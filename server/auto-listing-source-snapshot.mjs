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

// Read-only pricing projection for independent listing workflows; no snapshot or strategy gate.
export function readAutoListingSourcePrice({ record = {}, fallback = null, collectItem = {}, currencyContext = {} } = {}) {
  return priceEvidence(record, fallback, collectItem, currencyContext, { ignoreMalformedDecimalCandidates: true });
}

function priceEvidence(record, fallback, collectItem, currencyContext, {
  allowFallbackPrices = true,
  ignoreMalformedDecimalCandidates = false,
} = {}) {
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
  const historicalDisplayMinorUnits = (value) => {
    const display = String(value).trim();
    const displayCurrency = /(?:¥|￥|\bCNY\b)/iu.test(display)
      ? "CNY"
      : /(?:₽|\bRUB\b|руб)/iu.test(display) ? "RUB" : "";
    if (displayCurrency && displayCurrency !== currency) return "";
    const numeric = display
      .replace(/(?:\bCNY\b|\bRUB\b|руб(?:\.|\p{L})*)/giu, "")
      .replace(/[¥￥₽]/gu, "")
      .trim();
    if (!numeric || !/^[0-9][0-9.,'’\s\u00a0\u2007\u202f]*$/u.test(numeric)) return "";
    let decimal = numeric.replace(/['’\s\u00a0\u2007\u202f]/gu, "");
    const comma = decimal.lastIndexOf(",");
    const dot = decimal.lastIndexOf(".");
    const separator = Math.max(comma, dot);
    if (separator >= 0) {
      const fractionalDigits = decimal.length - separator - 1;
      decimal = fractionalDigits >= 1 && fractionalDigits <= 2
        ? `${decimal.slice(0, separator).replace(/[.,]/gu, "")}.${decimal.slice(separator + 1)}`
        : decimal.replace(/[.,]/gu, "");
    }
    const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/u.exec(decimal);
    if (!match) return "";
    const result = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0") || "0");
    return result <= POSTGRES_BIGINT_MAX ? String(result) : "";
  };
  const minorUnits = (...values) => {
    for (const value of values) {
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
        if (ignoreMalformedDecimalCandidates) continue;
        throw sourceError("AUTO_LISTING_SOURCE_INVALID");
      }
      const decimal = String(value).trim();
      const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/u.exec(decimal);
      if (!match) {
        if (ignoreMalformedDecimalCandidates) {
          const recovered = historicalDisplayMinorUnits(decimal);
          if (recovered) return recovered;
          continue;
        }
        throw sourceError("AUTO_LISTING_SOURCE_INVALID");
      }
      const result = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0") || "0");
      if (result > POSTGRES_BIGINT_MAX) {
        if (ignoreMalformedDecimalCandidates) continue;
        throw sourceError("AUTO_LISTING_SOURCE_INVALID");
      }
      return String(result);
    }
    return "";
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

const VISUAL_ASPECT_KINDS = new Map([
  ["цвет", "COLOR"],
  ["color", "COLOR"],
  ["colour", "COLOR"],
  ["рисунок", "PATTERN"],
  ["узор", "PATTERN"],
  ["принт", "PATTERN"],
  ["pattern", "PATTERN"],
  ["форма", "SHAPE"],
  ["shape", "SHAPE"],
  ["материал", "MATERIAL"],
  ["material", "MATERIAL"],
  ["количество предметов", "ACCESSORY_COUNT"],
  ["количество в комплекте", "ACCESSORY_COUNT"],
  ["number of items", "ACCESSORY_COUNT"],
]);
const SIZE_ASPECTS = new Set([
  "размер", "российский размер", "size", "объем", "обьем", "volume", "вместимость", "capacity",
]);

function normalizedAspectLabel(value) {
  return text(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function variantFact(kind, value) {
  const factId = crypto.createHash("sha256").update(`${kind}\u0000${value}`).digest("hex").slice(0, 24);
  return { factId: `fact.variant.${factId}`, kind, value };
}

function evidenceFromVariantAspects(value, sku) {
  if (value?.evidence !== undefined && value.evidence !== null) return value.evidence;
  const aspects = value?.aspectValues;
  if (!aspects || typeof aspects !== "object" || Array.isArray(aspects)) return null;
  const appearanceFacts = [];
  const sizeFacts = [];
  let ambiguous = false;
  for (const [rawName, rawValue] of Object.entries(aspects)) {
    const name = normalizedAspectLabel(rawName);
    const factValue = typeof rawValue === "string" || typeof rawValue === "number"
      ? String(rawValue).replace(/\s+/gu, " ").trim()
      : "";
    if (!name || !factValue || factValue.length > 2048 || /[\u0000-\u001f\u007f]/u.test(factValue)) {
      ambiguous = true;
      continue;
    }
    const appearanceKind = VISUAL_ASPECT_KINDS.get(name);
    if (appearanceKind) appearanceFacts.push(variantFact(appearanceKind, factValue));
    else if (SIZE_ASPECTS.has(name)) sizeFacts.push(variantFact("SIZE", factValue));
    else ambiguous = true;
  }
  if (!appearanceFacts.length && !sizeFacts.length) return null;
  return {
    contractVersion: 1,
    variantId: `source-sku:${sku}`,
    appearanceStatus: ambiguous || !appearanceFacts.length ? "AMBIGUOUS" : "COMPLETE",
    appearanceFacts,
    sizeFacts,
  };
}

function ozoneMediaIdentity(entry) {
  const url = typeof entry === "string"
    ? entry
    : (entry && typeof entry === "object" && !Array.isArray(entry)
      ? firstDefined(entry.url, entry.src, entry.imageUrl)
      : null);
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    if (!/(?:^|\.)ozone\.ru$/iu.test(parsed.hostname)) return null;
    const pathname = parsed.pathname.replace(/\/wc\d+(?=\/)/giu, "");
    if (!/^\/s3\/multimedia-/iu.test(pathname)) return null;
    return `ozon:${pathname}`;
  } catch {
    return null;
  }
}

function mergedMedia(...collections) {
  const result = [];
  const seen = new Set();
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      const normalized = jsonSafe(entry);
      const key = ozoneMediaIdentity(normalized) || JSON.stringify(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
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
    media: firstNonEmptyArray(draft.images, draft.media, collectItem.images),
    groupId: firstDefined(draft.variantGroupId, draft.groupId, null),
    relation: firstDefined(draft.relation, draft.variantRelation, draft.groupEvidence, null),
    evidence: firstDefined(draft.evidence, null),
  };
  const records = Array.isArray(draft.variants) && draft.variants.length ? draft.variants : [primary];
  const variants = records.map((record) => {
    const value = record && typeof record === "object" && !Array.isArray(record) ? record : {};
    const sku = text(firstDefined(value.sku, value.sourceSku, value.source_sku));
    if (!sku) throw sourceError("AUTO_LISTING_SOURCE_SKU_REQUIRED");
    const variantMedia = firstNonEmptyArray(value.media, value.images);
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
        { allowFallbackPrices: sku === primarySku, ignoreMalformedDecimalCandidates: true },
      ),
      media: sku === primarySku ? mergedMedia(primary.media, variantMedia) : mergedMedia(variantMedia),
      groupId: firstDefined(value.variantGroupId, value.groupId, value.group_id, null),
      relation: firstDefined(value.relation, value.variantRelation, value.groupEvidence, null),
      evidence: evidenceFromVariantAspects(value, sku),
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
