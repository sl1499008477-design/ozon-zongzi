/**
 * ozon-bff-interceptor.js — Ozon BFF 响应被动拦截器 (L1 数据层)
 *
 * 注入: MAIN world / document_start
 * 适配页面: ozon.ru/search/* | /category/* | /product/*  (manifest 各自单独 entry)
 *
 * 用途:
 *   被动 clone Ozon composer-api / entrypoint-api 响应,把 JSON 通过
 *   window.postMessage 推给 ISOLATED world 的 l1-bridge.js,作为 DOM 抓取
 *   之外的并行数据源。
 *
 * 不改写响应、不阻断请求 — 只读不写。
 *
 * 设计要点(详见 plan 文档 .claude/plans/chrome-api-purring-haven.md 第六节):
 *   1. **端点白名单** — 只拦命中 URL_PATTERNS 的 fetch/XHR,其他直通
 *   2. **accessor 自愈** — 用 Object.defineProperty 在 window.fetch 装 getter/setter,
 *      Ozon 自身 `window.fetch = native` 重置后 setter 会自动重新 wrap (抄
 *      ozon-premium-hook.js:367-382 已验证模式)
 *   3. **toString 伪装** — 在 wrapped fetch 上重写 toString,让
 *      `window.fetch.toString()` 看起来仍像 native,规避 Ozon 的指纹检测
 *   4. **clone + 异步解析** — clone() 后异步 .json(),失败静默吞掉,绝对不
 *      影响原 Response 流给页面
 *   5. **空闲态调度** — dispatchEvent 用 setTimeout(0) 推到下一个 tick,不阻塞
 *      原请求的关键路径
 */
(function () {
  "use strict";
  // 全局单例:商品页和搜索页 manifest 各有一条 MAIN world 注入条目,但同一
  // 浏览上下文(同 tab 同 frame)只应装一次 hook;此 flag 防重入。
  if (window.__JZC_BFF_INTERCEPTOR_INSTALLED__) return;
  window.__JZC_BFF_INTERCEPTOR_INSTALLED__ = true;

  // ─── 常量 ─────────────────────────────────────────
  // 跨 world 通信:用 window.postMessage 与 ISOLATED world 对话,与仓库现有
  // ozon-bestsellers-hook / ozon-premium-hook ↔ ozon-seller-bridge 约定一致。
  // 不用 CustomEvent — Chrome MV3 下 CustomEvent.detail 跨 world 时部分场景会
  // 被包成 wrapper,可调试性差。postMessage 走 structured clone 一致性更好。
  const MSG_TYPE = "JZC_OZON_COMPOSER_RESPONSE";
  const PATCH_FETCH = "__jzcInterceptFetchPatched__";
  const PATCH_FETCH_ACCESSOR = "__jzcInterceptFetchAccessorInstalled__";
  const PATCH_XHR_OPEN = "__jzcInterceptXhrOpenPatched__";
  const PATCH_XHR_OPEN_ACCESSOR = "__jzcInterceptXhrOpenAccessorInstalled__";
  const PATCH_XHR_SEND = "__jzcInterceptXhrSendPatched__";
  const PATCH_XHR_SEND_ACCESSOR = "__jzcInterceptXhrSendAccessorInstalled__";

  // 端点白名单 — 仅拦命中这些 path 的请求。命中后才 clone+json,其他请求 zero cost。
  // 路径选择依据(2026-05 抓包确认):
  //   搜索/类目页:
  //     /api/composer-api.bx/_action/getCatalog        — 搜索结果 v2 翻页 / 类目卡片
  //     /api/composer-api.bx/_action/getSimilarSearch  — 搜索相似/SPA 跳转后 BFF
  //     /api/composer-api.bx/page/json/v2              — 首屏类目/搜索 SSR 后 hydrate
  //   商品页:
  //     /api/composer-api.bx/_action/widgetStatesV2    — 商品页内部 widget 刷新(切 SKU/价格)
  //     /api/composer-api.bx/_action/getSellerProducts — 同店其他商品
  //     /api/composer-api.bx/_action/v2/reviewsList    — 商品评价
  //   通用:
  //     /api/entrypoint-api.bx/page/json/v2            — SSR hydrate(搜索/类目/商品 都走)
  const URL_PATTERNS = [
    /\/api\/composer-api\.bx\/_action\/getCatalog/i,
    /\/api\/composer-api\.bx\/_action\/getSimilarSearch/i,
    /\/api\/composer-api\.bx\/_action\/widgetStatesV2/i,
    /\/api\/composer-api\.bx\/_action\/getSellerProducts/i,
    /\/api\/composer-api\.bx\/_action\/v2\/reviewsList/i,
    /\/api\/composer-api\.bx\/page\/json\/v2/i,
    /\/api\/entrypoint-api\.bx\/page\/json\/v2/i,
  ];

  function isTargetUrl(url) {
    if (!url || typeof url !== "string") return false;
    for (let i = 0; i < URL_PATTERNS.length; i += 1) {
      if (URL_PATTERNS[i].test(url)) return true;
    }
    return false;
  }

  function extractUrlFromInput(input) {
    try {
      if (typeof input === "string") return input;
      if (input instanceof Request) return input.url;
      if (input && typeof input.url === "string") return input.url;
    } catch (e) {}
    return "";
  }

  // 异步派发,不阻塞原请求 — Promise.resolve().then 推到 microtask
  function dispatchSafe(url, data, source) {
    Promise.resolve().then(() => {
      try {
        // postMessage 默认 target = window (current frame),与现有 bridge 约定一致
        window.postMessage(
          {
            type: MSG_TYPE,
            url: url,
            data: data,
            source: source,
            ts: Date.now(),
          },
          window.location.origin
        );
      } catch (e) {
        // 安静失败 — 不能把异常抛回原请求链路
      }
    });
  }

  // ─── (1) window.fetch 拦截 ──────────────────────────
  // 缓存原生 fetch 的 toString 输出,用于伪装
  const NATIVE_FETCH_STR = (function () {
    try {
      return Function.prototype.toString.call(window.fetch);
    } catch (e) {
      return "function fetch() { [native code] }";
    }
  })();

  function makeNativeLooking(wrapped, nativeStr) {
    try {
      Object.defineProperty(wrapped, "toString", {
        value: function toString() {
          return nativeStr;
        },
        configurable: true,
        enumerable: false,
        writable: true,
      });
      // name 也伪装回 "fetch"
      try {
        Object.defineProperty(wrapped, "name", {
          value: "fetch",
          configurable: true,
        });
      } catch (e) {}
    } catch (e) {}
  }

  function wrapFetch(orig) {
    if (typeof orig !== "function" || orig[PATCH_FETCH]) return orig;
    const wrapped = function (input, init) {
      const url = String(extractUrlFromInput(input) || "");
      const promise = orig.call(this, input, init);
      if (!isTargetUrl(url)) return promise;
      // 命中白名单:fire-and-forget 异步消费 clone
      return promise.then(
        (response) => {
          try {
            if (response && typeof response.clone === "function") {
              const cloned = response.clone();
              cloned
                .json()
                .then((data) => dispatchSafe(url, data, "fetch"))
                .catch(() => {});
            }
          } catch (e) {}
          return response;
        },
        (err) => {
          throw err;
        }
      );
    };
    wrapped[PATCH_FETCH] = true;
    makeNativeLooking(wrapped, NATIVE_FETCH_STR);
    return wrapped;
  }

  function installFetchHook() {
    if (!window[PATCH_FETCH_ACCESSOR]) {
      let originalFetch = window.fetch;
      let currentFetch = wrapFetch(originalFetch);
      Object.defineProperty(window, "fetch", {
        configurable: true,
        enumerable: true,
        get: function () {
          return currentFetch;
        },
        set: function (next) {
          originalFetch = next;
          currentFetch = wrapFetch(next);
        },
      });
      window[PATCH_FETCH_ACCESSOR] = true;
    } else if (!window.fetch[PATCH_FETCH]) {
      // accessor 已装,但 setter 没把当前值 wrap (异常情况),重新触发
      // eslint-disable-next-line no-self-assign
      window.fetch = window.fetch;
    }
  }

  // ─── (2) XMLHttpRequest 拦截 ────────────────────────
  // Ozon 大部分接口走 fetch,但仍有少量 XHR(老页面/第三方 widget)
  function wrapXhrOpen(orig) {
    if (typeof orig !== "function" || orig[PATCH_XHR_OPEN]) return orig;
    const wrapped = function (method, url) {
      try {
        this.__jzcInterceptUrl__ = String(url || "");
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    wrapped[PATCH_XHR_OPEN] = true;
    makeNativeLooking(wrapped, "function open() { [native code] }");
    return wrapped;
  }

  function wrapXhrSend(orig) {
    if (typeof orig !== "function" || orig[PATCH_XHR_SEND]) return orig;
    const wrapped = function (body) {
      const url = String(this.__jzcInterceptUrl__ || "");
      if (isTargetUrl(url)) {
        const xhr = this;
        const origOnLoad = xhr.onload;
        const origOnReady = xhr.onreadystatechange;
        const captureBody = function () {
          try {
            if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300) {
              const text =
                xhr.responseType === "" || xhr.responseType === "text"
                  ? xhr.responseText
                  : null;
              if (text) {
                try {
                  const data = JSON.parse(text);
                  dispatchSafe(url, data, "xhr");
                } catch (e) {}
              }
            }
          } catch (e) {}
        };
        // 用 addEventListener 而不是覆盖 onload — 不要破坏原始监听器
        try {
          xhr.addEventListener("load", captureBody);
        } catch (e) {
          // 兜底:某些环境 addEventListener 被改,用 chained onload
          xhr.onload = function () {
            captureBody();
            if (typeof origOnLoad === "function") {
              try {
                origOnLoad.apply(xhr, arguments);
              } catch (e2) {}
            }
          };
          xhr.onreadystatechange = function () {
            if (typeof origOnReady === "function") {
              try {
                origOnReady.apply(xhr, arguments);
              } catch (e2) {}
            }
          };
        }
      }
      return orig.apply(this, [body]);
    };
    wrapped[PATCH_XHR_SEND] = true;
    makeNativeLooking(wrapped, "function send() { [native code] }");
    return wrapped;
  }

  function installXhrHook() {
    const proto = XMLHttpRequest.prototype;
    if (!proto[PATCH_XHR_OPEN_ACCESSOR]) {
      let originalOpen = proto.open;
      let currentOpen = wrapXhrOpen(originalOpen);
      Object.defineProperty(proto, "open", {
        configurable: true,
        enumerable: false,
        get: function () {
          return currentOpen;
        },
        set: function (next) {
          originalOpen = next;
          currentOpen = wrapXhrOpen(next);
        },
      });
      proto[PATCH_XHR_OPEN_ACCESSOR] = true;
    } else if (!proto.open[PATCH_XHR_OPEN]) {
      // eslint-disable-next-line no-self-assign
      proto.open = proto.open;
    }

    if (!proto[PATCH_XHR_SEND_ACCESSOR]) {
      let originalSend = proto.send;
      let currentSend = wrapXhrSend(originalSend);
      Object.defineProperty(proto, "send", {
        configurable: true,
        enumerable: false,
        get: function () {
          return currentSend;
        },
        set: function (next) {
          originalSend = next;
          currentSend = wrapXhrSend(next);
        },
      });
      proto[PATCH_XHR_SEND_ACCESSOR] = true;
    } else if (!proto.send[PATCH_XHR_SEND]) {
      // eslint-disable-next-line no-self-assign
      proto.send = proto.send;
    }
  }

  installFetchHook();
  installXhrHook();
})();
