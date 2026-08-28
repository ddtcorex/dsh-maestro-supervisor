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
