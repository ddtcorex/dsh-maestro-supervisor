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
})