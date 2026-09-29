import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { loadConfig } from '../config.mjs';
import { SqliteCalendarStore } from '../storage/sqlite-store.mjs';
import { createLeaseBroker } from '../security/lease-broker.mjs';
import { createSecretFabricResolver } from '../security/secretfabric-resolver.mjs';
import { CalendarService, CALDAV_SYNC_FIELDS } from '../calendar/calendar-service.mjs';
import { createCaldavProvider } from '../calendar/caldav-provider.mjs';
import { SyncWorker } from '../calendar/sync-worker.mjs';
import { createMcpHandlers } from './handlers.mjs';

const config = loadConfig();
const store = new SqliteCalendarStore(config.dbPath);
const pendingApprovals = new Map();

const resolveCredentials = createSecretFabricResolver({
  baseUrl: config.secretFabricUrl,
  apiToken: config.secretFabricApiToken
});

const leaseBroker = createLeaseBroker({
  resolver: ({ accountId, purpose }) => {
    const account = store.getAccount(accountId);
    if (!account) throw new Error('account_not_found');
    return resolveCredentials({
      resourceId: account.secretRef,
      purpose,
      fieldPaths: CALDAV_SYNC_FIELDS
    });
  }
});

async function providerFactory({ account, lease }) {
  const credentials = leaseBroker.getPrivate(lease.leaseId);
  if (!credentials) throw new Error('credential_lease_unavailable');
  return createCaldavProvider({ connection: account.connection ?? {}, credentials });
}

const calendarService = new CalendarService({
  accountRegistry: store,
  leaseBroker,
  providerFactory
});

const handlers = createMcpHandlers({ store, calendarService, pendingApprovals });

const syncWorker = new SyncWorker({
  accounts: { list: () => store.listActiveAccounts() },
  sync: (accountId, options) => calendarService.syncAccount(accountId, { ...options, store }),
  intervalMs: config.syncIntervalSeconds * 1000
});
syncWorker.start();

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
  description: 'Full or incremental sync for one account into the local mirror.',
  inputSchema: { accountId: z.string().min(1), mode: z.enum(['full', 'incremental']).default('incremental') }
}, async ({ accountId, mode }) => text(await handlers.calendar_sync({ accountId, mode })));

server.registerTool('calendar_sync_all', {
  description: 'Sync every enabled calendar account.',
  inputSchema: { mode: z.enum(['full', 'incremental']).default('incremental') }
}, async ({ mode }) => text(await handlers.calendar_sync_all({ mode })));

server.registerTool('event_search', {
  description: 'Search the local event mirror by text and optional date range.',
  inputSchema: {
    accountId: z.string().min(1),
    query: z.string().default(''),
    start: z.string().nullable().optional(),
    end: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(200).default(50)
  }
}, async (input) => text(await handlers.event_search(input)));

server.registerTool('event_read', {
  description: 'Read one complete mirrored event by eventKey.',
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

async function main() {
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
