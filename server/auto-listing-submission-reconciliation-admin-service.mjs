import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const INPUT_KEYS = new Set(["actor", "taskId", "reason", "idempotencyKey", "correlationId"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

function adminError(code, status = 400, retryable = false) {
  const error = new Error("自动上架对账恢复操作失败");
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function exact(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw adminError("AUTO_LISTING_RECONCILE_ADMIN_INVALID");
    const keys = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (keys.length !== INPUT_KEYS.size || keys.some((key) => typeof key !== "string" || !INPUT_KEYS.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
      throw adminError("AUTO_LISTING_RECONCILE_ADMIN_INVALID");
    }
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === "AUTO_LISTING_RECONCILE_ADMIN_INVALID") throw error;
    throw adminError("AUTO_LISTING_RECONCILE_ADMIN_INVALID");
  }
}

function identifier(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw adminError("AUTO_LISTING_RECONCILE_ADMIN_INVALID");
  return result;
}

function reason(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || Buffer.byteLength(result, "utf8") > 500) throw adminError("AUTO_LISTING_RECONCILE_ADMIN_INVALID");
  return result;
}

export function createAutoListingSubmissionReconciliationAdminService({ repository } = {}) {
  if (typeof repository?.reopenDeadTask !== "function") {
    throw new TypeError("Auto-listing reconciliation admin repository is required");
  }
  return Object.freeze({
    async reopenDeadTask(raw = {}) {
      const input = exact(raw);
      assertPermission(input.actor, PERMISSIONS.AI_CONTENT_MANAGE);
      const accountId = identifier(input.actor?.id);
      let row;
      try {
        row = await repository.reopenDeadTask({
          accountId, actorId: accountId, taskId: identifier(input.taskId), reason: reason(input.reason),
          idempotencyKey: identifier(input.idempotencyKey), correlationId: identifier(input.correlationId),
        });
      } catch (error) {
        if (typeof error?.code === "string") throw error;
        throw adminError("AUTO_LISTING_RECONCILE_ADMIN_FAILED", 503, true);
      }
      if (!row || row.accountId !== accountId || !SAFE_ID.test(row.taskId || "") || row.state !== "PENDING"
        || !Number.isSafeInteger(row.recoveryCount) || row.recoveryCount < 1
        || typeof row.duplicate !== "boolean") {
        throw adminError("AUTO_LISTING_RECONCILE_ADMIN_DATA_BOUNDARY", 500);
      }
      return Object.freeze({
        taskId: row.taskId, state: row.state, recoveryCount: row.recoveryCount, duplicate: row.duplicate,
      });
    },
  });
}
