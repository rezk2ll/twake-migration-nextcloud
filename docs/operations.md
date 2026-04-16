# Operations

Runbook for operating the service in production. Covers how to tell when something is wrong, what the service does automatically, and when a human needs to step in.

## Health and metrics

The service exposes a small HTTP server on `HTTP_PORT` (default `8080`) with three endpoints:

| Path | Purpose |
|---|---|
| `/healthz` | Liveness probe. Always returns 200 while the process is alive. Deliberately cheap — a stuck event loop can still return 200, which is the point of separating it from readiness. |
| `/readyz` | Readiness probe. Returns 200 only when RabbitMQ is connected and the process is not shutting down. Flips to 503 as soon as SIGTERM is received so load balancers and `PodDisruptionBudget` logic stop routing to the pod before the drain begins. |
| `/metrics` | Prometheus text exposition. Scrape interval of 15–30 s is plenty; the metrics below are counters and gauges, not high-cardinality. |

In Kubernetes, point `livenessProbe` at `/healthz` and `readinessProbe` at `/readyz`. The default Helm chart values do this for you.

### Metrics worth alerting on

| Metric | Type | What it tells you |
|---|---|---|
| `nextcloud_migration_active` | gauge | How many migrations are in-flight right now. Sustained at the concurrency cap means you're queue-bound. |
| `nextcloud_migration_started_total` | counter | Migration arrival rate. Alert on a drop to zero while the RabbitMQ queue has items — indicates the consumer has stopped picking work up. |
| `nextcloud_migration_finished_total{outcome}` | counter | `outcome="completed"` vs `outcome="failed"`. Alert on a sustained failure ratio above your tolerance (e.g. > 10%). |
| `nextcloud_migration_files_total{outcome}` | counter | Per-file outcomes (`transferred`, `skipped`, `failed`). `skipped` is normal during resumes; `failed` is not. |
| `nextcloud_migration_file_transfer_duration_seconds` | histogram | Per-file transfer latency. A shift in the upper buckets is an early signal of Stack or Nextcloud slowdown. |
| `nextcloud_migration_cloudery_token_total{outcome}` | counter | `outcome="success"` vs `"failed"`. A spike in failed tokens points at Cloudery, not at this service. |
| `nextcloud_migration_rabbitmq_connected` | gauge | `1` when connected, `0` otherwise. Complements the `/readyz` probe for dashboards. |

Default Node.js runtime metrics (event loop lag, heap, GC) are included automatically by `prom-client`.

## Log-based signals

Even with metrics, the event log remains the source of truth for per-migration diagnosis:

- **Process uptime.** Log lines with `event: service.starting`, `service.shutting_down`, `service.stopped` delimit lifetimes.
- **RabbitMQ connection.** An `event: rabbitmq.connected` on startup means the broker is reachable.
- **Consumption rate.** Count `event: consumer.message_received` over time.

If the process is alive, `/readyz` is green, but the queue keeps growing, look at the concurrency cap next.

## Events worth alerting on

Every log line carries a stable `event` field. Route these to your alert pipeline:

| Event | Severity | When |
|---|---|---|
| `service.stopped` with `drained: false` | info | Shutdown hit the 60 s drain deadline. Heartbeat recovery will pick up the stragglers, but investigate if this keeps happening. |
| `cloudery.token_failed` with `attempts: 3` | error | Cloudery retry budget exhausted — all three attempts failed. A short blip is fine; sustained means the Cloudery is down or your `CLOUDERY_TOKEN` is wrong. Alert on this specific variant with `attempts`, not on every `cloudery.token_failed`: the warn-level ones without `attempts` fire on each individual attempt and are expected noise during a retry. |
| `consumer.migration_unhandled_error` | error | A migration blew past the internal catch. Code bug; capture the stack trace. |
| `migration.tracking_update_failed` | error | Couldn't persist the terminal state of a migration. The doc is now a stale-running zombie; heartbeat logic will eventually reclaim it. |
| `runner.drain_timeout` | warn | In-flight migrations did not finish within the shutdown deadline. Expected during rolling deploys; persistent occurrences mean you're running very long migrations. |

The `cloudery.token_retry`, `stack.token_refresh`, and `consumer.resuming_stale` events are normal — informational only.

## Stuck migrations

**Symptom:** user reports their migration has been `running` forever in the UI.

Check the tracking document's `last_heartbeat_at`:

- **Younger than 30 minutes:** the migration is still active somewhere. If no consumer log lines confirm it, the consumer probably crashed between heartbeats — wait a bit longer or look for a new consumer picking it up.
- **Older than 30 minutes:** the doc is a zombie. The next message for this migration ID (e.g. a user retry) will trigger automatic resume — the service logs `consumer.resuming_stale` and takes over, skipping files already in Cozy. No manual intervention needed.

If no new message is coming (the original was ACKed and the queue is empty), publish a replacement to the exchange with the same `migrationId`. The stale-running recovery handles the rest.

## Failed migrations

A tracking doc in `failed` status carries two pieces of information:

- `failure_reason` — the migration-level fatal error (quota exceeded, source path missing, etc.).
- `errors[]` — per-file failures that happened before the fatal error, if any.

Common causes:

- **Insufficient quota:** `failure_reason` begins with `Insufficient quota`. The user needs more Cozy storage; re-triggering the migration won't help.
- **Source path not found:** `failure_reason` is `Source path not found in Nextcloud`. The user gave a path that doesn't exist in their Nextcloud; they need to fix the request, not retry as-is.
- **Per-file errors only:** `failure_reason` is null, some files are in `errors[]` but the migration is `completed`. The migration finished; those specific files need individual attention (permissions, corrupted source, etc.).

## Dead-letter queue

Queue: `migration.nextcloud.commands.dlq`.

The DLQ accumulates messages that:
- Hit a transient failure 3 times in a row (Stack 5xx, CouchDB conflict exhaustion, network partition).
- Failed JSON decoding at the library level.

Malformed payloads, missing tracking docs, and invalid source paths do **not** end up here — those are handled explicitly by the service and either marked failed or ACKed silently.

Inspect the DLQ via the RabbitMQ management UI. To replay: move a message back to `migration.nextcloud.commands` using the management UI's "Move messages" action. If something ends up in the DLQ repeatedly, the cause is not transient — investigate before replaying blindly.

## Configuration knobs you may want to tune

- **`MAX_CONCURRENT_MIGRATIONS`**: raise when the instance has headroom and migrations are queued; lower on cramped hosts to stop the consumer from starving neighbours.
- **`FLUSH_INTERVAL`**: raise under CouchDB write pressure; lower for more frequent progress bar updates (at the cost of more writes).
- **`LOG_LEVEL`**: bump to `debug` temporarily when diagnosing a specific instance; never leave it there in production — the per-file events become very noisy.

See [Configuration](configuration.md) for the full list.

## Graceful shutdown

On `SIGTERM` or `SIGINT`:

1. `/readyz` flips to 503 immediately so load balancers stop routing to the pod.
2. RabbitMQ subscription closes — no new messages are accepted.
3. The process waits up to 60 seconds for in-flight migrations to finish naturally.
4. The ops HTTP server closes.
5. If the drain deadline passed, the process exits anyway. Anything still running becomes a stale-running zombie and is reclaimed by the next consumer.

This matters for rolling deployments: if you expect migrations to routinely run longer than 60 seconds (most do), you'll see `service.stopped` with `drained: false` on every rollout. That's not a regression — it's the heartbeat recovery doing its job.
