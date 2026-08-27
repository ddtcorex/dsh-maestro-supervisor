import { describe, it, expect, vi } from 'vitest'
import { notify } from '../src/host/notifier.js'

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
})
