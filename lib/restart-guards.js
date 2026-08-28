// Regression guard: PR #17 added a "kill stale pid holding :3080/:3000 before
// restart" step (EADDRINUSE recovery), but the original `ss -tlnp` call had no
// port filter — it matched every listening process on the host, so every
// restart also killed unrelated services (redis, php-fpm, horizon, ssh, ...).
// The dsh-web MainThread holds both 3080 and 3000 (see AGENTS.md Known Issues),
// so filtering `ss` itself to those ports is both correct and sufficient.
export function buildKillStalePortsCommand(ports = [3080, 3000]) {
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
export async function checkPlannedRestart(markerPath) {
    try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const os = await import('node:os');
        const p = markerPath ?? path.join(os.homedir(), '.dsh/.supervisor/planned-restart');
        const stat = fs.statSync(p);
        return isPlannedRestartFresh(stat.mtimeMs, Date.now());
    }
    catch {
        return false;
    }
}
