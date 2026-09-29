import test from 'node:test';
import assert from 'node:assert/strict';
import { syncAccount } from '../src/calendar/sync-engine.mjs';

test('incremental sync skips calendars with unchanged ctag', async () => {
  const fetched = [];
  const store = {
    async getCheckpoint(_accountId, calendarId) {
      return { calendarCtag: calendarId === 'cal-1' ? 'ctag-v1' : null };
    },
    async upsertCalendar() {},
    async upsertEvent() {},
    async checkpoint() {}
  };
  const provider = {
    async listCalendars() {
      return [
        { id: 'cal-1', displayName: 'Same', ctag: 'ctag-v1' },
        { id: 'cal-2', displayName: 'Changed', ctag: 'ctag-v2' }
      ];
    },
    async *fetchEvents(calendar) {
      fetched.push(calendar.id);
      yield { uid: 'u1', etag: 'e1', summary: 'x', raw: 'RAW' };
    }
  };
  const result = await syncAccount({ accountId: 'a', provider, store, mode: 'incremental' });
  assert.deepEqual(fetched, ['cal-2']);
  assert.equal(result.skippedCalendars, 1);
});

test('full sync refetches every calendar', async () => {
  const fetched = [];
  const store = {
    async getCheckpoint() { return { calendarCtag: 'old' }; },
    async upsertCalendar() {},
    async upsertEvent() {},
    async checkpoint() {}
  };
  const provider = {
    async listCalendars() {
      return [{ id: 'cal-1', ctag: 'ctag-v1' }];
    },
    async *fetchEvents(calendar) {
      fetched.push(calendar.id);
    }
  };
  await syncAccount({ accountId: 'a', provider, store, mode: 'full' });
  assert.deepEqual(fetched, ['cal-1']);
});
