import crypto from "node:crypto";
import { buildCollectItemDraftV4 } from "./listing-pipeline.mjs";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function sourceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function identifier(value) {
  return (typeof value === "string" || typeof value === "number") ? String(value).trim() : "";
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
      return value.map((entry) => jsonSafe(entry, active));
    } finally {
      active.delete(value);
    }
  }
  if (!value || typeof value !== "object") throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  if (active.has(value)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  active.add(value);
  try {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (DANGEROUS_KEYS.has(key)) throw sourceError("AUTO_LISTING_SOURCE_INVALID");
      output[key] = jsonSafe(value[key], active);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return values.at(-1);
}

function categorySnapshot(draft) {
  const resolution = draft.categoryResolution && typeof draft.categoryResolution === "object"
    ? draft.categoryResolution : {};
  const descriptionCategoryId = identifier(firstDefined(draft.descriptionCategoryId, draft.description_category_id));
  const typeId = identifier(firstDefined(draft.typeId, draft.type_id));
  if (!descriptionCategoryId || !typeId) throw sourceError("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED");
  return {
    descriptionCategoryId,
    typeId,
    categoryPath: firstDefined(draft.categoryPath, resolution.categoryPath, resolution.path, resolution.source?.path, []),
    sourceEvidence: firstDefined(resolution.source, draft.sourceCategory, null),
    match: firstDefined(resolution.match, resolution.dictionaryMatch, null),
    dictionary: firstDefined(resolution.dictionary, null),
    taxonomy: firstDefined(resolution.taxonomy, null),
  };
}

function priceSnapshot(draft, collectItem) {
  const currency = text(firstDefined(draft.currency, draft.currencyCode, draft.currency_code, collectItem.currency));
  if (currency !== "RUB") throw sourceError("AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB");
  return {
    blackKopecks: String(firstDefined(draft.blackKopecks, draft.black_kopecks, draft.blackPriceKopecks, "")),
    greenKopecks: String(firstDefined(draft.greenKopecks, draft.green_kopecks, draft.greenPriceKopecks, "")),
    currency,
  };
}

function sourceVariants(draft, collectItem) {
  const primarySku = text(firstDefined(draft.sku, draft.sourceSku, collectItem.sku, collectItem.sourceSku));
  const primary = {
    sku: primarySku,
    offerId: firstDefined(draft.offerId, draft.offer_id, collectItem.offerId, collectItem.offer_id, ""),
    name: firstDefined(draft.title, draft.name, collectItem.name, collectItem.title, ""),
    price: firstDefined(draft.price, collectItem.price, ""),
    media: firstDefined(draft.images, draft.media, collectItem.images, []),
  };
  const variants = Array.isArray(draft.variants) && draft.variants.length ? draft.variants : [primary];
  const normalized = variants.map((variant) => {
    const record = variant && typeof variant === "object" && !Array.isArray(variant) ? variant : {};
    const sku = text(firstDefined(record.sku, record.sourceSku, record.source_sku));
    if (!sku) throw sourceError("AUTO_LISTING_SOURCE_SKU_REQUIRED");
    return {
      sku,
      offerId: firstDefined(record.offerId, record.offer_id, ""),
      name: firstDefined(record.name, record.title, ""),
      price: firstDefined(record.price, record.priceKopecks, ""),
      media: firstDefined(record.media, record.images, []),
      relation: firstDefined(record.relation, record.variantRelation, record.groupEvidence, null),
      evidence: firstDefined(record.evidence, null),
    };
  });
  if (!primarySku) throw sourceError("AUTO_LISTING_SOURCE_SKU_REQUIRED");
  if (!normalized.some((variant) => variant.sku === primarySku)) normalized.unshift(primary);
  return { primarySku, variants: normalized };
}

function productMeasurements(draft, collectItem) {
  return firstDefined(
    draft.productMeasurements,
    draft.product_measurements,
    draft.productDimensions,
    draft.product_dimensions,
    collectItem.productMeasurements,
    collectItem.productDimensions,
    {},
  );
}

/**
 * Builds an immutable, JSON-safe capture of already-normalized collect facts.
 * This function never scrapes or enriches data; any new collection becomes a new snapshot.
 */
export function buildAutoListingSourceSnapshot(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  }
  const accountId = text(input.accountId);
  const sourceRecordId = text(input.sourceRecordId);
  const sourceVersion = text(input.sourceVersion);
  const sourceType = text(input.sourceType);
  const collectItem = input.collectItem;
  if (!accountId || !collectItem || typeof collectItem !== "object" || Array.isArray(collectItem)
    || (text(collectItem.accountId) && text(collectItem.accountId) !== accountId)) {
    throw sourceError("AUTO_LISTING_SOURCE_SCOPE");
  }
  if (!sourceRecordId || !sourceVersion || !["COLLECT_BOX", "EXCEL_SKU"].includes(sourceType)) {
    throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  }
  if (text(collectItem.id) && text(collectItem.id) !== sourceRecordId) {
    throw sourceError("AUTO_LISTING_SOURCE_SCOPE");
  }

  let draft;
  try {
    draft = buildCollectItemDraftV4(collectItem);
  } catch {
    throw sourceError("AUTO_LISTING_SOURCE_INVALID");
  }
  const variants = sourceVariants(draft, collectItem);
  const snapshot = jsonSafe({
    identity: {
      accountId,
      sourceType,
      sourceRecordId,
      sourceVersion,
      primarySku: variants.primarySku,
      primaryOfferId: firstDefined(draft.offerId, draft.offer_id, collectItem.offerId, collectItem.offer_id, ""),
      primaryName: firstDefined(draft.title, draft.name, collectItem.name, collectItem.title, ""),
    },
    source: {
      sourceType,
      sourceRecordId,
      sourceVersion,
      productDraftId: firstDefined(input.productDraft?.id, null),
      productDraftVersion: firstDefined(input.productDraft?.version, null),
    },
    targetCategory: categorySnapshot(draft),
    attributes: firstDefined(draft.attributes, draft.categoryAttributes, []),
    logistics: firstDefined(draft.logistics, {
      packageWeight: draft.packageWeight,
      packageLength: draft.packageLength,
      packageWidth: draft.packageWidth,
      packageHeight: draft.packageHeight,
    }),
    productMeasurements: productMeasurements(draft, collectItem),
    priceEvidence: priceSnapshot(draft, collectItem),
    variants: variants.variants,
    media: {
      images: firstDefined(draft.images, collectItem.images, []),
      video: firstDefined(draft.video, null),
      videos: firstDefined(draft.videos, draft.media, collectItem.videos, []),
    },
    richContent: firstDefined(draft.richContent, draft.rich_content, collectItem.richContent, collectItem.rich_content, null),
    rawEvidence: {
      rawResponseRef: firstDefined(input.rawResponseRef, null),
      rawResponseHash: firstDefined(input.rawResponseHash, null),
    },
  });
  const serialized = JSON.stringify(snapshot);
  return {
    snapshot,
    snapshotHash: crypto.createHash("sha256").update(serialized).digest("hex"),
    rawResponseRef: firstDefined(input.rawResponseRef, null),
  };
}
