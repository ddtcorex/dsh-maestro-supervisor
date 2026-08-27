import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { writeReport } from '../src/host/report.js'

describe('report', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'report-'))
  })

  it('writes report with health and git diff', async () => {
    const p = await writeReport({
      reportsRoot: tmp,
      ts: '2026-08-27T00-00-00-000Z',
      health: { up: false, error: 'ERR_MODULE_NOT_FOUND' },
      gitDiff: 'diff --git a/src/host/index.ts b/src/host/index.ts',
      logTail: 'ERR_MODULE_NOT_FOUND: lib/index.js',
      action: 'rollback to 2026-08-26T14-20-00Z',
    })
    expect(fs.existsSync(p)).toBe(true)
    const content = fs.readFileSync(p, 'utf-8')
    expect(content).toContain('ERR_MODULE_NOT_FOUND')
    expect(content).toContain('rollback')
    expect(content.toLowerCase()).toContain('git diff')
  })

  it('creates reports dir if missing', async () => {
    const nested = path.join(tmp, 'a/b')
    const p = await writeReport({
      reportsRoot: nested,
      ts: '2026-08-27T01-00-00-000Z',
      health: { up: true },
      gitDiff: '',
      logTail: '',
      action: 'degraded: maestro-xyz',
    })
    expect(fs.existsSync(p)).toBe(true)
  })
})
