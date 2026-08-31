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
import { join } from 'node:path';
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
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
export async function dryBootVerify(harnessRoot, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const home = homedir();
    const liveProfile = join(home, '.dsh', 'profiles', 'web');
    if (!existsSync(liveProfile))
        return { ok: true, detail: 'skipped (no live web profile)' };
    const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-dryboot-'));
    const logs = [];
    let child = null;
    try {
        cpSync(liveProfile, join(tmpHome, 'profiles', 'web'), { recursive: true, preserveTimestamps: true });
        const port = String(9000 + Math.floor(Math.random() * 1000));
        const url = `http://127.0.0.1:${port}/`;
        child = spawn('node', ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', '--port', port], {
            cwd: harnessRoot, env: { ...process.env, DSH_HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.on('data', (d) => logs.push(d.toString()));
        child.stderr?.on('data', (d) => logs.push(d.toString()));
        const deadline = Date.now() + timeoutMs;
        let code = -1;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) {
                code = child.exitCode;
                break;
            }
            try {
                const r = await fetch(url);
                if (r.status === 200 || r.status === 401) {
                    code = 0;
                    break;
                }
            }
            catch { }
            await new Promise(r => setTimeout(r, 500));
        }
        const tail = logs.join('').slice(-3000);
        const loadErr = /ERR_MODULE_NOT_FOUND|assertChannel|must declare output|failed to apply loader entry/.exec(tail);
        return { ok: code === 0 && !loadErr, detail: loadErr ? loadErr[0] : (code === 0 ? 'dry-boot ok' : `dry-boot failed (exit ${code})`) };
    }
    catch (e) {
        return { ok: false, detail: `dry-boot error: ${e?.message ?? String(e)}` };
    }
    finally {
        // Kill on every exit path — a successful boot included. The dry boot only
        // exists to verify the tree; leaving the child up would orphan a dsh web
        // on the ephemeral port whose temp DSH_HOME is removed below, and a stale
        // orphan could later answer a port collision with a false-positive 200.
        try {
            child?.kill('SIGKILL');
        }
        catch { }
        try {
            rmSync(tmpHome, { recursive: true, force: true });
        }
        catch { }
    }
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
export function isPluginTreeChanged(harnessRoot, lkgDir = join(homedir(), '.dsh/.supervisor/lkg'), opts = {}) {
    void harnessRoot;
    const statFile = opts.statFile ?? ((p) => statSync(p));
    try {
        const entries = existsSync(lkgDir) ? readdirSync(lkgDir).sort() : [];
        const latest = entries[entries.length - 1];
        if (!latest)
            return true; // no baseline → assume changed
        const lkgHome = join(lkgDir, latest, 'profiles', 'web');
        const live = join(homedir(), '.dsh', 'profiles', 'web');
        const lkgManifest = join(lkgHome, 'package.json');
        const liveManifest = join(live, 'package.json');
        if (!existsSync(lkgManifest) || !existsSync(liveManifest))
            return true;
        if (readFileSync(liveManifest, 'utf8') !== readFileSync(lkgManifest, 'utf8'))
            return true;
        // cordis.patch.yml — compare only when at least one side has it (profiles
        // without a patch are the baseline; a patch appearing on either side alone
        // is drift). The text compare keeps the check cheap and hermetic.
        const lkgPatch = join(lkgHome, 'cordis.patch.yml');
        const livePatch = join(live, 'cordis.patch.yml');
        if (existsSync(lkgPatch) || existsSync(livePatch)) {
            if (!existsSync(lkgPatch) || !existsSync(livePatch))
                return true;
            if (readFileSync(livePatch, 'utf8') !== readFileSync(lkgPatch, 'utf8'))
                return true;
        }
        const snapshotManifest = join(lkgDir, latest, 'manifest.json');
        const baseline = existsSync(snapshotManifest)
            ? statFile(snapshotManifest).mtimeMs
            : statFile(join(lkgDir, latest)).mtimeMs;
        const livePlugins = join(live, 'node_modules', '@ddtcorex');
        if (existsSync(livePlugins)) {
            for (const name of readdirSync(livePlugins)) {
                const libDir = join(livePlugins, name, 'lib');
                if (!existsSync(libDir))
                    continue;
                if (newestFileMtime(libDir, statFile) > baseline)
                    return true;
            }
        }
        return false;
    }
    catch {
        return true;
    }
}
/** Newest mtime under a directory; recursion threads the injected stat reader. */
function newestFileMtime(dir, statFile) {
    let newest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory())
            newest = Math.max(newest, newestFileMtime(p, statFile));
        else
            newest = Math.max(newest, statFile(p).mtimeMs);
    }
    return newest;
}
function currentSessionId(exec, fallback) {
    // dsh-tools dispatch hands a ToolRunContext — the exec itself has no
    // sessionId/session/caller fields; session identity lives on the agent
    // (exec.agent.id is the branded SessionId, exec.agent.session.id also
    // exists). Probe those first so production dispatches are identifiable.
    return exec?.agent?.id ?? exec?.agent?.session?.id ?? exec?.sessionId ?? exec?.session?.id ?? exec?.caller?.sessionId ?? fallback?.(exec);
}
/**
 * Register the dsh_web_restart tool. Registration is fail-safe (warns, never
 * throws) and the returned function disposes the registration. `deps` are
 * injectable for tests.
 */
export function registerRestartTool(ctx, deps = {}) {
    const doDryBoot = deps.dryBoot ?? dryBootVerify;
    const doWrite = deps.writeRestartRequest ?? writeRestartRequest;
    const doSessionId = deps.sessionIdOf ?? currentSessionId;
    let dispose;
    try {
        dispose = ctx.tools.register({
            name: 'dsh_web_restart',
            description: 'Schedule a safe restart of the dsh web host. Verifies the plugin tree first (dry-boot), records an intent for the calling session, and hands the restart to the supervisor daemon (out-of-band). Never restarts in-tree itself.',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Why the restart is happening (recorded in the intent)' },
                    pluginChanged: { type: 'boolean', description: 'Override for the auto-detected plugin-tree change check' },
                },
                additionalProperties: false,
            },
            output: {
                schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } },
                render: (_args, value) => [{ type: 'text', text: value.detail }],
            },
            execute: async (args, exec) => {
                const harnessRoot = deps.harnessRoot ?? (await import('./paths.js')).resolveDeepseekHarnessDir();
                const lkgDir = join(homedir(), '.dsh/.supervisor/lkg');
                const changed = args.pluginChanged === true || (args.pluginChanged !== false && isPluginTreeChanged(harnessRoot, lkgDir));
                if (changed) {
                    const gate = await doDryBoot(harnessRoot);
                    if (!gate.ok)
                        return { ok: false, detail: `dry-boot failed — restart refused. ${gate.detail}` };
                }
                const callerSessionId = doSessionId(exec);
                if (!callerSessionId) {
                    // The daemon's grace branch keys on callerSessionId — without it the
                    // marker would be written but no restart would ever be supervised.
                    return { ok: false, detail: 'cannot identify the calling session — restart not scheduled' };
                }
                doWrite({ callerSessionId, reason: typeof args.reason === 'string' ? args.reason : undefined }, 180_000);
                writeIntentSidecar(callerSessionId, args.reason);
                return { ok: true, detail: `restart scheduled (≈30s) — caller ${callerSessionId}` };
            },
        });
    }
    catch (e) {
        try {
            ctx.logger?.warn?.(`[supervisor] dsh_web_restart tool failed: ${e?.message ?? String(e)}`);
        }
        catch { }
    }
    return () => { try {
        if (typeof dispose === 'function')
            dispose();
    }
    catch { } };
}
function writeIntentSidecar(sessionId, reason) {
    try {
        if (!sessionId)
            return;
        const dir = join(homedir(), '.dsh/.supervisor/intents');
        const require = createRequire(import.meta.url);
        const { mkdirSync, writeFileSync, chmodSync } = require('node:fs');
        mkdirSync(dir, { recursive: true });
        // Flatten slash-namespaced ids ('proj/abc' → 'proj_abc') so the sidecar is
        // a single file under intents/ and never needs a nested intents/proj/ dir.
        const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
        writeFileSync(join(dir, `${safeId}.json`), JSON.stringify({ ts: Date.now(), sessionId, reason: reason ?? '' }), 'utf8');
        try {
            chmodSync(join(dir, `${safeId}.json`), 0o600);
        }
        catch { }
    }
    catch { }
}
