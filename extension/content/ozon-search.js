(function() {
  'use strict';

  // 标记：ozon-search.js 已经在本页注入。
  // ozon-data-panel.js 看到这个 flag 就跳过自己的数据面板渲染逻辑，
  // 让搜索/类目页继续由 ozon-search.js 一手管（含选品模式 / 采集器联动）。
  window.OzonHelperSearchInjected = true;
  // 注:L1 (composer-api 拦截) bridge 已经在 content/collector/l1-bridge.js 注入,
  // 不在本文件耦合,见 manifest content_scripts。

  const SELECTORS = [
    '[data-widget="searchResultsV2"] > div > div',
    '[data-widget="searchResults"] > div > div',
    '[data-widget="searchResultsV2"] [data-widget="searchResultsItem"]',
    '[data-widget="searchResults"] [data-widget="searchResultsItem"]',
    '.tile-root',
  ];

  // --- Data Panel State ---
  // panelState.enabled = 数据面板自动加载开关。新用户默认开(true)— 搜索/类目页
  // 一进来卡片就自动挂面板、拉数据填充。老用户在 popup 里显式关过会读出来保持关。
  // !! 不再耦合"采集器写入" — collectorRunning 是单独 flag,见下方。
  const panelState = { enabled: true };
  const panelDataCache = new Map();

  // collectorRunning = 是否把 panel 数据写入 IndexedDB 本地桶(真正的"采集动作")。
  // 默认 false:新用户进搜索页只看 panel 数据展示,不自动落桶。
  // 用户点采集器面板的"采集中"按钮才开始落桶。跟 panelState.enabled 完全解耦:
  // 采集器停了 panel 仍照常加载显示。
  let collectorRunning = false;
  let keywordPilotOwnsCollectorRunning = false;
  const COLLECTOR_RUNNING_STORAGE_KEY = 'ozon_collector_running';

  // --- Collector: TaskQueue + IndexedDB + 浮动面板 ---
  // queue 由 collector/task-queue.js 提供（content_scripts 注入顺序保证）
  const taskQueue = new window.JZTaskQueue({
    concurrency: 6,         // 数据面板请求并发上限(backend 走的 market/product stats)
    timeoutMs: 60000,
    autoPauseHigh: 12,
    autoPauseLow: 6,
    pauseLowPending: 12,
  });

  // staggered queue 工厂已下沉 shared-utils(window.jzMakeStaggeredQueue),
  // 与 ozon-data-panel.js 共用同一份实现,防两份漂移。

  // searchVariants: seller-portal chrome.scripting.executeScript,反爬指纹敏感,
  // 30+ 卡同时打容易 403 雪崩。2 并发 + 300ms stagger。
  // fleet 服务端取数灰度命中时放宽(下方 setParams):请求走后端,SW 侧
  // FLEET_MAX_INFLIGHT=6 并发闸兜底,这层 stagger 只剩拖慢;非灰度/查询失败
  // 保持保守默认(老路 SW _sellerPortalGate 200ms 仍是全局兜底)。
  const variantsQueue = window.jzMakeStaggeredQueue({ concurrency: 2, staggerMs: 300 });
  window.sendMessage('getFleetServersideFlag', {})
    .then((d) => { if (d?.on) variantsQueue.setParams({ concurrency: 6, staggerMs: 0 }); })
    .catch(() => {});

  // jzFetchPublicFollowSell: composer-api 同源 fetch,heavier than seller-portal,
  // 比 variants 更保守:1 并发 + 500ms stagger,且 cache 命中(4h)时 0 网络成本,
  // 真正受限的只有首次访问的 SKU。
  const followSellQueue = window.jzMakeStaggeredQueue({ concurrency: 1, staggerMs: 500 });
  let collectorPanel = null;
  let autoScroller = null;
  let keywordPilot = null;
  let antiBanGuard = null;
  // 仅抓有销量数据 — 影响 putSale 的入桶判断
  let onlyWithSales = false;

  function getCards() {
    const cards = new Set();
    SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((card) => cards.add(card));
    });
    return Array.from(cards);
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

  function getCurrentKeywordText() {
    const fromUrl = new URLSearchParams(window.location.search).get('text') || '';
    if (fromUrl) return fromUrl;
    try {
      return keywordPilot?.getState?.()?.currentKeyword?.text || '';
    } catch {
      return '';
    }
  }

  function extractCardInfo(card) {
    const link = card.querySelector('a[href*="/product/"]');
    const img = card.querySelector('img');

    // 名称优先级（避开 Chrome 翻译污染）：
    //   1. <a aria-label>            ← attribute，不被翻译
    //   2. <img alt>                 ← attribute，不被翻译
    //   3. <a> textContent           ← 翻译态下是中文，**仅在非翻译态使用**
    // 翻译态下若都拿不到原始名，name 留空，让后端走 search-variant-model
    // attr 4180 拿原始俄/英文名。
    const ariaLabel = (link?.getAttribute('aria-label') || '').trim();
    const imgAlt = (img?.getAttribute('alt') || '').trim();
    const translated = window.jzIsTranslated?.();
    const textTitle = translated
      ? ''
      : (
        link?.textContent?.trim() ||
        card.querySelector('[data-widget="searchResultsV2"]')?.textContent?.trim() ||
        card.textContent?.trim().slice(0, 120) ||
        ''
      );
    // 角标(Новинка / 0% до N дней 分期等)会被 textContent 抓进名字,剥掉它们;
    // 整串都是角标时留空,让后端 attr 4180 兜底拿原始俄文名。
    const rawTitle = ariaLabel || imgAlt || textTitle;
    const cleanedTitle = window.jzCleanOzonCardTitle
      ? window.jzCleanOzonCardTitle(rawTitle)
      : rawTitle;
    const title = window.jzStripPromo
      ? window.jzStripPromo(cleanedTitle)
      : cleanedTitle;

    const priceNode = card.querySelector('[data-widget="searchResultsPrice"]') ||
      card.querySelector('[data-widget="searchResultsV2"] [data-widget="webPrice"]') ||
      card.querySelector('[data-widget="webPrice"]');
    const priceText = extractVisiblePriceText(card, priceNode);
    const price = window.normalizePrice(priceText);
    const priceCurrency = detectPriceCurrency(priceText);
    const priceTags = window.jzExtractOzonCalcPriceTags
      ? window.jzExtractOzonCalcPriceTags(card)
      : (window.jzExtractOzonPriceTags ? window.jzExtractOzonPriceTags(card) : {});

    return {
      url: link?.href || '',
      name: title,
      price,
      priceCurrency,
      marketingPrice: priceTags.blackPrice ?? null,
      marketingPriceCurrency: priceTags.blackPriceCurrency || null,
      marketingPriceSource: priceTags.blackPrice != null ? 'card' : null,
      greenPrice: priceTags.greenPrice ?? null,
      greenPriceCurrency: priceTags.greenPriceCurrency || null,
      greenPriceSource: priceTags.greenPrice != null ? 'card' : null,
      image: img?.getAttribute('src') || img?.getAttribute('data-src') || '',
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
    ].some((value) => value !== undefined && value !== null && String(value).trim() !== '');
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
      name: '',
      image: '',
      price: null,
      priceCurrency: null,
      marketingPrice: priceTags.blackPrice ?? info.marketingPrice ?? null,
      marketingPriceCurrency: priceTags.blackPriceCurrency || info.marketingPriceCurrency || null,
      marketingPriceSource: priceTags.blackPrice != null ? 'pdp' : (info.marketingPriceSource || null),
      greenPrice: priceTags.greenPrice ?? info.greenPrice ?? null,
      greenPriceCurrency: priceTags.greenPriceCurrency || info.greenPriceCurrency || null,
      greenPriceSource: priceTags.greenPrice != null ? 'pdp' : (info.greenPriceSource || null),
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
      const needsPrice = missing.some((key) => key === 'price');
      const needsMarketingPrice = missing.some((key) => key === 'marketingPrice');
      const hasMarketing = hasMarketingPrice(data, nextInfo);
      const shouldSoftWaitMarketing = !hasMarketing && softMarketingWaits < 6;
      if (!needsPrice && !needsMarketingPrice && !shouldSoftWaitMarketing) return await maybeEnrichDetailPrice();
      if (missing.length && !needsPrice && !needsMarketingPrice) return await maybeEnrichDetailPrice();
      if (!card?.isConnected) return await maybeEnrichDetailPrice();
      const panelStatus = panel?.dataset?.jzLoadStatus || '';
      if (panelStatus === 'ready' || panelStatus === 'error' || panel?.querySelector?.('.ozon-helper-panel-error')) {
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

  function ensureBadge(card) {
    let badge = card.querySelector('.ozon-helper-card-badge');
    if (badge) {
      return badge;
    }
    badge = document.createElement('div');
    badge.className = 'ozon-helper-card-badge';

    const priceNode = card.querySelector('[data-widget="searchResultsPrice"]') ||
      card.querySelector('[data-widget="webPrice"]');
    const priceText = extractVisiblePriceText(card, priceNode);
    const price = window.normalizePrice(priceText);
    const oldPriceNode = card.querySelector('[data-widget="searchResultsOldPrice"]') ||
      card.querySelector('[data-widget="oldPrice"]');
    const oldPriceText = oldPriceNode?.textContent || '';
    const oldPrice = window.normalizePrice(oldPriceText);
    const discount =
      oldPrice > price && oldPrice > 0
        ? Math.round(((oldPrice - price) / oldPrice) * 100)
        : 0;

    const salesNode = card.querySelector('[data-widget="searchResultsSales"]');
    const salesText = salesNode?.textContent?.trim();

    const sellerNode = card.querySelector('[data-widget="searchResultsSeller"]');
    const sellerText = sellerNode?.textContent?.trim();

    const ratingNode = card.querySelector('[data-widget="searchResultsRating"]');
    const ratingText = ratingNode?.textContent?.trim();

    badge.innerHTML = `
      ${salesText ? `<div class="ozon-helper-card-sales">${salesText}</div>` : ''}
      ${discount ? `<div class="ozon-helper-card-discount">-${discount}%</div>` : ''}
      ${price ? `<div class="ozon-helper-card-price">${window.formatNumber(price)} ₽</div>` : ''}
      ${sellerText ? `<div class="ozon-helper-card-seller">${sellerText}</div>` : ''}
      ${ratingText ? `<div class="ozon-helper-card-rating">${ratingText}</div>` : ''}
    `;

    card.style.position = 'relative';
    card.appendChild(badge);

    return badge;
  }

  // --- Data Panel: Extract Product ID from URL ---
  // URL format: /product/some-name-here-1234567890/
  // The product ID is the last numeric segment after the final hyphen
  function extractProductId(url) {
    if (!url) return null;
    const m = url.match(/\/product\/.*-(\d{5,})/);
    return m ? m[1] : null;
  }

  // 格式化 + merge + 渲染统一放在 shared-utils.js,跟 ozon-data-panel.js 共用。
  // 见 window.jzMergeCardPanelData / window.jzRenderProductCardPanel /
  //   window.jzRenderPanelSkeleton。
  // 注:search 页暂未调用 fetchPublicFollowSell,hero「跟卖」会显示空态。

  // --- Collector: 销量过滤（"仅抓有销量数据"开启时才生效） ---
  function passCollectorFilters(data, info) {
    if (onlyWithSales) {
      const sold = Number(data?.soldCount);
      if (!Number.isFinite(sold) || sold <= 0) return false;
    }
    return window.JZCollectorFilter?.matches ? window.JZCollectorFilter.matches(data, info) : true;
  }

  // --- Collector: 把卡片信息 + merged 数据写到 IndexedDB sales store
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
      raw.marketingPriceCurrency = info.marketingPriceCurrency || 'RUB';
      raw._marketingPriceSource = info.marketingPriceSource || 'card';
    }
    if (info.greenPrice != null) {
      raw.greenPrice = info.greenPrice;
      raw.greenPriceCurrency = info.greenPriceCurrency || 'RUB';
      raw._greenPriceSource = info.greenPriceSource || info.marketingPriceSource || 'card';
    }
    return {
      sku: String(productId),
      url: info.url || '',
      name: info.name || '',
      price: info.price != null ? String(info.price) : null,
      priceCurrency: info.priceCurrency || null,
      image: info.image || '',
      soldCount: data?.soldCount ?? null,
      gmvSum: data?.gmvSum != null ? String(data.gmvSum) : null,
      views: data?.views ?? null,
      convViewToOrder: data?.convViewToOrder != null ? String(data.convViewToOrder) : null,
      discount: data?.discount != null ? String(data.discount) : null,
      keyword,
      hashtags: hashtags.length ? hashtags : undefined,
      collectedAt: Date.now(),
      status: 'local',
      raw: Object.keys(raw).length ? raw : null,
    };
  }


  async function collectSaleIfMatched(productId, card, info, data, panel) {
    if (!collectorRunning) return false;
    const sourceData = window.jzExtractPanelFilterData
      ? window.jzExtractPanelFilterData(panel, info, data || {})
      : (data || {});
    const readyInfo = await waitForCollectorFilterData(card, sourceData, info, panel);
    if (!collectorRunning) return false;
    const readyData = window.jzExtractPanelFilterData
      ? window.jzExtractPanelFilterData(panel, readyInfo, sourceData)
      : sourceData;
    if (readyInfo && passCollectorFilters(readyData, readyInfo)) {
      try {
        if (!window.JZCollectorDB?.putSale) return false;
        const record = buildSaleRecord(productId, readyInfo, readyData);
        if (!collectorRunning) return false;
        await window.JZCollectorDB.putSale(record);
        window.JZCollectorToast?.localCollectSuccess?.(record.sku);
        return true;
      } catch {}
    }
    return false;
  }

  // --- Data Panel: Load data for a card(通过 JZTaskQueue 节流 + 仅当采集器运行时落 IndexedDB) ---
  // panel 数据展示无条件加载;落桶仅在 collectorRunning=true 时执行,跟采集器
  // 「采集中/停止」按钮挂钩。
  async function loadPanelData(card, panel) {
    if (panel) panel.dataset.jzLoadStatus = 'loading';
    const info = extractCardInfo(card);
    const productId = extractProductId(info.url);
    if (!productId) {
      if (panel) panel.dataset.jzLoadStatus = 'error';
      panel.innerHTML = '';
      return;
    }

    // —— 会员门控:数据卡为会员功能,免费档渲染锁定卡、不发任何数据请求 ——
    // (页面级缓存一次;fail-open,后端 product-data 403 + __featureGated 兜底)
    const renderLockedPanel = () => {
      if (!panel) return;
      panel.dataset.jzLoadStatus = 'ready';
      window.jzRenderPanelSkeleton(panel); // 复用卡头(品牌 + 齿轮)
      const body = panel.querySelector('.ozon-helper-sidebar-card-body') || panel;
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
      info.priceCurrency !== 'CNY' && info.priceCurrency !== 'USD' && Number(info.price) > 0
        ? Number(info.price)
        : 0;

    if (panelDataCache.has(productId)) {
      const cached = panelDataCache.get(productId);
      // V2 优先(对齐详情页 5-section)— 用 cached.preFetched 复用之前 fetch 结果
      if (typeof window.jzRenderProductPanelV2 === 'function' && cached?.preFetched) {
        if (!panel.getAttribute('data-jz-datacard')) {
          window.jzRenderProductPanelV2(panel, { sku: productId, initial: cached });
        }
        try { await window.jzPopulatePanelV2(panel, productId, { preFetched: cached.preFetched, pageRub: tileRub }); } catch {}
      } else {
        window.jzRenderProductCardPanel(panel, cached);
      }
      // 缓存命中也落桶(仅采集器运行时)— 首次切换"采集中"后让已展示的卡也补落桶
      if (panel) panel.dataset.jzLoadStatus = 'ready';
      await collectSaleIfMatched(productId, card, info, cached, panel);
      return;
    }

    const showError = () => {
      if (panel) panel.dataset.jzLoadStatus = 'error';
      panel.innerHTML = '<div class="ozon-helper-panel-error" style="cursor:pointer;color:var(--oh-red,#ff4d4f);font-size:12px;padding:8px 12px;">数据加载失败，点击重试</div>';
      panel.querySelector('.ozon-helper-panel-error')?.addEventListener('click', () => {
        window.jzMountPanelStructure(panel, card);
        loadPanelData(card, panel);
      }, { once: true });
    };

    try {
      // TaskQueue 通过 taskId 去重(同 sku 重复入队复用同一 promise)。
      // 快慢分车道(首帧只等快车道,旧版 4 路 allSettled barrier 让每张卡的首帧
      // 都被最慢一路扣死 —— 跟卖数 1 并发×500ms 串行,整页 40 卡尾卡要等 20s+):
      //   - 快:taskQueue(6 并发)里的 backend market/product stats,到手即渲染
      //   - 慢:variantsQueue 的 searchVariants + followSellQueue 的跟卖数,
      //     经 jzPopulatePanelV2 的 promise 型 preFetched 到货即补格子
      // 公共 fetch 内部都有 sessionStorage cache,首屏后命中即返不打网。
      const fetchTask = () => {
        const slowVariant = variantsQueue.add(() => window.sendMessage('searchVariants', { sku: productId }));
        const slowFollow = followSellQueue.add(() => window.jzFetchPublicFollowSell(productId));
        // 慢车道晚些才被 allSettled/populate 收编,先挂空 catch 防 unhandledrejection
        slowVariant.catch(() => {});
        slowFollow.catch(() => {});
        return Promise.allSettled([
          window.sendMessage('getMarketStats', { sku: productId, period: window.jzGetSalesPeriod?.() || 'monthly' }),
          window.sendMessage('getProductStats', { url: info.url, period: window.jzGetSalesPeriod?.() || 'monthly' }),
        ]).then(([marketResult, productResult]) => ({ marketResult, productResult, slowVariant, slowFollow }));
      };
      const { marketResult, productResult, slowVariant, slowFollow } =
        await taskQueue.add(`stats-${productId}`, fetchTask);

      if (!card?.isConnected) {
        if (panel) {
          panel.dataset.jzLoadStatus = 'idle';
          panel.innerHTML = '';
        }
        return;
      }

      if (marketResult.status === 'rejected' && productResult.status === 'rejected') {
        // 任务在队列里是 SUCCESS(allSettled 恒 fulfilled)但内容全失败 —— 不 evict
        // 的话「点击重试」会拿回同一份坏结果,永远无法真正重试。
        taskQueue.evict?.(`stats-${productId}`);
        showError();
        return;
      }

      // 会员门控兜底:会员在页面打开期间过期(或门控查询 fail-open 放行但后端拦了)
      // → SW 透传 __featureGated,渲染锁定卡而非空数据卡
      if (productResult.status === 'fulfilled' && productResult.value?.__featureGated) {
        renderLockedPanel();
        return;
      }

      // —— 首帧:stats/market 到手立即渲染;variants/跟卖数由 populate 到货即补 ——
      let populatePromise = null;
      if (typeof window.jzRenderProductPanelV2 === 'function') {
        const firstData = window.jzMergeCardPanelData(
          marketResult.status === 'fulfilled' ? marketResult.value : null,
          productResult.status === 'fulfilled' ? productResult.value : null,
          null,
          null,
          productId,
          null,
        );
        if (!panel.getAttribute('data-jz-datacard')) {
          // 挂载时回退了旧骨架(极端情况)才需要在这里补渲染结构
          window.jzRenderProductPanelV2(panel, { sku: productId, initial: firstData });
        }
        if (panel) panel.dataset.jzLoadStatus = 'ready';
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
          panel.dataset.jzLoadStatus = 'idle';
          panel.innerHTML = '';
        }
        return;
      }

      // sv 失败/auth issue 兜底:从 chrome.storage.local 读详情页采集的 cache
      // (用户曾访问该 SKU 详情页时 jzc-calc/ozon-product 抓的真实数据)
      const cachedWeightDims = (variantResult.status !== 'fulfilled' || !variantResult.value?.items?.[0])
        ? await (window.jzReadCachedWeightDims?.(productId).catch(() => null) ?? null)
        : null;

      const data = window.jzMergeCardPanelData(
        marketResult.status === 'fulfilled' ? marketResult.value : null,
        productResult.status === 'fulfilled' ? productResult.value : null,
        variantResult.status === 'fulfilled' ? variantResult.value : null,
        followSellResult.status === 'fulfilled' && followSellResult.value
          ? {
              followSellCount: followSellResult.value.count,
              sellers: followSellResult.value.sellers,
            }
          : null,
        productId,
        cachedWeightDims,
      );
      // 挂 preFetched 让后续 cache 命中时 V2 复用,避免再次往 backend / SW 发请求
      // (存终局 SettledResult,不存在途 promise)
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

      // 写入 IndexedDB sales store(仅采集器运行时;启用销量过滤时跳过 0 销量)
      if (panel) panel.dataset.jzLoadStatus = 'ready';
      await collectSaleIfMatched(productId, card, info, data, panel);
    } catch {
      showError();
    }
  }

  // --- Data Panel: 点击事件分发(hero followsell + 底部按钮) ---
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

  async function handlePanelAction(action, card, panel, btn) {
    if (action === 'toggle-section') {
      window.JZSidebarSectionToggle?.toggleSidebarSection(btn);
      return;
    }

    // 字段设置齿轮:不依赖 info.url(放在 url 守卫之前),对全站数据卡生效。
    if (action === 'open-field-settings') {
      window.jzOpenFieldSettings?.(panel);
      return;
    }

    const info = extractCardInfo(card);
    if (!info.url) return;

    if (action === 'show-followsell-modal' || action === 'view-sellers') {
      // Hero follow-sell stat: show our seller modal; keep Ozon URL fallback.
      const product = getPanelFollowSellProduct(card, panel);
      if (product && window.jzShowFollowSellListModal) {
        window.jzShowFollowSellListModal(btn, product, { trigger: 'click' });
      } else {
        const sep = info.url.includes('?') ? '&' : '?';
        window.open(`${info.url}${sep}prefer_sellers=true`, '_blank');
      }
      return;
    }

    if (action === 'open-followsell' || action === 'follow-sell') {
      // 底部「一键跟卖」按钮 → 主扩展上架面板
      window.open(info.url + '#jz-follow-sell', '_blank');
      return;
    }

    if (action === 'edit-list') {
      await handleEditList(card, panel, btn, info);
      return;
    }

    if (action === 'collect-one') {
      await handleCollectOne(card, panel, btn, info);
      return;
    }
  }

  // 「采集」按钮:与 action bar 上的「一键采集」语义统一,写 backend 采集箱
  // (pushSourceCollect)。同时保留本地 IndexedDB 写入,供「极掌采集器」关键词
  // 巡航的桶视图复用 sale record。绕过 collectorRunning gate(用户主动点 = 显式同意)。
  //
  // resp shape (SW ENVELOPE_FIX 2025-05):{ dedupeHit, lastAt, result }。
  // sendMessage 在 SW ok:false 时直接 reject(走外层 catch),不必检查 resp.ok。
  async function handleCollectOne(card, panel, btn, info) {
    if (btn.dataset.busy === '1') return;
    const productId = extractProductId(info.url);
    if (!productId) {
      flashBtn(btn, '无效 SKU', 'is-failed', 1500);
      return;
    }
    btn.dataset.busy = '1';
    try {
      // 优先用 panelDataCache 里已加载的完整数据;还没加载就用最少字段(标题/图/价/url)
      const data = panelDataCache.get(productId) || null;
      info = await enrichInfoWithDetailMarketingPrice(info);

      // 1. searchVariants 补 sv 富字段(品牌/类目/属性),失败兜底空
      const variantResp = await window
        .sendMessage('searchVariants', { sku: productId })
        .catch(() => null);
      const variantItems = variantResp?.items || variantResp?.data?.items || [];
      const variantMatch =
        variantItems.find((it) => String(it.variant_id) === productId) ||
        variantItems[0] ||
        null;
      if (variantMatch && Array.isArray(info.hashtags) && info.hashtags.length) {
        try { window.JZFollowSellContentCopy?.mergeSourceHashtagsIntoVariant?.(variantMatch, info.hashtags); } catch {}
      }

      // 2. 写 backend 采集箱(主路径)
      // 跟卖式 catalog:name/images 切 sv(search+bundle)优先,DOM(info)兜底;
      // 统计仍走 DOM/后端 stats(seller-portal 不返回)。
      const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(variantMatch) : null;
      const collectName = window.jzPreferSourceName
        ? window.jzPreferSourceName(svCat?.name, info.name)
        : (info.name || svCat?.name || '');
      const collectImages = svCat?.images?.length
        ? svCat.images
        : (info.image ? [info.image] : []);
      const collectPayload = {
        sku: String(productId),
        url: info.url,
        name: collectName || info.name,
        price: info.price != null ? String(info.price) : undefined,
        priceCurrency: info.priceCurrency || undefined,
        marketingPrice: info.marketingPrice != null ? String(info.marketingPrice) : undefined,
        marketingPriceCurrency: info.marketingPriceCurrency || undefined,
        image: svCat?.mainImage || info.image || undefined,
        images: collectImages.length ? collectImages : undefined,
        variantData: variantMatch || undefined,
        soldCount: data?.soldCount ?? undefined,
        soldSum: data?.gmvSum != null ? String(data.gmvSum) : undefined,
        views: data?.views ?? undefined,
        convViewToOrder:
          data?.convViewToOrder != null ? String(data.convViewToOrder) : undefined,
        discount: data?.discount != null ? String(data.discount) : undefined,
        gmvSum: data?.gmvSum != null ? String(data.gmvSum) : undefined,
      };
      const resp = await window.sendMessage('pushSourceCollect', {
        sourceId: 'ozon',
        raw: collectPayload,
      });

      // 3. 本地桶 (失败静默,backend 写成功就算采集成功)
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
          fallbackRaw.marketingPriceCurrency = info.marketingPriceCurrency || 'RUB';
          fallbackRaw._marketingPriceSource = info.marketingPriceSource || 'card';
          fallbackRaw.greenPrice = info.greenPrice ?? undefined;
          fallbackRaw.greenPriceCurrency = info.greenPrice != null ? (info.greenPriceCurrency || 'RUB') : undefined;
          fallbackRaw._greenPriceSource = info.greenPrice != null ? (info.greenPriceSource || info.marketingPriceSource || 'card') : undefined;
        }
        const record = data
          ? buildSaleRecord(productId, info, data)
          : {
              sku: String(productId),
              url: info.url || '',
              name: info.name || '',
              price: info.price != null ? String(info.price) : null,
              priceCurrency: info.priceCurrency || null,
              image: info.image || '',
              keyword,
              hashtags: Array.isArray(info.hashtags) && info.hashtags.length ? info.hashtags : undefined,
              collectedAt: Date.now(),
              raw: Object.keys(fallbackRaw).length ? fallbackRaw : null,
            };
        await window.JZCollectorDB?.putSale(record);
      } catch (e) {
        console.warn('[ozon-helper] collect-one local-bucket write failed:', e);
      }

      const label = resp?.dedupeHit ? '近期已采集' : '已采集';
      flashBtn(btn, label, 'is-collected', 1800);
    } catch (e) {
      console.warn('[ozon-helper] collect-one failed:', e);
      const msg = e?.message || '';
      const friendly = /NETWORK_ERROR|超时|timeout|网络/i.test(msg) ? '网络错误' : '失败';
      flashBtn(btn, friendly, 'is-failed', 1800);
    } finally {
      btn.dataset.busy = '';
    }
  }

  function flashBtn(btn, text, cls, ms) {
    const original = btn.innerHTML;
    btn.classList.add(cls);
    btn.innerHTML = `<span class="oh-btn-icon">✓</span>${text}`;
    setTimeout(() => {
      btn.classList.remove(cls);
      btn.innerHTML = original;
    }, ms);
  }

  async function handleEditList(card, panel, btn, info) {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '采集中…';

    try {
      const sku = extractProductId(info.url);
      if (!sku) throw new Error('missing-sku');
      info = await enrichInfoWithDetailMarketingPrice(info);

      const variantResp = await window.sendMessage('searchVariants', { sku }).catch(() => null);
      const variantItems = variantResp?.items || variantResp?.data?.items || [];
      const variantMatch = variantItems.find((it) => String(it.variant_id) === sku) || variantItems[0] || null;

      // sendMessage 在 SW ok:false 时直接 reject(走外层 catch),resolve 时只透出
      // response.data。SW 已统一把 envelope 塞进 data,resp 形如 { dedupeHit, lastAt, result }。
      // 不再检查 resp.ok — 那是历史残留,resp 已不带 envelope。
      // 跟卖式 catalog:name/images 切 sv 优先,DOM(info)兜底。
      const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(variantMatch) : null;
      if (variantMatch && Array.isArray(info.hashtags) && info.hashtags.length) {
        try { window.JZFollowSellContentCopy?.mergeSourceHashtagsIntoVariant?.(variantMatch, info.hashtags); } catch {}
      }
      const collectName = window.jzPreferSourceName
        ? window.jzPreferSourceName(svCat?.name, info.name)
        : (info.name || svCat?.name || '');
      const collectImages = svCat?.images?.length
        ? svCat.images
        : (info.image ? [info.image] : []);
      const resp = await window.sendMessage('pushSourceCollect', {
        sourceId: 'ozon',
        raw: {
          sku, url: info.url, name: collectName || info.name,
          price: info.price != null ? String(info.price) : undefined,
          priceCurrency: info.priceCurrency || undefined,
          marketingPrice: info.marketingPrice != null ? String(info.marketingPrice) : undefined,
          marketingPriceCurrency: info.marketingPriceCurrency || undefined,
          image: svCat?.mainImage || info.image || undefined,
          images: collectImages.length ? collectImages : undefined,
          variantData: variantMatch || undefined,
        },
      });
      const itemId = resp?.result?.id;
      const frontendUrl = 'http://127.0.0.1:5173';
      window.open(
        itemId
          ? `${frontendUrl}/ozon/products/collect/edit?id=${itemId}`
          : `${frontendUrl}/ozon/products/collect`,
        '_blank',
      );
      btn.innerHTML = resp.dedupeHit ? '近期已采集' : original;
      btn.disabled = false;
      btn.dataset.busy = '0';
      if (resp.dedupeHit) {
        setTimeout(() => { btn.innerHTML = original; }, 2500);
      }
    } catch (err) {
      console.error('[ozon-helper] search edit-list failed:', err);
      const msg = err?.message || '';
      btn.innerHTML = /NETWORK_ERROR|超时|timeout|网络/i.test(msg) ? '网络错误' : '失败';
      setTimeout(() => {
        btn.innerHTML = original;
        btn.disabled = false;
        btn.dataset.busy = '0';
      }, 2500);
    }
  }

  // --- Data Panel: Inject panel inside card (bottom) ---
  function ensureDataPanel(card) {
    if (card._ohPanelAttached) return;
    card._ohPanelAttached = true;

    const panel = document.createElement('div');
    panel.className = 'ozon-helper-data-panel';
    panel.setAttribute('lang', 'zh-Hans');
    window.jzMountPanelStructure(panel, card);
    panel.dataset.jzLoadStatus = 'pending';
    card.appendChild(panel);
    card._ohPanel = panel;

    // 阻止 hero/按钮 click 冒泡到 Ozon tile(避免误触发跳转)
    panel.addEventListener('click', (e) => {
      const target = e.target.closest('[data-click-action], [data-action]');
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      const action = target.getAttribute('data-click-action') || target.getAttribute('data-action');
      handlePanelAction(action, card, panel, target);
    });

    // Use IntersectionObserver for lazy loading
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.disconnect();
          loadPanelData(card, panel);
        }
      }
    }, { rootMargin: '200px' });
    observer.observe(panel);
  }

  function removeDataPanel(card) {
    if (card._ohPanel) {
      card._ohPanel.remove();
      card._ohPanel = null;
    }
    card._ohPanelAttached = false;
  }

  // --- Data Panel: 开关从 chrome.storage.local 读取 + 监听 onChanged ---
  // 旧版本是右下角浮动 toggle 按钮（.ozon-helper-panel-toggle）。
  // 现在统一移到极掌 popup 里 toggle，状态持久化到
  // chrome.storage.local.ozon_data_panel_enabled。
  const PANEL_STORAGE_KEY = 'ozon_data_panel_enabled';

  async function loadPanelEnabled() {
    try {
      const r = await chrome.storage.local.get(PANEL_STORAGE_KEY);
      // 默认 true(首次安装/未设置 = 自动加载数据面板,跟 popup 默认显示一致)。
      // 只有 storage 里显式存 false 才关 — 老用户关过的状态会保留。
      panelState.enabled = r[PANEL_STORAGE_KEY] !== false;
    } catch {
      panelState.enabled = true;
    }
  }

  function listenStorageToggle() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (!changes[PANEL_STORAGE_KEY]) return;
        // !== false 兼容 undefined/true 两种 default-on 写法
        panelState.enabled = changes[PANEL_STORAGE_KEY].newValue !== false;
        const cards = getCards();
        if (panelState.enabled) {
          cards.forEach((c) => ensureDataPanel(c));
        } else {
          cards.forEach((c) => removeDataPanel(c));
        }
      });
    } catch {}
  }

  function applyToCards() {
    const cards = getCards();
    cards.forEach((card) => {
      ensureBadge(card);
      if (panelState.enabled) {
        ensureDataPanel(card);
      } else {
        removeDataPanel(card);
      }
    });
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
    const panel = card._ohPanel || card.querySelector?.('.ozon-helper-data-panel');
    if (!panel) return null;
    const status = panel.dataset.jzLoadStatus || '';
    if (!status || status === 'idle' || status === 'pending' || (options.forceCollect && status === 'ready')) {
      loadPanelData(card, panel);
    }
    return panel;
  }

  // 把 IndexedDB 本地桶里 status='local' 的全部推送到后端
  //
  // 跟卖式数据(2026-05-30):浏览时 loadPanelData 已经把 searchVariants(search+
  // bundle)结果存进桶记录的 rec.raw.preFetched.variant —— 所以批量推送 **零额外
  // seller-portal 请求** 就能带上完整 sv:从桶里取出 variantMatch、跟卖式抽 catalog
  // (name/images sv 优先,统计仍用桶里的 DOM 值),再走会 prune + RUB→CNY 的
  // 多源批量端点 /sources/ozon/collect/batch(替代旧 /ozon/collect-box/batch ——
  // 旧端点不 prune,带完整 bundle 会撑爆 JSONB,且 sourceId 落 'unknown'/币种不换算)。
  async function pushBucketToCollectBox() {
    if (!window.JZCollectorDB) return { ok: false, message: 'IndexedDB 未就绪' };
    const all = await window.JZCollectorDB.getAllSales({ status: 'local' });
    if (!all.length) return { ok: true, message: '本地桶无待推送' };

    const items = all.map((rec) => {
      // rec.raw = 浏览时 jzMergeCardPanelData 的 data,preFetched.variant 是
      // searchVariants 的 settled 结果 { status, value:{items} }。
      const vres = rec.raw?.preFetched?.variant;
      const vitems = vres?.status === 'fulfilled'
        ? (vres.value?.items || vres.value?.data?.items || [])
        : [];
      const variantMatch =
        vitems.find((it) => String(it.variant_id) === String(rec.sku)) || vitems[0] || null;
      const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(variantMatch) : null;
      const name = window.jzPreferSourceName
        ? window.jzPreferSourceName(svCat?.name, rec.name)
        : (rec.name || svCat?.name || '');
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

    // 切片 100 条/批(新端点上限 200;带完整 variantData 时 100 条 body ~10MB,
    // 在后端 50mb 限制内留足余量,且每批顺序 upsert 不会太久)
    let created = 0, updated = 0, failed = 0;
    for (let i = 0; i < items.length; i += 100) {
      const chunk = items.slice(i, i + 100);
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'pushSourceCollectBatch', sourceId: 'ozon', items: chunk }, resolve);
      });
      if (!resp?.ok) {
        return { ok: false, message: resp?.error || '推送失败' };
      }
      // 新端点返回 { results:[{action:'created'|'updated'}], errors:[{index,reason}] }。
      // errors 是真失败(validate/normalize 失败),不能算"跳过",也不能 markPushed —— 否则
      // 失败项被移出本地桶 local 状态,永远不会重试。只把成功项 markPushed。
      const results = resp.data?.results || [];
      const errors = resp.data?.errors || [];
      const successResults = results.filter((r) => r?.action === 'created' || r?.action === 'updated');
      created += successResults.filter((r) => r.action === 'created').length;
      updated += successResults.filter((r) => r.action === 'updated').length;
      failed += errors.length + Math.max(0, chunk.length - successResults.length - errors.length);
      const okSkus = successResults.map((r) => String(r.sku || '')).filter(Boolean);
      if (okSkus.length) {
        try {
          await window.JZCollectorDB.markPushed(okSkus);
        } catch {}
      }
    }
    const failTail = failed ? ` / 失败 ${failed}` : '';
    return { ok: failed === 0, message: `推送完成：新增 ${created} / 更新 ${updated}${failTail}` };
  }

  // 极掌采集器面板 UI 显示开关:默认开 —— 新用户进搜索页能看到控制面板。
  // 注意这只控制浮窗是否显示;真正写入本地桶由 collectorRunning 控制,默认停止。
  // 状态由 popup toggle 控制,通过 chrome.storage.local.ozon_collector_enabled 同步。
  const COLLECTOR_STORAGE_KEY = 'ozon_collector_enabled';
  let collectorEnabled = true;

  async function loadCollectorEnabled() {
    try {
      const r = await chrome.storage.local.get(COLLECTOR_STORAGE_KEY);
      // 未设置 = 显示浮窗;只有显式 false 才隐藏。
      collectorEnabled = r[COLLECTOR_STORAGE_KEY] !== false;
    } catch {
      collectorEnabled = true;
    }
  }

  // collectorRunning is session-only: every search page starts stopped.
  async function loadCollectorRunning() {
    collectorRunning = false;
    keywordPilotOwnsCollectorRunning = false;
    try { await chrome.storage.local.remove(COLLECTOR_RUNNING_STORAGE_KEY); } catch {}
  }

  function listenCollectorRunningToggle() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (!changes[COLLECTOR_RUNNING_STORAGE_KEY]) return;
        if (changes[COLLECTOR_RUNNING_STORAGE_KEY].newValue !== false) return;
        collectorRunning = false;
        keywordPilotOwnsCollectorRunning = false;
        try { autoScroller?.stop?.(); } catch {}
        try { collectorPanel?.setRunning(false); } catch {}
        try { collectorPanel?.setAutoScrollerState({ running: false, autoPaused: false }); } catch {}
        try { Promise.resolve(keywordPilot?.stop?.()).catch(() => {}); } catch {}
        try { Promise.resolve(clearKeywordPilotSession()).catch(() => {}); } catch {}
        sendHeartbeatNow();
      });
    } catch {}
  }

  async function clearKeywordPilotSession() {
    const db = window.JZCollectorDB;
    if (!db) return;
    try {
      const runningKeywords = await db.getKeywords?.({ status: 'running' }) || [];
      const ids = new Set(runningKeywords.map((k) => k.id).filter(Boolean));
      await Promise.all(Array.from(ids).map((id) => db.updateKeyword?.(id, { status: 'pending' })));
      await db.clearSession?.();
    } catch {}
  }

  function unmountCollectorPanel() {
    collectorRunning = false;
    keywordPilotOwnsCollectorRunning = false;
    try { chrome.storage.local.set({ [COLLECTOR_RUNNING_STORAGE_KEY]: false }); } catch {}
    try { autoScroller?.stop?.(); } catch {}
    try { Promise.resolve(keywordPilot?.stop?.()).catch(() => {}); } catch {}
    try { Promise.resolve(clearKeywordPilotSession()).catch(() => {}); } catch {}
    sendHeartbeatNow();
    if (collectorPanel) {
      try { collectorPanel.unmount(); } catch {}
      collectorPanel = null;
    }
  }

  function listenCollectorToggle() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (!changes[COLLECTOR_STORAGE_KEY]) return;
        collectorEnabled = changes[COLLECTOR_STORAGE_KEY].newValue !== false;
        if (collectorEnabled) mountCollectorPanel();
        else unmountCollectorPanel();
      });
    } catch {}
  }

  function mountCollectorPanel() {
    if (!collectorEnabled) return;
    if (collectorPanel || !window.JZCollectorPanel) return;
    collectorPanel = window.JZCollectorPanel.create({
      queue: taskQueue,
      db: window.JZCollectorDB,
      onPushClick: () => pushBucketToCollectBox(),
      onClearClick: () => window.JZCollectorDB?.clearSales(),
      onToggleRunning: async (next) => {
        // Do not persist running=true across page loads.
        collectorRunning = !!next;
        keywordPilotOwnsCollectorRunning = false;
        try {
          if (collectorRunning) chrome.storage.local.remove(COLLECTOR_RUNNING_STORAGE_KEY);
          else chrome.storage.local.set({ [COLLECTOR_RUNNING_STORAGE_KEY]: false });
        } catch {}
        if (collectorRunning) {
          collectCurrentCardsOnce();
        } else {
          if (autoScroller) autoScroller.stop();
          collectorPanel?.setAutoScrollerState({ running: false, autoPaused: false });
          applyToCards();
          try { if (keywordPilot) await keywordPilot.stop(); } catch {}
          await clearKeywordPilotSession();
          await refreshKeywordPanelState();
        }
        sendHeartbeatNow();
      },
      onAutoScrollToggle: (next) => {
        if (!autoScroller) return;
        if (next && !collectorRunning) {
          autoScroller.stop();
          collectorPanel?.setAutoScrollerState({ running: false, autoPaused: false });
          collectorPanel?.toast?.('请先启动采集', 'info', 1600);
          return;
        }
        if (next) autoScroller.start();
        else autoScroller.stop();
        collectorPanel.setAutoScrollerState({
          running: autoScroller.isUserActive(),
          autoPaused: autoScroller.isAutoPaused(),
        });
      },
      onSalesFilterChange: (next) => {
        onlyWithSales = !!next;
      },
      onKeywordsStart: async (texts, maxN) => {
        if (!keywordPilot) return;
        // 关键词采集启动:必须确保 collectorRunning=true(否则爬到的数据不落桶,
        // 关键词采集就没意义)。panel 自动加载和 taskQueue 永远开,不需动。
        const startedHere = !collectorRunning;
        try {
          if (startedHere) {
            collectorRunning = true;
            keywordPilotOwnsCollectorRunning = true;
            try { chrome.storage.local.remove(COLLECTOR_RUNNING_STORAGE_KEY); } catch {}
            collectorPanel.setRunning(true);
          }
          await keywordPilot.addKeywords(texts);
          await keywordPilot.start({
            maxCollectNumber: maxN || 200,
            collectorStartedByKeywordPilot: startedHere,
          });
        } catch (err) {
          if (startedHere) {
            collectorRunning = false;
            keywordPilotOwnsCollectorRunning = false;
            try { chrome.storage.local.set({ [COLLECTOR_RUNNING_STORAGE_KEY]: false }); } catch {}
            collectorPanel.setRunning(false);
          }
          throw err;
        }
      },
      onKeywordsStop: async () => {
        if (!keywordPilot) return;
        const mode = keywordPilot.getState?.().mode;
        if (mode !== 'COLLECTING' && mode !== 'NAVIGATING') {
          await clearKeywordPilotSession();
          await refreshKeywordPanelState();
          return;
        }
        await keywordPilot.stop();
        await clearKeywordPilotSession();
        await refreshKeywordPanelState();
      },
      onKeywordsClear: async () => {
        if (!keywordPilot) return;
        const mode = keywordPilot.getState?.().mode;
        if (mode === 'COLLECTING' || mode === 'NAVIGATING') {
          await keywordPilot.stop();
        }
        await clearKeywordPilotSession();
        await keywordPilot.clearAllKeywords();
        await refreshKeywordPanelState();
      },
    });
    collectorPanel.mount();
    // 初始按钮状态显示 collectorRunning(IndexedDB 写入开关),不再用 panelState.enabled
    collectorPanel.setRunning(collectorRunning);
    // 初始 sales filter 状态
    onlyWithSales = collectorPanel.getInitialSalesFilter();
    refreshKeywordPanelState().catch(() => {});
  }

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

  function mountAutoScroller() {
    if (autoScroller || !window.JZAutoScroller) return;
    autoScroller = new window.JZAutoScroller({
      queue: taskQueue,
      intervalMs: 500,
      settleMs: 1000,
      scrollStepRatio: 0.95,
      minScrollStepPx: 680,
      readinessPollMs: 300,
      maxReadinessWaitMs: 20000,
      isReadyToScroll: () => isCurrentViewportDataReady(),
      emptyThreshold: 5,
      getCardCount: () => getCards().length,
      onCongestionPause: (which) => {
        const stateMsg = which === 'paused' ? '队列拥塞，自动暂停翻页' : '队列恢复，继续翻页';
        if (collectorPanel) {
          collectorPanel.setAutoScrollerState({
            running: autoScroller.isUserActive(),
            autoPaused: autoScroller.isAutoPaused(),
          });
          collectorPanel.toast(stateMsg, 'info', 1800);
        }
      },
      onEmpty: async () => {
        if (collectorPanel) {
          collectorPanel.setAutoScrollerState({ running: false, autoPaused: false });
          collectorPanel.toast('当前页已抓取完成', 'success', 1800);
        }
        if (keywordPilot) await keywordPilot.notifyKeywordEmpty();
      },
    });
  }

  async function mountKeywordPilot() {
    if (keywordPilot || !window.JZKeywordPilot || !window.JZCollectorDB) return;
    keywordPilot = new window.JZKeywordPilot({
      db: window.JZCollectorDB,
      defaultMaxCollectNumber: 200,
      onStartCollecting: (kw, session) => {
        collectorRunning = true;
        keywordPilotOwnsCollectorRunning = session?.collectorStartedByKeywordPilot !== false;
        try { chrome.storage.local.remove(COLLECTOR_RUNNING_STORAGE_KEY); } catch {}
        sendHeartbeatNow();
        if (collectorPanel) {
          collectorPanel.setRunning(true);
          collectorPanel.setKeywordPilotState({
            mode: 'COLLECTING',
            currentKeyword: kw,
            pendingCount: 0, doneCount: 0,
          });
          collectorPanel.toast(`开始采集 "${kw.text}"`, 'info', 2000);
        }
        if (autoScroller) {
          if (collectorRunning) {
            autoScroller.start();
            collectorPanel?.setAutoScrollerState({
              running: autoScroller.isUserActive(),
              autoPaused: autoScroller.isAutoPaused(),
            });
          } else {
            autoScroller.stop();
            collectorPanel?.setAutoScrollerState({ running: false, autoPaused: false });
          }
        }
      },
      onStopCollecting: () => {
        const pilotMode = keywordPilot?.getState?.().mode;
        const isAutoAdvancing = pilotMode === 'COLLECTING';
        if (autoScroller) autoScroller.stop();
        if (isAutoAdvancing) {
          collectorPanel?.setAutoScrollerState({ running: false, autoPaused: false });
          return;
        }
        const shouldStopCollector = keywordPilotOwnsCollectorRunning || !collectorRunning;
        keywordPilotOwnsCollectorRunning = false;
        if (shouldStopCollector) {
          collectorRunning = false;
          try { chrome.storage.local.set({ [COLLECTOR_RUNNING_STORAGE_KEY]: false }); } catch {}
        }
        if (collectorPanel) {
          collectorPanel.setRunning(collectorRunning);
          collectorPanel.setAutoScrollerState({ running: false, autoPaused: false });
          refreshKeywordPanelState().catch(() => {});
        }
        sendHeartbeatNow();
      },
      onAllDone: () => {
        if (keywordPilotOwnsCollectorRunning) {
          collectorRunning = false;
          try { chrome.storage.local.set({ [COLLECTOR_RUNNING_STORAGE_KEY]: false }); } catch {}
        }
        keywordPilotOwnsCollectorRunning = false;
        collectorPanel?.setRunning(collectorRunning);
        collectorPanel?.setAutoScrollerState({ running: false, autoPaused: false });
        refreshKeywordPanelState().catch(() => {});
        sendHeartbeatNow();
        if (collectorPanel) collectorPanel.toast('所有关键词采集完成', 'success', 3000);
      },
    });
    // 复活检查（如果是关键词跳过来的页面，会自动启动 AutoScroller）
    if (!collectorEnabled) {
      await clearKeywordPilotSession();
      await refreshKeywordPanelState();
      return;
    }
    await keywordPilot.init();
    await refreshKeywordPanelState();
  }

  async function refreshKeywordPanelState() {
    if (!collectorPanel || !keywordPilot || !window.JZCollectorDB) return;
    const state = keywordPilot.getState();
    const all = await window.JZCollectorDB.getKeywords();
    const pendingCount = all.filter((k) => k.status === 'pending').length;
    const doneCount = all.filter((k) => k.status === 'done').length;
    collectorPanel.setKeywordPilotState({ ...state, pendingCount, doneCount });
  }

  function mountAntiBanGuard() {
    if (antiBanGuard || !window.JZAntiBanGuard) return;
    antiBanGuard = new window.JZAntiBanGuard({
      queue: taskQueue,
      windowSize: 20,
      failureRateThreshold: 0.5,
      cooldownMs: 60000,
      onTrigger: (msg) => {
        if (collectorPanel) collectorPanel.toast(msg, 'error', 5000);
      },
    });
    antiBanGuard.start();
  }

  function createObserver() {
    let _applyPending = false;
    const observer = new MutationObserver(() => {
      if (_applyPending) return;
      _applyPending = true;
      requestAnimationFrame(() => {
        _applyPending = false;
        applyToCards();
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  async function init() {
    const auth = await window.checkAuth();
    if (!auth.loggedIn) {
      window.createLoginPrompt();
      return;
    }

    // 初始化 IndexedDB
    try { await window.JZCollectorDB?.init(); } catch (e) { console.warn('[ozon-search] IndexedDB init failed:', e); }

    await loadPanelEnabled();
    listenStorageToggle();
    await loadCollectorEnabled();
    listenCollectorToggle();
    await loadCollectorRunning();
    listenCollectorRunningToggle();
    mountCollectorPanel();
    mountAutoScroller();
    await mountKeywordPilot();
    mountAntiBanGuard();
    applyToCards();
    createObserver();
    startHeartbeat();
  }

  // ─── 心跳上报：让 popup 大屏能看到本 tab 的采集进度 ───────
  let _heartbeatTimer = null;
  let _heartbeatPending = null;
  async function sendHeartbeatNow() {
    try {
      const stats = taskQueue.stats();
      const pilotState = keywordPilot?.getState() || { mode: 'IDLE', currentKeyword: null };
      let bucketCount = null;
      try { bucketCount = await window.JZCollectorDB?.countSales(); } catch {}
      chrome.runtime.sendMessage({
        action: 'collectorHeartbeat',
        stats,
        currentKeyword: pilotState.currentKeyword?.text || null,
        autoScrollerRunning: !!autoScroller?.isUserActive(),
        bucketCount,
        // running 语义:采集器是否在写桶(IndexedDB 写入开关),不是 panel 加载开关
        running: collectorRunning,
        url: window.location.href,
        title: document.title,
      });
    } catch { /* 关闭中或权限问题，忽略 */ }
  }
  function debouncedHeartbeat() {
    if (_heartbeatPending) return;
    _heartbeatPending = setTimeout(() => {
      _heartbeatPending = null;
      sendHeartbeatNow();
    }, 1000);
  }
  function startHeartbeat() {
    if (_heartbeatTimer) return;
    sendHeartbeatNow();                                    // 启动立即发一次
    _heartbeatTimer = setInterval(sendHeartbeatNow, 30000); // 30s 兜底
    taskQueue.on('stateChange', debouncedHeartbeat);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
})();
