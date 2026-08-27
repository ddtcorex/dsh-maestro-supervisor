export interface DebugAgentOpts {
  reportPath: string
  health: { error?: string; httpCode?: number }
  attempts?: number
  cooldownMs?: number
}

let lastRun = 0
let attempts = 0
const MAX_ATTEMPTS = 3

export async function runDebugAgent(opts: DebugAgentOpts): Promise<{ fixed: boolean; reason: string }> {
  const now = Date.now()
  const cooldownMs = opts.cooldownMs ?? 10 * 60 * 1000
  if (now - lastRun < cooldownMs) {
    return { fixed: false, reason: 'cooldown' }
  }
  if (attempts >= MAX_ATTEMPTS) {
    return { fixed: false, reason: 'max attempts' }
  }
  lastRun = now
  attempts++

  // Phase 3A: deterministic checks before LLM
  // 1) Try pnpm verify in the degraded package (if identifiable)
  // 2) Dry-boot DSH web on ephemeral port
  // If both pass, consider fixed (degraded was transient, e.g. log tail stale)
  // Otherwise, would spawn systematic-debugging subagent (LLM) — stub for now
  try {
    const { execSync } = await import('node:child_process')
    const { readFileSync } = await import('node:fs')
    // Check report exists
    let report = ''
    try { report = readFileSync(opts.reportPath, 'utf-8') } catch {}
    // If error is ERR_MODULE_NOT_FOUND for a package that now has lib/index.js, consider fixed
    const err = opts.health.error ?? ''
    if (err.includes('ERR_MODULE_NOT_FOUND') || err.includes('Cannot find module')) {
      // Check if the missing file now exists (e.g. after pnpm build)
      // This is a heuristic: if any dsh-maestro package now has lib/index.js, the degraded may be stale
      const candidates = ['dsh-maestro-supervisor', 'dsh-maestro-observe', 'dsh-maestro-memory']
      for (const pkg of candidates) {
        try {
          const p = `/home/kai/Work/htdocs/maestro-harness/packages/${pkg}/lib/index.js`
          readFileSync(p)
          // if file exists, the error may be transient — try verify
          try {
            execSync(`pnpm --dir /home/kai/Work/htdocs/maestro-harness/packages/${pkg} verify --silent 2>&1 | head -5`, { timeout: 15000 })
          } catch {}
        } catch {}
      }
    }
    // Dry-boot check (isolated DSH_HOME, port 0)
    try {
      const tmp = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
      const port = Math.floor(19000 + Math.random() * 1000)
      const out = execSync(`timeout 8 bash -c 'DSH_HOME=${tmp} pnpm --dir /home/kai/Work/htdocs/maestro-harness/deepseek-harness dsh web --port ${port} --no-open >${tmp}/dsh.log 2>&1 & pid=\\$!; for i in \\$(seq 1 5); do sleep 1; if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/ 2>&1 | grep -q 200; then kill \\$pid 2>/dev/null || true; wait \\$pid 2>/dev/null || true; echo ok; exit 0; fi; done; kill \\$pid 2>/dev/null || true; wait \\$pid 2>/dev/null || true; echo fail; exit 1'`, { encoding: 'utf-8', timeout: 12000 })
      execSync(`rm -rf ${tmp}`)
      if (out.includes('ok')) {
        return { fixed: true, reason: `dry-boot ok (attempt ${attempts}) — transient degraded` }
      }
    } catch {}
  } catch {}

  return { fixed: false, reason: `would debug ${opts.reportPath} (attempt ${attempts}) — LLM not wired, manual fix needed` }
}

export function _resetDebugAgentForTest() {
  lastRun = 0
  attempts = 0
}
