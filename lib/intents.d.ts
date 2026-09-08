/**
 * Durable self-restart intent sidecar written by `dsh_web_restart`
 * (`~/.dsh/.supervisor/intents/<sessionId>.json`, mode 600). Consumed by
 * auto-resume so a session that requested the restart is resumed with a
 * contextual message instead of the generic "outcome unknown" recovery text.
 */
export interface RestartIntent {
    ts: number;
    sessionId?: string;
    reason?: string;
}
export declare function intentsDir(): string;
export declare function intentPath(sessionId: string): string;
export declare function readIntent(sessionId: string): RestartIntent | undefined;
export declare function consumeIntent(sessionId: string): void;
/**
 * Post-swap outcome written by the supervisor daemon after acting on a
 * restart request (`<sessionId>.outcome.json`, mode 600, same dir). Read by
 * `dsh_web_restart_status` so callers learn the new PID + HTTP status without
 * hand-probing `ss`/`curl`.
 */
export interface RestartOutcome {
    state: 'ok' | 'failed';
    oldPid?: number;
    newPid?: number;
    httpStatus?: number;
    swappedAt: number;
    error?: string;
}
export declare function outcomePath(sessionId: string): string;
export declare function writeRestartOutcome(sessionId: string, outcome: RestartOutcome): void;
export declare function readRestartOutcome(sessionId: string): RestartOutcome | undefined;
