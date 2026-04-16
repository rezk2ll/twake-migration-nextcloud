import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

/**
 * Prometheus metrics for the consumer. Call sites import specific
 * metrics and call `.inc()` / `.observe()` directly; the shared
 * `registry` is exported for the HTTP server. Default Node runtime
 * metrics (heap, event-loop lag, GC) are opt-in via
 * {@link enableDefaultMetrics} — tests that import this module do
 * not want dangling interval timers registered at import time.
 */
export const registry = new Registry()

/**
 * Opts into prom-client's default Node runtime metrics. Call once,
 * typically from `main()` at process boot. Idempotent: repeat calls
 * on the same registry are silently ignored by prom-client.
 */
export function enableDefaultMetrics(): void {
  collectDefaultMetrics({ register: registry })
}

/** 1 when the RabbitMQ connection is up, 0 otherwise. */
export const rabbitmqConnected = new Gauge({
  name: 'nextcloud_migration_rabbitmq_connected',
  help: 'Whether the RabbitMQ connection is established (1) or not (0).',
  registers: [registry],
})

// Pull-model source for the active-migrations gauge. The runner holds
// the authoritative count; the gauge samples it at scrape time via the
// `collect` callback below. Bind the source once in `main()` after
// instantiating the runner.
let activeMigrationsSource: () => number = () => 0

/**
 * @param source - Function returning the current in-flight migration count
 */
export function bindActiveMigrationsSource(source: () => number): void {
  activeMigrationsSource = source
}

/** Current in-flight migrations, sampled from the runner on scrape. */
export const activeMigrations = new Gauge({
  name: 'nextcloud_migration_active',
  help: 'Number of migrations currently running on this consumer.',
  registers: [registry],
  collect() {
    this.set(activeMigrationsSource())
  },
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
