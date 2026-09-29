/**
 * Sync CalDAV calendars and events into the local store.
 * @param {{ accountId: string, provider: object, store: object, mode?: string }} options
 */
export async function syncAccount({ accountId, provider, store, mode = 'incremental' }) {
  if (!accountId || !provider || !store) throw new TypeError('accountId, provider and store are required');
  const calendars = await provider.listCalendars({ mode });
  let eventCount = 0;
  let skippedCalendars = 0;

  for (const calendar of calendars) {
    const calendarId = calendar.id ?? calendar.calendarId;
    const checkpoint = mode === 'incremental' ? await store.getCheckpoint?.(accountId, calendarId) : null;
    if (mode === 'incremental' && checkpoint?.calendarCtag && calendar.ctag && checkpoint.calendarCtag === calendar.ctag) {
      skippedCalendars += 1;
      continue;
    }

    await store.upsertCalendar({ ...calendar, accountId, calendarId });
    let folderCount = 0;
    for await (const event of provider.fetchEvents(calendar, { mode, checkpoint })) {
      await store.upsertEvent({ ...event, accountId, calendarId });
      eventCount += 1;
      folderCount += 1;
    }
    await store.checkpoint({
      accountId,
      calendarId,
      mode,
      eventCount: folderCount,
      calendarCtag: calendar.ctag ?? null
    });
  }

  return { accountId, mode, calendars: calendars.length, events: eventCount, skippedCalendars };
}
