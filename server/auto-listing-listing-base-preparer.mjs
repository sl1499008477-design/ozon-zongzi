import crypto from "node:crypto";

import { normalizeOzonImportItems } from "./ozon-import-normalizer.mjs";
import { rebuildOzonItemsForCategory } from "./ozon-category-item-rebuilder.mjs";
import { buildOzonCategoryRebuildMetadata } from "./ozon-category-service.mjs";
import { normalizeAutoListingCurrency } from "./auto-listing-currency.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const RICH_CONTENT_ATTRIBUTE_ID = 11254;

function failure(code, status = 422) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = false;
  error.cause = null;
  return error;
}

const text = (value) => typeof value === "string" ? value.trim() : "";
const plainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : plainObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function productDraftEvidence(source, fallbackVersions) {
  const draft = source?.productDraft;
  if (!plainObject(draft) || !text(draft.id) || !Number.isSafeInteger(draft.version) || draft.version < 1
    || !HASH.test(draft.dataHash || "")) {
    throw failure("AUTO_LISTING_PRODUCT_DRAFT_REQUIRED", 409);
  }
  const normalizerVersion = text(draft.normalizerVersion) || fallbackVersions.normalizerVersion;
  const categoryRuleVersion = text(draft.categoryRuleVersion) || fallbackVersions.categoryRuleVersion;
  const dictionaryVersion = text(draft.dictionaryVersion) || fallbackVersions.dictionaryVersion;
  if (!normalizerVersion || !categoryRuleVersion || !dictionaryVersion) {
    throw failure("AUTO_LISTING_PRODUCT_DRAFT_REQUIRED", 409);
  }
  return {
    productDraft: { id: text(draft.id), version: draft.version, dataHash: draft.dataHash },
    versions: {
      normalizerVersion,
      categoryRuleVersion,
      dictionaryVersion,
    },
  };
}

function priceEvidence(value) {
  const currency = normalizeAutoListingCurrency(value?.currency);
  const currencySource = value?.currencySource;
  const legacy = currencySource === undefined && currency === "RUB";
  if (!plainObject(value) || !currency
    || (!legacy && !["SOURCE", "TARGET_STORE"].includes(currencySource))
    || typeof value.blackKopecks !== "string" || !/^\d{1,30}$/u.test(value.blackKopecks)
    || !(value.greenKopecks === null || (typeof value.greenKopecks === "string" && /^\d{1,30}$/u.test(value.greenKopecks)))) {
    throw failure("AUTO_LISTING_PRICE_EVIDENCE_INVALID");
  }
  const evidence = {
    currency,
    ...(legacy ? {} : { currencySource }),
    blackKopecks: value.blackKopecks,
    greenKopecks: value.greenKopecks,
  };
  return { ...evidence, evidenceHash: digest(evidence) };
}

function defaultRawItems(source, { currencyCode } = {}) {
  const collectItem = plainObject(source?.collectItem) ? source.collectItem : {};
  const draft = plainObject(collectItem.listingDraft) ? collectItem.listingDraft : {};
  const records = Array.isArray(draft.variants) && draft.variants.length ? draft.variants : [draft];
  return records.map((record, index) => {
    if (!plainObject(record)) throw failure("AUTO_LISTING_LISTING_BASE_INCOMPLETE");
    const sku = text(record.sku || record.sourceSku || record.source_sku || (index === 0 ? draft.sku : ""));
    const merged = {
      ...structuredClone(draft),
      ...structuredClone(record),
      sku,
      scraped_sku: sku,
      offer_id: record.offer_id || record.offerId || sku,
      currency_code: currencyCode,
      currencyCode,
    };
    delete merged.variants;
    return merged;
  });
}

function attributeId(attribute) {
  const value = Number(attribute?.id ?? attribute?.attribute_id ?? attribute?.attributeId);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function positiveId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : 0;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return 0;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : 0;
}

function normalizedAttributeKeys(items) {
  const keys = new Set();
  const include = (attribute) => {
    const id = positiveId(attribute?.id);
    const complexId = positiveId(attribute?.complex_id) || 0;
    if (id) keys.add(`${complexId}:${id}`);
  };
  for (const item of items) {
    for (const attribute of Array.isArray(item.attributes) ? item.attributes : []) include(attribute);
    for (const group of Array.isArray(item.complex_attributes) ? item.complex_attributes : []) {
      for (const attribute of Array.isArray(group?.attributes) ? group.attributes : []) include(attribute);
    }
  }
  return keys;
}

function sourceVariant(raw, normalized, index) {
  const sourceSku = text(raw?.sku || raw?.sourceSku || raw?.source_sku || raw?.scraped_sku);
  const sourceVariantId = text(raw?.offer_id || raw?.offerId || sourceSku || String(index + 1));
  if (!sourceSku || !sourceVariantId) throw failure("AUTO_LISTING_LISTING_BASE_INCOMPLETE");
  return { sourceVariantId, sourceSku, item: normalized };
}

function exactTargetCategory(value) {
  const positive = (nested) => /^[1-9][0-9]*$/u.test(String(nested ?? ""))
    && Number.isSafeInteger(Number(nested));
  if (!plainObject(value)
    || value.schemaVersion !== "AUTO_LISTING_ACCOUNT_CATEGORY_V2"
    || !text(value.evidenceId) || !text(value.sharedCategoryId)
    || !Number.isSafeInteger(value.sharedCategoryVersion) || value.sharedCategoryVersion < 1
    || !positive(value.sourceDescriptionCategoryId) || !positive(value.sourceTypeId)
    || !positive(value.descriptionCategoryId) || !positive(value.typeId)
    || value.taxonomyScope !== "OZON:DEFAULT"
    || !(value.taxonomyFingerprint === "" || HASH.test(value.taxonomyFingerprint || ""))
    || !["SOURCE_DIRECT", "OZON_REFRESH", "MANUAL"].includes(value.provenance)) {
    throw failure("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", 409);
  }
  return Object.freeze(structuredClone(value));
}

function assertDependencies({ loadStoreAccess, categoryService, normalizeItems, buildRawItems }) {
  if (typeof loadStoreAccess !== "function" || typeof normalizeItems !== "function" || typeof buildRawItems !== "function"
    || !categoryService || ["getCategoryAttributes", "getCategoryAttributeValues"]
      .some((key) => typeof categoryService[key] !== "function")) {
    throw new TypeError("Auto listing base preparer dependencies are required");
  }
}

export function createAutoListingListingBasePreparer({
  loadStoreAccess,
  categoryService,
  normalizeItems = normalizeOzonImportItems,
  buildRawItems = defaultRawItems,
  versions = {
    normalizerVersion: "v3",
    categoryRuleVersion: "2026-07-v1",
    dictionaryVersion: "live-api",
  },
} = {}) {
  assertDependencies({ loadStoreAccess, categoryService, normalizeItems, buildRawItems });
  const fallbackVersions = {
    normalizerVersion: text(versions?.normalizerVersion),
    categoryRuleVersion: text(versions?.categoryRuleVersion),
    dictionaryVersion: text(versions?.dictionaryVersion),
  };
  if (Object.values(fallbackVersions).some((value) => !value)) {
    throw new TypeError("Auto listing base preparer versions are required");
  }

  return async function prepareAutoListingListingBase({
    accountId, source, targetStore, targetCategory, pricingEvidence, signal,
  } = {}) {
    const scope = text(accountId);
    const targetStoreId = text(targetStore?.id);
    const ownerAccountId = text(targetStore?.ownerAccountId || targetStore?.accountId);
    if (!scope || !targetStoreId || ownerAccountId !== scope) throw failure("AUTO_LISTING_TARGET_STORE_FORBIDDEN", 403);
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw failure("AUTO_LISTING_CATEGORY_LEASE_INVALID", 500);
    }
    signal?.throwIfAborted();
    const { productDraft, versions: frozenVersions } = productDraftEvidence(source, fallbackVersions);
    const frozenPriceEvidence = priceEvidence(pricingEvidence);
    const category = exactTargetCategory(targetCategory);
    const storeAccess = await loadStoreAccess({ accountId: scope, targetStoreId });
    const storeCurrency = normalizeAutoListingCurrency(storeAccess?.currencyCode || storeAccess?.currency_code || storeAccess?.currency);
    if (!plainObject(storeAccess) || text(storeAccess.id) !== targetStoreId
      || text(storeAccess.ownerAccountId || storeAccess.accountId) !== scope
      || !text(storeAccess.clientId) || !text(storeAccess.apiKey)) {
      throw failure("AUTO_LISTING_TARGET_STORE_CREDENTIALS_UNAVAILABLE", 409);
    }
    if (!storeCurrency || storeCurrency !== frozenPriceEvidence.currency) {
      throw failure("AUTO_LISTING_PRICE_EVIDENCE_INVALID");
    }

    const builtItems = buildRawItems(source, { currencyCode: storeCurrency });
    const rawItems = Array.isArray(builtItems) ? builtItems.map((item) => ({
      ...structuredClone(item),
      description_category_id: Number(category.descriptionCategoryId),
      descriptionCategoryId: Number(category.descriptionCategoryId),
      type_id: Number(category.typeId),
      typeId: Number(category.typeId),
    })) : builtItems;
    if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 1_000) {
      throw failure("AUTO_LISTING_LISTING_BASE_INCOMPLETE");
    }
    const categoryCapabilities = new Map();
    const categoryAttributeMetadata = new Map();
    const categoryDictionaryReadPromises = new Map();
    const categoryDictionaryValues = new Map();
    const categoryKey = (descriptionCategoryId, typeId) => `${Number(descriptionCategoryId)}:${Number(typeId)}`;
    const dictionaryKey = (descriptionCategoryId, typeId, attributeIdValue) =>
      `${Number(descriptionCategoryId)}:${Number(typeId)}:${Number(attributeIdValue)}`;
    const sourceCategory = Object.freeze({
      kind: "UNIQUE_MATCH",
      descriptionCategoryId: Number(category.descriptionCategoryId),
      typeId: Number(category.typeId),
    });
    const readDictionaryValues = (descriptionCategoryId, typeId, attributeIdValue) => {
      if (Number(descriptionCategoryId) !== sourceCategory.descriptionCategoryId
        || Number(typeId) !== sourceCategory.typeId || !positiveId(attributeIdValue)) {
        throw failure("AUTO_LISTING_SOURCE_VERSION_CONFLICT", 409);
      }
      const key = dictionaryKey(descriptionCategoryId, typeId, attributeIdValue);
      if (!categoryDictionaryReadPromises.has(key)) {
        categoryDictionaryReadPromises.set(key, (async () => {
          try {
            const result = await categoryService.getCategoryAttributeValues({
              accountId: scope, store: storeAccess, descriptionCategoryId, typeId,
              attributeId: Number(attributeIdValue), language: "DEFAULT", limit: 5_000,
              ...(signal ? { signal } : {}),
            });
            if (!Array.isArray(result?.items) || result.items.length > 5_000) {
              throw failure("AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED");
            }
            categoryDictionaryValues.set(key, result.items);
            return result.items;
          } catch {
            throw failure("AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED");
          }
        })());
      }
      return categoryDictionaryReadPromises.get(key);
    };
    const normalized = await normalizeItems(rawItems, {
      strictTypeMatch: true,
      categoryMatchPolicy: "SOURCE_CATEGORY_STRICT",
      sourceCategory,
      allowUnresolvedRequiredDictionaryValues: false,
      getCategoryAttributes: async (descriptionCategoryId, typeId) => {
        if (Number(descriptionCategoryId) !== Number(category.descriptionCategoryId)
          || Number(typeId) !== Number(category.typeId)) {
          throw failure("AUTO_LISTING_SOURCE_VERSION_CONFLICT", 409);
        }
        const result = await categoryService.getCategoryAttributes({
          accountId: scope, store: storeAccess, descriptionCategoryId, typeId, language: "DEFAULT",
          ...(signal ? { signal } : {}),
        });
        const items = Array.isArray(result?.items) ? result.items : [];
        categoryCapabilities.set(
          categoryKey(descriptionCategoryId, typeId),
          items.some((attribute) => attributeId(attribute) === RICH_CONTENT_ATTRIBUTE_ID),
        );
        categoryAttributeMetadata.set(categoryKey(descriptionCategoryId, typeId), items);
        return items;
      },
      getCategoryAttributeValues: async (descriptionCategoryId, typeId, attributeIdValue) => {
        return readDictionaryValues(descriptionCategoryId, typeId, attributeIdValue);
      },
    });
    if (!Array.isArray(normalized?.items) || normalized.items.length !== rawItems.length
      || normalized.items.some((item) => !plainObject(item))) {
      throw failure("AUTO_LISTING_LISTING_BASE_INCOMPLETE");
    }
    if (normalized.items.some((item) => item.currency_code !== storeCurrency)) {
      throw failure("AUTO_LISTING_PRICE_EVIDENCE_INVALID");
    }
    if (normalized.items.some((item) => Number(item.description_category_id) !== Number(category.descriptionCategoryId)
      || Number(item.type_id) !== Number(category.typeId))) {
      throw failure("AUTO_LISTING_SOURCE_VERSION_CONFLICT", 409);
    }
    const supported = normalized.items.every((item) =>
      categoryCapabilities.get(categoryKey(item.description_category_id, item.type_id)) === true);
    if (!supported) throw failure("AUTO_LISTING_RICH_CONTENT_UNSUPPORTED", 409);

    const metadataInput = () => ({
      descriptionCategoryId: sourceCategory.descriptionCategoryId,
      typeId: sourceCategory.typeId,
      attributes: categoryAttributeMetadata.get(categoryKey(
        sourceCategory.descriptionCategoryId,
        sourceCategory.typeId,
      )) || [],
      dictionaryValues: [...categoryDictionaryValues.entries()].map(([key, values]) => ({
        attributeId: Number(key.split(":")[2]),
        values,
      })),
    });
    const preliminaryMetadata = buildOzonCategoryRebuildMetadata(metadataInput());
    const usedAttributeKeys = normalizedAttributeKeys(normalized.items);
    const dictionaryAttributeIds = [...new Set(preliminaryMetadata.attributes
      .filter((attribute) => attribute.dictionaryId
        && (attribute.required || usedAttributeKeys.has(`${attribute.complexId}:${attribute.id}`)))
      .map((attribute) => attribute.id))].sort((left, right) => left - right);
    for (const attributeIdValue of dictionaryAttributeIds) {
      await readDictionaryValues(
        sourceCategory.descriptionCategoryId,
        sourceCategory.typeId,
        attributeIdValue,
      );
    }
    const currentCategoryMetadata = buildOzonCategoryRebuildMetadata(metadataInput());
    const rebuiltItems = rebuildOzonItemsForCategory({
      originalItems: normalized.items,
      sourceEvidenceAttributes: normalized.items.map((item) => item.attributes || []),
      replacementCategory: sourceCategory,
      currentCategoryMetadata,
    });

    return deepFreeze({
      productDraft,
      pricingEvidence: frozenPriceEvidence,
      richContentAttributeSupported: true,
      variants: rebuiltItems.map((item, index) => sourceVariant(rawItems[index], item, index)),
      versions: frozenVersions,
    });
  };
}
