import { describe, it, expect, vi } from 'vitest'
import { resumeInterrupted, runAutoResume, apply } from '../src/host/plugin.js'

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

function makeCtxWithEffect(overrides: Record<string, any> = {}) {
  const logs: string[] = []
  const rpcHandlers: { channel: string; opts: any }[] = []
  return {
    logger: { info: (m: string) => logs.push(`info:${m}`), warn: (m: string) => logs.push(`warn:${m}`) },
    effect: (fn: any) => fn(),
    connection: {
      rpc: {
        handle: (channel: string, _handler: any, opts?: any) => {
          rpcHandlers.push({ channel, opts })
          return () => {}
        },
      },
    },
    sessions: { get: () => undefined },
    get: () => undefined,
    _logs: logs,
    _rpcHandlers: rpcHandlers,
    ...overrides,
  }
}

describe('apply', () => {
  it('registers the RPC handler exactly once on the corrected channel name', () => {
    const ctx = makeCtxWithEffect()
    apply(ctx)
    expect(ctx._rpcHandlers).toHaveLength(1)
    expect(ctx._rpcHandlers[0].channel).toBe('/dsh-maestro-supervisor-resume')
    expect(ctx._rpcHandlers[0].channel).toMatch(/^\/[A-Za-z0-9._~-]+$/)
  })

  it('does not throw when ctx.connection.rpc.handle itself throws', () => {
    const ctx = makeCtxWithEffect({
      connection: { rpc: { handle: () => { throw new Error('bad channel') } } },
    })
    expect(() => apply(ctx)).not.toThrow()
  })

  it('does not throw when ctx.connection is missing entirely', () => {
    const ctx = makeCtxWithEffect({ connection: undefined })
    expect(() => apply(ctx)).not.toThrow()
  })

  it('returns a disposer from the effect that clears the timer and unregisters RPC without throwing', () => {
    const ctx = makeCtxWithEffect()
    let disposer: any
    ctx.effect = (fn: any) => { disposer = fn(); return disposer }
    apply(ctx)
    expect(typeof disposer).toBe('function')
    expect(() => disposer()).not.toThrow()
  })

  it('does not throw when ctx.effect itself throws', () => {
    const ctx = makeCtxWithEffect({
      effect: () => { throw new Error('effect boom') },
    })
    expect(() => apply(ctx)).not.toThrow()
  })

  it('does not throw when ctx.effect is missing entirely', () => {
    const ctx = makeCtxWithEffect({ effect: undefined })
    expect(() => apply(ctx)).not.toThrow()
  })

  it('does not throw when ctx.connection.rpc.handle throws AND the logger.warn used to report it also throws', () => {
    const ctx = makeCtxWithEffect({
      connection: { rpc: { handle: () => { throw new Error('bad channel') } } },
      logger: {
        info: () => {},
        warn: () => { throw new Error('logger boom') },
      },
    })
    expect(() => apply(ctx)).not.toThrow()
  })
})
