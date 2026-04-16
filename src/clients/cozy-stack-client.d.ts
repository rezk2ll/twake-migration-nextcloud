declare module 'cozy-stack-client' {
  // The package ships as CommonJS with `__esModule: true`, so the real
  // runtime shape is `module.exports = { default: CozyStackClient, ... }`.
  // Node's ESM interop surfaces that object under the default import,
  // which is why stack-client.ts reaches through `.default` to get the
  // class. The default export's declared type mirrors the runtime
  // wrapper so `cozyStackClientPkg.default` typechecks as the class.
  const cozyStackClientModule: { default: typeof CozyStackClient }
  export default cozyStackClientModule

  /** Attributes the Stack returns on a Cozy file/directory stat. */
  export interface FileAttributes {
    name: string
    type: 'file' | 'directory'
    path: string
    dir_id?: string
    size?: string | number
    mime?: string
    [key: string]: unknown
  }

  /** JSON-API envelope for a single file/directory document. */
  export interface FileStat {
    data: {
      _id: string
      attributes: FileAttributes
      [key: string]: unknown
    }
  }

  /** JSON-API envelope the downstream-transfer route returns. */
  export interface TransferredFile {
    data: {
      id: string
      attributes: {
        name: string
        dir_id: string
        size: string | number
        [key: string]: unknown
      }
    }
  }

  /** Raw shape of a directory listing entry from the Nextcloud proxy. */
  export interface NextcloudEntryRaw {
    type: 'file' | 'directory'
    name: string
    path: string
    size?: number | string
    mime?: string
    [key: string]: unknown
  }

  export class CozyStackClient {
    constructor(options: { uri: string; token: string })
    collection(doctype: 'io.cozy.remote.nextcloud.files'): NextcloudFilesCollection
    collection(doctype: 'io.cozy.files'): FileCollection
    collection(doctype: 'io.cozy.settings'): SettingsCollection
    collection<T = Record<string, unknown>>(doctype: string): DocumentCollection<T>
    setToken(token: string): void
    fetch(method: string, path: string, body?: unknown, opts?: Record<string, unknown>): Promise<Response>
    fetchJSON<T = unknown>(method: string, path: string, body?: unknown, opts?: Record<string, unknown>): Promise<T>
  }

  export class DocumentCollection<T = Record<string, unknown>> {
    get(id: string): Promise<{ data: T }>
    create(doc: T): Promise<{ data: T }>
    update(doc: T): Promise<{ data: T & { _rev: string } }>
  }

  export class FileCollection extends DocumentCollection {
    createDirectory(
      attributes: { name: string; dirId: string },
      options?: { sanitizeName?: boolean }
    ): Promise<FileStat>
    /**
     * Walks every segment of `path` and creates the missing ones,
     * returning the leaf stat. Idempotent — existing segments are
     * reused rather than producing a 409.
     */
    createDirectoryByPath(
      path: string,
      options?: { sanitizeName?: boolean }
    ): Promise<FileStat>
    /**
     * Stat-by-path then create-on-404 for a single child under
     * `parent`. The library handles the 404 internally, so this never
     * surfaces a 409 to the caller.
     */
    getDirectoryOrCreate(
      name: string,
      parent: { _id: string; attributes: { path: string } },
      options?: { sanitizeName?: boolean }
    ): Promise<FileStat>
    statByPath(path: string): Promise<FileStat>
  }

  export class NextcloudFilesCollection extends DocumentCollection {
    find(selector: {
      'cozyMetadata.sourceAccount': string
      parentPath: string
    }): Promise<{ data: NextcloudEntryRaw[] }>

    moveToCozy(
      file: { path: string; cozyMetadata: { sourceAccount: string } },
      to: { _id: string },
      options?: { copy?: boolean; FailOnConflict?: boolean }
    ): Promise<Response>
  }

  export class SettingsCollection {
    get(id: string): Promise<{ data: { attributes: Record<string, unknown> } }>
  }
}
