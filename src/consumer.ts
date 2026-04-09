import type { Logger } from 'pino'
import type { ClouderyClient } from './cloudery-client.js'
import { createStackClient } from './stack-client.js'
import { calculateTotalBytes, runMigration } from './migration.js'
import { setFailed } from './tracking.js'
import type { MigrationCommand } from './types.js'

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

  const [diskUsage, { totalBytes: sourceSize }] = await Promise.all([
    stackClient.getDiskUsage(),
    calculateTotalBytes(stackClient, command.accountId, command.sourcePath || '/'),
  ])

  // quota === 0 means unlimited in Cozy Stack
  if (diskUsage.quota > 0) {
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
  }

  migrationLogger.info('Validation passed, starting migration')
  runMigration(command, stackClient, logger).catch((error) => {
    migrationLogger.error({ error }, 'Migration failed after ACK')
  })
}
