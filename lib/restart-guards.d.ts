export declare function buildKillStalePortsCommand(ports?: number[]): string;
export declare function isSelfCopyError(message: string): boolean;
export declare const PLANNED_RESTART_TTL_MS = 180000;
export declare function isPlannedRestartFresh(mtimeMs: number, nowMs: number, ttlMs?: number): boolean;
export declare function plannedRestartPath(): string;
export declare function writePlannedRestart(ttlMs?: number): void;
export declare function checkPlannedRestart(markerPath?: string): boolean;
export declare function clearPlannedRestart(): void;
export interface RestartRequest {
    ts: number;
    ttl: number;
    callerSessionId?: string;
    reason?: string;
}
export declare function writeRestartRequest(caller: {
    callerSessionId?: string;
    reason?: string;
}, ttlMs?: number): void;
export declare function readRestartRequest(): RestartRequest | undefined;
