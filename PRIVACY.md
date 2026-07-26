# Privacy note

NimDrops is a custodial NIM campaign-link app. It handles money, so it keeps records. This page says exactly which ones, and what it does not keep. It describes the behaviour that is implemented today, not an intention.

## What is stored

**Campaign records.** For each drop: the sponsor label and optional message you typed, the number of shares, the amount per share, the drop's public ID, its state, and its timestamps. The sponsor label is user-supplied text and is displayed as unverified — it is not checked against anything.

**Wallet addresses.** Three kinds, all of them addresses you already published on-chain by transacting:

- the address that sent the verified funding transaction, kept as the immutable creator and refund address for the drop;
- each claimant address, derived from the public key in the signature you approved — never typed in, never taken from a request body;
- the same claimant or sponsor address again on the outgoing transfer row that pays it.

**Transaction records.** Funding, payout and refund transaction hashes, block heights and block hashes, plus the exact serialized signed bytes of each attempt. The signed bytes are retained deliberately: rebroadcasting the same bytes rather than constructing new ones is what stops a crashed worker from paying twice, and the audit trail keeps every hash and byte string of every attempt, including superseded ones.

**Hashed values only.** Claim status tokens are stored as hashes; the plaintext bearer token is returned to your browser and never written down here. HTTP idempotency keys are stored as hashes, scoped to a route, alongside a hash of the request body. Challenge nonces are stored as hashes.

**Challenge records.** The canonical message you signed (origin, network, version, action, drop ID, nonce, issue and expiry times), when it was issued and when it was consumed.

**Timestamps** on essentially every row: created, reserved, confirmed, reconciled.

## What is not stored

- **No analytics.** There is no analytics service, no tracking pixel, no third-party script, no product-telemetry identifier of any kind in this codebase.
- **No device identifiers.** The Nimiq Mini Apps SDK exposes `requestDeviceIdentifier`. NimDrops deliberately does not call it, anywhere. A client-supplied device ID is not server-attested and can be forged by a direct API caller, so it would be a privacy cost with no security benefit.
- **No account, email, phone number, name or profile.** There is no sign-up. Nothing links a wallet address to a person unless that link already exists somewhere else.
- **No personal data beyond what the chain already makes public**, plus the sponsor label and message you chose to write into the campaign.
- **No claimant addresses in public responses.** The public drop page shows the sponsor label, a shortened verified funding address, the amount, the counts, the expiry and the message. It never lists who claimed.

## On-chain data is public and permanent

Funding, payouts and refunds are ordinary Nimiq transactions. Anyone can look up the custody address on a block explorer and see who funded a drop, which addresses were paid and how much. The funding transaction also carries the drop's public ID in its memo (`ND1:<publicId>`), which links that transaction to that campaign for anyone who has the link.

This is a property of the blockchain, not of NimDrops. Deleting a record here would not remove anything from the chain, and nothing on the chain can be edited or withdrawn.

## Retention

Be aware of what this section does **not** say: there is no automatic deletion of anything, and no retention period is implemented.

What actually happens today:

- Drop, claim, challenge, transfer and attempt rows are **kept indefinitely**. They are financial and audit records; a payment system that forgets which payments it made cannot prove it made them once.
- An unfunded draft older than 24 hours is marked `cancelled`. Its row is **not** deleted — this is garbage collection of a state, not of data. No money was ever received for it.
- HTTP idempotency records carry an `expires_at` column, but nothing currently sweeps expired rows.

If a retention or deletion policy is added, this file changes first.

## Logs

Logs are for diagnosis, so they are written to be dull. Application alerts and error logs carry internal database IDs, route names, error identities and on-chain transaction hashes — identifiers that are either meaningless outside the database or already public on the chain.

They deliberately do not carry: private keys, signatures, public keys, raw serialized transactions, status bearer tokens, request bodies, request headers, or full claimant addresses. The operator's incident report (`recover.ts status`) omits recipient addresses for the same reason: the transfer IDs are what an operator needs, and the two commands that act on a transfer read the address themselves from the immutable row.

Honest caveat: this is enforced at the call sites, by choosing what to pass, rather than by a serializer that strips these fields structurally. A structural redactor is a planned hardening item and is not written yet. The reverse proxy also writes ordinary HTTP access logs, which include client IP addresses.

Client IP addresses are used in memory for rate limiting. The API reads no forwarding header directly: it buckets by the socket peer, unless the request carries an address nominated by our own reverse proxy and authenticated with a shared secret, which is how the real client is recovered when a CDN sits in front. Anything a client sends itself — `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP` — is ignored, and every misconfiguration collapses everyone into one shared bucket rather than letting anyone choose their own. Those buckets live in the API process's memory and are never written to the database. The reverse proxy separately writes ordinary HTTP access logs, which do include client IP addresses.

## Third parties

The app talks to the Nimiq network (public seed nodes) and to nothing else. There is no CDN account, no analytics vendor, no error-reporting service, no email provider. If an alert webhook is configured by the operator, alert payloads — internal IDs, alert kind, hashes — go to that endpoint.

## Contact

Open an issue on this repository. If your question concerns a specific drop or claim, quote the drop's public ID or the transaction hash, and please do not post a full claimant address in a public issue. No separate privacy contact address has been published yet.
