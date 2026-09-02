import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { parseLaunchTarget, mintDshSessionCookie } from '../src/host/dsh-session.js'
import { resumeViaRpc, resumeViaRpcWithSession } from '../src/host/supervisor.js'

describe('dsh session cookie for the resume RPC', () => {
  it('parseLaunchTarget reads the newest boot line port + token', () => {
    const target = parseLaunchTarget(
      'old: dsh web: http://127.0.0.1:3080/?token=oldtok\nnew: dsh web: http://127.0.0.1:3082/?token=newtok\n',
    )
    expect(target).toEqual({ port: 3082, token: 'newtok' })
  })

  it('parseLaunchTarget returns undefined when no boot line exists', () => {
    expect(parseLaunchTarget('nothing here')).toBeUndefined()
  })

  it('mints the dsh-auth cookie by trading the launch token (303 + set-cookie)', async () => {
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:3082/?token=newtok')
      expect(init.redirect).toBe('manual')
      return new Response('', {
        status: 303,
        headers: { 'set-cookie': 'dsh-auth-127.0.0.1:3082=abc123; Path=/; HttpOnly; SameSite=Lax' },
      })
    })
    const cookie = await mintDshSessionCookie(fetchFn, {
      readFileImpl: async () => 'dsh web: http://127.0.0.1:3082/?token=newtok\n',
    })
    expect(cookie).toBe('dsh-auth-127.0.0.1:3082=abc123')
  })

  it('mint returns undefined when the token trade does not mint a cookie', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 401 }))
    const cookie = await mintDshSessionCookie(fetchFn, {
      readFileImpl: async () => 'dsh web: http://127.0.0.1:3082/?token=newtok\n',
    })
    expect(cookie).toBeUndefined()
  })

  it('resumeViaRpc attaches an extra Cookie header when provided', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify({
        type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { resumed: ['proj/session-a'] } },
      }), { status: 200 })
    })
    await expect(resumeViaRpc(['proj/session-a'], fetch, { cookie: 'dsh-auth-x=y' })).resolves
      .toEqual({ resumed: ['proj/session-a'] })
    expect(fetch.mock.calls[0]![1].headers).toEqual({ 'content-type': 'application/json', cookie: 'dsh-auth-x=y' })
  })

  it('resumeViaRpcWithSession mints then resumes through the RPC with the cookie', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-sess-'))
    const log = join(dir, 'dsh-web.log')
    await writeFile(log, 'dsh web: http://127.0.0.1:3082/?token=abc123\n')
    try {
      const fetch = vi.fn(async (url: string, init: RequestInit) => {
        if (url.includes('?token=')) {
          return new Response('', { status: 303, headers: { 'set-cookie': 'dsh-auth-127.0.0.1:3082=jar; Path=/' } })
        }
        const request = JSON.parse(String(init.body))
        return new Response(JSON.stringify({
          type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { resumed: ['proj/session-a'] } },
        }), { status: 200 })
      })
      await expect(resumeViaRpcWithSession(['proj/session-a'], fetch, { logPath: log })).resolves
        .toEqual({ resumed: ['proj/session-a'] })
      expect(fetch.mock.calls.length).toBe(2) // token trade + RPC POST
      expect(fetch.mock.calls[1]![1].headers).toMatchObject({ cookie: 'dsh-auth-127.0.0.1:3082=jar' })
    } finally {
      await rm(dirname(log), { recursive: true, force: true })
    }
  })

  it('falls back to an unauthenticated POST when no boot line is readable', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify({
        type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { resumed: [] } },
      }), { status: 200 })
    })
    await expect(resumeViaRpcWithSession([], fetch, { logPath: join(tmpdir(), 'no-such-dsh-web.log') })).resolves
      .toEqual({ resumed: [] })
    expect(fetch).toHaveBeenCalledTimes(1) // minting skipped (unreadable log), single plain POST
  })
})

afterEach(() => vi.restoreAllMocks())
