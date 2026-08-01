import crypto from "node:crypto";
import {
  assertOzonListingReady,
  buildOzonEnrichmentSummary,
  mergeOzonEnrichmentResult,
  preserveOzonSourceCategoryEvidence,
} from "./collect-enrichment-policy.mjs";
import { attachTrustedCollectAccountScope } from "./collect-hydration-scope.mjs";
import { publicPersistedCollectionItem } from "./collection-public-shape.mjs";
import { decryptSecret } from "./crypto-secrets.mjs";
import { getPostgresPool, postgresEnabled } from "./db/connection.mjs";
import { runMigrations } from "./db/migrate.mjs";
import {
  assertListingPreparationInput,
  markListingReplayPreflightError,
  resolveListingPreparationReplay,
  validateTargetStoreRecord,
} from "./listing-submission-policy.mjs";

export const LISTING_QUEUE = "ozon-product-import-v3";
export const TERMINAL_SUBMISSION_STATUSES = new Set(["SUCCEEDED", "PARTIAL_SUCCESS", "FAILED", "CANCELLED"]);

const allowedTransitions = new Map([
  ["QUEUE_PENDING", new Set(["QUEUED", "CANCELLED", "FAILED"])],
  ["QUEUED", new Set(["VALIDATING", "CANCELLED", "FAILED"])],
  ["VALIDATING", new Set(["SUBMITTING", "FAILED", "RETRY_PENDING", "CANCELLED"])],
  ["SUBMITTING", new Set(["OZON_ACCEPTED", "RECONCILING", "RETRY_PENDING", "FAILED"])],
  ["OZON_ACCEPTED", new Set(["CHECKING", "PARTIAL_SUCCESS", "FAILED"])],
  ["CHECKING", new Set(["CHECKING", "SUCCEEDED", "PARTIAL_SUCCESS", "FAILED", "RECONCILING"])],
  ["RECONCILING", new Set(["CHECKING", "RETRY_PENDING", "SUCCEEDED", "PARTIAL_SUCCESS", "FAILED"])],
  ["RETRY_PENDING", new Set(["QUEUED", "VALIDATING", "FAILED", "CANCELLED"])],
  ["CANCEL_REQUESTED", new Set(["CANCELLED", "CHECKING", "SUCCEEDED", "PARTIAL_SUCCESS", "FAILED"])],
]);

let pipelineReady = false;

export function listingPipelineEnabled() {
  return postgresEnabled() && process.env.LISTING_PIPELINE_V3 !== "0";
}

async function poolReady() {
  const pool = await getPostgresPool();
  if (!pipelineReady) {
    await runMigrations(pool);
    pipelineReady = true;
  }
  return pool;
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function hash(value) {
  const serialized = typeof value === "string" ? value : json(value);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function stableId(prefix, ...parts) {
  return `${prefix}_${hash(parts.map((part) => String(part ?? "")).join("|" )).slice(0, 24)}`;
}

function clean(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

async function assertCollectItemAvailableForListing(client, collectItemId, accountId) {
  const id = clean(collectItemId, 240);
  if (!id) return;
  const result = await client.query(
    `SELECT id,current_draft_id FROM collect_items
      WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL
      FOR UPDATE`,
    [id, clean(accountId, 240)],
  );
  if (!result.rowCount) {
    throw Object.assign(new Error("采集箱条目不存在"), {
      status: 404,
      code: "COLLECT_ITEM_NOT_FOUND",
    });
  }
  const currentDraftId = clean(result.rows[0]?.current_draft_id, 240);
  const draft = currentDraftId
    ? await client.query("SELECT data FROM product_drafts WHERE id=$1 FOR SHARE", [currentDraftId])
    : { rows: [] };
  return {
    id,
    listingDraft: draft.rows[0]?.data && typeof draft.rows[0].data === "object"
      ? draft.rows[0].data
      : {},
  };
}

function explicitSourceCategoryForListing(collectItem = {}, index = 0) {
  const draft = collectItem?.listingDraft && typeof collectItem.listingDraft === "object"
    && !Array.isArray(collectItem.listingDraft)
    ? collectItem.listingDraft
    : {};
  const variants = Array.isArray(draft.variants) ? draft.variants : [];
  const variant = variants[index] && typeof variants[index] === "object"
    && !Array.isArray(variants[index])
    ? variants[index]
    : {};
  for (const candidate of [
    variant.sourceCategory,
    variant.categoryResolution?.source,
    draft.sourceCategory,
    draft.categoryResolution?.source,
    collectItem?.sourceCategory,
    collectItem?.categoryResolution?.source,
  ]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const descriptionCategoryId = Number(
        candidate.descriptionCategoryId ?? candidate.description_category_id,
      );
      if (Number.isFinite(descriptionCategoryId) && descriptionCategoryId > 0) return candidate;
    }
  }
  return {};
}

function assertCollectItemListingPayloadsReady(collectItem, normalizedItems) {
  const listingPayloads = Array.isArray(normalizedItems) ? normalizedItems : [];
  if (!listingPayloads.length) assertOzonListingReady({});
  listingPayloads.forEach((payload, index) => assertOzonListingReady({
    ...payload,
    sourceCategory: explicitSourceCategoryForListing(collectItem, index),
  }));
}

function withoutCollectionScope(value = {}) {
  const result = { ...(value || {}) };
  for (const field of [
    "accountId",
    "createdBy",
    "storeId",
    "localStoreId",
    "operatingStoreId",
    "dataCollectionStoreId",
    "sellerCompanyId",
  ]) delete result[field];
  return result;
}

export function resolveCollectItemEnrichmentSummary(summary, fallback = null) {
  const persisted = summary && typeof summary === "object" && !Array.isArray(summary)
    ? summary.enrichment
    : null;
  if (persisted && typeof persisted === "object" && !Array.isArray(persisted)) {
    return structuredClone(persisted);
  }
  return fallback && typeof fallback === "object" && !Array.isArray(fallback)
    ? structuredClone(fallback)
    : null;
}

export function buildCollectItemMirrorSummary(item = {}, context = {}) {
  const enrichment = item.enrichment && typeof item.enrichment === "object" && !Array.isArray(item.enrichment)
    ? structuredClone(item.enrichment)
    : null;
  return {
    name: item.name || item.title || "",
    image: item.image || item.primaryImage || "",
    source: context.source || item.source || "",
    ...(enrichment ? { enrichment } : {}),
  };
}

function legacyCollectStatus(status) {
  return {
    QUEUE_PENDING: "上架中",
    QUEUED: "上架中",
    VALIDATING: "上架中",
    SUBMITTING: "上架中",
    OZON_ACCEPTED: "上架中",
    CHECKING: "上架中",
    RECONCILING: "待核对",
    RETRY_PENDING: "上架中",
    SUCCEEDED: "已上架",
    PARTIAL_SUCCESS: "部分成功",
    FAILED: "失败",
    CANCEL_REQUESTED: "取消中",
    CANCELLED: "已取消",
  }[status] || status;
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

function collectRawPayload(item = {}, sourceOverride) {
  const raw = sourceOverride && typeof sourceOverride === "object"
    ? sourceOverride
    : item.raw && typeof item.raw === "object" ? item.raw : {};
  const normalized = { ...item };
  for (const key of [
    "listingDraft", "listingResult", "listingTaskId", "listingJobId", "listingSubmittedAt",
    "listingCompletedAt", "listingLastError", "listingLastErrorAt", "listingStatusMessage",
    "status", "updatedAt",
  ]) delete normalized[key];
  return {
    source: raw,
    normalized,
    sourceExternalId: item.sourceExternalId || item.sku || item.id || "",
    sourceUrl: item.productUrl || item.url || "",
    title: item.name || item.title || "",
    price: item.price || item.priceText || "",
    currency: item.currencyCode || item.currency_code || item.currency || "",
    images: item.images || [],
    variants: item.variants || item.variantData?.variants || [],
    attributes: item.attributes || item.characteristics || [],
    media: item.media || item.videos || [],
    collectedAt: item.collectedAt || item.createdAt || "",
  };
}

export function buildCollectItemDraftV4(item = {}) {
  if (item.listingDraft && typeof item.listingDraft === "object") {
    return preserveOzonSourceCategoryEvidence(
      item,
      mergeOzonEnrichmentResult(item.listingDraft, item),
    );
  }
  const logistics = item.logistics && typeof item.logistics === "object"
    && !Array.isArray(item.logistics)
    ? item.logistics
    : {};
  return preserveOzonSourceCategoryEvidence(item, {
    sku: item.sku || item.sourceExternalId || item.id || "",
    title: item.name || item.title || "",
    price: item.price?.price || item.price || item.priceText || "",
    currencyCode: item.currencyCode || item.currency_code || item.currency || "",
    image: item.image || item.primaryImage || item.images?.[0] || "",
    images: Array.isArray(item.images) ? item.images : [],
    brand: item.brand || "",
    modelName: item.modelName || item.model_name || item.offer_id || item.sku || "",
    description: item.description || item.desc || item.subtitle || "",
    tags: Array.isArray(item.tags) ? item.tags : [],
    richContent: item.richContent || item.rich_content || "",
    packageWeight: item.packageWeight || item.weight || logistics.weightG || "",
    packageLength: item.packageLength || item.depth || item.length || logistics.lengthMm || "",
    packageWidth: item.packageWidth || item.width || logistics.widthMm || "",
    packageHeight: item.packageHeight || item.height || logistics.heightMm || "",
    ...(Object.keys(logistics).length ? { logistics: structuredClone(logistics) } : {}),
    descriptionCategoryId: item.description_category_id || item.descriptionCategoryId || "",
    typeId: item.type_id || item.typeId || "",
    sourceLink: item.productUrl || item.url || "",
    variants: Array.isArray(item.variants) ? item.variants : (item.variantData?.variants || []),
  });
}

function draftHashValue(draft = {}) {
  const comparable = { ...draft };
  delete comparable.savedAt;
  return comparable;
}

function draftVariants(draft = {}, item = {}) {
  if (Array.isArray(draft.variants) && draft.variants.length) return draft.variants;
  const variants = item.variants || item.variantData?.variants || [];
  return Array.isArray(variants) ? variants : [];
}

async function mirrorCollectItemWithClient(client, item = {}, context = {}) {
    const collectId = clean(context.collectId || item.id, 240);
    const accountId = clean(context.accountId || item.accountId, 240);
    if (!accountId) {
      throw Object.assign(new Error("采集记录缺少账号归属"), {
        status: 401,
        code: "COLLECT_ACCOUNT_REQUIRED",
      });
    }
    const sourceSku = clean(context.sourceSku || item.sourceSku || item.sku || item.sourceExternalId, 240);
    const sourceUrl = clean(context.sourceUrl || item.sourceUrl || item.productUrl || item.url, 2000);
    const rawPayload = collectRawPayload(item, context.rawSource);
    const rawHash = clean(context.contentHash, 128) || hash(rawPayload);
    const rawId = stableId("raw", collectId, rawHash);
    const draft = buildCollectItemDraftV4(item);
    const draftHash = hash(draftHashValue(draft));
    const draftId = stableId("draft", collectId);
    const accountExists = await client.query("SELECT 1 FROM accounts WHERE id=$1", [accountId]);
    if (!accountExists.rowCount) {
      throw Object.assign(new Error("采集账号不存在"), {
        status: 401,
        code: "COLLECT_ACCOUNT_REQUIRED",
      });
    }

    const existingRaw = await client.query(
      `SELECT id, payload_hash FROM collect_raw_payloads
       WHERE collect_item_id=$1 AND account_id=$2
       ORDER BY created_at DESC LIMIT 1`,
      [collectId, accountId],
    );
    const captureRaw = context.captureRaw === true || !existingRaw.rows[0];
    const rawChanged = existingRaw.rows[0]?.payload_hash !== rawHash;
    const shouldInsertRaw = captureRaw && rawChanged;
    const sourcePayloadId = shouldInsertRaw ? rawId : (existingRaw.rows[0]?.id || rawId);
    if (shouldInsertRaw) await client.query(
       `INSERT INTO collect_raw_payloads (
          id, collect_item_id, account_id, store_id, data_collection_store_id,
          source_sku, source_url, payload_hash, content_hash, request_id,
          collector_version, payload, collected_at
       ) VALUES ($1,$2,$3,NULL,NULL,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW())
       ON CONFLICT (collect_item_id, payload_hash) DO NOTHING`,
      [
        rawId,
        collectId,
        accountId,
        sourceSku,
        sourceUrl,
        rawHash,
        rawHash,
        clean(context.requestId, 240),
        clean(item.collectorVersion || item.extensionVersion, 120),
        json(rawPayload),
      ],
    );
    const persistedItem = await client.query(
      `INSERT INTO collect_items (
         id, account_id, store_id, data_collection_store_id, source_sku, source_url,
         source, identity_key, status, created_at, updated_at, summary
       ) VALUES ($1,$2,NULL,NULL,$3,$4,$5,$6,$7,NOW(),NOW(),$8::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         source_sku = EXCLUDED.source_sku,
         source_url = EXCLUDED.source_url,
         source = EXCLUDED.source,
         identity_key = EXCLUDED.identity_key,
         status = EXCLUDED.status,
         updated_at = NOW(), deleted_at = NULL, summary = EXCLUDED.summary
       WHERE collect_items.account_id=EXCLUDED.account_id
       RETURNING id`,
      [
        collectId,
        accountId,
        sourceSku,
        sourceUrl,
        clean(context.source || item.source || "ozon", 80),
        clean(context.identityKey, 128),
        clean(item.status || "COLLECTED", 80),
        json(buildCollectItemMirrorSummary(item, context)),
      ],
    );
    if (!persistedItem.rowCount) {
      throw Object.assign(new Error("采集箱条目不存在"), {
        status: 404,
        code: "COLLECT_ITEM_NOT_FOUND",
      });
    }

    const current = await client.query("SELECT version, data_hash FROM product_drafts WHERE id = $1 FOR UPDATE", [draftId]);
    let version = Number(current.rows[0]?.version || 0);
    const expectedVersion = context.expectedVersion === undefined || context.expectedVersion === null
      ? null
      : Number(context.expectedVersion);
    if (expectedVersion !== null && Number.isFinite(expectedVersion) && version !== expectedVersion) {
      const error = new Error(`草稿已被其他页面更新，当前版本为 v${version}，请刷新后重试`);
      error.code = "DRAFT_VERSION_CONFLICT";
      error.status = 409;
      throw error;
    }
    const changed = !current.rows[0] || current.rows[0].data_hash !== draftHash;
    if (!current.rows[0]) {
      version = 1;
      await client.query(
        `INSERT INTO product_drafts (
           id, collect_item_id, source_payload_id, version, data_hash, data,
           normalizer_version, category_rule_version, dictionary_version,
           rich_content_rule_version, updated_by
         ) VALUES ($1,$2,$3,1,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
        [draftId, collectId, sourcePayloadId, draftHash, json(draft), "v3", clean(context.categoryRuleVersion, 120), clean(context.dictionaryVersion, 120), clean(context.richContentRuleVersion, 120), accountId],
      );
    } else if (changed) {
      version += 1;
      await client.query(
        `UPDATE product_drafts SET
           source_payload_id=$2, version=$3, data_hash=$4, data=$5::jsonb,
           category_rule_version=$6, dictionary_version=$7,
           rich_content_rule_version=$8, updated_by=$9, updated_at=NOW()
         WHERE id=$1`,
        [draftId, sourcePayloadId, version, draftHash, json(draft), clean(context.categoryRuleVersion, 120), clean(context.dictionaryVersion, 120), clean(context.richContentRuleVersion, 120), accountId],
      );
    }
    if (changed) {
      await client.query(
        `INSERT INTO product_draft_revisions (id, draft_id, version, data_hash, data, changed_by, change_reason)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
         ON CONFLICT (draft_id, version) DO NOTHING`,
        [stableId("draftrev", draftId, version), draftId, version, draftHash, json(draft), accountId, clean(context.changeReason || (version === 1 ? "PREPROCESSED" : "USER_EDIT"), 120)],
      );
      const variants = draftVariants(draft, item);
      const activeVariantKeys = [];
      for (let index = 0; index < variants.length; index += 1) {
        const variant = variants[index] || {};
        const variantKey = clean(variant.variantKey || variant.sku || variant.offerId || variant.offer_id || `${index + 1}`, 240);
        activeVariantKeys.push(variantKey);
        await client.query(
          `INSERT INTO product_draft_variants (
             id, draft_id, source_payload_id, variant_key, sort_order, merge_model,
             sku, offer_id, data_hash, source_content_hash, data
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
           ON CONFLICT (draft_id, variant_key) DO UPDATE SET
             source_payload_id=EXCLUDED.source_payload_id,
             sort_order=EXCLUDED.sort_order,
             merge_model=EXCLUDED.merge_model,
             sku=EXCLUDED.sku,
             offer_id=EXCLUDED.offer_id,
             data_hash=EXCLUDED.data_hash,
             source_content_hash=EXCLUDED.source_content_hash,
             data=EXCLUDED.data,
             updated_at=NOW()`,
          [
            stableId("draftvar", draftId, variantKey),
            draftId,
            sourcePayloadId,
            variantKey,
            index,
            clean(draft.modelName || variant.modelName, 500),
            clean(variant.sku, 240),
            clean(variant.offerId || variant.offer_id, 240),
            hash(variant),
            clean(variant.sourceContentHash || variant.source_content_hash || rawHash, 128),
            json(variant),
          ],
        );
      }
      if (activeVariantKeys.length) {
        await client.query(
          "DELETE FROM product_draft_variants WHERE draft_id=$1 AND NOT (variant_key = ANY($2::text[]))",
          [draftId, activeVariantKeys],
        );
      } else {
        await client.query("DELETE FROM product_draft_variants WHERE draft_id=$1", [draftId]);
      }
    }
    await client.query(
      "UPDATE collect_items SET current_draft_id=$2, updated_at=NOW() WHERE id=$1 AND account_id=$3",
      [collectId, draftId, accountId],
    );
    return {
      collectId,
      rawId: sourcePayloadId,
      draftId,
      version,
      changed,
      created: !current.rows[0],
      dataHash: draftHash,
    };
}

export async function mirrorCollectItemV3(item = {}, context = {}) {
  if (!listingPipelineEnabled() || !(context.collectId || item?.id)) return null;
  if (context.client) return mirrorCollectItemWithClient(context.client, item, context);
  return transaction((client) => mirrorCollectItemWithClient(client, item, context));
}

export async function assertUsableOperatingStore({
  accountId,
  storeId,
  requireCredentials = true,
  client = null,
} = {}) {
  const scope = assertListingPreparationInput({
    accountId,
    collectItemId: "target-store-validation",
    targetStoreId: storeId,
    idempotencyKey: "target-store-validation",
  });
  const database = client || await poolReady();
  const result = await database.query(
    `SELECT
       s.id,
       s.owner_account_id,
       s.label,
       s.client_id,
       s.currency_code,
       s.status,
       (
         sc.store_id IS NOT NULL
         AND sc.encrypted_api_key <> ''
         AND sc.iv <> ''
         AND sc.auth_tag <> ''
       ) AS credentials_saved
     FROM stores s
     LEFT JOIN store_credentials sc ON sc.store_id=s.id
     WHERE s.id=$1 AND s.owner_account_id=$2
     LIMIT 1`,
    [scope.targetStoreId, scope.accountId],
  );
  return validateTargetStoreRecord({
    accountId: scope.accountId,
    targetStoreId: scope.targetStoreId,
    store: result.rows[0] || null,
    requireCredentials,
  });
}

export async function assertListingStocksBelongToTarget({
  accountId,
  storeId,
  stocks = [],
  client = null,
} = {}) {
  const warehouseIds = [...new Set(
    (Array.isArray(stocks) ? stocks : [])
      .map((stock) => clean(stock?.warehouse_id || stock?.warehouseId, 240))
      .filter(Boolean),
  )];
  if (!warehouseIds.length) return true;
  const database = client || await poolReady();
  const result = await database.query(
    `SELECT DISTINCT requested.id
     FROM unnest($3::text[]) AS requested(id)
     JOIN warehouses w ON w.warehouse_id=requested.id OR w.id=requested.id
     JOIN stores s ON s.id=w.store_id
     WHERE s.owner_account_id=$1
       AND w.store_id=$2
       AND w.is_active=TRUE
       AND w.is_archived=FALSE`,
    [clean(accountId, 240), clean(storeId, 240), warehouseIds],
  );
  if (result.rowCount !== warehouseIds.length) {
    throw Object.assign(new Error("上架仓库不属于目标经营店铺或当前不可用"), {
      status: 409,
      code: "LISTING_WAREHOUSE_TARGET_MISMATCH",
    });
  }
  return true;
}

export async function listCollectItemsV3({ accountId = "", includeDeleted = false, limit = 5000 } = {}) {
  if (!listingPipelineEnabled()) return [];
  const scopedAccountId = clean(accountId, 240);
  if (!scopedAccountId) {
    throw Object.assign(new Error("采集列表必须指定账号范围"), {
      status: 401,
      code: "COLLECT_ACCOUNT_REQUIRED",
    });
  }
  const pool = await poolReady();
  const params = [scopedAccountId];
  const where = ["c.account_id=$1"];
  if (!includeDeleted) where.push("c.deleted_at IS NULL");
  params.push(Math.max(1, Math.min(10000, Number(limit) || 5000)));
  const result = await pool.query(
    `SELECT c.*, d.data AS draft_data, d.version AS draft_version,
            raw.payload AS raw_payload
     FROM collect_items c
     LEFT JOIN product_drafts d ON d.id=c.current_draft_id
     LEFT JOIN LATERAL (
       SELECT payload FROM collect_raw_payloads r
       WHERE r.collect_item_id=c.id AND r.account_id=c.account_id
       ORDER BY r.created_at DESC LIMIT 1
     ) raw ON TRUE
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY c.updated_at DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => {
    const raw = row.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : {};
    const normalized = raw.normalized && typeof raw.normalized === "object" ? raw.normalized : {};
    const enrichment = resolveCollectItemEnrichmentSummary(row.summary, normalized.enrichment);
    return publicPersistedCollectionItem({
      ...withoutCollectionScope(normalized),
      ...(enrichment ? { enrichment } : {}),
      id: row.id,
      sku: row.source_sku || normalized.sku || "",
      productUrl: row.source_url || normalized.productUrl || "",
      storeId: row.store_id || "",
      dataCollectionStoreId: row.data_collection_store_id || "",
      status: legacyCollectStatus(row.status),
      listingDraft: row.draft_data || normalized.listingDraft || {},
      draftVersion: Number(row.draft_version || 1),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accountId: row.account_id || "",
      pipelineVersion: "v3",
    });
  });
}

function collectItemEnrichmentRow(row = {}) {
  if (!row.id) return null;
  const summary = row.summary && typeof row.summary === "object" ? row.summary : {};
  return {
    id: String(row.id),
    accountId: String(row.account_id || row.accountId || ""),
    status: String(row.status || ""),
    listingDraft: row.draft_data && typeof row.draft_data === "object"
      ? row.draft_data
      : row.listingDraft && typeof row.listingDraft === "object"
        ? row.listingDraft
        : {},
    draftVersion: Number(row.draft_version ?? row.draftVersion ?? 0),
    enrichment: resolveCollectItemEnrichmentSummary(summary, row.enrichment),
  };
}

export async function readCollectItemEnrichmentV4({ collectItemId, accountId } = {}) {
  if (!listingPipelineEnabled()) return null;
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT c.id,c.account_id,c.status,c.summary,d.data AS draft_data,d.version AS draft_version
       FROM collect_items c
       LEFT JOIN product_drafts d ON d.id=c.current_draft_id
      WHERE c.id=$1 AND c.account_id=$2 AND c.deleted_at IS NULL`,
    [clean(collectItemId, 240), clean(accountId, 240)],
  );
  return collectItemEnrichmentRow(result.rows[0]);
}

async function saveCollectItemEnrichmentWithClient(client, {
  collectItemId,
  accountId,
  expectedVersion = null,
  listingDraft,
  status,
  enrichment,
} = {}, transactionEffect = null) {
    if (typeof client?.query !== "function") {
      throw new TypeError("Ozon enrichment collect item transaction client required");
    }
    const result = await client.query(
      `SELECT c.*,d.data AS draft_data,d.version AS draft_version,raw.payload AS raw_payload
         FROM collect_items c
         LEFT JOIN product_drafts d ON d.id=c.current_draft_id
         LEFT JOIN LATERAL (
           SELECT payload FROM collect_raw_payloads r
            WHERE r.collect_item_id=c.id AND r.account_id=c.account_id
            ORDER BY r.created_at DESC LIMIT 1
         ) raw ON TRUE
        WHERE c.id=$1 AND c.account_id=$2 AND c.deleted_at IS NULL
        FOR UPDATE OF c`,
      [clean(collectItemId, 240), clean(accountId, 240)],
    );
    const row = result.rows[0];
    if (!row) return null;
    const currentVersion = Number(row.draft_version || 0);
    let draftVersion = currentVersion;
    if (listingDraft !== undefined) {
      if (Number(expectedVersion) !== currentVersion) {
        throw Object.assign(
          new Error(`草稿已被其他页面更新，当前版本为 v${currentVersion}，请刷新后重试`),
          { code: "DRAFT_VERSION_CONFLICT", status: 409 },
        );
      }
      const raw = row.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : {};
      const normalized = raw.normalized && typeof raw.normalized === "object" ? raw.normalized : {};
      const mirrored = await mirrorCollectItemWithClient(client, {
        ...withoutCollectionScope(normalized),
        id: row.id,
        accountId: row.account_id,
        sku: row.source_sku || normalized.sku || "",
        productUrl: row.source_url || normalized.productUrl || "",
        source: row.source || normalized.source || "ozon",
        status: clean(status || row.status, 80),
        listingDraft: structuredClone(listingDraft),
      }, {
        collectId: row.id,
        accountId: row.account_id,
        source: row.source || "ozon",
        identityKey: row.identity_key || "",
        expectedVersion: currentVersion,
        captureRaw: false,
        changeReason: "OZON_ENRICHMENT_MERGE",
      });
      draftVersion = Number(mirrored?.version || currentVersion);
    }
    const currentSummary = row.summary && typeof row.summary === "object" ? row.summary : {};
    const nextSummary = {
      ...currentSummary,
      ...(enrichment && typeof enrichment === "object"
        ? { enrichment: structuredClone(enrichment) }
        : {}),
    };
    const updated = await client.query(
      `UPDATE collect_items
          SET status=$3,summary=$4::jsonb,updated_at=NOW()
        WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL
        RETURNING id,account_id,status,summary`,
      [row.id, row.account_id, clean(status || row.status, 80), json(nextSummary)],
    );
    const saved = collectItemEnrichmentRow({
      ...updated.rows[0],
      draft_data: listingDraft === undefined ? row.draft_data : listingDraft,
      draft_version: draftVersion,
    });
    if (typeof transactionEffect === "function") await transactionEffect(client);
    return saved;
}

async function saveCollectItemEnrichmentTransaction(input = {}, transactionEffect = null) {
  if (!listingPipelineEnabled()) return null;
  return transaction((client) => (
    saveCollectItemEnrichmentWithClient(client, input, transactionEffect)
  ));
}

export async function saveCollectItemEnrichmentV4(input = {}) {
  return saveCollectItemEnrichmentTransaction(input);
}

export async function completeCollectItemEnrichmentV4({ completeJobAndCache, ...input } = {}) {
  if (typeof completeJobAndCache !== "function") {
    throw new TypeError("Ozon enrichment terminal transaction callback required");
  }
  return saveCollectItemEnrichmentTransaction(input, completeJobAndCache);
}

export async function completeCollectItemEnrichmentWithClientV4(client, {
  completeJobAndCache,
  ...input
} = {}) {
  if (typeof completeJobAndCache !== "function") {
    throw new TypeError("Ozon enrichment terminal transaction callback required");
  }
  return saveCollectItemEnrichmentWithClient(client, input, completeJobAndCache);
}

function collectItemEvidenceSummary(item = {}) {
  const draft = item.listingDraft && typeof item.listingDraft === "object"
    && !Array.isArray(item.listingDraft)
    ? item.listingDraft
    : {};
  const evidence = {
    ...item,
    ...draft,
    sourceCategory: draft.sourceCategory || item.sourceCategory,
    categoryResolution: draft.categoryResolution || item.categoryResolution,
    logistics: {
      ...(item.logistics && typeof item.logistics === "object" ? item.logistics : {}),
      ...(draft.logistics && typeof draft.logistics === "object" ? draft.logistics : {}),
    },
  };
  return buildOzonEnrichmentSummary(evidence);
}

export async function deferCollectItemEnrichmentWithClientV4(client, {
  collectItemId,
  accountId,
  status,
  error,
  deferJob,
  completeLinkedJobs,
} = {}) {
  if (
    typeof client?.query !== "function"
    || typeof deferJob !== "function"
    || typeof completeLinkedJobs !== "function"
  ) {
    throw new TypeError("Ozon enrichment defer transaction dependencies required");
  }
  const result = await client.query(
    `SELECT c.id,c.account_id,c.status,c.summary,d.data AS draft_data,d.version AS draft_version
       FROM collect_items c
       LEFT JOIN product_drafts d ON d.id=c.current_draft_id
      WHERE c.id=$1 AND c.account_id=$2 AND c.deleted_at IS NULL
      FOR UPDATE OF c`,
    [clean(collectItemId, 240), clean(accountId, 240)],
  );
  const row = result.rows[0];
  if (!row) return null;
  const deferredJob = await deferJob(client);
  const currentItem = collectItemEnrichmentRow(row);
  const persistedSummary = row.summary?.enrichment;
  const complete = persistedSummary?.status === "COMPLETE"
    || collectItemEvidenceSummary(currentItem).status === "COMPLETE";
  if (complete) {
    const terminalJob = await completeLinkedJobs(client, deferredJob);
    return { item: currentItem, job: terminalJob || deferredJob };
  }
  const currentSummary = row.summary && typeof row.summary === "object" ? row.summary : {};
  const evidenceSummary = collectItemEvidenceSummary(currentItem);
  const enrichment = {
    status: clean(status || "RETRYING", 80),
    missingFields: evidenceSummary.missingFields,
    attemptCount: Number(deferredJob?.attemptCount || 0),
    nextAttemptAt: String(deferredJob?.nextAttemptAt || ""),
    lastErrorCode: clean(error?.code, 120),
  };
  const updated = await client.query(
    `UPDATE collect_items
        SET status=$4,summary=$3::jsonb,updated_at=NOW()
      WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL
      RETURNING id,account_id,status,summary`,
    [
      row.id,
      row.account_id,
      json({ ...currentSummary, enrichment }),
      enrichment.status,
    ],
  );
  const item = collectItemEnrichmentRow({
    ...updated.rows[0],
    draft_data: row.draft_data,
    draft_version: row.draft_version,
  });
  if (!item) throw new Error("Ozon enrichment collect item defer update lost");
  return { item, job: deferredJob };
}

export async function deferCollectItemEnrichmentV4(input = {}) {
  if (!listingPipelineEnabled()) return null;
  return transaction((client) => deferCollectItemEnrichmentWithClientV4(client, input));
}

export async function failCollectItemEnrichmentWithClientV4(client, {
  collectItemId,
  accountId,
  status,
  enrichment,
  failJobAndCache,
} = {}) {
  if (typeof client?.query !== "function" || typeof failJobAndCache !== "function") {
    throw new TypeError("Ozon enrichment failure transaction dependencies required");
  }
  const result = await client.query(
    `SELECT c.id,c.account_id,c.status,c.summary,d.data AS draft_data,d.version AS draft_version
       FROM collect_items c
       LEFT JOIN product_drafts d ON d.id=c.current_draft_id
      WHERE c.id=$1 AND c.account_id=$2 AND c.deleted_at IS NULL
      FOR UPDATE OF c`,
    [clean(collectItemId, 240), clean(accountId, 240)],
  );
  const row = result.rows[0];
  if (!row) return null;
  const persistedJob = await failJobAndCache(client);
  const currentSummary = row.summary && typeof row.summary === "object" ? row.summary : {};
  const nextEnrichment = {
    ...(enrichment && typeof enrichment === "object" ? structuredClone(enrichment) : {}),
    attemptCount: Number(persistedJob?.attemptCount || 0),
  };
  const updated = await client.query(
    `UPDATE collect_items
        SET status=$4,summary=$3::jsonb,updated_at=NOW()
      WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL
      RETURNING id,account_id,status,summary`,
    [
      row.id,
      row.account_id,
      json({ ...currentSummary, enrichment: nextEnrichment }),
      clean(status || row.status, 80),
    ],
  );
  const item = collectItemEnrichmentRow({
    ...updated.rows[0],
    draft_data: row.draft_data,
    draft_version: row.draft_version,
  });
  if (!item) throw new Error("Ozon enrichment collect item failure update lost");
  return { item, job: persistedJob };
}

export async function failCollectItemEnrichmentV4(input = {}) {
  if (!listingPipelineEnabled()) return null;
  return transaction((client) => failCollectItemEnrichmentWithClientV4(client, input));
}

function retryJobFromRow(row = {}) {
  if (!row.id) return null;
  return {
    id: String(row.id),
    accountId: String(row.account_id || ""),
    collectItemId: row.collect_item_id || null,
    requestId: String(row.request_id || ""),
    sku: String(row.sku || ""),
    status: String(row.status || ""),
    preferredSessionId: row.preferred_session_id || null,
    claimedSessionId: row.claimed_session_id || null,
    claimExpiresAt: row.claim_expires_at ? new Date(row.claim_expires_at).toISOString() : null,
    refreshBundle: row.refresh_bundle || {},
    attemptCount: Number(row.attempt_count || 0),
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
    lastError: row.last_error_json || null,
    captureContext: row.capture_context_json || null,
    deadlineAt: row.deadline_at ? new Date(row.deadline_at).toISOString() : null,
    result: row.result_json || null,
    error: row.error_json || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

export async function retryCollectItemEnrichmentWithClientV4(client, {
  collectItemId,
  accountId,
  now,
} = {}) {
  if (typeof client?.query !== "function") {
    throw new TypeError("Ozon enrichment retry transaction client required");
  }
  const retriedAt = now instanceof Date ? new Date(now) : new Date(now);
  if (Number.isNaN(retriedAt.getTime())) throw new TypeError("Ozon enrichment retry time required");
  const itemResult = await client.query(
    `SELECT c.id,c.account_id,c.status,c.summary,d.data AS draft_data,d.version AS draft_version
       FROM collect_items c
       LEFT JOIN product_drafts d ON d.id=c.current_draft_id
      WHERE c.id=$1 AND c.account_id=$2 AND c.deleted_at IS NULL
      FOR UPDATE OF c`,
    [clean(collectItemId, 240), clean(accountId, 240)],
  );
  const row = itemResult.rows[0];
  if (!row) return null;
  const item = collectItemEnrichmentRow(row);
  const complete = item.enrichment?.status === "COMPLETE"
    || collectItemEvidenceSummary(item).status === "COMPLETE";
  if (complete) {
    const terminalResult = await client.query(
      `SELECT * FROM collector_ozon_enrichment_jobs
        WHERE account_id=$1 AND collect_item_id=$2 AND status='SUCCESS'
        ORDER BY updated_at DESC,created_at DESC,id DESC LIMIT 1
        FOR UPDATE`,
      [row.account_id, row.id],
    );
    return terminalResult.rows[0]
      ? { item, job: retryJobFromRow(terminalResult.rows[0]) }
      : null;
  }
  const jobResult = await client.query(
    `SELECT * FROM collector_ozon_enrichment_jobs
      WHERE account_id=$1 AND collect_item_id=$2
        AND status IN ('PENDING','PROCESSING','FAILED')
        AND COALESCE(error_json->>'code',last_error_json->>'code','')
            <> 'OZON_ENRICHMENT_DUPLICATE_SUPERSEDED'
      ORDER BY updated_at DESC,created_at DESC,id DESC LIMIT 1
      FOR UPDATE`,
    [row.account_id, row.id],
  );
  if (!jobResult.rows[0]) return null;
  const currentJob = jobResult.rows[0];
  if (
    currentJob.status === "PROCESSING"
    && currentJob.claim_expires_at
    && new Date(currentJob.claim_expires_at).getTime() > retriedAt.getTime()
  ) {
    return {
      item,
      job: retryJobFromRow(currentJob),
    };
  }
  const updatedJob = await client.query(
    `UPDATE collector_ozon_enrichment_jobs
        SET status='PENDING',next_attempt_at=$3,last_error_json=NULL,error_json=NULL,
            claimed_session_id=NULL,claim_expires_at=NULL,completed_at=NULL,updated_at=$3
      WHERE account_id=$1 AND id=$2
      RETURNING *`,
    [row.account_id, jobResult.rows[0].id, retriedAt],
  );
  const summary = row.summary && typeof row.summary === "object" ? row.summary : {};
  const currentEnrichment = summary.enrichment && typeof summary.enrichment === "object"
    ? summary.enrichment
    : {};
  const enrichment = {
    ...currentEnrichment,
    status: "RETRYING",
    attemptCount: Number(updatedJob.rows[0].attempt_count || 0),
    nextAttemptAt: retriedAt.toISOString(),
    lastErrorCode: "",
  };
  const updatedItem = await client.query(
    `UPDATE collect_items
        SET status='RETRYING',summary=$3::jsonb,updated_at=$4
      WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL
      RETURNING id,account_id,status,summary`,
    [row.account_id, row.id, json({ ...summary, enrichment }), retriedAt],
  );
  return {
    item: collectItemEnrichmentRow({
      ...updatedItem.rows[0],
      draft_data: row.draft_data,
      draft_version: row.draft_version,
    }),
    job: retryJobFromRow(updatedJob.rows[0]),
  };
}

export async function retryCollectItemEnrichmentV4(input = {}) {
  if (!listingPipelineEnabled()) return null;
  return transaction((client) => retryCollectItemEnrichmentWithClientV4(client, input));
}

export async function updateCollectItemDraftV4({ collectItemId, accountId, patch = {}, expectedVersion = null }) {
  if (!listingPipelineEnabled()) return null;
  return transaction(async (client) => {
    const result = await client.query(
      `SELECT c.*,d.data AS draft_data,d.version AS draft_version,raw.payload AS raw_payload
       FROM collect_items c
       LEFT JOIN product_drafts d ON d.id=c.current_draft_id
       LEFT JOIN LATERAL (
         SELECT payload FROM collect_raw_payloads r
         WHERE r.collect_item_id=c.id AND r.account_id=c.account_id
         ORDER BY r.created_at DESC LIMIT 1
       ) raw ON TRUE
       WHERE c.id=$1 AND c.account_id=$2 AND c.deleted_at IS NULL
       FOR UPDATE OF c`,
      [clean(collectItemId, 240), clean(accountId, 240)],
    );
    const row = result.rows[0];
    if (!row) return null;
    const raw = row.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : {};
    const normalized = raw.normalized && typeof raw.normalized === "object" ? raw.normalized : {};
    const currentDraft = row.draft_data && typeof row.draft_data === "object" ? row.draft_data : {};
    const enrichment = resolveCollectItemEnrichmentSummary(row.summary, normalized.enrichment);
    const safePatch = withoutCollectionScope(patch);
    const requestedDraft = safePatch.listingDraft && typeof safePatch.listingDraft === "object"
      ? safePatch.listingDraft
      : { ...currentDraft, ...safePatch };
    const listingDraft = preserveOzonSourceCategoryEvidence(currentDraft, requestedDraft);
    const item = publicPersistedCollectionItem({
      ...withoutCollectionScope(normalized),
      ...safePatch,
      ...(enrichment ? { enrichment } : {}),
      id: row.id,
      accountId: row.account_id,
      storeId: row.store_id || "",
      dataCollectionStoreId: row.data_collection_store_id || "",
      sku: safePatch.sku || row.source_sku || normalized.sku || "",
      productUrl: safePatch.productUrl || row.source_url || normalized.productUrl || "",
      status: row.status,
      listingDraft,
    });
    const mirrored = await mirrorCollectItemV3(item, {
      client,
      collectId: row.id,
      accountId: row.account_id,
      source: row.source || "ozon",
      identityKey: row.identity_key || "",
      expectedVersion: expectedVersion === null ? Number(row.draft_version || 0) : expectedVersion,
      captureRaw: false,
      changeReason: "USER_EDIT",
    });
    return {
      ...item,
      draftVersion: mirrored?.version || Number(row.draft_version || 1),
      pipelineVersion: "v4",
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function softDeleteCollectItemsForAccountV4(accountId, ids = []) {
  if (!listingPipelineEnabled()) return 0;
  const values = [...new Set(ids.map((id) => clean(id, 240)).filter(Boolean))];
  if (!values.length) return 0;
  const pool = await poolReady();
  const result = await pool.query(
    `UPDATE collect_items SET deleted_at=NOW(),status='DELETED',updated_at=NOW()
     WHERE account_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL`,
    [clean(accountId, 240), values],
  );
  return result.rowCount;
}

export async function softDeleteCollectItemsV3(accountId, ids = []) {
  return softDeleteCollectItemsForAccountV4(accountId, ids);
}

function publicJob(row = {}) {
  const itemRows = Array.isArray(row.items) ? row.items : [];
  return {
    id: row.id,
    localTaskId: row.id,
    clientJobId: row.id,
    listing: true,
    pipelineVersion: "v3",
    snapshotId: row.snapshot_id,
    collectBoxId: row.collect_item_id || "",
    accountId: row.account_id || "",
    storeId: row.store_id,
    type: row.type,
    status: row.status,
    ozonTaskId: row.ozon_task_id || "",
    taskId: row.ozon_task_id || row.id,
    itemCount: Number(row.item_count || 0),
    successCount: Number(row.success_count || 0),
    failedCount: Number(row.failed_count || 0),
    skippedCount: Number(row.skipped_count || 0),
    sku: row.source_sku || itemRows[0]?.sku || itemRows[0]?.offer_id || "",
    errorMessage: row.error_message || "",
    errorCode: row.error_code || "",
    statusMessage: row.status_message || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    correlationId: row.correlation_id,
    items: itemRows.map((item) => ({
      sku: item.sku,
      offer_id: item.offer_id,
      status: item.status,
      product_id: item.product_id,
      errors: item.error_message ? [{ code: item.error_code, message: item.error_message }] : [],
    })),
    statusResponse: { result: { items: itemRows.map((item) => item.response && Object.keys(item.response).length ? item.response : {
      sku: item.sku,
      offer_id: item.offer_id,
      status: item.status,
      product_id: item.product_id,
      errors: item.error_message ? [{ code: item.error_code, message: item.error_message }] : [],
    }) } },
  };
}

function listingPreparationIdempotencyKey(preparation) {
  return hash(["listing-prepare", preparation.accountId, preparation.idempotencyKey].join("|"));
}

async function readListingPreparationReplay(client, preparation, baseIdempotencyKey) {
  const existing = await client.query(
    `SELECT j.*, c.source_sku, s.idempotency_key,
            s.store_id AS frozen_store_id,
            s.collect_item_id AS frozen_collect_item_id,
            COALESCE((SELECT jsonb_agg(to_jsonb(si) ORDER BY si.sort_order) FROM submission_items si WHERE si.job_id=j.id),'[]'::jsonb) AS items
     FROM submission_snapshots s
     JOIN submission_jobs j ON j.snapshot_id=s.id
     LEFT JOIN collect_items c ON c.id=j.collect_item_id
     WHERE s.idempotency_key=$1 AND s.account_id=$2
     LIMIT 1`,
    [baseIdempotencyKey, preparation.accountId],
  );
  const latest = existing.rows[0];
  if (!latest) return null;
  resolveListingPreparationReplay({
    existing: {
      ...latest,
      store_id: latest.frozen_store_id,
      collect_item_id: latest.frozen_collect_item_id,
    },
    collectItemId: preparation.collectItemId,
    targetStoreId: preparation.targetStoreId,
  });
  return { duplicate: true, job: publicJob(latest) };
}

export async function findListingPreparationReplayV3(input = {}, { validateCollectItem = null } = {}) {
  if (!listingPipelineEnabled()) return null;
  const preparation = assertListingPreparationInput(input);
  const baseIdempotencyKey = listingPreparationIdempotencyKey(preparation);
  return transaction(async (client) => {
    const currentItem = await assertCollectItemAvailableForListing(
      client,
      preparation.collectItemId,
      preparation.accountId,
    );
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [baseIdempotencyKey]);
    const replay = await readListingPreparationReplay(client, preparation, baseIdempotencyKey);
    if (replay && typeof validateCollectItem === "function") {
      try {
        await validateCollectItem(currentItem);
      } catch (error) {
        throw markListingReplayPreflightError(error);
      }
    }
    return replay;
  });
}

export async function createSubmissionV3({
  collectItem,
  storeId,
  targetStoreId = "",
  accountId,
  idempotencyKey = "",
  normalizedItems,
  stocks = [],
  type = "COLLECT_BOX_DRAFT",
  versions = {},
  retryFailed = false,
}) {
  if (!listingPipelineEnabled()) return null;
  accountId = clean(accountId, 240);
  if (!accountId) {
    throw Object.assign(new Error("准备上架必须指定账号范围"), {
      status: 401,
      code: "COLLECT_ACCOUNT_REQUIRED",
    });
  }
  const preparation = targetStoreId || idempotencyKey
    ? assertListingPreparationInput({
        accountId,
        collectItemId: collectItem?.id,
        targetStoreId,
        idempotencyKey,
      })
    : null;
  const isCollectedListing = Boolean(preparation) || type === "COLLECT_BOX_DRAFT";
  if (preparation) storeId = preparation.targetStoreId;
  return transaction(async (client) => {
    let targetStore = null;
    let mirrored = null;
    let baseIdempotencyKey = preparation
      ? listingPreparationIdempotencyKey(preparation)
      : "";
    let latest = null;
    if (isCollectedListing && collectItem) {
      await assertCollectItemAvailableForListing(client, collectItem.id, accountId);
    }
    if (preparation) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [baseIdempotencyKey]);
      const replay = await readListingPreparationReplay(client, preparation, baseIdempotencyKey);
      if (replay) {
        try {
          assertCollectItemListingPayloadsReady(collectItem, normalizedItems);
        } catch (error) {
          throw markListingReplayPreflightError(error);
        }
        return replay;
      }
      assertCollectItemListingPayloadsReady(collectItem, normalizedItems);
      targetStore = await assertUsableOperatingStore({
        accountId: preparation.accountId,
        storeId: preparation.targetStoreId,
        requireCredentials: true,
        client,
      });
      mirrored = await mirrorCollectItemV3(collectItem, {
        accountId,
        storeId: preparation.targetStoreId,
        client,
        ...versions,
      });
    } else {
      if (isCollectedListing && collectItem) {
        assertCollectItemListingPayloadsReady(collectItem, normalizedItems);
      }
      mirrored = await mirrorCollectItemV3(collectItem, {
        accountId,
        storeId,
        client,
        ...versions,
      });
    }
    const frozenStoreId = targetStore?.id || storeId;
    const items = Array.isArray(normalizedItems) ? normalizedItems : [];
    const safeStocks = Array.isArray(stocks) ? stocks : [];
    const pricingRow = mirrored?.draftId
      ? await client.query("SELECT pricing_snapshot FROM product_drafts WHERE id = $1", [mirrored.draftId])
      : { rows: [] };
    const pricingSnapshot = pricingRow.rows[0]?.pricing_snapshot || {};
    const snapshotData = { items, stocks: safeStocks, pricingSnapshot };
    const snapshotHash = hash(snapshotData);
    const offers = items.map((item) => item.offer_id || item.sku || "").sort().join("|");
    if (!preparation) {
      baseIdempotencyKey = hash([frozenStoreId, offers, snapshotHash].join("|"));
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [baseIdempotencyKey]);
      const existing = await client.query(
        `SELECT j.*, c.source_sku,
                s.idempotency_key,
                COALESCE((SELECT jsonb_agg(to_jsonb(si) ORDER BY si.sort_order) FROM submission_items si WHERE si.job_id=j.id),'[]'::jsonb) AS items
         FROM submission_snapshots s
         JOIN submission_jobs j ON j.snapshot_id=s.id
         LEFT JOIN collect_items c ON c.id=j.collect_item_id
         WHERE s.store_id=$1 AND s.collect_item_id=$2 AND s.snapshot_hash=$3
           AND s.account_id=$4 AND c.account_id=$4
         ORDER BY s.created_at DESC
         LIMIT 1`,
        [frozenStoreId, collectItem.id, snapshotHash, accountId],
      );
      latest = existing.rows[0] || null;
    }
    if (preparation) {
      await assertListingStocksBelongToTarget({
        accountId: preparation.accountId,
        storeId: frozenStoreId,
        stocks: safeStocks,
        client,
      });
    }
    const retryableStatuses = new Set(["FAILED", "CANCELLED"]);
    if (latest && (!retryFailed || !retryableStatuses.has(String(latest.status || "").toUpperCase()))) {
      return { duplicate: true, job: publicJob(latest) };
    }
    const snapshotIdempotencyKey = latest
      ? hash([baseIdempotencyKey, "retry", latest.id].join("|"))
      : baseIdempotencyKey;

    const snapshotId = `snapshot_${crypto.randomUUID()}`;
    const jobId = `listing_${crypto.randomUUID()}`;
    const outboxId = `outbox_${crypto.randomUUID()}`;
    const correlationId = crypto.randomUUID();
    await client.query(
      `INSERT INTO submission_snapshots (
         id, collect_item_id, draft_id, draft_version, account_id, store_id,
         idempotency_key, snapshot_hash, item_count, items, stocks,
         normalizer_version, category_rule_version, dictionary_version, rich_content_rule_version,
         pricing_snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16::jsonb)`,
      [snapshotId, collectItem.id, mirrored?.draftId || null, mirrored?.version || 1, accountId || null, frozenStoreId, snapshotIdempotencyKey, snapshotHash, items.length, json(items), json(safeStocks), "v3", clean(versions.categoryRuleVersion, 120), clean(versions.dictionaryVersion, 120), clean(versions.richContentRuleVersion, 120), json(pricingSnapshot)],
    );
    await client.query(
      `INSERT INTO submission_jobs (
         id, snapshot_id, collect_item_id, account_id, store_id, type, status,
         item_count, correlation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,'QUEUE_PENDING',$7,$8)`,
      [jobId, snapshotId, collectItem.id, accountId || null, frozenStoreId, type, items.length, correlationId],
    );
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] || {};
      const variantKey = clean(item.sku || item.offer_id || `${index + 1}`, 240);
      await client.query(
        `INSERT INTO submission_items (
           id, job_id, snapshot_id, variant_key, sort_order, sku, offer_id, request_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [stableId("submititem", jobId, variantKey), jobId, snapshotId, variantKey, index, clean(item.scraped_sku || item.sku, 240), clean(item.offer_id, 240), hash(item)],
      );
    }
    await client.query(
      `INSERT INTO submission_events (job_id, to_status, event_type, message, actor_type, actor_id, payload)
       VALUES ($1,'QUEUE_PENDING','submission.created','已创建不可变上架快照','account',$2,$3::jsonb)`,
      [jobId, accountId || "", json({
        snapshotId,
        itemCount: items.length,
        snapshotHash,
        retryOfJobId: latest?.id || "",
        ...(targetStore ? { targetStore } : {}),
      })],
    );
    await client.query(
      `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
       VALUES ($1,'submission_job',$2,'listing.submit.requested',$3::jsonb,$4)`,
      [outboxId, jobId, json({ submissionJobId: jobId, action: "submit" }), `${jobId}:submit:0`],
    );
    await client.query(
      `INSERT INTO audit_events (account_id, store_id, action, entity_type, entity_id, correlation_id, metadata)
       VALUES ($1,$2,'LISTING_SUBMIT','submission_job',$3,$4,$5::jsonb)`,
      [accountId || null, frozenStoreId, jobId, correlationId, json({
        snapshotId,
        itemCount: items.length,
        retryOfJobId: latest?.id || "",
        ...(targetStore ? { targetStore } : {}),
      })],
    );
    await client.query(
      "UPDATE collect_items SET status='QUEUE_PENDING', updated_at=NOW() WHERE id=$1 AND account_id=$2",
      [collectItem.id, accountId],
    );
    const created = await client.query(
      `SELECT j.*, c.source_sku, '[]'::jsonb AS items FROM submission_jobs j
       LEFT JOIN collect_items c ON c.id=j.collect_item_id WHERE j.id=$1`,
      [jobId],
    );
    return { duplicate: false, job: publicJob(created.rows[0]) };
  });
}

export async function prepareCollectItemForListing({
  accountId,
  collectItemId,
  targetStoreId,
  idempotencyKey,
  collectItem,
  normalizedItems,
  stocks = [],
  type = "COLLECT_BOX_DRAFT",
  versions = {},
} = {}) {
  const preparation = assertListingPreparationInput({
    accountId,
    collectItemId,
    targetStoreId,
    idempotencyKey,
  });
  return createSubmissionV3({
    collectItem,
    accountId: preparation.accountId,
    storeId: preparation.targetStoreId,
    targetStoreId: preparation.targetStoreId,
    idempotencyKey: preparation.idempotencyKey,
    normalizedItems,
    stocks,
    type,
    versions,
  });
}

export async function listSubmissionJobsV3({ storeId = "", accountId = "", limit = 500 } = {}) {
  if (!listingPipelineEnabled()) return [];
  const pool = await poolReady();
  const params = [];
  const where = [];
  if (storeId) {
    params.push(storeId);
    where.push(`j.store_id=$${params.length}`);
  }
  if (accountId) {
    params.push(accountId);
    where.push(`j.account_id=$${params.length}`);
  }
  params.push(Math.max(1, Math.min(2000, Number(limit) || 500)));
  const result = await pool.query(
    `SELECT j.*, c.source_sku,
            COALESCE((SELECT jsonb_agg(to_jsonb(si) ORDER BY si.sort_order) FROM submission_items si WHERE si.job_id=j.id),'[]'::jsonb) AS items
     FROM submission_jobs j
     LEFT JOIN collect_items c ON c.id=j.collect_item_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY j.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(publicJob);
}

export async function hydrateLegacyStateWithV3(state = {}) {
  if (!listingPipelineEnabled()) return state;
  const accountIds = [...new Set(
    (state.accounts || []).map((account) => clean(account?.id, 240)).filter(Boolean),
  )];
  const relationalCollectItems = (
    await Promise.all(accountIds.map(async (accountId) =>
      attachTrustedCollectAccountScope(
        accountId,
        await listCollectItemsV3({ accountId, limit: 10000 }),
      )))
  ).flat();
  const legacyById = new Map((state.caches?.collectBox || []).map((item) => [String(item.id), item]));
  state.caches = state.caches || {};
  state.caches.collectBox = relationalCollectItems.map((item) => ({
    ...(legacyById.get(String(item.id)) || {}),
    ...item,
    listingDraft: item.listingDraft || legacyById.get(String(item.id))?.listingDraft || {},
  }));
  const jobs = await listSubmissionJobsV3({ limit: 1000 });
  state.jobs = state.jobs && typeof state.jobs === "object" ? state.jobs : {};
  for (const job of jobs) state.jobs[job.id] = job;
  const statusByCollect = new Map();
  for (const job of jobs) {
    if (job.collectBoxId && !statusByCollect.has(String(job.collectBoxId))) {
      statusByCollect.set(String(job.collectBoxId), job);
    }
  }
  state.caches.collectBox = (state.caches.collectBox || []).map((item) => {
    const job = statusByCollect.get(String(item.id));
    if (!job) return item;
    return {
      ...item,
      status: legacyCollectStatus(job.status),
      listingJobId: job.id,
      listingTaskId: job.ozonTaskId || "",
      listingLastError: job.errorMessage || "",
      listingStatusMessage: job.statusMessage || "",
      listingCompletedAt: job.completedAt || "",
    };
  });
  return state;
}

export async function getSubmissionJobV3(idOrTaskId, accountId) {
  if (!listingPipelineEnabled()) return null;
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT j.*, c.source_sku,
            COALESCE((SELECT jsonb_agg(to_jsonb(si) ORDER BY si.sort_order) FROM submission_items si WHERE si.job_id=j.id),'[]'::jsonb) AS items
     FROM submission_jobs j LEFT JOIN collect_items c ON c.id=j.collect_item_id
     WHERE j.account_id=$2 AND (j.id=$1 OR j.ozon_task_id=$1) LIMIT 1`,
    [String(idOrTaskId || ""), clean(accountId, 240)],
  );
  return result.rows[0] ? publicJob(result.rows[0]) : null;
}

export async function getSubmissionJobDetailV3(idOrTaskId, accountId) {
  if (!listingPipelineEnabled()) return null;
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT j.*, c.source_sku,
            s.snapshot_hash, s.draft_version, s.normalizer_version,
            s.category_rule_version, s.dictionary_version, s.rich_content_rule_version,
            COALESCE((SELECT jsonb_agg(to_jsonb(si) ORDER BY si.sort_order) FROM submission_items si WHERE si.job_id=j.id),'[]'::jsonb) AS items
     FROM submission_jobs j
     JOIN submission_snapshots s ON s.id=j.snapshot_id
     LEFT JOIN collect_items c ON c.id=j.collect_item_id
     WHERE j.account_id=$2 AND (j.id=$1 OR j.ozon_task_id=$1) LIMIT 1`,
    [String(idOrTaskId || ""), clean(accountId, 240)],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  const events = await pool.query(
    `SELECT id,from_status,to_status,event_type,message,actor_type,actor_id,created_at
     FROM submission_events WHERE job_id=$1 ORDER BY id`,
    [row.id],
  );
  return {
    ...publicJob(row),
    snapshot: {
      id: row.snapshot_id,
      hash: row.snapshot_hash,
      draftVersion: row.draft_version,
      normalizerVersion: row.normalizer_version,
      categoryRuleVersion: row.category_rule_version,
      dictionaryVersion: row.dictionary_version,
      richContentRuleVersion: row.rich_content_rule_version,
    },
    events: events.rows.map((event) => ({
      id: event.id,
      fromStatus: event.from_status,
      toStatus: event.to_status,
      type: event.event_type,
      message: event.message,
      actorType: event.actor_type,
      actorId: event.actor_id,
      createdAt: event.created_at,
    })),
  };
}

export async function loadSubmissionWorkV3(jobId) {
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT j.*, s.items, s.stocks, s.snapshot_hash, s.idempotency_key,
            c.source_sku, c.source_url
     FROM submission_jobs j
     JOIN submission_snapshots s ON s.id=j.snapshot_id
     LEFT JOIN collect_items c ON c.id=j.collect_item_id
     WHERE j.id=$1`,
    [jobId],
  );
  return result.rows[0] || null;
}

export async function readStoreCredentialV3(storeId, accountId = "") {
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT s.id, s.client_id, sc.encrypted_api_key, sc.iv, sc.auth_tag, sc.algorithm, sc.key_version
     FROM stores s
     JOIN store_credentials sc ON sc.store_id=s.id
     WHERE s.id=$1
       AND ($2='' OR s.owner_account_id=$2)
       AND s.status <> 'disabled'`,
    [storeId, clean(accountId, 240)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    apiKey: decryptSecret({ encrypted_api_key: row.encrypted_api_key, iv: row.iv, auth_tag: row.auth_tag }),
  };
}

export async function claimSubmissionJobV3(jobId, workerId, allowedStatuses) {
  const pool = await poolReady();
  const statuses = Array.isArray(allowedStatuses) && allowedStatuses.length ? allowedStatuses : ["QUEUED", "RETRY_PENDING"];
  const result = await pool.query(
    `UPDATE submission_jobs SET
       locked_by=$2, lock_expires_at=NOW() + INTERVAL '4 minutes', updated_at=NOW(), attempt_count=attempt_count+1
     WHERE id=$1 AND status = ANY($3::text[])
       AND (lock_expires_at IS NULL OR lock_expires_at < NOW() OR locked_by=$2)
     RETURNING *`,
    [jobId, workerId, statuses],
  );
  return result.rows[0] || null;
}

export async function releaseSubmissionLockV3(jobId, workerId) {
  const pool = await poolReady();
  await pool.query(
    "UPDATE submission_jobs SET locked_by='', lock_expires_at=NULL, updated_at=NOW() WHERE id=$1 AND locked_by=$2",
    [jobId, workerId],
  );
}

export async function incrementSubmissionStatusCheckV3(jobId) {
  const pool = await poolReady();
  const result = await pool.query(
    "UPDATE submission_jobs SET status_check_count=status_check_count+1, updated_at=NOW() WHERE id=$1 RETURNING status_check_count",
    [jobId],
  );
  return Number(result.rows[0]?.status_check_count || 0);
}

export async function transitionSubmissionJobV3(jobId, toStatus, patch = {}, event = {}) {
  return transaction(async (client) => {
    const current = await client.query("SELECT * FROM submission_jobs WHERE id=$1 FOR UPDATE", [jobId]);
    const row = current.rows[0];
    if (!row) throw new Error(`上架任务不存在: ${jobId}`);
    const fromStatus = row.status;
    if (fromStatus !== toStatus && !allowedTransitions.get(fromStatus)?.has(toStatus) && !event.force) {
      throw new Error(`不允许的上架状态迁移: ${fromStatus} -> ${toStatus}`);
    }
    const terminal = TERMINAL_SUBMISSION_STATUSES.has(toStatus);
    const result = await client.query(
      `UPDATE submission_jobs SET
         status=$2, status_version=status_version+1,
         ozon_task_id=COALESCE($3,ozon_task_id),
         success_count=COALESCE($4,success_count), failed_count=COALESCE($5,failed_count),
         skipped_count=COALESCE($6,skipped_count), error_code=COALESCE($7,error_code),
         error_message=COALESCE($8,error_message), status_message=COALESCE($9,status_message),
         result_summary=COALESCE($10::jsonb,result_summary),
         submitted_at=CASE WHEN $2='SUBMITTING' THEN COALESCE(submitted_at,NOW()) ELSE submitted_at END,
         accepted_at=CASE WHEN $2='OZON_ACCEPTED' THEN COALESCE(accepted_at,NOW()) ELSE accepted_at END,
         completed_at=CASE WHEN $11 THEN COALESCE(completed_at,NOW()) ELSE completed_at END,
         locked_by=CASE WHEN $11 THEN '' ELSE locked_by END,
         lock_expires_at=CASE WHEN $11 THEN NULL ELSE lock_expires_at END,
         updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [jobId, toStatus, patch.ozonTaskId ?? null, patch.successCount ?? null, patch.failedCount ?? null, patch.skippedCount ?? null, patch.errorCode ?? null, patch.errorMessage ?? null, patch.statusMessage ?? null, patch.resultSummary === undefined ? null : json(patch.resultSummary), terminal],
    );
    await client.query(
      `INSERT INTO submission_events (job_id, from_status, to_status, event_type, message, actor_type, actor_id, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [jobId, fromStatus, toStatus, event.type || "submission.status_changed", event.message || patch.statusMessage || patch.errorMessage || "", event.actorType || "worker", event.actorId || "", json(event.payload || {})],
    );
    if (row.collect_item_id) {
      await client.query(
        "UPDATE collect_items SET status=$2, updated_at=NOW() WHERE id=$1 AND account_id=$3",
        [row.collect_item_id, toStatus, row.account_id],
      );
    }
    return result.rows[0];
  });
}

export async function updateSubmissionItemsV3(jobId, items = []) {
  return transaction(async (client) => {
    const current = await client.query("SELECT * FROM submission_items WHERE job_id=$1 ORDER BY sort_order", [jobId]);
    for (let index = 0; index < current.rows.length; index += 1) {
      const target = current.rows[index];
      const update = items.find((item) => (item.offerId && item.offerId === target.offer_id) || (item.sku && item.sku === target.sku)) || items[index];
      if (!update) continue;
      await client.query(
        `UPDATE submission_items SET status=$2, product_id=$3, error_code=$4, error_message=$5, response=$6::jsonb, updated_at=NOW() WHERE id=$1`,
        [target.id, update.status || target.status, update.productId || "", update.errors?.[0] ? clean(update.errors[0], 160) : "", clean((update.errors || []).join("；"), 3000), json(update.response || {})],
      );
    }
  });
}

export async function enqueueSubmissionActionV3(jobId, action, delaySeconds = 0) {
  const pool = await poolReady();
  const eventId = `outbox_${crypto.randomUUID()}`;
  const job = await pool.query("SELECT attempt_count,status_check_count,status_version FROM submission_jobs WHERE id=$1", [jobId]);
  if (!job.rowCount) return "";
  const row = job.rows[0];
  const generation = action === "check"
    ? `check:${Number(row.status_check_count || 0)}:${Number(row.status_version || 0)}`
    : `submit:${Number(row.attempt_count || 0)}:${Number(row.status_version || 0)}`;
  const dedupeKey = `${jobId}:${generation}`;
  const result = await pool.query(
    `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, available_at, dedupe_key)
     VALUES ($1,'submission_job',$2,$3,$4::jsonb,NOW() + ($5::text || ' seconds')::interval,$6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [eventId, jobId, action === "check" ? "listing.check.requested" : "listing.submit.requested", json({ submissionJobId: jobId, action }), Math.max(0, Number(delaySeconds) || 0), dedupeKey],
  );
  return result.rows[0]?.id || "";
}

export async function recoverStaleSubmissionJobsV3({ workerId = "listing-watchdog", limit = 50 } = {}) {
  return transaction(async (client) => {
    const result = await client.query(
      `SELECT j.* FROM submission_jobs j
       WHERE j.status NOT IN ('SUCCEEDED','PARTIAL_SUCCESS','FAILED','CANCELLED')
         AND j.updated_at < NOW() - INTERVAL '5 minutes'
         AND (j.lock_expires_at IS NULL OR j.lock_expires_at < NOW())
         AND NOT EXISTS (
           SELECT 1 FROM outbox_events o
           WHERE o.aggregate_id=j.id AND o.status IN ('PENDING','PUBLISHING')
         )
       ORDER BY j.updated_at
       FOR UPDATE SKIP LOCKED LIMIT $1`,
      [Math.max(1, Math.min(200, Number(limit) || 50))],
    );
    const recovered = [];
    for (const row of result.rows) {
      let nextStatus = row.status;
      let action = "";
      let message = "";
      if (["QUEUE_PENDING", "QUEUED", "RETRY_PENDING"].includes(row.status)) {
        action = "submit";
        message = "检测到未投递的上架任务，已重新写入 Outbox";
      } else if (row.status === "VALIDATING") {
        nextStatus = "RETRY_PENDING";
        action = "submit";
        message = "Worker 在调用 Ozon 前中断，任务可以安全重试";
      } else if (row.status === "SUBMITTING") {
        nextStatus = "RECONCILING";
        message = "Ozon 请求结果未知，已停止自动重提以避免重复创建商品";
      } else if (["OZON_ACCEPTED", "CHECKING", "RECONCILING"].includes(row.status) && row.ozon_task_id) {
        nextStatus = "CHECKING";
        action = "check";
        message = "检测到状态查询中断，已恢复 Ozon 结果核对";
      } else {
        continue;
      }
      await client.query(
        `UPDATE submission_jobs SET status=$2, status_version=status_version+1,
           locked_by='', lock_expires_at=NULL, status_message=$3, updated_at=NOW()
         WHERE id=$1`,
        [row.id, nextStatus, message],
      );
      await client.query(
        `INSERT INTO submission_events (job_id,from_status,to_status,event_type,message,actor_type,actor_id)
         VALUES ($1,$2,$3,'submission.watchdog_recovered',$4,'watchdog',$5)`,
        [row.id, row.status, nextStatus, message, workerId],
      );
      if (action) {
        const eventType = action === "check" ? "listing.check.requested" : "listing.submit.requested";
        await client.query(
          `INSERT INTO outbox_events (id,aggregate_type,aggregate_id,event_type,payload,dedupe_key)
           VALUES ($1,'submission_job',$2,$3,$4::jsonb,$5)
           ON CONFLICT DO NOTHING`,
          [`outbox_${crypto.randomUUID()}`, row.id, eventType, json({ submissionJobId: row.id, action, recovered: true }), `${row.id}:${action}:watchdog:${row.status_version}`],
        );
      }
      recovered.push({ id: row.id, fromStatus: row.status, toStatus: nextStatus, action });
    }
    return recovered;
  });
}

export async function claimOutboxEventsV3(workerId, limit = 50) {
  return transaction(async (client) => {
    const result = await client.query(
      `WITH selected AS (
         SELECT id FROM outbox_events
         WHERE available_at <= NOW()
           AND (status='PENDING' OR (status='PUBLISHING' AND lock_expires_at < NOW()))
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE outbox_events o SET status='PUBLISHING', locked_by=$1,
         lock_expires_at=NOW() + INTERVAL '1 minute', attempt_count=attempt_count+1, updated_at=NOW()
       FROM selected WHERE o.id=selected.id RETURNING o.*`,
      [workerId, Math.max(1, Math.min(200, Number(limit) || 50))],
    );
    return result.rows;
  });
}

export async function markOutboxPublishedV3(eventId) {
  const pool = await poolReady();
  await pool.query("UPDATE outbox_events SET status='PUBLISHED', published_at=NOW(), locked_by='', lock_expires_at=NULL, updated_at=NOW() WHERE id=$1", [eventId]);
}

export async function markOutboxFailedV3(eventId, error) {
  const pool = await poolReady();
  await pool.query(
    `UPDATE outbox_events SET
       status=CASE WHEN attempt_count >= 10 THEN 'FAILED' ELSE 'PENDING' END,
       available_at=NOW() + (LEAST(300, GREATEST(2, attempt_count * attempt_count))::text || ' seconds')::interval,
       locked_by='', lock_expires_at=NULL, last_error=$2, updated_at=NOW()
     WHERE id=$1`,
    [eventId, clean(error?.message || error, 2000)],
  );
}

export async function patchLegacyCollectStatusV3(accountId, collectItemId, patch = {}) {
  if (!postgresEnabled() || !accountId || !collectItemId) return;
  const pool = await poolReady();
  const table = process.env.POSTGRES_STATE_TABLE || "local_state";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return;
  await pool.query(
    `UPDATE ${table} SET
       state=jsonb_set(
         state,
         '{caches,collectBox}',
         COALESCE((
           SELECT jsonb_agg(
             CASE
               WHEN value->>'id'=$1 AND value->>'accountId'=$3
                 THEN value || $2::jsonb
               ELSE value
             END
             ORDER BY ordinality
           )
           FROM jsonb_array_elements(COALESCE(state #> '{caches,collectBox}','[]'::jsonb)) WITH ORDINALITY
         ),'[]'::jsonb),
         true
       ), version=version+1, updated_at=NOW()
     WHERE id='local-state'`,
    [String(collectItemId), json(patch), String(accountId)],
  ).catch(() => {});
}

export async function listingPipelineHealth() {
  if (!listingPipelineEnabled()) return { enabled: false };
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM submission_jobs WHERE status NOT IN ('SUCCEEDED','PARTIAL_SUCCESS','FAILED','CANCELLED')) AS active_jobs,
       (SELECT COUNT(*)::int FROM submission_jobs WHERE status='RECONCILING') AS reconciliation_jobs,
       (SELECT COUNT(*)::int FROM submission_jobs WHERE status NOT IN ('SUCCEEDED','PARTIAL_SUCCESS','FAILED','CANCELLED') AND updated_at < NOW() - INTERVAL '5 minutes') AS stale_jobs,
       (SELECT COUNT(*)::int FROM outbox_events WHERE status IN ('PENDING','PUBLISHING')) AS pending_outbox,
       (SELECT COUNT(*)::int FROM outbox_events WHERE status='FAILED') AS failed_outbox`,
  );
  return { enabled: true, ...(result.rows[0] || {}) };
}
