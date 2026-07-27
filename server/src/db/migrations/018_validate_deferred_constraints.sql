-- Finish the three constraints 016 and 017 added `NOT VALID`.
--
-- A SEPARATE FILE, because `db/migrate.ts` runs each file in one transaction and
-- a lock is held until that transaction commits. Validating inside 016 or 017
-- would have held their ACCESS EXCLUSIVE lock across the scan — the exact stall
-- `NOT VALID` was chosen to avoid. From its own transaction, the validation
-- takes only SHARE UPDATE EXCLUSIVE, which conflicts with other DDL and with
-- VACUUM FULL and with nothing a claimant, a sponsor or the worker does.
--
-- A TIMEOUT IS TOLERATED RATHER THAN FATAL, and this is the one part that needs
-- arguing. Each validation is bounded by `statement_timeout`; a timeout is
-- downgraded to a WARNING, leaving that constraint `NOT VALID` — still enforced
-- on every write — and letting the migration commit. Safe because every one of
-- the three is satisfied by every pre-existing row BY CONSTRUCTION, so the scan
-- can only confirm what is already known:
--
--   * `drops_expiry_hours_range` — 016 created `expiry_hours` with a constant
--     default of 24, inside [1, 336], and nothing else has written those rows.
--   * `drops_closing_reason_allowed` — 017 replaced a validated, STRICTER
--     predicate with a weaker one over a superset of the same values.
--   * `wallet_challenges_action_allowed` — 017 created `action` with a constant
--     default of 'claim', one of the two permitted values.
--
-- Taking the money engine down to re-prove that would be worse than the stall
-- being avoided. `check_violation` is deliberately NOT caught: a CHECK the data
-- actually breaks is a fact about the money and must stop the deployment.
--
-- An operator finishes the job at any time, online:
--
--   SELECT conrelid::regclass AS "table", conname
--     FROM pg_constraint WHERE NOT convalidated AND contype = 'c';
--   ALTER TABLE <table> VALIDATE CONSTRAINT <conname>;
--
-- IDEMPOTENT AND RE-RUNNABLE: each block skips a constraint that is missing or
-- already valid, so this applies equally to a database carrying the validated
-- constraints from the first version of 016 and 017, one that has just applied
-- the current ones, or one where a previous run timed out partway.

SET LOCAL lock_timeout = '3s';
-- Armed per top-level statement, so each block below gets its own sixty seconds.
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'drops_expiry_hours_range'
      AND conrelid = 'drops'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE drops VALIDATE CONSTRAINT drops_expiry_hours_range;
  END IF;
EXCEPTION
  WHEN query_canceled OR lock_not_available THEN
    RAISE WARNING 'drops_expiry_hours_range left NOT VALID: %. It is still enforced on every '
                  'write; run ALTER TABLE drops VALIDATE CONSTRAINT drops_expiry_hours_range '
                  'when convenient.', SQLERRM;
END $$;

SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'drops_closing_reason_allowed'
      AND conrelid = 'drops'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE drops VALIDATE CONSTRAINT drops_closing_reason_allowed;
  END IF;
EXCEPTION
  WHEN query_canceled OR lock_not_available THEN
    RAISE WARNING 'drops_closing_reason_allowed left NOT VALID: %. It is still enforced on every '
                  'write; run ALTER TABLE drops VALIDATE CONSTRAINT '
                  'drops_closing_reason_allowed when convenient.', SQLERRM;
END $$;

SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wallet_challenges_action_allowed'
      AND conrelid = 'wallet_challenges'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE wallet_challenges VALIDATE CONSTRAINT wallet_challenges_action_allowed;
  END IF;
EXCEPTION
  WHEN query_canceled OR lock_not_available THEN
    RAISE WARNING 'wallet_challenges_action_allowed left NOT VALID: %. It is still enforced on '
                  'every write; run ALTER TABLE wallet_challenges VALIDATE CONSTRAINT '
                  'wallet_challenges_action_allowed when convenient.', SQLERRM;
END $$;
