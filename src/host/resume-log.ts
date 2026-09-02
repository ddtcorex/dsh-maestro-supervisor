import { appendFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Durable out-of-band resume log (`~/.dsh/.supervisor/resume.log.jsonl`).
 *
 * The in-tree supervisor's `ctx.logger` output does not reach `dsh-web.log`
 * (it goes to the per-session console), which made every `agents.resume`
 * failure invisible on real machines — the 2026-09-02 investigation only
 * recovered the pattern ("last successful continue 12:00Z, then 5 restarts
 * with none", `lastResumeProbe: null`, unconsumed intents) by scanning the
 * session logs. This append-only JSONL sidecar gives a machine-local audit
 * trail of resume outcomes that survives no matter where plugin logs land.
 * Never throws: a write failure must not break the resume path.
 */
export interface ResumeLogEntry {
  ts: number
  sessionId?: string
  kind: 'scan' | 'resume-failed' | 'resumed' | 'no-agent'
  error?: string
  detail?: string
  scanned?: number
  interrupted?: string[]
}

export function resumeLogPath(): string {
  return join(homedir(), '.dsh', '.supervisor', 'resume.log.jsonl')
}

export function appendResumeLog(entry: ResumeLogEntry): void {
  try {
    const p = resumeLogPath()
    mkdirSync(join(homedir(), '.dsh', '.supervisor'), { recursive: true })
    appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8')
    try { chmodSync(p, 0o600) } catch {}
  } catch {}
}