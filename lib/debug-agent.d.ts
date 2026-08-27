export interface DebugAgentOpts {
    reportPath: string;
    health: {
        error?: string;
        httpCode?: number;
    };
    attempts?: number;
    cooldownMs?: number;
}
export declare function runDebugAgent(opts: DebugAgentOpts): Promise<{
    fixed: boolean;
    reason: string;
}>;
export declare function _resetDebugAgentForTest(): void;
