# AgentCalendar specification v0.1

## Purpose

Headless MCP CalDAV calendar server for AI agents, sibling project to AgentMail (https://github.com/TheMertos/agentmail). Same security model, same credential boundary, same stdio-only headless architecture. No UI.

## Non-negotiable rules (copied from AgentMail conventions — follow exactly)

- Runtime: Node.js 22, ESM (`.mjs`), no TypeScript, no framework. `@modelcontextprotocol/sdk` for the MCP server, stdio transport only.
- Test-Driven Development is mandatory: for every new module, write the failing test first (`node --test`), watch it fail, then implement. Do not write implementation before its test exists. Use `node:test` + `node:assert/strict`, no other test framework.
- No secrets ever pass through MCP tool arguments or tool results. Calendar account credentials (CalDAV base URL, username, password) are resolved through a SecretFabric-style lease broker, exactly like AgentMail's `src/security/lease-broker.mjs` and `src/security/secretfabric-resolver.mjs` (copy these two files verbatim into this repo, they are reusable as-is).
- Env vars are REQUIRED for runtime configuration only (fail closed at startup if missing), never for account data: `AGENTCAL_DB_PATH`, `AGENTCAL_SYNC_INTERVAL_SECONDS`, `AGENTCAL_LOG_LEVEL`, `AGENTCAL_TRANSPORT` (stdio|streamable-http), `SECRET_FABRIC_URL`, `SECRET_FABRIC_API_TOKEN`. Model this exactly on AgentMail's `src/config.mjs` (copy the pattern, adapt var names).
- Calendar accounts, event data, sync checkpoints, and everything else live in SQLite (`better-sqlite3`) under a Docker volume, never in env vars. Only the active-account allowlist model from AgentMail's `src/storage/sqlite-store.mjs` (`active_accounts` table, `activateAccount`/`deactivateAccount`/`listActiveAccounts`/`getAccount`) should be copied and adapted — same idea: the agent may only touch calendars explicitly added to the active list.
- SecretFabric already has a `caldav` resource schema (see /home/mert/secretfabric/src/lib/schema-catalog.ts) with fields: `identity.email`, `server.baseUrl`, `server.calendarPath`, `auth.username`, `auth.password` (sensitive/claimOnly). The resolver endpoint at SecretFabric `/api/resolve` already accepts purpose `caldav-sync` and these field paths (see /home/mert/secretfabric/src/lib/resolver.ts, ALLOWED_PATHS includes `server.baseUrl`, `server.calendarPath`, `auth.username`, `auth.password`, `identity.email`). Use purpose `caldav-sync` for every lease request.
- Docker: multi-stage Dockerfile like AgentMail's (node:22-alpine, python3/make/g++ for native module builds, non-root user, ENTRYPOINT running the MCP server over stdio). compose.yaml should use `network_mode: host` so the container can reach SecretFabric at 127.0.0.1:3000, and a named volume for the SQLite file, with the four AGENTCAL_* env vars plus SECRET_FABRIC_URL/SECRET_FABRIC_API_TOKEN required (fail closed via `:?` in compose.yaml, matching AgentMail's compose.yaml).
- MIT or Apache-2.0 license, README explaining scope and safety model (model tone on AgentMail's README/docs/HEADLESS-MCP.md — headless, human-in-the-loop, credential boundary).

## Reference implementation to study first

Read these AgentMail files before writing anything (path: /home/mert/agent-mail-client):
- src/config.mjs + test/config.test.mjs (required-env pattern)
- src/security/lease-broker.mjs + test/lease-broker.test.mjs
- src/security/secretfabric-resolver.mjs + test/secretfabric-resolver.test.mjs
- src/storage/sqlite-store.mjs (only the active_accounts section, not the mail-specific tables)
- src/mail/mail-service.mjs (the credential-lease-then-provider-factory pattern)
- src/mcp/server.mjs (how tools are registered, how config/store/leaseBroker/providerFactory are wired together)
- Dockerfile, compose.yaml, .dockerignore, eslint.config.mjs, package.json

Copy the lease-broker.mjs and secretfabric-resolver.mjs files verbatim (they are generic, not mail-specific). Adapt everything else to calendars.

## CalDAV library

Use `tsdav` (npm) for CalDAV protocol handling (fetch calendars, fetch/create/update/delete events, basic auth). If `tsdav` proves unworkable, fall back to a minimal hand-rolled CalDAV client using `node:https`/`fetch` with PROPFIND/REPORT — but try `tsdav` first since it's actively maintained and handles iCal parsing.

## Domain model

```text
CalendarAccount
  id, email, provider, secretRef (opaque), connection (baseUrl, calendarPath), enabled

Calendar
  accountId, calendarId (URL), displayName, color, timezone

Event
  accountId, calendarId, uid (iCal UID), etag, summary, description,
  location, start, end, allDay, recurrenceRule, recurrenceId,
  attendees (json), organizer, status, raw (full iCal VEVENT text), updatedAt
```

## Sync engine

- Full sync: discover all calendars for an account (CalDAV PROPFIND on the account's calendar-home-set or the explicit `server.calendarPath`), then fetch all events (CalDAV REPORT calendar-query) into SQLite.
- Incremental sync: use CTag/ETag comparison per calendar — skip unchanged calendars, refetch only events whose ETag changed. Store ETags per event and per calendar (a `sync_checkpoints`-equivalent table).
- Idempotent upsert by `(accountId, calendarId, uid)`.
- A background `SyncWorker` (model on AgentMail's `src/mail/sync-worker.mjs`) that runs on an interval and syncs every active+enabled account, with per-account locking to prevent overlapping syncs.

## Bidirectional synchronization (required)

- Download sync remains provider → SQLite mirror.
- Add an explicit per-account/calendar `autoUpload` policy, default `false`.
- Local event mutations create a durable `dirty_events`/upload queue entry rather than silently changing the provider.
- When `autoUpload=true`, the background worker uploads dirty events to CalDAV after the normal policy/approval decision; it must never upload arbitrary downloaded mirror rows.
- Preserve event UID and use the last known ETag with `If-Match` to prevent overwriting remote changes.
- On ETag conflict, do not overwrite or retry blindly; persist a conflict record and expose it through MCP.
- After PUT, read the event back and update local ETag/raw/dirty state only after UID and content verification.
- Retry transient failures with bounded exponential backoff; retain failed jobs and error class.
- Add MCP tools: `sync_policy_get`, `sync_policy_set`, `event_update_local`, `event_upload_status`, and `event_conflicts`.
- `event_write` remains available for explicit immediate writes and uses the same ETag/read-back rules.
- Test dirty queue idempotency, upload success, conflict protection, retry behavior, and autoUpload off/on behavior with TDD.


Account management:
- `calendar_account_list` — metadata only, never credentials
- `calendar_account_status`
- `calendar_account_register` — non-sensitive metadata + opaque secretRef; reject any field that looks like a credential (password/token/secret) exactly like AgentMail's `assertSafeMetadata`
- `calendar_account_deactivate` — removes from active list, keeps local data

Calendar/event read:
- `calendar_list` — list calendars for one account (requires a real caldav-sync lease; never accepts credentials as arguments)
- `calendar_sync` — full/incremental sync for one account into the local mirror
- `calendar_sync_all` — sync every active account
- `event_search` — search the local mirror by text/date range across calendars
- `event_read` — read one complete event by its exact stored key

Write operations (must be approval-gated exactly like AgentMail's send_approval_create / message_send pattern — no direct write tool):
- `event_preview` — render the exact iCal VEVENT that would be created/updated from structured input (summary, start, end, attendees, etc.), never send it anywhere yet
- `event_approval_create` — create a short-lived (5 min) approval bound to a content hash of the exact previewed event payload (accountId, calendarId, uid-or-new, full iCal body) — reuse AgentMail's `src/core/approval.mjs` create/verify functions verbatim, they are generic
- `event_write` — requires a valid unexpired approval for the exact same payload; performs the actual CalDAV PUT (create or update); verifies by reading the event back via GET and comparing UID/ETag; any payload mismatch invalidates the approval
- `event_delete` (optional, same approval-gated pattern) — only if time permits after everything else works

## Non-negotiable safety rules

- AI can read/search/preview calendars and events freely, but can NEVER create, update, or delete a real calendar event without going through `event_preview` → `event_approval_create` → `event_write` with a payload-bound, time-limited approval, exactly like AgentMail's mail-send flow.
- No account is touched unless it appears in the active-accounts allowlist (added via `calendar_account_register`, i.e., after a SecretFabric claim was completed and the human entered credentials in the masked form).
- No plaintext credential anywhere in code, git history, logs, MCP tool inputs/outputs, or SQLite tables outside the trusted in-memory lease.

## Acceptance checklist (must all be true before calling this done)

1. `yarn lint && yarn test` is green (eslint + node:test), with tests written before implementation for every new module (TDD, RED→GREEN visible in commit history is a bonus but not required — the important thing is real, meaningful, currently-passing tests exist for account registry, lease broker reuse, sync engine idempotency, approval verify/expire, and MCP tool wiring where feasible without a live CalDAV server).
2. `docker compose build` succeeds.
3. `docker compose up -d` starts a healthy/running container.
4. Git repo initialized at /home/mert/agentcalendar, first commit made, remote NOT pushed yet (I will review and push it myself after you're done — do not run `git push` or create a GitHub repo).
5. Write a final summary file at /home/mert/agentcalendar/IMPLEMENTATION_REPORT.md listing: what was implemented, test count and pass/fail, what is stubbed/not implemented (e.g. if tsdav integration couldn't be verified against a live server, say so explicitly), and exact commands to verify (yarn test, docker compose build, docker compose up -d, hermes mcp add example).

## Explicitly out of scope for this pass

- No web UI.
- No OAuth-based calendar providers (Google Calendar API, Microsoft Graph) — CalDAV only for now.
- No recurring-event expansion/RRULE math beyond storing the raw RRULE string; don't build a recurrence engine.
- Do not touch anything under /home/mert/agent-mail-client or /home/mert/secretfabric except reading files for reference.
