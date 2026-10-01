import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { loadConfig } from '../config.mjs';
import { assertNativeService } from '../runtime/native-service.mjs';
import { createCalendarRuntime } from '../runtime/calendar-runtime.mjs';
import { createMcpHandlers } from './handlers.mjs';

const config = String(process.env.AGENTCAL_SERVICE_MODE ?? '').trim() === 'native'
  ? assertNativeService(process.env)
  : loadConfig();
const { store, calendarService } = createCalendarRuntime(config);
const pendingApprovals = new Map();
const handlers = createMcpHandlers({ store, calendarService, pendingApprovals });

const server = new McpServer({ name: 'agentcalendar', version: '0.1.0' });
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

server.registerTool('calendar_account_list', {
  description: 'List configured calendar account metadata. Credentials are never returned.',
  inputSchema: {}
}, async () => text(await handlers.calendar_account_list()));

server.registerTool('calendar_account_status', {
  description: 'Return connection status for one calendar account without credentials.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => text(await handlers.calendar_account_status({ accountId })));

server.registerTool('calendar_account_register', {
  description: 'Register non-sensitive account metadata and an opaque SecretFabric credential reference.',
  inputSchema: {
    id: z.string().min(1),
    email: z.string().email(),
    provider: z.string().min(1),
    secretRef: z.string().min(1),
    connection: z.record(z.string(), z.unknown()).optional()
  }
}, async (account) => text(await handlers.calendar_account_register(account)));

server.registerTool('calendar_account_deactivate', {
  description: 'Remove an account from the active list without deleting its local mirror.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => text(await handlers.calendar_account_deactivate({ accountId })));

server.registerTool('calendar_list', {
  description: 'List CalDAV calendars for an account. Requires a caldav-sync lease; credentials are never tool arguments.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => text(await handlers.calendar_list({ accountId })));

server.registerTool('calendar_sync', {
  description: 'Report that background calendar sync is disabled. Does not start, enqueue, or wait for a sync. Does not read local checkpoints. Never returns credentials.',
  inputSchema: {
    accountId: z.string().min(1),
    mode: z.enum(['full', 'incremental']).optional()
  }
}, async ({ accountId }) => text(await handlers.calendar_sync({ accountId })));

server.registerTool('calendar_sync_all', {
  description: 'Report that background calendar sync is disabled for every active account. Does not start, enqueue, or wait for a sync. Does not read local checkpoints. Never returns credentials.',
  inputSchema: { mode: z.enum(['full', 'incremental']).optional() }
}, async () => text(await handlers.calendar_sync_all()));

server.registerTool('event_search', {
  description: 'Search live CalDAV events in one calendar. Explicit calendarId searches only that calendar. Omitted calendarId searches the account calendar path, or the first calendar. The time window defaults to 30 days before and after now. Page size defaults to 50 and cannot exceed 200. Results are ordered by date descending unless sortOrder is asc. A nextCursor is returned only when the server honors a bounded calendar-query. Otherwise an oversized window fails with pagination_unavailable and event bodies are not downloaded. Does not read a local event mirror.',
  inputSchema: {
    accountId: z.string().min(1),
    calendarId: z.string().min(1).optional(),
    query: z.string().default(''),
    start: z.string().nullable().optional(),
    end: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    sortBy: z.enum(['date']).default('date'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
    cursor: z.string().min(1).optional()
  }
}, async (input) => text(await handlers.event_search(input)));

server.registerTool('event_read', {
  description: 'Read one complete event from CalDAV by eventKey. Does not read a local event mirror.',
  inputSchema: { eventKey: z.string().min(1) }
}, async ({ eventKey }) => text(await handlers.event_read({ eventKey })));

server.registerTool('event_preview', {
  description: 'Render the exact iCal VEVENT that would be written. Does not contact CalDAV.',
  inputSchema: {
    accountId: z.string().min(1),
    calendarId: z.string().min(1),
    uid: z.string().optional(),
    summary: z.string(),
    description: z.string().optional(),
    location: z.string().optional(),
    start: z.string(),
    end: z.string(),
    attendees: z.array(z.string()).optional(),
    organizer: z.string().optional(),
    recurrenceRule: z.string().optional()
  }
}, async (input) => text(await handlers.event_preview(input)));

server.registerTool('event_approval_create', {
  description: 'Create a short-lived approval bound to the exact previewed event payload.',
  inputSchema: {
    accountId: z.string().min(1),
    calendarId: z.string().min(1),
    uid: z.string().nullable().optional(),
    icalBody: z.string().min(1)
  }
}, async (payload) => text(await handlers.event_approval_create(payload)));

server.registerTool('event_write', {
  description: 'Write an approved event to CalDAV after human approval.',
  inputSchema: {
    approvalId: z.string().uuid(),
    accountId: z.string().min(1),
    calendarId: z.string().min(1),
    uid: z.string().nullable().optional(),
    icalBody: z.string().min(1)
  }
}, async (input) => text(await handlers.event_write(input)));

server.registerTool('sync_policy_get', {
  description: 'Read per-calendar autoUpload policy (default false).',
  inputSchema: { accountId: z.string().min(1), calendarId: z.string().min(1) }
}, async (input) => text(await handlers.sync_policy_get(input)));

server.registerTool('sync_policy_set', {
  description: 'Set per-calendar autoUpload policy for background uploads.',
  inputSchema: {
    accountId: z.string().min(1),
    calendarId: z.string().min(1),
    autoUpload: z.boolean()
  }
}, async (input) => text(await handlers.sync_policy_set(input)));

server.registerTool('event_update_local', {
  description: 'Disabled in remote-only mode. Event changes go through event_preview, event_approval_create, and event_write.',
  inputSchema: {
    accountId: z.string().min(1),
    calendarId: z.string().min(1),
    uid: z.string().min(1),
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional()
  }
}, async (input) => text(await handlers.event_update_local(input)));

server.registerTool('event_upload_status', {
  description: 'List dirty upload queue rows for an account.',
  inputSchema: { accountId: z.string().min(1), calendarId: z.string().optional() }
}, async (input) => text(await handlers.event_upload_status(input)));

server.registerTool('event_conflicts', {
  description: 'List ETag conflicts detected during upload.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => text(await handlers.event_conflicts({ accountId })));

/**
 * Hold the native host service open without starting sync or an MCP stdio session.
 * A timer keeps the event loop referenced until SIGTERM or SIGINT.
 * @returns {Promise<void>}
 */
function holdNativeService() {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
    const stop = () => {
      clearInterval(keepAlive);
      resolve();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

async function main() {
  if (process.env.AGENTCAL_NATIVE_HOLD === '1') {
    await holdNativeService();
    return;
  }
  if (config.transport !== 'stdio') {
    throw new Error('streamable-http transport is not implemented in this pass');
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`AgentCalendar MCP error: ${error.message}\n`);
  process.exit(1);
});
