# RabbitMQ Contract

## Topology

The service consumes from a single queue bound to a topic exchange.

| Component | Value |
|---|---|
| Exchange | `migration` (topic, durable) |
| Routing key | `nextcloud.migration.requested` |
| Queue | `migration.nextcloud.commands` (quorum, durable) |
| Dead-letter exchange | `migration.dlx` |
| Dead-letter queue | `migration.nextcloud.commands.dlq` |

The exchange, queue, dead-letter infrastructure, and bindings are all created automatically by `@linagora/rabbitmq-client` on startup.

## Message format

Published by the Cozy Stack when a user starts a migration.

```json
{
  "migrationId": "d4e5f6a7-b8c9-4d0e-a1b2-c3d4e5f6a7b8",
  "workplaceFqdn": "alice.cozy.example.com",
  "accountId": "a1b2c3d4e5f6",
  "sourcePath": "/",
  "timestamp": 1712563200
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `migrationId` | string (UUID) | yes | Matches the tracking document `_id` |
| `workplaceFqdn` | string | yes | Target Cozy instance FQDN |
| `accountId` | string | yes | `io.cozy.accounts` document ID for the Nextcloud connection |
| `sourcePath` | string | no | Nextcloud directory to migrate (defaults to `/`) |
| `timestamp` | number | yes | Unix timestamp of the request |

Nextcloud credentials (URL, login, app password) are stored in the `io.cozy.accounts` document, not in the message. The service references the account by ID when calling the Stack's Nextcloud routes.

## Acknowledgment

Messages are ACKed **early** — after validation passes but before the migration starts. This avoids holding the message unacked for hours during a large migration.

After ACK, the tracking document in CouchDB is the sole source of truth for migration state.

## Retries and dead-lettering

| Behavior | Detail |
|---|---|
| Pre-ACK failures | Handler throws → library retries up to 3 times |
| Retry delay | 1 second between attempts |
| After 3 failures | Message is moved to the dead-letter queue |
| Post-ACK failures | Handled by the migration logic, recorded in the tracking document |

Pre-ACK failures include: Cloudery unreachable, tracking document not found, invalid message format. These are transient or configuration issues worth retrying.

Post-ACK failures (file transfer errors, Stack outages) don't involve RabbitMQ at all — the tracking document records what happened.

## Idempotency

Before starting, the service reads the tracking document:

| Tracking doc status | Action |
|---|---|
| `completed` | ACK and skip |
| `running` | ACK and skip |
| `pending` | Proceed normally |
| `failed` | Proceed (retry scenario) |

This prevents duplicate processing if the same message is delivered twice.

## Prefetch

Set to 10. Multiple migrations for different users can run concurrently. Each migration is independent — its own token, its own tracking document, its own Cozy instance.
