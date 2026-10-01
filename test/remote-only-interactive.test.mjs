import test from 'node:test';
import assert from 'node:assert/strict';
import { CalendarService } from '../src/calendar/calendar-service.mjs';
import { createMcpHandlers } from '../src/mcp/handlers.mjs';
import { SqliteCalendarStore } from '../src/storage/sqlite-store.mjs';
import { createApproval } from '../src/core/approval.mjs';

test('event_search uses CalDAV and does not read the local mirror', async () => {
  const store = new SqliteCalendarStore(':memory:');
  store.activateAccount({
    id: 'a',
    email: 'u@example.com',
    provider: 'generic',
    secretRef: 'r',
    connection: { baseUrl: 'https://cal.example.test/' }
  });
  store.upsertEvent({
    accountId: 'a',
    calendarId: 'https://cal.example.test/home/',
    uid: 'local-only',
    summary: 'Cached',
    raw: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:local-only\r\nSUMMARY:Cached\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z'
  });
  let listed = false;
  const calendarService = new CalendarService({
    accountRegistry: { get: (id) => store.getAccount(id) },
    leaseBroker: {
      async acquire() { return { leaseId: 'lease-1' }; },
      async release() {}
    },
    providerFactory: async () => ({
      async listCalendars() {
        listed = true;
        return [{ id: 'https://cal.example.test/home/', url: 'https://cal.example.test/home/' }];
      },
      async *fetchEvents() {
        yield {
          uid: 'remote-1',
          etag: 'e-live',
          summary: 'Live standup',
          raw: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:remote-1\r\nSUMMARY:Live standup\r\nDTSTART:20260102T100000Z\r\nDTEND:20260102T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
        };
      },
      async close() {}
    })
  });
  const handlers = createMcpHandlers({ store, calendarService, pendingApprovals: new Map() });
  const hits = await handlers.event_search({ accountId: 'a', query: 'standup', limit: 10 });
  assert.equal(listed, true);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].uid, 'remote-1');
  assert.equal(hits[0].etag, 'e-live');
  assert.equal(JSON.stringify(hits).includes('Cached'), false);
  store.close();
});

test('event_search fails closed when CalDAV fails', async () => {
  const store = new SqliteCalendarStore(':memory:');
  store.activateAccount({
    id: 'a',
    email: 'u@example.com',
    provider: 'generic',
    secretRef: 'r',
    connection: { baseUrl: 'https://cal.example.test/' }
  });
  store.upsertEvent({
    accountId: 'a',
    calendarId: 'cal',
    uid: 'local-only',
    summary: 'Cached',
    raw: 'BEGIN:VEVENT\r\nUID:local-only\r\nSUMMARY:Cached\r\nEND:VEVENT\r\n'
  });
  const calendarService = new CalendarService({
    accountRegistry: { get: (id) => store.getAccount(id) },
    leaseBroker: {
      async acquire() { return { leaseId: 'lease-1' }; },
      async release() {}
    },
    providerFactory: async () => ({
      async listCalendars() { throw new Error('caldav_down'); },
      async *fetchEvents() {},
      async close() {}
    })
  });
  const handlers = createMcpHandlers({ store, calendarService, pendingApprovals: new Map() });
  const result = await handlers.event_search({ accountId: 'a', query: 'Cached' });
  assert.equal(result.error, 'caldav_down');
  assert.equal(result.length, undefined);
  store.close();
});

test('event_write uses the live ETag and does not store the event', async () => {
  const puts = [];
  const store = {
    upsertEvent() { throw new Error('local_write'); },
    getEvent() { throw new Error('local_read'); }
  };
  const service = new CalendarService({
    accountRegistry: { get: () => ({ id: 'a' }) },
    leaseBroker: {
      async acquire() { return { leaseId: 'lease-1' }; },
      async release() {}
    },
    providerFactory: async () => ({
      async getEvent({ uid }) {
        if (puts.length === 0) return { uid, etag: 'etag-live', raw: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nSUMMARY:Before\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' };
        return { uid, etag: 'etag-new', raw: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nSUMMARY:After\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' };
      },
      async putEvent(input) {
        puts.push(input);
        return { etag: 'etag-new', uid: input.uid };
      },
      async close() {}
    })
  });
  const icalBody = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nSUMMARY:After\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const result = await service.writeEvent('a', {
    calendarId: 'https://cal.example.test/home/',
    uid: 'u1',
    icalBody
  });
  assert.equal(result.verified, true);
  assert.equal(result.etag, 'etag-new');
  assert.equal(puts[0].etag, 'etag-live');
  assert.equal(store.upsertEvent, store.upsertEvent);
});

test('approved event_write does not persist a local copy', async () => {
  const store = new SqliteCalendarStore(':memory:');
  store.activateAccount({
    id: 'a',
    email: 'u@example.com',
    provider: 'generic',
    secretRef: 'r',
    connection: { baseUrl: 'https://cal.example.test/' }
  });
  const icalBody = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nSUMMARY:After\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const payload = {
    accountId: 'a',
    calendarId: 'https://cal.example.test/home/',
    uid: 'u1',
    icalBody
  };
  const approval = createApproval(payload, { ttlSeconds: 300 });
  const pending = new Map([[approval.id, { approval, payload }]]);
  const calendarService = new CalendarService({
    accountRegistry: { get: (id) => store.getAccount(id) },
    leaseBroker: {
      async acquire() { return { leaseId: 'lease-1' }; },
      async release() {}
    },
    providerFactory: async () => ({
      async getEvent({ uid }) {
        return { uid, etag: 'etag-new', raw: icalBody };
      },
      async putEvent() { return { etag: 'etag-new', uid: 'u1' }; },
      async close() {}
    })
  });
  const handlers = createMcpHandlers({ store, calendarService, pendingApprovals: pending });
  const result = await handlers.event_write({ approvalId: approval.id, ...payload });
  assert.equal(result.verified, true);
  assert.equal(store.getEvent('a', payload.calendarId, 'u1'), null);
  store.close();
});
