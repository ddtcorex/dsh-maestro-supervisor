import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'
import { join, basename } from 'node:path'
import { decompress } from 'fzstd'
import { classifySessionLog, repairSingleFrameLog, runSessionHealthCheck } from '../src/host/session-health.js'

// fzstd is a decode-only zstd library; test fixtures are built with Node's
// native zlib zstd encoder (standard frames, decodable by fzstd).
const compress = (data: Buffer): Buffer => zstdCompressSync(data)

const header = (id: string) => JSON.stringify({ type: 'session', version: 0, id, createdAt: 1, cwd: '/work', delegationDepth: 0, agentPreset: 'cordis' }) + '\n'
const writeLog = (dir: string, frames: Buffer[]) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.concat(frames)) }

describe('session health scan', () => {
  it('classifies a healthy 2-frame log as ok', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-healthy-'))
    try {
      writeLog(dir, [compress(Buffer.from(header('s1'))), compress(Buffer.from('{"type":"step/start","seq":1,"time":2,"data":{}}\n'))])
      expect((await classifySessionLog(join(dir, 'session.jsonl.zstd'))).klass).toBe('ok')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('classifies a single whole-file frame as single-frame-whole-log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-single-'))
    try {
      const payload = header('s2') + '{"type":"step/start","seq":1,"time":2,"data":{}}\n'
      writeLog(dir, [compress(Buffer.from(payload))]) // ONE frame for the whole log
      expect((await classifySessionLog(join(dir, 'session.jsonl.zstd'))).klass).toBe('single-frame-whole-log')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('classifies garbage bytes as corrupt-first-frame', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-corrupt-'))
    try {
      writeLog(dir, [Buffer.from('this is not zstd')])
      expect((await classifySessionLog(join(dir, 'session.jsonl.zstd'))).klass).toBe('corrupt-first-frame')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('classifies ok from the first frame alone when the tail is undecodable garbage (no whole-file decode)', async () => {
    // Perf regression: classifySessionLog must never decode the whole file for
    // the dominant healthy case. This fixture has a valid header-only first
    // frame followed by 512 random bytes that are NOT valid zstd — whole-file
    // decompress THROWS on it (asserted below), so the only way classify can
    // return 'ok' is by bounding its decode to the first frame (≤ 64 KiB head).
    const dir = mkdtempSync(join(tmpdir(), 'sh-nowhole-'))
    try {
      const path = join(dir, 'session.jsonl.zstd')
      const fixture = Buffer.concat([compress(Buffer.from(header('sNowhole'))), randomBytes(512)])
      writeFileSync(path, fixture)
      expect(() => decompress(fixture)).toThrow() // sanity: whole-file decode is impossible on this file
      expect((await classifySessionLog(path)).klass).toBe('ok')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('repairSingleFrameLog re-encodes to a header-only first frame and preserves payload byte-for-byte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-repair-'))
    try {
      const headerLine = header('s3')
      const events = Array.from({ length: 500 }, (_, i) => `{"type":"step/start","seq":${i + 1},"time":${i + 3},"data":{}}`)
      const payload = headerLine + events.join('\n') + '\n'
      const path = join(dir, 'session.jsonl.zstd')
      writeLog(dir, [compress(Buffer.from(payload))])
      await repairSingleFrameLog(path)
      expect((await classifySessionLog(path)).klass).toBe('ok')                            // header-only first frame now
      const repaired = readFileSync(path)
      expect(Buffer.from(decompress(repaired)).toString('utf8')).toBe(payload)             // data identical
      expect(existsSync(path + '.corrupt-singleframe.bak')).toBe(true)                     // backup preserved
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('runSessionHealthCheck leaves healthy dirs untouched and repairs a single-frame log', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-root-'))
    try {
      writeLog(join(root, '--work--', 'session-healthy-0000'), [compress(Buffer.from(header('sA'))), compress(Buffer.from('{"type":"step/start","seq":1,"time":2,"data":{}}\n'))])
      writeLog(join(root, '--work--', 'session-single-0000'), [compress(Buffer.from(header('sB') + '{"type":"step/start","seq":1,"time":2,"data":{}}\n'))])
      const r = await runSessionHealthCheck(root, { repair: true })
      expect(r.fixed).toBe(1)
      expect(r.remaining).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('classifies a large many-frame log stack-safely (first-frame probe bounded to 64 KiB)', async () => {
    // Regression: the first-frame probe must never feed the whole file into the
    // streaming decoder. On real long-running logs (~5000+ concatenated frames)
    // a whole-buffer push overflows the V8 stack (RangeError: Maximum call stack
    // size exceeded) and runSessionHealthCheck throws, silently no-op'ing the
    // safe-restart heal. Frames here are incompressible (base64 of random bytes),
    // N≫2500, total ≥1.8 MB — enough to reproduce the overflow on the old code.
    const dir = mkdtempSync(join(tmpdir(), 'sh-many-'))
    try {
      const frames: Buffer[] = [compress(Buffer.from(header('sMany')))]
      let total = Buffer.byteLength(Buffer.from(header('sMany')))
      const N = 12_000
      for (let i = 0; i < N; i++) {
        const line = randomBytes(200).toString('base64') + '\n'
        frames.push(compress(Buffer.from(line, 'utf8')))
        total += line.length
      }
      writeLog(dir, frames)
      expect(total).toBeGreaterThanOrEqual(1.8 * 1024 * 1024)
      const path = join(dir, 'session.jsonl.zstd')
      expect((await classifySessionLog(path)).klass).toBe('ok')
      await expect(runSessionHealthCheck(dir, { repair: true })).resolves.toMatchObject({ remaining: 0 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ---------------------------------------------------------------------------
// 2026-09-01 real-artifact validation. The incident log that motivated the A1
// scanner was ONE whole-file zstd frame (header line + ~20k event lines).
// This section pins that shape twice:
//  1. always-on synthetic replica — one whole-file frame with a real-shaped
//     header line + 500 event lines, repaired byte-for-byte (CI-safe);
//  2. guarded real backup — only when the operator's private DSH home holds a
//     genuinely single-frame backup (the A1 repair leaves `*.corrupt-singleframe*`
//     sidecars for exactly those). The backup path is derived from os.homedir()
//     at runtime and never committed, so CI (no ~/.dsh) always skips this suite.
// ---------------------------------------------------------------------------

/** Real-shaped header line (createdAt epoch, cwd, delegationDepth, agentPreset)
 * mirroring the 2026-09-01 artifact's first line. */
const artifactHeaderLine = (id: string) =>
  JSON.stringify({ type: 'session', version: 0, id, createdAt: 1788230776049, cwd: '/work/example-project', delegationDepth: 0, agentPreset: 'cordis' }) + '\n'

/** Parse the session id out of the decoded payload's header line. */
const headerSessionId = (plain: Buffer): string => {
  const nl = plain.indexOf(0x0a)
  return JSON.parse(plain.subarray(0, nl).toString('utf8')).id as string
}

/** Find the newest real single-frame backup under the operator's DSH home
 * sessions dir. Purely name- and mtime-based (no decompression); permission
 * errors are ignored, so a missing/inaccessible store yields `undefined` and
 * the guarded suite is skipped. */
function findRealSingleFrameBackup(): string | undefined {
  const root = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(root)) return undefined
  let best: { path: string; mtime: number } | undefined
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const fp = join(dir, e.name)
      if (e.isDirectory()) walk(fp, depth + 1)
      else if (e.isFile() && basename(e.name).endsWith('.bak') && basename(e.name).includes('.corrupt-singleframe')) {
        let mtime = 0
        try { mtime = statSync(fp).mtimeMs } catch { continue }
        if (mtime > (best?.mtime ?? 0)) best = { path: fp, mtime }
      }
    }
  }
  walk(root, 0)
  return best?.path
}

describe('2026-09-01 artifact shape — synthetic replica (always on)', () => {
  it('repairs a single whole-file frame (real header + 500 events) byte-for-byte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-artifact-synth-'))
    try {
      const id = 'session-synth-2026-09-01'
      const events = Array.from({ length: 500 }, (_, i) => `{"type":"step/start","seq":${i + 1},"time":${1788230776049 + i},"data":{}}`)
      const payload = artifactHeaderLine(id) + events.join('\n') + '\n'
      const path = join(dir, 'session.jsonl.zstd')
      writeLog(dir, [compress(Buffer.from(payload))]) // ONE whole-file frame, exactly like the real artifact
      expect((await classifySessionLog(path)).klass).toBe('single-frame-whole-log')
      await repairSingleFrameLog(path)
      expect((await classifySessionLog(path)).klass).toBe('ok')                     // first frame header-only now
      expect(existsSync(path + '.corrupt-singleframe.bak')).toBe(true)               // sidecar backup kept
      const repaired = Buffer.from(decompress(readFileSync(path)))
      expect(repaired.toString('utf8')).toBe(payload)                                // byte-identical payload
      expect(headerSessionId(repaired)).toBe(id)                                     // session id intact
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

const realSingleFrameBackup = findRealSingleFrameBackup()

describe.skipIf(realSingleFrameBackup === undefined)('2026-09-01 real artifact (operator-machine backup present)', () => {
  it('repairs the real single-frame backup on a copy: reclassify ok, payload byte-identical, session id intact', async () => {
    const path = realSingleFrameBackup as string
    expect(path).toBeTruthy()
    const dir = mkdtempSync(join(tmpdir(), 'sh-artifact-real-'))
    try {
      const copy = join(dir, 'session.jsonl.zstd')
      writeFileSync(copy, readFileSync(path)) // never the real file — always a copy
      expect((await classifySessionLog(copy)).klass).toBe('single-frame-whole-log')
      const payload = Buffer.from(decompress(readFileSync(copy)))
      const id = headerSessionId(payload)
      await repairSingleFrameLog(copy)
      expect((await classifySessionLog(copy)).klass).toBe('ok')
      expect(existsSync(copy + '.corrupt-singleframe.bak')).toBe(true)
      const repaired = readFileSync(copy)
      const repairedPlain = Buffer.from(decompress(repaired))
      expect(repairedPlain.toString('utf8')).toBe(payload.toString('utf8'))
      expect(headerSessionId(repairedPlain)).toBe(id)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})