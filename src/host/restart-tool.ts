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

import { join } from 'node:path'
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { writeRestartRequest } from './restart-guards.js'

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
  try {
    cpSync(liveProfile, join(tmpHome, 'profiles', 'web'), { recursive: true, preserveTimestamps: true })
    const port = String(9000 + Math.floor(Math.random() * 1000))
    const url = `http://127.0.0.1:${port}/`
    const child = spawn('node', ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', '--port', port], {
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
    if (code !== 0) child.kill('SIGKILL')
    const tail = logs.join('').slice(-3000)
    const loadErr = /ERR_MODULE_NOT_FOUND|assertChannel|must declare output|failed to apply loader entry/.exec(tail)
    return { ok: code === 0 && !loadErr, detail: loadErr ? loadErr[0] : (code === 0 ? 'dry-boot ok' : `dry-boot failed (exit ${code})`) }
  } catch (e: any) {
    return { ok: false, detail: `dry-boot error: ${e?.message ?? String(e)}` }
  } finally {
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  }
}

/**
 * Whether the live profile's web package.json differs from the latest LKG
 * snapshot's copy. No LKG baseline, a missing file on either side, or any
 * read error means "changed" — the caller falls back to the dry-boot gate.
 */
export function isPluginTreeChanged(harnessRoot: string, lkgDir = join(homedir(), '.dsh/.supervisor/lkg')): boolean {
  void harnessRoot
  try {
    const entries = existsSync(lkgDir) ? readdirSync(lkgDir).sort() : []
    const latest = entries[entries.length - 1]
    if (!latest) return true // no baseline → assume changed
    const lkgManifestPath = join(lkgDir, latest, 'profiles', 'web', 'package.json')
    const live = join(homedir(), '.dsh', 'profiles', 'web', 'package.json')
    if (!existsSync(lkgManifestPath) || !existsSync(live)) return true
    const liveText = readFileSync(live, 'utf8')
    const lkgText = readFileSync(lkgManifestPath, 'utf8')
    return liveText !== lkgText
  } catch { return true }
}

function currentSessionId(exec: any, fallback?: (exec: any) => string | undefined): string | undefined {
  return exec?.sessionId ?? exec?.session?.id ?? exec?.caller?.sessionId ?? fallback?.(exec)
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
} = {}): () => void {
  const doDryBoot = deps.dryBoot ?? dryBootVerify
  const doWrite = deps.writeRestartRequest ?? writeRestartRequest
  const doSessionId = deps.sessionIdOf ?? currentSessionId
  let dispose: (() => void) | undefined
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
        doWrite({ callerSessionId, reason: typeof args.reason === 'string' ? args.reason : undefined }, 180_000)
        writeIntentSidecar(callerSessionId, args.reason)
        return { ok: true, detail: callerSessionId ? `restart scheduled (≈30s) — caller ${callerSessionId}` : 'restart scheduled (≈30s)' }
      },
    })
  } catch (e: any) {
    try { ctx.logger?.warn?.(`[supervisor] dsh_web_restart tool failed: ${e?.message ?? String(e)}`) } catch {}
  }
  return () => { try { if (typeof dispose === 'function') dispose() } catch {} }
}

function writeIntentSidecar(sessionId: string | undefined, reason: string | undefined): void {
  try {
    if (!sessionId) return
    const dir = join(homedir(), '.dsh/.supervisor/intents')
    const require = createRequire(import.meta.url)
    const { mkdirSync, writeFileSync, chmodSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(dir, { recursive: true })
    const safeId = sessionId.replace(/[^A-Za-z0-9._/-]/g, '_')
    writeFileSync(join(dir, `${safeId}.json`), JSON.stringify({ ts: Date.now(), sessionId, reason: reason ?? '' }), 'utf8')
    try { chmodSync(join(dir, `${safeId}.json`), 0o600) } catch {}
  } catch {}
}