import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('runtime configuration is mandatory', () => {
  assert.throws(() => loadConfig({}), /AGENTCAL_DB_PATH/);
});

const CACHE_KEY = 'ab'.repeat(32);

test('runtime configuration validates values', () => {
  const env = {
    AGENTCAL_DB_PATH: '/data/agentcalendar.db',
    AGENTCAL_SYNC_INTERVAL_SECONDS: '300',
    AGENTCAL_LOG_LEVEL: 'info',
    AGENTCAL_TRANSPORT: 'stdio',
    AGENTCAL_PRINCIPAL: 'mert',
    SECRET_FABRIC_PRINCIPAL: 'mert',
    SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
    SECRET_FABRIC_API_TOKEN: 'tok',
    CREDENTIAL_CACHE_KEY: CACHE_KEY
  };
  const config = loadConfig(env);
  assert.deepEqual(config, {
    dbPath: '/data/agentcalendar.db',
    syncIntervalSeconds: 300,
    logLevel: 'info',
    transport: 'stdio',
    principal: 'mert',
    secretFabricPrincipal: 'mert',
    secretFabricUrl: 'http://127.0.0.1:3000',
    secretFabricApiToken: 'tok',
    serviceMode: 'native',
    credentialCacheKey: CACHE_KEY
  });
  const { CREDENTIAL_CACHE_KEY: _key, ...withoutKey } = env;
  assert.throws(() => loadConfig(withoutKey), /CREDENTIAL_CACHE_KEY/);
  assert.throws(() => loadConfig({ ...env, CREDENTIAL_CACHE_KEY: 'short' }), /CREDENTIAL_CACHE_KEY/);
});
