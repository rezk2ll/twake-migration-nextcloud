import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleMigrationMessage } from '../src/runtime/consumer.js'
import type { ClouderyClient } from '../src/clients/cloudery-client.js'
import type { StackClient } from '../src/clients/stack-client.js'
import type { MigrationCommand, TrackingDoc } from '../src/domain/types.js'
import type { Config } from '../src/runtime/config.js'
import type { MigrationRunner } from '../src/runtime/migration-runner.js'
import type { Logger } from 'pino'

/** Pass-through runner for tests: invokes the task synchronously so
 *  assertions can run afterwards. Production runs tasks in the background. */
const passThroughRunner: MigrationRunner = {
  async run(task) { await task() },
  async drain() { return true },
  get active() { return 0 },
}

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
  flushInterval: 25,
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
    target_dir: '/Nextcloud',
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
      refreshToken: vi.fn().mockResolvedValue('jwt-token'),
    }

    mockStack = {
      getTrackingDoc: vi.fn().mockResolvedValue(makePendingDoc()),
      getDiskUsage: vi.fn().mockResolvedValue({ used: 1000, quota: 100000 }),
      getNextcloudSize: vi.fn().mockResolvedValue(0),
      listNextcloudDir: vi.fn().mockResolvedValue([]),
      updateTrackingDoc: vi.fn().mockImplementation(async (doc: TrackingDoc) => doc),
      transferFile: vi.fn(),
      createDir: vi.fn(),
    } as unknown as StackClient

    vi.mocked(createStackClient).mockReturnValue(mockStack)
  })

  it('fetches token, validates, and fires migration', async () => {
    const command = makeCommand()
    // Small enough to pass the quota check (used 1000 + 12345 < quota 100000).
    vi.mocked(mockStack.getNextcloudSize).mockResolvedValueOnce(12345)

    await handleMigrationMessage(command, mockCloudery, logger, config, passThroughRunner)

    expect(mockCloudery.getToken).toHaveBeenCalledWith('alice.cozy.example')
    expect(createStackClient).toHaveBeenCalledWith('alice.cozy.example', 'https', 'jwt-token', mockCloudery, expect.anything())
    expect(mockStack.getTrackingDoc).toHaveBeenCalledWith('mig-1')
    // The pre-flight size from getNextcloudSize is forwarded to runMigration
    // so setRunning can seed bytes_total for the UI's progress bar.
    expect(runMigration).toHaveBeenCalledWith(command, mockStack, logger, 12345, '/Nextcloud', config.flushInterval)
  })

  it('skips migration if status is completed', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce(makePendingDoc({
      status: 'completed',
      progress: { files_imported: 10, files_total: 10, bytes_imported: 5000, bytes_total: 5000 },
      started_at: '2024-01-01T00:00:00.000Z',
      finished_at: '2024-01-01T00:01:00.000Z',
    }))

    await handleMigrationMessage(makeCommand(), mockCloudery, logger, config, passThroughRunner)

    expect(runMigration).not.toHaveBeenCalled()
  })

  it('skips migration if status is running and heartbeat is fresh', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce(makePendingDoc({
      status: 'running',
      progress: { files_imported: 5, files_total: 10, bytes_imported: 2000, bytes_total: 5000 },
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
    }))

    await handleMigrationMessage(makeCommand(), mockCloudery, logger, config, passThroughRunner)

    expect(runMigration).not.toHaveBeenCalled()
  })

  it('resumes a running migration whose heartbeat is stale', async () => {
    // Heartbeat well older than STALE_HEARTBEAT_MS (30 min) means the
    // previous consumer crashed; the 409-on-existing skip logic makes
    // resume idempotent, so we pick it up.
    const old = new Date(Date.now() - 60 * 60_000).toISOString()
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce(makePendingDoc({
      status: 'running',
      progress: { files_imported: 5, files_total: 10, bytes_imported: 2000, bytes_total: 5000 },
      started_at: old,
      last_heartbeat_at: old,
    }))

    await handleMigrationMessage(makeCommand(), mockCloudery, logger, config, passThroughRunner)

    expect(runMigration).toHaveBeenCalled()
  })

  it('proceeds if status is failed (retry scenario)', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce(makePendingDoc({
      status: 'failed',
      progress: { files_imported: 5, files_total: 10, bytes_imported: 2000, bytes_total: 5000 },
      errors: [{ path: '/x', message: 'boom', at: '2024-01-01T00:00:00.000Z' }],
      started_at: '2024-01-01T00:00:00.000Z',
      finished_at: '2024-01-01T00:01:00.000Z',
    }))

    await handleMigrationMessage(makeCommand(), mockCloudery, logger, config, passThroughRunner)

    expect(runMigration).toHaveBeenCalled()
  })

  it('marks migration as failed if quota is insufficient', async () => {
    vi.mocked(mockStack.getDiskUsage).mockResolvedValueOnce({ used: 99000, quota: 100000 })
    // The recursive oc:size total exceeds the free quota.
    vi.mocked(mockStack.getNextcloudSize).mockResolvedValueOnce(50000)

    await handleMigrationMessage(makeCommand(), mockCloudery, logger, config, passThroughRunner)

    expect(runMigration).not.toHaveBeenCalled()
    const failedUpdate = vi.mocked(mockStack.updateTrackingDoc).mock.calls
      .find((c) => (c[0] as TrackingDoc).status === 'failed')
    expect(failedUpdate).toBeDefined()
  })

  it('skips quota check when quota is 0 (unlimited)', async () => {
    vi.mocked(mockStack.getDiskUsage).mockResolvedValueOnce({ used: 99000, quota: 0 })
    // Even with a huge source tree, unlimited quota allows migration.
    vi.mocked(mockStack.getNextcloudSize).mockResolvedValueOnce(999999)

    await handleMigrationMessage(makeCommand(), mockCloudery, logger, config, passThroughRunner)

    expect(runMigration).toHaveBeenCalled()
  })

  it('falls back to /Nextcloud when the tracking doc has no target_dir', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce(makePendingDoc({ target_dir: '' }))
    vi.mocked(mockStack.getNextcloudSize).mockResolvedValueOnce(10)

    await handleMigrationMessage(makeCommand(), mockCloudery, logger, config, passThroughRunner)

    expect(runMigration).toHaveBeenCalledWith(
      expect.anything(), mockStack, logger, 10, '/Nextcloud', config.flushInterval,
    )
  })

  it('calls getNextcloudSize on the configured sourcePath', async () => {
    await handleMigrationMessage(makeCommand({ sourcePath: '/Photos' }), mockCloudery, logger, config, passThroughRunner)
    expect(mockStack.getNextcloudSize).toHaveBeenCalledWith('acc-123', '/Photos')
  })

  it('throws on Cloudery failure (triggers retry/DLQ)', async () => {
    vi.mocked(mockCloudery.getToken).mockRejectedValueOnce(
      new Error('Cloudery token request failed (503): unavailable')
    )

    await expect(
      handleMigrationMessage(makeCommand(), mockCloudery, logger, config, passThroughRunner)
    ).rejects.toThrow('503')
  })

  describe('permanent pre-ACK failures', () => {
    it('drops the message when the tracking doc is missing (404)', async () => {
      vi.mocked(mockStack.getTrackingDoc).mockRejectedValueOnce(
        Object.assign(new Error('not found'), { status: 404 }),
      )

      await handleMigrationMessage(makeCommand(), mockCloudery, logger, config, passThroughRunner)

      expect(runMigration).not.toHaveBeenCalled()
      expect(mockStack.updateTrackingDoc).not.toHaveBeenCalled()
    })

    it('still throws on transient tracking-doc errors (5xx)', async () => {
      vi.mocked(mockStack.getTrackingDoc).mockRejectedValueOnce(
        Object.assign(new Error('Internal Server Error'), { status: 500 }),
      )

      await expect(
        handleMigrationMessage(makeCommand(), mockCloudery, logger, config, passThroughRunner),
      ).rejects.toThrow(/Internal Server Error/)
    })

    it('marks the migration failed when the source path is missing (404)', async () => {
      vi.mocked(mockStack.getNextcloudSize).mockRejectedValueOnce(
        Object.assign(new Error('not found'), { status: 404 }),
      )

      await handleMigrationMessage(
        makeCommand({ sourcePath: '/does-not-exist' }),
        mockCloudery,
        logger,
        config,
        passThroughRunner,
      )

      expect(runMigration).not.toHaveBeenCalled()
      const failedUpdate = vi.mocked(mockStack.updateTrackingDoc).mock.calls
        .find((c) => (c[0] as TrackingDoc).status === 'failed')
      expect(failedUpdate).toBeDefined()
    })

    it('still throws on transient Nextcloud size errors (5xx)', async () => {
      vi.mocked(mockStack.getNextcloudSize).mockRejectedValueOnce(
        Object.assign(new Error('Bad Gateway'), { status: 502 }),
      )

      await expect(
        handleMigrationMessage(makeCommand(), mockCloudery, logger, config, passThroughRunner),
      ).rejects.toThrow(/Bad Gateway/)
    })
  })
})
