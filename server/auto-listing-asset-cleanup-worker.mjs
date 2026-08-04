import { verifyGeneratedAssetObjectKey } from "./auto-listing-asset-store.mjs";

const clean = (value, max = 240) => typeof value === "string" && value.trim() && value === value.trim()
  && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "";
const RUN_KEYS = new Set(["accountId", "workerId", "limit", "leaseMs"]);

function problem() {
  const error = new Error("图片清理任务无效");
  error.code = "AUTO_LISTING_ASSET_CLEANUP_INVALID";
  error.retryable = false;
  return error;
}

function validRun(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== RUN_KEYS.size || Object.keys(input).some((key) => !RUN_KEYS.has(key))
    || !clean(input?.accountId) || !clean(input?.workerId)
    || !Number.isInteger(input?.limit) || input.limit < 1 || input.limit > 100
    || !Number.isInteger(input?.leaseMs) || input.leaseMs < 1 || input.leaseMs > 24 * 60 * 60 * 1000) throw problem();
  return { accountId: input.accountId, workerId: input.workerId, limit: input.limit, leaseMs: input.leaseMs };
}

function safeLog(logger, code) {
  try {
    const pending = logger?.error?.({ code });
    if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
  } catch {}
}

function validClaimedObligation(obligation, request) {
  if (obligation?.accountId !== request.accountId || obligation?.status !== "PROCESSING"
    || obligation?.claimOwner !== request.workerId || !clean(obligation?.id)
    || !clean(obligation?.claimToken) || !clean(obligation?.objectKey, 4096)) return false;
  return verifyGeneratedAssetObjectKey(obligation);
}

function validAdoptedResult(result, obligation, request) {
  const record = result?.record;
  return result?.status === "ADOPTED" && record?.status === "ADOPTED"
    && record.accountId === request.accountId && record.id === obligation.id
    && record.objectKeyVersion === obligation.objectKeyVersion && record.objectKey === obligation.objectKey
    && record.claimToken === null && record.claimOwner === null && record.claimExpiresAt === null
    && clean(record.adoptedGenerationAssetId) && clean(record.adoptedGenerationAssetStatus)
    && Number.isFinite(record.adoptedAt instanceof Date ? record.adoptedAt.getTime()
      : typeof record.adoptedAt === "string" ? Date.parse(record.adoptedAt) : record.adoptedAt);
}

export function createAutoListingAssetCleanupWorker({ repository, storage, logger = null } = {}) {
  if (typeof repository?.claimAssetCleanupObligations !== "function"
    || typeof repository?.adoptAssetCleanupIfReferenced !== "function"
    || typeof repository?.completeAssetCleanup !== "function"
    || typeof repository?.failAssetCleanup !== "function"
    || typeof storage?.removeObject !== "function") throw problem();

  return Object.freeze({
    async run(input) {
      const request = validRun(input);
      const obligations = await repository.claimAssetCleanupObligations(request);
      if (!Array.isArray(obligations) || obligations.length > request.limit) throw problem();
      const summary = { claimed: obligations.length, completed: 0, adopted: 0, failed: 0 };
      for (const obligation of obligations) {
        if (!validClaimedObligation(obligation, request)) {
          summary.failed += 1;
          safeLog(logger, "AUTO_LISTING_ASSET_CLEANUP_CLAIM_INVALID");
          continue;
        }
        const ownership = {
          accountId: request.accountId,
          id: obligation?.id,
          workerId: request.workerId,
          claimToken: obligation?.claimToken,
        };
        let adoption;
        try {
          adoption = await repository.adoptAssetCleanupIfReferenced(ownership);
        } catch {
          summary.failed += 1;
          safeLog(logger, "AUTO_LISTING_ASSET_CLEANUP_ADOPTION_CHECK_FAILED");
          continue;
        }
        if (adoption?.status === "ADOPTED") {
          if (!validAdoptedResult(adoption, obligation, request)) {
            summary.failed += 1;
            safeLog(logger, "AUTO_LISTING_ASSET_CLEANUP_ADOPTION_INVALID");
            continue;
          }
          summary.adopted += 1;
          continue;
        }
        if (!adoption || adoption.status !== "UNREFERENCED" || Object.keys(adoption).length !== 1) {
          summary.failed += 1;
          safeLog(logger, "AUTO_LISTING_ASSET_CLEANUP_ADOPTION_INVALID");
          continue;
        }
        try {
          await storage.removeObject(obligation.objectKey, { accountId: request.accountId });
        } catch {
          summary.failed += 1;
          try {
            await repository.failAssetCleanup({ ...ownership, errorCode: "AUTO_LISTING_ASSET_REMOVE_FAILED" });
          } catch {
            safeLog(logger, "AUTO_LISTING_ASSET_CLEANUP_FAIL_PERSIST_FAILED");
          }
          continue;
        }
        try {
          await repository.completeAssetCleanup(ownership);
          summary.completed += 1;
        } catch {
          summary.failed += 1;
          safeLog(logger, "AUTO_LISTING_ASSET_CLEANUP_COMPLETE_FAILED");
        }
      }
      return Object.freeze(summary);
    },
  });
}
