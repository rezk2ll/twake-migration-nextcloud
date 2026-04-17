import type { Config } from '../src/runtime/config.js'

/**
 * Produces a complete Config populated with the same defaults loadConfig
 * emits from an empty environment. Tests override just the fields they
 * exercise, which keeps them stable when Config grows new fields.
 */
export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    rabbitmqUrl: 'amqp://localhost',
    rabbitmqExchange: 'migration',
    rabbitmqRequestRoutingKey: 'nextcloud.migration.requested',
    rabbitmqRequestQueue: 'migration.nextcloud.commands',
    rabbitmqCancelRoutingKey: 'nextcloud.migration.canceled',
    rabbitmqCancelQueue: 'migration.nextcloud.cancels',
    clouderyUrl: 'https://manager.cozycloud.cc',
    clouderyToken: 'secret',
    logLevel: 'info',
    flushInterval: 25,
    stackUrlScheme: 'https',
    maxConcurrentMigrations: 10,
    httpPort: 8080,
    ...overrides,
  }
}
