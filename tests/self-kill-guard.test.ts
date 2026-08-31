import { describe, it, expect } from 'vitest'
import { isSelfKillCommand, makePreExecuteGuard, resolveDshWebTreePids, treeBoundaryKind, DSH_WEB_PORTS } from '../src/host/self-kill-guard.js'

// Process-tree fixture mirroring a pnpm-launched dsh web:
//   1 (init) → 100 (systemd --user) → 200 (pnpm launcher) → 300 (dsh-web
//   MainThread, holds :3080/:3000) → children 301 (bash tool) / 302 (browser).
//   Unrelated listeners: 400 (mysqld, :3306) / 401 (worker) / 500 (sshd, :22).
const FAKE_TREE = [
  { pid: 1, ppid: 0 },
  { pid: 100, ppid: 1 },
  { pid: 200, ppid: 100 },
  { pid: 300, ppid: 200 },
  { pid: 301, ppid: 300 },
  { pid: 302, ppid: 300 },
  { pid: 400, ppid: 100 },
  { pid: 401, ppid: 400 },
  { pid: 500, ppid: 1 },
]
const FAKE_ARGS: Record<number, string> = {
  100: 'systemd --user',
  200: 'node /usr/lib/node_modules/pnpm/bin/pnpm.cjs dsh web --no-open',
  300: 'node /home/acme/harness/apps/cli/dist/bin.js',
  400: 'mysqld',
  500: '/usr/sbin/sshd',
}
const fakeBoundary = (pid: number) => treeBoundaryKind(FAKE_ARGS[pid] ?? '')

describe('isSelfKillCommand', () => {
  it('denies systemctl/systemd restarts of dsh-web and pkill/kill patterns', () => {
    expect(isSelfKillCommand('systemctl --user restart dsh-web.service', [])).toBe(true)
    expect(isSelfKillCommand('systemctl --user restart dsh-web', [])).toBe(true)
    expect(isSelfKillCommand('pkill -f "dsh web"', [])).toBe(true)
    expect(isSelfKillCommand('killall dsh', [])).toBe(true)
    expect(isSelfKillCommand('kill 848894', [848894])).toBe(true) // own pid
    expect(isSelfKillCommand('ss -tlnp | grep 3080 | xargs kill', [])).toBe(true)
    expect(isSelfKillCommand('pnpm build', [])).toBe(false)
    expect(isSelfKillCommand('kill 1234', [848894])).toBe(false) // unrelated pid
  })

  it('denies compound commands that start with an unrelated kill (no bypass via prefix)', () => {
    // The `kill <unrelated>` allow-list must only apply when the command is
    // essentially JUST a kill — a compound that chains a restart/pkill must
    // still be denied.
    expect(isSelfKillCommand('kill 1234 && systemctl --user restart dsh-web', [848894])).toBe(true)
    expect(isSelfKillCommand('kill 1234 && pkill -f "dsh web"', [848894])).toBe(true)
    expect(isSelfKillCommand('kill 1234; sleep 1; killall dsh', [848894])).toBe(true)
    expect(isSelfKillCommand('kill -9 1234 && systemctl --user restart dsh-web', [848894])).toBe(true)
  })

  it('handles kill flag forms: own pid denied, unrelated pid allowed', () => {
    expect(isSelfKillCommand('kill -9 848894', [848894])).toBe(true) // own pid w/ flag
    expect(isSelfKillCommand('kill -TERM 848894', [848894])).toBe(true)
    expect(isSelfKillCommand('kill -9 1234', [848894])).toBe(false) // unrelated w/ flag
    expect(isSelfKillCommand('kill -TERM 1234', [848894])).toBe(false)
  })
})

describe('treeBoundaryKind', () => {
  it('classifies the pnpm launcher and the systemd --user manager distinctly', () => {
    expect(treeBoundaryKind('node .../pnpm dsh web')).toBe('launcher')
    expect(treeBoundaryKind('systemd --user')).toBe('service-manager')
    expect(treeBoundaryKind('node /usr/bin/pnpm.cjs run x')).toBe('launcher')
    expect(treeBoundaryKind('mysqld')).toBe('none')
    expect(treeBoundaryKind('node apps/cli/dist/bin.js')).toBe('none')
  })
})

describe('resolveDshWebTreePids', () => {
  it('protects the dsh-web listeners + their launcher chain and descendants, never unrelated services', () => {
    const pids = resolveDshWebTreePids([300], FAKE_TREE, fakeBoundary)
    // actual dsh web processes: MainThread, its pnpm launcher, bash-tool + browser children
    expect(pids).toContain(300)
    expect(pids).toContain(200)
    expect(pids).toContain(301)
    expect(pids).toContain(302)
    // never climbs into the service manager and never swallows unrelated listeners
    expect(pids).not.toContain(100)
    expect(pids).not.toContain(400)
    expect(pids).not.toContain(500)
  })

  it('returns an empty set when no dsh-web port listener exists', () => {
    expect(resolveDshWebTreePids([], FAKE_TREE, fakeBoundary)).toEqual([])
  })

  it('protects an unrelated listener only for its own subtree, never the manager or unrelated services', () => {
    // A hypothetical non-dsh listener (mysqld on :3306) is scoped to itself and
    // its worker — it never climbs into systemd --user or swallows sshd/init.
    const pids = resolveDshWebTreePids([400], FAKE_TREE, fakeBoundary)
    expect(pids).toEqual([400, 401])
    expect(pids).not.toContain(100)
    expect(pids).not.toContain(500)
  })

  it('falls back to the listener-only subtree when boundary data is unusable (walk stops at the listener)', () => {
    // Without any boundary info the resolver must still refuse to over-include:
    // it protects the listener and its descendants but never ancestors.
    const pids = resolveDshWebTreePids([300], FAKE_TREE, () => 'launcher')
    expect(pids).toEqual([300, 301, 302])
  })
})

describe('makePreExecuteGuard', () => {
  const allow = async () => ({ kind: 'allow' })

  it('denies kill of a pid inside the resolved dsh-web tree (MainThread)', async () => {
    const live = resolveDshWebTreePids([300], FAKE_TREE, fakeBoundary)
    const guard = makePreExecuteGuard({ livePids: () => live })
    const res = await guard({ name: 'bash', args: { command: 'kill 300' } }, allow)
    expect(res).toEqual({ kind: 'deny', reason: expect.stringContaining('dsh_web_restart') })
  })

  it('allows kill of an unrelated listener pid that is not in the dsh-web tree (mysql/sshd/nginx)', async () => {
    const live = resolveDshWebTreePids([300], FAKE_TREE, fakeBoundary)
    const guard = makePreExecuteGuard({ livePids: () => live })
    // mysqld (400) and sshd (500) both hold listening ports but are NOT dsh web
    expect(await guard({ name: 'bash', args: { command: 'kill 400' } }, allow)).toEqual({ kind: 'allow' })
    expect(await guard({ name: 'bash', args: { command: 'kill -9 500' } }, allow)).toEqual({ kind: 'allow' })
    expect(await guard({ name: 'bash', args: { command: 'kill 11111' } }, allow)).toEqual({ kind: 'allow' })
  })

  it('tracks only the dsh-web ports as listeners (3000/3080)', () => {
    expect(DSH_WEB_PORTS).toContain(3000)
    expect(DSH_WEB_PORTS).toContain(3080)
  })

  it('denies a bash self-kill and allows benign commands', async () => {
    const guard = makePreExecuteGuard({ livePids: () => [848894] })
    const exec = { name: 'bash', args: { command: 'systemctl --user restart dsh-web' } }
    expect(await guard(exec, async () => ({ kind: 'allow' }))).toEqual({ kind: 'deny', reason: expect.stringContaining('dsh_web_restart') })
    const benign = await guard({ name: 'bash', args: { command: 'ls -la' } }, async () => ({ kind: 'allow' }))
    expect(benign).toEqual({ kind: 'allow' })
  })

  it('reads the command from the dsh-tools ToolExecution shape (arguments.command)', async () => {
    const guard = makePreExecuteGuard({ livePids: () => [848894] })
    const exec = { name: 'bash', arguments: { command: 'systemctl --user stop dsh-web' } }
    expect(await guard(exec, async () => ({ kind: 'allow' }))).toEqual({ kind: 'deny', reason: expect.stringContaining('dsh_web_restart') })
  })

  it('passes through non-bash tools', async () => {
    const guard = makePreExecuteGuard({ livePids: () => [848894] })
    const exec = { name: 'maestro_jobs_search', args: { query: 'react' } }
    expect(await guard(exec, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
  })

  it('denies a compound command whose prefix is an unrelated kill', async () => {
    const guard = makePreExecuteGuard({ livePids: () => [848894] })
    const exec = { name: 'bash', args: { command: 'kill 1234 && systemctl --user restart dsh-web' } }
    expect(await guard(exec, async () => ({ kind: 'allow' }))).toEqual({ kind: 'deny', reason: expect.stringContaining('dsh_web_restart') })
  })

  it('denies a kill -9 of the live pid and allows kill -9 of an unrelated pid', async () => {
    const guard = makePreExecuteGuard({ livePids: () => [848894] })
    const own = { name: 'bash', args: { command: 'kill -9 848894' } }
    expect(await guard(own, async () => ({ kind: 'allow' }))).toEqual({ kind: 'deny', reason: expect.stringContaining('dsh_web_restart') })
    const unrelated = { name: 'bash', args: { command: 'kill -9 1234' } }
    expect(await guard(unrelated, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
  })
})