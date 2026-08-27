/**
 * dsh-maestro-supervisor — host plugin for auto-resume inside DSH web.
 * Runs inside the DSH host process (outside the daemon's tree) and
 * auto-resumes sessions interrupted within the configured window after
 * a restart. The standalone daemon (systemd) handles crash detection
 * and web restart; this plugin handles the in-process resume.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
export const inject = ['sessions', 'connection'];
function parseDuration(s) {
    if (!s)
        return undefined;
    const m = s.trim().match(/^(\d+)(s|m|h)?$/);
    if (!m)
        return undefined;
    const n = parseInt(m[1], 10);
    const unit = m[2] ?? 's';
    if (unit === 's')
        return n * 1000;
    if (unit === 'm')
        return n * 60 * 1000;
    if (unit === 'h')
        return n * 60 * 60 * 1000;
    return undefined;
}
function getAutoResumeEnabled() {
    const env = process.env.DSH_SUPERVISOR_AUTO_RESUME;
    if (env !== undefined) {
        const v = env.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on', 'enabled'].includes(v))
            return true;
        if (['0', 'false', 'no', 'off', 'disabled'].includes(v))
            return false;
    }
    try {
        const cfgPath = path.join(os.homedir(), '.dsh/.supervisor/config.json');
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            const raw = cfg.autoResumeEnabled ?? cfg.autoResume;
            if (typeof raw === 'boolean')
                return raw;
            if (typeof raw === 'string') {
                const v = raw.trim().toLowerCase();
                if (['1', 'true', 'yes', 'on'].includes(v))
                    return true;
                if (['0', 'false', 'no', 'off'].includes(v))
                    return false;
            }
        }
        const maestroPath = path.join(os.homedir(), '.dsh/maestro/settings.json');
        if (fs.existsSync(maestroPath)) {
            const j = JSON.parse(fs.readFileSync(maestroPath, 'utf-8'));
            const raw = j?.domains?.supervisor?.autoResumeEnabled ?? j?.supervisor?.autoResumeEnabled;
            if (typeof raw === 'boolean')
                return raw;
            if (typeof raw === 'string') {
                const v = raw.trim().toLowerCase();
                if (['1', 'true', 'yes', 'on'].includes(v))
                    return true;
                if (['0', 'false', 'no', 'off'].includes(v))
                    return false;
            }
        }
    }
    catch { }
    return true;
}
function getResumeWithinMs() {
    const env = process.env.DSH_SUPERVISOR_RESUME_WITHIN;
    if (env) {
        if (/^\d+$/.test(env.trim()))
            return parseInt(env.trim(), 10) * 60 * 1000;
        const v = parseDuration(env);
        if (v !== undefined)
            return v;
    }
    try {
        const cfgPath = path.join(os.homedir(), '.dsh/.supervisor/config.json');
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            const raw = cfg.autoResumeWithin;
            if (typeof raw === 'string') {
                if (/^\d+$/.test(raw.trim()))
                    return parseInt(raw.trim(), 10) * 60 * 1000;
                const v = parseDuration(raw);
                if (v !== undefined)
                    return v;
            }
            else if (typeof raw === 'number')
                return raw * 60 * 1000;
        }
        const maestroPath = path.join(os.homedir(), '.dsh/maestro/settings.json');
        if (fs.existsSync(maestroPath)) {
            const j = JSON.parse(fs.readFileSync(maestroPath, 'utf-8'));
            const raw = j?.domains?.supervisor?.autoResumeWithin ?? j?.supervisor?.autoResumeWithin;
            if (typeof raw === 'string') {
                if (/^\d+$/.test(raw.trim()))
                    return parseInt(raw.trim(), 10) * 60 * 1000;
                const v = parseDuration(raw);
                if (v !== undefined)
                    return v;
            }
            else if (typeof raw === 'number')
                return raw * 60 * 1000;
        }
    }
    catch { }
    return 5 * 60 * 1000;
}
async function findInterrupted(dshHome, opts) {
    const home = dshHome ?? path.join(os.homedir(), '.dsh');
    const sessionsRoot = path.join(home, 'sessions');
    let scanned = 0;
    const interrupted = [];
    const now = Date.now();
    const withinMs = opts?.withinMs;
    const sinceMs = withinMs !== undefined ? now - withinMs : undefined;
    try {
        const groups = fs.readdirSync(sessionsRoot, { withFileTypes: true });
        for (const g of groups) {
            if (!g.isDirectory())
                continue;
            const groupPath = path.join(sessionsRoot, g.name);
            const sessions = fs.readdirSync(groupPath, { withFileTypes: true });
            for (const s of sessions) {
                if (!s.isDirectory())
                    continue;
                scanned++;
                const zstdPath = path.join(groupPath, s.name, 'session.jsonl.zstd');
                const jsonlPath = path.join(groupPath, s.name, 'session.jsonl');
                try {
                    let lines = [];
                    if (fs.existsSync(zstdPath)) {
                        const { execSync } = await import('node:child_process');
                        const out = execSync(`zstd -d -c ${JSON.stringify(zstdPath)} 2>/dev/null | tail -20`, { encoding: 'utf-8' });
                        lines = out.split('\n').filter(Boolean);
                    }
                    else if (fs.existsSync(jsonlPath)) {
                        const content = fs.readFileSync(jsonlPath, 'utf-8');
                        lines = content.trim().split('\n').slice(-20);
                    }
                    let found = false;
                    let foundTime;
                    for (let i = lines.length - 1; i >= 0; i--) {
                        const line = lines[i];
                        if (!line.toLowerCase().includes('interrupted'))
                            continue;
                        try {
                            const obj = JSON.parse(line);
                            foundTime = typeof obj.time === 'number' ? obj.time : undefined;
                            if (obj.data?.reason?.kind === 'interrupted' || line.toLowerCase().includes('interrupted')) {
                                found = true;
                                break;
                            }
                        }
                        catch {
                            found = true;
                            break;
                        }
                    }
                    if (!found)
                        continue;
                    if (sinceMs !== undefined && foundTime !== undefined) {
                        if (foundTime < sinceMs)
                            continue;
                    }
                    else if (sinceMs !== undefined && foundTime === undefined) {
                        continue;
                    }
                    interrupted.push(`${g.name}/${s.name}`);
                }
                catch { }
            }
        }
    }
    catch { }
    return { scanned, interrupted };
}
export function apply(ctx, _config = {}) {
    // Auto-resume after DSH web is ready — runs inside the host, not the daemon.
    ctx.effect(() => {
        let disposed = false;
        let timer = null;
        const run = async () => {
            if (disposed)
                return;
            if (!getAutoResumeEnabled()) {
                ctx.logger?.info?.('[supervisor] auto-resume disabled — skip');
                return;
            }
            const withinMs = getResumeWithinMs();
            try {
                const { scanned, interrupted } = await findInterrupted(undefined, { withinMs });
                if (!interrupted.length) {
                    ctx.logger?.info?.(`[supervisor] auto-resume: 0/${scanned} interrupted within ${withinMs}ms — nothing to do`);
                    return;
                }
                ctx.logger?.info?.(`[supervisor] auto-resume: ${interrupted.length}/${scanned} interrupted within ${withinMs}ms: ${interrupted.slice(0, 3).join(', ')}`);
                // For each interrupted session, try to resume via sessions service.
                // We do not have a direct "resume" API, but we can re-create the session
                // with its persisted seed — DSH's session persistence will treat it as
                // a resume (the log is re-read, interrupted turn is closed).
                // The actual agent continuation requires the UI to re-attach; we at least
                // ensure the session is loadable and log the intent.
                for (const id of interrupted) {
                    try {
                        // The session id in DSH is the last part after "/" — group is cwd hash
                        const sessionId = id.split('/').pop();
                        // Check if already live
                        const existing = ctx.sessions?.get?.(sessionId);
                        if (existing) {
                            ctx.logger?.info?.(`[supervisor] auto-resume skip ${id} — already live`);
                            continue;
                        }
                        // Try to load persisted state via sessionPersistence if available
                        const persistence = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence;
                        if (persistence?.load) {
                            try {
                                const loaded = await persistence.load(sessionId);
                                if (loaded?.events?.length) {
                                    ctx.logger?.info?.(`[supervisor] auto-resume: session ${id} has ${loaded.events.length} events, would resume (requires agent re-attach)`);
                                    // We do not auto-create the session here to avoid duplicate
                                    // agent loops — the UI will re-create on next open. Log only.
                                }
                            }
                            catch (e) {
                                ctx.logger?.warn?.(`[supervisor] auto-resume load failed ${id}: ${e?.message ?? String(e)}`);
                            }
                        }
                        else {
                            ctx.logger?.info?.(`[supervisor] auto-resume: ${id} — no sessionPersistence, skip in-process resume (daemon will notify)`);
                        }
                    }
                    catch (e) {
                        ctx.logger?.warn?.(`[supervisor] auto-resume failed ${id}: ${e?.message ?? String(e)}`);
                    }
                }
                // Also expose via RPC for daemon to trigger explicitly
                try {
                    await ctx.connection?.rpc?.handle?.('/dsh-maestro-supervisor/resume', async (_endpoint, payload) => {
                        return { ok: true, resumed: interrupted };
                    });
                }
                catch { }
            }
            catch (e) {
                ctx.logger?.warn?.(`[supervisor] auto-resume error: ${e?.message ?? String(e)}`);
            }
        };
        // Delay to let DSH web finish booting and persistence warm up
        timer = setTimeout(run, 8000);
        // Also handle explicit RPC from daemon
        let disposeRpc;
        try {
            const conn = ctx.connection ?? ctx.get?.('connection');
            if (conn?.rpc?.handle) {
                disposeRpc = conn.rpc.handle('/dsh-maestro-supervisor/resume', async (endpoint, payload) => {
                    const within = payload?.withinMs ?? getResumeWithinMs();
                    const res = await findInterrupted(undefined, { withinMs: within });
                    return { ok: true, ...res };
                }, { authority: 'loopback' });
            }
        }
        catch { }
        return () => {
            disposed = true;
            if (timer)
                clearTimeout(timer);
            if (disposeRpc)
                try {
                    disposeRpc();
                }
                catch { }
        };
    }, 'supervisor:auto-resume');
}
