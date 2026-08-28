import { describe, it, expect, vi } from 'vitest'
import { Supervisor } from '../src/host/supervisor.js'

describe('supervisor — debug-agent LLM integration', () => {
  it('notifies FIXED when debug-agent reports fixed (degraded)', async () => {
    const notify = vi.fn(async () => {})
    const runDebugAgent = vi.fn(async () => ({ fixed: true, reason: 'LLM fixed: patched allowBuilds' }))
    const s = new Supervisor({
      pollHealth: async () => ({ up: true, degraded: true, httpCode: 200, error: 'allowBuilds missing' }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: {} as any })),
      writeFailed: vi.fn(async () => ({ ts: '', manifest: {} as any })),
      writeReport: vi.fn(async () => '/tmp/report-xyz.md'),
      rollback: vi.fn(async () => {}),
      notify,
      runDebugAgent,
      findInterrupted: async () => ({ scanned: 5, interrupted: [] }),
      intervalMs: 10,
    })
    await s.tick()
    // give fire-and-forget a tick to resolve
    await new Promise(r => setTimeout(r, 30))
    expect(runDebugAgent).toHaveBeenCalledWith(expect.objectContaining({ reportPath: '/tmp/report-xyz.md' }))
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('FIXED'))
  })

  it('notifies FIX FAILED after max attempts (degraded)', async () => {
    const notify = vi.fn(async () => {})
    const runDebugAgent = vi.fn(async () => ({ fixed: false, reason: 'max attempts' }))
    const s = new Supervisor({
      pollHealth: async () => ({ up: true, degraded: true, httpCode: 200, error: 'weird error' }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: {} as any })),
      writeFailed: vi.fn(async () => ({ ts: '', manifest: {} as any })),
      writeReport: vi.fn(async () => '/tmp/report-abc.md'),
      rollback: vi.fn(async () => {}),
      notify,
      runDebugAgent,
      findInterrupted: async () => ({ scanned: 0, interrupted: [] }),
      intervalMs: 10,
    })
    await s.tick()
    await new Promise(r => setTimeout(r, 30))
    expect(runDebugAgent).toHaveBeenCalled()
    // should notify with FIX FAILED or at least contain max attempts
    const calls = notify.mock.calls.map(c => c[0] as string)
    expect(calls.some(m => m.includes('FIX FAILED') || m.includes('max attempts'))).toBe(true)
  })

  it('notifies FIXED when debug-agent fixes full crash after rollback', async () => {
    const notify = vi.fn(async () => {})
    const runDebugAgent = vi.fn(async () => ({ fixed: true, reason: 'LLM fixed after rollback' }))
    const s = new Supervisor({
      pollHealth: async () => ({ up: false, httpCode: 500, error: 'ERR_MODULE_NOT_FOUND lib' }),
      writeLKG: vi.fn(async () => ({ ts: '', manifest: {} as any })),
      writeFailed: vi.fn(async () => ({ ts: 'failed-ts', manifest: {} as any })),
      writeReport: vi.fn(async () => '/tmp/report-full.md'),
      rollback: vi.fn(async () => {}),
      notify,
      runDebugAgent,
      findInterrupted: async () => ({ scanned: 3, interrupted: ['sess1'] }),
      debounceMs: 0,
      downThreshold: 1,
      intervalMs: 10,
    })
    await s.tick()
    await new Promise(r => setTimeout(r, 30))
    expect(runDebugAgent).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('CRASH'))
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('FIXED'))
  })
})
