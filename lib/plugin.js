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
import { findInterrupted as defaultFindInterrupted } from './resume.js';
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
        const doResume = opts.resumeInterrupted ?? resumeInterrupted;
        if (!getAutoResumeEnabled(opts?.config)) {
            ctx.logger?.info?.('[supervisor] auto-resume disabled — skip');
            return;
        }
        const withinMs = getResumeWithinMs(opts?.config);
        const { scanned, interrupted } = await doFind(undefined, { withinMs });
        if (!interrupted.length) {
            ctx.logger?.info?.(`[supervisor] auto-resume: 0/${scanned} interrupted within ${withinMs}ms — nothing to do`);
            return;
        }
        ctx.logger?.info?.(`[supervisor] auto-resume: ${interrupted.length}/${scanned} interrupted within ${withinMs}ms: ${interrupted.slice(0, 3).join(', ')}`);
        await doResume(ctx, interrupted);
    }
    catch (e) {
        try {
            ctx.logger?.warn?.(`[supervisor] auto-resume error: ${e?.message ?? String(e)}`);
        }
        catch { }
    }
}
export async function resumeInterrupted(ctx, ids) {
    for (const id of ids) {
        try {
            const sessionId = id.split('/').pop();
            const exists = ctx.sessions?.get?.(sessionId);
            if (exists) {
                ctx.logger?.info?.(`[supervisor] auto-resume skip ${id} — already live`);
                continue;
            }
            const persistence = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence;
            if (persistence?.load) {
                try {
                    const loaded = await persistence.load(sessionId);
                    if (loaded?.events?.length) {
                        try {
                            const { SessionId } = await import('@deepseek-ai/dsh-session').catch(() => ({ SessionId: (s) => s }));
                            const sid = SessionId ? SessionId(sessionId) : sessionId;
                            const created = ctx.sessions?.create?.(sid, { seed: loaded.events, meta: loaded.meta ?? {} });
                            if (created)
                                ctx.logger?.info?.(`[supervisor] auto-resume: re-created session ${id} with ${loaded.events.length} events`);
                            try {
                                const agents = ctx.get?.('agents') ?? ctx.agents;
                                if (agents?.create && loaded.meta?.preset) {
                                    const handle = await agents.create({ sessionId: sid, preset: loaded.meta.preset });
                                    ctx.logger?.info?.(`[supervisor] auto-resume: agent re-attached for ${id}`);
                                    try {
                                        const { createUserMessage } = await import('@deepseek-ai/dsh-llm').catch(() => ({
                                            createUserMessage: (input) => ({ ...input, role: 'user', id: crypto.randomUUID() }),
                                        }));
                                        handle?.agent?.followup?.(createUserMessage({
                                            content: [{ type: 'text', text: 'continue' }],
                                            source: { kind: 'user' },
                                        }));
                                        ctx.logger?.info?.(`[supervisor] auto-resume: sent continue trigger for ${id}`);
                                    }
                                    catch (e) {
                                        ctx.logger?.warn?.(`[supervisor] auto-resume: continue trigger failed for ${id}: ${e?.message ?? String(e)}`);
                                    }
                                }
                            }
                            catch (e) {
                                ctx.logger?.warn?.(`[supervisor] auto-resume: agent create failed for ${id}: ${e?.message ?? String(e)}`);
                            }
                        }
                        catch (e) {
                            ctx.logger?.info?.(`[supervisor] auto-resume: session ${id} has ${loaded.events.length} events, would resume (create failed: ${e?.message ?? String(e)})`);
                        }
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
                    disposeRpc = conn.rpc.handle('/dsh-maestro-supervisor-resume', async (_endpoint, payload) => {
                        const within = payload?.withinMs ?? getResumeWithinMs(config);
                        return await defaultFindInterrupted(undefined, { withinMs: within });
                    }, { authority: 'loopback' });
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
