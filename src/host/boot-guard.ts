import * as path from 'node:path'
import { acquireBootLock, releaseBootLock, type BootLockDeps } from './boot-lock.js'
import { markBootBoundary, dshWebLogPath } from './restart-guards.js'

/**
 * D6 — one restart implementation per concern.
 *
 * `performSingleBootRestart` (the daemon's path) takes `boot.lock` and appends
 * the `[supervisor] boot-boundary` sentinel through `markBootBoundary()`. The
 * manual skill script (`skills/dsh-safe-restart/scripts/restart-dsh-web.sh`)
 * must do exactly the same, or a human restart is neither serialized with a
 * supervised one (two boots racing for :3082) nor scoped in the append-only log
 * (the poller reads the previous boot's crash as this boot's).
 *
 * This module is that shared entry point: the script shells out to
 * `lib/bin.js boot-guard acquire|release --pid <shell pid>` instead of writing
 * either marker itself.
 */

/** Log the boundary sentinel belongs to (isolated home wins when set, for rehearsals). */
export function bootBoundaryLogPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_WEB_LOG) return env.DSH_WEB_LOG
  if (env.DSH_HOME) return path.join(env.DSH_HOME, 'dsh-web.log')
  return dshWebLogPath()
}

export interface BootGuard {
  acquired: boolean
  release: () => void
}

/**
 * Acquire the shared boot lock for `deps.pid` and append the boundary sentinel.
 * The sentinel is written first-thing after the lock, matching
 * `performSingleBootRestart` (marker before the port goes down).
 */
export function acquireBootGuard(deps: BootLockDeps = {}, logPath?: string): BootGuard {
  const lock = acquireBootLock(deps)
  if (!lock) return { acquired: false, release: () => {} }
  markBootBoundary(logPath ?? bootBoundaryLogPath())
  return { acquired: true, release: lock.release }
}

/** Release the lock only if `pid` still owns it (see releaseBootLock). */
export function releaseBootGuard(pid: number, deps: BootLockDeps = {}): boolean {
  return releaseBootLock(pid, deps)
}

export const BOOT_GUARD_BUSY_EXIT = 3
export const BOOT_GUARD_USAGE_EXIT = 64

/** CLI used by the skill script; returns the process exit code. */
export function runBootGuardCli(args: string[], deps: BootLockDeps = {}, logPath?: string): number {
  const action = args[0]
  const pidIdx = args.indexOf('--pid')
  const pid = pidIdx === -1 ? Number.NaN : Number(args[pidIdx + 1])
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error('boot-guard: --pid <owner pid> is required (pass the shell PID: $$)')
    return BOOT_GUARD_USAGE_EXIT
  }
  if (action === 'acquire') {
    const guard = acquireBootGuard({ ...deps, pid }, logPath)
    if (!guard.acquired) {
      console.error('busy: another boot holds boot.lock')
      return BOOT_GUARD_BUSY_EXIT
    }
    console.log('acquired')
    return 0
  }
  if (action === 'release') {
    releaseBootGuard(pid, deps)
    return 0
  }
  console.error(`boot-guard: unknown action: ${action ?? ''} (expected acquire|release)`)
  return BOOT_GUARD_USAGE_EXIT
}
