import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const shouldRun = process.env.DSH_INTEGRATION === '1'

describe('integration — supervisor with ephemeral DSH_HOME', () => {
  it.skipIf(!shouldRun)('detects corrupted settings and triggers report', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-'))
    const dshHome = path.join(tmp, 'fake-home')
    fs.mkdirSync(path.join(dshHome, 'maestro'), { recursive: true })
    fs.writeFileSync(path.join(dshHome, 'maestro/settings.json'), '{ corrupted')
    // Simulate supervisor detecting failure — just verify writeLKG + report path
    const { writeLKG } = await import('../src/host/snapshot.js')
    const { writeReport } = await import('../src/host/report.js')
    const lkgRoot = path.join(tmp, 'lkg')
    const reportsRoot = path.join(tmp, 'reports')
    const { ts } = await writeLKG(dshHome, path.join(tmp, 'failed'))
    const reportPath = await writeReport({
      reportsRoot,
      ts,
      health: { up: false, error: 'JSON parse failed' },
      gitDiff: '',
      logTail: 'SyntaxError: Unexpected token',
      action: 'rollback',
    })
    expect(fs.existsSync(reportPath)).toBe(true)
  })
})
