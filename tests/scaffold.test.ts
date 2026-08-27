import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
describe('scaffold', () => {
  it('emits lib/index.js', () => {
    expect(fs.existsSync('lib/index.js')).toBe(true)
  })
})
