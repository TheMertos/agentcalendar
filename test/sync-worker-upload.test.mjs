import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncWorker } from '../src/calendar/sync-worker.mjs';

test('worker skips upload phase when autoUpload is false', async () => {
  const uploadCalls = [];
  const worker = new SyncWorker({
    accounts: { list: () => [{ id: 'a', enabled: true }] },
    sync: async () => {},
    upload: async (accountId) => {
      uploadCalls.push(accountId);
    },
    policy: { shouldAutoUpload: () => false }
  });
  await worker.runOnce();
  assert.deepEqual(uploadCalls, []);
});

test('worker runs upload after sync when autoUpload enabled for account', async () => {
  const order = [];
  const worker = new SyncWorker({
    accounts: { list: () => [{ id: 'a', enabled: true }] },
    sync: async (id) => { order.push(`sync:${id}`); },
    upload: async (id) => { order.push(`upload:${id}`); },
    policy: { shouldAutoUpload: (accountId) => accountId === 'a' }
  });
  await worker.runOnce();
  assert.deepEqual(order, ['sync:a', 'upload:a']);
});
