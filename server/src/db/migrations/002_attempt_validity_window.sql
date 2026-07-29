-- Record each attempt's transaction validity window base (design §8.3).
--
-- Design §6.3's "minimum schema" omits this column, but §8.3's `proven_dead`
-- rule cannot be evaluated without it: after a restart the reconciler has only
-- the durable attempt row, and deciding an attempt is permanently dead requires
-- proving its validity window is past the current head. The G0 spike's durable
-- attempt record already persisted the same field
-- (`server/spike/s2-attempt-a.json` → `"validityStartHeight"`); this makes the
-- database row its production equivalent.
--
-- Deadline height = validity_start_height + NIMIQ_VALIDITY_WINDOW_BLOCKS
-- (Policy.TRANSACTION_VALIDITY_WINDOW_BLOCKS = 7200 on both Albatross networks,
-- measured in server/spike/g0-evidence.md §3). Head strictly past that deadline
-- with the hash sustainedly absent is the ONLY path to `proven_dead`; a
-- not-found lookup alone never is (getTransaction does not see the mempool).
-- Added with a temporary default so the ALTER succeeds against a table that
-- already has rows, then the default is DROPPED immediately. Keeping a default
-- would be dangerous: a future insert that forgot the column would silently get
-- height 0, whose window is past by construction, and an absent-but-pending
-- transaction would then look "proven dead" to the recovery CLI — the exact
-- double-payment this column exists to prevent. After this migration every
-- insert must state the height explicitly.
--
-- GUARD (G1 review finding 9). The paragraph above used to end "pre-existing
-- rows are backfilled with 0, which is safe because no deployment exists yet".
-- That safety argument is true of THIS repository and of nothing else: run
-- against a 001-era database that does have attempt rows, the backfill gives
-- every one of them validity_start_height = 0, whose window
-- (0 + 7200) is past by construction at any real head. `recover.ts replace`
-- would then read those live attempts as provably dead and sign a second
-- payment for each. So the migration refuses rather than assumes.
--
-- Fresh deploys are unaffected: an empty table passes the check and the ALTER
-- runs exactly as before. A non-empty one gets a loud, actionable failure and
-- an operator who must state the real heights before proceeding.
DO $$
DECLARE
  existing BIGINT;
BEGIN
  SELECT count(*) INTO existing FROM transaction_attempts;
  IF existing > 0 THEN
    RAISE EXCEPTION
      'refusing to backfill validity_start_height = 0 for % existing transaction_attempts row(s): '
      'a zero window reads as "provably dead" at any real head and would authorise a replacement '
      'payment for an attempt that may still land. Backfill the true heights by hand first.',
      existing;
  END IF;
END
$$;

ALTER TABLE transaction_attempts
  ADD COLUMN validity_start_height BIGINT NOT NULL DEFAULT 0;

ALTER TABLE transaction_attempts
  ALTER COLUMN validity_start_height DROP DEFAULT;

ALTER TABLE transaction_attempts
  ADD CONSTRAINT transaction_attempts_validity_start_non_negative
    CHECK (validity_start_height >= 0);
