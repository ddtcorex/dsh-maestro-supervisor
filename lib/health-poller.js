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
    const fetchFn = opts.fetch ?? defaultFetch(opts.url ?? 'http://127.0.0.1:3080/', opts.timeoutMs ?? 5000);
    const psAliveFn = opts.psAlive ?? defaultPsAlive;
    const logTailFn = opts.logTail ?? defaultLogTail;
    let httpCode;
    let fetchError;
    try {
        const res = await fetchFn();
        httpCode = res.status;
        if (res.status !== 200) {
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
    let logError;
    const lowerLog = logContent.toLowerCase();
    for (const pat of ERROR_PATTERNS) {
        if (lowerLog.includes(pat.toLowerCase())) {
            // extract line containing pattern (case-insensitive)
            const line = logContent.split('\n').find(l => l.toLowerCase().includes(pat.toLowerCase())) ?? pat;
            logError = line.trim().slice(0, 500);
            break;
        }
    }
    // Distinguish FULL (http !=200) vs DEGRADED (http 200 but log has plugin error)
    if (fetchError) {
        return {
            up: false,
            httpCode,
            error: logError ? `${fetchError} + ${logError}` : fetchError,
            degraded: false,
            logTail: logContent.slice(-5000),
        };
    }
    if (logError) {
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
    return { up: httpCode === 200, httpCode, logTail: logContent.slice(-5000) };
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
