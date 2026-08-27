import { describe, it, expect, vi } from 'vitest'
import { resumeInterrupted } from '../src/host/plugin.js'

function makeCtx(overrides: Record<string, any> = {}) {
  const logs: string[] = []
  return {
    logger: {
      info: (msg: string) => logs.push(`info:${msg}`),
      warn: (msg: string) => logs.push(`warn:${msg}`),
    },
    sessions: { get: () => undefined },
    get: (key: string) => (overrides[key] !== undefined ? overrides[key] : undefined),
    _logs: logs,
    ...overrides,
  }
}

describe('resumeInterrupted', () => {
  it('skips a session that is already live', async () => {
    const ctx = makeCtx({ sessions: { get: () => ({ status: 'active' }) } })
    await resumeInterrupted(ctx, ['proj/abc-123'])
    expect(ctx._logs.some((l: string) => l.includes('already live'))).toBe(true)
  })

  it('does nothing for a session with no sessionPersistence available', async () => {
    const ctx = makeCtx()
    await expect(resumeInterrupted(ctx, ['proj/abc-123'])).resolves.toBeUndefined()
  })

  it('continues to the next id when one session throws', async () => {
    const throwingPersistence = { load: async () => { throw new Error('disk error') } }
    const ctx = makeCtx({ sessionPersistence: throwingPersistence })
    await expect(resumeInterrupted(ctx, ['proj/bad-1', 'proj/bad-2'])).resolves.toBeUndefined()
    expect(ctx._logs.filter((l: string) => l.includes('warn:')).length).toBeGreaterThanOrEqual(2)
  })
})
