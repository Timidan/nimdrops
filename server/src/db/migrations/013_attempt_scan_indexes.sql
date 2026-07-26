-- Indexes for the two scans round 4 added to hot paths.
--
-- Neither is a correctness change; both are here because the queries they serve
-- moved from "occasionally, by an operator" to "on every claim" and "on every
-- tick", and `transaction_attempts` is the one table that grows without bound
-- in this system.
--
-- 1. INDETERMINATE BROADCASTS (S3). `assertSolvent` now refuses to create any
--    new liability while a broadcast outcome is unknown, so this predicate is
--    evaluated inside the singleton `custody_controls` lock on every claim
--    reservation, every activation and every signature. Anything evaluated
--    while holding that row is on the critical path of the whole application.
--
-- 2. THE DEAD-ATTEMPT RESCAN (S5). Every worker tick now also looks for
--    recently `proven_dead` attempts. Partial, so it stays proportional to the
--    number of dead attempts rather than to all attempts ever made — the same
--    reason the scan itself is bounded by a height window.
CREATE INDEX transaction_attempts_indeterminate
  ON transaction_attempts (created_at)
  WHERE state = 'signed' AND broadcast_attempted_at IS NOT NULL;

CREATE INDEX transaction_attempts_recent_proven_dead
  ON transaction_attempts (validity_start_height)
  WHERE state = 'proven_dead';

COMMENT ON INDEX transaction_attempts_indeterminate IS
  'S3: attempts whose broadcast outcome is unknown; read on every assertSolvent';
COMMENT ON INDEX transaction_attempts_recent_proven_dead IS
  'S5: dead attempts the tick rescans in case they landed after all';
