import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
export function intentsDir() {
    return join(homedir(), '.dsh', '.supervisor', 'intents');
}
export function intentPath(sessionId) {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
    return join(intentsDir(), `${safe}.json`);
}
export function readIntent(sessionId) {
    try {
        const p = intentPath(sessionId);
        if (!existsSync(p))
            return undefined;
        return JSON.parse(readFileSync(p, 'utf8'));
    }
    catch {
        return undefined;
    }
}
export function consumeIntent(sessionId) {
    try {
        unlinkSync(intentPath(sessionId));
    }
    catch { }
}
export function outcomePath(sessionId) {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
    return join(intentsDir(), `${safe}.outcome.json`);
}
export function writeRestartOutcome(sessionId, outcome) {
    try {
        mkdirSync(intentsDir(), { recursive: true });
        writeFileSync(outcomePath(sessionId), JSON.stringify(outcome), { encoding: 'utf8', mode: 0o600 });
    }
    catch { }
}
export function readRestartOutcome(sessionId) {
    try {
        const p = outcomePath(sessionId);
        if (!existsSync(p))
            return undefined;
        return JSON.parse(readFileSync(p, 'utf8'));
    }
    catch {
        return undefined;
    }
}
