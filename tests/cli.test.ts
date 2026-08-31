import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rollbackLKG } from '../src/host/cli.js'

describe('cli', () => {
  it('shows help', () => {
    const out = execSync('node lib/bin.js --help', { encoding: 'utf-8' })
    expect(out).toContain('daemon')
    expect(out).toContain('status')
  })
  it('status runs without crash', () => {
    const out = execSync('node lib/bin.js status 2>&1 || true', { encoding: 'utf-8', timeout: 20000 })
    expect(out).toContain('up:')
  }, 20000)
})

describe('rollbackLKG', () => {
  it('restores non-session entries but never rolls sessions back (append-only truth)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rb-'))
    try {
      const lkg = join(root, 'lkg/2026-08-31T00-00-00-000Z')
      mkdirSync(join(lkg, 'profiles/web'), { recursive: true })
      writeFileSync(join(lkg, 'profiles/web/package.json'), JSON.stringify({ name: 'web-profile' }))
      mkdirSync(join(lkg, 'sessions/proj/s1'), { recursive: true })
      writeFileSync(join(lkg, 'sessions/proj/s1/session.jsonl'), '{"type":"session","id":"s1"}\n')
      writeFileSync(join(lkg, 'manifest.json'), '{}')
      const dest = join(root, 'dest')
      mkdirSync(dest, { recursive: true })

      const target = await rollbackLKG({ dshHome: dest, lkgRoot: join(root, 'lkg') })

      expect(target).toBe('2026-08-31T00-00-00-000Z')
      expect(existsSync(join(dest, 'profiles/web/package.json'))).toBe(true)
      expect(existsSync(join(dest, 'sessions/proj/s1/session.jsonl'))).toBe(false)
      expect(existsSync(join(dest, 'manifest.json'))).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('throws when there is no LKG to roll back to', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rb-missing-'))
    try {
      await expect(rollbackLKG({ dshHome: join(root, 'dest'), lkgRoot: join(root, 'lkg') })).rejects.toThrow(/no LKG to rollback/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})