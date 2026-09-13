import { describe, it, expect } from 'vitest'
import { performSingleBootRestart } from '../src/host/restart-web.js'

function harness(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  const deps: any = {
    bootGraceMs: 180_000,
    writeMarker: (ttl?: number) => { calls.push(`marker:${ttl}`) },
    exec: (cmd: string) => { calls.push(`exec:${cmd}`) },
    serializedRestart: async () => { calls.push('systemd:serialized') },
    startViaSystemd: () => { calls.push('systemd:start') },
    spawnNohup: () => { calls.push('nohup') },
    unitExists: () => true,
    lock: {
      lockPath: '/tmp/dsh-boot-lock-test',
      createExclusive: () => true,
      readLock: () => undefined,
      remove: () => {},
      portUp: async () => true,
      now: () => 1,
      waitTimeoutMs: 0,
    },
    ...over,
  }
  return { deps, calls }
}

describe('performSingleBootRestart', () => {
  it('marks the boot budget, then starts exactly once through systemd', async () => {
    const { deps, calls } = harness()
    const res = await performSingleBootRestart(deps)
    expect(res).toEqual({ restarted: true })
    expect(calls[0]).toBe('marker:180000')
    expect(calls.filter(c => c.startsWith('systemd:'))).toHaveLength(1)
    expect(calls).not.toContain('nohup')
  })

  it('never falls back to nohup while the systemd unit exists', async () => {
    const { deps, calls } = harness({
      serializedRestart: async () => { throw new Error('start refused') },
      startViaSystemd: () => { throw new Error('start refused') },
    })
    await expect(performSingleBootRestart(deps)).rejects.toThrow(/refusing the direct-node fallback/)
    expect(calls).not.toContain('nohup')
  })

  it('uses the nohup fallback only on a host without the unit', async () => {
    const { deps, calls } = harness({
      serializedRestart: async () => { throw new Error('unit not found') },
      startViaSystemd: () => { throw new Error('unit not found') },
      unitExists: () => false,
    })
    await expect(performSingleBootRestart(deps)).resolves.toEqual({ restarted: true })
    expect(calls).toContain('nohup')
  })

  it('skips the whole restart — marker included — when another boot holds the lock', async () => {
    const { deps, calls } = harness({
      lock: {
        lockPath: '/tmp/dsh-boot-lock-test',
        createExclusive: () => false,
        readLock: () => JSON.stringify({ pid: 4242, ts: 0 }),
        pidAlive: () => true,
        remove: () => {},
        now: () => 1,
        portUp: async () => true,
        waitTimeoutMs: 0,
      },
    })
    const res = await performSingleBootRestart(deps)
    expect(res.restarted).toBe(false)
    expect(res.reason).toContain('boot.lock')
    expect(calls).toEqual([])
  })
})
