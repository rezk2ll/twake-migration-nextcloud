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
 * @returns StackClient instance
 */
export function createStackClient(
  workplaceFqdn: string,
  initialToken: string,
  clouderyClient: ClouderyClient
): StackClient {
  const baseUrl = `https://${workplaceFqdn}`
  let token = initialToken

  async function request(path: string, options: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(options.headers as Record<string, string> ?? {}),
    }

    const response = await fetch(`${baseUrl}${path}`, { ...options, headers })

    if (response.status === 401) {
      token = await clouderyClient.getToken(workplaceFqdn)
      const retryHeaders = { ...headers, Authorization: `Bearer ${token}` }
      const retry = await fetch(`${baseUrl}${path}`, { ...options, headers: retryHeaders })
      if (!retry.ok) {
        const body = await retry.text()
        throw new Error(`Stack request failed after token refresh (${retry.status}): ${body}`)
      }
      return retry
    }

    return response
  }

  function assertOk(response: Response, body: string): void {
    if (!response.ok) {
      throw new Error(`Stack request failed (${response.status}): ${body}`)
    }
  }

  return {
    async listNextcloudDir(accountId: string, path: string): Promise<NextcloudEntry[]> {
      const response = await request(`/remote/nextcloud/${accountId}/${stripLeadingSlash(path)}`)
      const body = await response.text()
      assertOk(response, body)
      return JSON.parse(body) as NextcloudEntry[]
    },

    async transferFile(accountId: string, ncPath: string, cozyDirId: string): Promise<CozyFile> {
      const response = await request(
        `/remote/nextcloud/${accountId}/downstream/${stripLeadingSlash(ncPath)}?To=${cozyDirId}&Copy=true`,
        { method: 'POST' }
      )
      const body = await response.text()
      assertOk(response, body)
      const parsed = JSON.parse(body) as { data: { id: string; attributes: Record<string, unknown> } }
      const attrs = parsed.data.attributes
      return {
        id: parsed.data.id,
        name: attrs.name as string,
        dir_id: attrs.dir_id as string,
        size: typeof attrs.size === 'string' ? parseInt(attrs.size, 10) : (attrs.size as number),
      }
    },

    async createDir(parentDirId: string, name: string): Promise<string> {
      const response = await request(
        `/files/${parentDirId}?Name=${name}&Type=directory`,
        { method: 'POST' }
      )
      const body = await response.text()
      if (response.status === 409) {
        const conflict = JSON.parse(body) as { errors?: Array<{ source?: { id?: string } }> }
        const existingId = conflict.errors?.[0]?.source?.id
        if (!existingId) {
          throw new Error(`Stack 409 on createDir but no existing dir ID in response: ${body}`)
        }
        return existingId
      }
      assertOk(response, body)
      const created = JSON.parse(body) as { data: { id: string } }
      return created.data.id
    },

    async getDiskUsage(): Promise<DiskUsage> {
      const response = await request('/settings/disk-usage')
      const body = await response.text()
      assertOk(response, body)
      const parsed = JSON.parse(body) as { data: { attributes: { used: string; quota: string } } }
      return {
        used: parseInt(parsed.data.attributes.used, 10),
        quota: parseInt(parsed.data.attributes.quota, 10),
      }
    },

    async getTrackingDoc(id: string): Promise<TrackingDoc> {
      const response = await request(`/data/${MIGRATIONS_DOCTYPE}/${id}`)
      const body = await response.text()
      assertOk(response, body)
      return JSON.parse(body) as TrackingDoc
    },

    async updateTrackingDoc(doc: TrackingDoc): Promise<TrackingDoc> {
      const response = await request(
        `/data/${MIGRATIONS_DOCTYPE}/${doc._id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(doc),
        }
      )
      const body = await response.text()
      assertOk(response, body)
      const result = JSON.parse(body) as { ok: boolean; id: string; rev: string }
      return { ...doc, _rev: result.rev }
    },
  }
}
