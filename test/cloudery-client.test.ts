import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createClouderyClient } from '../src/clients/cloudery-client.js'
import { MIGRATION_TOKEN_SCOPE } from '../src/domain/doctypes.js'
import type { Logger } from 'pino'

describe('ClouderyClient', () => {
  const CLOUDERY_URL = 'https://manager.cozycloud.cc'
  const CLOUDERY_TOKEN = 'api-secret'
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches a token for a given instance', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'instance-jwt' }), { status: 200 })
    )

    const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)
    const token = await client.getToken('alice.cozy.example')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://manager.cozycloud.cc/api/public/instances/alice.cozy.example/token',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer api-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audience: 'app',
          scope: MIGRATION_TOKEN_SCOPE,
        }),
        signal: expect.any(AbortSignal),
      })
    )
    expect(token).toBe('instance-jwt')
  })

  it('throws on non-OK response with status and body', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(
      new Response('instance not found', { status: 404 })
    )

    const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)

    await expect(client.getToken('unknown.cozy.example')).rejects.toThrow(
      'Cloudery token request failed (404): instance not found'
    )
  })

  it('rejects with a timeout error when the fetch exceeds the ceiling', async () => {
    // Drive wall-clock via fake timers so we can fast-forward past the
    // 30s ceiling without actually waiting. The mocked fetch rejects
    // with the same AbortError shape Node produces on signal abort.
    vi.useFakeTimers()
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockImplementationOnce((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    })

    const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)
    const pending = client.getToken('alice.cozy.example')
    const assertion = expect(pending).rejects.toThrow(/timed out after 30000ms/)
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
    vi.useRealTimers()
  })
})
