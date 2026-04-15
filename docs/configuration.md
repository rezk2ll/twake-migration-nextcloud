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

Number of files between progress flushes to the CouchDB tracking document. Defaults to `50`.

The unit is a **count of files**, not a duration — there is no time-based flush. A final flush always runs on completion or failure regardless of how many files have accumulated since the last one.

Why this knob exists: the service used to write to the tracking document after every single file. With many small files, that meant one CouchDB read-modify-write cycle per file, dominating migration time and piling pressure on a single document. Batching amortizes the cost — one write per 50 files instead of one per file — while the in-memory accumulator keeps `files_imported`, `bytes_imported`, `errors`, and `skipped` accurate between flushes.

Lower values give the Settings UI more frequent progress updates at the cost of more CouchDB writes. Higher values reduce write pressure but the UI sees larger jumps between updates. The default is a reasonable tradeoff for typical deployments; only tune it if profiling shows the tracking writes are a bottleneck (smaller files, faster storage → consider lowering) or if CouchDB is under unusual load (→ consider raising).

```
FLUSH_INTERVAL="50"
```
