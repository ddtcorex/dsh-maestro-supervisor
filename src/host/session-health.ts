/**
 * Session-log health scan.
 *
 * Deeper resilience for dsh-safe-restart pre-flight: after (or before) a
 * restart, individual session logs under a project session dir can end up in
 * three distinct shapes:
 *
 *  1. healthy multi-frame  — one frame per line (a header-only first frame,
 *                            then per-event frames). The DSH reader depends on
 *                            this shape to fast-seek the session header.
 *  2. single-frame whole-log — the entire log was written as ONE zstd frame.
 *                            Data is fully intact (whole-file decode works) but
 *                            the header cannot be located by a frame walk.
 *  3. corrupt first frame — the first frame cannot be decoded at all.
 *
 * Classification uses fzstd's whole-file decode + streaming Decompress and
 * avoids a hand-rolled zstd frame-header walker (empirically wrong on both
 * real file shapes; fzstd whole-file decode already handles single and
 * concatenated frames). The first-frame probe only ever feeds the streaming
 * decoder a bounded 64 KiB head (log2 scans of ≤256-byte-prefix steps), so it
 * is stack-safe even on long-running many-frame logs — feeding a whole file
 * into the streaming decoder recurses per frame and overflows the V8 stack.
 *
 * Repair re-encodes a single-frame whole-log into the canonical multi-frame
 * shape (frame #1 = exactly the header line, trailing line-batched frames),
 * byte-preserving every event; the original file is kept as a sidecar backup
 * and the replace is atomic (write temp + rename).
 *
 * NOTE: fzstd is a decode-only pure-JS zstd library; re-encoding uses Node's
 * native zlib zstd encoder, whose frames fzstd (and the zstd CLI / DSH's
 * reader) decode as standard concatenated frames.
 */

import { decompress, Decompress } from 'fzstd'
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync, type Dirent } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { join, basename } from 'node:path'

export type SessionLogClass = 'ok' | 'single-frame-whole-log' | 'corrupt-first-frame' | 'not-a-session-log'
export interface SessionHealthEntry { path: string; klass: SessionLogClass; remark?: string }

/**
 * Cap on the file head probed through the streaming decoder. Feeding a whole
 * long-running log (thousands of concatenated zstd frames) into fzstd's
 * streaming `Decompress` in one push recurses once per frame and overflows the
 * V8 stack (RangeError: Maximum call stack size exceeded, seen on a real
 * ~1.8 MB session log). Only the first frame matters for classification, so we
 * never probe past 64 KiB — a canonical log's first frame is a few hundred
 * bytes, and a frame can never legitimately straddle this cap.
 */
const FIRST_FRAME_CAP = 64 * 1024

/** Standard zstd frame encoder (node:zlib) — decode-compatible with fzstd. */
function compress(data: Buffer): Buffer {
  return zstdCompressSync(data)
}

type FrameHead = { found: true; end: number } | { found: false }

/**
 * Smallest head prefix at which the streaming decoder first emits output
 * (≈ first-frame completion), searched only within FIRST_FRAME_CAP. Never
 * pushes more than the cap into the decoder, so the probe is stack-safe on
 * arbitrarily large many-frame logs.
 */
function firstFrameHead(buf: Buffer): FrameHead {
  const emits = (len: number): boolean => {
    let fired = false
    const d = new Decompress((chunk) => { if (chunk.length > 0) fired = true })
    d.push(buf.subarray(0, len))
    return fired
  }
  const cap = Math.min(buf.length, FIRST_FRAME_CAP)
  let hi = cap
  for (let l = 256; l <= cap; l += 256) if (emits(l)) { hi = l; break }
  if (!emits(cap)) return { found: false }   // no frame boundary within the cap
  let lo = 0
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; emits(mid) ? hi = mid : lo = mid }
  return { found: true, end: hi }
}

function isSingleHeaderLine(plain: Buffer): boolean {
  if (plain.length === 0) return false
  const nl = plain.indexOf(0x0a)
  return nl === plain.length - 1            // exactly one line, terminated by '\n'
}

/**
 * Classify a single session log file per the validated algorithm:
 * whole-file decode success guards 'corrupt', otherwise the first-frame head
 * (bounded to 64 KiB) decides 'ok' (header-only first frame) vs the
 * recoverable 'single-frame-whole-log'. A missing first-frame boundary within
 * the cap means the first frame is bigger than 64 KiB — never a canonical
 * healthy log — so it classifies as 'single-frame-whole-log'. Empty files are
 * not session logs.
 */
export async function classifySessionLog(path: string): Promise<SessionHealthEntry> {
  let buf: Buffer
  try { buf = readFileSync(path) } catch { return { path, klass: 'not-a-session-log' } }
  if (buf.length === 0) return { path, klass: 'not-a-session-log' }
  try { decompress(buf) } catch { return { path, klass: 'corrupt-first-frame' } }
  const head = firstFrameHead(buf)
  if (head.found) {
    let first: Buffer | undefined
    try { first = Buffer.from(decompress(buf.subarray(0, head.end))) } catch { /* prefix not a complete frame */ }
    if (first?.byteLength !== undefined && isSingleHeaderLine(first)) return { path, klass: 'ok' }
  }
  return { path, klass: 'single-frame-whole-log' }   // whole-file decodes; first frame isn't header-only → recoverable
}

/**
 * Re-encode a single-frame-whole-log into canonical multi-frame form:
 * frame #1 = exactly the header line, then line-batched trailing frames.
 * The original file is preserved as `path + backupSuffix` (first time only)
 * and the replace is atomic (temp file + rename).
 */
export async function repairSingleFrameLog(path: string, backupSuffix = '.corrupt-singleframe.bak'): Promise<void> {
  const buf = readFileSync(path)
  const whole = Buffer.from(decompress(buf))
  const nl = whole.indexOf(0x0a)
  const header = whole.subarray(0, nl + 1)
  const rest = whole.subarray(nl + 1)
  if (!existsSync(path + backupSuffix)) copyFileSync(path, path + backupSuffix)
  const frames: Buffer[] = [compress(header)]
  let start = 0
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === 0x0a && i - start + 1 >= 64 * 1024) { frames.push(compress(rest.subarray(start, i + 1))); start = i + 1 }
  }
  if (start < rest.length) frames.push(compress(rest.subarray(start)))
  const tmp = path + '.repair.tmp'
  writeFileSync(tmp, Buffer.concat(frames))
  renameSync(tmp, path)
}

/**
 * Walk `root` recursively and classify every `session.jsonl.zstd` found.
 * The process-write layout is <dshHome>/sessions/<project>/<session>/, but we
 * recurse generically so tests and future layouts work unchanged.
 */
export async function scanSessionLogs(root: string): Promise<SessionHealthEntry[]> {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const fp = join(dir, e.name)
      if (e.isDirectory()) walk(fp)
      else if (e.isFile() && basename(e.name) === 'session.jsonl.zstd') found.push(fp)
    }
  }
  walk(root)
  const out: SessionHealthEntry[] = []
  for (const p of found) {
    try {
      out.push(await classifySessionLog(p))
    } catch (err) {
      // One unreadable / unclassifiable file must never abort the whole scan.
      out.push({ path: p, klass: 'corrupt-first-frame', remark: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

/**
 * Health check over a session-log root: repair single-frame logs (atomic
 * re-encode), optionally quarantine corrupt-first-frame logs aside, and
 * report counts. `remaining` counts unhealthy entries left untouched
 * (not-a-session-log, corrupt frames when quarantine is off, and
 * single-frame logs when repair is off).
 */
export async function runSessionHealthCheck(
  root: string,
  opts: { repair?: boolean; quarantine?: boolean } = {},
): Promise<{ fixed: number; quarantined: number; remaining: number }> {
  const repair = opts.repair ?? true
  const quarantine = opts.quarantine ?? false
  let fixed = 0
  let quarantined = 0
  let remaining = 0
  for (const entry of await scanSessionLogs(root)) {
    try {
      switch (entry.klass) {
        case 'single-frame-whole-log':
          if (repair) { await repairSingleFrameLog(entry.path); fixed++ } else remaining++
          break
        case 'corrupt-first-frame':
          if (quarantine) {
            let aside = entry.path + '.corrupt-' + Date.now() + '.bak'
            let n = 0
            while (existsSync(aside)) aside = entry.path + '.corrupt-' + Date.now() + '-' + (++n) + '.bak'
            renameSync(entry.path, aside)
            quarantined++
          } else remaining++
          break
        case 'not-a-session-log':
          remaining++
          break
        default:
          break
      }
    } catch {
      // Repair/quarantine of a single entry failed — it stays unhealthy and
      // can never abort the whole pass. Counts always reconcile.
      remaining++
    }
  }
  return { fixed, quarantined, remaining }
}