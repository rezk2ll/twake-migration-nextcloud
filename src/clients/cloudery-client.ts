import type { Logger } from 'pino'
import { MIGRATION_TOKEN_SCOPE } from '../domain/doctypes.js'

export interface ClouderyClient {
  getToken(workplaceFqdn: string): Promise<string>
}

/** Per-request ceiling for the Cloudery token endpoint. */
const CLOUDERY_TIMEOUT_MS = 30_000

/**
 * Creates a client for the Cloudery token endpoint.
 * @param clouderyUrl - Base URL of the Cloudery (e.g. https://manager.cozycloud.cc)
 * @param clouderyToken - API bearer token for authenticating with the Cloudery
 * @param logger - Pino logger instance
 * @returns ClouderyClient instance
 */
export function createClouderyClient(
  clouderyUrl: string,
  clouderyToken: string,
  logger: Logger
): ClouderyClient {
  return {
    async getToken(workplaceFqdn: string): Promise<string> {
      const start = Date.now()
      const url = `${clouderyUrl}/api/public/instances/${workplaceFqdn}/token`
      // Native fetch accepts an AbortSignal, so we cancel the socket
      // directly rather than relying on the generic withTimeout helper,
      // which only frees the caller. Stack calls cannot do this because
      // cozy-stack-client does not forward a signal.
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), CLOUDERY_TIMEOUT_MS)
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${clouderyToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            audience: 'app',
            scope: MIGRATION_TOKEN_SCOPE,
          }),
          signal: controller.signal,
        })
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          logger.error({
            event: 'cloudery.token_failed',
            instance: workplaceFqdn,
            duration_ms: Date.now() - start,
            error: 'timeout',
          }, 'Cloudery token request timed out')
          throw new Error(
            `Cloudery token request timed out after ${CLOUDERY_TIMEOUT_MS}ms`
          )
        }
        throw error
      } finally {
        clearTimeout(timeoutId)
      }

      if (!response.ok) {
        const body = await response.text()
        logger.error({
          event: 'cloudery.token_failed',
          instance: workplaceFqdn,
          status: response.status,
          duration_ms: Date.now() - start,
          error: body,
        }, 'Cloudery token request failed')
        throw new Error(
          `Cloudery token request failed (${response.status}): ${body}`
        )
      }

      const data = (await response.json()) as { token: string }
      return data.token
    },
  }
}
