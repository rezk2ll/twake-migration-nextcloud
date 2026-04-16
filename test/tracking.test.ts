import { describe, it, expect, vi } from 'vitest'
import {
  updateTracking,
  setRunning,
  setCompleted,
  setFailed,
  flushProgress,
  isConflictError,
  isStaleRunning,
  STALE_HEARTBEAT_MS,
  IllegalStatusTransitionError,
} from '../src/domain/tracking.js'
import type { StackClient } from '../src/clients/stack-client.js'
import type { TrackingDoc } from '../src/domain/types.js'

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
  // Stateful fake: every updateTrackingDoc call replaces the stored doc, so
  // subsequent getTrackingDoc calls see the result of the previous write.
  // Tests that chain multiple tracking writes (notably the cross-flush
  // invariants) depend on this to exercise the real read-modify-write loop.
  let current = doc ?? makeDoc()
  return {
    getTrackingDoc: vi.fn().mockImplementation(async () => current),
    updateTrackingDoc: vi.fn().mockImplementation(async (d: TrackingDoc) => {
      current = d
      return d
    }),
    listNextcloudDir: vi.fn(),
    transferFile: vi.fn(),
    createDir: vi.fn(),
    getDiskUsage: vi.fn(),
  } as unknown as StackClient
}

describe('isConflictError', () => {
  it('detects a legacy (409) message', () => {
    expect(isConflictError(new Error('Something (409) Conflict'))).toBe(true)
  })

  it('detects a FetchError-shaped 409 with only a status property', () => {
    // cozy-stack-client's FetchError sets `.status` but leaves `.message`
    // empty, so matching on message alone misses every Stack 409.
    const err = Object.assign(new Error(''), { name: 'FetchError', status: 409 })
    expect(isConflictError(err)).toBe(true)
  })

  it('returns false for non-Error values', () => {
    expect(isConflictError(null)).toBe(false)
    expect(isConflictError('409')).toBe(false)
    expect(isConflictError({ status: 409 })).toBe(false)
  })

  it('returns false for unrelated statuses', () => {
    const err = Object.assign(new Error(''), { status: 500 })
    expect(isConflictError(err)).toBe(false)
  })
})

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
  it('sets status, started_at, heartbeat, and progress.bytes_total', async () => {
    const stack = makeMockStack()
    await setRunning(stack, 'mig-1', 5000)

    const calledDoc = vi.mocked(stack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.status).toBe('running')
    expect(calledDoc.started_at).toBeDefined()
    expect(calledDoc.last_heartbeat_at).toBeDefined()
    expect(calledDoc.progress.bytes_total).toBe(5000)
  })

  it('preserves the original started_at when resuming a stale migration', async () => {
    const originalStart = '2024-01-01T00:00:00.000Z'
    const stack = makeMockStack(makeDoc({
      status: 'running',
      started_at: originalStart,
      last_heartbeat_at: originalStart,
    }))

    await setRunning(stack, 'mig-1', 5000)

    const calledDoc = vi.mocked(stack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.started_at).toBe(originalStart)
    expect(calledDoc.last_heartbeat_at).not.toBe(originalStart)
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
      progress: { bytes_imported: 100, files_imported: 2, bytes_total: 67365343, files_total: 0 },
      errors: [{ path: '/old.txt', message: 'old error', at: '2024-01-01T00:00:00Z' }],
    })
    const stack = makeMockStack(doc)

    await flushProgress(stack, 'mig-1', {
      bytesImported: 500,
      filesImported: 3,
      errors: [{ path: '/new.txt', message: 'new error', at: '2024-01-02T00:00:00Z' }],
      skipped: [{ path: '/dup.txt', reason: 'already exists', size: 42 }],
    }, 20)

    const calledDoc = vi.mocked(stack.updateTrackingDoc).mock.calls[0][0]
    // Deltas are added to existing values
    expect(calledDoc.progress.bytes_imported).toBe(600)
    expect(calledDoc.progress.files_imported).toBe(5)
    // bytes_total is preserved from setRunning (never overwritten here)
    expect(calledDoc.progress.bytes_total).toBe(67365343)
    // files_total tracks the live discovered count
    expect(calledDoc.progress.files_total).toBe(20)
    // Errors and skipped are appended
    expect(calledDoc.errors).toHaveLength(2)
    expect(calledDoc.skipped).toHaveLength(1)
  })

  it('never rewrites bytes_total once setRunning has seeded it', async () => {
    // Two consecutive flushes against a stateful mock. bytes_total must
    // survive both writes unchanged so the UI sees a stable denominator.
    // bytes_imported must accumulate across flushes (first 100, then
    // +500), which only works because the mock now replays the previous
    // write on the next read.
    const doc = makeDoc({
      progress: { bytes_imported: 0, files_imported: 0, bytes_total: 1000000, files_total: 0 },
    })
    const stack = makeMockStack(doc)

    await flushProgress(stack, 'mig-1', { bytesImported: 100, filesImported: 1, errors: [], skipped: [] }, 5)
    await flushProgress(stack, 'mig-1', { bytesImported: 500, filesImported: 2, errors: [], skipped: [] }, 12)

    const calls = vi.mocked(stack.updateTrackingDoc).mock.calls
    expect(calls[0][0].progress.bytes_total).toBe(1000000)
    expect(calls[1][0].progress.bytes_total).toBe(1000000)
    expect(calls[0][0].progress.bytes_imported).toBe(100)
    expect(calls[1][0].progress.bytes_imported).toBe(600)
    expect(calls[0][0].progress.files_total).toBe(5)
    expect(calls[1][0].progress.files_total).toBe(12)
  })

  it('retries on 409 with reapplied patch', async () => {
    const stack = makeMockStack()
    vi.mocked(stack.updateTrackingDoc)
      .mockRejectedValueOnce(new Error('Stack request failed (409): conflict'))
      .mockResolvedValueOnce(makeDoc())

    await flushProgress(stack, 'mig-1', {
      bytesImported: 100, filesImported: 1,
      errors: [], skipped: [],
    }, 1)

    // Re-reads doc and reapplies patch
    expect(stack.getTrackingDoc).toHaveBeenCalledTimes(2)
    expect(stack.updateTrackingDoc).toHaveBeenCalledTimes(2)
  })

  it('stamps last_heartbeat_at on every flush', async () => {
    const stack = makeMockStack()
    await flushProgress(stack, 'mig-1', {
      bytesImported: 1, filesImported: 1, errors: [], skipped: [],
    }, 1)

    const calledDoc = vi.mocked(stack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.last_heartbeat_at).toBeDefined()
  })
})

describe('status transition guards', () => {
  it('setRunning rejects a completed doc', async () => {
    const stack = makeMockStack(makeDoc({ status: 'completed' }))

    await expect(setRunning(stack, 'mig-1', 1000)).rejects.toBeInstanceOf(
      IllegalStatusTransitionError,
    )
    expect(stack.updateTrackingDoc).not.toHaveBeenCalled()
  })

  it('setCompleted on an already-completed doc is a silent no-op', async () => {
    const stack = makeMockStack(makeDoc({ status: 'completed' }))

    await setCompleted(stack, 'mig-1')
    expect(stack.updateTrackingDoc).not.toHaveBeenCalled()
  })

  it('setCompleted refuses to overwrite a failed doc', async () => {
    const stack = makeMockStack(makeDoc({ status: 'failed' }))

    await expect(setCompleted(stack, 'mig-1')).rejects.toBeInstanceOf(
      IllegalStatusTransitionError,
    )
    expect(stack.updateTrackingDoc).not.toHaveBeenCalled()
  })

  it('setFailed on an already-failed doc is a silent no-op', async () => {
    const stack = makeMockStack(makeDoc({ status: 'failed' }))

    await setFailed(stack, 'mig-1', 'again')
    expect(stack.updateTrackingDoc).not.toHaveBeenCalled()
  })

  it('setFailed refuses to overwrite a completed doc', async () => {
    const stack = makeMockStack(makeDoc({ status: 'completed' }))

    await expect(setFailed(stack, 'mig-1', 'late failure')).rejects.toBeInstanceOf(
      IllegalStatusTransitionError,
    )
    expect(stack.updateTrackingDoc).not.toHaveBeenCalled()
  })

  it('setRunning on a failed doc is allowed (retry path)', async () => {
    const stack = makeMockStack(makeDoc({ status: 'failed' }))

    await setRunning(stack, 'mig-1', 1000)

    const calledDoc = vi.mocked(stack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.status).toBe('running')
  })
})

describe('isStaleRunning', () => {
  const now = Date.UTC(2024, 5, 1, 12, 0, 0)

  it('returns false for non-running docs', () => {
    expect(isStaleRunning(makeDoc({ status: 'pending' }), now)).toBe(false)
    expect(isStaleRunning(makeDoc({ status: 'completed' }), now)).toBe(false)
    expect(isStaleRunning(makeDoc({ status: 'failed' }), now)).toBe(false)
  })

  it('returns false when the heartbeat is within the threshold', () => {
    const recent = new Date(now - STALE_HEARTBEAT_MS + 1).toISOString()
    const doc = makeDoc({ status: 'running', last_heartbeat_at: recent })
    expect(isStaleRunning(doc, now)).toBe(false)
  })

  it('returns true when the heartbeat is older than the threshold', () => {
    const old = new Date(now - STALE_HEARTBEAT_MS - 1).toISOString()
    const doc = makeDoc({ status: 'running', last_heartbeat_at: old })
    expect(isStaleRunning(doc, now)).toBe(true)
  })

  it('falls back to started_at for docs with no heartbeat field', () => {
    const old = new Date(now - STALE_HEARTBEAT_MS - 1).toISOString()
    const doc = makeDoc({ status: 'running', started_at: old })
    expect(isStaleRunning(doc, now)).toBe(true)
  })

  it('treats a running doc with no timestamps at all as stale', () => {
    const doc = makeDoc({ status: 'running', started_at: null })
    expect(isStaleRunning(doc, now)).toBe(true)
  })
})
