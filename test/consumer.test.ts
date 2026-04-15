import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleMigrationMessage } from '../src/runtime/consumer.js'
import type { ClouderyClient } from '../src/clients/cloudery-client.js'
import type { StackClient } from '../src/clients/stack-client.js'
import type { MigrationCommand, TrackingDoc } from '../src/domain/types.js'
import type { Config } from '../src/runtime/config.js'
import type { Logger } from 'pino'

// Mock the migration module so runMigration doesn't actually execute
vi.mock('../src/domain/migration.js', () => ({
  runMigration: vi.fn().mockResolvedValue(undefined),
}))

// Mock stack-client factory
vi.mock('../src/clients/stack-client.js', () => ({
  createStackClient: vi.fn(),
}))

import { runMigration } from '../src/domain/migration.js'
import { createStackClient } from '../src/clients/stack-client.js'

const logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger

const config: Config = {
  rabbitmqUrl: 'amqp://localhost',
  clouderyUrl: 'https://manager.cozycloud.cc',
  clouderyToken: 'secret',
  logLevel: 'info',
  flushInterval: 50,
  stackUrlScheme: 'https',
}

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

function makePendingDoc(overrides: Partial<TrackingDoc> = {}): TrackingDoc {
  return {
    _id: 'mig-1',
    _rev: '1-abc',
    status: 'pending',
    target_dir: 'io.cozy.files.root-dir',
    progress: { files_imported: 0, files_total: 0, bytes_imported: 0, bytes_total: 0 },
    errors: [],
    skipped: [],
    started_at: null,
    finished_at: null,
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
      getTrackingDoc: vi.fn().mockResolvedValue(makePendingDoc()),
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

    await handleMigrationMessage(command, mockCloudery, logger, config)

    expect(mockCloudery.getToken).toHaveBeenCalledWith('alice.cozy.example')
    expect(createStackClient).toHaveBeenCalledWith('alice.cozy.example', 'https', 'jwt-token', mockCloudery, expect.anything())
    expect(mockStack.getTrackingDoc).toHaveBeenCalledWith('mig-1')
    expect(runMigration).toHaveBeenCalledWith(command, mockStack, logger, config.flushInterval)
  })

  it('skips migration if status is completed', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce(makePendingDoc({
      status: 'completed',
      progress: { files_imported: 10, files_total: 10, bytes_imported: 5000, bytes_total: 5000 },
      started_at: '2024-01-01T00:00:00.000Z',
      finished_at: '2024-01-01T00:01:00.000Z',
    }))

    await handleMigrationMessage(makeCommand(), mockCloudery, logger, config)

    expect(runMigration).not.toHaveBeenCalled()
  })

  it('skips migration if status is running', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce(makePendingDoc({
      status: 'running',
      progress: { files_imported: 5, files_total: 10, bytes_imported: 2000, bytes_total: 5000 },
      started_at: '2024-01-01T00:00:00.000Z',
    }))

    await handleMigrationMessage(makeCommand(), mockCloudery, logger, config)

    expect(runMigration).not.toHaveBeenCalled()
  })

  it('proceeds if status is failed (retry scenario)', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce(makePendingDoc({
      status: 'failed',
      progress: { files_imported: 5, files_total: 10, bytes_imported: 2000, bytes_total: 5000 },
      errors: [{ path: '/x', message: 'boom', at: '2024-01-01T00:00:00.000Z' }],
      started_at: '2024-01-01T00:00:00.000Z',
      finished_at: '2024-01-01T00:01:00.000Z',
    }))

    await handleMigrationMessage(makeCommand(), mockCloudery, logger, config)

    expect(runMigration).toHaveBeenCalled()
  })

  it('marks migration as failed if quota is insufficient', async () => {
    vi.mocked(mockStack.getDiskUsage).mockResolvedValueOnce({ used: 99000, quota: 100000 })
    // estimateSourceSize sums file sizes from listNextcloudDir
    vi.mocked(mockStack.listNextcloudDir).mockResolvedValueOnce([
      { type: 'file', name: 'large.zip', path: '/large.zip', size: 50000, mime: 'application/zip' },
    ])

    await handleMigrationMessage(makeCommand(), mockCloudery, logger, config)

    expect(runMigration).not.toHaveBeenCalled()
    const failedUpdate = vi.mocked(mockStack.updateTrackingDoc).mock.calls
      .find((c) => (c[0] as TrackingDoc).status === 'failed')
    expect(failedUpdate).toBeDefined()
  })

  it('skips quota check when quota is 0 (unlimited)', async () => {
    vi.mocked(mockStack.getDiskUsage).mockResolvedValueOnce({ used: 99000, quota: 0 })
    // Even with large files, unlimited quota allows migration
    vi.mocked(mockStack.listNextcloudDir).mockResolvedValueOnce([
      { type: 'file', name: 'huge.iso', path: '/huge.iso', size: 999999, mime: 'application/octet-stream' },
    ])

    await handleMigrationMessage(makeCommand(), mockCloudery, logger, config)

    expect(runMigration).toHaveBeenCalled()
  })

  it('throws on Cloudery failure (triggers retry/DLQ)', async () => {
    vi.mocked(mockCloudery.getToken).mockRejectedValueOnce(
      new Error('Cloudery token request failed (503): unavailable')
    )

    await expect(
      handleMigrationMessage(makeCommand(), mockCloudery, logger, config)
    ).rejects.toThrow('503')
  })
})
