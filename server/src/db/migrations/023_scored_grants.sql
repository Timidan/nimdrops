-- A grant may carry a payout fraction, in permille of the drop's full share.
--
-- NULL means the full share, which is every grant issued before this migration
-- and every kind that has no notion of partial success. Trivia writes 600, 800
-- or 1000 (score/questionCount x 1000).
--
-- On the GRANT, not the claim, so the money path stays kind-agnostic: claims.ts
-- reads a number off a row it already locks and never learns what a score is.
ALTER TABLE gate_grants
  ADD COLUMN payout_permille SMALLINT NULL
  CHECK (payout_permille > 0 AND payout_permille <= 1000);
