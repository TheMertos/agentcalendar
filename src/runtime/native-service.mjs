import { loadConfig } from '../config.mjs';

/**
 * Fail closed unless this process is a native host service with a matching profile.
 * Does not start calendar sync.
 * @param {Record<string, string|undefined>} [env] Process environment.
 * @returns {ReturnType<typeof loadConfig>}
 */
export function assertNativeService(env = process.env) {
  if (String(env.AGENTCAL_SERVICE_MODE ?? '').trim() !== 'native') {
    throw new Error('AGENTCAL_SERVICE_MODE must be native');
  }
  const config = loadConfig(env);
  const profile = String(env.AGENTCAL_PROFILE ?? '').trim();
  if (!profile || profile !== config.principal) {
    throw new Error('AGENTCAL_PROFILE must match AGENTCAL_PRINCIPAL');
  }
  return config;
}
