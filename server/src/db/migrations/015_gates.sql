-- Conditional claim gates. Nothing here holds money. The only coupling to the
-- money core is one nullable FK, `gate_grants.consumed_claim_id`.

CREATE TABLE drop_gates (
  drop_id    UUID PRIMARY KEY REFERENCES drops(id),
  kind       TEXT NOT NULL,
  listed     BOOL NOT NULL DEFAULT false,
  -- Kind-specific settings, validated by that kind's module and never by the
  -- claim path. `trivia` holds tier/bank_version/question_count/seconds;
  -- `passphrase` holds a salted hash, never the word; `attested` holds the
  -- attester public key and a max attestation age.
  config     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT drop_gates_kind_allowed
    CHECK (kind IN ('trivia','passphrase','attested'))
);

-- One grant per wallet per drop, ever.
--
-- Not "one unconsumed grant": `claims` already allows one claim per wallet per
-- drop via UNIQUE (drop_id, recipient_address), so a second grant could never
-- be spent and its only effect would be to confuse an audit.
CREATE TABLE gate_grants (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id           UUID NOT NULL REFERENCES drop_gates(drop_id),
  wallet_address    TEXT NOT NULL,
  -- Which kind issued it. Denormalised for audit; the claim path ignores it.
  kind              TEXT NOT NULL,
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_claim_id UUID NULL REFERENCES claims(id),
  UNIQUE (drop_id, wallet_address)
);

CREATE INDEX gate_grants_unconsumed
  ON gate_grants (drop_id, wallet_address) WHERE consumed_claim_id IS NULL;

-- ---- kind: trivia ----------------------------------------------------------
--
-- Sessions are a state machine only. The "one pass per wallet" invariant lives
-- in gate_grants, not here, which is why repeated FAILED sessions need no
-- special handling: a pass simply tries to insert a grant and the unique
-- constraint is the authority.

CREATE TABLE trivia_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id         UUID NOT NULL REFERENCES drop_gates(drop_id),
  wallet_address  TEXT NOT NULL,
  state           TEXT NOT NULL,
  bank_version    TEXT NOT NULL,
  question_ids    JSONB NOT NULL,
  delivered_count INT  NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ NULL,
  CONSTRAINT trivia_sessions_state_allowed
    CHECK (state IN ('in_progress','passed','failed','expired')),
  CONSTRAINT trivia_sessions_delivered_non_negative
    CHECK (delivered_count >= 0)
);

CREATE INDEX trivia_sessions_wallet_recent
  ON trivia_sessions (drop_id, wallet_address, started_at DESC);

CREATE TABLE trivia_answers (
  session_id     UUID NOT NULL REFERENCES trivia_sessions(id),
  question_index INT  NOT NULL,
  question_id    TEXT NOT NULL,
  delivered_at   TIMESTAMPTZ NOT NULL,
  deadline_at    TIMESTAMPTZ NOT NULL,
  answered_at    TIMESTAMPTZ NULL,
  answer_index   INT  NULL,
  is_correct     BOOL NULL,
  -- One submission per question, enforced by the database.
  PRIMARY KEY (session_id, question_index),
  CONSTRAINT trivia_answers_index_non_negative CHECK (question_index >= 0),
  CONSTRAINT trivia_answers_answer_range
    CHECK (answer_index IS NULL OR answer_index BETWEEN 0 AND 3)
);

-- ---- kind: passphrase ------------------------------------------------------
--
-- Wrong guesses, per address per drop. A durable counter rather than an
-- in-memory one: the cap is about an address, and a restart must not hand a
-- brute-forcer a fresh five.

CREATE TABLE passphrase_attempts (
  drop_id        UUID NOT NULL REFERENCES drop_gates(drop_id),
  wallet_address TEXT NOT NULL,
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX passphrase_attempts_recent
  ON passphrase_attempts (drop_id, wallet_address, attempted_at DESC);

-- ---- kind: attested --------------------------------------------------------
--
-- Replay protection for third-party attestations. One row per accepted nonce.

CREATE TABLE attestation_nonces (
  drop_id    UUID NOT NULL REFERENCES drop_gates(drop_id),
  nonce_hash TEXT NOT NULL,
  used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (drop_id, nonce_hash)
);
