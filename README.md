# AgentCalendar

Headless MCP CalDAV calendar server for AI agents. Sibling to [AgentMail](https://github.com/TheMertos/agentmail): same credential boundary, same stdio-only architecture, no web UI.

## What it does

- Reads, searches, and writes CalDAV events directly on the remote server.
- Interactive tools do not read or write a local event mirror. SQLite stores account metadata and an opaque SecretFabric `secretRef` only for the allowlist.
- There is no background sync worker, no sync interval, and no IMAP IDLE equivalent. Nothing polls or holds a long-lived remote watch.
- Resolves CalDAV credentials only through SecretFabric short-lived leases (`caldav-sync` purpose).
- Gates every real write behind `event_preview` → `event_approval_create` → `event_write`. The approval is payload-bound and lasts five minutes.
- On update, `event_write` loads the live ETag, sends it as `If-Match`, then reads the event back and checks UID, summary, and ETag.

## Safety model

- **No secrets in MCP tools** — account passwords never appear in tool arguments or JSON results.
- **Active-account allowlist** — only accounts registered via `calendar_account_register` (with an opaque `secretRef`) can be listed, read, or written.
- **Human in the loop** — creating or updating calendar events requires an explicit approval matching the exact iCal body.
- **Remote failure** — if CalDAV or the credential lease fails, `calendar_list`, `event_search`, `event_read`, and `event_write` return that error. They do not fill the result from SQLite. A missing remote event is `event_not_found`. An `If-Match` rejection is `precondition_failed`. A read-back that does not match the written UID, summary, or ETag fails the write.

## Runtime configuration (required)

| Variable | Purpose |
|----------|---------|
| `AGENTCAL_DB_PATH` | SQLite path for account metadata and opaque SecretFabric refs |
| `AGENTCAL_SYNC_INTERVAL_SECONDS` | Required integer ≥ 30 at startup. It does not schedule sync |
| `AGENTCAL_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `AGENTCAL_TRANSPORT` | `stdio` (only mode implemented in v0.1) |
| `SECRET_FABRIC_URL` | SecretFabric base URL |
| `SECRET_FABRIC_API_TOKEN` | Bearer token for `/api/resolve` |

## Local development

```bash
export AGENTCAL_DB_PATH=/tmp/agentcalendar.db
export AGENTCAL_SYNC_INTERVAL_SECONDS=300
export AGENTCAL_LOG_LEVEL=info
export AGENTCAL_TRANSPORT=stdio
export SECRET_FABRIC_URL=http://127.0.0.1:3000
export SECRET_FABRIC_API_TOKEN=your-token

yarn install
yarn check
yarn start
```

`yarn start` is the MCP stdio server. It does not start a sync loop.

## Docker

```bash
export SECRET_FABRIC_URL=http://127.0.0.1:3000
export SECRET_FABRIC_API_TOKEN=your-token
docker compose build
docker compose up -d
```

`docker compose up` starts only the MCP server and keeps the named `agentcalendar-data` volume. Compose has no worker service. The image entrypoint is `node src/mcp/server.mjs`, so `docker compose run --rm -T agentcalendar` is the stdio MCP process. `AGENTCAL_SYNC_INTERVAL_SECONDS` is set in Compose only so startup validation succeeds.

`network_mode: host` lets the container reach SecretFabric on the host loopback.

## Hermes MCP example

```bash
hermes mcp add agentcalendar -- docker compose -f /path/to/agentcalendar/compose.yaml run --rm -T agentcalendar
```

(Adjust paths and ensure `SECRET_FABRIC_*` are set in the environment passed to Compose.)

## MCP tools (summary)

- Accounts: `calendar_account_list`, `calendar_account_status`, `calendar_account_register`, `calendar_account_deactivate` — metadata and opaque refs, never credentials
- Calendars: `calendar_list` — live CalDAV list
- Sync status is inert: `calendar_sync` and `calendar_sync_all` report `mode: remote-only`, `syncEnabled: false`, and do not contact CalDAV
- Read: `event_search` and `event_read` query CalDAV directly
- Write (approval-gated): `event_preview` → `event_approval_create` → `event_write`
- Disabled local/queue tools return an error and do not mutate a mirror: `event_update_local` (`remote_only_local_writes_disabled`), `event_upload_status` and `event_conflicts` (`remote_only_sync_disabled`)

## License

Apache-2.0
