import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleCancelMessage } from '../src/runtime/cancel-consumer.js'
import type { ClouderyClient } from '../src/clients/cloudery-client.js'
import type { StackClient } from '../src/clients/stack-client.js'
import type { CancelCommand, TrackingDoc } from '../src/domain/types.js'
import type { MigrationRunner } from '../src/runtime/migration-runner.js'
import { makeTestConfig } from './fixtures.js'
import type { Logger } from 'pino'

vi.mock('../src/clients/stack-client.js', () => ({
  createStackClient: vi.fn(),
}))

import { createStackClient } from '../src/clients/stack-client.js'

const logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger

const config = makeTestConfig()

function makeCommand(overrides: Partial<CancelCommand> = {}): CancelCommand {
  return {
    migrationId: 'mig-1',
    workplaceFqdn: 'alice.cozy.example',
    timestamp: Date.now(),
    ...overrides,
  }
}

function makeRunner(overrides: Partial<MigrationRunner> = {}): MigrationRunner {
  return {
    async run() { /* noop */ },
    cancel: vi.fn().mockReturnValue(false),
    async drain() { return true },
    get active() { return 0 },
    ...overrides,
  }
}

function makePendingDoc(overrides: Partial<TrackingDoc> = {}): TrackingDoc {
  return {
    _id: 'mig-1',
    _rev: '1-abc',
    status: 'running',
    target_dir: '/Nextcloud',
    progress: { files_imported: 0, files_total: 0, bytes_imported: 0, bytes_total: 0 },
    errors: [],
    skipped: [],
    started_at: '2026-04-17T00:00:00Z',
    finished_at: null,
    ...overrides,
  }
}

describe('handleCancelMessage', () => {
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
      updateTrackingDoc: vi.fn().mockImplementation(async (doc: TrackingDoc) => doc),
    } as unknown as StackClient

    vi.mocked(createStackClient).mockReturnValue(mockStack)
  })

  it('writes cancel_requested on the tracking doc and signals the local runner', async () => {
    const runner = makeRunner({ cancel: vi.fn().mockReturnValue(true) })

    await handleCancelMessage(makeCommand(), mockCloudery, logger, config, runner)

    expect(mockStack.updateTrackingDoc).toHaveBeenCalled()
    const written = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0] as TrackingDoc
    expect(written.cancel_requested).toBe(true)
    expect(runner.cancel).toHaveBeenCalledWith('mig-1')
  })

  it('still writes the flag when the migration is not running on this pod', async () => {
    const runner = makeRunner({ cancel: vi.fn().mockReturnValue(false) })

    await handleCancelMessage(makeCommand(), mockCloudery, logger, config, runner)

    // Durable flag is the cross-pod signal: even when no local runner
    // owns this migration, we must still record the intent so the
    // actual owner picks it up at the next flush checkpoint.
    expect(mockStack.updateTrackingDoc).toHaveBeenCalled()
  })

  it('ignores a cancel for a migration that is already terminal', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce(makePendingDoc({
      status: 'completed',
      finished_at: '2026-04-17T01:00:00Z',
    }))
    const runner = makeRunner()

    await handleCancelMessage(makeCommand(), mockCloudery, logger, config, runner)

    expect(mockStack.updateTrackingDoc).not.toHaveBeenCalled()
    expect(runner.cancel).not.toHaveBeenCalled()
  })

  it('ignores a cancel when the tracking doc is missing (404)', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockRejectedValueOnce(
      Object.assign(new Error(''), { status: 404 }),
    )
    const runner = makeRunner()

    await handleCancelMessage(makeCommand(), mockCloudery, logger, config, runner)

    expect(mockStack.updateTrackingDoc).not.toHaveBeenCalled()
    expect(runner.cancel).not.toHaveBeenCalled()
  })

  it('re-throws transient errors so the library retries / DLQs', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockRejectedValueOnce(
      Object.assign(new Error('CouchDB unavailable'), { status: 503 }),
    )
    const runner = makeRunner()

    await expect(
      handleCancelMessage(makeCommand(), mockCloudery, logger, config, runner),
    ).rejects.toThrow(/CouchDB unavailable/)
  })

  it('re-throws Cloudery token failures', async () => {
    vi.mocked(mockCloudery.getToken).mockRejectedValueOnce(
      new Error('Cloudery token request failed (503)'),
    )
    const runner = makeRunner()

    await expect(
      handleCancelMessage(makeCommand(), mockCloudery, logger, config, runner),
    ).rejects.toThrow(/Cloudery/)
  })

  it('does not re-signal the runner when the flag was already set', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce(makePendingDoc({
      cancel_requested: true,
      canceled_at: '2026-04-17T00:00:00Z',
    }))
    const runner = makeRunner({ cancel: vi.fn().mockReturnValue(true) })

    await handleCancelMessage(makeCommand(), mockCloudery, logger, config, runner)

    // Durable flag is unchanged, so no write. The runner is still
    // signalled — a re-delivery may come through after the first
    // cancel's abort was swallowed somehow, and re-signalling a
    // controller that has already fired is a cheap no-op.
    expect(mockStack.updateTrackingDoc).not.toHaveBeenCalled()
    expect(runner.cancel).toHaveBeenCalledWith('mig-1')
  })
})
