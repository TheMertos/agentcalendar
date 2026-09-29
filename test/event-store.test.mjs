import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCalendarStore } from '../src/storage/sqlite-store.mjs';

test('event upsert is idempotent by account calendar and uid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentcal-events-'));
  const store = new SqliteCalendarStore(join(dir, 'cal.db'));
  const base = {
    accountId: 'a',
    calendarId: 'cal-1',
    uid: 'uid-1',
    etag: 'e1',
    summary: 'First',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z',
    allDay: false,
    raw: 'BEGIN:VEVENT\nUID:uid-1\nEND:VEVENT'
  };
  store.upsertEvent(base);
  store.upsertEvent({ ...base, summary: 'Updated', etag: 'e2' });
  const event = store.getEvent('a', 'cal-1', 'uid-1');
  assert.equal(event.summary, 'Updated');
  assert.equal(event.etag, 'e2');
  assert.equal(store.searchEvents('a', { query: 'Updated' }).length, 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
