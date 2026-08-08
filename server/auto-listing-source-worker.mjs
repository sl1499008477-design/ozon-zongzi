const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

function workerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw workerError("AUTO_LISTING_SOURCE_WORKER_INVALID");
  return result;
}

function boundedText(value, maximum, { recordId = false } = {}) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)
    || (recordId && /[/\\]/u.test(result))) {
    throw workerError("AUTO_LISTING_SOURCE_WORKER_INVALID");
  }
  return result;
}

function safeClaim(value, accountId) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.accountId !== accountId || value.state !== "PROCESSING"
    || !Number.isInteger(value.attempts) || value.attempts < 1
    || !Number.isInteger(value.stateVersion) || value.stateVersion < 1
    || !Number.isInteger(value.leaseGeneration) || value.leaseGeneration < 1) {
    throw workerError("AUTO_LISTING_SOURCE_WORKER_INVALID");
  }
  return {
    id: id(value.id), accountId, importFileId: id(value.importFileId), rowId: id(value.rowId),
    sku: boundedText(value.sku, 160), leaseToken: id(value.leaseToken), attempts: value.attempts,
  };
}

function persistedItemId(result) {
  if (!result || result.scraped !== true || !result.item || typeof result.item !== "object"
    || Array.isArray(result.item)) throw workerError("AUTO_LISTING_SOURCE_RESULT_INVALID");
  return boundedText(result.item.id, 240, { recordId: true });
}

export function createAutoListingSourceWorker({ workerId, repository, collectSku } = {}) {
  const stableWorkerId = id(workerId);
  if (typeof repository?.claimNext !== "function" || typeof repository?.completeCollection !== "function"
    || typeof repository?.failCollection !== "function" || typeof collectSku !== "function") {
    throw new TypeError("Auto-listing source worker dependencies are required");
  }
  return Object.freeze({
    async processAccount(input = {}) {
      const accountId = id(input.accountId);
      const limit = input.limit ?? 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw workerError("AUTO_LISTING_SOURCE_WORKER_INVALID");
      const totals = { claimed: 0, completed: 0, retried: 0, dead: 0 };
      for (let index = 0; index < limit; index += 1) {
        const raw = await repository.claimNext({ accountId, workerId: stableWorkerId, leaseSeconds: 120 });
        if (!raw) break;
        const claim = safeClaim(raw, accountId);
        totals.claimed += 1;
        let result;
        try {
          result = await collectSku({ account: { id: accountId, role: "user" }, sku: claim.sku });
          if (!result || typeof result !== "object" || Array.isArray(result)
            || typeof result.scraped !== "boolean") {
            throw workerError("AUTO_LISTING_SOURCE_RESULT_INVALID");
          }
          if (result?.scraped !== true) {
            const code = result?.code === "OZON_SKU_SCRAPE_EMPTY"
              ? "OZON_SKU_SCRAPE_EMPTY" : "OZON_SKU_COLLECTION_FAILED";
            const failed = await repository.failCollection({
              accountId, outboxId: claim.id, rowId: claim.rowId, leaseToken: claim.leaseToken,
              errorCode: code, retryable: true,
            });
            totals[failed?.state === "DEAD" ? "dead" : "retried"] += 1;
            continue;
          }
        } catch (error) {
          const stableCode = error?.code === "AUTO_LISTING_SOURCE_RESULT_INVALID"
            ? error.code : "OZON_SKU_COLLECTION_FAILED";
          const failed = await repository.failCollection({
            accountId, outboxId: claim.id, rowId: claim.rowId, leaseToken: claim.leaseToken,
            errorCode: stableCode, retryable: stableCode !== "AUTO_LISTING_SOURCE_RESULT_INVALID",
          });
          totals[failed?.state === "DEAD" ? "dead" : "retried"] += 1;
          continue;
        }
        let collectItemId;
        try { collectItemId = persistedItemId(result); } catch {
          const failed = await repository.failCollection({
            accountId, outboxId: claim.id, rowId: claim.rowId, leaseToken: claim.leaseToken,
            errorCode: "AUTO_LISTING_SOURCE_RESULT_INVALID", retryable: false,
          });
          totals[failed?.state === "DEAD" ? "dead" : "retried"] += 1;
          continue;
        }
        await repository.completeCollection({
          accountId, outboxId: claim.id, rowId: claim.rowId, leaseToken: claim.leaseToken, collectItemId,
        });
        totals.completed += 1;
      }
      return Object.freeze(totals);
    },
  });
}
