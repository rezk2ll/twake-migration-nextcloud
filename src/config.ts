import type { Config } from './types.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export function loadConfig(): Config {
  return {
    rabbitmqUrl: requireEnv('RABBITMQ_URL'),
    clouderyUrl: requireEnv('CLOUDERY_URL'),
    clouderyToken: requireEnv('CLOUDERY_TOKEN'),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  }
}
