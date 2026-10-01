/**
 * Interval sync for active accounts, with per-account locking and optional autoUpload.
 */
export class SyncWorker {
  constructor({ accounts, sync, upload = null, policy = null, intervalMs = 300_000 }) {
    this.accounts = accounts;
    this.sync = sync;
    this.upload = upload;
    this.policy = policy;
    this.intervalMs = intervalMs;
    this.running = null;
    this.timer = null;
    this.locks = new Set();
  }

  /**
   * Sync every enabled account once. Overlapping calls share the in-flight cycle.
   * @returns {Promise<Array<{ accountId: string, status: string, error?: string }>>} Per-account results.
   */
  async runOnce() {
    if (this.running) return this.running;
    this.running = (async () => {
      const results = [];
      try {
        for (const account of this.accounts.list()) {
          if (account.enabled === false) continue;
          if (this.locks.has(account.id)) {
            results.push({ accountId: account.id, status: 'skipped_locked' });
            continue;
          }
          this.locks.add(account.id);
          try {
            await this.sync(account.id, { mode: 'incremental' });
            if (this.upload && this.policy?.shouldAutoUpload?.(account.id)) {
              await this.upload(account.id);
            }
            results.push({ accountId: account.id, status: 'ok' });
          } catch (error) {
            results.push({ accountId: account.id, status: 'error', error: error.message });
          } finally {
            this.locks.delete(account.id);
          }
        }
        return results;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /**
   * Start the interval and run one cycle immediately.
   * The timer stays referenced so a dedicated worker process does not exit between cycles.
   */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
    void this.runOnce();
  }

  /**
   * Stop the interval. An in-flight cycle is allowed to finish.
   */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
