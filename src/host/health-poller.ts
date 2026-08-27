export interface HealthState {
  up: boolean
  httpCode?: number
  error?: string
  degraded?: boolean
  logTail?: string
}

export interface PollHealthOpts {
  fetch?: () => Promise<{ status: number; text: () => Promise<string> }>
  psAlive?: () => Promise<boolean>
  logTail?: () => Promise<string>
  url?: string
  timeoutMs?: number
}

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
]

export async function pollHealth(opts: PollHealthOpts = {}): Promise<HealthState> {
  const fetchFn = opts.fetch ?? defaultFetch(opts.url ?? 'http://127.0.0.1:3080/', opts.timeoutMs ?? 5000)
  const psAliveFn = opts.psAlive ?? defaultPsAlive
  const logTailFn = opts.logTail ?? defaultLogTail

  let httpCode: number | undefined
  let fetchError: string | undefined

  try {
    const res = await fetchFn()
    httpCode = res.status
    if (res.status !== 200) {
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

  let logError: string | undefined
  // Find most recent error line (not first) and ignore stale errors that are
  // followed by a successful boot (log tail is append-only, old EADDRINUSE stays forever).
  // We check last occurrence and ensure no "dsh web: http" success after it.
  const lines = logContent.split('\n')
  const lowerLines = lines.map(l => l.toLowerCase())
  let lastErrorIdx = -1
  let matchedLine = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const lower = lowerLines[i]
    for (const pat of ERROR_PATTERNS) {
      if (lower.includes(pat.toLowerCase())) {
        lastErrorIdx = i
        matchedLine = lines[i].trim().slice(0, 500)
        break
      }
    }
    if (lastErrorIdx !== -1) break
  }
  if (lastErrorIdx !== -1) {
    // If a successful boot line appears after the last error, error is stale (already recovered)
    let hasSuccessAfter = false
    for (let i = lastErrorIdx + 1; i < lines.length; i++) {
      if (lowerLines[i].includes('dsh web: http')) { hasSuccessAfter = true; break }
    }
    if (!hasSuccessAfter) logError = matchedLine
  }

  // Distinguish FULL (http !=200) vs DEGRADED (http 200 but log has plugin error)
  if (fetchError) {
    return {
      up: false,
      httpCode,
      error: logError ? `${fetchError} + ${logError}` : fetchError,
      degraded: false,
      logTail: logContent.slice(-5000),
    }
  }
  if (logError) {
    // EADDRINUSE is fatal even with http 200 — old process still holds 3080/3000
    // and new start failed; treat as FULL down so supervisor kills + restarts.
    const lowerErr = logError.toLowerCase()
    const isFatalPortError = lowerErr.includes('eaddrinuse') || lowerErr.includes('address already in use')
    if (isFatalPortError) {
      return {
        up: false,
        httpCode,
        error: logError,
        degraded: false,
        logTail: logContent.slice(-5000),
      }
    }
    // http 200 but log error → DEGRADED (isolatable), not FULL
    if (httpCode === 200) {
      return {
        up: true,
        httpCode,
        error: logError,
        degraded: true,
        logTail: logContent.slice(-5000),
      }
    }
    return {
      up: false,
      httpCode,
      error: logError,
      degraded: false,
      logTail: logContent.slice(-5000),
    }
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

  return { up: httpCode === 200, httpCode, logTail: logContent.slice(-5000) }
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
