# Operations

Runbook for operating the service in production. Covers how to tell when something is wrong, what the service does automatically, and when a human needs to step in.

## Health signal

The service has no HTTP health endpoint. What you can observe externally:

- **Process uptime.** Log lines with `event: service.starting`, `service.shutting_down`, `service.stopped` delimit lifetimes.
- **RabbitMQ connection.** An `event: rabbitmq.connected` on startup means the broker is reachable. Silent thereafter; connection drops surface as errors from the underlying library.
- **Consumption rate.** Count `event: consumer.message_received` over time. A healthy instance emits one per incoming migration request.

If the process is alive and RabbitMQ is drained but the queue keeps growing, look at the concurrency cap next.

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

1. RabbitMQ subscription closes immediately — no new messages are accepted.
2. The process waits up to 60 seconds for in-flight migrations to finish naturally.
3. If the deadline passes, the process exits anyway. Anything still running becomes a stale-running zombie and is reclaimed by the next consumer.

This matters for rolling deployments: if you expect migrations to routinely run longer than 60 seconds (most do), you'll see `service.stopped` with `drained: false` on every rollout. That's not a regression — it's the heartbeat recovery doing its job.
