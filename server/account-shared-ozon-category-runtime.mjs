import crypto from "node:crypto";
import { types } from "node:util";
import {
  createJsonAccountSharedOzonCategoryRepository,
  createPostgresAccountSharedOzonCategoryRepository,
} from "./account-shared-ozon-category-repository.mjs";
import {
  createAccountSharedOzonCategoryService,
  publicAccountSharedCategorySelection,
} from "./account-shared-ozon-category-service.mjs";
import { createOzonSourceCategoryLookup } from "./ozon-source-category-lookup.mjs";
import { getPostgresPool } from "./db/connection.mjs";

const CONFIRM_KEYS = Object.freeze([
  "actor", "collectItemId", "expectedSourceVersion", "descriptionCategoryId",
  "typeId", "taxonomyScope", "idempotencyKey", "correlationId",
]);
const BODY_KEYS = Object.freeze(CONFIRM_KEYS.filter((key) => key !== "actor"));
const CATEGORY_STATE_KEYS = Object.freeze([
  "collectOzonCategorySourceEvidence",
  "accountOzonSharedCategories",
  "accountOzonSharedCategoryEvents",
  "accountOzonCategoryConfirmations",
  "collectOzonCategoryLookupEvidence",
  "collectOzonCategoryCurrentSources",
]);

function runtimeError(code, status = 400) {
  return Object.assign(new Error("Account-shared Ozon category operation failed"), { code, status });
}

function exactObject(value, keys, code = "OZON_CATEGORY_CONFIRMATION_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw runtimeError(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key) || descriptors[key].get
      || descriptors[key].set || descriptors[key].enumerable !== true)) throw runtimeError(code);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function text(value, maximum = 240, code = "OZON_CATEGORY_CONFIRMATION_INVALID") {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) throw runtimeError(code);
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw runtimeError("OZON_CATEGORY_CONFIRMATION_INVALID");
  return value;
}

function categoryOf(item = {}) {
  const draft = item?.listingDraft && typeof item.listingDraft === "object"
    && !Array.isArray(item.listingDraft) ? item.listingDraft : {};
  const category = draft.sourceCategory && typeof draft.sourceCategory === "object"
    ? draft.sourceCategory
    : item.sourceCategory && typeof item.sourceCategory === "object" ? item.sourceCategory : {};
  const sourceDescriptionCategoryId = Number(
    category.descriptionCategoryId ?? category.description_category_id,
  );
  const sourceTypeId = Number(
    category.typeIdCandidate ?? category.typeId ?? category.type_id_candidate ?? category.type_id,
  );
  const normalizedPath = Array.isArray(category.path)
    ? category.path.map((part) => String(part || "").trim().slice(0, 160)).filter(Boolean).slice(0, 32)
    : [];
  const attributes = Array.isArray(category.attributes) ? category.attributes : [];
  const attributeSummary = attributes.slice(0, 100).flatMap((attribute) => {
    const key = String(attribute?.key ?? attribute?.id ?? "").trim().slice(0, 80);
    if (!key) return [];
    const rawValue = attribute?.value ?? null;
    const value = rawValue === null || typeof rawValue === "boolean"
      || (typeof rawValue === "number" && Number.isFinite(rawValue))
      || (typeof rawValue === "string" && rawValue.length <= 500) ? rawValue : null;
    const dictionaryValueId = Number(
      attribute?.dictionaryValueId ?? attribute?.dictionary_value_id,
    );
    return [{ key, value, ...(Number.isSafeInteger(dictionaryValueId) && dictionaryValueId > 0
      ? { dictionaryValueId } : {}) }];
  });
  return {
    sourceDescriptionCategoryId: Number.isSafeInteger(sourceDescriptionCategoryId)
      && sourceDescriptionCategoryId > 0 ? sourceDescriptionCategoryId : null,
    sourceTypeId: Number.isSafeInteger(sourceTypeId) && sourceTypeId > 0 ? sourceTypeId : null,
    normalizedPath,
    attributeSummary,
  };
}

function productIdOf(item = {}) {
  const candidates = [
    item.ozonProductId, item.productId, item.product_id, item.variantData?.id,
    item.variantData?.product_id,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return null;
}

function itemSku(item = {}) {
  const value = item.sourceSku ?? item.offerId ?? item.offer_id ?? item.sku ?? null;
  return value === null ? null : String(value).trim().slice(0, 240) || null;
}

function findJsonItem(state, accountId, collectItemId) {
  return (Array.isArray(state?.caches?.collectBox) ? state.caches.collectBox : []).find((item) =>
    String(item?.accountId || "") === accountId
    && String(item?.id || "") === collectItemId
    && item?.deletedAt == null && String(item?.status || "") !== "DELETED") || null;
}

function lookupCredentialInState(state, accountId) {
  const storeId = String(state?.currentStoreIdsByAccount?.[accountId] || "");
  if (!storeId) return null;
  return (Array.isArray(state?.stores) ? state.stores : []).find((store) =>
    String(store?.id || "") === storeId
    && String(store?.ownerAccountId ?? store?.accountId ?? "") === accountId) || null;
}

function recordInput(input) {
  const item = input.item && typeof input.item === "object" ? input.item : {};
  const category = categoryOf(item);
  const capturedAt = new Date(input.capturedAt ?? item.capturedAt ?? item.updatedAt ?? new Date());
  if (Number.isNaN(capturedAt.getTime())) throw runtimeError("OZON_CATEGORY_SOURCE_INVALID");
  return {
    accountId: text(input.accountId, 240, "OZON_CATEGORY_SOURCE_INVALID"),
    collectItemId: text(input.collectItemId, 240, "OZON_CATEGORY_SOURCE_INVALID"),
    sourceVersion: text(input.sourceVersion, 240, "OZON_CATEGORY_SOURCE_INVALID"),
    productDraftId: text(input.productDraftId, 240, "OZON_CATEGORY_SOURCE_INVALID"),
    productDraftVersion: positiveInteger(Number(input.productDraftVersion)),
    ozonProductId: productIdOf(item),
    sourceSku: itemSku(item),
    taxonomyScope: "OZON:DEFAULT",
    ...category,
    capturedAt: capturedAt.toISOString(),
    rawResponseRef: text(input.rawResponseRef, 240, "OZON_CATEGORY_SOURCE_INVALID"),
    rawResponseHash: text(input.rawResponseHash, 64, "OZON_CATEGORY_SOURCE_INVALID"),
  };
}

function confirmationInput(input) {
  const value = exactObject(input, CONFIRM_KEYS);
  const actor = exactObject(value.actor, ["id", "role"]);
  const accountId = text(actor.id);
  if (actor.role !== "admin") throw runtimeError("PERMISSION_FORBIDDEN", 403);
  const normalized = {
    actor: Object.freeze({ id: accountId, role: "admin" }),
    collectItemId: text(value.collectItemId),
    expectedSourceVersion: text(value.expectedSourceVersion),
    descriptionCategoryId: positiveInteger(value.descriptionCategoryId),
    typeId: positiveInteger(value.typeId),
    taxonomyScope: text(value.taxonomyScope, 80),
    idempotencyKey: text(value.idempotencyKey),
    correlationId: text(value.correlationId),
  };
  if (normalized.taxonomyScope !== "OZON:DEFAULT") {
    throw runtimeError("OZON_CATEGORY_CONFIRMATION_INVALID");
  }
  return normalized;
}

function confirmationHash(input) {
  return crypto.createHash("sha256").update(JSON.stringify({
    collectItemId: input.collectItemId,
    expectedSourceVersion: input.expectedSourceVersion,
    descriptionCategoryId: input.descriptionCategoryId,
    typeId: input.typeId,
    taxonomyScope: input.taxonomyScope,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
  })).digest("hex");
}

function confirmationEventId(input) {
  return `ozon_category_confirmation_${crypto.createHash("sha256")
    .update(`${input.actor.id}\u0000${input.idempotencyKey}`).digest("hex")}`;
}

function manualConfirmation(input, source, shared) {
  if (!source || source.accountId !== input.actor.id
    || source.collectItemId !== input.collectItemId
    || source.sourceVersion !== input.expectedSourceVersion) {
    throw runtimeError("OZON_CATEGORY_CONFIRMATION_SOURCE_VERSION_CONFLICT", 409);
  }
  const expectedVersion = shared?.version;
  if (!expectedVersion) throw runtimeError("OZON_CATEGORY_CONFIRMATION_STATE_CONFLICT", 409);
  return {
    evidenceId: source.id,
    expectedVersion,
    taxonomyFingerprint: crypto.createHash("sha256")
      .update(`${input.taxonomyScope}:${input.descriptionCategoryId}:${input.typeId}`).digest("hex"),
  };
}

function replayConfirmation(metadata, input, requestHash) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || metadata.requestHash !== requestHash) {
    throw runtimeError("OZON_CATEGORY_CONFIRMATION_IDEMPOTENCY_CONFLICT", 409);
  }
  const result = exactObject(metadata.result, ["collectItemId", "categoryResolution"]);
  if (result.collectItemId !== input.collectItemId) {
    throw runtimeError("OZON_CATEGORY_CONFIRMATION_IDEMPOTENCY_CONFLICT", 409);
  }
  const resolution = exactObject(result.categoryResolution, [
    "status", "taxonomyScope", "sourceDescriptionCategoryId", "sourceTypeId",
    "currentDescriptionCategoryId", "currentTypeId", "source", "version",
    "validatedAt", "action", "message",
  ]);
  if (resolution.source !== "MANUAL" || resolution.status !== "ACTIVE"
    || resolution.taxonomyScope !== input.taxonomyScope
    || resolution.currentDescriptionCategoryId !== input.descriptionCategoryId
    || resolution.currentTypeId !== input.typeId
    || !Number.isSafeInteger(resolution.version) || resolution.version <= 0
    || typeof resolution.validatedAt !== "string") {
    throw runtimeError("OZON_CATEGORY_CONFIRMATION_IDEMPOTENCY_CONFLICT", 409);
  }
  return deepFreeze(structuredClone(result));
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function commitCategoryState(target, source) {
  for (const key of CATEGORY_STATE_KEYS) target[key] = source[key];
}

export function createAccountSharedOzonCategoryRuntime({
  loadState,
  saveState,
  stateTransaction,
  persistenceMode,
  sourceLookup = null,
  initializePostgresRepository = null,
  initializePostgresTransactionRepository = null,
  postgresPool = getPostgresPool,
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
} = {}) {
  if (typeof loadState !== "function" || typeof saveState !== "function"
    || typeof stateTransaction?.run !== "function" || typeof persistenceMode !== "function"
    || typeof now !== "function" || typeof randomUUID !== "function"
    || typeof postgresPool !== "function"
    || (initializePostgresTransactionRepository !== null
      && typeof initializePostgresTransactionRepository !== "function")) {
    throw new TypeError("Account-shared category runtime dependencies required");
  }
  const lookup = sourceLookup || createOzonSourceCategoryLookup({ now });
  let postgresRepositoryPromise = null;
  function postgresRepository() {
    if (!postgresRepositoryPromise) {
      postgresRepositoryPromise = Promise.resolve().then(async () => (
        initializePostgresRepository
          ? initializePostgresRepository()
          : createPostgresAccountSharedOzonCategoryRepository({ pool: await postgresPool(), idFactory: randomUUID, now })
      ));
      postgresRepositoryPromise.catch(() => { postgresRepositoryPromise = null; });
    }
    return postgresRepositoryPromise;
  }

  function jsonPorts(state) {
    const repository = createJsonAccountSharedOzonCategoryRepository({ state, idFactory: randomUUID, now });
    const service = createAccountSharedOzonCategoryService({ repository, sourceLookup: lookup, now });
    return { repository, service };
  }

  async function recordCollectionResult(input = {}) {
    const execute = async (state, persist) => {
      const prepared = recordInput(input);
      const { service } = jsonPorts(state);
      const result = prepared.sourceDescriptionCategoryId && prepared.sourceTypeId
        ? await service.recordCollectionSource(prepared)
        : await service.resolveCollectionSource({
            ...prepared,
            lookupContext: input.lookupContext || {
              accountId: prepared.accountId,
              store: input.store || lookupCredentialInState(state, prepared.accountId),
              ozonProductId: prepared.ozonProductId,
              sourceSku: prepared.sourceSku,
            },
          });
      if (persist) await saveState(state);
      return result;
    };
    if (input.state) return execute(input.state, false);
    if (persistenceMode() === "postgres" || input.postgresExecutor) {
      let preparedInput = input;
      if (input.postgresExecutor && (!input.productDraftId || !input.rawResponseRef)) {
        const row = (await input.postgresExecutor.query(
          `SELECT d.id AS product_draft_id,d.version AS product_draft_version,r.id AS raw_response_ref,
                  r.payload_hash AS raw_response_hash,COALESCE(r.collected_at,r.created_at) AS captured_at
             FROM collect_items c
             JOIN product_drafts d ON d.id=c.current_draft_id AND d.collect_item_id=c.id
             JOIN collect_raw_payloads r ON r.id=d.source_payload_id
            WHERE c.account_id=$1 AND c.id=$2 AND c.deleted_at IS NULL LIMIT 1`,
          [String(input.accountId || ""), String(input.collectItemId || "")],
        )).rows[0];
        if (!row) throw runtimeError("OZON_CATEGORY_SOURCE_INVALID");
        preparedInput = {
          ...input,
          productDraftId: row.product_draft_id,
          productDraftVersion: Number(row.product_draft_version),
          sourceVersion: `draft:${Number(row.product_draft_version)}`,
          rawResponseRef: row.raw_response_ref,
          rawResponseHash: row.raw_response_hash,
          capturedAt: new Date(row.captured_at).toISOString(),
        };
      }
      const prepared = recordInput(preparedInput);
      const repository = input.postgresExecutor
        ? createPostgresAccountSharedOzonCategoryRepository({
            pool: input.postgresExecutor,
            transactionOwner: "caller",
            idFactory: randomUUID,
            now,
          })
        : await postgresRepository();
      const service = createAccountSharedOzonCategoryService({
        repository, sourceLookup: lookup, now,
      });
      let lookupContext = input.lookupContext;
      if (!lookupContext && (!prepared.sourceDescriptionCategoryId || !prepared.sourceTypeId)) {
        const credentialState = input.state || await loadState();
        lookupContext = {
          accountId: prepared.accountId,
          store: input.store || lookupCredentialInState(credentialState, prepared.accountId),
          ozonProductId: prepared.ozonProductId,
          sourceSku: prepared.sourceSku,
        };
      }
      return prepared.sourceDescriptionCategoryId && prepared.sourceTypeId
        ? service.recordCollectionSource(prepared)
        : service.resolveCollectionSource({ ...prepared, lookupContext });
    }
    return stateTransaction.run(async () => {
      const state = await loadState();
      const working = structuredClone(state);
      const result = await execute(working, false);
      await saveState(working);
      commitCategoryState(state, working);
      return result;
    });
  }

  async function readForItems(input) {
    if (persistenceMode() === "postgres") {
      return createAccountSharedOzonCategoryService({
        repository: await postgresRepository(), sourceLookup: lookup, now,
      }).readForItems(input);
    }
    return stateTransaction.run(async () => jsonPorts(await loadState()).service.readForItems(input));
  }

  async function confirmInJson(state, rawInput, persist) {
    const input = confirmationInput(rawInput);
    state.accountOzonCategoryConfirmations = Array.isArray(state.accountOzonCategoryConfirmations)
      ? state.accountOzonCategoryConfirmations : [];
    const requestHash = confirmationHash(input);
    const existing = state.accountOzonCategoryConfirmations.find((row) =>
      row.accountId === input.actor.id && row.idempotencyKey === input.idempotencyKey);
    if (existing) {
      return replayConfirmation({
        requestHash: existing.requestHash,
        result: existing.result,
      }, input, requestHash);
    }
    const item = findJsonItem(state, input.actor.id, input.collectItemId);
    if (!item) throw runtimeError("OZON_CATEGORY_CONFIRMATION_ITEM_NOT_FOUND", 404);
    const { repository } = jsonPorts(state);
    const current = await repository.readCurrentEvidence({
      accountId: input.actor.id, collectItemIds: [input.collectItemId],
    });
    const source = current[0];
    if (!source || source.sourceVersion !== input.expectedSourceVersion) {
      throw runtimeError("OZON_CATEGORY_CONFIRMATION_SOURCE_VERSION_CONFLICT", 409);
    }
    const sharedRows = await repository.readSharedForEvidence({
      accountId: input.actor.id, evidenceIds: [source.id],
    });
    const confirmedAt = new Date(now());
    if (Number.isNaN(confirmedAt.getTime())) throw runtimeError("OZON_CATEGORY_CONFIRMATION_FAILED", 500);
    const prepared = manualConfirmation(
      input, source, sharedRows[0],
    );
    const shared = await repository.confirmManualCategory({
      accountId: input.actor.id,
      evidenceId: prepared.evidenceId,
      expectedVersion: prepared.expectedVersion,
      currentDescriptionCategoryId: input.descriptionCategoryId,
      currentTypeId: input.typeId,
      taxonomyFingerprint: prepared.taxonomyFingerprint,
      validatedAt: confirmedAt.toISOString(),
    });
    const result = deepFreeze({
      collectItemId: input.collectItemId,
      categoryResolution: publicAccountSharedCategorySelection(shared),
    });
    state.accountOzonCategoryConfirmations.push({
      accountId: input.actor.id,
      collectItemId: input.collectItemId,
      expectedSourceVersion: input.expectedSourceVersion,
      descriptionCategoryId: input.descriptionCategoryId,
      typeId: input.typeId,
      taxonomyScope: input.taxonomyScope,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      requestHash,
      actor: structuredClone(input.actor),
      confirmedAt: confirmedAt.toISOString(),
      result: structuredClone(result),
    });
    if (persist) await saveState(state);
    return result;
  }

  async function confirmManualCategory(input) {
    if (persistenceMode() === "postgres") {
      const normalized = confirmationInput(input);
      const requestHash = confirmationHash(normalized);
      const eventId = confirmationEventId(normalized);
      let client;
      let committed = false;
      try {
        const pool = await postgresPool();
        client = await pool.connect();
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '25s'");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [eventId],
        );
        const audit = await client.query(
          `SELECT request_hash,result_json FROM account_ozon_category_confirmation_audit
            WHERE id=$1 AND account_id=$2
            FOR UPDATE`,
          [eventId, normalized.actor.id],
        );
        if (audit.rows?.[0]) {
          const replay = replayConfirmation({
            requestHash: audit.rows[0].request_hash,
            result: audit.rows[0].result_json,
          }, normalized, requestHash);
          await client.query("COMMIT");
          committed = true;
          return replay;
        }
        const repository = initializePostgresTransactionRepository
          ? await initializePostgresTransactionRepository(client)
          : createPostgresAccountSharedOzonCategoryRepository({
              pool: client, transactionOwner: "caller", idFactory: randomUUID, now,
            });
        const current = await repository.readCurrentEvidence({
          accountId: normalized.actor.id, collectItemIds: [normalized.collectItemId],
        });
        const source = current[0];
        if (!source) throw runtimeError("OZON_CATEGORY_CONFIRMATION_ITEM_NOT_FOUND", 404);
        const sharedRows = await repository.readSharedForEvidence({
          accountId: normalized.actor.id, evidenceIds: [source.id],
        });
        const confirmedAt = new Date(now());
        if (Number.isNaN(confirmedAt.getTime())) {
          throw runtimeError("OZON_CATEGORY_CONFIRMATION_FAILED", 500);
        }
        const prepared = manualConfirmation(
          normalized, source, sharedRows[0],
        );
        const shared = await repository.confirmManualCategory({
          accountId: normalized.actor.id,
          evidenceId: prepared.evidenceId,
          expectedVersion: prepared.expectedVersion,
          currentDescriptionCategoryId: normalized.descriptionCategoryId,
          currentTypeId: normalized.typeId,
          taxonomyFingerprint: prepared.taxonomyFingerprint,
          validatedAt: confirmedAt.toISOString(),
        });
        const result = deepFreeze({
          collectItemId: normalized.collectItemId,
          categoryResolution: publicAccountSharedCategorySelection(shared),
        });
        const insertedConfirmation = await client.query(
          `INSERT INTO account_ozon_category_confirmation_audit (
             id,account_id,collect_item_id,source_evidence_id,expected_source_version,
             selected_description_category_id,selected_type_id,taxonomy_scope,actor_id,
             correlation_id,idempotency_key,request_hash,result_json,confirmed_at,created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$2,$9,$10,$11,$12::jsonb,$13,$13)
           ON CONFLICT (account_id,idempotency_key) DO NOTHING RETURNING id`,
          [eventId, normalized.actor.id, normalized.collectItemId, source.id,
            normalized.expectedSourceVersion, normalized.descriptionCategoryId, normalized.typeId,
            normalized.taxonomyScope, normalized.correlationId, normalized.idempotencyKey,
            requestHash, JSON.stringify(result), confirmedAt.toISOString()],
        );
        if (insertedConfirmation.rowCount !== 1) {
          throw runtimeError("OZON_CATEGORY_CONFIRMATION_IDEMPOTENCY_CONFLICT", 409);
        }
        const inserted = await client.query(
          `INSERT INTO audit_events (
             event_id,account_id,store_id,action,status,actor_type,actor_id,device_id,source,
             entity_type,entity_id,correlation_id,metadata,occurred_at,created_at
           ) VALUES ($1,$2,NULL,'OZON_CATEGORY_CONFIRMATION','SUCCESS','account',$2,'','category-admin',
             'collect_item',$3,$4,$5::jsonb,$6,$6)
           ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING RETURNING event_id`,
          [eventId, normalized.actor.id, normalized.collectItemId, normalized.correlationId,
            JSON.stringify({ requestHash, result }), confirmedAt.toISOString()],
        );
        if (inserted.rowCount !== 1) {
          throw runtimeError("OZON_CATEGORY_CONFIRMATION_IDEMPOTENCY_CONFLICT", 409);
        }
        await client.query("COMMIT");
        committed = true;
        return result;
      } catch (error) {
        if (client && !committed) await client.query("ROLLBACK").catch(() => {});
        if (typeof error?.code === "string" && (error.code.startsWith("OZON_CATEGORY_")
          || error.code === "PERMISSION_FORBIDDEN")) throw error;
        throw runtimeError("OZON_CATEGORY_CONFIRMATION_FAILED", 503);
      } finally {
        try { client?.release(); } catch { /* best effort */ }
      }
    }
    return stateTransaction.run(async () => {
      const state = await loadState();
      const working = structuredClone(state);
      const result = await confirmInJson(working, input, false);
      await saveState(working);
      commitCategoryState(state, working);
      return result;
    });
  }

  function createHttpHandler({ authenticate, readJson, sendJson } = {}) {
    if (typeof authenticate !== "function" || typeof readJson !== "function"
      || typeof sendJson !== "function") throw new TypeError("Category confirmation HTTP dependencies required");
    return async function handle(req, res, url) {
      if (url.pathname !== "/ozon/category-confirmations") return false;
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, code: "OZON_CATEGORY_CONFIRMATION_METHOD_NOT_ALLOWED", message: "不支持的类目确认请求方法" });
        return true;
      }
      try {
        const actor = await authenticate(req);
        if (actor?.role !== "admin") throw runtimeError("PERMISSION_FORBIDDEN", 403);
        let body;
        try { body = exactObject(await readJson(req), BODY_KEYS); } catch { throw runtimeError("OZON_CATEGORY_CONFIRMATION_INVALID"); }
        const result = await confirmManualCategory({ actor: { id: actor.id, role: actor.role }, ...body });
        sendJson(res, 200, { ok: true, data: result });
      } catch (error) {
        const code = [
          "PERMISSION_FORBIDDEN", "OZON_CATEGORY_CONFIRMATION_INVALID",
          "OZON_CATEGORY_CONFIRMATION_IDEMPOTENCY_CONFLICT",
          "OZON_CATEGORY_CONFIRMATION_SOURCE_VERSION_CONFLICT",
          "OZON_CATEGORY_CONFIRMATION_ITEM_NOT_FOUND",
          "OZON_CATEGORY_CONFIRMATION_STATE_CONFLICT",
          "OZON_CATEGORY_CONFIRMATION_UNAVAILABLE",
        ].includes(error?.code) ? error.code : "OZON_CATEGORY_CONFIRMATION_FAILED";
        const status = code === "OZON_CATEGORY_CONFIRMATION_FAILED" ? 500
          : Number(error?.status) >= 400 && Number(error?.status) <= 599 ? Number(error.status) : 422;
        sendJson(res, status, {
          ok: false,
          code,
          message: code === "PERMISSION_FORBIDDEN" ? "没有类目确认权限"
            : status >= 500 ? "类目确认服务暂时不可用" : "类目确认请求无效",
        });
      }
      return true;
    };
  }

  return Object.freeze({
    recordCollectionResult,
    readForItems,
    confirmManualCategory,
    createHttpHandler,
  });
}
