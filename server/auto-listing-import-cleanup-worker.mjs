const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

function workerError(code, retryable = false) {
  const error = new Error(code === "AUTO_LISTING_IMPORT_CLEANUP_WORKER_FAILED"
    ? "自动上架导入文件清理暂时失败" : code);
  error.code = code;
  error.status = code === "AUTO_LISTING_IMPORT_CLEANUP_WORKER_INVALID" ? 422 : 503;
  error.retryable = retryable;
  return error;
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw workerError("AUTO_LISTING_IMPORT_CLEANUP_WORKER_INVALID");
  return result;
}

function safeLog(logger, event, fields) {
  if (typeof logger?.info !== "function") return;
  try {
    const pending = logger.info(event, fields);
    if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
  } catch { /* best effort */ }
}

export function createAutoListingImportCleanupWorker({
  repository,
  workbookStore,
  workerId = "import-cleanup-v1",
  logger = null,
  accountLimit = 100,
  maxAccountPages = 100,
  batchSize = 20,
  leaseMs = 60_000,
} = {}) {
  const methods = ["listRunnableCleanupAccountIds", "claimObjectCleanup", "prepareObjectCleanup",
    "completeObjectCleanup", "failObjectCleanup"];
  if (!repository || methods.some((method) => typeof repository[method] !== "function")
    || typeof workbookStore?.removeWorkbook !== "function" || !SAFE_ID.test(workerId)
    || !Number.isInteger(accountLimit) || accountLimit < 1 || accountLimit > 100
    || !Number.isInteger(maxAccountPages) || maxAccountPages < 1 || maxAccountPages > 1_000
    || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100
    || !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
    throw workerError("AUTO_LISTING_IMPORT_CLEANUP_WORKER_INVALID");
  }
  return Object.freeze({
    async runOnce() {
      const totals = { accounts: 0, claimed: 0, completed: 0, failed: 0 };
      let afterAccountId = null;
      let accountPages = 0;
      const seenCursors = new Set();
      while (true) {
        accountPages += 1;
        let accountIds;
        try {
          accountIds = await repository.listRunnableCleanupAccountIds({ afterAccountId, limit: accountLimit });
        } catch {
          throw workerError("AUTO_LISTING_IMPORT_CLEANUP_WORKER_FAILED", true);
        }
        if (!Array.isArray(accountIds) || accountIds.length > accountLimit) {
          throw workerError("AUTO_LISTING_IMPORT_CLEANUP_WORKER_INVALID");
        }
        const page = accountIds.map(id);
        const isStrictlyAscending = page.every((accountId, index) => (
          (index === 0 || page[index - 1] < accountId)
          && (afterAccountId === null || accountId > afterAccountId)
        ));
        if (!isStrictlyAscending) {
          throw workerError("AUTO_LISTING_IMPORT_CLEANUP_WORKER_INVALID");
        }
        totals.accounts += page.length;
        for (const accountId of page) {
        let rows;
        try {
          rows = await repository.claimObjectCleanup({ accountId, workerId, limit: batchSize, leaseMs });
        } catch {
          throw workerError("AUTO_LISTING_IMPORT_CLEANUP_WORKER_FAILED", true);
        }
        if (!Array.isArray(rows) || rows.length > batchSize) {
          throw workerError("AUTO_LISTING_IMPORT_CLEANUP_WORKER_INVALID");
        }
        totals.claimed += rows.length;
        for (const row of rows) {
          const rowAccountId = id(row?.accountId);
          const importId = id(row?.importId);
          const cleanupId = id(row?.id);
          const leaseToken = id(row?.leaseToken);
          const objectKey = typeof row?.objectKey === "string" ? row.objectKey.trim() : "";
          if (rowAccountId !== accountId || row?.status !== "PROCESSING" || row?.leaseOwner !== workerId
            || objectKey !== `auto-listing/imports/v1/${accountId}/${importId}/workbook.xlsx`) {
            throw workerError("AUTO_LISTING_IMPORT_CLEANUP_WORKER_INVALID");
          }
          try {
            const decision = await repository.prepareObjectCleanup({
              accountId, id: cleanupId, workerId, leaseToken,
            });
            if (!decision || typeof decision.deleteRequired !== "boolean"
              || decision.cleanup?.accountId !== accountId || decision.cleanup?.id !== cleanupId) {
              throw workerError("AUTO_LISTING_IMPORT_CLEANUP_WORKER_INVALID");
            }
            if (!decision.deleteRequired) {
              totals.completed += 1;
              continue;
            }
            await workbookStore.removeWorkbook({ accountId, importId, objectKey });
            await repository.completeObjectCleanup({
              accountId, id: cleanupId, workerId, leaseToken,
            });
            totals.completed += 1;
          } catch {
            try {
              await repository.failObjectCleanup({
                accountId, id: cleanupId, workerId, leaseToken,
                errorCode: "OBJECT_STORAGE_REMOVE_FAILED",
              });
            } catch {
              throw workerError("AUTO_LISTING_IMPORT_CLEANUP_WORKER_FAILED", true);
            }
            totals.failed += 1;
            safeLog(logger, "auto_listing.import_cleanup_retry_scheduled", {
              accountId, importId, errorCode: "OBJECT_STORAGE_REMOVE_FAILED",
            });
          }
        }
        }
        if (page.length < accountLimit) break;
        const nextCursor = page.at(-1);
        if (!nextCursor || nextCursor === afterAccountId || seenCursors.has(nextCursor)
          || accountPages >= maxAccountPages) {
          throw workerError("AUTO_LISTING_IMPORT_CLEANUP_WORKER_INVALID");
        }
        seenCursors.add(nextCursor);
        afterAccountId = nextCursor;
      }
      return Object.freeze(totals);
    },
  });
}
