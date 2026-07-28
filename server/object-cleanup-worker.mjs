import { processPendingObjectDeletions } from "./object-cleanup-queue.mjs";

export function createObjectCleanupWorker({
  loadState,
  saveState,
  removeObject,
  logger = console,
}) {
  let running = false;

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
      const latest = state || await loadState();
      const cleanup = await processPendingObjectDeletions(latest, removeObject);
      if (cleanup.attempted > 0) await saveState(latest);
      return cleanup;
    } finally {
      running = false;
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
    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    };
  }

  return Object.freeze({ drain, start });
}
