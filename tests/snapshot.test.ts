import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { writeLKG, verifyLKG, rotateLKG } from '../src/host/snapshot.js'

describe('snapshot', () => {
  let tmp: string
  let dshHome: string
  let lkgRoot: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'))
    dshHome = path.join(tmp, 'dsh-home')
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
