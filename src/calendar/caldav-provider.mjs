import { createDAVClient } from 'tsdav';
import { parseVeventFields } from './ical.mjs';

/**
 * Map tsdav calendar object to internal shape.
 * @param {object} cal
 */
function mapCalendar(cal) {
  return {
    id: cal.url,
    calendarId: cal.url,
    displayName: cal.displayName ?? cal.name ?? cal.url,
    color: cal.calendarColor ?? null,
    timezone: cal.timezone ?? null,
    ctag: cal.syncToken ?? cal.ctag ?? null,
    etag: cal.etag ?? null,
    url: cal.url
  };
}

/**
 * Map DAV calendar object to event record.
 * @param {object} obj
 * @param {string} calendarUrl
 */
function mapCalendarObject(obj, calendarUrl) {
  const raw = obj.data ?? obj.calendarData ?? '';
  const parsed = raw ? parseVeventFields(raw) : {};
  const uid = parsed.uid ?? obj.url?.split('/').pop()?.replace(/\.ics$/, '') ?? obj.etag;
  return {
    uid,
    etag: obj.etag ?? null,
    summary: parsed.summary ?? obj.summary ?? null,
    description: parsed.description ?? null,
    location: parsed.location ?? null,
    start: parsed.start ?? null,
    end: parsed.end ?? null,
    allDay: false,
    recurrenceRule: null,
    recurrenceId: null,
    attendees: [],
    organizer: null,
    status: null,
    raw,
    calendarId: calendarUrl
  };
}

/**
 * Create a CalDAV provider backed by tsdav.
 * @param {{ connection: object, credentials: object }} options
 */
export function createCaldavProvider({ connection, credentials, davFactory }) {
  const baseUrl = connection?.baseUrl ?? credentials?.baseUrl;
  if (!baseUrl) throw new TypeError('connection.baseUrl is required');
  const username = credentials?.username;
  const password = credentials?.password;
  if (!username || !password) throw new TypeError('credentials username and password are required');

  let client = null;
  let calendarsCache = null;

  async function getClient() {
    if (client) return client;
    if (davFactory) {
      client = await davFactory();
      return client;
    }
    client = await createDAVClient({
      serverUrl: baseUrl.replace(/\/$/, ''),
      credentials: { username, password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    });
    return client;
  }

  return {
    async listCalendars() {
      const dav = await getClient();
      const calendars = await dav.fetchCalendars();
      calendarsCache = calendars.map(mapCalendar);
      if (connection?.calendarPath) {
        const path = connection.calendarPath;
        const filtered = calendarsCache.filter((c) => c.id.includes(path) || c.id.endsWith(path));
        return filtered.length ? filtered : calendarsCache;
      }
      return calendarsCache;
    },

    async *fetchEvents(calendar) {
      const dav = await getClient();
      const calendarUrl = calendar.url ?? calendar.id ?? calendar.calendarId;
      const objects = await dav.fetchCalendarObjects({ calendar: { url: calendarUrl } });
      for (const obj of objects) {
        yield mapCalendarObject(obj, calendarUrl);
      }
    },

    /**
     * Query one calendar inside a time window. Full event bodies are loaded only when the result fits the page.
     * A bounded REPORT may return one extra row so the caller can build a cursor. A larger unbounded result fails closed.
     * @param {{ calendarId: string, reports?: unknown[], start: string, end: string, query?: string, limit: number, sortOrder?: string, cursor?: string|null }} criteria Query bounds.
     * @returns {Promise<{ events: object[], bounded: boolean, hasMore: boolean }>} Provider page.
     */
    async queryEvents({ calendarId, reports = [], start, end, query = '', limit, sortOrder = 'desc', cursor = null }) {
      if (!calendarId || !start || !end) throw new Error('pagination_unavailable');
      const dav = await getClient();
      if (typeof dav.calendarQuery !== 'function') throw new Error('pagination_unavailable');
      const bounded = supportsBoundedReport(dav, reports);
      if (cursor && !bounded) throw new Error('pagination_unavailable');
      const cap = bounded ? limit + 1 : limit;
      const rows = await dav.calendarQuery({
        url: calendarId,
        props: bounded ? PAGE_PROPS : ETAG_PROPS,
        filters: eventWindowFilter(start, end, query),
        depth: '1',
        limit: bounded ? cap : undefined,
        sortOrder
      });
      const hrefs = (Array.isArray(rows) ? rows : []).filter((row) => isEventHref(row?.href));
      if (hrefs.length > cap) throw new Error('pagination_unavailable');
      const events = hrefs.every((row) => calendarData(row))
        ? hrefs.map((row) => mapCalendarObject({
          data: calendarData(row),
          etag: etagOf(row),
          url: row.href
        }, calendarId))
        : await fetchEventBodies(dav, calendarId, hrefs);
      return { events, bounded, hasMore: bounded && hrefs.length > limit };
    },

    async putEvent({ calendarId, uid, icalBody, etag }) {
      const dav = await getClient();
      const filename = `${uid}.ics`;
      const response = await dav.createCalendarObject({
        calendar: { url: calendarId },
        filename,
        iCalString: icalBody,
        headers: etag ? { 'If-Match': etag } : undefined
      });
      return { etag: response?.etag ?? null, uid };
    },

    async getEvent({ calendarId, uid }) {
      const dav = await getClient();
      const objects = await dav.fetchCalendarObjects({
        calendar: { url: calendarId },
        objectUrls: [`${calendarId.replace(/\/$/, '')}/${uid}.ics`]
      });
      const obj = objects?.[0];
      if (!obj) return null;
      const mapped = mapCalendarObject(obj, calendarId);
      return { uid: mapped.uid, etag: mapped.etag, raw: mapped.raw };
    },

    async close() {
      client = null;
      calendarsCache = null;
    }
  };
}

const ETAG_PROPS = { 'd:getetag': {} };
const PAGE_PROPS = { 'd:getetag': {}, 'c:calendar-data': {} };

/**
 * True when this client can apply a result limit inside calendar-query.
 * Stock tsdav does not. A client sets boundedReport or advertises a limit report.
 * @param {object} dav DAV client.
 * @param {unknown[]} reports Report names from the calendar, when known.
 * @returns {boolean}
 */
function supportsBoundedReport(dav, reports) {
  if (dav?.boundedReport === true) return true;
  return (reports ?? []).some((report) => /limit|nresults/i.test(reportLabel(report)));
}

/**
 * Report name used for bounded-report detection.
 * @param {unknown} report Report entry.
 * @returns {string}
 */
function reportLabel(report) {
  if (typeof report === 'string') return report;
  if (report && typeof report === 'object') return String(report.name ?? report.report ?? '');
  return '';
}

/**
 * calendar-query filter for VEVENTs in a time window, with an optional summary match.
 * @param {string} start Inclusive ISO start.
 * @param {string} end Exclusive ISO end.
 * @param {string} query Summary text.
 * @returns {object[]} tsdav filter list.
 */
function eventWindowFilter(start, end, query) {
  const component = {
    _attributes: { name: 'VEVENT' },
    'time-range': {
      _attributes: {
        start: toCalDavUtc(start),
        end: toCalDavUtc(end)
      }
    }
  };
  if (query) {
    component['prop-filter'] = {
      _attributes: { name: 'SUMMARY' },
      'text-match': {
        _attributes: { collation: 'i;ascii-casemap' },
        _text: query
      }
    };
  }
  return [{
    'comp-filter': {
      _attributes: { name: 'VCALENDAR' },
      'comp-filter': component
    }
  }];
}

/**
 * Format an ISO timestamp as a CalDAV UTC instant.
 * @param {string} iso ISO-8601 timestamp.
 * @returns {string} UTC instant.
 */
function toCalDavUtc(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * True when an href points at a calendar object.
 * @param {unknown} href DAV href.
 * @returns {boolean}
 */
function isEventHref(href) {
  return typeof href === 'string' && href.includes('.ics');
}

/**
 * Read calendar-data from a REPORT row.
 * @param {object} row DAV response row.
 * @returns {string} iCalendar text.
 */
function calendarData(row) {
  const value = row?.props?.calendarData;
  if (typeof value === 'string') return value;
  if (typeof value?._cdata === 'string') return value._cdata;
  return '';
}

/**
 * Read a getetag value from a REPORT row.
 * @param {object} row DAV response row.
 * @returns {string|null} ETag.
 */
function etagOf(row) {
  const value = row?.props?.getetag;
  return value == null ? null : String(value);
}

/**
 * Load full event bodies for an already bounded href list.
 * @param {object} dav DAV client.
 * @param {string} calendarId Calendar URL.
 * @param {object[]} hrefs REPORT rows.
 * @returns {Promise<object[]>} Mapped events.
 */
async function fetchEventBodies(dav, calendarId, hrefs) {
  if (hrefs.length === 0) return [];
  if (typeof dav.fetchCalendarObjects !== 'function') throw new Error('pagination_unavailable');
  const objects = await dav.fetchCalendarObjects({
    calendar: { url: calendarId },
    objectUrls: hrefs.map((row) => row.href)
  });
  return (objects ?? []).map((obj) => mapCalendarObject(obj, calendarId));
}
