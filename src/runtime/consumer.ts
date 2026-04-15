import type { Logger } from 'pino'
import type { ClouderyClient } from '../clients/cloudery-client.js'
import { createStackClient } from '../clients/stack-client.js'
import { runMigration } from '../domain/migration.js'
import { setFailed } from '../domain/tracking.js'
import type { MigrationCommand } from '../domain/types.js'
import type { Config } from './config.js'

/**
 * Handles a single migration message: acquires a token, validates idempotency
 * and quota, then fires the migration without awaiting (early ACK pattern).
 * Throws on pre-ACK failures (token acquisition, tracking doc fetch) so the
 * RabbitMQ library can retry or dead-letter.
 * @param command - Validated migration command
 * @param clouderyClient - Client for obtaining Stack tokens
 * @param logger - Pino logger instance
 * @param config - Service configuration
 */
export async function handleMigrationMessage(
  command: MigrationCommand,
  clouderyClient: ClouderyClient,
  logger: Logger,
  config: Config
): Promise<void> {
  const migrationLogger = logger.child({
    migration_id: command.migrationId,
    instance: command.workplaceFqdn,
    account_id: command.accountId,
  })

  migrationLogger.info({ event: 'consumer.message_received' }, 'Migration message received')

  const token = await clouderyClient.getToken(command.workplaceFqdn)
  const stackClient = createStackClient(
    command.workplaceFqdn,
    config.stackUrlScheme,
    token,
    clouderyClient,
    migrationLogger,
  )

  const trackingDoc = await stackClient.getTrackingDoc(command.migrationId)
  if (trackingDoc.status === 'completed' || trackingDoc.status === 'running') {
    migrationLogger.info({
      event: 'consumer.skipped_idempotent',
      status: trackingDoc.status,
    }, 'Migration already processed, skipping')
    return
  }

  // Nextcloud reports the recursive byte total of the source path via
  // its `oc:size` property, so we get an accurate pre-flight figure from
  // one constant-time PROPFIND. The previous implementation shallow-
  // summed the direct children of the source path and pretended that
  // was the total, which could be off by several orders of magnitude
  // and let quota-exceeding migrations start before failing mid-stream.
  const [diskUsage, sourceSize] = await Promise.all([
    stackClient.getDiskUsage(),
    stackClient.getNextcloudSize(command.accountId, command.sourcePath || '/'),
  ])

  // quota === 0 means unlimited
  if (diskUsage.quota > 0) {
    const availableSpace = diskUsage.quota - diskUsage.used
    if (sourceSize > availableSpace) {
      migrationLogger.warn({
        event: 'consumer.quota_exceeded',
        source_size: sourceSize,
        available_space: availableSpace,
        quota: diskUsage.quota,
        used: diskUsage.used,
      }, 'Insufficient quota for migration')
      await setFailed(
        stackClient,
        command.migrationId,
        `Insufficient quota: need ${sourceSize} bytes, only ${availableSpace} available`
      )
      return
    }
  }

  migrationLogger.info({
    event: 'consumer.validation_passed',
    source_size: sourceSize,
    quota: diskUsage.quota,
    used: diskUsage.used,
  }, 'Validation passed, firing migration')

  runMigration(command, stackClient, logger, sourceSize, config.flushInterval).catch((error) => {
    migrationLogger.error({
      event: 'consumer.migration_unhandled_error',
      error,
    }, 'Migration failed after ACK')
  })
}
