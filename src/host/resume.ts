import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export interface ResumeResult {
  scanned: number
  interrupted: string[]
}

export async function findInterrupted(dshHome?: string): Promise<ResumeResult> {
  const home = dshHome ?? path.join(os.homedir(), '.dsh')
  const sessionsRoot = path.join(home, 'sessions')
  let scanned = 0
  const interrupted: string[] = []
  try {
    const groups = fs.readdirSync(sessionsRoot, { withFileTypes: true })
    for (const g of groups) {
      if (!g.isDirectory()) continue
      const groupPath = path.join(sessionsRoot, g.name)
      const sessions = fs.readdirSync(groupPath, { withFileTypes: true })
      for (const s of sessions) {
        if (!s.isDirectory()) continue
        scanned++
        const zstdPath = path.join(groupPath, s.name, 'session.jsonl.zstd')
        const jsonlPath = path.join(groupPath, s.name, 'session.jsonl')
        try {
          let content = ''
          if (fs.existsSync(zstdPath)) {
            const { execSync } = await import('node:child_process')
            content = execSync(`zstd -d -c ${JSON.stringify(zstdPath)} 2>/dev/null | tail -5`, { encoding: 'utf-8' })
          } else if (fs.existsSync(jsonlPath)) {
            content = fs.readFileSync(jsonlPath, 'utf-8').slice(-5000)
          }
          if (content.toLowerCase().includes('interrupted')) {
            interrupted.push(`${g.name}/${s.name}`)
          }
        } catch {}
      }
    }
  } catch {}
  return { scanned, interrupted }
}
