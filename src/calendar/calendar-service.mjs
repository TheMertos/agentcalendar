import { parseVeventFields } from './ical.mjs';
import { writeEventWithVerification } from './write-service.mjs';
import {
  buildEventSearchPage,
  decodeEventCursor,
  encodeEventCursor,
  eventVisible,
  narrowWindow,
  normalizeEventSearch,
  resolveWindow,
  sameInstant,
  sortEvents
} from './event-search.mjs';

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
  /**
   * @param {{ accountRegistry: object, leaseBroker: object, providerFactory: Function, now?: () => Date }} deps Service dependencies.
   */
  constructor({ accountRegistry, leaseBroker, providerFactory, now }) {
    this.accountRegistry = accountRegistry;
    this.leaseBroker = leaseBroker;
    this.providerFactory = providerFactory;
    this.now = typeof now === 'function' ? now : () => new Date();
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
   * One calendar is queried. The provider must apply the limit; this method does not scan every remote event.
   * A cursor is returned only when the provider reports a bounded REPORT.
   * @param {string} accountId Account id.
   * @param {object} [criteria] Search criteria.
   * @returns {Promise<object>} Page with items, nextCursor, hasMore, appliedFilters, and total.
   */
  async searchEvents(accountId, criteria = {}) {
    const normalized = normalizeEventSearch(criteria);
    const account = this.#requireAccount(accountId);
    const cursor = normalized.cursor ? decodeEventCursor(normalized.cursor, accountId, normalized) : null;
    const lease = await this.#acquireLease(accountId);
    const provider = await this.providerFactory({ account, lease, operation: 'caldav-sync' });
    try {
      if (typeof provider.queryEvents !== 'function') throw new Error('pagination_unavailable');
      const calendar = cursor
        ? { calendarId: cursor.calendarId, reports: [] }
        : await this.#searchCalendar(provider, account, normalized.calendarId);
      if (!calendar) {
        return buildEventSearchPage({
          items: [],
          hasMore: false,
          nextCursor: null,
          appliedFilters: appliedFilters(accountId, null, resolveWindow(normalized, this.now()), normalized)
        });
      }
      const window = cursor
        ? { start: cursor.windowStart, end: cursor.windowEnd }
        : resolveWindow(normalized, this.now());
      const queried = narrowWindow(window, cursor, normalized.sortOrder);
      if (!(Date.parse(queried.start) < Date.parse(queried.end))) {
        return buildEventSearchPage({
          items: [],
          hasMore: false,
          nextCursor: null,
          appliedFilters: appliedFilters(accountId, calendar.calendarId, window, normalized)
        });
      }
      const result = await provider.queryEvents({
        calendarId: calendar.calendarId,
        reports: calendar.reports ?? [],
        start: queried.start,
        end: queried.end,
        query: normalized.query,
        limit: normalized.limit,
        sortBy: normalized.sortBy,
        sortOrder: normalized.sortOrder,
        cursor: normalized.cursor
      });
      return pageQueryResult({
        accountId,
        calendarId: calendar.calendarId,
        normalized,
        window,
        queried,
        result
      });
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

  /**
   * Choose the single calendar a search may query.
   * @param {object} provider CalDAV provider.
   * @param {object} account Account record.
   * @param {string|null} calendarId Requested calendar URL.
   * @returns {Promise<{ calendarId: string, reports: unknown[] }|null>} Calendar scope.
   */
  async #searchCalendar(provider, account, calendarId) {
    if (calendarId) return { calendarId, reports: [] };
    if (typeof provider.listCalendars !== 'function') throw new Error('provider_unavailable');
    const calendars = await provider.listCalendars();
    const path = account?.connection?.calendarPath;
    const match = path
      ? calendars.find((calendar) => {
        const id = calendar.url ?? calendar.calendarId ?? calendar.id ?? '';
        return id.includes(path) || id.endsWith(path);
      })
      : null;
    const selected = match ?? calendars[0];
    if (!selected) return null;
    const id = selected.url ?? selected.calendarId ?? selected.id;
    if (!id) return null;
    return { calendarId: id, reports: selected.reports ?? [] };
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
 * Turn a bounded provider result into one search page.
 * @param {{ accountId: string, calendarId: string, normalized: object, window: { start: string, end: string }, queried: { start: string, end: string }, result: object }} input Query result.
 * @returns {object} Search page.
 */
function pageQueryResult({ accountId, calendarId, normalized, window, queried, result }) {
  if (!result || !Array.isArray(result.events)) throw new Error('provider_unavailable');
  if (normalized.cursor && result.bounded !== true) throw new Error('pagination_unavailable');
  if (result.events.length > normalized.limit + 1) throw new Error('pagination_unavailable');
  if (result.bounded !== true && (result.events.length > normalized.limit || result.hasMore === true)) {
    throw new Error('pagination_unavailable');
  }
  const shaped = result.events.map((event) => shapeRemoteEvent(accountId, calendarId, event));
  const visible = shaped.filter((event) => eventVisible(event, {
    query: normalized.query,
    start: queried.start,
    end: queried.end
  }));
  if (visible.length !== shaped.length && result.bounded === true && result.events.length > normalized.limit) {
    throw new Error('pagination_unavailable');
  }
  const ordered = sortEvents(visible, normalized.sortOrder);
  const bounded = result.bounded === true;
  const hasMore = bounded && (ordered.length > normalized.limit || (result.hasMore === true && ordered.length === normalized.limit));
  const items = ordered.slice(0, normalized.limit);
  if (hasMore && ordered.length > normalized.limit && sameInstant(items.at(-1), ordered[normalized.limit])) {
    throw new Error('pagination_unavailable');
  }
  const nextCursor = hasMore
    ? encodeEventCursor({ accountId, normalized, calendarId, window, event: items.at(-1) })
    : null;
  return buildEventSearchPage({
    items,
    hasMore,
    nextCursor,
    appliedFilters: appliedFilters(accountId, calendarId, window, normalized)
  });
}

/**
 * Filters reported with a search page.
 * @param {string} accountId Account id.
 * @param {string|null} calendarId Calendar URL.
 * @param {{ start: string, end: string }} window Resolved window.
 * @param {object} normalized Normalized criteria.
 * @returns {object} Applied filters.
 */
function appliedFilters(accountId, calendarId, window, normalized) {
  return {
    accountId,
    calendarId,
    query: normalized.query,
    start: window.start,
    end: window.end,
    limit: normalized.limit,
    sortBy: normalized.sortBy,
    sortOrder: normalized.sortOrder
  };
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
