import { appendFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
export function resumeLogPath() {
    return join(homedir(), '.dsh', '.supervisor', 'resume.log.jsonl');
}
export function appendResumeLog(entry) {
    try {
        const p = resumeLogPath();
        mkdirSync(join(homedir(), '.dsh', '.supervisor'), { recursive: true });
        appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
        try {
            chmodSync(p, 0o600);
        }
        catch { }
    }
    catch { }
}
