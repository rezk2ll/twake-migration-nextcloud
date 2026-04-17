import type { Logger } from 'pino'
import type { CozyDir, StackClient } from '../clients/stack-client.js'
import type { MigrationCommand } from './types.js'
import { CancellationRequestedError, getErrorMessage } from './errors.js'
import {
  fileTransferDuration,
  filesProcessed,
  migrationsFinished,
  migrationsStarted,
} from '../runtime/metrics.js'
import {
  setRunning,
  flushProgress,
  flushAndComplete,
  flushAndCancel,
  flushAndFail,
  emptyLocalProgress,
  isConflictError,
  IllegalStatusTransitionError,
  type LocalProgress,
} from './tracking.js'

const DEFAULT_FLUSH_INTERVAL = 25

/**
 * @param targetDir - Absolute Cozy path whose usable segments are counted
 * @throws If `targetDir` has no usable segments (e.g. `""` or `"/"`)
 */
function assertTargetDirIsUsable(targetDir: string): void {
  const segments = targetDir.split('/').filter((s) => s !== '')
  if (segments.length === 0) {
    throw new Error(`invalid target_dir: ${targetDir}`)
  }
}

/**
 * Mutable state threaded through the traversal: clients, accumulators, and
 * logging counters. Kept on the stack frame of {@link runMigration} so every
 * helper sees the same totals without module-level state.
 */
interface MigrationContext {
  command: MigrationCommand
  stackClient: StackClient
  logger: Logger
  /**
   * Totals observed during traversal, cumulative, never reset.
   * `filesTotal` feeds the tracking document's `files_total` field via
   * flushProgress, so it drives the UI's file counter. `bytesTotal` is
   * log-only — `bytes_total` on the tracking document is seeded once
   * from the pre-flight oc:size total in setRunning and intentionally
   * not touched from here. The walker keeps this counter alongside so
   * the `migration.*` log lines can surface walker progress separately
   * from transfer progress for post-run diagnostics.
   */
  discovered: { bytesTotal: number; filesTotal: number }
  /** Total transferred (cumulative, never reset). Used for logging. */
  transferred: { bytes: number; files: number }
  /** Local deltas accumulated since last flush. Reset after each flush. */
  pending: LocalProgress
  /** Counters for logging. */
  totalErrors: number
  totalSkipped: number
  filesSinceFlush: number
  flushInterval: number
  startedAt: number
  /** Cooperative cancellation signal — checked at file/directory boundaries. */
  signal: AbortSignal
}

/**
 * Flushes pending local progress to CouchDB and resets the pending accumulators.
 * A no-op when nothing has accumulated since the previous flush, so it is safe
 * to call from completion/failure paths without double-writing.
 * @param ctx - Migration context carrying the pending deltas and flush target
 */
async function flush(ctx: MigrationContext): Promise<void> {
  if (ctx.filesSinceFlush === 0 && ctx.pending.errors.length === 0 && ctx.pending.skipped.length === 0) {
    return
  }
  await flushProgress(ctx.stackClient, ctx.command.migrationId, ctx.pending, ctx.discovered.filesTotal)
  ctx.pending = emptyLocalProgress()
  ctx.filesSinceFlush = 0
}

/** One directory still waiting to be visited. */
interface PendingDir {
  accountId: string
  ncPath: string
  cozyDir: CozyDir
}

/**
 * Iteratively walks the Nextcloud tree, transferring files and
 * recording per-directory errors. Uses an explicit LIFO stack rather
 * than recursion so a pathologically deep tree cannot overflow the
 * JavaScript call stack. Each traversal level carries the parent's
 * full {@link CozyDir} (id + path) so child directories can go
 * through the Stack's native stat-by-path helper with no 409 dance.
 * Flushes to CouchDB every ctx.flushInterval files.
 */
async function traverseTree(
  rootAccountId: string,
  rootPath: string,
  rootCozyDir: CozyDir,
  ctx: MigrationContext,
): Promise<void> {
  const stack: PendingDir[] = [
    { accountId: rootAccountId, ncPath: rootPath, cozyDir: rootCozyDir },
  ]
  while (stack.length > 0) {
    if (ctx.signal.aborted) throw new CancellationRequestedError()
    const { accountId, ncPath, cozyDir } = stack.pop() as PendingDir
    const subdirs: PendingDir[] = []
    const entries = await ctx.stackClient.listNextcloudDir(accountId, ncPath)
    for (const entry of entries) {
      if (entry.type === 'directory') {
        try {
          const childDir = await ctx.stackClient.ensureChildDir(entry.name, cozyDir)
          subdirs.push({ accountId, ncPath: entry.path, cozyDir: childDir })
        } catch (error) {
          recordDirFailure(ctx, entry.path, error)
        }
      } else {
        await handleFileEntry(ctx, accountId, cozyDir.id, entry)
      }
    }
    // Push in reverse so the leftmost subdirectory is popped next —
    // preserves the recursive version's in-order traversal.
    for (let i = subdirs.length - 1; i >= 0; i--) {
      stack.push(subdirs[i])
    }
  }
}

function recordDirFailure(
  ctx: MigrationContext,
  path: string,
  error: unknown,
): void {
  ctx.totalErrors += 1
  const message = getErrorMessage(error)
  ctx.logger.error({
    event: 'migration.dir_failed',
    nc_path: path,
    error: message,
    total_errors: ctx.totalErrors,
    elapsed_ms: Date.now() - ctx.startedAt,
  }, 'Directory traversal failed')
  ctx.pending.errors.push({ path, message, at: new Date().toISOString() })
}

async function handleFileEntry(
  ctx: MigrationContext,
  accountId: string,
  cozyDirId: string,
  entry: { name: string; path: string; size: number; mime: string },
): Promise<void> {
  if (ctx.signal.aborted) throw new CancellationRequestedError()
  ctx.discovered.bytesTotal += entry.size
  ctx.discovered.filesTotal += 1

  try {
    const fileStart = Date.now()
    const file = await ctx.stackClient.transferFile(accountId, entry.path, cozyDirId)
    const durationMs = Date.now() - fileStart
    fileTransferDuration.observe(durationMs / 1000)
    filesProcessed.inc({ outcome: 'transferred' })
    ctx.transferred.bytes += file.size
    ctx.transferred.files += 1
    ctx.pending.bytesImported += file.size
    ctx.pending.filesImported += 1
    ctx.filesSinceFlush += 1

    ctx.logger.info({
      event: 'migration.file_transferred',
      nc_path: entry.path,
      size: file.size,
      duration_ms: durationMs,
      transferred_bytes: ctx.transferred.bytes,
      transferred_files: ctx.transferred.files,
      discovered_bytes: ctx.discovered.bytesTotal,
      discovered_files: ctx.discovered.filesTotal,
      total_errors: ctx.totalErrors,
      total_skipped: ctx.totalSkipped,
      elapsed_ms: Date.now() - ctx.startedAt,
    }, 'File transferred')

    if (ctx.filesSinceFlush >= ctx.flushInterval) {
      await flush(ctx)
    }
  } catch (error) {
    // The per-file catch is for transfer errors only — cancellation
    // from the flush call above must propagate past it.
    if (error instanceof CancellationRequestedError) throw error
    if (isConflictError(error)) {
      filesProcessed.inc({ outcome: 'skipped' })
      ctx.totalSkipped += 1
      ctx.logger.info({
        event: 'migration.file_skipped',
        nc_path: entry.path,
        size: entry.size,
        reason: 'already_exists',
        total_skipped: ctx.totalSkipped,
        elapsed_ms: Date.now() - ctx.startedAt,
      }, 'File already exists, skipping')
      ctx.pending.skipped.push({ path: entry.path, reason: 'already exists', size: entry.size })
      return
    }
    filesProcessed.inc({ outcome: 'failed' })
    ctx.totalErrors += 1
    const message = getErrorMessage(error)
    ctx.logger.error({
      event: 'migration.file_failed',
      nc_path: entry.path,
      size: entry.size,
      error: message,
      total_errors: ctx.totalErrors,
      elapsed_ms: Date.now() - ctx.startedAt,
    }, 'File transfer failed')
    ctx.pending.errors.push({ path: entry.path, message, at: new Date().toISOString() })
  }
}

/**
 * Runs the full migration: sets status to running, creates the target
 * directory tree, lazily traverses the Nextcloud source transferring files,
 * and updates the tracking document throughout.
 *
 * Never throws: any error (including traversal, transfer, or tracking-doc
 * write failures) is caught, logged, and persisted on the tracking doc via
 * {@link flushAndFail}. Callers can attach a `.catch` for defensive logging
 * but do not need to propagate failures.
 *
 * @param command - Migration command from RabbitMQ (account, source path, ids)
 * @param stackClient - Authenticated Stack API client
 * @param logger - Pino logger; a child logger is derived with migration context
 * @param bytesTotal - Authoritative recursive byte total for the source path
 *   (from the Stack's `/remote/nextcloud/:account/size/*path` route). Seeded
 *   once via setRunning; see {@link flushProgress} for why it must not be
 *   rewritten later.
 * @param targetDir - Absolute Cozy path the imported tree is mirrored under.
 *   Comes from the tracking doc, which the Stack populated from the trigger
 *   request (or the `/Nextcloud` default). Each segment is created via
 *   createDir, so existing intermediate directories are reused.
 * @param flushInterval - Flush progress to CouchDB every N files (default: 25)
 * @param signal - Cooperative cancellation signal. Checked between
 *   directories and between files, so an in-flight file transfer is
 *   never interrupted. Defaults to a never-aborted signal, so existing
 *   call sites that do not participate in cancellation still work.
 */
export async function runMigration(
  command: MigrationCommand,
  stackClient: StackClient,
  logger: Logger,
  bytesTotal: number,
  targetDir: string,
  flushInterval: number = DEFAULT_FLUSH_INTERVAL,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const migrationLogger = logger.child({
    migration_id: command.migrationId,
    instance: command.workplaceFqdn,
    account_id: command.accountId,
    source_path: command.sourcePath,
    target_dir: targetDir,
  })
  const ctx: MigrationContext = {
    command,
    stackClient,
    logger: migrationLogger,
    discovered: { bytesTotal: 0, filesTotal: 0 },
    transferred: { bytes: 0, files: 0 },
    pending: emptyLocalProgress(),
    totalErrors: 0,
    totalSkipped: 0,
    filesSinceFlush: 0,
    flushInterval,
    startedAt: Date.now(),
    signal,
  }

  migrationsStarted.inc()
  try {
    migrationLogger.info({ event: 'migration.started' }, 'Migration started')

    await setRunning(stackClient, command.migrationId, bytesTotal)
    assertTargetDirIsUsable(targetDir)
    const targetCozyDir = await stackClient.ensureDirPath(targetDir)
    await traverseTree(command.accountId, command.sourcePath || '/', targetCozyDir, ctx)
    await flushAndComplete(
      stackClient,
      command.migrationId,
      ctx.pending,
      ctx.discovered.filesTotal,
    )

    migrationsFinished.inc({ outcome: 'completed' })
    migrationLogger.info({
      event: 'migration.completed',
      duration_ms: Date.now() - ctx.startedAt,
      discovered_bytes: ctx.discovered.bytesTotal,
      discovered_files: ctx.discovered.filesTotal,
      transferred_bytes: ctx.transferred.bytes,
      transferred_files: ctx.transferred.files,
      total_errors: ctx.totalErrors,
      total_skipped: ctx.totalSkipped,
    }, 'Migration completed')
  } catch (error) {
    if (error instanceof CancellationRequestedError) {
      await finalizeCancellation(ctx)
      return
    }
    // A `flushAndComplete` that lost to a concurrent cancel surfaces
    // here as `canceled -> completed`. The tracking doc is already in
    // its rightful terminal state — don't try to re-transition it.
    if (
      error instanceof IllegalStatusTransitionError &&
      error.from === 'canceled' &&
      error.to === 'completed'
    ) {
      migrationsFinished.inc({ outcome: 'canceled' })
      migrationLogger.info({
        event: 'migration.completion_superseded_by_cancel',
        duration_ms: Date.now() - ctx.startedAt,
        transferred_bytes: ctx.transferred.bytes,
        transferred_files: ctx.transferred.files,
      }, 'Migration completion superseded by cancellation')
      return
    }
    const message = getErrorMessage(error)
    migrationsFinished.inc({ outcome: 'failed' })
    migrationLogger.error({
      event: 'migration.failed',
      duration_ms: Date.now() - ctx.startedAt,
      discovered_bytes: ctx.discovered.bytesTotal,
      discovered_files: ctx.discovered.filesTotal,
      transferred_bytes: ctx.transferred.bytes,
      transferred_files: ctx.transferred.files,
      total_errors: ctx.totalErrors,
      total_skipped: ctx.totalSkipped,
      error: message,
    }, 'Migration failed')
    try {
      await flushAndFail(
        stackClient,
        command.migrationId,
        message,
        ctx.pending,
        ctx.discovered.filesTotal,
      )
    } catch (trackingError) {
      migrationLogger.error({
        event: 'migration.tracking_update_failed',
        error: getErrorMessage(trackingError),
      }, 'Failed to update tracking doc to failed status')
    }
  }
}

/**
 * Terminal path for a cooperative cancellation: records the outcome
 * metric, emits a structured summary, and flushes any pending progress
 * into the tracking doc as it transitions to `canceled`. A failure to
 * write the terminal state is logged but swallowed — the in-memory run
 * is over either way and the heartbeat-recovery logic reclaims any
 * zombie doc left behind.
 *
 * @param ctx - Migration context carrying the pending deltas and Stack client
 */
async function finalizeCancellation(ctx: MigrationContext): Promise<void> {
  migrationsFinished.inc({ outcome: 'canceled' })
  ctx.logger.info({
    event: 'migration.canceled',
    duration_ms: Date.now() - ctx.startedAt,
    discovered_bytes: ctx.discovered.bytesTotal,
    discovered_files: ctx.discovered.filesTotal,
    transferred_bytes: ctx.transferred.bytes,
    transferred_files: ctx.transferred.files,
    total_errors: ctx.totalErrors,
    total_skipped: ctx.totalSkipped,
  }, 'Migration canceled')
  try {
    await flushAndCancel(
      ctx.stackClient,
      ctx.command.migrationId,
      ctx.pending,
      ctx.discovered.filesTotal,
    )
  } catch (trackingError) {
    ctx.logger.error({
      event: 'migration.tracking_update_failed',
      error: getErrorMessage(trackingError),
    }, 'Failed to update tracking doc to canceled status')
  }
}
