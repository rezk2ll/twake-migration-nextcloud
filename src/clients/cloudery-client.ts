import type { Logger } from 'pino'
import { MIGRATION_TOKEN_SCOPE } from '../domain/doctypes.js'

export interface ClouderyClient {
  /** Returns a Stack token for the given instance, using the cache when fresh. */
  getToken(workplaceFqdn: string): Promise<string>
  /** Forces a fresh fetch, invalidating any cached token. Use on 401. */
  refreshToken(workplaceFqdn: string): Promise<string>
}

/** Per-request ceiling for the Cloudery token endpoint. */
const CLOUDERY_TIMEOUT_MS = 30_000
/**
 * How long a successful token is reused before we ask the Cloudery
 * again. Conservative: real Stack tokens live much longer, but we do
 * not parse their `exp`, and a short TTL limits blast radius if a
 * token is revoked upstream. A 401 from the Stack forces a refresh
 * regardless of TTL.
 */
const CACHE_TTL_MS = 60_000
const MAX_ATTEMPTS = 3
const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 4_000
/** Multiplier range for backoff jitter: delay * [0.75 .. 1.25]. */
const JITTER_MIN = 0.75
const JITTER_SPREAD = 0.5

/** Statuses the Cloudery may return transiently — worth retrying. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])

interface CachedToken {
  token: string
  expiresAt: number
}

/**
 * Marker property set on timeout errors so {@link isRetryable} can
 * classify them without parsing free-text error messages.
 */
interface TimeoutError extends Error {
  timedOut: true
}

/**
 * Creates a client for the Cloudery token endpoint with retry + cache.
 * Token fetches retry on transient failures (5xx, 429, network errors)
 * with exponential backoff and jitter. Successful tokens are cached
 * per-FQDN for {@link CACHE_TTL_MS} and concurrent callers share a
 * single in-flight fetch.
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
  const cache = new Map<string, CachedToken>()
  const pending = new Map<string, Promise<string>>()

  async function fetchOnce(workplaceFqdn: string): Promise<string> {
    const start = Date.now()
    const url = `${clouderyUrl}/api/public/instances/${workplaceFqdn}/token`
    // Native fetch accepts an AbortSignal, so we cancel the socket
    // directly on timeout rather than only freeing the caller.
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
        const timeoutError: TimeoutError = Object.assign(
          new Error(
            `Cloudery token request timed out after ${CLOUDERY_TIMEOUT_MS}ms`,
          ),
          { timedOut: true as const },
        )
        throw timeoutError
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      const body = await response.text()
      logger.warn({
        event: 'cloudery.token_failed',
        instance: workplaceFqdn,
        status: response.status,
        duration_ms: Date.now() - start,
        error: body,
      }, 'Cloudery token request failed')
      throw Object.assign(
        new Error(`Cloudery token request failed (${response.status}): ${body}`),
        { status: response.status },
      )
    }

    const data = (await response.json()) as { token: string }
    return data.token
  }

  function isRetryable(error: unknown): boolean {
    if ((error as { timedOut?: boolean }).timedOut) return true
    const status = (error as { status?: number }).status
    if (typeof status === 'number') return RETRYABLE_STATUSES.has(status)
    // No status means a native fetch failure (DNS, ECONNREFUSED, etc.).
    return true
  }

  async function fetchWithRetry(workplaceFqdn: string): Promise<string> {
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await fetchOnce(workplaceFqdn)
      } catch (error) {
        lastError = error
        if (!isRetryable(error) || attempt === MAX_ATTEMPTS - 1) break
        const base = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
        const delay = base * (JITTER_MIN + Math.random() * JITTER_SPREAD)
        logger.warn({
          event: 'cloudery.token_retry',
          instance: workplaceFqdn,
          attempt: attempt + 1,
          delay_ms: Math.round(delay),
          error: error instanceof Error ? error.message : String(error),
        }, 'Retrying Cloudery token request')
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
      }
    }
    logger.error({
      event: 'cloudery.token_failed',
      instance: workplaceFqdn,
      attempts: MAX_ATTEMPTS,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    }, 'Cloudery token request exhausted retries')
    throw lastError
  }

  function fetchAndCache(workplaceFqdn: string): Promise<string> {
    const existing = pending.get(workplaceFqdn)
    if (existing) return existing
    const promise = fetchWithRetry(workplaceFqdn)
      .then((token) => {
        cache.set(workplaceFqdn, { token, expiresAt: Date.now() + CACHE_TTL_MS })
        return token
      })
      .finally(() => {
        pending.delete(workplaceFqdn)
      })
    pending.set(workplaceFqdn, promise)
    return promise
  }

  return {
    async getToken(workplaceFqdn: string): Promise<string> {
      const cached = cache.get(workplaceFqdn)
      if (cached && cached.expiresAt > Date.now()) return cached.token
      // Prune expired entry so unique FQDNs do not accumulate stale
      // records indefinitely in long-running processes.
      if (cached) cache.delete(workplaceFqdn)
      return fetchAndCache(workplaceFqdn)
    },
    async refreshToken(workplaceFqdn: string): Promise<string> {
      cache.delete(workplaceFqdn)
      return fetchAndCache(workplaceFqdn)
    },
  }
}
