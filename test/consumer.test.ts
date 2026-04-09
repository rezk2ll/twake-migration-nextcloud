import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleMigrationMessage } from '../src/consumer.js'
import type { ClouderyClient } from '../src/cloudery-client.js'
import type { StackClient } from '../src/stack-client.js'
import type { MigrationCommand, TrackingDoc } from '../src/types.js'
import type { Logger } from 'pino'

// Mock the migration module so runMigration doesn't actually execute
vi.mock('../src/migration.js', () => ({
  runMigration: vi.fn().mockResolvedValue(undefined),
}))

// Mock stack-client factory
vi.mock('../src/stack-client.js', () => ({
  createStackClient: vi.fn(),
}))

import { runMigration } from '../src/migration.js'
import { createStackClient } from '../src/stack-client.js'

const logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger

function makeCommand(overrides: Partial<MigrationCommand> = {}): MigrationCommand {
  return {
    migrationId: 'mig-1',
    workplaceFqdn: 'alice.cozy.example',
    accountId: 'acc-123',
    sourcePath: '/',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('handleMigrationMessage', () => {
  let mockCloudery: ClouderyClient
  let mockStack: StackClient

  beforeEach(() => {
    vi.clearAllMocks()

    mockCloudery = {
      getToken: vi.fn().mockResolvedValue('jwt-token'),
    }

    mockStack = {
      getTrackingDoc: vi.fn().mockResolvedValue({
        _id: 'mig-1', _rev: '1-abc', status: 'pending',
        bytes_total: 0, bytes_imported: 0, files_imported: 0,
        errors: [], skipped: [],
      } satisfies TrackingDoc),
      getDiskUsage: vi.fn().mockResolvedValue({ used: 1000, quota: 100000 }),
      listNextcloudDir: vi.fn().mockResolvedValue([]),
      updateTrackingDoc: vi.fn().mockImplementation(async (doc: TrackingDoc) => doc),
      transferFile: vi.fn(),
      createDir: vi.fn(),
    } as unknown as StackClient

    vi.mocked(createStackClient).mockReturnValue(mockStack)
  })

  it('fetches token, validates, and fires migration', async () => {
    const command = makeCommand()

    await handleMigrationMessage(command, mockCloudery, logger)

    expect(mockCloudery.getToken).toHaveBeenCalledWith('alice.cozy.example')
    expect(createStackClient).toHaveBeenCalledWith('alice.cozy.example', 'jwt-token', mockCloudery)
    expect(mockStack.getTrackingDoc).toHaveBeenCalledWith('mig-1')
    expect(runMigration).toHaveBeenCalledWith(command, mockStack, logger)
  })

  it('skips migration if status is completed', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce({
      _id: 'mig-1', _rev: '1-abc', status: 'completed',
      bytes_total: 5000, bytes_imported: 5000, files_imported: 10,
      errors: [], skipped: [],
    } satisfies TrackingDoc)

    await handleMigrationMessage(makeCommand(), mockCloudery, logger)

    expect(runMigration).not.toHaveBeenCalled()
  })

  it('skips migration if status is running', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce({
      _id: 'mig-1', _rev: '1-abc', status: 'running',
      bytes_total: 5000, bytes_imported: 2000, files_imported: 5,
      errors: [], skipped: [],
    } satisfies TrackingDoc)

    await handleMigrationMessage(makeCommand(), mockCloudery, logger)

    expect(runMigration).not.toHaveBeenCalled()
  })

  it('proceeds if status is failed (retry scenario)', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce({
      _id: 'mig-1', _rev: '1-abc', status: 'failed',
      bytes_total: 5000, bytes_imported: 2000, files_imported: 5,
      errors: [{ path: '/x', message: 'boom' }], skipped: [],
    } satisfies TrackingDoc)

    await handleMigrationMessage(makeCommand(), mockCloudery, logger)

    expect(runMigration).toHaveBeenCalled()
  })

  it('marks migration as failed if quota is insufficient', async () => {
    vi.mocked(mockStack.getDiskUsage).mockResolvedValueOnce({ used: 99000, quota: 100000 })
    vi.mocked(mockStack.listNextcloudDir).mockResolvedValueOnce([
      { type: 'file', name: 'big.zip', path: '/big.zip', size: 50000, mime: 'application/zip' },
    ])

    await handleMigrationMessage(makeCommand(), mockCloudery, logger)

    expect(runMigration).not.toHaveBeenCalled()
    // Should have updated tracking doc to failed
    const failedUpdate = vi.mocked(mockStack.updateTrackingDoc).mock.calls
      .find((c) => (c[0] as TrackingDoc).status === 'failed')
    expect(failedUpdate).toBeDefined()
  })

  it('throws on Cloudery failure (triggers retry/DLQ)', async () => {
    vi.mocked(mockCloudery.getToken).mockRejectedValueOnce(
      new Error('Cloudery token request failed (503): unavailable')
    )

    await expect(
      handleMigrationMessage(makeCommand(), mockCloudery, logger)
    ).rejects.toThrow('503')
  })
})
