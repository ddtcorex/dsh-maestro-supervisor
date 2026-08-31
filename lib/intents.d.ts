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
