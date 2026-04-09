import type { Logger } from 'pino'
import type { ClouderyClient } from './cloudery-client.js'
import { createStackClient, type StackClient } from './stack-client.js'
import { runMigration } from './migration.js'
import { setFailed } from './tracking.js'
import type { MigrationCommand } from './types.js'

/** Shallow estimate from root listing — conservative pre-flight check only. */
async function estimateSourceSize(
  stackClient: StackClient,
  accountId: string,
  path: string
): Promise<number> {
  const entries = await stackClient.listNextcloudDir(accountId, path)
  let total = 0
  for (const entry of entries) {
    if (entry.type === 'file') {
      total += entry.size
    }
  }
  return total
}

export async function handleMigrationMessage(
  command: MigrationCommand,
  clouderyClient: ClouderyClient,
  logger: Logger
): Promise<void> {
  const migrationLogger = logger.child({
    migration_id: command.migrationId,
    instance: command.workplaceFqdn,
  })

  const token = await clouderyClient.getToken(command.workplaceFqdn)
  const stackClient = createStackClient(command.workplaceFqdn, token, clouderyClient)

  const trackingDoc = await stackClient.getTrackingDoc(command.migrationId)
  if (trackingDoc.status === 'completed' || trackingDoc.status === 'running') {
    migrationLogger.info({ status: trackingDoc.status }, 'Migration already processed, skipping')
    return
  }

  const [diskUsage, sourceEstimate] = await Promise.all([
    stackClient.getDiskUsage(),
    estimateSourceSize(stackClient, command.accountId, command.sourcePath || '/'),
  ])

  // quota === 0 means unlimited in Cozy Stack
  if (diskUsage.quota > 0) {
    const availableSpace = diskUsage.quota - diskUsage.used
    if (sourceEstimate > availableSpace) {
      migrationLogger.warn(
        { sourceEstimate, availableSpace },
        'Insufficient quota for migration'
      )
      await setFailed(
        stackClient,
        command.migrationId,
        `Insufficient quota: need ${sourceEstimate} bytes, only ${availableSpace} available`
      )
      return
    }
  }

  migrationLogger.info('Validation passed, starting migration')
  runMigration(command, stackClient, logger).catch((error) => {
    migrationLogger.error({ error }, 'Migration failed after ACK')
  })
}
