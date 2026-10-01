import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('runtime configuration is mandatory', () => {
  assert.throws(() => loadConfig({}), /AGENTCAL_DB_PATH/);
});

test('runtime configuration validates values', () => {
  const config = loadConfig({
    AGENTCAL_DB_PATH: '/data/agentcalendar.db',
    AGENTCAL_SYNC_INTERVAL_SECONDS: '300',
    AGENTCAL_LOG_LEVEL: 'info',
    AGENTCAL_TRANSPORT: 'stdio',
    AGENTCAL_PRINCIPAL: 'mert',
    SECRET_FABRIC_PRINCIPAL: 'mert',
    SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
    SECRET_FABRIC_API_TOKEN: 'tok'
  });
  assert.deepEqual(config, {
    dbPath: '/data/agentcalendar.db',
    syncIntervalSeconds: 300,
    logLevel: 'info',
    transport: 'stdio',
    principal: 'mert',
    secretFabricPrincipal: 'mert',
    secretFabricUrl: 'http://127.0.0.1:3000',
    secretFabricApiToken: 'tok',
    serviceMode: 'docker'
  });
});
