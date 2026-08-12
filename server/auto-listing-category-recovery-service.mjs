import crypto from "node:crypto";
import { projectOzonImportCarrier } from "./ozon-category-import-error-policy.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const SHARED_KEYS = [
  "accountId", "sourceDescriptionCategoryId", "sourceTypeId", "taxonomyScope",
  "currentDescriptionCategoryId", "currentTypeId", "status", "source",
  "taxonomyFingerprint", "version", "evidenceId", "validatedAt",
];
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

function positive(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sharedCategory(raw) {
  const value = exact(raw, SHARED_KEYS);
  if (!value || !safeId(value.accountId) || !positive(value.sourceDescriptionCategoryId)
    || !positive(value.sourceTypeId) || value.taxonomyScope !== "OZON:DEFAULT"
    || !positive(value.currentDescriptionCategoryId) || !positive(value.currentTypeId)
    || !["ACTIVE", "INVALIDATED", "NEEDS_REVIEW"].includes(value.status)
    || !["SOURCE_DIRECT", "OZON_REFRESH", "MANUAL"].includes(value.source)
    || (value.taxonomyFingerprint !== null
      && (typeof value.taxonomyFingerprint !== "string" || !HASH.test(value.taxonomyFingerprint)))
    || !positive(value.version) || !safeId(value.evidenceId)
    || (value.validatedAt !== null && (typeof value.validatedAt !== "string"
      || Number.isNaN(Date.parse(value.validatedAt))
      || new Date(value.validatedAt).toISOString() !== value.validatedAt))
    || (value.taxonomyFingerprint === null) !== (value.validatedAt === null)
    || (value.source === "SOURCE_DIRECT" && value.taxonomyFingerprint !== null)
    || (value.source !== "SOURCE_DIRECT" && value.taxonomyFingerprint === null)) return null;
  return value;
}

function sharedTransition(raw, previous, expected) {
  const value = sharedCategory(raw);
  if (!value) return null;
  const projected = { ...previous, ...expected };
  return SHARED_KEYS.every((key) => value[key] === projected[key]) ? value : null;
}

function attemptResult(raw, keys, expected) {
  const value = exact(raw, keys);
  if (!value || !safeId(value.attemptId)
    || Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)) return null;
  return value;
}

function claimResult(raw) {
  const value = exact(raw, ["attemptId", "status", "claimed"]);
  if (!value || !safeId(value.attemptId) || typeof value.claimed !== "boolean"
    || (value.claimed && value.status !== "CLAIMED")
    || (!value.claimed && ![
      "CLAIMED", "MATCHED", "RETRY_PENDING", "RETRY_ACCEPTED", "SUCCEEDED", "NEEDS_REVIEW",
    ].includes(value.status))) return null;
  return value;
}

function absenceResult(raw) {
  const value = exact(raw, ["status", "code"]);
  const combinations = new Map([
    ["ABSENT", "OZON_OFFERS_CONFIRMED_ABSENT"],
    ["PRESENT", "OZON_OFFER_PRESENT"],
    ["UNKNOWN", "OZON_OFFER_RECONCILIATION_INVALID"],
    ["UNKNOWN", "OZON_OFFER_RECONCILIATION_UNKNOWN"],
  ]);
  return value && combinations.get(value.status) === value.code ? value : null;
}

function categoryResult(raw) {
  const value = exact(raw, [
    "kind", "descriptionCategoryId", "typeId", "taxonomyFingerprint", "metadata",
  ]);
  if (!value || value.kind !== "UNIQUE_MATCH" || !positive(value.descriptionCategoryId)
    || !positive(value.typeId) || typeof value.taxonomyFingerprint !== "string"
    || !HASH.test(value.taxonomyFingerprint) || !value.metadata
    || typeof value.metadata !== "object" || Array.isArray(value.metadata)) return null;
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
    "existingAttempt", "sharedCategory",
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
  const shared = sharedCategory(value.sharedCategory);
  if (!shared || shared.accountId !== value.accountId
    || shared.evidenceId !== value.sourceEvidenceId) return null;
  if (value.existingAttempt !== null) {
    const existing = exact(value.existingAttempt, ["attemptId", "status", "correlationId"]);
    if (!existing || !safeId(existing.attemptId)
      || existing.correlationId !== request.correlationId
      || !["CLAIMED", "MATCHED", "RETRY_PENDING", "RETRY_ACCEPTED", "SUCCEEDED", "NEEDS_REVIEW"]
        .includes(existing.status)) return null;
  } else if (shared.version !== value.oldSharedCategoryVersion || shared.status !== "ACTIVE") {
    return null;
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
      || !Object.hasOwn(after, "attributes") || !Array.isArray(after.attributes)
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
  const result = attemptResult(await repository.requireCategoryRecoveryReview({
    accountId: request.accountId, jobId: request.jobId, snapshotId: basis.snapshotId,
    evidenceId: request.evidenceId, attemptId: attemptId || null,
    sourceEvidenceId: basis.sourceEvidenceId, oldSharedCategoryId: basis.oldSharedCategoryId,
    oldSharedCategoryVersion: basis.oldSharedCategoryVersion,
    originalOzonTaskId: basis.originalOzonTaskId, correlationId: request.correlationId,
    safeReviewCode: code, transitionedAt: now(),
  }), ["attemptId", "status"], { status: "NEEDS_REVIEW" });
  if (!result || (attemptId !== null && result.attemptId !== attemptId)) {
    throw failure("AUTO_LISTING_CATEGORY_RECOVERY_PORT_INVALID", 409);
  }
  return Object.freeze({ attemptId: result.attemptId, status: result.status });
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
      const basis = recoveryBasis(await repository.loadCategoryRecoveryBasis({
        accountId: request.accountId, jobId: request.jobId, evidenceId: request.evidenceId,
      }), request);
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
        absence = absenceResult(await confirmOfferAbsent({ offers: basis.offers, credential }));
      } catch {
        absence = null;
      }
      if (!absence || absence.status !== "ABSENT") {
        return safeReview(repository, basis, request, null,
          absence?.status === "PRESENT" ? "AUTO_LISTING_CATEGORY_RECOVERY_PRODUCT_PRESENT"
            : "AUTO_LISTING_CATEGORY_RECOVERY_PRODUCT_UNKNOWN", now);
      }
      let attempt;
      try {
        attempt = claimResult(await repository.claimCategoryRecovery({
          accountId: request.accountId, jobId: request.jobId, snapshotId: basis.snapshotId,
          evidenceId: request.evidenceId, sourceEvidenceId: basis.sourceEvidenceId,
          oldSharedCategoryId: basis.oldSharedCategoryId,
          oldSharedCategoryVersion: basis.oldSharedCategoryVersion,
          originalOzonTaskId: basis.originalOzonTaskId, correlationId: request.correlationId,
        }));
        if (!attempt) throw failure("AUTO_LISTING_CATEGORY_RECOVERY_PORT_INVALID", 409);
      } catch {
        throw failure("AUTO_LISTING_CATEGORY_RECOVERY_NOT_ELIGIBLE", 409);
      }
      if (attempt?.claimed === false) {
        return Object.freeze({ attemptId: attempt.attemptId, status: attempt.status });
      }
      let invalidated = false;
      let currentSharedCategoryVersion = basis.oldSharedCategoryVersion;
      let currentSharedCategory = basis.sharedCategory;
      let reviewCode = "AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE";
      try {
        const invalidatedAt = now();
        const invalidation = sharedTransition(await invalidateSharedCategory({
          accountId: request.accountId, evidenceId: basis.sourceEvidenceId,
          expectedVersion: basis.oldSharedCategoryVersion,
          safeFailureCode: "OZON_CATEGORY_INVALIDATED", transitionedAt: invalidatedAt,
        }), currentSharedCategory, {
          accountId: request.accountId, evidenceId: basis.sourceEvidenceId,
          status: "INVALIDATED", version: basis.oldSharedCategoryVersion + 1,
        });
        if (!invalidation) {
          throw failure("AUTO_LISTING_CATEGORY_RECOVERY_INVALIDATION_INVALID", 409);
        }
        invalidated = true;
        currentSharedCategoryVersion = invalidation.version;
        currentSharedCategory = invalidation;
        const category = categoryResult(await refreshCategory({
          accountId: request.accountId, sourceEvidenceId: basis.sourceEvidenceId,
          taxonomyScope: "OZON:DEFAULT",
        }));
        if (!category) {
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
        const validatedAt = now();
        const replacement = sharedTransition(await activateRefreshedCategory({
          accountId: request.accountId, evidenceId: basis.sourceEvidenceId,
          expectedVersion: currentSharedCategoryVersion,
          currentDescriptionCategoryId: category.descriptionCategoryId,
          currentTypeId: category.typeId, taxonomyFingerprint: category.taxonomyFingerprint,
          validatedAt,
        }), currentSharedCategory, {
          accountId: request.accountId, currentDescriptionCategoryId: category.descriptionCategoryId,
          currentTypeId: category.typeId, status: "ACTIVE", source: "OZON_REFRESH",
          taxonomyFingerprint: category.taxonomyFingerprint,
          version: currentSharedCategoryVersion + 1, evidenceId: basis.sourceEvidenceId, validatedAt,
        });
        if (!replacement) {
          reviewCode = "AUTO_LISTING_CATEGORY_RECOVERY_ACTIVATION_INVALID";
          throw failure(reviewCode, 409);
        }
        currentSharedCategoryVersion = replacement.version;
        currentSharedCategory = replacement;
        const correctedItemsHash = stableHash(correctedItems);
        const matched = attemptResult(await repository.saveCategoryRecoveryMatch({
          ...transitionIdentity(basis, request, attempt.attemptId), expectedStatus: "CLAIMED",
          replacementSharedCategoryId: basis.oldSharedCategoryId,
          replacementSharedCategoryVersion: replacement.version,
          correctedItems, correctedItemsHash, transitionedAt: now(),
        }), ["attemptId", "status", "replacementSharedCategoryId",
          "replacementSharedCategoryVersion", "correctedItemsHash"], {
          attemptId: attempt.attemptId, status: "MATCHED",
          replacementSharedCategoryId: basis.oldSharedCategoryId,
          replacementSharedCategoryVersion: replacement.version, correctedItemsHash,
        });
        if (!matched) throw failure("AUTO_LISTING_CATEGORY_RECOVERY_PORT_INVALID", 409);
        const pending = attemptResult(await repository.markCategoryRecoveryRetryPending({
          ...transitionIdentity(basis, request, attempt.attemptId), expectedStatus: "MATCHED",
          transitionedAt: now(),
        }), ["attemptId", "status"], { attemptId: attempt.attemptId, status: "RETRY_PENDING" });
        if (!pending) throw failure("AUTO_LISTING_CATEGORY_RECOVERY_PORT_INVALID", 409);
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
          const reviewedAt = now();
          const sharedReview = sharedTransition(await markSharedNeedsReview({
            accountId: request.accountId, evidenceId: basis.sourceEvidenceId,
            expectedVersion: currentSharedCategoryVersion,
            safeFailureCode: "OZON_CATEGORY_NEEDS_REVIEW", transitionedAt: reviewedAt,
          }), currentSharedCategory, {
            accountId: request.accountId, evidenceId: basis.sourceEvidenceId,
            status: "NEEDS_REVIEW", version: currentSharedCategoryVersion + 1,
          });
          if (!sharedReview) throw failure("AUTO_LISTING_CATEGORY_RECOVERY_PORT_INVALID", 409);
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
