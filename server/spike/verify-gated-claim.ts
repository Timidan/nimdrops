/**
 * OPERATOR UTILITY — play a live trivia drop and claim it, over HTTPS.
 *
 *   PUBLIC_ID=<22-char id> pnpm tsx spike/verify-gated-claim.ts
 *
 * The gate half of the settlement evidence. `s3-settlement-e2e.ts` proves the
 * money path against an ungated drop and `fund-one-drop.ts` proves activation;
 * neither touches a condition, so nothing yet shows that a real deployment
 * serves five questions, scores them, writes a grant, and then pays a claim that
 * the grant authorised — which is the whole product promise of a gated drop.
 *
 * Everything here goes through the PUBLIC API, over the real origin, exactly as
 * a browser would. It holds no database handle and no custody key. That is the
 * point: a green run is evidence about the deployment rather than about this
 * file, in the same spirit as `fund-one-drop.ts` refusing to write `drops`.
 *
 * ── the answers come from the bank, and that is not cheating ────────────────
 * A human player knows the answers or does not. This script reads the operator's
 * own bank file to answer correctly, because what is under test is the SERVER's
 * scoring, grant and claim path — not whether a script can pass a quiz. It needs
 * `TRIVIA_BANK_PATH` for that, and it needs `TRIVIA_SELECTION_SALT` for nothing
 * at all: which five questions get asked is the server's business, and this
 * script simply answers whatever it is shown.
 *
 * ── what a pass proves, and what it does not ────────────────────────────────
 * Proves: sessions start under an asserted address; questions arrive one at a
 * time with a server deadline; a complete correct session returns `passed` with
 * a review; the grant it writes is matched by `reserveClaim` against an address
 * DERIVED from a real signature; and the payout is reserved.
 *
 * Does NOT prove: anything about a phone. The deep link, the QR, the share
 * sheet, the wallet's own approval screens and whether the payout is visible in
 * Nimiq Pay all need a device, and §3c of the hackathon notes keeps those rows
 * separate on purpose.
 *
 * ── environment ─────────────────────────────────────────────────────────────
 *   PUBLIC_ID        (required) the funded, live, trivia-gated drop
 *   PUBLIC_ORIGIN    (default http://localhost:8080; set it explicitly to reach a deployment)
 *   TRIVIA_BANK_PATH (required) the same bank the deployment serves
 *   NIMIQ_NETWORK    (required) must match the deployment
 *   SIG_SCHEME       (default nimiq-signed-message)
 */
import { KeyPair, PrivateKey } from '@nimiq/core'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { loadBank } from '../src/gates/trivia/bank'

const ORIGIN = process.env.PUBLIC_ORIGIN ?? 'http://localhost:8080'
const PUBLIC_ID = process.env.PUBLIC_ID ?? ''
const BANK_PATH = process.env.TRIVIA_BANK_PATH ?? ''

/**
 * No `exitAfterTeardown` here, deliberately: this script holds no chain client
 * and no pool. It speaks HTTPS and reads one file, so there is nothing to close
 * and `process.exit` is honest.
 */
function fail(message: string): never {
  throw new Error(message)
}

function step(n: string, detail: string): void {
  console.log(`[${n}] ${detail}`)
}

async function api(
  path: string,
  init?: { method?: string; body?: unknown; idemKey?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      // A HEADER, not a body field. `only()` refuses an unexpected body key
      // outright, so putting it in the body is two errors rather than one.
      ...(init?.idemKey ? { 'Idempotency-Key': init.idemKey } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  })
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    /* a non-JSON body is itself the finding; status carries it */
  }
  return { status: res.status, body }
}

/**
 * A throwaway claimant.
 *
 * Random rather than derived: unlike `fund-one-drop.ts` there is nothing to
 * resume here, and a fresh wallet per run is what keeps a second run from
 * meeting its own `already_granted` and one-claim-per-wallet from the first.
 */
function newClaimant() {
  const keyPair = KeyPair.derive(PrivateKey.fromHex(randomBytes(32).toString('hex')))
  return {
    publicKeyHex: keyPair.publicKey.toHex(),
    address: keyPair.publicKey.toAddress().toUserFriendlyAddress(),
    /**
     * Signs the way a real Nimiq wallet signs, matching `SIG_SCHEME`.
     *
     * Signing the raw UTF-8 was the obvious thing and produced
     * `invalid_signature` against the deployment, which runs
     * `nimiq-signed-message` — the scheme a keyguard actually uses. It hashes
     * `\x16Nimiq Signed Message:\n` + the DECIMAL BYTE LENGTH + the message,
     * and signs that digest. Mirrors `signedBytes` in `src/auth/verify.ts`; a
     * script that signed the wrong bytes would prove nothing about the claim
     * path except that the signature check works.
     */
    sign: (message: string) => {
      const body = Buffer.from(message, 'utf8')
      if ((process.env.SIG_SCHEME ?? 'nimiq-signed-message') === 'raw') {
        return keyPair.sign(new Uint8Array(body)).toHex()
      }
      const digest = createHash('sha256')
        .update(
          Buffer.concat([
            Buffer.from('\x16Nimiq Signed Message:\n', 'utf8'),
            Buffer.from(String(body.byteLength), 'utf8'),
            body,
          ]),
        )
        .digest()
      return keyPair.sign(new Uint8Array(digest)).toHex()
    },
  }
}

async function run(): Promise<void> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(PUBLIC_ID)) fail('set PUBLIC_ID to a 22-character drop id')
  if (!BANK_PATH) fail('set TRIVIA_BANK_PATH to the bank this deployment serves')

  const bank = await loadBank(BANK_PATH)
  step('bank', `${bank.questions.length} questions, version ${bank.version}`)

  // 1 ---------------------------------------------------------------- the game
  const game = await api(`/api/games/${PUBLIC_ID}`)
  if (game.status !== 200) fail(`GET /api/games/${PUBLIC_ID} answered ${game.status}`)
  if (game.body.kind !== 'trivia') fail(`this drop is kind ${String(game.body.kind)}, not trivia`)
  if (game.body.state !== 'live') {
    fail(`this drop is ${String(game.body.state)}; fund it first (spike/fund-one-drop.ts)`)
  }
  step('game', `live, tier ${String(game.body.tier)}, ${String(game.body.slotsRemaining)} slot(s) left`)

  const claimant = newClaimant()
  step('wallet', `playing as ${claimant.address}`)

  // 2 ------------------------------------------------------------- the session
  const started = await api(`/api/games/${PUBLIC_ID}/session`, {
    method: 'POST',
    body: { walletAddress: claimant.address },
  })
  if (started.status !== 200) {
    fail(`POST session answered ${started.status}: ${JSON.stringify(started.body)}`)
  }
  const sessionId = String(started.body.sessionId)
  const questionCount = Number(started.body.questionCount)
  step('session', `${sessionId}, ${questionCount} questions`)

  // 3 --------------------------------------------------- answer every question
  let outcome: Record<string, unknown> = {}
  for (let i = 0; i < questionCount; i += 1) {
    const q = await api(
      `/api/games/${PUBLIC_ID}/session/${sessionId}/question?wallet=${encodeURIComponent(claimant.address)}`,
    )
    if (q.status !== 200) fail(`GET question ${i} answered ${q.status}: ${JSON.stringify(q.body)}`)

    // The server never sends the answer, so it is looked up by PROMPT — the one
    // field that identifies a question across the wire. A prompt the bank does
    // not hold means the deployment is serving a different bank than this
    // script was pointed at, which is worth failing loudly for.
    const prompt = String(q.body.prompt)
    const question = bank.questions.find((x) => x.prompt === prompt)
    if (!question) fail(`the deployment served a question this bank does not contain: ${prompt}`)
    const answerIndex = (q.body.options as string[]).indexOf(question.options[question.answerIndex])
    if (answerIndex < 0) fail(`the right option is missing from the options served for: ${prompt}`)

    const submitted = await api(`/api/games/${PUBLIC_ID}/session/${sessionId}/answer`, {
      method: 'POST',
      body: { questionIndex: q.body.questionIndex, answerIndex, walletAddress: claimant.address },
    })
    if (submitted.status !== 200) {
      fail(`POST answer ${i} answered ${submitted.status}: ${JSON.stringify(submitted.body)}`)
    }
    outcome = submitted.body
    step('answer', `${i + 1}/${questionCount} → ${String(outcome.state)}`)

    // Mid-session there must be nothing to read. Asserted here rather than
    // trusted, because this is the leak the whole scoring design exists to stop.
    if (i < questionCount - 1) {
      if (outcome.state !== 'in_progress') fail(`session ended early at answer ${i}`)
      if (outcome.review !== undefined) fail(`a review arrived mid-session, at answer ${i}`)
      if (outcome.correctCount !== undefined) fail(`a score arrived mid-session, at answer ${i}`)
    }
  }

  // 4 ------------------------------------------------------------- the outcome
  if (outcome.state !== 'passed') fail(`answered every question correctly and got ${String(outcome.state)}`)
  const review = outcome.review as Record<string, unknown>[] | undefined
  if (!review || review.length !== questionCount) fail('a passed session returned no full review')
  if (outcome.correctCount !== questionCount) {
    fail(`correctCount is ${String(outcome.correctCount)}, expected ${questionCount}`)
  }
  // This bank is imported from a public source, so every verdict should be
  // present. A null here on THIS bank means `disclosable` did not survive the
  // import or the load.
  const withheld = review.filter((r) => r.wasCorrect === null).length
  step('review', `${questionCount} rows, ${questionCount - withheld} with a verdict, score ${String(outcome.correctCount)}`)

  // 5 ---------------------------------------------------------------- the claim
  const challenge = await api(`/api/drops/${PUBLIC_ID}/challenge`, { method: 'POST' })
  if (challenge.status !== 200) fail(`POST challenge answered ${challenge.status}`)
  const claim = await api(`/api/drops/${PUBLIC_ID}/claims`, {
    method: 'POST',
    idemKey: randomUUID(),
    body: {
      challengeId: challenge.body.challengeId,
      publicKey: claimant.publicKeyHex,
      signature: claimant.sign(String(challenge.body.message)),
    },
  })
  if (claim.status !== 200 && claim.status !== 201) {
    fail(`POST claim answered ${claim.status}: ${JSON.stringify(claim.body)}`)
  }
  step('claim', `${String(claim.body.state)}, claim ${String(claim.body.claimId)}`)

  // 6 ------------------------------------------- the grant was actually spent
  //
  // A second claim by the SAME wallet must be refused. That is the check that
  // the grant was consumed rather than merely matched — one grant, one slot.
  // ONE fresh challenge, used once. Issuing a challenge per field would sign a
  // different message than the one submitted, and the refusal would then prove
  // the signature check rather than the grant being spent.
  const retry = await api(`/api/drops/${PUBLIC_ID}/challenge`, { method: 'POST' })
  const second = await api(`/api/drops/${PUBLIC_ID}/claims`, {
    method: 'POST',
    idemKey: randomUUID(),
    body: {
      challengeId: retry.body.challengeId,
      publicKey: claimant.publicKeyHex,
      signature: claimant.sign(String(retry.body.message)),
    },
  })
  if (second.status === 200 || second.status === 201) {
    fail('the same wallet claimed twice — one grant funded two slots')
  }
  step('reclaim', `refused ${second.status} ${String((second.body.error as { code?: string })?.code)}`)

  console.log(
    `\nPASSED — ${PUBLIC_ID} served five questions, scored them, granted, and paid one slot.\n` +
      `  claimant : ${claimant.address}\n` +
      `  claim    : ${String(claim.body.claimId)} (${String(claim.body.state)})\n\n` +
      'Still needs a real device (§3c): deep link, QR, share sheet, wallet approval\n' +
      'screens, and whether the payout is visible in Nimiq Pay.',
  )
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(`\nFAILED: ${(err as Error).message}`)
    process.exit(1)
  },
)
