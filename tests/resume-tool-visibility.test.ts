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
import { describe, it, expect, vi } from 'vitest'
import {
  resumeInterrupted,
  createResumeRpcHandler,
  probeToolView,
  CRITICAL_TOOLS,
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

    const resumed = await resumeInterrupted(ctx, ['proj/session-resumed-1'])
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

    const handler = createResumeRpcHandler(ctx)
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
