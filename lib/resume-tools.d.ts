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
import { type ToolViewProbe, type ToolViewProbeFn, type ToolScopeResolver, type ToolsLike, type ResumeCoreToolPolicy } from './plugin.js';
/** Reset the per-process mitigation state — tests + fresh boot reuse. */
export declare function resetResumeToolHealthState(): void;
/** Record a session the auto-resume confirmed as resumed (on-demand probe target). */
export declare function recordResumedSession(sessionId: string): void;
/** Record the last REAL post-resume tool-view observation ({ missing, visible }). */
export declare function recordResumeProbe(probe: ToolViewProbe): void;
/**
 * Operator-facing notify line. The park variant appends the manual-reopen
 * marker so the operator knows the session was NOT auto-continued for tools.
 */
export declare function buildCoreToolLossNotifyLine(sessionId: string, missing: string[], policy: ResumeCoreToolPolicy): string;
/**
 * The SYSTEM message injected into the resumed session. Tells the model the
 * CURRENT inventory (scoped `schemas()` — the tools the session can actually
 * call) so it stops issuing the lost tool instead of looping on unknown-tool
 * errors. Names joined with ', '.
 */
export declare function buildToolInventoryMessage(missing: string[], available: string[]): string;
export interface WarnCoreToolLossDeps {
    /** Loose notifier — default wires to the package notifier (swallows errors). */
    notify?: (line: string) => Promise<void>;
    /** Push a message into the resumed session — default follows the createUserMessage / followup pattern. */
    injectSessionMessage?: (sessionId: string, content: string) => unknown;
    /** Tool registry whose SCOPED schemas() yields the available-tool inventory. Defaults to ctx.tools. */
    tools?: ToolsLike;
}
/**
 * C2 mitigation entry: called by the resume flow when the post-resume probe
 * found a core tool missing. Notifies, injects the inventory message, and —
 * under 'park' policy — records the session id. Only fires on an actual
 * CRITICAL_TOOLS loss; a non-core missing name (e.g. cordis_inspect_query)
 * is a no-op. All seams are injectable for tests; every step is defensive.
 */
export declare function warnCoreToolLoss(ctx: any, sessionId: string, scope: string, probe: ToolViewProbe, policy: ResumeCoreToolPolicy, opts?: WarnCoreToolLossDeps): Promise<void>;
export interface ResumeToolHealthSnapshot {
    lastResumeProbe: ToolViewProbe | null;
    parked: string[];
}
/**
 * Build the RPC value. When the tool registry is reachable AND at least one
 * current resumed session still lives, re-probes each session's SCOPED view
 * on demand and records the aggregate as the freshest `lastResumeProbe`;
 * otherwise returns the stored last observation unchanged ('tool registry
 * unreachable -> lastResumeProbe' contract). Session ids whose agent is gone
 * are skipped (they are no longer "current resumed sessions").
 */
export declare function snapshotResumeToolHealth(ctx: any, deps?: {
    probeToolView?: ToolViewProbeFn;
    resolveToolScope?: ToolScopeResolver;
}): ResumeToolHealthSnapshot;
/**
 * Loopback RPC handler for /dsh-maestro-supervisor-resume-tool-health.
 * Same `{ ok, value | error }` envelope shape as the other supervisor RPCs.
 */
export declare function createResumeToolHealthRpcHandler(ctx: any, deps?: {
    probeToolView?: ToolViewProbeFn;
    resolveToolScope?: ToolScopeResolver;
}): (_endpoint: string, _payload: unknown, _signal: AbortSignal) => Promise<{
    ok: boolean;
    value: ResumeToolHealthSnapshot;
    error?: undefined;
} | {
    ok: boolean;
    error: {
        code: string;
        message: any;
    };
    value?: undefined;
}>;
/** dsh.tools definition for the maestro_resume_tool_health host tool. */
export declare function makeResumeToolHealthToolDef(ctx: any): any;
/**
 * Register the resume-tool-health RPC handle (loopback authority) and the
 * maestro_resume_tool_health host tool. Fail-safe like the other
 * registrations: any registration error is logged, never thrown, and the
 * returned disposer unregisters everything that did succeed.
 */
export declare function registerResumeToolHealthService(ctx: any): () => void;
