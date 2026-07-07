/**
 * 数据面板 — 在所有 ozon.ru 商品卡下方注入「极掌 ERP」销量/转化数据卡。
 *
 * 跟 ozon-search.js 的关系：
 *   - 之前数据面板逻辑跟「选品模式 / 采集器 / 自动滚动 / 关键词导航」捆在 ozon-search.js
 *   - manifest matches 仅 search / category / search-by-image，其他页（首页、商品详情页推荐区、
 *     品牌页、卖家店铺页、收藏夹）注不进去 → 看不到数据卡
 *   - 抽出独立脚本 + manifest matches 改成 www.ozon.ru/*，全站注入
 *   - 选品模式等 search-only 功能仍留在 ozon-search.js
 *
 * 共用资源（shared-utils.js 提供，content_scripts 加载顺序保证）：
 *   - window.formatNumber
 *   - window.sendMessage
 *   - window.JZTaskQueue（用于节流并发请求）
 *   - window.JZCollectorDB（顺手把数据写入 IndexedDB sales store，供采集器复用）
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

  // skipPaths：商品详情页本体（/product/<id>/）已经有侧边栏数据卡，
  // 不要在它的"也看了" tile 上重复出现（会被商品详情侧边卡盖住信息）
  // 改主意：还是在所有 tile 上展示，这样用户在详情页也能直接对比"也看了"的数据。
  // 留空，全站注入。
  const SKIP_PATHS = [];

  const panelState = { enabled: true };
  const panelDataCache = new Map();
  let onlyWithSales = false;
  let collectorRunning = false;
  let cachedKeywordText = "";

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

  function keywordTextFromUrl(url) {
    try {
      return new URL(url, window.location.href).searchParams.get("text") || "";
    } catch {
      return "";
    }
  }

  async function refreshCachedKeywordText() {
    const fromUrl = keywordTextFromUrl(window.location.href) || keywordTextFromUrl(document.referrer || "");
    if (fromUrl) {
      cachedKeywordText = fromUrl;
      return cachedKeywordText;
    }
    try {
      const session = await window.JZCollectorDB?.getSession?.();
      const currentKeywordId = session?.currentKeywordId;
      if (!currentKeywordId) return cachedKeywordText;
      const keywords = await window.JZCollectorDB?.getKeywords?.();
      const kw = (keywords || []).find((item) => item.id === currentKeywordId);
      if (kw?.text) cachedKeywordText = kw.text;
    } catch {}
    return cachedKeywordText;
  }

  function getCurrentKeywordText() {
    return keywordTextFromUrl(window.location.href) || keywordTextFromUrl(document.referrer || "") || cachedKeywordText || "";
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

  function hasMarketingPrice(data, info) {
    return [
      info?.marketingPrice,
      data?.marketingPrice,
      data?.marketing_price,
      data?.marketingPriceCny,
      data?.marketing_price_cny,
      data?.blackPrice,
      data?.black_price,
      data?.blackPriceCny,
      data?.black_price_cny,
    ].some((value) => value !== undefined && value !== null && String(value).trim() !== "");
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

  async function waitForCollectorFilterData(card, data, info, panel) {
    let nextInfo = info;
    let softMarketingWaits = 0;
    let hardWaits = 0;
    let triedDetailPrice = false;
    const maybeEnrichDetailPrice = async () => {
      if (!triedDetailPrice) {
        triedDetailPrice = true;
        nextInfo = await enrichInfoWithDetailMarketingPrice(nextInfo);
      }
      return nextInfo;
    };
    while (true) {
      const missing = window.JZCollectorFilter?.getMissingFields
        ? window.JZCollectorFilter.getMissingFields(data, nextInfo)
        : [];
      const needsPrice = missing.some((key) => key === "price");
      const needsMarketingPrice = missing.some((key) => key === "marketingPrice");
      const hasMarketing = hasMarketingPrice(data, nextInfo);
      const shouldSoftWaitMarketing = !hasMarketing && softMarketingWaits < 6;
      if (!needsPrice && !needsMarketingPrice && !shouldSoftWaitMarketing) return await maybeEnrichDetailPrice();
      if (missing.length && !needsPrice && !needsMarketingPrice) return await maybeEnrichDetailPrice();
      if (!card?.isConnected) return await maybeEnrichDetailPrice();
      const panelStatus = panel?.dataset?.jzLoadStatus || "";
      if (panelStatus === "ready" || panelStatus === "error" || panel?.querySelector?.(".ozon-helper-panel-error")) {
        const refreshedInfo = extractCardInfo(card);
        nextInfo = mergeRefreshedCardInfo(nextInfo, refreshedInfo);
        if ((!needsMarketingPrice && !shouldSoftWaitMarketing) || hasMarketingPrice(data, nextInfo) || hardWaits >= 15) return await maybeEnrichDetailPrice();
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      const refreshedInfo = extractCardInfo(card);
      nextInfo = mergeRefreshedCardInfo(nextInfo, refreshedInfo);
      if (shouldSoftWaitMarketing) softMarketingWaits += 1;
      if (needsPrice || needsMarketingPrice) hardWaits += 1;
      if (hardWaits >= 15) return await maybeEnrichDetailPrice();
    }
  }

  // 格式化 + 数据合并 + 渲染逻辑统一放在 shared-utils.js,跟 ozon-search.js 共用。
  // 见 window.jzMergeCardPanelData / window.jzRenderProductCardPanel /
  //   window.jzRenderPanelSkeleton。


  // 渲染逻辑统一在 shared-utils.js 的 window.jzRenderProductCardPanel。

  // ─── 入桶（沿用原逻辑：仅在搜索/类目页有 keyword 时落 IndexedDB） ─────
  function buildSaleRecord(productId, info, data) {
    const keyword = getCurrentKeywordText();
    const raw = data ? { ...data } : {};
    if (keyword) raw.keyword = keyword;
    const hashtags = Array.isArray(info.hashtags) ? info.hashtags.filter(Boolean) : [];
    if (hashtags.length) {
      raw.hashtags = hashtags;
      raw._aiHashtags = hashtags;
    }
    if (info.marketingPrice != null) {
      raw.marketingPrice = info.marketingPrice;
      raw.marketingPriceCurrency = info.marketingPriceCurrency || "RUB";
      raw._marketingPriceSource = info.marketingPriceSource || "card";
    }
    if (info.greenPrice != null) {
      raw.greenPrice = info.greenPrice;
      raw.greenPriceCurrency = info.greenPriceCurrency || "RUB";
      raw._greenPriceSource = info.greenPriceSource || info.marketingPriceSource || "card";
    }
    return {
      sku: String(productId),
      url: info.url || "",
      name: info.name || "",
      price: info.price != null ? String(info.price) : null,
      priceCurrency: info.priceCurrency || null,
      image: info.image || "",
      soldCount: data?.soldCount ?? null,
      gmvSum: data?.gmvSum != null ? String(data.gmvSum) : null,
      views: data?.views ?? null,
      convViewToOrder:
        data?.convViewToOrder != null ? String(data.convViewToOrder) : null,
      discount: data?.discount != null ? String(data.discount) : null,
      keyword,
      hashtags: hashtags.length ? hashtags : undefined,
      collectedAt: Date.now(),
      status: "local",
      raw: Object.keys(raw).length ? raw : null,
    };
  }

  // 仅在采集器手动启动后入桶（首页推荐 / 商品详情"也看了" / 品牌页等）。
  // 停止时仍可展示数据面板，但不会写入采集器本地桶。
  // 注：keyword 字段在非 search 页面会是 ''（无关键词上下文），仍然按 sku 落库。
  async function collectSaleIfMatched(productId, card, info, data, panel) {
    if (!shouldPersistToBucket()) return false;
    const sourceData = window.jzExtractPanelFilterData
      ? window.jzExtractPanelFilterData(panel, info, data || {})
      : (data || {});
    const readyInfo = await waitForCollectorFilterData(card, sourceData, info, panel);
    if (!shouldPersistToBucket()) return false;
    const readyData = window.jzExtractPanelFilterData
      ? window.jzExtractPanelFilterData(panel, readyInfo, sourceData)
      : sourceData;
    if (readyInfo && passCollectorFilters(readyData, readyInfo)) {
      try {
        if (!window.JZCollectorDB?.putSale) return false;
        const record = buildSaleRecord(productId, readyInfo, readyData);
        if (!shouldPersistToBucket()) return false;
        await window.JZCollectorDB.putSale(record);
        window.JZCollectorToast?.localCollectSuccess?.(record.sku);
        return true;
      } catch {}
    }
    return false;
  }

  function passCollectorFilters(data, info) {
    if (onlyWithSales) {
      const sold = Number(data?.soldCount);
      if (!Number.isFinite(sold) || sold <= 0) return false;
    }
    return window.JZCollectorFilter?.matches ? window.JZCollectorFilter.matches(data, info) : true;
  }

  function shouldPersistToBucket() {
    return collectorRunning;
  }

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
    const renderLockedPanel = () => {
      if (!panel) return;
      panel.dataset.jzLoadStatus = "ready";
      window.jzRenderPanelSkeleton(panel); // 复用卡头(品牌 + 齿轮)
      const body = panel.querySelector(".ozon-helper-sidebar-card-body") || panel;
      window.jzRenderDataCardLocked(body);
    };
    const gate = await window.jzDataCardAllowed();
    if (!gate.allowed) {
      renderLockedPanel();
      return;
    }

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
      await collectSaleIfMatched(productId, card, info, cached, panel);
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
      const { marketResult, productResult, slowVariant, slowFollow } =
        await taskQueue.add(`stats-${productId}`, fetchTask);

      if (!card?.isConnected) {
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
        showError();
        return;
      }

      // 会员门控兜底(门控查询 fail-open 放行但后端拦了/会员刚过期)
      if (productResult.status === "fulfilled" && productResult.value?.__featureGated) {
        renderLockedPanel();
        return;
      }

      // —— 首帧:stats/market 到手立即渲染;variants/跟卖数由 populate 到货即补 ——
      let populatePromise = null;
      if (typeof window.jzRenderProductPanelV2 === 'function') {
        const firstData = window.jzMergeCardPanelData(
          marketResult.status === "fulfilled" ? marketResult.value : null,
          productResult.status === "fulfilled" ? productResult.value : null,
          null,
          null,
          productId,
          null,
        );
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

      // —— 全齐后收尾:终局合并落 panelDataCache + 采集落桶(落桶的过滤条件读面板
      // DOM,须等 populate 把慢车道字段填完)——
      const [variantResult, followSellResult] = await Promise.allSettled([slowVariant, slowFollow]);
      if (populatePromise) await populatePromise;

      if (!card?.isConnected) {
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
      // V1 老渲染兜底(V2 已在首帧渲染过,不重复整卡重绘)
      if (typeof window.jzRenderProductPanelV2 !== 'function') {
        window.jzRenderProductCardPanel(panel, data);
      }

      if (panel) panel.dataset.jzLoadStatus = "ready";
      await collectSaleIfMatched(productId, card, info, data, panel);
    } catch {
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

  // 「采集」按钮:与 action bar 上的「一键采集」语义统一,写 backend 采集箱
  // (pushSourceCollect)。同时保留本地 IndexedDB 写入,供「极掌采集器」关键词
  // 巡航的桶视图复用 sale record。绕过 collectorRunning gate(用户主动点 = 显式同意)。
  //
  // resp shape (SW ENVELOPE_FIX 2025-05):{ dedupeHit, lastAt, result }
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
    try {
      const data = panelDataCache.get(productId) || null;
      info = await enrichInfoWithDetailMarketingPrice(info);

      // 1. searchVariants 补 sv 数据(品牌/类目/属性等富字段),失败兜底空
      const variantResp = await window
        .sendMessage("searchVariants", { sku: productId })
        .catch(() => null);
      const variantItems =
        variantResp?.items || variantResp?.data?.items || [];
      const variantMatch =
        variantItems.find((it) => String(it.variant_id) === productId) ||
        variantItems[0] ||
        null;
      if (variantMatch && Array.isArray(info.hashtags) && info.hashtags.length) {
        try { window.JZFollowSellContentCopy?.mergeSourceHashtagsIntoVariant?.(variantMatch, info.hashtags); } catch {}
      }

      // 2. 写 backend 采集箱(主路径) + 写本地 IndexedDB(兼容采集器桶)
      const collectPayload = {
        sku: String(productId),
        url: info.url,
        name: info.name,
        price: info.price != null ? String(info.price) : undefined,
        priceCurrency: info.priceCurrency || undefined,
        marketingPrice: info.marketingPrice != null ? String(info.marketingPrice) : undefined,
        marketingPriceCurrency: info.marketingPriceCurrency || undefined,
        image: info.image || undefined,
        images: info.image ? [info.image] : undefined,
        variantData: variantMatch || undefined,
        soldCount: data?.soldCount ?? undefined,
        soldSum: data?.gmvSum != null ? String(data.gmvSum) : undefined,
        views: data?.views ?? undefined,
        convViewToOrder:
          data?.convViewToOrder != null ? String(data.convViewToOrder) : undefined,
        discount: data?.discount != null ? String(data.discount) : undefined,
        gmvSum: data?.gmvSum != null ? String(data.gmvSum) : undefined,
      };
      const resp = await window.sendMessage("pushSourceCollect", {
        sourceId: "ozon",
        raw: collectPayload,
      });

      // 本地桶 (失败静默,backend 写成功就算采集成功;桶仅服务关键词巡航 UI)
      try {
        const keyword = getCurrentKeywordText();
        const fallbackRaw = {};
        if (keyword) fallbackRaw.keyword = keyword;
        if (Array.isArray(info.hashtags) && info.hashtags.length) {
          fallbackRaw.hashtags = info.hashtags;
          fallbackRaw._aiHashtags = info.hashtags;
        }
        if (info.marketingPrice != null) {
          fallbackRaw.marketingPrice = info.marketingPrice;
          fallbackRaw.marketingPriceCurrency = info.marketingPriceCurrency || "RUB";
          fallbackRaw._marketingPriceSource = info.marketingPriceSource || "card";
          fallbackRaw.greenPrice = info.greenPrice ?? undefined;
          fallbackRaw.greenPriceCurrency = info.greenPrice != null ? (info.greenPriceCurrency || "RUB") : undefined;
          fallbackRaw._greenPriceSource = info.greenPrice != null ? (info.greenPriceSource || info.marketingPriceSource || "card") : undefined;
        }
        const record = data
          ? buildSaleRecord(productId, info, data)
          : {
              sku: String(productId),
              url: info.url || "",
              name: info.name || "",
              price: info.price != null ? String(info.price) : null,
              priceCurrency: info.priceCurrency || null,
              image: info.image || "",
              keyword,
              hashtags: Array.isArray(info.hashtags) && info.hashtags.length ? info.hashtags : undefined,
              collectedAt: Date.now(),
              raw: Object.keys(fallbackRaw).length ? fallbackRaw : null,
            };
        await window.JZCollectorDB?.putSale(record);
      } catch (e) {
        console.warn(
          "[ozon-helper] data-panel collect-one local-bucket write failed:",
          e
        );
      }

      const label = resp?.dedupeHit ? "近期已采集" : "已采集";
      _flashBtn(btn, label, "is-collected", 1800);
    } catch (e) {
      console.warn("[ozon-helper] data-panel collect-one failed:", e);
      const msg = e?.message || "";
      const friendly = /NETWORK_ERROR|超时|timeout|网络/i.test(msg)
        ? "网络错误"
        : "失败";
      _flashBtn(btn, friendly, "is-failed", 1800);
    } finally {
      btn.dataset.busy = "";
    }
  }

  function _flashBtn(btn, text, cls, ms) {
    const original = btn.innerHTML;
    btn.classList.add(cls);
    btn.innerHTML = `<span class="oh-btn-icon">✓</span>${text}`;
    setTimeout(() => {
      btn.classList.remove(cls);
      btn.innerHTML = original;
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
      const info = await enrichInfoWithDetailMarketingPrice(extractCardInfo(card));
      const sku = extractProductId(info.url);
      if (!sku) throw new Error("missing-sku");

      const variantResp = await window
        .sendMessage("searchVariants", { sku })
        .catch(() => null);
      const variantItems = variantResp?.items || variantResp?.data?.items || [];
      const variantMatch =
        variantItems.find((it) => String(it.variant_id) === sku) ||
        variantItems[0] ||
        null;
      if (variantMatch && Array.isArray(info.hashtags) && info.hashtags.length) {
        try { window.JZFollowSellContentCopy?.mergeSourceHashtagsIntoVariant?.(variantMatch, info.hashtags); } catch {}
      }

      const collectPayload = {
        sku,
        url: info.url,
        name: info.name,
        price: info.price != null ? String(info.price) : undefined,
        priceCurrency: info.priceCurrency || undefined,
        marketingPrice: info.marketingPrice != null ? String(info.marketingPrice) : undefined,
        marketingPriceCurrency: info.marketingPriceCurrency || undefined,
        image: info.image || undefined,
        images: info.image ? [info.image] : undefined,
        variantData: variantMatch || undefined,
      };
      // SW 把 envelope (dedupeHit/lastAt) + 后端 result 都装进 data,这里 resp 已是
      // { dedupeHit, lastAt, result }。itemId 在 result.id。
      const resp = await window.sendMessage("pushSourceCollect", {
        sourceId: "ozon",
        raw: collectPayload,
      });
      const itemId = resp?.result?.id;
      const auth = await window.sendMessage("getAuth");
      // 从 brand webHost 直接构造,不要从 backendUrl 反推 — 旧 `.replace('/api','')`
      // 会把 `https://api.jizhangerp.com` 中 `://api` 后 4 字符 `/api` 误删,
      // 得到 `https:/.jizhangerp.com` 残缺 URL,浏览器按相对路径解析 →
      // 拼到 ozon.ru 下变成 `https://www.ozon.ru/.jizhangerp.com/...`。
      const frontendUrl = "http://127.0.0.1:5173";
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
      btn.innerHTML = "失败";
      setTimeout(() => {
        btn.innerHTML = original;
        btn.disabled = false;
        btn.dataset.busy = "0";
      }, 2000);
    }
  }

  function removeDataPanel(card) {
    if (card._ohPanel) {
      card._ohPanel.remove();
      card._ohPanel = null;
    }
    card._ohPanelAttached = false;
  }

  function getCards() {
    const cards = new Set();
    CARD_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((card) => cards.add(card));
    });
    return Array.from(cards);
  }

  function applyToAll() {
    const cards = getCards();
    if (panelState.enabled) {
      cards.forEach((card) => ensureDataPanel(card));
    } else {
      cards.forEach((card) => removeDataPanel(card));
    }
  }

  function collectCurrentCardsOnce() {
    if (!collectorRunning) return;
    const cards = getCards();
    cards.forEach((card) => ensurePanelLoadStarted(card, { forceCollect: true }));
  }

  function ensurePanelLoadStarted(card, options = {}) {
    if (!collectorRunning || !panelState.enabled || !card) return null;
    if (!card.querySelector('a[href*="/product/"]')) return null;
    ensureDataPanel(card);
    const panel = card._ohPanel || card.querySelector?.(".ozon-helper-data-panel");
    if (!panel) return null;
    const status = panel.dataset.jzLoadStatus || "";
    if (!status || status === "idle" || status === "pending" || (options.forceCollect && status === "ready")) {
      loadPanelData(card, panel);
    }
    return panel;
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

  // ─── 极掌采集器（非 search 页同款功能）────────────────
  // search/category 由 ozon-search.js 处理；本节负责首页 / 品牌 / 卖家 /
  // 商品详情"也看了" 等所有其他 ozon 页面。
  // 默认开:浮窗用于手动启动/停止采集;真正入桶由 collectorRunning 控制,默认停止。
  const COLLECTOR_KEY = "ozon_collector_enabled";
  let collectorEnabled = true;
  let _collectorPanel = null;
  let _autoScroller = null;
  let _antiBan = null;

  async function loadCollectorEnabled() {
    try {
      const r = await chrome.storage.local.get(COLLECTOR_KEY);
      collectorEnabled = r[COLLECTOR_KEY] !== false;
    } catch {
      collectorEnabled = true;
    }
  }

  function unmountCollectorHere() {
    collectorRunning = false;
    if (_collectorPanel) {
      try { _collectorPanel.unmount(); } catch {}
      _collectorPanel = null;
    }
    if (_autoScroller) {
      try { _autoScroller.stop && _autoScroller.stop(); } catch {}
      _autoScroller = null;
    }
    if (_antiBan) {
      try { _antiBan.stop && _antiBan.stop(); } catch {}
      _antiBan = null;
    }
  }

  function listenCollectorToggle() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[COLLECTOR_KEY]) return;
        collectorEnabled = changes[COLLECTOR_KEY].newValue !== false;
        if (collectorEnabled) mountCollectorHere();
        else unmountCollectorHere();
      });
    } catch {}
  }

  function mountCollectorHere() {
    if (!collectorEnabled) return;
    if (_collectorPanel || !window.JZCollectorPanel) return;

    function isDataPanelSettled(panel) {
      if (!panel) return false;
      const status = panel.dataset.jzLoadStatus || '';
      if (status === 'ready' || status === 'error') return true;
      if (panel.querySelector('.ozon-helper-panel-error')) return true;
      if (panel.querySelector('.is-skeleton, .is-skeleton-section, .oh-skeleton-row')) return false;
      return status === 'ready';
    }

    function isCurrentViewportDataReady() {
      if (!collectorRunning || !panelState.enabled) return true;
      const cards = getCards().filter((card) => {
        if (!card.querySelector('a[href*="/product/"]')) return false;
        const rect = card.getBoundingClientRect();
        return rect.bottom > -80 && rect.top < window.innerHeight + 80;
      });
      if (!cards.length) return true;
      return cards.every((card) => isDataPanelSettled(ensurePanelLoadStarted(card)));
    }

    // autoScroller：在首页 / 品牌 / 卖家 等 lazy-load 列表里也有用
    if (window.JZAutoScroller && !_autoScroller) {
      try {
        _autoScroller = new window.JZAutoScroller({
          queue: taskQueue,
          intervalMs: 500,
          settleMs: 1000,
          scrollStepRatio: 0.95,
          minScrollStepPx: 680,
          emptyThreshold: 5,
          readinessPollMs: 300,
          maxReadinessWaitMs: 20000,
          isReadyToScroll: () => isCurrentViewportDataReady(),
          getCardCount: () => getCards().length,
          onCongestionPause: (which) => {
            if (!_collectorPanel) return;
            _collectorPanel.setAutoScrollerState({
              running: _autoScroller.isUserActive(),
              autoPaused: _autoScroller.isAutoPaused(),
            });
            _collectorPanel.toast(
              which === "paused" ? "队列拥塞，自动暂停翻页" : "队列恢复，继续翻页",
              "info",
              1800,
            );
          },
          onEmpty: () => {
            if (!_collectorPanel) return;
            _collectorPanel.setAutoScrollerState({ running: false, autoPaused: false });
            _collectorPanel.toast("当前页已抓取完成", "success", 1800);
          },
        });
      } catch {}
    }

    // antiBan：监控失败率
    if (window.JZAntiBanGuard && !_antiBan) {
      try {
        _antiBan = new window.JZAntiBanGuard({
          queue: taskQueue,
          windowSize: 20,
          failureRateThreshold: 0.5,
          cooldownMs: 60000,
          onTrigger: (msg) => {
            _collectorPanel?.toast(msg, "error", 5000);
          },
        });
        _antiBan.start();
      } catch {}
    }

    _collectorPanel = window.JZCollectorPanel.create({
      queue: taskQueue,
      db: window.JZCollectorDB,
      onPushClick: async () => {
        try {
          if (!window.JZCollectorDB) {
            return { ok: false, message: "IndexedDB not ready" };
          }
          const all = await window.JZCollectorDB.getAllSales({ status: "local" });
          if (!all.length) {
            return { ok: true, message: "本地桶无待推送" };
          }

          const items = all.map((rec) => {
            const vres = rec.raw?.preFetched?.variant;
            const vitems = vres?.status === "fulfilled"
              ? (vres.value?.items || vres.value?.data?.items || [])
              : [];
            const variantMatch =
              vitems.find((it) => String(it.variant_id) === String(rec.sku)) ||
              vitems[0] ||
              null;
            const svCat = window.jzExtractCatalogFromSv
              ? window.jzExtractCatalogFromSv(variantMatch)
              : null;
            const name = window.jzPreferSourceName
              ? window.jzPreferSourceName(svCat?.name, rec.name)
              : (rec.name || svCat?.name || "");
            const images = svCat?.images?.length ? svCat.images : (rec.image ? [rec.image] : []);
            return {
              sku: String(rec.sku),
              url: rec.url || undefined,
              name: name || undefined,
              price: rec.price != null ? rec.price : undefined,
              priceCurrency: rec.priceCurrency || undefined,
              marketingPrice: rec.raw?.marketingPrice != null ? String(rec.raw.marketingPrice) : undefined,
              marketingPriceCurrency: rec.raw?.marketingPriceCurrency || undefined,
              image: svCat?.mainImage || rec.image || undefined,
              images: images.length ? images : undefined,
              variantData: variantMatch || undefined,
              soldCount: rec.soldCount ?? undefined,
              gmvSum: rec.gmvSum != null ? rec.gmvSum : undefined,
              views: rec.views ?? undefined,
              convViewToOrder: rec.convViewToOrder != null ? rec.convViewToOrder : undefined,
              discount: rec.discount != null ? rec.discount : undefined,
            };
          });

          let created = 0;
          let updated = 0;
          let failed = 0;
          for (let i = 0; i < items.length; i += 100) {
            const chunk = items.slice(i, i + 100);
            const resp = await new Promise((resolve) => {
              chrome.runtime.sendMessage(
                { action: "pushSourceCollectBatch", sourceId: "ozon", items: chunk },
                resolve,
              );
            });
            if (!resp?.ok) {
              return { ok: false, message: resp?.error || "推送失败" };
            }
            const results = resp.data?.results || [];
            const errors = resp.data?.errors || [];
            const successResults = results.filter((r) => r?.action === "created" || r?.action === "updated");
            created += successResults.filter((r) => r.action === "created").length;
            updated += successResults.filter((r) => r.action === "updated").length;
            failed += errors.length + Math.max(0, chunk.length - successResults.length - errors.length);
            const okSkus = successResults
              .map((r) => String(r.sku || ""))
              .filter(Boolean);
            if (okSkus.length) {
              try {
                await window.JZCollectorDB.markPushed(okSkus);
              } catch {}
            }
          }
          const failTail = failed ? ` / 失败 ${failed}` : "";
          return { ok: failed === 0, message: `推送完成：新增 ${created} / 更新 ${updated}${failTail}` };
        } catch (e) {
          return { ok: false, message: e.message || "推送失败" };
        }
      },
      onClearClick: () => window.JZCollectorDB?.clearSales(),
      onToggleRunning: (next) => {
        // Start/stop only controls writes to the local bucket.
        collectorRunning = !!next;
        if (next) {
          collectCurrentCardsOnce();
        } else {
          if (_autoScroller) _autoScroller.stop();
          _collectorPanel?.setAutoScrollerState({ running: false, autoPaused: false });
          applyToAll();
        }
      },
      onAutoScrollToggle: (next) => {
        if (!_autoScroller) return;
        if (next && !collectorRunning) {
          _autoScroller.stop();
          _collectorPanel?.setAutoScrollerState({ running: false, autoPaused: false });
          _collectorPanel?.toast?.("请先启动采集", "info", 1600);
          return;
        }
        if (next) _autoScroller.start();
        else _autoScroller.stop();
        _collectorPanel?.setAutoScrollerState({
          running: _autoScroller.isUserActive(),
          autoPaused: _autoScroller.isAutoPaused(),
        });
      },
      onSalesFilterChange: (next) => {
        onlyWithSales = !!next;
      },
      // keyword pilot 在非 search 页面没意义（无 ?text= 参数语义），
      // 不传 onKeywordsStart 让 panel 自然降级（按钮无响应）
    });
    _collectorPanel.mount();
    _collectorPanel.setRunning(collectorRunning);
    onlyWithSales = _collectorPanel.getInitialSalesFilter();
  }

  // ─── 启动 ─────────────────────────────────────────
  async function init() {
    // 搜索/类目/search-by-image 页由 ozon-search.js 管数据面板（它跟选品模式、
    // 采集器、关键词导航深度耦合）。本脚本仅负责"其他页面"——首页、品牌页、
    // 卖家店铺、收藏夹、商品详情页"也看了"等，避免跟 ozon-search 重复挂面板。
    if (window.OzonHelperSearchInjected) return;

    if (
      SKIP_PATHS.some((p) =>
        new RegExp(`^${p.replace(/\*/g, ".*")}$`).test(window.location.pathname)
      )
    ) {
      return;
    }

    // 鉴权检查：未登录就不加载（避免无 token 调极掌后端打 401 产生 spam）
    try {
      const auth = await window.checkAuth?.();
      if (auth && !auth.loggedIn) return;
    } catch {
      // checkAuth 失败也按未登录处理
      return;
    }

    try {
      await window.JZCollectorDB?.init();
    } catch {}
    await refreshCachedKeywordText();

    await loadPanelEnabled();
    listenStorageToggle();
    applyToAll();
    createObserver();

    // 极掌采集器：在所有有商品卡的 ozon.ru 页面（首页 / 品牌 / 卖家 /
    // 商品详情"也看了" 等）也挂载浮动采集器面板，受 popup 里的 toggle 控制。
    // search/category 页由 ozon-search.js 自行处理（它跟 keyword pilot 深度耦合），
    // 本脚本不在那些路径执行（被 OzonHelperSearchInjected flag 拦掉，见 init 顶部）。
    await loadCollectorEnabled();
    listenCollectorToggle();
    if (collectorEnabled) mountCollectorHere();
  }

  // shared-utils + collector libs 可能后于本脚本初始化（content_scripts 顺序虽固定，
  // 但 init 内部用到的全局可能受 site script 干扰）；用 idle callback 兜底
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
