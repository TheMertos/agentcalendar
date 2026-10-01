import { SqliteCalendarStore } from '../storage/sqlite-store.mjs';
import { createLeaseBroker } from '../security/lease-broker.mjs';
import { createSecretFabricResolver } from '../security/secretfabric-resolver.mjs';
import { CalendarService, CALDAV_SYNC_FIELDS } from '../calendar/calendar-service.mjs';
import { createCaldavProvider } from '../calendar/caldav-provider.mjs';

/**
 * Wire the SQLite store, active-account lookup, SecretFabric lease broker, and CalendarService.
 * Does not start calendar sync. Interactive tools use CalendarService against the live CalDAV provider.
 * @param {{ dbPath: string, secretFabricUrl: string, secretFabricApiToken: string, principal: string }} config Validated runtime configuration.
 * @param {{ fetchImpl?: typeof fetch, providerFactory?: Function }} [options] Optional test seams.
 * @returns {{ config: object, store: SqliteCalendarStore, calendarService: CalendarService, close: () => void }}
 */
export function createCalendarRuntime(config, options = {}) {
  const store = new SqliteCalendarStore(config.dbPath);
  const resolveCredentials = createSecretFabricResolver({
    baseUrl: config.secretFabricUrl,
    apiToken: config.secretFabricApiToken,
    principal: config.principal,
    fetchImpl: options.fetchImpl
  });
  const leaseBroker = createLeaseBroker({
    resolver: ({ accountId, purpose }) => {
      const account = store.getAccount(accountId);
      if (!account) throw new Error('account_not_found');
      return resolveCredentials({
        resourceId: account.secretRef,
        purpose,
        fieldPaths: CALDAV_SYNC_FIELDS
      });
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
    close: () => store.close()
  };
}
