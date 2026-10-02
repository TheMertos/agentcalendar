# AgentCalendar specification v0.1

## Purpose

Headless MCP CalDAV calendar server for AI agents, sibling project to AgentMail (https://github.com/TheMertos/agentmail). Same security model, same credential boundary, same stdio-only headless architecture. No UI.

## Non-negotiable rules (copied from AgentMail conventions — follow exactly)

- Runtime: Node.js 22, ESM (`.mjs`), no TypeScript, no framework. `@modelcontextprotocol/sdk` for the MCP server, stdio transport only.
- Test-Driven Development is mandatory: for every new module, write the failing test first (`node --test`), watch it fail, then implement. Do not write implementation before its test exists. Use `node:test` + `node:assert/strict`, no other test framework.
- No secrets ever pass through MCP tool arguments or tool results. Calendar account credentials (CalDAV base URL, username, password) are resolved through a SecretFabric-style lease broker, exactly like AgentMail's `src/security/lease-broker.mjs` and `src/security/secretfabric-resolver.mjs` (copy these two files verbatim into this repo, they are reusable as-is).
- Env vars are REQUIRED for runtime configuration only (fail closed at startup if missing), never for account data: `AGENTCAL_DB_PATH`, `AGENTCAL_SYNC_INTERVAL_SECONDS`, `AGENTCAL_LOG_LEVEL`, `AGENTCAL_TRANSPORT` (stdio|streamable-http), `SECRET_FABRIC_URL`, `SECRET_FABRIC_API_TOKEN`, `CREDENTIAL_CACHE_KEY`. `CREDENTIAL_CACHE_KEY` is an external 64-character hexadecimal secret. It is not stored in SQLite, MCP inputs or results, logs, or source. Model this exactly on AgentMail's `src/config.mjs` (copy the pattern, adapt var names). `AGENTCAL_SYNC_INTERVAL_SECONDS` stays a required integer ≥ 30 so startup still fails closed. It does not schedule a sync.
- SQLite (`better-sqlite3`) in the profile data directory stores the active-account allowlist: non-sensitive account metadata and an opaque SecretFabric `secretRef`. Interactive reads, searches, and writes do not use a local event mirror. The agent may only touch calendars explicitly added to the active list.
- SecretFabric already has a `caldav` resource schema (see /home/mert/secretfabric/src/lib/schema-catalog.ts) with fields: `identity.email`, `server.baseUrl`, `server.calendarPath`, `auth.username`, `auth.password` (sensitive/claimOnly). The resolver endpoint at SecretFabric `/api/resolve` already accepts purpose `caldav-sync` and these field paths (see /home/mert/secretfabric/src/lib/resolver.ts, ALLOWED_PATHS includes `server.baseUrl`, `server.calendarPath`, `auth.username`, `auth.password`, `identity.email`). Use purpose `caldav-sync` for every lease request.
- Native host service: `deploy/systemd/user/agentcalendar@.service` and `tools/hermes-agentcalendar-mcp.sh` run `node src/mcp/server.mjs` with `AGENTCAL_SERVICE_MODE=native`. Required env is `AGENTCAL_DB_PATH`, `AGENTCAL_SYNC_INTERVAL_SECONDS`, `AGENTCAL_LOG_LEVEL`, `AGENTCAL_TRANSPORT`, `AGENTCAL_PRINCIPAL`, `SECRET_FABRIC_PRINCIPAL`, `SECRET_FABRIC_URL`, `SECRET_FABRIC_API_TOKEN`, and `CREDENTIAL_CACHE_KEY`. The profile must match the principal. Provider access reconciles SecretFabric into the encrypted cache and decrypts only inside the service.
- MIT or Apache-2.0 license, README explaining scope and safety model (model tone on AgentMail's README/docs/HEADLESS-MCP.md — headless, human-in-the-loop, credential boundary).

## Reference implementation to study first

Read these AgentMail files before writing anything (path: /home/mert/agent-mail-client):
- src/config.mjs + test/config.test.mjs (required-env pattern)
- src/security/lease-broker.mjs + test/lease-broker.test.mjs
- src/security/secretfabric-resolver.mjs + test/secretfabric-resolver.test.mjs
- src/storage/sqlite-store.mjs (only the active_accounts section, not the mail-specific tables)
- src/mail/mail-service.mjs (the credential-lease-then-provider-factory pattern)
- src/mcp/server.mjs (how tools are registered, how config/store/leaseBroker/providerFactory are wired together)
- deploy/systemd/user/agentcalendar@.service, tools/hermes-agentcalendar-mcp.sh, eslint.config.mjs, package.json

Copy the lease-broker.mjs and secretfabric-resolver.mjs files verbatim (they are generic, not mail-specific). Adapt everything else to calendars.

## CalDAV library

Use `tsdav` (npm) for CalDAV protocol handling (fetch calendars, fetch/create/update/delete events, basic auth). If `tsdav` proves unworkable, fall back to a minimal hand-rolled CalDAV client using `node:https`/`fetch` with PROPFIND/REPORT — but try `tsdav` first since it's actively maintained and handles iCal parsing.

## Domain model

Persisted for interactive use:

```text
CalendarAccount
  id, email, provider, secretRef (opaque), connection (baseUrl, calendarPath), enabled
```

Calendars and events are remote CalDAV objects. Interactive tools do not persist them.

## Remote-only calendar access

- `calendar_list`, `event_search`, `event_read`, and approved `event_write` talk to CalDAV on each call.
- There is no background sync worker, no sync interval, and no IMAP IDLE equivalent. The native service runs only the MCP server. The worker entrypoint and `yarn start:worker` are disabled and must not be treated as an active sync process.
- SQLite keeps account metadata and opaque SecretFabric refs. Interactive operations do not read or write a local event mirror.
- Provider and lease failures return an error (`calendar_list`, `event_search`, `event_read`, `event_write`). Results are not filled from SQLite. A missing remote event is `event_not_found`.
- `event_write` loads the current remote ETag when a UID is present, sends it as `If-Match`, then reads the event back. UID, summary, and ETag must match. `412` / `precondition_failed` does not overwrite the remote event. The verified event is not stored locally.
- `calendar_sync` and `calendar_sync_all` report `mode: remote-only` and `syncEnabled: false`. They do not contact CalDAV.
- `event_update_local` returns `remote_only_local_writes_disabled`. `event_upload_status` and `event_conflicts` return `remote_only_sync_disabled`.

Account management:
- `calendar_account_list` — metadata only, never credentials
- `calendar_account_status`
- `calendar_account_register` — non-sensitive metadata + opaque secretRef; reject any field that looks like a credential (password/token/secret) exactly like AgentMail's `assertSafeMetadata`
- `calendar_account_deactivate` — removes from active list; account metadata may remain, events are not mirrored

Calendar/event read:
- `calendar_list` — list calendars for one account from CalDAV (requires a real caldav-sync lease; never accepts credentials as arguments)
- `calendar_sync` — report remote-only status for one account. Does not start, enqueue, or wait for a sync.
- `calendar_sync_all` — report remote-only status for every active account. Does not start a sync.
- `event_search` — search live CalDAV only. An explicit `calendarId` queries that calendar and does not list or read the others. With no `calendarId`, the account `calendarPath` is used when it matches one calendar; otherwise only the first calendar is queried. The time window is the caller’s `start`/`end` when both are set. A missing side extends 30 days from the side that is set. When both are omitted, the window is 30 days before and after the current time. Page size defaults to 50 and rejects values outside 1..200. Order is `date` descending unless `sortOrder` is `asc`, with the event key as a tie-break. The provider issues a time-bounded `calendar-query`. When that client honors a bounded REPORT (`boundedReport` or a report name containing `limit`/`nresults`), the REPORT asks for at most `limit + 1` objects and the page includes `nextCursor` / `hasMore`. Stock tsdav does not send a server limit. If the time window contains more objects than the page, the call fails with `pagination_unavailable` and does not download those event bodies. A cursor is not invented from a truncated download. Each event keeps its UID and ETag.
- `event_read` — read one complete event from CalDAV by `accountId::calendarId::uid`

Write operations (must be approval-gated exactly like AgentMail's send_approval_create / message_send pattern — no direct write tool):
- `event_preview` — render the exact iCal VEVENT that would be created/updated from structured input (summary, start, end, attendees, etc.), never send it anywhere yet
- `event_approval_create` — create a short-lived (5 min) approval bound to a content hash of the exact previewed event payload (accountId, calendarId, uid-or-new, full iCal body) — reuse AgentMail's `src/core/approval.mjs` create/verify functions verbatim, they are generic
- `event_write` — requires a valid unexpired approval for the exact same payload; performs the actual CalDAV PUT (create or update) with the live ETag as `If-Match` when a UID already exists; verifies by reading the event back and comparing UID, summary, and ETag; does not write the event into SQLite; any payload mismatch invalidates the approval
- `event_delete` (optional, same approval-gated pattern) — only if time permits after everything else works

## Non-negotiable safety rules

- AI can read/search/preview calendars and events freely, but can NEVER create, update, or delete a real calendar event without going through `event_preview` → `event_approval_create` → `event_write` with a payload-bound, time-limited approval, exactly like AgentMail's mail-send flow.
- No account is touched unless it appears in the active-accounts allowlist (added via `calendar_account_register`, i.e., after a SecretFabric claim was completed and the human entered credentials in the masked form).
- No plaintext credential anywhere in code, git history, logs, MCP tool inputs/outputs, or SQLite tables outside the trusted in-memory lease.

## Acceptance checklist (must all be true before calling this done)

1. `yarn lint && yarn test` is green (eslint + node:test), with tests written before implementation for every new module (TDD, RED→GREEN visible in commit history is a bonus but not required — the important thing is real, meaningful, currently-passing tests exist for account registry, lease broker reuse, sync engine idempotency, approval verify/expire, and MCP tool wiring where feasible without a live CalDAV server).
2. `systemctl --user is-active agentcalendar@default.service` reports the native unit.
3. The Hermes command is `tools/hermes-agentcalendar-mcp.sh`.
4. Git history stays on the existing repository.
5. `IMPLEMENTATION_REPORT.md` lists what was implemented, the test count, and native verification commands (`yarn lint`, `node --test --test-concurrency=1 test/**/*.test.mjs`).

## Explicitly out of scope for this pass

- No web UI.
- No OAuth-based calendar providers (Google Calendar API, Microsoft Graph) — CalDAV only for now.
- No recurring-event expansion/RRULE math beyond storing the raw RRULE string; don't build a recurrence engine.
- Do not touch anything under /home/mert/agent-mail-client or /home/mert/secretfabric except reading files for reference.
