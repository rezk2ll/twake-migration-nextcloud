import type { Logger } from 'pino'
import type { StackClient } from './stack-client.js'
import type { MigrationCommand, NextcloudEntry } from './types.js'
import {
  setRunning,
  setCompleted,
  setFailed,
  incrementProgress,
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
}

export async function calculateTotalBytes(
  stackClient: StackClient,
  accountId: string,
  path: string
): Promise<{ totalBytes: number; entries: NextcloudEntry[] }> {
  const entries = await stackClient.listNextcloudDir(accountId, path)
  let totalBytes = 0

  for (const entry of entries) {
    if (entry.type === 'file') {
      totalBytes += entry.size
    } else if (entry.type === 'directory') {
      const sub = await calculateTotalBytes(stackClient, accountId, entry.path)
      totalBytes += sub.totalBytes
    }
  }

  return { totalBytes, entries }
}

async function traverseDir(
  cozyDirId: string,
  entries: NextcloudEntry[],
  ctx: MigrationContext
): Promise<void> {
  const { accountId, migrationId } = ctx.command

  for (const entry of entries) {
    if (entry.type === 'directory') {
      try {
        const subDirId = await ctx.stackClient.createDir(cozyDirId, entry.name)
        const subEntries = await ctx.stackClient.listNextcloudDir(accountId, entry.path)
        await traverseDir(subDirId, subEntries, ctx)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.error({ path: entry.path, error: message }, 'Directory traversal failed')
        await addError(ctx.stackClient, migrationId, entry.path, message)
      }
    } else {
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
  const ctx: MigrationContext = { command, stackClient, logger: migrationLogger }

  try {
    migrationLogger.info('Starting migration')

    const sourcePath = command.sourcePath || '/'
    const { totalBytes, entries } = await calculateTotalBytes(
      stackClient,
      command.accountId,
      sourcePath
    )

    await setRunning(stackClient, command.migrationId, totalBytes)

    const targetDirId = await stackClient.createDir(COZY_ROOT_DIR_ID, TARGET_DIR_NAME)

    await traverseDir(targetDirId, entries, ctx)

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
