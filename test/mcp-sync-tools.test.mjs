import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandlers } from '../src/mcp/handlers.mjs';
import { SqliteCalendarStore } from '../src/storage/sqlite-store.mjs';

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

test('calendar_sync and calendar_sync_all report checkpoints without starting sync', async () => {
  const store = activeStore();
  store.checkpoint({
    accountId: 'a',
    calendarId: 'cal-1',
    mode: 'incremental',
    eventCount: 3,
    calendarCtag: 'ctag-1'
  });
  let synced = false;
  const handlers = createMcpHandlers({
    store,
    calendarService: {
      async syncAccount() {
        synced = true;
        return { events: 1 };
      }
    },
    pendingApprovals: new Map()
  });
  const status = await handlers.calendar_sync({ accountId: 'a', mode: 'full' });
  assert.equal(synced, false);
  assert.equal(status.syncStarted, false);
  assert.equal(status.mode, 'remote-only');
  assert.equal(status.syncEnabled, false);
  assert.deepEqual(status.calendars, []);
  assert.equal(JSON.stringify(status).includes('ctag-1'), false);
  assert.equal(status.secretRef, undefined);
  assert.equal(status.password, undefined);
  const all = await handlers.calendar_sync_all({ mode: 'full' });
  assert.equal(synced, false);
  assert.equal(all.syncStarted, false);
  assert.equal(all.accounts.length, 1);
  assert.deepEqual(all.accounts[0].calendars, []);
  store.close();
});

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

test('event_update_local does not write a local event', async () => {
  const store = activeStore();
  const handlers = createMcpHandlers({ store, calendarService: null, pendingApprovals: new Map() });
  const result = await handlers.event_update_local({
    accountId: 'a',
    calendarId: 'cal',
    uid: 'u1',
    summary: 'Changed'
  });
  assert.equal(result.error, 'remote_only_local_writes_disabled');
  assert.equal(store.getEvent('a', 'cal', 'u1'), null);
  const status = await handlers.event_upload_status({ accountId: 'a' });
  assert.equal(status.error, 'remote_only_sync_disabled');
  store.close();
});

test('event_conflicts does not read the local conflict cache', async () => {
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
  assert.equal(conflicts.error, 'remote_only_sync_disabled');
  store.close();
});
