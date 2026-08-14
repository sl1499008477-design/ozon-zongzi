import { types } from "node:util";

export const CATEGORY_STRATEGY_DRAFT_STATES = Object.freeze([
  "COLLECTING", "SAMPLES_READY", "ANALYZING", "DRAFT_READY", "PUBLISHED", "NEEDS_REVIEW",
]);

const CONTRACT_CODE = "AUTO_LISTING_CATEGORY_STRATEGY_CONTRACT_INVALID";
const SAMPLE_COUNT_CODE = "AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_COUNT_INVALID";
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ROLE_NAMES = Object.freeze([
  "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
]);
const TEXT_DENSITIES = new Set(["NONE", "LIGHT", "MEDIUM", "HEAVY"]);
const MAX_DEPTH = 64;
const MAX_NODES = 10_000;
const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_LENGTH = 100;

function failure(code = CONTRACT_CODE) {
  return Object.assign(new Error(code), { code });
}

function clone(value, state, depth = 0) {
  if (depth > MAX_DEPTH || state.nodes >= MAX_NODES) throw failure();
  state.nodes += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw failure();
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) throw failure();
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value) || state.active.has(value)) throw failure();
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_ARRAY_LENGTH) throw failure();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string") || keys.length !== value.length + 1
        || !Object.hasOwn(descriptors, "length") || descriptors.length.value !== value.length) throw failure();
      const projected = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.get || descriptor.set
          || descriptor.enumerable !== true) throw failure();
        projected.push(clone(descriptor.value, state, depth + 1));
      }
      return projected;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) throw failure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_ARRAY_LENGTH || keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key))) throw failure();
    const projected = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, "value") || descriptor.get || descriptor.set || descriptor.enumerable !== true) throw failure();
      projected[key] = clone(descriptor.value, state, depth + 1);
    }
    return projected;
  } catch (caught) {
    if (caught?.code === CONTRACT_CODE) throw caught;
    throw failure();
  } finally {
    state.active.delete(value);
  }
}

function safelyProject(value) {
  try {
    return clone(value, { nodes: 0, active: new WeakSet() });
  } catch {
    throw failure();
  }
}

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requiredText(value, maximum = 240) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) throw failure();
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw failure();
  return value;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) freeze(entry);
  return Object.freeze(value);
}

export function projectCategoryStrategyScope(input) {
  const value = safelyProject(input);
  const keys = ["accountId", "taxonomyScope", "descriptionCategoryId", "typeId"];
  if (!exact(value, keys)) throw failure();
  const scope = {
    accountId: requiredText(value.accountId),
    taxonomyScope: requiredText(value.taxonomyScope, 80),
    descriptionCategoryId: positiveInteger(value.descriptionCategoryId),
    typeId: positiveInteger(value.typeId),
  };
  if (scope.taxonomyScope !== "OZON:DEFAULT") throw failure();
  return freeze(scope);
}

export function validateCategoryStrategySamples(input) {
  const samples = safelyProject(input);
  if (!Array.isArray(samples)) throw failure();
  if (samples.length < 5 || samples.length > 20) throw failure(SAMPLE_COUNT_CODE);
  const skuSet = new Set();
  const projected = samples.map((sample) => {
    if (!exact(sample, ["sku", "images"]) || !Array.isArray(sample.images)
      || sample.images.length < 1 || sample.images.length > 6) throw failure();
    const sku = requiredText(sample.sku);
    if (skuSet.has(sku)) throw failure();
    skuSet.add(sku);
    const imageIds = new Set();
    const images = sample.images.map((image) => {
      if (!exact(image, ["imageId"])) throw failure();
      const imageId = requiredText(image.imageId);
      if (imageIds.has(imageId)) throw failure();
      imageIds.add(imageId);
      return { imageId };
    });
    return { sku, images };
  });
  return freeze(projected);
}

export function projectCategoryStrategyGuidanceV2(input) {
  const value = safelyProject(input);
  if (!exact(value, ["overallStyle", "prohibitedPatterns", "roles"])
    || !Array.isArray(value.prohibitedPatterns) || value.prohibitedPatterns.length > 20
    || !exact(value.roles, ROLE_NAMES)) throw failure();
  const roles = {};
  for (const roleName of ROLE_NAMES) {
    const role = value.roles[roleName];
    if (!exact(role, ["composition", "background", "textDensity", "layout"])) throw failure();
    const textDensity = requiredText(role.textDensity, 20);
    if (!TEXT_DENSITIES.has(textDensity)) throw failure();
    roles[roleName] = {
      composition: requiredText(role.composition, 1_000),
      background: requiredText(role.background, 1_000),
      textDensity,
      layout: requiredText(role.layout, 1_000),
    };
  }
  return freeze({
    overallStyle: requiredText(value.overallStyle, 1_000),
    prohibitedPatterns: value.prohibitedPatterns.map((pattern) => requiredText(pattern, 1_000)),
    roles,
  });
}

export function projectCategoryStrategyDraft(input) {
  const value = safelyProject(input);
  const keys = ["draftId", "scope", "draftVersion", "status", "previousStatus", "sampleCount", "guidance"];
  if (!exact(value, keys) || !CATEGORY_STRATEGY_DRAFT_STATES.includes(value.status)
    || (value.previousStatus !== null && !CATEGORY_STRATEGY_DRAFT_STATES.includes(value.previousStatus))
    || !Number.isSafeInteger(value.sampleCount) || value.sampleCount < 0 || value.sampleCount > 20) throw failure();
  const allowedPrevious = {
    COLLECTING: [null],
    SAMPLES_READY: ["COLLECTING"],
    ANALYZING: ["SAMPLES_READY"],
    DRAFT_READY: ["ANALYZING"],
    PUBLISHED: ["DRAFT_READY"],
    NEEDS_REVIEW: ["COLLECTING", "SAMPLES_READY", "ANALYZING", "DRAFT_READY", "NEEDS_REVIEW"],
  };
  if (!allowedPrevious[value.status].includes(value.previousStatus)) throw failure();
  if ((value.status === "SAMPLES_READY" || value.status === "ANALYZING" || value.status === "DRAFT_READY" || value.status === "PUBLISHED")
    && value.sampleCount < 5) throw failure();
  const hasGuidance = value.status === "DRAFT_READY" || value.status === "PUBLISHED";
  if ((hasGuidance && value.guidance === null) || (!hasGuidance && value.guidance !== null)) throw failure();
  return freeze({
    draftId: requiredText(value.draftId),
    scope: projectCategoryStrategyScope(value.scope),
    draftVersion: positiveInteger(value.draftVersion),
    status: value.status,
    sampleCount: value.sampleCount,
    guidance: hasGuidance ? projectCategoryStrategyGuidanceV2(value.guidance) : null,
  });
}
