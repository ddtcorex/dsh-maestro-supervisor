import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions } from '@deepseek-ai/dsh-skill'

const SKILL_NAME = 'dsh-safe-restart'

/** Minimal frontmatter reader for our own SKILL.md — enough to serve the provider contract. */
function parseFrontmatter(raw: string): { name: string; description: string; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) return { name: SKILL_NAME, description: '', body: raw }
  const fm = m[1].split('\n').reduce<Record<string, string>>((acc, line) => {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (kv) acc[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
    return acc
  }, {})
  return { name: fm.name || SKILL_NAME, description: fm.description || '', body: m[2] }
}

export function makeSkillProvider(skillsDir: string) {
  return {
    async list(_options: SkillLookupOptions): Promise<SkillCandidate[]> {
      const entry = join(skillsDir, SKILL_NAME)
      const st = await stat(entry).catch(() => null)
      if (!st?.isDirectory()) return []
      const skillFilePath = join(entry, 'SKILL.md')
      const fileSt = await stat(skillFilePath).catch(() => null)
      if (!fileSt?.isFile()) return []
      const raw = await readFile(skillFilePath, 'utf-8')
      const { name, description } = parseFrontmatter(raw)
      return [{
        name,
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'custom',
        provider: 'maestro-supervisor',
        rank: 360,
        locator: skillFilePath,
        path: skillFilePath,
        resourceBase: { kind: 'directory', path: entry },
        metadata: { name, description },
      }]
    },
    async get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
      try {
        const raw = await readFile(candidate.path as string, 'utf-8')
        const { name, description, body } = parseFrontmatter(raw)
        return {
          name, description,
          invocation: candidate.invocation,
          source: candidate.source,
          provider: candidate.provider,
          resourceBase: candidate.resourceBase,
          path: candidate.path,
          content: body,
          metadata: candidate.metadata,
        }
      } catch { return undefined }
    },
  }
}