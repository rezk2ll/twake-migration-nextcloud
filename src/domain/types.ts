export interface MigrationCommand {
  migrationId: string
  workplaceFqdn: string
  accountId: string
  sourcePath: string
  timestamp: number
}

/** Doctype: io.cozy.nextcloud.migrations */
export interface TrackingDoc {
  _id: string
  _rev?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  target_dir: string
  progress: TrackingProgress
  errors: TrackingError[]
  skipped: TrackingSkipped[]
  started_at: string | null
  finished_at: string | null
}

export interface TrackingProgress {
  files_imported: number
  files_total: number
  bytes_imported: number
  bytes_total: number
}

export interface TrackingError {
  path: string
  message: string
  at: string
}

export interface TrackingSkipped {
  path: string
  reason: string
  size: number
}

/**
 * Validates and extracts a MigrationCommand from a raw RabbitMQ message.
 * @param msg - Raw message payload from RabbitMQ
 * @returns Validated MigrationCommand with defaults for optional fields
 * @throws If migrationId, workplaceFqdn, or accountId are missing
 */
export function parseMigrationCommand(msg: Record<string, unknown>): MigrationCommand {
  const { migrationId, workplaceFqdn, accountId, sourcePath, timestamp } = msg
  if (typeof migrationId !== 'string' || !migrationId) {
    throw new Error(`Invalid migration message: missing or empty migrationId`)
  }
  if (typeof workplaceFqdn !== 'string' || !workplaceFqdn) {
    throw new Error(`Invalid migration message: missing or empty workplaceFqdn`)
  }
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error(`Invalid migration message: missing or empty accountId`)
  }
  return {
    migrationId,
    workplaceFqdn,
    accountId,
    sourcePath: typeof sourcePath === 'string' ? sourcePath : '/',
    timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
  }
}
