import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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
                            // also check nested reason
                            if (obj.data?.reason?.kind === 'interrupted' || line.toLowerCase().includes('interrupted')) {
                                found = true;
                                break;
                            }
                        }
                        catch {
                            // if not JSON, fallback to string match
                            found = true;
                            break;
                        }
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
