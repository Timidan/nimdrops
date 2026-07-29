<div align="center">

<img src="web/public/brand/lockup.svg" alt="NimDrops" height="64">

**One funding transaction. One link. A fixed share each.**

[![License: MIT](https://img.shields.io/badge/License-MIT-FF4D14.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Postgres](https://img.shields.io/badge/Postgres-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Nimiq](https://img.shields.io/badge/Nimiq-Albatross-FFB300)](https://nimiq.com)

[How it works](#-how-it-works) · [Architecture](#-architecture) · [Quickstart](#-quickstart) · [Operating it](#-operating-it) · [Security](#-security-and-threat-boundary)

</div>

---

A sponsor who wants to hand 100 people 2 NIM each has two options inside a wallet today: approve a hundred separate payments, or collect a hundred addresses first. Neither scales past a small room.

NimDrops replaces both with **one funding transaction and one shareable HTTPS link**. The sponsor picks the amount per person and the number of people; the total is derived exactly, in integer luna, with no remainder and no randomness. Each wallet that opens the link may sign once and receive that exact amount, first come first served. Whatever nobody claims goes back to the sponsor.

Red packets are established prior art — Binance and WeChat have shipped them for years. The Nimiq-specific wedge is narrower and worth stating plainly: one sponsor approval produces one externally shareable link for many deterministic recipients, inside a payments app people already have. That is a different shape from a Nimiq Cashlink (one recipient) and from a tip page (incoming, many payers).

<div align="center">
<table>
<tr>
<td width="25%"><img src="docs/screenshots/sealed-envelope.png" alt="A sealed red envelope with a wax seal, captioned 'Hold to open — nothing is signed yet'"></td>
<td width="25%"><img src="docs/screenshots/claim.png" alt="The claim screen showing 5 NIM, shares left, time remaining and the sponsor's message"></td>
<td width="25%"><img src="docs/screenshots/claimed.png" alt="Confirmation that the payment is on the Nimiq blockchain, with the transaction hash"></td>
<td width="25%"><img src="docs/screenshots/share-link.png" alt="The same link on a device without a wallet, offering a deep link and a QR code"></td>
</tr>
<tr>
<td align="center"><sub><b>Sealed</b><br>Holding costs nothing<br>and signs nothing</sub></td>
<td align="center"><sub><b>Opened</b><br>The amount is visible<br>before any signature</sub></td>
<td align="center"><sub><b>Paid</b><br>Only after finality,<br>with the receipt</sub></td>
<td align="center"><sub><b>No wallet</b><br>A finished state,<br>not an error</sub></td>
</tr>
</table>
</div>

## <img src="web/public/brand/mark.svg" width="18" alt=""> Custody disclosure

Read this before funding anything.

- **Funds are temporarily held by the operator.** Between the moment your funding transaction finalizes and the moment each payout finalizes, the NIM sits in a custody wallet controlled by the operator — not in a smart contract, not in your wallet. "Environment variable" and "open-source signer" are not security boundaries.
- **There is no on-chain escrow, and there cannot be one in this shape.** A Nimiq HTLC pays one named recipient. A drop pays a list of people nobody knows at funding time, so no contract on this chain can express it. That is why a person holds the money, not an implementation shortcut.
- **Nothing caps the size of a drop.** The amount at risk is whatever sponsors have funded and nobody has claimed yet. `GET /api/custody` publishes the live unclaimed total, and the create screen shows it above the fund button. What protects it is operational, not cryptographic: a ledger-derived solvency check that refuses to create a liability the books cannot cover, a single advisory-locked signer, an operator pause switch that stops every payment at once, and 64 blocks of finality before any funding counts.
- **There is no proof of unique personhood.** A wallet signature proves control of one address, not one human. Anyone able to produce signatures from several wallets can claim several shares of the same drop. The promise is *one claim per verified wallet per drop*, and never more than that.
- **Expiry is a window the sponsor chooses**, from 1 hour to 14 days, defaulting to 24, counted from finalized activation. At expiry the drop stops accepting claims, every already-reserved claim is still honoured, and exactly one refund is created for the unallocated value. It goes to the address that sent the verified funding transaction and to no other address.
- **The sponsor can end their own drop early, and only the sponsor can.** Same transition as expiry, triggered by a one-use five-minute wallet signature bound to that drop. Claims already reserved are paid in full. Closing is irreversible.

## <img src="web/public/brand/mark.svg" width="18" alt=""> How it works

### 1. Create and fund

The sponsor enters NIM per person and number of people; the total is `amount_each × claim_count`, computed in integer luna. They approve **one** native Nimiq Pay transaction that pays the custody address and carries the versioned ASCII memo `ND1:<publicId>`.

The backend does not activate on a memo scan. It activates on the exact transaction hash, and only when every predicate holds: correct network, successful execution, recipient exactly the configured custody address, value exactly `expected_funding_luna`, data exactly `ND1:<publicId>` within 64 UTF-8 bytes, a valid sender, a hash that has funded no other drop, and 64 blocks of depth. The verified sender — never a client request body — becomes the immutable creator and refund address. Partial, excess, duplicate, wrong-memo, wrong-recipient and wrong-network deposits are refused and land in the operator's reconciliation report.

### 2. Claim

A claimant opens the link and sees the sponsor label, the shortened verified funding address, the exact amount, how many shares remain, the expiry and the message. No claimant addresses are ever shown.

They tap **Claim** and approve one signature. The server issues a short-lived, single-use canonical challenge (origin, network, version, action, drop ID, nonce, issued-at, expiry), verifies the returned signature, and **derives the payout address from the verified public key** — the request carries no independently trusted address, so there is nothing to substitute.

Allocation is one Postgres transaction: lock `custody_controls`, then the drop row, recheck idempotency and the one-wallet-one-claim record under the lock, atomically consume the challenge, reserve the next slot, and write the deterministic `payout:<claimId>` transfer intent. Reserving the final slot flips the drop to `closing` in the same transaction. No blockchain call happens while the lock is held. The UI shows "Paid" only after finality, with the receipt.

The flow is called **tap and approve**, never "one tap" — a cold claimant can meet a deep-link warning plus a native signature confirmation, and the copy says so.

### 3. Conditional claims

A drop can be gated behind a condition the claimant meets first. Three kinds ship: a **passphrase** the sponsor says out loud, an **attestation** from whoever runs the drop, and **trivia** — five questions, four options each, one server-stamped deadline per question.

Trivia pays by score: three of five correct claims 60% of the share, four claims 80%, five claims all of it. Per-question correctness is never revealed during a session, and a question is never served to the same wallet twice. Meeting a condition writes a grant; the grant is consumed by the claim it pays for, in the same transaction.

### 4. Expiry and refund

At `expires_at`, expiry locks the same drop row and moves `live → closing`. Reserved claims stay liabilities and continue through the payout queue. The unallocated value is written as exactly one refund to the immutable verified funding sender, through the same persist-then-broadcast path as every payout. The drop reaches `refunded` only after every payout liability and the refund confirm. A signer outage can never move a reserved claimant's value into a sponsor refund.

## <img src="web/public/brand/mark.svg" width="18" alt=""> Architecture

```
sponsor wallet ──Nimiq Pay SDK──> custody address ──exact-hash verification──> drop live
custody key ──> persisted signed bytes ──> RPC broadcast ──> claimant / refund address
```

Five components, no more: a React/Vite frontend, one always-on Node/Hono API that also renders the SSR campaign pages and OG images, Postgres, one hot custody wallet, and one persistent worker. No Redis, no queue service, no indexer vendor, no identity provider.

The invariants that protect other people's money:

| Invariant | What it means |
|---|---|
| **Postgres is the financial source of truth** | Not the chain, not a cache. All values are positive integers in luna; no float ever crosses the money boundary. |
| **Persist signed bytes before broadcast** | The worker commits the exact serialized transaction and its deterministic hash as a `signed` attempt, then broadcasts *those stored bytes*. A timeout is resolved by querying the stored hash or rebroadcasting the same bytes, never by constructing a replacement. `broadcast` is not `paid`. |
| **`proven_dead` needs absence AND an expired window** | A single not-found is one node's opinion, and the pico client cannot see the mempool for ~30s after broadcast. Declaring an attempt dead requires two recorded absences at least five minutes apart, a fresh live lookup that is also absent, *and* a head past `validity_start_height + 7200` so the bytes can never be included again. |
| **One lock order, everywhere** | `custody_controls` → drop on activation and allocation; `custody_controls` → attempt → transfer on the worker and recovery paths. An earlier inversion produced a reproducible deadlock between an operator command and a payment confirmation. |
| **Solvency is ledger-derived** | `ledger balance ≥ outstanding principal + worst-case remaining fees`. A fully unclaimed drop still owes its whole principal. The chain balance is a cross-check that *pauses* when it holds less than the ledger, not the primary number. |
| **Exactly one worker signs** | It holds a Postgres advisory lock at global concurrency one. `--scale worker=2` is a bug, not a knob. |
| **Fail closed** | Paused custody, stale reconciliation, an exhausted fee reserve, a detected shortfall, or an unreadable chain each stop new money movement rather than guessing. `/health` stays 503 until the worker has reconciled. |

**Nimiq Pay integration.** `web/src/sdk/adapter.ts` is the only file allowed to import `@nimiq/mini-app-sdk`, and it exposes exactly three operations: `init()` for provider detection (it deliberately does not call `connect()`, which would cost the claimant an extra native prompt for information the signature already provides), `sign(message)` for claim authorization, and `sendBasicTransactionWithData()` for funding. There is deliberately no generic `send()` that would hide which key signs a transfer: SDK calls spend the user's key, while payouts and refunds are signed server-side and broadcast over the operator's own chain client.

## <img src="web/public/brand/mark.svg" width="18" alt=""> Quickstart

**Prerequisites:** Node ≥ 22, pnpm 11, Docker with Compose, and outbound WSS to the Nimiq seed nodes. Postgres comes from compose.

```bash
pnpm install
cp .env.example .env          # fill in real values; never commit this
```

Generate a custody key per environment, then print the address it derives to — this is what claimants are told to fund, so a mismatch sends real money to a wallet nobody controls:

```bash
cd server
CUSTODY_PRIVATE_KEY_HEX=... NIMIQ_NETWORK=TestAlbatross pnpm exec tsx -e \
  "import {nimiqChainFromEnv} from './src/chain/nimiq'; console.log(nimiqChainFromEnv().custodyAddress())"
```

Bring it up. Set the real hostname in `Caddyfile` first — Caddy provisions TLS from that name and nothing else:

```bash
docker compose build          # ALL services, never one at a time
docker compose up -d
```

> **Build every service together.** `server` and `worker` are separate images from the same Dockerfile, so `docker compose build server` leaves the worker running whatever code it was last built with. On one deployment this silently left a signing process four hours behind the API in front of it.

`.env.example` documents every variable with its purpose and failure mode. The ones without safe defaults are `DATABASE_URL`, `CUSTODY_PRIVATE_KEY_HEX` (worker only), `CUSTODY_ADDRESS`, `STATUS_TOKEN_SECRET`, `NIMIQ_NETWORK`, `SIG_SCHEME` and `PUBLIC_ORIGIN`; every process refuses to start without them rather than guessing.

**On `NIMIQ_FEE_LUNA`.** It defaults to 0, and at 0 fees consume nothing, so no claim count can exhaust the reserve. At a fee of *f*, every payout and refund costs *f* out of the attested operator float, and the number of outgoing transactions a deployment can pay is `(operator_float_luna − configured_fee_reserve_luna) / f`. If you set a non-zero fee, size the float for the drops you expect: a 100-claim drop needs 100 payouts.

## <img src="web/public/brand/mark.svg" width="18" alt=""> Repo map

| Path | What lives there |
|---|---|
| `server/src/services/` | The money core: claims, drops, close, expiry, solvency, transfers |
| `server/src/chain/` | The only chain client. Signing, broadcast, finality, reconciliation |
| `server/src/gates/` | Conditional claims: passphrase, attested, trivia, and grant issuance |
| `server/src/db/migrations/` | Schema, applied in filename order. Every constraint is documented in place |
| `server/src/http/` | Hono API, SSR campaign pages, OG images |
| `server/spike/` | Operator scripts: settlement harness, custody spikes, question-bank importer |
| `web/src/pages/` | The screens: landing, create, drop, close, games |
| `web/src/ui/` | The design system: field, sheet, envelope, the NIM lockup, tokens |
| `web/src/sdk/` | The Nimiq Pay adapter, and the only import of the Mini Apps SDK |
| `docs/architecture/` | Decision records and integration notes |

## <img src="web/public/brand/mark.svg" width="18" alt=""> Operating it

The CLI is `server/src/recover.ts`. Its structural constraint is one sentence: it resumes an existing transfer intent, or creates a replacement only after the prior one is `proven_dead`, and **no command may alter a recipient or an amount**. That is enforced by shape — neither `resume` nor `replace` accepts either; `replace` reads both off the immutable row.

```
pnpm tsx src/recover.ts <command> [argument]

  status                    One-screen incident snapshot. Read-only; run this first.
  resume <transferId>       Reconcile an intent against the chain, or re-queue it.
                            Signs nothing new. Safe to run repeatedly.
  replace <transferId>      Sign ONE replacement for a PROVEN DEAD attempt, same
                            recipient and amount. Refuses short of certainty.
  deposits                  Custody deposits that are no drop's accepted funding.
  float show                Print the float attestation beside the ledger balance.
  float set <luna> --tx     Re-attest the float, attributed to a finalized deposit.
  pause <reason>            Global kill switch. Needs no chain node, on purpose.
  unpause                   Release it. Does not reconcile.
```

**Incident order.** `status` first, always — it never throws on a chain problem and tells you whether custody is paused, which network the database is bound to, and what has been unsettled longest. Then `pause` if the cause is not yet understood. Then `resume` for anything in `manual_review`; it signs nothing new. Use `float show` and `deposits` to diagnose a solvency refusal. `replace` last and rarely: it is the only command that can spend the same intent's money twice, so it re-checks the whole proof under the row locks. If it refuses, look the hash up on a block explorer rather than running it again. `unpause` only after a clean reconcile.

## <img src="web/public/brand/mark.svg" width="18" alt=""> Testing

```bash
cd server && pnpm test
cd web    && pnpm test
```

The `*.race.test.ts` suites need a real Postgres and **skip silently without `DATABASE_URL`** — check that you actually ran them:

```bash
docker run --rm -d --name nimdrops-test -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_USER=nimdrops -e POSTGRES_DB=nimdrops -p 5432:5432 postgres:16

cd server && DATABASE_URL=postgres://nimdrops:dev@localhost:5432/nimdrops pnpm test
```

Each race suite migrates a throwaway schema and drops it afterwards. Between them they cover: many concurrent wallets racing the last slot; a claim racing exact expiry; the same wallet and the same idempotency key retrying; the same key with a changed request returning `409`; crash after allocation, after signing, and immediately after broadcast; two workers competing where only the advisory-lock holder signs; a broadcast timeout resolving by stored hash without a second payment; a proven-dead attempt being replaceable while an ambiguous one is not; and a refund that includes only unallocated slots. Several are mutation-verified — the test is checked to fail when the invariant is removed.

**Settlement harness.** `server/spike/s3-settlement-e2e.ts` drives the real service functions against Postgres and a real chain, in a throwaway schema, with real testnet NIM. It runs fail-closed solvency, float attestation, activation, a normal payout, a payout driven across two `kill -9` windows in separate child processes, forced expiry, the pause switch, a real out-of-band shortfall and its recovery, the refund, and a conservation audit against the custody wallet's own balance.

## <img src="web/public/brand/mark.svg" width="18" alt=""> Security and threat boundary

**What a wallet signature proves.** Control of one address at one moment, bound to one drop, one nonce, one origin and one network. That is all. A client-supplied device identifier is not server-attested and can be forged by a direct API caller, so `requestDeviceIdentifier` is deliberately unused in this codebase.

**Controls in place.** Unguessable 128-bit links, `noindex`, and no public feed — a public drop index would be a faucet index. One claim per wallet per drop, enforced by a database unique constraint rather than by application logic. Per-IP, per-wallet and per-drop rate limits, where the per-drop bucket is consumed only after signature verification so a malformed request cannot lock out a specific drop. The client IP is never taken from a header the client can send. A wall-clock bound on every chain call and a bounded per-tick scan, oldest-first, so one drop cannot stall every other. A global pause switch that works with the chain node down. Uniform generic responses where address enumeration would leak claim status; status tokens appear in no URL and no log, only their hashes are stored.

**Known gaps, stated rather than buried.**

- **The deposit report enumerates only via a test double.** `recover.ts deposits` needs every transaction paid to the custody address, but the frozen `ChainClient` interface answers only about a hash you already know. `FakeChain` satisfies the shape; `NimiqChain` does not implement it yet and raises `DepositEnumerationUnavailableError`. The intended fix is an explorer-backed `accountTransactions(address, limit)`.
- The API process holds the signing key even though it signs nothing; a read-only chain client for that process is an open hardening item.
- Rate-limit buckets are in-memory and per-process. Correct for one API process; would not survive horizontal scaling.
- **No real Nimiq Pay device signature fixture exists yet.** `server/test/fixtures/device-sign.json` is generated from Nimiq's published format with a throwaway key, so it proves the server verifies what the format says — not that the wallet obeys the format. A capture from a real phone is still owed.
- Custody is custody. The mitigations above are operational, not cryptographic. Read the custody disclosure as the whole of it.

**Reporting a problem.** Open an issue. If it concerns custody or a live drop, say so in the title and do not include a claimant's full address.

**What is stored about a claimant** — and what deliberately is not — is in [PRIVACY.md](./PRIVACY.md). In short: no claimant address is ever shown on a public surface, and `GET /api/games` selects none at all.

## <img src="web/public/brand/mark.svg" width="18" alt=""> License

MIT. See [LICENSE](./LICENSE).

Brand assets in `web/public/brand/` and the imagery in `web/public/images/` carry their own terms — see [`IMAGERY-LICENSES.md`](./web/public/images/nimdrops/IMAGERY-LICENSES.md) and [`BADGES.md`](./web/public/badges/BADGES.md).
