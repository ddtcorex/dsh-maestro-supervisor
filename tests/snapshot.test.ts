import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { writeLKG, verifyLKG, rotateLKG, isLkgExcluded, LKG_EXCLUDED_ENTRIES } from '../src/host/snapshot.js'

describe('snapshot', () => {
  let tmp: string
  let dshHome: string
  let lkgRoot: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'))
    dshHome = path.join(tmp, 'fake-home')
    lkgRoot = path.join(tmp, '.supervisor/lkg')
    fs.mkdirSync(path.join(dshHome, 'maestro'), { recursive: true })
    fs.writeFileSync(path.join(dshHome, 'maestro/settings.json'), JSON.stringify({ foo: 'bar' }))
  })

  it('writes and verifies LKG', async () => {
    const { ts } = await writeLKG(dshHome, lkgRoot)
    expect(ts).toBeDefined()
    const ok = await verifyLKG(path.join(lkgRoot, ts))
    expect(ok).toBe(true)
  })

  it('detects tampered file', async () => {
    const { ts } = await writeLKG(dshHome, lkgRoot)
    const lkgPath = path.join(lkgRoot, ts)
    // tamper
    fs.writeFileSync(path.join(lkgPath, 'maestro/settings.json'), 'tampered')
    const ok = await verifyLKG(lkgPath)
    expect(ok).toBe(false)
  })

  it('rotates to keep 3', async () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(dshHome, `f${i}.txt`), 'x')
      await writeLKG(dshHome, lkgRoot)
      await new Promise(r => setTimeout(r, 5))
    }
    await rotateLKG(lkgRoot, 3)
    expect(fs.readdirSync(lkgRoot).length).toBe(3)
  })
})

// D1 — the LKG exists to recover a *boot*, so it holds boot configuration
// (profiles/ + the per-plugin config sidecars and settings documents) and never
// runtime data. Restoring a stale sessions/ over live sessions loses every turn
// recorded after the snapshot, attachments/ objects are 0400 (the mode that made
// cpSync abort with EACCES), and plugins-src/ is a re-fetchable ~400MB cache.
describe('isLkgExcluded', () => {
  it('excludes the runtime-data entries a boot does not need', () => {
    const excluded = [
      'sessions',
      'sessions/proj/s1/session.jsonl.zstd',
      './sessions',
      'attachments',
      'attachments/v1/objects/f8',
      'plugins-src',
      'plugins-src/node_modules/x/index.js',
      '.supervisor',
      '.supervisor/lkg/2026-01-01T00-00-00-000Z/manifest.json',
      'dsh-web.log',
      'profiles/web/npm-debug.log',
    ]
    for (const entry of excluded) expect(isLkgExcluded(entry), entry).toBe(true)
  })

  it('keeps the plugin tree and its configuration', () => {
    const kept = [
      'profiles',
      'profiles/web/package.json',
      'profiles/web/pnpm-lock.yaml',
      'profiles/web/node_modules/@ddtcorex/dsh-maestro-remote/lib/index.js',
      'profiles/web/cordis.patch.yml',
      'maestro',
      'maestro/settings.json',
      'dsh-maestro-remote',
      'dsh-maestro-remote/settings.json',
      'dsh-maestro-config/settings.json',
      'settings.yaml',
      'settings.yaml.bak-20260910',
      '.env',
      'machine-id',
      'AGENTS.md',
    ]
    for (const entry of kept) expect(isLkgExcluded(entry), entry).toBe(false)
  })

  it('publishes the exclusion list as data, not as a heuristic in the copy loop', () => {
    expect(LKG_EXCLUDED_ENTRIES).toContain('sessions')
    expect(LKG_EXCLUDED_ENTRIES).toContain('attachments')
    expect(LKG_EXCLUDED_ENTRIES).toContain('plugins-src')
    expect(LKG_EXCLUDED_ENTRIES).toContain('.supervisor')
  })
})

describe('writeLKG scope (D1)', () => {
  it('snapshots the plugin tree and its configuration but never the runtime data', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-scope-'))
    try {
      const home = path.join(root, 'home')
      const lkg = path.join(root, 'lkg')
      fs.mkdirSync(path.join(home, 'profiles/web'), { recursive: true })
      fs.writeFileSync(path.join(home, 'profiles/web/package.json'), JSON.stringify({ name: 'web-profile' }))
      fs.mkdirSync(path.join(home, 'maestro'), { recursive: true })
      fs.writeFileSync(path.join(home, 'maestro/settings.json'), JSON.stringify({ foo: 'bar' }))
      fs.mkdirSync(path.join(home, 'sessions/proj/s1'), { recursive: true })
      fs.writeFileSync(path.join(home, 'sessions/proj/s1/session.jsonl.zstd'), 'session-bytes')
      fs.mkdirSync(path.join(home, 'attachments/v1/objects'), { recursive: true })
      fs.writeFileSync(path.join(home, 'attachments/v1/objects/f8'), 'blob')
      fs.mkdirSync(path.join(home, 'plugins-src'), { recursive: true })
      fs.writeFileSync(path.join(home, 'plugins-src/cache.bin'), 'plugin-source-cache')
      fs.writeFileSync(path.join(home, 'dsh-web.log'), 'boot log')

      const result = await writeLKG(home, lkg)
      const snapshot = path.join(lkg, result.ts)

      expect(fs.existsSync(path.join(snapshot, 'profiles/web/package.json'))).toBe(true)
      expect(fs.existsSync(path.join(snapshot, 'maestro/settings.json'))).toBe(true)
      expect(fs.existsSync(path.join(snapshot, 'sessions'))).toBe(false)
      expect(fs.existsSync(path.join(snapshot, 'attachments'))).toBe(false)
      expect(fs.existsSync(path.join(snapshot, 'plugins-src'))).toBe(false)
      expect(fs.existsSync(path.join(snapshot, 'dsh-web.log'))).toBe(false)
      expect(result.files).toBeGreaterThan(0)
      expect(result.skipped).toEqual([])
      // The snapshot must still be verifiable: the exclusion is scope, not loss.
      expect(await verifyLKG(snapshot)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
