-- Reserve aggregate capacity when funding instructions are ISSUED, not when the
-- money lands, and cap how many drops may be live at once.
--
-- THE HOLE THIS CLOSES. `createDraft` handed a sponsor the custody address and
-- an exact amount without consulting `max_live_principal_luna` at all. The cap
-- was checked once, inside `activate()`, by which time the sponsor's
-- transaction is on chain and final. So N sponsors could each be told to send
-- money, all of them could send it, and their total could exceed the cap — at
-- which point activation number two onwards fails with `CapExceededError` on
-- money that is already sitting in the custody wallet and now needs a manual
-- refund. The check was in the one place where refusing is most expensive.
--
-- Capacity is therefore taken at the moment the instructions are issued, under
-- the singleton `custody_controls` lock (mandated order: custody_controls →
-- drop), and it is a RESERVATION rather than a permanent claim.
--
-- 1. `drops.funding_reservation_expires_at` — when this draft stops holding
--    aggregate headroom. Without an expiry an abandoned draft would consume the
--    pilot's whole cap forever; with one, headroom returns on its own.
--
--    A drop holds capacity while it is un-activated AND either
--      * its reservation has not expired, or
--      * a funding hash has been recorded against it (`funding_pending`), which
--        means real money is already pointed at it. That case must NOT expire:
--        the sponsor has paid, and releasing their headroom would let a later
--        draft take the room their activation needs.
--
--    The window is deliberately shorter than the 24-hour draft GC horizon (see
--    `FUNDING_RESERVATION_MINUTES` in `services/drops.ts`). GC answers "when may
--    this row be deleted"; a reservation answers "how long do we promise a
--    sponsor room", and a promise that outlives the sponsor's attention by a day
--    is a promise that keeps everyone else out for a day.
--
-- 2. `custody_controls.max_live_drops` — an optional ceiling on the NUMBER of
--    simultaneously live drops, independent of their total principal. The first
--    mainnet run wants exactly one live drop; a principal cap alone cannot say
--    that, because two small drops fit inside one large one's budget.
--
--    NULL means "no count limit", which is what every existing database and the
--    whole test suite get: this migration changes no behaviour on its own. The
--    mainnet pilot values are applied once, when a fresh database is first bound
--    to MainAlbatross (`bindNetwork` in `services/solvency.ts`).

ALTER TABLE drops
  ADD COLUMN funding_reservation_expires_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN drops.funding_reservation_expires_at IS
  'while this is in the future the draft holds aggregate cap headroom; a recorded funding_tx_hash '
  'holds it regardless, because the sponsor has already paid';

-- Any draft that exists as this migration runs was issued instructions under the
-- old rule, i.e. with no reservation at all. Giving it one from its own creation
-- time is the honest reconstruction: a draft made two minutes ago still has a
-- sponsor looking at a funding screen, and one made yesterday does not.
UPDATE drops
SET funding_reservation_expires_at = created_at + interval '30 minutes'
WHERE state IN ('awaiting_funding', 'funding_pending')
  AND activated_height IS NULL;

-- The aggregate this index serves runs inside the singleton custody lock on
-- every draft creation, so it is on the critical path of the create flow.
CREATE INDEX drops_holding_capacity
  ON drops (funding_reservation_expires_at)
  WHERE activated_height IS NULL AND state IN ('awaiting_funding', 'funding_pending');

COMMENT ON INDEX drops_holding_capacity IS
  'drafts that may still be holding aggregate cap headroom; read on every createDraft';

ALTER TABLE custody_controls
  ADD COLUMN max_live_drops INT NULL;

ALTER TABLE custody_controls
  ADD CONSTRAINT custody_controls_max_live_drops_non_negative
    CHECK (max_live_drops IS NULL OR max_live_drops >= 0);

COMMENT ON COLUMN custody_controls.max_live_drops IS
  'ceiling on simultaneously live + reserved drops; NULL means only the principal cap applies';
