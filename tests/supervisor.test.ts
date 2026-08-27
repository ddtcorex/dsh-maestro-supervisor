import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Supervisor } from '../src/host/supervisor.js'

describe('supervisor', () => {
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
    })
    await s.tick()
    await s.tick() // second tick within debounce should not rollback again
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(writeReport).toHaveBeenCalled()
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
    })
    const p1 = s.tick()
    const p2 = s.tick()
    await new Promise(r => setTimeout(r, 20))
    expect(rollback).toHaveBeenCalledTimes(1)
    resolvers.forEach(r => r())
    await p1; await p2
  })
})
