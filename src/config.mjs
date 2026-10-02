const REQUIRED = [
  'AGENTCAL_DB_PATH',
  'AGENTCAL_SYNC_INTERVAL_SECONDS',
  'AGENTCAL_LOG_LEVEL',
  'AGENTCAL_TRANSPORT',
  'AGENTCAL_PRINCIPAL',
  'SECRET_FABRIC_PRINCIPAL',
  'SECRET_FABRIC_URL',
  'SECRET_FABRIC_API_TOKEN',
  'CREDENTIAL_CACHE_KEY'
];

/**
 * Load and validate runtime configuration from environment variables.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ dbPath: string, syncIntervalSeconds: number, logLevel: string, transport: string, principal: string, secretFabricPrincipal: string, secretFabricUrl: string, secretFabricApiToken: string, serviceMode: string, credentialCacheKey: string }}
 */
export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length) throw new Error(`missing required runtime configuration: ${missing.join(', ')}`);
  const interval = Number(env.AGENTCAL_SYNC_INTERVAL_SECONDS);
  if (!Number.isInteger(interval) || interval < 30) {
    throw new Error('AGENTCAL_SYNC_INTERVAL_SECONDS must be an integer >= 30');
  }
  if (!['stdio', 'streamable-http'].includes(env.AGENTCAL_TRANSPORT)) {
    throw new Error('AGENTCAL_TRANSPORT must be stdio or streamable-http');
  }
  if (!['debug', 'info', 'warn', 'error'].includes(env.AGENTCAL_LOG_LEVEL)) {
    throw new Error('AGENTCAL_LOG_LEVEL is invalid');
  }
  const principal = String(env.AGENTCAL_PRINCIPAL).trim();
  const secretFabricPrincipal = String(env.SECRET_FABRIC_PRINCIPAL).trim();
  if (!principal || !secretFabricPrincipal) throw new Error('AGENTCAL_PRINCIPAL must be a non-empty string');
  if (principal !== secretFabricPrincipal) {
    throw new Error('AGENTCAL_PRINCIPAL must match SECRET_FABRIC_PRINCIPAL');
  }
  const serviceMode = String(env.AGENTCAL_SERVICE_MODE ?? 'native').trim();
  if (serviceMode !== 'native') {
    throw new Error('AGENTCAL_SERVICE_MODE must be native');
  }
  const credentialCacheKey = readCredentialCacheKey(env);
  return {
    dbPath: env.AGENTCAL_DB_PATH,
    syncIntervalSeconds: interval,
    logLevel: env.AGENTCAL_LOG_LEVEL,
    transport: env.AGENTCAL_TRANSPORT,
    principal,
    secretFabricPrincipal,
    secretFabricUrl: env.SECRET_FABRIC_URL,
    secretFabricApiToken: env.SECRET_FABRIC_API_TOKEN,
    serviceMode,
    credentialCacheKey
  };
}

/**
 * Require the external 32-byte hex cache key. It is not stored or logged.
 * @param {Record<string, string|undefined>} env Process environment.
 * @returns {string}
 */
function readCredentialCacheKey(env) {
  const value = String(env.CREDENTIAL_CACHE_KEY ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('CREDENTIAL_CACHE_KEY must be a 32-byte hexadecimal key');
  }
  return value;
}
