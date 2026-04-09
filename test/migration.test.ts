import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMigration } from '../src/migration.js'
import type { StackClient } from '../src/stack-client.js'
import type { MigrationCommand, TrackingDoc, NextcloudEntry } from '../src/types.js'
import type { Logger } from 'pino'

function makeStack(overrides: Partial<StackClient> = {}): StackClient {
  return {
    listNextcloudDir: vi.fn().mockResolvedValue([]),
    transferFile: vi.fn().mockResolvedValue({ id: 'f1', name: 'f', dir_id: 'd', size: 100 }),
    createDir: vi.fn().mockResolvedValue('dir-id'),
    getDiskUsage: vi.fn().mockResolvedValue({ used: 1000, quota: 100000 }),
    getTrackingDoc: vi.fn().mockResolvedValue({
      _id: 'mig-1',
      _rev: '1-abc',
      status: 'pending',
      target_dir: 'io.cozy.files.root-dir',
      progress: { files_imported: 0, files_total: 0, bytes_imported: 0, bytes_total: 0 },
      errors: [],
      skipped: [],
      started_at: null,
      finished_at: null,
    } satisfies TrackingDoc),
    updateTrackingDoc: vi.fn().mockImplementation(async (doc: TrackingDoc) => ({ ...doc, _rev: 'next' })),
    ...overrides,
  } as StackClient
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

const logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger

describe('runMigration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates target directory and transfers a flat list of files', async () => {
    const entries: NextcloudEntry[] = [
      { type: 'file', name: 'photo.jpg', path: '/photo.jpg', size: 2048, mime: 'image/jpeg' },
      { type: 'file', name: 'doc.pdf', path: '/doc.pdf', size: 1024, mime: 'application/pdf' },
    ]
    const stack = makeStack({
      listNextcloudDir: vi.fn().mockResolvedValueOnce(entries),
    })

    await runMigration(makeCommand(), stack, logger)

    // Creates /Nextcloud target directory
    expect(stack.createDir).toHaveBeenCalledWith('io.cozy.files.root-dir', 'Nextcloud')
    // Transfers both files
    expect(stack.transferFile).toHaveBeenCalledTimes(2)
    expect(stack.transferFile).toHaveBeenCalledWith('acc-123', '/photo.jpg', 'dir-id')
    expect(stack.transferFile).toHaveBeenCalledWith('acc-123', '/doc.pdf', 'dir-id')
    // Updates tracking: running, increments, updateBytesTotal, completed
    expect(stack.updateTrackingDoc).toHaveBeenCalled()
  })

  it('recursively traverses subdirectories', async () => {
    const rootEntries: NextcloudEntry[] = [
      { type: 'directory', name: 'Photos', path: '/Photos', size: 0, mime: '' },
    ]
    const subEntries: NextcloudEntry[] = [
      { type: 'file', name: 'sunset.jpg', path: '/Photos/sunset.jpg', size: 512, mime: 'image/jpeg' },
    ]
    const stack = makeStack({
      listNextcloudDir: vi.fn()
        .mockResolvedValueOnce(rootEntries)   // traverseDir lists root
        .mockResolvedValueOnce(subEntries),   // traverseDir lists /Photos
      createDir: vi.fn()
        .mockResolvedValueOnce('nextcloud-dir')   // /Nextcloud
        .mockResolvedValueOnce('photos-dir'),      // /Nextcloud/Photos
    })

    await runMigration(makeCommand(), stack, logger)

    // Creates both directories
    expect(stack.createDir).toHaveBeenCalledWith('io.cozy.files.root-dir', 'Nextcloud')
    expect(stack.createDir).toHaveBeenCalledWith('nextcloud-dir', 'Photos')
    // Transfers the file into the Photos subdirectory
    expect(stack.transferFile).toHaveBeenCalledWith('acc-123', '/Photos/sunset.jpg', 'photos-dir')
  })

  it('skips files that already exist (409 on transfer) and records them', async () => {
    const entries: NextcloudEntry[] = [
      { type: 'file', name: 'exists.txt', path: '/exists.txt', size: 100, mime: 'text/plain' },
    ]
    const stack = makeStack({
      listNextcloudDir: vi.fn().mockResolvedValueOnce(entries),
      transferFile: vi.fn().mockRejectedValueOnce(new Error('Stack request failed (409): conflict')),
    })

    await runMigration(makeCommand(), stack, logger)

    const statusUpdates = vi.mocked(stack.updateTrackingDoc).mock.calls
      .map((c) => (c[0] as TrackingDoc).status)
    expect(statusUpdates).toContain('running')
    expect(statusUpdates).toContain('completed')
    // Skipped file should be recorded in tracking doc
    const skippedUpdates = vi.mocked(stack.updateTrackingDoc).mock.calls
      .filter((c) => (c[0] as TrackingDoc).skipped.length > 0)
    expect(skippedUpdates.length).toBeGreaterThan(0)
  })

  it('records per-file errors and continues', async () => {
    const entries: NextcloudEntry[] = [
      { type: 'file', name: 'bad.txt', path: '/bad.txt', size: 100, mime: 'text/plain' },
      { type: 'file', name: 'good.txt', path: '/good.txt', size: 200, mime: 'text/plain' },
    ]
    const stack = makeStack({
      listNextcloudDir: vi.fn().mockResolvedValueOnce(entries),
      transferFile: vi.fn()
        .mockRejectedValueOnce(new Error('Stack request failed (500): internal'))
        .mockResolvedValueOnce({ id: 'f2', name: 'good.txt', dir_id: 'd', size: 200 }),
    })

    await runMigration(makeCommand(), stack, logger)

    // Error recorded in tracking doc
    const errorUpdates = vi.mocked(stack.updateTrackingDoc).mock.calls
      .filter((c) => (c[0] as TrackingDoc).errors.length > 0)
    expect(errorUpdates.length).toBeGreaterThan(0)
    // Second file still transferred
    expect(stack.transferFile).toHaveBeenCalledTimes(2)
  })

  it('continues past inaccessible subdirectories and records error', async () => {
    const entries: NextcloudEntry[] = [
      { type: 'directory', name: 'Broken', path: '/Broken', size: 0, mime: '' },
      { type: 'file', name: 'ok.txt', path: '/ok.txt', size: 100, mime: 'text/plain' },
    ]
    const stack = makeStack({
      listNextcloudDir: vi.fn()
        .mockResolvedValueOnce(entries),      // traverseDir lists root
      createDir: vi.fn()
        .mockResolvedValueOnce('target-dir')  // /Nextcloud
        .mockRejectedValueOnce(new Error('Stack request failed (500): internal')),  // /Nextcloud/Broken fails
    })

    await runMigration(makeCommand(), stack, logger)

    // Migration should complete (not fail) because directory error is caught per-entry
    const statusUpdates = vi.mocked(stack.updateTrackingDoc).mock.calls
      .map((c) => (c[0] as TrackingDoc).status)
    expect(statusUpdates).toContain('completed')
    // Error for the broken directory should be recorded
    const errorUpdates = vi.mocked(stack.updateTrackingDoc).mock.calls
      .filter((c) => (c[0] as TrackingDoc).errors.length > 0)
    expect(errorUpdates.length).toBeGreaterThan(0)
    // The file sibling should still be transferred
    expect(stack.transferFile).toHaveBeenCalledWith('acc-123', '/ok.txt', 'target-dir')
  })

  it('calls updateBytesTotal with discovered bytes and file counts after traversal', async () => {
    const entries: NextcloudEntry[] = [
      { type: 'file', name: 'a.txt', path: '/a.txt', size: 300, mime: 'text/plain' },
      { type: 'file', name: 'b.txt', path: '/b.txt', size: 700, mime: 'text/plain' },
    ]
    const stack = makeStack({
      listNextcloudDir: vi.fn().mockResolvedValueOnce(entries),
    })

    await runMigration(makeCommand(), stack, logger)

    // updateBytesTotal should be called with discovered totals: 300 + 700 = 1000 bytes, 2 files
    const bytesTotalUpdate = vi.mocked(stack.updateTrackingDoc).mock.calls
      .find((c) => {
        const doc = c[0] as TrackingDoc
        return doc.progress.bytes_total === 1000 && doc.progress.files_total === 2
      })
    expect(bytesTotalUpdate).toBeDefined()
  })
})
