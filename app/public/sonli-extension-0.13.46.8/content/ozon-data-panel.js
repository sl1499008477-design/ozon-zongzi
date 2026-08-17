/**
 * 数据面板 — 在所有 ozon.ru 商品卡下方注入「极掌 ERP」销量/转化数据卡。
 *
 * 跟 ozon-search.js 的关系：
 *   - 搜索结果页的数据面板、采集器、自动滚动和关键词导航集中在 ozon-search.js
 *   - manifest matches 仅 search / category / search-by-image，其他页（首页、商品详情页推荐区、
 *     品牌页、卖家店铺页、收藏夹）注不进去 → 看不到数据卡
 *   - 抽出独立脚本 + manifest matches 改成 www.ozon.ru/*，全站注入
 *   - 搜索/类目/search-by-image 页的数据面板和采集器等行为仍由 ozon-search.js 负责
 *
 * 共用资源（shared-utils.js 提供，content_scripts 加载顺序保证）：
 *   - window.formatNumber
 *   - window.sendMessage
 *   - window.JZTaskQueue（用于节流并发请求）
 *   - window.checkAuth（避免未登录时白打请求）
 */
(function () {
  "use strict";

  // 通用商品卡 selector — Ozon 各页面（search / category / 首页 carousel /
  // brand / seller / 收藏夹 / 商品详情页"也看了"）目前都用 .tile-root 作为容器
  const CARD_SELECTORS = [
    ".tile-root",
    '[data-widget="searchResultsV2"] [data-widget="searchResultsItem"]',
    '[data-widget="searchResults"] [data-widget="searchResultsItem"]',
  ];

  // 商品详情页由 ozon-product.js 提供唯一主商品面板。推荐卡不再自动
  // 创建面板或补全任务，避免几十个推荐 SKU 抢占当前商品的采集队列。
  function isProductDetailPage() {
    return /^\/product\/[^/]+/.test(window.location.pathname);
  }

  const panelState = { enabled: true };
  const panelDataCache = new Map();
  const panelFastDataPromises = new Map();
  const panelVariantRetryStates = new Map();
  const SAFE_SELLER_STATUSES = new Set(["READY", "RECOVERING", "LOGIN_REQUIRED"]);
  const sellerContextSubscribers = new Set();
  let latestSellerContext = { status: "LOGIN_REQUIRED" };
  let sellerSwitchNoticeUntil = 0;
  let sellerSwitchNoticeTimer = null;
  let sellerLoginInFlight = null;
  const sellerLoginFeedbackTimers = new Set();
  const collectCoordinator = window.JzOzonCollectCoordinator.getPageCoordinator({
    sendMessage: (action, payload) => window.sendMessage(action, payload),
    now: () => Date.now(),
    timeoutMs: 20_000,
  });

  // 节流并发：跟原 ozon-search 配置一致
  const taskQueue = new window.JZTaskQueue({
    concurrency: 6,
    timeoutMs: 60000,
    autoPauseHigh: 12,
    autoPauseLow: 6,
    pauseLowPending: 12,
  });

  // 二级节流(与 ozon-search.js 同款,工厂在 shared-utils jzMakeStaggeredQueue):
  // 此前本文件四路请求全塞 taskQueue(6 并发)裸并发,searchVariants(seller-portal
  // 注入,反爬指纹敏感)和 jzFetchPublicFollowSell(composer)会 6 路齐发 —— 首页/
  // 品牌页 tile 一样多,突发跟搜索页同量级,必须同样上纪律。
  const variantsQueue = window.jzMakeStaggeredQueue({ concurrency: 2, staggerMs: 300 });
  const followSellQueue = window.jzMakeStaggeredQueue({ concurrency: 1, staggerMs: 500 });
  // fleet 服务端取数灰度命中时放宽 variants(与 ozon-search.js 同款):请求走后端,
  // SW 侧 FLEET_MAX_INFLIGHT=6 并发闸兜底,这层 stagger 只剩拖慢;非灰度/查询失败
  // 保持保守默认(老路 SW _sellerPortalGate 200ms 仍是全局兜底)。followSell 是
  // 本地 www composer 调用,不走 fleet,节流永远保留。
  window.sendMessage('getFleetServersideFlag', {})
    .then((d) => { if (d?.on) variantsQueue.setParams({ concurrency: 6, staggerMs: 0 }); })
    .catch(() => {});

  function safeSellerContext(response) {
    const data = response?.data || response || {};
    const status = SAFE_SELLER_STATUSES.has(data.status) ? data.status : "LOGIN_REQUIRED";
    const companyId = /^\d{4,15}$/.test(String(data.companyId || "").trim())
      ? String(data.companyId).trim()
      : "";
    return { status: status === "READY" && !companyId ? "LOGIN_REQUIRED" : status, companyId };
  }

  function renderSellerContextStatus(container, response) {
    if (!container) return;
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
        sellerContextSubscribers.forEach((subscriber) => subscriber(latestSellerContext));
      }, 3_000);
    } else if (sellerSwitchNoticeUntil <= Date.now()) {
      sellerSwitchNoticeUntil = 0;
      clearTimeout(sellerSwitchNoticeTimer);
      sellerSwitchNoticeTimer = null;
    }
    container.className = `oh-seller-context-status is-${status.toLowerCase().replace(/_/g, "-")}`;
    container.setAttribute("aria-live", "polite");
    container.innerHTML = "";
    const copy = document.createElement("span");
    copy.className = "oh-seller-context-copy";
    if (status === "READY") {
      copy.textContent = `Seller 已识别 · Company ID ${companyId}`;
      if (sellerSwitchNoticeUntil > Date.now()) {
        const note = document.createElement("span");
        note.className = "oh-seller-context-note";
        note.textContent = "Seller 店铺已切换";
        copy.appendChild(note);
      }
    }
    else if (status === "RECOVERING") {
      copy.textContent = "正在识别 Seller 店铺";
      if (sellerSwitchNoticeUntil > Date.now()) {
        const note = document.createElement("span");
        note.className = "oh-seller-context-note";
        note.textContent = "Seller 店铺已切换";
        copy.appendChild(note);
      }
    } else {
      copy.textContent = "需要登录 Seller";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "oh-seller-context-action";
      button.dataset.action = "open-seller-login";
      button.textContent = "打开 Seller 登录";
      button.setAttribute("aria-label", "打开 Seller 登录");
      const suppressHostCard = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      button.addEventListener("pointerdown", suppressHostCard);
      button.addEventListener("click", (event) => {
        suppressHostCard(event);
        openSellerLogin(button);
      });
      container.append(copy, button);
      return;
    }
    container.appendChild(copy);
  }

  const sellerStatusController = window.JzSellerContextStatusController
    .createSellerContextStatusController({
      requestStatus: () => window.sendMessage("getSellerContextStatus", {}),
      onStatus: (response) => sellerContextSubscribers.forEach((subscriber) => subscriber(response)),
      pollMs: 5_000,
    });

  function subscribeSellerContextStatus(container) {
    const subscriber = (response) => renderSellerContextStatus(container, response);
    sellerContextSubscribers.add(subscriber);
    subscriber(latestSellerContext);
    if (sellerContextSubscribers.size === 1) sellerStatusController.start();
    return () => {
      sellerContextSubscribers.delete(subscriber);
      if (sellerContextSubscribers.size === 0) sellerStatusController.stop();
    };
  }

  async function openSellerLogin(button) {
    if (sellerLoginInFlight) return;
    button.disabled = true;
    button.textContent = "正在打开…";
    sellerLoginInFlight = Promise.resolve(window.sendMessage("openSellerLogin", {}));
    try {
      const result = await sellerLoginInFlight;
      if (!result?.opened) throw new Error("not-opened");
      button.textContent = "已打开 Seller 登录";
    } catch {
      button.textContent = "暂时无法打开 Seller 登录";
    } finally {
      sellerLoginInFlight = null;
      const timer = setTimeout(() => {
        sellerLoginFeedbackTimers.delete(timer);
        button.disabled = false;
        button.textContent = "打开 Seller 登录";
      }, 1_500);
      sellerLoginFeedbackTimers.add(timer);
    }
  }

  // ─── 工具函数 ──────────────────────────────────────
  function extractProductId(url) {
    if (!url) return null;
    const m = url.match(/\/product\/.*-(\d{5,})/);
    return m ? m[1] : null;
  }

  const MONEY_TOKEN_RE = /(?:(?:[\u20bd\u00a5\uffe5]|\b(?:CNY|RMB|RUB)\b|\u0440\u0443\u0431\.?)\s*\d[\d\s]*(?:[,.]\d{1,2})?|\d[\d\s]*(?:[,.]\d{1,2})?\s*(?:[\u20bd\u00a5\uffe5]|\b(?:CNY|RMB|RUB)\b|\u0440\u0443\u0431\.?|\u5143))/i;

  function extractMoneyToken(text) {
    const match = String(text || '').replace(/\s+/g, ' ').trim().match(MONEY_TOKEN_RE);
    return match ? match[0] : '';
  }

  function extractVisiblePriceText(card, priceNode) {
    const rawNodeText = priceNode?.textContent || '';
    const nodeText = extractMoneyToken(rawNodeText);
    if (nodeText && window.normalizePrice(nodeText) > 0) return nodeText;
    if (rawNodeText && window.normalizePrice(rawNodeText) > 0) return rawNodeText;
    const text = card?.innerText || card?.textContent || '';
    return extractMoneyToken(text);
  }

  function detectPriceCurrency(text) {
    return window.jzDetectOzonMoneyCurrency?.(text) || null;
  }

  function extractCardInfo(card) {
    const link = card.querySelector('a[href*="/product/"]');
    const img = card.querySelector("img");

    // 名称优先级（避开 Chrome 翻译污染）：
    //   1. <a aria-label>            ← attribute，不被翻译
    //   2. <img alt>                 ← attribute，不被翻译
    //   3. <a> 上嵌入的 [data-state] / span 子元素 textContent —— 翻译态下退化
    //   4. <a> textContent            ← 翻译态下是中文，**仅在非翻译态使用**
    // 翻译态下若都拿不到原始名，name 留空，让后端走 search-variant-model
    // attr 4180 拿原始俄/英文名（更可靠）。
    const ariaLabel = (link?.getAttribute("aria-label") || "").trim();
    const imgAlt = (img?.getAttribute("alt") || "").trim();
    const translated = window.jzIsTranslated?.();
    const textTitle = translated
      ? ""
      : link?.textContent?.trim() || card.textContent?.trim().slice(0, 120) || "";
    const rawTitle = ariaLabel || imgAlt || textTitle;
    const cleanedTitle = window.jzCleanOzonCardTitle
      ? window.jzCleanOzonCardTitle(rawTitle)
      : rawTitle;
    const title = window.jzStripPromo
      ? window.jzStripPromo(cleanedTitle)
      : cleanedTitle;

    const priceNode =
      card.querySelector('[data-widget="searchResultsPrice"]') ||
      card.querySelector('[data-widget="webPrice"]');
    const priceText = extractVisiblePriceText(card, priceNode);
    const price = window.normalizePrice
      ? window.normalizePrice(priceText)
      : null;
    const priceCurrency = detectPriceCurrency(priceText);
    const priceTags = window.jzExtractOzonCalcPriceTags
      ? window.jzExtractOzonCalcPriceTags(card)
      : (window.jzExtractOzonPriceTags ? window.jzExtractOzonPriceTags(card) : {});

    return {
      url: link?.href || "",
      name: title,
      price,
      priceCurrency,
      marketingPrice: priceTags.blackPrice ?? null,
      marketingPriceCurrency: priceTags.blackPriceCurrency || null,
      marketingPriceSource: priceTags.blackPrice != null ? "card" : null,
      greenPrice: priceTags.greenPrice ?? null,
      greenPriceCurrency: priceTags.greenPriceCurrency || null,
      greenPriceSource: priceTags.greenPrice != null ? "card" : null,
      image: img?.getAttribute("src") || img?.getAttribute("data-src") || "",
    };
  }

  function mergeRefreshedCardInfo(prev, refreshed) {
    const hashtags = Array.isArray(refreshed?.hashtags)
      ? refreshed.hashtags.filter(Boolean)
      : [];
    return {
      ...prev,
      ...refreshed,
      url: refreshed.url || prev.url,
      name: refreshed.name || prev.name,
      image: refreshed.image || prev.image,
      price: Number(refreshed.price) > 0 ? refreshed.price : prev.price,
      priceCurrency: refreshed.priceCurrency || prev.priceCurrency,
      marketingPrice: refreshed.marketingPrice != null ? refreshed.marketingPrice : prev.marketingPrice,
      marketingPriceCurrency: refreshed.marketingPriceCurrency || prev.marketingPriceCurrency,
      marketingPriceSource: refreshed.marketingPrice != null ? (refreshed.marketingPriceSource || prev.marketingPriceSource) : prev.marketingPriceSource,
      greenPrice: refreshed.greenPrice != null ? refreshed.greenPrice : prev.greenPrice,
      greenPriceCurrency: refreshed.greenPriceCurrency || prev.greenPriceCurrency,
      greenPriceSource: refreshed.greenPrice != null ? (refreshed.greenPriceSource || prev.greenPriceSource) : prev.greenPriceSource,
      hashtags: hashtags.length ? hashtags : prev.hashtags,
    };
  }

  async function enrichInfoWithDetailMarketingPrice(info) {
    if (!info?.url || !window.jzFetchOzonPagePriceTags) return info;
    const priceTags = await window.jzFetchOzonPagePriceTags(info.url);
    if (!priceTags) return info;
    return mergeRefreshedCardInfo(info, {
      url: info.url,
      name: "",
      image: "",
      price: null,
      priceCurrency: null,
      marketingPrice: priceTags.blackPrice ?? info.marketingPrice ?? null,
      marketingPriceCurrency: priceTags.blackPriceCurrency || info.marketingPriceCurrency || null,
      marketingPriceSource: priceTags.blackPrice != null ? "pdp" : (info.marketingPriceSource || null),
      greenPrice: priceTags.greenPrice ?? info.greenPrice ?? null,
      greenPriceCurrency: priceTags.greenPriceCurrency || info.greenPriceCurrency || null,
      greenPriceSource: priceTags.greenPrice != null ? "pdp" : (info.greenPriceSource || null),
      hashtags: Array.isArray(priceTags.hashtags) ? priceTags.hashtags : [],
    });
  }

  // 格式化 + 数据合并 + 渲染逻辑统一放在 shared-utils.js,跟 ozon-search.js 共用。
  // 见 window.jzMergeCardPanelData / window.jzRenderProductCardPanel /
  //   window.jzRenderPanelSkeleton。

  // ─── 加载数据 + 渲染 ─────────────────────────────────
  async function loadPanelData(card, panel) {
    if (panel) panel.dataset.jzLoadStatus = "loading";
    const info = extractCardInfo(card);
    const productId = extractProductId(info.url);
    if (!productId) {
      if (panel) panel.dataset.jzLoadStatus = "error";
      panel.innerHTML = "";
      return;
    }

    // —— 会员门控:数据卡为会员功能,免费档渲染锁定卡、不发任何数据请求 ——
    // (页面级缓存一次;fail-open,后端 product-data 403 + __featureGated 兜底)
    const renderLockedPanel = (gate) => {
      if (!panel) return;
      panel.dataset.jzLoadStatus = "ready";
      window.jzRenderPanelSkeleton(panel); // 复用卡头(品牌 + 齿轮)
      const body = panel.querySelector(".ozon-helper-sidebar-card-body") || panel;
      if (gate?.reason === "WEB_AUTH_REQUIRED") {
        window.jzRenderDataCardLoginRequired(body);
      } else {
        window.jzRenderDataCardLocked(body);
      }
    };
    const gate = await window.jzDataCardAllowed();
    if (!gate.allowed) {
      renderLockedPanel(gate);
      return;
    }
    // Keep the panel's opportunistic warm-up for backward compatibility. Collection
    // itself is public-first and never waits for this held enrichment request.
    collectCoordinator.prefetch({ sku: productId }).catch(() => {});

    // tile 可见实价(RUB)传给 populate 定佣金档 —— 比市场月均价更贴近当前档位;
    // 币种明确是 CNY/USD(跨境视图)才不用,与 PDP 同口径。
    const tileRub =
      info.priceCurrency !== "CNY" && info.priceCurrency !== "USD" && Number(info.price) > 0
        ? Number(info.price)
        : 0;

    if (panelDataCache.has(productId)) {
      const cached = panelDataCache.get(productId);
      // V2 优先(对齐详情页 5-section 布局),用 cached.preFetched 复用之前已 fetch 的结果
      if (typeof window.jzRenderProductPanelV2 === 'function' && cached?.preFetched) {
        if (!panel.getAttribute("data-jz-datacard")) {
          window.jzRenderProductPanelV2(panel, { sku: productId, initial: cached });
        }
        try { await window.jzPopulatePanelV2(panel, productId, { preFetched: cached.preFetched, pageRub: tileRub }); } catch {}
      } else {
        window.jzRenderProductCardPanel(panel, cached);
      }
      if (panel) panel.dataset.jzLoadStatus = "ready";
      return;
    }

    const showError = () => {
      if (panel) panel.dataset.jzLoadStatus = "error";
      panel.innerHTML =
        '<div class="ozon-helper-panel-error" style="cursor:pointer;color:var(--oh-red,#ff4d4f);font-size:12px;padding:8px 12px;">数据加载失败，点击重试</div>';
      panel
        .querySelector(".ozon-helper-panel-error")
        ?.addEventListener(
          "click",
          () => {
            window.jzRenderPanelSkeleton(panel);
            loadPanelData(card, panel);
          },
          { once: true }
        );
    };

    try {
      // searchVariants 现走 sw.js /api/v1/search + bundle 组合,bundle 注入物理 attr
      // (4497 重量、9454-9456 尺寸)到 items[0].attributes,jzMergeCardPanelData
      // 直接从 sv 拿到。jzFetchPublicFollowSell 同源 composer-api 内部有 cache。
      // 快慢分车道(与 ozon-search.js 同纪律):首帧只等 stats/market 快车道;
      // variants/跟卖数经 populate 的 promise 型 preFetched 到货即补格子,
      // 不再让 4 路 allSettled barrier 把首帧拖到最慢一路(跟卖 1 并发×500ms)。
      const fetchTask = () => {
        const slowVariant = variantsQueue.add(() => window.sendMessage("searchVariants", { sku: productId }));
        const slowFollow = followSellQueue.add(() => window.jzFetchPublicFollowSell(productId));
        // 慢车道晚些才被 allSettled/populate 收编,先挂空 catch 防 unhandledrejection
        slowVariant.catch(() => {});
        slowFollow.catch(() => {});
        return Promise.allSettled([
          // period 跟 ozon-search.js 同款传参:不带的话周模式下标签显示「周销量」
          // 数据却是月口径(SW/后端按 monthly 兜底)。
          window.sendMessage("getMarketStats", { sku: productId, period: window.jzGetSalesPeriod?.() || "monthly" }),
          window.sendMessage("getProductStats", { url: info.url, period: window.jzGetSalesPeriod?.() || "monthly" }),
        ]).then(([marketResult, productResult]) => ({ marketResult, productResult, slowVariant, slowFollow }));
      };
      const fastDataPromise = taskQueue.add(`stats-${productId}`, fetchTask)
        .then(({ marketResult, productResult, slowVariant, slowFollow }) => {
          const firstData = window.jzMergeCardPanelData(
            marketResult.status === "fulfilled" ? marketResult.value : null,
            productResult.status === "fulfilled" ? productResult.value : null,
            null,
            null,
            productId,
            null,
          );
          firstData.preFetched = {
            stats: productResult,
            market: marketResult,
            variant: slowVariant,
            followCount: slowFollow,
          };
          return { marketResult, productResult, slowVariant, slowFollow, firstData };
        });
      panelFastDataPromises.set(productId, fastDataPromise);
      const { marketResult, productResult, slowVariant, slowFollow, firstData } =
        await fastDataPromise;

      if (!card?.isConnected) {
        panelFastDataPromises.delete(productId);
        if (panel) {
          panel.dataset.jzLoadStatus = "idle";
          panel.innerHTML = "";
        }
        return;
      }

      if (
        marketResult.status === "rejected" &&
        productResult.status === "rejected"
      ) {
        // 任务在队列里是 SUCCESS(allSettled 恒 fulfilled)但内容全失败 —— 不 evict
        // 的话「点击重试」会拿回同一份坏结果,永远无法真正重试。
        taskQueue.evict?.(`stats-${productId}`);
        panelFastDataPromises.delete(productId);
        showError();
        return;
      }

      // 会员门控兜底(门控查询 fail-open 放行但后端拦了/会员刚过期)
      if (productResult.status === "fulfilled" && productResult.value?.__featureGated) {
        panelFastDataPromises.delete(productId);
        renderLockedPanel();
        return;
      }

      panelDataCache.set(productId, firstData);

      // —— 首帧:stats/market 到手立即渲染;variants/跟卖数由 populate 到货即补 ——
      let populatePromise = null;
      if (typeof window.jzRenderProductPanelV2 === 'function') {
        if (!panel.getAttribute("data-jz-datacard")) {
          // 挂载时回退了旧骨架(极端情况)才需要在这里补渲染结构
          window.jzRenderProductPanelV2(panel, { sku: productId, initial: firstData });
        }
        if (panel) panel.dataset.jzLoadStatus = "ready";
        populatePromise = window.jzPopulatePanelV2(panel, productId, {
          preFetched: { stats: productResult, market: marketResult, variant: slowVariant, followCount: slowFollow },
          pageRub: tileRub,
          // sv 失败/无命中兜底:详情页曾抓过的 dims 真值(chrome.storage.local)
          fallbackDims: () => (window.jzReadCachedWeightDims?.(productId).catch(() => null) ?? null),
        }).catch(() => {});
      }

      // —— 全齐后收尾:终局合并并写入 panelDataCache ——
      const [variantResult, followSellResult] = await Promise.allSettled([slowVariant, slowFollow]);
      if (populatePromise) await populatePromise;

      if (!card?.isConnected) {
        panelFastDataPromises.delete(productId);
        if (panel) {
          panel.dataset.jzLoadStatus = "idle";
          panel.innerHTML = "";
        }
        return;
      }

      // sv 失败/auth issue 兜底:从 chrome.storage.local 读详情页采集的 cache
      const cachedWeightDims = (variantResult.status !== "fulfilled" || !variantResult.value?.items?.[0])
        ? await (window.jzReadCachedWeightDims?.(productId).catch(() => null) ?? null)
        : null;

      const data = window.jzMergeCardPanelData(
        marketResult.status === "fulfilled" ? marketResult.value : null,
        productResult.status === "fulfilled" ? productResult.value : null,
        variantResult.status === "fulfilled" ? variantResult.value : null,
        followSellResult.status === "fulfilled" && followSellResult.value
          ? {
              followSellCount: followSellResult.value.count,
              sellers: followSellResult.value.sellers,
            }
          : null,
        productId,
        cachedWeightDims,
      );
      // 把 fetch 结果挂到 cache 上,后续命中 cache 时 V2 走 preFetched 路径
      // 复用已有结果,避免再次往 backend / SW 发请求(存终局 SettledResult,
      // 不存在途 promise)。
      data.preFetched = {
        stats: productResult,
        market: marketResult,
        variant: variantResult,
        followCount: followSellResult,
      };
      panelDataCache.set(productId, data);
      projectSharedPanelVariantState(productId, data);
      panelFastDataPromises.delete(productId);
      // V1 老渲染兜底(V2 已在首帧渲染过,不重复整卡重绘)
      if (typeof window.jzRenderProductPanelV2 !== 'function') {
        window.jzRenderProductCardPanel(panel, data);
      }

      if (panel) panel.dataset.jzLoadStatus = "ready";
    } catch {
      panelFastDataPromises.delete(productId);
      showError();
    }
  }

  function ensureDataPanel(card) {
    if (card._ohPanelAttached) return;
    // 跳过没商品链接的 tile（推广位 / 占位 / 类目 chip 之类）
    if (!card.querySelector('a[href*="/product/"]')) return;
    card._ohPanelAttached = true;

    const panel = document.createElement("div");
    panel.className = "ozon-helper-data-panel";
    panel.setAttribute("lang", "zh-Hans");
    window.jzMountPanelStructure(panel, card);
    panel.dataset.jzLoadStatus = "pending";
    card.appendChild(panel);
    card._ohPanel = panel;
    const sellerStatus = document.createElement("section");
    sellerStatus.setAttribute("lang", "zh-Hans");
    card.appendChild(sellerStatus);
    card._ohSellerContextStatus = sellerStatus;
    card._ohSellerContextUnsubscribe = subscribeSellerContextStatus(sellerStatus);

    // 阻止整个 panel 的 click 冒泡到 Ozon tile（避免误触发跳转）
    panel.addEventListener("click", (e) => {
      const actionTarget = e.target.closest("[data-click-action], [data-action]");
      if (!actionTarget) return;
      e.preventDefault();
      e.stopPropagation();
      const action =
        actionTarget.getAttribute("data-click-action") ||
        actionTarget.getAttribute("data-action");
      handlePanelAction(action, card, panel, actionTarget);
    });

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            observer.disconnect();
            loadPanelData(card, panel);
          }
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(panel);
  }

  // ─── 点击事件分发 ──────────────────────────────────
  function getPanelFollowSellProduct(card, panel) {
    const info = extractCardInfo(card);
    const productId = extractProductId(info.url);
    if (!productId) return null;
    const cached = panelDataCache.get(productId) || {};
    return {
      sku: String(productId),
      productId: String(productId),
      url: info.url,
      followSellCount: cached.followSellCount,
    };
  }

  function handlePanelAction(action, card, panel, btn) {
    if (action === "open-seller-login") {
      if (btn?.disabled) return;
      if (btn) btn.disabled = true;
      Promise.resolve(window.sendMessage("openSellerLogin", {}))
        .catch(() => {})
        .finally(() => { if (btn) btn.disabled = false; });
      return;
    }

    if (action === "toggle-section") {
      window.JZSidebarSectionToggle?.toggleSidebarSection(btn);
      return;
    }

    // 字段设置齿轮:不依赖 info.url(放在 url 守卫之前),对全站数据卡生效。
    if (action === "open-field-settings") {
      window.jzOpenFieldSettings?.(panel);
      return;
    }

    const info = extractCardInfo(card);
    if (!info.url) return;

    if (action === "show-followsell-modal" || action === "view-sellers") {
      // Hero follow-sell stat: show our seller modal; keep Ozon URL fallback.
      const product = getPanelFollowSellProduct(card, panel);
      if (product && window.jzShowFollowSellListModal) {
        window.jzShowFollowSellListModal(btn, product, { trigger: "click" });
      } else {
        const sep = info.url.includes("?") ? "&" : "?";
        window.open(`${info.url}${sep}prefer_sellers=true`, "_blank");
      }
      return;
    }

    if (action === "open-followsell" || action === "follow-sell") {
      // 底部「一键跟卖」按钮:新 tab + URL hash 唤起主扩展上架面板(批采/AI 改图)
      window.open(info.url + "#jz-follow-sell", "_blank");
      return;
    }

    if (action === "edit-list") {
      handleEditList(card, panel, btn);
      return;
    }

    if (action === "collect-one") {
      handleCollectOne(card, panel, btn, info);
      return;
    }
  }




  async function panelDataForCollect(productId) {
    const cached = panelDataCache.get(productId);
    if (cached) return cached;
    const pending = panelFastDataPromises.get(productId);
    if (!pending) return null;
    try {
      const loaded = await pending;
      return panelDataCache.get(productId) || loaded?.firstData || null;
    } catch {
      return null;
    }
  }

  function sharedPanelVariantSlot(state) {
    if (state?.status === "pending") return state.promise;
    if (state?.status === "fulfilled") return { status: "fulfilled", value: state.value };
    if (state?.status === "rejected") return { status: "rejected", reason: state.error };
    return null;
  }

  function projectSharedPanelVariantState(productId, cachedPanelData) {
    const slot = sharedPanelVariantSlot(panelVariantRetryStates.get(productId));
    if (!slot) return;
    const targets = new Set([cachedPanelData, panelDataCache.get(productId)]);
    for (const target of targets) {
      if (target?.preFetched) target.preFetched.variant = slot;
    }
  }



  function buildPanelCollectRaw(productId, info, data) {
    return {
      sku: String(productId),
      url: info.url,
      name: info.name,
      price: info.price != null ? String(info.price) : undefined,
      priceCurrency: info.priceCurrency || undefined,
      marketingPrice: info.marketingPrice != null ? String(info.marketingPrice) : undefined,
      marketingPriceCurrency: info.marketingPriceCurrency || undefined,
      image: info.image || undefined,
      images: info.image ? [info.image] : undefined,
      hashtags: Array.isArray(info.hashtags) && info.hashtags.length ? [...info.hashtags] : undefined,
      soldCount: data?.soldCount ?? undefined,
      soldSum: data?.gmvSum != null ? String(data.gmvSum) : undefined,
      views: data?.views ?? undefined,
      convViewToOrder:
        data?.convViewToOrder != null ? String(data.convViewToOrder) : undefined,
      discount: data?.discount != null ? String(data.discount) : undefined,
      gmvSum: data?.gmvSum != null ? String(data.gmvSum) : undefined,
    };
  }

  function collectFailurePresentation(error) {
    const code = String(error?.code || "");
    const message = String(error?.message || "");
    if (/COLLECTOR_AUTH_REQUIRED|WEB_AUTH_REQUIRED/.test(code + message)) {
      return { text: "请先登录 Web", title: message || "请先登录 ozon 粽子 Web" };
    }
    if (
      /SELLER_CONTEXT_REQUIRED|SELLER_COMPANY_CONTEXT|AUTH_REQUIRED|NO_COMPANY_ID/.test(
        code + message,
      )
    ) {
      return { text: "Seller 未就绪", title: message || "Seller 公司上下文尚未就绪" };
    }
    if (/COLLECT_CAPTURE_INCOMPLETE/.test(code + message)) {
      const rawMissing = Array.isArray(error?.missing)
        ? error.missing.join("、")
        : message.split(":").slice(1).join(":");
      const compactMissing = rawMissing
        .replaceAll("长度", "长")
        .replaceAll("宽度", "宽")
        .replaceAll("高度", "高");
      return {
        text: `缺少：${compactMissing || "必要商品数据"}`,
        title: message,
      };
    }
    if (/OZON_ENRICH_INCOMPLETE|OZON_ENRICH_CONTRACT_MISMATCH/.test(code) || message.startsWith("缺少：")) {
      return { text: message || "商品补全资料不完整", title: message };
    }
    if (/OZON_ENRICH_BUSY/.test(code)) {
      return { text: "商品资料正在排队，请稍后重试", title: message };
    }
    if (/OZON_ENRICH_NOT_FOUND/.test(code)) {
      return { text: "未找到该商品的完整资料", title: message };
    }
    if (/OZON_ENRICH_UPSTREAM_FAILED/.test(code)) {
      return { text: "Ozon 商品资料暂时无法读取", title: message };
    }
    if (/NETWORK_ERROR|超时|timeout|网络/i.test(code + message)) {
      return { text: "网络错误", title: message };
    }
    return { text: "采集失败", title: message };
  }

  // 「采集」按钮与 action bar 上的「一键采集」语义统一，只写后台采集箱。
  //
  // resp shape: { dedupeHit, result }
  //   - dedupeHit:24h 内已采过同 SKU,SW 走 cache 没打 backend
  //   - result.id:backend OzonCollectBoxItem.id(可用于跳编辑页)
  // sendMessage 在 SW ok:false 时直接 reject(走外层 catch),不必检查 resp.ok。
  async function handleCollectOne(card, panel, btn, info) {
    if (btn.dataset.busy === "1") return;
    const productId = extractProductId(info.url);
    if (!productId) {
      _flashBtn(btn, "无效 SKU", "is-failed", 1500);
      return;
    }
    btn.dataset.busy = "1";
    btn.dataset.jzOriginalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "采集中…";
    try {
      const [data, enrichedInfo] = await Promise.all([
        panelDataForCollect(productId),
        enrichInfoWithDetailMarketingPrice(info),
      ]);
      info = enrichedInfo;
      const collectPromise = collectCoordinator.collect({
        sku: productId,
        raw: buildPanelCollectRaw(productId, info, data),
      });
      const resp = await collectPromise;

      const label = resp?.dedupeHit ? "近期已采集" : "已采集";
      _flashBtn(btn, label, "is-collected", 1800);
    } catch (e) {
      console.warn("[ozon-helper] data-panel collect-one failed:", e);
      if (collectCoordinator.getState(productId).status === "BLOCKED_AUTH") {
        btn.dataset.busy = "";
        btn.disabled = false;
        delete btn.dataset.jzOriginalHtml;
        const body = panel.querySelector(".ozon-helper-sidebar-card-body") || panel;
        window.jzRenderDataCardLoginRequired(body);
        return;
      }
      const failure = collectFailurePresentation(e);
      _flashBtn(btn, failure.text, "is-failed", 7000, failure.title);
    }
  }

  function _flashBtn(btn, text, cls, ms, title = "") {
    const original = btn.dataset.jzOriginalHtml || btn.innerHTML;
    const originalTitle = btn.getAttribute("title");
    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.classList.add(cls);
    btn.innerHTML = `<span class="oh-btn-icon">✓</span>${text}`;
    if (title) btn.setAttribute("title", title);
    setTimeout(() => {
      btn.classList.remove(cls);
      btn.innerHTML = original;
      delete btn.dataset.jzOriginalHtml;
      btn.dataset.busy = "";
      btn.disabled = false;
      if (originalTitle == null) btn.removeAttribute("title");
      else btn.setAttribute("title", originalTitle);
    }, ms);
  }

  // ─── 编辑上架：复刻 ozon-product.js:1599-1649 的 edit-list 流程 ──
  async function handleEditList(card, panel, btn) {
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "采集中…";

    try {
      let info = extractCardInfo(card);
      const sku = extractProductId(info.url);
      if (!sku) throw new Error("missing-sku");

      const [data, enrichedInfo] = await Promise.all([
        panelDataForCollect(sku),
        enrichInfoWithDetailMarketingPrice(info),
      ]);
      info = enrichedInfo;
      const collectPromise = collectCoordinator.collect({
        sku,
        raw: buildPanelCollectRaw(sku, info, data),
      });
      const resp = await collectPromise;
      const itemId = resp?.result?.id;
      // 从 brand webHost 直接构造,不要从 backendUrl 反推 — 旧 `.replace('/api','')`
      // 会把 `https://api.jizhangerp.com` 中 `://api` 后 4 字符 `/api` 误删,
      // 得到 `https:/.jizhangerp.com` 残缺 URL,浏览器按相对路径解析 →
      // 拼到 ozon.ru 下变成 `https://www.ozon.ru/.jizhangerp.com/...`。
      const frontendUrl = "http://127.0.0.1:3000";
      if (itemId) {
        window.open(
          `${frontendUrl}/ozon/products/collect/edit?id=${itemId}`,
          "_blank"
        );
      } else {
        window.open(`${frontendUrl}/ozon/products/collect`, "_blank");
      }
      btn.innerHTML = original;
      btn.disabled = false;
      btn.dataset.busy = "0";
    } catch (err) {
      console.warn("[ozon-helper] data-panel edit-list failed:", err);
      const sku = extractProductId(extractCardInfo(card).url);
      if (sku && collectCoordinator.getState(sku).status === "BLOCKED_AUTH") {
        const body = panel.querySelector(".ozon-helper-sidebar-card-body") || panel;
        window.jzRenderDataCardLoginRequired(body);
        return;
      }
      btn.innerHTML = collectFailurePresentation(err).text || "失败";
      setTimeout(() => {
        btn.innerHTML = original;
        btn.disabled = false;
        btn.dataset.busy = "0";
      }, 2000);
    }
  }

  function removeDataPanel(card) {
    card._ohSellerContextUnsubscribe?.();
    card._ohSellerContextUnsubscribe = null;
    card._ohSellerContextStatus?.remove();
    card._ohSellerContextStatus = null;
    if (card._ohPanel) {
      card._ohPanel.remove();
      card._ohPanel = null;
    }
    card._ohPanelAttached = false;
  }

  window.addEventListener?.("pagehide", () => {
    sellerStatusController.stop();
    clearTimeout(sellerSwitchNoticeTimer);
    sellerLoginFeedbackTimers.forEach((timer) => clearTimeout(timer));
    sellerLoginFeedbackTimers.clear();
  });
  window.addEventListener?.("pageshow", () => {
    if (sellerContextSubscribers.size > 0) sellerStatusController.start();
  });

  function getCards() {
    const cards = new Set();
    CARD_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((card) => cards.add(card));
    });
    return Array.from(cards);
  }

  function applyToAll() {
    if (isProductDetailPage()) {
      getCards().forEach((card) => removeDataPanel(card));
      return;
    }
    const cards = getCards();
    if (panelState.enabled) {
      cards.forEach((card) => ensureDataPanel(card));
    } else {
      cards.forEach((card) => removeDataPanel(card));
    }
  }

  // ─── 数据面板开关：从 chrome.storage.local 读 + 监听 onChanged ───
  // 旧版本是右下角浮动 toggle 按钮（.ozon-helper-panel-toggle）。
  // 现在统一移到极掌 popup 「工具与分析」分区里 toggle，状态持久化到
  // chrome.storage.local.ozon_data_panel_enabled。
  // 这里只订阅 storage 变化，自动 apply/remove 面板。
  const STORAGE_KEY = "ozon_data_panel_enabled";

  async function loadPanelEnabled() {
    try {
      const r = await chrome.storage.local.get(STORAGE_KEY);
      // 默认 true（首次安装时未设置 = 开启）
      panelState.enabled = r[STORAGE_KEY] !== false;
    } catch {
      panelState.enabled = true;
    }
  }

  function listenStorageToggle() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (!changes[STORAGE_KEY]) return;
        panelState.enabled = changes[STORAGE_KEY].newValue !== false;
        applyToAll();
      });
    } catch {}
  }

  function createObserver() {
    let pending = false;
    const observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        applyToAll();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── 启动 ─────────────────────────────────────────
  async function init() {
    // 搜索/类目/search-by-image 页由 ozon-search.js 管数据面板及采集器、
    // 关键词导航。本脚本仅负责"其他页面"——首页、品牌页、
    // 卖家店铺、收藏夹、商品详情页"也看了"等，避免跟 ozon-search 重复挂面板。
    if (window.OzonHelperSearchInjected) return;

    if (isProductDetailPage()) return;

    await loadPanelEnabled();
    listenStorageToggle();
    applyToAll();
    createObserver();

  }

  // shared-utils + collector libs 可能后于本脚本初始化（content_scripts 顺序虽固定，
  // 但 init 内部用到的全局可能受 site script 干扰）；用 idle callback 兜底
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
