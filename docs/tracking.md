# Tracking Document

Doctype: `io.cozy.nextcloud.migrations`

The tracking document lives in the user's CouchDB database. It's created by the Cozy Stack when the user starts a migration, and updated by this service as files are transferred.

The Settings UI watches this document via realtime events to show live progress.

## Schema

```json
{
  "_id": "d4e5f6a7-b8c9-4d0e-a1b2-c3d4e5f6a7b8",
  "_rev": "5-abc123",
  "status": "running",
  "target_dir": "/Nextcloud",
  "progress": {
    "files_imported": 142,
    "files_total": 1500,
    "bytes_imported": 1073741824,
    "bytes_total": 5368709120
  },
  "errors": [
    {
      "path": "/Documents/report.pdf",
      "message": "upload failed: 413 Request Entity Too Large",
      "at": "2026-04-08T10:32:15Z"
    }
  ],
  "skipped": [
    {
      "path": "/Photos/vacation.jpg",
      "reason": "already exists",
      "size": 4194304
    }
  ],
  "started_at": "2026-04-08T10:00:00Z",
  "finished_at": null
}
```

## Fields

| Field | Type | Description |
|---|---|---|
| `status` | string | `pending`, `running`, `completed`, or `failed` |
| `target_dir` | string | Cozy directory where files land (default: `/Nextcloud`) |
| `progress.files_imported` | number | Files successfully transferred so far |
| `progress.files_total` | number | Total files discovered (refined as directories are traversed) |
| `progress.bytes_imported` | number | Bytes transferred so far |
| `progress.bytes_total` | number | Total bytes discovered (starts at 0, refined after full traversal) |
| `errors` | array | Files that failed, with the error message and timestamp |
| `skipped` | array | Files intentionally skipped (already exist, etc.), with reason and size |
| `started_at` | string or null | ISO 8601 timestamp when the service started processing |
| `finished_at` | string or null | ISO 8601 timestamp when the migration completed or failed |

## Status transitions

```
pending ──▶ running ──▶ completed
                   └──▶ failed

pending ──▶ failed  (validation failure before migration starts)
```

A `failed` migration does not go back to `running`. The user retries from the Settings UI, which creates a new tracking document and a new RabbitMQ message.

## Concurrency and conflicts

The service updates the document after each file transfer. For small files uploaded in rapid succession, CouchDB may return 409 conflicts (stale `_rev`). The service handles this with a read-then-write retry loop (up to 5 attempts per update).

## Progress tracking

`bytes_total` and `files_total` start at 0 and are refined as the service walks the Nextcloud directory tree. Once traversal is complete, they reflect the actual totals. The UI can use `bytes_imported / bytes_total` as a progress percentage once `bytes_total` is non-zero.

## Resumability

If a migration fails or the service crashes, the user can retry. Files already present in Cozy produce a 409 from the Stack, which the service treats as "skip". The `skipped` array records what was skipped and why, so the tracking document stays accurate.
