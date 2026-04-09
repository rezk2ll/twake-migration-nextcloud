import type { Logger } from 'pino'
import { CozyStackClient, AppToken } from 'cozy-stack-client'
import type { ClouderyClient } from './cloudery-client.js'
import type {
  NextcloudEntry,
  CozyFile,
  DiskUsage,
  TrackingDoc,
} from './types.js'

export interface StackClient {
  /** Lists files and directories in a Nextcloud path via the Stack's WebDAV proxy. */
  listNextcloudDir(accountId: string, path: string): Promise<NextcloudEntry[]>
  /** Transfers a file from Nextcloud into a Cozy directory (copy, fail on conflict). */
  transferFile(accountId: string, ncPath: string, cozyDirId: string): Promise<CozyFile>
  /** Creates a directory in Cozy VFS. Returns existing dir ID on 409. */
  createDir(parentDirId: string, name: string): Promise<string>
  /** Returns disk usage and quota for the Cozy instance. */
  getDiskUsage(): Promise<DiskUsage>
  /** Fetches a tracking document by ID from CouchDB. */
  getTrackingDoc(id: string): Promise<TrackingDoc>
  /** Updates a tracking document in CouchDB. Returns the doc with updated _rev. */
  updateTrackingDoc(doc: TrackingDoc): Promise<TrackingDoc>
}

const MIGRATIONS_DOCTYPE = 'io.cozy.nextcloud.migrations'
const NC_FILES_DOCTYPE = 'io.cozy.remote.nextcloud.files'

/**
 * Creates a StackClient backed by cozy-stack-client with automatic token refresh.
 * @param workplaceFqdn - FQDN of the target Cozy instance
 * @param initialToken - JWT token obtained from the Cloudery
 * @param clouderyClient - Used to refresh the token on 401
 * @param logger - Pino logger (should carry migration context via .child())
 * @returns StackClient instance
 */
export function createStackClient(
  workplaceFqdn: string,
  initialToken: string,
  clouderyClient: ClouderyClient,
  logger: Logger
): StackClient {
  const cozy = new CozyStackClient({
    uri: `https://${workplaceFqdn}`,
    token: new AppToken(initialToken),
  })

  const ncCollection = cozy.collection(NC_FILES_DOCTYPE)
  const docCollection = cozy.collection(MIGRATIONS_DOCTYPE)
  const settingsCollection = cozy.collection('io.cozy.settings')
  const fileCollection = cozy.collection('io.cozy.files')

  /**
   * Wraps a Stack operation with 401 token refresh. On 401, fetches a new
   * token from the Cloudery, updates the CozyStackClient, and retries once.
   * @param operation - Async function to execute and potentially retry
   * @returns The result of the operation
   * @throws The original error if status is not 401, or the retry error
   */
  async function withTokenRefresh<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error: unknown) {
      const status = (error as { status?: number }).status
      if (status === 401) {
        logger.warn({ event: 'stack.token_refresh' }, 'Stack returned 401, refreshing token')
        const newToken = await clouderyClient.getToken(workplaceFqdn)
        cozy.setToken(new AppToken(newToken))
        return await operation()
      }
      throw error
    }
  }

  return {
    /**
     * @param accountId - Nextcloud account ID (io.cozy.accounts)
     * @param path - Nextcloud directory path to list
     * @returns Array of file and directory entries
     */
    async listNextcloudDir(accountId: string, path: string): Promise<NextcloudEntry[]> {
      const { data } = await withTokenRefresh(() =>
        ncCollection.find({
          'cozyMetadata.sourceAccount': accountId,
          parentPath: path,
        })
      ) as { data: Array<Record<string, unknown>> }

      return data.map((entry) => ({
        type: entry.type as 'file' | 'directory',
        name: entry.name as string,
        path: entry.path as string,
        size: Number(entry.size ?? 0),
        mime: (entry.mime as string) ?? '',
      }))
    },

    /**
     * Copies a file from Nextcloud into a Cozy directory via the Stack's
     * downstream route. Fails with 409 if the file already exists.
     * @param accountId - Nextcloud account ID (io.cozy.accounts)
     * @param ncPath - Source file path on Nextcloud
     * @param cozyDirId - Target Cozy directory ID
     * @returns The created file's metadata
     */
    async transferFile(accountId: string, ncPath: string, cozyDirId: string): Promise<CozyFile> {
      const resp = await withTokenRefresh(() =>
        ncCollection.moveToCozy(
          { path: ncPath, cozyMetadata: { sourceAccount: accountId } },
          { _id: cozyDirId },
          { copy: true, FailOnConflict: true }
        )
      )

      const body = await resp.json() as { data: { id: string; attributes: Record<string, unknown> } }
      const attrs = body.data.attributes
      return {
        id: body.data.id,
        name: attrs.name as string,
        dir_id: attrs.dir_id as string,
        size: typeof attrs.size === 'string' ? parseInt(attrs.size, 10) : (attrs.size as number),
      }
    },

    /**
     * Creates a directory in Cozy VFS. If the directory already exists (409),
     * extracts and returns the existing directory's ID.
     * @param parentDirId - Parent directory ID in Cozy VFS
     * @param name - Name of the directory to create
     * @returns The created or existing directory's ID
     */
    async createDir(parentDirId: string, name: string): Promise<string> {
      try {
        const { data } = await withTokenRefresh(() =>
          fileCollection.createDirectory({ name, dirId: parentDirId })
        )
        return data._id as string
      } catch (error: unknown) {
        const status = (error as { status?: number }).status
        if (status === 409) {
          const response = (error as { response?: Response }).response
          if (response) {
            const body = await response.json() as { errors?: Array<{ source?: { id?: string } }> }
            const existingId = body.errors?.[0]?.source?.id
            if (existingId) return existingId
          }
          throw new Error(`Stack 409 on createDir but could not extract existing dir ID`)
        }
        throw error
      }
    },

    /**
     * @returns Disk usage (used bytes) and quota for the instance. Quota 0 means unlimited.
     */
    async getDiskUsage(): Promise<DiskUsage> {
      const { data } = await withTokenRefresh(() =>
        settingsCollection.get('io.cozy.settings.disk-usage')
      )
      const attrs = data.attributes as Record<string, string>
      return {
        used: parseInt(attrs.used, 10),
        quota: parseInt(attrs.quota, 10),
      }
    },

    /**
     * @param id - Tracking document ID (io.cozy.nextcloud.migrations)
     * @returns The full tracking document from CouchDB
     */
    async getTrackingDoc(id: string): Promise<TrackingDoc> {
      const { data } = await withTokenRefresh(() =>
        docCollection.get(id)
      )
      return data as unknown as TrackingDoc
    },

    /**
     * @param doc - Tracking document with _id and _rev
     * @returns The document with updated _rev from CouchDB
     */
    async updateTrackingDoc(doc: TrackingDoc): Promise<TrackingDoc> {
      const { data } = await withTokenRefresh(() =>
        docCollection.update(doc as unknown as Record<string, unknown>)
      )
      return { ...doc, _rev: data._rev as string }
    },
  }
}
