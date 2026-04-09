# Nextcloud Migration Service

Migrates a user's entire Nextcloud file tree into their Cozy instance. Runs as a standalone RabbitMQ consumer — no web server, no database.

## How it works

When a user triggers a migration from the Settings UI, the Cozy Stack creates a tracking document and publishes a message to RabbitMQ. This service picks it up and:

1. Gets a short-lived token from the Cloudery
2. Checks idempotency (skip if already running or completed)
3. Validates there's enough disk quota on the Cozy side
4. ACKs the message early (the tracking document takes over as source of truth)
5. Walks the Nextcloud tree directory by directory, transferring each file through the Stack's proxy routes
6. Updates the tracking document after each file so the user sees live progress

The service never talks to Nextcloud directly. All file operations go through the Cozy Stack, which handles WebDAV internally.

### Error handling

- A single file failure doesn't abort the migration — the error is recorded in the tracking document and the service moves on.
- If a file already exists in Cozy (409), it's skipped. This makes migrations resumable after a crash.
- Token expiration mid-migration triggers an automatic refresh from the Cloudery.
- If the Stack becomes unreachable, the migration is marked as failed.

## Configuration

Copy `.env.example` to `.env` and fill in the values. See [docs/configuration.md](docs/configuration.md) for details.

## Documentation

- [Configuration](docs/configuration.md) — environment variables and setup
- [Development](docs/development.md) — local dev, testing, project structure
- [Docker](docs/docker.md) — building, running, and CI image publishing
- [RabbitMQ contract](docs/rabbitmq.md) — exchange, queue, message format
- [Tracking document](docs/tracking.md) — CouchDB schema, status transitions, fields
