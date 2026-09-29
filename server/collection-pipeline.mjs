import { assertOzonRussianProductText } from "./ozon-product-language.mjs";
import {collectCaptureSkus} from './collect-enrichment-recovery.mjs';
import {findCollectedSku, findOzonCollectedSkuSources} from "./collection-sku-rules.mjs";
import {admitCollectedItem} from "./collection-admission.mjs";
import crypto from "node:crypto";
import { getPostgresPool, postgresEnabled } from "./db/connection.mjs";
import { runMigrations } from "./db/migrate.mjs";
import { buildCollectItemDraftV4, mirrorCollectItemV3 } from "./listing-pipeline.mjs";
import {consumeCollectorMediaObjects} from './collector-media-upload.mjs';
import {
  findRetiredCollectorScopePath,
  findServerOwnedCategoryResolutionPath,
} from "./collector-scope-sanitizer.mjs";
import { assertCompleteOzonCollectPayload } from "./collector-ozon-enrichment-contract.mjs";
import {
  buildOzonEnrichmentSummary,
  normalizeOzonCollectedSourceEvidence,
  reconcileOzonEnrichmentSummary,
} from "./collect-enrichment-policy.mjs";
import { createPostgresCollectorOzonEnrichmentRepository } from "./collector-ozon-enrichment-repository.mjs";
import {
  assertCollectedPublicEvidenceSafe,
  mergeCollectedItemPublicEvidence,
  sanitizeCollectedPublicEvidence,
} from "./collect-item-identity-policy.mjs";

let ready = false;

async function poolReady() {
  const pool = await getPostgresPool();
  if (!ready) {
    await runMigrations(pool);
    ready = true;
  }
  return pool;
}

function clean(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function stableId(prefix, ...parts) {
  return `${prefix}_${sha256(parts.map((part) => String(part ?? "")).join("|" )).slice(0, 24)}`;
}

const VOLATILE_CANONICAL_KEYS = new Set([
  "collectedat", "createdat", "updatedat", "scrapedat", "savedat", "timestamp",
  "listingsubmittedat", "listingcompletedat", "listinglasterrorat",
]);

function canonicalContentKey(value) {
  return String(value || "").replace(/[-_]/g, "").toLowerCase();
}

function canonicalValue(value, key = "") {
  if (VOLATILE_CANONICAL_KEYS.has(canonicalContentKey(key))) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item)).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const childKey of Object.keys(value).sort()) {
      const child = canonicalValue(value[childKey], childKey);
      if (child !== undefined) result[childKey] = child;
    }
    return result;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value) ?? null);
}

function collectorError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function rejectCollectorScopeFields(input = {}) {
  const forbidden = findRetiredCollectorScopePath(input);
  if (forbidden) {
    throw collectorError(
      `采集请求不能指定账号或店铺范围：${forbidden}`,
      400,
      "COLLECTOR_SCOPE_FIELD_FORBIDDEN",
    );
  }
  const serverOwnedResolution = findServerOwnedCategoryResolutionPath(input);
  if (serverOwnedResolution) {
    throw collectorError(
      `采集请求不能指定服务端类目解析字段：${serverOwnedResolution}`,
      400,
      "COLLECTOR_RESOLUTION_FIELD_FORBIDDEN",
    );
  }
}

export function assertCollectorScopeFieldsAbsentV4(input = {}) {
  rejectCollectorScopeFields(input);
}

export function prepareCollectRequestV4({
  authenticatedAccount,
  input = {},
  enforceScopeFields = true,
} = {}) {
  if (enforceScopeFields) {
    assertCollectorScopeFieldsAbsentV4(input);
  }
  const accountId = clean(authenticatedAccount?.id, 240);
  if (!accountId) {
    throw collectorError("请先登录 sonli", 401, "COLLECT_ACCOUNT_REQUIRED");
  }
  const sourceId = clean(input.source || "ozon", 80).toLowerCase();
  const sourceSku = clean(input.sourceSku, 240);
  if (!sourceSku) {
    throw collectorError("采集数据缺少稳定来源标识", 422, "COLLECT_SOURCE_SKU_REQUIRED");
  }
  const sourceRequestId = clean(input.requestId, 240);
  if (!sourceRequestId) {
    throw collectorError("采集请求缺少 requestId", 422, "COLLECT_REQUEST_ID_REQUIRED");
  }
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw collectorError("采集商品 payload 格式无效", 422, "COLLECT_PAYLOAD_INVALID");
  }
  const payload = input.payload;
  assertCollectedPublicEvidenceSafe(payload);
  const sanitizedPayload = sanitizeCollectedPublicEvidence(payload);
  if (sourceId === "ozon") assertOzonRussianProductText(sanitizedPayload, { sku: sourceSku, operation: "采集" });
  const publicPayload = sourceId === "ozon"
    ? normalizeOzonCollectedSourceEvidence(sanitizedPayload)
    : sanitizedPayload;
  const contentHash = sha256(canonicalJson(payload));
  const identity = {
    accountId,
    source: sourceId,
    sourceSku,
    requestId: sourceRequestId,
  };
  const idempotencyKey = sha256([
    identity.accountId,
    identity.source,
    identity.sourceSku,
    identity.requestId,
  ].join("|"));
  const identityKey = sha256([accountId, sourceId, sourceSku].join("|"));
  return {
    identity,
    idempotencyKey,
    identityKey,
    contentHash,
    requestHash: sha256(JSON.stringify({ ...identity, contentHash })),
    collectId: stableId("collect", identityKey),
    persistedRequestId: stableId("collectreq", idempotencyKey),
    normalizedItem: {
      ...publicPayload,
      id: stableId("collect", identityKey),
      accountId,
      createdBy: accountId,
      source: sourceId,
      sourceSku,
      sourceUrl: clean(input.sourceUrl, 2000),
      deviceFingerprint: clean(input.deviceFingerprint, 240),
      capturedAt: clean(input.capturedAt, 120),
    },
  };
}

export function prepareCompleteCollectRequestV4({
  authenticatedAccount,
  input = {},
  enforceScopeFields = true,
  completenessPayload,
} = {}) {
  const prepared = prepareCollectRequestV4({
    authenticatedAccount,
    input,
    enforceScopeFields,
  });
  assertCompleteOzonCollectPayload(
    prepared.identity.source,
    completenessPayload === undefined ? prepared.normalizedItem : completenessPayload,
  );
  return prepared;
}

function preflightCollectRequests({
  authenticatedAccount,
  inputs = [],
  source,
  enforceScopeFields = true,
  prepare,
} = {}) {
  return inputs.map((value) => {
    const input = value && typeof value === "object" ? value : {};
    const effectiveInput = { ...input, source: input.source || source };
    const prepared = prepare({
      authenticatedAccount,
      input: effectiveInput,
      enforceScopeFields,
    });
    return { input, prepared };
  });
}

export function preflightCollectRequestsV4(options = {}) {
  return preflightCollectRequests({ ...options, prepare: prepareCollectRequestV4 });
}

async function transaction(callback) {
  const pool = await poolReady();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createCollectorEnrichmentRepositoryForTransaction(client) {
  return createPostgresCollectorOzonEnrichmentRepository({
    pool: client,
    transactionOwner: "caller",
  });
}

export function prepareCollectedItemForMirror(item = {}) {
  return {
    ...item,
    listingDraft: buildCollectItemDraftV4(item),
  };
}

function bearerToken(req) {
  const header = String(req?.headers?.authorization || "");
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

export async function authenticateCollectionRequest(req) {
  if (!postgresEnabled()) return null;
  const token = bearerToken(req);
  if (!token) {
    const error = new Error("请先登录 sonli");
    error.status = 401;
    throw error;
  }
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT a.id, a.username, a.display_name, a.role, a.status, a.expires_at
     FROM sessions s
     JOIN accounts a ON a.id=s.account_id
     WHERE s.token=$1
       AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > NOW())
     LIMIT 1`,
    [token],
  );
  const account = result.rows[0];
  if (!account || account.status !== "active") {
    const error = new Error("登录状态已失效，请重新登录");
    error.status = 401;
    throw error;
  }
  if (account.expires_at && new Date(account.expires_at).getTime() <= Date.now()) {
    const error = new Error("账号登录期限已到期");
    error.status = 403;
    throw error;
  }
  return {
    id: account.id,
    username: account.username,
    displayName: account.display_name || account.username,
    role: account.role,
  };
}

export async function ingestCollectRequestV4(options = {}) {
  if (!postgresEnabled()) return null;
  const usingAccountScopedContract = Boolean(options.authenticatedAccount || options.input);
  const authenticatedAccount = options.authenticatedAccount || { id: options.accountId };
  const legacyItem = options.item && typeof options.item === "object" ? options.item : {};
  const input = usingAccountScopedContract
    ? (options.input && typeof options.input === "object" ? options.input : {})
    : {
        source: options.source || "ozon",
        sourceSku: legacyItem.sku || legacyItem.sourceExternalId || legacyItem.id,
        sourceUrl: legacyItem.productUrl || legacyItem.url || legacyItem.sourceUrl,
        requestId: options.idempotencyKey,
        deviceFingerprint: legacyItem.deviceFingerprint,
        capturedAt: legacyItem.capturedAt || legacyItem.collectedAt || legacyItem.createdAt,
        payload: legacyItem,
      };
  const prepared = prepareCollectRequestV4({
    authenticatedAccount,
    input,
    enforceScopeFields: usingAccountScopedContract,
  });
  const {
    identity,
    idempotencyKey: resolvedIdempotencyKey,
    identityKey: proposedIdentityKey,
    contentHash,
    requestHash,
    collectId: proposedCollectId,
    persistedRequestId: requestId,
    normalizedItem: preparedItem,
  } = prepared;
  const {
    accountId,
    source: sourceId,
    sourceSku,
    requestId: sourceRequestId,
  } = identity;
  const enrichment = sourceId === "ozon"
    ? buildOzonEnrichmentSummary(preparedItem)
    : null;
  let incomingNormalizedItem = enrichment
    ? { ...preparedItem, enrichment }
    : preparedItem;

  const admissionPool = await poolReady();
  try {
    // Do not hold the account write lock while calling the official category API.
    // Existing saved goods retain their original admission and are not rechecked.
    const saved = sourceId === 'ozon' ? await findCollectedSku(admissionPool,accountId,sourceSku,collectCaptureSkus(incomingNormalizedItem)) : null;
    if (!saved) incomingNormalizedItem = await (options.checkAdmission || admitCollectedItem)({accountId,item:incomingNormalizedItem},{pool:admissionPool});
    const collected = await transaction(async (client) => {
      let collectId = proposedCollectId;
      let identityKey = proposedIdentityKey;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [sourceId === 'ozon' ? `collect-identity:${accountId}:${sourceId}` : `collect-identity:${accountId}:${sourceId}:${sourceSku}`],
      );
      let already = sourceId === "ozon" ? await findCollectedSku(client,accountId,sourceSku,collectCaptureSkus(incomingNormalizedItem)) : null;
      if (already && (already.id?.startsWith('listed:') || already.previouslyDeleted)) {
        const activeSources = await findOzonCollectedSkuSources(client, accountId, collectCaptureSkus(incomingNormalizedItem));
        const activeSku = activeSources.keys().next().value;
        if (activeSku) already = await findCollectedSku(client, accountId, activeSku);
      }
      if(already) {
        await consumeCollectorMediaObjects(client, {
          accountId, runId: incomingNormalizedItem.collectorRunId, itemId: incomingNormalizedItem.collectorItemId,
          payload: incomingNormalizedItem,
        });
        return {duplicate:true,action:"skipped",item:already,collectItemId:already.id,requestId:"",code:"COLLECT_SKU_ALREADY_EXISTS"};
      }
      if(saved)throw collectorError('已有采集记录已变化，请重试保存',409,'COLLECT_ADMISSION_RETRY');
      const inserted = await client.query(
        `INSERT INTO collect_requests (
           id,idempotency_key,account_id,store_id,data_collection_store_id,
           source,source_sku,request_hash,content_hash,status
         ) VALUES ($1,$2,$3,NULL,NULL,$4,$5,$6,$7,'PROCESSING')
         ON CONFLICT (account_id,source,source_sku,idempotency_key)
         DO NOTHING RETURNING id`,
        [requestId, resolvedIdempotencyKey, accountId, sourceId, sourceSku, requestHash, contentHash],
      );
      if (!inserted.rowCount) {
        const existing = await client.query(
          `SELECT * FROM collect_requests
           WHERE account_id=$1 AND source=$2 AND source_sku=$3 AND idempotency_key=$4
           FOR UPDATE`,
          [accountId, sourceId, sourceSku, resolvedIdempotencyKey],
        );
        const row = existing.rows[0];
        if (!row) {
          throw collectorError("采集请求冲突", 409, "COLLECT_REQUEST_CONFLICT");
        }
        if (row.content_hash !== contentHash) {
          throw collectorError(
            "相同采集请求标识已用于不同内容",
            409,
            "COLLECT_REQUEST_CONFLICT",
          );
        }
        const stillPresent = row?.collect_item_id ? (await client.query(
          'SELECT id FROM collect_items WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL',
          [row.collect_item_id, accountId],
        )).rowCount > 0 : false;
        if (row?.status === "SUCCEEDED" && stillPresent) {
          const storedResponse = row.response && typeof row.response === "object"
            ? row.response
            : { item: incomingNormalizedItem, collectItemId: row.collect_item_id };
          const historicalItem = storedResponse.item && typeof storedResponse.item === "object"
            ? storedResponse.item
            : incomingNormalizedItem;
          const storedItem = sourceId === "ozon"
            ? normalizeOzonCollectedSourceEvidence(historicalItem)
            : historicalItem;
          const replayEnrichment = sourceId === "ozon"
            ? storedResponse.enrichment
              || storedItem.enrichment
              || buildOzonEnrichmentSummary(storedItem)
            : null;
          return {
            duplicate: true,
            requestId: row.id,
            ...storedResponse,
            item: replayEnrichment
              ? { ...storedItem, enrichment: replayEnrichment }
              : storedItem,
            collectItemId: storedResponse.collectItemId || row.collect_item_id,
            ...(replayEnrichment ? { enrichment: replayEnrichment } : {}),
          };
        }
        await client.query(
          `UPDATE collect_requests SET status='PROCESSING',attempt_count=attempt_count+1,
             error_code='',error_message='',updated_at=NOW() WHERE id=$1 AND account_id=$2`,
          [row.id, accountId],
        );
      }
      const canonicalResult = await client.query(
        `SELECT c.*,d.data AS draft_data,d.version AS draft_version,raw.payload AS raw_payload
           FROM collect_items c
           LEFT JOIN product_drafts d ON d.id=c.current_draft_id
           LEFT JOIN LATERAL (
             SELECT payload FROM collect_raw_payloads r
              WHERE r.collect_item_id=c.id AND r.account_id=c.account_id
              ORDER BY r.created_at DESC,r.id DESC LIMIT 1
           ) raw ON TRUE
          WHERE c.account_id=$2 AND c.deleted_at IS NULL AND (
            c.id=$1 OR ($3='ozon' AND c.source='ozon' AND (
              c.source_sku=ANY($4::text[]) OR d.data->'variants' @> ANY($5::jsonb[])
            ))
          )
          ORDER BY c.created_at,c.id LIMIT 1
          FOR UPDATE OF c`,
        [collectId, accountId, sourceId, collectCaptureSkus(incomingNormalizedItem),
          collectCaptureSkus(incomingNormalizedItem).flatMap(sku => [JSON.stringify([{sku}]),
            ...(/^\d+$/.test(sku) && Number.isSafeInteger(Number(sku)) ? [JSON.stringify([{sku:Number(sku)}])] : [])])],
      );
      const canonicalRow = canonicalResult.rows[0];
      if (canonicalRow) {
        collectId = canonicalRow.id;
        identityKey = canonicalRow.identity_key || proposedIdentityKey;
      }
      incomingNormalizedItem = await consumeCollectorMediaObjects(client, {
        accountId, runId: incomingNormalizedItem.collectorRunId, itemId: incomingNormalizedItem.collectorItemId,
        collectItemId: collectId, payload: incomingNormalizedItem,
      });
      const canonicalRaw = canonicalRow?.raw_payload && typeof canonicalRow.raw_payload === "object"
        ? canonicalRow.raw_payload
        : {};
      const canonicalNormalized = canonicalRaw.normalized && typeof canonicalRaw.normalized === "object"
        ? canonicalRaw.normalized
        : {};
      const canonicalEnrichment = canonicalRow?.summary?.enrichment
        && typeof canonicalRow.summary.enrichment === "object"
        ? canonicalRow.summary.enrichment
        : canonicalNormalized.enrichment;
      const canonicalItem = canonicalRow
        ? {
            ...canonicalNormalized,
            id: canonicalRow.id,
            accountId: canonicalRow.account_id,
            source: canonicalRow.source,
            sourceSku: canonicalRow.source_sku,
            sourceUrl: canonicalRow.source_url,
            status: canonicalRow.status,
            listingDraft: canonicalRow.draft_data || canonicalNormalized.listingDraft || {},
            draftVersion: Number(canonicalRow.draft_version || 1),
            ...(canonicalEnrichment ? { enrichment: canonicalEnrichment } : {}),
          }
        : null;
      let normalizedItem = canonicalItem
        ? mergeCollectedItemPublicEvidence(canonicalItem, incomingNormalizedItem)
        : incomingNormalizedItem;
      if (canonicalItem && incomingNormalizedItem.mediaObjects?.length) {
        normalizedItem.mediaObjects = [...new Map([...(canonicalItem.mediaObjects || []), ...incomingNormalizedItem.mediaObjects]
          .map(ref => [JSON.stringify([ref.sourceSku, ref.purpose, ref.index]), ref])).values()];
      }
      if (canonicalItem && sourceId === 'ozon') {
        const knownSkus = new Set(collectCaptureSkus(canonicalItem));
        const incomingVariants = incomingNormalizedItem.variantData?.variants || incomingNormalizedItem.variants || [];
        const existingSources = await findOzonCollectedSkuSources(client, accountId, incomingVariants.map(v => v.sku).filter(Boolean));
        const additions = incomingVariants.filter(variant => {
          const sku = String(variant?.sku || '').trim();
          if (!sku || knownSkus.has(sku)) return false;
          if (existingSources.has(sku) && existingSources.get(sku) !== canonicalItem.id) return false;
          knownSkus.add(sku);
          return true;
        });
        if (additions.length) {
          // Only newly discovered siblings may extend the group. Existing draft
          // rows and source SKUs removed by the user must retain their meaning.
          const oldDraft = normalizedItem.listingDraft;
          const oldRows = oldDraft.variants?.length ? oldDraft.variants : [{ ...oldDraft, sku: oldDraft.sku || canonicalItem.sku || canonicalItem.sourceSku }];
          normalizedItem.listingDraft = { ...oldDraft, variants: [...oldRows, ...structuredClone(additions)] };
          const sourceRows = normalizedItem.variantData?.variants || normalizedItem.variants || [];
          const sourceSkus = new Set();
          normalizedItem.variants = [...sourceRows, ...structuredClone(additions)].filter(variant => {
            const sku = String(variant?.sku || '').trim();
            if (sku && sourceSkus.has(sku)) return false;
            if (sku) sourceSkus.add(sku);
            return true;
          });
          if (normalizedItem.variantData) normalizedItem.variantData.variants = structuredClone(normalizedItem.variants);
        }
      }
      if (sourceId === "ozon") {
        normalizedItem = normalizeOzonCollectedSourceEvidence(normalizedItem);
      }
      const effectiveEnrichment = sourceId === "ozon"
        ? reconcileOzonEnrichmentSummary(normalizedItem, canonicalEnrichment)
        : null;
      const captureSkus = collectCaptureSkus(normalizedItem);
      if (effectiveEnrichment && captureSkus.length > 1) {
        effectiveEnrichment.status = 'PENDING_ENRICHMENT';
        effectiveEnrichment.missingSkus = captureSkus;
      }
      if (effectiveEnrichment) normalizedItem.enrichment = structuredClone(effectiveEnrichment);
      if (effectiveEnrichment?.status === "COMPLETE") normalizedItem.status = "COMPLETE";
      normalizedItem = prepareCollectedItemForMirror(normalizedItem);
      if(incomingNormalizedItem.collectionAdmission) normalizedItem.listingDraft.collectionAdmission=incomingNormalizedItem.collectionAdmission;
      const mirrored = await mirrorCollectItemV3(normalizedItem, {
        client,
        collectId,
        accountId,
        source: sourceId,
        identityKey,
        contentHash,
        requestId: sourceRequestId,
        rawSource: input.payload,
        captureRaw: true,
        changeReason: "PREPROCESSED",
      });
      if (sourceId === "ozon" && options.categoryEvidencePort) {
        const draftVersion = Math.max(1, Number(mirrored?.version || 1));
        await options.categoryEvidencePort.recordCollectionResult({
          postgresExecutor: client,
          accountId,
          collectItemId: collectId,
          item: normalizedItem,
          productDraftId: mirrored?.draftId,
          productDraftVersion: draftVersion,
          sourceVersion: `draft:${draftVersion}`,
          capturedAt: preparedItem.capturedAt || new Date().toISOString(),
          rawResponseRef: mirrored?.rawId,
          rawResponseHash: contentHash,
        });
      }
      if (effectiveEnrichment) {
        const repository = createCollectorEnrichmentRepositoryForTransaction(client);
        if (effectiveEnrichment.status === "PENDING_ENRICHMENT") {
          for (const captureSku of captureSkus) await repository.enqueueForCollect({
            accountId,
            collectItemId: collectId,
            requestId: sourceRequestId,
            sku: captureSku,
            refreshBundle: {},
            now: new Date(),
          });
        } else if (effectiveEnrichment.status === "COMPLETE") {
          await repository.completeLinkedJobsFromCollectEvidence({
            accountId,
            collectItemId: collectId,
            sku: sourceSku,
            now: new Date(),
          });
        }
      }
      const response = {
        item: { ...normalizedItem, draftVersion: mirrored?.version || 1, pipelineVersion: "v4" },
        collectItemId: collectId,
        draftId: mirrored?.draftId || "",
        draftVersion: mirrored?.version || 1,
        action: mirrored?.created ? "created" : "updated",
        ...(effectiveEnrichment ? { enrichment: effectiveEnrichment } : {}),
      };
      await client.query(
        `UPDATE collect_requests SET status='SUCCEEDED',collect_item_id=$2,response=$3::jsonb,
           completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND account_id=$4`,
        [requestId, collectId, JSON.stringify(response), accountId],
      );
      return { duplicate: false, requestId, ...response };
    });
    return collected;
  } catch (error) {
    const pool = await poolReady();
    await pool.query(
      `INSERT INTO collect_requests (
         id,idempotency_key,account_id,store_id,data_collection_store_id,source,source_sku,
         request_hash,content_hash,status,error_code,error_message,completed_at
       ) VALUES ($1,$2,$3,NULL,NULL,$4,$5,$6,$7,'FAILED',$8,$9,NOW())
       ON CONFLICT (account_id,source,source_sku,idempotency_key) DO UPDATE SET
         status='FAILED',error_code=EXCLUDED.error_code,error_message=EXCLUDED.error_message,
         completed_at=NOW(),updated_at=NOW()
       WHERE collect_requests.content_hash=EXCLUDED.content_hash
         AND collect_requests.status<>'SUCCEEDED'`,
      [requestId, resolvedIdempotencyKey, accountId, sourceId, sourceSku, requestHash, contentHash, clean(error.code || (error.status ? `HTTP_${error.status}` : "COLLECT_FAILED"), 120), clean(error.message || error, 2000)],
    ).catch(() => {});
    throw error;
  }
}

export async function getCollectRequestForAccount(accountId, requestIdOrKey) {
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT id,idempotency_key,status,collect_item_id,response,error_code,error_message,
            attempt_count,created_at,updated_at,completed_at
     FROM collect_requests
     WHERE account_id=$1 AND (id=$2 OR idempotency_key=$2) LIMIT 1`,
    [accountId, clean(requestIdOrKey, 240)],
  );
  return result.rows[0] || null;
}
