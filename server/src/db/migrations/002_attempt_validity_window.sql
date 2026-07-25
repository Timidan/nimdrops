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
-- Pre-existing rows are backfilled with 0. That is safe here only because no
-- deployment exists yet (see server/spike/g0-evidence.md §7): the sole rows are
-- local test artifacts, never money.
ALTER TABLE transaction_attempts
  ADD COLUMN validity_start_height BIGINT NOT NULL DEFAULT 0;

ALTER TABLE transaction_attempts
  ALTER COLUMN validity_start_height DROP DEFAULT;

ALTER TABLE transaction_attempts
  ADD CONSTRAINT transaction_attempts_validity_start_non_negative
    CHECK (validity_start_height >= 0);
