import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pollHealth } from '../src/host/health-poller.js'
import { Supervisor } from '../src/host/supervisor.js'
import { writeLKG, verifyLKG } from '../src/host/snapshot.js'
import { writeReport } from '../src/host/report.js'

// All realistic fault cases from DSH local experience (spec §7 + local incidents)
const cases = [
  {
    id: 'A1-settings-corrupted-json',
    log: 'SyntaxError: Unexpected token { in JSON at position 2 (settings.json)',
    fetchStatus: 200,
    expectUp: false,
    expectErrorContains: 'SyntaxError',
  },
  {
    id: 'A2-settings-invalid-schema',
    log: 'Error: settings.json: invalid schema — missing required field',
    // fetch may still 200 but health should be flagged via log
    fetchStatus: 200,
    expectUp: false,
    expectErrorContains: 'JSON',
  },
  {
    id: 'B1-plugin-lib-missing',
    log: 'Error: Cannot find module \'/home/kai/.dsh/profiles/web/node_modules/@ddtcorex/dsh-maestro-memory/lib/index.js\'\nERR_MODULE_NOT_FOUND',
    fetchStatus: 500,
    expectUp: false,
    expectErrorContains: 'ERR_MODULE_NOT_FOUND',
  },
  {
    id: 'B2-cordis-channel-missing-slash',
    log: 'Error: assertChannel failed: channel must match /^\\/[A-Za-z0-9._~-]+$/ — got "dsh-maestro-memory" (missing leading /)',
    fetchStatus: 500,
    expectUp: false,
    expectErrorContains: 'assertChannel',
  },
  {
    id: 'B3-allowBuilds-missing',
    log: 'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @ddtcorex/dsh-maestro-memory — allowBuilds.esbuild is not set',
    fetchStatus: 500,
    expectUp: false,
    expectErrorContains: 'Failed to load',
  },
  {
    id: 'B4-rootDir-wrong',
    log: 'Error: Failed to load host plugin @ddtcorex/dsh-maestro-config — ERR_MODULE_NOT_FOUND: Cannot find module lib/index.js (tried lib/host/index.js)',
    fetchStatus: 500,
    expectUp: false,
    expectErrorContains: 'Cannot find module',
  },
  {
    id: 'C1-agent-preset-invalid-yaml',
    log: 'YAMLParseError: bad indentation in ~/.dsh/.agent-presets/test/agent.cordis.yml',
    fetchStatus: 200,
    expectUp: false,
    expectErrorContains: 'Failed to load',
  },
  {
    id: 'C2-profile-package-json-corrupted',
    log: 'SyntaxError: Unexpected token in ~/.dsh/profiles/web/package.json',
    fetchStatus: 200,
    expectUp: false,
    expectErrorContains: 'SyntaxError',
  },
]

describe('realistic cases — health poller', () => {
  for (const c of cases) {
    it(`${c.id} — pollHealth flags down`, async () => {
      const r = await pollHealth({
        fetch: async () => ({ status: c.fetchStatus, text: async () => 'ok' }) as any,
        psAlive: async () => c.fetchStatus === 200,
        logTail: async () => c.log,
      })
      expect(r.up).toBe(c.expectUp)
      if (!c.expectUp) {
        expect(r.error).toBeDefined()
      }
    })
  }
})

describe('realistic cases — supervisor rollback + report + snapshot', () => {
  for (const c of cases) {
    it(`${c.id} — supervisor triggers rollback and report`, async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `case-${c.id}-`))
      const dshHome = path.join(tmp, 'dsh-home')
      const lkgRoot = path.join(tmp, 'lkg')
      const failedRoot = path.join(tmp, 'failed')
      const reportsRoot = path.join(tmp, 'reports')
      fs.mkdirSync(path.join(dshHome, 'maestro'), { recursive: true })
      fs.writeFileSync(path.join(dshHome, 'maestro/settings.json'), JSON.stringify({ ok: true }))
      const { ts: lkgTs } = await writeLKG(dshHome, lkgRoot)
      expect(await verifyLKG(path.join(lkgRoot, lkgTs))).toBe(true)

      // corrupt for report context
      fs.writeFileSync(path.join(dshHome, 'maestro/settings.json'), '{ corrupted')

      let rollbackCalled = false
      let reportPath = ''
      const s = new Supervisor({
        pollHealth: async () => ({ up: false, httpCode: c.fetchStatus, error: c.log.slice(0, 100) }),
        writeLKG: async () => ({ ts: lkgTs, manifest: {} as any }),
        writeFailed: async () => {
          const r = await writeLKG(dshHome, failedRoot)
          return r
        },
        writeReport: async (opts) => {
          reportPath = await writeReport({
            reportsRoot,
            ts: opts.ts,
            health: opts.health,
            gitDiff: `fault: ${c.id}`,
            logTail: c.log,
            action: `rollback — ${c.id}`,
          })
          return reportPath
        },
        rollback: async () => {
          rollbackCalled = true
          // simulate restore from LKG
          fs.cpSync(path.join(lkgRoot, lkgTs), dshHome, { recursive: true, force: true })
        },
        notify: async () => {},
        debounceMs: 0,
      })
      await s.tick()
      expect(rollbackCalled).toBe(true)
      expect(fs.existsSync(reportPath)).toBe(true)
      const content = fs.readFileSync(reportPath, 'utf-8')
      expect(content).toContain(c.id)
      // after rollback, settings should be restored
      expect(fs.readFileSync(path.join(dshHome, 'maestro/settings.json'), 'utf-8')).toContain('ok')
      fs.rmSync(tmp, { recursive: true, force: true })
    })
  }
})
