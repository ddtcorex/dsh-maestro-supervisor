/**
 * C1 — post-resume tool-view observability probe.
 *
 * After a dsh web restart + auto-resume, a resumed session sometimes loses
 * core tools (`Error: unknown tool "bash"`, and `cordis_inspect_query`) while
 * plugin tools keep working. These tests pin the probe that makes that loss
 * caller-visible: it reads the resumed session's SCOPED tool view right after
 * the recovery followup and logs `bash=true/false`, the visible tool count and
 * the missing critical names.
 *
 * The stubs deliberately model the exact split C1 targets — the host layer
 * keeps bash registered (so the existing readiness poll passes instantly) while
 * the resumed session's per-session scoped view may or may not still expose it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  resumeInterrupted,
  createResumeRpcHandler,
  probeToolView,
  CRITICAL_TOOLS,
  warnCoreToolLoss,
  resetResumeToolHealthState,
  snapshotResumeToolHealth,
  createResumeToolHealthRpcHandler,
  buildToolInventoryMessage,
  type ToolsLike,
} from '../src/host/plugin.js'

function makeCtx(overrides: Record<string, any> = {}) {
  const logs: string[] = []
  return {
    logger: {
      info: (msg: string) => logs.push(`info:${msg}`),
      warn: (msg: string) => logs.push(`warn:${msg}`),
    },
    get: (key: string) => (overrides[key] !== undefined ? overrides[key] : undefined),
    _logs: logs,
    ...overrides,
  }
}

/**
 * ToolsLike stub that separates the global (host) view from the per-session
 * scoped view: the global view always has every tool (the readiness poll in
 * resumeInterrupted sees bash immediately), while the scoped view reflects the
 * session's actual surface — exactly what the probe must observe.
 */
function scopedTools(scopeTools: Record<string, unknown>): ToolsLike & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = []
  return {
    calls,
    get: (name: string, scope?: unknown) => {
      calls.push([name, scope])
      if (scope === undefined) return { name } // global view always has the tool
      return scopeTools[name]
    },
    schemas: (scope?: unknown) =>
      Object.keys(scope === undefined ? { bash: {}, read: {} } : scopeTools).map((name) => ({ name })),
  }
}

describe('C1 — resumed-session tool-view probe', () => {
  it('flags bash as missing when the resumed session scope hides it', async () => {
    const followup = vi.fn()
    const tools = scopedTools({ read: {} }) // session scope: no bash
    const ctx = makeCtx({ agents: { get: () => ({ followup }) }, tools })

    const resumed = await resumeInterrupted(ctx, ['proj/session-resumed-1'], {
      // C2 mitigation fires on this loss case — keep the test hermetic by
      // injecting the notify/message seams (defaults would hit the real
      // notifier + session push).
      notify: vi.fn(async () => {}),
      injectSessionMessage: vi.fn(),
    })
    expect(resumed).toEqual(['proj/session-resumed-1'])

    // Caller-visible probe result: missing bash in the resumed session's view.
    const probe = probeToolView(tools, 'session-resumed-1')
    expect(probe.missing).toEqual(['bash'])
    expect(probe.visible).toBe(1)

    // Journal log line pins the flip: bash=false, visible count, missing=bash.
    const line = ctx._logs.find((l: string) => l.startsWith('info:[supervisor] resumed ')) as string
    expect(line).toContain('session-resumed-1: bash=false')
    expect(line).toContain('visibleTools=1')
    expect(line).toContain('missing=bash')

    // The probe read the SCOPED view (session id), not just the global registry.
    expect(tools.calls.some(([name, scope]) => name === 'bash' && scope === 'session-resumed-1')).toBe(true)
  })

  it('reports no missing core tools when the resumed session scope keeps bash', async () => {
    const followup = vi.fn()
    const tools = scopedTools({ bash: {}, read: {} })
    const ctx = makeCtx({ agents: { get: () => ({ followup }) }, tools })

    const resumed = await resumeInterrupted(ctx, ['proj/session-resumed-2'])
    expect(resumed).toEqual(['proj/session-resumed-2'])

    expect(probeToolView(tools, 'session-resumed-2').missing).toEqual([])
    const line = ctx._logs.find((l: string) => l.startsWith('info:[supervisor] resumed ')) as string
    expect(line).toContain('session-resumed-2: bash=true')
    expect(line).toContain('missing=none')
  })

  it('skips the probe (missing []) when ctx.tools is absent', async () => {
    const followup = vi.fn()
    const ctx = makeCtx({ agents: { get: () => ({ followup }) } }) // no tools service

    const resumed = await resumeInterrupted(ctx, ['proj/session-resumed-3'])
    expect(resumed).toEqual(['proj/session-resumed-3'])
    expect(ctx._logs.some((l: string) => l.includes('resumed session-resumed-3'))).toBe(false)
  })

  it('uses an injected probeToolView and scope resolver through deps', async () => {
    const followup = vi.fn()
    const tools = scopedTools({ bash: {} })
    const injectedProbe = vi.fn(() => ({ missing: [] as string[], visible: 0 }))
    const resolveScope = (_ctx: any, id: string) => `agent:${id}`
    const ctx = makeCtx({ agents: { get: () => ({ followup }) }, tools })

    const resumed = await resumeInterrupted(ctx, ['proj/session-resumed-4'], {
      probeToolView: injectedProbe,
      resolveToolScope: resolveScope,
    })
    expect(resumed).toEqual(['proj/session-resumed-4'])
    expect(injectedProbe).toHaveBeenCalledTimes(1)
    expect(injectedProbe.mock.calls[0][1]).toBe('agent:session-resumed-4')
  })

  it('exposes the probe through the loopback resume RPC path', async () => {
    const followup = vi.fn()
    const tools = scopedTools({ read: {} }) // session scope: no bash
    const ctx = makeCtx({ agents: { get: () => ({ followup }) }, tools })

    const handler = createResumeRpcHandler(ctx, { notify: vi.fn(async () => {}), injectSessionMessage: vi.fn() })
    const res = await handler('resume', { ids: ['proj/session-resumed-5'] }, new AbortController().signal)
    expect(res).toEqual({ ok: true, value: { resumed: ['proj/session-resumed-5'] } })
    expect(ctx._logs.some((l: string) => l.includes('bash=false') && l.includes('missing=bash'))).toBe(true)
  })

  it('probeToolView returns empty missing when the tools service is absent or lacks get', () => {
    expect(probeToolView(undefined, 'session-x')).toEqual({ missing: [], visible: 0 })
    expect(probeToolView({ schemas: () => [] } as unknown as ToolsLike, 'session-x')).toEqual({
      missing: [],
      visible: 0,
    })
  })

  it('pins bash in CRITICAL_TOOLS (the Part C loss target)', () => {
    expect(CRITICAL_TOOLS).toContain('bash')
  })
})

describe('C2 — resumed-session core-tool-loss mitigation', () => {
  beforeEach(() => {
    // Module-level mitigation state (parked set + lastResumeProbe) is shared
    // across tests in this file — reset so each spec starts clean.
    resetResumeToolHealthState()
  })

  it('warn policy: notifies once with [bash], injects tool-inventory message, records nothing parked', async () => {
    const notify = vi.fn(async () => {})
    const injected: { sessionId: string; content: string }[] = []
    const injectSessionMessage = vi.fn((sessionId: string, content: string) => { injected.push({ sessionId, content }) })
    const followup = vi.fn()
    const tools = scopedTools({ read: {} }) // resumed scope hides bash; only 'read' is available
    const ctx = makeCtx({ agents: { get: () => ({ followup }) }, tools })

    const resumed = await resumeInterrupted(ctx, ['proj/session-core-1'], { notify, injectSessionMessage })
    expect(resumed).toEqual(['proj/session-core-1'])

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain('[bash]')
    expect(notify.mock.calls[0][0]).toContain('reopen session if it persists')
    expect(notify.mock.calls[0][0]).not.toContain('manual reopen required')

    expect(injectSessionMessage).toHaveBeenCalledTimes(1)
    expect(injected[0].sessionId).toBe('session-core-1')
    expect(injected[0].content).toContain('bash tool is unavailable')
    expect(injected[0].content).toContain('Available tools: read')
    expect(injected[0].content).toContain('Do not call bash')

    // warn policy: no parking, but the real observation is recorded.
    const health = snapshotResumeToolHealth(ctx)
    expect(health.parked).toEqual([])
    expect(health.lastResumeProbe).toEqual({ missing: ['bash'], visible: 1 })
  })

  it('park policy: notifies with manual-reopen marker and records the id in parked', async () => {
    const notify = vi.fn(async () => {})
    const injectSessionMessage = vi.fn()
    const followup = vi.fn()
    const tools = scopedTools({ read: {} })
    const ctx = makeCtx({ agents: { get: () => ({ followup }) }, tools })

    const resumed = await resumeInterrupted(ctx, ['proj/session-core-2'], {
      notify,
      injectSessionMessage,
      config: { resumeCoreToolPolicy: 'park' },
    })
    expect(resumed).toEqual(['proj/session-core-2'])

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain('[bash]')
    expect(notify.mock.calls[0][0]).toContain('manual reopen required')

    const health = snapshotResumeToolHealth(ctx)
    expect(health.parked).toEqual(['session-core-2'])
  })

  it('no missing core tools -> no notify and no session message', async () => {
    const notify = vi.fn(async () => {})
    const injectSessionMessage = vi.fn()
    const followup = vi.fn()
    const tools = scopedTools({ bash: {}, read: {} })
    const ctx = makeCtx({ agents: { get: () => ({ followup }) }, tools })

    const resumed = await resumeInterrupted(ctx, ['proj/session-core-3'], { notify, injectSessionMessage })
    expect(resumed).toEqual(['proj/session-core-3'])
    expect(notify).not.toHaveBeenCalled()
    expect(injectSessionMessage).not.toHaveBeenCalled()
  })

  it('maestro_resume_tool_health RPC returns lastResumeProbe + parked (probe stubbed by scoped tools)', async () => {
    const notify = vi.fn(async () => {})
    const injectSessionMessage = vi.fn()
    const followup = vi.fn()
    const tools = scopedTools({ read: {} })
    const ctx = makeCtx({ agents: { get: () => ({ followup }) }, tools })

    await resumeInterrupted(ctx, ['proj/session-core-4'], {
      notify,
      injectSessionMessage,
      config: { resumeCoreToolPolicy: 'park' },
    })

    const handler = createResumeToolHealthRpcHandler(ctx)
    const res = await handler('health', {}, new AbortController().signal)
    expect(res).toEqual({
      ok: true,
      value: { lastResumeProbe: { missing: ['bash'], visible: 1 }, parked: ['session-core-4'] },
    })
  })

  it('warnCoreToolLoss is a no-op when bash is not among the missing tools', async () => {
    const notify = vi.fn(async () => {})
    const injectSessionMessage = vi.fn()
    const followup = vi.fn()
    const tools = scopedTools({ bash: {}, read: {} })
    const ctx = makeCtx({ agents: { get: () => ({ followup }) }, tools })

    await warnCoreToolLoss(ctx, 'session-core-5', 'session-core-5', { missing: ['cordis_inspect_query'], visible: 2 }, 'warn', {
      notify,
      injectSessionMessage,
      tools,
    })
    expect(notify).not.toHaveBeenCalled()
    expect(injectSessionMessage).not.toHaveBeenCalled()
  })

  it('buildToolInventoryMessage joins the available tools into the System: inventory line', () => {
    const msg = buildToolInventoryMessage(['bash'], ['read', 'write'])
    expect(msg).toContain('bash tool is unavailable')
    expect(msg).toContain('Available tools: read, write')
    expect(msg).toContain('Do not call bash')
  })
})
