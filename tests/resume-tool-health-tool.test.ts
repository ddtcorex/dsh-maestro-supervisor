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
import { describe, it, expect, beforeEach } from 'vitest'
import { makeResumeToolHealthToolDef, recordResumeProbe, resetResumeToolHealthState } from '../src/host/resume-tools.js'

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
