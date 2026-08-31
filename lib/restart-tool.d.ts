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
 * Whether the live profile's web package.json differs from the latest LKG
 * snapshot's copy. No LKG baseline, a missing file on either side, or any
 * read error means "changed" — the caller falls back to the dry-boot gate.
 */
export declare function isPluginTreeChanged(harnessRoot: string, lkgDir?: string): boolean;
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
