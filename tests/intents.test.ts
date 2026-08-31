import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { intentsDir, intentPath, readIntent, consumeIntent } from '../src/host/intents.js'

let tmpHome = ''

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>()
  return { ...orig, homedir: () => tmpHome }
})

afterEach(() => { if (tmpHome) { rmSync(tmpHome, { recursive: true, force: true }); tmpHome = '' } })

describe('restart intents sidecar', () => {
  it('reads a written intent and consumes it', () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'intents-'))
    const sessionId = 'session-3a7428d3-817e-4e19-ade9-f6df908848b6'
    mkdirSync(intentsDir(), { recursive: true })
    writeFileSync(intentPath(sessionId), JSON.stringify({ ts: 1, sessionId, reason: 'e2e-test' }), 'utf8')

    const intent = readIntent(sessionId)
    expect(intent?.reason).toBe('e2e-test')
    expect(intent?.sessionId).toBe(sessionId)

    consumeIntent(sessionId)
    expect(existsSync(intentPath(sessionId))).toBe(false)
    expect(readIntent(sessionId)).toBeUndefined()
  })

  it('returns undefined for a missing or malformed intent', () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'intents-'))
    const sessionId = 'session-none'
    expect(readIntent(sessionId)).toBeUndefined()
    // malformed JSON
    mkdirSync(intentsDir(), { recursive: true })
    writeFileSync(intentPath(sessionId), '{ not json', 'utf8')
    expect(readIntent(sessionId)).toBeUndefined()
  })
})