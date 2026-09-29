import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaldavProvider } from '../src/calendar/caldav-provider.mjs';

test('createCaldavProvider requires baseUrl and credentials', () => {
  assert.throws(() => createCaldavProvider({ connection: {}, credentials: {} }), /baseUrl/);
  assert.throws(
    () => createCaldavProvider({ connection: { baseUrl: 'https://x/' }, credentials: { username: 'u' } }),
    /password/
  );
});

test('createCaldavProvider maps listCalendars from injected dav client', async () => {
  const provider = createCaldavProvider({
    connection: { baseUrl: 'https://caldav.example/' },
    credentials: { username: 'u', password: 'p' },
    davFactory: async () => ({
      fetchCalendars: async () => [{ url: 'https://caldav.example/cal/personal/', displayName: 'Personal', syncToken: 'ctag-1' }],
      fetchCalendarObjects: async () => []
    })
  });
  const calendars = await provider.listCalendars();
  assert.equal(calendars.length, 1);
  assert.equal(calendars[0].displayName, 'Personal');
  assert.equal(calendars[0].ctag, 'ctag-1');
});
