const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const INPUT_KEYS = new Set(["accountId", "cleanupId", "workerId"]);

function cleanupError(code, status = 503, retryable = true) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function exactInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).length !== INPUT_KEYS.size
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !INPUT_KEYS.has(key)
      || typeof value[key] !== "string" || !SAFE_ID.test(value[key]))) {
    throw cleanupError("LISTING_ASSET_PUBLICATION_CLEANUP_INVALID", 422, false);
  }
  return value;
}

function safeLog(logger, event) {
  try {
    const pending = logger?.warn?.(Object.freeze(event));
    if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
  } catch {}
}

function samePolicy(task, policy) {
  return policy && policy.publicationVersion === task.publicationVersion
    && policy.baseUrl === task.publicBaseUrl && policy.prefix === task.publicPrefix;
}

export function createListingAssetPublicationCleanupWorker({
  repository,
  removePublicObject,
  resolvePolicy,
  logger = null,
} = {}) {
  if (typeof repository?.claimCleanup !== "function" || typeof repository?.completeCleanup !== "function"
    || typeof repository?.failCleanup !== "function" || typeof removePublicObject !== "function"
    || typeof resolvePolicy !== "function") {
    throw new TypeError("Listing asset publication cleanup dependencies are required");
  }

  async function persistFailure(task, errorCode) {
    try {
      const result = await repository.failCleanup({
        accountId: task.accountId,
        cleanupId: task.id,
        leaseToken: task.leaseToken,
        errorCode,
      });
      if (!result || result.accountId !== task.accountId || result.id !== task.id || result.status !== "PENDING") {
        throw new Error("cleanup failure state not persisted");
      }
      return result;
    } catch {
      safeLog(logger, { code: "LISTING_ASSET_PUBLICATION_CLEANUP_PERSIST_FAILED", stage: "fail", accountId: task.accountId, cleanupId: task.id });
      throw cleanupError("LISTING_ASSET_PUBLICATION_CLEANUP_PERSIST_FAILED");
    }
  }

  return Object.freeze({
    async processCleanup(raw = {}) {
      const input = exactInput(raw);
      let task;
      try { task = await repository.claimCleanup(input); }
      catch {
        safeLog(logger, { code: "LISTING_ASSET_PUBLICATION_CLEANUP_FAILED", stage: "claim", accountId: input.accountId, cleanupId: input.cleanupId });
        throw cleanupError("LISTING_ASSET_PUBLICATION_CLEANUP_FAILED");
      }
      if (!task || task.accountId !== input.accountId || task.id !== input.cleanupId) {
        throw cleanupError("LISTING_ASSET_PUBLICATION_CLEANUP_NOT_FOUND", 404, false);
      }
      if (["REFERENCED", "CLEANED"].includes(task.status)) {
        return Object.freeze({ accountId: task.accountId, cleanupId: task.id, status: task.status, duplicate: true });
      }
      if (task.status !== "DELETING" || task.claimed !== true || !SAFE_ID.test(task.leaseToken || "")) {
        throw cleanupError("LISTING_ASSET_PUBLICATION_CLEANUP_BUSY", 409, true);
      }

      let policy;
      try { policy = await resolvePolicy(task.publicationVersion); } catch {}
      if (!samePolicy(task, policy)) {
        await persistFailure(task, "LISTING_ASSET_PUBLICATION_CLEANUP_POLICY_UNAVAILABLE");
        safeLog(logger, { code: "LISTING_ASSET_PUBLICATION_CLEANUP_POLICY_UNAVAILABLE", stage: "policy", accountId: task.accountId, cleanupId: task.id });
        throw cleanupError("LISTING_ASSET_PUBLICATION_CLEANUP_POLICY_UNAVAILABLE", 503, false);
      }

      try { await removePublicObject({ key: task.publicObjectKey }); }
      catch {
        await persistFailure(task, "LISTING_ASSET_PUBLICATION_CLEANUP_FAILED");
        safeLog(logger, { code: "LISTING_ASSET_PUBLICATION_CLEANUP_FAILED", stage: "remove", accountId: task.accountId, cleanupId: task.id });
        throw cleanupError("LISTING_ASSET_PUBLICATION_CLEANUP_FAILED");
      }

      let completed;
      try {
        completed = await repository.completeCleanup({
          accountId: task.accountId,
          cleanupId: task.id,
          leaseToken: task.leaseToken,
        });
      } catch {
        await persistFailure(task, "LISTING_ASSET_PUBLICATION_CLEANUP_FAILED");
        safeLog(logger, { code: "LISTING_ASSET_PUBLICATION_CLEANUP_FAILED", stage: "complete", accountId: task.accountId, cleanupId: task.id });
        throw cleanupError("LISTING_ASSET_PUBLICATION_CLEANUP_FAILED");
      }
      if (!completed || completed.accountId !== task.accountId || completed.id !== task.id || completed.status !== "CLEANED") {
        await persistFailure(task, "LISTING_ASSET_PUBLICATION_CLEANUP_FAILED");
        throw cleanupError("LISTING_ASSET_PUBLICATION_CLEANUP_FAILED");
      }
      return Object.freeze({ accountId: task.accountId, cleanupId: task.id, status: "CLEANED", duplicate: false });
    },
  });
}
