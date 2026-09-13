import { describe, it, expect, vi } from 'vitest'

// Hermetic supervisor config: the replay must not depend on the operator's
// ~/.dsh settings (the daemon's real poll interval, thresholds and boot budget
// are irrelevant to the verdict path under test).
vi.mock('../src/host/config.js', () => ({
  readSupervisorConfig: async () => ({
    bootGraceMs: 180_000,
    pollTimeoutMs: 20_000,
    downThreshold: 3,
    degradedThreshold: 5,
    intervalMs: 3_000,
  }),
}))

import { pollHealth } from '../src/host/health-poller.js'
import { Supervisor } from '../src/host/supervisor.js'
import { BOOT_BOUNDARY_MARKER } from '../src/host/restart-guards.js'

// Timeline of the incident (2026-09-13): the single dsh_web_restart at
// 09:04:29 started a boot that was still running at 09:05:47 (the report) and
// only exited at 09:06:21 — 1m52s. The rollback report was written 78s in.
const ACTIVE_ENTER_AT = Date.now() - 78_000
const BOUNDARY_AT = ACTIVE_ENTER_AT - 5_000

// The incident's log shape: the PREVIOUS boot's success marker, the losing
// boot's EADDRINUSE stack (30 such lines predate the incident), then this
// boot's own boundary and its still-loading output.
const INCIDENT_LOG = [
  'dsh web: http://127.0.0.1:3082/?token=previous-boot',
  'listening on 3080',
  'Error: listen EADDRINUSE: address already in use 127.0.0.1:3082',
  '    at Server.setupListenHandle (node:net:1940:16)',
  `${BOOT_BOUNDARY_MARKER} ${new Date(BOUNDARY_AT).toISOString()}`,
  '[workspace] loading plugin tree…',
].join('\n')

function incidentPollHealth(bootGraceMs: number) {
  return pollHealth({
    fetch: async () => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }) },
    psAlive: async () => true, // the previous instance still held :3082 → EADDRINUSE
    logTail: async () => INCIDENT_LOG,
    activeEnterAtMs: ACTIVE_ENTER_AT,
    bootGraceMs,
  })
}

describe('slow-boot double-restart incident (2026-09-13)', () => {
  it('pre-fix verdict: with the 30s window already expired the abort is degraded', async () => {
    // bootGraceMs 0 models the pre-fix world at +78s: the 30s planned-restart
    // marker and the 30s isRecentlyStarted window had both expired.
    const r = await incidentPollHealth(0)
    expect(r.up).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.error).toContain('This operation was aborted')
  })

  it('post-fix verdict: the boot budget keeps the same poll healthy and inconclusive', async () => {
    const r = await incidentPollHealth(180_000)
    expect(r.bootPhase).toBe('booting')
    expect(r.up).toBe(true)
    expect(r.degraded).toBeFalsy()
    expect(r.error).toBeUndefined()
  })

  it('the full supervisor loop produces zero rollbacks and zero extra restarts', async () => {
    const rollback = vi.fn(async () => {})
    const restartWeb = vi.fn(async () => {})
    const writeReport = vi.fn(async () => '/tmp/report.md')
    const s = new Supervisor({
      pollHealth: () => incidentPollHealth(180_000),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeFailed: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeReport,
      rollback,
      restartWeb,
      notify: vi.fn(async () => {}),
      intervalMs: 3_000,
      getTime: () => Date.now(),
      // The incident happened AFTER the 30s marker expired, so the suppression
      // marker must be modelled as absent: the freshness gate is what has to
      // hold the counters, not the marker.
      checkPlannedRestart: () => false,
      isPlannedRestartActive: async () => false,
    } as any)
    // 2 minutes at the daemon's 3s interval → 40 polls, all inside the boot grace.
    for (let i = 0; i < 40; i++) await s.tick()
    expect(rollback).not.toHaveBeenCalled()
    expect(restartWeb).not.toHaveBeenCalled()
    expect(writeReport).not.toHaveBeenCalled()
  })
})
