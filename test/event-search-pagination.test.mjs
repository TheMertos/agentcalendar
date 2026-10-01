import test from 'node:test';
import assert from 'node:assert/strict';
import { CalendarService } from '../src/calendar/calendar-service.mjs';
import { createCaldavProvider } from '../src/calendar/caldav-provider.mjs';
import { createMcpHandlers } from '../src/mcp/handlers.mjs';
import { SqliteCalendarStore } from '../src/storage/sqlite-store.mjs';

const NOW = '2026-06-15T12:00:00.000Z';
const WINDOW_START = '2026-05-16T12:00:00.000Z';
const WINDOW_END = '2026-07-15T12:00:00.000Z';

/**
 * Build one remote event at an ISO start.
 * @param {number} index Event index.
 * @param {string} start ISO start.
 * @returns {object} Provider event.
 */
function remoteEvent(index, start) {
  const uid = `uid-${String(index).padStart(4, '0')}`;
  return {
    uid,
    etag: `etag-${index}`,
    summary: `Item ${index}`,
    start,
    end: start,
    raw: `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:Item ${index}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
  };
}

/**
 * Account store that fails if event tables are read.
 * @returns {SqliteCalendarStore} Store with an active account.
 */
function accountStore() {
  const store = new SqliteCalendarStore(':memory:');
  store.activateAccount({
    id: 'a',
    email: 'u@example.com',
    provider: 'generic',
    secretRef: 'r',
    connection: { baseUrl: 'https://cal.example.test/', calendarPath: '/home/' }
  });
  store.searchEvents = () => {
    throw new Error('sqlite_event_read');
  };
  store.getEvent = () => {
    throw new Error('sqlite_event_read');
  };
  return store;
}

/**
 * Service whose provider records each bounded query.
 * @param {object} provider CalDAV provider.
 * @param {SqliteCalendarStore} store Account store.
 * @returns {CalendarService} Service.
 */
function serviceWith(provider, store) {
  return new CalendarService({
    accountRegistry: { get: (id) => store.getAccount(id) },
    leaseBroker: {
      async acquire() { return { leaseId: 'lease-1' }; },
      async release() {}
    },
    providerFactory: async () => provider,
    now: () => new Date(NOW)
  });
}

test('event_search pages a large remote set without reading SQLite or fetching every event', async () => {
  const store = accountStore();
  store.upsertEvent({
    accountId: 'a',
    calendarId: 'https://cal.example.test/home/',
    uid: 'local-only',
    summary: 'Cached',
    raw: 'BEGIN:VEVENT\r\nUID:local-only\r\nSUMMARY:Cached\r\nEND:VEVENT\r\n',
    start: '2026-06-01T10:00:00Z',
    end: '2026-06-01T11:00:00Z'
  });
  const remote = Array.from({ length: 1000 }, (_, index) => remoteEvent(
    index,
    new Date(Date.parse('2026-06-01T00:00:00.000Z') + index * 60_000).toISOString()
  ));
  let loaded = 0;
  const provider = {
    async listCalendars() {
      return [{ url: 'https://cal.example.test/home/' }, { url: 'https://cal.example.test/other/' }];
    },
    async *fetchEvents() {
      throw new Error('unbounded_fetch');
    },
    async queryEvents({ limit, calendarId }) {
      assert.equal(calendarId, 'https://cal.example.test/home/');
      assert.equal(limit, 50);
      loaded += limit;
      return { events: remote.slice(0, limit), bounded: true, hasMore: true };
    },
    async close() {}
  };
  const handlers = createMcpHandlers({
    store,
    calendarService: serviceWith(provider, store),
    pendingApprovals: new Map()
  });
  const page = await handlers.event_search({ accountId: 'a', query: 'Item' });
  assert.equal(loaded, 50);
  assert.equal(page.items.length, 50);
  assert.equal(page.results.length, 50);
  assert.equal(page.items[0].uid, 'uid-0049');
  assert.equal(page.items[0].etag, 'etag-49');
  assert.equal(page.items[49].uid, 'uid-0000');
  assert.equal(page.hasMore, true);
  assert.equal(typeof page.nextCursor, 'string');
  assert.equal(JSON.stringify(page).includes('Cached'), false);
  assert.equal(JSON.stringify(page).includes('local-only'), false);
  store.close();
});

test('explicit calendarId queries only that calendar', async () => {
  const store = accountStore();
  const queried = [];
  let listed = false;
  const provider = {
    async listCalendars() {
      listed = true;
      return [{ url: 'https://cal.example.test/home/' }, { url: 'https://cal.example.test/other/' }];
    },
    async *fetchEvents() {
      throw new Error('unbounded_fetch');
    },
    async queryEvents({ calendarId, limit }) {
      queried.push(calendarId);
      assert.equal(limit, 50);
      return { events: [remoteEvent(1, '2026-06-02T00:00:00.000Z')], bounded: false, hasMore: false };
    },
    async close() {}
  };
  const page = await serviceWith(provider, store).searchEvents('a', {
    calendarId: 'https://cal.example.test/other/'
  });
  assert.equal(listed, false);
  assert.deepEqual(queried, ['https://cal.example.test/other/']);
  assert.equal(page.items[0].uid, 'uid-0001');
  assert.equal(page.items[0].etag, 'etag-1');
  assert.equal(page.nextCursor, null);
  store.close();
});

test('default scope is one calendar inside a fixed time window', async () => {
  const store = accountStore();
  const calls = [];
  const provider = {
    async listCalendars() {
      return [
        { url: 'https://cal.example.test/home/' },
        { url: 'https://cal.example.test/other/' }
      ];
    },
    async *fetchEvents() {
      throw new Error('unbounded_fetch');
    },
    async queryEvents(input) {
      calls.push(input);
      return { events: [], bounded: false, hasMore: false };
    },
    async close() {}
  };
  const page = await serviceWith(provider, store).searchEvents('a', {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].calendarId, 'https://cal.example.test/home/');
  assert.equal(calls[0].start, WINDOW_START);
  assert.equal(calls[0].end, WINDOW_END);
  assert.equal(calls[0].limit, 50);
  assert.equal(calls[0].sortOrder, 'desc');
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.equal(page.total, 0);
  store.close();
});

test('date order is deterministic and the page size is capped', async () => {
  const store = accountStore();
  const events = [
    remoteEvent(2, '2026-06-02T00:00:00.000Z'),
    remoteEvent(1, '2026-06-01T00:00:00.000Z'),
    remoteEvent(3, '2026-06-02T00:00:00.000Z')
  ];
  const provider = {
    async queryEvents() {
      return { events, bounded: false, hasMore: false };
    },
    async close() {}
  };
  const service = serviceWith(provider, store);
  const desc = await service.searchEvents('a', {
    calendarId: 'https://cal.example.test/home/',
    sortOrder: 'desc',
    limit: 10
  });
  assert.deepEqual(desc.items.map((item) => item.uid), ['uid-0003', 'uid-0002', 'uid-0001']);
  const asc = await service.searchEvents('a', {
    calendarId: 'https://cal.example.test/home/',
    sortOrder: 'asc',
    limit: 10
  });
  assert.deepEqual(asc.items.map((item) => item.uid), ['uid-0001', 'uid-0002', 'uid-0003']);
  await assert.rejects(
    () => service.searchEvents('a', { calendarId: 'https://cal.example.test/home/', limit: 201 }),
    /invalid_limit/
  );
  store.close();
});

test('bounded report pages with a cursor and does not repeat events', async () => {
  const store = accountStore();
  const remote = [5, 4, 3, 2, 1, 0].map((index) => remoteEvent(
    index,
    new Date(Date.parse('2026-06-01T00:00:00.000Z') + index * 86_400_000).toISOString()
  ));
  const provider = {
    async queryEvents({ start, end, limit, cursor }) {
      assert.equal(limit, 2);
      const rows = remote.filter((event) => {
        const time = Date.parse(event.start);
        return time >= Date.parse(start) && time < Date.parse(end);
      }).sort((left, right) => Date.parse(right.start) - Date.parse(left.start) || (left.uid < right.uid ? 1 : -1));
      if (cursor) assert.equal(typeof cursor, 'string');
      return { events: rows.slice(0, limit + 1), bounded: true, hasMore: rows.length > limit };
    },
    async close() {}
  };
  const service = serviceWith(provider, store);
  const seen = [];
  let cursor;
  do {
    const page = await service.searchEvents('a', {
      calendarId: 'https://cal.example.test/home/',
      start: '2026-06-01T00:00:00.000Z',
      end: '2026-06-08T00:00:00.000Z',
      limit: 2,
      sortOrder: 'desc',
      cursor
    });
    seen.push(...page.items.map((item) => item.uid));
    cursor = page.nextCursor;
    assert.equal(page.items.length <= 2, true);
  } while (cursor);
  assert.deepEqual(seen, ['uid-0005', 'uid-0004', 'uid-0003', 'uid-0002', 'uid-0001', 'uid-0000']);
  store.close();
});

test('without a bounded report, an oversized window fails closed before event bodies are fetched', async () => {
  const fetched = [];
  const provider = createCaldavProvider({
    connection: { baseUrl: 'https://cal.example.test/' },
    credentials: { username: 'u', password: 'p' },
    davFactory: async () => ({
      async calendarQuery() {
        return Array.from({ length: 1000 }, (_, index) => ({
          href: `/home/${index}.ics`,
          props: { getetag: `"${index}"` }
        }));
      },
      async fetchCalendarObjects(params) {
        fetched.push(params.objectUrls?.length ?? 1000);
        return [];
      }
    })
  });
  await assert.rejects(
    () => provider.queryEvents({
      calendarId: 'https://cal.example.test/home/',
      start: WINDOW_START,
      end: WINDOW_END,
      limit: 50,
      sortOrder: 'desc',
      query: ''
    }),
    /pagination_unavailable/
  );
  assert.deepEqual(fetched, []);
});

test('a bounded report fetches only the page and a fitting window fetches only those objects', async () => {
  const bodyFetches = [];
  const bounded = createCaldavProvider({
    connection: { baseUrl: 'https://cal.example.test/' },
    credentials: { username: 'u', password: 'p' },
    davFactory: async () => ({
      boundedReport: true,
      async calendarQuery(params) {
        assert.equal(params.limit, 3);
        return [2, 1, 0].map((index) => ({
          href: `https://cal.example.test/home/${index}.ics`,
          props: {
            getetag: `"${index}"`,
            calendarData: `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:uid-${index}\r\nSUMMARY:Item ${index}\r\nDTSTART:2026060${index + 1}T000000Z\r\nDTEND:2026060${index + 1}T010000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
          }
        }));
      },
      async fetchCalendarObjects(params) {
        bodyFetches.push(params.objectUrls ?? []);
        return [];
      }
    })
  });
  const page = await bounded.queryEvents({
    calendarId: 'https://cal.example.test/home/',
    start: WINDOW_START,
    end: WINDOW_END,
    limit: 2,
    sortOrder: 'desc',
    query: ''
  });
  assert.equal(page.bounded, true);
  assert.equal(page.events.length, 3);
  assert.equal(page.events[0].uid, 'uid-2');
  assert.equal(page.events[0].etag, '"2"');
  assert.deepEqual(bodyFetches, []);

  const smallFetches = [];
  const fitting = createCaldavProvider({
    connection: { baseUrl: 'https://cal.example.test/' },
    credentials: { username: 'u', password: 'p' },
    davFactory: async () => ({
      async calendarQuery() {
        return [{ href: '/home/a.ics', props: { getetag: '"a"' } }];
      },
      async fetchCalendarObjects(params) {
        smallFetches.push(params.objectUrls);
        return [{
          url: 'https://cal.example.test/home/a.ics',
          etag: '"a"',
          data: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:uid-a\r\nSUMMARY:Only\r\nDTSTART:20260602T000000Z\r\nDTEND:20260602T010000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
        }];
      }
    })
  });
  const fitted = await fitting.queryEvents({
    calendarId: 'https://cal.example.test/home/',
    start: WINDOW_START,
    end: WINDOW_END,
    limit: 50,
    sortOrder: 'asc',
    query: ''
  });
  assert.equal(fitted.bounded, false);
  assert.equal(fitted.hasMore, false);
  assert.deepEqual(smallFetches, [['/home/a.ics']]);
  assert.equal(fitted.events[0].uid, 'uid-a');
  assert.equal(fitted.events[0].etag, '"a"');
});
