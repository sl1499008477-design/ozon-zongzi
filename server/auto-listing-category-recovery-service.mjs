import crypto from "node:crypto";
import { projectOzonImportCarrier } from "./ozon-category-import-error-policy.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const IMMUTABLE_EXCEPT = new Set([
  "description_category_id", "descriptionCategoryId", "type_id", "typeId", "attributes",
]);

function failure(code, status = 422) {
  const error = new Error("自动类目恢复条件不完整");
  error.code = code;
  error.status = status;
  error.retryable = false;
  error.cause = null;
  return error;
}

function safeId(value) {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

function exact(raw, keys) {
  const value = projectOzonImportCarrier(raw);
  if (!value || Array.isArray(value)) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) return null;
  return value;
}

function command(raw) {
  const value = exact(raw, ["accountId", "jobId", "evidenceId", "correlationId"]);
  if (!value || ![value.accountId, value.jobId, value.evidenceId, value.correlationId].every(safeId)) {
    throw failure("AUTO_LISTING_CATEGORY_RECOVERY_INVALID");
  }
  return value;
}

function evidence(value, basis) {
  const result = exact(value, [
    "schemaVersion", "policyVersion", "errorCode", "field", "attributeId", "state",
    "offerId", "productId", "classification",
  ]);
  if (!result || result.schemaVersion !== "OZON_CATEGORY_IMPORT_ERROR_EVIDENCE_V1"
    || result.policyVersion !== basis.policyVersion || result.classification !== "EXPLICIT_CATEGORY_FAILURE"
    || result.state !== "FAILED" || result.productId !== null
    || !safeId(result.errorCode) || typeof result.field !== "string" || result.field.length < 1
    || result.field.length > 240 || (result.attributeId !== null
      && (!Number.isSafeInteger(result.attributeId) || result.attributeId < 1))) return null;
  return result;
}

function recoveryBasis(raw, request) {
  const value = exact(raw, [
    "accountId", "jobId", "snapshotId", "evidenceId", "policyVersion", "classification",
    "productId", "originalOzonTaskId", "sourceEvidenceId", "oldSharedCategoryId",
    "oldSharedCategoryVersion", "offers", "frozenItems", "safeEvidence",
    "existingAttempt",
  ]);
  if (!value || value.accountId !== request.accountId || value.jobId !== request.jobId
    || value.evidenceId !== request.evidenceId || !safeId(value.snapshotId)
    || !safeId(value.originalOzonTaskId) || !safeId(value.sourceEvidenceId)
    || !safeId(value.oldSharedCategoryId) || !safeId(value.policyVersion)
    || value.classification !== "EXPLICIT_CATEGORY_FAILURE" || value.productId !== null
    || !Number.isSafeInteger(value.oldSharedCategoryVersion) || value.oldSharedCategoryVersion < 1
    || !Array.isArray(value.offers) || value.offers.length < 1 || value.offers.length > 100
    || !Array.isArray(value.frozenItems) || value.frozenItems.length !== value.offers.length
    || !evidence(value.safeEvidence, value)) return null;
  if (value.existingAttempt !== null) {
    const existing = exact(value.existingAttempt, ["attemptId", "status"]);
    if (!existing || !safeId(existing.attemptId)
      || !["CLAIMED", "MATCHED", "RETRY_PENDING", "RETRY_ACCEPTED", "SUCCEEDED", "NEEDS_REVIEW"]
        .includes(existing.status)) return null;
  }
  const seen = new Set();
  for (let index = 0; index < value.offers.length; index += 1) {
    const offer = exact(value.offers[index], ["offerId", "sku"]);
    const item = value.frozenItems[index];
    if (!offer || !safeId(offer.offerId) || typeof offer.sku !== "string" || offer.sku.length > 240
      || seen.has(offer.offerId) || !item || Array.isArray(item)
      || item.offer_id !== offer.offerId || String(item.sku ?? "") !== offer.sku) return null;
    seen.add(offer.offerId);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
  return value;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function immutableProjection(item) {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !IMMUTABLE_EXCEPT.has(key)));
}

function validCorrection(original, corrected, category) {
  const projected = projectOzonImportCarrier(corrected);
  if (!Array.isArray(projected) || projected.length !== original.length) return null;
  for (let index = 0; index < original.length; index += 1) {
    const before = original[index];
    const after = projected[index];
    if (!after || Array.isArray(after)
      || after.description_category_id !== category.descriptionCategoryId
      || after.type_id !== category.typeId
      || (Object.hasOwn(after, "descriptionCategoryId")
        && after.descriptionCategoryId !== category.descriptionCategoryId)
      || (Object.hasOwn(after, "typeId") && after.typeId !== category.typeId)
      || JSON.stringify(immutableProjection(after)) !== JSON.stringify(immutableProjection(before))) return null;
  }
  return projected;
}

async function safeReview(repository, basis, request, attemptId, code, now) {
  const result = await repository.requireCategoryRecoveryReview({
    accountId: request.accountId, jobId: request.jobId, snapshotId: basis.snapshotId,
    evidenceId: request.evidenceId, attemptId: attemptId || null,
    sourceEvidenceId: basis.sourceEvidenceId, oldSharedCategoryId: basis.oldSharedCategoryId,
    oldSharedCategoryVersion: basis.oldSharedCategoryVersion,
    originalOzonTaskId: basis.originalOzonTaskId, correlationId: request.correlationId,
    safeReviewCode: code, transitionedAt: now(),
  });
  return Object.freeze({ attemptId: result.attemptId, status: "NEEDS_REVIEW" });
}

function transitionIdentity(basis, request, attemptId) {
  return {
    accountId: request.accountId,
    jobId: request.jobId,
    snapshotId: basis.snapshotId,
    evidenceId: request.evidenceId,
    attemptId,
    sourceEvidenceId: basis.sourceEvidenceId,
    oldSharedCategoryId: basis.oldSharedCategoryId,
    oldSharedCategoryVersion: basis.oldSharedCategoryVersion,
    originalOzonTaskId: basis.originalOzonTaskId,
    correlationId: request.correlationId,
  };
}

export function createAutoListingCategoryRecoveryService({
  repository,
  loadOperatingStoreAccess,
  confirmOfferAbsent,
  invalidateSharedCategory,
  refreshCategory,
  rebuildItems,
  activateRefreshedCategory,
  markSharedNeedsReview,
  scheduleRetry,
  now = () => new Date().toISOString(),
} = {}) {
  if (!repository || [loadOperatingStoreAccess, confirmOfferAbsent, invalidateSharedCategory,
    refreshCategory, rebuildItems, activateRefreshedCategory, markSharedNeedsReview,
    scheduleRetry].some((port) => typeof port !== "function")) {
    throw new TypeError("category recovery ports are required");
  }
  return Object.freeze({
    async recover(rawRequest) {
      const request = command(rawRequest);
      const basis = recoveryBasis(await repository.loadCategoryRecoveryBasis(request), request);
      if (!basis) throw failure("AUTO_LISTING_CATEGORY_RECOVERY_NOT_ELIGIBLE", 409);
      if (basis.existingAttempt !== null) {
        return Object.freeze({
          attemptId: basis.existingAttempt.attemptId, status: basis.existingAttempt.status,
        });
      }
      let absence;
      try {
        const credential = await loadOperatingStoreAccess({
          accountId: request.accountId, jobId: request.jobId, snapshotId: basis.snapshotId,
        });
        absence = await confirmOfferAbsent({ offers: basis.offers, credential });
      } catch {
        absence = { status: "UNKNOWN" };
      }
      if (!absence || absence.status !== "ABSENT") {
        return safeReview(repository, basis, request, null,
          absence?.status === "PRESENT" ? "AUTO_LISTING_CATEGORY_RECOVERY_PRODUCT_PRESENT"
            : "AUTO_LISTING_CATEGORY_RECOVERY_PRODUCT_UNKNOWN", now);
      }
      let attempt;
      try {
        attempt = await repository.claimCategoryRecovery({
          accountId: request.accountId, jobId: request.jobId, snapshotId: basis.snapshotId,
          evidenceId: request.evidenceId, sourceEvidenceId: basis.sourceEvidenceId,
          oldSharedCategoryId: basis.oldSharedCategoryId,
          oldSharedCategoryVersion: basis.oldSharedCategoryVersion,
          originalOzonTaskId: basis.originalOzonTaskId, correlationId: request.correlationId,
        });
      } catch {
        return safeReview(repository, basis, request, null,
          "AUTO_LISTING_CATEGORY_RECOVERY_ALREADY_ATTEMPTED", now);
      }
      if (attempt?.claimed === false) {
        return Object.freeze({ attemptId: attempt.attemptId, status: attempt.status });
      }
      let invalidated = false;
      let currentSharedCategoryVersion = basis.oldSharedCategoryVersion;
      let reviewCode = "AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE";
      try {
        const invalidation = await invalidateSharedCategory({
          accountId: request.accountId, evidenceId: basis.sourceEvidenceId,
          expectedVersion: basis.oldSharedCategoryVersion,
          safeFailureCode: basis.safeEvidence.errorCode, transitionedAt: now(),
        });
        if (!invalidation || invalidation.status !== "INVALIDATED"
          || !Number.isSafeInteger(invalidation.version)
          || invalidation.version <= basis.oldSharedCategoryVersion) {
          throw failure("AUTO_LISTING_CATEGORY_RECOVERY_INVALIDATION_INVALID", 409);
        }
        invalidated = true;
        currentSharedCategoryVersion = invalidation.version;
        const category = await refreshCategory({
          accountId: request.accountId, sourceEvidenceId: basis.sourceEvidenceId,
          taxonomyScope: "OZON:DEFAULT",
        });
        if (!category || category.kind !== "UNIQUE_MATCH"
          || !Number.isSafeInteger(category.descriptionCategoryId) || category.descriptionCategoryId < 1
          || !Number.isSafeInteger(category.typeId) || category.typeId < 1
          || typeof category.taxonomyFingerprint !== "string"
          || !/^[0-9a-f]{64}$/u.test(category.taxonomyFingerprint)) {
          reviewCode = "AUTO_LISTING_CATEGORY_RECOVERY_MATCH_AMBIGUOUS";
          throw failure(reviewCode, 409);
        }
        const rebuilt = await rebuildItems({
          originalItems: basis.frozenItems, sourceEvidenceId: basis.sourceEvidenceId,
          replacementCategory: category, currentCategoryMetadata: category.metadata,
        });
        const correctedItems = validCorrection(basis.frozenItems, rebuilt, category);
        if (!correctedItems) {
          reviewCode = "AUTO_LISTING_CATEGORY_RECOVERY_CORRECTION_INVALID";
          throw failure(reviewCode, 409);
        }
        const replacement = await activateRefreshedCategory({
          accountId: request.accountId, evidenceId: basis.sourceEvidenceId,
          expectedVersion: currentSharedCategoryVersion,
          currentDescriptionCategoryId: category.descriptionCategoryId,
          currentTypeId: category.typeId, taxonomyFingerprint: category.taxonomyFingerprint,
          validatedAt: now(),
        });
        if (!replacement || !safeId(replacement.id) || !Number.isSafeInteger(replacement.version)
          || replacement.version <= currentSharedCategoryVersion || replacement.status !== "ACTIVE") {
          reviewCode = "AUTO_LISTING_CATEGORY_RECOVERY_ACTIVATION_INVALID";
          throw failure(reviewCode, 409);
        }
        currentSharedCategoryVersion = replacement.version;
        const correctedItemsHash = stableHash(correctedItems);
        await repository.saveCategoryRecoveryMatch({
          ...transitionIdentity(basis, request, attempt.attemptId), expectedStatus: "CLAIMED",
          replacementSharedCategoryId: replacement.id,
          replacementSharedCategoryVersion: replacement.version,
          correctedItems, correctedItemsHash, transitionedAt: now(),
        });
        const pending = await repository.markCategoryRecoveryRetryPending({
          ...transitionIdentity(basis, request, attempt.attemptId), expectedStatus: "MATCHED",
          transitionedAt: now(),
        });
        try {
          await scheduleRetry({
            accountId: request.accountId, jobId: request.jobId, snapshotId: basis.snapshotId,
            attemptId: attempt.attemptId, correctedItemsHash, correlationId: request.correlationId,
          });
        } catch {}
        return Object.freeze({ attemptId: pending.attemptId, status: "RETRY_PENDING" });
      } catch {}
      let failClosed = false;
      if (invalidated) {
        try {
          await markSharedNeedsReview({
            accountId: request.accountId, evidenceId: basis.sourceEvidenceId,
            expectedVersion: currentSharedCategoryVersion,
            safeFailureCode: reviewCode, transitionedAt: now(),
          });
        } catch { failClosed = true; }
      }
      let reviewed;
      try {
        reviewed = await safeReview(repository, basis, request, attempt.attemptId,
          reviewCode, now);
      } catch {
        failClosed = true;
      }
      if (failClosed) throw failure("AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE", 409);
      return reviewed;
    },
  });
}
