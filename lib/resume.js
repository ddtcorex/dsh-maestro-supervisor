import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
/**
 * Read the last ~20 lines of one session's raw log, applying the mtime
 * pre-filter before any (potentially expensive) zstd decompression: a
 * session log's mtime only advances when something is appended to it, so a
 * file older than `sinceMs` cannot contain anything within the window.
 * Shared by every raw-log scan below so the pre-filter (Critical: this
 * scan previously blocked the host event loop ~5.5s across 412 sessions on
 * a real machine before this filter existed) can't be accidentally
 * bypassed by a future scan variant.
 * @returns `undefined` when the session has no log file, or is filtered
 *   out by `sinceMs` — callers must treat that the same as "nothing found".
 */
async function readSessionTailLines(zstdPath, jsonlPath, sinceMs) {
    if (sinceMs !== undefined) {
        try {
            const statPath = fs.existsSync(zstdPath) ? zstdPath : (fs.existsSync(jsonlPath) ? jsonlPath : undefined);
            if (statPath) {
                const mtimeMs = fs.statSync(statPath).mtimeMs;
                if (mtimeMs < sinceMs)
                    return undefined;
            }
        }
        catch { }
    }
    if (fs.existsSync(zstdPath)) {
        const { execSync } = await import('node:child_process');
        const out = execSync(`zstd -d -c ${JSON.stringify(zstdPath)} 2>/dev/null | tail -20`, { encoding: 'utf-8' });
        return out.split('\n').filter(Boolean);
    }
    if (fs.existsSync(jsonlPath)) {
        const content = fs.readFileSync(jsonlPath, 'utf-8');
        return content.trim().split('\n').slice(-20);
    }
    return undefined;
}
export async function findInterrupted(dshHome, opts) {
    const home = dshHome ?? path.join(os.homedir(), '.dsh');
    const sessionsRoot = path.join(home, 'sessions');
    let scanned = 0;
    const interrupted = [];
    const now = Date.now();
    const withinMs = opts?.withinMs;
    const sinceMs = opts?.sinceMs ?? (withinMs !== undefined ? now - withinMs : undefined);
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
                    const lines = await readSessionTailLines(zstdPath, jsonlPath, sinceMs);
                    if (lines === undefined)
                        continue;
                    let found = false;
                    let foundTime;
                    for (let i = lines.length - 1; i >= 0; i--) {
                        const line = lines[i];
                        try {
                            const obj = JSON.parse(line);
                            foundTime = typeof obj.time === 'number' ? obj.time : undefined;
                            if (obj.type === 'turn/end' && obj.data?.reason?.kind === 'interrupted') {
                                found = true;
                                break;
                            }
                        }
                        catch { }
                    }
                    if (!found)
                        continue;
                    if (sinceMs !== undefined && foundTime !== undefined) {
                        if (foundTime < sinceMs)
                            continue; // too old
                    }
                    else if (sinceMs !== undefined && foundTime === undefined) {
                        // no timestamp, skip when filtering by time
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
/**
 * Detect sessions whose raw log ends with a `turn/start` that has no
 * matching `turn/end` anywhere later in the scanned tail — a dangling open
 * turn. Unlike {@link findInterrupted}, this needs no prior `persistence.load()`
 * call to have already synthesized a `turn/end interrupted` closer (DSH core
 * only writes that closer when something loads/prepares the specific
 * session — a genuinely fresh crash's raw log has no closer at all, only an
 * open turn). Safe to call ONLY right after a fresh `dsh web` boot, when
 * `dsh web` is the sole live process for these sessions — an open turn found
 * at that moment cannot belong to a still-running generation anywhere else.
 * Callers MUST additionally skip any id that is live in their own current
 * process (e.g. `ctx.sessions.get(id)`) before treating a match as crashed.
 */
export async function findDanglingOpenTurns(dshHome, opts) {
    const home = dshHome ?? path.join(os.homedir(), '.dsh');
    const sessionsRoot = path.join(home, 'sessions');
    let scanned = 0;
    const interrupted = [];
    const now = Date.now();
    const withinMs = opts?.withinMs;
    const sinceMs = opts?.sinceMs ?? (withinMs !== undefined ? now - withinMs : undefined);
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
                    const lines = await readSessionTailLines(zstdPath, jsonlPath, sinceMs);
                    if (lines === undefined)
                        continue;
                    let openTurn;
                    let openTurnTime;
                    for (const line of lines) {
                        try {
                            const obj = JSON.parse(line);
                            if (obj.type === 'turn/start' && typeof obj.data?.turn === 'number') {
                                openTurn = obj.data.turn;
                                openTurnTime = typeof obj.time === 'number' ? obj.time : undefined;
                            }
                            else if (obj.type === 'turn/end' && obj.data?.turn === openTurn) {
                                openTurn = undefined;
                                openTurnTime = undefined;
                            }
                        }
                        catch { }
                    }
                    if (openTurn === undefined)
                        continue;
                    if (sinceMs !== undefined) {
                        if (openTurnTime === undefined || openTurnTime < sinceMs)
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
export function parseDuration(s) {
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
