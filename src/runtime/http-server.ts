import { createServer, type Server } from 'node:http'
import type { Logger } from 'pino'
import { registry } from './metrics.js'

/**
 * Minimal ops HTTP server exposing Kubernetes probes and a Prometheus
 * scrape target. Intentionally uses only `node:http` — no framework,
 * no route library — because the surface is tiny and changes rarely.
 */
export interface OpsServer {
  /** Opens the listen socket. Resolves once the server is bound. */
  start(): Promise<void>
  /** Closes the listen socket. Resolves once all connections drain. */
  stop(): Promise<void>
}

/**
 * Signals that gate the probes. Health is checked against the live
 * state of RabbitMQ and the shutdown flag so `/readyz` flips to 503
 * during graceful shutdown, which tells Kubernetes to stop routing
 * new traffic (relevant once the chart adds a Service; harmless
 * otherwise).
 */
export interface ReadinessSignals {
  isRabbitMQConnected: () => boolean
  isShuttingDown: () => boolean
}

/**
 * @param port - TCP port to bind on 0.0.0.0
 * @param signals - Readiness signals inspected per request
 * @param logger - Pino logger
 */
export function createOpsServer(
  port: number,
  signals: ReadinessSignals,
  logger: Logger,
): OpsServer {
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? ''
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    if (url === '/healthz') {
      // Liveness — is the process reachable at all. A green /healthz
      // plus a stuck event loop would still return 200; that is the
      // point of keeping it deliberately cheap.
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
      return
    }
    if (url === '/readyz') {
      const ready = signals.isRabbitMQConnected() && !signals.isShuttingDown()
      res
        .writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain' })
        .end(ready ? 'ready' : 'not ready')
      return
    }
    if (url === '/metrics') {
      try {
        const body = await registry.metrics()
        res
          .writeHead(200, { 'Content-Type': registry.contentType })
          .end(body)
      } catch (error) {
        logger.error({
          event: 'http.metrics_failed',
          error: error instanceof Error ? error.message : String(error),
        }, 'Failed to render Prometheus metrics')
        res.writeHead(500).end()
      }
      return
    }
    res.writeHead(404).end()
  })

  return {
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => {
          server.off('error', reject)
          logger.info({ event: 'http.listening', port }, 'Ops HTTP server listening')
          resolve()
        })
      })
    },
    async stop() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}
