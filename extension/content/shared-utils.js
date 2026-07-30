globalThis.__JZ_BRAND__ = {"code":"sonli","displayName":"ozon 粽子","productName":"ozon 粽子","primaryColor":"#1268FF","apiHost":"127.0.0.1:3000/api","webHost":"127.0.0.1:3000","logoUrl":(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL("icons/ozon-zongzi-symbol.svg") : null};
// Shared utility functions for 极掌 (JiZhang) Extension
// This file is loaded before other content scripts via manifest.json

// Brand 兜底:dev 直接加载源码时 esbuild define 未注入 globalThis.__JZ_BRAND__,
// fallback 默认极掌。生产 build 时 build.js esbuild define 把 globalThis.__JZ_BRAND__
// 静态 inline 成实际 brand 对象,该 if 判断恒为 false,赋值被 DCE。
// per-field 兜底:防止某个 brand build 漏配字段(如 distributor 配置只有
// displayName/logoUrl 没 webHost)→ `https://${undefined}` 这种线上 bug。
const BRAND_DISPLAY_NAME_FALLBACK = /__BRAND/.test("ozon 粽子")
  ? "平台"
  : "ozon 粽子";
const BRAND_PRODUCT_NAME_FALLBACK = /__BRAND/.test("ozon 粽子")
  ? `${BRAND_DISPLAY_NAME_FALLBACK}算价`
  : "ozon 粽子";
const __JZ_BRAND_DEFAULTS__ = {
  code: "platform",
  displayName: BRAND_DISPLAY_NAME_FALLBACK,
  productName: BRAND_PRODUCT_NAME_FALLBACK,
  primaryColor: "#1268FF",
  apiHost: "127.0.0.1:3000/api",
  webHost: "127.0.0.1:3000",
  logoUrl: null,
};
if (!globalThis.__JZ_BRAND__) {
  globalThis.__JZ_BRAND__ = { ...__JZ_BRAND_DEFAULTS__ };
} else {
  for (const k of Object.keys(__JZ_BRAND_DEFAULTS__)) {
    if (globalThis.__JZ_BRAND__[k] == null) {
      globalThis.__JZ_BRAND__[k] = __JZ_BRAND_DEFAULTS__[k];
    }
  }
}

(function() {
  'use strict';

  const STATE_CACHE = {};
  const KEY_CACHE = {};

  // ─── Machine fingerprint v3 (2026-05-27 起,跟 popup.js / frontend
  //     device-fingerprint.ts 严格对齐) ─────────────────────────────
  //
  // 设计:同台机器的「网页 / 插件 popup / 插件 content script」三处算出来必须
  // 完全相同,backend `device.service.ts:265 groupByFingerprint` 才能把它们
  // 归到 1 个名额。SW 自己没 DOM 算不出 screen 维度,所以让任意有 DOM 的
  // 入口(popup 登录、content script 启动、sync-auth.js 同步)把算出的 v3
  // 推给 SW 缓存(`setMachineFingerprint` action)。
  //
  // 算法:OS bucket + 屏宽×高×色深 + 时区 + 主语言 + CPU 核数。
  // v2 用过 devicePixelRatio + navigator.languages.slice(0,3),同台机不同
  // zoom / Edge profile 会变,v3 移除。
  function _jzcOsBucket() {
    const platform = `${navigator.userAgentData?.platform || navigator.platform || ''} ${navigator.userAgent || ''}`;
    if (/mac/i.test(platform)) return 'mac';
    if (/win/i.test(platform)) return 'windows';
    if (/android/i.test(platform)) return 'android';
    if (/iphone|ipad|ios/i.test(platform)) return 'ios';
    if (/linux/i.test(platform)) return 'linux';
    return 'unknown-os';
  }
  function _jzcFpHash(s) {
    let h1 = 0x811c9dc5;
    let h2 = 0x1b873593;
    for (let i = 0; i < s.length; i++) {
      h1 = (h1 ^ s.charCodeAt(i)) >>> 0;
      h1 = Math.imul(h1, 0x01000193);
      h2 = (h2 ^ s.charCodeAt(i)) >>> 0;
      h2 = Math.imul(h2, 0xcc9e2d51);
    }
    return `${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`;
  }
  window.getMachineFingerprintV3 = function () {
    const screenInfo = window.screen
      ? [window.screen.width, window.screen.height, window.screen.colorDepth].join('x')
      : 'unknown-screen';
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown-tz';
    const language = navigator.language || 'unknown-lang';
    const raw = [
      'jizhang-machine-v3',
      _jzcOsBucket(),
      screenInfo,
      timeZone,
      language,
      navigator.hardwareConcurrency || 0,
    ].join('|');
    return `machine-v3-${_jzcFpHash(raw)}`;
  };

  // 启动时主动把 fingerprint 推给 SW,不依赖用户必须先打开 popup 登录。
  // SW 收到后存 chrome.storage.local.ozonMachineFingerprintV3,后续 heartbeat /
  // login 等所有动作复用同一份 v3,跟 web/popup 算的一致 → 同台机 1 名额。
  // 失败静默(SW 未就绪 / 接口不在 等)— 这只是优化,不影响主功能。
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      const fp = window.getMachineFingerprintV3();
      chrome.runtime.sendMessage({ action: 'setMachineFingerprint', deviceFingerprint: fp }, () => {
        // 吞 chrome.runtime.lastError(SW unloaded 等),保持静默
        void chrome.runtime.lastError;
      });
    }
  } catch {}

  /**
   * Inline lucide-style SVG icons. 替代 emoji 用作 UI 装饰，统一克制风格。
   * 使用：window.lucideIcon('copy', 14) → 返回 14×14 stroke=currentColor 的 svg 字符串。
   * 不在表里的 name 会回退到 'package'。stroke-width 默认 2。
   */
  const LUCIDE_PATHS = {
    'package': '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    'box': '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>',
    'dollar-sign': '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    'bar-chart': '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    'pie-chart': '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
    'trending-up': '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    'tag': '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    'copy': '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    'globe': '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    'check': '<polyline points="20 6 9 17 4 12"/>',
    'x': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    'loader': '<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>',
    'alert-triangle': '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    'flame': '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    'gem': '<polygon points="6 3 18 3 22 9 12 22 2 9"/><polyline points="11 3 8 9 12 22 16 9 13 3"/><line x1="2" y1="9" x2="22" y2="9"/>',
    'flag': '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
    'check-square': '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    'star': '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    'zap': '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    'truck': '<rect x="1" y="3" width="15" height="13" rx="1"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    'plane': '<path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.2.6-.6.5-1.1z"/>',
    'settings': '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    'ban': '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
    'battery': '<rect x="1" y="6" width="18" height="12" rx="2" ry="2"/><line x1="23" y1="13" x2="23" y2="11"/>',
    'flask': '<path d="M9 2v6L4 18a2 2 0 0 0 1.8 2.9h12.4A2 2 0 0 0 20 18L15 8V2"/><line x1="9" y1="2" x2="15" y2="2"/><line x1="6" y1="14" x2="18" y2="14"/>',
    'droplet': '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
    'pill': '<path d="M10.5 20.5L20.5 10.5a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="M8.5 8.5l7 7"/>',
    'crosshair': '<circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>',
    'radio': '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>',
    'cigarette': '<path d="M18 12H2v4h16"/><path d="M22 12v4"/><path d="M7 12v4"/><path d="M18 8c0-2.5-2-2.5-2-5"/><path d="M22 8c0-2.5-2-2.5-2-5"/>',
  };

  window.lucideIcon = function(name, size) {
    const sz = size || 14;
    const p = LUCIDE_PATHS[name] || LUCIDE_PATHS['package'];
    return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  };


  // PDP composer-api 缓存(Ozon 2026 SSR DOM 剥离修复):
  // 页面 hydrate 把 web* widget state 全擦了。我们走 SW → composer-api 拉
  // page json,把 widgetStates 缓存到这里,extractStateData 在 DOM miss 时
  // fallback 命中,所有老 caller 透明修复。
  // 缓存 key=URL,TTL 60s,跨 URL(SPA 软导航)自动失效。
  let _jzPdpStateCache = null; // { url, expiresAt, widgetStates }
  let _jzPdpStateFetchPromise = null;
  // 把 SW widgetStates 的 key prefix 映射到旧 extractStateData stateName。
  // 旧 caller 调 'state-webPrice' / 'state-webGallery';新 widgetStates 的 key
  // 是 'webPrice-12345-default-1' 这种。前缀匹配命中。
  const _statePrefixOf = (stateName) => stateName.replace(/^state-/, '');

  window.extractStateData = function(stateName) {
    if (STATE_CACHE[stateName]) {
      return STATE_CACHE[stateName];
    }
    try {
      // Old format: <div data-state="state-webPrice">{"price":"44 ¥"}</div>
      const stateElement = document.querySelector(`[data-state="${stateName}"]`);
      if (stateElement && stateElement.textContent) {
        const parsed = JSON.parse(stateElement.textContent);
        if (parsed !== null && parsed !== undefined) {
          STATE_CACHE[stateName] = parsed;
          return parsed;
        }
      }
    } catch {}
    // Fallback: 命中 composer-api 缓存(Ozon 2026 纯客户端 hydrate 场景)
    if (
      _jzPdpStateCache &&
      _jzPdpStateCache.url === window.location.href &&
      _jzPdpStateCache.expiresAt > Date.now()
    ) {
      const prefix = _statePrefixOf(stateName);
      const wsKey = Object.keys(_jzPdpStateCache.widgetStates).find((k) => k.startsWith(prefix));
      if (wsKey) {
        const raw = _jzPdpStateCache.widgetStates[wsKey];
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (parsed != null) {
            STATE_CACHE[stateName] = parsed;
            return parsed;
          }
        } catch {}
      }
    }
    return null;
  };

  // 异步预热:页面加载后 1 次性拉 composer-api page json,populate cache。
  // 之后所有 sync extractStateData('state-webXxx') 在 DOM 空时透明 hit cache。
  //
  // 调用方:product / search page 的 content_script 应该在 document_idle 后立刻
  // 调一次 window.ensurePdpState() — 失败静默(网络不可达/非 product 页都正常)。
  // 不阻塞用户操作:fire-and-forget。
  //
  // force=true 时跳过缓存重新拉(用于 SPA 软导航后强制刷新)
  window.ensurePdpState = function(opts = {}) {
    const url = window.location.href;
    const now = Date.now();
    // 只在 product 页有效,其他页(category/search/index)跳过
    if (!/\/product\//.test(url)) return Promise.resolve(null);
    if (
      !opts.force &&
      _jzPdpStateCache &&
      _jzPdpStateCache.url === url &&
      _jzPdpStateCache.expiresAt > now
    ) {
      return Promise.resolve(_jzPdpStateCache.widgetStates);
    }
    if (_jzPdpStateFetchPromise && _jzPdpStateFetchPromise._url === url) {
      return _jzPdpStateFetchPromise;
    }
    const fetchPromise = (async () => {
      try {
        // sendMessage 成功时 resolve(response.data),SW 返回 { ok:true, data:{ fields, widgetStates }}
        // 所以这里 resp 直接是 { fields, widgetStates }(去掉 ok 包装)。
        // 失败走 catch 分支,无需 resp?.ok 检查。
        const resp = await window.sendMessage('fetchProductPageState', { url });
        if (resp?.widgetStates) {
          _jzPdpStateCache = {
            url,
            expiresAt: Date.now() + 60_000,
            widgetStates: resp.widgetStates,
          };
          // 旧 STATE_CACHE + KEY_CACHE 跨 ensurePdpState 调用都要清掉,避免命中
          // stale DOM 解析结果。KEY_CACHE 是 findStateDataByKeys 用的另一个独立缓存,
          // 之前漏清会让 SPA 切商品 A→B 时 sku 来自 B 但 title/seller 来自 A 的
          // payload 错乱 (Codex round 13 P2 #7)。
          for (const k of Object.keys(STATE_CACHE)) delete STATE_CACHE[k];
          for (const k of Object.keys(KEY_CACHE)) delete KEY_CACHE[k];
          return resp.widgetStates;
        }
        return null;
      } catch {
        return null;
      } finally {
        // 只在自己仍是当前 in-flight 时才清。否则在 A→B 跨 URL 切换场景下
        // (A 旧 fetch finally 把 B 新 fetch 也清成 null),并发去重失效,
        // 后续 B 的 ensurePdpState 调用会重新发请求。codex review #1。
        if (_jzPdpStateFetchPromise === fetchPromise) {
          _jzPdpStateFetchPromise = null;
        }
      }
    })();
    fetchPromise._url = url;
    _jzPdpStateFetchPromise = fetchPromise;
    return fetchPromise;
  };

  // SPA URL 切换时(history.pushState / popstate)清缓存 — 防止 product A → product B
  // 时 product B 的 extractStateData 还命中 product A 的缓存。
  (function setupPdpStateInvalidation() {
    let lastUrl = window.location.href;
    const invalidateOnChange = () => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        _jzPdpStateCache = null;
        _jzPdpStateFetchPromise = null;
        for (const k of Object.keys(STATE_CACHE)) delete STATE_CACHE[k];
        // KEY_CACHE 同清(Codex round 13 P2 #7)— SPA 切商品时 findStateDataByKeys
        // 命中的旧条目会让新页面拿到上一商品的 title/seller/images。
        for (const k of Object.keys(KEY_CACHE)) delete KEY_CACHE[k];
      }
    };
    window.addEventListener('popstate', invalidateOnChange);
    const origPush = history.pushState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      invalidateOnChange();
    };
    const origReplace = history.replaceState;
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      invalidateOnChange();
    };
  })();

  // New format: search data-state attribute values (JSON) for objects containing all required keys
  window.findStateDataByKeys = function(requiredKeys) {
    const cacheKey = requiredKeys.sort().join('|');
    if (KEY_CACHE[cacheKey]) {
      return KEY_CACHE[cacheKey];
    }
    const elements = document.querySelectorAll('[data-state]');
    for (const el of elements) {
      try {
        const raw = el.getAttribute('data-state');
        if (!raw || raw.length < 10) continue;
        const data = JSON.parse(raw);
        if (data && typeof data === 'object' && !Array.isArray(data)
            && requiredKeys.every(k => k in data)) {
          KEY_CACHE[cacheKey] = data;
          return data;
        }
      } catch {}
    }
    return null;
  };

  // Normalize price values to numbers
  window.normalizePrice = function(value) {
    if (typeof value === 'number') {
      return value;
    }
    if (!value) {
      return 0;
    }
    if (typeof value === 'string') {
      const numeric = value.replace(/[^0-9.,]/g, '').replace(',', '.');
      const parsed = parseFloat(numeric);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  };

  function _jzVisibleText(node) {
    return String(node?.innerText || node?.textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  // 面板占位文案:'-'(加载中)/'—'/'暂无数据'(接口返回后仍无数据)都视为空。
  const _JZ_PANEL_EMPTY_TEXTS = new Set(['-', '—', '\u2014', '暂无数据']);
  window.jzIsPanelEmptyText = (t) => _JZ_PANEL_EMPTY_TEXTS.has(String(t ?? '').trim());

  function _jzFirstFilled(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '' && !window.jzIsPanelEmptyText(value)) return value;
    }
    return null;
  }

  function _jzNumberFromPanelText(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value || '').replace(/\u00a0/g, ' ').trim();
    if (!text || window.jzIsPanelEmptyText(text)) return null;
    const match = text.replace(/\s+/g, '').match(/[-+]?\d+(?:[,.]\d+)?/);
    if (!match) return null;
    const num = Number(match[0].replace(',', '.'));
    if (!Number.isFinite(num)) return null;
    if (/万/.test(text)) return num * 10000;
    return num;
  }

  function _jzPercentFromPanelText(value) {
    const num = _jzNumberFromPanelText(value);
    return num === null ? null : num;
  }

  function _jzCnyFromMoneyText(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value || '').replace(/\u00a0/g, ' ').trim();
    if (!text || window.jzIsPanelEmptyText(text)) return null;
    const cnyMatch = text.replace(/\s+/g, '').match(/[\u00A5\uFFE5]\s*([-+]?\d+(?:[,.]\d+)?)/);
    if (cnyMatch) {
      const cny = Number(cnyMatch[1].replace(',', '.'));
      return Number.isFinite(cny) ? cny : null;
    }
    return null;
  }

  function _jzDetectOzonMoneyCurrency(value) {
    if (value && typeof value === 'object') {
      const direct = value.currency_code ?? value.currencyCode ?? value.currency ?? value.price_currency ?? value.priceCurrency;
      if (direct) return String(direct).trim().toUpperCase();
      const nested = value.price ?? value.value ?? value.amount ?? value.text ?? value.marketingPrice ?? value.marketing_price ?? '';
      if (nested === value) return null;
      return _jzDetectOzonMoneyCurrency(nested);
    }
    const text = String(value || '').toUpperCase();
    if (!text) return null;
    if (/[\u20BD₽]/.test(text) || /\bRUB\b|\bRUR\b/.test(text) || /РУБ/i.test(text)) return 'RUB';
    if (/[\u00A5\uFFE5¥￥]/.test(text) || /\bCNY\b|\bRMB\b/.test(text) || /人民币|元/.test(text)) return 'CNY';
    return null;
  }

  function _jzCurrencyFromMoneyText(value) {
    return _jzDetectOzonMoneyCurrency(value);
  }

  function _jzMoneyObjectValue(value) {
    if (value && typeof value === 'object') {
      const units = _jzNumberFromPanelText(value.units);
      const nanos = Number(value.nanos);
      if (units !== null && Number.isFinite(nanos) && nanos !== 0) return units + (nanos / 1e9);
      if (units !== null) return units;
      const nestedValue = _jzFirstFilled(
        value.amount,
        value.value,
        value.price,
        value.marketing_price,
        value.marketingPrice,
      );
      return nestedValue && typeof nestedValue === 'object'
        ? _jzMoneyObjectValue(nestedValue)
        : nestedValue;
    }
    return value;
  }

  function _jzMoneyObjectCurrency(value) {
    if (value && typeof value === 'object') {
      const direct = _jzFirstFilled(
        value.currency_code,
        value.currencyCode,
        value.currency,
        value.price_currency,
        value.priceCurrency,
      );
      if (direct !== null) return direct;
      const nestedValue = _jzFirstFilled(value.price, value.marketing_price, value.marketingPrice);
      return nestedValue && typeof nestedValue === 'object'
        ? _jzMoneyObjectCurrency(nestedValue)
        : _jzCurrencyFromMoneyText(nestedValue);
    }
    return _jzCurrencyFromMoneyText(value);
  }

  function _jzProductIdFromUrl(url) {
    const text = String(url || '');
    const match = text.match(/\/product\/(?:[^/?#]+-)?(\d+)(?:[/?#]|$)/) || text.match(/[?&](?:sku|product_id|productId)=(\d+)/);
    return match ? match[1] : null;
  }

  function _jzVariantMatchFromData(data, info) {
    const variantResult = data?.preFetched?.variant || info?.preFetched?.variant || null;
    const value = variantResult?.status === 'fulfilled' ? variantResult.value : variantResult;
    const items = value?.items || value?.data?.items || [];
    if (!Array.isArray(items) || items.length === 0) return null;
    const sku = _jzFirstFilled(
      data?.sku,
      data?.productId,
      info?.sku,
      info?.productId,
      _jzProductIdFromUrl(info?.url),
    );
    return items.find((it) => String(it.variant_id) === String(sku)) || items[0] || null;
  }

  function _jzMarketingPriceInfo(data, info) {
    const variantMatch = _jzVariantMatchFromData(data, info);
    const partMarketingPrice = _jzFirstFilled(
      variantMatch?.part_marketing_price,
      variantMatch?.partMarketingPrice,
      data?.part_marketing_price,
      data?.partMarketingPrice,
    );
    const partPrice = partMarketingPrice && typeof partMarketingPrice === 'object'
      ? _jzFirstFilled(
          partMarketingPrice.price,
          partMarketingPrice.marketing_price,
          partMarketingPrice.marketingPrice,
          partMarketingPrice.value,
        )
      : null;
    const directCny = _jzNumberFromPanelText(_jzFirstFilled(
      info?.marketingPriceCny,
      info?.marketing_price_cny,
      info?.blackPriceCny,
      info?.black_price_cny,
      data?.marketingPriceCny,
      data?.marketing_price_cny,
      data?.blackPriceCny,
      data?.black_price_cny,
      variantMatch?.marketingPriceCny,
      variantMatch?.marketing_price_cny,
    ));
    const priceValue = _jzFirstFilled(
      info?.marketingPrice,
      info?.marketing_price,
      info?.blackPrice,
      info?.black_price,
      data?.marketingPrice,
      data?.marketing_price,
      data?.blackPrice,
      data?.black_price,
      variantMatch?.marketingPrice,
      variantMatch?.marketing_price,
      partPrice,
    );
    const currency = _jzFirstFilled(
      info?.marketingPriceCurrency,
      info?.marketing_price_currency,
      info?.blackPriceCurrency,
      info?.black_price_currency,
      data?.marketingPriceCurrency,
      data?.marketing_price_currency,
      data?.blackPriceCurrency,
      data?.black_price_currency,
      variantMatch?.marketingPriceCurrency,
      variantMatch?.marketing_price_currency,
      _jzMoneyObjectCurrency(priceValue),
      _jzMoneyObjectCurrency(partPrice),
      _jzMoneyObjectCurrency(partMarketingPrice),
      data?.priceCurrency,
      info?.priceCurrency,
    );
    return {
      value: _jzMoneyObjectValue(priceValue),
      currency,
      cny: directCny,
    };
  }

  function _jzPositiveOrNull(value) {
    const num = _jzNumberFromPanelText(value);
    return num > 0 ? num : null;
  }

  function _jzDaysFromPanelText(value) {
    const text = String(value || '').replace(/\u00a0/g, ' ').trim();
    if (!text || window.jzIsPanelEmptyText(text)) return null;
    const dayMatch = text.match(/(\d+)\s*(?:天|days?|дн)/i);
    if (dayMatch) return Number(dayMatch[1]);
    const dateMatch = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (dateMatch) {
      const time = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3])).getTime();
      if (!Number.isNaN(time)) {
        return Math.max(0, Math.floor((Date.now() - time) / 86400000));
      }
    }
    return _jzNumberFromPanelText(text);
  }

  function _jzPanelFieldText(panel, field) {
    if (!panel || !field) return '';
    const escaped = window.CSS?.escape ? window.CSS.escape(field) : String(field).replace(/"/g, '\\"');
    const node = panel.querySelector(`[data-field="${escaped}"]`);
    return _jzVisibleText(node);
  }

  function _jzPanelLabelText(panel, label) {
    if (!panel || !label) return '';
    const text = _jzVisibleText(panel);
    if (!text) return '';
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i] === label || lines[i] === `${label}:` || lines[i] === `${label}：`) {
        return lines[i + 1] || '';
      }
      if (lines[i].startsWith(`${label} `) || lines[i].startsWith(`${label}:`) || lines[i].startsWith(`${label}：`)) {
        return lines[i].replace(label, '').replace(/^[:：\s]+/, '').trim();
      }
    }
    return '';
  }

  function _jzPanelValue(panel, fields = [], labels = []) {
    for (const field of fields) {
      const text = _jzPanelFieldText(panel, field);
      if (text) return text;
    }
    for (const label of labels) {
      const text = _jzPanelLabelText(panel, label);
      if (text) return text;
    }
    return '';
  }

  window.jzExtractPanelFilterData = function(panel, info = {}, baseData = {}) {
    const out = { ...(baseData || {}) };
    const set = (key, value) => {
      if (value !== undefined && value !== null && value !== '' && !window.jzIsPanelEmptyText(value)) out[key] = value;
    };
    const setNum = (key, value, parser = _jzNumberFromPanelText) => {
      const num = parser(value);
      if (num !== null) out[key] = num;
    };

    const infoPrice = _jzPositiveOrNull(info?.price);
    const basePrice = _jzPositiveOrNull(baseData?.price);
    const priceSource = infoPrice !== null
      ? {
          value: infoPrice,
          currency: _jzFirstFilled(info?.priceCurrency, _jzCurrencyFromMoneyText(info?.price)),
        }
      : basePrice !== null
        ? {
            value: basePrice,
            currency: _jzFirstFilled(
              baseData?.priceCurrency,
              baseData?.currency,
              baseData?.currencyCode,
              baseData?.currency_code,
              _jzCurrencyFromMoneyText(baseData?.price)
            ),
          }
        : null;
    if (priceSource) {
      setNum('price', priceSource.value);
      set('priceCurrency', priceSource.currency);
    }
    const marketingPriceInfo = _jzMarketingPriceInfo(baseData || {}, info || {});
    set('marketingPrice', marketingPriceInfo.value);
    set('marketingPriceCurrency', marketingPriceInfo.currency);
    if (marketingPriceInfo.cny !== null) out.marketingPriceCny = marketingPriceInfo.cny;
    setNum('soldCount', _jzFirstFilled(
      baseData?.soldCount,
      baseData?.sales30d,
      _jzPanelValue(panel, ['sales30d', 'soldCount'], ['月销量', '周销量'])
    ));
    const gmvValue = _jzFirstFilled(
      baseData?.gmvSum,
      baseData?.revenue30dRub,
      baseData?.revenue30d,
      _jzPanelValue(panel, ['revenue30d', 'revenue30dRub', 'gmvSum'], ['月销售额', '周销售额'])
    );
    setNum('gmvSum', gmvValue);
    setNum('gmvSumCny', _jzFirstFilled(
      baseData?.gmvSumCny,
      baseData?.revenue30dCny,
      _jzPanelValue(panel, ['revenue30d', 'revenue30dCny'], [])
    ), _jzCnyFromMoneyText);
    set('brandName', _jzFirstFilled(
      baseData?.brandName,
      baseData?.brand,
      _jzPanelValue(panel, ['brandName', 'brand'], ['品牌'])
    ));
    set('shippingMode', _jzFirstFilled(
      baseData?.shippingMode,
      baseData?.salesSchema,
      baseData?.marketSalesSchema,
      _jzPanelValue(panel, ['salesSchema', 'marketSalesSchema'], ['发货模式'])
    ));
    setNum('weight', _jzFirstFilled(
      baseData?.weight,
      baseData?.weightG,
      baseData?.weightGrams,
      _jzPanelValue(panel, ['weight', 'weightG', 'weightGrams'], ['重量'])
    ));
    setNum('listedDays', _jzFirstFilled(
      baseData?.listedDays,
      baseData?.daysOnline,
      baseData?.createDate,
      _jzPanelValue(panel, ['createDate', 'listedDays', 'daysOnline'], ['上架时间'])
    ), _jzDaysFromPanelText);
    setNum('monthlyTurnoverDynamic', _jzFirstFilled(
      baseData?.monthlyTurnoverDynamic,
      baseData?.turnoverDynamic,
      baseData?.salesDynamics,
      _jzPanelValue(panel, ['salesDynamics', 'monthlyTurnoverDynamic'], ['月周转动态', '周周转动态'])
    ), _jzPercentFromPanelText);
    setNum('adCostRatio', _jzFirstFilled(
      baseData?.adCostRatio,
      baseData?.adCostPercent,
      baseData?.drr,
      _jzPanelValue(panel, ['drr', 'adCostRatio', 'adCostPercent'], ['广告费占比'])
    ), _jzPercentFromPanelText);
    setNum('promoDays', _jzFirstFilled(baseData?.promoDays, baseData?.daysInPromo, _jzPanelValue(panel, ['daysInPromo', 'promoDays'], ['促销天数'])));
    setNum('promoDiscount', _jzFirstFilled(baseData?.promoDiscount, baseData?.discount, _jzPanelValue(panel, ['discount', 'promoDiscount'], ['促销折扣'])), _jzPercentFromPanelText);
    setNum('promoConversionRate', _jzFirstFilled(baseData?.promoConversionRate, baseData?.promoRevenueShare, baseData?.promoConvRate, _jzPanelValue(panel, ['promoConvRate', 'promoRevenueShare', 'promoConversionRate'], ['促销转化率'])), _jzPercentFromPanelText);
    setNum('paidPromotionDays', _jzFirstFilled(baseData?.paidPromotionDays, baseData?.daysWithTrafarets, baseData?.daysWithAds, _jzPanelValue(panel, ['daysWithAds', 'daysWithTrafarets', 'paidPromotionDays'], ['推广天数', '付费推广天数'])));
    setNum('views', _jzFirstFilled(baseData?.views, baseData?.qtyViewPdp, baseData?.sessionCount, baseData?.pdpViews, _jzPanelValue(panel, ['pdpViews', 'qtyViewPdp', 'views', 'sessionCount'], ['卡片浏览'])));
    setNum('cardAddToCartRate', _jzFirstFilled(baseData?.cardAddToCartRate, baseData?.pdpToCartConversion, baseData?.convToCartPdp, baseData?.pdpCartRate, _jzPanelValue(panel, ['pdpCartRate', 'convToCartPdp', 'pdpToCartConversion', 'cardAddToCartRate'], ['卡片加购率'])), _jzPercentFromPanelText);
    setNum('searchCatalogViews', _jzFirstFilled(baseData?.searchCatalogViews, baseData?.sessionCountSearch, baseData?.searchViews, _jzPanelValue(panel, ['searchViews', 'sessionCountSearch', 'searchCatalogViews'], ['搜索浏览', '搜索目录浏览量'])));
    setNum('searchCatalogAddToCartRate', _jzFirstFilled(baseData?.searchCatalogAddToCartRate, baseData?.convToCartSearch, baseData?.searchCartRate, _jzPanelValue(panel, ['searchCartRate', 'convToCartSearch', 'searchCatalogAddToCartRate'], ['搜索加购率', '搜索目录加购率'])), _jzPercentFromPanelText);
    setNum('displayConversionRate', _jzFirstFilled(baseData?.displayConversionRate, baseData?.convViewToOrder, _jzPanelValue(panel, ['convViewToOrder', 'displayConversionRate'], ['展示转化率'])), _jzPercentFromPanelText);
    setNum('returnCancelRate', _jzFirstFilled(baseData?.returnCancelRate, baseData?.returnRate, _jzPanelValue(panel, ['returnRate', 'returnCancelRate'], ['退货率', '退款取消率'])), _jzPercentFromPanelText);
    setNum('followerCount', _jzFirstFilled(baseData?.followerCount, baseData?.followSellCount, baseData?.heroFollow, _jzPanelValue(panel, ['heroFollow', 'followSellCount', 'followerCount'], ['跟卖'])));
    setNum('lowestFollowerPrice', _jzFirstFilled(baseData?.lowestFollowerPrice, baseData?.followSellMinPrice, baseData?.followMinPrice, _jzPanelValue(panel, ['followMinPrice', 'followSellMinPrice', 'lowestFollowerPrice'], ['跟卖最低价'])));
    const overridePanelText = (key, fields, labels) => {
      const value = _jzPanelValue(panel, fields, labels);
      if (value) set(key, value);
    };
    const overridePanelNum = (key, fields, labels, parser = _jzNumberFromPanelText) => {
      const value = _jzPanelValue(panel, fields, labels);
      if (value) setNum(key, value, parser);
    };
    overridePanelNum('soldCount', ['sales30d', 'soldCount'], ['月销量', '周销量']);
    overridePanelNum('gmvSum', ['revenue30d', 'revenue30dRub', 'gmvSum'], ['月销售额', '周销售额']);
    overridePanelText('brandName', ['brandName', 'brand'], ['品牌']);
    overridePanelText('shippingMode', ['salesSchema', 'marketSalesSchema'], ['发货模式']);
    overridePanelNum('weight', ['weight', 'weightG', 'weightGrams'], ['重量']);
    overridePanelNum('listedDays', ['createDate', 'listedDays', 'daysOnline'], ['上架时间'], _jzDaysFromPanelText);
    overridePanelNum('monthlyTurnoverDynamic', ['salesDynamics', 'monthlyTurnoverDynamic'], ['月周转动态', '周周转动态'], _jzPercentFromPanelText);
    overridePanelNum('adCostRatio', ['drr', 'adCostRatio', 'adCostPercent'], ['广告费占比'], _jzPercentFromPanelText);
    overridePanelNum('promoDays', ['daysInPromo', 'promoDays'], ['促销天数']);
    overridePanelNum('promoDiscount', ['discount', 'promoDiscount'], ['促销折扣'], _jzPercentFromPanelText);
    overridePanelNum('promoConversionRate', ['promoConvRate', 'promoRevenueShare', 'promoConversionRate'], ['促销转化率'], _jzPercentFromPanelText);
    overridePanelNum('paidPromotionDays', ['daysWithAds', 'daysWithTrafarets', 'paidPromotionDays'], ['推广天数', '付费推广天数']);
    overridePanelNum('views', ['pdpViews', 'qtyViewPdp', 'views', 'sessionCount'], ['卡片浏览']);
    overridePanelNum('cardAddToCartRate', ['pdpCartRate', 'convToCartPdp', 'pdpToCartConversion', 'cardAddToCartRate'], ['卡片加购率'], _jzPercentFromPanelText);
    overridePanelNum('searchCatalogViews', ['searchViews', 'sessionCountSearch', 'searchCatalogViews'], ['搜索浏览', '搜索目录浏览量']);
    overridePanelNum('searchCatalogAddToCartRate', ['searchCartRate', 'convToCartSearch', 'searchCatalogAddToCartRate'], ['搜索加购率', '搜索目录加购率'], _jzPercentFromPanelText);
    overridePanelNum('displayConversionRate', ['convViewToOrder', 'displayConversionRate'], ['展示转化率'], _jzPercentFromPanelText);
    overridePanelNum('returnCancelRate', ['returnRate', 'returnCancelRate'], ['退货率', '退款取消率'], _jzPercentFromPanelText);
    overridePanelNum('followerCount', ['heroFollow', 'followSellCount', 'followerCount'], ['跟卖']);
    overridePanelNum('lowestFollowerPrice', ['followMinPrice', 'followSellMinPrice', 'lowestFollowerPrice'], ['跟卖最低价']);
    return out;
  };

  // Format numbers with locale-specific formatting
  window.formatNumber = function(value, fraction = 0) {
    const normalized = typeof value === 'number' ? value : window.normalizePrice(value);
    return normalized.toLocaleString('ru-RU', {
      minimumFractionDigits: fraction,
      maximumFractionDigits: fraction,
    });
  };

  window.jzReturnRateFromRedemption = function(value) {
    const redemption = Number(value);
    if (!Number.isFinite(redemption) || redemption < 0 || redemption > 100) return null;
    return 100 - redemption;
  };

  window.jzFormatRating = function(rating, reviewCount) {
    const value = Number(rating);
    if (!Number.isFinite(value)) return null;
    const reviews = Number(reviewCount);
    return `${value.toFixed(1)}${Number.isFinite(reviews) && reviews > 0
      ? ` (${window.formatNumber(reviews)})`
      : ''}`;
  };

  // Global singleton tooltip for [data-oh-tip] elements.
  // Uses position: fixed + document.body append so it escapes any overflow:hidden ancestor.
  (function() {
    let _ohTip = null;
    const ensureTip = () => {
      if (_ohTip && document.body && document.body.contains(_ohTip)) return _ohTip;
      _ohTip = document.createElement('div');
      _ohTip.className = 'ozon-helper-global-tip';
      _ohTip.setAttribute('lang', 'zh-Hans');
      (document.body || document.documentElement).appendChild(_ohTip);
      return _ohTip;
    };

    const showTip = (target) => {
      const text = target.getAttribute('data-oh-tip');
      if (!text) return;
      const tip = ensureTip();
      tip.textContent = text;
      tip.classList.add('is-visible');
      const rect = target.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      let top = rect.top - tipRect.height - 8;
      let left = rect.left + (rect.width - tipRect.width) / 2;
      if (top < 8) top = rect.bottom + 8;
      if (left < 8) left = 8;
      if (left + tipRect.width > window.innerWidth - 8) {
        left = window.innerWidth - tipRect.width - 8;
      }
      tip.style.top = top + 'px';
      tip.style.left = left + 'px';
    };

    const hideTip = () => {
      if (_ohTip) _ohTip.classList.remove('is-visible');
    };

    document.addEventListener('mouseover', (e) => {
      const t = e.target && e.target.closest && e.target.closest('[data-oh-tip]');
      if (t) showTip(t);
    });
    document.addEventListener('mouseout', (e) => {
      const t = e.target && e.target.closest && e.target.closest('[data-oh-tip]');
      if (!t) return;
      if (e.relatedTarget && t.contains(e.relatedTarget)) return;
      hideTip();
    });
    document.addEventListener('scroll', hideTip, true);
  })();

  // === 图片悬浮放大预览 (jz image zoom) ===
  // 任意带 data-oh-zoom 的元素(通常是缩略图 <img>)悬浮时,在视口里浮出一张大图。
  // 委托式单监听,与上面的 tooltip 同构 —— 其他地方只要给缩略图加 data-oh-zoom 即可复用。
  // data-oh-zoom 的值是大图 URL(留空则回退到元素自身/内层 <img> 的 src);
  // 命中 ir.ozone.ru 的 URL 会把 /wcNN/ 尺寸段升到 /wc1000/,保证放大后清晰。
  (function () {
    let _zoomEl = null;
    let _zoomImg = null;
    const upscaleOzon = (u) =>
      typeof u === 'string' && u.includes('ir.ozone.ru')
        ? u.replace(/\/wc\d+\//, '/wc1000/')
        : u;
    const ensureZoom = () => {
      if (_zoomEl && document.body && document.body.contains(_zoomEl)) return _zoomEl;
      if (!document.getElementById('oh-img-zoom-style')) {
        const st = document.createElement('style');
        st.id = 'oh-img-zoom-style';
        st.textContent =
          '.oh-img-zoom{position:fixed;z-index:2147483646;pointer-events:none;' +
          'background:#fff;padding:6px;border-radius:10px;border:1px solid rgba(0,0,0,.06);' +
          'box-shadow:0 8px 28px rgba(0,0,0,.22),0 2px 8px rgba(0,0,0,.12);' +
          'opacity:0;visibility:hidden;transform:scale(.96);' +
          'transition:opacity .12s ease,transform .12s ease}' +
          '.oh-img-zoom.is-visible{opacity:1;visibility:visible;transform:scale(1)}' +
          '.oh-img-zoom img{display:block;width:auto;height:auto;' +
          'max-width:min(440px,44vw);max-height:74vh;border-radius:6px;' +
          'object-fit:contain;background:#f5f5f5}' +
          '[data-oh-zoom]{cursor:zoom-in}';
        (document.head || document.documentElement).appendChild(st);
      }
      _zoomEl = document.createElement('div');
      _zoomEl.className = 'oh-img-zoom';
      _zoomImg = document.createElement('img');
      _zoomImg.referrerPolicy = 'no-referrer';
      _zoomEl.appendChild(_zoomImg);
      (document.body || document.documentElement).appendChild(_zoomEl);
      return _zoomEl;
    };
    const resolveSrc = (target) => {
      let src = target.getAttribute('data-oh-zoom');
      if (!src) {
        if (target.tagName === 'IMG') src = target.getAttribute('src') || '';
        else {
          const inner = target.querySelector && target.querySelector('img');
          src = inner ? inner.getAttribute('src') || '' : '';
        }
      }
      return upscaleOzon(src);
    };
    const positionZoom = (target) => {
      if (!_zoomEl) return;
      const rect = target.getBoundingClientRect();
      const zr = _zoomEl.getBoundingClientRect();
      const gap = 12;
      // 优先放缩略图右侧,放不下放左侧,再放不下贴右边;纵向居中并夹在视口内。
      let left = rect.right + gap;
      if (left + zr.width > window.innerWidth - 8) left = rect.left - zr.width - gap;
      if (left < 8) left = Math.max(8, window.innerWidth - zr.width - 8);
      let top = rect.top + rect.height / 2 - zr.height / 2;
      if (top < 8) top = 8;
      if (top + zr.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - zr.height - 8);
      _zoomEl.style.left = left + 'px';
      _zoomEl.style.top = top + 'px';
    };
    const showZoom = (target) => {
      const src = resolveSrc(target);
      if (!src) return;
      ensureZoom();
      if (_zoomImg.getAttribute('src') !== src) _zoomImg.setAttribute('src', src);
      _zoomEl.classList.add('is-visible');
      positionZoom(target);
      // 大图未解码完时尺寸为 0,加载后再定位一次防偏。
      if (!_zoomImg.complete) _zoomImg.onload = () => positionZoom(target);
    };
    const hideZoom = () => { if (_zoomEl) _zoomEl.classList.remove('is-visible'); };
    document.addEventListener('mouseover', (e) => {
      const t = e.target && e.target.closest && e.target.closest('[data-oh-zoom]');
      if (t) showZoom(t);
    });
    document.addEventListener('mouseout', (e) => {
      const t = e.target && e.target.closest && e.target.closest('[data-oh-zoom]');
      if (!t) return;
      if (e.relatedTarget && t.contains(e.relatedTarget)) return;
      hideZoom();
    });
    document.addEventListener('scroll', hideZoom, true);
  })();

  // Check only the service worker's scoped collector-session status. The
  // credential itself stays owned by collector-session.js in storage.session
  // and is never returned to content scripts.
  window.checkAuth = function() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getAuth' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ loggedIn: false, account: null, permissions: [] });
          return;
        }
        if (!response?.ok) {
          resolve({ loggedIn: false, account: null, permissions: [] });
          return;
        }
        const { authenticated, account, permissions } = response.data || {};
        resolve({
          loggedIn: Boolean(authenticated),
          account: account || null,
          permissions: Array.isArray(permissions) ? permissions : [],
        });
      });
    });
  };

  // Show a floating login prompt when not logged in
  window.createLoginPrompt = function() {
    if (document.querySelector('.ozon-helper-login-prompt')) return;

    const prompt = document.createElement('div');
    prompt.className = 'ozon-helper-login-prompt';
    prompt.innerHTML = `
      <div class="ozon-helper-login-prompt-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
          <polyline points="10 17 15 12 10 7"/>
          <line x1="15" y1="12" x2="3" y2="12"/>
        </svg>
      </div>
      <span class="ozon-helper-login-prompt-text">登录${globalThis.__JZ_BRAND__.displayName}</span>
    `;

    const tooltip = document.createElement('div');
    tooltip.className = 'ozon-helper-login-tooltip';
    tooltip.textContent = `请点击浏览器工具栏中的 ${globalThis.__JZ_BRAND__.displayName} 图标登录`;

    let tooltipTimer = null;

    prompt.addEventListener('click', () => {
      // 首选:直接弹工具栏 popup(SW 调 chrome.action.openPopup(),Chrome 127+)。
      // 弹不出来(老 Chrome / 非活动窗口 / SW 异常)→ 跳 ERP 网页登录:
      // Web 登录页与扩展必须位于同一浏览器用户配置。登录后由一次性票据
      // 建立采集会话；网页也打不开时才落回 badge 闪烁 + 气泡指引。
      const fallbackHint = () => {
        chrome.runtime.sendMessage({ action: 'flashBadge' });
        tooltip.classList.add('is-visible');
        clearTimeout(tooltipTimer);
        tooltipTimer = setTimeout(() => tooltip.classList.remove('is-visible'), 4000);
      };
      const trySend = (action, params) => new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ action, ...params }, (resp) => {
            // 读一次 lastError 防 Unchecked runtime.lastError 噪音
            void chrome.runtime.lastError;
            resolve(!!(resp && resp.ok));
          });
        } catch {
          resolve(false);
        }
      });
      new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ action: 'openLoginPopup' }, (resp) => {
            void chrome.runtime.lastError;
            resolve(!!(resp && resp.ok && resp.data && resp.data.opened));
          });
        } catch {
          resolve(false);
        }
      }).then(async (opened) => {
        if (opened) return;
        const webOpened = await trySend('openFrontend', { path: '/login' });
        if (!webOpened) fallbackHint();
      });
    });

    document.body.appendChild(prompt);
    document.body.appendChild(tooltip);
  };

  // Send message to service worker with Promise wrapper
  window.sendMessage = function(action, params = {}) {
    // Default 60s timeout; long-running actions get more time
    // uploadFollowSellVideo:视频转存(download 跨源 .mp4 + media-storage 上传)executeScript
    // 内部可达 90s+,默认 60s 会让 content 侧先超时拿不到结果 → 放宽。
    // importFromPublic:公开页取数(fetchOzonWwwViaTab ≤15s)+ 后端服务端类目/属性解析
    // (apiRequest ≤120s),合计远超默认 60s → 放宽,避免已入队却被 content 侧误判超时报"提交失败"。
    const LONG_ACTIONS = ['followSell', 'importBySku', 'uploadFollowSellVideo', 'importFromPublic', 'followFromPublic'];
    const timeoutMs = LONG_ACTIONS.includes(action) ? 600000 : 60000;
    console.log(`[sendMessage] sending action=${action}`);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          console.error(`[sendMessage] TIMEOUT action=${action} after ${timeoutMs/1000}s`);
          reject(new Error(`sendMessage("${action}") 超时 (${timeoutMs / 1000}s)`));
        }
      }, timeoutMs);
      chrome.runtime.sendMessage({ action, ...params }, (response) => {
        clearTimeout(timer);
        if (settled) { console.warn(`[sendMessage] LATE response for action=${action} (already timed out)`); return; }
        settled = true;
        if (chrome.runtime.lastError) {
          console.error(`[sendMessage] lastError action=${action}:`, chrome.runtime.lastError.message);
          reject(chrome.runtime.lastError);
        } else if (response && response.ok) {
          console.log(`[sendMessage] OK action=${action}`);
          resolve(response.data);
        } else {
          // 同时打分类码 + 真实 message：SW 失败响应带了 {error: 分类码, message: 真实原因},
          // 之前只打 `error || message`(error 优先)→ 真实原因被 UNKNOWN_ERROR 等分类码盖住、
          // 排查得翻 SW 控制台。这里把两者都带上,页面错误面板直接看到根因。
          console.error(
            `[sendMessage] FAIL action=${action}: ${response?.error || 'UNKNOWN'}` +
              (response?.message && response.message !== response.error
                ? ` — ${response.message}`
                : ''),
          );
          reject(new Error(response?.message || response?.error || 'Unknown error'));
        }
      });
    });
  };

  // ─── 数据卡会员门控 ─────────────────────────
  // 数据卡(搜索页面板 + 详情页侧栏卡)为会员功能。渲染前调这里判断:
  // 后端 usage-summary 的 canUse.DATA_CARD === false(FREE 档)→ 锁定卡。
  // 页面级缓存一次(promise 复用),搜索页几十张卡只打一次 usage-summary。
  // fail-open:未登录/后端不可达/旧后端无该键 → 不拦,由后端 product-data 403 兜底。
  let _dataCardGatePromise = null;
  window.jzDataCardAllowed = function () {
    if (!_dataCardGatePromise) {
      _dataCardGatePromise = window.sendMessage('getMembershipSummary', {})
        .then((s) => {
          if (s && s.canUse && s.canUse.DATA_CARD === false) {
            return { allowed: false };
          }
          return { allowed: true };
        })
        .catch(() => ({ allowed: true }));
    }
    return _dataCardGatePromise;
  };

  // 锁定卡片正文(两类数据卡共用):蒙层文案 + 升级会员按钮。
  // container 是卡片 body 容器,调用方负责保留自己的卡头。
  window.jzRenderDataCardLocked = function (container) {
    container.innerHTML = `
      <div class="ozon-helper-datacard-locked" translate="no" style="padding:28px 16px;text-align:center;">
        <div style="font-size:26px;line-height:1;margin-bottom:10px;">🔒</div>
        <div style="font-size:13px;font-weight:600;color:#1f2733;margin-bottom:4px;">商品数据卡为会员功能</div>
        <div style="font-size:12px;color:#8a94a6;margin-bottom:14px;">开通会员后可查看月销量、销售额、佣金、流量转化等数据</div>
        <button data-action="datacard-upgrade" style="background:#005bff;color:#fff;border:none;border-radius:8px;padding:8px 22px;font-size:13px;font-weight:600;cursor:pointer;">升级会员</button>
      </div>`;
    container.querySelector('[data-action="datacard-upgrade"]')?.addEventListener('click', () => {
      window.sendMessage('openFrontend', { path: '/ozon/settings/membership' }).catch(() => {});
    });
  };

  // ─── 浏览器翻译态检测 helper ─────────────────────────
  // Chrome / Edge 翻译开启后会给 <html> 加 .translated-ltr / .translated-rtl class
  // 或修改 lang 属性。各处需要"翻译开了就退化为空，避免污染数据"的逻辑都用这个 helper。
  window.jzIsTranslated = function () {
    try {
      const html = document.documentElement;
      if (!html) return false;
      if (html.classList.contains('translated-ltr')) return true;
      if (html.classList.contains('translated-rtl')) return true;
      const lang = (html.lang || '').toLowerCase();
      // Ozon 原生 ru / en，翻译后通常变 zh / zh-CN / zh-Hans
      // 如果页面原生 zh 也认为是"翻译态"——这种情况 Ozon DOM 不会是俄/英，统一退化更安全
      if (lang && lang.startsWith('zh')) return true;
    } catch {}
    return false;
  };

  // ─── 防浏览器翻译污染极掌注入 UI ─────────────────────────
  // 用户可能开了 Chrome / Edge 翻译把页面翻成中文，会污染极掌的：
  //   - UI 文本（"商品信息 / 月销量 / 极掌 ERP" 等）
  //   - 用户后续从 DOM 读取的内容（采集器抓 textContent → 中文进库）
  //
  // 给所有极掌注入的 DOM 元素打 translate="no" 属性，浏览器翻译会跳过这些子树。
  // 选择器：所有以 ozon-helper-* / jzc-* / jz-c- 开头的 className，
  // 以及透视眼浮窗的固定 ID（jzc_premium_panel）。
  // 子元素继承祖先的 translate 属性，所以只需给根元素打就够了。
  const _OH_SELECTOR = '[class^="ozon-helper-"], [class^="jzc-"], [class^="jz-c-"], #jzc_premium_panel';
  const _setNoTranslate = (el) => {
    try {
      if (el && el.setAttribute && el.nodeType === 1 && !el.hasAttribute('translate')) {
        el.setAttribute('translate', 'no');
      }
    } catch {}
  };
  const _scanAndProtect = (root) => {
    try {
      if (!root || !root.querySelectorAll) return;
      if (root.matches?.(_OH_SELECTOR)) _setNoTranslate(root);
      root.querySelectorAll(_OH_SELECTOR).forEach(_setNoTranslate);
    } catch {}
  };
  const _initTranslateGuard = () => {
    if (window.__jzcTranslateGuardInstalled__) return;
    window.__jzcTranslateGuardInstalled__ = true;
    if (!document.body) return;
    // 立即扫一遍现有元素
    _scanAndProtect(document.body);
    // 监听后续注入的极掌元素
    try {
      new MutationObserver((mutations) => {
        for (const m of mutations) {
          m.addedNodes && m.addedNodes.forEach((node) => {
            if (node.nodeType === 1) _scanAndProtect(node);
          });
        }
      }).observe(document.body, { childList: true, subtree: true });
    } catch {}
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initTranslateGuard, { once: true });
  } else {
    _initTranslateGuard();
  }

  // ============================================================
  // jzRenderProductCardPanel — 商品卡数据面板共享渲染
  // 由 ozon-data-panel.js (首页/品牌/详情"也看了") 与 ozon-search.js
  // (搜索/类目) 共用,避免两份不同步的面板。
  // ============================================================
  const _ohEsc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const _ohSvg = (paths) =>
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

  const _OH_ICONS = {
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    barChart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
  };

  // ============================================================
  // 数据卡共享基建:一级类目中文化 / 体积 / 字段显隐设置
  //   PDP(ozon-product.js createSidebarDataCard)与列表/搜索卡
  //   (jzRenderProductCardPanel / jzRenderProductPanelV2)共用。
  // ============================================================

  // 一级类目中文化字典:Ozon ~30 个一级类目的「英文名 / 俄文名 → 中文」。
  // product-data 后端有时已返中文(categoryL1),有时透传 sv/data-v3 的英/俄原文,
  // 这里统一兜底成中文。拿不准的保留原文(不进字典即原样返回)。
  const JZ_L1_CN = {
    // 服装鞋包
    'Clothes': '服装', 'Одежда': '服装',
    'Shoes': '鞋靴', 'Обувь': '鞋靴',
    'Bags & Suitcases': '箱包', 'Сумки и чемоданы': '箱包',
    'Accessories': '配饰', 'Аксессуары': '配饰',
    'Haberdashery & Accessories': '服饰辅料', 'Галантерея и аксессуары': '服饰辅料', 'Галантерея': '服饰辅料',
    // 美妆个护 / 健康
    'Beauty & Health': '美妆个护', 'Beauty & Hygiene': '美妆个护', 'Красота и здоровье': '美妆个护',
    'Pharmacy': '药品', 'Аптека': '药品',
    // 电子数码
    'Electronics': '电子产品', 'Электроника': '电子产品',
    'Appliances': '家用电器', 'Бытовая техника': '家用电器',
    // 家居
    'Home & Garden': '家居园艺', 'House & Garden': '家居园艺', 'Дом и сад': '家居园艺',
    'Home & Interior': '家居家装', 'Дом и интерьер': '家居家装',
    'Furniture': '家具', 'Мебель': '家具',
    'Construction & Repair': '建材装修', 'Construction & Renovation': '建材装修', 'Строительство и ремонт': '建材装修', 'DIY & Tools': '五金工具',
    'Household Chemicals': '家庭日化', 'Бытовая химия': '家庭日化',
    // 母婴 / 玩具
    'Children\'s Goods': '母婴用品', 'Kids\' Goods': '母婴用品', 'Детские товары': '母婴用品',
    'Toys & Games': '玩具', 'Toys': '玩具', 'Игрушки': '玩具',
    // 食品
    'Food': '食品', 'Продукты питания': '食品', 'Grocery': '食品',
    'Pet Supplies': '宠物用品', 'Pet Products': '宠物用品', 'Товары для животных': '宠物用品', 'Зоотовары': '宠物用品',
    // 运动 / 户外
    'Sports & Recreation': '运动户外', 'Sports & Outdoor': '运动户外', 'Спорт и отдых': '运动户外',
    // 文娱
    'Books': '图书', 'Книги': '图书',
    'Stationery & Office': '文具办公', 'Stationery': '文具', 'Канцтовары': '文具办公',
    'Music & Video': '音像制品', 'Hobbies & Creativity': '手工创意', 'Hobbies & Creative Activities': '手工创意', 'Хобби и творчество': '手工创意',
    // 汽配 / 工业
    'Auto Products': '汽车用品', 'Automotive': '汽车用品', 'Автотовары': '汽车用品',
    'Industrial Equipment': '工业设备',
    // 珠宝 / 其它
    'Jewelry': '珠宝首饰', 'Ювелирные изделия': '珠宝首饰',
    'Antiques & Collectibles': '古董收藏', 'Антиквариат и коллекционирование': '古董收藏',
    'Gifts & Holiday': '礼品节庆', 'Wedding': '婚庆用品',
    'Adult Products': '成人用品', 'Товары для взрослых': '成人用品',
    'Digital Goods': '虚拟商品', 'Цифровые товары': '虚拟商品',
  };

  // 一级类目 id → 中文(全量 30 个 L1)。id 取自 Ozon 真实类目树,与佣金表 cat1Id /
  // 后端 ozon_category_market_snapshot.cat1Name 同命名空间;what_to_sell 的 category1Id 同此 id。
  // 数字稳定,永不随 Ozon 英文名漂移 —— 这是 L1 翻中文的首选路径(英文名字典只作兜底)。
  // 源:prod 桥接表 distinct cat1Id→cat1Name(2026-06-26 核对全 30 行)。
  const JZ_L1_CN_BY_ID = {
    '15621031': '服装', '15621032': '鞋靴', '15621042': '电子产品',
    '17027482': '建材装修', '17027483': '服务', '17027484': '成人用品',
    '17027485': '手工创意', '17027486': '家用电器', '17027487': '宠物用品',
    '17027488': '母婴用品', '17027489': '美妆个护', '17027490': '古董收藏',
    '17027491': '运动户外', '17027492': '文具办公', '17027493': '小百货配饰',
    '17027494': '家居园艺', '17027495': '汽车用品', '17027496': '食品',
    '17027915': '家具', '52265716': '药品', '75021418': '家庭日化',
    '76902590': '珠宝首饰', '88976462': '农产品', '92120918': '汽车摩托',
    '92130764': '乐器', '99999999': '影音游戏软件', '200001160': '慈善',
    '200001388': '生鲜食品', '200001482': '图书', '200001506': '烟具',
  };

  // id 优先(稳定、全覆盖);无 id 再按英文/俄文名字典兜底;已是中文原样返回。
  window.jzTranslateCategoryL1 = function (name, id) {
    if (id != null && id !== '' && JZ_L1_CN_BY_ID[String(id)]) return JZ_L1_CN_BY_ID[String(id)];
    if (name == null || name === '') return name;
    const s = String(name).trim();
    if (/[一-龥]/.test(s)) return s; // 已含中文,原样
    return JZ_L1_CN[s] || s;
  };

  // 体积(升):mm³ → 升(1L = 1e6 mm³)。任一维缺失返回 null。
  window.jzVolumeLiters = function (l, w, h) {
    return (l && w && h) ? +(l * w * h / 1e6).toFixed(2) : null;
  };

  // 通用 staggered queue 工厂:while + 同步预占 inFlight/lastLaunchAt,timer=null
  // 单一 settled 信号,task timeout 防 service-worker hang。
  // 由 ozon-search.js 下沉共享(v0.9.91 曾把 inFlight++ 写进 setTimeout 回调导致
  // concurrency 形同虚设,这份是修正后的唯一实现)—— ozon-search 与 ozon-data-panel
  // 的 variantsQueue/followSellQueue 都从这里造,防两份漂移。
  window.jzMakeStaggeredQueue = function ({ concurrency, staggerMs, taskTimeoutMs = 60000 }) {
    // concurrency/staggerMs 可经 setParams 运行时放宽:数据卡 searchVariants 在
    // fleet 服务端取数灰度命中时走后端(SW 侧有 6 并发闸兜底),内容脚本这层为
    // seller-tab 老路设计的 stagger 就成了纯拖慢,查到 flag 后调宽。
    let _concurrency = concurrency;
    let _staggerMs = staggerMs;
    let inFlight = 0;
    let lastLaunchAt = 0;
    const waiting = [];
    const pump = () => {
      while (inFlight < _concurrency && waiting.length > 0) {
        const next = waiting.shift();
        inFlight++;
        const sinceLast = Date.now() - lastLaunchAt;
        const wait = Math.max(0, _staggerMs - sinceLast);
        lastLaunchAt = Date.now() + wait;
        setTimeout(() => {
          let timer = setTimeout(() => {
            if (timer == null) return;
            timer = null;
            next.reject(new Error('queue task timeout'));
            inFlight--; pump();
          }, taskTimeoutMs);
          Promise.resolve()
            .then(next.task)
            .then(
              (v) => { if (timer == null) return; clearTimeout(timer); timer = null; next.resolve(v); inFlight--; pump(); },
              (e) => { if (timer == null) return; clearTimeout(timer); timer = null; next.reject(e); inFlight--; pump(); },
            );
        }, wait);
      }
    };
    return {
      add: (task) => new Promise((resolve, reject) => {
        waiting.push({ task, resolve, reject });
        pump();
      }),
      setParams: ({ concurrency: c, staggerMs: s } = {}) => {
        if (Number.isFinite(c) && c > 0) _concurrency = c;
        if (Number.isFinite(s) && s >= 0) _staggerMs = s;
        pump(); // 容量变大时立即补发排队中的任务
      },
    };
  };

  // sv 属性重量统一取值(克):4497(packaged g)优先;缺则 4383 —— 该属性是 kg 浮点,
  // 但历史数据里也混有克值,沿用 jzExtractCatalogFromSv 的启发式:<100 视为 kg→×1000。
  // 三个取数点(jzMergeCardPanelData / jzPopulatePanelV2 / PDP sv 路径)必须共用这里,
  // 否则轻货显示 "0.35g" 且经 reportSkuDims 把 kg 值回写污染 ozon_sku_dims。
  window.jzSvWeightG = function (attrMap) {
    const g = Number(attrMap?.get('4497')?.value);
    if (Number.isFinite(g) && g > 0) return Math.round(g);
    const raw = Number(attrMap?.get('4383')?.value);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw < 100 ? Math.round(raw * 1000) : Math.round(raw);
  };

  // 字段目录(按段分组):覆盖两套卡所有可显隐的 section 行字段。
  // hero 字段(sales30d/createDate/heroFollow/heroSize)不在此目录 —— hero 是
  // 核心选品指标,不参与显隐(单列、始终显示),与规格「hero 建议不可关」一致。
  window.JZ_DATACARD_FIELDS = [
    // 商品信息 / 销售表现
    { field: 'category', label: '一级类目', group: '商品信息' },
    { field: 'categoryL3', label: '三级类目', group: '商品信息' },
    { field: 'sku', label: 'SKU', group: '商品信息' },
    { field: 'brand', label: '品牌', group: '商品信息' },
    { field: 'salesSchema', label: '发货模式', group: '商品信息' },
    { field: 'commRfbs', label: 'rFBS佣金', group: '商品信息' },
    { field: 'commFbp', label: 'FBP佣金', group: '商品信息' },
    { field: 'revenue30d', label: '销售额', group: '商品信息' },
    { field: 'salesDynamics', label: '周转动态', group: '商品信息' },
    { field: 'dailySales', label: '日销量', group: '商品信息' },
    { field: 'dailyRevenue', label: '日销售额', group: '商品信息' },
    { field: 'drr', label: '广告费占比', group: '商品信息' },
    // 促销推广(仅 V2 / PDP 有)
    { field: 'daysInPromo', label: '促销天数', group: '促销推广' },
    { field: 'promoDiscount', label: '促销折扣', group: '促销推广' },
    { field: 'promoConvRate', label: '促销转化率', group: '促销推广' },
    { field: 'daysWithAds', label: '推广天数', group: '促销推广' },
    { field: 'discount', label: '折扣', group: '促销推广' },
    // 流量与转化
    { field: 'pdpViews', label: '卡片浏览', group: '流量转化' },
    { field: 'pdpCartRate', label: '卡片加购率', group: '流量转化' },
    { field: 'searchViews', label: '搜索浏览', group: '流量转化' },
    { field: 'searchCartRate', label: '搜索加购率', group: '流量转化' },
    { field: 'views', label: '展示量', group: '流量转化' },
    { field: 'convViewToOrder', label: '展示转化率', group: '流量转化' },
    { field: 'clickRate', label: '点击率', group: '流量转化' },
    // 物流与商品
    { field: 'returnRate', label: '退货率', group: '物流商品' },
    { field: 'rating', label: '评分', group: '物流商品' },
    { field: 'stock', label: '库存', group: '物流商品' },
    { field: 'dimensions', label: '长宽高', group: '物流商品' },
    { field: 'volume', label: '体积', group: '物流商品' },
    { field: 'weight', label: '重量', group: '物流商品' },
    // 跟卖信息(仅 PDP 有)
    { field: 'followMinPrice', label: '跟卖最低价', group: '跟卖信息' },
    { field: 'canFollow', label: '能否跟卖', group: '跟卖信息' },
  ];

  const _JZ_FIELDVIS_KEY = 'dataCardFieldVisibility';

  // 读字段显隐 map:{ [field]: bool }。缺省 {}(全显)。
  window.jzLoadFieldVisibility = function () {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([_JZ_FIELDVIS_KEY], (r) => {
          resolve((r && r[_JZ_FIELDVIS_KEY]) || {});
        });
      } catch {
        resolve({});
      }
    });
  };

  // 写字段显隐 map。
  window.jzSaveFieldVisibility = function (map) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [_JZ_FIELDVIS_KEY]: map || {} }, () => resolve());
      } catch {
        resolve();
      }
    });
  };

  // ── 数据卡销量周期(月 / 周)──────────────────────────────────
  // Ozon what_to_sell 支持 period:'monthly'(月,默认)/ 'weekly'(周)。2026-06 月接口已恢复,
  // 默认回月。用户可在字段设置弹窗切换;数据卡的销量/销售额/周转动态据此取数,标签随之「月/周」。
  const _JZ_SALESPERIOD_KEY = 'dataCardSalesPeriod';
  let _jzSalesPeriod = 'monthly'; // 同步缓存(渲染/取数处同步读),默认月
  try {
    chrome.storage.local.get([_JZ_SALESPERIOD_KEY], (r) => {
      const p = r && r[_JZ_SALESPERIOD_KEY];
      if (p === 'weekly' || p === 'monthly') _jzSalesPeriod = p;
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch[_JZ_SALESPERIOD_KEY]) {
        const p = ch[_JZ_SALESPERIOD_KEY].newValue;
        if (p === 'weekly' || p === 'monthly') _jzSalesPeriod = p;
      }
    });
  } catch {}
  window.jzGetSalesPeriod = () => _jzSalesPeriod; // 'monthly' | 'weekly'
  window.jzSalesPeriodCnShort = () => (_jzSalesPeriod === 'weekly' ? '周' : '月');
  window.jzSalesPeriodDays = () => (_jzSalesPeriod === 'weekly' ? 7 : 30);
  window.jzSalesPeriodCnLong = () => (_jzSalesPeriod === 'weekly' ? '近 7 天' : '近 30 天');
  window.jzSalesPeriodCnUnit = () => (_jzSalesPeriod === 'weekly' ? '近一周' : '近一个月');
  window.jzSalesPeriodCnPrev = () => (_jzSalesPeriod === 'weekly' ? '上一周' : '上一个月');
  window.jzSaveSalesPeriod = (p) => new Promise((res) => {
    const v = p === 'weekly' ? 'weekly' : 'monthly';
    try { chrome.storage.local.set({ [_JZ_SALESPERIOD_KEY]: v }, () => res(v)); } catch { res(v); }
  });

  // 应用显隐:visMap[field]===false 才隐藏(未列出 / true 都显示,向后兼容默认全显)。
  // 再逐 section 检查:若 body 内所有行都被隐藏则整段隐藏。
  window.jzApplyFieldVisibility = function (rootEl, visMap) {
    if (!rootEl) return;
    const map = visMap || {};
    rootEl.querySelectorAll('[data-field]').forEach((el) => {
      const f = el.getAttribute('data-field');
      // data-field 可能落在「行/卡容器」上(列表卡 _ohRenderRow、hero _ohHeroStat)
      // 或「value 子元素」上(详情/搜索卡 _v2RenderRow / _v2RenderHeroStat,label 是兄弟节点)。
      // 后者只隐 value 会留下孤儿 label(关掉 FBP佣金 值没了标题还在),故统一上溯到行/卡容器再隐。
      const target = el.closest('.ozon-helper-sidebar-card-row, .oh-hero-stat') || el;
      target.style.display = map[f] === false ? 'none' : '';
    });
    rootEl.querySelectorAll('.ozon-helper-sidebar-section').forEach((section) => {
      const body = section.querySelector('.ozon-helper-sidebar-section-body');
      if (!body) return;
      const rows = body.querySelectorAll('.ozon-helper-sidebar-card-row');
      if (!rows.length) return;
      // 显隐统一作用在行容器上(见上),直接看行自身 display 即可。
      const allHidden = Array.from(rows).every((row) => row.style.display === 'none');
      section.style.display = allHidden ? 'none' : '';
    });
  };

  // 把显隐设置应用到页面上所有已渲染的数据卡。
  window.jzApplyFieldVisibilityToAll = function (visMap) {
    document
      .querySelectorAll('.ozon-helper-sidebar-card, [data-jz-datacard]')
      .forEach((card) => window.jzApplyFieldVisibility(card, visMap));
  };

  // 字段设置弹窗:按 group 列出 checkbox,保存时写 storage + 刷新所有数据卡。
  // anchorRootEl 仅用于触发上下文,设置对全站数据卡生效。
  window.jzOpenFieldSettings = function () {
    // 已开则不重复
    if (document.querySelector('.jz-fieldset-mask')) return;

    window.jzLoadFieldVisibility().then((visMap) => {
      const map = visMap || {};

      const mask = document.createElement('div');
      mask.className = 'jz-fieldset-mask';
      mask.setAttribute('lang', 'zh-Hans');
      mask.setAttribute('translate', 'no');

      const modal = document.createElement('div');
      modal.className = 'jz-fieldset-modal';
      modal.setAttribute('translate', 'no');

      // 按 group 分组
      const groups = [];
      const byGroup = new Map();
      for (const f of window.JZ_DATACARD_FIELDS) {
        if (!byGroup.has(f.group)) {
          byGroup.set(f.group, []);
          groups.push(f.group);
        }
        byGroup.get(f.group).push(f);
      }

      const gearIcon = window.lucideIcon ? window.lucideIcon('settings', 16) : '';
      // 数据周期(月/周)单选 —— 放在字段列表最上方
      const _curPeriod = window.jzGetSalesPeriod ? window.jzGetSalesPeriod() : 'monthly';
      const periodHtml = `<div class="jz-fieldset-group">
          <div class="jz-fieldset-group-title">数据周期</div>
          <div class="jz-fieldset-grid">
            <label class="jz-fieldset-item">
              <input type="radio" name="jz-sales-period" value="monthly" ${_curPeriod === 'monthly' ? 'checked' : ''} />
              <span>月销量(近 30 天)</span>
            </label>
            <label class="jz-fieldset-item">
              <input type="radio" name="jz-sales-period" value="weekly" ${_curPeriod === 'weekly' ? 'checked' : ''} />
              <span>周销量(近 7 天)</span>
            </label>
          </div>
        </div>`;
      let bodyHtml = '';
      for (const g of groups) {
        const items = byGroup.get(g).map((f) => {
          const checked = map[f.field] === false ? '' : 'checked';
          return `<label class="jz-fieldset-item">
            <input type="checkbox" data-jz-field="${_ohEsc(f.field)}" ${checked} />
            <span>${_ohEsc(f.label)}</span>
          </label>`;
        }).join('');
        bodyHtml += `<div class="jz-fieldset-group">
          <div class="jz-fieldset-group-title">${_ohEsc(g)}</div>
          <div class="jz-fieldset-grid">${items}</div>
        </div>`;
      }

      modal.innerHTML = `
        <div class="jz-fieldset-header">
          <span class="jz-fieldset-title"><span class="jz-fieldset-title-icon">${gearIcon}</span>数据卡字段设置</span>
          <button class="jz-fieldset-close" data-jz-act="cancel" title="关闭">&times;</button>
        </div>
        <div class="jz-fieldset-note">关闭的字段在所有数据卡生效(店铺详情页 / 搜索 / 列表)</div>
        <div class="jz-fieldset-body">${periodHtml}${bodyHtml}</div>
        <div class="jz-fieldset-footer">
          <button class="jz-fieldset-btn" data-jz-act="cancel">取消</button>
          <button class="jz-fieldset-btn is-primary" data-jz-act="save">保存</button>
        </div>`;

      mask.appendChild(modal);
      document.body.appendChild(mask);

      const close = () => mask.remove();

      // modal 内点击:先阻止冒泡到 Ozon 页面 / 卡片 click 委托,再处理按钮动作。
      // (此前把动作处理挂在 mask 委托上,又给 modal 加了 stopPropagation 监听 →
      //  modal 内按钮点击被 stopPropagation 拦在 mask 委托之前 → 取消/保存/关闭全失效。
      //  改为在 modal 自身上既 stopPropagation 又处理动作。)
      modal.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = e.target.closest('[data-jz-act]')?.getAttribute('data-jz-act');
        if (!act) return;
        e.preventDefault();
        if (act === 'cancel') { close(); return; }
        if (act === 'save') {
          const next = {};
          modal.querySelectorAll('input[data-jz-field]').forEach((cb) => {
            // 只持久化「关闭」项(false);默认全显,map 越小越好、向后兼容
            if (!cb.checked) next[cb.getAttribute('data-jz-field')] = false;
          });
          // 数据周期:切换需重新取数(getMarketStats 的 period 变 + 标签月/周),保存后若变化则刷新本页。
          const selPeriod = modal.querySelector('input[name="jz-sales-period"]:checked')?.value === 'weekly' ? 'weekly' : 'monthly';
          const periodChanged = selPeriod !== (window.jzGetSalesPeriod ? window.jzGetSalesPeriod() : 'monthly');
          Promise.all([
            window.jzSaveFieldVisibility(next),
            window.jzSaveSalesPeriod ? window.jzSaveSalesPeriod(selPeriod) : Promise.resolve(),
          ]).then(() => {
            window.jzApplyFieldVisibilityToAll(next);
            if (periodChanged) { try { location.reload(); } catch {} }
          });
          close();
        }
      });
      // 点遮罩空白处(modal 之外)关闭。
      mask.addEventListener('click', (e) => {
        if (e.target === mask) { e.preventDefault(); e.stopPropagation(); close(); }
      });
    });
  };

  // 齿轮按钮 HTML(header 用,logo 之后 / close 之前)。
  window.jzFieldSettingsGearHtml = function () {
    const icon = window.lucideIcon ? window.lucideIcon('settings', 14) : '';
    return `<button class="ozon-helper-sidebar-card-gear" data-action="open-field-settings" title="字段设置">${icon}</button>`;
  };

  function _ohFmtNum(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (Number.isNaN(n)) return null;
    return window.formatNumber(n);
  }

  function _ohFmtMoney(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (Number.isNaN(n)) return null;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M ₽';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K ₽';
    return window.formatNumber(n) + ' ₽';
  }

  function _ohFmtPct(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (Number.isNaN(n)) return null;
    return n.toFixed(1) + '%';
  }

  const _OH_DASH = '—';

  function _ohHeroStat({ accent, label, value, sub, tip, clickAction, field }) {
    const isEmpty = value == null;
    const accentCls = accent ? ` is-accent-${accent}` : '';
    // clickAction 一旦提供就生效,即便 value 是 — (允许 fetch 失败时跳兜底 URL)
    const clickCls = clickAction ? ' is-clickable' : '';
    const clickAttr = clickAction ? ` data-click-action="${_ohEsc(clickAction)}"` : '';
    const tipAttr = tip ? ` data-oh-tip="${_ohEsc(tip)}"` : '';
    const fieldAttr = field ? ` data-field="${_ohEsc(field)}"` : '';
    const valHtml = isEmpty
      ? `<div class="oh-hero-value is-dim">${_OH_DASH}</div>`
      : `<div class="oh-hero-value">${value}${sub ? `<small>${_ohEsc(sub)}</small>` : ''}</div>`;
    return `<div class="oh-hero-stat${accentCls}${clickCls}"${tipAttr}${clickAttr}${fieldAttr}>
      <div class="oh-hero-label">${_ohEsc(label)}</div>
      ${valHtml}
    </div>`;
  }

  function _ohRenderRow(r) {
    const valDisplay = r.value == null ? _OH_DASH : r.value;
    const dimCls = r.value == null ? ' is-dim' : '';
    const colorCls = !dimCls && r.color ? ` is-${r.color}` : '';
    const tipAttr = r.tip ? ` data-oh-tip="${_ohEsc(r.tip)}"` : '';
    const fieldAttr = r.field ? ` data-field="${_ohEsc(r.field)}"` : '';
    return `<div class="ozon-helper-sidebar-card-row"${fieldAttr}>
      <span class="ozon-helper-sidebar-card-label"${tipAttr}>${_ohEsc(r.label)}</span>
      <span class="ozon-helper-sidebar-card-value${colorCls}${dimCls}">${valDisplay}</span>
    </div>`;
  }

  function _ohRenderSection(s) {
    const accentCls = s.accent ? ` is-accent-${s.accent}` : '';
    return `<div class="ozon-helper-sidebar-section${accentCls}">
      <div class="ozon-helper-sidebar-section-header">
        <span><span class="oh-section-icon">${s.icon}</span>${_ohEsc(s.title)}</span>
      </div>
      <div class="ozon-helper-sidebar-section-body">
        ${s.rows.map(_ohRenderRow).join('')}
      </div>
    </div>`;
  }

  window.jzRenderPanelSkeleton = function(panel) {
    panel.innerHTML = `
      <div class="ozon-helper-sidebar-card-header">
        <span class="ozon-helper-sidebar-card-logo"><span class="oh-logo-icon">${_ohSvg(_OH_ICONS.zap)}</span>${globalThis.__JZ_BRAND__.displayName}ERP</span>
        ${window.jzFieldSettingsGearHtml()}
      </div>
      <div class="ozon-helper-sidebar-card-body">
        <div class="oh-hero-section">
          <div class="oh-hero-stat is-skeleton"></div>
          <div class="oh-hero-stat is-skeleton"></div>
          <div class="oh-hero-stat is-skeleton"></div>
          <div class="oh-hero-stat is-skeleton"></div>
        </div>
        <div class="ozon-helper-sidebar-section is-skeleton-section">
          <div class="oh-skeleton-row"></div>
          <div class="oh-skeleton-row"></div>
          <div class="oh-skeleton-row"></div>
        </div>
      </div>`;
  };

  // 挂载即渲染**真实 V2 面板结构**(字段 '-' 占位),不再走 shimmer 骨架 ——
  // 骨架屏把"在等待"放大成显性体感;结构先出、数据到货即填,与 PDP 侧栏卡一致。
  // V2 渲染器缺失 / tile 提不出 SKU 的极端情况回退旧骨架。
  // 返回是否渲染了 V2 结构(调用方据此决定后续是否需要整卡重绘)。
  window.jzMountPanelStructure = function (panel, card) {
    const href = card?.querySelector?.('a[href*="/product/"]')?.href || '';
    const m = href.match(/\/product\/.*-(\d{5,})/);
    const sku = m ? m[1] : null;
    if (sku && typeof window.jzRenderProductPanelV2 === 'function') {
      window.jzRenderProductPanelV2(panel, { sku });
      return true;
    }
    window.jzRenderPanelSkeleton(panel);
    return false;
  };

  // 主渲染。data shape 见 jzMergeCardPanelData。options.showActions 控制底部按钮。
  window.jzRenderProductCardPanel = function(panel, data, options = {}) {
    const opts = { showActions: true, ...options };

    const heroSold = _ohFmtNum(data.soldCount);

    let dateMain = null;
    let dateSub = null;
    if (data.createDate) {
      const d = new Date(data.createDate);
      if (!Number.isNaN(d.getTime())) {
        dateMain = d.toISOString().slice(0, 10);
        const days = Math.floor((Date.now() - d.getTime()) / 86400000);
        dateSub = `${days} 天`;
      }
    }

    const followCount = data.followSellCount != null ? Number(data.followSellCount) : null;
    const followVal = followCount != null ? `${followCount}` : null;
    const followSub = followCount != null ? '卖家' : null;

    let sizeMain = null;
    let sizeSub = null;
    if (data.weightG) sizeMain = `${data.weightG}g`;
    if (data.lengthMm && data.widthMm && data.heightMm) {
      const dims = `${data.lengthMm}×${data.widthMm}×${data.heightMm}`;
      if (sizeMain) sizeSub = dims;
      else sizeMain = dims;
    }

    const heroHtml = `<div class="oh-hero-section">
      ${_ohHeroStat({
        field: 'sales30d',
        accent: 'blue', label: `${window.jzSalesPeriodCnShort?.() || '月'}销量`, value: heroSold,
        tip: `商品${window.jzSalesPeriodCnLong?.() || '近 30 天'}销售数量`,
      })}
      ${_ohHeroStat({
        field: 'createDate',
        accent: 'green', label: '上架时间', value: dateMain, sub: dateSub,
        tip: '商品首次上架的日期',
      })}
      ${_ohHeroStat({
        field: 'heroFollow',
        accent: 'orange', label: '跟卖', value: followVal, sub: followSub,
        // followCount === 0 才禁用(确认无跟卖);null(fetch 失败/反爬退避中) 仍允许跳
        // Ozon 原生卖家列表,作为兜底。
        tip: followCount === 0
          ? '商品当前无跟卖者'
          : followCount > 0
            ? '\u70b9\u51fb\u67e5\u770b\u8ddf\u5356\u5546\u5bb6\u5217\u8868'
            : '\u8ddf\u5356\u6570\u52a0\u8f7d\u4e2d,\u70b9\u51fb\u67e5\u770b\u5356\u5bb6\u5217\u8868',
        clickAction: followCount === 0 ? null : 'show-followsell-modal',
      })}
      ${_ohHeroStat({
        field: 'heroSize',
        accent: 'purple', label: '重量·尺寸', value: sizeMain, sub: sizeSub,
        tip: '商品重量与长×宽×高(mm)',
      })}
    </div>`;

    // Sections:删除 hero 已展示的「月销量」「跟卖数」
    const sections = [
      {
        accent: 'blue', icon: _ohSvg(_OH_ICONS.barChart), title: '销售表现', rows: [
          {
            field: 'revenue30d',
            label: `${window.jzSalesPeriodCnShort?.() || '月'}销售额`, value: _ohFmtMoney(data.gmvSum),
            color: data.gmvSum > 0 ? 'blue' : '',
            tip: `商品${window.jzSalesPeriodCnLong?.() || '近 30 天'}销售额`,
          },
          {
            field: 'avgPrice',
            label: '均价',
            value: data.avgPrice != null ? `${window.formatNumber(data.avgPrice)} ₽` : null,
            tip: '商品平均售价',
          },
          {
            field: 'dailySales',
            label: '日销量',
            value: data.dailySales != null ? Number(data.dailySales).toFixed(2) : null,
            color: 'blue',
            tip: `${window.jzSalesPeriodCnUnit?.() || '近一个月'}销售件数,除以有现货天数(退货/取消不计)`,
          },
          {
            field: 'dailyRevenue',
            label: '日销售额',
            value: data.dailyRevenue != null ? Number(data.dailyRevenue).toFixed(2) + '₽' : null,
            color: 'blue',
            tip: `${window.jzSalesPeriodCnUnit?.() || '近一个月'}销售金额,除以有现货天数(退货/取消不计)`,
          },
          {
            field: 'salesDynamics',
            label: `${window.jzSalesPeriodCnShort?.() || '月'}周转动态`, value: _ohFmtPct(data.salesDynamics),
            color: data.salesDynamics > 0 ? 'green' : data.salesDynamics < 0 ? 'red' : '',
            tip: `与${window.jzSalesPeriodCnPrev?.() || '上一个月'}相比订单金额总和发生了怎样的变化`,
          },
        ],
      },
      {
        accent: 'green', icon: _ohSvg(_OH_ICONS.users), title: '流量与转化', rows: [
          {
            field: 'views',
            label: '展示量', value: _ohFmtNum(data.views),
            tip: '商品在网站所有页面上的展示次数',
          },
          {
            field: 'convViewToOrder',
            label: '展示转化率', value: _ohFmtPct(data.convViewToOrder),
            color: data.convViewToOrder > 0 ? 'green' : '',
            tip: '展示次数与订单数量的比例',
          },
          {
            field: 'drr',
            label: '广告费占比', value: _ohFmtPct(data.drr),
            tip: '商品推广费用占所有订单金额的百分比',
          },
          {
            field: 'discount',
            label: '折扣',
            value: data.discount != null ? _ohFmtPct(data.discount) : null,
            color: data.discount > 0 ? 'orange' : '',
            tip: '当前商品的折扣百分比',
          },
        ],
      },
      {
        accent: 'purple', icon: _ohSvg(_OH_ICONS.box), title: '物流与商品', rows: [
          { field: 'salesSchema', label: '发货模式', value: data.salesSchema || null, tip: '商品发货模式' },
          { field: 'stock', label: '库存', value: _ohFmtNum(data.stock), tip: '当前商品库存量' },
          {
            field: 'rating',
            label: '评分', value: data.rating != null ? String(data.rating) : null,
            color: data.rating >= 4 ? 'gold' : '',
            tip: '商品评分',
          },
          {
            field: 'volume',
            label: '体积',
            value: window.jzVolumeLiters(data.lengthMm, data.widthMm, data.heightMm) != null
              ? window.jzVolumeLiters(data.lengthMm, data.widthMm, data.heightMm) + ' L'
              : null,
            tip: '按长×宽×高估算的体积(升)',
          },
        ],
      },
    ];

    // 两行布局:
    //   第一行 一键跟卖(primary,占满宽);
    //   第二行 编辑上架 + 采集(各占一半)
    // 三按钮一行宽度太挤(每按 ~85px),占满信息折叠成两字"采集"也不舒服。
    const actionsHtml = opts.showActions ? `<div class="ozon-helper-sidebar-card-actions">
      <button class="ozon-helper-sidebar-card-btn is-primary" data-action="follow-sell">
        <span class="oh-btn-icon">${_ohSvg(_OH_ICONS.link)}</span>一键跟卖
      </button>
      <div class="ozon-helper-sidebar-card-actions-row">
        <button class="ozon-helper-sidebar-card-btn" data-action="edit-list">
          <span class="oh-btn-icon">${_ohSvg(_OH_ICONS.pencil)}</span>编辑上架
        </button>
        <button class="ozon-helper-sidebar-card-btn" data-action="collect-one">
          <span class="oh-btn-icon">${_ohSvg(_OH_ICONS.inbox)}</span>采集
        </button>
      </div>
    </div>` : '';

    panel.innerHTML = `
      <div class="ozon-helper-sidebar-card-header">
        <span class="ozon-helper-sidebar-card-logo"><span class="oh-logo-icon">${_ohSvg(_OH_ICONS.zap)}</span>${globalThis.__JZ_BRAND__.displayName}ERP</span>
        ${window.jzFieldSettingsGearHtml()}
      </div>
      <div class="ozon-helper-sidebar-card-body">
        ${heroHtml}
        ${sections.map(_ohRenderSection).join('')}
        ${actionsHtml}
      </div>`;

    // 标记为数据卡(jzApplyFieldVisibilityToAll 用)+ 应用当前显隐。
    // 齿轮点击不在此自绑:list/search 的 caller(ozon-search.js / ozon-data-panel.js)
    // 在 ensureDataPanel 里对 panel 节点装了 [data-action] 委托(panel 节点跨 re-render
    // 复用),open-field-settings 由那套统一捕获 → 走同一条 handlePanelAction 路径。
    panel.setAttribute('data-jz-datacard', '1');
    window.jzBindDataCardCopyButtons(panel);
    window.jzLoadFieldVisibility().then((v) => window.jzApplyFieldVisibility(panel, v));
  };

  window.jzMergeCardPanelData = function(marketData, productData, variantData, publicData, productId, publicWeightDims) {
    const stats = productData?.statistics || {};
    const md = marketData || {};

    const items = variantData?.items || variantData?.data?.items || [];
    const matchedItem = items.find((it) => String(it.variant_id) === String(productId)) || null;
    const item = matchedItem || items[0];
    const attrMap = item?.attributes
      ? new Map(item.attributes.map((a) => [String(a.key), a]))
      : null;
    // sv 优先(自家目录 SKU 直命中,attr 数值类型可靠);
    // sv 拿不到时(跟卖陌生 SKU 全部走这里)用 publicWeightDims 公共 /features/ 兜底。
    const pwd = publicWeightDims || null;
    const weightG = (attrMap ? window.jzSvWeightG(attrMap) : null) || (pwd?.weightG ?? null);
    const lengthMm = (attrMap ? Number(attrMap.get('9454')?.value) || null : null) || (pwd?.lengthMm ?? null);
    const widthMm = (attrMap ? Number(attrMap.get('9455')?.value) || null : null) || (pwd?.widthMm ?? null);
    const heightMm = (attrMap ? Number(attrMap.get('9456')?.value) || null : null) || (pwd?.heightMm ?? null);

    // 抓到重量/尺寸即回写平台级缓存(best-effort;后端灰度 ozon_sku_dims_cache 门控,未开则丢弃)。
    // 这些值全来自 sv(自家目录)或公共 PDP 的客户端抓取,不是后端缓存回读,可安全上报。
    try {
      if (productId && (weightG || lengthMm || widthMm || heightMm) && window.sendMessage) {
        const fromSv = !!(attrMap && (attrMap.get('4497') || attrMap.get('4383') ||
          attrMap.get('9454') || attrMap.get('9455') || attrMap.get('9456')));
        window.sendMessage('reportSkuDims', {
          item: {
            sku: String(productId),
            weightG: weightG || null,
            lengthMm: lengthMm || null,
            widthMm: widthMm || null,
            heightMm: heightMm || null,
            source: fromSv ? 'sv' : 'public_pdp',
          },
        }).catch(() => {});
      }
    } catch (_) { /* best-effort,绝不影响数据卡渲染 */ }

    const followSellCount =
      publicData?.followSellCount ?? productData?.followSellCount ?? null;
    const followSellers = Array.isArray(publicData?.sellers) ? publicData.sellers : [];
    const parseFollowPrice = (price) => {
      if (price == null) return null;
      const normalized = String(price).replace(/[^\d.,-]/g, '').replace(/\s/g, '').replace(',', '.');
      const num = parseFloat(normalized);
      return Number.isFinite(num) ? num : null;
    };
    const followSellPrices = followSellers
      .map((seller) => parseFollowPrice(seller?.price))
      .filter((price) => price !== null);
    const followSellMinPrice =
      publicData?.followSellMinPrice ?? productData?.followSellMinPrice ??
      (followSellPrices.length ? Math.min(...followSellPrices) : null);
    const brandAttr = attrMap?.get('85') || null;
    const brand =
      md.brand ??
      productData?.brand ??
      (typeof brandAttr?.value === 'string' ? brandAttr.value : null) ??
      (Array.isArray(brandAttr?.values) ? brandAttr.values[0]?.value : null) ??
      null;

    return {
      soldCount: md.soldCount ?? stats.sold_count ?? null,
      gmvSum: md.gmvSum ?? stats.gmv_sum ?? null,
      avgPrice: md.avgPrice ?? stats.avg_price ?? null,
      views: md.views ?? stats.views ?? null,
      convViewToOrder: md.convViewToOrder ?? null,
      salesDynamics: md.salesDynamics ?? null,
      drr: md.drr ?? null,
      stock: md.stock ?? null,
      discount: md.discount ?? null,
      daysInPromo: md.daysInPromo ?? null,
      promoRevenueShare: md.promoRevenueShare ?? null,
      daysWithTrafarets: md.daysWithTrafarets ?? null,
      qtyViewPdp: md.qtyViewPdp ?? null,
      sessionCount: md.sessionCount ?? null,
      pdpToCartConversion: md.pdpToCartConversion ?? null,
      convToCartPdp: md.convToCartPdp ?? null,
      sessionCountSearch: md.sessionCountSearch ?? null,
      convToCartSearch: md.convToCartSearch ?? null,
      salesSchema: md.salesSchema ?? null,
      sources: md.sources ?? null,
      nullableRedemptionRate: md.nullableRedemptionRate ?? null,
      dailySales: md.avgOrdersOnAccDays ?? productData?.dailySales ?? null,
      dailyRevenue: md.avgGmvOnAccDays ?? productData?.dailyRevenue ?? null,
      rating: productData?.rating ?? null,
      brand,
      followSellCount,
      followSellMinPrice,
      canFollow: Boolean(matchedItem || productData?.canFollow),
      createDate: md.nullableCreateDate ?? null,
      weightG, lengthMm, widthMm, heightMm,
    };
  };

  // ─── 统一的「需登录卖家中心」红色提示条 ──────────────────────────────
  // market 字段(月销量/月销售额/转化率/上架时间…)依赖 seller.ozon.ru 登录态:
  // getMarketStats 返 __needSellerLogin 时,这些字段会空,这里给**红色**明确提示 +
  // 一键去登录,引导用户做商家侧登录(点按钮经 SW 复用/新开 seller tab;登录是安全
  // 操作,必须用户自己点,绝不自动登录)。PDP 侧边卡与搜索/类目卡共用同一实现,
  // 避免双份漂移。container = PDP 卡 body 或搜索卡 panel。
  // opts.message / opts.cta 可覆盖文案;opts.tone 'error'(红,默认)| 'warn'(黄)。
  window.jzShowSellerLoginHint = function (container, opts = {}) {
    if (!container || container.querySelector('.ozon-helper-seller-login-hint')) return null;
    const palette = (opts.tone === 'warn')
      ? { bg: '#fff7e6', border: '#ffe0a3', fg: '#ad6800' }
      : { bg: '#fff1f0', border: '#ffccc7', fg: '#cf1322' };
    const hint = document.createElement('div');
    hint.className = 'ozon-helper-seller-login-hint';
    hint.setAttribute('translate', 'no');
    hint.setAttribute('lang', 'zh-Hans');
    hint.style.cssText =
      `margin:8px;padding:8px 10px;border-radius:8px;background:${palette.bg};` +
      `border:1px solid ${palette.border};color:${palette.fg};font-size:12px;line-height:1.5;` +
      'display:flex;align-items:center;gap:8px;justify-content:space-between;';
    const text = document.createElement('span');
    text.textContent = opts.message || '⚠️ 请登录 Ozon 卖家后台后继续查看市场数据';
    const btn = document.createElement('a');
    btn.textContent = opts.cta || '点击登录 →';
    btn.href = '#';
    btn.style.cssText =
      `color:${palette.fg};font-weight:700;white-space:nowrap;cursor:pointer;text-decoration:underline;`;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      // 走 SW 开 tab(content script 无 chrome.tabs;SW 能复用已有 tab);失败兜底 window.open。
      try {
        window.sendMessage('openSellerPortal', {}).catch(() => {
          window.open('https://seller.ozon.ru/app/products', '_blank');
        });
      } catch {
        window.open('https://seller.ozon.ru/app/products', '_blank');
      }
    });
    hint.append(text, btn);
    container.insertBefore(hint, container.firstChild);
    return hint;
  };

  // ─── sv(search-variant + bundle)→ 统一 catalog 字段提取 ──────────────
  // 「一键采集」改造(2026-05-30):商品页 / 搜索页单采 / 采集器批量推送三处共用
  // 同一份「跟卖式」取值逻辑,把 catalog 字段的真值源从 DOM 切到 seller-portal
  // search + create-bundle-by-variant-id 返回的 sv item,避免 DOM 抓到的被
  // Chrome 翻译污染的标题 / 不全的图册 / 缺失的品牌类目。
  //
  // 入参 sv = searchVariants 返回 items[] 里匹配到的那条(normalizeSearchVariantToSv
  // 输出 + bundle attrs 已 merge,见 service-worker.js searchVariants handler)。
  // 返回字段都是 sv 真值源;sv 缺某字段时返回 ''/[]/null,由 caller 用 DOM 兜底。
  // statistics / price / seller seller-portal 不返回,不在此 helper 内 —— caller
  // 仍走 DOM(混合模式)。
  //
  // attr key 映射(跟卖 handleMultiVariantFollowSell + jzMergeCardPanelData 同源):
  //   4180 商品名 · 4194 主图 · 4195 图册collection · 85 品牌 · 8229 类型/类目名
  //   4497 重量g · 4383 重量kg(浮点) · 9454/9455/9456 depth/width/height mm · 7822 GTIN
  window.jzExtractCatalogFromSv = function (sv) {
    const empty = {
      name: '', mainImage: '', images: [], brand: '',
      categoryPath: '', categoryId: null,
      weightG: null, depthMm: null, widthMm: null, heightMm: null, gtin: '',
    };
    if (!sv || !Array.isArray(sv.attributes)) return { ...empty };
    const attrMap = new Map(sv.attributes.map((a) => [String(a.key), a]));
    const sval = (k) => {
      const v = attrMap.get(String(k))?.value;
      return v != null && String(v).trim() ? String(v).trim() : '';
    };
    const sint = (k) => {
      const n = Number(attrMap.get(String(k))?.value);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    };

    // 图册:4194 主图 + 4195 collection,按规范化 url 去重(跟卖 pushUrl 同逻辑)
    const images = [];
    const seen = new Set();
    const pushUrl = (u) => {
      if (!u || typeof u !== 'string') return;
      const norm = u.split('?')[0].split('#')[0].toLowerCase();
      if (seen.has(norm)) return;
      seen.add(norm);
      images.push(u);
    };
    pushUrl(sval('4194'));
    const gallery = attrMap.get('4195')?.collection;
    if (Array.isArray(gallery)) for (const u of gallery) pushUrl(u);

    // 重量:4497(packaged g)优先,缺则 4383 kg 浮点(<100 视为 kg→*1000,
    // 跟后端 product.service.ts 启发式 + 跟卖 readSourceWeightKgAsG 对齐)
    let weightG = sint('4497');
    if (weightG == null) {
      const kg = Number(attrMap.get('4383')?.value);
      if (Number.isFinite(kg) && kg > 0) weightG = kg < 100 ? Math.round(kg * 1000) : Math.round(kg);
    }

    // 类目:优先 categories[] 可读 title 拼 "L1/最深" 路径;/api/v1/search 的
    // categories 常只回 {id, level} 无 title → 回退类型名 8229(同 shared-utils
    // panel fill 逻辑)
    let categoryPath = '';
    const cats = Array.isArray(sv.categories)
      ? sv.categories.filter((c) => c && (c.title || c.name))
      : [];
    if (cats.length) {
      const titles = [...cats]
        .sort((a, b) => (Number(a.level) || 0) - (Number(b.level) || 0))
        .map((c) => c.title || c.name)
        .filter(Boolean);
      const l1 = titles[0];
      const deepest = titles[titles.length - 1];
      categoryPath = [l1, deepest && deepest !== l1 ? deepest : null].filter(Boolean).join('/');
    }
    if (!categoryPath) categoryPath = sval('8229');

    return {
      name: sval('4180'),
      mainImage: images[0] || '',
      images,
      brand: sval('85'),
      categoryPath,
      categoryId: sv.description_category_id ?? null,
      weightG,
      depthMm: sint('9454'),
      widthMm: sint('9455'),
      heightMm: sint('9456'),
      gtin: sval('7822'),
    };
  };

  // 名称真值源选择(翻译/污染安全),跟卖 handleMultiVariantFollowSell 同款判定:
  // DOM 文本含中文 && sv 4180 原值不含中文 → DOM 是被 Chrome 翻译的版本,
  // 强制用 sv 俄/英原名,避免采集落库后上架到俄罗斯店出现中文名。
  // DOM 清洗前后不一致 → DOM 混入角标/促销/价格等污染文本,用 sv 原名兜底。
  // 其余情况干净 DOM 优先(用户可能手编过 / sv 缺名时),DOM 空再退 sv。
  window.jzPreferSourceName = function (svName, domName) {
    const sv = svName ? String(svName).replace(/\s+/g, ' ').trim() : '';
    const rawDom = domName ? String(domName).replace(/\s+/g, ' ').trim() : '';
    const dom = window.jzCleanOzonCardTitle ? window.jzCleanOzonCardTitle(rawDom) : rawDom;
    const isCN = (s) => /[一-龥]/.test(s);
    const domLooksPolluted = !!sv && !!rawDom && !!dom && rawDom !== dom;
    if (domLooksPolluted) return sv;
    if (sv && isCN(dom) && !isCN(sv)) return sv;
    return dom || sv;
  };

  // ─── 抓标题时剔除 Ozon 卡片角标 / 营销促销词 ──────────────────────────
  // Ozon 卡片上的「Новинка」「0% до N дней」分期角标等会被 textContent 抓进商品
  // 名,上架时被审核打回「属性包含广告表达或营销促销名称…不符合网站规则」。
  // 抓到的标题先过这层;若剥光后为空(整串都是角标),返回 '' 让后端走
  // search-variant-model attr 4180 拿原始俄文名。后端 product.service 里有同名
  // 兜底(stripOzonPromoExpressions),此处是源头防线。
  const JZ_PROMO_INSTALLMENT_RE =
    /\d+\s*%\s*(?:до|на|за)\s*\d+\s*(?:дн(?:ей|я|и)|месяц\w*|мес\.?|год\w*|лет)/giu;
  const JZ_PROMO_DISCOUNT_RE = /[-–−]\s*\d+\s*%/gu;
  // 「скидки недели」整短语须排在裸 скидк[аиу] 之前 — 交替按序匹配,否则只剥掉
  // 「Скидки」留下孤儿残词「недели」(合并卡角标实测)。与后端 PROMO_WORD_RE 同步。
  const JZ_PROMO_WORD_RE =
    /(?<![\p{L}\p{N}])(?:новинк[аи]|хит(?:\s+продаж)?|бестселлер|bestseller|распродаж[аи]|скидк[аиу]\s+недели|скидк[аиу]|акци[яи]|sale|promo|промо|выгодн(?:о|ая\s+цена)|спец(?:предложение|\s*цена)|лучшая\s+цена|топ\s+продаж|уникальное\s+предложение)(?![\p{L}\p{N}])/giu;
  window.jzStripPromo = function (title) {
    if (!title) return '';
    try {
      return String(title)
        .replace(JZ_PROMO_INSTALLMENT_RE, ' ')
        .replace(JZ_PROMO_DISCOUNT_RE, ' ')
        .replace(JZ_PROMO_WORD_RE, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s,./:;!?»«"'-]+|[\s,./:;!?»«"'-]+$/g, '')
        .trim();
    } catch {
      return String(title).trim();
    }
  };

  // 标题「整体≈角标」判定:jzStripPromo 剥后剩空/碎词(如「0% до 140 днейСкидки
  // недели」→「недели」),残词不是可用商品名 — 调用方应回退 sv 4180 真名。
  // 口径与后端 product.service isPromoResidualTitle 一致:剥掉了内容,且剩余
  // <8 字符,或删除比例 ≥50% 且只剩 ≤2 个词。
  window.jzIsPromoResidualTitle = function (original, stripped) {
    const orig = String(original || '').trim();
    const rest = String(stripped || '').trim();
    if (!orig) return false;
    if (!rest) return true;
    if (rest === orig) return false;
    const words = rest.split(/\s+/).filter(Boolean);
    const removedRatio = 1 - rest.length / orig.length;
    return rest.length < 8 || (removedRatio >= 0.5 && words.length <= 2);
  };

  window.jzCleanOzonCardTitle = function (title) {
    let text = String(title || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const money = '(?:[\\u20bd\\u00a5\\uffe5]\\s*)?\\d[\\d\\s]*(?:[,.]\\d{1,2})\\s*(?:[\\u20bd\\u00a5\\uffe5]|RUB|RUR|CNY|RMB|руб\\.?)?';
    text = text.replace(new RegExp(`^(?:${money}\\s*){1,3}`, 'i'), '').trim();
    text = text.replace(/^[\s\u2212-]*\d{1,2}\s*%\s*/u, '').trim();
    text = text.replace(/\s+\d[,.]\d\d*\s*Ozon\s*$/i, '').trim();
    text = text.replace(/\s+Ozon\s*$/i, '').trim();
    return text;
  };

  window.jzParseOzonPriceNumber = function (value) {
    if (value == null) return null;
    if (typeof value === 'object') {
      const units = window.jzParseOzonPriceNumber(value.units);
      const nanos = Number(value.nanos);
      if (units != null && Number.isFinite(nanos) && nanos !== 0) return units + (nanos / 1e9);
      if (units != null) return units;
      const nested = value.price ?? value.value ?? value.amount ?? value.text ?? value.marketingPrice ?? value.marketing_price ?? '';
      if (nested === value) return null;
      return nested && typeof nested === 'object'
        ? window.jzParseOzonPriceNumber(nested)
        : window.jzParseOzonPriceNumber(String(nested));
    }
    const raw = value;
    const text = String(raw).replace(/\u00a0/g, ' ').trim();
    const match = text.replace(/\s+/g, '').match(/[-+]?\d+(?:[,.]\d+)?/);
    if (!match) return null;
    const n = Number(match[0].replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  window.jzDetectOzonMoneyCurrency = _jzDetectOzonMoneyCurrency;

  function _jzOzonVisibleMoneyTokens(node) {
    if (!node) return [];
    const text = String(node.innerText || node.textContent || '').replace(/\u00a0/g, ' ');
    if (!text.trim()) return [];
    const tokens = [];
    const seen = new Set();
    const re = /(?:[\u20bd\u00a5\uffe5]\s*)?\d[\d\s]*(?:[,.]\d{1,2})?\s*(?:[\u20bd\u00a5\uffe5]|RUB|RUR|CNY|RMB|\u0440\u0443\u0431\.?)?/giu;
    let match;
    while ((match = re.exec(text))) {
      const raw = String(match[0] || '').trim();
      const currency = window.jzDetectOzonMoneyCurrency(raw);
      if (!currency) continue;
      const value = window.jzParseOzonPriceNumber(raw);
      if (value == null) continue;
      const key = `${currency}:${Math.round(value * 100)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push({ value, currency });
      if (tokens.length >= 6) break;
    }
    return tokens;
  }

  function _jzOzonPriceStateElements(root) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    const out = [];
    const seen = new Set();
    const add = (el) => {
      if (!el || typeof el.getAttribute !== 'function') return;
      if (!el.getAttribute('data-state')) return;
      if (seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };
    try {
      if (scope && typeof scope.matches === 'function' && scope.matches('[data-widget="webPrice"], [data-widget="searchResultsPrice"]')) {
        add(scope);
      }
      scope.querySelectorAll('[data-widget="webPrice"][data-state], [data-widget="searchResultsPrice"][data-state]').forEach(add);
      scope.querySelectorAll('[data-widget="webPrice"] [data-state], [data-widget="searchResultsPrice"] [data-state]').forEach(add);
    } catch {}
    return out;
  }

  window.jzExtractOzonVisiblePriceTags = function (root) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    const nodes = [];
    if (scope && typeof scope.matches === 'function' && scope.matches('[data-widget="webPrice"], [data-widget="searchResultsPrice"]')) {
      nodes.push(scope);
    }
    try {
      scope.querySelectorAll('[data-widget="webPrice"], [data-widget="searchResultsPrice"]').forEach((node) => nodes.push(node));
    } catch {}
    for (const node of nodes) {
      const tokens = _jzOzonVisibleMoneyTokens(node);
      if (!tokens.length) continue;
      const primaryCurrency = tokens[0].currency || 'RUB';
      const sameCurrency = tokens.filter((item) => item.currency === primaryCurrency);
      const picked = (sameCurrency.length ? sameCurrency : tokens).slice(0, 2);
      const values = picked.map((item) => item.value).filter((value) => Number.isFinite(value) && value > 0);
      if (!values.length) continue;
      const min = Math.min(...values);
      const max = Math.max(...values);
      return {
        blackPrice: max,
        blackPriceCurrency: primaryCurrency,
        greenPrice: min,
        greenPriceCurrency: primaryCurrency,
      };
    }
    return {};
  };

  window.jzExtractOzonPriceTags = function (root) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    const out = {};
    const seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    const assign = (kind, value) => {
      const n = window.jzParseOzonPriceNumber(value);
      if (n == null || out[kind] != null) return;
      out[kind] = n;
      const currency = window.jzDetectOzonMoneyCurrency(value);
      if (currency) out[`${kind}Currency`] = currency;
    };
    try {
      const visibleTags = window.jzExtractOzonVisiblePriceTags(scope) || null;
      if (visibleTags?.blackPrice != null) {
        out.blackPrice = visibleTags.blackPrice;
        if (visibleTags.blackPriceCurrency) out.blackPriceCurrency = visibleTags.blackPriceCurrency;
      }
      if (visibleTags?.greenPrice != null) {
        out.greenPrice = visibleTags.greenPrice;
        if (visibleTags.greenPriceCurrency) out.greenPriceCurrency = visibleTags.greenPriceCurrency;
      }
    } catch {}
    const visitPriceState = (node, depth = 0) => {
      if (!node || depth > 6) return;
      if (typeof node !== 'object') return;
      if (seen) {
        if (seen.has(node)) return;
        seen.add(node);
      }
      if (Array.isArray(node)) {
        node.slice(0, 80).forEach((item) => visitPriceState(item, depth + 1));
        return;
      }
      assign('blackPrice', node.blackPrice ?? node.black_price ?? node.marketingPrice ?? node.marketing_price);
      if (node.cardPrice != null || node.card_price != null) {
        assign('blackPrice', node.price);
        assign('greenPrice', node.cardPrice ?? node.card_price);
      } else if (node.price != null) {
        assign('blackPrice', node.price);
      }
      Object.entries(node).slice(0, 120).forEach(([key, value]) => {
        if (/image|img|url|link|title|name/i.test(key)) return;
        visitPriceState(value, depth + 1);
      });
    };
    try {
      _jzOzonPriceStateElements(scope).forEach((el) => {
        const raw = el.getAttribute('data-state');
        if (!raw || raw.length < 8) return;
        try {
          const state = JSON.parse(raw);
          if (!state || typeof state !== 'object') return;
          if (out.blackPrice == null && state.price != null) {
            assign('blackPrice', state.price);
          }
          if (out.greenPrice == null && state.cardPrice != null) {
            assign('greenPrice', state.cardPrice);
          }
          visitPriceState(state);
        } catch {}
      });
    } catch {}
    if (out.blackPrice == null) {
      const el = scope.querySelector('[data-widget="webPrice"] span, [data-widget="searchResultsPrice"] span');
      assign('blackPrice', el?.textContent);
    }
    if (out.blackPrice == null && out.greenPrice != null) out.blackPrice = out.greenPrice;
    if (out.blackPrice != null && (out.greenPrice == null || out.greenPrice > out.blackPrice)) {
      out.greenPrice = out.blackPrice;
    }
    if (out.blackPrice != null && !out.blackPriceCurrency) out.blackPriceCurrency = 'RUB';
    if (out.greenPrice != null && !out.greenPriceCurrency) out.greenPriceCurrency = 'RUB';
    return out;
  };

  window.jzExtractOzonCalcPriceTags = function (root) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    const out = {};
    const assign = (kind, value) => {
      const n = window.jzParseOzonPriceNumber(value);
      if (n == null || out[kind] != null) return;
      out[kind] = n;
      const currency = window.jzDetectOzonMoneyCurrency(value);
      if (currency) out[`${kind}Currency`] = currency;
    };
    try {
      const tags = window.jzExtractOzonPriceTags(scope) || null;
      if (tags?.blackPrice != null) {
        out.blackPrice = tags.blackPrice;
        if (tags.blackPriceCurrency) out.blackPriceCurrency = tags.blackPriceCurrency;
      }
      if (tags?.greenPrice != null) {
        out.greenPrice = tags.greenPrice;
        if (tags.greenPriceCurrency) out.greenPriceCurrency = tags.greenPriceCurrency;
      }
    } catch {}
    try {
      _jzOzonPriceStateElements(scope).forEach((el) => {
        const raw = el.getAttribute('data-state');
        if (!raw || raw.length < 10) return;
        try {
          const p = JSON.parse(raw);
          if (!p || typeof p !== 'object') return;
          if (p.price && out.blackPrice == null) assign('blackPrice', p.price);
          if (p.cardPrice && out.greenPrice == null) assign('greenPrice', p.cardPrice);
        } catch {}
      });
    } catch {}
    if (!out.blackPrice) {
      const el = scope.querySelector('[data-widget="webPrice"] span');
      assign('blackPrice', el?.textContent);
    }
    if (out.blackPrice == null && out.greenPrice != null) out.blackPrice = out.greenPrice;
    if (out.blackPrice != null && (out.greenPrice == null || out.greenPrice > out.blackPrice)) {
      out.greenPrice = out.blackPrice;
    }
    if (out.blackPrice != null && !out.blackPriceCurrency) out.blackPriceCurrency = 'RUB';
    if (out.greenPrice != null && !out.greenPriceCurrency) out.greenPriceCurrency = 'RUB';
    return out;
  };

  window.jzExtractOzonPageHashtags = function (root) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    const out = [];
    const seen = new Set();
    const pushText = (value) => {
      const text = String(value || '').replace(/\u00a0/g, ' ').trim();
      if (!text) return;
      const matches = text.match(/#[\p{L}\p{N}_]+/gu) || [];
      for (const rawTag of matches) {
        const tag = rawTag.trim();
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
      }
    };
    const visit = (value, depth = 0) => {
      if (depth > 5 || value == null || out.length >= 20) return;
      if (typeof value === 'string' || typeof value === 'number') {
        pushText(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      if (typeof value === 'object') {
        for (const item of Object.values(value)) visit(item, depth + 1);
      }
    };
    try {
      scope.querySelectorAll('[data-widget="webHashtags"] [title]').forEach((el) => {
        pushText(el.getAttribute('title'));
      });
    } catch {}
    try {
      scope.querySelectorAll('[data-widget="tagList"] a').forEach((el) => {
        pushText(el.textContent);
      });
    } catch {}
    try {
      scope.querySelectorAll('[data-widget="webHashtags"][data-state], [data-widget="tagList"][data-state]').forEach((el) => {
        const raw = el.getAttribute('data-state');
        if (!raw || raw.length < 2) return;
        try { visit(JSON.parse(raw)); } catch {}
      });
    } catch {}
    return out.slice(0, 20);
  };

  const _jzPagePriceTagCache = new Map();
  window.jzFetchOzonPagePriceTags = async function (url) {
    if (!url) return null;
    let href = '';
    try {
      const u = new URL(url, window.location.href);
      if (!/\.?ozon\.ru$/i.test(u.hostname)) return null;
      href = `${u.origin}${u.pathname}${u.search}`;
    } catch {
      return null;
    }
    if (_jzPagePriceTagCache.has(href)) return _jzPagePriceTagCache.get(href);
    const promise = (async () => {
      const fetchHtml = async (target) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const resp = await fetch(target, {
            credentials: 'include',
            headers: { accept: 'text/html' },
            signal: controller.signal,
          });
          if (!resp.ok) return '';
          return await resp.text();
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        const readTags = (html) => {
          if (!html) return null;
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const priceTags = window.jzExtractOzonCalcPriceTags
            ? window.jzExtractOzonCalcPriceTags(doc)
            : window.jzExtractOzonPriceTags(doc);
          const hashtags = window.jzExtractOzonPageHashtags
            ? window.jzExtractOzonPageHashtags(doc)
            : [];
          const hasPrice = priceTags && (priceTags.blackPrice != null || priceTags.greenPrice != null);
          if (!hasPrice && (!hashtags || hashtags.length === 0)) return null;
          return {
            ...(hasPrice ? priceTags : {}),
            ...(hashtags && hashtags.length ? { hashtags } : {}),
          };
        };
        let tags = readTags(await fetchHtml(href));
        if (!tags) {
          const canonical = new URL(href);
          const canonicalHref = `${canonical.origin}${canonical.pathname}`;
          if (canonicalHref !== href) tags = readTags(await fetchHtml(canonicalHref));
        }
        return tags;
      } catch {
        return null;
      }
    })();
    _jzPagePriceTagCache.set(href, promise);
    return promise;
  };

  // ─── 公开 composer-api 跟卖列表 → followSellCount + sellers ─────────
  // 同源 fetch(content script 跑在 ozon.ru/* 页面上下文),反爬信任度等同用户正常浏览。
  // 拆到 shared-utils 里让详情页(ozon-product/data-panel)和搜索页(ozon-search)
  // 共用同一份 cache + failure-backoff 状态(同 tab 内一致)。
  //
  // 数据源(2026-05 起):Ozon 把跟卖列表从商品页主响应里彻底拿掉,改到独立 modal
  // endpoint `/modal/otherOffersFromSellers?product_id=<sku>`。响应 widgetStates 里
  // 的 `webSellerList-*` widget 携带完整的 sellers 数组(name/price/sku/productLink/
  // rating/delivery/logo 等)。零跟卖时该 widget 不存在。
  //
  // 反爬保护:
  // - sessionStorage cache(jz-fs5:<sku>):命中 → TTL 4h(>=1 跟卖)/ 30min(零跟卖)
  // - sessionStorage miss cache(jz-fs2-miss:<sku>):legacy,新逻辑直接 cache 0,
  //   不再写 miss(零卖家用 normal cache + 短 TTL 表达)
  // - 失败计数走 60s 滑动窗口:近 60s 内 5 次失败 → 退避 60s
  const FOLLOW_SELL_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
  const FOLLOW_SELL_MISS_TTL_MS = 5 * 60 * 1000;
  const FOLLOW_SELL_FAILURE_THRESHOLD = 5;
  const FOLLOW_SELL_FAILURE_WINDOW_MS = 60 * 1000;
  const FOLLOW_SELL_BACKOFF_MS = 60 * 1000;
  const followSellFailureState = { timestamps: [], pausedUntil: 0 };

  function recordFollowSellFailure() {
    const now = Date.now();
    followSellFailureState.timestamps = followSellFailureState.timestamps.filter(
      (t) => now - t < FOLLOW_SELL_FAILURE_WINDOW_MS
    );
    followSellFailureState.timestamps.push(now);
    if (followSellFailureState.timestamps.length >= FOLLOW_SELL_FAILURE_THRESHOLD) {
      followSellFailureState.pausedUntil = now + FOLLOW_SELL_BACKOFF_MS;
      followSellFailureState.timestamps = [];
    }
  }

  // jz-fs5:<sku> = { at, count, sellers, ttl } —— v4 加了配送/头像等详情,
  // 老 jz-fs2/fs3 cache 不读取(自然过期被覆盖)。
  function readFollowSellCache(sku) {
    try {
      const raw = sessionStorage.getItem(`jz-fs5:${sku}`);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      const ttl = typeof obj.ttl === "number" ? obj.ttl : FOLLOW_SELL_CACHE_TTL_MS;
      if (Date.now() - obj.at > ttl) return null;
      return { count: obj.count, sellers: Array.isArray(obj.sellers) ? obj.sellers : [] };
    } catch {
      return null;
    }
  }

  function writeFollowSellCache(sku, count, sellers, ttl) {
    try {
      sessionStorage.setItem(
        `jz-fs5:${sku}`,
        JSON.stringify({
          at: Date.now(),
          count,
          sellers: Array.isArray(sellers) ? sellers : [],
          ttl: ttl || FOLLOW_SELL_CACHE_TTL_MS,
        })
      );
    } catch {}
  }

  function readFollowSellMissCache(sku) {
    try {
      const raw = sessionStorage.getItem(`jz-fs2-miss:${sku}`);
      if (!raw) return false;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return false;
      if (Date.now() - obj.at > FOLLOW_SELL_MISS_TTL_MS) return false;
      return true;
    } catch {
      return false;
    }
  }

  // 从可能嵌套的文本节点 (text/title/content[]) 里提取字符串,Ozon JSON 里 seller
  // 字段经常包成 { text: "...", style: ... } 形态。
  function _extractText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) {
      return v.map(_extractText).filter(Boolean).join(" ");
    }
    if (typeof v === "object") {
      // textRs / atom / button.text 等嵌套文本
      if (typeof v.text === "string") return v.text;
      if (typeof v.content === "string") return v.content;
      if (typeof v.value === "string" || typeof v.value === "number") return String(v.value);
      if (typeof v.price === "string" || typeof v.price === "number") return String(v.price);
      if (typeof v.title === "string") return v.title;
      if (Array.isArray(v.textRs)) {
        return v.textRs.map(_extractText).filter(Boolean).join(" ");
      }
      if (Array.isArray(v.content)) {
        return v.content.map(_extractText).filter(Boolean).join(" ");
      }
      if (v.price && typeof v.price === "object") return _extractText(v.price);
      if (v.title && typeof v.title === "object") return _extractText(v.title);
      if (v.subtitle && typeof v.subtitle === "object") return _extractText(v.subtitle);
      if (v.label && typeof v.label === "object") return _extractText(v.label);
    }
    return "";
  }

  function _firstText(...values) {
    for (const v of values) {
      const text = _extractText(v).trim();
      if (text) return text;
    }
    return "";
  }

  function _extractUrl(v) {
    if (!v) return "";
    if (typeof v === "string") {
      return /^https?:\/\//i.test(v) || v.startsWith("//") ? v : "";
    }
    if (typeof v !== "object") return "";
    const direct =
      v.url || v.src || v.imageUrl || v.avatarUrl || v.logoUrl || v.link || v.href ||
      v.image?.url || v.image?.src || v.picture?.url || v.picture?.src;
    if (typeof direct === "string" && (/^https?:\/\//i.test(direct) || direct.startsWith("//"))) {
      return direct.startsWith("//") ? `https:${direct}` : direct;
    }
    return "";
  }

  function _findTextByKey(root, keyRe, textRe, depth = 0, seen = new Set()) {
    if (!root || typeof root !== "object" || depth > 5 || seen.has(root)) return "";
    seen.add(root);
    if (Array.isArray(root)) {
      for (const item of root) {
        const found = _findTextByKey(item, keyRe, textRe, depth + 1, seen);
        if (found) return found;
      }
      return "";
    }
    for (const [key, value] of Object.entries(root)) {
      const text = _extractText(value).trim();
      if (keyRe.test(key) && text && (!textRe || textRe.test(text))) return text;
      if (value && typeof value === "object") {
        const found = _findTextByKey(value, keyRe, textRe, depth + 1, seen);
        if (found) return found;
      }
    }
    return "";
  }

  function _parseDeliveryRank(text) {
    if (!text) return null;
    const s = String(text).toLowerCase();
    if (/сегодня|today|今天/.test(s)) return 0;
    if (/завтра|tomorrow|明天/.test(s)) return 1;
    const daysMatch = s.match(/(\d{1,2})\s*(?:дн|day|days|天)/i);
    if (daysMatch) return Number(daysMatch[1]);
    const now = new Date();
    const year = now.getFullYear();
    const cn = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (cn) {
      const dt = new Date(year, Number(cn[1]) - 1, Number(cn[2]));
      if (Number.isFinite(dt.getTime())) {
        if (dt.getTime() < now.getTime() - 7 * 86400000) dt.setFullYear(year + 1);
        return Math.max(0, Math.round((dt.getTime() - now.getTime()) / 86400000));
      }
    }
    const ruMonths = {
      "января": 0, "февраля": 1, "марта": 2, "апреля": 3, "мая": 4, "июня": 5,
      "июля": 6, "августа": 7, "сентября": 8, "октября": 9, "ноября": 10, "декабря": 11,
    };
    const ru = s.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/i);
    if (ru) {
      const dt = new Date(year, ruMonths[ru[2]], Number(ru[1]));
      if (Number.isFinite(dt.getTime())) {
        if (dt.getTime() < now.getTime() - 7 * 86400000) dt.setFullYear(year + 1);
        return Math.max(0, Math.round((dt.getTime() - now.getTime()) / 86400000));
      }
    }
    const iso = s.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (iso) {
      const dt = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
      if (Number.isFinite(dt.getTime())) return Math.max(0, Math.round((dt.getTime() - now.getTime()) / 86400000));
    }
    return null;
  }

  function _normalizeSeller(item) {
    if (!item || typeof item !== "object") return null;
    const name =
      _extractText(item.name) ||
      _extractText(item.sellerName) ||
      _extractText(item.seller?.name || item.seller) ||
      _extractText(item.title) ||
      _extractText(item.subtitle);
    // webSellerList shape: price = { cardPrice: { price: "16,87 ¥" }, ... }
    const priceRaw =
      item.price?.cardPrice?.price ??
      item.price?.cardPrice ??
      item.priceWithDiscount ?? item.finalPrice ?? item.price ??
      item.discountPrice ?? item.originalPrice ?? item.priceText;
    const price = _extractText(priceRaw);
    if (!name && !price) return null;
    const sku = _extractText(item.sku) || _extractText(item.id) || _extractText(item.skuId);
    // webSellerList shape: productLink = absolute url string
    const link =
      (typeof item.productLink === "string" ? item.productLink : "") ||
      item.link?.action?.link || item.link?.link || item.link ||
      item.action?.link || item.url || "";
    // webSellerList shape: rating = { totalScore: 3.5, reviewsCount: 163 }
    const rating =
      item.rating?.totalScore ?? item.rating?.value ?? item.rating ?? item.sellerRating ?? null;
    const reviewsCount =
      item.rating?.reviewsCount ?? item.rating?.reviews_count ?? item.reviewsCount ??
      item.reviewCount ?? item.sellerReviewsCount ?? null;
    const region = _extractText(item.region) || _extractText(item.location);
    const avatar =
      _extractUrl(item.avatar) ||
      _extractUrl(item.logo) ||
      _extractUrl(item.sellerLogo) ||
      _extractUrl(item.seller?.avatar) ||
      _extractUrl(item.seller?.logo) ||
      _extractUrl(item.image) ||
      _extractUrl(item.picture) ||
      _extractUrl(item.icon);
    // 2026-05-27:Ozon /modal/otherOffersFromSellers 实际把 delivery 藏在
    // advantages[i].contentRs.headRs[i].content,key="delivery"。之前的 fallback 链
    // 漏掉这条 → deliveryText 全 null → 排序"更快配送" tab 落到 price tiebreaker,
    // 跟"较低价格" tab 同顺序,user 感知 tab 切换无效。
    const _advantageDeliveryText = (() => {
      const advs = Array.isArray(item?.advantages) ? item.advantages : [];
      for (const a of advs) {
        if (a && (a.key === 'delivery' || a.iconKey === 'iconOrderPlane')) {
          const heads = a?.contentRs?.headRs;
          if (Array.isArray(heads)) {
            for (const h of heads) {
              if (h && typeof h.content === 'string' && h.content.trim()) return h.content.trim();
            }
          }
        }
      }
      return null;
    })();
    const deliveryText =
      _firstText(
        _advantageDeliveryText,
        item.deliveryText,
        item.deliveryDate,
        item.delivery?.text,
        item.delivery?.title,
        item.delivery?.subtitle,
        item.delivery?.description,
        item.delivery?.date,
        item.deliveryInfo,
        item.deliveryTerms,
        item.shipmentText,
        item.shipmentDate,
        item.shipment?.text,
        item.shipment?.title,
        item.shipment?.subtitle,
        item.shipment?.date,
        item.shippingText,
        item.shipping?.text,
        item.shipping?.title,
        item.shipping?.subtitle,
        item.shipping?.date,
        item.logistics?.delivery,
        item.logistics?.shipping
      ) ||
      _findTextByKey(
        item,
        /delivery|deliver|shipping|shipment|date|term|logistic|достав|отправ|срок/i,
        /\d|сегодня|завтра|today|tomorrow|достав|отправ|deliver|ship|月|日|天/i
      );
    const deliveryRank =
      _parseDeliveryRank(deliveryText) ??
      _parseDeliveryRank(_firstText(item.delivery?.date, item.deliveryDate, item.shipmentDate));
    return {
      name: typeof name === "string" ? name.trim() : "",
      price: typeof price === "string" ? price.trim() : "",
      sku: typeof sku === "string" ? sku.trim() : "",
      link: typeof link === "string" ? link : "",
      avatar,
      rating: Number.isFinite(Number(rating)) ? Number(rating) : null,
      reviewsCount: Number.isFinite(Number(reviewsCount)) ? Number(reviewsCount) : null,
      region: typeof region === "string" ? region.trim() : "",
      deliveryText: typeof deliveryText === "string" ? deliveryText.trim() : "",
      deliveryRank: Number.isFinite(Number(deliveryRank)) ? Number(deliveryRank) : null,
    };
  }
  // 2026-05 Ozon 把跟卖数据从商品页主响应里搬走了 — webOtherSellers/Followers/otherSellers
  // 等 widget 在 /api/composer-api.bx/page/json/v2?url=/product/<sku> 里全部消失。
  // 现在数据只在独立 modal endpoint 里:
  //   /api/composer-api.bx/page/json/v2?url=/modal/otherOffersFromSellers?product_id=<sku>
  // widgetStates['webSellerList-...'].sellers 是 normalized seller 数组(name/price/
  // sku/productLink/rating/delivery)。零跟卖时 webSellerList widget 不存在(widgetCount=5)。
  async function fetchFollowSellFromModal(sku) {
    const lang = (typeof document !== "undefined" && document.documentElement.lang) || "ru";
    const inner = `/modal/otherOffersFromSellers?product_id=${sku}`;
    const url = `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(inner)}`;
    const resp = await fetch(url, {
      credentials: "include",
      headers: {
        accept: "application/json",
        "x-o3-app-name": "dweb_client",
        "x-o3-language": lang,
      },
    });
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      console.error("[jz follow-sell] JSON parse failed", e);
      throw e;
    }
    const states = data?.widgetStates || {};
    if (!states || typeof states !== "object" || Object.keys(states).length === 0) {
      // 完全空响应 — 反爬退避 stub 或非法 sku,throw 走 failure tracking
      throw new Error(`empty widgetStates for sku=${sku}`);
    }
    const wslKey = Object.keys(states).find((k) => k.startsWith("webSellerList"));
    if (!wslKey) {
      // modal 正常加载但没有 webSellerList widget — 零跟卖商品
      return { count: 0, sellers: [], source: "no-sellers" };
    }
    let wsl = states[wslKey];
    if (typeof wsl === "string") {
      try { wsl = JSON.parse(wsl); } catch { return { count: 0, sellers: [], source: "parse-fail" }; }
    }
    const rawSellers = Array.isArray(wsl?.sellers) ? wsl.sellers : [];
    const sellers = rawSellers.map(_normalizeSeller).filter(Boolean);
    return { count: rawSellers.length, sellers, source: "modal" };
  }

  // 返回 { count, sellers } 或 null(失败/反爬退避中)
  // - count: number(跟卖卖家数)
  // - sellers: Array<{name, price, sku, link, avatar, rating, reviewsCount, region, deliveryText, deliveryRank}>
  // 历史调用方期望 number,有向后兼容包装 jzFetchPublicFollowSellCount。
  window.jzFetchPublicFollowSell = async function (sku) {
    if (!sku) return null;
    const cached = readFollowSellCache(sku);
    if (cached) return cached;
    if (readFollowSellMissCache(sku)) return null;
    if (Date.now() < followSellFailureState.pausedUntil) return null;

    try {
      const result = await fetchFollowSellFromModal(sku);
      followSellFailureState.timestamps = [];
      // 零跟卖也 cache(避免重复打 modal endpoint),但用较短 TTL — 商品获得首个跟卖
      // 后能在 30min 内刷新
      const ttl = result.count > 0 ? FOLLOW_SELL_CACHE_TTL_MS : 30 * 60 * 1000;
      writeFollowSellCache(sku, result.count, result.sellers, ttl);
      return { count: result.count, sellers: result.sellers };
    } catch (e) {
      console.error(`[jz follow-sell] modal fetch failed for sku=${sku}: ${e?.message || e}`);
      recordFollowSellFailure();
      return null;
    }
  };

  // 老 caller 兼容:返回 number(只要 count)。新 caller 用 jzFetchPublicFollowSell
  // 拿 { count, sellers } 完整结果。
  window.jzFetchPublicFollowSellCount = async function (sku) {
    const r = await window.jzFetchPublicFollowSell(sku);
    return r ? r.count : null;
  };

  let _followSellModalState = null;
  const FOLLOW_SELL_HOVER_CLOSE_DELAY_MS = 180;

  function _fsInitial(name) {
    const trimmed = String(name || "").trim();
    return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
  }

  function _fsColor(name) {
    let h = 0;
    const s = String(name || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 60%, 55%)`;
  }

  function _fsFormatReviews(n) {
    const num = Number(n);
    if (!Number.isFinite(num) || num <= 0) return "";
    const fmt = window.formatNumber ? window.formatNumber(num) : String(num);
    return `${fmt}\u6761\u8bc4\u8bba`;
  }

  function _fsParsePrice(priceStr) {
    if (!priceStr) return null;
    const normalized = String(priceStr).replace(/[^\d.,-]/g, "").replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(normalized);
    return Number.isFinite(n) ? n : null;
  }

  function _fsDeliveryRank(seller) {
    const rank = Number(seller?.deliveryRank);
    return Number.isFinite(rank) ? rank : null;
  }

  function _fsSortSellers(sellers, mode) {
    const sorted = sellers.map((seller, index) => ({ seller, index })).sort((a, b) => {
      if (mode === "delivery") {
        const ar = _fsDeliveryRank(a.seller);
        const br = _fsDeliveryRank(b.seller);
        if (ar != null || br != null) {
          if (ar == null) return 1;
          if (br == null) return -1;
          if (ar !== br) return ar - br;
        }
      }
      const ap = _fsParsePrice(a.seller.price);
      const bp = _fsParsePrice(b.seller.price);
      if (ap != null || bp != null) {
        if (ap == null) return 1;
        if (bp == null) return -1;
        if (ap !== bp) return ap - bp;
      }
      return a.index - b.index;
    });
    return sorted.map((item) => item.seller);
  }

  function _fsSellerStats(sellers) {
    let minPrice = Infinity;
    let fastestRank = Infinity;
    for (const seller of sellers) {
      const price = _fsParsePrice(seller.price);
      if (price != null && price < minPrice) minPrice = price;
      const rank = _fsDeliveryRank(seller);
      if (rank != null && rank < fastestRank) fastestRank = rank;
    }
    return {
      minPrice: minPrice === Infinity ? null : minPrice,
      fastestRank: fastestRank === Infinity ? null : fastestRank,
    };
  }

  function _fsRenderSellerRow(seller, flags = {}) {
    const sellerUrl = seller.link
      ? (seller.link.startsWith("http") ? seller.link : "https://www.ozon.ru" + seller.link)
      : "";
    const avatarHtml = seller.avatar
      ? `<img class="oh-seller-avatar" src="${_ohEsc(seller.avatar)}" alt="" loading="lazy" />`
      : `<span class="oh-seller-avatar oh-seller-avatar-fallback" style="background:${_fsColor(seller.name)}">${_ohEsc(_fsInitial(seller.name))}</span>`;
    const nameHtml = sellerUrl
      ? `<a class="oh-seller-name oh-seller-link" href="${_ohEsc(sellerUrl)}" target="_blank" rel="noopener">${_ohEsc(seller.name || "\u672a\u77e5\u5356\u5bb6")}</a>`
      : `<span class="oh-seller-name">${_ohEsc(seller.name || "\u672a\u77e5\u5356\u5bb6")}</span>`;
    const ratingHtml = typeof seller.rating === "number"
      ? `<span class="oh-seller-rating">\u2605 ${seller.rating.toFixed(1)}</span>`
      : "";
    const reviewsText = _fsFormatReviews(seller.reviewsCount);
    const reviewsHtml = reviewsText ? `<span class="oh-seller-reviews">${_ohEsc(reviewsText)}</span>` : "";
    const regionHtml = seller.region ? `<span class="oh-seller-region">${_ohEsc(seller.region)}</span>` : "";
    const skuHtml = seller.sku ? `<span class="oh-seller-sku">SKU ${_ohEsc(seller.sku)}</span>` : "";
    const priceHtml = seller.price
      ? `<span class="oh-seller-price${flags.isMinPrice ? " is-min" : ""}">${_ohEsc(seller.price)}${flags.isMinPrice ? ' <span class="oh-seller-tag is-price">\u6700\u4f4e</span>' : ""}</span>`
      : `<span class="oh-seller-price oh-seller-price-empty">-</span>`;
    const deliveryHtml = seller.deliveryText
      ? `<span class="oh-seller-delivery-main">${_ohEsc(seller.deliveryText)}</span>`
      : `<span class="oh-seller-delivery-main is-muted">\u914d\u9001\u4fe1\u606f\u672a\u8fd4\u56de</span>`;
    const fastestTag = flags.isFastest
      ? `<span class="oh-seller-tag is-delivery">\u6700\u5feb</span>`
      : "";
    return `
      <div class="oh-seller-row${flags.isMinPrice ? " is-min" : ""}${flags.isFastest ? " is-fastest" : ""}">
        <div class="oh-seller-cell oh-seller-avatar-cell">${avatarHtml}</div>
        <div class="oh-seller-cell oh-seller-name-cell">
          ${nameHtml}
          <div class="oh-seller-meta">${ratingHtml}${reviewsHtml}${regionHtml}${skuHtml}</div>
        </div>
        <div class="oh-seller-cell oh-seller-price-cell">${priceHtml}</div>
        <div class="oh-seller-cell oh-seller-delivery-cell">
          <span class="oh-seller-delivery-icon">${window.lucideIcon ? window.lucideIcon("truck", 14) : ""}</span>
          <span class="oh-seller-delivery-text">${deliveryHtml}${fastestTag}</span>
        </div>
      </div>
    `;
  }

  function _fsRenderSellerList(sellers, mode, totalCount) {
    const stats = _fsSellerStats(sellers);
    const sorted = _fsSortSellers(sellers, mode);
    return `
      <div class="oh-seller-list">
        ${sorted.map((seller) => {
          const price = _fsParsePrice(seller.price);
          const rank = _fsDeliveryRank(seller);
          return _fsRenderSellerRow(seller, {
            isMinPrice: stats.minPrice != null && price != null && price === stats.minPrice,
            isFastest: stats.fastestRank != null && rank != null && rank === stats.fastestRank,
          });
        }).join("")}
      </div>
      ${sellers.length < totalCount
        ? `<div class="oh-modal-partial">\u5df2\u663e\u793a ${sellers.length} / ${totalCount},\u5b8c\u6574\u5217\u8868\u70b9\u51fb\u4e0b\u65b9\u6309\u94ae\u67e5\u770b</div>`
        : ""}
    `;
  }

  function _fsRenderSkeletonRows(n) {
    let html = "";
    for (let i = 0; i < n; i++) {
      html += `
        <div class="oh-seller-row oh-seller-row-skeleton">
          <div class="oh-seller-cell oh-seller-avatar-cell"><span class="oh-skeleton oh-skeleton-circle"></span></div>
          <div class="oh-seller-cell oh-seller-name-cell">
            <span class="oh-skeleton oh-skeleton-line" style="width:55%"></span>
            <span class="oh-skeleton oh-skeleton-line oh-skeleton-line-sm" style="width:30%;margin-top:6px"></span>
          </div>
          <div class="oh-seller-cell oh-seller-price-cell"><span class="oh-skeleton oh-skeleton-line" style="width:60px"></span></div>
          <div class="oh-seller-cell oh-seller-delivery-cell"><span class="oh-skeleton oh-skeleton-line" style="width:132px"></span></div>
        </div>`;
    }
    return html;
  }

  function _fsRenderEmpty(modal, totalCount, ozonModalUrl) {
    const body = modal.querySelector(".oh-modal-body");
    if (!body) return;
    body.dataset.state = "empty";
    body.innerHTML = `
      <div class="oh-modal-empty-state">
        <div class="oh-modal-empty-icon">${window.lucideIcon ? window.lucideIcon("users", 28) : ""}</div>
        <div class="oh-modal-empty-title">${totalCount > 0 ? `${totalCount} \u4e2a\u8ddf\u5356\u5546\u5bb6` : "\u6682\u65e0\u8ddf\u5356\u5546\u5bb6"}</div>
        <div class="oh-modal-empty-hint">${totalCount > 0 ? "\u5b8c\u6574\u5356\u5bb6\u5217\u8868(\u542b\u4ef7\u683c\u3001\u914d\u9001\u3001\u8bc4\u5206)\u8bf7\u5728 Ozon \u67e5\u770b" : "\u8be5\u5546\u54c1\u5f53\u524d\u6ca1\u6709\u5176\u4ed6\u5546\u5bb6\u8ddf\u5356"}</div>
        ${ozonModalUrl && totalCount > 0
          ? `<a class="oh-modal-empty-btn" href="${_ohEsc(ozonModalUrl)}" target="_blank" rel="noopener">\u5728 Ozon \u67e5\u770b -></a>`
          : ""}
      </div>
    `;
  }

  function _fsCloseExistingModal() {
    if (_followSellModalState?.close) _followSellModalState.close();
    else document.querySelector(".ozon-helper-follow-modal")?.remove();
    _followSellModalState = null;
  }

  window.jzShowFollowSellListModal = async function (anchor, product = {}, options = {}) {
    if (!anchor || typeof anchor.getBoundingClientRect !== "function") return null;
    const sku = String(product.sku || product.productId || product.product_id || "").trim();
    if (
      _followSellModalState?.modal?.isConnected &&
      _followSellModalState.anchor === anchor &&
      String(_followSellModalState.sku || "") === sku
    ) {
      _followSellModalState.clearCloseTimer?.();
      return _followSellModalState.modal;
    }

    _fsCloseExistingModal();

    const totalCount = Number(product.followSellCount) || 0;
    const ozonModalUrl = sku ? `https://www.ozon.ru/product/${sku}/?prefer_sellers=true` : null;
    let activeSellerMode = "price";
    let loadedSellers = [];
    let loadedTotalCount = totalCount;
    let closeTimer = null;
    const cleanups = [];

    const modal = document.createElement("div");
    modal.className = "ozon-helper-follow-modal";
    modal.innerHTML = `
      <div class="oh-modal-header">
        <div class="oh-modal-title">
          <span class="oh-modal-title-text">\u8ddf\u5356\u5546\u5bb6\u5217\u8868</span>
          <span class="oh-modal-title-count">${totalCount}</span>
        </div>
        <button class="oh-modal-close" type="button" aria-label="\u3000\u95ed">&times;</button>
      </div>
      <div class="oh-modal-tabs" role="tablist" aria-label="\u8ddf\u5356\u5546\u5bb6\u5206\u7c7b">
        <button class="oh-modal-tab" type="button" data-seller-mode="delivery" role="tab" aria-selected="false">
          <span class="oh-modal-tab-label">\u66f4\u5feb\u914d\u9001</span>
        </button>
        <button class="oh-modal-tab is-active" type="button" data-seller-mode="price" role="tab" aria-selected="true">
          <span class="oh-modal-tab-label">\u8f83\u4f4e\u4ef7\u683c</span>
        </button>
      </div>
      <div class="oh-modal-body" data-state="loading">
        <div class="oh-seller-list">${_fsRenderSkeletonRows(5)}</div>
      </div>
      <div class="oh-modal-footer">
        ${ozonModalUrl
          ? `<a class="oh-modal-cta" href="${_ohEsc(ozonModalUrl)}" target="_blank" rel="noopener">\u5728 Ozon \u67e5\u770b\u5b8c\u6574\u5217\u8868 -></a>`
          : ""}
      </div>
    `;

    const rect = anchor.getBoundingClientRect();
    modal.style.position = "fixed";
    const modalWidth = Math.min(720, window.innerWidth - 24);
    let left = rect.left + rect.width / 2 - modalWidth / 2;
    if (left < 10) left = 10;
    if (left + modalWidth > window.innerWidth - 10) left = window.innerWidth - modalWidth - 10;
    const modalHeight = Math.min(620, window.innerHeight - 20);
    let top = rect.bottom + 8;
    if (top + modalHeight > window.innerHeight) top = Math.max(10, rect.top - modalHeight - 8);
    modal.style.top = `${top}px`;
    modal.style.left = `${left}px`;
    document.body.appendChild(modal);

    const clearCloseTimer = () => {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = null;
    };
    const shouldStayOpen = () => {
      try {
        return (anchor.isConnected && anchor.matches(":hover")) || modal.matches(":hover");
      } catch {
        return false;
      }
    };
    const close = () => {
      clearCloseTimer();
      cleanups.splice(0).forEach((fn) => {
        try { fn(); } catch {}
      });
      modal.remove();
      if (_followSellModalState?.modal === modal) _followSellModalState = null;
    };
    const scheduleClose = (delay = FOLLOW_SELL_HOVER_CLOSE_DELAY_MS) => {
      clearCloseTimer();
      closeTimer = setTimeout(() => {
        closeTimer = null;
        if (!shouldStayOpen()) close();
      }, delay);
    };
    const on = (el, type, fn) => {
      el.addEventListener(type, fn);
      cleanups.push(() => el.removeEventListener(type, fn));
    };

    _followSellModalState = { anchor, modal, sku, close, clearCloseTimer, scheduleClose };

    modal.querySelector(".oh-modal-close")?.addEventListener("click", close);
    if (options.trigger === "hover") {
      on(anchor, "mouseenter", clearCloseTimer);
      on(anchor, "mouseleave", () => scheduleClose());
      on(modal, "mouseenter", clearCloseTimer);
      on(modal, "mouseleave", () => scheduleClose());
    }

    const updateTabs = () => {
      modal.querySelectorAll("[data-seller-mode]").forEach((btn) => {
        const active = btn.dataset.sellerMode === activeSellerMode;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      });
    };
    const renderLoadedSellers = () => {
      const body = modal.querySelector(".oh-modal-body");
      if (!body || loadedSellers.length === 0) return;
      body.dataset.state = "ready";
      body.innerHTML = _fsRenderSellerList(loadedSellers, activeSellerMode, loadedTotalCount);
    };

    modal.addEventListener("click", (e) => {
      const modeBtn = e.target?.closest?.("[data-seller-mode]");
      if (!modeBtn || !modal.contains(modeBtn)) return;
      activeSellerMode = modeBtn.dataset.sellerMode || "price";
      updateTabs();
      renderLoadedSellers();
    });

    setTimeout(() => {
      const offHandler = (e) => {
        if (!modal.contains(e.target) && !anchor.contains(e.target)) close();
      };
      document.addEventListener("click", offHandler);
      cleanups.push(() => document.removeEventListener("click", offHandler));
    }, 0);

    if (!sku || !window.jzFetchPublicFollowSell) {
      _fsRenderEmpty(modal, totalCount, ozonModalUrl);
      return modal;
    }

    let result = null;
    try {
      result = await window.jzFetchPublicFollowSell(sku);
    } catch (e) {
      console.warn("[follow-sell modal] fetch failed", e);
    }
    if (!modal.isConnected) return modal;

    const sellers = (result && Array.isArray(result.sellers)) ? result.sellers : [];
    loadedTotalCount = Math.max(totalCount, Number(result?.count) || 0, sellers.length);
    const countEl = modal.querySelector(".oh-modal-title-count");
    if (countEl) countEl.textContent = String(loadedTotalCount);
    if (sellers.length === 0) {
      _fsRenderEmpty(modal, loadedTotalCount, ozonModalUrl);
      return modal;
    }

    loadedSellers = sellers;
    updateTabs();
    renderLoadedSellers();
    return modal;
  };

  window.jzBindFollowSellHover = function (root) {
    if (!root || root._jzFollowSellHoverBound) return () => {};
    root._jzFollowSellHoverBound = true;
    // Compatibility no-op: follow-sell seller list is click-only again.
    // The actual click dispatch lives in ozon-product / ozon-search / ozon-data-panel.
    return () => {
      root._jzFollowSellHoverBound = false;
    };
  };

  // ── 重量/尺寸 chrome.storage.local 跨 tab cache ────────────────
  // 详情页(ozon-product.js / jzc-calc.js)抓到重量/尺寸 → 写入这里;
  // 搜索页/列表页/其他 tab 在 sv 调用失败/未登录场景下作为兜底。
  //
  // 2026-05 后主路径 — sw.js searchVariants 已切到 /api/v1/search + bundle 注入
  // 物理 attr,数据卡片 jzMergeCardPanelData 直接从 sv items[0].attributes
  // 4497/9454-9456 命中,不再依赖公共 /features/ 兜底(老 /features/ 路径
  // 已删除,因为 Ozon 公开页对小百货/服饰类目几乎不暴露物理参数,覆盖率太低)。
  //
  // 此 cache 仍保留作为「sv 失败/auth issue」时的额外兜底,30 天 TTL,合并
  // 更新策略(新数据 fill in null 字段,不覆盖已有非空)。
  const WD_LOCAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const _wdLocalKey = (sku) => `jz-wd-local:${sku}`;

  async function _readPersistentWeightDims(sku) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage?.local) { resolve(null); return; }
        chrome.storage.local.get([_wdLocalKey(sku)], (data) => {
          const v = data?.[_wdLocalKey(sku)];
          if (!v) { resolve(null); return; }
          if (Date.now() - (v.at || 0) > WD_LOCAL_TTL_MS) { resolve(null); return; }
          if (v.weightG == null && v.lengthMm == null && v.widthMm == null && v.heightMm == null) {
            resolve(null); return;
          }
          resolve({
            weightG: v.weightG ?? null,
            lengthMm: v.lengthMm ?? null,
            widthMm: v.widthMm ?? null,
            heightMm: v.heightMm ?? null,
          });
        });
      } catch { resolve(null); }
    });
  }

  // 公开 persist 入口 — ozon-product.js / jzc-calc.js 抓到数据后调
  // source: 'sv-attrs' | 'jzc-dom' | 'jzc-composer' | 'jzc-seller' 等
  window.jzPersistWeightDims = function (sku, dims, source) {
    if (!sku || !dims) return;
    const w = dims.weightG != null && Number.isFinite(+dims.weightG) && +dims.weightG > 0 ? Math.round(+dims.weightG) : null;
    const l = dims.lengthMm != null && Number.isFinite(+dims.lengthMm) && +dims.lengthMm > 0 ? Math.round(+dims.lengthMm) : null;
    const wi = dims.widthMm != null && Number.isFinite(+dims.widthMm) && +dims.widthMm > 0 ? Math.round(+dims.widthMm) : null;
    const h = dims.heightMm != null && Number.isFinite(+dims.heightMm) && +dims.heightMm > 0 ? Math.round(+dims.heightMm) : null;
    if (w == null && l == null && wi == null && h == null) return;

    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
      chrome.storage.local.get([_wdLocalKey(sku)], (existing) => {
        const old = existing?.[_wdLocalKey(sku)];
        const merged = {
          at: Date.now(),
          source: source || 'unknown',
          weightG: w ?? old?.weightG ?? null,
          lengthMm: l ?? old?.lengthMm ?? null,
          widthMm: wi ?? old?.widthMm ?? null,
          heightMm: h ?? old?.heightMm ?? null,
        };
        chrome.storage.local.set({ [_wdLocalKey(sku)]: merged });
      });
    } catch {}
  };

  // 只读 cache 入口,数据卡片 sv 失败时兜底用。
  // 返 { weightG, lengthMm, widthMm, heightMm } 或 null(无 cache)。
  window.jzReadCachedWeightDims = _readPersistentWeightDims;

  // 调试入口:`jzDebugWeightDims('1234567')` → dump cache 状态
  window.jzDebugWeightDims = async function (sku) {
    if (!sku) {
      console.error('[jz-debug-wd] usage: jzDebugWeightDims("<sku>")');
      return null;
    }
    const cached = await _readPersistentWeightDims(String(sku));
    const out = { sku, cached };
    console.log('[jz-debug-wd]', out);
    return out;
  };

  // 调试入口:控制台直接 `jzDebugFollowSell('1234567')` 查看 widgetStates 命中详情。
  // 排查 hero 跟卖卡显示 — 的根因:widget key 是否漂移、是否触发反爬 stub、cache 状态。
  window.jzDebugFollowSell = async function (sku) {
    if (!sku) {
      console.error('[jz-debug-fs] usage: jzDebugFollowSell("<sku>")');
      return null;
    }
    const lang = (typeof document !== 'undefined' && document.documentElement.lang) || 'ru';
    const out = { sku, lang, cache: null, miss: null, paused: false };
    try {
      const raw = sessionStorage.getItem(`jz-fs5:${sku}`);
      out.cache = raw ? JSON.parse(raw) : null;
    } catch {}
    try {
      const raw = sessionStorage.getItem(`jz-fs2-miss:${sku}`);
      out.miss = raw ? JSON.parse(raw) : null;
    } catch {}
    out.paused = Date.now() < followSellFailureState.pausedUntil;
    const inner = `/modal/otherOffersFromSellers?product_id=${sku}`;
    const url = `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(inner)}`;
    out.endpoint = url;
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { accept: 'application/json', 'x-o3-app-name': 'dweb_client', 'x-o3-language': lang },
      });
      out.status = resp.status;
      const data = await resp.json();
      const states = data?.widgetStates || {};
      out.widgetCount = Object.keys(states).length;
      out.widgetKeys = Object.keys(states);
      const wslKey = Object.keys(states).find((k) => k.startsWith('webSellerList'));
      out.wslKey = wslKey || null;
      if (wslKey) {
        let wsl = states[wslKey];
        if (typeof wsl === 'string') { try { wsl = JSON.parse(wsl); } catch {} }
        const rawSellers = Array.isArray(wsl?.sellers) ? wsl.sellers : [];
        out.rawSellerCount = rawSellers.length;
        out.normalizedSample = rawSellers.slice(0, 3).map(_normalizeSeller);
      } else {
        out.rawSellerCount = 0;
      }
    } catch (e) {
      out.error = e?.message || String(e);
    }
    console.log('[jz-debug-fs]', out);
    return out;
  };

  // ============================================================
  // jzRenderProductPanelV2 — 完整 PDP-style 数据面板(对齐详情页)
  // ============================================================
  // 列表页商品卡片下方的数据面板 v2,跟商品详情页(extension/content/ozon-product.js
  // line 1879+ sections 数组)1:1 对齐:5 个 section + hero。
  //
  // 用法:
  //   1. window.jzRenderProductPanelV2(panel, { sku, initial })  → 渲染骨架
  //   2. window.jzPopulatePanelV2(panel, sku, info)               → fetch + 异步更新字段
  //
  // 数据源跟 PDP 同(getProductStats / getMarketStats / searchVariants /
  // jzFetchPublicFollowSellCount),后端 /ozon/product-data/:sku 已经返了 PDP
  // 用的全部字段(categoryL1/L3, brand, commissionRfbs/Fbp×3档, daysInPromo,
  // pdpViews, searchViews, clickRate 等)。
  //
  // updateField helper 跟 PDP line 2256+ 同款语义:`panel.querySelector(
  // `[data-field="${name}"]`)` 找到 placeholder 节点,innerHTML / classList 更新。
  // ============================================================

  function _v2Escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.jzSafeCopyText = window.jzSafeCopyText || async function (text) {
    if (text == null) return false;
    const value = String(text);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {}

    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, value.length);
      const ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch {
      return false;
    }
  };

  window.jzBindDataCardCopyButtons = window.jzBindDataCardCopyButtons || function (root) {
    if (!root || root._jzCopyButtonsBound) return;
    root._jzCopyButtonsBound = true;
    root.addEventListener('click', async (e) => {
      const btn = e.target?.closest?.('.ozon-helper-copy-btn');
      if (!btn || !root.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();

      const original = btn.dataset.copyIcon || btn.innerHTML || _v2Icon('copy', 12);
      btn.dataset.copyIcon = original;
      const ok = await window.jzSafeCopyText(btn.dataset.copy);
      btn.textContent = ok ? '\u2713' : '\u2716';
      btn.classList.toggle('is-copied', ok);
      btn.classList.toggle('is-copy-failed', !ok);
      setTimeout(() => {
        btn.innerHTML = btn.dataset.copyIcon || _v2Icon('copy', 12);
        btn.classList.remove('is-copied', 'is-copy-failed');
      }, 1200);
    }, true);
  };

  function _v2RenderHeroStat(r) {
    const accentCls = r.accent ? ` is-accent-${r.accent}` : '';
    const isDim = r.value == null || r.value === '-';
    const dimCls = isDim ? ' is-dim' : '';
    const clickCls = r.clickAction ? ' is-clickable' : '';
    const tipAttr = r.tip ? ` data-oh-tip="${_v2Escape(r.tip)}"` : '';
    const clickAttr = r.clickAction ? ` data-click-action="${_v2Escape(r.clickAction)}"` : '';
    const hasSubSlot = Object.prototype.hasOwnProperty.call(r, 'sub');
    const subHtml = hasSubSlot ? `<small>${r.sub ? _v2Escape(r.sub) : ''}</small>` : '';
    return `<div class="oh-hero-stat${accentCls}${clickCls}"${tipAttr}${clickAttr}>
      <div class="oh-hero-label">${_v2Escape(r.label)}</div>
      <div class="oh-hero-value${dimCls}" data-field="${_v2Escape(r.field)}">${r.value || '-'}${subHtml}</div>
    </div>`;
  }

  function _v2RenderRow(r) {
    const valueContent = r.raw
      ? r.value
      : `${_v2Escape(r.value)}${r.copyable ? ' <span class="ozon-helper-copy-btn" data-copy="' + _v2Escape(r.value) + '">' + (window.lucideIcon ? window.lucideIcon('copy', 12) : '⧉') + '</span>' : ''}`;
    const colorCls = r.color ? ` is-${r.color}` : '';
    const dimCls = r.value === '-' ? ' is-dim' : '';
    const fullCls = r.full ? ' is-full-row' : '';
    const tipAttr = r.tip ? ` data-oh-tip="${_v2Escape(r.tip)}"` : '';
    return `<div class="ozon-helper-sidebar-card-row${fullCls}">
      <span class="ozon-helper-sidebar-card-label"${tipAttr}>${_v2Escape(r.label)}</span>
      <span class="ozon-helper-sidebar-card-value${colorCls}${dimCls}" data-field="${_v2Escape(r.field)}">${valueContent}</span>
    </div>`;
  }

  function _v2RenderSection(section) {
    if (section.type === 'hero') {
      return `<div class="oh-hero-section">${section.rows.map(_v2RenderHeroStat).join('')}</div>`;
    }
    const accentCls = section.accent ? ` is-accent-${section.accent}` : '';
    const iconHtml = section.icon || '';
    return `<div class="ozon-helper-sidebar-section${accentCls}" data-section="${_v2Escape(section.id)}">
      <div class="ozon-helper-sidebar-section-header" data-action="toggle-section">
        <span><span class="oh-section-icon">${iconHtml}</span>${_v2Escape(section.title)}</span>
        <span class="ozon-helper-sidebar-chevron">▼</span>
      </div>
      <div class="ozon-helper-sidebar-section-body">
        ${section.rows.map(_v2RenderRow).join('')}
      </div>
    </div>`;
  }

  // Lucide icons placeholder — content scripts that use shared-utils 通常已经
  // 加载 lucide.js / 提供 window.lucideIcon。这里用 fallback emoji 防止 undefined。
  function _v2Icon(name, size = 14) {
    if (typeof window.lucideIcon === 'function') return window.lucideIcon(name, size);
    const fallback = { package: '📦', target: '🎯', 'bar-chart': '📊', truck: '🚚', link: '🔗', zap: '⚡' };
    return fallback[name] || '·';
  }

  /**
   * 渲染完整 PDP-style 5-section + hero 面板骨架(字段全 '-' placeholder)。
   * 之后调 jzPopulatePanelV2 异步 fetch + updateField 填值。
   */
  window.jzRenderProductPanelV2 = function (panel, opts = {}) {
    const initial = opts.initial || {};
    const sku = String(opts.sku || initial.sku || '-');
    const showActions = opts.showActions !== false;

    // 体积(升)初值:有 mm 三维就直接算,否则 '-'(jzPopulatePanelV2 异步补)。
    const _v2Vol = window.jzVolumeLiters(initial.lengthMm, initial.widthMm, initial.heightMm);
    const _v2InitialVolume = _v2Vol != null ? `${_v2Vol} L` : '-';

    const sections = [
      {
        id: 'hero', type: 'hero', rows: [
          { field: 'sales30d', label: `${window.jzSalesPeriodCnShort?.() || '月'}销量`, value: initial.sales30d || '-', accent: 'blue', tip: `商品${window.jzSalesPeriodCnLong?.() || '近 30 天'}销售数量` },
          { field: 'createDate', label: '上架时间', value: initial.createDate || '-', accent: 'green', tip: '商品首次上架的日期' },
          {
            field: 'heroFollow', label: '跟卖',
            value: initial.followSellCount != null ? String(initial.followSellCount) : '-',
            sub: initial.followSellCount != null ? '卖家' : '',
            accent: 'orange',
            clickAction: 'show-followsell-modal',
            tip: '\u70b9\u51fb\u67e5\u770b\u8ddf\u5356\u5546\u5bb6\u5217\u8868',
          },
          {
            field: 'heroSize', label: '重量·尺寸',
            value: initial.heroSizeMain || '-',
            sub: initial.heroSizeSub || '',
            accent: 'purple',
            tip: '商品重量(g) · 长×宽×高(mm)',
          },
        ],
      },
      {
        id: 'info', icon: _v2Icon('package'), title: '商品信息', accent: 'blue', rows: [
          { field: 'category', label: '一级类目', value: '-', tip: '商品一级类目', full: true },
          { field: 'categoryL3', label: '三级类目', value: '-', tip: '商品三级(末级)类目', full: true },
          { field: 'sku', label: 'SKU', value: sku, copyable: true, tip: '商品SKU', full: true },
          { field: 'brand', label: '品牌', value: '-', color: 'orange', tip: '商品品牌' },
          { field: 'salesSchema', label: '发货模式', value: '-', tip: '商品发货模式' },
          { field: 'commRfbs', label: 'rFBS佣金', value: '-', color: 'orange', tip: '按商品售价档位收取的佣金比例', full: true },
          { field: 'commFbp', label: 'FBP佣金', value: '-', color: 'orange', tip: '按商品售价档位收取的佣金比例', full: true },
          { field: 'revenue30d', label: `${window.jzSalesPeriodCnShort?.() || '月'}销售额`, value: '-', color: 'blue', tip: `商品${window.jzSalesPeriodCnLong?.() || '近 30 天'}销售额` },
          { field: 'salesDynamics', label: `${window.jzSalesPeriodCnShort?.() || '月'}周转动态`, value: '-', tip: `与${window.jzSalesPeriodCnPrev?.() || '上一个月'}相比订单金额总和发生了怎样的变化` },
          { field: 'dailySales', label: '日销量', value: '-', color: 'blue', tip: `${window.jzSalesPeriodCnUnit?.() || '近一个月'}销售件数,除以商品有现货的天数` },
          { field: 'dailyRevenue', label: '日销售额', value: '-', color: 'blue', tip: `${window.jzSalesPeriodCnUnit?.() || '近一个月'}销售金额除以商品有现货的天数` },
          { field: 'drr', label: '广告费占比', value: '-', tip: '商品推广费用占所有订单金额的百分比', full: true },
        ],
      },
      {
        id: 'promo', icon: _v2Icon('target'), title: '促销推广', accent: 'orange', rows: [
          { field: 'daysInPromo', label: '促销天数', value: '-', tip: '商品近一个月参与促销的天数' },
          { field: 'promoDiscount', label: '促销折扣', value: '-', tip: '近一个月参与促销的平均折扣' },
          { field: 'promoConvRate', label: '促销转化率', value: '-', color: 'green', tip: '促销期间订购的金额,在总订购金额的占比' },
          { field: 'daysWithAds', label: '推广天数', value: '-', tip: '近一个月参与模版付费推广的天数' },
        ],
      },
      {
        id: 'traffic', icon: _v2Icon('bar-chart'), title: '流量转化', accent: 'green', rows: [
          { field: 'pdpViews', label: '卡片浏览', value: '-', tip: '买家打开商品卡片的次数' },
          { field: 'pdpCartRate', label: '卡片加购率', value: '-', tip: '商品卡片浏览次数与浏览后将商品添加到购物车的数量之间的比例' },
          { field: 'searchViews', label: '搜索浏览', value: '-', tip: '买家在搜索结果中和类目中查看商品的次数' },
          { field: 'searchCartRate', label: '搜索加购率', value: '-', tip: '商品添加到购物车的次数与在目录和搜索结果中浏览次数之间的比例' },
          { field: 'convViewToOrder', label: '展示转化率', value: '-', tip: '商品在网站所有页面上的展示次数与订单数量的比例' },
          { field: 'clickRate', label: '点击率', value: '-', color: 'orange', tip: '买家点击商品的次数与商品在网站所有页面上的展示次数之间的比例' },
        ],
      },
      {
        id: 'logistics', icon: _v2Icon('truck'), title: '物流详情', accent: 'purple', rows: [
          { field: 'returnRate', label: '退货率', value: '-', color: 'red', tip: '商品退货取消率' },
          { field: 'rating', label: '评分', value: '-', color: 'gold', tip: '商品评分及评论数量' },
          { field: 'dimensions', label: '长宽高', value: '-', tip: '商品长宽高(毫米)', full: true },
          {
            field: 'volume', label: '体积',
            value: _v2InitialVolume,
            tip: '按长×宽×高估算的体积(升)', full: true,
          },
          { field: 'weight', label: '重量', value: '-', tip: '商品重量(克)', full: true },
        ],
      },
    ];

    const actionsHtml = showActions ? `<div class="ozon-helper-sidebar-card-actions">
      <button class="ozon-helper-sidebar-card-btn is-primary" data-action="follow-sell">
        <span class="oh-btn-icon">${_v2Icon('link', 14)}</span>一键跟卖
      </button>
      <div class="ozon-helper-sidebar-card-actions-row">
        <button class="ozon-helper-sidebar-card-btn" data-action="edit-list">编辑上架</button>
        <button class="ozon-helper-sidebar-card-btn" data-action="collect-one">采集</button>
      </div>
    </div>` : '';

    panel.innerHTML = `
      <div class="ozon-helper-sidebar-card-header">
        <span class="ozon-helper-sidebar-card-logo"><span class="oh-logo-icon">${_v2Icon('zap')}</span>${(globalThis.__JZ_BRAND__ && globalThis.__JZ_BRAND__.displayName) || BRAND_DISPLAY_NAME_FALLBACK}ERP</span>
        ${window.jzFieldSettingsGearHtml()}
      </div>
      <div class="ozon-helper-sidebar-card-body">
        ${sections.map(_v2RenderSection).join('')}
      </div>
      ${actionsHtml}`;

    // 标记为数据卡 + 应用当前显隐(齿轮点击由 caller 的 [data-action] 委托统一捕获)。
    panel.setAttribute('data-jz-datacard', '1');
    window.jzBindDataCardCopyButtons(panel);
    window.jzLoadFieldVisibility().then((v) => window.jzApplyFieldVisibility(panel, v));
  };

  /**
   * 佣金价格档:Ozon 跨境按售价分 3 档(≤1500₽ / 1500~5000₽ / >5000₽)收佣。
   * priceRub<=0(售价未知)→ -1。真值见 backend/src/ozon/data/ozon-commission-table.ts。
   */
  window.jzCommissionTierIndex = function (priceRub) {
    const p = Number(priceRub);
    if (!(p > 0)) return -1;
    return p <= 1500 ? 0 : p <= 5000 ? 1 : 2;
  };

  /**
   * 解析用于佣金「档位」的 RUB 单价,优先级:
   *   后端 product-data 的 priceRub > 调用方传入的页面 RUB 单价 > 月均价(月销额/月销量)。
   * 返回 0 = 无从判断(jzRenderCommissionTier 会退回三档全显)。
   * 加这个是因为后端 priceRub 常缺失、且 PDP 的页面币种检测可能为 null,导致档位选不出来
   * → 卡片三档全列、看不到"具体命中哪档"。月均价是 priceRub 缺失时的兜底(档位粒度够粗,够用)。
   */
  window.jzResolveCommPriceRub = function (data, pageRub) {
    data = data || {};
    if (Number(data.priceRub) > 0) return Number(data.priceRub);
    if (Number(pageRub) > 0) return Number(pageRub);
    const rev = Number(data.revenue30dRub);
    const units = Number(data.sales30d);
    if (rev > 0 && units > 0) return rev / units;
    return 0;
  };
  // 按售价只渲染命中的那一档佣金(单个 oh-tag,保留档位配色);售价未知时退回三档全显
  // (无从择一)。PDP 面板与列表卡片共用,保证口径一致。
  window.jzRenderCommissionTier = function (r1, r2, r3, priceRub) {
    const rates = [Number(r1), Number(r2), Number(r3)];
    const meta = [
      { cls: 'oh-tag-blue', label: '≤1500₽' },
      { cls: 'oh-tag-orange', label: '1500~5000₽' },
      { cls: 'oh-tag-magenta', label: '>5000₽' },
    ];
    const i = window.jzCommissionTierIndex(priceRub);
    if (i < 0) {
      return rates
        .map(
          (rate, k) =>
            `<span class="oh-tag ${meta[k].cls}" data-oh-tip="售价 ${meta[k].label}">${rate}%</span>`,
        )
        .join('');
    }
    const m = meta[i];
    const tip = `当前售价 ₽${window.formatNumber(Math.round(Number(priceRub)))} → 适用「${m.label}」档佣金`;
    return `<span class="oh-tag ${m.cls}" data-oh-tip="${tip}">${rates[i]}%</span>`;
  };

  /**
   * 给已渲染的 v2 面板灌数据。fetch 同 PDP 路径(getProductStats / getMarketStats /
   * searchVariants / jzFetchPublicFollowSellCount),用 updateField 异步填充每个
   * data-field 节点。
   *
   * 这是**所有数据卡的唯一灌数实现**(PDP 侧栏卡 + 搜索/类目卡 + 全站 tile 卡)。
   * PDP 旧的 fetchBackendProductData 平行实现已删,口径漂移(空值0/格式/优先级)由此收敛。
   *
   * info 选项:
   *   preFetched   — 复用调用方已 fetch 的 SettledResult(列表卡)
   *   catIds       — PDP 面包屑买家类目 id,透传后端佣金按 ID 精确分档
   *   pageRub      — 页面实价(PDP 页价/列表 tile 价,RUB),佣金定档优先于月均价
   *   noFollowFetch— PDP 页面 widget 已带跟卖数,跳过 composer followCount 请求
   *   persistDims  — PDP 专用:sv 真值写本地缓存 + 回写服务端 ozon_sku_dims
   *   onFeatureGated — 后端 __featureGated 时的锁定态渲染回调
   */
  window.jzPopulatePanelV2 = async function (panel, sku, info = {}) {
    if (!panel || !sku) return;
    const skuStr = String(sku);

    const updateField = (name, value, color, persistent, opts = {}) => {
      const el = panel.querySelector(`[data-field="${name}"]`);
      if (!el) return;
      if (persistent) el.dataset.persistent = '1';
      else if (el.dataset.persistent === '1') return;
      // hero stat 节点带 <small> 子元素;只更新主文本,保留 <small>
      const small = el.querySelector(':scope > small');
      if (opts.raw) {
        el.innerHTML = (value == null ? '-' : value) + (small ? small.outerHTML : '');
      } else {
        el.innerHTML = _v2Escape(value == null ? '-' : value) + (small ? small.outerHTML : '');
      }
      if (color) {
        el.classList.remove('is-blue', 'is-orange', 'is-green', 'is-red', 'is-gold', 'is-purple');
        el.classList.add(`is-${color}`);
      }
      if (value != null && value !== '-') el.classList.remove('is-dim', 'is-nodata');
    };

    const updateHeroSub = (field, subText, force) => {
      const el = panel.querySelector(`[data-field="${field}"]`);
      if (!el || !subText) return;
      let small = el.querySelector(':scope > small');
      if (!small) {
        small = document.createElement('small');
        el.appendChild(small);
      }
      // force:sv/bundle 真值需要替换页面同步抽取的旧 sub(如 PDP cm 初值→mm 真值)
      if (force || !small.textContent) small.textContent = subText;
    };

    // 字段仍为占位('-' 或上一轮标记的「暂无数据」)时才兜底填充(hero 的 <small> 不计入判断)。
    const fieldEmpty = (name) => {
      const el = panel.querySelector(`[data-field="${name}"]`);
      if (!el) return false;
      const small = el.querySelector(':scope > small');
      const text = (el.textContent || '').replace(small ? (small.textContent || '') : '', '');
      return window.jzIsPanelEmptyText(text);
    };


    const fmtMoneyRub = (raw) => {
      if (raw == null) return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      return `₽${n >= 10000 ? (n / 10000).toFixed(1) + '万' : window.formatNumber(n)}`;
    };

    // 并行 fetch 同 PDP 路径。caller(如 ozon-data-panel.js)有时已经预先 fetch
    // 过相同数据,可通过 info.preFetched 复用,避免双 round-trip(stats/market 走
    // backend HTTP 无 SW 级 cache,重复 fetch 浪费)。
    // info.preFetched shape: { stats, market, variant, followCount } — 每项是
    // Promise.allSettled 风格 SettledResult,或一个 Promise(列表卡首帧渐进渲染:
    // variants/跟卖慢源在途,到货即填,不拖 stats/market 首帧)。
    const toSettled = (x) => {
      if (x && typeof x.then === 'function') {
        return x.then(
          (value) => ({ status: 'fulfilled', value }),
          (reason) => ({ status: 'rejected', reason }),
        );
      }
      return Promise.resolve(x || { status: 'fulfilled', value: null });
    };

    // 快慢分车道:stats/market(后端 + fleet 缓存,快)先到先填;searchVariants /
    // followCount 各自到货再补格子,不再让首帧等最慢一路(旧 4 路 allSettled barrier
    // 下,跟卖数 1 并发×500ms 串行会把整页卡的首帧拖到几十秒)。
    let statsResult, marketResult, variantPromise, followPromise;
    if (info?.preFetched) {
      [statsResult, marketResult] = await Promise.all([
        toSettled(info.preFetched.stats),
        toSettled(info.preFetched.market),
      ]);
      variantPromise = toSettled(info.preFetched.variant);
      followPromise = toSettled(info.preFetched.followCount);
    } else {
      variantPromise = toSettled(window.sendMessage('searchVariants', { sku: skuStr }));
      // PDP 页面 widget 已带跟卖数(noFollowFetch),不再打 composer;列表卡照取
      followPromise = toSettled(
        info.noFollowFetch || !window.jzFetchPublicFollowSellCount
          ? Promise.resolve(null)
          : window.jzFetchPublicFollowSellCount(skuStr),
      );
      [statsResult, marketResult] = await Promise.allSettled([
        window.sendMessage('getProductStats', {
          sku: skuStr,
          period: window.jzGetSalesPeriod?.() || 'monthly',
          // PDP 从面包屑抽的买家类目 id:后端佣金按 ID 精确分档(列表卡无面包屑,不传)
          ...(Array.isArray(info.catIds) && info.catIds.length ? { catIds: info.catIds } : {}),
        }),
        window.sendMessage('getMarketStats', { sku: skuStr, period: window.jzGetSalesPeriod?.() || 'monthly' }),
      ]);
    }

    // 会员门控兜底(页面级门控 fail-open 放行但后端拦了/会员刚过期):
    // 调用方决定锁定态怎么渲染(PDP 换卡 body,列表卡整面板重绘)。
    if (statsResult.status === 'fulfilled' && statsResult.value?.__featureGated) {
      if (typeof info.onFeatureGated === 'function') {
        try { info.onFeatureGated(); } catch {}
      }
      return;
    }

    // ── 1. Backend product-data(SelectionProduct + analytics + adStats + market) ──
    if (statsResult.status === 'fulfilled' && statsResult.value) {
      const data = statsResult.value;

      // id 优先翻中文(30 个 L1 全覆盖,不怕英文名漂移,同 PDP 口径 PR#257/#331)
      if (data.categoryL1 || data.categoryL1Id) updateField('category', window.jzTranslateCategoryL1(data.categoryL1, data.categoryL1Id));
      if (data.categoryL3) updateField('categoryL3', data.categoryL3);
      if (data.brand) updateField('brand', data.brand, 'blue');
      if (data.rating != null) {
        const ratingText = window.jzFormatRating(data.rating, data.reviewCount);
        if (ratingText) updateField('rating', ratingText, 'gold');
      }
      if (data.sales30d != null) updateField('sales30d', window.formatNumber(data.sales30d), 'blue');

      // 自有商品的 analyticsRevenue(seller analytics 实时)优先于选品库 revenue30dRub 快照
      const fmtMoneyVal = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + '万' : window.formatNumber(n));
      const moneyStr = fmtMoneyRub(data.analyticsRevenue) || fmtMoneyRub(data.revenue30dRub);
      if (moneyStr) {
        updateField('revenue30d', moneyStr, 'blue');
      } else if (data.revenue30dCny != null) {
        // RUB 缺失时的 CNY/USD 回退(选品库部分行只有外币口径)
        updateField('revenue30d', `¥${fmtMoneyVal(Number(data.revenue30dCny))}`, 'blue');
      } else if (data.revenue30dUsd != null) {
        updateField('revenue30d', `$${fmtMoneyVal(Number(data.revenue30dUsd))}`, 'blue');
      }

      if (data.dailyRevenue != null) {
        updateField('dailyRevenue', `₽${window.formatNumber(data.dailyRevenue)}`, 'blue');
      } else if (data.revenue30dCny != null) {
        // revenue30dCny/Usd 只来自选品库(固定月口径),恒 ÷30,不随周期开关
        updateField('dailyRevenue', `¥${window.formatNumber(Number(data.revenue30dCny) / 30)}`, 'blue');
      } else if (data.revenue30dUsd != null) {
        updateField('dailyRevenue', `$${window.formatNumber(Number(data.revenue30dUsd) / 30)}`, 'blue');
      }
      if (data.dailySales != null) updateField('dailySales', Number(data.dailySales).toFixed(2), 'blue');

      // 按售价档只显示命中那一档佣金。售价优先级:
      //   后端 priceRub > 扩展直连市场月均价(gmvSum/soldCount)> backend revenue30dRub/sales30d。
      // 为何要带市场月均价:product-data 走 skipMarket=1(把市场数据让给扩展直连那路、避开
      // 后端 antibot),所以搜索品(不在选品库)的 backend priceRub/revenue30dRub/sales30d 全为空,
      // #52 的后端均价兜底无从触发 → 列表卡三档全列。这里改用扩展自己拿到的 marketResult
      // (gmvSum 月营收 / soldCount 月销量,正是面板显示月销额/月销量那份)反推单价定档。
      let _mktRub = 0;
      if (marketResult && marketResult.status === 'fulfilled' && marketResult.value) {
        const _m = marketResult.value;
        const _g = Number(_m.gmvSum), _s = Number(_m.soldCount);
        if (_g > 0 && _s > 0) _mktRub = _g / _s;
      }
      // info.pageRub:调用方的页面实价(PDP 页价 / 列表 tile 可见价,非 CNY/USD 时传入)。
      // 实价比月均价更贴近当前档位,优先;两者皆缺退 jzResolveCommPriceRub 内部兜底链。
      const _pageRub = Number(info.pageRub) > 0 ? Number(info.pageRub) : 0;
      const _commPriceRub = window.jzResolveCommPriceRub(data, _pageRub || _mktRub);
      if (data.commissionRfbsBelow1500 != null && data.commissionRfbs1500to5000 != null && data.commissionRfbsAbove5000 != null) {
        updateField('commRfbs', window.jzRenderCommissionTier(data.commissionRfbsBelow1500, data.commissionRfbs1500to5000, data.commissionRfbsAbove5000, _commPriceRub), '', false, { raw: true });
      }
      if (data.commissionFbpBelow1500 != null && data.commissionFbp1500to5000 != null && data.commissionFbpAbove5000 != null) {
        updateField('commFbp', window.jzRenderCommissionTier(data.commissionFbpBelow1500, data.commissionFbp1500to5000, data.commissionFbpAbove5000, _commPriceRub), '', false, { raw: true });
      }

      if (data.weightG != null) {
        updateField('weight', `${data.weightG}g`);
        updateField('heroSize', `${data.weightG}g`);
      }
      if (data.lengthMm != null && data.widthMm != null && data.heightMm != null) {
        updateField('dimensions', `${data.lengthMm} × ${data.widthMm} × ${data.heightMm}mm`);
        updateHeroSub('heroSize', `${data.lengthMm}×${data.widthMm}×${data.heightMm}mm`);
        const vol = window.jzVolumeLiters(data.lengthMm, data.widthMm, data.heightMm);
        if (vol != null) updateField('volume', `${vol} L`);
      }

      if (data.productCreatedDate) {
        const d = new Date(data.productCreatedDate);
        if (!Number.isNaN(d.getTime())) {
          const dateStr = d.toISOString().slice(0, 10);
          const days = Math.floor((Date.now() - d.getTime()) / 86400000);
          updateField('createDate', dateStr, 'green');
          updateHeroSub('createDate', `${days} 天`);
        }
      }

      if (data.marketSalesSchema) updateField('salesSchema', data.marketSalesSchema);
      if (data.marketSalesDynamics != null) {
        const v = Number(data.marketSalesDynamics);
        updateField('salesDynamics', `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`, v > 0 ? 'green' : v < 0 ? 'red' : '');
      }
      // marketDiscount = 快照促销折扣(market.discount) → 促销折扣行;广告费占比走 marketDrr。
      if (data.marketDiscount != null) updateField('promoDiscount', `${Number(data.marketDiscount).toFixed(2)}%`);
      if (data.marketDrr != null) updateField('drr', `${Number(data.marketDrr).toFixed(2)}%`);
      if (data.adCostRatio != null) updateField('drr', `${Number(data.adCostRatio).toFixed(2)}%`, '', true);

      // 流量转化
      if (data.marketViews != null) updateField('pdpViews', window.formatNumber(data.marketViews));
      if (data.analyticsConvRate != null) updateField('pdpCartRate', `${Number(data.analyticsConvRate).toFixed(2)}%`);
      if (data.marketSearchViews != null) updateField('searchViews', window.formatNumber(data.marketSearchViews));
      if (data.analyticsSearchCartRate != null) updateField('searchCartRate', `${Number(data.analyticsSearchCartRate).toFixed(2)}%`);
      if (data.marketConvRate != null) updateField('convViewToOrder', `${Number(data.marketConvRate).toFixed(2)}%`, 'green');
      if (data.clickRate != null) updateField('clickRate', `${Number(data.clickRate).toFixed(2)}%`, 'orange');
      if (data.paidPromoDays != null) updateField('daysWithAds', String(data.paidPromoDays));

      // 退货率:marketRedemptionRate 是快照透传的原始 nullableRedemptionRate(签收率),
      // 与下面 market 直连路径同口径 —— 退货率 = 100 - 签收率,不能直显原值。
      if (data.marketRedemptionRate != null) {
        const returnRate = window.jzReturnRateFromRedemption(data.marketRedemptionRate);
        if (returnRate != null) {
          updateField('returnRate', `${returnRate.toFixed(0)}%`, returnRate > 0 ? 'red' : 'green');
        }
      }

      // 跟卖字段兜底(fill-if-empty:PDP 页面 widget 同步初值优先;列表卡无这些
      // data-field 节点时 updateField 自动 no-op)
      if (data.followCount != null && fieldEmpty('heroFollow')) {
        updateField('heroFollow', String(data.followCount));
        updateHeroSub('heroFollow', '卖家');
      }
      if (data.lowestPriceUsd != null && fieldEmpty('followMinPrice')) {
        // 后端该字段是 USD,按 $ 原样显示,不做假汇率换算
        updateField('followMinPrice', `$${Number(data.lowestPriceUsd).toFixed(2)}`, 'green');
      }
      if (data.canFollow != null && fieldEmpty('canFollow')) {
        updateField('canFollow', data.canFollow ? '能' : '不能', data.canFollow ? 'green' : 'red');
      }
    }

    // ── 2. Market data(seller.ozon.ru data/v3,通过 SW 注入到 seller tab 拿)──
    // 跟 PDP createSidebarDataCard:2441-2490 用同一字段映射;backend product-data
    // 走 skipMarket=1 把市场数据让给这条路,避免 backend 撞 Ozon antibot。force=true
    // 让 market data 优先于 backend 兜底值(market 是当下时点数据,backend 选品库
    // 可能是 hourly 缓存)。
    if (marketResult.status === 'fulfilled' && marketResult.value) {
      const d = marketResult.value;
      // 会话过期/未登录信号(跟 PDP createSidebarDataCard 同口径):SW 区分了
      // "该 SKU 无数据"(value=null)和"需登录卖家中心"(value.__needSellerLogin)。
      // 后者在 panel 顶部插一条提示而非静默"-"。
      if (d.__needSellerLogin) {
        // 命中选品库(后端 product-data 已填市场数据)时不弹「需登录卖家中心」横幅 —— 数据已有,无需打扰。
        // 注:此处在 marketResult 块内,上面 backend 块的 `data` const 已出作用域,直接读函数级 statsResult.value。
        const _sv = statsResult && statsResult.status === 'fulfilled' ? statsResult.value : null;
        const _hasBackendMarket = !!_sv && (_sv.sales30d != null || _sv.revenue30dRub != null);
        if (!_hasBackendMarket && panel) {
          // 红色「请登录卖家中心」提示 + 一键登录(统一 helper,见 jzShowSellerLoginHint)。
          // 命中选品库(后端已有市场数据)则不弹,数据已有无需打扰。
          // 插到卡 body(PDP/列表卡结构相同),不插卡头之上。
          window.jzShowSellerLoginHint(panel.querySelector('.ozon-helper-sidebar-card-body') || panel);
        }
        // 不 return —— 让下面 ③ searchVariants 的重量/尺寸兜底仍能填(那条不依赖
        // seller 登录,走 Ozon sv;market 字段则保持"-")。
      } else {
      // 类目/品牌兜底:data/v3 的俄文值只在 backend 完全没填时用(backend 中文优先)
      if ((d.category1 || d.category1Id) && fieldEmpty('category')) {
        updateField('category', window.jzTranslateCategoryL1(d.category1, d.category1Id));
      }
      if (d.category3 && fieldEmpty('categoryL3')) updateField('categoryL3', d.category3);
      if (d.brand && fieldEmpty('brand')) updateField('brand', d.brand, 'orange');
      // 销售
      if (d.soldCount != null) {
        updateField('sales30d', window.formatNumber(Number(d.soldCount)), 'blue', true);
      }
      if (d.gmvSum != null) {
        const rev = Number(d.gmvSum);
        const RUB_TO_CNY_V2 = 0.084;
        const cny = (rev * RUB_TO_CNY_V2).toFixed(2);
        updateField(
          'revenue30d',
          `₽${window.formatNumber(rev)} ≈ ¥${cny}`,
          'blue',
          true,
        );
      }
      if (d.salesDynamics != null) {
        const sd = Number(d.salesDynamics);
        updateField(
          'salesDynamics',
          `${sd >= 0 ? '+' : ''}${sd.toFixed(1)}%`,
          sd > 0 ? 'green' : sd < 0 ? 'red' : '',
          true,
        );
      }
      if (d.drr != null) {
        updateField('drr', `${Number(d.drr).toFixed(2)}%`, '', true);
      }
      if (d.avgOrdersOnAccDays != null) {
        updateField('dailySales', Number(d.avgOrdersOnAccDays).toFixed(2), 'blue', true);
      }
      if (d.avgGmvOnAccDays != null) {
        updateField('dailyRevenue', `${Number(d.avgGmvOnAccDays).toFixed(2)}₽`, 'blue', true);
      }
      // 促销与推广
      if (d.daysInPromo != null) {
        updateField('daysInPromo', String(d.daysInPromo), '', true);
      }
      if (d.discount != null) {
        updateField('promoDiscount', `${Number(d.discount).toFixed(2)}%`, '', true);
      }
      if (d.promoRevenueShare != null) {
        updateField('promoConvRate', `${Number(d.promoRevenueShare).toFixed(2)}%`, 'green', true);
      }
      if (d.daysWithTrafarets != null) {
        updateField('daysWithAds', String(d.daysWithTrafarets), '', true);
      }
      // 流量与转化
      const pdpViewsRaw =
        d.qtyViewPdp != null ? d.qtyViewPdp : d.sessionCount != null ? d.sessionCount : null;
      if (pdpViewsRaw != null) {
        updateField('pdpViews', window.formatNumber(Number(pdpViewsRaw)), '', true);
      }
      const pdpCartRaw =
        d.pdpToCartConversion != null
          ? d.pdpToCartConversion
          : d.convToCartPdp != null
          ? d.convToCartPdp
          : null;
      if (pdpCartRaw != null) {
        updateField('pdpCartRate', `${Number(pdpCartRaw).toFixed(2)}%`, '', true);
      }
      if (d.sessionCountSearch != null) {
        updateField('searchViews', window.formatNumber(Number(d.sessionCountSearch)), '', true);
      }
      if (d.convToCartSearch != null) {
        updateField('searchCartRate', `${Number(d.convToCartSearch).toFixed(2)}%`, '', true);
      }
      if (d.convViewToOrder != null) {
        updateField('convViewToOrder', `${Number(d.convViewToOrder).toFixed(2)}%`, '', true);
      }
      // CTR = sessionCount / views;backend 没算这个 derive 字段,我们在 client 算
      const viewsForCtr = Number(d.views) || 0;
      const sessionsForCtr = Number(d.sessionCount || d.qtyViewPdp) || 0;
      if (viewsForCtr > 0) {
        const ctr = ((sessionsForCtr / viewsForCtr) * 100).toFixed(2);
        updateField('clickRate', `${ctr}%`, Number(ctr) > 5 ? 'orange' : '', true);
      }
      // 物流与商品
      if (d.salesSchema || (Array.isArray(d.sources) && d.sources.length > 0)) {
        const schema =
          d.salesSchema || (d.sources?.length ? d.sources.join('/').toUpperCase() : '-');
        updateField('salesSchema', schema, '', true);
      }
      if (d.nullableRedemptionRate != null) {
        const returnRate = window.jzReturnRateFromRedemption(d.nullableRedemptionRate);
        if (returnRate != null) {
          updateField(
            'returnRate',
            `${returnRate.toFixed(0)}%`,
            returnRate > 0 ? 'red' : 'green',
            true,
          );
        }
      }
      if (d.nullableCreateDate) {
        const cd = new Date(d.nullableCreateDate);
        if (!Number.isNaN(cd.getTime())) {
          const daysSince = Math.floor((Date.now() - cd.getTime()) / 86400000);
          // 与 backend 路径同款「日期 + sub 天数」格式;旧写法整串 `日期(N天)` 会跟
          // backend 先写入的 sub 叠加成重复天数。
          updateField('createDate', cd.toISOString().slice(0, 10), '', true);
          updateHeroSub('createDate', `${daysSince} 天`, true);
        }
      }
      } // close else (非 __needSellerLogin 分支)
    }

    // ── 3. Follow-sell count(独立 fetch,即便 backend fail 也可填) ──
    // 慢车道:到货即填(见下方 Promise.all)。与 ④ 字段不相交可并行;二者都在
    // ①/② 之后才跑,fill-if-empty 的先后语义与旧串行版一致。
    const fillFollowSection = (followCountResult) => {
    if (followCountResult.status === 'fulfilled' && followCountResult.value != null) {
      const followPayload = followCountResult.value;
      const n = Number(
        followPayload && typeof followPayload === 'object'
          ? followPayload.count
          : followPayload
      );
      if (Number.isFinite(n)) {
        updateField('heroFollow', String(n));
        updateHeroSub('heroFollow', '卖家');
      }
      const sellers = followPayload && typeof followPayload === 'object' && Array.isArray(followPayload.sellers)
        ? followPayload.sellers
        : [];
      const prices = sellers
        .map((seller) => {
          const normalized = String(seller?.price ?? '')
            .replace(/[^\d.,-]/g, '')
            .replace(/\s/g, '')
            .replace(',', '.');
          const price = parseFloat(normalized);
          return Number.isFinite(price) ? price : null;
        })
        .filter((price) => price !== null);
      if (prices.length) {
        // sellers[].price 来自 Ozon 页面/composer,币种是卢布 —— 标 ₽ 不标 ¥。
        updateField('followMinPrice', `₽${window.formatNumber(Math.min(...prices), 2)}`, 'green');
      }
    }
    };

    // ── 4. searchVariants:重量/尺寸真值覆盖 + 品牌/类目兜底 ──
    // 重量/尺寸:sv/bundle(4497/9454-9456)是 seller 后台真值(g/mm 精度),**强制覆盖**
    // Backend 的 SelectionProduct/dims 缓存快照 —— 后者按天 snapshot,卖家改包装后会过期。
    // (两卡统一此优先级:此前 PDP force 覆盖、列表卡反向"后端先写 sv 只兜底",同一商品两卡显示不同。)
    // 品牌/类目:backend 没填时才兜底(backend 中文值优先)。
    const fillVariantSection = (variantResult) => {
    if (variantResult.status === 'fulfilled' && variantResult.value) {
      const items = variantResult.value.items || variantResult.value.data?.items || [];
      const item = items.find((it) => String(it.variant_id) === skuStr) || items[0];
      if (item?.attributes) {
        const attrMap = new Map(item.attributes.map((a) => [String(a.key), a]));
        const w = window.jzSvWeightG(attrMap) || 0;
        const dp = Number(attrMap.get('9454')?.value);
        const wd = Number(attrMap.get('9455')?.value);
        const ht = Number(attrMap.get('9456')?.value);
        if (w > 0) {
          updateField('weight', `${w}g`);
          updateField('heroSize', `${w}g`);
        }
        if (dp > 0 && wd > 0 && ht > 0) {
          updateField('dimensions', `${dp} × ${wd} × ${ht}mm`);
          updateHeroSub('heroSize', `${dp}×${wd}×${ht}mm`, true);
          const vol = window.jzVolumeLiters(dp, wd, ht);
          if (vol != null) updateField('volume', `${vol} L`);
        }
        // PDP(persistDims):sv 真值写 chrome.storage 本地缓存(全站其他卡直接命中)
        // + 回写服务端 ozon_sku_dims 平台缓存。列表卡不传 —— 它们经
        // jzMergeCardPanelData 已上报,避免双份。
        if (info.persistDims && (w > 0 || (dp > 0 && wd > 0 && ht > 0))) {
          window.jzPersistWeightDims?.(skuStr, { weightG: w, lengthMm: dp, widthMm: wd, heightMm: ht }, 'sv-attrs');
          try {
            window.sendMessage?.('reportSkuDims', {
              item: { sku: skuStr, weightG: w || null, lengthMm: dp || null, widthMm: wd || null, heightMm: ht || null, source: 'sv' },
            }).catch(() => {});
          } catch {}
        }
        // sv 命中即可跟卖(晚于 backend 顺序执行,统一「sv 结论优先」,消除旧 PDP
        // backend/sv 双源先到先得的竞态)。列表卡无 canFollow 节点,no-op。
        updateField('canFollow', '能', 'green');
        // 品牌 ← sv attr 85 (来自 /search brand_name)
        const brandVal = attrMap.get('85')?.value;
        if (brandVal && fieldEmpty('brand')) updateField('brand', String(brandVal), 'blue');

        // 类目 ← sv:优先 item.categories[] 的可读 title 拼 "L1/L3" 路径;
        // 但 /api/v1/search 的 categories 通常只回 {id, level} 无 title(见 sw.js
        // normalizeSearchVariantToSv 注释),故缺 title 时回退到类型名 attr 8229
        // (description_type_name,即最具体的类型/类目可读名)。
        if (fieldEmpty('category') || fieldEmpty('categoryL3')) {
          let l1 = '', deepest = '';
          const cats = Array.isArray(item.categories)
            ? item.categories.filter((c) => c && (c.title || c.name))
            : [];
          if (cats.length) {
            const titles = [...cats]
              .sort((a, b) => (Number(a.level) || 0) - (Number(b.level) || 0))
              .map((c) => c.title || c.name)
              .filter(Boolean);
            l1 = window.jzTranslateCategoryL1(titles[0]) || '';
            const d = titles[titles.length - 1];
            if (d && d !== titles[0]) deepest = String(d); // ≥2 级才有三级名
          }
          if (!deepest) {
            const typeName = attrMap.get('8229')?.value; // 类型名(最具体)兜底当三级
            if (typeName) deepest = String(typeName);
          }
          if (l1 && fieldEmpty('category')) updateField('category', l1);
          if (deepest && fieldEmpty('categoryL3')) updateField('categoryL3', deepest);
        }
      }
    }
    };

    // 慢车道并行收尾:两段到货即填;函数整体仍等两路都落定才 resolve,调用方
    // (列表卡落桶 collectSaleIfMatched / PDP autoCollapseEmptySections)时序不变。
    await Promise.all([
      followPromise.then((r) => { try { fillFollowSection(r); } catch {} }),
      variantPromise.then(async (r) => {
        try { fillVariantSection(r); } catch {}
        // sv 失败/无命中时的本地缓存兜底(用户曾访问该 SKU 详情页时抓的 dims 真值;
        // 列表卡经 info.fallbackDims 传入)。fill-if-empty,不覆盖 backend/sv 已填值。
        const _items = r.status === 'fulfilled' ? (r.value?.items || r.value?.data?.items || []) : [];
        if (!_items[0] && typeof info.fallbackDims === 'function') {
          const fd = await Promise.resolve().then(info.fallbackDims).catch(() => null);
          if (!fd) return;
          const w = Math.round(Number(fd.weightG)) || 0;
          const dp = Number(fd.lengthMm) || 0;
          const wd = Number(fd.widthMm) || 0;
          const ht = Number(fd.heightMm) || 0;
          if (w > 0 && fieldEmpty('weight')) updateField('weight', `${w}g`);
          if (w > 0 && fieldEmpty('heroSize')) updateField('heroSize', `${w}g`);
          if (dp > 0 && wd > 0 && ht > 0) {
            if (fieldEmpty('dimensions')) updateField('dimensions', `${dp} × ${wd} × ${ht}mm`);
            updateHeroSub('heroSize', `${dp}×${wd}×${ht}mm`);
            if (fieldEmpty('volume')) {
              const vol = window.jzVolumeLiters(dp, wd, ht);
              if (vol != null) updateField('volume', `${vol} L`);
            }
          }
        }
      }),
    ]);

    // 收口:所有数据源都落定后,仍是占位 '-' 的字段统一改成「暂无数据」。
    // 加载中保持 '-'(短、不抢镜);落定后明确告知"查过了,确实没有"。
    // is-dim class 保留(autoCollapseEmptySections 等按 class 判空),仅换文案+加 is-nodata。
    try {
      window.jzMarkEmptyFieldsNoData(panel);
    } catch {}
  };

  /**
   * 把面板里仍为 '-' 占位的 data-field 统一标记为「暂无数据」。
   * 幂等;hero 的 <small> 子节点保留;已有真值/已标记的字段不动。
   */
  window.jzMarkEmptyFieldsNoData = function (panel) {
    if (!panel) return;
    panel.querySelectorAll('[data-field]').forEach((el) => {
      const small = el.querySelector(':scope > small');
      const main = small
        ? (el.textContent || '').replace(small.textContent || '', '')
        : el.textContent || '';
      if (main.trim() !== '-') return;
      el.classList.add('is-nodata');
      el.innerHTML = '暂无数据' + (small ? small.outerHTML : '');
    });
  };
})();
