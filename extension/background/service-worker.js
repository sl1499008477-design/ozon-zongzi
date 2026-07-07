globalThis.__JZ_BRAND__ = {"code":"qh","displayName":"QH","productName":"QH","primaryColor":"#1677ff","apiHost":"localhost:3001","webHost":"127.0.0.1:5173","logoUrl":(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL("icons/icon128.png") : null};
// Electron host compatibility shim — Electron 36+ extension system 不实现
// chrome.contextMenus / chrome.cookies / chrome.notifications,SW 顶层调到
// chrome.contextMenus.onClicked.addListener 会抛 TypeError 导致整个 SW 注册失败。
// 这里给缺失 API 注册 no-op fallback;Chrome 里 typeof check 不触发,不污染原生。
// chrome.cookies 在 Electron 完整迁移阶段走 main process session.cookies IPC 桥;
// PoC 阶段用 no-op,让 SW 至少 active,跟卖前置流程会另行处理。
if (typeof chrome !== 'undefined') {
  if (typeof chrome.contextMenus === 'undefined') {
    chrome.contextMenus = {
      removeAll: (cb) => { try { cb && cb(); } catch (_) {} },
      create: () => {},
      onClicked: { addListener: () => {}, removeListener: () => {} },
    };
  }
  if (typeof chrome.notifications === 'undefined') {
    chrome.notifications = {
      create: (id, opts, cb) => { try { cb && cb(typeof id === 'string' ? id : ''); } catch (_) {} },
      clear: (id, cb) => { try { cb && cb(true); } catch (_) {} },
      onClicked: { addListener: () => {}, removeListener: () => {} },
    };
  }
  if (typeof chrome.cookies === 'undefined') {
    chrome.cookies = {
      getAll: (_query, cb) => {
        const empty = [];
        if (typeof cb === 'function') { try { cb(empty); } catch (_) {} return; }
        return Promise.resolve(empty);
      },
    };
  }
}

// Client-side sync 模块 — 同步加载到 SW global,挂 globalThis.Jz* 命名空间。
// importScripts 必须在 IIFE 之前(SW 文件顶层)同步调用,否则 SW spec 不允许。
// 这套模块完全隔离在 background/sync/ 子目录,不动现有 IIFE 内部结构。
try {
  importScripts(
    // cdn-buster 必须在 backend-client 之前 — 后者运行时读 globalThis.JzCdnBuster。
    '../lib/cdn-buster.js',
    '../lib/ozon-video-extract.js',
    'sync/opi-client.js',
    'sync/backend-client.js',
    'sync/lease-client.js',
    'sync/diff-index.js',
    'sync/sync-state.js',
    'sync/sync-engine.js',
    'agent/actions.js',
    'agent/collect-actions.js',
    'agent/listing-actions.js',
    'agent/agent-runtime.js',
  );
} catch (e) {
  // 不要阻断 SW 启动 — 老功能仍需可用。client-sync 失败时 alarm 不会触发。
  console.warn('[SW] client-sync importScripts failed:', e?.message || e);
}

(() => {
  // 启动版本标识：用户跟卖前看 chrome://extensions 极掌 → service worker → console
  // 必须能看到下面这行才说明新代码已加载（否则说明 sw 没 reload）
  console.log('[SW] booted: searchVariants = /api/v1/search + /api/site/seller-prototype/create-bundle-by-variant-id (sv endpoint 2026-05 下线) + ensureSellerTab + client-sync');

  // Backend 路由策略:
  //   - dev (直接加载 extension/ 源码,不跑 build.js) → globalThis.__JZ_PROD_BUILD__
  //     未定义 → 候选包含 localhost:3001,detectBackendUrl 优先试 localhost,联通即用
  //   - prod (走 npm run build 出的 dist/zip,esbuild define 把
  //     globalThis.__JZ_PROD_BUILD__ 替换成 "true") → 只走 api.jizhangerp.com,
  //     不再 fallback localhost。防止从 jizhangerp.com 下载安装的扩展在用户本地
  //     恰好开着 dev backend 时被劫持到 localhost:3001。
  const LOCAL_FRONTEND_BASE_URL = 'http://127.0.0.1:5173';
  const LOCAL_FRONTEND_TAB_URLS = [
    'http://localhost:3000/*',
    'http://store.localhost:3000/*',
    'http://localhost:5173/*',
    'http://127.0.0.1:5173/*',
  ];
  const BACKEND_URLS = ['http://localhost:3001', 'http://127.0.0.1:3001'];
  const isLocalBackendUrl = (value) => /^(?:http:\/\/)?(?:localhost|127\.0\.0\.1):3001\b/.test(String(value || ''));

  // dev 直接加载源码时 build.js 没跑,qh.jizhangerp.com 保持字面量 → 运行时兜底平台默认。
  // 影响:tryWebSync 抓 store.jizhangerp.com 标签页登录态、openFrontend 跳转域名。
  // 用 /__BRAND/ 探测(不写全占位符),避免 build textual replace 把探测逻辑也换掉
  // 而导致分销商 build 被误兜底成平台默认。
  const BRAND_WEB_HOST = /__BRAND/.test('qh.jizhangerp.com')
    ? 'store.jizhangerp.com'
    : 'qh.jizhangerp.com';

  // 插件更新检查配置: 走后端 GET /extension/latest?client=extension
  // (URL 在 checkForUpdate 中通过 getBackendUrl() 动态拼接)
  const UPDATE_CHECK_ALARM = 'extension-update-check';
  const UPDATE_CHECK_INTERVAL_MINUTES = 240; // 每4小时检查一次

  // 跟卖任务失败检查配置
  const FOLLOW_SELL_CHECK_ALARM = 'follow-sell-task-check';
  const FOLLOW_SELL_CHECK_INTERVAL_MINUTES = 5; // 每 5 分钟拉一次最近任务
  const FOLLOW_SELL_RECENT_WINDOW_MS = 60 * 60 * 1000; // 只通知最近 1 小时内创建的失败任务

  const STORAGE_KEYS = {
    token: 'ozonAuthToken',
    storeId: 'ozonStoreId',
    latestVersion: 'extensionLatestVersion',
    latestDownloadUrl: 'extensionLatestDownloadUrl',
    latestSha256: 'extensionLatestSha256',
    updateDismissedVersion: 'extensionUpdateDismissedVersion',
    followSellNotifiedIds: 'followSellNotifiedLocalTaskIds',
    deviceFingerprint: 'ozonExtensionFingerprint',
    // v2 (deprecated) → v3 (2026-05-27 起):v2 含 devicePixelRatio + languages 数组
    // 在同台 Edge 不同 profile/zoom 算成两台机器,导致 4 台套餐错占名额。
    // v3 移除这两个不稳维度。读时优先 v3,fallback v2 兼容旧 cache,setStorage 写 v3。
    deviceFingerprintV2: 'ozonMachineFingerprintV2',
    deviceFingerprintV3: 'ozonMachineFingerprintV3',
    // 通用埋点当天去重: { [featureKey]: 'YYYY-MM-DD' }
    usageTrackedDate: 'usageTrackedDate',
    // L1 (composer-api 拦截) 上报开关。默认 false (dry-run) —— 后端 endpoint
    // 就绪前不发任何网络请求,只做本地计数。用 `chrome.storage.local.set({
    // l1ReportEnabled: true })` 启用。详见 .claude/plans/chrome-api-purring-haven.md。
    l1ReportEnabled: 'l1ReportEnabled',
  };

  // L1 SW 端运行时计数器(本进程级,SW 重启会清零;持久化指标走影子表 IndexedDB)
  const l1SwStats = {
    receivedBatches: 0,
    receivedSamples: 0,
    sentSamples: 0,
    droppedNoAuth: 0,
    droppedDisabled: 0,
    httpErrors: 0,
    lastError: null,
    lastSentAt: 0,
  };

  const HEARTBEAT_ALARM = 'device-heartbeat';
  const HEARTBEAT_INTERVAL_MINUTES = 5;

  // 采集器实时大屏：tab → 最近一次 heartbeat 状态（不持久化，sw 休眠后会清空，
  // 但前台每 30s 会重发心跳，恢复也快）
  const COLLECTOR_STALE_MS = 90 * 1000;
  const collectorTabs = new Map(); // tabId → { tabId, stats, currentKeyword, autoScrollerRunning, bucketCount, url, title, ts }

  // pushSourceCollect in-flight 合并(plan v3 子项 ② P1 修复):
  // chrome.storage 的 dedupe 只在请求完成写 cache 后才命中。如果用户快速连点 5 次,
  // 5 次都可能在第一次 fetch 返回前 miss cache,各自发请求 → backend 收到 5 次重复 upsert。
  // 加 SW 内存级 Map:key 命中时 await 同一个 in-flight Promise,合并并发。
  const pendingCollects = new Map(); // cacheKey → Promise<{ok, dedupeHit, data, ...}>

  // ── 极掌算价：CNY→RUB 实时汇率 ──
  // 每日刷新一次写入 chrome.storage.local。content/jzc-calc.js 监听 storage 变化自动重算
  const FX_STORAGE_KEY = 'jz_calc_fx_rate_v1';
  const FX_ALARM = 'jzc-fx-refresh';
  const FX_API_URL = 'https://open.er-api.com/v6/latest/CNY';
  const FX_REFRESH_INTERVAL_MINUTES = 24 * 60;

  // ── client-side sync(扩展端跑同步,取代后端 BullMQ cron)──
  // 三个独立 alarm,各类型独立频率。SW 重启自动 re-create alarm,
  // chrome.alarms 在用户登录浏览器期间持续触发,不依赖 ozon 页面打开。
  const CLIENT_SYNC_ALARM_PREFIX = 'jz:client-sync:';
  const CLIENT_SYNC_TYPES = ['POSTINGS', 'PRODUCTS', 'WAREHOUSES'];
  // 默认间隔(分钟) — 跟 backend SyncSettingsService.getXxxClientIntervalMin 对齐。
  // backend 端点 /ozon/sync/client-intervals 可拉服务端配置,MVP 先硬编码,
  // 之后灰度时再加"启动 + 每 24h 拉一次刷新"逻辑。
  // 2026-06-02:POSTINGS 3→5 对齐后端 OZON_POSTINGS_CLIENT_INTERVAL_MIN 默认值(5)。
  // 之前硬编码 3min 无视后端配置,是高峰 api 最大流量源(lease 三件套 + client-report
  // 逐页上报,~40 req/s)。5min 把这块砍 ~40%,订单新鲜度 3→5min 可接受。
  const CLIENT_SYNC_INTERVALS = {
    POSTINGS: 5,
    PRODUCTS: 30,
    WAREHOUSES: 360,
  };
  const BROWSER_AGENT_ALARM = 'jz:browser-agent';
  const BROWSER_AGENT_INTERVAL_MINUTES = 1;

  /**
   * 登录门户域声明(2026-06-11 串号修复):build.js 给发版包注入
   * globalThis.__JZ_BRAND__(分销商定制版 webHost = 其商户域,平台版 =
   * store.jizhangerp.com)。popup/SW 登录直调 api.* 时后端拿不到分销商域上下文
   * (Origin 是 chrome-extension:// 被跳过),把 webHost 随 body 显式声明,
   * 后端按它解析 distributorId —— 定制版用户从此登进自己分销商的账号,
   * 不再被串进平台直营。dev 源码加载无 brand 注入 → 返回 undefined,后端走
   * 原 host 链路。
   */
  function jzBrandPortalHost() {
    try {
      const h = globalThis.__JZ_BRAND__ && globalThis.__JZ_BRAND__.webHost;
      return typeof h === 'string' && h.trim() ? h.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  async function getExtensionFingerprint(preferredFingerprint) {
    // popup 传上来的 preferredFingerprint 现在是 machine-v3-,兼容 v2 旧 popup
    // (用户没 reload 扩展但 reload 了网页端)期间 v2 fingerprint 也能透传。
    if (preferredFingerprint && /^machine-v[23]-[a-z0-9-]+$/i.test(preferredFingerprint)) {
      await setStorage({ [STORAGE_KEYS.deviceFingerprintV3]: preferredFingerprint });
      return preferredFingerprint;
    }
    const stored = await getStorage([
      STORAGE_KEYS.deviceFingerprintV3,
      STORAGE_KEYS.deviceFingerprintV2,
    ]);
    // v3 优先;不存在但有 v2 → migrate 一次(同 raw 输入算 v3 hash 不同,直接重算)。
    if (stored[STORAGE_KEYS.deviceFingerprintV3]) return stored[STORAGE_KEYS.deviceFingerprintV3];
    const fp = buildWorkerMachineFingerprint();
    await setStorage({ [STORAGE_KEYS.deviceFingerprintV3]: fp });
    return fp;
  }

  function buildWorkerMachineFingerprint() {
    // v3 (2026-05-27):移除 SW 里没用上的不稳维度,跟 popup.js / frontend
    // device-fingerprint.ts 对齐到 v3。SW 没有 window.screen,本来就比 popup 少
    // 几个维度,这里主要负责 bump 版本号。
    const raw = [
      'jizhang-machine-v3',
      getWorkerOsBucket(),
      'extension-service-worker',
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown-tz',
      navigator.language || 'unknown-lang',
      navigator.hardwareConcurrency || 0,
    ].join('|');
    return `machine-v3-${hashString(raw)}`;
  }

  function getWorkerOsBucket() {
    const platform = `${navigator.userAgentData?.platform || navigator.platform || ''} ${navigator.userAgent || ''}`;
    if (/mac/i.test(platform)) return 'mac';
    if (/win/i.test(platform)) return 'windows';
    if (/android/i.test(platform)) return 'android';
    if (/iphone|ipad|ios/i.test(platform)) return 'ios';
    if (/linux/i.test(platform)) return 'linux';
    return 'unknown-os';
  }

  function hashString(s) {
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

  const getStorage = (keys) => new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });

  const setStorage = (values) => new Promise((resolve) => {
    chrome.storage.local.set(values, resolve);
  });

  const removeStorage = (keys) => new Promise((resolve) => {
    chrome.storage.local.remove(keys, resolve);
  });

  // Debounced ozon tab reload — prevents rapid reload storms on auth state changes
  let _reloadTimer = null;
  function reloadOzonTabs() {
    clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(async () => {
      const tabs = await chrome.tabs.query({ url: ['*://*.ozon.ru/*', '*://*.ozon.kz/*'] });
      for (const tab of tabs) {
        chrome.tabs.reload(tab.id);
      }
    }, 300);
  }

  // 插件登出 → 同步清掉所有已打开的 ERP 网页标签登录态(扩展登出时网页也登出,
  // 防止两边停在不同账号)。executeScript 注入清 localStorage + 跳 /login。
  // 幂等:若标签页本就没 token 直接 return,断开任何来回触发的循环。
  async function clearWebAuthTabs() {
    try {
      // 只命中真正的卖家 web(品牌域 + 平台 apex + 本地),不带 *.jizhangerp.com
      // 通配,避免误清 admin.jizhangerp.com 等共用同名 localStorage key 的子域。
      const tabs = await chrome.tabs.query({
        url: [
          `*://${BRAND_WEB_HOST}/*`,
          '*://jizhangerp.com/*',
          ...LOCAL_FRONTEND_TAB_URLS,
        ],
      });
      for (const tab of tabs) {
        if (!tab.id) continue;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              try {
                // 幂等清 key(已空也无妨);仅在非 /login 时跳转 → 防来回重定向循环,
                // 且每个 tab 各自按自身 pathname 判定,多 tab 不会被共享 localStorage
                // 的"已清空"状态误判而漏跳转。
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                localStorage.removeItem('currentOzonStoreId');
                if (!location.pathname.startsWith('/login')) {
                  location.href = '/login';
                }
              } catch {}
            },
          });
        } catch {}
      }
    } catch (e) {
      console.warn('[ServiceWorker] clearWebAuthTabs failed:', e?.message);
    }
  }

  let resolvedBackendUrl = null;

  const detectBackendUrl = async () => {
    // 生产构建(__JZ_PROD_BUILD__ DCE 后)只剩一个候选 URL,无需探活,直接定址。
    // 旧实现拿 /auth/captcha 当探针:MV3 SW 空闲 ~30s 即被杀,每次重启都重新探活,
    // 每次探活后端真实生成一张验证码(SVG + Redis 写)—— 是生产 /auth/captcha
    // ~11 req/s 洪水的主源(装机基数 × SW 醒睡循环,24h 不停)。
    if (BACKEND_URLS.length === 1) {
      resolvedBackendUrl = BACKEND_URLS[0];
      return resolvedBackendUrl;
    }
    // dev 双候选(localhost vs api)才需要探活,改打轻量 /health(无鉴权、不碰
    // DB/Redis、不生成验证码;后端同批次新增)。
    for (const url of BACKEND_URLS) {
      try {
        const resp = await fetch(`${url}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          resolvedBackendUrl = url;
          return url;
        }
      } catch {}
    }
    resolvedBackendUrl = BACKEND_URLS[BACKEND_URLS.length - 1];
    return resolvedBackendUrl;
  };

  const getBackendUrl = async () => {
    if (resolvedBackendUrl) return resolvedBackendUrl;
    return detectBackendUrl();
  };

  /**
   * Execute fetch in a seller.ozon.ru tab's page context (MAIN world).
   * This produces a same-origin request with correct cookies, Sec-Fetch-Site,
   * and TLS fingerprint — bypassing antibot that blocks cross-site requests
   * from service worker fetch().
   *
   * Uses chrome.scripting.executeScript to inject fetch directly into
   * the seller tab — no dependency on pre-injected content scripts.
   */
  /**
   * 把 /api/v1/search 返回的 variant 转成 sv 兼容 shape，下游 distillSource /
   * resolveViaSearchVariantModel 直接用。
   *
   * /search 真实顶层字段（实测）：
   *   variant_id, variant_name, main_image, secondary_images, description_type_name,
   *   description_type_dict_value, brand_name, brand_id, is_brand_promoted, is_copy_allowed,
   *   is_content_copy_allowed, rating, skus, barcodes, categories[{id, level}]
   *
   * sv 期望：description_category_id (number) + categories[{id, level, title}]
   *   + attributes[{key, value | collection}]
   *
   * sv → /search 字段映射（确保 distillSource readSourceText/readSourceImages 都能命中）：
   *   4180 商品名 ← variant_name  ⭐ 关键，distillSource.name 来自此
   *   4194 主图  ← main_image
   *   4195 图册  ← secondary_images
   *   8229 类型名 ← description_type_name（决定 backend Strategy 1 type-name 匹配）
   *   85   品牌  ← brand_name
   *   7822 GTIN  ← barcodes[0]（路径 2 也能继承 GTIN，影响内容评分）
   *   4191 描述  ← description（/search 不返，留空）
   *   4497 重量 / 9454-9456 尺寸 ← /search 不返
   */
  const normalizeSearchVariantToSv = (v) => {
    if (!v) return null;
    // 已是 sv shape（含 attributes 数组）→ 原样返回
    if (Array.isArray(v.attributes) && v.attributes.length > 0) return v;
    const attributes = [];
    const descriptionTypeDictValue = Number(v.description_type_dict_value) || 0;
    if (v.description_type_name) {
      attributes.push({
        key: '8229',
        value: v.description_type_name,
        ...(descriptionTypeDictValue ? { dictionary_value_id: descriptionTypeDictValue } : {}),
      });
    }
    if (v.brand_name) attributes.push({ key: '85', value: v.brand_name });
    // /search 商品名实际字段是 variant_name；title/name 兜底（少数 shape 用过）
    const productName = v.variant_name || v.title || v.name;
    if (productName) attributes.push({ key: '4180', value: productName });
    if (v.description) attributes.push({ key: '4191', value: v.description });
    if (v.main_image) attributes.push({ key: '4194', value: v.main_image });
    const secondaries = Array.isArray(v.secondary_images) ? v.secondary_images : [];
    if (secondaries.length > 0) attributes.push({ key: '4195', collection: secondaries });
    // GTIN(7822) — 从 /search 的 barcodes 兜底，后端 mapping 时若目标类目含 7822 会自动 copy 进 item.attributes
    if (Array.isArray(v.barcodes) && v.barcodes.length > 0) {
      const gtin = String(v.barcodes[0] || '').trim();
      if (gtin) attributes.push({ key: '7822', value: gtin });
    }
    const partMarketingPrice = v.part_marketing_price || v.partMarketingPrice || null;
    const marketingPrice =
      v.marketing_price ||
      v.marketingPrice ||
      partMarketingPrice?.price ||
      partMarketingPrice?.marketing_price ||
      null;
    const sellerPrice =
      v.seller_price ||
      v.sellerPrice ||
      partMarketingPrice?.seller_price ||
      null;
    const marketingPriceCurrency =
      v.marketing_price_currency ||
      v.marketingPriceCurrency ||
      partMarketingPrice?.price?.currencyCode ||
      partMarketingPrice?.price?.currency_code ||
      partMarketingPrice?.price?.currency ||
      partMarketingPrice?.currencyCode ||
      partMarketingPrice?.currency_code ||
      partMarketingPrice?.currency ||
      v.currency_code ||
      v.currency ||
      null;
    const categories = (v.categories || []).map(c => ({
      id: Number(c.id),
      level: Number(c.level),
      name: c.name || '',
      title: c.title || c.name || '',
    }));
    const deepestCategory = categories.reduce((best, category) => {
      if (!category.id) return best;
      if (!best || Number(category.level) >= Number(best.level)) return category;
      return best;
    }, null);
    const descriptionCategoryId =
      Number(v.description_category_id || v.descriptionCategoryId) ||
      Number(deepestCategory?.id) ||
      0;
    return {
      // variant_id 优先 /search 真返的 variant_id，barcode 兜底
      variant_id: v.variant_id || (v.barcodes && v.barcodes[0]) || '',
      description_category_id: descriptionCategoryId,
      categories,
      // 把 /search 的额外字段也带上，方便上层（如跟卖面板的 is_copy_allowed 检查）使用
      _searchMeta: {
        skus: v.skus || [],
        barcodes: v.barcodes || [],
        brand_id: v.brand_id,
        is_copy_allowed: v.is_copy_allowed,
        is_content_copy_allowed: v.is_content_copy_allowed,
        rating: v.rating,
      },
      ...(marketingPrice ? { marketing_price: marketingPrice } : {}),
      ...(sellerPrice ? { seller_price: sellerPrice } : {}),
      ...(marketingPriceCurrency ? { marketing_price_currency: marketingPriceCurrency } : {}),
      attributes,
    };
  };

  /**
   * /api/site/seller-prototype/create-bundle-by-variant-id —— 跟卖源数据完整接口
   *
   * 老 /api/v1/search-variant-model endpoint 2026-05 被 Ozon 下线(全员 404 ResourceNotFound)。
   * 实测 /search 还活但不返物理 attributes(weight/dimensions/description)。
   * Ozon SPA 的 /app/products/copy/list (跟卖列表)用 create-bundle-by-variant-id
   * 这个 endpoint 拿跟卖商品完整后台数据:
   *
   *   item.weight                ← 重量 (grams)
   *   item.depth/width/height    ← 长/宽/高 (mm,Ozon 把"长"叫 depth)
   *   item.barcode               ← GTIN
   *   item.primary_image, images ← 主图 + 图册
   *   item.attributes[]          ← 40-63 个完整后台 attr(品牌/类目/材质/包装/...)
   *
   * 输入 variant_id 必须是 /api/v1/search 返回的真 variant_id(不是 URL 数字 SKU,两者
   * 不同 namespace)。
   *
   * **副作用**: 每次调用 Ozon 端创建一个新 bundle draft,bundle_id 递增。需要 cache
   * 控制 — 同一 SKU 默认 24 小时复用一次。源商品改类目/属性/包装时最多 1 天后刷新;
   * 需要立即刷新可在 sendMessage('searchVariants', { sku, forceRefresh: true })。
   *
   * Headers 实测带 / 不带 x-o3-app-name + x-o3-page-type 都 200 OK,沿用 fetchSellerPortal
   * 默认 headers + urlPrefix='/api/site' 即可。
   */
  const _BUNDLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  // v2 cache key 必须包含 companyId + variantId — 同一 Chrome profile 多 ozon 店时,
  // v1 (只 sku) 会让 B 店复用 A 店的 bundle item,串店导致重量/尺寸/属性串数据。
  // variant_id 在 Ozon 内是 store-scoped(create-bundle-by-variant-id 副作用产物),
  // 加 companyId 是双保险:即使将来 variant_id 复用同 namespace,companyId 也能隔离。
  const _BUNDLE_CACHE_PREFIX = 'jz-sw-bundle-v2:';
  const _bundleCacheKey = (companyId, variantId) =>
    `${_BUNDLE_CACHE_PREFIX}${companyId || 'unknown'}:${variantId}`;

  // SW 启动时清理 v1 缓存 — 它的 key 只用 sku,可能跨店污染过用户数据。
  // 一次性清理,跑完后用户的 v2 缓存重建即可。
  (async () => {
    try {
      const all = await new Promise((r) => chrome.storage.local.get(null, r));
      const stale = Object.keys(all || {}).filter((k) => k.startsWith('jz-sw-bundle:'));
      if (stale.length) {
        await new Promise((r) => chrome.storage.local.remove(stale, r));
        console.log(`[SW] cleared ${stale.length} v1 bundle cache entries (cross-store risk)`);
      }
    } catch {}
  })();

  // SW 启动时清理 24h 过期的采集去重 cache(plan v3 子项 ②)。
  // key 形如 `jz-collect-recent-v1:{host}:{storeId}:{sourceId}:{sku}`,
  // 每次 push 成功都新写,过期项靠定期清理避免 chrome.storage.local 5MB 配额撑爆。
  //
  // codex P2 节流:MV3 SW 会反复唤醒/休眠,每次唤醒都全扫 storage 浪费。
  // 用 `jz-collect-recent-cleaned-at` 记录上次清理时间,12h 内不重复清。
  const _COLLECT_CLEANUP_KEY = 'jz-collect-recent-cleaned-at';
  const _COLLECT_CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
  (async () => {
    try {
      const stamp = await new Promise((r) => chrome.storage.local.get([_COLLECT_CLEANUP_KEY], (d) => r(d?.[_COLLECT_CLEANUP_KEY])));
      const now = Date.now();
      // 防御未来时间(时钟回滚 / 数据损坏):只信任 typeof number && <= now 的 stamp
      const stampAt = (stamp && typeof stamp.at === 'number' && stamp.at <= now) ? stamp.at : 0;
      if (stampAt > 0 && now - stampAt < _COLLECT_CLEANUP_INTERVAL_MS) {
        return; // 上次清理还在 12h 内,跳过
      }
      const all = await new Promise((r) => chrome.storage.local.get(null, r));
      const expired = Object.keys(all || {}).filter((k) => {
        if (!k.startsWith('jz-collect-recent-v1:')) return false;
        const entry = all[k];
        return entry && now - (entry.at || 0) >= 24 * 60 * 60 * 1000;
      });
      if (expired.length) {
        await new Promise((r) => chrome.storage.local.remove(expired, r));
        console.log(`[SW] cleared ${expired.length} expired collect dedupe entries (>24h)`);
      }
      await new Promise((r) => chrome.storage.local.set({ [_COLLECT_CLEANUP_KEY]: { at: now } }, r));
    } catch {}
  })();

  const fetchBundleByVariantId = async (sku, variantId, companyId, opts = {}) => {
    const cacheKey = _bundleCacheKey(companyId, variantId);
    // L1: chrome.storage.local cache(同 company+variant 24h 复用)
    // forceRefresh=true 跳过 cache 命中,直接调 endpoint 拉新 bundle(用于源商品改了类目/属性时手动刷新)
    if (!opts.forceRefresh) {
      try {
        const cached = await new Promise((resolve) => {
          chrome.storage.local.get([cacheKey], (data) => {
            resolve(data?.[cacheKey] || null);
          });
        });
        if (cached && Date.now() - (cached.at || 0) < _BUNDLE_CACHE_TTL_MS && cached.item) {
          // 无 attributes 的缓存条目 = 疑似瞬时降级产物(实测 sku 3270906481:空属性 bundle
          // 被缓存后 24h 内每次采集复用空壳 → 批量上架特征属性全缺、内容评分 0/30)。
          // 只有"重拉验证过确实没有"(attrsEmptyVerifiedAt 6h 内)才复用,否则视为 stale 真拉刷新。
          const cachedHasAttrs = Array.isArray(cached.item.attributes) && cached.item.attributes.length > 0;
          if (cachedHasAttrs) return cached.item;
          const attrsEmptyVerifiedAt = Number(cached.attrsEmptyVerifiedAt || 0);
          if (attrsEmptyVerifiedAt && Date.now() - attrsEmptyVerifiedAt < 6 * 60 * 60 * 1000) {
            return cached.item;
          }
        }
      } catch {}
    }

    // L2: 真调 endpoint(有副作用)
    const resp = await fetchSellerPortal(
      '/seller-prototype/create-bundle-by-variant-id',
      {
        company_id: String(companyId),
        variant_id: String(variantId),
        source: 'SOURCE_UI_COPY_APPAREL',
      },
      { urlPrefix: '/api/site', pageType: 'products', timeoutMs: 30000, allowOzonTab: true, preferTabId: opts.preferTabId },
    );
    const item = resp?.item || null;
    if (!item) return null;

    // 写 cache(包括 sku + bundle_id 便于 debug,但 item 才是数据本体)。
    // 真拉回来仍无 attributes → 打 attrsEmptyVerifiedAt 标记:6h 内按"确实没有"复用,
    // 过期再验(与上面读侧守卫配对,避免对天生无属性的品每次采集都真拉)。
    try {
      const hasSimpleAttrs = Array.isArray(item.attributes) && item.attributes.length > 0;
      chrome.storage.local.set({
        [cacheKey]: {
          at: Date.now(), item, sku, bundleId: resp.bundle_id || null,
          ...(hasSimpleAttrs ? {} : { attrsEmptyVerifiedAt: Date.now() }),
        },
      });
    } catch {}

    return item;
  };

  // ── 门户上架(seller-prototype bundle 合并卡)── 绕官方 /v3/product/import 限流。
  // 全部复用 fetchSellerPortal(urlPrefix=/api/site, pageType=products, allowOzonTab)
  // 在浏览器里跑,带用户真实 cookie/UA/fingerprint 绕反爬。详见门户接口契约。
  const _bundlePortalOpts = (preferTabId, timeoutMs = 30000) => ({
    urlPrefix: '/api/site', pageType: 'products', timeoutMs, allowOzonTab: true, preferTabId,
  });

  // 建空草稿 → { bundle_id }
  const createBundle = async (companyId, preferTabId) => {
    const resp = await fetchSellerPortal(
      '/seller-prototype/create-bundle',
      { company_id: String(companyId) },
      _bundlePortalOpts(preferTabId),
    );
    const bundleId = resp?.bundle_id;
    if (!bundleId) throw new Error('create-bundle 未返回 bundle_id');
    return String(bundleId);
  };

  // 写入/保存草稿全部商品数据(可反复调)→ {}
  const updateBundleItems = async (bundleId, companyId, items, source, catName, preferTabId) =>
    fetchSellerPortal(
      '/seller-prototype/update-bundle-items',
      {
        bundle_id: String(bundleId),
        company_id: String(companyId),
        source: source || 'SOURCE_MERGED',
        description_category_lvl3_name: catName || '',
        items,
      },
      _bundlePortalOpts(preferTabId),
    );

  // 提交发布:草稿 → 真实商品 → { upload_task_id }
  const uploadBundle = async (bundleId, companyId, preferTabId) => {
    const resp = await fetchSellerPortal(
      '/seller-prototype/upload-bundle',
      { bundle_id: String(bundleId), company_id: String(companyId), strict: true },
      _bundlePortalOpts(preferTabId),
    );
    const taskId = resp?.upload_task_id;
    if (!taskId) throw new Error('upload-bundle 未返回 upload_task_id');
    return String(taskId);
  };

  // 轮询任务进度(processed/failed/warned/status,source=bundle)
  const getUploadTaskList = async (companyId, { limit = 30, page = 1 } = {}, preferTabId) =>
    fetchSellerPortal(
      '/async-upload/v1/task/get-list',
      { company_id: String(companyId), limit, page },
      _bundlePortalOpts(preferTabId),
    );

  // 拉每个 SKU 的失败原因(task_id 必须是数字)
  const getUploadTaskErrors = async (companyId, taskId, { page = 1, page_size = 50 } = {}, preferTabId) =>
    fetchSellerPortal(
      '/async-upload/v1/task/get-errors',
      { company_id: String(companyId), task_id: Number(taskId), page, page_size },
      _bundlePortalOpts(preferTabId),
    );

  // 解析当前登录店铺的 sc_company_id(门户接口都要它)
  const resolveSellerCompanyId = async () => {
    const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
    const companyId = scCookies[0]?.value || '';
    if (!companyId) throw new Error('sc_company_id cookie 未找到,请确保已登录 seller.ozon.ru');
    return companyId;
  };

  /**
   * 门户上架编排(follow-sell viaPortal):
   *   1) 后端 /ozon/products/prepare-bundle-items 同步复用全加工流水线 → 分组好的 bundles
   *   2) 解析 sc_company_id
   *   3) 逐 bundle: create-bundle → update-bundle-items → upload-bundle
   * 返回形状对齐现有 importResult.result.task_id(content 端取 task_id 不变)。
   */
  const importViaPortal = async (message, token, targetStoreId, backendUrl, preferTabId) => {
    const prep = await apiRequest(
      'POST', `${backendUrl}/ozon/products/prepare-bundle-items`, message, token, targetStoreId, 120_000,
    );
    const result = prep?.result || {};
    const bundles = Array.isArray(result.bundles) ? result.bundles : [];
    if (bundles.length === 0) {
      throw new Error(result.message || '无可上架商品(源数据不可用或被严格模式跳过)');
    }
    const companyId = await resolveSellerCompanyId();
    // 公司一致性护栏:门户路只能在「浏览器当前登录 seller.ozon.ru 的店铺」建商品。
    // 后端给了目标店铺的 company_id 且与当前登录不一致 → 会建到错误店铺,立即中止并提示切换。
    const storeCompanyId = result.store_company_id ? String(result.store_company_id) : '';
    if (storeCompanyId && storeCompanyId !== String(companyId)) {
      throw new Error(`所选店铺与当前 seller.ozon.ru 登录店铺不一致(目标 ${storeCompanyId} / 当前 ${companyId}),门户上架请先在浏览器切换到该店铺登录`);
    }
    const withRetry = async (fn, label, maxAttempts = 3) => {
      for (let i = 1; i <= maxAttempts; i++) {
        try { return await fn(); }
        catch (e) {
          if (i === maxAttempts) throw e;
          const wait = 1000 * Math.pow(2, i - 1);
          console.warn(`[importViaPortal] ${label} 第${i}次失败, ${wait}ms 后重试:`, e?.message || e);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    };
    const taskIds = [];
    const bundleIds = [];
    const bundleErrors = [];
    for (const b of bundles) {
      try {
        const bundleId = await withRetry(() => createBundle(companyId, preferTabId), 'createBundle');
        await withRetry(() => updateBundleItems(bundleId, companyId, b.items, b.source, b.description_category_lvl3_name, preferTabId), 'updateBundleItems');
        const taskId = await withRetry(() => uploadBundle(bundleId, companyId, preferTabId), 'uploadBundle');
        bundleIds.push(bundleId);
        taskIds.push(taskId);
      } catch (e) {
        const offers = Array.isArray(b.items) ? b.items.map((x) => x.offer_id).filter(Boolean) : [];
        bundleErrors.push({ offers, error: e?.message || String(e) });
        console.warn('[importViaPortal] bundle 失败:', offers.join(','), e?.message || e);
      }
    }
    if (taskIds.length === 0) {
      throw new Error(`门户上架失败: ${bundleErrors.map((x) => x.error).join('; ') || '未知错误'}`);
    }
    return {
      result: {
        viaPortal: true,
        task_id: taskIds[0],
        task_ids: taskIds,
        bundle_ids: bundleIds,
        company_id: companyId,
        strictSkipped: result.strictSkipped || [],
        invalidImage: result.invalidImage || [],
        bundleErrors,
      },
    };
  };

  /**
   * 返回一个 status='complete' 的 seller.ozon.ru tab,优先 /app/* 路径
   * (避免命中 signin/login 中间页)。没有就自动后台打开 pinned tab 并等加载完成,
   * 用户首次跟卖时会看到一个 pinned 短标签,无须手动打开。
   *
   * caller 应直接用返回值,不要自己再 query+find,否则会引入
   * "等到了一个 complete 的,但 query 后却选了另一个 loading 的" 竞态。
   */
  // 内部实现;对外用下方带 single-flight 的 ensureSellerTab 包装。
  const _ensureSellerTabImpl = async (timeoutMs = 20000) => {
    const queryTabs = () => chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
    // 2026-05-30:排除 signin/registration/auth/login 页 —— 它们的 URL 也含 /app/
    // (如 /app/registration/signin),旧 find(url.includes('/app/')) 会误选到登录页,
    // 注入后页面无有效会话 / SPA 拦截 fetch。优先选真业务页,auth 页排最后兜底。
    // (companyId 走域级 cookie 不依赖选哪个 tab,但选业务页注入更稳,也跟
    //  getMarketStats 的 tab 选择口径统一。)
    const isAuthUrl = (u) => /\/(registration|signin|auth|login)/i.test(u || '');
    const pickReadyTab = (list) =>
      list.find(t => t.status === 'complete' && t.url?.includes('/app/') && !isAuthUrl(t.url))
      || list.find(t => t.status === 'complete' && !isAuthUrl(t.url))
      || list.find(t => t.status === 'complete' && t.url?.includes('/app/'))
      || list.find(t => t.status === 'complete')
      || null;

    let tabs = await queryTabs();
    let ready = pickReadyTab(tabs);
    if (ready) return ready;

    // 有 tab 但都在 loading → 等它们 complete；途中全被关掉就落到下面 create
    if (tabs.length) {
      console.log('[ensureSellerTab] 已有 tab 但都在加载中，等待 complete...');
      const waitDeadline = Date.now() + timeoutMs;
      while (Date.now() < waitDeadline) {
        await new Promise(r => setTimeout(r, 500));
        tabs = await queryTabs();
        ready = pickReadyTab(tabs);
        if (ready) return ready;
        if (tabs.length === 0) break;
      }
      // 等待超时或全被关 → fall through 到 create 一个新 tab
      console.warn('[ensureSellerTab] 等待已有 tab complete 失败，新开一个');
    }

    console.log('[ensureSellerTab] 无可用 seller.ozon.ru tab，后台打开...');
    const created = await chrome.tabs.create({
      url: 'https://seller.ozon.ru/app/products/copy/list',
      active: false,
      pinned: true,
    });

    const createDeadline = Date.now() + timeoutMs;
    while (Date.now() < createDeadline) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const t = await chrome.tabs.get(created.id);
        if (t.status === 'complete') {
          console.log(`[ensureSellerTab] tab ${created.id} 加载完成，url=${t.url}`);
          return t;
        }
      } catch {
        throw new Error('自动打开的 seller.ozon.ru tab 已被关闭');
      }
    }
    throw new Error(`seller.ozon.ru tab 加载超时（${timeoutMs / 1000}s）`);
  };

  // single-flight 包装:并发调用(列表页多卡同时要市场数据/变体、或 fast-path 回退叠加)
  // 共享同一次"找或开 seller tab",避免各自 query→见无→create 把 seller tab 开出多个。
  // settle(成功/失败)即清缓存,允许该 tab 被关掉后下次重新开。
  let _ensureSellerTabInflight = null;
  const ensureSellerTab = (timeoutMs = 20000) => {
    if (_ensureSellerTabInflight) return _ensureSellerTabInflight;
    _ensureSellerTabInflight = _ensureSellerTabImpl(timeoutMs).finally(() => {
      _ensureSellerTabInflight = null;
    });
    return _ensureSellerTabInflight;
  };

  // what_to_sell/data/v3 单条 item 字段归一 —— 防 Ozon 改大小写/命名导致「月销量等市场
  // 字段全空但无报错横幅」的静默回归。下游(shared-utils jzPopulatePanelV2 / jzMergeCardPanelData)
  // 只读固定 camelCase(d.soldCount / d.gmvSum / d.salesDynamics ...);后端 ozon-market-data
  // .service.ts:normalizeProductItem 早已对 SoldCount/GmvSum 等 PascalCase 做兜底,扩展这条
  // 直连路一直没做 → 这里对齐后端口径。spread 原 item 保留所有已有字段(零回归),只对会被
  // 下游消费的字段补「camelCase ?? PascalCase ?? snake_case」别名,缺失才回填、绝不覆盖已有值。
  const normalizeMarketItem = (item) => {
    if (!item || typeof item !== 'object') return item;
    const pick = (...keys) => {
      for (const k of keys) if (item[k] != null) return item[k];
      return undefined;
    };
    return {
      ...item,
      // 核心销量/金额
      soldCount: pick('soldCount', 'SoldCount', 'sold_count', 'sales', 'Sales'),
      gmvSum: pick('gmvSum', 'GmvSum', 'gmv_sum', 'revenue', 'Revenue'),
      avgPrice: pick('avgPrice', 'AvgGmv', 'avgGmv', 'avg_price', 'price', 'Price'),
      salesDynamics: pick('salesDynamics', 'SalesDynamics', 'sales_dynamics'),
      drr: pick('drr', 'Drr', 'DRR'),
      // 日均
      avgOrdersOnAccDays: pick('avgOrdersOnAccDays', 'AvgOrdersOnAccDays', 'avg_orders_on_acc_days'),
      avgGmvOnAccDays: pick('avgGmvOnAccDays', 'AvgGmvOnAccDays', 'avg_gmv_on_acc_days'),
      // 促销与推广
      daysInPromo: pick('daysInPromo', 'DaysInPromo', 'days_in_promo'),
      discount: pick('discount', 'Discount'),
      promoRevenueShare: pick('promoRevenueShare', 'PromoRevenueShare'),
      daysWithTrafarets: pick('daysWithTrafarets', 'DaysWithTrafarets'),
      // 流量与转化
      qtyViewPdp: pick('qtyViewPdp', 'QtyViewPdp', 'qty_view_pdp'),
      sessionCount: pick('sessionCount', 'SessionCount', 'session_count'),
      sessionCountSearch: pick('sessionCountSearch', 'SessionCountSearch', 'session_count_search'),
      pdpToCartConversion: pick('pdpToCartConversion', 'PdpToCartConversion'),
      convToCartPdp: pick('convToCartPdp', 'ConvToCartPdp'),
      convToCartSearch: pick('convToCartSearch', 'ConvToCartSearch'),
      convViewToOrder: pick('convViewToOrder', 'ConvViewToOrder'),
      views: pick('views', 'Views'),
      // 物流与商品
      stock: pick('stock', 'Stock', 'balance'),
      salesSchema: pick('salesSchema', 'SalesSchema', 'sales_schema'),
      nullableRedemptionRate: pick('nullableRedemptionRate', 'NullableRedemptionRate', 'redemptionRate'),
      nullableCreateDate: pick('nullableCreateDate', 'NullableCreateDate', 'createDate', 'CreateDate'),
    };
  };

  // 找/开一个 www.ozon.ru 买家 tab，用于在 MAIN world 跑 composer-api 抓 PDP 图册视频
  // （SW 直 fetch composer-api 反爬必死 403，必须借买家 tab 的 cookie/UA/fingerprint）。
  // 用于 batch-upload（扩展页发起、无 ozon.ru content_script sender）逐 SKU 抓竞品视频。
  const ensureBuyerTab = async (timeoutMs = 20000) => {
    const queryTabs = () => chrome.tabs.query({ url: ['https://www.ozon.ru/*', 'https://ozon.ru/*'] });
    const pickReady = (list) =>
      list.find(t => t.status === 'complete' && /\/(product|category|search)\b/i.test(t.url || ''))
      || list.find(t => t.status === 'complete')
      || null;
    let tabs = await queryTabs();
    let ready = pickReady(tabs);
    if (ready) return ready;
    if (tabs.length) {
      const waitDeadline = Date.now() + timeoutMs;
      while (Date.now() < waitDeadline) {
        await new Promise(r => setTimeout(r, 500));
        tabs = await queryTabs();
        ready = pickReady(tabs);
        if (ready) return ready;
        if (tabs.length === 0) break;
      }
    }
    console.log('[ensureBuyerTab] 无可用 www.ozon.ru tab，后台打开...');
    const created = await chrome.tabs.create({ url: 'https://www.ozon.ru/', active: false, pinned: true });
    const createDeadline = Date.now() + timeoutMs;
    while (Date.now() < createDeadline) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const t = await chrome.tabs.get(created.id);
        if (t.status === 'complete') return t;
      } catch {
        throw new Error('自动打开的 www.ozon.ru tab 已被关闭');
      }
    }
    throw new Error(`www.ozon.ru tab 加载超时（${timeoutMs / 1000}s）`);
  };

  // 把任意 .mp4 直链转存成卖家自有 Ozon 视频(ir.ozone.ru/s3):走 seller-tab MAIN world 会话
  // 上传 /api/media-storage/upload-file。返回 { ok, url } 或 { ok:false, error }。
  // 抽自原 uploadFollowSellVideo case,供「一键跟卖 / 单采 / 纯采集 / 批量上架」共用同一转存实现。
  const transferVideoToOzon = async (srcUrl) => {
    if (!srcUrl || typeof srcUrl !== 'string') return { ok: false, error: 'srcUrl required' };
    const targetTab = await ensureSellerTab();
    const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
    const companyId = scCookies[0]?.value || '';
    if (!companyId) {
      return { ok: false, error: 'AUTH_REQUIRED', message: 'sc_company_id cookie 未找到，请先登录 seller.ozon.ru' };
    }
    // 在 seller.ozon.ru tab 的 MAIN world 跑:跨源拉源 .mp4 → multipart 同源 POST(带 cookie)。
    const doUpload = async (src, xCompanyId, timeout) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const dl = await fetch(src, { signal: controller.signal });
        if (!dl.ok) { clearTimeout(timer); return { ok: false, error: '源视频下载失败 ' + dl.status }; }
        const blob = await dl.blob();
        if (!blob || blob.size === 0) { clearTimeout(timer); return { ok: false, error: '源视频为空' }; }
        const fname = ((src.split('/').pop() || 'video.mp4').split('?')[0].split('#')[0]) || 'video.mp4';
        const fd = new FormData();
        fd.append('file_name', fname);
        fd.append('tmp', 'true');
        fd.append('body', new File([blob], fname, { type: blob.type || 'video/mp4' }));
        const resp = await fetch('https://seller.ozon.ru/api/media-storage/upload-file', {
          method: 'POST',
          signal: controller.signal,
          credentials: 'include',
          headers: { 'accept': 'application/json, text/plain, */*', 'x-o3-company-id': xCompanyId, 'x-o3-language': 'zh-Hans' },
          body: fd,
        });
        clearTimeout(timer);
        if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
          return { ok: false, status: 401, error: 'Seller portal cookie已过期，请重新登录' };
        }
        if (!resp.ok) { const t = await resp.text().catch(() => ''); return { ok: false, status: resp.status, error: 'upload-file ' + resp.status + ': ' + t.slice(0, 200) }; }
        const j = await resp.json().catch(() => null);
        return { ok: true, url: (j && j.url) || null, size: blob.size };
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, error: e.name === 'AbortError' ? '上传超时' : (e.message || String(e)) };
      }
    };
    const results = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId: targetTab.id }, func: doUpload, args: [srcUrl, companyId, 90000], world: 'MAIN' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), 95000)),
    ]);
    const r = results && results[0] && results[0].result;
    if (!r) return { ok: false, error: 'executeScript 未返回结果' };
    if (!r.ok || !r.url) return { ok: false, error: r.error || '上传未返回 url' };
    console.log(`[transferVideoToOzon] ${srcUrl} → ${r.url} (${r.size}B)`);
    return { ok: true, url: r.url };
  };

  // 借买家 tab 抓某商品 PDP 的 webGallery .mp4 直链 + 源富内容(11254 文档)+ 源描述(4191)
  // + 源主题标签(23171)。给 batch-upload 逐 SKU 用:扩展页无 ozon.ru content_script,只能经
  // ensureBuyerTab 注入 fetch。/api/v1/search 不返 4191/11254/23171,这三样只活在 PDP 的
  // webDescription/富内容/webHashtags widget,故与视频同一次 page json 一并抽,零增量请求 ——
  // 让批量上架继承源店铺描述与标签(与手动跟卖 extractPageDescription/extractKeywords 同语义)。
  // 注:源标签裸下发会触发 Ozon BR_hashtag_brand,品牌清洗在 backend 注入处做(此处只负责抓回)。
  // 返回 { mp4, richContent, description, hashtags };失败返回全空(best-effort 降级)。
  const fetchVariantMediaViaBuyerTab = async (productUrl) => {
    const EMPTY = { mp4: null, richContent: '', description: '', hashtags: [] };
    if (!productUrl || typeof productUrl !== 'string') return EMPTY;
    let path = productUrl;
    try {
      const u = new URL(productUrl, 'https://www.ozon.ru');
      path = u.pathname + u.search;
    } catch {}
    if (!path.startsWith('/')) path = '/' + path;
    let tab;
    try { tab = await ensureBuyerTab(); } catch (e) { console.warn('[fetchVariantMedia] ensureBuyerTab 失败:', e?.message || e); return EMPTY; }
    // MAIN world:相对路径同源命中(www.ozon.ru / ozon.kz),依次试 entrypoint→composer
    // (与 fetchOzonPublicProduct 同口径)。executeScript 序列化注入,不能引用 SW 闭包 ——
    // 富内容抽取逻辑须内联(与 content/ozon-product.js 的 jzExtractRichContentFromStates
    // 同规则:richAnnotationJson 字符串 / state 顶层 {content:[{widgetName}],version})。
    const doFetch = async (relPath, timeout) => {
      const parseMaybeJson = (value) => {
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
        try { return JSON.parse(trimmed); } catch { return value; }
      };
      const normalizeOzonProductInnerPath = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return '';
        try {
          const url = new URL(raw, 'https://www.ozon.ru');
          return (url.pathname || '') + (url.search || '');
        } catch {
          const noHash = raw.split('#')[0];
          return noHash.startsWith('/') ? noHash : '/' + noHash;
        }
      };
      const ozonProductPathKey = (value) =>
        normalizeOzonProductInnerPath(value).split('?')[0].replace(/\/+$/, '');
      const ozonProductId = (value) => {
        const pathKey = ozonProductPathKey(value);
        const match = pathKey.match(/\/product\/(?:[^/?#]*-)?(\d+)$/i);
        return match ? match[1] : '';
      };
      const endpointQueue = [];
      const seenEndpoints = new Set();
      const enqueuePath = (innerPath) => {
        const normalized = normalizeOzonProductInnerPath(innerPath);
        if (!normalized) return;
        const urls = [
          `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(normalized)}`,
          `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(normalized)}`,
        ];
        for (const url of urls) {
          if (seenEndpoints.has(url)) continue;
          seenEndpoints.add(url);
          endpointQueue.push(url);
        }
      };
      enqueuePath(relPath);
      const isRichDoc = (o) =>
        o && typeof o === 'object' && Array.isArray(o.content) && o.content.length > 0 &&
        o.content.some((b) => b && typeof b === 'object' && typeof b.widgetName === 'string');
      const collectRichStats = (doc) => {
        const stats = {
          widgetCount: 0,
          textWidgetCount: 0,
          layoutWidgetCount: 0,
          chessWidgetCount: 0,
          imageCount: 0,
          textNodeCount: 0,
          textChars: 0,
          hasRealText: false,
        };
        const skipTextKeys = new Set([
          'widgetName', 'align', 'size', 'color', 'type', 'src', 'srcMobile', 'url', 'link', 'imgLink',
          'richAnnotationJson', 'class', 'className', 'style', 'trackingInfo', 'layoutTrackingInfo',
          'gifUrl', 'videoUrl', 'previewUrl', 'backgroundColor', 'theme', 'padding', 'margin', 'id',
          'reff', 'fontColor', 'borderColor', 'position', 'positionMobile',
        ]);
        const looksLikeImageUrl = (text) => /^https?:\/\/.+\.(?:jpg|jpeg|png|webp|gif|avif)(?:[?#].*)?$/i.test(text);
        const pushText = (value, key) => {
          if (key && skipTextKeys.has(key)) return;
          const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
          if (text.length < 2 || /^https?:\/\//i.test(text) || looksLikeImageUrl(text)) return;
          if (!/[A-Za-zА-Яа-яЁё]/.test(text)) return;
          stats.textNodeCount += 1;
          stats.textChars += text.length;
        };
        const walk = (node, key, depth) => {
          if (node == null || depth > 24) return;
          if (typeof node === 'string') { pushText(node, key); return; }
          if (Array.isArray(node)) { for (const item of node) walk(item, key, depth + 1); return; }
          if (typeof node !== 'object') return;
          const widgetName = String(node.widgetName || '');
          const type = String(node.type || '');
          if (widgetName) {
            stats.widgetCount += 1;
            if (/text|description|annotation/i.test(widgetName)) stats.textWidgetCount += 1;
            if (/chess/i.test(widgetName) || /chess/i.test(type)) stats.chessWidgetCount += 1;
            if (/showcase|billboard|roll|tile|media|chess/i.test(widgetName) || /billboard|roll|chess|tile/i.test(type)) {
              stats.layoutWidgetCount += 1;
            }
          }
          if (node.img && typeof node.img === 'object') stats.imageCount += 1;
          for (const imageKey of ['src', 'srcMobile', 'url', 'image', 'imageUrl', 'coverImage']) {
            const raw = node[imageKey];
            if (typeof raw === 'string' && /^https?:\/\//i.test(raw) && looksLikeImageUrl(raw)) stats.imageCount += 1;
          }
          for (const childKey of Object.keys(node)) {
            if (skipTextKeys.has(childKey) && childKey !== 'text' && childKey !== 'title') continue;
            walk(node[childKey], childKey, depth + 1);
          }
        };
        walk(doc?.content, 'content', 0);
        stats.hasRealText = stats.textChars >= 12 || stats.textNodeCount >= 2 || stats.textWidgetCount > 0;
        return stats;
      };
      const extractRich = (states) => {
        const candidates = [];
        const seenJson = new Set();
        const seenObjects = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
        const addCandidate = (doc, rawJson) => {
          if (!isRichDoc(doc)) return;
          const json = typeof rawJson === 'string' && rawJson.trim()
            ? rawJson.trim()
            : JSON.stringify({ content: doc.content, version: doc.version || 0.3 });
          if (seenJson.has(json)) return;
          seenJson.add(json);
          const stats = collectRichStats(doc);
          candidates.push({
            json,
            score:
              (stats.hasRealText ? 100000 : 0) +
              stats.chessWidgetCount * 20000 +
              stats.textWidgetCount * 12000 +
              stats.layoutWidgetCount * 600 +
              stats.textChars * 40 +
              stats.textNodeCount * 500 +
              stats.widgetCount * 80 +
              stats.imageCount * 20 +
              Math.min(json.length, 20000) / 20000 -
              candidates.length / 1000,
          });
        };
        const walk = (node, depth) => {
          if (node == null || depth > 24) return;
          const parsed = parseMaybeJson(node);
          if (!parsed || typeof parsed !== 'object') return;
          if (seenObjects) {
            if (seenObjects.has(parsed)) return;
            seenObjects.add(parsed);
          }
          if (typeof parsed.richAnnotationJson === 'string' && parsed.richAnnotationJson.trim()) {
            addCandidate(parseMaybeJson(parsed.richAnnotationJson), parsed.richAnnotationJson);
          }
          if (isRichDoc(parsed)) addCandidate(parsed, null);
          if (Array.isArray(parsed)) {
            for (const item of parsed) walk(item, depth + 1);
            return;
          }
          for (const key of Object.keys(parsed)) walk(parsed[key], depth + 1);
        };
        walk(states, 0);
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.json || '';
      };
      const hasRichContentText = (raw) => {
        const doc = parseMaybeJson(raw);
        return isRichDoc(doc) && collectRichStats(doc).hasRealText;
      };
      const collectOzonRichContentPagePaths = (states, currentPath) => {
        const out = [];
        const seenPaths = new Set();
        const seenObjects = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
        const currentProductKey = ozonProductPathKey(currentPath);
        const currentProductId = ozonProductId(currentPath);
        const push = (candidate) => {
          const pagePath = normalizeOzonProductInnerPath(candidate);
          if (!pagePath || !/[?&]layout_container=pdpPage2column(?:&|$)/.test(pagePath)) return;
          const productKey = ozonProductPathKey(pagePath);
          const productId = ozonProductId(pagePath);
          if (currentProductId && productId && currentProductId !== productId) return;
          if ((!currentProductId || !productId) && currentProductKey && productKey && productKey !== currentProductKey) return;
          if (seenPaths.has(pagePath)) return;
          seenPaths.add(pagePath);
          out.push(pagePath);
        };
        const walk = (node, depth) => {
          if (node == null || depth > 18) return;
          const parsed = parseMaybeJson(node);
          if (!parsed || typeof parsed !== 'object') return;
          if (seenObjects) {
            if (seenObjects.has(parsed)) return;
            seenObjects.add(parsed);
          }
          if (typeof parsed.nextPage === 'string') push(parsed.nextPage);
          if (Array.isArray(parsed)) {
            for (const item of parsed) walk(item, depth + 1);
            return;
          }
          for (const key of Object.keys(parsed)) walk(parsed[key], depth + 1);
        };
        walk(states, 0);
        return out;
      };
      const extractMp4 = (states) => {
        const helper = globalThis.JZOzonVideoExtract;
        if (helper && typeof helper.extractOzonMp4FromSources === 'function') {
          const found = helper.extractOzonMp4FromSources(Object.values(states || {}));
          if (found) return found;
        }
        for (const k of Object.keys(states || {})) {
          if (!/gallery/i.test(k)) continue;
          let v = states[k];
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch { continue; } }
          const vids = v && Array.isArray(v.videos) ? v.videos : [];
          for (const it of vids) {
            const raw = typeof it === 'string' ? it : (it && (it.url || it.src) || '');
            if (raw && /\.mp4(\?|#|$)/i.test(raw)) return raw;
          }
        }
        return null;
      };
      // 源描述(4191):优先 webDescription widget,复用注入的 JZFollowSellContentCopy.extractDescriptionText
      // (与手动跟卖同一套富文本/HTML 解析,绝不把原始 JSON 串当描述)。helper 注入失败则降级空。
      const extractDescription = (states) => {
        const helper = globalThis.JZFollowSellContentCopy;
        if (!helper || typeof helper.extractDescriptionText !== 'function') return '';
        const keys = Object.keys(states || {});
        const descKeys = keys.filter((k) => /description/i.test(k));
        for (const k of descKeys) {
          let v = states[k];
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* 当字符串直接抽 */ } }
          const text = helper.extractDescriptionText(v, 4096);
          if (text) return text;
        }
        return '';
      };
      // 源主题标签(23171):从 webHashtags/tagList state 里递归捞 `#` 前缀串。纯内联(无 helper 依赖),
      // 去重 + 上限 30(Ozon 单卡上限)。品牌清洗在 backend 注入处做,这里只负责把源标签原样抓回。
      const extractHashtags = (states) => {
        const out = [];
        const seen = new Set();
        const push = (s) => {
          const t = String(s == null ? '' : s).trim();
          if (!t || t.length < 2 || !t.startsWith('#')) return;
          const key = t.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          if (out.length < 30) out.push(t);
        };
        const walk = (node, depth) => {
          if (out.length >= 30 || depth > 32 || node == null) return;
          if (typeof node === 'string') { push(node); return; }
          if (Array.isArray(node)) { for (const it of node) walk(it, depth + 1); return; }
          if (typeof node === 'object') { for (const k of Object.keys(node)) walk(node[k], depth + 1); }
        };
        for (const k of Object.keys(states || {})) {
          if (!/hashtag|taglist/i.test(k)) continue;
          let v = states[k];
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch { continue; } }
          walk(v, 0);
        }
        return out;
      };
      let anyOk = false;
      let richContent = '';
      let richContentHasText = false;
      let mp4 = null;
      let description = '';
      let hashtags = [];
      for (let endpointIndex = 0; endpointIndex < endpointQueue.length; endpointIndex += 1) {
        const url = endpointQueue[endpointIndex];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const resp = await fetch(url, { credentials: 'include', headers: { 'x-o3-app-name': 'dweb_client', 'accept': 'application/json' }, signal: controller.signal });
          clearTimeout(timer);
          if (!resp.ok) continue;
          anyOk = true;
          const data = await resp.json();
          const states = data && data.widgetStates ? data.widgetStates : {};
          for (const nextPage of collectOzonRichContentPagePaths(states, relPath)) enqueuePath(nextPage);
          const candidateRichContent = extractRich(states);
          if (candidateRichContent) {
            const candidateHasText = hasRichContentText(candidateRichContent);
            if (!richContent || (!richContentHasText && candidateHasText)) {
              richContent = candidateRichContent;
              richContentHasText = candidateHasText;
            }
          }
          if (!mp4) mp4 = extractMp4(states);
          if (!description) description = extractDescription(states);
          if (!hashtags.length) hashtags = extractHashtags(states);
          // 视频 + 富内容都到手即可提前结束(描述/标签随当前 states 顺带抽,不单独多跑 endpoint);
          // 否则继续试下一个 endpoint(视频/富内容偶尔只在 composer 而不在 entrypoint)。
          if (mp4 && richContent && (richContentHasText || endpointIndex + 1 >= endpointQueue.length)) break;
        } catch (e) {
          clearTimeout(timer);
          // 单个 endpoint 失败 → 试下一个。
        }
      }
      // 有 200 过则按真实抽取结果返回;全失败则 ok:false。
      return anyOk ? { ok: true, mp4, richContent, description, hashtags } : { ok: false, error: 'all endpoints failed' };
    };
    try {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/ozon-video-extract.js'], world: 'MAIN' });
      } catch (e) {
        console.warn('[fetchVariantMedia] video helper inject failed:', e?.message || e);
      }
      try {
        // doFetch 的 extractDescription 复用 JZFollowSellContentCopy.extractDescriptionText;
        // 注入失败仅降级描述抽取(返回空),不影响视频/富内容/标签。
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/follow-sell-content-copy.js'], world: 'MAIN' });
      } catch (e) {
        console.warn('[fetchVariantMedia] content-copy helper inject failed:', e?.message || e);
      }
      const results = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: doFetch, args: [path, 15000], world: 'MAIN' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), 40000)),
      ]);
      const r = results && results[0] && results[0].result;
      if (!r || !r.ok) { console.warn('[fetchVariantMedia] 抓取失败:', r && r.error); return EMPTY; }
      return { mp4: r.mp4 || null, richContent: r.richContent || '', description: r.description || '', hashtags: Array.isArray(r.hashtags) ? r.hashtags : [] };
    } catch (e) {
      console.warn('[fetchVariantMedia] executeScript 异常:', e?.message || e);
      return EMPTY;
    }
  };

  // ── seller.ozon.ru 门户全局节奏闸门 ──────────────────────────────────────────
  // 所有走 fetchSellerPortal 的门户调用(采集 /search + create-bundle、跟卖预取、
  // 数据面板、bestsellers 等)共用这一把闸门,保证相邻两次门户请求至少间隔
  // SELLER_PORTAL_MIN_INTERVAL_MS。seller portal 按"短时请求密度"做反爬风险评分,
  // 批量上架 / 快速浏览叠加时会瞬时打出大量请求触发验证码 / 限制登录;这里把所有出口的
  // 请求节奏串行摊平,是采集层 BATCH 节流之外的全局兜底(作用域不同,二者互补)。
  // 注:transferVideoToOzon 的 upload-file 是独立 executeScript 路径,不经此闸门,
  // 由 sku-collect.js 的 VIDEO_INTERVAL_MS 单独节流。
  const SELLER_PORTAL_MIN_INTERVAL_MS = 200;
  let _sellerPortalGateChain = Promise.resolve();
  let _sellerPortalLastAt = 0;
  const _sellerPortalGate = () => {
    const wait = _sellerPortalGateChain.then(async () => {
      const delta = Date.now() - _sellerPortalLastAt;
      if (delta < SELLER_PORTAL_MIN_INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, SELLER_PORTAL_MIN_INTERVAL_MS - delta));
      }
      _sellerPortalLastAt = Date.now();
    });
    // 串行化:下一个调用排在这次放行之后;.catch 防止异常断链(wait 只 await setTimeout,不会 reject)。
    _sellerPortalGateChain = wait.catch(() => {});
    return wait;
  };

  // ── 跨域快路:在「当前/任意 ozon.ru 标签页」内直发 seller 门户请求 ──────────────
  // 实测(2026-06-14):www.ozon.ru 与 seller.ozon.ru 同属 .ozon.ru,sc_company_id /
  // 登录态 cookie 域级共享;只要满足 CORS「简单请求」(content-type:text/plain、
  // 不带任何 x-o3-* 自定义头、company_id 放进 body),从 www 商品页就能跨域读到
  // seller.ozon.ru/api/v1/search 与 create-bundle-by-variant-id 的响应(type:cors 200)。
  // 好处:用户跟卖时本就在 www 商品页 → 无需另开 / 依赖一个已登录的 seller 专用标签,
  // 根治「请先打开 seller.ozon.ru / executeScript 与 bridge 均不可用」这类失败。
  // 限制:只适用于 company_id 可放 body 的端点(/search、create-bundle);
  // what_to_sell/data/v3 强制 x-o3-company-id 自定义头(必触发预检被 CORS 挡)→ 不走此路。
  // 失败(无 ozon 标签 / 注入失败 / 反爬 / 网络)由 fetchSellerPortal 回退老 seller-tab 路。
  const fetchSellerViaOzonTab = async (path, body, opts = {}, preferTabId = null) => {
    const timeoutMs = opts.timeoutMs || 30000;
    const urlPrefix = opts.urlPrefix !== undefined ? opts.urlPrefix : '/api/v1';

    // 解析目标标签:优先消息来源标签(用户正所在的 www 商品页),否则任意已加载完成的
    // *.ozon.ru 标签(www 或 seller 都行 —— cookie 域级共享、且都有真实浏览器指纹)。
    const isOzonUrl = (u) => /^https?:\/\/([^/]+\.)?ozon\.ru\//i.test(u || '');
    let target = null;
    if (preferTabId) {
      try {
        const t = await chrome.tabs.get(preferTabId);
        if (t && isOzonUrl(t.url)) target = t; // 来源标签是 live 的(它刚发的消息),不强求 complete
      } catch {}
    }
    if (!target) {
      const tabs = await chrome.tabs.query({ url: ['*://*.ozon.ru/*'] });
      target = tabs.find((t) => t.status === 'complete' && t.active)
        || tabs.find((t) => t.status === 'complete')
        || null;
    }
    if (!target) {
      const e = new Error('无可用 ozon.ru 标签(跨域快路)');
      e.tabUnavailable = true;
      throw e;
    }

    // 注入 MAIN world 的跨域 fetch:严格只用 CORS-safelisted 头(content-type:text/plain),
    // company_id 已在 body 内。任何自定义头都会触发预检 → seller 不放行 → Failed to fetch。
    const doFetchXO = async (apiPath, reqBody, timeout, prefix) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const resp = await fetch('https://seller.ozon.ru' + (prefix || '/api/v1') + apiPath, {
          method: 'POST',
          signal: controller.signal,
          credentials: 'include',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify(reqBody),
        });
        clearTimeout(timer);
        if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
          return { ok: false, status: 401, code: 'AUTH_REDIRECT', error: 'Seller portal cookie已过期，请重新登录' };
        }
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          let parsedCode = '';
          try { const j = JSON.parse(text); parsedCode = (j && (j.code || (j.error && j.error.code))) || ''; } catch {}
          return { ok: false, status: resp.status, code: parsedCode, error: `Seller portal 请求失败 (${resp.status}): ${text.slice(0, 200)}` };
        }
        return { ok: true, data: await resp.json() };
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') return { ok: false, error: `请求超时 (${timeout}ms)` };
        return { ok: false, error: e.message || String(e) };
      }
    };

    let results;
    try {
      results = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId: target.id },
          func: doFetchXO,
          args: [path, body, timeoutMs, urlPrefix],
          world: 'MAIN',
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), timeoutMs + 5000)),
      ]);
    } catch (e) {
      // 注入层失败(标签正在导航 / 权限 / 超时)→ 标记 tabUnavailable,允许回退 seller-tab 路
      const err = new Error(`ozon-tab 注入失败: ${e.message || e}`);
      err.tabUnavailable = true;
      throw err;
    }
    const r = results?.[0]?.result;
    if (!r) { const e = new Error('ozon-tab executeScript 未返回结果'); e.tabUnavailable = true; throw e; }
    if (!r.ok) {
      const err = new Error(r.error || 'unknown');
      if (typeof r.status === 'number') err.status = r.status;
      if (typeof r.code === 'string') err.code = r.code;
      throw err; // HTTP 层错误 → 交给 fetchSellerPortal 决定是否回退(404/ResourceNotFound 权威空结果不回退)
    }
    console.log(`[fetchSellerViaOzonTab] ok tab=${target.id} url=${target.url} path=${path}`);
    return r.data;
  };

  const fetchSellerPortal = async (path, body, timeoutMsOrOpts = 30000) => {
    await _sellerPortalGate(); // 全局节奏闸门(见上)——所有门户调用共用,摊平请求密度防反爬
    // 兼容旧调用：第三个参数可以是数字（timeoutMs，默认 page-type=products-other + url=/api/v1+path），
    // 也可以是 opts 对象 { timeoutMs, urlPrefix, pageType }
    const opts = typeof timeoutMsOrOpts === "number"
      ? { timeoutMs: timeoutMsOrOpts }
      : (timeoutMsOrOpts || {});
    const timeoutMs = opts.timeoutMs || 30000;
    const urlPrefix = opts.urlPrefix !== undefined ? opts.urlPrefix : "/api/v1";
    const pageType = opts.pageType || "products-other";

    // 0. 跨域快路:opts.allowOzonTab 的调用(/search、create-bundle —— company_id 在 body、
    // 无需 x-o3-* 自定义头)优先在「当前 ozon.ru 标签页」内直发,免依赖 seller 专用标签。
    // 成功直接返回;404/ResourceNotFound 是权威空结果(SKU 不在目录)也直接抛;
    // 其余失败(无 ozon 标签 / 注入失败 / 反爬 / 网络)静默回退到下面的 seller-tab 老路。
    if (opts.allowOzonTab) {
      try {
        return await fetchSellerViaOzonTab(path, body, opts, opts.preferTabId);
      } catch (e) {
        if (e.status === 404 && e.code === 'ResourceNotFound') throw e;
        console.warn(`[fetchSellerPortal] ozon-tab 快路失败,回退 seller-tab: ${e.message || e}`);
      }
    }

    // 1. Find or auto-open seller.ozon.ru tab —— 直接用 ensureSellerTab 返回的
    // status=complete 的 tab,不再 query+find,避免选到 loading 中的 active tab。
    const targetTab = await ensureSellerTab();

    console.log(`[fetchSellerPortal] tab=${targetTab.id} url=${targetTab.url} path=${path}`);

    // 2. Resolve sc_company_id from chrome.cookies
    const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
    const companyId = scCookies[0]?.value || '';
    if (!companyId) {
      throw new Error('sc_company_id cookie 未找到，请确保已登录 seller.ozon.ru');
    }

    // 3. Try executeScript first (with hard timeout), fallback to bridge
    const doFetch = async (apiPath, reqBody, xCompanyId, timeout, prefix, pageTypeHdr) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const resp = await fetch('https://seller.ozon.ru' + (prefix || '/api/v1') + apiPath, {
          method: 'POST',
          signal: controller.signal,
          credentials: 'include',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'x-o3-app-name': 'seller-ui',
            'x-o3-company-id': xCompanyId,
            'x-o3-language': 'zh-Hans',
            'x-o3-page-type': pageTypeHdr || 'products-other',
          },
          body: JSON.stringify(reqBody),
        });
        clearTimeout(timer);
        if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
          return { ok: false, status: 401, code: 'AUTH_REDIRECT', error: 'Seller portal cookie已过期，请重新登录' };
        }
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          // codex review HIGH#7:把 status + response.code 单独抠出来传给上游
          // classifyError。原版只塞进字符串 msg,任何字串里凑巧含 "ResourceNotFound"
          // 都会被当业务空结果吞掉。
          let parsedCode = '';
          try {
            const json = JSON.parse(text);
            parsedCode = (json && (json.code || (json.error && json.error.code))) || '';
          } catch {}
          return {
            ok: false,
            status: resp.status,
            code: parsedCode,
            error: `Seller portal 请求失败 (${resp.status}): ${text.slice(0, 200)}`,
          };
        }
        return { ok: true, data: await resp.json() };
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') return { ok: false, error: `请求超时 (${timeout}ms)` };
        return { ok: false, error: e.message || String(e) };
      }
    };

    // Wrap executeScript with a hard timeout to prevent hang
    const tryExecuteScript = () => Promise.race([
      chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: doFetch,
        args: [path, body, companyId, timeoutMs, urlPrefix, pageType],
        world: 'MAIN',
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), timeoutMs + 5000)),
    ]);

    // Bridge fallback (tabs.sendMessage to ozon-seller-bridge.js)
    const tryBridge = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bridge 超时')), timeoutMs + 5000);
      chrome.tabs.sendMessage(targetTab.id, {
        type: 'sellerPortalFetch',
        apiPath: path,
        reqBody: body,
        fallbackCompanyId: companyId,
        timeoutMs,
        urlPrefix,
        pageType,
      }, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        resolve(resp);
      });
    });

    // codex review HIGH#7:把 doFetch 返回的 status / code 透传到 Error 对象上,
    // 让上游 classifyError 直接看 status === 404 && code === 'ResourceNotFound',
    // 不再靠 msg.includes() 字符串 sniffing(会把 "Forbidden ... ResourceNotFound"
    // 之类的混合错误也吞成业务空结果)。
    const makeStructuredError = (r) => {
      const err = new Error(r.error || 'unknown');
      if (typeof r.status === 'number') err.status = r.status;
      if (typeof r.code === 'string') err.code = r.code;
      return err;
    };

    // Strategy: try executeScript → if fail, try bridge → if fail, throw
    const methods = [
      { name: 'executeScript', fn: async () => {
        const results = await tryExecuteScript();
        const r = results?.[0]?.result;
        if (!r) throw new Error('executeScript 未返回结果');
        if (!r.ok) throw makeStructuredError(r);
        return r.data;
      }},
      { name: 'bridge', fn: async () => {
        const r = await tryBridge();
        if (!r) throw new Error('bridge 返回错误');
        if (!r.ok) throw makeStructuredError(r);
        return r.data;
      }},
    ];

    // 收集每个策略的真实错误，最终 throw 时拼进 message —— 保留 "过期/登录/超时/403"
    // 等关键字,让上游 ozon-product.js prefetchSourceVariant 的 errorCode classifier
    // 能命中 AUTH_REQUIRED / TIMEOUT / ANTIBOT_BLOCKED 等具体分类。
    const lastErrors = [];
    for (const m of methods) {
      try {
        console.log(`[fetchSellerPortal] trying ${m.name}...`);
        const data = await m.fn();
        console.log(`[fetchSellerPortal] ${m.name} succeeded`);
        return data;
      } catch (e) {
        const msg = e.message || String(e);
        console.warn(`[fetchSellerPortal] ${m.name} failed: ${msg}`);
        // codex review HIGH#7:status=404 + code=ResourceNotFound 是稳定的业务
        // 空结果(SKU 不在自家目录),不是 strategy 失败 —— 不需要 fallback 到
        // bridge,也不该把它和 strategy 失败混在一起。直接抛 structured error。
        if (e.status === 404 && e.code === 'ResourceNotFound') {
          throw e;
        }
        lastErrors.push({ name: m.name, msg, status: e.status, code: e.code });
      }
    }
    const detail = lastErrors.map(x => `${x.name}: ${x.msg}`).join(' | ');
    const err = new Error(`Seller portal 请求失败 — ${detail}`);
    // 多个 strategy 都失败,挑第一个非空 status 透传(通常 executeScript 已经拿到
    // 后端的 4xx 状态,bridge 失败可能是 chrome runtime 错)。
    const firstWithStatus = lastErrors.find((x) => typeof x.status === 'number');
    if (firstWithStatus) {
      err.status = firstWithStatus.status;
      if (firstWithStatus.code) err.code = firstWithStatus.code;
    }
    throw err;
  };

  /**
   * 在用户的 www.ozon.ru tab 里执行 fetch — 通过 chrome.scripting.executeScript
   * 注入 MAIN world 跑,带着用户真实的 cookie + UA + fingerprint。SW 直 fetch
   * 会被 Ozon 反爬拦截返回 403(Origin: chrome-extension://... 是死亡标记)。
   *
   * 调用场景:
   *   - fetchProductPageState (composer-api page json)
   *
   * @param {Object} sender chrome.runtime.onMessage 的 sender, 至少要有 tab.id + tab.url
   * @param {string} apiUrl 完整 URL,例: 'https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=...'
   * @param {number} timeoutMs
   * @returns {Promise<{ok:true, data:any}|{ok:false, status?:number, error:string}>}
   */
  const fetchOzonWwwViaTab = async (sender, apiUrl, timeoutMs = 15_000) => {
    const tab = sender?.tab;
    const tabUrl = tab?.url || '';
    const tabId = tab?.id;
    // 仅当 sender 是 ozon.ru 域下的 content_script 时走 MAIN world 注入。
    // 弹窗/options/其他扩展页发起的请求落不到这里(它们也用不到这俩 action)。
    // ozon.kz 同样允许,这俩 endpoint 在哈站点也存在。
    const isOzonTab = /^https?:\/\/(?:www\.|m\.)?ozon\.(?:ru|kz)(?::\d+)?\//i.test(tabUrl);
    if (!tabId || !isOzonTab) {
      // 没 tab 上下文 → 退回 SW 直 fetch(几乎必 403,但留口子万一未来 ozon 不反爬了)。
      try {
        const resp = await fetch(apiUrl, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!resp.ok) {
          return { ok: false, status: resp.status, error: `Ozon ${resp.status}` };
        }
        const data = await resp.json();
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: `network: ${e?.message || e}` };
      }
    }
    // executeScript 注入 MAIN world,fetch 跑在 page 上下文,带 www.ozon.ru 完整 cookies。
    const doFetchInPage = async (url, timeout) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const resp = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) {
          return { ok: false, status: resp.status, error: `Ozon ${resp.status}` };
        }
        return { ok: true, data: await resp.json() };
      } catch (e) {
        clearTimeout(timer);
        if (e?.name === 'AbortError') return { ok: false, error: `请求超时 (${timeout}ms)` };
        return { ok: false, error: e?.message || String(e) };
      }
    };
    try {
      const results = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId },
          func: doFetchInPage,
          args: [apiUrl, timeoutMs],
          world: 'MAIN',
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('executeScript 超时')), timeoutMs + 5000),
        ),
      ]);
      const r = results?.[0]?.result;
      if (!r) return { ok: false, error: 'executeScript 未返回结果' };
      return r;
    } catch (e) {
      return { ok: false, error: `executeScript: ${e?.message || e}` };
    }
  };

  function apiPathForLog(url) {
    try {
      const u = new URL(url);
      return `${u.pathname}${u.search}`;
    } catch {
      return String(url || '').replace(/^https?:\/\/[^/]+/i, '');
    }
  }

  function summarizeAiWizardDebugBody(body = {}) {
    const items = Array.isArray(body.items) ? body.items : [];
    const stocks = Array.isArray(body.stocks) ? body.stocks : [];
    const itemOfferIds = items
      .map((item) => String(item?.offer_id || item?.offerId || '').slice(0, 80))
      .filter(Boolean)
      .slice(0, 5);
    const stockOfferIds = stocks
      .map((stock) => String(stock?.offer_id || stock?.offerId || '').slice(0, 80))
      .filter(Boolean)
      .slice(0, 5);

    return {
      sourceId: body.sourceId || undefined,
      rawOfferId: body.rawOfferId || undefined,
      rawTitleLen: body.rawTitleLen,
      rawImageCount: body.rawImageCount,
      language: body.language || undefined,
      modules: Array.isArray(body.modules) ? body.modules : undefined,
      attrScope: body.attrScope || '',
      typeId: body.category?.typeId || undefined,
      descCatId: body.category?.descriptionCategoryId || undefined,
      candidates: Array.isArray(body.candidates) ? body.candidates.length : body.candidates,
      titleLen: typeof body.title === 'string' ? body.title.length : undefined,
      attrTextLen: typeof body.attributes === 'string' ? body.attributes.length : undefined,
      itemCount: items.length || body.itemCount || undefined,
      itemOfferIds: itemOfferIds.length ? itemOfferIds : body.itemOfferIds,
      stockCount: stocks.length || body.stockCount || undefined,
      stockOfferIds: stockOfferIds.length ? stockOfferIds : body.stockOfferIds,
      applyPoster: body.applyPoster,
    };
  }

  function sanitizeAiWizardDebugMeta(meta = {}) {
    const body = summarizeAiWizardDebugBody(meta.body || {});
    return {
      action: meta.action || '',
      method: meta.method || '',
      path: meta.path || '',
      storeId: meta.storeId || '',
      status: meta.status || undefined,
      ok: meta.ok,
      ms: meta.ms,
      timeoutMs: meta.timeoutMs,
      error: meta.error ? String(meta.error).slice(0, 180) : '',
      body,
    };
  }

  function logAiWizardDebug(meta) {
    if (!meta?.debug) return;
    try {
      console.log('[AIW debug]', JSON.stringify(sanitizeAiWizardDebugMeta(meta)));
    } catch {
      console.log('[AIW debug]', meta?.action || '');
    }
  }

  function aiWizardDebugMeta(message, action, body) {
    return message?._aiwDebug ? { debug: true, action: action || message.action, body: body || message.body || {} } : null;
  }

  function stripInternalMessageFields(message) {
    const copy = { ...(message || {}) };
    delete copy._aiwDebug;
    return copy;
  }

  // 上架入口推断:content script 不用逐个改,SW 按消息来源页归因。
  // 后端 sanitizeListingEntry 只收 [a-z0-9-],这里的短代码要与
  // 管理端 sku-upload-records 的 ENTRY_LABELS 映射保持一致。
  function deriveImportEntry(message, sender) {
    if (typeof message?.entry === 'string' && message.entry.trim()) return message.entry.trim();
    const url = String(sender?.url || sender?.tab?.url || '');
    try {
      const u = new URL(url);
      if (u.protocol === 'chrome-extension:') {
        return u.pathname.includes('batch-upload') ? 'batch-upload' : 'extension-page';
      }
      const host = u.hostname;
      if (/(^|\.)1688\.com$/.test(host)) return 'ai-wizard-1688';
      if (/(^|\.)ozon\.(ru|com)$/.test(host)) {
        return u.pathname.startsWith('/product/') ? 'product-page' : 'search-page';
      }
    } catch { /* sender 无 URL(如 popup)→ 归 unknown */ }
    return 'ext-unknown';
  }

  const EXT_VERSION = (() => {
    try { return chrome.runtime.getManifest().version; } catch { return ''; }
  })();

  const apiRequest = async (method, url, body, token, storeId, timeoutMs = 60_000, debugMeta = null) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (storeId) headers['x-ozon-store-id'] = storeId;
    if (EXT_VERSION) headers['x-jz-ext-version'] = EXT_VERSION;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const started = Date.now();
    const debugBase = debugMeta?.debug ? {
      ...debugMeta,
      method,
      path: apiPathForLog(url),
      storeId,
      timeoutMs,
      body: {
        ...summarizeAiWizardDebugBody(debugMeta.body || {}),
        ...summarizeAiWizardDebugBody(body || {}),
      },
    } : null;
    logAiWizardDebug({ ...debugBase, ok: undefined });

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorMsg = '请求失败';
        let errorCode = null;
        // 只读一次 body:先取文本,再尝试 JSON.parse。不能 response.json() 失败后再
        // response.text() —— body 流只能读一次,二次读会抛
        // "Failed to execute 'text' on 'Response': body stream already read",
        // 把真正的后端错误(常是 502/空响应/非 JSON 网关页)掩盖成这条假错误。
        const rawBody = await response.text().catch(() => '');
        try {
          const errorBody = JSON.parse(rawBody);
          errorMsg = errorBody.message || errorBody.error || errorMsg;
          errorCode = errorBody.code || null;
        } catch {
          errorMsg = rawBody || errorMsg;
        }
        // 任何 401（设备被顶 / token 过期 / 签名失败 / 缺 tenant 上下文）
        // 都视为登录失效：清 token + storeId，让前端显示重登提示。
        // 之前只识别 TOKEN_REVOKED，导致 jwt expired 等场景静默失败、
        // 用户继续看到挂死状态。
        if (response.status === 401) {
          await removeStorage([STORAGE_KEYS.token, STORAGE_KEYS.storeId]);
          if (errorCode == null) errorCode = 'AUTH_EXPIRED';
        }
        const err = new Error(`[${response.status}] ${errorMsg}`);
        err.status = response.status;
        err.code = errorCode;
        throw err;
      }

      // 滑动续期:后端在 token 用过半时重签并塞 X-Refreshed-Token,收到就替换本地 token
      // (同 jti、无感),让活跃用户永不掉登录、少弹「请重新登录」。
      const refreshed = response.headers.get('X-Refreshed-Token');
      if (refreshed) {
        try { await setStorage({ [STORAGE_KEYS.token]: refreshed }); } catch {}
      }
      const data = await response.json();
      logAiWizardDebug({
        ...debugBase,
        ok: true,
        status: response.status,
        ms: Date.now() - started,
      });
      return data;
    } catch (e) {
      logAiWizardDebug({
        ...debugBase,
        ok: false,
        status: e?.status,
        ms: Date.now() - started,
        error: e?.message || String(e),
      });
      if (e?.name === 'AbortError' || /signal is aborted/i.test(e?.message || '')) {
        if (timedOut) {
          throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s 无响应）`);
        }
        throw new Error('后台服务被浏览器挂起，请重试');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  // ── 代采(没登卖家端 → 派给同租户已登录设备代采)─────────────────
  // 本机未登录 seller.ozon.ru(无 sc_company_id)时,searchVariants 透明回退到
  // 这里:向后端入队一个 tenant-scope 的 ozon.collect_variant 任务,等同租户内
  // 某台已登录设备(具备 ozon.seller_collect 能力)在它自己的浏览器里跑同一套
  // searchVariants 采集并回传。结果 shape 与本地 searchVariants 完全一致
  // ({ ok:true, data:{ items } }),所以 sku-collect.js 调用方零改动。
  // 返回:成功 → 采集结果对象;无人代采/超时/失败 → null(调用方按未登录处理)。
  const COLLECT_PROXY_POLL_INTERVAL_MS = 1500;
  const COLLECT_PROXY_TIMEOUT_MS = 90_000;
  // 市场数据代采的并发上限:类目/搜索网格一次会对几十个 SKU 调 getMarketStats,未登录用户
  // 若每个都派单会刷爆 job 表 + 拖垮代采设备(代采方串行执行)。这里把同时在途的市场代采
  // 限到 5 个;超出的直接返回 null(那张卡落「需登录」提示),PDP 单品恒能派。批量代采(一个
  // job 带多 SKU)是后续优化项。
  const MD_PROXY_MAX_INFLIGHT = 5;
  let _mdProxyInflight = 0;
  const proxyCollectVariant = async (backendUrl, token, storeId, sku) => {
    if (!token) return null; // 未登录极掌,无法派单
    try {
      const job = await apiRequest(
        'POST',
        `${backendUrl}/browser-agents/collection-jobs`,
        { sku: String(sku), ...(storeId ? { storeId } : {}) },
        token,
        storeId,
        20_000,
      );
      const jobId = job?.id;
      if (!jobId) return null;
      // 已经是终态(罕见:同 SKU 在途任务刚好刚完成)直接用。
      if (job.status === 'succeeded' && job.result) {
        return job.result?.data?.items ? job.result : null;
      }
      const deadline = Date.now() + COLLECT_PROXY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, COLLECT_PROXY_POLL_INTERVAL_MS));
        let cur;
        try {
          cur = await apiRequest(
            'GET',
            `${backendUrl}/browser-agents/collection-jobs/${jobId}`,
            null,
            token,
            storeId,
            20_000,
          );
        } catch (e) {
          // 轮询单次失败不致命,继续重试到 deadline。
          continue;
        }
        if (cur?.status === 'succeeded') {
          // helper 回传的就是 searchVariants 响应({ ok, data:{ items } })。
          return cur.result?.data?.items ? cur.result : null;
        }
        if (['failed', 'expired', 'cancelled', 'skipped'].includes(cur?.status)) {
          return null; // 无人代采或代采失败 → 回退未登录处理
        }
      }
      return null; // 超时
    } catch (e) {
      console.warn('[collect-proxy] dispatch failed:', e?.message || e);
      return null;
    }
  };

  // 代采「市场数据」:本机没登卖家端时,把按 SKU 取月销量(what_to_sell/data/v3)派给同租户/
  // 池子里已登录 seller 的设备代发(后端服务器 IP 直连会撞反爬,只能借用户浏览器)。
  // 与 proxyCollectVariant 同构。成功返回远端 getMarketStats 的整包 { ok, data }(data 可能
  // 为 null = 该 SKU 确无市场数据);派单失败/超时/无人代采返回 null,由调用方回退到「需登录」提示。
  const proxyMarketData = async (backendUrl, token, storeId, sku, period) => {
    if (!token) return null; // 未登录极掌,无法派单
    if (_mdProxyInflight >= MD_PROXY_MAX_INFLIGHT) return null; // 限流:网格场景别刷爆代采池
    _mdProxyInflight++;
    try {
      const job = await apiRequest(
        'POST',
        `${backendUrl}/browser-agents/market-data-jobs`,
        { sku: String(sku), ...(storeId ? { storeId } : {}), ...(period ? { period } : {}) },
        token,
        storeId,
        20_000,
      );
      const jobId = job?.id;
      if (!jobId) return null;
      if (job.status === 'succeeded' && job.result) {
        return job.result; // { ok, data }
      }
      const deadline = Date.now() + COLLECT_PROXY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, COLLECT_PROXY_POLL_INTERVAL_MS));
        let cur;
        try {
          cur = await apiRequest(
            'GET',
            `${backendUrl}/browser-agents/market-data-jobs/${jobId}`,
            null,
            token,
            storeId,
            20_000,
          );
        } catch (e) {
          continue; // 轮询单次失败不致命
        }
        if (cur?.status === 'succeeded') {
          return cur.result || null; // 远端 getMarketStats 整包 { ok, data }
        }
        if (['failed', 'expired', 'cancelled', 'skipped'].includes(cur?.status)) {
          return null; // 无人代采或失败 → 回退「需登录」提示
        }
      }
      return null; // 超时
    } catch (e) {
      console.warn('[market-data-proxy] dispatch failed:', e?.message || e);
      return null;
    } finally {
      _mdProxyInflight--;
    }
  };

  // ── 灰度:3 类请求服务端化(ozon-fleet 机群)──────────────────
  // feature-flag `ozon_fleet_serverside` 命中时,把 search / create-bundle / what_to_sell
  // 经后端 /ozon/fleet/* 走俄罗斯 VPS 机群(服务端 IP);未命中(403)或失败回落浏览器老路。
  // (PDP/composer 竞品抓取不服务端化 —— www 买家反爬太凶,留买家 tab 老路。)
  // 缓存按 token 分域:同一 SW 实例内切换账号(登出→登入)时 token 变 → 缓存失效重取,
  // 避免上个用户的灰度命中污染下个用户(codex review #5)。
  // fresh=true 表示值来自成功响应(5min 有效);fresh=false 是失败兜底(30s 后就重试)。
  // 2026-07 事故教训:此前 catch 里强制 val=false 负缓存 5 分钟 —— /feature-flags/me
  // 一次超时/抖动就让整个扩展 5 分钟内所有数据卡绕开 fleet 端点(后端 Redis 里躺着的
  // market 缓存满血也摸不到),整页退回「代采→本地 seller tab」老路弹「请登录」。
  // 现在失败走 stale-while-error:沿用同 token 上次已知值,false 只能来自成功响应。
  let _fleetFlag = { token: null, val: false, at: 0, fresh: false };
  // single-flight:搜索页几十张卡并发首查时只发一条 /feature-flags/me(SW 冷启并发
  // 打几十条本身就容易撞限流/超时,正是把 flag 打失败的元凶之一)。
  let _fleetFlagInflight = null; // { token, p }
  const isFleetServerSide = async (backendUrl, token) => {
    if (!token || !backendUrl) return false;
    const ttl = _fleetFlag.fresh ? 300_000 : 30_000;
    if (_fleetFlag.token === token && Date.now() - _fleetFlag.at < ttl) return _fleetFlag.val;
    if (_fleetFlagInflight && _fleetFlagInflight.token === token) return _fleetFlagInflight.p;
    const p = (async () => {
      try {
        const flags = await apiRequest('GET', `${backendUrl}/feature-flags/me`, null, token, null, 8000);
        _fleetFlag = { token, val: !!flags?.ozon_fleet_serverside, at: Date.now(), fresh: true };
      } catch {
        // 失败不改判:同 token 沿用旧值;换了 token(登出登入)没有旧值可信,保守 false。
        const staleVal = _fleetFlag.token === token ? _fleetFlag.val : false;
        _fleetFlag = { token, val: staleVal, at: Date.now(), fresh: false };
      } finally {
        _fleetFlagInflight = null;
      }
      return _fleetFlag.val;
    })();
    _fleetFlagInflight = { token, p };
    return p;
  };
  // ── fleet 并发闸:同一时刻最多 N 条 /ozon/fleet/* 在飞,其余 FIFO 排队 ──────
  // 搜索页几十张卡并发开火时,不加闸会把突发原样打到后端→VPS(2026-07-03 实测
  // 7-8 req/s 峰值直接触发 Ozon 反爬,整机群账号连锁冷却 10 分钟)。
  // 选 max-inflight 而非 _sellerPortalGate 那种间隔闸:fleet 调用大半命中后端
  // Redis 缓存(~80ms),间隔闸会白白拖慢快路径;in-flight 闸在全命中时几乎无感
  // (6 并发×80ms≈0.5s 清完 40 卡),miss 变多时吞吐自然回落,恰好是想要的行为。
  // N=6 ≈ 机群 warm 账号并发(5 账号,留 1 余量);排队超 10s 直接返 false 让调用方
  // 回落老路,不无限堆积(MV3 SW 空闲重启会清状态,无泄漏风险)。
  const FLEET_MAX_INFLIGHT = 6;
  const FLEET_ACQUIRE_TIMEOUT_MS = 10_000;
  let _fleetInflight = 0;
  const _fleetWaiters = [];
  const _fleetAcquire = () => {
    if (_fleetInflight < FLEET_MAX_INFLIGHT) {
      _fleetInflight++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const w = { resolve, done: false };
      _fleetWaiters.push(w);
      setTimeout(() => {
        if (!w.done) {
          w.done = true;
          resolve(false); // 排队超时:调用方拿 false → 走老路,名额计数不动(从未占过)
        }
      }, FLEET_ACQUIRE_TIMEOUT_MS);
    });
  };
  const _fleetRelease = () => {
    // 名额直接转交队首未超时者(inflight 计数不变);全超时/空队列才真正释放。
    let next;
    while ((next = _fleetWaiters.shift())) {
      if (!next.done) {
        next.done = true;
        next.resolve(true);
        return;
      }
    }
    _fleetInflight--;
  };
  // 调后端 fleet 代理端点;成功返回 data,403(未命中灰度)/池忙/失败返回 null(回落老路)。
  const callFleet = async (backendUrl, token, storeId, path, body) => {
    if (!(await _fleetAcquire())) return null;
    try {
      const r = await apiRequest('POST', `${backendUrl}/ozon/fleet/${path}`, body, token, storeId, 25_000);
      return r?.ok ? r.data : null;
    } catch {
      return null;
    } finally {
      _fleetRelease();
    }
  };

  // ── fleet 本地缓存(chrome.storage.local)────────────────────────
  // 后端 /ozon/fleet/* 已有平台级 Redis 缓存,这层是设备侧再加一跳:命中零网络,
  // 顺带削掉同 SKU 反复打后端的请求量。TTL 取短于后端(collect 24h≤30d、market
  // 30min≤7d),不会引入比后端更陈的数据。
  // 红线(PR#332 负缓存事故教训):失败/null 一律不写;collect 残包(有 sourceVariant
  // 没 bundleItem,后端只给 600s 短缓存等 fleet 恢复补全)也不写 —— 本地写了就把
  // 缺重量/尺寸的结果钉死 24h,毁掉补全链路。
  const _FLEET_COLLECT_CACHE_PREFIX = 'jz-sw-fleetcollect-v1:';
  const _FLEET_COLLECT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  // collect 条目大(sourceVariant 带 40-63 个属性,单条可达几十 KB),即便有
  // unlimitedStorage 也做条数上限,防长期膨胀拖慢 storage.get(null) 全扫
  const _FLEET_COLLECT_CACHE_MAX = 150;
  const _FLEET_MARKET_CACHE_PREFIX = 'jz-sw-fleetmarket-v1:';
  const _FLEET_MARKET_CACHE_TTL_MS = 30 * 60 * 1000;
  const _fleetMarketCacheKey = (sku, period) => `${_FLEET_MARKET_CACHE_PREFIX}${sku}:${period}`;
  const _fleetCacheGet = async (key, ttlMs) => {
    try {
      const entry = await new Promise((r) => chrome.storage.local.get([key], (d) => r(d?.[key] || null)));
      if (entry && typeof entry.at === 'number' && Date.now() - entry.at < ttlMs && entry.data != null) {
        return entry.data;
      }
    } catch {}
    return null;
  };
  const _fleetCacheSet = (key, data) => {
    try { chrome.storage.local.set({ [key]: { at: Date.now(), data } }); } catch {}
  };
  // 启动清扫:两类前缀的过期项 + collect 条数上限(超出删最旧)。同采集去重清扫的
  // 节流模式 —— MV3 SW 高频唤醒,12h 内不重复全扫。
  const _FLEET_CACHE_CLEANUP_KEY = 'jz-sw-fleetcache-cleaned-at';
  const _FLEET_CACHE_CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
  (async () => {
    try {
      const stamp = await new Promise((r) => chrome.storage.local.get([_FLEET_CACHE_CLEANUP_KEY], (d) => r(d?.[_FLEET_CACHE_CLEANUP_KEY])));
      const now = Date.now();
      // 防御未来时间(时钟回滚/数据损坏):只信任 <= now 的 stamp
      const stampAt = (stamp && typeof stamp.at === 'number' && stamp.at <= now) ? stamp.at : 0;
      if (stampAt > 0 && now - stampAt < _FLEET_CACHE_CLEANUP_INTERVAL_MS) return;
      const all = await new Promise((r) => chrome.storage.local.get(null, r));
      const toRemove = [];
      const collectAlive = [];
      for (const [k, v] of Object.entries(all || {})) {
        const at = (v && typeof v.at === 'number') ? v.at : 0;
        if (k.startsWith(_FLEET_COLLECT_CACHE_PREFIX)) {
          if (now - at >= _FLEET_COLLECT_CACHE_TTL_MS) toRemove.push(k);
          else collectAlive.push({ k, at });
        } else if (k.startsWith(_FLEET_MARKET_CACHE_PREFIX)) {
          if (now - at >= _FLEET_MARKET_CACHE_TTL_MS) toRemove.push(k);
        }
      }
      if (collectAlive.length > _FLEET_COLLECT_CACHE_MAX) {
        collectAlive.sort((a, b) => a.at - b.at);
        for (const e of collectAlive.slice(0, collectAlive.length - _FLEET_COLLECT_CACHE_MAX)) toRemove.push(e.k);
      }
      if (toRemove.length) {
        await new Promise((r) => chrome.storage.local.remove(toRemove, r));
        console.log(`[SW] cleared ${toRemove.length} fleet local cache entries (expired/over-cap)`);
      }
      await new Promise((r) => chrome.storage.local.set({ [_FLEET_CACHE_CLEANUP_KEY]: { at: now } }, r));
    } catch {}
  })();
  // market 合批端点降级标记:旧后端(404)/未进灰度(403)/网络失败时 10min 内不再
  // 撞 batch,直接走单条补拉(内存态,SW 重启自然清零)。
  let _fleetMarketBatchDownUntil = 0;

  // ── market 微批探针:搜索/类目/首页数据卡逐卡发单条 getMarketStats,SW 收
  // 120ms 窗口合并成一条 /ozon/fleet/market/batch。后端该端点 hits 即回(只答
  // 榜单快照/Redis 命中,miss 不打 VPS),轻请求、不占 fleet 6 并发闸 —— 91% 命中
  // 率下一页 40 卡从 40 次单条排队变 1 次合批 + 少数 miss 单条补拉。
  // 探针 miss(返 null)由调用方继续原单条 callFleet 路径(那条才真正打 VPS)。
  // payload 字段顺序必须与单条路径逐字节一致(后端按 JSON.stringify sha1 对缓存键)。
  const _MARKET_PROBE_WINDOW_MS = 120;
  const _MARKET_PROBE_MAX = 50; // 后端 market/batch 上限 50/批
  let _marketProbeQueue = []; // { sku, period, backendUrl, token, storeId, resolve }
  let _marketProbeTimer = null;
  const _flushMarketProbe = async () => {
    const batch = _marketProbeQueue.splice(0, _marketProbeQueue.length);
    if (_marketProbeTimer) { clearTimeout(_marketProbeTimer); _marketProbeTimer = null; }
    if (!batch.length) return;
    // 同窗口内 auth 上下文一致(同一浏览器 profile),取首条的即可
    const { backendUrl, token, storeId } = batch[0];
    try {
      const items = batch.map((b) => ({ payload: { filter: { stock: 'any_stock', period: b.period, sku: String(b.sku) }, sort: { key: 'sum_gmv_desc' }, limit: '1', offset: '0' } }));
      const resp = await apiRequest('POST', `${backendUrl}/ozon/fleet/market/batch`, { items }, token, storeId, 25_000);
      const rows = resp?.ok && Array.isArray(resp.results) ? resp.results : [];
      batch.forEach((b, idx) => {
        const row = rows[idx];
        b.resolve(row && row.hit ? (row.data?.items?.[0] || row.data?.data?.[0] || null) : null);
      });
    } catch {
      // 与 getMarketStatsBatch 共用熔断:10min 内探针直接 miss,全走单条
      _fleetMarketBatchDownUntil = Date.now() + 10 * 60 * 1000;
      batch.forEach((b) => b.resolve(null));
    }
  };
  const _marketBatchProbe = (backendUrl, token, storeId, sku, period) => {
    if (Date.now() < _fleetMarketBatchDownUntil) return Promise.resolve(null);
    return new Promise((resolve) => {
      _marketProbeQueue.push({ sku, period, backendUrl, token, storeId, resolve });
      if (_marketProbeQueue.length >= _MARKET_PROBE_MAX) {
        _flushMarketProbe();
      } else if (!_marketProbeTimer) {
        _marketProbeTimer = setTimeout(_flushMarketProbe, _MARKET_PROBE_WINDOW_MS);
      }
    });
  };

  // ── maozi 公开商详上架灰度开关(读 /feature-flags/me,5min 缓存,同 token)──
  let _publicImportFlag = { token: null, val: false, at: 0 };
  const isPublicImportEnabled = async (backendUrl, token) => {
    if (!token || !backendUrl) return false;
    if (_publicImportFlag.token === token && Date.now() - _publicImportFlag.at < 300_000) return _publicImportFlag.val;
    try {
      const flags = await apiRequest('GET', `${backendUrl}/feature-flags/me`, null, token, null, 8000);
      _publicImportFlag = { token, val: !!flags?.ozon_public_import, at: Date.now() };
    } catch {
      _publicImportFlag = { token, val: false, at: Date.now() };
    }
    return _publicImportFlag.val;
  };

  // maozi 公开商详上架:把公开买家商详页 page-json(widgetStates)解析成后端
  // /ozon/products/import-from-public 的精简行(媒体+文本+价格+俄文 characteristics
  // +类目面包屑)。后端据此服务端解析类目/属性 → 官方 import,门户无关。
  const buildPublicListingRow = (data, productPath) => {
    const ws = data?.widgetStates || {};
    const keys = Object.keys(ws);
    const find = (p) => keys.find((k) => k.startsWith(p));
    const parse = (k) => {
      if (!k) return null;
      const raw = ws[k];
      if (typeof raw === 'object' && raw !== null) return raw;
      try { return JSON.parse(raw); } catch { return null; }
    };
    const gallery = parse(find('webGallery'));
    const heading = parse(find('webProductHeading'));
    const price = parse(find('webPrice'));
    const shortChars = parse(find('webShortCharacteristics'));
    const descW = parse(find('webDescription'));
    const crumbsW = parse(find('breadCrumbs'));

    const sku = String(gallery?.sku || (productPath.match(/-(\d+)\/?$/)?.[1]) || '');
    const images = Array.isArray(gallery?.images)
      ? gallery.images.map((it) => (typeof it === 'string' ? it : it?.url || it?.link || it?.src)).filter(Boolean)
      : [];
    const cover = typeof gallery?.coverImage === 'string'
      ? gallery.coverImage
      : gallery?.coverImage?.url || gallery?.coverImage?.link || images[0] || '';

    // webShortCharacteristics.characteristics[] → [{nameRu, valueRu}]
    // 形状(见 docs/maozi-import.md):{ title:{textRs:[{content}]}, values:[{text}] }
    const chars = [];
    const rawChars = Array.isArray(shortChars?.characteristics) ? shortChars.characteristics : [];
    for (const c of rawChars) {
      const nameRu = Array.isArray(c?.title?.textRs)
        ? c.title.textRs.map((t) => t?.content || t?.text || '').join('').trim()
        : String(c?.title?.text || '').trim();
      const valueRu = Array.isArray(c?.values)
        ? c.values.map((v) => v?.text || v?.content || '').filter(Boolean).join(', ').trim()
        : '';
      if (nameRu && valueRu) chars.push({ nameRu, valueRu });
    }

    // breadcrumb:只保留单段 /category/slug-digits/ 的类目面包屑,丢掉末尾的
    // 品牌过滤 crumb(link 有两段,如 /category/dozimetry-33842/aeg-test-.../)。
    const allCrumbs = Array.isArray(crumbsW?.breadcrumbs) ? crumbsW.breadcrumbs : [];
    const breadcrumb = allCrumbs
      .filter((c) => /^\/category\/[^/]+\/?$/.test(String(c?.link || '')))
      .map((c) => String(c?.text || '').trim())
      .filter(Boolean);

    // 价格:webPrice 是买家展示串(如 "545,54 ¥" / "1 305,12 ₽")。maozi 定价 =
    // 抽展示价原值当 sell_price,后端 deriveMaoziPricing 派生 price(ceil)/old_price(×2)。
    // 币种按符号识别(¥→CNY / ₽→RUB / $→USD),后端据此写 currency_code。
    const toNum = (s) => {
      if (s == null) return undefined;
      // 千分位空格先删,逗号→小数点,再抽数字
      const m = String(s).replace(/\s/g, '').replace(',', '.').match(/[\d.]+/);
      return m ? Number(m[0]) : undefined;
    };
    const detectCurrency = (s) => {
      const str = String(s || '');
      if (str.includes('¥') || /CNY|RMB/i.test(str)) return 'CNY';
      if (str.includes('₽') || /RUB/i.test(str)) return 'RUB';
      if (str.includes('$') || /USD/i.test(str)) return 'USD';
      return undefined;
    };
    const priceStr = price?.price ?? price?.cardPrice;

    // 描述:webDescription 结构多变,尽力取纯文本
    let description = '';
    try {
      description = descW?.richAnnotationJson
        ? ''
        : String(descW?.characteristics?.[0]?.text || descW?.text || '').trim();
    } catch {}

    return {
      sku,
      offer_id: '',
      title: heading?.title || '',
      cover_image: cover,
      images,
      description,
      sell_price: toNum(priceStr),
      currency_code: detectCurrency(priceStr),
      breadcrumb,
      source_characteristics: chars,
    };
  };

  // ── product-data 合批器 ──────────────────────────────────────
  // 搜索页每张商品卡发一条 getProductStats,旧实现逐卡 GET /ozon/product-data/:sku
  // (生产实测 ~11.5 req/s,后端最高频接口之一)。这里在 SW 层把短窗口内到达的 SKU
  // 合成一次 POST /ozon/product-data/batch,content script 完全无感知。
  // 到达模式 = 首屏 6 连发(content taskQueue 并发数)+ 队列 trickle,故用
  // debounce(每次到达顺延 100ms)+ 硬上限(首个入队后最多等 300ms)+ 凑满 50 立发。
  // 数据卡片渲染本就等 variantsQueue(300ms+),这点合批延迟完全被遮住。
  const productStatsBatch = {
    pending: new Map(), // sku -> resolve[]
    ctx: null, // { backendUrl, token, storeId, period }
    debounceTimer: null,
    maxWaitTimer: null,
  };

  const flushProductStatsBatch = async () => {
    const { pending, ctx } = productStatsBatch;
    clearTimeout(productStatsBatch.debounceTimer);
    clearTimeout(productStatsBatch.maxWaitTimer);
    productStatsBatch.pending = new Map();
    productStatsBatch.ctx = null;
    productStatsBatch.debounceTimer = null;
    productStatsBatch.maxWaitTimer = null;
    if (!pending.size || !ctx) return;

    const skus = [...pending.keys()];
    const dataBySku = {};
    try {
      const res = await apiRequest(
        'POST',
        `${ctx.backendUrl}/ozon/product-data/batch`,
        // period:数据卡月/周开关。旧后端 DTO 无此字段时多余键会被 ValidationPipe
        // whitelist 剥掉或忽略,不影响老服务。
        { skus, ...(ctx.period ? { period: ctx.period } : {}) },
        ctx.token,
        ctx.storeId,
      );
      Object.assign(dataBySku, res?.data || {});
    } catch (e) {
      if (e?.code === 'FEATURE_GATED') {
        // 数据卡会员门控:免费档整批 403,逐 SKU 重试也只会是同样的 403,直接
        // 用 __featureGated 标记整批返回,content script 渲染锁定卡。
        for (const [, resolvers] of pending) {
          for (const resolve of resolvers) resolve({ ok: true, data: { __featureGated: true } });
        }
        return;
      }
      // batch 端点不可用(后端未升级 / 瞬时故障)→ 退回逐 SKU GET,行为同旧版
      await Promise.all(
        skus.map(async (sku) => {
          try {
            const r = await apiRequest(
              'GET',
              `${ctx.backendUrl}/ozon/product-data/${sku}?skipMarket=1${ctx.period ? `&period=${ctx.period}` : ''}`,
              null,
              ctx.token,
              ctx.storeId,
            );
            dataBySku[sku] = r?.data || null;
          } catch (e2) {
            dataBySku[sku] = e2?.code === 'FEATURE_GATED' ? { __featureGated: true } : null;
          }
        }),
      );
    }
    for (const [sku, resolvers] of pending) {
      for (const resolve of resolvers) resolve({ ok: true, data: dataBySku[sku] ?? null });
    }
  };

  const queueProductStats = (sku, ctx) =>
    new Promise((resolve) => {
      const cur = productStatsBatch.ctx;
      // 换号/换店/换后端/换周期时先冲掉旧批,严禁跨上下文混批
      if (
        cur &&
        (cur.token !== ctx.token || cur.storeId !== ctx.storeId || cur.backendUrl !== ctx.backendUrl ||
          cur.period !== ctx.period)
      ) {
        flushProductStatsBatch();
      }
      productStatsBatch.ctx = ctx;
      const arr = productStatsBatch.pending.get(sku) || [];
      arr.push(resolve);
      productStatsBatch.pending.set(sku, arr);

      if (productStatsBatch.pending.size >= 50) {
        flushProductStatsBatch();
        return;
      }
      clearTimeout(productStatsBatch.debounceTimer);
      productStatsBatch.debounceTimer = setTimeout(flushProductStatsBatch, 100);
      if (!productStatsBatch.maxWaitTimer) {
        productStatsBatch.maxWaitTimer = setTimeout(flushProductStatsBatch, 300);
      }
    });

  // ── SKU 重量/尺寸回写攒批 ──────────────────────────────────────────
  // 数据卡抓到重量/尺寸(sv 4497/9454-9456 或公共 PDP)后逐条 queue,2s 攒批一次性 POST
  // /ozon/product-data/dims。fire-and-forget:后端灰度 ozon_sku_dims_cache 门控,未开则静默丢弃。
  const dimsReportBatch = { items: new Map(), ctx: null, timer: null };
  const flushDimsReport = async () => {
    const { items, ctx } = dimsReportBatch;
    clearTimeout(dimsReportBatch.timer);
    dimsReportBatch.items = new Map();
    dimsReportBatch.ctx = null;
    dimsReportBatch.timer = null;
    if (!items.size || !ctx || !ctx.token) return;
    try {
      await apiRequest('POST', `${ctx.backendUrl}/ozon/product-data/dims`,
        { items: [...items.values()] }, ctx.token, ctx.storeId, 15_000);
    } catch { /* best-effort,不重试 */ }
  };
  const queueDimsReport = (item, ctx) => {
    if (!item || !item.sku) return;
    const cur = dimsReportBatch.ctx;
    if (cur && (cur.token !== ctx.token || cur.backendUrl !== ctx.backendUrl)) flushDimsReport();
    dimsReportBatch.ctx = ctx;
    dimsReportBatch.items.set(String(item.sku), item); // 同 sku 去重,后到覆盖
    if (dimsReportBatch.items.size >= 50) { flushDimsReport(); return; }
    clearTimeout(dimsReportBatch.timer);
    dimsReportBatch.timer = setTimeout(flushDimsReport, 2000);
  };

  const createContextMenus = () => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'ozon-image-search-1688',
        title: '搜索1688货源',
        contexts: ['image'],
      });
    });
  };

  // ── 插件更新检查 ──
  const getCurrentVersion = () => chrome.runtime.getManifest().version;

  const compareVersions = (v1, v2) => {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const a = parts1[i] || 0;
      const b = parts2[i] || 0;
      if (a > b) return 1;
      if (a < b) return -1;
    }
    return 0;
  };

  /**
   * Compute hex SHA-256 of an ArrayBuffer using SubtleCrypto.
   */
  const sha256Hex = async (buffer) => {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };

  /**
   * Re-download the zip from `downloadUrl` and verify its SHA-256 matches
   * `expectedHex`. Returns true on match, false otherwise (including network
   * failures — fail closed for security).
   */
  const verifyExtensionHash = async (downloadUrl, expectedHex) => {
    if (!expectedHex || !/^[0-9a-f]{64}$/i.test(expectedHex)) return false;
    try {
      const resp = await fetch(downloadUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(60_000),
        cache: 'no-cache',
      });
      if (!resp.ok) {
        console.warn(`[checkForUpdate] zip fetch failed: ${resp.status}`);
        return false;
      }
      const buf = await resp.arrayBuffer();
      const computed = await sha256Hex(buf);
      const match = computed.toLowerCase() === expectedHex.toLowerCase();
      if (!match) {
        console.error(
          `[checkForUpdate] SHA-256 mismatch: expected=${expectedHex} computed=${computed}`
        );
      }
      return match;
    } catch (e) {
      console.warn(`[checkForUpdate] hash verify failed: ${e?.message || e}`);
      return false;
    }
  };

  const checkForUpdate = async () => {
    try {
      const backendUrl = await getBackendUrl();
      // 分销商 brand build 时,build.js 把 brand.code 注入到 globalThis.__JZ_BRAND__。
      // 必须带 brand 参数,后端按 brand 路由到对应分销商 zip 的 version/url/sha256 —
      // 不带的话 backend 默认返回主插件元数据,分销商插件会被引导去下主插件 zip。
      const brandCode =
        (typeof globalThis !== 'undefined' &&
          globalThis.__JZ_BRAND__ &&
          typeof globalThis.__JZ_BRAND__.code === 'string' &&
          globalThis.__JZ_BRAND__.code) ||
        '';
      const brandQuery =
        brandCode && brandCode !== 'platform'
          ? `&brand=${encodeURIComponent(brandCode)}`
          : '';
      const updateUrl = `${backendUrl}/extension/latest?client=extension${brandQuery}`;
      const resp = await fetch(updateUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
        cache: 'no-cache',
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.version) return;

      const currentVersion = getCurrentVersion();
      if (compareVersions(data.version, currentVersion) <= 0) {
        // 已是最新版本，清除更新提示
        await removeStorage([
          STORAGE_KEYS.latestVersion,
          STORAGE_KEYS.latestDownloadUrl,
          STORAGE_KEYS.latestSha256,
          STORAGE_KEYS.updateDismissedVersion,
        ]);
        chrome.action.setBadgeText({ text: '' });
        return;
      }

      // 有新版本：先验证 SHA-256 再展示更新角标。后端 v0.9.40+ 返回 sha256；
      // 旧后端无该字段时降级为告警（保留兼容路径，但 console 留痕）。
      const downloadUrl = data.downloadUrl || data.url || '';
      const expectedHash = typeof data.sha256 === 'string' ? data.sha256.trim() : '';
      let verified = false;

      if (!downloadUrl) {
        console.warn('[checkForUpdate] missing downloadUrl, skipping');
        return;
      }

      if (expectedHash) {
        // 同版本号已通过校验则跳过重复下载
        const cached = await getStorage([STORAGE_KEYS.latestVersion, STORAGE_KEYS.latestSha256]);
        if (
          cached[STORAGE_KEYS.latestVersion] === data.version &&
          cached[STORAGE_KEYS.latestSha256] === expectedHash
        ) {
          verified = true;
        } else {
          verified = await verifyExtensionHash(downloadUrl, expectedHash);
        }
      } else if (brandCode && brandCode !== 'platform') {
        // 分销商 brand 必须有 sha256。空表示该 brand 还未跑过新版 build —
        // 此时 downloadUrl 可能指向某次"旧 build 的 zip",但我们没法在客户端验证
        // 完整性。直接拒装,留个角标提示运营 rebuild。
        console.warn(
          `[checkForUpdate] brand=${brandCode} backend returned no sha256 — refusing install (run /admin/distributor/extension/build to refresh)`
        );
        verified = false;
      } else {
        // 平台主插件:历史上 EXTENSION_DOWNLOAD_SHA256 不一定配置,沿用 legacy
        // 兼容路径(只警告不拒装)。仅适用 brand==='' 或 'platform' 分支。
        console.warn(
          '[checkForUpdate] backend returned no sha256 — running in legacy compatibility mode (no integrity check)'
        );
        verified = true;
      }

      if (!verified) {
        // 校验失败：不写入版本/下载链接，提示用户当前更新不可信
        await removeStorage([STORAGE_KEYS.latestVersion, STORAGE_KEYS.latestDownloadUrl, STORAGE_KEYS.latestSha256]);
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
        try {
          chrome.notifications.create('extension-update-untrusted', {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: '插件更新校验失败',
            message: '官方下载文件 SHA-256 不匹配，已阻止本次更新提示。请检查后端配置或联系管理员。',
            priority: 2,
          });
        } catch {}
        return;
      }

      await setStorage({
        [STORAGE_KEYS.latestVersion]: data.version,
        [STORAGE_KEYS.latestDownloadUrl]: downloadUrl,
        [STORAGE_KEYS.latestSha256]: expectedHash,
      });
      chrome.action.setBadgeText({ text: 'NEW' });
      chrome.action.setBadgeBackgroundColor({ color: '#ff4d4f' });
    } catch {
      // 网络失败时静默忽略
    }
  };

  // 注册定时检查 alarm
  const setupUpdateAlarm = () => {
    chrome.alarms.create(UPDATE_CHECK_ALARM, {
      delayInMinutes: 1, // 启动后 1 分钟首次检查
      periodInMinutes: UPDATE_CHECK_INTERVAL_MINUTES,
    });
  };

  // ── 跟卖任务失败检查 ──
  const checkFollowSellTasks = async () => {
    try {
      const data = await getStorage([STORAGE_KEYS.token, STORAGE_KEYS.storeId, STORAGE_KEYS.followSellNotifiedIds]);
      const token = data[STORAGE_KEYS.token];
      const storeId = data[STORAGE_KEYS.storeId];
      if (!token || !storeId) return; // 未登录或未选店铺，跳过

      const backendUrl = await getBackendUrl();
      const resp = await apiRequest(
        'GET',
        `${backendUrl}/ozon/products/import-by-sku/tasks?current=1&pageSize=20`,
        null,
        token,
        storeId,
        15_000,
      );
      const items = resp?.items || [];
      if (!Array.isArray(items) || items.length === 0) return;

      const notified = new Set(Array.isArray(data[STORAGE_KEYS.followSellNotifiedIds]) ? data[STORAGE_KEYS.followSellNotifiedIds] : []);
      const cutoff = Date.now() - FOLLOW_SELL_RECENT_WINDOW_MS;
      const newlyFailed = items.filter(t => {
        if (t.status !== 'FAILED') return false;
        if (!t.localTaskId) return false;
        if (notified.has(t.localTaskId)) return false;
        const createdAtMs = t.createdAt ? new Date(t.createdAt).getTime() : 0;
        return createdAtMs >= cutoff;
      });

      for (const task of newlyFailed) {
        const firstItem = Array.isArray(task.itemsPreview) && task.itemsPreview.length > 0 ? task.itemsPreview[0] : null;
        const itemCount = Array.isArray(task.itemsPreview) ? task.itemsPreview.length : 0;
        const title = itemCount > 1
          ? `跟卖失败 (${itemCount} 个商品)`
          : `跟卖失败${firstItem?.name ? `：${String(firstItem.name).slice(0, 30)}` : ''}`;
        const message = task.errorMessage
          ? String(task.errorMessage).slice(0, 180)
          : '跟卖任务后台执行失败，请在插件弹窗「上架记录」中查看。';
        try {
          chrome.notifications.create(`follow-sell-fail-${task.localTaskId}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title,
            message,
            priority: 1,
          });
        } catch (e) {
          // notification 权限缺失时静默
        }
        notified.add(task.localTaskId);
      }

      if (newlyFailed.length > 0) {
        // 保留最近 200 条，防止存储无限增长
        const pruned = Array.from(notified).slice(-200);
        await setStorage({ [STORAGE_KEYS.followSellNotifiedIds]: pruned });
      }
    } catch (e) {
      console.log('[followSell-check] failed:', e?.message || e);
    }
  };

  const setupFollowSellCheckAlarm = () => {
    chrome.alarms.create(FOLLOW_SELL_CHECK_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: FOLLOW_SELL_CHECK_INTERVAL_MINUTES,
    });
  };

  const setupHeartbeatAlarm = () => {
    chrome.alarms.create(HEARTBEAT_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: HEARTBEAT_INTERVAL_MINUTES,
    });
  };

  // ── 极掌算价：拉取 CNY→RUB 实时汇率 ──
  const refreshExchangeRate = async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      const r = await fetch(FX_API_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const rate = Number(data?.rates?.RUB);
      if (!isFinite(rate) || rate <= 0) throw new Error('invalid rate');
      await setStorage({
        [FX_STORAGE_KEY]: { rate, ts: Date.now(), source: 'open.er-api.com' },
      });
      return rate;
    } catch (e) {
      console.warn('[jzc-fx] refresh failed:', e?.message || e);
      return null;
    }
  };

  const setupFxAlarm = () => {
    chrome.alarms.create(FX_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: FX_REFRESH_INTERVAL_MINUTES,
    });
  };

  // ── client-side sync 接入 ──
  // 在 IIFE 内拼装 closures 注入到 globalThis.JzBackendClient(它在 importScripts 期间
  // 创建了 setContext stub,等我们调用才有效),保证 backend-client 能复用
  // SW 现有的 getBackendUrl + token storage 路径。
  const initClientSyncContext = () => {
    if (!globalThis.JzBackendClient) return; // importScripts 失败时不可用
    globalThis.JzBackendClient.setContext({
      getBackendUrl: async () => {
        return await getBackendUrl();
      },
      getAuthToken: async () => {
        const s = await getStorage([STORAGE_KEYS.token]);
        return s[STORAGE_KEYS.token] || null;
      },
    });
  };

  const initBrowserAgentContext = () => {
    if (!globalThis.JzBrowserAgentRuntime) return;
    globalThis.JzBrowserAgentRuntime.setContext({
      getDeviceKey: async () => getExtensionFingerprint(),
      getDeviceName: async () => {
        const manifest = chrome.runtime.getManifest() || {};
        return `${manifest.name || '极掌'} / Chrome`;
      },
    });
  };

  const setupBrowserAgentAlarm = () => {
    chrome.alarms.create(BROWSER_AGENT_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: BROWSER_AGENT_INTERVAL_MINUTES,
    });
  };

  // Phase 3 补:启动时尝试从 backend 拉 /ozon/sync/client-intervals,失败用 default。
  // 24h 缓存(JzSyncState),允许后端集中调整 tenant 同步频率而不需要扩展更新。
  const setupClientSyncAlarms = async () => {
    if (!globalThis.JzSyncEngine) return;
    let intervals = { ...CLIENT_SYNC_INTERVALS };
    try {
      const cached = await globalThis.JzSyncState?.getIntervals?.();
      if (cached) {
        intervals = {
          POSTINGS: cached.postingsMin || intervals.POSTINGS,
          PRODUCTS: cached.productsMin || intervals.PRODUCTS,
          WAREHOUSES: cached.warehousesMin || intervals.WAREHOUSES,
        };
      } else {
        // cache miss / TTL 过期 — fetch + 存
        const fresh = await globalThis.JzBackendClient?.getClientIntervals();
        if (fresh) {
          intervals = {
            POSTINGS: fresh.postingsMin || intervals.POSTINGS,
            PRODUCTS: fresh.productsMin || intervals.PRODUCTS,
            WAREHOUSES: fresh.warehousesMin || intervals.WAREHOUSES,
          };
          await globalThis.JzSyncState?.setIntervals?.(fresh);
        }
      }
    } catch (e) {
      // 未登录 / 后端不通 — 静默用 default(灰度期间 OPI 一旦不可用,扩展端也跑不动)
      console.log(
        '[client-sync] interval fetch failed, using defaults:',
        e?.message || e,
      );
    }
    for (const type of CLIENT_SYNC_TYPES) {
      chrome.alarms.create(`${CLIENT_SYNC_ALARM_PREFIX}${type}`, {
        delayInMinutes: 1,
        periodInMinutes: intervals[type],
      });
    }
  };

  // 手动 sync 并发限流(Codex P1 #2):"全部同步" UI 在 ~100ms 内可连发
  // N×3 条 jzManualSync 消息,直接 fire-and-forget 会瞬间起 15+ 并发 Ozon
  // request,极易撞 antibot / 429。这里限制同时最多 3 个 runOneType,多余排队。
  // 队列长度无上限 — UI 那侧只发 active stores × 3 条,有界。
  const MANUAL_SYNC_MAX_CONCURRENT = 3;
  let manualSyncRunning = 0;
  const manualSyncQueue = [];
  const runManualSyncBounded = async (task) => {
    if (manualSyncRunning >= MANUAL_SYNC_MAX_CONCURRENT) {
      await new Promise((resolve) => manualSyncQueue.push(resolve));
    }
    manualSyncRunning++;
    try {
      await task();
    } finally {
      manualSyncRunning--;
      const next = manualSyncQueue.shift();
      if (next) next();
    }
  };

  // 在飞守卫:同类型一次只能有一个 runRound 在跑。Codex P1 #1。
  //
  // 背景:周期性 alarm 触发 runRound,长跨度同步(POSTINGS 多店 + Ozon 慢)经常
  // 单轮超过 alarm interval (POSTINGS 默认 3min),下一轮 alarm 又 fire,且
  // backend sync-lease 允许同 holderDeviceId 重新 acquire(它把同 holder 重 acquire
  // 当成 heartbeat 续约),结果同店同类型并发跑 → Ozon API 重复 call + 双写 cache。
  //
  // 这里用 SW 进程级 Set 作为最便宜的守卫(每 SW 实例独立,无跨进程同步)。
  // 多店 sync 在 runRound 内部循环,守卫粒度是"type",对齐 alarm/lease 粒度。
  const runningTypes = new Set();

  const handleClientSyncAlarm = async (alarmName) => {
    if (!globalThis.JzSyncEngine) return;
    const type = alarmName.slice(CLIENT_SYNC_ALARM_PREFIX.length);
    if (!CLIENT_SYNC_TYPES.includes(type)) return;
    // 没登录就跳过(JzBackendClient.getAuthToken 会抛"No backend auth token")
    const s = await getStorage([STORAGE_KEYS.token]);
    if (!s[STORAGE_KEYS.token]) return;
    if (runningTypes.has(type)) {
      console.log(`[client-sync] skip ${type}: previous round still running`);
      return;
    }
    runningTypes.add(type);
    try {
      await globalThis.JzSyncEngine.runRound(type);
    } catch (e) {
      console.warn(`[client-sync] runRound(${type}) crashed:`, e?.message || e);
    } finally {
      runningTypes.delete(type);
    }
  };

  const handleBrowserAgentAlarm = async () => {
    if (!globalThis.JzBrowserAgentRuntime) return;
    const s = await getStorage([STORAGE_KEYS.token]);
    if (!s[STORAGE_KEYS.token]) return;
    await globalThis.JzBrowserAgentRuntime.tick();
  };

  const sendHeartbeat = async () => {
    try {
      const stored = await getStorage([STORAGE_KEYS.token]);
      const token = stored[STORAGE_KEYS.token];
      if (!token) return;
      const backendUrl = await getBackendUrl();
      const fp = await getExtensionFingerprint();
      await apiRequest('PUT', `${backendUrl}/auth/device/heartbeat`, { deviceFingerprint: fp, platform: 'extension' }, token, null);
    } catch (e) {
      // 心跳失败不上报
    }
  };

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_CHECK_ALARM) {
      checkForUpdate();
    } else if (alarm.name === FOLLOW_SELL_CHECK_ALARM) {
      checkFollowSellTasks();
    } else if (alarm.name === HEARTBEAT_ALARM) {
      sendHeartbeat();
    } else if (alarm.name === FX_ALARM) {
      refreshExchangeRate();
    } else if (alarm.name.startsWith(CLIENT_SYNC_ALARM_PREFIX)) {
      handleClientSyncAlarm(alarm.name);
    } else if (alarm.name === BROWSER_AGENT_ALARM) {
      handleBrowserAgentAlarm();
    }
  });

  chrome.notifications.onClicked.addListener((notificationId) => {
    if (notificationId.startsWith('follow-sell-fail-')) {
      chrome.action.openPopup().catch(() => {});
      chrome.notifications.clear(notificationId);
    }
  });

  /**
   * Reload all seller.ozon.ru tabs so manifest-declared content_scripts get injected.
   * Needed when the extension loads after the tab is already open (e.g. install/update/startup).
   */
  const reloadSellerTabs = async () => {
    const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
    for (const tab of tabs) {
      chrome.tabs.reload(tab.id);
    }
    if (tabs.length) console.log(`[reloadSellerTabs] reloaded ${tabs.length} seller tab(s)`);
  };

  chrome.runtime.onInstalled.addListener(() => {
    detectBackendUrl();
    createContextMenus();
    setupUpdateAlarm();
    setupFollowSellCheckAlarm();
    setupHeartbeatAlarm();
    setupFxAlarm();
    initClientSyncContext();
    initBrowserAgentContext();
    setupClientSyncAlarms();
    setupBrowserAgentAlarm();
    checkForUpdate();
    refreshExchangeRate();
    handleBrowserAgentAlarm();
    reloadSellerTabs();
  });

  chrome.runtime.onStartup.addListener(() => {
    setupFollowSellCheckAlarm();
    setupHeartbeatAlarm();
    setupFxAlarm();
    initClientSyncContext();
    initBrowserAgentContext();
    setupClientSyncAlarms();
    setupBrowserAgentAlarm();
    refreshExchangeRate();
    handleBrowserAgentAlarm();
    reloadSellerTabs();
  });

  // SW 冷启动(install/startup 之外的 import 时)也要 init,
  // 因为 chrome 在 SW 唤醒时不会再触发 onStartup。
  initClientSyncContext();
  initBrowserAgentContext();

  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId !== 'ozon-image-search-1688' || !info.srcUrl) return;
    const encoded = encodeURIComponent(info.srcUrl);
    // 走极掌的自动以图搜款流程（1688-image-search.js content script 处理 __jzcOzonImg）
    const targetUrl = `https://s.1688.com/youyuan/index.htm?tab=imageSearch&__jzcOzonImg=${encoded}`;
    chrome.tabs.create({ url: targetUrl });
  });

  // tab 关闭时清理采集器心跳记录

  const get1688TabNavigationUrl = (tab) => String(tab?.pendingUrl || tab?.url || '');

  const is1688ImageSearchPageUrl = (url) => {
    try {
      const u = new URL(String(url));
      return /(^|\.)1688\.com$/i.test(u.hostname)
        && u.pathname.includes('/kapp/1688-search/pc-image-search/');
    } catch (_) {
      return false;
    }
  };

  const is1688ImageSearchTransitionUrl = (url) => {
    try {
      const u = new URL(String(url));
      return is1688ImageSearchPageUrl(u.href)
        && u.searchParams.has('__jzcOzonImg')
        && !u.searchParams.has('imageId');
    } catch (_) {
      return false;
    }
  };

  const is1688ImageSearchResultUrl = (url) => {
    try {
      const u = new URL(String(url));
      return is1688ImageSearchPageUrl(u.href) && u.searchParams.has('imageId');
    } catch (_) {
      return false;
    }
  };

  const collapse1688ImageSearchResultTab = async (tab) => {
    const resultUrl = get1688TabNavigationUrl(tab);
    if (!is1688ImageSearchResultUrl(resultUrl)) return false;

    const openerTabId = Number(tab?.openerTabId);
    const resultTabId = Number(tab?.id);
    if (!Number.isInteger(openerTabId) || !Number.isInteger(resultTabId) || openerTabId === resultTabId) {
      return false;
    }

    let openerTab;
    try {
      openerTab = await chrome.tabs.get(openerTabId);
    } catch (_) {
      return false;
    }

    if (!is1688ImageSearchTransitionUrl(get1688TabNavigationUrl(openerTab))) return false;

    try {
      await chrome.tabs.update(openerTabId, { url: resultUrl, active: true });
      await chrome.tabs.remove(resultTabId);
      console.info('[jzc-1688] collapsed image-search result tab into transition tab');
      return true;
    } catch (e) {
      console.warn('[jzc-1688] failed to collapse image-search result tab:', e?.message || e);
      return false;
    }
  };

  if (chrome.tabs?.onCreated?.addListener) {
    chrome.tabs.onCreated.addListener((tab) => {
      collapse1688ImageSearchResultTab(tab);
    });
  }

  if (chrome.tabs?.onUpdated?.addListener) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (!changeInfo?.url && !tab?.pendingUrl && !tab?.url) return;
      collapse1688ImageSearchResultTab({ ...tab, id: tabId });
    });
  }

  // Clean collector heartbeat cache when a tab is closed.
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (collectorTabs.has(tabId)) collectorTabs.delete(tabId);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 极掌算价：手动重拉汇率（content/jzc-calc.js 走 message.type 路由，
    // 与现有 message.action dispatch 完全独立）
    if (message?.type === 'jzc:refreshFx') {
      refreshExchangeRate().then((rate) => sendResponse({ ok: rate != null, rate }));
      return true;
    }

    // 商品页采集 fallback:Ozon 2026 起逐步把 PDP state 从 SSR DOM 剥离到纯
    // 客户端 hydrate(web* widget 元素只剩 shell,data-state 全空)。
    // content_script extractProductData 读 DOM 拿不到 title/images/sku/aspects
    // 全部 → 触发"采集失败"页。
    //
    // 这里走 composer-api page json 拉同一份数据(用浏览器 cookie/IP,不打 backend),
    // 解析 widgetStates 返回结构化字段。content_script 收到后注入 panel 替代
    // DOM 解析结果。
    //
    // 协议:request  { action:'fetchProductPageState', url }
    //       response { ok, fields?, raw?, error? }
    //   fields: { title, sku, productId, price, currency, images[], coverImage,
    //             aspects[], seller:{name,link}, brand, category }
    if (message?.action === 'fetchProductPageState') {
      (async () => {
        try {
          const inputUrl = String(message?.url || '').trim();
          if (!inputUrl) {
            sendResponse({ ok: false, error: 'url required' });
            return;
          }
          // 抠 product path (/product/...-SKU/)。url 可能是绝对(用户当前 href)
          // 也可能是相对路径。
          let productPath = inputUrl;
          try {
            const u = new URL(inputUrl, 'https://www.ozon.ru');
            productPath = u.pathname;
          } catch {}
          if (!productPath.startsWith('/product/')) {
            sendResponse({ ok: false, error: 'not a product url' });
            return;
          }
          // composer-api page endpoint。SW 直 fetch 反爬必死 403,走 fetchOzonWwwViaTab
          // 通过 sender 的 ozon.ru tab 注入 MAIN world,带用户真实 cookie + fingerprint。
          // (2026-05-26 修复:fetchProductPageState 在采集面板报 "Ozon 403"。)
          const apiUrl = `https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(productPath)}`;
          const fetchResult = await fetchOzonWwwViaTab(sender, apiUrl, 15_000);
          if (!fetchResult.ok) {
            sendResponse({ ok: false, error: fetchResult.error || `Ozon ${fetchResult.status}` });
            return;
          }
          const data = fetchResult.data;
          const ws = data?.widgetStates || {};
          const keys = Object.keys(ws);
          const find = (prefix) => keys.find((k) => k.startsWith(prefix));
          const parse = (key) => {
            if (!key) return null;
            const raw = ws[key];
            if (typeof raw === 'object' && raw !== null) return raw;
            try { return JSON.parse(raw); } catch { return null; }
          };
          const gallery = parse(find('webGallery'));
          const heading = parse(find('webProductHeading'));
          const aspects = parse(find('webAspects'));
          const price = parse(find('webPrice'));
          const seller = parse(find('webCurrentSeller'));
          const shortChars = parse(find('webShortCharacteristics'));
          const detailSku = parse(find('webDetailSKU'));
          const brand = parse(find('webBrand'));
          // sku 优先 gallery.sku,fallback detailSku
          const sku = String(
            gallery?.sku ||
            detailSku?.sku ||
            detailSku?.itemId ||
            (productPath.match(/-(\d+)\/?$/)?.[1]) ||
            ''
          );
          // images: gallery 通常 {images:[{url,...}, ...], coverImage:{url,...}}
          const images = Array.isArray(gallery?.images)
            ? gallery.images
                .map((it) => (typeof it === 'string' ? it : it?.url || it?.link || it?.src))
                .filter(Boolean)
            : [];
          const coverImage =
            typeof gallery?.coverImage === 'string'
              ? gallery.coverImage
              : gallery?.coverImage?.url || gallery?.coverImage?.link || images[0] || '';
          // seller link / name
          let sellerName = '';
          let sellerLink = '';
          try {
            sellerName =
              seller?.header?.title?.text ||
              seller?.sellerCell?.centerBlock?.title?.text ||
              seller?.sellerCell?.name ||
              seller?.name ||
              '';
            sellerLink =
              seller?.header?.title?.link ||
              seller?.sellerCell?.centerBlock?.title?.link ||
              seller?.sellerCell?.link ||
              seller?.link ||
              '';
          } catch {}
          // brand
          let brandName = '';
          try {
            brandName = brand?.title || brand?.name || '';
          } catch {}
          // price
          const priceStr =
            price?.cardPrice || price?.price || price?.originalPrice || '';
          const fields = {
            title: heading?.title || '',
            sku,
            productId: sku,
            price: priceStr,
            images,
            coverImage,
            aspects: Array.isArray(aspects?.aspects) ? aspects.aspects : [],
            seller: { name: sellerName, link: sellerLink },
            brand: brandName,
            shortCharacteristicsRaw: shortChars || null,
          };
          // 也把 raw widgetStates 回传 — content_script 的 extractStateData
          // fallback 缓存层会把它当作"伪 SSR DOM" 用,让所有走 extractStateData 的
          // 老逻辑透明命中 composer-api 数据,不需要逐个改 caller。
          // 体积控制:不传 webPdpGrid / 容器类(布局 meta),只传业务 widget。
          const usefulPrefixes = [
            'webGallery', 'webProductHeading', 'webAspects', 'webPrice',
            'webAddToCart', 'webCurrentSeller', 'webBrand', 'webDetailSKU',
            'webShortCharacteristics', 'webCharacteristics', 'webDescription',
            'webMarketingLabels', 'webSale', 'webReviewProductScore',
            'webSingleProductScore', 'webModelParams', 'webHashtags',
            'webBestSeller', 'webProductMainWidget',
          ];
          const widgetStates = {};
          for (const k of keys) {
            if (usefulPrefixes.some((p) => k.startsWith(p))) {
              widgetStates[k] = ws[k];
            }
          }
          // shared-utils.js window.sendMessage 协议:成功必须 { ok:true, data:{...} }
          // 否则 caller 只 resolve(response.data) 会拿到 undefined。
          // 之前平铺 { ok, fields, widgetStates } 导致 ensurePdpState 静默失败
          // (fire-and-forget 没人发现,但下游 findStateDataByKeys 一直命中 stale DOM)。
          sendResponse({ ok: true, data: { fields, widgetStates } });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    // expandModelVariants 不在 SW 实现 — content/ozon-product.js 里直接 fetch SSR HTML
    // (path-only,带 same-origin cookies,200 OK)+ DOMParser 解析。原因:
    //   `/api/composer-api.bx/page/json/v2?url=...` 已被 Ozon antibot 全员 403(2026-05-26
    //   端到端验证;含当前页 fetch 自己也 403),改走 SSR HTML 路径。
    //   SW 无 DOMParser,所以解析必须在 content/page context 完成,本来就不需要绕一圈 SW。

    // L1 (composer-api 拦截) 样本上报。content/collector/l1-bridge.js batch 推送。
    // 默认 dry-run — chrome.storage.local.l1ReportEnabled=true 才真发网络请求。
    // Phase 1 PoC 不要急着开,先用 __jzc.l1Stats() 在 page 端看本地影子表数据。
    if (message?.type === 'JZC_L1_SAMPLE') {
      const samples = Array.isArray(message.samples) ? message.samples : [];
      l1SwStats.receivedBatches += 1;
      l1SwStats.receivedSamples += samples.length;
      // 异步处理,马上回 ack 避免 content script hold 连接
      sendResponse({ ok: true, batchSize: samples.length });
      (async () => {
        try {
          const stored = await getStorage([
            STORAGE_KEYS.l1ReportEnabled,
            STORAGE_KEYS.token,
            STORAGE_KEYS.storeId,
          ]);
          if (!stored[STORAGE_KEYS.l1ReportEnabled]) {
            l1SwStats.droppedDisabled += samples.length;
            return;
          }
          const token = stored[STORAGE_KEYS.token];
          const storeId = stored[STORAGE_KEYS.storeId];
          if (!token) {
            l1SwStats.droppedNoAuth += samples.length;
            return;
          }
          const backendUrl = await getBackendUrl();
          // 后端 endpoint 占位 — 实际 schema/路径需要后端先开。HTTP 失败静默,不重试。
          await apiRequest(
            'POST',
            `${backendUrl}/extension/l1-samples`,
            { samples, sentAt: Date.now() },
            token,
            storeId,
            15_000,
          );
          l1SwStats.sentSamples += samples.length;
          l1SwStats.lastSentAt = Date.now();
        } catch (err) {
          l1SwStats.httpErrors += 1;
          l1SwStats.lastError = err && err.message ? err.message : String(err);
        }
      })();
      return false; // sync response 已发,async 工作 fire-and-forget
    }

    // 前端"立即同步"按钮(my.jizhangerp.com 等)走 postMessage → bridge →
    // chrome.runtime.sendMessage 触发本店本类型一次同步。bridge 是 jizhangerp.com
    // 域内 content_script,这里直接调 JzSyncEngine.runOneType,跳过 backend BullMQ。
    //
    // 协议:request  { type:'jzManualSync', storeId, syncType:'PRODUCTS'|'POSTINGS'|'WAREHOUSES' }
    //       response { ok, jobId?, error? }
    //
    // 设计:
    //  1) 先 GET 一遍 token / sync 模块就绪检查,缺啥就 ok:false 让前端 fallback;
    //  2) SW 端 pre-write PENDING 行(同步 await),保证 frontend poll
    //     /ozon/sync/jobs/:jobId 立刻能命中,不会 404 看起来像扩展挂了;
    //  3) sendResponse({ ok:true, jobId }) 后 fire-and-forget runOneType 入并发限流队列
    //     (Codex P1 #2):"全部同步" UI 在 100ms 内可连发 N×3 条消息,如果直接
    //     fire-and-forget 会瞬间起 15+ 并发 Ozon 请求 → 撞 antibot / 429。
    //     manualSyncSem 限制同时 ≤ 3 个 runOneType,多余排队。lease-busy / crash
    //     的状态上报维持原逻辑(在 runOneType 落地后)。
    if (message?.type === 'jzManualSync') {
      (async () => {
        try {
          const storeId = String(message?.storeId || '').trim();
          const syncType = String(message?.syncType || '').toUpperCase();
          if (!storeId || !['PRODUCTS', 'POSTINGS', 'WAREHOUSES'].includes(syncType)) {
            sendResponse({ ok: false, error: 'invalid storeId/syncType' });
            return;
          }
          if (!globalThis.JzSyncEngine || !globalThis.JzSyncState || !globalThis.JzBackendClient) {
            sendResponse({ ok: false, error: 'sync_modules_not_loaded' });
            return;
          }
          const stored = await getStorage([STORAGE_KEYS.token]);
          if (!stored[STORAGE_KEYS.token]) {
            sendResponse({ ok: false, error: 'extension_not_authed' });
            return;
          }
          const deviceId = await globalThis.JzSyncState.getOrCreateDeviceId();
          const jobId = crypto.randomUUID();
          const postingsOptions = syncType === 'POSTINGS'
            ? {
                postingsSinceDays: Number.isFinite(Number(message?.postingsSinceDays))
                  ? Number(message.postingsSinceDays)
                  : undefined,
                postingsSince: typeof message?.postingsSince === 'string'
                  ? message.postingsSince
                  : undefined,
                postingsTo: typeof message?.postingsTo === 'string'
                  ? message.postingsTo
                  : undefined,
              }
            : undefined;
          try {
            await globalThis.JzBackendClient.clientReport({
              storeId,
              type: syncType,
              clientJobId: jobId,
              deviceId,
              status: 'PENDING',
            });
          } catch (e) {
            sendResponse({
              ok: false,
              error: `client-report PENDING failed: ${e?.message || e}`,
            });
            return;
          }
          sendResponse({ ok: true, jobId });
          // fire-and-forget,通过 runManualSyncBounded 限流(P1 #2)。runOneType 落地
          // 后照旧根据 lease-busy / crash 上报 FAILED 终态。
          runManualSyncBounded(() =>
            globalThis.JzSyncEngine
              .runOneType({ id: storeId }, syncType, deviceId, jobId, postingsOptions)
              .then(async (res) => {
                if (res?.skipped === 'lease-busy') {
                  await globalThis.JzBackendClient.clientReport({
                    storeId,
                    type: syncType,
                    clientJobId: jobId,
                    deviceId,
                    status: 'FAILED',
                    error: 'lease-busy: 另一台设备正在同步该店铺同类型数据',
                  }).catch(() => {});
                }
              })
              .catch(async (e) => {
                console.warn('[jzManualSync] runOneType crash:', e?.message || e);
                await globalThis.JzBackendClient.clientReport({
                  storeId,
                  type: syncType,
                  clientJobId: jobId,
                  deviceId,
                  status: 'FAILED',
                  error: String(e?.message || e).slice(0, 500),
                }).catch(() => {});
              }),
          );
        } catch (e) {
          try {
            sendResponse({ ok: false, error: e?.message || String(e) });
          } catch {}
        }
      })();
      return true;
    }

    if (message?.type === 'JZC_L1_REPORT_STATUS') {
      (async () => {
        const stored = await getStorage([
          STORAGE_KEYS.l1ReportEnabled,
          STORAGE_KEYS.token,
        ]);
        sendResponse({
          enabled: !!stored[STORAGE_KEYS.l1ReportEnabled],
          authed: !!stored[STORAGE_KEYS.token],
          stats: { ...l1SwStats },
          hint: stored[STORAGE_KEYS.l1ReportEnabled]
            ? 'L1 上报已启用'
            : "dry-run: 本地影子表写入正常,后端上报关闭。启用: chrome.storage.local.set({ l1ReportEnabled: true })",
        });
      })();
      return true;
    }


  const getSellerPortalCompanyId = async () => {
    const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
    const companyId = scCookies[0]?.value || '';
    if (!companyId) {
      throw new Error('sc_company_id not found, please login seller.ozon.ru first');
    }
    return companyId;
  };

    const handle = async () => {
      const data = await getStorage([STORAGE_KEYS.token, STORAGE_KEYS.storeId]);
      const token = data[STORAGE_KEYS.token];
      const storeId = data[STORAGE_KEYS.storeId];
      const backendUrl = await getBackendUrl();

      switch (message?.action) {
        case 'getAuth': {
          // version 由 manifest 注入,前端用它判断是否需要升级提示
          const manifest = chrome.runtime.getManifest() || {};
          const version = String(manifest.version || '');
          return { ok: true, data: { token, storeId, backendUrl, version } };
        }
        case 'getWatermarkTemplates': {
          if (!token) return { ok: false, error: 'no auth' };
          const targetStoreId = message?.storeId || storeId;
          const [templates, stores] = await Promise.all([
            apiRequest('GET', `${backendUrl}/ozon/watermark-settings`, null, token, targetStoreId),
            apiRequest('GET', `${backendUrl}/auth/ozon-stores`, null, token, targetStoreId),
          ]);
          return {
            ok: true,
            data: {
              templates: Array.isArray(templates) ? templates : [],
              stores: Array.isArray(stores) ? stores : [],
            },
          };
        }
        case 'usageTrack': {
          // 通用功能埋点。当天每个 (featureKey, client, version) 组合只发一次到
          // backend — 设备级去重避免高频写,backend 用 (tenantId, featureKey,
          // usageDate, client, version) unique 索引做最终聚合。失败静默,不影响
          // 调用方。client / version 由 sw 自动从 manifest 注入,调用方无需关心。
          try {
            const featureKey = String(message?.featureKey || '').trim();
            if (!featureKey || !/^[a-z0-9][a-z0-9:_\-]{1,63}$/.test(featureKey)) {
              return { ok: false, error: 'invalid featureKey' };
            }
            if (!token) return { ok: false, error: 'no auth' };
            const manifest = chrome.runtime.getManifest() || {};
            // 用 manifest.name 区分主插件 vs lite (lite 名字含 'lite' / '极简')。
            // 不依赖 build 配置,降版/换插件时自动适应。
            const isLite = /lite|极简/i.test(manifest.name || '');
            const client = isLite ? 'lite' : 'main';
            const version = String(manifest.version || 'unknown').slice(0, 16);
            const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            const dedupeKey = `${featureKey}@${client}@${version}`;
            const stored = await getStorage([STORAGE_KEYS.usageTrackedDate]);
            const map = stored[STORAGE_KEYS.usageTrackedDate] || {};
            if (map[dedupeKey] === today) {
              return { ok: true, deduped: true };
            }
            // 先标记再发请求 — 即使网络失败也不重试,防止刷爆。
            map[dedupeKey] = today;
            await setStorage({ [STORAGE_KEYS.usageTrackedDate]: map });
            await apiRequest(
              'POST',
              `${backendUrl}/usage/track`,
              { featureKey, client, version },
              token,
              storeId,
              5000,
            );
            return { ok: true };
          } catch (e) {
            // 静默失败,埋点不能影响主功能
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'saveAuth': {
          await setStorage({
            [STORAGE_KEYS.token]: message.token,
            [STORAGE_KEYS.storeId]: message.storeId,
          });
          reloadOzonTabs();
          return { ok: true };
        }
        case 'logout': {
          await removeStorage([STORAGE_KEYS.token, STORAGE_KEYS.storeId]);
          reloadOzonTabs();
          // 扩展登出 → 同步登出已打开的 ERP 网页。await 确保 web 端 token 在本
          // handler 返回前已清,堵住"清扩展→web 端 syncAuthFromWeb 又把旧 token
          // 喂回来"的时间窗。
          await clearWebAuthTabs();
          return { ok: true };
        }
        case 'flashBadge': {
          // Flash the toolbar icon badge to draw user attention
          chrome.action.setBadgeText({ text: '!' });
          chrome.action.setBadgeBackgroundColor({ color: '#005bff' });
          setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
          return { ok: true };
        }
        case 'openLoginPopup': {
          // 页面内「登录极掌」按钮直接弹工具栏 popup。chrome.action.openPopup()
          // Chrome 127+ 对普通扩展开放;更老版本/非活动窗口会抛错 → opened:false,
          // content 侧降级为原 badge 闪烁 + 气泡指引。
          try {
            await chrome.action.openPopup();
            return { ok: true, data: { opened: true } };
          } catch (e) {
            console.log('[openLoginPopup] openPopup unavailable:', e?.message);
            return { ok: true, data: { opened: false } };
          }
        }
        case 'syncAuthFromWeb': {
          // Source-of-truth policy: popup is the primary login UI for the extension.
          //   - Web empty          → DO NOT clear extension (may just be an un-logged-in Web tab).
          //   - Extension empty    → adopt Web token (first-time login synced from Web).
          //   - Same token on both → allow storeId to update (user switched store on Web).
          //   - Different tokens   → IGNORE Web; extension wins. Prevents stale Web tokens
          //                          from clobbering a fresh popup login.
          if (!message.token) {
            return { ok: true };
          }
          if (!token) {
            await setStorage({
              [STORAGE_KEYS.token]: message.token,
              [STORAGE_KEYS.storeId]: message.storeId || storeId,
            });
            console.log('[ServiceWorker] Auth adopted from web frontend (extension was logged out)');
            reloadOzonTabs();
          } else if (message.token === token) {
            if (message.storeId && message.storeId !== storeId) {
              await setStorage({ [STORAGE_KEYS.storeId]: message.storeId });
              console.log('[ServiceWorker] Store switched from web frontend');
              reloadOzonTabs();
            }
          } else {
            console.log('[ServiceWorker] Ignoring web token — differs from extension token');
          }
          return { ok: true };
        }
        case 'tryWebSync': {
          // Popup requests: try to get token from any open jizhangerp.com tab
          try {
            const tabs = await chrome.tabs.query({
              url: [`*://${BRAND_WEB_HOST}/*`, ...LOCAL_FRONTEND_TAB_URLS],
            });
            for (const tab of tabs) {
              if (tab.id) {
                const results = await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  func: () => ({
                    token: localStorage.getItem('token'),
                    storeId: localStorage.getItem('currentOzonStoreId'),
                  }),
                });
                const result = results?.[0]?.result;
                if (result?.token) {
                  await setStorage({
                    [STORAGE_KEYS.token]: result.token,
                    [STORAGE_KEYS.storeId]: result.storeId || null,
                  });
                  return { ok: true, data: { synced: true, token: result.token, storeId: result.storeId } };
                }
              }
            }
          } catch (e) {
            console.warn('[ServiceWorker] tryWebSync failed:', e.message);
          }
          return { ok: true, data: { synced: false } };
        }
        case 'openFrontend': {
          // Open a frontend page AND preload the extension's token into the
          // tab's localStorage before React hydrates, so the user lands on
          // the target page already authenticated — no /login flash, no
          // reload round-trip.
          const frontendBase = isLocalBackendUrl(backendUrl)
            ? LOCAL_FRONTEND_BASE_URL
            : `https://${BRAND_WEB_HOST}`;
          const path = typeof message.path === 'string' && message.path.startsWith('/')
            ? message.path
            : '/';
          const url = `${frontendBase}${path}`;

          const tab = await chrome.tabs.create({ url, active: true });
          const tabId = tab?.id;

          if (tabId && token) {
            const inject = async () => {
              try {
                await chrome.scripting.executeScript({
                  target: { tabId },
                  func: (t, s) => {
                    try {
                      if (localStorage.getItem('token') !== t) {
                        localStorage.setItem('token', t);
                      }
                      if (s && localStorage.getItem('currentOzonStoreId') !== s) {
                        localStorage.setItem('currentOzonStoreId', s);
                      }
                    } catch {}
                  },
                  args: [token, storeId || null],
                });
              } catch (e) {
                console.warn('[openFrontend] inject failed:', e.message);
              }
            };

            let settled = false;
            const listener = (updatedId, info) => {
              if (updatedId !== tabId || settled) return;
              if (info.status === 'loading' || info.status === 'complete') {
                settled = true;
                chrome.tabs.onUpdated.removeListener(listener);
                inject();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            // Safety: remove listener after 10s even if status events never fire.
            setTimeout(() => {
              if (!settled) chrome.tabs.onUpdated.removeListener(listener);
            }, 10_000);
          }
          return { ok: true };
        }
        case 'openSellerPortal': {
          // 数据卡片「需登录卖家中心」提示按钮 → 复用已有 seller tab(避免重复开),
          // 没有就新开一个 active tab 让用户登录。content script 无 chrome.tabs,走 SW。
          try {
            const existing = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
            if (existing.length && existing[0].id) {
              await chrome.tabs.update(existing[0].id, { active: true });
              if (existing[0].windowId != null) {
                try { await chrome.windows.update(existing[0].windowId, { focused: true }); } catch {}
              }
              return { ok: true, data: { reused: true } };
            }
            await chrome.tabs.create({ url: 'https://seller.ozon.ru/app/products', active: true });
            return { ok: true, data: { reused: false } };
          } catch (e) {
            return { ok: false, error: e?.message || 'open seller portal failed' };
          }
        }
        case 'refreshBackend': {
          resolvedBackendUrl = null;
          const url = await detectBackendUrl();
          return { ok: true, backendUrl: url };
        }
        case 'collectProduct': {
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/ozon/collect-box`, message.product, token, storeId) };
        }
        case 'updateCollectBoxItem': {
          // AI 采集向导回写采集箱条目(标题/属性等)。PATCH 与前端 updateCollectBoxItem 同端点。
          const cbId = String(message.id || '').trim();
          if (!cbId) return { ok: false, error: 'id required' };
          return {
            ok: true,
            data: await apiRequest(
              'PATCH',
              `${backendUrl}/ozon/collect-box/${cbId}`,
              message.body || {},
              token,
              message.storeId || storeId,
              60_000,
              aiWizardDebugMeta(message, 'updateCollectBoxItem'),
            ),
          };
        }
        case 'pushSourceCollect': {
          // Multi-source unified ingest. message.sourceId in
          // 'ozon'|'1688'|'pdd'|'taobao'; message.raw is the platform-specific
          // raw scraped payload. Backend's source provider does normalization.
          //
          // 客户端去重 + 失败重试(plan v3 子项 ②):
          // - dedupe key 含 backendHost(extension 无 tenantId,用 host 作环境隔离)
          //   + storeId + sourceId + sku,24h TTL
          // - 内存级 pendingCollects 合并 in-flight 并发(快速连点 5 次合并为 1 次 POST)
          // - 网络层失败(5xx / 408 / 429 / network)指数退避,attempt 1 失败等 1s
          //   再试,attempt 2 失败等 2s 再试,attempt 3 失败直接放弃。总共最多 2 次等待。
          // - 4xx 业务错误立即返回(401/403/422 重试无意义)
          // - 成功才写 cache,失败 3 次不写(留给下次重试)
          // - forceResubmit:true 跳 dedupe(用户主动覆盖)
          const sourceId = String(message.sourceId || '').trim();
          if (!sourceId) return { ok: false, error: 'sourceId required' };
          const sku = String(message?.raw?.sku || '').trim();
          const forceResubmit = Boolean(message.forceResubmit);
          // 让调用方(AI 采集向导)用 message.storeId 覆盖扩展全局当前店铺,对齐
          // followSell 等其他 action 的 `message.storeId || storeId` 写法。否则
          // 1688 采集会落到全局店铺或 null,前端采集箱按所选店铺过滤就看不到。
          const effStoreId = message.storeId || storeId;
          const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

          let cacheKey = null;
          if (sku && backendUrl) {
            try {
              const host = new URL(backendUrl).host;
              // sku / sourceId 走 encodeURIComponent,防止 1688/PDD 等 sku 含 `:` `/` 时
              // 切坏 tuple 边界(当前 ozon sku 都是数字串,留作扩展防御)。
              cacheKey = `jz-collect-recent-v1:${host}:${encodeURIComponent(effStoreId || 'no-store')}:${encodeURIComponent(sourceId)}:${encodeURIComponent(sku)}`;
              if (!forceResubmit) {
                const cached = await new Promise((resolve) => {
                  chrome.storage.local.get([cacheKey], (d) => resolve(d?.[cacheKey]));
                });
                if (cached && Date.now() - (cached.at || 0) < DEDUPE_TTL_MS) {
                  // 必须把 dedupeHit / lastAt 放进 data — shared-utils.js sendMessage
                  // wrapper 在 resp.ok=true 时只 resolve(response.data),envelope 字段
                  // 全丢。下面 success 和 in-flight 合并路径同。
                  return { ok: true, data: { dedupeHit: true, lastAt: cached.at, result: null } };
                }
              }
            } catch {
              // 拿不到 host 就跳过 dedupe,保留原始 fetch 路径
              cacheKey = null;
            }
          }

          // in-flight 合并:并发同 cacheKey 的请求 await 同一个 Promise
          if (cacheKey && !forceResubmit && pendingCollects.has(cacheKey)) {
            try {
              const resp = await pendingCollects.get(cacheKey);
              // 给后到的并发请求标 dedupeHit,UI 区分"刚刚已采集"。
              // resp.data 形如 { dedupeHit, lastAt, result } — 仅覆盖 dedupeHit
              return resp?.ok
                ? { ok: true, data: { ...resp.data, dedupeHit: true } }
                : resp;
            } catch (e) {
              return { ok: false, error: e?.message || 'pending request failed' };
            }
          }

          const collectPromise = (async () => {
            const MAX_RETRIES = 3;
            let lastErr = null;
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
              try {
                const body = { raw: message.raw || {} };
                if (effStoreId) body.storeId = effStoreId;   // 后端 body.storeId 优先于 header
                if (message.resetDraft === true) body.resetDraft = true;
                const data = await apiRequest(
                  'POST',
                  `${backendUrl}/sources/${encodeURIComponent(sourceId)}/collect`,
                  body,
                  token,
                  effStoreId,
                  60_000,
                  aiWizardDebugMeta(message, 'pushSourceCollect', {
                    sourceId,
                    rawOfferId: message?.raw?.offerId,
                    rawTitleLen: typeof message?.raw?.title === 'string' ? message.raw.title.length : undefined,
                    rawImageCount: Array.isArray(message?.raw?.mainImages) ? message.raw.mainImages.length : undefined,
                  }),
                );
                if (cacheKey) {
                  try {
                    await new Promise((r) => chrome.storage.local.set({ [cacheKey]: { at: Date.now() } }, r));
                  } catch {}
                }
                // 把 dedupeHit / lastAt / 后端 result 全塞进 data,let sendMessage 的
                // resolve(response.data) 一次性递给 content script。
                return { ok: true, data: { dedupeHit: false, lastAt: null, result: data } };
              } catch (error) {
                lastErr = error;
                const status = error?.status;
                // 4xx 业务错误(非 408/429)立即失败,不重试
                if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
                  return { ok: false, error: error.message, status };
                }
                if (attempt < MAX_RETRIES) {
                  await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
                }
              }
            }
            return { ok: false, error: lastErr?.message || 'NETWORK_ERROR' };
          })();

          // forceResubmit 不写 pendingCollects:避免强制请求覆盖同 cacheKey 的普通请求,
          // 让后到的普通请求 await 错语义(强制语义跟普通采集不能合并)
          if (cacheKey && !forceResubmit) {
            pendingCollects.set(cacheKey, collectPromise);
          }
          try {
            return await collectPromise;
          } finally {
            if (cacheKey && !forceResubmit) pendingCollects.delete(cacheKey);
          }
        }
        case 'collectBatch': {
          // Legacy action, kept for backward compatibility with older content scripts.
          // New code should use 'pushToCollectBox'.
          const products = message.products || [];
          if (products.length === 0) return { ok: true, data: { results: [], total: 0 } };
          try {
            const data = await apiRequest('POST', `${backendUrl}/ozon/collect-box/batch`, { items: products, mode: 'update' }, token, storeId);
            return { ok: true, data };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        }
        case 'pushToCollectBox': {
          const items = message.items || [];
          const mode = message.mode === 'skip' ? 'skip' : 'update';
          if (items.length === 0) return { ok: true, data: { created: 0, updated: 0, skipped: 0, items: [] } };
          try {
            const data = await apiRequest('POST', `${backendUrl}/ozon/collect-box/batch`, { items, mode }, token, storeId);
            return { ok: true, data };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        }
        case 'pushSourceCollectBatch': {
          // 采集器批量推送(2026-05-30):走多源批量端点,每条 raw 经 provider
          // validatePayload + normalize(prune variantData + RUB→CNY + sourceId='ozon'
          // + sourceExternalId 唯一索引去重),替代旧 /ozon/collect-box/batch。
          // 返回 { results:[{action}], errors:[{index,reason}] },上层换算新增/更新/跳过。
          const sourceId = message.sourceId || 'ozon';
          const rawItems = message.items || [];
          if (rawItems.length === 0) return { ok: true, data: { results: [], errors: [] } };
          try {
            const body = { items: rawItems.map((raw) => ({ raw })) };
            const data = await apiRequest('POST', `${backendUrl}/sources/${encodeURIComponent(sourceId)}/collect/batch`, body, token, storeId);
            return { ok: true, data };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        }
        case 'collectorHeartbeat': {
          // content script → bg：上报当前 tab 的采集器状态
          const tabId = sender?.tab?.id;
          if (!tabId) return { ok: false, error: 'no tab id' };
          const heartbeatActive =
            !!message.running ||
            !!message.autoScrollerRunning ||
            !!message.currentKeyword;
          if (!heartbeatActive) {
            collectorTabs.delete(tabId);
            return { ok: true };
          }
          collectorTabs.set(tabId, {
            tabId,
            url: sender?.tab?.url || message.url || '',
            title: sender?.tab?.title || message.title || '',
            stats: message.stats || null,
            currentKeyword: message.currentKeyword || null,
            autoScrollerRunning: !!message.autoScrollerRunning,
            bucketCount: message.bucketCount ?? null,
            running: !!message.running,
            ts: Date.now(),
          });
          return { ok: true };
        }
        case 'collectorGetState': {
          // popup → bg：拉取所有活跃采集器 tab
          const now = Date.now();
          const tabs = [];
          for (const [tabId, state] of collectorTabs) {
            if (now - state.ts > COLLECTOR_STALE_MS) {
              collectorTabs.delete(tabId);
              continue;
            }
            tabs.push(state);
          }
          // 按最近活跃排序
          tabs.sort((a, b) => b.ts - a.ts);
          return { ok: true, data: { tabs } };
        }
        case 'browserAgentGetState': {
          if (!globalThis.JzBrowserAgentRuntime) {
            return { ok: false, error: 'browser agent runtime unavailable' };
          }
          return {
            ok: true,
            data: await globalThis.JzBrowserAgentRuntime.getState(),
          };
        }
        case 'browserAgentCancelCurrent': {
          if (!globalThis.JzBrowserAgentRuntime) {
            return { ok: false, error: 'browser agent runtime unavailable' };
          }
          return await globalThis.JzBrowserAgentRuntime.requestCancel(message.jobId || null);
        }
        case 'addFavorite': {
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/ozon/favorites`, message.product, token, storeId) };
        }
        case 'getProductStats': {
          let sku = message.sku;
          if (!sku && message.url) {
            const m = message.url.match(/\/product\/.*-(\d{5,})/);
            sku = m?.[1];
          }
          if (!sku) return { ok: true, data: null };
          // PDP 单卡会带 catIds(从面包屑 URL 抽的买家类目 id)→ 直连 GET 透传给后端,
          // 让佣金按类目 ID 精确分档解析(竞品无类目 id 时后端才退回俄文名兜底)。
          // 合批 body 只带 sku、且单卡无需合批,故带 catIds 时不进合批器;
          // 搜索页卡不带 catIds,照走合批(POST /product-data/batch)。
          const catIds = Array.isArray(message.catIds)
            ? message.catIds.filter((n) => Number.isFinite(n) && n > 0)
            : [];
          // period(数据卡月/周开关):后端 controller 支持但此前两条路径都没透传,
          // 周模式下标签「周销量」数据却是月口径。非法值兜底 monthly,与 getMarketStats 同。
          const pPeriod = message.period === 'weekly' ? 'weekly' : 'monthly';
          if (catIds.length) {
            try {
              const r = await apiRequest(
                'GET',
                `${backendUrl}/ozon/product-data/${sku}?skipMarket=1&catIds=${catIds.join(',')}&period=${pPeriod}`,
                null,
                token,
                storeId,
              );
              return { ok: true, data: r?.data ?? null };
            } catch (e) {
              // 会员门控 403 透传标记(content 渲染锁定卡);其他错误照旧静默降级
              if (e?.code === 'FEATURE_GATED') {
                return { ok: true, data: { __featureGated: true } };
              }
              return { ok: true, data: null };
            }
          }
          // 经合批器走 POST /ozon/product-data/batch(batch 端点恒不取 market data,
          // 语义同原 skipMarket=1 —— 扩展自己用 getMarketStats 经 seller tab 拿)。
          // 批量失败时合批器内部自动退回逐 SKU GET。period 进 ctx,换周期会先冲掉旧批。
          return queueProductStats(String(sku), { backendUrl, token, storeId, period: pPeriod });
        }
        case 'reportSkuDims': {
          // 数据卡抓到重量/尺寸即上报(fire-and-forget,攒批;后端灰度门控丢弃)。不阻塞。
          if (token && message?.item?.sku) {
            queueDimsReport(message.item, { backendUrl, token, storeId });
          }
          return { ok: true };
        }
        case 'getMarketStats': {
          // Call seller.ozon.ru internal API for market data (data/v3)
          // Must execute in seller.ozon.ru tab context (cookies + company ID)
          const mSku = message.sku;
          if (!mSku) return { ok: true, data: null };
          // what_to_sell period:'monthly'(月,默认)/ 'weekly'(周)。2026-06 月接口已恢复,
          // 默认回月;尊重调用方传入的 period(数据卡周期开关),非法值兜底 monthly。
          const mPeriod = message.period === 'weekly' ? 'weekly' : 'monthly';
          // 灰度:服务端机群取数(命中走俄罗斯 VPS;失败/未命中回落下面的代采+本地老路)
          if (!message.noProxy && await isFleetServerSide(backendUrl, token)) {
            // 本地 memo(30min)命中零网络;只缓存真拿到 item 的成功结果,null/失败不缓存
            const _mk = _fleetMarketCacheKey(String(mSku), mPeriod);
            const _hit = await _fleetCacheGet(_mk, _FLEET_MARKET_CACHE_TTL_MS);
            if (_hit) return { ok: true, data: normalizeMarketItem(_hit) };
            // 微批探针:同屏多卡的单条查询合成一条 market/batch(后端只答快照/缓存
            // 命中即回,不打 VPS)。命中省一次单条 fleet 往返;miss 落回下面单条。
            const _probeIt = await _marketBatchProbe(backendUrl, token, storeId, String(mSku), mPeriod);
            if (_probeIt) {
              _fleetCacheSet(_mk, _probeIt);
              return { ok: true, data: normalizeMarketItem(_probeIt) };
            }
            const _fb = { filter: { stock: 'any_stock', period: mPeriod, sku: String(mSku) }, sort: { key: 'sum_gmv_desc' }, limit: '1', offset: '0' };
            const _fr = await callFleet(backendUrl, token, storeId, 'market', { payload: _fb });
            if (_fr) {
              const _it = _fr.items?.[0] || _fr.data?.[0] || null;
              if (_it) _fleetCacheSet(_mk, _it);
              return { ok: true, data: _it ? normalizeMarketItem(_it) : null };
            }
          }
          // 本机没登卖家端 → 透明回退:把取数派给同租户/池子里已登录 seller 的设备代采
          // (后端服务器 IP 直连 data/v3 会撞反爬 307 loop,只能借用户浏览器)。
          // noProxy 防递归 —— 代采执行方本身已登录,直接跑下面的本地路径。
          if (!message.noProxy) {
            const _scLocal = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
            if (!_scLocal[0]?.value) {
              const proxied = await proxyMarketData(backendUrl, token, storeId, mSku, mPeriod);
              if (proxied) return proxied; // 代采成功({ ok, data });失败则落到下面走「需登录」
            }
          }
          try {
            let sellerTabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
            // 没开任何 seller tab。选品库稀疏,多数商品市场数据仍依赖 seller tab 的 what_to_sell;
            // #82 后变体查询走 www 不再顺带开 seller tab → 这里在「已登录 seller」时自己开一个
            // (ensureSellerTab 内含 single-flight,列表页多卡并发只开一个)。未登录则不开无用
            // signin tab,直接走下面的「需登录」提示。
            if (!sellerTabs.length) {
              const _sc = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
              if (_sc[0]?.value) {
                try { await ensureSellerTab(); } catch (e) { console.log('[getMarketStats] ensureSellerTab 失败:', e?.message || e); }
                sellerTabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
              }
            }
            // 仍没有(未登录 / 开 tab 失败)→ 会话信号(不是"该 SKU 无数据")。卡片据此显示
            // 「需登录卖家中心」提示,而非静默"-"。__needSellerLogin 放 data 里 ——
            // sendMessage wrapper 只透传 response.data,放顶层会被吞(envelope 坑)。
            if (!sellerTabs.length) {
              return { ok: true, data: { __needSellerLogin: true, __reason: 'NO_SELLER_TAB' } };
            }

            // 2026-05-30 修:不靠 URL 猜哪个 tab 登录了 —— 用户常同时开多个 seller tab,
            // 其中可能混着 /app/registration/signin(未登录/会话过期被重定向)。旧逻辑
            // `find(url.includes('/app/'))` 会选中 signin 页(它也含 /app/),注入后拿不到
            // sc_company_id → 永远返 null → market 字段全空。
            //
            // 新逻辑:遍历所有 seller tab 逐个注入,注入函数自己判 cookie + fetch,
            // 第一个真拿到 sc_company_id 且 data/v3 成功的就用。URL 会骗人(过期态也可能
            // 停在 /app/products),cookie + fetch 成功才是硬证据。
            //
            // 注入函数返回三态:
            //   { ok: true,  data }  — 成功(可能 data=null,即该 SKU 无市场数据但登录正常)
            //   { ok: false, reason: 'no_company_id' } — 这个 tab 没登录,试下一个
            //   { ok: false, reason: 'http_<status>' } — fetch 被拒(限流/权限),试下一个
            // 排序:把含 signin/registration/auth/login 的 tab 排到最后,优先试业务页,
            // 减少无谓注入(纯优化,不影响正确性 —— 反正都会遍历到能用的那个)。
            const isAuthUrl = (u) => /\/(registration|signin|auth|login)/i.test(u || '');
            const orderedTabs = [...sellerTabs].sort(
              (a, b) => (isAuthUrl(a.url) ? 1 : 0) - (isAuthUrl(b.url) ? 1 : 0),
            );

            const injectFetch = async (sku, period) => {
              try {
                const cookies = document.cookie.split(';').map((c) => c.trim());
                const scCookie = cookies.find((c) => c.startsWith('sc_company_id='));
                const companyId = scCookie ? scCookie.split('=')[1] : '';
                if (!companyId) return { ok: false, reason: 'no_company_id' };
                const resp = await fetch('/api/site/seller-analytics/what_to_sell/data/v3', {
                  method: 'POST',
                  credentials: 'include',
                  headers: {
                    'accept': 'application/json',
                    'content-type': 'application/json',
                    'x-o3-app-name': 'seller-ui',
                    'x-o3-company-id': companyId,
                    'x-o3-language': 'zh-Hans',
                  },
                  body: JSON.stringify({
                    filter: { stock: 'any_stock', period: period || 'monthly', sku: String(sku) },
                    sort: { key: 'sum_gmv_desc' },
                    limit: '1', offset: '0',
                  }),
                });
                if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
                const result = await resp.json();
                // items 是历史 key;data/v3 偶以 data 返回(后端 ozon-market-data 同样 items??data 兜底)。
                // 字段大小写归一在 SW 侧做(此函数注入页面上下文,够不到 SW 的 normalizeMarketItem)。
                return { ok: true, data: result?.items?.[0] || result?.data?.[0] || null };
              } catch (e) {
                return { ok: false, reason: `exc_${(e && e.message) || 'unknown'}` };
              }
            };

            const reasons = [];
            for (const tab of orderedTabs) {
              if (!tab.id) continue;
              let injected;
              try {
                // 销量列会并发多个 getMarketStats,这条注入 fetch 直打 what_to_sell/data/v3,
                // 不经 fetchSellerPortal → 必须显式过全局节奏闸门,否则绕过 P2-1 的限流摊平。
                await _sellerPortalGate();
                injected = await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  func: injectFetch,
                  args: [mSku, mPeriod],
                });
              } catch (e) {
                // 个别 tab 注入失败(页面 crash / 权限)不致命,继续试下一个
                reasons.push(`tab${tab.id}:inject_err`);
                continue;
              }
              const r = injected?.[0]?.result;
              if (r?.ok) {
                // 找到能用的 tab —— 成功(data 可能 null,表示该 SKU 无市场数据但登录正常)。
                // normalizeMarketItem:把 data/v3 item 归一成下游固定读的 camelCase,
                // 防 Ozon 改大小写导致月销量等市场字段全空却无报错(见 normalizeMarketItem 注释)。
                return { ok: true, data: r.data ? normalizeMarketItem(r.data) : null };
              }
              reasons.push(`tab${tab.id}:${r?.reason || 'no_result'}`);
            }

            // 所有 seller tab 都拿不到。区分两种:
            //   - 全部 no_company_id → 会话过期/未登录 → __needSellerLogin 让卡片提示去登录
            //   - 其余(http_401/AUTH_REDIRECT 也算会话;http_403/限流/网络等 → 仍静默 null)
            // 401/signin 重定向都归为"需登录";其它(权限/限流/网络抖动)不强提示,
            // 避免把临时性 fetch 失败误报成"需登录"骚扰用户。
            console.log('[getMarketStats] no usable seller tab:', reasons.join(', '));
            const sessionLike = reasons.every((r) =>
              /no_company_id|http_401|signin|login|redirect/i.test(r),
            );
            if (sessionLike) {
              return { ok: true, data: { __needSellerLogin: true, __reason: 'AUTH_REQUIRED' } };
            }
            return { ok: true, data: null };
          } catch (e) {
            console.log('[getMarketStats] failed:', e.message);
            return { ok: true, data: null };
          }
        }
        case 'getMarketStatsBatch': {
          // 多变体面板销量列合批取数,只走 fleet 途径:本地 memo → 批量端点 → 单条补拉,
          // 彻底拿不到的收进 pending 由 content 降级代采/seller tab 老路。
          // 非灰度返 supported:false → content 原样走 worker 池老路(红线:不能让
          // 非灰度用户的并发打到 seller tab 注入)。supported 放 data 里 —— sendMessage
          // wrapper 只透传 response.data(envelope 坑,同 __needSellerLogin)。
          const bSkus = Array.isArray(message.skus)
            ? [...new Set(message.skus.map((s) => String(s || '').trim()).filter(Boolean))]
            : [];
          const bPeriod = message.period === 'weekly' ? 'weekly' : 'monthly';
          if (!(await isFleetServerSide(backendUrl, token))) {
            return { ok: true, data: { supported: false } };
          }
          const bResults = {};
          const bPending = [];
          // ① 本地 memo 先行(30min,零网络)
          const bMisses = [];
          for (const s of bSkus) {
            const hit = await _fleetCacheGet(_fleetMarketCacheKey(s, bPeriod), _FLEET_MARKET_CACHE_TTL_MS);
            if (hit) bResults[s] = normalizeMarketItem(hit);
            else bMisses.push(s);
          }
          // ② batch 端点:后端只查缓存/榜单快照即回(miss 不打 VPS)的轻请求,不占
          //    fleet 6 并发闸;≤50/批。payload 字段顺序必须与单条路径完全一致 ——
          //    后端按 JSON.stringify(payload) 的 sha1 对缓存键,顺序不同就 miss。
          let bSingles = bMisses;
          if (bMisses.length && Date.now() >= _fleetMarketBatchDownUntil) {
            bSingles = [];
            for (let i = 0; i < bMisses.length; i += 50) {
              const chunk = bMisses.slice(i, i + 50);
              if (Date.now() < _fleetMarketBatchDownUntil) { bSingles.push(...chunk); continue; }
              try {
                const items = chunk.map((s) => ({ payload: { filter: { stock: 'any_stock', period: bPeriod, sku: String(s) }, sort: { key: 'sum_gmv_desc' }, limit: '1', offset: '0' } }));
                const resp = await apiRequest('POST', `${backendUrl}/ozon/fleet/market/batch`, { items }, token, storeId, 25_000);
                const rows = resp?.ok && Array.isArray(resp.results) ? resp.results : [];
                chunk.forEach((s, idx) => {
                  const row = rows[idx];
                  const it = row && row.hit ? (row.data?.items?.[0] || row.data?.data?.[0] || null) : null;
                  if (it) {
                    _fleetCacheSet(_fleetMarketCacheKey(s, bPeriod), it);
                    bResults[s] = normalizeMarketItem(it);
                  } else {
                    bSingles.push(s);
                  }
                });
              } catch {
                // 旧后端 404 / 未进灰度 403 / 网络失败:标记 10min 不再撞 batch,本批全部降级单条
                _fleetMarketBatchDownUntil = Date.now() + 10 * 60 * 1000;
                bSingles.push(...chunk);
              }
            }
          }
          // ③ batch 没命中的逐个走单条 fleet(callFleet 内含 6 并发闸,FIFO 排队,
          //    排队超时/失败自然落 pending)。成功写 memo。
          if (bSingles.length) {
            await Promise.all(bSingles.map(async (s) => {
              const _fb = { filter: { stock: 'any_stock', period: bPeriod, sku: String(s) }, sort: { key: 'sum_gmv_desc' }, limit: '1', offset: '0' };
              const _fr = await callFleet(backendUrl, token, storeId, 'market', { payload: _fb });
              if (_fr) {
                const _it = _fr.items?.[0] || _fr.data?.[0] || null;
                if (_it) {
                  _fleetCacheSet(_fleetMarketCacheKey(s, bPeriod), _it);
                  bResults[s] = normalizeMarketItem(_it);
                } else {
                  // fleet 正常响应但该 SKU 无市场数据 → 确定性 null,content 不必再走老路
                  bResults[s] = null;
                }
              } else {
                bPending.push(s);
              }
            }));
          }
          return { ok: true, data: { supported: true, results: bResults, pending: bPending } };
        }
        case 'getMembershipSummary': {
          try {
            const summary = await apiRequest('GET', `${backendUrl}/membership/usage-summary`, null, token, storeId);
            return { ok: true, data: summary };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        }
        case 'getAiQuota': {
          // AI 改图：按极点余额 / 单价 计算可用张数，但受会员等级限制（免费版 24h 试用）
          // AI 重写：按次扣极点(2026-07 起,不再是会员权益)，余额不足内容脚本默认关闭
          // 单价从 /jidian/pricing 拉取，超管可在后台调整；拉不到 fallback 到默认价
          try {
            const [balanceRes, summaryRes, pricingRes] = await Promise.all([
              apiRequest('GET', `${backendUrl}/jidian/balance`, null, token, storeId).catch(() => ({ balance: 0 })),
              apiRequest('GET', `${backendUrl}/membership/usage-summary`, null, token, storeId).catch(() => null),
              apiRequest('GET', `${backendUrl}/jidian/pricing`, null, token, storeId).catch(() => null),
            ]);
            const balance = balanceRes?.balance ?? 0;
            const PRICE_IMAGE = typeof pricingRes?.AI_IMAGE === 'number' && pricingRes.AI_IMAGE > 0
              ? pricingRes.AI_IMAGE
              : 50;
            const PRICE_REWRITE = typeof pricingRes?.AI_REWRITE === 'number' && pricingRes.AI_REWRITE > 0
              ? pricingRes.AI_REWRITE
              : 20;
            const aiEditEnabled = summaryRes?.canUse?.AI_EDIT !== false;
            const aiEditTrialExpired = summaryRes?.usage?.aiEditTrialExpired === true;
            const pointAliasRaw = pricingRes?._meta?.pointAlias;
            const pointLabel = typeof pointAliasRaw === 'string' && pointAliasRaw.trim()
              ? pointAliasRaw.trim()
              : '极点';
            return {
              ok: true,
              data: {
                balance,
                pointLabel,
                aiImage: {
                  used: 0,
                  limit: balance,
                  remaining: Math.floor(balance / PRICE_IMAGE),
                  price: PRICE_IMAGE,
                  canUse: aiEditEnabled,
                  trialExpired: aiEditTrialExpired,
                },
                aiRewrite: {
                  price: PRICE_REWRITE,
                  balance,
                  // 余额够不够一次调用;内容脚本据此决定默认勾选/禁用开关
                  sufficient: balance >= PRICE_REWRITE,
                },
              },
            };
          } catch (e) {
            console.warn('[getAiQuota] failed:', e.message);
            return { ok: false, error: e.message };
          }
        }
        case 'followSell': {
          const targetStoreId = message.storeId || storeId;
          const importMessage = stripInternalMessageFields(message);
          // 上架入口 → 后端 listingSettings 快照(上架记录详情展示)
          importMessage.entry = deriveImportEntry(message, sender);
          // 门户上架(灰度):message.viaPortal=true 时不走官方 API,改走 seller.ozon.ru
          // bundle 接口创建商品(绕官方 import 限流/封控)。后端只备 bundle items,
          // create/update/upload 三步在浏览器里跑。preferTabId 用发起页(www.ozon.ru)
          // 标签,走 fetchSellerPortal 的跨域快路免依赖 seller 专用标签。
          if (importMessage.viaPortal) {
            console.log(`[followSell] viaPortal: items=${importMessage.items?.length}, url=${backendUrl}/ozon/products/prepare-bundle-items`);
            const portalResult = await importViaPortal(importMessage, token, targetStoreId, backendUrl, sender?.tab?.id);
            console.log('[followSell] portal response:', JSON.stringify(portalResult).slice(0, 200));
            return { ok: true, data: portalResult };
          }
          const bodySize = JSON.stringify(importMessage).length;
          if (importMessage.dryRun) {
            console.log(`[followSell] Preview import: items=${importMessage.items?.length}, bodySize=${bodySize}, url=${backendUrl}/ozon/products/import/preview`);
            const previewResult = await apiRequest(
              'POST',
              `${backendUrl}/ozon/products/import/preview`,
              importMessage,
              token,
              targetStoreId,
              120_000,
              aiWizardDebugMeta(message, 'followSellPreview', {
                items: Array.isArray(importMessage.items) ? importMessage.items.length : undefined,
              }),
            );
            console.log('[followSell] Preview response:', JSON.stringify(previewResult).slice(0, 200));
            return { ok: true, data: previewResult };
          }
          // Backend now enqueues and returns within ~1s; AI/watermark run in the worker.
          const importTimeout = 120_000;
          console.log(`[followSell] Enqueueing import: items=${importMessage.items?.length}, bodySize=${bodySize}, aiImage=${importMessage.applyAiImage}, watermark=${importMessage.applyWatermark}, url=${backendUrl}/ozon/products/import`);
          const followSellResult = await apiRequest(
            'POST',
            `${backendUrl}/ozon/products/import`,
            importMessage,
            token,
            targetStoreId,
            importTimeout,
            aiWizardDebugMeta(message, 'followSell', {
              items: Array.isArray(importMessage.items) ? importMessage.items.length : undefined,
              stocks: Array.isArray(importMessage.stocks) ? importMessage.stocks.length : undefined,
              applyPoster: !!importMessage.applyPoster,
            }),
          );
          console.log('[followSell] Enqueue response:', JSON.stringify(followSellResult).slice(0, 200));
          return { ok: true, data: followSellResult };
        }
        case 'importFromPublic': {
          // maozi 公开商详上架(灰度 ozon_public_import):从公开买家商详页 page-json
          // 采集精简行(走买家 tab 绕反爬),回传后端服务端解析类目/属性 → 官方 import。
          // 门户无关、可跟卖任意商品;全程后端官方 API,零 cookie 模拟。
          const targetStoreId = message.storeId || storeId;
          const shopSku = String(message.sku || '').trim();
          let productPath = shopSku ? `/product/${shopSku}/` : String(message.url || '');
          try {
            const u = new URL(productPath, 'https://www.ozon.ru');
            productPath = u.pathname;
          } catch {}
          if (!productPath.startsWith('/product/')) {
            return { ok: false, error: 'sku 或 product url 必填' };
          }
          const apiUrl = `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(productPath)}`;
          const fr = await fetchOzonWwwViaTab(sender, apiUrl, 15_000);
          if (!fr.ok) {
            return { ok: false, error: fr.error || `Ozon ${fr.status}` };
          }
          const row = buildPublicListingRow(fr.data, productPath);
          if (!row.title || !row.sku) {
            return { ok: false, error: '公开页解析失败(缺 title/sku)' };
          }
          if (!row.breadcrumb?.length) {
            console.warn('[importFromPublic] 无类目面包屑,后端类目解析可能失败', row.sku);
          }
          const body = {
            rows: [row],
            applyWatermark: message.applyWatermark,
            applyAiRewrite: message.applyAiRewrite,
            watermarkTemplateId: message.watermarkTemplateId,
            stocks: message.stocks,
          };
          console.log(`[importFromPublic] sku=${row.sku} chars=${row.source_characteristics.length} crumbs=${row.breadcrumb.length} → ${backendUrl}/ozon/products/import-from-public`);
          const res = await apiRequest('POST', `${backendUrl}/ozon/products/import-from-public`, body, token, targetStoreId, 120_000);
          return { ok: true, data: res };
        }
        case 'followFromPublic': {
          // maozi v2 公开挂靠:content 传来精简变体列表(sku + 定价),SW 逐变体拉公开
          // 商详 page-json 补成**完整行**(title/图/描述/类目/属性)—— 挂靠只用 sku+价,
          // 但**源禁止复制**的变体后端要自动回退克隆,克隆需要完整内容(后端打不了公开页
          // 反爬,只能插件带过去)。全程后端官方 API、门户无关。
          const targetStoreId = message.storeId || storeId;
          const variants = Array.isArray(message.rows) ? message.rows : [];
          if (!variants.length) return { ok: false, error: 'rows 为空' };
          const rows = [];
          for (const v of variants) {
            const sku = String(v?.sku || '').trim();
            if (!sku) continue;
            const productPath = `/product/${sku}/`;
            const apiUrl = `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(productPath)}`;
            let row = null;
            try {
              const fr = await fetchOzonWwwViaTab(sender, apiUrl, 15_000);
              if (fr.ok) row = buildPublicListingRow(fr.data, productPath);
            } catch (e) {
              console.warn(`[followFromPublic] 变体 ${sku} 取数失败(仍挂靠,克隆兜底可能缺内容):`, e?.message || e);
            }
            if (!row) row = { sku };
            // 挂靠定价兜底:page 没解析出价时用枚举带来的变体价
            if (row.sell_price == null && v.sell_price != null) row.sell_price = v.sell_price;
            if (!row.currency_code && v.currency_code) row.currency_code = v.currency_code;
            rows.push(row);
          }
          if (!rows.length) return { ok: false, error: '变体取数全失败' };
          console.log(`[followFromPublic] variants=${variants.length} rows=${rows.length} → ${backendUrl}/ozon/products/follow-from-public`);
          const res = await apiRequest('POST', `${backendUrl}/ozon/products/follow-from-public`, { rows }, token, targetStoreId, 120_000);
          return { ok: true, data: res };
        }
        case 'portalImportStatus': {
          // 门户上架进度查询:用 async-upload task get-list 找到 upload_task_id 的
          // processed/failed/warned,failed>0 再拉 get-errors 拿逐 SKU 原因。
          // 形状供 content 端跟卖面板「成功 N/失败 N」回显。
          try {
            const taskId = message.taskId;
            if (!taskId) return { ok: false, error: '缺少 taskId' };
            const companyId = message.companyId || (await resolveSellerCompanyId());
            const preferTabId = sender?.tab?.id;
            const list = await getUploadTaskList(companyId, { limit: 30, page: 1 }, preferTabId);
            const task = (list?.tasks || []).find((t) => String(t.id) === String(taskId)) || null;
            let errors = [];
            const failed = Number(task?.failed || 0);
            if (task && failed > 0) {
              try {
                const errResp = await getUploadTaskErrors(companyId, taskId, { page: 1, page_size: 50 }, preferTabId);
                errors = (errResp?.task_item_errors || []).map((e) => ({
                  offer_id: e.offer_id,
                  errors: (e.errors || []).map((x) => ({
                    code: x.code, field: x.field, level: x.level,
                    message: (x.texts && x.texts.description) || x.code,
                  })),
                }));
              } catch (e) {
                console.warn('[portalImportStatus] get-errors 失败:', e?.message || e);
              }
            }
            const size = Number(task?.size || 0);
            const processed = Number(task?.processed || 0);
            const warned = Number(task?.warned || 0);
            // 任务处理完毕:processed 覆盖全部 size(failed 计入 processed)
            const done = !!task && size > 0 && processed >= size;
            return {
              ok: true,
              data: { taskId: String(taskId), found: !!task, status: task?.status || null, size, processed, failed, warned, done, errors },
            };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'listFollowSellTasks': {
          const listStoreId = message.storeId || storeId;
          const current = Math.max(1, parseInt(message.current || 1, 10) || 1);
          const pageSize = Math.max(1, Math.min(50, parseInt(message.pageSize || 10, 10) || 10));
          return {
            ok: true,
            data: await apiRequest(
              'GET',
              `${backendUrl}/ozon/products/import-by-sku/tasks?current=${current}&pageSize=${pageSize}`,
              null,
              token,
              listStoreId
            ),
          };
        }
        case 'importBySku': {
          // items: [{ sku, offer_id, price, vat, currency_code }]
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/ozon/products/import-by-sku`, { items: message.items, entry: deriveImportEntry(message, sender) }, token, storeId) };
        }
        case 'getWarehouses': {
          // backend `/ozon/warehouses` 已统一做 shape 归一化 + cache fallback
          // (warehouses.service.ts),SW 这里只透传即可。
          const whStoreId = message.storeId || storeId;
          return { ok: true, data: await apiRequest('GET', `${backendUrl}/ozon/warehouses`, null, token, whStoreId, 60_000, aiWizardDebugMeta(message, 'getWarehouses')) };
        }
        case 'getCategoryTree': {
          const lang = message.language || 'DEFAULT';
          const catTreeStoreId = message.storeId || storeId;
          return { ok: true, data: await apiRequest('GET', `${backendUrl}/ozon/categories/tree?language=${lang}`, null, token, catTreeStoreId, 60_000, aiWizardDebugMeta(message, 'getCategoryTree', { language: lang })) };
        }
        case 'getCategoryAttributes': {
          // 拉某 type(叶子类目)的属性 schema(含 is_required/dictionary_id)。
          // 只要 typeId,后端内部反查 description_category_id。
          const catStoreId = message.storeId || storeId;
          const tid = encodeURIComponent(message.typeId);
          return { ok: true, data: await apiRequest('GET', `${backendUrl}/ozon/description-category/${tid}/attributes`, null, token, catStoreId, 60_000, aiWizardDebugMeta(message, 'getCategoryAttributes', { typeId: message.typeId })) };
        }
        case 'aiOptimizeForRating': {
          // AI 满分体检/属性填充。1688 向导用 modules:["attrs"](或含 title/description)
          // + currentAttrs:[] 让 AI 填必填属性。后端跑 LLM 候选 + 字典匹配。
          const aiStoreId = message.storeId || storeId;
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/ozon/ai/optimize-for-rating`, message.body || {}, token, aiStoreId, 120_000, aiWizardDebugMeta(message, 'aiOptimizeForRating')) };
        }
        case 'suggestCategory': {
          // AI 类目建议：把 1688 标题+属性交给 LLM，输出末级类目中文名（向导本地 fuzzyMatch 落叶子）。
          const aiStoreId = message.storeId || storeId;
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/ozon/ai/suggest-category`, message.body || {}, token, aiStoreId, 60_000, aiWizardDebugMeta(message, 'suggestCategory')) };
        }
        case 'verifyCategory': {
          // 叶子复核：descent 选到叶子后,让 LLM 确认是否真适合该商品;不适合返回正确一级大类(向导据此重下钻)。
          const aiStoreId = message.storeId || storeId;
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/ozon/ai/verify-category`, message.body || {}, token, aiStoreId, 60_000, aiWizardDebugMeta(message, 'verifyCategory')) };
        }
        case 'importStock': {
          // stocks: [{ offer_id, stock, warehouse_id }]
          const stockStoreId = message.storeId || storeId;
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/ozon/stocks/import`, { items: message.stocks }, token, stockStoreId) };
        }
        case 'getImportStatus': {
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/ozon/products/import/status`, { task_id: message.taskId }, token, storeId) };
        }
        // ── 1688 AI 采集向导：采集箱条目的 AI 上架草稿（重写+类目智选+改图+定价）──
        // 三段式对应后端 collect-box/:id/ai-listing-draft 的 create→confirm→publish。
        // body 透传 DTO（targetMarginPercent / priceRub / applyPoster / applyWatermark
        // / warehouseId / offerId 等），storeId 走 x-ozon-store-id 头由 apiRequest 注入。
        case 'aiListingDraftCreate': {
          const aiStoreId = message.storeId || storeId;
          const id = encodeURIComponent(message.itemId);
          // AI 重写+改图在后端跑，给 120s 余量
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/ozon/collect-box/${id}/ai-listing-draft`, message.body || {}, token, aiStoreId, 120_000) };
        }
        case 'aiListingDraftConfirm': {
          const aiStoreId = message.storeId || storeId;
          const id = encodeURIComponent(message.itemId);
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/ozon/collect-box/${id}/ai-listing-draft/confirm`, message.body || {}, token, aiStoreId) };
        }
        case 'aiListingDraftPublish': {
          const aiStoreId = message.storeId || storeId;
          const id = encodeURIComponent(message.itemId);
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/ozon/collect-box/${id}/ai-listing-draft/publish`, message.body || {}, token, aiStoreId, 120_000) };
        }
        case 'getFxRate': {
          // CNY→RUB 实时汇率（复用「极掌算价」的 FX 缓存 jz_calc_fx_rate_v1）。
          // 给 1688 AI 采集向导按店铺货币定价用：成本是人民币，需换算成店铺货币。
          // 缓存缺失/过期则即时刷新一次。
          try {
            const cached = await new Promise((r) =>
              chrome.storage.local.get([FX_STORAGE_KEY], (d) => r(d?.[FX_STORAGE_KEY])));
            let rate = cached?.rate;
            const stale = !cached || (Date.now() - (cached.ts || 0) > FX_REFRESH_INTERVAL_MINUTES * 60 * 1000);
            if (!rate || stale) {
              const fresh = await refreshExchangeRate();
              if (fresh) rate = fresh;
            }
            return rate
              ? { ok: true, data: { rate, base: 'CNY', quote: 'RUB' } }
              : { ok: false, error: '汇率获取失败' };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'getFeatureFlags': {
          // 当前用户的灰度开关 map { flagKey: bool }。面板/向导按 flag 决定是否显示新功能。
          const ffStoreId = message.storeId || storeId;
          return { ok: true, data: await apiRequest('GET', `${backendUrl}/feature-flags/me`, null, token, ffStoreId) };
        }
        case 'getFleetServersideFlag': {
          // fleet 服务端取数灰度是否命中(走 SW 侧 5min 缓存 + single-flight,不额外
          // 打后端)。数据卡内容脚本据此放宽 variantsQueue —— fleet 路的并发由 SW
          // FLEET_MAX_INFLIGHT 闸兜底,内容脚本层为 seller-tab 老路设的 stagger
          // 在灰度命中时是纯拖慢。
          return { ok: true, data: { on: await isFleetServerSide(backendUrl, token) } };
        }
        case 'searchProductBySku': {
          // /api/v1/search 是 seller portal 跟卖列表（products/copy/list）用的接口
          // 按 SKU 精确定位 Ozon 全平台商品，返回精准 description_category_id + attributes
          // search-variant-model 只搜自家目录无果时（跟卖陌生 SKU），降级到这个
          // 注意：body 必须带 company_id，否则返 403 PermissionDenied
          const sku = message.sku;
          const senderTabId = sender?.tab?.id || null; // 优先在来源 ozon 标签内跨域直发,免依赖 seller 专用标签
          // 灰度:服务端 search(命中走俄罗斯 VPS;失败/未命中回落下面老路)
          if (await isFleetServerSide(backendUrl, token)) {
            const _fr = await callFleet(backendUrl, token, storeId, 'search', { sku });
            if (_fr) {
              const _raw = _fr.variants || _fr.items || _fr.products || [];
              return { ok: true, data: { items: _raw.map(normalizeSearchVariantToSv).filter(Boolean) } };
            }
          }
          try {
            const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
            const companyId = scCookies[0]?.value || '';
            if (!companyId) {
              return { ok: false, error: 'NO_COMPANY_ID', message: 'sc_company_id cookie 未找到，请先登录 seller.ozon.ru' };
            }
            const resp = await fetchSellerPortal(
              '/search',
              {
                company_id: companyId,
                need_total: true,
                filter: {
                  children_nodes: {
                    children_nodes: [
                      { input_leaf: { sku: { values: [String(sku)] } } },
                    ],
                    operator: 'AND',
                  },
                },
                pagination: { limit: '50' },
                is_copy_allowed: false,
              },
              { urlPrefix: '/api/v1', pageType: 'products', timeoutMs: 30000, allowOzonTab: true, preferTabId: senderTabId },
            );
            // /api/v1/search 返回字段是 `variants`，且 shape 跟 sv 不同
            // 必须 normalize 成 sv 兼容（含 attributes 数组）才能让下游 distillSource / resolveViaSearchVariantModel 直接用
            const rawVariants = Array.isArray(resp?.variants) ? resp.variants
              : Array.isArray(resp?.items) ? resp.items
              : Array.isArray(resp?.products) ? resp.products
              : Array.isArray(resp) ? resp : [];
            const items = rawVariants.map(normalizeSearchVariantToSv);
            console.log(`[searchProductBySku] sku=${sku} normalized ${items.length} variants, first.attrs=${items[0]?.attributes?.length || 0}, desc_cat=${items[0]?.description_category_id}`);
            if (items.length === 0) {
              console.log(`[searchProductBySku] raw resp:`, JSON.stringify(resp).slice(0, 600));
            }
            return { ok: true, data: { items } };
          } catch (e) {
            console.warn(`[searchProductBySku] failed:`, e.message || e);
            return { ok: false, error: 'SEARCH_FAILED', message: e.message || String(e) };
          }
        }
        case 'uploadFollowSellVideo': {
          // 把竞品 PDP 的 .mp4 转存成「卖家自有」的 Ozon 视频(ir.ozone.ru/s3)。这是唯一能让
          // Ozon 接受跟卖视频的途径 —— 主视频/封面槽只认平台链接或卖家自有 Ozon 视频,不吃任意直链。
          // 失败返回 ok:false,上游降级为不带视频、不阻断上架。调用方已有 .mp4 直链(PDP gallery)。
          try {
            const r = await transferVideoToOzon(message.srcUrl);
            if (!r.ok) return { ok: false, error: r.error, message: r.message };
            // 注意:window.sendMessage 成功时 resolve 的是 response.data,故 url 必须放进 data。
            return { ok: true, data: { url: r.url } };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'transferVariantVideo': {
          // batch-upload 逐 SKU 用:给商品 url/path,借买家 tab 抓 PDP gallery 的 .mp4,再转存成
          // 卖家自有 Ozon 视频。无视频 / 抓取失败 / 转存失败 → ok:true + url:null(best-effort,不阻断上架)。
          // 同一次 page json 顺带抽到的源富内容(11254)+ 描述(4191)+ 主题标签(23171)一并透传 ——
          // 视频开关开着时这三样零增量请求(sku-collect 据此注入 distilled / _sourceVariant)。
          try {
            const media = await fetchVariantMediaViaBuyerTab(message.url);
            const richContent = media.richContent || '';
            const description = media.description || '';
            const hashtags = Array.isArray(media.hashtags) ? media.hashtags : [];
            if (!media.mp4) return { ok: true, data: { url: null, richContent, description, hashtags } };
            const r = await transferVideoToOzon(media.mp4);
            return { ok: true, data: { url: r.ok ? r.url : null, richContent, description, hashtags } };
          } catch (e) {
            return { ok: true, data: { url: null, richContent: '', description: '', hashtags: [] } };
          }
        }
        case 'fetchVariantRichContent': {
          // batch-upload 逐 SKU 用(视频转存关闭时的源内容独立通道):借买家 tab 拉 PDP page
          // json,抽源富内容(11254)+ 描述(4191)+ 主题标签(23171),纯读不写(无 upload-file 门户请求)。
          // 抓不到 / 失败 → ok:true + 空值(best-effort,不阻断上架)。
          try {
            const media = await fetchVariantMediaViaBuyerTab(message.url);
            return { ok: true, data: { richContent: media.richContent || '', description: media.description || '', hashtags: Array.isArray(media.hashtags) ? media.hashtags : [] } };
          } catch (e) {
            return { ok: true, data: { richContent: '', description: '', hashtags: [] } };
          }
        }
        case 'searchVariants': {
          const sku = message.sku;
          const forceRefresh = Boolean(message.forceRefresh);
          // 跟卖时用户本就在 www 商品页 → 用来源标签走跨域快路,免依赖 seller 专用标签
          const senderTabId = sender?.tab?.id || null;
          // 灰度:服务端 collect(search→bundle 链式;命中走俄罗斯 VPS,失败/未命中回落老路)
          if (await isFleetServerSide(backendUrl, token)) {
            const _ck = `${_FLEET_COLLECT_CACHE_PREFIX}${String(sku)}`;
            // 本地缓存 24h(≤后端 30d,不引入更陈数据);forceRefresh 跳读不跳写,
            // 与老路 fetchBundleByVariantId 的 forceRefresh 语义一致。fleet collect
            // 数据来自机群账号(平台级、非用户店铺),key 只用 sku 即可,无串店风险。
            if (!forceRefresh) {
              const _hit = await _fleetCacheGet(_ck, _FLEET_COLLECT_CACHE_TTL_MS);
              if (_hit && _hit.sourceVariant) return { ok: true, data: { items: [_hit.sourceVariant] } };
            }
            const _fc = await callFleet(backendUrl, token, storeId, 'collect', { sku });
            if (_fc && _fc.sourceVariant) {
              // 兜底:旧版 fleet 的 mergeBundleIntoSv 只合物理属性(业务属性漏了 → 特征 0/30,
              // 实测 sku 3270906481/2720736474),但完整 bundleItem 一直随响应带回。这里本地把
              // complex_id=0 的业务属性合进 sourceVariant —— 覆盖「fleet 未重部署」和「backend
              // Redis 旧缓存」两个窗口;fleet 侧修好后 existing 去重使本段自然空转。
              const _sv = _fc.sourceVariant;
              try {
                const _bi = _fc.bundleItem;
                if (_bi && Array.isArray(_bi.attributes) && Array.isArray(_sv.attributes)) {
                  const _has = new Set(_sv.attributes.map((a) => String(a.key)));
                  for (const ba of _bi.attributes) {
                    if (ba?.complex_id && String(ba.complex_id) !== '0') continue;
                    const key = String(ba?.attribute_id || '');
                    if (!key || _has.has(key)) continue;
                    const vals = Array.isArray(ba?.values)
                      ? ba.values.filter((v) => v && v.value != null && v.value !== '')
                      : [];
                    if (vals.length === 0) continue;
                    if (vals.length > 1) {
                      _sv.attributes.push({ key, collection: vals.map((v) => String(v.value)) });
                    } else {
                      _sv.attributes.push({ key, value: String(vals[0].value) });
                    }
                    _has.add(key);
                  }
                }
              } catch (e) {
                console.warn('[searchVariants] fleet bundleItem 属性兜底合并失败(忽略):', e?.message || e);
              }
              // 只缓存完整包:残包(缺 bundleItem → 没有重量/尺寸/完整属性包,后端仅
              // 600s 短缓存等重试补全)写本地会钉死 24h;失败/null 更不写(PR#332 红线)。
              // 缓存放在业务属性合并之后 —— _sv === _fc.sourceVariant 同引用,存进去的已是
              // 富化后的 sv,读缓存命中路径(上面 _hit.sourceVariant 直接返回)无需再合。
              if (_fc.bundleItem) _fleetCacheSet(_ck, _fc);
              return { ok: true, data: { items: [_sv] } };
            }
          }
          // 2026-05 Ozon 把 /api/v1/search-variant-model endpoint 下线(实测所有
          // SKU/参数都返 404 ResourceNotFound)。新流程是 /api/v1/search 拿元数据
          // + /api/site/seller-prototype/create-bundle-by-variant-id 补完整 attributes:
          //
          // Step 1: /api/v1/search filter sku.values 拿 variants[0].variant_id
          //         (URL 数字 SKU 与 variant_id 不同 namespace,必须先转换)
          // Step 2: /api/site/seller-prototype/create-bundle-by-variant-id 拿 item
          //         含 weight/depth/width/height(物理) + barcode + 40-63 个 attributes
          // Step 3: 把 item.weight/depth/width/height 以 sv attr key 形式
          //         (4497/9454/9455/9456)push 进 items[0].attributes,
          //         让下游 distillSource / resolveViaSearchVariantModel /
          //         jzMergeCardPanelData 等所有 caller 无感升级 — 它们的代码不动
          //
          // 副作用:bundle endpoint 每次创建 draft bundle_id。fetchBundleByVariantId
          // 内部用 chrome.storage.local 24h cache(下调自 30d,牺牲少量 draft 增长换取
          // 源商品改类目/属性时及时刷新);传 message.forceRefresh=true 可绕过 cache 立即重拉。
          //
          // NOT_IN_OWN_CATALOG label 保留以兼容 caller 的 errorCode 检查,语义
          // 现在变成 SKU_NOT_FOUND_ON_PLATFORM(/search 对找不到的 SKU 通常返 200
          // + 空 variants,而不是 404,所以这分支实际很少触发)。
          const classifyError = (e) => {
            const msg = e.message || String(e);
            const status = typeof e.status === 'number' ? e.status : null;
            const code = typeof e.code === 'string' ? e.code : null;
            let errorCode = 'UNKNOWN_ERROR';
            if (status === 404 && code === 'ResourceNotFound') {
              errorCode = 'NOT_IN_OWN_CATALOG';
            } else if (msg.includes('请先打开') || msg.includes('No seller tab')) {
              errorCode = 'NO_SELLER_TAB';
            } else if (msg.includes('Cannot access contents') || msg.includes('permission to access')) {
              errorCode = 'PERMISSION_DENIED';
            } else if (status === 401 || code === 'AUTH_REDIRECT' || msg.includes('sc_company_id') || msg.includes('过期') || msg.includes('登录') || msg.includes('signin') || msg.includes('login')) {
              errorCode = 'AUTH_REQUIRED';
            } else if (status === 403 || msg.includes('403')) {
              // 403 细分:Ozon 反爬挑战是 HTML 页;而 company_id 失效 / 会话过期 / 账号无权限的
              // PermissionDenied 是结构化 JSON。早期一律当反爬 → 误冷却 10min + 误导用户"换网络"
              // (实际该重登 / 重选店)。按 body 形状分流:仅当明确是结构化 JSON 权限/会话错时改判
              // AUTH_REQUIRED;HTML 挑战页 / 裸 403 无线索仍按反爬(保留熔断保护,宁可多冷却不要猛打)。
              const blob = `${code || ''} ${msg}`.toLowerCase();
              const looksHtmlChallenge = /<html|<!doctype|just a moment|attention required|enable javascript|are you a robot|вы не робот|captcha|challenge|too many requests/.test(blob);
              const looksStructuredApiError = /"code"|"message"|permission_?denied|company_?id|sc_company|unauthenticated|invalid.?token|session/.test(blob);
              errorCode = (looksStructuredApiError && !looksHtmlChallenge) ? 'AUTH_REQUIRED' : 'ANTIBOT_BLOCKED';
            } else if (msg.includes('超时') || msg.includes('timeout') || msg.includes('AbortError') || msg.includes('Timeout')) {
              errorCode = 'TIMEOUT';
            } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('network')) {
              errorCode = 'NETWORK_ERROR';
            }
            return { errorCode, msg };
          };

          // /search 必须 body 带 company_id(否则 403 PermissionDenied)
          const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
          const companyId = scCookies[0]?.value || '';
          if (!companyId) {
            // 本机没登卖家端 → 透明回退:派给同租户已登录设备代采。message.noProxy
            // 由代采执行端(agent action)设置,杜绝"代采里再触发代采"的递归。
            if (!message.noProxy) {
              const proxied = await proxyCollectVariant(backendUrl, token, storeId, sku);
              if (proxied) return proxied;
            }
            return { ok: false, error: 'AUTH_REQUIRED', message: 'sc_company_id cookie 未找到，请先登录 seller.ozon.ru' };
          }

          const MAX_RETRIES = 2;
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              const resp = await fetchSellerPortal(
                '/search',
                {
                  company_id: companyId,
                  need_total: true,
                  filter: {
                    children_nodes: {
                      children_nodes: [
                        { input_leaf: { sku: { values: [String(sku)] } } },
                      ],
                      operator: 'AND',
                    },
                  },
                  pagination: { limit: '50' },
                  is_copy_allowed: false,
                },
                { urlPrefix: '/api/v1', pageType: 'products', timeoutMs: 30000, allowOzonTab: true, preferTabId: senderTabId },
              );
              const rawVariants = Array.isArray(resp?.variants) ? resp.variants
                : Array.isArray(resp?.items) ? resp.items
                : Array.isArray(resp?.products) ? resp.products
                : Array.isArray(resp) ? resp : [];
              const items = rawVariants.map(normalizeSearchVariantToSv).filter(Boolean);
              if (items.length === 0) {
                if (attempt === 1) {
                  console.log(`[searchVariants] sku=${sku} no variants from /search, raw:`, JSON.stringify(resp).slice(0, 400));
                }
                return { ok: true, data: { items: [] } };
              }

              // Step 2: bundle 补完整 attributes(物理 + 含 40-63 个完整 attr)
              // 失败不致命 — items 已有基础元数据(品牌/类目/GTIN/图片),caller 仍可用,
              // 只是 4497/9454-9456 物理 attr 缺失 → 数据卡片重量·尺寸退化为公开兜底。
              try {
                const variantId = items[0].variant_id;
                if (variantId) {
                  const bundleItem = await fetchBundleByVariantId(sku, variantId, companyId, { forceRefresh, preferTabId: senderTabId });
                  if (bundleItem) {
                    if (!Array.isArray(bundleItem.attributes) || bundleItem.attributes.length === 0) {
                      // 只有物理字段、没有业务属性 → 下游批量上架的特征属性(材料/尺寸/配套…)会缺失,
                      // 内容评分「特征」0 分。留痕便于区分「源本就没属性」vs「取数降级」。
                      console.warn(`[searchVariants] bundle attributes EMPTY for sku=${sku} — 特征属性无法随上架带出(仅物理字段)`);
                    }
                    const existingKeys = new Set(items[0].attributes.map((a) => String(a.key)));
                    const physicalAttrs = [];
                    if (Number(bundleItem.weight) > 0 && !existingKeys.has('4497')) {
                      physicalAttrs.push({ key: '4497', value: String(bundleItem.weight) });
                    }
                    if (Number(bundleItem.depth) > 0 && !existingKeys.has('9454')) {
                      physicalAttrs.push({ key: '9454', value: String(bundleItem.depth) });
                    }
                    if (Number(bundleItem.width) > 0 && !existingKeys.has('9455')) {
                      physicalAttrs.push({ key: '9455', value: String(bundleItem.width) });
                    }
                    if (Number(bundleItem.height) > 0 && !existingKeys.has('9456')) {
                      physicalAttrs.push({ key: '9456', value: String(bundleItem.height) });
                    }
                    if (bundleItem.barcode && !existingKeys.has('7822')) {
                      physicalAttrs.push({ key: '7822', value: String(bundleItem.barcode) });
                    }
                    // bundle.attributes shape: { attribute_id, values:[{value, dictionary_value_id}], complex_id }
                    // 简单 attr(complex_id=0)转成 sv 兼容 { key, value | collection } 让 backend
                    // resolveViaSearchVariantModel 的 sourceAttrMap 能 hit 到类目业务 attr(刷子类型/季卡/材质/...)。
                    // complex attr(complex_id>0,即视频/PDF)单独收集成 _bundleComplexAttrs,follow-sell
                    // 据此重建 import 的 complex_attributes(带上原 SKU 视频)。bundle 是 Ozon 自家"复制商品"
                    // API,返回的视频 URL 本就给 import 重新消费用,不是页面播放器的 m3u8 临时签名地址。
                    const bundleComplexAttrs = [];
                    if (Array.isArray(bundleItem.attributes)) {
                      for (const ba of bundleItem.attributes) {
                        if (ba.complex_id && String(ba.complex_id) !== '0') {
                          bundleComplexAttrs.push(ba);
                          continue;
                        }
                        const key = String(ba.attribute_id || '');
                        if (!key || existingKeys.has(key)) continue;
                        const vals = Array.isArray(ba.values) ? ba.values.filter(v => v && v.value != null && v.value !== '') : [];
                        if (vals.length === 0) continue;
                        if (vals.length > 1) {
                          physicalAttrs.push({ key, collection: vals.map(v => String(v.value)) });
                        } else {
                          physicalAttrs.push({ key, value: String(vals[0].value) });
                        }
                        existingKeys.add(key);
                      }
                    }
                    if (physicalAttrs.length > 0) {
                      items[0] = { ...items[0], attributes: [...items[0].attributes, ...physicalAttrs] };
                    }
                    if (bundleComplexAttrs.length > 0) {
                      items[0]._bundleComplexAttrs = bundleComplexAttrs;
                      console.log(`[searchVariants] bundle complex attrs (视频/PDF): ${bundleComplexAttrs.length} for sku=${sku}`);
                    }
                    // 完整 bundle item 也挂上(供高级 caller — 如 follow-sell 拿全 40-63 个 attr)
                    items[0]._bundleItem = bundleItem;
                  }
                }
              } catch (e) {
                console.warn(`[searchVariants] bundle injection failed for sku=${sku}:`, e.message || e);
              }

              return { ok: true, data: { items } };
            } catch (e) {
              const { errorCode, msg } = classifyError(e);
              // 业务空结果(罕见 — /search 通常返 200 + 空 variants):立即降级
              if (errorCode === 'NOT_IN_OWN_CATALOG') {
                console.log(`[searchVariants] sku=${sku} not found on platform (404) — returning empty items`);
                return { ok: true, data: { items: [] } };
              }
              console.warn(`[searchVariants] attempt ${attempt}/${MAX_RETRIES} failed [${errorCode}]:`, msg, e);
              const isRetryable = ['TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN_ERROR'].includes(errorCode);
              if (attempt >= MAX_RETRIES || !isRetryable) {
                return { ok: false, error: errorCode, message: msg };
              }
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        }
        case 'fetchBestsellers': {
          // 拉 Ozon 官方 Bestsellers (what_to_sell/data/v3) 并转交给后端入库
          const period = message.period || 'weekly'; // weekly | monthly
          const sortKey = message.sortKey || 'sum_gmv_desc';
          const limit = String(message.limit || 50);
          const offset = String(message.offset || 0);
          const categories = Array.isArray(message.categories) ? message.categories : [];
          try {
            const data = await fetchSellerPortal(
              '/site/seller-analytics/what_to_sell/data/v3',
              {
                limit,
                offset,
                filter: { stock: 'any_stock', period, categories },
                sort: { key: sortKey },
              },
              { urlPrefix: '/api', pageType: 'analytics_platform', timeoutMs: 30000 },
            );
            const items = Array.isArray(data?.items) ? data.items : [];
            // 同步到后端按日存档（前端日常查后端快照）
            if (items.length > 0 && token && storeId) {
              try {
                await apiRequest(
                  'POST',
                  `${backendUrl}/ozon/selection/bestsellers/snapshot`,
                  { period, items },
                  token,
                  storeId,
                );
              } catch (e) {
                console.warn('[fetchBestsellers] backend ingest failed:', e?.message || e);
              }
            }
            return {
              ok: true,
              data: {
                items,
                totals: data?.totals,
                updateDate: data?.updateDate,
                benchmark: data?.benchmark,
              },
            };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'fetchOzonPublicProduct': {
          // 按 SKU 抓 ozon.ru 公开商品页，提炼 pageProduct（name/images/breadcrumbs/brand/weight/dims）。
          // Ozon 反爬会 ban 掉 service-worker 直 fetch（缺浏览器指纹），所以**优先**
          // 在 www.ozon.ru tab 内 executeScript 注入 fetch（同 fetchSellerPortal 套路），
          // 找不到 tab 才 fall back 到 service-worker 直 fetch（大概率被反爬拦）。
          try {
            const sku = String(message.sku || '').trim();
            if (!/^\d{6,16}$/.test(sku)) return { ok: false, error: 'invalid sku' };

            // 在页面上下文跑的 fetch + 解析（大字符串注入 executeScript），返回标准化数据
            // URL 用相对路径,自动适配当前 tab 是 www.ozon.ru 还是 ozon.kz (同 origin)。
            const inPageFetcher = async (sku) => {
              const path = `/product/${sku}`;
              const endpoints = [
                `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
                `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
              ];
              const upgrade = (u) =>
                typeof u === 'string' && u.includes('ir.ozone.ru')
                  ? u.replace(/\/wc\d+\//, '/wc1000/')
                  : u;
              for (const url of endpoints) {
                try {
                  const resp = await fetch(url, {
                    credentials: 'include',
                    headers: { 'x-o3-app-name': 'dweb_client', 'accept': 'application/json' },
                  });
                  if (!resp.ok) continue;
                  const data = await resp.json();
                  const states = data && data.widgetStates ? data.widgetStates : {};
                  if (Object.keys(states).length === 0) continue;

                  let name = null;
                  let titleFromHeading = null;
                  const allImages = [];
                  const seenImg = new Set();
                  let coverImage = null;
                  let breadcrumbs = [];
                  let brand = null;
                  let weight = null;
                  const dims = {};

                  const pushImg = (raw) => {
                    if (!raw) return;
                    const upgraded = upgrade(raw);
                    if (!upgraded) return;
                    const norm = String(upgraded).split('?')[0].split('#')[0].toLowerCase();
                    if (seenImg.has(norm)) return;
                    seenImg.add(norm);
                    allImages.push(upgraded);
                  };

                  for (const k of Object.keys(states)) {
                    let v = states[k];
                    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { continue; } }
                    if (!v || typeof v !== 'object') continue;
                    const kLower = k.toLowerCase();
                    if (!titleFromHeading && kLower.indexOf('heading') !== -1 && typeof v.title === 'string' && v.title.length > 3) {
                      titleFromHeading = v.title.trim();
                    }
                    if (!name && typeof v.title === 'string' && v.title.length > 3) name = v.title.trim();
                    if (!name && typeof v.name === 'string' && v.name.length > 3) name = v.name.trim();
                    if (!coverImage && typeof v.coverImage === 'string') coverImage = v.coverImage;
                    if (Array.isArray(v.images)) {
                      for (const img of v.images) {
                        const u = typeof img === 'string' ? img : (img && (img.src || img.url || img.image));
                        if (u) pushImg(u);
                      }
                    }
                    if (Array.isArray(v.breadcrumbs) && v.breadcrumbs.length > breadcrumbs.length) {
                      breadcrumbs = v.breadcrumbs.map((b) => (b && (b.text || b.title || b.name)) || '').filter(Boolean);
                    }
                    if (!brand && typeof v.brand === 'string') brand = v.brand;
                    if (Array.isArray(v.characteristics)) {
                      for (const c of v.characteristics) {
                        const cName = String((c && (c.name || c.title)) || '').toLowerCase();
                        const cValRaw = String((c && (c.value || (c.values && c.values[0] && c.values[0].text))) || '');
                        const m = cValRaw.match(/[\d.]+/);
                        const num = m ? parseFloat(m[0]) : null;
                        if (!num) continue;
                        if (cName.indexOf('вес') !== -1 || cName.indexOf('weight') !== -1) {
                          const isKg = cValRaw.toLowerCase().indexOf('кг') !== -1 || cValRaw.toLowerCase().indexOf('kg') !== -1;
                          weight = weight || (isKg ? Math.round(num * 1000) : Math.round(num));
                        } else if (cName.indexOf('длина') !== -1 || cName.indexOf('length') !== -1 || cName.indexOf('depth') !== -1) {
                          const isCm = cValRaw.toLowerCase().indexOf('см') !== -1 || cValRaw.toLowerCase().indexOf('cm') !== -1;
                          dims.depth = dims.depth || (isCm ? Math.round(num * 10) : Math.round(num));
                        } else if (cName.indexOf('ширина') !== -1 || cName.indexOf('width') !== -1) {
                          const isCm = cValRaw.toLowerCase().indexOf('см') !== -1 || cValRaw.toLowerCase().indexOf('cm') !== -1;
                          dims.width = dims.width || (isCm ? Math.round(num * 10) : Math.round(num));
                        } else if (cName.indexOf('высота') !== -1 || cName.indexOf('height') !== -1) {
                          const isCm = cValRaw.toLowerCase().indexOf('см') !== -1 || cValRaw.toLowerCase().indexOf('cm') !== -1;
                          dims.height = dims.height || (isCm ? Math.round(num * 10) : Math.round(num));
                        }
                      }
                    }
                  }

                  const finalName = titleFromHeading || name;
                  if (coverImage) {
                    const filtered = allImages.filter((u) => u !== coverImage);
                    filtered.unshift(coverImage);
                    allImages.length = 0;
                    Array.prototype.push.apply(allImages, filtered);
                  }
                  if (!finalName && allImages.length === 0) {
                    return { ok: false, error: '页面解析失败：name + images 都为空' };
                  }
                  return {
                    ok: true,
                    data: {
                      sku,
                      name: finalName,
                      images: allImages,
                      breadcrumbs,
                      brand,
                      weight,
                      depth: dims.depth || null,
                      width: dims.width || null,
                      height: dims.height || null,
                    },
                  };
                } catch (e) {
                  // try next endpoint
                }
              }
              return { ok: false, error: '所有公开端点都失败' };
            };

            // 1) 优先：在已打开的 ozon.ru / ozon.kz tab 内 page-context 跑 fetch
            const ozonTabs = await chrome.tabs.query({
              url: [
                'https://www.ozon.ru/*',
                'https://*.ozon.ru/*',
                'https://ozon.kz/*',
                'https://*.ozon.kz/*',
              ],
            });
            // 排除 seller.* (反爬信任域不是这个;且 seller portal 走另一条路径)
            const target = ozonTabs.find(
              (t) => t.url && /^https:\/\/(www\.ozon\.ru|ozon\.kz|www\.ozon\.kz)\//.test(t.url),
            );
            if (target?.id) {
              try {
                const results = await chrome.scripting.executeScript({
                  target: { tabId: target.id },
                  func: inPageFetcher,
                  args: [sku],
                  world: 'MAIN',
                });
                const r = results?.[0]?.result;
                if (r) return r;
              } catch (e) {
                console.warn('[fetchOzonPublicProduct] in-tab executeScript failed:', e?.message);
              }
            }

            // 2) 没 tab / executeScript 失败 → 引导用户打开 ozon 页面
            if (!target) {
              return {
                ok: false,
                error: 'NO_OZON_TAB',
                message: '请先在浏览器打开任意 ozon.ru 或 ozon.kz 页面（保持后台打开即可），让扩展能借用页面上下文抓数据',
              };
            }

            // 3) Fallback：service-worker 直 fetch（大概率反爬，但作为最后兜底）
            try {
              const r = await inPageFetcher(sku);
              return r;
            } catch (e) {
              return { ok: false, error: e?.message || '反爬拦截' };
            }
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'proxyImageFetch': {
          // 由 1688 content script 调用：在 background 代为 fetch ozon CDN 图片，
          // 避开页面 CORS（host_permissions 已含 *.ozon.ru / *.ozonusercontent.com）。
          // 返回 base64 dataURL，content script 转 blob/File 注入 1688 file input。
          try {
            const url = String(message.url || '');
            if (!/^https?:\/\//.test(url)) return { ok: false, error: 'invalid url' };
            const r = await fetch(url, { method: 'GET' });
            if (!r.ok) return { ok: false, error: `${r.status}` };
            const blob = await r.blob();
            const dataUrl = await new Promise((resolve, reject) => {
              const fr = new FileReader();
              fr.onload = () => resolve(fr.result);
              fr.onerror = () => reject(fr.error);
              fr.readAsDataURL(blob);
            });
            return { ok: true, dataUrl };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'reportCategoryMapping': {
          // 由 ozon-bestsellers-hook 在 seller.ozon.ru 上学到的 (一级类目名 → leaf IDs[])
          // 转发上报到极掌后端入库。失败仅 console，不阻塞任何用户操作。
          try {
            if (!token || !storeId) return { ok: false, error: 'no auth' };
            const { name, leafIds, source } = message;
            if (!name || !Array.isArray(leafIds) || leafIds.length === 0) {
              return { ok: false, error: 'invalid payload' };
            }
            await apiRequest(
              'POST',
              `${backendUrl}/ozon/selection/category-mapping`,
              { name, leafIds, source: source || null },
              token,
              storeId,
            );
            return { ok: true };
          } catch (e) {
            console.warn('[reportCategoryMapping] failed:', e?.message || e);
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'syncSellerCookies': {
          // Three-way query to cover all possible cookie storage locations
          const [byName, byUrl, byDomain] = await Promise.all([
            chrome.cookies.getAll({ name: "sc_company_id" }),
            chrome.cookies.getAll({ url: "https://seller.ozon.ru/app/dashboard/main" }),
            chrome.cookies.getAll({ domain: ".ozon.ru" }),
          ]);
          // Deduplicate by name+domain
          const seen = new Set();
          const sellerCookies = [];
          for (const c of [...byUrl, ...byDomain]) {
            const key = `${c.name}@${c.domain}`;
            if (!seen.has(key)) { seen.add(key); sellerCookies.push(c); }
          }

          if (!sellerCookies.length && !byName.length) {
            return { ok: false, error: '未检测到 Ozon 登录状态，请先在浏览器中登录 seller.ozon.ru' };
          }

          // Include byName results in cookie string if not already present
          for (const c of byName) {
            const key = `${c.name}@${c.domain}`;
            if (!seen.has(key)) { seen.add(key); sellerCookies.push(c); }
          }

          const cookieStr = sellerCookies.map(c => `${c.name}=${c.value}`).join('; ');
          // SECURITY: never log cookie *values* — they're bearer credentials for
          // seller.ozon.ru. Names + counts are enough to debug sync issues.
          console.log('[syncSellerCookies] cookie names:', sellerCookies.map(c => c.name).join(', '));
          console.log('[syncSellerCookies] cookie count:', sellerCookies.length);
          // Prefer name-based query (most reliable), fallback to merged list
          const companyIdCookie = byName[0] || sellerCookies.find(c => c.name === 'sc_company_id');
          const scCompanyId = companyIdCookie?.value || null;

          if (!scCompanyId) {
            return { ok: false, error: '未找到 sc_company_id，请确认已登录 Ozon 卖家中心' };
          }

          if (!storeId) {
            return { ok: false, error: '请先选择店铺' };
          }

          await apiRequest('PATCH', `${backendUrl}/auth/ozon-stores/${storeId}`, {
            cookieAuth: { cookies: cookieStr, sc_company_id: scCompanyId, userAgent: navigator.userAgent },
          }, token, storeId);

          return { ok: true, data: { sc_company_id: scCompanyId, cookie_count: sellerCookies.length } };
        }
        case 'checkSellerCookies': {
          const [byName, byUrl, byDomain] = await Promise.all([
            chrome.cookies.getAll({ name: "sc_company_id" }),
            chrome.cookies.getAll({ url: "https://seller.ozon.ru/app/dashboard/main" }),
            chrome.cookies.getAll({ domain: ".ozon.ru" }),
          ]);
          const allCookies = [...byUrl, ...byDomain];
          const companyId = byName[0] || allCookies.find(c => c.name === 'sc_company_id');
          return {
            ok: true,
            data: {
              has_cookies: allCookies.length > 0 || byName.length > 0,
              cookie_count: allCookies.length,
              sc_company_id: companyId?.value || null,
              userAgent: navigator.userAgent,
            },
          };
        }
        case 'translateKeywords': {
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/ozon/extension/translate`, { texts: message.texts, from: message.from || 'ru', to: message.to || 'zh' }, token, storeId) };
        }
        case 'aiOptimize': {
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/ozon/extension/ai-optimize`, { title: message.title, description: message.description, category: message.category, keywords: message.keywords }, token, storeId) };
        }
        case 'getRecommendations': {
          const type = message.type || 'hot';
          let sortBy = type === 'blue' ? 'views' : 'sold_count';
          const resp = await apiRequest('GET', `${backendUrl}/ozon/products/cache?currentPage=1&pageSize=20&sortBy=${sortBy}&sortOrder=desc`, null, token, storeId);
          return { ok: true, data: { products: resp.data || [] } };
        }
        case 'getCollectCount': {
          return { ok: true, data: await apiRequest('GET', `${backendUrl}/ozon/collect-box?currentPage=1&pageSize=1`, null, token, storeId) };
        }
        case 'getProductStatusCounts': {
          return { ok: true, data: await apiRequest('GET', `${backendUrl}/ozon/products/cache/status-counts`, null, token, storeId) };
        }
        case 'getFavCount': {
          return { ok: true, data: await apiRequest('GET', `${backendUrl}/ozon/favorites?currentPage=1&pageSize=1`, null, token, storeId) };
        }
        case 'getStores': {
          return { ok: true, data: await apiRequest('GET', `${backendUrl}/auth/ozon-stores`, null, token, storeId) };
        }
        case 'getCaptcha': {
          return { ok: true, data: await apiRequest('GET', `${backendUrl}/auth/captcha`, null, null, null) };
        }
        case 'sendSmsCode': {
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/auth/send-code`, { phoneNumber: message.phoneNumber, captchaId: message.captchaId, captchaCode: message.captchaCode }, null, null) };
        }
        case 'setMachineFingerprint': {
          // content script / popup / sync-auth 启动时主动推 v3 fingerprint 给 SW,
          // SW 缓存到 chrome.storage.local。后续 SW 自身的 heartbeat/login 等动作
          // 直接用这份「真·机器级」fingerprint,跟 web/popup 算出来的完全一致,
          // 解决"同台机器算成两台占两个名额"的问题。
          // SW 自己没 DOM,算不出 screen 维度;让任何有 DOM 的入口推过来就够了。
          const fp = String(message.deviceFingerprint || '').trim();
          if (!fp || !/^machine-v[23]-[a-z0-9-]+$/i.test(fp)) {
            return { ok: false, error: 'invalid fingerprint' };
          }
          try {
            await setStorage({ [STORAGE_KEYS.deviceFingerprintV3]: fp });
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message };
          }
        }
        case 'loginSms': {
          const fp = await getExtensionFingerprint(message.deviceFingerprint);
          // /auth/login 旧短信登录已被后端禁用 (auth.controller.ts:82),
          // 新路径 /auth/sms/verify body shape 兼容 (phoneNumber/code/deviceFingerprint/platform)。
          // 返回 shape (auth.service.ts:2784):
          //   单身份:{ accessToken, user }          ← P9 后是 camelCase,不再是 access_token
          //   多身份:{ sessionToken, identities }   ← popup 没有 UI 选择,引导走网页端
          // popup.js 三个字段兜底 (accessToken / access_token / token),保证 backend
          // shape 漂移不会再让登录挂死。
          // portalHost(2026-06-11 串号修复):SW 直调 api.* 时,后端 extractHost 的
          // Origin 是 chrome-extension:// 被跳过 → host 落 api.* → 一律判平台直营,
          // 分销商定制版用户在 popup 登录会被自注册进平台直营空账号(实锤:时渡
          // [REDACTED PERSONAL INFORMATION]
          // store.jizhangerp.com)随 body 显式声明登录门户,后端优先用它解析
          // distributorId。dev 源码加载无 brand 注入 → undefined → 后端走原 host
          // 链路,行为不变。
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/auth/sms/verify`, { phoneNumber: message.phoneNumber, code: message.code, deviceFingerprint: fp, platform: 'extension', portalHost: jzBrandPortalHost() }, null, null) };
        }
        case 'loginPassword': {
          const fp = await getExtensionFingerprint(message.deviceFingerprint);
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/auth/login-password`, { phoneNumber: message.phoneNumber, password: message.password, captchaId: message.captchaId, captchaCode: message.captchaCode, deviceFingerprint: fp, platform: 'extension', portalHost: jzBrandPortalHost() }, null, null) };
        }
        case 'login': {
          const fp = await getExtensionFingerprint(message.deviceFingerprint);
          return { ok: true, data: await apiRequest('POST', `${backendUrl}/auth/login-password`, { phoneNumber: message.phone, password: message.password, deviceFingerprint: fp, platform: 'extension', portalHost: jzBrandPortalHost() }, null, null) };
        }
        case 'getUpdateInfo': {
          const stored = await getStorage([
            STORAGE_KEYS.latestVersion,
            STORAGE_KEYS.latestDownloadUrl,
            STORAGE_KEYS.updateDismissedVersion,
          ]);
          const latestVersion = stored[STORAGE_KEYS.latestVersion];
          const downloadUrl = stored[STORAGE_KEYS.latestDownloadUrl];
          const dismissedVersion = stored[STORAGE_KEYS.updateDismissedVersion];
          const currentVersion = getCurrentVersion();
          const hasUpdate = latestVersion && compareVersions(latestVersion, currentVersion) > 0 && latestVersion !== dismissedVersion;
          return { ok: true, data: { hasUpdate, currentVersion, latestVersion, downloadUrl } };
        }
        case 'checkUpdate': {
          await checkForUpdate();
          const info = await getStorage([STORAGE_KEYS.latestVersion, STORAGE_KEYS.latestDownloadUrl]);
          const curVer = getCurrentVersion();
          const newVer = info[STORAGE_KEYS.latestVersion];
          const dlUrl = info[STORAGE_KEYS.latestDownloadUrl];
          const isNew = newVer && compareVersions(newVer, curVer) > 0;
          return { ok: true, data: { hasUpdate: isNew, currentVersion: curVer, latestVersion: newVer, downloadUrl: dlUrl } };
        }
        case 'dismissUpdate': {
          const verToDismiss = message.version;
          if (verToDismiss) {
            await setStorage({ [STORAGE_KEYS.updateDismissedVersion]: verToDismiss });
            chrome.action.setBadgeText({ text: '' });
          }
          return { ok: true };
        }
        default:
          return { ok: false, error: '未知消息类型' };
      }
    };

    // Keep service worker alive during operations that may exceed Chrome MV3
    // SW idle timeout (~30s). 用 chrome.runtime.getPlatformInfo() 周期 ping 续命。
    //
    // 之前只覆盖 followSell / importBySku — 实测 fetchProductPageState /
    // searchVariants / pushSourceCollect 也可能因为 chrome.scripting.executeScript
    // 注入 MAIN world 卡 30s+(Ozon 2026 page main world race condition),
    // SW 被 unload → handle() promise 中断 → sendResponse 永不调 →
    // content_script 等 60s 超时。把这几个 action 也加进保活列表。
    let keepAliveTimer = null;
    // 注:expandModelVariants 在 2aaa415 之后已不在 SW 实现(改 content-side SSR HTML fetch),
    // fetchSellerSiblings 在 c6f9925 整个 handler 删了,均无需在 KEEP_ALIVE_ACTIONS 列出。
    const KEEP_ALIVE_ACTIONS = new Set([
      'followSell',
      'importBySku',
      'fetchProductPageState',
      'searchVariants',
      'pushSourceCollect',
      // 视频转存:download(跨源 .mp4) + media-storage 上传跑在 seller/buyer tab,executeScript
      // 可达 90s+,必须保活防 SW unload 中断 sendResponse。
      'uploadFollowSellVideo',
      'transferVariantVideo',
    ]);
    const AI_WIZARD_LONG_ACTIONS = new Set([
      'aiOptimizeForRating',
      'suggestCategory',
      'verifyCategory',
      'getCategoryTree',
      'getCategoryAttributes',
      'pushSourceCollect',
      'updateCollectBoxItem',
      'followSell',
    ]);
    if (KEEP_ALIVE_ACTIONS.has(message?.action) || AI_WIZARD_LONG_ACTIONS.has(message?.action)) {
      chrome.runtime.getPlatformInfo(() => {});
      keepAliveTimer = setInterval(() => {
        chrome.runtime.getPlatformInfo(() => {});
      }, 15_000);
    }

    // Handler 顶层 race timeout — 防止内部 await 永不返(executeScript hang /
    // promise leak)导致 handle() 永远 pending,sendResponse 永不调,content 等死。
    // 默认 50s(留 10s buffer 给 content wrapper 的 60s)。视频转存例外:download 跨源 .mp4 +
    // media-storage 上传跑在 seller/buyer tab,executeScript 内部就排到 90s+(transferVariantVideo
    // 还叠加买家 tab 抓图册 40s),50s 会把**正常但慢**的转存误杀。给它们 160s 上限,并配合
    // content LONG_ACTIONS 把这俩 action 的 content 侧超时也放宽到 600s。
    const VIDEO_ACTIONS = new Set(['uploadFollowSellVideo', 'transferVariantVideo']);
    const HANDLER_TOTAL_TIMEOUT_MS = VIDEO_ACTIONS.has(message?.action)
      ? 160_000
      : (AI_WIZARD_LONG_ACTIONS.has(message?.action) ? 150_000 : 50_000);
    const handlerPromise = Promise.race([
      handle(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`SW handler ${message?.action} 总超时 (${HANDLER_TOTAL_TIMEOUT_MS / 1000}s)`)),
          HANDLER_TOTAL_TIMEOUT_MS,
        ),
      ),
    ]);

    handlerPromise
      .then((result) => {
        console.log(`[SW] sendResponse OK for action=${message?.action}`, JSON.stringify(result).slice(0, 150));
        sendResponse(result);
      })
      .catch((error) => {
        console.error(`[SW] sendResponse ERROR for action=${message?.action}`, error.message);
        sendResponse({ ok: false, error: error.message || '请求失败' });
      })
      .finally(() => {
        if (keepAliveTimer) clearInterval(keepAliveTimer);
      });

    return true;
  });
})();
