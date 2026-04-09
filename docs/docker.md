# Docker

## Building locally

```bash
docker build -t twake-migration-nextcloud .
```

The Dockerfile uses a multi-stage build: the first stage compiles TypeScript, the second stage copies only the compiled JS and production dependencies. Final image is ~60MB on Alpine.

## Running

```bash
docker run --env-file .env twake-migration-nextcloud
```

Or pass variables individually:

```bash
docker run \
  -e RABBITMQ_URL="amqp://user:pass@rabbitmq:5672" \
  -e CLOUDERY_URL="https://manager.cozycloud.cc" \
  -e CLOUDERY_TOKEN="your-token" \
  twake-migration-nextcloud
```

## Published images

Images are published to the GitHub Container Registry at:

```
ghcr.io/linagora/twake-migration-nextcloud
```

### Tags

| Tag | When | Use case |
|---|---|---|
| `latest` | Every push to `main` | Development, staging |
| `v1.2.3` | On semver tag push (`v*.*.*`) | Production releases |

### Pulling

```bash
docker pull ghcr.io/linagora/twake-migration-nextcloud:latest
docker pull ghcr.io/linagora/twake-migration-nextcloud:v1.0.0
```

## CI pipeline

The Docker build and publish is handled by GitHub Actions:

- **Push to `main`** — runs tests, then publishes `latest`
- **Semver tag** (e.g. `v1.0.0`) — runs tests, publishes the versioned tag, creates a GitHub release

See `.github/workflows/` for the workflow definitions.
