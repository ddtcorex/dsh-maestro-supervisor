import { execSync } from 'node:child_process'

/**
 * Serialized systemd restart for `dsh-web.service`: stop, wait until the
 * unit is inactive, then start — instead of one raw `systemctl restart`
 * that boots the new process while the old one still holds :3082 and
 * crash-loops on EADDRINUSE (2026-09-11 dsh-home outage: 4 restarts in
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
