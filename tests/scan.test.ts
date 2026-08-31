import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanSessions } from '../src/host/scan.js'

describe('scanSessions', () => {
  it('flags a torn zstd session and tolerates a valid plain-text log', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-scan-'))
    try {
      // Real layout is <dshHome>/sessions/<project>/<session>/{session.jsonl.zstd,*.jsonl}
      const sess = join(root, 'sessions', 'proj', 's1')
      mkdirSync(sess, { recursive: true })
      writeFileSync(join(sess, 'good.jsonl'), '{"type":"session","id":"s1"}\n')
      // Torn zstd frame: magic bytes + a single trailing byte — zstd must
      // report "premature end" (decode failure), never silently succeed.
      writeFileSync(join(sess, 'torn.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]))
      const res = await scanSessions(root, { withinMs: 60 * 60 * 1000 })
      expect(res.scanned).toBe(2)
      // Exactly the torn zstd is flagged; the valid plain-text log is not torn.
      expect(res.torn).toEqual([join(sess, 'torn.jsonl.zstd')])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('returns an empty scan when the sessions root is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-scan-missing-'))
    try {
      const res = await scanSessions(root, { withinMs: 60 * 60 * 1000 })
      expect(res).toEqual({ scanned: 0, torn: [] })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})