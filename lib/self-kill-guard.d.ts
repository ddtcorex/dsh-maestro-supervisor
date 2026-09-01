/**
 * Self-kill guard for `tools/pre-execute`: deny bash/shell commands that would
 * kill or restart the very dsh web process the agent is running inside. The
 * model must route restarts through the supervisor's dsh_web_restart tool, not
 * by killing the host.
 */
/**
 * Remove data spans (quoted strings and heredoc bodies) from a command before
 * self-kill matching. Text inside quotes or a heredoc is content — an echo,
 * printf, node -e script or cat <<'EOF' body can legitimately discuss kill
 * commands without executing one.
 */
export declare function stripDataSpans(cmd: string): string;
/**
 * The dsh web MainThread owns both ports (3000 = gitlab-webhook, 3080 = web).
 * Only listeners on these ports can be dsh web; every other listening process
 * on the host (mysql, sshd, nginx, redis, ...) is explicitly NOT protected.
 */
export declare const DSH_WEB_PORTS: number[];
export type TreeBoundaryKind = 'none' | 'launcher' | 'service-manager';
/**
 * Boundary classification for the ancestor walk — mirrors
 * `skills/dsh-safe-restart/scripts/restart-dsh-web.sh`'s `resolve_tree()`:
 * the walk stops at `pnpm` (the launcher — everything above it is the
 * launching shell, not dsh web) and never walks into a `systemd --user`
 * manager (it owns every user unit on the box). `launcher` pids stay in the
 * forest; `service-manager` pids are never included.
 */
export declare function treeBoundaryKind(commandLine: string): TreeBoundaryKind;
/** Convenience boolean form of {@link treeBoundaryKind}. */
export declare function isTreeBoundary(commandLine: string): boolean;
export interface ProcessRow {
    pid: number;
    ppid: number;
}
/**
 * Resolve the pids that belong to the dsh web process forest. `listeners` are
 * the pids owning the dsh-web ports (already narrowed by the caller). A pid is
 * protected iff its upward ancestor chain reaches the forest before pid 1:
 *
 *   - the forest roots are the listeners plus every ancestor up to the
 *     `launcher` boundary (pnpm stays inside the forest; systemd --user and
 *     the launching shell stay out);
 *   - the descendant closure then protects the whole owned subtree — the dsh
 *     web node processes AND their bash-tool/browser children — while never
 *     climbing into unrelated ancestors.
 *
 * `boundary(pid)` classifies the command line of a walked pid; it is only
 * invoked for the handful of listener + ancestor pids, never for the full
 * table.
 */
export declare function resolveDshWebTreePids(listeners: number[], rows: ProcessRow[], boundary?: (pid: number) => TreeBoundaryKind): number[];
/**
 * Whether a shell command is a self-kill. `livePids` are the pids of the dsh
 * web process forest; a `kill <pid>` whose pid is one of ours is a self-kill
 * regardless of anything else in the command. The kill parser accepts flag
 * forms (`kill -9 <pid>`, `kill -TERM <pid>`). A command that is essentially
 * JUST a `kill <unrelated-pid>` is allowed (idempotent cleanups are common),
 * as are kill attempts whose output reports "not found"/"done" — but any
 * compound that chains a restart/kill after it (or before the end) stays
 * denied.
 */
export declare function isSelfKillCommand(cmd: string, livePids: number[]): boolean;
/**
 * Live pids of the dsh web OWN forest: pids owning the dsh-web ports
 * (3000/3080) plus their ancestor chain up to the pnpm/systemd boundary and
 * the owned subtree. A kill of an unrelated listener (mysql/sshd/nginx) is
 * therefore allowed — before this scoping the guard denied `kill <pid>` of ANY
 * pid holding a listening socket as a "restart dsh web".
 */
export declare function dshWebTreeLivePids(): number[];
/**
 * Build a `tools/pre-execute` waterfall listener: deny matching
 * bash/shell/exec commands, otherwise delegate to `next()`. Live pids default
 * to the dsh web process forest (see `dshWebTreeLivePids`) so `kill <pid>` of
 * a live host process is caught even when the command names no tool, while a
 * kill of an unrelated service is not.
 */
export declare function makePreExecuteGuard(opts?: {
    livePids?: () => number[];
}): (exec: any, next: () => Promise<any>) => Promise<any>;
