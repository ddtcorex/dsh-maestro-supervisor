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
import { findInterrupted as defaultFindInterrupted, findDanglingOpenTurns as defaultFindDanglingOpenTurns } from './resume.js';
export const inject = ['sessions', 'agents', 'connection'];
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
function getAutoResumeEnabled(config) {
    // The Cordis-supplied config (cordis.patch.yml's `config:` block, or whatever
    // the caller passes to apply()) is the highest-precedence source — it is an
    // explicit, per-install decision and must win over ambient env/files.
    if (typeof config?.autoResumeEnabled === 'boolean')
        return config.autoResumeEnabled;
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
function getResumeWithinMs(config) {
    // Same precedence rule as getAutoResumeEnabled: explicit config wins first.
    if (config?.autoResumeWithin !== undefined) {
        const raw = config.autoResumeWithin;
        if (typeof raw === 'number')
            return raw * 60 * 1000;
        if (typeof raw === 'string') {
            if (/^\d+$/.test(raw.trim()))
                return parseInt(raw.trim(), 10) * 60 * 1000;
            const v = parseDuration(raw);
            if (v !== undefined)
                return v;
        }
    }
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
export async function runAutoResume(ctx, opts = {}) {
    try {
        const doFind = opts.findInterrupted ?? defaultFindInterrupted;
        const doFindDangling = opts.findDanglingOpenTurns ?? defaultFindDanglingOpenTurns;
        const doResume = opts.resumeInterrupted ?? resumeInterrupted;
        if (!getAutoResumeEnabled(opts?.config)) {
            ctx.logger?.info?.('[supervisor] auto-resume disabled — skip');
            return;
        }
        const withinMs = getResumeWithinMs(opts?.config);
        const { scanned, interrupted } = await doFind(undefined, { withinMs });
        // Only safe to treat a dangling open turn as crashed right after a fresh
        // boot, when this process is the sole live owner of these sessions —
        // exactly the context runAutoResume runs in (called once, 8s after
        // apply()). resumeInterrupted()'s own "already live" check additionally
        // protects any id that happens to be live in *this* process already.
        let dangling = [];
        try {
            dangling = (await doFindDangling(undefined, { withinMs })).interrupted;
        }
        catch (e) {
            ctx.logger?.warn?.(`[supervisor] auto-resume: dangling-open-turn scan failed, continuing with closed-turn results only: ${e?.message ?? String(e)}`);
        }
        const merged = Array.from(new Set([...interrupted, ...dangling]));
        if (!merged.length) {
            ctx.logger?.info?.(`[supervisor] auto-resume: 0/${scanned} interrupted within ${withinMs}ms — nothing to do`);
            return;
        }
        ctx.logger?.info?.(`[supervisor] auto-resume: ${merged.length}/${scanned} interrupted within ${withinMs}ms: ${merged.slice(0, 3).join(', ')}`);
        await doResume(ctx, merged);
    }
    catch (e) {
        try {
            ctx.logger?.warn?.(`[supervisor] auto-resume error: ${e?.message ?? String(e)}`);
        }
        catch { }
    }
}
async function repairEmptyBashCalls(sessionId, ctx) {
    try {
        const { execSync } = await import('node:child_process');
        const { homedir } = await import('node:os');
        const { join } = await import('node:path');
        const fs = await import('node:fs');
        const { zstdCompress } = await import('node:zlib');
        const { promisify } = await import('node:util');
        const { constants } = await import('node:zlib');
        const zstdCompressAsync = promisify(zstdCompress);
        const root = join(homedir(), '.dsh/sessions');
        let foundPath;
        for (const proj of fs.readdirSync(root)) {
            const p = join(root, proj, sessionId, 'session.jsonl.zstd');
            try {
                if (fs.statSync(p).isFile()) {
                    foundPath = p;
                    break;
                }
            }
            catch { }
            try {
                for (const sessDir of fs.readdirSync(join(root, proj))) {
                    const cand = join(root, proj, sessDir, 'session.jsonl.zstd');
                    try {
                        if (fs.existsSync(cand) && fs.readFileSync(cand).slice(0, 500).toString().includes(sessionId)) {
                            foundPath = cand;
                            break;
                        }
                    }
                    catch { }
                }
            }
            catch { }
            if (foundPath)
                break;
        }
        if (!foundPath)
            return;
        // Decompress via zstd CLI (handles concatenated frames)
        let text;
        try {
            text = execSync(`zstd -d -c ${JSON.stringify(foundPath)}`, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
        }
        catch {
            return;
        }
        const lines = text.split('\n').filter((l) => l.trim().length > 0);
        if (!lines.length)
            return;
        let header;
        try {
            header = JSON.parse(lines[0]);
        }
        catch {
            return;
        }
        if (header?.type !== 'session')
            return;
        const events = [];
        const toRemove = new Set();
        for (let i = 1; i < lines.length; i++) {
            try {
                events.push(JSON.parse(lines[i]));
            }
            catch {
                toRemove.add(i - 1);
            }
        }
        // Find empty bash calls (arguments === "{}" or empty object)
        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            if (e?.type === 'tool/call' && e?.data?.name === 'bash') {
                const args = e.data?.arguments;
                let isEmpty = false;
                if (typeof args === 'string') {
                    try {
                        isEmpty = Object.keys(JSON.parse(args)).length === 0;
                    }
                    catch {
                        isEmpty = args.trim() === '{}';
                    }
                }
                else if (typeof args === 'object' && args !== null)
                    isEmpty = Object.keys(args).length === 0;
                if (isEmpty) {
                    toRemove.add(i);
                    const cid = e.data?.callId;
                    for (let j = i + 1; j < events.length; j++) {
                        const r = events[j];
                        if (r?.type === 'tool/result' && (r?.data?.callId === cid || r?.data?.message?.source?.callId === cid)) {
                            toRemove.add(j);
                            break;
                        }
                    }
                }
            }
        }
        if (toRemove.size === 0)
            return;
        const filtered = events.filter((_, idx) => !toRemove.has(idx));
        const headerLine = JSON.stringify(header) + '\n';
        const bodyLines = filtered.map((e) => JSON.stringify(e)).join('\n') + '\n';
        const hf = await zstdCompressAsync(Buffer.from(headerLine), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
        const bf = await zstdCompressAsync(Buffer.from(bodyLines), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
        const out = Buffer.concat([hf, bf]);
        const bak = foundPath + '.bak-emptybash-auto.' + Date.now();
        fs.copyFileSync(foundPath, bak);
        fs.writeFileSync(foundPath, out);
        ctx.logger?.info?.(`[supervisor] auto-repair: removed ${toRemove.size} empty bash calls for ${sessionId} (bak ${bak})`);
    }
    catch (e) {
        ctx.logger?.warn?.(`[supervisor] auto-repair empty bash failed for ${sessionId}: ${e?.message ?? String(e)}`);
    }
}
export async function resumeInterrupted(ctx, ids) {
    const resumed = [];
    for (const id of ids) {
        try {
            const sessionId = id.split('/').pop();
            // Auto-repair empty bash calls before resume (prevents unknown tool loop)
            await repairEmptyBashCalls(sessionId, ctx);
            const agents = ctx.get?.('agents') ?? ctx.agents;
            let agent = agents?.get?.(sessionId);
            if (agent === undefined) {
                const { SessionId } = await import('@deepseek-ai/dsh-session').catch(() => ({ SessionId: (s) => s }));
                const sid = SessionId ? SessionId(sessionId) : sessionId;
                const persistence = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence;
                let agentOptions;
                try {
                    const loaded = await persistence?.load?.(sessionId);
                    const context = Array.isArray(loaded?.events)
                        ? [...loaded.events].reverse().find((event) => event?.type === 'request/context')?.data
                        : undefined;
                    if (typeof context?.provider === 'string' && typeof context?.model === 'string') {
                        agentOptions = { provider: context.provider, model: context.model };
                    }
                }
                catch (e) {
                    ctx.logger?.warn?.(`[supervisor] auto-resume: could not recover route for ${id}: ${e?.message ?? String(e)}`);
                }
                const handle = await agents?.resume?.({
                    resumeSessionId: sid,
                    ...(agentOptions === undefined ? {} : { agentOptions }),
                });
                agent = handle?.agent;
                if (agent !== undefined)
                    ctx.logger?.info?.(`[supervisor] auto-resume: re-attached agent for ${id}`);
            }
            if (typeof agent?.followup !== 'function') {
                ctx.logger?.warn?.(`[supervisor] auto-resume: no live agent available for ${id}`);
                continue;
            }
            const { createUserMessage } = await import('@deepseek-ai/dsh-llm').catch(() => ({
                createUserMessage: (input) => ({ ...input, role: 'user', id: crypto.randomUUID() }),
            }));
            agent.followup(createUserMessage({
                content: [{ type: 'text', text: 'continue' }],
                source: { kind: 'user' },
            }));
            resumed.push(id);
            ctx.logger?.info?.(`[supervisor] auto-resume: sent continue trigger for ${id}`);
        }
        catch (e) {
            ctx.logger?.warn?.(`[supervisor] auto-resume failed ${id}: ${e?.message ?? String(e)}`);
        }
    }
    return resumed;
}
export function createResumeRpcHandler(ctx, opts = {}) {
    const resume = opts.resumeInterrupted ?? resumeInterrupted;
    return async (endpoint, payload, _signal) => {
        if (endpoint === 'scan') {
            const withinMs = typeof payload?.withinMs === 'number'
                ? payload.withinMs
                : getResumeWithinMs(opts.config);
            return { ok: true, value: await defaultFindInterrupted(undefined, { withinMs }) };
        }
        if (endpoint !== 'resume') {
            return { ok: false, error: { code: 'bad-request', message: `unsupported endpoint: ${endpoint}` } };
        }
        const ids = Array.isArray(payload?.ids)
            ? payload.ids.filter((id) => typeof id === 'string' && id.length > 0)
            : [];
        if (!ids.length) {
            return { ok: false, error: { code: 'bad-request', message: 'resume requires at least one session id' } };
        }
        return { ok: true, value: { resumed: await resume(ctx, ids) } };
    };
}
export function apply(ctx, config = {}) {
    // The whole body is wrapped: per AGENTS.md, apply() must never throw
    // synchronously or let a rejected promise escape, no matter what fails
    // (ctx.effect missing/throwing, RPC registration throwing, or even the
    // error-reporting logger call itself throwing).
    try {
        ctx.effect(() => {
            let disposed = false;
            let timer = null;
            timer = setTimeout(() => {
                if (disposed)
                    return;
                runAutoResume(ctx, { config }).catch(() => {
                    // runAutoResume already never rejects, but guard the .catch itself is a no-op safety net
                });
            }, 8000);
            let disposeRpc;
            try {
                const conn = ctx.connection ?? ctx.get?.('connection');
                if (conn?.rpc?.handle) {
                    disposeRpc = conn.rpc.handle('/dsh-maestro-supervisor-resume', createResumeRpcHandler(ctx, { config }), { authority: 'loopback' });
                }
            }
            catch (e) {
                try {
                    ctx.logger?.warn?.(`[supervisor] auto-resume RPC registration failed: ${e?.message ?? String(e)}`);
                }
                catch { }
            }
            return () => {
                disposed = true;
                if (timer)
                    clearTimeout(timer);
                if (disposeRpc) {
                    try {
                        disposeRpc();
                    }
                    catch { }
                }
            };
        }, 'supervisor:auto-resume');
    }
    catch (e) {
        try {
            ctx.logger?.warn?.(`[supervisor] auto-resume apply() failed: ${e?.message ?? String(e)}`);
        }
        catch { }
    }
}
