import type { Logger } from 'pino'
import cozyStackClientPkg from 'cozy-stack-client'
import type { CozyStackClient as CozyStackClientType } from 'cozy-stack-client'
import type { ClouderyClient } from './cloudery-client.js'
import type { TrackingDoc } from '../domain/types.js'
import { DOCTYPES } from '../domain/doctypes.js'

export interface NextcloudEntry {
  type: 'file' | 'directory'
  name: string
  path: string
  size: number
  mime: string
}

/** Unwrapped from the Stack's JSON-API response. Size is parsed from string. */
export interface CozyFile {
  id: string
  name: string
  dir_id: string
  size: number
}

export interface DiskUsage {
  used: number
  /** 0 means unlimited in Cozy Stack. */
  quota: number
}

// cozy-stack-client is published as CommonJS with `__esModule: true`, which
// means Node's ESM→CJS interop surfaces module.exports under the default
// import. The class lives at `.default` on that object, and AppToken is not
// re-exported from the package index at all. Reach through once and then use
// CozyStackClient like a normal constructor. The constructor accepts either
// an AppToken instance or a raw JWT string, so we pass the string directly
// and sidestep the missing AppToken export.
const CozyStackClient = (cozyStackClientPkg as unknown as {
  default: new (options: { uri: string; token: string }) => CozyStackClientType
}).default

export interface StackClient {
  /** Lists files and directories in a Nextcloud path via the Stack's WebDAV proxy. */
  listNextcloudDir(accountId: string, path: string): Promise<NextcloudEntry[]>
  /**
   * Returns the recursive byte total of a Nextcloud folder (or file) as
   * reported by Nextcloud's server-maintained `oc:size` property. Used
   * as the pre-flight quota check source of truth.
   */
  getNextcloudSize(accountId: string, path: string): Promise<number>
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

/**
 * Creates a StackClient backed by cozy-stack-client with automatic token refresh.
 * @param workplaceFqdn - FQDN of the target Cozy instance
 * @param urlScheme - `https` in production, `http` for local dev Stacks
 * @param initialToken - JWT token obtained from the Cloudery
 * @param clouderyClient - Used to refresh the token on 401
 * @param logger - Pino logger (should carry migration context via .child())
 * @returns StackClient instance
 */
export function createStackClient(
  workplaceFqdn: string,
  urlScheme: 'http' | 'https',
  initialToken: string,
  clouderyClient: ClouderyClient,
  logger: Logger
): StackClient {
  const cozy = new CozyStackClient({
    uri: `${urlScheme}://${workplaceFqdn}`,
    token: initialToken,
  })

  const ncCollection = cozy.collection(DOCTYPES.NC_FILES)
  const docCollection = cozy.collection(DOCTYPES.MIGRATIONS)
  const settingsCollection = cozy.collection(DOCTYPES.SETTINGS)
  const fileCollection = cozy.collection(DOCTYPES.FILES)

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
        cozy.setToken(newToken)
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
     * Fetches the recursive byte total of a Nextcloud folder through the
     * Stack's /size/*path proxy route. The Stack itself issues a Depth:0
     * PROPFIND for the `oc:size` property on the target path, so this
     * costs one constant-time round trip regardless of how deeply the
     * folder is nested or how many files it contains. Pass an empty
     * string or '/' to target the account root.
     * @param accountId - Nextcloud account ID (io.cozy.accounts)
     * @param path - Nextcloud directory (or file) path
     * @returns Total bytes of the target subtree, as a JS number
     */
    async getNextcloudSize(accountId: string, path: string): Promise<number> {
      const encodedPath = path
        .split('/')
        .map((segment) =>
          encodeURIComponent(segment).replace(/\(/g, '%28').replace(/\)/g, '%29'),
        )
        .join('/')
      const trimmed = encodedPath.startsWith('/') ? encodedPath : '/' + encodedPath
      const url = `/remote/nextcloud/${encodeURIComponent(accountId)}/size${trimmed}`

      const body = await withTokenRefresh(() =>
        cozy.fetchJSON('GET', url),
      ) as { size: number | string }
      return typeof body.size === 'string' ? parseInt(body.size, 10) : body.size
    },

    /**
     * Copies a file from Nextcloud into a Cozy directory via the Stack's
     * downstream route. Fails with 409 if the file already exists.
     *
     * Goes through cozy.fetchJSON rather than ncCollection.moveToCozy
     * because the library's moveToCozy constructs its FetchError with a
     * non-awaited `resp.json()` call, which corrupts the Response body and
     * causes node's undici to throw "Body is unusable" on every 4xx —
     * crashing the whole consumer process on the first file conflict.
     * Using fetchJSON bypasses that path: the Stack client's core fetch
     * reads the body once via getResponseData and hangs the parsed body
     * off `error.reason`, so 409s surface as normal throwable errors the
     * migration loop can skip.
     *
     * @param accountId - Nextcloud account ID (io.cozy.accounts)
     * @param ncPath - Source file path on Nextcloud
     * @param cozyDirId - Target Cozy directory ID
     * @returns The created file's metadata
     */
    async transferFile(accountId: string, ncPath: string, cozyDirId: string): Promise<CozyFile> {
      const encodedPath = ncPath
        .split('/')
        .map((segment) =>
          encodeURIComponent(segment).replace(/\(/g, '%28').replace(/\)/g, '%29'),
        )
        .join('/')
      const url =
        `/remote/nextcloud/${encodeURIComponent(accountId)}/downstream${encodedPath}` +
        `?To=${encodeURIComponent(cozyDirId)}&Copy=true&FailOnConflict=true`

      const body = await withTokenRefresh(() =>
        cozy.fetchJSON('POST', url),
      ) as { data: { id: string; attributes: Record<string, unknown> } }
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
     * looks up the existing directory in the parent's children and returns
     * its ID. This supports idempotent retries of a crashed migration.
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
        if (status !== 409) {
          throw error
        }
        // On 409, the Stack's body does not carry the conflicting doc's id
        // (`errors[0].source` is empty), so we query the parent to find the
        // matching child by name. Reading `error.response.json()` would
        // crash with "Body is unusable" because cozy-stack-client already
        // drained it while constructing the FetchError — never go there.
        const parent = await withTokenRefresh(() =>
          cozy.fetchJSON('GET', `/files/${encodeURIComponent(parentDirId)}?page[limit]=1000`)
        ) as {
          included?: Array<{ id: string; attributes: { name: string; type: string } }>
        }
        const existing = parent.included?.find(
          (child) => child.attributes.name === name && child.attributes.type === 'directory',
        )
        if (existing) return existing.id
        throw new Error(
          `Stack 409 on createDir but could not find existing directory ${name} under ${parentDirId}`,
        )
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
