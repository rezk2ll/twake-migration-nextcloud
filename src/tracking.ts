import type { StackClient } from './stack-client.js'
import type { TrackingDoc } from './types.js'

const MAX_CONFLICT_RETRIES = 5

/**
 * @param error - Caught error value
 * @returns true if the error is a CouchDB 409 conflict
 */
export function isConflictError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(409)')
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

/**
 * Increments progress counters after a successful file transfer.
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 * @param fileSize - Size in bytes of the transferred file
 */
export async function incrementProgress(
  stackClient: StackClient,
  docId: string,
  fileSize: number
): Promise<void> {
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    progress: {
      ...doc.progress,
      bytes_imported: doc.progress.bytes_imported + fileSize,
      files_imported: doc.progress.files_imported + 1,
    },
  }))
}

/**
 * Refines the total counters to actual discovered values after traversal completes.
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 * @param bytesTotal - Actual total bytes discovered during traversal
 * @param filesTotal - Actual total file count discovered during traversal
 */
export async function updateBytesTotal(
  stackClient: StackClient,
  docId: string,
  bytesTotal: number,
  filesTotal: number
): Promise<void> {
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    progress: {
      ...doc.progress,
      bytes_total: bytesTotal,
      files_total: filesTotal,
    },
  }))
}

/**
 * Records a per-file error in the tracking document.
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 * @param path - Nextcloud path of the file that failed
 * @param message - Error description
 */
export async function addError(
  stackClient: StackClient,
  docId: string,
  path: string,
  message: string
): Promise<void> {
  const at = new Date().toISOString()
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    errors: [...doc.errors, { path, message, at }],
  }))
}

/**
 * Records a skipped file in the tracking document.
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 * @param path - Nextcloud path of the skipped file
 * @param reason - Why the file was skipped
 * @param size - Size in bytes of the skipped file
 */
export async function addSkipped(
  stackClient: StackClient,
  docId: string,
  path: string,
  reason: string,
  size: number
): Promise<void> {
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    skipped: [...doc.skipped, { path, reason, size }],
  }))
}
