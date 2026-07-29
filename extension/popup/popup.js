(() => {
  // dev 直接加载源码时 build.js 没跑,brand 占位符保持字面量 → 运行时兜底成平台默认。
  // 用 /__BRAND/ 探测而不写全占位符:build 的 textual replace 会把出现的全占位符全换掉,
  // 若把探测串也写全,分销商 build 会被错误兜底成平台默认(store.jizhangerp.com / sonli)。
  const _brandFallback = (val, fb) => (/__BRAND/.test(val) ? fb : val);
  const BRAND_WEB_HOST = _brandFallback("qh.jizhangerp.com", "store.jizhangerp.com");
  const BRAND_DISPLAY_NAME = _brandFallback("sonli", "sonli");
  const LOCAL_FRONTEND_BASE_URL = "http://127.0.0.1:3000";
  const isLocalBackendUrl = (value) => /^http:\/\/127\.0\.0\.1:3000\/api\b/.test(String(value || ""));

  // popup.html 里的 brand 静态占位符(标题/logo/按钮文案)在 dev 源码
  // 加载时不会被 build 替换 → 运行时扫一遍文本节点 + title + img[alt] 兜底替换。
  const applyBrandToDom = () => {
    const PH = "__BRAND" + "_DISPLAY_NAME__"; // 拆写,避免被 build textual replace 命中
    if (document.title.includes(PH)) {
      document.title = document.title.split(PH).join(BRAND_DISPLAY_NAME);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((n) => {
      if (n.nodeValue && n.nodeValue.includes(PH)) {
        n.nodeValue = n.nodeValue.split(PH).join(BRAND_DISPLAY_NAME);
      }
    });
    document.querySelectorAll("img[alt]").forEach((img) => {
      if (img.alt.includes(PH)) img.alt = img.alt.split(PH).join(BRAND_DISPLAY_NAME);
    });
  };
  applyBrandToDom();

  // Dynamically resolved after backend detection; default to production
  // V2.0: brand.webHost 注入占位符,build 时根据 distributor 替换。
  let FRONTEND_BASE_URL = LOCAL_FRONTEND_BASE_URL;

  // ─── DOM refs ───
  const loginView = document.getElementById("login-view");
  const mainView = document.getElementById("main-view");
  const loginTip = document.getElementById("login-tip");
  const logoutBtn = document.getElementById("logout-btn");
  const serverStatus = document.getElementById("server-status");

  // store card
  const storeCard = document.getElementById("store-card");
  const storeName = document.getElementById("store-name");
  const storeAuth = document.getElementById("store-auth");
  const storeAuthDot = storeAuth.querySelector(".auth-dot");
  const storeAuthText = storeAuth.querySelector(".auth-text");
  const storeR = document.getElementById("store-r");
  const storeSelect = document.getElementById("store-select");
  const storeCurrency = document.getElementById("store-currency");
  const storePremium = document.getElementById("store-premium");
  const syncCookieBtn = document.getElementById("sync-cookie-btn");
  const sellerPortalBtn = document.getElementById("seller-portal-btn");
  const sellerPortalLabel = document.getElementById("seller-portal-label");
  const connectionStatus = document.getElementById("connection-status");
  const connectionStatusText = document.getElementById(
    "connection-status-text",
  );

  // today + signals
  const todayCountEl = document.getElementById("today-count");
  const signalsContainer = document.getElementById("signals");

  // nav badges
  const navBadgeProducts = document.getElementById("nav-badge-products");
  const navBadgeCollect = document.getElementById("nav-badge-collect");

  // Local Browser Agent task monitor
  const browserAgentSection = document.getElementById("browser-agent-section");
  const browserAgentTitle = document.getElementById("browser-agent-title");
  const browserAgentMeta = document.getElementById("browser-agent-meta");
  const browserAgentProgressBar = document.getElementById(
    "browser-agent-progress-bar",
  );
  const browserAgentStopBtn = document.getElementById("browser-agent-stop-btn");
  let _browserAgentTimer = null;
  let _browserAgentJobId = null;

  // update banner (kept)
  const updateBanner = document.getElementById("update-banner");
  const updateVersion = document.getElementById("update-version");
  const currentVersionEl = document.getElementById("current-version");
  const dismissUpdateBtn = document.getElementById("dismiss-update-btn");
  const downloadUpdateBtn = document.getElementById("download-update-btn");
  const headerVersion = document.getElementById("header-version");

  let availableStores = [];

  // ─── Generic helpers ───
  const sendMessage = (payload) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, resolve);
    });

  // v3 (2026-05-27):跟 frontend/lib/device-fingerprint.ts 对齐。
  // v2 用 devicePixelRatio + navigator.languages.slice(0,3),同台机器不同
  // Edge profile / 不同 zoom 会算成两台,导致 4 台套餐被错占名额。
  // v3 移除这两个不稳维度,保留 OS + 屏分辨率 + 色深 + 时区 + 主语言 + CPU 核数。
  const getMachineFingerprint = () => {
    const screenInfo = window.screen
      ? [
          window.screen.width,
          window.screen.height,
          window.screen.colorDepth,
        ].join('x')
      : 'unknown-screen';
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown-tz';
    const language = navigator.language || 'unknown-lang';
    const raw = [
      'jizhang-machine-v3',
      getOsBucket(),
      screenInfo,
      timeZone,
      language,
      navigator.hardwareConcurrency || 0,
    ].join('|');
    return `machine-v3-${hash(raw)}`;
  };

  const getOsBucket = () => {
    const platform = `${navigator.userAgentData?.platform || navigator.platform || ''} ${navigator.userAgent || ''}`;
    if (/mac/i.test(platform)) return 'mac';
    if (/win/i.test(platform)) return 'windows';
    if (/android/i.test(platform)) return 'android';
    if (/iphone|ipad|ios/i.test(platform)) return 'ios';
    if (/linux/i.test(platform)) return 'linux';
    return 'unknown-os';
  };

  const hash = (s) => {
    let h1 = 0x811c9dc5;
    let h2 = 0x1b873593;
    for (let i = 0; i < s.length; i++) {
      h1 = (h1 ^ s.charCodeAt(i)) >>> 0;
      h1 = Math.imul(h1, 0x01000193);
      h2 = (h2 ^ s.charCodeAt(i)) >>> 0;
      h2 = Math.imul(h2, 0xcc9e2d51);
    }
    return `${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`;
  };

  const setLoginState = (loggedIn) => {
    if (loggedIn) {
      loginView.style.display = "none";
      mainView.classList.add("active");
    } else {
      loginView.style.display = "flex";
      mainView.classList.remove("active");
    }
  };

  const showTip = (msg, isError = true) => {
    loginTip.textContent = msg || "";
    loginTip.style.color = isError ? "var(--orange)" : "var(--green)";
  };

  const updateServerStatus = (connected) => {
    const text = serverStatus.querySelector(".status-text");
    if (connected) {
      serverStatus.className = "server-status connected";
      text.textContent = "服务器已连接";
    } else {
      serverStatus.className = "server-status error";
      text.textContent = "服务器连接失败";
    }
  };

  const setConnectionState = (state, label) => {
    if (!connectionStatus || !connectionStatusText) return;
    connectionStatus.classList.remove("is-loading", "is-ok", "is-error");
    connectionStatus.classList.add(`is-${state}`);
    connectionStatusText.textContent = label;
  };

  const fetchAuth = async () => {
    const response = await sendMessage({ action: "getAuth" });
    return response?.data || response || {};
  };

  // ─── Main view: data fetchers ───
  const currencyLabel = (store) => {
    const code = String(
      store?.currency || store?.currencyCode || store?.companyCurrency || "",
    )
      .trim()
      .toUpperCase();
    const names = { CNY: "人民币", RUB: "卢布", USD: "美元" };
    return code ? `${names[code] || "货币"}·${code}` : "货币·待同步";
  };

  const premiumState = (store) => {
    const raw = store?.isPremium ?? store?.premium ?? store?.premiumEnabled;
    if (raw === true || raw === 1 || raw === "true" || raw === "active") {
      return true;
    }
    if (raw === false || raw === 0 || raw === "false" || raw === "inactive") {
      return false;
    }
    return null;
  };

  const renderStoreMeta = (store) => {
    if (storeCurrency) storeCurrency.textContent = currencyLabel(store);
    if (!storePremium) return;
    const premium = premiumState(store);
    storePremium.classList.toggle("is-off", premium === false);
    storePremium.classList.toggle("is-pending", premium === null);
    storePremium.textContent =
      premium === true
        ? "Premium Pro·已开启"
        : premium === false
          ? "Premium·未开启"
          : "Premium·待同步";
  };

  const loadStores = async () => {
    setConnectionState("loading", "连接中");
    availableStores = [];
    storeSelect.innerHTML = '<option value="">加载中...</option>';
    storeName.textContent = "加载中...";
    renderStoreMeta(null);

    let response;
    try {
      response = await sendMessage({ action: "getStores" });
    } catch (e) {
      console.error("[popup] loadStores exception:", e);
      storeSelect.innerHTML = '<option value="">加载失败</option>';
      storeName.textContent = "加载失败";
      setConnectionState("error", "连接异常");
      return [];
    }
    if (!response?.ok) {
      const err = response?.error || "";
      console.error("[popup] loadStores failed:", err || response);
      if (
        err.includes("[401]") ||
        err.includes("[403]") ||
        err.includes("Unauthorized") ||
        err.includes("未授权") ||
        err.includes("未登录") ||
        err.includes("过期") ||
        err.includes("停用") ||
        err.includes("jwt expired") ||
        err.includes("invalid token")
      ) {
        setLoginState(false);
        showTip("采集会话已失效，请先登录 Web 管理后台");
        return [];
      }
      storeSelect.innerHTML = `<option value="">加载失败${err ? ": " + err.slice(0, 30) : ""}</option>`;
      storeName.textContent = "加载失败";
      setConnectionState("error", "连接异常");
      return [];
    }

    const stores = response.data?.data || response.data || [];
    availableStores = Array.isArray(stores) ? stores : [];
    setConnectionState("ok", "Web 已连接");
    storeSelect.innerHTML = "";
    if (!availableStores.length) {
      storeSelect.innerHTML = '<option value="">暂无店铺</option>';
      storeName.textContent = "暂无店铺";
      renderStoreMeta(null);
      return [];
    }

    availableStores.forEach((store) => {
      const option = document.createElement("option");
      option.value = store.id || store.storeId || "";
      option.textContent =
        store.label ||
        store.companyName ||
        store.legalName ||
        `店铺 ${option.value}`;
      storeSelect.appendChild(option);
    });

    const activeId = String(
      availableStores[0].id || availableStores[0].storeId || "",
    );
    if (activeId) storeSelect.value = activeId;

    const active =
      availableStores.find((s) => String(s.id || s.storeId) === activeId) ||
      availableStores[0];
    storeName.textContent =
      active?.label ||
      active?.companyName ||
      active?.legalName ||
      `店铺 ${activeId}`;
    renderStoreMeta(active);
    return availableStores;
  };

  // ─── Cookie status ───
  const checkCookieStatus = async () => {
    try {
      const resp = await sendMessage({ action: "checkSellerCookies" });
      if (resp?.ok && resp.data?.sc_company_id) {
        return { status: "ok", companyId: resp.data.sc_company_id };
      }
      if (resp?.ok && resp.data?.has_cookies) {
        return { status: "warn", message: "Ozon Cookie 存在，但未找到店铺 ID" };
      }
      return { status: "err", message: "Seller 登录已失效" };
    } catch {
      return { status: "unknown" };
    }
  };

  const renderStoreAuth = (cookie) => {
    storeAuth.classList.remove("ok", "err", "warn");
    storeCard.classList.remove("is-error");
    syncCookieBtn.style.display = "none";
    storeR.style.display = "";

    if (cookie.status === "ok") {
      storeAuth.classList.add("ok");
      storeAuthText.textContent = `Seller 已登录 · ${cookie.companyId}`;
    } else if (cookie.status === "warn") {
      storeAuth.classList.add("warn");
      storeAuthText.textContent = cookie.message;
      storeCard.classList.add("is-error");
      syncCookieBtn.style.display = "";
    } else if (cookie.status === "err") {
      storeAuth.classList.add("err");
      storeAuthText.textContent = cookie.message;
      storeCard.classList.add("is-error");
      syncCookieBtn.style.display = "";
    } else {
      storeAuthText.textContent = "检测失败";
    }

    // seller 跳转/登录按钮:已登录→「查看」(幽灵态),否则→「登录」(醒目态引导登录)。
    if (sellerPortalBtn && sellerPortalLabel) {
      const loggedIn = cookie.status === "ok";
      sellerPortalBtn.classList.toggle("is-login", !loggedIn);
      sellerPortalLabel.textContent = loggedIn ? "查看" : "登录";
      sellerPortalBtn.title = loggedIn
        ? "打开 seller.ozon.ru 卖家后台"
        : "登录 seller.ozon.ru 卖家后台";
    }
  };

  // ─── Counts (feed nav badges only) ───
  const loadCounts = async () => {
    const counts = { collect: 0, products: 0 };
    const [c, p] = await Promise.all([
      sendMessage({ action: "getCollectCount" }).catch(() => null),
      sendMessage({ action: "getProductStatusCounts" }).catch(() => null),
    ]);
    if (c?.ok) counts.collect = c.data?.total ?? c.data?.data?.total ?? 0;
    if (p?.ok && p.data) {
      const v = p.data;
      counts.products =
        v.ALL ||
        v.total ||
        Object.values(v).reduce(
          (a, b) => a + (typeof b === "number" ? b : 0),
          0,
        ) ||
        0;
    }
    return counts;
  };

  const renderNavBadges = (counts) => {
    if (counts.products > 0) {
      navBadgeProducts.textContent = String(counts.products);
      navBadgeProducts.style.display = "";
    } else {
      navBadgeProducts.style.display = "none";
    }
    if (counts.collect > 0) {
      navBadgeCollect.textContent = String(counts.collect);
      navBadgeCollect.style.display = "";
    } else {
      navBadgeCollect.style.display = "none";
    }
  };

  // ─── Follow-sell tasks → signals ───
  const loadFollowSellSignal = async () => {
    try {
      const resp = await sendMessage({
        action: "listFollowSellTasks",
        current: 1,
        pageSize: 20,
      });
      const items = resp?.data?.items || [];
      if (!Array.isArray(items) || items.length === 0) return null;
      const now = Date.now();
      const RECENT_MS = 60 * 60 * 1000;
      const recentFailed = items.filter(
        (t) =>
          t.status === "FAILED" &&
          t.createdAt &&
          now - new Date(t.createdAt).getTime() < RECENT_MS,
      );
      const inflight = items.filter(
        (t) => t.status === "QUEUED" || t.status === "PROCESSING",
      );
      if (recentFailed.length > 0)
        return {
          kind: "follow-failed",
          count: recentFailed.length,
          sample: recentFailed[0],
        };
      if (inflight.length > 0)
        return { kind: "follow-inflight", count: inflight.length };
      return null;
    } catch {
      return null;
    }
  };

  // ─── Active tab → context signal ───
  const detectOzonProductTab = async () => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.url) return null;
      if (!/^https:\/\/www\.ozon\.ru\/product\//.test(tab.url)) return null;
      return { tabId: tab.id, url: tab.url };
    } catch {
      return null;
    }
  };

  // ─── Collected-URL session memory ─────────────────────────────────
  // 用户采集成功后，30 分钟内不再展示「采集当前商品」signal，避免空点。
  // 用 chrome.storage.local 而不是 sessionStorage：popup 关闭后状态消失会让人困惑。
  const COLLECTED_URL_KEY = "collectedOzonUrlsV1";
  const COLLECTED_URL_TTL_MS = 30 * 60 * 1000;
  const normalizeProductUrl = (url) => {
    try {
      const u = new URL(url);
      return "https://" + u.host + u.pathname;
    } catch {
      return String(url || "");
    }
  };
  const loadCollectedUrls = async () => {
    try {
      const v = await chrome.storage.local.get([COLLECTED_URL_KEY]);
      const m = v?.[COLLECTED_URL_KEY] || {};
      const now = Date.now();
      const fresh = {};
      for (const [k, ts] of Object.entries(m)) {
        if (typeof ts === "number" && now - ts < COLLECTED_URL_TTL_MS)
          fresh[k] = ts;
      }
      // 顺手把过期项清掉
      if (Object.keys(fresh).length !== Object.keys(m).length) {
        try {
          await chrome.storage.local.set({ [COLLECTED_URL_KEY]: fresh });
        } catch {}
      }
      return fresh;
    } catch {
      return {};
    }
  };
  const markUrlCollected = async (url) => {
    try {
      const fresh = await loadCollectedUrls();
      fresh[normalizeProductUrl(url)] = Date.now();
      await chrome.storage.local.set({ [COLLECTED_URL_KEY]: fresh });
    } catch {}
  };
  const isUrlCollected = async (url) => {
    const fresh = await loadCollectedUrls();
    return !!fresh[normalizeProductUrl(url)];
  };

  // ─── Signal renderers ───
  const ICON_SVG = {
    camera:
      '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    archive:
      '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    clock:
      '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    alert:
      '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
  };
  const svgEl = (key, size = 16, strokeWidth = 2) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${ICON_SVG[key]}</svg>`;

  const renderSignals = (signals) => {
    signalsContainer.innerHTML = "";
    if (signals.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sig-empty";
      empty.innerHTML = `${svgEl("check", 14, 2.5)}没有待处理任务`;
      signalsContainer.appendChild(empty);
      return;
    }
    signals.forEach((sig) => {
      const card = document.createElement("div");
      card.className = `sig is-${sig.variant}`;
      card.innerHTML = `
        <div class="sig-icon">${svgEl(sig.icon, 16)}</div>
        <div class="sig-body">
          <div class="sig-title">${sig.title}</div>
          ${sig.sub ? `<div class="sig-sub">${sig.sub}</div>` : ""}
        </div>
      `;
      const btn = document.createElement("button");
      btn.className = sig.btnGhost ? "sig-btn-ghost" : "sig-btn";
      btn.textContent = sig.btnLabel;
      btn.addEventListener("click", () => sig.onAction(btn));
      card.appendChild(btn);
      signalsContainer.appendChild(card);
    });
  };

  const renderToday = (signals) => {
    if (signals.length === 0) {
      todayCountEl.textContent = "一切正常";
      todayCountEl.classList.remove("is-bad");
      return;
    }
    const hasBad = signals.some((s) => s.variant === "bad");
    todayCountEl.textContent = hasBad
      ? `${signals.length} 项需要处理`
      : `${signals.length} 项待处理`;
    todayCountEl.classList.toggle("is-bad", hasBad);
  };

  // ─── Build signals (priority-ordered) ───
  const buildSignals = async () => {
    const [cookie, ctxTab, followSig] = await Promise.all([
      checkCookieStatus(),
      detectOzonProductTab(),
      loadFollowSellSignal(),
    ]);
    const counts = await loadCounts();
    renderNavBadges(counts);
    renderStoreAuth(cookie);

    const signals = [];

    // 1. bad: cookie 失效
    if (cookie.status === "err" || cookie.status === "warn") {
      signals.push({
        variant: "bad",
        icon: "alert",
        title: "登录已掉线，先同步 Cookie",
        sub: "同步前其它操作可能失败",
        btnLabel: "立即同步",
        onAction: () => doSyncCookie(),
      });
    }

    // 2. context: 当前 ozon 商品页（30 分钟内已采集过的不再重复显示）
    if (ctxTab && !(await isUrlCollected(ctxTab.url))) {
      const previewUrl =
        ctxTab.url.replace(/^https?:\/\//, "").slice(0, 38) +
        (ctxTab.url.length > 45 ? "..." : "");
      signals.push({
        variant: "context",
        icon: "camera",
        title: "采集当前商品",
        sub: previewUrl,
        btnLabel: "采集",
        onAction: (btn) => triggerCollectFromTab(ctxTab.tabId, ctxTab.url, btn),
      });
    }

    // 3. neutral: 采集箱待上架
    if (counts.collect > 0) {
      signals.push({
        variant: "neutral",
        icon: "archive",
        title: `采集箱待上架 ${counts.collect} 个`,
        sub: "",
        btnLabel: "去上架",
        btnGhost: true,
        onAction: () =>
          sendMessage({
            action: "openFrontend",
            path: "/ozon/products/collect",
          }),
      });
    }

    // 4. bad: 跟卖任务失败
    if (followSig?.kind === "follow-failed") {
      const errPreview = (followSig.sample?.errorMessage || "后台处理失败")
        .toString()
        .slice(0, 50);
      signals.push({
        variant: "bad",
        icon: "alert",
        title: `${followSig.count} 个跟卖任务失败`,
        sub: errPreview,
        btnLabel: "查看",
        onAction: () =>
          sendMessage({
            action: "openFrontend",
            path: "/ozon/products/import-history",
          }),
      });
    }

    // 5. warn: 跟卖任务进行中
    if (followSig?.kind === "follow-inflight") {
      signals.push({
        variant: "warn",
        icon: "clock",
        title: `${followSig.count} 个跟卖任务排队中`,
        sub: '点击"查看"进入上架记录',
        btnLabel: "查看",
        btnGhost: true,
        onAction: () =>
          sendMessage({
            action: "openFrontend",
            path: "/ozon/products/import-history",
          }),
      });
    }

    // Sort: bad > context > warn > neutral （已按构造顺序近似，再做稳定排序保证）
    const ORDER = { bad: 0, context: 1, warn: 2, neutral: 3 };
    signals.sort((a, b) => ORDER[a.variant] - ORDER[b.variant]);

    renderToday(signals);
    renderSignals(signals);
  };

  // ─── Local Browser Agent 任务状态 ─────────────────────────
  const browserAgentActionLabel = (type) =>
    ({
      "agent.ping": "连接检测",
      "collect.hot_products": "热卖商品采集",
      "collect.product_detail": "商品详情采集",
      "listing.create_draft": "生成上架草稿",
      "listing.publish_draft": "发布商品",
    })[type] ||
    type ||
    "AI Agent 任务";

  const renderBrowserAgentState = (state) => {
    if (!state?.running) {
      browserAgentSection.style.display = "none";
      _browserAgentJobId = null;
      return;
    }

    _browserAgentJobId = state.jobId || null;
    const rawPercent = Number(state.percent ?? 0);
    const percent = Number.isFinite(rawPercent)
      ? Math.max(0, Math.min(100, rawPercent))
      : 0;
    const label = browserAgentActionLabel(state.type);
    const stage = state.stage ? ` · ${state.stage}` : "";
    const cancelText = state.cancelRequested ? "正在停止" : "";
    const message = state.message || cancelText || "正在执行";

    browserAgentSection.style.display = "";
    browserAgentTitle.textContent = label;
    browserAgentMeta.textContent = `${message}${stage}`;
    browserAgentProgressBar.style.width = `${percent}%`;
    browserAgentStopBtn.disabled = !!state.cancelRequested;
    browserAgentStopBtn.textContent = state.cancelRequested ? "停止中" : "停止";
  };

  const refreshBrowserAgentState = async () => {
    try {
      const resp = await sendMessage({ action: "browserAgentGetState" });
      if (!resp?.ok) {
        renderBrowserAgentState(null);
        return;
      }
      renderBrowserAgentState(resp.data);
    } catch {
      renderBrowserAgentState(null);
    }
  };

  const startBrowserAgentPolling = () => {
    if (_browserAgentTimer) return;
    refreshBrowserAgentState();
    _browserAgentTimer = setInterval(refreshBrowserAgentState, 3000);
  };

  // 防御:browser-agent 区块是可选 UI。若 popup.html 缺这些节点(历史上 JS/CSS
  // 已加但 HTML 漏了一版),getElementById 返回 null,这里若不判空,顶层
  // .addEventListener 抛 TypeError 会中断整个 IIFE → init() 永不执行 →
  // 验证码不加载、状态卡在「检测服务器…」、登录彻底失效。判空让其优雅降级。
  browserAgentStopBtn?.addEventListener("click", async () => {
    if (!_browserAgentJobId) return;
    browserAgentStopBtn.disabled = true;
    browserAgentStopBtn.textContent = "停止中";
    await sendMessage({
      action: "browserAgentCancelCurrent",
      jobId: _browserAgentJobId,
    }).catch(() => null);
    await refreshBrowserAgentState();
  });

  // ─── Actions: cookie sync, context-tab collect ───
  const doSyncCookie = async () => {
    syncCookieBtn.disabled = true;
    const originalLabel = syncCookieBtn.querySelector("span").textContent;
    syncCookieBtn.querySelector("span").textContent = "同步中...";
    try {
      const resp = await sendMessage({ action: "syncSellerCookies" });
      if (resp?.ok) {
        await buildSignals(); // 重新拉所有信号
      } else {
        storeAuth.classList.add("err");
        storeAuthText.textContent = resp?.error || "同步失败";
      }
    } catch (e) {
      storeAuthText.textContent = e.message || "同步失败";
    } finally {
      syncCookieBtn.disabled = false;
      syncCookieBtn.querySelector("span").textContent = originalLabel;
    }
  };

  const triggerCollectFromTab = async (tabId, url, btn) => {
    // 锁按钮 + 给即时反馈，否则用户看不到任何动静
    const restoreBtn = () => {
      if (!btn) return;
      btn.disabled = false;
      btn.dataset.state = "";
      btn.textContent = "采集";
    };
    if (btn) {
      btn.disabled = true;
      btn.dataset.state = "loading";
      btn.textContent = "采集中…";
    }
    try {
      const resp = await chrome.tabs.sendMessage(tabId, {
        action: "triggerCollectFromPopup",
      });
      if (resp?.ok) {
        if (url) await markUrlCollected(url);
        if (btn) {
          btn.dataset.state = "done";
          btn.textContent = "已采集";
        }
        // 短暂展示成功状态后，重建 signals —— 已采集的当前商品 signal 会被过滤掉
        setTimeout(() => {
          buildSignals();
        }, 700);
      } else {
        if (btn) {
          btn.dataset.state = "error";
          btn.textContent = "采集失败";
          setTimeout(restoreBtn, 2000);
        } else {
          alert(resp?.error || "采集失败，请刷新页面重试");
        }
        console.warn("[popup] collect failed:", resp?.error);
      }
    } catch (e) {
      if (btn) {
        btn.dataset.state = "error";
        btn.textContent = "采集失败";
        setTimeout(restoreBtn, 2000);
      } else {
        alert("采集失败，请刷新页面重试");
      }
      console.warn("[popup] collect error:", e?.message);
    }
  };

  syncCookieBtn.addEventListener("click", doSyncCookie);

  // seller.ozon.ru 跳转/登录:复用 service-worker 的 openSellerPortal(复用现有
  // seller tab 或新开 /app/products;未登录时 Ozon 自动转登录页)。点完弹窗通常因
  // 焦点切到新标签而关闭,disabled 只是防连点兜底。
  sellerPortalBtn?.addEventListener("click", async () => {
    if (sellerPortalBtn.disabled) return;
    sellerPortalBtn.disabled = true;
    try {
      await sendMessage({ action: "openSellerPortal" });
    } catch (e) {
      console.warn("[popup] openSellerPortal error:", e?.message);
    } finally {
      setTimeout(() => {
        sellerPortalBtn.disabled = false;
      }, 800);
    }
  });

  // ─── Update banner ───
  const checkUpdateBanner = async () => {
    try {
      const resp = await sendMessage({ action: "getUpdateInfo" });
      if (resp?.ok && resp.data) {
        const { hasUpdate, currentVersion, latestVersion, downloadUrl } =
          resp.data;
        if (headerVersion) headerVersion.textContent = `v${currentVersion}`;
        if (hasUpdate && latestVersion) {
          updateVersion.textContent = `v${latestVersion}`;
          currentVersionEl.textContent = `v${currentVersion}`;
          updateBanner.style.display = "flex";
          downloadUpdateBtn.dataset.url = downloadUrl || "";
          downloadUpdateBtn.dataset.version = latestVersion;
        } else {
          updateBanner.style.display = "none";
        }
      }
    } catch {
      // 忽略
    }
  };

  downloadUpdateBtn.addEventListener("click", () => {
    const url = downloadUpdateBtn.dataset.url;
    chrome.tabs.create({ url: url || `${FRONTEND_BASE_URL}/extension` });
  });

  dismissUpdateBtn.addEventListener("click", async () => {
    const version = downloadUpdateBtn.dataset.version;
    if (version) await sendMessage({ action: "dismissUpdate", version });
    updateBanner.style.display = "none";
  });

  // ─── Init / lifecycle ───
  const initMainView = async () => {
    const auth = await fetchAuth();
    FRONTEND_BASE_URL =
      auth.backendUrl && isLocalBackendUrl(auth.backendUrl)
        ? LOCAL_FRONTEND_BASE_URL
        : "https://" + BRAND_WEB_HOST;
    await loadStores();
    await Promise.all([buildSignals(), checkUpdateBanner()]);
    startBrowserAgentPolling();
  };

  logoutBtn.addEventListener("click", async () => {
    await sendMessage({ action: "logout" });
    setLoginState(false);
    showTip("采集会话已清除，请在 Web 管理后台保持登录");
  });

  let _storeSaving = false;
  storeSelect.addEventListener("change", async () => {
    if (_storeSaving) return;
    _storeSaving = true;
    try {
      // 切店后店铺名同步、所有店铺范围信号刷新（context 卡不依赖店铺，会被同时重渲）
      const opt = storeSelect.options[storeSelect.selectedIndex];
      if (opt) storeName.textContent = opt.textContent;
      const active = availableStores.find(
        (store) => String(store.id || store.storeId || "") === storeSelect.value,
      );
      renderStoreMeta(active || null);
      await buildSignals();
    } finally {
      _storeSaving = false;
    }
  });

  // ─── Nav / CTA routing ───
  const ACTION_PATHS = {
    dashboard: "/ozon/dashboard",
    products: "/ozon/products/list",
    orders: "/ozon/postings/list",
    profit: "/ozon/postings/profit-trend",
    messages: "/ozon/messaging/templates",
    "collect-box": "/ozon/products/collect",
    favorites: "/ozon/products/favorites",
    "import-history": "/ozon/products/import-history",
    reshelf: "/ozon/products/reshelf",
    // 'pricing' 不走通用 openFrontend，单独处理（见 openJzcCalc）
    watermark: "/ozon/tools/watermark",
    stores: "/ozon/settings/stores",
  };

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      // 批量上架走独立扩展页（chrome.windows.create），不走 openFrontend
      if (action === "batch-upload") {
        try {
          await chrome.windows.create({
            url: chrome.runtime.getURL("batch-upload/index.html"),
            type: "popup",
            width: 1100,
            height: 760,
          });
          window.close();
        } catch (e) {
          console.error("[popup] open batch-upload failed:", e);
        }
        return;
      }
      // 数据透视眼：toggle 而非跳转。首次启用弹 confirm 警告 TOS 风险。
      if (action === "premium-pivot") {
        await togglePremiumPivot();
        return;
      }
      // 数据面板：toggle ozon.ru 商品卡下方的极掌 ERP 数据卡。
      if (action === "data-panel") {
        await toggleDataPanel();
        return;
      }
      // 极掌算价：jzc-calc.js 浮动面板只在 ozon.ru 商品页激活，
      // 这里直接切到已打开的商品页，没有则提示用户打开商品页
      if (action === "pricing") {
        await openJzcCalc();
        return;
      }
      const path = ACTION_PATHS[action];
      if (!path) return;
      await sendMessage({ action: "openFrontend", path });
    });
  });

  // ─── 数据透视眼 toggle ─────────────────────────
  async function togglePremiumPivot() {
    const { ozon_premium_enabled, ozon_premium_acknowledged } =
      await chrome.storage.local.get([
        "ozon_premium_enabled",
        "ozon_premium_acknowledged",
      ]);
    const wantOn = !ozon_premium_enabled;

    if (wantOn && !ozon_premium_acknowledged) {
      const ok = window.confirm(
        "⚠ 数据透视眼会客户端伪造 Ozon Premium 会员状态\n\n" +
          "• 该功能可能违反 Ozon TOS 导致店铺封禁\n" +
          "• 伪造的图表数据是随机数，无业务参考价值\n" +
          "• 一切风险由您自行承担\n\n" +
          "确认开启？",
      );
      if (!ok) return;
      await chrome.storage.local.set({ ozon_premium_acknowledged: true });
    }

    await chrome.storage.local.set({ ozon_premium_enabled: wantOn });
    await syncPremiumBadge();
  }

  async function syncPremiumBadge() {
    const badge = document.getElementById("nav-badge-premium");
    if (!badge) return;
    const { ozon_premium_enabled } = await chrome.storage.local.get(
      "ozon_premium_enabled",
    );
    const on = !!ozon_premium_enabled;
    badge.textContent = on ? "开" : "关";
    badge.classList.toggle("is-on", on);
  }

  // ─── 数据面板 toggle（默认开） ────────────────────
  async function toggleDataPanel() {
    const { ozon_data_panel_enabled } = await chrome.storage.local.get(
      "ozon_data_panel_enabled",
    );
    // 首次安装（undefined）按"默认开"处理：点击切到关
    const currentlyOn = ozon_data_panel_enabled !== false;
    await chrome.storage.local.set({ ozon_data_panel_enabled: !currentlyOn });
    await syncDataPanelBadge();
  }

  async function syncDataPanelBadge() {
    const badge = document.getElementById("nav-badge-data-panel");
    if (!badge) return;
    const { ozon_data_panel_enabled } = await chrome.storage.local.get(
      "ozon_data_panel_enabled",
    );
    const on = ozon_data_panel_enabled !== false; // 默认 true
    badge.textContent = on ? "开" : "关";
    badge.classList.toggle("is-on", on);
  }

  // ─── 极掌算价：跳到 ozon.ru 商品页激活 jzc-calc 浮动面板 ──
  async function openJzcCalc() {
    try {
      // 优先级 1：已打开的商品页（jzc-calc 浮窗就在那）
      const productTabs = await chrome.tabs.query({
        url: ["https://www.ozon.ru/product/*", "https://ozon.kz/product/*"],
      });
      if (productTabs.length > 0) {
        const t = productTabs[0];
        await chrome.tabs.update(t.id, { active: true });
        if (t.windowId)
          await chrome.windows.update(t.windowId, { focused: true });
        window.close();
        return;
      }
      // 优先级 2：已打开的 ozon.ru 任意页（让用户接下来去找商品）
      const ozonTabs = await chrome.tabs.query({
        url: ["https://www.ozon.ru/*", "https://*.ozon.ru/*"],
      });
      const target = ozonTabs.find(
        (t) => t.url && /^https:\/\/www\.ozon\.ru\//.test(t.url),
      );
      if (target) {
        await chrome.tabs.update(target.id, { active: true });
        if (target.windowId)
          await chrome.windows.update(target.windowId, { focused: true });
        window.close();
        return;
      }
      // 兜底：新开 ozon 首页
      chrome.tabs.create({ url: "https://www.ozon.ru/" });
      window.close();
    } catch (e) {
      console.error("[popup] openJzcCalc failed:", e);
    }
  }

  // 启动时初次刷新
  syncPremiumBadge().catch(() => {});
  syncDataPanelBadge().catch(() => {});

  // 监听 storage 变化（浮动面板上 toggle 也能反传到 popup）
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.ozon_premium_enabled) syncPremiumBadge();
      if (changes.ozon_data_panel_enabled) syncDataPanelBadge();
    });
  } catch {}

  document.getElementById("web-login-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: "http://127.0.0.1:3000/login" });
  });

  // ─── Boot ───
  const init = async () => {
    const auth = await fetchAuth();
    if (auth.authenticated) {
      setLoginState(true);
      await initMainView();
    } else {
      setLoginState(false);
    }
  };

  document.getElementById("collector-auth-recheck-btn").addEventListener("click", async () => {
    showTip("正在检查 Web 登录状态…", false);
    await sendMessage({ action: "requestCollectorAuth" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const auth = await fetchAuth();
    if (!auth.authenticated) {
      setLoginState(false);
      showTip("尚未取得采集会话，请确认已在同一浏览器用户配置中登录");
      return;
    }
    showTip("采集会话已连接", false);
    setLoginState(true);
    await initMainView();
  });

  init();
})();
