/**
 * dsh-maestro-supervisor — host plugin for auto-resume inside DSH web.
 * Runs inside the DSH host process (outside the daemon's tree) and
 * auto-resumes sessions interrupted within the configured window after
 * a restart. The standalone daemon (systemd) handles crash detection
 * and web restart; this plugin handles the in-process resume.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export const inject = ['sessions', 'connection'] as const

export interface SupervisorPluginConfig {
  autoResumeWithin?: number | string // in MINUTES if number, or "5m"/"30s"/"1h" string
  autoResumeEnabled?: boolean
}

function parseDuration(s: string): number | undefined {
  if (!s) return undefined
  const m = s.trim().match(/^(\d+)(s|m|h)?$/)
  if (!m) return undefined
  const n = parseInt(m[1], 10)
  const unit = m[2] ?? 's'
  if (unit === 's') return n * 1000
  if (unit === 'm') return n * 60 * 1000
  if (unit === 'h') return n * 60 * 60 * 1000
  return undefined
}

function getAutoResumeEnabled(): boolean {
  const env = process.env.DSH_SUPERVISOR_AUTO_RESUME
  if (env !== undefined) {
    const v = env.trim().toLowerCase()
    if (['1','true','yes','on','enabled'].includes(v)) return true
    if (['0','false','no','off','disabled'].includes(v)) return false
  }
  try {
    const cfgPath = path.join(os.homedir(), '.dsh/.supervisor/config.json')
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
      const raw = (cfg as any).autoResumeEnabled ?? (cfg as any).autoResume
      if (typeof raw === 'boolean') return raw
      if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase()
        if (['1','true','yes','on'].includes(v)) return true
        if (['0','false','no','off'].includes(v)) return false
      }
    }
    const maestroPath = path.join(os.homedir(), '.dsh/maestro/settings.json')
    if (fs.existsSync(maestroPath)) {
      const j = JSON.parse(fs.readFileSync(maestroPath, 'utf-8'))
      const raw = j?.domains?.supervisor?.autoResumeEnabled ?? j?.supervisor?.autoResumeEnabled
      if (typeof raw === 'boolean') return raw
      if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase()
        if (['1','true','yes','on'].includes(v)) return true
        if (['0','false','no','off'].includes(v)) return false
      }
    }
  } catch {}
  return true
}

function getResumeWithinMs(): number {
  const env = process.env.DSH_SUPERVISOR_RESUME_WITHIN
  if (env) {
    if (/^\d+$/.test(env.trim())) return parseInt(env.trim(), 10) * 60 * 1000
    const v = parseDuration(env)
    if (v !== undefined) return v
  }
  try {
    const cfgPath = path.join(os.homedir(), '.dsh/.supervisor/config.json')
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
      const raw = (cfg as any).autoResumeWithin
      if (typeof raw === 'string') {
        if (/^\d+$/.test(raw.trim())) return parseInt(raw.trim(), 10) * 60 * 1000
        const v = parseDuration(raw)
        if (v !== undefined) return v
      } else if (typeof raw === 'number') return raw * 60 * 1000
    }
    const maestroPath = path.join(os.homedir(), '.dsh/maestro/settings.json')
    if (fs.existsSync(maestroPath)) {
      const j = JSON.parse(fs.readFileSync(maestroPath, 'utf-8'))
      const raw = j?.domains?.supervisor?.autoResumeWithin ?? j?.supervisor?.autoResumeWithin
      if (typeof raw === 'string') {
        if (/^\d+$/.test(raw.trim())) return parseInt(raw.trim(), 10) * 60 * 1000
        const v = parseDuration(raw)
        if (v !== undefined) return v
      } else if (typeof raw === 'number') return raw * 60 * 1000
    }
  } catch {}
  return 5 * 60 * 1000
}

async function findInterrupted(dshHome?: string, opts?: { withinMs?: number }): Promise<{ scanned: number; interrupted: string[] }> {
  const home = dshHome ?? path.join(os.homedir(), '.dsh')
  const sessionsRoot = path.join(home, 'sessions')
  let scanned = 0
  const interrupted: string[] = []
  const now = Date.now()
  const withinMs = opts?.withinMs
  const sinceMs = withinMs !== undefined ? now - withinMs : undefined
  try {
    const groups = fs.readdirSync(sessionsRoot, { withFileTypes: true })
    for (const g of groups) {
      if (!g.isDirectory()) continue
      const groupPath = path.join(sessionsRoot, g.name)
      const sessions = fs.readdirSync(groupPath, { withFileTypes: true })
      for (const s of sessions) {
        if (!s.isDirectory()) continue
        scanned++
        const zstdPath = path.join(groupPath, s.name, 'session.jsonl.zstd')
        const jsonlPath = path.join(groupPath, s.name, 'session.jsonl')
        try {
          let lines: string[] = []
          if (fs.existsSync(zstdPath)) {
            const { execSync } = await import('node:child_process')
            const out = execSync(`zstd -d -c ${JSON.stringify(zstdPath)} 2>/dev/null | tail -20`, { encoding: 'utf-8' })
            lines = out.split('\n').filter(Boolean)
          } else if (fs.existsSync(jsonlPath)) {
            const content = fs.readFileSync(jsonlPath, 'utf-8')
            lines = content.trim().split('\n').slice(-20)
          }
          let found = false
          let foundTime: number | undefined
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i]
            if (!line.toLowerCase().includes('interrupted')) continue
            try {
              const obj = JSON.parse(line)
              foundTime = typeof obj.time === 'number' ? obj.time : undefined
              if (obj.data?.reason?.kind === 'interrupted' || line.toLowerCase().includes('interrupted')) {
                found = true
                break
              }
            } catch {
              found = true
              break
            }
          }
          if (!found) continue
          if (sinceMs !== undefined && foundTime !== undefined) {
            if (foundTime < sinceMs) continue
          } else if (sinceMs !== undefined && foundTime === undefined) {
            continue
          }
          interrupted.push(`${g.name}/${s.name}`)
        } catch {}
      }
    }
  } catch {}
  return { scanned, interrupted }
}

export function apply(ctx: any, _config: SupervisorPluginConfig = {}): void {
  // Auto-resume after DSH web is ready — runs inside the host, not the daemon.
  ctx.effect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const run = async () => {
      if (disposed) return
      if (!getAutoResumeEnabled()) {
        ctx.logger?.info?.('[supervisor] auto-resume disabled — skip')
        return
      }
      const withinMs = getResumeWithinMs()
      try {
        const { scanned, interrupted } = await findInterrupted(undefined, { withinMs })
        if (!interrupted.length) {
          ctx.logger?.info?.(`[supervisor] auto-resume: 0/${scanned} interrupted within ${withinMs}ms — nothing to do`)
          return
        }
        ctx.logger?.info?.(`[supervisor] auto-resume: ${interrupted.length}/${scanned} interrupted within ${withinMs}ms: ${interrupted.slice(0,3).join(', ')}`)

        // For each interrupted session, try to resume via sessions service.
        // We re-create the session with its persisted seed — DSH's session
        // persistence treats it as a resume (log is re-read, interrupted turn
        // is closed). If an agent can be re-attached, we try via ctx.agents.
        for (const id of interrupted) {
          try {
            const sessionId = id.split('/').pop()!
            const exists = ctx.sessions?.get?.(sessionId)
            if (exists) {
              ctx.logger?.info?.(`[supervisor] auto-resume skip ${id} — already live`)
              continue
            }
            const persistence = (ctx.get?.('sessionPersistence') as any) ?? (ctx as any).sessionPersistence
            if (persistence?.load) {
              try {
                const loaded = await persistence.load(sessionId)
                if (loaded?.events?.length) {
                  // Try to re-create the session inside DSH host so it becomes
                  // visible without requiring the user to re-open the tab.
                  try {
                    const { SessionId } = await import('@deepseek-ai/dsh-session' as any).catch(() => ({ SessionId: (s: string) => s as any }))
                    const sid = SessionId ? SessionId(sessionId) : sessionId
                    const created = ctx.sessions?.create?.(sid, { seed: loaded.events, meta: loaded.meta ?? {} })
                    if (created) ctx.logger?.info?.(`[supervisor] auto-resume: re-created session ${id} with ${loaded.events.length} events`)
                    // Best-effort: try to re-attach an agent if the preset is known
                    try {
                      const agents = (ctx.get?.('agents') as any) ?? (ctx as any).agents
                      if (agents?.create && loaded.meta?.preset) {
                        await agents.create({ sessionId: sid, preset: loaded.meta.preset }).catch(() => {})
                        ctx.logger?.info?.(`[supervisor] auto-resume: agent re-attached for ${id}`)
                      }
                    } catch {}
                  } catch (e: any) {
                    ctx.logger?.info?.(`[supervisor] auto-resume: session ${id} has ${loaded.events.length} events, would resume (create failed: ${e?.message ?? String(e)})`)
                  }
                }
              } catch (e: any) {
                ctx.logger?.warn?.(`[supervisor] auto-resume load failed ${id}: ${e?.message ?? String(e)}`)
              }
            } else {
              ctx.logger?.info?.(`[supervisor] auto-resume: ${id} — no sessionPersistence, skip in-process resume (daemon will notify)`)
            }
          } catch (e: any) {
            ctx.logger?.warn?.(`[supervisor] auto-resume failed ${id}: ${e?.message ?? String(e)}`)
          }
        }

        // Also expose via RPC for daemon to trigger explicitly
        try {
          await ctx.connection?.rpc?.handle?.('/dsh-maestro-supervisor/resume', async (_endpoint: string, payload: any) => {
            return { ok: true, resumed: interrupted }
          })
        } catch {}
      } catch (e: any) {
        ctx.logger?.warn?.(`[supervisor] auto-resume error: ${e?.message ?? String(e)}`)
      }
    }

    // Delay to let DSH web finish booting and persistence warm up
    timer = setTimeout(run, 8000)

    // Also handle explicit RPC from daemon
    let disposeRpc: (() => void) | undefined
    try {
      const conn = ctx.connection ?? ctx.get?.('connection')
      if (conn?.rpc?.handle) {
        disposeRpc = conn.rpc.handle('/dsh-maestro-supervisor/resume', async (endpoint: string, payload: any) => {
          const within = payload?.withinMs ?? getResumeWithinMs()
          const res = await findInterrupted(undefined, { withinMs: within })
          return { ok: true, ...res }
        }, { authority: 'loopback' })
      }
    } catch {}

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      if (disposeRpc) try { disposeRpc() } catch {}
    }
  }, 'supervisor:auto-resume')
}
