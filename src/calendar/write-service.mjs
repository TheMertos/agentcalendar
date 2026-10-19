import { parseVeventFields } from './ical.mjs';

/**
 * Write a server-side-only diagnostic line for a collapsed write-verification failure.
 * The caller always receives the single generic 'write_verification_failed' error for
 * any post-write mismatch (uid/content/etag) so a caller probing a write cannot learn
 * which specific check failed; operators debugging a legitimate failure still need the
 * real reason. Never include icalBody/summary/description content here — only the
 * calendarId/uid identifiers and structural facts.
 * @param {string} reason Internal-only reason code, never sent to the caller.
 * @param {object} [details] Non-content structural details (ids, booleans).
 */
function logWriteVerificationFailure(reason, details = {}) {
  try {
    process.stderr.write(`AgentCalendar write verification rejected (internal): ${reason} ${JSON.stringify(details)}\n`);
  } catch {
    // Logging must never throw or block the rejection path.
  }
}

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
  if (!readBack?.uid || readBack.uid !== eventUid) {
    logWriteVerificationFailure('uid_mismatch', { calendarId, expectedUid: eventUid, gotUid: readBack?.uid ?? null });
    throw new Error('write_verification_failed');
  }
  const expected = parseVeventFields(icalBody);
  const actual = parseVeventFields(readBack.raw ?? '');
  if (expected.summary && actual.summary && expected.summary !== actual.summary) {
    logWriteVerificationFailure('summary_mismatch', { calendarId, uid: eventUid });
    throw new Error('write_verification_failed');
  }
  if (writeResult?.etag && readBack.etag && writeResult.etag !== readBack.etag) {
    logWriteVerificationFailure('etag_mismatch', { calendarId, uid: eventUid });
    throw new Error('write_verification_failed');
  }
  return { uid: eventUid, etag: readBack.etag ?? writeResult?.etag ?? null, verified: true };
}
