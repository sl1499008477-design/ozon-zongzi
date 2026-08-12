import {
  classifyOzonCategoryImportResult,
  projectOzonImportCarrier,
} from "./ozon-category-import-error-policy.mjs";

const SUCCEEDED_STATES = new Set(["imported", "success", "processed", "done", "complete", "completed", "finished"]);
const CHECKING_STATES = new Set(["pending", "processing", "created", "queued", "running", "importing", "checking", "in_progress"]);
const FAILED_STATES = new Set(["failed", "error", "rejected", "cancelled", "canceled", "validation_error"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function normalizeStatus(value = "") {
  if (typeof value !== "string") return "UNKNOWN_RESULT";
  const status = value.toLowerCase();
  if (SUCCEEDED_STATES.has(status)) return "SUCCEEDED";
  if (status === "skipped") return "SKIPPED";
  if (FAILED_STATES.has(status)) return "FAILED";
  if (CHECKING_STATES.has(status)) return "CHECKING";
  return "UNKNOWN_RESULT";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function projectedImportInfoItems(projected) {
  const root = objectValue(projected);
  if (!root) return [];
  const result = objectValue(root.result) || Object.create(null);
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(root.items)) return root.items;
  if (Array.isArray(result.products)) return result.products;
  if (Array.isArray(root.products)) return root.products;
  return [];
}

export function importInfoItems(data) {
  const projected = projectOzonImportCarrier(data);
  return deepFreeze(projectedImportInfoItems(projected));
}

function safeOptions(rawOptions) {
  if (rawOptions === undefined) return { expectedOfferIds: null };
  const options = projectOzonImportCarrier(rawOptions);
  if (!objectValue(options) || Object.keys(options).some((key) => key !== "expectedOfferIds")) return null;
  if (!Array.isArray(options.expectedOfferIds)) return null;
  const ids = options.expectedOfferIds;
  if (ids.some((value) => typeof value !== "string" || value.length === 0 || value.length > 240)) return null;
  if (new Set(ids).size !== ids.length) return null;
  return { expectedOfferIds: ids };
}

function safeString(value, max = 240) {
  return typeof value === "string" && value.length <= max ? value : "";
}

function safeProductId(value) {
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") return "";
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,239}$/u.test(value)) return value;
  return "";
}

function itemOfferId(item) {
  return safeString(item?.offer_id);
}

function normalizedUnknown(index, response = {}) {
  return Object.freeze({
    index,
    sku: "",
    offerId: "",
    productId: "",
    status: "UNKNOWN_RESULT",
    errors: Object.freeze([]),
    classification: "UNKNOWN_RESULT",
    errorEvidence: null,
    response,
  });
}

function normalizeItem(item, index, expectedOfferId, batchHasPartialOutcome) {
  if (!objectValue(item)) return normalizedUnknown(index, item || {});
  const classified = classifyOzonCategoryImportResult({ item, expectedOfferId, batchHasPartialOutcome });
  const status = classified.classification === "SUCCEEDED"
    ? "SUCCEEDED"
    : classified.classification === "CHECKING"
      ? "CHECKING"
      : ["EXPLICIT_CATEGORY_FAILURE", "OTHER_TERMINAL_FAILURE"].includes(classified.classification)
        ? (String(item.status || "").toLowerCase() === "skipped" ? "SKIPPED" : "FAILED")
        : "UNKNOWN_RESULT";
  return Object.freeze({
    index,
    sku: safeString(item.sku),
    offerId: itemOfferId(item),
    productId: safeProductId(item.product_id),
    status,
    errors: Object.freeze(status === "FAILED" ? ["OZON_ITEM_RESULT"] : []),
    classification: classified.classification,
    errorEvidence: classified.errorEvidence,
    response: item,
  });
}

function unknownResult() {
  return Object.freeze({
    status: "UNKNOWN_RESULT",
    done: false,
    failed: 0,
    success: 0,
    skipped: 0,
    items: Object.freeze([]),
    errorMessage: "",
    statusMessage: "",
  });
}

export function deriveOzonImportStatus(data, rawOptions) {
  const projected = deepFreeze(projectOzonImportCarrier(data));
  const options = safeOptions(rawOptions);
  const root = objectValue(projected);
  if (!root || !options) return unknownResult();
  const rawItems = projectedImportInfoItems(root);
  if (rawItems.length) {
    const rawOffers = rawItems.map(itemOfferId);
    const expectedOffers = options.expectedOfferIds || rawOffers;
    const expectedSet = new Set(expectedOffers);
    const rawOfferSet = new Set(rawOffers);
    const identityInvalid = rawOffers.some((offerId) => !offerId)
      || rawOfferSet.size !== rawOffers.length
      || expectedOffers.length !== rawOffers.length
      || expectedSet.size !== expectedOffers.length
      || expectedOffers.some((offerId) => !rawOfferSet.has(offerId));
    const preliminary = rawItems.map((item, index) => normalizeItem(
      item,
      index,
      !identityInvalid && expectedSet.has(rawOffers[index]) ? rawOffers[index] : "",
      false,
    ));
    const batchHasPartialOutcome = preliminary.some((item) => ["SUCCEEDED", "SKIPPED"].includes(item.status));
    const normalizedItems = preliminary.map((item, index) => item.status === "FAILED"
      ? normalizeItem(rawItems[index], index,
        !identityInvalid && expectedSet.has(rawOffers[index]) ? rawOffers[index] : "", batchHasPartialOutcome)
      : item);
    const failed = normalizedItems.filter((item) => item.status === "FAILED").length;
    const success = normalizedItems.filter((item) => item.status === "SUCCEEDED").length;
    const skipped = normalizedItems.filter((item) => item.status === "SKIPPED").length;
    const unknown = normalizedItems.some((item) => item.status === "UNKNOWN_RESULT");
    const done = !unknown && failed + success + skipped === normalizedItems.length;
    const status = unknown
      ? "UNKNOWN_RESULT"
      : !done
        ? "CHECKING"
        : failed
          ? (success || skipped ? "PARTIAL_SUCCESS" : "FAILED")
          : (success ? (skipped ? "PARTIAL_SUCCESS" : "SUCCEEDED") : "FAILED");
    return Object.freeze({
      status,
      done,
      failed,
      success,
      skipped,
      items: Object.freeze(normalizedItems),
      errorMessage: failed ? "Ozon 返回商品导入失败" : "",
      statusMessage: skipped ? `Ozon 跳过了 ${skipped} 个变体` : "",
    });
  }
  const result = objectValue(root.result) || Object.create(null);
  const direct = normalizeStatus(result.status ?? result.state ?? root.status ?? root.state ?? "");
  return Object.freeze({
    status: direct,
    done: ["SUCCEEDED", "FAILED", "SKIPPED"].includes(direct),
    failed: direct === "FAILED" ? 1 : 0,
    success: direct === "SUCCEEDED" ? 1 : 0,
    skipped: direct === "SKIPPED" ? 1 : 0,
    items: Object.freeze([]),
    errorMessage: direct === "FAILED" ? "Ozon 返回商品导入失败" : "",
    statusMessage: "",
  });
}
