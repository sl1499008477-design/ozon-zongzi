import crypto from "node:crypto";
import { types } from "node:util";

const HASH = /^[0-9a-f]{64}$/u;
const LOOKUP_REF = /^ozon-read:v1:[0-9a-f]{64}$/u;
const MANUAL_CONFIRMATION_REF = /^manual-confirmation:v1:[0-9a-f]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const EVIDENCE_KEYS = Object.freeze([
  "accountId", "collectItemId", "sourceVersion", "productDraftId",
  "productDraftVersion", "ozonProductId", "sourceSku", "taxonomyScope",
  "sourceDescriptionCategoryId", "sourceTypeId", "normalizedPath",
  "attributeSummary", "provenance", "capturedAt", "rawResponseRef",
  "rawResponseHash",
]);
const SELECTION_KEYS = Object.freeze([
  "accountId", "sourceDescriptionCategoryId", "sourceTypeId", "taxonomyScope",
  "currentDescriptionCategoryId", "currentTypeId", "status", "source",
  "taxonomyFingerprint", "version", "evidenceId", "validatedAt",
]);
const PROVENANCE_BASE_KEYS = Object.freeze([
  "accountId", "collectItemId", "sourceKind", "sourceRecordId",
  "rawResponseRef", "rawResponseHash", "capturedAt",
]);
const ENRICHMENT_PROVENANCE_KEYS = Object.freeze([
  ...PROVENANCE_BASE_KEYS, "enrichmentSource", "enrichmentContractVersion",
]);
const LOOKUP_PROVENANCE_KEYS = Object.freeze([
  ...PROVENANCE_BASE_KEYS, "lookupContractVersion", "requestedOzonProductId",
  "requestedSourceSku", "matchedOzonProductId", "matchedSourceSku",
  "triggerProductDraftId", "triggerProductDraftVersion",
]);
const MANUAL_CONFIRMATION_PROVENANCE_KEYS = Object.freeze([
  ...PROVENANCE_BASE_KEYS, "confirmationContractVersion", "triggerProductDraftId",
  "triggerProductDraftVersion", "selectedDescriptionCategoryId", "selectedTypeId",
  "taxonomyScope", "actorId", "correlationId", "idempotencyKey",
]);
const ATTRIBUTE_KEYS = new Set(["key", "value", "dictionaryValueId"]);
const SHARED_STATUSES = new Set(["ACTIVE", "INVALIDATED", "NEEDS_REVIEW"]);
const SHARED_SOURCES = new Set(["SOURCE_DIRECT", "OZON_REFRESH", "MANUAL"]);

function invalid() {
  return Object.assign(new TypeError("Account-shared Ozon category input is invalid"), {
    code: "ACCOUNT_SHARED_ZONGZI_CATEGORY_CONTRACT_INVALID",
  });
}

function assertDataObject(value, allowedKeys, seen) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || seen.has(value)) throw invalid();
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key)
      || !allowedKeys.has(key) || descriptors[key].get || descriptors[key].set
      || descriptors[key].enumerable !== true) throw invalid();
  }
  return descriptors;
}

function assertExactDataObject(value, orderedKeys, seen) {
  const descriptors = assertDataObject(value, new Set(orderedKeys), seen);
  if (Object.keys(descriptors).length !== orderedKeys.length
    || orderedKeys.some((key) => !Object.hasOwn(descriptors, key))) throw invalid();
  return descriptors;
}

function text(value, maximum = 240) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid();
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid();
  return value;
}

function nullableText(value, maximum = 240) {
  return value === null ? null : text(value, maximum);
}

function nullablePositiveInteger(value) {
  return value === null ? null : positiveInteger(value);
}

function isoInstant(value) {
  const timestamp = typeof value === "string" ? new Date(value) : null;
  if (typeof value !== "string" || !ISO_INSTANT.test(value)
    || Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) throw invalid();
  return value;
}

function sha256(value) {
  if (typeof value !== "string" || !HASH.test(value)) throw invalid();
  return value;
}

export function lookupObservationIdentity(input) {
  const seen = new WeakSet();
  const keys = [
    "collectItemId", "triggerProductDraftId", "triggerProductDraftVersion",
    "lookupContractVersion", "requestedOzonProductId", "requestedSourceSku",
    "matchedOzonProductId", "matchedSourceSku", "responseHash",
  ];
  assertExactDataObject(input, keys, seen);
  const values = {
    collectItemId: text(input.collectItemId),
    triggerProductDraftId: text(input.triggerProductDraftId),
    triggerProductDraftVersion: positiveInteger(input.triggerProductDraftVersion),
    lookupContractVersion: text(input.lookupContractVersion, 120),
    requestedOzonProductId: nullablePositiveInteger(input.requestedOzonProductId),
    requestedSourceSku: nullableText(input.requestedSourceSku),
    matchedOzonProductId: positiveInteger(input.matchedOzonProductId),
    matchedSourceSku: text(input.matchedSourceSku),
    responseHash: sha256(input.responseHash),
  };
  if (values.lookupContractVersion !== "account-shared-ozon-category-lookup.v1"
    || (!values.requestedOzonProductId && !values.requestedSourceSku)
    || (values.requestedOzonProductId
      && values.requestedOzonProductId !== values.matchedOzonProductId)
    || (values.requestedSourceSku && values.requestedSourceSku !== values.matchedSourceSku)) {
    throw invalid();
  }
  const observationHash = crypto.createHash("sha256").update(JSON.stringify([
    values.collectItemId,
    values.triggerProductDraftId,
    values.triggerProductDraftVersion,
    values.lookupContractVersion,
    values.requestedOzonProductId,
    values.requestedSourceSku,
    values.matchedOzonProductId,
    values.matchedSourceSku,
    values.responseHash,
  ])).digest("hex");
  const sourceRecordId = `ozon-read:v1:${observationHash}`;
  return Object.freeze({
    sourceRecordId,
    sourceVersion: `lookup:v1:${observationHash}`,
    rawResponseRef: sourceRecordId,
  });
}

export function manualConfirmationObservationIdentity(input) {
  const seen = new WeakSet();
  const keys = [
    "accountId", "collectItemId", "triggerProductDraftId", "triggerProductDraftVersion",
    "selectedDescriptionCategoryId", "selectedTypeId", "taxonomyScope", "actorId",
    "capturedAt", "correlationId", "idempotencyKey", "requestHash",
  ];
  assertExactDataObject(input, keys, seen);
  const values = {
    accountId: text(input.accountId),
    collectItemId: text(input.collectItemId),
    triggerProductDraftId: text(input.triggerProductDraftId),
    triggerProductDraftVersion: positiveInteger(input.triggerProductDraftVersion),
    selectedDescriptionCategoryId: positiveInteger(input.selectedDescriptionCategoryId),
    selectedTypeId: positiveInteger(input.selectedTypeId),
    taxonomyScope: text(input.taxonomyScope, 80),
    actorId: text(input.actorId),
    capturedAt: isoInstant(input.capturedAt),
    correlationId: text(input.correlationId),
    idempotencyKey: text(input.idempotencyKey),
    requestHash: sha256(input.requestHash),
  };
  if (values.taxonomyScope !== "OZON:DEFAULT" || values.actorId !== values.accountId) throw invalid();
  const observationHash = crypto.createHash("sha256").update(JSON.stringify([
    values.accountId, values.collectItemId, values.triggerProductDraftId,
    values.triggerProductDraftVersion, values.selectedDescriptionCategoryId,
    values.selectedTypeId, values.taxonomyScope, values.actorId, values.capturedAt,
    values.correlationId, values.idempotencyKey, values.requestHash,
  ])).digest("hex");
  const sourceRecordId = `manual-confirmation:v1:${observationHash}`;
  return Object.freeze({ sourceRecordId, sourceVersion: sourceRecordId, rawResponseRef: sourceRecordId });
}

function frozenArray(values) {
  return Object.freeze(values);
}

function assertDataArray(value, maximum, seen) {
  if (!Array.isArray(value) || types.isProxy(value) || seen.has(value) || value.length > maximum) {
    throw invalid();
  }
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => {
    if (key === "length") return descriptors[key].get || descriptors[key].set;
    return typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)
      || descriptors[key].get || descriptors[key].set || descriptors[key].enumerable !== true;
  })) throw invalid();
}

function normalizedPath(value, seen) {
  assertDataArray(value, 32, seen);
  return frozenArray(value.map((part) => text(part, 160)));
}

function attributeValue(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid();
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw invalid();
}

function attributeSummary(value, seen) {
  assertDataArray(value, 100, seen);
  return frozenArray(value.map((attribute) => {
    const descriptors = assertDataObject(attribute, ATTRIBUTE_KEYS, seen);
    if (!Object.hasOwn(descriptors, "key") || !Object.hasOwn(descriptors, "value")) throw invalid();
    const projected = {
      key: text(attribute.key, 80),
      value: attributeValue(attribute.value),
    };
    if (Object.hasOwn(descriptors, "dictionaryValueId")) {
      projected.dictionaryValueId = positiveInteger(attribute.dictionaryValueId);
    }
    return Object.freeze(projected);
  }));
}

function evidenceProvenance(value, evidence, seen) {
  const descriptors = assertDataObject(value, new Set([
    ...ENRICHMENT_PROVENANCE_KEYS, ...LOOKUP_PROVENANCE_KEYS,
    ...MANUAL_CONFIRMATION_PROVENANCE_KEYS,
  ]), seen);
  const sourceKind = descriptors.sourceKind?.value;
  const keys = sourceKind === "ENRICHMENT_CACHE"
    ? ENRICHMENT_PROVENANCE_KEYS
    : sourceKind === "OZON_READ_LOOKUP" ? LOOKUP_PROVENANCE_KEYS
      : sourceKind === "MANUAL_CONFIRMATION" ? MANUAL_CONFIRMATION_PROVENANCE_KEYS
        : PROVENANCE_BASE_KEYS;
  if (Object.keys(descriptors).length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key))) throw invalid();
  const projected = {
    accountId: text(value.accountId),
    collectItemId: nullableText(value.collectItemId),
    sourceKind: text(value.sourceKind, 40),
    sourceRecordId: text(value.sourceRecordId),
    rawResponseRef: text(value.rawResponseRef),
    rawResponseHash: sha256(value.rawResponseHash),
    capturedAt: isoInstant(value.capturedAt),
  };
  if (projected.accountId !== evidence.accountId
    || projected.collectItemId !== evidence.collectItemId
    || projected.rawResponseRef !== evidence.rawResponseRef
    || projected.rawResponseHash !== evidence.rawResponseHash
    || projected.capturedAt !== evidence.capturedAt) throw invalid();
  if (projected.sourceKind === "PRODUCT_DRAFT") {
    if (evidence.collectItemId === null || evidence.productDraftId === null
      || evidence.productDraftVersion === null
      || projected.sourceRecordId !== evidence.productDraftId) throw invalid();
  } else if (projected.sourceKind === "ENRICHMENT_CACHE") {
    projected.enrichmentSource = text(value.enrichmentSource, 80);
    projected.enrichmentContractVersion = text(value.enrichmentContractVersion, 120);
    if (evidence.collectItemId !== null || evidence.productDraftId !== null
      || evidence.productDraftVersion !== null || evidence.sourceSku === null
      || projected.sourceRecordId !== `${projected.enrichmentSource}:${evidence.sourceSku}:${projected.enrichmentContractVersion}`
      || projected.rawResponseRef !== `collector_ozon_enrichment_cache:${projected.sourceRecordId}`) throw invalid();
  } else if (projected.sourceKind === "OZON_READ_LOOKUP") {
    projected.lookupContractVersion = text(value.lookupContractVersion, 120);
    projected.requestedOzonProductId = nullablePositiveInteger(value.requestedOzonProductId);
    projected.requestedSourceSku = nullableText(value.requestedSourceSku);
    projected.matchedOzonProductId = positiveInteger(value.matchedOzonProductId);
    projected.matchedSourceSku = text(value.matchedSourceSku);
    projected.triggerProductDraftId = text(value.triggerProductDraftId);
    projected.triggerProductDraftVersion = positiveInteger(value.triggerProductDraftVersion);
    const observation = lookupObservationIdentity({
      collectItemId: evidence.collectItemId,
      triggerProductDraftId: projected.triggerProductDraftId,
      triggerProductDraftVersion: projected.triggerProductDraftVersion,
      lookupContractVersion: projected.lookupContractVersion,
      requestedOzonProductId: projected.requestedOzonProductId,
      requestedSourceSku: projected.requestedSourceSku,
      matchedOzonProductId: projected.matchedOzonProductId,
      matchedSourceSku: projected.matchedSourceSku,
      responseHash: projected.rawResponseHash,
    });
    if (evidence.collectItemId === null || evidence.productDraftId !== null
      || evidence.productDraftVersion !== null
      || evidence.ozonProductId !== projected.matchedOzonProductId
      || evidence.sourceSku !== projected.matchedSourceSku
      || (!projected.requestedOzonProductId && !projected.requestedSourceSku)
      || (projected.requestedOzonProductId
        && projected.requestedOzonProductId !== projected.matchedOzonProductId)
      || (projected.requestedSourceSku
        && projected.requestedSourceSku !== projected.matchedSourceSku)
      || evidence.sourceVersion !== observation.sourceVersion
      || projected.sourceRecordId !== observation.sourceRecordId
      || projected.rawResponseRef !== observation.rawResponseRef
      || !LOOKUP_REF.test(projected.rawResponseRef)
    ) throw invalid();
  } else if (projected.sourceKind === "MANUAL_CONFIRMATION") {
    projected.confirmationContractVersion = text(value.confirmationContractVersion, 120);
    projected.triggerProductDraftId = text(value.triggerProductDraftId);
    projected.triggerProductDraftVersion = positiveInteger(value.triggerProductDraftVersion);
    projected.selectedDescriptionCategoryId = positiveInteger(value.selectedDescriptionCategoryId);
    projected.selectedTypeId = positiveInteger(value.selectedTypeId);
    projected.taxonomyScope = text(value.taxonomyScope, 80);
    projected.actorId = text(value.actorId);
    projected.correlationId = text(value.correlationId);
    projected.idempotencyKey = text(value.idempotencyKey);
    const observation = manualConfirmationObservationIdentity({
      accountId: evidence.accountId,
      collectItemId: evidence.collectItemId,
      triggerProductDraftId: projected.triggerProductDraftId,
      triggerProductDraftVersion: projected.triggerProductDraftVersion,
      selectedDescriptionCategoryId: projected.selectedDescriptionCategoryId,
      selectedTypeId: projected.selectedTypeId,
      taxonomyScope: projected.taxonomyScope,
      actorId: projected.actorId,
      capturedAt: projected.capturedAt,
      correlationId: projected.correlationId,
      idempotencyKey: projected.idempotencyKey,
      requestHash: projected.rawResponseHash,
    });
    if (projected.confirmationContractVersion
        !== "account-shared-ozon-category-manual-confirmation.v1"
      || evidence.collectItemId === null || evidence.productDraftId !== null
      || evidence.productDraftVersion !== null || evidence.ozonProductId !== null
      || evidence.sourceSku !== null || evidence.normalizedPath.length !== 0
      || evidence.attributeSummary.length !== 0
      || evidence.sourceDescriptionCategoryId !== projected.selectedDescriptionCategoryId
      || evidence.sourceTypeId !== projected.selectedTypeId
      || evidence.taxonomyScope !== projected.taxonomyScope
      || evidence.sourceVersion !== observation.sourceVersion
      || projected.sourceRecordId !== observation.sourceRecordId
      || projected.rawResponseRef !== observation.rawResponseRef
      || !MANUAL_CONFIRMATION_REF.test(projected.rawResponseRef)) throw invalid();
  } else throw invalid();
  return Object.freeze(projected);
}

export function sourceCategoryEvidence(input) {
  const seen = new WeakSet();
  assertExactDataObject(input, EVIDENCE_KEYS, seen);
  const projected = {
    accountId: text(input.accountId),
    collectItemId: nullableText(input.collectItemId),
    sourceVersion: text(input.sourceVersion),
    productDraftId: nullableText(input.productDraftId),
    productDraftVersion: nullablePositiveInteger(input.productDraftVersion),
    ozonProductId: nullablePositiveInteger(input.ozonProductId),
    sourceSku: nullableText(input.sourceSku),
    taxonomyScope: text(input.taxonomyScope, 80),
    sourceDescriptionCategoryId: positiveInteger(input.sourceDescriptionCategoryId),
    sourceTypeId: positiveInteger(input.sourceTypeId),
    normalizedPath: normalizedPath(input.normalizedPath, seen),
    attributeSummary: attributeSummary(input.attributeSummary, seen),
    provenance: null,
    capturedAt: isoInstant(input.capturedAt),
    rawResponseRef: text(input.rawResponseRef),
    rawResponseHash: sha256(input.rawResponseHash),
  };
  if (projected.taxonomyScope !== "OZON:DEFAULT") throw invalid();
  projected.provenance = evidenceProvenance(input.provenance, projected, seen);
  return Object.freeze(projected);
}

export function sharedCategorySelection(input) {
  const seen = new WeakSet();
  assertExactDataObject(input, SELECTION_KEYS, seen);
  const projected = {
    accountId: text(input.accountId),
    sourceDescriptionCategoryId: positiveInteger(input.sourceDescriptionCategoryId),
    sourceTypeId: positiveInteger(input.sourceTypeId),
    taxonomyScope: text(input.taxonomyScope, 80),
    currentDescriptionCategoryId: positiveInteger(input.currentDescriptionCategoryId),
    currentTypeId: positiveInteger(input.currentTypeId),
    status: text(input.status, 40),
    source: text(input.source, 40),
    taxonomyFingerprint: input.taxonomyFingerprint === null ? null : sha256(input.taxonomyFingerprint),
    version: positiveInteger(input.version),
    evidenceId: text(input.evidenceId),
    validatedAt: input.validatedAt === null ? null : isoInstant(input.validatedAt),
  };
  if (projected.taxonomyScope !== "OZON:DEFAULT"
    || !SHARED_STATUSES.has(projected.status) || !SHARED_SOURCES.has(projected.source)
    || (projected.taxonomyFingerprint === null) !== (projected.validatedAt === null)
    || (projected.source === "SOURCE_DIRECT" && projected.taxonomyFingerprint !== null)
    || (projected.source !== "SOURCE_DIRECT" && projected.taxonomyFingerprint === null)) throw invalid();
  return Object.freeze(projected);
}
