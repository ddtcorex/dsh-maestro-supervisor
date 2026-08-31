import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Supervisor, resumeViaRpc } from '../src/host/supervisor.js'

describe('supervisor', () => {
  it('posts a valid loopback RPC envelope and returns the resumed ids', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: { resumed: ['proj/session-a'] } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    await expect(resumeViaRpc(['proj/session-a'], fetch)).resolves.toEqual({ resumed: ['proj/session-a'] })
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3080/dsh-maestro-supervisor-resume/resume',
      expect.objectContaining({ method: 'POST', headers: { 'content-type': 'application/json' } }),
    )
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toMatchObject({
      type: 'client-request', method: 'resume', payload: { ids: ['proj/session-a'] },
    })
  })

  it('reports a failed resume trigger instead of claiming auto-resume', async () => {
    const notify = vi.fn(async () => {})
    const s = new Supervisor({
      pollHealth: async () => ({ up: true, httpCode: 200 }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeFailed: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeReport: vi.fn(async () => '/tmp/report.md'),
      rollback: vi.fn(async () => {}),
      notify,
      resumeSessions: async () => { throw new Error('loopback unavailable') },
    })

    await (s as any).attemptAutoResume(['proj/session-a'])
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('RESUME FAILED'))
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining('auto-resuming'))
  })

  it('writes LKG when healthy', async () => {
    const writeLKG = vi.fn(async () => ({ ts: '2026-08-27T00-00-00-000Z', manifest: { ts: '', files: [] } as any }))
    const s = new Supervisor({
      pollHealth: async () => ({ up: true, httpCode: 200 }),
      writeLKG,
      writeFailed: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeReport: vi.fn(async () => '/tmp/report.md'),
      rollback: vi.fn(async () => {}),
      notify: vi.fn(async () => {}),
      intervalMs: 10,
    })
    await s.tick()
    expect(writeLKG).toHaveBeenCalled()
  })

  it('rollbacks once when down (debounced)', async () => {
    const rollback = vi.fn(async () => {})
    const writeReport = vi.fn(async () => '/tmp/report.md')
    const s = new Supervisor({
      pollHealth: async () => ({ up: false, error: 'ERR_MODULE_NOT_FOUND' }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeFailed: vi.fn(async () => ({ ts: 'failed-ts', manifest: { ts: '', files: [] } as any })),
      writeReport,
      rollback,
      notify: vi.fn(async () => {}),
      intervalMs: 10,
      debounceMs: 60000,
      downThreshold: 1, // this test is about debounce, not the consecutive-failure threshold
    })
    await s.tick()
    await s.tick() // second tick within debounce should not rollback again
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(writeReport).toHaveBeenCalled()
  })

  it('does not rollback on a single transient down poll', async () => {
    // Regression: a lone fetch timeout / AbortError during a slow boot was
    // being treated as a confirmed crash on the very first bad poll, which
    // then re-triggered restartWeb() and its own transient errors — a
    // self-sustaining restart loop. Require consecutive confirmations.
    const rollback = vi.fn(async () => {})
    const s = new Supervisor({
      pollHealth: async () => ({ up: false, error: 'This operation was aborted' }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeFailed: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeReport: vi.fn(async () => '/tmp/report.md'),
      rollback,
      notify: vi.fn(async () => {}),
      intervalMs: 10,
      downThreshold: 3,
    })
    await s.tick()
    await s.tick()
    expect(rollback).not.toHaveBeenCalled()
  })

  it('rollbacks once downThreshold consecutive down polls are seen', async () => {
    const rollback = vi.fn(async () => {})
    const notify = vi.fn(async () => {})
    const s = new Supervisor({
      pollHealth: async () => ({ up: false, error: 'This operation was aborted' }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeFailed: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeReport: vi.fn(async () => '/tmp/report.md'),
      rollback,
      notify,
      intervalMs: 10,
      downThreshold: 3,
    })
    await s.tick()
    await s.tick()
    expect(rollback).not.toHaveBeenCalled()
    await s.tick()
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('resets the consecutive-down count when health recovers between down polls', async () => {
    const states: Array<{ up: boolean; error?: string }> = [
      { up: false, error: 'aborted' },
      { up: false, error: 'aborted' },
      { up: true, httpCode: 200 } as any, // recovers before hitting the threshold
      { up: false, error: 'aborted' },
      { up: false, error: 'aborted' },
    ]
    const rollback = vi.fn(async () => {})
    const s = new Supervisor({
      pollHealth: async () => states.shift() as any,
      writeLKG: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeFailed: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeReport: vi.fn(async () => '/tmp/report.md'),
      rollback,
      notify: vi.fn(async () => {}),
      intervalMs: 10,
      downThreshold: 3,
    })
    for (let i = 0; i < states.length; i++) await s.tick()
    expect(rollback).not.toHaveBeenCalled()
  })

  it('does not treat down as a crash while a planned restart is active', async () => {
    // Coordination with dsh-safe-web-update's restart-dsh-web.sh: an
    // intentional restart can hold the port down far longer than any
    // consecutive-down threshold tuned for a real crash. See
    // docs/specs/2026-08-28-supervisor-planned-restart-design.md.
    const rollback = vi.fn(async () => {})
    const restartWeb = vi.fn(async () => {})
    const s = new Supervisor({
      pollHealth: async () => ({ up: false, error: 'aborted' }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeFailed: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeReport: vi.fn(async () => '/tmp/report.md'),
      rollback,
      restartWeb,
      notify: vi.fn(async () => {}),
      intervalMs: 10,
      downThreshold: 1,
      isPlannedRestartActive: async () => true,
    })
    await s.tick()
    await s.tick()
    await s.tick()
    expect(rollback).not.toHaveBeenCalled()
    expect(restartWeb).not.toHaveBeenCalled()
  })

  it('resumes normal crash handling once the planned-restart marker is gone', async () => {
    let planned = true
    const rollback = vi.fn(async () => {})
    const s = new Supervisor({
      pollHealth: async () => ({ up: false, error: 'aborted' }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeFailed: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeReport: vi.fn(async () => '/tmp/report.md'),
      rollback,
      notify: vi.fn(async () => {}),
      intervalMs: 10,
      downThreshold: 1,
      isPlannedRestartActive: async () => planned,
    })
    await s.tick()
    expect(rollback).not.toHaveBeenCalled()
    planned = false
    await s.tick()
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('does not rollback when already rolling back', async () => {
    let resolvers: (() => void)[] = []
    const rollback = vi.fn(async () => new Promise<void>(r => resolvers.push(r)))
    const s = new Supervisor({
      pollHealth: async () => ({ up: false, error: 'crash' }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeFailed: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeReport: vi.fn(async () => '/tmp/report.md'),
      rollback,
      notify: vi.fn(async () => {}),
      intervalMs: 10,
      downThreshold: 1,
    })
    const p1 = s.tick()
    const p2 = s.tick()
    await new Promise(r => setTimeout(r, 20))
    expect(rollback).toHaveBeenCalledTimes(1)
    resolvers.forEach(r => r())
    await p1; await p2
  })

  it('marker: restartWeb writes marker before systemctl', async () => {
    const writes: string[] = []
    const s = new Supervisor({
      pollHealth: async () => ({ up: true, httpCode: 200 }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeFailed: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeReport: vi.fn(async () => '/tmp/report.md'),
      rollback: vi.fn(async () => {}),
      restartWeb: async () => { writes.push('restart') },
      notify: vi.fn(async () => {}),
      // injected marker writer for test isolation — Supervisor.restartWeb must call it with 30000 first
      writePlannedRestart: ((ttl?: number) => { writes.push(`marker:${ttl ?? 30000}`) }) as any,
    } as any)
    await s.restartWeb()
    expect(writes[0]).toBe('marker:30000')
    expect(writes[1]).toBe('restart')
  })

  it('marker: tick suppressed when planned restart active (no writeFailed/writeReport/rollback)', async () => {
    const writeFailed = vi.fn(async () => ({ ts: 'failed', manifest: { ts: '', files: [] } as any }))
    const writeReport = vi.fn(async () => '/tmp/report.md')
    const rollback = vi.fn(async () => {})
    const s = new Supervisor({
      pollHealth: async () => ({ up: false, error: 'crash' }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeFailed,
      writeReport,
      rollback,
      notify: vi.fn(async () => {}),
      intervalMs: 10,
      downThreshold: 1,
      checkPlannedRestart: () => true,
    } as any)
    await s.tick()
    await s.tick()
    await s.tick()
    expect(writeFailed).not.toHaveBeenCalled()
    expect(writeReport).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
  })

  it('marker: tick doubles downThreshold when suppressed', async () => {
    const rollback = vi.fn(async () => {})
    const writeFailed = vi.fn(async () => ({ ts: 'failed', manifest: { ts: '', files: [] } as any }))
    const writeReport = vi.fn(async () => '/tmp/report.md')
    // Phase 1: suppressed — downThreshold 3 doubled to 6, so 3 ticks should NOT trigger rollback
    const sSuppressed = new Supervisor({
      pollHealth: async () => ({ up: false, error: 'crash' }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeFailed,
      writeReport,
      rollback,
      notify: vi.fn(async () => {}),
      intervalMs: 10,
      downThreshold: 3,
      checkPlannedRestart: () => true,
    } as any)
    await sSuppressed.tick()
    await sSuppressed.tick()
    await sSuppressed.tick()
    expect(rollback).not.toHaveBeenCalled()
    expect(writeFailed).not.toHaveBeenCalled()
    // 6th tick still suppressed (marker active) — should never rollback while suppressed
    await sSuppressed.tick()
    await sSuppressed.tick()
    await sSuppressed.tick()
    expect(rollback).not.toHaveBeenCalled()
    // Phase 2: not suppressed — same 3 threshold should rollback after 3 downs
    const rollback2 = vi.fn(async () => {})
    const sNormal = new Supervisor({
      pollHealth: async () => ({ up: false, error: 'crash' }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: { ts: '', files: [] } as any })),
      writeFailed: vi.fn(async () => ({ ts: 'failed', manifest: { ts: '', files: [] } as any })),
      writeReport: vi.fn(async () => '/tmp/report.md'),
      rollback: rollback2,
      notify: vi.fn(async () => {}),
      intervalMs: 10,
      downThreshold: 3,
      checkPlannedRestart: () => false,
    } as any)
    await sNormal.tick()
    await sNormal.tick()
    expect(rollback2).not.toHaveBeenCalled()
    await sNormal.tick()
    expect(rollback2).toHaveBeenCalledTimes(1)
  })
})

describe('caller restart-request handling', () => {
  it('fires restartWeb exactly once after the grace when a caller marker is present', async () => {
    vi.useFakeTimers()
    const restartWeb = vi.fn(async () => {})
    const notify = vi.fn(async () => {})
    const req = { ts: Date.now(), ttl: 180_000, callerSessionId: 'proj/s-1', reason: 'plugin v2' }
    const supervisor = new Supervisor({
      pollHealth: async () => ({ up: false }),
      writeLKG: async () => ({ ts: '', manifest: { files: [] } } as any),
      writeFailed: async () => ({ ts: '' } as any),
      writeReport: async (o: any) => o.ts,
      rollback: async () => {},
      restartWeb,
      notify,
      getTime: () => Date.now(),
      isPlannedRestartActive: async () => false,
      // Hermetic: never write the real ~/.dsh/.supervisor/planned-restart.json
      // (a live daemon and parallel test files contend on that path).
      writePlannedRestart: () => {},
      readRestartRequest: () => req,
    } as any)
    await supervisor.tick()
    await vi.advanceTimersByTimeAsync(6000)
    expect(restartWeb).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/self-restart by session proj\/s-1/))
    supervisor.stop()
    vi.useRealTimers()
  })

  it('does nothing when the marker has no caller', async () => {
    vi.useFakeTimers()
    const restartWeb = vi.fn(async () => {})
    const supervisor = new Supervisor({
      pollHealth: async () => ({ up: false }),
      writeLKG: async () => ({ ts: '' } as any),
      writeFailed: async () => ({ ts: '' } as any),
      writeReport: async (o: any) => o.ts,
      rollback: async () => {},
      restartWeb,
      notify: async () => {},
      getTime: () => Date.now(),
      writePlannedRestart: () => {},
      readRestartRequest: () => undefined,
    } as any)
    await supervisor.tick()
    await vi.advanceTimersByTimeAsync(6000)
    expect(restartWeb).not.toHaveBeenCalled()
    supervisor.stop()
    vi.useRealTimers()
  })

  it('clears the suppression marker on the post-restart up-tick (held until boot proves healthy)', async () => {
    vi.useFakeTimers()
    const restartWeb = vi.fn(async () => {})
    const cleared = vi.fn()
    let up = false
    let marker: any = { ts: Date.now(), ttl: 180_000, callerSessionId: 'proj/s-1', reason: 'plugin v2' }
    const supervisor = new Supervisor({
      pollHealth: async () => ({ up }),
      writeLKG: async () => ({ ts: '' } as any),
      writeFailed: async () => ({ ts: '' } as any),
      writeReport: async (o: any) => o.ts,
      rollback: async () => {},
      restartWeb,
      notify: async () => {},
      getTime: () => Date.now(),
      writePlannedRestart: () => {},
      readRestartRequest: () => marker,
      clearPlannedRestart: cleared,
    } as any)
    await supervisor.tick()
    await vi.advanceTimersByTimeAsync(6000)
    expect(restartWeb).toHaveBeenCalledTimes(1)
    // The suppression marker must NOT be cleared before the restart boot
    // proves healthy — clearing early would drop crash suppression mid-boot.
    expect(cleared).not.toHaveBeenCalled()
    // Boot completes: the up-tick clears the pending marker/flag exactly once
    // and does not re-fire restartWeb.
    up = true
    marker = undefined
    await supervisor.tick()
    expect(cleared).toHaveBeenCalledTimes(1)
    expect(restartWeb).toHaveBeenCalledTimes(1)
    // Marker cleared + latch re-armed → a fresh request is handled again.
    marker = { ts: Date.now(), ttl: 180_000, callerSessionId: 'proj/s-2', reason: 'again' }
    await supervisor.tick()
    await vi.advanceTimersByTimeAsync(6000)
    expect(restartWeb).toHaveBeenCalledTimes(2)
    supervisor.stop()
    vi.useRealTimers()
  })

  it('keeps the single-flight latch when the up-tick marker clear fails', async () => {
    vi.useFakeTimers()
    const restartWeb = vi.fn(async () => {})
    let up = false
    const supervisor = new Supervisor({
      pollHealth: async () => ({ up }),
      writeLKG: async () => ({ ts: '' } as any),
      writeFailed: async () => ({ ts: '' } as any),
      writeReport: async (o: any) => o.ts,
      rollback: async () => {},
      restartWeb,
      notify: async () => {},
      getTime: () => Date.now(),
      writePlannedRestart: () => {},
      readRestartRequest: () => ({ ts: Date.now(), ttl: 180_000, callerSessionId: 'proj/s-1' }),
      clearPlannedRestart: () => { throw new Error('disk error') },
    } as any)
    await supervisor.tick()
    await vi.advanceTimersByTimeAsync(6000)
    expect(restartWeb).toHaveBeenCalledTimes(1)
    // Boot completes but the clear throws → the latch must stay set so the
    // still-present marker is never re-handled into a second restart.
    up = true
    await supervisor.tick()
    up = false
    await supervisor.tick()
    await vi.advanceTimersByTimeAsync(6000)
    expect(restartWeb).toHaveBeenCalledTimes(1)
    supervisor.stop()
    vi.useRealTimers()
  })

  it('does not rollback or re-fire restartWeb on a down tick within the restart debounce', async () => {
    vi.useFakeTimers()
    const restartWeb = vi.fn(async () => {})
    const rollback = vi.fn(async () => {})
    let up = false
    const supervisor = new Supervisor({
      pollHealth: async () => ({ up }),
      writeLKG: async () => ({ ts: '' } as any),
      writeFailed: async () => ({ ts: '' } as any),
      writeReport: async (o: any) => o.ts,
      rollback,
      restartWeb,
      notify: async () => {},
      getTime: () => Date.now(),
      writePlannedRestart: () => {},
      readRestartRequest: () => ({ ts: Date.now(), ttl: 180_000, callerSessionId: 'proj/s-1' }),
      downThreshold: 1, // normally a single down tick would rollback + restart
    } as any)
    await supervisor.tick()
    await vi.advanceTimersByTimeAsync(6000)
    expect(restartWeb).toHaveBeenCalledTimes(1)
    expect(rollback).not.toHaveBeenCalled()
    // Still booting (down). The debounce set when the grace branch issued the
    // restart must hold: no rollback and no racing second restart.
    await supervisor.tick()
    await vi.advanceTimersByTimeAsync(6000)
    expect(rollback).not.toHaveBeenCalled()
    expect(restartWeb).toHaveBeenCalledTimes(1)
    supervisor.stop()
    vi.useRealTimers()
  })
})
