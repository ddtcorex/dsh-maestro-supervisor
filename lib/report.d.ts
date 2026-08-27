import type { HealthState } from './health-poller.js';
export interface ReportOpts {
    reportsRoot: string;
    ts: string;
    health: HealthState;
    gitDiff: string;
    logTail: string;
    action: string;
}
export declare function writeReport(opts: ReportOpts): Promise<string>;
export declare function collectGitDiff(workspaceRoot: string): Promise<string>;
