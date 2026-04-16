import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createStackClient } from '../src/clients/stack-client.js'
import type { ClouderyClient } from '../src/clients/cloudery-client.js'
import type { TrackingDoc } from '../src/domain/types.js'
import type { Logger } from 'pino'

// Mock cozy-stack-client
const mockFind = vi.fn()
const mockMoveToCozy = vi.fn()
const mockEnsureDirByPath = vi.fn()
const mockGetOrCreateDir = vi.fn()
const mockSettingsGet = vi.fn()
const mockDocGet = vi.fn()
const mockDocUpdate = vi.fn()
const mockSetToken = vi.fn()
const mockFetchJSON = vi.fn()

vi.mock('cozy-stack-client', () => {
  // Match the real package's shape: CommonJS with __esModule: true exposes
  // the class through `.default` on module.exports. Returning it the same
  // way under `default` lets the production code's default-import-then-
  // reach-through-.default pattern work against the mock.
  class CozyStackClient {
    constructor() {}
    setToken = mockSetToken
    fetchJSON = mockFetchJSON
    collection(doctype: string) {
      if (doctype === 'io.cozy.remote.nextcloud.files') {
        return { find: mockFind, moveToCozy: mockMoveToCozy }
      }
      if (doctype === 'io.cozy.files') {
        return {
          createDirectoryByPath: mockEnsureDirByPath,
          getDirectoryOrCreate: mockGetOrCreateDir,
        }
      }
      if (doctype === 'io.cozy.settings') {
        return { get: mockSettingsGet }
      }
      return { get: mockDocGet, update: mockDocUpdate }
    }
  }

  return { default: { default: CozyStackClient }, CozyStackClient }
})

const logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger

describe('StackClient', () => {
  const FQDN = 'alice.cozy.example'
  const TOKEN = 'initial-token'
  let mockCloudery: ClouderyClient

  beforeEach(() => {
    vi.clearAllMocks()
    mockCloudery = {
      getToken: vi.fn().mockResolvedValue('refreshed-token'),
      refreshToken: vi.fn().mockResolvedValue('refreshed-token'),
    }
  })

  describe('listNextcloudDir', () => {
    it('calls find with the right selector and maps entries', async () => {
      mockFind.mockResolvedValueOnce({
        data: [
          { type: 'directory', name: 'Photos', path: '/Photos', size: 0, mime: '' },
          { type: 'file', name: 'doc.pdf', path: '/doc.pdf', size: 1024, mime: 'application/pdf' },
        ],
      })

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)
      const result = await client.listNextcloudDir('acc-123', '/')

      expect(mockFind).toHaveBeenCalledWith({
        'cozyMetadata.sourceAccount': 'acc-123',
        parentPath: '/',
      })
      expect(result).toEqual([
        { type: 'directory', name: 'Photos', path: '/Photos', size: 0, mime: '' },
        { type: 'file', name: 'doc.pdf', path: '/doc.pdf', size: 1024, mime: 'application/pdf' },
      ])
    })
  })

  describe('getNextcloudSize', () => {
    it('calls the size proxy route and unwraps the byte total', async () => {
      mockFetchJSON.mockResolvedValueOnce({ size: 67365343 })

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)
      const size = await client.getNextcloudSize('acc-123', '/Photos')

      expect(size).toBe(67365343)
      expect(mockFetchJSON).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('/remote/nextcloud/acc-123/size/Photos'),
      )
    })

    it('sends the root path as /size/ for an empty or slash input', async () => {
      mockFetchJSON.mockResolvedValue({ size: 0 })
      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)

      await client.getNextcloudSize('acc-123', '/')
      await client.getNextcloudSize('acc-123', '')

      const urls = mockFetchJSON.mock.calls.map((call) => call[1] as string)
      expect(urls[0]).toContain('/remote/nextcloud/acc-123/size/')
      expect(urls[1]).toContain('/remote/nextcloud/acc-123/size/')
    })

    it('percent-encodes path segments with spaces and parens', async () => {
      mockFetchJSON.mockResolvedValueOnce({ size: 123 })
      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)

      await client.getNextcloudSize('acc-123', '/Holiday 2024/IMG (1)')

      const url = mockFetchJSON.mock.calls[0][1] as string
      expect(url).toContain('Holiday%202024')
      expect(url).toContain('IMG%20%281%29')
    })

    it('accepts a stringified size for forward compatibility', async () => {
      mockFetchJSON.mockResolvedValueOnce({ size: '42' })
      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)

      const size = await client.getNextcloudSize('acc-123', '/')
      expect(size).toBe(42)
    })
  })

  describe('transferFile', () => {
    it('calls the downstream proxy route and unwraps JSON-API', async () => {
      // transferFile goes through cozy.fetchJSON directly rather than
      // ncCollection.moveToCozy because that library method has a buggy
      // error path that crashes with "Body is unusable" on any 4xx.
      mockFetchJSON.mockResolvedValueOnce({
        data: {
          id: 'file-1',
          type: 'io.cozy.files',
          attributes: { name: 'doc.pdf', dir_id: 'dir-1', size: '1024' },
        },
      })

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)
      const result = await client.transferFile('acc-123', '/doc.pdf', 'dir-1')

      expect(mockFetchJSON).toHaveBeenCalledWith(
        'POST',
        expect.stringContaining('/remote/nextcloud/acc-123/downstream/doc.pdf'),
      )
      expect(mockFetchJSON).toHaveBeenCalledWith(
        'POST',
        expect.stringContaining('Copy=true'),
      )
      expect(mockFetchJSON).toHaveBeenCalledWith(
        'POST',
        expect.stringContaining('FailOnConflict=true'),
      )
      expect(result).toEqual({ id: 'file-1', name: 'doc.pdf', dir_id: 'dir-1', size: 1024 })
    })

    it('propagates a 409 FetchError so the migration loop can skip the file', async () => {
      mockFetchJSON.mockRejectedValueOnce(
        Object.assign(new Error('Conflict'), {
          name: 'FetchError',
          status: 409,
          reason: { errors: [{ status: '409', detail: 'already exists' }] },
        }),
      )

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)
      await expect(client.transferFile('acc-123', '/doc.pdf', 'dir-1'))
        .rejects.toMatchObject({ status: 409 })
    })

    it('percent-encodes path segments but keeps the slashes', async () => {
      mockFetchJSON.mockResolvedValueOnce({
        data: {
          id: 'f',
          type: 'io.cozy.files',
          attributes: { name: 'x', dir_id: 'd', size: '0' },
        },
      })

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)
      await client.transferFile('acc-123', '/Photos/Holiday 2024/IMG (1).jpg', 'dir-1')

      const url = mockFetchJSON.mock.calls[0][1] as string
      expect(url).toContain('/Photos/')
      expect(url).toContain('Holiday%202024')
      expect(url).toContain('IMG%20%281%29.jpg')
    })
  })

  describe('ensureDirPath', () => {
    it('delegates to createDirectoryByPath and unwraps id + path', async () => {
      mockEnsureDirByPath.mockResolvedValueOnce({
        data: { _id: 'leaf-id', attributes: { path: '/Nextcloud/Imports', type: 'directory' } },
      })

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)
      const dir = await client.ensureDirPath('/Nextcloud/Imports')

      expect(mockEnsureDirByPath).toHaveBeenCalledWith('/Nextcloud/Imports')
      expect(dir).toEqual({ id: 'leaf-id', path: '/Nextcloud/Imports' })
    })
  })

  describe('ensureChildDir', () => {
    it('delegates to getDirectoryOrCreate so existence is a stat, not a 409', async () => {
      // Any existing-dir lookup goes through the library's native
      // statByPath-then-create-on-404 helper; we should never reach a
      // 409 path ourselves. Assert the library call shape is correct.
      mockGetOrCreateDir.mockResolvedValueOnce({
        data: { _id: 'child-id', attributes: { path: '/Nextcloud/Imports/Photos', type: 'directory' } },
      })
      const parent = { id: 'parent-id', path: '/Nextcloud/Imports' }

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)
      const dir = await client.ensureChildDir('Photos', parent)

      expect(mockGetOrCreateDir).toHaveBeenCalledWith('Photos', {
        _id: 'parent-id',
        attributes: { path: '/Nextcloud/Imports' },
      })
      expect(dir).toEqual({ id: 'child-id', path: '/Nextcloud/Imports/Photos' })
    })

    it('propagates unexpected errors from the Stack helper', async () => {
      mockGetOrCreateDir.mockRejectedValueOnce(
        Object.assign(new Error('Internal Server Error'), { status: 500 }),
      )

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)
      await expect(
        client.ensureChildDir('Photos', { id: 'parent-id', path: '/Nextcloud' }),
      ).rejects.toThrow(/Internal Server Error/)
    })
  })

  describe('getDiskUsage', () => {
    it('returns used and quota parsed from strings', async () => {
      mockSettingsGet.mockResolvedValueOnce({
        data: { attributes: { used: '5000', quota: '10000' } },
      })

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)
      const usage = await client.getDiskUsage()

      expect(mockSettingsGet).toHaveBeenCalledWith('io.cozy.settings.disk-usage')
      expect(usage).toEqual({ used: 5000, quota: 10000 })
    })
  })

  describe('getTrackingDoc', () => {
    it('fetches and returns the tracking document', async () => {
      const doc: TrackingDoc = {
        _id: 'mig-1', _rev: '1-abc', status: 'pending',
        target_dir: '/Nextcloud',
        progress: { files_imported: 0, files_total: 0, bytes_imported: 0, bytes_total: 0 },
        errors: [], skipped: [],
        started_at: null, finished_at: null,
      }
      mockDocGet.mockResolvedValueOnce({ data: doc })

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)
      const result = await client.getTrackingDoc('mig-1')

      expect(mockDocGet).toHaveBeenCalledWith('mig-1')
      expect(result).toEqual(doc)
    })
  })

  describe('updateTrackingDoc', () => {
    it('updates and returns the doc with new _rev', async () => {
      const doc: TrackingDoc = {
        _id: 'mig-1', _rev: '1-abc', status: 'running',
        target_dir: '/Nextcloud',
        progress: { files_imported: 0, files_total: 0, bytes_imported: 0, bytes_total: 5000 },
        errors: [], skipped: [],
        started_at: '2024-01-01T00:00:00.000Z', finished_at: null,
      }
      mockDocUpdate.mockResolvedValueOnce({ data: { ...doc, _rev: '2-def' } })

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)
      const result = await client.updateTrackingDoc(doc)

      expect(mockDocUpdate).toHaveBeenCalledWith(doc)
      expect(result._rev).toBe('2-def')
    })
  })

  describe('timeout', () => {
    it('rejects with a labelled timeout when a Stack call stalls', async () => {
      // Use fake timers so we do not actually wait 60s. The mocked call
      // returns a promise that never settles, so only the timeout branch
      // can win the race.
      vi.useFakeTimers()
      mockFind.mockReturnValueOnce(new Promise(() => { /* never */ }))

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)
      const pending = client.listNextcloudDir('acc-123', '/')
      const assertion = expect(pending).rejects.toThrow(/listNextcloudDir timed out/)
      await vi.advanceTimersByTimeAsync(60_000)
      await assertion
      vi.useRealTimers()
    })
  })

  describe('token refresh on 401', () => {
    it('refreshes token and retries on 401 from collection', async () => {
      const entries = [{ type: 'file', name: 'a.txt', path: '/a.txt', size: 10, mime: 'text/plain' }]
      mockFind
        .mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }))
        .mockResolvedValueOnce({ data: entries })

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)
      const result = await client.listNextcloudDir('acc-123', '/')

      expect(mockCloudery.refreshToken).toHaveBeenCalledWith(FQDN)
      expect(mockSetToken).toHaveBeenCalled()
      expect(result).toEqual(entries)
    })

    it('throws after refresh + retry still fails', async () => {
      mockFind
        .mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }))
        .mockRejectedValueOnce(Object.assign(new Error('Still unauthorized'), { status: 401 }))

      const client = createStackClient(FQDN, 'https', TOKEN, mockCloudery, logger)

      await expect(client.listNextcloudDir('acc-123', '/')).rejects.toThrow()
    })
  })
})
