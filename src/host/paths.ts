import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Resolve Maestro Harness root without hardcoding a machine-specific home path.
 * Priority: env > walk up from current file > cwd check > homedir fallback (last resort).
 */
export function resolveHarnessRoot(): string {
  if (process.env.MAESTRO_HARNESS_ROOT) return process.env.MAESTRO_HARNESS_ROOT

  // Walk up from this file's directory (works for both src and lib)
  try {
    // In ESM, __dirname is not available; use import.meta.url if possible, else process.cwd()
    // Fallback to file path heuristic: supervisor is at packages/dsh-maestro-supervisor/{src,lib}
    const candidates: string[] = []
    // Try to derive from current working file via stack-relative: use process.argv[1] or cwd
    // Most reliable: check common locations relative to this file
    // For compiled lib: lib/paths.js -> ../../.. = maestro-harness
    // For src: src/host/paths.ts -> ../../.. = maestro-harness
    const here = path.dirname(new URL(import.meta.url).pathname)
    candidates.push(path.resolve(here, '../../..')) // lib -> maestro-harness
    candidates.push(path.resolve(here, '../../../..')) // src/host -> maestro-harness
    candidates.push(path.resolve(here, '../../../../..'))
    candidates.push(process.cwd())

    for (const c of candidates) {
      try {
        if (fs.existsSync(path.join(c, 'deepseek-harness', 'package.json')) && fs.existsSync(path.join(c, 'packages', 'dsh-maestro-supervisor', 'package.json'))) {
          return c
        }
      } catch {}
    }
    // Fallback to first candidate that exists
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
  } catch {}

  // Last resort: cwd
  return process.cwd()
}

export function resolveDeepseekHarnessDir(): string {
  return path.join(resolveHarnessRoot(), 'deepseek-harness')
}
