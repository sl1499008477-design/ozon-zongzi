const DETAIL_KEYS = Object.freeze([
  "responseId", "attemptId", "diagnosticRunId", "planningContract", "model",
  "promptTemplateVersion", "gatewayRequestId", "receivedAt", "response", "validation",
]);
const VALIDATION_KEYS = Object.freeze(["status", "validatorVersion", "issues", "validatedAt"]);
const ISSUE_KEYS = Object.freeze(["code", "slotKey", "claimIndex", "field", "expected", "actual"]);
const LEGACY_RESPONSE_KEYS = Object.freeze(["version", "language", "slots"]);
const FIXED_RESPONSE_KEYS = Object.freeze(["version", "language", "fills"]);
const CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,239}$/u;
const SECRET_VALUE = /^(?:sk-(?:proj-)?[a-z0-9_-]{8,}|AKIA[A-Z0-9]{16}|AIza[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{8,}|Bearer\s+\S+)$/iu;
const FORBIDDEN_KEYS = /^(?:api[_-]?key|gateway[_-]?key|prompt|systemPrompt|cause|rawError|authorization|cookie|credential|password|secret|accessToken|refreshToken)$/iu;

const runtimeIsProxy = (() => {
  try {
    const candidate = globalThis.process?.getBuiltinModule?.("node:util")?.types?.isProxy;
    return typeof candidate === "function" ? candidate : () => false;
  } catch {
    return () => false;
  }
})();

class UnsafeData extends Error {}

function cloneData(value, state, depth = 0) {
  if (depth > 64 || state.nodes >= 200_000) throw new UnsafeData();
  state.nodes += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsafeData();
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 2_000_000 || SECRET_VALUE.test(value)) throw new UnsafeData();
    return value;
  }
  if (!value || typeof value !== "object" || runtimeIsProxy(value) || state.active.has(value)) throw new UnsafeData();
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
        if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) throw new UnsafeData();
        return cloneData(descriptor.value, state, depth + 1);
      });
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new UnsafeData();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 10_000 || keys.some((key) => typeof key !== "string" || FORBIDDEN_KEYS.test(key)
      || ["__proto__", "constructor", "prototype"].includes(key))) throw new UnsafeData();
    const output = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) throw new UnsafeData();
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

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

const safeId = (value) => typeof value === "string" && value === value.trim() && SAFE_ID.test(value);
const safeText = (value, max = 240) => typeof value === "string" && value.length > 0
  && value === value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
  && !SECRET_VALUE.test(value);
const canonicalTime = (value) => {
  try { return typeof value === "string" && new Date(value).toISOString() === value; } catch { return false; }
};

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}

function validIssue(issue) {
  return exact(issue, ISSUE_KEYS) && CODE.test(issue.code || "")
    && (issue.slotKey === null || safeText(issue.slotKey, 500))
    && (issue.claimIndex === null || (Number.isSafeInteger(issue.claimIndex) && issue.claimIndex >= 0))
    && (issue.field === null || safeText(issue.field, 240))
    && [issue.expected, issue.actual].every((value) => value === null || safeText(value, 160));
}

export function autoListingPlanDiagnosticDetail(raw) {
  try {
    const value = cloneData(raw, { nodes: 0, active: new Set() });
    if (!exact(value, DETAIL_KEYS) || !safeId(value.responseId)
      || !((safeId(value.attemptId) && value.diagnosticRunId === null)
        || (value.attemptId === null && safeId(value.diagnosticRunId)))
      || !["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1"].includes(value.planningContract)
      || !safeText(value.model) || !safeText(value.promptTemplateVersion)
      || !(value.gatewayRequestId === null || safeText(value.gatewayRequestId))
      || !canonicalTime(value.receivedAt) || !exact(value.validation, VALIDATION_KEYS)
      || !["ACCEPTED", "REJECTED"].includes(value.validation.status)
      || !safeText(value.validation.validatorVersion) || !Array.isArray(value.validation.issues)
      || value.validation.issues.length > 100 || value.validation.issues.some((issue) => !validIssue(issue))
      || !canonicalTime(value.validation.validatedAt)) return null;
    const responseKeys = value.planningContract === "FIXED_SKELETON_V1"
      ? FIXED_RESPONSE_KEYS : LEGACY_RESPONSE_KEYS;
    if (!exact(value.response, responseKeys) || value.response.version !== 1 || value.response.language !== "ru"
      || (value.planningContract === "FIXED_SKELETON_V1"
        ? !value.response.fills || Array.isArray(value.response.fills) : !Array.isArray(value.response.slots))
      || (value.validation.status === "ACCEPTED" && value.validation.issues.length !== 0)
      || (value.validation.status === "REJECTED" && value.validation.issues.length < 1)) return null;
    const { promptTemplateVersion, ...safeValue } = value;
    return deepFreeze({ ...safeValue, templateVersion: promptTemplateVersion });
  } catch {
    return null;
  }
}
