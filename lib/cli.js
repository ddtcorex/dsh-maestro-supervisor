import { Supervisor } from './supervisor.js';
import { pollHealth } from './health-poller.js';
import { writeLKG, verifyLKG } from './snapshot.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveHarnessRoot, resolveDeepseekHarnessDir } from './paths.js';
export async function runCli(args) {
    const cmd = args[2] ?? '--help';
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
        console.log(`Usage: dsh-web-supervisor <command>

Commands:
  daemon     Run supervisor daemon (poll every 3s)
  status     Show health + LKG status
  logs       Tail supervisor reports
  rollback --to <ts>  Rollback to LKG <ts>
  resume [--within <dur>]  List interrupted sessions (filter by time, e.g. 5m, 30s, 1h)
`);
        return;
    }
    if (cmd === 'status') {
        const health = await pollHealth();
        console.log(`up: ${health.up}, httpCode: ${health.httpCode}, error: ${health.error ?? 'none'}`);
        const lkgRoot = path.join(os.homedir(), '.dsh/.supervisor/lkg');
        if (fs.existsSync(lkgRoot)) {
            const entries = fs.readdirSync(lkgRoot).sort();
            console.log(`LKG: ${entries.length} snapshots, latest: ${entries[entries.length - 1] ?? 'none'}`);
            if (entries.length) {
                const ok = await verifyLKG(path.join(lkgRoot, entries[entries.length - 1])).catch(() => false);
                console.log(`latest LKG valid: ${ok}`);
            }
        }
        else {
            console.log('LKG: none');
        }
        return;
    }
    if (cmd === 'resume') {
        const withinIdx = args.indexOf('--within');
        let withinMs;
        if (withinIdx !== -1) {
            const raw = args[withinIdx + 1] ?? '';
            const { parseDuration } = await import('./resume.js');
            withinMs = parseDuration(raw);
            if (withinMs === undefined) {
                console.error(`invalid --within value: ${raw} (use e.g. 5m, 30s, 1h)`);
                process.exit(1);
            }
        }
        const { findInterrupted } = await import('./resume.js');
        const res = await findInterrupted(undefined, withinMs !== undefined ? { withinMs } : undefined);
        if (withinMs !== undefined) {
            console.log(`interrupted within ${args[withinIdx + 1]}: ${res.interrupted.length}/${res.scanned}`);
        }
        else {
            console.log(`interrupted: ${res.interrupted.length}/${res.scanned}`);
        }
        for (const id of res.interrupted)
            console.log(id);
        return;
    }
    if (cmd === 'daemon') {
        console.log('[supervisor] starting daemon — poll every 3s, Ctrl+C to stop');
        const dshHome = path.join(os.homedir(), '.dsh');
        const lkgRoot = path.join(os.homedir(), '.dsh/.supervisor/lkg');
        const failedRoot = path.join(os.homedir(), '.dsh/.supervisor/failed');
        const reportsRoot = path.join(os.homedir(), '.dsh/.supervisor/reports');
        const supervisor = new Supervisor({
            pollHealth: () => pollHealth(),
            writeLKG: () => writeLKG(dshHome, lkgRoot),
            writeFailed: () => writeLKG(dshHome, failedRoot),
            writeReport: async ({ ts, health, action, logTail, gitDiff }) => {
                const { writeReport, collectGitDiff } = await import('./report.js');
                const { collectLogTail } = await import('./health-poller.js');
                // Prefer supervisor-provided tail/diff (from health.logTail); fallback to live collect
                let tail = logTail ?? health.logTail ?? '';
                if (!tail) {
                    try {
                        tail = await collectLogTail();
                    }
                    catch {
                        tail = '';
                    }
                }
                let diff = gitDiff ?? '';
                if (!diff) {
                    try {
                        const harnessRoot = resolveHarnessRoot();
                        diff = await collectGitDiff(harnessRoot).catch(() => '');
                        if (!diff) {
                            // fallback: try git diff in cwd
                            const { execSync } = await import('node:child_process');
                            try {
                                diff = execSync('git diff 2>/dev/null | head -n 200', { encoding: 'utf-8', timeout: 2000 });
                            }
                            catch {
                                diff = '';
                            }
                        }
                    }
                    catch {
                        diff = '';
                    }
                }
                return writeReport({ reportsRoot, ts, health, gitDiff: diff, logTail: tail, action });
            },
            rollback: async () => {
                const { execSync } = await import('node:child_process');
                const entries = fs.existsSync(lkgRoot) ? fs.readdirSync(lkgRoot).sort() : [];
                if (!entries.length)
                    throw new Error('no LKG to rollback to');
                // Try newest to oldest (up to 3) to find a clean LKG for plugin failures
                // Extract failing plugin from current log tail if possible
                let failingPlugin;
                try {
                    const tail = fs.readFileSync(path.join(os.homedir(), '.dsh/dsh-web.log'), 'utf8').slice(-5000);
                    const m = tail.match(/@ddtcorex\/dsh-maestro-[a-z0-9_-]+/i) ?? tail.match(/dsh-maestro-[a-z0-9_-]+/i);
                    if (m)
                        failingPlugin = m[0].replace(/^@ddtcorex\//, '');
                }
                catch { }
                const candidates = [...entries].reverse().slice(0, 3);
                let chosen;
                for (const cand of candidates) {
                    if (!failingPlugin) {
                        chosen = cand;
                        break;
                    }
                    try {
                        const pkgPath = path.join(lkgRoot, cand, 'profiles/web/package.json');
                        if (!fs.existsSync(pkgPath)) {
                            chosen = cand;
                            break;
                        }
                        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                        const bundles = pkg?.dsh?.profile?.bundles ?? [];
                        const deps = pkg?.dependencies ?? {};
                        const hasFailing = bundles.some((b) => b.includes(failingPlugin)) || Object.keys(deps).some(k => k.includes(failingPlugin));
                        if (!hasFailing) {
                            chosen = cand;
                            break;
                        }
                        console.log(`[supervisor] skipping LKG ${cand} still contains failing plugin ${failingPlugin}`);
                    }
                    catch {
                        chosen = cand;
                        break;
                    }
                }
                const target = chosen ?? entries[entries.length - 1];
                const src = path.join(lkgRoot, target);
                for (const entry of fs.readdirSync(src)) {
                    if (entry === 'manifest.json')
                        continue;
                    fs.cpSync(path.join(src, entry), path.join(dshHome, entry), { recursive: true, force: true });
                }
                console.log(`[supervisor] rolled back to ${target}${failingPlugin ? ` (avoiding ${failingPlugin})` : ''}`);
                // Reconcile node_modules from restored package.json (critical for link: deps)
                try {
                    execSync('pnpm --dir ~/.dsh/profiles/web install --silent', { timeout: 30000, stdio: 'pipe' });
                    console.log('[supervisor] pnpm install reconciled profiles/web');
                }
                catch (e) {
                    console.log(`[supervisor] pnpm install failed: ${e?.message ?? String(e)}`);
                }
            },
            restartWeb: async () => {
                const { execSync } = await import('node:child_process');
                // Kill stale MainThread holding 3080/3000 before any restart attempt
                // (EADDRINUSE crash leaves old pid alive with http 200; new start would fail)
                try {
                    execSync(`pids=$(ss -tlnp 2>/dev/null | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | sort -u); if [ -n "$pids" ]; then echo "[supervisor] killing stale pids $pids"; kill $pids 2>/dev/null || true; sleep 2; fi`, { timeout: 5000, stdio: 'pipe' });
                }
                catch { }
                // Prefer systemd — if dsh-web.service is installed, restart/start it
                try {
                    execSync('systemctl --user is-active --quiet dsh-web.service && systemctl --user restart dsh-web.service || systemctl --user start dsh-web.service', { timeout: 15000, stdio: 'pipe' });
                    console.log('[supervisor] restarted dsh-web via systemd');
                    return;
                }
                catch { }
                // Check if unit exists but not active — try start
                try {
                    execSync('systemctl --user start dsh-web.service', { timeout: 15000, stdio: 'pipe' });
                    console.log('[supervisor] started dsh-web via systemd (fallback)');
                    return;
                }
                catch { }
                // Last fallback: detached direct node (portable — sources nvm directly, falls back to system node)
                try {
                    const harnessRoot = resolveDeepseekHarnessDir();
                    const logPath = path.join(os.homedir(), '.dsh/dsh-web.log');
                    execSync(`setsid nohup bash -c 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; cd ${JSON.stringify(harnessRoot)} && exec node --import tsx/esm apps/cli/src/bin.ts web --no-open >> ${JSON.stringify(logPath)} 2>&1' &`, { timeout: 5000 });
                    console.log('[supervisor] started dsh-web via nohup fallback (direct node, portable)');
                }
                catch (e) {
                    throw new Error(`restartWeb failed: ${e?.message ?? String(e)}`);
                }
            },
            notify: async (msg) => console.log(`[notify] ${msg}`),
            intervalMs: 3000,
        });
        supervisor.start();
        // keep process alive
        await new Promise(() => { });
    }
    console.log(`unknown command: ${cmd} — try --help`);
}
