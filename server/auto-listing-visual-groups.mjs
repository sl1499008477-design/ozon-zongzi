import crypto from "node:crypto";
import { verifyAutoListingSourceSnapshot } from "./auto-listing-source-snapshot.mjs";

const INPUT_KEYS = new Set(["sourceCapture"]);
const EVIDENCE_KEYS = new Set(["contractVersion", "variantId", "appearanceStatus", "appearanceFacts", "sizeFacts"]);
const FACT_KEYS = new Set(["factId", "kind", "value"]);
const IMAGE_KEYS = new Set(["assetId", "contentHash"]);
const NORMALIZED_IMAGE_KEYS = new Set(["assetId", "sourceRefHash", "contentHash", "sourceRef", "evidenceKind"]);
const APPEARANCE_KINDS = new Set(["COLOR", "PATTERN", "SHAPE", "MATERIAL", "ACCESSORY_COUNT"]);
const SHA256 = /^[a-f0-9]{64}$/;
const OUTPUT_KEYS = new Set(["sourceHash", "groups", "reasonCodes", "visualGroupsHash"]);

function visualError() {
  const error = new Error("商品视觉证据无效");
  error.code = "AUTO_LISTING_VISUAL_EVIDENCE_INVALID";
  return error;
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function exactObject(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

function requiredText(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw visualError();
  return value.trim();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonical(value[key])]));
}

function assertJsonSafe(value, active = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw visualError();
    return;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) throw visualError();
  if (active.has(value)) throw visualError();
  active.add(value);
  try {
    if (Array.isArray(value)) value.forEach((entry) => assertJsonSafe(entry, active));
    else for (const [key, entry] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw visualError();
      assertJsonSafe(entry, active);
    }
  } finally {
    active.delete(value);
  }
}

const canonicalText = (value) => JSON.stringify(canonical(value));
const hash = (value) => crypto.createHash("sha256").update(canonicalText(value)).digest("hex");
const hashText = (value) => crypto.createHash("sha256").update(value).digest("hex");
const compareText = (left, right) => Buffer.from(String(left), "utf8").compare(Buffer.from(String(right), "utf8"));
const compareCanonical = (left, right) => compareText(canonicalText(left), canonicalText(right));

function normalizeFact(value, expectedKinds) {
  if (!exactObject(value, FACT_KEYS)) throw visualError();
  const fact = {
    factId: requiredText(value.factId),
    kind: requiredText(value.kind),
    value: requiredText(value.value),
  };
  if (!expectedKinds.has(fact.kind)) throw visualError();
  return fact;
}

function normalizeFacts(values, expectedKinds) {
  if (!Array.isArray(values)) throw visualError();
  const byId = new Map();
  for (const value of values) {
    const fact = normalizeFact(value, expectedKinds);
    const known = byId.get(fact.factId);
    if (known && canonicalText(known) !== canonicalText(fact)) throw visualError();
    if (known) throw visualError();
    byId.set(fact.factId, fact);
  }
  return [...byId.values()].sort(compareCanonical);
}

function normalizeImages(values) {
  if (!Array.isArray(values)) throw visualError();
  const byId = new Map();
  for (const value of values) {
    if (typeof value === "string") {
      let sourceUrl;
      try { sourceUrl = new URL(value); } catch { throw visualError(); }
      if (!["http:", "https:"].includes(sourceUrl.protocol) || value.length > 8192) throw visualError();
      const sourceRef = sourceUrl.toString();
      const sourceRefHash = hashText(sourceRef);
      const image = {
        assetId: `source-url-${sourceRefHash.slice(0, 24)}`,
        sourceRefHash,
        contentHash: null,
        sourceRef: null,
        evidenceKind: "SOURCE_REF_HASH",
      };
      const known = byId.get(image.assetId);
      if (known && canonicalText(known) !== canonicalText(image)) throw visualError();
      byId.set(image.assetId, image);
      continue;
    }
    if (!exactObject(value, IMAGE_KEYS)) throw visualError();
    const image = {
      assetId: requiredText(value.assetId),
      sourceRefHash: null,
      contentHash: requiredText(value.contentHash),
      sourceRef: null,
      evidenceKind: "CONTENT_HASH",
    };
    if (!SHA256.test(image.contentHash)) throw visualError();
    const known = byId.get(image.assetId);
    if (known && canonicalText(known) !== canonicalText(image)) throw visualError();
    byId.set(image.assetId, image);
  }
  return [...byId.values()];
}

function normalizeEvidence(value, sku) {
  const singleton = (evidenceReason) => ({
    variantId: `source-sku:${sku}`,
    complete: false,
    appearanceFacts: [],
    sizeFacts: [],
    evidenceReason,
  });
  if (value === null || value === undefined) {
    return singleton(null);
  }
  if (!isPlainObject(value) || value.contractVersion !== 1) return singleton("LEGACY_APPEARANCE_EVIDENCE_SINGLETON");
  if (!exactObject(value, EVIDENCE_KEYS) || !["COMPLETE", "AMBIGUOUS"].includes(value.appearanceStatus)) throw visualError();
  const appearanceFacts = normalizeFacts(value.appearanceFacts, APPEARANCE_KINDS);
  const conflictingKinds = new Set();
  const valueByKind = new Map();
  for (const fact of appearanceFacts) {
    const known = valueByKind.get(fact.kind);
    if (known !== undefined && known !== fact.value) conflictingKinds.add(fact.kind);
    valueByKind.set(fact.kind, fact.value);
  }
  const conflicting = value.appearanceStatus === "COMPLETE" && conflictingKinds.size > 0;
  return {
    variantId: requiredText(value.variantId),
    complete: value.appearanceStatus === "COMPLETE" && !conflicting,
    appearanceFacts: conflicting ? [] : appearanceFacts,
    sizeFacts: normalizeFacts(value.sizeFacts, new Set(["SIZE"])),
    evidenceReason: conflicting ? "CONFLICTING_APPEARANCE_EVIDENCE_SINGLETON" : null,
  };
}

function normalizeVariants(snapshot) {
  const seenVariantIds = new Set();
  const variants = snapshot.variants.map((variant) => {
    const sku = requiredText(variant.sku);
    const evidence = normalizeEvidence(variant.evidence, sku);
    if (seenVariantIds.has(evidence.variantId)) throw visualError();
    seenVariantIds.add(evidence.variantId);
    const referenceImages = normalizeImages(variant.media);
    const appearanceSignature = evidence.complete && evidence.appearanceFacts.length
      ? hash(evidence.appearanceFacts.map(({ kind, value }) => ({ kind, value })))
      : null;
    return { sku, ...evidence, referenceImages, appearanceSignature };
  });
  const sourceImagesById = new Map();
  for (const variant of variants) for (const image of variant.referenceImages) {
    const known = sourceImagesById.get(image.assetId);
    if (known && canonicalText(known) !== canonicalText(image)) throw visualError();
    sourceImagesById.set(image.assetId, image);
  }
  return variants;
}

function buildGroups(variants) {
  const buckets = new Map();
  for (const variant of variants) {
    const bucketKey = variant.appearanceSignature
      ? `appearance:${variant.appearanceSignature}`
      : `ambiguous:${variant.variantId}`;
    const bucket = buckets.get(bucketKey) || [];
    bucket.push(variant);
    buckets.set(bucketKey, bucket);
  }

  const completeSignatureCount = new Set(variants.map((variant) => variant.appearanceSignature).filter(Boolean)).size;
  const groups = [];
  for (const [bucketKey, members] of buckets) {
    members.sort((left, right) => compareText(left.variantId, right.variantId) || compareText(left.sku, right.sku));
    const imageById = new Map();
    const factById = new Map();
    for (const member of members) {
      for (const image of member.referenceImages) {
        const known = imageById.get(image.assetId);
        if (known && canonicalText(known) !== canonicalText(image)) throw visualError();
        imageById.set(image.assetId, image);
      }
      for (const fact of [...member.appearanceFacts, ...member.sizeFacts]) {
        const known = factById.get(fact.factId);
        if (known && canonicalText(known) !== canonicalText(fact)) throw visualError();
        factById.set(fact.factId, fact);
      }
    }
    const ambiguous = bucketKey.startsWith("ambiguous:");
    const singletonReason = members.find((member) => member.evidenceReason)?.evidenceReason;
    const reasonCodes = ambiguous
      ? [singletonReason || "AMBIGUOUS_APPEARANCE_SPLIT"]
      : completeSignatureCount > 1
        ? ["VISIBLE_APPEARANCE_DIFFERENCE"]
        : members.length > 1
          ? ["SIZE_ONLY_VARIANTS_SHARED"]
          : ["COMPLETE_APPEARANCE_EVIDENCE"];
    const groupIdentity = {
      appearanceSignature: members[0].appearanceSignature,
      variantIds: members.map((member) => member.variantId),
    };
    groups.push({
      visualGroupKey: `visual-group-${hash(groupIdentity).slice(0, 20)}`,
      sourceSkus: [...new Set(members.map((member) => member.sku))].sort(compareText),
      variantIds: members.map((member) => member.variantId),
      referenceImages: [...imageById.values()],
      factEvidence: [...factById.values()].sort(compareCanonical),
      reasonCodes,
    });
  }
  return groups.sort((left, right) => compareText(left.visualGroupKey, right.visualGroupKey));
}

export function buildVisualGroups(input = {}) {
  if (!exactObject(input, INPUT_KEYS)) throw visualError();
  const verified = verifyAutoListingSourceSnapshot(input.sourceCapture);
  const groups = buildGroups(normalizeVariants(verified.snapshot));
  const result = {
    sourceHash: verified.snapshotHash,
    groups,
    reasonCodes: [...new Set(groups.flatMap((group) => group.reasonCodes))].sort(compareText),
  };
  return Object.freeze({ ...result, visualGroupsHash: hash(result) });
}

export function verifyVisualGroupsCapture(value, expectedSourceHash) {
  if (!exactObject(value, OUTPUT_KEYS)
    || !Array.isArray(value.groups)
    || !Array.isArray(value.reasonCodes)
    || typeof value.sourceHash !== "string"
    || typeof value.visualGroupsHash !== "string"
    || value.sourceHash !== expectedSourceHash) throw visualError();
  assertJsonSafe(value);
  const rebuilt = { sourceHash: value.sourceHash, groups: value.groups, reasonCodes: value.reasonCodes };
  if (!SHA256.test(value.visualGroupsHash) || hash(rebuilt) !== value.visualGroupsHash) throw visualError();
  // Re-run the closed output shape through canonical source-like checks rather than trusting a caller-supplied hash.
  const groupKeys = new Set();
  const evidenceByAssetId = new Map();
  for (const group of value.groups) {
    const keys = new Set(["visualGroupKey", "sourceSkus", "variantIds", "referenceImages", "factEvidence", "reasonCodes"]);
    if (!exactObject(group, keys) || groupKeys.has(group.visualGroupKey)
      || !Array.isArray(group.sourceSkus) || !Array.isArray(group.variantIds)
      || !Array.isArray(group.referenceImages) || !Array.isArray(group.factEvidence)
      || !Array.isArray(group.reasonCodes)) throw visualError();
    groupKeys.add(group.visualGroupKey);
    for (const entry of group.referenceImages) {
      if (!exactObject(entry, NORMALIZED_IMAGE_KEYS)
        || !["CONTENT_HASH", "SOURCE_REF_HASH"].includes(entry.evidenceKind)
        || entry.sourceRef !== null
        || (entry.evidenceKind === "CONTENT_HASH" && (!SHA256.test(entry.contentHash) || !(entry.sourceRefHash === null || SHA256.test(entry.sourceRefHash))))
        || (entry.evidenceKind === "SOURCE_REF_HASH" && (entry.contentHash !== null || !SHA256.test(entry.sourceRefHash)))) throw visualError();
      requiredText(entry.assetId);
      const known = evidenceByAssetId.get(entry.assetId);
      if (known && canonicalText(known) !== canonicalText(entry)) throw visualError();
      evidenceByAssetId.set(entry.assetId, entry);
    }
  }
  return value;
}
