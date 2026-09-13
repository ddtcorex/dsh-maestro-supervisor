import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { acquireBootGuard, releaseBootGuard, bootBoundaryLogPath, runBootGuardCli } from '../src/host/boot-guard.js'
import { BOOT_BOUNDARY_MARKER } from '../src/host/restart-guards.js'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-guard-'))
  return {
    root,
    lockPath: path.join(root, 'boot.lock'),
    logPath: path.join(root, 'dsh-web.log'),
    deps: { lockPath: path.join(root, 'boot.lock'), now: () => 1_000, pidAlive: () => true, staleMs: 180_000 },
  }
}

// D6 — the manual skill script and the supervisor's performSingleBootRestart
// must share one boot.lock and one boot-boundary sentinel, so a human restart
// is serialized with a supervised one and its boot window is scoped in the log
// the same way.
describe('boot-guard (D6)', () => {
  it('takes the shared boot.lock and appends the shared boundary sentinel', () => {
    const f = fixture()
    try {
      const guard = acquireBootGuard({ ...f.deps, pid: 4242 }, f.logPath)

      expect(guard.acquired).toBe(true)
      expect(JSON.parse(fs.readFileSync(f.lockPath, 'utf-8'))).toEqual({ pid: 4242, ts: 1_000 })
      expect(fs.readFileSync(f.logPath, 'utf-8')).toContain(BOOT_BOUNDARY_MARKER)

      guard.release()
      expect(fs.existsSync(f.lockPath)).toBe(false)
    } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
  })

  it('refuses when another live boot already holds the lock', () => {
    const f = fixture()
    try {
      const first = acquireBootGuard({ ...f.deps, pid: 4242 }, f.logPath)
      const second = acquireBootGuard({ ...f.deps, pid: 4343 }, f.logPath)

      expect(second.acquired).toBe(false)
      // The losing side must not steal or release the winner's lock.
      second.release()
      expect(JSON.parse(fs.readFileSync(f.lockPath, 'utf-8')).pid).toBe(4242)

      first.release()
    } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
  })

  it('releases only a lock owned by the given pid', () => {
    const f = fixture()
    try {
      acquireBootGuard({ ...f.deps, pid: 4242 }, f.logPath)

      expect(releaseBootGuard(9999, f.deps)).toBe(false)
      expect(fs.existsSync(f.lockPath)).toBe(true)
      expect(releaseBootGuard(4242, f.deps)).toBe(true)
      expect(fs.existsSync(f.lockPath)).toBe(false)
    } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
  })

  it('drives the same behaviour from the CLI the skill script calls', () => {
    const f = fixture()
    try {
      expect(runBootGuardCli(['acquire', '--pid', '4242'], f.deps, f.logPath)).toBe(0)
      expect(fs.existsSync(f.lockPath)).toBe(true)
      // A second boot is refused with a distinct exit code, not a stack trace.
      expect(runBootGuardCli(['acquire', '--pid', '4343'], f.deps, f.logPath)).toBe(3)
      expect(runBootGuardCli(['release', '--pid', '4242'], f.deps, f.logPath)).toBe(0)
      expect(fs.existsSync(f.lockPath)).toBe(false)
      // Idempotent: releasing again is not an error.
      expect(runBootGuardCli(['release', '--pid', '4242'], f.deps, f.logPath)).toBe(0)
    } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
  })

  it('rejects a call without an explicit owner pid', () => {
    const f = fixture()
    try {
      expect(runBootGuardCli(['acquire'], f.deps, f.logPath)).toBe(64)
      expect(runBootGuardCli(['nonsense', '--pid', '4242'], f.deps, f.logPath)).toBe(64)
    } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
  })

  it('writes the sentinel into the isolated DSH_HOME log, not the operator home', () => {
    expect(bootBoundaryLogPath({ DSH_HOME: '/tmp/example-home' } as any)).toBe('/tmp/example-home/dsh-web.log')
    expect(bootBoundaryLogPath({ DSH_WEB_LOG: '/tmp/example-web.log' } as any)).toBe('/tmp/example-web.log')
  })
})

describe('dsh-safe-restart script contract (D6)', () => {
  const scriptPath = new URL('../skills/dsh-safe-restart/scripts/restart-dsh-web.sh', import.meta.url)
  const script = fs.readFileSync(scriptPath, 'utf-8')

  it('acquires and releases the lock through the package helper, not a re-implementation', () => {
    expect(script).toMatch(/boot-guard acquire/)
    expect(script).toMatch(/boot-guard release/)
    expect(script).toContain('lib/bin.js')
    // The sentinel must come from markBootBoundary() — never re-typed here.
    expect(script).not.toContain(BOOT_BOUNDARY_MARKER)
  })

  it('holds the lock across the stop/start window and releases it on every exit path', () => {
    expect(script).toMatch(/trap '[^']*boot_guard_release[^']*' EXIT/)
  })
})
