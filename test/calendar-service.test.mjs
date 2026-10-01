import test from 'node:test';
import assert from 'node:assert/strict';
import { CalendarService } from '../src/calendar/calendar-service.mjs';

test('calendar service acquires lease before sync and releases provider', async () => {
  let released = false;
  const leaseBroker = {
    async acquire() { return { leaseId: 'l1', accountId: 'a', purpose: 'caldav-sync', fields: [], expiresAt: Date.now() + 60_000 }; },
    async release() { released = true; }
  };
  const provider = {
    async listCalendars() { return [{ id: 'cal-1', ctag: 'c1' }]; },
    async *fetchEvents() { yield { uid: 'u1', summary: 'S', raw: 'R' }; },
    async close() {}
  };
  const store = {
    getCheckpoint: () => null,
    upsertCalendar: () => {},
    upsertEvent: () => {},
    checkpoint: () => {}
  };
  const service = new CalendarService({
    accountRegistry: { get: () => ({ id: 'a', connection: { baseUrl: 'https://x/' } }) },
    leaseBroker,
    providerFactory: async () => provider
  });
  await assert.rejects(() => service.syncAccount('a', { mode: 'full', store }), /remote_only_sync_disabled/);
  assert.equal(released, false);
});
