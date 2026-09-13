/**
 * Agent-preset composition for resumed sessions.
 *
 * `agents.resume()` composes an agent's scoped world ONLY through
 * `ResumeAgentOptions.setup`; without it the agent is published joined to no
 * preset and its tool view collapses to the deployment-global layer (the
 * 2026-09-14 incident: a resumed session lost bash, read, write, subagent and
 * every other preset tool). These specs pin the two facts the supervisor needs
 * — which preset a session records, and whether a live agent is joined to one —
 * plus the repair path for an agent that already missed it.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  resolveSessionPresetId,
  makePresetSetup,
  composedPresetId,
  repairAgentPreset,
} from '../src/host/preset.js'

const ctxWith = (services: Record<string, any>) => ({
  get: (key: string) => services[key],
  ...services,
})

describe('resolveSessionPresetId', () => {
  it('prefers the attached session projection', async () => {
    const ctx = ctxWith({
      sessions: { get: () => ({ id: 's1' }) },
      sessionProjections: { stateOf: () => 'cordis' },
      sessionQuery: { observeSession: vi.fn() },
    })
    expect(await resolveSessionPresetId(ctx, 's1')).toBe('cordis')
    expect(ctx.sessionQuery.observeSession).not.toHaveBeenCalled()
  })

  it('falls back to the persisted header', async () => {
    const ctx = ctxWith({
      sessions: { get: () => undefined },
      sessionQuery: { observeSession: async () => ({ header: { agentPreset: 'cordis' } }) },
    })
    expect(await resolveSessionPresetId(ctx, 's1')).toBe('cordis')
  })

  it('returns undefined for a session that records no preset', async () => {
    const ctx = ctxWith({
      sessions: { get: () => undefined },
      sessionQuery: { observeSession: async () => ({ header: {} }) },
    })
    expect(await resolveSessionPresetId(ctx, 's1')).toBeUndefined()
  })

  it('never throws when the seams are missing', async () => {
    expect(await resolveSessionPresetId(ctxWith({}), 's1')).toBeUndefined()
  })
})

describe('makePresetSetup', () => {
  it('mounts the preset on the agent context', async () => {
    const mount = vi.fn(async () => ({}))
    const setup = makePresetSetup(ctxWith({ agentPresets: { mount } }), 'cordis')
    await setup({ scopeKey: 'agent-ctx' })
    expect(mount).toHaveBeenCalledWith({ scopeKey: 'agent-ctx' }, 'cordis')
  })

  it('is a no-op without the agentPresets service', async () => {
    const setup = makePresetSetup(ctxWith({}), 'cordis')
    await expect(setup({})).resolves.toBeUndefined()
  })
})

describe('composedPresetId', () => {
  it('reads the roster answer for the agent context', () => {
    const ctx = ctxWith({ agentPresets: { composedPreset: () => 'cordis' } })
    expect(composedPresetId(ctx, { ctx: {} })).toBe('cordis')
  })

  it('reports undefined when the agent joined no preset', () => {
    const ctx = ctxWith({ agentPresets: { composedPreset: () => undefined } })
    expect(composedPresetId(ctx, { ctx: {} })).toBeUndefined()
  })

  it('never throws when the roster is absent', () => {
    expect(composedPresetId(ctxWith({}), { ctx: {} })).toBeUndefined()
  })
})

describe('repairAgentPreset', () => {
  it('recomposes a preset-less live agent and reports the outcome', async () => {
    const recompose = vi.fn(async () => ({ id: 'cordis' }))
    let composed: string | undefined
    const ctx = ctxWith({
      agents: { get: () => ({ ctx: { c: 1 } }) },
      agentPresets: {
        composedPreset: () => composed,
        recompose: async (agentCtx: unknown, id: string) => { composed = id; return recompose(agentCtx, id) },
      },
      sessions: { get: () => undefined },
      sessionQuery: { observeSession: async () => ({ header: { agentPreset: 'cordis' } }) },
    })
    expect(await repairAgentPreset(ctx, 's1')).toMatchObject({
      repaired: true,
      presetId: 'cordis',
      reason: 'repaired',
      composedAfter: 'cordis',
    })
    expect(recompose).toHaveBeenCalledWith({ c: 1 }, 'cordis')
  })

  it('does not recompose an agent that is already joined', async () => {
    const recompose = vi.fn()
    const ctx = ctxWith({
      agents: { get: () => ({ ctx: {} }) },
      agentPresets: { composedPreset: () => 'cordis', recompose },
    })
    expect(await repairAgentPreset(ctx, 's1')).toMatchObject({ repaired: false, reason: 'already-composed' })
    expect(recompose).not.toHaveBeenCalled()
  })

  it('fails loudly when no preset is recorded', async () => {
    const ctx = ctxWith({
      agents: { get: () => ({ ctx: {} }) },
      agentPresets: { composedPreset: () => undefined },
      sessions: { get: () => undefined },
      sessionQuery: { observeSession: async () => ({ header: {} }) },
    })
    expect(await repairAgentPreset(ctx, 's1')).toMatchObject({ repaired: false, reason: 'no-preset-recorded' })
  })

  it('reports a missing live agent instead of throwing', async () => {
    const ctx = ctxWith({ agents: { get: () => undefined } })
    expect(await repairAgentPreset(ctx, 's1')).toMatchObject({ repaired: false, reason: 'no-live-agent' })
  })

  it('reports a failed recompose instead of throwing', async () => {
    const ctx = ctxWith({
      agents: { get: () => ({ ctx: {} }) },
      agentPresets: {
        composedPreset: () => undefined,
        recompose: async () => { throw new Error('unknown preset') },
      },
      sessions: { get: () => undefined },
      sessionQuery: { observeSession: async () => ({ header: { agentPreset: 'gone' } }) },
    })
    expect(await repairAgentPreset(ctx, 's1')).toMatchObject({ repaired: false, reason: 'recompose-failed' })
  })
})
