import { processPendingObjectDeletions } from "./object-cleanup-queue.mjs";

export function createObjectCleanupWorker({
  loadState,
  saveState,
  stateTransaction,
  removeObject,
  logger = console,
}) {
  let running = false;
  let active = null;
  const runStateTransaction = typeof stateTransaction?.run === "function"
    ? (operation) => stateTransaction.run(operation)
    : (operation) => operation();

  async function drain(state = null) {
    if (running) {
      return {
        attempted: 0,
        deleted: 0,
        failed: 0,
        pending: Array.isArray(state?.pendingObjectDeletions)
          ? state.pendingObjectDeletions.length
          : 0,
      };
    }
    running = true;
    try {
      active = runStateTransaction(async () => {
        const latest = state || await loadState({ hydrateCatalog: false });
        const cleanup = await processPendingObjectDeletions(latest, removeObject);
        if (cleanup.attempted > 0) await saveState(latest);
        return cleanup;
      });
      return await active;
    } finally {
      running = false;
      active = null;
    }
  }

  function start({
    initialDelayMs = 5000,
    intervalMs = 5 * 60 * 1000,
  } = {}) {
    const run = () => {
      drain().catch((error) => {
        logger.error(`对象清理重试失败：${String(error?.message || error).slice(0, 240)}`);
      });
    };
    const initialTimer = setTimeout(run, initialDelayMs);
    initialTimer.unref?.();
    const intervalTimer = setInterval(run, intervalMs);
    intervalTimer.unref?.();
    return async () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
      await active;
    };
  }

  return Object.freeze({ drain, start });
}
