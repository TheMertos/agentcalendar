import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Worker entrypoint is disabled in remote-only mode.
 * It does not open SQLite, SecretFabric, or CalDAV.
 * @returns {never}
 */
export function runCalendarRuntimeWorker() {
  const error = new Error('remote_only_sync_disabled');
  error.code = 'remote_only_sync_disabled';
  throw error;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    runCalendarRuntimeWorker();
  } catch (error) {
    process.stderr.write(`AgentCalendar sync worker error: ${error.message}\n`);
    process.exit(1);
  }
}
