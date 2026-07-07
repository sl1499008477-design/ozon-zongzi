/**
 * extension/background/sync/backend-client.js
 *
 * 跟 backend(api.jizhangerp.com / localhost:3001)交互的 wrapper。
 * 复用 service-worker.js 已经实现的 BACKEND_URLS + getAuthToken 路径,
 * 但因为 SW IIFE 不导出符号,这里通过 JzClientSync.init() 注入的回调
 * (getBackendUrl / getAuthToken)拿到。
 *
 * 端点对齐 backend Phase 1 改造:
 *   GET  /ozon/sync/client-intervals
 *   GET  /ozon/stores/:storeId/sync-credentials
 *   POST /ozon/sync/lease/{acquire,heartbeat,release}
 *   POST /ozon/sync/client-report
 *   POST /ozon/cache/import-with-hash
 */

(() => {
  let ctx = null; // { getBackendUrl, getAuthToken, getStoreList }

  function setContext(c) {
    ctx = c;
  }

  async function authedFetch(path, init = {}) {
    if (!ctx) throw new Error("JzBackendClient not initialized");
    const baseUrl = await ctx.getBackendUrl();
    const token = await ctx.getAuthToken();
    if (!token) throw new Error("No backend auth token");
    // CDN 历史污染兜底:见 extension/lib/cdn-buster.js。
    const method = (init.method || "GET").toUpperCase();
    const bustedPath =
      method === "GET" && globalThis.JzCdnBuster
        ? globalThis.JzCdnBuster.withCdnBuster(path)
        : path;
    const res = await fetch(`${baseUrl}${bustedPath}`, {
      ...init,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const err = new Error(
        `Backend ${res.status} ${path}: ${text.slice(0, 300)}`,
      );
      err.status = res.status;
      err.bodyText = text;
      err.bodyParsed = parsed;
      throw err;
    }
    return parsed;
  }

  // GET /ozon/sync/client-intervals
  async function getClientIntervals() {
    return authedFetch("/ozon/sync/client-intervals", { method: "GET" });
  }

  // GET /ozon/stores/:storeId/sync-credentials
  // 传 x-device-fingerprint 给 backend 写 audit log,让运维能追溯
  // "哪台机器 / IP / 何时拉了 OPI 凭据"(没传的话 audit deviceFingerprint=null)
  async function getSyncCredentials(storeId, deviceId) {
    return authedFetch(
      `/ozon/stores/${encodeURIComponent(storeId)}/sync-credentials`,
      {
        method: "GET",
        headers: deviceId ? { "x-device-fingerprint": deviceId } : {},
      },
    );
  }

  // POST /ozon/sync/lease/acquire
  async function acquireLease({ storeId, type, deviceId, ttlSeconds }) {
    return authedFetch("/ozon/sync/lease/acquire", {
      method: "POST",
      body: JSON.stringify({ storeId, type, deviceId, ttlSeconds }),
    });
  }

  async function heartbeatLease({ leaseId, deviceId, ttlSeconds }) {
    return authedFetch("/ozon/sync/lease/heartbeat", {
      method: "POST",
      body: JSON.stringify({ leaseId, deviceId, ttlSeconds }),
    });
  }

  async function releaseLease({ leaseId, deviceId }) {
    return authedFetch("/ozon/sync/lease/release", {
      method: "POST",
      body: JSON.stringify({ leaseId, deviceId }),
    });
  }

  // POST /ozon/sync/client-report
  async function clientReport(report) {
    return authedFetch("/ozon/sync/client-report", {
      method: "POST",
      body: JSON.stringify(report),
    });
  }

  // POST /ozon/cache/import-with-hash (PRODUCTS only — diff 端点)
  async function importWithHash({ storeId, leaseId, deviceId, items }) {
    return authedFetch("/ozon/cache/import-with-hash", {
      method: "POST",
      body: JSON.stringify({
        storeId,
        type: "PRODUCTS",
        leaseId,
        deviceId,
        items,
      }),
    });
  }

  // 复用现有的 cache import 端点 — 后端 OzonCacheService 已实现
  async function importPostings({ storeId, items }) {
    return authedFetch("/ozon/postings/cache/import", {
      method: "POST",
      headers: { "x-ozon-store-id": storeId },
      body: JSON.stringify({ items }),
    });
  }

  async function importWarehouses({ storeId, items }) {
    return authedFetch("/ozon/warehouses/cache/import", {
      method: "POST",
      headers: { "x-ozon-store-id": storeId },
      body: JSON.stringify({ items }),
    });
  }

  // 获取用户可见的 store 列表 — 复用 /auth/ozon-stores
  // (auth.controller.ts:450 listMyStores → authService.listVisibleOzonStores)
  async function getVisibleStores() {
    return authedFetch("/auth/ozon-stores", { method: "GET" });
  }

  async function collectSource({ sourceId, raw, storeId }) {
    return authedFetch(`/sources/${encodeURIComponent(sourceId)}/collect`, {
      method: "POST",
      headers: storeId ? { "x-ozon-store-id": storeId } : {},
      body: JSON.stringify({ raw: raw || {} }),
    });
  }

  async function createAiListingDraft({ candidateId, draft, storeId }) {
    return authedFetch(
      `/ozon/collect-box/${encodeURIComponent(candidateId)}/ai-listing-draft`,
      {
        method: "POST",
        headers: storeId ? { "x-ozon-store-id": storeId } : {},
        body: JSON.stringify(draft || {}),
      },
    );
  }

  async function publishAiListingDraft({ draftId, publish, storeId }) {
    return authedFetch(
      `/ozon/collect-box/${encodeURIComponent(draftId)}/ai-listing-draft/publish`,
      {
        method: "POST",
        headers: storeId ? { "x-ozon-store-id": storeId } : {},
        body: JSON.stringify(publish || {}),
      },
    );
  }

  async function registerBrowserAgent(payload) {
    return authedFetch("/browser-agents/register", {
      method: "POST",
      body: JSON.stringify(payload || {}),
    });
  }

  async function heartbeatBrowserAgent(payload) {
    return authedFetch("/browser-agents/heartbeat", {
      method: "POST",
      body: JSON.stringify(payload || {}),
    });
  }

  async function claimNextBrowserAgentJob(deviceId) {
    return authedFetch(
      `/browser-agents/jobs/next?deviceId=${encodeURIComponent(deviceId)}`,
      { method: "GET" },
    );
  }

  async function reportBrowserAgentJobProgress(jobId, payload) {
    return authedFetch(
      `/browser-agents/jobs/${encodeURIComponent(jobId)}/progress`,
      {
        method: "POST",
        body: JSON.stringify(payload || {}),
      },
    );
  }

  async function completeBrowserAgentJob(jobId, payload) {
    return authedFetch(
      `/browser-agents/jobs/${encodeURIComponent(jobId)}/result`,
      {
        method: "POST",
        body: JSON.stringify(payload || {}),
      },
    );
  }

  async function failBrowserAgentJob(jobId, payload) {
    return authedFetch(
      `/browser-agents/jobs/${encodeURIComponent(jobId)}/fail`,
      {
        method: "POST",
        body: JSON.stringify(payload || {}),
      },
    );
  }

  globalThis.JzBackendClient = {
    setContext,
    getClientIntervals,
    getSyncCredentials,
    acquireLease,
    heartbeatLease,
    releaseLease,
    clientReport,
    importWithHash,
    importPostings,
    importWarehouses,
    getVisibleStores,
    collectSource,
    createAiListingDraft,
    publishAiListingDraft,
    registerBrowserAgent,
    heartbeatBrowserAgent,
    claimNextBrowserAgentJob,
    reportBrowserAgentJobProgress,
    completeBrowserAgentJob,
    failBrowserAgentJob,
  };
})();
