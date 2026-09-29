import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadDirtyEvent } from '../src/calendar/upload-service.mjs';
import { buildVeventIcal } from '../src/calendar/ical.mjs';
import { SqliteCalendarStore } from '../src/storage/sqlite-store.mjs';

function makeStoreWithDirty({ icalBody, etag = 'etag-old' }) {
  const store = new SqliteCalendarStore(':memory:');
  store.upsertEvent({
    accountId: 'a',
    calendarId: 'cal',
    uid: 'u1',
    etag,
    summary: 'Local',
    raw: icalBody,
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z'
  });
  store.enqueueDirtyEvent({
    accountId: 'a',
    calendarId: 'cal',
    uid: 'u1',
    expectedEtag: etag,
    icalBody
  });
  return store;
}

test('uploadDirtyEvent succeeds with If-Match and clears queue', async () => {
  const icalBody = buildVeventIcal({ uid: 'u1', summary: 'Up', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' });
  const store = makeStoreWithDirty({ icalBody });
  let ifMatch = null;
  const provider = {
    async putEvent({ etag }) {
      ifMatch = etag;
      return { etag: 'etag-new' };
    },
    async getEvent() {
      return { uid: 'u1', etag: 'etag-new', raw: icalBody };
    }
  };
  const entry = store.listDirtyEvents('a')[0];
  const result = await uploadDirtyEvent({ provider, store, entry });
  assert.equal(result.status, 'uploaded');
  assert.equal(ifMatch, 'etag-old');
  assert.equal(store.listDirtyEvents('a', { status: 'pending' }).length, 0);
  assert.equal(store.getEvent('a', 'cal', 'u1').etag, 'etag-new');
  store.close();
});

test('uploadDirtyEvent records conflict on etag precondition failure', async () => {
  const icalBody = buildVeventIcal({ uid: 'u1', summary: 'Up', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' });
  const store = makeStoreWithDirty({ icalBody });
  const provider = {
    async putEvent() {
      const err = new Error('precondition_failed');
      err.code = 'precondition_failed';
      err.status = 412;
      throw err;
    },
    async getEvent() {
      return { uid: 'u1', etag: 'remote-other', raw: icalBody };
    }
  };
  const entry = store.listDirtyEvents('a')[0];
  const result = await uploadDirtyEvent({ provider, store, entry });
  assert.equal(result.status, 'conflict');
  assert.equal(store.listConflicts('a').length, 1);
  assert.equal(store.listDirtyEvents('a', { status: 'conflict' }).length, 1);
  store.close();
});

test('uploadDirtyEvent retries transient failures with bounded backoff', async () => {
  const icalBody = buildVeventIcal({ uid: 'u1', summary: 'Up', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' });
  const store = makeStoreWithDirty({ icalBody });
  let attempts = 0;
  const provider = {
    async putEvent() {
      attempts += 1;
      if (attempts < 2) {
        const err = new Error('network');
        err.code = 'transient';
        throw err;
      }
      return { etag: 'etag-new' };
    },
    async getEvent() {
      return { uid: 'u1', etag: 'etag-new', raw: icalBody };
    }
  };
  const entry = store.listDirtyEvents('a')[0];
  const result = await uploadDirtyEvent({ provider, store, entry, maxAttempts: 3 });
  assert.equal(result.status, 'uploaded');
  assert.equal(attempts, 2);
  store.close();
});
