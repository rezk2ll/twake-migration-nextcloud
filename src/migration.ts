import type { Logger } from 'pino'
import type { StackClient } from './stack-client.js'
import type { MigrationCommand, NextcloudEntry } from './types.js'
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

interface MigrationContext {
  command: MigrationCommand
  stackClient: StackClient
  logger: Logger
  /** Running totals discovered during lazy traversal. */
  discovered: { bytesTotal: number; filesTotal: number }
}

/**
 * Lazy recursive traversal: list one directory at a time, transfer its files,
 * then recurse into subdirectories. Accumulates discovered totals as it goes.
 */
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
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.error({ path: entry.path, error: message }, 'Directory traversal failed')
        await addError(ctx.stackClient, migrationId, entry.path, message)
      }
    } else {
      ctx.discovered.bytesTotal += entry.size
      ctx.discovered.filesTotal += 1

      try {
        const file = await ctx.stackClient.transferFile(accountId, entry.path, cozyDirId)
        await incrementProgress(ctx.stackClient, migrationId, file.size)
      } catch (error) {
        if (isConflictError(error)) {
          ctx.logger.info({ path: entry.path }, 'File already exists, skipping')
          await addSkipped(ctx.stackClient, migrationId, entry.path, 'already exists', entry.size)
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.error({ path: entry.path, error: message }, 'File transfer failed')
        await addError(ctx.stackClient, migrationId, entry.path, message)
      }
    }
  }
}

export async function runMigration(
  command: MigrationCommand,
  stackClient: StackClient,
  logger: Logger
): Promise<void> {
  const migrationLogger = logger.child({
    migration_id: command.migrationId,
    instance: command.workplaceFqdn,
  })
  const discovered = { bytesTotal: 0, filesTotal: 0 }
  const ctx: MigrationContext = { command, stackClient, logger: migrationLogger, discovered }

  try {
    migrationLogger.info('Starting migration')

    const sourcePath = command.sourcePath || '/'

    // Initial bytes_total comes from Nextcloud quota (set by consumer before ACK).
    // Set status to running — bytes_total is already an estimate from the consumer.
    await setRunning(stackClient, command.migrationId, 0)

    const targetDirId = await stackClient.createDir(COZY_ROOT_DIR_ID, TARGET_DIR_NAME)

    // Lazy traversal: discover and transfer directory by directory
    await traverseDir(command.accountId, sourcePath, targetDirId, ctx)

    // Refine bytes_total and files_total to actual discovered values
    await updateBytesTotal(
      stackClient,
      command.migrationId,
      discovered.bytesTotal,
      discovered.filesTotal
    )

    await setCompleted(stackClient, command.migrationId)
    migrationLogger.info('Migration completed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    migrationLogger.error({ error: message }, 'Migration failed')
    try {
      await setFailed(stackClient, command.migrationId, message)
    } catch (trackingError) {
      migrationLogger.error({ error: trackingError }, 'Failed to update tracking doc to failed status')
    }
  }
}
