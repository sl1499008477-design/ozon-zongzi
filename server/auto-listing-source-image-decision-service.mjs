import { isSafeAutoListingAiIdentifier } from "./auto-listing-ai-message.mjs";

const INPUT_KEYS = new Set([
  "accountId", "jobId", "itemId", "analysisRunId", "sourceAssetId", "decision",
  "expectedStatusVersion", "idempotencyKey", "correlationId",
]);
const PUBLIC_DECISIONS = new Map([
  ["PRODUCT_MARKING", "PRODUCT_MARKING"],
  ["EXTERNAL_OVERLAY_EXCLUDE", "EXTERNAL_OVERLAY_EXCLUDE"],
  ["EXCLUDE_UNCERTAIN", "UNRESOLVED_EXCLUDE"],
]);

function decisionError(code = "AUTO_LISTING_SOURCE_IMAGE_DECISION_INVALID", status = 400) {
  const error = new Error("来源图片确认操作失败");
  error.code = code;
  error.status = status;
  return error;
}

function closedInput(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw decisionError();
    const keys = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (keys.length !== INPUT_KEYS.size || keys.some((key) => typeof key !== "string"
      || !INPUT_KEYS.has(key) || descriptors[key]?.enumerable !== true
      || !Object.hasOwn(descriptors[key], "value"))) throw decisionError();
    const value = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
    if (![value.accountId, value.jobId, value.itemId, value.analysisRunId, value.sourceAssetId,
      value.idempotencyKey, value.correlationId].every(isSafeAutoListingAiIdentifier)
      || !PUBLIC_DECISIONS.has(value.decision)
      || !Number.isInteger(value.expectedStatusVersion) || value.expectedStatusVersion < 1
      || value.expectedStatusVersion >= 2_147_483_647) throw decisionError();
    return Object.freeze({ ...value, decision: PUBLIC_DECISIONS.get(value.decision) });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_SOURCE_IMAGE_DECISION_INVALID") throw error;
    throw decisionError();
  }
}

function publicResult(value) {
  const run = value?.derivedRun;
  if (!run || !isSafeAutoListingAiIdentifier(run.id)
    || run.status !== "RECONCILING" || !Number.isInteger(run.expectedStatusVersion)
    || run.expectedStatusVersion < 2) {
    throw decisionError("AUTO_LISTING_SOURCE_IMAGE_DECISION_FAILED", 503);
  }
  return Object.freeze({ analysisRunId: run.id, status: "PLANNING", statusVersion: run.expectedStatusVersion });
}

export function createAutoListingSourceImageDecisionService({ repository } = {}) {
  if (typeof repository?.recordSourceImageDecision !== "function") {
    throw new TypeError("Source-image decision repository is required");
  }
  return Object.freeze({
    async recordDecision(raw = {}) {
      const input = closedInput(raw);
      try {
        return publicResult(await repository.recordSourceImageDecision(input));
      } catch (error) {
        if (error?.code === "AUTO_LISTING_SOURCE_IMAGE_DECISION_INVALID"
          || error?.code === "AUTO_LISTING_SOURCE_IMAGE_DECISION_FAILED") throw error;
        if (["AUTO_LISTING_SOURCE_IMAGE_STALE", "AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT",
          "AUTO_LISTING_SOURCE_IMAGE_SCOPE_CONFLICT", "AUTO_LISTING_SOURCE_IMAGE_RUN_NOT_FOUND",
        ].includes(error?.code)) throw decisionError("AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT", 409);
        throw decisionError("AUTO_LISTING_SOURCE_IMAGE_DECISION_FAILED", 503);
      }
    },
  });
}
