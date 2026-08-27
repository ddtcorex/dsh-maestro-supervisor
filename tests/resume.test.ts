import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Wrap execSync so we can observe every call resume.ts makes (it decompresses
// .zstd session logs via a dynamic `import('node:child_process')`), while still
// letting the wrapped calls actually execute for fixture setup and real
// decompression during the tests that need it.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, execSync: vi.fn(actual.execSync) }
})

import * as childProcess from 'node:child_process'
import { findInterrupted } from '../src/host/resume.js'

const mockedExecSync = childProcess.execSync as unknown as ReturnType<typeof vi.fn>

let zstdAvailable = true
try {
  childProcess.execSync('zstd --version', { stdio: 'ignore' })
} catch {
  zstdAvailable = false
}

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-test-'))
  mockedExecSync.mockClear()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function sessionDir(group: string, id: string): string {
  const dir = path.join(tmp, 'sessions', group, id)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeJsonl(dir: string, lines: string[], mtime?: Date) {
  const file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(file, lines.join('\n') + '\n')
  if (mtime) fs.utimesSync(file, mtime, mtime)
}

function writeZstd(dir: string, lines: string[], mtime?: Date) {
  const plain = path.join(dir, '_src.jsonl')
  fs.writeFileSync(plain, lines.join('\n') + '\n')
  const zstdPath = path.join(dir, 'session.jsonl.zstd')
  childProcess.execSync(`zstd -q -f ${JSON.stringify(plain)} -o ${JSON.stringify(zstdPath)}`)
  fs.rmSync(plain)
  if (mtime) fs.utimesSync(zstdPath, mtime, mtime)
}

function interruptedLine(time: number): string {
  return JSON.stringify({ type: 'turn/end', time, data: { reason: { kind: 'interrupted' } } })
}

function completedLine(time: number): string {
  return JSON.stringify({ type: 'turn/end', time, data: { reason: { kind: 'completed' } } })
}

describe('findInterrupted — plain .jsonl detection', () => {
  it('detects a trailing turn/end interrupted event', async () => {
    const dir = sessionDir('proj', 'sess-a')
    writeJsonl(dir, [
      JSON.stringify({ type: 'turn/start', time: Date.now() - 1000 }),
      interruptedLine(Date.now()),
    ])
    const res = await findInterrupted(tmp)
    expect(res.interrupted).toContain('proj/sess-a')
    expect(res.scanned).toBe(1)
  })

  it('does not detect a turn/end whose reason is completed, not interrupted', async () => {
    const dir = sessionDir('proj', 'sess-b')
    writeJsonl(dir, [completedLine(Date.now())])
    const res = await findInterrupted(tmp)
    expect(res.interrupted).not.toContain('proj/sess-b')
  })

  it('does not crash and does not false-positive on garbage/unparseable lines', async () => {
    const dir = sessionDir('proj', 'sess-c')
    writeJsonl(dir, [
      'not json at all',
      '{ still not valid json',
      JSON.stringify({ type: 'turn/end' }), // no data.reason at all
      completedLine(Date.now()),
    ])
    const result = await findInterrupted(tmp)
    expect(result.interrupted).not.toContain('proj/sess-c')
  })
})

describe('findInterrupted — .zstd detection', () => {
  it.skipIf(!zstdAvailable)('detects an interrupted turn/end in a zstd-compressed log', async () => {
    const dir = sessionDir('proj', 'sess-z')
    writeZstd(dir, [
      JSON.stringify({ type: 'turn/start', time: Date.now() - 1000 }),
      interruptedLine(Date.now()),
    ])
    const res = await findInterrupted(tmp)
    expect(res.interrupted).toContain('proj/sess-z')
  })
})

describe('findInterrupted — time-window filtering', () => {
  it('excludes an interrupted session older than the window and includes one within it', async () => {
    const now = Date.now()
    const oldDir = sessionDir('proj', 'sess-old')
    writeJsonl(oldDir, [interruptedLine(now - 60 * 60 * 1000)]) // 1h ago
    const recentDir = sessionDir('proj', 'sess-recent')
    writeJsonl(recentDir, [interruptedLine(now - 1000)]) // 1s ago

    const res = await findInterrupted(tmp, { withinMs: 5 * 60 * 1000 }) // 5m window
    expect(res.interrupted).not.toContain('proj/sess-old')
    expect(res.interrupted).toContain('proj/sess-recent')
  })
})

describe('findInterrupted — Finding 1: mtime pre-filter avoids decompression', () => {
  it.skipIf(!zstdAvailable)('never decompresses a .zstd log whose mtime predates the requested window', async () => {
    const now = Date.now()
    const oldTime = new Date(now - 60 * 60 * 1000) // 1h old — must be skipped
    const recentTime = new Date(now - 1000) // 1s old — must be scanned

    // Several old sessions that would otherwise all pay the decompression cost.
    for (let i = 0; i < 5; i++) {
      const dir = sessionDir('proj', `sess-old-${i}`)
      writeZstd(dir, [interruptedLine(now - 60 * 60 * 1000)], oldTime)
    }
    const recentDir = sessionDir('proj', 'sess-recent')
    writeZstd(recentDir, [interruptedLine(now - 1000)], recentTime)

    mockedExecSync.mockClear() // ignore the zstd compression calls used for fixture setup

    const res = await findInterrupted(tmp, { withinMs: 5 * 60 * 1000 })

    // Only the recent session's log should have been decompressed.
    expect(mockedExecSync).toHaveBeenCalledTimes(1)
    expect(mockedExecSync.mock.calls[0][0]).toContain('sess-recent')
    expect(res.interrupted).toContain('proj/sess-recent')
    expect(res.interrupted).not.toContain('proj/sess-old-0')
  })

  it.skipIf(!zstdAvailable)('does not skip anything when no time window is requested (sinceMs undefined)', async () => {
    const now = Date.now()
    const oldTime = new Date(now - 60 * 60 * 1000)
    const dir = sessionDir('proj', 'sess-old-unfiltered')
    writeZstd(dir, [interruptedLine(now - 60 * 60 * 1000)], oldTime)

    mockedExecSync.mockClear()

    const res = await findInterrupted(tmp) // no opts -> no window
    expect(mockedExecSync).toHaveBeenCalledTimes(1)
    expect(res.interrupted).toContain('proj/sess-old-unfiltered')
  })
})
