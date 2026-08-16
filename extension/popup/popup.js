(() => {
  // dev 直接加载源码时 build.js 没跑,brand 占位符保持字面量 → 运行时兜底成平台默认。
  // 用 /__BRAND/ 探测而不写全占位符:build 的 textual replace 会把出现的全占位符全换掉,
  // 若把探测串也写全,分销商 build 会被错误兜底成平台默认(store.jizhangerp.com / sonli)。
  const _brandFallback = (val, fb) => (/__BRAND/.test(val) ? fb : val);
  const BRAND_WEB_HOST = _brandFallback("qh.jizhangerp.com", "store.jizhangerp.com");
  const BRAND_DISPLAY_NAME = _brandFallback("ozon 粽子", "ozon 粽子");
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
  const webLoginBtn = document.getElementById("web-login-btn");
  const webLoginLabel = document.getElementById("web-login-label");
  const collectorAuthRecheckBtn = document.getElementById("collector-auth-recheck-btn");
  const collectorAuthRecheckLabel = document.getElementById("collector-auth-recheck-label");
  const logoutBtn = document.getElementById("logout-btn");
  const serverStatus = document.getElementById("server-status");
  const COLLECTOR_AUTH_STATUS_STORAGE_KEY = "sonliCollectorAuthStatus";
  let latestCollectorAuthStatus = null;
  let collectorAuthStatusRevision = 0;
  let collectorAuthDisplayTimer = null;
  let collectorAuthStorageListener = null;
  let currentMainViewActivation = null;
  let initializedMainViewActivation = null;
  const mainViewInitPromises = new Map();
  let webLoginOpening = false;
  let webLoginAttempt = 0;
  let popupDisposed = false;

  const connectionStatus = document.getElementById("connection-status");
  const connectionStatusText = document.getElementById(
    "connection-status-text",
  );

  // today + signals
  const todayCountEl = document.getElementById("today-count");
  const signalsContainer = document.getElementById("signals");
  const sellerContextStatus = document.getElementById("seller-context-status");

  // nav badges
  const navBadgeProducts = document.getElementById("nav-badge-products");
  const navBadgeCollect = document.getElementById("nav-badge-collect");

  // update banner (kept)
  const updateBanner = document.getElementById("update-banner");
  const updateVersion = document.getElementById("update-version");
  const currentVersionEl = document.getElementById("current-version");
  const dismissUpdateBtn = document.getElementById("dismiss-update-btn");
  const downloadUpdateBtn = document.getElementById("download-update-btn");
  const headerVersion = document.getElementById("header-version");

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

  const showTip = (msg, tone = "warning") => {
    const normalizedTone = tone === false ? "progress" : tone === true ? "warning" : tone;
    loginTip.textContent = msg || "";
    loginTip.classList.remove("is-progress", "is-warning", "is-error");
    loginTip.classList.add(`is-${normalizedTone}`);
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

  const fetchCollectorAuthStatus = async () => {
    const response = await sendMessage({ action: "getCollectorAuthStatus" });
    return response?.ok === true ? response.data : null;
  };

  const SAFE_SELLER_STATUSES = new Set(["READY", "RECOVERING", "LOGIN_REQUIRED"]);
  let latestSellerContext = { status: "LOGIN_REQUIRED" };
  let sellerSwitchNoticeUntil = 0;
  let sellerSwitchNoticeTimer = null;
  let sellerLoginInFlight = null;
  let sellerLoginFeedbackTimer = null;

  const safeSellerContext = (response) => {
    const data = response?.data || response || {};
    const status = SAFE_SELLER_STATUSES.has(data.status) ? data.status : "LOGIN_REQUIRED";
    const companyId = /^\d{4,15}$/.test(String(data.companyId || "").trim())
      ? String(data.companyId).trim()
      : "";
    return { status: status === "READY" && !companyId ? "LOGIN_REQUIRED" : status, companyId };
  };

  const renderSellerContextStatus = (response) => {
    if (!sellerContextStatus) return;
    const { status, companyId } = safeSellerContext(response);
    const previousContext = latestSellerContext;
    latestSellerContext = { status, companyId };
    if (globalThis.JzSellerContextStatusController.isSellerContextSwitch(
      previousContext,
      latestSellerContext,
    )) {
      sellerSwitchNoticeUntil = Date.now() + 3_000;
      clearTimeout(sellerSwitchNoticeTimer);
      sellerSwitchNoticeTimer = setTimeout(() => {
        sellerSwitchNoticeUntil = 0;
        renderSellerContextStatus(latestSellerContext);
      }, 3_000);
    } else if (sellerSwitchNoticeUntil <= Date.now()) {
      sellerSwitchNoticeUntil = 0;
      clearTimeout(sellerSwitchNoticeTimer);
      sellerSwitchNoticeTimer = null;
    }
    sellerContextStatus.className = `seller-context-status is-${status.toLowerCase().replace(/_/g, "-")}`;
    sellerContextStatus.innerHTML = "";
    const copy = document.createElement("span");
    copy.className = "seller-status-copy";
    if (status === "READY") {
      copy.textContent = `Seller 已识别 · Company ID ${companyId}`;
      if (sellerSwitchNoticeUntil > Date.now()) {
        const note = document.createElement("span");
        note.className = "seller-status-note";
        note.textContent = "Seller 店铺已切换";
        copy.appendChild(note);
      }
    } else if (status === "RECOVERING") {
      copy.textContent = "正在识别 Seller 店铺";
      if (sellerSwitchNoticeUntil > Date.now()) {
        const note = document.createElement("span");
        note.className = "seller-status-note";
        note.textContent = "Seller 店铺已切换";
        copy.appendChild(note);
      }
    } else {
      copy.textContent = "需要登录 Seller";
    }
    sellerContextStatus.appendChild(copy);
    if (status !== "LOGIN_REQUIRED") return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-outline seller-status-action";
    button.textContent = "打开 Seller 登录";
    button.setAttribute("aria-label", "打开 Seller 登录");
    button.addEventListener("click", async () => {
      if (sellerLoginInFlight) return;
      button.disabled = true;
      button.textContent = "正在打开…";
      sellerLoginInFlight = sendMessage({ action: "openSellerLogin" });
      try {
        const result = await sellerLoginInFlight;
        if (!result?.ok || !result?.data?.opened) throw new Error("not-opened");
        button.textContent = "已打开 Seller 登录";
      } catch {
        button.textContent = "暂时无法打开 Seller 登录";
      } finally {
        sellerLoginInFlight = null;
        clearTimeout(sellerLoginFeedbackTimer);
        sellerLoginFeedbackTimer = setTimeout(() => {
          button.disabled = false;
          button.textContent = "打开 Seller 登录";
        }, 1_500);
      }
    });
    sellerContextStatus.appendChild(button);
  };

  const sellerStatusController = globalThis.JzSellerContextStatusController
    .createSellerContextStatusController({
      requestStatus: () => sendMessage({ action: "getSellerContextStatus" }),
      onStatus: renderSellerContextStatus,
      pollMs: 5_000,
    });

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
  const buildSignals = async (isCurrent = () => true) => {
    const [ctxTab, followSig] = await Promise.all([
      detectOzonProductTab(),
      loadFollowSellSignal(),
    ]);
    if (!isCurrent()) return;
    const counts = await loadCounts();
    if (!isCurrent()) return;
    renderNavBadges(counts);

    const signals = [];

    // 1. context: 当前 ozon 商品页（30 分钟内已采集过的不再重复显示）
    let currentUrlCollected = false;
    if (ctxTab) {
      if (!isCurrent()) return;
      currentUrlCollected = await isUrlCollected(ctxTab.url);
      if (!isCurrent()) return;
    }
    if (ctxTab && !currentUrlCollected) {
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

    // 2. neutral: 采集箱待上架
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

    // 3. bad: 跟卖任务失败
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

    // 4. warn: 跟卖任务进行中
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

    if (isCurrent()) {
      renderToday(signals);
      renderSignals(signals);
    }
  };

  // ─── Action: context-tab collect ───
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

  // ─── Update banner ───
  const checkUpdateBanner = async (isCurrent = () => true) => {
    try {
      const resp = await sendMessage({ action: "getUpdateInfo" });
      if (isCurrent() && resp?.ok && resp.data) {
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
  const initMainView = async (auth, isCurrent = () => true) => {
    if (!isCurrent()) return;
    const frontendBaseUrl =
      auth.backendUrl && isLocalBackendUrl(auth.backendUrl)
        ? LOCAL_FRONTEND_BASE_URL
        : "https://" + BRAND_WEB_HOST;
    if (!isCurrent()) return;
    FRONTEND_BASE_URL = frontendBaseUrl;
    setConnectionState("ok", "采集会话已连接");
    await Promise.all([buildSignals(isCurrent), checkUpdateBanner(isCurrent)]);
    if (isCurrent()) sellerStatusController.start();
  };

  logoutBtn.addEventListener("click", async () => {
    await sendMessage({ action: "logout" });
    currentMainViewActivation = null;
    initializedMainViewActivation = null;
    sellerStatusController.stop();
    setLoginState(false);
    showTip("采集会话已清除，请在 Web 管理后台保持登录", "warning");
  });

  window.addEventListener?.("unload", () => {
    popupDisposed = true;
    currentMainViewActivation = null;
    webLoginOpening = false;
    webLoginAttempt += 1;
    clearTimeout(collectorAuthDisplayTimer);
    collectorAuthDisplayTimer = null;
    if (collectorAuthStorageListener) {
      chrome.storage.onChanged.removeListener?.(collectorAuthStorageListener);
    }
    sellerStatusController.stop();
    clearTimeout(sellerSwitchNoticeTimer);
    clearTimeout(sellerLoginFeedbackTimer);
  }, { once: true });

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
        url: ["https://www.ozon.ru/*", "https://ozon.ru/*"],
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

  const ACTION_REQUIRED_COPY = Object.freeze({
    ACCOUNT_DISABLED: "当前账号已停用，请联系管理员",
    ACCOUNT_EXPIRED: "当前账号已过期，请在 Web 管理后台续期或切换账号",
    PERMISSION_DENIED: "当前账号无采集权限，请联系管理员",
    TRUST_BOUNDARY_REJECTED: "登录校验未通过，请重新打开 Web 登录页",
    SERVER_UPGRADE_REQUIRED: "当前版本暂不兼容，请更新本地服务和扩展",
  });
  const SAFE_LOCAL_SERVICE_COPY = "本地服务暂时不可用，请稍后重试";
  const COLLECTOR_AUTH_STATUS_KEYS = Object.freeze([
    "account",
    "attemptNumber",
    "expiresAt",
    "generationId",
    "nextRetryAt",
    "phase",
    "publicCode",
    "startedAt",
    "updatedAt",
    "version",
  ]);
  const COLLECTOR_AUTH_ACCOUNT_KEYS = Object.freeze(["displayName", "id"]);
  const COLLECTOR_AUTH_PHASES = new Set([
    "WAITING_FOR_WEB",
    "DISCOVERING_WEB",
    "REQUESTING_TICKET",
    "EXCHANGING",
    "RETRY_WAIT",
    "AUTHENTICATED",
    "ACTION_REQUIRED",
  ]);
  const COLLECTOR_AUTH_PUBLIC_CODES = new Set([
    "",
    "WEB_LOGIN_REQUIRED",
    "WEB_TAB_UNAVAILABLE",
    "LOCAL_SERVICE_UNAVAILABLE",
    ...Object.keys(ACTION_REQUIRED_COPY),
  ]);
  const GENERATION_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
  const SENSITIVE_STATUS_VALUE = /(?:ctt|cst|csess)_[A-Za-z0-9_-]+|bearer\s+|authorization|fingerprint/i;

  const hasExactKeys = (value, expectedKeys) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    return keys.length === expectedKeys.length
      && keys.every((key, index) => key === expectedKeys[index]);
  };

  const isCanonicalIso = (value, { allowEmpty = true } = {}) => {
    if (typeof value !== "string") return false;
    if (!value) return allowEmpty;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  };

  const isSafeAccountText = (value, { required = false } = {}) => (
    typeof value === "string"
    && value.trim() === value
    && value.length <= 128
    && (!required || value.length > 0)
    && !SENSITIVE_STATUS_VALUE.test(value)
  );

  const normalizeCollectorAuthStatus = (value, currentTime = Date.now()) => {
    if (!hasExactKeys(value, COLLECTOR_AUTH_STATUS_KEYS)) return null;
    if (
      value.version !== 1
      || !COLLECTOR_AUTH_PHASES.has(value.phase)
      || !COLLECTOR_AUTH_PUBLIC_CODES.has(value.publicCode)
      || !Number.isSafeInteger(value.attemptNumber)
      || value.attemptNumber < 0
      || typeof value.generationId !== "string"
      || (value.generationId !== "" && !GENERATION_PATTERN.test(value.generationId))
      || SENSITIVE_STATUS_VALUE.test(value.generationId)
      || !isCanonicalIso(value.startedAt)
      || !isCanonicalIso(value.updatedAt)
      || !isCanonicalIso(value.nextRetryAt)
      || !isCanonicalIso(value.expiresAt)
    ) return null;

    let account = null;
    if (value.account !== null) {
      if (
        !hasExactKeys(value.account, COLLECTOR_AUTH_ACCOUNT_KEYS)
        || !isSafeAccountText(value.account.id, { required: true })
        || !isSafeAccountText(value.account.displayName)
      ) return null;
      account = { id: value.account.id, displayName: value.account.displayName };
    }

    const startedAt = value.startedAt ? Date.parse(value.startedAt) : NaN;
    const updatedAt = value.updatedAt ? Date.parse(value.updatedAt) : NaN;
    const nextRetryAt = value.nextRetryAt ? Date.parse(value.nextRetryAt) : NaN;
    const expiresAt = value.expiresAt ? Date.parse(value.expiresAt) : NaN;
    const hasTimeline = Number.isFinite(startedAt) && Number.isFinite(updatedAt);
    const hasPartialTimeline = Boolean(value.startedAt) !== Boolean(value.updatedAt);
    if (
      hasPartialTimeline
      || (hasTimeline && (startedAt > updatedAt || updatedAt > currentTime))
    ) return null;

    const noCredentialProjection = account === null && value.expiresAt === "";
    const noRetry = value.nextRetryAt === "";
    if (value.phase === "WAITING_FOR_WEB") {
      if (
        !["", "WEB_LOGIN_REQUIRED", "WEB_TAB_UNAVAILABLE"].includes(value.publicCode)
        || !noCredentialProjection
        || !noRetry
      ) return null;
    } else if (value.phase === "ACTION_REQUIRED") {
      if (!ACTION_REQUIRED_COPY[value.publicCode] || !noCredentialProjection || !noRetry) {
        return null;
      }
    } else if (value.phase === "AUTHENTICATED") {
      if (
        value.publicCode !== ""
        || !account
        || !GENERATION_PATTERN.test(value.generationId)
        || !hasTimeline
        || !noRetry
        || !Number.isFinite(expiresAt)
        || expiresAt <= currentTime
      ) return null;
    } else if (value.phase === "RETRY_WAIT") {
      if (
        value.publicCode !== "LOCAL_SERVICE_UNAVAILABLE"
        || !noCredentialProjection
        || !GENERATION_PATTERN.test(value.generationId)
        || !hasTimeline
        || value.attemptNumber < 1
        || !Number.isFinite(nextRetryAt)
        || updatedAt >= nextRetryAt
        || nextRetryAt <= currentTime
        || nextRetryAt - updatedAt > 30_000
      ) return null;
    } else if (
      value.publicCode !== ""
      || !noCredentialProjection
      || !noRetry
      || !GENERATION_PATTERN.test(value.generationId)
      || !hasTimeline
    ) return null;

    return {
      version: 1,
      phase: value.phase,
      generationId: value.generationId,
      startedAt: value.startedAt,
      updatedAt: value.updatedAt,
      attemptNumber: value.attemptNumber,
      nextRetryAt: value.nextRetryAt,
      publicCode: value.publicCode,
      account,
      expiresAt: value.expiresAt,
    };
  };

  const clearCollectorAuthDisplayTimer = () => {
    clearTimeout(collectorAuthDisplayTimer);
    collectorAuthDisplayTimer = null;
  };

  const collectorAuthIdentity = (status) => [
    status.generationId,
    status.account.id,
    status.expiresAt,
  ].join("|");

  const mainViewActivationIsCurrent = (activation) => (
    !popupDisposed
    && currentMainViewActivation === activation
    && collectorAuthStatusRevision === activation.revision
    && latestCollectorAuthStatus?.phase === "AUTHENTICATED"
    && collectorAuthIdentity(latestCollectorAuthStatus) === activation.identity
  );

  const ensureMainView = (status) => {
    const activation = Object.freeze({
      revision: collectorAuthStatusRevision,
      identity: collectorAuthIdentity(status),
      accountId: status.account.id,
      expiresAt: status.expiresAt,
    });
    currentMainViewActivation = activation;
    setLoginState(true);
    if (
      initializedMainViewActivation
      && initializedMainViewActivation.identity === activation.identity
    ) {
      initializedMainViewActivation = activation;
      return;
    }
    const initPromise = (async () => {
      const auth = await fetchAuth();
      if (
        !mainViewActivationIsCurrent(activation)
        || !auth.authenticated
        || auth.account?.id !== activation.accountId
        || auth.expiresAt !== activation.expiresAt
      ) return;
      await initMainView(auth, () => mainViewActivationIsCurrent(activation));
      if (mainViewActivationIsCurrent(activation)) {
        initializedMainViewActivation = activation;
      }
    })().catch(() => {
      if (!mainViewActivationIsCurrent(activation)) return;
      currentMainViewActivation = null;
      setLoginState(false);
      showTip(SAFE_LOCAL_SERVICE_COPY, "error");
    }).finally(() => {
      if (mainViewInitPromises.get(activation.revision) === initPromise) {
        mainViewInitPromises.delete(activation.revision);
      }
    });
    mainViewInitPromises.set(activation.revision, initPromise);
  };

  const renderCollectorAuthStatus = (status) => {
    if (popupDisposed) return;
    clearCollectorAuthDisplayTimer();
    latestCollectorAuthStatus = status;
    const phase = latestCollectorAuthStatus?.phase;
    const publicCode = latestCollectorAuthStatus?.publicCode;
    const now = Date.now();
    let copy = SAFE_LOCAL_SERVICE_COPY;
    let tone = "error";
    let disableWebLogin = false;
    let disableRetry = false;
    let retryLabel = "重新检查";
    let refreshDisplay = false;

    if (phase === "WAITING_FOR_WEB") {
      if (publicCode === "WEB_TAB_UNAVAILABLE") {
        copy = "未检测到 Web 管理后台，请先打开登录页";
      } else if (publicCode === "" || publicCode === "WEB_LOGIN_REQUIRED") {
        copy = "等待 Web 端登录";
      }
      tone = "warning";
    } else if (phase === "DISCOVERING_WEB") {
      copy = "正在检测 Web 登录状态";
      tone = "progress";
      disableWebLogin = true;
      disableRetry = true;
      retryLabel = "正在检查…";
    } else if (phase === "REQUESTING_TICKET") {
      copy = "正在获取登录授权";
      tone = "progress";
      disableWebLogin = true;
      disableRetry = true;
      retryLabel = "正在检查…";
    } else if (phase === "EXCHANGING") {
      const startedAt = Date.parse(latestCollectorAuthStatus.startedAt);
      const elapsedSeconds = Number.isFinite(startedAt)
        ? Math.max(0, Math.floor((now - startedAt) / 1_000))
        : 0;
      copy = `正在连接采集服务 · 已等待 ${elapsedSeconds} 秒`;
      tone = "progress";
      disableWebLogin = true;
      disableRetry = true;
      retryLabel = "正在检查…";
      refreshDisplay = true;
    } else if (
      phase === "RETRY_WAIT"
      && publicCode === "LOCAL_SERVICE_UNAVAILABLE"
    ) {
      const nextRetryAt = Date.parse(latestCollectorAuthStatus.nextRetryAt);
      const seconds = Number.isFinite(nextRetryAt)
        ? Math.max(0, Math.ceil((nextRetryAt - now) / 1_000))
        : 0;
      copy = `连接暂时不稳定，将在 ${seconds} 秒后自动重试`;
      tone = "warning";
      disableWebLogin = true;
      retryLabel = "立即重试";
      refreshDisplay = Number.isFinite(nextRetryAt) && nextRetryAt > now;
    } else if (phase === "ACTION_REQUIRED" && ACTION_REQUIRED_COPY[publicCode]) {
      copy = ACTION_REQUIRED_COPY[publicCode];
      tone = "error";
    } else if (phase === "AUTHENTICATED") {
      showTip("采集会话已连接", "progress");
      ensureMainView(latestCollectorAuthStatus);
      return;
    }

    currentMainViewActivation = null;
    initializedMainViewActivation = null;
    sellerStatusController.stop();
    setLoginState(false);
    showTip(copy, tone);
    webLoginBtn.disabled = webLoginOpening || disableWebLogin;
    webLoginLabel.textContent = webLoginOpening ? "正在打开 Web 登录页…" : "前往登录";
    collectorAuthRecheckBtn.disabled = disableRetry;
    collectorAuthRecheckLabel.textContent = retryLabel;

    if (refreshDisplay) {
      collectorAuthDisplayTimer = setTimeout(() => {
        if (!popupDisposed && latestCollectorAuthStatus === status) {
          renderCollectorAuthStatus(status);
        }
      }, 1_000);
    }
  };

  const refreshCollectorAuthStatus = async () => {
    const expectedRevision = collectorAuthStatusRevision;
    const status = normalizeCollectorAuthStatus(await fetchCollectorAuthStatus());
    if (expectedRevision === collectorAuthStatusRevision) {
      renderCollectorAuthStatus(status);
    }
  };

  // One storage listener owns both local preference updates and session auth progress.
  try {
    collectorAuthStorageListener = (changes, area) => {
      if (area === "local") {
        if (changes.ozon_premium_enabled) syncPremiumBadge();
        if (changes.ozon_data_panel_enabled) syncDataPanelBadge();
        return;
      }
      if (area !== "session") return;
      const statusChange = changes[COLLECTOR_AUTH_STATUS_STORAGE_KEY];
      if (statusChange && Object.hasOwn(statusChange, "newValue")) {
        collectorAuthStatusRevision += 1;
        webLoginOpening = false;
        webLoginAttempt += 1;
        renderCollectorAuthStatus(normalizeCollectorAuthStatus(statusChange.newValue));
      }
    };
    chrome.storage.onChanged.addListener(collectorAuthStorageListener);
  } catch {}

  webLoginBtn.addEventListener("click", async () => {
    if (webLoginOpening) return;
    const attempt = ++webLoginAttempt;
    const expectedRevision = collectorAuthStatusRevision;
    webLoginOpening = true;
    clearCollectorAuthDisplayTimer();
    webLoginBtn.disabled = true;
    webLoginLabel.textContent = "正在打开 Web 登录页…";
    showTip("正在打开 Web 登录页…", false);
    try {
      const response = await sendMessage({ action: "openFrontend", path: "/login" });
      if (response?.data?.opened !== true) throw new Error("frontend-not-opened");
      if (
        popupDisposed
        || attempt !== webLoginAttempt
        || expectedRevision !== collectorAuthStatusRevision
      ) return;
      webLoginOpening = false;
      renderCollectorAuthStatus(latestCollectorAuthStatus);
    } catch {
      if (
        popupDisposed
        || attempt !== webLoginAttempt
        || expectedRevision !== collectorAuthStatusRevision
      ) return;
      webLoginOpening = false;
      renderCollectorAuthStatus(latestCollectorAuthStatus);
      showTip("无法打开 Web 登录页，请确认本地服务已启动", "error");
    }
  });

  // ─── Boot ───
  const init = async () => {
    await refreshCollectorAuthStatus();
  };

  collectorAuthRecheckBtn.addEventListener("click", async () => {
    if (collectorAuthRecheckBtn.disabled) return;
    collectorAuthRecheckBtn.disabled = true;
    collectorAuthRecheckLabel.textContent = "正在检查…";
    showTip("正在检测 Web 登录状态", "progress");
    await sendMessage({ action: "retryCollectorAuth" });
    await refreshCollectorAuthStatus();
  });

  init();
})();
