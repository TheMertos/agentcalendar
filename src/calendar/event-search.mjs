import { createHash } from 'node:crypto';

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Search input that cannot be applied safely.
 */
export class EventSearchError extends Error {
  /**
   * @param {string} code Stable error code.
   */
  constructor(code) {
    super(code);
    this.name = 'EventSearchError';
    this.code = code;
  }
}

/**
 * Normalize event search input. Dates stay as provided; the resolved window is separate.
 * @param {object} [input] Search criteria.
 * @returns {object} Normalized criteria.
 */
export function normalizeEventSearch(input = {}) {
  const source = input ?? {};
  const limit = source.limit === undefined ? PAGE_SIZE_DEFAULT : source.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE_MAX) throw new EventSearchError('invalid_limit');
  const sortBy = source.sortBy ?? 'date';
  const sortOrder = source.sortOrder ?? 'desc';
  if (sortBy !== 'date') throw new EventSearchError('invalid_sort');
  if (sortOrder !== 'asc' && sortOrder !== 'desc') throw new EventSearchError('invalid_sort');
  const start = optionalInstant(source.start);
  const end = optionalInstant(source.end);
  if (start && end && Date.parse(start) >= Date.parse(end)) throw new EventSearchError('invalid_date');
  const calendarId = optionalCalendar(source.calendarId);
  const cursor = source.cursor == null || source.cursor === '' ? null : source.cursor;
  if (cursor != null && typeof cursor !== 'string') throw new EventSearchError('invalid_cursor');
  return {
    query: source.query == null ? '' : String(source.query),
    start,
    end,
    limit,
    sortBy,
    sortOrder,
    calendarId,
    cursor
  };
}

/**
 * Resolve the time window actually sent to CalDAV.
 * Omitted bounds use 30 days on each side of now. One omitted bound extends 30 days from the other.
 * @param {object} normalized Output of normalizeEventSearch.
 * @param {Date} now Clock value used when a bound is omitted.
 * @returns {{ start: string, end: string }} Inclusive start and exclusive end, as ISO-8601.
 */
export function resolveWindow(normalized, now) {
  const nowMs = now.getTime();
  let startMs = normalized.start ? Date.parse(normalized.start) : null;
  let endMs = normalized.end ? Date.parse(normalized.end) : null;
  if (startMs == null && endMs == null) {
    startMs = nowMs - WINDOW_MS;
    endMs = nowMs + WINDOW_MS;
  } else if (startMs == null) startMs = endMs - WINDOW_MS;
  else if (endMs == null) endMs = startMs + WINDOW_MS;
  if (!(endMs > startMs)) throw new EventSearchError('invalid_date');
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

/**
 * Move the window past a cursor. Descending pages end at the cursor instant. Ascending pages start one millisecond after it.
 * @param {{ start: string, end: string }} window Un-narrowed window.
 * @param {object|null} cursor Decoded cursor.
 * @param {'asc'|'desc'} sortOrder Sort direction.
 * @returns {{ start: string, end: string }} Window for the next provider query.
 */
export function narrowWindow(window, cursor, sortOrder) {
  if (!cursor) return window;
  if (!cursor.sortValue) throw new EventSearchError('pagination_unavailable');
  if (sortOrder === 'asc') {
    return { start: new Date(Date.parse(cursor.sortValue) + 1).toISOString(), end: window.end };
  }
  return { start: window.start, end: cursor.sortValue };
}

/**
 * Encode a continuation token for a bounded report page.
 * @param {{ accountId: string, normalized: object, calendarId: string, window: { start: string, end: string }, event: object }} input Cursor source.
 * @returns {string} Opaque cursor.
 */
export function encodeEventCursor({ accountId, normalized, calendarId, window, event }) {
  const sortValue = sortStamp(event);
  if (!sortValue) throw new EventSearchError('pagination_unavailable');
  const payload = {
    v: 1,
    h: fingerprint(accountId, normalized),
    calendarId,
    windowStart: window.start,
    windowEnd: window.end,
    sortOrder: normalized.sortOrder,
    sortValue,
    id: event.eventKey
  };
  return `es1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

/**
 * Decode a cursor and reject tokens that belong to a different query.
 * @param {string} token Opaque cursor.
 * @param {string} accountId Account id.
 * @param {object} normalized Current criteria.
 * @returns {object} Cursor payload.
 */
export function decodeEventCursor(token, accountId, normalized) {
  if (typeof token !== 'string' || !token.startsWith('es1.')) throw new EventSearchError('invalid_cursor');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(token.slice(4), 'base64url').toString('utf8'));
  } catch {
    throw new EventSearchError('invalid_cursor');
  }
  if (!payload || payload.v !== 1 || payload.h !== fingerprint(accountId, normalized)) throw new EventSearchError('invalid_cursor');
  if (payload.sortOrder !== normalized.sortOrder) throw new EventSearchError('invalid_cursor');
  if (typeof payload.calendarId !== 'string' || payload.calendarId.length === 0) throw new EventSearchError('invalid_cursor');
  if (typeof payload.windowStart !== 'string' || typeof payload.windowEnd !== 'string') throw new EventSearchError('invalid_cursor');
  if (typeof payload.sortValue !== 'string' || payload.sortValue.length === 0) throw new EventSearchError('invalid_cursor');
  if (typeof payload.id !== 'string' || payload.id.length === 0) throw new EventSearchError('invalid_cursor');
  if (!(Date.parse(payload.windowStart) < Date.parse(payload.windowEnd))) throw new EventSearchError('invalid_cursor');
  return payload;
}

/**
 * Sort events by start instant, then event key, in the requested direction.
 * @param {object[]} events Shaped events.
 * @param {'asc'|'desc'} sortOrder Sort direction.
 * @returns {object[]} New array.
 */
export function sortEvents(events, sortOrder) {
  const direction = sortOrder === 'asc' ? 1 : -1;
  return [...events].sort((left, right) => compareEvents(left, right) * direction);
}

/**
 * True when two events share a start instant.
 * @param {object} left Event.
 * @param {object} right Event.
 * @returns {boolean}
 */
export function sameInstant(left, right) {
  const stamp = sortStamp(left);
  return stamp.length > 0 && stamp === sortStamp(right);
}

/**
 * True when text and the queried window match.
 * @param {object} event Shaped event.
 * @param {{ query: string, start: string, end: string }} criteria Query and exclusive end.
 * @returns {boolean}
 */
export function eventVisible(event, { query, start, end }) {
  if (query) {
    const haystack = `${event.summary ?? ''}\n${event.description ?? ''}\n${event.location ?? ''}\n${event.raw ?? ''}`.toLowerCase();
    if (!haystack.includes(String(query).toLowerCase())) return false;
  }
  const instant = eventInstant(event.start);
  if (instant == null) return true;
  if (start && instant < Date.parse(start)) return false;
  if (end && instant >= Date.parse(end)) return false;
  return true;
}

/**
 * Build the public search page.
 * @param {{ items: object[], hasMore: boolean, nextCursor: string|null, appliedFilters: object }} page Page parts.
 * @returns {object} Search envelope.
 */
export function buildEventSearchPage({ items, hasMore, nextCursor, appliedFilters }) {
  return {
    items,
    results: items,
    nextCursor,
    hasMore,
    appliedFilters,
    total: hasMore ? null : items.length
  };
}

/**
 * Compare two events in ascending date order.
 * @param {object} left Event.
 * @param {object} right Event.
 * @returns {number} Negative when left sorts first.
 */
function compareEvents(left, right) {
  const leftStamp = sortStamp(left);
  const rightStamp = sortStamp(right);
  if (leftStamp < rightStamp) return -1;
  if (leftStamp > rightStamp) return 1;
  const leftId = left.eventKey ?? '';
  const rightId = right.eventKey ?? '';
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

/**
 * ISO stamp used for ordering. Missing starts sort first in ascending order.
 * @param {object} event Event.
 * @returns {string} ISO instant or an empty string.
 */
function sortStamp(event) {
  const instant = eventInstant(event.start);
  return instant == null ? '' : new Date(instant).toISOString();
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
 * Hash the filters a cursor is allowed to continue.
 * @param {string} accountId Account id.
 * @param {object} normalized Normalized criteria.
 * @returns {string} Fingerprint.
 */
function fingerprint(accountId, normalized) {
  return createHash('sha256').update(JSON.stringify({
    accountId,
    calendarId: normalized.calendarId ?? '',
    query: normalized.query,
    start: normalized.start ?? '',
    end: normalized.end ?? '',
    limit: normalized.limit,
    sortBy: normalized.sortBy,
    sortOrder: normalized.sortOrder
  })).digest('base64url');
}

/**
 * Accept an ISO timestamp or reject a value that is not one.
 * @param {unknown} value Candidate timestamp.
 * @returns {string|null} Timestamp.
 */
function optionalInstant(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new EventSearchError('invalid_date');
  return value;
}

/**
 * Accept one calendar URL.
 * @param {unknown} value Candidate calendar id.
 * @returns {string|null} Calendar URL.
 */
function optionalCalendar(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new EventSearchError('invalid_calendar');
  return value;
}
