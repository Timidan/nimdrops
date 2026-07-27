import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import type { ChainClient } from '../src/chain/types'
import { migrate } from '../src/db/migrate'
import {
  ChainStartupError,
  ChainUnavailableError,
  DepositAttestationError,
  InvalidLunaError,
  OverAttestationError,
  type RecoverOutcome,
  ReplaceRefusedError,
  USAGE,
  attestedFloatDepositsLuna,
  failed,
  faulted,
  flagValue,
  floatShow,
  main,
  setOperatorFloat,
  statusReport,
  succeeded,
} from '../src/recover'
import {
  InsolventError,
  assertSolvent,
  ensureNetworkBinding,
  ledgerMovementsLuna,
  lockControls,
  readControls,
} from '../src/services/solvency'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * `float` and `status` read GLOBAL aggregates (`ledgerMovementsLuna`,
 * `outstandingPrincipalLuna`, per-table state counts) and take the singleton
 * `custody_controls` row, so this suite cannot share tables with the other
 * `*.race.test.ts` files vitest runs in parallel. It migrates a private
 * Postgres schema and points its own pool's `search_path` at it; the service
 * code uses unqualified table names, so it lands in the private schema
 * unchanged.
 */
const SCHEMA = 'recover_ops_race_test'

const CUSTODY = 'NQ07 CUSTODY'

let pool: pg.Pool
let chain: FakeChain

interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>
}

// ---- chain doubles -------------------------------------------------------------

/** Delegating ChainClient so a single method can be made to fail. */
function chainWith(base: FakeChain, over: Partial<ChainClient>): ChainClient {
  const delegate: ChainClient = {
    network: () => base.network(),
    custodyAddress: () => base.custodyAddress(),
    headHeight: () => base.headHeight(),
    isFinal: (tx, head) => base.isFinal(tx, head),
    getTransaction: (hash) => base.getTransaction(hash),
    confirmedBalanceLuna: (address) => base.confirmedBalanceLuna(address),
    buildSignedBasic: (o) => base.buildSignedBasic(o),
    broadcast: (raw) => base.broadcast(raw),
  }
  return { ...delegate, ...over }
}

/**
 * Put `luna` into custody on the fake chain (an operator top-up) and move the
 * head well past it, so the deposit is FINAL — which is what `float set` now
 * requires of the hash it attests against (round-2 F4).
 *
 * Returns the hash so a test can pass it as `--tx`.
 */
function topUpCustody(luna: bigint, o: { final?: boolean } = {}): string {
  const hash = `topup-${randomUUID()}`
  chain.deposit({
    hash,
    sender: 'NQ07 OPERATOR',
    recipient: CUSTODY,
    valueLuna: luna,
    includedHeight: 1,
  })
  if (o.final !== false) chain.setHead(1_000)
  return hash
}

// ---- fixtures ------------------------------------------------------------------

interface DropInput {
  claimCount?: number
  amountEachLuna?: bigint
  state?: string
  activated?: boolean
}

async function insertDrop(db: Queryable, o: DropInput = {}): Promise<{ id: string }> {
  const activated = o.activated ?? true
  const claimCount = o.claimCount ?? 5
  const amountEach = o.amountEachLuna ?? 100n
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO drops (
       public_id, sponsor_label, claim_count, amount_each_luna, expected_funding_luna,
       state, funding_tx_hash, activated_height, creator_address, refund_address, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
     RETURNING id`,
    [
      randomUUID(),
      'Sponsor',
      claimCount,
      amountEach.toString(),
      (amountEach * BigInt(claimCount)).toString(),
      o.state ?? 'live',
      activated ? randomUUID() : null,
      activated ? '1000' : null,
      activated ? 'NQ07 CREATOR' : null,
      activated ? new Date(Date.now() + 86_400_000) : null,
    ],
  )
  return rows[0]
}

async function insertClaim(
  db: Queryable,
  dropId: string,
  slotIndex: number,
  state = 'reserved',
): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO claims (drop_id, slot_index, recipient_address, status_token_hash, state)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [dropId, slotIndex, `NQ07 CLAIMANT ${randomUUID()}`, randomUUID(), state],
  )
  return rows[0]
}

async function insertTransfer(
  db: Queryable,
  o: {
    purpose: 'payout' | 'refund'
    dropId: string
    claimId?: string | null
    amountLuna?: bigint
    state: 'queued' | 'in_progress' | 'confirmed' | 'manual_review'
    createdAgoSeconds?: number
  },
): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO outgoing_transfers (
       idempotency_key, purpose, drop_id, claim_id, recipient_address, amount_luna, state,
       created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7,
       now() - make_interval(secs => $8::float8))
     RETURNING id`,
    [
      o.purpose === 'payout' ? `payout:${o.claimId}` : `refund:${o.dropId}`,
      o.purpose,
      o.dropId,
      o.claimId ?? null,
      'NQ07 RECIPIENT',
      (o.amountLuna ?? 100n).toString(),
      o.state,
      o.createdAgoSeconds ?? 0,
    ],
  )
  return rows[0]
}

async function insertAttempt(
  db: Queryable,
  o: {
    transferId: string
    sequence?: number
    state: 'signed' | 'broadcast' | 'confirmed' | 'proven_dead'
    feeLuna?: bigint
    createdAgoSeconds?: number
  },
): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO transaction_attempts (
       transfer_id, sequence, state, raw_signed_tx, tx_hash, fee_luna, validity_start_height,
       created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, now() - make_interval(secs => $7::float8))
     RETURNING id`,
    [
      o.transferId,
      o.sequence ?? 1,
      o.state,
      Buffer.from('00ff', 'hex'),
      randomUUID(),
      (o.feeLuna ?? 0n).toString(),
      o.createdAgoSeconds ?? 0,
    ],
  )
  return rows[0]
}

async function setControls(o: {
  paused?: boolean
  capLuna?: bigint
  feeReserveLuna?: bigint
  operatorFloatLuna?: bigint
  balanceLuna?: bigint | null
  reconciledAgoMs?: number | null
}): Promise<void> {
  const balance = o.balanceLuna === undefined ? 10_000_000n : o.balanceLuna
  const agoMs = o.reconciledAgoMs === undefined ? 0 : o.reconciledAgoMs
  await pool.query(
    `UPDATE custody_controls SET
       paused = $1,
       max_live_principal_luna = $2,
       configured_fee_reserve_luna = $3,
       reconciled_confirmed_balance_luna = $4,
       operator_float_luna = $6,
       last_reconciled_height = CASE WHEN $5::float8 IS NULL THEN NULL ELSE 1000 END,
       last_reconciled_at = CASE WHEN $5::float8 IS NULL THEN NULL
                                 ELSE now() - make_interval(secs => $5::float8 / 1000) END
     WHERE singleton`,
    [
      o.paused ?? false,
      (o.capLuna ?? 10_000_000n).toString(),
      (o.feeReserveLuna ?? 100_000n).toString(),
      balance === null ? null : balance.toString(),
      agoMs,
      (o.operatorFloatLuna ?? 0n).toString(),
    ],
  )
}

/** The activation path's solvency gate, exactly as `activate()` runs it. */
async function activationWouldPass(addLuna: bigint): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const controls = await lockControls(client)
    await assertSolvent(client, controls, addLuna)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ---- help (no database needed) --------------------------------------------------

describe('recover CLI help', () => {
  const SUBCOMMANDS = [
    'status',
    'resume',
    'replace',
    'deposits',
    'float show',
    'float set',
    'pause',
    'unpause',
  ]

  it('names every subcommand, with a description and an example for each', () => {
    for (const name of SUBCOMMANDS) {
      expect(USAGE).toContain(name)
    }
    // One worked example per subcommand, plus the `--help` line itself.
    const examples = USAGE.match(/^ {6}example: /gm) ?? []
    expect(examples.length).toBe(SUBCOMMANDS.length)
    expect(USAGE).toContain('--help')
  })

  it('prints the full usage block on --help and exits 0', async () => {
    const printed: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      printed.push(args.map(String).join(' '))
    }
    try {
      const outcome = await main(['--help'])
      expect(outcome.exitCode).toBe(0)
      expect(outcome.ok).toBe(true)
      expect(outcome.effect).toBe('read_only')
    } finally {
      console.log = original
    }
    const out = printed.join('\n')
    for (const name of SUBCOMMANDS) expect(out).toContain(name)
  })

  it('documents every exit code it can return', () => {
    for (const code of [0, 1, 2, 3, 4]) {
      expect(USAGE).toMatch(new RegExp(`^ {2}${code} {3}`, 'm'))
    }
    // The machine-readable contract has to be discoverable from --help too, or
    // nobody writing a script will know it is there.
    expect(USAGE).toContain('"event":"recover_result"')
  })

  it('reads --tx as a flag, in either spelling', () => {
    expect(flagValue(['float', 'set', '100', '--tx', 'abc'], '--tx')).toBe('abc')
    expect(flagValue(['float', 'set', '100', '--tx=abc'], '--tx')).toBe('abc')
    expect(flagValue(['float', 'set', '100'], '--tx')).toBeUndefined()
  })

  it('prints usage to stderr and exits 2 when given no command', async () => {
    const printed: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      printed.push(args.map(String).join(' '))
    }
    try {
      for (const argv of [
        [],
        ['float'],
        ['float', 'nonsense'],
        ['float', 'set'],
        // The amount is positional: `float set --tx <hash>` with no amount must
        // not read "--tx" as a number of luna.
        ['float', 'set', '--tx', 'abc'],
      ]) {
        const outcome = await main(argv)
        expect(outcome.exitCode, argv.join(' ')).toBe(2)
        expect(outcome.ok).toBe(false)
        expect(outcome.phase).toBe('usage')
        expect(outcome.effect).toBe('none')
      }
    } finally {
      console.error = original
    }
    expect(printed.join('\n')).toContain('float set <luna>')
  })
})

/**
 * The outcome classifier, on its own.
 *
 * These three functions are the whole of the retry contract: they decide what
 * an operator is told about whether the money moved. They are pure, so they are
 * tested directly — the process-level behaviour they produce is covered by the
 * spawned children below.
 */
describe('recover outcome classification', () => {
  it('calls a finished money command APPLIED and a finished report READ-ONLY', () => {
    const applied = succeeded('float set', { command: 'float set' })
    expect(applied).toMatchObject({ ok: true, effect: 'applied', exitCode: 0, phase: 'done' })
    // "what changed" travels with the line, so automation never has to go back
    // and re-parse the pretty report above it.
    expect(applied.result).toEqual({ command: 'float set' })

    expect(succeeded('status', { command: 'status' })).toMatchObject({
      ok: true,
      effect: 'read_only',
      exitCode: 0,
    })
  })

  it('calls anything that failed in STARTUP a no-op, whatever the error was', () => {
    for (const err of [
      new Error('CUSTODY_PRIVATE_KEY_HEX is not set'),
      new ChainStartupError('consensus was not established'),
      new TypeError('arg0.addEventListener is not a function'),
    ]) {
      const o = failed('replace', 'startup', err)
      expect(o).toMatchObject({ ok: false, effect: 'none', exitCode: 3, phase: 'startup' })
      expect(o.advice).toContain('safe to re-run')
    }
  })

  it('calls a deliberate refusal a no-op and an unclassified money error UNKNOWN', () => {
    expect(failed('replace', 'work', new ReplaceRefusedError('nope'))).toMatchObject({
      effect: 'none',
      exitCode: 1,
    })
    expect(failed('float set', 'work', new DepositAttestationError('not_final', 'nope'))).toMatchObject({
      effect: 'none',
      exitCode: 1,
    })
    // Not a RecoverError, and the command can move money: we do not know.
    expect(failed('replace', 'work', new Error('connection terminated'))).toMatchObject({
      effect: 'unknown',
      exitCode: 4,
    })
    // Same error on a command that only reads is still just a failed read.
    expect(failed('status', 'work', new Error('connection terminated'))).toMatchObject({
      effect: 'none',
      exitCode: 1,
    })
  })

  it('splits an uncatchable fault on the phase, which is the only thing that can', () => {
    const wasm = new Error('called `Result::unwrap_throw()` on an `Err` value')

    const before = faulted('float set', 'startup', 'uncaught exception', wasm)
    expect(before).toMatchObject({ ok: false, effect: 'none', exitCode: 3 })
    expect(before.advice).toContain('nothing was read and nothing was written')

    const during = faulted('float set', 'work', 'uncaught exception', wasm)
    expect(during).toMatchObject({ ok: false, effect: 'unknown', exitCode: 4 })
    expect(during.advice).toContain('UNKNOWN')

    // The same WASM backtrace, two opposite instructions to the operator. That
    // difference is the entire point of the phase.
    expect(before.advice).not.toBe(during.advice)
  })

  it('names the refusal class, so a script can branch on it', () => {
    expect(failed('replace', 'work', new ReplaceRefusedError('x')).error?.name).toBe(
      'ReplaceRefusedError',
    )
    expect(failed('float set', 'startup', new ChainStartupError('x')).error?.name).toBe(
      'ChainStartupError',
    )
  })
})

/**
 * How the CLI ENDS, proven the only way it can be: real child processes, real
 * exit codes, real stdout.
 *
 * Two separate defects live here, both found on the mainnet cutover, both
 * making the exit code a lie in a different direction:
 *
 *  1. **Success reported failure.** `unpause` updated the row, logged
 *     `custody_unpaused` — and exited 1, because `print()` called
 *     `JSON.stringify` on a `Controls` object whose luna fields are `bigint`.
 *     The work was done and the process said it had failed.
 *  2. **A teardown fault outranked the work.** `main` tore the chain client and
 *     the pool down inside its own `finally` and only then called
 *     `exitAfterFlush`, which fixes no exit code at all — it installs no
 *     handlers. The `@nimiq/core` rethrow (`called Result::unwrap_throw() on an
 *     Err value`), which arrives on a tick of its own long after the work, met
 *     Node's default handler and ended the process at 1.
 *
 * And the third property, which is what an operator actually needs: a run that
 * dies BEFORE its work must say so, because "nothing happened, safe to re-run"
 * and "it worked, do not re-run" look identical when both are a WASM backtrace
 * and a non-zero status.
 *
 * The WASM fault itself is not reproducible on demand — fourteen consecutive
 * MainAlbatross connections from a developer machine produced none. So it is
 * reproduced by its MECHANISM, exactly as `test/exit.test.ts` does: an
 * exception thrown from a timer callback, outside every promise the CLI awaits,
 * injected with `--import` so the CLI itself is unmodified and unaware.
 */
describe.skipIf(!hasDb)('recover CLI process lifetime', () => {
  const CLI_TIMEOUT_MS = 90_000
  const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
  /** Resolved from THIS package, so the child patches the module it will load. */
  const PG_MODULE = createRequire(import.meta.url).resolve('pg')

  /**
   * A preload that makes `pg` misbehave the way `@nimiq/core` does.
   *
   * `which` selects the moment: `startup` faults while the CLI is awaiting its
   * database probe (so `phase === 'startup'` is guaranteed rather than raced),
   * `teardown` faults while the pool is closing, which is after the outcome has
   * been fixed. Both throw from a `setTimeout` callback, which is the property
   * that matters — no `try`/`catch` in the CLI can see it.
   */
  const faultPreload = (which: 'startup' | 'teardown') => `
    import pg from ${JSON.stringify(pathToFileURL(PG_MODULE).href)}
    const WASM = () => {
      throw new Error('called \\\`Result::unwrap_throw()\\\` on an \\\`Err\\\` value')
    }
    const method = ${which === 'startup' ? "'query'" : "'end'"}
    const original = pg.Pool.prototype[method]
    let armed = true
    pg.Pool.prototype[method] = function patched(...args) {
      if (!armed) return original.apply(this, args)
      armed = false
      setTimeout(WASM, 10)
      return new Promise((resolve) => {
        setTimeout(() => resolve(original.apply(this, args)), 250)
      })
    }
  `

  let preloadDir: string

  // The child is the REAL CLI, so it reads `DATABASE_URL` as an operator's
  // shell would: no `search_path` override, and therefore the default schema
  // rather than any of this suite's private ones. That schema has to be
  // migrated by somebody, and until now it was migrated by nobody — the test
  // passed only because a previous run or a hand-run of `migrate-cli` had left
  // tables behind, and failed on the first run against a genuinely empty
  // database or after a new migration was added. Migrating it here makes the
  // test independent of what ran before it.
  beforeAll(async () => {
    preloadDir = mkdtempSync(join(tmpdir(), 'nimdrops-recover-'))
    for (const which of ['startup', 'teardown'] as const) {
      writeFileSync(join(preloadDir, `${which}.mjs`), faultPreload(which))
    }
    const ambient = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    try {
      await migrate(ambient)
    } finally {
      await ambient.end()
    }
  }, CLI_TIMEOUT_MS)

  afterAll(() => {
    if (preloadDir) rmSync(preloadDir, { recursive: true, force: true })
  })

  interface CliRun {
    code: number | null
    stdout: string
    stderr: string
    /** The machine-readable last line, parsed. `null` when it was not printed. */
    outcome: RecoverOutcome | null
  }

  function runCli(
    args: string[],
    opts: { fault?: 'startup' | 'teardown'; env?: Record<string, string> } = {},
  ): Promise<CliRun> {
    return new Promise((resolve, reject) => {
      const preload = opts.fault
        ? ['--import', pathToFileURL(join(preloadDir, `${opts.fault}.mjs`)).href]
        : []
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', ...preload, 'src/recover.ts', ...args],
        {
          cwd: SERVER_DIR,
          env: { ...process.env, NIMIQ_NETWORK: 'TestAlbatross', ...opts.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('the CLI did not exit on its own'))
      }, CLI_TIMEOUT_MS - 5_000)
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr, outcome: lastOutcome(stdout) })
      })
    })
  }

  /**
   * The contract automation is told to rely on: the LAST `recover_result` line
   * on stdout. Found by its event name rather than by position, because the
   * library writes its own noise to both streams.
   */
  function lastOutcome(stdout: string): RecoverOutcome | null {
    const lines = stdout
      .split('\n')
      .filter((line) => line.startsWith('{"event":"recover_result"'))
    const last = lines.at(-1)
    return last ? (JSON.parse(last) as RecoverOutcome) : null
  }

  it(
    'exits on its own, with the whole report flushed to a pipe',
    async () => {
      const run = await runCli(['status'])
      expect(run.code, 'the process must terminate by itself').toBe(0)
      // Both halves of stdout have to have survived: the indented human report,
      // and — genuinely last, so it is what a truncating `process.exit` would
      // eat — the machine line.
      const human = run.stdout.slice(0, run.stdout.indexOf('{"event":"recover_result"'))
      const report = JSON.parse(human.slice(human.indexOf('{'))) as { command: string }
      expect(report.command).toBe('status')
      expect(run.outcome).toMatchObject({ ok: true, command: 'status', effect: 'read_only' })
      expect(run.stdout.trimEnd().endsWith('}')).toBe(true)
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'exits 0 after unpause, whose report is full of bigints',
    async () => {
      const run = await runCli(['unpause'])
      // The cutover's exact failure: the row was updated and the process
      // reported 1 because it could not serialise its own success.
      expect(run.stderr).not.toContain('Do not know how to serialize a BigInt')
      expect(run.code).toBe(0)
      expect(run.outcome).toMatchObject({ ok: true, command: 'unpause', effect: 'applied' })
      // Luna survive as decimal STRINGS, which is the only lossless JSON they
      // have — never as numbers.
      //
      // Asserted as a shape rather than as `'0'`. This suite spawns CLI child
      // processes and holds no pool of its own, so it cannot set the float it
      // was reading: the exact value belonged to whichever suite happened to
      // run before it, and the test went red the moment that order changed.
      // Nothing about the serialisation claim needs a particular number — it
      // needs the value to be a string of digits and not a JSON number, which
      // is what a bigint silently becomes when it survives `JSON.stringify` by
      // being cast, and what `1e21` becomes when it does not.
      const float = (run.outcome?.result as { operatorFloatLuna: unknown }).operatorFloatLuna
      expect(typeof float).toBe('string')
      expect(float).toMatch(/^\d+$/)
      expect((run.outcome?.result as { paused: unknown }).paused).toBe(false)
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'exits 0 after pause too, and says the switch is now engaged',
    async () => {
      const run = await runCli(['pause', 'exit-code regression test'])
      expect(run.code).toBe(0)
      expect(run.outcome).toMatchObject({ ok: true, command: 'pause', effect: 'applied' })
      expect((run.outcome?.result as { paused: unknown }).paused).toBe(true)
      // Leave the shared schema as we found it.
      expect((await runCli(['unpause'])).code).toBe(0)
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'keeps the work’s exit code when the teardown raises the WASM rethrow',
    async () => {
      const run = await runCli(['unpause'], { fault: 'teardown' })
      expect(run.code, 'a fault after the work must not change the status').toBe(0)
      expect(run.outcome).toMatchObject({ ok: true, command: 'unpause', effect: 'applied' })
      // Discarded as an influence, never as a fact: a WASM error nobody sees is
      // its own bug.
      expect(run.stderr).toContain('recover_teardown_fault')
      expect(run.stderr).toContain('unwrap_throw')
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'says NOTHING HAPPENED when the same fault lands before the work',
    async () => {
      const run = await runCli(['unpause'], { fault: 'startup' })
      expect(run.code, 'a run that did nothing must still fail').toBe(3)
      expect(run.outcome).toMatchObject({
        ok: false,
        command: 'unpause',
        phase: 'startup',
        effect: 'none',
        exitCode: 3,
        fault: 'uncaught exception',
      })
      expect(run.outcome?.advice).toContain('nothing was read and nothing was written')
      // The distinction the operator could not previously make: same library
      // fault, same WASM message, opposite instruction.
      expect(run.outcome?.error?.message).toContain('unwrap_throw')
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'refuses before the work when the chain client cannot be built at all',
    async () => {
      const run = await runCli(['resume', '3f0c9a3e-7b1e-4c2a-9c1a-2b7d5e8f0a11'], {
        env: { CUSTODY_PRIVATE_KEY_HEX: '' },
      })
      expect(run.code).toBe(3)
      expect(run.outcome).toMatchObject({ phase: 'startup', effect: 'none', ok: false })
      expect(run.stderr).toContain('CUSTODY_PRIVATE_KEY_HEX')
      // No `fault`: this one was caught on a stack we own, and saying so is the
      // difference between a configuration mistake and a library crash.
      expect(run.outcome?.fault).toBeUndefined()
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'gives up on consensus rather than hanging, and calls that a no-op',
    async () => {
      // `waitForConsensusEstablished()` never resolves and never rejects when
      // the seeds are unreachable — the failure mode API-DIVERGENCE 15
      // describes. Unroutable seeds plus a short budget exercise the bound.
      const run = await runCli(['deposits'], {
        env: {
          CUSTODY_PRIVATE_KEY_HEX: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
          NIMIQ_SEED_NODES: '/dns4/seed.invalid/tcp/443/wss',
          RECOVER_STARTUP_TIMEOUT_MS: '3000',
        },
      })
      expect(run.code).toBe(3)
      expect(run.outcome).toMatchObject({
        ok: false,
        command: 'deposits',
        phase: 'startup',
        effect: 'none',
      })
      expect(run.outcome?.error?.name).toBe('ChainStartupError')
      expect(run.outcome?.error?.message).toContain('consensus was not established')
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'still prints the status report when the node cannot be reached',
    async () => {
      // Connecting eagerly must not have turned a DEGRADED report into a failed
      // one: an on-call operator asking what is going on always gets a screen,
      // and the reason the chain half is missing is the most useful line on it.
      const run = await runCli(['status'], {
        env: {
          CUSTODY_PRIVATE_KEY_HEX: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
          NIMIQ_SEED_NODES: '/dns4/seed.invalid/tcp/443/wss',
          RECOVER_STARTUP_TIMEOUT_MS: '3000',
        },
      })
      expect(run.code).toBe(0)
      expect(run.outcome).toMatchObject({ ok: true, command: 'status', effect: 'read_only' })
      expect(run.stdout).toContain('"degraded": true')
      expect(run.stdout).toContain('consensus was not established')
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'reports a usage error without opening anything',
    async () => {
      const run = await runCli(['nonsense'])
      expect(run.code).toBe(2)
      expect(run.outcome).toMatchObject({ ok: false, phase: 'usage', effect: 'none' })
      expect(run.stderr).toContain('float set <luna>')
    },
    CLI_TIMEOUT_MS,
  )
})

// ---- database-backed suite ------------------------------------------------------

describe.skipIf(!hasDb)('operator float and status (real Postgres)', () => {
  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()

    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA},public`,
    })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.end()
  })

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE transaction_attempts, outgoing_transfers, wallet_challenges, claims, drops,
       operator_float_deposits, custody_deposit_owners, http_idempotency RESTART IDENTITY CASCADE`,
    )
    await pool.query(
      `UPDATE custody_controls SET network = NULL, custody_address = '${CUSTODY}' WHERE singleton`,
    )
    await setControls({})
    chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
  })

  // ---- float set --------------------------------------------------------------

  it('refuses a float that would attest more than the chain actually holds', async () => {
    const tx = topUpCustody(200_000n)
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n }) // +500 ledger movements

    await expect(setOperatorFloat(pool, chain, '300000', tx)).rejects.toBeInstanceOf(
      OverAttestationError,
    )

    // The refusal must not have written anything — not the float, and not the
    // deposit row that would have made a second attempt look already-counted.
    expect((await readControls(pool)).operatorFloatLuna).toBe(0n)
    expect(await attestedFloatDepositsLuna(pool)).toBe(0n)
  })

  it('names the numbers it refused on', async () => {
    const tx = topUpCustody(200_000n)
    // The deposit is real, and custody has since paid 150_000 of it out to
    // somewhere the ledger knows nothing about. A verified deposit hash is not
    // proof the money is still there — the in-lock balance is.
    chain.deposit({
      hash: `spend-${randomUUID()}`,
      sender: CUSTODY,
      recipient: 'NQ07 ELSEWHERE',
      valueLuna: 150_000n,
      includedHeight: 2,
    })

    await expect(setOperatorFloat(pool, chain, '200000', tx)).rejects.toThrow(/200000/)
    await expect(setOperatorFloat(pool, chain, '200000', tx)).rejects.toThrow(/50000/)
    // Refused twice: the first refusal rolled its deposit row back, so the
    // second is the same refusal and not "already attested".
    expect(await attestedFloatDepositsLuna(pool)).toBe(0n)
  })

  it('accepts a float the chain balance covers, and unblocks a stuck activation', async () => {
    const tx = topUpCustody(100_000n)
    // One activated drop: 500 luna of principal and 500 luna of ledger movement.
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    // …whose funding is sitting in custody on chain too. That is why the ledger
    // may legitimately exceed the float: the float is only the operator's share.
    chain.deposit({
      hash: `funding-${randomUUID()}`,
      sender: 'NQ07 SPONSOR',
      recipient: CUSTODY,
      valueLuna: 500n,
      includedHeight: 1,
    })

    // Ledger = float(0) + 500 < outstanding(500) + fee reserve(100_000): the
    // deployment note in EXECUTION-LOG.md — a fresh database fails closed until
    // the operator attests their fee float.
    await expect(activationWouldPass(500n)).rejects.toBeInstanceOf(InsolventError)

    const result = await setOperatorFloat(pool, chain, '100000', tx)

    expect(result.operatorFloatLuna).toEqual({ before: '0', after: '100000' })
    expect(result.ledgerBalanceLuna).toEqual({ before: '500', after: '100500' })
    // headroom = ledger - outstanding - fee reserve
    expect(result.solvencyHeadroomLuna).toEqual({ before: '-100000', after: '0' })
    expect(result.chainConfirmedBalanceLuna).toBe('100500')
    expect(result.ledgerMinusChainLuna.after).toBe('0')
    // Every luna of the float points at a transaction (round-2 F4).
    expect(result.deposit).toEqual({ txHash: tx, valueLuna: '100000', includedHeight: 1 })
    expect(result.attestedFloatDepositsLuna).toBe('100000')

    expect((await readControls(pool)).operatorFloatLuna).toBe(100_000n)
    await expect(activationWouldPass(500n)).resolves.toBeUndefined()
  })

  it('rejects a float that is not a positive integer number of luna', async () => {
    const tx = topUpCustody(1_000_000n)
    for (const bad of ['0', '-1', '1.5', '1e5', 'abc', '', ' ', '1_000', '+7']) {
      await expect(setOperatorFloat(pool, chain, bad, tx)).rejects.toBeInstanceOf(InvalidLunaError)
    }
    expect((await readControls(pool)).operatorFloatLuna).toBe(0n)
  })

  it('refuses to guess when the chain cannot be reached', async () => {
    const tx = topUpCustody(1_000n)
    const down = chainWith(chain, {
      confirmedBalanceLuna: async () => {
        throw new Error('no peers')
      },
    })
    await expect(setOperatorFloat(pool, down, '100', tx)).rejects.toBeInstanceOf(
      ChainUnavailableError,
    )
    expect((await readControls(pool)).operatorFloatLuna).toBe(0n)
  })

  it('refuses every float command when the database is bound to another network', async () => {
    const tx = topUpCustody(1_000n)
    await pool.query(`UPDATE custody_controls SET network = 'MainAlbatross' WHERE singleton`)
    await expect(setOperatorFloat(pool, chain, '100', tx)).rejects.toThrow(/MainAlbatross/)

    // The read-only report still renders — it just labels the chain section.
    const shown = await floatShow(pool, chain)
    expect(shown.chain.available).toBe(false)
    if (!shown.chain.available) expect(shown.chain.reason).toMatch(/MainAlbatross/)
  })

  // ---- F4: the float is attributed to a named, finalized deposit ----------------

  /** The `code` of a `DepositAttestationError`, or the error itself if it is not one. */
  async function attestationCode(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => 'resolved',
      (err: unknown) => (err instanceof DepositAttestationError ? err.code : err),
    )
  }

  it('refuses to write a float that is not attributed to a deposit at all', async () => {
    topUpCustody(200_000n)
    expect(await attestationCode(setOperatorFloat(pool, chain, '100000'))).toBe('missing_tx')
    expect(await attestationCode(setOperatorFloat(pool, chain, '100000', '   '))).toBe('missing_tx')
    expect((await readControls(pool)).operatorFloatLuna).toBe(0n)
  })

  it('refuses every deposit hash that does not put final money into custody', async () => {
    topUpCustody(500_000n) // head 1000, so height 1 is comfortably final

    // Not on chain at all.
    expect(await attestationCode(setOperatorFloat(pool, chain, '1', 'no-such-hash'))).toBe(
      'not_found',
    )

    // Included but not yet behind the finality depth: a reorg can still take it.
    chain.deposit({
      hash: 'too-recent',
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 1_000n,
      includedHeight: 998,
    })
    expect(await attestationCode(setOperatorFloat(pool, chain, '1000', 'too-recent'))).toBe(
      'not_final',
    )

    // Included and failed: it moved nothing.
    chain.deposit({
      hash: 'failed-tx',
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 1_000n,
      includedHeight: 1,
      executionOk: false,
    })
    expect(await attestationCode(setOperatorFloat(pool, chain, '1000', 'failed-tx'))).toBe(
      'execution_failed',
    )

    // Paid to someone else entirely.
    chain.deposit({
      hash: 'not-ours',
      sender: 'NQ07 OPERATOR',
      recipient: 'NQ07 SOMEONE ELSE',
      valueLuna: 1_000n,
      includedHeight: 1,
    })
    expect(await attestationCode(setOperatorFloat(pool, chain, '1000', 'not-ours'))).toBe(
      'wrong_recipient',
    )

    // Custody paying itself moves no new money in.
    chain.deposit({
      hash: 'self-pay',
      sender: CUSTODY,
      recipient: CUSTODY,
      valueLuna: 1_000n,
      includedHeight: 1,
    })
    expect(await attestationCode(setOperatorFloat(pool, chain, '1000', 'self-pay'))).toBe(
      'self_transfer',
    )

    expect((await readControls(pool)).operatorFloatLuna).toBe(0n)
    expect(await attestedFloatDepositsLuna(pool)).toBe(0n)
  })

  it("refuses to count a drop's funding transaction as operator float", async () => {
    const drop = await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    const fundingHash = 'sponsor-funding'
    await pool.query('UPDATE drops SET funding_tx_hash = $2 WHERE id = $1', [drop.id, fundingHash])
    chain.deposit({
      hash: fundingHash,
      sender: 'NQ07 SPONSOR',
      recipient: CUSTODY,
      valueLuna: 500n,
      includedHeight: 1,
    })
    chain.setHead(1_000)

    // That money is owed to claimants and the ledger already counts it. Counting
    // it again as float would credit the same 500 luna twice.
    expect(await attestationCode(setOperatorFloat(pool, chain, '500', fundingHash))).toBe(
      'drop_funding',
    )
    expect((await readControls(pool)).operatorFloatLuna).toBe(0n)
  })

  it('refuses to count the same deposit twice, and requires the float to be their sum', async () => {
    const first = topUpCustody(100_000n)
    const accepted = await setOperatorFloat(pool, chain, '100000', first)
    expect(accepted.attestedFloatDepositsLuna).toBe('100000')

    // The same hash again: the money is already in the books, so counting it
    // would credit the same luna twice even though the total looks affordable.
    expect(await attestationCode(setOperatorFloat(pool, chain, '100000', first))).toBe(
      'already_attested',
    )
    expect((await readControls(pool)).operatorFloatLuna).toBe(100_000n)

    // A genuinely new deposit, but attested with the wrong running total: the
    // float must equal the SUM of the deposits behind it, not the last one.
    const second = topUpCustody(50_000n)
    expect(await attestationCode(setOperatorFloat(pool, chain, '50000', second))).toBe(
      'float_mismatch',
    )
    expect((await readControls(pool)).operatorFloatLuna).toBe(100_000n)
    expect(await attestedFloatDepositsLuna(pool), 'the rejected row rolled back').toBe(100_000n)

    // The running total is accepted, and the float is attributable to both.
    const total = await setOperatorFloat(pool, chain, '150000', second)
    expect(total.attestedFloatDepositsLuna).toBe('150000')
    expect((await readControls(pool)).operatorFloatLuna).toBe(150_000n)

    const shown = await floatShow(pool, chain)
    expect(shown.solvency.attestedFloatDepositsLuna).toBe('150000')
    expect(shown.solvency.floatAttributed).toBe(true)
  })

  it('reports a float that nothing on chain has been pointed at', async () => {
    topUpCustody(200_000n)
    // A hand-written float — or one migration 006 zeroed out from under an
    // operator who has not re-attested yet. The report must say so out loud.
    await setControls({ operatorFloatLuna: 100_000n })

    const shown = await floatShow(pool, chain)
    expect(shown.solvency.operatorFloatLuna).toBe('100000')
    expect(shown.solvency.attestedFloatDepositsLuna).toBe('0')
    expect(shown.solvency.floatAttributed).toBe(false)
  })

  // ---- N2: the bound is applied to a balance read under the lock -----------------

  it('a payout confirming mid-command cannot enable an over-attestation', async () => {
    const tx = topUpCustody(200_000n)
    // Before the command runs, a float of 200_000 is entirely honest.
    expect(await chain.confirmedBalanceLuna(CUSTODY)).toBe(200_000n)

    // `float set` reads the head twice: once as a pre-lock probe (so a dead node
    // is discovered without stalling every payout behind the singleton row) and
    // once as the first thing it does while HOLDING that row. Landing the payout
    // on the second call places it in exactly the window N2 is about: the
    // command was waiting for the lock, and the money left while it waited.
    let headCalls = 0
    const racing = chainWith(chain, {
      headHeight: async () => {
        headCalls += 1
        if (headCalls === 2) {
          chain.deposit({
            hash: `payout-${randomUUID()}`,
            sender: CUSTODY,
            recipient: 'NQ07 CLAIMANT',
            valueLuna: 150_000n,
            includedHeight: 2,
          })
        }
        return chain.headHeight()
      },
    })

    // Round-2 N2: with the balance read before the lock, this passed and wrote
    // a float of 200_000 against a wallet holding 50_000.
    await expect(setOperatorFloat(pool, racing, '200000', tx)).rejects.toBeInstanceOf(
      OverAttestationError,
    )
    expect(headCalls, 'the balance must be re-read under the lock').toBeGreaterThanOrEqual(2)
    expect((await readControls(pool)).operatorFloatLuna).toBe(0n)
    expect(await attestedFloatDepositsLuna(pool)).toBe(0n)
    expect(await chain.confirmedBalanceLuna(CUSTODY)).toBe(50_000n)
  })

  // ---- R6: the bound is conservative, not raced ---------------------------------

  it('subtracts every attempt that could still land before it attests anything', async () => {
    // Bind before any attempt row exists, as booting `worker.ts` does.
    await ensureNetworkBinding(pool, chain)
    const tx = topUpCustody(200_000n)
    // A payout the worker has already broadcast. Nothing about the chain
    // balance says so yet — the transaction has not been included — so all
    // 200_000 luna still LOOKS like headroom.
    const drop = await insertDrop(pool, { activated: false })
    const claim = await insertClaim(pool, drop.id, 0)
    const transfer = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: drop.id,
      claimId: claim.id,
      amountLuna: 50_000n,
      state: 'in_progress',
    })
    await insertAttempt(pool, { transferId: transfer.id, state: 'broadcast', feeLuna: 100n })
    expect(await chain.confirmedBalanceLuna(CUSTODY)).toBe(200_000n)

    // Holding the custody lock cannot stop an already-broadcast transaction
    // from being included, so the bound stops trying: the 50_100 luna committed
    // to that attempt is not headroom, landed or not.
    await expect(setOperatorFloat(pool, chain, '200000', tx)).rejects.toBeInstanceOf(
      OverAttestationError,
    )
    await expect(setOperatorFloat(pool, chain, '200000', tx)).rejects.toThrow(/50100/)
    expect((await readControls(pool)).operatorFloatLuna).toBe(0n)
  })

  it('an attempt landing mid-command cannot leave the float over-attested', async () => {
    await ensureNetworkBinding(pool, chain)
    const tx = topUpCustody(200_000n)
    const drop = await insertDrop(pool, { activated: false })
    const claim = await insertClaim(pool, drop.id, 0)
    const transfer = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: drop.id,
      claimId: claim.id,
      amountLuna: 50_000n,
      state: 'in_progress',
    })
    await insertAttempt(pool, { transferId: transfer.id, state: 'broadcast', feeLuna: 0n })

    // The operator attests the whole deposit. Whether that is accepted is the
    // command's business — what is asserted below is the property that must
    // hold either way.
    await setOperatorFloat(pool, chain, '200000', tx).catch(() => undefined)

    // …and now the attempt lands, which is precisely the event no lock could
    // have prevented: the chain balance the bound was checked against is gone.
    chain.deposit({
      hash: `landed-${randomUUID()}`,
      sender: CUSTODY,
      recipient: 'NQ07 CLAIMANT',
      valueLuna: 50_000n,
      includedHeight: 2,
    })
    const chainAfter = await chain.confirmedBalanceLuna(CUSTODY)
    expect(chainAfter).toBe(150_000n)

    const controls = await readControls(pool)
    const ledgerAfter = controls.operatorFloatLuna + (await ledgerMovementsLuna(pool))
    expect(
      ledgerAfter <= chainAfter,
      `ledger ${ledgerAfter} must not exceed the chain's ${chainAfter} once the in-flight ` +
        'attempt landed — a float attested against a balance that was about to shrink',
    ).toBe(true)
  })

  // ---- R2: a deposit is drop funding OR operator float, never both ---------------

  it('refuses a deposit that carries a drop funding memo', async () => {
    // A sponsor's funding transaction that no drop has been activated with yet:
    // `funding_tx_hash` is still NULL everywhere, so the drop-funding check
    // cannot see it. The memo is what gives it away.
    const memoed = `memoed-${randomUUID()}`
    chain.deposit({
      hash: memoed,
      sender: 'NQ07 SPONSOR',
      recipient: CUSTODY,
      valueLuna: 500n,
      dataUtf8: 'ND1:abcdefghijklmnopqrstuv',
      includedHeight: 1,
    })
    chain.setHead(1_000)

    expect(await attestationCode(setOperatorFloat(pool, chain, '500', memoed))).toBe('drop_memo')
    expect((await readControls(pool)).operatorFloatLuna).toBe(0n)
    expect(await attestedFloatDepositsLuna(pool)).toBe(0n)
  })

  it('will not let an attested float deposit become a drop funding hash', async () => {
    const tx = topUpCustody(100_000n)
    await setOperatorFloat(pool, chain, '100000', tx)

    // The database backstop (migration 008), reached directly: even hand-written
    // SQL cannot point a drop's funding at money the float already counts.
    const drop = await insertDrop(pool, { activated: false })
    await expect(
      pool.query('UPDATE drops SET funding_tx_hash = $2 WHERE id = $1', [drop.id, tx]),
    ).rejects.toThrow(/attested as operator float/i)
  })

  it("will not let a drop's funding hash become an attested float deposit", async () => {
    const drop = await insertDrop(pool)
    const fundingHash = `funding-${randomUUID()}`
    await pool.query('UPDATE drops SET funding_tx_hash = $2 WHERE id = $1', [drop.id, fundingHash])

    await expect(
      pool.query(
        `INSERT INTO operator_float_deposits (tx_hash, value_luna, included_height, network)
         VALUES ($1, 500, 1, 'TestAlbatross')`,
        [fundingHash],
      ),
    ).rejects.toThrow(/funding of drop/i)
  })

  // ---- float show -------------------------------------------------------------

  it('shows the float beside the ledger, the chain and the caps', async () => {
    topUpCustody(200_000n)
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    await setControls({ operatorFloatLuna: 100_000n })

    const shown = await floatShow(pool, chain)

    expect(shown.solvency.operatorFloatLuna).toBe('100000')
    expect(shown.solvency.ledgerBalanceLuna).toBe('100500')
    expect(shown.solvency.outstandingPrincipalLuna).toBe('500')
    expect(shown.solvency.feeReserveLuna).toBe('100000')
    expect(shown.solvency.maxLivePrincipalLuna).toBe('10000000')
    expect(shown.solvency.paused).toBe(false)
    expect(shown.solvency.network).toBe('TestAlbatross')
    expect(shown.solvency.lastReconciledAt).not.toBeNull()
    expect(shown.solvency.lastReconciledHeight).toBe(1000)

    expect(shown.chain.available).toBe(true)
    if (shown.chain.available) {
      expect(shown.chain.confirmedBalanceLuna).toBe('200000')
      expect(shown.chain.ledgerMinusChainLuna).toBe('-99500')
    }
  })

  it('renders without a chain client, clearly labelled as degraded', async () => {
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    await setControls({ operatorFloatLuna: 100_000n })

    const shown = await floatShow(pool, null)

    expect(shown.solvency.ledgerBalanceLuna).toBe('100500')
    expect(shown.chain).toMatchObject({ available: false, degraded: true })
    if (!shown.chain.available) {
      expect(shown.chain.reason).toMatch(/no chain client/i)
    }
    // Nothing pretends to know the on-chain number.
    expect(shown.chain).not.toHaveProperty('confirmedBalanceLuna')
    expect(shown.chain).not.toHaveProperty('ledgerMinusChainLuna')
  })

  // ---- status -----------------------------------------------------------------

  it('counts every state and lists manual_review transfers with their ages', async () => {
    topUpCustody(500_000n)
    await setControls({ operatorFloatLuna: 100_000n, paused: true })
    // Bind before the attempt history exists, exactly as booting `index.ts` or
    // `worker.ts` does. An UNBOUND database that already holds attempts is the
    // fail-closed case round-2 F6 added, and it has its own test below.
    await ensureNetworkBinding(pool, chain)

    const live = await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    await insertDrop(pool, { state: 'settled' })
    await insertDrop(pool, { state: 'awaiting_funding', activated: false })

    const paid = await insertClaim(pool, live.id, 0, 'paid')
    const stuck = await insertClaim(pool, live.id, 1, 'manual_review')
    await insertClaim(pool, live.id, 2, 'reserved')
    await insertClaim(pool, live.id, 3, 'reserved')

    const done = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: live.id,
      claimId: paid.id,
      state: 'confirmed',
    })
    await insertAttempt(pool, { transferId: done.id, state: 'confirmed', feeLuna: 1n })

    const flagged = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: live.id,
      claimId: stuck.id,
      state: 'manual_review',
      createdAgoSeconds: 7200,
    })
    await insertAttempt(pool, { transferId: flagged.id, state: 'proven_dead' })

    const flaggedRefund = await insertTransfer(pool, {
      purpose: 'refund',
      dropId: live.id,
      state: 'manual_review',
      createdAgoSeconds: 60,
    })

    const queuedDrop = await insertDrop(pool, { claimCount: 2, amountEachLuna: 50n })
    const queuedClaim = await insertClaim(pool, queuedDrop.id, 0)
    const inFlight = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: queuedDrop.id,
      claimId: queuedClaim.id,
      state: 'in_progress',
    })
    const oldestOpen = await insertAttempt(pool, {
      transferId: inFlight.id,
      state: 'broadcast',
      createdAgoSeconds: 3600,
    })
    const refundIntent = await insertTransfer(pool, {
      purpose: 'refund',
      dropId: queuedDrop.id,
      state: 'queued',
    })
    await insertAttempt(pool, {
      transferId: refundIntent.id,
      state: 'signed',
      createdAgoSeconds: 30,
    })

    const report = await statusReport(pool, chain)

    expect(report.paused).toBe(true)
    expect(report.network).toBe('TestAlbatross')
    expect(report.solvency.shortfallDetectedAt).toBeNull()
    expect(report.solvency.operatorFloatLuna).toBe('100000')
    // open drops 500 + 500 + 100, less the one finalized 100-luna payout
    expect(report.solvency.outstandingPrincipalLuna).toBe('1000')

    expect(report.counts.drops).toEqual({
      live: 3,
      settled: 1,
      awaiting_funding: 1,
    })
    expect(report.counts.claims).toEqual({ paid: 1, manual_review: 1, reserved: 3 })
    expect(report.counts.outgoingTransfers).toEqual({
      confirmed: 1,
      manual_review: 2,
      in_progress: 1,
      queued: 1,
    })
    expect(report.counts.transactionAttempts).toEqual({
      confirmed: 1,
      proven_dead: 1,
      broadcast: 1,
      signed: 1,
    })

    expect(report.manualReviewTransfers).toHaveLength(2)
    const ids = report.manualReviewTransfers.map((t) => t.transferId)
    expect(ids).toContain(flagged.id)
    expect(ids).toContain(flaggedRefund.id)
    // Oldest first: an on-call operator triages by age.
    expect(ids[0]).toBe(flagged.id)
    expect(report.manualReviewTransfers[0].ageSeconds).toBeGreaterThanOrEqual(7000)
    expect(report.manualReviewTransfers[1].ageSeconds).toBeLessThan(7000)

    expect(report.oldestOpenAttempt?.attemptId).toBe(oldestOpen.id)
    expect(report.oldestOpenAttempt?.state).toBe('broadcast')
    expect(report.oldestOpenAttempt?.ageSeconds).toBeGreaterThanOrEqual(3500)
  })

  it('renders an empty, unpaused system without a chain client', async () => {
    const report = await statusReport(pool, null)

    expect(report.paused).toBe(false)
    expect(report.counts.drops).toEqual({})
    expect(report.counts.claims).toEqual({})
    expect(report.counts.outgoingTransfers).toEqual({})
    expect(report.manualReviewTransfers).toEqual([])
    expect(report.oldestOpenAttempt).toBeNull()
    expect(report.chain).toMatchObject({ available: false, degraded: true })
  })

  it('is JSON-printable: no bigint escapes into the report', async () => {
    topUpCustody(1_000n)
    await insertDrop(pool)
    const shown = await floatShow(pool, chain)
    const report = await statusReport(pool, chain)
    expect(() => JSON.stringify(shown)).not.toThrow()
    expect(() => JSON.stringify(report)).not.toThrow()
  })
})
