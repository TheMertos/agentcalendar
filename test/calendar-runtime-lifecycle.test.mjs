import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteCalendarStore } from '../src/storage/sqlite-store.mjs';
import { startDurableSyncWorker } from '../src/worker/durable-sync.mjs';
import { createCalendarRuntime } from '../src/runtime/calendar-runtime.mjs';
import { buildVeventIcal } from '../src/calendar/ical.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('native unit and launcher run MCP and do not start a calendar worker', () => {
  const unit = readFileSync(join(repoRoot, 'deploy/systemd/user/agentcalendar@.service'), 'utf8');
  const launcher = readFileSync(join(repoRoot, 'tools/agentcalendar-native-mcp.sh'), 'utf8');
  const source = `${unit}\n${launcher}`;
  assert.match(unit, /agentcalendar-native-mcp\.sh --service %i/);
  assert.match(launcher, /src\/mcp\/server\.mjs/);
  assert.doesNotMatch(source, /agentcalendar-worker|calendar-runtime-worker|docker/);
  assert.match(unit, /AGENTCAL_SERVICE_MODE=native/);
  assert.match(unit, /AGENTCAL_NATIVE_HOLD=1/);
});

test('MCP server does not start a sync worker', () => {
  const server = readFileSync(join(repoRoot, 'src/mcp/server.mjs'), 'utf8');
  const handlers = readFileSync(join(repoRoot, 'src/mcp/handlers.mjs'), 'utf8');
  const runtime = readFileSync(join(repoRoot, 'src/runtime/calendar-runtime.mjs'), 'utf8');
  const entrypoint = readFileSync(join(repoRoot, 'src/worker/calendar-runtime-worker.mjs'), 'utf8');
  const durable = readFileSync(join(repoRoot, 'src/worker/durable-sync.mjs'), 'utf8');
  assert.doesNotMatch(server, /SyncWorker|syncWorker|startDurableSyncWorker|calendar-runtime-worker/);
  assert.match(server, /createCalendarRuntime/);
  assert.doesNotMatch(server, /syncAccount\(/);
  assert.match(server, /Does not start, enqueue, or wait for a sync/);
  assert.doesNotMatch(handlers, /syncAccount|uploadDirtyEvents|searchEvents\(store|getEventByKey/);
  assert.doesNotMatch(runtime, /SyncWorker|startDurableSyncWorker|setInterval/);
  assert.match(entrypoint, /remote_only_sync_disabled/);
  assert.doesNotMatch(entrypoint, /startDurableSyncWorker\(|createCalendarRuntime/);
  assert.doesNotMatch(entrypoint, /McpServer|StdioServerTransport/);
  assert.doesNotMatch(durable, /calendarService\.syncAccount|uploadDirtyEvents|setInterval/);
  assert.match(durable, /syncEnabled: false/);
});

test('sqlite store uses WAL and a busy timeout for a shared database file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentcal-sqlite-share-'));
  const dbPath = join(dir, 'cal.db');
  const writer = new SqliteCalendarStore(dbPath);
  const reader = new SqliteCalendarStore(dbPath);
  try {
    assert.equal(writer.db.pragma('busy_timeout', { simple: true }), 5000);
    assert.equal(String(writer.db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
    writer.activateAccount({
      id: 'a',
      email: 'a@example.test',
      provider: 'generic',
      secretRef: 'sf-ref',
      connection: { baseUrl: 'https://caldav.example.test/' }
    });
    assert.equal(reader.getAccount('a').secretRef, 'sf-ref');
  } finally {
    writer.close();
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('durable sync worker does not run an initial sync cycle', async () => {
  const syncCalls = [];
  const { stop } = startDurableSyncWorker({
    config: { syncIntervalSeconds: 3600 },
    accounts: {
      list: () => [{ id: 'a', enabled: true }],
      get: (id) => (id === 'a' ? { id: 'a', enabled: true } : undefined)
    },
    policy: { shouldAutoUpload: () => false },
    calendarService: {
      syncAccount: async (accountId, opts) => {
        syncCalls.push({ accountId, mode: opts.mode });
        return { accountId };
      },
      uploadDirtyEvents: async () => []
    },
    store: {}
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(syncCalls.length, 0);
  } finally {
    stop();
  }
});

test('worker interval does not sync or auto-upload', async () => {
  const calls = [];
  const { stop } = startDurableSyncWorker({
    config: { syncIntervalSeconds: 0.05 },
    accounts: {
      list: () => [{ id: 'a', enabled: true }],
      get: (id) => (id === 'a' ? { id: 'a', enabled: true } : undefined)
    },
    policy: { shouldAutoUpload: () => true },
    calendarService: {
      syncAccount: async (accountId) => {
        calls.push(`sync:${accountId}`);
        return { accountId };
      },
      uploadDirtyEvents: async (accountId) => {
        calls.push(`upload:${accountId}`);
        return [];
      }
    },
    store: {}
  });

  let poll;
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(calls, []);
  } finally {
    clearInterval(poll);
    stop();
  }
});

test('worker does not sync an account missing from the active registry', async () => {
  const calls = [];
  const { stop } = startDurableSyncWorker({
    config: { syncIntervalSeconds: 3600 },
    accounts: {
      list: () => [{ id: 'gone', enabled: true }],
      get: () => undefined
    },
    policy: { shouldAutoUpload: () => true },
    calendarService: {
      syncAccount: async (accountId) => {
        calls.push(accountId);
      },
      uploadDirtyEvents: async (accountId) => {
        calls.push(accountId);
      }
    },
    store: {}
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, []);
  } finally {
    stop();
  }
});

test('disabled worker does not sync or upload through SecretFabric', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentcal-worker-runtime-'));
  const dbPath = join(dir, 'cal.db');
  const fetches = [];
  const providerCalls = [];
  const puts = [];
  const icalBody = buildVeventIcal({
    uid: 'u1',
    summary: 'Local change',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z'
  });

  /**
   * @param {string} url Request URL.
   * @param {{ headers?: Record<string, string>, body?: string }} init Fetch init.
   * @returns {Promise<{ ok: boolean, status: number, json: () => Promise<object> }>}
   */
  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    fetches.push({
      url,
      authorization: init.headers.authorization,
      resourceId: body.resourceId,
      purpose: body.purpose,
      fieldPaths: body.fieldPaths
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          fields: {
            'auth.username': 'cal-user',
            'auth.password': 'cal-secret',
            'server.baseUrl': 'https://caldav.example.test/'
          }
        };
      }
    };
  }

  /**
   * @param {{ account: { id: string, secretRef: string }, lease: { credentials?: { username?: string } } }} input Provider input.
   * @returns {Promise<object>} Fake CalDAV provider.
   */
  async function providerFactory({ account, lease }) {
    providerCalls.push({
      accountId: account.id,
      secretRef: account.secretRef,
      username: lease.credentials?.username ?? null
    });
    return {
      async listCalendars() {
        return [{ id: 'cal-1', ctag: 'c1', displayName: 'Home' }];
      },
      async *fetchEvents() {
        yield {
          uid: 'remote-1',
          summary: 'Remote',
          etag: 'e-remote',
          raw: 'BEGIN:VEVENT\nUID:remote-1\nSUMMARY:Remote\nEND:VEVENT'
        };
      },
      async putEvent() {
        puts.push('u1');
        return { etag: 'etag-new' };
      },
      async getEvent() {
        return { uid: 'u1', etag: 'etag-new', raw: icalBody };
      },
      async close() {}
    };
  }

  const runtime = createCalendarRuntime({
    dbPath,
    syncIntervalSeconds: 3600,
    logLevel: 'info',
    transport: 'stdio',
    secretFabricUrl: 'http://secretfabric.test',
    secretFabricApiToken: 'test-token',
    principal: 'mert'
  }, { fetchImpl, providerFactory });
  let stop = () => {};
  try {
    runtime.store.activateAccount({
      id: 'a',
      email: 'a@example.test',
      provider: 'caldav',
      secretRef: 'sf-ref',
      connection: { baseUrl: 'https://caldav.example.test/' }
    });
    runtime.store.setSyncPolicy('a', 'cal-1', { autoUpload: true });
    runtime.store.upsertEvent({
      accountId: 'a',
      calendarId: 'cal-1',
      uid: 'u1',
      etag: 'etag-old',
      summary: 'Old',
      raw: icalBody,
      start: '2026-01-01T10:00:00Z',
      end: '2026-01-01T11:00:00Z'
    });
    runtime.store.enqueueDirtyEvent({
      accountId: 'a',
      calendarId: 'cal-1',
      uid: 'u1',
      expectedEtag: 'etag-old',
      icalBody
    });
    assert.equal(fetches.length, 0);
    assert.equal(runtime.store.getEvent('a', 'cal-1', 'remote-1'), null);

    ({ stop } = startDurableSyncWorker({
      config: runtime.config,
      accounts: {
        list: () => runtime.store.listActiveAccounts(),
        get: (accountId) => runtime.store.getAccount(accountId)
      },
      policy: {
        shouldAutoUpload(accountId) {
          return runtime.store.listSyncPolicies(accountId).some((row) => row.autoUpload);
        }
      },
      calendarService: runtime.calendarService,
      store: runtime.store
    }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(puts.length, 0);
    assert.equal(runtime.store.getEvent('a', 'cal-1', 'remote-1'), null);
    assert.equal(runtime.store.listDirtyEvents('a', { status: 'pending' }).length, 1);
    assert.equal(runtime.store.getEvent('a', 'cal-1', 'u1').etag, 'etag-old');
    assert.equal(fetches.length, 0);
    assert.equal(providerCalls.length, 0);
    assert.equal(JSON.stringify(runtime.store.listCheckpoints('a')).includes('cal-secret'), false);
  } finally {
    stop();
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
