import { types } from "node:util";

const LEGAL_STYLES = new Set([
  "VISUAL_FIRST",
  "PARAMETER_FIRST",
  "DEMONSTRATION_FIRST",
  "SPECIFICATION_FIRST",
  "BALANCED_DEFAULT",
]);
const V1_MATCH_TYPES = new Set(["EXACT_CATEGORY", "ANCESTOR_CATEGORY", "PRODUCT_STYLE"]);
const ROLE_NAMES = Object.freeze([
  "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
]);
const ROLE_SET = new Set(ROLE_NAMES);
const DENSITIES = new Set(["NONE", "LIGHT", "MEDIUM", "HEAVY"]);
const HASH = /^[a-f0-9]{64}$/u;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const COUNT_INSTRUCTION_KEYS = new Set([
  "imageCount", "imageCounts", "roleCount", "roleCounts", "slotCount", "slots",
  "requestedCounts", "requestedRoleCounts", "imagesPerVisualGroup", "count",
]);
const V2_RULE_KEYS = new Set([
  "ruleId", "ruleOrder", "matchType", "scope", "overallStyle", "prohibitedPatterns",
  "roleGuidance", "sampleSetHash", "analysisAttemptId", "analysisResultId",
  ...COUNT_INSTRUCTION_KEYS,
]);
const V2_GUIDANCE_KEYS = new Set([
  "composition", "background", "textDensity", "layout", ...COUNT_INSTRUCTION_KEYS,
]);
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_STRING = 100_000;

const strategyError = () => {
  const error = new Error("AI_CONTENT_STRATEGY_INVALID");
  error.code = "AI_CONTENT_STRATEGY_INVALID";
  return error;
};

class UnsafeCarrier extends Error {}

function cloneData(value, state, depth = 0) {
  if (state.bounded && (depth > MAX_DEPTH || state.nodes >= MAX_NODES)) throw new UnsafeCarrier();
  state.nodes += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsafeCarrier();
    return value;
  }
  if (typeof value === "string") {
    if (state.bounded && value.length > MAX_STRING) throw new UnsafeCarrier();
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value) || state.active.has(value)) {
    throw new UnsafeCarrier();
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype
        || (state.bounded && value.length > 10_000)) throw new UnsafeCarrier();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (keys.length !== allowed.size || keys.some((key) => typeof key !== "string" || !allowed.has(key))
        || descriptors.length?.value !== value.length) throw new UnsafeCarrier();
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
          throw new UnsafeCarrier();
        }
        return cloneData(descriptor.value, state, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new UnsafeCarrier();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if ((state.bounded && keys.length > 10_000)
      || keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key))) {
      throw new UnsafeCarrier();
    }
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw new UnsafeCarrier();
      output[key] = cloneData(descriptor.value, state, depth + 1);
    }
    return output;
  } catch (error) {
    if (error instanceof UnsafeCarrier) throw error;
    throw new UnsafeCarrier();
  } finally {
    state.active.delete(value);
  }
}

function hasV2Rule(value) {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return false;
  const rulesDescriptor = Object.getOwnPropertyDescriptor(value, "rules");
  const rules = rulesDescriptor && Object.hasOwn(rulesDescriptor, "value") ? rulesDescriptor.value : null;
  if (!Array.isArray(rules) || types.isProxy(rules)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(rules);
  for (let index = 0; index < rules.length; index += 1) {
    const descriptor = descriptors[String(index)];
    const rule = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
    if (!rule || typeof rule !== "object" || Array.isArray(rule) || types.isProxy(rule)) continue;
    const matchDescriptor = Object.getOwnPropertyDescriptor(rule, "matchType");
    if (matchDescriptor && Object.hasOwn(matchDescriptor, "value")
      && matchDescriptor.value === "EXACT_CATEGORY_TYPE_V2") return true;
  }
  return false;
}

function project(value) {
  try {
    return cloneData(value, { nodes: 0, active: new Set(), bounded: hasV2Rule(value) });
  } catch {
    throw strategyError();
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const requiredString = (value, max = 2_048) => typeof value === "string" && value.trim()
  && value === value.trim() && value.length <= max ? value : null;
const legacyString = (value) => typeof value === "string" && value.trim() ? value : null;
const exactKeys = (value, expected) => isPlainObject(value)
  && Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
const compareStringIds = (left, right) => left === right ? 0 : left < right ? -1 : 1;
const compareCandidates = (left, right) => left.rule.ruleOrder - right.rule.ruleOrder
  || compareStringIds(left.rule.ruleId, right.rule.ruleId);

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((nested) => deepFreeze(nested, seen));
  return Object.freeze(value);
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw strategyError();
  return value;
}

function validateV1Rule(value) {
  if (!legacyString(value.ruleId)
    || !Number.isInteger(value.ruleOrder) || value.ruleOrder <= 0
    || !V1_MATCH_TYPES.has(value.matchType)
    || !LEGAL_STYLES.has(value.style)
    || !isPlainObject(value.textDensityByRole)) throw strategyError();
  if (value.matchType === "PRODUCT_STYLE") {
    if (!legacyString(value.productStyle)) throw strategyError();
  } else if (!legacyString(value.categoryId)) throw strategyError();
  return value;
}

const SAFE_GUIDANCE = Object.freeze(Object.fromEntries(ROLE_NAMES.map((role) => [role, Object.freeze({
  composition: "keep the complete product clearly visible",
  background: "use a neutral background that does not obscure the product",
  textDensity: role === "MAIN" ? "NONE" : "LIGHT",
  layout: "use a simple stable hierarchy",
})])));

function projectGuidance(value, diagnostics) {
  if (!isPlainObject(value)) throw strategyError();
  const roleGuidance = {};
  for (const [role, rawGuidance] of Object.entries(value)) {
    if (!ROLE_SET.has(role)) {
      diagnostics.add("CATEGORY_STRATEGY_EXTRA_ROLE_GUIDANCE_IGNORED");
      continue;
    }
    if (!isPlainObject(rawGuidance)
      || Object.keys(rawGuidance).some((key) => !V2_GUIDANCE_KEYS.has(key))) throw strategyError();
    if (Object.keys(rawGuidance).some((key) => COUNT_INSTRUCTION_KEYS.has(key))) {
      diagnostics.add("CATEGORY_STRATEGY_COUNT_INSTRUCTION_IGNORED");
    }
    const guidance = {
      composition: requiredString(rawGuidance.composition, 1_000),
      background: requiredString(rawGuidance.background, 1_000),
      textDensity: requiredString(rawGuidance.textDensity, 20),
      layout: requiredString(rawGuidance.layout, 1_000),
    };
    if (!guidance.composition || !guidance.background || !DENSITIES.has(guidance.textDensity)
      || !guidance.layout) throw strategyError();
    roleGuidance[role] = guidance;
  }
  for (const role of ROLE_NAMES) if (!roleGuidance[role]) {
    roleGuidance[role] = { ...SAFE_GUIDANCE[role] };
    diagnostics.add("CATEGORY_STRATEGY_ROLE_GUIDANCE_FALLBACK");
  }
  return Object.fromEntries(ROLE_NAMES.map((role) => [role, roleGuidance[role]]));
}

function validateV2Rule(value) {
  if (Object.keys(value).some((key) => !V2_RULE_KEYS.has(key))
    || !requiredString(value.ruleId) || !Number.isInteger(value.ruleOrder) || value.ruleOrder <= 0
    || value.matchType !== "EXACT_CATEGORY_TYPE_V2"
    || !exactKeys(value.scope, new Set(["taxonomyScope", "descriptionCategoryId", "typeId"]))
    || value.scope.taxonomyScope !== "OZON:DEFAULT"
    || !requiredString(value.overallStyle, 1_000)
    || !Array.isArray(value.prohibitedPatterns) || value.prohibitedPatterns.length > 20
    || value.prohibitedPatterns.some((entry) => !requiredString(entry, 1_000))
    || !HASH.test(value.sampleSetHash || "")
    || !requiredString(value.analysisAttemptId) || !requiredString(value.analysisResultId)) throw strategyError();
  positiveInteger(value.scope.descriptionCategoryId);
  positiveInteger(value.scope.typeId);
  const diagnostics = new Set();
  if (Object.keys(value).some((key) => COUNT_INSTRUCTION_KEYS.has(key))) {
    diagnostics.add("CATEGORY_STRATEGY_COUNT_INSTRUCTION_IGNORED");
  }
  return {
    ...value,
    roleGuidance: projectGuidance(value.roleGuidance, diagnostics),
    diagnostics: [...diagnostics].sort(),
  };
}

function validateRule(value) {
  if (!isPlainObject(value)) throw strategyError();
  return value.matchType === "EXACT_CATEGORY_TYPE_V2" ? validateV2Rule(value) : validateV1Rule(value);
}

function validateUniqueRuleIds(rules) {
  const ruleIds = new Set();
  for (const rule of rules) {
    if (ruleIds.has(rule.ruleId)) throw strategyError();
    ruleIds.add(rule.ruleId);
  }
}

function validateProduct(value, requiresV2Scope) {
  if (!isPlainObject(value)) throw strategyError();
  if (value.descriptionCategoryId !== undefined
    && !(requiresV2Scope ? requiredString(value.descriptionCategoryId) : legacyString(value.descriptionCategoryId))) {
    throw strategyError();
  }
  if (requiresV2Scope && (!requiredString(value.typeId) || !requiredString(value.taxonomyScope, 80))) {
    throw strategyError();
  }
  if (value.productStyle !== undefined && !legacyString(value.productStyle)) throw strategyError();
  const ancestors = value.categoryAncestors ?? [];
  if (!Array.isArray(ancestors)) throw strategyError();
  for (const ancestor of ancestors) {
    if (!isPlainObject(ancestor) || !legacyString(ancestor.categoryId)
      || !Number.isInteger(ancestor.distance) || ancestor.distance < 1) throw strategyError();
  }
  return ancestors;
}

function buildV1Result({ strategyVersion, candidate, matchedBy, targetDescriptionCategoryId, matchedValue, ancestorDistance }) {
  const evidence = { targetDescriptionCategoryId: targetDescriptionCategoryId ?? null, matchedValue };
  if (ancestorDistance !== undefined) evidence.ancestorDistance = ancestorDistance;
  if (candidate) evidence.ruleOrder = candidate.rule.ruleOrder;
  return {
    strategyId: strategyVersion.strategyId,
    strategyVersionId: strategyVersion.strategyVersionId,
    ruleId: candidate?.rule.ruleId ?? null,
    matchedBy,
    style: candidate?.rule.style ?? "BALANCED_DEFAULT",
    textDensityByRole: candidate ? structuredClone(candidate.rule.textDensityByRole) : {},
    evidence,
  };
}

function buildV2Result(strategyVersion, rule, product) {
  const textDensityByRole = Object.fromEntries(ROLE_NAMES.map((role) => [role, rule.roleGuidance[role].textDensity]));
  return deepFreeze({
    strategyId: strategyVersion.strategyId,
    strategyVersionId: strategyVersion.strategyVersionId,
    ruleId: rule.ruleId,
    matchedBy: "EXACT_CATEGORY_TYPE_V2",
    style: "BALANCED_DEFAULT",
    textDensityByRole,
    evidence: {
      targetTaxonomyScope: product.taxonomyScope,
      targetDescriptionCategoryId: product.descriptionCategoryId,
      targetTypeId: product.typeId,
      ruleOrder: rule.ruleOrder,
    },
    scope: { ...rule.scope },
    overallStyle: rule.overallStyle,
    prohibitedPatterns: [...rule.prohibitedPatterns],
    roleGuidance: structuredClone(rule.roleGuidance),
    sampleSetHash: rule.sampleSetHash,
    analysisAttemptId: rule.analysisAttemptId,
    analysisResultId: rule.analysisResultId,
    diagnostics: [...rule.diagnostics],
  });
}

export function resolveAiContentStrategy(rawInput) {
  const input = project(rawInput);
  if (!isPlainObject(input) || !isPlainObject(input.strategyVersion) || !Array.isArray(input.rules)) {
    throw strategyError();
  }
  const rules = input.rules.map(validateRule);
  const hasV2 = rules.some((candidate) => candidate.matchType === "EXACT_CATEGORY_TYPE_V2");
  const versionString = hasV2 ? requiredString : legacyString;
  if (!versionString(input.strategyVersion.strategyId)
    || !versionString(input.strategyVersion.strategyVersionId)) throw strategyError();
  validateUniqueRuleIds(rules);
  const ancestors = validateProduct(input.product, hasV2);
  const product = input.product;
  const targetDescriptionCategoryId = product.descriptionCategoryId;

  const v2Candidates = rules.filter((rule) => rule.matchType === "EXACT_CATEGORY_TYPE_V2"
    && product.taxonomyScope === rule.scope.taxonomyScope
    && String(rule.scope.descriptionCategoryId) === targetDescriptionCategoryId
    && String(rule.scope.typeId) === product.typeId).map((rule) => ({ rule })).sort(compareCandidates);
  if (v2Candidates[0]) return buildV2Result(input.strategyVersion, v2Candidates[0].rule, product);

  const exactCandidates = rules.filter((rule) => rule.matchType === "EXACT_CATEGORY"
    && rule.categoryId === targetDescriptionCategoryId).map((rule) => ({ rule })).sort(compareCandidates);
  if (exactCandidates[0]) return buildV1Result({ strategyVersion: input.strategyVersion,
    candidate: exactCandidates[0], matchedBy: "EXACT_CATEGORY", targetDescriptionCategoryId,
    matchedValue: targetDescriptionCategoryId });

  const ancestorDistanceByCategoryId = new Map();
  for (const ancestor of ancestors) {
    const known = ancestorDistanceByCategoryId.get(ancestor.categoryId);
    if (known === undefined || ancestor.distance < known) ancestorDistanceByCategoryId.set(ancestor.categoryId, ancestor.distance);
  }
  const ancestorCandidates = rules.filter((rule) => rule.matchType === "ANCESTOR_CATEGORY"
    && ancestorDistanceByCategoryId.has(rule.categoryId))
    .map((rule) => ({ rule, distance: ancestorDistanceByCategoryId.get(rule.categoryId) }))
    .sort((left, right) => left.distance - right.distance || compareCandidates(left, right));
  if (ancestorCandidates[0]) {
    const candidate = ancestorCandidates[0];
    return buildV1Result({ strategyVersion: input.strategyVersion, candidate, matchedBy: "ANCESTOR_CATEGORY",
      targetDescriptionCategoryId, matchedValue: candidate.rule.categoryId, ancestorDistance: candidate.distance });
  }
  const productStyle = product.productStyle;
  const styleCandidates = productStyle && productStyle !== "UNKNOWN"
    ? rules.filter((rule) => rule.matchType === "PRODUCT_STYLE" && rule.productStyle === productStyle)
      .map((rule) => ({ rule })).sort(compareCandidates) : [];
  if (styleCandidates[0]) return buildV1Result({ strategyVersion: input.strategyVersion,
    candidate: styleCandidates[0], matchedBy: "PRODUCT_STYLE", targetDescriptionCategoryId,
    matchedValue: productStyle });
  return buildV1Result({ strategyVersion: input.strategyVersion, matchedBy: "DEFAULT",
    targetDescriptionCategoryId, matchedValue: "BALANCED_DEFAULT" });
}
