/**
 * Post-restart session scan: walk recent session logs under
 * <dshHome>/sessions/<project>/<session>/ and flag torn tails (a zstd frame
 * that fails to decode, or a plain-text log that is unreadable). Runs after
 * an intentional dsh-web restart so the supervisor can report whether any
 * in-flight session log was left truncated by the restart.
 */
interface ScanOptions {
    withinMs?: number;
}
/**
 * Scan session logs whose mtime falls within the window. A file whose decode
 * fails (torn zstd frame or unreadable plain text) is reported as torn. A
 * missing sessions root yields an empty scan, never an error.
 */
export declare function scanSessions(dshHome: string, opts?: ScanOptions): Promise<{
    scanned: number;
    torn: string[];
}>;
export {};
