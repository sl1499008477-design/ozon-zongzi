import { randomUUID } from "node:crypto";
import { types } from "node:util";
import {
  sharedCategorySelection,
  sourceCategoryEvidence,
} from "./account-shared-ozon-category-contract.mjs";

const SAFE_FAILURE_CODES = new Set([
  "OZON_CATEGORY_INVALIDATED",
  "OZON_CATEGORY_NEEDS_REVIEW",
  "OZON_TAXONOMY_CHANGED",
  "OZON_TYPE_NOT_FOUND",
  "OZON_TYPE_AMBIGUOUS",
  "OZON_TYPE_DUPLICATE",
  "MANUAL_REVIEW_REQUIRED",
]);
const STORED_EVIDENCE_KEYS = Object.freeze([
  "id", "accountId", "collectItemId", "sourceVersion", "productDraftId",
  "productDraftVersion", "ozonProductId", "sourceSku", "taxonomyScope",
  "sourceDescriptionCategoryId", "sourceTypeId", "normalizedPath",
  "attributeSummary", "provenance", "capturedAt", "rawResponseRef",
  "rawResponseHash",
]);
const HASH = /^[0-9a-f]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const stateQueues = new WeakMap();

function repositoryError(code, status = 400) {
  return Object.assign(new Error("Account-shared Ozon category operation failed"), { code, status });
}

function invalid() {
  return repositoryError("ACCOUNT_SHARED_OZON_CATEGORY_CONTRACT_INVALID", 400);
}

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key) || !allowed.has(key)
      || descriptors[key].get || descriptors[key].set || !descriptors[key].enumerable) throw invalid();
  }
  if (Object.keys(descriptors).length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key))) throw invalid();
  return value;
}

function text(value, maximum = 240) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid();
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid();
  return value;
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

function safeFailureCode(value) {
  const code = text(value, 80);
  if (!SAFE_FAILURE_CODES.has(code)) throw invalid();
  return code;
}

function idList(value) {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > 500) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => {
    if (key === "length") return descriptors[key].get || descriptors[key].set;
    return typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)
      || descriptors[key].get || descriptors[key].set || !descriptors[key].enumerable;
  })) throw invalid();
  const result = value.map((item) => text(item));
  if (new Set(result).size !== result.length) throw invalid();
  return result;
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function normalizeStoredEvidence(record) {
  try {
    exactObject(record, STORED_EVIDENCE_KEYS);
    const { id, ...input } = record;
    return Object.freeze({ id: text(id), ...sourceCategoryEvidence(input) });
  } catch {
    throw repositoryError("OZON_CATEGORY_PERSISTENCE_FAILED", 500);
  }
}

function publicEvidence(record) {
  return normalizeStoredEvidence(record);
}

function validateStoredEvidenceRows(state) {
  try {
    const rows = state.collectOzonCategorySourceEvidence;
    if (!Array.isArray(rows) || types.isProxy(rows)
      || Object.getPrototypeOf(rows) !== Array.prototype) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(rows);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || lengthDescriptor.get || lengthDescriptor.set
      || lengthDescriptor.value !== rows.length || lengthDescriptor.enumerable !== false
      || lengthDescriptor.configurable !== false || lengthDescriptor.writable !== true) throw invalid();
    let elements = 0;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (descriptor.get || descriptor.set) throw invalid();
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)
        || Number(key) >= rows.length || descriptor.enumerable !== true) throw invalid();
      elements += 1;
    }
    if (elements !== rows.length) throw invalid();
    for (let index = 0; index < rows.length; index += 1) {
      normalizeStoredEvidence(descriptors[String(index)].value);
    }
  } catch {
    throw repositoryError("OZON_CATEGORY_PERSISTENCE_FAILED", 500);
  }
}

function publicShared(record) {
  return sharedCategorySelection({
    accountId: record.accountId,
    sourceDescriptionCategoryId: record.sourceDescriptionCategoryId,
    sourceTypeId: record.sourceTypeId,
    taxonomyScope: record.taxonomyScope,
    currentDescriptionCategoryId: record.currentDescriptionCategoryId,
    currentTypeId: record.currentTypeId,
    status: record.status,
    source: record.source,
    taxonomyFingerprint: record.taxonomyFingerprint,
    version: record.version,
    evidenceId: record.evidenceId,
    validatedAt: record.validatedAt,
  });
}

function sourceKey(evidence) {
  return [
    evidence.accountId,
    evidence.provenance.sourceKind,
    evidence.provenance.sourceRecordId,
    evidence.sourceVersion,
  ].join("\u0001");
}

function signature(value) {
  return [
    value.accountId,
    value.sourceDescriptionCategoryId,
    value.sourceTypeId,
    value.taxonomyScope,
  ].join("\u0001");
}

function sameEvidence(left, right) {
  const { id: _leftId, ...leftEvidence } = left;
  const { id: _rightId, ...rightEvidence } = right;
  return JSON.stringify(sourceCategoryEvidence(leftEvidence))
    === JSON.stringify(sourceCategoryEvidence(rightEvidence));
}

function sameObservation(left, right) {
  if (left?.provenance?.sourceKind !== "OZON_READ_LOOKUP"
    || right?.provenance?.sourceKind !== "OZON_READ_LOOKUP") return sameEvidence(left, right);
  return sameEvidence(left, {
    ...right,
    capturedAt: left.capturedAt,
    provenance: {
      ...right.provenance,
      capturedAt: left.provenance.capturedAt,
    },
  });
}

function normalizeState(working) {
  delete working.collectCategoryResolutions;
  delete working.collectCategoryResolutionRuntimeCursors;
  if (!Array.isArray(working.collectOzonCategorySourceEvidence)) {
    working.collectOzonCategorySourceEvidence = [];
  }
  if (!Array.isArray(working.accountOzonSharedCategories)) {
    working.accountOzonSharedCategories = [];
  }
  if (!Array.isArray(working.accountOzonSharedCategoryEvents)) {
    working.accountOzonSharedCategoryEvents = [];
  }
  if (!Array.isArray(working.collectOzonCategoryLookupEvidence)) {
    working.collectOzonCategoryLookupEvidence = [];
  }
  if (!Array.isArray(working.collectOzonCategoryCurrentSources)) {
    working.collectOzonCategoryCurrentSources = [];
  }
  const pointedItems = new Set(working.collectOzonCategoryCurrentSources
    .map((row) => `${row.accountId}\u0001${row.collectItemId}`));
  const backfill = new Map();
  for (const evidence of working.collectOzonCategorySourceEvidence) {
    if (!evidence?.collectItemId || evidence?.provenance?.sourceKind === "ENRICHMENT_CACHE") continue;
    const key = `${evidence.accountId}\u0001${evidence.collectItemId}`;
    if (pointedItems.has(key)) continue;
    const item = (Array.isArray(working?.caches?.collectBox) ? working.caches.collectBox : [])
      .find((row) => String(row?.accountId || "") === evidence.accountId
        && String(row?.id || "") === evidence.collectItemId);
    const draftId = item?.currentDraftId ?? item?.current_draft_id ?? null;
    const draftVersion = Number(item?.draftVersion ?? item?.draft_version ?? 0);
    if (evidence.provenance.sourceKind === "OZON_READ_LOOKUP") continue;
    if (evidence.provenance.sourceKind === "PRODUCT_DRAFT"
      && ((draftId !== null && String(draftId) !== evidence.productDraftId)
        || (draftVersion > 0 && draftVersion !== evidence.productDraftVersion))) continue;
    backfill.set(key, {
      accountId: evidence.accountId,
      collectItemId: evidence.collectItemId,
      evidenceId: evidence.id,
      sourceKind: evidence.provenance.sourceKind,
      sourceRecordId: evidence.provenance.sourceRecordId,
      sourceVersion: evidence.sourceVersion,
    });
  }
  working.collectOzonCategoryCurrentSources.push(...backfill.values());
  return working;
}

function stateNeedsMigration(state) {
  return Object.hasOwn(state, "collectCategoryResolutions")
    || Object.hasOwn(state, "collectCategoryResolutionRuntimeCursors")
    || !Array.isArray(state.collectOzonCategorySourceEvidence)
    || !Array.isArray(state.accountOzonSharedCategories)
    || !Array.isArray(state.accountOzonSharedCategoryEvents)
    || !Array.isArray(state.collectOzonCategoryLookupEvidence)
    || !Array.isArray(state.collectOzonCategoryCurrentSources);
}

function commitState(target, working) {
  delete target.collectCategoryResolutions;
  delete target.collectCategoryResolutionRuntimeCursors;
  target.collectOzonCategorySourceEvidence = working.collectOzonCategorySourceEvidence;
  target.accountOzonSharedCategories = working.accountOzonSharedCategories;
  target.accountOzonSharedCategoryEvents = working.accountOzonSharedCategoryEvents;
  target.collectOzonCategoryLookupEvidence = working.collectOzonCategoryLookupEvidence;
  target.collectOzonCategoryCurrentSources = working.collectOzonCategoryCurrentSources;
}

function enqueueState(state, operation) {
  const previous = stateQueues.get(state) || Promise.resolve();
  const flight = previous.catch(() => {}).then(operation);
  stateQueues.set(state, flight.catch(() => {}));
  return flight;
}

function readInput(input, listKey) {
  exactObject(input, ["accountId", listKey]);
  return { accountId: text(input.accountId), ids: idList(input[listKey]) };
}

function transitionBase(input, extraKeys = []) {
  exactObject(input, [
    "accountId", "evidenceId", "expectedVersion", ...extraKeys,
  ]);
  return {
    accountId: text(input.accountId),
    evidenceId: text(input.evidenceId),
    expectedVersion: positiveInteger(input.expectedVersion),
  };
}

function rowNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw repositoryError("OZON_CATEGORY_PERSISTENCE_FAILED", 500);
  return number;
}

function mapSharedRow(row) {
  return {
    id: text(row.id),
    accountId: text(row.account_id),
    sourceDescriptionCategoryId: rowNumber(row.source_description_category_id),
    sourceTypeId: rowNumber(row.source_type_id),
    taxonomyScope: text(row.taxonomy_scope, 80),
    currentDescriptionCategoryId: rowNumber(row.current_description_category_id),
    currentTypeId: rowNumber(row.current_type_id),
    status: text(row.status, 40),
    source: text(row.source, 40),
    taxonomyFingerprint: row.taxonomy_fingerprint ?? null,
    safeFailureCode: String(row.safe_failure_code ?? ""),
    version: rowNumber(row.version),
    evidenceId: text(row.source_evidence_id),
    validatedAt: row.validated_at ? new Date(row.validated_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function categoryEvidenceFromRow(row) {
  const stored = row?.provenance?.categoryEvidence;
  if (stored) return { id: text(row.id), ...sourceCategoryEvidence(stored) };
  const sourceKind = text(row.source_kind, 40);
  const capturedAt = new Date(row.captured_at).toISOString();
  const common = {
    accountId: text(row.account_id),
    sourceVersion: text(row.source_version),
    ozonProductId: null,
    taxonomyScope: text(row.taxonomy_scope, 80),
    sourceDescriptionCategoryId: rowNumber(row.source_description_category_id),
    sourceTypeId: rowNumber(row.source_type_id),
    normalizedPath: [],
    attributeSummary: [],
    capturedAt,
    rawResponseRef: text(row.raw_response_ref),
    rawResponseHash: sha256(row.raw_response_hash),
  };
  if (sourceKind === "PRODUCT_DRAFT") {
    const productDraftVersion = Number(row.source_version);
    return {
      id: text(row.id),
      ...sourceCategoryEvidence({
        ...common,
        collectItemId: text(row.collect_item_id),
        productDraftId: text(row.product_draft_id),
        productDraftVersion: positiveInteger(productDraftVersion),
        sourceSku: null,
        provenance: {
          accountId: text(row.account_id),
          collectItemId: text(row.collect_item_id),
          sourceKind,
          sourceRecordId: text(row.source_record_id),
          rawResponseRef: text(row.raw_response_ref),
          rawResponseHash: sha256(row.raw_response_hash),
          capturedAt,
        },
      }),
    };
  }
  if (sourceKind === "ENRICHMENT_CACHE") {
    return {
      id: text(row.id),
      ...sourceCategoryEvidence({
        ...common,
        collectItemId: null,
        productDraftId: null,
        productDraftVersion: null,
        sourceSku: text(row.enrichment_sku),
        provenance: {
          accountId: text(row.account_id),
          collectItemId: null,
          sourceKind,
          sourceRecordId: text(row.source_record_id),
          rawResponseRef: text(row.raw_response_ref),
          rawResponseHash: sha256(row.raw_response_hash),
          capturedAt,
          enrichmentSource: text(row.enrichment_source, 80),
          enrichmentContractVersion: text(row.enrichment_contract_version, 120),
        },
      }),
    };
  }
  throw repositoryError("OZON_CATEGORY_PERSISTENCE_FAILED", 500);
}

function makeEvent({
  idFactory,
  shared,
  evidenceId,
  eventType,
  previous = null,
  createdAt,
  sourceEvidence = null,
}) {
  const provenance = {
    sharedCategoryId: shared.id,
    sourceEvidenceId: evidenceId,
    fromVersion: previous?.version ?? null,
    toVersion: shared.version,
    transition: eventType,
    occurredAt: createdAt,
  };
  if (sourceEvidence) Object.assign(provenance, {
    sourceRecordId: sourceEvidence.provenance.sourceRecordId,
    sourceVersion: sourceEvidence.sourceVersion,
    rawResponseHash: sourceEvidence.rawResponseHash,
    rawResponseRef: sourceEvidence.rawResponseRef,
    capturedAt: sourceEvidence.capturedAt,
  });
  return {
    id: text(idFactory()),
    accountId: shared.accountId,
    sharedCategoryId: shared.id,
    sourceEvidenceId: evidenceId,
    eventType,
    fromStatus: previous?.status ?? null,
    toStatus: shared.status,
    fromVersion: previous?.version ?? null,
    toVersion: shared.version,
    taxonomyFingerprint: shared.taxonomyFingerprint,
    provenance: Object.freeze(provenance),
    createdAt,
  };
}

function recordEvidenceInState(working, evidenceInput, { idFactory }) {
  const evidence = sourceCategoryEvidence(evidenceInput);
  const existing = working.collectOzonCategorySourceEvidence.find(
    (row) => sourceKey(row) === sourceKey(evidence),
  );
  if (existing) {
    if (!sameObservation(existing, evidence)) {
      throw repositoryError("OZON_CATEGORY_SOURCE_VERSION_CONFLICT", 409);
    }
    const shared = working.accountOzonSharedCategories.find(
      (row) => signature(row) === signature(existing),
    );
    return { evidence: existing, shared, created: false };
  }
  if (evidence.provenance.sourceKind === "OZON_READ_LOOKUP") {
    const lookup = {
      id: evidence.rawResponseRef,
      accountId: evidence.accountId,
      collectItemId: evidence.collectItemId,
      requestedOzonProductId: evidence.provenance.requestedOzonProductId,
      requestedSourceSku: evidence.provenance.requestedSourceSku,
      matchedOzonProductId: evidence.provenance.matchedOzonProductId,
      matchedSourceSku: evidence.provenance.matchedSourceSku,
      lookupContractVersion: evidence.provenance.lookupContractVersion,
      triggerProductDraftId: evidence.provenance.triggerProductDraftId,
      triggerProductDraftVersion: evidence.provenance.triggerProductDraftVersion,
      responseHash: evidence.rawResponseHash,
      capturedAt: evidence.capturedAt,
    };
    const existingLookup = working.collectOzonCategoryLookupEvidence.find((row) =>
      row.accountId === lookup.accountId && row.id === lookup.id);
    if (existingLookup && JSON.stringify(existingLookup) !== JSON.stringify(lookup)) {
      throw repositoryError("OZON_CATEGORY_SOURCE_VERSION_CONFLICT", 409);
    }
    if (!existingLookup) working.collectOzonCategoryLookupEvidence.push(lookup);
  }
  const record = { id: text(idFactory()), ...evidence };
  working.collectOzonCategorySourceEvidence.push(record);
  let shared = working.accountOzonSharedCategories.find(
    (row) => signature(row) === signature(record),
  );
  if (!shared) {
    shared = {
      id: text(idFactory()),
      accountId: record.accountId,
      sourceDescriptionCategoryId: record.sourceDescriptionCategoryId,
      sourceTypeId: record.sourceTypeId,
      taxonomyScope: record.taxonomyScope,
      currentDescriptionCategoryId: record.sourceDescriptionCategoryId,
      currentTypeId: record.sourceTypeId,
      status: "ACTIVE",
      source: "SOURCE_DIRECT",
      taxonomyFingerprint: null,
      safeFailureCode: "",
      version: 1,
      evidenceId: record.id,
      validatedAt: null,
      createdAt: record.capturedAt,
      updatedAt: record.capturedAt,
    };
    working.accountOzonSharedCategories.push(shared);
    working.accountOzonSharedCategoryEvents.push(makeEvent({
      idFactory,
      shared,
      evidenceId: record.id,
      eventType: "SOURCE_DIRECT_RECORDED",
      createdAt: record.capturedAt,
      sourceEvidence: record,
    }));
  }
  setCurrentSourceInState(working, record);
  return { evidence: record, shared, created: true };
}

function setCurrentSourceInState(working, evidence) {
  if (!evidence.collectItemId || evidence.provenance.sourceKind === "ENRICHMENT_CACHE") return;
  if (evidence.provenance.sourceKind === "PRODUCT_DRAFT") {
    const item = (Array.isArray(working?.caches?.collectBox) ? working.caches.collectBox : [])
      .find((row) => String(row?.accountId || "") === evidence.accountId
        && String(row?.id || "") === evidence.collectItemId);
    const canonicalDraftId = item?.currentDraftId ?? item?.current_draft_id ?? null;
    const canonicalVersion = Number(item?.draftVersion ?? item?.draft_version ?? 0);
    if (canonicalDraftId !== null && String(canonicalDraftId) !== evidence.productDraftId) return;
    if (canonicalVersion > 0 && canonicalVersion !== evidence.productDraftVersion) return;
  }
  const pointer = {
    accountId: evidence.accountId,
    collectItemId: evidence.collectItemId,
    evidenceId: evidence.id,
    sourceKind: evidence.provenance.sourceKind,
    sourceRecordId: evidence.provenance.sourceRecordId,
    sourceVersion: evidence.sourceVersion,
  };
  const index = working.collectOzonCategoryCurrentSources.findIndex((row) =>
    row.accountId === pointer.accountId && row.collectItemId === pointer.collectItemId);
  if (evidence.provenance.sourceKind === "OZON_READ_LOOKUP") {
    if (index < 0) {
      const item = (Array.isArray(working?.caches?.collectBox) ? working.caches.collectBox : [])
        .find((row) => String(row?.accountId || "") === evidence.accountId
          && String(row?.id || "") === evidence.collectItemId);
      const draftId = item?.currentDraftId ?? item?.current_draft_id ?? null;
      const draftVersion = Number(item?.draftVersion ?? item?.draft_version ?? 0);
      if (draftId === null || String(draftId) !== evidence.provenance.triggerProductDraftId
        || draftVersion !== evidence.provenance.triggerProductDraftVersion) return;
      working.collectOzonCategoryCurrentSources.push(pointer);
      return;
    }
    const current = working.collectOzonCategoryCurrentSources[index];
    if (current.sourceKind !== "PRODUCT_DRAFT"
      || current.sourceRecordId !== evidence.provenance.triggerProductDraftId
      || ![String(evidence.provenance.triggerProductDraftVersion),
        `draft:${evidence.provenance.triggerProductDraftVersion}`].includes(current.sourceVersion)) return;
    working.collectOzonCategoryCurrentSources[index] = pointer;
    return;
  }
  if (index < 0) working.collectOzonCategoryCurrentSources.push(pointer);
  else working.collectOzonCategoryCurrentSources[index] = pointer;
}

function findSharedForEvidence(working, accountId, evidenceId) {
  const evidence = working.collectOzonCategorySourceEvidence.find(
    (row) => row.accountId === accountId && row.id === evidenceId,
  );
  if (!evidence) throw repositoryError("OZON_CATEGORY_EVIDENCE_NOT_FOUND", 404);
  const shared = working.accountOzonSharedCategories.find(
    (row) => row.accountId === accountId && signature(row) === signature(evidence),
  );
  if (!shared) throw repositoryError("OZON_CATEGORY_SHARED_NOT_FOUND", 404);
  return { evidence, shared };
}

function transitionInState(working, {
  accountId,
  evidenceId,
  expectedVersion,
  desired,
  eventType,
  transitionedAt,
  idFactory,
}) {
  const { shared } = findSharedForEvidence(working, accountId, evidenceId);
  if (shared.version === expectedVersion + 1
    && shared.evidenceId === evidenceId
    && Object.entries(desired).every(([key, value]) => shared[key] === value)) return shared;
  if (shared.version !== expectedVersion) {
    throw repositoryError("OZON_CATEGORY_SHARED_VERSION_CONFLICT", 409);
  }
  const previous = clone(shared);
  Object.assign(shared, desired, {
    version: expectedVersion + 1,
    evidenceId,
    updatedAt: transitionedAt,
  });
  working.accountOzonSharedCategoryEvents.push(makeEvent({
    idFactory,
    shared,
    evidenceId,
    eventType,
    previous,
    createdAt: transitionedAt,
  }));
  return shared;
}

export function createJsonAccountSharedOzonCategoryRepository({
  state,
  persist = async () => {},
  idFactory = randomUUID,
  now = () => new Date().toISOString(),
} = {}) {
  if (!state || typeof state !== "object" || Array.isArray(state) || types.isProxy(state)
    || typeof persist !== "function" || typeof idFactory !== "function" || typeof now !== "function") {
    throw invalid();
  }

  async function write(operation) {
    return enqueueState(state, async () => {
      if (Array.isArray(state.collectOzonCategorySourceEvidence)) validateStoredEvidenceRows(state);
      const working = normalizeState(clone(state));
      const result = operation(working);
      try {
        await persist(working);
      } catch {
        throw repositoryError("OZON_CATEGORY_PERSISTENCE_FAILED", 500);
      }
      commitState(state, working);
      return result;
    });
  }

  async function migrate() {
    if (!stateNeedsMigration(state)) return;
    await write(() => null);
  }

  async function transition(input, kind) {
    const extras = kind === "ACTIVATE" ? [
      "currentDescriptionCategoryId", "currentTypeId", "taxonomyFingerprint", "validatedAt",
    ] : ["safeFailureCode", "transitionedAt"];
    const base = transitionBase(input, extras);
    const transitionedAt = kind === "ACTIVATE" ? isoInstant(input.validatedAt) : isoInstant(input.transitionedAt);
    const desired = kind === "ACTIVATE" ? {
      currentDescriptionCategoryId: positiveInteger(input.currentDescriptionCategoryId),
      currentTypeId: positiveInteger(input.currentTypeId),
      status: "ACTIVE",
      source: "OZON_REFRESH",
      taxonomyFingerprint: sha256(input.taxonomyFingerprint),
      safeFailureCode: "",
      validatedAt: transitionedAt,
    } : {
      status: kind === "INVALIDATE" ? "INVALIDATED" : "NEEDS_REVIEW",
      safeFailureCode: safeFailureCode(input.safeFailureCode),
    };
    return publicShared(await write((working) => transitionInState(working, {
      ...base,
      desired,
      eventType: kind === "ACTIVATE" ? "OZON_REFRESH_ACTIVATED"
        : kind === "INVALIDATE" ? "SHARED_CATEGORY_INVALIDATED" : "SHARED_CATEGORY_NEEDS_REVIEW",
      transitionedAt,
      idFactory,
    })));
  }

  return Object.freeze({
    async recordSourceEvidence(input) {
      const evidence = sourceCategoryEvidence(input);
      const result = await write((working) => recordEvidenceInState(working, evidence, { idFactory }));
      return deepFreeze({ evidence: publicEvidence(result.evidence), shared: publicShared(result.shared) });
    },

    async readCurrentEvidence(input) {
      const { accountId, ids } = readInput(input, "collectItemIds");
      await migrate();
      validateStoredEvidenceRows(state);
      const pointerIds = new Map(state.collectOzonCategoryCurrentSources
        .filter((row) => row.accountId === accountId && ids.includes(row.collectItemId))
        .map((row) => [row.collectItemId, row.evidenceId]));
      const current = state.collectOzonCategorySourceEvidence.filter((evidence) =>
        evidence.accountId === accountId
        && pointerIds.get(evidence.collectItemId) === evidence.id);
      return deepFreeze(current.sort((left, right) =>
        left.collectItemId.localeCompare(right.collectItemId),
      ).map(publicEvidence));
    },

    async readSharedForEvidence(input) {
      const { accountId, ids } = readInput(input, "evidenceIds");
      await migrate();
      validateStoredEvidenceRows(state);
      const signatures = new Set(state.collectOzonCategorySourceEvidence
        .filter((row) => row.accountId === accountId && ids.includes(row.id))
        .map(signature));
      return deepFreeze(state.accountOzonSharedCategories
        .filter((row) => row.accountId === accountId && signatures.has(signature(row)))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(publicShared));
    },

    async confirmManualCategory(input) {
      exactObject(input, [
        "accountId", "evidenceId", "expectedVersion", "currentDescriptionCategoryId",
        "currentTypeId", "taxonomyFingerprint", "validatedAt",
      ]);
      const accountId = text(input.accountId);
      const evidenceId = text(input.evidenceId);
      const expectedVersion = positiveInteger(input.expectedVersion);
      const validatedAt = isoInstant(input.validatedAt);
      const desired = {
        currentDescriptionCategoryId: positiveInteger(input.currentDescriptionCategoryId),
        currentTypeId: positiveInteger(input.currentTypeId),
        status: "ACTIVE",
        source: "MANUAL",
        taxonomyFingerprint: sha256(input.taxonomyFingerprint),
        safeFailureCode: "",
        validatedAt,
      };
      const result = await write((working) => transitionInState(working, {
          accountId,
          evidenceId,
          expectedVersion,
          desired,
          eventType: "MANUAL_CATEGORY_CONFIRMED",
          transitionedAt: validatedAt,
          idFactory,
        }));
      return publicShared(result);
    },

    invalidateSharedCategory(input) {
      return transition(input, "INVALIDATE");
    },

    activateRefreshedCategory(input) {
      return transition(input, "ACTIVATE");
    },

    markSharedNeedsReview(input) {
      return transition(input, "REVIEW");
    },
  });
}

async function withTransaction(pool, operation) {
  if (typeof pool?.connect !== "function") throw invalid();
  let client = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (String(error?.code || "").startsWith("OZON_")
      || error?.code === "ACCOUNT_SHARED_OZON_CATEGORY_CONTRACT_INVALID") throw error;
    throw repositoryError("OZON_CATEGORY_PERSISTENCE_FAILED", 500);
  } finally {
    client?.release();
  }
}

async function recordEvidencePostgres(client, evidenceInput, { idFactory }) {
  const evidence = sourceCategoryEvidence(evidenceInput);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [sourceKey(evidence)],
  );
  const existingResult = await client.query(
    `SELECT * FROM collect_ozon_category_source_evidence
      WHERE account_id=$1 AND source_kind=$2
        AND source_record_id=$3 AND source_version=$4
      FOR UPDATE`,
    [evidence.accountId, evidence.provenance.sourceKind,
      evidence.provenance.sourceRecordId, evidence.sourceVersion],
  );
  if (existingResult.rows[0]) {
    const existing = categoryEvidenceFromRow(existingResult.rows[0]);
    const { id, ...existingEvidence } = existing;
    if (!sameObservation(existingEvidence, evidence)) {
      throw repositoryError("OZON_CATEGORY_SOURCE_VERSION_CONFLICT", 409);
    }
    const sharedResult = await client.query(
      `SELECT * FROM account_ozon_shared_categories
        WHERE account_id=$1 AND source_description_category_id=$2
          AND source_type_id=$3 AND taxonomy_scope=$4`,
      [evidence.accountId, evidence.sourceDescriptionCategoryId, evidence.sourceTypeId, evidence.taxonomyScope],
    );
    return { evidence: existing, shared: mapSharedRow(sharedResult.rows[0]), created: false };
  }

  const evidenceId = text(idFactory());
  const productDraft = evidence.provenance.sourceKind === "PRODUCT_DRAFT";
  const lookup = evidence.provenance.sourceKind === "OZON_READ_LOOKUP";
  if (lookup) {
    await client.query(
      `INSERT INTO collect_ozon_category_lookup_evidence
        (id,account_id,collect_item_id,requested_ozon_product_id,requested_source_sku,
         matched_ozon_product_id,matched_source_sku,lookup_contract_version,
         trigger_product_draft_id,trigger_product_draft_version,response_hash,
         captured_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
       ON CONFLICT (account_id,id) DO NOTHING`,
      [evidence.rawResponseRef, evidence.accountId, evidence.collectItemId,
        evidence.provenance.requestedOzonProductId, evidence.provenance.requestedSourceSku,
        evidence.provenance.matchedOzonProductId, evidence.provenance.matchedSourceSku,
        evidence.provenance.lookupContractVersion, evidence.provenance.triggerProductDraftId,
        evidence.provenance.triggerProductDraftVersion, evidence.rawResponseHash,
        evidence.capturedAt],
    );
    const lookupRow = (await client.query(
      `SELECT * FROM collect_ozon_category_lookup_evidence
        WHERE account_id=$1 AND id=$2 FOR UPDATE`,
      [evidence.accountId, evidence.rawResponseRef],
    )).rows[0];
    const expectedLookup = [evidence.collectItemId, evidence.provenance.requestedOzonProductId,
      evidence.provenance.requestedSourceSku, evidence.provenance.matchedOzonProductId,
      evidence.provenance.matchedSourceSku, evidence.provenance.lookupContractVersion,
      evidence.provenance.triggerProductDraftId, evidence.provenance.triggerProductDraftVersion,
      evidence.rawResponseHash, evidence.capturedAt];
    const actualLookup = lookupRow ? [lookupRow.collect_item_id,
      lookupRow.requested_ozon_product_id === null ? null : Number(lookupRow.requested_ozon_product_id),
      lookupRow.requested_source_sku, Number(lookupRow.matched_ozon_product_id),
      lookupRow.matched_source_sku, lookupRow.lookup_contract_version,
      lookupRow.trigger_product_draft_id, Number(lookupRow.trigger_product_draft_version),
      lookupRow.response_hash,
      new Date(lookupRow.captured_at).toISOString()] : [];
    if (JSON.stringify(actualLookup) !== JSON.stringify(expectedLookup)) {
      throw repositoryError("OZON_CATEGORY_SOURCE_VERSION_CONFLICT", 409);
    }
  }
  const evidenceRow = (await client.query(
    `INSERT INTO collect_ozon_category_source_evidence
      (id,account_id,source_kind,source_record_id,source_version,collect_item_id,
       product_draft_id,enrichment_source,enrichment_sku,enrichment_contract_version,
       source_description_category_id,source_type_id,taxonomy_scope,captured_at,
       raw_response_hash,raw_response_ref,product_raw_response_ref,lookup_evidence_id,
       provenance,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$14)
     RETURNING *`,
    [
      evidenceId, evidence.accountId, evidence.provenance.sourceKind,
      evidence.provenance.sourceRecordId, evidence.sourceVersion,
      productDraft || lookup ? evidence.collectItemId : null,
      productDraft ? evidence.productDraftId : null,
      productDraft || lookup ? null : evidence.provenance.enrichmentSource,
      productDraft || lookup ? null : evidence.sourceSku,
      productDraft || lookup ? null : evidence.provenance.enrichmentContractVersion,
      evidence.sourceDescriptionCategoryId, evidence.sourceTypeId, evidence.taxonomyScope,
      evidence.capturedAt, evidence.rawResponseHash, evidence.rawResponseRef,
      productDraft ? evidence.rawResponseRef : null,
      lookup ? evidence.rawResponseRef : null,
      JSON.stringify({ ...evidence.provenance, categoryEvidence: evidence }),
    ],
  )).rows[0];
  const sharedId = text(idFactory());
  const sharedResult = await client.query(
    `INSERT INTO account_ozon_shared_categories
      (id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
       current_description_category_id,current_type_id,status,source,version,
       taxonomy_fingerprint,safe_failure_code,source_evidence_id,validated_at,
       next_refresh_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$3,$4,'ACTIVE','SOURCE_DIRECT',1,NULL,'',$6,NULL,NULL,$7,$7)
     ON CONFLICT (account_id,source_description_category_id,source_type_id,taxonomy_scope)
     DO NOTHING RETURNING *`,
    [sharedId, evidence.accountId, evidence.sourceDescriptionCategoryId, evidence.sourceTypeId,
      evidence.taxonomyScope, evidenceId, evidence.capturedAt],
  );
  let sharedRow = sharedResult.rows[0];
  if (sharedRow) {
    await client.query(
      `INSERT INTO account_ozon_shared_category_events
        (id,account_id,shared_category_id,source_evidence_id,event_type,from_status,
         to_status,from_version,to_version,taxonomy_fingerprint,provenance,created_at)
       VALUES ($1,$2,$3,$4,'SOURCE_DIRECT_RECORDED',NULL,'ACTIVE',NULL,1,NULL,$5::jsonb,$6)`,
      [text(idFactory()), evidence.accountId, sharedRow.id, evidenceId, JSON.stringify({
        sharedCategoryId: sharedRow.id,
        sourceEvidenceId: evidenceId,
        sourceRecordId: evidence.provenance.sourceRecordId,
        sourceVersion: evidence.sourceVersion,
        rawResponseHash: evidence.rawResponseHash,
        rawResponseRef: evidence.rawResponseRef,
        capturedAt: evidence.capturedAt,
      }), evidence.capturedAt],
    );
  } else {
    sharedRow = (await client.query(
      `SELECT * FROM account_ozon_shared_categories
        WHERE account_id=$1 AND source_description_category_id=$2
          AND source_type_id=$3 AND taxonomy_scope=$4
        FOR UPDATE`,
      [evidence.accountId, evidence.sourceDescriptionCategoryId, evidence.sourceTypeId, evidence.taxonomyScope],
    )).rows[0];
  }
  const storedEvidence = categoryEvidenceFromRow(evidenceRow);
  await setCurrentSourcePostgres(client, storedEvidence);
  return {
    evidence: storedEvidence,
    shared: mapSharedRow(sharedRow),
    created: true,
  };
}

async function setCurrentSourcePostgres(client, evidence) {
  if (!evidence.collectItemId || evidence.provenance.sourceKind === "ENRICHMENT_CACHE") return;
  if (evidence.provenance.sourceKind === "PRODUCT_DRAFT") {
    const current = (await client.query(
      `SELECT 1 FROM collect_items AS item
        JOIN product_drafts AS draft
          ON draft.id=item.current_draft_id AND draft.collect_item_id=item.id
       WHERE item.account_id=$1 AND item.id=$2 AND draft.id=$3 AND draft.version=$4`,
      [evidence.accountId, evidence.collectItemId, evidence.productDraftId,
        evidence.productDraftVersion],
    )).rows[0];
    if (!current) return;
  }
  if (evidence.provenance.sourceKind === "OZON_READ_LOOKUP") {
    await client.query(
      `INSERT INTO collect_ozon_category_current_sources
        (account_id,collect_item_id,source_evidence_id,source_kind,source_record_id,
         source_version,updated_at)
       SELECT $1,$2,$3,$4,$5,$6,$7
         FROM collect_items AS item
         JOIN product_drafts AS draft
           ON draft.id=item.current_draft_id AND draft.collect_item_id=item.id
        WHERE item.account_id=$1 AND item.id=$2 AND draft.id=$8 AND draft.version=$9
       ON CONFLICT (account_id,collect_item_id) DO UPDATE SET
         source_evidence_id=EXCLUDED.source_evidence_id,source_kind=EXCLUDED.source_kind,
         source_record_id=EXCLUDED.source_record_id,source_version=EXCLUDED.source_version,
         updated_at=EXCLUDED.updated_at
       WHERE collect_ozon_category_current_sources.source_kind='PRODUCT_DRAFT'
         AND collect_ozon_category_current_sources.source_record_id=$8
         AND collect_ozon_category_current_sources.source_version IN ($9::TEXT,'draft:' || $9::TEXT)`,
      [evidence.accountId, evidence.collectItemId, evidence.id, evidence.provenance.sourceKind,
        evidence.provenance.sourceRecordId, evidence.sourceVersion, evidence.capturedAt,
        evidence.provenance.triggerProductDraftId,
        evidence.provenance.triggerProductDraftVersion],
    );
    return;
  }
  await client.query(
    `INSERT INTO collect_ozon_category_current_sources
      (account_id,collect_item_id,source_evidence_id,source_kind,source_record_id,
       source_version,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (account_id,collect_item_id) DO UPDATE SET
       source_evidence_id=EXCLUDED.source_evidence_id,source_kind=EXCLUDED.source_kind,
       source_record_id=EXCLUDED.source_record_id,source_version=EXCLUDED.source_version,
       updated_at=EXCLUDED.updated_at`,
    [evidence.accountId, evidence.collectItemId, evidence.id, evidence.provenance.sourceKind,
      evidence.provenance.sourceRecordId, evidence.sourceVersion, evidence.capturedAt],
  );
}

async function transitionPostgres(client, {
  accountId,
  evidenceId,
  expectedVersion,
  desired,
  transitionedAt,
}) {
  const evidenceRow = (await client.query(
    `SELECT * FROM collect_ozon_category_source_evidence
      WHERE account_id=$1 AND id=$2`,
    [accountId, evidenceId],
  )).rows[0];
  if (!evidenceRow) throw repositoryError("OZON_CATEGORY_EVIDENCE_NOT_FOUND", 404);
  const sharedIdentity = (await client.query(
    `SELECT id FROM account_ozon_shared_categories
      WHERE account_id=$1 AND source_description_category_id=$2
        AND source_type_id=$3 AND taxonomy_scope=$4`,
    [accountId, rowNumber(evidenceRow.source_description_category_id),
      rowNumber(evidenceRow.source_type_id), text(evidenceRow.taxonomy_scope, 80)],
  )).rows[0];
  if (!sharedIdentity) throw repositoryError("OZON_CATEGORY_SHARED_NOT_FOUND", 404);
  await client.query(
    "SELECT pg_advisory_xact_lock(account_ozon_shared_category_lease_key($1,$2))",
    [accountId, sharedIdentity.id],
  );
  const sharedRow = (await client.query(
    `SELECT * FROM account_ozon_shared_categories
      WHERE account_id=$1 AND id=$5 AND source_description_category_id=$2
        AND source_type_id=$3 AND taxonomy_scope=$4
      FOR UPDATE`,
    [accountId, rowNumber(evidenceRow.source_description_category_id),
      rowNumber(evidenceRow.source_type_id), text(evidenceRow.taxonomy_scope, 80), sharedIdentity.id],
  )).rows[0];
  if (!sharedRow) throw repositoryError("OZON_CATEGORY_SHARED_NOT_FOUND", 404);
  const current = mapSharedRow(sharedRow);
  if (current.version === expectedVersion + 1
    && Object.entries(desired).every(([key, value]) => current[key] === value)
    && current.evidenceId === evidenceId) return current;
  if (current.version !== expectedVersion) {
    throw repositoryError("OZON_CATEGORY_SHARED_VERSION_CONFLICT", 409);
  }
  const updated = (await client.query(
    `UPDATE account_ozon_shared_categories
        SET current_description_category_id=$4,current_type_id=$5,status=$6,source=$7,
            taxonomy_fingerprint=$8,safe_failure_code=$9,source_evidence_id=$3,
            validated_at=$10,version=version+1,
            updated_at=GREATEST($11::timestamptz,updated_at+INTERVAL '1 millisecond')
      WHERE account_id=$1 AND id=$2 AND version=$12
      RETURNING *`,
    [
      accountId, current.id, evidenceId, desired.currentDescriptionCategoryId ?? current.currentDescriptionCategoryId,
      desired.currentTypeId ?? current.currentTypeId, desired.status, desired.source ?? current.source,
      desired.taxonomyFingerprint ?? current.taxonomyFingerprint,
      desired.safeFailureCode, desired.validatedAt ?? current.validatedAt,
      transitionedAt, expectedVersion,
    ],
  )).rows[0];
  if (!updated) throw repositoryError("OZON_CATEGORY_SHARED_VERSION_CONFLICT", 409);
  return mapSharedRow(updated);
}

export function createPostgresAccountSharedOzonCategoryRepository({
  pool,
  idFactory = randomUUID,
  now = () => new Date().toISOString(),
  transactionOwner = "repository",
} = {}) {
  if (!pool || typeof pool.query !== "function" || typeof idFactory !== "function" || typeof now !== "function") {
    throw invalid();
  }
  if (!["repository", "caller"].includes(transactionOwner)) throw invalid();
  const runWrite = (operation) => transactionOwner === "caller"
    ? operation(pool)
    : withTransaction(pool, operation);

  async function transition(input, kind) {
    const extras = kind === "ACTIVATE" ? [
      "currentDescriptionCategoryId", "currentTypeId", "taxonomyFingerprint", "validatedAt",
    ] : ["safeFailureCode", "transitionedAt"];
    const base = transitionBase(input, extras);
    const transitionedAt = kind === "ACTIVATE" ? isoInstant(input.validatedAt) : isoInstant(input.transitionedAt);
    const desired = kind === "ACTIVATE" ? {
      currentDescriptionCategoryId: positiveInteger(input.currentDescriptionCategoryId),
      currentTypeId: positiveInteger(input.currentTypeId),
      status: "ACTIVE",
      source: "OZON_REFRESH",
      taxonomyFingerprint: sha256(input.taxonomyFingerprint),
      safeFailureCode: "",
      validatedAt: transitionedAt,
    } : {
      status: kind === "INVALIDATE" ? "INVALIDATED" : "NEEDS_REVIEW",
      safeFailureCode: safeFailureCode(input.safeFailureCode),
    };
    return publicShared(await runWrite((client) => transitionPostgres(client, {
      ...base, desired, transitionedAt,
    })));
  }

  return Object.freeze({
    async recordSourceEvidence(input) {
      const evidence = sourceCategoryEvidence(input);
      const result = await runWrite((client) => recordEvidencePostgres(client, evidence, { idFactory }));
      return deepFreeze({ evidence: publicEvidence(result.evidence), shared: publicShared(result.shared) });
    },

    async readCurrentEvidence(input) {
      const { accountId, ids } = readInput(input, "collectItemIds");
      if (!ids.length) return Object.freeze([]);
      try {
        const rows = (await pool.query(
          `SELECT evidence.*
             FROM collect_ozon_category_current_sources AS current_source
             JOIN collect_ozon_category_source_evidence AS evidence
               ON evidence.account_id=current_source.account_id
              AND evidence.id=current_source.source_evidence_id
              AND evidence.collect_item_id=current_source.collect_item_id
              AND evidence.source_kind=current_source.source_kind
              AND evidence.source_record_id=current_source.source_record_id
              AND evidence.source_version=current_source.source_version
            WHERE current_source.account_id=$1
              AND current_source.collect_item_id=ANY($2::text[])
            ORDER BY current_source.collect_item_id`,
          [accountId, ids],
        )).rows;
        return deepFreeze(rows.map((row) => publicEvidence(categoryEvidenceFromRow(row))));
      } catch (error) {
        if (error?.code === "OZON_CATEGORY_PERSISTENCE_FAILED") throw error;
        throw repositoryError("OZON_CATEGORY_PERSISTENCE_FAILED", 500);
      }
    },

    async readSharedForEvidence(input) {
      const { accountId, ids } = readInput(input, "evidenceIds");
      if (!ids.length) return Object.freeze([]);
      try {
        const rows = (await pool.query(
          `SELECT DISTINCT shared.*
             FROM collect_ozon_category_source_evidence AS evidence
             JOIN account_ozon_shared_categories AS shared
               ON shared.account_id=evidence.account_id
              AND shared.source_description_category_id=evidence.source_description_category_id
              AND shared.source_type_id=evidence.source_type_id
              AND shared.taxonomy_scope=evidence.taxonomy_scope
            WHERE evidence.account_id=$1 AND evidence.id=ANY($2::text[])
            ORDER BY shared.id`,
          [accountId, ids],
        )).rows;
        return deepFreeze(rows.map((row) => publicShared(mapSharedRow(row))));
      } catch {
        throw repositoryError("OZON_CATEGORY_PERSISTENCE_FAILED", 500);
      }
    },

    async confirmManualCategory(input) {
      exactObject(input, [
        "accountId", "evidenceId", "expectedVersion", "currentDescriptionCategoryId",
        "currentTypeId", "taxonomyFingerprint", "validatedAt",
      ]);
      const accountId = text(input.accountId);
      const evidenceId = text(input.evidenceId);
      const expectedVersion = positiveInteger(input.expectedVersion);
      const validatedAt = isoInstant(input.validatedAt);
      const desired = {
        currentDescriptionCategoryId: positiveInteger(input.currentDescriptionCategoryId),
        currentTypeId: positiveInteger(input.currentTypeId),
        status: "ACTIVE",
        source: "MANUAL",
        taxonomyFingerprint: sha256(input.taxonomyFingerprint),
        safeFailureCode: "",
        validatedAt,
      };
      const result = await runWrite((client) => transitionPostgres(client, {
          accountId,
          evidenceId,
          expectedVersion,
          desired,
          transitionedAt: validatedAt,
        }));
      return publicShared(result);
    },

    invalidateSharedCategory(input) {
      return transition(input, "INVALIDATE");
    },

    activateRefreshedCategory(input) {
      return transition(input, "ACTIVATE");
    },

    markSharedNeedsReview(input) {
      return transition(input, "REVIEW");
    },
  });
}
