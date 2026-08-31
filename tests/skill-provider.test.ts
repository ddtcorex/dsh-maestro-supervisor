import { describe, it, expect } from 'vitest'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeSkillProvider } from '../src/host/skill-provider.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const skillsDir = resolve(__dirname, '../skills')

describe('dsh-safe-restart skill provider', () => {
  it('lists exactly the dsh-safe-restart skill from the package skills dir', async () => {
    const as = (await makeSkillProvider(skillsDir).list({} as any)) as Array<{ name: string; path: string }>
    expect(as.map(s => s.name)).toEqual(['dsh-safe-restart'])
    expect(as[0].path).toBe(join(skillsDir, 'dsh-safe-restart', 'SKILL.md'))
  })

  it('resolves the skill body with its scripts resource base', async () => {
    const provider = makeSkillProvider(skillsDir)
    const [cand] = await provider.list({} as any)
    const skill = await provider.get(cand, {} as any)
    expect(skill?.content).toContain('## Purpose')
    expect(skill?.resourceBase).toEqual({ kind: 'directory', path: join(skillsDir, 'dsh-safe-restart') })
  })
})