-- Which questions a wallet has already been shown.
--
-- This exists so a session can REVEAL its answers afterwards without handing
-- over a reusable key. Those two rules only work as a pair:
--
--   * a question is never served to the same wallet twice, so knowing its answer
--     is worth nothing to that wallet;
--   * therefore the answers can be shown, which is the whole learning payoff.
--
-- It replaces the previous bound. Selection used to be deterministic per
-- (drop, wallet) so a retry served the identical set, and a failure leaked one
-- bit: brute force was 4^5 = 1024 attempts. With a reveal that bound would have
-- collapsed to about four attempts — test one option across all five questions,
-- read every verdict, repeat — so determinism is deliberately given up here and
-- pool size takes over as the thing that makes enumeration expensive.
--
-- Scoped to the WALLET, not to the drop. Per-drop would let the same wallet meet
-- the same question again on the next drop, which is exactly the repetition the
-- reveal makes dangerous.
--
-- Deliberately NOT foreign-keyed to a questions table: the bank is a file, not a
-- table, and its ids must survive a re-import. `import-opentdb.ts` derives ids by
-- hashing question text for that reason.

CREATE TABLE trivia_seen (
  wallet_address TEXT NOT NULL,
  question_id    TEXT NOT NULL,
  /** The session that first showed it. Audit only; nothing reads it. */
  session_id     UUID NULL REFERENCES trivia_sessions(id),
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, question_id)
);

-- Selection reads every id one wallet has seen, on every session start. This is
-- the index that keeps that a lookup rather than a scan as the table grows.
CREATE INDEX trivia_seen_by_wallet ON trivia_seen (wallet_address);
