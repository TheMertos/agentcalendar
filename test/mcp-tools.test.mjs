import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandlers } from '../src/mcp/handlers.mjs';
import { SqliteCalendarStore } from '../src/storage/sqlite-store.mjs';

test('calendar_account_register rejects credential fields in connection', async () => {
  const store = new SqliteCalendarStore(':memory:');
  const handlers = createMcpHandlers({ store, calendarService: null, pendingApprovals: new Map() });
  const result = await handlers.calendar_account_register({
    id: 'x',
    email: 'u@example.com',
    provider: 'generic',
    secretRef: 'ref-1',
    connection: { baseUrl: 'https://x/', password: 'nope' }
  });
  assert.match(JSON.stringify(result), /not allowed/);
  store.close();
});

test('event_write requires valid approval', async () => {
  const store = new SqliteCalendarStore(':memory:');
  store.activateAccount({
    id: 'a',
    email: 'u@example.com',
    provider: 'generic',
    secretRef: 'r',
    connection: { baseUrl: 'https://x/' }
  });
  const pending = new Map();
  const handlers = createMcpHandlers({
    store,
    calendarService: { writeEvent: async () => ({ verified: true, uid: 'u', etag: 'e' }) },
    pendingApprovals: pending
  });
  const missing = await handlers.event_write({
    approvalId: '00000000-0000-4000-8000-000000000001',
    accountId: 'a',
    calendarId: 'cal',
    uid: 'u',
    icalBody: 'BODY'
  });
  assert.match(JSON.stringify(missing), /approval_not_found/);
  store.close();
});
