/**
 * Tool-view observability for resumed sessions.
 *
 * A probe answers two separate questions: WHICH critical tools a scope resolves,
 * and WHETHER the registry could be read at all. Conflating them produced a
 * false "nothing missing" report for a session that had lost every preset tool
 * (2026-09-14), so `registry: 'unreachable'` is part of the result rather than
 * an empty list. Composition questions are answered by the preset roster
 * (`agentPresets.composedPreset`), never by a tool count.
 * @module @ddtcorex/dsh-maestro-supervisor/tool-view
 */

/** Core tools a resumed session must resolve; the probe reports each one it does not. */
export const CRITICAL_TOOLS = ['bash'] as const

/** Minimal ToolRegistry surface the probe reads. */
export interface ToolsLike {
  get?(name: string, scope?: unknown): unknown
  schemas?(scope?: unknown): unknown
}

/**
 * Caller-visible result of one tool-view probe.
 * `registry: 'unreachable'` means the probe could not read the registry — it is
 * never evidence that nothing is missing.
 */
export interface ToolViewProbe {
  missing: string[]
  visible: number
  /** Whether the registry could be read at all. */
  registry: 'reachable' | 'unreachable'
}

export type ToolViewProbeFn = (
  tools: ToolsLike | undefined,
  scope: unknown,
  logger?: { info?: (msg: string) => void },
) => ToolViewProbe

export type ToolScopeResolver = (ctx: any, sessionId: string) => unknown

/**
 * Default scope: the live agent's own scope, else the session id. The agent
 * object is the registry's scope key — `assembleContextFor(agent)` passes it the
 * same way — so asking with it asks the registry what a request would.
 * @param ctx - plugin context providing the optional `agents` service.
 * @param sessionId - the session whose tool view is being observed.
 * @returns the scope value to hand to the registry.
 */
export const defaultResolveToolScope: ToolScopeResolver = (ctx, sessionId) => {
  try {
    const agents = ctx?.get?.('agents') ?? ctx?.agents
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    if (agent !== undefined) return agent
  } catch {}
  return sessionId
}

/**
 * Snapshot one scope's tool view.
 *
 * A registry that cannot be read (no `get`, or a `schemas` that throws) returns
 * `registry: 'unreachable'` with an empty `missing` list; callers MUST branch on
 * `registry` before reading that as health.
 * @param tools - the harness ToolRegistry service, or undefined when unavailable.
 * @param scope - the scope to read (an Agent, or a session id for the legacy path).
 * @param logger - optional ctx logger; the probe journals its observation when present.
 * @returns the probe result, including whether the registry answered.
 */
export function probeToolView(
  tools: ToolsLike | undefined,
  scope: unknown,
  logger?: { info?: (msg: string) => void },
): ToolViewProbe {
  const probe: ToolViewProbe = { missing: [], visible: 0, registry: 'unreachable' }
  try {
    const get = tools?.get
    if (typeof get !== 'function') return probe
    const schemas = tools?.schemas?.(scope)
    if (!Array.isArray(schemas)) return probe
    probe.registry = 'reachable'
    probe.visible = schemas.length
    probe.missing = [...CRITICAL_TOOLS].filter((name) => get(name, scope) === undefined)
  } catch {}
  try {
    logger?.info?.(`[supervisor] resumed ${String(scope)}: ${summarizeToolView(probe)}`)
  } catch {}
  return probe
}

/**
 * One-line rendering of a probe for journals, notifications and tool output.
 * @param probe - the probe to render.
 * @returns `missing=<names|none> visible=<n> registry=<reachable|unreachable>`.
 */
export function summarizeToolView(probe: ToolViewProbe): string {
  return `missing=${probe.missing.join(',') || 'none'} visible=${probe.visible} registry=${probe.registry}`
}
