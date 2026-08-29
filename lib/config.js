import { load, readFlat } from '@ddtcorex/dsh-maestro-config-lib';
export async function readSupervisorConfig() {
    try {
        const doc = await load();
        if (doc?.domains?.supervisor && typeof doc.domains.supervisor === 'object' && !Array.isArray(doc.domains.supervisor)) {
            return doc.domains.supervisor;
        }
    }
    catch { }
    try {
        const f = await readFlat().catch(() => ({}));
        if (f?.supervisor && typeof f.supervisor === 'object' && !Array.isArray(f.supervisor)) {
            return f.supervisor;
        }
    }
    catch { }
    return {};
}
