import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  updateTracking,
  setRunning,
  setCompleted,
  setFailed,
  flushProgress,
} from '../src/tracking.js'
import type { StackClient } from '../src/stack-client.js'
import type { TrackingDoc } from '../src/types.js'

function makeDoc(overrides: Partial<TrackingDoc> = {}): TrackingDoc {
  return {
    _id: 'mig-1',
    _rev: '1-abc',
    status: 'pending',
    target_dir: '/Nextcloud',
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

function makeMockStack(doc?: TrackingDoc): StackClient {
  return {
    getTrackingDoc: vi.fn().mockResolvedValue(doc ?? makeDoc()),
    updateTrackingDoc: vi.fn().mockImplementation(async (d: TrackingDoc) => d),
    listNextcloudDir: vi.fn(),
    transferFile: vi.fn(),
    createDir: vi.fn(),
    getDiskUsage: vi.fn(),
  } as unknown as StackClient
}

describe('updateTracking', () => {
  it('reads, applies updater, and writes the doc', async () => {
    const doc = makeDoc()
    const stack = makeMockStack(doc)

    await updateTracking(stack, 'mig-1', (d) => ({ ...d, status: 'running' }))

    expect(stack.getTrackingDoc).toHaveBeenCalledWith('mig-1')
    expect(stack.updateTrackingDoc).toHaveBeenCalledWith({ ...doc, status: 'running' })
  })

  it('retries on 409 conflict', async () => {
    const doc = makeDoc()
    const stack = makeMockStack(doc)
    const error409 = new Error('Stack request failed (409): conflict')
    vi.mocked(stack.updateTrackingDoc)
      .mockRejectedValueOnce(error409)
      .mockRejectedValueOnce(error409)
      .mockResolvedValueOnce({ ...doc, _rev: '2-def', status: 'running' })

    await updateTracking(stack, 'mig-1', (d) => ({ ...d, status: 'running' }))

    expect(stack.getTrackingDoc).toHaveBeenCalledTimes(3)
    expect(stack.updateTrackingDoc).toHaveBeenCalledTimes(3)
  })

  it('throws after 5 consecutive 409 conflicts', async () => {
    const stack = makeMockStack()
    vi.mocked(stack.updateTrackingDoc).mockRejectedValue(new Error('Stack request failed (409): conflict'))

    await expect(
      updateTracking(stack, 'mig-1', (d) => ({ ...d, status: 'running' }))
    ).rejects.toThrow('409')
  })

  it('throws non-409 errors immediately', async () => {
    const stack = makeMockStack()
    vi.mocked(stack.updateTrackingDoc).mockRejectedValueOnce(new Error('Stack request failed (500): internal'))

    await expect(
      updateTracking(stack, 'mig-1', (d) => ({ ...d, status: 'running' }))
    ).rejects.toThrow('500')
  })
})

describe('setRunning', () => {
  it('sets status, started_at, and progress.bytes_total', async () => {
    const stack = makeMockStack()
    await setRunning(stack, 'mig-1', 5000)

    const calledDoc = vi.mocked(stack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.status).toBe('running')
    expect(calledDoc.started_at).toBeDefined()
    expect(calledDoc.progress.bytes_total).toBe(5000)
  })
})

describe('setCompleted', () => {
  it('sets status and finished_at', async () => {
    const stack = makeMockStack()
    await setCompleted(stack, 'mig-1')

    const calledDoc = vi.mocked(stack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.status).toBe('completed')
    expect(calledDoc.finished_at).toBeDefined()
  })
})

describe('setFailed', () => {
  it('sets status, finished_at, and appends error with timestamp', async () => {
    const stack = makeMockStack()
    await setFailed(stack, 'mig-1', 'something broke')

    const calledDoc = vi.mocked(stack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.status).toBe('failed')
    expect(calledDoc.finished_at).toBeDefined()
    expect(calledDoc.errors[0]).toMatchObject({ path: '', message: 'something broke' })
    expect(calledDoc.errors[0].at).toBeDefined()
  })
})

describe('flushProgress', () => {
  it('merges local deltas into the remote doc in a single write', async () => {
    const doc = makeDoc({
      progress: { bytes_imported: 100, files_imported: 2, bytes_total: 0, files_total: 0 },
      errors: [{ path: '/old.txt', message: 'old error', at: '2024-01-01T00:00:00Z' }],
    })
    const stack = makeMockStack(doc)

    await flushProgress(stack, 'mig-1', {
      bytesImported: 500,
      filesImported: 3,
      bytesTotal: 9000,
      filesTotal: 20,
      errors: [{ path: '/new.txt', message: 'new error', at: '2024-01-02T00:00:00Z' }],
      skipped: [{ path: '/dup.txt', reason: 'already exists', size: 42 }],
    })

    const calledDoc = vi.mocked(stack.updateTrackingDoc).mock.calls[0][0]
    // Deltas are added to existing values
    expect(calledDoc.progress.bytes_imported).toBe(600)
    expect(calledDoc.progress.files_imported).toBe(5)
    // Totals are replaced (latest discovered values)
    expect(calledDoc.progress.bytes_total).toBe(9000)
    expect(calledDoc.progress.files_total).toBe(20)
    // Errors and skipped are appended
    expect(calledDoc.errors).toHaveLength(2)
    expect(calledDoc.skipped).toHaveLength(1)
  })

  it('retries on 409 with reapplied patch', async () => {
    const stack = makeMockStack()
    vi.mocked(stack.updateTrackingDoc)
      .mockRejectedValueOnce(new Error('Stack request failed (409): conflict'))
      .mockResolvedValueOnce(makeDoc())

    await flushProgress(stack, 'mig-1', {
      bytesImported: 100, filesImported: 1,
      bytesTotal: 100, filesTotal: 1,
      errors: [], skipped: [],
    })

    // Re-reads doc and reapplies patch
    expect(stack.getTrackingDoc).toHaveBeenCalledTimes(2)
    expect(stack.updateTrackingDoc).toHaveBeenCalledTimes(2)
  })
})
