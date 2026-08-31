/**
 * dsh-maestro-supervisor — host plugin for auto-resume inside DSH web.
 * Runs inside the DSH host process (outside the daemon's tree) and
 * auto-resumes sessions interrupted within the configured window after
 * a restart. The standalone daemon (systemd) handles crash detection
 * and web restart; this plugin handles the in-process resume.
 */
import { findInterrupted as defaultFindInterrupted, findDanglingOpenTurns as defaultFindDanglingOpenTurns } from './resume.js';
import type { RestartIntent } from './intents.js';
export declare const inject: readonly ["sessions", "agents", "connection", "tools", "skills"];
export interface SupervisorPluginConfig {
    autoResumeWithin?: number | string;
    autoResumeEnabled?: boolean;
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
export declare function apply(ctx: any, config?: SupervisorPluginConfig): void;
