# NimDrops

Fund one NIM campaign with a single wallet approval, share one link, and let a fixed number of wallets each claim one equal payment.

An organizer who wants to hand 20 people 2 NIM each has, today, two options inside a wallet: approve twenty separate payments, or collect twenty addresses first. Neither scales past a small room. NimDrops replaces both with one funding transaction and one shareable HTTPS link. The sponsor picks the amount per person and the number of people; the total is derived exactly, with no remainder and no randomness. Each wallet that opens the link may sign once and receive that exact amount, first come first served. Whatever nobody claims goes back to the sponsor.

Red packets are established prior art — Binance and WeChat have shipped them for years, and NimDrops does not claim to have invented the format. The Nimiq-specific wedge is narrower and worth stating plainly: **one sponsor approval and one funding transaction produce one externally shareable link for many deterministic recipients**, inside a payments app people already have. That is a different shape from a Nimiq Cashlink (one recipient) and from a tip page (incoming, many payers). It is also custodial, which is why the disclosure below sits above the feature list rather than under it.

---

## Custody disclosure

Read this before funding anything.

- **Funds are temporarily held by the NimDrops operator.** Between the moment your funding transaction finalizes and the moment each payout finalizes, the NIM sits in a custody wallet controlled by the operator, not in a smart contract and not in your wallet. "Environment variable" and "open-source signer" are not security boundaries. The mitigation is deliberately small exposure and hard caps, not cryptographic guarantees.
- **Claims are fixed, first-come-first-served, and one per verified wallet.** There is **no proof of unique personhood.** A wallet signature proves control of one address. It does not prove one human. Anyone able to produce signatures from several wallets can claim several shares of the same drop.
- **Expiry is 24 hours from finalized activation**, not from when you started the draft. At expiry the drop stops accepting new claims, every already-reserved claim is still honoured, and exactly one refund is created for the unallocated value: `(claim_count − reserved_claims) × amount_each`. The refund goes to the address that sent the verified funding transaction and to no other address. No request body can change it.
- **Payouts and refunds wait for chain finality and can enter manual review.** NimDrops does not call a claim "paid" until its transaction is 64 blocks deep — the wallet's own `confirmed` state is not sufficient. During an RPC or signer incident a transfer is parked in `manual_review` and an operator resolves it by hand. Money is never silently re-sent, and a reserved claimant's share is never quietly turned into a sponsor refund.
- **Wallet addresses and transactions are public and permanent on-chain.** Anyone can see who funded a drop and who was paid from it. The app itself retains only the minimum operational records described in [PRIVACY.md](./PRIVACY.md).

---

## Current status

This is a competition build for the Nimiq Mini Apps Competition, Cycle I. Being exact about what is proven matters more here than sounding finished.

**Proven.** The end-to-end settlement gate passed on the intended judging deployment (docker compose: Postgres + API + one worker) against TestAlbatross, run `s3_20260726040800` on 2026-07-26. Full evidence: [`docs/evidence/g1-vps-s3_20260726040800.md`](./docs/evidence/g1-vps-s3_20260726040800.md). In one 361.6-second run, through the shipped service functions rather than a re-implementation:

| Leg | Result |
|---|---|
| Fail-closed solvency | Activation at operator float 0 refused with `InsolventError`; float then attested through `float set --tx cb112cce…` (200000 luna, height 7006397) |
| Funding → activation | 6000 luna funded with memo `ND1:BWcXLVpZxQomlV2t8bJzlQ`, activated under the global principal cap |
| Kill/restart | Payout B driven across three OS processes: `kill -9` after the `signed` row committed and before broadcast, `kill -9` the instant broadcast returned, then a third process let startup reconciliation finish. Result: 1 attempt row, 1 hash `2ed5ec14…`, 1 confirmation at height 7006573 |
| No double pay | Both claimant addresses hold **exactly 2000 luna** on chain — counted on the chain, not in our own books |
| Pause + shortfall | A paused custody created no attempt for a queued refund; a real out-of-band debit made the chain hold less than the ledger, reconcile paused and stamped `shortfall_detected_at`, and after `unpause` signing was **still** refused until a clean reconcile |
| Conservation | 4000 luna paid across 2 claims + 2000 luna refunded for 1 unallocated slot == 6000 luna funded; the custody wallet moved exactly 6000 luna, no unaccounted payment |

Exactly one thing in that run is forced: `expires_at` is set one second into the past by a direct `UPDATE`, because the production horizon is 24 hours. Every transition after that `UPDATE` is produced by shipped code.

**Not proven, and not claimed.**

- **No mainnet run has happened.** Every transaction above is TestAlbatross. The mainnet spike is blocked on operator provisioning (mainnet custody key generated on the host, mainnet NIM). Three things must be re-measured, not assumed, before mainnet: whether a 0-luna fee is still accepted, the finality wall-clock, and consensus establishment time from the deployment host. **Do not read this README as a claim of mainnet readiness.**
- **No real Nimiq Pay device signature fixture exists yet.** `SIG_SCHEME` selects which bytes a wallet signs (`raw` or `nimiq-signed-message`) and fails closed when unset — it is a configuration lock waiting on a measurement from a real phone, not a proven value. The exact return shape of `sendBasicTransactionWithData` (hash, or serialized transaction from which the hash must be derived) is likewise still to be settled on device; the bridge passes the provider's string through unchanged and logs the raw value.
- **TLS and a public hostname are not configured.** `Caddyfile` still names `drops.example.com`; no DNS name has been provided, so the stack currently listens only on the docker network.
- **The Day-0 (G0) mainnet gate and the real-device release matrix in [`docs/HACKATHON.md`](./docs/HACKATHON.md) are open**, as is the final adversarial code review of the settlement gate.
- **The deposit reconciliation report enumerates only against a test double.** See [Security and threat boundary](#security-and-threat-boundary).

---

## How it works

Three loops, all of them narrow on purpose.

### 1. Create and fund

The sponsor enters NIM per person and number of people; the total is `amount_each × claim_count`, computed in integer luna. They add an explicitly unverified sponsor label and an optional short message, review the total and the custody disclosure, and approve **one** native Nimiq Pay transaction. That transaction pays the custody address and carries the versioned ASCII memo `ND1:<publicId>` in its data field.

The backend does not activate on a memo scan. It activates on the exact hash, and only when every predicate holds: correct network, successful execution, recipient exactly the configured custody address, value exactly `expected_funding_luna`, data exactly `ND1:<publicId>` and within 64 UTF-8 bytes, a valid sender, a hash that has funded no other drop, and 64 blocks of depth. The verified sender — never a client request body — becomes the immutable creator and refund address. Partial, excess, duplicate, wrong-memo, wrong-recipient and wrong-network deposits are all refused and land in the operator's manual reconciliation report instead.

Once live, the sponsor gets a canonical HTTPS link (`/d/:publicId`, an unguessable 128-bit ID, `noindex`), a QR code, a campaign-specific Open Graph preview for chat platforms, and a Nimiq Pay deep link.

### 2. Claim

A claimant opens the link — in a chat, from a QR code, anywhere — and sees the sponsor label, the shortened verified funding address, the exact fixed amount, how many shares remain, the expiry and the message. No claimant addresses are shown.

They tap **Claim N NIM** and approve one signature. The server issues a short-lived, single-use canonical challenge (origin, network, version, action, drop ID, random nonce, issued-at, expiry), verifies the returned signature, and **derives the payout address from the verified public key**. The claim request carries no independently trusted payout address, so there is nothing to substitute.

Allocation is one Postgres transaction that locks `custody_controls` then the drop row, rechecks idempotency and the one-wallet-one-claim record under the lock, atomically consumes the challenge, reserves the next slot, and writes the deterministic `payout:<claimId>` transfer intent. Reserving the final slot flips the drop to `closing` in the same transaction. The response is `202 Reserved` plus an opaque status token; no blockchain call happens while the lock is held. The UI polls and shows "Paid" only after finality, with the transaction receipt.

The flow is called **tap and approve**, never "one tap" — a cold claimant can meet a deep-link warning plus one native signature confirmation, and the copy says so.

### 3. Expiry and refund

24 hours after activation, expiry locks the same drop row and moves `live → closing`. From that commit no new slot can be reserved. Reserved claims stay liabilities and continue through the payout queue. The unallocated value is computed and, if positive, exactly one refund transfer is written to the immutable verified funding sender and sent through the same persist-then-broadcast path as every payout. The drop reaches `refunded` only after every payout liability and the refund confirm — or `settled` if nothing was left over. A signer outage can never move a reserved claimant's value into a sponsor refund.

### Nimiq Pay integration

`web/src/sdk/adapter.ts` is the only file allowed to import `@nimiq/mini-app-sdk`, and it exposes exactly three operations:

- **`init()`** for provider detection. It deliberately does **not** call `provider.connect()`, because that calls `listAccounts()` and costs the claimant an extra native prompt for information the signature already provides.
- **`sign(message)`** for claim authorization. The returned public key is what the server derives the payout address from.
- **`sendBasicTransactionWithData({ recipient, value, data })`** for funding, with `data` set to the `ND1:<publicId>` memo. This is the only path that moves money from a user's wallet, and it is validated against the 64-byte memo limit before it is sent.

There is deliberately no generic `send()` that would hide which key signs a transfer: SDK calls spend the user's key, custodial payouts and refunds are signed server-side with `@nimiq/core` and broadcast over the operator's own chain client. A rejected promise and a resolved provider `ErrorResponse` both normalize into one typed `BridgeError`; a resolved value is never assumed to be success until its shape is checked.

Sharing falls back through the Web Share API, a QR code and copy-link. The deep link is `nimiqpay://miniapp?url=<encoded canonical https url>`, so the campaign ID survives the round trip through the wallet.

---

## Architecture

```
sponsor wallet ──Nimiq Pay SDK──> custody address ──exact-hash verification──> drop live
custody key ──> persisted signed bytes ──> RPC broadcast ──> claimant / refund address
```

Five components, no more: a React/Vite frontend, one always-on Node/Hono API that also renders the SSR campaign pages and OG image, Postgres, one capped hot custody wallet, and one persistent worker. No Redis, no queue service, no indexer vendor, no identity provider.

The invariants that actually protect other people's money:

- **Postgres is the financial source of truth.** Not the chain, not a cache. All NIM values are positive integers in luna; no JavaScript float ever crosses the money boundary.
- **Persist signed bytes before broadcast.** The worker signs, commits the exact serialized transaction and its deterministic hash as a `signed` attempt, and only then broadcasts *those stored bytes*. A broadcast timeout is resolved by querying the stored hash or rebroadcasting the same bytes — never by constructing a replacement. `broadcast` is not `paid`.
- **`proven_dead` requires sustained absence AND a passed validity window.** A single not-found answer is one node's opinion; the pico client cannot see the mempool for roughly the first 30 seconds after a broadcast, so acting on one lookup would double-pay. Declaring an attempt dead requires at least two recorded consecutive absences at least five minutes apart, a fresh live lookup that is also absent, *and* a head strictly past `validity_start_height + 7200` blocks so the bytes can never be included again. All of it is re-evaluated under the row locks.
- **One lock order, everywhere: `custody_controls` → drop** on the activation and allocation paths, and `custody_controls` → attempt → transfer on the worker and recovery paths. An earlier inversion in recovery produced a real, reproducible Postgres deadlock between an operator command and a payment confirmation — resolved by killing one side at random, which on that path is a coin flip over whether the operator or the payment survives.
- **Solvency is ledger-derived, with an attributable operator float.** The invariant is `ledger balance ≥ outstanding principal + worst-case remaining fees`, where outstanding principal counts open slots on live drops — a fully unclaimed drop still owes its whole principal — and in-flight attempts stay outstanding until they finalize. The chain balance is a cross-check that *pauses* when the chain holds less than the ledger, not the primary number. The operator's fee float is the one ledger credit no drop supplies, so it must be attested against a named finalized deposit that paid into custody and is not any drop's funding.
- **Exactly one worker signs.** It holds a Postgres advisory lock and global concurrency one. `docker compose up --scale worker=2` is a bug, not a knob.
- **Fail closed.** Paused custody, stale reconciliation, an exhausted fee reserve, a detected shortfall, or an unreadable chain each stop new money movement rather than guessing. `/health` stays 503 until the worker has reconciled.

---

## Running it

**Prerequisites:** Node ≥ 22, pnpm 11, Docker with Compose, and outbound WSS to the Nimiq seed nodes. Postgres comes from compose.

**Environment.** Copy `.env.example` to `.env` and fill in real values. Never commit `.env`. The names, with no values here:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string; the financial source of truth |
| `CUSTODY_PRIVATE_KEY_HEX` | Custody wallet key. Generate on the deployment host, back up encrypted, never in Git |
| `STATUS_TOKEN_SECRET` | HMAC secret for opaque claim status tokens |
| `NIMIQ_NETWORK` | `TestAlbatross` or `MainAlbatross`. No default; every process refuses to start without it |
| `SIG_SCHEME` | Which bytes a wallet signs: `raw` or `nimiq-signed-message`. Fails closed when unset |
| `PUBLIC_ORIGIN` | Canonical origin used in share links, OG tags and claim challenges |
| `PORT` | API port. Optional, defaults to 8080 |
| `ALERT_WEBHOOK_URL` | Operator alerts. Optional; falls back to console |
| `POSTGRES_PASSWORD` | Compose-only; not read by the app |
| `SPA_DIST` | Override for the built frontend directory. Optional |
| `NIMIQ_SEED_NODES` | Comma-separated seed override. Optional |
| `NIMIQ_FINALITY_DEPTH` | Confirmation depth. Optional; floor 64, may only be raised |
| `NIMIQ_VALIDITY_WINDOW_BLOCKS` | Transaction validity window. Optional; floor 7200, may only be raised |
| `NIMIQ_FEE_LUNA` | Per-transaction fee. Optional; defaults to 0 |

**Bring it up.** Set the real hostname in `Caddyfile` first — Caddy provisions TLS from that name and nothing else.

```bash
docker compose up -d --build
```

**Apply migrations.** They are deliberately not automatic; a financial schema change should be an operator action taken before the new image serves traffic. `migrate()` is idempotent and takes an advisory lock, so concurrent invocations are safe.

```bash
docker compose run --rm --entrypoint sh server -c "cd /app/server && pnpm tsx src/db/migrate-cli.ts"
```

**Required post-deploy step — attest the operator float.**

```bash
docker compose run --rm --entrypoint sh server -c \
  "cd /app/server && pnpm tsx src/recover.ts float set <luna> --tx <deposit hash>"
```

A fresh database **fails closed as insolvent** until this runs, and that is intended. Network fees are paid out of money no drop ever deposited, so the ledger has to be told about it — and told in a way an auditor can check. The `--tx` hash is mandatory: it must be final, execution-ok, paid *into* custody, not sent by custody, not any drop's funding transaction, and not already attested; `<luna>` must equal the sum of every deposit backing the float; and the resulting ledger balance may not exceed the on-chain custody balance. An unreachable chain is a refusal, not a guess. Until this is done, every activation is refused with `InsolventError` — which is exactly what the settlement gate observed on a fresh schema.

Verify with `recover.ts status`, then check `/health`.

---

## Operator runbook

The CLI is `server/src/recover.ts`. Its structural constraint is one sentence: it resumes an existing transfer intent, or creates a replacement attempt only after the prior one is `proven_dead`, and **no command may alter a recipient or an amount**. That is enforced by shape rather than discipline — neither `resume` nor `replace` accepts a recipient or an amount; `replace` reads both off the immutable `outgoing_transfers` row.

```
usage:
  pnpm tsx src/recover.ts <command> [argument]

commands:
  status
      One-screen incident snapshot: pause switch, bound network, solvency
      numbers, per-state row counts, manual_review transfers and the oldest
      unsettled attempt. Read-only; run this one first.

  resume <transferId>
      Reconcile an existing intent against the chain, or re-queue it when it has
      no open attempt. Signs nothing new; cannot change recipient or amount.

  replace <transferId>
      Sign ONE replacement for a PROVEN DEAD attempt, same recipient and amount.
      Refuses unless sustained absence and a passed validity window both hold.

  deposits
      Custody deposits that are no drop's accepted funding transaction: late,
      partial, excess, duplicate, unknown-memo and no-memo (design §7).

  float show
      Print the operator float attestation beside the ledger balance, the
      outstanding principal, the fee reserve, the caps and the on-chain custody
      balance. Read-only.

  float set <luna> --tx <hash>
      Re-attest the operator float, in whole positive luna, ATTRIBUTED to a
      finalized custody deposit. --tx is mandatory: the hash must be final, paid
      to custody, not any drop's funding and not already attested, and <luna>
      must equal the sum of every deposit backing the float. Also refuses any
      value that would push the ledger balance above the on-chain custody
      balance, and refuses outright when the chain cannot be read.

  pause <reason>
      Engage the global kill switch: every new money path fails closed. Needs no
      chain node — pausing must work when the node is the thing that broke.

  unpause
      Release the kill switch. Does not reconcile: a stale balance keeps failing
      closed until the worker's next successful reconcile.

  --help
      Print this block. Also printed, to stderr, on an unrecognised command.
```

**Incident order.**

1. **`status` first, always.** It is read-only, it never throws on a chain problem — a node that is down is printed as a fact rather than swallowing the whole report — and it tells you whether custody is paused, which network the database is bound to, whether the ledger still covers its liabilities, what is flagged for a human, and what has been unsettled the longest.
2. **`pause "<reason>"`** if the cause is not yet understood, or if `status` shows a shortfall or a stale reconciliation. Pausing needs no chain client on purpose.
3. **`resume <transferId>`** for anything in `manual_review`. This is the safe move: it signs nothing new, reconciles the existing attempt against the chain, and re-queues an intent that has no open attempt. Safe to run repeatedly.
4. **`float show`** and **`deposits`** to diagnose a solvency refusal — the first tells you whether the ledger, the float and the chain agree, the second surfaces late, partial, excess and unknown deposits that never activated anything.
5. **`replace <transferId>` last, and rarely.** It is the only command that can spend the same intent's money twice, so it re-checks the entire proof under the row locks and refuses on anything short of certainty — an inconclusive lookup, an undecodable or foreign-network attempt, an unexpired validity window, or an absence series shorter than the threshold. If it refuses, the answer is to look the hash up on a block explorer, not to run it again.
6. **`unpause`** only after a clean reconcile. Unpausing is permission to resume, not evidence that the balance is known — a detected shortfall keeps signing closed until reconciliation succeeds.

---

## Testing

The suite is Vitest. Unit and API tests run with no external services:

```bash
cd server && pnpm test          # or: pnpm vitest run
cd web    && pnpm test
```

The `*.race.test.ts` suites need a real Postgres and **skip silently without `DATABASE_URL`** — check that you actually ran them:

```bash
docker run --rm -d --name nimdrops-test -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_USER=nimdrops -e POSTGRES_DB=nimdrops -p 5432:5432 postgres:16

cd server
DATABASE_URL=postgres://nimdrops:dev@localhost:5432/nimdrops pnpm vitest run
```

Each race suite migrates a throwaway schema and drops it afterwards. Between them they cover: many concurrent wallets racing the last slot; a claim racing exact expiry; the same wallet and the same HTTP idempotency key retrying; the same key with a changed request returning `409`; crash after allocation, after signing and immediately after broadcast; two worker instances competing where only the advisory-lock holder signs; a broadcast timeout resolving by stored hash without a second payment; a proven-dead attempt being replaceable while an ambiguous one is not; concurrent activations being unable to exceed the globally locked principal cap; and a refund that includes only unallocated slots. Several of them are mutation-verified — the test is checked to fail when the invariant is removed.

One known flake, verified on an unmodified baseline and not introduced by any fix batch: `expiry.race.test.ts > resolves claim-versus-expiry one way or the other, 20 times` fails roughly one run in ten. It is owed a fix.

**Settlement harness.** `server/spike/s3-settlement-e2e.ts` is the end-to-end gate: it drives the real service functions against Postgres and a real chain, in a throwaway schema, with real testnet NIM.

```bash
cd server
DATABASE_URL=postgres://nimdrops:dev@localhost:5432/nimdrops \
NIMIQ_NETWORK=TestAlbatross CUSTODY_PRIVATE_KEY_HEX=<testnet key> \
pnpm tsx spike/s3-settlement-e2e.ts
```

It runs fail-closed solvency, float attestation, activation, a normal payout, a payout driven across two `kill -9` windows in separate child processes, forced expiry, the pause switch, a real out-of-band shortfall and its recovery, the refund, and a conservation audit against the custody wallet's own balance — then writes an evidence file. `S3_KEEP_SCHEMA=1` keeps the schema for inspection; `S3_EVIDENCE_PATH` redirects the output. It needs funded testnet custody; the testnet faucet has no captcha, so this does not require operator involvement.

---

## Security and threat boundary

**What a wallet signature proves.** Control of one address at one moment, bound to one drop, one nonce, one origin and one network. That is all. It does not prove one human, and NimDrops therefore promises *one claim per verified wallet per drop* — never one claim per person. A device identifier supplied by a client is not server-attested and can be forged by a direct API caller, so `requestDeviceIdentifier` is deliberately not used anywhere in this codebase.

**Controls actually in place.**

- Unguessable 128-bit links, `noindex`, and no public feed. A public drop index would be a faucet index, which is an abuse feature.
- One claim per wallet per drop, enforced by a database unique constraint rather than by application logic.
- Per-IP, per-wallet and per-drop rate limits. The per-drop bucket is consumed only after signature verification, so a malformed request cannot be aimed at locking out a specific drop; the client IP is read from the *last* `X-Forwarded-For` hop for the same reason.
- Hard caps in the schema: between 2 and 20 claims per drop, and an operator-set maximum aggregate live liability plus a fee reserve, both checked under the singleton lock before every activation, allocation and signature. A per-drop cap does not cap hot-wallet exposure, so the aggregate cap is the one that matters.
- A global pause switch that works with the chain node down, and automatic pausing on a detected shortfall or stale reconciliation.
- Uniform generic API responses where address enumeration would leak claim status; public drop state never returns claimant addresses, signatures or internal errors. Status tokens never appear in URLs or logs — only their hashes are stored.
- Log redaction as a discipline at the call sites: alerts and error logs carry internal IDs, route names and on-chain hashes, never signatures, raw transactions, bearer tokens or full claimant addresses. A dedicated serializer that would enforce this structurally is planned and not yet written.

**Known gaps, stated rather than buried.**

- **The deposit report enumerates only via a test double.** `recover.ts deposits` needs to list every transaction paid to the custody address, but the frozen `ChainClient` interface answers only about a hash you already know, and the pico client indexes by hash rather than by address. `FakeChain` satisfies the enumeration shape, so the report is proven against the test double; `NimiqChain` does not implement it yet, and on mainnet the command raises `DepositEnumerationUnavailableError`. The intended fix is a non-interface `accountTransactions(address, limit)` backed by the explorer API, and it is a pre-mainnet requirement.
- The API process currently holds the signing key even though it signs nothing; a read-only chain client for that process is an open hardening item.
- Rate-limit buckets are in-memory and per-process. With one API process that is correct; it would not survive horizontal scaling.
- Custody is custody. The caps are small on purpose because the honest mitigation for a hot wallet is exposure you can afford to lose, not an assurance.

**Reporting a problem.** Open an issue on this repository. If it concerns custody or a live drop, say so in the title and do not include a claimant's full address. No separate security contact address has been published yet.

---

## License

MIT. See [LICENSE](./LICENSE).

## Contributing and roadmap

The roadmap is in [design §14](./docs/superpowers/specs/2026-07-25-nimdrops-design.md#14-sustainable-roadmap) and it is deliberately demand-led: nothing on it gets built before Cycle I reliability is proven and a named partner actually asks for it. In order — campaign operations (creator history, configurable expiry, signed allowlists, external security review), then distribution adapters for a named partner, then merchant campaigns with real purchase verification. Direct tips and group jars may reuse the wallet-auth, funding-verifier and transfer-ledger pieces but get their own domain models and threat reviews; they are not new values of a `kind` column.

Explicitly not planned until a concrete use case forecloses the simpler path: bot platforms, OAuth identity vendors, indexers, other chains, other assets.

If you want to contribute, the highest-value work right now is the mainnet re-measurements and the device signature fixture listed under [Current status](#current-status) — everything else is downstream of those.
