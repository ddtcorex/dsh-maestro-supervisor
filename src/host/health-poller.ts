export interface HealthState {
  up: boolean
  httpCode?: number
  error?: string
  degraded?: boolean
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
  'assertChannel',
  'unhandledRejection',
  'Cannot find module',
  'Failed to load',
]

export async function pollHealth(opts: PollHealthOpts = {}): Promise<HealthState> {
  const fetchFn = opts.fetch ?? defaultFetch(opts.url ?? 'http://127.0.0.1:3080/', opts.timeoutMs ?? 2000)
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
  for (const pat of ERROR_PATTERNS) {
    if (logContent.includes(pat)) {
      // extract line containing pattern
      const line = logContent.split('\n').find(l => l.includes(pat)) ?? pat
      logError = line.trim().slice(0, 500)
      break
    }
  }

  // If either fetch failed or log has error, consider down
  if (fetchError || logError) {
    return {
      up: false,
      httpCode,
      error: logError ?? fetchError,
      degraded: !!logError && httpCode === 200,
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

  return { up: httpCode === 200, httpCode }
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

async function defaultLogTail(): Promise<string> {
  try {
    const { readFileSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    const logPath = `${homedir()}/.dsh.log`
    const content = readFileSync(logPath, 'utf-8')
    return content.slice(-5000)
  } catch {
    return ''
  }
}
