import type { StackClient } from '../clients/stack-client.js'
import type { TrackingDoc, TrackingError, TrackingSkipped } from './types.js'

const MAX_CONFLICT_RETRIES = 5

/**
 * Age after which a `running` tracking doc is considered a zombie from
 * a crashed consumer rather than an in-flight migration. Chosen
 * comfortably larger than the longest legitimate gap between flushes:
 * a single file transfer can last up to TRANSFER_TIMEOUT_MS (15 min)
 * with no heartbeat, so we need room for that plus a safety margin.
 */
export const STALE_HEARTBEAT_MS = 30 * 60_000

/**
 * @param doc - Tracking document
 * @param now - Override for the current time in ms (tests)
 * @returns true when `doc.status === 'running'` but the heartbeat is
 *   older than {@link STALE_HEARTBEAT_MS}. Legacy docs with no
 *   heartbeat fall back to `started_at`; if that is also missing the
 *   doc is treated as stale.
 */
export function isStaleRunning(doc: TrackingDoc, now: number = Date.now()): boolean {
  if (doc.status !== 'running') return false
  const heartbeat = doc.last_heartbeat_at ?? doc.started_at
  if (!heartbeat) return true
  return now - Date.parse(heartbeat) > STALE_HEARTBEAT_MS
}

/**
 * Raised when a state transition would violate the tracking-doc
 * invariants (e.g. a late writer trying to demote `completed` back
 * to `failed`). The caller typically logs and moves on — the guard
 * exists so a stale consumer cannot clobber a new run's result.
 */
export class IllegalStatusTransitionError extends Error {
  constructor(from: TrackingDoc['status'], to: TrackingDoc['status']) {
    super(`Illegal tracking-doc transition: ${from} -> ${to}`)
    this.name = 'IllegalStatusTransitionError'
  }
}

/**
 * @param error - Caught error value
 * @returns true if the error represents an HTTP/CouchDB 409 conflict
 */
export function isConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.message.includes('(409)')) return true
  // cozy-stack-client's FetchError exposes the HTTP status directly but
  // leaves `.message` empty, so message-matching alone misses every Stack
  // 409. Fall through to the status field so callers catch both shapes.
  return (error as { status?: number }).status === 409
}

/**
 * Read-modify-write with automatic retry on CouchDB 409 conflicts.
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 * @param updater - Pure function that produces the updated document
 * @throws After {@link MAX_CONFLICT_RETRIES} consecutive 409s, or on any non-409 error
 */
export async function updateTracking(
  stackClient: StackClient,
  docId: string,
  updater: (doc: TrackingDoc) => TrackingDoc
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const doc = await stackClient.getTrackingDoc(docId)
    const updated = updater(doc)
    // Same reference means the updater has nothing to write (idempotent
    // no-op such as setCompleted on an already-completed doc). Skipping
    // the write also skips the CouchDB round trip.
    if (updated === doc) return
    try {
      await stackClient.updateTrackingDoc(updated)
      return
    } catch (error) {
      if (!isConflictError(error) || attempt === MAX_CONFLICT_RETRIES - 1) {
        throw error
      }
    }
  }
}

/**
 * Transitions the tracking document to "running". Preserves any
 * existing `started_at` (so a resumed stale migration keeps its
 * original timestamp) and stamps the heartbeat so a fresh consumer
 * marks the doc actively-running immediately.
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 * @param bytesTotal - Initial estimated total bytes (from Nextcloud quota)
 */
export async function setRunning(
  stackClient: StackClient,
  docId: string,
  bytesTotal: number
): Promise<void> {
  const now = new Date().toISOString()
  await updateTracking(stackClient, docId, (doc) => {
    if (doc.status === 'completed') {
      throw new IllegalStatusTransitionError(doc.status, 'running')
    }
    return {
      ...doc,
      status: 'running',
      started_at: doc.started_at ?? now,
      last_heartbeat_at: now,
      progress: {
        ...doc.progress,
        bytes_total: bytesTotal,
      },
    }
  })
}

/**
 * Transitions the tracking document to "completed".
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 */
export async function setCompleted(
  stackClient: StackClient,
  docId: string
): Promise<void> {
  const finishedAt = new Date().toISOString()
  await updateTracking(stackClient, docId, (doc) => {
    if (doc.status === 'completed') return doc
    if (doc.status === 'failed') {
      throw new IllegalStatusTransitionError(doc.status, 'completed')
    }
    return { ...doc, status: 'completed', finished_at: finishedAt }
  })
}

/**
 * Transitions the tracking document to "failed" and records the error.
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 * @param errorMessage - Human-readable failure reason
 */
export async function setFailed(
  stackClient: StackClient,
  docId: string,
  errorMessage: string
): Promise<void> {
  const now = new Date().toISOString()
  await updateTracking(stackClient, docId, (doc) => {
    if (doc.status === 'failed') return doc
    if (doc.status === 'completed') {
      throw new IllegalStatusTransitionError(doc.status, 'failed')
    }
    return {
      ...doc,
      status: 'failed',
      finished_at: now,
      errors: [...doc.errors, { path: '', message: errorMessage, at: now }],
    }
  })
}

/** Local progress deltas accumulated between flushes. */
export interface LocalProgress {
  bytesImported: number
  filesImported: number
  errors: TrackingError[]
  skipped: TrackingSkipped[]
}

/**
 * @returns A zeroed LocalProgress with empty arrays, ready to accumulate deltas.
 */
export function emptyLocalProgress(): LocalProgress {
  return { bytesImported: 0, filesImported: 0, errors: [], skipped: [] }
}

/**
 * Flushes locally accumulated progress to CouchDB in a single write.
 * On 409, re-reads _rev and reapplies the patch.
 *
 * `bytes_total` is intentionally preserved across flushes: it is seeded
 * once by [setRunning] from the authoritative Nextcloud `oc:size` total
 * and must stay stable so the UI can render a meaningful progress bar.
 * `files_total` is still updated from the walk because Nextcloud does
 * not expose a cheap recursive file count, so the frontend should treat
 * it as a best-effort counter rather than a stable denominator.
 *
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 * @param local - Accumulated deltas since last flush
 * @param filesDiscovered - Total files discovered so far during traversal
 */
export async function flushProgress(
  stackClient: StackClient,
  docId: string,
  local: LocalProgress,
  filesDiscovered: number
): Promise<void> {
  const now = new Date().toISOString()
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    last_heartbeat_at: now,
    ...mergeLocalProgress(doc, local, filesDiscovered),
  }))
}

/**
 * Atomic terminal write for the success path: applies any pending
 * progress deltas AND transitions to `completed` in a single CouchDB
 * round trip. Previously the migration did `flushProgress` followed
 * by `setCompleted` as two separate writes; a crash in between left
 * the doc stuck in `running` with full progress but no terminal
 * status — a zombie the heartbeat logic would eventually reclaim.
 *
 * Same transition guards as {@link setCompleted}: no-op when the doc
 * is already `completed`, refuses to overwrite `failed`.
 *
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 * @param local - Pending deltas accumulated since the last flush
 * @param filesDiscovered - Total files discovered during traversal
 */
export async function flushAndComplete(
  stackClient: StackClient,
  docId: string,
  local: LocalProgress,
  filesDiscovered: number,
): Promise<void> {
  const now = new Date().toISOString()
  await updateTracking(stackClient, docId, (doc) => {
    if (doc.status === 'completed') return doc
    if (doc.status === 'failed') {
      throw new IllegalStatusTransitionError(doc.status, 'completed')
    }
    return {
      ...doc,
      status: 'completed',
      finished_at: now,
      last_heartbeat_at: now,
      ...mergeLocalProgress(doc, local, filesDiscovered),
    }
  })
}

/**
 * Atomic terminal write for the failure path: applies any pending
 * progress deltas AND transitions to `failed` in a single CouchDB
 * round trip. The fatal error message is appended to the per-file
 * `errors` array with an empty `path` to mark it as a migration-level
 * failure rather than a specific-file failure.
 *
 * Same transition guards as {@link setFailed}: no-op when already
 * failed, refuses to overwrite `completed`.
 *
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 * @param errorMessage - Human-readable failure reason
 * @param local - Pending deltas accumulated since the last flush
 * @param filesDiscovered - Total files discovered during traversal
 */
export async function flushAndFail(
  stackClient: StackClient,
  docId: string,
  errorMessage: string,
  local: LocalProgress,
  filesDiscovered: number,
): Promise<void> {
  const now = new Date().toISOString()
  await updateTracking(stackClient, docId, (doc) => {
    if (doc.status === 'failed') return doc
    if (doc.status === 'completed') {
      throw new IllegalStatusTransitionError(doc.status, 'failed')
    }
    const merged = mergeLocalProgress(doc, local, filesDiscovered)
    return {
      ...doc,
      status: 'failed',
      finished_at: now,
      last_heartbeat_at: now,
      ...merged,
      errors: [...merged.errors, { path: '', message: errorMessage, at: now }],
    }
  })
}

/**
 * Shared merger for the flush + terminal writes: adds local deltas to
 * the remote progress counters (never rewriting `bytes_total`),
 * updates `files_total` to the live discovery count, and concatenates
 * per-file errors and skips.
 */
function mergeLocalProgress(
  doc: TrackingDoc,
  local: LocalProgress,
  filesDiscovered: number,
): Pick<TrackingDoc, 'progress' | 'errors' | 'skipped'> {
  return {
    progress: {
      ...doc.progress,
      bytes_imported: doc.progress.bytes_imported + local.bytesImported,
      files_imported: doc.progress.files_imported + local.filesImported,
      files_total: filesDiscovered,
    },
    errors: [...doc.errors, ...local.errors],
    skipped: [...doc.skipped, ...local.skipped],
  }
}
