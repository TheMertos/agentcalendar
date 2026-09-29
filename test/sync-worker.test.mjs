import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncWorker } from '../src/calendar/sync-worker.mjs';

test('worker syncs every enabled account once and prevents overlap', async () => {
  const calls = [];
  const worker = new SyncWorker({
    accounts: { list: () => [{ id: 'a', enabled: true }, { id: 'b', enabled: true }] },
    sync: async (id) => { calls.push(id); }
  });
  await Promise.all([worker.runOnce(), worker.runOnce()]);
  assert.deepEqual(calls.sort(), ['a', 'b']);
});
