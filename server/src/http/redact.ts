/**
 * Log redaction (design §10.3, HACKATHON.md §8: "Logs omit keys, signatures,
 * device IDs, full wallet addresses, and serialized secrets").
 *
 * Until this module existed, redaction here was CALL-SITE DISCIPLINE: every
 * `console.info(JSON.stringify({...}))` in the codebase was hand-audited to
 * carry only internal IDs, and a comment above `app.ts`'s error logger recorded
 * the promise. That works exactly until someone adds a field. A wallet address
 * or a `rawTxHex` reaches the host's log the first time a well-meaning `...detail`
 * spread widens, and nothing fails when it does — which is the definition of a
 * control that is not one.
 *
 * So the rule moved out of the comments and into a function. {@link safeLog} is
 * the one writer, {@link redact} is what it puts every value through, and the
 * tests below `server/test/redact.test.ts` assert per sensitive class rather
 * than per call site.
 *
 * ## What is masked, and why by KEY as well as by VALUE
 *
 * Two passes, because neither alone is enough:
 *
 *  - **By key.** `signature`, `publicKey`, `rawTxHex`, `statusToken`,
 *    `idempotencyKey`, anything private-key-shaped: these are secret *because of
 *    what they are*, whatever their value happens to look like. A truncated or
 *    malformed signature is still a signature.
 *  - **By value.** A long hex run, an `NQ..` address or a `Bearer <token>` is
 *    secret *wherever it appears* — and where it actually appears in practice is
 *    inside a free-form string nobody thought of as a field: a driver's error
 *    message, a stack frame, a webhook's failure text. `errorMessage(err)` is
 *    logged in nine places in this repo and its contents are the library's
 *    choice, not ours.
 *
 * ## The one deliberate exemption: transaction hashes
 *
 * A Nimiq transaction hash is 64 hex characters — byte-identical in shape to an
 * Ed25519 private key, which is why the value pass would eat it. It is also
 * PUBLIC (it is the explorer URL), and it is the single identifier that lets an
 * operator tie a log line to money on chain; `transfers.ts` logs it on the line
 * that says a payment finished, and HACKATHON.md §8 requires exactly that
 * lookup. So keys in {@link PUBLIC_ID_KEYS} keep their value verbatim.
 *
 * The exemption is by KEY NAME only. A 64-hex run inside an error string is
 * still masked, because there we do not know what it is — and "unknown, might be
 * a key" must fail towards masking.
 *
 * ## Addresses keep a prefix
 *
 * `NQ21 SEXP …` — the first 9 characters, per the plan. That is the network
 * prefix, the check digits and the first block: enough for an operator to
 * correlate two log lines about the same claimant, not enough to identify the
 * wallet or look it up on an explorer. Financial tables keep the canonical
 * address; logs get a handle.
 *
 * This module is dependency-free on purpose (like `config.ts`): the worker, the
 * services and the CLIs all import it, and none of them should drag in `pg` or
 * the WASM bundle to write a log line.
 */

/** How much of an address survives redaction. `NQ21 SEXP` is 9 characters. */
export const ADDRESS_PREFIX_CHARS = 9

/** What replaces a value we will not print at all. */
export const REDACTED = '[redacted]'

/** Appended to the surviving prefix of an address, so truncation is visible. */
export const TRUNCATED = '...'

/** Deepest object we will walk before giving up. Guards pathological inputs. */
const MAX_DEPTH = 6

/**
 * Field names whose VALUE is never printed, in any form.
 *
 * Compared after {@link normalizeKey}, so `raw_tx_hex`, `rawTxHex` and
 * `RAW-TX-HEX` are one entry. Deliberately generous: a false positive costs an
 * operator one field, a false negative costs a custody key.
 */
const SECRET_KEYS = new Set([
  // signatures and the material that verifies them
  'signature',
  'signaturehex',
  'sig',
  'sighex',
  'signedmessage',
  'signedbytes',
  'publickey',
  'publickeyhex',
  'pubkey',
  'pubkeyhex',
  // key material
  'privatekey',
  'privatekeyhex',
  'custodyprivatekeyhex',
  'sponsorprivatekeyhex',
  'key',
  'keyhex',
  'keypair',
  'seed',
  'seedphrase',
  'mnemonic',
  // serialized transactions — the bytes are a bearer instrument until broadcast
  'raw',
  'rawtx',
  'rawtxhex',
  'rawtransaction',
  'serializedtx',
  'signedtx',
  'txbytes',
  'txhex',
  // bearer credentials
  'token',
  'statustoken',
  'statustokenhash',
  'bearer',
  'bearertoken',
  'accesstoken',
  'authorization',
  'auth',
  'cookie',
  'setcookie',
  'apikey',
  'password',
  'passwd',
  'credential',
  'credentials',
  'secret',
  'statustokensecret',
  // request-scoped identifiers a client chose and could correlate on
  'idempotency',
  'idempotencykey',
  'idemkey',
  'idempotencykeyhash',
])

/**
 * Field names holding a wallet address. Reduced to a prefix, never dropped: an
 * operator triaging "did claimant X get paid twice" needs to see that two lines
 * are about the same wallet without learning which wallet.
 */
const ADDRESS_KEYS = new Set([
  'address',
  'addresses',
  'walletaddress',
  'recipientaddress',
  'senderaddress',
  'refundaddress',
  'custodyaddress',
  'claimantaddress',
  'payoutaddress',
  'depositaddress',
  'fundingaddress',
  'recipient',
  'sender',
])

/**
 * Field names whose value is a PUBLIC on-chain or internal identifier, exempt
 * from the value pass. See the module note: without this, every `txHash` in the
 * logs turns into `[redacted]` and the §8 "find a transfer by ID" requirement
 * dies with it.
 */
const PUBLIC_ID_KEYS = new Set([
  'txhash',
  'hash',
  'transactionhash',
  'blockhash',
  'fundingtxhash',
  'payouttxhash',
  'refundtxhash',
  'replacedtxhash',
])

/** `raw_tx_hex`, `rawTxHex` and `Raw-Tx-Hex` are the same field. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s.]/g, '')
}

/**
 * Set membership with a plural fallback, so `signatures` inherits `signature`
 * and `addresses` inherits `address` without a second copy of every entry.
 */
function names(set: Set<string>, name: string): boolean {
  return set.has(name) || (name.endsWith('s') && set.has(name.slice(0, -1)))
}

/**
 * A Nimiq user-friendly address, spaced (`NQ21 SEXP …`) or unspaced.
 *
 * 'NQ' + 2 check digits + 8 blocks of 4 base32 characters. Matched anywhere in
 * a string, because that is where they leak from — error text, memos, URLs.
 */
const NIMIQ_ADDRESS_RE = /NQ[0-9]{2} ?(?:[0-9A-Z]{4} ?){7}[0-9A-Z]{4}/g

/**
 * A hex run long enough to be key material.
 *
 * 32 characters = 16 bytes, the shortest thing worth calling a secret here; an
 * Ed25519 key is 64 and a signature 128. An optional `0x` is consumed so the
 * prefix does not survive as a hint. `\b` anchors keep it from firing inside a
 * longer word, and UUIDs (longest run: 12) are below the threshold by design —
 * internal IDs must stay readable.
 */
const LONG_HEX_RE = /\b(?:0x)?[0-9a-fA-F]{32,}\b/g

/**
 * A base64url blob long enough to be a status token.
 *
 * `statusToken()` is HMAC-SHA256 base64url — 43 characters. A drop's public id
 * is 22, so the 40-character floor separates the credential from the identifier
 * without needing to know which is which.
 */
const LONG_B64URL_RE = /[A-Za-z0-9_-]{40,}/g

/**
 * Runs the base64url rule must NOT eat: hex and dashes only.
 *
 * A UUID is 36 characters of exactly that alphabet, and two of them side by side
 * clear the 40-character floor. Internal ids ARE the operator's tracing handle
 * (§8), so they are spared explicitly — and nothing is lost by it, because a
 * pure-hex run of 32+ was already masked by {@link LONG_HEX_RE} one step
 * earlier. What survives here is only the hex-with-dashes shape.
 */
const IDENTIFIER_RE = /^[0-9a-fA-F-]+$/

/** `Authorization: Bearer <token>`, wherever it was stringified from. */
const BEARER_RE = /\b(bearer)\s+\S+/gi

/**
 * The credentials inside a URL: `postgres://nimdrops:hunter2@postgres:5432/…`.
 *
 * §10.3 lists "environment values", and this is the one that actually escapes.
 * `DATABASE_URL` is in every one of these processes and `pg` puts the whole
 * connection string into its own error text on a failed connect — which then
 * lands in `request_failed` via `errorMessage(err)`. The host and database are
 * kept, because "which database could we not reach" is the operational content.
 */
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi

/** First 9 characters plus a truncation marker; anything shorter is left alone. */
export function redactAddress(value: string): string {
  if (value.length <= ADDRESS_PREFIX_CHARS) return value
  return value.slice(0, ADDRESS_PREFIX_CHARS) + TRUNCATED
}

/**
 * Mask every secret-shaped RUN inside a free-form string.
 *
 * Order matters. URL credentials first (a password is not hex, not base64url
 * and not preceded by "Bearer"), then bearer tokens, then addresses (whose
 * blocks would otherwise be nibbled at by the base64url rule), then hex, then
 * base64url.
 */
export function redactString(value: string): string {
  return value
    .replace(URL_CREDENTIALS_RE, (_m, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(NIMIQ_ADDRESS_RE, (address) => redactAddress(address))
    .replace(LONG_HEX_RE, REDACTED)
    .replace(LONG_B64URL_RE, (run) => (IDENTIFIER_RE.test(run) ? run : REDACTED))
}

/**
 * Redact a value of any shape for logging.
 *
 * Objects and arrays are walked; every string — whether it is a field value, an
 * array element or an `Error.message` — goes through {@link redactString} unless
 * its field name says otherwise. `bigint` is stringified because `JSON.stringify`
 * throws on it, and a logger that throws is a logger that takes the process with
 * it. Cycles are broken rather than followed.
 */
export function redact(value: unknown): unknown {
  return walk(value, undefined, 0, new WeakSet())
}

function walk(
  value: unknown,
  key: string | undefined,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  const name = key === undefined ? undefined : normalizeKey(key)

  if (name !== undefined && names(SECRET_KEYS, name)) return REDACTED

  if (value === null || value === undefined) return value

  switch (typeof value) {
    case 'string':
      if (name !== undefined && names(ADDRESS_KEYS, name)) return redactAddress(value)
      // The one exemption, and only when the field NAMES itself a public id.
      if (name !== undefined && names(PUBLIC_ID_KEYS, name)) return value
      return redactString(value)
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    case 'function':
    case 'symbol':
      return REDACTED
    default:
      break
  }

  if (depth >= MAX_DEPTH) return '[deep]'

  const object = value as object
  if (seen.has(object)) return '[circular]'
  seen.add(object)

  if (value instanceof Date) return value.toISOString()

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack ? { stack: redactString(value.stack) } : {}),
    }
  }

  if (Array.isArray(value)) {
    // Elements inherit the ARRAY's field name: `signatures: [ ... ]` must mask
    // its contents, and `addresses: [ ... ]` must prefix them.
    return value.map((item) => walk(item, key, depth + 1, seen))
  }

  const out: Record<string, unknown> = {}
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = walk(childValue, childKey, depth + 1, seen)
  }
  return out
}

export type LogLevel = 'info' | 'warn' | 'error'

/**
 * THE logging helper. One JSON line, one timestamp, one redaction pass.
 *
 * Shape is `{event, at, ...detail}` — the shape `index.ts` and `worker.ts`
 * already used by hand, so adopting this changes what is printed (secrets stop
 * being) and not how it is parsed.
 *
 * It cannot throw. A log call that fails inside a `catch` block would replace a
 * recoverable error with an unrecoverable one, and the money paths call this
 * from exactly there; a value that defeats `JSON.stringify` degrades to a line
 * saying so instead.
 */
export function safeLog(
  level: LogLevel,
  event: string,
  detail: Record<string, unknown> = {},
): void {
  let line: string
  try {
    line = JSON.stringify({ event, at: new Date().toISOString(), ...(redact(detail) as object) })
  } catch {
    line = JSON.stringify({ event, at: new Date().toISOString(), note: 'detail not serializable' })
  }
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}

export function logInfo(event: string, detail: Record<string, unknown> = {}): void {
  safeLog('info', event, detail)
}

export function logWarn(event: string, detail: Record<string, unknown> = {}): void {
  safeLog('warn', event, detail)
}

export function logError(event: string, detail: Record<string, unknown> = {}): void {
  safeLog('error', event, detail)
}
