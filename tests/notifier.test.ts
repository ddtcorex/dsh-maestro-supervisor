import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { notify, notifyAutoRestart } from '../src/host/notifier.js'
import { writePlannedRestart, clearPlannedRestart } from '../src/host/restart-guards.js'

// Isolate marker file to a temp HOME so parallel vitest workers (threads)
// sharing the same real ~/.dsh/.supervisor/ do not race. Each fork has the
// same filesystem, so without isolation the restart-guards.test.ts concurrent
// write/read can be deleted by notifier's clearPlannedRestart mid-assertion.
// os.homedir() on POSIX reads $HOME, so overriding that env isolates the file
// without needing to mock the ESM namespace (which is not configurable).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-notifier-'))
const savedHome = process.env.HOME
const savedUserProfile = process.env.USERPROFILE
beforeAll(() => {
  process.env.HOME = tmpHome
  // Also clear the legacy plain file path that checkPlannedRestart falls back to
  if (process.env.USERPROFILE !== undefined) process.env.USERPROFILE = tmpHome
})
afterAll(() => {
  process.env.HOME = savedHome
  if (savedUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedUserProfile
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
})
afterEach(() => {
  clearPlannedRestart()
})

describe('notifier', () => {
  it('calls notifier and swallows errors', async () => {
    const mock = vi.fn(async () => { throw new Error('telegram down') })
    await expect(notify('test', { send: mock })).resolves.toBeUndefined()
    expect(mock).toHaveBeenCalled()
  })

  it('sends message when notifier succeeds', async () => {
    const mock = vi.fn(async () => {})
    await notify('hello', { send: mock })
    expect(mock).toHaveBeenCalledWith('hello')
  })

  it('auto notify with reason EADDRINUSE should contain 🔄', async () => {
    clearPlannedRestart()
    const sent: string[] = []
    await notifyAutoRestart('health: EADDRINUSE :3080', { send: async (m) => { sent.push(m) } })
    expect(sent.length).toBe(1)
    expect(sent[0]).toMatch(/🔄 dsh web auto-restart — health: EADDRINUSE/)
  })

  it('no notify when planned restart active', async () => {
    writePlannedRestart(30000)
    const sent: string[] = []
    await notifyAutoRestart('health: EADDRINUSE :3080', { send: async (m) => { sent.push(m) } })
    expect(sent.length).toBe(0)
  })
})
