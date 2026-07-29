-- Uncapped operator drops (owner decision, 2026-07-29; design doc: docs/
-- superpowers/specs/2026-07-29-operator-funded-drops-design.md's successor —
-- see the PR that added this file for the write-up).
--
-- WHY. `createOperatorFundedDrop` commits `claim_count × amount_each_luna` of
-- operator float up front, because `outstandingPrincipalLuna` sums
-- `expected_funding_luna` for every open drop. A game that should run "for as
-- long as custody has NIM to cover the next claim" has no such total to commit,
-- so it needs a `claim_count` that can be absent.
--
-- `drops.claim_count` becomes NULLABLE. NULL means uncapped: no slot ceiling,
-- no `expected_funding_luna` total, running until the float cannot cover the
-- next claim. `expected_funding_luna` becomes nullable with it, for the same
-- reason 024 kept `refund_address` nullable — an uncapped drop has no fixed
-- total to record any more than an operator drop has a verified sender.
--
-- ONLY AN OPERATOR DROP MAY BE UNCAPPED. A sponsor's exposure must stay
-- knowable — they are shown a total before they pay — so `drops_expected_
-- funding_exact` keeps requiring one for `funding_source = 'sponsor'`, and a
-- new CHECK ties a NULL `claim_count` to `funding_source = 'operator'` alone.
-- `createDraft` (sponsor path) never passes NULL, so no existing behaviour
-- changes for a sponsor drop.
--
-- Two services read `claim_count`, and both change to match:
--
--   * `outstandingPrincipalLuna` (services/solvency.ts): a capped drop's
--     liability is still `expected_funding_luna` minus its finalized payouts,
--     unchanged. An uncapped drop's liability is instead the SUM of its
--     payout `outgoing_transfers` that are not yet finalized — what it has
--     actually committed to and not yet paid — because there is no total to
--     subtract finalized payouts from.
--   * `reserveClaim` (services/claims.ts): a capped drop still refuses at
--     `claim_count` and flips the drop to `closing` on its last slot. An
--     uncapped drop skips both — there is no ceiling and no last slot — and
--     instead asserts solvency right after the claim and its payout transfer
--     are written, still inside the same transaction and the same lock, so a
--     refusal rolls both rows back. Checked AFTER the write on purpose:
--     `assertSolvent`'s added-liability argument is only safe to use for
--     money that is credited to the ledger at the same instant, which a
--     sponsor's funding is and an uncapped payout is not — so the payout has
--     to already be counted by `outstandingPrincipalLuna` before the check
--     runs, the same way `createOperatorFundedDrop` already asserts a drop's
--     own principal.
ALTER TABLE drops
  ALTER COLUMN claim_count DROP NOT NULL;

ALTER TABLE drops
  ALTER COLUMN expected_funding_luna DROP NOT NULL;

ALTER TABLE drops
  DROP CONSTRAINT drops_expected_funding_exact;

ALTER TABLE drops
  ADD CONSTRAINT drops_expected_funding_exact
    CHECK (
      (claim_count IS NULL AND expected_funding_luna IS NULL) OR
      (claim_count IS NOT NULL AND expected_funding_luna IS NOT NULL
        AND expected_funding_luna = claim_count * amount_each_luna)
    );

ALTER TABLE drops
  ADD CONSTRAINT drops_uncapped_requires_operator
    CHECK (claim_count IS NOT NULL OR funding_source = 'operator');

COMMENT ON COLUMN drops.claim_count IS
  'NULL means uncapped: no slot ceiling, running while custody can cover the next claim. '
  'Only funding_source = ''operator'' may be NULL (drops_uncapped_requires_operator) — a '
  'sponsor''s exposure must stay knowable. See services/solvency.ts outstandingPrincipalLuna '
  'and services/claims.ts reserveClaim.';

COMMENT ON COLUMN drops.expected_funding_luna IS
  'NULL together with claim_count (drops_expected_funding_exact): an uncapped drop has no '
  'fixed total to record, the same way an operator drop already has no refund_address.';
