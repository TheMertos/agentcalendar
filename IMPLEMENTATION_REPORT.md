# AgentCalendar implementation report

## Implemented

- **Runtime config** (`src/config.mjs`) — fail-closed `AGENTCAL_*` and `SECRET_FABRIC_*` env validation.
- **Security** — `lease-broker.mjs` (verbatim from AgentMail), `secretfabric-resolver.mjs` (AgentMail copy plus `auth.username` / `auth.password` for CalDAV).
- **Approvals** — `approval.mjs` (verbatim), wired for `event_approval_create` / `event_write`.
- **SQLite store** — `active_accounts`, `calendars`, `events`, `sync_checkpoints`, **`sync_policies`**, **`dirty_events`**, **`sync_conflicts`**; idempotent event upsert by `(accountId, calendarId, uid)`.
- **Download sync** — full/incremental engine with per-calendar CTag skip; skips upsert when a pending/failed dirty row exists for the same event key.
- **Bidirectional upload path** — `event_update_local` / `local-event-service.mjs` mutates the mirror and enqueues durable dirty rows; **`autoUpload` per `(accountId, calendarId)` defaults false**; `upload-service.mjs` performs If-Match PUT, read-back UID/content checks, ETag conflict records, and bounded exponential backoff retries; `SyncWorker` runs upload phase only when the account has at least one calendar with `autoUpload=true`.
- **CalDAV** — `tsdav`-based `createCaldavProvider` with injectable `davFactory` for tests; `If-Match` on PUT when etag is known.
- **Calendar service** — lease-gated `listCalendars`, `syncAccount`, `writeEvent` (uses stored etag, updates mirror, clears dirty queue on success), `uploadDirtyEvents`.
- **MCP** — stdio server and `handlers.mjs` including **`sync_policy_get`**, **`sync_policy_set`**, **`event_update_local`**, **`event_upload_status`**, **`event_conflicts`**.
- **Docker** — multi-stage `Dockerfile`, `compose.yaml` with `network_mode: host` and required env `:?` guards.
- **Docs** — `README.md`, `LICENSE` (Apache-2.0).

## Not implemented / limitations

- **`event_delete`** — omitted (optional in spec).
- **`AGENTCAL_TRANSPORT=streamable-http`** — rejected at startup with explicit error (stdio only).
- **Live CalDAV** — no automated integration test against a real CalDAV server in CI. Upload/update URL semantics (`createCalendarObject` vs `updateCalendarObject`) are exercised via injected mocks only.
- **Per-event ETag incremental fetch** — incremental mode skips whole calendars when CTag is unchanged; changed calendars refetch all objects.
- **RRULE expansion** — raw RRULE string storage only, as specified.
- **Conflict resolution workflow** — conflicts are recorded and listed; no automatic merge or human-resolve tool beyond inspection.

## Tests

Last run: **40 tests, 40 passed, 0 failed** (`yarn lint && yarn test`).

| Area | Test file |
|------|-----------|
| Config | `test/config.test.mjs` |
| Lease broker | `test/lease-broker.test.mjs` |
| SecretFabric resolver | `test/secretfabric-resolver.test.mjs` |
| Approval | `test/approval.test.mjs` |
| Account safety | `test/account-registry.test.mjs` |
| Active accounts | `test/active-accounts.test.mjs` |
| Event store | `test/event-store.test.mjs` |
| Sync policy | `test/sync-policy.test.mjs` |
| Dirty queue / conflicts | `test/dirty-queue.test.mjs` |
| Local event update | `test/local-event-update.test.mjs` |
| Upload service | `test/upload-service.test.mjs` |
| Sync engine | `test/incremental-sync.test.mjs` |
| Sync worker | `test/sync-worker.test.mjs`, `test/sync-worker-upload.test.mjs` |
| iCal | `test/ical.test.mjs` |
| Write service | `test/write-service.test.mjs` |
| Calendar service | `test/calendar-service.test.mjs` |
| CalDAV provider | `test/caldav-provider.test.mjs` |
| MCP handlers | `test/mcp-tools.test.mjs`, `test/mcp-sync-tools.test.mjs` |

## Verification commands

```bash
cd /home/mert/agentcalendar
yarn lint && yarn test

export SECRET_FABRIC_URL=http://127.0.0.1:3000
export SECRET_FABRIC_API_TOKEN=your-token
docker compose config --quiet
docker compose build
docker compose up -d
docker ps --filter name=agentcalendar
```

Hermes MCP add (example):

```bash
hermes mcp add agentcalendar -- docker compose -f /home/mert/agentcalendar/compose.yaml run --rm -T agentcalendar
```

## SecretFabric integration

Lease requests use purpose **`caldav-sync`** with field paths:

`identity.email`, `server.baseUrl`, `server.calendarPath`, `auth.username`, `auth.password`

Non-sensitive `baseUrl` / `calendarPath` may also be stored in SQLite `connection` at register time; auth material only via lease.
