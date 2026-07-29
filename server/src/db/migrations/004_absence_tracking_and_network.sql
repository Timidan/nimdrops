-- Sustained-absence evidence, network binding and the operator float
-- (G1 review findings 2, 4 and 6).
--
-- 1. ABSENCE TRACKING (finding 2). `proven_dead` used to rest on a SINGLE
--    not-found lookup plus an expired validity window. One lookup is one
--    momentary answer from one node: a peer that is behind, a pico-client that
--    lost consensus mid-call, or an explorer hiccup all answer "not found" for
--    a transaction that is on chain. Building a replacement on that evidence
--    pays twice. These two columns make absence an OBSERVATION SERIES rather
--    than an instant: `recover.ts replace` requires at least two absences,
--    spaced at least five minutes apart, a validity window provably past AND a
--    fresh live lookup that is also absent. Any single found lookup resets both
--    columns, so the series has to be unbroken.
ALTER TABLE transaction_attempts
  ADD COLUMN absent_checks   INT NOT NULL DEFAULT 0,
  ADD COLUMN first_absent_at TIMESTAMPTZ NULL;

ALTER TABLE transaction_attempts
  ADD CONSTRAINT transaction_attempts_absent_checks_non_negative
    CHECK (absent_checks >= 0);

COMMENT ON COLUMN transaction_attempts.absent_checks IS
  'consecutive not-found lookups; reset to 0 the moment the chain shows the tx';
COMMENT ON COLUMN transaction_attempts.first_absent_at IS
  'when the current unbroken absence series started; NULL when not absent';

-- 2. NETWORK BINDING (finding 6). Nothing in the database said which chain the
--    money in it lives on. An operator who ran the recovery CLI with a testnet
--    environment against the mainnet database would sign real payouts with the
--    wrong network id — or, worse, prove a mainnet attempt "absent" by looking
--    for it on testnet and then replace it. The first boot stamps the network
--    here; every later boot and every chain-touching recovery command compares
--    and refuses on mismatch. NULL means "not yet stamped", which only a
--    genuinely fresh database can be.
ALTER TABLE custody_controls
  ADD COLUMN network TEXT NULL;

ALTER TABLE custody_controls
  ADD CONSTRAINT custody_controls_network_allowed
    CHECK (network IS NULL OR network IN ('TestAlbatross', 'MainAlbatross'));

COMMENT ON COLUMN custody_controls.network IS
  'chain this custody wallet is bound to; stamped at first boot, immutable after';

-- 3. OPERATOR FLOAT (finding 4). The solvency invariant now runs on a
--    LEDGER-DERIVED balance (accepted finalized funding − finalized outgoing
--    principal − recorded fees) instead of the head-state chain balance, so a
--    credit the chain shows but the books cannot explain — an unrelated
--    deposit, a not-yet-final one, one that a reorg later removes — can no
--    longer be spent as capacity.
--
--    The books need ONE term the drops cannot supply: the operator's own
--    pre-funded float, which is what the configured fee reserve is spent out
--    of. It arrives as an ordinary deposit carrying no drop memo, so nothing in
--    the schema attributes it to anything. It is recorded here, by the
--    operator, deliberately: the number is an attestation, and the chain
--    cross-check in `reconcile()` pauses custody if the chain ever shows less
--    than the books claim.
--
--    DEFAULT 0 is the fail-closed value: until the operator records the float
--    they actually sent, `balance >= outstanding + fee reserve` cannot hold and
--    no new liability can be created. That is the correct direction for a fresh
--    deployment (Task 18 operator checklist).
ALTER TABLE custody_controls
  ADD COLUMN operator_float_luna BIGINT NOT NULL DEFAULT 0;

ALTER TABLE custody_controls
  ADD CONSTRAINT custody_controls_operator_float_non_negative
    CHECK (operator_float_luna >= 0);

COMMENT ON COLUMN custody_controls.operator_float_luna IS
  'operator-attested custody money that is not drop funding (fee float); ledger credit';
COMMENT ON COLUMN custody_controls.reconciled_confirmed_balance_luna IS
  'chain cross-check only; the solvency invariant runs on the ledger balance';
