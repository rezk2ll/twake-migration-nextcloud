import { describe, it, expect, vi, afterEach } from 'vitest'
import { withTimeout } from '../src/clients/with-timeout.js'

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the operation result when it settles before the ceiling', async () => {
    const result = await withTimeout(async () => 'ok', 1000, 'test')
    expect(result).toBe('ok')
  })

  it('propagates operation errors untouched', async () => {
    await expect(
      withTimeout(async () => {
        throw new Error('boom')
      }, 1000, 'test'),
    ).rejects.toThrow('boom')
  })

  it('rejects with a labelled timeout error when the ceiling is exceeded', async () => {
    vi.useFakeTimers()
    const pending = withTimeout(
      () => new Promise<never>(() => { /* never resolves */ }),
      5_000,
      'neverSettles',
    )
    // Silence the unhandled-rejection window: advancing timers rejects
    // `pending` before the assertion below can observe it.
    const assertion = expect(pending).rejects.toThrow(/neverSettles timed out after 5000ms/)
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
  })

  it('does not leave the timer pending after a fast success', async () => {
    vi.useFakeTimers()
    await withTimeout(async () => 'fast', 5_000, 'fast')
    // If the timer was still armed it would count against the remaining
    // pending timers; assert we cleared it on success.
    expect(vi.getTimerCount()).toBe(0)
  })
})
