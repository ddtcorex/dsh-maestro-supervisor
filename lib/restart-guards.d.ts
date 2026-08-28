export declare function buildKillStalePortsCommand(ports?: number[]): string;
export declare function isSelfCopyError(message: string): boolean;
export declare const PLANNED_RESTART_TTL_MS = 180000;
export declare function isPlannedRestartFresh(mtimeMs: number, nowMs: number, ttlMs?: number): boolean;
export declare function checkPlannedRestart(markerPath?: string): Promise<boolean>;
