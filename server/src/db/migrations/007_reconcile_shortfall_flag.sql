-- A chain-below-ledger shortfall must survive `unpause` (round-2 review N3).
--
-- `reconcile()` pauses custody when the chain holds LESS than the books can
-- explain. Until now that verdict lived only in `paused`, which the operator
-- clears with one command. `unpause` then reopened every money path
-- immediately: the last reconciliation was FAILED but it was also FRESH, so
-- `lockControls` saw a recent `last_reconciled_at` and let signatures through
-- for up to a full reconcile interval — against a custody wallet that had
-- already been observed short.
--
-- This column separates "an operator says carry on" from "the books and the
-- chain agree again". `reconcile()` stamps it on a shortfall and clears it on a
-- clean pass; `assertSolvent` refuses while it is set. So an operator can
-- unpause, but nothing signs until a SUBSEQUENT reconciliation actually
-- succeeds — which is the correct order: know the balance, then move money.
--
-- The timestamp (rather than a bool) records WHEN the shortfall was first seen
-- and is preserved across repeated failing reconciles, so an incident report
-- can say how long the condition has stood.
ALTER TABLE custody_controls
  ADD COLUMN shortfall_detected_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN custody_controls.shortfall_detected_at IS
  'when reconcile last saw the chain below the ledger; cleared only by a clean reconcile, never by unpause';
