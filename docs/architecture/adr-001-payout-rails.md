# ADR-001: Keep NIM Settlement Frozen; Add Polygon USDT as a Same-Asset Rail Later

**Status:** Accepted for competition scope; post-competition design direction  
**Date:** 26 July 2026  
**Research:** [Nimiq ecosystem and USD payout report](../research/Nimiq_Ecosystem_USD_Payout_20260726/report.md)

## Context

NimDrops currently implements a NIM-funded custodial pot with NIM payouts and NIM expiry refunds. The competition release has four days remaining. Nimiq Pay supports Polygon USDT and exposes an EVM provider, but no live canonical NIM-to-EVM bridge or public Mini App swap primitive exists.

“Fund in NIM and let each claimant select USD on any network” crosses four boundaries at once: asset conversion, destination-chain settlement, custody/solvency, and exchange/compliance operations. It cannot be represented safely as another value in the current outgoing transfer `purpose` field or as methods added to the NIM `ChainClient`.

## Decision

1. Cycle I remains NIM-only. Polygon, USDT, swaps, and destination selection stay outside the competition money path.
2. The existing `ChainClient` remains Nimiq-specific and unchanged.
3. The first added stablecoin product may be a creator-funded **Polygon USDT Stable Drop** in a separate post-competition build. Funding, claims, payouts, accounting, and refunds use the same token on the same chain.
4. A shared `PayoutRail` interface will be extracted only while implementing that second working rail. It will compose the NIM client; it will not replace it with a prematurely generic chain interface.
5. NIM-funded claimant-selected conversion is not a scheduled feature. It is conditional research that can be reconsidered only when live economics and supported integration plumbing meet explicit gates.
6. “USD” in product copy will be “Polygon USDT” unless the product actually uses a regulated bank payout rail.

## Target boundary

The eventual boundary should express settlement capabilities, not arbitrary networks:

```ts
type AssetId = 'NIM' | 'USDT_POLYGON'

interface PayoutRail {
  readonly asset: AssetId
  getFundingInstructions(dropId: string): Promise<FundingInstructions>
  verifyFunding(input: FundingSubmission): Promise<VerifiedFunding>
  prepareTransfer(intent: SameAssetTransferIntent): Promise<PreparedTransfer>
  broadcast(prepared: PreparedTransfer): Promise<BroadcastResult>
  reconcile(reference: TransferReference): Promise<TransferState>
}
```

This interface is illustrative, not authorization to refactor before the second rail begins. Quote and conversion methods do not belong here because same-asset settlement and asset conversion are different concerns.

The Polygon rail is a second custody engine. Its required end-to-end path is:

```text
creator EVM address
  -> Polygon USDT custody address (creator pays POL under current Mini App rules)
  -> backend ERC-20 funding verifier
  -> serialized EVM nonce + signed USDT payout (operator pays POL)
  -> claimant's verified EVM address
  -> same-asset USDT refund to verified creator address (operator pays POL)
```

This path does not bridge NIM. It must be proven on a real Nimiq Pay device before the product commits to Stable Drops. In particular, verify ERC-20 return values, chain ID, token contract, creator POL failure UX, recipient token visibility, backend nonce recovery, and refund behavior. If Nimiq exposes a supported native USDT funding request with gas abstraction later, it can replace only the creator-funding step; it does not remove the Polygon custody engine.

If conversion is added later, use a separate interface:

```ts
interface ConversionProvider {
  quote(request: ConversionQuoteRequest): Promise<ConversionQuote>
  createOrder(acceptedQuote: AcceptedQuote): Promise<ConversionOrder>
  fund(order: ConversionOrder, preparedSourceTx: PreparedTransfer): Promise<void>
  reconcile(orderId: string): Promise<ConversionOrderState>
}
```

## Data-model consequences

Same-asset Stable Drops need rail-aware but conversion-free fields:

- immutable `drops.asset` and `drops.rail`;
- amounts stored in the asset's smallest integer unit;
- an asset-aware custody account and fee-reserve policy;
- chain-specific attempts and confirmation data;
- unique one-payout-per-claim and one-refund-per-drop constraints unchanged in meaning.

Claimant-selected conversion later needs separate records:

- immutable source entitlement;
- signed payout selection;
- accepted quote with fee/rate expiry;
- conversion order and provider identifiers;
- destination transfer attempt;
- explicit failure/manual-review/fallback state.

Do not overload current `outgoing_transfers` with provider orders or store decimal fiat amounts in its NIM integer columns.

## Security invariants for any future stablecoin rail

- One claim settles once across all payout rails.
- The destination address is proven by a domain-separated signature and bound to drop, claim, chain, token, nonce, and expiry.
- Chain ID and token contract come from a server allowlist.
- Prepared transfers are stored before broadcast and reconciled by deterministic hash/nonce.
- EVM nonce allocation is serialized per custody account.
- Recipient choice becomes immutable when the entitlement is reserved.
- Expiry cannot refund an entitlement with an in-flight payout or conversion.
- New orders fail closed when quotes, RPC, provider status, gas reserve, or treasury reconciliation is stale.
- Provider credentials and custody keys are separate secrets with separate rotation and incident controls.
- An external exchange hold never triggers an automatic second order or a simultaneous NIM fallback.

## Consequences

Positive:

- The competition build keeps its tested NIM accounting and failure model.
- Polygon USDT can be added without conversion, slippage, or exchange/KYC dependencies.
- Future providers can churn without infecting the entitlement ledger.
- Product copy remains precise and supportable.

Negative:

- A NIM-funded claimant cannot immediately select USDT.
- Stable Drops require a second custody balance, POL gas reserve, nonce manager, and EVM reconciler.
- Creator funding through today's Mini App EVM transaction path requires creator-held POL; receiving does not require claimant gas, but later Mini App transfers can.
- A future conversion product still requires provider partnership and likely legal/compliance review.

## Rejected alternatives

- **Add EVM/swap methods to `ChainClient`:** conflates Nimiq chain access, EVM token settlement, and exchange orchestration.
- **Per-claim ChangeNOW/SimpleSwap now:** dynamic minimums, multi-minute latency, AML holds, and refund ambiguity are incompatible with the promised claim experience.
- **Per-claim Fastspot now:** best trust model, but requires partner API access, HTLC state, typed redemption signing/watchtower support, and economically poor micro quotes.
- **Prefunded USDT treasury with NIM intake now:** fast UX but makes NimDrops an FX broker with inventory, pricing, reserve, and compliance risk.
- **Arbitrary stablecoin/network selector:** multiplies contracts, gas tokens, RPCs, monitoring, and stranded-asset support before one stable rail is proven.

## Revisit conditions

Revisit NIM-to-Polygon-USDT conversion only after all of these are true. Until then it is considered economically unavailable, not deferred roadmap scope:

1. Competition NIM settlement is mainnet- and device-proven.
2. Real users request stable settlement and the expected claim size exceeds route minimums/fees.
3. Nimiq or Fastspot supplies a supported third-party integration path and production terms.
4. An end-to-end spike proves quote, signing, funding, settlement, timeout, refund, ambiguous response recovery, and provider outage handling.
5. The operator has a written policy for conversion fees, FX slippage, AML/KYC holds, privacy, and jurisdiction restrictions.
6. Polygon USDT is still surfaced and supported in the current Nimiq Pay release.
7. Representative live quotes meet both a positive minimum output (target at least 1 USDT) and a maximum all-in haircut (target at most 5%) at the product's observed claim sizes.
