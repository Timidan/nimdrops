-- Let the sponsor choose how long their drop stays claimable.
--
-- WHY. `expires_at` was stamped `now() + 24 hours` at activation, from a
-- constant in `services/drops.ts`. Twenty-four hours is right for a meetup in a
-- room and wrong for a campaign meant to run over a weekend, and the sponsor is
-- the only person who knows which one they are doing. The window becomes theirs,
-- inside bounds this deployment enforces.
--
-- THE BOUNDS, and why each exists.
--
--  * FLOOR: 1 hour. This protects CLAIMANTS, not the operator. A drop that
--    expires before anyone realistically opens the link refunds every share to
--    the sponsor, at no cost to them, having advertised money nobody had a real
--    chance to take. That is a scam's exact shape whether or not it was meant
--    as one, and the floor is what stops the schema from being able to express
--    it. An hour is the shortest window in which a link posted into a group
--    chat can plausibly be opened by the people in it, and the clock does not
--    start until funding is final, so none of it is spent waiting on the chain.
--
--  * CEILING: 336 hours (14 days). This bounds CUSTODY DURATION. There is no
--    on-chain escrow here: the operator's hot key can move a drop's principal
--    for as long as the drop is live, and since migration 015 removed the size
--    caps a drop can be arbitrarily large. Unbounded value for an unbounded
--    time is a materially different product from the one this schema had
--    before, so the time half of it is bounded here.
--
--    Fourteen and not thirty, for three reasons that all point the same way.
--    First, nothing in the product can end a drop early — there is no sponsor
--    cancel and no operator close, only `sweepExpiry` at `expires_at` — so the
--    ceiling is not "the longest claim window" but "the longest a sponsor can
--    lock their own money with no way out". Second, every campaign shape anyone
--    has named fits inside it: an evening, a weekend, a week-long conference, a
--    fortnight's push. A month is not a longer campaign, it is a deposit.
--    Third, the operator must keep the signer and the sweeper alive for the
--    whole window of every outstanding drop, and a ceiling nobody can credibly
--    commit to is a promise the deployment has not earned. It can be raised
--    later against evidence; it cannot be lowered without stranding drops.
--
--    SUPERSEDED IN PART: 017 gives the funding wallet an early close, so the
--    first of those three reasons no longer holds. The ceiling and the other
--    two stand. 017 re-issues the persistent constraint comment below, for
--    databases that already ran this file.
--
-- IMMUTABLE ONCE CHOSEN. The value is fixed when the draft is created and read
-- back out of THIS COLUMN at activation — `activate()` computes
-- `expires_at = now() + make_interval(hours => expiry_hours)` against the drop
-- row it has already locked, and never against anything in a request body. A
-- sponsor who could shorten the window after claims started would strand the
-- remaining claimants and take their shares back as a refund, so this is a
-- security property and not a convenience. Nothing outside this migration and
-- `createDraft`'s INSERT ever writes the column.
--
-- SAFE AGAINST A LIVE DATABASE, and the argument in full:
--
--  1. NO TABLE REWRITE. Since PostgreSQL 11, `ADD COLUMN ... NOT NULL DEFAULT
--     <constant>` stores the default in the catalogue (`pg_attribute
--     .atthasmissing` / `attmissingval`) and existing rows read it without
--     being touched. This deployment is PostgreSQL 16, so the statement is a
--     catalogue update whose cost does not depend on how many drops exist.
--  2. NO BACKFILL, AND NO WRONG ROWS. The default is 24, which is exactly the
--     window every existing row was activated under. Live drops keep the
--     `expires_at` already stamped on them — this column does not recompute
--     anything — so a drop mid-flight when this runs is unaffected. Open drafts
--     get 24 and activate to the same instant they would have. In-flight
--     transfers never read the column at all.
--  3. THE LOCK IS BOUNDED IN BOTH DIRECTIONS. `lock_timeout` caps how long
--     ACCESS EXCLUSIVE is WAITED for; it says nothing about how long it is
--     HELD, and a validated `ADD CONSTRAINT ... CHECK` holds it for a full
--     table scan. `drops` is unbounded — a cancelled draft is never deleted —
--     so that scan can outlast the wait cap by any margin, with every read and
--     every claim queued behind it. Hence `NOT VALID`, which is catalogue-only
--     and still fully enforced against every INSERT and UPDATE; migration 018
--     proves the pre-existing rows separately, under a lock that blocks nobody.
--     `statement_timeout` bounds the work as well as the wait.
--  4. IDEMPOTENT. `IF NOT EXISTS` on the column, and a catalogue check before
--     the constraint, so a database that already has either converges instead
--     of erroring. The check is on existence, not validity, so a database
--     carrying the validated constraint from the first version of this file
--     keeps it and 018 skips it.
--
-- Migration 015 is untouched. This builds on top of it.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE drops
  ADD COLUMN IF NOT EXISTS expiry_hours INT NOT NULL DEFAULT 24;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'drops_expiry_hours_range' AND conrelid = 'drops'::regclass
  ) THEN
    ALTER TABLE drops
      ADD CONSTRAINT drops_expiry_hours_range
        CHECK (expiry_hours BETWEEN 1 AND 336) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN drops.expiry_hours IS
  'how long this drop stays claimable, counted from finalized activation and chosen by the '
  'sponsor when the draft was created. Written once, at INSERT; activation reads it and never '
  'writes it. A request body can never change it, because shortening a live window would strand '
  'claimants and refund their shares to the sponsor';

COMMENT ON CONSTRAINT drops_expiry_hours_range ON drops IS
  'floor of 1 hour so a drop cannot expire before anyone could realistically open the link; '
  'ceiling of 336 hours (14 days) because this is the longest the operator holds a sponsor''s NIM '
  'on the clock alone. Since migration 017 the funding wallet can close the drop early and take '
  'the unclaimed remainder back, so the ceiling bounds the wait, not a trap';
