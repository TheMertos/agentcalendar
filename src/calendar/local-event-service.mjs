import { buildVeventIcal, parseVeventFields } from './ical.mjs';

/**
 * Apply a local-only event mutation and enqueue upload.
 * @param {object} store
 * @param {{ accountId: string, calendarId: string, uid: string, summary?: string, description?: string, location?: string, start?: string, end?: string }} input
 */
export function updateEventLocal(store, input) {
  const { accountId, calendarId, uid } = input;
  const existing = store.getEvent(accountId, calendarId, uid);
  if (!existing) throw new Error('event_not_found');

  const merged = {
    summary: input.summary ?? existing.summary,
    description: input.description ?? existing.description,
    location: input.location ?? existing.location,
    start: input.start ?? existing.start,
    end: input.end ?? existing.end,
    attendees: existing.attendees,
    organizer: existing.organizer,
    recurrenceRule: existing.recurrenceRule
  };
  const icalBody = buildVeventIcal({ uid, ...merged });
  const parsed = parseVeventFields(icalBody);

  store.upsertEvent({
    accountId,
    calendarId,
    uid,
    etag: existing.etag,
    summary: parsed.summary ?? merged.summary,
    description: parsed.description ?? merged.description,
    location: parsed.location ?? merged.location,
    start: merged.start,
    end: merged.end,
    allDay: existing.allDay,
    recurrenceRule: existing.recurrenceRule,
    recurrenceId: existing.recurrenceId,
    attendees: existing.attendees,
    organizer: existing.organizer,
    status: existing.status,
    raw: icalBody
  });
  store.enqueueDirtyEvent({
    accountId,
    calendarId,
    uid,
    expectedEtag: existing.etag ?? null,
    icalBody
  });
  return store.getEvent(accountId, calendarId, uid);
}
