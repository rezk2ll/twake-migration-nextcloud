import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMigration } from '../src/domain/migration.js'
import type { StackClient, NextcloudEntry } from '../src/clients/stack-client.js'
import type { MigrationCommand, TrackingDoc } from '../src/domain/types.js'
import type { Logger } from 'pino'

function makeStack(overrides: Partial<StackClient> = {}): StackClient {
  return {
    listNextcloudDir: vi.fn().mockResolvedValue([]),
    transferFile: vi.fn().mockResolvedValue({ id: 'f1', name: 'f', dir_id: 'd', size: 100 }),
    ensureDirPath: vi.fn().mockResolvedValue({ id: 'dir-id', path: '/Nextcloud' }),
    ensureChildDir: vi.fn().mockImplementation(async (name: string, parent: { id: string; path: string }) => ({
      id: `${parent.id}/${name}`,
      path: `${parent.path}/${name}`,
    })),
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

    await runMigration(makeCommand(), stack, logger, 0, '/Nextcloud')

    // Uses the Stack's path-based ensureDir helper; no 409 dance.
    expect(stack.ensureDirPath).toHaveBeenCalledWith('/Nextcloud')
    // Transfers both files into the target dir id returned by ensureDirPath.
    expect(stack.transferFile).toHaveBeenCalledTimes(2)
    expect(stack.transferFile).toHaveBeenCalledWith('acc-123', '/photo.jpg', 'dir-id')
    expect(stack.transferFile).toHaveBeenCalledWith('acc-123', '/doc.pdf', 'dir-id')
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
        .mockResolvedValueOnce(rootEntries)
        .mockResolvedValueOnce(subEntries),
      ensureDirPath: vi.fn().mockResolvedValue({ id: 'nextcloud-dir', path: '/Nextcloud' }),
      ensureChildDir: vi.fn().mockResolvedValueOnce({ id: 'photos-dir', path: '/Nextcloud/Photos' }),
    })

    await runMigration(makeCommand(), stack, logger, 0, '/Nextcloud')

    expect(stack.ensureDirPath).toHaveBeenCalledWith('/Nextcloud')
    expect(stack.ensureChildDir).toHaveBeenCalledWith(
      'Photos',
      { id: 'nextcloud-dir', path: '/Nextcloud' },
    )
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

    await runMigration(makeCommand(), stack, logger, 0, '/Nextcloud')

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

    await runMigration(makeCommand(), stack, logger, 0, '/Nextcloud')

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
      listNextcloudDir: vi.fn().mockResolvedValueOnce(entries),
      ensureDirPath: vi.fn().mockResolvedValue({ id: 'target-dir', path: '/Nextcloud' }),
      ensureChildDir: vi.fn().mockRejectedValueOnce(
        new Error('Stack request failed (500): internal'),
      ),
    })

    await runMigration(makeCommand(), stack, logger, 0, '/Nextcloud')

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

  it('creates the nested target_dir in a single ensureDirPath call', async () => {
    const entries: NextcloudEntry[] = [
      { type: 'file', name: 'photo.jpg', path: '/photo.jpg', size: 100, mime: 'image/jpeg' },
    ]
    const stack = makeStack({
      listNextcloudDir: vi.fn().mockResolvedValueOnce(entries),
      ensureDirPath: vi.fn().mockResolvedValue({
        id: 'from-nc-id',
        path: '/Imports/From Nextcloud',
      }),
    })

    await runMigration(makeCommand(), stack, logger, 0, '/Imports/From Nextcloud')

    // The library walks and creates each segment internally; our
    // migrator no longer loops over segments itself.
    expect(stack.ensureDirPath).toHaveBeenCalledTimes(1)
    expect(stack.ensureDirPath).toHaveBeenCalledWith('/Imports/From Nextcloud')
    expect(stack.transferFile).toHaveBeenCalledWith('acc-123', '/photo.jpg', 'from-nc-id')
  })

  it('handles pathologically deep trees without overflowing the call stack', async () => {
    // Recursive traversal blew up around 10k frames. The iterative
    // walker uses an explicit heap stack, so a chain of 5000 nested
    // directories should finish without a RangeError.
    const DEPTH = 5_000
    const listMock = vi.fn().mockImplementation(async (_acc: string, path: string) => {
      if (path === '/deepest/leaf.txt') return []
      // Every intermediate directory contains a single child directory.
      const depth = path === '/' ? 0 : path.split('/').filter(Boolean).length
      if (depth < DEPTH) {
        return [
          { type: 'directory', name: `d${depth}`, path: `${path === '/' ? '' : path}/d${depth}`, size: 0, mime: '' },
        ]
      }
      // At the deepest level, a single file ends the chain.
      return [
        { type: 'file', name: 'leaf.txt', path: `${path}/leaf.txt`, size: 1, mime: 'text/plain' },
      ]
    })
    const stack = makeStack({
      listNextcloudDir: listMock,
      ensureChildDir: vi.fn().mockImplementation(async (name, parent) => ({
        id: `${parent.id}/${name}`,
        path: `${parent.path}/${name}`,
      })),
      transferFile: vi.fn().mockResolvedValue({ id: 'leaf', name: 'leaf.txt', dir_id: 'd', size: 1 }),
    })

    await runMigration(makeCommand(), stack, logger, 0, '/Nextcloud')

    expect(stack.transferFile).toHaveBeenCalledTimes(1)
    // Every level should have been listed.
    expect(listMock.mock.calls.length).toBeGreaterThan(DEPTH)
  })

  it('seeds bytes_total on the running-state update from the passed argument', async () => {
    // The frontend renders a progress bar from bytes_imported / bytes_total,
    // so bytes_total must be set once at the start (from the pre-flight
    // oc:size total) rather than growing from 0 during traversal. That
    // seeding happens in the setRunning call that runMigration issues
    // before it starts walking the tree. (The companion invariant that
    // subsequent flushes must not rewrite bytes_total lives in
    // tracking.test.ts, which has a stateful mock.)
    const entries: NextcloudEntry[] = [
      { type: 'file', name: 'a.txt', path: '/a.txt', size: 300, mime: 'text/plain' },
    ]
    const stack = makeStack({
      listNextcloudDir: vi.fn().mockResolvedValueOnce(entries),
    })

    await runMigration(makeCommand(), stack, logger, 12345, '/Nextcloud')

    const runningUpdate = vi.mocked(stack.updateTrackingDoc).mock.calls
      .map((c) => c[0] as TrackingDoc)
      .find((d) => d.status === 'running')
    expect(runningUpdate).toBeDefined()
    expect(runningUpdate?.progress.bytes_total).toBe(12345)
  })
})
