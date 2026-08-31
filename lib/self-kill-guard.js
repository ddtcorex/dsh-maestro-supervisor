/**
 * Self-kill guard for `tools/pre-execute`: deny bash/shell commands that would
 * kill or restart the very dsh web process the agent is running inside. The
 * model must route restarts through the supervisor's dsh_web_restart tool, not
 * by killing the host.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Patterns that restart/stop/start or kill dsh web (systemctl --user units,
// pkill/killall over the dsh tree, killing holders of :3080, and the
// dsh-safe-web-update helper itself). The bare `kill\s+` alternative is
// narrowed below so a kill of an unrelated pid is not denied as a self-kill.
const SELF_KILL_RE = /(systemctl\s+--?user\s+.*(restart|stop|start).*dsh-web|pkill\s+.*dsh|killall\s+.*dsh|ss\s+.*3080.*kill|restart-dsh-web|kill\s+)/i;
/**
 * Whether a shell command is a self-kill. `livePids` are the pids currently
 * holding listening sockets; a `kill <pid>` whose pid is one of ours is a
 * self-kill regardless of anything else in the command. A bare `kill <pid>`
 * against an unrelated pid is allowed (idempotent cleanups are common), as
 * are kill attempts whose output reports "not found"/"done".
 */
export function isSelfKillCommand(cmd, livePids) {
    if (/kill\s+(\d+)/i.test(cmd)) {
        const pid = Number(cmd.match(/kill\s+(\d+)/i)?.[1]);
        if (livePids.includes(pid))
            return true;
    }
    return SELF_KILL_RE.test(cmd)
        // A command that is exactly `kill <unrelated pid>` (or starts with one)
        // is not a self-kill — the pid check above already covered our own pids.
        && !/^kill\s+\d+\b/i.test(cmd.trim())
        && !/kill\s+(\d+)\s+.*(not found|done)/i.test(cmd);
}
/**
 * Build a `tools/pre-execute` waterfall listener: deny matching
 * bash/shell/exec commands, otherwise delegate to `next()`. Live pids default
 * to the pids holding listening sockets (`ss -tlnp`) so `kill <pid>` of a
 * live host process is caught even when the command names no tool.
 */
export function makePreExecuteGuard(opts = {}) {
    const livePids = opts.livePids ?? (() => {
        try {
            const { execSync } = require('node:child_process');
            const out = execSync(`ss -tlnp 2>/dev/null | grep -oP 'pid=\\K[0-9]+' | sort -u`, { encoding: 'utf8' });
            return out.trim().split('\n').filter(Boolean).map(Number);
        }
        catch {
            return [];
        }
    });
    return async (exec, next) => {
        // dsh-tools hands the frozen ToolExecution (name + arguments); the guard
        // also accepts the `args` shape for tests/embedded hosts.
        const cmd = String(exec?.args?.command ?? exec?.args?.input ?? exec?.arguments?.command ?? exec?.arguments?.input ?? '');
        if ((exec?.name === 'bash' || exec?.name === 'shell' || exec?.name === 'exec') && isSelfKillCommand(cmd, livePids())) {
            return { kind: 'deny', reason: 'DENIED — this command restarts the dsh web process you are running inside. Use the dsh_web_restart tool (supervisor) for a safe restart.' };
        }
        return next();
    };
}
