import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeMetadata } from '../src/core/account-registry.mjs';

test('assertSafeMetadata rejects passwords in connection metadata', () => {
  assert.throws(
    () => assertSafeMetadata({ baseUrl: 'https://x', password: 'nope' }, 'connection'),
    /connection.password is not allowed/
  );
});

test('assertSafeMetadata allows non-sensitive connection fields', () => {
  assertSafeMetadata({ baseUrl: 'https://caldav.example/', calendarPath: '/calendars/user/' }, 'connection');
});
