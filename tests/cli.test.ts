import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
describe('cli', () => {
  it('shows help', () => {
    const out = execSync('node lib/index.js --help', { encoding: 'utf-8' })
    expect(out).toContain('daemon')
    expect(out).toContain('status')
  })
  it('status runs without crash', () => {
    const out = execSync('node lib/index.js status 2>&1 || true', { encoding: 'utf-8', timeout: 15000 })
    expect(out).toContain('up:')
  }, 15000)
})
