import crypto from "node:crypto";
import { buildCollectItemDraftV4 } from "./listing-pipeline.mjs";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SNAPSHOT_KEYS = [
  "identity", "source", "targetCategory", "attributes", "logistics", "productMeasurements",
  "priceEvidence", "variants", "media", "richContent", "rawEvidence",
];

function sourceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const text = (value) => typeof value === "string" ? value.trim() : "";
const identifier = (value) => (typeof value === "string" || typeof value === "number") ? String(value).trim() : "";

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

function safeAncestorIds(target = {}) {
  const ids = firstDefined(target.ancestorCategoryIds, target.ancestor_category_ids, []);
  if (!Array.isArray(ids)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  return ids.map((id) => {
    const value = identifier(id);
    if (!value) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
    return value;
  });
}

function categorySnapshot(draft) {
  const resolution = draft.categoryResolution && typeof draft.categoryResolution === "object" ? draft.categoryResolution : {};
  const target = resolution.target && typeof resolution.target === "object" ? resolution.target : {};
  const descriptionCategoryId = identifier(firstDefined(draft.descriptionCategoryId, draft.description_category_id));
  const typeId = identifier(firstDefined(draft.typeId, draft.type_id));
  const targetStoreId = identifier(target.storeId);
  if (!descriptionCategoryId || !typeId || !targetStoreId) throw sourceError("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED");
  return {
    descriptionCategoryId,
    typeId,
    targetStoreId,
    ancestorCategoryIds: safeAncestorIds(target),
    categoryPath: firstDefined(draft.categoryPath, resolution.categoryPath, resolution.path, resolution.source?.path, []),
    sourceEvidence: firstDefined(resolution.source, draft.sourceCategory, null),
    match: firstDefined(resolution.match, resolution.dictionaryMatch, null),
    dictionary: firstDefined(resolution.dictionary, null),
    taxonomy: firstDefined(resolution.taxonomy, target.taxonomy, null),
  };
}

function priceEvidence(record, fallback, collectItem) {
  const currency = text(firstDefined(record?.currency, record?.currencyCode, record?.currency_code, fallback?.currency, fallback?.currencyCode, collectItem.currency));
  if (currency !== "RUB") throw sourceError("AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB");
  return {
    blackKopecks: String(firstDefined(record?.blackKopecks, record?.black_kopecks, record?.blackPriceKopecks, fallback?.blackKopecks, fallback?.black_kopecks, fallback?.blackPriceKopecks, "")),
    greenKopecks: String(firstDefined(record?.greenKopecks, record?.green_kopecks, record?.greenPriceKopecks, fallback?.greenKopecks, fallback?.green_kopecks, fallback?.greenPriceKopecks, "")),
    currency,
  };
}

function variantsSnapshot(draft, collectItem) {
  const primarySku = text(firstDefined(draft.sku, draft.sourceSku, collectItem.sku, collectItem.sourceSku));
  if (!primarySku) throw sourceError("AUTO_LISTING_SOURCE_SKU_REQUIRED");
  const primary = {
    sku: primarySku,
    offerId: firstDefined(draft.offerId, draft.offer_id, collectItem.offerId, collectItem.offer_id, ""),
    name: firstDefined(draft.title, draft.name, collectItem.name, collectItem.title, ""),
    price: firstDefined(draft.price, collectItem.price, ""),
    priceEvidence: priceEvidence(draft, null, collectItem),
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
      priceEvidence: priceEvidence(value, draft, collectItem),
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

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const stringOrNull = (value) => value === null || typeof value === "string";
const requiredString = (value) => typeof value === "string" && value.trim().length > 0;
const rubPrice = (value) => plainObject(value) && value.currency === "RUB"
  && typeof value.blackKopecks === "string" && typeof value.greenKopecks === "string";

function assertSemanticSnapshot(snapshot) {
  const { identity, source, targetCategory, attributes, logistics, productMeasurements, priceEvidence, variants, media, richContent, rawEvidence } = snapshot;
  if (!plainObject(identity) || !["accountId", "sourceType", "sourceRecordId", "sourceVersion", "primarySku"].every((key) => requiredString(identity[key]))
    || !["primaryOfferId", "primaryName", "brand"].every((key) => typeof identity[key] === "string")
    || !plainObject(source) || !["sourceType", "sourceRecordId", "sourceVersion", "productStyle"].every((key) => requiredString(source[key]))
    || !stringOrNull(source.productDraftId) || !(source.productDraftVersion === null || Number.isInteger(source.productDraftVersion))
    || !stringOrNull(source.collectedAt)
    || identity.sourceType !== source.sourceType || identity.sourceRecordId !== source.sourceRecordId || identity.sourceVersion !== source.sourceVersion
    || !plainObject(targetCategory) || !["descriptionCategoryId", "typeId", "targetStoreId"].every((key) => requiredString(targetCategory[key]))
    || !Array.isArray(targetCategory.ancestorCategoryIds) || targetCategory.ancestorCategoryIds.some((id) => typeof id !== "string")
    || !Array.isArray(attributes) || !plainObject(logistics) || !plainObject(productMeasurements)
    || !rubPrice(priceEvidence) || !requiredString(priceEvidence.blackKopecks) || !requiredString(priceEvidence.greenKopecks) || !Array.isArray(variants) || variants.length < 1
    || !plainObject(media) || !Array.isArray(media.images) || !Array.isArray(media.videos)
    || !(richContent === null || typeof richContent === "string" || plainObject(richContent) || Array.isArray(richContent))
    || !plainObject(rawEvidence) || !stringOrNull(rawEvidence.rawResponseRef) || !stringOrNull(rawEvidence.rawResponseHash)) {
    throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  }
  for (const variant of variants) {
    if (!plainObject(variant) || !requiredString(variant.sku) || !["offerId", "name"].every((key) => typeof variant[key] === "string")
      || !rubPrice(variant.priceEvidence) || !requiredString(variant.priceEvidence.blackKopecks) || !requiredString(variant.priceEvidence.greenKopecks) || !Array.isArray(variant.media)
      || !stringOrNull(variant.groupId) || !(variant.relation === null || plainObject(variant.relation) || Array.isArray(variant.relation))) {
      throw sourceError("AUTO_LISTING_SOURCE_INVALID");
    }
  }
  if (!variants.some((variant) => variant.sku === identity.primarySku)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
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

export function buildAutoListingSourceSnapshot(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  const accountId = text(input.accountId);
  const sourceRecordId = text(input.sourceRecordId);
  const sourceVersion = text(input.sourceVersion);
  const sourceType = text(input.sourceType);
  const collectItem = input.collectItem;
  if (!sourceRecordId || !sourceVersion || !["COLLECT_BOX", "EXCEL_SKU"].includes(sourceType)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  if (!accountId || !collectItem || typeof collectItem !== "object" || Array.isArray(collectItem)
    || text(collectItem.accountId) !== accountId || text(collectItem.id) !== sourceRecordId) {
    throw sourceError("AUTO_LISTING_SOURCE_SCOPE");
  }
  const rawResponseRef = scalar(input.rawResponseRef, { allowNull: true });
  const rawResponseHash = scalar(input.rawResponseHash, { allowNull: true });
  let draft;
  try { draft = buildCollectItemDraftV4(collectItem); } catch { throw sourceError("AUTO_LISTING_SOURCE_INVALID"); }
  const variants = variantsSnapshot(draft, collectItem);
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
    targetCategory: categorySnapshot(draft),
    attributes: firstDefined(draft.attributes, draft.categoryAttributes, []),
    logistics: firstDefined(draft.logistics, { packageWeight: draft.packageWeight || "", packageLength: draft.packageLength || "", packageWidth: draft.packageWidth || "", packageHeight: draft.packageHeight || "" }),
    productMeasurements: firstDefined(draft.productMeasurements, draft.product_measurements, draft.productDimensions, draft.product_dimensions, collectItem.productMeasurements, collectItem.productDimensions, {}),
    priceEvidence: priceEvidence(draft, null, collectItem),
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
