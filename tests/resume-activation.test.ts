/**
 * Resume activation must compose the session's agent preset.
 *
 * The 2026-09-14 incident: `agents.resume({ resumeSessionId, agentOptions })`
 * publishes an agent joined to no preset, so the resumed session's tool view is
 * the deployment-global layer (76 tools, no bash) and every re-issued tool call
 * fails with `UNKNOWN TOOL`. These specs pin the activation order — the session
 * controller first (the same owner the Web UI uses), then `agents.resume` with a
 * preset-composing `setup` — and that a preset that cannot be composed aborts
 * the session instead of resuming it blind.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resumeInterrupted, resetResumeToolHealthState, snapshotResumeToolHealth } from '../src/host/plugin.js'
import type { ResumeLogEntry } from '../src/host/resume-log.js'

/** Persistence handle that answers with a recoverable provider/model route. */
const ROUTE_PERSISTENCE = {
  open: async () => ({
    read: async () => ([{ type: 'request/context', data: { provider: 'example-provider', model: 'example-model' } }]),
    close: async () => {},
  }),
}

function makeCtx(overrides: Record<string, any> = {}) {
  const logs: string[] = []
  return {
    logger: { info: (m: string) => logs.push(`info:${m}`), warn: (m: string) => logs.push(`warn:${m}`) },
    sessions: { get: () => undefined },
    get: (key: string) => (overrides[key] !== undefined ? overrides[key] : undefined),
    _logs: logs,
    ...overrides,
  }
}

beforeEach(() => resetResumeToolHealthState())

describe('resume activation composes the preset', () => {
  it('prefers sessionController.resolveAgent when the service exists', async () => {
    const followup = vi.fn()
    const resolveAgent = vi.fn(async () => ({ agent: { followup } }))
    const resume = vi.fn()
    const ctx = makeCtx({
      sessionController: { resolveAgent },
      agents: { get: () => undefined, resume },
      agentPresets: { composedPreset: () => 'cordis', mount: vi.fn() },
    })

    await expect(resumeInterrupted(ctx, ['proj/s1'], { logResume: () => {} })).resolves.toEqual(['proj/s1'])
    expect(resolveAgent).toHaveBeenCalledWith('s1')
    expect(resume).not.toHaveBeenCalled()
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('falls back to agents.resume with a preset-composing setup', async () => {
    const followup = vi.fn()
    const mount = vi.fn(async () => ({}))
    const resume = vi.fn(async (options: any) => {
      expect(typeof options.setup).toBe('function')
      await options.setup({ scopeKey: 'agent-ctx' }, { id: 's1' })
      return { agent: { followup } }
    })
    const ctx = makeCtx({
      sessionPersistence: ROUTE_PERSISTENCE,
      agents: { get: () => undefined, resume },
      agentPresets: { mount, composedPreset: () => 'cordis' },
      sessionQuery: { observeSession: async () => ({ header: { agentPreset: 'cordis' } }) },
    })

    await expect(resumeInterrupted(ctx, ['proj/s1'], {
      resumeOwnershipRetryDelaysMs: [],
      logResume: () => {},
    })).resolves.toEqual(['proj/s1'])
    expect(mount).toHaveBeenCalledWith({ scopeKey: 'agent-ctx' }, 'cordis')
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('aborts the session when the preset cannot be mounted', async () => {
    const followup = vi.fn()
    const entries: ResumeLogEntry[] = []
    const resume = vi.fn(async (options: any) => {
      await options.setup({}, { id: 's1' })
      return { agent: { followup } }
    })
    const ctx = makeCtx({
      sessionPersistence: ROUTE_PERSISTENCE,
      agents: { get: () => undefined, resume },
      agentPresets: { mount: async () => { throw new Error('unknown preset "gone"') }, composedPreset: () => undefined },
      sessionQuery: { observeSession: async () => ({ header: { agentPreset: 'gone' } }) },
    })

    await expect(resumeInterrupted(ctx, ['proj/s1'], {
      resumeOwnershipRetryDelaysMs: [],
      logResume: (entry) => entries.push(entry),
    })).resolves.toEqual([])
    expect(followup).not.toHaveBeenCalled()
    expect(entries.some((e) => e.kind === 'resume-failed' && String(e.error).includes('preset'))).toBe(true)
    expect(ctx._logs.some((l: string) => l.includes('preset'))).toBe(true)
  })

  it('does not mount anything for a session that records no preset', async () => {
    const followup = vi.fn()
    const mount = vi.fn()
    const resume = vi.fn(async (options: any) => {
      expect(options.setup).toBeUndefined()
      return { agent: { followup } }
    })
    const ctx = makeCtx({
      sessionPersistence: ROUTE_PERSISTENCE,
      agents: { get: () => undefined, resume },
      agentPresets: { mount },
      sessionQuery: { observeSession: async () => ({ header: {} }) },
    })

    await expect(resumeInterrupted(ctx, ['proj/s1'], {
      resumeOwnershipRetryDelaysMs: [],
      logResume: () => {},
    })).resolves.toEqual(['proj/s1'])
    expect(mount).not.toHaveBeenCalled()
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('falls back to the resume path when the session controller throws', async () => {
    const followup = vi.fn()
    const resume = vi.fn(async () => ({ agent: { followup } }))
    const ctx = makeCtx({
      sessionController: { resolveAgent: async () => { throw new Error('controller exploded') } },
      sessionPersistence: ROUTE_PERSISTENCE,
      agents: { get: () => undefined, resume },
      agentPresets: { composedPreset: () => 'cordis' },
      sessionQuery: { observeSession: async () => ({ header: { agentPreset: 'cordis' } }) },
    })

    await expect(resumeInterrupted(ctx, ['proj/s1'], {
      resumeOwnershipRetryDelaysMs: [],
      logResume: () => {},
    })).resolves.toEqual(['proj/s1'])
    expect(resume).toHaveBeenCalledTimes(1)
    expect(followup).toHaveBeenCalledTimes(1)
  })
})

describe('resume verifies composition and repairs a preset-less agent', () => {
  it('recomposes a preset-less agent before delivering the recovery prompt', async () => {
    const order: string[] = []
    let composed: string | undefined
    const recompose = vi.fn(async (agentCtx: unknown, id: string) => { composed = id; order.push('recompose'); return { id } })
    const followup = vi.fn(() => { order.push('followup') })
    const ctx = makeCtx({
      agents: { get: () => ({ ctx: { agentCtx: true }, followup }) },
      agentPresets: { composedPreset: () => composed, recompose, mount: vi.fn() },
      sessionQuery: { observeSession: async () => ({ header: { agentPreset: 'cordis' } }) },
    })

    await expect(resumeInterrupted(ctx, ['proj/s1'], { logResume: () => {} })).resolves.toEqual(['proj/s1'])
    expect(recompose).toHaveBeenCalledWith({ agentCtx: true }, 'cordis')
    expect(order).toEqual(['recompose', 'followup'])
  })

  it('leaves an already composed agent untouched', async () => {
    const recompose = vi.fn()
    const followup = vi.fn()
    const ctx = makeCtx({
      agents: { get: () => ({ ctx: {}, followup }) },
      agentPresets: { composedPreset: () => 'cordis', recompose },
    })

    await expect(resumeInterrupted(ctx, ['proj/s1'], { logResume: () => {} })).resolves.toEqual(['proj/s1'])
    expect(recompose).not.toHaveBeenCalled()
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('notifies and parks when the repair fails, and still delivers the prompt', async () => {
    const notify = vi.fn(async () => {})
    const followup = vi.fn()
    const ctx = makeCtx({
      agents: { get: () => ({ ctx: {}, followup }) },
      agentPresets: {
        composedPreset: () => undefined,
        recompose: async () => { throw new Error('unknown preset') },
        mount: vi.fn(),
      },
      sessionQuery: { observeSession: async () => ({ header: { agentPreset: 'gone' } }) },
    })

    await expect(resumeInterrupted(ctx, ['proj/s1'], {
      notify,
      logResume: () => {},
      config: { resumeCoreToolPolicy: 'park' },
    })).resolves.toEqual(['proj/s1'])
    expect(followup).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls.some(([line]) => line.includes('NOT joined to an agent preset'))).toBe(true)
    expect(snapshotResumeToolHealth(ctx).parked).toEqual(['s1'])
  })

  it('does not repair when resumeAutoRepair is disabled, but still reports the loss', async () => {
    const notify = vi.fn(async () => {})
    const recompose = vi.fn()
    const followup = vi.fn()
    const ctx = makeCtx({
      agents: { get: () => ({ ctx: {}, followup }) },
      agentPresets: { composedPreset: () => undefined, recompose },
    })

    await expect(resumeInterrupted(ctx, ['proj/s1'], {
      notify,
      logResume: () => {},
      config: { resumeAutoRepair: false },
    })).resolves.toEqual(['proj/s1'])
    expect(recompose).not.toHaveBeenCalled()
    expect(notify.mock.calls.some(([line]) => line.includes('NOT joined to an agent preset'))).toBe(true)
  })

  it('notifies when a repair succeeded so the operator knows the session was recovered', async () => {
    const notify = vi.fn(async () => {})
    let composed: string | undefined
    const ctx = makeCtx({
      agents: { get: () => ({ ctx: {}, followup: vi.fn() }) },
      agentPresets: {
        composedPreset: () => composed,
        recompose: async () => { composed = 'cordis'; return {} },
      },
      sessionQuery: { observeSession: async () => ({ header: { agentPreset: 'cordis' } }) },
    })

    await resumeInterrupted(ctx, ['proj/s1'], { notify, logResume: () => {} })
    expect(notify.mock.calls.some(([line]) => line.includes('repaired'))).toBe(true)
  })
})
