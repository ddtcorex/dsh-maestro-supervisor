import { checkPlannedRestart } from './restart-guards.js';
import { execSync as execSyncImpl } from 'node:child_process';
export function getActiveEnterMs() {
    if (process.env.VITEST)
        return undefined;
    try {
        const out = execSyncImpl('systemctl --user show -p ActiveEnterTimestampMonotonic dsh-web.service 2>/dev/null', { encoding: 'utf8' });
        const m = out.match(/ActiveEnterTimestampMonotonic=(\d+)/);
        if (m)
            return Number(m[1]);
    }
    catch { }
    return undefined;
}
export function getActiveEnterWallMs() {
    if (process.env.VITEST)
        return undefined;
    try {
        const out = execSyncImpl('systemctl --user show -p ActiveEnterTimestamp dsh-web.service 2>/dev/null', { encoding: 'utf8' });
        const m = out.match(/ActiveEnterTimestamp=(.+)/);
        if (m) {
            const s = m[1].trim();
            if (!s || s === 'n/a')
                return undefined;
            const ms = Date.parse(s);
            if (!Number.isNaN(ms))
                return ms;
        }
    }
    catch { }
    return undefined;
}
function isRecentlyStarted(opts, wallMs) {
    if (process.env.VITEST)
        return false;
    const now = Date.now();
    // 30s grace after ActiveEnterTimestamp (wall clock) — covers manual systemctl start without marker
    const wall = wallMs ?? (() => {
        try {
            const fn = opts.getActiveEnterWallMs;
            if (typeof fn === 'function')
                return fn();
            return getActiveEnterWallMs();
        }
        catch {
            return undefined;
        }
    })();
    if (typeof wall === 'number' && now - wall < 30000)
        return true;
    return false;
}
const ERROR_PATTERNS = [
    'ERR_MODULE_NOT_FOUND',
    'ERR_PNPM',
    'assertChannel',
    'unhandledRejection',
    'SyntaxError',
    'YAMLParseError',
    'ParseError',
    'YAML',
    'JSON',
    'corrupted',
    'allowBuilds',
    'Cannot find module',
    'Failed to load',
    'EADDRINUSE',
    'address already in use',
];
export async function pollHealth(opts = {}) {
    // 5s was too tight for a busy plugin-tree boot: a lone AbortError from a slow
    // (but otherwise fine) response was indistinguishable from a real crash, and
    // combined with a low down-threshold this caused a self-sustaining restart
    // loop (see Supervisor.downThreshold). 12s gives boot room without masking
    // a genuinely dead process for long.
    const fetchFn = opts.fetch ?? defaultFetch(opts.url ?? 'http://127.0.0.1:3080/', opts.timeoutMs ?? 12000);
    const psAliveFn = opts.psAlive ?? defaultPsAlive;
    const logTailFn = opts.logTail ?? defaultLogTail;
    let httpCode;
    let fetchError;
    try {
        const res = await fetchFn();
        httpCode = res.status;
        // 401 is healthy: dsh web is up but requires browser token (since 0.1.2). Only 5xx / network errors are down.
        if (res.status !== 200 && res.status !== 401) {
            fetchError = `http ${res.status}`;
        }
    }
    catch (e) {
        fetchError = e?.message ?? String(e);
    }
    let logContent = '';
    try {
        logContent = await logTailFn();
    }
    catch {
        // ignore log read errors
    }
    // Suppression gate: during 30s planned-restart window, boot transients are expected.
    // Fetch failures are treated as suppressed (up:true), and log scanning is windowed.
    const suppressed = checkPlannedRestart();
    const recentlyStarted = isRecentlyStarted(opts);
    const graceActive = suppressed || recentlyStarted;
    // ActiveEnterTimestampMonotonic lookup — primary filter source; fallback to last success window
    let activeEnterMs;
    try {
        const fn = opts.getActiveEnterMs ?? getActiveEnterMs;
        activeEnterMs = fn();
        void activeEnterMs;
    }
    catch {
        activeEnterMs = undefined;
    }
    let logError;
    // Filter logTail to only consider lines after ActiveEnterTimestamp.
    // Fallback: last 200 lines after last "dsh web: http" success marker (log is append-only).
    const lines = logContent.split('\n');
    const lowerLines = lines.map(l => l.toLowerCase());
    // find last success marker
    let lastSuccessIdx = -1;
    for (let i = lowerLines.length - 1; i >= 0; i--) {
        if (lowerLines[i].includes('dsh web: http')) {
            lastSuccessIdx = i;
            break;
        }
    }
    let scanLines;
    let scanLower;
    if (lastSuccessIdx !== -1) {
        const after = lines.slice(lastSuccessIdx + 1);
        const afterLower = lowerLines.slice(lastSuccessIdx + 1);
        // keep only last 200 lines after success (fallback window)
        if (after.length > 200) {
            scanLines = after.slice(-200);
            scanLower = afterLower.slice(-200);
        }
        else {
            scanLines = after;
            scanLower = afterLower;
        }
        // If ActiveEnter is available, the same window applies — old EADDRINUSE before restart
        // is before the success marker and thus excluded. No extra timestamp->line mapping needed.
    }
    else {
        // no success marker: consider last 200 lines total (both primary and fallback)
        if (lines.length > 200) {
            scanLines = lines.slice(-200);
            scanLower = lowerLines.slice(-200);
        }
        else {
            scanLines = lines;
            scanLower = lowerLines;
        }
    }
    // If ActiveEnter lookup succeeded/failed, we already applied the fallback window.
    // When system has no success marker and no ActiveEnter, scanLines is still last 200.
    let lastErrorIdx = -1;
    let matchedLine = '';
    for (let i = scanLines.length - 1; i >= 0; i--) {
        const lower = scanLower[i];
        for (const pat of ERROR_PATTERNS) {
            if (lower.includes(pat.toLowerCase())) {
                lastErrorIdx = i;
                matchedLine = scanLines[i].trim().slice(0, 500);
                break;
            }
        }
        if (lastErrorIdx !== -1)
            break;
    }
    if (lastErrorIdx !== -1) {
        // Within the windowed view, if a success appears after the error it would have been before the slice,
        // but check anyway for safety (error before success within window)
        let hasSuccessAfter = false;
        for (let i = lastErrorIdx + 1; i < scanLines.length; i++) {
            if (scanLower[i].includes('dsh web: http')) {
                hasSuccessAfter = true;
                break;
            }
        }
        if (!hasSuccessAfter)
            logError = matchedLine;
    }
    else if (suppressed) {
        // suppressed window with no windowed error — ensure stale errors before success are ignored
        // (already handled by windowing)
    }
    // Legacy full-scan fallback for hasSuccessAfter across original lines when no windowed error
    // but original had error before success — already suppressed by windowing, no need to re-check.
    // Distinguish FULL (http !=200) vs DEGRADED (http 200 but log has plugin error)
    // Suppression: during 30s grace (planned-restart OR recently started), transient fetch failures are not a crash
    if (fetchError) {
        if (graceActive) {
            // treat fetch failed / http 404 as up:true suppressed (don't write error) — also doubles effective downThreshold
            return {
                up: true,
                httpCode,
                logTail: logContent.slice(-5000),
            };
        }
        return {
            up: false,
            httpCode,
            error: logError ? `${fetchError} + ${logError}` : fetchError,
            degraded: false,
            logTail: logContent.slice(-5000),
        };
    }
    // During grace, a windowed logError that is still present is considered stale/boot transient
    // as well — treat as up to avoid double restart. The fallback window already filters pre-restart errors.
    if (graceActive && logError) {
        // Effective downThreshold doubling is handled by supervisor, but health also suppresses log tail
        return {
            up: true,
            httpCode,
            logTail: logContent.slice(-5000),
        };
    }
    if (logError) {
        // EADDRINUSE is fatal even with http 200 — old process still holds 3080
        // and new start failed; treat as FULL down so supervisor kills + restarts.
        const lowerErr = logError.toLowerCase();
        const isFatalPortError = lowerErr.includes('eaddrinuse') || lowerErr.includes('address already in use');
        if (isFatalPortError) {
            return {
                up: false,
                httpCode,
                error: logError,
                degraded: false,
                logTail: logContent.slice(-5000),
            };
        }
        // http 200 but log error → DEGRADED (isolatable), not FULL
        if (httpCode === 200) {
            return {
                up: true,
                httpCode,
                error: logError,
                degraded: true,
                logTail: logContent.slice(-5000),
            };
        }
        return {
            up: false,
            httpCode,
            error: logError,
            degraded: false,
            logTail: logContent.slice(-5000),
        };
    }
    // Also check psAlive as secondary signal — if fetch ok but ps dead, still down
    try {
        const alive = await psAliveFn();
        if (!alive && httpCode === 200) {
            // fetch succeeded but ps says dead — likely stale, still consider up if http 200
        }
    }
    catch {
        // ignore
    }
    return { up: httpCode === 200 || httpCode === 401, httpCode, logTail: logContent.slice(-5000) };
}
function defaultFetch(url, timeoutMs) {
    return async () => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: controller.signal });
            return { status: res.status, text: async () => res.text() };
        }
        finally {
            clearTimeout(t);
        }
    };
}
async function defaultPsAlive() {
    // Check if any listener on 3080 exists via ss — fallback to true if ss unavailable
    try {
        const { execSync } = await import('node:child_process');
        const out = execSync('ss -tln 2>/dev/null || true', { encoding: 'utf-8' });
        return out.includes(':3080');
    }
    catch {
        return true;
    }
}
export async function collectLogTail() {
    try {
        const { readFileSync, existsSync, statSync } = await import('node:fs');
        const { homedir } = await import('node:os');
        const candidates = [
            `${homedir()}/.dsh/dsh-web.log`,
            `${homedir()}/.dsh/.supervisor/supervisor.log`,
            `${homedir()}/.dsh.log`,
        ];
        for (const logPath of candidates) {
            try {
                if (!existsSync(logPath))
                    continue;
                // avoid reading huge files fully — if >1MB, read tail via shell
                try {
                    const sz = statSync(logPath).size;
                    if (sz > 1024 * 1024) {
                        const { execSync } = await import('node:child_process');
                        const out = execSync(`tail -c 5000 ${JSON.stringify(logPath)} 2>/dev/null || cat ${JSON.stringify(logPath)} 2>/dev/null | tail -c 5000`, { encoding: 'utf-8', timeout: 2000 });
                        if (out)
                            return out.slice(-5000);
                    }
                }
                catch { }
                const content = readFileSync(logPath, 'utf-8');
                if (content && content.trim())
                    return content.slice(-5000);
            }
            catch { }
        }
        // fallback: try journalctl for the dsh-web or supervisor units (if running via systemd)
        try {
            const { execSync } = await import('node:child_process');
            const journal = execSync('journalctl --user -u dsh-web-supervisor --no-pager -n 100 2>/dev/null | tail -c 5000 || journalctl --user --no-pager -n 100 2>/dev/null | tail -c 5000 || true', { encoding: 'utf-8', timeout: 2000 });
            if (journal && journal.trim())
                return journal.slice(-5000);
        }
        catch { }
        return '';
    }
    catch {
        return '';
    }
}
async function defaultLogTail() {
    return collectLogTail();
}
