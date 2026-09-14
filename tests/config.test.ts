import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `readSupervisorConfig()` reads the SHARED Maestro store
 * (`<dshHome>/dsh-maestro-config/settings.json`, owned by
 * `@ddtcorex/dsh-maestro-config-lib`). These tests used to seed
 * `<dshHome>/maestro/settings.json` — the path the retired 0.1.x store lib read
 * — so they passed while the package resolved a stale config-lib and the real
 * store was invisible (2026-09-14: same root cause as the empty Settings
 * panels; fixed by declaring `workspace:^0.2.0` and listing the sibling in the
 * workspace).
 */
describe('supervisor config', () => {
  let tmpHome: string
  let origDshHome: string | undefined

  const seedShared = async (supervisor: Record<string, unknown>) => {
    await mkdir(join(tmpHome, 'dsh-maestro-config'), { recursive: true })
    await writeFile(
      join(tmpHome, 'dsh-maestro-config', 'settings.json'),
      JSON.stringify({ version: 1, domains: { supervisor } }),
    )
  }
  const seedRetired = async (supervisor: Record<string, unknown>) => {
    await mkdir(join(tmpHome, 'maestro'), { recursive: true })
    await writeFile(join(tmpHome, 'maestro', 'settings.json'), JSON.stringify({ version: 1, domains: { supervisor } }))
  }
  const resetLibCache = async () => {
    const { resetForTests } = await import('@ddtcorex/dsh-maestro-config-lib')
    resetForTests()
  }

  beforeEach(async () => {
    origDshHome = process.env.DSH_HOME
    tmpHome = await mkdtemp(join(tmpdir(), 'dsh-supervisor-config-'))
    process.env.DSH_HOME = tmpHome
    await resetLibCache()
  })

  afterEach(async () => {
    if (origDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = origDshHome
    await resetLibCache()
    await rm(tmpHome, { recursive: true, force: true })
  })

  it('reads intervalMs from the shared store via readSupervisorConfig', async () => {
    const { readSupervisorConfig } = await import('../src/host/config.js')
    await seedShared({ intervalMs: 5000 })
    // reset cache after writing file so load reads fresh
    await resetLibCache()
    const cfg = await readSupervisorConfig()
    expect(cfg.intervalMs).toBe(5000)
  })

  it('returns empty object when no config present', async () => {
    const { readSupervisorConfig } = await import('../src/host/config.js')
    const cfg = await readSupervisorConfig()
    expect(cfg).toEqual({})
  })

  it('reads downThreshold from the shared store', async () => {
    const { readSupervisorConfig } = await import('../src/host/config.js')
    await seedShared({ downThreshold: 5 })
    await resetLibCache()
    const cfg = await readSupervisorConfig()
    expect(cfg.downThreshold).toBe(5)
  })

  it('reads bootGraceMs from the shared store', async () => {
    const { readSupervisorConfig } = await import('../src/host/config.js')
    await seedShared({ bootGraceMs: 300000 })
    await resetLibCache()
    const cfg = await readSupervisorConfig()
    expect(cfg.bootGraceMs).toBe(300000)
  })

  it('ignores the retired ~/.dsh/maestro/settings.json entirely', async () => {
    const { readSupervisorConfig } = await import('../src/host/config.js')
    await seedShared({ intervalMs: 1000 })
    await seedRetired({ intervalMs: 9999, downThreshold: 42 })
    await resetLibCache()
    const cfg = await readSupervisorConfig()
    expect(cfg.intervalMs).toBe(1000)
    expect(cfg.downThreshold).toBeUndefined()
  })
})
