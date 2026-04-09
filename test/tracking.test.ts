import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  updateTracking,
  setRunning,
  setCompleted,
  setFailed,
  incrementProgress,
  updateBytesTotal,
  addError,
  addSkipped,
} from '../src/tracking.js'
import type { StackClient } from '../src/stack-client.js'
import type { TrackingDoc } from '../src/types.js'

function makeDoc(overrides: Partial<TrackingDoc> = {}): TrackingDoc {
  return {
    _id: 'mig-1',
    _rev: '1-abc',
    status: 'pending',
    target_dir: 'io.cozy.files.root-dir',
    progress: {
      files_imported: 0,
      files_total: 0,
      bytes_imported: 0,
      bytes_total: 0,
    },
    errors: [],
    skipped: [],
    started_at: null,
    finished_at: null,
    ...overrides,
  }
}

describe('updateTracking', () => {
  let mockStack: StackClient

  beforeEach(() => {
    mockStack = {
      getTrackingDoc: vi.fn(),
      updateTrackingDoc: vi.fn(),
      listNextcloudDir: vi.fn(),
      transferFile: vi.fn(),
      createDir: vi.fn(),
      getDiskUsage: vi.fn(),
    } as unknown as StackClient
  })

  it('reads, applies updater, and writes the doc', async () => {
    const doc = makeDoc()
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce(doc)
    vi.mocked(mockStack.updateTrackingDoc).mockResolvedValueOnce({ ...doc, _rev: '2-def', status: 'running' })

    await updateTracking(mockStack, 'mig-1', (d) => ({ ...d, status: 'running' }))

    expect(mockStack.getTrackingDoc).toHaveBeenCalledWith('mig-1')
    expect(mockStack.updateTrackingDoc).toHaveBeenCalledWith({ ...doc, status: 'running' })
  })

  it('retries on 409 conflict up to 5 times', async () => {
    const doc = makeDoc()
    const error409 = new Error('Stack request failed (409): conflict')
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValue(doc)
    vi.mocked(mockStack.updateTrackingDoc)
      .mockRejectedValueOnce(error409)
      .mockRejectedValueOnce(error409)
      .mockResolvedValueOnce({ ...doc, _rev: '2-def', status: 'running' })

    await updateTracking(mockStack, 'mig-1', (d) => ({ ...d, status: 'running' }))

    // 1 initial + 2 retries = 3 calls to getTrackingDoc (re-read on each retry)
    expect(mockStack.getTrackingDoc).toHaveBeenCalledTimes(3)
    expect(mockStack.updateTrackingDoc).toHaveBeenCalledTimes(3)
  })

  it('throws after 5 consecutive 409 conflicts', async () => {
    const doc = makeDoc()
    const error409 = new Error('Stack request failed (409): conflict')
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValue(doc)
    vi.mocked(mockStack.updateTrackingDoc).mockRejectedValue(error409)

    await expect(
      updateTracking(mockStack, 'mig-1', (d) => ({ ...d, status: 'running' }))
    ).rejects.toThrow('409')
  })

  it('throws non-409 errors immediately', async () => {
    const doc = makeDoc()
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValue(doc)
    vi.mocked(mockStack.updateTrackingDoc).mockRejectedValueOnce(
      new Error('Stack request failed (500): internal error')
    )

    await expect(
      updateTracking(mockStack, 'mig-1', (d) => ({ ...d, status: 'running' }))
    ).rejects.toThrow('500')
  })
})

describe('helper functions', () => {
  let mockStack: StackClient

  beforeEach(() => {
    mockStack = {
      getTrackingDoc: vi.fn().mockResolvedValue(makeDoc()),
      updateTrackingDoc: vi.fn().mockImplementation(async (doc: TrackingDoc) => doc),
      listNextcloudDir: vi.fn(),
      transferFile: vi.fn(),
      createDir: vi.fn(),
      getDiskUsage: vi.fn(),
    } as unknown as StackClient
  })

  it('setRunning sets status, started_at, and bytes_total', async () => {
    await setRunning(mockStack, 'mig-1', 5000)

    const calledDoc = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.status).toBe('running')
    expect(calledDoc.started_at).toBeDefined()
    expect(calledDoc.progress.bytes_total).toBe(5000)
  })

  it('setCompleted sets status and finished_at', async () => {
    await setCompleted(mockStack, 'mig-1')

    const calledDoc = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.status).toBe('completed')
    expect(calledDoc.finished_at).toBeDefined()
  })

  it('setFailed sets status, finished_at, and appends error with at timestamp', async () => {
    await setFailed(mockStack, 'mig-1', 'something broke')

    const calledDoc = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.status).toBe('failed')
    expect(calledDoc.finished_at).toBeDefined()
    expect(calledDoc.errors[0].path).toBe('')
    expect(calledDoc.errors[0].message).toBe('something broke')
    expect(calledDoc.errors[0].at).toBeDefined()
  })

  it('incrementProgress adds to bytes_imported and files_imported', async () => {
    await incrementProgress(mockStack, 'mig-1', 1024)

    const calledDoc = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.progress.bytes_imported).toBe(1024)
    expect(calledDoc.progress.files_imported).toBe(1)
  })

  it('updateBytesTotal sets bytes_total and files_total in progress', async () => {
    await updateBytesTotal(mockStack, 'mig-1', 9000, 12)

    const calledDoc = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.progress.bytes_total).toBe(9000)
    expect(calledDoc.progress.files_total).toBe(12)
  })

  it('addError appends to errors array with at field', async () => {
    await addError(mockStack, 'mig-1', '/bad-file.txt', 'transfer failed')

    const calledDoc = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.errors[0].path).toBe('/bad-file.txt')
    expect(calledDoc.errors[0].message).toBe('transfer failed')
    expect(calledDoc.errors[0].at).toBeDefined()
  })

  it('addSkipped appends to skipped array', async () => {
    await addSkipped(mockStack, 'mig-1', '/huge.iso', 'exceeds quota', 999999)

    const calledDoc = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.skipped).toContainEqual({ path: '/huge.iso', reason: 'exceeds quota', size: 999999 })
  })
})
