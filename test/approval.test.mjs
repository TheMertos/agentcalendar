import test from 'node:test';
import assert from 'node:assert/strict';
import { createApproval, verifyApproval } from '../src/core/approval.mjs';

test('approval verifies for the exact reviewed event payload', () => {
  const payload = {
    accountId: 'work',
    calendarId: 'https://caldav.example/cal/personal/',
    uid: 'evt-1',
    icalBody: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:evt-1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
  };
  const approval = createApproval(payload, { ttlSeconds: 300, now: 1_700_000_000 });
  assert.equal(verifyApproval(approval, payload, 1_700_000_100), true);
});

test('approval fails when ical body changes', () => {
  const payload = { accountId: 'a', calendarId: 'c', uid: 'u', icalBody: 'A' };
  const approval = createApproval(payload, { ttlSeconds: 300, now: 1_700_000_000 });
  assert.equal(verifyApproval(approval, { ...payload, icalBody: 'B' }, 1_700_000_001), false);
});

test('approval fails after expiry', () => {
  const payload = { accountId: 'a', calendarId: 'c', uid: 'u', icalBody: 'A' };
  const approval = createApproval(payload, { ttlSeconds: 60, now: 1_700_000_000 });
  assert.equal(verifyApproval(approval, payload, 1_700_000_061), false);
});
