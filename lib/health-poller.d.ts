export interface HealthState {
    up: boolean;
    httpCode?: number;
    error?: string;
    degraded?: boolean;
    logTail?: string;
}
export declare function getActiveEnterMs(): number | undefined;
export interface PollHealthOpts {
    fetch?: () => Promise<{
        status: number;
        text: () => Promise<string>;
    }>;
    psAlive?: () => Promise<boolean>;
    logTail?: () => Promise<string>;
    url?: string;
    timeoutMs?: number;
    /** injectable for tests — overrides systemctl lookup */
    getActiveEnterMs?: () => number | undefined;
}
export declare function pollHealth(opts?: PollHealthOpts): Promise<HealthState>;
export declare function collectLogTail(): Promise<string>;
