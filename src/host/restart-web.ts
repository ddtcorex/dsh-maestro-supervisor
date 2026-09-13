import * as os from 'node:os'
import * as path from 'node:path'
import { buildKillStalePortsCommand, writePlannedRestart } from './restart-guards.js'
import { serializedSystemdRestart, shouldUseNohupFallback, systemdUnitExists } from './restart-exec.js'
import { withBootLock, type BootLockDeps } from './boot-lock.js'
import { resolveDeepseekHarnessDir } from './paths.js'

/** Boot budget: how long a boot may take before its failures are judged. */
export const DEFAULT_BOOT_GRACE_MS = 180_000

export interface RestartWebDeps {
  exec?: (cmd: string, opts?: { timeout?: number }) => void
  writeMarker?: (ttlMs?: number) => void
  serializedRestart?: () => Promise<void>
  startViaSystemd?: () => void
  spawnNohup?: () => void | Promise<void>
  unitExists?: () => boolean
  bootGraceMs?: number
  lock?: BootLockDeps
}

export interface RestartWebResult {
  restarted: boolean
  reason?: string
}

/**
 * The single implementation of a supervised dsh web restart. Single-flight:
 * boot.lock is held from before the marker is written until the port answers,
 * so a racing tick or a second rollback skips instead of producing the second
 * systemd start that turned the incident's log tail toxic (2026-09-13).
 */
export async function performSingleBootRestart(deps: RestartWebDeps = {}): Promise<RestartWebResult> {
  const grace = deps.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS
  const outcome = await withBootLock(async () => {
    // Marker first, and inside the lock: every poll during the boot must know a
    // restart is in flight, and the TTL is the boot budget — not 30 s (D5).
    ;(deps.writeMarker ?? writePlannedRestart)(grace)
    const { execSync } = await import('node:child_process')
    const exec = deps.exec ?? ((cmd: string, opts?: { timeout?: number }) => {
      execSync(cmd, { timeout: opts?.timeout ?? 15_000, stdio: 'pipe' })
    })
    // A stale MainThread holding :3080/:3082 survives an EADDRINUSE crash with
    // http 200 still served, so the new start would lose the race.
    try { exec(buildKillStalePortsCommand(), { timeout: 5000 }) } catch {}
    try {
      await (deps.serializedRestart ?? (() => serializedSystemdRestart()))()
      return
    } catch {}
    try {
      ;(deps.startViaSystemd ?? (() => exec('systemctl --user start dsh-web.service', { timeout: 15_000 })))()
      return
    } catch {}
    const unitExists = (deps.unitExists ?? systemdUnitExists)()
    if (!shouldUseNohupFallback(unitExists)) {
      throw new Error('systemd manages dsh-web.service but start failed — refusing the direct-node fallback (it would create a second boot)')
    }
    await (deps.spawnNohup ?? defaultNohup)()
  }, deps.lock ?? {})
  if (!outcome.acquired) return { restarted: false, reason: 'another boot already holds boot.lock' }
  return { restarted: true }
}

async function defaultNohup(): Promise<void> {
  const { execSync } = await import('node:child_process')
  const harnessRoot = resolveDeepseekHarnessDir()
  const logPath = path.join(os.homedir(), '.dsh/dsh-web.log')
  execSync(
    `setsid nohup bash -c 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; cd ${JSON.stringify(harnessRoot)} && exec node --import tsx/esm apps/cli/src/bin.ts web --no-open >> ${JSON.stringify(logPath)} 2>&1' &`,
    { timeout: 5000 },
  )
}
