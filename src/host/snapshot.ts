import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

interface ManifestEntry { path: string; sha256: string }
interface Manifest { ts: string; files: ManifestEntry[] }

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

export async function writeLKG(dshHome: string, lkgRoot: string): Promise<{ ts: string; manifest: Manifest }> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(lkgRoot, ts)
  fs.mkdirSync(dest, { recursive: true })

  // Copy DSH home contents (if exists, copy recursively)
  if (fs.existsSync(dshHome)) {
    // Use cpSync if available
    for (const entry of fs.readdirSync(dshHome)) {
      const src = path.join(dshHome, entry)
      const dst = path.join(dest, entry)
      fs.cpSync(src, dst, { recursive: true })
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
  return { ts, manifest }
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

export async function writeFailed(dshHome: string, failedRoot: string): Promise<{ ts: string; manifest: Manifest }> {
  return writeLKG(dshHome, failedRoot)
}
