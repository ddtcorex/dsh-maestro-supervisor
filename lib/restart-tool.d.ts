/**
 * dsh_web_restart tool — the safe restart path for the model running inside
 * dsh web. Scheduling a restart through this tool instead of a raw kill keeps
 * the restart inside the supervisor's ownership loop:
 *
 *   1. dry-boot gate — if the plugin tree changed since the latest LKG, boot a
 *      copy of the live profile on an ephemeral DSH_HOME first and only
 *      schedule when that boot serves HTTP.
 *   2. intent sidecar — record the caller session + reason under
 *      ~/.dsh/.supervisor/intents/ for attribution.
 *   3. hand-off — write the restart-request marker (planned-restart.json with
 *      callerSessionId) that the supervisor daemon owns and acts on
 *      (out-of-band). This tool NEVER restarts the host in-tree.
 */
import { writeRestartRequest } from './restart-guards.js';
/**
 * Boot a copy of the live web profile on an isolated DSH_HOME and verify the
 * plugin tree loads and serves. Returns ok + a one-line detail for the tool
 * message. The spawned tree is killed (best-effort) and the temp home removed.
 * Unit tests mock this (never spawn a real node boot in tests).
 *
 * NOTE (bin.ts finding): the `web` alias already implies `--profile web`, and
 * the web app's own commander program (no allowUnknownOption) rejects a stray
 * `--profile` in its inner args — so the spawn passes only `web --no-open
 * --port <port>`.
 */
export declare function dryBootVerify(harnessRoot: string, opts?: {
    timeoutMs?: number;
}): Promise<{
    ok: boolean;
    detail: string;
}>;
/**
 * Classify a failed dry-boot's log tail into a precise one-line detail. The
 * most common operator-actionable failure is an EADDRINUSE — the candidate
 * collided with the live dsh web tree on :3000/:3080 or with another process
 * on the ephemeral 9000-9999 port — so name the colliding port instead of
 * reporting a generic boot failure. Plugin-tree load errors keep their stable
 * codes (the caller's refused message reads `dry-boot failed — restart
 * refused. <detail>`).
 */
export declare function dryBootFailureDetail(tail: string, exitCode: number): string;
/** Minimal file metadata the drift check reads; injectable for deterministic tests. */
export interface FileStat {
    mtimeMs: number;
}
/**
 * Whether the live plugin tree differs from the latest LKG snapshot. Three
 * signals are combined:
 *
 *   1. manifest drift — the live profile's web `package.json` text vs baseline;
 *   2. cordis patch drift — the live profile's web `cordis.patch.yml` text vs
 *      baseline (a patch-only config edit changes the boot-time row wiring
 *      without touching the manifest — the manifest check alone misses it);
 *   3. plugin-lib drift — any `@ddtcorex` plugin `lib/` file newer than the
 *      snapshot moment. Link-installed plugins resolve to the same workspace
 *      files in both live and LKG, so the stored copies cannot be compared
 *      byte-wise; the snapshot itself is the meaningful baseline and a rebuilt
 *      `lib/` bumps a file past it even when the manifest text is unchanged.
 *      writeLKG writes `manifest.json` LAST, so its FILE mtime is the
 *      authoritative snapshot moment; the snapshot dir mtime is only a
 *      fallback for legacy snapshots without a manifest.
 *
 * `statFile` (default `statSync`) reads the metadata so tests can inject a
 * controlled reader instead of relying on filesystem utimes (which CI runners
 * do not reliably reflect). No LKG baseline, a missing file on either side, or
 * any stat/read error means "changed" — the caller falls back to the dry-boot
 * gate.
 */
export declare function isPluginTreeChanged(harnessRoot: string, lkgDir?: string, opts?: {
    statFile?: (p: string) => FileStat;
}): boolean;
/**
 * Register the dsh_web_restart tool. Registration is fail-safe (warns, never
 * throws) and the returned function disposes the registration. `deps` are
 * injectable for tests.
 */
export declare function registerRestartTool(ctx: any, deps?: {
    sessionIdOf?: (exec: any) => string | undefined;
    dryBoot?: typeof dryBootVerify;
    writeRestartRequest?: typeof writeRestartRequest;
    harnessRoot?: string;
}): () => void;
