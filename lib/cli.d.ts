/**
 * Copy a chosen LKG snapshot back into the DSH home. Recent snapshots are
 * tried newest-first, skipping any that still carry a failing plugin so a
 * broken bundle is not restored. `sessions/` is deliberately NOT restored —
 * session logs are append-only truth and rolling them back to a snapshot
 * would drop every turn recorded after that snapshot.
 * @returns the rolled-back snapshot id.
 */
export declare function rollbackLKG(opts: {
    dshHome: string;
    lkgRoot: string;
    failingPlugin?: string;
}): Promise<string>;
export declare function runCli(args: string[]): Promise<void>;
