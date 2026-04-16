import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createClouderyClient } from '../src/clients/cloudery-client.js'
import { MIGRATION_TOKEN_SCOPE } from '../src/domain/doctypes.js'
import type { Logger } from 'pino'

describe('ClouderyClient', () => {
  const CLOUDERY_URL = 'https://manager.cozycloud.cc'
  const CLOUDERY_TOKEN = 'api-secret'
  const FQDN = 'alice.cozy.example'
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function okResponse(token = 'instance-jwt') {
    return new Response(JSON.stringify({ token }), { status: 200 })
  }

  it('fetches a token for a given instance', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(okResponse())

    const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)
    const token = await client.getToken(FQDN)

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

  it('throws on non-retryable failure with status and body', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(
      new Response('instance not found', { status: 404 })
    )

    const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)

    await expect(client.getToken('unknown.cozy.example')).rejects.toThrow(
      'Cloudery token request failed (404): instance not found'
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('rejects with a timeout error when the fetch exceeds the ceiling', async () => {
    // Drive wall-clock via fake timers so we can fast-forward past the
    // 30s ceiling without actually waiting. The mocked fetch rejects
    // with the same AbortError shape Node produces on signal abort.
    vi.useFakeTimers()
    const mockFetch = vi.mocked(fetch)
    // All retry attempts stall; each one must trip the per-call timeout.
    mockFetch.mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    })

    const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)
    const pending = client.getToken(FQDN)
    const assertion = expect(pending).rejects.toThrow(/timed out after 30000ms/)
    // Fast-forward past every timeout + backoff slot.
    await vi.advanceTimersByTimeAsync(200_000)
    await assertion
  })

  describe('caching', () => {
    it('reuses a cached token within the TTL', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValueOnce(okResponse('jwt-1'))

      const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)
      const first = await client.getToken(FQDN)
      const second = await client.getToken(FQDN)

      expect(first).toBe('jwt-1')
      expect(second).toBe('jwt-1')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('refetches after the TTL expires', async () => {
      vi.useFakeTimers()
      const mockFetch = vi.mocked(fetch)
      mockFetch
        .mockResolvedValueOnce(okResponse('jwt-1'))
        .mockResolvedValueOnce(okResponse('jwt-2'))

      const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)
      const first = await client.getToken(FQDN)
      // TTL is 60s; step past it.
      await vi.advanceTimersByTimeAsync(61_000)
      const second = await client.getToken(FQDN)

      expect(first).toBe('jwt-1')
      expect(second).toBe('jwt-2')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('refreshToken bypasses the cache', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch
        .mockResolvedValueOnce(okResponse('jwt-1'))
        .mockResolvedValueOnce(okResponse('jwt-2'))

      const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)
      await client.getToken(FQDN)
      const refreshed = await client.refreshToken(FQDN)

      expect(refreshed).toBe('jwt-2')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('coalesces concurrent callers for the same instance into one fetch', async () => {
      const mockFetch = vi.mocked(fetch)
      let resolveFetch: (r: Response) => void = () => {}
      mockFetch.mockReturnValueOnce(
        new Promise<Response>((resolve) => { resolveFetch = resolve })
      )

      const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)
      const a = client.getToken(FQDN)
      const b = client.getToken(FQDN)
      resolveFetch(okResponse('jwt-1'))
      const [tokenA, tokenB] = await Promise.all([a, b])

      expect(tokenA).toBe('jwt-1')
      expect(tokenB).toBe('jwt-1')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('retry', () => {
    it('retries on 503 and succeeds on a later attempt', async () => {
      vi.useFakeTimers()
      const mockFetch = vi.mocked(fetch)
      mockFetch
        .mockResolvedValueOnce(new Response('busy', { status: 503 }))
        .mockResolvedValueOnce(okResponse('jwt-1'))

      const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)
      const pending = client.getToken(FQDN)
      await vi.advanceTimersByTimeAsync(5_000)
      const token = await pending

      expect(token).toBe('jwt-1')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('retries on network errors', async () => {
      vi.useFakeTimers()
      const mockFetch = vi.mocked(fetch)
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(okResponse('jwt-1'))

      const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)
      const pending = client.getToken(FQDN)
      await vi.advanceTimersByTimeAsync(5_000)
      const token = await pending

      expect(token).toBe('jwt-1')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('does not retry on 404', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValueOnce(new Response('nope', { status: 404 }))

      const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)
      await expect(client.getToken(FQDN)).rejects.toThrow(/404/)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('does not retry on 401 (Cloudery auth misconfigured)', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValueOnce(new Response('bad key', { status: 401 }))

      const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)
      await expect(client.getToken(FQDN)).rejects.toThrow(/401/)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('gives up after the retry budget is exhausted', async () => {
      vi.useFakeTimers()
      const mockFetch = vi.mocked(fetch)
      // A Response body drains on read, so each attempt needs its own.
      mockFetch.mockImplementation(async () =>
        new Response('busy', { status: 503 }),
      )

      const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN, logger)
      const pending = client.getToken(FQDN)
      const assertion = expect(pending).rejects.toThrow(/503/)
      await vi.advanceTimersByTimeAsync(20_000)
      await assertion

      expect(mockFetch).toHaveBeenCalledTimes(3)
    })
  })
})
