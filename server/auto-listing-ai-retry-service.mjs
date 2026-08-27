import { isSafeAutoListingAiIdentifier } from "./auto-listing-ai-message.mjs";

const COMMAND_KEYS = new Set([
  "accountId", "jobId", "itemId", "expectedStatusVersion", "idempotencyKey",
]);
const FACTORY_KEYS = new Set(["repository"]);
const RESULT_KEYS = new Set([
  "status", "statusVersion", "recoveryPoint", "enqueued", "duplicate",
]);
const SAFE_CODES = new Set([
  "AUTO_LISTING_AI_RETRY_VERSION_CONFLICT",
  "AUTO_LISTING_AI_RETRY_NOT_RECOVERABLE",
  "AUTO_LISTING_AI_RETRY_NOT_FOUND",
]);
const MAX_PLAN_SLOTS = 1_000;

function retryError(code, retryable = false) {
  const error = new Error("自动上架 AI 重试操作失败");
  error.code = code;
  error.retryable = retryable;
  return error;
}

function plainClosed(value, keys) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("invalid");
    const actual = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (actual.length !== keys.size || actual.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
      throw new Error("invalid");
    }
    return Object.fromEntries(actual.map((key) => [key, descriptors[key].value]));
  } catch {
    throw retryError("AUTO_LISTING_AI_RETRY_INVALID");
  }
}

function command(raw) {
  const value = plainClosed(raw, COMMAND_KEYS);
  for (const key of ["accountId", "jobId", "itemId", "idempotencyKey"]) {
    if (!isSafeAutoListingAiIdentifier(value[key])) throw retryError("AUTO_LISTING_AI_RETRY_INVALID");
  }
  if (!Number.isInteger(value.expectedStatusVersion) || value.expectedStatusVersion < 1
    || value.expectedStatusVersion >= 2_147_483_647) throw retryError("AUTO_LISTING_AI_RETRY_INVALID");
  return Object.freeze(value);
}

function result(raw) {
  const value = plainClosed(raw, RESULT_KEYS);
  if (!new Set(["PLANNING", "GENERATING"]).has(value.status)
    || !new Set(["PLANNING", "GENERATION"]).has(value.recoveryPoint)
    || (value.status === "PLANNING") !== (value.recoveryPoint === "PLANNING")
    || !Number.isInteger(value.statusVersion) || value.statusVersion < 2
    || !Number.isInteger(value.enqueued) || value.enqueued < 1 || value.enqueued > MAX_PLAN_SLOTS
    || typeof value.duplicate !== "boolean") throw retryError("AUTO_LISTING_AI_RETRY_FAILED", true);
  return Object.freeze(value);
}

function safeErrorCode(error) {
  try {
    const descriptor = error && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "code") : null;
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
  } catch {
    return null;
  }
}

export function createAutoListingAiRetryService(rawOptions = {}) {
  const { repository } = plainClosed(rawOptions, FACTORY_KEYS);
  if (!repository || typeof repository !== "object"
    || typeof repository.retryAutoListingAiItem !== "function") {
    throw retryError("AUTO_LISTING_AI_RETRY_INVALID");
  }
  return Object.freeze({
    async retry(raw) {
      const input = command(raw);
      try {
        return result(await repository.retryAutoListingAiItem(input));
      } catch (error) {
        const code = safeErrorCode(error);
        if (SAFE_CODES.has(code)) throw retryError(code);
        if (code === "AUTO_LISTING_AI_RETRY_INVALID") throw retryError(code);
        throw retryError("AUTO_LISTING_AI_RETRY_FAILED", true);
      }
    },
  });
}
