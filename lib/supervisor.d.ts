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
    getTime?: () => number;
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
}
export declare class Supervisor {
    private deps;
    private lastRollback;
    private rollingBack;
    private lastLKGWrite;
    private lastDegradedNotify;
    private timer;
    constructor(deps: SupervisorDeps);
    private getRunDebugAgent;
    private getFindInterrupted;
    private getResumeWithinMs;
    private findInterruptedRecent;
    private collectGitDiff;
    private handleDebugResult;
    tick(): Promise<void>;
    start(): void;
    stop(): void;
}
