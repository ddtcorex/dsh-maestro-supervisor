import { Supervisor } from './supervisor.js'
import { pollHealth } from './health-poller.js'
import { writeLKG, verifyLKG } from './snapshot.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { resolveHarnessRoot, resolveDeepseekHarnessDir } from './paths.js'
import { buildKillStalePortsCommand, isSelfCopyError, checkPlannedRestart, writePlannedRestart, readRestartRequest, clearPlannedRestart } from './restart-guards.js'

/**
 * Copy a chosen LKG snapshot back into the DSH home. Recent snapshots are
 * tried newest-first, skipping any that still carry a failing plugin so a
 * broken bundle is not restored. `sessions/` is deliberately NOT restored —
 * session logs are append-only truth and rolling them back to a snapshot
 * would drop every turn recorded after that snapshot.
 * @returns the rolled-back snapshot id.
 */
export async function rollbackLKG(opts: { dshHome: string; lkgRoot: string; failingPlugin?: string }): Promise<string> {
  const { dshHome, lkgRoot, failingPlugin } = opts
  const entries = fs.existsSync(lkgRoot) ? fs.readdirSync(lkgRoot).sort() : []
  if (!entries.length) throw new Error('no LKG to rollback to')
  const candidates = [...entries].reverse().slice(0, 3)
  let chosen: string | undefined
  for (const cand of candidates) {
    if (!failingPlugin) { chosen = cand; break }
    try {
      const pkgPath = path.join(lkgRoot, cand, 'profiles/web/package.json')
      if (!fs.existsSync(pkgPath)) { chosen = cand; break }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      const bundles: string[] = pkg?.dsh?.profile?.bundles ?? []
      const deps = pkg?.dependencies ?? {}
      const hasFailing = bundles.some((b: string) => b.includes(failingPlugin)) || Object.keys(deps).some(k => k.includes(failingPlugin))
      if (!hasFailing) { chosen = cand; break }
      console.log(`[supervisor] skipping LKG ${cand} still contains failing plugin ${failingPlugin}`)
    } catch { chosen = cand; break }
  }
  const target = chosen ?? entries[entries.length - 1]
  const src = path.join(lkgRoot, target)
  for (const entry of fs.readdirSync(src)) {
    if (entry === 'manifest.json') continue
    if (entry === 'sessions') {
      console.log('[supervisor] rollback keeps live sessions (append-only truth) — skipping sessions/')
      continue
    }
    const srcPath = path.join(src, entry)
    const destPath = path.join(dshHome, entry)
    try {
      // Skip if src and dest are the same file (e.g. symlink to same target like ~/.dsh/AGENTS.md)
      try {
        if (fs.existsSync(srcPath) && fs.existsSync(destPath) && fs.realpathSync(srcPath) === fs.realpathSync(destPath)) continue
      } catch {}
      fs.cpSync(srcPath, destPath, { recursive: true, force: true })
    } catch (e: any) {
      if (isSelfCopyError(String(e?.message ?? ''))) continue
      throw e
    }
  }
  return target
}

export async function runCli(args: string[]): Promise<void> {
  const cmd = args[2] ?? '--help'
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(`Usage: dsh-web-supervisor <command>

Commands:
  daemon     Run supervisor daemon (poll every 3s)
  status     Show health + LKG status
  logs       Tail supervisor reports
  rollback --to <ts>  Rollback to LKG <ts>
  resume [--within <dur>]  List interrupted sessions (filter by time, e.g. 5m, 30s, 1h)
`)
    return
  }
  if (cmd === 'status') {
    const health = await pollHealth()
    console.log(`up: ${health.up}, httpCode: ${health.httpCode}, error: ${health.error ?? 'none'}`)
    const lkgRoot = path.join(os.homedir(), '.dsh/.supervisor/lkg')
    if (fs.existsSync(lkgRoot)) {
      const entries = fs.readdirSync(lkgRoot).sort()
      console.log(`LKG: ${entries.length} snapshots, latest: ${entries[entries.length - 1] ?? 'none'}`)
      if (entries.length) {
        const ok = await verifyLKG(path.join(lkgRoot, entries[entries.length - 1])).catch(() => false)
        console.log(`latest LKG valid: ${ok}`)
      }
    } else {
      console.log('LKG: none')
    }
    return
  }
  if (cmd === 'resume') {
    const withinIdx = args.indexOf('--within')
    let withinMs: number | undefined
    if (withinIdx !== -1) {
      const raw = args[withinIdx + 1] ?? ''
      const { parseDuration } = await import('./resume.js')
      withinMs = parseDuration(raw)
      if (withinMs === undefined) {
        console.error(`invalid --within value: ${raw} (use e.g. 5m, 30s, 1h)`)
        process.exit(1)
      }
    }
    const { findInterrupted } = await import('./resume.js')
    const res = await findInterrupted(undefined, withinMs !== undefined ? { withinMs } : undefined)
    if (withinMs !== undefined) {
      console.log(`interrupted within ${args[withinIdx + 1]}: ${res.interrupted.length}/${res.scanned}`)
    } else {
      console.log(`interrupted: ${res.interrupted.length}/${res.scanned}`)
    }
    for (const id of res.interrupted) console.log(id)
    return
  }
  if (cmd === 'daemon') {
    console.log('[supervisor] starting daemon — poll every 3s, Ctrl+C to stop')
    const dshHome = path.join(os.homedir(), '.dsh')
    const lkgRoot = path.join(os.homedir(), '.dsh/.supervisor/lkg')
    const failedRoot = path.join(os.homedir(), '.dsh/.supervisor/failed')
    const reportsRoot = path.join(os.homedir(), '.dsh/.supervisor/reports')
    const supervisor = new Supervisor({
      pollHealth: () => pollHealth(),
      writeLKG: () => writeLKG(dshHome, lkgRoot),
      writeFailed: () => writeLKG(dshHome, failedRoot),
      writeReport: async ({ ts, health, action, logTail, gitDiff }: any) => {
        const { writeReport, collectGitDiff } = await import('./report.js')
        const { collectLogTail } = await import('./health-poller.js')
        // Prefer supervisor-provided tail/diff (from health.logTail); fallback to live collect
        let tail: string = logTail ?? (health as any).logTail ?? ''
        if (!tail) {
          try { tail = await collectLogTail() } catch { tail = '' }
        }
        let diff: string = gitDiff ?? ''
        if (!diff) {
          try {
            const harnessRoot = resolveHarnessRoot()
            diff = await collectGitDiff(harnessRoot).catch(() => '')
            if (!diff) {
              // fallback: try git diff in cwd
              const { execSync } = await import('node:child_process')
              try { diff = execSync('git diff 2>/dev/null | head -n 200', { encoding: 'utf-8', timeout: 2000 }) } catch { diff = '' }
            }
          } catch { diff = '' }
        }
        return writeReport({ reportsRoot, ts, health, gitDiff: diff, logTail: tail, action })
      },
      rollback: async () => {
        const { execSync } = await import('node:child_process')
        // Extract failing plugin from current log tail if possible
        let failingPlugin: string | undefined
        try {
          const tail = fs.readFileSync(path.join(os.homedir(), '.dsh/dsh-web.log'), 'utf8').slice(-5000)
          const m = tail.match(/@ddtcorex\/dsh-maestro-[a-z0-9_-]+/i) ?? tail.match(/dsh-maestro-[a-z0-9_-]+/i)
          if (m) failingPlugin = m[0].replace(/^@ddtcorex\//, '')
        } catch {}
        const target = await rollbackLKG({ dshHome, lkgRoot, failingPlugin })
        console.log(`[supervisor] rolled back to ${target}${failingPlugin ? ` (avoiding ${failingPlugin})` : ''}`)
        // Reconcile node_modules from restored package.json (critical for link: deps)
        try {
          execSync('pnpm --dir ~/.dsh/profiles/web install --silent', { timeout: 30000, stdio: 'pipe' })
          console.log('[supervisor] pnpm install reconciled profiles/web')
        } catch (e: any) {
          console.log(`[supervisor] pnpm install failed: ${e?.message ?? String(e)}`)
        }
      },
      restartWeb: async () => {
        const { execSync } = await import('node:child_process')
        // Single-owner: mark planned restart 30s before any systemctl/nohup
        // so pollHealth + tick suppress the transient down (no double restart).
        try { writePlannedRestart(30000) } catch {}
        // Kill stale MainThread holding 3080 before any restart attempt
        // (EADDRINUSE crash leaves old pid alive with http 200; new start would fail)
        // Scoped to :3080 only — an unfiltered `ss -tlnp` matches every
        // listening process on the host, not just dsh web (regression: killed
        // unrelated services like redis/horizon on every restart).
        try {
          execSync(buildKillStalePortsCommand(), { timeout: 5000, stdio: 'pipe' })
        } catch {}
        // Prefer systemd — if dsh-web.service is installed, restart/start it
        try {
          execSync('systemctl --user is-active --quiet dsh-web.service && systemctl --user restart dsh-web.service || systemctl --user start dsh-web.service', { timeout: 15000, stdio: 'pipe' })
          console.log('[supervisor] restarted dsh-web via systemd')
          return
        } catch {}
        // Check if unit exists but not active — try start
        try {
          execSync('systemctl --user start dsh-web.service', { timeout: 15000, stdio: 'pipe' })
          console.log('[supervisor] started dsh-web via systemd (fallback)')
          return
        } catch {}
        // Last fallback: detached direct node (portable — sources nvm directly, falls back to system node)
        try {
          const harnessRoot = resolveDeepseekHarnessDir()
          const logPath = path.join(os.homedir(), '.dsh/dsh-web.log')
          try { writePlannedRestart(30000) } catch {}
          execSync(`setsid nohup bash -c 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; cd ${JSON.stringify(harnessRoot)} && exec node --import tsx/esm apps/cli/src/bin.ts web --no-open >> ${JSON.stringify(logPath)} 2>&1' &`, { timeout: 5000 })
          console.log('[supervisor] started dsh-web via nohup fallback (direct node, portable)')
        } catch (e: any) {
          throw new Error(`restartWeb failed: ${e?.message ?? String(e)}`)
        }
      },
      notify: async (msg) => console.log(`[notify] ${msg}`),
      isPlannedRestartActive: () => checkPlannedRestart(),
      // dsh_web_restart marker ownership: the daemon acts on the marker. After
      // the restart, scan recent session logs for torn tails (an in-flight
      // session truncated by the restart) and report; the marker is cleared in
      // the supervisor's own finally block and again here as a safety net.
      readRestartRequest: () => readRestartRequest(),
      onRestartRequestHandled: async () => {
        const { scanSessions } = await import('./scan.js')
        const res = await scanSessions(path.join(os.homedir(), '.dsh'), { withinMs: 10 * 60 * 1000 }).catch(() => ({ scanned: 0, torn: [] }))
        if (res.torn.length) {
          console.log(`[supervisor] post-self-restart scan: ${res.torn.length} torn session log(s)`)
        } else {
          console.log('[supervisor] post-self-restart scan: clean')
        }
        void clearPlannedRestart()
      },
    })
    await supervisor.start()
    // keep process alive
    await new Promise(() => {})
  }
  console.log(`unknown command: ${cmd} — try --help`)
}
