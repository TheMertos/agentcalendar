import { parseVeventFields } from './ical.mjs';
import { writeEventWithVerification } from './write-service.mjs';

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

  async syncAccount() {
    throw remoteOnlyError('remote_only_sync_disabled');
  }

  /**
   * Search live CalDAV events. Does not read or write the local event mirror.
   * @param {string} accountId Account id.
   * @param {{ query?: string, start?: string|null, end?: string|null, limit?: number }} criteria Search criteria.
   * @returns {Promise<object[]>} Matching events.
   */
  async searchEvents(accountId, { query = '', start = null, end = null, limit = 50 } = {}) {
    const account = this.#requireAccount(accountId);
    const lease = await this.#acquireLease(accountId);
    const provider = await this.providerFactory({ account, lease, operation: 'caldav-sync' });
    try {
      if (typeof provider.listCalendars !== 'function' || typeof provider.fetchEvents !== 'function') {
        throw new Error('provider_unavailable');
      }
      const calendars = await provider.listCalendars();
      const hits = [];
      for (const calendar of calendars) {
        const calendarId = calendar.calendarId ?? calendar.id ?? calendar.url;
        for await (const event of provider.fetchEvents(calendar)) {
          const shaped = shapeRemoteEvent(accountId, calendarId, event);
          if (!eventMatches(shaped, { query, start, end })) continue;
          hits.push(shaped);
        }
      }
      hits.sort((left, right) => String(left.start ?? '').localeCompare(String(right.start ?? '')));
      return hits.slice(0, limit);
    } finally {
      await provider.close?.();
      await this.leaseBroker.release?.(lease);
    }
  }

  /**
   * Read one live event by eventKey. A missing event returns null. Provider errors propagate.
   * @param {string} eventKey accountId::calendarId::uid key.
   * @returns {Promise<object|null>} Event or null.
   */
  async readEvent(eventKey) {
    const identity = parseEventKey(eventKey);
    const account = this.#requireAccount(identity.accountId);
    const lease = await this.#acquireLease(identity.accountId);
    const provider = await this.providerFactory({ account, lease, operation: 'caldav-sync' });
    try {
      if (typeof provider.getEvent !== 'function') throw new Error('provider_unavailable');
      const event = await provider.getEvent({ calendarId: identity.calendarId, uid: identity.uid });
      if (!event) return null;
      return shapeRemoteEvent(identity.accountId, identity.calendarId, event);
    } finally {
      await provider.close?.();
      await this.leaseBroker.release?.(lease);
    }
  }

  /**
   * Write an approved event to CalDAV and verify it by read-back.
   * The current ETag comes from the provider. The event is not stored locally.
   * @param {string} accountId Account id.
   * @param {object} payload Approved event payload.
   * @returns {Promise<object>} Verified write result.
   */
  async writeEvent(accountId, payload) {
    const account = this.#requireAccount(accountId);
    const lease = await this.#acquireLease(accountId);
    const provider = await this.providerFactory({ account, lease, operation: 'caldav-sync' });
    try {
      const enriched = { ...payload };
      if (payload.uid && enriched.etag == null) {
        if (typeof provider.getEvent !== 'function') throw new Error('provider_unavailable');
        const existing = await provider.getEvent({ calendarId: payload.calendarId, uid: payload.uid });
        if (existing?.etag) enriched.etag = existing.etag;
      }
      return await writeEventWithVerification({ provider, payload: enriched });
    } finally {
      await provider.close?.();
      await this.leaseBroker.release?.(lease);
    }
  }

  async uploadDirtyEvents() {
    throw remoteOnlyError('remote_only_sync_disabled');
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

/**
 * Parse an event key into account, calendar URL, and UID.
 * @param {string} eventKey Event key.
 * @returns {{ accountId: string, calendarId: string, uid: string }}
 */
export function parseEventKey(eventKey) {
  if (typeof eventKey !== 'string') throw new Error('event_not_found');
  const first = eventKey.indexOf('::');
  const last = eventKey.lastIndexOf('::');
  if (first <= 0 || last <= first) throw new Error('event_not_found');
  const accountId = eventKey.slice(0, first);
  const calendarId = eventKey.slice(first + 2, last);
  const uid = eventKey.slice(last + 2);
  if (!accountId || !calendarId || !uid) throw new Error('event_not_found');
  return { accountId, calendarId, uid };
}

/**
 * Build an event record from a live CalDAV object.
 * @param {string} accountId Account id.
 * @param {string} calendarId Calendar URL.
 * @param {object} event Provider event.
 * @returns {object} Event record.
 */
function shapeRemoteEvent(accountId, calendarId, event) {
  const parsed = parseVeventFields(event.raw ?? '');
  const uid = event.uid ?? parsed.uid;
  return {
    accountId,
    calendarId,
    uid,
    etag: event.etag ?? null,
    summary: event.summary ?? parsed.summary ?? null,
    description: event.description ?? parsed.description ?? null,
    location: event.location ?? parsed.location ?? null,
    start: event.start ?? parsed.start ?? null,
    end: event.end ?? parsed.end ?? null,
    raw: event.raw ?? '',
    eventKey: `${accountId}::${calendarId}::${uid}`
  };
}

/**
 * True when an event matches text and optional date bounds.
 * @param {object} event Shaped event.
 * @param {{ query: string, start: string|null, end: string|null }} criteria Criteria.
 * @returns {boolean}
 */
function eventMatches(event, { query, start, end }) {
  if (query) {
    const haystack = `${event.summary ?? ''}\n${event.description ?? ''}\n${event.location ?? ''}\n${event.raw ?? ''}`.toLowerCase();
    if (!haystack.includes(String(query).toLowerCase())) return false;
  }
  const eventStart = eventInstant(event.start);
  const eventEnd = eventInstant(event.end) ?? eventStart;
  if (start && eventEnd != null && eventEnd < eventInstant(start)) return false;
  if (end && eventStart != null && eventStart > eventInstant(end)) return false;
  return true;
}

/**
 * Parse an ISO or iCal UTC timestamp.
 * @param {string|null|undefined} value Timestamp.
 * @returns {number|null} Epoch milliseconds.
 */
function eventInstant(value) {
  if (!value) return null;
  const ical = String(value).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  const iso = ical ? `${ical[1]}-${ical[2]}-${ical[3]}T${ical[4]}:${ical[5]}:${ical[6]}Z` : value;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Error for a disabled background sync or upload path.
 * @param {string} code Error code.
 * @returns {Error}
 */
function remoteOnlyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export { assertLeaseSafe };
