/**
 * dsh-maestro-supervisor — host plugin for auto-resume inside DSH web.
 * Runs inside the DSH host process (outside the daemon's tree) and
 * auto-resumes sessions interrupted within the configured window after
 * a restart. The standalone daemon (systemd) handles crash detection
 * and web restart; this plugin handles the in-process resume.
 */
import { findInterrupted as defaultFindInterrupted, findDanglingOpenTurns as defaultFindDanglingOpenTurns } from './resume.js';
import type { RestartIntent } from './intents.js';
import { type ResumeLogEntry } from './resume-log.js';
import { runSessionHealthCheck } from './session-health.js';
export * from './resume-tools.js';
export declare const inject: readonly ["sessions", "agents", "connection", "tools", "skills"];
export interface SupervisorPluginConfig {
    autoResumeWithin?: number | string;
    autoResumeEnabled?: boolean;
    sessionLogRoot?: string;
    resumeCoreToolPolicy?: ResumeCoreToolPolicy;
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
export type ResumeCoreToolPolicy = 'warn' | 'park';
/**
 * Core tools that must be visible on a resumed session. Part C targets the
 * post-restart bash loss (`Error: unknown tool "bash"`); extend this list to
 * widen the probe (e.g. 'cordis_inspect_query').
 */
export declare const CRITICAL_TOOLS: readonly ["bash"];
/** Minimal ToolRegistry surface the resume tool-view probe reads. */
export interface ToolsLike {
    get?(name: string, scope?: unknown): unknown;
    schemas?(scope?: unknown): {
        name?: string;
    }[];
}
/** Caller-visible result of the post-resume tool-view probe. */
export interface ToolViewProbe {
    missing: string[];
    visible: number;
}
export type ToolViewProbeFn = (tools: ToolsLike | undefined, scope: string, logger?: {
    info?: (msg: string) => void;
}) => ToolViewProbe;
export type ToolScopeResolver = (ctx: any, sessionId: string) => string;
/** Default: the resumed agent's tool scope is its top-level session id. */
export declare const defaultResolveToolScope: ToolScopeResolver;
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
export declare function probeToolView(tools: ToolsLike | undefined, scope: string, logger?: {
    info?: (msg: string) => void;
}): ToolViewProbe;
export declare function runAutoResume(ctx: any, opts?: {
    findInterrupted?: typeof defaultFindInterrupted;
    findDanglingOpenTurns?: typeof defaultFindDanglingOpenTurns;
    resumeInterrupted?: typeof resumeInterrupted;
    logResume?: (entry: ResumeLogEntry) => void;
    config?: SupervisorPluginConfig;
}): Promise<void>;
export declare function resumeInterrupted(ctx: any, ids: string[], deps?: {
    readIntent?: (id: string) => RestartIntent | undefined;
    consumeIntent?: (id: string) => void;
    probeToolView?: ToolViewProbeFn;
    resolveToolScope?: ToolScopeResolver;
    notify?: (line: string) => Promise<void>;
    injectSessionMessage?: (sessionId: string, content: string) => unknown;
    logResume?: (entry: ResumeLogEntry) => void;
    config?: SupervisorPluginConfig;
}): Promise<string[]>;
export declare function createResumeRpcHandler(ctx: any, opts?: {
    resumeInterrupted?: typeof resumeInterrupted;
    config?: SupervisorPluginConfig;
    notify?: (line: string) => Promise<void>;
    injectSessionMessage?: (sessionId: string, content: string) => unknown;
}): (endpoint: string, payload: unknown, _signal: AbortSignal) => Promise<{
    ok: boolean;
    value: import("./resume.js").ResumeResult;
    error?: undefined;
} | {
    ok: boolean;
    error: {
        code: string;
        message: string;
    };
    value?: undefined;
} | {
    ok: boolean;
    value: {
        resumed: string[];
    };
    error?: undefined;
}>;
/**
 * Loopback RPC handler for /dsh-maestro-supervisor-session-health. Runs the
 * A1 session-log health check over the resolved root with repair on and
 * quarantine off (mirrors the safe-restart pre-flight — single-frame logs get
 * re-encoded, corrupt logs stay in place and are only counted). Same
 * `{ ok, value | error }` envelope shape as the resume handler.
 */
export declare function createSessionHealthRpcHandler(ctx: any, deps?: {
    run?: typeof runSessionHealthCheck;
    config?: SupervisorPluginConfig;
}): (_endpoint: string, payload: unknown, _signal: AbortSignal) => Promise<{
    ok: boolean;
    value: {
        fixed: number;
        quarantined: number;
        remaining: number;
    };
    error?: undefined;
} | {
    ok: boolean;
    error: {
        code: string;
        message: any;
    };
    value?: undefined;
}>;
/**
 * Register the session-health RPC handle (loopback authority) and the
 * maestro_session_health host tool. Fail-safe like the other registrations:
 * any registration error is logged, never thrown, and the returned disposer
 * unregisters everything that did succeed.
 */
export declare function registerSessionHealthService(ctx: any, config?: SupervisorPluginConfig): () => void;
export declare function apply(ctx: any, config?: SupervisorPluginConfig): void;
