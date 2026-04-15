declare module 'cozy-stack-client' {
  // The package ships as CommonJS with `__esModule: true`, so the real
  // runtime shape is `module.exports = { default: CozyStackClient, ... }`.
  // Node's ESM interop surfaces this object under the default import, which
  // is why stack-client.ts reaches through `.default` to get the class. The
  // type is exported both as a named export (for `import type`) and as the
  // default (for the runtime consumer) so both paths typecheck.
  export default CozyStackClientConstructor
  const CozyStackClientConstructor: {
    new (options: { uri: string; token: string }): CozyStackClient
  }

  export class CozyStackClient {
    constructor(options: { uri: string; token: string })
    collection(doctype: 'io.cozy.remote.nextcloud.files'): NextcloudFilesCollection
    collection(doctype: 'io.cozy.files'): FileCollection
    collection(doctype: 'io.cozy.settings'): SettingsCollection
    collection(doctype: string): DocumentCollection
    setToken(token: string): void
    fetch(method: string, path: string, body?: unknown, opts?: Record<string, unknown>): Promise<Response>
    fetchJSON(method: string, path: string, body?: unknown, opts?: Record<string, unknown>): Promise<unknown>
  }

  export class DocumentCollection {
    get(id: string): Promise<{ data: Record<string, unknown> }>
    create(doc: Record<string, unknown>): Promise<{ data: Record<string, unknown> }>
    update(doc: Record<string, unknown>): Promise<{ data: Record<string, unknown> }>
  }

  export class FileCollection extends DocumentCollection {
    createDirectory(
      attributes: { name: string; dirId: string },
      options?: { sanitizeName?: boolean }
    ): Promise<{ data: { _id: string; [key: string]: unknown } }>
  }

  export class NextcloudFilesCollection extends DocumentCollection {
    find(selector: {
      'cozyMetadata.sourceAccount': string
      parentPath: string
    }): Promise<{ data: Array<Record<string, unknown>> }>

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
