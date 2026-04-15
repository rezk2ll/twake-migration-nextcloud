# Development

## Prerequisites

- Node.js 20+
- npm

## Setup

```bash
npm install
cp .env.example .env
# Fill in .env with your values
```

## Commands

| Command | What it does |
|---|---|
| `npm test` | Run the test suite (vitest) |
| `npm run lint` | Type-check with `tsc --noEmit` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled service (`dist/index.js`) |
| `npm run dev` | Watch mode for TypeScript compilation |

## Project structure

The `src/` tree is grouped by role so each folder has a single reason to exist.

```
src/
  index.ts                  Entry point — connects RabbitMQ, subscribes, handles shutdown

  clients/                  External integrations. Everything that talks to something outside the process.
    stack-client.ts         Cozy Stack API (token refresh on 401)
    cloudery-client.ts      Cloudery token endpoint
    cozy-stack-client.d.ts  Type shim for the cozy-stack-client library

  domain/                   What a migration is. No HTTP, no config, no process plumbing.
    migration.ts            Core logic — lazy directory traversal, file transfers, progress tracking
    tracking.ts             Tracking document helpers with CouchDB 409 conflict retry
    doctypes.ts             Cozy doctype identifiers used across the codebase
    types.ts                Migration command + tracking document schema

  runtime/                  Process wiring. How domain + clients get started and fed.
    consumer.ts             Message handler — validation, idempotency, quota check, early ACK
    config.ts               Environment variable parsing + Config type

test/
  *.test.ts                 Unit tests for each module (mocked HTTP, no real services needed)
```

## Testing

Tests use vitest with mocked `fetch` — no RabbitMQ or Stack instance required. Each module is tested independently through its public interface.

```bash
npm test              # single run
npm run test:watch    # watch mode
```

## How the pieces fit together

1. `index.ts` initializes the RabbitMQ client and subscribes to the migration queue
2. Each message goes through `consumer.ts` which validates and ACKs early
3. `migration.ts` runs in the background, calling `stack-client.ts` methods to list/transfer files
4. `tracking.ts` keeps the CouchDB tracking document in sync with progress
5. `cloudery-client.ts` provides tokens, refreshed automatically on 401
