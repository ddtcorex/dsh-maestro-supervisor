import type { HealthState } from './health-poller.js'
import { runDebugAgent } from './debug-agent.js'
import { findInterrupted as defaultFindInterrupted } from './resume.js'

export interface SupervisorDeps {
  pollHealth: () => Promise<HealthState>
  writeLKG: () => Promise<{ ts: string; manifest: any }>
  writeFailed: () => Promise<{ ts: string; manifest: any }>
  writeReport: (opts: { ts: string; health: HealthState; action: string }) => Promise<string>
  rollback: (ts?: string) => Promise<void>
  notify: (msg: string) => Promise<void>
  intervalMs?: number
  debounceMs?: number
  getTime?: () => number
  // injectable for test / LLM wiring
  runDebugAgent?: (opts: { reportPath: string; health: HealthState }) => Promise<{ fixed: boolean; reason: string }>
  findInterrupted?: () => Promise<{ scanned: number; interrupted: string[] }>
}

export class Supervisor {
  private deps: SupervisorDeps
  private lastRollback = 0
  private rollingBack = false
  private lastLKGWrite = 0
  private lastDegradedNotify = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: SupervisorDeps) {
    this.deps = deps
  }

  private getRunDebugAgent() {
    return this.deps.runDebugAgent ?? runDebugAgent
  }

  private getFindInterrupted() {
    return this.deps.findInterrupted ?? defaultFindInterrupted
  }

  private handleDebugResult(reportPath: string, res: { fixed: boolean; reason: string }): void {
    if (res.fixed) {
      void this.deps.notify(`FIXED: debug-agent fixed ${reportPath} — ${res.reason}`).catch(() => {})
      // After fix, try to resume interrupted sessions
      void this.getFindInterrupted()().then(r => {
        if (r.interrupted.length) void this.deps.notify(`RESUME: ${r.interrupted.length} interrupted sessions (${r.interrupted.slice(0, 3).join(', ')})`).catch(() => {})
      }).catch(() => {})
    } else if (res.reason.includes('max attempts')) {
      void this.deps.notify(`FIX FAILED after 3 attempts — needs human (report: ${reportPath}, reason: ${res.reason})`).catch(() => {})
    } else if (res.reason.includes('cooldown')) {
      // silent — cooldown, no notify
    } else {
      // non-fixed but not max attempts — still surface for visibility
      void this.deps.notify(`FIX FAILED: ${res.reason} (report: ${reportPath})`).catch(() => {})
    }
  }

  async tick(): Promise<void> {
    const health = await this.deps.pollHealth()

    // DEGRADED: http 200 but log has plugin error → report, notify, no rollback
    if (health.degraded) {
      const now = this.deps.getTime ? this.deps.getTime() : Date.now()
      if (now - this.lastDegradedNotify < 60000) return
      this.lastDegradedNotify = now
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const reportPath = await this.deps.writeReport({ ts, health, action: `degraded — ${health.error ?? 'plugin'}` }).catch(() => '')
        await this.deps.notify(`DEGRADED: ${health.error ?? 'plugin'} (report: ${reportPath})`).catch(() => {})
        // Phase 3: debug + resume — use injected fn if provided (even in VITEST), otherwise fire-and-forget real impl (skip in VITEST)
        const runner = this.getRunDebugAgent()
        const finder = this.getFindInterrupted()
        const isInjected = !!this.deps.runDebugAgent
        if (isInjected) {
          void runner({ reportPath, health }).then(res => this.handleDebugResult(reportPath, res)).catch(() => {})
          setTimeout(() => {
            finder().then(r => {
              if (r.interrupted.length) this.deps.notify(`RESUME: ${r.interrupted.length} interrupted sessions (${r.interrupted.slice(0,3).join(', ')})`).catch(() => {})
            }).catch(() => {})
          }, 0)
        } else if (!process.env.VITEST) {
          void runner({ reportPath, health }).then(res => this.handleDebugResult(reportPath, res)).catch(() => {})
          setTimeout(() => {
            finder().then(r => {
              if (r.interrupted.length) this.deps.notify(`RESUME: ${r.interrupted.length} interrupted sessions (${r.interrupted.slice(0,3).join(', ')})`).catch(() => {})
            }).catch(() => {})
          }, 0)
        }
      } catch {}
      return
    }

    if (health.up) {
      // Throttle LKG writes to at most once per 5 minutes
      const now = this.deps.getTime ? this.deps.getTime() : Date.now()
      if (now - this.lastLKGWrite > 5 * 60 * 1000) {
        try {
          await this.deps.writeLKG()
          this.lastLKGWrite = now
        } catch {
          // ignore snapshot errors
        }
      }
      return
    }

    // Down — check debounce and rolling state
    if (this.rollingBack) return
    const now = this.deps.getTime ? this.deps.getTime() : Date.now()
    const debounceMs = this.deps.debounceMs ?? 60000
    if (now - this.lastRollback < debounceMs) return

    this.rollingBack = true
    this.lastRollback = now

    try {
      const failed = await this.deps.writeFailed().catch(() => ({ ts: new Date().toISOString().replace(/[:.]/g, '-'), manifest: null }))
      const ts = (failed as any)?.ts ?? new Date().toISOString().replace(/[:.]/g, '-')
      const reportPath = await this.deps.writeReport({ ts, health, action: `rollback — ${health.error ?? 'down'}` }).catch(() => '')
      await this.deps.rollback()
      await this.deps.notify(`CRASH detected → rollback (report: ${reportPath}, error: ${health.error ?? 'down'})`).catch(() => {})
      const runner = this.getRunDebugAgent()
      const finder = this.getFindInterrupted()
      const isInjected = !!this.deps.runDebugAgent
      if (isInjected) {
        void runner({ reportPath, health }).then(res => this.handleDebugResult(reportPath, res)).catch(() => {})
        setTimeout(() => {
          finder().then(r => {
            if (r.interrupted.length) this.deps.notify(`RESUME: ${r.interrupted.length} interrupted sessions`).catch(() => {})
          }).catch(() => {})
        }, 0)
      } else if (!process.env.VITEST) {
        void runner({ reportPath, health }).then(res => this.handleDebugResult(reportPath, res)).catch(() => {})
        setTimeout(() => {
          finder().then(r => {
            if (r.interrupted.length) this.deps.notify(`RESUME: ${r.interrupted.length} interrupted sessions`).catch(() => {})
          }).catch(() => {})
        }, 0)
      }
    } finally {
      this.rollingBack = false
    }
  }

  start(): void {
    if (this.timer) return
    const intervalMs = this.deps.intervalMs ?? 3000
    this.timer = setInterval(() => { this.tick().catch(() => {}) }, intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
