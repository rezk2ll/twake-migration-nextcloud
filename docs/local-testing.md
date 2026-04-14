# Local end-to-end testing

A step-by-step recipe for running the full migration flow on a single machine against a real Nextcloud, before the Cloudery is wired up. The [unit tests](development.md#testing) mock every network call; this guide is for the higher-confidence check that the service actually boots, consumes RabbitMQ messages, asks a Cloudery for a token, and drives the Stack through a real transfer. Environment variables referenced below are described in [Configuration](configuration.md).

## What you need

- A Nextcloud account with an app password (Settings > Security > App passwords in Nextcloud)
- A `cozy-stack` checkout that builds (Go toolchain installed)
- CouchDB 3.x running locally on `:5984`
- RabbitMQ running locally on `:5672` with the management UI on `:15672`
- Node.js 20+

## 1. Point the Stack at RabbitMQ

The Stack has to declare the `migration` exchange the consumer subscribes to. In `$HOME/.cozy/cozy.yml` (create it if it does not exist), add:

```yaml
rabbitmq:
  enabled: true
  nodes:
    default:
      enabled: true
      url: amqp://admin:admin@localhost:5672/
  exchanges:
    - name: migration
      kind: topic
      durable: true
      declare_exchange: true
```

Both `rabbitmq.enabled` *and* `nodes.default.enabled` must be true. The per-node flag is silent and defaults to false, which leaves the Stack logging `No RabbitMQ manager for context default` at startup and quietly falling back to the noop service, which rejects every publish with a 503.

## 2. Start the Stack and create an instance

In the cozy-stack checkout:

```bash
make run
```

Watch for `Starting RabbitMQ manager for context default` in the logs. If you see `No RabbitMQ managers to start` or a connection error, the config above was not picked up.

In another shell:

```bash
cozy-stack instances add cozy.localhost:8080 \
  --passphrase cozy \
  --apps home,settings \
  --email you@example.org \
  --locale en \
  --public-name You \
  --context-name dev
```

Confirm the exchange is now declared:

```bash
curl -s -u admin:admin http://localhost:15672/api/exchanges/%2f \
  | python3 -c "import sys,json; print([e['name'] for e in json.load(sys.stdin) if e['name']=='migration'])"
```

You should see `['migration']`.

## 3. Mock the Cloudery

The consumer fetches its Stack token from the Cloudery, which is not available locally. A tiny Node HTTP server that returns a pre-minted Stack token on every call is enough. Unlike the real Cloudery, this mock ignores the request body (the consumer still sends the expected `audience` and `scope` fields; the real endpoint validates them). Save this somewhere outside the repo, for example `/tmp/cloudery-mock.js`:

```js
const http = require('http')

const TOKEN = process.env.STACK_TOKEN
const PORT = parseInt(process.env.MOCK_PORT || '3001', 10)

if (!TOKEN) {
  console.error('STACK_TOKEN env var is required')
  process.exit(1)
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const match = req.url.match(/^\/api\/public\/instances\/([^/]+)\/token$/)
    if (req.method === 'POST' && match) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ token: TOKEN }))
      return
    }
    res.writeHead(404)
    res.end('not found\n')
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cloudery mock on http://127.0.0.1:${PORT}`)
})
```

Mint a long-lived CLI token that covers every doctype the consumer touches. The same token is used for the trigger curl in step 5, so keep it in a variable or a file:

```bash
export STACK_TOKEN=$(cozy-stack instances token-cli cozy.localhost:8080 \
  io.cozy.nextcloud.migrations \
  io.cozy.remote.nextcloud.files \
  io.cozy.files \
  io.cozy.settings)
```

Start the mock in a new shell, passing the token through:

```bash
STACK_TOKEN="$STACK_TOKEN" node /tmp/cloudery-mock.js
```

## 4. Build and run the consumer

In this repo:

```bash
npm install
npm run build
```

Then start the service with the env it needs. `STACK_URL_SCHEME=http` is what makes the consumer talk to a local HTTP Stack instead of the production `https://` default:

```bash
RABBITMQ_URL="amqp://admin:admin@localhost:5672" \
CLOUDERY_URL="http://127.0.0.1:3001" \
CLOUDERY_TOKEN="mock-secret-not-checked" \
STACK_URL_SCHEME="http" \
LOG_LEVEL="debug" \
node dist/index.js
```

The consumer does not auto-load `.env`. Either pass the variables inline (as above) or `source` your own env file before launching.

When it is up you should see:

```json
{"event":"rabbitmq.subscribed","exchange":"migration","queue":"migration.nextcloud.commands","routing_key":"nextcloud.migration.requested"}
```

## 5. Trigger a migration

POST to the Stack using the same `STACK_TOKEN` from step 3. Its scope is a superset of what the trigger endpoint needs. Replace the URL, login, and password with your real Nextcloud credentials:

```bash
MIGRATION_ID=$(curl -s -X POST http://cozy.localhost:8080/remote/nextcloud/migration \
  -H "Authorization: Bearer $STACK_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/vnd.api+json" \
  -d '{
    "nextcloud_url": "https://your-nextcloud.example/",
    "nextcloud_login": "you@example.org",
    "nextcloud_app_password": "xxxxx-xxxxx-xxxxx-xxxxx-xxxxx",
    "source_path": "/"
  }' | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")

echo "migration: $MIGRATION_ID"
```

On success the Stack returns `201 Created` with the tracking document id (captured above). The consumer receives the RabbitMQ message within a second, calls the mock to get a Stack token, and starts walking the Nextcloud tree.

## 6. Verify

Watch the consumer logs for `migration.started`, one `migration.file_transferred` per file, and a final `migration.completed`. The tracking document can also be read straight from CouchDB, using the `$MIGRATION_ID` captured in step 5. Replace `admin:password` with whatever admin credentials your local CouchDB was installed with; they are independent from the RabbitMQ ones:

```bash
PFX=$(cozy-stack instances show cozy.localhost:8080 \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['attributes']['prefix'])")

curl -s -u admin:password \
  "http://localhost:5984/${PFX}%2Fio-cozy-nextcloud-migrations/${MIGRATION_ID}" \
  | python3 -m json.tool
```

Migrated files land under `/Nextcloud/...` in the target Cozy. You can also browse them from the Drive app at `http://cozy.localhost:8080/`.

## Known gotchas

- **Stack CLI tokens are tied to the instance.** If you destroy and recreate `cozy.localhost:8080`, re-mint `STACK_TOKEN` and restart the mock; the previous token will be rejected by the new instance.
- **The Stack probe failure message is generic.** If the Stack returns `401 nextcloud credentials are invalid` but you know the password is right, the Nextcloud OCS probe endpoint likely returned a non-200 for reasons other than auth. Recent stacks probe OCS Core (`/ocs/v2.php/cloud/user`), which cannot be disabled.
- **Conflict handling is name-only.** If the target Cozy directory already contains a file with the same name as a Nextcloud file, the migration silently keeps the Cozy version, even when the bytes differ. To retry a clean migration, destroy the instance or delete the `/Nextcloud` tree in Drive before firing the next request.
- **Stuck tracking documents.** Only one `pending` or `running` migration is allowed per instance. If the consumer crashes mid-run, mark the stuck doc as `failed` in CouchDB (edit the `status` field) before triggering again, otherwise you will get a `409 Conflict`.
- **RabbitMQ publish failure.** If the Stack config is wrong and the consumer is not running but the exchange is not declared either, the trigger endpoint returns `503` and marks the tracking document as `failed`. Check the Stack logs for the full cause.
