import type { Logger } from 'pino'
import type { ClouderyClient } from '../clients/cloudery-client.js'
import { createStackClient, type StackClient } from '../clients/stack-client.js'
import { runMigration } from '../domain/migration.js'
import { getErrorMessage } from '../domain/errors.js'
import { isStaleRunning, setFailed } from '../domain/tracking.js'
import type { MigrationCommand } from '../domain/types.js'
import type { Config } from './config.js'
import type { MigrationRunner } from './migration-runner.js'

// Fallback when the tracking document has no target_dir. The Stack defaults
// this field at creation time, so an empty value only happens with legacy
// docs written before target_dir was wired up.
const DEFAULT_TARGET_DIR = '/Nextcloud'

/**
 * @param error - Caught error value
 * @returns true if the error represents an HTTP 404 from the Stack
 */
function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ((error as { status?: number }).status === 404) return true
  return error.message.includes('(404)')
}

/**
 * Handles a single migration message: acquires a token, validates idempotency
 * and quota, then fires the migration without awaiting (early ACK pattern).
 *
 * Returns normally (ACKs the message) when the failure is permanent — no
 * amount of retrying will help — so the 3× RabbitMQ retry budget and the
 * DLQ only accumulate genuinely transient problems. Throws only on
 * transient pre-ACK failures that should retry.
 *
 * @param command - Validated migration command
 * @param clouderyClient - Client for obtaining Stack tokens
 * @param logger - Pino logger instance
 * @param config - Service configuration
 */
export async function handleMigrationMessage(
  command: MigrationCommand,
  clouderyClient: ClouderyClient,
  logger: Logger,
  config: Config,
  runner: MigrationRunner,
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

  let trackingDoc
  try {
    trackingDoc = await stackClient.getTrackingDoc(command.migrationId)
  } catch (error) {
    if (isNotFoundError(error)) {
      // The tracking doc was deleted (user cancelled, or the message
      // survived a CouchDB reset). Nothing to resume and no doc to
      // update — drop the message rather than spin the retry budget.
      migrationLogger.warn({
        event: 'consumer.tracking_doc_not_found',
        error: getErrorMessage(error),
      }, 'Tracking document not found, dropping message')
      return
    }
    throw error
  }

  const freshlyRunning =
    trackingDoc.status === 'running' && !isStaleRunning(trackingDoc)
  if (trackingDoc.status === 'completed' || freshlyRunning) {
    migrationLogger.info({
      event: 'consumer.skipped_idempotent',
      status: trackingDoc.status,
    }, 'Migration already processed, skipping')
    return
  }
  if (trackingDoc.status === 'running') {
    // Heartbeat is older than the stale threshold: the previous
    // consumer crashed or was killed mid-migration. The 409-on-existing
    // skip logic in the traversal makes resume idempotent, so we take
    // over rather than leaving a zombie doc wedged forever.
    migrationLogger.warn({
      event: 'consumer.resuming_stale',
      last_heartbeat_at: trackingDoc.last_heartbeat_at,
      started_at: trackingDoc.started_at,
    }, 'Resuming stale running migration')
  }

  // Nextcloud reports the recursive byte total of the source path via
  // its `oc:size` property, so we get an accurate pre-flight figure from
  // one constant-time PROPFIND. The previous implementation shallow-
  // summed the direct children of the source path and pretended that
  // was the total, which could be off by several orders of magnitude
  // and let quota-exceeding migrations start before failing mid-stream.
  // Serialised with getDiskUsage so a 404 on the source path skips the
  // quota call entirely; the added round trip is negligible versus a
  // migration that runs for minutes.
  const sourceSize = await fetchSourceSizeOrFail(
    stackClient,
    command,
    migrationLogger,
  )
  if (sourceSize === null) return
  const diskUsage = await stackClient.getDiskUsage()

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

  // Hand off to the runner: blocks for a concurrency slot, then fires
  // the migration in the background. The handler returns as soon as
  // the task is launched, which is also when the RabbitMQ library
  // ACKs — the slot stays held until runMigration settles.
  await runner.run(() =>
    runMigration(
      command,
      stackClient,
      logger,
      sourceSize,
      trackingDoc.target_dir || DEFAULT_TARGET_DIR,
      config.flushInterval,
    ).catch((error) => {
      migrationLogger.error({
        event: 'consumer.migration_unhandled_error',
        error,
      }, 'Migration failed after ACK')
    }),
  )
}

/**
 * Fetches the recursive Nextcloud size for the command's source path.
 * A 404 means the user supplied a path that does not exist — permanent
 * failure — so we mark the tracking doc as failed and return null
 * rather than letting the 404 spin the RabbitMQ retry budget.
 * Any other error propagates for transient retry.
 * @returns The source size in bytes, or null when the migration was marked failed.
 */
async function fetchSourceSizeOrFail(
  stackClient: StackClient,
  command: MigrationCommand,
  logger: Logger,
): Promise<number | null> {
  try {
    return await stackClient.getNextcloudSize(
      command.accountId,
      command.sourcePath || '/',
    )
  } catch (error) {
    if (!isNotFoundError(error)) throw error
    logger.warn({
      event: 'consumer.source_path_not_found',
      source_path: command.sourcePath,
      error: getErrorMessage(error),
    }, 'Source path does not exist in Nextcloud')
    await setFailed(
      stackClient,
      command.migrationId,
      `Source path not found in Nextcloud: ${command.sourcePath || '/'}`,
    )
    return null
  }
}
