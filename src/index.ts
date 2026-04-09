import pino from 'pino'
import { RabbitMQClient, type RabbitMQMessage } from '@linagora/rabbitmq-client'
import { loadConfig } from './config.js'
import { createClouderyClient } from './cloudery-client.js'
import { handleMigrationMessage } from './consumer.js'
import type { MigrationCommand } from './types.js'

const EXCHANGE = 'migration'
const ROUTING_KEY = 'nextcloud.migration.requested'
const QUEUE = 'migration.nextcloud.commands'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = pino({ level: config.logLevel })

  logger.info('Starting Nextcloud migration service')

  const clouderyClient = createClouderyClient(config.clouderyUrl, config.clouderyToken)

  const rabbitClient = new RabbitMQClient({
    url: config.rabbitmqUrl,
    maxRetries: 3,
    retryDelay: 1000,
    prefetch: 10,
    logger,
  })

  await rabbitClient.init()
  logger.info('Connected to RabbitMQ')

  await rabbitClient.subscribe(
    EXCHANGE,
    ROUTING_KEY,
    QUEUE,
    async (msg: RabbitMQMessage) => {
      await handleMigrationMessage(msg as unknown as MigrationCommand, clouderyClient, logger)
    }
  )
  logger.info({ exchange: EXCHANGE, queue: QUEUE, routingKey: ROUTING_KEY }, 'Subscribed to migration queue')

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down')
    await rabbitClient.close()
    logger.info('RabbitMQ connection closed')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  console.error('Fatal error during startup:', error)
  process.exit(1)
})
