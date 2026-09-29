import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteCalendarStore } from '../src/storage/sqlite-store.mjs';

test('sync policy defaults autoUpload to false per calendar', () => {
  const store = new SqliteCalendarStore(':memory:');
  const policy = store.getSyncPolicy('acct', 'cal-1');
  assert.equal(policy.autoUpload, false);
  store.close();
});

test('sync policy set and get round-trip', () => {
  const store = new SqliteCalendarStore(':memory:');
  store.setSyncPolicy('acct', 'cal-1', { autoUpload: true });
  assert.equal(store.getSyncPolicy('acct', 'cal-1').autoUpload, true);
  store.setSyncPolicy('acct', 'cal-1', { autoUpload: false });
  assert.equal(store.getSyncPolicy('acct', 'cal-1').autoUpload, false);
  store.close();
});

test('listSyncPolicies returns explicit rows for an account', () => {
  const store = new SqliteCalendarStore(':memory:');
  store.setSyncPolicy('acct', 'cal-a', { autoUpload: true });
  store.setSyncPolicy('acct', 'cal-b', { autoUpload: false });
  const policies = store.listSyncPolicies('acct');
  assert.deepEqual(
    policies.sort((a, b) => a.calendarId.localeCompare(b.calendarId)),
    [
      { accountId: 'acct', calendarId: 'cal-a', autoUpload: true },
      { accountId: 'acct', calendarId: 'cal-b', autoUpload: false }
    ]
  );
  store.close();
});
