/**
 * dsh-maestro-supervisor — host plugin for auto-resume inside DSH web.
 * Runs inside the DSH host process (outside the daemon's tree) and
 * auto-resumes sessions interrupted within the configured window after
 * a restart. The standalone daemon (systemd) handles crash detection
 * and web restart; this plugin handles the in-process resume.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { findInterrupted as defaultFindInterrupted, findDanglingOpenTurns as defaultFindDanglingOpenTurns } from './resume.js'
import { readIntent, consumeIntent } from './intents.js'
import type { RestartIntent } from './intents.js'
import { appendResumeLog, type ResumeLogEntry } from './resume-log.js'
import { makeSkillProvider } from './skill-provider.js'
import { registerRestartTool } from './restart-tool.js'
import { makePreExecuteGuard } from './self-kill-guard.js'
import { runSessionHealthCheck } from './session-health.js'
import {
  warnCoreToolLoss,
  recordResumedSession,
  recordResumeProbe,
  registerResumeToolHealthService,
} from './resume-tools.js'
export * from './resume-tools.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const inject = ['sessions', 'agents', 'connection', 'tools', 'skills'] as const

export interface SupervisorPluginConfig {
  autoResumeWithin?: number | string // in MINUTES if number, or "5m"/"30s"/"1h" string
  autoResumeEnabled?: boolean
  sessionLogRoot?: string // session-log dir for the session-health scan (env SESSIONS_ROOT wins)
  resumeCoreToolPolicy?: ResumeCoreToolPolicy // C2 — see type below
}

/**
 * C2 — mitigation policy when a resumed session's post-resume probe (C1)
 * reports a core tool (bash) missing from its SCOPED tool view:
 *  - 'warn': notify the operator once + inject a "System:" inventory message
 *    into the session telling the model which tools it CAN still call
 *    (default — the loss is real, but the session may still be usable).
 *  - 'park': additionally record the session id in the park set (exposed via
 *    maestro_resume_tool_health / /dsh-maestro-supervisor-resume-tool-health)
 *    and flag the notify with "(manual reopen required)" — the operator must
 *    reopen the session fresh because the core-tool surface is not guaranteed.
 */
export type ResumeCoreToolPolicy = 'warn' | 'park'

function parseDuration(s: string): number | undefined {
  if (!s) return undefined
  const m = s.trim().match(/^(\d+)(s|m|h)?$/)
  if (!m) return undefined
  const n = parseInt(m[1], 10)
  const unit = m[2] ?? 's'
  if (unit === 's') return n * 1000
  if (unit === 'm') return n * 60 * 1000
  if (unit === 'h') return n * 60 * 60 * 1000
  return undefined
}

function getAutoResumeEnabled(config?: SupervisorPluginConfig): boolean {
  // The Cordis-supplied config (cordis.patch.yml's `config:` block, or whatever
  // the caller passes to apply()) is the highest-precedence source — it is an
  // explicit, per-install decision and must win over ambient env/files.
  if (typeof config?.autoResumeEnabled === 'boolean') return config.autoResumeEnabled
  const env = process.env.DSH_SUPERVISOR_AUTO_RESUME
  if (env !== undefined) {
    const v = env.trim().toLowerCase()
    if (['1','true','yes','on','enabled'].includes(v)) return true
    if (['0','false','no','off','disabled'].includes(v)) return false
  }
  try {
    const cfgPath = path.join(os.homedir(), '.dsh/.supervisor/config.json')
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
      const raw = (cfg as any).autoResumeEnabled ?? (cfg as any).autoResume
      if (typeof raw === 'boolean') return raw
      if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase()
        if (['1','true','yes','on'].includes(v)) return true
        if (['0','false','no','off'].includes(v)) return false
      }
    }
    const maestroPath = path.join(os.homedir(), '.dsh/maestro/settings.json')
    if (fs.existsSync(maestroPath)) {
      const j = JSON.parse(fs.readFileSync(maestroPath, 'utf-8'))
      const raw = j?.domains?.supervisor?.autoResumeEnabled ?? j?.supervisor?.autoResumeEnabled
      if (typeof raw === 'boolean') return raw
      if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase()
        if (['1','true','yes','on'].includes(v)) return true
        if (['0','false','no','off'].includes(v)) return false
      }
    }
  } catch {}
  return true
}

/**
 * C2 — resolve the mitigation policy with exactly the same precedence chain as
 * getAutoResumeEnabled: (1) the Cordis-supplied plugin config (cordis.patch.yml
 * `config:` block / whatever apply() receives — highest precedence), (2) env
 * DSH_SUPERVISOR_RESUME_CORE_TOOL_POLICY, (3) ~/.dsh/.supervisor/config.json,
 * (4) ~/.dsh/maestro/settings.json (domains.supervisor.resumeCoreToolPolicy),
 * (5) 'warn'. Any other value falls through to the default 'warn'.
 */
function getResumeCoreToolPolicy(config?: SupervisorPluginConfig): ResumeCoreToolPolicy {
  if (config?.resumeCoreToolPolicy === 'warn' || config?.resumeCoreToolPolicy === 'park') {
    return config.resumeCoreToolPolicy
  }
  const env = process.env.DSH_SUPERVISOR_RESUME_CORE_TOOL_POLICY
  if (env) {
    const v = env.trim().toLowerCase()
    if (v === 'warn' || v === 'park') return v
  }
  try {
    const cfgPath = path.join(os.homedir(), '.dsh/.supervisor/config.json')
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
      const raw = (cfg as any).resumeCoreToolPolicy
      if (raw === 'warn' || raw === 'park') return raw
    }
    const maestroPath = path.join(os.homedir(), '.dsh/maestro/settings.json')
    if (fs.existsSync(maestroPath)) {
      const j = JSON.parse(fs.readFileSync(maestroPath, 'utf-8'))
      const raw = j?.domains?.supervisor?.resumeCoreToolPolicy ?? j?.supervisor?.resumeCoreToolPolicy
      if (raw === 'warn' || raw === 'park') return raw
    }
  } catch {}
  return 'warn'
}

function getResumeWithinMs(config?: SupervisorPluginConfig): number {
  // Same precedence rule as getAutoResumeEnabled: explicit config wins first.
  if (config?.autoResumeWithin !== undefined) {
    const raw = config.autoResumeWithin
    if (typeof raw === 'number') return raw * 60 * 1000
    if (typeof raw === 'string') {
      if (/^\d+$/.test(raw.trim())) return parseInt(raw.trim(), 10) * 60 * 1000
      const v = parseDuration(raw)
      if (v !== undefined) return v
    }
  }
  const env = process.env.DSH_SUPERVISOR_RESUME_WITHIN
  if (env) {
    if (/^\d+$/.test(env.trim())) return parseInt(env.trim(), 10) * 60 * 1000
    const v = parseDuration(env)
    if (v !== undefined) return v
  }
  try {
    const cfgPath = path.join(os.homedir(), '.dsh/.supervisor/config.json')
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
      const raw = (cfg as any).autoResumeWithin
      if (typeof raw === 'string') {
        if (/^\d+$/.test(raw.trim())) return parseInt(raw.trim(), 10) * 60 * 1000
        const v = parseDuration(raw)
        if (v !== undefined) return v
      } else if (typeof raw === 'number') return raw * 60 * 1000
    }
    const maestroPath = path.join(os.homedir(), '.dsh/maestro/settings.json')
    if (fs.existsSync(maestroPath)) {
      const j = JSON.parse(fs.readFileSync(maestroPath, 'utf-8'))
      const raw = j?.domains?.supervisor?.autoResumeWithin ?? j?.supervisor?.autoResumeWithin
      if (typeof raw === 'string') {
        if (/^\d+$/.test(raw.trim())) return parseInt(raw.trim(), 10) * 60 * 1000
        const v = parseDuration(raw)
        if (v !== undefined) return v
      } else if (typeof raw === 'number') return raw * 60 * 1000
    }
  } catch {}
  return 5 * 60 * 1000
}

/**
 * Core tools that must be visible on a resumed session. Part C targets the
 * post-restart bash loss (`Error: unknown tool "bash"`); extend this list to
 * widen the probe (e.g. 'cordis_inspect_query').
 */
export const CRITICAL_TOOLS = ['bash'] as const

/** Minimal ToolRegistry surface the resume tool-view probe reads. */
export interface ToolsLike {
  get?(name: string, scope?: unknown): unknown
  schemas?(scope?: unknown): { name?: string }[]
}

/** Caller-visible result of the post-resume tool-view probe. */
export interface ToolViewProbe {
  missing: string[]
  visible: number
}

export type ToolViewProbeFn = (
  tools: ToolsLike | undefined,
  scope: string,
  logger?: { info?: (msg: string) => void },
) => ToolViewProbe

export type ToolScopeResolver = (ctx: any, sessionId: string) => string

/** Default: the resumed agent's tool scope is its top-level session id. */
export const defaultResolveToolScope: ToolScopeResolver = (_ctx, sessionId) => sessionId

/**
 * Snapshot one session's visible tool view for the journal: which CRITICAL_TOOLS
 * are missing from the SCOPED registry (not the global view) and how many tools
 * are visible. When the tools service is absent or lacks `get`, the probe is
 * skipped and reports no missing tools. The log line is the Part D trigger —
 * `bash=false` at resume marks the loss the moment it happens.
 * @param tools - the harness ToolRegistry service, or undefined when unavailable.
 * @param scope - the session's tool scope (defaults to the top-level session id).
 * @param logger - optional ctx logger; the probe writes its line when present.
 */
export function probeToolView(
  tools: ToolsLike | undefined,
  scope: string,
  logger?: { info?: (msg: string) => void },
): ToolViewProbe {
  const probe: ToolViewProbe = { missing: [], visible: 0 }
  try {
    const get = tools?.get
    if (typeof get !== 'function') return probe
    probe.missing = [...CRITICAL_TOOLS].filter((name) => get(name, scope) === undefined)
    const schemas = tools?.schemas?.(scope)
    probe.visible = Array.isArray(schemas) ? schemas.length : 0
  } catch {}
  try {
    logger?.info?.(`[supervisor] resumed ${scope}: bash=${!probe.missing.includes('bash')} visibleTools=${probe.visible} missing=${probe.missing.join(',') || 'none'}`)
  } catch {}
  return probe
}

export async function runAutoResume(
  ctx: any,
  opts: {
    findInterrupted?: typeof defaultFindInterrupted
    findDanglingOpenTurns?: typeof defaultFindDanglingOpenTurns
    resumeInterrupted?: typeof resumeInterrupted
    logResume?: (entry: ResumeLogEntry) => void
    config?: SupervisorPluginConfig
  } = {}
): Promise<void> {
  try {
    const doFind = opts.findInterrupted ?? defaultFindInterrupted
    const doFindDangling = opts.findDanglingOpenTurns ?? defaultFindDanglingOpenTurns
    const doResume = opts.resumeInterrupted ?? resumeInterrupted
    const doLog = opts.logResume ?? ((entry: ResumeLogEntry) => { try { appendResumeLog(entry) } catch {} })
    if (!getAutoResumeEnabled(opts?.config)) {
      ctx.logger?.info?.('[supervisor] auto-resume disabled — skip')
      doLog({ ts: Date.now(), kind: 'scan', scanned: 0, interrupted: [], detail: 'auto-resume disabled' })
      return
    }
    const withinMs = getResumeWithinMs(opts?.config)
    const { scanned, interrupted } = await doFind(undefined, { withinMs })
    // Only safe to treat a dangling open turn as crashed right after a fresh
    // boot, when this process is the sole live owner of these sessions —
    // exactly the context runAutoResume runs in (called once, 8s after
    // apply()). resumeInterrupted()'s own "already live" check additionally
    // protects any id that happens to be live in *this* process already.
    let dangling: string[] = []
    try {
      dangling = (await doFindDangling(undefined, { withinMs })).interrupted
    } catch (e: any) {
      ctx.logger?.warn?.(`[supervisor] auto-resume: dangling-open-turn scan failed, continuing with closed-turn results only: ${e?.message ?? String(e)}`)
    }
    const merged = Array.from(new Set([...interrupted, ...dangling]))
    doLog({ ts: Date.now(), kind: 'scan', scanned, interrupted: merged, detail: `withinMs=${withinMs}` })
    if (!merged.length) {
      ctx.logger?.info?.(`[supervisor] auto-resume: 0/${scanned} interrupted within ${withinMs}ms — nothing to do`)
      return
    }
    ctx.logger?.info?.(`[supervisor] auto-resume: ${merged.length}/${scanned} interrupted within ${withinMs}ms: ${merged.slice(0, 3).join(', ')}`)
    await doResume(ctx, merged, {
      ...(opts?.config !== undefined ? { config: opts.config } : {}),
      ...(opts.logResume !== undefined ? { logResume: opts.logResume } : {}),
    })
  } catch (e: any) {
    try {
      ctx.logger?.warn?.(`[supervisor] auto-resume error: ${e?.message ?? String(e)}`)
    } catch {}
  }
}

export async function resumeInterrupted(
  ctx: any,
  ids: string[],
  deps: {
    readIntent?: (id: string) => RestartIntent | undefined
    consumeIntent?: (id: string) => void
    probeToolView?: ToolViewProbeFn
    resolveToolScope?: ToolScopeResolver
    // C2 injectable seams — default to the real notifier + real session push.
    notify?: (line: string) => Promise<void>
    injectSessionMessage?: (sessionId: string, content: string) => unknown
    // Durable out-of-band resume audit trail (default: resume-log.ts sidecar).
    // Injected in tests so failures/resumptions can be asserted without
    // touching ~/.dsh/.supervisor.
    logResume?: (entry: ResumeLogEntry) => void
    config?: SupervisorPluginConfig
  } = {},
): Promise<string[]> {
  const doReadIntent = deps.readIntent ?? readIntent
  const doConsumeIntent = deps.consumeIntent ?? consumeIntent
  const doProbe = deps.probeToolView ?? probeToolView
  const doResolveToolScope = deps.resolveToolScope ?? defaultResolveToolScope
  const doLog = deps.logResume ?? ((entry: ResumeLogEntry) => { try { appendResumeLog(entry) } catch {} })
  const coreToolPolicy = getResumeCoreToolPolicy(deps.config)
  const resumed: string[] = []
  for (const id of ids) {
    try {
      const sessionId = id.split('/').pop()!
      const agents = (ctx.get?.('agents') as any) ?? (ctx as any).agents
      let agent = agents?.get?.(sessionId)
      if (agent === undefined) {
        const { SessionId } = await import('@deepseek-ai/dsh-session' as any).catch(() => ({ SessionId: (s: string) => s as any }))
        const sid = SessionId ? SessionId(sessionId) : sessionId
        const persistence = (ctx.get?.('sessionPersistence') as any) ?? (ctx as any).sessionPersistence
        let agentOptions: { provider: string; model: string } | undefined
        try {
          const loaded = await persistence?.load?.(sessionId)
          const context = Array.isArray(loaded?.events)
            ? [...loaded.events].reverse().find((event: any) => event?.type === 'request/context')?.data
            : undefined
          if (typeof context?.provider === 'string' && typeof context?.model === 'string') {
            agentOptions = { provider: context.provider, model: context.model }
          }
        } catch (e: any) {
          ctx.logger?.warn?.(`[supervisor] auto-resume: could not recover route for ${id}: ${e?.message ?? String(e)}`)
        }
        if (agentOptions === undefined) {
          // Resuming without a provider/model builds an agent whose
          // {{model}} persona variable has no value, so the very next turn
          // fails with `prompt variable "{{model}}" has no value for this
          // assembly (section "deployment:persona")`. Skip corrupt/routeless
          // sessions instead of triggering a continue that can only fail.
          ctx.logger?.warn?.(`[supervisor] auto-resume: skipping ${id} — no provider/model recovered (corrupt or routeless session)`)
          doLog({ ts: Date.now(), sessionId, kind: 'resume-failed', error: 'missing provider/model: persistence has no request/context route — skipping corrupt/routeless session' })
          continue
        }
        const handle = await agents?.resume?.({
          resumeSessionId: sid,
          agentOptions,
        })
        agent = handle?.agent
        if (agent !== undefined) ctx.logger?.info?.(`[supervisor] auto-resume: re-attached agent for ${id}`)
      }
      if (typeof agent?.followup !== 'function') {
        ctx.logger?.warn?.(`[supervisor] auto-resume: no live agent available for ${id}`)
        doLog({ ts: Date.now(), sessionId, kind: 'no-agent', detail: 'agents.resume returned no followup-capable handle' })
        continue
      }
      // Ensure bash tool is registered before followup — initial resume header with
      // only 11 tools (missing bash) broke 36646045... etc. Wait briefly for
      // ctx.tools to populate (preset mount + shell). Best-effort: poll up to 5s.
      try {
        const tools: any = (ctx.get?.('tools') as any) ?? (ctx as any).tools
        const hasBash = () => {
          try {
            if (typeof tools?.get === 'function') return tools.get('bash') !== undefined
            if (typeof tools?.has === 'function') return tools.has('bash')
            if (Array.isArray(tools?.list?.())) return tools.list().some((t: any) => t?.name === 'bash' || t === 'bash')
            // Fallback: check systemPrompt assembly indirectly via tools registry size
            return true
          } catch { return true }
        }
        if (!hasBash()) {
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 500))
            if (hasBash()) break
          }
          if (!hasBash()) ctx.logger?.warn?.(`[supervisor] auto-resume: bash tool still not ready for ${id} — continuing anyway`)
        }
      } catch {}
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm' as any).catch(() => ({
        createUserMessage: (input: any) => ({ ...input, role: 'user', id: crypto.randomUUID() }),
      }))
      // Use an explicit recovery prompt instead of bare "continue" — the synthetic
      // TOOL_OUTCOME_UNKNOWN / TOOL_NOT_STARTED result (repair.ts:104) tells the
      // model to verify external state before retrying. A bare "continue" made
      // the model reply with text instead of re-issuing bash, leaving the
      // session stuck after every crash (36646045..., 31ae53a2...).
      const idleMessage =
        'The previous turn was interrupted by a crash and the harness has synthesized a tool result with TOOL_OUTCOME_UNKNOWN / TOOL_NOT_STARTED. ' +
        'Outcome of the last tool call is unknown — it may or may not have had side effects. ' +
        'Verify external state with bash (e.g., ls, cat, git status) before retrying. ' +
        'Retry only if the operation is read-only or idempotent; if it may have side effects, verify first or ask the user. ' +
        'Then continue the original task from where it was interrupted — re-issue the next bash/tool call that the plan requires.'
      // A session that requested the dsh web restart has a durable intent
      // sidecar (written by dsh_web_restart): resume it with a contextual
      // message instead of the generic "outcome unknown" recovery prompt, then
      // consume the sidecar so it cannot re-trigger on a later resume.
      let resumeMessage = idleMessage
      let intentReason = ''
      try {
        const intent = doReadIntent(sessionId)
        if (intent) {
          intentReason = intent.reason ?? ''
          resumeMessage = `You requested a dsh web restart${intentReason ? ` (reason: ${intentReason})` : ''} and it completed. Do NOT call dsh_web_restart again. Verify current state if needed, then continue the original task.`
        }
      } catch {}
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: resumeMessage }],
        source: { kind: 'user' },
      }))
      try { if (resumeMessage !== idleMessage) doConsumeIntent(sessionId) } catch {}
      resumed.push(id)
      ctx.logger?.info?.(`[supervisor] auto-resume: sent recovery continue for ${id}`)
      doLog({
        ts: Date.now(),
        sessionId,
        kind: 'resumed',
        detail: resumeMessage === idleMessage ? 'idle-recovery-prompt' : `restart-intent:${intentReason.slice(0, 100)}`,
      })
      // C1 observability probe — snapshot the resumed session's SCOPED tool
      // view at the success point so a post-resume bash loss surfaces in the
      // journal the moment it happens (Part D reads this line). Defensive:
      // absent ctx.tools just skips the probe, never fails the resume.
      // C2 mitigation — when the probe reports a CORE tool lost from the
      // resumed session's SCOPED view, notify the operator + inject the tool-
      // inventory System message (park policy additionally parks the id for a
      // manual reopen). Both record the session as "currently resumed" and
      // the probe as the freshest observation for maestro_resume_tool_health.
      try {
        const probeTools = (ctx.get?.('tools') as any) ?? (ctx as any).tools
        const probe = doProbe(probeTools, doResolveToolScope(ctx, sessionId), ctx.logger)
        recordResumedSession(sessionId)
        if (probe.missing.length) {
          await warnCoreToolLoss(ctx, sessionId, doResolveToolScope(ctx, sessionId), probe, coreToolPolicy, {
            notify: deps.notify,
            injectSessionMessage: deps.injectSessionMessage,
          })
        }
        recordResumeProbe(probe)
      } catch {}
    } catch (e: any) {
      ctx.logger?.warn?.(`[supervisor] auto-resume failed ${id}: ${e?.message ?? String(e)}`)
      doLog({ ts: Date.now(), sessionId: String(id).split('/').pop() ?? String(id), kind: 'resume-failed', error: e?.message ?? String(e) })
    }
  }
  return resumed
}

export function createResumeRpcHandler(
  ctx: any,
  opts: {
    resumeInterrupted?: typeof resumeInterrupted
    config?: SupervisorPluginConfig
    notify?: (line: string) => Promise<void>
    injectSessionMessage?: (sessionId: string, content: string) => unknown
  } = {},
) {
  const resume = opts.resumeInterrupted ?? resumeInterrupted
  return async (endpoint: string, payload: unknown, _signal: AbortSignal) => {
    if (endpoint === 'scan') {
      const withinMs = typeof (payload as any)?.withinMs === 'number'
        ? (payload as any).withinMs
        : getResumeWithinMs(opts.config)
      return { ok: true, value: await defaultFindInterrupted(undefined, { withinMs }) }
    }
    if (endpoint !== 'resume') {
      return { ok: false, error: { code: 'bad-request', message: `unsupported endpoint: ${endpoint}` } }
    }
    const ids = Array.isArray((payload as any)?.ids)
      ? (payload as any).ids.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : []
    if (!ids.length) {
      return { ok: false, error: { code: 'bad-request', message: 'resume requires at least one session id' } }
    }
    // Forward the resume-relevant surface (config so resumeCoreToolPolicy
    // resolves, plus the C2 injectable seams). Optional keys keep the deps
    // object minimal — absent opts only yields `{}`.
    const resumeDeps = {
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.notify !== undefined ? { notify: opts.notify } : {}),
      ...(opts.injectSessionMessage !== undefined ? { injectSessionMessage: opts.injectSessionMessage } : {}),
    }
    return { ok: true, value: { resumed: await resume(ctx, ids, resumeDeps) } }
  }
}

/**
 * Session-log root resolution shared with the safe-restart pre-flight script
 * (skills/dsh-safe-restart/scripts/restart-dsh-web.sh): SESSIONS_ROOT wins,
 * else DSH_HOME/sessions, else ~/.dsh/sessions. Kept in lockstep with the
 * shell derivation so the RPC/tool and the pre-flight always scan the same
 * store.
 */
function defaultSessionsRoot(): string {
  if (typeof process.env.SESSIONS_ROOT === 'string' && process.env.SESSIONS_ROOT) return process.env.SESSIONS_ROOT
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
}

/** Extract a non-empty payload.root, else the resolved default session root. */
function resolveHealthRoot(payload: unknown, config?: SupervisorPluginConfig): string {
  const root = (payload as any)?.root
  if (typeof root === 'string' && root) return root
  return config?.sessionLogRoot ?? defaultSessionsRoot()
}

/**
 * Loopback RPC handler for /dsh-maestro-supervisor-session-health. Runs the
 * A1 session-log health check over the resolved root with repair on and
 * quarantine off (mirrors the safe-restart pre-flight — single-frame logs get
 * re-encoded, corrupt logs stay in place and are only counted). Same
 * `{ ok, value | error }` envelope shape as the resume handler.
 */
export function createSessionHealthRpcHandler(
  ctx: any,
  deps: { run?: typeof runSessionHealthCheck; config?: SupervisorPluginConfig } = {},
) {
  const run = deps.run ?? runSessionHealthCheck
  const config = deps.config ?? (ctx as any).config
  return async (_endpoint: string, payload: unknown, _signal: AbortSignal) => {
    try {
      return { ok: true, value: await run(resolveHealthRoot(payload, config), { repair: true, quarantine: false }) }
    } catch (e: any) {
      return { ok: false, error: { code: 'session-health-failed', message: e?.message ?? String(e) } }
    }
  }
}

/** dsh.tools definition for the maestro_session_health host tool. */
function makeSessionHealthToolDef(config: SupervisorPluginConfig) {
  return {
    name: 'maestro_session_health',
    description:
      'Scan session logs under the operator DSH home sessions dir and report unhealthy shapes (single-frame whole logs, corrupt first frames). ' +
      'Single-frame logs are re-encoded into the canonical multi-frame form (with a backup); corrupt logs are only counted unless quarantine is enabled. ' +
      'Safe to run before or after a dsh web restart.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Session-log root to scan; defaults to the configured/operator DSH home sessions dir' },
        repair: { type: 'boolean', description: 'Re-encode single-frame whole logs into canonical multi-frame form (default true)' },
        quarantine: { type: 'boolean', description: 'Move corrupt-first-frame logs aside instead of leaving them in place (default false)' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, counts: { type: 'object' } } },
      render: (_args: any, value: any) =>
        [{ type: 'text', text: `fixed=${value?.counts?.fixed ?? 0} quarantined=${value?.counts?.quarantined ?? 0} remaining=${value?.counts?.remaining ?? 0}` }],
    },
    execute: async (args: any) => {
      const counts = await runSessionHealthCheck(resolveHealthRoot(args, config), {
        repair: args?.repair !== false,
        quarantine: args?.quarantine === true,
      })
      return { ok: true, counts }
    },
  }
}

/**
 * Register the session-health RPC handle (loopback authority) and the
 * maestro_session_health host tool. Fail-safe like the other registrations:
 * any registration error is logged, never thrown, and the returned disposer
 * unregisters everything that did succeed.
 */
export function registerSessionHealthService(ctx: any, config: SupervisorPluginConfig = {}): () => void {
  const disposers: (() => void)[] = []
  try {
    const conn = ctx.connection ?? ctx.get?.('connection')
    if (conn?.rpc?.handle) {
      disposers.push(conn.rpc.handle(
        '/dsh-maestro-supervisor-session-health',
        createSessionHealthRpcHandler(ctx, { config }),
        { authority: 'loopback' },
      ))
    }
  } catch (e: any) {
    try { ctx.logger?.warn?.(`[supervisor] session-health RPC registration failed: ${e?.message ?? String(e)}`) } catch {}
  }
  try {
    if (typeof ctx.tools?.register === 'function') {
      disposers.push(ctx.tools.register(makeSessionHealthToolDef(config)))
    }
  } catch (e: any) {
    try { ctx.logger?.warn?.(`[supervisor] session-health tool registration failed: ${e?.message ?? String(e)}`) } catch {}
  }
  return () => { for (const d of disposers) { try { d() } catch {} } }
}

/** Resolve the package-root skills/ dir regardless of module layout. The built
 * host lib is flat (lib/plugin.js → ../skills), but under vitest the same
 * module loads from src/host/ (→ ../../skills). Walking to the nearest
 * package.json yields the same package-root skills/ in both layouts. */
function resolveSkillsDir(fromDir: string): string {
  let dir = fromDir
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) return path.join(dir, 'skills')
    } catch {}
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.join(fromDir, '..', 'skills')
}

function ensureSystemdKeepalive(ctx: any): void {
  // Best-effort: ensure dsh-web-keepalive.service exists and is enabled, and linger is on.
  // This is the user-level auto-fix for the 11:42:58 crash where manager session 97
  // Removed caused user manager to exit despite Linger, killing dsh-web.
  // Runs inside dsh web (as the current user) so systemctl --user bus is available when manager is alive.
  // Failures are swallowed — never throw from apply().
  try {
    const home = os.homedir()
    const systemdDir = path.join(home, '.config/systemd/user')
    const keepalivePath = path.join(systemdDir, 'dsh-web-keepalive.service')
    // Migrate old keepalive.service (pre-prefix) if present
    const oldKeepalivePath = path.join(systemdDir, 'keepalive.service')
    if (fs.existsSync(oldKeepalivePath) && !fs.existsSync(keepalivePath)) {
      try { fs.renameSync(oldKeepalivePath, keepalivePath); ctx.logger?.info?.('[supervisor] migrated keepalive.service → dsh-web-keepalive.service') } catch { try { fs.copyFileSync(oldKeepalivePath, keepalivePath) } catch {} }
    }
    if (!fs.existsSync(keepalivePath)) {
      try {
        fs.mkdirSync(systemdDir, { recursive: true })
        // Inline template — avoids needing to resolve package's systemd/dsh-web-keepalive.service.template at runtime
        const content = `[Unit]\nDescription=Keepalive for user manager linger — prevents systemd --user exit on manager session close\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=/bin/sleep infinity\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`
        fs.writeFileSync(keepalivePath, content, 'utf-8')
        ctx.logger?.info?.('[supervisor] dsh-web-keepalive.service installed')
      } catch (e: any) {
        ctx.logger?.warn?.(`[supervisor] keepalive install failed: ${e?.message ?? String(e)}`)
        return
      }
    }
    // Try to enable linger + enable/start units best-effort (may need sudo for linger, ignore failure)
    try {
      const { execSync } = require('node:child_process') as typeof import('node:child_process')
      const username = (() => { try { return os.userInfo().username } catch { return process.env.USER || process.env.LOGNAME || '' } })()
      const lingerPath = username ? `/var/lib/systemd/linger/${username}` : ''
      if (lingerPath && !fs.existsSync(lingerPath)) {
        try { execSync(`loginctl enable-linger ${username} 2>/dev/null || true`, { timeout: 3000, stdio: 'ignore' }) } catch {}
      }
      try { execSync('systemctl --user daemon-reload 2>/dev/null || true', { timeout: 3000, stdio: 'ignore' }) } catch {}
      try { execSync('systemctl --user enable dsh-web-keepalive.service 2>/dev/null || true', { timeout: 3000, stdio: 'ignore' }) } catch {}
      try { execSync('systemctl --user start dsh-web-keepalive.service 2>/dev/null || true', { timeout: 3000, stdio: 'ignore' }) } catch {}
      // Also ensure dsh-web + supervisor are enabled (in case user installed plugin but never ran install-systemd.sh)
      try { execSync('systemctl --user enable dsh-web.service dsh-web-supervisor.service 2>/dev/null || true', { timeout: 3000, stdio: 'ignore' }) } catch {}
    } catch {}
  } catch {}
}

export function apply(ctx: any, config: SupervisorPluginConfig = {}): void {
  // The whole body is wrapped: per AGENTS.md, apply() must never throw
  // synchronously or let a rejected promise escape, no matter what fails
  // (ctx.effect missing/throwing, RPC registration throwing, or even the
  // error-reporting logger call itself throwing).
  try {
    try { ensureSystemdKeepalive(ctx) } catch {}
    try {
      const skills: any = ctx.get?.('skills')
      if (skills?.registerProvider) {
        ctx.effect(() => {
          let unregister: (() => void) | undefined
          try {
            // Package-root skills/ is resolved at runtime by walking to the
            // nearest package.json (robust to lib/ vs src/host/ layouts).
            unregister = skills.registerProvider(() => makeSkillProvider(resolveSkillsDir(__dirname)))
          } catch (e: any) { ctx.logger?.warn?.(`[supervisor] skill provider failed: ${e?.message ?? String(e)}`) }
          return () => { try { unregister?.() } catch {} }
        }, 'supervisor:skill')
      }
    } catch {}

    try {
      ctx.effect(() => registerRestartTool(ctx), 'supervisor:restart-tool')
    } catch (e: any) {
      try { ctx.logger?.warn?.(`[supervisor] restart tool effect failed: ${e?.message ?? String(e)}`) } catch {}
    }

    try {
      ctx.effect(() => registerSessionHealthService(ctx, config), 'supervisor:session-health')
    } catch (e: any) {
      try { ctx.logger?.warn?.(`[supervisor] session-health effect failed: ${e?.message ?? String(e)}`) } catch {}
    }

    try {
      ctx.effect(() => registerResumeToolHealthService(ctx), 'supervisor:resume-tool-health')
    } catch (e: any) {
      try { ctx.logger?.warn?.(`[supervisor] resume-tool-health effect failed: ${e?.message ?? String(e)}`) } catch {}
    }

    ctx.effect(() => {
      let disposed = false
      let timer: ReturnType<typeof setTimeout> | null = null

      timer = setTimeout(() => {
        if (disposed) return
        runAutoResume(ctx, { config }).catch(() => {
          // runAutoResume already never rejects, but guard the .catch itself is a no-op safety net
        })
      }, 8000)

      let disposeRpc: (() => void) | undefined
      try {
        const conn = ctx.connection ?? ctx.get?.('connection')
        if (conn?.rpc?.handle) {
          disposeRpc = conn.rpc.handle(
            '/dsh-maestro-supervisor-resume',
            createResumeRpcHandler(ctx, { config }),
            { authority: 'loopback' }
          )
        }
      } catch (e: any) {
        try {
          ctx.logger?.warn?.(`[supervisor] auto-resume RPC registration failed: ${e?.message ?? String(e)}`)
        } catch {}
      }

      return () => {
        disposed = true
        if (timer) clearTimeout(timer)
        if (disposeRpc) {
          try { disposeRpc() } catch {}
        }
      }
    }, 'supervisor:auto-resume')

    try {
      // Deny bash/shell self-kill commands in-tree; the safe restart path is
      // dsh_web_restart (supervisor daemon owns the actual restart).
      const guard = makePreExecuteGuard()
      ctx.effect(() => {
        const un = ctx.on?.('tools/pre-execute', guard) ?? null
        return () => { try { un?.() } catch {} }
      }, 'supervisor:self-kill-guard')
    } catch (e: any) {
      try { ctx.logger?.warn?.(`[supervisor] self-kill guard effect failed: ${e?.message ?? String(e)}`) } catch {}
    }
  } catch (e: any) {
    try {
      ctx.logger?.warn?.(`[supervisor] auto-resume apply() failed: ${e?.message ?? String(e)}`)
    } catch {}
  }
}
