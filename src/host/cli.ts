import { Supervisor } from './supervisor.js'
import { pollHealth } from './health-poller.js'
import { writeLKG, verifyLKG, isLkgExcluded, failureReason } from './snapshot.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { resolveHarnessRoot } from './paths.js'
import { isSelfCopyError, checkPlannedRestart, readRestartRequest, clearPlannedRestart } from './restart-guards.js'
import { readSupervisorConfig } from './config.js'

export interface RestoreResult {
  /** Snapshot id that was restored. */
  target: string
  /** Files (and symlinks) restored into the live DSH home. */
  restored: number
  /** Entries that were not restored, each with a reason. Never silent. */
  skipped: Array<{ path: string; reason: string }>
}

/**
 * Make a destination (recursively) writable before overwriting it (D3).
 *
 * `fs.cpSync` copies into an existing destination file with
 * `O_WRONLY|O_CREAT|O_TRUNC`, so a mode-`0400` object fails with EACCES and
 * aborts the whole restore — the exact 2026-09-13 failure
 * (`EACCES, Permission denied '.../attachments/v1/objects/f8'`). Only entries
 * that actually lack the needed bit are chmod-ed, so a healthy tree costs
 * stats, not a chmod per file.
 */
function makeWritable(target: string): void {
  let st: fs.Stats
  try {
    st = fs.lstatSync(target)
  } catch {
    return
  }
  if (st.isSymbolicLink()) return
  if (st.isDirectory()) {
    if ((st.mode & 0o300) !== 0o300) {
      try { fs.chmodSync(target, st.mode | 0o300) } catch {}
    }
    let names: string[] = []
    try { names = fs.readdirSync(target) } catch { return }
    for (const name of names) makeWritable(path.join(target, name))
    return
  }
  if ((st.mode & 0o200) === 0) {
    try { fs.chmodSync(target, st.mode | 0o200) } catch {}
  }
}

/** Files (and symlinks) a restore of this source entry would write. */
function countRestorable(srcPath: string): number {
  try {
    const st = fs.lstatSync(srcPath)
    if (st.isDirectory()) return walkFiles(srcPath).length
    return 1
  } catch {
    return 0
  }
}

function walkFiles(dir: string, base: string = dir): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full))
  }
  return out
}

/**
 * Copy a chosen LKG snapshot back into the DSH home. Recent snapshots are
 * tried newest-first, skipping any that still carry a failing plugin so a
 * broken bundle is not restored. `sessions/` and every other runtime-data entry
 * is deliberately NOT restored (D1) — session logs are append-only truth and
 * rolling them back to a snapshot would drop every turn recorded after that
 * snapshot.
 *
 * Never throws for a per-entry failure: the failures are collected into
 * `skipped` and the caller reports them (D2/D4). The only throw left is "there
 * is no snapshot at all", which the caller must know about.
 *
 * @returns the restore summary (snapshot id + what was/was not restored).
 */
export async function rollbackLKG(opts: { dshHome: string; lkgRoot: string; failingPlugin?: string }): Promise<RestoreResult> {
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
  const skipped: RestoreResult['skipped'] = []
  let restored = 0
  for (const entry of fs.readdirSync(src)) {
    if (entry === 'manifest.json') continue
    if (isLkgExcluded(entry)) {
      // Legacy snapshots (taken before D1) still carry runtime data. Restoring
      // a stale sessions/ over live sessions can lose a log, and a 0400
      // attachment blob is what aborted this very path — report, never restore.
      skipped.push({ path: entry, reason: 'runtime data excluded from the LKG scope (not required to boot)' })
      continue
    }
    const srcPath = path.join(src, entry)
    const destPath = path.join(dshHome, entry)
    try {
      // Skip if src and dest are the same file (e.g. symlink to same target like ~/.dsh/AGENTS.md)
      try {
        if (fs.existsSync(srcPath) && fs.existsSync(destPath) && fs.realpathSync(srcPath) === fs.realpathSync(destPath)) continue
      } catch {}
      makeWritable(destPath)
      fs.cpSync(srcPath, destPath, { recursive: true, force: true })
      restored += countRestorable(srcPath)
    } catch (e: any) {
      if (isSelfCopyError(String(e?.message ?? ''))) continue
      skipped.push({ path: entry, reason: failureReason(e) })
    }
  }
  return { target, restored, skipped }
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
        const res = await rollbackLKG({ dshHome, lkgRoot, failingPlugin })
        console.log(`[supervisor] rolled back to ${res.target} — ${res.restored} file(s) restored${failingPlugin ? ` (avoiding ${failingPlugin})` : ''}`)
        // D4: a partial restore is surfaced loudly, never silently.
        if (res.skipped.length) {
          console.log(`[supervisor] ROLLBACK PARTIAL: ${res.skipped.length} entr(ies) not restored`)
          for (const s of res.skipped.slice(0, 10)) console.log(`[supervisor]   skipped ${s.path}: ${s.reason}`)
          if (res.skipped.length > 10) console.log(`[supervisor]   … ${res.skipped.length - 10} more`)
        }
        // Reconcile node_modules from restored package.json (critical for link: deps)
        try {
          execSync('pnpm --dir ~/.dsh/profiles/web install --silent', { timeout: 30000, stdio: 'pipe' })
          console.log('[supervisor] pnpm install reconciled profiles/web')
        } catch (e: any) {
          console.log(`[supervisor] pnpm install failed: ${e?.message ?? String(e)}`)
        }
        return res
      },
      restartWeb: async () => {
        // One implementation of the single-boot restart: marker (TTL = boot
        // budget) → boot.lock → serialized systemd start → direct-node nohup
        // only on hosts where the unit does not exist (D4/D5).
        const { performSingleBootRestart, DEFAULT_BOOT_GRACE_MS } = await import('./restart-web.js')
        let grace = DEFAULT_BOOT_GRACE_MS
        try {
          const cfg = await readSupervisorConfig()
          if (typeof (cfg as any).bootGraceMs === 'number' && (cfg as any).bootGraceMs > 0) grace = (cfg as any).bootGraceMs
        } catch {}
        const res = await performSingleBootRestart({ bootGraceMs: grace })
        if (!res.restarted) console.log(`[supervisor] restart skipped: ${res.reason ?? 'boot lock held'}`)
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
