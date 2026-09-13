import { describe, it, expect, vi } from 'vitest'
import { serializedSystemdRestart, shouldUseNohupFallback, systemdUnitExists } from '../src/host/restart-exec.js'

// A serialized restart must never overlap the old process: stop, wait until
// the unit is inactive, then start — instead of one raw `systemctl restart`
// that boots the new process while the old one still holds :3082 (EADDRINUSE
// crash loop, 2026-09-11 outage).
function harness(over: Record<string, unknown> = {}) {
  const cmds: string[] = []
  const d: any = {
    exec: vi.fn((cmd: string) => { cmds.push(cmd) }),
    isActive: vi.fn(() => false),
    sleep: vi.fn(async () => {}),
    stopTimeoutMs: 10_000,
    pollMs: 1_000,
    ...over,
  }
  return { d, cmds }
}

describe('serializedSystemdRestart', () => {
  it('stops, waits until inactive, then starts exactly once', async () => {
    const active = [true, true, false]
    const { d, cmds } = harness({ isActive: vi.fn(() => active.shift() ?? false) })
    await serializedSystemdRestart(d)
    expect(cmds[0]).toMatch(/stop/)
    expect(cmds[cmds.length - 1]).toMatch(/start/)
    expect(cmds.filter(c => /start/.test(c))).toHaveLength(1)
    expect(d.sleep).toHaveBeenCalled()
  })

  it('proceeds to start when stop itself fails (best-effort stop)', async () => {
    const { d, cmds } = harness({
      exec: vi.fn((cmd: string) => {
        cmds.push(cmd)
        if (/stop/.test(cmd)) throw new Error('unit not loaded')
      }),
    })
    await serializedSystemdRestart(d)
    expect(cmds.some(c => /start/.test(c))).toBe(true)
  })

  it('starts after the wait times out instead of waiting forever', async () => {
    let now = 1_000
    const { d, cmds } = harness({
      isActive: vi.fn(() => true),
      stopTimeoutMs: 3_000,
      pollMs: 1_000,
      sleep: vi.fn(async (ms: number) => { now += ms }),
      now: () => now,
    })
    await serializedSystemdRestart(d)
    expect(cmds.some(c => /start/.test(c))).toBe(true)
    expect(d.sleep.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('throws when start fails so callers can fall back', async () => {
    const { d } = harness({
      exec: vi.fn((cmd: string) => {
        if (/start/.test(cmd)) throw new Error('start refused')
      }),
    })
    await expect(serializedSystemdRestart(d)).rejects.toThrow(/start refused/)
  })
})

describe('nohup fallback gate', () => {
  it('never uses the direct-node fallback when the systemd unit exists', () => {
    expect(shouldUseNohupFallback(true)).toBe(false)
  })

  it('falls back to direct node only on hosts without the unit', () => {
    expect(shouldUseNohupFallback(false)).toBe(true)
  })

  it('reports a missing unit path instead of throwing', () => {
    expect(systemdUnitExists('/nonexistent/dsh-web.service')).toBe(false)
  })
})
