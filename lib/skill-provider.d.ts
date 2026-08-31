import type { SkillCandidate, SkillDefinition, SkillLookupOptions } from '@deepseek-ai/dsh-skill';
export declare function makeSkillProvider(skillsDir: string): {
    name: string;
    list(_options: SkillLookupOptions): Promise<SkillCandidate[]>;
    get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined>;
};
