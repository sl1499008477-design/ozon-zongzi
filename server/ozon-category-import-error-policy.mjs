import { types } from "node:util";

const EVIDENCE_SCHEMA = "OZON_IMPORT_ERROR_EVIDENCE_V1";
const MAX_STRING_LENGTH = 2_000_000;
const MAX_ARRAY_LENGTH = 5_000;
const MAX_DEPTH = 64;
const MAX_NODES = 200_000;
const SUCCEEDED_STATES = new Set(["imported", "success", "processed", "done", "complete", "completed", "finished"]);
const CHECKING_STATES = new Set(["pending", "processing", "created", "queued", "running", "importing", "checking", "in_progress"]);
const TERMINAL_FAILURE_STATES = new Set(["failed", "error", "rejected", "cancelled", "canceled", "validation_error"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const POLICY_VERSION = 1;
const POLICY_RULES = Object.freeze([]);

function frozenResult(classification, errorEvidence = null) {
  return Object.freeze({ classification, errorEvidence });
}

const UNKNOWN = frozenResult("UNKNOWN_RESULT");

function descriptors(value) {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function prototypeOf(value) {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    return undefined;
  }
}

function cloneJsonData(value, state, depth = 0) {
  if (depth > MAX_DEPTH || state.nodes >= MAX_NODES) return undefined;
  state.nodes += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    state.characters += value.length;
    return value.length <= MAX_STRING_LENGTH && state.characters <= MAX_STRING_LENGTH ? value : undefined;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object") return undefined;
  try {
    if (types.isProxy(value)) return undefined;
  } catch {
    return undefined;
  }
  if (state.seen.has(value)) return undefined;
  state.seen.add(value);
  try {
    let isArray;
    try {
      isArray = Array.isArray(value);
    } catch {
      return undefined;
    }
    const prototype = prototypeOf(value);
    if (prototype === undefined) return undefined;
    const own = descriptors(value);
    if (!own || Reflect.ownKeys(own).some((key) => typeof key === "symbol")) return undefined;
    if (isArray) {
      if (prototype !== Array.prototype || !Number.isSafeInteger(value.length) || value.length > MAX_ARRAY_LENGTH) return undefined;
      const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (Reflect.ownKeys(own).some((key) => !allowed.has(key))) return undefined;
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = own[String(index)];
        if (!descriptor || !("value" in descriptor)) return undefined;
        const cloned = cloneJsonData(descriptor.value, state, depth + 1);
        if (cloned === undefined) return undefined;
        output.push(cloned);
      }
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const output = Object.create(null);
    for (const key of Reflect.ownKeys(own)) {
      if (typeof key !== "string" || key.length > 1_000 || DANGEROUS_KEYS.has(key)) return undefined;
      state.characters += key.length;
      if (state.characters > MAX_STRING_LENGTH) return undefined;
      const descriptor = own[key];
      if (!("value" in descriptor)) return undefined;
      const cloned = cloneJsonData(descriptor.value, state, depth + 1);
      if (cloned === undefined) return undefined;
      output[key] = cloned;
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

export function projectOzonImportCarrier(value) {
  return cloneJsonData(value, { nodes: 0, characters: 0, seen: new Set() });
}

function stringField(object, key, { required = false, max = 1_000 } = {}) {
  if (!Object.hasOwn(object, key)) return required ? undefined : null;
  const value = object[key];
  if (typeof value !== "string" || value.length > max || (required && value.length === 0)) return undefined;
  return value;
}

function exactPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizedProductId(item) {
  if (!Object.hasOwn(item, "product_id") || item.product_id === null || item.product_id === "" || item.product_id === 0 || item.product_id === "0") return null;
  if (Number.isSafeInteger(item.product_id) && item.product_id > 0) return String(item.product_id);
  if (typeof item.product_id === "string" && /^[1-9][0-9]{0,239}$/u.test(item.product_id)) return item.product_id;
  return undefined;
}

function normalizedState(item) {
  const state = stringField(item, "status", { required: true, max: 80 });
  return state === undefined ? undefined : state.toLowerCase();
}

function normalizedErrors(item) {
  if (!Object.hasOwn(item, "errors")) return [];
  if (!Array.isArray(item.errors)) return undefined;
  const output = [];
  for (const error of item.errors) {
    if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
    const code = stringField(error, "code", { required: true });
    const field = stringField(error, "field", { required: true });
    if (code === undefined || field === undefined) return undefined;
    let attributeId = null;
    if (Object.hasOwn(error, "attribute_id")) {
      attributeId = exactPositiveInteger(error.attribute_id);
      if (attributeId === null) return undefined;
    }
    output.push({ code, field, attributeId });
  }
  return output;
}

function classifyWithRules(policyVersion, rules, rawInput) {
  const input = projectOzonImportCarrier(rawInput);
  if (!input || Array.isArray(input)) return UNKNOWN;
  const item = input.item;
  const expectedOfferId = input.expectedOfferId;
  if (!item || Array.isArray(item) || typeof expectedOfferId !== "string" || expectedOfferId.length === 0 || expectedOfferId.length > 240) return UNKNOWN;
  if (Object.keys(input).some((key) => !["item", "expectedOfferId", "batchHasPartialOutcome"].includes(key))) return UNKNOWN;
  if (Object.hasOwn(input, "batchHasPartialOutcome") && typeof input.batchHasPartialOutcome !== "boolean") return UNKNOWN;
  const offerId = stringField(item, "offer_id", { required: true, max: 240 });
  const state = normalizedState(item);
  const productId = normalizedProductId(item);
  const errors = normalizedErrors(item);
  if (offerId === undefined || offerId !== expectedOfferId || state === undefined || productId === undefined || errors === undefined) return UNKNOWN;
  if (SUCCEEDED_STATES.has(state)) return frozenResult("SUCCEEDED");
  if (CHECKING_STATES.has(state)) return frozenResult("CHECKING");
  if (state === "skipped") return frozenResult("OTHER_TERMINAL_FAILURE");
  if (!TERMINAL_FAILURE_STATES.has(state)) return UNKNOWN;
  if (state !== "failed") return frozenResult("OTHER_TERMINAL_FAILURE");
  if (input.batchHasPartialOutcome || productId !== null) return frozenResult("OTHER_TERMINAL_FAILURE");
  const matched = errors.find((error) => rules.some((rule) => rule.code === error.code
    && rule.field === error.field && rule.attributeId === error.attributeId));
  if (!matched) return frozenResult("OTHER_TERMINAL_FAILURE");
  const errorEvidence = Object.freeze({
    schemaVersion: EVIDENCE_SCHEMA,
    policyVersion,
    code: matched.code,
    field: matched.field,
    attributeId: matched.attributeId,
    state: "FAILED",
    offerId,
    productId: null,
    classification: "EXPLICIT_CATEGORY_FAILURE",
  });
  return frozenResult("EXPLICIT_CATEGORY_FAILURE", errorEvidence);
}

export function classifyOzonCategoryImportResult(input) {
  return classifyWithRules(POLICY_VERSION, POLICY_RULES, input);
}

export function projectProductionOzonImportErrorEvidence(value) {
  const projected = projectOzonImportCarrier(value);
  if (!projected || Array.isArray(projected)) return null;
  const exactKeys = ["schemaVersion", "policyVersion", "code", "field", "attributeId", "state", "offerId", "productId", "classification"];
  if (Object.keys(projected).length !== exactKeys.length || exactKeys.some((key) => !Object.hasOwn(projected, key))) return null;
  if (projected.schemaVersion !== EVIDENCE_SCHEMA || projected.policyVersion !== POLICY_VERSION
      || projected.state !== "FAILED" || projected.productId !== null
      || projected.classification !== "EXPLICIT_CATEGORY_FAILURE") return null;
  const rule = POLICY_RULES.find((candidate) => candidate.code === projected.code
    && candidate.field === projected.field && candidate.attributeId === projected.attributeId);
  if (!rule || typeof projected.offerId !== "string" || projected.offerId.length === 0 || projected.offerId.length > 240) return null;
  return Object.freeze({ ...projected });
}
