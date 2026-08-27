export interface HealthState {
    up: boolean;
    httpCode?: number;
    error?: string;
    degraded?: boolean;
    logTail?: string;
}
export interface PollHealthOpts {
    fetch?: () => Promise<{
        status: number;
        text: () => Promise<string>;
    }>;
    psAlive?: () => Promise<boolean>;
    logTail?: () => Promise<string>;
    url?: string;
    timeoutMs?: number;
}
export declare function pollHealth(opts?: PollHealthOpts): Promise<HealthState>;
export declare function collectLogTail(): Promise<string>;
