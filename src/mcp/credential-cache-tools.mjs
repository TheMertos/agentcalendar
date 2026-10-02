import { CALDAV_SYNC_FIELDS } from '../calendar/calendar-service.mjs';

const CALENDAR_SCOPES = [{ purpose: 'caldav-sync', fieldPaths: CALDAV_SYNC_FIELDS }];
const SECRET_KEYS = /password|token|secret|ciphertext|nonce|username|authorization/i;

/**
 * Drop credential-bearing keys from a status payload.
 * @param {unknown} value Status value.
 * @returns {unknown}
 */
function publicStatus(value) {
  if (Array.isArray(value)) return value.map((item) => publicStatus(item));
  if (!value || typeof value !== 'object') return value;
  const cleaned = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) continue;
    cleaned[key] = publicStatus(nested);
  }
  return cleaned;
}

/**
 * Non-sensitive credential cache status and reconcile handlers.
 * @param {{ store: { getAccount: Function }, credentialSync: object|null }} deps Account store and sync service.
 * @returns {{ credentialCacheStatus: Function, credentialCacheReconcile: Function }}
 */
export function createCredentialCacheHandlers({ store, credentialSync }) {
  /**
   * Load one enabled account.
   * @param {string} accountId Account id.
   * @returns {object|null}
   */
  function activeAccount(accountId) {
    const account = store.getAccount(accountId);
    if (!account?.enabled) return null;
    return account;
  }

  return {
    /**
     * Return cache status without ciphertext or credentials.
     * @param {{ accountId: string }} args Tool input.
     * @returns {Promise<object>}
     */
    async credentialCacheStatus({ accountId }) {
      if (!activeAccount(accountId)) return { error: 'account_not_active' };
      if (!credentialSync) return { error: 'credential_cache_unconfigured' };
      return publicStatus({ accountId, entries: credentialSync.listStatus(accountId) });
    },

    /**
     * Refresh the encrypted cache from SecretFabric. The result is status only.
     * @param {{ accountId: string }} args Tool input.
     * @returns {Promise<object>}
     */
    async credentialCacheReconcile({ accountId }) {
      const account = activeAccount(accountId);
      if (!account) return { error: 'account_not_active' };
      if (!credentialSync) return { error: 'credential_cache_unconfigured' };
      const entries = [];
      for (const scope of CALENDAR_SCOPES) {
        entries.push(await credentialSync.reconcile({
          account,
          purpose: scope.purpose,
          fieldPaths: scope.fieldPaths
        }));
      }
      return publicStatus({ accountId, entries });
    }
  };
}
