/** Message published by the Stack when a user requests a migration. */
export interface MigrationCommand {
  migrationId: string
  workplaceFqdn: string
  accountId: string
  sourcePath: string
  timestamp: number
}

/** Tracking document stored in CouchDB (io.cozy.nextcloud.migrations). */
export interface TrackingDoc {
  _id: string
  _rev?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  started_at?: string
  finished_at?: string
  bytes_total: number
  bytes_imported: number
  files_imported: number
  errors: TrackingError[]
  skipped: TrackingSkipped[]
}

export interface TrackingError {
  path: string
  message: string
}

export interface TrackingSkipped {
  path: string
  reason: string
  size: number
}

/** Entry returned by the Stack's Nextcloud directory listing. */
export interface NextcloudEntry {
  type: 'file' | 'directory'
  name: string
  path: string
  size: number
  mime: string
}

/** File document returned by the Stack after a transfer or dir creation. */
export interface CozyFile {
  _id: string
  _rev: string
  type: string
  name: string
  dir_id: string
  size: number
}

/** Disk usage from GET /settings/disk-usage. */
export interface DiskUsage {
  used: number
  quota: number
}

/** Parsed and validated environment config. */
export interface Config {
  rabbitmqUrl: string
  clouderyUrl: string
  clouderyToken: string
  logLevel: string
}
