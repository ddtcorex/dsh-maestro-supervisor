export interface ResumeResult {
    scanned: number;
    interrupted: string[];
}
export declare function findInterrupted(dshHome?: string): Promise<ResumeResult>;
