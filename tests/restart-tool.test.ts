import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerRestartTool, isPluginTreeChanged } from '../src/host/restart-tool.js'

// Point os.homedir() at a per-file temp home: tool registration, dry-boot
// gating (isPluginTreeChanged's default LKG dir) and the intent sidecar never
// touch the real ~/.dsh — a live supervisor daemon there would act on a real
// restart-request marker and restart the running dsh web.
let fakeHome = ''
beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dsh-tool-home-'))
})
afterAll(() => {
  if (fakeHome) {
    try { rmSync(fakeHome, { recursive: true, force: true }) } catch {}
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => fakeHome,
  }
})

describe('registerRestartTool', () => {
  it('registers the tool and hands off via restart-request marker (never restarts itself)', async () => {
    const registered: any[] = []
    const ctx: any = {
      tools: { register: (def: any) => { registered.push(def); return () => {} } },
      logger: { info: () => {}, warn: () => {} },
      get: () => undefined,
    }
    const deps = {
      sessionIdOf: () => 'proj/abc',
      dryBoot: async () => ({ ok: true, detail: '200' }),
      writeRestartRequest: vi.fn(),
    }
    const dispose = registerRestartTool(ctx, deps as any)
    const tool = registered.find(t => t.name === 'dsh_web_restart')
    expect(tool).toBeDefined()
    const result = await tool.execute({ reason: 'plugin fixed' }, {})
    expect(result.ok).toBe(true)
    expect(deps.writeRestartRequest).toHaveBeenCalledWith(
      { callerSessionId: 'proj/abc', reason: 'plugin fixed' }, expect.any(Number))
    expect(result.detail).toMatch(/scheduled/)
    dispose()
  })

  it('refuses when the dry-boot gate fails (bad plugin change)', async () => {
    const tool: any[] = []
    const ctx: any = {
      tools: { register: (d: any) => { tool.push(d); return () => {} } },
      logger: { info: () => {}, warn: () => {} },
      get: () => undefined,
    }
    const deps = {
      sessionIdOf: () => 'proj/abc',
      dryBoot: async () => ({ ok: false, detail: 'ERR_MODULE_NOT_FOUND' }),
      writeRestartRequest: vi.fn(),
    }
    registerRestartTool(ctx, deps as any)
    const t = tool.find(x => x.name === 'dsh_web_restart')
    const result = await t.execute({}, {})
    expect(result.ok).toBe(false)
    expect(deps.writeRestartRequest).not.toHaveBeenCalled()
  })

  it('schedules without a dry-boot when pluginChanged is explicitly false', async () => {
    const registered: any[] = []
    const ctx: any = {
      tools: { register: (def: any) => { registered.push(def); return () => {} } },
      logger: { info: () => {}, warn: () => {} },
      get: () => undefined,
    }
    const dryBoot = vi.fn(async () => ({ ok: false, detail: 'should not run' }))
    const deps = { sessionIdOf: () => 'proj/abc', dryBoot, writeRestartRequest: vi.fn() }
    registerRestartTool(ctx, deps as any)
    const t = registered.find(x => x.name === 'dsh_web_restart')
    const result = await t.execute({ pluginChanged: false }, {})
    expect(result.ok).toBe(true)
    expect(dryBoot).not.toHaveBeenCalled()
  })
})

describe('isPluginTreeChanged', () => {
  it('assumes changed when no LKG baseline exists', () => {
    expect(isPluginTreeChanged(fakeHome, join(fakeHome, 'lkg-missing'))).toBe(true)
  })

  it('detects a live profile package.json different from the latest LKG', () => {
    const lkgWeb = join(fakeHome, '.dsh/.supervisor/lkg/2026-01-01T00-00-00-000Z/profiles/web')
    mkdirSync(lkgWeb, { recursive: true })
    writeFileSync(join(lkgWeb, 'package.json'), JSON.stringify({ version: '1' }))
    const liveWeb = join(fakeHome, '.dsh/profiles/web')
    mkdirSync(liveWeb, { recursive: true })
    writeFileSync(join(liveWeb, 'package.json'), JSON.stringify({ version: '2' }))
    expect(isPluginTreeChanged(fakeHome)).toBe(true)
    writeFileSync(join(liveWeb, 'package.json'), JSON.stringify({ version: '1' }))
    expect(isPluginTreeChanged(fakeHome)).toBe(false)
  })
})