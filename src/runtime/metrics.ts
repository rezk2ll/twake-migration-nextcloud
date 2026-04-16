import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

/**
 * Prometheus metrics for the consumer. One shared registry is
 * populated at import time so call sites can just `.inc()` or
 * `.observe()` without threading a registry through every factory.
 * The default Node runtime metrics (heap, event-loop lag, GC) are
 * collected automatically.
 */
export const registry = new Registry()
collectDefaultMetrics({ register: registry })

/** 1 when the RabbitMQ connection is up, 0 otherwise. */
export const rabbitmqConnected = new Gauge({
  name: 'nextcloud_migration_rabbitmq_connected',
  help: 'Whether the RabbitMQ connection is established (1) or not (0).',
  registers: [registry],
})

/** Current in-flight migrations (matches MigrationRunner.active). */
export const activeMigrations = new Gauge({
  name: 'nextcloud_migration_active',
  help: 'Number of migrations currently running on this consumer.',
  registers: [registry],
})

/** Migrations that the consumer has started. */
export const migrationsStarted = new Counter({
  name: 'nextcloud_migration_started_total',
  help: 'Total number of migrations started since process boot.',
  registers: [registry],
})

/**
 * Migrations that reached a terminal state. `outcome` is `completed`
 * or `failed`, matching the tracking document's status.
 */
export const migrationsFinished = new Counter({
  name: 'nextcloud_migration_finished_total',
  help: 'Total number of migrations that reached a terminal state.',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

/**
 * Per-file outcomes inside a migration. `outcome` is `transferred`,
 * `skipped`, or `failed`. Lets ops derive throughput and failure
 * rate without parsing the event log.
 */
export const filesProcessed = new Counter({
  name: 'nextcloud_migration_files_total',
  help: 'Total number of file operations attempted, by outcome.',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

/** Wall-clock duration of a single file transfer, in seconds. */
export const fileTransferDuration = new Histogram({
  name: 'nextcloud_migration_file_transfer_duration_seconds',
  help: 'Duration of a successful file transfer, in seconds.',
  // Covers sub-second small files through to multi-minute large
  // ones. The 900s upper bound matches TRANSFER_TIMEOUT_MS.
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900],
  registers: [registry],
})

/** Cloudery token fetches, labelled by final outcome. */
export const clouderyTokenRequests = new Counter({
  name: 'nextcloud_migration_cloudery_token_total',
  help: 'Total Cloudery token requests, by outcome.',
  labelNames: ['outcome'] as const,
  registers: [registry],
})
