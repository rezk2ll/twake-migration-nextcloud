import pino from 'pino'
import { RabbitMQClient, type RabbitMQMessage } from '@linagora/rabbitmq-client'
import { loadConfig } from './runtime/config.js'
import { createClouderyClient } from './clients/cloudery-client.js'
import { handleMigrationMessage } from './runtime/consumer.js'
import { createMigrationRunner } from './runtime/migration-runner.js'
import { createOpsServer } from './runtime/http-server.js'
import {
  bindActiveMigrationsSource,
  enableDefaultMetrics,
  rabbitmqConnected,
} from './runtime/metrics.js'
import { parseMigrationCommand } from './domain/types.js'

const EXCHANGE = 'migration'
const ROUTING_KEY = 'nextcloud.migration.requested'
const QUEUE = 'migration.nextcloud.commands'
/** How long we give in-flight migrations to finish on SIGTERM/SIGINT
 * before exiting anyway. The heartbeat/stale-recovery logic picks up
 * anything we leave behind, so this is a politeness ceiling rather
 * than a correctness one. */
const SHUTDOWN_DRAIN_MS = 60_000

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = pino({
    level: config.logLevel,
    base: { service: 'twake-nextcloud-migration' },
  })

  logger.info({ event: 'service.starting' }, 'Starting Nextcloud migration service')

  enableDefaultMetrics()
  const clouderyClient = createClouderyClient(config.clouderyUrl, config.clouderyToken, logger)
  const migrationRunner = createMigrationRunner(config.maxConcurrentMigrations, logger)
  bindActiveMigrationsSource(() => migrationRunner.active)

  const rabbitClient = new RabbitMQClient({
    url: config.rabbitmqUrl,
    maxRetries: 3,
    retryDelay: 1000,
    prefetch: 10,
    logger,
  })

  let shuttingDown = false
  const opsServer = createOpsServer(
    config.httpPort,
    {
      isRabbitMQConnected: () => rabbitClient.isConnected(),
      isShuttingDown: () => shuttingDown,
    },
    logger,
  )
  // Start the ops server BEFORE RabbitMQ so /healthz is answerable
  // while init runs — Kubernetes sees a live pod even if broker
  // connection takes a moment.
  await opsServer.start()

  await rabbitClient.init()
  rabbitmqConnected.set(1)
  logger.info({ event: 'rabbitmq.connected' }, 'Connected to RabbitMQ')

  await rabbitClient.subscribe(
    EXCHANGE,
    ROUTING_KEY,
    QUEUE,
    async (msg: RabbitMQMessage) => {
      // Schema validation failure is permanent — no retry will make
      // the payload valid — so we log and ACK rather than spin the
      // library's 3× retry budget before DLQ.
      let command
      try {
        command = parseMigrationCommand(msg)
      } catch (error) {
        logger.warn({
          event: 'consumer.invalid_message',
          error: error instanceof Error ? error.message : String(error),
        }, 'Dropping malformed migration message')
        return
      }
      await handleMigrationMessage(command, clouderyClient, logger, config, migrationRunner)
    }
  )
  logger.info({
    event: 'rabbitmq.subscribed',
    exchange: EXCHANGE,
    queue: QUEUE,
    routing_key: ROUTING_KEY,
  }, 'Subscribed to migration queue')

  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({
      event: 'service.shutting_down',
      signal,
      active_migrations: migrationRunner.active,
    }, 'Shutting down')
    await rabbitClient.close()
    rabbitmqConnected.set(0)
    const drained = await migrationRunner.drain(SHUTDOWN_DRAIN_MS)
    await opsServer.stop()
    logger.info({
      event: 'service.stopped',
      drained,
      still_active: migrationRunner.active,
    }, drained ? 'All migrations drained, exiting cleanly' : 'Drain deadline hit, exiting with active migrations')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  console.error('Fatal error during startup:', error)
  process.exit(1)
})
