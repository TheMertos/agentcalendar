# AgentCalendar implementation report

## Implemented

- **Runtime config** (`src/config.mjs`) — fail-closed `AGENTCAL_*` and `SECRET_FABRIC_*` env validation.
- **Security** — `lease-broker.mjs` (verbatim from AgentMail), `secretfabric-resolver.mjs` (AgentMail copy plus `auth.username` / `auth.password` for CalDAV).
- **Approvals** — `approval.mjs` (verbatim), wired for `event_approval_create` / `event_write`.
- **SQLite store** — `active_accounts`, `calendars`, `events`, `sync_checkpoints`; idempotent event upsert by `(accountId, calendarId, uid)`.
- **Sync** — full/incremental engine with per-calendar CTag skip; background `SyncWorker` with per-account locking.
- **CalDAV** — `tsdav`-based `createCaldavProvider` with injectable `davFactory` for tests.
- **Calendar service** — lease-gated `listCalendars`, `syncAccount`, `writeEvent` with read-back verification.
- **MCP** — stdio server and extractable `handlers.mjs` for tool wiring tests.
- **Docker** — multi-stage `Dockerfile`, `compose.yaml` with `network_mode: host` and required env `:?` guards.
- **Docs** — `README.md`, `LICENSE` (Apache-2.0).

## Not implemented / limitations

- **`event_delete`** — omitted (optional in spec).
- **`AGENTCAL_TRANSPORT=streamable-http`** — rejected at startup with explicit error (stdio only).
- **Live CalDAV** — no automated integration test against a real CalDAV server in CI. `tsdav` mapping (`syncToken`/`ctag`, `createCalendarObject`, object URLs) is exercised via injected mocks only. Manual verification against iCloud/Nextcloud/mailbox.org may surface URL/etag edge cases.
- **Per-event ETag incremental fetch** — incremental mode skips whole calendars when CTag is unchanged; changed calendars refetch all objects (no per-event ETag diff in this pass).
- **RRULE expansion** — raw RRULE string storage only, as specified.

## Tests

Last run: **25 tests, 25 passed, 0 failed** (`yarn test`).

| Area | Test file |
|------|-----------|
| Config | `test/config.test.mjs` |
| Lease broker | `test/lease-broker.test.mjs` |
| SecretFabric resolver | `test/secretfabric-resolver.test.mjs` |
| Approval | `test/approval.test.mjs` |
| Account safety | `test/account-registry.test.mjs` |
| Active accounts | `test/active-accounts.test.mjs` |
| Event store | `test/event-store.test.mjs` |
| Sync engine | `test/incremental-sync.test.mjs` |
| Sync worker | `test/sync-worker.test.mjs` |
| iCal | `test/ical.test.mjs` |
| Write service | `test/write-service.test.mjs` |
| Calendar service | `test/calendar-service.test.mjs` |
| CalDAV provider | `test/caldav-provider.test.mjs` |
| MCP handlers | `test/mcp-tools.test.mjs` |

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
