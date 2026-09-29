import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandlers } from '../src/mcp/handlers.mjs';
import { SqliteCalendarStore } from '../src/storage/sqlite-store.mjs';
import { buildVeventIcal } from '../src/calendar/ical.mjs';

function activeStore() {
  const store = new SqliteCalendarStore(':memory:');
  store.activateAccount({
    id: 'a',
    email: 'u@example.com',
    provider: 'generic',
    secretRef: 'r',
    connection: { baseUrl: 'https://x/' }
  });
  return store;
}

test('sync_policy_get and sync_policy_set', async () => {
  const store = activeStore();
  const handlers = createMcpHandlers({ store, calendarService: null, pendingApprovals: new Map() });
  const before = await handlers.sync_policy_get({ accountId: 'a', calendarId: 'cal-1' });
  assert.equal(before.autoUpload, false);
  await handlers.sync_policy_set({ accountId: 'a', calendarId: 'cal-1', autoUpload: true });
  const after = await handlers.sync_policy_get({ accountId: 'a', calendarId: 'cal-1' });
  assert.equal(after.autoUpload, true);
  store.close();
});

test('event_update_local enqueues dirty row', async () => {
  const store = activeStore();
  const raw = buildVeventIcal({
    uid: 'u1',
    summary: 'S',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z'
  });
  store.upsertEvent({
    accountId: 'a',
    calendarId: 'cal',
    uid: 'u1',
    etag: 'e1',
    summary: 'S',
    raw,
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z'
  });
  const handlers = createMcpHandlers({ store, calendarService: null, pendingApprovals: new Map() });
  const result = await handlers.event_update_local({
    accountId: 'a',
    calendarId: 'cal',
    uid: 'u1',
    summary: 'Changed'
  });
  assert.equal(result.summary, 'Changed');
  const status = await handlers.event_upload_status({ accountId: 'a' });
  assert.equal(status.pending.length, 1);
  store.close();
});

test('event_conflicts lists stored conflicts', async () => {
  const store = activeStore();
  store.recordConflict({
    accountId: 'a',
    calendarId: 'cal',
    uid: 'u1',
    expectedEtag: 'e1',
    remoteEtag: 'e2',
    message: 'etag_mismatch'
  });
  const handlers = createMcpHandlers({ store, calendarService: null, pendingApprovals: new Map() });
  const conflicts = await handlers.event_conflicts({ accountId: 'a' });
  assert.equal(conflicts.length, 1);
  store.close();
});
