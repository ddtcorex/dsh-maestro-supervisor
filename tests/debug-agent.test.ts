import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runDebugAgent, _resetDebugAgentForTest } from '../src/host/debug-agent.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

describe('debug-agent — cooldown and max attempts', () => {
  beforeEach(() => _resetDebugAgentForTest())

  it('respects cooldown', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'))
    const report = path.join(tmp, 'report.md')
    fs.writeFileSync(report, '# report')

    // mock dryBoot to succeed so first call returns fixed
    const r1 = await runDebugAgent({
      reportPath: report,
      health: { error: 'transient' },
      cooldownMs: 60000,
      dryBoot: async () => true,
    })
    expect(r1.fixed).toBe(true)

    const r2 = await runDebugAgent({
      reportPath: report,
      health: { error: 'transient' },
      cooldownMs: 60000,
      dryBoot: async () => true,
    })
    expect(r2.reason).toBe('cooldown')
    expect(r2.fixed).toBe(false)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('stops after 3 attempts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'))
    const report = path.join(tmp, 'report.md')
    fs.writeFileSync(report, '# report')

    for (let i = 0; i < 3; i++) {
      _resetDebugAgentForTest()
      // we reset to bypass cooldown, but attempts accumulate unless reset
      // Instead test without reset: need to exhaust attempts
    }
    // fresh
    _resetDebugAgentForTest()
    for (let i = 0; i < 3; i++) {
      const r = await runDebugAgent({
        reportPath: report,
        health: { error: `fail ${i}` },
        cooldownMs: 0,
        dryBoot: async () => false,
        fetchLLM: async () => { throw new Error('no llm') },
      })
      expect(r.fixed).toBe(false)
    }
    const r4 = await runDebugAgent({
      reportPath: report,
      health: { error: 'fourth' },
      cooldownMs: 0,
      dryBoot: async () => false,
      fetchLLM: async () => 'fix',
    })
    expect(r4.reason).toBe('max attempts')
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('debug-agent — deterministic transient', () => {
  beforeEach(() => _resetDebugAgentForTest())

  it('returns fixed when dryBoot succeeds (transient degraded)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'))
    const report = path.join(tmp, 'report.md')
    fs.writeFileSync(report, 'ERR_MODULE_NOT_FOUND fake')

    const r = await runDebugAgent({
      reportPath: report,
      health: { error: 'ERR_MODULE_NOT_FOUND: lib/index.js' },
      cooldownMs: 0,
      dryBoot: async () => true,
      exec: () => '',
      readFile: (p: string) => { try { return fs.readFileSync(p, 'utf-8') } catch { return '' } },
    })
    expect(r.fixed).toBe(true)
    expect(r.reason).toMatch(/dry-boot ok|transient/i)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('debug-agent — LLM wiring (systematic-debugging)', () => {
  beforeEach(() => _resetDebugAgentForTest())

  it('calls LLM when deterministic fix insufficient and dryBoot fails', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'))
    const report = path.join(tmp, 'report.md')
    fs.writeFileSync(report, 'unknown error XYZ')

    const fetchLLM = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('unknown error XYZ')
      expect(prompt).toContain('systematic-debugging')
      // Return a JSON fix instruction: patch pnpm-workspace.yaml or similar
      return JSON.stringify({
        analysis: 'test analysis — root cause is missing allowBuilds',
        file: path.join(tmp, 'fix-target.txt'),
        content: 'fixed-content',
      })
    })

    // First dryBoot (reproduce) fails, second after LLM fix succeeds
    let dryCall = 0
    const dryBoot = vi.fn(async () => {
      dryCall++
      return dryCall >= 2
    })
    const writeFile = vi.fn((p: string, c: string) => { fs.writeFileSync(p, c) })

    const r = await runDebugAgent({
      reportPath: report,
      health: { error: 'unknown error XYZ' },
      cooldownMs: 0,
      fetchLLM,
      dryBoot,
      writeFile,
      exec: () => '',
      readFile: (p: string) => { try { return fs.readFileSync(p, 'utf-8') } catch { return '' } },
    })

    expect(fetchLLM).toHaveBeenCalledTimes(1)
    expect(dryBoot).toHaveBeenCalledTimes(2)
    expect(r.fixed).toBe(true)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('returns not fixed when LLM fails or dryBoot still fails', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'))
    const report = path.join(tmp, 'report.md')
    fs.writeFileSync(report, 'error ABC')

    const fetchLLM = vi.fn(async () => { throw new Error('LLM unavailable') })

    const r = await runDebugAgent({
      reportPath: report,
      health: { error: 'error ABC' },
      cooldownMs: 0,
      fetchLLM,
      dryBoot: async () => false,
      exec: () => { throw new Error('verify fail') },
    })

    expect(r.fixed).toBe(false)
    expect(r.reason).toMatch(/LLM|manual/i)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('deterministic auto-fix for allowBuilds before LLM', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'))
    const report = path.join(tmp, 'report.md')
    fs.writeFileSync(report, 'allowBuilds')

    const exec = vi.fn((cmd: string) => {
      if (cmd.includes('pnpm')) return ''
      return ''
    })
    const fetchLLM = vi.fn(async () => { throw new Error('should not be called if auto-fix succeeds') })

    const r = await runDebugAgent({
      reportPath: report,
      health: { error: 'ERR_PNPM allowBuilds.esbuild is not set' },
      cooldownMs: 0,
      exec,
      dryBoot: async () => true,
      fetchLLM,
    })

    // allowBuilds deterministic path should try exec and then dryBoot → fixed without LLM
    expect(r.fixed).toBe(true)
    // fetchLLM should not be called if deterministic path already fixed
    expect(fetchLLM).not.toHaveBeenCalled()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
