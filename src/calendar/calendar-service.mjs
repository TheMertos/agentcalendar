import { syncAccount } from './sync-engine.mjs';
import { writeEventWithVerification } from './write-service.mjs';
import { uploadPendingForAccount } from './upload-service.mjs';

const SENSITIVE = /password|token|secret|private.?key|credential/i;

/**
 * @param {object} lease
 */
function assertLeaseSafe(lease) {
  if (!lease || typeof lease !== 'object' || !lease.leaseId) throw new Error('credential_lease_required');
  for (const key of Object.keys(lease)) {
    if (SENSITIVE.test(key)) throw new Error('plaintext credential in lease');
  }
}

export const CALDAV_SYNC_FIELDS = [
  'identity.email',
  'server.baseUrl',
  'server.calendarPath',
  'auth.username',
  'auth.password'
];

/**
 * CalDAV operations with lease-gated provider access.
 */
export class CalendarService {
  constructor({ accountRegistry, leaseBroker, providerFactory }) {
    this.accountRegistry = accountRegistry;
    this.leaseBroker = leaseBroker;
    this.providerFactory = providerFactory;
  }

  async listCalendars(accountId) {
    const account = this.#requireAccount(accountId);
    const lease = await this.#acquireLease(accountId);
    const provider = await this.providerFactory({ account, lease, operation: 'caldav-sync' });
    try {
      return await provider.listCalendars();
    } finally {
      await provider.close?.();
      await this.leaseBroker.release?.(lease);
    }
  }

  async syncAccount(accountId, { mode = 'incremental', store }) {
    const account = this.#requireAccount(accountId);
    if (!store) throw new Error('calendar_store_unavailable');
    const lease = await this.#acquireLease(accountId);
    const provider = await this.providerFactory({ account, lease, operation: 'caldav-sync' });
    try {
      return await syncAccount({ accountId, provider, store, mode });
    } finally {
      await provider.close?.();
      await this.leaseBroker.release?.(lease);
    }
  }

  async writeEvent(accountId, payload, { store } = {}) {
    const account = this.#requireAccount(accountId);
    const lease = await this.#acquireLease(accountId);
    const provider = await this.providerFactory({ account, lease, operation: 'caldav-sync' });
    try {
      const enriched = { ...payload };
      if (store && payload.uid) {
        const existing = store.getEvent(accountId, payload.calendarId, payload.uid);
        if (existing?.etag && enriched.etag == null) enriched.etag = existing.etag;
      }
      const result = await writeEventWithVerification({ provider, payload: enriched });
      if (store && payload.uid) {
        store.upsertEvent({
          accountId,
          calendarId: payload.calendarId,
          uid: payload.uid,
          etag: result.etag,
          raw: payload.icalBody
        });
        store.clearDirtyEvent?.(accountId, payload.calendarId, payload.uid);
      }
      return result;
    } finally {
      await provider.close?.();
      await this.leaseBroker.release?.(lease);
    }
  }

  async uploadDirtyEvents(accountId, { store }) {
    const account = this.#requireAccount(accountId);
    if (!store) throw new Error('calendar_store_unavailable');
    const lease = await this.#acquireLease(accountId);
    const provider = await this.providerFactory({ account, lease, operation: 'caldav-sync' });
    try {
      return await uploadPendingForAccount({ accountId, provider, store });
    } finally {
      await provider.close?.();
      await this.leaseBroker.release?.(lease);
    }
  }

  #requireAccount(accountId) {
    const account = this.accountRegistry?.get(accountId);
    if (!account) throw new Error('account_not_found');
    return account;
  }

  async #acquireLease(accountId) {
    if (!this.leaseBroker?.acquire) throw new Error('credential_lease_unavailable');
    const lease = await this.leaseBroker.acquire({ accountId, purpose: 'caldav-sync', fields: ['caldav'] });
    assertLeaseSafe(lease);
    return lease;
  }
}

export { assertLeaseSafe };
