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
  /**
   * Schema version stamped on every write, so future consumers can
   * evolve the shape without guessing which fields exist. Bump when
   * the shape changes incompatibly.
   */
  schema_version?: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'canceled'
  target_dir: string
  progress: TrackingProgress
  /** Per-file errors, capped at {@link MAX_ERRORS_CAP}. */
  errors: TrackingError[]
  /**
   * Number of per-file errors that were dropped to stay within the
   * cap. Added rather than resizing the doc unbounded: a wide
   * migration with many failures would otherwise grow the doc past
   * CouchDB's per-document limit.
   */
  errors_truncated_count?: number
  /** Files skipped (typically via 409 on resume), capped at {@link MAX_SKIPPED_CAP}. */
  skipped: TrackingSkipped[]
  /** Number of skipped entries dropped to stay within the cap. */
  skipped_truncated_count?: number
  started_at: string | null
  finished_at: string | null
  /**
   * ISO timestamp stamped on every progress flush. Distinguishes an
   * actively-running migration from a zombie left behind by a crashed
   * consumer: a `running` doc whose heartbeat is older than the stale
   * threshold is resumable. Optional for backward compatibility with
   * docs written before the field existed.
   */
  last_heartbeat_at?: string | null
  /**
   * Human-readable reason a migration is in `failed` status. Distinct
   * from the per-file `errors` array, which is only meant to list
   * individual files that could not be transferred. Dual-written
   * alongside the legacy `{ path: '', message, at }` sentinel in
   * `errors` for back-compat with frontends still reading the old
   * shape; new consumers should prefer this field.
   */
  failure_reason?: string | null
  /**
   * Durable cancellation signal. Set to true by the cancel handler.
   * A running migration picks it up at the next `flushProgress`
   * checkpoint; a pending/failed doc about to start reads it in
   * `handleMigrationMessage` and transitions straight to `canceled`
   * without launching. Optional for back-compat with docs written
   * before the field existed.
   */
  cancel_requested?: boolean
  /**
   * ISO timestamp of when the user requested cancellation. Distinct
   * from `finished_at`, which stamps the terminal transition. Useful
   * for measuring the time between request and stop.
   */
  canceled_at?: string | null
}

export interface CancelCommand {
  migrationId: string
  workplaceFqdn: string
  timestamp: number
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
 * Reads a required string field off a raw RabbitMQ payload. Shared by
 * the request and cancel parsers so error messages stay consistent and
 * a single change point covers both.
 *
 * @param msg - Raw message payload
 * @param key - Field name to read
 * @param kind - Human-readable message kind, interpolated into the
 *   error message (e.g. `'migration'`, `'cancel'`)
 * @throws If the field is missing, empty, or not a string
 */
function requireString(msg: Record<string, unknown>, key: string, kind: string): string {
  const value = msg[key]
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid ${kind} message: missing or empty ${key}`)
  }
  return value
}

/**
 * Reads the `timestamp` field off a raw payload, defaulting to the
 * current time when the field is missing or malformed. Mirrors the
 * original request parser's tolerant behaviour.
 *
 * @param msg - Raw message payload
 * @returns The payload timestamp in ms, or `Date.now()` as a fallback
 */
function coerceTimestamp(msg: Record<string, unknown>): number {
  return typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
}

/**
 * Validates and extracts a CancelCommand from a raw RabbitMQ message.
 * @throws If migrationId or workplaceFqdn are missing
 */
export function parseCancelCommand(msg: Record<string, unknown>): CancelCommand {
  return {
    migrationId: requireString(msg, 'migrationId', 'cancel'),
    workplaceFqdn: requireString(msg, 'workplaceFqdn', 'cancel'),
    timestamp: coerceTimestamp(msg),
  }
}

/**
 * Validates and extracts a MigrationCommand from a raw RabbitMQ message.
 * @throws If migrationId, workplaceFqdn, or accountId are missing
 */
export function parseMigrationCommand(msg: Record<string, unknown>): MigrationCommand {
  return {
    migrationId: requireString(msg, 'migrationId', 'migration'),
    workplaceFqdn: requireString(msg, 'workplaceFqdn', 'migration'),
    accountId: requireString(msg, 'accountId', 'migration'),
    sourcePath: typeof msg.sourcePath === 'string' ? msg.sourcePath : '/',
    timestamp: coerceTimestamp(msg),
  }
}
