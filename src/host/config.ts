import { load, readFlat } from '@ddtcorex/dsh-maestro-config-lib'

export async function readSupervisorConfig(): Promise<Record<string, any>> {
  try {
    const doc: any = await load()
    if (doc?.domains?.supervisor && typeof doc.domains.supervisor === 'object' && !Array.isArray(doc.domains.supervisor)) {
      return doc.domains.supervisor as Record<string, any>
    }
  } catch {}
  try {
    const f: any = await readFlat().catch(() => ({}))
    if (f?.supervisor && typeof f.supervisor === 'object' && !Array.isArray(f.supervisor)) {
      return f.supervisor as Record<string, any>
    }
  } catch {}
  return {}
}
