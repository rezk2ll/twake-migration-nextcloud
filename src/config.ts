import type { Config } from './types.js'

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
  return {
    rabbitmqUrl: requireEnv('RABBITMQ_URL'),
    clouderyUrl: requireEnv('CLOUDERY_URL'),
    clouderyToken: requireEnv('CLOUDERY_TOKEN'),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    flushInterval: parseInt(process.env.FLUSH_INTERVAL ?? '50', 10),
    stackUrlScheme: rawScheme,
  }
}
