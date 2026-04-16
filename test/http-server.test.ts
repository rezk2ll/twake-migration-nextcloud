import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createOpsServer, type OpsServer } from '../src/runtime/http-server.js'
import { registry, migrationsStarted } from '../src/runtime/metrics.js'
import type { Logger } from 'pino'

const logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger

/**
 * Grabs a free ephemeral port by letting the OS choose. Safe because
 * vitest runs tests within a file sequentially — two tests in this
 * file never hold a port at the same time.
 */
async function pickPort(): Promise<number> {
  const { createServer } = await import('node:http')
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: response.status, body: await response.text() }
}

describe('opsServer', () => {
  let server: OpsServer
  let port: number
  let rabbitConnected: boolean
  let shuttingDown: boolean

  beforeEach(async () => {
    port = await pickPort()
    rabbitConnected = false
    shuttingDown = false
    server = createOpsServer(port, {
      isRabbitMQConnected: () => rabbitConnected,
      isShuttingDown: () => shuttingDown,
    }, logger)
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('answers /healthz with 200 regardless of readiness', async () => {
    const res = await get(port, '/healthz')
    expect(res.status).toBe(200)
    expect(res.body).toBe('ok')
  })

  it('/readyz returns 503 until RabbitMQ is connected', async () => {
    expect((await get(port, '/readyz')).status).toBe(503)
    rabbitConnected = true
    expect((await get(port, '/readyz')).status).toBe(200)
  })

  it('/readyz flips to 503 once shutdown begins, even if RabbitMQ is still connected', async () => {
    rabbitConnected = true
    expect((await get(port, '/readyz')).status).toBe(200)
    shuttingDown = true
    expect((await get(port, '/readyz')).status).toBe(503)
  })

  it('/metrics exposes the Prometheus text exposition format', async () => {
    // Touching a metric first so the output is non-trivial.
    migrationsStarted.inc()
    const res = await get(port, '/metrics')
    expect(res.status).toBe(200)
    expect(res.body).toContain('# HELP nextcloud_migration_started_total')
    expect(res.body).toMatch(/nextcloud_migration_started_total \d+/)
  })

  it('rejects non-GET methods with 405', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { method: 'POST' })
    expect(response.status).toBe(405)
  })

  it('returns 404 for unknown paths', async () => {
    expect((await get(port, '/nope')).status).toBe(404)
  })

  it('uses the shared metrics registry, so call-site increments are visible', async () => {
    // Counters only move forward, so capture before/after numbers.
    const before = await registry.getSingleMetric('nextcloud_migration_started_total')?.get()
    const beforeValue = (before?.values?.[0]?.value as number | undefined) ?? 0
    migrationsStarted.inc(2)
    const res = await get(port, '/metrics')
    const match = res.body.match(/nextcloud_migration_started_total (\d+)/)
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBe(beforeValue + 2)
  })
})
