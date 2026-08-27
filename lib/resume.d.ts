export interface ResumeResult {
    scanned: number;
    interrupted: string[];
}
export interface FindInterruptedOpts {
    withinMs?: number;
    sinceMs?: number;
}
export declare function findInterrupted(dshHome?: string, opts?: FindInterruptedOpts): Promise<ResumeResult>;
export declare function parseDuration(s: string): number | undefined;
