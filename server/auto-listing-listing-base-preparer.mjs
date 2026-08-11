import crypto from "node:crypto";

import { normalizeOzonImportItems } from "./ozon-import-normalizer.mjs";
import { normalizeAutoListingCurrency } from "./auto-listing-currency.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const RICH_CONTENT_ATTRIBUTE_ID = 11254;

function failure(code, status = 422) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = false;
  return error;
}

const text = (value) => typeof value === "string" ? value.trim() : "";
const plainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : plainObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

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

function sourceVariant(raw, normalized, index) {
  const sourceSku = text(raw?.sku || raw?.sourceSku || raw?.source_sku || raw?.scraped_sku);
  const sourceVariantId = text(raw?.offer_id || raw?.offerId || sourceSku || String(index + 1));
  if (!sourceSku || !sourceVariantId) throw failure("AUTO_LISTING_LISTING_BASE_INCOMPLETE");
  return { sourceVariantId, sourceSku, item: structuredClone(normalized) };
}

function assertDependencies({ loadStoreAccess, categoryService, normalizeItems, buildRawItems }) {
  if (typeof loadStoreAccess !== "function" || typeof normalizeItems !== "function" || typeof buildRawItems !== "function"
    || !categoryService || ["getCategoryTree", "getCategoryAttributes", "getCategoryAttributeValues"]
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
    accountId, source, targetStore, pricingEvidence,
  } = {}) {
    const scope = text(accountId);
    const targetStoreId = text(targetStore?.id);
    const ownerAccountId = text(targetStore?.ownerAccountId || targetStore?.accountId);
    if (!scope || !targetStoreId || ownerAccountId !== scope) throw failure("AUTO_LISTING_TARGET_STORE_FORBIDDEN", 403);
    const { productDraft, versions: frozenVersions } = productDraftEvidence(source, fallbackVersions);
    const frozenPriceEvidence = priceEvidence(pricingEvidence);
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

    const rawItems = buildRawItems(source, { currencyCode: storeCurrency });
    if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 1_000) {
      throw failure("AUTO_LISTING_LISTING_BASE_INCOMPLETE");
    }
    const categoryCapabilities = new Map();
    const categoryKey = (descriptionCategoryId, typeId) => `${Number(descriptionCategoryId)}:${Number(typeId)}`;
    const normalized = await normalizeItems(rawItems, {
      strictTypeMatch: true,
      categoryMatchPolicy: "TARGET_STORE_EXACT",
      targetStoreId,
      allowUnresolvedRequiredDictionaryValues: false,
      getCategoryTree: async () => (
        await categoryService.getCategoryTree({ accountId: scope, store: storeAccess, language: "DEFAULT" })
      ).items,
      getCategoryAttributes: async (descriptionCategoryId, typeId) => {
        const result = await categoryService.getCategoryAttributes({
          accountId: scope, store: storeAccess, descriptionCategoryId, typeId, language: "DEFAULT",
        });
        const items = Array.isArray(result?.items) ? result.items : [];
        categoryCapabilities.set(
          categoryKey(descriptionCategoryId, typeId),
          items.some((attribute) => attributeId(attribute) === RICH_CONTENT_ATTRIBUTE_ID),
        );
        return items;
      },
      getCategoryAttributeValues: async (descriptionCategoryId, typeId, attributeIdValue) => (
        await categoryService.getCategoryAttributeValues({
          accountId: scope, store: storeAccess, descriptionCategoryId, typeId,
          attributeId: attributeIdValue, language: "DEFAULT", limit: 5_000,
        })
      ).items,
    });
    if (!Array.isArray(normalized?.items) || normalized.items.length !== rawItems.length
      || normalized.items.some((item) => !plainObject(item))) {
      throw failure("AUTO_LISTING_LISTING_BASE_INCOMPLETE");
    }
    if (normalized.items.some((item) => item.currency_code !== storeCurrency)) {
      throw failure("AUTO_LISTING_PRICE_EVIDENCE_INVALID");
    }
    const supported = normalized.items.every((item) =>
      categoryCapabilities.get(categoryKey(item.description_category_id, item.type_id)) === true);
    if (!supported) throw failure("AUTO_LISTING_RICH_CONTENT_UNSUPPORTED", 409);

    return Object.freeze({
      productDraft,
      pricingEvidence: frozenPriceEvidence,
      richContentAttributeSupported: true,
      variants: normalized.items.map((item, index) => sourceVariant(rawItems[index], item, index)),
      versions: frozenVersions,
    });
  };
}
