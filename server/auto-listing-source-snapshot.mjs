import crypto from "node:crypto";
import { buildCollectItemDraftV4 } from "./listing-pipeline.mjs";
import { resolveAutoListingPriceCurrency } from "./auto-listing-currency.mjs";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SNAPSHOT_KEYS = [
  "identity", "source", "targetCategory", "attributes", "logistics", "productMeasurements",
  "priceEvidence", "variants", "media", "richContent", "rawEvidence",
];
const BLOCKED_EVIDENCE_KEYS = [
  "accountId", "collectedAt", "failureCode", "kind", "productDraftId", "productDraftVersion",
  "rawResponseHash", "rawResponseRef", "sourceRecordId", "sourceType", "sourceVersion", "version",
];
const BLOCKED_EVIDENCE_KIND = "AUTO_LISTING_BLOCKED_SOURCE_EVIDENCE";
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const BLOCKED_SOURCE_FAILURE_CODES = new Set([
  "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED",
  "AUTO_LISTING_SOURCE_SKU_REQUIRED",
  "AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB",
  "AUTO_LISTING_SOURCE_CURRENCY_UNSUPPORTED",
  "AUTO_LISTING_SOURCE_CURRENCY_MISMATCH",
]);

function sourceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const text = (value) => typeof value === "string" ? value.trim() : "";
const identifier = (value) => (typeof value === "string" || typeof value === "number") ? String(value).trim() : "";
const positiveIdentifier = (value) => /^[1-9][0-9]*$/u.test(identifier(value)) ? identifier(value) : "";

function scalar(value, { allowNull = false } = {}) {
  if (allowNull && (value === undefined || value === null || value === "")) return null;
  const result = text(value);
  if (!result || result.length > 2048) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  return result;
}

function jsonSafe(value, active = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
    return value;
  }
  if (Array.isArray(value)) {
    if (active.has(value)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
    active.add(value);
    try {
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
        output.push(jsonSafe(value[index], active));
      }
      return output;
    } finally {
      active.delete(value);
    }
  }
  if (!value || typeof value !== "object") throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || active.has(value)) {
    throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  }
  active.add(value);
  try {
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (DANGEROUS_KEYS.has(key)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
      return [key, jsonSafe(value[key], active)];
    }));
  } finally {
    active.delete(value);
  }
}

function firstDefined(...values) {
  for (const value of values) if (value !== undefined && value !== null && value !== "") return value;
  return values.at(-1);
}

function firstNonEmptyArray(...values) {
  return values.find((value) => Array.isArray(value) && value.length > 0) || [];
}

function categorySnapshot({ accountId, categoryEvidence, sharedCategory }) {
  if (!plainObject(categoryEvidence) || !plainObject(sharedCategory)) {
    throw sourceError("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED");
  }
  const evidenceId = identifier(categoryEvidence.id);
  const sharedCategoryId = identifier(sharedCategory.id);
  const sharedCategoryVersion = sharedCategory.version;
  const sourceDescriptionCategoryId = positiveIdentifier(categoryEvidence.sourceDescriptionCategoryId);
  const sourceTypeId = positiveIdentifier(categoryEvidence.sourceTypeId);
  const descriptionCategoryId = positiveIdentifier(sharedCategory.currentDescriptionCategoryId);
  const typeId = positiveIdentifier(sharedCategory.currentTypeId);
  const taxonomyScope = text(categoryEvidence.taxonomyScope);
  const sharedTaxonomyScope = text(sharedCategory.taxonomyScope);
  const taxonomyFingerprint = sharedCategory.taxonomyFingerprint === null
    ? "" : text(sharedCategory.taxonomyFingerprint);
  const provenance = text(sharedCategory.source);
  if (!evidenceId || !sharedCategoryId || !Number.isSafeInteger(sharedCategoryVersion) || sharedCategoryVersion < 1
    || !sourceDescriptionCategoryId || !sourceTypeId || !descriptionCategoryId || !typeId || !taxonomyScope
    || sharedTaxonomyScope !== taxonomyScope || text(categoryEvidence.accountId) !== accountId
    || text(sharedCategory.accountId) !== accountId
    || identifier(sharedCategory.sourceDescriptionCategoryId) !== sourceDescriptionCategoryId
    || identifier(sharedCategory.sourceTypeId) !== sourceTypeId || sharedCategory.status !== "ACTIVE"
    || !["SOURCE_DIRECT", "MANUAL", "OZON_REFRESH"].includes(provenance)) {
    throw sourceError("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED");
  }
  return {
    schemaVersion: "AUTO_LISTING_ACCOUNT_CATEGORY_V2",
    evidenceId,
    sharedCategoryId,
    sharedCategoryVersion,
    sourceDescriptionCategoryId,
    sourceTypeId,
    descriptionCategoryId,
    typeId,
    taxonomyScope,
    taxonomyFingerprint,
    provenance,
  };
}

function priceEvidence(record, fallback, collectItem, currencyContext, { allowFallbackPrices = true } = {}) {
  const sourceCurrency = firstDefined(
    record?.currency,
    record?.currencyCode,
    record?.currency_code,
    record?.blackPriceCurrency,
    record?.black_price_currency,
    record?.priceCurrency,
    record?.price_currency,
    fallback?.currency,
    fallback?.currencyCode,
    fallback?.currency_code,
    fallback?.blackPriceCurrency,
    fallback?.black_price_currency,
    fallback?.priceCurrency,
    fallback?.price_currency,
    collectItem.currency,
    collectItem.currencyCode,
    collectItem.currency_code,
    collectItem.blackPriceCurrency,
    collectItem.black_price_currency,
    collectItem.priceCurrency,
    collectItem.price_currency,
    "",
  );
  const { currency, currencySource } = resolveAutoListingPriceCurrency({
    sourceCurrency,
    targetStoreCurrency: currencyContext.targetStoreCurrency,
    sourceTargetStoreId: currencyContext.sourceTargetStoreId,
    targetStoreId: currencyContext.targetStoreId,
  });
  const fact = (...values) => {
    const value = values.find((candidate) => candidate !== undefined);
    if (value === undefined) return "";
    if (value === null || typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  };
  const minorUnits = (...values) => {
    const value = values.find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
    if (value === undefined) return "";
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
      throw sourceError("AUTO_LISTING_SOURCE_INVALID");
    }
    const decimal = String(value).trim();
    const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/u.exec(decimal);
    if (!match) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
    const result = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0") || "0");
    if (result > POSTGRES_BIGINT_MAX) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
    return String(result);
  };
  const explicitBlack = fact(record?.blackKopecks, record?.black_kopecks, record?.blackPriceKopecks,
    ...(allowFallbackPrices
      ? [fallback?.blackKopecks, fallback?.black_kopecks, fallback?.blackPriceKopecks]
      : []), "");
  const explicitGreen = fact(record?.greenKopecks, record?.green_kopecks, record?.greenPriceKopecks,
    ...(allowFallbackPrices
      ? [fallback?.greenKopecks, fallback?.green_kopecks, fallback?.greenPriceKopecks]
      : []), "");
  const fallbackPrice = allowFallbackPrices ? fallback : null;
  const collectedPrice = allowFallbackPrices ? collectItem : {};
  const greenKopecks = explicitGreen === "" ? minorUnits(
    record?.greenPrice, record?.green_price, record?.walletPrice, record?.wallet_price,
    fallbackPrice?.greenPrice, fallbackPrice?.green_price, fallbackPrice?.walletPrice, fallbackPrice?.wallet_price,
    collectedPrice.greenPrice, collectedPrice.green_price, collectedPrice.walletPrice, collectedPrice.wallet_price,
  ) : explicitGreen;
  return {
    blackKopecks: explicitBlack === "" ? minorUnits(
      record?.blackPrice, record?.black_price, record?.marketingPrice, record?.marketing_price, record?.price,
      fallbackPrice?.blackPrice, fallbackPrice?.black_price, fallbackPrice?.marketingPrice, fallbackPrice?.marketing_price, fallbackPrice?.price,
      collectedPrice.blackPrice, collectedPrice.black_price, collectedPrice.marketingPrice, collectedPrice.marketing_price, collectedPrice.price,
    ) : explicitBlack,
    greenKopecks: greenKopecks === "" ? null : greenKopecks,
    currency,
    currencySource,
  };
}

function variantsSnapshot(draft, collectItem, currencyContext) {
  const primarySku = text(firstDefined(draft.sku, draft.sourceSku, collectItem.sku, collectItem.sourceSku));
  if (!primarySku) throw sourceError("AUTO_LISTING_SOURCE_SKU_REQUIRED");
  const primary = {
    sku: primarySku,
    offerId: firstDefined(draft.offerId, draft.offer_id, collectItem.offerId, collectItem.offer_id, ""),
    name: firstDefined(draft.title, draft.name, collectItem.name, collectItem.title, ""),
    price: firstDefined(draft.price, collectItem.price, ""),
    priceEvidence: priceEvidence(draft, null, collectItem, currencyContext),
    media: firstDefined(draft.media, draft.images, collectItem.images, []),
    groupId: firstDefined(draft.variantGroupId, draft.groupId, null),
    relation: firstDefined(draft.relation, draft.variantRelation, draft.groupEvidence, null),
    evidence: firstDefined(draft.evidence, null),
  };
  const records = Array.isArray(draft.variants) && draft.variants.length ? draft.variants : [primary];
  const variants = records.map((record) => {
    const value = record && typeof record === "object" && !Array.isArray(record) ? record : {};
    const sku = text(firstDefined(value.sku, value.sourceSku, value.source_sku));
    if (!sku) throw sourceError("AUTO_LISTING_SOURCE_SKU_REQUIRED");
    return {
      sku,
      offerId: firstDefined(value.offerId, value.offer_id, ""),
      name: firstDefined(value.name, value.title, ""),
      price: firstDefined(value.price, value.priceKopecks, ""),
      priceEvidence: priceEvidence(
        value,
        sku === primarySku ? draft : null,
        sku === primarySku ? collectItem : {},
        currencyContext,
        { allowFallbackPrices: sku === primarySku },
      ),
      media: firstDefined(value.media, value.images, []),
      groupId: firstDefined(value.variantGroupId, value.groupId, value.group_id, null),
      relation: firstDefined(value.relation, value.variantRelation, value.groupEvidence, null),
      evidence: firstDefined(value.evidence, null),
    };
  });
  if (!variants.some((variant) => variant.sku === primarySku)) variants.unshift(primary);
  return { primarySku, variants };
}

function normalizedSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  const keys = Object.keys(snapshot).sort();
  if (keys.length !== SNAPSHOT_KEYS.length || keys.some((key, index) => key !== [...SNAPSHOT_KEYS].sort()[index])) {
    throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  }
  return jsonSafe(snapshot);
}

function normalizedBlockedEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  const keys = Object.keys(evidence).sort();
  if (keys.length !== BLOCKED_EVIDENCE_KEYS.length
    || keys.some((key, index) => key !== BLOCKED_EVIDENCE_KEYS[index])) {
    throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  }
  return jsonSafe(evidence);
}

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const stringOrNull = (value) => value === null || typeof value === "string";
const requiredString = (value) => typeof value === "string" && value.trim().length > 0;
const nonemptyStringOrNull = (value) => value === null || requiredString(value);
const priceFact = (value) => value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
const supportedPrice = (value) => plainObject(value) && ["RUB", "CNY"].includes(value.currency)
  && priceFact(value.blackKopecks) && priceFact(value.greenKopecks)
  && (value.currencySource === undefined
    ? value.currency === "RUB"
    : ["SOURCE", "TARGET_STORE"].includes(value.currencySource));

function assertSemanticSnapshot(snapshot) {
  const { identity, source, targetCategory, attributes, logistics, productMeasurements, priceEvidence, variants, media, richContent, rawEvidence } = snapshot;
  if (!plainObject(identity) || !["accountId", "sourceType", "sourceRecordId", "sourceVersion", "primarySku"].every((key) => requiredString(identity[key]))
    || !["COLLECT_BOX", "EXCEL_SKU"].includes(identity.sourceType)
    || !["primaryOfferId", "primaryName", "brand"].every((key) => typeof identity[key] === "string")
    || !plainObject(source) || !["sourceType", "sourceRecordId", "sourceVersion", "productStyle"].every((key) => requiredString(source[key]))
    || !stringOrNull(source.productDraftId) || !(source.productDraftVersion === null || (Number.isInteger(source.productDraftVersion) && source.productDraftVersion > 0))
    || !stringOrNull(source.collectedAt)
    || identity.sourceType !== source.sourceType || identity.sourceRecordId !== source.sourceRecordId || identity.sourceVersion !== source.sourceVersion
    || !plainObject(targetCategory) || !validCategorySnapshot(targetCategory)
    || !Array.isArray(attributes) || !plainObject(logistics) || !plainObject(productMeasurements)
    || !supportedPrice(priceEvidence) || !Array.isArray(variants) || variants.length < 1
    || !plainObject(media) || !Array.isArray(media.images) || !Array.isArray(media.videos)
    || !(richContent === null || typeof richContent === "string" || plainObject(richContent) || Array.isArray(richContent))
    || !plainObject(rawEvidence) || !nonemptyStringOrNull(rawEvidence.rawResponseRef) || !nonemptyStringOrNull(rawEvidence.rawResponseHash)) {
    throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  }
  for (const variant of variants) {
    if (!plainObject(variant) || !requiredString(variant.sku) || !["offerId", "name"].every((key) => typeof variant[key] === "string")
      || !supportedPrice(variant.priceEvidence) || !Array.isArray(variant.media)
      || !stringOrNull(variant.groupId) || !(variant.relation === null || plainObject(variant.relation) || Array.isArray(variant.relation))) {
      throw sourceError("AUTO_LISTING_SOURCE_INVALID");
    }
  }
  if (!variants.some((variant) => variant.sku === identity.primarySku)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
}

function validCategorySnapshot(value) {
  if (value.schemaVersion === "AUTO_LISTING_ACCOUNT_CATEGORY_V2") {
    const keys = ["schemaVersion", "evidenceId", "sharedCategoryId", "sharedCategoryVersion",
      "sourceDescriptionCategoryId", "sourceTypeId", "descriptionCategoryId", "typeId",
      "taxonomyScope", "taxonomyFingerprint", "provenance"];
    return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
      && ["evidenceId", "sharedCategoryId", "sourceDescriptionCategoryId", "sourceTypeId",
        "descriptionCategoryId", "typeId", "taxonomyScope", "provenance"].every((key) => requiredString(value[key]))
      && ["sourceDescriptionCategoryId", "sourceTypeId", "descriptionCategoryId", "typeId"]
        .every((key) => positiveIdentifier(value[key]))
      && Number.isSafeInteger(value.sharedCategoryVersion) && value.sharedCategoryVersion > 0
      && value.taxonomyScope === "OZON:DEFAULT"
      && typeof value.taxonomyFingerprint === "string"
      && (value.taxonomyFingerprint === "" || /^[0-9a-f]{64}$/u.test(value.taxonomyFingerprint))
      && ["SOURCE_DIRECT", "MANUAL", "OZON_REFRESH"].includes(value.provenance);
  }
  return ["descriptionCategoryId", "typeId", "targetStoreId"].every((key) => requiredString(value[key]))
    && Array.isArray(value.ancestorCategoryIds)
    && value.ancestorCategoryIds.every((id) => requiredString(id));
}

function assertBlockedEvidence(evidence) {
  if (evidence.kind !== BLOCKED_EVIDENCE_KIND || evidence.version !== 1
    || !requiredString(evidence.accountId)
    || !["COLLECT_BOX", "EXCEL_SKU"].includes(evidence.sourceType)
    || !requiredString(evidence.sourceRecordId) || !requiredString(evidence.sourceVersion)
    || !stringOrNull(evidence.productDraftId)
    || !(evidence.productDraftVersion === null || (Number.isInteger(evidence.productDraftVersion) && evidence.productDraftVersion > 0))
    || !nonemptyStringOrNull(evidence.collectedAt)
    || !nonemptyStringOrNull(evidence.rawResponseRef) || !nonemptyStringOrNull(evidence.rawResponseHash)
    || !BLOCKED_SOURCE_FAILURE_CODES.has(evidence.failureCode)) {
    throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  }
}

export function canonicalAutoListingSourceSnapshot(snapshot) {
  return JSON.stringify(normalizedSnapshot(snapshot));
}

export function verifyAutoListingSourceSnapshot(value = {}) {
  const snapshot = normalizedSnapshot(value.snapshot);
  assertSemanticSnapshot(snapshot);
  const snapshotHash = scalar(value.snapshotHash);
  const expected = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  if (snapshotHash !== expected) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  return {
    snapshot,
    snapshotHash,
    rawResponseRef: scalar(value.rawResponseRef, { allowNull: true }),
  };
}

export function finalizeAutoListingSourceAttributes(capture, attributes) {
  const verified = verifyAutoListingSourceSnapshot(capture);
  if (!Array.isArray(attributes)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  const safeAttributes = jsonSafe(attributes);
  const sourceVersion = crypto.createHash("sha256").update(JSON.stringify({
    contract: "AUTO_LISTING_SOURCE_FACTS_V2",
    sourceVersion: verified.snapshot.source.sourceVersion,
    attributes: safeAttributes,
  })).digest("hex");
  const snapshot = normalizedSnapshot({
    ...verified.snapshot,
    identity: { ...verified.snapshot.identity, sourceVersion },
    source: { ...verified.snapshot.source, sourceVersion },
    attributes: safeAttributes,
  });
  return verifyAutoListingSourceSnapshot({
    snapshot,
    snapshotHash: crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    rawResponseRef: verified.rawResponseRef,
  });
}

export function verifyAutoListingBlockedSourceEvidence(value = {}) {
  const blockedEvidence = normalizedBlockedEvidence(value.blockedEvidence);
  assertBlockedEvidence(blockedEvidence);
  const snapshotHash = scalar(value.snapshotHash);
  const expected = crypto.createHash("sha256").update(JSON.stringify(blockedEvidence)).digest("hex");
  if (snapshotHash !== expected) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  const rawResponseRef = scalar(value.rawResponseRef, { allowNull: true });
  if (rawResponseRef !== blockedEvidence.rawResponseRef) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  return { blockedEvidence, snapshotHash, rawResponseRef };
}

export function buildAutoListingBlockedSourceEvidence(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  const accountId = scalar(input.accountId);
  const sourceType = scalar(input.sourceType);
  const sourceRecordId = scalar(input.sourceRecordId);
  const sourceVersion = scalar(input.sourceVersion);
  if (!["COLLECT_BOX", "EXCEL_SKU"].includes(sourceType)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  const productDraft = input.productDraft;
  if (!(productDraft === undefined || productDraft === null || plainObject(productDraft))) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  const productDraftId = scalar(productDraft?.id, { allowNull: true });
  const productDraftVersion = productDraft?.version ?? null;
  const blockedEvidence = normalizedBlockedEvidence({
    kind: BLOCKED_EVIDENCE_KIND,
    version: 1,
    accountId,
    sourceType,
    sourceRecordId,
    sourceVersion,
    productDraftId,
    productDraftVersion,
    collectedAt: scalar(input.rawCollectedAt, { allowNull: true }),
    rawResponseRef: scalar(input.rawResponseRef, { allowNull: true }),
    rawResponseHash: scalar(input.rawResponseHash, { allowNull: true }),
    failureCode: input.failureCode,
  });
  return verifyAutoListingBlockedSourceEvidence({
    blockedEvidence,
    snapshotHash: crypto.createHash("sha256").update(JSON.stringify(blockedEvidence)).digest("hex"),
    rawResponseRef: blockedEvidence.rawResponseRef,
  });
}

export function buildAutoListingSourceSnapshot(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  const accountId = text(input.accountId);
  const sourceRecordId = text(input.sourceRecordId);
  const sourceVersion = text(input.sourceVersion);
  const sourceType = text(input.sourceType);
  const collectItem = input.collectItem;
  const expectedCollectItemId = sourceType === "EXCEL_SKU" ? text(input.collectItemId) : sourceRecordId;
  if (!sourceRecordId || !sourceVersion || !["COLLECT_BOX", "EXCEL_SKU"].includes(sourceType)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  if (!accountId || !collectItem || typeof collectItem !== "object" || Array.isArray(collectItem)
    || !expectedCollectItemId || text(collectItem.accountId) !== accountId
    || text(collectItem.id) !== expectedCollectItemId) {
    throw sourceError("AUTO_LISTING_SOURCE_SCOPE");
  }
  jsonSafe(collectItem);
  if (!(input.productDraft === undefined || input.productDraft === null || plainObject(input.productDraft))) {
    throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  }
  if (input.productDraft) jsonSafe(input.productDraft);
  const rawResponseRef = scalar(input.rawResponseRef, { allowNull: true });
  const rawResponseHash = scalar(input.rawResponseHash, { allowNull: true });
  let draft;
  try { draft = buildCollectItemDraftV4(collectItem); } catch { throw sourceError("AUTO_LISTING_SOURCE_INVALID"); }
  const targetCategory = categorySnapshot({ accountId, categoryEvidence: input.categoryEvidence, sharedCategory: input.sharedCategory });
  const currencyContext = {
    targetStoreCurrency: input.targetStoreCurrency,
    targetStoreId: input.targetStoreId,
    sourceTargetStoreId: input.targetStoreId,
  };
  const variants = variantsSnapshot(draft, collectItem, currencyContext);
  const snapshot = normalizedSnapshot({
    identity: {
      accountId, sourceType, sourceRecordId, sourceVersion, primarySku: variants.primarySku,
      primaryOfferId: firstDefined(draft.offerId, draft.offer_id, collectItem.offerId, collectItem.offer_id, ""),
      primaryName: firstDefined(draft.title, draft.name, collectItem.name, collectItem.title, ""),
      brand: firstDefined(draft.brand, collectItem.brand, ""),
    },
    source: {
      sourceType, sourceRecordId, sourceVersion,
      productDraftId: firstDefined(input.productDraft?.id, null),
      productDraftVersion: firstDefined(input.productDraft?.version, null),
      collectedAt: scalar(firstDefined(input.rawCollectedAt, draft.collectedAt, collectItem.collectedAt, collectItem.createdAt, null), { allowNull: true }),
      productStyle: identifier(firstDefined(draft.productStyle, collectItem.productStyle, "UNKNOWN")) || "UNKNOWN",
    },
    targetCategory,
    attributes: firstNonEmptyArray(
      draft.categoryAttributes,
      draft.attributes,
      draft.sourceCategory?.attributes,
      collectItem.categoryAttributes,
      collectItem.attributes,
      collectItem.sourceCategory?.attributes,
    ),
    logistics: firstDefined(draft.logistics, { packageWeight: draft.packageWeight || "", packageLength: draft.packageLength || "", packageWidth: draft.packageWidth || "", packageHeight: draft.packageHeight || "" }),
    productMeasurements: firstDefined(draft.productMeasurements, draft.product_measurements, draft.productDimensions, draft.product_dimensions, collectItem.productMeasurements, collectItem.productDimensions, {}),
    priceEvidence: priceEvidence(draft, null, collectItem, currencyContext),
    variants: variants.variants,
    media: { images: firstDefined(draft.images, collectItem.images, []), video: firstDefined(draft.video, null), videos: firstDefined(draft.videos, draft.media, collectItem.videos, []) },
    richContent: firstDefined(draft.richContent, draft.rich_content, collectItem.richContent, collectItem.rich_content, null),
    rawEvidence: { rawResponseRef, rawResponseHash },
  });
  return verifyAutoListingSourceSnapshot({
    snapshot,
    snapshotHash: crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    rawResponseRef,
  });
}
