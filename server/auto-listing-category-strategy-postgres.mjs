import crypto from "node:crypto";
import { types } from "node:util";

import {
  projectCategoryStrategyGuidanceV2,
  projectCategoryStrategyScope,
} from "./auto-listing-category-strategy-contract.mjs";

const FACTORY_KEYS = new Set(["pool"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const SAFE_OBJECT_KEY = /^[A-Za-z0-9._/-]+$/u;
const MODES = new Set(["LEGACY_FALLBACK", "REQUIRE_EXACT_STRATEGY"]);
const SAMPLE_REVISION_STATUSES = ["COLLECTING", "SAMPLES_READY", "DRAFT_READY", "NEEDS_REVIEW"];
const ADMIN_CATEGORY_STRATEGY_ACTIONS = [
  "AUTO_LISTING_CATEGORY_STRATEGY_PUBLISH",
  "AUTO_LISTING_CATEGORY_STRATEGY_ROLLBACK",
];

function repositoryError(code, status = 422, retryable = false) {
  return Object.assign(new Error(code), { code, status, retryable });
}

function invalid() {
  return repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_REPOSITORY_INVALID");
}

function databaseFailed() {
  return repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DATABASE_FAILED", 503, true);
}

function closed(value, keys) {
  try {
    if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.size || ownKeys.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    return Object.fromEntries(ownKeys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_REPOSITORY_INVALID") throw error;
    throw invalid();
  }
}

function closedArray(value, minimum, maximum) {
  try {
    if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < minimum || value.length > maximum) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== value.length + 1 || descriptors.length?.value !== value.length) throw invalid();
    return Array.from({ length: value.length }, (_, ordinal) => {
      const descriptor = descriptors[String(ordinal)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw invalid();
      return descriptor.value;
    });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_REPOSITORY_INVALID") throw error;
    throw invalid();
  }
}

function id(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(normalized)) throw invalid();
  return normalized;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_646) throw invalid();
  return value;
}

function platformId(value) {
  const normalized = typeof value === "number" ? value
    : (typeof value === "string" && /^[1-9][0-9]{0,15}$/u.test(value) ? Number(value) : 0);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw invalid();
  return normalized;
}

function sha256(value) {
  if (typeof value !== "string" || !SHA256.test(value)) throw invalid();
  return value;
}

function sameActor(input) {
  const accountId = id(input.accountId);
  if (id(input.actorId) !== accountId) throw invalid();
  return accountId;
}

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (types.isProxy(value)) throw invalid();
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.fromEntries(Reflect.ownKeys(descriptors).sort().map((key) => {
    if (typeof key !== "string" || descriptors[key]?.enumerable !== true
      || !Object.hasOwn(descriptors[key], "value")) throw invalid();
    if (["__proto__", "constructor", "prototype"].includes(key)) throw invalid();
    return [key, canonical(descriptors[key].value)];
  }));
}

function boundedCanonical(value, maximumBytes, state = { nodes: 0, active: new WeakSet() }, depth = 0) {
  if (depth > 32 || state.nodes++ > 20_000) throw invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value) || state.active.has(value)) throw invalid();
  state.active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      const length = descriptors.length?.value;
      if (Object.getPrototypeOf(value) !== Array.prototype || !Number.isSafeInteger(length)
        || length < 0 || length > 10_000 || keys.length !== length + 1) throw invalid();
      return Array.from({ length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw invalid();
        return boundedCanonical(descriptor.value, maximumBytes, state, depth + 1);
      });
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || keys.length > 10_000) throw invalid();
    const projected = {};
    for (const key of keys.sort()) {
      const descriptor = descriptors[key];
      if (typeof key !== "string" || key.length > 1_024
        || ["__proto__", "constructor", "prototype"].includes(key)
        || descriptor?.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw invalid();
      projected[key] = boundedCanonical(descriptor.value, maximumBytes, state, depth + 1);
    }
    if (depth === 0 && Buffer.byteLength(JSON.stringify(projected), "utf8") > maximumBytes) throw invalid();
    return projected;
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_REPOSITORY_INVALID") throw error;
    throw invalid();
  } finally {
    state.active.delete(value);
  }
}

function requestHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function sameHash(left, right) {
  return typeof left === "string" && SHA256.test(left) && typeof right === "string" && SHA256.test(right)
    && crypto.timingSafeEqual(Buffer.from(left, "ascii"), Buffer.from(right, "ascii"));
}

function deterministicId(prefix, ...values) {
  const suffix = crypto.createHash("sha256").update(values.join("\0"), "utf8").digest("hex").slice(0, 40);
  return `${prefix}_${suffix}`;
}

function isoDate(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw invalid();
  return new Date(value).toISOString();
}

function scopeFor(accountId, rawScope) {
  let scope;
  try {
    scope = projectCategoryStrategyScope(rawScope);
  } catch {
    throw invalid();
  }
  if (scope.accountId !== accountId) throw invalid();
  return { ...scope };
}

function draftRow(row, duplicate = false) {
  if (!row) return null;
  return {
    draftId: row.id,
    accountId: row.account_id,
    scope: {
      accountId: row.account_id,
      taxonomyScope: row.taxonomy_scope,
      descriptionCategoryId: Number(row.description_category_id),
      typeId: Number(row.type_id),
    },
    draftVersion: Number(row.draft_version),
    status: row.status,
    sourceCollectItemId: row.source_collect_item_id,
    expectedSourceVersion: row.expected_source_version,
    duplicate,
  };
}

function sessionRow(row, duplicate = false) {
  if (!row) return null;
  return {
    sessionId: row.id,
    draftId: row.draft_id,
    accountId: row.account_id,
    state: row.state,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    duplicate,
  };
}

function sampleSetRow(row, duplicate = false) {
  if (!row) return null;
  return {
    sampleSetId: row.sample_set_id ?? row.id,
    draftId: row.draft_id,
    accountId: row.account_id,
    sampleSetHash: row.sample_set_hash,
    sampleCount: Number(row.sample_count),
    draftVersion: Number(row.draft_version),
    status: row.draft_status ?? row.status,
    idempotencyKey: row.idempotency_key,
    duplicate,
  };
}

function analysisResultRow(row, duplicate = false, draftVersion = null, draftStatus = null) {
  if (!row) return null;
  let guidance;
  try { guidance = projectCategoryStrategyGuidanceV2(row.guidance); } catch { throw databaseFailed(); }
  const raw = row.raw_response;
  const original = row.result_event_payload;
  const status = draftStatus ?? original?.status
    ?? (raw?.validationStatus === "ACCEPTED" ? "DRAFT_READY" : "NEEDS_REVIEW");
  return {
    attemptId: row.attempt_id,
    resultId: row.id,
    status,
    draftVersion: Number(draftVersion ?? original?.draftVersion ?? row.draft_version),
    duplicate,
    safeCode: raw?.safeCode ?? null,
    guidance,
    evidenceSummary: raw?.evidenceSummary ?? null,
    editedBy: row.edited_by ?? null,
    editedAt: row.edited_at instanceof Date ? row.edited_at.toISOString() : (row.edited_at ?? null),
    baseAnalysisAttemptId: row.base_analysis_attempt_id ?? null,
  };
}

function policyRow(row, duplicate = false) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    mode: row.mode,
    version: Number(row.version),
    duplicate,
  };
}

async function query(target, sql, params = []) {
  try {
    return await target.query(sql, params);
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_CATEGORY_STRATEGY_")) throw error;
    throw databaseFailed();
  }
}

async function transaction(pool, operation) {
  let client;
  try {
    client = await pool.connect();
  } catch {
    throw databaseFailed();
  }
  let committed = false;
  try {
    await query(client, "BEGIN");
    const result = await operation(client);
    await query(client, "COMMIT");
    committed = true;
    return result;
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    try { client.release(); } catch { /* best effort */ }
  }
}

async function lockAccount(client, accountId) {
  const result = await query(client, "SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [accountId]);
  if (!result.rows[0]) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_ACCOUNT_NOT_FOUND", 404);
}

async function requireMutationEnabled(client, accountId) {
  const result = await query(client,
    `SELECT mode FROM auto_listing_category_strategy_account_settings
      WHERE account_id=$1 FOR UPDATE`,
    [accountId]);
  if (result.rows[0]?.mode !== "REQUIRE_EXACT_STRATEGY") {
    throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_READ_ONLY", 409);
  }
}

async function requireCompatibleEventIdempotency(client, { accountId, idempotencyKey }, action, hash) {
  const categoryEvents = await query(client,
    `SELECT CASE
       WHEN event_type='PUBLISHED' THEN 'AUTO_LISTING_CATEGORY_STRATEGY_PUBLISH'
       WHEN event_type='ACCOUNT_SETTINGS_CHANGED' THEN 'TRANSITION_ACCOUNT_POLICY'
       WHEN event_payload->>'event'='DRAFT_CREATED' THEN 'CREATE_DRAFT'
       WHEN event_payload->>'event'='SAMPLING_SESSION_STARTED' THEN 'START_SAMPLING_SESSION'
       WHEN event_payload->>'event'='SAMPLE_REVISION_REQUESTED' THEN 'PREPARE_SAMPLE_REVISION'
       WHEN event_payload->>'event'='SAMPLE_SET_COMMITTED' THEN 'COMMIT_SAMPLE_SET'
       WHEN event_payload->>'event'='ANALYSIS_ATTEMPT_RESERVED' THEN 'RESERVE_ANALYSIS_ATTEMPT'
       WHEN event_payload->>'event'='ANALYSIS_RESULT_RECORDED' THEN 'COMPLETE_ANALYSIS_ATTEMPT'
       WHEN event_payload->>'event'='ANALYSIS_MANUAL_EDITED' THEN 'APPEND_MANUAL_ANALYSIS_RESULT'
       ELSE 'UNKNOWN'
     END AS action,request_hash
       FROM auto_listing_category_strategy_events
      WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
    [accountId, idempotencyKey]);
  const auditIds = ADMIN_CATEGORY_STRATEGY_ACTIONS.map((adminAction) => deterministicId(
    "audit_ai_admin", adminAction, accountId, idempotencyKey,
  ));
  const adminAudits = await query(client,
    `SELECT action,metadata->>'requestHash' AS request_hash
       FROM audit_events
      WHERE account_id=$1 AND event_id=ANY($2::TEXT[]) FOR UPDATE`,
    [accountId, auditIds]);
  const attempts = await query(client,
    `SELECT 'RESERVE_ANALYSIS_ATTEMPT' AS action,request_hash
       FROM auto_listing_category_strategy_analysis_attempts
      WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
    [accountId, idempotencyKey]);
  const results = await query(client,
    `SELECT CASE WHEN source_kind='MANUAL' THEN 'APPEND_MANUAL_ANALYSIS_RESULT'
                 ELSE 'COMPLETE_ANALYSIS_ATTEMPT' END AS action,request_hash
       FROM auto_listing_category_strategy_analysis_results
      WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
    [accountId, idempotencyKey]);
  const entries = [...categoryEvents.rows, ...adminAudits.rows, ...attempts.rows, ...results.rows];
  if (entries.some((entry) => !(entry.action === action && entry.request_hash === hash)
    && !(action === "RESERVE_ANALYSIS_ATTEMPT" && entry.action === "COMPLETE_ANALYSIS_ATTEMPT"))) {
    throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
  }
}

function analysisEvidenceRequest(raw) {
  const value = closed(raw, new Set(["accountId", "actorId", "draftId"]));
  const accountId = sameActor(value);
  return { accountId, actorId: accountId, draftId: id(value.draftId) };
}

function analysisReplayRequest(raw) {
  const value = closed(raw, new Set([
    "accountId", "actorId", "draftId", "idempotencyKey", "correlationId",
  ]));
  const accountId = sameActor(value);
  return { accountId, actorId: accountId, draftId: id(value.draftId),
    idempotencyKey: id(value.idempotencyKey), correlationId: id(value.correlationId) };
}

function modelSnapshot(raw) {
  const value = closed(raw, new Set([
    "analyzerVersion", "promptVersion", "profileId", "profileVersion", "model",
  ]));
  return { analyzerVersion: id(value.analyzerVersion), promptVersion: id(value.promptVersion),
    profileId: id(value.profileId), profileVersion: positiveInteger(value.profileVersion), model: id(value.model) };
}

function reserveAnalysisRequest(raw) {
  const value = closed(raw, new Set([
    "accountId", "actorId", "draftId", "expectedDraftVersion", "sampleSetId", "sampleSetHash",
    "analysisInputHash", "modelConfigSnapshot", "modelConfigHash", "costConfirmed",
    "idempotencyKey", "correlationId",
  ]));
  const accountId = sameActor(value);
  if (value.costConfirmed !== true) throw invalid();
  return { accountId, actorId: accountId, draftId: id(value.draftId),
    expectedDraftVersion: positiveInteger(value.expectedDraftVersion), sampleSetId: id(value.sampleSetId),
    sampleSetHash: sha256(value.sampleSetHash), analysisInputHash: sha256(value.analysisInputHash),
    modelConfigSnapshot: modelSnapshot(value.modelConfigSnapshot), modelConfigHash: sha256(value.modelConfigHash),
    costConfirmed: true, idempotencyKey: id(value.idempotencyKey), correlationId: id(value.correlationId) };
}

function completeAnalysisRequest(raw) {
  const value = closed(raw, new Set([
    "accountId", "actorId", "draftId", "attemptId", "expectedDraftVersion", "analysisInputHash",
    "outcome", "safeCode", "rawResponse", "rawResponseHash", "guidance", "guidanceHash",
    "evidenceSummary", "idempotencyKey", "correlationId",
  ]));
  const accountId = sameActor(value);
  if (!['ACCEPTED', 'REJECTED'].includes(value.outcome)
    || (value.outcome === 'ACCEPTED' ? value.safeCode !== null
      : !(typeof value.safeCode === 'string' && /^AUTO_LISTING_CATEGORY_STRATEGY_AI_[A-Z0-9_:-]+$/u.test(value.safeCode)))) {
    throw invalid();
  }
  let guidance;
  try { guidance = projectCategoryStrategyGuidanceV2(value.guidance); } catch { throw invalid(); }
  const rawResponse = boundedCanonical(value.rawResponse, 4 * 1024 * 1024);
  const evidenceSummary = value.evidenceSummary === null ? null
    : boundedCanonical(value.evidenceSummary, 256 * 1024);
  const persistedRaw = { ...rawResponse, evidenceSummary };
  if (requestHash(persistedRaw) !== value.rawResponseHash
    || requestHash(guidance) !== value.guidanceHash) throw invalid();
  return { accountId, actorId: accountId, draftId: id(value.draftId), attemptId: id(value.attemptId),
    expectedDraftVersion: positiveInteger(value.expectedDraftVersion),
    analysisInputHash: sha256(value.analysisInputHash), outcome: value.outcome, safeCode: value.safeCode,
    rawResponse: persistedRaw, rawResponseHash: value.rawResponseHash, guidance,
    guidanceHash: value.guidanceHash, idempotencyKey: id(value.idempotencyKey),
    correlationId: id(value.correlationId) };
}

function manualAnalysisRequest(raw) {
  const value = closed(raw, new Set([
    "accountId", "actorId", "draftId", "expectedDraftVersion", "baseAnalysisAttemptId",
    "guidance", "guidanceHash", "idempotencyKey", "correlationId",
  ]));
  const accountId = sameActor(value);
  let guidance;
  try { guidance = projectCategoryStrategyGuidanceV2(value.guidance); } catch { throw invalid(); }
  if (requestHash(guidance) !== value.guidanceHash) throw invalid();
  return { accountId, actorId: accountId, draftId: id(value.draftId),
    expectedDraftVersion: positiveInteger(value.expectedDraftVersion),
    baseAnalysisAttemptId: id(value.baseAnalysisAttemptId), guidance,
    guidanceHash: sha256(value.guidanceHash), idempotencyKey: id(value.idempotencyKey),
    correlationId: id(value.correlationId) };
}

async function requireCurrentSource(client, { accountId, sourceCollectItemId, expectedSourceVersion, scope }) {
  const result = await query(client,
    `SELECT item.id
       FROM collect_items item
       JOIN product_drafts draft
         ON draft.collect_item_id=item.id AND draft.id=item.current_draft_id
       JOIN collect_ozon_category_current_sources pointer
         ON pointer.account_id=item.account_id AND pointer.collect_item_id=item.id
        AND pointer.source_kind='PRODUCT_DRAFT' AND pointer.source_record_id=draft.id
        AND pointer.source_version IN (draft.version::TEXT,'draft:' || draft.version::TEXT)
       JOIN collect_ozon_category_source_evidence evidence
         ON evidence.account_id=pointer.account_id AND evidence.id=pointer.source_evidence_id
        AND evidence.collect_item_id=pointer.collect_item_id
        AND evidence.source_kind=pointer.source_kind
        AND evidence.source_record_id=pointer.source_record_id
        AND evidence.source_version=pointer.source_version
       JOIN account_ozon_shared_categories shared
         ON shared.account_id=evidence.account_id
        AND shared.source_description_category_id=evidence.source_description_category_id
        AND shared.source_type_id=evidence.source_type_id
        AND shared.taxonomy_scope=evidence.taxonomy_scope
        AND shared.current_description_category_id=evidence.source_description_category_id
        AND shared.current_type_id=evidence.source_type_id
        AND shared.status='ACTIVE'
      WHERE item.account_id=$1 AND item.id=$2
        AND $3='draft:' || draft.version::TEXT
        AND evidence.taxonomy_scope=$4
        AND evidence.source_description_category_id=$5
        AND evidence.source_type_id=$6
      FOR UPDATE OF item,draft,pointer,shared`,
    [accountId, sourceCollectItemId, expectedSourceVersion, scope.taxonomyScope,
      scope.descriptionCategoryId, scope.typeId]);
  if (!result.rows[0]) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SOURCE_NOT_FOUND", 404);
}

async function requireDraftCurrentSource(client, row) {
  await requireCurrentSource(client, {
    accountId: row.account_id,
    sourceCollectItemId: row.source_collect_item_id,
    expectedSourceVersion: row.expected_source_version,
    scope: {
      taxonomyScope: row.taxonomy_scope,
      descriptionCategoryId: Number(row.description_category_id),
      typeId: Number(row.type_id),
    },
  });
}

function createDraftRequest(raw) {
  const value = closed(raw, new Set([
    "accountId", "actorId", "scope", "sourceCollectItemId", "expectedSourceVersion",
    "idempotencyKey", "correlationId",
  ]));
  const accountId = sameActor(value);
  const expectedSourceVersion = id(value.expectedSourceVersion);
  if (!/^draft:[1-9][0-9]*$/u.test(expectedSourceVersion)) throw invalid();
  return {
    accountId, actorId: accountId, scope: scopeFor(accountId, value.scope),
    sourceCollectItemId: id(value.sourceCollectItemId), expectedSourceVersion,
    idempotencyKey: id(value.idempotencyKey), correlationId: id(value.correlationId),
  };
}

function sessionRequest(raw) {
  const value = closed(raw, new Set([
    "accountId", "actorId", "draftId", "expectedDraftVersion", "sessionId", "sessionSecretHash",
    "expiresAt", "idempotencyKey", "correlationId",
  ]));
  const accountId = sameActor(value);
  return {
    accountId, actorId: accountId, draftId: id(value.draftId),
    expectedDraftVersion: positiveInteger(value.expectedDraftVersion), sessionId: id(value.sessionId),
    sessionSecretHash: sha256(value.sessionSecretHash), expiresAt: isoDate(value.expiresAt),
    idempotencyKey: id(value.idempotencyKey), correlationId: id(value.correlationId),
  };
}

function sessionReplayRequest(raw) {
  const value = closed(raw, new Set([
    "accountId", "actorId", "draftId", "expectedDraftVersion", "sessionId", "sessionSecretHash",
    "idempotencyKey", "correlationId",
  ]));
  const accountId = sameActor(value);
  return { accountId, actorId: accountId, draftId: id(value.draftId),
    expectedDraftVersion: positiveInteger(value.expectedDraftVersion),
    sessionId: id(value.sessionId), sessionSecretHash: sha256(value.sessionSecretHash),
    idempotencyKey: id(value.idempotencyKey), correlationId: id(value.correlationId) };
}

function sessionValidationRequest(raw) {
  const value = closed(raw, new Set([
    "accountId", "actorId", "draftId", "expectedDraftVersion", "sessionId", "sessionSecretHash",
  ]));
  const accountId = sameActor(value);
  return { accountId, actorId: accountId, draftId: id(value.draftId),
    expectedDraftVersion: positiveInteger(value.expectedDraftVersion), sessionId: id(value.sessionId),
    sessionSecretHash: sha256(value.sessionSecretHash) };
}

function sessionCancellationRequest(raw) {
  const value = closed(raw, new Set(["accountId", "actorId", "sessionId"]));
  const accountId = sameActor(value);
  return { accountId, actorId: accountId, sessionId: id(value.sessionId) };
}

function sampleRevisionRequest(raw) {
  const value = closed(raw, new Set([
    "accountId", "actorId", "draftId", "sampleId", "expectedDraftVersion",
    "samplingIdempotencyKey", "samplingCorrelationId", "idempotencyKey", "correlationId",
  ]));
  const accountId = sameActor(value);
  return { accountId, actorId: accountId, draftId: id(value.draftId), sampleId: id(value.sampleId),
    expectedDraftVersion: positiveInteger(value.expectedDraftVersion),
    samplingIdempotencyKey: id(value.samplingIdempotencyKey),
    samplingCorrelationId: id(value.samplingCorrelationId),
    idempotencyKey: id(value.idempotencyKey), correlationId: id(value.correlationId) };
}

function sampleSelection(raw) {
  const value = closed(raw, new Set(["sku", "sourceProductId", "sourceProductRef"]));
  return { sku: id(value.sku), sourceProductId: platformId(value.sourceProductId),
    sourceProductRef: id(value.sourceProductRef) };
}

function sampleReplayRequest(raw) {
  const value = closed(raw, new Set([
    "accountId", "actorId", "draftId", "sessionId", "sessionSecretHash", "expectedDraftVersion",
    "selections", "idempotencyKey", "correlationId",
  ]));
  const accountId = sameActor(value);
  const selections = closedArray(value.selections, 5, 20).map(sampleSelection);
  if (new Set(selections.map((entry) => entry.sku)).size !== selections.length
    || new Set(selections.map((entry) => entry.sourceProductId)).size !== selections.length) throw invalid();
  return { accountId, actorId: accountId, draftId: id(value.draftId), sessionId: id(value.sessionId),
    sessionSecretHash: sha256(value.sessionSecretHash),
    expectedDraftVersion: positiveInteger(value.expectedDraftVersion), selections,
    idempotencyKey: id(value.idempotencyKey), correlationId: id(value.correlationId) };
}

function imageEvidence(raw, context) {
  const value = closed(raw, new Set([
    "imageId", "role", "ordinal", "sourceUrlHost", "sourceRefHash", "sourceResponseHash",
    "sourceContentHash", "analysisObjectKey", "analysisContentHash", "thumbnailObjectKey",
    "thumbnailContentHash", "contentType", "width", "height", "capturedAt",
  ]));
  const imageId = id(value.imageId);
  if (!["MAIN", "DETAIL"].includes(value.role)
    || !Number.isInteger(value.ordinal) || value.ordinal < 0 || value.ordinal > 5
    || (value.role === "MAIN") !== (value.ordinal === 0)) throw invalid();
  const sourceUrlHost = typeof value.sourceUrlHost === "string" ? value.sourceUrlHost : "";
  if (sourceUrlHost.length > 253 || !SAFE_HOST.test(sourceUrlHost)) throw invalid();
  const analysisObjectKey = typeof value.analysisObjectKey === "string" ? value.analysisObjectKey : "";
  const thumbnailObjectKey = typeof value.thumbnailObjectKey === "string" ? value.thumbnailObjectKey : "";
  const prefix = `category-strategy/${context.accountId}/${context.draftId}/${context.sampleSetId}/${context.sampleId}/`;
  if (![analysisObjectKey, thumbnailObjectKey].every((key) => key.length <= 1024
    && SAFE_OBJECT_KEY.test(key) && !key.includes("..") && key.startsWith(prefix))) throw invalid();
  if (!["image/jpeg", "image/png", "image/webp"].includes(value.contentType)
    || !Number.isInteger(value.width) || value.width < 1 || value.width > 16_384
    || !Number.isInteger(value.height) || value.height < 1 || value.height > 16_384) throw invalid();
  return {
    imageId, role: value.role, ordinal: value.ordinal, sourceUrlHost,
    sourceRefHash: sha256(value.sourceRefHash), sourceResponseHash: sha256(value.sourceResponseHash),
    sourceContentHash: sha256(value.sourceContentHash), analysisObjectKey,
    analysisContentHash: sha256(value.analysisContentHash), thumbnailObjectKey,
    thumbnailContentHash: sha256(value.thumbnailContentHash), contentType: value.contentType,
    width: value.width, height: value.height, capturedAt: isoDate(value.capturedAt),
  };
}

const SAMPLE_EVIDENCE_KEYS = new Set([
  "sampleSetId", "sampleId", "sku", "sourceProductId", "sourceProductRef", "sourceProductResponseHash",
  "taxonomyScope", "descriptionCategoryId", "typeId", "images",
]);

function sampleEvidence(raw, context) {
  const value = closed(raw, SAMPLE_EVIDENCE_KEYS);
  const sampleSetId = id(value.sampleSetId);
  const sampleId = id(value.sampleId);
  if (value.taxonomyScope !== context.scope.taxonomyScope
    || value.descriptionCategoryId !== context.scope.descriptionCategoryId
    || value.typeId !== context.scope.typeId) throw invalid();
  const images = closedArray(value.images, 1, 6).map((image) => imageEvidence(image, {
    ...context, sampleSetId, sampleId,
  }));
  if (images.some((image, ordinal) => image.ordinal !== ordinal
    || image.role !== (ordinal === 0 ? "MAIN" : "DETAIL"))
    || new Set(images.map((image) => image.imageId)).size !== images.length) throw invalid();
  return {
    sampleSetId, sampleId, sku: id(value.sku), sourceProductId: platformId(value.sourceProductId),
    sourceProductRef: id(value.sourceProductRef), sourceProductResponseHash: sha256(value.sourceProductResponseHash),
    taxonomyScope: value.taxonomyScope, descriptionCategoryId: value.descriptionCategoryId,
    typeId: value.typeId, images,
  };
}

function commitRequest(raw, { canonical = false } = {}) {
  const keys = [
    "accountId", "actorId", "draftId", "sessionId", "sessionSecretHash", "expectedDraftVersion", "samples",
    "idempotencyKey", "correlationId",
  ];
  if (!canonical) keys.push("sampleSetHash");
  const value = closed(raw, new Set(keys));
  const accountId = sameActor(value);
  const sampleValues = closedArray(value.samples, 5, 20);
  const input = {
    accountId, actorId: accountId, draftId: id(value.draftId), sessionId: id(value.sessionId),
    sessionSecretHash: sha256(value.sessionSecretHash),
    expectedDraftVersion: positiveInteger(value.expectedDraftVersion),
    ...(canonical ? {} : { sampleSetHash: sha256(value.sampleSetHash) }),
    idempotencyKey: id(value.idempotencyKey),
    correlationId: id(value.correlationId),
  };
  const rawScope = closed(sampleValues[0], SAMPLE_EVIDENCE_KEYS);
  input.scope = {
    taxonomyScope: rawScope.taxonomyScope,
    descriptionCategoryId: rawScope.descriptionCategoryId,
    typeId: rawScope.typeId,
  };
  input.samples = sampleValues.map((entry) => sampleEvidence(entry, input));
  if (new Set(input.samples.map((entry) => entry.sampleSetId)).size !== 1
    || new Set(input.samples.map((entry) => entry.sampleId)).size !== input.samples.length
    || new Set(input.samples.map((entry) => entry.sku)).size !== input.samples.length
    || new Set(input.samples.map((entry) => entry.sourceProductId)).size !== input.samples.length) throw invalid();
  input.sampleSetId = input.samples[0].sampleSetId;
  return input;
}

function policyRequest(raw) {
  const value = closed(raw, new Set([
    "accountId", "actorId", "expectedVersion", "mode", "idempotencyKey", "correlationId",
  ]));
  const accountId = sameActor(value);
  if (!MODES.has(value.mode)) throw invalid();
  return {
    accountId, actorId: accountId, expectedVersion: positiveInteger(value.expectedVersion), mode: value.mode,
    idempotencyKey: id(value.idempotencyKey), correlationId: id(value.correlationId),
  };
}

async function insertDraftEvent(client, input, draft, eventName, hash, extraPayload = {}) {
  await query(client,
    `INSERT INTO auto_listing_category_strategy_events
       (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,event_type,event_payload,
        idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,$3,$4,$5,$6,'DRAFT_EVENT',$7::JSONB,$8,$9,$10,$2)`,
    [deterministicId("category_strategy_event", input.accountId, input.idempotencyKey), input.accountId,
      draft.id, draft.taxonomy_scope, draft.description_category_id, draft.type_id,
      JSON.stringify({ event: eventName, draftVersion: Number(draft.draft_version), status: draft.status,
        ...extraPayload }),
      input.idempotencyKey, input.correlationId, hash]);
}

async function insertAnalysisEvent(client, input, draft, eventName, hash, attemptId, resultId = null) {
  const eventKey = deterministicId("category_analysis_event_key", input.accountId, eventName,
    input.idempotencyKey, resultId ?? attemptId);
  await query(client,
    `INSERT INTO auto_listing_category_strategy_events
       (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,event_type,event_payload,
        idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,$3,$4,$5,$6,'DRAFT_EVENT',$7::JSONB,$8,$9,$10,$2)`,
    [deterministicId("category_analysis_event", input.accountId, eventName, resultId ?? attemptId),
      input.accountId, draft.id, draft.taxonomy_scope, draft.description_category_id, draft.type_id,
      JSON.stringify({ event: eventName, draftVersion: Number(draft.draft_version), status: draft.status,
        attemptId, ...(resultId ? { resultId } : {}) }), eventKey, input.correlationId, hash]);
}

export function createAutoListingCategoryStrategyPostgres(rawOptions = {}) {
  const options = closed(rawOptions, FACTORY_KEYS);
  const { pool } = options;
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") throw invalid();

  async function commitSampleSetCommand(raw, canonical) {
    const input = commitRequest(raw, { canonical });
    const action = "COMMIT_SAMPLE_SET";
    const hash = requestHash({ action, ...input });
    return transaction(pool, async (client) => {
      await lockAccount(client, input.accountId);
      await requireCompatibleEventIdempotency(client, input, action, hash);
      const replay = await query(client,
        `SELECT sample_set.id AS sample_set_id,sample_set.account_id,sample_set.draft_id,
                sample_set.sample_set_hash,sample_set.sample_count,sample_set.idempotency_key,
                sample_set.request_hash,
                draft.draft_version,draft.status AS draft_status
           FROM auto_listing_category_strategy_sample_sets sample_set
           JOIN auto_listing_category_strategy_drafts draft
             ON draft.account_id=sample_set.account_id AND draft.id=sample_set.draft_id
          WHERE sample_set.account_id=$1 AND sample_set.idempotency_key=$2 FOR UPDATE OF sample_set,draft`,
        [input.accountId, input.idempotencyKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== hash
          || (!canonical && replay.rows[0].sample_set_hash !== input.sampleSetHash)) {
          throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
        }
        return sampleSetRow({ ...replay.rows[0], draft_status: "SAMPLES_READY",
          draft_version: input.expectedDraftVersion + 1 }, true);
      }
      await requireMutationEnabled(client, input.accountId);
      const draftResult = await query(client,
        `SELECT * FROM auto_listing_category_strategy_drafts
          WHERE account_id=$1 AND id=$2 FOR UPDATE`,
        [input.accountId, input.draftId]);
      const draft = draftResult.rows[0];
      if (!draft) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
      if (Number(draft.draft_version) !== input.expectedDraftVersion
        || !SAMPLE_REVISION_STATUSES.includes(draft.status)) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
      }
      if (draft.taxonomy_scope !== input.scope.taxonomyScope
        || Number(draft.description_category_id) !== input.scope.descriptionCategoryId
        || Number(draft.type_id) !== input.scope.typeId) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SCOPE_CONFLICT", 409);
      }
      await requireDraftCurrentSource(client, draft);
      const sessionResult = await query(client,
        `SELECT *,expires_at>STATEMENT_TIMESTAMP() AS unexpired
           FROM auto_listing_category_strategy_sampling_sessions
          WHERE account_id=$1 AND draft_id=$2 AND taxonomy_scope=$3
            AND description_category_id=$4 AND type_id=$5 AND id=$6 FOR UPDATE`,
        [input.accountId, input.draftId, draft.taxonomy_scope, draft.description_category_id,
          draft.type_id, input.sessionId]);
      const session = sessionResult.rows[0];
      if (!session) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SESSION_NOT_FOUND", 404);
      if (session.state !== "ACTIVE" || session.unexpired !== true) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SESSION_EXPIRED", 409);
      }
      if (!sameHash(session.session_secret_hash, input.sessionSecretHash)) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SESSION_SECRET_MISMATCH", 409);
      }
      const sessionEvent = await query(client,
        `SELECT event_payload FROM auto_listing_category_strategy_events
          WHERE account_id=$1 AND draft_id=$2 AND idempotency_key=$3`,
        [input.accountId, input.draftId, session.idempotency_key]);
      const excludedSourceProductId = sessionEvent.rows[0]?.event_payload?.excludedSourceProductId;
      if (typeof excludedSourceProductId === "string"
        && input.samples.some((sample) => String(sample.sourceProductId) === excludedSourceProductId)) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_EXCLUDED_RESELECTED", 409);
      }
      await query(client,
        `INSERT INTO auto_listing_category_strategy_sample_sets
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,session_id,
            idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$2)`,
        [input.sampleSetId, input.accountId, input.draftId, draft.taxonomy_scope,
          draft.description_category_id, draft.type_id, input.sessionId,
          input.idempotencyKey, input.correlationId, hash]);
      for (const [ordinal, sample] of input.samples.entries()) {
        const childKey = deterministicId("category_sample_command", input.accountId, input.idempotencyKey, sample.sampleId);
        await query(client,
          `INSERT INTO auto_listing_category_strategy_samples
             (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,ordinal,
              sku,source_product_id,source_product_ref,source_product_response_hash,
              idempotency_key,correlation_id,request_hash,actor_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$2)`,
          [sample.sampleId, input.accountId, input.draftId, draft.taxonomy_scope,
            draft.description_category_id, draft.type_id, input.sampleSetId, ordinal, sample.sku,
            sample.sourceProductId, sample.sourceProductRef, sample.sourceProductResponseHash,
            childKey, input.correlationId, hash]);
        for (const image of sample.images) {
          const imageKey = deterministicId("category_image_command", input.accountId, input.idempotencyKey, image.imageId);
          await query(client,
            `INSERT INTO auto_listing_category_strategy_sample_images
               (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_id,
                image_id,role,ordinal,source_url_host,source_ref_hash,source_response_hash,source_content_hash,
                analysis_object_key,analysis_content_hash,thumbnail_object_key,thumbnail_content_hash,
                content_type,width,height,captured_at,idempotency_key,correlation_id,request_hash,actor_account_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$1,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               $22::TIMESTAMPTZ,$23,$24,$25,$2)`,
            [image.imageId, input.accountId, input.draftId, draft.taxonomy_scope,
              draft.description_category_id, draft.type_id, input.sampleSetId, sample.sampleId,
              image.role, image.ordinal, image.sourceUrlHost, image.sourceRefHash, image.sourceResponseHash,
              image.sourceContentHash, image.analysisObjectKey, image.analysisContentHash,
              image.thumbnailObjectKey, image.thumbnailContentHash, image.contentType, image.width,
              image.height, image.capturedAt, imageKey, input.correlationId, hash]);
        }
      }
      const canonicalHash = (await query(client,
        "SELECT auto_listing_category_strategy_canonical_sample_set_hash($1,$2) AS hash",
        [input.accountId, input.sampleSetId])).rows[0]?.hash;
      if (typeof canonicalHash !== "string" || !SHA256.test(canonicalHash)) {
        throw databaseFailed();
      }
      if (!canonical && canonicalHash !== input.sampleSetHash) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_SET_HASH_MISMATCH", 409);
      }
      const sealed = await query(client,
        `UPDATE auto_listing_category_strategy_sample_sets
            SET status='SEALED',sample_set_hash=$3
          WHERE account_id=$1 AND id=$2 AND status='BUILDING'
          RETURNING id AS sample_set_id,account_id,draft_id,sample_set_hash,sample_count,idempotency_key`,
        [input.accountId, input.sampleSetId, canonicalHash]);
      const advanced = await query(client,
        `UPDATE auto_listing_category_strategy_drafts
            SET status='SAMPLES_READY',draft_version=draft_version+1,updated_at=STATEMENT_TIMESTAMP()
          WHERE account_id=$1 AND id=$2 AND draft_version=$3 AND status=ANY($4::TEXT[])
          RETURNING *`,
        [input.accountId, input.draftId, input.expectedDraftVersion, SAMPLE_REVISION_STATUSES]);
      if (!advanced.rows[0]) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
      await insertDraftEvent(client, input, advanced.rows[0], "SAMPLE_SET_COMMITTED", hash);
      return sampleSetRow({ ...sealed.rows[0], draft_version: advanced.rows[0].draft_version,
        draft_status: advanced.rows[0].status }, false);
    });
  }

  return Object.freeze({
    async getAnalysisReplay(raw = {}) {
      const input = analysisReplayRequest(raw);
      const attemptResult = await query(pool,
        `SELECT * FROM auto_listing_category_strategy_analysis_attempts
          WHERE account_id=$1 AND draft_id=$2 AND idempotency_key=$3`,
        [input.accountId, input.draftId, input.idempotencyKey]);
      const attempt = attemptResult.rows[0];
      if (!attempt) return null;
      if (attempt.correlation_id !== input.correlationId) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
      }
      const result = await query(pool,
        `SELECT result.*,draft.draft_version,draft.status AS draft_status,
                history.event_payload AS result_event_payload
           FROM auto_listing_category_strategy_analysis_results result
           JOIN auto_listing_category_strategy_drafts draft
             ON draft.account_id=result.account_id AND draft.id=result.draft_id
           LEFT JOIN auto_listing_category_strategy_events history
             ON history.account_id=result.account_id AND history.draft_id=result.draft_id
            AND history.taxonomy_scope=result.taxonomy_scope
            AND history.description_category_id=result.description_category_id
            AND history.type_id=result.type_id AND history.event_type='DRAFT_EVENT'
            AND history.event_payload->>'resultId'=result.id
          WHERE result.account_id=$1 AND result.attempt_id=$2 AND result.source_kind='AI'`,
        [input.accountId, attempt.id]);
      return { attemptId: attempt.id, analysisInputHash: attempt.analysis_input_hash,
        modelConfigSnapshot: attempt.model_config_snapshot, sampleSetId: attempt.sample_set_id,
        sampleSetHash: attempt.sample_set_hash,
        result: result.rows[0] ? analysisResultRow(result.rows[0], true) : null };
    },

    async getDraftReplay(raw = {}) {
      const input = createDraftRequest(raw);
      const requestHashValue = requestHash({ action: "CREATE_DRAFT", ...input });
      const replay = await query(pool,
        `SELECT * FROM auto_listing_category_strategy_drafts
          WHERE account_id=$1 AND idempotency_key=$2`,
        [input.accountId, input.idempotencyKey]);
      const row = replay.rows[0];
      if (!row) return null;
      if (row.request_hash !== requestHashValue) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
      }
      return draftRow({ ...row, status: "COLLECTING", draft_version: 1 }, true);
    },

    async createDraft(raw = {}) {
      const input = createDraftRequest(raw);
      const action = "CREATE_DRAFT";
      const hash = requestHash({ action, ...input });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        await requireCompatibleEventIdempotency(client, input, action, hash);
        const replay = await query(client,
          `SELECT * FROM auto_listing_category_strategy_drafts
            WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [input.accountId, input.idempotencyKey]);
        if (replay.rows[0]) {
          if (replay.rows[0].request_hash !== hash) {
            throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
          }
          return draftRow({ ...replay.rows[0], status: "COLLECTING", draft_version: 1 }, true);
        }
        await requireMutationEnabled(client, input.accountId);
        await requireCurrentSource(client, input);
        const productDraftVersion = Number(input.expectedSourceVersion.slice("draft:".length));
        const source = await query(client,
          `SELECT draft.id
             FROM collect_items item
             JOIN product_drafts draft ON draft.collect_item_id=item.id AND draft.id=item.current_draft_id
            WHERE item.account_id=$1 AND item.id=$2 AND draft.version=$3`,
          [input.accountId, input.sourceCollectItemId, productDraftVersion]);
        const draftId = deterministicId("category_strategy_draft", input.accountId, input.idempotencyKey);
        const inserted = await query(client,
          `INSERT INTO auto_listing_category_strategy_drafts
             (id,account_id,taxonomy_scope,description_category_id,type_id,draft_version,status,
              source_collect_item_id,source_product_draft_id,source_product_draft_version,expected_source_version,
              idempotency_key,correlation_id,request_hash,actor_account_id)
           VALUES ($1,$2,$3,$4,$5,1,'COLLECTING',$6,$7,$8,$9,$10,$11,$12,$2)
           RETURNING *`,
          [draftId, input.accountId, input.scope.taxonomyScope, input.scope.descriptionCategoryId,
            input.scope.typeId, input.sourceCollectItemId, source.rows[0].id, productDraftVersion,
            input.expectedSourceVersion, input.idempotencyKey, input.correlationId, hash]);
        await insertDraftEvent(client, input, inserted.rows[0], "DRAFT_CREATED", hash);
        return draftRow(inserted.rows[0], false);
      });
    },

    async getSamplingSessionReplay(raw = {}) {
      const input = sessionReplayRequest(raw);
      const result = await query(pool,
        `SELECT session.*,event.event_payload,event.correlation_id AS event_correlation_id
           FROM auto_listing_category_strategy_sampling_sessions session
           LEFT JOIN auto_listing_category_strategy_events event
             ON event.account_id=session.account_id AND event.draft_id=session.draft_id
            AND event.idempotency_key=session.idempotency_key
          WHERE session.account_id=$1 AND session.idempotency_key=$2`,
        [input.accountId, input.idempotencyKey]);
      const row = result.rows[0];
      if (!row) return null;
      if (row.id !== input.sessionId || row.draft_id !== input.draftId
        || !sameHash(row.session_secret_hash, input.sessionSecretHash)
        || row.correlation_id !== input.correlationId
        || row.event_correlation_id !== input.correlationId
        || row.event_payload?.event !== "SAMPLING_SESSION_STARTED"
        || Number(row.event_payload?.draftVersion) !== input.expectedDraftVersion) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
      }
      return sessionRow(row, true);
    },

    async prepareSampleRevision(raw = {}) {
      const input = sampleRevisionRequest(raw);
      const action = "PREPARE_SAMPLE_REVISION";
      const hash = requestHash({ action, ...input });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        await requireCompatibleEventIdempotency(client, input, action, hash);
        const replay = await query(client,
          `SELECT event.event_payload,event.request_hash
             FROM auto_listing_category_strategy_events event
            WHERE event.account_id=$1 AND event.idempotency_key=$2 FOR UPDATE`,
          [input.accountId, input.idempotencyKey]);
        if (replay.rows[0]) {
          const payload = replay.rows[0].event_payload;
          if (replay.rows[0].request_hash !== hash || payload?.event !== "SAMPLE_REVISION_REQUESTED"
            || payload?.sampleId !== input.sampleId
            || payload?.samplingIdempotencyKey !== input.samplingIdempotencyKey
            || payload?.samplingCorrelationId !== input.samplingCorrelationId) {
            throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
          }
          return { draftId: input.draftId, sampleId: input.sampleId,
            expectedDraftVersion: input.expectedDraftVersion,
            samplingIdempotencyKey: input.samplingIdempotencyKey,
            samplingCorrelationId: input.samplingCorrelationId, duplicate: true };
        }
        await requireMutationEnabled(client, input.accountId);
        const draftResult = await query(client,
          `SELECT * FROM auto_listing_category_strategy_drafts
            WHERE account_id=$1 AND id=$2 FOR UPDATE`, [input.accountId, input.draftId]);
        const draft = draftResult.rows[0];
        if (!draft) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
        if (Number(draft.draft_version) !== input.expectedDraftVersion
          || !SAMPLE_REVISION_STATUSES.includes(draft.status)) {
          throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
        }
        await requireDraftCurrentSource(client, draft);
        const conflictingSession = await query(client,
          `SELECT id FROM auto_listing_category_strategy_sampling_sessions
            WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [input.accountId, input.samplingIdempotencyKey]);
        if (conflictingSession.rows[0]) {
          throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
        }
        const selected = await query(client,
          `SELECT sample.source_product_id
             FROM auto_listing_category_strategy_samples sample
             JOIN auto_listing_category_strategy_sample_sets sample_set
               ON sample_set.account_id=sample.account_id AND sample_set.id=sample.sample_set_id
            WHERE sample.account_id=$1 AND sample.draft_id=$2 AND sample.id=$3
              AND sample_set.status='SEALED'
              AND sample_set.id=(SELECT latest.id FROM auto_listing_category_strategy_sample_sets latest
                WHERE latest.account_id=$1 AND latest.draft_id=$2 AND latest.status='SEALED'
                ORDER BY latest.sealed_at DESC,latest.id DESC LIMIT 1)`,
          [input.accountId, input.draftId, input.sampleId]);
        if (!selected.rows[0]) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_NOT_FOUND", 404);
        await insertDraftEvent(client, input, draft, "SAMPLE_REVISION_REQUESTED", hash, {
          sampleId: input.sampleId,
          excludedSourceProductId: String(selected.rows[0].source_product_id),
          samplingIdempotencyKey: input.samplingIdempotencyKey,
          samplingCorrelationId: input.samplingCorrelationId,
        });
        return { draftId: input.draftId, sampleId: input.sampleId,
          expectedDraftVersion: input.expectedDraftVersion,
          samplingIdempotencyKey: input.samplingIdempotencyKey,
          samplingCorrelationId: input.samplingCorrelationId, duplicate: false };
      });
    },

    async validateSamplingSession(raw = {}) {
      const input = sessionValidationRequest(raw);
      const draftResult = await query(pool,
        `SELECT * FROM auto_listing_category_strategy_drafts
          WHERE account_id=$1 AND id=$2`,
        [input.accountId, input.draftId]);
      const draft = draftResult.rows[0];
      if (!draft) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
      if (Number(draft.draft_version) !== input.expectedDraftVersion
        || !SAMPLE_REVISION_STATUSES.includes(draft.status)) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
      }
      await requireDraftCurrentSource(pool, draft);
      const sessionResult = await query(pool,
        `SELECT *,expires_at>STATEMENT_TIMESTAMP() AS unexpired
           FROM auto_listing_category_strategy_sampling_sessions
          WHERE account_id=$1 AND draft_id=$2 AND taxonomy_scope=$3
            AND description_category_id=$4 AND type_id=$5 AND id=$6`,
        [input.accountId, input.draftId, draft.taxonomy_scope, draft.description_category_id,
          draft.type_id, input.sessionId]);
      const session = sessionResult.rows[0];
      if (!session) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SESSION_NOT_FOUND", 404);
      if (session.state !== "ACTIVE" || session.unexpired !== true) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SESSION_EXPIRED", 409);
      }
      if (!sameHash(session.session_secret_hash, input.sessionSecretHash)) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SESSION_SECRET_MISMATCH", 409);
      }
      return sessionRow(session, false);
    },

    async getCommittedSampleSetReplay(raw = {}) {
      const input = sampleReplayRequest(raw);
      const result = await query(pool,
        `SELECT sample_set.*,session.session_secret_hash,event.event_payload,
                event.correlation_id AS event_correlation_id
           FROM auto_listing_category_strategy_sample_sets sample_set
           JOIN auto_listing_category_strategy_sampling_sessions session
             ON session.account_id=sample_set.account_id AND session.id=sample_set.session_id
           LEFT JOIN auto_listing_category_strategy_events event
             ON event.account_id=sample_set.account_id AND event.draft_id=sample_set.draft_id
            AND event.idempotency_key=sample_set.idempotency_key
          WHERE sample_set.account_id=$1 AND sample_set.idempotency_key=$2`,
        [input.accountId, input.idempotencyKey]);
      const row = result.rows[0];
      if (!row) return null;
      if (row.status !== "SEALED" || row.draft_id !== input.draftId || row.session_id !== input.sessionId
        || row.correlation_id !== input.correlationId || row.event_correlation_id !== input.correlationId
        || row.event_payload?.event !== "SAMPLE_SET_COMMITTED"
        || Number(row.event_payload?.draftVersion) !== input.expectedDraftVersion + 1
        || !sameHash(row.session_secret_hash, input.sessionSecretHash)) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
      }
      const samples = await query(pool,
        `SELECT sku,source_product_id,source_product_ref
           FROM auto_listing_category_strategy_samples
          WHERE account_id=$1 AND sample_set_id=$2 ORDER BY ordinal ASC`,
        [input.accountId, row.id]);
      if (samples.rows.length !== input.selections.length
        || samples.rows.some((sample, ordinal) => sample.sku !== input.selections[ordinal].sku
          || Number(sample.source_product_id) !== input.selections[ordinal].sourceProductId
          || sample.source_product_ref !== input.selections[ordinal].sourceProductRef)) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
      }
      return sampleSetRow({ ...row, sample_set_id: row.id,
        draft_version: input.expectedDraftVersion + 1, draft_status: "SAMPLES_READY" }, true);
    },

    async startSamplingSession(raw = {}) {
      const input = sessionRequest(raw);
      const action = "START_SAMPLING_SESSION";
      const hash = requestHash({ action, ...input });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        await requireCompatibleEventIdempotency(client, input, action, hash);
        const replay = await query(client,
          `SELECT *,expires_at>STATEMENT_TIMESTAMP() AS unexpired
             FROM auto_listing_category_strategy_sampling_sessions
            WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [input.accountId, input.idempotencyKey]);
        if (replay.rows[0]) {
          if (replay.rows[0].request_hash !== hash) {
            throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
          }
          return sessionRow(replay.rows[0], true);
        }
        await requireMutationEnabled(client, input.accountId);
        const draftResult = await query(client,
          `SELECT * FROM auto_listing_category_strategy_drafts
            WHERE account_id=$1 AND id=$2 FOR UPDATE`,
          [input.accountId, input.draftId]);
        const draft = draftResult.rows[0];
        if (!draft) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
        if (Number(draft.draft_version) !== input.expectedDraftVersion
          || !SAMPLE_REVISION_STATUSES.includes(draft.status)) {
          throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
        }
        await requireDraftCurrentSource(client, draft);
        const clock = await query(client, "SELECT STATEMENT_TIMESTAMP() AS now");
        const expectedExpiry = new Date(clock.rows[0].now).getTime() + (2 * 60 * 60 * 1000);
        if (Math.abs(Date.parse(input.expiresAt) - expectedExpiry) > 60_000) {
          throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SESSION_EXPIRY_INVALID", 409);
        }
        const inserted = await query(client,
          `INSERT INTO auto_listing_category_strategy_sampling_sessions
             (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,session_secret_hash,
              idempotency_key,correlation_id,request_hash,actor_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$2)
           RETURNING *`,
          [input.sessionId, input.accountId, input.draftId, draft.taxonomy_scope,
            draft.description_category_id, draft.type_id, input.sessionSecretHash,
            input.idempotencyKey, input.correlationId, hash]);
        const revision = await query(client,
          `SELECT event_payload FROM auto_listing_category_strategy_events
            WHERE account_id=$1 AND draft_id=$2
              AND event_payload->>'event'='SAMPLE_REVISION_REQUESTED'
              AND event_payload->>'samplingIdempotencyKey'=$3
              AND event_payload->>'samplingCorrelationId'=$4
            ORDER BY created_at DESC,id DESC LIMIT 1`,
          [input.accountId, input.draftId, input.idempotencyKey, input.correlationId]);
        await insertDraftEvent(client, input, draft, "SAMPLING_SESSION_STARTED", hash,
          revision.rows[0] ? { excludedSourceProductId:
            revision.rows[0].event_payload.excludedSourceProductId } : {});
        return sessionRow(inserted.rows[0], false);
      });
    },

    async commitSampleSet(raw = {}) {
      return commitSampleSetCommand(raw, false);
    },

    async commitSampleSetCanonical(raw = {}) {
      return commitSampleSetCommand(raw, true);
    },

    async cancelSamplingSession(raw = {}) {
      const input = sessionCancellationRequest(raw);
      const idempotencyKey = deterministicId("category_sampling_cancel_key", input.accountId, input.sessionId);
      const correlationId = deterministicId("category_sampling_cancel_correlation", input.accountId, input.sessionId);
      const action = "CANCEL_SAMPLING_SESSION";
      const hash = requestHash({ action, ...input, idempotencyKey, correlationId });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const result = await query(client,
          `SELECT session.*,draft.taxonomy_scope AS draft_taxonomy_scope,
                  draft.description_category_id AS draft_description_category_id,
                  draft.type_id AS draft_type_id
             FROM auto_listing_category_strategy_sampling_sessions session
             JOIN auto_listing_category_strategy_drafts draft
               ON draft.account_id=session.account_id AND draft.id=session.draft_id
            WHERE session.account_id=$1 AND session.id=$2 FOR UPDATE OF session,draft`,
          [input.accountId, input.sessionId]);
        const session = result.rows[0];
        if (!session) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SESSION_NOT_FOUND", 404);
        const replay = session.state === "CANCELLED";
        let cancelled = session;
        if (!replay) {
          const update = await query(client,
            `UPDATE auto_listing_category_strategy_sampling_sessions
                SET state='CANCELLED'
              WHERE account_id=$1 AND id=$2 AND state='ACTIVE' RETURNING *`,
            [input.accountId, input.sessionId]);
          cancelled = update.rows[0];
          if (!cancelled) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_SESSION_CANCELLED", 409);
        }
        await query(client,
          `INSERT INTO auto_listing_category_strategy_events
             (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,event_type,event_payload,
              idempotency_key,correlation_id,request_hash,actor_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,'DRAFT_EVENT',$7::JSONB,$8,$9,$10,$2)
           ON CONFLICT (account_id,idempotency_key) DO NOTHING`,
          [deterministicId("category_sampling_cancel_event", input.accountId, input.sessionId), input.accountId,
            cancelled.draft_id, cancelled.taxonomy_scope, cancelled.description_category_id, cancelled.type_id,
            JSON.stringify({ event: "SAMPLING_SESSION_CANCELLED", sessionId: input.sessionId }),
            idempotencyKey, correlationId, hash]);
        return sessionRow(cancelled, replay);
      });
    },

    async loadAnalysisEvidence(raw = {}) {
      const input = analysisEvidenceRequest(raw);
      const draftResult = await query(pool,
        `SELECT * FROM auto_listing_category_strategy_drafts
          WHERE account_id=$1 AND id=$2`,
        [input.accountId, input.draftId]);
      const draft = draftResult.rows[0];
      if (!draft) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
      if (!["SAMPLES_READY", "ANALYZING", "DRAFT_READY", "NEEDS_REVIEW"].includes(draft.status)) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_EVIDENCE_NOT_READY", 409);
      }
      const setResult = await query(pool,
        `SELECT * FROM auto_listing_category_strategy_sample_sets
          WHERE account_id=$1 AND draft_id=$2 AND taxonomy_scope=$3
            AND description_category_id=$4 AND type_id=$5 AND status='SEALED'
          ORDER BY sealed_at DESC,id DESC LIMIT 1`,
        [input.accountId, input.draftId, draft.taxonomy_scope,
          draft.description_category_id, draft.type_id]);
      const set = setResult.rows[0];
      if (!set || Number(set.sample_count) < 5 || Number(set.sample_count) > 20) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_EVIDENCE_NOT_READY", 409);
      }
      const sampleResult = await query(pool,
        `SELECT * FROM auto_listing_category_strategy_samples
          WHERE account_id=$1 AND draft_id=$2 AND sample_set_id=$3
          ORDER BY ordinal ASC,id ASC`,
        [input.accountId, input.draftId, set.id]);
      if (sampleResult.rows.length !== Number(set.sample_count)
        || new Set(sampleResult.rows.map((entry) => entry.sku)).size !== sampleResult.rows.length) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_EVIDENCE_NOT_READY", 409);
      }
      const imageResult = await query(pool,
        `SELECT * FROM auto_listing_category_strategy_sample_images
          WHERE account_id=$1 AND draft_id=$2 AND sample_set_id=$3
          ORDER BY sample_id ASC,ordinal ASC,id ASC`,
        [input.accountId, input.draftId, set.id]);
      const imagesBySample = new Map();
      for (const image of imageResult.rows) {
        const images = imagesBySample.get(image.sample_id) ?? [];
        images.push({ evidenceId: image.id, state: "READY", role: image.role,
          ordinal: Number(image.ordinal), analysisObjectKey: image.analysis_object_key,
          analysisContentHash: image.analysis_content_hash, contentType: image.content_type });
        imagesBySample.set(image.sample_id, images);
      }
      const samples = sampleResult.rows.map((sample) => ({
        sampleId: sample.id, sku: sample.sku, productFacts: { sku: sample.sku },
        images: imagesBySample.get(sample.id) ?? [],
      }));
      if (samples.some((sample) => sample.images.length < 1 || sample.images.length > 6)) {
        throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_EVIDENCE_NOT_READY", 409);
      }
      return { accountId: input.accountId, draftId: input.draftId,
        draftVersion: Number(draft.draft_version), status: draft.status,
        scope: { accountId: input.accountId, taxonomyScope: draft.taxonomy_scope,
          descriptionCategoryId: Number(draft.description_category_id), typeId: Number(draft.type_id) },
        sampleSetId: set.id, sampleSetHash: set.sample_set_hash, samples };
    },

    async reserveAnalysisAttempt(raw = {}) {
      const input = reserveAnalysisRequest(raw);
      if (requestHash(input.modelConfigSnapshot) !== input.modelConfigHash) throw invalid();
      const action = "RESERVE_ANALYSIS_ATTEMPT";
      const { expectedDraftVersion: _concurrencyGuard, ...identity } = input;
      const hash = requestHash({ action, ...identity });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        await requireCompatibleEventIdempotency(client, input, action, hash);
        const replay = await query(client,
          `SELECT * FROM auto_listing_category_strategy_analysis_attempts
            WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [input.accountId, input.idempotencyKey]);
        if (replay.rows[0]) {
          if (replay.rows[0].request_hash !== hash) {
            throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
          }
          const result = await query(client,
            `SELECT result.*,draft.draft_version,draft.status AS draft_status,
                    history.event_payload AS result_event_payload
               FROM auto_listing_category_strategy_analysis_results result
               JOIN auto_listing_category_strategy_drafts draft
                 ON draft.account_id=result.account_id AND draft.id=result.draft_id
               LEFT JOIN auto_listing_category_strategy_events history
                 ON history.account_id=result.account_id AND history.draft_id=result.draft_id
                AND history.taxonomy_scope=result.taxonomy_scope
                AND history.description_category_id=result.description_category_id
                AND history.type_id=result.type_id AND history.event_type='DRAFT_EVENT'
                AND history.event_payload->>'resultId'=result.id
              WHERE result.account_id=$1 AND result.attempt_id=$2 AND result.source_kind='AI'
              FOR UPDATE OF result,draft`,
            [input.accountId, replay.rows[0].id]);
          return { attemptId: replay.rows[0].id, duplicate: true,
            result: result.rows[0] ? analysisResultRow(result.rows[0], true) : null };
        }
        await requireMutationEnabled(client, input.accountId);
        const draftResult = await query(client,
          `SELECT * FROM auto_listing_category_strategy_drafts
            WHERE account_id=$1 AND id=$2 FOR UPDATE`,
          [input.accountId, input.draftId]);
        const draft = draftResult.rows[0];
        if (!draft) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
        if (Number(draft.draft_version) !== input.expectedDraftVersion
          || !["SAMPLES_READY", "DRAFT_READY", "NEEDS_REVIEW"].includes(draft.status)) {
          throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
        }
        await requireDraftCurrentSource(client, draft);
        const set = await query(client,
          `SELECT * FROM auto_listing_category_strategy_sample_sets
            WHERE account_id=$1 AND draft_id=$2 AND taxonomy_scope=$3
              AND description_category_id=$4 AND type_id=$5 AND id=$6
              AND sample_set_hash=$7 AND status='SEALED' FOR UPDATE`,
          [input.accountId, input.draftId, draft.taxonomy_scope, draft.description_category_id,
            draft.type_id, input.sampleSetId, input.sampleSetHash]);
        if (!set.rows[0]) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_EVIDENCE_NOT_READY", 409);
        const attemptId = deterministicId("category_analysis_attempt", input.accountId, input.idempotencyKey);
        const inserted = await query(client,
          `INSERT INTO auto_listing_category_strategy_analysis_attempts
             (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,
              sample_set_hash,analysis_input_hash,model_config_snapshot,model_config_hash,cost_confirmed,
              idempotency_key,correlation_id,request_hash,actor_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::JSONB,$11,TRUE,$12,$13,$14,$2)
           RETURNING *`,
          [attemptId, input.accountId, input.draftId, draft.taxonomy_scope,
            draft.description_category_id, draft.type_id, input.sampleSetId, input.sampleSetHash,
            input.analysisInputHash, JSON.stringify(input.modelConfigSnapshot), input.modelConfigHash,
            input.idempotencyKey, input.correlationId, hash]);
        const advanced = await query(client,
          `UPDATE auto_listing_category_strategy_drafts
              SET status='ANALYZING',draft_version=draft_version+1,updated_at=STATEMENT_TIMESTAMP()
            WHERE account_id=$1 AND id=$2 AND draft_version=$3
              AND status IN ('SAMPLES_READY','DRAFT_READY','NEEDS_REVIEW') RETURNING *`,
          [input.accountId, input.draftId, input.expectedDraftVersion]);
        if (!advanced.rows[0]) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
        await insertAnalysisEvent(client, input, advanced.rows[0], "ANALYSIS_ATTEMPT_RESERVED",
          hash, inserted.rows[0].id);
        return { attemptId: inserted.rows[0].id, duplicate: false, result: null };
      });
    },

    async completeAnalysisAttempt(raw = {}) {
      const input = completeAnalysisRequest(raw);
      const action = "COMPLETE_ANALYSIS_ATTEMPT";
      const hash = requestHash({ action, ...input });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const attemptResult = await query(client,
          `SELECT * FROM auto_listing_category_strategy_analysis_attempts
            WHERE account_id=$1 AND id=$2 FOR UPDATE`,
          [input.accountId, input.attemptId]);
        const attempt = attemptResult.rows[0];
        if (!attempt || attempt.draft_id !== input.draftId
          || attempt.idempotency_key !== input.idempotencyKey
          || attempt.correlation_id !== input.correlationId
          || attempt.analysis_input_hash !== input.analysisInputHash) {
          throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_ATTEMPT_CONFLICT", 409);
        }
        const replay = await query(client,
          `SELECT result.*,draft.draft_version,draft.status AS draft_status,
                  history.event_payload AS result_event_payload
             FROM auto_listing_category_strategy_analysis_results result
             JOIN auto_listing_category_strategy_drafts draft
               ON draft.account_id=result.account_id AND draft.id=result.draft_id
             LEFT JOIN auto_listing_category_strategy_events history
               ON history.account_id=result.account_id AND history.draft_id=result.draft_id
              AND history.taxonomy_scope=result.taxonomy_scope
              AND history.description_category_id=result.description_category_id
              AND history.type_id=result.type_id AND history.event_type='DRAFT_EVENT'
              AND history.event_payload->>'resultId'=result.id
            WHERE result.account_id=$1 AND result.attempt_id=$2 AND result.source_kind='AI'
            FOR UPDATE OF result,draft`,
          [input.accountId, input.attemptId]);
        if (replay.rows[0]) {
          if (replay.rows[0].request_hash !== hash) {
            throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
          }
          return analysisResultRow(replay.rows[0], true);
        }
        await requireMutationEnabled(client, input.accountId);
        const draftResult = await query(client,
          `SELECT * FROM auto_listing_category_strategy_drafts
            WHERE account_id=$1 AND id=$2 FOR UPDATE`,
          [input.accountId, input.draftId]);
        const draft = draftResult.rows[0];
        if (!draft || Number(draft.draft_version) !== input.expectedDraftVersion || draft.status !== "ANALYZING") {
          throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
        }
        await requireDraftCurrentSource(client, draft);
        const resultId = deterministicId("category_analysis_result", input.accountId, input.idempotencyKey);
        const inserted = await query(client,
          `INSERT INTO auto_listing_category_strategy_analysis_results
             (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,
              sample_set_id,sample_set_hash,analysis_input_hash,raw_response,raw_response_hash,
              guidance,guidance_hash,source_kind,idempotency_key,correlation_id,request_hash,actor_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::JSONB,$12,$13::JSONB,$14,'AI',$15,$16,$17,$2)
           RETURNING *`,
          [resultId, input.accountId, input.draftId, attempt.taxonomy_scope,
            attempt.description_category_id, attempt.type_id, input.attemptId, attempt.sample_set_id,
            attempt.sample_set_hash, input.analysisInputHash, JSON.stringify(input.rawResponse),
            input.rawResponseHash, JSON.stringify(input.guidance), input.guidanceHash,
            input.idempotencyKey, input.correlationId, hash]);
        const nextStatus = input.outcome === "ACCEPTED" ? "DRAFT_READY" : "NEEDS_REVIEW";
        const advanced = await query(client,
          `UPDATE auto_listing_category_strategy_drafts
              SET status=$4,draft_version=draft_version+1,updated_at=STATEMENT_TIMESTAMP()
            WHERE account_id=$1 AND id=$2 AND draft_version=$3 AND status='ANALYZING' RETURNING *`,
          [input.accountId, input.draftId, input.expectedDraftVersion, nextStatus]);
        if (!advanced.rows[0]) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
        await insertAnalysisEvent(client, input, advanced.rows[0], "ANALYSIS_RESULT_RECORDED",
          hash, input.attemptId, resultId);
        return analysisResultRow(inserted.rows[0], false,
          Number(advanced.rows[0].draft_version), advanced.rows[0].status);
      });
    },

    async appendManualAnalysisResult(raw = {}) {
      const input = manualAnalysisRequest(raw);
      const action = "APPEND_MANUAL_ANALYSIS_RESULT";
      const hash = requestHash({ action, ...input });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        await requireCompatibleEventIdempotency(client, input, action, hash);
        const replay = await query(client,
          `SELECT result.*,draft.draft_version,draft.status AS draft_status,
                  history.event_payload AS result_event_payload
             FROM auto_listing_category_strategy_analysis_results result
             JOIN auto_listing_category_strategy_drafts draft
               ON draft.account_id=result.account_id AND draft.id=result.draft_id
             LEFT JOIN auto_listing_category_strategy_events history
               ON history.account_id=result.account_id AND history.draft_id=result.draft_id
              AND history.taxonomy_scope=result.taxonomy_scope
              AND history.description_category_id=result.description_category_id
              AND history.type_id=result.type_id AND history.event_type='DRAFT_EVENT'
              AND history.event_payload->>'resultId'=result.id
            WHERE result.account_id=$1 AND result.idempotency_key=$2 AND result.source_kind='MANUAL'
            FOR UPDATE OF result,draft`,
          [input.accountId, input.idempotencyKey]);
        if (replay.rows[0]) {
          if (replay.rows[0].request_hash !== hash) {
            throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
          }
          return analysisResultRow(replay.rows[0], true);
        }
        await requireMutationEnabled(client, input.accountId);
        const draftResult = await query(client,
          `SELECT * FROM auto_listing_category_strategy_drafts
            WHERE account_id=$1 AND id=$2 FOR UPDATE`,
          [input.accountId, input.draftId]);
        const draft = draftResult.rows[0];
        if (!draft || Number(draft.draft_version) !== input.expectedDraftVersion
          || !["DRAFT_READY", "NEEDS_REVIEW"].includes(draft.status)) {
          throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
        }
        await requireDraftCurrentSource(client, draft);
        const attemptResult = await query(client,
          `SELECT attempt.* FROM auto_listing_category_strategy_analysis_attempts attempt
            WHERE attempt.account_id=$1 AND attempt.draft_id=$2 AND attempt.taxonomy_scope=$3
              AND attempt.description_category_id=$4 AND attempt.type_id=$5 AND attempt.id=$6
            FOR UPDATE`,
          [input.accountId, input.draftId, draft.taxonomy_scope, draft.description_category_id,
            draft.type_id, input.baseAnalysisAttemptId]);
        const attempt = attemptResult.rows[0];
        if (!attempt) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_ATTEMPT_CONFLICT", 409);
        const baseAi = await query(client,
          `SELECT id FROM auto_listing_category_strategy_analysis_results
            WHERE account_id=$1 AND attempt_id=$2 AND source_kind='AI' FOR UPDATE`,
          [input.accountId, input.baseAnalysisAttemptId]);
        if (!baseAi.rows[0]) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_ATTEMPT_CONFLICT", 409);
        const resultId = deterministicId("category_manual_analysis_result", input.accountId, input.idempotencyKey);
        const manualRaw = { sourceKind: "MANUAL", baseAnalysisAttemptId: input.baseAnalysisAttemptId };
        const inserted = await query(client,
          `INSERT INTO auto_listing_category_strategy_analysis_results
             (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,
              sample_set_id,sample_set_hash,analysis_input_hash,raw_response,raw_response_hash,
              guidance,guidance_hash,source_kind,edited_by,edited_at,base_analysis_attempt_id,
              idempotency_key,correlation_id,request_hash,actor_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::JSONB,$12,$13::JSONB,$14,
             'MANUAL',$2,STATEMENT_TIMESTAMP(),$7,$15,$16,$17,$2) RETURNING *`,
          [resultId, input.accountId, input.draftId, attempt.taxonomy_scope,
            attempt.description_category_id, attempt.type_id, input.baseAnalysisAttemptId,
            attempt.sample_set_id, attempt.sample_set_hash, attempt.analysis_input_hash,
            JSON.stringify(manualRaw), requestHash(manualRaw), JSON.stringify(input.guidance),
            input.guidanceHash, input.idempotencyKey, input.correlationId, hash]);
        const advanced = await query(client,
          `UPDATE auto_listing_category_strategy_drafts
              SET status='DRAFT_READY',draft_version=draft_version+1,updated_at=STATEMENT_TIMESTAMP()
            WHERE account_id=$1 AND id=$2 AND draft_version=$3
              AND status IN ('DRAFT_READY','NEEDS_REVIEW') RETURNING *`,
          [input.accountId, input.draftId, input.expectedDraftVersion]);
        if (!advanced.rows[0]) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
        await insertAnalysisEvent(client, input, advanced.rows[0], "ANALYSIS_MANUAL_EDITED",
          hash, input.baseAnalysisAttemptId, resultId);
        return analysisResultRow(inserted.rows[0], false,
          Number(advanced.rows[0].draft_version), advanced.rows[0].status);
      });
    },

    async transitionAccountPolicy(raw = {}) {
      const input = policyRequest(raw);
      const action = "TRANSITION_ACCOUNT_POLICY";
      const hash = requestHash({ action, ...input });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        await requireCompatibleEventIdempotency(client, input, action, hash);
        const replay = await query(client,
          `SELECT event.account_id,event.request_hash,event.event_payload,
                  event.settings_version AS version,event.event_payload->>'mode' AS mode
             FROM auto_listing_category_strategy_events event
            WHERE event.account_id=$1 AND event.idempotency_key=$2
              AND event.event_type='ACCOUNT_SETTINGS_CHANGED' FOR UPDATE OF event`,
          [input.accountId, input.idempotencyKey]);
        if (replay.rows[0]) {
          if (replay.rows[0].request_hash !== hash || replay.rows[0].event_payload?.mode !== input.mode) {
            throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
          }
          return policyRow(replay.rows[0], true);
        }
        const current = await query(client,
          "SELECT * FROM auto_listing_category_strategy_account_settings WHERE account_id=$1 FOR UPDATE",
          [input.accountId]);
        if (!current.rows[0]) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_ACCOUNT_NOT_FOUND", 404);
        if (Number(current.rows[0].version) !== input.expectedVersion) {
          throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_POLICY_VERSION_CONFLICT", 409);
        }
        if (current.rows[0].mode === input.mode) {
          throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_POLICY_TRANSITION_INVALID", 409);
        }
        const updated = await query(client,
          `UPDATE auto_listing_category_strategy_account_settings
              SET mode=$2,version=version+1,idempotency_key=$3,correlation_id=$4,
                  request_hash=$5,actor_account_id=$1
            WHERE account_id=$1 AND version=$6
            RETURNING *`,
          [input.accountId, input.mode, input.idempotencyKey, input.correlationId, hash, input.expectedVersion]);
        if (!updated.rows[0]) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_POLICY_VERSION_CONFLICT", 409);
        return policyRow(updated.rows[0], false);
      });
    },

    async getAccountPolicy(raw = {}) {
      const value = closed(raw, new Set(["accountId"]));
      const accountId = id(value.accountId);
      const result = await query(pool,
        "SELECT * FROM auto_listing_category_strategy_account_settings WHERE account_id=$1",
        [accountId]);
      return policyRow(result.rows[0], false);
    },
  });
}
