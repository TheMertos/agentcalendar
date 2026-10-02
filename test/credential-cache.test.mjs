import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CALDAV_SYNC_FIELDS } from '../src/calendar/calendar-service.mjs';
import { loadConfig } from '../src/config.mjs';
import { createCredentialCacheHandlers } from '../src/mcp/credential-cache-tools.mjs';
import { createCalendarRuntime } from '../src/runtime/calendar-runtime.mjs';
import { createCredentialCache } from '../src/security/credential-cache.mjs';
import { createCredentialSync, mapCalendarCredentials } from '../src/security/credential-sync.mjs';

const RESOURCE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PURPOSE = 'caldav-sync';

/**
 * Create a random cache key and a random credential pair.
 * @returns {{ key: string, username: string, password: string }}
 */
function secretMaterial() {
  return {
    key: randomBytes(32).toString('hex'),
    username: randomBytes(24).toString('hex'),
    password: randomBytes(32).toString('hex')
  };
}

/**
 * Serialize every stored value, including blobs, for leakage checks.
 * @param {import('better-sqlite3').Database} db Open database.
 * @returns {string}
 */
function databaseText(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const chunks = [];
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM ${table.name}`).all();
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (Buffer.isBuffer(value)) chunks.push(value.toString('utf8'), value.toString('hex'));
        else if (value != null) chunks.push(String(value));
      }
    }
  }
  return chunks.join('\n');
}

/**
 * Build a resolve payload.
 * @param {number} version Resource version.
 * @param {string} username Username.
 * @param {string} password Password.
 * @returns {object}
 */
function resolved(version, username, password) {
  return {
    requestId: 'req',
    resourceId: RESOURCE_ID,
    version,
    expiresInSeconds: 300,
    fields: { 'auth.username': username, 'auth.password': password }
  };
}

test('encrypted cache persists and a wrong key fails closed', () => {
  const { key, username, password } = secretMaterial();
  const otherKey = randomBytes(32).toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'agentcal-cache-'));
  const filename = join(dir, 'cache.db');
  try {
    const first = new Database(filename);
    const cache = createCredentialCache(first, key);
    const status = cache.put({
      accountId: 'a',
      purpose: PURPOSE,
      resourceId: RESOURCE_ID,
      version: 1,
      credentials: { username, password },
      freshUntil: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(status.status, 'current');
    assert.equal(JSON.stringify(status).includes(password), false);
    assert.equal(databaseText(first).includes(password), false);
    assert.equal(databaseText(first).includes(username), false);
    first.close();

    const second = new Database(filename);
    const reopened = createCredentialCache(second, key);
    assert.deepEqual(reopened.read('a', PURPOSE), { username, password });
    assert.throws(() => createCredentialCache(second, otherKey).read('a', PURPOSE), /credential_cache_decrypt_failed/);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcile updates a new version and invalidates a deleted resource', async () => {
  const { key, username, password } = secretMaterial();
  const nextPassword = randomBytes(32).toString('hex');
  const db = new Database(':memory:');
  const cache = createCredentialCache(db, key);
  let version = 1;
  let deleted = false;
  const resolveResource = async (request) => {
    assert.equal(request.purpose, PURPOSE);
    assert.deepEqual(request.fieldPaths, CALDAV_SYNC_FIELDS);
    if (deleted) {
      const error = new Error('resource_not_found');
      error.code = 'resource_not_found';
      error.status = 404;
      throw error;
    }
    return resolved(version, username, version === 1 ? password : nextPassword);
  };
  const sync = createCredentialSync({ cache, resolveResource, mapFields: mapCalendarCredentials });
  const account = { id: 'a', secretRef: RESOURCE_ID };
  const created = await sync.reconcile({ account, purpose: PURPOSE, fieldPaths: CALDAV_SYNC_FIELDS });
  assert.equal(created.status, 'current');
  assert.equal(JSON.stringify(created).includes(password), false);
  version = 2;
  const updated = await sync.reconcile({ account, purpose: PURPOSE, fieldPaths: CALDAV_SYNC_FIELDS });
  assert.equal(updated.version, 2);
  assert.deepEqual(sync.readForProvider('a', PURPOSE), { username, password: nextPassword });
  assert.equal(databaseText(db).includes(password), false);
  assert.equal(databaseText(db).includes(nextPassword), false);
  deleted = true;
  const removed = await sync.reconcile({ account, purpose: PURPOSE, fieldPaths: CALDAV_SYNC_FIELDS });
  assert.equal(removed.status, 'invalidated');
  assert.equal(removed.reason, 'deleted');
  assert.throws(() => sync.readForProvider('a', PURPOSE), /credential_cache_unavailable/);
  assert.equal(db.prepare('SELECT ciphertext FROM credential_cache').get().ciphertext, null);
  assert.equal(databaseText(db).includes(nextPassword), false);
  db.close();
});

test('deleted and failed resolves do not open the provider', async () => {
  const { key, username, password } = secretMaterial();
  const dir = mkdtempSync(join(tmpdir(), 'agentcal-runtime-'));
  const calls = [];
  let mode = 'ok';
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (mode === 'delete') return { ok: false, status: 404, json: async () => ({ error: 'resource_not_found' }) };
    if (mode === 'fail') return { ok: false, status: 403, json: async () => ({ error: 'purpose_not_allowed' }) };
    return { ok: true, json: async () => resolved(1, username, password) };
  };
  const runtime = createCalendarRuntime({
    dbPath: join(dir, 'calendar.db'),
    principal: 'mert',
    secretFabricUrl: 'http://127.0.0.1:9',
    secretFabricApiToken: 'tok',
    credentialCacheKey: key
  }, {
    fetchImpl,
    providerFactory() {
      throw new Error('provider_should_not_open');
    }
  });
  try {
    runtime.store.activateAccount({
      id: 'a',
      email: 'a@example.test',
      provider: 'caldav',
      secretRef: RESOURCE_ID,
      connection: { baseUrl: 'https://caldav.example.test/' }
    });
    const handlers = createCredentialCacheHandlers({
      store: runtime.store,
      credentialSync: runtime.credentialSync
    });
    const inactive = await handlers.credentialCacheStatus({ accountId: 'missing' });
    assert.deepEqual(inactive, { error: 'account_not_active' });
    const status = await handlers.credentialCacheReconcile({ accountId: 'a' });
    assert.equal(JSON.stringify(status).includes(password), false);
    assert.equal(JSON.stringify(status).includes(username), false);
    assert.equal(status.entries[0].status, 'current');
    mode = 'delete';
    await assert.rejects(() => runtime.calendarService.listCalendars('a'), /credential_cache_unavailable/);
    mode = 'fail';
    await assert.rejects(() => runtime.calendarService.listCalendars('a'), /credential_cache_unavailable/);
    assert.equal(calls.every((call) => call.url === 'http://127.0.0.1:9/api/resolve'), true);
    assert.equal(calls.every((call) => call.body.purpose === 'caldav-sync'), true);
    assert.equal(databaseText(runtime.store.db).includes(password), false);
    const cache = createCredentialCache(runtime.store.db, key);
    cache.put({
      accountId: 'a',
      purpose: PURPOSE,
      resourceId: RESOURCE_ID,
      version: 1,
      credentials: { username, password },
      freshUntil: new Date(Date.now() - 1000).toISOString()
    });
    assert.throws(() => cache.read('a', PURPOSE), /credential_cache_stale/);
  } finally {
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cache key is required and rejected when missing or malformed', () => {
  const base = {
    AGENTCAL_DB_PATH: '/data/agentcalendar.db',
    AGENTCAL_SYNC_INTERVAL_SECONDS: '300',
    AGENTCAL_LOG_LEVEL: 'info',
    AGENTCAL_TRANSPORT: 'stdio',
    AGENTCAL_PRINCIPAL: 'mert',
    SECRET_FABRIC_PRINCIPAL: 'mert',
    SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
    SECRET_FABRIC_API_TOKEN: 'tok'
  };
  assert.throws(() => loadConfig(base), /CREDENTIAL_CACHE_KEY/);
  assert.throws(() => loadConfig({ ...base, CREDENTIAL_CACHE_KEY: 'short' }), /CREDENTIAL_CACHE_KEY/);
});

test('runtime requires the cache key and does not resolve credentials directly', () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: false, status: 500, json: async () => ({ error: 'unexpected' }) };
  };
  assert.throws(() => createCalendarRuntime({
    dbPath: join(tmpdir(), 'agentcal-missing-key.db'),
    principal: 'mert',
    secretFabricUrl: 'http://127.0.0.1:9',
    secretFabricApiToken: 'tok'
  }, { fetchImpl }), /CREDENTIAL_CACHE_KEY/);
  assert.equal(called, false);
});
