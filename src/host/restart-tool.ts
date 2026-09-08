/**
 * dsh_web_restart tool — the safe restart path for the model running inside
 * dsh web. Scheduling a restart through this tool instead of a raw kill keeps
 * the restart inside the supervisor's ownership loop:
 *
 *   1. dry-boot gate — if the plugin tree changed since the latest LKG, boot a
 *      copy of the live profile on an ephemeral DSH_HOME first and only
 *      schedule when that boot serves HTTP.
 *   2. intent sidecar — record the caller session + reason under
 *      ~/.dsh/.supervisor/intents/ for attribution.
 *   3. hand-off — write the restart-request marker (planned-restart.json with
 *      callerSessionId) that the supervisor daemon owns and acts on
 *      (out-of-band). This tool NEVER restarts the host in-tree.
 */

import { join, dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync, readdirSync, statSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { writeRestartRequest } from './restart-guards.js'

/**
 * Copy a live profile tree for an isolated dry-boot. A naive recursive copy
 * breaks `link:` installs: their node_modules entries are relative symlinks
 * (e.g. `../../../shared/pkg`) that resolve against the copy location and
 * dangle. Every symlink left dangling by the copy is rewritten to the
 * absolute live target it pointed at, so the dry-boot loads the same code
 * the live tree loads. Links already broken in the live tree are left alone
 * (the dry-boot must stay faithful, not fix the live tree).
 */
export function copyProfileForDryBoot(srcDir: string, destDir: string): void {
  cpSync(srcDir, destDir, { recursive: true, preserveTimestamps: true })
  const repair = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(p)
      if (st.isSymbolicLink()) {
        if (!existsSync(p)) {
          const liveTarget = resolve(srcDir, dirname(r), readlinkSync(p))
          if (existsSync(liveTarget)) {
            unlinkSync(p)
            symlinkSync(liveTarget, p)
          }
        }
      } else if (st.isDirectory()) {
        repair(p, r)
      }
    }
  }
  repair(destDir, '')
}

/**
 * A dry-boot orphan candidate: a `dsh web` process rooted at a temp DSH_HOME
 * with an ephemeral-port listener. Ports 3080/3081/3082 are the live tree and
 * can never be candidates.
 */
export interface DryBootCandidate { pid: number; port: number; dshHome: string }

const LIVE_PORTS = new Set([3080, 3081, 3082])

export interface GcReaders {
  readProc?: () => Array<{ pid: number; cmd: string; env: string }>
  ssPortsOf?: (pid: number) => number[]
  selfPid?: number
}

function defaultReadProc(): Array<{ pid: number; cmd: string; env: string }> {
  const out: Array<{ pid: number; cmd: string; env: string }> = []
  let names: string[] = []
  try { names = readdirSync('/proc') } catch { return out }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    try {
      const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ')
      const env = readFileSync(`/proc/${name}/environ`, 'utf8')
      out.push({ pid: Number(name), cmd, env })
    } catch { /* process exited mid-scan — ignore */ }
  }
  return out
}

function defaultSsPortsOf(pid: number): number[] {
  try {
    const out = execFileSync('ss', ['-tlnp'], { encoding: 'utf8' })
    const ports: number[] = []
    for (const line of out.split('\n')) {
      if (!line.includes(`pid=${pid},`)) continue
      const m = /:(\d+)\s/.exec(line)
      if (m) ports.push(Number(m[1]))
    }
    return ports
  } catch { return [] }
}

/**
 * List dry-boot orphans: `dsh web` processes on a temp DSH_HOME holding an
 * ephemeral 9000-9999 listener. Conjunctive fingerprint + absolute exclusions
 * (self PID, live ports, real-home DSH_HOME) — a process is returned only when
 * every signal agrees it is a disposable dry-boot.
 */
export function listDryBootCandidates(readers: GcReaders = {}): DryBootCandidate[] {
  const readProc = readers.readProc ?? defaultReadProc
  const ssPortsOf = readers.ssPortsOf ?? defaultSsPortsOf
  const selfPid = readers.selfPid ?? process.pid
  const out: DryBootCandidate[] = []
  for (const p of readProc()) {
    if (p.pid === selfPid) continue
    if (!/bin\.ts web/.test(p.cmd)) continue
    const home = /^DSH_HOME=([^\0]*)/m.exec(p.env)?.[1] ?? ''
    if (!home.startsWith(join(tmpdir(), 'dsh-dryboot-'))) continue
    const ports = ssPortsOf(p.pid)
    if (ports.some(port => LIVE_PORTS.has(port))) continue
    const eph = ports.filter(port => port >= 9000 && port <= 9999)
    if (eph.length === 0) continue
    out.push({ pid: p.pid, port: eph[0], dshHome: home })
  }
  return out
}

/**
 * Boot a copy of the live web profile on an isolated DSH_HOME and verify the
 * plugin tree loads and serves. Returns ok + a one-line detail for the tool
 * message. The spawned tree is killed (best-effort) and the temp home removed.
 * Unit tests mock this (never spawn a real node boot in tests).
 *
 * NOTE (bin.ts finding): the `web` alias already implies `--profile web`, and
 * the web app's own commander program (no allowUnknownOption) rejects a stray
 * `--profile` in its inner args — so the spawn passes only `web --no-open
 * --port <port>`.
 */
export async function dryBootVerify(harnessRoot: string, opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; detail: string }> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const home = homedir()
  const liveProfile = join(home, '.dsh', 'profiles', 'web')
  if (!existsSync(liveProfile)) return { ok: true, detail: 'skipped (no live web profile)' }
  const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-dryboot-'))
  const logs: string[] = []
  let child: ReturnType<typeof spawn> | null = null
  try {
    copyProfileForDryBoot(liveProfile, join(tmpHome, 'profiles', 'web'))
    const port = String(9000 + Math.floor(Math.random() * 1000))
    const url = `http://127.0.0.1:${port}/`
    child = spawn('node', ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', '--port', port], {
      cwd: harnessRoot, env: { ...process.env, DSH_HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (d: Buffer) => logs.push(d.toString()))
    child.stderr?.on('data', (d: Buffer) => logs.push(d.toString()))
    const deadline = Date.now() + timeoutMs
    let code = -1
    while (Date.now() < deadline) {
      if (child.exitCode !== null) { code = child.exitCode; break }
      try { const r = await fetch(url); if (r.status === 200 || r.status === 401) { code = 0; break } } catch {}
      await new Promise(r => setTimeout(r, 500))
    }
    const tail = logs.join('').slice(-3000)
    const loadErr = /ERR_MODULE_NOT_FOUND|assertChannel|must declare output|failed to apply loader entry/.exec(tail)
    if (code === 0 && !loadErr) return { ok: true, detail: 'dry-boot ok' }
    return { ok: false, detail: dryBootFailureDetail(tail, code) }
  } catch (e: any) {
    return { ok: false, detail: `dry-boot error: ${e?.message ?? String(e)}` }
  } finally {
    // Kill on every exit path — a successful boot included. The dry boot only
    // exists to verify the tree; leaving the child up would orphan a dsh web
    // on the ephemeral port whose temp DSH_HOME is removed below, and a stale
    // orphan could later answer a port collision with a false-positive 200.
    try { child?.kill('SIGKILL') } catch {}
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  }
}

/**
 * Classify a failed dry-boot's log tail into a precise one-line detail. The
 * most common operator-actionable failure is an EADDRINUSE — the candidate
 * collided with the live dsh web tree on :3000/:3080 or with another process
 * on the ephemeral 9000-9999 port — so name the colliding port instead of
 * reporting a generic boot failure. Plugin-tree load errors keep their stable
 * codes (the caller's refused message reads `dry-boot failed — restart
 * refused. <detail>`).
 */
export function dryBootFailureDetail(tail: string, exitCode: number): string {
  const addrInUse = /EADDRINUSE[^]*?:(\d+)/.exec(tail)
  if (addrInUse) {
    const port = addrInUse[1]
    return `dry-boot failed: port ${port} already in use (EADDRINUSE) — the live dsh web tree or another process holds it`
  }
  const loadErr = /ERR_MODULE_NOT_FOUND|assertChannel|must declare output|failed to apply loader entry/.exec(tail)
  if (loadErr) return `dry-boot failed: ${loadErr[0]}`
  return `dry-boot failed (exit ${exitCode})`
}

/** Minimal file metadata the drift check reads; injectable for deterministic tests. */
export interface FileStat { mtimeMs: number }

/**
 * Whether the live plugin tree differs from the latest LKG snapshot. Three
 * signals are combined:
 *
 *   1. manifest drift — the live profile's web `package.json` text vs baseline;
 *   2. cordis patch drift — the live profile's web `cordis.patch.yml` text vs
 *      baseline (a patch-only config edit changes the boot-time row wiring
 *      without touching the manifest — the manifest check alone misses it);
 *   3. plugin-lib drift — any `@ddtcorex` plugin `lib/` file newer than the
 *      snapshot moment. Link-installed plugins resolve to the same workspace
 *      files in both live and LKG, so the stored copies cannot be compared
 *      byte-wise; the snapshot itself is the meaningful baseline and a rebuilt
 *      `lib/` bumps a file past it even when the manifest text is unchanged.
 *      writeLKG writes `manifest.json` LAST, so its FILE mtime is the
 *      authoritative snapshot moment; the snapshot dir mtime is only a
 *      fallback for legacy snapshots without a manifest.
 *
 * `statFile` (default `statSync`) reads the metadata so tests can inject a
 * controlled reader instead of relying on filesystem utimes (which CI runners
 * do not reliably reflect). No LKG baseline, a missing file on either side, or
 * any stat/read error means "changed" — the caller falls back to the dry-boot
 * gate.
 */
export function isPluginTreeChanged(
  harnessRoot: string,
  lkgDir = join(homedir(), '.dsh/.supervisor/lkg'),
  opts: { statFile?: (p: string) => FileStat } = {},
): boolean {
  void harnessRoot
  const statFile = opts.statFile ?? ((p: string) => statSync(p))
  try {
    const entries = existsSync(lkgDir) ? readdirSync(lkgDir).sort() : []
    const latest = entries[entries.length - 1]
    if (!latest) return true // no baseline → assume changed
    const lkgHome = join(lkgDir, latest, 'profiles', 'web')
    const live = join(homedir(), '.dsh', 'profiles', 'web')
    const lkgManifest = join(lkgHome, 'package.json')
    const liveManifest = join(live, 'package.json')
    if (!existsSync(lkgManifest) || !existsSync(liveManifest)) return true
    if (readFileSync(liveManifest, 'utf8') !== readFileSync(lkgManifest, 'utf8')) return true
    // cordis.patch.yml — compare only when at least one side has it (profiles
    // without a patch are the baseline; a patch appearing on either side alone
    // is drift). The text compare keeps the check cheap and hermetic.
    const lkgPatch = join(lkgHome, 'cordis.patch.yml')
    const livePatch = join(live, 'cordis.patch.yml')
    if (existsSync(lkgPatch) || existsSync(livePatch)) {
      if (!existsSync(lkgPatch) || !existsSync(livePatch)) return true
      if (readFileSync(livePatch, 'utf8') !== readFileSync(lkgPatch, 'utf8')) return true
    }
    const snapshotManifest = join(lkgDir, latest, 'manifest.json')
    const baseline = existsSync(snapshotManifest)
      ? statFile(snapshotManifest).mtimeMs
      : statFile(join(lkgDir, latest)).mtimeMs
    const livePlugins = join(live, 'node_modules', '@ddtcorex')
    if (existsSync(livePlugins)) {
      for (const name of readdirSync(livePlugins)) {
        const libDir = join(livePlugins, name, 'lib')
        if (!existsSync(libDir)) continue
        if (newestFileMtime(libDir, statFile) > baseline) return true
      }
    }
    return false
  } catch { return true }
}

/** Newest mtime under a directory; recursion threads the injected stat reader. */
function newestFileMtime(dir: string, statFile: (p: string) => FileStat): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestFileMtime(p, statFile))
    else newest = Math.max(newest, statFile(p).mtimeMs)
  }
  return newest
}

function currentSessionId(exec: any, fallback?: (exec: any) => string | undefined): string | undefined {
  // dsh-tools dispatch hands a ToolRunContext — the exec itself has no
  // sessionId/session/caller fields; session identity lives on the agent
  // (exec.agent.id is the branded SessionId, exec.agent.session.id also
  // exists). Probe those first so production dispatches are identifiable.
  return exec?.agent?.id ?? exec?.agent?.session?.id ?? exec?.sessionId ?? exec?.session?.id ?? exec?.caller?.sessionId ?? fallback?.(exec)
}

/**
 * Register the dsh_web_restart tool. Registration is fail-safe (warns, never
 * throws) and the returned function disposes the registration. `deps` are
 * injectable for tests.
 */
export function registerRestartTool(ctx: any, deps: {
  sessionIdOf?: (exec: any) => string | undefined
  dryBoot?: typeof dryBootVerify
  writeRestartRequest?: typeof writeRestartRequest
  harnessRoot?: string
  gcReaders?: GcReaders
  killPid?: (pid: number, sig: string) => void
} = {}): () => void {
  const doDryBoot = deps.dryBoot ?? dryBootVerify
  const doWrite = deps.writeRestartRequest ?? writeRestartRequest
  const doSessionId = deps.sessionIdOf ?? currentSessionId
  let dispose: (() => void) | undefined
  let disposeDryboot: (() => void) | undefined
  let disposeGc: (() => void) | undefined
  try {
    dispose = ctx.tools.register({
      name: 'dsh_web_restart',
      description: 'Schedule a safe restart of the dsh web host. Verifies the plugin tree first (dry-boot), records an intent for the calling session, and hands the restart to the supervisor daemon (out-of-band). Never restarts in-tree itself.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the restart is happening (recorded in the intent)' },
          pluginChanged: { type: 'boolean', description: 'Override for the auto-detected plugin-tree change check' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } },
        render: (_args: any, value: any) => [{ type: 'text', text: value.detail }],
      },
      execute: async (args: any, exec: any) => {
        const harnessRoot = deps.harnessRoot ?? (await import('./paths.js')).resolveDeepseekHarnessDir()
        const lkgDir = join(homedir(), '.dsh/.supervisor/lkg')
        const changed = args.pluginChanged === true || (args.pluginChanged !== false && isPluginTreeChanged(harnessRoot, lkgDir))
        if (changed) {
          const gate = await doDryBoot(harnessRoot)
          if (!gate.ok) return { ok: false, detail: `dry-boot failed — restart refused. ${gate.detail}` }
        }
        const callerSessionId = doSessionId(exec)
        if (!callerSessionId) {
          // The daemon's grace branch keys on callerSessionId — without it the
          // marker would be written but no restart would ever be supervised.
          return { ok: false, detail: 'cannot identify the calling session — restart not scheduled' }
        }
        doWrite({ callerSessionId, reason: typeof args.reason === 'string' ? args.reason : undefined }, 180_000)
        writeIntentSidecar(callerSessionId, args.reason)
        return { ok: true, detail: `restart scheduled (≈30s) — caller ${callerSessionId}` }
      },
    })
  } catch (e: any) {
    try { ctx.logger?.warn?.(`[supervisor] dsh_web_restart tool failed: ${e?.message ?? String(e)}`) } catch {}
  }
  try {
    disposeDryboot = ctx.tools.register({
      name: 'dsh_web_dryboot',
      description: 'Validate the plugin tree by booting a copy of the live profile on an ephemeral port. Never schedules or performs a restart; temp home removed afterwards.',
      parameters: {
        type: 'object',
        properties: {
          timeoutMs: { type: 'number', description: 'Gate timeout in ms (default 60000).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } },
        render: (_args: any, value: any) => [{ type: 'text', text: value.detail }],
      },
      execute: async (args: any) => {
        const harnessRoot = deps.harnessRoot ?? (await import('./paths.js')).resolveDeepseekHarnessDir()
        const gate = await doDryBoot(harnessRoot, typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : undefined)
        return { ok: gate.ok, detail: gate.detail }
      },
    })
  } catch (e: any) {
    try { ctx.logger?.warn?.(`[supervisor] dsh_web_dryboot tool failed: ${e?.message ?? String(e)}`) } catch {}
  }
  try {
    const doKill = deps.killPid ?? ((pid: number, sig: string) => process.kill(pid, sig as NodeJS.Signals))
    disposeGc = ctx.tools.register({
      name: 'dsh_web_gc',
      description: 'Reap orphaned dry-boot dsh web processes (temp DSH_HOME + ephemeral port). Preview-first: returns candidates without killing unless confirm:true.',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: 'Actually SIGKILL the candidates and verify they are gone.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { killed: { type: 'array' }, candidates: { type: 'array' } } },
        render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args: any) => {
        // INVARIANT: kill only conjunctive-fingerprint dry-boots (temp DSH_HOME
        // + ephemeral listener), never self / live ports / real-home processes.
        // Preview is the default; killing requires explicit confirm:true.
        const found = listDryBootCandidates(deps.gcReaders)
        if (args.confirm !== true) return { killed: [], candidates: found }
        const killed: number[] = []
        for (const c of found) {
          try { doKill(c.pid, 'SIGKILL') } catch {}
        }
        const remaining = listDryBootCandidates(deps.gcReaders)
        const alive = new Set(remaining.map(c => c.pid))
        for (const c of found) {
          if (!alive.has(c.pid)) killed.push(c.pid)
        }
        return { killed, candidates: remaining }
      },
    })
  } catch (e: any) {
    try { ctx.logger?.warn?.(`[supervisor] dsh_web_gc tool failed: ${e?.message ?? String(e)}`) } catch {}
  }
  return () => {
    try { if (typeof dispose === 'function') dispose() } catch {}
    try { if (typeof disposeDryboot === 'function') disposeDryboot() } catch {}
    try { if (typeof disposeGc === 'function') disposeGc() } catch {}
  }
}

function writeIntentSidecar(sessionId: string | undefined, reason: string | undefined): void {
  try {
    if (!sessionId) return
    const dir = join(homedir(), '.dsh/.supervisor/intents')
    const require = createRequire(import.meta.url)
    const { mkdirSync, writeFileSync, chmodSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(dir, { recursive: true })
    // Flatten slash-namespaced ids ('proj/abc' → 'proj_abc') so the sidecar is
    // a single file under intents/ and never needs a nested intents/proj/ dir.
    const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
    writeFileSync(join(dir, `${safeId}.json`), JSON.stringify({ ts: Date.now(), sessionId, reason: reason ?? '' }), 'utf8')
    try { chmodSync(join(dir, `${safeId}.json`), 0o600) } catch {}
  } catch {}
}