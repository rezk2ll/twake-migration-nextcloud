import type { Logger } from 'pino'
import type { ClouderyClient } from './cloudery-client.js'
import type {
  NextcloudEntry,
  CozyFile,
  DiskUsage,
  TrackingDoc,
} from './types.js'

export interface StackClient {
  listNextcloudDir(accountId: string, path: string): Promise<NextcloudEntry[]>
  transferFile(accountId: string, ncPath: string, cozyDirId: string): Promise<CozyFile>
  createDir(parentDirId: string, name: string): Promise<string>
  getDiskUsage(): Promise<DiskUsage>
  getTrackingDoc(id: string): Promise<TrackingDoc>
  updateTrackingDoc(doc: TrackingDoc): Promise<TrackingDoc>
}

const MIGRATIONS_DOCTYPE = 'io.cozy.nextcloud.migrations'

function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path
}

/**
 * Creates an HTTP client for the Cozy Stack API with automatic 401 token refresh.
 * @param workplaceFqdn - FQDN of the target Cozy instance
 * @param initialToken - JWT token obtained from the Cloudery
 * @param clouderyClient - Used to refresh the token on 401
 * @param logger - Pino logger (should already carry migration context via .child())
 * @returns StackClient instance
 */
export function createStackClient(
  workplaceFqdn: string,
  initialToken: string,
  clouderyClient: ClouderyClient,
  logger: Logger
): StackClient {
  const baseUrl = `https://${workplaceFqdn}`
  let token = initialToken

  async function request(
    method: string,
    path: string,
    options: RequestInit = {}
  ): Promise<{ response: Response; body: string; duration_ms: number }> {
    const start = Date.now()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(options.headers as Record<string, string> ?? {}),
    }

    let response = await fetch(`${baseUrl}${path}`, { ...options, method, headers })

    if (response.status === 401) {
      logger.warn({
        event: 'stack.token_refresh',
        method,
        path,
        duration_ms: Date.now() - start,
      }, 'Stack returned 401, refreshing token')
      token = await clouderyClient.getToken(workplaceFqdn)
      const retryHeaders = { ...headers, Authorization: `Bearer ${token}` }
      response = await fetch(`${baseUrl}${path}`, { ...options, method, headers: retryHeaders })
    }

    const body = await response.text()
    const duration_ms = Date.now() - start

    if (!response.ok) {
      logger.error({
        event: 'stack.request_failed',
        method,
        path,
        status: response.status,
        duration_ms,
        error: body,
      }, 'Stack request failed')
      throw new Error(`Stack request failed (${response.status}): ${body}`)
    }

    logger.debug({
      event: 'stack.request',
      method,
      path,
      status: response.status,
      duration_ms,
    }, 'Stack request completed')

    return { response, body, duration_ms }
  }

  return {
    async listNextcloudDir(accountId: string, path: string): Promise<NextcloudEntry[]> {
      const reqPath = `/remote/nextcloud/${accountId}/${stripLeadingSlash(path)}`
      const { body } = await request('GET', reqPath)
      const entries = JSON.parse(body) as NextcloudEntry[]
      logger.debug({
        event: 'stack.nextcloud_list',
        nc_path: path,
        entry_count: entries.length,
      }, 'Listed Nextcloud directory')
      return entries
    },

    async transferFile(accountId: string, ncPath: string, cozyDirId: string): Promise<CozyFile> {
      const reqPath = `/remote/nextcloud/${accountId}/downstream/${stripLeadingSlash(ncPath)}?To=${cozyDirId}&Copy=true`
      const { body, duration_ms } = await request('POST', reqPath)
      const parsed = JSON.parse(body) as { data: { id: string; attributes: Record<string, unknown> } }
      const attrs = parsed.data.attributes
      const file: CozyFile = {
        id: parsed.data.id,
        name: attrs.name as string,
        dir_id: attrs.dir_id as string,
        size: typeof attrs.size === 'string' ? parseInt(attrs.size, 10) : (attrs.size as number),
      }
      logger.debug({
        event: 'stack.file_transferred',
        nc_path: ncPath,
        file_id: file.id,
        size: file.size,
        duration_ms,
      }, 'File transferred from Nextcloud to Cozy')
      return file
    },

    async createDir(parentDirId: string, name: string): Promise<string> {
      const reqPath = `/files/${parentDirId}?Name=${name}&Type=directory`
      const start = Date.now()
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      }
      const response = await fetch(`${baseUrl}${reqPath}`, { method: 'POST', headers })
      const body = await response.text()
      const duration_ms = Date.now() - start

      if (response.status === 409) {
        const conflict = JSON.parse(body) as { errors?: Array<{ source?: { id?: string } }> }
        const existingId = conflict.errors?.[0]?.source?.id
        if (!existingId) {
          throw new Error(`Stack 409 on createDir but no existing dir ID in response: ${body}`)
        }
        logger.debug({
          event: 'stack.dir_exists',
          name,
          parent_dir_id: parentDirId,
          dir_id: existingId,
          duration_ms,
        }, 'Directory already exists')
        return existingId
      }

      if (!response.ok) {
        logger.error({
          event: 'stack.request_failed',
          method: 'POST',
          path: reqPath,
          status: response.status,
          duration_ms,
          error: body,
        }, 'Stack request failed')
        throw new Error(`Stack request failed (${response.status}): ${body}`)
      }

      const created = JSON.parse(body) as { data: { id: string } }
      logger.debug({
        event: 'stack.dir_created',
        name,
        parent_dir_id: parentDirId,
        dir_id: created.data.id,
        duration_ms,
      }, 'Directory created')
      return created.data.id
    },

    async getDiskUsage(): Promise<DiskUsage> {
      const { body } = await request('GET', '/settings/disk-usage')
      const parsed = JSON.parse(body) as { data: { attributes: { used: string; quota: string } } }
      const usage = {
        used: parseInt(parsed.data.attributes.used, 10),
        quota: parseInt(parsed.data.attributes.quota, 10),
      }
      logger.info({
        event: 'stack.disk_usage',
        used: usage.used,
        quota: usage.quota,
      }, 'Disk usage retrieved')
      return usage
    },

    async getTrackingDoc(id: string): Promise<TrackingDoc> {
      const { body } = await request('GET', `/data/${MIGRATIONS_DOCTYPE}/${id}`)
      return JSON.parse(body) as TrackingDoc
    },

    async updateTrackingDoc(doc: TrackingDoc): Promise<TrackingDoc> {
      const { body } = await request('PUT', `/data/${MIGRATIONS_DOCTYPE}/${doc._id}`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      })
      const result = JSON.parse(body) as { ok: boolean; id: string; rev: string }
      return { ...doc, _rev: result.rev }
    },
  }
}
