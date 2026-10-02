# AgentCalendar

Headless MCP CalDAV calendar server for AI agents. Sibling to [AgentMail](https://github.com/TheMertos/agentmail): same credential boundary, same stdio-only architecture, no web UI.

## What it does

- Reads, searches, and writes CalDAV events directly on the remote server.
- Interactive tools do not read or write a local event mirror. SQLite stores account metadata and an opaque SecretFabric `secretRef` only for the allowlist.
- There is no background sync worker, no sync interval, and no IMAP IDLE equivalent. Nothing polls or holds a long-lived remote watch.
- Reconciles CalDAV credentials from SecretFabric into the service-owned encrypted cache (`caldav-sync` purpose), then decrypts only inside the service. `CREDENTIAL_CACHE_KEY` is required. There is no direct resolver fallback.
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
| `CREDENTIAL_CACHE_KEY` | Required external 64-character hexadecimal secret for the service-owned encrypted credential cache. Not stored in SQLite, MCP inputs or results, logs, or source |
| `AGENTCAL_PRINCIPAL` | Trusted principal. Must match `SECRET_FABRIC_PRINCIPAL` |
| `SECRET_FABRIC_PRINCIPAL` | Sent as `x-hermes-principal`. Never taken from tool arguments |
| `AGENTCAL_SERVICE_MODE` | `native`. This is the only supported mode |
| `AGENTCAL_PROFILE` | Required. Must match the principal |

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

## Native host service

The supported process is Node on the host, started by `tools/hermes-agentcalendar-mcp.sh` or the systemd user template `deploy/systemd/user/agentcalendar@.service`. Both set `AGENTCAL_SERVICE_MODE=native` and the profile principal. They do not start a sync worker. Install steps are in [`docs/COMPOSE-TRANSITION.md`](docs/COMPOSE-TRANSITION.md). This repository does not ship a container image or Compose file.

```bash
export SECRET_FABRIC_URL=http://127.0.0.1:3000
export SECRET_FABRIC_API_TOKEN=your-token
export HERMES_HOME="$HOME/.hermes"
tools/hermes-agentcalendar-mcp.sh
```

## Hermes MCP example

```bash
hermes mcp add agentcalendar -- /path/to/agentcalendar/tools/hermes-agentcalendar-mcp.sh
```

Register the native wrapper. It sets `AGENTCAL_PRINCIPAL` and `SECRET_FABRIC_PRINCIPAL` from `HERMES_HOME`. Empty `SECRET_FABRIC_URL` and `SECRET_FABRIC_API_TOKEN` values are loaded from `~/.config/agentcalendar/<profile>.env`. Values already present in the environment are kept. The wrapper exits if either value is still missing and does not print secrets. `CREDENTIAL_CACHE_KEY` is a required external secret. The wrapper does not load it from the profile env file, so the MCP process environment must already contain it. The systemd user unit loads the whole env file.

## MCP tools (summary)

- Accounts: `calendar_account_list`, `calendar_account_status`, `calendar_account_register`, `calendar_account_deactivate` — metadata and opaque refs, never credentials
- Calendars: `calendar_list` — live CalDAV list
- Sync status is inert: `calendar_sync` and `calendar_sync_all` report `mode: remote-only`, `syncEnabled: false`, and do not contact CalDAV
- Read: `event_search` and `event_read` query CalDAV directly. `event_search` reads one calendar, inside a time window (30 days before and after now when dates are omitted). The page size is 50 by default and 200 at most, ordered by date descending or ascending. A `nextCursor` is returned only when the CalDAV client honors a bounded calendar-query. If the window is larger than the page and the server cannot limit the REPORT, the tool returns `pagination_unavailable` and does not download every event body.
- Write (approval-gated): `event_preview` → `event_approval_create` → `event_write`
- Disabled local/queue tools return an error and do not mutate a mirror: `event_update_local` (`remote_only_local_writes_disabled`), `event_upload_status` and `event_conflicts` (`remote_only_sync_disabled`)

## License

Apache-2.0
