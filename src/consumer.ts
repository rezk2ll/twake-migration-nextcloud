import type { Logger } from 'pino'
import type { ClouderyClient } from './cloudery-client.js'
import { createStackClient, type StackClient } from './stack-client.js'
import { runMigration } from './migration.js'
import { setFailed } from './tracking.js'
import type { MigrationCommand } from './types.js'

async function estimateSourceSize(
  stackClient: StackClient,
  accountId: string,
  path: string
): Promise<number> {
  const entries = await stackClient.listNextcloudDir(accountId, path)
  let total = 0
  for (const entry of entries) {
    total += entry.size
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

  const [diskUsage, sourceSize] = await Promise.all([
    stackClient.getDiskUsage(),
    estimateSourceSize(stackClient, command.accountId, command.sourcePath || '/'),
  ])
  const availableSpace = diskUsage.quota - diskUsage.used
  if (sourceSize > availableSpace) {
    migrationLogger.warn(
      { sourceSize, availableSpace },
      'Insufficient quota for migration'
    )
    await setFailed(
      stackClient,
      command.migrationId,
      `Insufficient quota: need ${sourceSize} bytes, only ${availableSpace} available`
    )
    return
  }

  migrationLogger.info('Validation passed, starting migration')
  runMigration(command, stackClient, logger).catch((error) => {
    migrationLogger.error({ error }, 'Migration failed after ACK')
  })
}
