import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Serialized systemd restart for `dsh-web.service`: stop, wait until the
 * unit is inactive, then start — instead of one raw `systemctl restart`
 * that boots the new process while the old one still holds :3082 and
 * crash-loops on EADDRINUSE (2026-09-11 outage: 4 restarts in
 * 15 min over a ~90s SIGTERM stop → 30 EADDRINUSE crashes).
 *
 * All side effects are injectable so tests never touch systemd.
 */
export interface SerializedRestartDeps {
  /** Run a shell command; must throw on non-zero exit. */
  exec?: (cmd: string) => void
  /** Whether the unit is currently active. */
  isActive?: () => boolean
  sleep?: (ms: number) => Promise<void>
  /** Max time to wait for inactivity before starting anyway. */
  stopTimeoutMs?: number
  /** Poll interval while waiting for inactivity. */
  pollMs?: number
  /** Clock (injectable for tests). */
  now?: () => number
}

const STOP_TIMEOUT_MS = 120_000
const POLL_MS = 2_000

export async function serializedSystemdRestart(deps: SerializedRestartDeps = {}): Promise<void> {
  const exec = deps.exec ?? ((cmd: string) => {
    execSync(cmd, { timeout: 15_000, stdio: 'pipe' })
  })
  const isActive = deps.isActive ?? (() => {
    try {
      execSync('systemctl --user is-active --quiet dsh-web.service', { timeout: 5_000, stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  })
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const stopTimeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS
  const pollMs = deps.pollMs ?? POLL_MS
  const now = deps.now ?? Date.now
  // Best-effort: the unit may already be down (crash) — the wait + start
  // below still apply.
  try {
    exec('systemctl --user stop dsh-web.service')
  } catch { /* fall through to wait + start */ }
  const deadline = now() + stopTimeoutMs
  while (isActive()) {
    if (now() >= deadline) break
    await sleep(pollMs)
  }
  exec('systemctl --user start dsh-web.service')
}

export const DSH_WEB_UNIT_NAME = 'dsh-web.service'

export function dshWebUnitPath(): string {
  return process.env.DSH_WEB_UNIT_PATH ?? path.join(os.homedir(), '.config/systemd/user/dsh-web.service')
}

/** Does systemd own `dsh-web.service` on this host? */
export function systemdUnitExists(unitPath: string = dshWebUnitPath()): boolean {
  try { return fs.existsSync(unitPath) } catch { return false }
}

/**
 * The direct-node `nohup` fallback exists for portable hosts that have no
 * systemd unit. When the unit exists, systemd owns the boot: spawning node
 * behind its back is how a second instance appears — the two starts / one
 * rollback report of 2026-09-13. Gate on "the unit does not exist", never on
 * "this particular start failed".
 */
export function shouldUseNohupFallback(unitExists: boolean): boolean {
  return !unitExists
}
