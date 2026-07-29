-- Operator-funded drops (design doc: docs/superpowers/specs/
-- 2026-07-29-operator-funded-drops-design.md).
--
-- Every gated game — trivia and anything gated after it — is funded by the
-- operator, never by a sponsor's own funding transaction. Before this, the only
-- way for a drop to reach `live` was `activate()`: a real funding transaction,
-- verified to 64 blocks, whose sender becomes the immutable refund address.
-- An operator game has no sponsor to be that sender, so the previous approach
-- (`spike/fund-one-drop.ts`) had custody seed a throwaway wallet that paid the
-- money straight back to itself — two chain transactions and a 64-block wait,
-- a light client that has to work at creation time, and a solvency invariant
-- that briefly claims more NIM than the chain holds (the seed leaves custody
-- with no ledger row) — all to prove the operator paid the operator.
--
-- `funding_source` replaces that ceremony with a fact. The NIM behind an
-- operator drop is already in custody: the drop only changes which bucket it
-- is counted in, never how much custody holds. An operator drop is created
-- directly `live`, with `activated_height` NULL (it never goes through
-- `activate()`) and no funding transaction ever recorded against it.
--
-- Two services read this column, and the design doc's arithmetic depends on
-- them treating it differently:
--
--   * `outstandingPrincipalLuna` (services/solvency.ts) counts a drop when
--     `activated_height IS NOT NULL` OR `funding_source = 'operator'` — an
--     operator drop's principal is a real claimant liability the moment it is
--     created, even though nothing verified a funding transaction for it.
--   * `ledgerMovementsLuna` is UNCHANGED and still credits only
--     `activated_height IS NOT NULL`. No money entered custody for an operator
--     drop, so nothing may be credited — this is the term that keeps
--     `ledgerBalanceLuna` equal to the chain. Crediting it here would invent
--     money that was never deposited.
--
-- The two facts together are the whole point: `ledgerBalance` does not move
-- and `outstandingPrincipal` rises by the drop's principal, so solvency
-- headroom falls by exactly that principal. Creating an operator drop is
-- therefore refused unless the float can already cover it — "a game runs
-- while custody holds NIM no drop has claimed."
ALTER TABLE drops
  ADD COLUMN funding_source TEXT NOT NULL DEFAULT 'sponsor';

ALTER TABLE drops
  ADD CONSTRAINT drops_funding_source_allowed
    CHECK (funding_source IN ('sponsor', 'operator'));

COMMENT ON COLUMN drops.funding_source IS
  'sponsor (default): live only via a verified funding transaction (activate()), '
  'activated_height set, refund_address the verified sender. operator: created '
  'directly live by an operator script against the database, activated_height '
  'NULL, no funding transaction — the NIM was already in custody. See '
  'services/solvency.ts outstandingPrincipalLuna and services/drops.ts '
  'createOperatorFundedDrop.';

-- `refund_address` (001_core.sql) is already `TEXT NULL` — it was designed
-- nullable from the start, for exactly the state a draft sits in before
-- `activate()` stamps it with the verified funding sender. That same
-- nullability is what makes an operator drop's shape legal without a column
-- change here: an operator drop never has a verified sender to name, so
-- `refund_address` stays NULL for its whole life. `services/expiry.ts`
-- (`closeLiveDrop`, `settleTerminal`) reads that NULL to skip writing a
-- refund transfer for an operator drop entirely — there is nothing to send
-- back, because nothing ever left custody in the first place.
