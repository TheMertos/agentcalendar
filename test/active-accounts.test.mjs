import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCalendarStore } from '../src/storage/sqlite-store.mjs';

test('active account list persists activation and excludes inactive accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentcal-accounts-'));
  const store = new SqliteCalendarStore(join(dir, 'cal.db'));
  store.activateAccount({
    id: 'work',
    email: 'user@example.com',
    provider: 'mailbox.org',
    secretRef: 'resource-work',
    connection: { baseUrl: 'https://caldav.mailbox.org/', calendarPath: '/calendars/user/' }
  });
  store.activateAccount({
    id: 'personal',
    email: 'personal@example.com',
    provider: 'icloud',
    secretRef: 'resource-personal',
    connection: { baseUrl: 'https://caldav.icloud.com/' }
  });
  assert.deepEqual(store.listActiveAccounts().map((account) => account.id), ['personal', 'work']);
  store.deactivateAccount('work');
  assert.deepEqual(store.listActiveAccounts().map((account) => account.id), ['personal']);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
