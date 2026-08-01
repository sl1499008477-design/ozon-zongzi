export const OZON_ENRICHMENT_FIELDS = Object.freeze([
  "descriptionCategoryId",
  "weightG",
  "lengthMm",
  "widthMm",
  "heightMm",
]);

function positiveNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  if (typeof value !== "string") return 0;
  const text = value.trim();
  if (!/^[+]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return 0;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function firstPositive(...values) {
  for (const value of values) {
    const number = positiveNumber(value);
    if (number) return number;
  }
  return 0;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function enrichmentFieldValues(value = {}) {
  const logistics = value?.logistics && typeof value.logistics === "object" ? value.logistics : {};
  return {
    descriptionCategoryId: firstPositive(value?.descriptionCategoryId, value?.description_category_id),
    weightG: firstPositive(value?.weightG, logistics.weightG, value?.weight),
    lengthMm: firstPositive(value?.lengthMm, logistics.lengthMm, value?.depth),
    widthMm: firstPositive(value?.widthMm, logistics.widthMm, value?.width),
    heightMm: firstPositive(value?.heightMm, logistics.heightMm, value?.height),
  };
}

function sanitizeSummaryOverrides(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return {};
  const attemptCount = Number(overrides.attemptCount);
  const summary = {};
  if (Number.isFinite(attemptCount) && attemptCount >= 0) {
    summary.attemptCount = Math.floor(attemptCount);
  }
  if (typeof overrides.nextAttemptAt === "string") {
    summary.nextAttemptAt = cleanText(overrides.nextAttemptAt);
  }
  if (typeof overrides.lastErrorCode === "string") {
    summary.lastErrorCode = cleanText(overrides.lastErrorCode);
  }
  return summary;
}

export function missingOzonEnrichmentFields(payload) {
  const fields = enrichmentFieldValues(payload);
  return OZON_ENRICHMENT_FIELDS.filter((field) => !positiveNumber(fields[field]));
}

export function buildOzonEnrichmentSummary(payload, overrides = {}) {
  const missingFields = missingOzonEnrichmentFields(payload);
  return {
    status: missingFields.length ? "PENDING_ENRICHMENT" : "COMPLETE",
    missingFields,
    attemptCount: 0,
    nextAttemptAt: "",
    lastErrorCode: "",
    ...sanitizeSummaryOverrides(overrides),
  };
}

export function mergeOzonEnrichmentResult(current = {}, result = {}) {
  const draft = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const currentFields = enrichmentFieldValues(draft);
  const resultFields = enrichmentFieldValues(result);
  const currentLogistics = draft.logistics && typeof draft.logistics === "object" ? draft.logistics : {};
  const logistics = { ...currentLogistics };

  for (const field of OZON_ENRICHMENT_FIELDS.slice(1)) {
    if (!positiveNumber(currentFields[field])) {
      const enriched = positiveNumber(resultFields[field]);
      if (enriched) logistics[field] = enriched;
    }
  }

  const merged = { ...draft, logistics };
  if (!positiveNumber(currentFields.descriptionCategoryId)) {
    const enrichedCategoryId = positiveNumber(resultFields.descriptionCategoryId);
    if (enrichedCategoryId) merged.descriptionCategoryId = enrichedCategoryId;
  }
  return merged;
}

export function retryDelayMs(attemptCount) {
  const attempt = Math.max(1, Math.floor(Number(attemptCount) || 0));
  if (attempt === 1) return 30_000;
  if (attempt === 2) return 120_000;
  if (attempt === 3) return 600_000;
  if (attempt === 4) return 1_800_000;
  return 3_600_000;
}

export function assertOzonListingReady(payload) {
  const missingFields = missingOzonEnrichmentFields(payload);
  if (!missingFields.length) return;
  throw Object.assign(
    new Error(`Ozon 商品补全资料不完整：${missingFields.join(", ")}`),
    { status: 422, code: "COLLECT_ENRICHMENT_INCOMPLETE", missingFields },
  );
}
