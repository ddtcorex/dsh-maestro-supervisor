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
 * self-kill regardless of anything else in the command. The kill parser accepts
 * flag forms (`kill -9 <pid>`, `kill -TERM <pid>`). A command that is
 * essentially JUST a `kill <unrelated-pid>` is allowed (idempotent cleanups
 * are common), as are kill attempts whose output reports "not found"/"done" —
 * but any compound that chains a restart/kill after it (or before the end)
 * stays denied.
 */
export function isSelfKillCommand(cmd, livePids) {
    if (/kill\s+(?:-\S+\s+)?(\d+)/i.test(cmd)) {
        const pid = Number(cmd.match(/kill\s+(?:-\S+\s+)?(\d+)/i)?.[1]);
        if (livePids.includes(pid))
            return true;
    }
    return SELF_KILL_RE.test(cmd)
        // Exclude only a command that is JUST `kill [flags] <unrelated pid>` —
        // anchored end-to-end so `kill 1234 && systemctl restart dsh-web` cannot
        // whitelist the compound through its prefix.
        && !/^kill\s+(?:-\S+\s+)?\d+\s*$/i.test(cmd.trim())
        && !/kill\s+(?:-\S+\s+)?(\d+)\s+.*(not found|done)/i.test(cmd);
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
