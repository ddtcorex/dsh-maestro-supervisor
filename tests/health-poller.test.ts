import { describe, it, expect, vi, afterEach } from 'vitest'
import { pollHealth } from '../src/host/health-poller.js'
import { clearPlannedRestart } from '../src/host/restart-guards.js'
import * as guards from '../src/host/restart-guards.js'

describe('health-poller', () => {
  it('reports up when curl 200', async () => {
    const r = await pollHealth({
      fetch: async () => ({ status: 200, text: async () => 'ok marker' }) as any,
      psAlive: async () => true,
      logTail: async () => '',
    })
    expect(r.up).toBe(true)
    expect(r.httpCode).toBe(200)
  })

  it('reports down when curl fails', async () => {
    const r = await pollHealth({
      fetch: async () => { throw new Error('ECONNREFUSED') },
      psAlive: async () => false,
      logTail: async () => '',
    })
    expect(r.up).toBe(false)
  })

  it('reports degraded (not down) when curl fails but the port is still listening', async () => {
    // A busy-but-alive process (e.g. heavy webhook-triggered review work
    // blocking dsh-web's own event loop) times out the same HTTP fetch a
    // real crash would — but a real crash always frees the port. `psAlive`
    // is the cheaper, non-contended corroboration that decides which one
    // this is (see 2026-08-31 restart-loop postmortem).
    const r = await pollHealth({
      fetch: async () => { throw new Error('This operation was aborted') },
      psAlive: async () => true,
      logTail: async () => '',
    })
    expect(r.up).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.error).toContain('aborted')
  })

  it('detects error in log tail', async () => {
    const r = await pollHealth({
      fetch: async () => ({ status: 200, text: async () => 'ok' }) as any,
      psAlive: async () => true,
      logTail: async () => 'ERR_MODULE_NOT_FOUND: cannot find lib/index.js',
    })
    expect(r.error).toContain('ERR_MODULE_NOT_FOUND')
    expect(r.up).toBe(true)
    expect(r.degraded).toBe(true)
  })

  it('reports degraded when log has assertChannel error but curl ok', async () => {
    const r = await pollHealth({
      fetch: async () => ({ status: 200, text: async () => 'ok' }) as any,
      psAlive: async () => true,
      logTail: async () => 'assertChannel failed: channel must start with /',
    })
    expect(r.up).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.error).toContain('assertChannel')
  })

  it('ignores structured Maestro Sync status logs after a healthy start', async () => {
    // Regression (2026-08-31): a healthy dsh web (HTTP 401) was rolled back and
    // restarted because the broad 'JSON' matcher flagged maestro-sync's status
    // line — its JSON payload lists session.jsonl.zstd / settings.json paths.
    const r = await pollHealth({
      fetch: async () => ({ status: 401, text: async () => 'unauthorized' }) as any,
      psAlive: async () => true,
      logTail: async () => [
        'dsh web: http://127.0.0.1:3080/?token=abc',
        '[maestro-sync] slim {"localOnly":91,"remoteOnly":51,"both":788,"localOnlyFiles":["sessions/--project-key--/009003fe-03d4-4f16-9915-6984e0aa7a4f/session.jsonl.zstd"],"remoteOnlyFiles":["memories/daily/2026-08-24.md.bak.1787658738478"],"bothFiles":[".anonymous-user-id","maestro/settings.json","memories/SUGGESTIONS.jsonl","memories/TODOS-work.md"],"connection":{"ok":true,"host":"example.com","latencyMs":2364},"remoteHost":"example.com"}',
      ].join('\n'),
    })
    expect(r.up).toBe(true)
    expect(r.httpCode).toBe(401)
    expect(r.error).toBeUndefined()
    expect(r.degraded).toBeUndefined()
  })

  afterEach(() => {
    clearPlannedRestart()
  })

  it('suppress fetch failed during planned restart 30s', async () => {
    const spy = vi.spyOn(guards, 'checkPlannedRestart').mockReturnValue(true)
    try {
      const res = await pollHealth({
        fetch: async () => { throw new Error('fetch failed') },
        logTail: async () => 'EADDRINUSE ...\ndsh web: http://127.0.0.1:3080/?token=abc',
        psAlive: async () => true,
      })
      expect(res.up).toBe(true)
      expect(res.error).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it('suppress logTail before ActiveEnter ignored', async () => {
    // log: success at start, then EADDRINUSE just after success, then 300 ok lines.
    // Without ActiveEnter/window filtering, lastError (EADDRINUSE) has no success after -> down.
    // With fallback window (last 200 after last "dsh web: http"), EADDRINUSE falls outside window -> up.
    const success = 'dsh web: http://127.0.0.1:3080/?token=abc'
    const earlyError = 'EADDRINUSE: address already in use :::3080'
    const tailOk = Array.from({ length: 300 }, (_, i) => `ok line ${i}`).join('\n')
    const log = `${success}\n${earlyError}\n${tailOk}`
    const res = await pollHealth({
      fetch: async () => ({ status: 200, text: async () => 'ok' }) as any,
      psAlive: async () => true,
      logTail: async () => log,
    })
    expect(res.up).toBe(true)
    expect(res.error).toBeUndefined()
  })
})
