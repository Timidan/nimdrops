-- Let a sponsor close their own drop early and take the unclaimed remainder back.
--
-- WHY NOW. Migration 016 let a sponsor choose a claim window of up to 336 hours
-- (14 days). Its own comment names the reason that ceiling is 14 and not 30:
-- "nothing in the product can end a drop early — there is no sponsor cancel and
-- no operator close, only `sweepExpiry` at `expires_at` — so the ceiling is not
-- 'the longest claim window' but 'the longest a sponsor can lock their own money
-- with no way out'". While every drop expired in 24 hours that was a wait. At 14
-- days it is a trap: a sponsor who funds the wrong drop, or whose event is
-- cancelled, has no exit. This migration is the schema half of the exit.
--
-- IT ADDS NO MONEY PATH. Early close is the transition `sweepExpiry` already
-- performs, triggered on demand instead of by the clock: the drop leaves `live`,
-- every already-reserved claim is honoured, and ONE refund is written for the
-- unallocated value `(claim_count - reserved) * amount_each_luna`, to the
-- address that sent the verified funding transaction. `services/expiry.ts`
-- derives that amount in exactly one function and both callers go through it.
-- `one_refund_per_drop` (migration 001) is unchanged and remains the backstop
-- that makes a second refund impossible however the code is called.
--
-- TWO COLUMNS CHANGE. Nothing is dropped, nothing is rewritten.
--
--  1. `drops.closing_reason` gains 'closed_by_sponsor'. The column is how the
--     claimant's UI already distinguishes "every share is taken" from "this drop
--     has expired" (`closedRejection` in `services/claims.ts`), and a claimant
--     who arrives after an early close deserves the true third sentence rather
--     than the nearest of the two existing ones.
--
--     The old CHECK is dropped and a strictly WEAKER one added in its place, so
--     no existing row can fail it. PostgreSQL still scans the table to validate
--     the new constraint; `drops` is small by construction — one row per drop
--     ever created — and `lock_timeout` bounds the wait for the ACCESS EXCLUSIVE
--     lock, so the migration fails and rolls back cleanly rather than stalling
--     the claim path behind a long transaction.
--
--  2. `wallet_challenges.action` records WHICH action a challenge authorizes.
--
--     The binding already exists cryptographically: `auth/challenge.ts` puts
--     `action` inside the canonical message, the wallet signs those exact bytes,
--     and both verifiers re-canonicalize the stored message and refuse one whose
--     action is not theirs. So a claim signature cannot be replayed as a close
--     today. The column makes that same binding checkable by the DATABASE, in
--     the single UPDATE that consumes the nonce:
--
--       UPDATE wallet_challenges SET consumed_at = now()
--        WHERE id = $1 AND drop_id = $2 AND action = 'close'
--          AND consumed_at IS NULL AND expires_at > now()
--
--     One statement, one row, one use — and a challenge minted for a claim can
--     never be the row a close consumes, even if a future refactor forgets to
--     re-check the message. Authorization on the refund path is worth two
--     independent enforcements.
--
--     DEFAULT 'claim' is what makes this safe against rows that already exist
--     and against a server still running the previous image: every challenge
--     minted before this migration was a claim challenge, and the only writer of
--     the column that is not a claim is the close path added alongside it.
--
-- SAFE AGAINST A LIVE DATABASE:
--
--  * NO TABLE REWRITE. `ADD COLUMN ... NOT NULL DEFAULT <constant>` stores the
--    default in the catalogue since PostgreSQL 11 (this deployment is 16), so
--    existing `wallet_challenges` rows are not touched.
--  * NO IN-FLIGHT DROP CHANGES MEANING. `closing_reason` is only ever written at
--    the moment a drop closes; widening the set of legal values changes nothing
--    already written, and no reader treats an unknown reason as fatal.
--  * IDEMPOTENT. Every statement is guarded by a catalogue check, so a
--    hand-repaired database converges instead of erroring.
--
-- Migrations 015 and 016 are untouched. This builds on top of both.

SET LOCAL lock_timeout = '3s';

-- 1. `closed_by_sponsor` joins `expired` and `exhausted`.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'drops_closing_reason_allowed' AND conrelid = 'drops'::regclass
  ) THEN
    ALTER TABLE drops DROP CONSTRAINT drops_closing_reason_allowed;
  END IF;

  ALTER TABLE drops
    ADD CONSTRAINT drops_closing_reason_allowed
      CHECK (
        closing_reason IS NULL
        OR closing_reason IN ('expired', 'exhausted', 'closed_by_sponsor')
      );
END $$;

COMMENT ON CONSTRAINT drops_closing_reason_allowed ON drops IS
  'why a drop left `live`: its deadline passed, its last share was taken, or the sponsor closed '
  'it early. All three run the same transition and produce at most one refund of the unallocated '
  'value to the funding sender; the reason exists so a claimant can be told which one happened';

-- 2. A challenge says which action it authorizes, and the database enforces it.

ALTER TABLE wallet_challenges
  ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'claim';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wallet_challenges_action_allowed'
      AND conrelid = 'wallet_challenges'::regclass
  ) THEN
    ALTER TABLE wallet_challenges
      ADD CONSTRAINT wallet_challenges_action_allowed
        CHECK (action IN ('claim', 'close'));
  END IF;
END $$;

COMMENT ON COLUMN wallet_challenges.action IS
  'the one action this challenge authorizes, mirroring the `action` field inside `canonical_message` '
  'that the wallet actually signed. The consuming UPDATE filters on it, so a claim challenge can '
  'never be spent as a close and a close challenge can never be spent as a claim — enforced here as '
  'well as in the signed bytes, because this is the authorization on a refund path';
