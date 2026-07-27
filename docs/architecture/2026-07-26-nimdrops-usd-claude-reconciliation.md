# NimDrops USD Payout — review reconciliation

**Date:** 26 July 2026  
**Verdict:** **AGREE WITH CHANGES**  
**Reviewed decision:** [ADR-001](adr-001-payout-rails.md) and the [ecosystem research report](../research/Nimiq_Ecosystem_USD_Payout_20260726/report.md)

An independent an independent review review agreed with the core sequence:

1. Ship NIM-only for the competition.
2. Treat creator-funded Polygon USDT as the first plausible stablecoin rail.
3. Do not add claimant-selected NIM-to-USDT conversion to the competition build.

the reviewer required five material clarifications, all now incorporated:

- Mainnet, real-device, and TLS work are release gates, not polish; USDT work must not consume the remaining competition window.
- Polygon USDT needs a separate EVM custody engine, nonce manager, gas reserve, and reconciler; it is not a small extension of the NIM engine.
- The gas-payer model must be explicit. Under the current Mini App EVM API, creator funding needs POL; the operator pays POL for payouts and refunds; claim receipt itself needs no claimant gas.
- Claimant-choice conversion is conditionally unavailable at red-packet sizes, not a scheduled roadmap feature. It can be reconsidered only if live economics or a supported Nimiq primitive materially change.
- The entire Stable Drop flow must be proven without relying on Nimiq's future EVM bridge. Same-asset Polygon USDT settlement should not touch NIM at all.

No disagreement remains on the competition scope or the recommended post-competition order. Agreement does not replace the current NIM release gates or the future Polygon device/mainnet spike.
