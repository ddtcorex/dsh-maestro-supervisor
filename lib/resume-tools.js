/**
 * C2 — deterministic plugin-layer mitigation for resumed sessions that lose
 * core tools after a dsh web restart (`Error: unknown tool "bash"`).
 *
 * The supervisor cannot edit the harness tool layer (hard workspace rule) and
 * the exact layer-rebuild root cause is only observable on the live system
 * (Part D). So when the post-resume probe (C1) reports a core tool missing
 * from the resumed session's SCOPED view, this module runs a host-side
 * mitigation:
 *
 *   1. a short notifier line so the operator sees the loss immediately;
 *   2. a "System:"-prefixed inventory user-message injected into the session
 *      (same createUserMessage/followup pattern as the resume-intent message),
 *      so the model stops calling the lost tool and uses what remains;
 *   3. optionally (resumeCoreToolPolicy: 'park') records the session id in a
 *      module-level parked set exposed through the `maestro_resume_tool_health`
 *      host tool + loopback RPC, marking it for manual reopen.
 *
 * The module-level state (`parkedCoreToolLossIds`, `lastResumeProbe`,
 * `resumedSessions`) is per-`dsh web`-process: a host restart clears it, which
 * is exactly right — these are per-boot facts.
 */
import { notify } from './notifier.js';
import { probeToolView, defaultResolveToolScope, CRITICAL_TOOLS, } from './plugin.js';
// --- module-level mitigation state ---------------------------------------------
let lastResumeProbe = null;
const parkedCoreToolLossIds = new Set();
const resumedSessions = new Set();
/** Reset the per-process mitigation state — tests + fresh boot reuse. */
export function resetResumeToolHealthState() {
    lastResumeProbe = null;
    parkedCoreToolLossIds.clear();
    resumedSessions.clear();
}
/** Record a session the auto-resume confirmed as resumed (on-demand probe target). */
export function recordResumedSession(sessionId) {
    resumedSessions.add(sessionId);
}
/** Record the last REAL post-resume tool-view observation ({ missing, visible }). */
export function recordResumeProbe(probe) {
    lastResumeProbe = probe;
}
// --- message builders -----------------------------------------------------------
/**
 * Operator-facing notify line. The park variant appends the manual-reopen
 * marker so the operator knows the session was NOT auto-continued for tools.
 */
export function buildCoreToolLossNotifyLine(sessionId, missing, policy) {
    const base = `[supervisor] resumed ${sessionId}: core tool lost [${missing.join(',')}] — tool view incomplete; reopen session if it persists`;
    return policy === 'park' ? `${base} (manual reopen required)` : base;
}
/**
 * The SYSTEM message injected into the resumed session. Tells the model the
 * CURRENT inventory (scoped `schemas()` — the tools the session can actually
 * call) so it stops issuing the lost tool instead of looping on unknown-tool
 * errors. Names joined with ', '.
 */
export function buildToolInventoryMessage(missing, available) {
    const names = missing.join(', ');
    const verb = missing.length === 1 ? 'tool is' : 'tools are';
    return `System: the ${names} ${verb} unavailable in this session's restored tool view. Available tools: ${available.join(', ')}. Do not call ${names}; use the available tools.`;
}
/** Scoped schemas() = exactly what the session can still call; never the global view. */
function resolveAvailableToolNames(tools, scope) {
    try {
        const schemas = typeof tools?.schemas === 'function' ? tools.schemas : undefined;
        if (!schemas)
            return [];
        const list = schemas(scope);
        if (!Array.isArray(list))
            return [];
        return list.map((t) => (t && typeof t.name === 'string' ? t.name : '')).filter((n) => n.length > 0);
    }
    catch {
        return [];
    }
}
/**
 * Default session-message injection: mirrors the resume-intent push in
 * plugin.ts `resumeInterrupted` — `createUserMessage` (dynamic import so the
 * plugin loads without the LLM package ever installed) + `agent.followup`.
 * Never throws; a missing agent just no-ops.
 */
function makeDefaultSessionMessageInjector(ctx) {
    return async (sessionId, content) => {
        try {
            const agents = ctx.get?.('agents') ?? ctx.agents;
            const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
            if (typeof agent?.followup !== 'function')
                return;
            const { createUserMessage } = await import('@deepseek-ai/dsh-llm').catch(() => ({
                createUserMessage: (input) => ({ ...input, role: 'user', id: crypto.randomUUID() }),
            }));
            agent.followup(createUserMessage({
                content: [{ type: 'text', text: content }],
                source: { kind: 'user' },
            }));
        }
        catch { }
    };
}
/**
 * C2 mitigation entry: called by the resume flow when the post-resume probe
 * found a core tool missing. Notifies, injects the inventory message, and —
 * under 'park' policy — records the session id. Only fires on an actual
 * CRITICAL_TOOLS loss; a non-core missing name (e.g. cordis_inspect_query)
 * is a no-op. All seams are injectable for tests; every step is defensive.
 */
export async function warnCoreToolLoss(ctx, sessionId, scope, probe, policy, opts = {}) {
    const lostCore = probe.missing.filter((n) => CRITICAL_TOOLS.includes(n));
    if (!lostCore.length)
        return;
    const doNotify = opts.notify ?? ((line) => notify(line));
    try {
        await doNotify(buildCoreToolLossNotifyLine(sessionId, lostCore, policy));
    }
    catch { }
    try {
        const tools = opts.tools ?? (ctx.get?.('tools') ?? ctx.tools);
        const doInject = opts.injectSessionMessage ?? makeDefaultSessionMessageInjector(ctx);
        await doInject(sessionId, buildToolInventoryMessage(lostCore, resolveAvailableToolNames(tools, scope)));
    }
    catch { }
    if (policy === 'park')
        parkedCoreToolLossIds.add(sessionId);
}
function mergeResumeProbes(base, next) {
    if (!base)
        return next;
    return {
        missing: Array.from(new Set([...base.missing, ...next.missing])),
        visible: base.visible + next.visible,
    };
}
/**
 * Build the RPC value. When the tool registry is reachable AND at least one
 * current resumed session still lives, re-probes each session's SCOPED view
 * on demand and records the aggregate as the freshest `lastResumeProbe`;
 * otherwise returns the stored last observation unchanged ('tool registry
 * unreachable -> lastResumeProbe' contract). Session ids whose agent is gone
 * are skipped (they are no longer "current resumed sessions").
 */
export function snapshotResumeToolHealth(ctx, deps = {}) {
    const doProbe = deps.probeToolView ?? probeToolView;
    const doResolve = deps.resolveToolScope ?? defaultResolveToolScope;
    const tools = ctx.get?.('tools') ?? ctx.tools;
    let reachable = false;
    let aggregated = null;
    for (const id of resumedSessions) {
        try {
            const agents = ctx.get?.('agents') ?? ctx.agents;
            if (typeof agents?.get === 'function' && agents.get(id) === undefined)
                continue;
            aggregated = mergeResumeProbes(aggregated, doProbe(tools, doResolve(ctx, id)));
            reachable = true;
        }
        catch { }
    }
    if (reachable && aggregated)
        lastResumeProbe = aggregated;
    return { lastResumeProbe, parked: [...parkedCoreToolLossIds] };
}
/**
 * Loopback RPC handler for /dsh-maestro-supervisor-resume-tool-health.
 * Same `{ ok, value | error }` envelope shape as the other supervisor RPCs.
 */
export function createResumeToolHealthRpcHandler(ctx, deps = {}) {
    return async (_endpoint, _payload, _signal) => {
        try {
            return { ok: true, value: snapshotResumeToolHealth(ctx, deps) };
        }
        catch (e) {
            return { ok: false, error: { code: 'resume-tool-health-failed', message: e?.message ?? String(e) } };
        }
    };
}
/** dsh.tools definition for the maestro_resume_tool_health host tool. */
export function makeResumeToolHealthToolDef(ctx) {
    return {
        name: 'maestro_resume_tool_health',
        description: 'Report the tool-view health of sessions auto-resumed after a dsh web restart. ' +
            'Returns the last post-resume probe (missing core tools, visible count) plus the sessions ' +
            'parked for manual reopen under resumeCoreToolPolicy: park. The probe is refreshed on demand ' +
            'against the currently resumed sessions when the tool registry is reachable.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    lastResumeProbe: {
                        type: 'object',
                        properties: {
                            missing: { type: 'array', items: { type: 'string' } },
                            visible: { type: 'number' },
                        },
                    },
                    parked: { type: 'array', items: { type: 'string' } },
                },
            },
            render: (_args, value) => {
                const probe = value?.lastResumeProbe;
                const missing = Array.isArray(probe?.missing) && probe.missing.length ? probe.missing.join(',') : 'none';
                const visible = typeof probe?.visible === 'number' ? probe.visible : 'n/a';
                return [{ type: 'text', text: `missing=${missing} visible=${visible} parked=${Array.isArray(value?.parked) ? value.parked.length : 0}` }];
            },
        },
        execute: async () => snapshotResumeToolHealth(ctx),
    };
}
/**
 * Register the resume-tool-health RPC handle (loopback authority) and the
 * maestro_resume_tool_health host tool. Fail-safe like the other
 * registrations: any registration error is logged, never thrown, and the
 * returned disposer unregisters everything that did succeed.
 */
export function registerResumeToolHealthService(ctx) {
    const disposers = [];
    try {
        const conn = ctx.connection ?? ctx.get?.('connection');
        if (conn?.rpc?.handle) {
            disposers.push(conn.rpc.handle('/dsh-maestro-supervisor-resume-tool-health', createResumeToolHealthRpcHandler(ctx), { authority: 'loopback' }));
        }
    }
    catch (e) {
        try {
            ctx.logger?.warn?.(`[supervisor] resume-tool-health RPC registration failed: ${e?.message ?? String(e)}`);
        }
        catch { }
    }
    try {
        if (typeof ctx.tools?.register === 'function') {
            disposers.push(ctx.tools.register(makeResumeToolHealthToolDef(ctx)));
        }
    }
    catch (e) {
        try {
            ctx.logger?.warn?.(`[supervisor] resume-tool-health tool registration failed: ${e?.message ?? String(e)}`);
        }
        catch { }
    }
    return () => { for (const d of disposers) {
        try {
            d();
        }
        catch { }
    } };
}
