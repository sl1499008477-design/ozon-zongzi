/**
 * Browser Agent collection actions.
 *
 * These actions reuse the existing source-provider ingest path. They never run
 * server-provided JavaScript; the only dynamic input is a typed params object.
 */
(() => {
  const DEFAULT_LIMIT = 5;
  const MAX_LIMIT = 20;
  const TAB_LOAD_TIMEOUT_MS = 30000;
  const SCRAPE_TIMEOUT_MS = 15000;

  if (!globalThis.JzBrowserAgentActions) {
    throw new Error('JzBrowserAgentActions must be loaded before collect-actions');
  }

  // 代采能力位:仅当本机已登录 seller.ozon.ru(存在 sc_company_id cookie)时上报。
  // 后端据此只把 tenant-scope 的 ozon.collect_variant 任务派给已登录设备,未登录
  // 设备领不到,避免它领走后必然失败、把发起方的代采请求白白耗掉。
  if (typeof globalThis.JzBrowserAgentActions.registerDynamicCapability === 'function') {
    globalThis.JzBrowserAgentActions.registerDynamicCapability(
      'ozon.seller_collect',
      async () => {
        try {
          const cookies = await chrome.cookies.getAll({
            url: 'https://seller.ozon.ru/',
            name: 'sc_company_id',
          });
          return !!cookies?.[0]?.value;
        } catch {
          return false;
        }
      },
    );
  }

  function clampLimit(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
  }

  function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  function tabCreate(url) {
    return new Promise((resolve, reject) => {
      chrome.tabs.create({ url, active: false }, (tab) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(tab);
      });
    });
  }

  function tabUpdate(tabId, updateProperties) {
    return new Promise((resolve, reject) => {
      chrome.tabs.update(tabId, updateProperties, (tab) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(tab);
      });
    });
  }

  function tabGet(tabId) {
    return new Promise((resolve, reject) => {
      chrome.tabs.get(tabId, (tab) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(tab);
      });
    });
  }

  function waitForTabComplete(tabId) {
    return withTimeout(
      new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => chrome.tabs.onUpdated.removeListener(listener);
        const finish = (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };
        const listener = (updatedTabId, changeInfo, tab) => {
          if (updatedTabId !== tabId) return;
          if (changeInfo.status === 'complete') finish(tab);
        };
        chrome.tabs.onUpdated.addListener(listener);
        tabGet(tabId)
          .then((tab) => {
            if (tab.status === 'complete') finish(tab);
          })
          .catch((e) => {
            if (!settled) {
              settled = true;
              cleanup();
              reject(e);
            }
          });
      }),
      TAB_LOAD_TIMEOUT_MS,
      'tab load',
    );
  }

  async function ensureTab(url) {
    const tab = await tabCreate(url);
    await waitForTabComplete(tab.id);
    return tab;
  }

  async function executeScript(tabId, func, args = []) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
    });
    return result?.result;
  }

  function buildHotProductsUrl(params) {
    if (params.url || params.sourceUrl) {
      return assertOzonUrl(String(params.url || params.sourceUrl));
    }
    const category = String(params.category || '').trim();
    const source = String(params.source || '').trim();
    const query =
      category ||
      (source === 'china_pavilion' ? 'товары из китая' : 'популярные товары');
    const url = new URL('https://www.ozon.ru/search/');
    url.searchParams.set('text', query);
    // Ozon may ignore unknown sorting values, but this keeps the intent
    // explicit and harmless for public search pages.
    if (String(params.ranking || '').includes('hot')) {
      url.searchParams.set('sorting', 'rating');
    }
    return url.toString();
  }

  function assertOzonUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Invalid Ozon URL');
    }
    if (!/^https:$/.test(url.protocol) || !/(^|\.)ozon\.(ru|kz|by)$/.test(url.hostname)) {
      throw new Error('Only Ozon HTTPS URLs are allowed for browser-agent collection');
    }
    return url.toString();
  }

  async function scrapeHotProductCards(tabId, limit) {
    return withTimeout(
      executeScript(tabId, async (maxItems) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const productIdFromUrl = (url) => {
          const match = String(url || '').match(/\/product\/.*-(\d{5,})/);
          return match ? match[1] : null;
        };
        const normalizePrice = (text) => {
          const cleaned = String(text || '').replace(/[^\d.,]/g, '').replace(/\s/g, '');
          if (!cleaned) return null;
          const normalized = cleaned.replace(',', '.');
          const n = Number(normalized);
          return Number.isFinite(n) ? String(n) : null;
        };
        const moneyTokenPattern = /(?:(?:[\u20bd\u00a5\uffe5]|\b(?:CNY|RMB|RUB)\b|\u0440\u0443\u0431\.?)\s*\d[\d\s]*(?:[,.]\d{1,2})?|\d[\d\s]*(?:[,.]\d{1,2})?\s*(?:[\u20bd\u00a5\uffe5]|\b(?:CNY|RMB|RUB)\b|\u0440\u0443\u0431\.?|\u5143))/i;
        const extractPriceText = (text) => {
          const match = String(text || '').replace(/\s+/g, ' ').trim().match(moneyTokenPattern);
          return match ? match[0] : String(text || '');
        };
        const detectPriceCurrency = (text) => {
          const value = String(text || '');
          if (/[\u00a5\uffe5]|\b(?:CNY|RMB)\b|\u5143/i.test(value)) return 'CNY';
          if (/\u20bd|\bRUB\b|\u0440\u0443\u0431/i.test(value)) return 'RUB';
          return null;
        };
        const pickTitle = (link, img, card) =>
          (
            link?.getAttribute('aria-label') ||
            img?.getAttribute('alt') ||
            link?.textContent ||
            card?.textContent ||
            ''
          )
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 240);
        const collect = () => {
          const links = Array.from(document.querySelectorAll('a[href*="/product/"]'));
          const seen = new Set();
          const rows = [];
          for (const link of links) {
            const href = link.href || link.getAttribute('href') || '';
            const sku = productIdFromUrl(href);
            if (!sku || seen.has(sku)) continue;
            seen.add(sku);
            const card = link.closest('[data-widget="searchResultsItem"], .tile-root, div');
            const img =
              card?.querySelector('img') ||
              link.querySelector('img') ||
              document.querySelector(`a[href*="${sku}"] img`);
            const priceNode =
              card?.querySelector('[data-widget="searchResultsPrice"]') ||
              card?.querySelector('[data-widget="webPrice"]') ||
              card?.querySelector('[class*="price"]');
            const priceText = extractPriceText(priceNode?.textContent || '');
            const title = pickTitle(link, img, card);
            rows.push({
              sku,
              url: href.split('?')[0],
              name: title || null,
              price: normalizePrice(priceText),
              priceCurrency: detectPriceCurrency(priceText) || undefined,
              image: img?.currentSrc || img?.src || img?.getAttribute('data-src') || null,
              images: img?.currentSrc || img?.src ? [img.currentSrc || img.src] : undefined,
              keyword: new URLSearchParams(location.search).get('text') || null,
            });
            if (rows.length >= maxItems) break;
          }
          return rows;
        };

        const deadline = Date.now() + 12000;
        let rows = collect();
        while (rows.length === 0 && Date.now() < deadline) {
          window.scrollBy(0, Math.floor(window.innerHeight * 0.8));
          await sleep(800);
          rows = collect();
        }
        return rows;
      }, [limit]),
      SCRAPE_TIMEOUT_MS,
      'hot product scrape',
    );
  }

  async function scrapeProductDetail(tabId, sourceUrl) {
    return withTimeout(
      executeScript(tabId, async (url) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const productIdFromUrl = (value) => {
          const match = String(value || '').match(/\/product\/.*-(\d{5,})/);
          return match ? match[1] : null;
        };
        const normalizePrice = (text) => {
          const cleaned = String(text || '').replace(/[^\d.,]/g, '').replace(/\s/g, '');
          if (!cleaned) return null;
          const normalized = cleaned.replace(',', '.');
          const n = Number(normalized);
          return Number.isFinite(n) ? String(n) : null;
        };
        const moneyTokenPattern = /(?:(?:[\u20bd\u00a5\uffe5]|\b(?:CNY|RMB|RUB)\b|\u0440\u0443\u0431\.?)\s*\d[\d\s]*(?:[,.]\d{1,2})?|\d[\d\s]*(?:[,.]\d{1,2})?\s*(?:[\u20bd\u00a5\uffe5]|\b(?:CNY|RMB|RUB)\b|\u0440\u0443\u0431\.?|\u5143))/i;
        const extractPriceText = (text) => {
          const match = String(text || '').replace(/\s+/g, ' ').trim().match(moneyTokenPattern);
          return match ? match[0] : String(text || '');
        };
        const detectPriceCurrency = (text) => {
          const value = String(text || '');
          if (/[\u00a5\uffe5]|\b(?:CNY|RMB)\b|\u5143/i.test(value)) return 'CNY';
          if (/\u20bd|\bRUB\b|\u0440\u0443\u0431/i.test(value)) return 'RUB';
          return null;
        };
        const read = () => {
          const sku = productIdFromUrl(url || location.href);
          const title =
            document.querySelector('h1')?.textContent?.trim() ||
            document.querySelector('[data-widget="webProductHeading"]')?.textContent?.trim() ||
            document.querySelector('meta[property="og:title"]')?.content ||
            document.title;
          const image =
            document.querySelector('meta[property="og:image"]')?.content ||
            document.querySelector('[data-widget="webGallery"] img')?.currentSrc ||
            document.querySelector('[data-widget="webGallery"] img')?.src ||
            document.querySelector('img')?.currentSrc ||
            document.querySelector('img')?.src ||
            null;
          const priceText =
            extractPriceText(
              document.querySelector('[data-widget="webPrice"]')?.textContent ||
                document.querySelector('[data-widget="webSale"]')?.textContent ||
                '',
            );
          return sku
            ? {
                sku,
                url: (url || location.href).split('?')[0],
                name: title ? title.replace(/\s+/g, ' ').slice(0, 240) : null,
                price: normalizePrice(priceText),
                priceCurrency: detectPriceCurrency(priceText) || undefined,
                image,
                images: image ? [image] : undefined,
              }
            : null;
        };
        const deadline = Date.now() + 10000;
        let row = read();
        while (!row && Date.now() < deadline) {
          await sleep(700);
          row = read();
        }
        return row;
      }, [sourceUrl]),
      SCRAPE_TIMEOUT_MS,
      'product detail scrape',
    );
  }

  async function enrichVariant(raw) {
    if (!raw?.sku) return raw;
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'searchVariants', sku: String(raw.sku) },
          (result) => resolve(result),
        );
      });
      const items = response?.items || response?.data?.items || [];
      const match = items.find((item) => String(item.variant_id) === String(raw.sku)) || items[0];
      if (match) return { ...raw, variantData: match };
    } catch {}
    return raw;
  }

  async function collectRaw(raw, job) {
    const result = await globalThis.JzBackendClient.collectSource({
      sourceId: 'ozon',
      raw,
      storeId: job.storeId || undefined,
    });
    return {
      ...result,
      raw: {
        sku: raw.sku,
        url: raw.url,
        name: raw.name,
        image: raw.image,
      },
    };
  }

  globalThis.JzBrowserAgentActions.register(
    'collect.hot_products',
    async (job, context) => {
      const params = job?.params || {};
      const limit = clampLimit(params.limit);
      const url = buildHotProductsUrl(params);
      await context.reportProgress?.({
        stage: 'opening_source',
        message: 'Opening Ozon product source',
        percent: 10,
        payload: { url },
      });
      const tab = await ensureTab(url);

      await context.reportProgress?.({
        stage: 'scraping_candidates',
        message: 'Reading visible product cards',
        percent: 35,
      });
      const candidates = await scrapeHotProductCards(tab.id, limit);
      if (!candidates.length) {
        throw new Error('No Ozon product cards found on the source page');
      }

      const collected = [];
      for (let i = 0; i < candidates.length; i += 1) {
        context.throwIfCancelled?.();
        await context.reportProgress?.({
          stage: 'collecting_candidates',
          message: `Collecting ${i + 1}/${candidates.length}`,
          percent: Math.min(95, 45 + Math.round((i / candidates.length) * 45)),
          payload: { sku: candidates[i].sku },
        });
        const enriched = await enrichVariant(candidates[i]);
        context.throwIfCancelled?.();
        collected.push(await collectRaw(enriched, job));
      }

      return {
        sourceUrl: url,
        count: collected.length,
        candidates: collected,
      };
    },
  );

  // 代采:同租户内某个没登卖家端的用户把按 SKU 采集竞品的请求派过来,本机(已登
  // seller.ozon.ru)在自己的浏览器里跑同一套 searchVariants(走 /api/v1/search +
  // create-bundle-by-variant-id),把带 attribute_id + dictionary_value_id 的完整
  // 结构化结果回传。noProxy:true 防止本机万一掉登录态时再触发一次代采(递归)。
  globalThis.JzBrowserAgentActions.register(
    'ozon.collect_variant',
    async (job, context) => {
      const sku = String(job?.params?.sku || '').trim();
      if (!sku) throw new Error('sku is required');
      await context.reportProgress?.({
        stage: 'collecting_variant',
        message: `代采 SKU ${sku}`,
        percent: 20,
        payload: { sku },
      });
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'searchVariants', sku, noProxy: true },
          (result) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(result);
            }
          },
        );
      });
      // 基础设施性错误(本机掉登录态/反爬/无 tab)→ 抛错让任务 fail,发起方据此回退,
      // 而不是把空/错结果当成功回传。业务空结果({ ok:true, items:[] })属正常,照常回传。
      if (!response || response.ok === false) {
        const err = new Error(response?.message || response?.error || '代采 searchVariants 失败');
        err.code = response?.error || 'COLLECT_VARIANT_FAILED';
        throw err;
      }
      // 与本地 searchVariants 完全同 shape:{ ok:true, data:{ items } }。
      return response;
    },
  );

  // 代采「市场数据」:没登卖家端的用户把按 SKU 取月销量(what_to_sell/data/v3)的请求派过来,
  // 本机(已登 seller)在自己浏览器里跑同一套 getMarketStats 过反爬,把 { ok, data } 回传。
  // 后端服务器 IP 直连会被反爬挡(307 loop),所以必须借已登录设备的浏览器。noProxy:true 防递归。
  globalThis.JzBrowserAgentActions.register(
    'ozon.market_data',
    async (job, context) => {
      const sku = String(job?.params?.sku || '').trim();
      // what_to_sell period:'monthly'(月,默认)/ 'weekly'(周)。2026-06 月接口已恢复,默认回月;
      // 尊重 job.params.period(数据卡周期开关),非 weekly 一律按 monthly。
      const rawPeriod = String(job?.params?.period || 'monthly').trim();
      const period = rawPeriod === 'weekly' ? 'weekly' : 'monthly';
      if (!sku) throw new Error('sku is required');
      await context.reportProgress?.({
        stage: 'fetching_market_data',
        message: `代采市场数据 SKU ${sku}`,
        percent: 20,
        payload: { sku, period },
      });
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'getMarketStats', sku, period, noProxy: true },
          (result) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(result);
            }
          },
        );
      });
      // 本机掉登录态/反爬(getMarketStats 返 __needSellerLogin)→ 抛错让任务 fail,
      // 发起方据此回退(或换设备),而不是把"需登录"当成功回传。
      if (!response || response.ok === false || response?.data?.__needSellerLogin) {
        const err = new Error(response?.message || response?.error || '代采 getMarketStats 失败');
        err.code = response?.data?.__reason || response?.error || 'MARKET_DATA_FAILED';
        throw err;
      }
      // { ok:true, data:<item|null> } —— data 为 null 表示该 SKU 确无市场数据(正常,照传)。
      return response;
    },
  );

  globalThis.JzBrowserAgentActions.register(
    'collect.product_detail',
    async (job, context) => {
      const params = job?.params || {};
      const sourceUrlRaw = String(params.sourceUrl || params.url || '').trim();
      const sourceUrl = sourceUrlRaw ? assertOzonUrl(sourceUrlRaw) : '';
      if (!sourceUrl) throw new Error('sourceUrl is required');
      await context.reportProgress?.({
        stage: 'opening_product',
        message: 'Opening Ozon product page',
        percent: 10,
        payload: { sourceUrl },
      });
      const tab = await ensureTab(sourceUrl);
      context.throwIfCancelled?.();
      const raw = await scrapeProductDetail(tab.id, sourceUrl);
      if (!raw?.sku) throw new Error('No Ozon product detail found');
      await context.reportProgress?.({
        stage: 'collecting_product',
        message: `Collecting ${raw.sku}`,
        percent: 70,
      });
      const enriched = await enrichVariant(raw);
      context.throwIfCancelled?.();
      const collected = await collectRaw(enriched, job);
      return {
        sourceUrl,
        count: 1,
        item: collected,
      };
    },
  );
})();
