import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs'
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
  it('restores boot configuration but never the runtime data a legacy snapshot carries (D1)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rb-'))
    try {
      const lkg = join(root, 'lkg/2026-08-31T00-00-00-000Z')
      mkdirSync(join(lkg, 'profiles/web'), { recursive: true })
      writeFileSync(join(lkg, 'profiles/web/package.json'), JSON.stringify({ name: 'web-profile' }))
      mkdirSync(join(lkg, 'sessions/proj/s1'), { recursive: true })
      writeFileSync(join(lkg, 'sessions/proj/s1/session.jsonl'), '{"type":"session","id":"s1"}\n')
      mkdirSync(join(lkg, 'attachments/v1/objects'), { recursive: true })
      writeFileSync(join(lkg, 'attachments/v1/objects/f8'), 'blob')
      writeFileSync(join(lkg, 'dsh-web.log'), 'boot log')
      writeFileSync(join(lkg, 'manifest.json'), '{}')
      const dest = join(root, 'dest')
      mkdirSync(dest, { recursive: true })

      const result = await rollbackLKG({ dshHome: dest, lkgRoot: join(root, 'lkg') })

      expect(result.target).toBe('2026-08-31T00-00-00-000Z')
      expect(result.restored).toBeGreaterThan(0)
      expect(existsSync(join(dest, 'profiles/web/package.json'))).toBe(true)
      expect(existsSync(join(dest, 'sessions/proj/s1/session.jsonl'))).toBe(false)
      expect(existsSync(join(dest, 'attachments'))).toBe(false)
      expect(existsSync(join(dest, 'dsh-web.log'))).toBe(false)
      expect(existsSync(join(dest, 'manifest.json'))).toBe(false)
      // Skipped entries are reported with a reason, never silently dropped.
      expect(result.skipped.map(s => s.path)).toEqual(
        expect.arrayContaining(['sessions', 'attachments', 'dsh-web.log']),
      )
      for (const s of result.skipped) expect(s.reason.length).toBeGreaterThan(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('throws when there is no LKG to roll back to', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rb-missing-'))
    try {
      await expect(rollbackLKG({ dshHome: join(root, 'dest'), lkgRoot: join(root, 'lkg') })).rejects.toThrow(/no LKG to rollback/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  // D3 — a read-only destination must not be fatal. This is the incident's
  // exact shape: the LKG holds a file the live tree has as mode 0400, and
  // fs.cpSync opens the existing destination with O_WRONLY|O_TRUNC.
  it('overwrites a read-only (0400) destination instead of aborting the restore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rb-0400-'))
    try {
      const lkg = join(root, 'lkg/2026-08-31T00-00-00-000Z')
      mkdirSync(join(lkg, 'profiles/web'), { recursive: true })
      writeFileSync(join(lkg, 'profiles/web/settings.json'), '{"restored":true}')
      const dest = join(root, 'dest')
      mkdirSync(join(dest, 'profiles/web'), { recursive: true })
      const live = join(dest, 'profiles/web/settings.json')
      writeFileSync(live, '{"live":true}')
      chmodSync(live, 0o400)

      const result = await rollbackLKG({ dshHome: dest, lkgRoot: join(root, 'lkg') })

      expect(readFileSync(live, 'utf-8')).toBe('{"restored":true}')
      expect(result.skipped).toEqual([])
      expect(result.restored).toBeGreaterThan(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  // D2/D4 — a snapshot entry that cannot be restored is reported, and the
  // remaining entries are still restored. The rollback never throws here.
  it('collects an unrestorable entry instead of aborting the rest of the restore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rb-skip-'))
    try {
      const lkg = join(root, 'lkg/2026-08-31T00-00-00-000Z')
      mkdirSync(join(lkg, 'profiles/web'), { recursive: true })
      writeFileSync(join(lkg, 'profiles/web/package.json'), '{"name":"web"}')
      mkdirSync(join(lkg, 'maestro'), { recursive: true })
      writeFileSync(join(lkg, 'maestro/settings.json'), '{"ok":true}')
      const dest = join(root, 'dest')
      mkdirSync(dest, { recursive: true })
      // The live tree has a plain file where the snapshot has a directory.
      writeFileSync(join(dest, 'profiles'), 'not-a-directory')

      const result = await rollbackLKG({ dshHome: dest, lkgRoot: join(root, 'lkg') })

      expect(result.skipped.map(s => s.path)).toEqual(['profiles'])
      expect(result.skipped[0]!.reason.length).toBeGreaterThan(0)
      expect(readFileSync(join(dest, 'maestro/settings.json'), 'utf-8')).toBe('{"ok":true}')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})