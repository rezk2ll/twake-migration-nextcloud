import type { StackClient } from '../clients/stack-client.js'
import type { TrackingDoc, TrackingError, TrackingSkipped } from './types.js'

const MAX_CONFLICT_RETRIES = 5

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
 * Transitions the tracking document to "running".
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 * @param bytesTotal - Initial estimated total bytes (from Nextcloud quota)
 */
export async function setRunning(
  stackClient: StackClient,
  docId: string,
  bytesTotal: number
): Promise<void> {
  const startedAt = new Date().toISOString()
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    status: 'running',
    started_at: startedAt,
    progress: {
      ...doc.progress,
      bytes_total: bytesTotal,
    },
  }))
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
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    status: 'completed',
    finished_at: finishedAt,
  }))
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
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    status: 'failed',
    finished_at: now,
    errors: [...doc.errors, { path: '', message: errorMessage, at: now }],
  }))
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
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    progress: {
      ...doc.progress,
      bytes_imported: doc.progress.bytes_imported + local.bytesImported,
      files_imported: doc.progress.files_imported + local.filesImported,
      files_total: filesDiscovered,
    },
    errors: [...doc.errors, ...local.errors],
    skipped: [...doc.skipped, ...local.skipped],
  }))
}
