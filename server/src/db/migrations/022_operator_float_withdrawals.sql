-- Money can leave custody legitimately, and until now the books could not say so.
--
-- The operator float is "working capital in custody, over and above what
-- claimants are owed". `float set` attests it against finalized deposits and
-- enforces `operator_float_luna = SUM(operator_float_deposits.value_luna)`, so
-- the float can only ever RATCHET UP: every write needs a new deposit hash, and
-- the same hash is refused twice. There is exactly one UPDATE of
-- `operator_float_luna` in the codebase and it sits behind both checks.
--
-- That is the right shape for raising it — it stops an operator inventing
-- spendable capacity out of a number. It is the wrong shape for the case where
-- custody legitimately pays money out through something other than a payout or a
-- refund, because then the float is overstated and nothing can correct it.
--
-- FOUND BY PAUSING THE MAINNET PILOT, 2026-07-27. `spike/fund-one-drop.ts` seeds
-- a throwaway sponsor with a direct `custodySend` so that custody is not its own
-- refund address. That send is not an `outgoing_transfers` row — it is neither a
-- payout nor a refund, and the ledger has no other shape for money leaving — so
-- the books never debited it. The same coins returned as the drop's funding and
-- were credited as principal:
--
--     chain custody   15 NIM   (2 out as seed, 2 back as funding)
--     ledger          17 NIM   (15 float + 2 principal — the same 2 twice)
--
-- `reconcile()` compared those, found the books claiming more than custody
-- holds, and paused the deployment with `chain_below_ledger`. The invariant did
-- exactly its job: it refused to pay a claim against money it could not account
-- for. But there was no command that could put it right, and a deployment that
-- cannot unstick itself is a worse failure than the one it is protecting against.
--
-- WHY A SECOND TABLE RATHER THAN A NEGATIVE ROW. The obvious cheap fix is to
-- relax `operator_float_deposits_value_positive` and record a reduction as a
-- negative deposit. That makes the sum one query, and it makes the table's name
-- a lie: a row in `operator_float_deposits` would no longer be a deposit. It
-- also silently widens every existing reader of that table. A withdrawal is a
-- different fact about a different transaction, so it gets its own row.
--
-- The float is therefore `SUM(deposits) - SUM(withdrawals)`, and both halves are
-- attested against a real, finalized, on-chain hash that an auditor can open in
-- a block explorer. Neither half can be written from a guess.

CREATE TABLE operator_float_withdrawals (
  -- The custody-outgoing transaction that removed this money. PRIMARY KEY, so
  -- attesting the same withdrawal twice is a conflict rather than a double
  -- debit — the mirror of `operator_float_deposits`, and for the same reason.
  tx_hash         TEXT PRIMARY KEY,

  -- Always POSITIVE, and subtracted by the reader. Storing the sign in the
  -- table name rather than the value keeps `> 0` meaning "this row is
  -- well-formed" in both tables, instead of one of them meaning the opposite.
  value_luna      BIGINT NOT NULL,

  included_height BIGINT NOT NULL,

  -- The same network guard the deposits table carries. A testnet hash must
  -- never be able to reduce a mainnet float, any more than it could raise one.
  network         TEXT NOT NULL,

  -- Free text, required. A withdrawal is an operator asserting that money left
  -- for a reason the ledger has no row for; if that reason cannot be written
  -- down, it is not a reason. This is the only field in either table that is
  -- prose, and it exists because the audit question here is "why", not "how
  -- much" — the amount is already on chain.
  reason          TEXT NOT NULL,

  attested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT operator_float_withdrawals_value_positive
    CHECK (value_luna > 0),
  CONSTRAINT operator_float_withdrawals_height_non_negative
    CHECK (included_height >= 0),
  CONSTRAINT operator_float_withdrawals_network_allowed
    CHECK (network IN ('TestAlbatross', 'MainAlbatross')),
  CONSTRAINT operator_float_withdrawals_reason_non_empty
    CHECK (length(btrim(reason)) > 0)
);

COMMENT ON TABLE operator_float_withdrawals IS
  'finalized custody-outgoing transactions that reduced the operator float; the float is SUM(deposits) - SUM(withdrawals)';

COMMENT ON COLUMN operator_float_withdrawals.reason IS
  'why money left custody outside outgoing_transfers — an operator assertion, kept for audit';
