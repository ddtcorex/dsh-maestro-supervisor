/**
 * Agent-preset composition for resumed sessions.
 *
 * `agents.resume()` composes an agent's scoped world ONLY through
 * `ResumeAgentOptions.setup`; without it the agent is published joined to no
 * preset and its tool view collapses to the deployment-global layer (2026-09-14
 * incident). This module owns the three facts the supervisor needs: which preset
 * a session records, how to compose it on a fresh agent context, and whether a
 * live agent is actually joined to one — the roster's own answer
 * (`agentPresets.composedPreset`), never a tool count.
 * @module @ddtcorex/dsh-maestro-supervisor/preset
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execSync } from 'node:child_process'
import { resolveSessionLogPath } from './resume.js'

/** Injectable seams for the preset readers/composers; every one is optional. */
export interface PresetDeps {
  /** Read the preset id a session records. Default: projection → persisted header → raw log. */
  readPresetId?: (sessionId: string) => Promise<string | undefined>
  /** Compose a preset on one agent context. Default: `agentPresets.mount`. */
  mount?: (agentCtx: unknown, presetId: string) => Promise<unknown>
  /** Re-link one agent context to a preset. Default: `agentPresets.recompose`. */
  recompose?: (agentCtx: unknown, presetId: string) => Promise<unknown>
}

/**
 * The preset a live agent is joined to, or undefined when it joined none.
 *
 * This is the authoritative composition fact: the roster records the binding it
 * made for each agent scope.
 * @param ctx - plugin context providing the optional `agentPresets` service.
 * @param agent - the live agent (its `ctx` carries the scope the roster keys by).
 * @returns the composed preset id, or undefined when there is none.
 */
export function composedPresetId(ctx: any, agent: any): string | undefined {
  try {
    const presets = ctx?.get?.('agentPresets') ?? ctx?.agentPresets
    const agentCtx = agent?.ctx
    if (typeof presets?.composedPreset !== 'function' || agentCtx === undefined) return undefined
    const id = presets.composedPreset(agentCtx)
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch {
    /* an unreadable roster is "not composed", which the caller verifies and repairs */
    return undefined
  }
}

/**
 * The preset id a session records, in authority order: the attached session's
 * `agentPreset` projection, the persisted session header, then the raw log's
 * first line. A session that records none is a legitimately bare agent (created
 * by ACP/headless), so undefined is a valid answer rather than an error.
 * @param ctx - plugin context providing the optional session services.
 * @param sessionId - the session whose preset is being resolved.
 * @returns the recorded preset id, or undefined when the session records none.
 */
export async function resolveSessionPresetId(ctx: any, sessionId: string): Promise<string | undefined> {
  try {
    const sessions = ctx?.get?.('sessions') ?? ctx?.sessions
    const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    if (session !== undefined) {
      const projections = ctx?.get?.('sessionProjections') ?? ctx?.sessionProjections
      const id = typeof projections?.stateOf === 'function' ? projections.stateOf(session, 'agentPreset') : undefined
      if (typeof id === 'string' && id.length > 0) return id
    }
  } catch {}
  try {
    const query = ctx?.get?.('sessionQuery') ?? ctx?.sessionQuery
    if (typeof query?.observeSession === 'function') {
      const observation = await query.observeSession(sessionId)
      const id = observation?.header?.agentPreset
      if (typeof id === 'string' && id.length > 0) return id
    }
  } catch {}
  return readPresetIdFromRawLog(sessionId)
}

/**
 * Read the preset out of a session's raw log. The first line is the `type:
 * "session"` header, which carries the creation-time `agentPreset` even when no
 * service can open the session. Root resolution mirrors the session-health scan
 * (`SESSIONS_ROOT`, else `DSH_HOME/sessions`).
 */
function readPresetIdFromRawLog(sessionId: string): string | undefined {
  const root = process.env.SESSIONS_ROOT
    || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
  try {
    for (const group of fs.readdirSync(root, { withFileTypes: true })) {
      if (!group.isDirectory()) continue
      const logPath = resolveSessionLogPath(path.join(root, group.name, sessionId))
      if (logPath === undefined) continue
      const line = logPath.endsWith('.zstd')
        ? execSync(`zstd -d -c ${JSON.stringify(logPath)} 2>/dev/null | head -1`, { encoding: 'utf-8' })
        : fs.readFileSync(logPath, 'utf-8').split('\n')[0] ?? ''
      const id = JSON.parse(line)?.agentPreset
      if (typeof id === 'string' && id.length > 0) return id
    }
  } catch {}
  return undefined
}

/**
 * Build the `setup` callback that joins an agent to its preset. The factory
 * awaits it before publishing the agent, so the first request already carries
 * the preset's tools. Without the roster service this degrades to "no
 * composition" — the caller verifies the result and repairs rather than
 * resuming blind.
 * @param ctx - plugin context providing the optional `agentPresets` service.
 * @param presetId - the preset the session records.
 * @param deps - optional seams; `mount` overrides the roster call.
 * @returns the setup callback handed to `agents.resume`.
 */
export function makePresetSetup(
  ctx: any,
  presetId: string,
  deps: PresetDeps = {},
): (agentCtx: unknown, agent?: unknown) => Promise<void> {
  const mount = deps.mount ?? ((agentCtx: unknown, agent: unknown) => {
    void agent
    const presets = ctx?.get?.('agentPresets') ?? ctx?.agentPresets
    if (typeof presets?.mount !== 'function') return Promise.resolve(undefined)
    return presets.mount(agentCtx, presetId)
  })
  return async (agentCtx: unknown, agent?: unknown) => { await mount(agentCtx, presetId) }
}

/** Outcome of one repair attempt; `reason` is the operator-facing classification. */
export interface RepairOutcome {
  repaired: boolean
  presetId?: string
  reason: 'repaired' | 'already-composed' | 'no-preset-recorded' | 'no-live-agent' | 'recompose-failed'
  composedAfter?: string
}

/**
 * Re-link a live agent that joined no preset.
 *
 * `recompose` on an agent whose binding is absent IS its first bind, so this is
 * a mount in effect: it emits `tools/change`, and the next request records
 * `request/header reason=change` with the restored tool set. Never throws — a
 * failure is reported in the outcome so the caller can notify and park.
 * @param ctx - plugin context providing `agents` and `agentPresets`.
 * @param sessionId - the session whose live agent is repaired.
 * @param deps - optional seams for tests.
 * @returns the repair outcome.
 */
export async function repairAgentPreset(ctx: any, sessionId: string, deps: PresetDeps = {}): Promise<RepairOutcome> {
  try {
    const agents = ctx?.get?.('agents') ?? ctx?.agents
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    if (agent === undefined) return { repaired: false, reason: 'no-live-agent' }
    const current = composedPresetId(ctx, agent)
    if (current !== undefined) return { repaired: false, reason: 'already-composed', composedAfter: current }
    const presetId = deps.readPresetId !== undefined ? await deps.readPresetId(sessionId) : await resolveSessionPresetId(ctx, sessionId)
    if (presetId === undefined) return { repaired: false, reason: 'no-preset-recorded' }
    const recompose = deps.recompose ?? ((agentCtx: unknown, id: string) => {
      const presets = ctx?.get?.('agentPresets') ?? ctx?.agentPresets
      if (typeof presets?.recompose !== 'function') throw new Error('agentPresets.recompose is unavailable')
      return presets.recompose(agentCtx, id)
    })
    await recompose(agent.ctx, presetId)
    return { repaired: true, presetId, reason: 'repaired', composedAfter: composedPresetId(ctx, agent) }
  } catch {
    return { repaired: false, reason: 'recompose-failed' }
  }
}
