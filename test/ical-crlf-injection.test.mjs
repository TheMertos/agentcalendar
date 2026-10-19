import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVeventIcal } from '../src/calendar/ical.mjs';

test('a CRLF embedded in uid cannot inject an extra iCal property', () => {
  assert.throws(
    () => buildVeventIcal({
      uid: 'u-1\r\nX-EVIL:1',
      summary: 'Test',
      start: '2026-01-01T10:00:00Z',
      end: '2026-01-01T11:00:00Z'
    }),
    /invalid uid/
  );
});

test('a CRLF embedded in organizer cannot inject an extra ATTENDEE line', () => {
  assert.throws(
    () => buildVeventIcal({
      uid: 'u-1',
      summary: 'Test',
      start: '2026-01-01T10:00:00Z',
      end: '2026-01-01T11:00:00Z',
      organizer: 'a@example.test\r\nATTENDEE:mailto:attacker@evil.test'
    }),
    /invalid organizer/
  );
});

test('a CRLF embedded in an attendee address cannot inject an extra property', () => {
  assert.throws(
    () => buildVeventIcal({
      uid: 'u-1',
      summary: 'Test',
      start: '2026-01-01T10:00:00Z',
      end: '2026-01-01T11:00:00Z',
      attendees: ['b@example.test\r\nX-INJECT:1']
    }),
    /invalid attendee/
  );
});

test('a bare CR in summary/description/location is folded, not left as a raw line terminator', () => {
  const ical = buildVeventIcal({
    uid: 'u-1',
    summary: 'Line1\rLine2',
    description: 'Desc1\r\nDesc2',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z'
  });
  // No bare \r survives in the serialized body outside of the mandated CRLF line terminators.
  const bodyWithoutLineBreaks = ical.replace(/\r\n/g, '|');
  assert.equal(/\r/.test(bodyWithoutLineBreaks), false);
  assert.match(ical, /SUMMARY:Line1\\nLine2/);
  assert.match(ical, /DESCRIPTION:Desc1\\nDesc2/);
});

test('a clean uid/organizer/attendee still produces a well-formed VEVENT', () => {
  const ical = buildVeventIcal({
    uid: 'u-1',
    summary: 'Test',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z',
    organizer: 'a@example.test',
    attendees: ['b@example.test', 'c@example.test']
  });
  assert.match(ical, /UID:u-1\r\n/);
  assert.match(ical, /ORGANIZER:mailto:a@example\.test\r\n/);
  assert.match(ical, /ATTENDEE:mailto:b@example\.test\r\n/);
  assert.match(ical, /ATTENDEE:mailto:c@example\.test\r\n/);
});
