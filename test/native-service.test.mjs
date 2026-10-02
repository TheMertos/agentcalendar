import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { assertNativeService } from '../src/runtime/native-service.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const wrapperPath = join(repoRoot, 'tools', 'hermes-agentcalendar-mcp.sh');
const nativePath = join(repoRoot, 'tools', 'agentcalendar-native-mcp.sh');
const unitPath = join(repoRoot, 'deploy', 'systemd', 'user', 'agentcalendar@.service');

const BASE_ENV = {
  AGENTCAL_DB_PATH: '/data/agentcalendar.db',
  AGENTCAL_SYNC_INTERVAL_SECONDS: '300',
  AGENTCAL_LOG_LEVEL: 'info',
  AGENTCAL_TRANSPORT: 'stdio',
  AGENTCAL_PROFILE: 'mert',
  AGENTCAL_PRINCIPAL: 'mert',
  SECRET_FABRIC_PRINCIPAL: 'mert',
  SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
  SECRET_FABRIC_API_TOKEN: 'tok',
  CREDENTIAL_CACHE_KEY: 'ab'.repeat(32),
  AGENTCAL_SERVICE_MODE: 'native'
};

/**
 * Run a shell entrypoint.
 * @param {string} script Script path.
 * @param {{ args?: string[], hermesHome?: string, env?: Record<string, string>, pathPrefix?: string }} options
 */
function runScript(script, { args = [], hermesHome, env = {}, pathPrefix = '' } = {}) {
  const merged = {
    ...process.env,
    PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH,
    ...env
  };
  delete merged.HERMES_INSTANCE_NAME;
  delete merged.AGENTCAL_NATIVE_HOLD;
  if (hermesHome !== undefined) merged.HERMES_HOME = hermesHome;
  else delete merged.HERMES_HOME;
  return spawnSync('bash', [script, ...args], { env: merged, encoding: 'utf8' });
}

/**
 * Fake node that records the native launch environment.
 * @returns {{ binDir: string, logPath: string }}
 */
function fakeNode() {
  const binDir = mkdtempSync(join(tmpdir(), 'agentcal-fake-node-'));
  const logPath = join(binDir, 'node.log');
  const fake = join(binDir, 'node');
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
{
  printf 'argv:%s\\n' "$*"
  printf 'mode:%s\\n' "\${AGENTCAL_SERVICE_MODE:-}"
  printf 'profile:%s\\n' "\${AGENTCAL_PROFILE:-}"
  printf 'principal:%s\\n' "\${AGENTCAL_PRINCIPAL:-}"
  printf 'sf:%s\\n' "\${SECRET_FABRIC_PRINCIPAL:-}"
  printf 'db:%s\\n' "\${AGENTCAL_DB_PATH:-}"
  printf 'hold:%s\\n' "\${AGENTCAL_NATIVE_HOLD:-}"
  printf 'url:%s\\n' "\${SECRET_FABRIC_URL:-}"
} > "${logPath}"
exit 0
`
  );
  chmodSync(fake, 0o755);
  return { binDir, logPath };
}

test('service mode accepts only native', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, AGENTCAL_SERVICE_MODE: 'docker' }), /AGENTCAL_SERVICE_MODE must be native/);
  assert.equal(loadConfig(BASE_ENV).serviceMode, 'native');
});

test('native service mode requires a matching profile', () => {
  assert.throws(() => assertNativeService({ ...BASE_ENV, AGENTCAL_PROFILE: 'other' }), /AGENTCAL_PROFILE/);
  const config = assertNativeService(BASE_ENV);
  assert.equal(config.serviceMode, 'native');
  assert.equal(config.principal, 'mert');
  assert.equal(config.secretFabricPrincipal, 'mert');
});

test('native service files do not start a calendar sync worker', () => {
  const source = [
    readFileSync(join(repoRoot, 'src/runtime/native-service.mjs'), 'utf8'),
    readFileSync(nativePath, 'utf8'),
    readFileSync(unitPath, 'utf8')
  ].join('\n');
  assert.doesNotMatch(source, /calendar-runtime-worker|startDurableSyncWorker/);
  assert.match(readFileSync(unitPath, 'utf8'), /AGENTCAL_NATIVE_HOLD=1/);
});

test('hermes wrapper runs node with the derived principal and fails closed without secrets', () => {
  const { binDir, logPath } = fakeNode();
  const emptyHome = mkdtempSync(join(tmpdir(), 'agentcal-no-env-'));
  const missing = runScript(wrapperPath, {
    hermesHome: '/home/user/.hermes/profiles/mert',
    pathPrefix: binDir,
    env: { HOME: emptyHome, SECRET_FABRIC_URL: '', SECRET_FABRIC_API_TOKEN: '' }
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SECRET_FABRIC_URL/);
  assert.doesNotMatch(missing.stderr, /tok/);

  const home = mkdtempSync(join(tmpdir(), 'agentcal-home-'));
  const result = runScript(wrapperPath, {
    hermesHome: '/home/user/.hermes',
    pathPrefix: binDir,
    env: {
      HOME: home,
      SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
      SECRET_FABRIC_API_TOKEN: 'tok'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(logPath, 'utf8');
  assert.match(log, /argv:src\/mcp\/server\.mjs/);
  assert.match(log, /mode:native/);
  assert.match(log, /principal:default/);
  assert.match(log, /sf:default/);
  assert.match(log, new RegExp(`db:${home}/.local/share/agentcalendar/default/agentcalendar.db`));
  assert.match(log, /hold:$/m);
});

test('hermes wrapper loads a profile SecretFabric env file without printing or overriding secrets', () => {
  const { binDir, logPath } = fakeNode();
  const home = mkdtempSync(join(tmpdir(), 'agentcal-profile-env-'));
  const configDir = join(home, '.config', 'agentcalendar');
  mkdirSync(configDir, { recursive: true });
  const fileToken = 'file-secret-token';
  writeFileSync(
    join(configDir, 'mert.env'),
    `SECRET_FABRIC_URL=http://file.example\nSECRET_FABRIC_API_TOKEN=${fileToken}\n`
  );
  const loaded = runScript(wrapperPath, {
    hermesHome: '/home/user/.hermes/profiles/mert',
    pathPrefix: binDir,
    env: { HOME: home, SECRET_FABRIC_URL: '', SECRET_FABRIC_API_TOKEN: '' }
  });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.match(readFileSync(logPath, 'utf8'), /url:http:\/\/file\.example/);
  assert.doesNotMatch(`${loaded.stdout}${loaded.stderr}`, new RegExp(fileToken));

  const inherited = runScript(wrapperPath, {
    hermesHome: '/home/user/.hermes/profiles/mert',
    pathPrefix: binDir,
    env: {
      HOME: home,
      SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
      SECRET_FABRIC_API_TOKEN: 'inherited-token'
    }
  });
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.match(readFileSync(logPath, 'utf8'), /url:http:\/\/127\.0\.0\.1:3000/);
  assert.doesNotMatch(`${inherited.stdout}${inherited.stderr}`, new RegExp(fileToken));

  const xdgHome = mkdtempSync(join(tmpdir(), 'agentcal-xdg-home-'));
  const xdg = mkdtempSync(join(tmpdir(), 'agentcal-xdg-config-'));
  mkdirSync(join(xdg, 'agentcalendar'), { recursive: true });
  writeFileSync(
    join(xdg, 'agentcalendar', 'mert.env'),
    'SECRET_FABRIC_URL=http://xdg.example\nSECRET_FABRIC_API_TOKEN=xdg-token\n'
  );
  const fromXdg = runScript(wrapperPath, {
    hermesHome: '/home/user/.hermes/profiles/mert',
    pathPrefix: binDir,
    env: {
      HOME: xdgHome,
      XDG_CONFIG_HOME: xdg,
      SECRET_FABRIC_URL: '',
      SECRET_FABRIC_API_TOKEN: ''
    }
  });
  assert.equal(fromXdg.status, 0, fromXdg.stderr);
  assert.match(readFileSync(logPath, 'utf8'), /url:http:\/\/xdg\.example/);
  assert.doesNotMatch(`${fromXdg.stdout}${fromXdg.stderr}`, /xdg-token/);
});

/**
 * Install a fake node that records its launch line.
 * @param {string} binDir Directory that receives the node executable.
 * @param {string} logPath File that receives the launch record.
 */
function installFakeNode(binDir, logPath) {
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, 'node');
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
printf 'argv:%s\\n' "$*" > "${logPath}"
exit 0
`
  );
  chmodSync(fake, 0o755);
}

test('native launcher finds node when PATH is the systemd user default', () => {
  const unit = readFileSync(unitPath, 'utf8');
  assert.match(unit, /Environment=PATH=%h\/\.local\/bin:%h\/\.hermes\/node\/bin:/);

  const home = mkdtempSync(join(tmpdir(), 'agentcal-systemd-node-'));
  const logPath = join(home, 'node.log');
  installFakeNode(join(home, '.hermes', 'node', 'bin'), logPath);
  const systemdPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const fromHermes = runScript(nativePath, {
    args: ['--service', 'default'],
    env: {
      HOME: home,
      PATH: systemdPath,
      SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
      SECRET_FABRIC_API_TOKEN: 'tok'
    }
  });
  assert.equal(fromHermes.status, 0, fromHermes.stderr);
  assert.match(readFileSync(logPath, 'utf8'), /argv:src\/mcp\/server\.mjs/);

  const localHome = mkdtempSync(join(tmpdir(), 'agentcal-systemd-local-node-'));
  const localLog = join(localHome, 'node.log');
  installFakeNode(join(localHome, '.local', 'bin'), localLog);
  const fromLocal = runScript(nativePath, {
    args: ['--service', 'default'],
    env: {
      HOME: localHome,
      PATH: systemdPath,
      SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
      SECRET_FABRIC_API_TOKEN: 'tok'
    }
  });
  assert.equal(fromLocal.status, 0, fromLocal.stderr);
  assert.match(readFileSync(localLog, 'utf8'), /argv:src\/mcp\/server\.mjs/);
});

test('native hold stays running until SIGTERM', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agentcal-hold-')), 'agentcalendar.db');
  const child = spawn(process.execPath, [join(repoRoot, 'src/mcp/server.mjs')], {
    env: {
      ...BASE_ENV,
      AGENTCAL_DB_PATH: dbPath,
      AGENTCAL_NATIVE_HOLD: '1',
      PATH: process.env.PATH
    },
    stdio: 'ignore'
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const early = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve({ running: true }), 1000))
  ]);
  assert.equal(early.running, true);
  child.kill('SIGTERM');
  const finished = await exited;
  assert.equal(finished.code, 0);
  assert.equal(finished.signal, null);
});

test('native MCP startup fails closed when principal configuration is missing', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'src/mcp/server.mjs')], {
    env: {
      AGENTCAL_DB_PATH: '/tmp/agentcalendar-fail.db',
      AGENTCAL_SYNC_INTERVAL_SECONDS: '300',
      AGENTCAL_LOG_LEVEL: 'info',
      AGENTCAL_TRANSPORT: 'stdio',
      AGENTCAL_SERVICE_MODE: 'native',
      SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
      SECRET_FABRIC_API_TOKEN: 'tok',
      PATH: process.env.PATH
    },
    encoding: 'utf8',
    timeout: 5000
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /AGENTCAL_PRINCIPAL|AGENTCAL_PROFILE|native/);
});
