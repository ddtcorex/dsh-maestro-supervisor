import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The supervisor daemon is the SECOND long-lived process in the system: it
 * caches `lib/*.js` in RAM at start, exactly like `dsh web`. A rebuild without
 * a daemon reload therefore leaves the OLD rollback logic running — the
 * 2026-09-13 restart storm (the daemon judged a slow boot as down and rolled
 * `dsh web` back in a loop) happened with a daemon started before the fix.
 *
 * These tests EXECUTE the helper against a stubbed `systemctl --user` plus a
 * real throwaway daemon process, because a source-inspection test cannot tell
 * which branch a shell conditional takes — the lesson from the 2026-09-12
 * deploy-guard incident.
 */

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
  'dsh-safe-restart',
  'scripts',
  'restart-dsh-web.sh',
)

interface Fixture {
  root: string
  binDir: string
  pluginDir: string
  pidFile: string
  /** Pids this fixture owns; killed in teardown so nothing outlives the test. */
  owned: number[]
}

let fixture: Fixture

/** A `systemctl --user` stand-in that mirrors dsh-web-supervisor.service: it
 *  reports the recorded MainPID and — like `Restart=always` — starts a
 *  replacement when the recorded pid is gone. A zombie counts as gone: systemd
 *  reaps its units, so `kill -0` alone would misreport a stopped daemon. */
function writeStubSystemctl(f: Fixture): void {
  const stub = `#!/usr/bin/env bash
pid_file="\${STUB_SUPERVISOR_PID_FILE:-}"
plugin_dir="\${STUB_PLUGIN_DIR:-}"
args="$*"
alive() {
  local p="$1" state
  [[ -d "/proc/$p" ]] || return 1
  state="$(awk '{print $3}' "/proc/$p/stat" 2>/dev/null)"
  [[ "$state" == Z ]] && return 1
  return 0
}
main_pid() {
  local pid=""
  [[ -f "$pid_file" ]] && pid="$(cat "$pid_file" 2>/dev/null)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) && ! alive "$pid"; then
    setsid node "$plugin_dir/lib/bin.js" daemon >/dev/null 2>&1 &
    pid=$!
    printf '%s' "$pid" > "$pid_file"
  fi
  printf '%s\\n' "\${pid:-0}"
}
case "$args" in
  *MainPID*) main_pid ;;
  *) exit 0 ;;
esac
`
  fs.writeFileSync(path.join(f.binDir, 'systemctl'), stub, { mode: 0o755 })
}

/** Running (not a zombie, not gone) — the same predicate the stub uses. */
function isRunning(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
    return state !== 'Z'
  } catch {
    return false
  }
}

function startDaemon(f: Fixture): number {
  const child = spawn('node', [path.join(f.pluginDir, 'lib', 'bin.js'), 'daemon'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  const pid = child.pid as number
  f.owned.push(pid)
  fs.writeFileSync(f.pidFile, String(pid))
  return pid
}

function runHelper(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      DSH_SUPERVISOR_PLUGIN_DIR: fixture.pluginDir,
      STUB_SUPERVISOR_PID_FILE: fixture.pidFile,
      STUB_PLUGIN_DIR: fixture.pluginDir,
      DSH_SUPERVISOR_RELOAD_WAIT: '5',
      ...env,
    },
  })
}

/** Age `lib/*.js` relative to now, in whole seconds (`stat -c %Y` resolution). */
function touchLib(f: Fixture, secondsFromNow: number): void {
  const when = new Date(Date.now() + secondsFromNow * 1000)
  for (const file of ['bin.js', 'index.js']) {
    const target = path.join(f.pluginDir, 'lib', file)
    fs.utimesSync(target, when, when)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-safe-restart-'))
  const binDir = path.join(root, 'bin')
  const pluginDir = path.join(root, 'plugin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true })
  // The daemon entry point is a real, cheap long-lived process.
  fs.writeFileSync(path.join(pluginDir, 'lib', 'bin.js'), 'setTimeout(() => {}, 60000)\n')
  fs.writeFileSync(path.join(pluginDir, 'lib', 'index.js'), 'export const id = "stub"\n')
  fixture = { root, binDir, pluginDir, pidFile: path.join(root, 'mainpid'), owned: [] }
  writeStubSystemctl(fixture)
})

afterEach(() => {
  const recorded = fs.existsSync(fixture.pidFile) ? Number(fs.readFileSync(fixture.pidFile, 'utf8')) : NaN
  for (const pid of [...fixture.owned, recorded]) {
    if (Number.isInteger(pid) && pid > 1) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

describe('restart-dsh-web.sh supervisor daemon freshness', () => {
  it('reports fresh when the daemon started after the newest lib build', async () => {
    touchLib(fixture, -60) // built a minute before the daemon starts
    await sleep(1200)
    startDaemon(fixture)

    const out = runHelper(['--check-supervisor'])
    expect(out).toMatch(/supervisor daemon: fresh/)
    expect(out).toMatch(/pid=\d+/)
  })

  it('reports stale when lib was rebuilt while the daemon kept running', async () => {
    startDaemon(fixture)
    await sleep(1200)
    touchLib(fixture, 0) // rebuilt after the daemon started

    const out = runHelper(['--check-supervisor'])
    expect(out).toMatch(/supervisor daemon: stale/)
  })

  it('reports absent when no supervisor daemon owns the unit', () => {
    fs.writeFileSync(fixture.pidFile, '0')
    const out = runHelper(['--check-supervisor'])
    expect(out).toMatch(/supervisor daemon: absent/)
  })

  it('never touches the daemon in check mode', async () => {
    const pid = startDaemon(fixture)
    await sleep(1200)
    touchLib(fixture, 0)

    runHelper(['--check-supervisor'])
    expect(isRunning(pid)).toBe(true)
  })

  it('leaves a fresh daemon alone in reload mode', async () => {
    touchLib(fixture, -60)
    await sleep(1200)
    const pid = startDaemon(fixture)

    const out = runHelper(['--reload-supervisor'])
    expect(out).toMatch(/supervisor daemon: fresh/)
    expect(isRunning(pid)).toBe(true)
  })

  it('reloads a stale daemon and reports the pid swap', async () => {
    const pid = startDaemon(fixture)
    await sleep(1200)
    touchLib(fixture, 0)

    const out = runHelper(['--reload-supervisor'])
    expect(out).toMatch(/supervisor daemon: reloaded/)
    expect(out).toContain(String(pid))
    // The stale process is gone and its replacement is the recorded MainPID.
    expect(isRunning(pid)).toBe(false)
    const replacement = Number(fs.readFileSync(fixture.pidFile, 'utf8'))
    fixture.owned.push(replacement)
    expect(replacement).not.toBe(pid)
    expect(isRunning(replacement)).toBe(true)
  })
})

describe('restart-dsh-web.sh supervisor step placement', () => {
  const script = fs.readFileSync(scriptPath, 'utf8')

  it('reloads the daemon before dsh web is stopped', () => {
    // The daemon must already run the built rules when the swap happens —
    // reloading it afterwards would let the old rules judge the new boot.
    const reloadIdx = script.lastIndexOf('ensure_supervisor_current')
    const stopIdx = script.indexOf('systemctl --user stop dsh-web.service')
    expect(reloadIdx).toBeGreaterThan(-1)
    expect(stopIdx).toBeGreaterThan(-1)
    expect(reloadIdx).toBeLessThan(stopIdx)
  })

  it('refuses to swap dsh web when the stale daemon cannot be reloaded', () => {
    expect(script).toMatch(/ensure_supervisor_current \|\| fail '[^']*refusing to swap/)
  })

  it('only signals a pid that really is the supervisor daemon', () => {
    expect(script).toContain('bin.js daemon')
    expect(script).toMatch(/systemctl --user show -p MainPID --value dsh-web-supervisor\.service/)
  })
})
