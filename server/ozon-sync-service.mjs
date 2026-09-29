import crypto from "node:crypto";
import { activeStore, storesForAccount } from "./account-context.mjs";
import { appendAuditEvent } from "./audit-event.mjs";
import { callOzonSellerApi } from "./ozon-client.mjs";
import {
  cacheItemMatchesStore,
  cacheItemsForStore,
  cacheItemScope,
  upsertCacheItemByStore,
  upsertProductByStore,
} from "./store-cache-scope.mjs";

const cleanText = (value, maxLength = 160) =>
  String(value ?? "").trim().slice(0, maxLength);
const LOCAL_STATE_SAVE_MAX_ATTEMPTS = 4;
const STORE_SYNC_JOB_KIND = "STORE_SYNC";
const SUPPORTED_SYNC_TYPES = new Set(["PRODUCTS", "WAREHOUSES"]);
const RETIRED_SYNC_TYPES = new Set(["POSTINGS", "PROMOTIONS"]);
const SYNC_COVERAGE_BY_TYPE = Object.freeze({
  PRODUCTS: Object.freeze([
    "PROFILE",
    "PRODUCTS",
    "ARCHIVED_PRODUCTS",
    "ARCHIVE_CLEANUP",
    "PRICES",
    "MARKETING_PRICES",
    "FBS_STOCK",
    "FBO_STOCK",
  ]),
  WAREHOUSES: Object.freeze([
    "PROFILE",
    "WAREHOUSES",
  ]),
});

function sanitizedSyncText(value, store, maxLength = 500) {
  let text = String(value ?? "");
  for (const credential of [store?.clientId, store?.apiKey]) {
    const secret = String(credential || "");
    if (secret) text = text.replaceAll(secret, "[REDACTED]");
  }
  return text
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .trim()
    .slice(0, maxLength);
}

function safeSyncErrorDetails(error, store) {
  const source = error?.body && typeof error.body === "object" ? error.body : {};
  const details = {};
  const status = Number(error?.status || source.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) details.status = status;
  for (const [key, maxLength] of [
    ["apiPath", 240],
    ["phase", 80],
    ["responseFormat", 40],
  ]) {
    const value = sanitizedSyncText(source[key], store, maxLength);
    if (value) details[key] = value;
  }
  if (source.network === true) details.network = true;
  return details;
}

function attachSyncErrorContext(error, {
  accountId,
  storeId,
  type,
  timestamp,
  taskId,
  requestId,
  store = null,
  details = {},
}) {
  error.body = {
    accountId: String(accountId || ""),
    storeId: String(storeId || ""),
    type: String(type || ""),
    timestamp: String(timestamp || ""),
    taskId: String(taskId || ""),
    requestId: String(requestId || ""),
    code: String(error?.code || "STORE_SYNC_FAILED").slice(0, 120),
    message: sanitizedSyncText(error?.message || error || "店铺同步失败", store, 500),
    details,
  };
  return error;
}

function publicSyncErrorResponse(error) {
  const body = error?.body && typeof error.body === "object"
    ? error.body
    : { code: "STORE_SYNC_FAILED", message: "店铺同步失败" };
  return {
    status: Number(error?.status || 502),
    body: { ok: false, ...body },
  };
}

function failedSyncReplayError(report) {
  const error = new Error(report.error || "店铺同步失败");
  error.status = Number(report.errorStatus || report.details?.error?.status || 502);
  error.code = String(report.errorCode || "STORE_SYNC_FAILED");
  error.body = {
    accountId: report.accountId,
    storeId: report.storeId,
    type: report.type,
    timestamp: report.timestamp,
    taskId: report.taskId,
    requestId: report.requestId,
    code: error.code,
    message: error.message,
    details: structuredClone(report.details?.error || {}),
  };
  return error;
}

function storeSyncTaskId({ accountId, storeId, type, clientJobId }) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([accountId, storeId, type, clientJobId]))
    .digest("hex");
  return `store_sync_${digest.slice(0, 40)}`;
}

function storeSyncRequestHash({ requestId }) {
  return crypto
    .createHash("sha256")
    // Keep the old null option in the digest so retained sync replays remain compatible.
    .update(JSON.stringify({ requestId, postingsSinceDays: null }))
    .digest("hex");
}

function truthyOzonFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (["true", "1", "yes", "y", "premium", "premium_plus", "active", "grace_good"].includes(text)) return true;
  if (["false", "0", "no", "n", "standard", "free", "none", "inactive", "not_premium"].includes(text)) return false;
  return null;
}

function firstCleanText(values, maxLength = 160) {
  for (const value of values) {
    const text = cleanText(value, maxLength);
    if (text) return text;
  }
  return "";
}

function supportedStoreCurrency(value) {
  const currency = cleanText(value, 12).toUpperCase();
  return ["RUB", "CNY"].includes(currency) ? currency : "";
}

function extractSellerInfoProfile(payload = {}) {
  const source = payload?.result && typeof payload.result === "object" ? payload.result : payload;
  const company = source?.company && typeof source.company === "object" ? source.company : {};
  const subscription = source?.subscription && typeof source.subscription === "object" ? source.subscription : {};
  const premiumCandidates = [
    subscription.is_premium,
    subscription.isPremium,
    subscription.premium,
    subscription.current,
    subscription.status,
    source.is_premium,
    source.isPremium,
    source.premium,
  ];
  const premium = premiumCandidates.map(truthyOzonFlag).find((value) => value !== null);
  return {
    companyName: firstCleanText([company.name, source.company_name, source.companyName, source.name], 160),
    legalName: firstCleanText([company.legal_name, company.legalName, source.legal_name, source.legalName], 220),
    inn: firstCleanText([company.inn, company.INN, source.inn, source.INN, company.tax_id, source.tax_id], 80),
    currencyCode: supportedStoreCurrency(company.currency),
    isPremium: premium,
  };
}

function pickArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.stocks)) return value.stocks;
  if (Array.isArray(value.rows)) return value.rows;
  if (Array.isArray(value.products)) return value.products;
  if (Array.isArray(value.result?.items)) return value.result.items;
  if (Array.isArray(value.result?.stocks)) return value.result.stocks;
  if (Array.isArray(value.result?.rows)) return value.result.rows;
  if (Array.isArray(value.result?.products)) return value.result.products;
  if (Array.isArray(value.result)) return value.result;
  return [];
}

function stockCountFromOzon(row = {}) {
  return Number(
    row.present ??
    row.stock ??
    row.available ??
    row.quantity ??
    row.balance ??
    row.available_stock ??
    row.free_to_sell ??
    row.free_to_sell_amount ??
    0
  ) || 0;
}

function normalizeWarehouseStockRows(item = {}, defaultSource = "fbs") {
  const rows = pickArray(item.stocks).length ? pickArray(item.stocks) : pickArray(item);
  const sourceRows = rows.length
    ? rows
    : (item.warehouse_id || item.warehouseId || item.warehouse_name || item.warehouseName ? [item] : []);
  return sourceRows.map((row) => ({
    ...row,
    warehouse_id: row.warehouse_id ?? row.warehouseId ?? row.warehouse?.id ?? item.warehouse_id ?? item.warehouseId,
    warehouse_name: row.warehouse_name ?? row.warehouseName ?? row.warehouse?.name ?? item.warehouse_name ?? item.warehouseName,
    present: stockCountFromOzon(row),
    reserved: Number(row.reserved ?? row.reserved_stock ?? row.reserved_amount ?? 0) || 0,
    sku: row.sku ?? item.sku,
    offer_id: row.offer_id ?? item.offer_id,
    product_id: row.product_id ?? item.product_id,
    source: row.source || defaultSource,
  })).filter((row) => row.warehouse_id || row.warehouse_name);
}

function addWarehouseStockLookup(map, item = {}, defaultSource = "fbs") {
  const rows = normalizeWarehouseStockRows(item, defaultSource);
  const keys = [
    item.product_id,
    item.productId,
    item.id,
    item.offer_id,
    item.offerId,
    item.item_code,
    item.sku,
  ].filter(Boolean).map(String);
  if (!rows.length || !keys.length) return;
  for (const key of keys) {
    const existing = map.get(key) || [];
    map.set(key, [...existing, ...rows]);
  }
}

function warehouseStockRowsForProduct(map, product = {}) {
  const keys = [
    product.product_id,
    product.productId,
    product.id,
    product.offer_id,
    product.offerId,
    product.item_code,
    product.sku,
  ].filter(Boolean).map(String);
  return keys
    .map((key) => map.get(key))
    .find((rows) => Array.isArray(rows)) || [];
}

function dedupeWarehouseStockRows(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = [
      String(row.source || ""),
      String(row.warehouse_id ?? row.warehouseId ?? ""),
      String(row.warehouse_name ?? row.warehouseName ?? ""),
      String(row.sku ?? ""),
      String(row.offer_id ?? row.offerId ?? ""),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function refreshOzonKeyExpiry(store, {callApi=callOzonSellerApi,now=()=>new Date()}={}) {
  try {
    const response=await callApi(store,'/v1/roles',{},15_000);
    const raw=response.expires_at || response.result?.expires_at;
    if(!raw || !Number.isFinite(Date.parse(raw)))return false;
    store.apiKeyExpiresAt=new Date(raw).toISOString();
    store.apiKeyExpirySource='OZON_ROLES';
    store.apiKeyExpiryCheckedAt=now().toISOString();
    return true;
  } catch {return false;}
}

export function createOzonSyncService({
  loadState,
  saveState,
  now = () => new Date(),
  createJobId = () => crypto.randomUUID(),
  logger = console,
}) {
  const nowIso = () => now().toISOString();
  const activeSyncClaims = new Map();

  function syncClaimConflict(report) {
    const error = new Error("同步幂等键已用于不同请求");
    error.status = 409;
    error.code = "SYNC_IDEMPOTENCY_CONFLICT";
    return attachSyncErrorContext(error, {
      accountId: report.accountId,
      storeId: report.storeId,
      type: report.type,
      timestamp: report.timestamp,
      taskId: report.taskId,
      requestId: report.requestId,
      details: {},
    });
  }

  async function runWithSyncClaim(report, operation) {
    const claimKey = JSON.stringify([report.accountId, report.clientJobId]);
    const existing = activeSyncClaims.get(claimKey);
    if (existing) {
      if (
        existing.taskId !== report.taskId
        || existing.requestHash !== report.requestHash
      ) {
        throw syncClaimConflict(report);
      }
      return existing.promise;
    }

    const promise = Promise.resolve().then(operation);
    activeSyncClaims.set(claimKey, {
      taskId: report.taskId,
      requestHash: report.requestHash,
      promise,
    });
    try {
      return await promise;
    } finally {
      if (activeSyncClaims.get(claimKey)?.promise === promise) {
        activeSyncClaims.delete(claimKey);
      }
    }
  }

  function appendSyncReport(state, report) {
    state.jobs = state.jobs && typeof state.jobs === "object" ? state.jobs : {};
    state.reports = Array.isArray(state.reports) ? state.reports : [];
    const savedReport = { ...report };
    const existingJob = state.jobs[report.id];
    if (
      existingJob
      && String(existingJob.accountId || "") !== String(report.accountId || "")
    ) {
      const error = new Error("同步任务身份冲突");
      error.status = 409;
      error.code = "SYNC_IDENTITY_CONFLICT";
      throw error;
    }
    state.jobs[report.id] = savedReport;
    state.reports = [
      savedReport,
      ...state.reports.filter((item) => String(item?.id || "") !== String(report.id)),
    ].slice(0, 200);
    if (["SUCCESS", "FAILED"].includes(String(report.status || "").toUpperCase())) {
      const auditEventId = `audit_sync_${report.id}_${String(report.status).toLowerCase()}`;
      const existingAudit = state.auditEvents?.find((event) => event?.eventId === auditEventId);
      if (
        existingAudit
        && String(existingAudit.accountId || "") !== String(report.accountId || "")
      ) {
        const error = new Error("同步审计身份冲突");
        error.status = 409;
        error.code = "SYNC_IDENTITY_CONFLICT";
        throw error;
      }
      appendAuditEvent(state, {
        eventId: auditEventId,
        correlationId: report.id,
        action: `SYNC_${String(report.type || "UNKNOWN").toUpperCase()}`,
        status: report.status,
        accountId: report.accountId,
        storeId: report.storeId,
        deviceId: report.deviceId,
        source: report.source || "server",
        actorType: "account",
        actorId: report.accountId,
        entityType: "sync_job",
        entityId: report.id,
        metadata: {
          fetchedCount: report.fetchedCount,
          requestId: report.requestId,
          taskId: report.taskId,
          error: report.error || "",
        },
        createdAt: report.updatedAt || report.createdAt,
      });
    }
  }

  async function mutateLatestStateWithConflictRetry(mutator, {
    hydrateCatalog = true,
    catalogMutation = null,
  } = {}) {
    let lastConflict = null;
    for (let attempt = 0; attempt < LOCAL_STATE_SAVE_MAX_ATTEMPTS; attempt += 1) {
      const latest = await loadState({ hydrateCatalog });
      const result = mutator(latest);
      try {
        await saveState(latest, { catalogMutation });
        return { latest, result };
      } catch (error) {
        if (error?.code !== "LOCAL_STATE_VERSION_CONFLICT") throw error;
        lastConflict = error;
      }
    }
    throw lastConflict;
  }

  async function persistSyncReport(report) {
    const { latest } = await mutateLatestStateWithConflictRetry((state) => {
      appendSyncReport(state, report);
    }, { hydrateCatalog: false });
    return latest;
  }

  async function findSyncReplay(report) {
    const latest = await loadState({ hydrateCatalog: false });
    const records = [
      ...(Array.isArray(latest.reports) ? latest.reports : []),
      ...Object.values(latest.jobs && typeof latest.jobs === "object" ? latest.jobs : {}),
    ].filter((item) =>
      item?.jobKind === STORE_SYNC_JOB_KIND
      && String(item.accountId || "") === report.accountId
      && String(item.clientJobId || "") === report.clientJobId);
    if (!records.length) return null;
    const existing = records.find((item) =>
      String(item.id || "") === report.id
      && String(item.storeId || "") === report.storeId
      && String(item.type || "") === report.type
      && String(item.requestHash || "") === report.requestHash);
    if (
      existing
      && ["SUCCESS", "FAILED"].includes(String(existing.status || "").toUpperCase())
    ) {
      return structuredClone(existing);
    }
    if (
      existing
      && records.every((item) =>
        String(item.id || "") === report.id
        && String(item.storeId || "") === report.storeId
        && String(item.type || "") === report.type
        && String(item.requestHash || "") === report.requestHash)
    ) {
      return null;
    }
    throw syncClaimConflict(report);
  }

  async function syncStoreProfile(state, store) {
    const response = await callOzonSellerApi(store, "/v1/seller/info", {});
    const profile = extractSellerInfoProfile(response);
    if (profile.companyName) {
      store.companyName = profile.companyName;
      store.shopName = profile.companyName;
    }
    if (profile.legalName) store.legalName = profile.legalName;
    if (profile.inn) {
      store.inn = profile.inn;
      store.taxId = profile.inn;
    }
    if (profile.isPremium !== null && profile.isPremium !== undefined) {
      store.isPremium = profile.isPremium;
    }
    const syncedAt = nowIso();
    if (profile.currencyCode) {
      store.currencyCode = profile.currencyCode;
      store.currency = profile.currencyCode;
      store.companyCurrency = profile.currencyCode;
      store.currencySource = "OZON_SELLER_INFO";
      store.currencySyncedAt = syncedAt;
    }
    store.profileSyncedAt = syncedAt;
    store.updatedAt = store.profileSyncedAt;
    if(!store.apiKeyExpiryCheckedAt || now().getTime()-Date.parse(store.apiKeyExpiryCheckedAt)>=86_400_000) {
      await refreshOzonKeyExpiry(store,{now});
    }
    return profile;
  }

  async function refreshStoreProfiles(state, { accountId, storeId = "" }) {
    const accountStores = storesForAccount(state, accountId);
    const targets = storeId
      ? accountStores.filter((store) => String(store.id) === String(storeId))
      : accountStores;
    if (storeId && !targets.length) {
      const error = new Error("门店不存在");
      error.status = 404;
      error.code = "STORE_NOT_FOUND";
      throw error;
    }
    const errors = [];
    let syncedCount = 0;
    for (const store of targets) {
      try {
        await syncStoreProfile(state, store);
        syncedCount += 1;
      } catch (error) {
        errors.push({
          storeId: store.id,
          message: String(error?.message || error).slice(0, 240),
        });
      }
    }
    await saveState(state);
    return { syncedCount, errors };
  }

  async function fetchWarehouseStockLookup(store) {
    const map = new Map();
    let total = 0;
    const limit = 1000;
    for (let offset = 0; offset < 100000; offset += limit) {
      const data = await callOzonSellerApi(
        store,
        "/v2/analytics/stock_on_warehouses",
        { limit, offset, warehouse_type: "ALL" },
        120000,
      );
      const items = pickArray(data);
      if (!items.length) break;
      for (const item of items) {
        addWarehouseStockLookup(map, item, "fbo");
        total += 1;
      }
      if (items.length < limit) break;
    }
    return { map, total };
  }

  async function fetchFbsWarehouseStockLookup(store, products = []) {
    const map = new Map();
    const offerIds = [...new Set(products.map((item) => item.offer_id || item.offerId).filter(Boolean).map(String))];
    const skuIds = [...new Set(products.map((item) => item.sku).filter(Boolean).map(Number).filter(Boolean))];
    const chunks = (offerIds.length ? offerIds : skuIds).reduce((acc, item, index) => {
      if (index % 500 === 0) acc.push([]);
      acc[acc.length - 1].push(item);
      return acc;
    }, []);
    let total = 0;
    for (const chunk of chunks) {
      let cursor = "";
      for (let page = 0; page < 50; page += 1) {
        const payload = {
          limit: 1000,
          ...(offerIds.length ? { offer_id: chunk } : { sku: chunk }),
          ...(cursor ? { cursor } : {}),
        };
        const data = await callOzonSellerApi(
          store,
          "/v2/product/info/stocks-by-warehouse/fbs",
          payload,
          120000,
        );
        const items = pickArray(data);
        for (const item of items) {
          addWarehouseStockLookup(map, item, "fbs");
          total += 1;
        }
        cursor = data?.cursor || data?.result?.cursor || "";
        if (!data?.has_next && !data?.result?.has_next) break;
        if (!cursor) break;
      }
    }
    return { map, total };
  }

  async function syncProducts(state, store) {
    let imported = 0;
    state.caches = state.caches && typeof state.caches === "object" ? state.caches : {};
    state.caches.products = Array.isArray(state.caches.products) ? state.caches.products : [];
    const cache = state.caches.products;
    const seenProductIds = new Set();
    const warehouseStockLookup = await fetchWarehouseStockLookup(store);
    for (const visibility of ["ALL", "ARCHIVED"]) {
      let lastId = "";
      for (let page = 0; page < 20; page += 1) {
        const listPayload = { limit: 1000, filter: { visibility } };
        if (lastId) listPayload.last_id = lastId;
        const listRes = await callOzonSellerApi(store, "/v3/product/list", listPayload);
        const items = listRes?.result?.items || [];
        const listItemById = new Map(
          items.map((item) => [String(item.product_id || item.id || item.offer_id || ""), item]),
        );
        const ids = items.map((item) => item.product_id).filter(Boolean).map(String);
        if (!ids.length) break;
        ids.forEach((id) => seenProductIds.add(id));
        for (let index = 0; index < ids.length; index += 1000) {
          const chunk = ids.slice(index, index + 1000);
          const infoRes = await callOzonSellerApi(
            store,
            "/v3/product/info/list",
            { product_id: chunk },
            120000,
          );
          const priceRes = await callOzonSellerApi(
            store,
            "/v5/product/info/prices",
            { filter: { product_id: chunk, visibility }, limit: chunk.length },
            120000,
          );
          const details = infoRes?.result?.items || infoRes?.items || [];
          const priceDetails = priceRes?.items || priceRes?.result?.items || [];
          const priceItemById = new Map(
            priceDetails.map((item) => [String(item.product_id || item.id || item.offer_id || ""), item]),
          );
          const fbsWarehouseStockLookup = await fetchFbsWarehouseStockLookup(store, details);
          const syncedAt = nowIso();
          for (const raw of details) {
            const id = raw.id || raw.product_id || raw.offer_id;
            const listItem = listItemById.get(String(id || "")) || {};
            const priceItem = priceItemById.get(String(id || "")) || {};
            const warehouseStocks = dedupeWarehouseStockRows([
              ...warehouseStockRowsForProduct(warehouseStockLookup.map, raw),
              ...warehouseStockRowsForProduct(fbsWarehouseStockLookup.map, raw),
            ]);
            const isArchived = Boolean(raw.is_archived || raw.archived || visibility === "ARCHIVED");
            upsertProductByStore(cache, store, id, {
              ...raw,
              id: String(id),
              price: priceItem.price || raw.price,
              marketing_actions: priceItem.marketing_actions || raw.marketing_actions,
              price_info: priceItem,
              price_indexes: priceItem.price_indexes || raw.price_indexes,
              warehouse_stocks: warehouseStocks,
              visibilityFilter: visibility,
              listVisibility: listItem.visibility || visibility,
              is_archived: isArchived,
              ...cacheItemScope(store, store.ownerAccountId),
              syncedAt,
            });
            imported += 1;
          }
        }
        const nextLastId = listRes?.result?.last_id;
        if (!nextLastId || String(nextLastId) === String(lastId)) break;
        lastId = String(nextLastId);
      }
    }
    state.caches.products = cache.filter((item) => {
      if (!cacheItemMatchesStore(item, store)) return true;
      const id = String(item.id || item.product_id || item.offer_id || "");
      return Boolean(id) && seenProductIds.has(id);
    });
    return imported;
  }

  async function syncWarehouses(state, store) {
    state.caches = state.caches && typeof state.caches === "object" ? state.caches : {};
    const response = await callOzonSellerApi(store, "/v2/warehouse/list", {});
    const candidate =
      response?.result?.warehouses ||
      response?.result?.items ||
      response?.result ||
      response?.warehouses ||
      response?.items ||
      [];
    const warehouses = Array.isArray(candidate) ? candidate : [];
    const syncedAt = nowIso();
    const scopedWarehouses = warehouses.map((raw) => ({
      ...raw,
      id: String(raw.warehouse_id || raw.id || raw.name || crypto.randomUUID()),
      ...cacheItemScope(store, store.ownerAccountId),
      syncedAt,
    }));
    state.caches.warehouses = [
      ...(Array.isArray(state.caches.warehouses) ? state.caches.warehouses : [])
        .filter((item) => !cacheItemMatchesStore(item, store)),
      ...scopedWarehouses,
    ];
    return scopedWarehouses.length;
  }

  async function commitLocalSyncResult(workingState, store, accountId, type, report) {
    const cacheKey = {
      PRODUCTS: "products",
      WAREHOUSES: "warehouses",
    }[type];
    const { latest } = await mutateLatestStateWithConflictRetry((state) => {
      const latestStore = activeStore(state, store.id, accountId);
      if (!latestStore) {
        const error = new Error("同步期间门店已删除或归属已变更");
        error.status = 409;
        error.code = "STORE_OWNERSHIP_CHANGED";
        throw error;
      }
      state.caches = state.caches && typeof state.caches === "object" ? state.caches : {};
      state.caches[cacheKey] = [
        ...(Array.isArray(state.caches[cacheKey]) ? state.caches[cacheKey] : [])
          .filter((item) => !cacheItemMatchesStore(item, latestStore)),
        ...cacheItemsForStore(workingState.caches?.[cacheKey], store),
      ];
      for (const key of [
        "companyName",
        "shopName",
        "legalName",
        "inn",
        "taxId",
        "isPremium",
        "profileSyncedAt",
        "profileSyncError",
        "updatedAt",
      ]) {
        if (Object.hasOwn(store, key)) latestStore[key] = store[key];
      }
      appendSyncReport(state, report);
    }, {
      hydrateCatalog: false,
      catalogMutation: { storeId: store.id, kind: cacheKey },
    });
    return latest;
  }

  async function runLocalSync(state, {
    accountId,
    storeId,
    type,
    jobId = createJobId(),
    requestId = "",
    deviceId = "",
    source = "",
  } = {}) {
    const upper = String(type || "").toUpperCase();
    const requestAccountId = String(accountId || "").trim();
    const requestedStoreId = String(storeId || "").trim();
    const normalizedClientJobId = cleanText(jobId || createJobId(), 240);
    const normalizedRequestId = cleanText(requestId || normalizedClientJobId, 240);
    const normalizedTaskId = storeSyncTaskId({
      accountId: requestAccountId,
      storeId: requestedStoreId,
      type: upper,
      clientJobId: normalizedClientJobId,
    });
    const createdAt = nowIso();
    if (!requestAccountId) {
      const error = new Error("同步请求缺少账号标识");
      error.status = 400;
      error.code = "ACCOUNT_ID_REQUIRED";
      throw attachSyncErrorContext(error, {
        accountId: requestAccountId,
        storeId: requestedStoreId,
        type: upper,
        timestamp: createdAt,
        taskId: normalizedTaskId,
        requestId: normalizedRequestId,
      });
    }
    const workingState = structuredClone(state);
    const store = activeStore(workingState, requestedStoreId, requestAccountId);
    if (!store) {
      const error = new Error("未找到已绑定门店");
      error.status = 400;
      error.code = "STORE_NOT_FOUND";
      throw attachSyncErrorContext(error, {
        accountId: requestAccountId,
        storeId: requestedStoreId,
        type: upper,
        timestamp: createdAt,
        taskId: normalizedTaskId,
        requestId: normalizedRequestId,
      });
    }
    if (!SUPPORTED_SYNC_TYPES.has(upper)) {
      const retired = RETIRED_SYNC_TYPES.has(upper);
      const error = new Error(retired ? "该运营辅助同步已停用" : "Ozon 本地同步尚未迁移到服务");
      error.status = retired ? 410 : 501;
      error.code = retired ? "FEATURE_RETIRED" : "ZONGZI_SYNC_UNSUPPORTED";
      throw attachSyncErrorContext(error, {
        accountId: requestAccountId,
        storeId: requestedStoreId,
        type: upper,
        timestamp: createdAt,
        taskId: normalizedTaskId,
        requestId: normalizedRequestId,
        store,
      });
    }
    const report = {
      id: normalizedTaskId,
      taskId: normalizedTaskId,
      clientJobId: normalizedClientJobId,
      requestId: normalizedRequestId,
      requestHash: storeSyncRequestHash({ requestId: normalizedRequestId }),
      jobKind: STORE_SYNC_JOB_KIND,
      accountId: requestAccountId,
      storeId: store.id,
      deviceId,
      source: source || (deviceId ? "extension" : "server"),
      type: upper,
      status: "RUNNING",
      fetchedCount: 0,
      createdAt,
      updatedAt: createdAt,
      timestamp: createdAt,
      details: {
        fetchedCount: 0,
        coverage: [...(SYNC_COVERAGE_BY_TYPE[upper] || [])],
        profile: { status: "PENDING" },
      },
    };
    return runWithSyncClaim(report, async () => {
      try {
        const replay = await findSyncReplay(report);
        if (replay?.status === "FAILED") throw failedSyncReplayError(replay);
        if (replay) return replay;
        await persistSyncReport(report);
      } catch (error) {
        if (error?.body && typeof error.body === "object") throw error;
        const unavailable = new Error("同步状态暂时不可用");
        unavailable.status = Number(error?.status) >= 500
          ? Number(error.status)
          : 503;
        unavailable.code = "SYNC_STATE_UNAVAILABLE";
        throw attachSyncErrorContext(unavailable, {
          accountId: report.accountId,
          storeId: report.storeId,
          type: report.type,
          timestamp: report.timestamp,
          taskId: report.taskId,
          requestId: report.requestId,
          store,
          details: {},
        });
      }
      try {
        let profileError = "";
        try {
          await syncStoreProfile(workingState, store);
          delete store.profileSyncError;
        } catch (error) {
          profileError = sanitizedSyncText(error?.message || error, store, 240);
          store.profileSyncError = profileError;
        }
        const syncByType = {
          PRODUCTS: () => syncProducts(workingState, store),
          WAREHOUSES: () => syncWarehouses(workingState, store),
        };
        report.fetchedCount = await syncByType[upper]();
        report.status = "SUCCESS";
        report.updatedAt = nowIso();
        report.timestamp = report.updatedAt;
        report.details = {
          fetchedCount: report.fetchedCount,
          coverage: [...SYNC_COVERAGE_BY_TYPE[upper]],
          profile: profileError
            ? { status: "FAILED", error: profileError }
            : { status: "SUCCESS" },
        };
        await commitLocalSyncResult(
          workingState,
          store,
          requestAccountId,
          upper,
          report,
        );
        return report;
      } catch (error) {
        report.status = "FAILED";
        report.error = sanitizedSyncText(error?.message || error, store, 500);
        report.errorCode = String(error?.code || "STORE_SYNC_FAILED").slice(0, 120);
        report.errorStatus = Number(error?.status || 502);
        report.updatedAt = nowIso();
        report.timestamp = report.updatedAt;
        report.details = {
          fetchedCount: report.fetchedCount,
          coverage: [...(SYNC_COVERAGE_BY_TYPE[upper] || [])],
          error: safeSyncErrorDetails(error, store),
        };
        try {
          await persistSyncReport(report);
        } catch {
          logger.warn?.("[local-sync] failed to persist failure report");
        }
        attachSyncErrorContext(error, {
          accountId: report.accountId,
          storeId: report.storeId,
          type: report.type,
          timestamp: report.timestamp,
          taskId: report.taskId,
          requestId: report.requestId,
          store,
          details: safeSyncErrorDetails(error, store),
        });
        throw error;
      }
    });
  }

  return {
    syncStoreProfile,
    refreshStoreProfiles,
    runLocalSync,
    publicSyncErrorResponse,
  };
}
