import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteCalendarStore } from '../src/storage/sqlite-store.mjs';
import { updateEventLocal } from '../src/calendar/local-event-service.mjs';
import { buildVeventIcal } from '../src/calendar/ical.mjs';

test('updateEventLocal mutates mirror and enqueues dirty upload', () => {
  const store = new SqliteCalendarStore(':memory:');
  const raw = buildVeventIcal({
    uid: 'u1',
    summary: 'Before',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z'
  });
  store.upsertEvent({
    accountId: 'a',
    calendarId: 'cal',
    uid: 'u1',
    etag: 'e1',
    summary: 'Before',
    raw,
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z'
  });
  const updated = updateEventLocal(store, {
    accountId: 'a',
    calendarId: 'cal',
    uid: 'u1',
    summary: 'After'
  });
  assert.equal(updated.summary, 'After');
  const dirty = store.listDirtyEvents('a', { status: 'pending' });
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].expectedEtag, 'e1');
  store.close();
});
