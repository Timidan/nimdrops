# Offboarding and External Integration Boundary

NimDrops finishes a claim before offering any external destination:

```text
NimDrops entitlement -> finalized NIM payout -> claimant receipt
                                             -> optional external handoff
```

The competition build has three external handoffs:

| Need | Destination | What NimDrops sends |
|---|---|---|
| Open/install the wallet | Nimiq Pay deep link, App Store, Google Play | The current public HTTPS page only |
| Pay from the wallet | Nimiq Pay scanner, including supported Bitcoin Lightning payments | Nothing; the claimant uses their settled wallet balance |
| Spend NIM | Nimiq Crypto Map | Nothing; a plain link with no query or referrer |
| Explore selling NIM | Nimiq's official buy-and-sell directory | Nothing; a plain link with no amount, address, drop ID, or referrer |

These are navigation integrations, not payout rails. They cannot reserve a claim, move funds, report settlement, or change the receipt. Provider availability, minimums, fees, identity checks, and jurisdiction rules remain the provider's responsibility and are disclosed before the claimant leaves NimDrops.

NIM-to-USD conversion is not implemented. A future conversion provider must live server-side, use explicit quote and order records, reconcile ambiguous outcomes, and never trigger an automatic second order or parallel NIM payout. The current NIM ledger and `ChainClient` stay unchanged until a second working same-asset rail exists; see [ADR-001](adr-001-payout-rails.md).

External distribution uses canonical HTTPS drop links, server-rendered preview metadata, QR, copy, and the operating system share sheet. NimDrops does not require platform OAuth, messaging SDKs, bots, or delivery webhooks to distribute a drop.
