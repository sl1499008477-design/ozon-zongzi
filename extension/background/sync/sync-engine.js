/**
 * extension/background/sync/sync-engine.js
 *
 * Phase 2 主循环:在扩展端按类型独立 chrome.alarms 周期跑三类同步。
 * 完全复刻 backend/src/ozon/sync.worker.ts:160-545 的 PRODUCTS / POSTINGS / WAREHOUSES
 * 分页 + chunk + cursor 推进语义,关键差异:
 *   - PRODUCTS 走 import-with-hash diff 端点(client 算 hash,backend 持真值)
 *   - 每页结束 lease heartbeat + client-report 进度上报
 *   - 跑完(或异常)主动 release lease,失败靠 backend TTL 兜底
 *
 * 通过 importScripts 加载,挂 globalThis.JzSyncEngine。依赖:
 *   - JzOpiClient (./opi-client.js)
 *   - JzBackendClient (./backend-client.js)
 *   - JzDiffIndex (./diff-index.js)
 *   - JzSyncState (./sync-state.js)
 */

(() => {
  const PRODUCT_LIST_PAGE_LIMIT = 1000;
  // 2026-06-11:500→1000 对齐 list 页大小,单页只跑一次 info+import-with-hash(原来要 2 次)。
  // Ozon /v3/product/info/list 上限 1000,砍掉约一半 import-with-hash 请求。
  const PRODUCT_INFO_CHUNK = 1000;
  const POSTINGS_PAGE_LIMIT = 100;
  const POSTINGS_MAX_PAGES = 50;
  const POSTINGS_SINCE_DAYS = 7;
  const POSTINGS_MANUAL_SINCE_DAYS = 30;
  const POSTINGS_LIST_PATH = "/v4/posting/fbs/list";
  const DAY_MS = 24 * 60 * 60 * 1000;

  const clampPostingsSinceDays = (value, fallback) => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    const days = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    return Math.max(1, Math.min(days, 365));
  };

  const parsePostingsDate = (value) => {
    if (!value) return null;
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
  };

  // ─── 公共工具 ─────────────────────────────────────────────────

  /**
   * 拉一次 OPI 凭据并 cache 5min(JzSyncState 里 in-memory)。
   * 凭据全程不落 chrome.storage,SW 重启自动重新 GET。
   * deviceId 透传给 backend 写 audit log(codex review #7)。
   */
  async function fetchCredentialsCached(storeId, deviceId) {
    const cached = JzSyncState.getCachedCred(storeId);
    if (cached) return cached;
    const fresh = await JzBackendClient.getSyncCredentials(storeId, deviceId);
    if (!fresh?.clientId || !fresh?.apiKey) {
      throw new Error("Backend returned empty credentials");
    }
    JzSyncState.setCachedCred(storeId, fresh);
    return { clientId: fresh.clientId, apiKey: fresh.apiKey };
  }

  // 各类型独立 TTL,跟 backend SYNC_LEASE_DEFAULT_TTL_SECONDS 对齐。
  // heartbeat 时按 type 传,避免 PRODUCTS 长 sync 被默认 5min TTL 中途丢锁(codex #2)。
  const LEASE_TTL_SECONDS = {
    PRODUCTS: 45 * 60,
    POSTINGS: 5 * 60,
    WAREHOUSES: 10 * 60,
  };

  // Lease 操作走独立 JzLeaseClient(同 importScripts 加载;含自动续期 timer)。
  // 这里保留一层 thin wrapper 把 JzSyncState 本地 lease cache 同步起来,
  // 让 admin/popup 调试可以读到当前持锁状态。
  async function acquireLease(storeId, type, deviceId) {
    const res = await JzLeaseClient.acquire(
      storeId,
      type,
      deviceId,
      LEASE_TTL_SECONDS[type],
    );
    if (!res) return null;
    JzSyncState.setCachedLease(storeId, type, res.leaseId, res.expiresAt);
    return res;
  }

  async function releaseLeaseSafe(leaseId, deviceId, storeId, type) {
    JzSyncState.clearCachedLease(storeId, type);
    await JzLeaseClient.release(storeId, type, deviceId, leaseId);
  }

  // 逐页 heartbeat / 进度上报曾是高峰期最大 api 流量源(client-report ~21/s、
  // lease/heartbeat ~10/s)。2026-06-11 改成时间节流:
  //   - heartbeat 距上次 < TTL/3 跳过(lease-client.js 自身另有 TTL/3 自动续期 +
  //     backend import-with-hash 也会服务端续锁,双重兜底)
  //   - 进度上报(RUNNING):cron 轮没人看 → 完全跳过;手动轮最多每 5s 一次
  // PENDING/SUCCESS/FAILED 仍照常直发,不受节流影响。
  const _lastBeatAt = new Map(); // `${storeId}:${type}` -> ts
  const _lastReportAt = new Map();
  const PROGRESS_REPORT_MIN_GAP_MS = 5_000;

  async function heartbeatLeaseSafe(leaseId, deviceId, type, storeId) {
    const key = `${storeId}:${type}`;
    const now = Date.now();
    const minGap = Math.floor((LEASE_TTL_SECONDS[type] * 1000) / 3);
    if (now - (_lastBeatAt.get(key) || 0) < minGap) return;
    _lastBeatAt.set(key, now);
    await JzLeaseClient.heartbeat(leaseId, deviceId, LEASE_TTL_SECONDS[type]);
  }

  /**
   * 上报 client-report — 任何上报失败只 log,不阻断 sync 主流程。
   * 第一次调用(status='PENDING')必须成功才能产 SyncJob 行。
   */
  async function reportSafe(report) {
    try {
      await JzBackendClient.clientReport(report);
    } catch (e) {
      console.warn(`[JzSyncEngine] client-report failed:`, e?.message || e);
    }
  }

  // 逐页 RUNNING 进度上报:cron(silentProgress)跳过,手动轮节流到 5s 一次。
  async function reportProgress(report, silentProgress) {
    if (silentProgress) return;
    const key = `${report.storeId}:${report.type}`;
    const now = Date.now();
    if (now - (_lastReportAt.get(key) || 0) < PROGRESS_REPORT_MIN_GAP_MS) return;
    _lastReportAt.set(key, now);
    await reportSafe(report);
  }

  function chunked(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // ─── PRODUCTS ───────────────────────────────────────────────
  async function syncProducts(store, deviceId, leaseId, jobId, silentProgress) {
    const storeId = store.id;
    const creds = await fetchCredentialsCached(storeId, deviceId);

    let totalFetched = 0;

    // 跑两轮 visibility=ALL + visibility=ARCHIVED,各自独立 cursor。
    for (const visibility of ["ALL", "ARCHIVED"]) {
      let lastId = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const payload = { limit: PRODUCT_LIST_PAGE_LIMIT, filter: { visibility } };
        if (lastId) payload.last_id = lastId;

        const listRes = await JzOpiClient.call(
          "/v3/product/list",
          payload,
          creds,
        );
        const items = listRes?.result?.items ?? [];
        const newLastId = listRes?.result?.last_id;
        if (!items.length) break;

        const productIds = items
          .map((it) => it.product_id)
          .filter(Boolean)
          .map(String);

        for (const chunk of chunked(productIds, PRODUCT_INFO_CHUNK)) {
          const infoRes = await JzOpiClient.call(
            "/v3/product/info/list",
            { product_id: chunk },
            creds,
          );
          const details =
            infoRes?.result?.items ?? infoRes?.items ?? [];

          if (!details.length) continue;

          // 算每行 contentHash
          const hashed = await Promise.all(
            details.map(async (d) => {
              const productId = String(d?.id ?? d?.product_id ?? "");
              return {
                productId,
                contentHash: await JzDiffIndex.computeHash(d),
                raw: d,
              };
            }),
          );

          // 跟本地索引比对,决定每行带不带 raw
          const localHashes = await JzDiffIndex.getHashes(
            storeId,
            "PRODUCTS",
            hashed.map((h) => h.productId),
          );

          const payloadItems = hashed.map((h) => {
            const local = localHashes.get(h.productId);
            if (local && local === h.contentHash) {
              return { id: h.productId, contentHash: h.contentHash };
            }
            return {
              id: h.productId,
              contentHash: h.contentHash,
              raw: h.raw,
            };
          });

          // 1st-pass POST
          let res = await JzBackendClient.importWithHash({
            storeId,
            leaseId,
            deviceId,
            items: payloadItems,
          });

          // 处理 needRaw:client 本地 hash 误判 → backend 索要 raw 二次提交
          if (res?.needRaw?.length) {
            const needSet = new Set(res.needRaw);
            const retry = hashed
              .filter((h) => needSet.has(h.productId))
              .map((h) => ({
                id: h.productId,
                contentHash: h.contentHash,
                raw: h.raw,
              }));
            if (retry.length) {
              res = await JzBackendClient.importWithHash({
                storeId,
                leaseId,
                deviceId,
                items: retry,
              });
            }
          }

          // 写本地 hash 索引(成功上传后才写,避免回滚不一致)
          await JzDiffIndex.setHashes(
            storeId,
            "PRODUCTS",
            hashed.map((h) => ({
              productId: h.productId,
              hash: h.contentHash,
            })),
          );

          totalFetched += details.length;
        }

        // 每页结束 heartbeat(节流)+ 进度上报(cron 跳过 / 手动节流)
        await heartbeatLeaseSafe(leaseId, deviceId, "PRODUCTS", storeId);
        await reportProgress(
          {
            storeId,
            type: "PRODUCTS",
            clientJobId: jobId,
            deviceId,
            status: "RUNNING",
            fetchedCount: totalFetched,
            lastId,
          },
          silentProgress,
        );

        // cursor 推进
        if (newLastId == null) break;
        const nextCursor = String(newLastId);
        if (nextCursor === lastId) break;
        lastId = nextCursor;
      }
    }

    return totalFetched;
  }

  // ─── POSTINGS ───────────────────────────────────────────────
  async function syncPostings(
    store,
    deviceId,
    leaseId,
    jobId,
    silentProgress,
    sinceDays = POSTINGS_SINCE_DAYS,
    postingsOptions = {},
  ) {
    const storeId = store.id;
    const creds = await fetchCredentialsCached(storeId, deviceId);

    const to = parsePostingsDate(postingsOptions.postingsTo) || new Date();
    const explicitSince = parsePostingsDate(postingsOptions.postingsSince);
    const hasRequestedDays = typeof postingsOptions.postingsSinceDays !== "undefined";
    const hasExplicitWindow = Boolean(
      postingsOptions.postingsSince || postingsOptions.postingsTo || hasRequestedDays,
    );
    const requestedDays =
      hasRequestedDays
        ? clampPostingsSinceDays(postingsOptions.postingsSinceDays, sinceDays)
        : POSTINGS_MANUAL_SINCE_DAYS;
    let since = null;
    let shouldAdvanceWatermark = !hasExplicitWindow;

    if (explicitSince && explicitSince < to) {
      since = explicitSince;
      shouldAdvanceWatermark = false;
    } else if (!hasExplicitWindow && typeof JzSyncState.getPostingsWatermark === "function") {
      const watermark = await JzSyncState.getPostingsWatermark(storeId);
      const watermarkTo = parsePostingsDate(watermark?.lastSuccessTo);
      if (watermarkTo && watermarkTo < to) {
        since = new Date(watermarkTo.getTime() - DAY_MS);
      }
    }

    if (!since) {
      since = new Date(to.getTime() - requestedDays * DAY_MS);
    }

    const filter = { since: since.toISOString(), to: to.toISOString() };
    let cursor = "";
    let totalFetched = 0;
    let reachedEnd = false;

    for (let page = 0; page < POSTINGS_MAX_PAGES; page++) {
      const payload = {
        cursor,
        filter,
        limit: POSTINGS_PAGE_LIMIT,
        // 必须显式 with — 否则订单卡片利润全是 --
        with: {
          analytics_data: true,
          barcodes: true,
          financial_data: true,
          translit: true,
        },
      };
      const listRes = await JzOpiClient.call(POSTINGS_LIST_PATH, payload, creds);

      const result = listRes?.result ?? listRes;
      const postings = result?.postings ?? result?.items ?? [];
      const newCursor = result?.cursor ?? listRes?.cursor;
      const hasNext = result?.has_next ?? listRes?.has_next;

      if (!Array.isArray(postings) || postings.length === 0) {
        reachedEnd = true;
        break;
      }

      const imp = await JzBackendClient.importPostings({
        storeId,
        items: postings,
      });
      totalFetched += imp?.imported || 0;

      await heartbeatLeaseSafe(leaseId, deviceId, "POSTINGS", storeId);
      await reportProgress(
        {
          storeId,
          type: "POSTINGS",
          clientJobId: jobId,
          deviceId,
          status: "RUNNING",
          fetchedCount: totalFetched,
          lastId: cursor,
        },
        silentProgress,
      );

      if (hasNext === false) {
        reachedEnd = true;
        break;
      }
      if (!newCursor || String(newCursor) === cursor) {
        reachedEnd = true;
        break;
      }
      cursor = String(newCursor);
    }

    if (!reachedEnd) {
      throw new Error(`POSTINGS sync reached maxPages=${POSTINGS_MAX_PAGES} before exhausting Ozon cursor`);
    }

    if (shouldAdvanceWatermark && typeof JzSyncState.setPostingsWatermark === "function") {
      await JzSyncState.setPostingsWatermark(storeId, {
        lastSuccessTo: filter.to,
        updatedAt: new Date().toISOString(),
      });
    }

    return totalFetched;
  }

  // ─── WAREHOUSES ─────────────────────────────────────────────
  async function syncWarehouses(store, deviceId, leaseId, jobId, silentProgress) {
    const storeId = store.id;
    const creds = await fetchCredentialsCached(storeId, deviceId);

    const listRes = await JzOpiClient.call("/v2/warehouse/list", {}, creds);
    // 复刻 backend extractWarehouseList 的 6-shape fallback
    const candidate =
      listRes?.result?.warehouses ??
      listRes?.result?.items ??
      listRes?.result ??
      listRes?.warehouses ??
      listRes?.items ??
      listRes;
    const warehouses = Array.isArray(candidate) ? candidate : [];

    const imp = await JzBackendClient.importWarehouses({
      storeId,
      items: warehouses,
    });

    await heartbeatLeaseSafe(leaseId, deviceId, "WAREHOUSES", storeId);
    await reportProgress(
      {
        storeId,
        type: "WAREHOUSES",
        clientJobId: jobId,
        deviceId,
        status: "RUNNING",
        fetchedCount: imp?.imported || 0,
      },
      silentProgress,
    );

    return imp?.imported || 0;
  }

  // ─── 单类型 round 入口 ──────────────────────────────────────
  // preJobId: 手动触发(SW jzManualSync handler)预生成 jobId,以便桥能立刻
  // 把 jobId 回给前端 poll。不传(cron 路径)就内部 random。
  async function runOneType(store, type, deviceId, preJobId, postingsOptions = {}) {
    const jobId = preJobId || crypto.randomUUID();
    // cron 轮(无 preJobId)没人看进度 → 静默,只发 PENDING/SUCCESS/FAILED。
    // 手动轮(SW 预生成 jobId 给前端 poll)照常发进度(reportProgress 内部再 5s 节流)。
    const silentProgress = !preJobId;
    const lease = await acquireLease(store.id, type, deviceId);
    if (!lease) {
      // 别的设备/账号正在跑;静默跳过(手动触发时 SW handler 会显式 FAILED 上报)
      return { skipped: "lease-busy", jobId };
    }
    // 新 lease 重置节流计时,保证本轮首页 heartbeat/进度立即发一次
    _lastBeatAt.delete(`${store.id}:${type}`);
    _lastReportAt.delete(`${store.id}:${type}`);
    await reportSafe({
      storeId: store.id,
      type,
      clientJobId: jobId,
      deviceId,
      status: "PENDING",
    });

    try {
      let fetched = 0;
      if (type === "PRODUCTS") {
        fetched = await syncProducts(store, deviceId, lease.leaseId, jobId, silentProgress);
      } else if (type === "POSTINGS") {
        const postingsSinceDays = preJobId
          ? POSTINGS_MANUAL_SINCE_DAYS
          : POSTINGS_SINCE_DAYS;
        fetched = await syncPostings(
          store,
          deviceId,
          lease.leaseId,
          jobId,
          silentProgress,
          postingsSinceDays,
          postingsOptions,
        );
      } else if (type === "WAREHOUSES") {
        fetched = await syncWarehouses(store, deviceId, lease.leaseId, jobId, silentProgress);
      }

      await reportSafe({
        storeId: store.id,
        type,
        clientJobId: jobId,
        deviceId,
        status: "SUCCESS",
        fetchedCount: fetched,
      });
      return { ok: true, fetched, jobId };
    } catch (e) {
      const msg = String(e?.message || e);
      console.warn(
        `[JzSyncEngine] ${type} sync failed store=${store.id}:`,
        msg,
      );
      // 凭据无效 → 清缓存让下轮重 GET
      if (e?.status === 401 || e?.status === 403) {
        JzSyncState.invalidateCred(store.id);
      }
      await reportSafe({
        storeId: store.id,
        type,
        clientJobId: jobId,
        deviceId,
        status: "FAILED",
        error: msg.slice(0, 500),
      });
      return { ok: false, error: msg, jobId };
    } finally {
      await releaseLeaseSafe(lease.leaseId, deviceId, store.id, type);
    }
  }

  // ─── 全店循环 ───────────────────────────────────────────────
  async function runRound(type) {
    const deviceId = await JzSyncState.getOrCreateDeviceId();
    let stores;
    try {
      stores = await JzBackendClient.getVisibleStores();
    } catch (e) {
      console.warn(`[JzSyncEngine] runRound(${type}) getVisibleStores failed:`, e?.message || e);
      return;
    }
    if (!Array.isArray(stores)) return;

    for (let i = 0; i < stores.length; i++) {
      const store = stores[i];
      if (!store?.id) continue;
      // 同 store 之间 stagger 10s 避免抓 Ozon 限流
      if (i > 0) await new Promise((r) => setTimeout(r, 10_000));
      await runOneType(store, type, deviceId);
    }

    await JzSyncState.setLastRunAt(type, Date.now());
  }

  globalThis.JzSyncEngine = {
    runOneType,
    runRound,
    // 暴露给 testing / popup 触发
    _internal: { syncProducts, syncPostings, syncWarehouses },
  };
})();
