import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeLKG } from '../src/host/snapshot.ts'
import { rollbackLKG } from '../src/host/cli.ts'
import { Supervisor } from '../src/host/supervisor.ts'

/**
 * Deliberate rollback rehearsal. The unit suites prove `writeLKG`/`rollbackLKG`
 * in isolation and the tick's branches with stubs; neither proves the two halves
 * work together — which is exactly what the 2026-09-13 incident exposed (a
 * rollback that aborted with EACCES on a read-only object and never restored
 * anything). This wires the REAL snapshot + restore into a real Supervisor tick
 * against an isolated home, and asserts the boot config comes back.
 */
let base: string
let home: string
let lkgRoot: string

const BOOT_CONFIG = 'theme: dark\n'
const PKG = JSON.stringify({ name: 'web', dsh: { profile: { bundles: [] } }, dependencies: {} }, null, 2)

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rollback-rehearsal-'))
  home = join(base, 'home')
  lkgRoot = join(base, 'lkg')
  await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  await writeFile(join(home, 'profiles', 'web', 'package.json'), PKG)
  await writeFile(join(home, 'settings.yaml'), BOOT_CONFIG)
  // The class that used to abort a restore: a read-only file in the tree.
  await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'rows: []\n', { mode: 0o400 })
  // Runtime data that must never enter the snapshot (nor be restored over).
  await mkdir(join(home, 'sessions', 'proj'), { recursive: true })
  await writeFile(join(home, 'sessions', 'proj', 'live.jsonl'), 'live\n')
  await mkdir(join(home, 'attachments', 'v1'), { recursive: true })
  await writeFile(join(home, 'attachments', 'v1', 'blob'), 'blob\n', { mode: 0o400 })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('rollback rehearsal on an isolated home', () => {
  it('snapshots, restores the boot config byte-identically, and leaves runtime data alone', async () => {
    const snap = await writeLKG(home, lkgRoot)
    expect(snap.files).toBeGreaterThan(0)

    // Corrupt the config a boot needs, and keep writing to the live session.
    await writeFile(join(home, 'settings.yaml'), 'broken: true\n')
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{ not json')
    await writeFile(join(home, 'sessions', 'proj', 'live.jsonl'), 'live\nmore\n')

    const res = await rollbackLKG({ dshHome: home, lkgRoot })

    expect(res.restored).toBeGreaterThan(0)
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toBe(BOOT_CONFIG)
    expect(await readFile(join(home, 'profiles', 'web', 'package.json'), 'utf8')).toBe(PKG)
    // Excluded from the snapshot, so the live content survives the rollback.
    expect(await readFile(join(home, 'sessions', 'proj', 'live.jsonl'), 'utf8')).toBe('live\nmore\n')
    expect(res.skipped.every((s) => typeof s.reason === 'string' && s.reason.length > 0)).toBe(true)
  })

  it('drives a real tick to a real rollback when the boot config is broken', async () => {
    await writeLKG(home, lkgRoot)
    await writeFile(join(home, 'settings.yaml'), 'broken: true\n')

    const restartWeb = vi.fn(async () => {})
    const writeReport = vi.fn(async () => '/tmp/report.md')
    const supervisor = new Supervisor({
      pollHealth: async () => ({ up: false, error: 'plugin tree failed to load' }),
      writeLKG: async () => ({ ts: '', files: 0, skipped: [] }),
      writeFailed: async () => ({ ts: '', files: 0, skipped: [] }),
      writeReport,
      rollback: async () => rollbackLKG({ dshHome: home, lkgRoot }),
      notify: vi.fn(async () => {}),
      restartWeb,
      downThreshold: 1,
      intervalMs: 1,
      checkPlannedRestart: () => false,
      isPlannedRestartActive: () => false,
      getTime: () => 1_000_000,
    } as never)

    await supervisor.tick()

    expect(writeReport).toHaveBeenCalled()
    expect(restartWeb).toHaveBeenCalledTimes(1)
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toBe(BOOT_CONFIG)
  })
})
