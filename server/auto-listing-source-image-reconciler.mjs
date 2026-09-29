import crypto from "node:crypto";
import { types } from "node:util";

import {
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS,
  verifySourceImageAssessment,
  verifySourceImageIntelligenceSummary,
} from "./auto-listing-source-image-intelligence-contract.mjs";
import { verifyAutoListingSourceSnapshot } from "./auto-listing-source-snapshot.mjs";

const COMPLETE_FAMILIES = Object.freeze(["FRONT", "BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"]);
const FAMILY_ORDER = Object.freeze([...COMPLETE_FAMILIES, "DETAIL", "SCENE", "PACKAGE"]);
const MANUAL_DECISIONS = new Set(["PRODUCT_MARKING", "EXTERNAL_OVERLAY_EXCLUDE", "UNRESOLVED_EXCLUDE"]);
const RECONCILE_KEYS = new Set(["sourceCapture", "assessments", "decisions"]);
const RECONCILE_DERIVATIVE_KEYS = new Set([...RECONCILE_KEYS, "acceptedDerivativeBindings"]);
const FACT_KEYS = new Set(["sourceCapture", "assessments"]);
const DECISION_KEYS = new Set(["sourceAssetId", "decision", "decisionHash"]);
const DERIVATIVE_BINDING_KEYS = new Set([
  "sourceAssetId", "mode", "effectiveContentHash", "derivativeAttemptId", "cleanupEvidenceHash",
]);
const HASH = /^[a-f0-9]{64}$/u;
const APPEARANCE_KINDS = new Set(["PRODUCT_VIEW", "PRODUCT_DETAIL", "USAGE_SCENE", "PACKAGE", "MIXED"]);
const APPEARANCE_USES = new Set(["IDENTITY_ANCHOR", "TARGET_VIEW", "DETAIL", "SCENE", "PACKAGE"]);
const SEMANTIC_FACT_KIND = Object.freeze({
  SELLING_POINT: "IMAGE_SELLING_POINT",
  USAGE: "IMAGE_USAGE",
  USAGE_STEP: "IMAGE_USAGE_STEP",
  SPECIFICATION: "IMAGE_SPECIFICATION",
  PACKAGE_CONTENT: "IMAGE_PACKAGE_CONTENT",
  CAUTION: "IMAGE_CAUTION",
  PRODUCT_IDENTITY: "IMAGE_PRODUCT_IDENTITY",
});
const REJECTED_SEMANTIC_KINDS = new Set(["EXTERNAL_OVERLAY", "PROMOTION", "CONTACT", "OTHER"]);
const HARD_UNSAFE_SEMANTIC_KINDS = new Set(["EXTERNAL_OVERLAY", "CONTACT"]);
const COLLECTION_FACT_KINDS = new Set([
  "IMAGE_SELLING_POINT", "IMAGE_USAGE", "IMAGE_USAGE_STEP", "IMAGE_PACKAGE_CONTENT", "IMAGE_CAUTION",
]);
const UNSAFE_MATERIAL_OR_MODEL_VALUE = /(?:hypoallergenic|hypo\s*аллергенн\p{L}*|гипо\s*allergenic\p{L}*|гипоаллергенн\p{L}*|compatib\p{L}*|совместим\p{L}*|medical\p{L}*|медицинск\p{L}*|(?:^|\s)med(?:ical)?\s*grade(?:$|\s)|cures?|лечит\p{L}*|лечение|safety|safe|безопасн\p{L}*)/iu;

function failure() {
  return Object.assign(new Error("AUTO_LISTING_SOURCE_IMAGE_RECONCILIATION_INPUT_INVALID"), {
    code: "AUTO_LISTING_SOURCE_IMAGE_RECONCILIATION_INPUT_INVALID",
  });
}

function plain(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value) && !types.isProxy(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  } catch { return false; }
}

function exact(value, keys) {
  if (!plain(value)) throw failure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
    || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw failure();
  return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
}

function compareCodePoints(left, right) {
  const a = Array.from(String(left), (character) => character.codePointAt(0));
  const b = Array.from(String(right), (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort(compareCodePoints).map((key) => [key, canonical(value[key])]))
    : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const sourceFactId = (kind, value) => `source-fact-${digest({ kind, value: normalizeText(value) }).slice(0, 24)}`;

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeText(value) {
  return String(value).normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("ru-RU");
}

function unsafeMaterialOrModelValue(value) {
  const normalized = normalizeText(value);
  return UNSAFE_MATERIAL_OR_MODEL_VALUE.test(normalized.replace(/[._\/-]+/gu, " "))
    || UNSAFE_MATERIAL_OR_MODEL_VALUE.test(normalized.replace(/[._\/-]+/gu, ""));
}

function identifier(value) {
  return typeof value === "string" && value === value.trim() && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u.test(value)
    && !/^(?:https?|ftp|file|data):|^www\./iu.test(value);
}

function regionKey(region) {
  return region === null ? "null" : JSON.stringify(canonical(region));
}

function copyRegion(region) {
  return region === null ? null : { x: region.x, y: region.y, width: region.width, height: region.height };
}

function sameRegion(left, right) {
  return regionKey(left) === regionKey(right);
}

function regionOverlaps(left, right) {
  if (left === null || right === null) return true;
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

function intersectionArea(left, right) {
  if (left === null || right === null) return null;
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function substantiallyOverlaps(region, subjectBounds) {
  if (region === null || subjectBounds === null) return true;
  return intersectionArea(region, subjectBounds) / (region.width * region.height) >= 0.5;
}

function unique(values) {
  return [...new Set(values)];
}

function sortedAssessments(rawAssessments) {
  if (!Array.isArray(rawAssessments) || types.isProxy(rawAssessments)) throw failure();
  let assessments;
  try { assessments = rawAssessments.map(verifySourceImageAssessment); } catch { throw failure(); }
  if (new Set(assessments.map(({ sourceAssetId }) => sourceAssetId)).size !== assessments.length
    || new Set(assessments.map(({ sourceOrdinal }) => sourceOrdinal)).size !== assessments.length
    || new Set(assessments.map(({ contractVersion }) => contractVersion)).size > 1) throw failure();
  return assessments.slice().sort((left, right) => left.sourceOrdinal - right.sourceOrdinal
    || compareCodePoints(left.sourceAssetId, right.sourceAssetId));
}

function reconcileInput(raw, withDecisions) {
  const hasDecisions = withDecisions && plain(raw) && Object.hasOwn(raw, "decisions");
  const hasDerivativeBindings = hasDecisions && Object.hasOwn(raw, "acceptedDerivativeBindings");
  const keys = hasDerivativeBindings ? RECONCILE_DERIVATIVE_KEYS : hasDecisions ? RECONCILE_KEYS : FACT_KEYS;
  const input = exact(raw, keys);
  let snapshot;
  try { snapshot = verifyAutoListingSourceSnapshot(input.sourceCapture).snapshot; } catch { throw failure(); }
  const assessments = sortedAssessments(input.assessments);
  const contractVersion = assessments[0]?.contractVersion || SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION;
  if (hasDerivativeBindings && contractVersion !== SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2) throw failure();
  const acceptedDerivativeBindings = hasDerivativeBindings
    ? validatedDerivativeBindings(input.acceptedDerivativeBindings, assessments) : [];
  return {
    snapshot,
    assessments,
    decisions: hasDecisions ? input.decisions : [],
    acceptedDerivativeBindings,
  };
}

function validatedDerivativeBindings(rawBindings, assessments) {
  if (!Array.isArray(rawBindings) || types.isProxy(rawBindings)) throw failure();
  const assetIds = new Set(assessments.map(({ sourceAssetId }) => sourceAssetId));
  const seen = new Set();
  return rawBindings.map((rawBinding) => {
    const binding = exact(rawBinding, DERIVATIVE_BINDING_KEYS);
    if (!identifier(binding.sourceAssetId) || !assetIds.has(binding.sourceAssetId)
      || seen.has(binding.sourceAssetId) || binding.mode !== "CLEANED"
      || !HASH.test(binding.effectiveContentHash || "")
      || !identifier(binding.derivativeAttemptId) || !HASH.test(binding.cleanupEvidenceHash || "")) throw failure();
    seen.add(binding.sourceAssetId);
    return { ...binding };
  });
}

function structuredFacts(snapshot) {
  const facts = [];
  const add = (kind, value) => {
    if (typeof kind !== "string" || !/^[A-Z][A-Z0-9_]{0,119}$/u.test(kind)
      || !["string", "number", "boolean"].includes(typeof value) || !String(value).trim()) return;
    facts.push({ kind, value: String(value).trim() });
  };
  if (snapshot.identity.brand) add("BRAND", snapshot.identity.brand);
  for (const entry of snapshot.attributes) {
    if (!plain(entry)) continue;
    const kind = typeof entry.kind === "string" ? entry.kind.trim().toUpperCase().replace(/[^A-Z0-9]+/gu, "_") : "";
    const value = entry.value ?? entry.values?.[0]?.value ?? entry.values?.[0];
    add(kind, value);
  }
  for (const [kind, value] of Object.entries(snapshot.productMeasurements)) {
    add(`PRODUCT_${kind.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}`, value);
  }
  for (const [kind, value] of Object.entries(snapshot.logistics)) {
    add(`LOGISTICS_${kind.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}`, value);
  }
  const seen = new Set();
  return facts.filter(({ kind, value }) => {
    const key = `${kind}\u0000${normalizeText(value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function prohibitedClaim(text) {
  return /(?:^|[^\p{L}\p{N}])(?:price|цена|скидк\p{L}*|акци\p{L}*|распродаж\p{L}*|промокод|sale|sold|продано|продаж\p{L}*|ranked|ranking|рейтинг|best seller)(?:$|[^\p{L}\p{N}])/iu.test(text)
    || /(?:offer valid|sale ends|limited time|предложение действительно|акция действует|лучше чем|better than|аналог|совместим\p{L}* с|compatible with|лечит\p{L}*|лечение|cures?|medical claim|безопасн\p{L}*|safe for|child-safe)/iu.test(text)
    || /[₽$€]|(?:^|[^\p{L}\p{N}])\d{1,3}\s*%|(?:https?:\/\/|www\.)|(?:^|[^\p{L}\p{N}])[\p{L}\p{N}-]+\.(?:ru|com|net|org|shop|market)(?:$|[^\p{L}\p{N}])|\+?\d[\d\s()\-]{8,}\d|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}|(?:^|[^\p{L}\p{N}])(?:qr|телефон|whatsapp|telegram|контакт)(?:$|[^\p{L}\p{N}])/iu.test(text);
}

function parseClosedFact(text, frozenFacts) {
  const trimmed = String(text).trim();
  let match;
  if ((match = /^(?:(?:количество|quantity|package quantity)\s*[:\-]\s*)?(\d+)\s*(?:шт(?:ук(?:а|и)?)?|pieces?|pcs?)\.?$/iu.exec(trimmed))) {
    return { kind: "PACKAGE_QUANTITY", canonicalValue: normalizeText(match[1]), displayValue: trimmed, highRisk: false };
  }
  if ((match = /^(?:материал|material)\s*[:\-]\s*([^:;]+)$/iu.exec(trimmed))) {
    const canonicalValue = normalizeText(match[1]);
    const frozenMaterial = frozenFacts.some(({ kind, value }) => kind === "MATERIAL"
      && normalizeText(value) === canonicalValue);
    const safeSingleValue = /^[\p{L}\p{N}.]+$/u.test(match[1].trim())
      && !unsafeMaterialOrModelValue(canonicalValue);
    if (frozenMaterial || safeSingleValue) {
      return { kind: "MATERIAL", canonicalValue, displayValue: trimmed, highRisk: false };
    }
  }
  if ((match = /^(?:модель|model)\s*[:#]\s*([\p{L}\p{N}._\/-]+)$/iu.exec(trimmed))) {
    const canonicalValue = normalizeText(match[1]);
    const frozenModel = frozenFacts.some(({ kind, value }) => kind === "MODEL"
      && normalizeText(value) === canonicalValue);
    const safeSingleValue = !match[1].includes("/")
      && !unsafeMaterialOrModelValue(canonicalValue);
    if (frozenModel || safeSingleValue) {
      return { kind: "MODEL", canonicalValue, displayValue: trimmed, highRisk: false };
    }
  }
  if (/^model[-_][\p{L}\p{N}._\/-]+$/iu.test(trimmed)) {
    const canonicalValue = normalizeText(trimmed);
    const frozenModel = frozenFacts.some(({ kind, value }) => kind === "MODEL"
      && normalizeText(value) === canonicalValue);
    if (frozenModel || (!trimmed.includes("/")
      && !unsafeMaterialOrModelValue(canonicalValue))) {
      return { kind: "MODEL", canonicalValue, displayValue: trimmed, highRisk: false };
    }
  }
  if ((match = /^(?:размер(?:ы)?|dimensions?|size)\s*[:\-]\s*(\d+(?:[.,]\d+)?(?:\s*[x×х]\s*\d+(?:[.,]\d+)?){1,2}\s*(?:мм|см|м|mm|cm|m)?)$/iu.exec(trimmed))) {
    return { kind: "DIMENSIONS", canonicalValue: normalizeText(match[1]), displayValue: trimmed, highRisk: false };
  }
  if ((match = /^(?:(?:сертификат|сертификация|certification|certified)\s*[:\-]?\s*)?(CE|EAC|ROHS|FDA)$/iu.exec(trimmed))) {
    return { kind: "CERTIFICATION", canonicalValue: normalizeText(match[1]), displayValue: trimmed, highRisk: true };
  }
  if ((match = /^(?:гарантия|warranty)\s*[:\-]?\s*(.+)$/iu.exec(trimmed))
    || (match = /^(.+)\s+(?:year warranty|лет гарантии)$/iu.exec(trimmed))) {
    return { kind: "WARRANTY", canonicalValue: normalizeText(match[1]), displayValue: trimmed, highRisk: true };
  }
  const brand = frozenFacts.find(({ kind, value }) => kind === "BRAND" && normalizeText(value) === normalizeText(trimmed));
  if (brand) return { kind: "BRAND", canonicalValue: normalizeText(brand.value), displayValue: trimmed, highRisk: false };
  return { kind: "OBSERVED_TEXT", canonicalValue: normalizeText(trimmed), displayValue: trimmed, highRisk: false };
}

function evidenceComponents(assessments) {
  const parent = new Map();
  const ensure = (assetId) => { if (!parent.has(assetId)) parent.set(assetId, assetId); };
  const find = (assetId) => {
    ensure(assetId);
    let root = assetId;
    while (parent.get(root) !== root) root = parent.get(root);
    let current = assetId;
    while (parent.get(current) !== current) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left); const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort(compareCodePoints);
    parent.set(second, first);
  };
  const byPerceptualGroup = new Map();
  for (const assessment of assessments) {
    ensure(assessment.sourceAssetId);
    if (assessment.duplicateOfSourceAssetId) union(assessment.sourceAssetId, assessment.duplicateOfSourceAssetId);
    if (assessment.perceptualDuplicateGroup) {
      const representative = byPerceptualGroup.get(assessment.perceptualDuplicateGroup);
      if (representative) union(assessment.sourceAssetId, representative);
      else byPerceptualGroup.set(assessment.perceptualDuplicateGroup, assessment.sourceAssetId);
    }
  }
  return new Map(assessments.map(({ sourceAssetId }) => [sourceAssetId, find(sourceAssetId)]));
}

function sourceEvidenceKey(assessment, components) {
  return `component:${components.get(assessment.sourceAssetId) || assessment.sourceAssetId}`;
}

function semanticResolutionByText(assessments, components) {
  const groups = new Map();
  for (const assessment of assessments) {
    if (assessment.contractVersion !== SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2) continue;
    const evidenceKey = sourceEvidenceKey(assessment, components);
    for (const semantic of assessment.semanticTextRegions) {
      const key = normalizeText(semantic.sourceText);
      const group = groups.get(key) || [];
      group.push({ semantic, evidenceKey });
      groups.set(key, group);
    }
  }
  const resolutions = new Map();
  for (const [key, entries] of groups) {
    const confirmed = entries.filter(({ semantic }) => semantic.confidence === "CONFIRMED");
    const rankedEntries = confirmed.length > 0 ? confirmed : entries;
    const evidenceByKind = new Map();
    for (const { semantic, evidenceKey } of rankedEntries) {
      const evidence = evidenceByKind.get(semantic.semanticKind) || new Set();
      evidence.add(evidenceKey);
      evidenceByKind.set(semantic.semanticKind, evidence);
    }
    const rankedKinds = [...evidenceByKind].map(([kind, evidence]) => ({ kind, count: evidence.size }))
      .sort((left, right) => right.count - left.count || compareCodePoints(left.kind, right.kind));
    const classificationConflict = rankedKinds.length > 1
      && (rankedKinds.some(({ kind }) => HARD_UNSAFE_SEMANTIC_KINDS.has(kind))
        || rankedKinds[0].count === rankedKinds[1].count);
    const semanticKind = classificationConflict ? "OTHER" : rankedKinds[0].kind;
    const meaningEntries = classificationConflict
      ? entries
      : entries.filter(({ semantic }) => semantic.semanticKind === semanticKind);
    const meaningEvidence = new Map();
    for (const { semantic, evidenceKey } of meaningEntries) {
      const normalizedMeaning = classificationConflict ? semantic.sourceText : semantic.normalizedMeaning;
      const evidence = meaningEvidence.get(normalizedMeaning) || new Set();
      evidence.add(evidenceKey);
      meaningEvidence.set(normalizedMeaning, evidence);
    }
    const normalizedMeaning = [...meaningEvidence].map(([value, evidence]) => ({ value, count: evidence.size }))
      .sort((left, right) => right.count - left.count || compareCodePoints(left.value, right.value))[0].value;
    const stepSequences = meaningEntries.map(({ semantic }) => semantic.sequence).filter(Number.isSafeInteger);
    resolutions.set(key, {
      semanticKind,
      normalizedMeaning,
      sequence: semanticKind === "USAGE_STEP" ? Math.min(...stepSequences) : null,
      classificationConflict,
      majorityApplied: !classificationConflict && rankedKinds.length > 1,
    });
  }
  return resolutions;
}

function effectiveMarkingDispositionForRegion(markingDecisions, sourceAssetId, region) {
  const assetDecisions = markingDecisions.filter((decision) => decision.sourceAssetId === sourceAssetId);
  const manual = assetDecisions.find(({ decisionMethod }) => decisionMethod === "MANUAL_DECISION");
  if (manual && manual.kind !== "PRODUCT_MARKING") return "BLOCKED";
  if (region === null) return null;
  const covering = assetDecisions.filter((decision) => decision.regions.some((candidate) => candidate !== null
    && intersectionArea(candidate, region) / (region.width * region.height) >= 0.8));
  if (covering.length === 0) return null;
  return covering.every(({ kind }) => kind === "PRODUCT_MARKING") ? "PRODUCT_MARKING" : "BLOCKED";
}

function factsFor(snapshot, assessments, markingDecisions) {
  const frozenFacts = structuredFacts(snapshot);
  const components = evidenceComponents(assessments);
  const semanticResolutions = semanticResolutionByText(assessments, components);
  const observed = [];
  for (const assessment of assessments) {
    if (assessment.contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2) {
      for (const semantic of assessment.semanticTextRegions) {
        const resolution = semanticResolutions.get(normalizeText(semantic.sourceText));
        const semanticKind = resolution?.semanticKind || semantic.semanticKind;
        const normalizedMeaning = resolution?.normalizedMeaning || semantic.normalizedMeaning;
        const source = {
          sourceAssetId: assessment.sourceAssetId,
          region: copyRegion(semantic.region),
          sourceText: semantic.sourceText,
          semanticKind,
          sequence: semanticKind === "USAGE_STEP" ? resolution?.sequence ?? semantic.sequence : null,
        };
        const parsed = parseClosedFact(semantic.sourceText, frozenFacts);
        const frozenMatch = frozenFacts.find(({ kind, value }) => kind === parsed.kind
          && normalizeText(value) === parsed.canonicalValue);
        const evidenceKey = sourceEvidenceKey(assessment, components);
        if (resolution?.classificationConflict) {
          observed.push({
            kind: "FORBIDDEN_TEXT", value: semantic.sourceText, source, evidenceKey,
            canonicalValue: normalizeText(semantic.sourceText), method: "REJECTED_FORBIDDEN_TEXT",
            confirmed: false, eligibleForRepeat: false, reason: "SOURCE_FACT_SEMANTIC_CLASSIFICATION_CONFLICT",
          });
          continue;
        }
        const classificationReason = resolution?.majorityApplied
          ? "SOURCE_FACT_SEMANTIC_CLASSIFICATION_MAJORITY" : null;
        if (REJECTED_SEMANTIC_KINDS.has(semanticKind) || prohibitedClaim(semantic.sourceText)
          || (parsed.highRisk && !frozenMatch)) {
          observed.push({
            kind: "FORBIDDEN_TEXT", value: semantic.sourceText, source, evidenceKey,
            canonicalValue: normalizeText(semantic.sourceText), method: "REJECTED_FORBIDDEN_TEXT",
            confirmed: false, eligibleForRepeat: false, reason: "SOURCE_FACT_FORBIDDEN_TEXT_REJECTED",
            classificationReason,
          });
          continue;
        }
        const semanticFactKind = SEMANTIC_FACT_KIND[semanticKind];
        if (semantic.confidence !== "CONFIRMED") {
          observed.push({
            kind: semanticFactKind || parsed.kind, value: normalizedMeaning,
            canonicalValue: normalizeText(normalizedMeaning), source, evidenceKey,
            eligibleForRepeat: false, method: "UNCONFIRMED_OCR", confirmed: false,
            reason: "SOURCE_FACT_OCR_NOT_CONFIRMED",
            classificationReason,
          });
          continue;
        }
        if (frozenMatch) {
          observed.push({
            ...frozenMatch, canonicalValue: parsed.canonicalValue, source, evidenceKey,
            method: "STRUCTURED_FACT_MATCH", confirmed: true, eligibleForRepeat: false,
            reason: "SOURCE_FACT_STRUCTURED_MATCH",
            classificationReason,
          });
          continue;
        }
        if (semanticFactKind) {
          observed.push({
            kind: semanticFactKind, value: normalizedMeaning,
            canonicalValue: normalizeText(normalizedMeaning), source, evidenceKey,
            method: "SOURCE_TEXT_EXPLICIT_LOW_RISK", confirmed: true, explicitLowRisk: true,
            reason: "SOURCE_FACT_EXPLICIT_LOW_RISK_TEXT",
            classificationReason,
          });
          continue;
        }
        observed.push({
          kind: parsed.kind, value: normalizedMeaning,
          canonicalValue: normalizeText(normalizedMeaning), source, evidenceKey,
          eligibleForRepeat: false, method: "INSUFFICIENT_INDEPENDENT_EVIDENCE", confirmed: false,
          reason: "SOURCE_FACT_INSUFFICIENT_INDEPENDENT_EVIDENCE",
          classificationReason,
        });
      }
      continue;
    }
    for (const ocr of assessment.ocrRegions) {
      const source = { sourceAssetId: assessment.sourceAssetId, region: copyRegion(ocr.region) };
      const parsed = parseClosedFact(ocr.text, frozenFacts);
      const frozenMatch = frozenFacts.find(({ kind, value }) => kind === parsed.kind
        && normalizeText(value) === parsed.canonicalValue);
      const markingDisposition = effectiveMarkingDispositionForRegion(
        markingDecisions, assessment.sourceAssetId, ocr.region,
      );
      if (prohibitedClaim(ocr.text) || (parsed.highRisk && !frozenMatch)) {
        observed.push({ kind: "FORBIDDEN_TEXT", value: ocr.text, source, evidenceKey: sourceEvidenceKey(assessment, components),
          canonicalValue: normalizeText(ocr.text), method: "REJECTED_FORBIDDEN_TEXT", confirmed: false,
          reason: "SOURCE_FACT_FORBIDDEN_TEXT_REJECTED" });
        continue;
      }
      if (ocr.confidence !== "CONFIRMED") {
        observed.push({ kind: parsed.kind, value: parsed.displayValue, canonicalValue: parsed.canonicalValue,
          source, evidenceKey: sourceEvidenceKey(assessment, components), eligibleForRepeat: false,
          method: "UNCONFIRMED_OCR", confirmed: false, reason: "SOURCE_FACT_OCR_NOT_CONFIRMED" });
        continue;
      }
      if (markingDisposition === "BLOCKED") {
        observed.push({ kind: parsed.kind, value: parsed.displayValue, canonicalValue: parsed.canonicalValue,
          source, evidenceKey: sourceEvidenceKey(assessment, components), eligibleForRepeat: false,
          method: "INSUFFICIENT_INDEPENDENT_EVIDENCE", confirmed: false,
          reason: "SOURCE_FACT_MARKING_DISPOSITION_REJECTED" });
        continue;
      }
      if (frozenMatch) {
        observed.push({ ...frozenMatch, canonicalValue: parsed.canonicalValue, source,
          evidenceKey: sourceEvidenceKey(assessment, components), method: "STRUCTURED_FACT_MATCH", confirmed: true,
          reason: "SOURCE_FACT_STRUCTURED_MATCH" });
        continue;
      }
      const productOrPackageMarking = markingDisposition === "PRODUCT_MARKING";
      const typed = parsed.kind !== "OBSERVED_TEXT";
      observed.push({ kind: parsed.kind, value: parsed.displayValue, canonicalValue: parsed.canonicalValue,
        source, evidenceKey: sourceEvidenceKey(assessment, components),
        method: productOrPackageMarking && typed ? "PRODUCT_OR_PACKAGE_MARKING" : null,
        confirmed: productOrPackageMarking && typed, reason: productOrPackageMarking && typed
          ? "SOURCE_FACT_PRODUCT_OR_PACKAGE_MARKING" : "SOURCE_FACT_INSUFFICIENT_INDEPENDENT_EVIDENCE" });
    }
  }

  const groups = new Map();
  for (const entry of observed) {
    const key = `${entry.kind}\u0000${entry.canonicalValue}`;
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  }
  const candidates = [];
  for (const group of groups.values()) {
    const first = group[0];
    const sources = [];
    const sourceKeys = new Set();
    for (const entry of group) {
      const key = `${entry.source.sourceAssetId}\u0000${regionKey(entry.source.region)}`;
      if (!sourceKeys.has(key)) { sourceKeys.add(key); sources.push(entry.source); }
    }
    const evidenceCount = new Set(group.filter(({ eligibleForRepeat }) => eligibleForRepeat !== false)
      .map(({ evidenceKey }) => evidenceKey)).size;
    const direct = group.find(({ confirmed }) => confirmed);
    const confirmed = direct || (first.kind !== "OBSERVED_TEXT" && evidenceCount >= 2
      && first.method !== "REJECTED_FORBIDDEN_TEXT");
    const repeatedExplicitMeaning = evidenceCount >= 2 && group.some(({ explicitLowRisk }) => explicitLowRisk);
    const method = repeatedExplicitMeaning ? "INDEPENDENT_IMAGE_REPEAT"
      : direct?.method || (confirmed ? "INDEPENDENT_IMAGE_REPEAT" : first.method || "INSUFFICIENT_INDEPENDENT_EVIDENCE");
    candidates.push({
      sourceFactId: sourceFactId(first.kind, first.value), kind: first.kind, value: first.value,
      status: confirmed ? "CONFIRMED" : "REJECTED", sources,
      confirmationMethod: method,
      reasonCodes: unique(group.flatMap(({ reason, classificationReason }) => [reason, classificationReason].filter(Boolean))
        .concat(confirmed && !direct ? ["SOURCE_FACT_INDEPENDENT_IMAGE_REPEAT"] : [])),
    });
  }

  const confirmedByKind = new Map();
  for (const candidate of candidates.filter(({ status }) => status === "CONFIRMED")) {
    const values = confirmedByKind.get(candidate.kind) || new Set();
    values.add(normalizeText(candidate.value));
    confirmedByKind.set(candidate.kind, values);
  }
  for (const candidate of candidates) {
    if (!COLLECTION_FACT_KINDS.has(candidate.kind) && (confirmedByKind.get(candidate.kind)?.size || 0) > 1) {
      candidate.status = "REJECTED";
      candidate.confirmationMethod = "CONFLICTING_EVIDENCE";
      candidate.reasonCodes = unique([...candidate.reasonCodes, "SOURCE_FACT_CONFLICTING_EVIDENCE"]);
    }
  }
  const sequenceOf = (candidate) => Math.min(...candidate.sources
    .map(({ sequence }) => sequence).filter(Number.isSafeInteger), Number.MAX_SAFE_INTEGER);
  return candidates.sort((left, right) => compareCodePoints(left.kind, right.kind)
    || (left.kind === "IMAGE_USAGE_STEP" ? sequenceOf(left) - sequenceOf(right) : 0)
    || compareCodePoints(normalizeText(left.value), normalizeText(right.value)));
}

function manualDecisionMap(rawDecisions, assessments) {
  if (!Array.isArray(rawDecisions) || types.isProxy(rawDecisions)) throw failure();
  const assetIds = new Set(assessments.map(({ sourceAssetId }) => sourceAssetId));
  const output = new Map();
  for (const rawDecision of rawDecisions) {
    const decision = exact(rawDecision, DECISION_KEYS);
    if (!identifier(decision.sourceAssetId) || !assetIds.has(decision.sourceAssetId)
      || !MANUAL_DECISIONS.has(decision.decision) || !HASH.test(decision.decisionHash || "")
      || output.has(decision.sourceAssetId)) throw failure();
    output.set(decision.sourceAssetId, decision.decision);
  }
  return output;
}

function repeatedPhysicalRegions(assessments, manual) {
  const components = evidenceComponents(assessments);
  const eligible = [];
  for (const assessment of assessments) {
    const override = manual.get(assessment.sourceAssetId);
    if (override && override !== "PRODUCT_MARKING") continue;
    const candidates = assessment.markings.filter((marking) => marking.kind === "UNCERTAIN_MARKING"
      && marking.reasonCodes.includes("SAME_PHYSICAL_LOCATION"));
    if (candidates.length === 1) eligible.push({ assessment, evidenceKey: sourceEvidenceKey(assessment, components) });
  }
  if (new Set(eligible.map(({ evidenceKey }) => evidenceKey)).size < 2) return new Set();
  return new Set(eligible.map(({ assessment }) => assessment.sourceAssetId));
}

function observedMarkingDecisions(assessments, manual) {
  const repeatedAssets = repeatedPhysicalRegions(assessments, manual);
  const output = [];
  for (const assessment of assessments) {
    const override = manual.get(assessment.sourceAssetId);
    if (override && override !== "PRODUCT_MARKING") {
      output.push({
        sourceAssetId: assessment.sourceAssetId,
        kind: "EXTERNAL_OVERLAY",
        regions: unique(assessment.markings.map(({ region }) => regionKey(region))).map((key) => key === "null"
          ? null : JSON.parse(key)),
        decisionMethod: "MANUAL_DECISION",
        reasonCodes: ["EXTERNAL_OVERLAY_ASSET_EXCLUDED"],
      });
      continue;
    }
    const grouped = new Map();
    const add = (kind, region, method, reason) => {
      const key = `${kind}\u0000${method}`;
      const group = grouped.get(key) || { sourceAssetId: assessment.sourceAssetId, kind, regions: [],
        decisionMethod: method, reasonCodes: [] };
      if (!group.regions.some((candidate) => sameRegion(candidate, region))) group.regions.push(copyRegion(region));
      if (!group.reasonCodes.includes(reason)) group.reasonCodes.push(reason);
      grouped.set(key, group);
    };
    for (const marking of assessment.markings) {
      if (marking.confidence === "CONFIRMED" && (marking.kind === "EXTERNAL_OVERLAY"
        || marking.reasonCodes.includes("FIXED_CANVAS_POSITION")
        || (assessment.subjectBounds !== null && marking.region !== null && !regionOverlaps(marking.region, assessment.subjectBounds)))) {
        add("EXTERNAL_OVERLAY", marking.region, "BACKGROUND_CANVAS_OVERLAY", "EXTERNAL_OVERLAY_ASSET_EXCLUDED");
      } else if (marking.kind === "PRODUCT_MARKING" && marking.confidence === "CONFIRMED") {
        add("PRODUCT_MARKING", marking.region, "OBSERVED_PRODUCT_MARKING", "PRODUCT_MARKING_PROTECTED");
      } else if (override === "PRODUCT_MARKING") {
        add("PRODUCT_MARKING", marking.region, "MANUAL_DECISION", "PRODUCT_MARKING_PROTECTED");
      } else if (marking.kind === "PRODUCT_MARKING") {
        add("PRODUCT_MARKING", marking.region, "OBSERVED_PRODUCT_MARKING", "PRODUCT_MARKING_PROTECTED");
      } else if (repeatedAssets.has(assessment.sourceAssetId) && marking.kind === "UNCERTAIN_MARKING"
        && marking.reasonCodes.includes("SAME_PHYSICAL_LOCATION")) {
        add("PRODUCT_MARKING", marking.region, "REPEATED_PHYSICAL_LOCATION", "PRODUCT_MARKING_REPEATED_PHYSICAL_LOCATION");
      } else {
        add("UNCERTAIN_MARKING", marking.region, "UNCERTAIN", "UNCERTAIN_MARKING_EXCLUDED");
      }
    }
    output.push(...grouped.values());
  }
  const order = new Map(assessments.map((assessment, index) => [assessment.sourceAssetId, index]));
  const kindOrder = { PRODUCT_MARKING: 0, EXTERNAL_OVERLAY: 1, UNCERTAIN_MARKING: 2 };
  return output.sort((left, right) => order.get(left.sourceAssetId) - order.get(right.sourceAssetId)
    || kindOrder[left.kind] - kindOrder[right.kind]);
}

function symmetryClass(snapshot, assessments) {
  const declared = structuredFacts(snapshot).find(({ kind }) => kind === "SYMMETRY_CLASS")?.value;
  if (["ROTATIONAL", "BILATERAL", "SPHERICAL"].includes(declared)) return declared;
  const reasons = assessments.flatMap((assessment) => [assessment.reasonCodes,
    ...assessment.viewpoints.map((viewpoint) => viewpoint.reasonCodes)]).flat();
  if (reasons.includes("ROTATIONAL_SYMMETRY_CONFIRMED")) return "ROTATIONAL";
  if (reasons.includes("SPHERICAL_SYMMETRY_CONFIRMED")) return "SPHERICAL";
  if (reasons.includes("BILATERAL_SYMMETRY_CONFIRMED")) return "BILATERAL";
  return "ASYMMETRIC";
}

function viewpointFamilies(viewpoint) {
  if (viewpoint === "FRONT_LEFT_3_4") return ["FRONT", "LEFT"];
  if (viewpoint === "FRONT_RIGHT_3_4") return ["FRONT", "RIGHT"];
  if (viewpoint === "BACK_LEFT_3_4") return ["BACK", "LEFT"];
  if (viewpoint === "BACK_RIGHT_3_4") return ["BACK", "RIGHT"];
  return FAMILY_ORDER.includes(viewpoint) ? [viewpoint] : [];
}

function appearanceCandidate(assessment) {
  const pureText = assessment.contentKinds.includes("TEXT_ONLY")
    && !assessment.contentKinds.some((kind) => APPEARANCE_KINDS.has(kind));
  const confirmedView = assessment.viewpoints.some(({ kind, confidence }) => confidence === "CONFIRMED"
    && viewpointFamilies(kind).length > 0);
  return !pureText && assessment.quality?.usable !== false && !assessment.eligibleUses.includes("UNUSABLE")
    && assessment.contentKinds.some((kind) => APPEARANCE_KINDS.has(kind))
    && assessment.eligibleUses.some((use) => APPEARANCE_USES.has(use)) && confirmedView;
}

function coverageViewpoints(assessment) {
  const frontFacingDetail = assessment.quality?.usable === true
    && assessment.contentKinds.includes("PRODUCT_VIEW")
    && assessment.eligibleUses.includes("IDENTITY_ANCHOR")
    && assessment.eligibleUses.includes("TARGET_VIEW")
    && assessment.viewpoints.some(({ kind, confidence, reasonCodes }) => kind === "DETAIL"
      && confidence === "CONFIRMED" && reasonCodes.includes("FRONT_FACING_PRODUCT"));
  if (!frontFacingDetail || assessment.viewpoints.some(({ kind, confidence }) =>
    confidence === "CONFIRMED" && COMPLETE_FAMILIES.includes(kind))) return assessment.viewpoints;
  return [...assessment.viewpoints, { kind: "FRONT", confidence: "CONFIRMED" }];
}

function coverageFor(assessments, eligibleAssetIds, symmetry) {
  const eligible = new Set(eligibleAssetIds);
  const assessmentByAssetId = new Map(assessments.map((assessment) => [
    assessment.sourceAssetId,
    assessment,
  ]));
  const detailCompositionRank = (assetId) => {
    const assessment = assessmentByAssetId.get(assetId);
    return assessment?.viewpoints.some(({ kind, confidence, reasonCodes }) => kind === "DETAIL"
      && confidence === "CONFIRMED" && reasonCodes.includes("COMPLETE_PRODUCT_VISIBLE")) ? 0 : 1;
  };
  const confirmed = new Map();
  const tentative = new Map();
  for (const assessment of assessments) {
    for (const viewpoint of coverageViewpoints(assessment)) {
      for (const family of viewpointFamilies(viewpoint.kind)) {
        const horizontal = ["FRONT", "BACK", "LEFT", "RIGHT"].includes(family);
        const targetFamily = symmetry === "ROTATIONAL" && horizontal ? "ROTATIONAL" : family;
        if (viewpoint.confidence === "CONFIRMED" && eligible.has(assessment.sourceAssetId)) {
          const group = confirmed.get(targetFamily) || { assetIds: [], preciseViewpoints: [], tentativeAssetIds: [] };
          if (!group.assetIds.includes(assessment.sourceAssetId)) group.assetIds.push(assessment.sourceAssetId);
          if (!group.preciseViewpoints.includes(viewpoint.kind)) group.preciseViewpoints.push(viewpoint.kind);
          confirmed.set(targetFamily, group);
        } else if (viewpoint.confidence === "TENTATIVE") {
          const group = tentative.get(targetFamily) || [];
          if (!group.includes(assessment.sourceAssetId)) group.push(assessment.sourceAssetId);
          tentative.set(targetFamily, group);
        }
      }
    }
  }
  const coverageMap = {};
  const order = symmetry === "ROTATIONAL"
    ? ["ROTATIONAL", "TOP", "BOTTOM", "INTERIOR", "DETAIL", "SCENE", "PACKAGE"] : FAMILY_ORDER;
  for (const family of order) {
    const entry = confirmed.get(family);
    if (!entry) continue;
    if (family === "DETAIL") {
      entry.assetIds.sort((left, right) => detailCompositionRank(left) - detailCompositionRank(right)
        || assessmentByAssetId.get(left).sourceOrdinal - assessmentByAssetId.get(right).sourceOrdinal);
    }
    entry.tentativeAssetIds = tentative.get(family) || [];
    coverageMap[family] = entry;
  }
  const confirmedFamilies = [...confirmed.keys()].filter((family) => COMPLETE_FAMILIES.includes(family) || family === "ROTATIONAL");
  const prohibitedViews = symmetry === "ROTATIONAL"
    ? COMPLETE_FAMILIES.filter((view) => ["FRONT", "BACK", "LEFT", "RIGHT"].includes(view)
      ? view !== "FRONT" || !confirmed.has("ROTATIONAL")
      : !confirmed.has(view))
    : COMPLETE_FAMILIES.filter((family) => !confirmed.has(family));
  coverageMap.COMPLETE_PRODUCT = {
    confirmedFamilyCount: confirmedFamilies.length,
    confirmedFamilies,
    requiredFamilyCount: Math.min(confirmedFamilies.length, 3),
    prohibitedViews,
  };
  return coverageMap;
}

function buildSummary(snapshot, assessments, decisions, acceptedDerivativeBindings) {
  const manual = manualDecisionMap(decisions, assessments);
  const markingDecisions = observedMarkingDecisions(assessments, manual);
  const contractVersion = assessments[0]?.contractVersion || SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION;
  const cleanupByAssetId = new Map(acceptedDerivativeBindings.map((binding) => [binding.sourceAssetId, binding]));
  const unsafeByAssetId = new Map();
  for (const decision of markingDecisions.filter(({ kind }) => kind !== "PRODUCT_MARKING")) {
    const values = unsafeByAssetId.get(decision.sourceAssetId) || [];
    values.push(decision);
    unsafeByAssetId.set(decision.sourceAssetId, values);
  }
  for (const binding of acceptedDerivativeBindings) {
    const unsafe = unsafeByAssetId.get(binding.sourceAssetId) || [];
    if (!unsafe.some(({ kind }) => kind === "EXTERNAL_OVERLAY")) throw failure();
  }
  const appearanceAllowed = (assessment) => {
    const unsafe = unsafeByAssetId.get(assessment.sourceAssetId) || [];
    if (contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2) {
      return unsafe.every(({ kind }) => kind === "EXTERNAL_OVERLAY");
    }
    return unsafe.length === 0 || (cleanupByAssetId.has(assessment.sourceAssetId)
      && unsafe.every(({ kind }) => kind === "EXTERNAL_OVERLAY"));
  };
  const eligibleAssetIds = assessments.filter((assessment) => appearanceCandidate(assessment) && appearanceAllowed(assessment))
    .map(({ sourceAssetId }) => sourceAssetId);
  const eligible = new Set(eligibleAssetIds);
  const excludedAssetIds = assessments.filter((assessment) => !eligible.has(assessment.sourceAssetId))
    .map(({ sourceAssetId }) => sourceAssetId);
  const symmetry = symmetryClass(snapshot, assessments);
  const coverageMap = coverageFor(assessments, eligibleAssetIds, symmetry);
  const candidateAssetsByFamily = new Map();
  for (const assessment of assessments.filter(appearanceCandidate)) {
    for (const viewpoint of assessment.viewpoints.filter(({ confidence }) => confidence === "CONFIRMED")) {
      for (const family of viewpointFamilies(viewpoint.kind).filter((entry) => COMPLETE_FAMILIES.includes(entry))) {
        const key = symmetry === "ROTATIONAL" && ["FRONT", "BACK", "LEFT", "RIGHT"].includes(family)
          ? "ROTATIONAL" : family;
        const assetIds = candidateAssetsByFamily.get(key) || new Set();
        assetIds.add(assessment.sourceAssetId);
        candidateAssetsByFamily.set(key, assetIds);
      }
    }
  }
  const requiredConfirmations = [];
  for (const assessment of assessments) {
    const uncertain = markingDecisions.filter((entry) => entry.sourceAssetId === assessment.sourceAssetId
      && entry.kind === "UNCERTAIN_MARKING");
    if (uncertain.length === 0 || !uncertain.some((entry) => entry.regions
      .some((region) => substantiallyOverlaps(region, assessment.subjectBounds)))) continue;
    const families = unique(assessment.viewpoints.filter(({ confidence }) => confidence === "CONFIRMED")
      .flatMap(({ kind }) => viewpointFamilies(kind)).filter((family) => COMPLETE_FAMILIES.includes(family)));
    const uniqueCriticalView = families.some((family) => {
      const key = symmetry === "ROTATIONAL" && ["FRONT", "BACK", "LEFT", "RIGHT"].includes(family)
        ? "ROTATIONAL" : family;
      return !coverageMap[key] && candidateAssetsByFamily.get(key)?.size === 1;
    });
    if (uniqueCriticalView) requiredConfirmations.push({
      sourceAssetId: assessment.sourceAssetId, kind: "UNCERTAIN_MARKING",
      regions: unique(uncertain.flatMap(({ regions }) => regions).map(regionKey)).map((key) => key === "null" ? null : JSON.parse(key)),
      reasonCodes: ["AUTO_LISTING_SOURCE_IMAGE_UNIQUE_VIEW_MARKING_UNCERTAIN"],
    });
  }
  const reasonCodes = ["AUTO_LISTING_SOURCE_IMAGE_HIDDEN_VIEW_INFERENCE_PROHIBITED"];
  if (assessments.some((assessment) => assessment.contentKinds.includes("TEXT_ONLY"))) {
    reasonCodes.push("AUTO_LISTING_SOURCE_IMAGE_TEXT_ONLY_EXCLUDED");
  }
  if (markingDecisions.some(({ kind }) => kind === "EXTERNAL_OVERLAY")) {
    reasonCodes.push(contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2
      ? "AUTO_LISTING_SOURCE_IMAGE_EXTERNAL_OVERLAY_GUIDANCE_ONLY"
      : "AUTO_LISTING_SOURCE_IMAGE_UNSAFE_OVERLAY_EXCLUDED");
  }
  if (requiredConfirmations.length > 0) reasonCodes.push("AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED");
  if (symmetry === "ROTATIONAL") reasonCodes.push("AUTO_LISTING_SOURCE_IMAGE_ROTATIONAL_SYMMETRY_COLLAPSED");
  const value = {
    contractVersion,
    coverageMap,
    factCandidates: factsFor(snapshot, assessments, markingDecisions),
    markingDecisions,
    eligibleAssetIds,
    excludedAssetIds,
    requiredConfirmations,
    symmetryClass: symmetry,
    reasonCodes,
    ...(contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2 ? {
      appearanceAssetBindings: eligibleAssetIds.map((sourceAssetId) => {
        const assessment = assessments.find((entry) => entry.sourceAssetId === sourceAssetId);
        return cleanupByAssetId.get(sourceAssetId) || {
          sourceAssetId,
          mode: "ORIGINAL",
          effectiveContentHash: assessment.contentHash,
          derivativeAttemptId: null,
          cleanupEvidenceHash: null,
        };
      }),
    } : {}),
  };
  const summary = { ...value, summaryHash: digest(value) };
  try { verifySourceImageIntelligenceSummary(summary); } catch { throw failure(); }
  return freeze(summary);
}

export function confirmSourceImageFacts(raw = {}) {
  const { snapshot, assessments } = reconcileInput(raw, false);
  const markingDecisions = observedMarkingDecisions(assessments, new Map());
  return freeze(factsFor(snapshot, assessments, markingDecisions));
}

export function reconcileSourceImageAssessments(raw = {}) {
  const { snapshot, assessments, decisions, acceptedDerivativeBindings } = reconcileInput(raw, true);
  return buildSummary(snapshot, assessments, decisions, acceptedDerivativeBindings);
}
