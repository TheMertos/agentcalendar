export class SyncWorker {
  constructor({ accounts, sync, intervalMs = 300_000 }) {
    this.accounts = accounts;
    this.sync = sync;
    this.intervalMs = intervalMs;
    this.running = null;
    this.timer = null;
    this.locks = new Set();
  }

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

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
    this.timer.unref?.();
    void this.runOnce();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
