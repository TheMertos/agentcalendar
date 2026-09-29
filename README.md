# AgentCalendar

Headless MCP CalDAV calendar server for AI agents. Sibling to [AgentMail](https://github.com/TheMertos/agentmail): same credential boundary, same stdio-only architecture, no web UI.

## What it does

- Mirrors CalDAV calendars and events into local SQLite for fast `event_search` / `event_read`.
- Resolves CalDAV credentials only through SecretFabric short-lived leases (`caldav-sync` purpose).
- Gates every real write behind `event_preview` → `event_approval_create` → `event_write` with a payload-bound, five-minute approval.

## Safety model

- **No secrets in MCP tools** — account passwords never appear in tool arguments or JSON results.
- **Active-account allowlist** — only accounts registered via `calendar_account_register` (with an opaque `secretRef`) are synced or written.
- **Human in the loop** — creating or updating calendar events requires an explicit approval matching the exact iCal body.

## Runtime configuration (required)

| Variable | Purpose |
|----------|---------|
| `AGENTCAL_DB_PATH` | SQLite database path |
| `AGENTCAL_SYNC_INTERVAL_SECONDS` | Background sync interval (≥ 30) |
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

## Docker

```bash
export SECRET_FABRIC_URL=http://127.0.0.1:3000
export SECRET_FABRIC_API_TOKEN=your-token
docker compose build
docker compose up -d
```

`network_mode: host` lets the container reach SecretFabric on the host loopback.

## Hermes MCP example

```bash
hermes mcp add agentcalendar -- docker compose -f /path/to/agentcalendar/compose.yaml run --rm -T agentcalendar
```

(Adjust paths and ensure `SECRET_FABRIC_*` are set in the environment passed to Compose.)

## MCP tools (summary)

- Accounts: `calendar_account_list`, `calendar_account_status`, `calendar_account_register`, `calendar_account_deactivate`
- Sync: `calendar_list`, `calendar_sync`, `calendar_sync_all`
- Read: `event_search`, `event_read`
- Write (approval-gated): `event_preview`, `event_approval_create`, `event_write`

## License

Apache-2.0
