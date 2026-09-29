import { parseVeventFields } from './ical.mjs';

/**
 * PUT event to CalDAV and verify UID/etag via read-back.
 * @param {{ provider: object, payload: object }} options
 */
export async function writeEventWithVerification({ provider, payload }) {
  const { calendarId, icalBody, uid } = payload;
  if (!calendarId || !icalBody) throw new TypeError('calendarId and icalBody are required');
  const parsed = parseVeventFields(icalBody);
  const eventUid = uid ?? parsed.uid;
  if (!eventUid) throw new Error('event_uid_required');

  let writeResult;
  try {
    writeResult = await provider.putEvent({ calendarId, uid: eventUid, icalBody, etag: payload.etag ?? null });
  } catch (error) {
    if (error?.status === 412 || error?.code === 'precondition_failed') {
      const wrapped = new Error('precondition_failed');
      wrapped.code = 'precondition_failed';
      wrapped.status = 412;
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
  const readBack = await provider.getEvent({ calendarId, uid: eventUid });
  if (!readBack?.uid || readBack.uid !== eventUid) throw new Error('write_verification_failed');
  const expected = parseVeventFields(icalBody);
  const actual = parseVeventFields(readBack.raw ?? '');
  if (expected.summary && actual.summary && expected.summary !== actual.summary) {
    throw new Error('content_verification_failed');
  }
  if (writeResult?.etag && readBack.etag && writeResult.etag !== readBack.etag) {
    throw new Error('etag_verification_failed');
  }
  return { uid: eventUid, etag: readBack.etag ?? writeResult?.etag ?? null, verified: true };
}
