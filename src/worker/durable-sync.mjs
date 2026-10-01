/**
 * Remote-only mode does not start calendar sync or auto-upload.
 * @returns {{ worker: null, syncEnabled: false, stop: () => void }} Disabled worker.
 */
export function startDurableSyncWorker() {
  return {
    worker: null,
    syncEnabled: false,
    /**
     * No interval was started.
     * @returns {void}
     */
    stop() {}
  };
}
