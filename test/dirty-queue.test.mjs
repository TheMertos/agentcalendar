import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteCalendarStore } from '../src/storage/sqlite-store.mjs';
import { buildVeventIcal } from '../src/calendar/ical.mjs';

test('enqueueDirtyEvent is idempotent per account calendar uid', () => {
  const store = new SqliteCalendarStore(':memory:');
  const icalA = buildVeventIcal({ uid: 'u1', summary: 'A', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' });
  const icalB = buildVeventIcal({ uid: 'u1', summary: 'B', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' });
  store.enqueueDirtyEvent({
    accountId: 'a',
    calendarId: 'cal',
    uid: 'u1',
    expectedEtag: 'etag-1',
    icalBody: icalA
  });
  store.enqueueDirtyEvent({
    accountId: 'a',
    calendarId: 'cal',
    uid: 'u1',
    expectedEtag: 'etag-1',
    icalBody: icalB
  });
  const pending = store.listDirtyEvents('a', { status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].icalBody.includes('SUMMARY:B'), true);
  store.close();
});

test('recordConflict persists conflict for MCP listing', () => {
  const store = new SqliteCalendarStore(':memory:');
  store.recordConflict({
    accountId: 'a',
    calendarId: 'cal',
    uid: 'u1',
    expectedEtag: 'local-etag',
    remoteEtag: 'remote-etag',
    message: 'etag_mismatch'
  });
  const conflicts = store.listConflicts('a');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].uid, 'u1');
  assert.equal(conflicts[0].remoteEtag, 'remote-etag');
  store.close();
});
