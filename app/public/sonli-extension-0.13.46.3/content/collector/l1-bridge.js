// l1-bridge.js — L1 (composer-api 拦截) 跨 world 数据桥
//
// 注入: ISOLATED / document_idle / 搜索/类目/商品页 都注入
//
// 职责:
//   1. 接收 MAIN world ozon-bff-interceptor.js 通过 window.postMessage 推上来的
//      Ozon BFF 响应(type='JZC_OZON_COMPOSER_RESPONSE')
//   2. 写入本地 IndexedDB 影子表(window.JZL1ShadowDB,只存 metadata)
//   3. 转发给 service-worker(chrome.runtime.sendMessage 'JZC_L1_SAMPLE'),
//      由 SW 决定是否上报后端(默认 dry-run,见 background/service-worker.js)
//   4. 暴露 debug 入口 __jzc.l1Stats() / l1Clear() / l1ReportStatus()
//
// 设计原则:
//   - **本地写入永远成功,转发可失败** — 本地是 PoC 主路径,后端上报是次路径
//   - **转发节流** — chrome.runtime.sendMessage 不能太频繁,batch 10 条/2s
//   - **同 frame 单例** — search 和 product 页 manifest 各引一次,用 flag 防重入

(() => {
  if (window.__JZC_L1_BRIDGE_INSTALLED__) return;
  window.__JZC_L1_BRIDGE_INSTALLED__ = true;

  const MSG_TYPE_FROM_MAIN = "JZC_OZON_COMPOSER_RESPONSE";
  const MSG_TYPE_TO_SW = "JZC_L1_SAMPLE";

  // ─── 运行时计数器(debug 用,不持久化)─────────────────
  const counters = {
    received: 0,
    persisted: 0,
    forwardedToSw: 0,
    swErrors: 0,
    persistErrors: 0,
    lastError: null,
    startedAt: Date.now(),
  };

  // ─── batch 转发到 service worker(节流) ──────────────
  // 每条样本立刻写本地;转发 SW 做 batch (10 条 OR 2s flush 一次),减少 SW 唤醒
  const pendingForward = [];
  let flushTimer = null;
  const FLUSH_BATCH = 10;
  const FLUSH_INTERVAL_MS = 2000;

  function flushForward() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingForward.length === 0) return;
    const batch = pendingForward.splice(0, pendingForward.length);
    try {
      chrome.runtime.sendMessage(
        { type: MSG_TYPE_TO_SW, samples: batch, ts: Date.now() },
        (response) => {
          // sendMessage 在 SW 未唤醒时可能丢失,容错处理
          if (chrome.runtime.lastError) {
            counters.swErrors += 1;
            counters.lastError = chrome.runtime.lastError.message;
            return;
          }
          counters.forwardedToSw += batch.length;
        }
      );
    } catch (e) {
      counters.swErrors += 1;
      counters.lastError = e && e.message ? e.message : String(e);
    }
  }

  function enqueueForward(sample) {
    pendingForward.push(sample);
    if (pendingForward.length >= FLUSH_BATCH) {
      flushForward();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushForward, FLUSH_INTERVAL_MS);
    }
  }

  // ─── 主入口:接 MAIN world postMessage ──────────────
  window.addEventListener("message", (event) => {
    if (!event || event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.type !== MSG_TYPE_FROM_MAIN) return;
    counters.received += 1;

    // 1) 本地影子表写入(优先)
    if (window.JZL1ShadowDB) {
      window.JZL1ShadowDB.putSample({
        url: msg.url,
        data: msg.data,
        ts: msg.ts,
        source: msg.source,
      })
        .then(() => {
          counters.persisted += 1;
        })
        .catch((err) => {
          counters.persistErrors += 1;
          counters.lastError =
            err && err.message ? err.message : String(err);
        });
    } else {
      counters.persistErrors += 1;
      counters.lastError = "JZL1ShadowDB not loaded";
    }

    // 2) SW 转发:**只传 metadata,不传原始 data**
    //    后端可能存,转发体不能太大,且原始 data 含 widget tracking 等隐私字段
    let topKeys = [];
    let byteSize = 0;
    try {
      topKeys =
        msg.data && typeof msg.data === "object"
          ? Object.keys(msg.data).slice(0, 50)
          : [];
      byteSize = JSON.stringify(msg.data || null).length;
    } catch (e) {}
    enqueueForward({
      url: msg.url,
      ts: msg.ts,
      source: msg.source,
      topKeys,
      byteSize,
      pageUrl: window.location.href,
    });
  });

  // 页面卸载时 flush 一次,避免 batch 在路上丢
  window.addEventListener("beforeunload", () => {
    flushForward();
  });

  // ─── debug 入口 ───────────────────────────────────
  window.__jzc = window.__jzc || {};

  window.__jzc.l1Stats = async function l1Stats() {
    const c = { ...counters };
    const stats = window.JZL1ShadowDB ? await window.JZL1ShadowDB.stats() : null;
    const recent = window.JZL1ShadowDB
      ? await window.JZL1ShadowDB.getRecentSamples(5)
      : [];
    return { counters: c, shadowDb: stats, recent };
  };

  window.__jzc.l1Clear = async function l1Clear() {
    if (window.JZL1ShadowDB) await window.JZL1ShadowDB.clearSamples();
    counters.received = 0;
    counters.persisted = 0;
    counters.forwardedToSw = 0;
    counters.swErrors = 0;
    counters.persistErrors = 0;
    counters.lastError = null;
    counters.startedAt = Date.now();
    return "cleared";
  };

  window.__jzc.l1ReportStatus = function l1ReportStatus() {
    // 查 service-worker 端的上报开关状态。开关存在 chrome.storage.local.l1ReportEnabled。
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "JZC_L1_REPORT_STATUS" },
          (response) => {
            if (chrome.runtime.lastError) {
              resolve({ error: chrome.runtime.lastError.message });
              return;
            }
            resolve(response || { error: "no response from sw" });
          }
        );
      } catch (e) {
        resolve({ error: e && e.message ? e.message : String(e) });
      }
    });
  };
})();
