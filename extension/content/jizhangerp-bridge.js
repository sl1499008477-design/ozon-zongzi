/**
 * Frontend ↔ Extension postMessage bridge (jizhangerp.com 域内)。
 *
 * 用途：让 my.jizhangerp.com / store.jizhangerp.com / localhost:3000 上的
 * 前端代码,通过 window.postMessage 委托 extension 调 seller.ozon.ru/api/v1/search
 * 拿 sourceVariant,塞进 import payload 再 POST /products/import,避免 backend
 * 跨境直接打 seller portal 触发 antibot 403 重试堆积(单 item 节省 4-5min)。
 *
 * 设计:
 * - postMessage 通道 (非 externally_connectable) — 前端不用知道 extension ID,
 *   靠 ping 超时探测装没装
 * - 复用 lib/sku-collect.js 的 JZSkuCollect.collectBySkus —— 已有 BATCH_SIZE=3 +
 *   searchVariants(含 bundle 注入) + searchProductBySku 降级 + distill
 * - 协议版本 "v1"
 *
 * 协议:
 *   request:  { __jz:"v1", kind:"ping.request"|"prefetch.request"|"sync.request"|"follow-sell.request",
 *               reqId, skus?, storeId?, syncType?, sku?, price? }
 *   response: { __jz:"v1", kind:"ping.response"|"prefetch.response"|"sync.response"|"follow-sell.response",
 *               reqId, ok, ...payload }
 *
 * sync.request: 把 my.jizhangerp.com 上"立即同步"按钮的触发转发给 SW 跑 client-sync
 *   (取代后端 /ozon/sync/products|postings|warehouses BullMQ 路径)。
 *
 * 调用方见 frontend/lib/extension-bridge.ts
 */
(function () {
  "use strict";

  const PROTO = "v1";

  if (!window.JZSkuCollect) {
    // sku-collect.js 应该在 manifest 里排在 bridge 之前; 缺失即配置错误,直接返错
    console.warn("[jz-bridge] JZSkuCollect 未加载,manifest content_scripts 顺序有误");
  }

  function reply(reqId, kind, payload) {
    window.postMessage({ __jz: PROTO, kind, reqId, ...payload }, window.location.origin);
  }

  async function handlePrefetch(reqId, skus) {
    if (!Array.isArray(skus) || skus.length === 0) {
      reply(reqId, "prefetch.response", { ok: false, error: "skus 不能为空" });
      return;
    }
    if (!window.JZSkuCollect?.collectBySkus) {
      reply(reqId, "prefetch.response", { ok: false, error: "JZSkuCollect_not_loaded" });
      return;
    }
    try {
      const { sourceMap, failed } = await window.JZSkuCollect.collectBySkus(
        skus.map(String),
      );
      const bySku = {};
      for (const [sku, distilled] of sourceMap.entries()) {
        if (distilled?._sourceVariant) {
          bySku[sku] = distilled._sourceVariant;
        }
      }
      reply(reqId, "prefetch.response", {
        ok: true,
        bySku,
        failed: (failed || []).map((f) => ({ sku: f.sku, error: f.error })),
      });
    } catch (e) {
      reply(reqId, "prefetch.response", {
        ok: false,
        error: e?.message || String(e),
      });
    }
  }

  function sendToSw(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message || "chrome.runtime.sendMessage 失败"));
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function handleSync(reqId, storeId, syncType, postingsOptions) {
    if (!storeId || !syncType) {
      reply(reqId, "sync.response", {
        ok: false,
        error: "storeId / syncType 必填",
      });
      return;
    }
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      // bridge 不在 extension 上下文(理论上不可能,content_script 必有 chrome.runtime)
      reply(reqId, "sync.response", {
        ok: false,
        error: "chrome_runtime_unavailable",
      });
      return;
    }
    try {
      const resp = await sendToSw({
        type: "jzManualSync",
        portalProtocol: "JZ_ERP",
        storeId: String(storeId),
        syncType: String(syncType).toUpperCase(),
        ...(postingsOptions || {}),
      });
      if (!resp) {
        reply(reqId, "sync.response", { ok: false, error: "no_response_from_sw" });
        return;
      }
      reply(reqId, "sync.response", {
        ok: !!resp.ok,
        jobId: resp.jobId,
        error: resp.error,
      });
    } catch (e) {
      reply(reqId, "sync.response", {
        ok: false,
        error: e?.message || String(e),
      });
    }
  }

  async function handleFollowSell(reqId, payload) {
    const sku = String(payload?.sku || "").trim();
    const storeId = String(payload?.storeId || "").trim();
    const price = Number(payload?.price);
    if (!sku || !storeId || !Number.isFinite(price) || price <= 0) {
      reply(reqId, "follow-sell.response", {
        ok: false,
        error: "sku / storeId / price 必填",
      });
      return;
    }
    if (!window.JZSkuCollect?.collectBySkus || !window.JZV3Payload?.buildV3Item) {
      reply(reqId, "follow-sell.response", {
        ok: false,
        error: "插件上架依赖未加载，请重新加载扩展",
      });
      return;
    }
    try {
      const { sourceMap, failed } = await window.JZSkuCollect.collectBySkus([sku]);
      const distilled = sourceMap?.get?.(sku);
      if (!distilled) {
        const reason = failed?.[0]?.error || "未采集到可上架的源商品数据";
        reply(reqId, "follow-sell.response", { ok: false, error: reason });
        return;
      }

      const batchSalt = Date.now().toString(36).slice(-6);
      const built = window.JZV3Payload.buildV3Item(
        {
          sku,
          price,
          offerId: String(payload?.offerId || "").trim(),
        },
        distilled,
        {
          offerIdPrefix: String(payload?.offerIdPrefix || "jz"),
          batchSalt,
          currencyCode: String(payload?.currencyCode || "RUB"),
          vat: String(payload?.vat || "0"),
          brand: String(payload?.brand || "copy"),
          modelName: String(payload?.modelName || ""),
        },
      );
      if (!built?.ok || !built.item) {
        reply(reqId, "follow-sell.response", {
          ok: false,
          error: built?.error || "上架 item 构造失败",
        });
        return;
      }
      const stocks = Array.isArray(payload?.stocks)
        ? payload.stocks
            .map((row) => ({
              ...row,
              warehouse_id: row?.warehouse_id ?? row?.warehouseId,
              stock: Math.max(0, Number(row?.stock ?? row?.present ?? 0) || 0),
            }))
            .filter((row) => row.warehouse_id)
        : [];
      if (stocks.length) {
        built.item.stocks = stocks;
      }

      const followSellRequest = {
        action: "followSell",
        portalProtocol: "JZ_ERP",
        storeId,
        items: [built.item],
        strictTypeMatch: true,
        dryRun: !!payload?.dryRun,
        applyWatermark: !!payload?.applyWatermark,
        applyPoster: !!payload?.applyPoster,
        applyAiRewrite: !!payload?.applyAiRewrite,
      };
      if (stocks.length) {
        followSellRequest.stocks = stocks;
      }
      const resp = globalThis.JzPortalBridgePolicy.sanitizePortalBridgeResponse(await sendToSw(followSellRequest));
      if (!resp?.ok) {
        reply(reqId, "follow-sell.response", {
          ok: false,
          error: resp?.error || resp?.message || "提交上架失败",
          data: resp?.data || null,
        });
        return;
      }
      reply(reqId, "follow-sell.response", {
        ok: true,
        data: resp.data || null,
        taskId: resp.data?.result?.task_id || resp.data?.task_id || null,
      });
    } catch (e) {
      reply(reqId, "follow-sell.response", {
        ok: false,
        error: e?.message || String(e),
      });
    }
  }

  window.addEventListener("message", (ev) => {
    // 同窗同源限制 — 防其他 iframe / extension 注入伪造请求
    if (ev.source !== window) return;
    if (ev.origin !== window.location.origin) return;
    const msg = ev.data;
    if (!msg || msg.__jz !== PROTO || typeof msg.reqId !== "string") return;

    if (msg.kind === "ping.request") {
      reply(msg.reqId, "ping.response", {
        ok: true,
        version: chrome.runtime.getManifest().version,
        capabilities: {
          followSell: true,
          dryRunPreview: true,
          localListingBridge: true,
        },
      });
    } else if (msg.kind === "prefetch.request") {
      handlePrefetch(msg.reqId, msg.skus);
    } else if (msg.kind === "sync.request") {
      handleSync(msg.reqId, msg.storeId, msg.syncType, {
        postingsSinceDays: msg.postingsSinceDays,
        postingsSince: msg.postingsSince,
        postingsTo: msg.postingsTo,
      });
    } else if (msg.kind === "follow-sell.request") {
      handleFollowSell(msg.reqId, msg);
    }
  });
})();
