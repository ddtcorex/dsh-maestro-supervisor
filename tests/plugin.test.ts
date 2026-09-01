import { describe, it, expect, vi } from 'vitest'
import { resumeInterrupted, runAutoResume, apply, createResumeRpcHandler, createSessionHealthRpcHandler, inject } from '../src/host/plugin.js'

function makeCtx(overrides: Record<string, any> = {}) {
  const logs: string[] = []
  return {
    logger: {
      info: (msg: string) => logs.push(`info:${msg}`),
      warn: (msg: string) => logs.push(`warn:${msg}`),
    },
    sessions: { get: () => undefined },
    get: (key: string) => (overrides[key] !== undefined ? overrides[key] : undefined),
    _logs: logs,
    ...overrides,
  }
}

describe('resumeInterrupted', () => {
  it('sends continue to an already live agent instead of skipping its session', async () => {
    const followup = vi.fn()
    const ctx = makeCtx({
      sessions: { get: () => ({ status: 'active' }) },
      agents: { get: () => ({ followup }) },
    })
    await expect(resumeInterrupted(ctx, ['proj/abc-123'])).resolves.toEqual(['proj/abc-123'])
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a session with no sessionPersistence available', async () => {
    const ctx = makeCtx()
    await expect(resumeInterrupted(ctx, ['proj/abc-123'])).resolves.toEqual([])
  })

  it('continues to the next id when one session throws', async () => {
    const throwingPersistence = { load: async () => { throw new Error('disk error') } }
    const ctx = makeCtx({ sessionPersistence: throwingPersistence })
    await expect(resumeInterrupted(ctx, ['proj/bad-1', 'proj/bad-2'])).resolves.toEqual([])
    expect(ctx._logs.filter((l: string) => l.includes('warn:')).length).toBeGreaterThanOrEqual(2)
  })

  it('resumes a self-restart caller with a contextual message and consumes the intent', async () => {
    const followup = vi.fn()
    const ctx = makeCtx({ agents: { get: () => ({ followup }) } })
    const consume = vi.fn()
    const read = (id: string) => (id === 'abc' ? { ts: 1, sessionId: 'abc', reason: 'e2e-test' } : undefined)
    const resumed = await resumeInterrupted(ctx, ['proj/abc'], { readIntent: read, consumeIntent: consume })
    expect(resumed).toEqual(['proj/abc'])
    const text = followup.mock.calls[0][0].content[0].text as string
    expect(text).toContain('requested a dsh web restart')
    expect(text).toContain('e2e-test')
    expect(consume).toHaveBeenCalledWith('abc')
  })

  it('sends a "continue" follow-up turn after successfully re-attaching an agent', async () => {
    const followup = vi.fn()
    const persistence = {
      load: async () => ({
        events: [{ type: 'turn/end', data: { reason: { kind: 'interrupted' } } }],
        meta: { agentPreset: 'default' },
      }),
    }
    const resumeAgent = vi.fn(async () => ({ agent: { followup } }))
    const ctx = makeCtx({
      sessionPersistence: persistence,
      sessions: { get: () => undefined, create: () => true },
      agents: { get: () => undefined, resume: resumeAgent },
    })
    await resumeInterrupted(ctx, ['proj/session-abc'])
    expect(resumeAgent).toHaveBeenCalledTimes(1)
    expect(resumeAgent).toHaveBeenCalledWith({ resumeSessionId: 'session-abc' })
    expect(followup).toHaveBeenCalledTimes(1)
    const sentMessage = followup.mock.calls[0][0]
    // Recovery prompt must mention interruption + bash verification (repair.ts:104 TOOL_OUTCOME_UNKNOWN)
    expect(sentMessage.content[0].text).toContain('interrupted')
    expect(sentMessage.content[0].text).toContain('bash')
    expect(sentMessage.content[0].text).toContain('TOOL_OUTCOME_UNKNOWN')
    expect(sentMessage.source).toEqual({ kind: 'user' })
    expect(ctx._logs.some((l: string) => l.includes('sent recovery continue'))).toBe(true)
  })

  it('restores the persisted provider and model when resuming an agent', async () => {
    const resumeAgent = vi.fn(async () => ({ agent: { followup: vi.fn() } }))
    const ctx = makeCtx({
      sessionPersistence: {
        load: async () => ({
          events: [{ type: 'request/context', data: { provider: 'example-provider', model: 'example-model' } }],
        }),
      },
      agents: { get: () => undefined, resume: resumeAgent },
    })

    await resumeInterrupted(ctx, ['proj/session-abc'])
    expect(resumeAgent).toHaveBeenCalledWith({
      resumeSessionId: 'session-abc',
      agentOptions: { provider: 'example-provider', model: 'example-model' },
    })
  })

  it('does not throw when the agent handle has no followup method', async () => {
    const persistence = {
      load: async () => ({
        events: [{ type: 'turn/end', data: { reason: { kind: 'interrupted' } } }],
        meta: { agentPreset: 'default' },
      }),
    }
    const ctx = makeCtx({
      sessionPersistence: persistence,
      sessions: { get: () => undefined, create: () => true },
      agents: { get: () => undefined, resume: async () => ({ agent: {} }) },
    })
    await expect(resumeInterrupted(ctx, ['proj/session-abc'])).resolves.toEqual([])
  })

  it('does not throw when agents.create rejects', async () => {
    const persistence = {
      load: async () => ({
        events: [{ type: 'turn/end', data: { reason: { kind: 'interrupted' } } }],
        meta: { agentPreset: 'default' },
      }),
    }
    const ctx = makeCtx({
      sessionPersistence: persistence,
      sessions: { get: () => undefined, create: () => true },
      agents: { get: () => undefined, resume: async () => { throw new Error('factory unavailable') } },
    })
    await expect(resumeInterrupted(ctx, ['proj/session-abc'])).resolves.toEqual([])
    expect(ctx._logs.some((l: string) => l.includes('warn:'))).toBe(true)
  })
})

describe('runAutoResume', () => {
  // All tests below pass config.autoResumeEnabled explicitly rather than
  // relying on ambient process.env.DSH_SUPERVISOR_AUTO_RESUME or files under
  // ~/.dsh — the Finding 3 config seam lets tests be deterministic regardless
  // of the machine they run on (see also the DSH_SUPERVISOR_AUTO_RESUME=0
  // ambient-decoupling tests further down).
  const enabledConfig = { autoResumeEnabled: true } as const

  it('does not throw when findInterrupted throws', async () => {
    const ctx = makeCtx()
    const boom = async () => { throw new Error('scan failed') }
    await expect(
      runAutoResume(ctx, { findInterrupted: boom as any, config: enabledConfig })
    ).resolves.toBeUndefined()
    expect(ctx._logs.some((l: string) => l.includes('warn:'))).toBe(true)
  })

  it('does not throw when resumeInterrupted throws', async () => {
    const ctx = makeCtx()
    const scan = async () => ({ scanned: 1, interrupted: ['proj/a-1'] })
    const boomResume = async () => { throw new Error('resume failed') }
    await expect(
      runAutoResume(ctx, { findInterrupted: scan as any, resumeInterrupted: boomResume as any, config: enabledConfig })
    ).resolves.toBeUndefined()
    expect(ctx._logs.some((l: string) => l.includes('warn:'))).toBe(true)
  })

  // A no-op stand-in for the dangling-open-turn scan — real machines have
  // real session data under ~/.dsh/sessions, so any test asserting exact
  // resumeInterrupted call contents must not fall through to the real scan.
  const noDangling = async () => ({ scanned: 0, interrupted: [] })

  it('calls resumeInterrupted with the scanned ids when interrupted sessions exist', async () => {
    const ctx = makeCtx()
    const scan = async () => ({ scanned: 2, interrupted: ['proj/a-1', 'proj/b-2'] })
    const resumeSpy = vi.fn(async () => {})
    await runAutoResume(ctx, { findInterrupted: scan as any, findDanglingOpenTurns: noDangling, resumeInterrupted: resumeSpy, config: enabledConfig })
    expect(resumeSpy).toHaveBeenCalledWith(ctx, ['proj/a-1', 'proj/b-2'], { config: enabledConfig })
  })

  it('skips resumeInterrupted entirely when nothing is interrupted', async () => {
    const ctx = makeCtx()
    const scan = async () => ({ scanned: 5, interrupted: [] })
    const resumeSpy = vi.fn(async () => {})
    await runAutoResume(ctx, { findInterrupted: scan as any, findDanglingOpenTurns: noDangling, resumeInterrupted: resumeSpy, config: enabledConfig })
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it('does not throw when opts is null (explicitly passed, not undefined)', async () => {
    const ctx = makeCtx()
    // Passing null instead of undefined to test that property access doesn't escape the try block
    await expect(
      runAutoResume(ctx, null as any)
    ).resolves.toBeUndefined()
    expect(ctx._logs.some((l: string) => l.includes('warn:'))).toBe(true)
  })

  it('skips scanning entirely (does not call findInterrupted) when config.autoResumeEnabled is false, even if env would otherwise enable it', async () => {
    const prevEnv = process.env.DSH_SUPERVISOR_AUTO_RESUME
    process.env.DSH_SUPERVISOR_AUTO_RESUME = '1' // ambient env says "enabled"
    try {
      const ctx = makeCtx()
      const findSpy = vi.fn(async () => ({ scanned: 3, interrupted: ['proj/a-1'] }))
      await runAutoResume(ctx, { findInterrupted: findSpy, config: { autoResumeEnabled: false } })
      expect(findSpy).not.toHaveBeenCalled()
      expect(ctx._logs.some((l: string) => l.includes('auto-resume disabled'))).toBe(true)
    } finally {
      if (prevEnv === undefined) delete process.env.DSH_SUPERVISOR_AUTO_RESUME
      else process.env.DSH_SUPERVISOR_AUTO_RESUME = prevEnv
    }
  })

  it('prefers config.autoResumeWithin over env DSH_SUPERVISOR_RESUME_WITHIN when both are set', async () => {
    const prevEnv = process.env.DSH_SUPERVISOR_RESUME_WITHIN
    process.env.DSH_SUPERVISOR_RESUME_WITHIN = '99'
    try {
      const ctx = makeCtx()
      let capturedWithinMs: number | undefined
      const findSpy = vi.fn(async (_home: any, opts: any) => {
        capturedWithinMs = opts?.withinMs
        return { scanned: 0, interrupted: [] }
      })
      await runAutoResume(ctx, { findInterrupted: findSpy, config: { autoResumeEnabled: true, autoResumeWithin: 7 } })
      expect(capturedWithinMs).toBe(7 * 60 * 1000)
    } finally {
      if (prevEnv === undefined) delete process.env.DSH_SUPERVISOR_RESUME_WITHIN
      else process.env.DSH_SUPERVISOR_RESUME_WITHIN = prevEnv
    }
  })

  it('merges findInterrupted and findDanglingOpenTurns results (deduped) before resuming', async () => {
    const ctx = makeCtx()
    const findInterruptedSpy = vi.fn(async () => ({ scanned: 5, interrupted: ['proj/a-1', 'proj/shared'] }))
    const findDanglingSpy = vi.fn(async () => ({ scanned: 5, interrupted: ['proj/shared', 'proj/b-2'] }))
    const resumeSpy = vi.fn(async () => {})
    await runAutoResume(ctx, {
      findInterrupted: findInterruptedSpy,
      findDanglingOpenTurns: findDanglingSpy,
      resumeInterrupted: resumeSpy,
      config: enabledConfig,
    })
    expect(findDanglingSpy).toHaveBeenCalledTimes(1)
    expect(resumeSpy).toHaveBeenCalledTimes(1)
    const resumedIds = resumeSpy.mock.calls[0][1] as string[]
    expect(resumedIds.sort()).toEqual(['proj/a-1', 'proj/b-2', 'proj/shared'])
  })

  it('does not throw when findDanglingOpenTurns throws — falls back to findInterrupted results alone', async () => {
    const ctx = makeCtx()
    const findInterruptedSpy = vi.fn(async () => ({ scanned: 1, interrupted: ['proj/a-1'] }))
    const findDanglingSpy = vi.fn(async () => { throw new Error('dangling scan failed') })
    const resumeSpy = vi.fn(async () => {})
    await expect(runAutoResume(ctx, {
      findInterrupted: findInterruptedSpy,
      findDanglingOpenTurns: findDanglingSpy,
      resumeInterrupted: resumeSpy,
      config: enabledConfig,
    })).resolves.toBeUndefined()
    expect(resumeSpy).toHaveBeenCalledWith(ctx, ['proj/a-1'], { config: enabledConfig })
    expect(ctx._logs.some((l: string) => l.includes('warn:'))).toBe(true)
  })
})

function makeCtxWithEffect(overrides: Record<string, any> = {}) {
  const logs: string[] = []
  const rpcHandlers: { channel: string; opts: any }[] = []
  return {
    logger: { info: (m: string) => logs.push(`info:${m}`), warn: (m: string) => logs.push(`warn:${m}`) },
    effect: (fn: any) => fn(),
    connection: {
      rpc: {
        handle: (channel: string, _handler: any, opts?: any) => {
          rpcHandlers.push({ channel, opts })
          return () => {}
        },
      },
    },
    sessions: { get: () => undefined },
    get: () => undefined,
    _logs: logs,
    _rpcHandlers: rpcHandlers,
    ...overrides,
  }
}

describe('apply', () => {
  it('waits for the agent registry before starting auto-resume', () => {
    expect(inject).toContain('agents')
  })

  it('declares skills in inject so the skills service exists when the provider registers', () => {
    expect(inject).toContain('skills')
  })

  it('declares tools in inject so ctx.tools resolves for the dsh_web_restart registration', () => {
    // Without 'tools' injected, ctx.tools is undefined and registerRestartTool's
    // ctx.tools.register throws inside the wrapped effect — the tool silently
    // never registers and agents cannot find it at runtime.
    expect(inject).toContain('tools')
  })

  it('registers dsh_web_restart through apply() wiring via ctx.tools', async () => {
    const registered: any[] = []
    const disposers: (() => void)[] = []
    // Cordis inject exposes the 'tools' service as the plugin ctx's `tools`
    // property — simulate that exactly (ctx.get('tools') is NOT the path used).
    const ctx = makeCtxWithEffect({
      effect: (fn: any) => { const d = fn(); disposers.push(d); return d },
      tools: { register: (def: any) => { registered.push(def); return () => {} } },
      get: () => undefined,
    })
    expect(() => apply(ctx)).not.toThrow()
    expect(registered.some(t => t.name === 'dsh_web_restart')).toBe(true)
    for (const d of disposers) { expect(() => d()).not.toThrow() }
  })

  it('registers a skills provider via ctx.get(skills) that lists the dsh-safe-restart candidate and unregisters on dispose', async () => {
    const unregisterSpy = vi.fn(() => {})
    const registerProviderSpy = vi.fn(() => unregisterSpy)
    const disposers: (() => void)[] = []
    const ctx = makeCtxWithEffect({
      effect: (fn: any) => { const d = fn(); disposers.push(d); return d },
      get: (key: string) => (key === 'skills' ? { registerProvider: registerProviderSpy } : undefined),
    })

    expect(() => apply(ctx)).not.toThrow()

    // registration went through the real apply() wiring, not a direct call
    expect(registerProviderSpy).toHaveBeenCalledTimes(1)
    const providerFactory = registerProviderSpy.mock.calls[0][0] as () => any
    const provider = providerFactory()
    const candidates = await provider.list({})
    expect(candidates.map((c: any) => c.name)).toEqual(['dsh-safe-restart'])
    expect(candidates[0].provider).toBe('maestro-supervisor')
    expect(candidates[0].resourceBase?.path).toMatch(/skills[\\/]dsh-safe-restart$/)

    // effect disposers clear the auto-resume timer/RPC and attempt skill deregistration without throwing
    expect(disposers.length).toBeGreaterThanOrEqual(2)
    expect(() => disposers.forEach((d) => d())).not.toThrow()
    expect(unregisterSpy).toHaveBeenCalledTimes(1)
  })

  it('registers the dsh_web_restart tool through apply() when ctx.tools.register is available', () => {
    const registered: any[] = []
    const ctx = makeCtxWithEffect({ tools: { register: (d: any) => { registered.push(d); return () => {} } } })
    expect(() => apply(ctx)).not.toThrow()
    expect(registered.some(t => t.name === 'dsh_web_restart')).toBe(true)
  })

  it('does not throw when ctx.tools is missing entirely (restart tool degrades to a logged skip)', () => {
    const ctx = makeCtxWithEffect() // no tools key
    expect(() => apply(ctx)).not.toThrow()
  })

  it('registers a tools/pre-execute self-kill guard via apply when ctx.on exists', () => {
    const onCalls: any[] = []
    const ctx = makeCtxWithEffect({ on: (ev: string, h: any) => { onCalls.push([ev, h]); return () => {} } })
    expect(() => apply(ctx)).not.toThrow()
    expect(onCalls.some(([ev]) => ev === 'tools/pre-execute')).toBe(true)
  })

  it('denies a bash self-kill through the pre-execute guard registered by apply', async () => {
    let handler: any
    const ctx = makeCtxWithEffect({ on: (ev: string, h: any) => { if (ev === 'tools/pre-execute') handler = h; return () => {} } })
    apply(ctx)
    expect(typeof handler).toBe('function')
    const res = await handler({ name: 'bash', args: { command: 'systemctl --user restart dsh-web' } }, async () => ({ kind: 'allow' }))
    expect(res).toMatchObject({ kind: 'deny' })
    expect(res.reason).toContain('dsh_web_restart')
    const benign = await handler({ name: 'bash', args: { command: 'ls -la' } }, async () => ({ kind: 'allow' }))
    expect(benign).toEqual({ kind: 'allow' })
  })

  it('does not throw when ctx.on is missing entirely', () => {
    const ctx = makeCtxWithEffect() // no on method
    expect(() => apply(ctx)).not.toThrow()
  })

  it('routes a loopback resume request to the in-process resume handler', async () => {
    const ctx = makeCtx()
    const resume = vi.fn(async () => ['proj/session-a'])
    const handler = createResumeRpcHandler(ctx, { resumeInterrupted: resume })

    await expect(handler('resume', { ids: ['proj/session-a'] }, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { resumed: ['proj/session-a'] } })
    // The handler forwards a deps object (empty here — no config/seams passed).
    expect(resume).toHaveBeenCalledWith(ctx, ['proj/session-a'], {})
  })

  it('registers each RPC handler exactly once on host-valid channel names', () => {
    const ctx = makeCtxWithEffect()
    apply(ctx)
    const channels = ctx._rpcHandlers.map((r: any) => r.channel)
    expect(channels).toEqual(expect.arrayContaining([
      '/dsh-maestro-supervisor-resume',
      '/dsh-maestro-supervisor-session-health',
    ]))
    // Every channel must satisfy the host channel contract (/^\/[A-Za-z0-9._~-]+$/ —
    // assertChannel rejects inner slashes, so the sibling dash convention applies).
    for (const ch of channels) expect(ch).toMatch(/^\/[A-Za-z0-9._~-]+$/)
    for (const r of ctx._rpcHandlers) expect(r.opts).toMatchObject({ authority: 'loopback' })
  })

  it('routes a loopback session-health request to runSessionHealthCheck with repair on', async () => {
    const ctx = makeCtx()
    const run = vi.fn(async () => ({ fixed: 1, quarantined: 0, remaining: 2 }))
    const handler = createSessionHealthRpcHandler(ctx, { run, config: { sessionLogRoot: '/sessions/root' } })

    await expect(handler('scan', {}, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { fixed: 1, quarantined: 0, remaining: 2 } })
    expect(run).toHaveBeenCalledWith('/sessions/root', { repair: true, quarantine: false })
  })

  it('prefers payload.root over config.sessionLogRoot for the session-health root', async () => {
    const ctx = makeCtx()
    const run = vi.fn(async () => ({ fixed: 0, quarantined: 0, remaining: 0 }))
    const handler = createSessionHealthRpcHandler(ctx, { run, config: { sessionLogRoot: '/cfg/root' } })

    await handler('scan', { root: '/payload/root' }, new AbortController().signal)
    expect(run).toHaveBeenCalledWith('/payload/root', { repair: true, quarantine: false })
  })

  it('reports a failed session-health scan as an error envelope instead of throwing', async () => {
    const ctx = makeCtx()
    const run = vi.fn(async () => { throw new Error('scan boom') })
    const handler = createSessionHealthRpcHandler(ctx, { run })

    await expect(handler('scan', {}, new AbortController().signal))
      .resolves.toEqual({ ok: false, error: { code: 'session-health-failed', message: 'scan boom' } })
  })

  it('registers the maestro_session_health host tool through apply() wiring', () => {
    const registered: any[] = []
    const ctx = makeCtxWithEffect({ tools: { register: (d: any) => { registered.push(d); return () => {} } } })
    apply(ctx)
    expect(registered.some(t => t.name === 'maestro_session_health')).toBe(true)
  })

  it('does not throw when ctx.connection.rpc.handle itself throws', () => {
    const ctx = makeCtxWithEffect({
      connection: { rpc: { handle: () => { throw new Error('bad channel') } } },
    })
    expect(() => apply(ctx)).not.toThrow()
  })

  it('does not throw when ctx.connection is missing entirely', () => {
    const ctx = makeCtxWithEffect({ connection: undefined })
    expect(() => apply(ctx)).not.toThrow()
  })

  it('returns a disposer from the effect that clears the timer and unregisters RPC without throwing', () => {
    const ctx = makeCtxWithEffect()
    let disposer: any
    ctx.effect = (fn: any) => { disposer = fn(); return disposer }
    apply(ctx)
    expect(typeof disposer).toBe('function')
    expect(() => disposer()).not.toThrow()
  })

  it('does not throw when ctx.effect itself throws', () => {
    const ctx = makeCtxWithEffect({
      effect: () => { throw new Error('effect boom') },
    })
    expect(() => apply(ctx)).not.toThrow()
  })

  it('does not throw when ctx.effect is missing entirely', () => {
    const ctx = makeCtxWithEffect({ effect: undefined })
    expect(() => apply(ctx)).not.toThrow()
  })

  it('does not throw when ctx.connection.rpc.handle throws AND the logger.warn used to report it also throws', () => {
    const ctx = makeCtxWithEffect({
      connection: { rpc: { handle: () => { throw new Error('bad channel') } } },
      logger: {
        info: () => {},
        warn: () => { throw new Error('logger boom') },
      },
    })
    expect(() => apply(ctx)).not.toThrow()
  })
})
