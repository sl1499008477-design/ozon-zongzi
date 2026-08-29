import { types } from "node:util";
import { fixedClaimRange } from "./auto-listing-fixed-skeleton.mjs";

export const AUTO_LISTING_CONTENT_PLAN_VALIDATOR_VERSION = "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1";

const MAX_DEPTH = 64;
const MAX_NODES = 200_000;
const MAX_SLOTS = 1_000;
const MAX_STRING_LENGTH = 2_000_000;
const MAX_ISSUES = 100;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PLAN_KEYS = new Set(["version", "language", "slots"]);
const SLOT_KEYS_V1 = new Set([
  "slotKey", "visualGroupKey", "role", "order", "textDensity", "claims", "sourceFactIds",
  "referenceAssetIds", "preserve", "prohibitedClaims",
]);
const SLOT_KEYS_V2 = new Set([...SLOT_KEYS_V1, "requestedRole", "substitutionReasonCode"]);
const CLAIM_KEYS = new Set(["text", "claimType", "sourceFactIds"]);
const ROLE_ORDER = ["MAIN", "SELLING_POINT", "INFOGRAPHIC", "SCENE", "DETAIL", "SPECIFICATION"];
const LEGACY_ROLE_ORDER = ["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"];
const SECRET_LIKE = /(?:api[_-]?key|password|passwd|secret|bearer|authorization|cookie|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|sk-(?:proj-)?)/iu;

class CarrierInvalid extends Error {}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}

function cloneData(value, state, depth = 0) {
  if (depth > MAX_DEPTH || state.nodes >= MAX_NODES) throw new CarrierInvalid();
  state.nodes += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CarrierInvalid();
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) throw new CarrierInvalid();
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value) || state.active.has(value)) {
    throw new CarrierInvalid();
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_SLOTS * 20) {
        throw new CarrierInvalid();
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string") || descriptors.length?.value !== value.length) {
        throw new CarrierInvalid();
      }
      const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) throw new CarrierInvalid();
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
          throw new CarrierInvalid();
        }
        return cloneData(descriptor.value, state, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new CarrierInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 10_000 || keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key))) {
      throw new CarrierInvalid();
    }
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) throw new CarrierInvalid();
      output[key] = cloneData(descriptor.value, state, depth + 1);
    }
    return output;
  } catch (error) {
    if (error instanceof CarrierInvalid) throw error;
    throw new CarrierInvalid();
  } finally {
    state.active.delete(value);
  }
}

function safeProject(value) {
  return cloneData(value, { nodes: 0, active: new Set() });
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
}

function validStringArray(value, { nonempty = false } = {}) {
  return Array.isArray(value)
    && (!nonempty || value.length > 0)
    && value.length === new Set(value).size
    && value.every((entry) => typeof entry === "string" && entry.trim());
}

function safeSummary(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === "object") return "object";
  let text = String(value);
  if (SECRET_LIKE.test(text)) return "[redacted]";
  if (text.length > 160) text = `${text.slice(0, 157)}...`;
  return text;
}

function addIssue(issues, value) {
  if (issues.length >= MAX_ISSUES) return;
  issues.push(Object.freeze({
    code: /^[A-Z][A-Z0-9_]{0,119}$/u.test(value.code || "") ? value.code : "CONTENT_PLAN_RULE_MISMATCH",
    slotKey: typeof value.slotKey === "string" && value.slotKey.length <= 500 ? value.slotKey : null,
    claimIndex: Number.isSafeInteger(value.claimIndex) && value.claimIndex >= 0 ? value.claimIndex : null,
    field: typeof value.field === "string" && value.field.length <= 240 ? value.field : null,
    expected: safeSummary(value.expected),
    actual: safeSummary(value.actual),
  }));
}

function forbiddenClaim(text) {
  return typeof text === "string"
    && /сертиф|certif|гаранти|warrant|медицин|лечеб|medical\s+benefit|вылеч|cure\b/iu.test(text);
}

function numberTokens(text) {
  return typeof text === "string" ? (text.match(/\d+(?:[.,]\d+)?/gu) || []).map((entry) => entry.replaceAll(",", ".")) : [];
}

function normalizedUnit(value) {
  return new Map([
    ["mm", "mm"], ["мм", "mm"], ["cm", "cm"], ["см", "cm"], ["m", "m"], ["м", "m"],
    ["kg", "kg"], ["кг", "kg"], ["g", "g"], ["г", "g"], ["l", "l"], ["л", "l"],
    ["w", "w"], ["вт", "w"],
  ]).get(String(value).toLocaleLowerCase("ru-RU")) || null;
}

function numberUnitPairs(text) {
  return typeof text === "string" ? [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*([\p{L}]+)/gu)]
    .map(([, number, unit]) => ({ number: number.replaceAll(",", "."), unit: normalizedUnit(unit) })) : [];
}

function numericEvidenceMatches(text, facts, claimType = "") {
  const scopedFacts = claimType ? facts.filter((fact) => fact?.kind === claimType) : facts;
  const evidenceNumbers = new Set(scopedFacts.flatMap((fact) => numberTokens(fact?.value)));
  if (numberTokens(text).some((number) => !evidenceNumbers.has(number))) return false;
  return numberUnitPairs(text).every((pair) => pair.unit && scopedFacts.some((fact) => numberUnitPairs(fact?.value)
    .some((evidence) => evidence.number === pair.number && evidence.unit === pair.unit)));
}

const IDENTITY_STOP_WORDS = new Set(["и", "в", "во", "на", "для", "до", "с", "со", "из", "по", "от", "к", "у", "не", "без"]);

function identityTokens(value) {
  return (String(value || "").toLocaleLowerCase("ru-RU").match(/\d+(?:[.,]\d+)?|\p{L}+/gu) || [])
    .map((token) => token.replaceAll(",", "."));
}

function identityTextUsesEvidence(text, facts, claimType) {
  const claimTokens = identityTokens(text);
  const evidenceTokens = new Set(facts
    .filter((fact) => fact?.kind === claimType)
    .flatMap((fact) => identityTokens(fact?.value)));
  const allowedLabels = claimType === "IDENTITY_BRAND" ? new Set(["бренд", "марка"]) : new Set();
  return claimTokens.length > 0
    && claimTokens.every((token) => evidenceTokens.has(token) || allowedLabels.has(token))
    && claimTokens.some((token) => /\d/u.test(token) || (token.length >= 2 && !IDENTITY_STOP_WORDS.has(token)));
}

function textUsesEvidence(claim, facts) {
  const normalized = String(claim.text || "").toLocaleLowerCase("ru-RU");
  if (String(claim.claimType || "").startsWith("DIMENSION_")) {
    if (!numberTokens(claim.text).length || !numericEvidenceMatches(claim.text, facts, claim.claimType)) return false;
    const mentionedKinds = [
      [/высот/u, "DIMENSION_HEIGHT"],
      [/ширин/u, "DIMENSION_WIDTH"],
      [/длин/u, "DIMENSION_LENGTH"],
      [/глубин/u, "DIMENSION_DEPTH"],
      [/диаметр/u, "DIMENSION_DIAMETER"],
    ].filter(([pattern]) => pattern.test(normalized)).map(([, kind]) => kind);
    return !mentionedKinds.length || mentionedKinds.every((kind) => kind === claim.claimType);
  }
  if (String(claim.claimType || "").startsWith("IDENTITY_")) {
    return identityTextUsesEvidence(claim.text, facts, claim.claimType);
  }
  return facts.some((fact) => {
    if (fact?.kind !== claim.claimType || typeof fact.value !== "string") return false;
    const value = fact.value.toLocaleLowerCase("ru-RU").trim();
    return value.length > 2 ? normalized.includes(value)
      : normalized.split(/[^\p{L}\p{N}]+/u).includes(value);
  });
}

function roleOrderFor(input) {
  return input?.promptTemplateVersion === "AUTO_LISTING_CONTENT_PLAN_FILL_V6"
    ? ROLE_ORDER
    : LEGACY_ROLE_ORDER;
}

function expectedSlots(input, roleOrder) {
  const slots = [];
  for (const group of input.visualGroups || []) {
    let order = 1;
    for (const role of roleOrder) {
      const count = Number.isSafeInteger(input.requestedRoleCounts?.[role]) ? input.requestedRoleCounts[role] : 0;
      const substitutions = Array.isArray(input.roleSubstitutions)
        ? input.roleSubstitutions.filter((entry) => entry?.actualRole === role) : [];
      const originalCount = count - substitutions.reduce((sum, entry) => sum + Number(entry?.count || 0), 0);
      for (let occurrence = 1; occurrence <= count; occurrence += 1) {
        let substitution = null;
        let substitutedOccurrence = occurrence - originalCount;
        if (substitutedOccurrence > 0) substitution = substitutions.find((entry) => {
          if (substitutedOccurrence <= entry.count) return true;
          substitutedOccurrence -= entry.count;
          return false;
        }) || null;
        slots.push({
          visualGroupKey: group.visualGroupKey,
          role,
          requestedRole: substitution?.requestedRole || role,
          substitutionReasonCode: substitution?.reasonCode || null,
          order: order++,
          slotKey: `${group.visualGroupKey}:${role.toLowerCase().replaceAll("_", "-")}:${String(occurrence).padStart(2, "0")}`,
        });
      }
    }
  }
  return slots;
}

function collectIssues(plan, plannerContext) {
  const issues = [];
  const input = plannerContext?.plannerInput;
  if (!exactKeys(plan, PLAN_KEYS) || ![1, 2].includes(plan.version) || plan.language !== "ru" || !Array.isArray(plan.slots)
    || !input || !Array.isArray(input.visualGroups) || !Array.isArray(input.factRegistry)) {
    addIssue(issues, { code: "CONTENT_PLAN_SHAPE_INVALID", field: "plan", expected: "closed V1 or V2 ru plan", actual: plan });
    return issues;
  }
  if (plan.version === 1 && Array.isArray(input.roleSubstitutions) && input.roleSubstitutions.length) {
    addIssue(issues, { code: "CONTENT_PLAN_SHAPE_INVALID", field: "version", expected: 2, actual: plan.version });
  }
  const roleOrder = roleOrderFor(input);
  const expected = expectedSlots(input, roleOrder);
  if (plan.slots.length !== expected.length) addIssue(issues, {
    code: "SLOT_COUNT_MISMATCH", field: "slots", expected: expected.length, actual: plan.slots.length,
  });
  const facts = new Map(input.factRegistry.map((fact) => [fact?.factId, fact]));
  const groups = new Map(input.visualGroups.map((group) => [group?.visualGroupKey, group]));
  const actualRoleCounts = new Map([...groups.keys()].map((key) => [key, Object.fromEntries(roleOrder.map((role) => [role, 0]))]));
  for (let index = 0; index < plan.slots.length && issues.length < MAX_ISSUES; index += 1) {
    const slot = plan.slots[index];
    const expectedSlot = expected[index];
    const slotKey = typeof slot?.slotKey === "string" ? slot.slotKey : null;
    const slotKeys = plan.version === 2 ? SLOT_KEYS_V2 : SLOT_KEYS_V1;
    if (!exactKeys(slot, slotKeys)) {
      addIssue(issues, { code: "SLOT_SHAPE_INVALID", slotKey, field: `slots[${index}]`, expected: "closed slot", actual: slot });
      continue;
    }
    if (typeof slot.slotKey !== "string" || !slot.slotKey.trim()) addIssue(issues, {
      code: "SLOT_IDENTITY_MISMATCH", slotKey, field: "slotKey", expected: "non-empty slot key", actual: slot.slotKey,
    });
    if (expectedSlot && slot.order !== expectedSlot.order) addIssue(issues, {
      code: "SLOT_ORDER_MISMATCH", slotKey, field: "order", expected: expectedSlot.order, actual: slot.order,
    });
    if (expectedSlot && slot.role !== expectedSlot.role) addIssue(issues, {
      code: "ROLE_COUNT_MISMATCH", slotKey, field: "role", expected: expectedSlot.role, actual: slot.role,
    });
    if (plan.version === 2 && expectedSlot
      && (slot.requestedRole !== expectedSlot.requestedRole
        || slot.substitutionReasonCode !== expectedSlot.substitutionReasonCode)) {
      addIssue(issues, { code: "ROLE_SUBSTITUTION_MISMATCH", slotKey, field: "requestedRole",
        expected: `${expectedSlot.requestedRole}:${expectedSlot.substitutionReasonCode || "none"}`,
        actual: `${slot.requestedRole}:${slot.substitutionReasonCode || "none"}` });
    }
    if (expectedSlot && (slot.slotKey !== expectedSlot.slotKey || slot.visualGroupKey !== expectedSlot.visualGroupKey)) {
      addIssue(issues, { code: "SLOT_IDENTITY_MISMATCH", slotKey, field: "slotKey", expected: expectedSlot.slotKey, actual: slot.slotKey });
    }
    if (actualRoleCounts.has(slot.visualGroupKey) && roleOrder.includes(slot.role)) {
      actualRoleCounts.get(slot.visualGroupKey)[slot.role] += 1;
    }
    const group = groups.get(slot.visualGroupKey);
    if (!group) {
      addIssue(issues, { code: "VISUAL_GROUP_NOT_FOUND", slotKey, field: "visualGroupKey", expected: "configured visual group", actual: slot.visualGroupKey });
      continue;
    }
    const allowedAssets = new Set((group.referenceImages || []).map((entry) => entry?.assetId));
    const copyFreeFallback = slot.textDensity === "NONE" && Array.isArray(slot.claims) && slot.claims.length === 0;
    if (slot.textDensity !== input.textDensityByRole?.[slot.role] && !copyFreeFallback) addIssue(issues, {
      code: "TEXT_DENSITY_MISMATCH", slotKey, field: "textDensity",
      expected: input.textDensityByRole?.[slot.role], actual: slot.textDensity,
    });
    if (!Array.isArray(slot.preserve)
      || JSON.stringify([...slot.preserve].sort()) !== JSON.stringify([...(group.requiredPreserve || [])].sort())) {
      addIssue(issues, { code: "PRESERVE_IDENTITY_MISMATCH", slotKey, field: "preserve", expected: group.requiredPreserve, actual: slot.preserve });
    }
    if (!Array.isArray(slot.prohibitedClaims)
      || JSON.stringify([...slot.prohibitedClaims].sort()) !== JSON.stringify([...(input.prohibitedClaims || [])].sort())) {
      addIssue(issues, { code: "PROHIBITED_POLICY_MISMATCH", slotKey, field: "prohibitedClaims", expected: input.prohibitedClaims, actual: slot.prohibitedClaims });
    }
    if (!validStringArray(slot.referenceAssetIds, { nonempty: true })
      || slot.referenceAssetIds.some((assetId) => !allowedAssets.has(assetId))) {
      addIssue(issues, { code: "REFERENCE_ASSET_OUT_OF_SCOPE", slotKey, field: "referenceAssetIds", expected: "group reference assets", actual: slot.referenceAssetIds });
    }
    const slotFacts = Array.isArray(slot.sourceFactIds) ? slot.sourceFactIds.map((factId) => facts.get(factId)) : [];
    if (!validStringArray(slot.sourceFactIds, { nonempty: true })
      || slotFacts.some((fact) => !fact
        || (Array.isArray(fact.visualGroupKeys) && fact.visualGroupKeys.length
          && !fact.visualGroupKeys.includes(slot.visualGroupKey)))) {
      addIssue(issues, { code: "SOURCE_FACT_NOT_FOUND", slotKey, field: "sourceFactIds", expected: "known fact IDs", actual: slot.sourceFactIds });
    }
    if (!Array.isArray(slot.claims)) {
      addIssue(issues, { code: "CLAIM_SHAPE_INVALID", slotKey, field: "claims", expected: "array", actual: slot.claims });
      continue;
    }
    const fixedCopy = /^AUTO_LISTING_CONTENT_PLAN_FILL_V[3-6]$/u.test(input.promptTemplateVersion || "");
    const claimLimit = fixedCopy
      ? fixedClaimRange(slot, Array.isArray(slot.sourceFactIds) ? slot.sourceFactIds.length : 0).maximum
      : { NONE: 0, LIGHT: 1, MEDIUM: 2, HEAVY: 3 }[slot.textDensity];
    if (!Number.isInteger(claimLimit) || slot.claims.length > claimLimit) addIssue(issues, {
      code: "CLAIM_COUNT_MISMATCH", slotKey, field: "claims", expected: claimLimit, actual: slot.claims.length,
    });
    slot.claims.forEach((claim, claimIndex) => {
      if (issues.length >= MAX_ISSUES) return;
      if (!exactKeys(claim, CLAIM_KEYS)) {
        addIssue(issues, { code: "CLAIM_SHAPE_INVALID", slotKey, claimIndex, field: `claims[${claimIndex}]`, expected: "closed claim", actual: claim });
        return;
      }
      const field = `claims[${claimIndex}].sourceFactIds`;
      const claimFacts = Array.isArray(claim.sourceFactIds) ? claim.sourceFactIds.map((id) => facts.get(id)) : [];
      if (!validStringArray(claim.sourceFactIds, { nonempty: true })
        || claim.sourceFactIds.some((id) => !Array.isArray(slot.sourceFactIds) || !slot.sourceFactIds.includes(id))
        || claimFacts.some((fact) => !fact
          || (Array.isArray(fact.visualGroupKeys) && fact.visualGroupKeys.length
            && !fact.visualGroupKeys.includes(slot.visualGroupKey)))) {
        addIssue(issues, { code: "SOURCE_FACT_NOT_FOUND", slotKey, claimIndex, field, expected: "known fact IDs", actual: claim.sourceFactIds });
      }
      if (typeof claim.text !== "string" || !claim.text.trim() || claim.text.length > 300
        || typeof claim.claimType !== "string" || !claim.claimType.trim()) {
        addIssue(issues, { code: "CLAIM_SHAPE_INVALID", slotKey, claimIndex, field: `claims[${claimIndex}]`, expected: "bounded claim text and type", actual: claim });
      }
      if (!claimFacts.some((fact) => fact?.kind === claim.claimType)) addIssue(issues, {
        code: "CLAIM_TYPE_EVIDENCE_MISMATCH", slotKey, claimIndex,
        field: `claims[${claimIndex}].claimType`, expected: "cited fact kind", actual: claim.claimType,
      });
      if (forbiddenClaim(claim.text) || input.prohibitedClaims?.includes(claim.claimType)) {
        addIssue(issues, { code: "PROHIBITED_CLAIM", slotKey, claimIndex, field: `claims[${claimIndex}].text`, expected: "allowed factual claim", actual: claim.text });
      }
      const identityExact = claimFacts.some((fact) => String(fact?.kind || "").startsWith("IDENTITY_")
        && claim.text === fact.value);
      const factExact = claimFacts.some((fact) => fact?.kind === claim.claimType && claim.text === fact.value);
      if (typeof claim.text !== "string" || (!/\p{Script=Cyrillic}/u.test(claim.text) && !identityExact)) {
        addIssue(issues, { code: "RUSSIAN_TEXT_REQUIRED", slotKey, claimIndex, field: `claims[${claimIndex}].text`, expected: "Russian or exact identity", actual: claim.text });
      }
      if (!factExact && numberTokens(claim.text).length && !numericEvidenceMatches(claim.text, claimFacts, claim.claimType)) {
        addIssue(issues, { code: "NUMERIC_EVIDENCE_MISMATCH", slotKey, claimIndex, field: `claims[${claimIndex}].text`, expected: "cited number and unit", actual: claim.text });
      }
      if (claimFacts.length && !textUsesEvidence(claim, claimFacts)) {
        addIssue(issues, { code: "CLAIM_EVIDENCE_MISMATCH", slotKey, claimIndex, field: `claims[${claimIndex}].text`, expected: "text supported by cited facts", actual: claim.text });
      }
    });
  }
  for (const [groupKey, counts] of actualRoleCounts) {
    for (const role of roleOrder) if (counts[role] !== input.requestedRoleCounts?.[role]) addIssue(issues, {
      code: "ROLE_COUNT_MISMATCH", slotKey: null, field: "role", expected: `${groupKey}:${role}:${input.requestedRoleCounts?.[role]}`, actual: counts[role],
    });
  }
  return issues;
}

function rejected(issues) {
  return deepFreeze({
    status: "REJECTED",
    validatorVersion: AUTO_LISTING_CONTENT_PLAN_VALIDATOR_VERSION,
    issues,
    plan: null,
  });
}

export function createContentPlanDiagnoser() {
  return function diagnoseContentPlan(input = {}) {
    let projected;
    try {
      projected = safeProject(input);
      if (!exactKeys(projected, new Set(["plan", "plannerContext"]))) throw new CarrierInvalid();
      if (!Array.isArray(projected.plan?.slots) || projected.plan.slots.length > MAX_SLOTS) throw new CarrierInvalid();
    } catch {
      return rejected([Object.freeze({
        code: "CONTENT_PLAN_CARRIER_INVALID", slotKey: null, claimIndex: null, field: null,
        expected: "safe closed data", actual: "rejected",
      })]);
    }
    const issues = collectIssues(projected.plan, projected.plannerContext);
    if (issues.length) return rejected(issues);
    return deepFreeze({
      status: "ACCEPTED",
      validatorVersion: AUTO_LISTING_CONTENT_PLAN_VALIDATOR_VERSION,
      issues: [],
      plan: deepFreeze(projected.plan),
    });
  };
}
