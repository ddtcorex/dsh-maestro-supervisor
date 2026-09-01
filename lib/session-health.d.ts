/**
 * Session-log health scan.
 *
 * Deeper resilience for dsh-safe-restart pre-flight: after (or before) a
 * restart, individual session logs under a project session dir can end up in
 * three distinct shapes:
 *
 *  1. healthy multi-frame  — one frame per line (a header-only first frame,
 *                            then per-event frames). The DSH reader depends on
 *                            this shape to fast-seek the session header.
 *  2. single-frame whole-log — the entire log was written as ONE zstd frame.
 *                            Data is fully intact (whole-file decode works) but
 *                            the header cannot be located by a frame walk.
 *  3. corrupt first frame — the first frame cannot be decoded at all.
 *
 * Classification uses fzstd's whole-file decode + streaming Decompress and
 * avoids a hand-rolled zstd frame-header walker (empirically wrong on both
 * real file shapes; fzstd whole-file decode already handles single and
 * concatenated frames). The `firstEmitPrefix` binary search is cheap
 * (log2 scans of ≤1–4 KB prefixes per file when healthy).
 *
 * Repair re-encodes a single-frame whole-log into the canonical multi-frame
 * shape (frame #1 = exactly the header line, trailing line-batched frames),
 * byte-preserving every event; the original file is kept as a sidecar backup
 * and the replace is atomic (write temp + rename).
 *
 * NOTE: fzstd is a decode-only pure-JS zstd library; re-encoding uses Node's
 * native zlib zstd encoder, whose frames fzstd (and the zstd CLI / DSH's
 * reader) decode as standard concatenated frames.
 */
export type SessionLogClass = 'ok' | 'single-frame-whole-log' | 'corrupt-first-frame' | 'not-a-session-log';
export interface SessionHealthEntry {
    path: string;
    klass: SessionLogClass;
}
/**
 * Classify a single session log file per the validated algorithm:
 * whole-file decode success guards 'corrupt', otherwise the first-frame
 * prefix decode decides 'ok' (header-only first frame) vs the recoverable
 * 'single-frame-whole-log'. Empty files are not session logs.
 */
export declare function classifySessionLog(path: string): Promise<SessionHealthEntry>;
/**
 * Re-encode a single-frame-whole-log into canonical multi-frame form:
 * frame #1 = exactly the header line, then line-batched trailing frames.
 * The original file is preserved as `path + backupSuffix` (first time only)
 * and the replace is atomic (temp file + rename).
 */
export declare function repairSingleFrameLog(path: string, backupSuffix?: string): Promise<void>;
/**
 * Walk `root` recursively and classify every `session.jsonl.zstd` found.
 * The process-write layout is <dshHome>/sessions/<project>/<session>/, but we
 * recurse generically so tests and future layouts work unchanged.
 */
export declare function scanSessionLogs(root: string): Promise<SessionHealthEntry[]>;
/**
 * Health check over a session-log root: repair single-frame logs (atomic
 * re-encode), optionally quarantine corrupt-first-frame logs aside, and
 * report counts. `remaining` counts unhealthy entries left untouched
 * (not-a-session-log, corrupt frames when quarantine is off, and
 * single-frame logs when repair is off).
 */
export declare function runSessionHealthCheck(root: string, opts?: {
    repair?: boolean;
    quarantine?: boolean;
}): Promise<{
    fixed: number;
    quarantined: number;
    remaining: number;
}>;
