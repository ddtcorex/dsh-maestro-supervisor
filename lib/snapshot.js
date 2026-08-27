import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
function sha256File(filePath) {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
}
function walkFiles(dir, base = dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
            out.push(...walkFiles(full, base));
        else if (entry.isFile())
            out.push(path.relative(base, full));
    }
    return out;
}
export async function writeLKG(dshHome, lkgRoot) {
    // Dedupe: skip snapshot if current state identical to latest LKG (prevents 5-min unconditional growth)
    try {
        if (await isDuplicateLKG(dshHome, lkgRoot)) {
            const entries = fs.readdirSync(lkgRoot).filter((n) => {
                try {
                    return fs.statSync(path.join(lkgRoot, n)).isDirectory();
                }
                catch {
                    return false;
                }
            }).sort();
            const latest = entries[entries.length - 1];
            const manifestPath = path.join(lkgRoot, latest, 'manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            return { ts: latest, manifest };
        }
    }
    catch { }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(lkgRoot, ts);
    fs.mkdirSync(dest, { recursive: true });
    // Copy DSH home contents (if exists, copy recursively) — skip .supervisor to avoid recursion
    if (fs.existsSync(dshHome)) {
        for (const entry of fs.readdirSync(dshHome)) {
            if (entry === '.supervisor')
                continue;
            const src = path.join(dshHome, entry);
            const dst = path.join(dest, entry);
            fs.cpSync(src, dst, { recursive: true });
        }
    }
    const files = fs.existsSync(dest) ? walkFiles(dest) : [];
    const manifest = {
        ts,
        files: files
            .filter(f => f !== 'manifest.json')
            .map(f => ({ path: f, sha256: sha256File(path.join(dest, f)) })),
    };
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
    // Retention: keep only 3 most recent, plus age (7d) and size (5GB) caps — prevents unbounded 40GB+ growth
    await rotateLKG(lkgRoot, 3).catch(() => { });
    await pruneByAge(lkgRoot, 7 * 24 * 60 * 60 * 1000).catch(() => { });
    await pruneBySize(lkgRoot, 5 * 1024 * 1024 * 1024).catch(() => { });
    return { ts, manifest };
}
export async function pruneByAge(root, maxAgeMs) {
    if (!fs.existsSync(root))
        return;
    const now = Date.now();
    const entries = fs.readdirSync(root).filter((n) => {
        try {
            return fs.statSync(path.join(root, n)).isDirectory();
        }
        catch {
            return false;
        }
    });
    for (const name of entries) {
        try {
            const tsStr = name.replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z$/, '$1-$2-$3T$4:$5:$6.$7Z');
            const ts = Date.parse(tsStr);
            if (!isNaN(ts) && now - ts > maxAgeMs) {
                fs.rmSync(path.join(root, name), { recursive: true, force: true });
            }
        }
        catch { }
    }
}
export async function pruneBySize(root, maxBytes) {
    if (!fs.existsSync(root))
        return;
    const entries = fs.readdirSync(root).filter((n) => {
        try {
            return fs.statSync(path.join(root, n)).isDirectory();
        }
        catch {
            return false;
        }
    }).sort();
    let total = 0;
    const sizes = [];
    for (const name of entries) {
        try {
            const p = path.join(root, name);
            let size = 0;
            for (const f of walkFiles(p)) {
                try {
                    size += fs.statSync(path.join(p, f)).size;
                }
                catch { }
            }
            sizes.push({ name, size });
            total += size;
        }
        catch { }
    }
    for (const { name, size } of sizes) {
        if (total <= maxBytes)
            break;
        try {
            fs.rmSync(path.join(root, name), { recursive: true, force: true });
            total -= size;
        }
        catch { }
    }
}
export async function isDuplicateLKG(dshHome, lkgRoot) {
    // Lightweight dedupe: if latest snapshot is <5 minutes old, skip (prevents 5-min unconditional growth)
    // Full hash check is too heavy (would read 500MB+ each tick) and caused status timeouts
    if (!fs.existsSync(lkgRoot))
        return false;
    const entries = fs.readdirSync(lkgRoot).filter((n) => {
        try {
            return fs.statSync(path.join(lkgRoot, n)).isDirectory();
        }
        catch {
            return false;
        }
    }).sort();
    if (!entries.length)
        return false;
    const latestName = entries[entries.length - 1];
    try {
        const tsStr = latestName.replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z$/, '$1-$2-$3T$4:$5:$6.$7Z');
        const ts = Date.parse(tsStr);
        if (!isNaN(ts) && Date.now() - ts < 5 * 60 * 1000) {
            // If latest is recent and DSH home hasn't changed in mtime, consider duplicate
            // Quick check: compare latest snapshot's mtime vs DSH home's newest file mtime
            const latestPath = path.join(lkgRoot, latestName);
            const latestMtime = fs.statSync(latestPath).mtimeMs;
            let newestFileMtime = 0;
            if (fs.existsSync(dshHome)) {
                for (const entry of fs.readdirSync(dshHome)) {
                    if (entry === '.supervisor')
                        continue;
                    try {
                        const s = fs.statSync(path.join(dshHome, entry));
                        if (s.mtimeMs > newestFileMtime)
                            newestFileMtime = s.mtimeMs;
                    }
                    catch { }
                }
            }
            if (newestFileMtime > 0 && newestFileMtime < latestMtime)
                return true;
        }
    }
    catch { }
    return false;
}
export async function verifyLKG(lkgPath) {
    const manifestPath = path.join(lkgPath, 'manifest.json');
    if (!fs.existsSync(manifestPath))
        return false;
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        for (const entry of manifest.files) {
            const filePath = path.join(lkgPath, entry.path);
            if (!fs.existsSync(filePath))
                return false;
            const hash = sha256File(filePath);
            if (hash !== entry.sha256)
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
export async function rotateLKG(lkgRoot, keep = 3) {
    if (!fs.existsSync(lkgRoot))
        return;
    const entries = fs.readdirSync(lkgRoot).filter((n) => {
        try {
            return fs.statSync(path.join(lkgRoot, n)).isDirectory();
        }
        catch {
            return false;
        }
    }).sort();
    const toDelete = entries.slice(0, Math.max(0, entries.length - keep));
    for (const name of toDelete) {
        fs.rmSync(path.join(lkgRoot, name), { recursive: true, force: true });
    }
}
export async function writeFailed(dshHome, failedRoot) {
    return writeLKG(dshHome, failedRoot);
}
