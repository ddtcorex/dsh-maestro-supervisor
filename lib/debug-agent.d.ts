export interface DebugAgentOpts {
    reportPath: string;
    health: {
        error?: string;
        httpCode?: number;
    };
    cooldownMs?: number;
    exec?: (cmd: string, opts?: any) => string;
    readFile?: (path: string) => string;
    writeFile?: (path: string, content: string) => void;
    dryBoot?: () => Promise<boolean>;
}
export declare function runDebugAgent(opts: DebugAgentOpts): Promise<{
    fixed: boolean;
    reason: string;
}>;
export declare function _resetDebugAgentForTest(): void;
