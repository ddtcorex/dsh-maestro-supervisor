import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * One-boot-at-a-time guard (spec D4, incident 2026-09-13). Every path that
 * starts dsh web takes this lock from the moment the restart is issued until
 * the port answers, so a racing tick, the dsh_web_restart hand-off, or a
 * rollback that fires while the first boot is still coming up skips instead of
 * producing the second systemd start that made the incident's log tail toxic.
 *
 * The lock is an atomically created file (`O_EXCL`) carrying `{pid, ts}`. An
 * existing lock is honored unless its owner is gone or it has outlived
 * `staleMs` (the boot budget). Node exposes no flock(2) binding; O_EXCL plus
 * PID liveness gives the same mutual exclusion deterministically, and every
 * side effect is injectable so tests never touch the real ~/.dsh/.supervisor.
 */
export const DEFAULT_BOOT_LOCK_STALE_MS = 180_000

export interface BootLockDeps {
  lockPath?: string
  createExclusive?: (p: string, body: string) => boolean
  readLock?: (p: string) => string | undefined
  remove?: (p: string) => void
  pidAlive?: (pid: number) => boolean
  now?: () => number
  staleMs?: number
  sleep?: (ms: number) => Promise<void>
  portUp?: () => Promise<boolean>
  waitTimeoutMs?: number
  pollMs?: number
  /**
   * Owner recorded in the lock file; defaults to this process. The skill script
   * (D6) holds the lock with the shell's own PID, so liveness stays meaningful
   * while the shell performs the restart.
   */
  pid?: number
}

export interface BootLock {
  path: string
  release: () => void
}

export function bootLockPath(): string {
  return process.env.DSH_SUPERVISOR_BOOT_LOCK ?? path.join(os.homedir(), '.dsh/.supervisor/boot.lock')
}

function resolved(deps: BootLockDeps) {
  return {
    lockPath: deps.lockPath ?? bootLockPath(),
    createExclusive: deps.createExclusive ?? ((p: string, body: string) => {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, body, { flag: 'wx', mode: 0o600 })
        return true
      } catch { return false }
    }),
    readLock: deps.readLock ?? ((p: string) => {
      try { return fs.readFileSync(p, 'utf8') } catch { return undefined }
    }),
    remove: deps.remove ?? ((p: string) => { try { fs.unlinkSync(p) } catch {} }),
    pidAlive: deps.pidAlive ?? ((pid: number) => {
      if (!Number.isInteger(pid) || pid <= 0) return false
      if (pid === process.pid) return true
      try { process.kill(pid, 0); return true } catch { return false }
    }),
    now: deps.now ?? (() => Date.now()),
    staleMs: deps.staleMs ?? DEFAULT_BOOT_LOCK_STALE_MS,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms))),
    portUp: deps.portUp ?? defaultPortUp,
    waitTimeoutMs: deps.waitTimeoutMs ?? DEFAULT_BOOT_LOCK_STALE_MS,
    pollMs: deps.pollMs ?? 3_000,
    pid: deps.pid ?? process.pid,
  }
}

function parseLock(raw: string | undefined): { pid: number; ts: number } | undefined {
  if (!raw) return undefined
  try {
    const j = JSON.parse(raw)
    if (typeof j?.pid === 'number' && typeof j?.ts === 'number') return { pid: j.pid, ts: j.ts }
  } catch {}
  return undefined
}

/** Take the boot lock, or return undefined when another live boot owns it. */
export function acquireBootLock(deps: BootLockDeps = {}): BootLock | undefined {
  const d = resolved(deps)
  const body = JSON.stringify({ pid: d.pid, ts: d.now() })
  const take = (): BootLock | undefined =>
    d.createExclusive(d.lockPath, body) ? { path: d.lockPath, release: () => d.remove(d.lockPath) } : undefined
  const first = take()
  if (first) return first
  const existing = parseLock(d.readLock(d.lockPath))
  const stale = existing === undefined || !d.pidAlive(existing.pid) || d.now() - existing.ts > d.staleMs
  if (!stale) return undefined
  d.remove(d.lockPath)
  return take()
}

/**
 * Release the lock only when `pid` still owns it. A boot that lost the race (or
 * whose stale lock was taken over) must never delete the winner's lock file.
 */
export function releaseBootLock(pid: number, deps: BootLockDeps = {}): boolean {
  const d = resolved(deps)
  const existing = parseLock(d.readLock(d.lockPath))
  if (existing === undefined || existing.pid !== pid) return false
  d.remove(d.lockPath)
  return true
}

async function defaultPortUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    try {
      // Any HTTP answer (200/303/401) means the boot is serving.
      await fetch('http://127.0.0.1:3080/', { signal: ctrl.signal })
      return true
    } finally { clearTimeout(t) }
  } catch { return false }
}

/** Poll the port until it answers or the boot budget expires. */
export async function waitForPort(deps: BootLockDeps = {}): Promise<boolean> {
  const d = resolved(deps)
  const deadline = d.now() + d.waitTimeoutMs
  for (;;) {
    try { if (await d.portUp()) return true } catch {}
    if (d.now() >= deadline) return false
    await d.sleep(d.pollMs)
  }
}

/**
 * Run `fn` under the boot lock, then hold the lock until the port answers (or
 * the boot budget expires). Returns `{ acquired: false }` — without running
 * `fn` — when another boot already owns the lock.
 */
export async function withBootLock<T>(
  fn: () => Promise<T>,
  deps: BootLockDeps = {},
): Promise<{ acquired: boolean; value?: T }> {
  const lock = acquireBootLock(deps)
  if (!lock) return { acquired: false }
  try {
    const value = await fn()
    await waitForPort(deps)
    return { acquired: true, value }
  } finally {
    lock.release()
  }
}
