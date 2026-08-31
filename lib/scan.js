/**
 * Post-restart session scan: walk recent session logs under
 * <dshHome>/sessions/<project>/<session>/ and flag torn tails (a zstd frame
 * that fails to decode, or a plain-text log that is unreadable). Runs after
 * an intentional dsh-web restart so the supervisor can report whether any
 * in-flight session log was left truncated by the restart.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
async function decodeOk(file) {
    try {
        if (extname(file) === '.zstd') {
            execFileSync('zstd', ['-d', '-c', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
        }
        else {
            const { readFileSync } = await import('node:fs');
            readFileSync(file, 'utf8');
        }
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Scan session logs whose mtime falls within the window. A file whose decode
 * fails (torn zstd frame or unreadable plain text) is reported as torn. A
 * missing sessions root yields an empty scan, never an error.
 */
export async function scanSessions(dshHome, opts = {}) {
    const sessionsRoot = join(dshHome, 'sessions');
    const now = Date.now();
    const withinMs = opts.withinMs ?? 10 * 60 * 1000;
    const files = [];
    try {
        for (const proj of readdirSync(sessionsRoot)) {
            const projDir = join(sessionsRoot, proj);
            if (!statSync(projDir).isDirectory())
                continue;
            for (const sess of readdirSync(projDir)) {
                const sessDir = join(projDir, sess);
                if (!statSync(sessDir).isDirectory())
                    continue;
                for (const f of readdirSync(sessDir)) {
                    const name = basename(f);
                    if (!name.endsWith('.zstd') && !name.endsWith('.jsonl'))
                        continue;
                    const fp = join(sessDir, f);
                    let mtime = 0;
                    try {
                        mtime = statSync(fp).mtimeMs;
                    }
                    catch {
                        continue;
                    }
                    if (now - mtime > withinMs)
                        continue;
                    files.push(fp);
                }
            }
        }
    }
    catch { /* sessions root absent */ }
    const torn = [];
    for (const f of files) {
        if (!(await decodeOk(f)))
            torn.push(f);
    }
    return { scanned: files.length, torn };
}
