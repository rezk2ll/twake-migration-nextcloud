import type { Logger } from 'pino'
import { MIGRATION_TOKEN_SCOPE } from './doctypes.js'

export interface ClouderyClient {
  getToken(workplaceFqdn: string): Promise<string>
}

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
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clouderyToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audience: 'app',
          scope: MIGRATION_TOKEN_SCOPE,
        }),
      })

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
