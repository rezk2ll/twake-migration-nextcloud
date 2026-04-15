import pino from 'pino'
import { RabbitMQClient, type RabbitMQMessage } from '@linagora/rabbitmq-client'
import { loadConfig } from './runtime/config.js'
import { createClouderyClient } from './clients/cloudery-client.js'
import { handleMigrationMessage } from './runtime/consumer.js'
import { parseMigrationCommand } from './domain/types.js'

const EXCHANGE = 'migration'
const ROUTING_KEY = 'nextcloud.migration.requested'
const QUEUE = 'migration.nextcloud.commands'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = pino({
    level: config.logLevel,
    base: { service: 'twake-nextcloud-migration' },
  })

  logger.info({ event: 'service.starting' }, 'Starting Nextcloud migration service')

  const clouderyClient = createClouderyClient(config.clouderyUrl, config.clouderyToken, logger)

  const rabbitClient = new RabbitMQClient({
    url: config.rabbitmqUrl,
    maxRetries: 3,
    retryDelay: 1000,
    prefetch: 10,
    logger,
  })

  await rabbitClient.init()
  logger.info({ event: 'rabbitmq.connected' }, 'Connected to RabbitMQ')

  await rabbitClient.subscribe(
    EXCHANGE,
    ROUTING_KEY,
    QUEUE,
    async (msg: RabbitMQMessage) => {
      const command = parseMigrationCommand(msg)
      await handleMigrationMessage(command, clouderyClient, logger, config)
    }
  )
  logger.info({
    event: 'rabbitmq.subscribed',
    exchange: EXCHANGE,
    queue: QUEUE,
    routing_key: ROUTING_KEY,
  }, 'Subscribed to migration queue')

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ event: 'service.shutting_down', signal }, 'Shutting down')
    await rabbitClient.close()
    logger.info({ event: 'service.stopped' }, 'RabbitMQ connection closed')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  console.error('Fatal error during startup:', error)
  process.exit(1)
})
