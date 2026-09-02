import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export interface ResumeResult {
  scanned: number
  interrupted: string[]
}

export interface FindInterruptedOpts {
  withinMs?: number // only sessions interrupted within this window from now
  sinceMs?: number // or since this absolute epoch ms
}

/**
 * Read the last ~100 lines of one session's raw log, applying the mtime
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
async function readSessionTailLines(zstdPath: string, jsonlPath: string, sinceMs: number | undefined): Promise<string[] | undefined> {
  if (sinceMs !== undefined) {
    try {
      const statPath = fs.existsSync(zstdPath) ? zstdPath : (fs.existsSync(jsonlPath) ? jsonlPath : undefined)
      if (statPath) {
        const mtimeMs = fs.statSync(statPath).mtimeMs
        if (mtimeMs < sinceMs) return undefined
      }
    } catch {}
  }
  if (fs.existsSync(zstdPath)) {
    const { execSync } = await import('node:child_process')
    const out = execSync(`zstd -d -c ${JSON.stringify(zstdPath)} 2>/dev/null | tail -100`, { encoding: 'utf-8' })
    return out.split('\n').filter(Boolean)
  }
  if (fs.existsSync(jsonlPath)) {
    const content = fs.readFileSync(jsonlPath, 'utf-8')
    return content.trim().split('\n').slice(-100)
  }
  return undefined
}

export async function findInterrupted(dshHome?: string, opts?: FindInterruptedOpts): Promise<ResumeResult> {
  const home = dshHome ?? path.join(os.homedir(), '.dsh')
  const sessionsRoot = path.join(home, 'sessions')
  let scanned = 0
  const interrupted: string[] = []
  const now = Date.now()
  const withinMs = opts?.withinMs
  const sinceMs = opts?.sinceMs ?? (withinMs !== undefined ? now - withinMs : undefined)
  try {
    const groups = fs.readdirSync(sessionsRoot, { withFileTypes: true })
    for (const g of groups) {
      if (!g.isDirectory()) continue
      const groupPath = path.join(sessionsRoot, g.name)
      const sessions = fs.readdirSync(groupPath, { withFileTypes: true })
      for (const s of sessions) {
        if (!s.isDirectory()) continue
        scanned++
        const zstdPath = path.join(groupPath, s.name, 'session.jsonl.zstd')
        const jsonlPath = path.join(groupPath, s.name, 'session.jsonl')
        try {
          const lines = await readSessionTailLines(zstdPath, jsonlPath, sinceMs)
          if (lines === undefined) continue
          let found = false
          let foundTime: number | undefined
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i]
            try {
              const obj = JSON.parse(line)
              foundTime = typeof obj.time === 'number' ? obj.time : undefined
              if (obj.type === 'turn/end' && obj.data?.reason?.kind === 'interrupted') { found = true; break }
            } catch {}
          }
          if (!found) continue
          if (sinceMs !== undefined && foundTime !== undefined) {
            if (foundTime < sinceMs) continue // too old
          } else if (sinceMs !== undefined && foundTime === undefined) {
            // no timestamp, skip when filtering by time
            continue
          }
          interrupted.push(`${g.name}/${s.name}`)
        } catch {}
      }
    }
  } catch {}
  return { scanned, interrupted }
}

/**
 * Read the entire log for a recent session (mtime within window) to find an
 * open turn that may be far from the tail. Used only by
 * {@link findDanglingOpenTurns}, which must see the last `turn/start`
 * even when the file is 1906 lines and the open turn is at line 2 (subagent
 * `b6487e33` had its only `turn/start` at seq 6, missed by `tail -100`).
 * The mtime pre-filter ensures this full decompression runs only for
 * recent sessions (within 5m, typically 1-2 files), not for all 425.
 */
async function readSessionAllLines(zstdPath: string, jsonlPath: string, sinceMs: number | undefined): Promise<string[] | undefined> {
  if (sinceMs !== undefined) {
    try {
      const statPath = fs.existsSync(zstdPath) ? zstdPath : (fs.existsSync(jsonlPath) ? jsonlPath : undefined)
      if (statPath) {
        const mtimeMs = fs.statSync(statPath).mtimeMs
        if (mtimeMs < sinceMs) return undefined
      }
    } catch {}
  }
  if (fs.existsSync(zstdPath)) {
    const { execSync } = await import('node:child_process')
    // maxBuffer must exceed the decompressed size of any real session log —
    // worker sessions decode to 8-23MB while execSync's default 1MB would
    // throw ENOBUFS and silently drop the session from every scan that needs
    // the full file (findDanglingOpenTurns). Use 64MB to leave headroom.
    const out = execSync(`zstd -d -c ${JSON.stringify(zstdPath)} 2>/dev/null`, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    return out.split('\n').filter(Boolean)
  }
  if (fs.existsSync(jsonlPath)) {
    const content = fs.readFileSync(jsonlPath, 'utf-8')
    return content.trim().split('\n').filter(Boolean)
  }
  return undefined
}

/**
 * Detect sessions whose raw log ends with a `turn/start` that has no
 * matching `turn/end` anywhere later in the scanned log — a dangling open
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
export async function findDanglingOpenTurns(dshHome?: string, opts?: FindInterruptedOpts): Promise<ResumeResult> {
  const home = dshHome ?? path.join(os.homedir(), '.dsh')
  const sessionsRoot = path.join(home, 'sessions')
  let scanned = 0
  const interrupted: string[] = []
  const now = Date.now()
  const withinMs = opts?.withinMs
  const sinceMs = opts?.sinceMs ?? (withinMs !== undefined ? now - withinMs : undefined)
  try {
    const groups = fs.readdirSync(sessionsRoot, { withFileTypes: true })
    for (const g of groups) {
      if (!g.isDirectory()) continue
      const groupPath = path.join(sessionsRoot, g.name)
      const sessions = fs.readdirSync(groupPath, { withFileTypes: true })
      for (const s of sessions) {
        if (!s.isDirectory()) continue
        scanned++
        const zstdPath = path.join(groupPath, s.name, 'session.jsonl.zstd')
        const jsonlPath = path.join(groupPath, s.name, 'session.jsonl')
        try {
          const lines = await readSessionAllLines(zstdPath, jsonlPath, sinceMs)
          if (lines === undefined) continue
          let openTurn: number | undefined
          let openTurnTime: number | undefined
          for (const line of lines) {
            try {
              const obj = JSON.parse(line)
              if (obj.type === 'turn/start' && typeof obj.data?.turn === 'number') {
                openTurn = obj.data.turn
                openTurnTime = typeof obj.time === 'number' ? obj.time : undefined
              } else if (obj.type === 'turn/end' && obj.data?.turn === openTurn) {
                openTurn = undefined
                openTurnTime = undefined
              }
            } catch {}
          }
          if (openTurn === undefined) continue
          if (sinceMs !== undefined) {
            if (openTurnTime === undefined || openTurnTime < sinceMs) continue
          }
          interrupted.push(`${g.name}/${s.name}`)
        } catch {}
      }
    }
  } catch {}
  return { scanned, interrupted }
}

export function parseDuration(s: string): number | undefined {
  if (!s) return undefined
  const m = s.trim().match(/^(\d+)(s|m|h)?$/)
  if (!m) return undefined
  const n = parseInt(m[1], 10)
  const unit = m[2] ?? 's'
  if (unit === 's') return n * 1000
  if (unit === 'm') return n * 60 * 1000
  if (unit === 'h') return n * 60 * 60 * 1000
  return undefined
}
