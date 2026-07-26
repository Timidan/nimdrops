-- Re-ship migration 002's backfill guard as a migration of its OWN
-- (round-2 review finding F9).
--
-- 002 grew a `DO` block that refuses to backfill `validity_start_height = 0`
-- onto a table that already has rows. That guard is correct and it is also
-- unreachable on exactly the databases it was written for: `db/migrate.ts`
-- skips by FILENAME, so any deployment that had already applied 002 never ran
-- the amended version of it and never will. Editing an applied migration
-- changes nothing but the repository's own history.
--
-- So the check ships again, here, where an already-migrated database will
-- actually execute it. What it looks for is the DAMAGE rather than the
-- precondition: a row whose `validity_start_height` is 0 is the fingerprint of
-- the unguarded backfill, because
--
--   * 002's ALTER wrote 0 into every pre-existing row, and
--   * every insert since then states a real head height explicitly (the DEFAULT
--     was dropped in the same migration, and `signAndPersistAttempt` passes the
--     height it signed against).
--
-- A zero window is past by construction at any real head, so `recover.ts
-- replace` would read such a row as "provably dead" and sign a SECOND payment
-- for an attempt that may still land. That is the whole reason this file exists.
--
-- Checking for the damage rather than for "any rows at all" is deliberate: the
-- deployed system already holds legitimate attempt rows from its settlement
-- run, and refusing to migrate those would be a false alarm that costs an
-- outage. A healthy populated table passes; a backfilled one does not.
--
-- LOCK TABLE first (the other half of F9). `count(*)` in READ COMMITTED sees a
-- snapshot taken when the statement started, so a writer inserting a row
-- microseconds later slips past a guard that only counts. EXCLUSIVE mode blocks
-- every writer (readers are still served) for the rest of this migration's
-- transaction, which makes the count a decision about the whole table rather
-- than about one instant of it.
LOCK TABLE transaction_attempts IN EXCLUSIVE MODE;

DO $$
DECLARE
  backfilled BIGINT;
BEGIN
  SELECT count(*) INTO backfilled
  FROM transaction_attempts
  WHERE validity_start_height = 0;

  IF backfilled > 0 THEN
    RAISE EXCEPTION
      'refusing to run on % transaction_attempts row(s) with validity_start_height = 0: '
      'a zero validity window reads as "provably dead" at any real head, so recover.ts replace '
      'would authorise a second payment for an attempt that may still land. These rows were '
      'backfilled by migration 002 running against a non-empty table. Restore the true validity '
      'start heights from the signed transaction bytes (raw_signed_tx) before migrating.',
      backfilled;
  END IF;
END
$$;
