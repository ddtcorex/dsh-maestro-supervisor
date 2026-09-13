import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

interface ManifestEntry { path: string; sha256: string }
interface Manifest { ts: string; files: ManifestEntry[] }

export interface SnapshotResult {
  ts: string
  /** Files (and symlinks) copied into this snapshot. */
  files: number
  /** Entries that could not be copied; the snapshot stays usable either way. */
  skipped: Array<{ path: string; reason: string }>
}

/**
 * DSH-home entries the last-known-good snapshot deliberately never copies.
 *
 * The LKG exists to recover a boot that fails while loading the plugin tree, so
 * it holds boot **configuration**: `profiles/` (the plugin tree with its
 * lockfile, `cordis.patch.yml` and sidecars), the per-plugin config directories
 * and the settings documents. Everything below is runtime **data** — it is
 * written continuously while `dsh web` runs, so restoring a snapshot of it can
 * only lose newer state, and some of it is hostile to a bulk copy:
 *
 * - `sessions/` — append-only transcripts. Restoring a stale copy over live
 *   sessions drops every turn recorded after the snapshot, i.e. the recovery
 *   path would lose the log it is supposed to protect.
 * - `attachments/` — content-addressed blobs stored mode `0400`. That read-only
 *   bit is exactly what made the 2026-09-13 rollback abort with
 *   `EACCES: Permission denied '.../attachments/v1/objects/f8'`.
 * - `plugins-src/` — plugin source cache, re-fetched on demand (~400 MB host).
 * - `.supervisor/` — the LKG root itself lives inside the DSH home, so copying
 *   it would recurse into every retained snapshot.
 *
 * This list is data, not a heuristic: the copy loop and the restore loop both
 * consult `isLkgExcluded()`, and the table test pins the rule.
 */
export const LKG_EXCLUDED_ENTRIES: readonly string[] = [
  'sessions',
  'attachments',
  'plugins-src',
  '.supervisor',
]

/**
 * True when a DSH-home-relative path must never enter (or leave) the LKG.
 *
 * The named entries match the first path segment; `*.log` matches by basename
 * anywhere, because append-only logs are data at any depth and a restored stale
 * `dsh-web.log` would poison the boot-boundary scan.
 */
export function isLkgExcluded(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  const segments = normalized.split('/').filter(s => s.length > 0 && s !== '.')
  if (!segments.length) return false
  if (LKG_EXCLUDED_ENTRIES.includes(segments[0]!)) return true
  return segments[segments.length - 1]!.endsWith('.log')
}

function sha256File(filePath: string): string {
  const data = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(data).digest('hex')
}

function walkFiles(dir: string, base: string = dir): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full))
  }
  return out
}

export async function writeLKG(dshHome: string, lkgRoot: string): Promise<SnapshotResult> {
  // Dedupe: skip snapshot if current state identical to latest LKG (prevents 5-min unconditional growth)
  try {
    if (await isDuplicateLKG(dshHome, lkgRoot)) {
      const entries = fs.readdirSync(lkgRoot).filter((n: string) => {
        try { return fs.statSync(path.join(lkgRoot, n)).isDirectory() } catch { return false }
      }).sort()
      const latest = entries[entries.length - 1]
      const manifestPath = path.join(lkgRoot, latest, 'manifest.json')
      const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      return { ts: latest, files: manifest.files?.length ?? 0, skipped: [] }
    }
  } catch {}

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(lkgRoot, ts)
  fs.mkdirSync(dest, { recursive: true })

  // Copy only the boot configuration (D1). The per-entry filter applies
  // `isLkgExcluded()` at every depth, so a nested `*.log` is left behind too.
  if (fs.existsSync(dshHome)) {
    for (const entry of fs.readdirSync(dshHome)) {
      if (isLkgExcluded(entry)) continue
      const src = path.join(dshHome, entry)
      const dst = path.join(dest, entry)
      fs.cpSync(src, dst, {
        recursive: true,
        filter: (source: string) => !isLkgExcluded(path.relative(dshHome, source)),
      })
    }
  }

  const files = fs.existsSync(dest) ? walkFiles(dest) : []
  const manifest: Manifest = {
    ts,
    files: files
      .filter(f => f !== 'manifest.json')
      .map(f => ({ path: f, sha256: sha256File(path.join(dest, f)) })),
  }
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // Retention: keep only 3 most recent, plus age (7d) and size (5GB) caps — prevents unbounded 40GB+ growth
  await rotateLKG(lkgRoot, 3).catch(() => {})
  await pruneByAge(lkgRoot, 7 * 24 * 60 * 60 * 1000).catch(() => {})
  await pruneBySize(lkgRoot, 5 * 1024 * 1024 * 1024).catch(() => {})

  return { ts, files: manifest.files.length, skipped: [] }
}

export async function pruneByAge(root: string, maxAgeMs: number): Promise<void> {
  if (!fs.existsSync(root)) return
  const now = Date.now()
  const entries = fs.readdirSync(root).filter((n: string) => {
    try { return fs.statSync(path.join(root, n)).isDirectory() } catch { return false }
  })
  for (const name of entries) {
    try {
      const tsStr = name.replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z$/, '$1-$2-$3T$4:$5:$6.$7Z')
      const ts = Date.parse(tsStr)
      if (!isNaN(ts) && now - ts > maxAgeMs) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true })
      }
    } catch {}
  }
}

export async function pruneBySize(root: string, maxBytes: number): Promise<void> {
  if (!fs.existsSync(root)) return
  const entries = fs.readdirSync(root).filter((n: string) => {
    try { return fs.statSync(path.join(root, n)).isDirectory() } catch { return false }
  }).sort()
  let total = 0
  const sizes: Array<{ name: string; size: number }> = []
  for (const name of entries) {
    try {
      const p = path.join(root, name)
      let size = 0
      for (const f of walkFiles(p)) {
        try { size += fs.statSync(path.join(p, f)).size } catch {}
      }
      sizes.push({ name, size })
      total += size
    } catch {}
  }
  for (const { name, size } of sizes) {
    if (total <= maxBytes) break
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
      total -= size
    } catch {}
  }
}

export async function isDuplicateLKG(dshHome: string, lkgRoot: string): Promise<boolean> {
  // Lightweight dedupe: if latest snapshot is <5 minutes old, skip (prevents 5-min unconditional growth)
  // Full hash check is too heavy (would read 500MB+ each tick) and caused status timeouts
  if (!fs.existsSync(lkgRoot)) return false
  const entries = fs.readdirSync(lkgRoot).filter((n: string) => {
    try { return fs.statSync(path.join(lkgRoot, n)).isDirectory() } catch { return false }
  }).sort()
  if (!entries.length) return false
  const latestName = entries[entries.length - 1]
  try {
    const tsStr = latestName.replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z$/, '$1-$2-$3T$4:$5:$6.$7Z')
    const ts = Date.parse(tsStr)
    if (!isNaN(ts) && Date.now() - ts < 5 * 60 * 1000) {
      // If latest is recent and DSH home hasn't changed in mtime, consider duplicate
      // Quick check: compare latest snapshot's mtime vs DSH home's newest file mtime
      const latestPath = path.join(lkgRoot, latestName)
      const latestMtime = fs.statSync(latestPath).mtimeMs
      let newestFileMtime = 0
      if (fs.existsSync(dshHome)) {
        for (const entry of fs.readdirSync(dshHome)) {
          // Same scope as the copy loop: runtime data changes constantly and
          // must not defeat the dedupe for the configuration being snapshotted.
          if (isLkgExcluded(entry)) continue
          try {
            const s = fs.statSync(path.join(dshHome, entry))
            if (s.mtimeMs > newestFileMtime) newestFileMtime = s.mtimeMs
          } catch {}
        }
      }
      if (newestFileMtime > 0 && newestFileMtime < latestMtime) return true
    }
  } catch {}
  return false
}

export async function verifyLKG(lkgPath: string): Promise<boolean> {
  const manifestPath = path.join(lkgPath, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return false
  try {
    const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    for (const entry of manifest.files) {
      const filePath = path.join(lkgPath, entry.path)
      if (!fs.existsSync(filePath)) return false
      const hash = sha256File(filePath)
      if (hash !== entry.sha256) return false
    }
    return true
  } catch {
    return false
  }
}

export async function rotateLKG(lkgRoot: string, keep = 3): Promise<void> {
  if (!fs.existsSync(lkgRoot)) return
  const entries = fs.readdirSync(lkgRoot).filter((n: string) => {
    try { return fs.statSync(path.join(lkgRoot, n)).isDirectory() } catch { return false }
  }).sort()
  const toDelete = entries.slice(0, Math.max(0, entries.length - keep))
  for (const name of toDelete) {
    fs.rmSync(path.join(lkgRoot, name), { recursive: true, force: true })
  }
}

export async function writeFailed(dshHome: string, failedRoot: string): Promise<SnapshotResult> {
  return writeLKG(dshHome, failedRoot)
}
