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
