import { writeEventWithVerification } from './write-service.mjs';
import { parseVeventFields } from './ical.mjs';

const DEFAULT_MAX_ATTEMPTS = 4;

/**
 * @param {Error} error
 */
function isPreconditionConflict(error) {
  return error?.status === 412 || error?.code === 'precondition_failed' || /precondition/i.test(error?.message ?? '');
}

/**
 * @param {Error} error
 */
function isTransientError(error) {
  if (isPreconditionConflict(error)) return false;
  return error?.code === 'transient' || /network|timeout|econnreset/i.test(error?.message ?? '');
}

/**
 * @param {number} attempt
 */
function backoffMs(attempt) {
  return Math.min(30_000, 250 * (2 ** attempt));
}

/**
 * Upload one dirty queue row with If-Match, read-back verification, and bounded retries.
 * @param {{ provider: object, store: object, entry: object, maxAttempts?: number }} options
 */
export async function uploadDirtyEvent({ provider, store, entry, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  const { accountId, calendarId, uid, icalBody, expectedEtag } = entry;
  let attempt = entry.attemptCount ?? 0;

  while (attempt < maxAttempts) {
    try {
      const result = await writeEventWithVerification({
        provider,
        payload: { calendarId, uid, icalBody, etag: expectedEtag ?? null }
      });
      const parsed = parseVeventFields(icalBody);
      store.upsertEvent({
        accountId,
        calendarId,
        uid,
        etag: result.etag,
        summary: parsed.summary ?? null,
        description: parsed.description ?? null,
        location: parsed.location ?? null,
        start: parsed.start ?? null,
        end: parsed.end ?? null,
        raw: icalBody
      });
      store.clearDirtyEvent(accountId, calendarId, uid);
      return { status: 'uploaded', uid, etag: result.etag };
    } catch (error) {
      if (isPreconditionConflict(error)) {
        let remoteEtag = null;
        try {
          const remote = await provider.getEvent({ calendarId, uid });
          remoteEtag = remote?.etag ?? null;
        } catch {
          // ignore read errors during conflict handling
        }
        store.recordConflict({
          accountId,
          calendarId,
          uid,
          expectedEtag,
          remoteEtag,
          message: 'etag_precondition_failed'
        });
        store.updateDirtyEventState(accountId, calendarId, uid, {
          status: 'conflict',
          errorClass: 'conflict',
          lastError: error.message
        });
        return { status: 'conflict', uid };
      }

      attempt += 1;
      if (!isTransientError(error) || attempt >= maxAttempts) {
        store.updateDirtyEventState(accountId, calendarId, uid, {
          status: 'failed',
          attemptCount: attempt,
          errorClass: isTransientError(error) ? 'transient' : 'permanent',
          lastError: error.message,
          nextRetryAt: null
        });
        return { status: 'failed', uid, error: error.message };
      }

      store.updateDirtyEventState(accountId, calendarId, uid, {
        status: 'pending',
        attemptCount: attempt,
        errorClass: 'transient',
        lastError: error.message,
        nextRetryAt: new Date(Date.now() + backoffMs(attempt)).toISOString()
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return { status: 'failed', uid, error: 'max_attempts_exceeded' };
}

/**
 * Process all uploadable dirty rows for calendars with autoUpload enabled.
 * @param {{ accountId: string, provider: object, store: object }} options
 */
export async function uploadPendingForAccount({ accountId, provider, store }) {
  const dirty = store.listDirtyEvents(accountId, { status: 'pending' });
  const results = [];
  for (const entry of dirty) {
    const policy = store.getSyncPolicy(accountId, entry.calendarId);
    if (!policy.autoUpload) {
      results.push({ uid: entry.uid, status: 'skipped_policy' });
      continue;
    }
    if (entry.nextRetryAt && Date.parse(entry.nextRetryAt) > Date.now()) {
      results.push({ uid: entry.uid, status: 'skipped_backoff' });
      continue;
    }
    results.push(await uploadDirtyEvent({ provider, store, entry }));
  }
  return results;
}
