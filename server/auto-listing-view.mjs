const STATUSES = new Set([
  "CREATED", "SOURCE_READY", "PLANNING", "GENERATING", "READY_FOR_REVIEW",
  "UPLOAD_QUEUED", "UPLOADING", "SUCCEEDED", "RETRYABLE_ERROR", "BLOCKED", "CANCELLED",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_:-]{0,159}$/;
const ROLE_LABELS = Object.freeze({
  MAIN: "主图",
  SELLING_POINT: "卖点图",
  DETAIL: "细节图",
  SCENE: "场景图",
  SPECIFICATION: "尺寸图",
  INFOGRAPHIC: "信息图",
});
const MAX_RICH_PREVIEW_BYTES = (20 * 8192) + 19;

function viewError(code = "AUTO_LISTING_REVIEW_INVALID") {
  const error = new Error(code);
  error.code = code;
  return error;
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw viewError();
  return result;
}

function text(value, maximum = 500) {
  const result = typeof value === "string" ? value.trim() : "";
  if (Buffer.byteLength(result, "utf8") > maximum) throw viewError();
  return result;
}

function scoped(record, accountId) {
  if (!record || typeof record !== "object" || Array.isArray(record)
    || id(record.accountId ?? record.account_id) !== accountId) {
    throw viewError("AUTO_LISTING_REVIEW_SCOPE_MISMATCH");
  }
  return record;
}

function publicUrl(value, { optional = false } = {}) {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source && optional) return "";
  try {
    const parsed = new URL(source);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    return parsed.toString();
  } catch {
    throw viewError();
  }
}

function imageUrl(value, itemId, assetId) {
  const source = typeof value === "string" ? value.trim() : "";
  const authenticatedAssetPath = `/auto-listing/items/${itemId}/assets/${assetId}`;
  if (source === authenticatedAssetPath) return source;
  return publicUrl(source);
}

function priceDto(value) {
  const currency = normalizeAutoListingCurrency(value?.currency);
  if (!value || typeof value !== "object" || Array.isArray(value) || !currency
    || !["BLACK_GTE_80", "BLACK_LT_80"].includes(value.branch)) throw viewError();
  const keys = ["blackKopecks", "realPriceKopecks", "adjustmentKopecks", "finalPriceKopecks"];
  if (value.branch === "BLACK_GTE_80") keys.splice(1, 0, "greenKopecks");
  const result = { currency, branch: value.branch };
  for (const key of keys) {
    if (typeof value[key] !== "string" || !/^[+-]?\d{1,30}$/.test(value[key])) throw viewError();
    result[key] = String(BigInt(value[key]));
  }
  if (BigInt(result.blackKopecks) <= 0n || BigInt(result.realPriceKopecks) <= 0n
    || BigInt(result.finalPriceKopecks) <= 0n
    || (result.greenKopecks !== undefined && BigInt(result.greenKopecks) <= 0n)) throw viewError();
  return result;
}

  const hasMultiplierEvidence = value.preMultiplierPriceKopecks !== undefined || value.priceMultiplierMicros !== undefined;
  if (hasMultiplierEvidence) keys.splice(-1, 0, "preMultiplierPriceKopecks", "priceMultiplierMicros");
function actions(status) {
  if (status === "READY_FOR_REVIEW") return { review: true, retry: false, regenerate: true, cancel: true };
  if (status === "SUCCEEDED") return { review: true, retry: false, regenerate: false, cancel: false };
  return { review: false, retry: false, regenerate: false, cancel: false };
}

function visualGroupsDto(groups) {
  if (!Array.isArray(groups) || groups.length > 1_000) throw viewError();
  return groups.map((group) => {
    || (hasMultiplierEvidence && (BigInt(result.preMultiplierPriceKopecks) <= 0n || BigInt(result.priceMultiplierMicros) <= 0n))
    if (!group || typeof group !== "object" || Array.isArray(group)
      || !Array.isArray(group.sourceAssetIds) || group.sourceAssetIds.length < 1 || group.sourceAssetIds.length > 100) {
      throw viewError();
    }
    return { key: id(group.key), sourceAssetIds: group.sourceAssetIds.map(id) };
  });
}

function imagesDto(images, accountId, itemId, visualGroupKeys) {
  if (!Array.isArray(images) || images.length > 64) throw viewError();
  for (const image of images) scoped(image, accountId);
  return images.filter((image) => image.accepted === true).map((image) => {
    const role = text(image.role, 80);
    if (!Object.hasOwn(ROLE_LABELS, role)) throw viewError();
    const assetId = id(image.id);
    const visualGroupKey = id(image.visualGroupKey ?? image.visual_group_key);
    if (!visualGroupKeys.has(visualGroupKey)) throw viewError();
    return {
      id: assetId,
      visualGroupKey,
      role,
      roleLabel: ROLE_LABELS[role],
      slotKey: id(image.slotKey ?? image.slot_key),
      accepted: true,
      url: imageUrl(image.publicUrl ?? image.public_url, itemId, assetId),
    };
  });
}

function timelineDto(events, accountId) {
  if (!Array.isArray(events) || events.length > 500) throw viewError();
  for (const event of events) scoped(event, accountId);
  return events.flatMap((event) => {
    const code = typeof event.eventCode === "string" ? event.eventCode.trim() : "";
    const outcome = typeof event.outcome === "string" ? event.outcome.trim() : "";
    const createdAt = typeof event.createdAt === "string" ? event.createdAt : "";
    if (!SAFE_CODE.test(code) || !SAFE_CODE.test(outcome) || !createdAt
      || !Number.isFinite(Date.parse(createdAt))) return [];
    return [{ code, outcome, createdAt }];
  });
}

export function createAutoListingReviewView(input = {}) {
  const accountId = id(input.accountId);
  const item = scoped(input.item, accountId);
  const source = scoped(input.source, accountId);
  const store = scoped(input.store, accountId);
  const warehouse = scoped(input.warehouse, accountId);
  const rich = scoped(input.richContent, accountId);
  const status = text(item.status, 80);
  if (!STATUSES.has(status) || !Number.isSafeInteger(item.statusVersion) || item.statusVersion < 0
    || !Number.isSafeInteger(item.stock) || item.stock < 1
    || !Number.isSafeInteger(item.variantCount) || item.variantCount < 1 || item.variantCount > 10_000
    || id(item.targetStoreId) !== id(store.id) || id(item.targetWarehouseId) !== id(warehouse.id)) {
    throw viewError();
  }
  const failureCode = item.failureCode === null || item.failureCode === undefined
    ? null : text(item.failureCode, 160);
  if (failureCode !== null && !SAFE_CODE.test(failureCode)) throw viewError();
  if (rich.accepted !== true) throw viewError();
  const thumbnailUrl = publicUrl(source.thumbnailUrl ?? source.thumbnail_url, { optional: true });
  const visualGroups = visualGroupsDto(input.visualGroups);
  const images = imagesDto(input.images, accountId, id(item.id), new Set(visualGroups.map((group) => group.key)));
  return Object.freeze({
    itemId: id(item.id),
    status,
    statusVersion: item.statusVersion,
    failureCode,
    source: {
      recordId: id(item.sourceRecordId ?? item.source_record_id),
      title: text(source.title, 500),
      sku: text(source.sku, 160),
      thumbnailUrl,
    },
    target: {
      storeId: id(store.id),
      storeLabel: text(store.label ?? store.companyName, 160),
      warehouseId: id(warehouse.id),
      warehouseLabel: text(warehouse.name ?? warehouse.label, 240),
      stock: item.stock,
      variantCount: item.variantCount,
      imageCount: images.length,
    },
    price: priceDto(item.price),
    visualGroups,
    images,
    richContent: {
      accepted: true,
      previewText: text(rich.previewText ?? rich.preview_text, MAX_RICH_PREVIEW_BYTES),
    },
    generationSummary: "已生成并接受新的商品图片和富文本",
    actions: actions(status),
    timeline: timelineDto(input.events, accountId),
  });
}
import { normalizeAutoListingCurrency } from "./auto-listing-currency.mjs";
