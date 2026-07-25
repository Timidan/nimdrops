-- NimDrops core financial schema (design §6.3).
-- All NIM values are BIGINT luna (1 NIM = 100_000 luna). No floating point anywhere.
-- Invariants that protect money are enforced by the database, not by application code.

CREATE TABLE drops (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id             TEXT UNIQUE NOT NULL,          -- >=128 random bits, URL-safe
  sponsor_label         TEXT NOT NULL,
  message               TEXT NULL,
  claim_count           INT NOT NULL,
  amount_each_luna      BIGINT NOT NULL,
  expected_funding_luna BIGINT NOT NULL,
  creator_address       TEXT NULL,                     -- set from verified funding tx
  refund_address        TEXT NULL,                     -- same verified sender for Cycle I
  state                 TEXT NOT NULL,
  closing_reason        TEXT NULL,                     -- expired | exhausted
  funding_tx_hash       TEXT UNIQUE NULL,
  activated_height      BIGINT NULL,
  funding_block_hash    TEXT NULL,
  expires_at            TIMESTAMPTZ NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT drops_amount_positive
    CHECK (amount_each_luna > 0),
  CONSTRAINT drops_claim_count_range
    CHECK (claim_count BETWEEN 2 AND 20),
  CONSTRAINT drops_expected_funding_exact
    CHECK (expected_funding_luna = claim_count * amount_each_luna),
  CONSTRAINT drops_state_allowed
    CHECK (state IN (
      'awaiting_funding', 'funding_pending', 'live', 'closing',
      'settled', 'refunded', 'paused', 'manual_review', 'cancelled'
    )),
  CONSTRAINT drops_closing_reason_allowed
    CHECK (closing_reason IS NULL OR closing_reason IN ('expired', 'exhausted'))
);

CREATE TABLE claims (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id           UUID NOT NULL REFERENCES drops(id),
  slot_index        INT NOT NULL,
  recipient_address TEXT NOT NULL,
  status_token_hash TEXT UNIQUE NOT NULL,
  state             TEXT NOT NULL,
  reserved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (drop_id, slot_index),
  UNIQUE (drop_id, recipient_address),
  CONSTRAINT claims_slot_index_non_negative
    CHECK (slot_index >= 0),
  CONSTRAINT claims_state_allowed
    CHECK (state IN ('reserved', 'sending', 'confirming', 'paid', 'manual_review'))
);

CREATE TABLE wallet_challenges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id           UUID NOT NULL REFERENCES drops(id),
  nonce_hash        TEXT UNIQUE NOT NULL,
  canonical_message TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ NULL
);

CREATE TABLE outgoing_transfers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   TEXT UNIQUE NOT NULL,   -- payout:<claimId> | refund:<dropId>
  purpose           TEXT NOT NULL,          -- payout | refund
  drop_id           UUID NOT NULL REFERENCES drops(id),
  claim_id          UUID NULL REFERENCES claims(id),
  recipient_address TEXT NOT NULL,
  amount_luna       BIGINT NOT NULL,
  state             TEXT NOT NULL,          -- queued | in_progress | confirmed | manual_review
  last_error        TEXT NULL,
  next_attempt_at   TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outgoing_transfers_amount_positive
    CHECK (amount_luna > 0),
  CONSTRAINT outgoing_transfers_purpose_allowed
    CHECK (purpose IN ('payout', 'refund')),
  CONSTRAINT outgoing_transfers_state_allowed
    CHECK (state IN ('queued', 'in_progress', 'confirmed', 'manual_review')),
  CONSTRAINT outgoing_transfers_purpose_claim_shape
    CHECK (
      (purpose = 'payout' AND claim_id IS NOT NULL) OR
      (purpose = 'refund' AND claim_id IS NULL)
    )
);

-- One payout intent per claim, one refund intent per drop. The caller-supplied
-- idempotency string is a convenience; these indexes are the financial invariant.
CREATE UNIQUE INDEX one_payout_per_claim
  ON outgoing_transfers (claim_id) WHERE purpose = 'payout';
CREATE UNIQUE INDEX one_refund_per_drop
  ON outgoing_transfers (drop_id) WHERE purpose = 'refund';

CREATE TABLE transaction_attempts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id          UUID NOT NULL REFERENCES outgoing_transfers(id),
  sequence             INT NOT NULL,
  state                TEXT NOT NULL,   -- signed | broadcast | confirmed | proven_dead
  raw_signed_tx        BYTEA NOT NULL,  -- encrypted at rest if available
  tx_hash              TEXT UNIQUE NOT NULL,
  fee_luna             BIGINT NOT NULL,
  observed_height      BIGINT NULL,
  observed_block_hash  TEXT NULL,
  confirmed_height     BIGINT NULL,
  confirmed_block_hash TEXT NULL,
  last_error           TEXT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, sequence),
  CONSTRAINT transaction_attempts_sequence_positive
    CHECK (sequence >= 1),
  CONSTRAINT transaction_attempts_fee_non_negative
    CHECK (fee_luna >= 0),
  CONSTRAINT transaction_attempts_state_allowed
    CHECK (state IN ('signed', 'broadcast', 'confirmed', 'proven_dead'))
);

-- At most one open (signed or broadcast) attempt per intent: a replacement may
-- only be built once the prior attempt is proven_dead (or confirmed).
CREATE UNIQUE INDEX one_open_attempt
  ON transaction_attempts (transfer_id) WHERE state IN ('signed', 'broadcast');

CREATE TABLE http_idempotency (
  scope           TEXT NOT NULL,
  key_hash        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     UUID NULL,
  response_status INT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, key_hash)
);

CREATE TABLE custody_controls (
  singleton                         BOOL PRIMARY KEY CHECK (singleton),
  paused                            BOOL NOT NULL,
  max_live_principal_luna           BIGINT NOT NULL,
  configured_fee_reserve_luna       BIGINT NOT NULL,
  last_reconciled_height            BIGINT NULL,
  last_reconciled_at                TIMESTAMPTZ NULL,
  reconciled_confirmed_balance_luna BIGINT NULL,
  CONSTRAINT custody_controls_caps_non_negative
    CHECK (max_live_principal_luna >= 0 AND configured_fee_reserve_luna >= 0)
);

INSERT INTO custody_controls (
  singleton, paused, max_live_principal_luna, configured_fee_reserve_luna
) VALUES (
  true, false, 10000000, 100000
);
