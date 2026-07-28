import crypto from "node:crypto";
import { activeStore, storesForAccount } from "./account-context.mjs";
import { appendAuditEvent } from "./audit-event.mjs";
import { callOzonSellerApi } from "./ozon-client.mjs";
import {
  cacheItemMatchesStore,
  cacheItemsForStore,
  cacheItemScope,
  upsertProductByStore,
} from "./store-cache-scope.mjs";

const cleanText = (value, maxLength = 160) =>
  String(value ?? "").trim().slice(0, maxLength);

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

export function createOzonSyncService({
  loadState,
  saveState,
  now = () => new Date(),
  createJobId = () => crypto.randomUUID(),
  logger = console,
}) {
  const nowIso = () => now().toISOString();

  function upsertSyncReport(state, report) {
    state.jobs = state.jobs && typeof state.jobs === "object" ? state.jobs : {};
    state.reports = Array.isArray(state.reports) ? state.reports : [];
    const savedReport = { ...report };
    state.jobs[report.id] = savedReport;
    state.reports = [
      savedReport,
      ...state.reports.filter((item) => String(item?.id || "") !== String(report.id)),
    ].slice(0, 200);
    if (["SUCCESS", "FAILED"].includes(String(report.status || "").toUpperCase())) {
      appendAuditEvent(state, {
        eventId: `audit_sync_${report.id}_${String(report.status).toLowerCase()}`,
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
          error: report.error || "",
        },
        createdAt: report.updatedAt || report.createdAt,
      });
    }
  }

  async function persistSyncReport(report) {
    const latest = await loadState();
    upsertSyncReport(latest, report);
    await saveState(latest);
    return latest;
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
    store.profileSyncedAt = nowIso();
    store.updatedAt = store.profileSyncedAt;
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

  async function commitProductSync(workingState, store, report) {
    const latest = await loadState();
    latest.caches = latest.caches && typeof latest.caches === "object" ? latest.caches : {};
    latest.caches.products = [
      ...(Array.isArray(latest.caches.products) ? latest.caches.products : [])
        .filter((item) => !cacheItemMatchesStore(item, store)),
      ...cacheItemsForStore(workingState.caches?.products, store),
    ];
    const latestStore = (Array.isArray(latest.stores) ? latest.stores : [])
      .find((item) => String(item?.id || "") === String(store.id));
    if (latestStore) {
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
    }
    upsertSyncReport(latest, report);
    await saveState(latest);
    return latest;
  }

  async function runLocalSync(state, {
    accountId,
    storeId,
    type,
    jobId = createJobId(),
    deviceId = "",
    source = "",
  } = {}) {
    const upper = String(type || "").toUpperCase();
    if (upper !== "PRODUCTS") {
      const error = new Error("Ozon 本地同步尚未迁移到服务");
      error.status = 501;
      error.code = "OZON_SYNC_UNSUPPORTED";
      throw error;
    }
    const workingState = structuredClone(state);
    const store = activeStore(workingState, storeId, accountId);
    if (!store) {
      const error = new Error("未找到已绑定门店");
      error.status = 400;
      error.code = "STORE_NOT_FOUND";
      throw error;
    }
    const createdAt = nowIso();
    const report = {
      id: jobId,
      clientJobId: jobId,
      accountId: accountId || "",
      storeId: store.id,
      deviceId,
      source: source || (deviceId ? "extension" : "server"),
      type: upper,
      status: "RUNNING",
      fetchedCount: 0,
      createdAt,
      updatedAt: createdAt,
    };
    await persistSyncReport(report);
    try {
      try {
        await syncStoreProfile(workingState, store);
        delete store.profileSyncError;
      } catch (error) {
        store.profileSyncError = String(error?.message || error).slice(0, 240);
      }
      report.fetchedCount = await syncProducts(workingState, store);
      report.status = "SUCCESS";
      report.updatedAt = nowIso();
      await commitProductSync(workingState, store, report);
      return report;
    } catch (error) {
      report.status = "FAILED";
      report.error = String(error?.message || error).slice(0, 500);
      report.updatedAt = nowIso();
      try {
        await persistSyncReport(report);
      } catch (persistError) {
        logger.warn?.(
          `[local-sync] failed to persist ${upper} failure: ${persistError?.message || persistError}`,
        );
      }
      throw error;
    }
  }

  return {
    syncStoreProfile,
    refreshStoreProfiles,
    runLocalSync,
  };
}
