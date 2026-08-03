const LEGAL_STYLES = new Set([
  "VISUAL_FIRST",
  "PARAMETER_FIRST",
  "DEMONSTRATION_FIRST",
  "SPECIFICATION_FIRST",
  "BALANCED_DEFAULT",
]);

const RULE_MATCH_TYPES = new Set([
  "EXACT_CATEGORY",
  "ANCESTOR_CATEGORY",
  "PRODUCT_STYLE",
]);

const strategyError = () => {
  const error = new Error("AI_CONTENT_STRATEGY_INVALID");
  error.code = "AI_CONTENT_STRATEGY_INVALID";
  return error;
};

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const requiredString = (value) =>
  typeof value === "string" && value.trim() ? value : null;

const UNSAFE_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const cloneJsonSafe = (value, active = new WeakSet()) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw strategyError();
    return value;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) throw strategyError();
  if (active.has(value)) throw strategyError();

  active.add(value);
  try {
    if (Array.isArray(value)) return value.map((nested) => cloneJsonSafe(nested, active));

    const clone = {};
    for (const [key, nested] of Object.entries(value)) {
      if (UNSAFE_JSON_KEYS.has(key)) throw strategyError();
      clone[key] = cloneJsonSafe(nested, active);
    }
    return clone;
  } finally {
    active.delete(value);
  }
};

const compareStringIds = (left, right) => {
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

const compareCandidates = (left, right) =>
  left.rule.ruleOrder - right.rule.ruleOrder || compareStringIds(left.rule.ruleId, right.rule.ruleId);

const validateRule = (value) => {
  if (!isPlainObject(value)
    || !requiredString(value.ruleId)
    || !Number.isInteger(value.ruleOrder)
    || !RULE_MATCH_TYPES.has(value.matchType)
    || !LEGAL_STYLES.has(value.style)
    || !isPlainObject(value.textDensityByRole)) {
    throw strategyError();
  }
  cloneJsonSafe(value.textDensityByRole);

  if (value.matchType === "PRODUCT_STYLE") {
    if (!requiredString(value.productStyle)) throw strategyError();
  } else if (!requiredString(value.categoryId)) {
    throw strategyError();
  }

  return value;
};

const validateUniqueRuleIds = (rules) => {
  const ruleIds = new Set();
  for (const rule of rules) {
    if (ruleIds.has(rule.ruleId)) throw strategyError();
    ruleIds.add(rule.ruleId);
  }
};

const validateProduct = (value) => {
  if (!isPlainObject(value)) throw strategyError();
  if (value.descriptionCategoryId !== undefined && !requiredString(value.descriptionCategoryId)) {
    throw strategyError();
  }
  if (value.productStyle !== undefined && !requiredString(value.productStyle)) {
    throw strategyError();
  }

  const ancestors = value.categoryAncestors ?? [];
  if (!Array.isArray(ancestors)) throw strategyError();
  for (const ancestor of ancestors) {
    if (!isPlainObject(ancestor)
      || !requiredString(ancestor.categoryId)
      || !Number.isInteger(ancestor.distance)
      || ancestor.distance < 1) {
      throw strategyError();
    }
  }
  return ancestors;
};

const buildResult = ({ strategyVersion, candidate, matchedBy, targetDescriptionCategoryId, matchedValue, ancestorDistance }) => {
  const evidence = {
    targetDescriptionCategoryId: targetDescriptionCategoryId ?? null,
    matchedValue,
  };
  if (ancestorDistance !== undefined) evidence.ancestorDistance = ancestorDistance;
  if (candidate) evidence.ruleOrder = candidate.rule.ruleOrder;

  return {
    strategyId: strategyVersion.strategyId,
    strategyVersionId: strategyVersion.strategyVersionId,
    ruleId: candidate?.rule.ruleId ?? null,
    matchedBy,
    style: candidate?.rule.style ?? "BALANCED_DEFAULT",
    textDensityByRole: candidate ? cloneJsonSafe(candidate.rule.textDensityByRole) : {},
    evidence,
  };
};

export function resolveAiContentStrategy(input) {
  if (!isPlainObject(input)
    || !isPlainObject(input.strategyVersion)
    || !requiredString(input.strategyVersion.strategyId)
    || !requiredString(input.strategyVersion.strategyVersionId)
    || !Array.isArray(input.rules)) {
    throw strategyError();
  }

  const rules = input.rules.map(validateRule);
  validateUniqueRuleIds(rules);
  const ancestors = validateProduct(input.product);
  const { descriptionCategoryId: targetDescriptionCategoryId, productStyle } = input.product;

  const exactCandidates = rules
    .filter((rule) => rule.matchType === "EXACT_CATEGORY" && rule.categoryId === targetDescriptionCategoryId)
    .map((rule) => ({ rule }))
    .sort(compareCandidates);
  if (exactCandidates[0]) {
    return buildResult({
      strategyVersion: input.strategyVersion,
      candidate: exactCandidates[0],
      matchedBy: "EXACT_CATEGORY",
      targetDescriptionCategoryId,
      matchedValue: targetDescriptionCategoryId,
    });
  }

  const ancestorDistanceByCategoryId = new Map();
  for (const ancestor of ancestors) {
    const knownDistance = ancestorDistanceByCategoryId.get(ancestor.categoryId);
    if (knownDistance === undefined || ancestor.distance < knownDistance) {
      ancestorDistanceByCategoryId.set(ancestor.categoryId, ancestor.distance);
    }
  }
  const ancestorCandidates = rules
    .filter((rule) => rule.matchType === "ANCESTOR_CATEGORY" && ancestorDistanceByCategoryId.has(rule.categoryId))
    .map((rule) => ({ rule, distance: ancestorDistanceByCategoryId.get(rule.categoryId) }))
    .sort((left, right) => left.distance - right.distance || compareCandidates(left, right));
  if (ancestorCandidates[0]) {
    const candidate = ancestorCandidates[0];
    return buildResult({
      strategyVersion: input.strategyVersion,
      candidate,
      matchedBy: "ANCESTOR_CATEGORY",
      targetDescriptionCategoryId,
      matchedValue: candidate.rule.categoryId,
      ancestorDistance: candidate.distance,
    });
  }

  const styleCandidates = productStyle && productStyle !== "UNKNOWN"
    ? rules
      .filter((rule) => rule.matchType === "PRODUCT_STYLE" && rule.productStyle === productStyle)
      .map((rule) => ({ rule }))
      .sort(compareCandidates)
    : [];
  if (styleCandidates[0]) {
    return buildResult({
      strategyVersion: input.strategyVersion,
      candidate: styleCandidates[0],
      matchedBy: "PRODUCT_STYLE",
      targetDescriptionCategoryId,
      matchedValue: productStyle,
    });
  }

  return buildResult({
    strategyVersion: input.strategyVersion,
    matchedBy: "DEFAULT",
    targetDescriptionCategoryId,
    matchedValue: "BALANCED_DEFAULT",
  });
}
