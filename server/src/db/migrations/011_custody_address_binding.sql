-- Bind this database to ONE custody address, the way 004 bound it to one chain
-- (round-4 review S1).
--
-- Only the NETWORK was database-bound. The custody ADDRESS was not, and the two
-- processes that need it get it from different places:
--
--   * `index.ts` reads `CUSTODY_ADDRESS` from the environment and builds a
--     read-only client from it — that string is what a sponsor is told to pay,
--     and what `submitFunding` checks `tx.recipient` against;
--   * `worker.ts` DERIVES the address from `CUSTODY_PRIVATE_KEY_HEX` — that key
--     is what every payout is signed with.
--
-- Nothing compared them. A `CUSTODY_ADDRESS` that is a perfectly valid Nimiq
-- address but not the worker's wallet is therefore accepted at boot, printed as
-- funding instructions, and used to ACTIVATE drops: the money lands in a wallet
-- the worker holds no key for, the ledger credits it as custody capacity, and
-- the first payout the worker tries to sign is drawn on an account that never
-- received it. Every claimant of that drop is unpayable, and the deposits are
-- unrecoverable by this system.
--
-- One column and the same fail-closed shape as `network`: the first boot of a
-- fresh database stamps it, every later boot compares and refuses. Rotating the
-- custody wallet is a deliberate operator action, confirmed through
-- `NIMDROPS_CONFIRM_CUSTODY_ADDRESS` (see `ensureChainBinding`), never a silent
-- consequence of a changed environment variable.
--
-- NULL means "not yet stamped". Databases migrated from an earlier version get
-- NULL here exactly as they got NULL for `network`, and the same round-2 F6
-- reasoning applies: an unbound database that ALREADY holds a payment history
-- must not have its binding invented by whichever process happens to boot
-- first, so that case demands the confirmation variable too.
ALTER TABLE custody_controls
  ADD COLUMN custody_address TEXT NULL;

ALTER TABLE custody_controls
  ADD CONSTRAINT custody_controls_custody_address_non_empty
    CHECK (custody_address IS NULL OR length(btrim(custody_address)) > 0);

COMMENT ON COLUMN custody_controls.custody_address IS
  'custody wallet this database is bound to, in spaced user-friendly form; stamped at first boot, '
  'changed only through an explicit operator-confirmed rotation';
