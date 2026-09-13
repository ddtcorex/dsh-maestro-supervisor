import { describe, it, expect, vi } from 'vitest'
import { acquireBootLock, withBootLock } from '../src/host/boot-lock.js'

function fakeFs() {
  const files = new Map<string, string>()
  return {
    files,
    deps: {
      lockPath: '/tmp/dsh-boot.lock',
      createExclusive: (p: string, body: string) => { if (files.has(p)) return false; files.set(p, body); return true },
      readLock: (p: string) => files.get(p),
      remove: (p: string) => { files.delete(p) },
    },
  }
}

describe('acquireBootLock', () => {
  it('takes the lock once and refuses a second request while the owner is alive', () => {
    const { deps, files } = fakeFs()
    const first = acquireBootLock({ ...deps, pidAlive: () => true, now: () => 1_000, staleMs: 180_000 })
    expect(first).toBeDefined()
    const second = acquireBootLock({ ...deps, pidAlive: () => true, now: () => 1_000, staleMs: 180_000 })
    expect(second).toBeUndefined()
    first!.release()
    expect(files.size).toBe(0)
  })

  it('takes over the lock when the recorded owner is gone', () => {
    const { deps, files } = fakeFs()
    files.set(deps.lockPath, JSON.stringify({ pid: 999_999, ts: 1_000 }))
    const lock = acquireBootLock({ ...deps, pidAlive: () => false, now: () => 2_000, staleMs: 180_000 })
    expect(lock).toBeDefined()
    expect(JSON.parse(files.get(deps.lockPath)!)).toEqual({ pid: process.pid, ts: 2_000 })
  })

  it('takes over a lock older than the boot budget', () => {
    const { deps, files } = fakeFs()
    files.set(deps.lockPath, JSON.stringify({ pid: 4242, ts: 1_000 }))
    const lock = acquireBootLock({ ...deps, pidAlive: () => true, now: () => 200_000, staleMs: 180_000 })
    expect(lock).toBeDefined()
  })

  it('takes over an unreadable lock file instead of deadlocking forever', () => {
    const { deps, files } = fakeFs()
    files.set(deps.lockPath, 'not json')
    const lock = acquireBootLock({ ...deps, pidAlive: () => true, now: () => 2_000, staleMs: 180_000 })
    expect(lock).toBeDefined()
  })
})

describe('withBootLock', () => {
  it('does not run the work when another boot holds the lock', async () => {
    const { deps } = fakeFs()
    const held = acquireBootLock({ ...deps, pidAlive: () => true, now: () => 1_000, staleMs: 180_000 })
    const fn = vi.fn(async () => 'ran')
    const res = await withBootLock(fn, { ...deps, pidAlive: () => true, now: () => 1_000, staleMs: 180_000 })
    expect(res).toEqual({ acquired: false })
    expect(fn).not.toHaveBeenCalled()
    held!.release()
  })

  it('holds the lock until the port answers, then releases it', async () => {
    const { deps, files } = fakeFs()
    const seen: string[] = []
    const res = await withBootLock(async () => {
      seen.push('work')
      expect(files.size).toBe(1)
      return 'done'
    }, {
      ...deps,
      pidAlive: () => true,
      now: () => 1_000,
      staleMs: 180_000,
      portUp: async () => { seen.push('probe'); return seen.filter(s => s === 'probe').length >= 2 },
      waitTimeoutMs: 10_000,
      pollMs: 1_000,
      sleep: async () => {},
    })
    expect(res).toEqual({ acquired: true, value: 'done' })
    expect(seen).toEqual(['work', 'probe', 'probe'])
    expect(files.size).toBe(0)
  })

  it('gives up waiting when the boot budget expires and still releases the lock', async () => {
    const { deps, files } = fakeFs()
    let now = 0
    const res = await withBootLock(async () => 'done', {
      ...deps,
      pidAlive: () => true,
      now: () => now,
      staleMs: 180_000,
      portUp: async () => false,
      waitTimeoutMs: 3_000,
      pollMs: 1_000,
      sleep: async (ms: number) => { now += ms },
    })
    expect(res.acquired).toBe(true)
    expect(files.size).toBe(0)
  })
})
