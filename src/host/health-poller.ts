import { checkPlannedRestart, BOOT_BOUNDARY_MARKER } from './restart-guards.js'
import { execSync as execSyncImpl } from 'node:child_process'

export interface HealthState {
  up: boolean
  httpCode?: number
  error?: string
  degraded?: boolean
  logTail?: string
  /** Boot verdict for the unit start this poll observed (see bootFreshness). */
  bootPhase?: BootFreshness
}

/**
 * Wall-clock epoch ms of the current dsh-web unit start, or undefined when
 * systemd does not manage the unit (portable host) or the lookup is disabled.
 * `ActiveEnterTimestampMonotonic` is deliberately gone: a monotonic reading
 * cannot be compared with a timestamp-less append-only log.
 */
export function getActiveEnterMs(): number | undefined {
  if (process.env.VITEST) return undefined
  try {
    const out = execSyncImpl('systemctl --user show -p ActiveEnterTimestamp dsh-web.service 2>/dev/null', { encoding: 'utf8' } as any) as unknown as string
    const m = (out as string).match(/ActiveEnterTimestamp=(.+)/)
    if (m) {
      const s = m[1].trim()
      if (!s || s === 'n/a') return undefined
      const ms = Date.parse(s)
      if (!Number.isNaN(ms)) return ms
    }
  } catch {}
  return undefined
}

/** @deprecated kept for callers; identical to getActiveEnterMs(). */
export function getActiveEnterWallMs(): number | undefined {
  return getActiveEnterMs()
}

export interface PollHealthOpts {
  fetch?: () => Promise<{ status: number; text: () => Promise<string> }>
  psAlive?: () => Promise<boolean>
  logTail?: () => Promise<string>
  url?: string
  timeoutMs?: number
  /** injectable for tests — overrides the systemctl lookup */
  getActiveEnterMs?: () => number | undefined
  /** Wall-clock epoch ms of the current dsh-web unit start (see bootFreshness). */
  activeEnterAtMs?: number
  /** Boot budget in ms; a younger boot without its own success marker is 'booting'. */
  bootGraceMs?: number
}

// Specific parse/boot-failure markers only. Bare 'JSON'/'YAML' were removed
// (2026-08-31): they matched any line whose payload merely *contained* those
// substrings — e.g. maestro-sync's status JSON listing session.jsonl.zstd /
// settings.json paths — turning a healthy 401 into a rollback + restart.
const ERROR_PATTERNS = [
  'ERR_MODULE_NOT_FOUND',
  'ERR_PNPM',
  'assertChannel',
  'unhandledRejection',
  'SyntaxError',
  'YAMLParseError',
  'ParseError',
  'corrupted',
  'allowBuilds',
  'Cannot find module',
  'Failed to load',
  'EADDRINUSE',
  'address already in use',
]

export type BootFreshness = 'unknown' | 'booting' | 'settled'

/**
 * Decide whether the current unit start can already be judged.
 *
 * `activeEnterAtMs` is WALL-CLOCK epoch ms from
 * `systemctl --user show -p ActiveEnterTimestamp dsh-web.service`.
 * Deliberately NOT `ActiveEnterTimestampMonotonic`: a monotonic reading can
 * never be compared against an append-only log that carries no timestamps, and
 * that mismatch is why the previous scan filter silently fell through and let
 * the previous boot's crash text be read as this boot's (incident 2026-09-13).
 *
 * - 'unknown' — no boot anchor (systemd absent, lookup disabled, clock skew):
 *               behave exactly as before the fix; never suppress anything.
 * - 'booting' — the unit started less than `bootGraceMs` ago and has not yet
 *               proven itself with its own success marker: weak failures are
 *               suppressed and log lines are inconclusive.
 * - 'settled' — the boot proved itself, or the grace window expired: judge
 *               normally.
 */
export function bootFreshness(opts: {
  activeEnterAtMs?: number
  now: number
  bootGraceMs: number
  currentBootSucceeded: boolean
}): BootFreshness {
  const { activeEnterAtMs, now, bootGraceMs, currentBootSucceeded } = opts
  if (activeEnterAtMs === undefined || !Number.isFinite(activeEnterAtMs)) return 'unknown'
  if (now < activeEnterAtMs) return 'unknown'
  if (currentBootSucceeded) return 'settled'
  return now - activeEnterAtMs < bootGraceMs ? 'booting' : 'settled'
}

/**
 * Classify a fetch failure by what it says about the process.
 *
 * 'refused' — nothing is listening, so the process is gone: a strong down
 *             signal that must never be masked by a boot grace.
 * 'timeout' — something may be alive but slow: weak, only meaningful once the
 *             boot grace expired.
 * 'other'   — anything we cannot attribute.
 *
 * Walks the `cause` chain because undici surfaces a refused connection as
 * `TypeError: fetch failed` with the real `ECONNREFUSED` on `cause`.
 */
export function classifyFetchFailure(err: unknown): 'refused' | 'timeout' | 'other' {
  const parts: string[] = []
  let cur: any = err
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (typeof cur === 'string') { parts.push(cur); break }
    const code = typeof cur.code === 'string' ? cur.code : ''
    const name = typeof cur.name === 'string' ? cur.name : ''
    const message = typeof cur.message === 'string' ? cur.message : ''
    parts.push(`${code} ${name} ${message}`)
    cur = cur.cause
  }
  const text = parts.join(' ').toLowerCase()
  if (/econnrefused|connection refused|ehostunreach|enetunreach/.test(text)) return 'refused'
  if (/abort|timed? ?out|etimedout|und_err_connect_timeout/.test(text)) return 'timeout'
  return 'other'
}

export const SUCCESS_MARKER = 'dsh web: http'

/** Index of the last boot-boundary line in the tail, or -1 when it predates the tail. */
export function lastBootBoundaryIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(BOOT_BOUNDARY_MARKER)) return i
  }
  return -1
}

/** Index of the last "dsh web: http" success marker (`lowerLines` must be lower-cased). */
export function lastSuccessMarkerIndex(lowerLines: string[]): number {
  for (let i = lowerLines.length - 1; i >= 0; i--) {
    if (lowerLines[i].includes(SUCCESS_MARKER)) return i
  }
  return -1
}

/** Wall-clock ms parsed from a boot-boundary line, or undefined when unparseable. */
export function parseBootBoundaryMs(line: string): number | undefined {
  const m = /boot-boundary\s+(\S+)/.exec(line)
  if (!m) return undefined
  const ms = Date.parse(m[1]!)
  return Number.isNaN(ms) ? undefined : ms
}

export async function pollHealth(opts: PollHealthOpts = {}): Promise<HealthState> {
  // 5s was too tight for a busy plugin-tree boot: a lone AbortError from a slow
  // (but otherwise fine) response was indistinguishable from a real crash, and
  // combined with a low down-threshold this caused a self-sustaining restart
  // loop (see Supervisor.downThreshold). 12s gives boot room without masking
  // a genuinely dead process for long. 20s (Option A 2026-09-03) tolerates
  // high load (loadavg 12) stalls; configurable via domains.supervisor.pollTimeoutMs.
  // If opts.timeoutMs is not injected, read from supervisor config (maestro settings).
  let effectiveTimeout = opts.timeoutMs
  let bootGraceMs = opts.bootGraceMs
  if (effectiveTimeout === undefined || bootGraceMs === undefined) {
    try {
      const { readSupervisorConfig } = await import('./config.js')
      const cfg: any = await readSupervisorConfig()
      if (effectiveTimeout === undefined && typeof cfg.pollTimeoutMs === 'number' && cfg.pollTimeoutMs > 0) effectiveTimeout = cfg.pollTimeoutMs
      if (bootGraceMs === undefined && typeof cfg.bootGraceMs === 'number' && cfg.bootGraceMs > 0) bootGraceMs = cfg.bootGraceMs
    } catch {}
    effectiveTimeout ??= 20000
    bootGraceMs ??= 180000
  }
  const fetchFn = opts.fetch ?? defaultFetch(opts.url ?? 'http://127.0.0.1:3080/', effectiveTimeout)
  const psAliveFn = opts.psAlive ?? defaultPsAlive
  const logTailFn = opts.logTail ?? defaultLogTail

  let httpCode: number | undefined
  let fetchError: string | undefined

  try {
    const res = await fetchFn()
    httpCode = res.status
    // 401 is healthy: dsh web is up but requires browser token (since 0.1.2). Only 5xx / network errors are down.
    if (res.status !== 200 && res.status !== 401) {
      fetchError = `http ${res.status}`
    }
  } catch (e: any) {
    fetchError = e?.message ?? String(e)
  }

  let logContent = ''
  try {
    logContent = await logTailFn()
  } catch {
    // ignore log read errors
  }

  // Suppression gate: an in-flight planned restart, or a boot that has not yet
  // proven itself, means transients are expected. A refused connection is
  // never suppressed: nothing is listening, so the process is gone (D2).
  const suppressed = checkPlannedRestart()

  let activeEnterAtMs: number | undefined = opts.activeEnterAtMs
  if (activeEnterAtMs === undefined) {
    try {
      const fn = opts.getActiveEnterMs ?? getActiveEnterMs
      activeEnterAtMs = fn()
    } catch {
      activeEnterAtMs = undefined
    }
  }

  const now = Date.now()
  const lines = logContent.split('\n')
  const lowerLines = lines.map(l => l.toLowerCase())
  // Scope the scan to the current boot. The boundary line is only trusted for
  // the unit start it was written for: a start more than a boot budget later
  // (a systemd auto-restart, a manual start) is a different boot.
  const boundaryIdx = lastBootBoundaryIndex(lines)
  const boundaryMs = boundaryIdx === -1 ? undefined : parseBootBoundaryMs(lines[boundaryIdx]!)
  const scopedToThisBoot = boundaryMs !== undefined
    && activeEnterAtMs !== undefined
    && activeEnterAtMs >= boundaryMs
    && activeEnterAtMs - boundaryMs <= bootGraceMs
  const bootLines = scopedToThisBoot ? lines.slice(boundaryIdx + 1) : lines
  const bootLower = scopedToThisBoot ? lowerLines.slice(boundaryIdx + 1) : lowerLines
  const currentBootSucceeded = scopedToThisBoot && bootLower.some(l => l.includes(SUCCESS_MARKER))
  const bootPhase = bootFreshness({ activeEnterAtMs, now, bootGraceMs, currentBootSucceeded })
  const booting = bootPhase === 'booting'
  const graceActive = suppressed || booting

  // Inside the current boot, only lines after its own success marker may be a
  // post-start crash. With no marker and no scope proving these lines are this
  // boot's, the scan is inconclusive (D3) instead of inheriting the previous
  // boot's crash text — that inheritance is what produced the 2026-09-13
  // rollback report ("rollback — degraded: This operation was aborted") from a
  // healthy, still-booting instance reading the previous boot's EADDRINUSE.
  const successIdx = lastSuccessMarkerIndex(bootLower)
  let scanLines: string[]
  let scanLower: string[]
  if (successIdx !== -1) {
    scanLines = bootLines.slice(successIdx + 1)
    scanLower = bootLower.slice(successIdx + 1)
  } else if (booting && !scopedToThisBoot) {
    scanLines = []
    scanLower = []
  } else {
    scanLines = bootLines
    scanLower = bootLower
  }
  if (scanLines.length > 200) {
    scanLines = scanLines.slice(-200)
    scanLower = scanLower.slice(-200)
  }

  let lastErrorIdx = -1
  let matchedLine = ''
  for (let i = scanLines.length - 1; i >= 0; i--) {
    const lower = scanLower[i]
    for (const pat of ERROR_PATTERNS) {
      if (lower.includes(pat.toLowerCase())) {
        lastErrorIdx = i
        matchedLine = scanLines[i].trim().slice(0, 500)
        break
      }
    }
    if (lastErrorIdx !== -1) break
  }
  let logError: string | undefined
  if (lastErrorIdx !== -1) {
    let hasSuccessAfter = false
    for (let i = lastErrorIdx + 1; i < scanLines.length; i++) {
      if (scanLower[i].includes(SUCCESS_MARKER)) { hasSuccessAfter = true; break }
    }
    if (!hasSuccessAfter) logError = matchedLine
  }

  if (fetchError) {
    const kind = classifyFetchFailure(fetchError)
    // D1: a timeout/abort while the current boot is unproven is a slow boot,
    // not a crash — increment nothing. D2: a refused connection is different
    // (nothing is listening, the process is gone) and is never masked.
    if (booting && kind !== 'refused') {
      return { up: true, httpCode, bootPhase, logTail: logContent.slice(-5000) }
    }
    if (suppressed) {
      return { up: true, httpCode, bootPhase, logTail: logContent.slice(-5000) }
    }
    // Corroborate with a cheap port-liveness check before declaring a crash.
    // The HTTP fetch shares dsh-web's own event loop, so a busy-but-alive
    // process (e.g. heavy GitLab-webhook-triggered review work) times out
    // the same way a genuinely dead one does — but a real crash always frees
    // the port, while `ss` does not depend on the contended event loop to
    // answer. Downgrade to DEGRADED (still visible, still escalates after
    // repeated ticks) instead of forcing an immediate rollback + restartWeb
    // that would kill an in-flight review for nothing.
    let portAlive = false
    try { portAlive = await psAliveFn() } catch { portAlive = false }
    if (portAlive) {
      return {
        up: true,
        httpCode,
        bootPhase,
        error: logError ? `${fetchError} + ${logError}` : fetchError,
        degraded: true,
        logTail: logContent.slice(-5000),
      }
    }
    return {
      up: false,
      httpCode,
      bootPhase,
      error: logError ? `${fetchError} + ${logError}` : fetchError,
      degraded: false,
      logTail: logContent.slice(-5000),
    }
  }
  // During grace, a windowed logError that is still present is considered
  // stale/boot transient as well — treat as up to avoid double restart.
  if (graceActive && logError) {
    return { up: true, httpCode, bootPhase, logTail: logContent.slice(-5000) }
  }
  if (logError) {
    // EADDRINUSE is fatal even with http 200 — an old process still holds
    // the port and the new start failed; treat as FULL down so the supervisor
    // kills + restarts.
    const lowerErr = logError.toLowerCase()
    const isFatalPortError = lowerErr.includes('eaddrinuse') || lowerErr.includes('address already in use')
    if (isFatalPortError) {
      return { up: false, httpCode, bootPhase, error: logError, degraded: false, logTail: logContent.slice(-5000) }
    }
    // http 200 but log error → DEGRADED (isolatable), not FULL
    if (httpCode === 200) {
      return { up: true, httpCode, bootPhase, error: logError, degraded: true, logTail: logContent.slice(-5000) }
    }
    return { up: false, httpCode, bootPhase, error: logError, degraded: false, logTail: logContent.slice(-5000) }
  }

  // Also check psAlive as secondary signal — if fetch ok but ps dead, still down
  try {
    const alive = await psAliveFn()
    if (!alive && httpCode === 200) {
      // fetch succeeded but ps says dead — likely stale, still consider up if http 200
    }
  } catch {
    // ignore
  }

  return { up: httpCode === 200 || httpCode === 401, httpCode, bootPhase, logTail: logContent.slice(-5000) }
}

function defaultFetch(url: string, timeoutMs: number): () => Promise<{ status: number; text: () => Promise<string> }> {
  return async () => {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { signal: controller.signal })
      return { status: res.status, text: async () => res.text() }
    } finally {
      clearTimeout(t)
    }
  }
}

async function defaultPsAlive(): Promise<boolean> {
  // Check if any listener on 3080 exists via ss — fallback to true if ss unavailable
  try {
    const { execSync } = await import('node:child_process')
    const out = execSync('ss -tln 2>/dev/null || true', { encoding: 'utf-8' })
    return out.includes(':3080')
  } catch {
    return true
  }
}

export async function collectLogTail(): Promise<string> {
  try {
    const { readFileSync, existsSync, statSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    const candidates = [
      `${homedir()}/.dsh/dsh-web.log`,
      `${homedir()}/.dsh/.supervisor/supervisor.log`,
      `${homedir()}/.dsh.log`,
    ]
    for (const logPath of candidates) {
      try {
        if (!existsSync(logPath)) continue
        // avoid reading huge files fully — if >1MB, read tail via shell
        try {
          const sz = statSync(logPath).size
          if (sz > 1024 * 1024) {
            const { execSync } = await import('node:child_process')
            const out = execSync(`tail -c 5000 ${JSON.stringify(logPath)} 2>/dev/null || cat ${JSON.stringify(logPath)} 2>/dev/null | tail -c 5000`, { encoding: 'utf-8', timeout: 2000 })
            if (out) return out.slice(-5000)
          }
        } catch {}
        const content = readFileSync(logPath, 'utf-8')
        if (content && content.trim()) return content.slice(-5000)
      } catch {}
    }
    // fallback: try journalctl for the dsh-web or supervisor units (if running via systemd)
    try {
      const { execSync } = await import('node:child_process')
      const journal = execSync('journalctl --user -u dsh-web-supervisor --no-pager -n 100 2>/dev/null | tail -c 5000 || journalctl --user --no-pager -n 100 2>/dev/null | tail -c 5000 || true', { encoding: 'utf-8', timeout: 2000 })
      if (journal && journal.trim()) return journal.slice(-5000)
    } catch {}
    return ''
  } catch {
    return ''
  }
}

async function defaultLogTail(): Promise<string> {
  return collectLogTail()
}
