import crypto from "node:crypto";

import { projectCategoryStrategyScope } from "./auto-listing-category-strategy-contract.mjs";

const FACTORY_KEYS = new Set(["pool"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const SAFE_OBJECT_KEY = /^[A-Za-z0-9._/-]+$/u;
const MODES = new Set(["LEGACY_FALLBACK", "REQUIRE_EXACT_STRATEGY"]);

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
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
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
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw invalid();
    return [key, canonical(value[key])];
  }));
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

async function requireCompatibleEventIdempotency(client, { accountId, idempotencyKey }, hash) {
  const result = await query(client,
    `SELECT request_hash FROM auto_listing_category_strategy_events
      WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
    [accountId, idempotencyKey]);
  if (result.rows[0] && result.rows[0].request_hash !== hash) {
    throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
  }
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

function sampleEvidence(raw, context) {
  const value = closed(raw, new Set([
    "sampleSetId", "sampleId", "sku", "sourceProductId", "sourceProductRef", "sourceProductResponseHash",
    "taxonomyScope", "descriptionCategoryId", "typeId", "images",
  ]));
  const sampleSetId = id(value.sampleSetId);
  const sampleId = id(value.sampleId);
  if (value.taxonomyScope !== context.scope.taxonomyScope
    || value.descriptionCategoryId !== context.scope.descriptionCategoryId
    || value.typeId !== context.scope.typeId || !Array.isArray(value.images)
    || value.images.length < 1 || value.images.length > 6) throw invalid();
  const images = value.images.map((image) => imageEvidence(image, {
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

function commitRequest(raw) {
  const value = closed(raw, new Set([
    "accountId", "actorId", "draftId", "sessionId", "sessionSecretHash", "expectedDraftVersion", "samples",
    "sampleSetHash", "idempotencyKey", "correlationId",
  ]));
  const accountId = sameActor(value);
  if (!Array.isArray(value.samples) || value.samples.length < 5 || value.samples.length > 20) throw invalid();
  const input = {
    accountId, actorId: accountId, draftId: id(value.draftId), sessionId: id(value.sessionId),
    sessionSecretHash: sha256(value.sessionSecretHash),
    expectedDraftVersion: positiveInteger(value.expectedDraftVersion),
    sampleSetHash: sha256(value.sampleSetHash), idempotencyKey: id(value.idempotencyKey),
    correlationId: id(value.correlationId),
  };
  const rawScope = value.samples[0];
  input.scope = {
    taxonomyScope: rawScope?.taxonomyScope,
    descriptionCategoryId: rawScope?.descriptionCategoryId,
    typeId: rawScope?.typeId,
  };
  input.samples = value.samples.map((entry) => sampleEvidence(entry, input));
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

async function insertDraftEvent(client, input, draft, eventName, hash) {
  await query(client,
    `INSERT INTO auto_listing_category_strategy_events
       (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,event_type,event_payload,
        idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,$3,$4,$5,$6,'DRAFT_EVENT',$7::JSONB,$8,$9,$10,$2)`,
    [deterministicId("category_strategy_event", input.accountId, input.idempotencyKey), input.accountId,
      draft.id, draft.taxonomy_scope, draft.description_category_id, draft.type_id,
      JSON.stringify({ event: eventName, draftVersion: Number(draft.draft_version), status: draft.status }),
      input.idempotencyKey, input.correlationId, hash]);
}

export function createAutoListingCategoryStrategyPostgres(rawOptions = {}) {
  const options = closed(rawOptions, FACTORY_KEYS);
  const { pool } = options;
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") throw invalid();

  return Object.freeze({
    async createDraft(raw = {}) {
      const input = createDraftRequest(raw);
      const hash = requestHash({ action: "CREATE_DRAFT", ...input });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        await requireCompatibleEventIdempotency(client, input, hash);
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

    async startSamplingSession(raw = {}) {
      const input = sessionRequest(raw);
      const hash = requestHash({ action: "START_SAMPLING_SESSION", ...input });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        await requireCompatibleEventIdempotency(client, input, hash);
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
        const draftResult = await query(client,
          `SELECT * FROM auto_listing_category_strategy_drafts
            WHERE account_id=$1 AND id=$2 FOR UPDATE`,
          [input.accountId, input.draftId]);
        const draft = draftResult.rows[0];
        if (!draft) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
        if (Number(draft.draft_version) !== input.expectedDraftVersion || draft.status !== "COLLECTING") {
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
        await insertDraftEvent(client, input, draft, "SAMPLING_SESSION_STARTED", hash);
        return sessionRow(inserted.rows[0], false);
      });
    },

    async commitSampleSet(raw = {}) {
      const input = commitRequest(raw);
      const hash = requestHash({ action: "COMMIT_SAMPLE_SET", ...input });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        await requireCompatibleEventIdempotency(client, input, hash);
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
            || replay.rows[0].sample_set_hash !== input.sampleSetHash) {
            throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
          }
          return sampleSetRow({ ...replay.rows[0], draft_status: "SAMPLES_READY",
            draft_version: input.expectedDraftVersion + 1 }, true);
        }
        const draftResult = await query(client,
          `SELECT * FROM auto_listing_category_strategy_drafts
            WHERE account_id=$1 AND id=$2 FOR UPDATE`,
          [input.accountId, input.draftId]);
        const draft = draftResult.rows[0];
        if (!draft) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
        if (Number(draft.draft_version) !== input.expectedDraftVersion || draft.status !== "COLLECTING") {
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
        if (canonicalHash !== input.sampleSetHash) {
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
            WHERE account_id=$1 AND id=$2 AND draft_version=$3 AND status='COLLECTING'
            RETURNING *`,
          [input.accountId, input.draftId, input.expectedDraftVersion]);
        if (!advanced.rows[0]) throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
        await insertDraftEvent(client, input, advanced.rows[0], "SAMPLE_SET_COMMITTED", hash);
        return sampleSetRow({ ...sealed.rows[0], draft_version: advanced.rows[0].draft_version,
          draft_status: advanced.rows[0].status }, false);
      });
    },

    async transitionAccountPolicy(raw = {}) {
      const input = policyRequest(raw);
      const hash = requestHash({ action: "TRANSITION_ACCOUNT_POLICY", ...input });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        await requireCompatibleEventIdempotency(client, input, hash);
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
