# Configuration

The service is configured entirely through environment variables. Copy `.env.example` to `.env` for local development.

## Required variables

### `RABBITMQ_URL`

AMQP connection string for RabbitMQ.

```
RABBITMQ_URL="amqp://user:pass@rabbitmq:5672"
```

### `CLOUDERY_URL`

Base URL of the Cloudery instance. The service calls this to obtain short-lived Stack tokens for each migration.

```
CLOUDERY_URL="https://manager.cozycloud.cc"
```

### `CLOUDERY_TOKEN`

API bearer token that authenticates this service with the Cloudery's public endpoint. This is a long-lived secret managed as an environment variable — it's not a user token.

```
CLOUDERY_TOKEN="your-cloudery-api-token"
```

## Optional variables

### `STACK_URL_SCHEME`

URL scheme the consumer uses to reach the Cozy Stack, either `https` or `http`. Defaults to `https`, which is what production always wants. Set to `http` only for local development against a non-TLS Stack (for example `http://cozy.localhost:8080`). Any other value fails fast at startup.

```
STACK_URL_SCHEME="https"
```

### `LOG_LEVEL`

Controls log verbosity. Defaults to `info`.

Accepted values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.

Set to `debug` during development to see HTTP-level detail. In production, `info` gives you per-file transfer events and migration lifecycle without noise.

```
LOG_LEVEL="info"
```

### `FLUSH_INTERVAL`

Number of files between progress flushes to the CouchDB tracking document. Defaults to `25`.

The unit is a **count of files**, not a duration — there is no time-based flush. A final flush always runs on completion or failure regardless of how many files have accumulated since the last one.

Why this knob exists: the service used to write to the tracking document after every single file. With many small files, that meant one CouchDB read-modify-write cycle per file, dominating migration time and piling pressure on a single document. Batching amortizes the cost — one write per 25 files instead of one per file — while the in-memory accumulator keeps `files_imported`, `bytes_imported`, `errors`, and `skipped` accurate between flushes.

Lower values give the Settings UI more frequent progress updates at the cost of more CouchDB writes. Higher values reduce write pressure but the UI sees larger jumps between updates. The default is a reasonable tradeoff for typical deployments; only tune it if profiling shows the tracking writes are a bottleneck (smaller files, faster storage → consider lowering) or if CouchDB is under unusual load (→ consider raising).

```
FLUSH_INTERVAL="50"
```

### `HTTP_PORT`

TCP port the ops HTTP server binds on. Defaults to `8080`. The server exposes `/healthz`, `/readyz`, and `/metrics` — see [Operations](operations.md#health-and-metrics) for what each returns.

```
HTTP_PORT="8080"
```

### `MAX_CONCURRENT_MIGRATIONS`

Hard cap on the number of migrations the consumer will run at the same time. Defaults to `10`, matching the RabbitMQ prefetch.

The prefetch only limits concurrent *handlers* — messages being validated. Once a handler has ACKed and fired the migration, the migration keeps running in the background. Without this cap, a burst of messages could spawn hundreds of concurrent migrations competing for the event loop and memory, with no backpressure.

When every slot is held, new handlers block waiting for one to free. That keeps the next messages unacked, which naturally makes RabbitMQ hold them back. Raise this if you have the infrastructure headroom to run more migrations in parallel; lower it when running alongside other tenants on a cramped node.

Shutdown waits up to 60 s for in-flight migrations to finish on SIGTERM/SIGINT. Anything left running when the deadline hits is reclaimed by the heartbeat recovery on the next consumer that picks the message up (see [Tracking document](tracking.md)).

```
MAX_CONCURRENT_MIGRATIONS="10"
```
