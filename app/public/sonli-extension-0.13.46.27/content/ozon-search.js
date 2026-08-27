(function() {
  'use strict';

  // 标记：ozon-search.js 已经在本页注入。
  // ozon-data-panel.js 看到这个 flag 就跳过自己的数据面板渲染逻辑，
  // 让搜索/类目页继续由 ozon-search.js 一手管（含采集器联动）。
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
  const panelState = { enabled: true };
  const panelDataCache = new Map();
  const panelFastDataPromises = new Map();
  const collectCoordinator = window.JzOzonCollectCoordinator.getPageCoordinator({
    sendMessage: (action, payload) => window.sendMessage(action, payload),
    now: () => Date.now(),
    timeoutMs: 20_000,
  });

  // queue 负责数据面板请求节流。
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

  function getCards() {
    const cardsBySku = new Map();
    const addCard = (card) => {
      const link = card?.querySelector?.('a[href*="/product/"]');
      const sku = extractProductId(link?.getAttribute?.('href') || link?.href || '');
      if (!sku || !card.querySelector('img') || cardsBySku.has(sku)) return;
      cardsBySku.set(sku, card);
    };
    SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach(addCard);
    });
    document.querySelectorAll('[data-widget*="searchResults"] a[href*="/product/"]')
      .forEach((link) => {
        const sku = extractProductId(link.getAttribute('href') || link.href || '');
        if (!sku || cardsBySku.has(sku)) return;
        const boundary = link.closest('[data-widget*="searchResults"]');
        let card = link.parentElement;
        while (card && card !== boundary) {
          if (card.querySelector('img')) {
            const productSkus = new Set(Array.from(card.querySelectorAll('a[href*="/product/"]'))
              .map((candidate) => extractProductId(
                candidate.getAttribute('href') || candidate.href || '',
              ))
              .filter(Boolean));
            if (productSkus.size === 1 && productSkus.has(sku)
              && String(card.textContent || '').trim()) {
              addCard(card);
              break;
            }
            if (productSkus.size > 1) {
              break;
            }
          }
          card = card.parentElement;
        }
      });
    return Array.from(cardsBySku.values());
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

  // --- Data Panel: Load data for a card ---
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
    const renderLockedPanel = (gate) => {
      if (!panel) return;
      panel.dataset.jzLoadStatus = 'ready';
      window.jzRenderPanelSkeleton(panel); // 复用卡头(品牌 + 齿轮)
      const body = panel.querySelector('.ozon-helper-sidebar-card-body') || panel;
      if (gate?.reason === 'WEB_AUTH_REQUIRED') {
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
      if (panel) panel.dataset.jzLoadStatus = 'ready';
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
      const fastDataPromise = taskQueue.add(`stats-${productId}`, fetchTask)
        .then(({ marketResult, productResult, slowVariant, slowFollow }) => {
          const firstData = window.jzMergeCardPanelData(
            marketResult.status === 'fulfilled' ? marketResult.value : null,
            productResult.status === 'fulfilled' ? productResult.value : null,
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
          panel.dataset.jzLoadStatus = 'idle';
          panel.innerHTML = '';
        }
        return;
      }

      if (marketResult.status === 'rejected' && productResult.status === 'rejected') {
        // 任务在队列里是 SUCCESS(allSettled 恒 fulfilled)但内容全失败 —— 不 evict
        // 的话「点击重试」会拿回同一份坏结果,永远无法真正重试。
        taskQueue.evict?.(`stats-${productId}`);
        panelFastDataPromises.delete(productId);
        showError();
        return;
      }

      // 会员门控兜底:会员在页面打开期间过期(或门控查询 fail-open 放行但后端拦了)
      // → SW 透传 __featureGated,渲染锁定卡而非空数据卡
      if (productResult.status === 'fulfilled' && productResult.value?.__featureGated) {
        panelFastDataPromises.delete(productId);
        renderLockedPanel();
        return;
      }

      // 先缓存快车道统计与在途 variants，早点击采集也能复用当前这一轮请求。
      panelDataCache.set(productId, firstData);

      // —— 首帧:stats/market 到手立即渲染;variants/跟卖数由 populate 到货即补 ——
      let populatePromise = null;
      if (typeof window.jzRenderProductPanelV2 === 'function') {
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

      // —— 全齐后收尾:终局合并并写入 panelDataCache ——
      const [variantResult, followSellResult] = await Promise.allSettled([slowVariant, slowFollow]);
      if (populatePromise) await populatePromise;

      if (!card?.isConnected) {
        panelFastDataPromises.delete(productId);
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
      panelFastDataPromises.delete(productId);
      // V1 老渲染兜底(V2 已在首帧渲染过,不重复整卡重绘)
      if (typeof window.jzRenderProductPanelV2 !== 'function') {
        window.jzRenderProductCardPanel(panel, data);
      }

      if (panel) panel.dataset.jzLoadStatus = 'ready';
    } catch {
      panelFastDataPromises.delete(productId);
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

  async function panelDataForCollect(sku) {
    const cached = panelDataCache.get(sku);
    if (cached) return cached;
    const pending = panelFastDataPromises.get(sku);
    if (!pending) return null;
    try {
      const loaded = await pending;
      return panelDataCache.get(sku) || loaded?.firstData || null;
    } catch {
      return null;
    }
  }

  async function buildSearchCollectRaw(sku, info, data) {
    const collectImages = info.image ? [info.image] : [];
    const sellerEvidence = typeof window.jzReadOzonCollectEvidence === 'function'
      ? await Promise.resolve(
          window.jzReadOzonCollectEvidence(sku, data?.preFetched?.variant),
        ).catch(() => ({}))
      : {};
    return {
      ...sellerEvidence,
      sku: String(sku),
      url: info.url,
      name: info.name,
      price: info.price != null ? String(info.price) : undefined,
      priceCurrency: info.priceCurrency || undefined,
      marketingPrice: info.marketingPrice != null ? String(info.marketingPrice) : undefined,
      marketingPriceCurrency: info.marketingPriceCurrency || undefined,
      image: info.image || undefined,
      images: collectImages.length ? collectImages : undefined,
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
    const code = String(error?.code || '');
    const message = String(error?.message || '');
    if (/COLLECTOR_AUTH_REQUIRED|COLLECTOR_PERMISSION_DENIED|COLLECTOR_SESSION_CHANGED|WEB_AUTH_REQUIRED/.test(code)) {
      return message || '请先登录 Web';
    }
    if (message) return message;
    return /NETWORK_ERROR|超时|timeout|网络/i.test(code) ? '网络错误，请稍后重试' : '采集失败';
  }

  // 「采集」按钮与 action bar 上的「一键采集」语义统一，只写后台采集箱。
  //
  // resp shape: { dedupeHit, result }。
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
      const [data, enrichedInfo] = await Promise.all([
        panelDataForCollect(productId),
        enrichInfoWithDetailMarketingPrice(info),
      ]);
      info = enrichedInfo;
      const collectPromise = collectCoordinator.collect({
        sku: productId,
        raw: await buildSearchCollectRaw(productId, info, data),
      });
      const resp = await collectPromise;

      const label = resp?.dedupeHit ? '近期已采集' : '已采集';
      flashBtn(btn, label, 'is-collected', 1800);
    } catch (e) {
      console.warn('[ozon-helper] collect-one failed:', e);
      if (collectCoordinator.getState(productId).status === 'BLOCKED_AUTH') {
        const body = panel.querySelector('.ozon-helper-sidebar-card-body') || panel;
        window.jzRenderDataCardLoginRequired(body);
        return;
      }
      flashBtn(btn, collectFailurePresentation(e), 'is-failed', 7000);
    } finally {
      btn.dataset.busy = '';
    }
  }

  function flashBtn(btn, text, cls, ms) {
    const original = btn.dataset.jzOriginalHtml || btn.innerHTML;
    btn.classList.add(cls);
    btn.innerHTML = `<span class="oh-btn-icon">✓</span>${text}`;
    setTimeout(() => {
      btn.classList.remove(cls);
      btn.innerHTML = original;
      delete btn.dataset.jzOriginalHtml;
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
      const [data, enrichedInfo] = await Promise.all([
        panelDataForCollect(sku),
        enrichInfoWithDetailMarketingPrice(info),
      ]);
      info = enrichedInfo;
      const collectPromise = collectCoordinator.collect({
        sku,
        raw: await buildSearchCollectRaw(sku, info, data),
      });
      const resp = await collectPromise;
      const itemId = resp?.result?.id;
      const frontendUrl = 'http://127.0.0.1:3000';
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
      const sku = extractProductId(info.url);
      if (sku && collectCoordinator.getState(sku).status === 'BLOCKED_AUTH') {
        const body = panel.querySelector('.ozon-helper-sidebar-card-body') || panel;
        window.jzRenderDataCardLoginRequired(body);
        return;
      }
      btn.innerHTML = collectFailurePresentation(err);
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

  // 类目策略选样是独立模式：只调用专用扩展通道，不复用普通采集按钮、队列或存储。
  const categoryStrategySampling = (() => {
    const api = window.JzCategoryStrategySampling;
    if (!api?.createCategoryStrategySamplingController) return null;
    let announced = false;
    let lastReadinessAt = 0;
    let samplingSessionId = null;
    let validatedPageUrl = '';
    let samplingFeedback = '';
    let refreshTimer = null;
    let expiryTimer = null;
    const controller = api.createCategoryStrategySamplingController({
      now: () => Date.now(),
      getSession: async () => {
        let requestedSessionId = null;
        try {
          const candidate = new URL(location.href).searchParams
            .get('zongziCategoryStrategySession');
          if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(candidate || '')) {
            requestedSessionId = candidate;
          }
        } catch {}
        if (!requestedSessionId) {
          samplingSessionId = null;
          return null;
        }
        const needsReadiness = !announced || Date.now() - lastReadinessAt >= 60_000;
        const action = needsReadiness
          ? 'CATEGORY_STRATEGY_SESSION_START' : 'CATEGORY_STRATEGY_SESSION_GET';
        announced = true;
        if (needsReadiness) lastReadinessAt = Date.now();
        const result = await window.sendMessage(action, { sessionId: requestedSessionId });
        samplingSessionId = result?.sessionId || null;
        return result;
      },
      capturePageFacts: (payload) =>
        window.sendMessage('CATEGORY_STRATEGY_PAGE_FACTS_CAPTURE', payload),
      captureCardFacts: (payload) =>
        window.sendMessage('CATEGORY_STRATEGY_CARD_FACTS_CAPTURE', payload),
      confirmSamples: (payload) =>
        window.sendMessage('CATEGORY_STRATEGY_SAMPLES_CONFIRM', payload),
      cancelSession: (payload) => window.sendMessage('CATEGORY_STRATEGY_SESSION_CANCEL', payload),
    });

    const removeUi = () => {
      document.querySelectorAll('[data-zongzi-category-strategy-sampling]')
        .forEach((node) => node.remove());
      document.querySelectorAll('.zongzi-category-strategy-sampling-selected')
        .forEach((node) => node.classList.remove('zongzi-category-strategy-sampling-selected'));
    };

    const schedule = (state) => {
      clearTimeout(refreshTimer);
      clearTimeout(expiryTimer);
      if (state.mode === 'INACTIVE' && samplingSessionId) {
        refreshTimer = setTimeout(() => refresh().catch(() => {}), 3000);
      } else if (state.expiresAt) {
        expiryTimer = setTimeout(() => refresh().catch(() => {}),
          Math.max(250, Math.min(2_147_000_000, Date.parse(state.expiresAt) - Date.now() + 20)));
      }
    };

    const renderBar = (state) => {
      let bar = document.querySelector('.zongzi-category-strategy-sampling-bar');
      if (state.mode === 'INACTIVE') {
        bar?.remove();
        return;
      }
      if (!bar) {
        bar = document.createElement('section');
        bar.className = 'zongzi-category-strategy-sampling-bar';
        bar.dataset.zongziCategoryStrategySampling = 'bar';
        bar.innerHTML = '<div class="zongzi-category-strategy-sampling-summary"></div>'
          + '<div class="zongzi-category-strategy-sampling-actions">'
          + '<button type="button" data-category-strategy-action="cancel">取消配置</button>'
          + '<button type="button" data-category-strategy-action="confirm">确定选样</button></div>';
        bar.addEventListener('click', async (event) => {
          const action = event.target?.dataset?.categoryStrategyAction;
          if (!action) return;
          event.preventDefault();
          try {
            const operation = action === 'cancel' ? controller.cancel() : controller.confirm();
            render();
            await operation;
          } catch (error) {
            samplingFeedback = safeFeedback(error?.code);
          }
          render();
        });
        document.body.appendChild(bar);
      }
      const summary = bar.querySelector('.zongzi-category-strategy-sampling-summary');
      let summaryText;
      if (state.mode === api.MODE) {
        summaryText = `类目策略选样 · ${state.scope.descriptionCategoryId}/${state.scope.typeId}`
          + ` · 已选 ${state.selectedCount}/20（至少 5 个）`;
      } else {
        summaryText = '此页面的 Ozon 类目信息无法与配置任务精确匹配，请返回后重新打开。';
      }
      if (samplingFeedback) summaryText += ` · ${samplingFeedback}`;
      if (summary.textContent !== summaryText) summary.textContent = summaryText;
      const confirm = bar.querySelector('[data-category-strategy-action="confirm"]');
      confirm.disabled = !state.canConfirm;
    };

    const renderCard = (card, state) => {
      let control = card.querySelector(':scope > .zongzi-category-strategy-sampling-control');
      if (state.mode !== api.MODE) {
        control?.remove();
        card.classList.remove('zongzi-category-strategy-sampling-selected');
        return;
      }
      const info = extractCardInfo(card);
      const sku = extractProductId(info.url);
      if (!sku || !info.url) {
        control?.remove();
        return;
      }
      if (!control) {
        control = document.createElement('button');
        control.type = 'button';
        control.className = 'zongzi-category-strategy-sampling-control';
        control.dataset.zongziCategoryStrategySampling = 'card';
        control.setAttribute('aria-label', '选择为类目策略样品');
        control.addEventListener('click', async (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (control.disabled) return;
          control.disabled = true;
          control.dataset.status = 'validating';
          try {
            const currentSku = control.dataset.strategySku;
            const currentUrl = control.dataset.strategyUrl;
            const selected = controller.snapshot().selectedSkus.includes(currentSku);
            if (selected) {
              await window.sendMessage('CATEGORY_STRATEGY_SELECTION_REMOVE', {
                sessionId: samplingSessionId,
                sku: currentSku,
              });
              controller.deselect({ sku: currentSku });
            }
            else await controller.select({ sku: currentSku, productUrl: currentUrl });
            delete control.dataset.error;
            delete control.dataset.feedback;
          } catch (error) {
            control.dataset.error = error?.code || 'CATEGORY_STRATEGY_SAMPLING_FACTS_INVALID';
            control.dataset.feedback = safeFeedback(error?.code);
            if (error?.code === 'CATEGORY_STRATEGY_SAMPLING_PAGE_FACTS_INVALID') {
              await refresh();
            }
          } finally {
            control.disabled = false;
            delete control.dataset.status;
            render();
          }
        });
        card.style.position = 'relative';
        card.appendChild(control);
      }
      control.dataset.strategySku = sku;
      control.dataset.strategyUrl = info.url;
      const selected = state.selectedSkus.includes(sku);
      const controlText = control.dataset.feedback
        || (selected ? '✓ 已选' : '＋ 选为样品');
      if (control.textContent !== controlText) control.textContent = controlText;
      control.setAttribute('aria-pressed', String(selected));
      card.classList.toggle('zongzi-category-strategy-sampling-selected', selected);
    };

    const render = () => {
      const state = controller.snapshot();
      if (state.mode === 'INACTIVE') removeUi();
      renderBar(state);
      getCards().forEach((card) => renderCard(card, state));
      schedule(state);
    };

    async function refresh() {
      try {
        const state = await controller.refresh({ pageUrl: location.href });
        if (state.mode === api.MODE) {
          controller.restoreSelections(
            await window.sendMessage('CATEGORY_STRATEGY_SELECTIONS_GET', {
              sessionId: samplingSessionId,
            }),
          );
          validatedPageUrl = location.href;
          samplingFeedback = '';
        }
      }
      catch { /* controller projects failures into a closed state */ }
      render();
    }

    function safeFeedback(code) {
      if (code === 'CATEGORY_STRATEGY_SAMPLING_CARD_SCOPE_MISMATCH') {
        return '非目标类目或商品类型不一致';
      }
      if (code === 'CATEGORY_STRATEGY_SAMPLING_FACTS_INVALID') return '类目待确认，未计入样本';
      if (code === 'CATEGORY_STRATEGY_SAMPLING_COUNT_INVALID') return '请选择 5～20 个有效样本';
      if (code === 'CATEGORY_STRATEGY_SAMPLING_PAGE_FACTS_INVALID') {
        return '页面已变化，正在重新确认类目';
      }
      return '类目策略选样暂时无法完成，请重试';
    }

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'session' && changes.sonliCollectorSession) {
          announced = false;
          lastReadinessAt = 0;
          samplingSessionId = null;
          removeUi();
          refresh().catch(() => {});
        }
      });
    } catch {}
    return Object.freeze({ refresh, render, needsPageRefresh: () => {
      const hasSession = /[?&]zongziCategoryStrategySession=/.test(location.search);
      return (validatedPageUrl && location.href !== validatedPageUrl)
        || (!validatedPageUrl && hasSession);
    } });
  })();

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
    categoryStrategySampling?.render();
  }

  function createObserver() {
    let _applyPending = false;
    let _strategyRefreshUrl = '';
    const observer = new MutationObserver(() => {
      if (_applyPending) return;
      _applyPending = true;
      requestAnimationFrame(() => {
        _applyPending = false;
        if (categoryStrategySampling?.needsPageRefresh() && _strategyRefreshUrl !== location.href) {
          _strategyRefreshUrl = location.href;
          categoryStrategySampling.refresh().catch(() => {});
          return;
        }
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
    }

    await loadPanelEnabled();
    listenStorageToggle();
    await categoryStrategySampling?.refresh();
    applyToCards();
    createObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
})();
