import crypto from "node:crypto";

import { verifyAutoListingFrozenConfig } from "./auto-listing-contract.mjs";
import { calculateAutoListingPrice } from "./auto-listing-pricing.mjs";
import {
  AUTO_LISTING_OZON_RICH_CONTENT_VERSION,
  convertAutoListingRichContentToOzon,
} from "./auto-listing-ozon-rich-content.mjs";

const BASE_VERSION = "AUTO_LISTING_LISTING_BASE_V1";
const DRAFT_VERSION = "AUTO_LISTING_SUBMISSION_DRAFT_V1";
const HASH = /^[a-f0-9]{64}$/u;
const MAX_BASE_BYTES = 10 * 1024 * 1024;
const BASE_INPUT_KEYS = new Set([
  "accountId", "jobId", "itemId", "sourceSnapshotId", "collectItemId", "targetStoreId",
  "productDraft", "pricingEvidence", "richContentAttributeSupported", "variants", "versions",
]);
const BASE_KEYS = new Set([...BASE_INPUT_KEYS, "version", "canonicalHash"]);
const PRODUCT_DRAFT_KEYS = new Set(["id", "version", "dataHash"]);
const PRICING_EVIDENCE_KEYS = new Set(["currency", "blackKopecks", "greenKopecks", "evidenceHash"]);
const VERSIONS_KEYS = new Set(["normalizerVersion", "categoryRuleVersion", "dictionaryVersion"]);
const VARIANT_KEYS = new Set(["sourceVariantId", "sourceSku", "item"]);
const OVERLAY_INPUT_KEYS = new Set([
  "listingBase", "visualGroups", "acceptedAssets", "acceptedRichContent", "frozenConfig",
  "targetWarehousePlatformId", "publicationPolicy",
]);
const VISUAL_GROUPS_KEYS = new Set(["accountId", "jobId", "itemId", "planId", "groups"]);
const GROUP_KEYS = new Set(["visualGroupKey", "variantIds", "slots"]);
const SLOT_KEYS = new Set(["slotKey", "role", "order"]);
const RICH_RESULT_KEYS = new Set([
  "accountId", "jobId", "itemId", "planId", "visualGroupKey", "status", "content", "outputHash",
]);
const FROZEN_CONFIG_KEYS = new Set(["config", "configHash"]);
const ROLES = new Set(["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"]);
const CONFIG_ROLE_TO_ASSET_ROLE = Object.freeze({
  main: "MAIN", sellingPoint: "SELLING_POINT", detail: "DETAIL", scene: "SCENE",
  specification: "SPECIFICATION", infographic: "INFOGRAPHIC",
});
const SENSITIVE_KEY = /^(?:api[_-]?key|password|passwd|secret|authorization|cookie|credential|private[_-]?key|access[_-]?token|refresh[_-]?token)$/iu;

function baseInvalid() {
  const error = new Error("自动上架冻结商品底稿无效");
  error.code = "AUTO_LISTING_LISTING_BASE_INVALID";
  error.retryable = false;
  return error;
}

function overlayInvalid() {
  const error = new Error("自动上架覆盖内容无效");
  error.code = "AUTO_LISTING_OVERLAY_INVALID";
  error.retryable = false;
  return error;
}

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactObject = (value, keys) => plainObject(value)
  && Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
const compareText = (left, right) => Buffer.from(String(left), "utf8").compare(Buffer.from(String(right), "utf8"));
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonical(value[key])]))
    : value;
const canonicalText = (value) => JSON.stringify(canonical(value));
const hash = (value) => crypto.createHash("sha256").update(canonicalText(value), "utf8").digest("hex");

function text(value, maximum = 240) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw baseInvalid();
  return value;
}

function overlayText(value, maximum = 240) {
  try { return text(value, maximum); } catch { throw overlayInvalid(); }
}

function assertJsonSafe(value, errorFactory, active = new Set(), depth = 0) {
  if (depth > 100) throw errorFactory();
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw errorFactory();
    return;
  }
  if (!Array.isArray(value) && !plainObject(value)) throw errorFactory();
  if (active.has(value)) throw errorFactory();
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) assertJsonSafe(entry, errorFactory, active, depth + 1);
    } else {
      for (const [key, entry] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(key) || SENSITIVE_KEY.test(key)) throw errorFactory();
        assertJsonSafe(entry, errorFactory, active, depth + 1);
      }
    }
  } finally {
    active.delete(value);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value, errorFactory) {
  try { return structuredClone(value); } catch { throw errorFactory(); }
}

function validSourceUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 8_192) return false;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
}

function validateNormalizedItem(item) {
  if (!plainObject(item) || !text(item.offer_id, 1_000) || !text(item.name, 1_000)
    || typeof item.price !== "string" || !/^\d+(?:\.\d{1,2})?$/u.test(item.price)
    || item.currency_code !== "RUB"
    || !Number.isSafeInteger(item.description_category_id) || item.description_category_id < 1
    || !Number.isSafeInteger(item.type_id) || item.type_id < 1
    || !Number.isSafeInteger(item.weight) || item.weight < 1 || item.weight_unit !== "g"
    || !Number.isSafeInteger(item.depth) || item.depth < 1
    || !Number.isSafeInteger(item.width) || item.width < 1
    || !Number.isSafeInteger(item.height) || item.height < 1 || item.dimension_unit !== "mm"
    || !Array.isArray(item.images) || item.images.length < 1 || item.images.some((url) => !validSourceUrl(url))
    || !validSourceUrl(item.primary_image) || !Array.isArray(item.attributes)) throw baseInvalid();
  const attributeKeys = new Set();
  for (const attribute of item.attributes) {
    if (!plainObject(attribute) || !Number.isSafeInteger(Number(attribute.id)) || Number(attribute.id) < 1
      || !Number.isSafeInteger(Number(attribute.complex_id)) || Number(attribute.complex_id) < 0
      || !Array.isArray(attribute.values) || attribute.values.length < 1) throw baseInvalid();
    const key = `${Number(attribute.complex_id)}:${Number(attribute.id)}`;
    if (attributeKeys.has(key)) throw baseInvalid();
    attributeKeys.add(key);
  }
  assertJsonSafe(item, baseInvalid);
}

function normalizePricingEvidence(value) {
  if (!exactObject(value, PRICING_EVIDENCE_KEYS) || value.currency !== "RUB"
    || typeof value.blackKopecks !== "string" || !/^\d{1,30}$/u.test(value.blackKopecks)
    || !(value.greenKopecks === null || (typeof value.greenKopecks === "string" && /^\d{1,30}$/u.test(value.greenKopecks)))
    || !HASH.test(value.evidenceHash || "")) throw baseInvalid();
  const black = BigInt(value.blackKopecks);
  const green = value.greenKopecks === null ? null : BigInt(value.greenKopecks);
  if (black < 1n || (black >= 8_000n && (green === null || green < 1n || green > black))
    || (black < 8_000n && green !== null)) throw baseInvalid();
  const evidence = {
    currency: "RUB",
    blackKopecks: String(black),
    greenKopecks: green === null ? null : String(green),
  };
  if (hash(evidence) !== value.evidenceHash) throw baseInvalid();
  return { ...evidence, evidenceHash: value.evidenceHash };
}

function normalizeBaseInput(input) {
  if (!exactObject(input, BASE_INPUT_KEYS) || !exactObject(input.productDraft, PRODUCT_DRAFT_KEYS)
    || !exactObject(input.versions, VERSIONS_KEYS) || !Array.isArray(input.variants)
    || input.variants.length < 1 || input.variants.length > 1_000) throw baseInvalid();
  const scope = {
    accountId: text(input.accountId), jobId: text(input.jobId), itemId: text(input.itemId),
    sourceSnapshotId: text(input.sourceSnapshotId), collectItemId: text(input.collectItemId),
    targetStoreId: text(input.targetStoreId),
  };
  const productDraft = {
    id: text(input.productDraft.id),
    version: input.productDraft.version,
    dataHash: input.productDraft.dataHash,
  };
  if (!Number.isSafeInteger(productDraft.version) || productDraft.version < 1 || !HASH.test(productDraft.dataHash || "")) throw baseInvalid();
  const versions = {
    normalizerVersion: text(input.versions.normalizerVersion),
    categoryRuleVersion: text(input.versions.categoryRuleVersion),
    dictionaryVersion: text(input.versions.dictionaryVersion),
  };
  const pricingEvidence = normalizePricingEvidence(input.pricingEvidence);
  if (typeof input.richContentAttributeSupported !== "boolean") throw baseInvalid();
  const variantIds = new Set();
  const sourceSkus = new Set();
  const offerIds = new Set();
  const variants = input.variants.map((variant) => {
    if (!exactObject(variant, VARIANT_KEYS)) throw baseInvalid();
    const sourceVariantId = text(variant.sourceVariantId);
    const sourceSku = text(variant.sourceSku, 1_000);
    validateNormalizedItem(variant.item);
    if (variantIds.has(sourceVariantId) || sourceSkus.has(sourceSku) || offerIds.has(variant.item.offer_id)) throw baseInvalid();
    variantIds.add(sourceVariantId);
    sourceSkus.add(sourceSku);
    offerIds.add(variant.item.offer_id);
    return { sourceVariantId, sourceSku, item: clone(variant.item, baseInvalid) };
  });
  const payload = {
    version: BASE_VERSION, ...scope, productDraft, pricingEvidence,
    richContentAttributeSupported: input.richContentAttributeSupported, variants, versions,
  };
  assertJsonSafe(payload, baseInvalid);
  if (Buffer.byteLength(canonicalText(payload), "utf8") > MAX_BASE_BYTES) throw baseInvalid();
  return payload;
}

/** Freezes only a complete target-store-normalized Ozon-ready base, never the compact AI snapshot. */
export function freezeAutoListingListingBase(input = {}) {
  const payload = normalizeBaseInput(input);
  return deepFreeze({ ...payload, canonicalHash: hash(payload) });
}

function verifyListingBase(value) {
  if (!exactObject(value, BASE_KEYS) || value.version !== BASE_VERSION || !HASH.test(value.canonicalHash || "")) throw baseInvalid();
  const rebuilt = normalizeBaseInput({
    accountId: value.accountId,
    jobId: value.jobId,
    itemId: value.itemId,
    sourceSnapshotId: value.sourceSnapshotId,
    collectItemId: value.collectItemId,
    targetStoreId: value.targetStoreId,
    productDraft: value.productDraft,
    pricingEvidence: value.pricingEvidence,
    richContentAttributeSupported: value.richContentAttributeSupported,
    variants: value.variants,
    versions: value.versions,
  });
  if (hash(rebuilt) !== value.canonicalHash || canonicalText({ ...rebuilt, canonicalHash: value.canonicalHash }) !== canonicalText(value)) throw baseInvalid();
  return rebuilt;
}

function verifyFrozenConfig(value) {
  if (!exactObject(value, FROZEN_CONFIG_KEYS) || !HASH.test(value.configHash || "")) throw overlayInvalid();
  try { return verifyAutoListingFrozenConfig(value.config, value.configHash).config; } catch { throw overlayInvalid(); }
}

function derivePrice(pricingEvidence, adjustmentKopecks) {
  let calculated;
  try {
    calculated = calculateAutoListingPrice({
      currency: pricingEvidence.currency,
      blackKopecks: pricingEvidence.blackKopecks,
      ...(pricingEvidence.greenKopecks === null ? {} : { greenKopecks: pricingEvidence.greenKopecks }),
      adjustmentKopecks,
    });
  } catch { throw overlayInvalid(); }
  if (!/^\d{1,30}$/u.test(calculated.finalPriceKopecks)) throw overlayInvalid();
  const kopecks = BigInt(calculated.finalPriceKopecks);
  return { calculated, rubles: `${kopecks / 100n}.${String(kopecks % 100n).padStart(2, "0")}` };
}

function verifyRichResult(value, scope, visualGroupKey) {
  if (!exactObject(value, RICH_RESULT_KEYS) || value.status !== "ACCEPTED" || !HASH.test(value.outputHash || "")
    || value.accountId !== scope.accountId || value.jobId !== scope.jobId || value.itemId !== scope.itemId
    || value.planId !== scope.planId || value.visualGroupKey !== visualGroupKey) throw overlayInvalid();
  assertJsonSafe(value.content, overlayInvalid);
  if (hash(value.content) !== value.outputHash) throw overlayInvalid();
  return clone(value.content, overlayInvalid);
}

function expectedRoleCounts(config) {
  return Object.fromEntries(Object.entries(CONFIG_ROLE_TO_ASSET_ROLE)
    .map(([configRole, assetRole]) => [assetRole, config.image.roles[configRole]]));
}

function verifyGroups(value, variants, base, config) {
  if (!exactObject(value, VISUAL_GROUPS_KEYS) || value.accountId !== base.accountId
    || value.jobId !== base.jobId || value.itemId !== base.itemId || !overlayText(value.planId)
    || !Array.isArray(value.groups) || value.groups.length < 1 || value.groups.length > 1_000) throw overlayInvalid();
  const validVariantIds = new Set(variants.map((variant) => variant.sourceVariantId));
  const mapped = new Set();
  const groupKeys = new Set();
  const variantToGroup = new Map();
  const groupContracts = new Map();
  const globalSlotKeys = new Set();
  const rolesExpected = expectedRoleCounts(config);
  for (const group of value.groups) {
    if (!exactObject(group, GROUP_KEYS) || !Array.isArray(group.variantIds) || group.variantIds.length < 1
      || !Array.isArray(group.slots) || group.slots.length !== config.image.total) throw overlayInvalid();
    const key = overlayText(group.visualGroupKey);
    if (groupKeys.has(key)) throw overlayInvalid();
    groupKeys.add(key);
    const roleCounts = Object.fromEntries([...ROLES].map((role) => [role, 0]));
    const orders = new Set();
    const slots = group.slots.map((slot) => {
      if (!exactObject(slot, SLOT_KEYS) || !overlayText(slot.slotKey) || globalSlotKeys.has(slot.slotKey)
        || !ROLES.has(slot.role) || !Number.isSafeInteger(slot.order) || slot.order < 0 || slot.order > 100_000
        || orders.has(slot.order)) throw overlayInvalid();
      globalSlotKeys.add(slot.slotKey);
      orders.add(slot.order);
      roleCounts[slot.role] += 1;
      return { slotKey: slot.slotKey, role: slot.role, order: slot.order };
    }).sort((left, right) => left.order - right.order || compareText(left.slotKey, right.slotKey));
    if ([...ROLES].some((role) => roleCounts[role] !== rolesExpected[role])) throw overlayInvalid();
    groupContracts.set(key, { visualGroupKey: key, slots });
    for (const variantId of group.variantIds) {
      const id = overlayText(variantId);
      if (!validVariantIds.has(id) || mapped.has(id)) throw overlayInvalid();
      mapped.add(id);
      variantToGroup.set(id, key);
    }
  }
  if (mapped.size !== validVariantIds.size) throw overlayInvalid();
  return {
    scope: { accountId: value.accountId, jobId: value.jobId, itemId: value.itemId, planId: value.planId },
    groupKeys, groupContracts, variantToGroup,
  };
}

function verifyAssets(values, groupContracts, scope) {
  const groupKeys = new Set(groupContracts.keys());
  if (!Array.isArray(values) || values.length < 6 || values.length > groupKeys.size * 13) throw overlayInvalid();
  const byGroup = new Map([...groupKeys].map((key) => [key, new Map()]));
  const ids = new Set();
  const globalSlots = new Set();
  for (const asset of values) {
    if (!plainObject(asset) || !overlayText(asset.assetId) || ids.has(asset.assetId)
      || asset.status !== "ACCEPTED" || !groupKeys.has(asset.visualGroupKey) || !ROLES.has(asset.role)
      || asset.accountId !== scope.accountId || asset.jobId !== scope.jobId || asset.itemId !== scope.itemId
      || asset.planId !== scope.planId || !overlayText(asset.slotKey) || globalSlots.has(asset.slotKey)) throw overlayInvalid();
    ids.add(asset.assetId);
    globalSlots.add(asset.slotKey);
    const planned = groupContracts.get(asset.visualGroupKey).slots.find((slot) => slot.slotKey === asset.slotKey);
    if (!planned || planned.role !== asset.role) throw overlayInvalid();
    byGroup.get(asset.visualGroupKey).set(asset.slotKey, asset);
  }
  const orderedByGroup = new Map();
  for (const [key, bySlot] of byGroup) {
    const contract = groupContracts.get(key);
    if (bySlot.size !== contract.slots.length) throw overlayInvalid();
    const ordered = contract.slots.map((slot) => bySlot.get(slot.slotKey));
    if (ordered.some((asset) => !asset)) throw overlayInvalid();
    orderedByGroup.set(key, ordered);
  }
  return orderedByGroup;
}

function verifyRichResults(values, groupKeys, scope) {
  if (!Array.isArray(values) || values.length !== groupKeys.size) throw overlayInvalid();
  const results = new Map();
  for (const value of values) {
    const key = value?.visualGroupKey;
    if (!groupKeys.has(key) || results.has(key)) throw overlayInvalid();
    results.set(key, verifyRichResult(value, scope, key));
  }
  return results;
}

function replaceRichContent(attributes, richValue) {
  const copy = clone(attributes, overlayInvalid);
  const indexes = copy.flatMap((attribute, index) => Number(attribute?.id) === 11254 ? [index] : []);
  if (indexes.length > 1) throw overlayInvalid();
  const replacement = { complex_id: 0, id: 11254, values: [{ value: richValue }] };
  if (indexes.length === 1) copy[indexes[0]] = replacement;
  else copy.push(replacement);
  return copy;
}

/** Copies the frozen base and applies only the closed, typed upload overlay. */
export function buildAutoListingSubmissionDraft(input = {}) {
  if (!exactObject(input, OVERLAY_INPUT_KEYS)) throw overlayInvalid();
  const base = verifyListingBase(input.listingBase);
  const config = verifyFrozenConfig(input.frozenConfig);
  const targetWarehousePlatformId = text(input.targetWarehousePlatformId);
  if (config.targetStoreId !== base.targetStoreId || base.richContentAttributeSupported !== true
    || !targetWarehousePlatformId) throw overlayInvalid();
  const price = derivePrice(base.pricingEvidence, config.priceAdjustmentKopecks);
  const { scope, groupKeys, groupContracts, variantToGroup } = verifyGroups(input.visualGroups, base.variants, base, config);
  const assetsByGroup = verifyAssets(input.acceptedAssets, groupContracts, scope);
  const richByGroup = verifyRichResults(input.acceptedRichContent, groupKeys, scope);
  const convertedByGroup = new Map();
  for (const visualGroupKey of groupKeys) {
    convertedByGroup.set(visualGroupKey, convertAutoListingRichContentToOzon({
      richContent: richByGroup.get(visualGroupKey),
      publishedAssets: assetsByGroup.get(visualGroupKey),
      scope: { ...scope, visualGroupKey },
      publicationPolicy: input.publicationPolicy,
    }));
  }

  const items = base.variants.map((variant) => {
    const item = clone(variant.item, overlayInvalid);
    const visualGroupKey = variantToGroup.get(variant.sourceVariantId);
    const groupAssets = assetsByGroup.get(visualGroupKey);
    const images = groupAssets.map((asset) => asset.publishedUrl);
    item.images = images;
    const mainIndex = groupAssets.findIndex((asset) => asset.role === "MAIN");
    if (mainIndex < 0) throw overlayInvalid();
    item.primary_image = images[mainIndex];
    item.price = price.rubles;
    const convertedRich = convertedByGroup.get(visualGroupKey);
    item.attributes = replaceRichContent(item.attributes, convertedRich.value);
    if (Object.hasOwn(item, "richContent")) item.richContent = convertedRich.value;
    if (Object.hasOwn(item, "rich_content")) item.rich_content = convertedRich.value;
    return item;
  });
  const stocks = items.map((item) => ({
    offer_id: item.offer_id,
    warehouse_id: targetWarehousePlatformId,
    stock: config.stock,
  }));
  const payload = {
    version: DRAFT_VERSION,
    listingBaseHash: input.listingBase.canonicalHash,
    targetStoreId: config.targetStoreId,
    targetWarehouseId: config.targetWarehouseId,
    targetWarehousePlatformId,
    planId: scope.planId,
    items,
    stocks,
    priceCalculation: clone(price.calculated, overlayInvalid),
    pricingEvidenceHash: base.pricingEvidence.evidenceHash,
    versions: {
      ...clone(base.versions, overlayInvalid),
      richContentRuleVersion: AUTO_LISTING_OZON_RICH_CONTENT_VERSION,
    },
  };
  assertJsonSafe(payload, overlayInvalid);
  return deepFreeze({ ...payload, resultHash: hash(payload) });
}
