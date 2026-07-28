/**
 * extension/background/sync/sync-state.js
 *
 * 客户端同步运行时状态:
 *   - 凭据 cache:严格 in-memory(模块顶层 Map),5min TTL,不入 storage
 *   - deviceId:chrome.storage.local 持久化(纯本机标识,不含用户隐私)
 *   - lastRunAt(每类型分别):决定本次 alarm 是否真跑(防多 alarm 撞车)
 *   - 当前 round 的 leaseId(in-memory,SW 重启后用 acquire 重抢)
 */

(() => {
  const CRED_TTL_MS = 5 * 60_000;
  const DEVICE_ID_KEY = "jzClientSync:deviceId";
  const LAST_RUN_KEY = "jzClientSync:lastRunAt"; // { [type]: epochMs }
  const INTERVAL_CACHE_KEY = "jzClientSync:intervals"; // { fetchedAt, postingsMin, productsMin, warehousesMin }
  const POSTINGS_WATERMARK_KEY = "jzClientSync:postingsWatermark"; // { [storeId]: { lastSuccessTo, updatedAt } }
  const INTERVAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  // storeId -> { clientId, apiKey, fetchedAt }
  const credCache = new Map();
  // `${storeId}:${type}` -> { leaseId, expiresAt }
  const leaseCache = new Map();

  let deviceIdPromise = null;
  async function getOrCreateDeviceId() {
    if (deviceIdPromise) return deviceIdPromise;
    deviceIdPromise = (async () => {
      const got = await chrome.storage.local.get(DEVICE_ID_KEY);
      if (got[DEVICE_ID_KEY]) return got[DEVICE_ID_KEY];
      const id = crypto.randomUUID();
      await chrome.storage.local.set({ [DEVICE_ID_KEY]: id });
      return id;
    })();
    return deviceIdPromise;
  }

  function getCachedCred(storeId) {
    const c = credCache.get(storeId);
    if (!c) return null;
    if (Date.now() - c.fetchedAt > CRED_TTL_MS) {
      credCache.delete(storeId);
      return null;
    }
    return { clientId: c.clientId, apiKey: c.apiKey };
  }

  function setCachedCred(storeId, { clientId, apiKey }) {
    credCache.set(storeId, { clientId, apiKey, fetchedAt: Date.now() });
  }

  function invalidateCred(storeId) {
    credCache.delete(storeId);
  }

  function getCachedLease(storeId, type) {
    const k = `${storeId}:${type}`;
    const v = leaseCache.get(k);
    if (!v) return null;
    if (v.expiresAt.getTime() <= Date.now()) {
      leaseCache.delete(k);
      return null;
    }
    return v;
  }

  function setCachedLease(storeId, type, leaseId, expiresAt) {
    leaseCache.set(`${storeId}:${type}`, {
      leaseId,
      expiresAt: new Date(expiresAt),
    });
  }

  function clearCachedLease(storeId, type) {
    leaseCache.delete(`${storeId}:${type}`);
  }

  async function getLastRunAt(type) {
    const got = await chrome.storage.local.get(LAST_RUN_KEY);
    return got[LAST_RUN_KEY]?.[type] ?? 0;
  }

  async function setLastRunAt(type, ts) {
    const got = await chrome.storage.local.get(LAST_RUN_KEY);
    const next = { ...(got[LAST_RUN_KEY] || {}), [type]: ts };
    await chrome.storage.local.set({ [LAST_RUN_KEY]: next });
  }

  async function getIntervals() {
    const got = await chrome.storage.local.get(INTERVAL_CACHE_KEY);
    const cached = got[INTERVAL_CACHE_KEY];
    if (
      cached &&
      Date.now() - cached.fetchedAt < INTERVAL_CACHE_TTL_MS &&
      cached.postingsMin > 0
    ) {
      return cached;
    }
    return null;
  }

  async function setIntervals(intervals) {
    await chrome.storage.local.set({
      [INTERVAL_CACHE_KEY]: { ...intervals, fetchedAt: Date.now() },
    });
  }

  async function getPostingsWatermark(storeId) {
    if (!storeId) return null;
    const got = await chrome.storage.local.get(POSTINGS_WATERMARK_KEY);
    const watermark = got[POSTINGS_WATERMARK_KEY]?.[storeId];
    if (!watermark?.lastSuccessTo) return null;
    const lastSuccessTo = new Date(String(watermark.lastSuccessTo));
    if (Number.isNaN(lastSuccessTo.getTime())) return null;
    return {
      lastSuccessTo: lastSuccessTo.toISOString(),
      updatedAt: watermark.updatedAt || null,
    };
  }

  async function setPostingsWatermark(storeId, watermark) {
    if (!storeId || !watermark?.lastSuccessTo) return;
    const lastSuccessTo = new Date(String(watermark.lastSuccessTo));
    if (Number.isNaN(lastSuccessTo.getTime())) return;

    const got = await chrome.storage.local.get(POSTINGS_WATERMARK_KEY);
    const allWatermarks = got[POSTINGS_WATERMARK_KEY] || {};
    const updatedAt =
      watermark.updatedAt && !Number.isNaN(new Date(String(watermark.updatedAt)).getTime())
        ? new Date(String(watermark.updatedAt)).toISOString()
        : new Date().toISOString();

    await chrome.storage.local.set({
      [POSTINGS_WATERMARK_KEY]: {
        ...allWatermarks,
        [storeId]: {
          lastSuccessTo: lastSuccessTo.toISOString(),
          updatedAt,
        },
      },
    });
  }

  globalThis.JzSyncState = {
    getOrCreateDeviceId,
    getCachedCred,
    setCachedCred,
    invalidateCred,
    getCachedLease,
    setCachedLease,
    clearCachedLease,
    getLastRunAt,
    setLastRunAt,
    getIntervals,
    setIntervals,
    getPostingsWatermark,
    setPostingsWatermark,
  };
})();
