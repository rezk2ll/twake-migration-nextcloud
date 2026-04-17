import type { StackClient } from '../clients/stack-client.js'
import type { TrackingDoc, TrackingError, TrackingSkipped } from './types.js'
import { CancellationRequestedError } from './errors.js'

const MAX_CONFLICT_RETRIES = 5

/** Current schema version stamped on every write. */
export const TRACKING_SCHEMA_VERSION = 2

/**
 * Maximum number of entries we keep in the `errors` and `skipped`
 * arrays. Per-file noise on a large migration can otherwise grow the
 * tracking doc past CouchDB's document-size ceiling. Overflow is
 * counted in the sibling `*_truncated_count` fields so consumers can
 * still show a total while displaying only the most recent entries.
 */
export const MAX_ERRORS_CAP = 1000
export const MAX_SKIPPED_CAP = 1000

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
 * @returns true when `status` is a final state that no further write
 *   should demote. Terminal writes (`setCompleted`, `setFailed`,
 *   `flushAndCancel`, …) use this to refuse transitions that would
 *   overwrite a peer terminal state, and the request handler uses it
 *   to short-circuit before launching.
 */
export function isTerminal(status: TrackingDoc['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled'
}

/**
 * Raised when a state transition would violate the tracking-doc
 * invariants (e.g. a late writer trying to demote `completed` back
 * to `failed`). The caller typically logs and moves on — the guard
 * exists so a stale consumer cannot clobber a new run's result.
 */
export class IllegalStatusTransitionError extends Error {
  constructor(
    public readonly from: TrackingDoc['status'],
    public readonly to: TrackingDoc['status'],
  ) {
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
 *
 * Two short-circuits inside the updater:
 * - Returning the same reference as the input doc signals an idempotent
 *   no-op and skips the PUT entirely (saves a round trip on repeated
 *   terminal writes).
 * - Throwing from inside the updater (for example {@link CancellationRequestedError}
 *   raised by `flushProgress` when it sees `cancel_requested: true`)
 *   aborts the loop and propagates the error to the caller without
 *   writing anything. Cancellation relies on this to piggyback its
 *   cross-pod signal on the existing read of the tracking doc.
 *
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 * @param updater - Pure function that produces the updated document
 * @throws After {@link MAX_CONFLICT_RETRIES} consecutive 409s, on any
 *   non-409 error from the Stack, or on any error thrown by `updater`.
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
    if (doc.status === 'completed' || doc.status === 'canceled') {
      throw new IllegalStatusTransitionError(doc.status, 'running')
    }
    return {
      ...doc,
      schema_version: TRACKING_SCHEMA_VERSION,
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
    if (doc.status === 'failed' || doc.status === 'canceled') {
      throw new IllegalStatusTransitionError(doc.status, 'completed')
    }
    return {
      ...doc,
      schema_version: TRACKING_SCHEMA_VERSION,
      status: 'completed',
      finished_at: finishedAt,
    }
  })
}

/** Outcome of {@link setCancelRequested}; doubles as the metric label. */
export type CancelRequestOutcome = 'recorded' | 'already_requested' | 'ignored_terminal'

/**
 * Records the user's cancellation request on the tracking document.
 * Idempotent: a second call while the flag is already set is a no-op.
 * No-ops (with no throw) on terminal states so the cancel handler
 * can still ACK the message without spinning the retry budget.
 */
export async function setCancelRequested(
  stackClient: StackClient,
  docId: string,
): Promise<CancelRequestOutcome> {
  const now = new Date().toISOString()
  let outcome: CancelRequestOutcome = 'recorded'
  await updateTracking(stackClient, docId, (doc) => {
    if (isTerminal(doc.status)) {
      outcome = 'ignored_terminal'
      return doc
    }
    if (doc.cancel_requested) {
      outcome = 'already_requested'
      return doc
    }
    return {
      ...doc,
      schema_version: TRACKING_SCHEMA_VERSION,
      cancel_requested: true,
      canceled_at: now,
    }
  })
  return outcome
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
    if (doc.status === 'completed' || doc.status === 'canceled') {
      throw new IllegalStatusTransitionError(doc.status, 'failed')
    }
    // Dual-write: legacy sentinel in errors[] for back-compat with
    // frontends that parse that array, plus the new top-level
    // failure_reason for new consumers.
    const errors = appendFailureSentinel(
      doc.errors,
      errorMessage,
      now,
      doc.errors_truncated_count ?? 0,
    )
    return {
      ...doc,
      schema_version: TRACKING_SCHEMA_VERSION,
      status: 'failed',
      finished_at: now,
      failure_reason: errorMessage,
      errors: errors.items,
      errors_truncated_count: errors.truncated,
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
  await updateTracking(stackClient, docId, (doc) => {
    // Cross-pod cancel signal: another consumer (on this or any other
    // pod) wrote `cancel_requested: true` since our last flush. The
    // in-process AbortController covers same-pod cancels instantly;
    // this checkpoint covers the rest.
    if (doc.cancel_requested) {
      throw new CancellationRequestedError()
    }
    return {
      ...doc,
      schema_version: TRACKING_SCHEMA_VERSION,
      last_heartbeat_at: now,
      ...mergeLocalProgress(doc, local, filesDiscovered),
    }
  })
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
    if (doc.status === 'failed' || doc.status === 'canceled') {
      throw new IllegalStatusTransitionError(doc.status, 'completed')
    }
    return {
      ...doc,
      schema_version: TRACKING_SCHEMA_VERSION,
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
    if (doc.status === 'completed' || doc.status === 'canceled') {
      throw new IllegalStatusTransitionError(doc.status, 'failed')
    }
    const merged = mergeLocalProgress(doc, local, filesDiscovered)
    // Dual-write: append the legacy sentinel to errors[] for back-
    // compat and set the new top-level `failure_reason`. The sentinel
    // still goes through the cap so the final write honors it.
    const withSentinel = appendFailureSentinel(
      merged.errors,
      errorMessage,
      now,
      merged.errors_truncated_count,
    )
    return {
      ...doc,
      schema_version: TRACKING_SCHEMA_VERSION,
      status: 'failed',
      finished_at: now,
      last_heartbeat_at: now,
      failure_reason: errorMessage,
      ...merged,
      errors: withSentinel.items,
      errors_truncated_count: withSentinel.truncated,
    }
  })
}

/**
 * Atomic terminal write for the cancellation path: applies any pending
 * progress deltas AND transitions to `canceled` in a single CouchDB
 * round trip. Mirrors {@link flushAndComplete} and {@link flushAndFail}.
 * Sets `failure_reason: "canceled by user"` for UIs that still parse
 * that field alongside `status`.
 *
 * Refuses to transition away from a terminal state: no-op on
 * `canceled`, throws {@link IllegalStatusTransitionError} for
 * `completed` or `failed`.
 *
 * @param stackClient - Stack API client
 * @param docId - Tracking document ID
 * @param local - Pending deltas accumulated since the last flush
 * @param filesDiscovered - Total files discovered during traversal
 */
export async function flushAndCancel(
  stackClient: StackClient,
  docId: string,
  local: LocalProgress,
  filesDiscovered: number,
): Promise<void> {
  const now = new Date().toISOString()
  await updateTracking(stackClient, docId, (doc) => {
    if (doc.status === 'canceled') return doc
    if (doc.status === 'completed' || doc.status === 'failed') {
      throw new IllegalStatusTransitionError(doc.status, 'canceled')
    }
    return {
      ...doc,
      schema_version: TRACKING_SCHEMA_VERSION,
      status: 'canceled',
      finished_at: now,
      last_heartbeat_at: now,
      canceled_at: doc.canceled_at ?? now,
      failure_reason: 'canceled by user',
      ...mergeLocalProgress(doc, local, filesDiscovered),
    }
  })
}

/**
 * Shared merger for the flush + terminal writes: adds local deltas to
 * the remote progress counters (never rewriting `bytes_total`),
 * advances `files_total` monotonically, and concatenates per-file
 * errors and skips while capping each array at its maximum. The max
 * on `files_total` matters because a resumed migration restarts its
 * discovery counter at 0; overwriting blindly would regress the UI's
 * progress denominator back to zero on every resumed run.
 */
interface MergedProgress {
  progress: TrackingDoc['progress']
  errors: TrackingError[]
  errors_truncated_count: number
  skipped: TrackingSkipped[]
  skipped_truncated_count: number
}

function mergeLocalProgress(
  doc: TrackingDoc,
  local: LocalProgress,
  filesDiscovered: number,
): MergedProgress {
  const capped = capTail(doc.errors, local.errors, MAX_ERRORS_CAP, doc.errors_truncated_count ?? 0)
  const cappedSkipped = capTail(doc.skipped, local.skipped, MAX_SKIPPED_CAP, doc.skipped_truncated_count ?? 0)
  return {
    progress: {
      ...doc.progress,
      bytes_imported: doc.progress.bytes_imported + local.bytesImported,
      files_imported: doc.progress.files_imported + local.filesImported,
      files_total: Math.max(doc.progress.files_total, filesDiscovered),
    },
    errors: capped.items,
    errors_truncated_count: capped.truncated,
    skipped: cappedSkipped.items,
    skipped_truncated_count: cappedSkipped.truncated,
  }
}

/**
 * Appends the migration-level failure sentinel `{ path: '', message,
 * at }` to the errors array and applies the cap. Shared between
 * setFailed (no per-file deltas) and flushAndFail (final flush plus
 * terminal transition).
 */
function appendFailureSentinel(
  existing: TrackingError[],
  errorMessage: string,
  now: string,
  existingTruncated: number,
): { items: TrackingError[]; truncated: number } {
  return capTail(
    existing,
    [{ path: '', message: errorMessage, at: now }],
    MAX_ERRORS_CAP,
    existingTruncated,
  )
}

/**
 * Concatenates `additions` onto `existing`, truncating from the front
 * (dropping the oldest) when the total exceeds `cap`. Returns the
 * kept tail and the cumulative dropped count (including the previous
 * `existingTruncated`) so callers can advance the counter across
 * repeated flushes.
 */
function capTail<T>(
  existing: T[],
  additions: T[],
  cap: number,
  existingTruncated: number,
): { items: T[]; truncated: number } {
  const all = existing.concat(additions)
  if (all.length <= cap) return { items: all, truncated: existingTruncated }
  const overflow = all.length - cap
  return { items: all.slice(overflow), truncated: existingTruncated + overflow }
}
