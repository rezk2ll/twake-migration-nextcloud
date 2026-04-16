# Tracking Document

Doctype: `io.cozy.nextcloud.migrations`

The tracking document lives in the user's CouchDB database. It's created by the Cozy Stack when the user starts a migration, and updated by this service as files are transferred.

The Settings UI watches this document via realtime events to show live progress.

## Schema

```json
{
  "_id": "d4e5f6a7-b8c9-4d0e-a1b2-c3d4e5f6a7b8",
  "_rev": "5-abc123",
  "schema_version": 1,
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
  "errors_truncated_count": 0,
  "skipped": [
    {
      "path": "/Photos/vacation.jpg",
      "reason": "already exists",
      "size": 4194304
    }
  ],
  "skipped_truncated_count": 0,
  "started_at": "2026-04-08T10:00:00Z",
  "last_heartbeat_at": "2026-04-08T10:32:20Z",
  "finished_at": null,
  "failure_reason": null
}
```

## Fields

| Field | Type | Description |
|---|---|---|
| `schema_version` | number | Stamped by the service on every write. Bumped when the shape changes incompatibly — consumers can key off this instead of sniffing for optional fields. |
| `status` | string | `pending`, `running`, `completed`, or `failed` |
| `target_dir` | string | Cozy directory where files land (default: `/Nextcloud`) |
| `progress.files_imported` | number | Files successfully transferred so far |
| `progress.files_total` | number | Total files discovered so far. Advances monotonically — a resumed walk never regresses the value below what's already on the doc. |
| `progress.bytes_imported` | number | Bytes transferred so far |
| `progress.bytes_total` | number | Total bytes of the source path, seeded once at start from Nextcloud's recursive `oc:size` so the UI has a stable denominator. |
| `errors` | array | Files that failed, with message and timestamp. Capped at 1000 entries; oldest get dropped first. |
| `errors_truncated_count` | number | How many entries were dropped to stay within the cap. Shown as "plus N more" in the UI. |
| `skipped` | array | Files intentionally skipped (already exist, etc.), with reason and size. Also capped at 1000. |
| `skipped_truncated_count` | number | How many skipped entries were dropped. |
| `started_at` | string or null | ISO 8601 timestamp when the service started processing. Preserved across resumes — a stale-running migration that gets picked up keeps its original start time. |
| `last_heartbeat_at` | string or null | ISO 8601 timestamp of the last progress write. Used to distinguish an actively-running migration from a zombie a crashed consumer left behind. |
| `finished_at` | string or null | ISO 8601 timestamp when the migration reached `completed` or `failed`. |
| `failure_reason` | string or null | Human-readable reason a migration ended in `failed`. Dual-written for now alongside a legacy `{ path: "", message, at }` sentinel inside `errors`; new consumers should prefer this field. |

## Status transitions

```
pending ──▶ running ──▶ completed
                   └──▶ failed

pending ──▶ failed       (validation fails before the migration starts)
failed  ──▶ running      (user retries a failed migration)
running ──▶ running      (consumer picks up a stale running doc — see below)
```

`completed` is terminal — nothing flips it back. `failed` allows a retry, which transitions through `running` again on the next pass.

The service rejects illegal transitions at the write layer, so a late writer (e.g. a stale consumer that eventually finishes its run) cannot demote a newer result.

## Heartbeat and stale-running recovery

A `running` doc whose `last_heartbeat_at` is older than 30 minutes is treated as a zombie left behind by a crashed consumer. The next consumer that receives the same message picks it up and resumes: the pre-existing files in Cozy return 409 on re-transfer and are silently skipped, so resume is cheap and idempotent.

Legacy docs without a heartbeat fall back to `started_at` for the staleness check; without either, the doc is treated as stale.

The 30-minute window is comfortably larger than the longest legitimate gap between progress writes — a single file transfer is capped at 15 minutes.

## Concurrency and conflicts

The service updates the document on every progress flush. CouchDB may return 409 on stale `_rev` — the service handles this with a read-then-write retry loop (up to 5 attempts per update).

`bytes_total` is written exactly once at start by the pre-flight `oc:size` probe, and is never rewritten afterwards — that's what gives the UI a stable denominator even while `bytes_imported` climbs.

## Resumability

Resume is implicit. If a migration crashes or is killed mid-run, the same RabbitMQ message eventually redelivers (or, if already ACKed, the heartbeat logic reclaims the doc). Files already in Cozy produce a 409 from the Stack and land in `skipped` rather than causing a re-upload.
