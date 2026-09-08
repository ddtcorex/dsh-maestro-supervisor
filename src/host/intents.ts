import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Durable self-restart intent sidecar written by `dsh_web_restart`
 * (`~/.dsh/.supervisor/intents/<sessionId>.json`, mode 600). Consumed by
 * auto-resume so a session that requested the restart is resumed with a
 * contextual message instead of the generic "outcome unknown" recovery text.
 */
export interface RestartIntent { ts: number; sessionId?: string; reason?: string }

export function intentsDir(): string {
  return join(homedir(), '.dsh', '.supervisor', 'intents')
}

export function intentPath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(intentsDir(), `${safe}.json`)
}

export function readIntent(sessionId: string): RestartIntent | undefined {
  try {
    const p = intentPath(sessionId)
    if (!existsSync(p)) return undefined
    return JSON.parse(readFileSync(p, 'utf8')) as RestartIntent
  } catch { return undefined }
}

export function consumeIntent(sessionId: string): void {
  try { unlinkSync(intentPath(sessionId)) } catch {}
}

/**
 * Post-swap outcome written by the supervisor daemon after acting on a
 * restart request (`<sessionId>.outcome.json`, mode 600, same dir). Read by
 * `dsh_web_restart_status` so callers learn the new PID + HTTP status without
 * hand-probing `ss`/`curl`.
 */
export interface RestartOutcome {
  state: 'ok' | 'failed'
  oldPid?: number
  newPid?: number
  httpStatus?: number
  swappedAt: number
  error?: string
}

export function outcomePath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(intentsDir(), `${safe}.outcome.json`)
}

export function writeRestartOutcome(sessionId: string, outcome: RestartOutcome): void {
  try {
    mkdirSync(intentsDir(), { recursive: true })
    writeFileSync(outcomePath(sessionId), JSON.stringify(outcome), { encoding: 'utf8', mode: 0o600 })
  } catch {}
}

export function readRestartOutcome(sessionId: string): RestartOutcome | undefined {
  try {
    const p = outcomePath(sessionId)
    if (!existsSync(p)) return undefined
    return JSON.parse(readFileSync(p, 'utf8')) as RestartOutcome
  } catch { return undefined }
}