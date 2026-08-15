import crypto from "node:crypto";
import { types } from "node:util";

const ROLE_ORDER = Object.freeze(["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"]);
const ROLE_KEYS = new Set(ROLE_ORDER);
const OUTPUT_KEYS = new Set(["plan", "skeletonHash", "allowedClaimsBySlot"]);
const PLAN_KEYS = new Set(["version", "language", "slots"]);
const SLOT_KEYS = new Set([
  "slotKey", "visualGroupKey", "role", "order", "textDensity", "claims", "sourceFactIds",
  "referenceAssetIds", "preserve", "prohibitedClaims",
]);
const FILL_KEYS = new Set(["version", "language", "fills"]);
const SLOT_FILL_KEYS = new Set(["claims"]);
const CLAIM_KEYS = new Set(["text", "claimType", "sourceFactIds"]);
const HASH = /^[a-f0-9]{64}$/u;
const MAX_DEPTH = 64;
const MAX_NODES = 200_000;
const MAX_STRING_LENGTH = 2_000_000;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CLAIM_LIMIT = Object.freeze({ NONE: 0, LIGHT: 1, MEDIUM: 2, HEAVY: 3 });

class UnsafeCarrier extends Error {}

function error(code, message, issues = undefined) {
  const failure = new Error(message);
  failure.code = code;
  if (issues) Object.defineProperty(failure, "issues", { value: deepFreeze(issues), enumerable: false });
  return failure;
}

const skeletonInvalid = () => error(
  "AUTO_LISTING_FIXED_SKELETON_INVALID",
  "固定图片骨架配置无效",
);

function fillInvalid(code = "FIXED_FILL_SHAPE_INVALID", slotKey = null, field = "fills", claimIndex = null) {
  return error("AUTO_LISTING_CONTENT_PLAN_INVALID", "AI 图片规划结果不符合商品事实", [{
    code,
    slotKey,
    claimIndex,
    field,
    expected: "fixed skeleton fill contract",
    actual: "invalid",
  }]);
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}

function cloneData(value, state, depth = 0) {
  if (depth > MAX_DEPTH || state.nodes >= MAX_NODES) throw new UnsafeCarrier();
  state.nodes += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsafeCarrier();
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) throw new UnsafeCarrier();
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value) || state.active.has(value)) throw new UnsafeCarrier();
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 20_000) throw new UnsafeCarrier();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (keys.some((key) => typeof key !== "string") || keys.length !== allowed.size
        || keys.some((key) => !allowed.has(key)) || descriptors.length?.value !== value.length) throw new UnsafeCarrier();
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) throw new UnsafeCarrier();
        return cloneData(descriptor.value, state, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new UnsafeCarrier();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 10_000 || keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key))) throw new UnsafeCarrier();
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) throw new UnsafeCarrier();
      output[key] = cloneData(descriptor.value, state, depth + 1);
    }
    return output;
  } catch (caught) {
    if (caught instanceof UnsafeCarrier) throw caught;
    throw new UnsafeCarrier();
  } finally {
    state.active.delete(value);
  }
}

const project = (value) => cloneData(value, { nodes: 0, active: new Set() });
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
const compareText = (left, right) => Buffer.from(String(left), "utf8").compare(Buffer.from(String(right), "utf8"));
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonical(value[key])])) : value;
const canonicalText = (value) => JSON.stringify(canonical(value));
const sha256 = (value) => crypto.createHash("sha256").update(canonicalText(value)).digest("hex");
const same = (left, right) => canonicalText(left) === canonicalText(right);
const requiredText = (value, max = 500) => typeof value === "string" && value.length > 0
  && value === value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

function factAllowedForRole(fact, role) {
  if (role === "SPECIFICATION") return String(fact.kind).startsWith("DIMENSION_");
  if (role === "MAIN") return true;
  if (role === "SELLING_POINT") return ["COLOR", "PATTERN", "SHAPE", "MATERIAL", "ACCESSORY_COUNT", "IDENTITY_NAME", "IDENTITY_BRAND"]
    .includes(fact.kind) || String(fact.kind).startsWith("ATTRIBUTE:");
  if (role === "DETAIL") return ["MATERIAL", "PATTERN", "SHAPE", "ACCESSORY_COUNT", "SIZE"]
    .includes(fact.kind) || String(fact.kind).startsWith("ATTRIBUTE:");
  if (role === "SCENE") return ["IDENTITY_NAME", "IDENTITY_BRAND", "SIZE", "COLOR", "MATERIAL"].includes(fact.kind);
  return true;
}

function fixedContext(rawContext) {
  let context;
  try { context = project(rawContext); } catch { throw skeletonInvalid(); }
  const input = context?.plannerInput;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Array.isArray(input.visualGroups) || input.visualGroups.length !== 1) {
    throw error("AUTO_LISTING_FIXED_SKELETON_VISUAL_GROUP_UNSUPPORTED", "固定图片骨架当前只支持一个视觉分组");
  }
  if (!Array.isArray(input.factRegistry) || !input.factRegistry.length
    || !input.requestedRoleCounts || typeof input.requestedRoleCounts !== "object"
    || !input.textDensityByRole || typeof input.textDensityByRole !== "object"
    || !Array.isArray(input.prohibitedClaims) || input.language !== "ru"
    || !requiredText(input.ratio, 20) || !requiredText(input.resolution, 20) || !requiredText(input.quality, 20)) throw skeletonInvalid();
  if (Object.keys(input.requestedRoleCounts).length !== ROLE_ORDER.length
    || Object.keys(input.requestedRoleCounts).some((key) => !ROLE_KEYS.has(key))) throw skeletonInvalid();
  const total = ROLE_ORDER.reduce((sum, role) => {
    const count = input.requestedRoleCounts[role];
    if (!Number.isSafeInteger(count) || count < 0 || count > 13) throw skeletonInvalid();
    return sum + count;
  }, 0);
  if (total !== input.imagesPerVisualGroup || total < 6 || total > 13) throw skeletonInvalid();
  const group = input.visualGroups[0];
  if (!group || !requiredText(group.visualGroupKey, 240) || !Array.isArray(group.referenceImages)
    || !group.referenceImages.length || !Array.isArray(group.requiredPreserve) || !group.requiredPreserve.length) throw skeletonInvalid();
  const referenceAssetIds = group.referenceImages.map((entry) => entry?.assetId);
  if (referenceAssetIds.some((entry) => !requiredText(entry, 240))
    || new Set(referenceAssetIds).size !== referenceAssetIds.length
    || group.requiredPreserve.some((entry) => !requiredText(entry, 240))) throw skeletonInvalid();
  const facts = input.factRegistry.map((fact) => {
    if (!fact || !requiredText(fact.factId, 240) || !requiredText(fact.kind, 120)
      || !requiredText(fact.value, 2048) || !Array.isArray(fact.visualGroupKeys)
      || fact.visualGroupKeys.some((key) => !requiredText(key, 240))) throw skeletonInvalid();
    return fact;
  }).filter((fact) => !fact.visualGroupKeys.length || fact.visualGroupKeys.includes(group.visualGroupKey));
  if (!facts.length) throw skeletonInvalid();
  if (input.requestedRoleCounts.SPECIFICATION > 0 && !facts.some((fact) => String(fact.kind).startsWith("DIMENSION_"))) {
    throw error("AUTO_LISTING_FIXED_SKELETON_DIMENSION_REQUIRED", "尺寸图缺少可靠的商品尺寸依据");
  }
  return { input, group, facts, total, referenceAssetIds };
}

export function buildFixedSkeleton({ plannerContext } = {}) {
  const { input, group, facts, referenceAssetIds } = fixedContext(plannerContext);
  const slots = [];
  const allowedClaimsBySlot = Object.create(null);
  let order = 1;
  for (const role of ROLE_ORDER) {
    const roleFacts = facts.filter((fact) => factAllowedForRole(fact, role));
    const allowedFacts = roleFacts.length ? roleFacts : facts;
    for (let occurrence = 1; occurrence <= input.requestedRoleCounts[role]; occurrence += 1) {
      const slotKey = `${group.visualGroupKey}:${role.toLowerCase().replaceAll("_", "-")}:${String(occurrence).padStart(2, "0")}`;
      const allowed = allowedFacts.map(({ factId, kind, value }) => ({ factId, kind, value }))
        .sort((left, right) => compareText(left.factId, right.factId));
      allowedClaimsBySlot[slotKey] = allowed;
      slots.push({
        slotKey,
        visualGroupKey: group.visualGroupKey,
        role,
        order: order++,
        textDensity: input.textDensityByRole[role],
        claims: [],
        sourceFactIds: allowed.map(({ factId }) => factId),
        referenceAssetIds: [...referenceAssetIds],
        preserve: [...group.requiredPreserve],
        prohibitedClaims: [...input.prohibitedClaims],
      });
    }
  }
  const plan = { version: 1, language: "ru", slots };
  const skeletonHash = sha256({
    contract: "FIXED_SKELETON_V1",
    generation: { language: input.language, ratio: input.ratio, resolution: input.resolution, quality: input.quality },
    plan,
    allowedClaimsBySlot,
  });
  return deepFreeze({ plan, skeletonHash, allowedClaimsBySlot });
}

function claimSchema(allowed, maximum) {
  const kinds = [...new Set(allowed.map(({ kind }) => kind))].sort(compareText);
  const factIds = allowed.map(({ factId }) => factId).sort(compareText);
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      claims: {
        type: "array", minItems: 0, maxItems: maximum,
        items: {
          type: "object", additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1, maxLength: 300 },
            claimType: { type: "string", enum: kinds },
            sourceFactIds: { type: "array", minItems: 1, maxItems: factIds.length, items: { type: "string", enum: factIds } },
          },
          required: ["text", "claimType", "sourceFactIds"],
        },
      },
    },
    required: ["claims"],
  };
}

export function buildContentPlanFillSchema(rawSkeleton) {
  let skeleton;
  try { skeleton = project(rawSkeleton); } catch { throw skeletonInvalid(); }
  if (!exact(skeleton, OUTPUT_KEYS) || !exact(skeleton.plan, PLAN_KEYS) || !HASH.test(skeleton.skeletonHash || "")
    || !Array.isArray(skeleton.plan.slots) || !skeleton.allowedClaimsBySlot
    || typeof skeleton.allowedClaimsBySlot !== "object" || Array.isArray(skeleton.allowedClaimsBySlot)) throw skeletonInvalid();
  const slotKeys = skeleton.plan.slots.map((slot) => slot?.slotKey);
  if (slotKeys.some((key) => !requiredText(key)) || new Set(slotKeys).size !== slotKeys.length
    || !same(Object.keys(skeleton.allowedClaimsBySlot).sort(compareText), [...slotKeys].sort(compareText))) throw skeletonInvalid();
  const schema = {
    type: "object", additionalProperties: false,
    properties: {
      version: { type: "integer", const: 1 },
      language: { type: "string", const: "ru" },
      fills: {
        type: "object", additionalProperties: false,
        properties: Object.fromEntries(skeleton.plan.slots.map((slot) => [
          slot.slotKey,
          claimSchema(skeleton.allowedClaimsBySlot[slot.slotKey], CLAIM_LIMIT[slot.textDensity]),
        ])),
        required: slotKeys,
      },
    },
    required: ["version", "language", "fills"],
  };
  return deepFreeze(schema);
}

export function mergeContentPlanFill({ skeleton: rawSkeleton, fill: rawFill, plannerContext } = {}) {
  let skeleton;
  let fill;
  try {
    skeleton = project(rawSkeleton);
    fill = project(rawFill);
  } catch {
    throw fillInvalid("FIXED_FILL_CARRIER_INVALID", null, "fill");
  }
  const expected = buildFixedSkeleton({ plannerContext });
  if (!exact(skeleton, OUTPUT_KEYS) || !same(skeleton, expected)) throw fillInvalid("FIXED_SKELETON_IDENTITY_MISMATCH", null, "skeletonHash");
  if (!exact(fill, FILL_KEYS) || fill.version !== 1 || fill.language !== "ru"
    || !fill.fills || typeof fill.fills !== "object" || Array.isArray(fill.fills)) {
    throw fillInvalid();
  }
  const slotKeys = skeleton.plan.slots.map(({ slotKey }) => slotKey);
  if (!same(Object.keys(fill.fills).sort(compareText), [...slotKeys].sort(compareText))) {
    throw fillInvalid("FIXED_FILL_SLOT_IDENTITY_MISMATCH", null, "fills");
  }
  const slots = skeleton.plan.slots.map((slot) => {
    const slotFill = fill.fills[slot.slotKey];
    if (!exact(slotFill, SLOT_FILL_KEYS) || !Array.isArray(slotFill.claims)) {
      throw fillInvalid("FIXED_FILL_SLOT_SHAPE_INVALID", slot.slotKey, "claims");
    }
    const limit = CLAIM_LIMIT[slot.textDensity];
    if (!Number.isSafeInteger(limit) || slotFill.claims.length > limit
      || (slot.role === "MAIN" && slotFill.claims.length !== 0)) {
      throw fillInvalid("CLAIM_COUNT_MISMATCH", slot.slotKey, "claims");
    }
    const allowed = skeleton.allowedClaimsBySlot[slot.slotKey];
    const allowedById = new Map(allowed.map((fact) => [fact.factId, fact]));
    const claims = slotFill.claims.map((claim, claimIndex) => {
      if (!exact(claim, CLAIM_KEYS) || !requiredText(claim.text, 300) || !requiredText(claim.claimType, 120)
        || !Array.isArray(claim.sourceFactIds) || !claim.sourceFactIds.length
        || claim.sourceFactIds.length !== new Set(claim.sourceFactIds).size
        || claim.sourceFactIds.some((factId) => !allowedById.has(factId))
        || !claim.sourceFactIds.some((factId) => allowedById.get(factId)?.kind === claim.claimType)) {
        throw fillInvalid("FIXED_FILL_CLAIM_INVALID", slot.slotKey, `claims[${claimIndex}]`, claimIndex);
      }
      return { text: claim.text, claimType: claim.claimType, sourceFactIds: [...claim.sourceFactIds] };
    });
    return { ...slot, claims };
  });
  return deepFreeze({ version: 1, language: "ru", slots });
}
