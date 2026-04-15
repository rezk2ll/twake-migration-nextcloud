import type { Logger } from 'pino'
import type { StackClient } from '../clients/stack-client.js'
import type { MigrationCommand } from './types.js'
import {
  setRunning,
  setCompleted,
  setFailed,
  flushProgress,
  emptyLocalProgress,
  isConflictError,
  type LocalProgress,
} from './tracking.js'

const COZY_ROOT_DIR_ID = 'io.cozy.files.root-dir'
const DEFAULT_FLUSH_INTERVAL = 25

/**
 * Walks an absolute Cozy path and creates each segment, returning the id of
 * the innermost directory. Segments that already exist are resolved via the
 * Stack's 409 recovery path in createDir, so repeated migrations reuse the
 * same tree instead of piling up "(2)" suffixes.
 */
async function ensureTargetDir(
  stackClient: StackClient,
  targetDir: string
): Promise<string> {
  const segments = targetDir.split('/').filter((s) => s !== '')
  if (segments.length === 0) {
    throw new Error(`invalid target_dir: ${targetDir}`)
  }
  let parentId = COZY_ROOT_DIR_ID
  for (const name of segments) {
    parentId = await stackClient.createDir(parentId, name)
  }
  return parentId
}

/**
 * @param error - Caught error value
 * @returns The error message string, or String(error) for non-Error values
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
}

/**
 * Flushes pending local progress to CouchDB and resets the pending accumulators.
 */
async function flush(ctx: MigrationContext): Promise<void> {
  if (ctx.filesSinceFlush === 0 && ctx.pending.errors.length === 0 && ctx.pending.skipped.length === 0) {
    return
  }
  await flushProgress(ctx.stackClient, ctx.command.migrationId, ctx.pending, ctx.discovered.filesTotal)
  ctx.pending = emptyLocalProgress()
  ctx.filesSinceFlush = 0
}

/**
 * Recursively lists and transfers files from a Nextcloud directory into Cozy.
 * Accumulates progress locally; flushes to CouchDB every ctx.flushInterval files.
 * @param accountId - Nextcloud account ID (io.cozy.accounts)
 * @param ncPath - Nextcloud directory path to list
 * @param cozyDirId - Target Cozy directory ID
 * @param ctx - Migration context carrying state, clients, and logger
 */
async function traverseDir(
  accountId: string,
  ncPath: string,
  cozyDirId: string,
  ctx: MigrationContext
): Promise<void> {
  const entries = await ctx.stackClient.listNextcloudDir(accountId, ncPath)

  for (const entry of entries) {
    if (entry.type === 'directory') {
      try {
        const subDirId = await ctx.stackClient.createDir(cozyDirId, entry.name)
        await traverseDir(accountId, entry.path, subDirId, ctx)
      } catch (error) {
        ctx.totalErrors += 1
        const message = getErrorMessage(error)
        ctx.logger.error({
          event: 'migration.dir_failed',
          nc_path: entry.path,
          error: message,
          total_errors: ctx.totalErrors,
          elapsed_ms: Date.now() - ctx.startedAt,
        }, 'Directory traversal failed')
        ctx.pending.errors.push({ path: entry.path, message, at: new Date().toISOString() })
      }
    } else {
      ctx.discovered.bytesTotal += entry.size
      ctx.discovered.filesTotal += 1

      try {
        const fileStart = Date.now()
        const file = await ctx.stackClient.transferFile(accountId, entry.path, cozyDirId)
        ctx.transferred.bytes += file.size
        ctx.transferred.files += 1
        ctx.pending.bytesImported += file.size
        ctx.pending.filesImported += 1
        ctx.filesSinceFlush += 1

        ctx.logger.info({
          event: 'migration.file_transferred',
          nc_path: entry.path,
          size: file.size,
          duration_ms: Date.now() - fileStart,
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
        if (isConflictError(error)) {
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
          continue
        }
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
  }
}

/**
 * Runs the full migration: sets status to running, creates target directory,
 * lazily traverses the Nextcloud tree transferring files, and updates the
 * tracking document throughout. On failure, marks the migration as failed.
 * @param command - Migration command from RabbitMQ
 * @param stackClient - Authenticated Stack API client
 * @param logger - Pino logger instance
 * @param bytesTotal - Authoritative recursive byte total for the source
 *   path (from the Stack's `/remote/nextcloud/:account/size/*path` route).
 *   Seeded once via setRunning; see {@link flushProgress} for why it must
 *   not be rewritten later.
 * @param targetDir - Absolute Cozy path the imported tree is mirrored under.
 *   Comes from the tracking doc, which the Stack populated from the trigger
 *   request (or the `/Nextcloud` default). Each path segment is created via
 *   createDir, so existing intermediate directories are reused.
 * @param flushInterval - Flush progress to CouchDB every N files (default: 25)
 */
export async function runMigration(
  command: MigrationCommand,
  stackClient: StackClient,
  logger: Logger,
  bytesTotal: number,
  targetDir: string,
  flushInterval: number = DEFAULT_FLUSH_INTERVAL
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
  }

  try {
    migrationLogger.info({ event: 'migration.started' }, 'Migration started')

    await setRunning(stackClient, command.migrationId, bytesTotal)
    const targetDirId = await ensureTargetDir(stackClient, targetDir)
    await traverseDir(command.accountId, command.sourcePath || '/', targetDirId, ctx)
    await flush(ctx)
    await setCompleted(stackClient, command.migrationId)

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
    const message = getErrorMessage(error)
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
      await flush(ctx)
      await setFailed(stackClient, command.migrationId, message)
    } catch (trackingError) {
      migrationLogger.error({
        event: 'migration.tracking_update_failed',
        error: getErrorMessage(trackingError),
      }, 'Failed to update tracking doc to failed status')
    }
  }
}
