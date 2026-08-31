import { describe, it, expect } from 'vitest'
import { isSelfKillCommand, makePreExecuteGuard } from '../src/host/self-kill-guard.js'

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

describe('makePreExecuteGuard', () => {
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