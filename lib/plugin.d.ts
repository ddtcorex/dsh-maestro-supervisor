/**
 * dsh-maestro-supervisor — host plugin for auto-resume inside DSH web.
 * Runs inside the DSH host process (outside the daemon's tree) and
 * auto-resumes sessions interrupted within the configured window after
 * a restart. The standalone daemon (systemd) handles crash detection
 * and web restart; this plugin handles the in-process resume.
 */
import { findInterrupted as defaultFindInterrupted, findDanglingOpenTurns as defaultFindDanglingOpenTurns } from './resume.js';
import type { RestartIntent } from './intents.js';
import { runSessionHealthCheck } from './session-health.js';
export declare const inject: readonly ["sessions", "agents", "connection", "tools", "skills"];
export interface SupervisorPluginConfig {
    autoResumeWithin?: number | string;
    autoResumeEnabled?: boolean;
    sessionLogRoot?: string;
}
export declare function runAutoResume(ctx: any, opts?: {
    findInterrupted?: typeof defaultFindInterrupted;
    findDanglingOpenTurns?: typeof defaultFindDanglingOpenTurns;
    resumeInterrupted?: typeof resumeInterrupted;
    config?: SupervisorPluginConfig;
}): Promise<void>;
export declare function resumeInterrupted(ctx: any, ids: string[], deps?: {
    readIntent?: (id: string) => RestartIntent | undefined;
    consumeIntent?: (id: string) => void;
}): Promise<string[]>;
export declare function createResumeRpcHandler(ctx: any, opts?: {
    resumeInterrupted?: typeof resumeInterrupted;
    config?: SupervisorPluginConfig;
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
