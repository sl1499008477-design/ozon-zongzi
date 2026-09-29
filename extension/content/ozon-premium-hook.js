globalThis.__JZ_BRAND__ = {"code":"sonli","displayName":"ozon 粽子","productName":"ozon 粽子","primaryColor":"#1268FF","apiHost":"www.ozonzongzi.com/api","webHost":"www.ozonzongzi.com","logoUrl":(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL("icons/ozon-zongzi-symbol.svg") : null};
/**
 * ozon-premium-hook.js — 数据透视眼（Ozon Premium 客户端伪造）。
 *
 * 注入：MAIN world / document_start / all_frames / matches: seller.ozon.ru/app/analytics/*
 *
 * 用途：
 *   在 Ozon 卖家后台 /app/analytics 路径下，hook fetch / XHR / JSON.parse /
 *   Response.prototype.json 这 4 条数据通道，把 Premium 会员相关接口的响应改写
 *   成「已开通」状态（is_premium=true / status=grace_good / features.*=full），
 *   绕过付费墙的 UI 锁定。
 *
 * ⚠ 风险提示：
 *   - 客户端伪造，不影响 Ozon 服务端真实订阅状态
 *   - 仅解锁前端图表壳子（dataPoints 是随机数，无真实数据）
 *   - 可能违反 Ozon TOS，存在店铺封禁风险
 *
 * 移植自 https://gitee.com/secret_code_5534/pivot-table，做了 3 处适配：
 *   1. 开关来源：sessionStorage → chrome.storage.local（通过 ozon-seller-bridge.js
 *      relay，bridge 拿到 storage 后 postMessage 反传，本脚本接收）
 *   2. 浮动面板位置存储：sessionStorage → chrome.storage.local（同上）
 *   3. 浮动面板内 toggle 点击：postMessage('JZC_PREMIUM_REQUEST_TOGGLE')
 *      让 bridge 写 storage，触发 onChanged 反传，保持单向数据流
 */
(function () {
  "use strict";
  if (window.__JZC_PREMIUM_HOOK_INSTALLED__) return;
  window.__JZC_PREMIUM_HOOK_INSTALLED__ = true;
  const BRAND_DISPLAY_NAME =
    (globalThis.__JZ_BRAND__ && globalThis.__JZ_BRAND__.displayName) ||
    (/__BRAND/.test("ozon 粽子") ? "平台" : "ozon 粽子");

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case "&": return "&amp;";
        case "<": return "&lt;";
        case ">": return "&gt;";
        case '"': return "&quot;";
        case "'": return "&#39;";
        default: return ch;
      }
    });
  }

  // 启动标记：用户可在 DevTools 看到这条日志确认 hook 已注入
  console.log(`[${BRAND_DISPLAY_NAME}·透视眼] hook 已注入 ·`, window.location.href);

  // ─── 常量 ─────────────────────────────────────────
  const PANEL_ID = "jzc_premium_panel";
  const PATCH_FETCH = "__jzcPremiumFetchPatched__";
  const PATCH_FETCH_ACCESSOR = "__jzcPremiumFetchAccessorInstalled__";
  const PATCH_XHR_OPEN = "__jzcPremiumXhrOpenPatched__";
  const PATCH_XHR_OPEN_ACCESSOR = "__jzcPremiumXhrOpenAccessorInstalled__";
  const PATCH_XHR_SEND = "__jzcPremiumXhrSendPatched__";
  const PATCH_XHR_SEND_ACCESSOR = "__jzcPremiumXhrSendAccessorInstalled__";
  const PATCH_JSON_PARSE = "__jzcPremiumJsonParsePatched__";
  const PATCH_RESPONSE_JSON = "__jzcPremiumResponseJsonPatched__";

  // 相关 API URL 白名单（命中才触发伪造）
  const URL_PATTERNS = [
    /\/premium\/status/i,
    /seller-analytics\/premium\/status/i,
    /get-seller-premium-status/i,
    /\/analytics\/graphs/i,
    /\/graph\/data/i,
    /\/statistics\/data/i,
  ];

  const objAssign =
    typeof Object.assign === "function"
      ? Object.assign.bind(Object)
      : function (target) {
          for (let i = 1; i < arguments.length; i += 1) {
            const src = arguments[i];
            if (!src) continue;
            for (const k in src) {
              if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
            }
          }
          return target;
        };

  // ─── 运行时状态（由 bridge 通过 postMessage 推送） ──────
  let enabled = false; // 开关
  let panelPos = null; // { left, top } | null
  let currentHref = window.location.href;

  // ─── 路径检查 ─────────────────────────────────────
  function inAnalyticsPath() {
    return /^https:\/\/seller\.ozon\.ru\/app\/analytics(?:[/?#]|$)/i.test(
      window.location.href
    );
  }
  function shouldFakeUrl(url) {
    return inAnalyticsPath() && URL_PATTERNS.some((re) => re.test(url));
  }

  // ─── 伪造响应生成（按 URL 命中正则返回不同 shape） ────
  function buildFakeResponse(url) {
    const base = {
      status: "grace_good",
      is_premium: true,
      isPremiumPlus: true,
      isAnalyst: true,
      subscription: {
        current: "PREMIUM_PLUS",
        available: ["PREMIUM_PLUS"],
        grace_period_end_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      },
      features: {
        analytics: "full",
        marketing: "full",
        api: "full_access",
        graphs: "full",
        reports: "full",
        statistics: "full",
        recommendations: "full",
      },
    };
    if (/\/analytics\/graphs/i.test(url) || /\/graph\/data/i.test(url)) {
      return objAssign({}, base, {
        graphsAccess: true,
        dataSets: ["sales", "traffic", "conversion"],
        timeRanges: ["day", "week", "month"],
      });
    }
    if (/seller-analytics\/premium\/status/i.test(url)) {
      return objAssign({}, base, {
        dataPoints: Array.from({ length: 15 }, (_, i) => ({
          id: "metric_" + i,
          value: Math.floor(Math.random() * 1000),
          trend: Math.random() > 0.5 ? "up" : "down",
          change: Math.floor(Math.random() * 100),
        })),
        hasAccess: true,
        accessLevel: "FULL",
      });
    }
    return base;
  }

  // ─── deep patch ─────────────────────────────────
  function isPlainObject(v) {
    return !!v && Object.prototype.toString.call(v) === "[object Object]";
  }

  function looksPremiumLike(obj) {
    if (!isPlainObject(obj)) return false;
    const keys = Object.keys(obj);
    if (!keys.length) return false;
    return keys.some((k) => {
      const lk = k.toLowerCase();
      return (
        lk.indexOf("premium") !== -1 ||
        lk.indexOf("subscription") !== -1 ||
        lk.indexOf("access") !== -1 ||
        lk.indexOf("graph") !== -1 ||
        lk.indexOf("analytic") !== -1 ||
        lk.indexOf("feature") !== -1
      );
    });
  }

  function patchInPlace(obj) {
    if (!isPlainObject(obj)) return false;
    let changed = false;
    if ("status" in obj) {
      obj.status = "grace_good";
      changed = true;
    }
    if ("is_premium" in obj) {
      obj.is_premium = true;
      changed = true;
    }
    if ("isPremium" in obj) {
      obj.isPremium = true;
      changed = true;
    }
    if ("isPremiumPlus" in obj) {
      obj.isPremiumPlus = true;
      changed = true;
    }
    if ("isAnalyst" in obj) {
      obj.isAnalyst = true;
      changed = true;
    }
    if ("hasAccess" in obj) {
      obj.hasAccess = true;
      changed = true;
    }
    if ("graphsAccess" in obj) {
      obj.graphsAccess = true;
      changed = true;
    }
    if ("accessLevel" in obj) {
      obj.accessLevel = "FULL";
      changed = true;
    }
    if ("locked" in obj && typeof obj.locked === "boolean") {
      obj.locked = false;
      changed = true;
    }
    if ("isLocked" in obj && typeof obj.isLocked === "boolean") {
      obj.isLocked = false;
      changed = true;
    }
    if (
      "disabled" in obj &&
      typeof obj.disabled === "boolean" &&
      looksPremiumLike(obj)
    ) {
      obj.disabled = false;
      changed = true;
    }
    if (isPlainObject(obj.subscription) || Array.isArray(obj.subscription)) {
      obj.subscription = objAssign(
        {},
        isPlainObject(obj.subscription) ? obj.subscription : {},
        {
          current: "PREMIUM_PLUS",
          available: ["PREMIUM_PLUS"],
          grace_period_end_at: new Date(
            Date.now() + 30 * 24 * 3600 * 1000
          ).toISOString(),
        }
      );
      changed = true;
    }
    if (isPlainObject(obj.features)) {
      obj.features = objAssign({}, obj.features, {
        analytics: "full",
        marketing: "full",
        api: "full_access",
        graphs: "full",
        reports: "full",
        statistics: "full",
        recommendations: "full",
      });
      changed = true;
    }
    return changed;
  }

  function deepPatch(value, seen) {
    if (!enabled || !inAnalyticsPath() || value == null) return value;
    const visited = seen || new WeakSet();
    if (typeof value !== "object" || visited.has(value)) return value;
    visited.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) value[i] = deepPatch(value[i], visited);
      return value;
    }
    const isPremiumShape = patchInPlace(value) || looksPremiumLike(value);
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      value[k] = deepPatch(value[k], visited);
    }
    if (!isPremiumShape && looksPremiumLike(value)) patchInPlace(value);
    return value;
  }

  // ─── 4 层拦截 ──────────────────────────────────────

  // (1) JSON.parse + Response.prototype.json (兜底)
  function patchJsonParsers() {
    const origParse = JSON.parse;
    if (!origParse[PATCH_JSON_PARSE]) {
      JSON.parse = function (text, reviver) {
        return deepPatch(origParse.call(this, text, reviver));
      };
      JSON.parse[PATCH_JSON_PARSE] = true;
    }
    const origRespJson = Response.prototype.json;
    if (!origRespJson[PATCH_RESPONSE_JSON]) {
      Response.prototype.json = function () {
        return origRespJson.apply(this, arguments).then((data) => deepPatch(data));
      };
      Response.prototype.json[PATCH_RESPONSE_JSON] = true;
    }
  }

  // (2) XMLHttpRequest open + send
  function patchXhr() {
    const proto = XMLHttpRequest.prototype;

    function wrapOpen(orig) {
      if (typeof orig !== "function" || orig[PATCH_XHR_OPEN]) return orig;
      const wrapped = function (method, url) {
        this.__jzcPremiumUrl__ = url;
        return orig.apply(this, arguments);
      };
      wrapped[PATCH_XHR_OPEN] = true;
      return wrapped;
    }

    function wrapSend(orig) {
      if (typeof orig !== "function" || orig[PATCH_XHR_SEND]) return orig;
      const wrapped = function (body) {
        const url = String(this.__jzcPremiumUrl__ || "");
        if (enabled && shouldFakeUrl(url)) {
          const fake = JSON.stringify(buildFakeResponse(url));
          Object.defineProperties(this, {
            responseText: { value: fake },
            response: { value: fake },
            status: { value: 200 },
            statusText: { value: "OK" },
            readyState: { value: 4 },
          });
          Promise.resolve().then(() => {
            if (typeof this.onreadystatechange === "function") {
              try {
                this.onreadystatechange();
              } catch {}
            }
            if (typeof this.onload === "function") {
              try {
                this.onload();
              } catch {}
            }
          });
          return;
        }
        return orig.apply(this, [body]);
      };
      wrapped[PATCH_XHR_SEND] = true;
      return wrapped;
    }

    if (!proto[PATCH_XHR_OPEN_ACCESSOR]) {
      let originalOpen = proto.open;
      let currentOpen = wrapOpen(originalOpen);
      Object.defineProperty(proto, "open", {
        configurable: true,
        enumerable: false,
        get: () => currentOpen,
        set(next) {
          originalOpen = next;
          currentOpen = wrapOpen(next);
        },
      });
      proto[PATCH_XHR_OPEN_ACCESSOR] = true;
    } else if (!proto.open[PATCH_XHR_OPEN]) {
      proto.open = proto.open;
    }

    if (!proto[PATCH_XHR_SEND_ACCESSOR]) {
      let originalSend = proto.send;
      let currentSend = wrapSend(originalSend);
      Object.defineProperty(proto, "send", {
        configurable: true,
        enumerable: false,
        get: () => currentSend,
        set(next) {
          originalSend = next;
          currentSend = wrapSend(next);
        },
      });
      proto[PATCH_XHR_SEND_ACCESSOR] = true;
    } else if (!proto.send[PATCH_XHR_SEND]) {
      proto.send = proto.send;
    }
  }

  // (3) window.fetch
  function patchFetch() {
    function wrap(orig) {
      if (typeof orig !== "function" || orig[PATCH_FETCH]) return orig;
      const wrapped = async function (input, init) {
        const url = String(input instanceof Request ? input.url : input || "");
        if (enabled && shouldFakeUrl(url)) {
          const fake = buildFakeResponse(url);
          return new Response(JSON.stringify(fake), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return orig.call(this, input, init);
      };
      wrapped[PATCH_FETCH] = true;
      return wrapped;
    }

    if (!window[PATCH_FETCH_ACCESSOR]) {
      let originalFetch = window.fetch;
      let currentFetch = wrap(originalFetch);
      Object.defineProperty(window, "fetch", {
        configurable: true,
        enumerable: true,
        get: () => currentFetch,
        set(next) {
          originalFetch = next;
          currentFetch = wrap(next);
        },
      });
      window[PATCH_FETCH_ACCESSOR] = true;
    } else if (!window.fetch[PATCH_FETCH]) {
      window.fetch = window.fetch;
    }
  }

  // ─── 浮动面板（透视眼） ─────────────────────────────
  function removePanel() {
    const el = document.getElementById(PANEL_ID);
    if (el) el.remove();
  }

  function renderPanel() {
    if (!inAnalyticsPath()) {
      removePanel();
      return;
    }
    removePanel();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText = [
      "position:fixed",
      "right:20px",
      "top:35%",
      "transform:translateY(-50%)",
      "width:190px",
      "padding:15px",
      "background:#fff",
      "border-radius:8px",
      "box-shadow:0 4px 12px rgba(0,0,0,0.1)",
      "z-index:999999",
      "font-family:Arial",
      "font-size:12px",
      "border:1px solid #eee",
      "cursor:move",
    ].join(";");

    panel.innerHTML = [
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding:0 4px;">',
      '<span style="font-weight:500;color:#1D2129;">透视眼</span>',
      `<div style="font-weight:bold;color:#1677FF;font-size:14px;">${escapeHtml(BRAND_DISPLAY_NAME)}</div>`,
      "</div>",
      `<div id="jzc_premium_toggle" style="width:40px;height:20px;border-radius:10px;position:relative;cursor:pointer;transition:all .2s;background:${enabled ? "#1677FF" : "#DCDFE6"};margin:0 auto 12px;"></div>`,
      '<div id="jzc_premium_status" style="text-align:center;font-weight:bold;padding:8px;border-radius:6px;background:#F7F8FA;color:#1D2129;">',
      enabled ? "会员权限伪造已启用" : "会员权限伪造已关闭",
      "</div>",
    ].join("");

    const knob = document.createElement("div");
    knob.style.cssText = [
      "width:16px",
      "height:16px",
      "border-radius:50%",
      "background:#fff",
      "position:absolute",
      "top:2px",
      "left:" + (enabled ? "22px" : "2px"),
      "transition:all .2s",
      "box-shadow:0 1px 3px rgba(0,0,0,0.15)",
    ].join(";");
    const toggle = panel.querySelector("#jzc_premium_toggle");
    toggle.appendChild(knob);

    toggle.addEventListener("click", () => {
      // 不直接改本地 enabled，让 bridge 写 storage 后通过 onChanged 反传
      window.postMessage(
        {
          __jzcReport: 1,
          type: "JZC_PREMIUM_REQUEST_TOGGLE",
          next: !enabled,
        },
        "*"
      );
    });

    document.body.appendChild(panel);

    // 应用持久化位置
    if (panelPos && typeof panelPos.left === "number" && typeof panelPos.top === "number") {
      panel.style.right = "auto";
      panel.style.transform = "none";
      panel.style.left = panelPos.left + "px";
      panel.style.top = panelPos.top + "px";
    }

    makeDraggable(panel, [toggle]);
  }

  function makeDraggable(panel, ignoreList) {
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let pendingDrag = false;
    let dragging = false;
    let savedUserSelect = "";
    let savedCursor = "";

    function onMouseMove(e) {
      if (!pendingDrag && !dragging) return;
      e.preventDefault();
      const dx = e.clientX - originX;
      const dy = e.clientY - originY;
      if (!dragging && pendingDrag) {
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        dragging = true;
        pendingDrag = false;
        panel.style.right = "auto";
        panel.style.transform = "none";
        panel.style.left = startX + "px";
        panel.style.top = startY + "px";
        savedUserSelect = document.body.style.userSelect;
        savedCursor = document.body.style.cursor;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "move";
      }
      if (!dragging) return;
      let nextX = startX + dx;
      let nextY = startY + dy;
      const maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
      nextX = Math.max(0, Math.min(nextX, maxX));
      nextY = Math.max(0, Math.min(nextY, maxY));
      panel.style.left = nextX + "px";
      panel.style.top = nextY + "px";
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      if (dragging) {
        document.body.style.userSelect = savedUserSelect;
        document.body.style.cursor = savedCursor;
        const left = parseInt(panel.style.left, 10);
        const top = parseInt(panel.style.top, 10);
        if (!Number.isNaN(left) && !Number.isNaN(top)) {
          window.postMessage(
            {
              __jzcReport: 1,
              type: "JZC_PREMIUM_PANEL_POS",
              pos: { left, top },
            },
            "*"
          );
        }
      }
      pendingDrag = false;
      dragging = false;
    }

    panel.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const target = e.target;
      if (ignoreList.some((node) => node && (node === target || node.contains(target))))
        return;
      const rect = panel.getBoundingClientRect();
      startX = rect.left;
      startY = rect.top;
      originX = e.clientX;
      originY = e.clientY;
      pendingDrag = true;
      dragging = false;
      window.addEventListener("mousemove", onMouseMove, true);
      window.addEventListener("mouseup", onMouseUp, true);
    });
  }

  // ─── 消息接收（来自 bridge / 同源） ──────────────────
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__jzcReport !== 1) return;
    if (d.type === "JZC_PREMIUM_TOGGLE") {
      enabled = !!d.enabled;
      if (document.body) renderPanel();
    } else if (d.type === "JZC_PREMIUM_PANEL_POS_RESTORE") {
      panelPos = d.pos || null;
      if (document.body) renderPanel();
    }
  });

  // ─── 启动 ─────────────────────────────────────────
  function applyAll() {
    patchXhr();
    patchFetch();
    patchJsonParsers();
    if (document.body) renderPanel();
  }

  function checkUrlChange() {
    if (window.location.href !== currentHref) {
      currentHref = window.location.href;
      applyAll();
    }
  }

  function hookHistory() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
      const r = origPush.apply(this, arguments);
      queueMicrotask(checkUrlChange);
      return r;
    };
    history.replaceState = function () {
      const r = origReplace.apply(this, arguments);
      queueMicrotask(checkUrlChange);
      return r;
    };
    window.addEventListener("popstate", checkUrlChange);
    window.addEventListener("hashchange", checkUrlChange);
  }

  // 立即开始 patch（不依赖开关，patch 拦截内部会判 enabled）
  patchXhr();
  patchFetch();
  patchJsonParsers();
  if (document.body) {
    renderPanel();
  } else {
    window.addEventListener("DOMContentLoaded", () => renderPanel(), { once: true });
  }
  hookHistory();
  applyAll();

  // 1s 兜底轮询：URL 变化 + 重新渲染面板
  window.setInterval(() => {
    applyAll();
    checkUrlChange();
  }, 1000);

  // 启动时主动询问 bridge 当前状态（异步等 storage）
  window.postMessage({ __jzcReport: 1, type: "JZC_PREMIUM_QUERY" }, "*");
})();
