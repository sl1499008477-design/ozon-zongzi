import crypto from "node:crypto";
import { getPostgresPool, postgresEnabled } from "./db/connection.mjs";
import { runMigrations } from "./db/migrate.mjs";
import { mirrorCollectItemV3 } from "./listing-pipeline.mjs";
import { findRetiredCollectorScopePath } from "./collector-scope-sanitizer.mjs";

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

function canonicalValue(value, key = "") {
  const volatile = new Set([
    "collectedAt", "createdAt", "updatedAt", "scrapedAt", "savedAt", "timestamp",
    "listingSubmittedAt", "listingCompletedAt", "listingLastErrorAt",
  ]);
  if (volatile.has(key)) return undefined;
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
  const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    ? input.payload
    : {};
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
      ...payload,
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
    identityKey,
    contentHash,
    requestHash,
    collectId,
    persistedRequestId: requestId,
    normalizedItem,
  } = prepared;
  const {
    accountId,
    source: sourceId,
    sourceSku,
    requestId: sourceRequestId,
  } = identity;

  try {
    return await transaction(async (client) => {
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
        if (row?.status === "SUCCEEDED") {
          return { duplicate: true, requestId: row.id, item: row.response?.item || normalizedItem, collectItemId: row.collect_item_id };
        }
        await client.query(
          `UPDATE collect_requests SET status='PROCESSING',attempt_count=attempt_count+1,
             error_code='',error_message='',updated_at=NOW() WHERE id=$1 AND account_id=$2`,
          [row.id, accountId],
        );
      }
      const mirrored = await mirrorCollectItemV3(normalizedItem, {
        client,
        collectId,
        accountId,
        source: sourceId,
        identityKey,
        contentHash,
        requestId: sourceRequestId,
        captureRaw: true,
        changeReason: "PREPROCESSED",
      });
      const response = {
        item: { ...normalizedItem, draftVersion: mirrored?.version || 1, pipelineVersion: "v4" },
        collectItemId: collectId,
        draftId: mirrored?.draftId || "",
        draftVersion: mirrored?.version || 1,
        action: mirrored?.created ? "created" : "updated",
      };
      await client.query(
        `UPDATE collect_requests SET status='SUCCEEDED',collect_item_id=$2,response=$3::jsonb,
           completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND account_id=$4`,
        [requestId, collectId, JSON.stringify(response), accountId],
      );
      return { duplicate: false, requestId, ...response };
    });
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
