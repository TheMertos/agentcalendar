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
