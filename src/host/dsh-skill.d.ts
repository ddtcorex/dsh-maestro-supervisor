/**
 * Ambient types for the DSH skills contract.
 *
 * `@deepseek-ai/dsh-skill` ships inside the deepseek-harness host and is not a
 * real node module resolvable from this package (same constraint maestro-skills
 * solves with `src/dsh-types.d.ts`). Only `import type` references are used, so
 * the declaration is erased at emit time; it exists purely to satisfy tsc.
 */
declare module '@deepseek-ai/dsh-skill' {
  export interface SkillCandidate {
    name: string
    description: string
    invocation: { modelInvocable: boolean; userInvocable: boolean }
    source: string
    provider: string
    rank: number
    locator: unknown
    path?: string
    resourceBase?: { kind: 'directory'; path: string }
    metadata?: Record<string, unknown>
  }

  export interface SkillDefinition {
    name: string
    description: string
    invocation: { modelInvocable: boolean; userInvocable: boolean }
    source: string
    provider: string
    resourceBase?: { kind: 'directory'; path: string }
    path?: string
    content: string
    metadata?: Record<string, unknown>
  }

  export interface SkillLookupOptions {
    cwd?: string
    signal?: AbortSignal
  }

  export interface SkillProviderControl {
    signal: AbortSignal
    invalidate: () => void
  }
}
