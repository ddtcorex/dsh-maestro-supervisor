/**
 * Self-kill guard for `tools/pre-execute`: deny bash/shell commands that would
 * kill or restart the very dsh web process the agent is running inside. The
 * model must route restarts through the supervisor's dsh_web_restart tool, not
 * by killing the host.
 */
/**
 * Whether a shell command is a self-kill. `livePids` are the pids currently
 * holding listening sockets; a `kill <pid>` whose pid is one of ours is a
 * self-kill regardless of anything else in the command. The kill parser accepts
 * flag forms (`kill -9 <pid>`, `kill -TERM <pid>`). A command that is
 * essentially JUST a `kill <unrelated-pid>` is allowed (idempotent cleanups
 * are common), as are kill attempts whose output reports "not found"/"done" —
 * but any compound that chains a restart/kill after it (or before the end)
 * stays denied.
 */
export declare function isSelfKillCommand(cmd: string, livePids: number[]): boolean;
/**
 * Build a `tools/pre-execute` waterfall listener: deny matching
 * bash/shell/exec commands, otherwise delegate to `next()`. Live pids default
 * to the pids holding listening sockets (`ss -tlnp`) so `kill <pid>` of a
 * live host process is caught even when the command names no tool.
 */
export declare function makePreExecuteGuard(opts?: {
    livePids?: () => number[];
}): (exec: any, next: () => Promise<any>) => Promise<any>;
