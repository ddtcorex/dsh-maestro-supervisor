/**
 * `maestro_resume_tool_health` declares its output for the harness tool-output
 * validator, whose schema subset is
 * `type/oneOf/properties/required/additionalProperties/items/enum/const` plus
 * annotations — a `type` array is rejected outright and `type` cannot sit next
 * to `oneOf`.
 *
 * A freshly booted host has not probed anything yet, so `lastResumeProbe` is
 * `null` there. Declaring it as a plain object made the harness reject the whole
 * call with `tool "maestro_resume_tool_health" returned invalid output:
 * "value.lastResumeProbe" must be an object` — on the exact host state an
 * operator inspects after a restart.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  makeResumeToolHealthToolDef,
  makeRepairPresetToolDef,
  recordResumeComposition,
  recordResumeProbe,
  resetResumeToolHealthState,
} from '../src/host/resume-tools.js'

/** Keywords the harness validator accepts, from its own subset check. */
const SUPPORTED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
])

function unsupportedSchemaUses(node: any, path = 'output'): string[] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [`${path} is not a schema object`]
  const problems: string[] = []
  for (const [key, value] of Object.entries(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) problems.push(`${path}.${key} is outside the validator subset`)
    if (key === 'type' && typeof value !== 'string') problems.push(`${path}.type must be a single type string`)
    if (key === 'oneOf' && Object.hasOwn(node, 'type')) problems.push(`${path} declares both type and oneOf`)
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [name, child] of Object.entries(node.properties)) problems.push(...unsupportedSchemaUses(child, `${path}.properties.${name}`))
  }
  if (node.items) problems.push(...unsupportedSchemaUses(node.items, `${path}.items`))
  if (Array.isArray(node.oneOf)) node.oneOf.forEach((child: any, i: number) => problems.push(...unsupportedSchemaUses(child, `${path}.oneOf[${i}]`)))
  return problems
}

describe('maestro_resume_tool_health output schema', () => {
  beforeEach(() => resetResumeToolHealthState())

  it('declares lastResumeProbe as nullable, matching a fresh host with no probe', async () => {
    const def = makeResumeToolHealthToolDef({})
    const probe = def.output.schema.properties.lastResumeProbe
    expect(probe.type).toBeUndefined()
    expect(probe.oneOf.map((branch: any) => branch.type)).toEqual(['object', 'null'])
    expect((await def.execute({}, {})).lastResumeProbe).toBeNull()
  })

  it('still reports a real probe through the object branch', async () => {
    recordResumeProbe({ missing: ['bash'], visible: 1, registry: 'reachable' })
    expect((await makeResumeToolHealthToolDef({}).execute({}, {})).lastResumeProbe).toEqual({ missing: ['bash'], visible: 1, registry: 'reachable' })
  })

  it('stays inside the harness validator subset', () => {
    const def = makeResumeToolHealthToolDef({})
    expect(unsupportedSchemaUses(def.output.schema)).toEqual([])
  })
})

describe('maestro_repair_session_preset tool', () => {
  beforeEach(() => resetResumeToolHealthState())

  const ctxWith = (services: Record<string, any>) => ({ get: (key: string) => services[key], ...services })

  it('re-links a preset-less live agent and reports the outcome', async () => {
    let composed: string | undefined
    const ctx = ctxWith({
      agents: { get: () => ({ ctx: { agentCtx: true } }) },
      agentPresets: {
        composedPreset: () => composed,
        recompose: async (_agentCtx: unknown, id: string) => { composed = id; return { id } },
      },
      sessionQuery: { observeSession: async () => ({ header: { agentPreset: 'cordis' } }) },
    })
    const def = makeRepairPresetToolDef(ctx)
    expect(def.name).toBe('maestro_repair_session_preset')
    expect(def.parameters.required).toEqual(['sessionId'])
    await expect(def.execute({ sessionId: 's1' }, {})).resolves.toMatchObject({
      ok: true,
      repaired: true,
      presetId: 'cordis',
      reason: 'repaired',
      composedAfter: 'cordis',
    })
  })

  it('is a no-op for an agent that is already joined to a preset', async () => {
    const recompose = vi.fn()
    const ctx = ctxWith({
      agents: { get: () => ({ ctx: {} }) },
      agentPresets: { composedPreset: () => 'cordis', recompose },
    })
    await expect(makeRepairPresetToolDef(ctx).execute({ sessionId: 's1' }, {})).resolves.toMatchObject({
      ok: true,
      repaired: false,
      reason: 'already-composed',
    })
    expect(recompose).not.toHaveBeenCalled()
  })

  it('reports a missing session instead of throwing', async () => {
    const ctx = ctxWith({ agents: { get: () => undefined } })
    await expect(makeRepairPresetToolDef(ctx).execute({ sessionId: 'gone' }, {})).resolves.toMatchObject({
      ok: true,
      repaired: false,
      reason: 'no-live-agent',
    })
  })

  it('rejects an empty session id without touching the runtime', async () => {
    const ctx = ctxWith({})
    await expect(makeRepairPresetToolDef(ctx).execute({}, {})).resolves.toMatchObject({ ok: false, repaired: false })
  })

  it('renders the health payload with registry and composition', async () => {
    recordResumeProbe({ missing: [], visible: 76, registry: 'unreachable' })
    recordResumeComposition({ sessionId: 's1', composed: null, repaired: false, reason: 'no-preset-recorded' })
    const def = makeResumeToolHealthToolDef(ctxWith({}))
    const rendered = def.output.render({}, await def.execute({}, {}))
    expect(rendered[0].text).toContain('registry=unreachable')
    expect(rendered[0].text).toContain('composed=none')
    expect(rendered[0].text).toContain('repaired=no')
  })
})
