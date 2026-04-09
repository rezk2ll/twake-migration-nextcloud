import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createStackClient } from '../src/stack-client.js'
import type { ClouderyClient } from '../src/cloudery-client.js'
import type { TrackingDoc } from '../src/types.js'
import type { Logger } from 'pino'

// Mock cozy-stack-client
const mockFind = vi.fn()
const mockMoveToCozy = vi.fn()
const mockCreateDirectory = vi.fn()
const mockSettingsGet = vi.fn()
const mockDocGet = vi.fn()
const mockDocUpdate = vi.fn()
const mockSetToken = vi.fn()

vi.mock('cozy-stack-client', () => {
  class AppToken {
    token: string
    constructor(token: string) { this.token = token }
    toAuthHeader() { return `Bearer ${this.token}` }
    getAccessToken() { return this.token }
  }

  class CozyStackClient {
    constructor() {}
    setToken = mockSetToken
    collection(doctype: string) {
      if (doctype === 'io.cozy.remote.nextcloud.files') {
        return { find: mockFind, moveToCozy: mockMoveToCozy }
      }
      if (doctype === 'io.cozy.files') {
        return { createDirectory: mockCreateDirectory }
      }
      if (doctype === 'io.cozy.settings') {
        return { get: mockSettingsGet }
      }
      return { get: mockDocGet, update: mockDocUpdate }
    }
  }

  return { CozyStackClient, AppToken }
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
    mockCloudery = { getToken: vi.fn().mockResolvedValue('refreshed-token') }
  })

  describe('listNextcloudDir', () => {
    it('calls find with the right selector and maps entries', async () => {
      mockFind.mockResolvedValueOnce({
        data: [
          { type: 'directory', name: 'Photos', path: '/Photos', size: 0, mime: '' },
          { type: 'file', name: 'doc.pdf', path: '/doc.pdf', size: 1024, mime: 'application/pdf' },
        ],
      })

      const client = createStackClient(FQDN, TOKEN, mockCloudery, logger)
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

  describe('transferFile', () => {
    it('calls moveToCozy with copy:true and unwraps JSON-API', async () => {
      const jsonApiBody = {
        data: {
          id: 'file-1',
          type: 'io.cozy.files',
          attributes: { name: 'doc.pdf', dir_id: 'dir-1', size: '1024' },
        },
      }
      mockMoveToCozy.mockResolvedValueOnce({
        status: 201,
        json: () => Promise.resolve(jsonApiBody),
      })

      const client = createStackClient(FQDN, TOKEN, mockCloudery, logger)
      const result = await client.transferFile('acc-123', '/doc.pdf', 'dir-1')

      expect(mockMoveToCozy).toHaveBeenCalledWith(
        { path: '/doc.pdf', cozyMetadata: { sourceAccount: 'acc-123' } },
        { _id: 'dir-1' },
        { copy: true, FailOnConflict: true }
      )
      expect(result).toEqual({ id: 'file-1', name: 'doc.pdf', dir_id: 'dir-1', size: 1024 })
    })
  })

  describe('createDir', () => {
    it('creates a directory and returns its ID', async () => {
      mockCreateDirectory.mockResolvedValueOnce({
        data: { _id: 'new-dir-id' },
      })

      const client = createStackClient(FQDN, TOKEN, mockCloudery, logger)
      const dirId = await client.createDir('parent-id', 'Photos')

      expect(mockCreateDirectory).toHaveBeenCalledWith({
        name: 'Photos',
        dirId: 'parent-id',
      })
      expect(dirId).toBe('new-dir-id')
    })

    it('returns existing dir ID on 409 conflict', async () => {
      const conflictError = Object.assign(new Error('Conflict'), {
        status: 409,
        response: {
          json: () => Promise.resolve({
            errors: [{ source: { id: 'existing-dir-id' } }],
          }),
        },
      })
      mockCreateDirectory.mockRejectedValueOnce(conflictError)

      const client = createStackClient(FQDN, TOKEN, mockCloudery, logger)
      const dirId = await client.createDir('parent-id', 'Photos')

      expect(dirId).toBe('existing-dir-id')
    })
  })

  describe('getDiskUsage', () => {
    it('returns used and quota parsed from strings', async () => {
      mockSettingsGet.mockResolvedValueOnce({
        data: { attributes: { used: '5000', quota: '10000' } },
      })

      const client = createStackClient(FQDN, TOKEN, mockCloudery, logger)
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

      const client = createStackClient(FQDN, TOKEN, mockCloudery, logger)
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

      const client = createStackClient(FQDN, TOKEN, mockCloudery, logger)
      const result = await client.updateTrackingDoc(doc)

      expect(mockDocUpdate).toHaveBeenCalledWith(doc)
      expect(result._rev).toBe('2-def')
    })
  })

  describe('token refresh on 401', () => {
    it('refreshes token and retries on 401 from collection', async () => {
      const entries = [{ type: 'file', name: 'a.txt', path: '/a.txt', size: 10, mime: 'text/plain' }]
      mockFind
        .mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }))
        .mockResolvedValueOnce({ data: entries })

      const client = createStackClient(FQDN, TOKEN, mockCloudery, logger)
      const result = await client.listNextcloudDir('acc-123', '/')

      expect(mockCloudery.getToken).toHaveBeenCalledWith(FQDN)
      expect(mockSetToken).toHaveBeenCalled()
      expect(result).toEqual(entries)
    })

    it('throws after refresh + retry still fails', async () => {
      mockFind
        .mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }))
        .mockRejectedValueOnce(Object.assign(new Error('Still unauthorized'), { status: 401 }))

      const client = createStackClient(FQDN, TOKEN, mockCloudery, logger)

      await expect(client.listNextcloudDir('acc-123', '/')).rejects.toThrow()
    })
  })
})
