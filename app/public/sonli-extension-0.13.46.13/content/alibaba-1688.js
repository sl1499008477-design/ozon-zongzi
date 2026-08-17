/**
 * alibaba-1688.js — 注入到 https://detail.1688.com/offer/{offerId}.html
 *
 * 在 1688 商品详情页右下角注入极掌快捷菜单。
 * 点击后从页面上抓取商品信息（title / images / price / sku / seller），
 * 通过 background 的 pushSourceCollect 推到后端 /api/sources/1688/collect。
 *
 * 抓取采用多策略 fallback（globals → ld+json → DOM 选择器 → 兜底默认值）：
 * 1688 详情页结构有时会改版，把数据藏到不同地方，所以每个字段都尽量给三条路。
 *
 * 用户必须先在自己浏览器登录 1688 才能拿到批发价/SKU等需要会话的数据。
 * 不登录也能采集，但很多字段会缺失。
 */

(() => {
  if (window.__JZC_1688_INJECTED__) return;
  window.__JZC_1688_INJECTED__ = true;

  const OFFER_ID_RE = /detail\.1688\.com\/offer\/(\d+)\.html/i;
  const log = (...a) => console.log('[jzc-1688]', ...a);
  const BRAND = getBrand();
  const PAGE_DATA_RESPONSE_TYPE = 'JZC_1688_PAGE_DATA';
  const PAGE_DATA_REQUEST_TYPE = 'JZC_1688_REQUEST_PAGE_DATA';
  const PAGE_DATA_RESPONSE_SOURCE = 'jzc-1688-page-data-hook';
  const PAGE_DATA_REQUEST_SOURCE = 'jzc-1688-scraper';
  const PAGE_GLOBAL_KEYS = ['__INIT_DATA__', 'detailData', 'runParams', '__detail_data__', 'offerDetail', 'pageData', 'offerInfo', '__INIT__', 'hummerData'];
  const pageDataBridge = { globals: {}, jsonLd: [] };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data || {};
    if (message.source !== PAGE_DATA_RESPONSE_SOURCE || message.type !== PAGE_DATA_RESPONSE_TYPE) return;
    const payload = message.payload || {};
    if (payload.globals && typeof payload.globals === 'object') {
      pageDataBridge.globals = payload.globals;
    }
    if (Array.isArray(payload.jsonLd)) {
      pageDataBridge.jsonLd = payload.jsonLd;
    }
  });

  function requestPageData() {
    try {
      window.postMessage({ source: PAGE_DATA_REQUEST_SOURCE, type: PAGE_DATA_REQUEST_TYPE }, '*');
    } catch {}
  }

  requestPageData();
  setTimeout(requestPageData, 250);

  // ───────────────────────────────────────────────────── extraction helpers ──

  /** Extract offer id from current URL or fallback locations. */
  function extractOfferId() {
    const m = location.href.match(OFFER_ID_RE);
    if (m) return m[1];
    const canonical = document.querySelector('link[rel="canonical"]')?.href;
    if (canonical) {
      const m2 = canonical.match(OFFER_ID_RE);
      if (m2) return m2[1];
    }
    return null;
  }

  /** Try several globals 1688 has historically used. */
  function readGlobals() {
    for (const k of PAGE_GLOBAL_KEYS) {
      const bridged = pageDataBridge.globals?.[k];
      if (bridged && typeof bridged === 'object') return { key: k, data: bridged };
      try {
        const v = window[k];
        if (v && typeof v === 'object') return { key: k, data: v };
      } catch {}
    }
    return null;
  }

  /** JSON-LD blocks are often present for SEO and contain structured fields. */
  function readJsonLd() {
    const out = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        const j = JSON.parse(s.textContent || '');
        if (j) out.push(j);
      } catch {}
    });
    return out;
  }

  function structuredRoots() {
    const roots = [];
    for (const key of PAGE_GLOBAL_KEYS) {
      const bridged = pageDataBridge.globals?.[key];
      if (bridged && typeof bridged === 'object') roots.push({ key: `bridge:${key}`, data: bridged });
      try {
        const data = window[key];
        if (data && typeof data === 'object') roots.push({ key, data });
      } catch {}
    }
    for (const item of pageDataBridge.jsonLd || []) roots.push({ key: 'bridge:jsonLd', data: item });
    for (const item of readJsonLd()) roots.push({ key: 'jsonLd', data: item });
    return roots;
  }

  function walkObjects(root, visit, depth = 0, seen = new Set()) {
    if (!root || typeof root !== 'object' || depth > 8 || seen.has(root)) return;
    seen.add(root);
    visit(root);
    const values = Array.isArray(root) ? root.slice(0, 200) : Object.values(root).slice(0, 200);
    for (const value of values) walkObjects(value, visit, depth + 1, seen);
  }

  function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const key of keys) {
      if (obj[key] != null) return obj[key];
    }
    return undefined;
  }

  function asText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const out = String(value).trim();
    return out || null;
  }

  function toAbsoluteUrl(src) {
    if (!src || typeof src !== 'string') return null;
    let out = src.trim().replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    if (!out) return null;
    if (out.startsWith('//')) out = `${location.protocol}${out}`;
    if (out.startsWith('/')) out = `${location.origin}${out}`;
    return out;
  }

  function normalizeProductImage(src) {
    let out = toAbsoluteUrl(src);
    if (!out) return null;
    if (/\.svg(?:\?|$)/i.test(out)) return null;
    if (/-tps-\d+-\d+/i.test(out)) return null;
    if (!/cbu01\.alicdn\.com|cbu01\.1688\.com|img\.alicdn\.com\/imgextra|gw\.alicdn\.com\/imgextra/i.test(out)) {
      return null;
    }
    out = out.split('#')[0].split('?')[0];
    out = out
      .replace(/_(\d+)x(\d+)q?\d*\.(jpg|jpeg|png|webp)(?:_?\.webp)?$/i, '.$3')
      .replace(/\.(jpg|jpeg|png|webp)_\.webp$/i, '.$1')
      .replace(/\.(jpg|jpeg|png|webp)\.webp$/i, '.$1');
    return out;
  }

  function pushUnique(list, value) {
    const normalized = normalizeProductImage(value);
    if (normalized && !list.includes(normalized)) list.push(normalized);
  }

  function pushImageLike(list, value) {
    if (!value) return;
    if (typeof value === 'string') {
      pushUnique(list, value);
      return;
    }
    if (typeof value !== 'object') return;
    pushUnique(list, pick(value, ['url', 'image', 'imageUrl', 'imgUrl', 'picUrl', 'originalUrl', 'fullPath']));
  }

  function imageFromElement(el) {
    if (!el) return null;
    const img = el.matches?.('img') ? el : el.querySelector?.('img');
    const attrs = img
      ? [
          img.getAttribute('data-original'),
          img.getAttribute('data-src'),
          img.getAttribute('src'),
          img.getAttribute('srcset')?.split(/\s+/)[0],
        ]
      : [];
    for (const src of attrs) {
      const normalized = normalizeProductImage(src);
      if (normalized) return normalized;
    }
    const style = el.getAttribute?.('style') || '';
    const bg = style.match(/url\(["']?([^"')]+)["']?\)/i)?.[1];
    return normalizeProductImage(bg);
  }

  function moneyFromText(text) {
    const raw = String(text || '');
    const m = raw.match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/);
    const value = m?.[1];
    if (!value) return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
  }

  function stockFromText(text) {
    const m = String(text || '').match(/库存\s*([\d.]+)\s*件?/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  function hashText(text) {
    let hash = 0;
    const raw = String(text || '');
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  function stableSku(offerId, axisName, name, idx) {
    return `${offerId}-${String(idx + 1).padStart(2, '0')}-${hashText(`${axisName || ''}:${name || ''}`)}`;
  }

  function normalizeSkuAxes(rawProps) {
    if (!Array.isArray(rawProps)) return [];
    return rawProps.map((prop, idx) => {
      const name = asText(pick(prop, ['prop', 'name', 'propName', 'propertyName', 'attributeName'])) || `规格${idx + 1}`;
      const rawValues = pick(prop, ['value', 'values', 'valueList', 'propValues', 'propertyValues']) || [];
      const options = (Array.isArray(rawValues) ? rawValues : []).map((value) => {
        if (typeof value === 'string' || typeof value === 'number') {
          return { name: String(value), id: String(value) };
        }
        const optionName = asText(pick(value, ['name', 'value', 'valueName', 'propValue', 'propertyValueName', 'text']));
        if (!optionName) return null;
        return {
          name: optionName,
          id: asText(pick(value, ['id', 'valueId', 'vid', 'skuPropertyValueId', 'propertyValueId'])),
          image: normalizeProductImage(pick(value, ['image', 'imageUrl', 'imgUrl', 'picUrl', 'url'])),
        };
      }).filter(Boolean);
      return { name, options };
    }).filter((axis) => axis.options.length > 0);
  }

  function parseSkuKey(key, axes) {
    const raw = String(key || '');
    const aspectValues = {};
    raw.split(/[;；|,，]+/).forEach((part) => {
      const pieces = part.split(/[:：=]/).map((s) => s.trim()).filter(Boolean);
      if (pieces.length >= 2) aspectValues[pieces[0]] = pieces.slice(1).join(':');
    });
    if (Object.keys(aspectValues).length > 0) return aspectValues;

    for (const axis of axes) {
      const matched = axis.options.find((option) =>
        (option.id && raw.includes(String(option.id))) || raw.includes(option.name)
      );
      if (matched) aspectValues[axis.name] = matched.name;
    }
    return Object.keys(aspectValues).length > 0 ? aspectValues : null;
  }

  function aspectImage(aspectValues, axes) {
    if (!aspectValues) return null;
    for (const axis of axes) {
      const value = aspectValues[axis.name];
      const option = axis.options.find((item) => item.name === value);
      if (option?.image) return option.image;
    }
    return null;
  }

  /**
   * Extract a clean product title.
   *
   * Note: <h1> on the current 1688 layout is the SHOP NAME, not the product
   * title. Don't trust h1. The product title lives in `.title-content`
   * (preferred) or `.module-od-title` (with trailing review counts to strip).
   * document.title is reliable but has " - 阿里巴巴" suffix.
   */
  function extractTitle() {
    const titleContent = document.querySelector('.title-content');
    if (titleContent?.textContent?.trim()) return titleContent.textContent.trim();

    const modTitle = document.querySelector('.module-od-title');
    if (modTitle) {
      // Take just the first text node — "【清仓特价款】XXX\n3400+人好评\n400+人已加购"
      const first = (modTitle.textContent || '').split('\n')[0].trim();
      if (first.length > 6) return first;
    }

    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (ogTitle && ogTitle.length > 6) return ogTitle.trim();

    // Last resort: clean up document.title
    const t = document.title || '';
    return t.replace(/\s*[-_|]\s*(阿里巴巴|1688\.com|alibaba).*$/i, '').trim();
  }

  /** Pull images from gallery / og:image / generic alicdn imgs. Dedup + size up. */
  function extractImages() {
    const images = [];

    for (const root of structuredRoots()) {
      walkObjects(root.data, (obj) => {
        ['imageList', 'images', 'mainImages', 'detailImages', 'imageUrls', 'albumImages', 'skuImages'].forEach((key) => {
          const value = obj[key];
          if (Array.isArray(value)) value.forEach((item) => pushImageLike(images, item));
        });
        ['image', 'imageUrl', 'imgUrl', 'picUrl', 'mainImage', 'coverImage'].forEach((key) => {
          if (obj[key]) pushImageLike(images, obj[key]);
        });
      });
    }

    // og:image
    const og = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
    if (og) pushUnique(images, og);

    // Gallery containers (multiple historical class names)
    document.querySelectorAll([
      '.detail-gallery-img img',
      '.preview-image img',
      '.preview-list img',
      '.tab-trigger img',
      '.module-od-sku-selection img',
      '.module-od-product-description img',
      '[class*="description"] img',
      '[class*="MainPic"] img',
      '[class*="preview"] img',
      '[class*="gallery"] img',
    ].join(',')).forEach((img) => {
      pushUnique(images, img.getAttribute('data-original') || img.getAttribute('data-src') || img.src);
    });

    // Fallback: every product-looking image on the page (already filtered inside pushUnique)
    if (images.length < 2) {
      document.querySelectorAll('img').forEach((img) => pushUnique(images, img.src));
    }

    return images;
  }

  /**
   * Extract price (single/range) from DOM or JSON-LD.
   *
   * Modern 1688 detail page (verified 2026-05) renders the main price inside
   * `.module-od-main-price`. Number is split across spans like
   *   <span>15</span><span>.00</span>
   * so concatenated text reads "¥\n15\n.00\n\n1件起批\n\n已售200+件".
   */
  function extractPrice() {
    // JSON-LD often has Offer/lowPrice/highPrice
    for (const j of readJsonLd()) {
      const offers = j.offers || j.mainEntity?.offers;
      if (offers) {
        if (offers.lowPrice && offers.highPrice) return { range: `${offers.lowPrice}~${offers.highPrice}`, single: null };
        if (offers.price) return { range: null, single: String(offers.price) };
      }
    }

    /**
     * Parse the first price out of free text.
     *
     * 1688 splits the integer and decimal into separate spans:
     *   <span>¥</span><span>15</span><span>.00</span><span>1件起批</span>
     * Concatenated with whitespace stripped this is `¥15.001件起批`. We must
     * cap the decimal portion at 2 digits so we don't gobble the "1" from
     * "1件起批" — prices on 1688 always use 2 decimal places at most.
     */
    const parseFromText = (raw) => {
      if (!raw) return null;
      const s = raw.replace(/\s+/g, '');
      // 只认紧跟 ¥ 的价格。1688 的数量阶梯(如「¥0.72 500-1999双」)里数量不带 ¥，
      // 旧的宽松 range 正则会把 `¥0.72`+`500-1999双` 拼成 `72500-1999` 误当价格区间
      // (offer 799324601711 实测抓出 72500)。只取 ¥ 后的小数价就不会跨界。
      const prices = [...s.matchAll(/[¥￥](\d+(?:\.\d{1,2})?)/g)]
        .map((m) => m[1]).filter((v) => Number(v) > 0);
      if (!prices.length) return null;
      // 单价优先取「到手单价/批发价」(用户实际采购成本)，否则页面第一个 ¥ 价。
      const pref =
        s.match(/到手[^¥￥]{0,4}[¥￥](\d+(?:\.\d{1,2})?)/) ||
        s.match(/批发[价]?[¥￥](\d+(?:\.\d{1,2})?)/);
      const single = pref ? pref[1] : prices[0];
      const nums = prices.map(Number), lo = Math.min(...nums), hi = Math.max(...nums);
      return { range: lo !== hi ? `${lo}~${hi}` : null, single };
    };

    // Preferred: main price module
    const mainEl = document.querySelector('.module-od-main-price');
    if (mainEl) {
      const p = parseFromText(mainEl.textContent || '');
      if (p) return p;
    }

    // Sometimes range price is rendered separately
    const rangeEl = document.querySelector('.module-od-price-range, [class*="priceRange"]');
    if (rangeEl) {
      const p = parseFromText(rangeEl.textContent || '');
      if (p) return p;
    }

    // Final fallback — any price-ish container
    for (const sel of ['[class*="price-now"]', '[class*="mainPrice"]', '.price-num', '.price-text']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const p = parseFromText(el.textContent || '');
      if (p) return p;
    }
    return { range: null, single: null };
  }

  /** Wholesale price ladder (阶梯价) — array of {minQty, price}. */
  function extractWholesale() {
    const out = [];
    // Tries: a table or list under "价格" panel
    document.querySelectorAll('[class*="ladder"] li, [class*="priceList"] li, [class*="priceTable"] tr').forEach((row) => {
      const text = row.textContent || '';
      const m = text.match(/(\d+)\s*[件个起≥>=]?\s*[¥￥]?\s*(\d+(?:\.\d+)?)/);
      if (m) out.push({ minQty: Number(m[1]), price: m[2] });
    });
    return out.length ? out : null;
  }

  /**
   * Seller (店铺) info.
   *
   * Verified 2026-05: the shop NAME anchor points to `https://shopXXXX.1688.com/?...`
   * (no `/page/` segment). The other anchor going to `/page/offerlist.htm` has
   * link text "商品" (a tab label), not the shop name. So we filter on the URL
   * shape, not the link text.
   */
  function extractSeller() {
    let name = null;
    let shopUrl = null;
    document.querySelectorAll('a[href*=".1688.com"]').forEach((a) => {
      const href = a.href || '';
      // Match shop root: shop1234567.1688.com/?... but NOT /page/* or /winport/*
      if (!/^https?:\/\/shop\d+\.1688\.com\/(\?|$)/i.test(href)) return;
      const text = a.textContent?.trim();
      if (!text || text.length > 40) return;
      if (!name || text.length > name.length) {
        name = text;
        shopUrl = href;
      }
    });
    if (!name) {
      const winport = document.querySelector('.winport-title');
      if (winport) name = (winport.textContent || '').split('\n')[0].trim() || null;
    }
    return { name, shopUrl };
  }

  /**
   * Sold count for THIS product. The page also shows "已售X件" on recommended
   * products — those live in `.offer-sales` inside `.module-od-shop-product-recommend`.
   * We want only the main one which lives in `.module-od-main-price` (or its
   * `.sold-count`).
   */
  function extractSoldCount() {
    const candidates = [
      document.querySelector('.module-od-main-price .sold-count'),
      document.querySelector('.module-od-main-price'),
    ];
    for (const el of candidates) {
      if (!el) continue;
      const text = el.textContent || '';
      const m = text.match(/已售\s*([0-9.万千+]+)\s*件?/);
      if (!m) continue;
      let n = m[1].replace(/\+/g, '');
      if (/万/.test(n)) n = parseFloat(n.replace('万', '')) * 10000;
      else if (/千/.test(n)) n = parseFloat(n.replace('千', '')) * 1000;
      else n = parseFloat(n);
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    return null;
  }

  function packageWeightToG(value, unit) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const u = String(unit || '').trim().toLowerCase();
    if (/^(kg|千克|公斤)$/.test(u)) return Math.round(n * 1000);
    return Math.round(n);
  }

  function packageLengthToCm(value, unit) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const u = String(unit || '').trim().toLowerCase();
    if (/^(mm|毫米)$/.test(u)) return Math.round(n) / 10;
    if (/^(m|米)$/.test(u)) return n * 100;
    return n;
  }

  function compactPackaging(record) {
    const out = {
      lengthCm: record?.lengthCm ?? null,
      widthCm: record?.widthCm ?? null,
      heightCm: record?.heightCm ?? null,
      weightG: record?.weightG ?? null,
    };
    return (out.lengthCm || out.widthCm || out.heightCm || out.weightG) ? out : null;
  }

  function extractPackagingFromText(text) {
    const raw = String(text || '').replace(/\s+/g, ' ');
    if (!raw) return null;
    const weightMatch = raw.match(/(?:包装重量|包装重|装箱重量|外箱重量|毛重|净重|克重|重量)[^\d]{0,30}(\d+(?:\.\d+)?)\s*(kg|千克|公斤|g|克)?/i);
    const dimMatch = raw.match(/(?:包装尺寸|包装规格|装箱尺寸|外箱尺寸|箱规|包装体积)[^\d]{0,60}(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米)?\s*[×xX*✕✖]\s*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米)?\s*[×xX*✕✖]\s*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米)?/i);
    const inferredDimUnit = dimMatch ? (dimMatch[2] || dimMatch[4] || dimMatch[6] || 'cm') : '';
    return compactPackaging({
      weightG: weightMatch ? packageWeightToG(weightMatch[1], weightMatch[2] || 'g') : null,
      lengthCm: dimMatch ? packageLengthToCm(dimMatch[1], dimMatch[2] || inferredDimUnit) : null,
      widthCm: dimMatch ? packageLengthToCm(dimMatch[3], dimMatch[4] || inferredDimUnit) : null,
      heightCm: dimMatch ? packageLengthToCm(dimMatch[5], dimMatch[6] || inferredDimUnit) : null,
    });
  }

  /**
   * 包装重量/三维 — 1688 正规卖家常带一张"装箱信息表"：
   *   颜色 | 尺码 | 长(cm) | 宽(cm) | 高(cm) | 体积(cm³) | 重量(g)
   * 找表头含「长(cm)/重量」的 table，解析列索引，取第一条有效数据行。
   * 多数商品所有 SKU 同箱规，取第一行即可；抓不到返回 null（向导用默认值/手填）。
   */
  function extractPackaging() {
    try {
      for (const tbl of document.querySelectorAll('table')) {
        const headRow = tbl.querySelector('tr');
        if (!headRow) continue;
        const heads = [...headRow.querySelectorAll('th,td')].map((c) => (c.textContent || '').trim());
        const find = (re) => heads.findIndex((h) => re.test(h));
        const li = find(/长.*cm|长\(cm\)/i), wi = find(/宽.*cm/i), hi = find(/高.*cm/i),
              gi = find(/重量|净重|毛重|克重/);
        if (li < 0 && gi < 0) continue;
        for (const tr of [...tbl.querySelectorAll('tr')].slice(1)) {
          const cells = [...tr.querySelectorAll('td,th')].map((c) => (c.textContent || '').trim());
          const num = (i) => { if (i < 0) return null; const m = (cells[i] || '').match(/[\d.]+/); return m ? parseFloat(m[0]) : null; };
          const lengthCm = num(li), widthCm = num(wi), heightCm = num(hi), weightG = num(gi);
          const parsed = compactPackaging({ lengthCm, widthCm, heightCm, weightG });
          if (parsed) return parsed;
        }
      }
      const textFallback = extractPackagingFromText(document.body?.innerText || '');
      if (textFallback) return textFallback;
    } catch (e) { log('extractPackaging failed', e); }
    return null;
  }

  /**
   * 1688「商品属性」键值对 — 用于喂给 AI 做类目判断 + Ozon 属性填充。
   * 当前 1688 详情页用 `.decision-attributes-list` 网格，每个 item 的 innerText
   * 是「名\n值」。抓到的如 {面料成分:'锦纶/尼龙', 风格:'运动休闲', 功能:'速干', …}。
   */
  function extractSpecs() {
    const specs = {};
    try {
      let grid = document.querySelector('.decision-attributes-list');
      if (!grid) {
        // 退回：找子项较多、含典型属性词的网格容器
        grid = [...document.querySelectorAll('div,ul,dl')].find((el) =>
          el.children.length > 5 && /(面料|材质|风格|适用|成分|功能)/.test(el.textContent || '')) || null;
      }
      if (grid) {
        [...grid.children].forEach((it) => {
          const parts = (it.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
          if (parts.length >= 2) {
            const k = parts[0].replace(/[:：]\s*$/, '');
            const v = parts.slice(1).join(' ').replace(/^[:：]\s*/, '');
            if (k && v && k.length < 20) specs[k] = v.slice(0, 80);
          }
        });
      }
    } catch (e) { log('extractSpecs failed', e); }
    return Object.keys(specs).length ? specs : null;
  }

  function extractVariants({ offerId, basePrice } = {}) {
    const structured = extractStructuredVariants({ offerId });
    if (structured.length) return structured;

    const industryTable = extractIndustryTableVariants({ offerId, basePrice });
    if (industryTable.length) return industryTable;

    const axes = extractDomVariantAxes();
    if (!axes.length) return [];
    return expandVariantAxes(axes, { offerId, basePrice });
  }

  function extractStructuredVariants({ offerId } = {}) {
    for (const root of structuredRoots()) {
      let found = [];
      walkObjects(root.data, (obj) => {
        if (found.length) return;
        const axes = normalizeSkuAxes(pick(obj, ['skuProps', 'skuPropList', 'skuPropertyList', 'salePropList']));
        const skuMap = pick(obj, ['skuMap', 'skuInfoMap', 'skuMapData', 'skuIdMap']);
        if (axes.length && skuMap && typeof skuMap === 'object' && !Array.isArray(skuMap)) {
          found = Object.entries(skuMap).map(([key, item], idx) =>
            variantFromStructuredEntry(item || {}, {
              key,
              axes,
              offerId,
              idx,
            })
          ).filter(Boolean);
          return;
        }

        const list = pick(obj, ['variants', 'skuList', 'skuInfos', 'skuInfoList']);
        if (Array.isArray(list) && list.length) {
          found = list.map((item, idx) =>
            variantFromStructuredEntry(item || {}, {
              key: item?.key || item?.specId || item?.skuKey || '',
              axes,
              offerId,
              idx,
            })
          ).filter(Boolean);
        }
      });
      if (found.length) return found.slice(0, 120);
    }
    return [];
  }

  function variantFromStructuredEntry(entry, { key, axes, offerId, idx }) {
    const aspectValues =
      (entry.aspectValues && typeof entry.aspectValues === 'object' ? entry.aspectValues : null) ||
      (entry.attrs && typeof entry.attrs === 'object' ? entry.attrs : null) ||
      (entry.specAttrs && typeof entry.specAttrs === 'object' ? entry.specAttrs : null) ||
      parseSkuKey(key, axes) ||
      {};
    const cleanAspectValues = {};
    Object.entries(aspectValues).forEach(([k, v]) => {
      const keyText = asText(k);
      const valueText = asText(v);
      if (keyText && valueText) cleanAspectValues[keyText] = valueText;
    });
    if (!Object.keys(cleanAspectValues).length && axes.length) return null;

    const sku = asText(pick(entry, ['sku', 'skuId', 'id', 'specId', 'skuIdStr'])) ||
      stableSku(offerId, key || 'sku', Object.values(cleanAspectValues).join('-'), idx);
    const image =
      normalizeProductImage(pick(entry, ['image', 'imageUrl', 'imgUrl', 'picUrl', 'skuImage'])) ||
      aspectImage(cleanAspectValues, axes);
    const price = firstPresentMoney(entry, ['price', 'salePrice', 'discountPrice', 'consignPrice', 'activityPrice']);
    const stock = Number(pick(entry, ['stock', 'amount', 'quantity', 'canBookCount', 'inventory']));
    const name = asText(pick(entry, ['name', 'skuName', 'title'])) || Object.values(cleanAspectValues).join(' ');
    return {
      sku,
      name,
      ...(price ? { price } : {}),
      ...(image ? { image, images: [image] } : {}),
      ...(Number.isFinite(stock) ? { stock } : {}),
      ...(Object.keys(cleanAspectValues).length ? { aspectValues: cleanAspectValues } : {}),
    };
  }

  function firstPresentMoney(obj, keys) {
    for (const key of keys) {
      const value = obj?.[key];
      if (value == null) continue;
      const price = moneyFromText(String(value).includes('¥') || String(value).includes('￥') ? String(value) : `¥${value}`);
      if (price) return price;
    }
    return null;
  }

  function cleanCellText(el) {
    return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeTableHeader(text) {
    return String(text || '').replace(/\s+/g, ' ').replace(/[：:]+$/g, '').trim();
  }

  function isIndustryPriceHeader(label) {
    return /价格|库存|price|stock|inventory/i.test(label || '');
  }

  function isIndustryQuantityHeader(label) {
    return /进货|采购|数量|下单|quantity|amount/i.test(label || '');
  }

  function plainNumber(text) {
    const m = String(text || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  }

  function priceAndStockFromIndustryCell(cell) {
    if (!cell) return {};
    const priceBox = cell.querySelector?.('.gyp-pro-table-price, [class*="pro-table-price"], [class*="table-price"]') || cell;
    const spans = Array.from(priceBox.querySelectorAll?.('span') || [])
      .map((span) => cleanCellText(span))
      .filter(Boolean);
    const price = spans.map(moneyFromText).find(Boolean) || moneyFromText(cleanCellText(priceBox));
    let stock = stockFromText(cleanCellText(priceBox));
    if (stock == null) {
      const stockText = spans.find((text) => !moneyFromText(text) && /^\d+(?:\.\d+)?$/.test(text.replace(/,/g, '')));
      const parsed = plainNumber(stockText);
      if (parsed != null) stock = Math.round(parsed);
    }
    return { price, stock };
  }

  function extractIndustryTableVariants({ offerId, basePrice } = {}) {
    const roots = Array.from(document.querySelectorAll([
      '.module-od-industry-pro-sku-selection',
      '.industry-pro-sku-selection',
      '[class*="industry-pro-sku-selection"]',
    ].join(','))).filter((root, idx, list) => root && list.indexOf(root) === idx);
    const variants = [];
    const seen = new Set();

    for (const root of roots) {
      const headers = Array.from(root.querySelectorAll('.ant-table-thead th, thead th'))
        .map((th) => normalizeTableHeader(cleanCellText(th)));
      const rows = Array.from(root.querySelectorAll('.ant-table-tbody tr, tbody tr'));

      for (const row of rows) {
        if (variants.length >= 120) break;
        const cells = Array.from(row.querySelectorAll('td'));
        if (!cells.length) continue;

        const nameCellIndex = Math.max(0, cells.findIndex((cell) =>
          cell.querySelector('.gyp-pro-table-title, [class*="pro-table-title"], [class*="table-title"]') ||
          imageFromElement(cell)
        ));
        const nameCell = cells[nameCellIndex] || cells[0];
        const nameBox =
          nameCell.querySelector('.gyp-pro-table-title, [class*="pro-table-title"], [class*="table-title"]') ||
          nameCell;
        const name = cleanCellText(nameBox);
        if (!name || /价格|库存|进货|采购|数量/.test(name)) continue;

        const priceCellIndex = cells.findIndex((cell, idx) =>
          isIndustryPriceHeader(headers[idx]) ||
          cell.querySelector('.gyp-pro-table-price, [class*="pro-table-price"], [class*="table-price"]') ||
          /[¥￥]/.test(cleanCellText(cell))
        );
        const { price, stock } = priceAndStockFromIndustryCell(cells[priceCellIndex]);
        if (!price) continue;
        const image = imageFromElement(nameCell) || imageFromElement(row);

        const aspectValues = {};
        cells.forEach((cell, idx) => {
          const header = headers[idx] || (idx === nameCellIndex ? '产品规格' : `规格${idx + 1}`);
          if (!header || isIndustryPriceHeader(header) || isIndustryQuantityHeader(header)) return;
          const value = idx === nameCellIndex ? name : cleanCellText(cell);
          if (value && value.length <= 120) aspectValues[header] = value;
        });
        if (!aspectValues['产品规格'] && name) aspectValues['产品规格'] = name;

        const rowKey = row.getAttribute('data-row-key') || '';
        const fingerprint = rowKey ? `row:${rowKey}` : [
          name,
          price,
          Object.entries(aspectValues).map(([k, v]) => `${k}:${v}`).join('|'),
        ].join('::');
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);

        variants.push({
          sku: rowKey || stableSku(offerId, 'industry-table', name, variants.length),
          name,
          price,
          ...(image ? { image, images: [image] } : {}),
          ...(stock != null ? { stock } : {}),
          ...(Object.keys(aspectValues).length ? { aspectValues } : {}),
        });
      }
    }

    return variants;
  }

  function extractDomVariantAxes() {
    const root = document.querySelector('.module-od-sku-selection, [class*="sku-selection"], [class*="SkuSelection"]');
    if (!root) return [];

    const featureBlocks = root.querySelectorAll('.feature-item, [class*="feature-item"], [class*="sku-prop"], [class*="SkuProp"]');
    const blocks = featureBlocks.length ? Array.from(featureBlocks) : [root];
    const axes = [];

    blocks.forEach((feature) => {
      const featureLines = ((feature.innerText || feature.textContent || '').split('\n'))
        .map((s) => s.trim())
        .filter(Boolean);
      const axisName =
        feature.querySelector(':scope > [class*="title"], :scope > [class*="name"], :scope > [class*="label"]')?.textContent?.trim() ||
        featureLines.find((line) => !/[¥￥]\s*\d|库存|已选|请选择/.test(line) && line.length <= 20) ||
        '规格';

      const optionNodes = feature.querySelectorAll([
        '.expand-view-item',
        '[class*="expand-view-item"]',
        '.sku-filter-button',
        '[class*="sku-filter-button"]',
        'button[class*="sku-filter"]',
        '[role="button"][class*="sku-filter"]',
        '[class*="sku-item"]',
        '[class*="SkuItem"]',
        '[class*="spec-item"]',
        '[class*="value-item"]',
        '[class*="ValueItem"]',
      ].join(','));

      const options = [];
      Array.from(optionNodes).forEach((node) => {
        const text = (node.innerText || node.textContent || '').trim();
        if (!text || /禁用|disabled/i.test(node.className || '')) return;
        const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
        const name =
          node.getAttribute('title') ||
          node.getAttribute('aria-label') ||
          lines.find((line) =>
            line !== axisName &&
            !/[¥￥]\s*\d|库存|起批|已售|件$|请选择|加购/.test(line) &&
            line.length <= 80
          );
        if (!name) return;

        if (options.some((item) => item.name === name)) return;
        options.push({
          name,
          id: node.getAttribute('data-sku-id') || node.getAttribute('data-sku') || node.getAttribute('data-id') || node.getAttribute('data-value-id') || null,
          image: imageFromElement(node),
          price: moneyFromText(text),
          stock: stockFromText(text),
        });
      });
      if (options.length) axes.push({ name: axisName, options });
    });

    return axes;
  }

  function expandVariantAxes(axes, { offerId, basePrice }) {
    const variants = [];
    const walk = (idx, chosen) => {
      if (variants.length >= 120) return;
      if (idx >= axes.length) {
        const aspectValues = {};
        chosen.forEach(({ axis, option }) => { aspectValues[axis.name] = option.name; });
        const joined = chosen.map(({ option }) => option.name).join(' ');
        const image = chosen.map(({ option }) => option.image).find(Boolean);
        const price = chosen.map(({ option }) => option.price).find(Boolean) || basePrice || null;
        const stock = chosen.map(({ option }) => option.stock).find((v) => v != null);
        variants.push({
          sku: stableSku(offerId, 'sku', joined, variants.length),
          name: joined,
          price,
          ...(image ? { image, images: [image] } : {}),
          ...(stock != null ? { stock } : {}),
          aspectValues,
        });
        return;
      }
      const axis = axes[idx];
      axis.options.forEach((option) => walk(idx + 1, [...chosen, { axis, option }]));
    };
    walk(0, []);
    return variants;
  }

  function normalizeVideoUrl(src) {
    const out = toAbsoluteUrl(src);
    if (!out || !/\.(mp4|m3u8)(?:[?#]|$)/i.test(out)) return null;
    return out;
  }

  function extractVideo() {
    const candidates = [];
    let structuredCover = null;
    for (const root of structuredRoots()) {
      walkObjects(root.data, (obj) => {
        const direct = pick(obj, ['videoUrl', 'video_url', 'mainVideoUrl', 'mainVideo', 'playUrl', 'videoPlayUrl']);
        if (direct) candidates.push(direct);
        const videoObj = pick(obj, ['video', 'mainVideoInfo', 'videoInfo']);
        if (videoObj && typeof videoObj === 'object') {
          candidates.push(pick(videoObj, ['url', 'videoUrl', 'playUrl', 'mp4Url', 'src']));
          structuredCover = structuredCover || normalizeProductImage(pick(videoObj, ['cover', 'coverUrl', 'poster', 'image', 'imageUrl']));
        }
        structuredCover = structuredCover || normalizeProductImage(pick(obj, ['videoCover', 'videoCoverUrl', 'poster', 'coverUrl']));
      });
    }
    document.querySelectorAll('video, source').forEach((el) => {
      candidates.push(el.currentSrc, el.src, el.getAttribute('src'), el.getAttribute('data-src'));
    });
    [
      'meta[property="og:video"]',
      'meta[property="og:video:url"]',
      'meta[property="og:video:secure_url"]',
      'meta[name="twitter:player:stream"]',
    ].forEach((sel) => {
      const content = document.querySelector(sel)?.getAttribute('content');
      if (content) candidates.push(content);
    });

    const scripts = Array.from(document.querySelectorAll('script'))
      .map((s) => s.textContent || '')
      .filter((text) => /\.(mp4|m3u8)/i.test(text))
      .join('\n');
    const urlMatches = scripts.match(/https?:\\?\/\\?\/[^"'\\\s]+?\.(?:mp4|m3u8)(?:[^"'\\\s]*)?/gi) || [];
    candidates.push(...urlMatches);

    const url = candidates.map(normalizeVideoUrl).find(Boolean);
    if (!url) return null;
    const cover =
      structuredCover ||
      normalizeProductImage(document.querySelector('video')?.getAttribute('poster')) ||
      normalizeProductImage(document.querySelector('meta[property="og:image"]')?.getAttribute('content')) ||
      extractImages()[0] ||
      null;
    return { url, cover };
  }

  /** Build the canonical raw payload that the 1688 provider's normalize() expects. */
  function buildPayload() {
    const offerId = extractOfferId();
    if (!offerId) return null;
    const title = extractTitle();
    const images = extractImages();
    const price = extractPrice();
    const wholesale = extractWholesale();
    const seller = extractSeller();
    const soldCount = extractSoldCount();
    const packaging = extractPackaging();
    const specs = extractSpecs();
    const variants = extractVariants({ offerId, basePrice: price.single });
    const video = extractVideo();
    return {
      sku: offerId,
      offerId,
      title,
      mainImages: images,
      price: price.single,
      priceRange: price.range,
      wholesalePrice: wholesale,
      seller,
      soldCount,
      packaging,
      specs,
      variants,
      skuList: variants,
      videoUrl: video?.url || null,
      videoCover: video?.cover || null,
      url: location.href.split('#')[0],
    };
  }

  // ──────────────────────────────────────────────────────────── floating UI ──

  function getBrand() {
    const runtime = globalThis.__JZ_BRAND__ || {};
    // dev 源码加载时 build.js 没跑,占位符保持字面量 → 运行时兜底平台品牌。
    // /__BRAND/ 探测避免被 build textual replace 命中(否则分销商 build 被误兜底)。
    const displayNameFallback = /__BRAND/.test("ozon 粽子")
      ? "平台"
      : "ozon 粽子";
    const displayName = runtime.displayName || displayNameFallback;
    const webHost = runtime.webHost || (/__BRAND/.test('qh.jizhangerp.com') ? 'store.jizhangerp.com' : 'qh.jizhangerp.com');
    const primaryColor = runtime.primaryColor || '#2168ff';
    return { displayName, webHost, primaryColor, logoUrl: runtime.logoUrl || null };
  }

  function iconSvg(name) {
    const paths = {
      image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-4.2-4.2a2 2 0 0 0-2.8 0L5 19"/>',
      box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
      upload: '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.box}</svg>`;
  }

  function injectStyles() {
    if (document.getElementById('jzc-1688-panel-style')) return;
    const style = document.createElement('style');
    style.id = 'jzc-1688-panel-style';
    style.textContent = `
      #jzc-1688-panel {
        position: fixed;
        right: 24px;
        bottom: 72px;
        z-index: 2147483647;
        width: 220px;
        color: #07142f;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }
      #jzc-1688-panel, #jzc-1688-panel * { box-sizing: border-box; }
      #jzc-1688-panel .jzc-1688-card {
        position: relative;
        padding: 14px;
        border: 1px solid rgba(231, 236, 246, 0.96);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.16), 0 2px 7px rgba(15, 23, 42, 0.08);
        backdrop-filter: blur(10px);
      }
      #jzc-1688-panel .jzc-1688-brand {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 32px;
        padding: 4px 4px 10px;
      }
      #jzc-1688-panel .jzc-1688-logo {
        display: inline-flex;
        width: 32px;
        height: 32px;
        flex: 0 0 32px;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        border-radius: 8px;
        background: ${BRAND.primaryColor};
        color: #fff;
        font-size: 15px;
        font-weight: 900;
        line-height: 1;
      }
      #jzc-1688-panel .jzc-1688-logo img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      #jzc-1688-panel .jzc-1688-name {
        font-size: 15px;
        font-weight: 700;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #jzc-1688-panel .jzc-1688-divider {
        height: 1px;
        margin: 0 0 8px;
        background: #e4eaf5;
      }
      #jzc-1688-panel .jzc-1688-action {
        display: flex;
        width: 100%;
        height: 38px;
        align-items: center;
        gap: 10px;
        margin-top: 4px;
        padding: 0 12px;
        border: 1px solid transparent;
        border-radius: 9px;
        background: #f3f6fb;
        color: #07142f;
        cursor: pointer;
        font: inherit;
        text-align: left;
        transition: transform 0.14s ease, border-color 0.14s ease, background 0.14s ease, box-shadow 0.14s ease;
      }
      #jzc-1688-panel .jzc-1688-action:hover {
        transform: translateY(-1px);
        background: #eef3fb;
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.08);
      }
      #jzc-1688-panel .jzc-1688-action.is-primary {
        border-color: ${BRAND.primaryColor};
        background: #eaf1ff;
        color: ${BRAND.primaryColor};
      }
      #jzc-1688-panel .jzc-1688-action:disabled {
        cursor: wait;
        opacity: 0.78;
        transform: none;
        box-shadow: none;
      }
      #jzc-1688-panel .jzc-1688-action-icon {
        display: inline-flex;
        width: 16px;
        height: 16px;
        flex: 0 0 16px;
        align-items: center;
        justify-content: center;
        color: ${BRAND.primaryColor};
      }
      #jzc-1688-panel .jzc-1688-action-icon svg {
        width: 16px;
        height: 16px;
      }
      #jzc-1688-panel .jzc-1688-action-label {
        min-width: 0;
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 600;
      }
      #jzc-1688-panel .jzc-1688-hot {
        flex: 0 0 auto;
        padding: 1.5px 6px;
        border-radius: 8px;
        background: #ff5b5b;
        color: #fff;
        font-size: 9px;
        font-weight: 800;
        line-height: 1.4;
      }
      @media (max-width: 720px) {
        #jzc-1688-panel {
          right: 12px;
          bottom: 18px;
          width: min(220px, calc(100vw - 24px));
        }
      }
      /* 可拖动（拖品牌头/小球）+ 可收起成小球（缩放）*/
      #jzc-1688-panel .jzc-1688-brand{cursor:grab;user-select:none;}
      #jzc-1688-panel.jzc-dragging{transition:none!important;}
      #jzc-1688-panel.jzc-dragging .jzc-1688-brand,
      #jzc-1688-panel.jzc-dragging .jzc-1688-ball{cursor:grabbing;}
      #jzc-1688-panel .jzc-1688-collapse{margin-left:auto;width:24px;height:24px;display:flex;
        align-items:center;justify-content:center;border-radius:7px;color:#90a0bd;font-size:17px;
        font-weight:800;line-height:1;cursor:pointer;flex:0 0 24px;}
      #jzc-1688-panel .jzc-1688-collapse:hover{background:#eef2f8;color:#0f1f3d;}
      #jzc-1688-panel.jzc-collapsed{width:54px!important;}
      #jzc-1688-panel.jzc-collapsed .jzc-1688-card{display:none;}
      #jzc-1688-panel .jzc-1688-ball{display:none;width:54px;height:54px;border-radius:16px;
        background:${BRAND.primaryColor};color:#fff;align-items:center;justify-content:center;
        font-size:23px;font-weight:900;cursor:grab;overflow:hidden;
        box-shadow:0 12px 30px rgba(15,23,42,.28);}
      #jzc-1688-panel.jzc-collapsed .jzc-1688-ball{display:flex;}
      #jzc-1688-panel .jzc-1688-ball img{width:100%;height:100%;object-fit:cover;}
    `;
    document.head.appendChild(style);
  }

  function createPanel() {
    if (document.getElementById('jzc-1688-panel')) return;
    injectStyles();

    const root = document.createElement('div');
    root.id = 'jzc-1688-panel';
    const brandDisplayName = BRAND.displayName || "平台";
    const logo = BRAND.logoUrl
      ? `<span class="jzc-1688-logo"><img src="${escapeAttr(BRAND.logoUrl)}" alt="${escapeAttr(brandDisplayName)}"></span>`
      : `<span class="jzc-1688-logo">${escapeHtml(brandDisplayName.slice(0, 1))}</span>`;
    const ballInner = BRAND.logoUrl
      ? `<img src="${escapeAttr(BRAND.logoUrl)}" alt="${escapeAttr(brandDisplayName)}">`
      : escapeHtml(brandDisplayName.slice(0, 1));
    root.innerHTML = `
      <div class="jzc-1688-card">
        <div class="jzc-1688-brand">
          ${logo}
          <span class="jzc-1688-name">${escapeHtml(brandDisplayName)}</span>
          <span class="jzc-1688-collapse" data-action="collapse" title="收起">—</span>
        </div>
        <div class="jzc-1688-divider"></div>
        <button class="jzc-1688-action" type="button" data-action="copy-image" data-label="复制图片">
          <span class="jzc-1688-action-icon">${iconSvg('image')}</span>
          <span class="jzc-1688-action-label">复制图片</span>
        </button>
        <button class="jzc-1688-action" type="button" data-action="collect-product" data-label="采集商品">
          <span class="jzc-1688-action-icon">${iconSvg('box')}</span>
          <span class="jzc-1688-action-label">采集商品</span>
        </button>
        <button class="jzc-1688-action is-primary" type="button" data-action="manual-listing" data-label="手动上架">
          <span class="jzc-1688-action-icon">${iconSvg('upload')}</span>
          <span class="jzc-1688-action-label">手动上架</span>
          <span class="jzc-1688-hot">HOT</span>
        </button>
        <button class="jzc-1688-action is-primary" type="button" data-action="ai-wizard" data-label="AI 采集" id="jzc-1688-ai-btn" style="display:none">
          <span class="jzc-1688-action-icon">${iconSvg('box')}</span>
          <span class="jzc-1688-action-label">AI 采集上架</span>
          <span class="jzc-1688-hot">AI</span>
        </button>
      </div>
      <div class="jzc-1688-ball" title="展开${escapeAttr(brandDisplayName)}">${ballInner}</div>
    `;
    root.addEventListener('click', onPanelClick);
    document.body.appendChild(root);
    setupFloat(root);
  }

  // 浮窗交互：拖动（拖品牌头或收起后的小球）+ 收起成小球（缩放）。
  // 位置与收起状态持久化到 localStorage，刷新/换页后保持。
  const FLOAT_KEY = 'jzc_1688_float';
  function floatSave(patch) {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(FLOAT_KEY) || '{}'); } catch (e) {}
    Object.assign(s, patch);
    try { localStorage.setItem(FLOAT_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function collapsePanel(on) {
    const p = document.getElementById('jzc-1688-panel');
    if (!p) return;
    p.classList.toggle('jzc-collapsed', on);
    floatSave({ collapsed: on });
  }
  function setupFloat(root) {
    // 恢复上次位置 / 收起态
    try {
      const s = JSON.parse(localStorage.getItem(FLOAT_KEY) || '{}');
      if (typeof s.left === 'number') {
        root.style.left = s.left + 'px'; root.style.top = s.top + 'px';
        root.style.right = 'auto'; root.style.bottom = 'auto';
      }
      if (s.collapsed) root.classList.add('jzc-collapsed');
    } catch (e) {}
    const clamp = (x, y) => {
      const w = root.offsetWidth, h = root.offsetHeight;
      return [Math.max(6, Math.min(x, window.innerWidth - w - 6)),
              Math.max(6, Math.min(y, window.innerHeight - h - 6))];
    };
    function startDrag(e) {
      if (e.button !== 0) return;
      const r = root.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      let moved = false;
      root.__dragMoved = false;
      root.classList.add('jzc-dragging');
      const mv = (ev) => {
        if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 4) moved = true;
        const [x, y] = clamp(ev.clientX - ox, ev.clientY - oy);
        root.style.left = x + 'px'; root.style.top = y + 'px';
        root.style.right = 'auto'; root.style.bottom = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        root.classList.remove('jzc-dragging');
        root.__dragMoved = moved;
        if (moved) {
          const r2 = root.getBoundingClientRect();
          floatSave({ left: Math.round(r2.left), top: Math.round(r2.top) });
        }
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    }
    const handle = root.querySelector('.jzc-1688-brand');
    const ball = root.querySelector('.jzc-1688-ball');
    if (handle) handle.addEventListener('mousedown', startDrag);
    if (ball) {
      ball.addEventListener('mousedown', startDrag);
      // 点小球展开（拖动不算点击）
      ball.addEventListener('click', () => { if (!root.__dragMoved) collapsePanel(false); });
    }
  }

  function showToast(text, kind = 'info') {
    const id = 'jzc-1688-toast';
    const old = document.getElementById(id);
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = id;
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed',
      right: '24px',
      bottom: window.innerWidth <= 720 ? '304px' : '360px',
      zIndex: '2147483647',
      padding: '10px 14px',
      borderRadius: '8px',
      background: kind === 'error' ? '#DC2626' : kind === 'ok' ? '#16A34A' : '#1F2937',
      color: '#fff',
      fontSize: '13px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      maxWidth: '300px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/`/g, '&#96;');
  }

  function setActionBusy(action, busy, busyText) {
    const btn = document.querySelector(`#jzc-1688-panel [data-action="${action}"]`);
    if (!btn) return;
    const label = btn.querySelector('.jzc-1688-action-label');
    btn.disabled = busy;
    if (label) label.textContent = busy ? busyText : (btn.dataset.label || label.textContent);
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: 'no response' });
        });
      } catch (e) {
        resolve({ ok: false, error: e?.message || String(e) });
      }
    });
  }

  async function onPanelClick(e) {
    const btn = e.target?.closest?.('[data-action]');
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    if (action === 'collapse') return collapsePanel(true);
    if (action === 'copy-image') await handleCopyImage();
    if (action === 'collect-product') await handleCollectProduct();
    if (action === 'manual-listing') await handleManualListing();
    if (action === 'ai-wizard') handleAiWizard();
  }

  /**
   * 打开 AI 采集向导（乌拉式 4 步：采集 → 选数据 → AI 智能体输出 → 直上）。
   * 向导本体在 content/1688-ai-wizard.js（同 matches 注入，共享 window 作用域）。
   * 这里只负责：用已写好的 buildPayload() 抓当前 1688 页 → 把 raw 交给向导。
   */
  function handleAiWizard() {
    let raw;
    try {
      raw = buildPayload();
    } catch (e) {
      // buildPayload 对 __INIT_DATA__/DOM 做无守卫深抓,异常页面结构会抛 —— 与
      // handleCollectProduct/handleManualListing 一致地兜住,别让点击静默失败。
      log('buildPayload failed in handleAiWizard', e);
      showToast('抓取商品信息失败,请等页面加载完再试', 'error');
      return;
    }
    if (!raw || !raw.title) {
      showToast('未抓到商品信息，请等页面加载完再试', 'error');
      return;
    }
    if (typeof window.__JZC_OPEN_AI_WIZARD__ === 'function') {
      window.__JZC_OPEN_AI_WIZARD__(raw);
    } else {
      showToast('AI 采集向导未加载（请重新加载扩展）', 'error');
    }
  }

  async function collectCurrentProduct({ forceResubmit = false, resetDraft = false } = {}) {
    const raw = buildPayload();
    if (!raw) throw new Error('未能识别 offerId — 当前不是 1688 详情页？');
    if (!raw.title) throw new Error('未能抓到商品标题，可能页面还没加载完，稍后重试');

    log('payload:', raw);
    const resp = await sendRuntimeMessage({
      action: 'pushSourceCollect',
      sourceId: '1688',
      raw,
      forceResubmit,
      resetDraft,
    });
    log('resp:', resp);
    if (!resp?.ok) throw new Error(resp?.error || '未知错误');

    const data = resp.data || {};
    const result = data.result || {};
    return { dedupeHit: !!data.dedupeHit, result };
  }

  async function handleCollectProduct() {
    setActionBusy('collect-product', true, '采集中...');
    try {
      // SW envelope (c55083b ENVELOPE_FIX):data = { dedupeHit, lastAt, result }
      // backend CollectResult (action/id) 在 result 里;dedupeHit 路径 result 为 null。
      const { dedupeHit, result: r } = await collectCurrentProduct();
      if (dedupeHit) {
        showToast('24h 内已采集过,跳过重复入库', 'ok');
      } else {
        showToast(`已${r.action === 'updated' ? '更新' : '加入'}采集箱（id=${(r.id || '').slice(0, 8)}…）`, 'ok');
      }
    } catch (e) {
      log('error:', e);
      showToast('采集失败：' + (e?.message || String(e)), 'error');
    } finally {
      setActionBusy('collect-product', false);
    }
  }

  async function handleManualListing() {
    setActionBusy('manual-listing', true, '准备上架...');
    try {
      const { result } = await collectCurrentProduct({ forceResubmit: true, resetDraft: true });
      const itemId = result?.id;
      await openCollectEditor(itemId);
      showToast(itemId ? '已采集，正在打开编辑上架页' : '已采集，正在打开采集箱', 'ok');
    } catch (e) {
      log('manual listing error:', e);
      showToast('手动上架失败：' + (e?.message || String(e)), 'error');
    } finally {
      setActionBusy('manual-listing', false);
    }
  }

  async function openCollectEditor(itemId) {
    const path = itemId
      ? `/ozon/products/collect/edit?id=${encodeURIComponent(itemId)}`
      : '/ozon/products/collect';
    const openResp = await sendRuntimeMessage({ action: 'openFrontend', path });
    if (openResp?.ok) return;

    const frontendUrl = 'http://127.0.0.1:3000';
    window.open(`${frontendUrl}${path}`, '_blank');
  }

  async function handleCopyImage() {
    setActionBusy('copy-image', true, '复制中...');
    try {
      const images = extractImages();
      const first = images[0];
      if (!first) throw new Error('当前页面还没有识别到商品图片');
      let copiedLink = false;
      try {
        await copyTextToClipboard(first);
        copiedLink = true;
      } catch {}
      const copiedImage = await copyImageToClipboard(first);
      if (copiedImage) {
        showToast('已复制商品主图', 'ok');
      } else if (copiedLink) {
        showToast('浏览器不允许直接复制图片，已复制图片链接', 'ok');
      } else {
        throw new Error('浏览器拒绝写入剪贴板');
      }
    } catch (e) {
      log('copy image error:', e);
      showToast('复制图片失败：' + (e?.message || String(e)), 'error');
    } finally {
      setActionBusy('copy-image', false);
    }
  }

  async function copyImageToClipboard(url) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
    try {
      const resp = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!resp.ok) return false;
      let blob = await resp.blob();
      if (!blob.type || blob.type === 'image/jpeg' || blob.type === 'image/webp') {
        blob = await convertImageBlobToPng(blob).catch(() => blob);
      }
      const type = blob.type || 'image/png';
      await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      return true;
    } catch {
      return false;
    }
  }

  async function convertImageBlobToPng(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return await new Promise((resolve, reject) => {
      canvas.toBlob((png) => {
        if (png) resolve(png);
        else reject(new Error('png convert failed'));
      }, 'image/png');
    });
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    if (!ok) throw new Error('浏览器拒绝写入剪贴板');
  }

  // ───────────────────────────────────────────────────────────── bootstrap ──

  // 灰度门控：拿到后端 flag 且 ai_collect_wizard_1688===true 才显示「AI 采集」入口。
  // 拿不到（未登录/老后端/未开放）则保持隐藏 —— 符合灰度语义（默认不曝光）。
  async function applyFeatureFlags() {
    try {
      const resp = await sendRuntimeMessage({ action: 'getFeatureFlags' });
      const on = !!(resp && resp.ok && resp.data && resp.data['ai_collect_wizard_1688'] === true);
      const btn = document.getElementById('jzc-1688-ai-btn');
      if (btn) btn.style.display = on ? '' : 'none';
    } catch (e) {
      log('feature flag check failed', e);
    }
  }

  function init() {
    if (!extractOfferId()) {
      log('not a detail page, skipping');
      return;
    }
    createPanel();
    applyFeatureFlags();
    log('ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
