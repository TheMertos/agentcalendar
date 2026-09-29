import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVeventIcal, parseVeventFields } from '../src/calendar/ical.mjs';

test('buildVeventIcal produces stable VEVENT wrapper', () => {
  const body = buildVeventIcal({
    uid: 'evt-abc',
    summary: 'Team sync',
    description: 'Agenda',
    location: 'Room 1',
    start: '2026-03-01T09:00:00Z',
    end: '2026-03-01T10:00:00Z',
    attendees: ['alice@example.com', 'bob@example.com']
  });
  assert.match(body, /BEGIN:VCALENDAR/);
  assert.match(body, /UID:evt-abc/);
  assert.match(body, /SUMMARY:Team sync/);
  assert.match(body, /ATTENDEE:mailto:alice@example.com/);
});

test('parseVeventFields reads uid and summary from built ical', () => {
  const icalBody = buildVeventIcal({
    uid: 'evt-xyz',
    summary: 'Lunch',
    start: '2026-03-02T12:00:00Z',
    end: '2026-03-02T13:00:00Z'
  });
  const parsed = parseVeventFields(icalBody);
  assert.equal(parsed.uid, 'evt-xyz');
  assert.equal(parsed.summary, 'Lunch');
});
