# AgentCalendar implementation report

## Implemented

- **Runtime config** (`src/config.mjs`) — fail-closed `AGENTCAL_*` and `SECRET_FABRIC_*` env validation. `AGENTCAL_SYNC_INTERVAL_SECONDS` must be an integer ≥ 30 at startup and does not schedule sync.
- **Security** — `lease-broker.mjs` (verbatim from AgentMail), `secretfabric-resolver.mjs` (AgentMail copy plus `auth.username` / `auth.password` for CalDAV).
- **Approvals** — `approval.mjs` (verbatim), wired for `event_preview` → `event_approval_create` → `event_write`.
- **SQLite store** — interactive use persists account metadata and opaque SecretFabric refs. Legacy event, checkpoint, policy, and dirty-queue tables remain in the schema and are not the source for interactive reads or writes.
- **Remote-only calendar service** — `listCalendars`, `searchEvents`, and `readEvent` use a `caldav-sync` lease and the live provider. Provider errors propagate and are not filled from SQLite. `syncAccount` and `uploadDirtyEvents` throw `remote_only_sync_disabled`.
- **Approved writes** — `event_write` loads the live ETag, sends `If-Match`, then read-back checks UID, summary, and ETag. `412` becomes `precondition_failed`. The verified event is not stored locally.
- **Process split** — `src/runtime/calendar-runtime.mjs` wires store, active accounts, SecretFabric leases, and `CalendarService` and does not start sync. The MCP server is only the tool surface. `calendar_sync` / `calendar_sync_all` report `mode: remote-only` and `syncEnabled: false`. There is no background worker and no IMAP IDLE equivalent.
- **Disabled worker** — `src/worker/calendar-runtime-worker.mjs` throws `remote_only_sync_disabled` and does not open SQLite, SecretFabric, or CalDAV. `yarn start:worker` prints that code and exits 1. It is not part of normal operation.
- **CalDAV** — `tsdav`-based `createCaldavProvider` with injectable `davFactory` for tests; `If-Match` on PUT when etag is known.
- **MCP** — stdio server and `handlers.mjs`. `event_update_local` returns `remote_only_local_writes_disabled`. `event_upload_status` and `event_conflicts` return `remote_only_sync_disabled`.
- **Docker** — multi-stage `Dockerfile` (MCP entrypoint `node src/mcp/server.mjs`). `compose.yaml` has only the `agentcalendar` service, `network_mode: host`, named volume `agentcalendar-data`, and required env `:?` guards. No worker service.
- **Docs** — `README.md`, `SPEC.md`, `LICENSE` (Apache-2.0).

## Not implemented / limitations

- **`event_delete`** — omitted (optional in spec).
- **`AGENTCAL_TRANSPORT=streamable-http`** — rejected at startup with explicit error (stdio only).
- **Live CalDAV** — no automated integration test against a real CalDAV server in CI. Upload/update URL semantics are exercised via injected mocks only.
- **Background sync, sync interval, and push/IDLE** — not part of interactive operation. Older sync/upload modules remain in the tree and are not started by the MCP server or Compose.
- **RRULE expansion** — raw RRULE string on the remote iCal body only.

## Tests

Last run: **52 tests, 52 passed, 0 failed** (`yarn lint`, then `node --test --test-concurrency=1 test/**/*.test.mjs`). `git diff --check` was clean. `docker compose config` with dummy SecretFabric env showed only the `agentcalendar` service. `docker compose build` succeeded.

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
| Sync worker | `test/sync-worker.test.mjs`, `test/sync-worker-upload.test.mjs`, `test/calendar-runtime-lifecycle.test.mjs` |
| Remote-only interactive | `test/remote-only-interactive.test.mjs` |
| iCal | `test/ical.test.mjs` |
| Write service | `test/write-service.test.mjs` |
| Calendar service | `test/calendar-service.test.mjs` |
| CalDAV provider | `test/caldav-provider.test.mjs` |
| MCP handlers | `test/mcp-tools.test.mjs`, `test/mcp-sync-tools.test.mjs` |

## Verification commands

```bash
cd /home/mert/agentcalendar
yarn lint
node --test --test-concurrency=1 test/**/*.test.mjs
git diff --check

export SECRET_FABRIC_URL=http://127.0.0.1:3000
export SECRET_FABRIC_API_TOKEN=dummy
docker compose config
docker compose build
```

Hermes MCP add (example):

```bash
hermes mcp add agentcalendar -- docker compose -f /home/mert/agentcalendar/compose.yaml run --rm -T agentcalendar
```

Normal operation is `yarn start` or the Compose MCP service. Do not start a background sync worker.

## SecretFabric integration

Lease requests use purpose **`caldav-sync`** with field paths:

`identity.email`, `server.baseUrl`, `server.calendarPath`, `auth.username`, `auth.password`

Non-sensitive `baseUrl` / `calendarPath` may also be stored in SQLite `connection` at register time; auth material only via lease.
