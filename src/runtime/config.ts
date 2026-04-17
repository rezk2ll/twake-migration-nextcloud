export interface Config {
  rabbitmqUrl: string
  rabbitmqExchange: string
  rabbitmqRequestRoutingKey: string
  rabbitmqRequestQueue: string
  rabbitmqCancelRoutingKey: string
  rabbitmqCancelQueue: string
  clouderyUrl: string
  clouderyToken: string
  logLevel: string
  flushInterval: number
  /** URL scheme used when addressing the target Cozy Stack. Defaults to
   * `https`; set `STACK_URL_SCHEME=http` for local development against a
   * non-TLS Stack. */
  stackUrlScheme: 'http' | 'https'
  /** Maximum number of migrations allowed to run concurrently. Defaults
   * to 10 to match the RabbitMQ prefetch. */
  maxConcurrentMigrations: number
  /** TCP port the ops HTTP server (probes + /metrics) binds on. */
  httpPort: number
}

const DEFAULT_RABBITMQ_EXCHANGE = 'migration'
const DEFAULT_REQUEST_ROUTING_KEY = 'nextcloud.migration.requested'
const DEFAULT_REQUEST_QUEUE = 'migration.nextcloud.commands'
const DEFAULT_CANCEL_ROUTING_KEY = 'nextcloud.migration.canceled'
const DEFAULT_CANCEL_QUEUE = 'migration.nextcloud.cancels'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

/**
 * Reads an optional env var, treating missing AND empty string as "unset".
 * Uses `||` rather than `??` deliberately: an empty string is the common
 * foot-gun when the value comes from a Helm chart's ConfigMap key that
 * the user forgot to fill in, and we want the default in that case too.
 */
function envOrDefault(name: string, fallback: string): string {
  return process.env[name] || fallback
}

/**
 * Loads and validates configuration from environment variables.
 * @returns Parsed Config object
 * @throws If any required env var is missing or has an invalid value
 */
export function loadConfig(): Config {
  const rawScheme = (process.env.STACK_URL_SCHEME ?? 'https').toLowerCase()
  if (rawScheme !== 'http' && rawScheme !== 'https') {
    throw new Error(
      `STACK_URL_SCHEME must be 'http' or 'https', got: ${process.env.STACK_URL_SCHEME}`,
    )
  }
  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_MIGRATIONS ?? '10', 10)
  if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(
      `MAX_CONCURRENT_MIGRATIONS must be a positive integer, got: ${process.env.MAX_CONCURRENT_MIGRATIONS}`,
    )
  }
  const httpPort = parseInt(process.env.HTTP_PORT ?? '8080', 10)
  if (!Number.isFinite(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error(
      `HTTP_PORT must be a TCP port (1-65535), got: ${process.env.HTTP_PORT}`,
    )
  }
  return {
    rabbitmqUrl: requireEnv('RABBITMQ_URL'),
    rabbitmqExchange: envOrDefault('RABBITMQ_EXCHANGE', DEFAULT_RABBITMQ_EXCHANGE),
    rabbitmqRequestRoutingKey: envOrDefault('RABBITMQ_REQUEST_ROUTING_KEY', DEFAULT_REQUEST_ROUTING_KEY),
    rabbitmqRequestQueue: envOrDefault('RABBITMQ_REQUEST_QUEUE', DEFAULT_REQUEST_QUEUE),
    rabbitmqCancelRoutingKey: envOrDefault('RABBITMQ_CANCEL_ROUTING_KEY', DEFAULT_CANCEL_ROUTING_KEY),
    rabbitmqCancelQueue: envOrDefault('RABBITMQ_CANCEL_QUEUE', DEFAULT_CANCEL_QUEUE),
    clouderyUrl: requireEnv('CLOUDERY_URL'),
    clouderyToken: requireEnv('CLOUDERY_TOKEN'),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    flushInterval: parseInt(process.env.FLUSH_INTERVAL ?? '25', 10),
    stackUrlScheme: rawScheme,
    maxConcurrentMigrations: maxConcurrent,
    httpPort,
  }
}
