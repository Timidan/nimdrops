-- Make the operator float ATTRIBUTABLE to real, finalized deposits
-- (round-2 review finding F4).
--
-- 004 gave the ledger the one credit the drops cannot supply — the operator's
-- pre-funded fee float — as a bare number in `custody_controls`. Nothing said
-- WHICH money it referred to. An operator (or anyone who could run the CLI)
-- could attest any amount the head-state chain balance happened to cover, and
-- the head-state balance includes credits that are not final, credits a reorg
-- can remove, and the drops' own funding sitting in the same wallet. The
-- attestation was therefore checkable only against a number that was itself
-- unverified.
--
-- From here the float is the SUM OF NAMED DEPOSITS. `float set` takes a
-- `--tx <hash>`, proves that hash is a finalized deposit paid into custody that
-- is not any drop's funding and has not been counted before, records it here,
-- and then requires `operator_float_luna` to equal the sum of this table. Every
-- luna of the float can be pointed at a transaction on a block explorer.
CREATE TABLE operator_float_deposits (
  tx_hash         TEXT PRIMARY KEY,
  value_luna      BIGINT NOT NULL,
  included_height BIGINT NOT NULL,
  -- The chain the deposit was proven on, so a database moved between networks
  -- cannot silently keep counting the other chain's money.
  network         TEXT NOT NULL,
  attested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operator_float_deposits_value_positive
    CHECK (value_luna > 0),
  CONSTRAINT operator_float_deposits_height_non_negative
    CHECK (included_height >= 0),
  CONSTRAINT operator_float_deposits_network_allowed
    CHECK (network IN ('TestAlbatross', 'MainAlbatross'))
);

COMMENT ON TABLE operator_float_deposits IS
  'finalized custody deposits backing custody_controls.operator_float_luna; one row per tx hash';

-- Any float standing at this moment was attested under the old, unattributable
-- rule, so it is now unbacked by construction: this table is empty. Zeroing it
-- is the FAIL-CLOSED direction and matches 004's own default — until the
-- operator re-attests against a real deposit hash, `ledger >= outstanding +
-- fee reserve` cannot hold and no new liability can be created. The money is
-- not lost and nothing on chain changes; only the claim about it is withdrawn
-- until it can be evidenced.
--
-- DEPLOYMENT NOTE: after this migration, run
--   pnpm tsx src/recover.ts float set <luna> --tx <deposit hash>
-- for the deposit(s) that actually funded the float.
UPDATE custody_controls SET operator_float_luna = 0 WHERE operator_float_luna <> 0;
