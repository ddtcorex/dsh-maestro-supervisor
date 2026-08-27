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
    }) => Promise<string>;
    rollback: (ts?: string) => Promise<void>;
    notify: (msg: string) => Promise<void>;
    intervalMs?: number;
    debounceMs?: number;
    getTime?: () => number;
}
export declare class Supervisor {
    private deps;
    private lastRollback;
    private rollingBack;
    private lastLKGWrite;
    private timer;
    constructor(deps: SupervisorDeps);
    tick(): Promise<void>;
    start(): void;
    stop(): void;
}
