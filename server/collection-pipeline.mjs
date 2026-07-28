import crypto from "node:crypto";
import { getPostgresPool, postgresEnabled } from "./db/connection.mjs";
import { runMigrations } from "./db/migrate.mjs";
import { mirrorCollectItemV3 } from "./listing-pipeline.mjs";

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

function normalizeCompanyId(value) {
  return clean(value, 80).replace(/[^\d]/g, "");
}

function publicCollectionStore(row = {}) {
  return {
    id: row.data_collection_store_id || row.id || "",
    label: row.label || "数据采集店铺",
    sellerCompanyId: row.seller_company_id || "",
    ownerAccountId: row.account_id || "",
    status: row.status || "active",
    note: row.note || "",
    isActive: row.is_current === true,
    createdAt: row.membership_created_at || row.created_at || "",
    updatedAt: row.membership_updated_at || row.updated_at || "",
    lastVerifiedAt: row.last_verified_at || "",
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

export async function backfillCollectionStoresFromLegacy(state = {}) {
  if (!postgresEnabled()) return;
  const stores = Array.isArray(state.dataCollectionStores) ? state.dataCollectionStores : [];
  if (!stores.length) return;
  await transaction(async (client) => {
    for (const legacy of stores) {
      const accountId = clean(legacy.ownerAccountId, 240);
      const sellerCompanyId = normalizeCompanyId(legacy.sellerCompanyId);
      if (!accountId || !sellerCompanyId) continue;
      const account = await client.query("SELECT 1 FROM accounts WHERE id=$1", [accountId]);
      if (!account.rowCount) continue;
      const preferredId = clean(legacy.id, 240) || stableId("collectstore", sellerCompanyId);
      const storeResult = await client.query(
        `INSERT INTO data_collection_stores (id, seller_company_id, created_at, updated_at)
         VALUES ($1,$2,COALESCE($3::timestamptz,NOW()),NOW())
         ON CONFLICT (seller_company_id) DO UPDATE SET updated_at=NOW()
         RETURNING id`,
        [preferredId, sellerCompanyId, legacy.createdAt || null],
      );
      const storeId = storeResult.rows[0].id;
      const owner = await client.query(
        `SELECT account_id FROM account_data_collection_stores
         WHERE data_collection_store_id=$1 LIMIT 1`,
        [storeId],
      );
      if (owner.rowCount && owner.rows[0].account_id !== accountId) {
        // Legacy state must never turn one Seller company into a
        // cross-account data-store membership.
        continue;
      }
      const currentId = state.currentDataCollectionStoreIdsByAccount?.[accountId]
        || (state.currentAccountId === accountId ? state.currentDataCollectionStoreId : "");
      const isCurrent = String(currentId || "") === String(legacy.id || "");
      if (isCurrent) {
        await client.query("UPDATE account_data_collection_stores SET is_current=FALSE WHERE account_id=$1", [accountId]);
      }
      await client.query(
        `INSERT INTO account_data_collection_stores (
           account_id, data_collection_store_id, label, status, note, is_current,
           last_verified_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,NOW()),NOW())
         ON CONFLICT (account_id, data_collection_store_id) DO UPDATE SET
           label=EXCLUDED.label, status=EXCLUDED.status, note=EXCLUDED.note,
           is_current=CASE WHEN EXCLUDED.is_current THEN TRUE ELSE account_data_collection_stores.is_current END,
           last_verified_at=COALESCE(EXCLUDED.last_verified_at,account_data_collection_stores.last_verified_at),
           updated_at=NOW()`,
        [accountId, storeId, clean(legacy.label, 120), legacy.status === "disabled" ? "disabled" : "active", clean(legacy.note, 240), isCurrent, legacy.lastVerifiedAt || null, legacy.createdAt || null],
      );
    }
  });
}

export async function hydrateCollectionStoresIntoState(state = {}) {
  if (!postgresEnabled()) return state;
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT m.account_id, m.data_collection_store_id, m.label, m.status, m.note,
            m.is_current, m.last_verified_at, m.created_at AS membership_created_at,
            m.updated_at AS membership_updated_at, s.seller_company_id
     FROM account_data_collection_stores m
     JOIN data_collection_stores s ON s.id=m.data_collection_store_id
     ORDER BY m.account_id, m.is_current DESC, m.updated_at DESC`,
  );
  state.dataCollectionStores = result.rows.map(publicCollectionStore);
  state.currentDataCollectionStoreIdsByAccount = {};
  for (const row of result.rows) {
    if (row.is_current) state.currentDataCollectionStoreIdsByAccount[row.account_id] = row.data_collection_store_id;
  }
  const currentAccountId = clean(state.currentAccountId, 240);
  state.currentDataCollectionStoreId = state.currentDataCollectionStoreIdsByAccount[currentAccountId] || "";
  return state;
}

export async function listCollectionStoresForAccount(accountId) {
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT m.account_id, m.data_collection_store_id, m.label, m.status, m.note,
            m.is_current, m.last_verified_at, m.created_at AS membership_created_at,
            m.updated_at AS membership_updated_at, s.seller_company_id
     FROM account_data_collection_stores m
     JOIN data_collection_stores s ON s.id=m.data_collection_store_id
     WHERE m.account_id=$1
     ORDER BY m.is_current DESC, m.updated_at DESC`,
    [accountId],
  );
  return result.rows.map(publicCollectionStore);
}

export async function upsertCollectionStoreForAccount(accountId, input = {}) {
  const sellerCompanyId = normalizeCompanyId(input.sellerCompanyId || input.companyId || input.scCompanyId);
  if (!sellerCompanyId) {
    const error = new Error("Client ID 必填");
    error.status = 400;
    throw error;
  }
  return transaction(async (client) => {
    const storeResult = await client.query(
      `INSERT INTO data_collection_stores (id,seller_company_id)
       VALUES ($1,$2)
       ON CONFLICT (seller_company_id) DO UPDATE SET updated_at=NOW()
       RETURNING id,seller_company_id`,
      [stableId("collectstore", sellerCompanyId), sellerCompanyId],
    );
    const storeId = storeResult.rows[0].id;
    const existingOwner = await client.query(
      `SELECT account_id FROM account_data_collection_stores
       WHERE data_collection_store_id=$1 LIMIT 1`,
      [storeId],
    );
    if (existingOwner.rowCount && existingOwner.rows[0].account_id !== accountId) {
      const error = new Error("该 Ozon 数据采集店铺已绑定到其他 sonli 账号");
      error.status = 409;
      error.code = "DATA_COLLECTION_STORE_ALREADY_OWNED";
      throw error;
    }
    await client.query("UPDATE account_data_collection_stores SET is_current=FALSE,updated_at=NOW() WHERE account_id=$1 AND is_current", [accountId]);
    const membership = await client.query(
      `INSERT INTO account_data_collection_stores (
         account_id,data_collection_store_id,label,status,note,is_current
       ) VALUES ($1,$2,$3,$4,$5,TRUE)
       ON CONFLICT (account_id,data_collection_store_id) DO UPDATE SET
         label=EXCLUDED.label,status=EXCLUDED.status,note=EXCLUDED.note,is_current=TRUE,updated_at=NOW()
       RETURNING *`,
      [accountId, storeId, clean(input.label || `采集店铺 ${sellerCompanyId}`, 120), input.status === "disabled" ? "disabled" : "active", clean(input.note, 240)],
    );
    return publicCollectionStore({ ...membership.rows[0], seller_company_id: sellerCompanyId });
  });
}

export async function setCurrentCollectionStoreForAccount(accountId, storeId) {
  return transaction(async (client) => {
    const target = await client.query(
      `SELECT m.*,s.seller_company_id
       FROM account_data_collection_stores m
       JOIN data_collection_stores s ON s.id=m.data_collection_store_id
       WHERE m.account_id=$1 AND m.data_collection_store_id=$2 AND m.status='active'
       FOR UPDATE`,
      [accountId, storeId],
    );
    if (!target.rowCount) {
      const error = new Error("数据采集店铺不存在或已停用");
      error.status = 404;
      throw error;
    }
    await client.query("UPDATE account_data_collection_stores SET is_current=FALSE,updated_at=NOW() WHERE account_id=$1 AND is_current", [accountId]);
    const updated = await client.query(
      `UPDATE account_data_collection_stores SET is_current=TRUE,updated_at=NOW()
       WHERE account_id=$1 AND data_collection_store_id=$2 RETURNING *`,
      [accountId, storeId],
    );
    return publicCollectionStore({ ...updated.rows[0], seller_company_id: target.rows[0].seller_company_id });
  });
}

export async function deleteCollectionStoreForAccount(accountId, storeId) {
  return transaction(async (client) => {
    const deleted = await client.query(
      "DELETE FROM account_data_collection_stores WHERE account_id=$1 AND data_collection_store_id=$2 RETURNING is_current",
      [accountId, storeId],
    );
    if (!deleted.rowCount) return false;
    if (deleted.rows[0].is_current) {
      await client.query(
        `UPDATE account_data_collection_stores SET is_current=TRUE,updated_at=NOW()
         WHERE (account_id,data_collection_store_id)=(
           SELECT account_id,data_collection_store_id FROM account_data_collection_stores
           WHERE account_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1
         )`,
        [accountId],
      );
    }
    return true;
  });
}

export async function verifyCollectionStoreForAccount(accountId, companyIds = [], requestId = "") {
  const actualCompanyIds = [...new Set(companyIds.map(normalizeCompanyId).filter(Boolean))];
  if (!actualCompanyIds.length) {
    const error = new Error("未检测到当前 Ozon 登录店铺，请先登录 seller.ozon.ru");
    error.status = 400;
    throw error;
  }
  try {
    return await transaction(async (client) => {
    const stores = await client.query(
      `SELECT m.*,s.seller_company_id
       FROM account_data_collection_stores m
       JOIN data_collection_stores s ON s.id=m.data_collection_store_id
       WHERE m.account_id=$1 AND m.status='active'
       ORDER BY m.is_current DESC,m.updated_at DESC
       FOR UPDATE OF m`,
      [accountId],
    );
    if (!stores.rowCount) {
      const error = new Error("请先在经营店铺页面设置数据采集店铺");
      error.status = 400;
      throw error;
    }
    const current = stores.rows.find((row) => row.is_current) || null;
    const matched = stores.rows.find((row) => actualCompanyIds.includes(normalizeCompanyId(row.seller_company_id))) || null;
    if (!matched) {
      const error = new Error(`当前 Ozon 登录店铺不属于当前 sonli 账号已绑定的数据采集店铺，请切换到「${current?.label || stores.rows[0].label || "数据采集店铺"}」或新增对应数据采集店铺后再采集`);
      error.status = 409;
      error.verificationFailure = {
        sellerCompanyId: actualCompanyIds[0],
        requestId: clean(requestId, 240),
      };
      throw error;
    }
    const switched = !current || current.data_collection_store_id !== matched.data_collection_store_id;
    if (switched) {
      await client.query("UPDATE account_data_collection_stores SET is_current=FALSE,updated_at=NOW() WHERE account_id=$1 AND is_current", [accountId]);
    }
    const updated = await client.query(
      `UPDATE account_data_collection_stores SET
         is_current=TRUE,last_verified_at=NOW(),updated_at=NOW()
       WHERE account_id=$1 AND data_collection_store_id=$2 RETURNING *`,
      [accountId, matched.data_collection_store_id],
    );
    await client.query(
      `INSERT INTO collection_store_verifications (
         account_id,data_collection_store_id,seller_company_id,matched,switched,request_id
       ) VALUES ($1,$2,$3,TRUE,$4,$5)`,
      [accountId, matched.data_collection_store_id, matched.seller_company_id, switched, clean(requestId, 240)],
    );
    return {
      store: publicCollectionStore({ ...updated.rows[0], seller_company_id: matched.seller_company_id }),
      switched,
    };
    });
  } catch (error) {
    if (error?.verificationFailure) {
      const pool = await poolReady();
      await pool.query(
        `INSERT INTO collection_store_verifications (account_id,seller_company_id,matched,request_id)
         VALUES ($1,$2,FALSE,$3)`,
        [accountId, error.verificationFailure.sellerCompanyId, error.verificationFailure.requestId],
      ).catch(() => {});
    }
    throw error;
  }
}

export async function ingestCollectRequestV4({
  accountId,
  storeId = "",
  dataCollectionStoreId = "",
  source = "ozon",
  item = {},
  idempotencyKey = "",
}) {
  if (!postgresEnabled()) return null;
  accountId = clean(accountId, 240);
  if (!accountId) {
    const error = new Error("请先登录 sonli");
    error.status = 401;
    error.code = "COLLECT_ACCOUNT_REQUIRED";
    throw error;
  }
  storeId = clean(storeId, 240);
  dataCollectionStoreId = clean(dataCollectionStoreId, 240);
  const sourceId = clean(source || "ozon", 80).toLowerCase();
  const sourceSku = clean(item.sku || item.sourceExternalId || item.id, 240);
  if (!sourceSku) {
    const error = new Error("采集数据缺少 SKU");
    error.status = 422;
    throw error;
  }
  const canonical = canonicalJson(item);
  const contentHash = sha256(canonical);
  const requestHash = sha256(JSON.stringify({ accountId, storeId, dataCollectionStoreId, sourceId, sourceSku, contentHash }));
  const resolvedIdempotencyKey = clean(idempotencyKey, 240)
    || `collect-${crypto.randomUUID()}`;
  const identityKey = sha256([accountId, storeId, dataCollectionStoreId, sourceId, sourceSku].join("|"));
  const collectId = stableId("collect", identityKey);
  const requestId = stableId("collectreq", accountId, resolvedIdempotencyKey);
  const normalizedItem = {
    ...item,
    id: collectId,
    accountId,
    storeId,
    localStoreId: storeId,
    dataCollectionStoreId,
    source: sourceId,
  };

  if (sourceId === "ozon" && !dataCollectionStoreId) {
    const error = new Error("Ozon 采集必须先验证并选择数据采集店铺");
    error.status = 409;
    error.code = "DATA_COLLECTION_STORE_REQUIRED";
    throw error;
  }

  try {
    return await transaction(async (client) => {
      if (storeId) {
        const operatingStore = await client.query(
          `SELECT 1 FROM stores
           WHERE id=$1 AND owner_account_id=$2 AND COALESCE(status,'')<>'disabled'`,
          [storeId, accountId],
        );
        if (!operatingStore.rowCount) {
          const error = new Error("经营店铺不存在、不属于当前账号或已停用");
          error.status = 403;
          error.code = "STORE_ACCOUNT_FORBIDDEN";
          throw error;
        }
      }
      if (dataCollectionStoreId) {
        const membership = await client.query(
          `SELECT 1 FROM account_data_collection_stores
           WHERE account_id=$1 AND data_collection_store_id=$2 AND status='active'`,
          [accountId, dataCollectionStoreId],
        );
        if (!membership.rowCount) {
          const error = new Error("数据采集店铺不属于当前账号或已停用");
          error.status = 409;
          throw error;
        }
      }
      const inserted = await client.query(
        `INSERT INTO collect_requests (
           id,idempotency_key,account_id,store_id,data_collection_store_id,
           source,source_sku,request_hash,content_hash,status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PROCESSING')
         ON CONFLICT (account_id,idempotency_key) WHERE account_id IS NOT NULL
         DO NOTHING RETURNING id`,
        [requestId, resolvedIdempotencyKey, accountId, storeId || null, dataCollectionStoreId || null, sourceId, sourceSku, requestHash, contentHash],
      );
      if (!inserted.rowCount) {
        const existing = await client.query(
          "SELECT * FROM collect_requests WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE",
          [accountId, resolvedIdempotencyKey],
        );
        const row = existing.rows[0];
        if (!row) {
          const error = new Error("采集幂等请求冲突");
          error.status = 409;
          error.code = "COLLECT_IDEMPOTENCY_CONFLICT";
          throw error;
        }
        if (row?.request_hash !== requestHash) {
          const error = new Error("幂等键已被不同采集请求使用");
          error.status = 409;
          error.code = "IDEMPOTENCY_KEY_REUSED";
          throw error;
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
        storeId,
        dataCollectionStoreId,
        source: sourceId,
        identityKey,
        contentHash,
        requestId,
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
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'FAILED',$10,$11,NOW())
       ON CONFLICT (account_id,idempotency_key) WHERE account_id IS NOT NULL DO UPDATE SET
         status='FAILED',error_code=EXCLUDED.error_code,error_message=EXCLUDED.error_message,
         completed_at=NOW(),updated_at=NOW()
       WHERE collect_requests.request_hash=EXCLUDED.request_hash
         AND collect_requests.status<>'SUCCEEDED'`,
      [requestId, resolvedIdempotencyKey, accountId, error?.code === "STORE_ACCOUNT_FORBIDDEN" ? null : (storeId || null), dataCollectionStoreId || null, sourceId, sourceSku, requestHash, contentHash, clean(error.code || (error.status ? `HTTP_${error.status}` : "COLLECT_FAILED"), 120), clean(error.message || error, 2000)],
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
