import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
const SKILL_NAME = 'dsh-safe-restart';
/** Minimal frontmatter reader for our own SKILL.md — enough to serve the provider contract. */
function parseFrontmatter(raw) {
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m)
        return { name: SKILL_NAME, description: '', body: raw };
    const fm = m[1].split('\n').reduce((acc, line) => {
        const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (kv)
            acc[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
        return acc;
    }, {});
    return { name: fm.name || SKILL_NAME, description: fm.description || '', body: m[2] };
}
export function makeSkillProvider(skillsDir) {
    return {
        // The dsh-skill service attributes candidates through the provider
        // object's own `name` (maestro-skills returns `{ name, list, get }`); a
        // missing name surfaces at runtime as `skill provider "undefined" returned
        // skill ... for provider "maestro-supervisor"` and fails every turn.
        name: 'maestro-supervisor',
        async list(_options) {
            const entry = join(skillsDir, SKILL_NAME);
            const st = await stat(entry).catch(() => null);
            if (!st?.isDirectory())
                return [];
            const skillFilePath = join(entry, 'SKILL.md');
            const fileSt = await stat(skillFilePath).catch(() => null);
            if (!fileSt?.isFile())
                return [];
            const raw = await readFile(skillFilePath, 'utf-8').catch(() => null);
            if (raw === null)
                return [];
            const { name, description } = parseFrontmatter(raw);
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
                }];
        },
        async get(candidate, _options) {
            try {
                const raw = await readFile(candidate.path, 'utf-8');
                const { name, description, body } = parseFrontmatter(raw);
                return {
                    name, description,
                    invocation: candidate.invocation,
                    source: candidate.source,
                    provider: candidate.provider,
                    resourceBase: candidate.resourceBase,
                    path: candidate.path,
                    content: body,
                    metadata: candidate.metadata,
                };
            }
            catch {
                return undefined;
            }
        },
    };
}
