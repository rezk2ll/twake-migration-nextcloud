import type { Logger } from 'pino'
import type { StackClient } from './stack-client.js'
import type { MigrationCommand } from './types.js'
import {
  setRunning,
  setCompleted,
  setFailed,
  incrementProgress,
  updateBytesTotal,
  addError,
  addSkipped,
  isConflictError,
} from './tracking.js'

const COZY_ROOT_DIR_ID = 'io.cozy.files.root-dir'
const TARGET_DIR_NAME = 'Nextcloud'

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface MigrationContext {
  command: MigrationCommand
  stackClient: StackClient
  logger: Logger
  discovered: { bytesTotal: number; filesTotal: number }
}

async function traverseDir(
  accountId: string,
  ncPath: string,
  cozyDirId: string,
  ctx: MigrationContext
): Promise<void> {
  const { migrationId } = ctx.command
  const entries = await ctx.stackClient.listNextcloudDir(accountId, ncPath)

  for (const entry of entries) {
    if (entry.type === 'directory') {
      try {
        const subDirId = await ctx.stackClient.createDir(cozyDirId, entry.name)
        await traverseDir(accountId, entry.path, subDirId, ctx)
      } catch (error) {
        const message = getErrorMessage(error)
        ctx.logger.error({
          event: 'migration.dir_failed',
          nc_path: entry.path,
          error: message,
        }, 'Directory traversal failed')
        await addError(ctx.stackClient, migrationId, entry.path, message)
      }
    } else {
      ctx.discovered.bytesTotal += entry.size
      ctx.discovered.filesTotal += 1

      try {
        const start = Date.now()
        const file = await ctx.stackClient.transferFile(accountId, entry.path, cozyDirId)
        await incrementProgress(ctx.stackClient, migrationId, file.size)
        ctx.logger.info({
          event: 'migration.file_transferred',
          nc_path: entry.path,
          size: file.size,
          duration_ms: Date.now() - start,
          progress_bytes: ctx.discovered.bytesTotal,
          progress_files: ctx.discovered.filesTotal,
        }, 'File transferred')
      } catch (error) {
        if (isConflictError(error)) {
          ctx.logger.info({
            event: 'migration.file_skipped',
            nc_path: entry.path,
            size: entry.size,
            reason: 'already exists',
          }, 'File already exists, skipping')
          await addSkipped(ctx.stackClient, migrationId, entry.path, 'already exists', entry.size)
          continue
        }
        const message = getErrorMessage(error)
        ctx.logger.error({
          event: 'migration.file_failed',
          nc_path: entry.path,
          size: entry.size,
          error: message,
        }, 'File transfer failed')
        await addError(ctx.stackClient, migrationId, entry.path, message)
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
 */
export async function runMigration(
  command: MigrationCommand,
  stackClient: StackClient,
  logger: Logger
): Promise<void> {
  const migrationLogger = logger.child({
    migration_id: command.migrationId,
    instance: command.workplaceFqdn,
    account_id: command.accountId,
    source_path: command.sourcePath,
  })
  const discovered = { bytesTotal: 0, filesTotal: 0 }
  const ctx: MigrationContext = { command, stackClient, logger: migrationLogger, discovered }

  const start = Date.now()
  try {
    migrationLogger.info({ event: 'migration.started' }, 'Migration started')

    await setRunning(stackClient, command.migrationId, 0)
    const targetDirId = await stackClient.createDir(COZY_ROOT_DIR_ID, TARGET_DIR_NAME)
    await traverseDir(command.accountId, command.sourcePath || '/', targetDirId, ctx)
    await updateBytesTotal(stackClient, command.migrationId, discovered.bytesTotal, discovered.filesTotal)
    await setCompleted(stackClient, command.migrationId)

    migrationLogger.info({
      event: 'migration.completed',
      duration_ms: Date.now() - start,
      bytes_total: discovered.bytesTotal,
      files_total: discovered.filesTotal,
    }, 'Migration completed')
  } catch (error) {
    const message = getErrorMessage(error)
    migrationLogger.error({
      event: 'migration.failed',
      duration_ms: Date.now() - start,
      bytes_total: discovered.bytesTotal,
      files_total: discovered.filesTotal,
      error: message,
    }, 'Migration failed')
    try {
      await setFailed(stackClient, command.migrationId, message)
    } catch (trackingError) {
      migrationLogger.error({
        event: 'migration.tracking_update_failed',
        error: getErrorMessage(trackingError),
      }, 'Failed to update tracking doc to failed status')
    }
  }
}
