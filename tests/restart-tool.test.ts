import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { registerRestartTool, isPluginTreeChanged, dryBootVerify, copyProfileForDryBoot } from '../src/host/restart-tool.js'

// Point os.homedir() at a per-file temp home: tool registration, dry-boot
// gating (isPluginTreeChanged's default LKG dir) and the intent sidecar never
// touch the real ~/.dsh — a live supervisor daemon there would act on a real
// restart-request marker and restart the running dsh web.
let fakeHome = ''
beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dsh-tool-home-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
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

// dryBootVerify must be unit-tested with a mocked spawn (never a real node
// boot). The fake child keeps `exitCode` null while the fetch stub serves 200.
const { spawnMock, childKillMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  childKillMock: vi.fn(),
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: spawnMock,
  }
})

function fakeChild(exitCode: number | null) {
  return {
    exitCode,
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    kill: childKillMock,
  } as any
}

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
      expect.objectContaining({ callerSessionId: 'proj/abc', reason: 'plugin fixed' }), expect.any(Number))
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

  it('refuses to schedule when the calling session cannot be identified', async () => {
    const registered: any[] = []
    const ctx: any = {
      tools: { register: (def: any) => { registered.push(def); return () => {} } },
      logger: { info: () => {}, warn: () => {} },
      get: () => undefined,
    }
    const deps = {
      dryBoot: async () => ({ ok: true, detail: '200' }),
      writeRestartRequest: vi.fn(),
    } // no sessionIdOf and no agent on the exec → truly caller-less
    registerRestartTool(ctx, deps as any)
    const t = registered.find(x => x.name === 'dsh_web_restart')
    const result = await t.execute({ pluginChanged: false }, { name: 'bash', arguments: {} })
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/cannot identify the calling session/)
    expect(deps.writeRestartRequest).not.toHaveBeenCalled()
  })

  it('identifies the calling session from the ToolRunContext agent.id without sessionIdOf', async () => {
    const registered: any[] = []
    const ctx: any = {
      tools: { register: (def: any) => { registered.push(def); return () => {} } },
      logger: { info: () => {}, warn: () => {} },
      get: () => undefined,
    }
    const deps = {
      dryBoot: async () => ({ ok: true, detail: '200' }),
      writeRestartRequest: vi.fn(),
    } // no injected sessionIdOf — the real dsh-tools dispatch shape carries the id on exec.agent
    registerRestartTool(ctx, deps as any)
    const t = registered.find(x => x.name === 'dsh_web_restart')
    // Realistic ToolRunContext: { callId, rootCallId, name, arguments, agent: Agent, ... }
    const exec = { name: 'bash', arguments: {}, agent: { id: 'proj/s-1' } }
    const result = await t.execute({ pluginChanged: false, reason: 'plugin v2' }, exec)
    expect(result.ok).toBe(true)
    expect(deps.writeRestartRequest).toHaveBeenCalledWith(
      expect.objectContaining({ callerSessionId: 'proj/s-1', reason: 'plugin v2' }), expect.any(Number))
    expect(result.detail).toMatch(/caller proj\/s-1/)
  })

  it('falls back to the agent session id when agent.id is absent', async () => {
    const registered: any[] = []
    const ctx: any = {
      tools: { register: (def: any) => { registered.push(def); return () => {} } },
      logger: { info: () => {}, warn: () => {} },
      get: () => undefined,
    }
    const deps = { dryBoot: async () => ({ ok: true, detail: '200' }), writeRestartRequest: vi.fn() }
    registerRestartTool(ctx, deps as any)
    const t = registered.find(x => x.name === 'dsh_web_restart')
    const exec = { name: 'bash', arguments: {}, agent: { session: { id: 'proj/s-9' } } }
    const result = await t.execute({ pluginChanged: false }, exec)
    expect(result.ok).toBe(true)
    expect(deps.writeRestartRequest).toHaveBeenCalledWith(
      expect.objectContaining({ callerSessionId: 'proj/s-9' }), expect.any(Number))
  })

  it('writes the intent sidecar with a flattened filename for slash-namespaced ids', async () => {
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
    registerRestartTool(ctx, deps as any)
    const t = registered.find(x => x.name === 'dsh_web_restart')
    const result = await t.execute({ reason: 'plugin fixed' }, {})
    expect(result.ok).toBe(true)
    // 'proj/abc' must flatten to a single file — never a nested intents/proj/ dir.
    const sidecar = join(fakeHome, '.dsh/.supervisor/intents/proj_abc.json')
    expect(existsSync(sidecar)).toBe(true)
    const j = JSON.parse(readFileSync(sidecar, 'utf8'))
    expect(j.sessionId).toBe('proj/abc')
    expect(j.reason).toBe('plugin fixed')
  })
})

describe('dryBootVerify', () => {
  it('kills the spawned child on every exit path (success and failure)', async () => {
    mkdirSync(join(fakeHome, '.dsh/profiles/web'), { recursive: true })
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 }) as any))

    // Success: the child keeps running after serving 200 — the finally must
    // SIGKILL it, otherwise a dsh web orphan survives on the ephemeral port
    // whose temp DSH_HOME is deleted underneath it.
    childKillMock.mockClear()
    spawnMock.mockReturnValue(fakeChild(null))
    const okRes = await dryBootVerify(fakeHome, { timeoutMs: 10_000 })
    expect(okRes.ok).toBe(true)
    expect(childKillMock).toHaveBeenCalledWith('SIGKILL')

    // Failure: the child exits nonzero before serving — killed and reported.
    childKillMock.mockClear()
    spawnMock.mockReturnValue(fakeChild(7))
    const failRes = await dryBootVerify(fakeHome, { timeoutMs: 10_000 })
    expect(failRes.ok).toBe(false)
    expect(failRes.detail).toMatch(/exit 7/)
    expect(childKillMock).toHaveBeenCalledWith('SIGKILL')
  })
})

describe('dsh_web_dryboot', () => {
  it('runs the dry-boot gate and returns its result without scheduling', async () => {
    const registered: any[] = []
    const ctx: any = {
      tools: { register: (d: any) => { registered.push(d); return () => {} } },
      logger: { info: () => {}, warn: () => {} },
      get: () => undefined,
    }
    const dryBoot = vi.fn(async () => ({ ok: true, detail: 'dry-boot ok' }))
    const writeRestartRequest = vi.fn()
    registerRestartTool(ctx, { dryBoot, writeRestartRequest, harnessRoot: '/repo' } as any)
    const t = registered.find(x => x.name === 'dsh_web_dryboot')
    expect(t).toBeDefined()
    const result = await t.execute({ timeoutMs: 5000 }, {})
    expect(dryBoot).toHaveBeenCalledWith('/repo', { timeoutMs: 5000 })
    expect(result).toEqual({ ok: true, detail: 'dry-boot ok' })
    expect(writeRestartRequest).not.toHaveBeenCalled()
  })
})

describe('dsh_web_gc', () => {
  const ORPHAN = { pid: 101, cmd: 'node --import tsx/esm apps/cli/src/bin.ts web --port 9417', env: 'DSH_HOME=/tmp/dsh-dryboot-x\0PATH=/usr/bin' }
  function makeCtx(registered: any[]) {
    return {
      tools: { register: (d: any) => { registered.push(d); return () => {} } },
      logger: { info: () => {}, warn: () => {} },
      get: () => undefined,
    } as any
  }
  it('previews without killing when confirm is not true', async () => {
    const registered: any[] = []
    const killPid = vi.fn()
    registerRestartTool(makeCtx(registered), {
      gcReaders: {
        readProc: () => [ORPHAN],
        ssPortsOf: () => [9417],
        selfPid: 1,
      },
      killPid,
    } as any)
    const t = registered.find(x => x.name === 'dsh_web_gc')
    expect(t).toBeDefined()
    const result = await t.execute({}, {})
    expect(result).toEqual({ killed: [], candidates: [{ pid: 101, port: 9417, dshHome: '/tmp/dsh-dryboot-x' }] })
    expect(killPid).not.toHaveBeenCalled()
  })
  it('kills and verifies absence with confirm:true', async () => {
    const registered: any[] = []
    let alive = true
    const killPid = vi.fn(() => { alive = false })
    registerRestartTool(makeCtx(registered), {
      gcReaders: {
        readProc: () => (alive ? [ORPHAN] : []),
        ssPortsOf: () => (alive ? [9417] : []),
        selfPid: 1,
      },
      killPid,
    } as any)
    const t = registered.find(x => x.name === 'dsh_web_gc')
    const result = await t.execute({ confirm: true }, {})
    expect(killPid).toHaveBeenCalledWith(101, 'SIGKILL')
    expect(result).toEqual({ killed: [101], candidates: [] })
  })
  it('never returns the host itself, live-port holders, or real-home processes', async () => {
    const registered: any[] = []
    const killPid = vi.fn()
    registerRestartTool(makeCtx(registered), {
      gcReaders: {
        readProc: () => [
          { pid: 1, cmd: 'node apps/cli/src/bin.ts web', env: 'DSH_HOME=/home/u/.dsh' },
          { pid: 102, cmd: 'node --import tsx/esm apps/cli/src/bin.ts web', env: 'DSH_HOME=/tmp/dsh-dryboot-y' },
          { pid: 103, cmd: 'node --import tsx/esm apps/cli/src/bin.ts web', env: 'DSH_HOME=/home/u/.dsh' },
        ],
        ssPortsOf: (pid: number) => (pid === 102 ? [3080] : pid === 103 ? [9418] : [3082]),
        selfPid: 1,
      },
      killPid,
    } as any)
    const t = registered.find(x => x.name === 'dsh_web_gc')
    const result = await t.execute({ confirm: true }, {})
    expect(result).toEqual({ killed: [], candidates: [] })
    expect(killPid).not.toHaveBeenCalled()
  })
})

describe('dsh_web_restart evidence', () => {
  it('returns oldPid + intentPath and carries oldPid in the marker', async () => {
    const registered: any[] = []
    const ctx: any = {
      tools: { register: (d: any) => { registered.push(d); return () => {} } },
      logger: { info: () => {}, warn: () => {} },
      get: () => undefined,
    }
    const writeRestartRequest = vi.fn()
    const deps = { sessionIdOf: () => 'proj/abc', writeRestartRequest }
    registerRestartTool(ctx, deps as any)
    const t = registered.find(x => x.name === 'dsh_web_restart')
    const result = await t.execute({ reason: 'x' }, {})
    expect(result.oldPid).toBe(process.pid)
    expect(result.intentPath).toContain('intents')
    expect(writeRestartRequest).toHaveBeenCalledWith(
      expect.objectContaining({ oldPid: process.pid }), expect.any(Number))
  })
})

describe('dryBootFailureDetail', () => {
  it('names the colliding port for an EADDRINUSE on the webhook port :3000', async () => {
    const { dryBootFailureDetail } = await import('../src/host/restart-tool.js')
    const tail = [
      'node:internal/modules/esm/loader',
      'Error: listen EADDRINUSE: address already in use :::3000',
      '    at Server.setupListenHandle [as _listen] (node:net:...:1)',
    ].join('\n')
    const detail = dryBootFailureDetail(tail, 1)
    expect(detail).toMatch(/EADDRINUSE/)
    expect(detail).toContain('port 3000')
    expect(detail).toMatch(/already in use/)
  })

  it('names the colliding port for an EADDRINUSE in the ephemeral 9000-9999 range', async () => {
    const { dryBootFailureDetail } = await import('../src/host/restart-tool.js')
    const detail = dryBootFailureDetail('Error: listen EADDRINUSE: address already in use :::9417', 1)
    expect(detail).toMatch(/EADDRINUSE/)
    expect(detail).toContain('port 9417')
  })

  it('keeps the load-error classifier for plugin-tree boot failures', async () => {
    const { dryBootFailureDetail } = await import('../src/host/restart-tool.js')
    const detail = dryBootFailureDetail(
      "node:internal/errors:... ERR_MODULE_NOT_FOUND: Cannot find package 'x/plugin'", 7)
    expect(detail).toMatch(/ERR_MODULE_NOT_FOUND/)
  })

  it('falls back to the generic exit detail when nothing is classified', async () => {
    const { dryBootFailureDetail } = await import('../src/host/restart-tool.js')
    expect(dryBootFailureDetail('some other log line', 3)).toBe('dry-boot failed (exit 3)')
  })
})

describe('copyProfileForDryBoot', () => {
  it('rewrites a relative link: symlink that dangles in the copy to its absolute live target', () => {
    const src = mkdtempSync(join(tmpdir(), 'dryboot-src-'))
    const dest = join(tmpdir(), `dryboot-dest-${Date.now()}`)
    try {
      // A link: install: node_modules/@scope/pkg -> ../../shared/pkg,
      // valid in the live tree, dangling under any naive recursive copy.
      const targetDir = join(src, 'shared/pkg')
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(join(targetDir, 'package.json'), JSON.stringify({ name: 'pkg' }))
      const linkDir = join(src, 'node_modules/@scope')
      mkdirSync(linkDir, { recursive: true })
      symlinkSync('../../shared/pkg', join(linkDir, 'pkg'))

      copyProfileForDryBoot(src, dest)

      const copiedLink = join(dest, 'node_modules/@scope/pkg')
      const rewritten = readlinkSync(copiedLink)
      expect(existsSync(rewritten)).toBe(true)
      expect(JSON.parse(readFileSync(join(rewritten, 'package.json'), 'utf8')).name).toBe('pkg')
    } finally {
      rmSync(src, { recursive: true, force: true })
      rmSync(dest, { recursive: true, force: true })
    }
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

  it('detects a rebuilt plugin lib file newer than the LKG snapshot baseline (injected stat reader)', () => {
    const lkgSnap = join(fakeHome, '.dsh/.supervisor/lkg/2026-01-01T00-00-00-000Z')
    const lkgWeb = join(lkgSnap, 'profiles/web')
    mkdirSync(lkgWeb, { recursive: true })
    writeFileSync(join(lkgWeb, 'package.json'), JSON.stringify({ version: '1' }))
    // writeLKG writes manifest.json last — its mtime is the snapshot moment.
    writeFileSync(join(lkgSnap, 'manifest.json'), JSON.stringify({ files: [] }))
    const liveWeb = join(fakeHome, '.dsh/profiles/web')
    mkdirSync(liveWeb, { recursive: true })
    writeFileSync(join(liveWeb, 'package.json'), JSON.stringify({ version: '1' }))
    const libFile = join(liveWeb, 'node_modules/@ddtcorex/example-plugin/lib/plugin.js')
    mkdirSync(dirname(libFile), { recursive: true })
    writeFileSync(libFile, 'export const x = 1')

    // Fully deterministic: the file-metadata reader is injected and backed by a
    // controlled map — no utimesSync (CI runners do not reliably reflect
    // utimes deltas in statSync mtimes for filesystem-backed paths).
    const stats = new Map<string, { mtimeMs: number }>([
      [join(lkgSnap, 'manifest.json'), { mtimeMs: 1000 }], // snapshot moment
      [libFile, { mtimeMs: 500 }], // lib built BEFORE the snapshot → unchanged
    ])
    const statFile = (p: string): { mtimeMs: number } => {
      const s = stats.get(p)
      if (!s) throw new Error(`no fixture stat for ${p}`)
      return s
    }
    expect(isPluginTreeChanged(fakeHome, undefined, { statFile })).toBe(false)
    // lib rebuilt AFTER the snapshot (2000 > manifest 1000) → changed
    stats.set(libFile, { mtimeMs: 2000 })
    expect(isPluginTreeChanged(fakeHome, undefined, { statFile })).toBe(true)
  })

  it('detects a live cordis.patch.yml different from the LKG snapshot even when the manifest is identical', () => {
    const lkgSnap = join(fakeHome, '.dsh/.supervisor/lkg/2026-01-01T00-00-00-000Z')
    const lkgWeb = join(lkgSnap, 'profiles/web')
    mkdirSync(lkgWeb, { recursive: true })
    const manifest = JSON.stringify({ version: '0.7.0' })
    writeFileSync(join(lkgWeb, 'package.json'), manifest)
    writeFileSync(join(lkgWeb, 'cordis.patch.yml'), 'maestro-supervisor:\n  config:\n    autoResumeWithin: 5\n')
    writeFileSync(join(lkgSnap, 'manifest.json'), JSON.stringify({ files: [] }))
    const liveWeb = join(fakeHome, '.dsh/profiles/web')
    mkdirSync(liveWeb, { recursive: true })
    writeFileSync(join(liveWeb, 'package.json'), manifest)
    // same manifest + same patch → unchanged
    writeFileSync(join(liveWeb, 'cordis.patch.yml'), 'maestro-supervisor:\n  config:\n    autoResumeWithin: 5\n')
    expect(isPluginTreeChanged(fakeHome)).toBe(false)
    // patch-only edit → changed (the manifest-driven check alone would miss it)
    writeFileSync(join(liveWeb, 'cordis.patch.yml'), 'maestro-supervisor:\n  config:\n    autoResumeWithin: 10\n')
    expect(isPluginTreeChanged(fakeHome)).toBe(true)
  })

  it('treats a patch file present on only one side as changed', () => {
    const lkgSnap = join(fakeHome, '.dsh/.supervisor/lkg/2026-01-01T00-00-00-000Z')
    const lkgWeb = join(lkgSnap, 'profiles/web')
    mkdirSync(lkgWeb, { recursive: true })
    const manifest = JSON.stringify({ version: '0.7.0' })
    writeFileSync(join(lkgWeb, 'package.json'), manifest)
    writeFileSync(join(lkgSnap, 'manifest.json'), JSON.stringify({ files: [] }))
    const liveWeb = join(fakeHome, '.dsh/profiles/web')
    mkdirSync(liveWeb, { recursive: true })
    writeFileSync(join(liveWeb, 'package.json'), manifest)
    // live gained a cordis.patch.yml the LKG snapshot predates
    writeFileSync(join(liveWeb, 'cordis.patch.yml'), 'maestro-supervisor:\n  config:\n    autoResumeWithin: 5\n')
    expect(isPluginTreeChanged(fakeHome)).toBe(true)
  })

  it('falls back to changed when the stat reader errors on the live tree (dry-boot gate)', () => {
    const lkgSnap = join(fakeHome, '.dsh/.supervisor/lkg/2026-01-01T00-00-00-000Z')
    const lkgWeb = join(lkgSnap, 'profiles/web')
    mkdirSync(lkgWeb, { recursive: true })
    writeFileSync(join(lkgWeb, 'package.json'), JSON.stringify({ version: '1' }))
    writeFileSync(join(lkgSnap, 'manifest.json'), JSON.stringify({ files: [] }))
    const liveWeb = join(fakeHome, '.dsh/profiles/web')
    mkdirSync(liveWeb, { recursive: true })
    writeFileSync(join(liveWeb, 'package.json'), JSON.stringify({ version: '1' }))
    const libFile = join(liveWeb, 'node_modules/@ddtcorex/example-plugin/lib/plugin.js')
    mkdirSync(dirname(libFile), { recursive: true })
    writeFileSync(libFile, 'export const x = 1')
    const statFile = (p: string): { mtimeMs: number } => {
      if (p === libFile) throw new Error('EACCES: live plugin lib unreadable')
      if (p === join(lkgSnap, 'manifest.json')) return { mtimeMs: 1000 }
      throw new Error(`unexpected stat ${p}`)
    }
    expect(isPluginTreeChanged(fakeHome, undefined, { statFile })).toBe(true)
  })
})