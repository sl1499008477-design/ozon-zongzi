import { types } from "node:util";
import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const REQUEST_KEYS = new Set(["actor", "jobId", "itemId"]);
const ACTOR_KEYS = new Set(["id", "role"]);
const DETAIL_KEYS = new Set([
  "responseId", "attemptId", "diagnosticRunId", "planningContract", "model",
  "promptTemplateVersion", "gatewayRequestId", "receivedAt", "response", "validation",
]);
const VALIDATION_KEYS = new Set(["status", "validatorVersion", "issues", "validatedAt"]);
const ISSUE_KEYS = new Set(["code", "slotKey", "claimIndex", "field", "expected", "actual"]);
const LEGACY_RESPONSE_KEYS = new Set(["version", "language", "slots"]);
const FIXED_RESPONSE_KEYS = new Set(["version", "language", "fills"]);
const CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,239}$/u;
const SECRET_VALUE = /^(?:sk-(?:proj-)?[a-z0-9_-]{8,}|AKIA[A-Z0-9]{16}|AIza[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{8,}|Bearer\s+\S+)$/iu;
const FORBIDDEN_KEYS = /^(?:api[_-]?key|gateway[_-]?key|prompt|systemPrompt|cause|rawError|authorization|cookie|credential|password|secret|accessToken|refreshToken)$/iu;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 64;
const MAX_NODES = 200_000;
const MAX_STRING = 2_000_000;

class UnsafeData extends Error {}

function diagnosticError(code, status) {
  const messages = {
    AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID: "规划诊断请求无效",
    AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_FOUND: "未找到该商品的规划诊断",
    AUTO_LISTING_PLAN_DIAGNOSTIC_FAILED: "规划诊断暂时无法读取",
  };
  const error = new Error(messages[code] || messages.AUTO_LISTING_PLAN_DIAGNOSTIC_FAILED);
  error.code = code;
  error.status = status;
  error.retryable = status >= 500;
  return error;
}

const invalid = () => diagnosticError("AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID", 400);
const notFound = () => diagnosticError("AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_FOUND", 404);
const failed = () => diagnosticError("AUTO_LISTING_PLAN_DIAGNOSTIC_FAILED", 500);

function cloneData(value, state, depth = 0) {
  if (depth > MAX_DEPTH || state.nodes >= MAX_NODES) throw new UnsafeData();
  state.nodes += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsafeData();
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING || SECRET_VALUE.test(value)) throw new UnsafeData();
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value) || state.active.has(value)) throw new UnsafeData();
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 20_000) throw new UnsafeData();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (keys.length !== allowed.size || keys.some((key) => typeof key !== "string" || !allowed.has(key))
        || descriptors.length?.value !== value.length) throw new UnsafeData();
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw new UnsafeData();
        return cloneData(descriptor.value, state, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new UnsafeData();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 10_000 || keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key)
      || FORBIDDEN_KEYS.test(key))) throw new UnsafeData();
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw new UnsafeData();
      output[key] = cloneData(descriptor.value, state, depth + 1);
    }
    return output;
  } catch (error) {
    if (error instanceof UnsafeData) throw error;
    throw new UnsafeData();
  } finally {
    state.active.delete(value);
  }
}

function project(value) {
  return cloneData(value, { nodes: 0, active: new Set() });
}

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
}

function safeId(value) {
  return typeof value === "string" && value === value.trim() && SAFE_ID.test(value);
}

function safeText(value, max = 240) {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= max && !/[\u0000-\u001f\u007f]/u.test(value)
    && !SECRET_VALUE.test(value);
}

function canonicalTime(value) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}

function projectRequest(raw) {
  let input;
  try { input = project(raw); } catch { throw invalid(); }
  if (!exact(input, REQUEST_KEYS) || !exact(input.actor, ACTOR_KEYS)
    || !safeId(input.actor.id) || !["admin", "user"].includes(input.actor.role)
    || !safeId(input.jobId) || !safeId(input.itemId)) throw invalid();
  return input;
}

function projectIssue(issue) {
  if (!exact(issue, ISSUE_KEYS) || !CODE.test(issue.code || "")
    || !(issue.slotKey === null || safeText(issue.slotKey, 500))
    || !(issue.claimIndex === null || (Number.isSafeInteger(issue.claimIndex) && issue.claimIndex >= 0))
    || !(issue.field === null || safeText(issue.field, 240))
    || ![issue.expected, issue.actual].every((value) => value === null || safeText(value, 160))) throw new UnsafeData();
}

function projectDetail(raw) {
  let value;
  try { value = project(raw); } catch { throw failed(); }
  try {
    if (!exact(value, DETAIL_KEYS) || !safeId(value.responseId)
      || !((safeId(value.attemptId) && value.diagnosticRunId === null)
        || (value.attemptId === null && safeId(value.diagnosticRunId)))
      || !["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1"].includes(value.planningContract)
      || !safeText(value.model) || !safeText(value.promptTemplateVersion)
      || !(value.gatewayRequestId === null || safeText(value.gatewayRequestId))
      || !canonicalTime(value.receivedAt)
      || !exact(value.validation, VALIDATION_KEYS)
      || !["ACCEPTED", "REJECTED"].includes(value.validation.status)
      || !safeText(value.validation.validatorVersion)
      || !Array.isArray(value.validation.issues) || value.validation.issues.length > 100
      || !canonicalTime(value.validation.validatedAt)) throw new UnsafeData();
    const rootKeys = value.planningContract === "FIXED_SKELETON_V1" ? FIXED_RESPONSE_KEYS : LEGACY_RESPONSE_KEYS;
    if (!exact(value.response, rootKeys) || value.response.version !== 1 || value.response.language !== "ru"
      || (value.planningContract === "FIXED_SKELETON_V1" ? !value.response.fills || Array.isArray(value.response.fills)
        : !Array.isArray(value.response.slots))) throw new UnsafeData();
    value.validation.issues.forEach(projectIssue);
    if ((value.validation.status === "ACCEPTED" && value.validation.issues.length !== 0)
      || (value.validation.status === "REJECTED" && value.validation.issues.length < 1)) throw new UnsafeData();
    return deepFreeze(value);
  } catch {
    throw failed();
  }
}

export function createAutoListingPlanDiagnosticService({ repository } = {}) {
  if (typeof repository?.loadLatest !== "function") {
    throw new TypeError("Auto-listing plan diagnostic repository is required");
  }
  return Object.freeze({
    async getLatest(raw) {
      const input = projectRequest(raw);
      assertPermission(input.actor, PERMISSIONS.AI_CONTENT_MANAGE);
      let record;
      try {
        record = await repository.loadLatest({
          accountId: input.actor.id,
          jobId: input.jobId,
          itemId: input.itemId,
        });
      } catch {
        throw failed();
      }
      if (record === null) throw notFound();
      return projectDetail(record);
    },
  });
}
