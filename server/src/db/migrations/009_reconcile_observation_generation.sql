-- A reconciliation verdict may only be overwritten by a NEWER observation
-- (round-3 review R3, the residue of round-2 N3).
--
-- `reconcile()` reads the chain and the books outside any lock and then writes
-- `shortfall_detected_at` last-writer-wins, with an unconditional `ELSE NULL`
-- on the clean branch. Two reconciliations can be in flight at once — the
-- worker runs one at startup and every 60s, and `drops.submitFunding` runs one
-- of its own before every activation — so this interleaving is reachable:
--
--   1. pass A observes a healthy chain balance, then stalls (GC, a slow RPC,
--      a scheduler hiccup) before its write;
--   2. money leaves custody out of band;
--   3. pass B observes the shortfall, stamps `shortfall_detected_at` and pauses;
--   4. pass A finally writes — and its `ELSE NULL` erases B's verdict.
--
-- The operator then unpauses, `assertSolvent` sees no standing shortfall, and
-- signatures resume against a wallet that has already been observed short. The
-- exact condition N3 was written to make unclearable is cleared by a stale
-- observation.
--
-- Two columns close it, one for each way an observation can be out of date.
--
-- 1. `reconcile_observed_seq` — the OBSERVATION GENERATION. Drawn from the
--    sequence below at the moment the observation COMPLETES (after the chain
--    reads and after the REPEATABLE READ ledger snapshot commits), so it orders
--    passes by when they finished looking rather than by when they started: a
--    pass that started first and stalled is correctly the older view. The write
--    is refused unless this generation is strictly greater than the one on
--    record, and it is taken under the singleton row lock, so two passes cannot
--    both read the same generation and both decide they are newer.
--
-- 2. `shortfall_observed_height` — the chain head the standing shortfall was
--    seen at. Generation order is about which observation FINISHED last, which
--    is not quite the same question as which one saw the chain LAST: the API
--    process and the worker talk to their own nodes, and those can differ by a
--    block or two. So a clean pass may refresh the cross-check numbers freely
--    (refusing that would make a momentarily lagging node stall activations on
--    staleness), but it may only CLEAR a standing shortfall if its own view of
--    the chain is at least as new as the view that verdict was formed from.
--    Money missing at height H is not explained by a healthy reading from
--    height H − 5.

ALTER TABLE custody_controls
  ADD COLUMN reconcile_observed_seq     BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN shortfall_observed_height  BIGINT NULL;

ALTER TABLE custody_controls
  ADD CONSTRAINT custody_controls_reconcile_observed_seq_non_negative
    CHECK (reconcile_observed_seq >= 0);

-- The two shortfall columns are one fact and must move together.
ALTER TABLE custody_controls
  ADD CONSTRAINT custody_controls_shortfall_height_with_timestamp
    CHECK ((shortfall_detected_at IS NULL) = (shortfall_observed_height IS NULL));

COMMENT ON COLUMN custody_controls.reconcile_observed_seq IS
  'generation of the last accepted reconciliation observation; only a strictly newer one may overwrite';
COMMENT ON COLUMN custody_controls.shortfall_observed_height IS
  'chain head the standing shortfall was observed at; a clean pass from an OLDER head may not clear it';

-- One counter per database (per schema, for the race suites' private ones).
-- `nextval` takes no transactional lock and never hands the same number out
-- twice, which is exactly what "monotonic across concurrent processes" needs.
CREATE SEQUENCE reconcile_observation_seq AS BIGINT START 1;

COMMENT ON SEQUENCE reconcile_observation_seq IS
  'generation counter drawn by reconcile() when an observation completes';
