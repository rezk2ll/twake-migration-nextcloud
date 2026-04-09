import { describe, it, expect, beforeEach, afterEach } from 'vitest'

describe('loadConfig', () => {
  const VALID_ENV = {
    RABBITMQ_URL: 'amqp://localhost',
    CLOUDERY_URL: 'https://manager.cozycloud.cc',
    CLOUDERY_TOKEN: 'secret-token',
  }

  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('parses valid environment variables', async () => {
    Object.assign(process.env, VALID_ENV)
    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    expect(config).toEqual({
      rabbitmqUrl: 'amqp://localhost',
      clouderyUrl: 'https://manager.cozycloud.cc',
      clouderyToken: 'secret-token',
      logLevel: 'info',
    })
  })

  it('uses LOG_LEVEL when provided', async () => {
    Object.assign(process.env, { ...VALID_ENV, LOG_LEVEL: 'debug' })
    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    expect(config.logLevel).toBe('debug')
  })

  it('throws when RABBITMQ_URL is missing', async () => {
    Object.assign(process.env, { ...VALID_ENV, RABBITMQ_URL: undefined })
    delete process.env.RABBITMQ_URL
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('RABBITMQ_URL')
  })

  it('throws when CLOUDERY_URL is missing', async () => {
    Object.assign(process.env, { ...VALID_ENV, CLOUDERY_URL: undefined })
    delete process.env.CLOUDERY_URL
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('CLOUDERY_URL')
  })

  it('throws when CLOUDERY_TOKEN is missing', async () => {
    Object.assign(process.env, { ...VALID_ENV, CLOUDERY_TOKEN: undefined })
    delete process.env.CLOUDERY_TOKEN
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('CLOUDERY_TOKEN')
  })
})
