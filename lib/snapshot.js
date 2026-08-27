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
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(lkgRoot, ts);
    fs.mkdirSync(dest, { recursive: true });
    // Copy DSH home contents (if exists, copy recursively)
    if (fs.existsSync(dshHome)) {
        // Use cpSync if available
        for (const entry of fs.readdirSync(dshHome)) {
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
    return { ts, manifest };
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
