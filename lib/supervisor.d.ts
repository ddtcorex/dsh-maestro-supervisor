import type { HealthState } from './health-poller.js';
export interface SupervisorDeps {
    pollHealth: () => Promise<HealthState>;
    writeLKG: () => Promise<{
        ts: string;
        manifest: any;
    }>;
    writeFailed: () => Promise<{
        ts: string;
        manifest: any;
    }>;
    writeReport: (opts: {
        ts: string;
        health: HealthState;
        action: string;
        logTail?: string;
        gitDiff?: string;
    }) => Promise<string>;
    rollback: (ts?: string) => Promise<void>;
    restartWeb?: () => Promise<void>;
    notify: (msg: string) => Promise<void>;
    intervalMs?: number;
    debounceMs?: number;
    downThreshold?: number;
    getTime?: () => number;
    isPlannedRestartActive?: () => boolean | Promise<boolean>;
    writePlannedRestart?: (ttlMs?: number) => void;
    checkPlannedRestart?: () => boolean;
    runDebugAgent?: (opts: {
        reportPath: string;
        health: HealthState;
    }) => Promise<{
        fixed: boolean;
        reason: string;
    }>;
    findInterrupted?: () => Promise<{
        scanned: number;
        interrupted: string[];
    }>;
    resumeSessions?: (ids: string[]) => Promise<{
        resumed: string[];
    }>;
}
export declare function resumeViaRpc(ids: string[], fetchFn?: (url: string, init: RequestInit) => Promise<Response>): Promise<{
    resumed: string[];
}>;
export declare class Supervisor {
    private deps;
    private lastRollback;
    private rollingBack;
    private lastLKGWrite;
    private lastDegradedNotify;
    private consecutiveDown;
    private consecutiveDegraded;
    private timer;
    constructor(deps: SupervisorDeps);
    private getWritePlannedRestart;
    private getCheckPlannedRestart;
    restartWeb(): Promise<void>;
    private getRunDebugAgent;
    private getFindInterrupted;
    private getResumeSessions;
    private getAutoResumeEnabled;
    private getResumeWithinMs;
    private getEffectiveIntervalMs;
    private getEffectiveDownThreshold;
    private findInterruptedRecent;
    private collectGitDiff;
    private attemptAutoResume;
    private handleDebugResult;
    tick(): Promise<void>;
    start(): Promise<void>;
    startSync(): void;
    stop(): void;
}
