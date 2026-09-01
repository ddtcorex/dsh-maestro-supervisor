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
 * concatenated frames). The `firstEmitPrefix` binary search is cheap
 * (log2 scans of ≤1–4 KB prefixes per file when healthy).
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
export interface SessionHealthEntry { path: string; klass: SessionLogClass }

/** Standard zstd frame encoder (node:zlib) — decode-compatible with fzstd. */
function compress(data: Buffer): Buffer {
  return zstdCompressSync(data)
}

/** Smallest input prefix at which a streaming decoder first emits output (≈ first-frame completion). */
function firstEmitPrefix(buf: Buffer): number {
  const emits = (len: number): boolean => {
    let fired = false
    const d = new Decompress((chunk) => { if (chunk.length > 0) fired = true })
    d.push(buf.subarray(0, len))
    return fired
  }
  let hi = buf.length
  for (let l = 256; l <= buf.length; l += 256) if (emits(l)) { hi = l; break }
  if (!emits(buf.length)) return buf.length
  let lo = 0
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; emits(mid) ? hi = mid : lo = mid }
  return hi
}

function isSingleHeaderLine(plain: Buffer): boolean {
  if (plain.length === 0) return false
  const nl = plain.indexOf(0x0a)
  return nl === plain.length - 1            // exactly one line, terminated by '\n'
}

/**
 * Classify a single session log file per the validated algorithm:
 * whole-file decode success guards 'corrupt', otherwise the first-frame
 * prefix decode decides 'ok' (header-only first frame) vs the recoverable
 * 'single-frame-whole-log'. Empty files are not session logs.
 */
export async function classifySessionLog(path: string): Promise<SessionHealthEntry> {
  let buf: Buffer
  try { buf = readFileSync(path) } catch { return { path, klass: 'not-a-session-log' } }
  if (buf.length === 0) return { path, klass: 'not-a-session-log' }
  let whole: Buffer
  try { whole = Buffer.from(decompress(buf)) } catch { return { path, klass: 'corrupt-first-frame' } }
  const firstEnd = firstEmitPrefix(buf)
  let first: Buffer | undefined
  try { first = Buffer.from(decompress(buf.subarray(0, firstEnd))) } catch { /* prefix not a complete frame */ }
  if (first?.byteLength !== undefined && isSingleHeaderLine(first)) return { path, klass: 'ok' }
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
  for (const p of found) out.push(await classifySessionLog(p))
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
  }
  return { fixed, quarantined, remaining }
}