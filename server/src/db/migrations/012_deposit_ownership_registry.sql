-- One custody deposit has exactly ONE owner, enforced by a unique key rather
-- than by two triggers looking for each other (round-4 review S4, the residue of
-- round-3 R2).
--
-- 008 made `activate()` and `float set` refuse a hash the other side had
-- already taken, with a trigger on each table doing an EXISTS lookup against
-- the other. That is not mutual exclusion, and 008's own header said why it
-- believed it was: both write paths take the singleton `custody_controls` row
-- FOR UPDATE first, so they are serialized and a READ COMMITTED existence check
-- cannot miss a committed row.
--
-- Two things falsify that argument.
--
--  1. `recordPending` stamps `funding_tx_hash` WITHOUT the custody lock — 008
--     acknowledged this and argued the later activation would be refused. It
--     would be, but only in that one ordering. Two writers that are not both
--     holding the lock can interleave freely:
--
--        T1: INSERT INTO operator_float_deposits (tx_hash = H)   -- uncommitted
--        T2: UPDATE drops SET funding_tx_hash = H                -- uncommitted
--        T1: trigger asks "is H any drop's funding?" -> no committed row -> ok
--        T2: trigger asks "is H attested float?"     -> no committed row -> ok
--        T1: COMMIT
--        T2: COMMIT
--
--     Both triggers passed, both rows exist, and the same luna is now credited
--     to the ledger twice — once as `expected_funding_luna` and once as
--     `operator_float_luna`. A row that is not yet committed is invisible to
--     an EXISTS check by definition, so NO arrangement of existence checks can
--     close this. Only a shared, uniquely-keyed row can: the second writer
--     BLOCKS on the first one's key until it commits, then sees it.
--
--  2. Anything that intersected BEFORE 008 ran survived it. 008 added triggers
--     and checked nothing, so a database that already had a hash on both sides
--     was migrated into a state its own invariant forbids, silently.
--
-- So: one registry table, `tx_hash` as the PRIMARY KEY, and both write paths
-- INSERT into it through triggers. The key is the exclusion — a real one,
-- serialized by Postgres' own index locking — and the triggers exist so that
-- hand-written SQL and any future caller are covered too.
--
-- ============================================================================
-- THIS MIGRATION ABORTS ON PRE-EXISTING INTERSECTIONS. That is deliberate: an
-- intersection means the ledger has already double-counted a deposit, and there
-- is no correct automatic repair — either the drop's claimants own that money
-- or the operator does, and only a human knows which. An operator who hits this
-- must decide, then remove the wrong side (`DELETE FROM operator_float_deposits
-- WHERE tx_hash = ...` plus a corrected `float set`, or clear the drop's
-- funding) and re-run the migration. The offending hashes are named in the
-- exception.
-- ============================================================================
DO $$
DECLARE
  clashes TEXT;
BEGIN
  SELECT string_agg(format('%s (drop %s)', f.tx_hash, d.public_id), ', ')
    INTO clashes
    FROM operator_float_deposits f
    JOIN drops d ON d.funding_tx_hash = f.tx_hash;

  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION
      'refusing to install the deposit ownership registry: % transaction(s) are ALREADY counted '
      'both as a drop''s funding and as operator float, so the ledger credits them twice: %. '
      'Decide who that money belongs to, remove the wrong side, and re-run. Migration 008 '
      'installed its triggers without checking, which is how these rows survived.',
      (SELECT count(*) FROM operator_float_deposits f2
        JOIN drops d2 ON d2.funding_tx_hash = f2.tx_hash),
      clashes
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE TABLE custody_deposit_owners (
  tx_hash     TEXT PRIMARY KEY,
  -- 'drop': the deposit is some drop's accepted funding, owed to its claimants.
  -- 'float': the deposit is the operator's own pre-funded fee float.
  owner       TEXT NOT NULL,
  -- Set for 'drop' rows only. ON DELETE CASCADE so removing a drop releases its
  -- claim on the hash; nothing in the application deletes drops, but a registry
  -- that can outlive its subject would block a legitimate re-attestation.
  drop_id     UUID NULL REFERENCES drops(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT custody_deposit_owners_owner_allowed
    CHECK (owner IN ('drop', 'float')),
  CONSTRAINT custody_deposit_owners_drop_id_matches_owner
    CHECK ((owner = 'drop') = (drop_id IS NOT NULL))
);

COMMENT ON TABLE custody_deposit_owners IS
  'S4: one row per custody deposit hash naming its single owner; the PRIMARY KEY is the '
  'mutual exclusion between drop funding and operator float';

-- Backfill: every hash already spoken for. The DO block above has proven the
-- two sides do not intersect, so neither insert can conflict with the other.
INSERT INTO custody_deposit_owners (tx_hash, owner, drop_id)
SELECT funding_tx_hash, 'drop', id FROM drops WHERE funding_tx_hash IS NOT NULL;

INSERT INTO custody_deposit_owners (tx_hash, owner, drop_id)
SELECT tx_hash, 'float', NULL FROM operator_float_deposits;

-- ---- the triggers ---------------------------------------------------------
--
-- AFTER, not BEFORE: `drop_id` references `drops(id)`, and in a BEFORE INSERT
-- trigger that row does not exist yet.
--
-- `ON CONFLICT DO UPDATE` with a no-op SET, rather than `DO NOTHING`: it is the
-- form that BLOCKS on a concurrent uncommitted insert of the same key and then
-- returns the row that won. `DO NOTHING` also blocks, but returns nothing, so
-- the loser cannot tell "I inserted it" from "somebody else owns it" — which is
-- precisely the question being asked.

CREATE FUNCTION claim_deposit_for_drop() RETURNS trigger
LANGUAGE plpgsql
-- Captures the search_path in force when this migration runs, so the function
-- always reads the tables of ITS OWN schema (the race suites migrate into
-- private schemas) rather than whatever the caller's path happens to be.
SET search_path FROM CURRENT
AS $$
DECLARE
  held_by    TEXT;
  held_drop  UUID;
BEGIN
  IF NEW.funding_tx_hash IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO custody_deposit_owners (tx_hash, owner, drop_id)
  VALUES (NEW.funding_tx_hash, 'drop', NEW.id)
  ON CONFLICT (tx_hash) DO UPDATE SET owner = custody_deposit_owners.owner
  RETURNING owner, drop_id INTO held_by, held_drop;

  IF held_by = 'float' THEN
    -- Message kept word-for-word compatible with 008: `drops.ts` matches on it
    -- to turn this backstop into a 422 the sponsor can act on rather than a 500.
    RAISE EXCEPTION
      'transaction % is already attested as operator float: it cannot also be drop funding, '
      'or the same luna would be credited to the ledger twice',
      NEW.funding_tx_hash
      USING ERRCODE = '23514';
  END IF;

  IF held_drop IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION
      'transaction % is already the funding of another drop: one deposit funds one drop',
      NEW.funding_tx_hash
      USING ERRCODE = '23505';
  END IF;

  RETURN NULL;
END
$$;

CREATE FUNCTION claim_deposit_for_float() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  held_by     TEXT;
  held_drop   UUID;
  funded_drop TEXT;
BEGIN
  INSERT INTO custody_deposit_owners (tx_hash, owner, drop_id)
  VALUES (NEW.tx_hash, 'float', NULL)
  ON CONFLICT (tx_hash) DO UPDATE SET owner = custody_deposit_owners.owner
  RETURNING owner, drop_id INTO held_by, held_drop;

  IF held_by = 'drop' THEN
    SELECT public_id INTO funded_drop FROM drops WHERE id = held_drop;
    -- Same wording as 008 for the same reason.
    RAISE EXCEPTION
      'transaction % is the funding of drop %: that money is owed to its claimants and is '
      'already in the ledger, so it cannot also be operator float',
      NEW.tx_hash, COALESCE(funded_drop, held_drop::text)
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$$;

-- 008's triggers are superseded, not supplemented: leaving both in place would
-- mean two different answers to the same question, and the EXISTS one is the
-- answer that can be wrong.
DROP TRIGGER drops_funding_not_operator_float ON drops;
DROP TRIGGER operator_float_deposits_not_drop_funding ON operator_float_deposits;
DROP FUNCTION assert_drop_funding_is_not_float();
DROP FUNCTION assert_float_deposit_is_not_drop_funding();

CREATE TRIGGER drops_claim_funding_deposit
  AFTER INSERT OR UPDATE OF funding_tx_hash ON drops
  FOR EACH ROW EXECUTE FUNCTION claim_deposit_for_drop();

CREATE TRIGGER operator_float_deposits_claim_deposit
  AFTER INSERT OR UPDATE OF tx_hash ON operator_float_deposits
  FOR EACH ROW EXECUTE FUNCTION claim_deposit_for_float();

COMMENT ON FUNCTION claim_deposit_for_drop() IS
  'S4: registers a drop''s funding hash in custody_deposit_owners; the unique key refuses a hash the float owns';
COMMENT ON FUNCTION claim_deposit_for_float() IS
  'S4: registers a float deposit hash in custody_deposit_owners; the unique key refuses a hash a drop owns';
