import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dshWebTemplate = resolve(__dirname, '../systemd/dsh-web.service.template')

describe('scaffold', () => {
  it('emits lib/index.js', () => {
    expect(fs.existsSync('lib/index.js')).toBe(true)
  })

  it('the dsh-web unit template caps boot crash loops (StartLimitBurst)', () => {
    const tpl = fs.readFileSync(dshWebTemplate, 'utf8')
    expect(tpl).toMatch(/StartLimitIntervalSec=60/)
    expect(tpl).toMatch(/StartLimitBurst=3/)
  })
})
