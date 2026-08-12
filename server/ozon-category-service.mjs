import { callOzonSellerApi as defaultCallOzonSellerApi } from "./ozon-client.mjs";
import {
  TAXONOMY_SCOPE_OZON_DEFAULT,
  taxonomyFingerprint,
} from "./ozon-taxonomy-category-policy.mjs";

export const DEFAULT_CATEGORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const CATEGORY_UNAVAILABLE_MESSAGE = "未能从 Ozon 获取真实类目数据，请重试";

function categoryError(operation, status, code) {
  const error = new Error(CATEGORY_UNAVAILABLE_MESSAGE);
  error.status = status;
  error.code = code;
  error.body = { operation };
  error.cause = null;
  return error;
}

function unavailableError(operation, source) {
  const status = source?.code === "OZON_TIMEOUT"
    ? 504
    : source?.status === 429
      ? 503
      : 502;
  const code = {
    TREE: "OZON_CATEGORY_TREE_UNAVAILABLE",
    ATTRIBUTES: "OZON_CATEGORY_ATTRIBUTES_UNAVAILABLE",
    VALUES: "OZON_CATEGORY_VALUES_UNAVAILABLE",
  }[operation];
  return categoryError(operation, status, code);
}

function normalizedLanguageOf(language) {
  return String(language || "DEFAULT").trim() || "DEFAULT";
}

function positiveIdOf(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function positiveIntegerIdOf(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function requiredPositiveIdOf(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw categoryError("INPUT", 400, "OZON_CATEGORY_DATA_INVALID");
  }
  return id;
}

function findDescriptionCategoryIdByTypeId(tree, typeId) {
  const wantedTypeId = positiveIdOf(typeId);
  if (!wantedTypeId) return 0;

  const visit = (node, parentDescriptionCategoryId = 0) => {
    if (!node) return 0;
    const descriptionCategoryId = positiveIdOf(node.description_category_id) || parentDescriptionCategoryId;
    if (positiveIdOf(node.type_id) === wantedTypeId) return descriptionCategoryId;
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const found = visit(child, descriptionCategoryId);
      if (found) return found;
    }
    return 0;
  };

  for (const root of tree) {
    const found = visit(root);
    if (found) return found;
  }
  return 0;
}

function nodeEnabled(node) {
  return node?.disabled !== true
    && node?.is_disabled !== true
    && node?.isDisabled !== true
    && node?.enabled !== false
    && node?.is_enabled !== false
    && node?.isEnabled !== false;
}

function descriptionCategoryIdOf(node) {
  return positiveIdOf(node?.description_category_id) || positiveIdOf(node?.descriptionCategoryId);
}

function typeIdOf(node) {
  return positiveIdOf(node?.type_id) || positiveIdOf(node?.typeId);
}

function targetInTree(tree, descriptionCategoryId, typeId) {
  const categoryNodes = [];
  let typeExists = false;

  function findType(node, inheritedEnabled) {
    if (!node || typeof node !== "object") return { found: false, enabled: false };
    const enabled = inheritedEnabled && nodeEnabled(node);
    const foundHere = typeIdOf(node) === typeId;
    typeExists ||= foundHere;
    const children = Array.isArray(node.children) ? node.children : [];
    const childResult = children.reduce((result, child) => {
      const candidate = findType(child, enabled);
      return {
        found: result.found || candidate.found,
        enabled: result.enabled || candidate.enabled,
      };
    }, { found: foundHere, enabled: foundHere && enabled });
    return childResult;
  }

  function visit(node, inheritedEnabled = true) {
    if (!node || typeof node !== "object") return;
    const enabled = inheritedEnabled && nodeEnabled(node);
    if (typeIdOf(node) === typeId) typeExists = true;
    if (descriptionCategoryIdOf(node) === descriptionCategoryId) {
      categoryNodes.push({ enabled, type: findType(node, inheritedEnabled) });
      return;
    }
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child, enabled);
  }

  for (const node of Array.isArray(tree) ? tree : []) visit(node);
  if (categoryNodes.length === 0) return "DESCRIPTION_CATEGORY_NOT_FOUND";
  if (categoryNodes.some((candidate) => candidate.enabled && candidate.type.enabled)) return "VALID";
  if (categoryNodes.some((candidate) => candidate.enabled && candidate.type.found)) return "TYPE_DISABLED";
  if (categoryNodes.some((candidate) => candidate.enabled)) {
    return typeExists ? "TYPE_NOT_IN_DESCRIPTION_CATEGORY" : "TYPE_NOT_FOUND";
  }
  return "DESCRIPTION_CATEGORY_DISABLED";
}

export function createOzonCategoryService({
  callOzonSellerApi = defaultCallOzonSellerApi,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_CATEGORY_CACHE_TTL_MS,
} = {}) {
  const cache = new Map();
  const snapshotCache = new Map();
  const scopeEpochs = new Map();
  const requestedCacheTtlMs = Number(cacheTtlMs);
  const effectiveCacheTtlMs = Number.isFinite(requestedCacheTtlMs) && requestedCacheTtlMs > 0
    ? Math.min(requestedCacheTtlMs, DEFAULT_CATEGORY_CACHE_TTL_MS)
    : DEFAULT_CATEGORY_CACHE_TTL_MS;

  function scopeOf({ accountId, store }) {
    const ownerAccountId = String(store?.ownerAccountId || store?.accountId || "");
    if (!accountId || !store?.id || ownerAccountId !== String(accountId)) {
      throw categoryError("SCOPE", 403, "OZON_CATEGORY_STORE_FORBIDDEN");
    }
    return [String(accountId), String(store.id)];
  }

  function cacheKey(...parts) {
    return JSON.stringify(parts);
  }

  function scopeEpochKey(scope) {
    return JSON.stringify(scope);
  }

  function scopeEpoch(scope) {
    return Number(scopeEpochs.get(scopeEpochKey(scope)) || 0);
  }

  function scopeEpochMatches(scope, expectedEpoch) {
    return scopeEpoch(scope) === expectedEpoch;
  }

  function readCache(key) {
    const entry = cache.get(key);
    if (!entry || now() >= entry.expiresAtMs) {
      cache.delete(key);
      return null;
    }
    return {
      items: structuredClone(entry.items),
      meta: { ...entry.meta, source: "OZON_CACHE" },
    };
  }

  function writeCache(key, items, { scope, epoch } = {}) {
    const fetchedAtMs = now();
    const entry = {
      items: structuredClone(items),
      expiresAtMs: fetchedAtMs + effectiveCacheTtlMs,
      meta: {
        source: "OZON_API",
        fetchedAt: new Date(fetchedAtMs).toISOString(),
        expiresAt: new Date(fetchedAtMs + effectiveCacheTtlMs).toISOString(),
      },
    };
    if (!scope || scopeEpochMatches(scope, epoch)) cache.set(key, entry);
    return { items: structuredClone(entry.items), meta: { ...entry.meta } };
  }

  function snapshotInputOf(storeOrInput, language) {
    if (storeOrInput?.store) {
      return {
        accountId: storeOrInput.accountId,
        store: storeOrInput.store,
        language: storeOrInput.language ?? language,
      };
    }
    return {
      accountId: storeOrInput?.ownerAccountId ?? storeOrInput?.accountId,
      store: storeOrInput,
      language,
    };
  }

  function snapshotResult(snapshot, stale, staleReasonCode = null) {
    return {
      items: structuredClone(snapshot.items),
      taxonomyScope: TAXONOMY_SCOPE_OZON_DEFAULT,
      taxonomyFingerprint: snapshot.taxonomyFingerprint,
      fetchedAt: snapshot.fetchedAt,
      stale,
      staleReasonCode,
    };
  }

  function cacheKeyMatchesStore(key, accountId, storeId) {
    try {
      const [scope] = JSON.parse(key);
      return Array.isArray(scope)
        && String(scope[0] || "") === accountId
        && String(scope[1] || "") === storeId;
    } catch {
      return false;
    }
  }

  function invalidateStore({ accountId, storeId } = {}) {
    const normalizedAccountId = String(accountId || "").trim();
    const normalizedStoreId = String(storeId || "").trim();
    if (!normalizedAccountId || !normalizedStoreId) return 0;
    const scope = [normalizedAccountId, normalizedStoreId];
    scopeEpochs.set(scopeEpochKey(scope), scopeEpoch(scope) + 1);
    let removed = 0;
    for (const key of cache.keys()) {
      if (!cacheKeyMatchesStore(key, normalizedAccountId, normalizedStoreId)) continue;
      cache.delete(key);
      removed += 1;
    }
    for (const key of snapshotCache.keys()) {
      if (!cacheKeyMatchesStore(key, normalizedAccountId, normalizedStoreId)) continue;
      snapshotCache.delete(key);
      removed += 1;
    }
    return removed;
  }

  async function getCategoryTree({ accountId, store, language, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw categoryError("INPUT", 400, "OZON_CATEGORY_DATA_INVALID");
    }
    signal?.throwIfAborted();
    const normalizedLanguage = normalizedLanguageOf(language);
    const scope = scopeOf({ accountId, store });
    const epoch = scopeEpoch(scope);
    const key = cacheKey(scope, "tree", normalizedLanguage);
    const cached = readCache(key);
    if (cached) return cached;

    let data;
    try {
      data = await callOzonSellerApi(
        store,
        "/v1/description-category/tree",
        { language: normalizedLanguage },
        120000,
        signal ? { signal } : {},
      );
    } catch (source) {
      throw unavailableError("TREE", source);
    }
    if (!Array.isArray(data?.result) || data.result.length === 0) {
      throw categoryError("TREE", 502, "OZON_CATEGORY_DATA_INVALID");
    }
    return writeCache(key, data.result, { scope, epoch });
  }

  async function getCategoryAttributes({
    accountId,
    store,
    descriptionCategoryId,
    typeId,
    language,
    signal,
  } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw categoryError("INPUT", 400, "OZON_CATEGORY_DATA_INVALID");
    }
    signal?.throwIfAborted();
    const normalizedDescriptionCategoryId = requiredPositiveIdOf(descriptionCategoryId);
    const normalizedTypeId = requiredPositiveIdOf(typeId);
    const normalizedLanguage = normalizedLanguageOf(language);
    const scope = scopeOf({ accountId, store });
    const epoch = scopeEpoch(scope);
    const key = cacheKey(
      scope,
      "attributes",
      normalizedLanguage,
      normalizedDescriptionCategoryId,
      normalizedTypeId,
    );
    const cached = readCache(key);
    if (cached) return cached;

    let data;
    try {
      data = await callOzonSellerApi(
        store,
        "/v1/description-category/attribute",
        {
          description_category_id: normalizedDescriptionCategoryId,
          type_id: normalizedTypeId,
          language: normalizedLanguage,
        },
        60000,
        signal ? { signal } : {},
      );
    } catch (source) {
      throw unavailableError("ATTRIBUTES", source);
    }
    if (!Array.isArray(data?.result)) {
      throw categoryError("ATTRIBUTES", 502, "OZON_CATEGORY_DATA_INVALID");
    }
    return writeCache(key, data.result, { scope, epoch });
  }

  async function getCategoryAttributeValues({
    accountId,
    store,
    descriptionCategoryId,
    typeId,
    attributeId,
    language,
    limit,
    signal,
  } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw categoryError("INPUT", 400, "OZON_CATEGORY_DATA_INVALID");
    }
    signal?.throwIfAborted();
    const normalizedDescriptionCategoryId = requiredPositiveIdOf(descriptionCategoryId);
    const normalizedTypeId = requiredPositiveIdOf(typeId);
    const normalizedAttributeId = requiredPositiveIdOf(attributeId);
    const normalizedLanguage = normalizedLanguageOf(language);
    const requestedLimit = Number(limit);
    const safeLimit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 5000)
      : 1000;
    const scope = scopeOf({ accountId, store });
    const epoch = scopeEpoch(scope);
    const key = cacheKey(
      scope,
      "values",
      normalizedLanguage,
      normalizedDescriptionCategoryId,
      normalizedTypeId,
      normalizedAttributeId,
      safeLimit,
    );
    const cached = readCache(key);
    if (cached) return cached;

    const values = [];
    const seenValues = new Set();
    const seenCursors = new Set();
    let lastValueId = 0;
    while (values.length < safeLimit) {
      const pageLimit = Math.min(1000, safeLimit - values.length);
      let data;
      try {
        data = await callOzonSellerApi(
          store,
          "/v1/description-category/attribute/values",
          {
            description_category_id: normalizedDescriptionCategoryId,
            type_id: normalizedTypeId,
            attribute_id: normalizedAttributeId,
            language: normalizedLanguage,
            limit: pageLimit,
            ...(lastValueId ? { last_value_id: lastValueId } : {}),
          },
          60000,
          signal ? { signal } : {},
        );
      } catch (source) {
        throw unavailableError("VALUES", source);
      }
      const page = Array.isArray(data?.result)
        ? data.result
        : Array.isArray(data?.result?.values)
          ? data.result.values
          : null;
      if (!page) throw categoryError("VALUES", 502, "OZON_CATEGORY_DATA_INVALID");
      if (page.length === 0) break;

      for (const item of page) {
        const id = item?.id ?? item?.dictionary_value_id ?? item?.dictionaryValueId ?? item?.value_id ?? item?.valueId ?? "";
        const value = item?.value ?? item?.name ?? item?.title ?? item?.label ?? "";
        const valueKey = `${id || ""}:${value || ""}`;
        if ((!id && !value) || seenValues.has(valueKey)) continue;
        seenValues.add(valueKey);
        values.push({
          id,
          value,
          info: item?.info ?? "",
          picture: item?.picture ?? "",
        });
        if (values.length === safeLimit) break;
      }

      const lastPageItem = page.at(-1);
      const nextCursor = positiveIdOf(
        lastPageItem?.id ??
          lastPageItem?.dictionary_value_id ??
          lastPageItem?.dictionaryValueId ??
          lastPageItem?.value_id ??
          lastPageItem?.valueId,
      );
      const hasNext = Boolean(data?.has_next || data?.result?.has_next);
      if (hasNext) {
        if (!nextCursor || seenCursors.has(nextCursor)) {
          throw categoryError("VALUES", 502, "OZON_CATEGORY_DATA_INVALID");
        }
        seenCursors.add(nextCursor);
        lastValueId = nextCursor;
      }
      if (!hasNext || values.length === safeLimit) break;
    }
    return writeCache(key, values, { scope, epoch });
  }

  async function resolveDescriptionCategoryId({ accountId, store, typeId, language } = {}) {
    const normalizedTypeId = requiredPositiveIdOf(typeId);
    const { items } = await getCategoryTree({ accountId, store, language });
    const descriptionCategoryId = findDescriptionCategoryIdByTypeId(items, normalizedTypeId);
    if (!descriptionCategoryId) {
      throw categoryError("TYPE", 422, "OZON_CATEGORY_TYPE_NOT_FOUND");
    }
    return descriptionCategoryId;
  }

  async function getCategorySnapshot(storeOrInput, language = "ZH_HANS") {
    const input = snapshotInputOf(storeOrInput, language);
    const normalizedLanguage = normalizedLanguageOf(input.language);
    const scope = scopeOf(input);
    const epoch = scopeEpoch(scope);
    const key = cacheKey(scope, "snapshot", normalizedLanguage);
    const previous = snapshotCache.get(key);
    try {
      const { items, meta } = await getCategoryTree({ ...input, language: normalizedLanguage });
      const snapshot = {
        items: structuredClone(items),
        taxonomyFingerprint: taxonomyFingerprint(items),
        fetchedAt: meta.fetchedAt,
      };
      if (scopeEpochMatches(scope, epoch)) snapshotCache.set(key, snapshot);
      return snapshotResult(snapshot, false);
    } catch (error) {
      if (previous) {
        return snapshotResult(
          previous,
          true,
          String(error?.code || "OZON_CATEGORY_TREE_UNAVAILABLE").trim()
            || "OZON_CATEGORY_TREE_UNAVAILABLE",
        );
      }
      throw error;
    }
  }

  function validationResult({ valid, reasonCode, taxonomyFingerprint: fingerprint = null }) {
    return {
      valid,
      reasonCode,
      taxonomyFingerprint: fingerprint,
      validatedAt: new Date(now()).toISOString(),
    };
  }

  async function validateTarget(storeOrInput, target) {
    const input = snapshotInputOf(storeOrInput, "ZH_HANS");
    const requestedTarget = target ?? (storeOrInput?.store ? storeOrInput : {});
    const descriptionCategoryId = positiveIntegerIdOf(requestedTarget?.descriptionCategoryId);
    const typeId = positiveIntegerIdOf(requestedTarget?.typeId);
    if (!descriptionCategoryId || !typeId) {
      return validationResult({ valid: false, reasonCode: "TARGET_INVALID" });
    }

    let snapshot;
    try {
      snapshot = await getCategorySnapshot(input, input.language);
    } catch {
      return validationResult({ valid: false, reasonCode: "TAXONOMY_UNAVAILABLE" });
    }
    if (snapshot.stale) {
      return validationResult({
        valid: false,
        reasonCode: "TAXONOMY_STALE",
        taxonomyFingerprint: snapshot.taxonomyFingerprint,
      });
    }

    const targetState = targetInTree(snapshot.items, descriptionCategoryId, typeId);
    if (targetState !== "VALID") {
      return validationResult({
        valid: false,
        reasonCode: targetState,
        taxonomyFingerprint: snapshot.taxonomyFingerprint,
      });
    }

    try {
      await getCategoryAttributes({
        ...input,
        descriptionCategoryId,
        typeId,
        language: input.language,
      });
    } catch (error) {
      return validationResult({
        valid: false,
        reasonCode: error?.code === "OZON_CATEGORY_ATTRIBUTES_UNAVAILABLE"
          ? "ATTRIBUTES_UNAVAILABLE"
          : "ATTRIBUTES_INVALID",
        taxonomyFingerprint: snapshot.taxonomyFingerprint,
      });
    }
    return validationResult({
      valid: true,
      reasonCode: "VALID",
      taxonomyFingerprint: snapshot.taxonomyFingerprint,
    });
  }

  return {
    getCategoryTree,
    getCategoryAttributes,
    getCategoryAttributeValues,
    resolveDescriptionCategoryId,
    getCategorySnapshot,
    validateTarget,
    invalidateStore,
  };
}
