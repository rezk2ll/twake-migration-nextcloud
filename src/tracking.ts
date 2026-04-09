import type { StackClient } from './stack-client.js'
import type { TrackingDoc } from './types.js'

const MAX_CONFLICT_RETRIES = 5

export function isConflictError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(409)')
}

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
