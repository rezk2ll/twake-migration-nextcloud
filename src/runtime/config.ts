export interface Config {
  rabbitmqUrl: string
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
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
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
  return {
    rabbitmqUrl: requireEnv('RABBITMQ_URL'),
    clouderyUrl: requireEnv('CLOUDERY_URL'),
    clouderyToken: requireEnv('CLOUDERY_TOKEN'),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    flushInterval: parseInt(process.env.FLUSH_INTERVAL ?? '25', 10),
    stackUrlScheme: rawScheme,
    maxConcurrentMigrations: maxConcurrent,
  }
}
