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
    const { loadConfig } = await import('../src/runtime/config.js')
    const config = loadConfig()
    expect(config).toEqual({
      rabbitmqUrl: 'amqp://localhost',
      clouderyUrl: 'https://manager.cozycloud.cc',
      clouderyToken: 'secret-token',
      logLevel: 'info',
      flushInterval: 50,
      stackUrlScheme: 'https',
    })
  })

  it('reads STACK_URL_SCHEME when set to http (dev against a local Stack)', async () => {
    Object.assign(process.env, { ...VALID_ENV, STACK_URL_SCHEME: 'http' })
    const { loadConfig } = await import('../src/runtime/config.js')
    expect(loadConfig().stackUrlScheme).toBe('http')
  })

  it('rejects STACK_URL_SCHEME values other than http or https', async () => {
    Object.assign(process.env, { ...VALID_ENV, STACK_URL_SCHEME: 'ftp' })
    const { loadConfig } = await import('../src/runtime/config.js')
    expect(() => loadConfig()).toThrow('STACK_URL_SCHEME')
  })

  it('uses LOG_LEVEL when provided', async () => {
    Object.assign(process.env, { ...VALID_ENV, LOG_LEVEL: 'debug' })
    const { loadConfig } = await import('../src/runtime/config.js')
    const config = loadConfig()
    expect(config.logLevel).toBe('debug')
  })

  it('throws when RABBITMQ_URL is missing', async () => {
    Object.assign(process.env, { ...VALID_ENV, RABBITMQ_URL: undefined })
    delete process.env.RABBITMQ_URL
    const { loadConfig } = await import('../src/runtime/config.js')
    expect(() => loadConfig()).toThrow('RABBITMQ_URL')
  })

  it('throws when CLOUDERY_URL is missing', async () => {
    Object.assign(process.env, { ...VALID_ENV, CLOUDERY_URL: undefined })
    delete process.env.CLOUDERY_URL
    const { loadConfig } = await import('../src/runtime/config.js')
    expect(() => loadConfig()).toThrow('CLOUDERY_URL')
  })

  it('throws when CLOUDERY_TOKEN is missing', async () => {
    Object.assign(process.env, { ...VALID_ENV, CLOUDERY_TOKEN: undefined })
    delete process.env.CLOUDERY_TOKEN
    const { loadConfig } = await import('../src/runtime/config.js')
    expect(() => loadConfig()).toThrow('CLOUDERY_TOKEN')
  })
})
