import { callOzonSellerApi as defaultCallOzonSellerApi } from "./ozon-client.mjs";

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

export function createOzonCategoryService({
  callOzonSellerApi = defaultCallOzonSellerApi,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_CATEGORY_CACHE_TTL_MS,
} = {}) {
  const cache = new Map();
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

  function writeCache(key, items) {
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
    cache.set(key, entry);
    return { items: structuredClone(entry.items), meta: { ...entry.meta } };
  }

  async function getCategoryTree({ accountId, store, language } = {}) {
    const normalizedLanguage = normalizedLanguageOf(language);
    const key = cacheKey(scopeOf({ accountId, store }), "tree", normalizedLanguage);
    const cached = readCache(key);
    if (cached) return cached;

    let data;
    try {
      data = await callOzonSellerApi(
        store,
        "/v1/description-category/tree",
        { language: normalizedLanguage },
        120000,
      );
    } catch (source) {
      throw unavailableError("TREE", source);
    }
    if (!Array.isArray(data?.result) || data.result.length === 0) {
      throw categoryError("TREE", 502, "OZON_CATEGORY_DATA_INVALID");
    }
    return writeCache(key, data.result);
  }

  async function getCategoryAttributes({
    accountId,
    store,
    descriptionCategoryId,
    typeId,
    language,
  } = {}) {
    const normalizedDescriptionCategoryId = positiveIdOf(descriptionCategoryId);
    const normalizedTypeId = positiveIdOf(typeId);
    const normalizedLanguage = normalizedLanguageOf(language);
    const key = cacheKey(
      scopeOf({ accountId, store }),
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
      );
    } catch (source) {
      throw unavailableError("ATTRIBUTES", source);
    }
    if (!Array.isArray(data?.result)) {
      throw categoryError("ATTRIBUTES", 502, "OZON_CATEGORY_DATA_INVALID");
    }
    return writeCache(key, data.result);
  }

  async function getCategoryAttributeValues() {
    throw categoryError("VALUES", 502, "OZON_CATEGORY_VALUES_UNAVAILABLE");
  }

  async function resolveDescriptionCategoryId({ accountId, store, typeId, language } = {}) {
    const { items } = await getCategoryTree({ accountId, store, language });
    return findDescriptionCategoryIdByTypeId(items, typeId);
  }

  return {
    getCategoryTree,
    getCategoryAttributes,
    getCategoryAttributeValues,
    resolveDescriptionCategoryId,
  };
}
