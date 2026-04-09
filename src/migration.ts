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
        const message = getErrorMessage(error)
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

    await setRunning(stackClient, command.migrationId, 0)
    const targetDirId = await stackClient.createDir(COZY_ROOT_DIR_ID, TARGET_DIR_NAME)
    await traverseDir(command.accountId, command.sourcePath || '/', targetDirId, ctx)
    await updateBytesTotal(stackClient, command.migrationId, discovered.bytesTotal, discovered.filesTotal)
    await setCompleted(stackClient, command.migrationId)

    migrationLogger.info('Migration completed')
  } catch (error) {
    const message = getErrorMessage(error)
    migrationLogger.error({ error: message }, 'Migration failed')
    try {
      await setFailed(stackClient, command.migrationId, message)
    } catch (trackingError) {
      migrationLogger.error({ error: trackingError }, 'Failed to update tracking doc to failed status')
    }
  }
}
