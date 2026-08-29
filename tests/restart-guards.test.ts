import { describe, it, expect } from 'vitest'
import { buildKillStalePortsCommand } from '../src/host/restart-guards.js'

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
  it('recognizes the literal error message this bug produced in production', async () => {
    const { isSelfCopyError } = await import('../src/host/restart-guards.js')
    expect(isSelfCopyError(
      'Cannot copy /home/kai/.npm/_npx/1e7f6d9597241db0/node_modules/unist-util-position ' +
      'to a subdirectory of self /home/kai/.npm/_npx/1e7f6d9597241db0/node_modules/unist-util-position',
    )).toBe(true)
  })

  it('still recognizes the older "cannot be the same" phrasing', async () => {
    const { isSelfCopyError } = await import('../src/host/restart-guards.js')
    expect(isSelfCopyError('src and dest cannot be the same')).toBe(true)
  })

  it('does not swallow unrelated errors', async () => {
    const { isSelfCopyError } = await import('../src/host/restart-guards.js')
    expect(isSelfCopyError('ENOENT: no such file or directory')).toBe(false)
  })
})

describe('isPlannedRestartFresh', () => {
  it('is fresh when mtime is recent', async () => {
    const { isPlannedRestartFresh } = await import('../src/host/restart-guards.js')
    expect(isPlannedRestartFresh(1000, 1000 + 60_000, 180_000)).toBe(true)
  })

  it('is stale once mtime is older than the TTL', async () => {
    const { isPlannedRestartFresh } = await import('../src/host/restart-guards.js')
    expect(isPlannedRestartFresh(0, 200_000, 180_000)).toBe(false)
  })

  it('treats the exact TTL boundary as stale (strictly less-than)', async () => {
    const { isPlannedRestartFresh } = await import('../src/host/restart-guards.js')
    expect(isPlannedRestartFresh(0, 180_000, 180_000)).toBe(false)
  })
})

describe('planned restart marker 30s', () => {
  it('planned restart marker 30s', async () => {
    const { writePlannedRestart, checkPlannedRestart, clearPlannedRestart } = await import('../src/host/restart-guards.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    clearPlannedRestart()
    expect(checkPlannedRestart()).toBe(false)
    writePlannedRestart(30000)
    expect(checkPlannedRestart()).toBe(true)
    const p = path.join(os.homedir(), '.dsh/.supervisor/planned-restart.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    expect(j.ttl).toBe(30000)
    expect(typeof j.ts).toBe('number')
    clearPlannedRestart()
  })
})
