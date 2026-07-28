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
    const normalizedDescriptionCategoryId = requiredPositiveIdOf(descriptionCategoryId);
    const normalizedTypeId = requiredPositiveIdOf(typeId);
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

  async function getCategoryAttributeValues({
    accountId,
    store,
    descriptionCategoryId,
    typeId,
    attributeId,
    language,
    limit,
  } = {}) {
    const normalizedDescriptionCategoryId = requiredPositiveIdOf(descriptionCategoryId);
    const normalizedTypeId = requiredPositiveIdOf(typeId);
    const normalizedAttributeId = requiredPositiveIdOf(attributeId);
    const normalizedLanguage = normalizedLanguageOf(language);
    const requestedLimit = Number(limit);
    const safeLimit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 5000)
      : 1000;
    const key = cacheKey(
      scopeOf({ accountId, store }),
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
    return writeCache(key, values);
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

  return {
    getCategoryTree,
    getCategoryAttributes,
    getCategoryAttributeValues,
    resolveDescriptionCategoryId,
  };
}
