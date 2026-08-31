import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
// Regression guard: PR #17 added a "kill stale pid holding :3080/:3000 before
// restart" step (EADDRINUSE recovery), but the original `ss -tlnp` call had no
// port filter — it matched every listening process on the host, so every
// restart also killed unrelated services (redis, php-fpm, horizon, ssh, ...).
// The dsh-web MainThread holds both 3080 and 3000 (see AGENTS.md Known Issues),
// so filtering `ss` itself to those ports is both correct and sufficient.
export function buildKillStalePortsCommand(ports = [3080]) {
    const filter = ports.map(p => `sport = :${p}`).join(' or ');
    return `pids=$(ss -tlnp '( ${filter} )' 2>/dev/null | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | sort -u); if [ -n "$pids" ]; then echo "[supervisor] killing stale pids $pids"; kill $pids 2>/dev/null || true; sleep 2; fi`;
}
// LKG rollback copies each entry with fs.cpSync — an entry that resolves back
// into itself (e.g. a symlink cycle reachable from ~/.dsh, observed in
// production pointing into ~/.npm/_npx/.../node_modules/unist-util-position)
// always throws here. Node's wording for this varies by version ("cannot be
// the same", "subdirectory of itself"/"of self") — match all known phrasings
// so the entry is skipped instead of aborting the whole rollback.
export function isSelfCopyError(message) {
    const lower = message.toLowerCase();
    return lower.includes('cannot be the same') || lower.includes('subdirectory of');
}
// Coordination contract with dsh-safe-web-update's restart-dsh-web.sh (see
// <workspace-root>/docs/specs/2026-08-28-supervisor-planned-restart-design.md):
// that script writes this marker right before it intentionally takes dsh-web
// down, so the supervisor's own health poll does not mistake a deliberate
// restart (kill -> dry-boot -> relaunch, up to ~130s) for a crash and race it
// with its own rollback + restartWeb(). Presence + freshness is authoritative;
// the marker's content is never parsed.
export const PLANNED_RESTART_TTL_MS = 180_000;
export function isPlannedRestartFresh(mtimeMs, nowMs, ttlMs = PLANNED_RESTART_TTL_MS) {
    return nowMs - mtimeMs < ttlMs;
}
export function plannedRestartPath() {
    return path.join(os.homedir(), '.dsh/.supervisor/planned-restart.json');
}
export function writePlannedRestart(ttlMs = 30000) {
    const p = plannedRestartPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ts: Date.now(), ttl: ttlMs }), { mode: 0o600 });
    try {
        fs.chmodSync(p, 0o600);
    }
    catch { }
}
export function checkPlannedRestart(markerPath) {
    // Legacy path explicit: check mtime of that file
    if (markerPath) {
        try {
            const stat = fs.statSync(markerPath);
            return isPlannedRestartFresh(stat.mtimeMs, Date.now());
        }
        catch {
            return false;
        }
    }
    // New JSON marker with {ts, ttl}
    try {
        const raw = fs.readFileSync(plannedRestartPath(), 'utf8');
        const j = JSON.parse(raw);
        if (typeof j.ts === 'number' && typeof j.ttl === 'number') {
            return Date.now() - j.ts < j.ttl;
        }
    }
    catch { }
    // Fallback: legacy plain file written by dsh-safe-web-update (no .json, mtime-based)
    try {
        const legacy = path.join(os.homedir(), '.dsh/.supervisor/planned-restart');
        const stat = fs.statSync(legacy);
        return isPlannedRestartFresh(stat.mtimeMs, Date.now());
    }
    catch { }
    return false;
}
export function clearPlannedRestart() {
    try {
        fs.unlinkSync(plannedRestartPath());
    }
    catch { }
    // also clear legacy plain file if present (best-effort, avoids stale suppression)
    try {
        const legacy = path.join(os.homedir(), '.dsh/.supervisor/planned-restart');
        if (fs.existsSync(legacy) && legacy !== plannedRestartPath()) {
            // only remove legacy if it was created as test artifact; keep conservative
            // but clearing both ensures checkPlannedRestart() returns false after clear
            try {
                fs.unlinkSync(legacy);
            }
            catch { }
        }
    }
    catch { }
}
export function writeRestartRequest(caller, ttlMs = 180_000) {
    const p = plannedRestartPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const body = { ts: Date.now(), ttl: ttlMs, ...caller };
    fs.writeFileSync(p, JSON.stringify(body), { mode: 0o600 });
    try {
        fs.chmodSync(p, 0o600);
    }
    catch { }
}
export function readRestartRequest() {
    try {
        const raw = fs.readFileSync(plannedRestartPath(), 'utf8');
        const j = JSON.parse(raw);
        if (typeof j.ts === 'number' && typeof j.ttl === 'number') {
            if (Date.now() - j.ts >= j.ttl)
                return undefined;
            return { ts: j.ts, ttl: j.ttl, callerSessionId: j.callerSessionId, reason: j.reason };
        }
    }
    catch { }
    return undefined;
}
