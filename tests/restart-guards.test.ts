import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  buildKillStalePortsCommand,
  clearPlannedRestart,
  checkPlannedRestart,
  isSelfCopyError,
  isPlannedRestartFresh,
  readRestartRequest,
  writePlannedRestart,
  writeRestartRequest,
} from '../src/host/restart-guards.js'

// Point os.homedir() at a per-file temp home so every restart marker (the
// planned-restart.json JSON AND the legacy plain file) lands under the temp
// dir instead of the real ~/.dsh. Without this the restart-guards tests
// collided with the LIVE dsh-web-supervisor daemon: under parallel vitest it
// reads/writes the real ~/.dsh/.supervisor/planned-restart.json at the same
// moment the daemon's health poll checks it, producing intermittent failures
// that blocked pushes.
let fakeHome = ''
beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dsh-restart-guards-home-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
})
afterAll(() => {
  if (fakeHome) {
    try { rmSync(fakeHome, { recursive: true, force: true }) } catch {}
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => fakeHome,
  }
})

describe('buildKillStalePortsCommand', () => {
  it('only kills :3080, never :3000', () => {
    const cmd = buildKillStalePortsCommand()
    expect(cmd).toContain('sport = :3080')
    expect(cmd).not.toContain('sport = :3000')
  })

  it('scopes the ss filter to the given ports only', () => {
    const cmd = buildKillStalePortsCommand([3080, 3000])
    expect(cmd).toContain('sport = :3080')
    expect(cmd).toContain('sport = :3000')
  })

  it('never runs an unfiltered ss -tlnp (would match every listening process on the host)', () => {
    const cmd = buildKillStalePortsCommand([3080, 3000])
    // "ss -tlnp" must always be followed immediately by a port filter expression,
    // never piped straight into sed/kill unscoped (regression: killed unrelated
    // host services like redis/horizon on every restart).
    expect(cmd).not.toMatch(/ss -tlnp\s+2>\/dev\/null \| sed/)
  })

  it('defaults to the dsh web port when called with no args', () => {
    const cmd = buildKillStalePortsCommand()
    expect(cmd).toContain(':3080')
    expect(cmd).not.toContain(':3000')
  })
})

describe('isSelfCopyError', () => {
  it('recognizes the literal error message this bug produced in production', () => {
    expect(isSelfCopyError(
      'Cannot copy /home/example/.npm/_npx/1e7f6d9597241db0/node_modules/unist-util-position ' +
      'to a subdirectory of self /home/example/.npm/_npx/1e7f6d9597241db0/node_modules/unist-util-position',
    )).toBe(true)
  })

  it('still recognizes the older "cannot be the same" phrasing', () => {
    expect(isSelfCopyError('src and dest cannot be the same')).toBe(true)
  })

  it('does not swallow unrelated errors', () => {
    expect(isSelfCopyError('ENOENT: no such file or directory')).toBe(false)
  })
})

describe('isPlannedRestartFresh', () => {
  it('is fresh when mtime is recent', () => {
    expect(isPlannedRestartFresh(1000, 1000 + 60_000, 180_000)).toBe(true)
  })

  it('is stale once mtime is older than the TTL', () => {
    expect(isPlannedRestartFresh(0, 200_000, 180_000)).toBe(false)
  })

  it('treats the exact TTL boundary as stale (strictly less-than)', () => {
    expect(isPlannedRestartFresh(0, 180_000, 180_000)).toBe(false)
  })
})

describe('planned restart marker 30s', () => {
  it('writes/reads the marker under the temp home only (never the real ~/.dsh)', () => {
    clearPlannedRestart()
    expect(checkPlannedRestart()).toBe(false)
    writePlannedRestart(30000)
    expect(checkPlannedRestart()).toBe(true)
    const marker = join(fakeHome, '.dsh/.supervisor/planned-restart.json')
    const j = JSON.parse(readFileSync(marker, 'utf8'))
    expect(j.ttl).toBe(30000)
    expect(typeof j.ts).toBe('number')
    clearPlannedRestart()
    expect(checkPlannedRestart()).toBe(false)
  })
})

describe('restart-request marker', () => {
  it('persists caller metadata and reads it back; TTL expiry returns undefined', () => {
    clearPlannedRestart()
    expect(readRestartRequest()).toBeUndefined()
    writeRestartRequest({ callerSessionId: 'proj/s-1', reason: 'applied plugin v2' }, 180_000)
    const req = readRestartRequest()
    expect(req?.callerSessionId).toBe('proj/s-1')
    expect(req?.reason).toBe('applied plugin v2')
    expect(req?.ttl).toBe(180_000)
    // the marker really lives under the temp home — prove no real ~/.dsh touch
    expect(readFileSync(join(fakeHome, '.dsh/.supervisor/planned-restart.json'), 'utf8')).toContain('proj/s-1')
    clearPlannedRestart()
  })

  it('treats an expired marker as absent', () => {
    writeRestartRequest({ callerSessionId: 'x' }, -1) // ttl already elapsed
    expect(readRestartRequest()).toBeUndefined()
    clearPlannedRestart()
  })
})

const restartScriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
  'dsh-safe-restart',
  'scripts',
  'restart-dsh-web.sh',
)

describe('restart-dsh-web.sh pre-flight', () => {
  const script = readFileSync(restartScriptPath, 'utf8')

  it('runs the session-log health scan before the fresh boot when SESSIONS_ROOT exists', () => {
    const preFlightIdx = script.indexOf('# Pre-flight')
    expect(preFlightIdx).toBeGreaterThan(-1)
    // The heal must happen BEFORE any (re)launch of dsh web — while the old
    // tree is stopped — so a live writer can never race the repair.
    const startIdx = script.indexOf('systemctl --user start dsh-web.service')
    expect(startIdx).toBeGreaterThan(-1)
    expect(preFlightIdx).toBeLessThan(startIdx)
    const guard = /# Pre-flight[\s\S]*?^\s*fi\s*$/m.exec(script)?.[0] ?? ''
    expect(guard.length).toBeGreaterThan(0)
    expect(guard).toMatch(/-n "\$SESSIONS_ROOT"/)
    expect(guard).toMatch(/-d "\$SESSIONS_ROOT"/)
    expect(guard).toContain('session-health.js')
    expect(guard).toContain('runSessionHealthCheck')
    expect(guard).toContain('repair: true, quarantine: false')
    expect(guard).toContain('process.env.SESSIONS_ROOT')
  })

  it('keeps the session-health pre-flight non-fatal so a transient scan error never blocks a restart', () => {
    const guard = /# Pre-flight[\s\S]*?^\s*fi\s*$/m.exec(script)?.[0] ?? ''
    expect(guard).toContain('|| true')
    // The pre-flight itself never aborts the script — the fatal paths
    // (fail '...' / exit <n>) belong to the gated restart steps, never to an
    // opportunistic heal.
    expect(guard).not.toContain("fail '")
    expect(guard).not.toMatch(/\bexit\s+[0-9]+/)
  })
})
