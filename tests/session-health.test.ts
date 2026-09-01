import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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