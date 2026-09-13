import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pollHealth, bootFreshness, classifyFetchFailure } from '../src/host/health-poller.js'
import { clearPlannedRestart, BOOT_BOUNDARY_MARKER } from '../src/host/restart-guards.js'
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

describe('bootFreshness', () => {
  const NOW = 1_800_000_000_000
  const GRACE = 180_000

  it('is unknown without a boot anchor (systemd absent) so nothing is suppressed', () => {
    expect(bootFreshness({ activeEnterAtMs: undefined, now: NOW, bootGraceMs: GRACE, probeSucceeded: false })).toBe('unknown')
  })

  it('is unknown when the anchor is in the future (clock skew)', () => {
    expect(bootFreshness({ activeEnterAtMs: NOW + 1, now: NOW, bootGraceMs: GRACE, probeSucceeded: false })).toBe('unknown')
  })

  it('is booting while the grace is open and this boot has printed no success marker', () => {
    expect(bootFreshness({ activeEnterAtMs: NOW - 78_000, now: NOW, bootGraceMs: GRACE, probeSucceeded: false })).toBe('booting')
  })

  it("is settled as soon as this boot's own success marker was seen", () => {
    expect(bootFreshness({ activeEnterAtMs: NOW - 5_000, now: NOW, bootGraceMs: GRACE, probeSucceeded: true })).toBe('settled')
  })

  it('is settled once the grace expired without a success marker', () => {
    expect(bootFreshness({ activeEnterAtMs: NOW - GRACE, now: NOW, bootGraceMs: GRACE, probeSucceeded: false })).toBe('settled')
  })
})

describe('classifyFetchFailure', () => {
  it('sees through undici TypeError("fetch failed") to a refused connection', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3082'), { code: 'ECONNREFUSED' }) })
    expect(classifyFetchFailure(err)).toBe('refused')
  })

  it('classifies a bare refused message as refused', () => {
    expect(classifyFetchFailure('connect ECONNREFUSED 127.0.0.1:3082')).toBe('refused')
  })

  it('classifies the poller abort message as timeout (the incident string)', () => {
    const err = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    expect(classifyFetchFailure(err)).toBe('timeout')
  })

  it('classifies an undici connect timeout as timeout', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })
    expect(classifyFetchFailure(err)).toBe('timeout')
  })

  it('falls back to other for anything it cannot attribute', () => {
    expect(classifyFetchFailure('http 500')).toBe('other')
    expect(classifyFetchFailure(undefined)).toBe('other')
  })
})

describe('pollHealth boot grace (2026-09-13 incident)', () => {
  const ABORT = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  // Hermetic: the planned-restart marker is a real file under ~/.dsh, so a live
  // supervisor daemon that recently restarted web would otherwise suppress the
  // very poll these cases are about.
  let markerSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { markerSpy = vi.spyOn(guards, 'checkPlannedRestart').mockReturnValue(false) })
  afterEach(() => { markerSpy.mockRestore() })

  it('suppresses a timeout/abort while the boot is unproven instead of degrading', async () => {
    // Before the fix this returned { up:true, degraded:true } (the port was
    // still held by the previous instance, so psAlive said "alive") and the
    // supervisor rolled back after 5 consecutive polls — the incident.
    const res = await pollHealth({
      fetch: async () => { throw ABORT },
      psAlive: async () => true,
      logTail: async () => '',
      activeEnterAtMs: Date.now() - 78_000,
      bootGraceMs: 180_000,
    })
    expect(res.bootPhase).toBe('booting')
    expect(res.up).toBe(true)
    expect(res.degraded).toBeFalsy()
    expect(res.error).toBeUndefined()
  })

  it('still reports a refused connection as down while the boot is unproven', async () => {
    // A refused connection means nothing is listening: the process is gone,
    // and the boot grace must not mask that.
    const res = await pollHealth({
      fetch: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3082') },
      psAlive: async () => false,
      logTail: async () => '',
      activeEnterAtMs: Date.now() - 10_000,
      bootGraceMs: 180_000,
    })
    expect(res.bootPhase).toBe('booting')
    expect(res.up).toBe(false)
    expect(res.error).toContain('ECONNREFUSED')
  })

  it('treats a refused connection as a boot symptom while the process is verifiably alive (D5)', async () => {
    // During the boot window the raw webserver may not be bound yet even though
    // the process holds the port: nothing to degrade for, and the counters must
    // stay untouched. A refused connection with psAlive() === false still counts
    // (previous case) — the aliveness probe is what separates the two.
    const res = await pollHealth({
      fetch: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3082') },
      psAlive: async () => true,
      logTail: async () => '',
      activeEnterAtMs: Date.now() - 10_000,
      bootGraceMs: 180_000,
    })
    expect(res.bootPhase).toBe('booting')
    expect(res.up).toBe(true)
    expect(res.degraded).toBeFalsy()
    expect(res.error).toBeUndefined()
  })

  it('judges a refused-but-alive connection normally once the boot grace has expired', async () => {
    // D5 is scoped to the unproven boot: after the window the existing
    // psAlive-based degraded verdict applies, exactly as before.
    const res = await pollHealth({
      fetch: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3082') },
      psAlive: async () => true,
      logTail: async () => '',
      activeEnterAtMs: Date.now() - 200_000,
      bootGraceMs: 180_000,
    })
    expect(res.bootPhase).toBe('settled')
    expect(res.up).toBe(true)
    expect(res.degraded).toBe(true)
    expect(res.error).toContain('ECONNREFUSED')
  })

  it('judges the same timeout normally once the boot grace has expired', async () => {
    const res = await pollHealth({
      fetch: async () => { throw ABORT },
      psAlive: async () => true,
      logTail: async () => '',
      activeEnterAtMs: Date.now() - 200_000,
      bootGraceMs: 180_000,
    })
    expect(res.bootPhase).toBe('settled')
    expect(res.up).toBe(true)
    expect(res.degraded).toBe(true)
  })

  it('reads bootGraceMs from opts when given', async () => {
    const res = await pollHealth({
      fetch: async () => ({ status: 200, text: async () => 'ok' }) as any,
      psAlive: async () => true,
      logTail: async () => '',
      activeEnterAtMs: Date.now() - 50_000,
      bootGraceMs: 10_000,
    })
    expect(res.bootPhase).toBe('settled')
  })
})

describe('log scan scoping (2026-09-13 incident log shape)', () => {
  const NOW = Date.now()
  const ACTIVE_ENTER_AT = NOW - 78_000
  const BOUNDARY_AT = ACTIVE_ENTER_AT - 5_000

  let markerSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { markerSpy = vi.spyOn(guards, 'checkPlannedRestart').mockReturnValue(false) })
  afterEach(() => { markerSpy.mockRestore() })

  const incidentLog = [
    'dsh web: http://127.0.0.1:3082/?token=previous-boot',
    'listening on 3080',
    'Error: listen EADDRINUSE: address already in use 127.0.0.1:3082',
    '    at Server.setupListenHandle (node:net:1940:16)',
    `${BOOT_BOUNDARY_MARKER} ${new Date(BOUNDARY_AT).toISOString()}`,
    '[workspace] loading plugin tree…',
  ].join('\n')

  const incidentLogWithEarlyMarker = [
    'dsh web: http://127.0.0.1:3082/?token=previous-boot',
    'Error: listen EADDRINUSE: address already in use 127.0.0.1:3082',
    `${BOOT_BOUNDARY_MARKER} ${new Date(BOUNDARY_AT).toISOString()}`,
    'dsh web: http://127.0.0.1:3082/?token=this-boot',
    '[workspace] loading plugin tree…',
  ].join('\n')

  it('does not treat an early success marker as proof while the probe still hangs', async () => {
    // 2026-09-13 restart loop: the marker above is printed when the RAW webserver
    // binds, not when the tree serves. Crediting it ended the grace and every
    // hung probe during the remaining boot counted as a crash.
    const res = await pollHealth({
      fetch: async () => { throw ABORT },
      psAlive: async () => true,
      logTail: async () => incidentLogWithEarlyMarker,
      activeEnterAtMs: ACTIVE_ENTER_AT,
      bootGraceMs: 180_000,
    })
    expect(res.bootPhase).toBe('booting')
    expect(res.up).toBe(true)
    expect(res.degraded).toBeFalsy()
  })

  it('never reads the previous boot EADDRINUSE as this boot when the scan is scoped', async () => {
    const res = await pollHealth({
      fetch: async () => ({ status: 200, text: async () => 'ok' }) as any,
      psAlive: async () => true,
      logTail: async () => incidentLog,
      activeEnterAtMs: ACTIVE_ENTER_AT,
      bootGraceMs: 180_000,
    })
    // This poll answered (200), so the boot is proven and judged normally; the
    // incident's shape — a probe that hangs while the tree is still coming up —
    // is the 'booting' case covered above.
    expect(res.bootPhase).toBe('settled')
    expect(res.up).toBe(true)
    expect(res.degraded).toBeFalsy()
    expect(res.error).toBeUndefined()
  })

  it('does not credit a stale success marker from a boot we cannot scope', async () => {
    // No boundary line at all: the previous boot's marker must not prove THIS
    // boot, otherwise the grace is skipped and the old crash text is judged.
    const stale = [
      'dsh web: http://127.0.0.1:3082/?token=previous-boot',
      'Error: listen EADDRINUSE: address already in use 127.0.0.1:3082',
    ].join('\n')
    const res = await pollHealth({
      fetch: async () => { throw new Error('This operation was aborted') },
      psAlive: async () => true,
      logTail: async () => stale,
      activeEnterAtMs: ACTIVE_ENTER_AT,
      bootGraceMs: 180_000,
    })
    expect(res.bootPhase).toBe('booting')
    expect(res.up).toBe(true)
    expect(res.degraded).toBeFalsy()
    expect(res.error).toBeUndefined()
  })

  it('still reports a real post-start crash of the current boot', async () => {
    const log = [
      `${BOOT_BOUNDARY_MARKER} ${new Date(BOUNDARY_AT).toISOString()}`,
      'dsh web: http://127.0.0.1:3082/?token=this-boot',
      "ERR_MODULE_NOT_FOUND: Cannot find module '/home/example/.dsh/profiles/web/node_modules/@ddtcorex/dsh-maestro-memory/lib/index.js'",
    ].join('\n')
    const res = await pollHealth({
      fetch: async () => ({ status: 200, text: async () => 'ok' }) as any,
      psAlive: async () => true,
      logTail: async () => log,
      activeEnterAtMs: ACTIVE_ENTER_AT,
      bootGraceMs: 180_000,
    })
    expect(res.bootPhase).toBe('settled')
    expect(res.up).toBe(true)
    expect(res.degraded).toBe(true)
    expect(res.error).toContain('ERR_MODULE_NOT_FOUND')
  })
})
