import { isSafeAutoListingAiIdentifier } from "./auto-listing-ai-message.mjs";
import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const INPUT_KEYS = new Set([
  "actor", "jobId", "itemId", "expectedStatusVersion", "idempotencyKey", "correlationId",
]);
const REVIEW_KEYS = new Set(["actor", "itemId"]);

function itemError(code = "AUTO_LISTING_USER_ACTION_INVALID") {
  const error = new Error("自动上架商品操作失败");
  error.code = code;
  error.status = code.endsWith("INVALID") ? 400 : 422;
  return error;
}

function command(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw itemError();
    const keys = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (keys.length !== INPUT_KEYS.size || keys.some((key) => typeof key !== "string"
      || !INPUT_KEYS.has(key) || descriptors[key]?.enumerable !== true
      || !Object.hasOwn(descriptors[key], "value"))) throw itemError();
    const input = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
    assertPermission(input.actor, PERMISSIONS.TENANT_OPERATE);
    const accountId = input.actor?.id;
    if (![accountId, input.jobId, input.itemId, input.idempotencyKey, input.correlationId]
      .every(isSafeAutoListingAiIdentifier)
      || !Number.isInteger(input.expectedStatusVersion) || input.expectedStatusVersion < 1
      || input.expectedStatusVersion >= 2_147_483_647) throw itemError();
    return Object.freeze({
      accountId, actorAccountId: accountId, jobId: input.jobId, itemId: input.itemId,
      expectedStatusVersion: input.expectedStatusVersion, idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
    });
  } catch (error) {
    if (error?.code === "PERMISSION_FORBIDDEN" || error?.code === "AUTO_LISTING_USER_ACTION_INVALID") throw error;
    throw itemError();
  }
}

function publicResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.status !== "string" || !Number.isInteger(value.statusVersion)
    || value.statusVersion < 1 || typeof value.duplicate !== "boolean") {
    throw itemError("AUTO_LISTING_USER_ACTION_FAILED");
  }
  return Object.freeze({
    status: value.status,
    statusVersion: value.statusVersion,
    duplicate: value.duplicate,
  });
}

function reviewInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype
    || Reflect.ownKeys(raw).length !== REVIEW_KEYS.size
    || Reflect.ownKeys(raw).some((key) => typeof key !== "string" || !REVIEW_KEYS.has(key))
    || !isSafeAutoListingAiIdentifier(raw.itemId)) throw itemError();
  return Object.freeze({ actor: raw.actor, itemId: raw.itemId });
}

export function createAutoListingItemService({ actionRepository, retryService, reviewService } = {}) {
  if (typeof actionRepository?.cancelItem !== "function"
    || typeof actionRepository?.regenerateItem !== "function"
    || typeof actionRepository?.approveItem !== "function"
    || typeof retryService?.retry !== "function"
    || typeof reviewService?.getReview !== "function") {
    throw new TypeError("Auto-listing item service dependencies are required");
  }
  return Object.freeze({
    async cancelItem(raw = {}) {
      return publicResult(await actionRepository.cancelItem(command(raw)));
    },
    async regenerateItem(raw = {}) {
      return publicResult(await actionRepository.regenerateItem(command(raw)));
    },
    async approveItem(raw = {}) {
      return publicResult(await actionRepository.approveItem(command(raw)));
    },
    async retryItem(raw = {}) {
      const value = command(raw);
      return publicResult(await retryService.retry({
        accountId: value.accountId, jobId: value.jobId, itemId: value.itemId,
        expectedStatusVersion: value.expectedStatusVersion, idempotencyKey: value.idempotencyKey,
      }));
    },
    async getReview(raw = {}) {
      return reviewService.getReview(reviewInput(raw));
    },
  });
}
