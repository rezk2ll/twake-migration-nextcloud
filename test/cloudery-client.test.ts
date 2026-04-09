import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createClouderyClient } from '../src/cloudery-client.js'

describe('ClouderyClient', () => {
  const CLOUDERY_URL = 'https://manager.cozycloud.cc'
  const CLOUDERY_TOKEN = 'api-secret'

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

    const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN)
    const token = await client.getToken('alice.cozy.example')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://manager.cozycloud.cc/api/public/instances/alice.cozy.example/nextcloud_migration_token',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer api-secret',
        },
      }
    )
    expect(token).toBe('instance-jwt')
  })

  it('throws on non-OK response with status and body', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(
      new Response('instance not found', { status: 404 })
    )

    const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN)

    await expect(client.getToken('unknown.cozy.example')).rejects.toThrow(
      'Cloudery token request failed (404): instance not found'
    )
  })
})
