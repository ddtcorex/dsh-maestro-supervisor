import { describe, it, expect, vi } from 'vitest'
import { pollHealth } from '../src/host/health-poller.js'

describe('health-poller', () => {
  it('reports up when curl 200', async () => {
    const r = await pollHealth({
      fetch: async () => ({ status: 200, text: async () => 'ok marker' }) as any,
      psAlive: async () => true,
      logTail: async () => '',
    })
    expect(r.up).toBe(true)
    expect(r.httpCode).toBe(200)
  })

  it('reports down when curl fails', async () => {
    const r = await pollHealth({
      fetch: async () => { throw new Error('ECONNREFUSED') },
      psAlive: async () => false,
      logTail: async () => '',
    })
    expect(r.up).toBe(false)
  })

  it('detects error in log tail', async () => {
    const r = await pollHealth({
      fetch: async () => ({ status: 200, text: async () => 'ok' }) as any,
      psAlive: async () => true,
      logTail: async () => 'ERR_MODULE_NOT_FOUND: cannot find lib/index.js',
    })
    expect(r.error).toContain('ERR_MODULE_NOT_FOUND')
    expect(r.up).toBe(true)
    expect(r.degraded).toBe(true)
  })

  it('reports degraded when log has assertChannel error but curl ok', async () => {
    const r = await pollHealth({
      fetch: async () => ({ status: 200, text: async () => 'ok' }) as any,
      psAlive: async () => true,
      logTail: async () => 'assertChannel failed: channel must start with /',
    })
    expect(r.up).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.error).toContain('assertChannel')
  })
})
