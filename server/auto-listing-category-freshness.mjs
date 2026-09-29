import { types } from "node:util";

import { resolveExactType } from "./ozon-taxonomy-category-policy.mjs";

function failure(code, status = 409) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = false;
  error.cause = null;
  return error;
}

function plainData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false;
  try {
    return [Object.prototype, null].includes(Object.getPrototypeOf(value));
  } catch {
    return false;
  }
}

function text(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 240
    ? value : "";
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function exactSource(value, accountId) {
  const evidence = value?.categoryEvidence;
  const shared = value?.sharedCategory;
  if (!plainData(value) || !plainData(evidence) || !plainData(shared)
    || evidence.accountId !== accountId || shared.accountId !== accountId
    || !text(evidence.id) || !text(shared.evidenceId) || !text(shared.id)
    || shared.status !== "ACTIVE" || !positive(shared.version)
    || shared.taxonomyScope !== "OZON:DEFAULT" || evidence.taxonomyScope !== "OZON:DEFAULT"
    || !positive(shared.currentDescriptionCategoryId) || !positive(shared.currentTypeId)
    || !positive(shared.sourceDescriptionCategoryId) || !positive(shared.sourceTypeId)
    || shared.sourceTypeId !== evidence.sourceTypeId
    || shared.sourceDescriptionCategoryId !== evidence.sourceDescriptionCategoryId) {
    throw failure("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED");
  }
  return { evidence, shared };
}

function exactSnapshot(value) {
  if (!plainData(value) || !Array.isArray(value.items) || value.stale === true
    || typeof value.taxonomyFingerprint !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.taxonomyFingerprint)) {
    throw failure("AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE", 422);
  }
  return value;
}

export function createAutoListingCategoryFreshness({
  loadStoreAccess,
  categoryService,
  repository,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof loadStoreAccess !== "function" || typeof now !== "function"
    || !categoryService || typeof categoryService.getCategorySnapshot !== "function"
    || typeof categoryService.getCategoryAttributes !== "function"
    || !repository || typeof repository.invalidateSharedCategory !== "function"
    || typeof repository.activateRefreshedCategory !== "function") {
    throw new TypeError("Auto listing category freshness dependencies are required");
  }

  return async function ensureAutoListingCategoryFresh({ accountId, targetStoreId, sources } = {}) {
    const scope = text(accountId);
    const storeId = text(targetStoreId);
    if (!scope || !storeId || !Array.isArray(sources) || sources.length < 1 || sources.length > 100) {
      throw failure("AUTO_LISTING_REQUEST_INVALID", 400);
    }
    const store = await loadStoreAccess({ accountId: scope, targetStoreId: storeId });
    if (!plainData(store) || store.id !== storeId || store.ownerAccountId !== scope
      || !text(store.clientId) || !text(store.apiKey) || !["RUB", "CNY"].includes(store.currencyCode)) {
      throw failure("AUTO_LISTING_TARGET_STORE_CREDENTIALS_UNAVAILABLE");
    }
    let snapshot;
    try {
      snapshot = exactSnapshot(await categoryService.getCategorySnapshot({
        accountId: scope, store, language: "DEFAULT",
      }));
    } catch (error) {
      if (error?.code === "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE") throw error;
      throw failure("AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE", 422);
    }

    const uniqueShared = new Map();
    for (const rawSource of sources) {
      const current = exactSource(rawSource, scope);
      const previous = uniqueShared.get(current.shared.id);
      if (previous && previous.shared.version !== current.shared.version) {
        throw failure("AUTO_LISTING_SOURCE_VERSION_CONFLICT");
      }
      uniqueShared.set(current.shared.id, current);
    }

    let refreshed = false;
    const blockedSharedCategoryIds = [];
    for (const { evidence, shared } of uniqueShared.values()) {
      const match = resolveExactType({ tree: snapshot.items, sourceTypeId: shared.sourceTypeId });
      if (match.kind !== "UNIQUE_MATCH") {
        blockedSharedCategoryIds.push(shared.id);
        continue;
      }
      if (match.descriptionCategoryId === shared.currentDescriptionCategoryId
        && match.typeId === shared.currentTypeId) continue;
      try {
        const attributes = await categoryService.getCategoryAttributes({
          accountId: scope, store,
          descriptionCategoryId: match.descriptionCategoryId,
          typeId: match.typeId, language: "DEFAULT",
        });
        if (!Array.isArray(attributes?.items) || attributes.items.length < 1
          || attributes.items.length > 1_000) throw new Error("invalid attributes");
      } catch {
        throw failure("AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE", 422);
      }
      const invalidatedAt = new Date(now()).toISOString();
      const invalidated = await repository.invalidateSharedCategory({
        accountId: scope,
        evidenceId: evidence.id,
        expectedVersion: shared.version,
        safeFailureCode: "ZONGZI_CATEGORY_INVALIDATED",
        transitionedAt: invalidatedAt,
      });
      if (!plainData(invalidated) || invalidated.status !== "INVALIDATED"
        || invalidated.version !== shared.version + 1) {
        throw failure("AUTO_LISTING_SOURCE_VERSION_CONFLICT");
      }
      const validatedAt = new Date(now()).toISOString();
      const activated = await repository.activateRefreshedCategory({
        accountId: scope,
        evidenceId: evidence.id,
        expectedVersion: invalidated.version,
        currentDescriptionCategoryId: match.descriptionCategoryId,
        currentTypeId: match.typeId,
        taxonomyFingerprint: snapshot.taxonomyFingerprint,
        validatedAt,
      });
      if (!plainData(activated) || activated.status !== "ACTIVE"
        || activated.source !== "OZON_REFRESH" || activated.version !== invalidated.version + 1
        || activated.currentDescriptionCategoryId !== match.descriptionCategoryId
        || activated.currentTypeId !== match.typeId) {
        throw failure("AUTO_LISTING_SOURCE_VERSION_CONFLICT");
      }
      refreshed = true;
    }
    return Object.freeze({
      status: refreshed ? "REFRESHED" : "CURRENT",
      ...(blockedSharedCategoryIds.length ? {
        blockedSharedCategoryIds: Object.freeze(blockedSharedCategoryIds),
      } : {}),
    });
  };
}
