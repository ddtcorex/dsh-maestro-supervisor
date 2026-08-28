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
})
