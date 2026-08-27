import crypto from "node:crypto";
import { types } from "node:util";

const ROLE_ORDER = Object.freeze(["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"]);
const ROLE_KEYS = new Set(ROLE_ORDER);
const OUTPUT_KEYS = new Set(["plan", "skeletonHash", "allowedClaimsBySlot"]);
const PLAN_KEYS = new Set(["version", "language", "slots"]);
const SLOT_KEYS_V1 = new Set([
  "slotKey", "visualGroupKey", "role", "order", "textDensity", "claims", "sourceFactIds",
  "referenceAssetIds", "preserve", "prohibitedClaims",
]);
const SLOT_KEYS_V2 = new Set([...SLOT_KEYS_V1, "requestedRole", "substitutionReasonCode"]);
const SUBSTITUTION_KEYS = new Set(["requestedRole", "actualRole", "count", "reasonCode"]);
const FILL_KEYS = new Set(["version", "language", "fills"]);
const SLOT_FILL_KEYS = new Set(["claims"]);
const CLAIM_KEYS = new Set(["text", "claimType", "sourceFactIds"]);
const HASH = /^[a-f0-9]{64}$/u;
const MAX_DEPTH = 64;
const MAX_NODES = 200_000;
const MAX_STRING_LENGTH = 2_000_000;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ROLE_CLAIM_RANGES = Object.freeze({
  MAIN: Object.freeze({ LIGHT: [1, 2], MEDIUM: [2, 3], HEAVY: [4, 4] }),
  SELLING_POINT: Object.freeze({ LIGHT: [2, 2], MEDIUM: [2, 3], HEAVY: [3, 4] }),
  DETAIL: Object.freeze({ LIGHT: [1, 2], MEDIUM: [1, 2], HEAVY: [2, 2] }),
  SCENE: Object.freeze({ LIGHT: [1, 2], MEDIUM: [2, 3], HEAVY: [2, 3] }),
  SPECIFICATION: Object.freeze({ LIGHT: [2, 3], MEDIUM: [3, 4], HEAVY: [5, 6] }),
  INFOGRAPHIC: Object.freeze({ LIGHT: [3, 4], MEDIUM: [4, 5], HEAVY: [5, 6] }),
});

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

export function factAllowedForRole(fact, role) {
  if (role === "SPECIFICATION") return documentaryFact(fact);
  if (role === "MAIN") return true;
  if (role === "SELLING_POINT") return ["COLOR", "PATTERN", "SHAPE", "MATERIAL", "ACCESSORY_COUNT", "IDENTITY_NAME", "IDENTITY_BRAND"]
    .includes(fact.kind) || String(fact.kind).startsWith("ATTRIBUTE:");
  if (role === "DETAIL") return ["MATERIAL", "PATTERN", "SHAPE"].includes(fact.kind)
    || (String(fact.kind).startsWith("ATTRIBUTE:") && !detailFactExcluded(fact));
  if (role === "SCENE") return ["IDENTITY_NAME", "IDENTITY_BRAND", "SIZE", "COLOR", "MATERIAL"].includes(fact.kind);
  return true;
}

function dimensionFact(fact) {
  const kind = String(fact?.kind || "");
  const value = String(fact?.claimText || fact?.value || "");
  return kind.startsWith("DIMENSION_") || kind === "SIZE"
    || /(?:размер|длина|ширина|высота|глубина|диаметр|дхшхв)/iu.test(value);
}

function accessoryFact(fact) {
  const kind = String(fact?.kind || "");
  const value = String(fact?.claimText || fact?.value || "");
  return kind === "ACCESSORY_COUNT"
    || /(?:комплектац|комплект поставки|аксессуар|в комплекте|количество предметов)/iu.test(value);
}

function documentaryFact(fact) {
  return dimensionFact(fact) || accessoryFact(fact);
}

function mainFactBucket(fact) {
  const kind = String(fact?.kind || "");
  const evidence = `${kind} ${String(fact?.claimText || fact?.value || "")}`;
  if (/(?:нагруз|грузопод|мощност|емкост|объ[её]м|производительност|скорост|давлен|дальност|яркост|время работы|承重|功率|容量)/iu.test(evidence)) return "PERFORMANCE";
  if (kind === "MATERIAL" || /(?:материал|材质)/iu.test(evidence)) return "MATERIAL";
  if (dimensionFact(fact)) return "DIMENSION";
  if (/(?:вес(?:\s+товара)?|масса|weight|重量)/iu.test(evidence)) return "WEIGHT";
  if (String(kind).startsWith("ATTRIBUTE:") && /\d/u.test(evidence)) return "NUMERIC_ATTRIBUTE";
  if (String(kind).startsWith("ATTRIBUTE:")) return "ATTRIBUTE";
  if (["COLOR", "PATTERN", "SHAPE"].includes(kind)) return "APPEARANCE";
  return "IDENTITY";
}

const MAIN_FACT_BUCKETS = Object.freeze([
  "PERFORMANCE", "MATERIAL", "DIMENSION", "WEIGHT",
  "NUMERIC_ATTRIBUTE", "ATTRIBUTE", "APPEARANCE",
]);

function mainFactEligible(fact) {
  if (mainFactBucket(fact) === "IDENTITY") return false;
  const evidence = `${String(fact?.kind || "")} ${String(fact?.claimText || fact?.value || "")}`;
  return !/(?:код продавца|артикул продавца|количеств[оа] заводских упаковок|нужен код маркировки|название модели|страна[- ]изготовитель|^ATTRIBUTE:[^\s]+\s+тип\s*:)/iu.test(evidence);
}

function prioritizedMainFacts(facts) {
  const ranked = facts.filter(mainFactEligible).sort((left, right) => {
    const bucketDifference = MAIN_FACT_BUCKETS.indexOf(mainFactBucket(left))
      - MAIN_FACT_BUCKETS.indexOf(mainFactBucket(right));
    if (bucketDifference) return bucketDifference;
    if (mainFactBucket(left) === "DIMENSION") {
      const leftCombined = /(?:размер|дхшхв|×)/iu.test(String(left.claimText || left.value || ""));
      const rightCombined = /(?:размер|дхшхв|×)/iu.test(String(right.claimText || right.value || ""));
      if (leftCombined !== rightCombined) return leftCombined ? -1 : 1;
    }
    return compareText(left.factId, right.factId);
  });
  const selected = [];
  const selectedBuckets = new Set();
  for (const fact of ranked) {
    const bucket = mainFactBucket(fact);
    if (selectedBuckets.has(bucket)) continue;
    selected.push(fact);
    selectedBuckets.add(bucket);
    if (selected.length === 4) return selected;
  }
  for (const fact of ranked) {
    if (selected.includes(fact)) continue;
    selected.push(fact);
    if (selected.length === 4) break;
  }
  return selected;
}

function detailFactExcluded(fact) {
  if (dimensionFact(fact)) return true;
  const evidence = `${String(fact?.kind || "")} ${String(fact?.claimText || fact?.value || "")}`;
  return /(?:\sтип\s*:|модел|код продавца|артикул продавца|количеств[оа] заводских упаковок|комплектац|упаковк|срок годности|страна[- ]изготовитель|хештег|код маркировк|вес товара)/iu.test(evidence);
}

export function fixedClaimRange(slot, allowedCount) {
  if (slot.textDensity === "NONE") return { minimum: 0, maximum: 0 };
  const configured = ROLE_CLAIM_RANGES[slot.role]?.[slot.textDensity];
  if (!configured || !Number.isSafeInteger(allowedCount) || allowedCount < 1) throw skeletonInvalid();
  return {
    minimum: Math.min(configured[0], allowedCount),
    maximum: Math.min(configured[1], allowedCount),
  };
}

const DIMENSION_LABELS = Object.freeze({
  DIMENSION_HEIGHT: "Высота",
  DIMENSION_WIDTH: "Ширина",
  DIMENSION_LENGTH: "Длина",
  DIMENSION_DEPTH: "Глубина",
  DIMENSION_DIAMETER: "Диаметр",
});

function claimTextForFact(fact) {
  const raw = typeof fact?.value === "string" ? fact.value.trim() : "";
  if (!raw) return "";
  const label = DIMENSION_LABELS[fact.kind];
  const localized = raw.replace(/\b(mm|cm|kg|g|l|w)\b/giu, (unit) => ({
    mm: "мм", cm: "см", kg: "кг", g: "г", l: "л", w: "Вт",
  })[unit.toLocaleLowerCase("en-US")] || unit);
  const text = label ? `${label}: ${localized}` : localized;
  return text.length <= 300 && (/\p{Script=Cyrillic}/u.test(text)
    || String(fact.kind).startsWith("IDENTITY_")) ? text : "";
}

function prohibitedClaimText(text) {
  return typeof text === "string"
    && /сертиф|certif|гаранти|warrant|медицин|лечеб|medical\s+benefit|вылеч|cure\b/iu.test(text);
}

function factsForOccurrence(facts, occurrence, count) {
  if (count <= 1 || facts.length <= 1) return facts;
  if (facts.length < count) return [facts[occurrence % facts.length]];
  return facts.filter((_fact, index) => index % count === occurrence);
}

function fixedContext(rawContext) {
  let context;
  try { context = project(rawContext); } catch { throw skeletonInvalid(); }
  const input = context?.plannerInput;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Array.isArray(input.visualGroups) || !input.visualGroups.length) {
    throw error("AUTO_LISTING_FIXED_SKELETON_VISUAL_GROUP_UNSUPPORTED", "固定图片骨架缺少视觉分组");
  }
  if (!Array.isArray(input.factRegistry) || !input.factRegistry.length
    || !input.requestedRoleCounts || typeof input.requestedRoleCounts !== "object"
    || !input.textDensityByRole || typeof input.textDensityByRole !== "object"
    || !Array.isArray(input.prohibitedClaims) || input.language !== "ru"
    || !requiredText(input.ratio, 20) || !requiredText(input.resolution, 20) || !requiredText(input.quality, 20)) throw skeletonInvalid();
  if (Object.keys(input.requestedRoleCounts).length !== ROLE_ORDER.length
    || Object.keys(input.requestedRoleCounts).some((key) => !ROLE_KEYS.has(key))) throw skeletonInvalid();
  const roleSubstitutions = input.roleSubstitutions ?? [];
  if (!Array.isArray(roleSubstitutions) || roleSubstitutions.some((entry) => !exact(entry, SUBSTITUTION_KEYS)
    || entry.requestedRole !== "SPECIFICATION" || !ROLE_KEYS.has(entry.actualRole)
    || entry.actualRole === "SPECIFICATION" || !Number.isSafeInteger(entry.count) || entry.count < 1
    || entry.reasonCode !== "PRODUCT_DIMENSIONS_UNAVAILABLE")) throw skeletonInvalid();
  const total = ROLE_ORDER.reduce((sum, role) => {
    const count = input.requestedRoleCounts[role];
    if (!Number.isSafeInteger(count) || count < 0 || count > 13) throw skeletonInvalid();
    return sum + count;
  }, 0);
  if (total !== input.imagesPerVisualGroup || total < 6 || total > 13) throw skeletonInvalid();
  for (const role of ROLE_ORDER) {
    const substituted = roleSubstitutions.filter((entry) => entry.actualRole === role)
      .reduce((sum, entry) => sum + entry.count, 0);
    if (substituted > input.requestedRoleCounts[role]) throw skeletonInvalid();
  }
  if (roleSubstitutions.length && input.requestedRoleCounts.SPECIFICATION !== 0) throw skeletonInvalid();
  const facts = input.factRegistry.map((fact) => {
    if (!fact || !requiredText(fact.factId, 240) || !requiredText(fact.kind, 120)
      || !requiredText(fact.value, 2048) || !Array.isArray(fact.visualGroupKeys)
      || fact.visualGroupKeys.some((key) => !requiredText(key, 240))) throw skeletonInvalid();
    return fact;
  });
  const groupKeys = input.visualGroups.map((group) => group?.visualGroupKey);
  if (groupKeys.some((key) => !requiredText(key, 240)) || new Set(groupKeys).size !== groupKeys.length) {
    throw skeletonInvalid();
  }
  const groups = input.visualGroups.map((group) => {
    if (!Array.isArray(group.referenceImages) || !group.referenceImages.length
      || !Array.isArray(group.requiredPreserve) || !group.requiredPreserve.length) throw skeletonInvalid();
    const referenceAssetIds = group.referenceImages.map((entry) => entry?.assetId);
    if (referenceAssetIds.some((entry) => !requiredText(entry, 240))
      || new Set(referenceAssetIds).size !== referenceAssetIds.length
      || group.requiredPreserve.some((entry) => !requiredText(entry, 240))) throw skeletonInvalid();
    const groupFacts = facts.filter((fact) => !fact.visualGroupKeys.length
      || fact.visualGroupKeys.includes(group.visualGroupKey));
    if (!groupFacts.length) throw skeletonInvalid();
    return { group, facts: groupFacts, referenceAssetIds };
  });
  return { input, groups, total, roleSubstitutions };
}

export function buildFixedSkeleton({ plannerContext } = {}) {
  const { input, groups, roleSubstitutions } = fixedContext(plannerContext);
  const slots = [];
  const allowedClaimsBySlot = Object.create(null);
  for (const { group, facts, referenceAssetIds } of groups) {
    const claimableFacts = facts.map((fact) => ({ ...fact, claimText: claimTextForFact(fact) }))
      .filter((fact) => fact.claimText && !prohibitedClaimText(fact.claimText));
    const identityAnchor = claimableFacts.find((fact) => fact.kind === "IDENTITY_NAME") || claimableFacts[0];
    let order = 1;
    for (const role of ROLE_ORDER) {
      const usedClaimFactIds = new Set();
      const substitutions = roleSubstitutions.filter((entry) => entry.actualRole === role);
      const originalCount = input.requestedRoleCounts[role]
        - substitutions.reduce((sum, entry) => sum + entry.count, 0);
      const roleFacts = claimableFacts.filter((fact) => factAllowedForRole(fact, role));
      const roleCandidates = role === "MAIN"
        && input.promptTemplateVersion === "AUTO_LISTING_CONTENT_PLAN_FILL_V6"
        ? prioritizedMainFacts(roleFacts)
        : roleFacts;
      for (let occurrence = 1; occurrence <= input.requestedRoleCounts[role]; occurrence += 1) {
        const slotOrder = order++;
        const slotKey = `${group.visualGroupKey}:${role.toLowerCase().replaceAll("_", "-")}:${String(occurrence).padStart(2, "0")}`;
        let substitution = null;
        let substitutedOccurrence = occurrence - originalCount;
        if (substitutedOccurrence > 0) substitution = substitutions.find((entry) => {
          if (substitutedOccurrence <= entry.count) return true;
          substitutedOccurrence -= entry.count;
          return false;
        }) || null;
        const distributedFacts = factsForOccurrence(
          roleCandidates,
          occurrence - 1,
          input.requestedRoleCounts[role],
        ).filter((fact) => !usedClaimFactIds.has(fact.factId));
        const density = input.textDensityByRole[role];
        const allowedFacts = density === "NONE" ? [] : distributedFacts;
        allowedFacts.forEach((fact) => usedClaimFactIds.add(fact.factId));
        const allowed = allowedFacts.map(({ factId, kind, claimText }) => ({ factId, kind, value: claimText }));
        if (!(role === "MAIN" && input.promptTemplateVersion === "AUTO_LISTING_CONTENT_PLAN_FILL_V6")) {
          allowed.sort((left, right) => compareText(left.factId, right.factId));
        }
        const sourceFactIds = allowed.length
          ? allowed.map(({ factId }) => factId)
          : [identityAnchor?.factId].filter(Boolean);
        if (!sourceFactIds.length) throw skeletonInvalid();
        allowedClaimsBySlot[slotKey] = allowed;
        slots.push({
          slotKey,
          visualGroupKey: group.visualGroupKey,
          role,
          requestedRole: substitution?.requestedRole || role,
          substitutionReasonCode: substitution?.reasonCode || null,
          order: slotOrder,
          textDensity: allowed.length ? density : "NONE",
          claims: [],
          sourceFactIds,
          referenceAssetIds: referenceAssetIds.length === 1 || slotOrder === 1
            ? [referenceAssetIds[0]]
            : [referenceAssetIds[1 + ((slotOrder - 2) % (referenceAssetIds.length - 1))], referenceAssetIds[0]],
          preserve: [...group.requiredPreserve],
          prohibitedClaims: [...input.prohibitedClaims],
        });
      }
    }
  }
  const plan = { version: 2, language: "ru", slots };
  const skeletonHash = sha256({
    contract: "FIXED_SKELETON_V1",
    generation: { language: input.language, ratio: input.ratio, resolution: input.resolution, quality: input.quality },
    plan,
    allowedClaimsBySlot,
  });
  return deepFreeze({ plan, skeletonHash, allowedClaimsBySlot });
}

function claimSchema(slot, allowed) {
  const { minimum, maximum } = fixedClaimRange(slot, allowed.length);
  if (allowed.length === 0) {
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        claims: {
          type: "array", minItems: 0, maxItems: 0,
          items: { type: "object", additionalProperties: false, properties: {}, required: [] },
        },
      },
      required: ["claims"],
    };
  }
  const kinds = [...new Set(allowed.map(({ kind }) => kind))].sort(compareText);
  const factIds = allowed.map(({ factId }) => factId).sort(compareText);
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      claims: {
        type: "array", minItems: minimum, maxItems: maximum,
        items: {
          type: "object", additionalProperties: false,
          properties: {
            text: { type: "string", enum: [...new Set(allowed.map(({ value }) => value))].sort(compareText) },
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
          claimSchema(
            slot,
            skeleton.allowedClaimsBySlot[slot.slotKey],
          ),
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
    const allowed = skeleton.allowedClaimsBySlot[slot.slotKey];
    const { minimum, maximum } = fixedClaimRange(slot, allowed.length);
    if (slotFill.claims.length < minimum || slotFill.claims.length > maximum) {
      throw fillInvalid("CLAIM_COUNT_MISMATCH", slot.slotKey, "claims");
    }
    const allowedById = new Map(allowed.map((fact) => [fact.factId, fact]));
    let claims = slotFill.claims.map((claim, claimIndex) => {
      const citedFacts = Array.isArray(claim?.sourceFactIds)
        ? claim.sourceFactIds.map((factId) => allowedById.get(factId)) : [];
      if (!exact(claim, CLAIM_KEYS) || !requiredText(claim.text, 300) || !requiredText(claim.claimType, 120)
        || !Array.isArray(claim.sourceFactIds) || !claim.sourceFactIds.length
        || claim.sourceFactIds.length !== new Set(claim.sourceFactIds).size
        || claim.sourceFactIds.some((factId) => !allowedById.has(factId))
        || citedFacts.some((fact) => fact?.value !== claim.text)) {
        throw fillInvalid("FIXED_FILL_CLAIM_INVALID", slot.slotKey, `claims[${claimIndex}]`, claimIndex);
      }
      const derivedKind = [...citedFacts].sort((left, right) => compareText(left.factId, right.factId))[0].kind;
      return { text: claim.text, claimType: derivedKind, sourceFactIds: [...claim.sourceFactIds] };
    });
    const requiredDocumentaryFact = slot.role === "SPECIFICATION" ? allowed.find(documentaryFact) : null;
    if (requiredDocumentaryFact
      && !claims.some((claim) => claim.sourceFactIds.some((factId) => documentaryFact(allowedById.get(factId))))) {
      const pinned = {
        text: requiredDocumentaryFact.value,
        claimType: requiredDocumentaryFact.kind,
        sourceFactIds: [requiredDocumentaryFact.factId],
      };
      claims = claims.length >= maximum
        ? [...claims.slice(0, maximum - 1), pinned]
        : [...claims, pinned];
    }
    return { ...slot, claims };
  });
  return deepFreeze({ version: skeleton.plan.version, language: "ru", slots });
}
