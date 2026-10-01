/**
 * Read local sync checkpoints for one account.
 * Does not contact CalDAV and does not start a sync.
 * @param {{ listCheckpoints: (accountId: string) => object[] }} store Calendar store.
 * @param {string} accountId Account id.
 * @returns {{ accountId: string, state: string, calendars: object[], syncStarted: boolean }} Status payload without credentials.
 */
export function buildCalendarSyncStatus(store, accountId) {
  const calendars = store.listCheckpoints(accountId);
  return {
    accountId,
    state: calendars.length === 0 ? 'not_started' : 'checkpointed',
    calendars,
    syncStarted: false
  };
}

/**
 * Read local sync checkpoints for every given account.
 * @param {{ listCheckpoints: (accountId: string) => object[] }} store Calendar store.
 * @param {string[]} accountIds Active account ids.
 * @returns {{ accounts: object[], syncStarted: boolean }} Status payload without credentials.
 */
export function buildCalendarSyncStatusAll(store, accountIds) {
  return {
    accounts: accountIds.map((accountId) => buildCalendarSyncStatus(store, accountId)),
    syncStarted: false
  };
}
