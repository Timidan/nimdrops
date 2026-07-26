import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * `src/exit.ts` decides what STATUS a process reports, so the only test that
 * means anything runs real child processes and reads their real exit codes.
 * Asserting on a stubbed `process.exit` would prove that the stub was called,
 * which is not the claim: the claim is that a parent running `spawnSync` sees
 * `status === 0` after a teardown that threw, and `signal === 'SIGKILL'` after
 * a kill — the two things `spike/s3-settlement-e2e.ts` asserts on its children.
 *
 * The child imports `src/exit.ts` by absolute path from a temp directory, so
 * nothing here depends on the fixture living inside the repo.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const EXIT_MODULE = join(HERE, '..', 'src', 'exit.ts')

/**
 * One fixture, steered by `T_MODE`, covering every way this can end.
 *
 * `wasm-rethrow` is the failure that started all this, reproduced by its
 * mechanism rather than by its library: when an async `EventTarget` listener
 * rejects, Node re-raises it with `process.nextTick(() => { throw err })`,
 * which no `try`/`catch` around the teardown can see.
 */
const FIXTURE = `
import { exitAfterTeardown } from ${JSON.stringify(EXIT_MODULE)}

const mode = process.env.T_MODE
const code = Number(process.env.T_CODE ?? '0')

if (mode === 'sigkill') {
  // The S3 crash legs. Uncatchable, and must stay that way.
  process.kill(process.pid, 'SIGKILL')
}

// A handle that keeps the event loop alive forever — the consensus worker's
// stand-in. Without an explicit exit the process would never end.
const held = setInterval(() => {}, 1_000)

console.log('work finished')

exitAfterTeardown(
  code,
  async () => {
    if (mode === 'teardown-throws') throw new Error('close() blew up')
    if (mode === 'teardown-hangs') await new Promise(() => {})
    if (mode === 'wasm-rethrow') {
      process.nextTick(() => {
        throw new Error('called \`Result::unwrap_throw()\` on an \`Err\` value')
      })
      await new Promise((resolve) => setTimeout(resolve, 30_000))
    }
    clearInterval(held)
  },
  (message) => console.log('FAULT ' + message),
)
`

let dir: string
let fixture: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nimdrops-exit-'))
  fixture = join(dir, 'fixture.ts')
  writeFileSync(fixture, FIXTURE)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(mode: string, code = 0) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, T_MODE: mode, T_CODE: String(code) },
  })
  return { status: r.status, signal: r.signal, out: `${r.stdout}${r.stderr}` }
}

describe('exitAfterTeardown', () => {
  it('exits promptly even though a handle is holding the event loop open', () => {
    const r = run('clean')
    expect(r.signal).toBeNull()
    expect(r.status).toBe(0)
    expect(r.out).toContain('work finished')
  })

  it('reports the WORK, not the teardown, when teardown rejects', () => {
    const r = run('teardown-throws')
    expect(r.signal).toBeNull()
    expect(r.status).toBe(0)
  })

  it('logs the teardown fault rather than hiding it', () => {
    const r = run('teardown-throws')
    expect(r.out).toContain('FAULT teardown failed after the work finished')
    expect(r.out).toContain('close() blew up')
  })

  it('survives the WASM rethrow that Node raises as an uncaught exception', () => {
    const r = run('wasm-rethrow')
    expect(r.signal).toBeNull()
    expect(r.status).toBe(0)
    expect(r.out).toContain('unwrap_throw')
    expect(r.out).toContain('exit code stays 0')
  })

  it('keeps a genuine failure’s own exit code across the same teardown fault', () => {
    for (const code of [1, 4, 6]) {
      const r = run('teardown-throws', code)
      expect(r.signal).toBeNull()
      expect(r.status).toBe(code)
    }
  })

  it('keeps a genuine failure’s exit code across the WASM rethrow too', () => {
    const r = run('wasm-rethrow', 6)
    expect(r.signal).toBeNull()
    expect(r.status).toBe(6)
    expect(r.out).toContain('exit code stays 6')
  })

  it('leaves anyway when teardown deadlocks instead of throwing', () => {
    // `pool.end()` waiting on a connection nobody released: the S3 child's
    // other teardown bug, which guarding only the exception would have turned
    // from "exits 1" into "never exits".
    const started = Date.now()
    const r = run('teardown-hangs', 4)
    expect(r.signal).toBeNull()
    expect(r.status).toBe(4)
    expect(r.out).toContain('teardown still unfinished')
    expect(Date.now() - started).toBeLessThan(25_000)
    // Deliberately slow: the whole point is that the real grace period elapses.
  }, 30_000)

  it('never converts a SIGKILL into a clean exit', () => {
    const r = run('sigkill')
    expect(r.signal).toBe('SIGKILL')
    expect(r.status).toBeNull()
  })
})
