-- One custody deposit is EITHER a drop's funding OR operator float — never both
-- (round-3 review R2).
--
-- Migration 006 made the float attributable to named deposits, and `float set`
-- already refused a hash that some drop had ALREADY been funded with. The gap
-- was the other direction and the other order:
--
--   * `float set` accepted any final inbound deposit not yet on a drop —
--     including one whose memo is `ND1:<publicId>`, i.e. money a sponsor sent
--     to fund a drop that simply had not been submitted yet; and
--   * `activate()` never looked at `operator_float_deposits` at all.
--
-- So the same transaction could be attested as float (crediting
-- `operator_float_luna`) and then, minutes later, submitted as a drop's funding
-- (crediting `expected_funding_luna`). The ledger counted one deposit twice and
-- the invariant authorised payouts against money that was never in custody.
--
-- The application checks both directions with messages an operator can act on
-- (`drops.ts` activation, `recover.ts float set`). These triggers are the guard
-- underneath them: they cannot be forgotten by a future caller, and they hold
-- for hand-written SQL too.
--
-- On concurrency: both WRITE paths — `activate()` and `setOperatorFloat()` —
-- take the singleton `custody_controls` row FOR UPDATE before they write, so
-- they are serialized against each other and a READ COMMITTED existence check
-- inside these triggers cannot miss a committed row from the other side. The
-- one write that does NOT hold that lock is `recordPending`, which stamps
-- `funding_tx_hash` on a not-yet-final funding transaction; a float attestation
-- racing that write can still win, and the drop's later ACTIVATION — which
-- re-stamps `funding_tx_hash` under the custody lock — is then refused by this
-- same trigger. Money is never credited twice in either ordering.

CREATE FUNCTION assert_drop_funding_is_not_float() RETURNS trigger
LANGUAGE plpgsql
-- Captures the search_path in force when this migration runs, so the function
-- always reads the tables of ITS OWN schema (the race suites migrate into
-- private schemas) rather than whatever the caller's path happens to be.
SET search_path FROM CURRENT
AS $$
BEGIN
  IF NEW.funding_tx_hash IS NOT NULL AND EXISTS (
    SELECT 1 FROM operator_float_deposits WHERE tx_hash = NEW.funding_tx_hash
  ) THEN
    RAISE EXCEPTION
      'transaction % is already attested as operator float: it cannot also be drop funding, '
      'or the same luna would be credited to the ledger twice',
      NEW.funding_tx_hash
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER drops_funding_not_operator_float
  BEFORE INSERT OR UPDATE OF funding_tx_hash ON drops
  FOR EACH ROW EXECUTE FUNCTION assert_drop_funding_is_not_float();

CREATE FUNCTION assert_float_deposit_is_not_drop_funding() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  funded_drop TEXT;
BEGIN
  SELECT public_id INTO funded_drop FROM drops WHERE funding_tx_hash = NEW.tx_hash;
  IF funded_drop IS NOT NULL THEN
    RAISE EXCEPTION
      'transaction % is the funding of drop %: that money is owed to its claimants and is '
      'already in the ledger, so it cannot also be operator float',
      NEW.tx_hash, funded_drop
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER operator_float_deposits_not_drop_funding
  BEFORE INSERT OR UPDATE OF tx_hash ON operator_float_deposits
  FOR EACH ROW EXECUTE FUNCTION assert_float_deposit_is_not_drop_funding();

COMMENT ON FUNCTION assert_drop_funding_is_not_float() IS
  'R2: refuses a funding hash that already backs the operator float (double credit)';
COMMENT ON FUNCTION assert_float_deposit_is_not_drop_funding() IS
  'R2: refuses a float deposit hash that is already some drop''s funding (double credit)';
