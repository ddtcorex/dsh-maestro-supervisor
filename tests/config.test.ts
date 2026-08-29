import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('supervisor config', () => {
  let tmpHome: string
  let origDshHome: string | undefined

  beforeEach(async () => {
    origDshHome = process.env.DSH_HOME
    tmpHome = await mkdtemp(join(tmpdir(), 'dsh-supervisor-config-'))
    process.env.DSH_HOME = tmpHome
    // reset config-lib cache
    const { resetForTests } = await import('@ddtcorex/dsh-maestro-config-lib')
    resetForTests()
  })

  afterEach(async () => {
    if (origDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = origDshHome
    const { resetForTests } = await import('@ddtcorex/dsh-maestro-config-lib')
    resetForTests()
    await rm(tmpHome, { recursive: true, force: true })
  })

  it('reads intervalMs from settings.json via readSupervisorConfig', async () => {
    const { readSupervisorConfig } = await import('../src/host/config.js')
    await mkdir(join(tmpHome, 'maestro'), { recursive: true })
    await writeFile(
      join(tmpHome, 'maestro', 'settings.json'),
      JSON.stringify({ version: 1, domains: { supervisor: { intervalMs: 5000 } } }),
    )
    // reset cache after writing file so load reads fresh
    const { resetForTests } = await import('@ddtcorex/dsh-maestro-config-lib')
    resetForTests()
    const cfg = await readSupervisorConfig()
    expect(cfg.intervalMs).toBe(5000)
  })

  it('returns empty object when no config present', async () => {
    const { readSupervisorConfig } = await import('../src/host/config.js')
    const cfg = await readSupervisorConfig()
    expect(cfg).toEqual({})
  })

  it('reads downThreshold from config', async () => {
    const { readSupervisorConfig } = await import('../src/host/config.js')
    await mkdir(join(tmpHome, 'maestro'), { recursive: true })
    await writeFile(
      join(tmpHome, 'maestro', 'settings.json'),
      JSON.stringify({ version: 1, domains: { supervisor: { downThreshold: 5 } } }),
    )
    const { resetForTests } = await import('@ddtcorex/dsh-maestro-config-lib')
    resetForTests()
    const cfg = await readSupervisorConfig()
    expect(cfg.downThreshold).toBe(5)
  })
})
