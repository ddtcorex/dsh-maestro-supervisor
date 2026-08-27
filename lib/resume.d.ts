export interface ResumeResult {
    scanned: number;
    interrupted: string[];
}
export interface FindInterruptedOpts {
    withinMs?: number;
    sinceMs?: number;
}
export declare function findInterrupted(dshHome?: string, opts?: FindInterruptedOpts): Promise<ResumeResult>;
/**
 * Detect sessions whose raw log ends with a `turn/start` that has no
 * matching `turn/end` anywhere later in the scanned log — a dangling open
 * turn. Unlike {@link findInterrupted}, this needs no prior `persistence.load()`
 * call to have already synthesized a `turn/end interrupted` closer (DSH core
 * only writes that closer when something loads/prepares the specific
 * session — a genuinely fresh crash's raw log has no closer at all, only an
 * open turn). Safe to call ONLY right after a fresh `dsh web` boot, when
 * `dsh web` is the sole live process for these sessions — an open turn found
 * at that moment cannot belong to a still-running generation anywhere else.
 * Callers MUST additionally skip any id that is live in their own current
 * process (e.g. `ctx.sessions.get(id)`) before treating a match as crashed.
 */
export declare function findDanglingOpenTurns(dshHome?: string, opts?: FindInterruptedOpts): Promise<ResumeResult>;
export declare function parseDuration(s: string): number | undefined;
