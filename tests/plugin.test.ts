import { describe, it, expect, vi } from 'vitest'
import { resumeInterrupted, runAutoResume } from '../src/host/plugin.js'

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

describe('runAutoResume', () => {
  it('does not throw when findInterrupted throws', async () => {
    const ctx = makeCtx()
    const boom = async () => { throw new Error('scan failed') }
    await expect(
      runAutoResume(ctx, { findInterrupted: boom as any })
    ).resolves.toBeUndefined()
    expect(ctx._logs.some((l: string) => l.includes('warn:'))).toBe(true)
  })

  it('does not throw when resumeInterrupted throws', async () => {
    const ctx = makeCtx()
    const scan = async () => ({ scanned: 1, interrupted: ['proj/a-1'] })
    const boomResume = async () => { throw new Error('resume failed') }
    await expect(
      runAutoResume(ctx, { findInterrupted: scan as any, resumeInterrupted: boomResume as any })
    ).resolves.toBeUndefined()
    expect(ctx._logs.some((l: string) => l.includes('warn:'))).toBe(true)
  })

  it('calls resumeInterrupted with the scanned ids when interrupted sessions exist', async () => {
    const ctx = makeCtx()
    const scan = async () => ({ scanned: 2, interrupted: ['proj/a-1', 'proj/b-2'] })
    const resumeSpy = vi.fn(async () => {})
    await runAutoResume(ctx, { findInterrupted: scan as any, resumeInterrupted: resumeSpy })
    expect(resumeSpy).toHaveBeenCalledWith(ctx, ['proj/a-1', 'proj/b-2'])
  })

  it('skips resumeInterrupted entirely when nothing is interrupted', async () => {
    const ctx = makeCtx()
    const scan = async () => ({ scanned: 5, interrupted: [] })
    const resumeSpy = vi.fn(async () => {})
    await runAutoResume(ctx, { findInterrupted: scan as any, resumeInterrupted: resumeSpy })
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it('does not throw when opts is null (explicitly passed, not undefined)', async () => {
    const ctx = makeCtx()
    // Passing null instead of undefined to test that property access doesn't escape the try block
    await expect(
      runAutoResume(ctx, null as any)
    ).resolves.toBeUndefined()
    expect(ctx._logs.some((l: string) => l.includes('warn:'))).toBe(true)
  })
})
