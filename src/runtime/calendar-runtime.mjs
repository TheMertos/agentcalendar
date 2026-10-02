import { SqliteCalendarStore } from '../storage/sqlite-store.mjs';
import { createCredentialCache, parseCredentialCacheKey } from '../security/credential-cache.mjs';
import { createCredentialSync, mapCalendarCredentials } from '../security/credential-sync.mjs';
import { createLeaseBroker } from '../security/lease-broker.mjs';
import { createSecretFabricClient } from '../security/secretfabric-resolver.mjs';
import { CalendarService, CALDAV_SYNC_FIELDS } from '../calendar/calendar-service.mjs';
import { createCaldavProvider } from '../calendar/caldav-provider.mjs';

/**
 * Wire the SQLite store, active-account lookup, encrypted credential cache, and CalendarService.
 * Provider access always reconciles SecretFabric into the service-owned cache, then decrypts only in this process.
 * CREDENTIAL_CACHE_KEY is required. There is no direct SecretFabric resolver fallback.
 * Does not start calendar sync. Interactive tools use CalendarService against the live CalDAV provider.
 * @param {{ dbPath: string, secretFabricUrl: string, secretFabricApiToken: string, principal: string, credentialCacheKey: string }} config Validated runtime configuration.
 * @param {{ fetchImpl?: typeof fetch, providerFactory?: Function, clock?: () => number }} [options] Optional test seams.
 * @returns {{ config: object, store: SqliteCalendarStore, calendarService: CalendarService, credentialSync: object, close: () => void }}
 */
export function createCalendarRuntime(config, options = {}) {
  parseCredentialCacheKey(config.credentialCacheKey);
  const store = new SqliteCalendarStore(config.dbPath);
  const fabricOptions = {
    baseUrl: config.secretFabricUrl,
    apiToken: config.secretFabricApiToken,
    principal: config.principal,
    fetchImpl: options.fetchImpl
  };
  const cache = createCredentialCache(store.db, config.credentialCacheKey);
  const credentialSync = createCredentialSync({
    cache,
    resolveResource: createSecretFabricClient(fabricOptions),
    mapFields: mapCalendarCredentials,
    clock: options.clock
  });
  const leaseBroker = createLeaseBroker({
    resolver: async ({ accountId, purpose }) => {
      const account = store.getAccount(accountId);
      if (!account?.enabled) throw new Error('account_not_found');
      const status = await credentialSync.reconcile({
        account,
        purpose,
        fieldPaths: CALDAV_SYNC_FIELDS
      });
      if (status.status !== 'current') throw new Error('credential_cache_unavailable');
      return credentialSync.readForProvider(account.id, purpose);
    }
  });

  /**
   * Open a CalDAV provider with the private lease credentials.
   * @param {{ account: object, lease: { leaseId: string } }} input Provider input.
   * @returns {Promise<object>} Provider instance.
   */
  async function defaultProviderFactory({ account, lease }) {
    const credentials = leaseBroker.getPrivate(lease.leaseId);
    if (!credentials) throw new Error('credential_lease_unavailable');
    return createCaldavProvider({ connection: account.connection ?? {}, credentials });
  }

  const calendarService = new CalendarService({
    accountRegistry: { get: (accountId) => store.getAccount(accountId) },
    leaseBroker,
    providerFactory: options.providerFactory ?? defaultProviderFactory
  });

  return {
    config,
    store,
    calendarService,
    credentialSync,
    close: () => store.close()
  };
}
