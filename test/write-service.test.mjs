import test from 'node:test';
import assert from 'node:assert/strict';
import { writeEventWithVerification } from '../src/calendar/write-service.mjs';
import { buildVeventIcal } from '../src/calendar/ical.mjs';

test('writeEventWithVerification requires matching uid on read-back', async () => {
  const icalBody = buildVeventIcal({ uid: 'u-1', summary: 'Test', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' });
  const provider = {
    async putEvent() { return { etag: 'e-new' }; },
    async getEvent() { return { uid: 'u-1', etag: 'e-new' }; }
  };
  const result = await writeEventWithVerification({
    provider,
    payload: { calendarId: 'cal-1', icalBody, uid: 'u-1' }
  });
  assert.equal(result.verified, true);
  assert.equal(result.uid, 'u-1');
});

test('writeEventWithVerification fails when read-back uid mismatches', async () => {
  const provider = {
    async putEvent() { return { etag: 'e' }; },
    async getEvent() { return { uid: 'other', etag: 'e' }; }
  };
  await assert.rejects(
    () => writeEventWithVerification({ provider, payload: { calendarId: 'c', icalBody: 'BEGIN:VCALENDAR\nUID:u\nEND:VCALENDAR', uid: 'u' } }),
    /write_verification_failed/
  );
});
