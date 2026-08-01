(function() {
  'use strict';

  // 预热 composer-api page json 缓存(Ozon 2026 SSR DOM 剥离修复):
  // 加载时立刻发起一次 fetch,典型 200-800ms 完成。用户点任何采集按钮时
  // (通常 >1s 后),sync extractStateData 已能 hit cache 拿 widgetStates。
  // 失败静默(非 /product/ 页 / 网络挂),不影响主功能。
  if (window.ensurePdpState) {
    window.ensurePdpState().catch(() => {});
  }

  function _escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Copy text to clipboard with a graceful fallback. `navigator.clipboard`
   * silently fails on http://, when document is not focused, or when the user
   * has denied permission — fallback to a hidden textarea + execCommand keeps
   * the copy button working in those cases. Resolves true/false so callers
   * can distinguish.
   */
  async function _safeCopy(text) {
    if (window.jzSafeCopyText) {
      return window.jzSafeCopyText(text);
    }
    if (text == null) return false;
    const value = String(text);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (e) {
      // fallthrough
    }
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
  }

  function _svgIcon(paths) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"'
      + ' fill="none" stroke="currentColor" stroke-width="2"'
      + ' stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  }

  const _ICONS = {
    collect:    _svgIcon('<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>'),
    profit:     _svgIcon('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
    source:     _svgIcon('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    favorite:   _svgIcon('<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>'),
    dataPanel:  _svgIcon('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
    followSell: _svgIcon('<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>'),
    batchUpload: _svgIcon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
    keyword:    _svgIcon('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
    variantSearch: _svgIcon('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'),
    erp:        _svgIcon('<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
    imageSearch: _svgIcon('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
  };

  // 页面类型判定:
  //   - 商品详情页(/product/) → 完整 action bar(采集/跟卖/批量上架/算价/...);
  //   - 非详情页里"含商品卡的列表页"(搜索/类目/卖家/品牌) → 精简浮窗
  //     (只有 一键跟卖 / 极掌算价 / 进入ERP,其中一键跟卖只列当前页商品卡 SKU);
  //   - 其余页面(首页/购物车/结算/...)不注入任何浮窗。
  const _JZ_IS_PRODUCT_PAGE = window.location.pathname.includes('/product/');
  const _JZ_IS_LISTING_PAGE =
    !_JZ_IS_PRODUCT_PAGE &&
    /\/(category|search|search-by-image|seller|brand|highlight)\b/.test(
      window.location.pathname,
    );
  if (!_JZ_IS_PRODUCT_PAGE && !_JZ_IS_LISTING_PAGE) {
    return;
  }

  const collectCoordinator = _JZ_IS_PRODUCT_PAGE
    ? window.JzOzonCollectCoordinator.getPageCoordinator({
        sendMessage: (action, payload) => window.sendMessage(action, payload),
        now: () => Date.now(),
        timeoutMs: 20_000,
      })
    : null;

  function collectVariantItems(response) {
    const items = response?.items || response?.data?.items;
    return Array.isArray(items) ? items : [];
  }

  function matchingProductVariant(response, sku) {
    const normalizedSku = String(sku || '').trim();
    if (!normalizedSku) return null;
    return collectVariantItems(response).find((item) =>
      window.JzOzonCollectCoordinator.matchesSku(item, normalizedSku)) || null;
  }

  function invalidProductVariantError(cause) {
    return Object.assign(new Error('Ozon 商品变体数据无效'), {
      code: 'OZON_ENRICH_CONTRACT_MISMATCH',
      status: 422,
      retryable: true,
      ...(cause ? { cause } : {}),
    });
  }

  // 与 ozon-data-panel.js 的采集状态文案保持一致。coordinator 负责稳定错误码，
  // 商品页只做用户可见的简短呈现，不再自己判断是否可以上传。
  function productCollectFailurePresentation(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '');
    if (/COLLECTOR_AUTH_REQUIRED|WEB_AUTH_REQUIRED/.test(code + message)) {
      return '请先登录 Web';
    }
    if (/COLLECT_CAPTURE_INCOMPLETE/.test(code + message)) {
      const rawMissing = Array.isArray(error?.missing)
        ? error.missing.join('、')
        : message.split(':').slice(1).join(':');
      const compactMissing = rawMissing
        .replaceAll('长度', '长')
        .replaceAll('宽度', '宽')
        .replaceAll('高度', '高');
      return `缺少：${compactMissing || '必要商品数据'}`;
    }
    if (/OZON_ENRICH_INCOMPLETE|OZON_ENRICH_CONTRACT_MISMATCH/.test(code)
      || message.startsWith('缺少：')) {
      return message || '商品资料不完整，未写入采集箱';
    }
    if (/OZON_ENRICH_BUSY/.test(code)) return '商品资料正在排队，请稍后重试';
    if (/OZON_ENRICH_NOT_FOUND/.test(code)) return '未找到该商品的完整资料';
    if (/OZON_ENRICH_UPSTREAM_FAILED/.test(code)) return 'Ozon 商品资料暂时无法读取';
    if (/NETWORK_ERROR|超时|timeout|网络/i.test(code + message)) return '网络错误';
    return '采集失败';
  }

  // ── 跟卖面板 RUB→CNY 汇率缓存 ──────────────────────────────────
  // Ozon 页面所有价格(extractProductData.price / extractAspectVariants 的 d.price)
  // 都是 RUB ₽,但跟卖面板的"原售价 / 实际售价 / 划线价"输入框语义是 CNY ¥
  // (与极掌算价器、Ozon import-by-sku 的 currency_code=CNY 跨境店模式对齐)。
  //
  // 不做转换会导致:¥734 实际是 734 ₽(≈64 CNY),defaultOldPrice = v.price*2 = 1468
  // 也是 RUB×2,提交给后端会以巨大的 CNY 金额上架,翻车。
  //
  // 汇率存储:chrome.storage.local.jz_calc_fx_rate_v1 = { rate, ts, source }
  //   rate = RUB per 1 CNY(~11.5)。 SW 每日刷新,首次安装时由 jzc:refreshFx 触发。
  // 兜底:11.5(与 line 4473 CNY_RATES.RUB 一致),拉不到时不阻塞 UI。
  const _JZ_FX_FALLBACK_CNY_TO_RUB = 11.5;
  let _jzFxCnyToRub = _JZ_FX_FALLBACK_CNY_TO_RUB;
  try {
    chrome.storage.local.get(['jz_calc_fx_rate_v1'], (data) => {
      const cached = data?.['jz_calc_fx_rate_v1'];
      if (cached?.rate && cached.rate > 0) _jzFxCnyToRub = cached.rate;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes['jz_calc_fx_rate_v1']) return;
      const next = changes['jz_calc_fx_rate_v1'].newValue;
      if (next?.rate && next.rate > 0) _jzFxCnyToRub = next.rate;
    });
  } catch {}
  // RUB → CNY,保留 2 位小数。0 / 负数 / NaN 全部返回 0。
  function _rubToCny(rub) {
    const n = Number(rub);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round((n / _jzFxCnyToRub) * 100) / 100;
  }

  // 从 Ozon 价格字符串解析币种 —— 这是最权威的信号,因为 Ozon 把币种符号
  // 直接拼在 d.price 字符串里:
  //   "734 ₽"   → RUB  (俄罗斯本土商品)
  //   "13,55 ¥" → CNY  (跨境商家,Ozon 已折算 CNY 显示给买家)
  //   "8500 ₸"  → KZT  (ozon.kz)
  //
  // **实测线索(2026-05-20 用 Chrome 在 ozon.ru 跨 3 商品 + 多会话 fingerprint
  // 验证):同一 ozon.ru 同会话可能同时存在 RUB / CNY 商品 —— hostname / JSON-LD
  // 都不能一刀切。直接从 d.price 字符串解析符号最可靠。**
  //
  // normalizePrice 会把符号吃掉,所以**必须**在 normalize 之前调这个函数。
  function _detectCurrencyFromPriceStr(s) {
    if (s == null) return null;
    const shared = window.jzDetectOzonMoneyCurrency?.(s);
    if (shared) return shared;
    const str = String(s);
    if (str.includes('₽') || /\bRUB\b/i.test(str)) return 'RUB';
    if (str.includes('¥') || /\bCNY\b/i.test(str)) return 'CNY';
    if (str.includes('₸') || /\bKZT\b/i.test(str)) return 'KZT';
    if (str.includes('Br') || /\bBYN\b/i.test(str)) return 'BYN';
    if (str.includes('$') || /\bUSD\b/i.test(str)) return 'USD';
    if (str.includes('€') || /\bEUR\b/i.test(str)) return 'EUR';
    return null;
  }

  // 跟卖面板每个 currency 对应的展示符号 —— 跟 line 4471 CURRENCY_SYMBOLS 对齐
  function _isRubFallbackCurrency(currency) {
    const code = String(currency || '').trim().toUpperCase();
    return !code || code === 'RUB' || code === 'RUR';
  }

  const _JZ_CURRENCY_SYMBOLS = {
    RUB: '₽', CNY: '¥', KZT: '₸', BYN: 'Br', USD: '$', EUR: '€',
  };

  // 检测页面整体币种 —— 给单变体 fallback 路径用。
  // 扫所有 [data-state] 找第一个含 price 字符串的,从字符串解析币种。
  // (按页 cache 一次。 normalize 之前 d.price 是字符串带符号,之后是 number)
  let _jzPageCurrencyCached = undefined;
  function _detectPageCurrency() {
    if (_jzPageCurrencyCached !== undefined) return _jzPageCurrencyCached;
    try {
      const stateEls = document.querySelectorAll('[data-state]');
      for (const el of stateEls) {
        const raw = el.getAttribute('data-state');
        if (!raw || raw.length < 10) continue;
        let p;
        try { p = JSON.parse(raw); } catch { continue; }
        if (!p || typeof p !== 'object') continue;
        const cur = _detectCurrencyFromPriceStr(p.price || p.cardPrice || p.originalPrice);
        if (cur) {
          _jzPageCurrencyCached = cur;
          return cur;
        }
      }
    } catch {}
    // JSON-LD 兜底
    try {
      const ld = extractJsonLd();
      let cur = ld?.offers?.priceCurrency;
      if (!cur && Array.isArray(ld?.offers)) cur = ld.offers[0]?.priceCurrency;
      if (cur) {
        _jzPageCurrencyCached = String(cur).toUpperCase();
        return _jzPageCurrencyCached;
      }
    } catch {}
    _jzPageCurrencyCached = null; // unknown
    return null;
  }

  function extractJsonLd() {
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        const data = JSON.parse(script.textContent);
        if (data['@type'] === 'Product') return data;
        if (Array.isArray(data['@graph'])) {
          const product = data['@graph'].find(item => item['@type'] === 'Product');
          if (product) return product;
        }
      }
    } catch {}
    return null;
  }

  function extractOgMeta(property) {
    return document.querySelector(`meta[property="${property}"]`)?.content || '';
  }

  function normalizeBrandName(raw) {
    if (!raw) return '';
    if (typeof raw === 'string') return raw.trim();
    if (typeof raw !== 'object') return String(raw).trim();
    const candidates = [
      raw.title,
      raw.name,
      raw.brand?.title,
      raw.brand?.name,
      raw.text,
    ];
    for (const item of candidates) {
      const text = item == null ? '' : String(item).trim();
      if (text) return text;
    }
    return '';
  }

  function extractProductData() {
    // Try old name-based extraction first, then new key-based extraction
    const webPrice = window.extractStateData('state-webPrice');
    const webGallery = window.extractStateData('state-webGallery');
    const webCurrentSeller = window.extractStateData('state-webCurrentSeller');
    const webAddToCart = window.extractStateData('state-webAddToCart');
    const webBrand = window.extractStateData('state-webBrand');
    const paginator = window.extractStateData('state-paginator');
    const detailInfo = paginator?.detail_info || {};

    // New key-based extraction for updated Ozon DOM structure
    const priceData = window.findStateDataByKeys(['price', 'isAvailable'])
      || window.findStateDataByKeys(['cardPrice']);
    const galleryData = window.findStateDataByKeys(['images', 'coverImage'])
      || window.findStateDataByKeys(['coverImage', 'sku']);
    console.log(`[extractProductData] webGallery=${!!webGallery}, galleryData=${!!galleryData}, galleryData.images=${galleryData?.images?.length ?? 'N/A'}, galleryData.videos=${galleryData?.videos?.length ?? 'N/A'}`);
    if (galleryData?.images?.length > 0) {
      const first = galleryData.images[0];
      console.log(`[extractProductData] First image type=${typeof first}, keys=${typeof first === 'object' ? Object.keys(first).join(',') : 'N/A'}`);
    }
    const sellerWidget = window.findStateDataByKeys(['sellerCell']);
    const productWidget = window.findStateDataByKeys(['name', 'sku', 'coverImageUrl']);
    const ratingData = window.findStateDataByKeys(['totalScore', 'reviewsCount']);

    const jsonLd = extractJsonLd();

    // Title: state → new key-based → jsonLd.name → og:title → h1
    const titleElement = document.querySelector('h1');
    // h1 兜底是从 DOM 文本抓 → 翻译态下是中文版本（污染上架 name）。
    // 翻译开了就跳过 h1 兜底；前 4 个来源（state-paginator / webState / json-ld /
    // og:title）都是 attribute / script 内 JSON，不被浏览器翻译影响。
    const _h1Text = window.jzIsTranslated?.()
      ? ''
      : (titleElement?.textContent?.trim() || '');
    const _rawTitle =
      detailInfo.name ||
      productWidget?.name ||
      jsonLd?.name ||
      extractOgMeta('og:title') ||
      _h1Text ||
      '';
    // 剥掉混进名字的 Ozon 角标(Новинка / 0% до N дней 分期等),否则上架被审核
    // 打回「属性包含广告表达或营销促销名称」。剥光后为空则保留原串(无更好兜底)。
    const title = window.jzStripPromo
      ? (window.jzStripPromo(_rawTitle) || _rawTitle)
      : _rawTitle;

    // Ozon 价格语义（与字段名直觉相反，参考 jzc-calc.js 已 work 的提取逻辑）：
    //   p.price       = 黑标基础价（"С другими банками"，460 ₽）
    //   p.cardPrice   = 绿标优惠价（"С банками"，Ozon Bank 折后 418 ₽）
    //   p.originalPrice = 划线原价（1 800 ₽）
    // 提取策略：遍历所有 [data-state] JSON 找 price/cardPrice 字段。
    // 比 extractStateData('state-webPrice') 稳：避免被 'state-webPricePerStars'
    // 之类同名前缀的 promo widget 误匹配（它们没 price/cardPrice 字段）。
    let pagePriceTags = null;
    try {
      pagePriceTags = window.jzExtractOzonCalcPriceTags?.(document) || window.jzExtractOzonPriceTags?.(document) || null;
    } catch {}
    let price = pagePriceTags?.blackPrice ?? null;
    let walletPrice = pagePriceTags?.greenPrice ?? null;
    let priceCurrency = pagePriceTags?.blackPriceCurrency || null;
    let walletPriceCurrency = pagePriceTags?.greenPriceCurrency || null;
    try {
      const stateEls = document.querySelectorAll('[data-state]');
      for (const el of stateEls) {
        const raw = el.getAttribute('data-state');
        if (!raw || raw.length < 10) continue;
        let p;
        try { p = JSON.parse(raw); } catch { continue; }
        if (!p || typeof p !== 'object') continue;
        if (p.price && price == null) {
          const n = window.normalizePrice(p.price);
          if (n && n > 0) {
            price = n;
            priceCurrency = priceCurrency || window.jzDetectOzonMoneyCurrency?.(p.price) || _detectCurrencyFromPriceStr(p.price);
          }
        }
        if (p.cardPrice && walletPrice == null) {
          const n = window.normalizePrice(p.cardPrice);
          if (n && n > 0) {
            walletPrice = n;
            walletPriceCurrency = walletPriceCurrency || window.jzDetectOzonMoneyCurrency?.(p.cardPrice) || _detectCurrencyFromPriceStr(p.cardPrice);
          }
        }
      }
    } catch {}
    // 商品没参与 Ozon Bank 折扣时 webPrice JSON 里只有 cardPrice 没有 price，
    // 此时 cardPrice 本身就是黑标价（无折扣）。
    if (!price && walletPrice) price = walletPrice;

    // Fallbacks：jsonLd → DOM
    if (!price && jsonLd?.offers) {
      const offers = Array.isArray(jsonLd.offers) ? jsonLd.offers[0] : jsonLd.offers;
      price = window.normalizePrice(offers?.price || offers?.lowPrice);
    }
    if (!price) {
      const domPriceEl = document.querySelector('[data-widget="webPrice"]');
      if (domPriceEl) {
        price = window.normalizePrice(domPriceEl.textContent);
        priceCurrency = priceCurrency || window.jzDetectOzonMoneyCurrency?.(domPriceEl.textContent);
      }
    }
    if (!priceCurrency) priceCurrency = _detectPageCurrency() || undefined;
    if (!walletPriceCurrency) walletPriceCurrency = priceCurrency || undefined;

    let originalPrice = window.normalizePrice(
      webPrice?.originalPrice ||
        webPrice?.oldPrice ||
        webPrice?.previousPrice ||
        priceData?.originalPrice ||
        priceData?.price ||
        detailInfo.old_price
    );
    if (!originalPrice) {
      originalPrice = window.normalizePrice(
        webPrice?.crossedPrice ||
        webPrice?.strikethroughPrice ||
        webPrice?.basePrice
      ) || 0;
    }

    // walletPrice (绿底优惠价) 已在上面 stateEls 循环里提取过

    // Images: multiple extraction strategies with debug logging
    let images = Array.isArray(webGallery?.images)
      ? webGallery.images
          .map((img) => (typeof img === 'string' ? img : img?.url || img?.src || img?.image))
          .filter((url) => typeof url === 'string' && url.length > 0)
      : [];
    if (images.length > 0) console.log(`[extractProductData] Images from webGallery: ${images.length}`);
    if (images.length === 0 && galleryData?.images && Array.isArray(galleryData.images)) {
      images = galleryData.images
        .map((img) => (typeof img === 'string' ? img : img?.src || img?.url || img?.image))
        .filter((url) => typeof url === 'string' && url.length > 0);
      if (images.length > 0) console.log(`[extractProductData] Images from galleryData: ${images.length}`);
    }
    if (images.length === 0 && (galleryData?.coverImage || productWidget?.coverImageUrl)) {
      const cover = galleryData?.coverImage || productWidget?.coverImageUrl;
      if (cover) { images = [cover]; console.log(`[extractProductData] Images from coverImage: 1`); }
    }
    if (images.length === 0 && jsonLd?.image) {
      const ldImages = Array.isArray(jsonLd.image) ? jsonLd.image : [jsonLd.image];
      images = ldImages.filter((url) => typeof url === 'string' && url.length > 0);
      if (images.length > 0) console.log(`[extractProductData] Images from JSON-LD: ${images.length}`);
    }
    if (images.length === 0) {
      const ogImage = extractOgMeta('og:image');
      if (ogImage) { images = [ogImage]; console.log(`[extractProductData] Images from og:image: 1`); }
    }
    // DOM fallback: gallery widget images
    if (images.length === 0) {
      const galleryImgs = document.querySelectorAll('[data-widget="webGallery"] img[src]');
      images = Array.from(galleryImgs)
        .map((img) => img.src)
        .filter((url) => url && !url.startsWith('data:'));
      if (images.length > 0) console.log(`[extractProductData] Images from gallery DOM: ${images.length}`);
    }
    // DOM fallback: any Ozon CDN images on page
    if (images.length === 0) {
      const ozonImgs = document.querySelectorAll('img[src*="ir.ozone.ru/s3/multimedia"]');
      images = Array.from(ozonImgs)
        .map((img) => img.src)
        .filter((url) => url && !url.startsWith('data:'));
      if (images.length > 0) console.log(`[extractProductData] Images from CDN DOM: ${images.length}`);
    }
    // DOM fallback: picture elements with srcset (lazy-loaded galleries)
    if (images.length === 0) {
      const srcsetImgs = document.querySelectorAll('picture source[srcset*="ir.ozone.ru"]');
      const srcsetUrls = [];
      srcsetImgs.forEach(src => {
        const srcset = src.getAttribute('srcset') || '';
        const match = srcset.match(/(https?:\/\/ir\.ozone\.ru[^\s,]+)/);
        if (match) srcsetUrls.push(match[1]);
      });
      if (srcsetUrls.length > 0) {
        images = [...new Set(srcsetUrls)];
        console.log(`[extractProductData] Images from srcset: ${images.length}`);
      }
    }
    // DOM fallback: scan ALL data-state attrs for image URLs (comprehensive)
    if (images.length === 0) {
      const stateEls = document.querySelectorAll('[data-state]');
      const allUrls = new Set();
      stateEls.forEach(el => {
        const state = el.getAttribute('data-state') || '';
        const matches = state.match(/https?:\/\/ir\.ozone\.ru\/s3\/multimedia-[^"'\s]+/g);
        if (matches) matches.forEach(u => allUrls.add(u));
      });
      if (allUrls.size > 0) {
        images = [...allUrls];
        console.log(`[extractProductData] Images from data-state scan: ${images.length}`);
      }
    }
    if (images.length === 0) {
      console.warn(`[extractProductData] No images found by any strategy! webGallery=${!!webGallery}, galleryData=${!!galleryData}, jsonLd.image=${!!jsonLd?.image}`);
    }

    // Upgrade Ozon CDN thumbnails to large images (Ozon requires >= 200x200)
    images = images.map(url => {
      if (typeof url === 'string' && url.includes('ir.ozone.ru')) {
        // Replace /wc50/, /wc140/, /wc250/ etc. with /wc1000/ for high-res
        return url.replace(/\/wc\d+\//, '/wc1000/');
      }
      return url;
    });

    const urlMatch = window.location.pathname.match(/\/product\/.*-(\d+)/);
    // SKU 兜底链:URL 正则 → webAddToCart.id → productWidget.sku → jsonLd.sku
    // 前两个已存,后两个 2026-05 加(Ozon SSR DOM 进一步剥离时 webAddToCart 也可能空)
    const sku = urlMatch?.[1]
      || String(webAddToCart?.id || '')
      || String(productWidget?.sku || '')
      || String(jsonLd?.sku || '');
    const productId = sku || String(webAddToCart?.id || '') || String(productWidget?.sku || '');

    // Ozon 2026 webCurrentSeller widget shape:
    //   { header: { title: { text: "Магазин" } }, // 只是 label,不是 seller name
    //     sellerCell: {
    //       centerBlock: { title: { text: "SANFALIYE" } },           // ← seller name
    //       common: { action: { link: "https://...ozon.ru/seller/sanfaliye/" } }, // ← link
    //     } }
    // 老 shape 还可能直接是 { name, link } 顶层(早期 SSR) — 仍然兜底。
    const sc = webCurrentSeller?.sellerCell;
    let seller = null;
    if (sc) {
      // 每个 fallback 都强制 typeof string,防 Ozon 后续 shape 升级把 title 改成
      // `{ textRich: [...] }` 之类对象时 `String(obj)` 退化成 "[object Object]"
      // 让 seller name 数据腐败 (Codex round 13 P2 #8)。
      const strOr = (v) => (typeof v === 'string' && v ? v : '');
      const name =
        strOr(sc.centerBlock?.title?.text) ||
        strOr(sc.centerBlock?.title) ||
        strOr(sc.name) ||
        '';
      const link =
        strOr(sc.common?.action?.link) ||
        strOr(sc.centerBlock?.title?.link) ||
        strOr(sc.link) ||
        '';
      if (name || link) {
        seller = { name, link };
      }
    }
    if (!seller && webCurrentSeller) {
      // 旧 shape 顶层 name/link 兜底
      seller = {
        name: webCurrentSeller.name || '',
        link: webCurrentSeller.link || '',
      };
    }
    if (!seller?.name && sellerWidget?.sellerCell) {
      // 历史 sellerWidget 路径(别处可能定义),兼容
      const sellerName = sellerWidget.sellerCell?.centerBlock?.title?.text
        || sellerWidget.sellerCell?.name || '';
      const sellerLink = sellerWidget.sellerCell?.common?.action?.link
        || sellerWidget.sellerCell?.centerBlock?.title?.link
        || sellerWidget.sellerCell?.link || '';
      if (sellerName) {
        seller = { name: sellerName, link: sellerLink };
      }
    }
    if (!seller?.name) {
      const sellerEl = document.querySelector(
        '[data-widget="webCurrentSeller"] a, [data-widget="sellerInfo"] a'
      );
      if (sellerEl) {
        seller = { name: sellerEl.textContent?.trim() || '', link: sellerEl.href || '' };
      }
    }

    const statistics = {
      sold_count: detailInfo.sold_count ?? null,
      sold_sum: detailInfo.sold_sum ?? null,
      gmv_sum: detailInfo.gmv_sum ?? null,
      avg_price: detailInfo.avg_price ?? null,
      views: detailInfo.views ?? null,
      session_count: detailInfo.session_count ?? null,
      conv_to_cart_pdp: detailInfo.conv_to_cart_pdp ?? null,
      conv_view_to_order: detailInfo.conv_view_to_order ?? null,
      discount: detailInfo.discount ?? null,
      create_date: detailInfo.create_date ?? '',
      lunch_date: detailInfo.lunch_date ?? '',
    };

    // Videos: extract from gallery data (same data-state element as images)
    let videos = [];
    const videoSource = galleryData || webGallery;
    if (Array.isArray(videoSource?.videos) && videoSource.videos.length > 0) {
      videos = videoSource.videos
        .map(v => {
          if (typeof v === 'string') return v;
          return v?.url || v?.src || null;
        })
        .filter(url => typeof url === 'string' && url.length > 0);
      if (videos.length > 0) console.log(`[extractProductData] Videos: ${videos.length}`);
    }

    // === Enhanced data extraction for sidebar data card ===

    // Brand: webBrand first, JSON-LD fallback.
    const brand = normalizeBrandName(webBrand) || normalizeBrandName(jsonLd?.brand);

    // Category — from breadcrumb DOM links (deduplicated)
    // Filter out brand links (last breadcrumb is often the brand, not a category)
    const categoryLinks = document.querySelectorAll('a[href*="/category/"]');
    const categoryArr = Array.from(categoryLinks)
      .map(a => a.textContent.trim())
      .filter(t => t.length > 0 && t.length < 80);
    const uniqueCategories = categoryArr.filter((c, i) => categoryArr.indexOf(c) === i);
    // Remove brand name from categories (last item may be brand)
    const brandName = brand;
    const filteredCategories = brandName
      ? uniqueCategories.filter(c => c.toLowerCase() !== brandName.toLowerCase())
      : uniqueCategories;
    // Show L1/L3 format (first and last category)
    const category = filteredCategories.length >= 2
      ? `${filteredCategories[0]}/${filteredCategories[filteredCategories.length - 1]}`
      : filteredCategories[0] || '';

    // Rating + review count — from JSON-LD aggregateRating
    const rating = jsonLd?.aggregateRating?.ratingValue || null;
    const reviewCount = jsonLd?.aggregateRating?.reviewCount || null;

    // Characteristics (dimensions/weight) — from data-state with characteristics key
    const charsData = window.findStateDataByKeys(['characteristics', 'titleRs']);
    const characteristics = {};
    if (charsData?.characteristics) {
      charsData.characteristics.forEach(c => {
        const charTitle = c.title?.textRs?.[0]?.content || '';
        const charValue = c.values?.[0]?.text || '';
        if (/длина|length/i.test(charTitle)) characteristics.lengthCm = charValue;
        if (/ширина|width/i.test(charTitle)) characteristics.widthCm = charValue;
        if (/высота|height/i.test(charTitle)) characteristics.heightCm = charValue;
        if (/вес|weight|масса/i.test(charTitle)) characteristics.weightG = charValue;
      });
    }

    // Stock — from addToCart data-state
    const cartData = window.findStateDataByKeys(['isInCart', 'toCart']);
    const freeRest = cartData?.firstButton?.freeRest ?? cartData?.freeRest ?? null;

    // Other sellers (follow-sell info) — from data-state with modalLink
    const otherSellersData = window.findStateDataByKeys(['modalLink', 'count']);
    // ?? 而非 ||:count=0(确认无跟卖)是有效值,吞成 null 会让 hero 显示 '-'
    // 且「商品当前无跟卖者」tip 分支永远走不到。
    const followSellCount = otherSellersData?.count ?? null;
    const followSellMinPrice = (() => {
      const texts = otherSellersData?.textRs || [];
      const pricePart = texts.find(t => t.content && /[\d,.]/.test(t.content));
      return pricePart ? window.normalizePrice(pricePart.content) : null;
    })();

    // Delivery mode — detect FBO/FBS/rFBS from page text
    const deliveryMode = (() => {
      const stateEls = document.querySelectorAll('[data-state]');
      let allText = '';
      stateEls.forEach(el => {
        const attr = el.getAttribute('data-state') || '';
        if (attr.length > 100 && attr.length < 20000) allText += attr;
      });
      if (/\bFBO\b/.test(allText)) return 'FBO';
      if (/\brFBS\b/i.test(allText)) return 'rFBS';
      if (/\bFBS\b/.test(allText)) return 'FBS';
      return null;
    })();

    return {
      title,
      price,
      walletPrice,
      blackPrice: price,
      greenPrice: walletPrice,
      marketingPrice: price,
      priceCurrency,
      blackPriceCurrency: priceCurrency,
      greenPriceCurrency: walletPriceCurrency,
      marketingPriceCurrency: priceCurrency,
      originalPrice,
      images,
      videos,
      sku,
      seller,
      statistics,
      productId,
      url: window.location.href,
      brand,
      category,
      rating,
      reviewCount,
      characteristics,
      freeRest,
      followSellCount,
      followSellMinPrice,
      deliveryMode,
    };
  }

  function buildMarketingPricePayload(product) {
    const marketingPrice = product?.marketingPrice ?? product?.blackPrice;
    const greenPrice = product?.greenPrice ?? product?.walletPrice;
    const marketingPriceCurrency =
      product?.marketingPriceCurrency ||
      product?.blackPriceCurrency ||
      product?.priceCurrency ||
      _detectPageCurrency() ||
      undefined;
    const greenPriceCurrency =
      product?.greenPriceCurrency ||
      product?.walletPriceCurrency ||
      marketingPriceCurrency ||
      undefined;
    const out = {};
    if (marketingPrice != null && marketingPrice !== '') {
      out.marketingPrice = String(marketingPrice);
      out.marketingPriceCurrency = marketingPriceCurrency;
      out.blackPrice = String(marketingPrice);
      out.blackPriceCurrency = marketingPriceCurrency;
    }
    if (greenPrice != null && greenPrice !== '') {
      out.greenPrice = String(greenPrice);
      out.greenPriceCurrency = greenPriceCurrency;
    }
    return out;
  }

  function getCurrentKeywordText() {
    try {
      const text = new URLSearchParams(window.location.search).get('text') || '';
      if (text) return text;
    } catch {}
    try {
      const ref = new URL(document.referrer || '');
      if (/\.?ozon\.ru$/i.test(ref.hostname)) {
        const text = ref.searchParams.get('text') || '';
        if (text) return text;
      }
    } catch {}
    return '';
  }

  function buildPdpBucketRecord(product, fallback = {}) {
    const sku = product?.sku || product?.productId;
    if (!sku) return null;
    const marketingPayload = buildMarketingPricePayload(product);
    const raw = { ...marketingPayload };
    if (marketingPayload.marketingPrice != null) raw._marketingPriceSource = 'pdp';
    if (marketingPayload.greenPrice != null) raw._greenPriceSource = 'pdp';
    const keyword = getCurrentKeywordText();
    if (keyword) raw.keyword = keyword;
    const hashtags = Array.isArray(fallback.hashtags)
      ? fallback.hashtags.filter(Boolean)
      : (Array.isArray(product?.hashtags) ? product.hashtags.filter(Boolean) : []);
    if (hashtags.length) {
      raw.hashtags = hashtags;
      raw._aiHashtags = hashtags;
    }
    return {
      sku: String(sku),
      url: product?.url || fallback.url || window.location.href,
      name: product?.title || fallback.name || '',
      price: product?.price != null ? String(product.price) : (fallback.price || null),
      priceCurrency: product?.priceCurrency || _detectPageCurrency() || fallback.priceCurrency || null,
      ...marketingPayload,
      image: product?.images?.[0] || fallback.image || getMainImageUrl(product) || '',
      keyword,
      hashtags: hashtags.length ? hashtags : undefined,
      collectedAt: Date.now(),
      raw: Object.keys(raw).length ? raw : null,
    };
  }

  function mergeMarketingPriceIntoVariantData(variantData, product) {
    if (!variantData || typeof variantData !== 'object') return variantData;
    const fields = buildMarketingPricePayload(product);
    if (fields.marketingPrice != null && variantData.marketing_price == null) {
      variantData.marketing_price = fields.marketingPrice;
    }
    if (fields.marketingPriceCurrency && variantData.marketing_price_currency == null) {
      variantData.marketing_price_currency = fields.marketingPriceCurrency;
    }
    if (fields.greenPrice != null && variantData.green_price == null) {
      variantData.green_price = fields.greenPrice;
    }
    if (fields.greenPriceCurrency && variantData.green_price_currency == null) {
      variantData.green_price_currency = fields.greenPriceCurrency;
    }
    return variantData;
  }

  /**
   * Extract the raw `aspects` array from page's webAspects widget — the same source
   * extractAspectVariants() uses, but returns the structure intact so callers can
   * iterate per-aspect (e.g. expandAllAxes needs to know which aspect is smaller
   * to pick as pivot).
   *
   * Returns: [{ aspectName, variants: [{sku, data, link, availability, active}, ...] }, ...]
   * Returns [] if no aspects found (single-SKU product / SSR strip / 异常页).
   */
  function extractRawAspects() {
    const allStateElements = document.querySelectorAll('[data-state]');
    for (const el of allStateElements) {
      try {
        const raw = el.getAttribute('data-state');
        if (!raw || raw.length < 20) continue;
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.aspects) && data.aspects.length > 0) return data.aspects;
      } catch {}
    }
    const widget = document.querySelector('[data-widget="webAspects"], [data-widget="aspects"]');
    if (widget) {
      try {
        const data = JSON.parse(widget.getAttribute('data-state') || '');
        if (Array.isArray(data?.aspects)) return data.aspects;
      } catch {}
    }
    const ws = window.extractStateData('state-webAspects');
    if (Array.isArray(ws?.aspects) && ws.aspects.length > 0) return ws.aspects;
    return [];
  }

  /**
   * Extract all product variants from the page's aspects widget (data-state).
   * Returns unique variants: { sku, title, price, coverImage, link, availability, active, aspectValues }
   * Returns [] if no aspects found.
   */
  function extractAspectVariants() {
    const currentProduct = extractProductData();
    const currentSku = String(currentProduct.sku || '');

    let aspectsData = null;
    const allStateElements = document.querySelectorAll('[data-state]');
    for (const el of allStateElements) {
      try {
        const raw = el.getAttribute('data-state');
        if (!raw || raw.length < 20) continue;
        const data = JSON.parse(raw);
        if (data && typeof data === 'object' && Array.isArray(data.aspects) && data.aspects.length > 0) {
          aspectsData = data.aspects;
          break;
        }
      } catch {}
    }

    // Fallback: data-widget="webAspects"
    if (!aspectsData) {
      const widget = document.querySelector('[data-widget="webAspects"], [data-widget="aspects"]');
      if (widget) {
        try {
          const data = JSON.parse(widget.getAttribute('data-state') || '');
          if (Array.isArray(data?.aspects)) aspectsData = data.aspects;
        } catch {}
      }
    }

    // Fallback 2: extractStateData 已经接了 ensurePdpState 的 composer-api 缓存,
    // Ozon 2026 SSR DOM 剥离场景下命中这里。两条独立的尝试 — webAspects 主键
    // 或者 page json 里的 webAspects-*-default-1 state。
    if (!aspectsData) {
      const ws = window.extractStateData('state-webAspects');
      if (Array.isArray(ws?.aspects) && ws.aspects.length > 0) {
        aspectsData = ws.aspects;
      }
    }

    if (!aspectsData || aspectsData.length === 0) return [];

    // Collect unique variants across all aspect groups
    const variantMap = new Map();
    for (const aspect of aspectsData) {
      const aspectName = aspect.aspectName || '';
      const variants = aspect.variants || [];
      for (const v of variants) {
        const sku = String(v.sku || '');
        if (!sku) continue;
        if (!variantMap.has(sku)) {
          const d = v.data || {};
          // d.price 是 Ozon 页面原始字符串,如 "734 ₽" / "13,55 ¥" / "8500 ₸"。
          // 必须**先**识别币种(从字符串符号),**再** normalize(剥去符号转 number)。
          const rawPriceStr = d.price;
          const srcCurrency = _detectCurrencyFromPriceStr(rawPriceStr);
          const rawPriceNum = window.normalizePrice(rawPriceStr) || 0;
          // 只有 RUB 才换 CNY;CNY 商品已经是目标币种;其他币种(KZT/BYN/...)
          // 没有 FX rate 不强转,保持原值显示 + 在符号上诚实标注。
          const isRub = _isRubFallbackCurrency(srcCurrency);
          variantMap.set(sku, {
            sku,
            title: d.title || '',
            price: isRub ? _rubToCny(rawPriceNum) : rawPriceNum,
            priceCurrency: isRub ? 'CNY' : srcCurrency,
            priceRub: isRub ? rawPriceNum : 0,
            coverImage: (d.coverImage || '').replace(/\/wc\d+\//, '/wc1000/'),
            link: v.link || '',
            availability: v.availability || 'unknown',
            active: v.active === true,
            aspectValues: {},
          });
        }
        const existing = variantMap.get(sku);
        const text = v.data?.searchableText || v.data?.textRs?.map(t => t.content).join('') || '';
        if (aspectName && text) existing.aspectValues[aspectName] = text;
      }
    }

    // Anchor validation: result must contain the current page's SKU
    if (currentSku && !variantMap.has(currentSku)) {
      // None of the aspects reference the current SKU — likely not the main variant widget
      return [];
    }

    return Array.from(variantMap.values());
  }

  /**
   * 拉「Все N цветов」弹窗的全部变体。单轴多值商品(如 38 色)内联 webAspects 只带
   * 可见 ~6 个,其余在弹窗里懒加载 —— aspect 自带 `aspectModalInfo.link`
   * (/modal/aspectsNew?…&from_sku=…),指向 composer/entrypoint page json,里面是
   * 全量 aspects.variants。走 content script 同源 fetch(图册/富内容同款通道,生产可用;
   * entrypoint 优先、composer 兜底)。失败返 [],绝不阻断采集。
   */
  async function jzFetchAspectsModalVariants(modalLink) {
    if (!modalLink || typeof modalLink !== 'string') return [];
    let path = modalLink;
    try {
      if (/^https?:\/\//i.test(path)) {
        const u = new URL(path);
        path = u.pathname + u.search;
      }
    } catch {}
    if (!path.startsWith('/')) path = '/' + path;
    const endpoints = [
      `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
      `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
    ];
    for (const url of endpoints) {
      try {
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { 'x-o3-app-name': 'dweb_client', accept: 'application/json' },
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const states = data?.widgetStates || {};
        const seen = new Set();
        const rows = [];
        for (const k of Object.keys(states)) {
          let v = states[k];
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch { continue; } }
          if (!v || !Array.isArray(v.aspects)) continue;
          for (const aspect of v.aspects) {
            const aspectName = aspect.aspectName || '';
            for (const av of aspect.variants || []) {
              const sku = String(av.sku || '');
              if (!sku || seen.has(sku)) continue;
              seen.add(sku);
              const d = av.data || {};
              const srcCurrency = _detectCurrencyFromPriceStr(d.price);
              const rawPriceNum = window.normalizePrice(d.price) || 0;
              const isRub = _isRubFallbackCurrency(srcCurrency);
              const text =
                d.searchableText || d.textRs?.map((t) => t.content).join('') || '';
              rows.push({
                sku,
                title: d.title || '',
                price: isRub ? _rubToCny(rawPriceNum) : rawPriceNum,
                priceCurrency: isRub ? 'CNY' : srcCurrency,
                priceRub: isRub ? rawPriceNum : 0,
                coverImage: (d.coverImage || '').replace(/\/wc\d+\//, '/wc1000/'),
                link: av.link || '',
                availability: av.availability || 'unknown',
                active: av.active === true,
                aspectValues: aspectName && text ? { [aspectName]: text } : {},
              });
            }
          }
        }
        if (rows.length > 0) return rows;
      } catch (e) {
        console.warn('[ozon-helper] aspectsModal fetch failed', url, e?.message);
      }
    }
    return [];
  }

  /**
   * 若某 aspect 的 `aspectModalInfo.realNumberOfVariants` 大于已采到的变体数,
   * 说明还有变体在弹窗里没拿全 → 拉弹窗补全并按 sku 并集(已有内联变体优先,
   * 弹窗只填新 sku)。覆盖单轴多值场景(Phase A 的 ≥2 轴门挡不住的情况)。
   */
  async function jzExpandVariantsViaModal(variants, rawAspects, setBtn) {
    try {
      let best = null;
      for (const a of rawAspects || []) {
        const mi = a?.aspectModalInfo;
        const link = mi?.link;
        const total = parseInt(mi?.realNumberOfVariants, 10);
        if (link && Number.isFinite(total) && total > variants.length) {
          if (!best || total > best.total) best = { link, total };
        }
      }
      if (!best) return variants;
      if (setBtn) setBtn(`展开全部 ${best.total} 个变体…`);
      const modalRows = await jzFetchAspectsModalVariants(best.link);
      if (modalRows.length === 0) {
        console.warn(
          `[ozon-helper] aspect modal 拉取为空,保留内联 ${variants.length} 个变体(目标 ${best.total})`,
        );
        return variants;
      }
      const map = new Map(variants.map((v) => [String(v.sku), v]));
      for (const r of modalRows) if (!map.has(r.sku)) map.set(r.sku, r);
      const merged = Array.from(map.values());
      console.log(
        `[ozon-helper] aspect modal 展开:内联 ${variants.length} → ${merged.length}(弹窗 ${modalRows.length},目标 ${best.total})`,
      );
      return merged;
    } catch (e) {
      console.warn('[ozon-helper] jzExpandVariantsViaModal err', e?.message);
      return variants;
    }
  }

  function extractBreadcrumbs() {
    // 优先 1：从 webState script JSON 抓（attribute / script 内 JSON 不被浏览器翻译污染）
    try {
      const bcState =
        window.findStateDataByKeys?.(['breadcrumbs']) ||
        window.findStateDataByKeys?.(['breadCrumbs']);
      const arr = bcState?.breadcrumbs || bcState?.breadCrumbs;
      if (Array.isArray(arr) && arr.length) {
        const items = arr
          .map((b) => (b?.text || b?.title || b?.name || '').trim())
          .filter((t) => t && t !== 'Ozon' && t !== 'Главная');
        if (items.length > 0) return items;
      }
    } catch {}

    // 翻译态下：DOM 文本是被中文化的版本，回传给后端 findCategoryByBreadcrumbs
    // 用中文匹配俄文类目树会 100% 失败 → 直接返空数组让后端走 sourceVariant 路径
    if (window.jzIsTranslated?.()) return [];

    const breadcrumbWidget = document.querySelector('[data-widget="breadCrumbs"], [data-widget="webBreadcrumbs"]');
    if (breadcrumbWidget) {
      const links = breadcrumbWidget.querySelectorAll('a');
      const crumbs = Array.from(links)
        .map(el => el.textContent?.trim())
        .filter(t => t && t !== 'Ozon' && t !== 'Главная');
      if (crumbs.length > 0) return crumbs;
    }
    const nav = document.querySelector('nav[aria-label]');
    if (nav) {
      const items = nav.querySelectorAll('li a, li span');
      return Array.from(items)
        .map(el => el.textContent?.trim())
        .filter(t => t && t !== 'Ozon' && t !== 'Главная');
    }
    return [];
  }

  // Extract category IDs embedded in breadcrumb link URLs
  // e.g. /category/kostyumy-sportivnye-93221/ → 93221
  function extractBreadcrumbCategoryIds() {
    const ids = [];
    const breadcrumbWidget = document.querySelector('[data-widget="breadCrumbs"], [data-widget="webBreadcrumbs"]');
    if (!breadcrumbWidget) return ids;
    const links = breadcrumbWidget.querySelectorAll('a[href*="/category/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/category\/.*?-(\d+)\/?/);
      if (match) ids.push(Number(match[1]));
    }
    console.log('[FollowSell] Breadcrumb category IDs from URLs:', ids);
    return ids;
  }

  function extractCharacteristics() {
    const characteristics = [];

    // Strategy A: Search data-state for objects with characteristic-related keys
    const charState = window.findStateDataByKeys?.(['characteristics'])
      || window.findStateDataByKeys?.(['shortCharacteristics'])
      || window.findStateDataByKeys?.(['specs']);

    if (charState) {
      const items = charState.characteristics || charState.shortCharacteristics || charState.specs;
      if (Array.isArray(items)) {
        for (const group of items) {
          const entries = group.short || group.items || group.characteristics || [];
          for (const entry of (Array.isArray(entries) ? entries : [])) {
            const name = entry.key || entry.name || entry.title || '';
            const val = entry.values
              ? (Array.isArray(entry.values) ? entry.values.map(v => v.text || v.value || v).join(', ') : String(entry.values))
              : (entry.value || entry.text || '');
            if (name && val) characteristics.push({ name: name.trim(), value: val.trim() });
          }
        }
      }
      console.log(`[JiZhang] Strategy A (state keys): found ${characteristics.length}`);
    } else {
      console.log('[JiZhang] Strategy A (state keys): no charState found');
    }

    // Strategy B: Parse data-state attribute of the characteristics widget element
    if (characteristics.length === 0) {
      const charWidget = document.querySelector(
        '[data-widget="webCharacteristics"], [data-widget="webShortCharacteristics"]'
      );
      if (charWidget) {
        const stateAttr = charWidget.getAttribute('data-state');
        if (stateAttr) {
          try {
            const data = JSON.parse(stateAttr);
            // Walk the parsed JSON looking for arrays of key-value pairs
            const walk = (obj) => {
              if (!obj || typeof obj !== 'object') return;
              if (Array.isArray(obj)) {
                for (const item of obj) walk(item);
                return;
              }
              if (obj.key && obj.value) {
                characteristics.push({ name: String(obj.key).trim(), value: String(obj.value).trim() });
                return;
              } else if (obj.name && obj.value) {
                characteristics.push({ name: String(obj.name).trim(), value: String(obj.value).trim() });
                return;
              }
              for (const v of Object.values(obj)) {
                if (v && typeof v === 'object') walk(v);
              }
            };
            walk(data);
          } catch (e) {
            console.log('[JiZhang] Strategy B: JSON parse error', e);
          }
        }
        console.log(`[JiZhang] Strategy B (widget data-state): found ${characteristics.length}`);
      } else {
        console.log('[JiZhang] Strategy B: no webCharacteristics widget found');
      }
    }

    // Strategy C: DOM text extraction from characteristics widget
    if (characteristics.length === 0) {
      const charWidget = document.querySelector(
        '[data-widget="webCharacteristics"], [data-widget="webShortCharacteristics"]'
      );
      if (charWidget) {
        // Try dl/dt/dd pairs
        const dts = charWidget.querySelectorAll('dt');
        const dds = charWidget.querySelectorAll('dd');
        if (dts.length > 0 && dts.length === dds.length) {
          for (let i = 0; i < dts.length; i++) {
            const name = dts[i].textContent?.trim();
            const val = dds[i].textContent?.trim();
            if (name && val) characteristics.push({ name, value: val });
          }
        }
        // Try span pairs with colon separator
        if (characteristics.length === 0) {
          const spans = charWidget.querySelectorAll('span');
          for (const span of spans) {
            const text = span.textContent?.trim();
            if (text && text.includes(':')) {
              const [name, ...rest] = text.split(':');
              const val = rest.join(':').trim();
              if (name && val) characteristics.push({ name: name.trim(), value: val });
            }
          }
        }
        console.log(`[JiZhang] Strategy C (widget DOM): found ${characteristics.length}`);
      } else {
        console.log('[JiZhang] Strategy C: no webCharacteristics widget found');
      }
    }

    // Strategy D: JSON-LD additionalProperty
    if (characteristics.length === 0) {
      try {
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of scripts) {
          const data = JSON.parse(script.textContent);
          if (data?.additionalProperty) {
            for (const prop of data.additionalProperty) {
              if (prop.name && prop.value) {
                characteristics.push({ name: prop.name, value: String(prop.value) });
              }
            }
          }
        }
      } catch {}
      console.log(`[JiZhang] Strategy D (JSON-LD): found ${characteristics.length}`);
    }

    // Strategy E: Broad scan — search ALL data-state elements for characteristic-like structures
    if (characteristics.length === 0) {
      const allWidgets = document.querySelectorAll('[data-widget]');
      const charWidgetNames = [];
      for (const w of allWidgets) {
        const name = w.getAttribute('data-widget');
        if (name && (name.toLowerCase().includes('character') || name.toLowerCase().includes('detail')
          || name.toLowerCase().includes('description') || name.toLowerCase().includes('spec')
          || name.toLowerCase().includes('param') || name.toLowerCase().includes('propert'))) {
          charWidgetNames.push(name);
          const stateAttr = w.getAttribute('data-state');
          if (stateAttr) {
            try {
              const data = JSON.parse(stateAttr);
              const walk = (obj) => {
                if (!obj || typeof obj !== 'object') return;
                if (Array.isArray(obj)) {
                  for (const item of obj) walk(item);
                  return;
                }
                if (obj.key && obj.value && typeof obj.key === 'string' && typeof obj.value === 'string') {
                  characteristics.push({ name: String(obj.key).trim(), value: String(obj.value).trim() });
                  return;
                } else if (obj.name && obj.value && typeof obj.name === 'string') {
                  characteristics.push({ name: String(obj.name).trim(), value: String(obj.value).trim() });
                  return;
                }
                for (const v of Object.values(obj)) {
                  if (v && typeof v === 'object') walk(v);
                }
              };
              walk(data);
            } catch {}
          }
        }
      }
      console.log(`[JiZhang] Strategy E (broad widget scan): widgets=[${charWidgetNames.join(',')}], found ${characteristics.length}`);
    }

    // Strategy F: Scan ALL data-state elements for arrays with key/value objects (last resort)
    if (characteristics.length === 0) {
      const stateEls = document.querySelectorAll('[data-state]');
      for (const el of stateEls) {
        try {
          const raw = el.getAttribute('data-state');
          if (!raw || raw.length < 50) continue;
          const data = JSON.parse(raw);
          // Look for objects with "characteristics" or similar nested arrays
          const findCharArrays = (obj, depth) => {
            if (!obj || typeof obj !== 'object' || depth > 5) return;
            if (Array.isArray(obj)) {
              // Check if this array contains objects with key-value or name-value pairs
              const kvCount = obj.filter(item =>
                item && typeof item === 'object' && !Array.isArray(item) &&
                ((item.key && item.value) || (item.name && item.value))
              ).length;
              if (kvCount >= 3 && kvCount === obj.length) {
                for (const item of obj) {
                  const n = item.key || item.name;
                  const v = typeof item.value === 'string' ? item.value
                    : (item.values ? (Array.isArray(item.values) ? item.values.map(x => x.text || x.value || x).join(', ') : String(item.values))
                    : String(item.value));
                  if (n && v) characteristics.push({ name: String(n).trim(), value: v.trim() });
                }
                return;
              }
              for (const item of obj) findCharArrays(item, depth + 1);
              return;
            }
            for (const v of Object.values(obj)) {
              if (v && typeof v === 'object') findCharArrays(v, depth + 1);
            }
          };
          findCharArrays(data, 0);
          if (characteristics.length > 0) break;
        } catch {}
      }
      console.log(`[JiZhang] Strategy F (deep scan all data-state): found ${characteristics.length}`);
    }

    // Strategy G: DOM-based extraction from any section with "Характеристик" heading
    if (characteristics.length === 0) {
      // Find headings that say "Характеристики" (Characteristics in Russian)
      const headings = document.querySelectorAll('h1, h2, h3, h4, div[class*="heading"], div[class*="title"]');
      for (const h of headings) {
        const text = h.textContent?.trim() || '';
        if (text.includes('Характеристик') || text.includes('характеристик') || text.includes('О товаре')) {
          // Look at the next sibling or parent container for dl/dt/dd or table rows
          const container = h.closest('div[data-widget]') || h.parentElement?.parentElement;
          if (container) {
            // Try dl/dt/dd
            const dts = container.querySelectorAll('dt');
            const dds = container.querySelectorAll('dd');
            if (dts.length > 0 && dts.length === dds.length) {
              for (let i = 0; i < dts.length; i++) {
                const name = dts[i].textContent?.trim();
                const val = dds[i].textContent?.trim();
                if (name && val) characteristics.push({ name, value: val });
              }
            }
            // Try table rows
            if (characteristics.length === 0) {
              const rows = container.querySelectorAll('tr');
              for (const row of rows) {
                const cells = row.querySelectorAll('td, th');
                if (cells.length >= 2) {
                  const name = cells[0].textContent?.trim();
                  const val = cells[1].textContent?.trim();
                  if (name && val) characteristics.push({ name, value: val });
                }
              }
            }
            // Try div pairs (common Ozon pattern: two adjacent divs per row)
            if (characteristics.length === 0) {
              const allDivs = container.querySelectorAll('div');
              const pairs = [];
              for (const div of allDivs) {
                // Look for leaf divs that only contain text (no child divs)
                if (div.children.length === 0 && div.textContent?.trim()) {
                  pairs.push(div.textContent.trim());
                }
              }
              // Try to pair them: even=name, odd=value
              if (pairs.length >= 4 && pairs.length % 2 === 0) {
                for (let i = 0; i < pairs.length; i += 2) {
                  if (pairs[i] && pairs[i + 1]) {
                    characteristics.push({ name: pairs[i], value: pairs[i + 1] });
                  }
                }
              }
            }
          }
        }
        if (characteristics.length > 0) break;
      }
      console.log(`[JiZhang] Strategy G (heading-based DOM): found ${characteristics.length}`);
    }

    console.log('[JiZhang] Extracted characteristics:', characteristics);
    return characteristics;
  }

  // Parse weight + dimensions out of an `extractCharacteristics()` result.
  // Returns { weight, depth, width, height } in grams / millimeters (integers, > 0),
  // or all undefined when nothing matches. Used as a last-resort scraping fallback
  // for cross-platform follow-sell SKUs whose seller-portal source-variant attrs
  // don't include 4383/4497/9454-9456 — characteristics ARE displayed on the
  // public product page for many categories, so DOM scrape recovers them.
  function parseScrapedDimensionsFromCharacteristics(characteristics) {
    if (!Array.isArray(characteristics) || characteristics.length === 0) return {};
    // 标签经常带单位/限定后缀:"Вес, г" / "Вес товара, кг" / "Длина, см" / "Размеры (мм)"
    // 匹配前剥掉",..."、"(..)"、"[..]"、"-..."、":..."尾部,只保留品名;
    // 同时把单位提取出来当作 hint(优先于 value 字符串里的单位)。
    // 防御性:如果分隔符后面紧跟"数字+单位"或纯数字(像 "Размер: 5L" / "Size: 20 cm"),
    // 说明这是 DOM 兜底 paired-divs 没拆好的"label: value"结构 — 不要砍掉,跳过整条。
    const normalizeLabel = (raw) => {
      let s = String(raw || '').trim().toLowerCase();
      // 抽出标签里出现的单位(只看尾部修饰段防止误吞品名)
      const unitInLabel = (() => {
        const m = s.match(/[,\(\[\-–:]\s*(кг|kg|г|g|см|cm|мм|mm|м\b|m\b)\s*[\)\]]?\s*$/iu);
        return m ? m[1].toLowerCase() : '';
      })();
      // 检测分隔符后是否像 value 而非 label suffix:
      //   "Size: 20 cm" → 跳过整条(label 实际是混进 value 的脏数据)
      //   "Размер: 5L" → 跳过整条
      // 排除已识别为单位 hint 的尾部("Вес, г" 这种依然砍尾)
      if (!unitInLabel) {
        const looksLikeValueAfterSep = /[,\(\[\-–:]\s*-?\d+(?:[.,]\d+)?(?:\s*[a-zA-Zа-яёА-ЯЁ]+)?/u.test(s);
        if (looksLikeValueAfterSep) {
          return { label: '', unitInLabel: '' };
        }
      }
      // 砍掉尾部 ", ...","( ... )","[ ... ]","- ..." / ": ..."
      s = s.replace(/\s*[,\(\[\-–:].*$/u, '').trim();
      return { label: s, unitInLabel };
    };
    // 字段名识别:全词匹配 normalized label,长 pattern 优先(避免"вес"先吃掉"вес товара с упаковкой")。
    const patterns = {
      weight: /^(вес\s*товара\s*с\s*упаковкой|вес\s*с\s*упаковкой|вес\s*товара|вес\s*брутто|вес\s*нетто|масса\s*брутто|масса\s*нетто|вес|масса|gross\s*weight|net\s*weight|weight)$/i,
      depth: /^(глубина\s*упаковки|глубина|длина\s*упаковки|длина\s*товара|длина|depth|length)$/i,
      width: /^(ширина\s*упаковки|ширина|width)$/i,
      height: /^(высота\s*упаковки|высота|height)$/i,
      sizeAll: /^(размеры\s*упаковки|размер\s*упаковки|размеры|размер|габариты|dimensions|size)$/i,
    };
    // Convert "value + unit" strings to base units (g / mm). unitHint 来自 label 兜底。
    // 关键设计:**无单位且无 unitHint 时拒绝解析**,而不是用"<100 = kg" 启发式 ——
    // codex review 指出 99 g 会被误判为 99 kg(放大 1000 倍),太危险,直接放弃比错更好。
    const toGrams = (raw, unitHint) => {
      const m = String(raw || '').replace(',', '.').match(/(-?\d+(?:\.\d+)?)\s*(кг|kg|г|g)?/i);
      if (!m) return null;
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n <= 0) return null;
      const unit = ((m[2] || unitHint || '').toLowerCase());
      if (unit === 'кг' || unit === 'kg') return Math.round(n * 1000);
      if (unit === 'г' || unit === 'g') return Math.round(n);
      // 没单位且无 hint:跳过(prefer 没数据 over 错数据)
      return null;
    };
    const toMm = (raw, unitHint) => {
      const m = String(raw || '').replace(',', '.').match(/(-?\d+(?:\.\d+)?)\s*(см|cm|мм|mm|м\b|m\b)?/i);
      if (!m) return null;
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n <= 0) return null;
      const unit = ((m[2] || unitHint || '').toLowerCase());
      if (unit === 'см' || unit === 'cm') return Math.round(n * 10);
      if (unit === 'м' || unit === 'm') return Math.round(n * 1000);
      if (unit === 'мм' || unit === 'mm') return Math.round(n);
      // 同上,没单位也没 hint:跳过
      return null;
    };
    const out = { weight: undefined, depth: undefined, width: undefined, height: undefined };
    for (const { name, value } of characteristics) {
      const { label, unitInLabel } = normalizeLabel(name);
      const v = String(value || '').trim();
      if (!label || !v) continue;
      if (!out.weight && patterns.weight.test(label)) {
        const g = toGrams(v, unitInLabel);
        if (g) out.weight = g;
        continue;
      }
      if (!out.depth && patterns.depth.test(label)) {
        const mm = toMm(v, unitInLabel);
        if (mm) out.depth = mm;
        continue;
      }
      if (!out.width && patterns.width.test(label)) {
        const mm = toMm(v, unitInLabel);
        if (mm) out.width = mm;
        continue;
      }
      if (!out.height && patterns.height.test(label)) {
        const mm = toMm(v, unitInLabel);
        if (mm) out.height = mm;
        continue;
      }
      // 组合 "10 x 20 x 30 см" / "10×20×30 мм" / "10 х 20 х 30" — 分隔符支持半/全角 x×*хХ + 周围空格 + 中文逗号/分号
      if (patterns.sizeAll.test(label)) {
        const parts = v.replace(',', '.').split(/\s*[x×*хХ;,，;]\s*/u).map(s => s.trim()).filter(Boolean);
        if (parts.length === 3) {
          const unitMatch = v.match(/(см|cm|мм|mm|м\b|m\b)/i);
          const unit = (unitMatch?.[1] || unitInLabel || '').toLowerCase();
          // 无单位且无 unitInLabel:跳过(过去是默认 mm,但 codex 指出无单位实际更常见是 cm,
          // 错 10x 比缺数据风险更大,直接放弃)
          if (!unit) continue;
          const toMmWithUnit = (s) => {
            const num = Number(String(s).match(/-?\d+(?:\.\d+)?/)?.[0]);
            if (!Number.isFinite(num) || num <= 0) return null;
            if (unit === 'см' || unit === 'cm') return Math.round(num * 10);
            if (unit === 'м' || unit === 'm') return Math.round(num * 1000);
            return Math.round(num);
          };
          const [d, w, h] = parts.map(toMmWithUnit);
          if (d && !out.depth) out.depth = d;
          if (w && !out.width) out.width = w;
          if (h && !out.height) out.height = h;
        }
      }
    }
    return out;
  }

  // Surface for tests / debugging — also lets future callers reuse without re-importing.
  window.jzParseScrapedDimensions = parseScrapedDimensionsFromCharacteristics;

  function logProductSummary(product, breadcrumbs, characteristics, description) {
    const sep = '============================================================';
    const price = product.price != null ? `${product.price}` : '-';
    const origPrice = product.originalPrice ? ` (原价: ${product.originalPrice})` : '';
    const discount = product.statistics?.discount != null ? `-${product.statistics.discount}%` : '-';
    const rating = product.statistics?.totalScore || '-';
    const brand = '-';
    const seller = product.seller?.name || '-';
    const sku = product.sku || product.productId || '-';
    const categoryPath = breadcrumbs.length > 0 ? breadcrumbs.join(' > ') : '-';
    const imageCount = (product.images || []).length;
    const charCount = (characteristics || []).length;

    const lines = [
      sep,
      `商品: ${product.title || '-'}`,
      `价格: ${price}${origPrice}`,
      `折扣: ${discount}`,
      `评分: ${rating}`,
      `品牌: ${brand}`,
      `卖家: ${seller}`,
      `SKU: ${sku}`,
      `类目: ${categoryPath}`,
      `图片: ${imageCount} 张`,
      `属性: ${charCount} 项`,
    ];
    if (characteristics && characteristics.length > 0) {
      for (const c of characteristics) {
        lines.push(`  - ${c.name}: ${c.value}`);
      }
    }
    const desc = description || '';
    lines.push(`描述: ${desc.length > 80 ? desc.slice(0, 80) + '...' : (desc || '-')}`);
    lines.push(sep);

    console.log('[JiZhang]\n' + lines.join('\n'));
  }

  function getMainImageUrl(product) {
    if (product.images && product.images.length > 0) {
      return product.images[0];
    }
    const img = document.querySelector('img[src*="ir.ozone.ru/s3/multimedia"]');
    return img?.getAttribute('src') || '';
  }

  // 「一键采集」= 采集当前商品的所有变体 SKU(2026-05-30)。
  // 复用一键跟卖的变体展开思路:Phase A SSR 逐页补全跨轴所有变体 → Phase B
  // JZSkuCollect.collectBySkus 逐变体抓 sv(search+bundle)→ 组装 N 个 raw payload
  // 批量推送到采集箱(走会 prune 的 /sources/ozon/collect/batch)。
  // 静默执行,进度直接显示在按钮上;单/无变体页直接委托 performProductCollect(单采)。
  //
  // 注意:下面的 Phase A SSR 展开块是 toggleFollowSellPanel(§Phase A,约 7397-7480)
  // 的精简镜像(去掉了与 Phase B worker pool 的交错,改为展开完再统一 collectBySkus)。
  // 若 Ozon 改 aspects/SSR 格式,两处需同步更新。
  async function collectAllVariants(btn, options = {}) {
    const forceSingleResubmit = Boolean(options.forceResubmit);
    const setBtn = (text) => {
      if (btn) btn.innerHTML = `<span class="oh-btn-icon">${_lucideSvg('refresh-cw')}</span>${text}`;
    };

    // composer-api 缓存预热(限 3s),让后续 sync 提取走 cache fallback
    if (window.ensurePdpState) {
      try { await Promise.race([window.ensurePdpState(), new Promise((r) => setTimeout(r, 3000))]); } catch {}
    }

    let variants = extractAspectVariants();

    // ── Phase 0:弹窗补全(单轴多值,如 38 色)──
    // 内联 webAspects 只带可见 ~6 个,其余在「Все N цветов」弹窗懒加载;Phase A 的
    // ≥2 轴门挡不住单轴场景,这里先按 aspectModalInfo.link 拉全量并集。
    variants = await jzExpandVariantsViaModal(variants, extractRawAspects(), setBtn);

    // ── Phase A:SSR 逐页展开补全所有变体 SKU(多轴网格)──
    try {
      const rawAspects = extractRawAspects();
      const currentSku = String(extractProductData()?.sku || '');
      const needPhaseA = rawAspects.length >= 2 && variants.length > 1 && currentSku;
      if (needPhaseA) {
        const variantMap = new Map(variants.map((v) => [String(v.sku), v]));
        const sortedAxes = [...rawAspects].sort(
          (a, b) => (a.variants?.length || 0) - (b.variants?.length || 0),
        );
        const linksToFetch = (sortedAxes[0]?.variants || [])
          .filter((v) => v && String(v.sku) !== currentSku && v.link)
          .slice(0, 8)
          .map((v) => ({ sku: String(v.sku), link: v.link }));
        for (let i = 0; i < linksToFetch.length; i++) {
          setBtn(`展开变体 ${i}/${linksToFetch.length}…`);
          if (i > 0) await new Promise((r) => setTimeout(r, 1200));
          try {
            const u = new URL(linksToFetch[i].link, 'https://www.ozon.ru');
            const r = await fetch(u.pathname, { credentials: 'include', headers: { accept: 'text/html' } });
            if (!r.ok) continue;
            const html = await r.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            let fetchedAspects = null;
            for (const el of doc.querySelectorAll('[data-state]')) {
              try {
                const data = JSON.parse(el.getAttribute('data-state') || '');
                if (Array.isArray(data?.aspects) && data.aspects.length > 0) { fetchedAspects = data.aspects; break; }
              } catch {}
            }
            if (!fetchedAspects) continue;
            for (const aspect of fetchedAspects) {
              const aspectName = aspect.aspectName || '';
              for (const v of aspect.variants || []) {
                const sku = String(v.sku || '');
                if (!sku) continue;
                if (!variantMap.has(sku)) {
                  const d = v.data || {};
                  const srcCurrency = _detectCurrencyFromPriceStr(d.price);
                  const rawPriceNum = window.normalizePrice(d.price) || 0;
                  const isRub = _isRubFallbackCurrency(srcCurrency);
                  variantMap.set(sku, {
                    sku,
                    title: d.title || '',
                    price: isRub ? _rubToCny(rawPriceNum) : rawPriceNum,
                    priceCurrency: isRub ? 'CNY' : srcCurrency,
                    priceRub: isRub ? rawPriceNum : 0,
                    coverImage: (d.coverImage || '').replace(/\/wc\d+\//, '/wc1000/'),
                    link: v.link || '',
                    availability: v.availability || 'unknown',
                    active: v.active === true,
                    aspectValues: {},
                  });
                }
                const existing = variantMap.get(sku);
                const text = v.data?.searchableText || v.data?.textRs?.map((t) => t.content).join('') || '';
                if (aspectName && text) existing.aspectValues[aspectName] = text;
              }
            }
          } catch (e) {
            console.warn('[ozon-helper] collectAll phaseA err:', e?.message || e);
          }
        }
        variants = Array.from(variantMap.values());
      }
    } catch (e) {
      console.warn('[ozon-helper] collectAll expand guard:', e?.message || e);
    }

    // ── #160 一次性诊断(用 console.error，生产构建不会 DCE)──
    // 现象:一键采集对多变体商品只建 1 个 SKU。根因疑为变体检测(extractAspectVariants /
    // extractRawAspects / SSR·弹窗展开)在当前 Ozon 页面普遍返回 ≤1,退回单采把整页图塞进 1 SKU。
    // 这里 dump 检测各环节的产出 + 页面 state/widget key,定位 Ozon 把 aspects 挪到了哪。
    // 用户点一次「一键采集」把 Console 里 [JZ#160] 这行贴回即可。定位后删除本块。
    try {
      const stateEls = Array.from(document.querySelectorAll('[data-state]'));
      let withAspects = 0;
      const stateKeys = [];
      for (const el of stateEls) {
        const k = el.getAttribute('data-state-key') || el.getAttribute('data-widget') || '';
        if (k) stateKeys.push(k);
        try {
          const d = JSON.parse(el.getAttribute('data-state') || '');
          if (d && Array.isArray(d.aspects) && d.aspects.length > 0) withAspects++;
        } catch {}
      }
      const rawAspects = (() => { try { return extractRawAspects(); } catch { return []; } })();
      const rawAspectVariantTotal = rawAspects.reduce((n, a) => n + ((a?.variants || []).length), 0);
      const aspectVariants = (() => { try { return extractAspectVariants(); } catch { return []; } })();
      const widgetKeys = Array.from(document.querySelectorAll('[data-widget]'))
        .map((el) => el.getAttribute('data-widget'))
        .filter(Boolean);
      console.error('[JZ#160] 变体检测诊断', JSON.stringify({
        currentSku: String(extractProductData()?.sku || ''),
        dataStateEls: stateEls.length,
        dataStateWithAspects: withAspects,
        rawAspects: rawAspects.length,
        rawAspectVariantTotal,
        aspectVariants: aspectVariants.length,
        variantsAfterExpand: variants.length,
        willFallbackToSingle: variants.length <= 1,
        stateKeys: Array.from(new Set(stateKeys)).slice(0, 50),
        widgetKeys: Array.from(new Set(widgetKeys)).slice(0, 50),
      }));
    } catch (e) {
      console.error('[JZ#160] 诊断块异常:', e?.message || e);
    }

    // 单/无变体 → 走现有单采(sv 优先已在其中),保持原行为
    if (variants.length <= 1) {
      return await performProductCollect({
        forceResubmit: forceSingleResubmit,
        onStatus: setBtn,
      });
    }

    // ── Phase B:逐变体抓 sv(search+bundle)──
    const allSkus = variants.map((v) => String(v.sku)).filter(Boolean);
    let sourceMap = new Map();
    if (window.JZSkuCollect?.collectBySkus) {
      try {
        const res = await window.JZSkuCollect.collectBySkus(allSkus, {
          onProgress: (done, total) => setBtn(`抓取变体 ${done}/${total}…`),
          // PDP 上有更优路径:母体富内容由 jzCollectPageRichContent 从 composer 缓存抽
          // (listing 级,见下方 variantData 注入),不必逐变体走买家 tab 重复拉。
          captureRichContent: false,
        });
        sourceMap = res.sourceMap || new Map();
      } catch (e) {
        console.warn('[ozon-helper] collectAll phaseB err:', e?.message || e);
      }
    }

    // ── 组装成「一条多变体采集记录」(锚定母体/当前页 SKU)──
    // 旧实现把每个变体 push 成独立一行(N 行),用户在采集箱看到一堆同款散行。
    // 现在改为:N 个变体写进母体 variantData.variants,后端按母体 SKU upsert 一行,
    // 编辑页 collect-adapter 据此渲染多变体 → 一个采集商品、多变体编辑。
    //
    // 母体顶层(name/image/统计/卖家/划线价 + variantData 的类目/描述/物理尺寸/完整
    // attributes)取当前页 anchor;每个变体行只存编辑页 VariantRow 用到的轻量字段。
    const anchorProduct = (() => { try { return extractProductData(); } catch { return null; } })();
    const anchorSku = String(anchorProduct?.sku || anchorProduct?.productId || '');

    // 把一个 aspect 变体裁成编辑页变体行 + catalog(sv 优先,DOM/aspect 兜底)。
    const toVariantRow = (v) => {
      const sku = String(v.sku);
      const distilled = sourceMap.get(sku) || null;
      const sv = distilled?._sourceVariant || null;
      const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(sv) : null;
      const name = window.jzPreferSourceName
        ? window.jzPreferSourceName(svCat?.name || distilled?.name, v.title)
        : (v.title || distilled?.name || '');
      const images = svCat?.images?.length
        ? svCat.images
        : (distilled?.images?.length ? distilled.images : (v.coverImage ? [v.coverImage] : []));
      let link = '';
      try { if (v.link) link = new URL(v.link, 'https://www.ozon.ru').href; } catch {}
      return {
        sku,
        sv,
        sourceVariant: sv || undefined,
        name: name || v.title || '',
        image: svCat?.mainImage || v.coverImage || undefined,
        images: images.length ? images : undefined,
        description: distilled?.description || undefined,
        richContent: distilled?.richContent || undefined,
        barcode: distilled?.barcode || undefined,
        weight: distilled?.weight || undefined,
        depth: distilled?.depth || undefined,
        width: distilled?.width || undefined,
        height: distilled?.height || undefined,
        bundleComplexAttrs: distilled?._bundleComplexAttrs || sv?._bundleComplexAttrs || undefined,
        // 价格口径同单采/后端:RUB 源送原卢布 + 'RUB'(后端 ×汇率);
        //   CNY 源(含 Ozon 跨境页默认人民币)送原人民币 + 'CNY'(后端原值保留);其它外币留空不猜。
        price: v.priceRub
          ? String(v.priceRub)
          : (v.priceCurrency === 'CNY' && v.price ? String(v.price) : undefined),
        priceCurrency: v.priceRub
          ? 'RUB'
          : (v.priceCurrency === 'CNY' && v.price ? 'CNY' : undefined),
        // is_aspect 规格维度值(颜色/尺码 → 文本),编辑页可据此预填区分 SKU 的属性。
        aspectValues: v.aspectValues && Object.keys(v.aspectValues).length ? v.aspectValues : undefined,
        link: link || undefined,
      };
    };

    const rows = variants.map(toVariantRow).filter((r) => r.sku);
    // 母体必须精确匹配当前页 SKU，禁止把第一个兄弟变体当作锚点。
    const anchorRow = rows.find((r) => r.sku === anchorSku);
    if (!anchorRow) throw invalidProductVariantError();
    const anchorSv = anchorRow?.sv || null;

    // 每个变体必须保留自己的完整 seller 源快照。除合并变体型号外，类目、属性、
    // 媒体、条码和物理尺寸都可能不同；如果这里只保留轻量行，编辑页和正式上架
    // 只能退回锚点变体数据，最终会把多个 SKU 错误地上传成相同商品。
    const variantRows = rows.map((r) => ({
      sku: r.sku,
      name: r.name || undefined,
      price: r.price,
      priceCurrency: r.priceCurrency,
      ...(r.sku === anchorSku ? buildMarketingPricePayload(anchorProduct) : {}),
      image: r.image,
      images: r.images,
      description: r.description,
      richContent: r.richContent,
      barcode: r.barcode,
      weight: r.weight,
      depth: r.depth,
      width: r.width,
      height: r.height,
      bundleComplexAttrs: r.bundleComplexAttrs,
      sourceVariant: r.sourceVariant,
      aspectValues: r.aspectValues,
      link: r.link,
    }));

    const variantData = Object.assign({}, anchorSv || {}, { variants: variantRows });
    mergeMarketingPriceIntoVariantData(variantData, anchorProduct);
    // 源富内容(11254)listing 级:同视频语义,整组变体共用当前页(母体)的富内容。
    // 从 composer 缓存抽(通常零额外请求)注入母体 variantData.attributes —— 编辑页
    // textarea 自动预填,批量导入经 _sourceVariant 由后端统一下发。
    const collectAllRichContent = await jzCollectPageRichContent();
    jzInjectRichContentAttr(variantData, collectAllRichContent);
    const contentCopy = window.JZFollowSellContentCopy;
    const collectAllDescription = contentCopy?.pickFollowSellDescription
      ? contentCopy.pickFollowSellDescription({
          customDescription: '',
          sourceVariant: variantData,
          richContent: collectAllRichContent,
          fallbackName: '',
          max: 4096,
        })
      : '';
    contentCopy?.mergeSourceDescriptionIntoVariant?.(variantData, collectAllDescription);
    const collectAllHashtags = extractKeywords();
    contentCopy?.mergeSourceHashtagsIntoVariant?.(variantData, collectAllHashtags);
    // 跟卖视频 listing 级:整组变体是同一商品的不同规格,共用当前页(母体)视频。抓一次转存,
    // 存进母体采集记录;编辑页 collect-adapter 会把它预填到每个变体行,上架时整组带同一视频。
    setBtn('转存视频…');
    const collectVideoMedia = await captureAndTransferPageVideoMedia((t) => setBtn(t));
    const collectVideoUrl = collectVideoMedia?.videoUrl || null;
    const collectVideoCover = collectVideoMedia?.videoCover || null;
    const s = anchorProduct?.statistics || {};
    const payload = {
      sku: String(anchorRow.sku),
      url: window.location.href,
      name: anchorRow.name || undefined,
      price: anchorRow.price,
      priceCurrency: anchorRow.priceCurrency,
      originalPrice: anchorProduct?.originalPrice != null ? String(anchorProduct.originalPrice) : undefined,
      ...buildMarketingPricePayload(anchorProduct),
      image: anchorRow.image,
      images: anchorRow.images,
      videoUrl: collectVideoUrl || undefined,
      videoCover: collectVideoCover || undefined,
      variantData,
      sellerName: anchorProduct?.seller?.name || undefined,
      sellerLink: anchorProduct?.seller?.link || undefined,
      soldCount: s.sold_count != null ? s.sold_count : undefined,
      soldSum: s.sold_sum != null ? String(s.sold_sum) : undefined,
      views: s.views != null ? s.views : undefined,
      convViewToOrder: s.conv_view_to_order != null ? String(s.conv_view_to_order) : undefined,
      discount: s.discount != null ? String(s.discount) : undefined,
      gmvSum: s.gmv_sum != null ? String(s.gmv_sum) : undefined,
    };
    const bucketRecord = buildPdpBucketRecord(anchorProduct, {
      name: anchorRow.name,
      price: anchorRow.price,
      priceCurrency: anchorRow.priceCurrency,
      image: anchorRow.image,
      hashtags: collectAllHashtags,
    });

    // 每个变体都先走服务器完整性门禁。prefetchBatch 不上传；任意一行失败
    // 都会阻断母体写入，不保留一个不完整的 anchor 充当成功。
    setBtn('正在补全商品资料');
    const gatedRows = await collectCoordinator.prefetchBatch({
      skus: variantRows.map((row) => row.sku),
      retryFailed: true,
    });
    if (!Array.isArray(gatedRows) || gatedRows.length !== variantRows.length) {
      throw invalidProductVariantError();
    }
    gatedRows.forEach((result, index) => {
      if (result?.status === 'ERROR') throw result.error || invalidProductVariantError();
      if (String(result?.sku || '') !== variantRows[index].sku) {
        throw invalidProductVariantError();
      }
      window.JzOzonEnrichmentContract.assertComplete(result);
      const row = variantRows[index];
      row.weight = result.logistics.weightG;
      row.depth = result.logistics.lengthMm;
      row.width = result.logistics.widthMm;
      row.height = result.logistics.heightMm;
      row.sourceVariant = {
        ...(row.sourceVariant && typeof row.sourceVariant === 'object'
          ? row.sourceVariant
          : {}),
        ...result.variantData,
      };
    });

    // 最终写入决策只属于 Task 7 coordinator。
    const resp = await collectCoordinator.collect({ sku: anchorSku, raw: payload });
    const dedupeHit = !!resp?.dedupeHit;
    const itemId = resp?.result?.id || resp?.result?.data?.id || null;
    return {
      ok: true,
      multiVariant: true,
      total: variantRows.length,
      created: 1,
      updated: 0,
      failed: 0,
      dedupeHit,
      itemId,
      bucketRecord,
    };
  }

  // 抓当前 PDP gallery 的 .mp4 并经 SW 转存成卖家自有 Ozon 视频(ir.ozone.ru/s3),返回自有 URL。
  // 跟卖/采集共用:竞品 PDP 视频是公开直链,Ozon import 不吃直链(主视频/封面槽只认平台链接
  // 或卖家自有视频),必须先经 seller 后台 /api/media-storage/upload-file 转存。转存失败或本页
  // 无视频 → 返回 null,上游优雅降级为不带视频、不阻断采集/上架。
  // onLabel(可选):进度文案回调(如把提交按钮文字改成「转存视频…」)。
  async function captureAndTransferPageVideoMedia(onLabel) {
    try {
      const g = window.extractStateData('state-webGallery');
      const vids = Array.isArray(g?.videos) ? g.videos : [];
      let srcMp4 = null;
      let videoCover = null;
      const extractor = window.JZOzonVideoExtract;
      if (extractor?.extractOzonVideoFromSources) {
        const media = extractor.extractOzonVideoFromSources([
          window.extractStateData('state-webGallery'),
          window.findStateDataByKeys?.(['videos']),
          window.findStateDataByKeys?.(['images', 'coverImage']),
          window.findStateDataByKeys?.(['coverImage', 'sku']),
        ]);
        srcMp4 = media?.mp4 || null;
        videoCover = media?.cover || null;
      } else if (extractor?.extractOzonMp4FromSources) {
        srcMp4 = extractor.extractOzonMp4FromSources([
          window.extractStateData('state-webGallery'),
          window.findStateDataByKeys?.(['videos']),
          window.findStateDataByKeys?.(['images', 'coverImage']),
          window.findStateDataByKeys?.(['coverImage', 'sku']),
        ]);
      }
      if ((!srcMp4 || !videoCover) && extractor?.extractOzonVideoFromDocument) {
        const media = extractor.extractOzonVideoFromDocument(document);
        srcMp4 = srcMp4 || media?.mp4 || null;
        videoCover = videoCover || media?.cover || null;
      } else if (!srcMp4 && extractor?.extractOzonMp4FromDocument) {
        srcMp4 = extractor.extractOzonMp4FromDocument(document);
      }
      if (!srcMp4) {
        for (const v of vids) {
          const raw = typeof v === 'string' ? v : (v?.url || v?.src || '');
          if (raw && typeof raw === 'string' && /\.mp4(\?|#|$)/i.test(raw)) { srcMp4 = raw; break; } // 跳 m3u8
        }
      }
      if (!srcMp4) return null;
      try { if (typeof onLabel === 'function') onLabel('转存视频…'); } catch (_) {}
      // window.sendMessage 成功时 resolve 的是 SW 的 response.data(失败则 throw),故 up = { url }。
      let up = null;
      try {
        up = await window.sendMessage('uploadFollowSellVideo', { srcUrl: srcMp4 });
      } catch (uploadErr) {
        console.warn('[ozon-helper] video upload failed, skipping video:', uploadErr?.message || uploadErr);
        return null;
      }
      if (up && up.url) {
        console.log(`[ozon-helper] 竞品视频已转存为自有 Ozon 视频: ${up.url}`);
        return { videoUrl: up.url, videoCover: videoCover || null };
      }
      console.warn('[ozon-helper] 视频转存未返回 url,跳过视频:', up);
      return null;
    } catch (e) {
      console.warn('[ozon-helper] 视频转存异常,跳过视频:', e?.message || e);
      return null;
    }
  }
  async function captureAndTransferPageVideo(onLabel) {
    const media = await captureAndTransferPageVideoMedia(onLabel);
    return media?.videoUrl || null;
  }
  window.jzCaptureAndTransferPageVideoMedia = captureAndTransferPageVideoMedia;
  window.jzCaptureAndTransferPageVideo = captureAndTransferPageVideo;

  // 抽自原 collectBtn click handler，便于 popup 远程触发同一逻辑
  async function performProductCollect(options = {}) {
    // 采集流程对 SW composer-api 缓存的依赖现在是**软依赖**:DOM + JSON-LD + og:meta
    // 一般能独立拿全(7 层 fallback)。所以策略改:
    //   1. 先 sync 跑 extractProductData
    //   2. 三个必填字段都有 → 跳过 SW 缓存等待,直接 proceed
    //   3. 缺字段 → 才 await ensurePdpState(限 3s),再次提取
    //
    // 旧策略 `await ensurePdpState()` 无脑等(无超时)— 实测 SW
    // fetchProductPageState 偶发 hang 60s(Ozon 2026 反爬 + Chrome MV3
    // scripting.executeScript MAIN world 注入路径 race),阻塞用户感知的"采集中..."。
    // 新策略让健康 PDP 页采集**< 50ms 完成**,Ozon DOM 全剥离的极端情况才付 3s 等待。
    let product = extractProductData();
    let hasTitle = !!(product?.title && product.title.trim());
    let hasImages = Array.isArray(product?.images) && product.images.length > 0;
    let hasSku = !!(product?.sku || product?.productId);

    // DOM 数据不全才等 SW 缓存预热兜底
    if ((!hasTitle || !hasImages || !hasSku) && window.ensurePdpState) {
      try {
        await Promise.race([
          window.ensurePdpState(),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      } catch { /* noop */ }
      product = extractProductData();
      hasTitle = !!(product?.title && product.title.trim());
      hasImages = Array.isArray(product?.images) && product.images.length > 0;
      hasSku = !!(product?.sku || product?.productId);
    }

    // 防御:Ozon DOM 改版 / composer-api 也挂时,product 关键字段全空 → 直接
    // 抛清晰错误,避免下游送给 backend 一个 sku/name 都空的 payload(backend 收
    // 到这种 payload 也会 reject,但报"采集请求失败"对用户没意义)。
    if (!hasTitle || !hasImages || !hasSku) {
      const missingFields = [
        !hasTitle ? '标题' : null,
        !hasImages ? '图片' : null,
        !hasSku ? 'SKU' : null,
      ].filter(Boolean);
      const missing = missingFields.join(' / ');
      // 详细诊断:打出 product 对象关键字段,便于 devtools console 看根因。
      // 用 warn 在 production build.js 里会被 DCE,只有 dev 模式才打。
      console.warn('[ozon-helper] 采集 validation 失败 — product 字段诊断:', {
        missing,
        titleLen: product?.title?.length || 0,
        titlePreview: (product?.title || '').slice(0, 40),
        imagesType: Array.isArray(product?.images) ? `array len=${product.images.length}` : typeof product?.images,
        sku: product?.sku || '(empty)',
        productId: product?.productId || '(empty)',
        url: window.location.href,
      });
      throw Object.assign(
        new Error(`采集数据不完整:${missingFields.join('、')}`),
        {
          code: 'COLLECT_CAPTURE_INCOMPLETE',
          missing: missingFields,
          retryable: true,
        },
      );
    }
    try {
      logProductSummary(product, extractBreadcrumbs(), extractCharacteristics(), '');
    } catch (e) {
      console.warn('[ozon-helper] logProductSummary threw:', e?.message);
      throw e;
    }

    let localVariantError = null;
    const variantPromise = product.sku
      ? window.sendMessage('searchVariants', { sku: product.sku }).catch((error) => {
          localVariantError = error;
          return null;
        })
      : Promise.resolve(null);

    const variantResp = await variantPromise;
    const variantMatch = matchingProductVariant(variantResp, product.sku);

    if (variantMatch) {
      console.log(`[ozon-helper] collectProduct: searchVariants found variant_id=${variantMatch.variant_id}, images=${variantMatch.images?.length || 0}, attrs=${variantMatch.attributes?.length || 0}`);
    }

    // 跟卖式 catalog 抽取:name/images 切成 sv(search+bundle)优先,DOM 兜底。
    // statistics / price / seller 仍走 DOM(seller-portal 接口不返回)。
    const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(variantMatch) : null;
    const collectName = window.jzPreferSourceName
      ? window.jzPreferSourceName(svCat?.name, product.title)
      : (product.title || svCat?.name || '');
    const collectImages = (svCat?.images?.length ? svCat.images : product.images) || [];
    const collectMainImage = svCat?.mainImage || product.images?.[0] || getMainImageUrl(product) || undefined;

    // 跟卖视频:抓当前 PDP 视频转存成卖家自有 Ozon 视频,随采集存进采集箱;上架时自动带视频。
    const collectVideoMedia = await captureAndTransferPageVideoMedia();
    const collectVideoUrl = collectVideoMedia?.videoUrl || null;
    const collectVideoCover = collectVideoMedia?.videoCover || null;

    // 源富内容(11254):composer 缓存抽取注入 variantData(searchVariants 失败也会
    // 新建 {attributes} 兜底),编辑页预填 + 上架经 _sourceVariant 下发。
    const collectRichContent = await jzCollectPageRichContent();
    let collectVariantData = jzInjectRichContentAttr(
      variantMatch,
      collectRichContent,
    );
    const contentCopy = window.JZFollowSellContentCopy;
    const collectDescription = contentCopy?.pickFollowSellDescription
      ? contentCopy.pickFollowSellDescription({
          customDescription: '',
          sourceVariant: collectVariantData || variantMatch,
          richContent: collectRichContent,
          fallbackName: '',
          max: 4096,
        })
      : '';
    collectVariantData = contentCopy?.mergeSourceDescriptionIntoVariant
      ? contentCopy.mergeSourceDescriptionIntoVariant(
          collectVariantData || variantMatch || {},
          collectDescription,
        )
      : collectVariantData;
    mergeMarketingPriceIntoVariantData(collectVariantData, product);
    const collectHashtags = extractKeywords();
    contentCopy?.mergeSourceHashtagsIntoVariant?.(collectVariantData, collectHashtags);
    const collectPayload = {
      sku: product.sku,
      url: product.url,
      name: collectName || product.title,
      price: product.price != null ? String(product.price) : undefined,
      // 页面币种(CNY/RUB)随价上传 — 后端 provider 据此决定是否 ×汇率,
      // 修跨境店人民币价被当卢布砍 ~12 倍的 bug。探测不到则留空(后端默认按 RUB)。
      priceCurrency: _detectPageCurrency() || undefined,
      originalPrice: product.originalPrice != null ? String(product.originalPrice) : undefined,
      ...buildMarketingPricePayload(product),
      image: collectMainImage,
      images: collectImages.length ? collectImages : undefined,
      videoUrl: collectVideoUrl || undefined,
      videoCover: collectVideoCover || undefined,
      variantData: collectVariantData || undefined,
      sellerName: product.seller?.name || undefined,
      sellerLink: product.seller?.link || undefined,
      soldCount: product.statistics?.sold_count != null ? product.statistics.sold_count : undefined,
      soldSum: product.statistics?.sold_sum != null ? String(product.statistics.sold_sum) : undefined,
      views: product.statistics?.views != null ? product.statistics.views : undefined,
      convViewToOrder: product.statistics?.conv_view_to_order != null ? String(product.statistics.conv_view_to_order) : undefined,
      discount: product.statistics?.discount != null ? String(product.statistics.discount) : undefined,
      gmvSum: product.statistics?.gmv_sum != null ? String(product.statistics.gmv_sum) : undefined,
    };
    const collectPromise = collectCoordinator.collect({
      sku: product.sku,
      raw: collectPayload,
      localFallback: () => {
        if (!variantMatch || !collectVariantData) {
          throw invalidProductVariantError(localVariantError);
        }
        return window.JzOzonEnrichmentContract.normalizeVariantData({
          sku: product.sku,
          variantData: collectVariantData,
          source: 'LOCAL_SELLER',
          capturedAt: new Date().toISOString(),
        });
      },
    });
    if (collectCoordinator.getState(product.sku).status === 'PREFETCHING') {
      options.onStatus?.('正在补全商品资料');
    }
    const resp = await collectPromise;
    const bucketRecord = buildPdpBucketRecord(product, {
      name: collectName || product.title,
      image: collectMainImage,
      hashtags: collectHashtags,
    });
    return {
      ok: true,
      dedupeHit: !!resp?.dedupeHit,
      lastAt: null,
      itemId: resp?.result?.id || resp?.result?.data?.id || null,
      bucketRecord,
    };
  }

  function createActionBar() {
    if (document.querySelector('.ozon-helper-action-bar')) {
      return;
    }

    const bar = document.createElement('div');
    bar.className = 'ozon-helper-action-bar';

    // Brand header
    const brand = document.createElement('div');
    brand.className = 'ozon-helper-bar-brand';
    {
      const _b = globalThis.__JZ_BRAND__;
      const iconHtml = _b.logoUrl
        ? `<span class="ozon-helper-bar-brand-icon"><img src="${_b.logoUrl}" alt=""></span>`
        : `<span class="ozon-helper-bar-brand-icon">${_b.displayName[0]}</span>`;
      brand.innerHTML = `${iconHtml}<span class="ozon-helper-bar-brand-name">${_b.displayName}</span>`;
    }
    bar.appendChild(brand);

    const collectBtn = createActionButton(_ICONS.collect, '一键采集', async () => {
      if (collectBtn.disabled) return;
      // 采全部变体是多阶段长操作(SSR 展开 + 逐变体抓 sv + 批量推送),进度由
      // collectAllVariants 直接写按钮文案,所以这里不套 showButtonFeedback 的 loading
      // 态(它会在异步进度更新时把按钮"恢复"成过期文案),改为手动存/还原 innerHTML。
      const original = collectBtn.innerHTML;
      collectBtn.disabled = true;
      collectBtn.innerHTML = `<span class="oh-btn-icon">${_lucideSvg('refresh-cw')}</span>采集中...`;
      try {
        const result = await collectAllVariants(collectBtn);
        collectBtn.disabled = false;
        collectBtn.innerHTML = original;
        if (result?.dedupeHit) {
          // 24h 内已采集过同 SKU,SW 直接走 cache 没发请求
          showButtonFeedback(collectBtn, 'success', '近期已采集', 2500);
        } else {
          showButtonFeedback(collectBtn, 'success', '已采集');
        }
      } catch (err) {
        collectBtn.disabled = false;
        collectBtn.innerHTML = original;
        const msg = err?.message || '采集失败';
        // 把完整错误写 console — UI 上 friendly 文案被截断,这里留 audit trail 让用户/开发
        // 在 devtools console 看完整原因(改版后采集失败,根因往往在 message 里:
        // 缺标题/缺图片/缺 SKU)。
        // 用 console.error 而非 warn,production build.js pure=['console.warn']
        // 会被 DCE 掉 — 改用 error 保证 prod 也能看到。
        console.error('[ozon-helper] 一键采集失败:', msg, err, err?.stack);
        showButtonFeedback(collectBtn, 'error', productCollectFailurePresentation(err), 7000);
      }
    });

    const followSellBtn = createActionButton(_ICONS.followSell, '模拟手动跟卖', () => toggleFollowSellPanel(followSellBtn));

    // maozi 公开页跟卖(灰度 ozon_public_import):从公开商详页采集精简行 → 后端服务端
    // 解析类目/属性 → 官方 import,门户无关、可跟卖任意商品。默认隐藏,flag 开才显示。
    const publicFollowSellBtn = createActionButton(_ICONS.followSell, '公开页跟卖', async () => {
      if (publicFollowSellBtn.disabled) return;
      const product = extractProductData();
      const sku = product?.sku;
      if (!sku) {
        showButtonFeedback(publicFollowSellBtn, 'error', '未获取到 SKU', 2500);
        return;
      }
      publicFollowSellBtn.disabled = true;
      try {
        const res = await window.sendMessage('importFromPublic', { sku });
        if (res?.result?.task_id || res?.task_id) {
          showButtonFeedback(publicFollowSellBtn, 'success', '已提交上架', 2800);
        } else {
          showButtonFeedback(publicFollowSellBtn, 'error', res?.error || '提交失败', 3000);
        }
      } catch (e) {
        console.error('[ozon-helper] 公开页跟卖失败:', e?.message || e, e);
        showButtonFeedback(publicFollowSellBtn, 'error', e?.message || '提交失败', 3000);
      } finally {
        // 不还原 innerHTML —— 本 handler 没设过 loading 文案,且 showButtonFeedback 会
        // 改内部 span 并自行定时还原;这里同步覆盖 innerHTML 会把反馈立刻抹掉(并把它
        // 定时 restore 的 span 换掉)。只解锁 disabled。
        publicFollowSellBtn.disabled = false;
      }
    });
    publicFollowSellBtn.dataset.color = 'purple';
    publicFollowSellBtn.style.display = 'none';
    isPublicImportEnabled().then((on) => {
      if (on) publicFollowSellBtn.style.display = '';
    });

    // maozi v2「公开页挂靠」(灰度 ozon_public_follow):枚举整款所有变体 → 官方
    // import-by-sku 挂靠到已有商品卡(非克隆新卡),门户无关。源禁止复制的变体后端
    // 自动回退克隆。定价默认 maozi ceil/×2(后端派生)。默认隐藏,flag 开才显示。
    const publicFollowBtn = createActionButton(_ICONS.followSell, '公开页挂靠', async () => {
      if (publicFollowBtn.disabled) return;
      publicFollowBtn.disabled = true;
      try {
        // 枚举整款变体(复用现有公开页枚举,门户无关):单轴经 aspectsNew 全量展开。
        let variants = extractAspectVariants();
        try {
          variants = await jzExpandVariantsViaModal(variants, extractRawAspects(), publicFollowBtn);
        } catch (e) {
          console.warn('[ozon-helper] 变体展开失败,回退当前已知变体:', e?.message || e);
        }
        // 组挂靠行:{sku, sell_price, currency_code}。优先原始 RUB(RU 卡=RUB 市场),
        // 无变体(单 SKU 商品)则用当前商品。offer_id/price 由后端默认(mz-<sku> + maozi)。
        let rows;
        if (Array.isArray(variants) && variants.length) {
          rows = variants
            .filter((v) => v && v.sku)
            .map((v) => ({
              sku: String(v.sku),
              sell_price: v.priceRub || v.price || undefined,
              currency_code: v.priceRub ? 'RUB' : v.priceCurrency,
            }));
        } else {
          const p = extractProductData();
          if (!p?.sku) {
            showButtonFeedback(publicFollowBtn, 'error', '未获取到 SKU', 2500);
            return;
          }
          rows = [{ sku: String(p.sku), sell_price: p.price || undefined }];
        }
        if (!rows.length) {
          showButtonFeedback(publicFollowBtn, 'error', '未枚举到变体', 2500);
          return;
        }
        const res = await window.sendMessage('followFromPublic', { rows });
        const r = res?.result || res;
        if (r && Array.isArray(r.attached)) {
          const n = r.attached.length;
          const cloned = r.cloned?.count || 0;
          // 源禁止复制的变体已由后端自动回退克隆
          showButtonFeedback(
            publicFollowBtn,
            'success',
            cloned > 0 ? `挂靠 ${n},克隆 ${cloned}` : `已挂靠 ${n} 个变体`,
            3200,
          );
        } else {
          showButtonFeedback(publicFollowBtn, 'error', res?.error || '提交失败', 3000);
        }
      } catch (e) {
        console.error('[ozon-helper] 公开页挂靠失败:', e?.message || e, e);
        showButtonFeedback(publicFollowBtn, 'error', e?.message || '提交失败', 3000);
      } finally {
        publicFollowBtn.disabled = false;
      }
    });
    publicFollowBtn.dataset.color = 'purple';
    publicFollowBtn.style.display = 'none';
    isPublicFollowEnabled().then((on) => {
      if (on) publicFollowBtn.style.display = '';
    });

    const batchUploadBtn = createActionButton(_ICONS.batchUpload, '批量上架', () => {
      try {
        const url = chrome.runtime.getURL('batch-upload/index.html');
        window.open(url, '_blank');
      } catch (e) {
        console.warn('[ozon-helper] open batch-upload failed:', e);
      }
    });
    batchUploadBtn.dataset.color = 'coral';

    const profitBtn = createActionButton(_ICONS.profit, `${globalThis.__JZ_BRAND__.displayName} 算价`, () => toggleProfitPanel(profitBtn));

    const sourceBtn = createActionButton(_ICONS.source, '1688找货源', () => {
      const product = extractProductData();
      const mainImage = getMainImageUrl(product);
      if (!mainImage) {
        return;
      }
      // 1688 的 imageUrl 参数已不工作（被 OCR 转关键词），改成跳到以图搜款页 +
      // 极掌注入的 __jzcOzonImg 参数；1688-image-search.js content script 会拦截
      // 并自动 fetch 该图 → 注入 file input → 触发 1688 原生以图搜款。
      const url = `https://s.1688.com/youyuan/index.htm?tab=imageSearch&__jzcOzonImg=${encodeURIComponent(
        mainImage
      )}`;
      window.open(url, '_blank');
    });

    const imageSearchBtn = createActionButton(_ICONS.imageSearch, 'OZON以图搜图', async () => {
      if (imageSearchBtn.disabled) return;
      const product = extractProductData();
      const mainImage = getMainImageUrl(product);
      if (!mainImage) {
        showButtonFeedback(imageSearchBtn, 'error', '未找到主图');
        return;
      }

      // Step 1: Locate file input — try direct lookup first, then click camera button if needed
      const findFileInput = () => document.querySelector('input[type="file"][accept*="image"]');
      const findCameraBtn = () => {
        // Strategy 1: known hashed class names (multi-version compat)
        const knownClasses = [
          'search_a7d',   // 2026-04 verified
          'search_l5',    // legacy
          'searchByImage',
          'search-by-image',
          'byImage',
          'camera',
        ];
        for (const cls of knownClasses) {
          const b = document.querySelector(`button[class*="${cls}"]`);
          if (b) return b;
        }
        // Strategy 2 (most stable): inside searchBar, exclude "Поиск/Search" button,
        // first remaining svg-only button = camera
        const searchBar =
          document.querySelector('[data-widget="searchBarDesktop"]') ||
          document.querySelector('[data-widget*="searchBar"]');
        if (searchBar) {
          const buttons = searchBar.querySelectorAll('button');
          for (const b of buttons) {
            if (b.textContent.trim()) continue;
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            if (/поиск|search/.test(aria)) continue;
            if (b.querySelector('svg')) return b;
          }
        }
        // Strategy 3: aria-label keyword (some Ozon variants do label the button)
        const labelled = document.querySelectorAll('button[aria-label]');
        for (const btn of labelled) {
          const lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (/изображ|фото|камер|by.*image|image.*search|camera|photo/.test(lbl)) return btn;
        }
        return null;
      };

      let fileInput = findFileInput();
      if (!fileInput) {
        const cameraBtn = findCameraBtn();
        if (!cameraBtn) {
          showButtonFeedback(imageSearchBtn, 'error', '未找到搜图入口', 3500);
          return;
        }
        cameraBtn.click();
        // Wait for file input to mount (some Ozon variants lazy-mount it)
        for (let i = 0; i < 12 && !fileInput; i++) {
          await new Promise(r => setTimeout(r, 200));
          fileInput = findFileInput();
        }
      }
      if (!fileInput) {
        showButtonFeedback(imageSearchBtn, 'error', '未找到上传入口', 3500);
        return;
      }

      try {
        imageSearchBtn.classList.add('is-loading');
        imageSearchBtn.querySelector('.ozon-helper-action-label').textContent = '搜索中...';

        // Download main image as blob. Hard timeout protects against Ozon
        // CDN hangs / 403 防盗链 keeping the button stuck "搜索中..." forever.
        const imgResp = await fetch(mainImage, {
          signal: AbortSignal.timeout(15000),
        });
        if (!imgResp.ok) {
          throw new Error(`主图下载失败 (${imgResp.status})`);
        }
        const blob = await imgResp.blob();
        const file = new File([blob], 'product.jpg', { type: blob.type || 'image/jpeg' });

        // Set file on the input using DataTransfer
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

        // Step 3: Wait for crop UI to appear, then auto-click "Найти"
        const waitForFind = async (attempts = 20) => {
          for (let i = 0; i < attempts; i++) {
            await new Promise(r => setTimeout(r, 500));
            const btns = document.querySelectorAll('button');
            for (const b of btns) {
              if (b.textContent.trim() === 'Найти') {
                b.click();
                return true;
              }
            }
          }
          return false;
        };
        await waitForFind();
      } catch (err) {
        console.error('[OzonHelper] Image search failed:', err);
        const message =
          err?.name === 'TimeoutError' || err?.name === 'AbortError'
            ? '主图下载超时，请重试'
            : err?.message || '搜图失败';
        showButtonFeedback(imageSearchBtn, 'error', message, 3500);
      } finally {
        imageSearchBtn.classList.remove('is-loading');
        imageSearchBtn.querySelector('.ozon-helper-action-label').textContent = 'OZON以图搜图';
      }
    });

    const keywordBtn = createActionButton(_ICONS.keyword, '主题标签', () => toggleKeywordPanel(keywordBtn));

    // Assign colors to action buttons (colored pill style — from Pencil design)
    collectBtn.dataset.color = 'coral';
    followSellBtn.dataset.color = 'purple';
    profitBtn.dataset.color = 'indigo';
    sourceBtn.dataset.color = 'amber';
    imageSearchBtn.dataset.color = 'cyan';
    keywordBtn.dataset.color = 'green';

    const erpBtn = createActionButton(_ICONS.erp, '进入ERP', () => {
      window.open('http://127.0.0.1:3000/ozon/dashboard/', '_blank');
    });
    erpBtn.dataset.color = 'teal';

    // Dividers matching design
    const divider1 = document.createElement('div');
    divider1.className = 'ozon-helper-bar-divider';
    const divider2 = document.createElement('div');
    divider2.className = 'ozon-helper-bar-divider';

    bar.append(divider1, collectBtn, followSellBtn, publicFollowSellBtn, publicFollowBtn, batchUploadBtn, profitBtn, sourceBtn, imageSearchBtn, keywordBtn, divider2, erpBtn);
    document.body.appendChild(bar);
    initBarDrag(bar);
    loadBarPosition().then(pos => applyBarPosition(bar, pos));
    loadBarCollapsed().then(c => {
      if (c) bar.classList.add('is-collapsed');
    });

    // URL hash 触发：从 data panel 的「跟卖」hero 卡 / 一键跟卖按钮跳过来时,
    // /product/xxx#jz-follow-sell 自动唤起跟卖面板
    if (location.hash === '#jz-follow-sell') {
      history.replaceState(null, '', location.pathname + location.search);
      setTimeout(() => toggleFollowSellPanel(followSellBtn), 600);
    }
  }

  function createActionButton(icon, label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ozon-helper-action-button';
    button.setAttribute('aria-label', label);

    const iconSpan = document.createElement('span');
    iconSpan.className = 'ozon-helper-action-icon';
    iconSpan.innerHTML = icon;

    const labelSpan = document.createElement('span');
    labelSpan.className = 'ozon-helper-action-label';
    labelSpan.textContent = label;

    button.append(iconSpan, labelSpan);
    button.addEventListener('click', onClick);
    return button;
  }

  // ───────────────────────────────────────────────────────────────
  // 精简浮窗(列表页:搜索 / 类目 / 卖家 / 品牌)
  //   只有 [一键跟卖(本页商品卡 SKU 列表)] / [极掌算价] / [进入ERP]。
  //   复用详情页 action bar 的同一套样式 / 拖拽 / 位置&折叠持久化。
  // ───────────────────────────────────────────────────────────────
  function createSlimActionBar() {
    if (document.querySelector('.ozon-helper-action-bar')) {
      return;
    }

    const bar = document.createElement('div');
    bar.className = 'ozon-helper-action-bar';

    // Brand header(与详情页同款)
    const brand = document.createElement('div');
    brand.className = 'ozon-helper-bar-brand';
    {
      const _b = globalThis.__JZ_BRAND__;
      const iconHtml = _b.logoUrl
        ? `<span class="ozon-helper-bar-brand-icon"><img src="${_b.logoUrl}" alt=""></span>`
        : `<span class="ozon-helper-bar-brand-icon">${_b.displayName[0]}</span>`;
      brand.innerHTML = `${iconHtml}<span class="ozon-helper-bar-brand-name">${_b.displayName}</span>`;
    }
    bar.appendChild(brand);

    // 跟卖本页商品卡:抓当前页所有商品卡 SKU,直接打开「一键上架到OZON」跟卖面板,
    // 每个卡片 = 变体定价与规格表里的一行;面板自动背景拉各 SKU 源数据(图/三维/重量/属性),
    // 用户填价后点「一键上架至OZON」一次性发布到当前店铺(默认不合并,各自独立成卡)。
    const followSellBtn = createActionButton(_ICONS.followSell, '跟卖本页商品卡', () =>
      followSellCurrentPageCards(followSellBtn),
    );
    followSellBtn.dataset.color = 'purple';

    const profitBtn = createActionButton(_ICONS.profit, `${globalThis.__JZ_BRAND__.displayName} 算价`, () =>
      toggleProfitPanel(profitBtn),
    );
    profitBtn.dataset.color = 'indigo';

    const erpBtn = createActionButton(_ICONS.erp, '进入ERP', () => {
      window.open('http://127.0.0.1:3000/ozon/dashboard/', '_blank');
    });
    erpBtn.dataset.color = 'teal';

    const divider1 = document.createElement('div');
    divider1.className = 'ozon-helper-bar-divider';
    const divider2 = document.createElement('div');
    divider2.className = 'ozon-helper-bar-divider';

    bar.append(divider1, followSellBtn, profitBtn, divider2, erpBtn);
    document.body.appendChild(bar);
    initBarDrag(bar);
    loadBarPosition().then(pos => applyBarPosition(bar, pos));
    loadBarCollapsed().then(c => {
      if (c) bar.classList.add('is-collapsed');
    });
  }

  // 扫描当前列表页的商品卡 → [{ sku, name, image, price, url }](按 SKU 去重)。
  // selector 与 ozon-data-panel.js / ozon-search.js 的卡片口径保持一致。
  function scanListingCards() {
    const SELECTORS = [
      '.tile-root',
      '[data-widget="searchResultsV2"] [data-widget="searchResultsItem"]',
      '[data-widget="searchResults"] [data-widget="searchResultsItem"]',
    ];
    const nodes = document.querySelectorAll(SELECTORS.join(','));
    const seen = new Set();
    const cards = [];
    nodes.forEach(card => {
      const link = card.querySelector('a[href*="/product/"]');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      const m = href.match(/\/product\/[^?#]*?-(\d{5,})/);
      if (!m) return;
      const sku = m[1];
      if (seen.has(sku)) return;
      seen.add(sku);
      const img = card.querySelector('img');
      const name =
        link.getAttribute('aria-label') ||
        (img && img.getAttribute('alt')) ||
        (link.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) ||
        '';
      // 取第一个含币种符号(₽/¥/₸)且带数字的叶子 span 作为售价。
      let price = '';
      const priceEl = Array.from(card.querySelectorAll('span')).find(
        el => el.children.length === 0 && /\d/.test(el.textContent || '') && /[₽¥₸]/.test(el.textContent || ''),
      );
      if (priceEl) price = (priceEl.textContent || '').replace(/\s+/g, ' ').trim();
      // 跟卖面板「原售价」按 CNY 计价(跨境店),与单品跟卖口径一致:RUB→CNY 换算,
      // CNY 本身 / KZT 等无 FX rate 的币种不强转。
      let priceCny = 0;
      let priceCurrency = 'CNY';
      let priceRub = 0;
      if (price) {
        const cur = _detectCurrencyFromPriceStr(price);
        const num = (window.normalizePrice && window.normalizePrice(price)) || 0;
        const isRub = _isRubFallbackCurrency(cur);
        priceCny = isRub ? _rubToCny(num) : num;
        priceCurrency = isRub ? 'CNY' : cur;
        priceRub = isRub ? num : 0;
      }
      const url = href.startsWith('http') ? href : 'https://' + location.host + href;
      cards.push({ sku, name: name.trim(), image: img ? img.src : '', price, priceCny, priceCurrency, priceRub, url });
    });
    return cards;
  }

  // 跟卖本页商品卡:抓全页商品卡 → 转成跟卖面板的「变体」数组 → 直接打开「一键上架到OZON」面板,
  // 每个卡片 = 变体定价与规格表里一行。源数据(图/三维/重量/属性)由面板自己背景按 SKU 拉取填充。
  // 默认不合并(merge-model 留空),每个 SKU 各自独立成卡;上架到面板里选的(当前)店铺。
  function followSellCurrentPageCards(btn) {
    const cards = scanListingCards();
    if (!cards.length) {
      showButtonFeedback(btn, 'error', '本页未找到商品卡', 3000);
      return;
    }
    // variant 形状与 toggleFollowSellPanel 单变体兜底分支一致(createMultiVariantFollowSellPanel 消费)。
    const variants = cards.map(c => ({
      sku: c.sku,
      title: c.name || `SKU ${c.sku}`,
      price: c.priceCny || 0,
      priceCurrency: c.priceCurrency || 'CNY',
      priceRub: c.priceRub || 0,
      coverImage: c.image || '',
      link: c.url,
      availability: true,
      active: true,
      aspectValues: {},
    }));
    // preCollectedSourceMap 传 null → 面板自己异步背景拉每个 SKU 的源数据填充三维/重量/属性。
    // independentProducts:true → 各卡片是独立商品,提交时不强制对齐到锚点类目(每个 SKU 用自己的源类目)。
    const panel = createMultiVariantFollowSellPanel(variants, null, { independentProducts: true });
    closeAllPanels(panel);
    panel.classList.add('is-open');
    setActiveButton(btn);
  }

  function showButtonFeedback(btn, status, label, durationMs = 2500) {
    const iconSpan  = btn.querySelector('.ozon-helper-action-icon');
    const labelSpan = btn.querySelector('.ozon-helper-action-label');
    const prevIcon  = iconSpan.innerHTML;
    const prevLabel = labelSpan.textContent;
    btn.disabled = true;

    const icons = {
      loading: _svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
      success: _svgIcon('<polyline points="20 6 9 17 4 12"/>'),
      error:   _svgIcon('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'),
    };

    iconSpan.innerHTML    = icons[status] || icons.success;
    labelSpan.textContent = label;

    const restore = () => {
      iconSpan.innerHTML    = prevIcon;
      labelSpan.textContent = prevLabel;
      btn.disabled = false;
    };

    if (status !== 'loading') {
      setTimeout(restore, durationMs);
    }

    return { restore };
  }

  /** 高亮激活的操作栏按钮，传 null 时取消所有高亮 */
  function setActiveButton(activeBtn) {
    document.querySelectorAll('.ozon-helper-action-button')
      .forEach(b => b.classList.remove('is-active'));
    if (activeBtn) activeBtn.classList.add('is-active');
  }

  /** 带退出动画地关闭面板（250ms 与 CSS --oh-duration-base 一致） */
  function closePanel(panel) {
    if (!panel || !panel.classList.contains('is-open')) return;
    try { panel._jzCleanup?.(); } catch {}
    panel._jzCleanup = null;
    setActiveButton(null);
    panel.classList.add('is-closing');
    setTimeout(() => {
      panel.classList.remove('is-open', 'is-closing');
    }, 250);
  }

  /** 关闭除 exceptPanel 以外的所有已打开面板 */
  function closeAllPanels(exceptPanel) {
    [
      '.ozon-helper-data-panel',
      '.ozon-helper-profit-panel',
      '.ozon-helper-followsell-panel',
      '.ozon-helper-keyword-panel',
    ].forEach(sel => {
      const p = document.querySelector(sel);
      if (p && p !== exceptPanel && p.classList.contains('is-open')) {
        closePanel(p);
      }
    });
    // jzc 算价面板(extension-lite 迁移过来)— 不用 is-open class,独立 unmount
    if (exceptPanel?.classList?.contains?.('jzc-panel')) return;
    if (window.__jzcIsMounted && window.__jzcIsMounted()) {
      window.__jzcUnmountPanel();
    }
  }

  function createDataPanel() {
    let panel = document.querySelector('.ozon-helper-data-panel');
    if (panel) {
      return panel;
    }
    panel = document.createElement('div');
    panel.className = 'ozon-helper-panel ozon-helper-data-panel';

    const header = document.createElement('div');
    header.className = 'ozon-helper-panel-header';
    header.innerHTML = '<span>数据面板</span><button class="ozon-helper-close-btn" data-action="close">&times;</button>';

    const content = document.createElement('div');
    content.className = 'ozon-helper-panel-content';
    content.innerHTML = '<div class="ozon-helper-panel-empty">加载中...</div>';

    panel.append(header, content);
    document.body.appendChild(panel);

    header.querySelector('[data-action="close"]').addEventListener('click', () => {
      closePanel(panel);
    });

    return panel;
  }

  function updateDataPanel() {
    const panel = createDataPanel();
    const content = panel.querySelector('.ozon-helper-panel-content');
    if (!content) {
      return;
    }
    const product = extractProductData();
    const sellerName = product.seller?.name || '未知卖家';
    const sellerLink = product.seller?.link || '';
    const avgPrice = window.normalizePrice(product.statistics?.avg_price || 0);
    const currentPrice = window.normalizePrice(product.price || 0);
    const originalPrice = window.normalizePrice(product.originalPrice || 0);
    const discountPercent =
      originalPrice > currentPrice && originalPrice > 0
        ? Math.round(((originalPrice - currentPrice) / originalPrice) * 100)
        : 0;

    const createDate = product.statistics?.create_date || '';
    const daysSinceListing = createDate
      ? Math.max(
          0,
          Math.floor(
            (Date.now() - new Date(createDate).getTime()) / (1000 * 60 * 60 * 24)
          )
        )
      : null;

    content.innerHTML = `
      <div class="ozon-helper-panel-section">
        <div class="ozon-helper-panel-section-title"><span class="ozon-helper-section-icon">${window.lucideIcon('package', 14)}</span>商品信息</div>
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">Product ID / SKU</span>
          <span class="ozon-helper-value">${product.productId || product.sku || '-'}</span>
        </div>
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">卖家</span>
          <span class="ozon-helper-value">
            ${sellerLink ? `<a class="ozon-helper-link" href="${sellerLink}" target="_blank" rel="noopener">${sellerName}</a>` : sellerName}
          </span>
        </div>
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">上架天数</span>
          <span class="ozon-helper-value">${daysSinceListing !== null ? `${daysSinceListing} 天` : '-'}</span>
        </div>
      </div>

      <div class="ozon-helper-panel-section">
        <div class="ozon-helper-panel-section-title"><span class="ozon-helper-section-icon">${window.lucideIcon('dollar-sign', 14)}</span>销售数据</div>
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">月销量</span>
          <span class="ozon-helper-value">${window.formatNumber(product.statistics?.sold_count || 0)}</span>
        </div>
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">销售额</span>
          <span class="ozon-helper-value">${window.formatNumber(product.statistics?.sold_sum || 0)} ₽</span>
        </div>
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">GMV</span>
          <span class="ozon-helper-value">${window.formatNumber(product.statistics?.gmv_sum || 0)} ₽</span>
        </div>
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">均价</span>
          <span class="ozon-helper-value">${window.formatNumber(product.statistics?.avg_price || 0)} ₽</span>
        </div>
      </div>

      <div class="ozon-helper-panel-section">
        <div class="ozon-helper-panel-section-title"><span class="ozon-helper-section-icon">${window.lucideIcon('bar-chart', 14)}</span>流量数据</div>
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">浏览量</span>
          <span class="ozon-helper-value">${window.formatNumber(product.statistics?.views || 0)}</span>
        </div>
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">会话数</span>
          <span class="ozon-helper-value">${window.formatNumber(product.statistics?.session_count || 0)}</span>
        </div>
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">加购转化</span>
          <span class="ozon-helper-value">${product.statistics?.conv_to_cart_pdp ? `${window.formatNumber(product.statistics.conv_to_cart_pdp, 2)}%` : '-'}</span>
        </div>
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">下单转化</span>
          <span class="ozon-helper-value">${product.statistics?.conv_view_to_order ? `${window.formatNumber(product.statistics.conv_view_to_order, 2)}%` : '-'}</span>
        </div>
      </div>

      <div class="ozon-helper-panel-section">
        <div class="ozon-helper-panel-section-title"><span class="ozon-helper-section-icon">${window.lucideIcon('tag', 14)}</span>价格信息</div>
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">当前价格</span>
          <span class="ozon-helper-value">${window.formatNumber(currentPrice)} ₽</span>
        </div>
        ${originalPrice ? `<div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">原价</span>
          <span class="ozon-helper-value">${window.formatNumber(originalPrice)} ₽ <span class="ozon-helper-discount">(-${discountPercent}%)</span></span>
        </div>` : ''}
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">均价对比</span>
          <span class="ozon-helper-value ${avgPrice ? (currentPrice <= avgPrice ? 'is-good' : 'is-bad') : 'is-muted'}">${avgPrice ? (currentPrice <= avgPrice ? `${window.lucideIcon('check', 12)} 低于均价` : `${window.lucideIcon('trending-up', 12)} 高于均价`) : '均价未知'}</span>
        </div>
        <div class="ozon-helper-panel-row">
          <span class="ozon-helper-label">佣金</span>
          <span class="ozon-helper-value">~5-15%</span>
        </div>
      </div>
    `;
  }

  function toggleDataPanel(btn) {
    const panel = createDataPanel();
    if (panel.classList.contains('is-open')) {
      closePanel(panel);
    } else {
      closeAllPanels(panel);
      panel.classList.add('is-open');
      setActiveButton(btn);
      updateDataPanel();
    }
  }

  // ===== Sidebar Data Card (injected into Ozon right sidebar) =====

  function formatDimensionMm(chars, key) {
    if (!chars) return '-';
    // Try mm first (from OzonSelectionProduct), then cm (from page characteristics)
    const mmKey = key + 'Mm';
    const cmKey = key + 'Cm';
    if (chars[mmKey]) return `${chars[mmKey]}毫米`;
    if (chars[cmKey]) {
      const n = parseFloat(chars[cmKey]);
      return Number.isNaN(n) ? '-' : `${Math.round(n * 10)}毫米`;
    }
    return '-';
  }

  let _sidebarCardRetries = 0;
  // 数据卡会员门控状态:null=未查,'pending'=查询中,{allowed}=已就绪(页面级只查一次)
  let _dataCardGate = null;
  // Inline lucide icon SVG (no font dependency, stroke uses currentColor)
  const _lucideSvg = (name) => {
    const paths = {
      'zap': '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
      'package': '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
      'target': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
      'bar-chart': '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
      'truck': '<rect x="1" y="3" width="15" height="13" rx="1"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
      'link': '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
      'pencil': '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
      'users': '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
      'inbox': '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
      'alert-triangle': '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
      'check': '<polyline points="20 6 9 17 4 12"/>',
      'trending-up': '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    };
    const p = paths[name] || paths['package'];
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  };

  // 「需登录卖家中心」提示条已统一进 jzPopulatePanelV2(shared-utils.js):
  // getMarketStats 返 __needSellerLogin 且后端无市场数据时,插入卡 body。
  function createSidebarDataCard() {
    console.log('[ozon-helper] createSidebarDataCard called, retry:', _sidebarCardRetries);
    if (document.querySelector('.ozon-helper-sidebar-card')) {
      console.log('[ozon-helper] sidebar card already exists, skipping');
      _sidebarCardRetries = 0;
      return;
    }

    // Target the rightmost webStickyColumn (price/cart sidebar, index 2)
    // Layout: [0]=gallery(left), [1]=product info(middle), [2]=price/cart(right)
    const stickyCols = document.querySelectorAll('[data-widget="webStickyColumn"]');
    console.log('[ozon-helper] found webStickyColumn count:', stickyCols.length);
    // Need at least 3 columns; if not ready yet, retry (Ozon SPA renders async)
    if (stickyCols.length < 3) {
      if (_sidebarCardRetries < 15) {
        _sidebarCardRetries++;
        setTimeout(createSidebarDataCard, 1000);
      } else {
        console.log('[ozon-helper] gave up waiting for 3 sticky columns');
      }
      return;
    }
    const stickyCol = stickyCols[2];

    // Find the inner grid that contains webSale (price/cart area)
    // Insert after webSale, same position as MaoziERP
    const webSale = stickyCol.querySelector('[data-widget="webSale"]');
    console.log('[ozon-helper] webSale found:', !!webSale);
    let insertParent = webSale ? webSale.parentElement : stickyCol;
    let insertAnchor = webSale;
    // Ozon 偶尔会把 webSale 套进一个比 stickyCol 窄的内层容器（带 padding 或
    // 自身 max-width），这会让我们的卡片比同 sticky 列里的 "Магазин" 卡窄。
    // 检测到差距 ≥8px 时，把插入点上提到 stickyCol 直接子层，跟 Магазин 同级。
    if (insertParent && insertParent !== stickyCol && insertParent.parentElement) {
      try {
        const innerW = insertParent.getBoundingClientRect().width;
        const outerW = stickyCol.getBoundingClientRect().width;
        if (innerW > 0 && outerW - innerW >= 8) {
          insertAnchor = insertParent;
          insertParent = insertParent.parentElement;
        }
      } catch {
        // getBoundingClientRect 极小概率抛错时保持原插入点
      }
    }

    // —— 会员门控:数据卡为会员功能,免费档渲染锁定卡(不抽页面数据、不发请求) ——
    // 首次进入先异步查(页面级只查一次),就绪后重入本函数;jzDataCardAllowed 内部
    // Web 未登录时 fail-closed；已登录但会员接口暂不可达时放行。
    if (_dataCardGate === null) {
      _dataCardGate = 'pending';
      window.jzDataCardAllowed().then((g) => {
        _dataCardGate = g && typeof g === 'object' ? g : { allowed: true };
        createSidebarDataCard();
      });
      return;
    }
    if (_dataCardGate === 'pending') return;
    if (_dataCardGate.allowed === false) {
      const lockedCard = document.createElement('div');
      lockedCard.className = 'ozon-helper-sidebar-card';
      lockedCard.setAttribute('lang', 'zh-Hans');
      lockedCard.innerHTML = `
        ${window.jzPanelBrandHeaderHtml({
          status: '会员功能',
          statusState: 'locked',
          showGear: false,
          showClose: true,
        })}
        <div class="ozon-helper-sidebar-card-body"></div>`;
      const lockedBody = lockedCard.querySelector('.ozon-helper-sidebar-card-body');
      if (_dataCardGate.reason === 'WEB_AUTH_REQUIRED') {
        window.jzRenderDataCardLoginRequired(lockedBody);
      } else {
        window.jzRenderDataCardLocked(lockedBody);
      }
      try {
        if (insertAnchor && insertAnchor.nextSibling) {
          insertParent.insertBefore(lockedCard, insertAnchor.nextSibling);
        } else {
          insertParent.appendChild(lockedCard);
        }
      } catch {
        return;
      }
      window.jzBindPanelBrandFallback?.(lockedCard);
      lockedCard.querySelector('[data-action="close-sidebar-card"]')?.addEventListener('click', () => lockedCard.remove());
      return;
    }

    let product;
    try {
      product = extractProductData();
    } catch (err) {
      return;
    }
    const card = document.createElement('div');
    card.className = 'ozon-helper-sidebar-card';
    card.setAttribute('lang', 'zh-Hans');

    // Statistics from detail_info (may be null on current Ozon pages)
    const stats = product.statistics || {};

    // Format rating display
    const formatRating = (rating, reviewCount) => {
      const sharedRating = window.jzFormatRating?.(rating, reviewCount);
      if (sharedRating) return sharedRating;
      const numericRating = Number(rating);
      if (!Number.isFinite(numericRating) || numericRating <= 0) return '-';
      const plainRating = numericRating.toFixed(1);
      return reviewCount ? `${plainRating} (${window.formatNumber(reviewCount)})` : plainRating;
    };

    // Build grouped 2-col rows. 首屏概览复用 shared-utils 的统一结构，避免 PDP
    // 与列表卡在 SKU 状态、三项经营指标和物流摘要上产生漂移。
    // Page-extracted characteristics 可能已经带俄文/英文单位 ("100 г"/"10 см"),
    // 直接拼 "g"/"cm" 会变 "100 гg"。带字母的原样显示,纯数字才补单位。
    const formatWeightG = (raw) => {
      if (raw == null) return null;
      const s = String(raw).trim();
      if (!s) return null;
      return /\p{L}/u.test(s) ? s : `${s}g`;
    };
    const formatDimsCm = (l, w, h) => {
      if (l == null || w == null || h == null) return null;
      const sL = String(l).trim(), sW = String(w).trim(), sH = String(h).trim();
      if (!sL || !sW || !sH) return null;
      const anyUnit = /\p{L}/u.test(sL + sW + sH);
      return anyUnit ? `${sL}×${sW}×${sH}` : `${sL}×${sW}×${sH}cm`;
    };
    const heroFollowVal = product.followSellCount != null ? String(product.followSellCount) : null;
    const heroFollowSub = product.followSellCount != null ? '卖家' : null;
    const charWeight = product.characteristics?.weightG;
    const heroSizeMain = formatWeightG(charWeight);
    const heroSizeSub = formatDimsCm(
      product.characteristics?.lengthCm,
      product.characteristics?.widthCm,
      product.characteristics?.heightCm,
    );
    // 体积(升)初值:PDP 特征是 cm(可能带单位后缀如 "10 см"),解析成数值后
    // cm³→L(/1000)。解析不出就 '-',由 jzPopulatePanelV2 的 mm 数据异步补。
    const _pdpInitialVolume = (() => {
      const pf = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
      const l = pf(product.characteristics?.lengthCm);
      const w = pf(product.characteristics?.widthCm);
      const h = pf(product.characteristics?.heightCm);
      return (l && w && h) ? +(l * w * h / 1000).toFixed(2) + ' L' : '-';
    })();
    const overviewHtml = window.jzPanelOverviewHtml({
      sku: product.sku,
      salesValue: '-',
      salesTip: `商品${window.jzSalesPeriodCnLong?.() || '近 30 天'}销售数量(Ozon 选品分析 what_to_sell)`,
      createValue: '-',
      followValue: heroFollowVal || '-',
      followSub: heroFollowSub,
      followTip: heroFollowVal === '0' ? '商品当前无跟卖者' : '\u70b9\u51fb\u67e5\u770b\u8ddf\u5356\u5546\u5bb6\u5217\u8868',
      followAction: heroFollowVal === '0' ? null : 'show-followsell-modal',
      sizeValue: heroSizeMain || '-',
      sizeSub: heroSizeSub,
    });

    const sections = [
      {
        id: 'info', icon: _lucideSvg('package'), title: '商品信息', accent: 'blue', rows: [
          { field: 'category', label: '一级类目', value: '-', tip: '商品一级类目', full: true },
          { field: 'categoryL3', label: '三级类目', value: product.category || '-', tip: '商品三级(末级)类目', full: true },
          { field: 'sku', label: 'SKU', value: product.sku || '-', copyable: true, tip: '商品SKU', full: true },
          { field: 'brand', label: '品牌', value: product.brand || '-', color: 'orange', tip: '商品品牌' },
          { field: 'salesSchema', label: '发货模式', value: '-', tip: '商品发货模式' },
          { field: 'commRfbs', label: 'rFBS佣金', value: '-', color: 'orange', tip: '按商品售价档位收取的佣金比例', full: true },
          { field: 'commFbp', label: 'FBP佣金', value: '-', color: 'orange', tip: '按商品售价档位收取的佣金比例', full: true },
          { field: 'revenue30d', label: `${window.jzSalesPeriodCnShort?.() || '月'}销售额`, value: '-', color: 'blue', tip: `商品${window.jzSalesPeriodCnLong?.() || '近 30 天'}销售额(Ozon 选品分析 what_to_sell)` },
          { field: 'salesDynamics', label: `${window.jzSalesPeriodCnShort?.() || '月'}周转动态`, value: '-', tip: `与${window.jzSalesPeriodCnPrev?.() || '上一个月'}相比订单金额总和发生了怎样的变化` },
          { field: 'dailySales', label: '日销量', value: '-', color: 'blue', tip: `${window.jzSalesPeriodCnUnit?.() || '近一个月'}销售件数，除以商品有现货的天数，退货和取消不纳入计算` },
          { field: 'dailyRevenue', label: '日销售额', value: '-', color: 'blue', tip: `${window.jzSalesPeriodCnUnit?.() || '近一个月'}销售金额除以商品有现货的天数，退货和取消不纳入计算` },
          { field: 'drr', label: '广告费占比', value: '-', tip: '商品推广费用占所有订单金额的百分比', full: true },
        ],
      },
      {
        id: 'promo', icon: _lucideSvg('target'), title: '促销推广', accent: 'orange', rows: [
          { field: 'daysInPromo', label: '促销天数', value: '-', tip: '商品近一个月参与促销的天数' },
          { field: 'promoDiscount', label: '促销折扣', value: '-', tip: '近一个月参与促销的平均折扣' },
          { field: 'promoConvRate', label: '促销转化率', value: '-', color: 'green', tip: '促销期间订购的金额，在总订购金额的占比' },
          { field: 'daysWithAds', label: '推广天数', value: '-', tip: '近一个月参与模版付费推广的天数' },
          {
            field: 'discount', label: '折扣',
            value: stats.discount != null && Number.isFinite(Number(stats.discount)) ? `${Number(stats.discount)}%` : '-',
            color: 'orange', tip: '当前商品的折扣百分比',
          },
        ],
      },
      {
        id: 'traffic', icon: _lucideSvg('bar-chart'), title: '流量转化', accent: 'green', rows: [
          { field: 'pdpViews', label: '卡片浏览', value: '-', tip: '买家打开商品卡片的次数' },
          { field: 'pdpCartRate', label: '卡片加购率', value: '-', tip: '商品卡片浏览次数与浏览后将商品添加到购物车的数量之间的比例' },
          { field: 'searchViews', label: '搜索浏览', value: '-', tip: '买家在搜索结果中和类目中查看商品的次数' },
          { field: 'searchCartRate', label: '搜索加购率', value: '-', tip: '商品添加到购物车的次数与在目录和搜索结果中浏览次数之间的比例' },
          {
            field: 'views', label: '展示量',
            value: stats.views != null && Number.isFinite(Number(stats.views)) ? window.formatNumber(Number(stats.views)) : '-',
            tip: '商品在网站所有页面上的展示次数',
          },
          { field: 'convViewToOrder', label: '展示转化率', value: '-', tip: '商品在网站所有页面上的展示次数与订单数量的比例' },
          { field: 'clickRate', label: '点击率', value: '-', color: 'orange', tip: '买家点击商品的次数与商品在网站所有页面上的展示次数之间的比例' },
        ],
      },
      {
        id: 'logistics', icon: _lucideSvg('truck'), title: '物流详情', accent: 'purple', rows: [
          { field: 'returnRate', label: '退货率', value: '-', color: 'red', tip: '商品退货取消率' },
          { field: 'rating', label: '评分', value: formatRating(product.rating, product.reviewCount), color: product.rating ? 'gold' : '', tip: '商品评分及评论数量' },
          {
            field: 'stock', label: '库存',
            value: product.freeRest != null && Number.isFinite(Number(product.freeRest)) ? window.formatNumber(Number(product.freeRest)) : '-',
            tip: '当前商品库存量',
          },
          { field: 'dimensions', label: '长宽高', value: '-', tip: '商品长宽高(毫米)', full: true },
          { field: 'volume', label: '体积', value: _pdpInitialVolume, tip: '按长×宽×高估算的体积(升)', full: true },
          { field: 'weight', label: '重量', value: formatWeightG(product.characteristics?.weightG) || '-', tip: '商品重量(克)', full: true },
        ],
      },
      {
        id: 'follow', icon: _lucideSvg('link'), title: '跟卖信息', accent: 'pink', rows: [
          { field: 'followMinPrice', label: '最低价', value: product.followSellMinPrice ? `₽${window.formatNumber(product.followSellMinPrice, 2)}` : '-', color: 'green', tip: '商品的跟卖最低价' },
          { field: 'canFollow', label: '能否跟卖', value: '-', tip: '该商品是否支持跟卖', full: true },
        ],
      },
    ];

    // Render normal row HTML
    const renderRow = (r) => {
      const valueText = String(r.value == null ? '' : r.value);
      const valueContent = r.raw
        ? r.value
        : `${_escHtml(valueText)}${r.copyable ? ' <span class="ozon-helper-copy-btn" data-copy="' + _escHtml(valueText) + '">' + window.lucideIcon('copy', 12) + '</span>' : ''}`;
      const colorCls = r.color ? ` is-${r.color}` : '';
      const dimCls = r.value === '-' ? ' is-dim' : '';
      const clickCls = r.clickable ? ' is-clickable' : '';
      const fullCls = r.full ? ' is-full-row' : '';
      const tipAttr = r.tip ? ` data-oh-tip="${_escHtml(r.tip)}"` : '';
      const clickAttr = r.clickable ? ` data-click-action="${r.clickAction || ''}"` : '';
      return `<div class="ozon-helper-sidebar-card-row${fullCls}">
        <span class="ozon-helper-sidebar-card-label"${tipAttr}>${r.label}</span>
        <span class="ozon-helper-sidebar-card-value${colorCls}${dimCls}${clickCls}" data-field="${r.field}"${clickAttr}>${valueContent}</span>
      </div>`;
    };

    // Render collapsible regular sections.
    const renderSection = (section) => {
      const collapsed = sessionStorage.getItem(`oh-sidebar-collapsed-${section.id}`) === '1';
      const accentCls = section.accent ? ` is-accent-${section.accent}` : '';
      return `<div class="ozon-helper-sidebar-section${collapsed ? ' is-collapsed' : ''}${accentCls}" data-section="${section.id}">
        <div class="ozon-helper-sidebar-section-header" data-action="toggle-section">
          <span><span class="oh-section-icon">${section.icon}</span>${section.title}</span>
          <span class="ozon-helper-sidebar-chevron">▼</span>
        </div>
        <div class="ozon-helper-sidebar-section-body${collapsed ? ' is-collapsed' : ''}">
          ${section.rows.map(renderRow).join('')}
        </div>
      </div>`;
    };

    card.innerHTML = `
      ${window.jzPanelBrandHeaderHtml({
        status: '正在加载商品数据',
        statusState: 'loading',
        showGear: true,
        showClose: true,
      })}
      <div class="ozon-helper-sidebar-card-body">
        ${overviewHtml}
        ${sections.map(renderSection).join('')}
      </div>
      <div class="ozon-helper-sidebar-card-actions">
        <button class="ozon-helper-sidebar-card-btn is-primary" data-action="quick-list"><span class="oh-btn-icon">${_lucideSvg('zap')}</span>一键上架</button>
        <div class="ozon-helper-sidebar-card-actions-row">
          <button class="ozon-helper-sidebar-card-btn" data-action="edit-list"><span class="oh-btn-icon">${_lucideSvg('pencil')}</span>编辑上架</button>
          <button class="ozon-helper-sidebar-card-btn" data-action="collect-one"><span class="oh-btn-icon">${_lucideSvg('inbox')}</span>采集</button>
        </div>
      </div>
    `;

    // Insert after the chosen anchor (webSale or its outer wrapper if we hopped)
    try {
      if (insertAnchor && insertAnchor.nextSibling) {
        insertParent.insertBefore(card, insertAnchor.nextSibling);
      } else {
        insertParent.appendChild(card);
      }
    } catch {
      return;
    }

    window.jzBindPanelBrandFallback?.(card);
    card.querySelector('[data-action="close-sidebar-card"]').addEventListener('click', () => card.remove());
    // 字段设置齿轮:打开显隐设置弹窗(保存后对全站数据卡生效)。
    card.querySelector('[data-action="open-field-settings"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      window.jzOpenFieldSettings?.(card);
    });
    // 标记为数据卡 + 应用当前字段显隐(默认全显;用户关过的字段隐藏)。
    card.setAttribute('data-jz-datacard', '1');
    window.jzLoadFieldVisibility?.().then((v) => window.jzApplyFieldVisibility?.(card, v));
    card.querySelector('[data-action="quick-list"]')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      // Drive the follow-sell panel directly. The previous implementation
      // used `.click()` on the floating action-bar button, which was opaque
      // to errors and broke whenever the bar was renamed or absent.
      try {
        if (typeof toggleFollowSellPanel !== 'function') {
          throw new Error('\u8ddf\u5356\u6d41\u7a0b\u672a\u51c6\u5907\u597d');
        }
        toggleFollowSellPanel(btn);
      } catch (err) {
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<span class="oh-btn-icon">${_lucideSvg('alert-triangle')}</span>${_escHtml(err && err.message ? err.message : '\u542f\u52a8\u5931\u8d25')}`;
        setTimeout(() => {
          btn.innerHTML = original;
          btn.disabled = false;
        }, 2500);
        console.warn('[ozon-helper] quick-list failed:', err);
      }
    });
    let editListInFlight = false;
    card.querySelector('[data-action="edit-list"]')?.addEventListener('click', async () => {
      // Closure flag guards against double-fire even when the button reference
      // becomes stale (e.g. card re-renders during the async chain).
      if (editListInFlight) return;
      editListInFlight = true;
      const editBtn = card.querySelector('[data-action="edit-list"]');
      const originalText = editBtn.textContent;
      editBtn.textContent = '⏳ 采集中...';
      editBtn.disabled = true;
      try {
        // 编辑上架必须复用“采集所有变体”的链路。旧实现只抓当前 SKU,即使页面是
        // 多规格商品,写入采集箱的 variantData 也只有单个 SKU,后台编辑页只能显示 1 行。
        const result = await collectAllVariants(editBtn, { forceResubmit: true });
        if (!result?.ok) throw new Error(result?.error || '采集失败');
        const itemId = result?.itemId;
        // 从 brand webHost 直接构造,不要从 backendUrl 反推 — 旧 `.replace('/api','')`
        // 会把 `https://api.jizhangerp.com` 中的 `://api` 后 4 字符 `/api` 误删,
        // 得到 `https:/.jizhangerp.com` 这个残缺 URL,浏览器按相对路径解析 →
        // 拼到 ozon.ru 域名下变成 `https://www.ozon.ru/.jizhangerp.com/...`。
        const frontendUrl = 'http://127.0.0.1:3000';
        if (itemId) {
          window.open(`${frontendUrl}/ozon/products/collect/edit?id=${itemId}`, '_blank');
        } else {
          window.open(`${frontendUrl}/ozon/products/collect`, '_blank');
        }
      } catch (err) {
        console.error('[ozon-helper] edit-list failed:', err);
        editBtn.textContent = '失败';
        setTimeout(() => {
          editBtn.textContent = originalText;
          editBtn.disabled = false;
          editListInFlight = false;
        }, 2000);
        return;
      }
      editBtn.textContent = originalText;
      editBtn.disabled = false;
      editListInFlight = false;
    });

    // 「采集」按钮与 action bar 共用正式采集链路，只写入后台采集箱。
    let collectInFlight = false;
    card.querySelector('[data-action="collect-one"]')?.addEventListener('click', async (e) => {
      if (collectInFlight) return;
      collectInFlight = true;
      const btn = e.currentTarget;
      const originalHtml = btn.innerHTML;
      try {
        // PDP 侧栏数据卡片跟 action bar 上的「一键采集」在同一个 PDP 页、同一份页面
        // 状态,复用同一个 collectAllVariants() — 采当前商品的所有变体 SKU,进度写在
        // 该按钮上;单/无变体页内部自动委托单采。
        const result = await collectAllVariants(btn);
        btn.classList.add('is-collected');
        const label = result?.dedupeHit ? '近期已采集' : '已采集';
        btn.innerHTML = `<span class="oh-btn-icon">✓</span>${label}`;
        setTimeout(() => {
          btn.classList.remove('is-collected');
          btn.innerHTML = originalHtml;
          collectInFlight = false;
        }, result?.multiVariant ? 2800 : 1800);
      } catch (err) {
        console.warn('[ozon-helper] sidebar collect-one failed:', err);
        const friendly = productCollectFailurePresentation(err);
        btn.innerHTML = `<span class="oh-btn-icon">${_lucideSvg('alert-triangle')}</span>${friendly}`;
        setTimeout(() => {
          btn.innerHTML = originalHtml;
          collectInFlight = false;
        }, 1800);
      }
    });

    if (window.jzBindDataCardCopyButtons) {
      window.jzBindDataCardCopyButtons(card);
    } else {
      card.querySelectorAll('.ozon-helper-copy-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation?.();
          const original = btn.dataset.copyIcon || btn.innerHTML || window.lucideIcon('copy', 12);
          btn.dataset.copyIcon = original;
          const ok = await _safeCopy(btn.dataset.copy);
          btn.textContent = ok ? '\u2713' : '\u2716';
          setTimeout(() => { btn.innerHTML = btn.dataset.copyIcon || window.lucideIcon('copy', 12); }, 1200);
        });
      });
    }

    // Click handler for clickable rows (e.g. follow-sell list)
    card.addEventListener('click', (e) => {
      const target = e.target.closest('[data-click-action]');
      if (!target) return;
      const action = target.getAttribute('data-click-action');
      if (action === 'show-followsell-modal') {
        e.stopPropagation();
        if (window.jzShowFollowSellListModal) {
          window.jzShowFollowSellListModal(target, product, { trigger: 'click' });
        } else {
          createFollowSellListModal(target, product);
        }
      }
    });

    // Section collapse/expand toggle
    card.querySelectorAll('[data-action="toggle-section"]').forEach(header => {
      header.addEventListener('click', () => {
        const section = header.closest('.ozon-helper-sidebar-section');
        const body = section.querySelector('.ozon-helper-sidebar-section-body');
        const sectionId = section.dataset.section;
        const isCollapsed = body.classList.toggle('is-collapsed');
        section.classList.toggle('is-collapsed', isCollapsed);
        sessionStorage.setItem(`oh-sidebar-collapsed-${sectionId}`, isCollapsed ? '1' : '0');
        // Remove "(无数据)" hint when user expands
        if (!isCollapsed) {
          const hint = header.querySelector('.ozon-helper-sidebar-empty-hint');
          if (hint) hint.remove();
        }
      });
    });

    // === Async: 灌数走 shared-utils 的 jzPopulatePanelV2(与列表/搜索卡同一实现) ===
    // 旧 fetchBackendProductData 是 ~280 行平行实现,与 V2 漂移出一批两卡不一致
    // (空值填0/格式/sv覆盖优先级/字段缺兜底),已删。PDP 特有上下文经 options 传入。
    if (product.sku && typeof window.jzPopulatePanelV2 === 'function') {
      // 面包屑买家类目 id → 后端佣金按 ID 精确分档(无 id 才退回俄文名兜底)
      const _bcCatIds = (() => { try { return extractBreadcrumbCategoryIds(); } catch { return []; } })();
      // 页面实价定佣金档:币种**明确**是 CNY/USD(跨境视图)才不用;RUB 或检测不到(null)
      // 都按卢布用 —— 卡片本就把该价显示成 ₽,口径一致。
      const _pageCur = _detectPageCurrency();
      const _pageRub =
        _pageCur !== 'CNY' && _pageCur !== 'USD'
          ? (window.normalizePrice ? window.normalizePrice(product.price) : Number(product.price)) || 0
          : 0;
      window
        .jzPopulatePanelV2(card, product.sku, {
          catIds: _bcCatIds,
          pageRub: _pageRub,
          noFollowFetch: true, // 页面 widget 已带跟卖数,免打 composer
          persistDims: true, // sv 真值写本地缓存 + 回写服务端 ozon_sku_dims
          onFeatureGated: () => {
            // 会员门控兜底:整卡切锁定态,不零散显示"-"
            const body = card.querySelector('.ozon-helper-sidebar-card-body');
            if (body && window.jzRenderDataCardLocked) window.jzRenderDataCardLocked(body);
          },
        })
        .catch((err) => console.warn('[ozon-helper] populate sidebar card failed:', err))
        .finally(() => {
          if (document.contains(card)) autoCollapseEmptySections(card);
        });
    } else {
      // No SKU — immediately collapse empty sections
      setTimeout(() => autoCollapseEmptySections(card), 100);
    }

    // Watch for Ozon SPA re-renders that remove our card
    // Re-inject when the card disappears from DOM
    const cardObserver = new MutationObserver(() => {
      // 原始节点还在 → 无事发生。
      if (document.contains(card)) return;
      // 原始卡离开了 DOM:Ozon 要么把它删了,要么把子树重新序列化成一张
      // addEventListener 监听器全丢的克隆(监听器不随 HTML 序列化保留)。旧守卫
      // `!querySelector('.ozon-helper-sidebar-card')` 在克隆这种情况下会误判
      // 「已存在」而不重建,留下一张收起/复制/采集全点不动的死卡。这里一律先拆掉
      // 残留卡(否则顶层 createSidebarDataCard 的去重守卫又会挡掉重建),再重新注入
      // 一张监听器齐全的新卡。
      cardObserver.disconnect();
      document.querySelectorAll('.ozon-helper-sidebar-card').forEach(el => el.remove());
      _sidebarCardRetries = 0;
      setTimeout(createSidebarDataCard, 500);
    });
    // Observe the parent that Ozon re-renders
    const observeTarget = insertParent.closest('[data-widget="webStickyColumn"]') || insertParent;
    cardObserver.observe(observeTarget, { childList: true, subtree: true });
  }

  /**
   * Auto-collapse sections where every row value is still "-" (placeholder).
   * Adds a subtle "(无数据)" hint on the section header.
   */
  function autoCollapseEmptySections(card) {
    if (!card || !document.contains(card)) return;
    card.querySelectorAll('.ozon-helper-sidebar-section').forEach(section => {
      const sectionId = section.dataset.section;
      // Skip if user has manually toggled this section (stored in sessionStorage)
      if (sessionStorage.getItem(`oh-sidebar-collapsed-${sectionId}`) != null) return;
      const body = section.querySelector('.ozon-helper-sidebar-section-body');
      const values = body.querySelectorAll('.ozon-helper-sidebar-card-value');
      const allEmpty = Array.from(values).every(v => v.classList.contains('is-dim'));
      if (allEmpty && values.length > 0) {
        body.classList.add('is-collapsed');
        section.classList.add('is-collapsed');
        // Add "(无数据)" hint to header if not already present
        const header = section.querySelector('.ozon-helper-sidebar-section-header');
        if (header && !header.querySelector('.ozon-helper-sidebar-empty-hint')) {
          const hint = document.createElement('span');
          hint.className = 'ozon-helper-sidebar-empty-hint';
          hint.textContent = '(无数据)';
          header.querySelector('span:first-child').appendChild(hint);
        }
      }
    });
  }

  // ─── Calculator Constants ────────────────────────────────
  //
  // 类目佣金率 — Ozon 官方跨境「销售佣金」表(2025-12-01 起生效,rFBS 模式)。
  // 真值见 backend/src/ozon/data/ozon-commission-table.ts(单一来源,调价同步那里)。
  // 每项 rates = [≤1500₽, 1501-5000₽, >5000₽] 三个价格档(百分数)。
  // 跨境店无小单保护(≤100/≤300 那套属俄罗斯本土店),已移除。
  const _CALC_DEFAULT_RATES = [12, 14, 18];
  const _CALC_COMMISSIONS = [
    { value: "药店", label: "药店 — 12/14/18%", rates: [12, 14, 18] },
    { value: "矫形用品", label: "矫形用品 — 12/17/17%", rates: [12, 17, 17] },
    { value: "成人用品", label: "成人用品 — 12/14/21%", rates: [12, 14, 21] },
    { value: "辅助药品", label: "辅助药品 — 12/15/15%", rates: [12, 15, 15] },
    { value: "电子烟及加热系统配件", label: "电子烟及加热系统配件 — 12/24/24%", rates: [12, 24, 24] },
    { value: "维生素和膳食补充剂", label: "维生素和膳食补充剂 — 12/18/18%", rates: [12, 18, 18] },
    { value: "装饰、清洁与储物", label: "装饰、清洁与储物 — 12/14/18%", rates: [12, 14, 18] },
    { value: "住宅和花园", label: "住宅和花园 — 12/14/20%", rates: [12, 14, 20] },
    { value: "汽车用品", label: "汽车用品 — 12/17/17%", rates: [12, 17, 17] },
    { value: "手动工具和测量仪器", label: "手动工具和测量仪器 — 12/17/17%", rates: [12, 17, 17] },
    { value: "建筑和装修", label: "建筑和装修 — 12/18/18%", rates: [12, 18, 18] },
    { value: "康复设备", label: "康复设备 — 12/14/17%", rates: [12, 14, 17] },
    { value: "重型建筑", label: "重型建筑 — 11/11/11%", rates: [11, 11, 11] },
    { value: "儿童餐具", label: "儿童餐具 — 12/14/18%", rates: [12, 14, 18] },
    { value: "家具", label: "家具 — 10/10/10%", rates: [10, 10, 10] },
    { value: "轮胎", label: "轮胎 — 10/10/10%", rates: [10, 10, 10] },
    { value: "装饰材料", label: "装饰材料 — 12/14/14%", rates: [12, 14, 14] },
    { value: "卫浴设备", label: "卫浴设备 — 12/14/14%", rates: [12, 14, 14] },
    { value: "日化", label: "日化 — 12/18/18%", rates: [12, 18, 18] },
    { value: "建筑、装修和园艺设备", label: "建筑、装修和园艺设备 — 12/16/16%", rates: [12, 16, 16] },
    { value: "新年装饰用品", label: "新年装饰用品 — 12/14/20%", rates: [12, 14, 20] },
    { value: "电动滑板车", label: "电动滑板车 — 12/17/17%", rates: [12, 17, 17] },
    { value: "船只、马达和充气艇", label: "船只、马达和充气艇 — 12/15/15%", rates: [12, 15, 15] },
    { value: "自行车", label: "自行车 — 12/15/15%", rates: [12, 15, 15] },
    { value: "水过滤器", label: "水过滤器 — 12/17/17%", rates: [12, 17, 17] },
    { value: "运动手表", label: "运动手表 — 12/12/12%", rates: [12, 12, 12] },
    { value: "成品房", label: "成品房 — 12/14.5/14.5%", rates: [12, 14.5, 14.5] },
    { value: "汽车、汽车房和特种设备", label: "汽车、汽车房和特种设备 — 10/10/10%", rates: [10, 10, 10] },
    { value: "服装和配饰", label: "服装和配饰 — 12/14/20.5%", rates: [12, 14, 20.5] },
    { value: "鞋类", label: "鞋类 — 12/12/12%", rates: [12, 12, 12] },
    { value: "美容与健康", label: "美容与健康 — 12/14/18%", rates: [12, 14, 18] },
    { value: "专业口腔护理", label: "专业口腔护理 — 12/17/17%", rates: [12, 17, 17] },
    { value: "外衣", label: "外衣 — 10/10/10%", rates: [10, 10, 10] },
    { value: "专业医疗设备", label: "专业医疗设备 — 12/17/17%", rates: [12, 17, 17] },
    { value: "包装袋", label: "包装袋 — 10/10/10%", rates: [10, 10, 10] },
    { value: "儿童纺织品", label: "儿童纺织品 — 12/19/19%", rates: [12, 19, 19] },
    { value: "儿童运动用品", label: "儿童运动用品 — 12/14/14%", rates: [12, 14, 14] },
    { value: "儿童电子产品、家具、配件", label: "儿童电子产品、家具、配件 — 12/14/20%", rates: [12, 14, 20] },
    { value: "玩具", label: "玩具 — 12/14/17.5%", rates: [12, 14, 17.5] },
    { value: "儿童卫生用品", label: "儿童卫生用品 — 12/18/18%", rates: [12, 18, 18] },
    { value: "婴儿推车和汽车安全座椅", label: "婴儿推车和汽车安全座椅 — 12/14/20%", rates: [12, 14, 20] },
    { value: "宠物饲料与农场用品", label: "宠物饲料与农场用品 — 12/13/13%", rates: [12, 13, 13] },
    { value: "宠物用品", label: "宠物用品 — 12/14/15%", rates: [12, 14, 15] },
    { value: "宠物卫生与护理", label: "宠物卫生与护理 — 12/13/13%", rates: [12, 13, 13] },
    { value: "食品", label: "食品 — 11/11/11%", rates: [11, 11, 11] },
    { value: "新鲜食品", label: "新鲜食品 — 11/11/11%", rates: [11, 11, 11] },
    { value: "个人卫生用品", label: "个人卫生用品 — 12/18/18%", rates: [12, 18, 18] },
    { value: "隐形眼镜", label: "隐形眼镜 — 12/18/18%", rates: [12, 18, 18] },
    { value: "运动和休闲用品", label: "运动和休闲用品 — 12/19/19%", rates: [12, 19, 19] },
    { value: "兴趣、创意与文具", label: "兴趣、创意与文具 — 12/14/16%", rates: [12, 14, 16] },
    { value: "书籍", label: "书籍 — 12/22/22%", rates: [12, 22, 22] },
    { value: "蹦床、游泳池和立式桨板", label: "蹦床、游泳池和立式桨板 — 12/16/16%", rates: [12, 16, 16] },
    { value: "运动营养", label: "运动营养 — 12/15/15%", rates: [12, 15, 15] },
    { value: "运动员营养补充剂", label: "运动员营养补充剂 — 12/18/18%", rates: [12, 18, 18] },
    { value: "电子产品配饰", label: "电子产品配饰 — 12/20/20%", rates: [12, 20, 20] },
    { value: "音频和视频设备配件", label: "音频和视频设备配件 — 12/14.5/14.5%", rates: [12, 14.5, 14.5] },
    { value: "家用电器", label: "家用电器 — 10/10/10%", rates: [10, 10, 10] },
    { value: "电视机", label: "电视机 — 9/9/9%", rates: [9, 9, 9] },
    { value: "美容设备", label: "美容设备 — 12/14/16%", rates: [12, 14, 16] },
    { value: "办公电脑设备、收银及仓储设备", label: "办公电脑设备、收银及仓储设备 — 12/16/16%", rates: [12, 16, 16] },
    { value: "游戏主机及配件、摄影器材", label: "游戏主机及配件、摄影器材 — 12/12.5/12.5%", rates: [12, 12.5, 12.5] },
    { value: "电脑外设设备及耗材", label: "电脑外设设备及耗材 — 12/14.5/14.5%", rates: [12, 14.5, 14.5] },
    { value: "非内置式大型家用电器", label: "非内置式大型家用电器 — 9/9/9%", rates: [9, 9, 9] },
    { value: "智能手机和平板电脑", label: "智能手机和平板电脑 — 11.5/11.5/11.5%", rates: [11.5, 11.5, 11.5] },
    { value: "电脑及笔记本配件", label: "电脑及笔记本配件 — 12/12.5/12.5%", rates: [12, 12.5, 12.5] },
    { value: "Yandex 智能音箱", label: "Yandex 智能音箱 — 12/14.5/14.5%", rates: [12, 14.5, 14.5] },
    { value: "嵌入式大型家用电器", label: "嵌入式大型家用电器 — 9/9/9%", rates: [9, 9, 9] },
    { value: "显示器", label: "显示器 — 12/12.5/12.5%", rates: [12, 12.5, 12.5] },
    { value: "智能手表与健身手环", label: "智能手表与健身手环 — 11.5/11.5/11.5%", rates: [11.5, 11.5, 11.5] },
    { value: "电子游戏", label: "电子游戏 — 12/14.5/14.5%", rates: [12, 14.5, 14.5] },
    { value: "台式电脑", label: "台式电脑 — 9/9/9%", rates: [9, 9, 9] },
    { value: "电脑设备配件", label: "电脑设备配件 — 12/13.5/13.5%", rates: [12, 13.5, 13.5] },
    { value: "笔记本电脑", label: "笔记本电脑 — 8/8/8%", rates: [8, 8, 8] },
    { value: "戴森配件", label: "戴森配件 — 6/6/6%", rates: [6, 6, 6] },
    { value: "索尼耳机", label: "索尼耳机 — 8/8/8%", rates: [8, 8, 8] },
    { value: "三星 TWS 耳机", label: "三星 TWS 耳机 — 8/8/8%", rates: [8, 8, 8] },
    { value: "三星智能手表与健身手环", label: "三星智能手表与健身手环 — 8/8/8%", rates: [8, 8, 8] },
    { value: "三星智能手机和平板电脑", label: "三星智能手机和平板电脑 — 8/8/8%", rates: [8, 8, 8] },
    { value: "苹果设备", label: "苹果设备 — 7/7/7%", rates: [7, 7, 7] },
    { value: "戴森设备", label: "戴森设备 — 8/8/8%", rates: [8, 8, 8] },
  ];

  /**
   * 按价格档取佣金率:priceRub ≤1500→档0,1501-5000→档1,>5000→档2。
   * rates = [t0,t1,t2](百分数);priceRub<=0(未知)按档0。无小单保护。
   */
  function _commissionRateForRub(rates, priceRub) {
    const t = (rates && rates.length) ? rates : _CALC_DEFAULT_RATES;
    const i = !(priceRub > 0) ? 0 : (priceRub <= 1500 ? 0 : (priceRub <= 5000 ? 1 : 2));
    return t[Math.min(i, t.length - 1)] || t[0] || 0;
  }

  /**
   * 定价标签页:售价由成本反推,而费率又取决于售价档位 → 自洽求解。
   * 暴力试 3 个价格档:用档 i 的费率反推售价,若反推出的 priceRub 恰好落在档 i 的区间
   * (≤1500 / 1501-5000 / >5000),即为自洽解。非单调/无自洽解时,退回"基础档估价定档"。
   * otherDeductPct = 广告+提现+退货率之和(%);marginPct = 毛利(%);totalCostCny = 固定成本合计。
   */
  function _pricingCommissionRate(rates, otherDeductPct, marginPct, totalCostCny, rubPerCny) {
    const t = (rates && rates.length) ? rates : _CALC_DEFAULT_RATES;
    const rub = rubPerCny > 0 ? rubPerCny : 11.08;
    for (let i = 0; i < 3; i++) {
      const r = t[Math.min(i, t.length - 1)];
      const den = 1 - (r + otherDeductPct) / 100 - marginPct / 100;
      if (!(den > 0.01)) continue;
      const priceRub = (totalCostCny / den) * rub;
      const inBand = i === 0 ? priceRub <= 1500 : (i === 1 ? (priceRub > 1500 && priceRub <= 5000) : priceRub > 5000);
      if (inBand) return r;
    }
    // 兜底:用基础档估出售价再定档
    const r0 = t[0];
    const den0 = 1 - (r0 + otherDeductPct) / 100 - marginPct / 100;
    const est = den0 > 0.01 ? (totalCostCny / den0) * rub : 0;
    return _commissionRateForRub(t, est);
  }

  const _CALC_XY_LOGISTICS = [
    { label: 'XY Standard XS (≤500g)', value: 'xs', costCny: 3, maxWeight: 500 },
    { label: 'XY Standard S (≤1000g)', value: 's', costCny: 6, maxWeight: 1000 },
    { label: 'XY Standard M (≤2000g)', value: 'm', costCny: 12, maxWeight: 2000 },
    { label: 'XY Standard L (≤5000g)', value: 'l', costCny: 30, maxWeight: 5000 },
    { label: 'XY Standard XL (≤10000g)', value: 'xl', costCny: 60, maxWeight: 10000 },
  ];

  const _CALC_PROFIT_LOGISTICS = [
    { label: 'GUOO', value: 'guoo', type: 'per_kg', ratePerKg: 55 },
    { label: 'OZON XY Standard', value: 'ozon_xy', type: 'tier', tiers: [
      { maxWeight: 500, cost: 3 }, { maxWeight: 1000, cost: 6 },
      { maxWeight: 2000, cost: 12 }, { maxWeight: 5000, cost: 30 },
      { maxWeight: 10000, cost: 60 },
    ]},
    { label: 'CAINIAO 菜鸟', value: 'cainiao', type: 'per_kg', ratePerKg: 48 },
    { label: '自定义费率', value: 'custom', type: 'per_kg', ratePerKg: 0 },
  ];

  const _CALC_DEFAULT_EXCHANGE = 11.97;

  function _calcProfitLogisticsCost(provider, weightG) {
    if (!provider || weightG <= 0) return 0;
    if (provider.type === 'tier' && provider.tiers) {
      const tier = provider.tiers.find(t => weightG <= t.maxWeight);
      return tier ? tier.cost : provider.tiers[provider.tiers.length - 1].cost;
    }
    return (weightG / 1000) * (provider.ratePerKg || 0);
  }

  function _fmtCny(v) { return '¥ ' + v.toFixed(2); }

  function _buildCommissionOptions(selected) {
    return _CALC_COMMISSIONS.map(c =>
      `<option value="${c.value}" ${c.value === selected ? 'selected' : ''}>${_escHtml(c.label)}</option>`
    ).join('');
  }

  function _buildRemoteCommissionOptions(config, selected) {
    const grouped = new Map();
    for (const rule of config?.commissionRules || []) {
      const categoryId = String(rule.ozonCategoryId || '*');
      const key = `${categoryId}|${String(rule.fulfillmentType || 'RFBS')}`;
      if (!grouped.has(key)) grouped.set(key, { categoryId, fulfillmentType: rule.fulfillmentType || 'RFBS', name: rule.ruleName || `类目 ${categoryId}`, rules: [] });
      grouped.get(key).rules.push(rule);
    }
    if (!grouped.size) return _buildCommissionOptions(selected);
    return [...grouped.values()].map((group) => {
      const rates = group.rules.sort((a, b) => Number(a.minPriceRub || 0) - Number(b.minPriceRub || 0)).map((rule) => Number(rule.commissionRate || 0)).join('/');
      const value = `${group.categoryId}|${group.fulfillmentType}`;
      return `<option value="${_escHtml(value)}" ${value === selected ? 'selected' : ''}>${_escHtml(`${group.name} · ${rates}%`)}</option>`;
    }).join('');
  }

  function _remoteLogisticsOptions(config, selected) {
    const providers = [...new Set((config?.logisticsRules || []).map((rule) => String(rule.provider || '').trim()).filter(Boolean))];
    if (!providers.length) return null;
    return providers.map((provider) => `<option value="${_escHtml(provider)}" ${provider === selected ? 'selected' : ''}>${_escHtml(provider)}</option>`).join('');
  }

  // ─── Create Tabbed Panel ───────────────────────────────
  async function createProfitPanel() {
    let panel = document.querySelector('.ozon-helper-profit-panel');
    if (panel) return panel;

    const settings = await _loadCalcSettings();
    let remoteConfig = null;
    try {
      const firstResponse = await window.sendMessage('getPricingConfig', {});
      const firstPayload = firstResponse?.data || firstResponse || {};
      const scope = firstPayload.cacheScope;
      const cache = globalThis.JzPricingConfigCache?.createPricingConfigCache({
        read: async (key) => new Promise((resolve) => chrome.storage.local.get([key], (value) => resolve(value?.[key]))),
        write: async (key, value) => new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve)),
      });
      if (!cache || !scope?.backendOrigin || !scope?.accountId || !scope?.storeId) throw new Error('PRICING_CONFIG_UNAVAILABLE');
      remoteConfig = await cache.load(scope, async () => firstPayload.config || null);
    } catch (_) {
      // No scope or no fresh same-scope cache is a hard miss: never reuse another store's pricing rules.
      remoteConfig = null;
    }
    const pricingDefaults = remoteConfig?.defaults || {};
    const remoteExchangeRate = Number(remoteConfig?.exchangeRate?.rate || 0) || _CALC_DEFAULT_EXCHANGE;
    const remoteCommissionSelection = settings.pIndustry && String(settings.pIndustry).includes('|')
      ? settings.pIndustry
      : `${remoteConfig?.commissionRules?.[0]?.ozonCategoryId || '*'}|${remoteConfig?.commissionRules?.[0]?.fulfillmentType || 'RFBS'}`;
    const remoteProviders = [...new Set((remoteConfig?.logisticsRules || []).map((rule) => String(rule.provider || '').trim()).filter(Boolean))];
    const product = extractProductData();
    const chars = extractCharacteristics();
    // Try to find weight from characteristics (name contains "вес" or "weight" or "масса")
    let pageWeight = 0;
    if (Array.isArray(chars)) {
      for (const c of chars) {
        const n = (c.name || '').toLowerCase();
        if (n.includes('вес') || n.includes('weight') || n.includes('масса')) {
          const v = parseFloat(String(c.value).replace(/[^\d.,]/g, '').replace(',', '.'));
          if (v > 0) {
            // If unit is "кг" or "kg", convert to grams
            const isKg = n.includes('кг') || n.includes('kg') || (c.value || '').toLowerCase().includes('кг');
            pageWeight = isKg ? Math.round(v * 1000) : Math.round(v);
            break;
          }
        }
      }
    }
    const pagePrice = product?.price || 0;

    panel = document.createElement('div');
    panel.className = 'ozon-helper-panel ozon-helper-profit-panel';
    panel.__sonliPricingConfig = remoteConfig;

    const _calcBrand = globalThis.__JZ_BRAND__;
    const _calcMark = _calcBrand.logoUrl
      ? `<span class="ozon-helper-calc-brand-mark"><img src="${_calcBrand.logoUrl}" alt=""></span>`
      : `<span class="ozon-helper-calc-brand-mark">${_calcBrand.displayName[0]}</span>`;
    panel.innerHTML = `
      <div class="ozon-helper-panel-header ozon-helper-calc-header">
        <div class="ozon-helper-calc-brand-row">
          ${_calcMark}
          <span class="ozon-helper-calc-brand-name">${_calcBrand.displayName}算价</span>
          <span class="ozon-helper-calc-brand-sub">定价 · 利润 · ${remoteConfig?.id ? `配置 V${remoteConfig.versionNo}` : '本地备用公式'}</span>
          <span class="ozon-helper-calc-brand-spacer"></span>
          <button class="ozon-helper-close-btn" data-action="close">&times;</button>
        </div>
        <div class="ozon-helper-calc-tabs">
          <button class="ozon-helper-calc-tab is-active" data-tab="pricing">定价精灵</button>
          <button class="ozon-helper-calc-tab" data-tab="profit">利润计算</button>
        </div>
      </div>
      <div class="ozon-helper-panel-content">

        <!-- ══ TAB: 定价精灵 ══ -->
        <div class="ozon-helper-calc-page is-active" data-page="pricing">
          <div class="ozon-helper-calc-section-title">基础设置</div>

          <div class="ozon-helper-calc-row">
            <label>所属行业</label>
            <div class="ozon-helper-calc-field">
              <select data-pf="p-industry">${remoteConfig ? _buildRemoteCommissionOptions(remoteConfig, remoteCommissionSelection) : _buildCommissionOptions(settings.pIndustry || '美容与健康')}</select>
            </div>
          </div>
          <div class="ozon-helper-calc-row">
            <label>采购成本</label>
            <div class="ozon-helper-calc-field">
              <input type="number" min="0" step="0.01" data-pf="p-purchase" value="0" />
              <span class="ozon-helper-calc-unit">元</span>
            </div>
          </div>
          <div class="ozon-helper-calc-row">
            <label>包裹重量</label>
            <div class="ozon-helper-calc-field">
              <input type="number" min="0" step="1" data-pf="p-weight" value="${pageWeight || 0}" />
              <span class="ozon-helper-calc-unit">g</span>
            </div>
          </div>
          <div class="ozon-helper-calc-inline">
            <div class="ozon-helper-calc-row">
              <label>毛利</label>
              <div class="ozon-helper-calc-field">
                <input type="number" min="0" max="99" step="1" data-pf="p-margin" value="${settings.pMargin ?? pricingDefaults.targetMarginRate ?? 20}" />
                <span class="ozon-helper-calc-unit">%</span>
              </div>
            </div>
            <div class="ozon-helper-calc-row">
              <label>前台折扣</label>
              <div class="ozon-helper-calc-field">
                <input type="number" min="1" max="100" step="1" data-pf="p-discount" value="${settings.pDiscount ?? pricingDefaults.frontendDiscountRate ?? 50}" />
                <span class="ozon-helper-calc-unit">%</span>
              </div>
            </div>
          </div>

          <div class="ozon-helper-calc-toggle" data-action="toggle-pricing-more">▾ 更多设置</div>
          <div data-section="pricing-more" style="display:none;">
            <div class="ozon-helper-calc-row">
              <label>境内段运费</label>
              <div class="ozon-helper-calc-field">
                <input type="number" min="0" step="0.01" data-pf="p-domestic" value="0" />
                <span class="ozon-helper-calc-unit">元</span>
              </div>
            </div>
            <div class="ozon-helper-calc-row">
              <label>物流方式</label>
              <div class="ozon-helper-calc-field">
                <select data-pf="p-logistics">
                  ${_remoteLogisticsOptions(remoteConfig, settings.pLogistics || remoteProviders[0] || 'XY') || _CALC_XY_LOGISTICS.map(l => `<option value="${l.value}" ${l.value === (settings.pLogistics || 'xs') ? 'selected' : ''}>${_escHtml(l.label)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="ozon-helper-calc-inline">
              <div class="ozon-helper-calc-row">
                <label>广告费</label>
                <div class="ozon-helper-calc-field">
                  <input type="number" min="0" max="100" step="1" data-pf="p-ad" value="${settings.pAd ?? pricingDefaults.adRate ?? 0}" />
                  <span class="ozon-helper-calc-unit">%</span>
                </div>
              </div>
              <div class="ozon-helper-calc-row">
                <label>提现费</label>
                <div class="ozon-helper-calc-field">
                  <input type="number" min="0" max="100" step="1" data-pf="p-withdraw" value="${settings.pWithdraw ?? pricingDefaults.withdrawalRate ?? 3}" />
                  <span class="ozon-helper-calc-unit">%</span>
                </div>
              </div>
            </div>
            <div class="ozon-helper-calc-inline">
              <div class="ozon-helper-calc-row">
                <label>退货率</label>
                <div class="ozon-helper-calc-field">
                  <input type="number" min="0" max="100" step="1" data-pf="p-return" value="${settings.pReturn ?? pricingDefaults.returnLossRate ?? 2}" />
                  <span class="ozon-helper-calc-unit">%</span>
                </div>
              </div>
              <div class="ozon-helper-calc-row">
                <label>其他费用</label>
                <div class="ozon-helper-calc-field">
                  <input type="number" min="0" step="0.01" data-pf="p-other" value="0" />
                  <span class="ozon-helper-calc-unit">元</span>
                </div>
              </div>
            </div>
          </div>

          <div class="ozon-helper-divider"></div>

          <div class="ozon-helper-calc-section-title">计算结果</div>
          <div class="ozon-helper-calc-dual-result">
            <div class="ozon-helper-calc-result-card">
              <div class="ozon-helper-calc-result-label">商品原价（折前）</div>
              <div class="ozon-helper-calc-result-big is-muted" data-pf="r-before">--</div>
              <div class="ozon-helper-calc-result-sub" data-pf="r-before-rub"></div>
            </div>
            <div class="ozon-helper-calc-result-card">
              <div class="ozon-helper-calc-result-label">商品售价（折后）</div>
              <div class="ozon-helper-calc-result-big is-muted" data-pf="r-after">--</div>
              <div class="ozon-helper-calc-result-sub" data-pf="r-after-rub"></div>
            </div>
          </div>
          <div class="ozon-helper-calc-result-card" style="padding:10px 16px;">
            <div style="display:flex;justify-content:space-around;">
              <div>
                <div class="ozon-helper-calc-result-label">毛利</div>
                <div style="font-weight:700;color:var(--oh-green);font-size:16px;" data-pf="r-gross">--</div>
              </div>
              <div>
                <div class="ozon-helper-calc-result-label">毛利率</div>
                <div style="font-weight:600;font-size:16px;" data-pf="r-margin-pct">--</div>
              </div>
            </div>
          </div>

          <div class="ozon-helper-calc-toggle" data-action="toggle-pricing-detail">▾ 计算明细</div>
          <div data-section="pricing-detail" style="display:none;">
            <div class="ozon-helper-calc-detail-list">
              <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">采购成本</span><span class="ozon-helper-calc-detail-value" data-pf="d-purchase">--</span></div>
              <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">境内段运费</span><span class="ozon-helper-calc-detail-value" data-pf="d-domestic">--</span></div>
              <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">跨境物流费</span><span class="ozon-helper-calc-detail-value" data-pf="d-logistics">--</span></div>
              <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">平台佣金</span><span class="ozon-helper-calc-detail-value" data-pf="d-commission">--</span></div>
              <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">广告费</span><span class="ozon-helper-calc-detail-value" data-pf="d-ad">--</span></div>
              <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">提现手续费</span><span class="ozon-helper-calc-detail-value" data-pf="d-withdraw">--</span></div>
              <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">退货损失</span><span class="ozon-helper-calc-detail-value" data-pf="d-return">--</span></div>
              <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">其他费用</span><span class="ozon-helper-calc-detail-value" data-pf="d-other">--</span></div>
            </div>
          </div>

          <div class="ozon-helper-calc-note">
            汇率：1 CNY ≈ 11.08 RUB ≈ 0.14 USD
          </div>
        </div>

        <!-- ══ TAB: 利润计算 ══ -->
        <div class="ozon-helper-calc-page" data-page="profit">
          <div class="ozon-helper-calc-section-title">基础设置</div>

          <div class="ozon-helper-calc-row">
            <label>售价</label>
            <div class="ozon-helper-calc-field">
              <input type="number" min="0" step="0.01" data-pf="lp-price" value="${pagePrice > 0 ? (pagePrice / _CALC_DEFAULT_EXCHANGE).toFixed(2) : '0'}" />
              <span class="ozon-helper-calc-unit">元</span>
            </div>
          </div>
          <div class="ozon-helper-calc-row">
            <label>采购成本</label>
            <div class="ozon-helper-calc-field">
              <input type="number" min="0" step="0.01" data-pf="lp-purchase" value="0" />
              <span class="ozon-helper-calc-unit">元</span>
            </div>
          </div>
          <div class="ozon-helper-calc-row">
            <label>类目佣金</label>
            <div class="ozon-helper-calc-field">
              <select data-pf="lp-commission">${remoteConfig ? _buildRemoteCommissionOptions(remoteConfig, settings.lpCommission || remoteCommissionSelection) : _buildCommissionOptions(settings.lpCommission || '美容与健康')}</select>
            </div>
          </div>
          <div class="ozon-helper-calc-row">
            <label>包裹重量</label>
            <div class="ozon-helper-calc-field">
              <input type="number" min="0" step="1" data-pf="lp-weight" value="${pageWeight || 50}" />
              <span class="ozon-helper-calc-unit">g</span>
            </div>
          </div>
          <div class="ozon-helper-calc-row">
            <label>跨境物流商</label>
            <div class="ozon-helper-calc-field">
              <select data-pf="lp-logistics">
                ${_remoteLogisticsOptions(remoteConfig, settings.lpLogistics || remoteProviders[0] || 'GUOO') || _CALC_PROFIT_LOGISTICS.map(p => `<option value="${p.value}" ${p.value === (settings.lpLogistics || 'guoo') ? 'selected' : ''}>${_escHtml(p.label)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="ozon-helper-calc-row" data-section="lp-custom-rate" style="display:${(settings.lpLogistics || 'guoo') === 'custom' ? 'flex' : 'none'};">
            <label>自定义费率</label>
            <div class="ozon-helper-calc-field">
              <input type="number" min="0" step="0.01" data-pf="lp-custom-rate" value="0" />
              <span class="ozon-helper-calc-unit">元/kg</span>
            </div>
          </div>

          <div class="ozon-helper-calc-section-title">其它设置</div>

          <div class="ozon-helper-calc-row">
            <label>国内运费+代贴</label>
            <div class="ozon-helper-calc-field">
              <input type="number" min="0" step="0.01" data-pf="lp-domestic" value="0" />
              <span class="ozon-helper-calc-unit">元</span>
            </div>
          </div>
          <div class="ozon-helper-calc-inline">
            <div class="ozon-helper-calc-row">
              <label>广告费</label>
              <div class="ozon-helper-calc-field">
                <input type="number" min="0" max="100" step="1" data-pf="lp-ad" value="${settings.lpAd ?? pricingDefaults.adRate ?? 0}" />
                <span class="ozon-helper-calc-unit">%</span>
              </div>
            </div>
            <div class="ozon-helper-calc-row">
              <label>其他</label>
              <div class="ozon-helper-calc-field">
                <input type="number" min="0" max="100" step="1" data-pf="lp-other" value="${settings.lpOther ?? 1}" />
                <span class="ozon-helper-calc-unit">%</span>
              </div>
            </div>
          </div>

          <div class="ozon-helper-calc-row">
            <label>汇率</label>
            <div class="ozon-helper-calc-field">
              <span class="ozon-helper-calc-unit">¥1 =</span>
              <input type="number" min="0" step="0.01" data-pf="lp-exchange" value="${settings.lpExchange || remoteExchangeRate}" />
              <span class="ozon-helper-calc-unit">₽</span>
            </div>
          </div>

          <div class="ozon-helper-divider"></div>

          <div class="ozon-helper-calc-section-title">计算结果</div>
          <div class="ozon-helper-calc-result-card">
            <div class="ozon-helper-calc-result-label">利润</div>
            <div class="ozon-helper-calc-result-big is-muted" data-pf="lr-profit">--</div>
            <div class="ozon-helper-calc-result-sub" data-pf="lr-margin">利润率: --</div>
            <div class="ozon-helper-calc-result-sub" data-pf="lr-exchange-info"></div>
            <div class="ozon-helper-calc-result-sub" data-pf="lr-rub-ref"></div>
          </div>

          <div class="ozon-helper-calc-section-title">计算明细</div>
          <div class="ozon-helper-calc-detail-list">
            <div class="ozon-helper-calc-detail-item is-highlight"><span class="ozon-helper-calc-detail-label">利润（毛利）</span><span class="ozon-helper-calc-detail-value" data-pf="ld-profit">--</span></div>
            <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">采购成本</span><span class="ozon-helper-calc-detail-value" data-pf="ld-purchase">--</span></div>
            <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">平台佣金</span><span class="ozon-helper-calc-detail-value" data-pf="ld-commission">--</span></div>
            <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">跨境物流费</span><span class="ozon-helper-calc-detail-value" data-pf="ld-logistics">--</span></div>
            <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">国内运费+代贴</span><span class="ozon-helper-calc-detail-value" data-pf="ld-domestic">--</span></div>
            <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">广告费</span><span class="ozon-helper-calc-detail-value" data-pf="ld-ad">--</span></div>
            <div class="ozon-helper-calc-detail-item"><span class="ozon-helper-calc-detail-label">其他(提现/货损)</span><span class="ozon-helper-calc-detail-value" data-pf="ld-other">--</span></div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // ── Tab switching ──
    panel.querySelectorAll('.ozon-helper-calc-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        panel.querySelectorAll('.ozon-helper-calc-tab').forEach(t => t.classList.remove('is-active'));
        panel.querySelectorAll('.ozon-helper-calc-page').forEach(p => p.classList.remove('is-active'));
        tab.classList.add('is-active');
        const page = panel.querySelector(`[data-page="${tab.dataset.tab}"]`);
        if (page) page.classList.add('is-active');
        // Scroll content to top on tab switch
        const content = panel.querySelector('.ozon-helper-panel-content');
        if (content) content.scrollTop = 0;
        _recalcActiveTab(panel);
      });
    });

    // ── Close button ──
    panel.querySelector('[data-action="close"]').addEventListener('click', () => closePanel(panel));

    // ── Toggle sections ──
    panel.querySelectorAll('.ozon-helper-calc-toggle').forEach(toggle => {
      toggle.addEventListener('click', () => {
        const action = toggle.dataset.action;
        let sectionName = '';
        if (action === 'toggle-pricing-more') sectionName = 'pricing-more';
        else if (action === 'toggle-pricing-detail') sectionName = 'pricing-detail';
        const section = panel.querySelector(`[data-section="${sectionName}"]`);
        if (!section) return;
        const isOpen = section.style.display !== 'none';
        section.style.display = isOpen ? 'none' : '';
        toggle.textContent = isOpen ? `▾ ${toggle.textContent.slice(2)}` : `▴ ${toggle.textContent.slice(2)}`;
      });
    });

    // ── Show/hide custom logistics rate ──
    const lpLogisticsSelect = panel.querySelector('[data-pf="lp-logistics"]');
    if (lpLogisticsSelect) {
      lpLogisticsSelect.addEventListener('change', () => {
        const customRow = panel.querySelector('[data-section="lp-custom-rate"]');
        if (customRow) customRow.style.display = lpLogisticsSelect.value === 'custom' ? 'flex' : 'none';
      });
    }

    // ── Recalc on any input/change ──
    panel.addEventListener('input', () => _recalcActiveTab(panel));
    panel.addEventListener('change', () => _recalcActiveTab(panel));

    return panel;
  }

  // ─── Recalc Dispatcher ─────────────────────────────────
  function _recalcActiveTab(panel) {
    if (!panel) return;
    const activePage = panel.querySelector('.ozon-helper-calc-page.is-active');
    if (!activePage) return;
    if (activePage.dataset.page === 'pricing') _recalcPricing(panel);
    else if (activePage.dataset.page === 'profit') _recalcProfitCalc(panel);
    _saveCalcSettings(panel);
    _scheduleServerPricing(panel);
  }

  const _pricingServerTimers = new WeakMap();
  const _pricingServerSequences = new WeakMap();

  function _pricingSelection(panel, field) {
    const raw = String(panel.querySelector(`[data-pf="${field}"]`)?.value || '*|RFBS');
    const [categoryId, fulfillmentType] = raw.split('|');
    return { categoryId: categoryId || '*', fulfillmentType: fulfillmentType || 'RFBS' };
  }

  function _serverPricingInput(panel, mode) {
    const value = (field) => parseFloat(panel.querySelector(`[data-pf="${field}"]`)?.value) || 0;
    if (mode === 'pricing') {
      return {
        mode,
        ..._pricingSelection(panel, 'p-industry'),
        purchaseCostCny: value('p-purchase'),
        weightG: value('p-weight'),
        targetMarginRate: value('p-margin'),
        frontendDiscountRate: value('p-discount'),
        domesticShippingCny: value('p-domestic'),
        logisticsProvider: panel.querySelector('[data-pf="p-logistics"]')?.value || 'XY',
        adRate: value('p-ad'),
        withdrawalRate: value('p-withdraw'),
        returnLossRate: value('p-return'),
        otherFixedFeeCny: value('p-other'),
        configVersionId: panel.__sonliPricingConfig?.id || undefined,
      };
    }
    return {
      mode,
      ..._pricingSelection(panel, 'lp-commission'),
      sellingPriceCny: value('lp-price'),
      purchaseCostCny: value('lp-purchase'),
      weightG: value('lp-weight'),
      logisticsProvider: panel.querySelector('[data-pf="lp-logistics"]')?.value || 'GUOO',
      domesticShippingCny: value('lp-domestic'),
      adRate: value('lp-ad'),
      otherFeeRate: value('lp-other'),
      exchangeRate: value('lp-exchange'),
      configVersionId: panel.__sonliPricingConfig?.id || undefined,
    };
  }

  function _setServerPricingStatus(panel, text, isError = false) {
    const target = panel.querySelector('.ozon-helper-calc-brand-sub');
    if (!target) return;
    target.textContent = text;
    target.style.color = isError ? 'var(--oh-red)' : '';
  }

  function _applyServerPricingResult(panel, result) {
    const field = (name) => panel.querySelector(`[data-pf="${name}"]`);
    const setMoney = (name, value) => { const el = field(name); if (el) el.textContent = _fmtCny(Number(value || 0)); };
    if (result.mode === 'pricing') {
      setMoney('r-before', result.originalPriceCny);
      setMoney('r-after', result.sellingPriceCny);
      setMoney('r-gross', result.netProfitCny);
      const margin = field('r-margin-pct');
      if (margin) margin.textContent = `${Number(result.profitMarginRate || 0).toFixed(2)}%`;
      const beforeRub = field('r-before-rub');
      const afterRub = field('r-after-rub');
      if (beforeRub) beforeRub.textContent = `₽ ${Number(result.originalPriceRub || 0).toFixed(2)}`;
      if (afterRub) afterRub.textContent = `₽ ${Number(result.sellingPriceRub || 0).toFixed(2)}`;
      setMoney('d-purchase', result.purchaseCostCny);
      setMoney('d-domestic', Number(result.domestic?.domesticShippingCny || 0) + Number(result.domestic?.labelingFeeCny || 0) + Number(result.domestic?.packagingFeeCny || 0) + Number(result.domestic?.operationFeeCny || 0));
      setMoney('d-logistics', result.logistics?.amount);
      setMoney('d-commission', result.commissionFeeCny);
      setMoney('d-ad', result.adFeeCny);
      setMoney('d-withdraw', result.withdrawalFeeCny);
      setMoney('d-return', result.returnLossCny);
      setMoney('d-other', Number(result.otherVariableFeeCny || 0));
    } else {
      setMoney('lr-profit', result.netProfitCny);
      const margin = field('lr-margin');
      if (margin) margin.innerHTML = `利润率: <span style="font-weight:600;">${Number(result.profitMarginRate || 0).toFixed(2)}%</span>`;
      const exchange = field('lr-exchange-info');
      if (exchange) exchange.textContent = `当前汇率: ¥1 = ₽${result.exchangeRate}`;
      const rub = field('lr-rub-ref');
      if (rub) rub.textContent = `售价约 ₽${Number(result.sellingPriceRub || 0).toFixed(2)} | 利润约 ₽${(Number(result.netProfitCny || 0) * Number(result.exchangeRate || 0)).toFixed(2)}`;
      setMoney('ld-profit', result.netProfitCny);
      setMoney('ld-purchase', result.purchaseCostCny);
      setMoney('ld-commission', result.commissionFeeCny);
      setMoney('ld-logistics', result.logistics?.amount);
      setMoney('ld-domestic', Number(result.domestic?.domesticShippingCny || 0) + Number(result.domestic?.labelingFeeCny || 0) + Number(result.domestic?.packagingFeeCny || 0) + Number(result.domestic?.operationFeeCny || 0));
      setMoney('ld-ad', result.adFeeCny);
      setMoney('ld-other', Number(result.otherVariableFeeCny || 0) + Number(result.withdrawalFeeCny || 0) + Number(result.returnLossCny || 0));
    }
    _setServerPricingStatus(panel, `服务端配置 V${result.configVersionNo} · ${result.commissionRate}% 佣金`);
  }

  function _scheduleServerPricing(panel) {
    if (!panel?.__sonliPricingConfig?.id || typeof window.sendMessage !== 'function') return;
    const currentTimer = _pricingServerTimers.get(panel);
    if (currentTimer) clearTimeout(currentTimer);
    const timer = setTimeout(async () => {
      const activePage = panel.querySelector('.ozon-helper-calc-page.is-active');
      const mode = activePage?.dataset.page === 'pricing' ? 'pricing' : 'profit';
      const input = _serverPricingInput(panel, mode);
      if (mode === 'pricing' && !(input.purchaseCostCny > 0)) return;
      if (mode === 'profit' && !(input.sellingPriceCny > 0)) return;
      const sequence = (_pricingServerSequences.get(panel) || 0) + 1;
      _pricingServerSequences.set(panel, sequence);
      _setServerPricingStatus(panel, `配置 V${panel.__sonliPricingConfig.versionNo} · 计算中…`);
      try {
        const response = await window.sendMessage('calculatePricing', { input });
        if (_pricingServerSequences.get(panel) !== sequence) return;
        const result = response?.result || response?.data?.result;
        if (result) _applyServerPricingResult(panel, result);
      } catch (error) {
        if (_pricingServerSequences.get(panel) !== sequence) return;
        _setServerPricingStatus(panel, `服务端计算失败，暂用本地结果：${error?.message || error}`, true);
      }
    }, 250);
    _pricingServerTimers.set(panel, timer);
  }

  // ─── Pricing Tab Calculation ───────────────────────────
  function _recalcPricing(panel) {
    const _v = (sel) => parseFloat(panel.querySelector(`[data-pf="${sel}"]`)?.value) || 0;
    const _el = (sel) => panel.querySelector(`[data-pf="${sel}"]`);

    const industryVal = panel.querySelector('[data-pf="p-industry"]')?.value || '';
    const commissionRates = _CALC_COMMISSIONS.find(c => c.value === industryVal)?.rates || _CALC_DEFAULT_RATES;
    const purchaseCost = _v('p-purchase');
    const grossMargin = _v('p-margin');
    const frontEndDiscount = _v('p-discount') || 50;
    const domesticShipping = _v('p-domestic');
    const logisticsVal = panel.querySelector('[data-pf="p-logistics"]')?.value || 'xs';
    const logisticsCostCny = _CALC_XY_LOGISTICS.find(l => l.value === logisticsVal)?.costCny || 3;
    const adFeeRate = _v('p-ad');
    const withdrawFeeRate = _v('p-withdraw');
    const returnRate = _v('p-return');
    const otherFees = _v('p-other');

    // 售价未知 → 自洽求解佣金价格档(避免一段式估价跨档取错费率,Codex P1)。
    // 折算 RUB 用 RATE_RUB(下方 11.08₽/¥)与展示一致。
    const _PRICING_RATE_RUB = 11.08;
    const _fixedCostCny = purchaseCost + domesticShipping + otherFees + logisticsCostCny;
    const commissionRate = _pricingCommissionRate(
      commissionRates,
      adFeeRate + withdrawFeeRate + returnRate,
      grossMargin,
      _fixedCostCny,
      _PRICING_RATE_RUB,
    );

    const totalCostCny = purchaseCost + domesticShipping + otherFees + logisticsCostCny;
    const deductionRate = (commissionRate + adFeeRate + withdrawFeeRate + returnRate) / 100;
    const marginRate = grossMargin / 100;
    const denominator = 1 - deductionRate - marginRate;

    let afterDiscountCny = 0;
    if (denominator > 0.01) afterDiscountCny = totalCostCny / denominator;
    let beforeDiscountCny = 0;
    if (frontEndDiscount > 0 && frontEndDiscount <= 100) {
      beforeDiscountCny = afterDiscountCny / (frontEndDiscount / 100);
    }

    const grossProfitCny = afterDiscountCny * marginRate;
    const platformCommissionCny = afterDiscountCny * (commissionRate / 100);
    const adFeeCny = afterDiscountCny * (adFeeRate / 100);
    const withdrawFeeCny = afterDiscountCny * (withdrawFeeRate / 100);
    const returnLossCny = afterDiscountCny * (returnRate / 100);

    const hasInput = purchaseCost > 0;
    const RATE_RUB = 11.08;

    // Update results
    const beforeEl = _el('r-before');
    const afterEl = _el('r-after');
    if (beforeEl) {
      beforeEl.textContent = hasInput ? _fmtCny(beforeDiscountCny) : '--';
      beforeEl.className = 'ozon-helper-calc-result-big ' + (hasInput ? 'is-loss' : 'is-muted');
    }
    if (afterEl) {
      afterEl.textContent = hasInput ? _fmtCny(afterDiscountCny) : '--';
      afterEl.className = 'ozon-helper-calc-result-big ' + (hasInput ? 'is-loss' : 'is-muted');
    }
    const beforeRubEl = _el('r-before-rub');
    const afterRubEl = _el('r-after-rub');
    if (beforeRubEl) beforeRubEl.textContent = hasInput ? `₽ ${(beforeDiscountCny * RATE_RUB).toFixed(2)}` : '';
    if (afterRubEl) afterRubEl.textContent = hasInput ? `₽ ${(afterDiscountCny * RATE_RUB).toFixed(2)}` : '';

    const grossEl = _el('r-gross');
    if (grossEl) {
      grossEl.textContent = hasInput ? _fmtCny(grossProfitCny) : '--';
      grossEl.style.color = grossProfitCny >= 0 ? 'var(--oh-green)' : 'var(--oh-red)';
    }
    const marginPctEl = _el('r-margin-pct');
    if (marginPctEl) marginPctEl.textContent = hasInput ? `${grossMargin}%` : '--';

    // Detail items
    const details = {
      'd-purchase': purchaseCost,
      'd-domestic': domesticShipping,
      'd-logistics': logisticsCostCny,
      'd-commission': platformCommissionCny,
      'd-ad': adFeeCny,
      'd-withdraw': withdrawFeeCny,
      'd-return': returnLossCny,
      'd-other': otherFees,
    };
    for (const [key, val] of Object.entries(details)) {
      const el = _el(key);
      if (el) el.textContent = hasInput ? _fmtCny(val) : '--';
    }
  }

  // ─── Profit Tab Calculation ────────────────────────────
  function _recalcProfitCalc(panel) {
    const _v = (sel) => parseFloat(panel.querySelector(`[data-pf="${sel}"]`)?.value) || 0;
    const _el = (sel) => panel.querySelector(`[data-pf="${sel}"]`);

    const sellingPrice = _v('lp-price');
    const purchaseCost = _v('lp-purchase');
    const commissionVal = panel.querySelector('[data-pf="lp-commission"]')?.value || '';
    const commissionRates = _CALC_COMMISSIONS.find(c => c.value === commissionVal)?.rates || _CALC_DEFAULT_RATES;
    const packageWeight = _v('lp-weight');
    const logisticsVal = panel.querySelector('[data-pf="lp-logistics"]')?.value || 'guoo';
    const customRate = _v('lp-custom-rate');
    const domesticShipping = _v('lp-domestic');
    const adFeeRate = _v('lp-ad');
    const otherFeeRate = _v('lp-other');
    const exchangeRate = _v('lp-exchange') || _CALC_DEFAULT_EXCHANGE;
    // 售价(CNY)折算 RUB 决定价格档:≤1500→档0,1501-5000→档1,>5000→档2。
    // 官方 2025-12-01 跨境表,无小单保护。
    const commissionRate = _commissionRateForRub(commissionRates, sellingPrice * (exchangeRate > 0 ? exchangeRate : 11.97));

    // Logistics cost
    let logisticsCost = 0;
    const provider = _CALC_PROFIT_LOGISTICS.find(p => p.value === logisticsVal);
    if (provider) {
      if (provider.value === 'custom') {
        logisticsCost = (packageWeight / 1000) * customRate;
      } else {
        logisticsCost = _calcProfitLogisticsCost(provider, packageWeight);
      }
    }

    const commission = sellingPrice * (commissionRate / 100);
    const adFee = sellingPrice * (adFeeRate / 100);
    const otherFee = sellingPrice * (otherFeeRate / 100);
    const profit = sellingPrice - purchaseCost - commission - logisticsCost - domesticShipping - adFee - otherFee;
    const profitMargin = sellingPrice > 0 ? (profit / sellingPrice) * 100 : 0;

    const hasInput = sellingPrice > 0;
    const isProfitable = profit >= 0;
    const colorClass = hasInput ? (isProfitable ? 'is-profit' : 'is-loss') : 'is-muted';

    // Result card
    const profitEl = _el('lr-profit');
    if (profitEl) {
      profitEl.textContent = hasInput ? _fmtCny(profit) : '--';
      profitEl.className = 'ozon-helper-calc-result-big ' + colorClass;
    }
    const marginEl = _el('lr-margin');
    if (marginEl) {
      marginEl.innerHTML = hasInput
        ? `利润率: <span style="color:${isProfitable ? 'var(--oh-green)' : 'var(--oh-red)'};font-weight:600;">${profitMargin.toFixed(2)}%</span>`
        : '利润率: --';
    }
    const exchangeInfoEl = _el('lr-exchange-info');
    if (exchangeInfoEl) {
      exchangeInfoEl.textContent = `当前汇率: ¥1 = ₽${exchangeRate}`;
    }
    const rubRefEl = _el('lr-rub-ref');
    if (rubRefEl) {
      rubRefEl.textContent = hasInput && exchangeRate > 0
        ? `售价约 ₽${(sellingPrice * exchangeRate).toFixed(2)} | 利润约 ₽${(profit * exchangeRate).toFixed(2)}`
        : '';
    }

    // Detail items
    const detailColor = (val, isProfit) => {
      if (!hasInput) return '';
      if (isProfit) return isProfitable ? 'var(--oh-green)' : 'var(--oh-red)';
      return 'var(--oh-red)';
    };

    const detailItems = {
      'ld-profit': { val: profit, isProfit: true },
      'ld-purchase': { val: purchaseCost },
      'ld-commission': { val: commission },
      'ld-logistics': { val: logisticsCost },
      'ld-domestic': { val: domesticShipping },
      'ld-ad': { val: adFee },
      'ld-other': { val: otherFee },
    };
    for (const [key, item] of Object.entries(detailItems)) {
      const el = _el(key);
      if (el) {
        el.textContent = hasInput ? _fmtCny(item.val) : '--';
        el.style.color = detailColor(item.val, item.isProfit);
      }
    }
  }

  // ─── Settings persistence ──────────────────────────────
  async function _loadCalcSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get(['calcSettings'], r => resolve(r.calcSettings || {}));
    });
  }

  function _saveCalcSettings(panel) {
    if (!panel) return;
    const _v = (sel) => panel.querySelector(`[data-pf="${sel}"]`)?.value ?? '';
    const settings = {
      pIndustry: _v('p-industry'),
      pMargin: parseFloat(_v('p-margin')) || 20,
      pDiscount: parseFloat(_v('p-discount')) || 50,
      pLogistics: _v('p-logistics'),
      pAd: parseFloat(_v('p-ad')) || 0,
      pWithdraw: parseFloat(_v('p-withdraw')) || 3,
      pReturn: parseFloat(_v('p-return')) || 2,
      lpCommission: _v('lp-commission'),
      lpLogistics: _v('lp-logistics'),
      lpAd: parseFloat(_v('lp-ad')) || 0,
      lpOther: parseFloat(_v('lp-other')) || 1,
      lpExchange: parseFloat(_v('lp-exchange')) || _CALC_DEFAULT_EXCHANGE,
    };
    chrome.storage.local.set({ calcSettings: settings });
  }

  async function loadBarPosition() {
    return new Promise(resolve =>
      chrome.storage.local.get(['actionBarPosition'], r => resolve(r.actionBarPosition || null))
    );
  }

  function saveBarPosition(pos) {
    chrome.storage.local.set({ actionBarPosition: pos });
  }

  async function loadBarCollapsed() {
    return new Promise(resolve =>
      chrome.storage.local.get(['actionBarCollapsed'], r => resolve(!!r.actionBarCollapsed))
    );
  }

  function saveBarCollapsed(collapsed) {
    chrome.storage.local.set({ actionBarCollapsed: !!collapsed });
  }

  function toggleBarCollapsed(bar) {
    const next = !bar.classList.contains('is-collapsed');
    bar.classList.toggle('is-collapsed', next);
    saveBarCollapsed(next);
    // 收起 / 展开会改变 bar 宽高,重新 clamp 位置防止溢出视口
    if (bar.style.left) {
      requestAnimationFrame(() => {
        const left = parseInt(bar.style.left);
        const top  = parseInt(bar.style.top);
        applyBarPosition(bar, { left, top });
      });
    }
    // 收起时关掉所有展开的面板,避免悬浮窗变小后面板悬空
    if (next) closeAllPanels();
  }

  function applyBarPosition(bar, pos) {
    if (!pos) return;
    const W = window.innerWidth, H = window.innerHeight;
    const left = Math.max(4, Math.min(pos.left, W - bar.offsetWidth - 4));
    const top  = Math.max(4, Math.min(pos.top,  H - bar.offsetHeight - 4));
    bar.style.right = 'auto';
    bar.style.transform = 'none';
    bar.style.left = `${left}px`;
    bar.style.top  = `${top}px`;
    document.documentElement.style.setProperty('--oh-bar-right', `${W - left - bar.offsetWidth}px`);
  }

  function repositionOpenPanel(bar) {
    const panel = document.querySelector('.ozon-helper-panel.is-open');
    if (!panel) return;
    const br = bar.getBoundingClientRect();
    const gap = 12;
    const onRight = (br.left + br.width / 2) > window.innerWidth / 2;

    if (onRight) {
      panel.style.left = '';
      panel.style.right = `${window.innerWidth - br.left + gap}px`;
    } else {
      panel.style.right = '';
      panel.style.left = `${br.right + gap}px`;
    }
    const maxTop = window.innerHeight - panel.offsetHeight - 8;
    panel.style.top = `${Math.max(8, Math.min(br.top, maxTop))}px`;
  }

  function initBarDrag(bar) {
    // drag-threshold:超过 TAP_THRESHOLD 像素才算 drag,否则当 click 处理
    // —— 让 brand 行 / 收起态胶囊条可点击 toggle 收起/展开
    const TAP_THRESHOLD = 4;
    let ox = 0, oy = 0, sx = 0, sy = 0, dragging = false;

    bar.addEventListener('mousedown', e => {
      if (e.target.closest('.ozon-helper-action-button')) return;
      e.preventDefault();
      const r = bar.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      sx = e.clientX;
      sy = e.clientY;
      dragging = false;

      const onMove = e => {
        if (!dragging) {
          if (Math.abs(e.clientX - sx) < TAP_THRESHOLD &&
              Math.abs(e.clientY - sy) < TAP_THRESHOLD) return;
          dragging = true;
          bar.classList.add('is-dragging');
        }
        const W = window.innerWidth, H = window.innerHeight;
        const left = Math.max(4, Math.min(e.clientX - ox, W - bar.offsetWidth - 4));
        const top  = Math.max(4, Math.min(e.clientY - oy, H - bar.offsetHeight - 4));
        bar.style.right = 'auto';
        bar.style.transform = 'none';
        bar.style.left = `${left}px`;
        bar.style.top  = `${top}px`;
        document.documentElement.style.setProperty('--oh-bar-right', `${W - left - bar.offsetWidth}px`);
      };

      const onUp = upEvent => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (dragging) {
          bar.classList.remove('is-dragging');
          dragging = false;
          saveBarPosition({ left: parseInt(bar.style.left), top: parseInt(bar.style.top) });
          repositionOpenPanel(bar);
          return;
        }
        // tap (没拖动) → brand 行点击 = toggle 收起;收起态整个 bar 都算 brand
        const inBrand = upEvent.target.closest('.ozon-helper-bar-brand');
        if (inBrand || bar.classList.contains('is-collapsed')) {
          toggleBarCollapsed(bar);
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function positionProfitPanel(panel) {
    // Ensure the panel fits within viewport vertically
    const vh = window.innerHeight;
    const topGap = 20;
    panel.style.top = `${topGap}px`;
    panel.style.maxHeight = `${vh - topGap * 2}px`;
    // Scroll content to top
    const content = panel.querySelector('.ozon-helper-panel-content');
    if (content) content.scrollTop = 0;
  }

  async function recalcProfit() {
    const panel = document.querySelector('.ozon-helper-profit-panel');
    if (panel) _recalcActiveTab(panel);
  }

  async function toggleProfitPanel(btn) {
    // Delegated to extension-lite (jzc-calc.js) — mounts the standalone calc panel.
    if (typeof window.__jzcMountPanel !== 'function') {
      console.warn('[OzonHelper] jzc-calc.js not loaded; cannot mount calc panel.');
      return;
    }
    if (window.__jzcIsMounted && window.__jzcIsMounted()) {
      window.__jzcUnmountPanel();
      btn?.classList?.remove('is-active');
      return;
    }
    // Hook to clear active state when user closes panel via × button
    window.__jzcOnUnmount = () => btn?.classList?.remove('is-active');
    closeAllPanels(null);
    setActiveButton(btn);
    window.__jzcMountPanel();
  }

  // ===== Shared helpers for follow-sell panels =====

  function loadStoresForPanel(panel) {
    (async () => {
      // Support both old single-select and new multi-select
      const storeSelect = panel.querySelector('[data-field="store"]');
      const storeTrigger = panel.querySelector('[data-action="toggle-stores"]');
      const storeDropdown = panel.querySelector('[data-field="store-dropdown"]');

      try {
        const [storesRes, auth] = await Promise.all([
          window.sendMessage('getStores'),
          window.sendMessage('getAuth'),
        ]);
        const storeList = storesRes?.data || storesRes || [];
        panel._followSellStoreList = storeList;

        // Old single-select panel (follow-sell single variant)
        if (storeSelect && !storeTrigger) {
          storeSelect.innerHTML = '';
          if (!storeList.length) {
            storeSelect.innerHTML = '<option value="">\u6682\u65e0\u5e97\u94fa</option>';
            return;
          }
          storeList.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id || s.storeId || '';
            opt.textContent = s.label || s.companyName || s.legalName || `\u5e97\u94fa ${opt.value}`;
            storeSelect.appendChild(opt);
          });
          if (auth.storeId) storeSelect.value = auth.storeId;
          return;
        }

        // New multi-select (multi-variant panel)
        if (!storeTrigger || !storeDropdown) return;
        if (!storeList.length) {
          storeTrigger.textContent = '\u6682\u65e0\u5e97\u94fa';
          return;
        }

        storeDropdown.innerHTML = '';

        // "全选" option
        const selectAllLabel = document.createElement('label');
        selectAllLabel.className = 'ozon-helper-mv-store-option';
        selectAllLabel.style.borderBottom = '1px solid #f0f0f0';
        selectAllLabel.innerHTML = `<input type="checkbox" class="ozon-helper-mv-store-select-all" /> <strong>\u5168\u9009</strong>`;
        storeDropdown.appendChild(selectAllLabel);

        storeList.forEach(s => {
          const id = s.id || s.storeId || '';
          const name = s.label || s.companyName || s.legalName || `\u5e97\u94fa ${id}`;
          const isDefault = auth.storeId && String(auth.storeId) === String(id);
          const label = document.createElement('label');
          label.className = 'ozon-helper-mv-store-option';
          label.innerHTML = `<input type="checkbox" class="ozon-helper-mv-store-cb" value="${_escHtml(id)}" ${isDefault ? 'checked' : ''} /> ${_escHtml(name)}`;
          storeDropdown.appendChild(label);
        });

        // \u6062\u590d\u4e0a\u6b21\u9009\u4e2d\u7684\u5e97\u94fa(\u8986\u76d6\u9ed8\u8ba4\u52fe\u9009\u5f53\u524d\u5e97);\u8fc7\u6ee4\u6389\u5df2\u4e0d\u5b58\u5728\u7684\u5e97\u94fa id\u3002
        // \u7a0b\u5e8f\u5316\u52fe\u9009\u4e0d\u89e6\u53d1 change,\u6240\u4ee5\u4e0d\u4f1a\u53cd\u8fc7\u6765\u5199\u56de storage(\u907f\u514d\u5b58\u50a8\u6296\u52a8)\u3002
        try {
          const savedCfg = await _getListingConfig();
          restoreManualSelectedStores(panel, savedCfg, storeList);
        } catch {}

        // "全选" checkbox logic
        const selectAllCb = storeDropdown.querySelector('.ozon-helper-mv-store-select-all');
        selectAllCb.addEventListener('change', () => {
          const allCbs = storeDropdown.querySelectorAll('.ozon-helper-mv-store-cb');
          let firstCheckedId = '';
          allCbs.forEach(cb => {
            cb.checked = selectAllCb.checked;
            if (selectAllCb.checked && !firstCheckedId) firstCheckedId = cb.value;
          });
          if (selectAllCb.checked) {
            rememberFollowSellWarehouseStore(panel, firstCheckedId);
          } else {
            panel._followSellPreferredWarehouseStoreId = '';
          }
          updateTriggerText();
          scheduleFollowSellWarehouseSync(panel);
        });

        // Update trigger text based on selections
        const updateTriggerText = () => {
          const allCbs = storeDropdown.querySelectorAll('.ozon-helper-mv-store-cb');
          const checked = storeDropdown.querySelectorAll('.ozon-helper-mv-store-cb:checked');
          // Sync "全选" checkbox state
          if (selectAllCb) selectAllCb.checked = checked.length === allCbs.length && allCbs.length > 0;
          if (checked.length === 0) {
            storeTrigger.textContent = '\u8bf7\u9009\u62e9\u5e97\u94fa';
          } else if (checked.length === 1) {
            storeTrigger.textContent = checked[0].parentElement.textContent.trim();
          } else {
            storeTrigger.textContent = `\u5df2\u9009 ${checked.length} \u4e2a\u5e97\u94fa`;
          }
        };
        updateTriggerText();

        // 门户「模拟手动上架」只能上当前登录 seller.ozon.ru 的那一个店铺(单 sc_company_id
        // cookie)。开启时把店铺选择收紧成单店:隐藏「全选」、多选裁成一个(优先当前店)、
        // 之后再选互斥。关闭则恢复多选。提交时仍有公司一致性护栏兜底。
        panel._applyPortalStoreConstraint = (on) => {
          panel._portalSingleStore = !!on;
          const selectAllRow = selectAllCb?.closest('.ozon-helper-mv-store-option');
          const cbs = [...storeDropdown.querySelectorAll('.ozon-helper-mv-store-cb')];
          if (on) {
            if (selectAllRow) selectAllRow.style.display = 'none';
            if (selectAllCb) selectAllCb.checked = false;
            const checked = cbs.filter((c) => c.checked);
            if (cbs.length && checked.length !== 1) {
              const cur = String(panel._followSellStoreId || '');
              const keep = checked.find((c) => String(c.value) === cur) || checked[0] || cbs[0];
              cbs.forEach((c) => { c.checked = (c === keep); });
              if (keep) rememberFollowSellWarehouseStore(panel, keep.value);
            }
          } else if (selectAllRow) {
            selectAllRow.style.display = '';
          }
          updateTriggerText();
          panel._updateFooterCount?.();
          scheduleFollowSellWarehouseSync(panel);
        };
        // 店铺异步加载完成时,若「上架方式」已是模拟手动上架(恢复的上次选择),立即收紧
        try {
          if (panel.querySelector('input[name="jz-upload-mode"]:checked')?.value === 'portal') {
            panel._applyPortalStoreConstraint(true);
          }
        } catch {}

        storeDropdown.addEventListener('change', (e) => {
          const target = e.target;
          if (target?.classList?.contains('ozon-helper-mv-store-cb')) {
            // 单店模式:选中一个就取消其他,保证只勾一个店铺
            if (panel._portalSingleStore && target.checked) {
              storeDropdown.querySelectorAll('.ozon-helper-mv-store-cb').forEach((cb) => {
                if (cb !== target) cb.checked = false;
              });
            }
            if (target.checked) {
              rememberFollowSellWarehouseStore(panel, target.value);
            } else if (String(panel._followSellPreferredWarehouseStoreId || '') === String(target.value || '')) {
              panel._followSellPreferredWarehouseStoreId = '';
            }
          }
          if (!target.classList.contains('ozon-helper-mv-store-select-all')) updateTriggerText();
        });

        // Toggle dropdown
        storeTrigger.addEventListener('click', () => {
          const isOpen = storeDropdown.style.display !== 'none';
          storeDropdown.style.display = isOpen ? 'none' : '';
        });

        // Close dropdown on outside click
        document.addEventListener('click', (e) => {
          const wrapper = panel.querySelector('[data-field="store-wrapper"]');
          if (wrapper && !wrapper.contains(e.target)) {
            storeDropdown.style.display = 'none';
          }
        });

        // Upgrade to enterprise picker (trigger pill + popover)
        // — keeps the legacy dropdown above as hidden source-of-truth for submit
        renderEnterpriseStorePicker(panel, storeList, auth);
        // 恢复的店铺选择是程序化勾选(不触发 change),手动同步仓库 UI(单店/多店列表)+ 页脚计数。
        scheduleFollowSellWarehouseSync(panel);
        panel._updateFooterCount?.();
      } catch {
        panel._followSellStoreList = [];
        if (storeSelect) storeSelect.innerHTML = '<option value="">\u52a0\u8f7d\u5931\u8d25</option>';
        if (storeTrigger) storeTrigger.textContent = '\u52a0\u8f7d\u5931\u8d25';
      }
    })();
  }

  // 跟卖面板「各店物流仓库」选择的跨会话记忆:panel._selectedWarehouseByStore 是
  // 内存 Map、关面板即丢(只在同一面板内有效)。这里把每店选的仓库写进
  // chrome.storage,脚本加载时读一次进内存缓存,渲染时作为 preferred 兜底 →
  // 下次打开面板各店自动回填上次选的仓库。
  let _persistedFollowSellWh = {};
  try {
    chrome.storage.local.get(['followSellWarehouseByStore'], (r) => {
      const m = r && r.followSellWarehouseByStore;
      if (m && typeof m === 'object') _persistedFollowSellWh = m;
    });
  } catch (e) { /* storage 不可用 → 退化为不记忆 */ }

  // 记住某店选的仓库(无变化不写,避免渲染自动落选时频繁写盘)。
  function persistFollowSellWarehouse(storeId, warehouseId) {
    const sid = String(storeId || '');
    const wid = String(warehouseId || '');
    if (!sid || !wid || _persistedFollowSellWh[sid] === wid) return;
    _persistedFollowSellWh[sid] = wid;
    try {
      chrome.storage.local.set({ followSellWarehouseByStore: _persistedFollowSellWh });
    } catch (e) { /* ignore */ }
  }

  function parseWarehouseListResponse(whRes) {
    const data = whRes?.data ?? whRes;
    const list = Array.isArray(data) ? data
      : Array.isArray(data?.result) ? data.result
      : Array.isArray(data?.result?.warehouses) ? data.result.warehouses
      : Array.isArray(data?.warehouses) ? data.warehouses
      : Array.isArray(data?.items) ? data.items
      : Array.isArray(data?.data?.result) ? data.data.result
      : Array.isArray(data?.data?.warehouses) ? data.data.warehouses
      : Array.isArray(data?.data) ? data.data
      : [];
    return list.filter(Boolean);
  }

  function getSelectedFollowSellStoreIds(panel) {
    return Array.from(panel.querySelectorAll('.ozon-helper-mv-store-cb:checked'))
      .map(cb => String(cb.value || '').trim())
      .filter(Boolean);
  }

  function rememberFollowSellWarehouseStore(panel, storeId) {
    const sid = String(storeId || '').trim();
    if (sid) panel._followSellPreferredWarehouseStoreId = sid;
  }

  function resolveFollowSellWarehouseStore(panel, selectedIds) {
    const preferred = String(panel._followSellPreferredWarehouseStoreId || '').trim();
    if (preferred && selectedIds.includes(preferred)) return preferred;
    const current = panel._followSellStoreId ? String(panel._followSellStoreId) : '';
    if (current && selectedIds.includes(current)) return current;
    return selectedIds[0] || '';
  }

  async function loadFollowSellWarehousesForStore(panel, storeId) {
    const whSelect = panel.querySelector('[data-field="warehouse-id"]');
    if (!whSelect) return [];
    const sid = String(storeId || '');
    panel._followSellStoreId = sid || null;
    panel._warehousesByStore = panel._warehousesByStore || new Map();
    panel._selectedWarehouseByStore = panel._selectedWarehouseByStore || new Map();
    // Stale-async guard — 单店切换时也可能用旧 sid fetch 覆盖更新的 sid render。
    // 多店 sync 早就加了 seq guard,单店这里同样需要(Codex round-2 抓出)。
    const loadSeq = (panel._warehouseSingleLoadSeq = (panel._warehouseSingleLoadSeq || 0) + 1);
    const isCurrentLoad = () =>
      panel._warehouseSingleLoadSeq === loadSeq &&
      String(panel._followSellStoreId || '') === sid;

    if (!sid) {
      whSelect.innerHTML = '<option value="">未选择店铺</option>';
      panel._warehouses = [];
      return [];
    }

    const cached = panel._warehousesByStore.get(sid);
    if (cached && Array.isArray(cached.options)) {
      renderFollowSellWarehouseOptions(panel, sid, cached.options);
      return cached.options;
    }

    whSelect.innerHTML = '<option value="">加载中...</option>';
    try {
      const whRes = await window.sendMessage('getWarehouses', { storeId: sid });
      const list = parseWarehouseListResponse(whRes);
      console.log('[OzonHelper] warehouses response:', { storeId: sid, whRes, parsed: list });
      panel._warehousesByStore.set(sid, { options: list });
      if (!isCurrentLoad()) return list; // stale → 不覆盖更新的 UI
      renderFollowSellWarehouseOptions(panel, sid, list);
      return list;
    } catch (e) {
      console.warn('[OzonHelper] Failed to load warehouses:', e);
      panel._warehousesByStore.set(sid, { options: [], error: e?.message || String(e || '') });
      if (!isCurrentLoad()) return []; // stale → 不覆盖更新的 UI
      whSelect.innerHTML = `<option value="">加载失败：${(e?.message || e || '').toString().slice(0, 60)}</option>`;
      panel._warehouses = [];
      return [];
    }
  }

  function renderFollowSellWarehouseOptions(panel, storeId, list) {
    const whSelect = panel.querySelector('[data-field="warehouse-id"]');
    if (!whSelect) return;
    const sid = String(storeId || '');
    panel._warehouses = list;

    if (!Array.isArray(list) || list.length === 0) {
      whSelect.innerHTML = '<option value="">无可用仓库（请先到「仓库管理」同步或检查 API 凭证）</option>';
      return;
    }

    const saved = panel._selectedWarehouseByStore?.get(sid);
    const templateWarehouseId = panel._templateSettings?.warehouseId;
    // 优先级:本面板内已选 → 上次跨会话记忆 → 模板默认仓 → 无
    const preferred = saved || _persistedFollowSellWh[sid] || templateWarehouseId || '';
    whSelect.innerHTML = list.map((w) => {
      const wid = w.warehouse_id ?? w.warehouseId ?? w.id;
      const name = w.name || w.warehouse_name || `仓库 ${wid}`;
      const selected = preferred && String(preferred) === String(wid) ? ' selected' : '';
      return `<option value="${_escHtml(wid)}"${selected}>${_escHtml(name)} (${_escHtml(wid)})</option>`;
    }).join('');

    if (!whSelect.value && whSelect.options.length > 0) {
      whSelect.selectedIndex = 0;
    }
    if (whSelect.value) {
      panel._selectedWarehouseByStore?.set(sid, String(whSelect.value));
      persistFollowSellWarehouse(sid, whSelect.value);
    }
  }

  /**
   * 并行 ensure 所有 selected store 的 warehouses 已 fetched + cached in
   * `panel._warehousesByStore`。已 cached 的 store skip,只 fetch 新加入的。
   * Best-effort — 单个 store 失败不阻断其他,cache 里写 { options:[], error }。
   */
  async function ensureFollowSellWarehousesForStores(panel, storeIds) {
    panel._warehousesByStore = panel._warehousesByStore || new Map();
    const toFetch = storeIds.filter((sid) => sid && !panel._warehousesByStore.has(sid));
    if (toFetch.length === 0) return;
    await Promise.all(
      toFetch.map(async (sid) => {
        try {
          const whRes = await window.sendMessage('getWarehouses', { storeId: sid });
          const list = parseWarehouseListResponse(whRes);
          panel._warehousesByStore.set(sid, { options: list });
        } catch (e) {
          panel._warehousesByStore.set(sid, { options: [], error: e?.message || String(e) });
        }
      }),
    );
  }

  /**
   * 多店模式:在 [data-field="warehouse-multi-list"] 容器里渲染 N 行,每行
   *   [店铺名] [<select data-warehouse-store-id="X">]
   * select onChange 写 `panel._selectedWarehouseByStore` map。提交时(line 6156+)
   * 直接从 map 读 per-store 仓库,无 UI 路径依赖。
   *
   * 已有的单选 [data-field="warehouse-id"] 在多店模式下隐藏(submit code 仍能
   * fallback 到 map → 模板 ts.warehouseId → 该店首仓,所以单 select 不影响)。
   */
  function renderFollowSellMultiStoreWarehousePicker(panel, storeIds) {
    const multiList = panel.querySelector('[data-field="warehouse-multi-list"]');
    const singleRow = panel.querySelector('[data-field="warehouse-single-row"]');
    const hint = panel.querySelector('[data-field="warehouse-picker-hint"]');
    if (!multiList || !singleRow) return;
    panel._selectedWarehouseByStore = panel._selectedWarehouseByStore || new Map();

    singleRow.style.display = 'none';
    multiList.style.display = 'flex';
    if (hint) hint.textContent = `库存将写入各店仓库（${storeIds.length} 家店,每家独立选择）`;

    const storeList = Array.isArray(panel._followSellStoreList) ? panel._followSellStoreList : [];
    const nameOf = (sid) => {
      const s = storeList.find((x) => String(x.id || x.storeId) === String(sid));
      return s?.label || s?.companyName || s?.legalName || `店铺 ${String(sid).slice(0, 8)}`;
    };

    const ts = panel._templateSettings || {};
    const rowsHtml = storeIds.map((sid) => {
      const cache = panel._warehousesByStore?.get(sid);
      const list = cache?.options || [];
      const error = cache?.error;
      const saved = panel._selectedWarehouseByStore?.get(sid);
      // 本面板内已选 → 上次跨会话记忆 → 模板默认仓
      const preferred = saved || _persistedFollowSellWh[sid] || ts.warehouseId || '';
      let selectInner;
      if (error) {
        selectInner = `<option value="">加载失败：${_escHtml(String(error).slice(0, 50))}</option>`;
      } else if (list.length === 0) {
        selectInner = '<option value="">无可用仓库</option>';
      } else {
        selectInner = list.map((w) => {
          const wid = w.warehouse_id ?? w.warehouseId ?? w.id;
          const name = w.name || w.warehouse_name || `仓库 ${wid}`;
          const selected = preferred && String(preferred) === String(wid) ? ' selected' : '';
          return `<option value="${_escHtml(wid)}"${selected}>${_escHtml(name)} (${_escHtml(wid)})</option>`;
        }).join('');
      }
      return `<div style="display:flex;align-items:center;gap:8px;">
        <span style="flex:0 0 140px;font-size:12px;color:#0f172a;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${_escHtml(nameOf(sid))}">${_escHtml(nameOf(sid))}</span>
        <select data-warehouse-store-id="${_escHtml(sid)}" style="flex:1;min-width:160px;height:28px;padding:0 8px;border:1px solid #e5e7eb;border-radius:6px;background:#fff;font-size:13px;">
          ${selectInner}
        </select>
      </div>`;
    }).join('');
    multiList.innerHTML = rowsHtml;

    // Wire onChange — 写 _selectedWarehouseByStore map(提交时 line 6156+ 优先读这里)
    multiList.querySelectorAll('select[data-warehouse-store-id]').forEach((sel) => {
      const sid = sel.getAttribute('data-warehouse-store-id');
      // Seed map with default selected option(用户没改动也要落到 map,否则
      // 提交时 fallback 链可能走到模板默认仓 vs UI 显示的首仓不一致)
      if (sid && sel.value) {
        panel._selectedWarehouseByStore.set(String(sid), String(sel.value));
        persistFollowSellWarehouse(sid, sel.value);
      }
      sel.addEventListener('change', () => {
        if (sid && sel.value) {
          panel._selectedWarehouseByStore.set(String(sid), String(sel.value));
          persistFollowSellWarehouse(sid, sel.value);
        }
      });
    });
  }

  function syncFollowSellWarehouseWithSelectedStores(panel) {
    // 序列号 + selection 恒等性双 guard,防止 stale async render 提交错 warehouse_id。
    // Race 场景(Codex CRITICAL):
    //   T0: 用户选 A+B → sync 1 启动 fetch A+B 仓库(慢)
    //   T1: 用户改选 A+C → sync 2 启动 fetch C 仓库(快)
    //   T2: sync 2 完成 → 渲染 A+C → map seed A+C 默认仓
    //   T3: sync 1 完成 → 渲染 A+B → multiList.innerHTML 覆盖 A+C → map 没 seed C
    //   T4: 用户立刻提交 → C 在 map miss → fallback 走 ts.warehouseId 或 null → 错 warehouse
    // 修法:每次 sync 抢一个递增 seq;async 完成后比较 seq + 当前 selectedIds,
    //      不匹配就 abort,不覆盖最新状态。
    const syncSeq = (panel._warehouseStoreSyncSeq = (panel._warehouseStoreSyncSeq || 0) + 1);
    const selectedIds = getSelectedFollowSellStoreIds(panel);
    const multiList = panel.querySelector('[data-field="warehouse-multi-list"]');
    const singleRow = panel.querySelector('[data-field="warehouse-single-row"]');
    const hint = panel.querySelector('[data-field="warehouse-picker-hint"]');

    if (selectedIds.length === 0) {
      panel._followSellPreferredWarehouseStoreId = '';
      // 隐藏多选,显示单选 placeholder
      if (multiList) multiList.style.display = 'none';
      if (singleRow) singleRow.style.display = 'flex';
      if (hint) hint.textContent = '库存将写入此仓库（变体表格设置库存后生效）';
      loadFollowSellWarehousesForStore(panel, '');
      return;
    }

    if (selectedIds.length === 1) {
      // 单店:沿用原 single-select 路径
      if (multiList) multiList.style.display = 'none';
      if (singleRow) singleRow.style.display = 'flex';
      if (hint) hint.textContent = '库存将写入此仓库（变体表格设置库存后生效）';
      const nextStoreId = resolveFollowSellWarehouseStore(panel, selectedIds);
      loadFollowSellWarehousesForStore(panel, nextStoreId);
      return;
    }

    // 多店:并行 ensure 各店 warehouses 已加载 → 渲染 N 行 per-store 选择
    (async () => {
      // 立即占位渲染(loading state)防止用户看到旧单选闪一下
      if (multiList) {
        multiList.style.display = 'flex';
        multiList.innerHTML = `<div style="font-size:12px;color:#64748b;">加载 ${selectedIds.length} 家店仓库中…</div>`;
      }
      if (singleRow) singleRow.style.display = 'none';
      try {
        await ensureFollowSellWarehousesForStores(panel, selectedIds);
      } catch (e) {
        console.warn('[OzonHelper] ensureFollowSellWarehousesForStores failed:', e);
      }
      // Stale guard:fetch 返回时若 user 已再次切换 → seq 不匹配 / selection 已变,abort
      // 不调 renderFollowSellMultiStoreWarehousePicker(否则覆盖更新的状态导致 map 不一致)
      const currentSelectedIds = getSelectedFollowSellStoreIds(panel);
      const isStillCurrent =
        panel._warehouseStoreSyncSeq === syncSeq &&
        currentSelectedIds.length === selectedIds.length &&
        currentSelectedIds.every((id, idx) => String(id) === String(selectedIds[idx]));
      if (!isStillCurrent) return;
      renderFollowSellMultiStoreWarehousePicker(panel, selectedIds);
    })();
  }

  function scheduleFollowSellWarehouseSync(panel) {
    clearTimeout(panel._warehouseStoreSyncTimer);
    panel._warehouseStoreSyncTimer = setTimeout(() => {
      syncFollowSellWarehouseWithSelectedStores(panel);
    }, 80);
  }

  // ===== Enterprise Store Picker (Quick List \u4e00\u952e\u4e0a\u67b6) =====

  function _buildStoreView(s) {
    const id = s.id || s.storeId || '';
    const name = s.label || s.companyName || s.legalName || `\u5e97\u94fa ${id}`;
    const country = (s.companyCountry || '').toUpperCase();
    const flag = country === 'RU' ? '\ud83c\uddf7\ud83c\uddfa'
               : country === 'BY' ? '\ud83c\udde7\ud83c\uddfe'
               : country === 'KZ' ? '\ud83c\uddf0\ud83c\uddff'
               : '';
    const group = country === 'RU' ? '\u4fc4\u7f57\u65af'
                : country === 'BY' ? '\u767d\u4fc4\u7f57\u65af'
                : country === 'KZ' ? '\u54c8\u8428\u514b\u65af\u5766'
                : '\u5176\u5b83';
    const color = country === 'RU' ? '#1d6bff'
                : country === 'BY' ? '#0ea5e9'
                : country === 'KZ' ? '#0891b2'
                : '#6b7a93';
    const tier = s.isPremium ? 'Premium' : 'Standard';
    const cleanName = name.replace(/[#\u00b7\s].*$/, '').trim();
    const initials = (cleanName.slice(0, 2) || '##').toUpperCase();
    const code = s.shopId != null ? String(s.shopId).padStart(5, '0') : (id ? String(id).slice(-5) : '-----');
    return { id: String(id), name, country, flag, group, color, tier, initials, code, isActive: s.isActive !== false };
  }

  function _cssEscape(id) {
    return String(id).replace(/(["'\\])/g, '\\$1');
  }

  function _getRecentStoreIds() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(['mv-store-recent'], r => {
          resolve(Array.isArray(r['mv-store-recent']) ? r['mv-store-recent'].map(String) : []);
        });
      } catch { resolve([]); }
    });
  }

  function _saveRecentStoreIds(ids) {
    if (!ids || !ids.length) return;
    const newIds = ids.map(String);
    try {
      chrome.storage.local.get(['mv-store-recent'], r => {
        const existing = Array.isArray(r['mv-store-recent']) ? r['mv-store-recent'].map(String) : [];
        const merged = [...newIds, ...existing.filter(x => !newIds.includes(x))].slice(0, 12);
        chrome.storage.local.set({ 'mv-store-recent': merged });
      });
    } catch {}
  }

  // 一键上架面板的「记住上次选择」—— 店铺/品牌/图片顺序/上架货币/AI 改图/AI 重写。
  // 单 key 存一个 config 对象;按字段 partial 合并,避免某次只改一个字段时把别的清掉。
  const MV_LISTING_CFG_KEY = 'mv-listing-config';
  function _getListingConfig() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get([MV_LISTING_CFG_KEY], r => {
          const c = r && r[MV_LISTING_CFG_KEY];
          resolve(c && typeof c === 'object' ? c : null);
        });
      } catch { resolve(null); }
    });
  }
  function _saveListingConfig(partial) {
    if (!partial || typeof partial !== 'object') return;
    try {
      chrome.storage.local.get([MV_LISTING_CFG_KEY], r => {
        const prev = (r && typeof r[MV_LISTING_CFG_KEY] === 'object' && r[MV_LISTING_CFG_KEY]) || {};
        chrome.storage.local.set({ [MV_LISTING_CFG_KEY]: { ...prev, ...partial } });
      });
    } catch {}
  }

  function normalizeManualListingMultiplier(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Number(n.toFixed(4));
  }

  function formatManualListingMultiplier(value) {
    const n = normalizeManualListingMultiplier(value);
    if (!n) return '';
    return String(n).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  function getManualListingVariantRows(panel) {
    return Array.from(panel.querySelectorAll('[data-field="variant-tbody"] tr'));
  }

  function getManualListingOldPriceAnchor(row) {
    const salePrice = Number(row.querySelector('.ozon-helper-mv-price')?.value);
    const basePrice = Number(row.querySelector('.ozon-helper-mv-price-original')?.dataset?.basePrice);
    if (Number.isFinite(salePrice) && salePrice > 0) return salePrice;
    if (Number.isFinite(basePrice) && basePrice > 0) return basePrice;
    return 0;
  }

  function getManualListingBasePrice(row) {
    const basePrice = Number(row.querySelector('.ozon-helper-mv-price-original')?.dataset?.basePrice);
    return Number.isFinite(basePrice) && basePrice > 0 ? basePrice : 0;
  }

  function showInheritedMultiplierToast(ratio) {
    const label = formatManualListingMultiplier(ratio);
    if (!label) return;
    document.querySelectorAll('.ozon-helper-mv-toast.ohm-inherited-multiplier-toast').forEach(t => t.remove());
    const toast = document.createElement('div');
    toast.className = 'ozon-helper-mv-toast ohm-inherited-multiplier-toast';

    const icon = document.createElement('span');
    icon.className = 'ohm-toast-check';
    icon.innerHTML = typeof window.lucideIcon === 'function' ? window.lucideIcon('check', 14) : '✓';

    const text = document.createElement('div');
    text.className = 'ohm-toast-text';
    const title = document.createElement('div');
    title.className = 'ohm-toast-title';
    title.textContent = `本次价格继承上次选择：${label}倍率`;
    const sub = document.createElement('div');
    sub.className = 'ohm-toast-sub';
    sub.textContent = '已自动按上次倍率填写价格';
    text.append(title, sub);

    const close = document.createElement('span');
    close.className = 'ohm-toast-close';
    close.dataset.action = 'close';
    close.textContent = '×';

    toast.append(icon, text, close);
    document.body.appendChild(toast);
    const closeToast = () => toast.remove();
    close.addEventListener('click', closeToast);
    setTimeout(closeToast, 4500);
  }

  function applyRememberedVariantPricingAndStock(panel, cfg, opts = {}) {
    if (!cfg || typeof cfg !== 'object') return;

    const stock = Number(cfg.defaultStock);
    if (Number.isFinite(stock) && stock >= 0) {
      panel._rememberedDefaultStock = stock;
      panel.querySelectorAll('.ozon-helper-mv-stock').forEach(input => {
        input.value = String(stock);
      });
    }

    const appliedSalePrice = applyManualSalePriceStrategy(panel, cfg, opts);
    const appliedMinPrice = applyManualMinPriceStrategy(panel, cfg, opts);

    const batchStrategy = cfg.lastBatchOldPriceStrategy?.type === 'multiplier'
      ? cfg.lastBatchOldPriceStrategy
      : null;
    const strategy = batchStrategy || cfg.oldPriceStrategy;
    const ratio = strategy?.type === 'multiplier'
      ? normalizeManualListingMultiplier(strategy.value)
      : null;
    if (!ratio) return;

    panel._rememberedOldPriceMultiplier = ratio;
    const isBatchMultiplier = !!batchStrategy || cfg.oldPriceStrategy?.source === 'batch';
    panel._rememberedOldPriceSource = isBatchMultiplier ? 'batch' : 'remembered';
    getManualListingVariantRows(panel).forEach(row => {
      const oldInput = row.querySelector('.ozon-helper-mv-oldprice');
      if (!oldInput) return;
      const anchor = getManualListingOldPriceAnchor(row);
      if (anchor > 0) oldInput.value = (anchor * ratio).toFixed(2);
    });
    if (!appliedSalePrice && !appliedMinPrice && opts.notifyPrice && isBatchMultiplier && !panel._inheritedMultiplierToastShown) {
      panel._inheritedMultiplierToastShown = true;
      showInheritedMultiplierToast(ratio);
    }
  }

  function applyManualSalePriceStrategy(panel, cfg, opts = {}) {
    const batchStrategy = cfg.lastBatchSalePriceStrategy?.type === 'multiplier'
      ? cfg.lastBatchSalePriceStrategy
      : null;
    const strategy = batchStrategy || cfg.salePriceStrategy;
    const ratio = strategy?.type === 'multiplier'
      ? normalizeManualListingMultiplier(strategy.value)
      : null;
    if (!ratio) return false;

    panel._rememberedSalePriceMultiplier = ratio;
    const isBatchMultiplier = !!batchStrategy || cfg.salePriceStrategy?.source === 'batch';
    panel._rememberedSalePriceSource = isBatchMultiplier ? 'batch' : 'remembered';
    getManualListingVariantRows(panel).forEach(row => {
      const priceInput = row.querySelector('.ozon-helper-mv-price');
      if (!priceInput) return;
      const basePrice = getManualListingBasePrice(row);
      if (basePrice > 0) priceInput.value = (basePrice * ratio).toFixed(2);
    });
    if (opts.notifyPrice && isBatchMultiplier && !panel._inheritedMultiplierToastShown) {
      panel._inheritedMultiplierToastShown = true;
      showInheritedMultiplierToast(ratio);
    }
    return true;
  }

  function applyManualMinPriceStrategy(panel, cfg, opts = {}) {
    const batchStrategy = cfg.lastBatchMinPriceStrategy?.type === 'multiplier'
      ? cfg.lastBatchMinPriceStrategy
      : null;
    const strategy = batchStrategy || cfg.minPriceStrategy;
    const ratio = strategy?.type === 'multiplier'
      ? normalizeManualListingMultiplier(strategy.value)
      : null;
    if (!ratio) return false;

    panel._rememberedMinPriceMultiplier = ratio;
    const isBatchMultiplier = !!batchStrategy || cfg.minPriceStrategy?.source === 'batch';
    panel._rememberedMinPriceSource = isBatchMultiplier ? 'batch' : 'remembered';
    getManualListingVariantRows(panel).forEach(row => {
      const minInput = row.querySelector('.ozon-helper-mv-minprice');
      if (!minInput) return;
      const basePrice = getManualListingBasePrice(row);
      if (basePrice > 0) minInput.value = (basePrice * ratio).toFixed(2);
    });
    if (opts.notifyPrice && isBatchMultiplier && !panel._inheritedMultiplierToastShown) {
      panel._inheritedMultiplierToastShown = true;
      showInheritedMultiplierToast(ratio);
    }
    return true;
  }

  function rememberManualBatchListingDefaults(panel, opts, mode, parsed) {
    const firstValue = Number(parsed?.[0]);
    if (opts?.targetField === 'mv-stock' && Number.isFinite(firstValue) && firstValue >= 0) {
      panel._lastBatchDefaultStock = Math.round(firstValue);
    }

    if (opts?.targetField === 'mv-price') {
      const ratio = mode === 'multiplier' ? normalizeManualListingMultiplier(firstValue) : null;
      if (ratio) {
        panel._lastBatchSalePriceStrategy = { type: 'multiplier', value: ratio };
        panel._rememberedSalePriceMultiplier = ratio;
        panel._rememberedSalePriceSource = 'batch';
        return;
      }
      panel._lastBatchSalePriceStrategy = { type: 'fixed' };
      delete panel._rememberedSalePriceMultiplier;
      delete panel._rememberedSalePriceSource;
      return;
    }

    if (opts?.targetField === 'mv-minprice') {
      const ratio = mode === 'multiplier' ? normalizeManualListingMultiplier(firstValue) : null;
      if (ratio) {
        panel._lastBatchMinPriceStrategy = { type: 'multiplier', value: ratio };
        panel._rememberedMinPriceMultiplier = ratio;
        panel._rememberedMinPriceSource = 'batch';
        return;
      }
      panel._lastBatchMinPriceStrategy = { type: 'fixed' };
      delete panel._rememberedMinPriceMultiplier;
      delete panel._rememberedMinPriceSource;
      return;
    }

    if (opts?.targetField !== 'mv-oldprice') return;
    const ratio = mode === 'multiplier' ? normalizeManualListingMultiplier(firstValue) : null;
    if (ratio) {
      panel._lastBatchOldPriceStrategy = { type: 'multiplier', value: ratio };
      panel._rememberedOldPriceMultiplier = ratio;
      return;
    }

    panel._lastBatchOldPriceStrategy = { type: 'fixed' };
    delete panel._rememberedOldPriceMultiplier;
  }

  function captureManualListingConfig(panel) {
    const selectedStoreIds = getSelectedFollowSellStoreIds(panel);
    const selectedWarehouseByStore = {};
    const whMap = panel._selectedWarehouseByStore instanceof Map
      ? panel._selectedWarehouseByStore
      : new Map();
    whMap.forEach((warehouseId, storeId) => {
      if (storeId && warehouseId) selectedWarehouseByStore[String(storeId)] = String(warehouseId);
    });
    const currentStoreId = panel._followSellStoreId ? String(panel._followSellStoreId) : '';
    const currentWarehouseId = panel.querySelector('[data-field="warehouse-id"]')?.value || '';
    if (currentStoreId && currentWarehouseId) {
      selectedWarehouseByStore[currentStoreId] = String(currentWarehouseId);
    }

    const variantRows = getManualListingVariantRows(panel);
    const checkedRows = variantRows
      .filter(row => row.querySelector('.ozon-helper-mv-check')?.checked);
    const readUniformStock = (rows) => {
      const values = rows
        .map(row => Number(row.querySelector('.ozon-helper-mv-stock')?.value))
        .filter(n => Number.isFinite(n) && n >= 0);
      return values.length > 0 && values.every(n => n === values[0]) ? values[0] : null;
    };
    const rememberedBatchStock = Number(panel._lastBatchDefaultStock);
    const defaultStock = Number.isFinite(rememberedBatchStock) && rememberedBatchStock >= 0
      ? rememberedBatchStock
      : (readUniformStock(checkedRows) ?? readUniformStock(variantRows));
    let salePriceStrategy = null;
    const batchSalePriceStrategy = panel._lastBatchSalePriceStrategy;
    const batchSaleRatio = batchSalePriceStrategy?.type === 'multiplier'
      ? normalizeManualListingMultiplier(batchSalePriceStrategy.value)
      : null;
    const rememberedSaleRatio = normalizeManualListingMultiplier(panel._rememberedSalePriceMultiplier);
    let lastBatchSalePriceStrategy = null;
    if (batchSaleRatio) {
      salePriceStrategy = { type: 'multiplier', value: batchSaleRatio, source: 'batch' };
      lastBatchSalePriceStrategy = { type: 'multiplier', value: batchSaleRatio };
    } else if (batchSalePriceStrategy?.type === 'fixed') {
      salePriceStrategy = null;
    } else if (rememberedSaleRatio) {
      const source = panel._rememberedSalePriceSource === 'batch' ? 'batch' : 'remembered';
      salePriceStrategy = { type: 'multiplier', value: rememberedSaleRatio, source };
      if (source === 'batch') {
        lastBatchSalePriceStrategy = { type: 'multiplier', value: rememberedSaleRatio };
      }
    }

    let minPriceStrategy = null;
    const batchMinPriceStrategy = panel._lastBatchMinPriceStrategy;
    const batchMinRatio = batchMinPriceStrategy?.type === 'multiplier'
      ? normalizeManualListingMultiplier(batchMinPriceStrategy.value)
      : null;
    const rememberedMinRatio = normalizeManualListingMultiplier(panel._rememberedMinPriceMultiplier);
    let lastBatchMinPriceStrategy = null;
    if (batchMinRatio) {
      minPriceStrategy = { type: 'multiplier', value: batchMinRatio, source: 'batch' };
      lastBatchMinPriceStrategy = { type: 'multiplier', value: batchMinRatio };
    } else if (batchMinPriceStrategy?.type === 'fixed') {
      minPriceStrategy = null;
    } else if (rememberedMinRatio) {
      const source = panel._rememberedMinPriceSource === 'batch' ? 'batch' : 'remembered';
      minPriceStrategy = { type: 'multiplier', value: rememberedMinRatio, source };
      if (source === 'batch') {
        lastBatchMinPriceStrategy = { type: 'multiplier', value: rememberedMinRatio };
      }
    }

    let oldPriceStrategy = null;
    const batchOldPriceStrategy = panel._lastBatchOldPriceStrategy;
    const batchRatio = batchOldPriceStrategy?.type === 'multiplier'
      ? normalizeManualListingMultiplier(batchOldPriceStrategy.value)
      : null;
    const rememberedRatio = normalizeManualListingMultiplier(panel._rememberedOldPriceMultiplier);
    let lastBatchOldPriceStrategy = null;
    if (batchRatio) {
      oldPriceStrategy = { type: 'multiplier', value: batchRatio, source: 'batch' };
      lastBatchOldPriceStrategy = { type: 'multiplier', value: batchRatio };
    } else if (batchOldPriceStrategy?.type === 'fixed') {
      oldPriceStrategy = null;
    } else if (rememberedRatio) {
      const source = panel._rememberedOldPriceSource === 'batch' ? 'batch' : 'remembered';
      oldPriceStrategy = { type: 'multiplier', value: rememberedRatio, source };
      if (source === 'batch') {
        lastBatchOldPriceStrategy = { type: 'multiplier', value: rememberedRatio };
      }
    } else {
      for (const row of checkedRows) {
        const oldPrice = Number(row.querySelector('.ozon-helper-mv-oldprice')?.value);
        const anchor = getManualListingOldPriceAnchor(row);
        if (!Number.isFinite(oldPrice) || oldPrice <= 0 || anchor <= 0) continue;
        oldPriceStrategy = {
          type: 'multiplier',
          value: Number((oldPrice / anchor).toFixed(4)),
          source: 'derived',
        };
        break;
      }
    }

    return {
      version: 2,
      savedAt: Date.now(),
      selectedStoreIds,
      storeIds: selectedStoreIds,
      brand: panel.querySelector('[data-field="brand"]')?.value || 'no_brand',
      imageOrder: panel.querySelector('[data-field="image-order"]')?.value || 'keep',
      currency: panel.querySelector('[data-field="currency"]')?.value || 'CNY',
      mergeEnabled: !!panel.querySelector('[data-field="merge-enabled"]')?.checked,
      // 不缓存合并型号名(attr 9048):复用上次竞品的型号名会被 Ozon 错误并卡;
      // 只记「是否合并」,恢复时生成全新型号名(见 applyManualListingConfig)。
      uploadMode: panel.querySelector('input[name="jz-upload-mode"]:checked')?.value || 'api',
      applyPoster: !!panel.querySelector('[data-field="apply-poster"]')?.checked,
      posterPrimaryOnly: !!panel.querySelector('[data-field="poster-primary-only"]')?.checked,
      applyAiRewrite: !!panel.querySelector('[data-field="apply-ai-rewrite"]')?.checked,
      selectedWarehouseByStore,
      warehouseIdByStore: selectedWarehouseByStore,
      defaultStock,
      salePriceStrategy,
      lastBatchSalePriceStrategy,
      minPriceStrategy,
      lastBatchMinPriceStrategy,
      oldPriceStrategy,
      lastBatchOldPriceStrategy,
    };
  }

  function restoreManualSelectedStores(panel, cfg, storeList) {
    const savedStoreIds = Array.isArray(cfg?.selectedStoreIds)
      ? cfg.selectedStoreIds.map(String)
      : (Array.isArray(cfg?.storeIds) ? cfg.storeIds.map(String) : null);
    if (!savedStoreIds || !savedStoreIds.length) return;
    const validSet = new Set((storeList || []).map(s => String(s.id || s.storeId || '')));
    const toCheck = new Set(savedStoreIds.filter(id => validSet.has(id)));
    if (!toCheck.size) return;
    panel.querySelectorAll('.ozon-helper-mv-store-cb').forEach(cb => {
      cb.checked = toCheck.has(String(cb.value));
    });
    if (toCheck.size === 1) {
      rememberFollowSellWarehouseStore(panel, [...toCheck][0]);
    }
    panel._updateFooterCount?.();
  }

  function applyManualListingConfig(panel, cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    const setSelect = (field, val) => {
      if (typeof val !== 'string') return;
      const el = panel.querySelector(`[data-field="${field}"]`);
      if (el && [...el.options].some((o) => o.value === val)) el.value = val;
    };
    setSelect('brand', cfg.brand);
    setSelect('image-order', cfg.imageOrder);
    setSelect('currency', cfg.currency);

    const mergeInput = panel.querySelector('[data-field="merge-model"]');
    const mergeCb = panel.querySelector('[data-field="merge-enabled"]');
    // 只恢复「是否合并」偏好,不恢复型号名:勾上则生成全新型号名(JZ-<ts>),避免复用
    // 上次竞品的 9048 把不相关商品并到同一张卡(对齐 followSellMergeEnabled 安全设计)。
    if (mergeCb && typeof cfg.mergeEnabled === 'boolean') {
      mergeCb.checked = cfg.mergeEnabled;
      if (cfg.mergeEnabled && mergeInput && !mergeInput.value.trim()) {
        mergeInput.value = 'JZ-' + Date.now().toString(36).toUpperCase();
      }
    }

    const setChecked = (field, val) => {
      if (typeof val !== 'boolean') return;
      const el = panel.querySelector(`[data-field="${field}"]`);
      if (el && !el.disabled) el.checked = val;
    };
    setChecked('apply-poster', cfg.applyPoster);
    setChecked('poster-primary-only', cfg.posterPrimaryOnly);
    setChecked('apply-ai-rewrite', cfg.applyAiRewrite);
    if (typeof cfg.applyAiRewrite === 'boolean') panel._aiRewriteUserTouched = true;

    if (cfg.uploadMode === 'api' || cfg.uploadMode === 'portal') {
      const mode = panel.querySelector(`input[name="jz-upload-mode"][value="${cfg.uploadMode}"]`);
      if (mode) mode.checked = true;
    }

    const warehouseMap = cfg.selectedWarehouseByStore || cfg.warehouseIdByStore || {};
    if (warehouseMap && typeof warehouseMap === 'object') {
      panel._selectedWarehouseByStore = panel._selectedWarehouseByStore || new Map();
      Object.entries(warehouseMap).forEach(([storeId, warehouseId]) => {
        if (storeId && warehouseId) panel._selectedWarehouseByStore.set(String(storeId), String(warehouseId));
      });
      const currentStoreId = panel._followSellStoreId ? String(panel._followSellStoreId) : '';
      const whSelect = panel.querySelector('[data-field="warehouse-id"]');
      const currentWarehouseId = currentStoreId ? panel._selectedWarehouseByStore.get(currentStoreId) : '';
      if (whSelect && currentWarehouseId && [...whSelect.options].some((o) => String(o.value) === String(currentWarehouseId))) {
        whSelect.value = String(currentWarehouseId);
      }
    }

    applyRememberedVariantPricingAndStock(panel, cfg, { notifyPrice: true });
    panel._updateAiEnabledCount?.();
    panel._updatePosterEstimate?.();
    panel._maybeExpandAiCard?.();
  }

  function saveManualListingConfigAfterSuccess(panel, extra = {}) {
    _saveListingConfig({ ...captureManualListingConfig(panel), ...extra });
  }

  function renderEnterpriseStorePicker(panel, storeList, auth) {
    const dropdown = panel.querySelector('[data-field="store-dropdown"]');
    const oldTrigger = panel.querySelector('[data-action="toggle-stores"]');
    if (!dropdown || !oldTrigger) return;

    // Hide legacy dropdown (kept as source-of-truth for submit + footer count)
    dropdown.classList.add('ozon-helper-mv-store-dropdown-legacy');

    // Replace old trigger with pill (clone-replace clears legacy click listeners)
    const pill = document.createElement('div');
    pill.className = 'ozon-helper-mv-store-pill';
    pill.setAttribute('data-action', 'toggle-stores');
    oldTrigger.replaceWith(pill);

    // Scope hint row (shown below pill when there's selection)
    const scopeRow = document.createElement('div');
    scopeRow.className = 'ozon-helper-mv-store-pill-scope';
    scopeRow.style.display = 'none';
    pill.insertAdjacentElement('afterend', scopeRow);

    const renderPill = () => {
      const checked = dropdown.querySelectorAll('.ozon-helper-mv-store-cb:checked');
      const total = storeList.length;
      const sel = checked.length;
      if (sel === 0) {
        pill.innerHTML = `
          <span class="ohm-pill-empty">\u8bf7\u9009\u62e9\u5e97\u94fa</span>
          <span class="ohm-pill-meta">0 / ${total} \u5e97</span>
          <span class="ohm-pill-arrow">\u70b9\u51fb\u9009\u62e9 \u25be</span>`;
        scopeRow.style.display = 'none';
        scopeRow.innerHTML = '';
        return;
      }
      const samples = Array.from(checked).slice(0, 4).map(cb => {
        const id = cb.value;
        const s = storeList.find(x => String(x.id || x.storeId) === String(id));
        return s ? _buildStoreView(s) : { id, name: id, color: '#94a3b8', initials: '##', flag: '' };
      });
      const overflow = Math.max(0, sel - 4);
      pill.innerHTML = `
        <div class="ohm-pill-count"><strong>${sel}</strong><em>/ ${total} \u5e97</em></div>
        <span class="ohm-pill-divider"></span>
        <div class="ohm-pill-stack">
          ${samples.map(s => `<span class="ohm-pill-avatar" style="background:${s.color}" title="${_escHtml(s.name)}">${_escHtml(s.initials)}</span>`).join('')}
        </div>
        <span class="ohm-pill-names">${samples.map(s => _escHtml(s.name)).join(' \u00b7 ')}${overflow ? ` <em>+${overflow} \u4e2a</em>` : ''}</span>
        <span class="ohm-pill-arrow">\u70b9\u51fb\u4fee\u6539 \u25be</span>`;

      // Detect if selection matches "\u6700\u8fd1\u7528\u8fc7" rule
      _getRecentStoreIds().then(recentIds => {
        const recentSet = new Set(recentIds);
        const checkedIds = Array.from(checked).map(cb => String(cb.value));
        const allRecent = checkedIds.length > 0 && checkedIds.every(id => recentSet.has(id));
        const ruleLabel = allRecent ? `\u6700\u8fd1\u7528\u8fc7 (${sel})` : `\u5df2\u9009 ${sel} \u5bb6`;
        scopeRow.style.display = '';
        scopeRow.innerHTML = `
          <span class="ohm-pill-scope-label">\u9009\u62e9\u89c4\u5219</span>
          <span class="ohm-pill-scope-chip">${ruleLabel} <em data-action="clear-stores">\u00d7</em></span>
          <span class="ohm-pill-scope-hint">\u89c4\u5219\u4fdd\u5b58\u540e\uff0c\u65b0\u52a0\u5165\u7684\u5e97\u94fa\u4f1a\u81ea\u52a8\u5339\u914d</span>
        `;
      });
    };
    renderPill();
    dropdown.addEventListener('change', () => {
      renderPill();
      scheduleFollowSellWarehouseSync(panel);
    });

    // Clear all stores when \u00d7 clicked on scope chip
    scopeRow.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="clear-stores"]')) {
        dropdown.querySelectorAll('.ozon-helper-mv-store-cb:checked').forEach(cb => {
          cb.checked = false;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
    });

    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      _openStorePickerPopover(panel, storeList, dropdown, pill);
    });
  }

  function _openStorePickerPopover(panel, storeList, hiddenDropdown, pill) {
    document.querySelectorAll('.ozon-helper-mv-storepick-pop').forEach(p => p.remove());

    const views = storeList.map(_buildStoreView);

    _getRecentStoreIds().then(recentIds => {
      const recentSet = new Set(recentIds);
      views.forEach(v => v.lastUsed = recentSet.has(v.id));

      let query = '';
      let activeTab = '\u5168\u90e8'; // \u5168\u90e8 / \u5df2\u9009 / \u6700\u8fd1 / Premium

      const pop = document.createElement('div');
      pop.className = 'ozon-helper-mv-storepick-pop';
      document.body.appendChild(pop);

      const isChecked = (id) => !!hiddenDropdown.querySelector(`.ozon-helper-mv-store-cb[value="${_cssEscape(id)}"]`)?.checked;
      const setChecked = (id, val) => {
        const cb = hiddenDropdown.querySelector(`.ozon-helper-mv-store-cb[value="${_cssEscape(id)}"]`);
        if (cb && cb.checked !== val) {
          cb.checked = val;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };

      const filteredList = () => {
        let list = views.slice();
        if (activeTab === '\u5df2\u9009') list = list.filter(v => isChecked(v.id));
        else if (activeTab === '\u6700\u8fd1') list = list.filter(v => v.lastUsed);
        else if (activeTab === 'Premium') list = list.filter(v => v.tier === 'Premium');
        if (query) {
          const q = query.toLowerCase();
          list = list.filter(v =>
            v.name.toLowerCase().includes(q) ||
            v.code.includes(query) ||
            v.id.toLowerCase().includes(q)
          );
        }
        return list;
      };

      const renderPop = () => {
        const list = filteredList();
        const groupOrder = ['\u4fc4\u7f57\u65af', '\u767d\u4fc4\u7f57\u65af', '\u54c8\u8428\u514b\u65af\u5766', '\u5176\u5b83'];
        const grouped = groupOrder.map(g => ({ name: g, rows: list.filter(v => v.group === g) })).filter(g => g.rows.length);
        const counts = {
          '\u5168\u90e8': views.length,
          '\u5df2\u9009': hiddenDropdown.querySelectorAll('.ozon-helper-mv-store-cb:checked').length,
          '\u6700\u8fd1': views.filter(v => v.lastUsed).length,
          'Premium': views.filter(v => v.tier === 'Premium').length,
        };
        const tabs = ['\u5168\u90e8', '\u5df2\u9009', '\u6700\u8fd1', 'Premium'];
        const allInListChecked = list.length > 0 && list.every(v => isChecked(v.id));
        const totalSelected = counts['\u5df2\u9009'];

        pop.innerHTML = `
          <div class="ohm-sp-search">
            <span class="ohm-sp-search-icon">\u{1F50D}</span>
            <input type="text" class="ohm-sp-input" placeholder="\u641c\u5e97\u94fa\u540d / \u5e97\u94fa ID / \u6807\u7b7e\u2026" value="${_escHtml(query)}" />
          </div>
          <div class="ohm-sp-chips">
            <span class="ohm-sp-chips-label">\u5feb\u901f\u9009\u62e9</span>
            <span class="ohm-sp-chip" data-quick="all">\u5168\u90e8 ${counts['\u5168\u90e8']} \u5bb6</span>
            <span class="ohm-sp-chip" data-quick="premium">\u4ec5 Premium (${counts['Premium']})</span>
            <span class="ohm-sp-chip" data-quick="recent">\u6700\u8fd1\u7528\u8fc7 (${counts['\u6700\u8fd1']})</span>
            <span class="ohm-sp-chip" data-quick="invert">\u53cd\u9009</span>
            <span class="ohm-sp-chip is-danger" data-quick="clear">\u6e05\u7a7a</span>
          </div>
          <div class="ohm-sp-tabs">
            ${tabs.map(t => `<span class="ohm-sp-tab ${t===activeTab?'is-active':''}" data-tab="${t}">${t}<em>${counts[t]}</em></span>`).join('')}
          </div>
          <div class="ohm-sp-list-head">
            <label class="ohm-sp-allinscope">
              <input type="checkbox" data-action="select-in-scope" ${allInListChecked?'checked':''}/>
              \u5168\u9009\u5f53\u524d\u5217\u8868\uff08<b>${list.length}</b> \u5bb6\uff09
            </label>
          </div>
          <div class="ohm-sp-list">
            ${grouped.length === 0 ? '<div class="ohm-sp-empty">\u6ca1\u6709\u5339\u914d\u7684\u5e97\u94fa</div>' :
              grouped.map(g => `
                <div class="ohm-sp-group">
                  <div class="ohm-sp-group-head">
                    <span class="ohm-sp-group-dot"></span>
                    <span class="ohm-sp-group-name">${g.name}</span>
                    <span class="ohm-sp-group-count">${g.rows.filter(v => isChecked(v.id)).length} / ${g.rows.length}</span>
                    <span class="ohm-sp-group-action" data-group-all="${g.name}">\u672c\u7ec4\u5168\u9009</span>
                  </div>
                  ${g.rows.map(v => {
                    const checked = isChecked(v.id);
                    return `
                      <label class="ohm-sp-row ${checked?'is-checked':''}">
                        <input type="checkbox" class="ohm-sp-row-cb" data-id="${_escHtml(v.id)}" ${checked?'checked':''}/>
                        <span class="ohm-sp-avatar" style="background:${v.color}">${_escHtml(v.initials)}</span>
                        <span class="ohm-sp-info">
                          <span class="ohm-sp-name">${_escHtml(v.name)}${v.lastUsed ? ' <em class="ohm-sp-tag">\u6700\u8fd1</em>' : ''}</span>
                          <span class="ohm-sp-meta">${v.code}${v.flag ? ' \u00b7 ' + v.flag : ''}${v.tier === 'Premium' ? ' \u00b7 <b>Premium</b>' : ''}</span>
                        </span>
                        <span class="ohm-sp-only" data-only="${_escHtml(v.id)}">\u4ec5\u6b64\u5e97</span>
                      </label>
                    `;
                  }).join('')}
                </div>
              `).join('')}
          </div>
          <div class="ohm-sp-footer">
            <span class="ohm-sp-footer-count">\u5df2\u9009 <b>${totalSelected}</b> \u5bb6</span>
            <span class="ohm-sp-footer-spacer"></span>
            <button class="ohm-sp-btn ohm-sp-btn-ghost" data-action="close">\u53d6\u6d88</button>
            <button class="ohm-sp-btn ohm-sp-btn-primary" data-action="apply">\u5e94\u7528</button>
          </div>
        `;
        _positionPopover(pop, pill);
      };

      renderPop();

      pop.addEventListener('input', (e) => {
        if (e.target.classList?.contains('ohm-sp-input')) {
          query = e.target.value;
          const cursor = e.target.selectionStart;
          renderPop();
          const ip = pop.querySelector('.ohm-sp-input');
          if (ip) { ip.focus(); ip.setSelectionRange(cursor, cursor); }
        }
      });

      pop.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (tab) { activeTab = tab.getAttribute('data-tab'); renderPop(); return; }
        const quick = e.target.closest('[data-quick]');
        if (quick) {
          const t = quick.getAttribute('data-quick');
          if (t === 'all') views.forEach(v => setChecked(v.id, true));
          else if (t === 'premium') views.forEach(v => setChecked(v.id, v.tier === 'Premium'));
          else if (t === 'recent') views.forEach(v => setChecked(v.id, v.lastUsed));
          else if (t === 'invert') views.forEach(v => setChecked(v.id, !isChecked(v.id)));
          else if (t === 'clear') views.forEach(v => setChecked(v.id, false));
          renderPop();
          return;
        }
        const grpAll = e.target.closest('[data-group-all]');
        if (grpAll) {
          const g = grpAll.getAttribute('data-group-all');
          const allOn = views.filter(v => v.group === g).every(v => isChecked(v.id));
          views.filter(v => v.group === g).forEach(v => setChecked(v.id, !allOn));
          renderPop();
          return;
        }
        const onlyBtn = e.target.closest('[data-only]');
        if (onlyBtn) {
          const id = onlyBtn.getAttribute('data-only');
          views.forEach(v => setChecked(v.id, v.id === id));
          renderPop();
          return;
        }
        const close = e.target.closest('[data-action="close"]');
        if (close) { pop.remove(); return; }
        const apply = e.target.closest('[data-action="apply"]');
        if (apply) {
          const ids = Array.from(hiddenDropdown.querySelectorAll('.ozon-helper-mv-store-cb:checked')).map(cb => cb.value);
          _saveRecentStoreIds(ids);
          pop.remove();
          return;
        }
      });

      pop.addEventListener('change', (e) => {
        if (e.target.classList?.contains('ohm-sp-row-cb')) {
          setChecked(e.target.getAttribute('data-id'), e.target.checked);
          renderPop();
          return;
        }
        if (e.target.matches?.('[data-action="select-in-scope"]')) {
          filteredList().forEach(v => setChecked(v.id, e.target.checked));
          renderPop();
          return;
        }
      });

      // Outside click \u2192 close
      setTimeout(() => {
        const outside = (ev) => {
          if (!pop.contains(ev.target) && !pill.contains(ev.target)) {
            pop.remove();
            document.removeEventListener('mousedown', outside);
          }
        };
        document.addEventListener('mousedown', outside);
      }, 0);
    });
  }

  function _positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = `${rect.bottom + 6}px`;
    pop.style.left = `${rect.left}px`;
    pop.style.zIndex = '2147483647';
    // After paint, snap to viewport
    requestAnimationFrame(() => {
      const popRect = pop.getBoundingClientRect();
      if (popRect.right > window.innerWidth - 16) {
        pop.style.left = `${Math.max(16, window.innerWidth - popRect.width - 16)}px`;
      }
      if (popRect.bottom > window.innerHeight - 16) {
        pop.style.top = `${Math.max(16, rect.top - popRect.height - 6)}px`;
      }
    });
  }

  // ===== Multi-Variant Follow-Sell Panel =====

  const JZ_MV_SORT_STORAGE_KEY = 'jz-mv-variant-sort-v1';
  const JZ_MV_DEFAULT_SORT = { field: 'sales', order: 'desc' };
  const JZ_MV_SORTABLE_FIELDS = new Set([
    'originalPrice',
    'sales',
    'follow',
    'price',
    'minPrice',
    'oldPrice',
    'stock',
    'weight',
  ]);

  function jzReadMultiVariantSort() {
    try {
      const raw = window.localStorage?.getItem(JZ_MV_SORT_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (
        parsed &&
        JZ_MV_SORTABLE_FIELDS.has(parsed.field) &&
        (parsed.order === 'asc' || parsed.order === 'desc')
      ) {
        return { field: parsed.field, order: parsed.order };
      }
    } catch {}
    return { ...JZ_MV_DEFAULT_SORT };
  }

  function jzPersistMultiVariantSort(sortState) {
    try {
      window.localStorage?.setItem(
        JZ_MV_SORT_STORAGE_KEY,
        JSON.stringify({ field: sortState.field, order: sortState.order }),
      );
    } catch {}
  }

  function jzMultiVariantSortHeader(label, field, title = '') {
    const safeLabel = _escHtml(label);
    const safeTitle = _escHtml(title || `${label}排序`);
    return `<th class="ozon-helper-mv-sortable" data-sort-field="${field}" title="${safeTitle}">
      <span class="ozon-helper-mv-sort-label">${safeLabel}<span class="ozon-helper-mv-sort-icon" data-sort-icon="${field}">↕</span></span>
    </th>`;
  }

  function jzParseNumericText(value) {
    if (value == null) return null;
    let s = String(value).trim();
    if (!s || s === '-' || s === '—' || s === '…' || s === '暂无数据' || /登录/.test(s)) return null;
    s = s.replace(/\s+/g, '').replace(/[^\d,.\-]/g, '');
    if (!s) return null;
    const hasComma = s.includes(',');
    const hasDot = s.includes('.');
    if (hasComma && hasDot) {
      s = s.replace(/,/g, '');
    } else if (hasComma) {
      const parts = s.split(',');
      s = parts.length === 2 && parts[1].length <= 2
        ? `${parts[0]}.${parts[1]}`
        : s.replace(/,/g, '');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function jzReadMultiVariantSortValue(row, field) {
    const readInput = (selector) => jzParseNumericText(row.querySelector(selector)?.value);
    const readCell = (selector) => {
      const el = row.querySelector(selector);
      const raw = el?.dataset?.sortValue;
      return raw !== undefined && raw !== '' ? jzParseNumericText(raw) : jzParseNumericText(el?.textContent);
    };
    if (field === 'originalPrice') {
      const cell = row.querySelector('.ozon-helper-mv-price-original');
      return jzParseNumericText(cell?.dataset?.basePrice || cell?.textContent);
    }
    if (field === 'sales') return readCell('.ozon-helper-mv-sales');
    if (field === 'follow') return readCell('.ozon-helper-mv-follow');
    if (field === 'price') return readInput('.ozon-helper-mv-price');
    if (field === 'minPrice') return readInput('.ozon-helper-mv-minprice');
    if (field === 'oldPrice') return readInput('.ozon-helper-mv-oldprice');
    if (field === 'stock') return readInput('.ozon-helper-mv-stock');
    if (field === 'weight') return readInput('.ozon-helper-mv-weight');
    return null;
  }

  function jzHydrateMultiVariantSortHeaders(panel) {
    const sortState = panel._mvSortState || JZ_MV_DEFAULT_SORT;
    panel.querySelectorAll('.ozon-helper-mv-sortable').forEach((th) => {
      const field = th.getAttribute('data-sort-field');
      const active = field === sortState.field;
      th.classList.toggle('is-active', active);
      th.setAttribute('aria-sort', active ? (sortState.order === 'asc' ? 'ascending' : 'descending') : 'none');
      const icon = th.querySelector('.ozon-helper-mv-sort-icon');
      if (icon) icon.textContent = active ? (sortState.order === 'asc' ? '↑' : '↓') : '↕';
    });
  }

  function jzApplyMultiVariantSort(panel) {
    const tbody = panel.querySelector('[data-field="variant-tbody"]');
    if (!tbody) return;
    const sortState = panel._mvSortState || JZ_MV_DEFAULT_SORT;
    if (!JZ_MV_SORTABLE_FIELDS.has(sortState.field)) return;
    const rows = Array.from(tbody.querySelectorAll('tr')).map((row, index) => ({
      row,
      index,
      value: jzReadMultiVariantSortValue(row, sortState.field),
    }));
    rows.sort((a, b) => {
      const aMissing = a.value == null;
      const bMissing = b.value == null;
      if (aMissing && bMissing) return a.index - b.index;
      if (aMissing) return 1;
      if (bMissing) return -1;
      const delta = a.value - b.value;
      if (delta === 0) return a.index - b.index;
      return sortState.order === 'asc' ? delta : -delta;
    });
    rows.forEach(({ row }) => tbody.appendChild(row));
  }

  function jzRefreshMultiVariantSort(panel) {
    if (!panel?.isConnected) return;
    jzHydrateMultiVariantSortHeaders(panel);
    jzApplyMultiVariantSort(panel);
  }

  function jzUpdateMultiVariantDensity(panel) {
    if (!panel?.isConnected) return;
    const tbody = panel.querySelector('[data-field="variant-tbody"]');
    const rowCount = tbody ? tbody.querySelectorAll('tr').length : 0;
    if (rowCount > 0) {
      panel.dataset.variantDensity = rowCount >= 6 ? 'expanded' : 'normal';
    }
  }

  function jzFitMultiVariantTableViewport(panel) {
    if (!panel?.isConnected) return;
    const body = panel.querySelector('.ozon-helper-mv-body');
    const footer = panel.querySelector('.ozon-helper-mv-footer');
    const tableWrap = panel.querySelector('.ozon-helper-mv-card-table .ozon-helper-mv-table-wrap');
    if (!body || !footer || !tableWrap) return;

    jzUpdateMultiVariantDensity(panel);
    const bodyRect = body.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const tableRect = tableWrap.getBoundingClientRect();
    const visibleBottom = Math.min(bodyRect.bottom, footerRect.top);
    const available = visibleBottom - tableRect.top - 12;
    const expandedDensity = panel.dataset.variantDensity === 'expanded';
    const fallback = Math.min(window.innerHeight * (expandedDensity ? 0.62 : 0.52), expandedDensity ? 680 : 560);
    const rawMax = available > 160 ? available : fallback;
    const height = Math.floor(Math.max(220, Math.min(rawMax, window.innerHeight * (expandedDensity ? 0.82 : 0.72), expandedDensity ? 820 : 720)));

    tableWrap.style.setProperty('--oh-mv-table-max-height', `${height}px`);
  }

  function jzScheduleMultiVariantTableFit(panel) {
    if (!panel?.isConnected) return;
    if (panel._jzMvTableFitRaf) return;
    panel._jzMvTableFitRaf = requestAnimationFrame(() => {
      panel._jzMvTableFitRaf = 0;
      jzFitMultiVariantTableViewport(panel);
    });
  }

  function createMultiVariantFollowSellPanel(variants, preCollectedSourceMap = null, options = {}) {
    // Guarantee single panel node in DOM
    const previousPanel = document.querySelector('.ozon-helper-followsell-panel');
    if (previousPanel) {
      try { previousPanel._jzCleanup?.(); } catch {}
      previousPanel.remove();
    }

    const currentProduct = extractProductData();
    // 跟卖默认一律「无品牌」:跟卖的源商品多为注册商标(Nerf/MONCLER/NHL/Miu Miu…),
    // 复制源品牌 = 品牌侵权 → Ozon「违法复制禁令(copy prohibition)」下架(2026-06 实测)。
    // 「复制当前品牌」选项保留,用户确需复制可手动选(自负侵权风险)。
    const defaultBrandChoice = 'no_brand';
    const panel = document.createElement('div');
    panel.className = 'ozon-helper-panel ozon-helper-followsell-panel ozon-helper-multivariant-panel';
    panel.dataset.variantDensity = variants.length >= 6 ? 'expanded' : 'normal';
    // 跟卖本页商品卡:每个卡片是「独立商品」(各自类目),不是同一 listing 的兄弟变体。
    // 此模式下不能把所有变体强制对齐到锚点类目(见 handleMultiVariantFollowSell 类目一致性块)。
    if (options.independentProducts === true) panel.dataset.independentProducts = '1';

    // Collect aspect keys for variant info display
    const aspectKeys = [];
    for (const v of variants) {
      for (const key of Object.keys(v.aspectValues || {})) {
        if (!aspectKeys.includes(key)) aspectKeys.push(key);
      }
    }

    // Build variant rows
    const variantRowsHtml = variants.map((v, i) => {
      const checked = v.availability === 'inStock' || v.active ? 'checked' : '';
      const imgHtml = v.coverImage
        ? `<img src="${_escHtml(v.coverImage)}" referrerpolicy="no-referrer" class="ozon-helper-mv-thumb" data-oh-zoom="${_escHtml(v.coverImage)}" onerror="this.style.display='none'" />`
        : '<span style="color:#ccc;">-</span>';
      // Merge aspect values into variant cell (like competitor)
      const aspectText = aspectKeys
        .map(k => v.aspectValues[k] || '')
        .filter(Boolean)
        .join(' / ');
      const defaultSellPrice = '';
      const defaultOldPrice = v.price ? (v.price * 2).toFixed(2) : '';
      const isActive = v.availability === 'inStock' || v.active;
      // 渲染前剥角标:合并卡变体 tile 的 data.title 常是促销角标拼接(非商品名)。
      // 剥后剩残词(≈整串都是角标)则保留原文让用户看出异常 — 源属性到位后
      // _applySourcePlaceholders 会把这类标题换成 sv 4180 真名。
      // data-jz-base-title 记录渲染基线:提交时 DOM ≠ 基线 → 模板/手动改过,尊重编辑。
      const displayTitle = (() => {
        const raw = String(v.title || '');
        if (!raw || !window.jzStripPromo) return raw;
        const stripped = window.jzStripPromo(raw);
        if (window.jzIsPromoResidualTitle?.(raw, stripped)) return raw;
        return stripped || raw;
      })();
      const variantTitle = [displayTitle, aspectText].filter(Boolean).join(' / ');
      return `<tr data-sku="${_escHtml(v.sku)}" data-active="${isActive ? '1' : '0'}">
        <td><input type="checkbox" class="ozon-helper-mv-check" data-idx="${i}" ${checked} /></td>
        <td>${imgHtml}</td>
        <td class="ozon-helper-mv-variant-cell" title="${_escHtml(variantTitle)}">
          <div class="ozon-helper-mv-variant-name"><span class="ozon-helper-mv-variant-title-text" data-jz-base-title="${_escHtml(displayTitle)}">${_escHtml(displayTitle) || '-'}</span>${aspectText ? `<span class="ozon-helper-mv-variant-aspect"> / ${_escHtml(aspectText)}</span>` : ''}</div>
        </td>
        <td><span class="ozon-helper-mv-sku">${_escHtml(v.sku)}</span></td>
        <td><input type="text" class="ozon-helper-mv-offerid" data-idx="${i}" placeholder="\u81ea\u52a8" style="width:140px;" /></td>
        <td class="ozon-helper-mv-price-original" data-base-price="${v.price || 0}" data-source-currency="${v.priceCurrency || 'CNY'}" title="${v.priceRub ? `Ozon \u539f\u4ef7 \u20bd${window.formatNumber(v.priceRub)} \u00b7 \u4f30\u7b97 1CNY\u2248${_jzFxCnyToRub.toFixed(2)}RUB` : (v.priceCurrency && v.priceCurrency !== 'CNY' ? `Ozon \u539f\u5e01\u79cd ${v.priceCurrency},\u672a\u6362\u7b97` : '')}">${_JZ_CURRENCY_SYMBOLS[v.priceCurrency] || '\u00a5'}${v.price ? window.formatNumber(v.price, v.price % 1 === 0 ? 0 : 2) : '-'}<div class="ozon-helper-mv-price-converted" style="display:none;"></div></td>
        <td class="ozon-helper-mv-sales-cell"><span class="ozon-helper-mv-sales" data-idx="${i}" data-sku="${_escHtml(v.sku)}" style="color:#94a3b8;" title="近30天销量">…</span></td>
        <td class="ozon-helper-mv-follow-cell"><span class="ozon-helper-mv-follow" data-idx="${i}" data-sku="${_escHtml(v.sku)}" style="color:#94a3b8;" title="跟卖卖家数">…</span></td>
        <td><input type="number" min="0" step="0.01" class="ozon-helper-mv-price" data-idx="${i}" value="${defaultSellPrice}" style="width:80px;" /></td>
        <td><input type="number" min="0" step="0.01" class="ozon-helper-mv-minprice" data-idx="${i}" value="" placeholder="可不填" title="Ozon 自动调价的下限,留空 = 不参与" style="width:80px;background:#fafafa;" /></td>
        <td><input type="number" min="0" step="0.01" class="ozon-helper-mv-oldprice" data-idx="${i}" value="${defaultOldPrice}" style="width:80px;" /></td>
        <td><input type="number" min="0" step="1" class="ozon-helper-mv-stock" data-idx="${i}" value="10" style="width:60px;" /></td>
        <td>
          <div class="ozon-helper-mv-lwh-cell">
            <input type="number" min="0" step="1" class="ozon-helper-mv-depth" data-idx="${i}" placeholder="0" title="留空或填写 0 时，沿用跟卖商品原有长宽高" />
            <span class="ozon-helper-mv-lwh-sep">\u00d7</span>
            <input type="number" min="0" step="1" class="ozon-helper-mv-width" data-idx="${i}" placeholder="0" title="留空或填写 0 时，沿用跟卖商品原有长宽高" />
            <span class="ozon-helper-mv-lwh-sep">\u00d7</span>
            <input type="number" min="0" step="1" class="ozon-helper-mv-height" data-idx="${i}" placeholder="0" title="留空或填写 0 时，沿用跟卖商品原有长宽高" />
            <span class="ozon-helper-mv-lwh-unit">mm</span>
          </div>
        </td>
        <td>
          <div class="ozon-helper-mv-unit-cell">
            <input type="number" min="0" step="1" class="ozon-helper-mv-weight" data-idx="${i}" placeholder="0" title="留空或填写 0 时，沿用跟卖商品原有重量" />
            <span class="ozon-helper-mv-lwh-unit">g</span>
          </div>
        </td>
        <td><button class="ozon-helper-mv-delete-btn" data-idx="${i}" title="\u5220\u9664">\u5220\u9664</button></td>
      </tr>`;
    }).join('');

    panel.innerHTML = `
      <div class="ozon-helper-mv-dialog ozon-helper-mv-dialog-v2">
        <div class="ozon-helper-mv-header ozon-helper-mv-header-v2">
          <div class="ozon-helper-mv-header-left">
            <div class="ozon-helper-mv-header-text">
              <div class="ozon-helper-mv-header-title-row">
                <span class="ozon-helper-mv-header-title">\u4e00\u952e\u4e0a\u67b6\u5230 OZON</span>
                <span class="ozon-helper-mv-variant-badge" data-field="variant-badge">${variants.length} \u4e2a\u53d8\u4f53</span>
              </div>
              <span class="ozon-helper-mv-header-subtitle">\u91c7\u96c6\u7ade\u54c1\uff0c\u81ea\u52a8\u586b\u5145\uff0c\u4e00\u952e\u53d1\u5e03\u5230\u6307\u5b9a\u5e97\u94fa</span>
            </div>
          </div>
          <div class="ozon-helper-mv-header-right">
            <label class="ozon-helper-mv-toggle-label">
              <span>\u663e\u793a\u6240\u6709 SKU</span>
              <div class="ozon-helper-mv-toggle" data-field="show-all-sku">
                <input type="checkbox" checked />
                <span class="ozon-helper-mv-toggle-slider"></span>
                <span class="ozon-helper-mv-toggle-text-yes">\u662f</span>
                <span class="ozon-helper-mv-toggle-text-no">\u5426</span>
              </div>
            </label>
            <button class="ozon-helper-mv-close" data-action="close">&times;</button>
          </div>
        </div>

        <div class="ozon-helper-mv-membership" data-field="membership-bar" style="display:none;"></div>

        <div class="ozon-helper-mv-body">
          <!-- \u5e97\u94fa\u57fa\u7840\u5361 -->
          <div class="ozon-helper-mv-card ozon-helper-mv-card-shop">
            <div class="ozon-helper-mv-card-header">
              <div class="ozon-helper-mv-card-header-left">
                <span class="ozon-helper-mv-card-bar" style="background:#16A34A"></span>
                <span class="ozon-helper-mv-card-no">01</span>
                <span class="ozon-helper-mv-card-title">\u5e97\u94fa\u4e0e\u57fa\u7840</span>
                <span class="ozon-helper-mv-required-pill">\u5fc5\u586b</span>
              </div>
            </div>
            <div class="ozon-helper-mv-card-body">
              <div class="ozon-helper-mv-field-grid">
                <div class="ozon-helper-mv-field ozon-helper-mv-field-vertical">
                  <label class="ozon-helper-mv-label">
                    <span class="ozon-helper-mv-required">*</span> \u76ee\u6807\u5e97\u94fa
                    <em class="ozon-helper-mv-label-hint">\u652f\u6301\u4e0a\u767e\u5e97\u94fa \u00b7 \u641c\u7d22 / \u5206\u7ec4 / \u89c4\u5219\u4fdd\u5b58</em>
                  </label>
                  <div class="ozon-helper-mv-store-select" data-field="store-wrapper" style="width:100%;">
                    <div class="ozon-helper-mv-store-trigger" data-action="toggle-stores">\u52a0\u8f7d\u4e2d...</div>
                    <div class="ozon-helper-mv-store-dropdown" style="display:none;" data-field="store-dropdown"></div>
                  </div>
                </div>
                <div class="ozon-helper-mv-field ozon-helper-mv-field-vertical">
                  <label class="ozon-helper-mv-label"><span class="ozon-helper-mv-required">*</span> \u54c1\u724c</label>
                  <select data-field="brand">
                    <option value="no_brand" ${defaultBrandChoice === 'no_brand' ? 'selected' : ''}>\u65e0\u54c1\u724c</option>
                    <option value="copy" ${defaultBrandChoice === 'copy' ? 'selected' : ''}>\u590d\u5236\u5f53\u524d\u54c1\u724c</option>
                  </select>
                </div>
                <div class="ozon-helper-mv-field ozon-helper-mv-field-vertical">
                  <label class="ozon-helper-mv-label"><span class="ozon-helper-mv-required">*</span> \u56fe\u7247\u987a\u5e8f</label>
                  <select data-field="image-order">
                    <option value="keep">\u4e0d\u5904\u7406</option>
                    <option value="shuffle">\u968f\u673a\u6253\u4e71</option>
                    <option value="shuffle_keep_first">\u4e3b\u56fe\u4e0d\u53d8,\u5176\u4f59\u6253\u4e71</option>
                  </select>
                </div>
                <div class="ozon-helper-mv-field ozon-helper-mv-field-vertical">
                  <label class="ozon-helper-mv-label">\u4e0a\u67b6\u8d27\u5e01</label>
                  <select data-field="currency">
                    <option value="CNY">[\u00a5] \u4eba\u6c11\u5e01</option>
                    <option value="USD">[$] \u7f8e\u5143</option>
                    <option value="EUR">[\u20ac] \u6b27\u5143</option>
                    <option value="RUB">[\u20bd] \u5362\u5e03</option>
                  </select>
                </div>
                <div class="ozon-helper-mv-field ozon-helper-mv-field-vertical">
                  <label class="ozon-helper-mv-label ozon-helper-mv-merge-label" style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" data-field="merge-enabled" style="margin:0;width:14px;height:14px;cursor:pointer;flex:0 0 auto;" />\u5408\u5e76\u6210\u4e00\u5f20\u5361
                  </label>
                  <input type="text" data-field="merge-model" placeholder="\u52fe\u9009\u540e\u81ea\u52a8\u751f\u6210\u578b\u53f7\u540d,\u53ef\u6539;\u7559\u7a7a=\u4e0d\u5408\u5e76" title="\u52fe\u9009\u300c\u5408\u5e76\u6210\u4e00\u5f20\u5361\u300d\u540e\u6574\u7ec4\u53d8\u4f53\u5171\u4eab\u540c\u4e00\u578b\u53f7\u540d(attr 9048)\u2192 Ozon \u5408\u5e76\u4e3a\u540c\u4e00\u5f20\u5546\u54c1\u5361;\u7559\u7a7a=\u6bcf\u4e2a\u53d8\u4f53\u5404\u81ea\u72ec\u7acb\u6210\u5361\u3002\u8ddf\u5356\u540c\u4e00\u7ade\u54c1\u7684\u591a\u4e2a\u53d8\u4f53\u65f6\u52fe\u4e0a\u5373\u53ef\u5408\u5e76\u3002" style="margin-top:6px;" />
                  <div class="ozon-helper-mv-merge-hint" style="font-size:10px;color:#94a3b8;line-height:1.35;margin-top:4px;">⏳ 合并在 Ozon 端最多 24h 才生效;需同品牌·同类目(个别类目不支持)</div>
                </div>
              </div>
            </div>
          </div>

          <!-- AI \u589e\u5f3a\u5361\uff08\u6298\u53e0\u5f0f\uff09 -->
          <div class="ozon-helper-mv-card ozon-helper-mv-card-ai">
            <div class="ozon-helper-mv-card-header ozon-helper-mv-card-header-clickable" data-action="toggle-ai-section">
              <div class="ozon-helper-mv-card-header-left">
                <span class="ozon-helper-mv-card-bar" style="background:#0ea5e9"></span>
                <span class="ozon-helper-mv-card-no">02</span>
                <span class="ozon-helper-mv-card-title">AI \u589e\u5f3a</span>
                <span class="ozon-helper-mv-optional-pill">\u53ef\u9009</span>
                <span class="ozon-helper-mv-card-hint">AI \u5927\u6a21\u578b\u6539\u56fe / AI \u91cd\u5199 \u00b7 \u672a\u542f\u7528\u90fd\u53ef\u53d1\u5e03</span>
                <span class="ozon-helper-mv-ai-enabled-count" data-field="ai-enabled-count" style="display:none;">\u5df2\u542f\u7528 0</span>
              </div>
              <svg class="ozon-helper-mv-card-chevron" data-field="ai-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </div>
            <div class="ozon-helper-mv-card-body ozon-helper-mv-ai-grid ozon-helper-mv-card-body-collapsed" data-field="ai-section">
              <div class="ozon-helper-mv-opt-card ozon-helper-mv-opt-ai">
                <div class="ozon-helper-mv-opt-header">
                  <label class="ozon-helper-mv-opt-toggle">
                    <input type="checkbox" data-field="apply-poster" />
                    <span class="ozon-helper-mv-opt-toggle-slider"></span>
                  </label>
                  <span class="ozon-helper-mv-opt-title">AI \u5927\u6a21\u578b\u6539\u56fe</span>
                  <span class="ozon-helper-mv-gemini-badge">Gemini</span>
                </div>
                <div class="ozon-helper-mv-poster-extras" data-field="poster-extras" style="display:none;">
                  <label class="ozon-helper-mv-poster-primary-only" data-field="poster-primary-only-row" style="display:flex;align-items:center;gap:6px;font-size:12px;color:#475569;cursor:pointer;padding:4px 0;">
                    <input type="checkbox" data-field="poster-primary-only" />
                    <span>\u53ea\u6539\u4e3b\u56fe</span>
                    <span style="color:#94a3b8;font-size:11px;">(<span data-field="poster-n1-unit">\u6781\u70b9</span> N\u2192 1)</span>
                  </label>
                  <div class="ozon-helper-mv-cost-box" data-field="poster-cost-box">
                    <div class="ozon-helper-mv-cost-label">\u672c\u6b21\u9884\u4f30\u6d88\u8017</div>
                    <div class="ozon-helper-mv-cost-value"><span data-field="poster-cost-value">0</span> <span data-field="poster-cost-unit">\u6781\u70b9</span></div>
                    <div class="ozon-helper-mv-cost-breakdown" data-field="poster-cost-breakdown">\u2014</div>
                  </div>
                  <div class="ozon-helper-mv-balance-row" data-field="poster-balance-row" style="display:none;">
                    <div class="ozon-helper-mv-balance-left">
                      <span class="ozon-helper-mv-balance-icon" data-field="poster-balance-icon">\u2713</span>
                      <span data-field="poster-balance-text">\u4f59\u989d\uff1a\u2014 \u6781\u70b9</span>
                    </div>
                    <a class="ozon-helper-mv-recharge-link" data-field="poster-recharge-link" href="#" style="display:none;">\u53bb\u5145\u503c \u2192</a>
                  </div>
                  <div class="ozon-helper-mv-duration-hint">
                    <span class="ozon-helper-mv-duration-icon">\u23f1</span>
                    <span>\u7ea6 5\u201310 \u5206\u949f\u51fa\u56fe\uff0c\u671f\u95f4\u9875\u9762\u53ef\u3000\u95ed</span>
                  </div>
                </div>
                <div class="ozon-helper-mv-poster-disabled-hint" data-field="poster-disabled-hint">
                  Gemini \u5927\u6a21\u578b\u6539\u56fe \u00b7 100 \u5957\u6a21\u677f\u81ea\u52a8\u9009\u573a\u666f + \u6e32\u67d3\u4fc4\u6587 \u00b7 \u672a\u542f\u7528\u65f6\u5546\u54c1\u6309\u539f\u56fe\u76f4\u63a5\u53d1\u5e03
                </div>
              </div>
              <div class="ozon-helper-mv-opt-card ozon-helper-mv-opt-rewrite">
                <div class="ozon-helper-mv-opt-header">
                  <label class="ozon-helper-mv-opt-toggle">
                    <input type="checkbox" data-field="apply-ai-rewrite" />
                    <span class="ozon-helper-mv-opt-toggle-slider"></span>
                  </label>
                  <span class="ozon-helper-mv-opt-title">AI \u91cd\u5199</span>
                  <span class="ozon-helper-mv-ai-quota" data-field="ai-rewrite-quota"></span>
                </div>
                <span class="ozon-helper-mv-opt-desc">\u7ffb\u8bd1 + SEO \u4f18\u5316\u6807\u9898 / \u63cf\u8ff0</span>
              </div>
            </div>
          </div>

          <!-- \u7269\u6d41\u4ed3\u5e93 -->
          <div class="ozon-helper-mv-card" style="padding:10px 14px;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
              <span style="font-weight:600;color:#0f172a;font-size:13px;flex-shrink:0;">\u7269\u6d41\u4ed3\u5e93</span>
              <span style="font-size:12px;color:#64748b;flex:1;" data-field="warehouse-picker-hint">\u5e93\u5b58\u5c06\u5199\u5165\u5404\u5e97\u4ed3\u5e93\uff08\u53d8\u4f53\u8868\u683c\u8bbe\u7f6e\u5e93\u5b58\u540e\u751f\u6548\uff09</span>
            </div>
            <!-- Single-store picker:1 \u9009\u4e2d\u5e97\u65f6\u663e\u793a;\u591a\u9009\u65f6\u9690\u85cf,\u6539\u7528\u4e0b\u9762\u7684 per-store list -->
            <div data-field="warehouse-single-row" style="display:flex;align-items:center;gap:8px;">
              <select data-field="warehouse-id" style="flex:1;min-width:160px;height:28px;padding:0 8px;border:1px solid #e5e7eb;border-radius:6px;background:#fff;font-size:13px;">
                <option value="">\u52a0\u8f7d\u4e2d...</option>
              </select>
            </div>
            <!-- Multi-store picker:N \u884c per-store \u4ed3\u5e93\u9009\u62e9 -->
            <div data-field="warehouse-multi-list" style="display:none;flex-direction:column;gap:6px;"></div>
          </div>

          <!-- \u53d8\u4f53\u8868\u683c\u5361 -->
          <div class="ozon-helper-mv-card ozon-helper-mv-card-table">
            <div class="ozon-helper-mv-card-header">
              <div class="ozon-helper-mv-card-header-left">
                <span class="ozon-helper-mv-card-bar" style="background:#3B82F6"></span>
                <span class="ozon-helper-mv-card-no">03</span>
                <span class="ozon-helper-mv-card-title">\u53d8\u4f53\u5b9a\u4ef7\u4e0e\u89c4\u683c</span>
                <span class="ozon-helper-mv-card-hint">\u52fe\u9009\u8981\u4e0a\u67b6\u7684\u53d8\u4f53\uff0c\u586b\u5165\u552e\u4ef7/\u5212\u7ebf\u4ef7/\u5e93\u5b58\uff1b\u957f\u5bbd\u9ad8/\u91cd\u91cf\u7559\u7a7a\u6216 0 = \u6cbf\u7528\u8ddf\u5356\u5546\u54c1\u5c5e\u6027</span>
              </div>
            </div>
            <div class="ozon-helper-mv-phys-hint">
              <span class="ozon-helper-mv-phys-hint-badge">提示</span>
              <span>长宽高、重量 <strong>留空或填写 0</strong> 时，不会覆盖原商品规格；只有输入大于 0 的值才会改写。</span>
            </div>
            <div class="ozon-helper-mv-table-wrap">
              <table class="ozon-helper-mv-table">
                <thead>
                  <tr>
                    <th style="width:36px;"><input type="checkbox" class="ozon-helper-mv-check" data-action="select-all" checked /></th>
                    <th>\u4e3b\u56fe</th>
                    <th>\u53d8\u4f53</th>
                    <th>
                      <div class="ozon-helper-mv-th-head">
                        <span>SKU</span>
                        <button type="button" class="ozon-helper-mv-copy-btn" data-action="copy-skus" title="复制当前变体 SKU">复制SKU</button>
                      </div>
                    </th>
                    <th style="min-width:160px;">
                      <div class="ozon-helper-mv-th-head">
                        <span>\u8d27\u53f7</span>
                        <button type="button" class="ozon-helper-mv-copy-btn" data-action="copy-offerids" title="复制当前变体货号">复制货号</button>
                      </div>
                      <div style="display:flex;align-items:center;gap:4px;margin-top:2px;font-weight:400;font-size:11px;color:#64748b;">
                        <span>\u524d\u7f00</span>
                        <input type="text" data-field="offerid-prefix" placeholder="jz-" maxlength="20" style="width:64px;height:20px;padding:0 4px;border:1px solid #e5e7eb;border-radius:3px;font-size:11px;font-family:inherit;background:#fff;" />
                        <span class="ozon-helper-mv-th-action" data-action="auto-offerid" style="margin-left:auto;">\u4e00\u952e\u751f\u6210</span>
                      </div>
                    </th>
                    ${jzMultiVariantSortHeader('\u539f\u552e\u4ef7', 'originalPrice', '\u6309\u539f\u552e\u4ef7\u6392\u5e8f')}
                    ${jzMultiVariantSortHeader('\u6708\u9500\u91cf', 'sales', '\u8fd130\u5929\u9500\u91cf \u00b7 \u9ed8\u8ba4\u4ece\u9ad8\u5230\u4f4e')}
                    ${jzMultiVariantSortHeader('\u8ddf\u5356\u6570\u91cf', 'follow', '\u8ddf\u5356\u8be5\u5546\u54c1\u7684\u5356\u5bb6\u6570 \u00b7 \u53ef\u70b9\u51fb\u6392\u5e8f')}
                    <th class="ozon-helper-mv-sortable" data-sort-field="price" style="position:relative;">\u5b9e\u9645\u552e\u4ef7 <span class="ozon-helper-mv-sort-icon" data-sort-icon="price">↕</span> <span class="ozon-helper-mv-th-action" data-action="batch-price">\u6279\u91cf\u8bbe\u7f6e</span></th>
                    <th class="ozon-helper-mv-sortable" data-sort-field="minPrice" style="position:relative;" title="Ozon \u81ea\u52a8\u8c03\u4ef7\u7684\u4e0b\u9650 \u2014 \u5e73\u53f0\u4fc3\u9500\u65f6\u4e0d\u4f1a\u4f4e\u4e8e\u6b64\u4ef7\u3002\u9009\u586b,\u7559\u7a7a = \u4e0d\u53c2\u4e0e\u81ea\u52a8\u8c03\u4ef7">\u6700\u4f4e\u4ef7 <span class="ozon-helper-mv-sort-icon" data-sort-icon="minPrice">↕</span> <span style="font-weight:400;font-size:11px;color:#94a3b8;">\u9009\u586b</span> <span class="ozon-helper-mv-th-action" data-action="batch-minprice">\u6279\u91cf\u8bbe\u7f6e</span></th>
                    <th class="ozon-helper-mv-sortable" data-sort-field="oldPrice" style="position:relative;">\u6211\u7684\u5212\u7ebf\u4ef7 <span class="ozon-helper-mv-sort-icon" data-sort-icon="oldPrice">↕</span> <span class="ozon-helper-mv-th-action" data-action="batch-oldprice">\u6279\u91cf\u8bbe\u7f6e</span></th>
                    <th class="ozon-helper-mv-sortable" data-sort-field="stock" style="position:relative;">\u6211\u7684\u5e93\u5b58 <span class="ozon-helper-mv-sort-icon" data-sort-icon="stock">↕</span> <span class="ozon-helper-mv-th-action" data-action="batch-stock">\u6279\u91cf\u8bbe\u7f6e</span></th>
                    <th style="position:relative;">
                      <span>\u957f \u00d7 \u5bbd \u00d7 \u9ad8</span>
                      <span class="ozon-helper-mv-inherit-chip" title="留空或填写 0 时沿用跟卖商品原有长宽高">0 沿用原值</span>
                      <span class="ozon-helper-mv-th-action" data-action="batch-dims">\u6279\u91cf\u8bbe\u7f6e</span>
                    </th>
                    <th class="ozon-helper-mv-sortable" data-sort-field="weight" style="position:relative;">
                      <span>\u91cd\u91cf</span>
                      <span class="ozon-helper-mv-sort-icon" data-sort-icon="weight">↕</span>
                      <span class="ozon-helper-mv-inherit-chip" title="留空或填写 0 时沿用跟卖商品原有重量">0 沿用原值</span>
                      <span class="ozon-helper-mv-th-action" data-action="batch-weight">\u6279\u91cf\u8bbe\u7f6e</span>
                    </th>
                    <th>\u64cd\u4f5c</th>
                  </tr>
                </thead>
                <tbody data-field="variant-tbody">${variantRowsHtml}</tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="ozon-helper-mv-status" data-field="mv-status" style="display:none;"></div>

        <div class="ozon-helper-mv-upload-mode" data-field="upload-mode-row" style="display:none;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 14px;margin-bottom:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
          <span style="font-weight:600;color:#0f172a;font-size:13px;">上架方式</span>
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;color:#334155;cursor:pointer;">
            <input type="radio" name="jz-upload-mode" data-field="upload-mode" value="api" checked /> API 上架
          </label>
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;color:#334155;cursor:pointer;">
            <input type="radio" name="jz-upload-mode" data-field="upload-mode" value="portal" /> 模拟手动上架
          </label>
          <span style="color:#94a3b8;font-size:11px;flex-basis:100%;line-height:1.5;">模拟手动上架：走卖家中心网页通道（像你手动建品），绕官方接口限流。<strong style="color:#b45309;">仅支持单店</strong>，且需已登录 seller.ozon.ru 的该店铺</span>
        </div>

        <div class="ozon-helper-mv-footer ozon-helper-mv-footer-v2">
          <div class="ozon-helper-mv-footer-left">
            <div class="ozon-helper-mv-footer-stat-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            </div>
            <div class="ozon-helper-mv-footer-stat">
              <span class="ozon-helper-mv-footer-meta">\u63d0\u4ea4\u540e\u5c06\u521b\u5efa</span>
              <span class="ozon-helper-mv-footer-count">
                <strong data-field="footer-publish-count">${variants.filter(v => v.availability === 'inStock' || v.active).length}</strong>
                <span class="ozon-helper-mv-footer-breakdown">\u6761\u4e0a\u67b6 \u00b7 <strong data-field="footer-selected-count">${variants.filter(v => v.availability === 'inStock' || v.active).length}</strong> \u53d8\u4f53 \u00d7 <strong data-field="footer-store-count">1</strong> \u5e97\u94fa</span>
              </span>
              <span class="ozon-helper-mv-footer-hint">\u63d0\u4ea4\u540e\u5c06\u81ea\u52a8\u540c\u6b65\u56fe\u7247\u3001\u5c5e\u6027\u548c\u5e93\u5b58</span>
            </div>
          </div>
          <div class="ozon-helper-mv-footer-right">
            <button class="ozon-helper-mv-btn-secondary" data-action="cancel">\u53d6\u6d88</button>
            <button class="ozon-helper-mv-btn-primary ozon-helper-mv-btn-primary-v2" data-action="confirm">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              \u4e00\u952e\u4e0a\u67b6\u81f3 OZON
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    panel._mvSortState = jzReadMultiVariantSort();
    panel.querySelectorAll('.ozon-helper-mv-sortable').forEach((th) => {
      th.addEventListener('click', (e) => {
        if (e.target.closest('.ozon-helper-mv-th-action, input, select, button, a')) return;
        const field = th.getAttribute('data-sort-field');
        if (!JZ_MV_SORTABLE_FIELDS.has(field)) return;
        const prev = panel._mvSortState || JZ_MV_DEFAULT_SORT;
        const order = prev.field === field && prev.order === 'desc' ? 'asc' : 'desc';
        const sortState = { field, order };
        panel._mvSortState = sortState;
        jzPersistMultiVariantSort(sortState);
        jzRefreshMultiVariantSort(panel);
      });
    });
    jzRefreshMultiVariantSort(panel);

    // \u5f02\u6b65\u62c9\u53d6\u6bcf\u4e2a\u53d8\u4f53 SKU \u7684\u300c\u5f53\u524d\u9500\u91cf\u300d(\u8fd130\u5929,\u6765\u81ea Ozon \u9009\u54c1\u5206\u6790 what_to_sell,
    // \u4e0e\u6570\u636e\u9762\u677f\u540c\u6e90 getMarketStats)\u3002\u9010 SKU \u62c9\u3001\u4f4e\u5e76\u53d1,\u907f\u514d\u5237\u7206 seller tab \u6ce8\u5165;
    // \u672a\u767b\u5f55\u5356\u5bb6\u4e2d\u5fc3\u5219\u6574\u5217\u663e\u793a\u300c\u9700\u767b\u5f55\u300d,\u65e0\u6570\u636e\u663e\u793a\u300c\u2014\u300d\u3002
    (async () => {
      const cells = Array.from(panel.querySelectorAll('.ozon-helper-mv-sales'));
      if (!cells.length) return;
      const setCell = (cell, text, title) => {
        if (!cell) return;
        cell.textContent = text;
        if (title) cell.title = title;
      };
      const fillCell = (cell, data) => {
        if (data && data.soldCount != null) {
          cell.dataset.sortValue = String(Number(data.soldCount));
          setCell(cell, window.formatNumber(Number(data.soldCount)), `\u8fd130\u5929\u9500\u91cf ${data.soldCount}`);
          cell.style.color = '';
        } else {
          cell.dataset.sortValue = '';
          setCell(cell, '\u2014', '\u6682\u65e0\u9500\u91cf\u6570\u636e');
        }
        cell.dataset.jzFilled = '1';
      };
      let aborted = false;
      const markAllNeedLogin = () => {
        aborted = true;
        cells.forEach((c) => {
          if (c.dataset.jzFilled !== '1') {
            c.dataset.sortValue = '';
            // \u7ea2\u8272\u300c\u9700\u767b\u5f55\u300d\u4e0e\u5361\u7247\u7ea2\u8272\u63d0\u793a\u6761\u7edf\u4e00\u53e3\u5f84(\u8bf7\u767b\u5f55\u5356\u5bb6\u4e2d\u5fc3\u540e\u67e5\u770b\u9500\u91cf)
            setCell(c, '\u9700\u767b\u5f55', '\u8bf7\u767b\u5f55 Ozon \u5356\u5bb6\u540e\u53f0\u540e\u67e5\u770b\u9500\u91cf');
            c.style.color = '#cf1322';
          }
        });
      };
      // \u5408\u6279\u5feb\u8def(\u7070\u5ea6 fleet \u670d\u52a1\u7aef\u5316):\u4e00\u6761\u6d88\u606f\u62ff\u6574\u5217,SW \u4fa7\u672c\u5730 memo+\u6279\u91cf\u7aef\u70b9+
      // \u5355\u6761\u8865\u62c9\u5168\u515c\u4f4f;\u53ea\u6709 pending \u6b8b\u4f59\u964d\u7ea7\u5230\u4e0b\u9762\u7684\u9010 SKU worker \u6c60\u8001\u8def\u3002
      // supported:false(\u975e\u7070\u5ea6/\u672a\u767b\u5f55)\u65f6 remaining \u4fdd\u6301\u6574\u5217 \u2192 \u884c\u4e3a\u4e0e\u4ece\u524d\u5b8c\u5168\u4e00\u81f4
      // (\u7ea2\u7ebf:\u975e\u7070\u5ea6\u7528\u6237\u7684\u5e76\u53d1\u4e0d\u80fd\u6253\u5230 seller tab \u6ce8\u5165)\u3002
      let remaining = cells;
      try {
        const batchSkus = [...new Set(cells.map((c) => c.getAttribute('data-sku')).filter(Boolean))];
        if (batchSkus.length) {
          const batch = await window.sendMessage('getMarketStatsBatch', {
            skus: batchSkus,
            period: window.jzGetSalesPeriod?.() || 'monthly',
          });
          if (batch && batch.supported) {
            const results = batch.results || {};
            const pendingSet = new Set(batch.pending || []);
            remaining = [];
            for (const cell of cells) {
              const sku = cell.getAttribute('data-sku');
              if (!sku) { cell.dataset.sortValue = ''; setCell(cell, '\u2014', '\u6682\u65e0\u9500\u91cf\u6570\u636e'); cell.dataset.jzFilled = '1'; continue; }
              if (pendingSet.has(sku)) { remaining.push(cell); continue; }
              fillCell(cell, results[sku] ?? null);
            }
            jzRefreshMultiVariantSort(panel);
            if (!remaining.length) return;
          }
        }
      } catch (e) {
        remaining = cells; // \u5408\u6279\u6d88\u606f\u5931\u8d25(\u8d85\u65f6/SW \u91cd\u542f)\u6574\u5217\u56de\u843d worker \u6c60\u8001\u8def
      }
      let cursor = 0;
      const worker = async () => {
        while (!aborted && cursor < remaining.length) {
          const cell = remaining[cursor++];
          const sku = cell.getAttribute('data-sku');
          if (!sku) { cell.dataset.sortValue = ''; setCell(cell, '\u2014', '\u6682\u65e0\u9500\u91cf\u6570\u636e'); cell.dataset.jzFilled = '1'; continue; }
          let data = null;
          try {
            data = await window.sendMessage('getMarketStats', { sku, period: window.jzGetSalesPeriod?.() || 'monthly' });
          } catch (e) {
            data = null;
          }
          if (aborted) return;
          if (data && data.__needSellerLogin) { markAllNeedLogin(); return; }
          fillCell(cell, data);
        }
      };
      const CONCURRENCY = 4;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, remaining.length) }, () => worker()),
      );
      jzRefreshMultiVariantSort(panel);
    })();

    // 异步拉每个变体的「跟卖数量」(跟卖该商品的卖家数,来自 Ozon 公开「其他卖家」弹窗,
    // 走 www 买家侧、无需登录卖家中心,与上方「月销量」的 seller 数据独立)。逐 SKU 低并发,
    // 复用 jzFetchPublicFollowSellCount 自带的失败熔断;无数据/失败显示「—」。
    (async () => {
      const cells = Array.from(panel.querySelectorAll('.ozon-helper-mv-follow'));
      if (!cells.length) return;
      if (typeof window.jzFetchPublicFollowSellCount !== 'function') {
        cells.forEach((c) => { c.dataset.sortValue = ''; c.textContent = '—'; });
        return;
      }
      let cursor = 0;
      const worker = async () => {
        while (cursor < cells.length) {
          const cell = cells[cursor++];
          const sku = cell.getAttribute('data-sku');
          if (!sku) { cell.dataset.sortValue = ''; cell.textContent = '—'; continue; }
          let count = null;
          try {
            count = await window.jzFetchPublicFollowSellCount(sku);
          } catch (e) {
            count = null;
          }
          if (count != null && Number.isFinite(Number(count))) {
            cell.dataset.sortValue = String(Number(count));
            cell.textContent = window.formatNumber(Number(count));
            cell.style.color = '';
            cell.title = `跟卖卖家数 ${count}`;
          } else {
            cell.dataset.sortValue = '';
            cell.textContent = '—';
            cell.title = '暂无跟卖数据';
          }
        }
      };
      const FOLLOW_CONCURRENCY = 3;
      await Promise.all(
        Array.from({ length: Math.min(FOLLOW_CONCURRENCY, cells.length) }, () => worker()),
      );
      jzRefreshMultiVariantSort(panel);
    })();

    // Load warehouses for current/selected store and populate the warehouse select.
    // Warehouse ID is seller-scoped, so switching stores must switch the option list too.
    (async () => {
      const whSelect = panel.querySelector('[data-field="warehouse-id"]');
      if (!whSelect) return;
      panel._selectedWarehouseByStore = panel._selectedWarehouseByStore || new Map();
      whSelect.addEventListener('change', () => {
        const sid = panel._followSellStoreId ? String(panel._followSellStoreId) : '';
        if (sid && whSelect.value) {
          panel._selectedWarehouseByStore.set(sid, String(whSelect.value));
          persistFollowSellWarehouse(sid, whSelect.value);
        }
      });
      const auth = await window.sendMessage('getAuth').catch(() => ({}));
      await loadFollowSellWarehousesForStore(panel, auth?.storeId || '');
    })();

    // Click overlay backdrop to close
    panel.addEventListener('click', (e) => {
      if (e.target === panel) closePanel(panel);
    });

    // Wheel isolation on body scroll area.
    // Keep the table deterministic across mouse wheels, precision touchpads and
    // browser zoom levels: when the pointer is inside the variant table, the
    // table consumes wheel movement first; only the remaining delta is passed to
    // the modal body. This avoids the old "body alignment first" heuristic that
    // could swallow downward scrolling on some devices.
    const mvBody = panel.querySelector('.ozon-helper-mv-body');
    if (mvBody) {
      const jzScheduleFit = () => jzScheduleMultiVariantTableFit(panel);
      jzScheduleFit();
      requestAnimationFrame(jzScheduleFit);
      setTimeout(jzScheduleFit, 120);
      window.addEventListener('resize', jzScheduleFit);
      mvBody.addEventListener('scroll', jzScheduleFit, { passive: true });
      panel._jzCleanup = () => {
        window.removeEventListener('resize', jzScheduleFit);
        mvBody.removeEventListener('scroll', jzScheduleFit);
        if (panel._jzMvTableFitRaf) {
          cancelAnimationFrame(panel._jzMvTableFitRaf);
          panel._jzMvTableFitRaf = 0;
        }
      };

      const WHEEL_EPS = 0.5;
      const normalizeWheelDelta = (delta, mode, pageSize) => {
        const raw = Number(delta) || 0;
        if (!raw) return 0;
        if (mode === 1) return raw * 16; // DOM_DELTA_LINE
        if (mode === 2) return raw * Math.max(1, pageSize || window.innerHeight || 800); // DOM_DELTA_PAGE
        return raw; // DOM_DELTA_PIXEL
      };
      const scrollElementBy = (el, amount, axis = 'y') => {
        if (!el || !Number.isFinite(amount) || Math.abs(amount) <= WHEEL_EPS) return 0;
        const prop = axis === 'x' ? 'scrollLeft' : 'scrollTop';
        const sizeProp = axis === 'x' ? 'scrollWidth' : 'scrollHeight';
        const clientProp = axis === 'x' ? 'clientWidth' : 'clientHeight';
        const max = Math.max(0, (el[sizeProp] || 0) - (el[clientProp] || 0));
        const before = el[prop] || 0;
        const next = Math.max(0, Math.min(max, before + amount));
        if (Math.abs(next - before) <= WHEEL_EPS) return 0;
        el[prop] = next;
        return (el[prop] || 0) - before;
      };
      mvBody.addEventListener('wheel', (e) => {
        const tableWrap = panel.querySelector('.ozon-helper-mv-card-table .ozon-helper-mv-table-wrap');
        const fromTable = tableWrap && tableWrap.contains(e.target);
        let deltaY = normalizeWheelDelta(e.deltaY, e.deltaMode, mvBody.clientHeight);
        let deltaX = normalizeWheelDelta(e.deltaX, e.deltaMode, tableWrap?.clientWidth || mvBody.clientWidth);

        if (fromTable) {
          let handled = false;

          // Shift + wheel is the standard horizontal-scroll gesture for many
          // non-precision mouse wheels. Treat it as horizontal table scrolling
          // when the device does not already provide deltaX.
          if (e.shiftKey && Math.abs(deltaX) <= WHEEL_EPS && Math.abs(deltaY) > WHEEL_EPS) {
            deltaX = deltaY;
            deltaY = 0;
          }

          if (Math.abs(deltaX) > WHEEL_EPS) {
            scrollElementBy(tableWrap, deltaX, 'x');
            handled = true;
          }

          if (Math.abs(deltaY) > WHEEL_EPS) {
            const consumedByTable = scrollElementBy(tableWrap, deltaY, 'y');
            const remainingY = deltaY - consumedByTable;
            if (Math.abs(remainingY) > WHEEL_EPS) {
              scrollElementBy(mvBody, remainingY, 'y');
            }
            handled = true;
          }

          if (handled) {
            e.preventDefault();
            e.stopPropagation();
          }
          e.stopPropagation();
          return;
        }

        const atTop = mvBody.scrollTop <= WHEEL_EPS && deltaY < 0;
        const atBottom =
          mvBody.scrollTop + mvBody.clientHeight >= mvBody.scrollHeight - WHEEL_EPS &&
          deltaY > 0;
        if (atTop || atBottom) e.preventDefault();
        e.stopPropagation();
      }, { passive: false });
    }

    // Close/cancel
    panel.querySelector('[data-action="close"]').addEventListener('click', () => closePanel(panel));
    panel.querySelector('[data-action="cancel"]').addEventListener('click', () => closePanel(panel));

    // 「合并成一张卡」勾选 ↔ 型号名(attr 9048):勾选且型号空 → 自动生成共享型号名
    // (JZ-…)→ 整组变体合并为同一张卡;取消勾选 → 清空(每个变体各自独立成卡)。
    // 手动改型号也同步勾选态。与批量上架(cfg-merge-model)同款交互。
    const mergeCb = panel.querySelector('[data-field="merge-enabled"]');
    const mergeInput = panel.querySelector('[data-field="merge-model"]');
    if (mergeCb && mergeInput) {
      const genMergeModel = () => 'JZ-' + Date.now().toString(36).toUpperCase();
      // 只缓存「是否合并」偏好,不缓存型号名:每次开面板重新生成新型号名,
      // 避免不同竞品复用同一型号名(attr 9048)被 Ozon 错误并到一张卡。
      const persistMerge = (on) => { try { chrome.storage.local.set({ followSellMergeEnabled: !!on }); } catch (e) {} };
      mergeCb.checked = !!mergeInput.value.trim(); // 复用上次填的型号时回显勾选
      mergeCb.addEventListener('change', () => {
        if (mergeCb.checked) {
          if (!mergeInput.value.trim()) mergeInput.value = genMergeModel();
          mergeInput.focus();
        } else {
          mergeInput.value = '';
        }
        persistMerge(mergeCb.checked);
      });
      mergeInput.addEventListener('input', () => {
        const on = !!mergeInput.value.trim();
        if (on !== mergeCb.checked) { mergeCb.checked = on; persistMerge(on); } // 勾选 ⟺ 有型号名
      });
      // 恢复上次的「合并」偏好:之前勾过则自动勾上并生成新型号名(仅在留空时生成)。
      try {
        chrome.storage.local.get(['followSellMergeEnabled'], (r) => {
          if (r && r.followSellMergeEnabled && !mergeCb.checked) {
            mergeCb.checked = true;
            if (!mergeInput.value.trim()) mergeInput.value = genMergeModel();
          }
        });
      } catch (e) {}
    }

    // AI 卡折叠（默认折叠以节省纵向空间；点击 header 切换）
    const aiHeaderToggle = panel.querySelector('[data-action="toggle-ai-section"]');
    const aiSectionBody = panel.querySelector('[data-field="ai-section"]');
    const aiChevron = panel.querySelector('[data-field="ai-chevron"]');
    if (aiChevron) aiChevron.style.transform = 'rotate(-90deg)';
    if (aiHeaderToggle && aiSectionBody) {
      aiHeaderToggle.addEventListener('click', () => {
        const collapsed = aiSectionBody.classList.toggle('ozon-helper-mv-card-body-collapsed');
        if (aiChevron) aiChevron.style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0)';
      });
    }
    // 有任一 AI 选项启用时展开 AI 卡。
    panel._maybeExpandAiCard = () => {
      const anyEnabled = ['apply-poster', 'apply-ai-rewrite']
        .some((f) => panel.querySelector(`[data-field="${f}"]`)?.checked);
      if (anyEnabled && aiSectionBody) {
        aiSectionBody.classList.remove('ozon-helper-mv-card-body-collapsed');
        if (aiChevron) aiChevron.style.transform = 'rotate(0)';
      }
    };

    // AI 启用计数同步 + 启用项卡片高亮 (.is-on)
    // V1 旧版 ai-image 已下线，仅 V2 海报
    const updateAiEnabledCount = () => {
      const checks = ['apply-poster', 'apply-ai-rewrite'];
      let enabled = 0;
      checks.forEach((f) => {
        const cb = panel.querySelector(`[data-field="${f}"]`);
        if (!cb) return;
        const card = cb.closest('.ozon-helper-mv-opt-card');
        if (cb.checked) {
          enabled++;
          card?.classList.add('is-on');
        } else {
          card?.classList.remove('is-on');
        }
      });
      const badge = panel.querySelector('[data-field="ai-enabled-count"]');
      if (badge) {
        if (enabled > 0) {
          badge.style.display = '';
          badge.textContent = `已启用 ${enabled}`;
        } else {
          badge.style.display = 'none';
        }
      }
    };
    // loadAiQuota(分离的顶层函数,不在本闭包作用域内)给会员默认勾选 AI 重写后,
    // 需要刷新「已启用 N」徽标 —— 通过 panel 暴露(同 panel._updatePosterEstimate 模式)。
    panel._updateAiEnabledCount = updateAiEnabledCount;
    ['apply-poster', 'apply-ai-rewrite'].forEach((f) => {
      panel.querySelector(`[data-field="${f}"]`)?.addEventListener('change', updateAiEnabledCount);
    });
    // 用户手动动过 AI 重写开关后,loadAiQuota 的「会员默认勾选」不再覆盖其选择。
    panel.querySelector('[data-field="apply-ai-rewrite"]')?.addEventListener('change', () => {
      panel._aiRewriteUserTouched = true;
    });

    // ── AI 海报：成本预估 + 余额对比 + 耗时提示 ──
    // 估算用 pageProduct.images.length（页面图册），如未抓到则回退 1 张
    // 单价从 getAiQuota 返回值 (q.aiImage.price) 读，超管可在后台调整；拉不到 fallback 50
    const POSTER_COST_PER_IMAGE_V2_DEFAULT = 50;
    const RECHARGE_PATH_V2 = '/ozon/settings/jidian';
    const updatePosterEstimateV2 = () => {
      const enabled = panel.querySelector('[data-field="apply-poster"]')?.checked || false;
      const extras = panel.querySelector('[data-field="poster-extras"]');
      const disabledHint = panel.querySelector('[data-field="poster-disabled-hint"]');
      if (!extras || !disabledHint) return;
      extras.style.display = enabled ? '' : 'none';
      disabledHint.style.display = enabled ? 'none' : '';
      if (!enabled) return;

      const variantCount = panel.querySelectorAll('.ozon-helper-mv-check[data-idx]:checked').length;
      // pageProduct 图册作为每变体图数近似（变体多数共享同一 gallery）；fallback 至少 1
      const fullImagesPerVariant = Math.max(1, (currentProduct.images || []).length || 1);
      // 只改主图模式:每变体只跑第一张图 → 极点 N→1。与后端 worker.ts:316
      // primaryOnly 分支口径一致。
      const primaryOnly = panel.querySelector('[data-field="poster-primary-only"]')?.checked || false;
      const imagesPerVariant = primaryOnly ? 1 : fullImagesPerVariant;
      // 多店扇出不再乘 store 数 —— 后端按 (tenantId, offerId, image-hash) cache，
      // 第一个店跑出来后，其余店都是 cache 命中、不重复扣点。
      const totalImages = variantCount * imagesPerVariant;
      const pricePerImage = typeof panel._aiImagePrice === 'number' && panel._aiImagePrice > 0
        ? panel._aiImagePrice
        : POSTER_COST_PER_IMAGE_V2_DEFAULT;
      const totalCost = totalImages * pricePerImage;
      const pointLabel = panel._pointLabel || '极点';

      const balance = typeof panel._aiBalance === 'number' ? panel._aiBalance : null;
      const sufficient = balance == null ? true : balance >= totalCost;

      const costValueEl = panel.querySelector('[data-field="poster-cost-value"]');
      const costBreakdownEl = panel.querySelector('[data-field="poster-cost-breakdown"]');
      const costBox = panel.querySelector('[data-field="poster-cost-box"]');
      if (costValueEl) costValueEl.textContent = totalCost.toLocaleString();
      if (costBreakdownEl) {
        if (variantCount === 0) {
          costBreakdownEl.textContent = '勾选变体后自动估算';
        } else if (primaryOnly) {
          costBreakdownEl.textContent = `${variantCount} 变体 × 1 张主图 × ${pricePerImage} ${pointLabel}`;
        } else {
          costBreakdownEl.textContent = `${variantCount} 变体 × ${imagesPerVariant} 张 × ${pricePerImage} ${pointLabel}`;
        }
      }
      if (costBox) costBox.classList.toggle('insufficient', !sufficient);

      const balanceRow = panel.querySelector('[data-field="poster-balance-row"]');
      const balanceIcon = panel.querySelector('[data-field="poster-balance-icon"]');
      const balanceText = panel.querySelector('[data-field="poster-balance-text"]');
      const rechargeLink = panel.querySelector('[data-field="poster-recharge-link"]');
      if (!balanceRow || !balanceIcon || !balanceText || !rechargeLink) return;
      if (balance == null || totalCost === 0) {
        balanceRow.style.display = 'none';
        return;
      }
      balanceRow.style.display = '';
      balanceRow.classList.toggle('insufficient', !sufficient);
      balanceIcon.textContent = sufficient ? '✓' : '⚠';
      balanceText.textContent = `余额：${balance.toLocaleString()} ${pointLabel} · ${
        sufficient ? '充足' : '不足'
      }`;
      if (sufficient) {
        rechargeLink.style.display = 'none';
      } else {
        rechargeLink.style.display = '';
        rechargeLink.onclick = (e) => {
          e.preventDefault();
          window.sendMessage('openFrontend', { path: RECHARGE_PATH_V2 }).catch(() => {});
        };
      }
    };
    panel._updatePosterEstimate = updatePosterEstimateV2;
    panel.querySelector('[data-field="apply-poster"]')?.addEventListener('change', updatePosterEstimateV2);
    // 只改主图切换时也要重算 — 否则用户先开海报、再勾"只改主图",cost box 不刷新。
    panel.querySelector('[data-field="poster-primary-only"]')?.addEventListener('change', updatePosterEstimateV2);
    panel.addEventListener('change', (e) => {
      if (
        e.target instanceof HTMLInputElement &&
        (e.target.classList?.contains('ozon-helper-mv-check') ||
          e.target.classList?.contains('ozon-helper-mv-store-cb') ||
          e.target.classList?.contains('ozon-helper-mv-store-select-all'))
      ) {
        updatePosterEstimateV2();
      }
    });

    // 若已存在启用项，自动展开 AI 卡，便于用户看到配置
    setTimeout(() => {
      updateAiEnabledCount();
      updatePosterEstimateV2();
      panel._maybeExpandAiCard?.();
    }, 0);

    // ── 恢复上次选择 + 选择变更后持久化 ──
    // 店铺在 loadStoresForPanel 里恢复。
    // 这里恢复同步存在的字段:品牌 / 图片顺序 / 上架货币 / AI 改图 / AI 重写。
    (async () => {
      const cfg = await _getListingConfig();
      if (!cfg) return;
      applyManualListingConfig(panel, cfg);
    })();

    // ── 「上架方式」选择器:仅灰度 flag ozon_portal_import 开时显示;默认 API 上架,
    // 用户主动选「模拟手动上架」才走门户(绕官方限流)。flag 关 → 不显示、永远 API。
    (async () => {
      try {
        if (!(await isPortalImportEnabled())) return;
        const row = panel.querySelector('[data-field="upload-mode-row"]');
        if (row) row.style.display = 'flex';
        const cfg = await _getListingConfig();
        const mode = cfg?.uploadMode === 'portal' ? 'portal' : 'api';
        const el = panel.querySelector(`input[name="jz-upload-mode"][value="${mode}"]`);
        if (el) el.checked = true;
        // 恢复成模拟手动上架时,若店铺已加载则立即收紧成单店(未加载则由店铺渲染末尾兜底)
        if (mode === 'portal') panel._applyPortalStoreConstraint?.(true);
      } catch {}
    })();

    // 上架配置只在成功提交后保存，避免临时试调但未上架的配置污染下次默认值。
    // 但「模拟手动上架」的单店约束是运行时联动（#189 补合），与「保存时机」无关：
    // upload-mode 切换时需即时收紧/放开店铺选择（portal 只支持单店），否则用户从
    // API 切到模拟手动上架后仍可多选店铺，提交时行为异常。
    panel.addEventListener('change', (e) => {
      const t = e.target;
      if (t?.getAttribute?.('data-field') === 'upload-mode') {
        panel._applyPortalStoreConstraint?.(t.value === 'portal');
      }
    });

    // Footer 已选数量同步: 变体 × 店铺 = 上架条数
    const updateFooterCount = () => {
      const sel = panel.querySelectorAll('.ozon-helper-mv-check[data-idx]:checked').length;
      const stores = panel.querySelectorAll('.ozon-helper-mv-store-cb:checked').length;
      const storeCount = Math.max(stores, 1);
      const total = sel * storeCount;
      const elV = panel.querySelector('[data-field="footer-selected-count"]');
      const elS = panel.querySelector('[data-field="footer-store-count"]');
      const elT = panel.querySelector('[data-field="footer-publish-count"]');
      if (elV) elV.textContent = String(sel);
      if (elS) elS.textContent = String(storeCount);
      if (elT) elT.textContent = String(total);
    };
    // 暴露给 loadStoresForPanel:恢复多店选择是程序化勾选(不触发 change),需手动刷新页脚计数。
    panel._updateFooterCount = updateFooterCount;
    panel.addEventListener('change', (e) => {
      if (e.target instanceof HTMLInputElement && (
        e.target.classList?.contains('ozon-helper-mv-check') ||
        e.target.classList?.contains('ozon-helper-mv-store-cb') ||
        e.target.classList?.contains('ozon-helper-mv-store-select-all')
      )) {
        updateFooterCount();
      }
    });
    // initial sync (after stores load asynchronously)
    setTimeout(updateFooterCount, 200);

    // Confirm → validate prices then batch submit
    panel.querySelector('[data-action="confirm"]').addEventListener('click', () => {
      // Clear previous validation states
      panel.querySelectorAll('.ozon-helper-mv-price-error').forEach(el => el.classList.remove('ozon-helper-mv-price-error'));
      const oldError = panel.querySelector('.ozon-helper-mv-error-notice');
      if (oldError) oldError.remove();

      // Validate: checked rows must have sell price and old price
      const checkedRows = panel.querySelectorAll('.ozon-helper-mv-check[data-idx]:checked');
      let hasError = false;
      checkedRows.forEach(cb => {
        const idx = cb.dataset.idx;
        const sellInput = panel.querySelector(`.ozon-helper-mv-price[data-idx="${idx}"]`);
        const oldInput = panel.querySelector(`.ozon-helper-mv-oldprice[data-idx="${idx}"]`);
        const sellVal = parseFloat(sellInput?.value);
        const oldVal = parseFloat(oldInput?.value);
        if (!sellVal || sellVal <= 0) {
          sellInput?.classList.add('ozon-helper-mv-price-error');
          hasError = true;
        }
        if (!oldVal || oldVal <= 0) {
          oldInput?.classList.add('ozon-helper-mv-price-error');
          hasError = true;
        }
      });

      if (hasError) {
        const notice = document.createElement('div');
        notice.className = 'ozon-helper-mv-error-notice';
        notice.innerHTML = '<span class="ozon-helper-mv-error-icon">!</span><span>\u8bf7\u4e3a\u5df2\u52fe\u9009\u7684\u53d8\u4f53\u8bbe\u7f6e\u552e\u4ef7\u548c\u5212\u7ebf\u4ef7\uff0c\u672a\u586b\u5199\u7684\u5df2\u6807\u7ea2\u663e\u793a\u3002</span>';
        const body = panel.querySelector('.ozon-helper-mv-body');
        const wrap = body?.querySelector('.ozon-helper-mv-table-wrap');
        if (wrap) wrap.insertAdjacentElement('beforebegin', notice);
        else if (body) body.appendChild(notice);
        // Scroll first error input into view
        const firstError = panel.querySelector('.ozon-helper-mv-price-error');
        if (firstError) firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      // Ozon \u786c\u7ea6\u675f\uff1a(old_price - price) / old_price < 0.9 (\u6298\u6263\u4e0d\u80fd \u2265 90%)\u3002
      // \u8fdd\u53cd\u5c31 auto-correct \u5230 85% \u6298\u6263\uff08price / 0.15\uff09\u2014\u2014 \u4e0e backend
      // product.service.ts:902-929 \u540c\u6837\u7684 fallback \u516c\u5f0f\uff0c\u4fdd\u8bc1\u4e00\u6b21\u63d0\u4ea4\u6210\u529f\u3002
      let correctedCount = 0;
      checkedRows.forEach((cb) => {
        const idx = cb.dataset.idx;
        const sellInput = panel.querySelector(`.ozon-helper-mv-price[data-idx="${idx}"]`);
        const oldInput = panel.querySelector(`.ozon-helper-mv-oldprice[data-idx="${idx}"]`);
        const sellVal = parseFloat(sellInput?.value);
        const oldVal = parseFloat(oldInput?.value);
        if (sellVal > 0 && oldVal > 0 && (oldVal - sellVal) / oldVal >= 0.9) {
          if (oldInput) oldInput.value = (sellVal / 0.15).toFixed(2);
          correctedCount++;
        }
      });
      if (correctedCount > 0) {
        const notice = document.createElement('div');
        notice.className = 'ozon-helper-mv-error-notice';
        notice.style.background = '#FFFBEB';
        notice.style.borderColor = '#F59E0B';
        notice.style.color = '#92400E';
        notice.innerHTML = `<span class="ozon-helper-mv-error-icon" style="background:#F59E0B;">!</span><span>${correctedCount} \u4e2a\u53d8\u4f53\u7684\u5212\u7ebf\u4ef7\u6298\u6263 \u2265 90%\uff08Ozon \u4e0d\u5141\u8bb8\uff09\uff0c\u5df2\u81ea\u52a8\u8c03\u6574\u4e3a 85% \u6298\u6263\u3002</span>`;
        const body = panel.querySelector('.ozon-helper-mv-body');
        const wrap = body?.querySelector('.ozon-helper-mv-table-wrap');
        if (wrap) wrap.insertAdjacentElement('beforebegin', notice);
        else if (body) body.appendChild(notice);
        // \u4e0d\u963b\u6b62\u63d0\u4ea4\uff0c\u8ba9\u7528\u6237\u770b\u5230\u63d0\u793a\u7684\u540c\u65f6\u76f4\u63a5\u8d70\u4e0b\u4e00\u6b65
      }

      handleMultiVariantFollowSell(panel, variants);
    });

    // "显示所有SKU" toggle → 否时只显示当前商品页的 SKU 行 (extract from URL/page),fallback 第一行
    // 状态持久化到 chrome.storage.local
    const showAllToggle = panel.querySelector('[data-field="show-all-sku"] input[type="checkbox"]');
    if (showAllToggle && options.independentProducts === true) {
      // 跟卖本页商品卡:每行是用户主动选的独立商品,没有「当前商品页 SKU」概念。
      // 「显示所有 SKU / 仅当前」开关在此无意义,且持久化的 false 偏好会导致只剩第一行被勾选、
      // 其余卡片被静默丢弃。隐藏开关并强制显示全部。
      showAllToggle.checked = true;
      showAllToggle.closest('.ozon-helper-mv-toggle-label')?.style.setProperty('display', 'none');
    } else if (showAllToggle) {
      const STORAGE_KEY = 'mv-show-all-sku';
      const currentProduct = extractProductData();
      const currentSku = currentProduct?.sku ? String(currentProduct.sku) : '';
      const applyShowAll = () => {
        const showAll = showAllToggle.checked;
        const rows = panel.querySelectorAll('[data-field="variant-tbody"] tr[data-sku]');
        let matched = false;
        let firstFallbackRow = null;
        rows.forEach((row) => {
          const cb = row.querySelector('.ozon-helper-mv-check');
          if (showAll) {
            row.style.display = '';
            return;
          }
          const rowSku = row.getAttribute('data-sku');
          if (currentSku && rowSku === currentSku) {
            row.style.display = '';
            if (cb) cb.checked = true;
            matched = true;
          } else {
            row.style.display = 'none';
            if (cb) cb.checked = false;
            if (!firstFallbackRow) firstFallbackRow = row;
          }
        });
        if (!showAll && !matched && firstFallbackRow) {
          firstFallbackRow.style.display = '';
          const cb = firstFallbackRow.querySelector('.ozon-helper-mv-check');
          if (cb) cb.checked = true;
        }
        if (!showAll) {
          const selectAll = panel.querySelector('[data-action="select-all"]');
          if (selectAll) {
            const checks = panel.querySelectorAll('.ozon-helper-mv-check[data-idx]');
            const checkedCount = Array.from(checks).filter(c => c.checked).length;
            selectAll.checked = checks.length > 0 && checkedCount === checks.length;
          }
        }
        updateFooterCount();
      };
      // Restore saved preference (default: true 显示所有)
      try {
        chrome.storage.local.get([STORAGE_KEY], (res) => {
          const saved = res?.[STORAGE_KEY];
          if (saved === false || saved === true) {
            showAllToggle.checked = saved;
          }
          applyShowAll();
        });
      } catch {
        applyShowAll();
      }
      // Persist on change
      showAllToggle.addEventListener('change', () => {
        applyShowAll();
        try { chrome.storage.local.set({ [STORAGE_KEY]: showAllToggle.checked }); } catch {}
      });
    }

    // Clear price error on input
    panel.addEventListener('input', (e) => {
      if (e.target.classList.contains('ozon-helper-mv-price-error')) {
        e.target.classList.remove('ozon-helper-mv-price-error');
        // Remove error notice if no more errors
        if (!panel.querySelector('.ozon-helper-mv-price-error')) {
          const errNotice = panel.querySelector('.ozon-helper-mv-error-notice');
          if (errNotice) errNotice.remove();
        }
      }
    });

    // 实际售价改动 → 同 row 划线价自动 = 售价 × 2（50% 折扣，远低于 Ozon 90% 上限）
    // 只在 mv-price token 上触发（mv-price-original / mv-price-prefix 等不命中 classList token）
    panel.addEventListener('input', (e) => {
      const t = e.target;
      if (!t.classList || !t.classList.contains('ozon-helper-mv-price')) return;
      const idx = t.dataset.idx;
      if (!idx) return;
      const sellVal = parseFloat(t.value);
      if (!Number.isFinite(sellVal) || sellVal <= 0) return;
      const oldInput = panel.querySelector(`.ozon-helper-mv-oldprice[data-idx="${idx}"]`);
      if (!oldInput) return;
      const rememberedRatio = normalizeManualListingMultiplier(panel._rememberedOldPriceMultiplier);
      const ratio = rememberedRatio || 2;
      oldInput.value = (sellVal * ratio).toFixed(2);
      oldInput.classList.remove('ozon-helper-mv-price-error');
    });

    // Select-all checkbox
    panel.querySelector('[data-action="select-all"]').addEventListener('change', (e) => {
      panel.querySelectorAll('.ozon-helper-mv-check[data-idx]').forEach(cb => { cb.checked = e.target.checked; });
    });

    // ===== Stage C: enhanced batch popover (scope chips + presets + preview + toast) =====
    function showAppliedToast(title, sub, undoFn) {
      document.querySelectorAll('.ozon-helper-mv-toast').forEach(t => t.remove());
      const toast = document.createElement('div');
      toast.className = 'ozon-helper-mv-toast';
      toast.innerHTML = `
        <span class="ohm-toast-check">${window.lucideIcon('check', 14)}</span>
        <div class="ohm-toast-text">
          <div class="ohm-toast-title">${title}</div>
          <div class="ohm-toast-sub">${sub}</div>
        </div>
        <span class="ohm-toast-undo" data-action="undo">撤销</span>
        <span class="ohm-toast-close" data-action="close">×</span>
      `;
      document.body.appendChild(toast);
      const closeT = () => toast.remove();
      toast.querySelector('[data-action="undo"]').addEventListener('click', () => { try { undoFn(); } catch {} closeT(); });
      toast.querySelector('[data-action="close"]').addEventListener('click', closeT);
      const timer = setTimeout(closeT, 6000);
      toast.addEventListener('mouseenter', () => clearTimeout(timer));
    }

    function jzCollectVisibleMultiVariantCopyRows(panel) {
      const rows = Array.from(panel.querySelectorAll('[data-field="variant-tbody"] tr[data-sku]'));
      const visibleRows = rows.filter((row) => {
        if (row.style.display === 'none') return false;
        const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(row) : null;
        return !style || (style.display !== 'none' && style.visibility !== 'hidden');
      });
      return visibleRows.length ? visibleRows : rows;
    }

    function jzReadMultiVariantInputValue(row, selector) {
      const input = row.querySelector(selector);
      return input ? String(input.value || '').trim() : '';
    }

    function jzBuildMultiVariantCopyText(panel, field) {
      return jzCollectVisibleMultiVariantCopyRows(panel)
        .map((row) => {
          const id = field === 'sku'
            ? String(row.getAttribute('data-sku') || '').trim()
            : jzReadMultiVariantInputValue(row, '.ozon-helper-mv-offerid');
          if (!id) return '';
          return id;
        })
        .filter(Boolean)
        .join('\n');
    }

    function jzShowMultiVariantCopyToast(panel, text) {
      document.querySelectorAll('.ozon-helper-mv-copy-toast').forEach(t => t.remove());
      const toast = document.createElement('div');
      toast.className = 'ozon-helper-mv-copy-toast';
      toast.textContent = text;
      document.body.appendChild(toast);
      const closeToast = () => toast.remove();
      setTimeout(closeToast, 1000);
    }

    async function jzCopyMultiVariantRows(panel, field) {
      const copyText = jzBuildMultiVariantCopyText(panel, field);
      if (!copyText) {
        jzShowMultiVariantCopyToast(panel, '暂无可复制内容');
        return;
      }
      const ok = await _safeCopy(copyText);
      if (ok) {
        jzShowMultiVariantCopyToast(panel, '一键复制成功');
      } else {
        jzShowMultiVariantCopyToast(panel, '复制失败，请重试');
      }
    }

    function openMvBatchPopoverV2(targetTh, opts) {
      // opts: {
      //   inputs?: [{ field, placeholder?, label? }]   - 多输入(尺寸场景)
      //   targetField?: string                         - 单值 shorthand
      //   baseField?, columnLabel, decimals=2, presetMultipliers,
      //   currencyAware?, unitLabel?
      // }
      document.querySelectorAll('.ozon-helper-mv-popover').forEach(p => p.remove());

      const inputs = (opts.inputs && opts.inputs.length) ? opts.inputs : [{ field: opts.targetField }];
      const isMulti = inputs.length > 1;

      const SYMBOLS = { CNY: '¥', USD: '$', EUR: '€', RUB: '₽' };
      const sym = opts.currencyAware
        ? (SYMBOLS[panel.querySelector('[data-field="currency"]')?.value] || '¥')
        : '';
      const decimals = opts.decimals != null ? opts.decimals : 2;
      const unitLabel = opts.unitLabel || '';

      let scope = 'all';
      let mode = (opts.baseField && !isMulti) ? 'multiplier' : 'fixed';
      let vals = inputs.map(() => '');

      const totalRows = () => panel.querySelectorAll('.ozon-helper-mv-check[data-idx]').length;
      const checkedRows = () => panel.querySelectorAll('.ozon-helper-mv-check[data-idx]:checked').length;

      const targetIndices = () => {
        const cbs = Array.from(panel.querySelectorAll('.ozon-helper-mv-check[data-idx]'));
        return cbs.map((cb) => {
          const idx = parseInt(cb.dataset.idx, 10);
          if (scope === 'checked' && !cb.checked) return -1;
          if (scope === 'empty') {
            const allEmpty = inputs.every(inp => {
              const e = panel.querySelector(`.ozon-helper-${inp.field}[data-idx="${idx}"]`);
              return !e || e.value === '';
            });
            if (!allEmpty) return -1;
          }
          return idx;
        }).filter(i => i >= 0);
      };

      const popover = document.createElement('div');
      popover.className = 'ozon-helper-mv-popover ozon-helper-mv-popover-v2';
      document.body.appendChild(popover);

      const previewRows = () => {
        const parsed = vals.map(v => parseFloat(v));
        const anyValid = parsed.some(v => !isNaN(v) && v > 0);
        if (!anyValid) return [];
        const idxs = targetIndices().slice(0, 3);
        if (!isMulti) {
          const val = parsed[0];
          if (isNaN(val) || val <= 0) return [];
          return idxs.map(i => {
            const v = variants[i];
            const baseVal = opts.baseField ? (parseFloat(v?.[opts.baseField]) || 0) : 0;
            const newVal = mode === 'multiplier' ? baseVal * val : val;
            const fromTxt = baseVal ? `${sym}${baseVal.toFixed(decimals)}` : '—';
            const toTxt = !isNaN(newVal) ? `${sym}${newVal.toFixed(decimals)}${unitLabel ? ' ' + unitLabel : ''}` : '?';
            return { name: v?.title || `变体 ${i + 1}`, color: v?.color || '#cbd5e1', from: fromTxt, to: toTxt };
          });
        }
        // multi (dim) preview
        return idxs.map(i => {
          const v = variants[i];
          const fromVals = inputs.map(inp => {
            const e = panel.querySelector(`.ozon-helper-${inp.field}[data-idx="${i}"]`);
            return e?.value || '—';
          });
          const toVals = inputs.map((inp, k) => {
            const cur = parsed[k];
            if (!isNaN(cur) && cur > 0) return cur.toFixed(decimals);
            const e = panel.querySelector(`.ozon-helper-${inp.field}[data-idx="${i}"]`);
            return e?.value || '—';
          });
          return {
            name: v?.title || `变体 ${i + 1}`,
            color: v?.color || '#cbd5e1',
            from: fromVals.join(' × ') + (unitLabel ? ' ' + unitLabel : ''),
            to: toVals.join(' × ') + (unitLabel ? ' ' + unitLabel : ''),
          };
        });
      };

      const renderPop = () => {
        const targets = targetIndices();
        const preview = previewRows();
        const presetsHtml = (mode === 'multiplier' && opts.presetMultipliers?.length)
          ? `<div class="ohm-bp-presets">${opts.presetMultipliers.map(p => `<span class="ohm-bp-preset ${vals[0] === String(p) ? 'is-active' : ''}" data-preset="${p}">×${p}</span>`).join('')}</div>`
          : '';
        const tabsHtml = (opts.baseField && !isMulti) ? `
          <div class="ohm-bp-tabs">
            <span class="ohm-bp-tab ${mode === 'fixed' ? 'is-active' : ''}" data-mode="fixed">同值</span>
            <span class="ohm-bp-tab ${mode === 'multiplier' ? 'is-active' : ''}" data-mode="multiplier">按 ${opts.baseField === 'price' ? '原售价' : '基价'} 倍数</span>
          </div>` : '';
        const previewHtml = preview.length ? `
          <div class="ohm-bp-preview">
            <div class="ohm-bp-preview-head">预览（前 ${preview.length} 行）</div>
            ${preview.map(p => `
              <div class="ohm-bp-preview-row">
                <span class="ohm-bp-preview-dot" style="background:${p.color}"></span>
                <span class="ohm-bp-preview-name">${_escHtml(p.name)}</span>
                <span class="ohm-bp-preview-from">${p.from}</span>
                <span class="ohm-bp-preview-arrow">→</span>
                <span class="ohm-bp-preview-to">${p.to}</span>
              </div>`).join('')}
          </div>` : '';

        // Input row
        let inputRowHtml;
        if (isMulti) {
          const placeholders = ['长', '宽', '高', '深'];
          const innerInputs = inputs.map((inp, k) => `
            <input type="text" inputmode="${decimals === 0 ? 'numeric' : 'decimal'}" pattern="[0-9]*\\.?[0-9]*" class="ozon-helper-mv-popover-input ohm-bp-input" data-i="${k}" placeholder="${inp.placeholder || placeholders[k] || ''}" value="${_escHtml(vals[k])}" />
          `);
          inputRowHtml = `
            <div class="ohm-bp-input-row ohm-bp-input-row-multi">
              ${innerInputs.map((html, k) => k === 0 ? html : `<span class="ohm-bp-multi-sep">×</span>${html}`).join('')}
              ${unitLabel ? `<span class="ohm-bp-suffix">${unitLabel}</span>` : ''}
            </div>`;
        } else {
          const placeholder = mode === 'multiplier'
            ? '例如 1.5'
            : (decimals === 0 ? '例如 10' : '例如 9.50');
          const fixedSuffix = mode === 'multiplier'
            ? '<span class="ohm-bp-suffix">倍</span>'
            : (unitLabel ? `<span class="ohm-bp-suffix">${unitLabel}</span>` : '');
          inputRowHtml = `
            <div class="ohm-bp-input-row">
              ${mode === 'fixed' && sym ? `<span class="ohm-bp-prefix">${sym}</span>` : ''}
              <input type="text" inputmode="${decimals === 0 ? 'numeric' : 'decimal'}" pattern="[0-9]*\\.?[0-9]*" class="ozon-helper-mv-popover-input ohm-bp-input" data-i="0" placeholder="${placeholder}" value="${_escHtml(vals[0])}" />
              ${fixedSuffix}
            </div>`;
        }

        popover.innerHTML = `
          <div class="ohm-bp-head">
            <span class="ohm-bp-icon">${window.lucideIcon('zap', 14)}</span>
            <span class="ohm-bp-title">批量设置 · ${_escHtml(opts.columnLabel)}</span>
            <span class="ohm-bp-close" data-action="close">×</span>
          </div>
          ${tabsHtml}
          <div class="ohm-bp-body">
            <div class="ohm-bp-scope">
              <span class="ohm-bp-scope-chip ${scope === 'all' ? 'is-active' : ''}" data-scope="all">全部 ${totalRows()}</span>
              <span class="ohm-bp-scope-chip ${scope === 'checked' ? 'is-active' : ''}" data-scope="checked">仅勾选 (${checkedRows()})</span>
              <span class="ohm-bp-scope-chip ${scope === 'empty' ? 'is-active' : ''}" data-scope="empty">仅空</span>
            </div>
            ${inputRowHtml}
            ${presetsHtml}
            ${previewHtml}
          </div>
          <div class="ohm-bp-footer">
            <span class="ohm-bp-footer-info">将影响 <b>${targets.length}</b> 个变体</span>
            <button class="ohm-bp-btn ohm-bp-btn-ghost" data-action="cancel">取消</button>
            <button class="ohm-bp-btn ohm-bp-btn-primary" data-action="apply">应用</button>
          </div>
        `;
        _positionPopover(popover, targetTh);
      };

      renderPop();

      popover.addEventListener('input', (e) => {
        if (e.target.classList?.contains('ohm-bp-input')) {
          const i = parseInt(e.target.getAttribute('data-i'), 10) || 0;
          vals[i] = e.target.value;
          const cursor = e.target.selectionStart;
          renderPop();
          const ip = popover.querySelector(`.ohm-bp-input[data-i="${i}"]`);
          if (ip) { ip.focus(); ip.setSelectionRange(cursor, cursor); }
        }
      });

      popover.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-mode]');
        if (tab) { mode = tab.getAttribute('data-mode'); vals = inputs.map(() => ''); renderPop(); return; }
        const sc = e.target.closest('[data-scope]');
        if (sc) { scope = sc.getAttribute('data-scope'); renderPop(); return; }
        const preset = e.target.closest('[data-preset]');
        if (preset) { vals[0] = preset.getAttribute('data-preset'); renderPop(); return; }
        if (e.target.closest('[data-action="close"]') || e.target.closest('[data-action="cancel"]')) {
          popover.remove();
          return;
        }
        if (e.target.closest('[data-action="apply"]')) {
          const parsed = vals.map(v => parseFloat(v));
          if (parsed.every(v => isNaN(v) || v <= 0)) return;
          const targets = targetIndices();
          if (!targets.length) { popover.remove(); return; }
          // capture previous values for undo (per-input × per-row)
          const prev = [];
          targets.forEach(i => {
            inputs.forEach(inp => {
              const el = panel.querySelector(`.ozon-helper-${inp.field}[data-idx="${i}"]`);
              if (el) prev.push({ idx: i, field: inp.field, value: el.value });
            });
          });
          // apply
          targets.forEach(i => {
            inputs.forEach((inp, k) => {
              const v = parsed[k];
              if (isNaN(v) || v <= 0) return;
              const el = panel.querySelector(`.ozon-helper-${inp.field}[data-idx="${i}"]`);
              if (!el) return;
              if (!isMulti && opts.baseField) {
                const baseVal = parseFloat(variants[i]?.[opts.baseField]) || 0;
                const newVal = mode === 'multiplier' ? baseVal * v : v;
                el.value = newVal.toFixed(decimals);
              } else {
                el.value = v.toFixed(decimals);
              }
              // 派发 input 事件让 panel 上的联动 listener 自然接管
              // （比如：mv-price 改了 → mv-oldprice 自动 ×2；mv-price-error 状态清除）
              el.dispatchEvent(new Event('input', { bubbles: true }));
            });
          });
          rememberManualBatchListingDefaults(panel, opts, mode, parsed);
          popover.remove();
          // toast
          const fmtMulti = parsed.map(v => isNaN(v) ? '—' : v.toFixed(decimals)).join(' × ');
          const sub = isMulti
            ? `${targets.length} 个变体 · ${fmtMulti}${unitLabel ? ' ' + unitLabel : ''}`
            : (mode === 'multiplier'
              ? `${targets.length} 个变体 · × ${parsed[0]}`
              : `${targets.length} 个变体 · ${sym}${parsed[0].toFixed(decimals)}${unitLabel ? ' ' + unitLabel : ''}`);
          showAppliedToast(`已批量更新「${opts.columnLabel}」`, sub, () => {
            prev.forEach(p => {
              const el = panel.querySelector(`.ozon-helper-${p.field}[data-idx="${p.idx}"]`);
              if (el) el.value = p.value;
            });
          });
          return;
        }
      });

      // outside click → close
      setTimeout(() => {
        const outside = (ev) => {
          if (!popover.contains(ev.target) && ev.target !== targetTh && !targetTh.contains(ev.target)) {
            popover.remove();
            document.removeEventListener('mousedown', outside);
          }
        };
        document.addEventListener('mousedown', outside);
      }, 0);
    }

    // Helper: create batch-setting Popover (shared by sell price and old price)
    function createBatchPopover(targetTh, onApply, defaultMultiplier) {
      // Close any existing popovers
      document.querySelectorAll('.ozon-helper-mv-popover').forEach(p => p.remove());

      const popover = document.createElement('div');
      popover.className = 'ozon-helper-mv-popover';
      popover.innerHTML = `
        <div class="ozon-helper-mv-popover-radios">
          <label class="ozon-helper-mv-popover-radio">
            <input type="radio" name="batch-mode" value="multiplier" checked />
            <span>\u539f\u552e\u4ef7\u500d\u6570</span>
          </label>
          <label class="ozon-helper-mv-popover-radio">
            <input type="radio" name="batch-mode" value="fixed" />
            <span>\u56fa\u5b9a\u91d1\u989d</span>
          </label>
        </div>
        <div class="ozon-helper-mv-popover-input-row" data-mode="multiplier">
          <input type="number" min="0" step="0.01" class="ozon-helper-mv-popover-input" placeholder="\u8bf7\u8f93\u5165\u500d\u6570\uff0c\u59821.2" />
          <span class="ozon-helper-mv-popover-suffix">\u500d</span>
        </div>
        <div class="ozon-helper-mv-popover-input-row" data-mode="fixed" style="display:none;">
          <span class="ozon-helper-mv-popover-prefix ozon-helper-mv-currency-symbol">\u00a5</span>
          <input type="number" min="0" step="0.01" class="ozon-helper-mv-popover-input" placeholder="\u8bf7\u8f93\u5165\u56fa\u5b9a\u91d1\u989d" />
        </div>
        <div class="ozon-helper-mv-popover-actions">
          <button class="ozon-helper-mv-popover-cancel">\u53d6\u6d88</button>
          <button class="ozon-helper-mv-popover-apply">\u5e94\u7528</button>
        </div>
      `;

      // Update currency symbol in popover
      const curSelect = panel.querySelector('[data-field="currency"]');
      if (curSelect) {
        const SYMBOLS = { CNY: '\u00a5', USD: '$', EUR: '\u20ac', RUB: '\u20bd' };
        const sym = SYMBOLS[curSelect.value] || '\u00a5';
        popover.querySelectorAll('.ozon-helper-mv-currency-symbol').forEach(el => { el.textContent = sym; });
      }

      // Set default multiplier value if provided
      if (defaultMultiplier) {
        const multInput = popover.querySelector('.ozon-helper-mv-popover-input-row[data-mode="multiplier"] .ozon-helper-mv-popover-input');
        if (multInput) multInput.value = defaultMultiplier;
      }

      // Position fixed relative to the trigger element
      document.body.appendChild(popover);
      const rect = targetTh.getBoundingClientRect();
      popover.style.top = (rect.bottom + 4) + 'px';
      popover.style.left = (rect.left + rect.width / 2 - popover.offsetWidth / 2) + 'px';

      // Radio toggle
      popover.querySelectorAll('input[name="batch-mode"]').forEach(radio => {
        radio.addEventListener('change', () => {
          const mode = radio.value;
          popover.querySelectorAll('.ozon-helper-mv-popover-input-row').forEach(row => {
            row.style.display = row.dataset.mode === mode ? '' : 'none';
          });
        });
      });

      // Click outside to close
      const outsideHandler = (e) => {
        if (!popover.contains(e.target) && e.target !== targetTh.querySelector('.ozon-helper-mv-th-action')) {
          closePopover();
        }
      };
      const closePopover = () => {
        document.removeEventListener('mousedown', outsideHandler);
        popover.remove();
      };

      // Cancel
      popover.querySelector('.ozon-helper-mv-popover-cancel').addEventListener('click', closePopover);

      // Apply
      popover.querySelector('.ozon-helper-mv-popover-apply').addEventListener('click', () => {
        const mode = popover.querySelector('input[name="batch-mode"]:checked').value;
        const inputRow = popover.querySelector(`.ozon-helper-mv-popover-input-row[data-mode="${mode}"]`);
        const val = parseFloat(inputRow.querySelector('.ozon-helper-mv-popover-input').value);
        if (isNaN(val) || val <= 0) return;
        onApply(mode, val);
        closePopover();
      });

      setTimeout(() => document.addEventListener('mousedown', outsideHandler), 0);
    }

    // "批量设置" 售价 → V2 Popover
    const batchPriceLink = panel.querySelector('[data-action="batch-price"]');
    if (batchPriceLink) {
      batchPriceLink.addEventListener('click', () => {
        const th = batchPriceLink.closest('th');
        openMvBatchPopoverV2(th, {
          targetField: 'mv-price',
          baseField: 'price',
          columnLabel: '实际售价',
          decimals: 2,
          presetMultipliers: ['1.5', '1.65', '1.8', '2.0'],
          currencyAware: true,
        });
      });
    }

    // "批量设置" 库存 → V2 Popover
    const batchStockLink = panel.querySelector('[data-action="batch-stock"]');
    if (batchStockLink) {
      batchStockLink.addEventListener('click', () => {
        const th = batchStockLink.closest('th');
        openMvBatchPopoverV2(th, {
          targetField: 'mv-stock',
          columnLabel: '我的库存',
          decimals: 0,
          currencyAware: false,
          unitLabel: '件',
        });
      });
    }

    // "批量设置" 最低价 → V2 Popover(基于实际售价的折扣倍数,常见 0.7-0.85)
    const batchMinPriceLink = panel.querySelector('[data-action="batch-minprice"]');
    if (batchMinPriceLink) {
      batchMinPriceLink.addEventListener('click', () => {
        const th = batchMinPriceLink.closest('th');
        openMvBatchPopoverV2(th, {
          targetField: 'mv-minprice',
          baseField: 'price',
          columnLabel: '最低价',
          decimals: 2,
          presetMultipliers: ['0.7', '0.8', '0.85', '0.9'],
          currencyAware: true,
        });
      });
    }

    // "批量设置" 划线价 → V2 Popover
    const batchOldPriceLink = panel.querySelector('[data-action="batch-oldprice"]');
    if (batchOldPriceLink) {
      batchOldPriceLink.addEventListener('click', () => {
        const th = batchOldPriceLink.closest('th');
        openMvBatchPopoverV2(th, {
          targetField: 'mv-oldprice',
          baseField: 'price',
          columnLabel: '我的划线价',
          decimals: 2,
          presetMultipliers: ['1.8', '2.0', '2.25', '2.5'],
          currencyAware: true,
        });
      });
    }

    // "批量设置" 长×宽×高 → V2 Popover (dim mode)
    const batchDimsLink = panel.querySelector('[data-action="batch-dims"]');
    if (batchDimsLink) {
      batchDimsLink.addEventListener('click', () => {
        const th = batchDimsLink.closest('th');
        openMvBatchPopoverV2(th, {
          inputs: [
            { field: 'mv-depth', placeholder: '长' },
            { field: 'mv-width', placeholder: '宽' },
            { field: 'mv-height', placeholder: '高' },
          ],
          columnLabel: '长 × 宽 × 高',
          decimals: 0,
          currencyAware: false,
          unitLabel: 'mm',
        });
      });
    }

    // "批量设置" 重量 → V2 Popover
    const batchWeightLink = panel.querySelector('[data-action="batch-weight"]');
    if (batchWeightLink) {
      batchWeightLink.addEventListener('click', () => {
        const th = batchWeightLink.closest('th');
        openMvBatchPopoverV2(th, {
          targetField: 'mv-weight',
          columnLabel: '重量',
          decimals: 0,
          currencyAware: false,
          unitLabel: 'g',
        });
      });
    }

    const copySkusLink = panel.querySelector('[data-action="copy-skus"]');
    if (copySkusLink) {
      copySkusLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        jzCopyMultiVariantRows(panel, 'sku');
      });
    }

    const copyOfferIdsLink = panel.querySelector('[data-action="copy-offerids"]');
    if (copyOfferIdsLink) {
      copyOfferIdsLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        jzCopyMultiVariantRows(panel, 'offerid');
      });
    }

    // Delete button → remove variant row
    const tbody = panel.querySelector('[data-field="variant-tbody"]');
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.ozon-helper-mv-delete-btn');
        if (!deleteBtn) return;
        const row = deleteBtn.closest('tr');
        if (row) row.remove();
      });
    }

    // Currency change → update symbols, original price conversion, and recalculate sell/old prices
    const currencySelect = panel.querySelector('[data-field="currency"]');
    if (currencySelect) {
      const CURRENCY_SYMBOLS = { CNY: '\u00a5', USD: '$', EUR: '\u20ac', RUB: '\u20bd' };
      // Approximate rates from CNY → target (used for display only)
      const CNY_RATES = { CNY: 1, USD: 0.14, EUR: 0.13, RUB: 11.5 };
      let prevCurrency = 'CNY';

      currencySelect.addEventListener('change', () => {
        const cur = currencySelect.value;
        const symbol = CURRENCY_SYMBOLS[cur] || '\u00a5';
        const rate = CNY_RATES[cur] || 1;
        const prevRate = CNY_RATES[prevCurrency] || 1;

        // Update sell price prefix symbols
        panel.querySelectorAll('.ozon-helper-mv-price-prefix').forEach(el => {
          el.textContent = symbol;
        });

        // Update original price: always show ¥ base price, add conversion line if non-CNY
        panel.querySelectorAll('.ozon-helper-mv-price-original').forEach(cell => {
          const basePrice = parseFloat(cell.dataset.basePrice) || 0;
          const convertedDiv = cell.querySelector('.ozon-helper-mv-price-converted');
          if (cur === 'CNY') {
            convertedDiv.style.display = 'none';
          } else if (basePrice > 0) {
            const converted = (basePrice * rate).toFixed(2);
            convertedDiv.textContent = `\u2248${symbol}${window.formatNumber(converted, 2)}`;
            convertedDiv.style.display = '';
          }
        });

        // Convert sell price and old price input values
        if (prevCurrency !== cur) {
          const conversionFactor = rate / prevRate;
          panel.querySelectorAll('.ozon-helper-mv-price').forEach(input => {
            const val = parseFloat(input.value);
            if (val > 0) input.value = (val * conversionFactor).toFixed(2);
          });
          panel.querySelectorAll('.ozon-helper-mv-oldprice').forEach(input => {
            const val = parseFloat(input.value);
            if (val > 0) input.value = (val * conversionFactor).toFixed(2);
          });
        }

        prevCurrency = cur;
      });
    }

    // "一键生成" → auto-generate offer IDs (always regenerates with unique suffix)
    //
    // 用户可编辑的 [data-field="offerid-prefix"] input(默认 "jz-",chrome.storage.local
    // 持久化 key "oh-offerid-prefix")作为前缀,跟日期戳 + 随机后缀 + SKU 拼接:
    //   <prefix><YYMMDD><4字符 base36>-<sku>
    // 用户改完前缀立即写 storage,下次面板打开自动 hydrate。
    const OFFER_ID_PREFIX_KEY = 'oh-offerid-prefix';
    const autoOfferIdLink = panel.querySelector('[data-action="auto-offerid"]');
    const prefixInput = panel.querySelector('[data-field="offerid-prefix"]');

    // Hydrate input 从 chrome.storage 取上次保存的前缀(默认 jz-)
    if (prefixInput) {
      try {
        chrome.storage.local.get([OFFER_ID_PREFIX_KEY], (data) => {
          const saved = data?.[OFFER_ID_PREFIX_KEY];
          if (saved && typeof saved === 'string') {
            prefixInput.value = saved;
          } else {
            prefixInput.value = 'jz-';
          }
          // Hydrate 完之后再触发首次自动生成(防止抢在 input.value 设置前用 placeholder 默认)
          if (autoOfferIdLink) autoOfferIdLink.click();
        });
      } catch {
        prefixInput.value = 'jz-';
        if (autoOfferIdLink) autoOfferIdLink.click();
      }
      // input 失焦或回车时存储新前缀
      const savePrefix = () => {
        const v = (prefixInput.value || '').trim();
        try { chrome.storage.local.set({ [OFFER_ID_PREFIX_KEY]: v || 'jz-' }); } catch {}
      };
      prefixInput.addEventListener('blur', savePrefix);
      prefixInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          prefixInput.blur();
        }
      });
    }

    if (autoOfferIdLink) {
      autoOfferIdLink.addEventListener('click', () => {
        const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, '');
        const suffix = Date.now().toString(36).slice(-4);
        // 允许空(走 'jz-' 默认),允许任意字符,但去掉空白避免 Ozon offer_id 校验问题
        const userPrefix = ((prefixInput?.value || 'jz-').trim() || 'jz-').replace(/\s+/g, '');
        const prefix = `${userPrefix}${dateStr}${suffix}`;
        variants.forEach((v, i) => {
          const input = panel.querySelector(`.ozon-helper-mv-offerid[data-idx="${i}"]`);
          if (input) {
            input.value = `${prefix}-${v.sku}`;
          }
        });
      });
      // Auto-generate offer IDs on panel open(若 prefix input 存在,会被上方 hydrate 路径
      // 接管 — 等读到 storage 才点;否则这里 fallback 用 placeholder/默认前缀立即生成)
      if (!prefixInput) autoOfferIdLink.click();
    }

    panel._variants = variants;
    loadStoresForPanel(panel);

    // Load AI quota status + membership limits
    loadAiQuota(panel);
    loadMembershipBar(panel);

    // 源属性 placeholder 兜底:weight/depth/width/height 来自:
    //   - 优先 preCollectedSourceMap(toggleFollowSellPanel 流水线 Phase B 已拉好)
    //   - 否则 fallback 异步背景拉:JZSkuCollect.collectBySkus → SW searchVariants
    //     → Ozon /api/v1/search + create-bundle-by-variant-id
    // 不 auto-fill value 是为了:
    //   1. 防止源数据 0/异常时盲填,提交失败
    //   2. 让用户看到"沿用原值是 X",明确预期再决定是否覆盖
    // 角标标题换真名:合并卡变体 tile 的 data.title 是促销角标拼接(非商品名),
    // 渲染时只能剥角标(剥光则原样保留)。源属性到位后用与提交同口径的
    // jzPreferSourceName + 残词判定,把污染标题直接换成 sv 4180 真名并同步基线,
    // 让面板所见 = 实际提交名。模板/手动改过(≠基线)不覆盖。
    const _fixPollutedTitle = (i, d) => {
      if (!d?.name || !window.jzPreferSourceName) return;
      const titleEl = panel
        .querySelector(`.ozon-helper-mv-check[data-idx="${i}"]`)
        ?.closest('tr')
        ?.querySelector('.ozon-helper-mv-variant-title-text');
      if (!titleEl) return;
      const current = (titleEl.textContent || '').trim();
      const base = (titleEl.dataset?.jzBaseTitle || '').trim();
      if (base && current !== base) return;
      const preferred = window.jzPreferSourceName(d.name, current === '-' ? '' : current);
      let finalName = preferred;
      if (window.jzStripPromo) {
        const stripped = window.jzStripPromo(preferred);
        if (window.jzIsPromoResidualTitle?.(preferred, stripped)) {
          finalName = (window.jzStripPromo(d.name) || d.name) || stripped || preferred;
        } else if (stripped) {
          finalName = stripped;
        }
      }
      if (!finalName || finalName === current) return;
      titleEl.textContent = finalName;
      titleEl.dataset.jzBaseTitle = finalName;
      const td = titleEl.closest('td');
      if (td) td.title = finalName;
    };

    const _applySourcePlaceholders = (sourceMap) => {
      let filled = 0;
      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        const d = sourceMap.get(String(v.sku));
        if (!d) continue;
        _fixPollutedTitle(i, d);
        const w = Number(d.weight) || 0;
        const dp = Number(d.depth) || 0;
        const wd = Number(d.width) || 0;
        const ht = Number(d.height) || 0;
        if (w === 0 && dp === 0 && wd === 0 && ht === 0) continue;
        filled++;
        const setHint = (cls, val) => {
          if (!val) return;
          const el = panel.querySelector(`.${cls}[data-idx="${i}"]`);
          if (el && !el.value) {
            el.placeholder = String(val);
            el.title = `源商品默认 ${val}(留空=沿用)`;
          }
        };
        setHint('ozon-helper-mv-weight', w);
        setHint('ozon-helper-mv-depth', dp);
        setHint('ozon-helper-mv-width', wd);
        setHint('ozon-helper-mv-height', ht);
      }
      return filled;
    };

    if (preCollectedSourceMap && preCollectedSourceMap.size > 0) {
      // 流水线已经拉好 — 直接 apply,跳过本函数自己的 fetch
      const filled = _applySourcePlaceholders(preCollectedSourceMap);
      const badge = panel.querySelector('[data-field="variant-badge"]');
      if (badge && filled > 0) {
        badge.textContent = `${variants.length} 个变体 · ${filled} 含源属性`;
      }
    } else if (window.JZSkuCollect?.collectBySkus && variants.length > 0) {
      // Fallback:流水线没跑(单变体快路径 / 没 JZSkuCollect),仍走异步背景拉。
      const skus = variants.map((v) => String(v.sku)).filter(Boolean);
      const badge = panel.querySelector('[data-field="variant-badge"]');
      const origBadgeText = badge ? badge.textContent : null;
      if (badge) badge.textContent = `${variants.length} 个变体 · 拉源属性中…`;
      (async () => {
        try {
          const { sourceMap } = await window.JZSkuCollect.collectBySkus(skus, {
            onProgress: (done, total) => {
              if (badge) badge.textContent = `${variants.length} 个变体 · 源属性 ${done}/${total}`;
            },
            // 面板路径自有 richContentMap(fetchVariantGallery 同源逐变体抽),
            // 不必再逐变体走买家 tab 拉富内容。
            captureRichContent: false,
          });
          const filled = _applySourcePlaceholders(sourceMap);
          if (badge) {
            badge.textContent = filled > 0
              ? `${variants.length} 个变体 · ${filled} 含源属性`
              : (origBadgeText || `${variants.length} 个变体`);
          }
        } catch (e) {
          console.warn('[panel] collectBySkus 拉源属性失败:', e?.message || e);
          if (badge) badge.textContent = origBadgeText || `${variants.length} 个变体`;
        }
      })();
    }

    // V1 旧版 ai-image-scene 下拉已下线，无 toggle 需绑定

    // Template: load button
    const mvLoadTemplateBtn = panel.querySelector('[data-action="mv-load-template"]');
    if (mvLoadTemplateBtn) {
      mvLoadTemplateBtn.addEventListener('click', () => handleLoadTemplateForMV(panel, variants));
    }

    // Template: clear button
    const mvClearTemplateBtn = panel.querySelector('[data-action="mv-clear-template"]');
    if (mvClearTemplateBtn) {
      mvClearTemplateBtn.addEventListener('click', () => {
        clearTemplateFromMVPanel(panel, variants);
      });
    }

    return panel;
  }

  const PLAN_LABELS = {
    free: '免费版',
    monthly: '个人会员',
    quarterly: '高级会员',
    yearly: '企业版会员',
  };

  function renderUsageItem(label, used, limit, suffix) {
    if (!limit || limit === 0) {
      // 0 = 无限
      return `<span class="ozon-helper-mv-membership-item">
        <span class="label">${label}</span>
        <span class="value">无限</span>
      </span>`;
    }
    const percent = used / limit;
    const cls = percent >= 1 ? 'full' : percent >= 0.8 ? 'warn' : '';
    return `<span class="ozon-helper-mv-membership-item ${cls}">
      <span class="label">${label}${suffix ? `(${suffix})` : ''}</span>
      <span class="value">${used}/${limit}</span>
    </span>`;
  }

  async function loadMembershipBar(panel) {
    const bar = panel.querySelector('[data-field="membership-bar"]');
    if (!bar) return;
    try {
      const res = await window.sendMessage('getMembershipSummary', {});
      if (!res || res.error || !res.ok || !res.data) return;
      const s = res.data;
      const planLabel = PLAN_LABELS[s.level] || s.planName || s.level || '免费版';
      const planCls = s.level === 'free' ? 'free' : '';

      const items = [];
      // 店铺
      items.push(renderUsageItem('店铺', s.usage.shopCount, s.caps.maxShops));
      // 上品（优先显示终身累计，否则每日）
      if (s.caps.cumulativeListingLimit > 0) {
        items.push(renderUsageItem('上品', s.usage.listingCumulative, s.caps.cumulativeListingLimit, '累计'));
      } else {
        items.push(renderUsageItem('今日上品', s.usage.listingToday, s.caps.dailyListingLimit));
      }
      // 设备
      items.push(renderUsageItem('设备', s.usage.activeDevices, s.caps.maxConcurrentDevices));

      // AI 试用提示
      const aiTrialHint = s.usage.aiEditTrialExpired
        ? `<span class="ozon-helper-mv-membership-item full"><span class="label">AI 大模型改图</span><span class="value">试用已过期</span></span>`
        : (s.caps.aiEditTrialOnly ? `<span class="ozon-helper-mv-membership-item warn"><span class="label">AI 大模型改图</span><span class="value">24h 试用中</span></span>` : '');

      const showUpgrade = s.level === 'free' || s.daysLeft <= 7;
      const upgradeBtn = showUpgrade
        ? `<button class="ozon-helper-mv-membership-upgrade" data-action="membership-upgrade">升级会员</button>`
        : '';

      bar.innerHTML = `
        <span class="ozon-helper-mv-membership-plan ${planCls}">${planLabel}${s.level !== 'free' ? ` · 剩余 ${s.daysLeft} 天` : ''}</span>
        ${items.join('')}
        ${aiTrialHint}
        ${upgradeBtn}
      `;
      bar.style.display = '';

      const upgrade = bar.querySelector('[data-action="membership-upgrade"]');
      if (upgrade) {
        upgrade.addEventListener('click', () => {
          window.sendMessage('openFrontend', { path: '/ozon/settings/membership' }).catch(() => {});
        });
      }
    } catch (e) {
      console.warn('[OzonHelper] Failed to load membership summary:', e);
    }
  }

  async function loadAiQuota(panel) {
    try {
      const res = await window.sendMessage('getAiQuota', {});
      if (res && !res.error) {
        // V1 \u65e7\u7248 ai-image-quota span \u5df2\u5220\uff08\u4ec5 V2 \u6d77\u62a5\uff0c70 \u6781\u70b9 / \u5f20\u9759\u6001\u663e\u793a\uff09
        const rewriteQuotaEl = panel.querySelector('[data-field="ai-rewrite-quota"]');
        // \u5b9e\u9645\u5f00\u3000\u662f apply-ai-rewrite(\u65e7\u4ee3\u7801\u67e5\u7684 ai-rewrite-enabled \u4e0d\u5b58\u5728,\u662f\u6b7b\u9009\u62e9\u5668)\u3002
        const rewriteToggle = panel.querySelector('[data-field="apply-ai-rewrite"]');
        if (rewriteQuotaEl && res.aiRewrite) {
          // 2026-07:AI \u91cd\u5199\u6309\u6b21\u6263\u6781\u70b9(\u4e0d\u518d\u662f\u4f1a\u5458\u6743\u76ca)\u3002\u4f59\u989d\u5145\u8db3 \u2192 \u9ed8\u8ba4\u52fe\u9009
          // (\u7528\u6237\u624b\u52a8\u52a8\u8fc7\u4e0d\u8986\u76d6);\u4f59\u989d\u4e0d\u8db3 \u2192 \u7981\u7528\u5e76\u53d6\u6d88\u52fe\u9009,\u5426\u5219\u63d0\u4ea4\u4f1a\u547d\u4e2d
          // backend INSUFFICIENT_JIDIAN \u8ba9\u6574\u6279\u5931\u8d25\u3002
          const rewritePl = (typeof res.pointLabel === 'string' && res.pointLabel.trim()) ? res.pointLabel.trim() : '\u6781\u70b9';
          const rewritePrice = res.aiRewrite.price;
          if (res.aiRewrite.sufficient) {
            rewriteQuotaEl.textContent = `${rewritePrice} ${rewritePl}/\u6b21`;
            rewriteQuotaEl.style.color = '#52c41a';
            rewriteQuotaEl.title = '\u6309\u6b21\u6263\u8d39;\u591a\u5e97\u94fa\u4e0a\u67b6\u540c\u6b3e\u6587\u6848\u7f13\u5b58\u547d\u4e2d\u4e0d\u91cd\u590d\u6263';
            if (rewriteToggle) {
              rewriteToggle.disabled = false;
              if (!panel._aiRewriteUserTouched && !rewriteToggle.checked) {
                rewriteToggle.checked = true;
                panel._updateAiEnabledCount?.();
              }
            }
          } else {
            rewriteQuotaEl.textContent = `${rewritePl}\u4e0d\u8db3`;
            rewriteQuotaEl.style.color = '#ff4d4f';
            rewriteQuotaEl.title = `${rewritePl}\u4f59\u989d\u4e0d\u8db3(\u5f53\u524d ${res.aiRewrite.balance ?? 0}\uff0c\u6bcf\u6b21 ${rewritePrice})\uff0c\u8bf7\u5148\u5145\u503c`;
            if (rewriteToggle) {
              rewriteToggle.disabled = true;
              if (rewriteToggle.checked) {
                rewriteToggle.checked = false;
                panel._updateAiEnabledCount?.();
              }
            }
          }
        }
        // \u6d77\u62a5\u6210\u672c\u9884\u4f30\u9700\u8981\u4f59\u989d + \u5355\u4ef7\uff1a\u7f13\u5b58\u5230 panel\uff0c\u89e6\u53d1\u5237\u65b0
        if (typeof res.balance === 'number') {
          panel._aiBalance = res.balance;
        }
        if (typeof res.aiImage?.price === 'number' && res.aiImage.price > 0) {
          panel._aiImagePrice = res.aiImage.price;
        }
        if (typeof res.pointLabel === 'string' && res.pointLabel.trim()) {
          panel._pointLabel = res.pointLabel.trim();
        }
        const pl = panel._pointLabel || '极点';
        const costUnitEl = panel.querySelector('[data-field="poster-cost-unit"]');
        if (costUnitEl) costUnitEl.textContent = pl;
        const n1UnitEl = panel.querySelector('[data-field="poster-n1-unit"]');
        if (n1UnitEl) n1UnitEl.textContent = pl;
        if (typeof panel._updatePosterEstimate === 'function') {
          panel._updatePosterEstimate();
        }
      }
    } catch (e) {
      console.warn('[OzonHelper] Failed to load AI quota:', e);
    }
  }

  // ── Multi-variant template support ──

  async function handleLoadTemplateForMV(panel, variants) {
    const loadBtn = panel.querySelector('[data-action="mv-load-template"]');
    const origText = loadBtn ? loadBtn.textContent : '';
    if (loadBtn) {
      loadBtn.textContent = '\u23f3 \u52a0\u8f7d\u4e2d...';
      loadBtn.disabled = true;
    }
    const statusDiv = panel.querySelector('[data-field="mv-status"]');

    try {
      const auth = await window.sendMessage('getAuth');
      if (!auth || !auth.token) {
        showMvStatus(statusDiv, 'error', '\u8bf7\u5148\u767b\u5f55');
        return;
      }

      const response = await fetch(`${auth.backendUrl || window.API_BASE_URL}/ozon/templates?pageSize=100`, {
        signal: AbortSignal.timeout(15000),
        headers: {
          'Authorization': `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
          ...(auth.storeId ? { 'x-ozon-store-id': auth.storeId } : {}),
        }
      });

      if (!response.ok) throw new Error(`\u52a0\u8f7d\u6a21\u677f\u5217\u8868\u5931\u8d25 (${response.status})`);

      const data = await response.json();
      const templates = data.items || [];

      if (templates.length === 0) {
        // Empty-state CTA: take the user straight to the "\u65b0\u5efa\u6a21\u677f" page
        // instead of dead-ending with a useless error toast.
        if (statusDiv) {
          statusDiv.classList.remove('is-loading');
          statusDiv.classList.add('is-error');
          statusDiv.innerHTML =
            '\u6682\u65e0\u53ef\u7528\u6a21\u677f \u00b7 ' +
            '<a href="#" class="ozon-helper-link" data-action="open-create-template">\u524d\u5f80\u540e\u53f0\u521b\u5efa</a>';
          const link = statusDiv.querySelector('[data-action="open-create-template"]');
          if (link) {
            link.addEventListener('click', (ev) => {
              ev.preventDefault();
              window.sendMessage('openFrontend', { path: '/ozon/templates' }).catch(() => {});
            });
          }
        }
        return;
      }

      // Build template selection modal (reuse same UI pattern as single-product)
      const templateHtml = templates.map(t =>
        `<div class="ozon-helper-template-item" data-template-id="${t.id}">
          <div class="ozon-helper-template-name">${_escHtml(t.name)}</div>
          <div class="ozon-helper-template-desc">${_escHtml(t.description || '')}</div>
        </div>`
      ).join('');

      const modal = document.createElement('div');
      modal.className = 'ozon-helper-modal';
      modal.innerHTML = `
        <div class="ozon-helper-modal-content">
          <div class="ozon-helper-modal-header">
            <span>\u9009\u62e9\u6a21\u677f</span>
            <button class="ozon-helper-modal-close">&times;</button>
          </div>
          <div class="ozon-helper-modal-body">
            <input class="ozon-helper-input ozon-helper-template-search" type="text" placeholder="\u641c\u7d22\u6a21\u677f\u540d\u79f0\u6216\u63cf\u8ff0..." style="margin-bottom:12px;" />
            <div class="ozon-helper-template-list">${templateHtml}</div>
          </div>
        </div>
      `;

      document.body.appendChild(modal);
      modal.classList.add('is-open');

      modal.querySelector('.ozon-helper-modal-close').addEventListener('click', () => modal.remove());

      const searchInput = modal.querySelector('.ozon-helper-template-search');
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        modal.querySelectorAll('.ozon-helper-template-item').forEach(item => {
          const name = item.querySelector('.ozon-helper-template-name')?.textContent.toLowerCase() || '';
          const desc = item.querySelector('.ozon-helper-template-desc')?.textContent.toLowerCase() || '';
          item.style.display = (name.includes(q) || desc.includes(q)) ? '' : 'none';
        });
      });

      modal.querySelectorAll('.ozon-helper-template-item').forEach(item => {
        item.addEventListener('click', async () => {
          const templateId = item.dataset.templateId;
          const templateName = item.querySelector('.ozon-helper-template-name')?.textContent || '';
          modal.remove();
          await applyTemplateToMVPanel(panel, variants, templateId, templateName, auth);
        });
      });

    } catch (error) {
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const msg = isTimeout ? '\u8bf7\u6c42\u8d85\u65f6\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5' : (error?.message || '\u672a\u77e5\u9519\u8bef');
      showMvStatus(statusDiv, 'error', `\u52a0\u8f7d\u6a21\u677f\u5931\u8d25: ${msg}`);
    } finally {
      if (loadBtn) {
        loadBtn.textContent = origText;
        loadBtn.disabled = false;
      }
    }
  }

  async function applyTemplateToMVPanel(panel, variants, templateId, templateName, auth) {
    const statusDiv = panel.querySelector('[data-field="mv-status"]');
    try {
      const product = extractProductData();
      const variables = {
        BRAND: product.brand || '',
        PRODUCT_NAME: product.title || '',
        PRICE: String(product.price || ''),
        ORIGINAL_PRICE: String(product.originalPrice || product.price || ''),
      };

      const response = await fetch(`${auth.backendUrl || window.API_BASE_URL}/ozon/templates/${templateId}/apply`, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: {
          'Authorization': `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
          ...(auth.storeId ? { 'x-ozon-store-id': auth.storeId } : {}),
        },
        body: JSON.stringify({ productData: product, variables })
      });

      if (!response.ok) throw new Error(`\u5e94\u7528\u6a21\u677f\u5931\u8d25 (${response.status})`);

      const result = await response.json();
      const ts = result.templateSettings || {};

      // ── Apply template fields to multi-variant panel UI ──

      // Currency
      if (ts.currency) {
        const curSelect = panel.querySelector('[data-field="currency"]');
        if (curSelect) {
          curSelect.value = ts.currency;
          curSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // Stock → batch fill all variant stock inputs
      if (ts.stock !== undefined && ts.stock !== null) {
        panel.querySelectorAll('.ozon-helper-mv-stock').forEach(input => {
          input.value = ts.stock;
        });
      }

      // Warehouse → 同步顶部仓库下拉
      if (ts.warehouseId) {
        const whSelect = panel.querySelector('[data-field="warehouse-id"]');
        if (whSelect) {
          // 若选项里有该 id 直接选中；否则 leave 用户当前选择不变（避免静默失效）
          if (Array.from(whSelect.options).some(o => o.value === String(ts.warehouseId))) {
            whSelect.value = String(ts.warehouseId);
          }
        }
      }

      // Brand
      if (ts.carryBrand && ts.customBrand) {
        const brandSelect = panel.querySelector('[data-field="brand"]');
        if (brandSelect) brandSelect.value = 'copy';
      } else if (ts.carryBrand === false) {
        const brandSelect = panel.querySelector('[data-field="brand"]');
        if (brandSelect) brandSelect.value = 'no_brand';
      }

      // Offer ID prefix → regenerate offer IDs with template prefix
      if (ts.offerIdPrefix) {
        const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, '');
        const suffix = Date.now().toString(36).slice(-4);
        const prefix = `${ts.offerIdPrefix}${dateStr}${suffix}`;
        variants.forEach((v, i) => {
          const input = panel.querySelector(`.ozon-helper-mv-offerid[data-idx="${i}"]`);
          if (input) input.value = `${prefix}-${v.sku}`;
        });
      }

      // Image arrangement → map template values to MV panel values
      if (ts.imageArrangement) {
        const imageOrderMap = {
          'keep': 'keep',
          'main_fixed': 'shuffle_keep_first',
          'all_random': 'shuffle',
        };
        const mapped = imageOrderMap[ts.imageArrangement] || ts.imageArrangement;
        const imgSelect = panel.querySelector('[data-field="image-order"]');
        if (imgSelect) imgSelect.value = mapped;
      }

      // Remove keywords from variant names
      if (ts.removeKeywords && ts.removeKeywords.length > 0) {
        panel.querySelectorAll('[data-field="variant-tbody"] tr[data-sku]').forEach(row => {
          const nameEl = row.querySelector('.ozon-helper-mv-variant-title-text') ||
            row.querySelector('.ozon-helper-mv-variant-name');
          if (nameEl) {
            let text = nameEl.textContent || '';
            for (const kw of ts.removeKeywords) {
              text = text.replace(new RegExp(_escRegExp(kw), 'gi'), '').trim();
            }
            // Collapse multiple spaces
            text = text.replace(/\s{2,}/g, ' ').trim();
            nameEl.textContent = text;
          }
        });
      }

      // Title suffix → append to each variant name
      if (ts.titleSuffix) {
        panel.querySelectorAll('[data-field="variant-tbody"] tr[data-sku]').forEach(row => {
          const nameEl = row.querySelector('.ozon-helper-mv-variant-title-text') ||
            row.querySelector('.ozon-helper-mv-variant-name');
          if (nameEl) {
            const current = nameEl.textContent || '';
            if (!current.endsWith(ts.titleSuffix)) {
              nameEl.textContent = current + ' ' + ts.titleSuffix;
            }
          }
        });
      }

      // Store all template settings on panel for submission
      panel._templateSettings = ts;
      panel._templateName = templateName;

      // Update template name display
      const nameEl = panel.querySelector('[data-field="mv-template-name"]');
      const clearEl = panel.querySelector('[data-action="mv-clear-template"]');
      if (nameEl) {
        nameEl.textContent = `\u2705 ${templateName}`;
        nameEl.style.display = '';
      }
      if (clearEl) clearEl.style.display = '';

      showMvStatus(statusDiv, 'success', `\u6a21\u677f\u300c${templateName}\u300d\u5df2\u5e94\u7528`);
      setTimeout(() => { statusDiv.style.display = 'none'; }, 2000);

    } catch (error) {
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const msg = isTimeout ? '\u8bf7\u6c42\u8d85\u65f6\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5' : (error?.message || '\u672a\u77e5\u9519\u8bef');
      showMvStatus(statusDiv, 'error', `\u5e94\u7528\u6a21\u677f\u5931\u8d25: ${msg}`);
    }
  }

  function clearTemplateFromMVPanel(panel, variants) {
    panel._templateSettings = null;
    panel._templateName = null;

    // Hide template name and clear button
    const nameEl = panel.querySelector('[data-field="mv-template-name"]');
    const clearEl = panel.querySelector('[data-action="mv-clear-template"]');
    if (nameEl) { nameEl.textContent = ''; nameEl.style.display = 'none'; }
    if (clearEl) clearEl.style.display = 'none';

    // Reset UI to defaults
    const curSelect = panel.querySelector('[data-field="currency"]');
    if (curSelect) {
      curSelect.value = 'CNY';
      curSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const brandSelect = panel.querySelector('[data-field="brand"]');
    if (brandSelect) brandSelect.value = 'no_brand';
    const imgSelect = panel.querySelector('[data-field="image-order"]');
    if (imgSelect) imgSelect.value = 'keep';

    // Reset stocks to 10
    panel.querySelectorAll('.ozon-helper-mv-stock').forEach(input => { input.value = '10'; });

    // Regenerate default offer IDs (same logic as auto-offerid)
    const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const suffix = Date.now().toString(36).slice(-4);
    const prefix = `jz-${dateStr}${suffix}`;
    variants.forEach((v, i) => {
      const input = panel.querySelector(`.ozon-helper-mv-offerid[data-idx="${i}"]`);
      if (input) input.value = `${prefix}-${v.sku}`;
    });

    const statusDiv = panel.querySelector('[data-field="mv-status"]');
    showMvStatus(statusDiv, 'success', '\u6a21\u677f\u5df2\u6e05\u9664');
    setTimeout(() => { statusDiv.style.display = 'none'; }, 1500);
  }

  // Helper: escape string for use in RegExp
  function _escRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function showMvStatus(statusDiv, type, message, opts) {
    if (!statusDiv || !document.body.contains(statusDiv)) return;
    statusDiv.style.display = type === 'loading' ? 'flex' : 'block';
    statusDiv.className = `ozon-helper-mv-status is-${type}`;
    if (type === 'loading') {
      // opts.onCancel: function | null. When provided, render a cancel link
      // next to the spinner so long-running batches (variant prefetch,
      // gallery fetch) can be aborted by the user instead of forcing a
      // page reload.
      const cancelHtml = opts && typeof opts.onCancel === 'function'
        ? '<button type="button" class="ozon-helper-mv-cancel-btn" data-action="mv-cancel">取消</button>'
        : '';
      statusDiv.innerHTML =
        `<span class="ozon-helper-mv-spinner"></span><span>${_escHtml(message)}</span>${cancelHtml}`;
      if (opts && typeof opts.onCancel === 'function') {
        const btn = statusDiv.querySelector('[data-action="mv-cancel"]');
        if (btn) {
          btn.addEventListener('click', () => {
            try { opts.onCancel(); } catch {}
          }, { once: true });
        }
      }
    } else {
      // Use textContent so \n renders as line breaks via white-space:pre-wrap
      statusDiv.textContent = message;
    }
  }

  // 上品配额预判:复刻后端 membership-check.service.ts 的 LISTING_CREATE 门控,
  // 提交前本地判一遍,达上限直接拦截并引导升级,不再让整批白跑到后端付费墙。
  // count = 本次单店上品数(变体数);多店扇出时后端按单店逐次 assert,这里用首店
  // 口径(cum + count > limit)预判,正好覆盖"已达上限"的硬拦截场景。
  function evaluateListingQuota(summary, itemCount) {
    if (!summary) return { blocked: false };
    const caps = summary.caps || {};
    const usage = summary.usage || {};
    const cumLimit = caps.cumulativeListingLimit || 0;
    const dailyLimit = caps.dailyListingLimit || 0;
    const cum = usage.listingCumulative || 0;
    const today = usage.listingToday || 0;
    const count = Math.max(1, itemCount || 1);
    // 免费版且两档都没配 = 完全不支持上品
    if (summary.canUse && summary.canUse.LISTING_CREATE === false && cumLimit === 0 && dailyLimit === 0) {
      return { blocked: true, message: '免费会员暂不支持上品，请升级会员解锁该功能' };
    }
    if (cumLimit > 0 && cum + count > cumLimit) {
      return { blocked: true, message: `免费版终身累计上品 ${cumLimit} 个已达上限，升级会员解锁每日配额` };
    }
    if (dailyLimit > 0 && today + count > dailyLimit) {
      return { blocked: true, message: `今日上品 ${dailyLimit} 个已达上限，请明日再试或升级更高等级` };
    }
    return { blocked: false };
  }

  // 达上限拦截:复用会员条的「升级会员」样式 + openFrontend 跳会员页(同 loadMembershipBar)
  function showMvUpgradeBlock(statusDiv, message) {
    if (!statusDiv || !document.body.contains(statusDiv)) return;
    statusDiv.style.display = 'block';
    statusDiv.className = 'ozon-helper-mv-status is-error';
    statusDiv.innerHTML = '';
    const msg = document.createElement('span');
    msg.textContent = message;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ozon-helper-mv-membership-upgrade';
    btn.textContent = '升级会员';
    btn.style.marginLeft = '8px';
    btn.addEventListener('click', () => {
      window.sendMessage('openFrontend', { path: '/ozon/settings/membership' }).catch(() => {});
    });
    statusDiv.appendChild(msg);
    statusDiv.appendChild(btn);
  }

  // 门户上架灰度开关读取(ozon_portal_import)。5min 内存缓存,任何失败默认 false
  // → 回退官方 API 路径,零风险。开则一键跟卖改走 seller.ozon.ru bundle 接口绕官方限流。
  let __portalFlagCache = null; // { at, on }
  async function isPortalImportEnabled() {
    try {
      const now = Date.now();
      if (__portalFlagCache && now - __portalFlagCache.at < 5 * 60 * 1000) {
        return __portalFlagCache.on;
      }
      const flags = await window.sendMessage('getFeatureFlags', {});
      const on = !!(flags && flags['ozon_portal_import'] === true);
      __portalFlagCache = { at: now, on };
      return on;
    } catch (e) {
      console.warn('[followSell] 读取 ozon_portal_import flag 失败,回退官方 API:', e?.message || e);
      return false;
    }
  }

  // maozi 公开商详上架灰度开关(ozon_public_import)。5min 缓存,失败默认 false → 隐藏入口。
  let __publicImportFlagCache = null;
  async function isPublicImportEnabled() {
    try {
      const now = Date.now();
      if (__publicImportFlagCache && now - __publicImportFlagCache.at < 5 * 60 * 1000) {
        return __publicImportFlagCache.on;
      }
      const flags = await window.sendMessage('getFeatureFlags', {});
      const on = !!(flags && flags['ozon_public_import'] === true);
      __publicImportFlagCache = { at: now, on };
      return on;
    } catch (e) {
      return false;
    }
  }

  // maozi v2 公开挂靠灰度开关(ozon_public_follow)。5min 缓存,失败默认 false → 隐藏入口。
  let __publicFollowFlagCache = null;
  async function isPublicFollowEnabled() {
    try {
      const now = Date.now();
      if (__publicFollowFlagCache && now - __publicFollowFlagCache.at < 5 * 60 * 1000) {
        return __publicFollowFlagCache.on;
      }
      const flags = await window.sendMessage('getFeatureFlags', {});
      const on = !!(flags && flags['ozon_public_follow'] === true);
      __publicFollowFlagCache = { at: now, on };
      return on;
    } catch (e) {
      return false;
    }
  }

  async function handleMultiVariantFollowSell(panel, variants) {
    const statusDiv = panel.querySelector('[data-field="mv-status"]');
    // 整个跟卖上架流程包一层兜底:任何未捕获异常(如 Ozon 页面 Vue 重渲染打乱
    // 面板 DOM 导致的 insertBefore NotFoundError)都不再静默卡死 UI,而是给出
    // 错误提示并解锁确认按钮供重试。
    try {
    // Collect selected stores (multi-select checkboxes)
    const selectedStoreIds = [];
    panel.querySelectorAll('.ozon-helper-mv-store-cb:checked').forEach(cb => {
      if (cb.value) selectedStoreIds.push(cb.value);
    });
    if (selectedStoreIds.length === 0) {
      showMvStatus(statusDiv, 'error', '\u8bf7\u81f3\u5c11\u9009\u62e9\u4e00\u4e2a\u5e97\u94fa');
      return;
    }
    const brandChoice = panel.querySelector('[data-field="brand"]')?.value || 'no_brand';
    const imageOrder = panel.querySelector('[data-field="image-order"]')?.value || 'keep';
    const mergeModel = (panel.querySelector('[data-field="merge-model"]')?.value || '').trim();
    const currencyCode = panel.querySelector('[data-field="currency"]')?.value || 'CNY';
    const applyPoster = panel.querySelector('[data-field="apply-poster"]')?.checked || false;
    // 只改主图:仅在 applyPoster 启用时有意义,关闭海报时这个标志透传也不影响 backend
    // (product-import.worker.ts:316 primaryOnly = Boolean(payload.posterPrimaryOnly),
    // applyPoster=false 时 ai-poster 子任务不会跑)。
    const posterPrimaryOnly = panel.querySelector('[data-field="poster-primary-only"]')?.checked || false;
    const applyAiRewrite = panel.querySelector('[data-field="apply-ai-rewrite"]')?.checked || false;
    const ts = panel._templateSettings || {};
    // V1 \u65e7\u7248 ai-image (applyAiImage / aiImageScene / aiImagePrompt) \u5df2\u4e0b\u7ebf\uff0c\u4ec5 V2 \u6d77\u62a5

    // Gather checked variants from remaining DOM rows (some may have been deleted)
    const checkedRows = [];
    panel.querySelectorAll('[data-field="variant-tbody"] tr').forEach(row => {
      const cb = row.querySelector('.ozon-helper-mv-check');
      if (cb && cb.checked) {
        const idx = parseInt(cb.dataset.idx);
        checkedRows.push({ row, idx, variant: variants[idx] });
      }
    });
    // Also build checkedIndices for backward compatibility with prefetch logic
    const checkedIndices = checkedRows.map(r => r.idx);
    if (checkedRows.length === 0) {
      showMvStatus(statusDiv, 'error', '\u8bf7\u81f3\u5c11\u9009\u62e9\u4e00\u4e2a\u53d8\u4f53');
      return;
    }

    // Validate prices and stock. Ozon caps price at ~9 digits; reject NaN /
    // negative / unreasonably large values up front instead of letting them
    // round-trip and fail mid-import after the rate-limit slot is consumed.
    const PRICE_MAX = 9_999_999;
    const STOCK_MAX = 1_000_000;
    for (const { row, idx, variant } of checkedRows) {
      const priceInput = row.querySelector('.ozon-helper-mv-price');
      const price = window.normalizePrice(priceInput?.value);
      if (!Number.isFinite(price) || price <= 0 || price > PRICE_MAX) {
        showMvStatus(statusDiv, 'error', `\u53d8\u4f53 ${idx + 1} (SKU: ${variant.sku}) \u4ef7\u683c\u65e0\u6548\uff08\u5e94\u4e3a\u6b63\u6570\u4e14\u4e0d\u8d85\u8fc7 ${PRICE_MAX}\uff09`);
        return;
      }
      const oldRaw = row.querySelector('.ozon-helper-mv-oldprice')?.value;
      if (oldRaw && oldRaw.trim() !== '') {
        const oldPrice = parseFloat(oldRaw);
        if (!Number.isFinite(oldPrice) || oldPrice < 0 || oldPrice > PRICE_MAX) {
          showMvStatus(statusDiv, 'error', `\u53d8\u4f53 ${idx + 1} \u5212\u7ebf\u4ef7\u65e0\u6548`);
          return;
        }
      }
      const stockRaw = row.querySelector('.ozon-helper-mv-stock')?.value;
      if (stockRaw !== undefined && stockRaw !== '') {
        const stockNum = Number(stockRaw);
        if (!Number.isInteger(stockNum) || stockNum < 0 || stockNum > STOCK_MAX) {
          showMvStatus(statusDiv, 'error', `\u53d8\u4f53 ${idx + 1} \u5e93\u5b58\u65e0\u6548\uff08\u5fc5\u987b\u4e3a 0~${STOCK_MAX} \u7684\u6574\u6570\uff09`);
          return;
        }
      }
    }

    // 会员上品配额预校验:达上限直接拦截 + 引导升级,不打后端(不消耗限流槽/不留 FAILED 记录)。
    // 拉取失败(网络/未登录)时静默放行,让后端兜底,避免误拦。
    try {
      const memRes = await window.sendMessage('getMembershipSummary', {});
      if (memRes && memRes.ok && memRes.data) {
        const quota = evaluateListingQuota(memRes.data, checkedRows.length);
        if (quota.blocked) {
          showMvUpgradeBlock(statusDiv, quota.message);
          return;
        }
      }
    } catch (_) { /* 静默放行 */ }

    // Lock UI to prevent duplicate submissions
    const _confirmBtn = panel.querySelector('[data-action="confirm"]');
    const _dialog = panel.querySelector('.ozon-helper-mv-dialog');
    if (_confirmBtn) { _confirmBtn.disabled = true; _confirmBtn.textContent = '上架中...'; }
    if (_dialog) _dialog.classList.add('is-submitting');
    const _unlockUI = () => {
      if (_confirmBtn) { _confirmBtn.disabled = false; _confirmBtn.textContent = '一键上架至OZON'; }
      if (_dialog) _dialog.classList.remove('is-submitting');
    };

    // 提前抓页面数据(给 galleryMap 用),原 const breadcrumbs/pageProduct 后面会再用一次,删除重复声明
    const breadcrumbs = extractBreadcrumbs();
    const pageProduct = extractProductData();

    // Pre-fetch _sourceVariant for all checked variants.
    // search-variant-model 的 name 是模糊搜索, 返回卖家自己目录里 attr 9024(Артикул) 含输入 SKU 的产品。
    // 注意: items[].variant_id 是卖家内部 id, ≠ 输入 SKU。必须按输入 SKU 作 key, 用 9024 前缀做精确匹配。
    const sourceMap = new Map();
    const galleryMap = new Map(); // sku → 完整图册(从 entrypoint-api 抓)
    const richContentMap = new Map(); // sku → 源富内容 11254 JSON(从 composer widgetStates 抽,跟卖卡保留富内容)
    const matched = [];
    const skipped = [];

    // 当前页变体的图册直接复用 pageProduct.images (已经是完整的页面图册)
    if (pageProduct.sku && (pageProduct.images || []).length > 0) {
      galleryMap.set(String(pageProduct.sku), [...pageProduct.images]);
    }
    // 锚点(当前页)图册复用了 pageProduct.images、不走下面的 fetchVariantGallery 预取循环,
    // 故单独补抓一次它的 composer 富内容(其余被选变体在预取循环里顺带抽,同一次 fetch)。
    if (pageProduct.sku) {
      try {
        const anchorSrc = await fetchVariantGallery(window.location.pathname);
        if (anchorSrc && anchorSrc.richContent) {
          richContentMap.set(String(pageProduct.sku), anchorSrc.richContent);
        }
      } catch {}
    }

    // 在 items 里挑出 attr 9024 以输入 SKU 为前缀的那个
    // 多个匹配时, 优先选 "可变特性 collection 最少" 的 (单色变体, 不是多色 umbrella);
    // 避免历史 follow-sell 留下的 multi-variant 整合 item 把多色一并塞进单一变体。
    const pickItemForSku = (items, sku) => {
      if (!Array.isArray(items) || items.length === 0) return null;
      const matching = items.filter(it =>
        (it.attributes || []).some(a =>
          String(a.key) === '9024' &&
          (String(a.value || '').startsWith(sku + '-') || String(a.value || '') === sku)
        )
      );
      if (matching.length === 0) return items[0] || null;
      // 评分: 把可变特性 (颜色 10096 / 颜色变体 22814 / 材料 8219) collection 大小相加,数字越小越「纯净」
      const score = (it) => {
        let s = 0;
        for (const key of ['10096','22814','8219']) {
          const a = (it.attributes || []).find(x => String(x.key) === key);
          if (Array.isArray(a?.collection)) s += a.collection.length;
          else if (a?.value) s += 1;
        }
        return s;
      };
      matching.sort((a, b) => score(a) - score(b));
      return matching[0];
    };

    // Gate check: prefetch first variant to validate Seller Portal access
    const firstSku = String(variants[checkedIndices[0]].sku);
    const firstResp = await prefetchSourceVariantWithItems(firstSku, statusDiv, showMvStatus);
    if (firstResp === false) {
      _unlockUI();
      return;
    }
    const firstPicked = pickItemForSku(firstResp.items, firstSku);
    if (firstPicked) {
      sourceMap.set(firstSku, firstPicked);
      matched.push(firstSku);
    } else {
      skipped.push(firstSku);
      console.log(`[MultiFollowSell] First variant ${firstSku} not found in Seller Portal, proceeding with category fallback`);
    }

    // 剩余变体: 每个 SKU 单独发一次 API
    // AbortController scoped to the prefetch + gallery loop so the user can
    // bail out via the "取消" button when matching dozens of variants is
    // taking long (or when seller portal is being slow). When aborted we
    // unwind to the calling form intact — sourceMap/matched/skipped reflect
    // whatever we finished before cancellation.
    const prefetchAbort = new AbortController();
    let prefetchCancelled = false;
    const onCancelPrefetch = () => {
      prefetchCancelled = true;
      try { prefetchAbort.abort(); } catch {}
    };

    const BATCH_SIZE = 3;
    const remainingIndices = checkedIndices.slice(1);

    for (let b = 0; b < remainingIndices.length; b += BATCH_SIZE) {
      if (prefetchCancelled) break;
      const batch = remainingIndices.slice(b, b + BATCH_SIZE);
      const completed = matched.length + skipped.length;
      showMvStatus(
        statusDiv,
        'loading',
        `正在匹配变体 (${completed}/${checkedIndices.length})...`,
        { onCancel: onCancelPrefetch }
      );

      const promises = batch.map(async (idx) => {
        if (prefetchCancelled) return;
        const sku = String(variants[idx].sku);
        try {
          const resp = await window.sendMessage('searchVariants', { sku });
          let items = resp?.items || resp?.data?.items || [];
          let picked = pickItemForSku(items, sku);
          // sv 没命中 → 降级 /api/v1/search 全平台 API（陌生 SKU 跟卖必走）
          if (!picked) {
            try {
              const searchResp = await window.sendMessage('searchProductBySku', { sku });
              const globalItems = searchResp?.items || searchResp?.data?.items || [];
              if (globalItems.length > 0) {
                items = globalItems;
                picked = pickItemForSku(items, sku) || globalItems[0];
              }
            } catch (e2) {
              console.warn(`[MultiFollowSell] /search fallback failed for SKU ${sku}:`, e2?.message);
            }
          }
          if (picked) {
            sourceMap.set(sku, picked);
            matched.push(sku);
          } else {
            skipped.push(sku);
          }
        } catch (e) {
          console.warn(`[MultiFollowSell] Pre-fetch failed for SKU ${sku}:`, e.message);
          skipped.push(sku);
        }
      });
      await Promise.allSettled(promises);
    }

    if (prefetchCancelled) {
      showMvStatus(statusDiv, 'error', '已取消变体匹配，可调整选择后重试');
      _unlockUI();
      return;
    }

    console.log(`[MultiFollowSell] Variant match: ${matched.length}/${checkedIndices.length}`, { matched, skipped });
    for (const [sku, sv] of sourceMap.entries()) {
      const cat = (sv.categories || []).map(c => c.name || c.title).join(' → ');
      const t = (sv.attributes || []).find(a => String(a.key) === '8229')?.value;
      console.log(`[MultiFollowSell]   ${sku} → desc_cat_id=${sv.description_category_id}, type=${t || 'N/A'}, cat=${cat}`);
    }

    // 并行抓取每个变体的完整图册 (除了已用 pageProduct.images 的当前页变体)
    // 这是为了让每个变体跟卖时图片和原先 Ozon 上发布的一致
    const galleryFetchTargets = checkedRows
      .filter(({ variant: v }) => v.link && !galleryMap.has(String(v.sku)))
      .map(({ variant: v }) => v);
    if (galleryFetchTargets.length > 0) {
      let galleryDone = 0;
      let galleryCancelled = false;
      const onCancelGallery = () => { galleryCancelled = true; };
      showMvStatus(
        statusDiv,
        'loading',
        `正在拉取变体图册 (0/${galleryFetchTargets.length})...`,
        { onCancel: onCancelGallery }
      );
      const GALLERY_BATCH = 4;
      for (let g = 0; g < galleryFetchTargets.length; g += GALLERY_BATCH) {
        if (galleryCancelled) break;
        const sub = galleryFetchTargets.slice(g, g + GALLERY_BATCH);
        await Promise.allSettled(sub.map(async (v) => {
          if (galleryCancelled) return;
          const { images: imgs, richContent } = await fetchVariantGallery(v.link);
          if (imgs.length > 0) {
            galleryMap.set(String(v.sku), imgs);
          }
          if (richContent) {
            richContentMap.set(String(v.sku), richContent);
          }
          galleryDone += 1;
        }));
        if (!galleryCancelled) {
          showMvStatus(
            statusDiv,
            'loading',
            `正在拉取变体图册 (${Math.min(galleryDone, galleryFetchTargets.length)}/${galleryFetchTargets.length})...`,
            { onCancel: onCancelGallery }
          );
        }
      }
      const fetched = Array.from(galleryMap.keys()).filter(sku => sku !== String(pageProduct.sku || '')).length;
      console.log(`[MultiFollowSell] Gallery fetched for ${fetched}/${galleryFetchTargets.length} variants${galleryCancelled ? ' (cancelled)' : ''}`);
      if (galleryCancelled) {
        showMvStatus(statusDiv, 'error', `已取消图册抓取（已抓 ${fetched} 个），将继续提交。如要重试请关闭面板`);
        // Continue to submit — user may still want partial gallery data.
      }
    }

    // 类目一致性: 强制所有变体跟"锚点变体"(优先当前页变体, 否则首个匹配到 _sourceVariant 的变体) 用同一个类目
    // 解决问题: Ozon 源商品在不同变体上可能被打到不同的细分类目 (例: 按摩垫 vs 澡巾),
    // 用户通常希望批量跟卖的所有变体进入同一个类目卡片
    //
    // ⚠️ 仅适用于「同一 listing 的兄弟变体」。「跟卖本页商品卡」(independentProducts) 下,
    // 每个卡片是彼此无关的独立商品(收纳盒 / 发箍 / 首饰盒…),强制对齐会把全部错打成首个
    // 商品的类目(线上表现:全部显示同一个"保养套件"等类目)。此模式下跳过,各 SKU 用自己的源类目。
    const independentProducts = panel?.dataset?.independentProducts === '1';
    const anchorSku = (pageProduct.sku && sourceMap.has(String(pageProduct.sku)))
      ? String(pageProduct.sku)
      : matched[0];
    const anchorSv = anchorSku ? sourceMap.get(anchorSku) : null;
    if (anchorSv && !independentProducts) {
      const anchorDescCatId = anchorSv.description_category_id;
      const anchorCategories = anchorSv.categories;
      const anchorTypeAttr = (anchorSv.attributes || []).find(a => String(a.key) === '8229');
      console.log(`[MultiFollowSell] 类目锚点: SKU ${anchorSku} → desc_cat_id=${anchorDescCatId}, type=${anchorTypeAttr?.value || 'N/A'}`);
      for (const [sku, sv] of sourceMap.entries()) {
        if (sku === anchorSku || !sv) continue;
        // 浅克隆后覆盖类目字段, 不污染原对象 (sourceMap 可能被其他逻辑引用)
        const cloned = { ...sv };
        cloned.description_category_id = anchorDescCatId;
        cloned.categories = anchorCategories;
        if (anchorTypeAttr) {
          // 覆盖该变体的 Тип 属性, 让 type_id 解析也对齐到锚点
          const newAttrs = (sv.attributes || []).filter(a => String(a.key) !== '8229');
          newAttrs.push({ ...anchorTypeAttr });
          cloned.attributes = newAttrs;
        }
        sourceMap.set(sku, cloned);
      }
    } else if (independentProducts) {
      console.log('[MultiFollowSell] 跟卖本页商品卡:独立商品模式,跳过类目对齐,各 SKU 保留自身源类目');
    }

    // 视频/PDF complex 属性是商品级的(整个 listing 共用)。bundle(Ozon 复制 API)只对
    // 每次 searchVariants 的 items[0] 拉取,挂在 picked sv 上的 _bundleComplexAttrs 可能缺失
    // (pickItemForSku 选了非 items[0] 的兄弟变体)。这里从锚点 sv 取一次作商品级兜底,
    // 任一变体没有自己的 bundle complex 时回退到它。
    // 独立商品模式(跟卖本页商品卡):不共享视频/PDF —— 各卡片是无关商品,共享会把首品的
    // 视频/PDF 串到其它商品。仅用各 SKU 自己的 _bundleComplexAttrs(下方 per-variant 处理)。
    const sharedBundleComplex = independentProducts ? null : (() => {
      if (Array.isArray(anchorSv?._bundleComplexAttrs) && anchorSv._bundleComplexAttrs.length > 0) {
        return anchorSv._bundleComplexAttrs;
      }
      for (const s of sourceMap.values()) {
        if (Array.isArray(s?._bundleComplexAttrs) && s._bundleComplexAttrs.length > 0) return s._bundleComplexAttrs;
      }
      return null;
    })();
    if (sharedBundleComplex) {
      console.log(`[MultiFollowSell] bundle complex attrs (视频/PDF) available: ${sharedBundleComplex.length}`);
    }

    // 视频(listing 级,整个商品共用):跟卖竞品时 Ozon 不接受任意直链 .mp4 —— 把当前 PDP 的
    // .mp4 经 captureAndTransferPageVideo(SW uploadFollowSellVideo 走 seller-tab 会话)转存成
    // 卖家自有 Ozon 视频(ir.ozone.ru/s3),后端 injectUserVideoComplexAttribute 注入主视频槽。
    // 与单采/纯采集共用同一 helper(此前为各自内联,逻辑已统一)。
    // 独立商品模式跳过:页面视频(若有)只属于当前 PDP,不该串到本页其它无关商品卡。
    let sharedVideo = null;
    if (!independentProducts) {
      // 进度提示:用本函数作用域里的提交按钮(_confirmBtn)。
      const onLabel = (t) => { try { if (typeof _confirmBtn !== 'undefined' && _confirmBtn) _confirmBtn.textContent = t; } catch (_) {} };
      const media = await captureAndTransferPageVideoMedia(onLabel);
      if (media?.videoUrl || media?.videoCover) {
        sharedVideo = { url: media.videoUrl || null, cover: media.videoCover || null };
      }
    }

    // Page-level dimension scrape — used as last-resort fallback when a variant's
    // source-variant (seller-portal sv) has no 4383/4497/9454-9456 attrs (common for
    // cross-platform foreign SKUs). Same characteristics for the listing apply to
    // every variant on the same page.
    // 独立商品模式不取页面级三维:列表页 extractCharacteristics 不对应任何单一商品,
    // 串给全部变体会污染尺寸/重量。各 SKU 走自身 source attrs / 后端兜底链即可。
    const pageScrapedDims = independentProducts
      ? {}
      : parseScrapedDimensionsFromCharacteristics(extractCharacteristics() || []);
    if (pageScrapedDims.weight || pageScrapedDims.depth || pageScrapedDims.width || pageScrapedDims.height) {
      console.log('[MultiFollowSell] Page-scraped dimensions:', pageScrapedDims);
    }

    // Build items array (breadcrumbs/pageProduct 已在前面声明)
    const items = [];
    // 「复制当前品牌」用:源商品品牌取自页面 state-webBrand(JSON-LD 兜底),商品级整组共享。
    // 后端只从 _sourceVariant(变体模型)找品牌属性时,那里可能恒无品牌(品牌非变体级)。
    // 因此这里把源品牌真名显式透传给后端,避免复制落空后静默退「无品牌」。
    const _sourceBrand = (pageProduct && pageProduct.brand) ? String(pageProduct.brand).trim() : '';
    const contentCopy = window.JZFollowSellContentCopy;

    // #146:主题标签(webHashtags 控件)是商品级的,整组变体共用。跟卖时复制到每个变体卡,
    // 后端 buildHashtagValues 会规范化 + 按类目 is_collection 写主题标签属性(开 AI 重写时由 AI 标签覆盖)。
    const sharedHashtags = extractKeywords();
    if (sharedHashtags.length > 0) {
      console.log(`[MultiFollowSell] 复制源主题标签 ${sharedHashtags.length} 个`);
    }

    for (const { row, idx, variant: v } of checkedRows) {
      const price = window.normalizePrice(row.querySelector('.ozon-helper-mv-price')?.value);
      const oldPrice = parseFloat(row.querySelector('.ozon-helper-mv-oldprice')?.value) || (price * 1.25);
      // 最低价(Ozon 自动调价下限,选填):用户留空 → 不传 min_price 字段,Ozon 默认不参与自动调价
      const minPriceRaw = row.querySelector('.ozon-helper-mv-minprice')?.value;
      const minPriceNum = minPriceRaw != null && minPriceRaw !== '' ? Number(minPriceRaw) : NaN;
      const minPrice = Number.isFinite(minPriceNum) && minPriceNum > 0 ? minPriceNum : null;
      const stock = parseInt(row.querySelector('.ozon-helper-mv-stock')?.value) || 0;
      const offerId = row.querySelector('.ozon-helper-mv-offerid')?.value || `SKU${v.sku}-${Date.now().toString().slice(-4)}`;
      // Per-variant image extraction
      // 优先用 galleryMap (从 entrypoint-api 抓到的该变体页面完整图册,跟原 Ozon 发布一致)
      // 兜底链: sourceVariant.attributes[4194]+[4195] → coverImage
      const sv = sourceMap.get(String(v.sku));
      // 该变体自己的 bundle 视频/PDF complex,缺失时回退商品级兜底(视频整 listing 共用)
      const bundleComplex = (Array.isArray(sv?._bundleComplexAttrs) && sv._bundleComplexAttrs.length > 0)
        ? sv._bundleComplexAttrs
        : sharedBundleComplex;

      // 物理参数解析优先级:用户实际输入 > 源 sourceVariant attrs > 留空让后端兜底
      // readSourceInt 直接读 g/mm 整数;readSourceWeightKg 读 4383 kg 浮点(如 "0.05")并 *1000 转 g
      // 兜底前(无 user / 无 source)发 undefined,让后端的 resolveViaSearchVariantModel
      // 和 prepareImport 沿 scraped_* → source attr 链路接续尝试,不再被 100 占位 shadow。
      //
      // parseStrictNumber:**严格只接受纯数字字符串**(允许俄式逗号 "0,05" 转点)。带单位的
      // "1.2kg" / "10 cm" 一律返回 NaN,让 backend 走 _sourceVariant.attributes 路径自己
      // 用 parseWeightToGrams/parseDimToMm 做单位识别。
      // (codex review round 3 指出:旧版只提数字部分会让前端送 weight=1 给 "1.2kg"
      // 这种值,被 backend 当成 user-set 1g 直接采纳,完全跳过 sourceAttrMap 解析。)
      const parseStrictNumber = (raw) => {
        if (raw == null) return NaN;
        const s = String(raw).replace(',', '.').trim();
        if (!/^-?\d+(?:\.\d+)?$/.test(s)) return NaN;
        return Number(s);
      };
      const readSourceInt = (key) => {
        const a = (sv?.attributes || []).find(x => String(x.key) === String(key));
        const n = parseStrictNumber(a?.value);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
      };
      const readSourceWeightKgAsG = () => {
        const a = (sv?.attributes || []).find(x => String(x.key) === '4383');
        const n = parseStrictNumber(a?.value);
        if (!Number.isFinite(n) || n <= 0) return null;
        // 4383 通常是 kg 浮点("0.05" / "1.2" / "0,05");>100 时可能本来就是 g,跟后端 product.service.ts:2195 启发式对齐
        return n < 100 ? Math.round(n * 1000) : Math.round(n);
      };
      // 用户实际输入:只有当 form 是有限正数才算真填了。NaN/0/空都视为未填。
      // 与 source attr 路径一致用 parseStrictNumber:用户粘贴 "1.2 kg" / "10 cm" 这种
      // 带单位字符串(虽然 <input type="number"> 会拦截输入,但粘贴/JS 设值可绕过)
      // 一律视为未填,让后端从 _sourceVariant.attributes 解析,避免 1g/10mm 误写。
      const parseUserInt = (sel) => {
        const n = parseStrictNumber(row.querySelector(sel)?.value);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
      };
      const userWeight = parseUserInt('.ozon-helper-mv-weight');
      const userDepth  = parseUserInt('.ozon-helper-mv-depth');
      const userWidth  = parseUserInt('.ozon-helper-mv-width');
      const userHeight = parseUserInt('.ozon-helper-mv-height');
      // weight: user > source 4497(packaged g) > source 4383(kg→g) > undefined
      const weight = userWeight || readSourceInt('4497') || readSourceWeightKgAsG() || undefined;
      const depth  = userDepth  || readSourceInt('9454') || undefined;
      const width  = userWidth  || readSourceInt('9455') || undefined;
      const height = userHeight || readSourceInt('9456') || undefined;
      const variantGallery = galleryMap.get(String(v.sku)) || [];
      // 源富内容(11254):从该变体 composer 抽到则注入 _sourceVariant.attributes,让后端
      // pickSourceRichContent 命中 follow_source(否则跟卖卡不带富内容)。幂等:已有则不重复加。
      const variantRichContent = richContentMap.get(String(v.sku)) || '';
      if (variantRichContent && sv && typeof sv === 'object') {
        if (!Array.isArray(sv.attributes)) sv.attributes = [];
        if (!sv.attributes.some((a) => String(a.key) === '11254')) {
          sv.attributes.push({ key: '11254', value: variantRichContent });
        }
      }
      let allImages = [];
      const seenUrls = new Set();
      const pushUrl = (u) => {
        if (!u || typeof u !== 'string') return;
        const norm = u.split('?')[0].split('#')[0].toLowerCase();
        if (seenUrls.has(norm)) return;
        seenUrls.add(norm);
        allImages.push(u);
      };

      let imageSource = 'none';
      if (variantGallery.length > 0) {
        // 主路径: 该变体页面的完整图册 (与原 Ozon 一致)
        for (const url of variantGallery) pushUrl(url);
        imageSource = 'pageState';
      } else if (sv?.attributes) {
        // 兜底 1: sourceVariant attrs (search-variant-model 返回)
        const primaryImgAttr = sv.attributes.find(a => String(a.key) === '4194');
        const addlImgAttr = sv.attributes.find(a => String(a.key) === '4195');
        if (primaryImgAttr?.value) pushUrl(primaryImgAttr.value);
        if (addlImgAttr?.collection?.length > 0) {
          for (const url of addlImgAttr.collection) pushUrl(url);
        }
        if (allImages.length > 0) imageSource = 'sourceVariant';
      }
      if (allImages.length === 0 && v.coverImage) {
        pushUrl(v.coverImage);
        imageSource = 'coverImage';
      }
      // Apply image order setting
      if (imageOrder === 'shuffle' && allImages.length > 1) {
        for (let k = allImages.length - 1; k > 0; k--) {
          const j = Math.floor(Math.random() * (k + 1));
          [allImages[k], allImages[j]] = [allImages[j], allImages[k]];
        }
      } else if (imageOrder === 'shuffle_keep_first' && allImages.length > 2) {
        const first = allImages[0];
        const rest = allImages.slice(1);
        for (let k = rest.length - 1; k > 0; k--) {
          const j = Math.floor(Math.random() * (k + 1));
          [rest[k], rest[j]] = [rest[j], rest[k]];
        }
        allImages = [first, ...rest];
      }
      const productImages = allImages.map((url, i) => ({ file_name: url, default: i === 0 }));
      console.log(`[MultiFollowSell] Variant ${v.sku}: ${allImages.length} images (source: ${imageSource})`);

      // Use DOM variant name (may have been modified by template: removeKeywords, titleSuffix).
      // Trim + cap to Ozon limits (name ≤200, description ≤4096) — sending raw
      // user-edited strings has caused mid-import failures and confused error
      // messages. Backend will still validate, this is the friendly first stop.
      const NAME_MAX = 200;
      const DESC_MAX = 4096;
      const safeText = (s, max) => {
        if (s == null) return '';
        const trimmed = String(s).replace(/\s+/g, ' ').trim();
        return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
      };
      // 名称取值链(避开浏览器翻译 + 角标污染两类脏源):
      // 1. 未被编辑(DOM 与渲染基线 data-jz-base-title 一致)→ jzPreferSourceName:
      //    DOM 被 Chrome 翻译成中文、或混入角标/价格污染 → 强制 sv 4180 真名;
      //    干净 DOM 优先(sv 缺名时兜底)。合并卡变体 tile 的 data.title 是促销角标
      //    textRs 拼接(如「0% до 140 днейСкидки недели」),不是商品名 — 22508
      //    BR_attribute_advertising 事故的源头,必须在这里就切换到 sv 真名。
      // 2. 模板 removeKeywords/titleSuffix 改过(与基线不一致)→ 尊重编辑结果,
      //    只保留翻译中文防线。
      // 3. 终检:最终名过 jzStripPromo;剥后只剩残词且有 sv 真名 → 用 sv(后端
      //    product.service 有同口径兜底,这里是源头防线)。
      const _name4180 = (sv?.attributes || []).find((a) => String(a.key) === '4180');
      const sourceName = _name4180?.value
        ? String(_name4180.value).replace(/\s+/g, ' ').trim()
        : '';
      const _titleEl = row.querySelector('.ozon-helper-mv-variant-title-text') ||
        row.querySelector('.ozon-helper-mv-variant-name');
      const _domRaw = (_titleEl?.textContent || '').trim();
      const domName = _domRaw === '-' ? '' : _domRaw; // '-' 是空标题的渲染占位
      const _baseTitle = (_titleEl?.dataset?.jzBaseTitle || '').trim();
      const titleEdited = !!domName && !!_baseTitle && domName !== _baseTitle;
      const _isCN = (s) => /[一-龥]/.test(s);
      const looksTranslated = sourceName && _isCN(domName) && !_isCN(sourceName);
      let rawName;
      if (titleEdited) {
        rawName = looksTranslated ? sourceName : domName;
      } else if (window.jzPreferSourceName) {
        rawName = window.jzPreferSourceName(sourceName, domName) || v.title || '';
      } else {
        rawName = looksTranslated
          ? sourceName
          : (domName || sourceName || v.title || '');
      }
      if (window.jzStripPromo) {
        const strippedName = window.jzStripPromo(rawName);
        if (window.jzIsPromoResidualTitle?.(rawName, strippedName)) {
          const svClean = sourceName
            ? (window.jzStripPromo(sourceName) || sourceName)
            : '';
          rawName = svClean || strippedName || rawName;
        } else if (strippedName) {
          rawName = strippedName;
        }
      }
      const variantName = safeText(rawName, NAME_MAX);
      // 简介只取源真实描述(自定义→源 4191),空则退标题；不再用页面描述兜底(会抓回富内容)。
      const description = contentCopy?.pickFollowSellDescription
        ? contentCopy.pickFollowSellDescription({
            customDescription: ts.customDescription,
            sourceVariant: sv,
            richContent: variantRichContent,
            fallbackName: variantName,
            max: DESC_MAX,
          })
        : safeText(ts.customDescription || variantName, DESC_MAX);
      contentCopy?.mergeSourceHashtagsIntoVariant?.(sv, sharedHashtags);
      items.push({
        offer_id: offerId,
        name: variantName,
        price: price.toFixed(2),
        old_price: oldPrice.toFixed(2),
        // 用户填了正数最低价才发 min_price(Ozon 自动调价下限,选填字段);
        // 留空 / 0 时不发,避免 Ozon 校验 / 误启用自动调价
        ...(minPrice != null ? { min_price: minPrice.toFixed(2) } : {}),
        vat: '0',
        currency_code: currencyCode,
        images: productImages,
        // 视频:两条互补路径。
        // (1) bundleComplexAttrs:bundle(Ozon 复制 API)返回的视频/PDF complex —— 仅自有商品复制时有,
        //     跟卖竞品恒空(Ozon 不复制原卖家视频)。
        // (2) videoUrl:PDP gallery 抓的公开 .mp4 —— 跟卖竞品时唯一能拿到视频的来源。后端
        //     injectUserVideoComplexAttribute 据此建视频 complex,且对 (1) 已建的视频幂等跳过。
        bundleComplexAttrs: bundleComplex || undefined,
        ...(sharedVideo?.url ? { videoUrl: sharedVideo.url } : {}),
        ...(sharedVideo?.cover ? { videoCover: sharedVideo.cover } : {}),
        scraped_breadcrumbs: breadcrumbs,
        scraped_description: description,
        // #146:把源商品主题标签随跟卖卡带上(后端写主题标签属性;开 AI 重写时被 AI 标签覆盖)
        ...(sharedHashtags.length > 0 ? { _aiHashtags: sharedHashtags } : {}),
        scraped_sku: String(v.sku),
        scraped_brand: brandChoice,
        // 选「复制当前品牌」时透传源品牌真名,后端据此匹配目标类目品牌字典(空=源本无品牌→无品牌)
        scraped_brand_value: (brandChoice === 'copy' && _sourceBrand) ? _sourceBrand : undefined,
        scraped_model_name: mergeModel ? safeText(mergeModel, NAME_MAX) : undefined,
        _sourceVariant: sv || undefined,
        // 物理参数若为 undefined,JSON.stringify 会跳过该 key,
        // 后端 prepareImport / resolveViaSearchVariantModel 将沿 source attr → scraped_* 兜底链补齐。
        // weight_unit / dimension_unit 也跟着只在有值时才送。
        weight: weight,
        weight_unit: weight != null ? 'g' : undefined,
        depth: depth, width: width, height: height,
        dimension_unit: (depth != null || width != null || height != null) ? 'mm' : undefined,
        // scraped_* 是页面 DOM 兜底:source variant attrs 缺失时(常见于陌生跨平台 SKU)
        // 后端可以接续兜底,而不是直接落到 100×100×100mm/100g。
        // 这些字段独立于 weight/depth/.../user input,即便 weight 已经填了也带上 — 不浪费一份信息。
        scraped_weight: pageScrapedDims.weight,
        scraped_depth: pageScrapedDims.depth,
        scraped_width: pageScrapedDims.width,
        scraped_height: pageScrapedDims.height,
        _stock: stock,
      });
    }

    // 提交前预检(标题质量 / 物流参数):只「建议」,不阻塞、不弹 confirm 逼用户二选一。
    // 命中只在面板内挂一条非阻塞提示条引导优化,提交照常进行(对齐批量上架的进度日志提示)。
    const advisories = [];

    // 标题质量(免费纯规则):没开 AI 重写时,源标题(attr 4180)原样上架易被 Ozon 判
    // 「无意义/语法错误/看不出是什么商品」。用最终拼好的 items[].name(含翻译回退/模板编辑)。
    if (!applyAiRewrite && window.JZTitleQuality) {
      const badTitles = items.filter(it => !window.JZTitleQuality.checkTitleQuality(it.name).ok);
      if (badTitles.length > 0) {
        advisories.push(`${badTitles.length} 个商品标题偏短/疑似无意义,Ozon 可能拒(从源 SKU 原样复制)。建议开启「AI 重写」自动优化,或手改标题。`);
        console.warn(`[MultiFollowSell] ${badTitles.length} low-quality titles (advisory only, not blocking)`);
      }
    }

    // 物流参数缺失:SKU 既无用户输入、也无源 sv attrs(4497/4383/9454-9456)、也无页面 DOM 兜底
    // → 后端落 100×100×100mm/100g,Ozon 按最大体积费率算物流费,可能压缩利润。
    const missingDimsItems = items.filter(it => {
      const noPhys = !it.weight && !it.depth && !it.width && !it.height;
      const noScraped = !it.scraped_weight && !it.scraped_depth && !it.scraped_width && !it.scraped_height;
      return noPhys && noScraped;
    });
    if (missingDimsItems.length > 0) {
      advisories.push(`${missingDimsItems.length} 个 SKU 无物流参数,将按默认 100×100×100mm/100g(Ozon 用最大体积费率,可能压缩利润)。建议手填重量/尺寸。`);
      console.warn(`[MultiFollowSell] ${missingDimsItems.length} items missing dim data (advisory only, not blocking)`);
    }

    // 非阻塞提示条:列出建议项,但本次仍照常提交(不取消、不要求用户先做选择)。
    if (advisories.length > 0) {
      const body = panel.querySelector('.ozon-helper-mv-body');
      const wrap = body?.querySelector('.ozon-helper-mv-table-wrap');
      if (body && wrap) {
        panel.querySelectorAll('.ozon-helper-mv-precheck-advisory').forEach(el => el.remove());
        const notice = document.createElement('div');
        notice.className = 'ozon-helper-mv-error-notice ozon-helper-mv-precheck-advisory';
        notice.style.background = '#FFFBEB';
        notice.style.borderColor = '#F59E0B';
        notice.style.color = '#92400E';
        notice.innerHTML = `<span class="ozon-helper-mv-error-icon" style="background:#F59E0B;">!</span><span>${advisories.join('<br>')}<br><b>本次仍按当前内容照常提交。</b></span>`;
        // 用 insertAdjacentElement 而非 body.insertBefore:Ozon 页面 Vue 重渲染
        // 可能打乱面板 DOM 层级,wrap 不再是 body 直接子节点会让 insertBefore 抛
        // NotFoundError 卡死整个上架流程(see handleMultiVariantFollowSell try-catch)。
        wrap.insertAdjacentElement('beforebegin', notice);
      }
    }

    // Submit to each selected store IN PARALLEL
    const totalStores = selectedStoreIds.length;
    showMvStatus(statusDiv, 'loading',
      totalStores > 1
        ? `正在提交 ${totalStores} 个店铺 (${items.length} 个商品)...`
        : `正在提交 ${items.length} 个商品...`
    );

    // 门户上架灰度:flag ozon_portal_import 开 **且** 用户在「上架方式」选了「模拟手动上架」
    // 才走 seller.ozon.ru bundle 接口(绕官方 import 限流)。flag 关 → 选择器不显示、永远 API。
    // flag 读取 5min 缓存,任何失败默认关 → 回退官方 API,零风险。
    const portalFlagOn = await isPortalImportEnabled();
    const uploadModeEl = panel.querySelector('input[name="jz-upload-mode"]:checked');
    const viaPortal = portalFlagOn && uploadModeEl?.value === 'portal';

    // 兜底:门户只认浏览器当前登录的单店,UI 已收紧成单选;万一漏到多店直接拦下不发请求。
    if (viaPortal && selectedStoreIds.length > 1) {
      showMvStatus(statusDiv, 'error', '模拟手动上架仅支持单店,请只选择一个已登录 seller.ozon.ru 的店铺');
      _unlockUI();
      return;
    }

    const settledResults = await Promise.allSettled(
      selectedStoreIds.map(async (storeId) => {
        const storeName = panel.querySelector(`.ozon-helper-mv-store-cb[value="${storeId}"]`)
          ?.parentElement?.textContent?.trim() || storeId;

        // Resolve warehouse_id first so stocks can be sent with the followSell payload
        // (backend worker imports stocks after product import succeeds — correct ordering).
        // 优先级：该店铺已选仓库 > 当前 UI 选择（仅当前 store）> 模板 ts.warehouseId
        // > 该 store 仓库列表第一个。仓库 ID 不跨店通用,禁止把前一个店铺的 UI 值
        // 直接套到另一个店铺。
        let stocks;
        try {
          const stockEntries = items.filter(item => parseInt(item._stock) > 0);
          if (stockEntries.length > 0) {
            const isCurrentStore = String(storeId) === String(panel._followSellStoreId);
            const savedWarehouseId = panel._selectedWarehouseByStore?.get(String(storeId)) || '';
            const uiWarehouseId = isCurrentStore
              ? (panel.querySelector('[data-field="warehouse-id"]')?.value || '')
              : '';
            let warehouseId = savedWarehouseId || uiWarehouseId || ts.warehouseId || null;
            if (!warehouseId) {
              const whRes = await window.sendMessage('getWarehouses', { storeId });
              const warehouses = parseWarehouseListResponse(whRes);
              warehouseId = warehouses && warehouses.length > 0
                ? (warehouses[0].warehouse_id ?? warehouses[0].warehouseId ?? warehouses[0].id)
                : null;
            }
            if (warehouseId) {
              stocks = stockEntries.map(item => ({
                offer_id: item.offer_id,
                stock: parseInt(item._stock),
                warehouse_id: warehouseId,
              }));
            }
          }
        } catch (whErr) {
          console.warn(`[MultiFollowSell] Warehouse lookup failed for store ${storeName}:`, whErr.message);
        }

        // 埋点（当天去重在 sw 层做,失败静默；多店扇出时去重也能保证只发一次）
        window.sendMessage('usageTrack', { featureKey: 'follow-sell:submit' }).catch(() => {});

        const importResult = await window.sendMessage('followSell', {
          storeId,
          items,
          ...(stocks && stocks.length > 0 ? { stocks } : {}),
          applyPoster,
          ...(applyPoster && posterPrimaryOnly ? { posterPrimaryOnly: true } : {}),
          applyAiRewrite,
          ...(viaPortal ? { viaPortal: true } : {}),
          ...(ts.randomColor !== undefined ? { randomColor: ts.randomColor } : {}),
          ...(ts.enableCopyBanSolution !== undefined ? { enableCopyBanSolution: ts.enableCopyBanSolution } : {}),
          ...(ts.randomAttributesCount !== undefined ? { randomAttributesCount: ts.randomAttributesCount } : {}),
          ...(ts.customDescription ? { customDescription: ts.customDescription } : {}),
          ...(ts.listingType ? { listingType: ts.listingType } : {}),
        });

        const taskId = importResult?.result?.task_id;
        if (!taskId) throw new Error('未收到任务ID');

        // 门户上架:upload_task_id 走 seller.ozon.ru 任务系统(get-list/get-errors)轮询,
        // 与官方 task_id 来源不同,回显时按 _viaPortal 分流。companyId 留给状态查询。
        const isPortalTask = !!importResult?.result?.viaPortal;
        // Backend 已入队（QUEUED），worker 异步执行 AI/Ozon 调用与库存导入。
        return {
          storeName, ok: true, taskId, warnings: [],
          _viaPortal: isPortalTask,
          _companyId: importResult?.result?.company_id || null,
          _taskIds: Array.isArray(importResult?.result?.task_ids) ? importResult.result.task_ids : [taskId],
        };
      })
    );

    // Translate raw backend error fragments into something a non-engineer
    // user can act on. Anything not matched falls through to the original
    // message — no information loss, just nicer phrasing for common cases.
    const humanizeError = (raw) => {
      if (!raw) return '未知错误';
      const msg = String(raw);
      const TABLE = [
        [/IMPORT_RATE_LIMIT|429/i, '上架请求过于频繁，请稍后再试（每分钟最多 30 次）'],
        [/IMPORT_ACTIVE_TASK_LIMIT|已有上架任务|已有.*上架任务.*处理中/i, '当前账号已有上架任务在处理中；已提交的店铺会继续处理，失败店铺请稍后重试'],
        [/AUTH_EXPIRED|401|TOKEN_REVOKED|jwt expired/i, '登录已过期，请重新登录后重试'],
        [/Tenant context missing/i, '租户信息缺失，请重新登录'],
        [/items\.length must be <= 200/i, '单次最多 200 个商品，请分批上架'],
        [/未收到任务ID|task_id/i, '后端未返回任务编号，可能是网络中断，请稍后重试'],
        [/executeScript 未返回结果|bridge 返回错误|seller portal/i, 'seller.ozon.ru 页面通讯失败，请刷新该页签后重试'],
        [/sc_company_id|cookie已过期|请先登录|seller\.ozon\.ru/i, '请确认已登录 seller.ozon.ru'],
        [/NetworkError|Failed to fetch|TimeoutError|超时/i, '网络异常或请求超时，请检查网络后重试'],
        [/Pre-import lookup failed/i, 'Ozon 商品列表查询失败，已中止避免重复，请稍后重试'],
        [/offer_id already exists/i, '商品 offer_id 已存在，请检查是否重复上架'],
        [/Store not found/i, '店铺不存在或无权访问'],
        [/Missing x-ozon-store-id/i, '请先选择一个店铺'],
      ];
      for (const [re, label] of TABLE) {
        if (re.test(msg)) return label;
      }
      return msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
    };

    // Flatten Promise.allSettled results
    const storeResults = settledResults.map((r, i) => {
      const storeName = panel.querySelector(`.ozon-helper-mv-store-cb[value="${selectedStoreIds[i]}"]`)
        ?.parentElement?.textContent?.trim() || selectedStoreIds[i];
      if (r.status === 'fulfilled') return r.value;
      return { storeName, ok: false, error: humanizeError(r.reason?.message || r.reason) };
    });

    // ── 门户上架(viaPortal):create→update→upload 已同步完成,这里内联轮询 Ozon 侧
    // 校验结果(数秒内出 processed/failed),给出真实「成功 X/失败 Y」回显。官方 API 路径
    // 不受影响(只入队即返回,进度在 popup「上架记录」看)。
    if (viaPortal) {
      const okStores = storeResults.filter((r) => r.ok);
      const submitFailed = storeResults.filter((r) => !r.ok);
      if (okStores.length > 0) {
        showMvStatus(statusDiv, 'loading', '已提交卖家中心,正在确认上架结果...');
      }
      const deadline = Date.now() + 16000;
      for (const pr of okStores) {
        pr._created = 0; pr._failed = 0; pr._errs = [];
        const taskIds = Array.isArray(pr._taskIds) && pr._taskIds.length ? pr._taskIds : [pr.taskId];
        for (const tid of taskIds) {
          let st = null;
          while (Date.now() < deadline) {
            st = await window.sendMessage('portalImportStatus', { taskId: String(tid), companyId: pr._companyId || undefined }).catch(() => null);
            if (st && st.done) break;
            await new Promise((res) => setTimeout(res, 2000));
          }
          if (st) {
            pr._created += Math.max(0, Number(st.processed || 0) - Number(st.failed || 0));
            pr._failed += Number(st.failed || 0);
            if (Array.isArray(st.errors)) pr._errs.push(...st.errors);
          }
        }
      }
      const totalCreated = okStores.reduce((s, r) => s + (r._created || 0), 0);
      const totalFailed = okStores.reduce((s, r) => s + (r._failed || 0), 0);
      const firstErr = okStores.flatMap((r) => r._errs || [])[0]?.errors?.[0]?.message;
      const submitFailDetail = submitFailed.map((r) => `${r.storeName}: ${r.error || '未知错误'}`).join('\n');
      if (submitFailed.length === 0 && totalFailed === 0 && totalCreated > 0) {
        saveManualListingConfigAfterSuccess(panel, { lastResult: { viaPortal: true, totalCreated, totalFailed } });
        showMvStatus(statusDiv, 'success',
          `门户上架完成！已通过卖家中心创建 ${totalCreated} 个商品 → ${okStores.length} 个店铺。可在 seller.ozon.ru 商品列表查看。`);
        setTimeout(() => closePanel(panel), 2500);
      } else if (totalCreated > 0) {
        saveManualListingConfigAfterSuccess(panel, { lastResult: { viaPortal: true, totalCreated, totalFailed } });
        const parts = [`门户上架部分成功：创建 ${totalCreated} 个，失败 ${totalFailed} 个。`];
        if (firstErr) parts.push(`失败原因示例: ${firstErr}`);
        if (submitFailDetail) parts.push(`提交失败店铺:\n${submitFailDetail}`);
        showMvStatus(statusDiv, 'error', parts.join('\n'));
      } else {
        const detail = submitFailDetail || (firstErr ? `卖家中心拒绝: ${firstErr}` : '未创建任何商品,请稍后在卖家中心确认');
        showMvStatus(statusDiv, 'error', `门户上架失败:\n${detail}`);
      }
      _unlockUI();
      return;
    }

    // Show final summary
    const matchInfo = `\u53d8\u4f53\u5339\u914d: ${matched.length}/${checkedIndices.length}`;
    const skippedInfo = skipped.length > 0
      ? ` (SKU ${skipped.join(', ')} \u4f7f\u7528\u7c7b\u76ee\u56de\u9000)` : '';
    const successCount = storeResults.filter(r => r.ok).length;
    const failedStores = storeResults.filter(r => !r.ok);

    if (failedStores.length === 0) {
      saveManualListingConfigAfterSuccess(panel, { lastResult: { viaPortal: false, successCount, totalStores } });
      const allWarnings = storeResults.flatMap(r => r.warnings || []);
      const warnText = allWarnings.length > 0
        ? `\n提醒: ${allWarnings[0]}`
        : '';
      showMvStatus(statusDiv, 'success',
        `已提交到后台！${items.length} 个商品正在后台上架到 ${successCount} 个店铺，可在插件弹窗「上架记录」查看进度 (${matchInfo}${skippedInfo})${warnText}`);
      setTimeout(() => closePanel(panel), allWarnings.length > 0 ? 5000 : 2000);
    } else if (successCount > 0) {
      saveManualListingConfigAfterSuccess(panel, { lastResult: { viaPortal: false, successCount, totalStores } });
      const failDetail = failedStores
        .map(r => `${r.storeName}: ${r.error || '未知错误'}`)
        .join('\n');
      showMvStatus(statusDiv, 'error',
        `部分入队成功: ${successCount}/${totalStores} 个店铺已提交。\n失败明细:\n${failDetail}`);
    } else {
      const failDetail = failedStores.map(r => `${r.storeName}: ${r.error || '未知错误'}`).join('\n');
      showMvStatus(statusDiv, 'error', `提交失败:\n${failDetail}`);
    }
    // Always re-enable confirm button so user can retry on error
    _unlockUI();
    } catch (err) {
      // 同步 DOM 异常(如 insertBefore)或 await 链抛错统一在此兜底,绝不再静默卡死。
      console.error('[MultiFollowSell] 上架流程未捕获异常,已解锁 UI 供重试:', err);
      try { showMvStatus(statusDiv, 'error', '上架出错:' + (err?.message || err) + '，请刷新页面后重试'); } catch (_) {}
      try { _unlockUI(); } catch (_) {}
    }
  }

  /**
   * 从 composer/entrypoint widgetStates 里抽取源商品的「富内容」(Ozon Rich Content,
   * attribute 11254)文档。两种常见形状:① 某 widget state 的 richAnnotationJson 字段是
   * 整份 {content,version} JSON 字符串;② state 顶层直接就是 {content:[...widget...],version}。
   * 用 content[].widgetName 作判别,避免误命中普通 list/gallery widget。返回 JSON 字符串或 ''。
   */
  function jzExtractRichContentFromStates(states) {
    if (!states || typeof states !== 'object') return '';
    const candidates = [];
    const seenJson = new Set();
    const seenObjects = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    const addCandidate = (doc, rawJson) => {
      if (!jzIsRichContentDoc(doc)) return;
      const json = typeof rawJson === 'string' && rawJson.trim()
        ? rawJson.trim()
        : JSON.stringify({ content: doc.content, version: doc.version || 0.3 });
      if (seenJson.has(json)) return;
      seenJson.add(json);
      const stats = jzCollectRichContentStats(doc);
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
      const parsed = jzParseMaybeJson(node);
      if (!parsed || typeof parsed !== 'object') return;
      if (seenObjects) {
        if (seenObjects.has(parsed)) return;
        seenObjects.add(parsed);
      }
      if (typeof parsed.richAnnotationJson === 'string' && parsed.richAnnotationJson.trim()) {
        addCandidate(jzParseMaybeJson(parsed.richAnnotationJson), parsed.richAnnotationJson);
      }
      if (jzIsRichContentDoc(parsed)) addCandidate(parsed, null);
      if (Array.isArray(parsed)) {
        for (const item of parsed) walk(item, depth + 1);
        return;
      }
      for (const key of Object.keys(parsed)) walk(parsed[key], depth + 1);
    };
    walk(states, 0);
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.json || '';
  }

  function jzParseMaybeJson(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
    try { return JSON.parse(trimmed); } catch { return value; }
  }

  function jzIsRichContentDoc(doc) {
    return Boolean(
      doc &&
      typeof doc === 'object' &&
      !Array.isArray(doc) &&
      Array.isArray(doc.content) &&
      doc.content.length > 0 &&
      doc.content.some((block) => block && typeof block === 'object' && typeof block.widgetName === 'string' && block.widgetName.trim()),
    );
  }

  function jzCollectRichContentStats(doc) {
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
  }

  function jzRichContentHasText(raw) {
    const doc = jzParseMaybeJson(raw);
    return jzIsRichContentDoc(doc) && jzCollectRichContentStats(doc).hasRealText;
  }

  function jzNormalizeOzonProductInnerPath(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw, 'https://www.ozon.ru');
      return (url.pathname || '') + (url.search || '');
    } catch {
      const noHash = raw.split('#')[0];
      return noHash.startsWith('/') ? noHash : '/' + noHash;
    }
  }

  function jzOzonProductPathKey(value) {
    const normalized = jzNormalizeOzonProductInnerPath(value);
    return normalized.split('?')[0].replace(/\/+$/, '');
  }

  function jzOzonProductId(value) {
    const pathKey = jzOzonProductPathKey(value);
    const match = pathKey.match(/\/product\/(?:[^/?#]*-)?(\d+)$/i);
    return match ? match[1] : '';
  }

  function jzCollectOzonRichContentPagePaths(states, currentPath) {
    const out = [];
    const seenPaths = new Set();
    const seenObjects = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    const currentProductKey = jzOzonProductPathKey(currentPath);
    const currentProductId = jzOzonProductId(currentPath);
    const push = (candidate) => {
      const pagePath = jzNormalizeOzonProductInnerPath(candidate);
      if (!pagePath || !/[?&]layout_container=pdpPage2column(?:&|$)/.test(pagePath)) return;
      const productKey = jzOzonProductPathKey(pagePath);
      const productId = jzOzonProductId(pagePath);
      if (currentProductId && productId && currentProductId !== productId) return;
      if ((!currentProductId || !productId) && currentProductKey && productKey && productKey !== currentProductKey) return;
      if (seenPaths.has(pagePath)) return;
      seenPaths.add(pagePath);
      out.push(pagePath);
    };
    const walk = (node, depth) => {
      if (node == null || depth > 18) return;
      const parsed = jzParseMaybeJson(node);
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
  }

  /**
   * 采集用:抽当前 PDP 的源富内容(11254)。优先 ensurePdpState 的 composer 缓存
   * (页面加载即预热,采集时通常零额外请求;SW 白名单含 webDescription —— 富内容的
   * richAnnotationJson 就住在那个 state 里);缓存 miss/不含富内容时,同源再拉一次
   * 当前页完整 widgetStates 兜底(fetchVariantGallery 同款端点)。
   * 失败一律返回 ''(富内容是增强项,绝不阻塞采集主流程)。
   */
  async function jzCollectPageRichContent() {
    try {
      let rc = '';
      if (window.ensurePdpState) {
        const states = await window.ensurePdpState().catch(() => null);
        if (states) rc = jzExtractRichContentFromStates(states);
      }
      if (!rc || !jzRichContentHasText(rc)) {
        const r = await fetchVariantGallery(window.location.pathname + window.location.search);
        const fetched = r?.richContent || '';
        if (fetched && (!rc || !jzRichContentHasText(rc) || jzRichContentHasText(fetched))) rc = fetched;
      }
      return rc;
    } catch {
      return '';
    }
  }

  /**
   * 把源富内容注入 sv-like 对象的 attributes(key '11254')。幂等(已有 11254 不重复);
   * 不原地 push —— 展开新数组,避免污染共享的源 attributes 引用(母体 variantData 是
   * anchorSv 的浅拷贝)。sv 为空且 rc 非空时新建 {attributes:[…]},让 searchVariants
   * 失败的单采也能带富内容。rc 为空时原样返回(undefined 仍是 undefined)。
   *
   * 下游消费:采集箱编辑页 collect-adapter 读 attributes 的 11254 预填 richContent
   * textarea;批量导入后端 collect-box.service 把 variantData 当 _sourceVariant 传,
   * importProducts 的 pickSourceRichContent 统一下发。
   */
  function jzInjectRichContentAttr(sv, richContent) {
    if (!richContent) return sv || undefined;
    const base = sv && typeof sv === 'object' ? sv : {};
    const attrs = Array.isArray(base.attributes) ? base.attributes : [];
    if (attrs.some((a) => String(a?.key) === '11254')) return base;
    base.attributes = [...attrs, { key: '11254', value: richContent }];
    return base;
  }

  /**
   * Fetch a variant's product page state via Ozon entrypoint-api,
   * extract its FULL gallery (same data the page DOM would render).
   * Returns { images: string[], richContent: string } —— richContent 为源富内容 11254 JSON 或 ''。
   */
  async function fetchVariantGallery(variantLink) {
    if (!variantLink) return { images: [], richContent: '' };
    let path = variantLink;
    try {
      if (/^https?:\/\//i.test(path)) {
        const u = new URL(path);
        path = u.pathname + u.search;
      }
    } catch {}
    if (!path.startsWith('/')) path = '/' + path;
    // 相对路径让 ozon.ru / ozon.kz 都同 origin 命中自家 entrypoint API。
    const endpoints = [
      `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
      `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
    ];
    const endpointQueue = endpoints.slice();
    const seenEndpoints = new Set(endpointQueue);
    const enqueuePath = (innerPath) => {
      const normalized = jzNormalizeOzonProductInnerPath(innerPath);
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
    const upgrade = (u) =>
      typeof u === 'string' && u.includes('ir.ozone.ru')
        ? u.replace(/\/wc\d+\//, '/wc1000/')
        : u;
    const norm = (u) => String(u || '').split('?')[0].split('#')[0].toLowerCase();

    let richContent = '';
    let richContentHasText = false;
    let bestGallery = [];
    for (let i = 0; i < endpointQueue.length; i += 1) {
      const url = endpointQueue[i];
      try {
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { 'x-o3-app-name': 'dweb_client', 'accept': 'application/json' },
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const states = data?.widgetStates || {};
        // 顺手从同一份 widgetStates 抽源富内容(零额外 fetch / 反爬开销)。
        for (const nextPage of jzCollectOzonRichContentPagePaths(states, path)) enqueuePath(nextPage);
        const candidateRichContent = jzExtractRichContentFromStates(states);
        if (candidateRichContent) {
          const candidateHasText = jzRichContentHasText(candidateRichContent);
          if (!richContent || (!richContentHasText && candidateHasText)) {
            richContent = candidateRichContent;
            richContentHasText = candidateHasText;
          }
        }
        // 扫所有 widgetStates → 选 images 数组最长的一个作为图册主源
        // (绝大多数情况下命中 webGallery,但偶有变体走其它命名,扫全确保兜底)
        let bestImages = [];
        let bestCover = null;
        for (const k of Object.keys(states)) {
          let v = states[k];
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch { continue; } }
          if (!v || typeof v !== 'object') continue;
          if (!Array.isArray(v.images)) continue;
          if (v.images.length > bestImages.length) {
            bestImages = v.images;
            bestCover = v.coverImage || null;
          }
        }
        if (bestImages.length > 0) {
          const seen = new Set();
          const out = [];
          const push = (raw) => {
            const upgraded = upgrade(raw);
            if (!upgraded) return;
            const n = norm(upgraded);
            if (seen.has(n)) return;
            seen.add(n);
            out.push(upgraded);
          };
          if (bestCover) push(bestCover);
          for (const img of bestImages) {
            const u = typeof img === 'string' ? img : (img?.src || img?.url || img?.image);
            if (u) push(u);
          }
          if (out.length > 0) {
            if (bestGallery.length === 0) bestGallery = out;
            if (richContent && (richContentHasText || i + 1 >= endpointQueue.length)) return { images: out, richContent };
          }
        } else {
          console.warn('[fetchVariantGallery] No images in widgetStates', path, 'totalKeys=', Object.keys(states).length);
        }
      } catch (e) {
        console.warn('[fetchVariantGallery] fetch failed', url, e?.message);
      }
    }
    return { images: bestGallery, richContent };
  }

  /**
   * Same as prefetchSourceVariant but returns the FULL items array on success.
   * search-variant-model usually returns the whole variant model (all sibling variants),
   * so we want to expose all of them to populate sourceMap in one call.
   * Return: false (gate failed, error shown) | { items: [...] }
   */
  async function prefetchSourceVariantWithItems(sku, statusDiv, showStatusFn) {
    const attempt = async () => {
      try {
        const resp = await window.sendMessage('searchVariants', { sku });
        const items = resp?.items || resp?.data?.items || [];
        return { items, error: null };
      } catch (e) {
        const msg = e.message || '';
        let errorCode = 'UNKNOWN_ERROR';
        if (msg.includes('打开') || msg === 'NO_SELLER_TAB') errorCode = 'NO_SELLER_TAB';
        else if (msg.includes('过期') || msg.includes('登录') || msg === 'AUTH_REQUIRED') errorCode = 'AUTH_REQUIRED';
        else if (msg === 'ANTIBOT_BLOCKED') errorCode = 'ANTIBOT_BLOCKED';
        else if (msg.includes('403')) {
          // 与 SW classifyError 同口径细分 403:HTML 挑战页 = 真反爬;结构化 JSON 权限/会话错
          // (company_id 失效等)= AUTH_REQUIRED(引导重登/重选店,不当反爬冷却)。裸 403 仍按反爬。
          const blob = msg.toLowerCase();
          const looksHtmlChallenge = /<html|<!doctype|just a moment|attention required|captcha|challenge|вы не робот|too many requests/.test(blob);
          const looksStructuredApiError = /"code"|"message"|permission_?denied|company_?id|sc_company|unauthenticated|session/.test(blob);
          errorCode = (looksStructuredApiError && !looksHtmlChallenge) ? 'AUTH_REQUIRED' : 'ANTIBOT_BLOCKED';
        }
        else if (msg.includes('超时') || msg.includes('timeout')) errorCode = 'TIMEOUT';
        return { items: [], error: errorCode, message: msg };
      }
    };

    showStatusFn(statusDiv, 'loading', '正在查询商品变体信息...');
    let result = await attempt();

    if (result.items.length === 0 && result.error) {
      const isRetryable = ['AUTH_REQUIRED', 'ANTIBOT_BLOCKED', 'NO_SELLER_TAB'].includes(result.error);
      if (isRetryable) {
        showStatusFn(statusDiv, 'loading', '正在刷新卖家中心登录状态...');
        try {
          await window.sendMessage('syncSellerCookies');
          showStatusFn(statusDiv, 'loading', '正在重新查询商品变体信息...');
          result = await attempt();
        } catch (syncErr) {
          console.warn('[prefetch] Cookie sync failed:', syncErr.message);
        }
      }
      if (result.items.length === 0 && result.error) {
        const hints = {
          NO_SELLER_TAB: '请先打开 seller.ozon.ru 并登录,然后重试',
          PERMISSION_DENIED: '浏览器未授予插件访问 seller.ozon.ru 的权限。请在扩展管理页面点击本插件的"详细信息",将"网站访问权限"设为"在所有网站上",然后刷新页面重试',
          AUTH_REQUIRED: '卖家中心登录已过期,请重新登录 seller.ozon.ru 后重试',
          ANTIBOT_BLOCKED: '卖家中心触发反爬验证,请在 seller.ozon.ru 页面刷新后重试',
          TIMEOUT: '卖家中心请求超时,请检查网络或刷新 seller.ozon.ru 页面',
          NETWORK_ERROR: '网络错误,请检查网络连接后重试',
          UNKNOWN_ERROR: `变体查询失败: ${result.message || '未知错误'}`,
        };
        showStatusFn(statusDiv, 'error', hints[result.error] || `变体查询失败: ${result.message || result.error}`);
        return false;
      }
    }

    // sv 没命中（陌生 SKU 或非自家商品）→ 降级 /api/v1/search 全平台跟卖列表 API
    // 它能按 SKU 精确定位 Ozon 全平台任意商品，返回精准 description_category_id + attributes
    if (result.items.length === 0) {
      try {
        showStatusFn(statusDiv, 'loading', '正在全平台查询该 SKU...');
        const searchResp = await window.sendMessage('searchProductBySku', { sku });
        const globalItems = searchResp?.items || searchResp?.data?.items || [];
        if (globalItems.length > 0) {
          console.log(`[prefetch] /search global found ${globalItems.length} items for sku=${sku}`);
          window.sendMessage('syncSellerCookies').catch(() => {});
          return { items: globalItems };
        }
      } catch (e) {
        console.warn(`[prefetch] /search fallback failed for sku=${sku}:`, e?.message || e);
      }
    }

    // 即使 items 为空也算"已通过 gate"(网络层无错),返回空 items 让上层走 fallback
    if (result.items.length > 0) {
      window.sendMessage('syncSellerCookies').catch(() => {});
    }
    return { items: result.items };
  }

  /**
   * Pre-fetch _sourceVariant from Seller Portal with auto-retry on auth failure.
   * On success, auto-syncs cookies to backend for backup.
   * Returns the matched variant object or undefined.
   */
  async function prefetchSourceVariant(sku, statusDiv, showStatusFn) {
    // window.sendMessage rejects on {ok:false}, so normalize to {items, error}
    const attempt = async () => {
      try {
        const resp = await window.sendMessage('searchVariants', { sku });
        const items = resp?.items || resp?.data?.items || [];
        return { items, error: null };
      } catch (e) {
        const msg = e.message || '';
        let errorCode = 'UNKNOWN_ERROR';
        if (msg.includes('打开') || msg === 'NO_SELLER_TAB') errorCode = 'NO_SELLER_TAB';
        else if (msg.includes('过期') || msg.includes('登录') || msg === 'AUTH_REQUIRED') errorCode = 'AUTH_REQUIRED';
        else if (msg === 'ANTIBOT_BLOCKED') errorCode = 'ANTIBOT_BLOCKED';
        else if (msg.includes('403')) {
          // 与 SW classifyError 同口径细分 403:HTML 挑战页 = 真反爬;结构化 JSON 权限/会话错
          // (company_id 失效等)= AUTH_REQUIRED(引导重登/重选店,不当反爬冷却)。裸 403 仍按反爬。
          const blob = msg.toLowerCase();
          const looksHtmlChallenge = /<html|<!doctype|just a moment|attention required|captcha|challenge|вы не робот|too many requests/.test(blob);
          const looksStructuredApiError = /"code"|"message"|permission_?denied|company_?id|sc_company|unauthenticated|session/.test(blob);
          errorCode = (looksStructuredApiError && !looksHtmlChallenge) ? 'AUTH_REQUIRED' : 'ANTIBOT_BLOCKED';
        }
        else if (msg.includes('超时') || msg.includes('timeout')) errorCode = 'TIMEOUT';
        return { items: [], error: errorCode, message: msg };
      }
    };

    showStatusFn(statusDiv, 'loading', '正在查询商品变体信息...');
    let result = await attempt();

    // On auth/antibot failure: auto-sync cookies and retry once
    if (result.items.length === 0 && result.error) {
      const isRetryable = ['AUTH_REQUIRED', 'ANTIBOT_BLOCKED', 'NO_SELLER_TAB'].includes(result.error);
      if (isRetryable) {
        showStatusFn(statusDiv, 'loading', '正在刷新卖家中心登录状态...');
        try {
          await window.sendMessage('syncSellerCookies');
          console.log('[prefetch] Cookie sync succeeded, retrying searchVariants');
          showStatusFn(statusDiv, 'loading', '正在重新查询商品变体信息...');
          result = await attempt();
        } catch (syncErr) {
          console.warn('[prefetch] Cookie sync failed:', syncErr.message);
        }
      }

      // Still failed — show actionable error
      if (result.items.length === 0 && result.error) {
        const hints = {
          NO_SELLER_TAB: '请先打开 seller.ozon.ru 并登录，然后重试',
          PERMISSION_DENIED: '浏览器未授予插件访问 seller.ozon.ru 的权限。请在扩展管理页面点击本插件的"详细信息"，将"网站访问权限"设为"在所有网站上"，然后刷新页面重试',
          AUTH_REQUIRED: '卖家中心登录已过期，请重新登录 seller.ozon.ru 后重试',
          ANTIBOT_BLOCKED: '卖家中心触发反爬验证，请在 seller.ozon.ru 页面刷新后重试',
          TIMEOUT: '卖家中心请求超时，请检查网络或刷新 seller.ozon.ru 页面',
          NETWORK_ERROR: '网络错误，请检查网络连接后重试',
          UNKNOWN_ERROR: `变体查询失败: ${result.message || '未知错误，请打开浏览器控制台查看详情'}`,
        };
        showStatusFn(statusDiv, 'error', hints[result.error] || `变体查询失败: ${result.message || result.error}`);
        return false;
      }
    }

    if (result.items.length > 0) {
      // Auto-sync cookies to backend (fire-and-forget)
      window.sendMessage('syncSellerCookies').catch(() => {});
      const exact = result.items.find(it => String(it.variant_id) === sku);
      return exact || result.items[0];
    }

    // Seller Portal accessible but no matching variant — return undefined (not false)
    // so caller knows it can proceed with category fallback
    console.log(`[prefetch] No variant found for SKU ${sku}, will use category fallback`);
    return undefined;
  }

  /**
   * Poll Ozon import task status until completion or timeout.
   * Returns 'success' if all items imported, otherwise shows error and returns 'error'.
   */
  async function pollImportTaskStatus(taskId, statusDiv, showStatusFn, maxAttempts = 10, intervalMs = 3000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise(r => setTimeout(r, intervalMs));
      try {
        const statusRes = await window.sendMessage('getImportStatus', { taskId: String(taskId) });
        const result = statusRes?.result;
        if (!result) continue;

        // Ozon returns result.items array with statuses per item
        const items = result.items || [];
        if (items.length === 0) {
          // Task not processed yet
          showStatusFn(statusDiv, 'loading', `等待Ozon处理中... (${attempt}/${maxAttempts})`);
          continue;
        }

        // Check statuses: "imported", "failed", "pending"
        const failed = items.filter(it => it.status === 'failed');
        const pending = items.filter(it => it.status === 'pending');
        const imported = items.filter(it => it.status === 'imported');

        if (pending.length > 0 && attempt < maxAttempts) {
          showStatusFn(statusDiv, 'loading',
            `Ozon处理中: ${imported.length} 成功, ${pending.length} 待处理... (${attempt}/${maxAttempts})`);
          continue;
        }

        if (failed.length > 0) {
          // Show detailed error from Ozon with code + message
          const errors = failed.map(it => {
            const errs = (it.errors || [])
              .map(e => e.code ? `[${e.code}] ${e.message || e.code}` : (e.message || JSON.stringify(e)))
              .join('\n  ');
            return `• ${it.offer_id}:\n  ${errs || '未知错误'}`;
          });
          showStatusFn(statusDiv, 'error',
            `上架失败 (${failed.length}/${items.length}):\n${errors.join('\n')}`);
          console.error('[ImportStatus] Failed items:', JSON.stringify(failed, null, 2));
          return { status: 'error', warnings: [] };
        }

        // Check imported items for errors (Ozon may return status="imported" with validation errors)
        // Non-fatal error codes: product is imported but needs seller action (e.g. brand certification)
        const NON_FATAL_CODES = new Set(['BR_wrong_name', 'BR_missing_docs']);
        const importedWithErrors = imported.filter(it =>
          it.errors && it.errors.some(e => e.level === 'error' && !NON_FATAL_CODES.has(e.code))
        );

        // Show non-fatal warnings separately
        const importedWithWarnings = imported.filter(it =>
          it.errors && it.errors.some(e => e.level === 'error' && NON_FATAL_CODES.has(e.code))
        );
        if (importedWithWarnings.length > 0) {
          const warns = importedWithWarnings.flatMap(it =>
            (it.errors || []).filter(e => NON_FATAL_CODES.has(e.code)).map(e => `[${e.code}] ${e.message || e.code}`)
          );
          console.warn('[ImportStatus] Non-fatal warnings:', warns.join('; '));
        }

        if (importedWithErrors.length > 0) {
          const errors = importedWithErrors.map(it => {
            const errs = (it.errors || [])
              .filter(e => e.level === 'error' && !NON_FATAL_CODES.has(e.code))
              .map(e => e.code ? `[${e.code}] ${e.message || e.code}` : (e.message || JSON.stringify(e)))
              .join('\n  ');
            return `• ${it.offer_id}:\n  ${errs || '未知错误'}`;
          });
          showStatusFn(statusDiv, 'error',
            `上架验证失败 (${importedWithErrors.length}/${items.length}):\n${errors.join('\n')}`);
          console.error('[ImportStatus] Imported items with errors:', JSON.stringify(importedWithErrors, null, 2));
          return { status: 'error', warnings: [] };
        }

        if (imported.length === items.length) {
          const warnings = importedWithWarnings.flatMap(it =>
            (it.errors || []).filter(e => NON_FATAL_CODES.has(e.code)).map(e => e.message || e.code)
          );
          if (warnings.length > 0) {
            return { status: 'success', warnings };
          }
          return { status: 'success', warnings: [] };
        }

        // Timeout with pending items
        if (attempt >= maxAttempts && pending.length > 0) {
          showStatusFn(statusDiv, 'loading',
            `任务仍在处理中 (Task: ${taskId})，请稍后在商品列表中查看结果`);
          return { status: 'pending', warnings: [] };
        }
      } catch (err) {
        console.warn(`[ImportStatus] Poll attempt ${attempt} failed:`, err.message);
      }
    }
    showStatusFn(statusDiv, 'loading',
      `任务提交成功 (Task: ${taskId})，Ozon正在处理中，请稍后查看商品列表`);
    return { status: 'timeout', warnings: [] };
  }


  // 卖家初始化字符(头像 fallback)
  function _sellerInitial(name) {
    if (!name) return "?";
    const trimmed = String(name).trim();
    if (!trimmed) return "?";
    return trimmed.slice(0, 1).toUpperCase();
  }

  // hash → HSL 色相,稳定但分布均匀(同名卖家颜色一致)
  function _sellerColor(name) {
    let h = 0;
    const s = String(name || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 60%, 55%)`;
  }

  function _formatSellerReviews(n) {
    const num = Number(n);
    if (!Number.isFinite(num) || num <= 0) return '';
    return `${window.formatNumber ? window.formatNumber(num) : num}\u6761\u8bc4\u8bba`;
  }

  function _sellerDeliveryRank(seller) {
    const rank = Number(seller?.deliveryRank);
    return Number.isFinite(rank) ? rank : null;
  }

  function _sortSellersForMode(sellers, mode) {
    const withIndex = sellers.map((seller, index) => ({ seller, index }));
    const sorted = withIndex.sort((a, b) => {
      if (mode === 'delivery') {
        const ar = _sellerDeliveryRank(a.seller);
        const br = _sellerDeliveryRank(b.seller);
        if (ar != null || br != null) {
          if (ar == null) return 1;
          if (br == null) return -1;
          if (ar !== br) return ar - br;
        }
      }
      const ap = _parsePriceNum(a.seller.price);
      const bp = _parsePriceNum(b.seller.price);
      if (ap != null || bp != null) {
        if (ap == null) return 1;
        if (bp == null) return -1;
        if (ap !== bp) return ap - bp;
      }
      return a.index - b.index;
    });
    return sorted.map((item) => item.seller);
  }

  function _sellerListStats(sellers) {
    let minPrice = Infinity;
    let fastestRank = Infinity;
    sellers.forEach((seller) => {
      const price = _parsePriceNum(seller.price);
      if (price != null && price < minPrice) minPrice = price;
      const rank = _sellerDeliveryRank(seller);
      if (rank != null && rank < fastestRank) fastestRank = rank;
    });
    return {
      minPrice: minPrice === Infinity ? null : minPrice,
      fastestRank: fastestRank === Infinity ? null : fastestRank,
    };
  }

  function _renderSellerRow(seller, flags = {}) {
    const sellerUrl = seller.link
      ? (seller.link.startsWith('http') ? seller.link : 'https://www.ozon.ru' + seller.link)
      : '';
    const avatarHtml = seller.avatar
      ? `<img class="oh-seller-avatar" src="${_escHtml(seller.avatar)}" alt="" loading="lazy" />`
      : `<span class="oh-seller-avatar oh-seller-avatar-fallback" style="background:${_sellerColor(seller.name)}">${_escHtml(_sellerInitial(seller.name))}</span>`;
    const nameHtml = sellerUrl
      ? `<a class="oh-seller-name oh-seller-link" href="${_escHtml(sellerUrl)}" target="_blank" rel="noopener">${_escHtml(seller.name || '未知卖家')}</a>`
      : `<span class="oh-seller-name">${_escHtml(seller.name || '未知卖家')}</span>`;
    const ratingHtml = typeof seller.rating === "number"
      ? `<span class="oh-seller-rating">★ ${seller.rating.toFixed(1)}</span>`
      : '';
    const reviewsText = _formatSellerReviews(seller.reviewsCount);
    const reviewsHtml = reviewsText
      ? `<span class="oh-seller-reviews">${_escHtml(reviewsText)}</span>`
      : '';
    const regionHtml = seller.region
      ? `<span class="oh-seller-region">${_escHtml(seller.region)}</span>`
      : '';
    const skuHtml = seller.sku
      ? `<span class="oh-seller-sku">SKU ${_escHtml(seller.sku)}</span>`
      : '';
    const priceHtml = seller.price
      ? `<span class="oh-seller-price${flags.isMinPrice ? ' is-min' : ''}">${_escHtml(seller.price)}${flags.isMinPrice ? ' <span class="oh-seller-tag is-price">\u6700\u4f4e</span>' : ''}</span>`
      : `<span class="oh-seller-price oh-seller-price-empty">—</span>`;
    const deliveryHtml = seller.deliveryText
      ? `<span class="oh-seller-delivery-main">${_escHtml(seller.deliveryText)}</span>`
      : `<span class="oh-seller-delivery-main is-muted">\u914d\u9001\u4fe1\u606f\u672a\u8fd4\u56de</span>`;
    const fastestTag = flags.isFastest
      ? `<span class="oh-seller-tag is-delivery">\u6700\u5feb</span>`
      : '';
    return `
      <div class="oh-seller-row${flags.isMinPrice ? ' is-min' : ''}${flags.isFastest ? ' is-fastest' : ''}">
        <div class="oh-seller-cell oh-seller-avatar-cell">${avatarHtml}</div>
        <div class="oh-seller-cell oh-seller-name-cell">
          ${nameHtml}
          <div class="oh-seller-meta">${ratingHtml}${reviewsHtml}${regionHtml}${skuHtml}</div>
        </div>
        <div class="oh-seller-cell oh-seller-price-cell">${priceHtml}</div>
        <div class="oh-seller-cell oh-seller-delivery-cell">
          <span class="oh-seller-delivery-icon">${_lucideSvg('truck')}</span>
          <span class="oh-seller-delivery-text">${deliveryHtml}${fastestTag}</span>
        </div>
      </div>
    `;
  }

  function _renderSellerListByMode(sellers, mode, totalCount) {
    const stats = _sellerListStats(sellers);
    const sorted = _sortSellersForMode(sellers, mode);
    return `
      <div class="oh-seller-list">
        ${sorted.map((seller) => {
          const price = _parsePriceNum(seller.price);
          const rank = _sellerDeliveryRank(seller);
          return _renderSellerRow(seller, {
            isMinPrice: stats.minPrice != null && price != null && price === stats.minPrice,
            isFastest: stats.fastestRank != null && rank != null && rank === stats.fastestRank,
          });
        }).join('')}
      </div>
      ${sellers.length < totalCount
        ? `<div class="oh-modal-partial">已显示 ${sellers.length} / ${totalCount},完整列表点击下方按钮查看</div>`
        : ''}
    `;
  }

  function _renderSkeletonRows(n) {
    let html = '';
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

  // 解析价格字符串为数字,用于「最低价」标记。Ozon 价格典型形式 "₽ 1 234,56" / "1234.56".
  function _parsePriceNum(priceStr) {
    if (!priceStr) return null;
    const m = String(priceStr).replace(/[^\d.,-]/g, "").replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(m);
    return Number.isFinite(n) ? n : null;
  }

  async function createFollowSellListModal(anchor, product) {
    document.querySelector('.ozon-helper-follow-modal')?.remove();

    const totalCount = product.followSellCount || 0;
    const sku = product.sku || product.productId || "";
    const ozonModalUrl = sku ? `https://www.ozon.ru/product/${sku}/?prefer_sellers=true` : null;
    let activeSellerMode = 'price';
    let loadedSellers = [];
    let loadedTotalCount = totalCount;

    const modal = document.createElement('div');
    modal.className = 'ozon-helper-follow-modal';
    modal.innerHTML = `
      <div class="oh-modal-header">
        <div class="oh-modal-title">
          <span class="oh-modal-title-text">跟卖商家列表</span>
          <span class="oh-modal-title-count">${totalCount}</span>
        </div>
        <button class="oh-modal-close" type="button" aria-label="关闭">&times;</button>
      </div>
      <div class="oh-modal-tabs" role="tablist" aria-label="跟卖商家分类">
        <button class="oh-modal-tab" type="button" data-seller-mode="delivery" role="tab" aria-selected="false">
          <span class="oh-modal-tab-label">更快配送</span>
        </button>
        <button class="oh-modal-tab is-active" type="button" data-seller-mode="price" role="tab" aria-selected="true">
          <span class="oh-modal-tab-label">较低价格</span>
        </button>
      </div>
      <div class="oh-modal-body" data-state="loading">
        <div class="oh-seller-list">${_renderSkeletonRows(5)}</div>
      </div>
      <div class="oh-modal-footer">
        ${ozonModalUrl
          ? `<a class="oh-modal-cta" href="${_escHtml(ozonModalUrl)}" target="_blank" rel="noopener">在 Ozon 查看完整列表 →</a>`
          : ''}
      </div>
    `;

    const rect = anchor.getBoundingClientRect();
    modal.style.position = 'fixed';
    const modalWidth = Math.min(720, window.innerWidth - 24);
    let left = rect.left + rect.width / 2 - modalWidth / 2;
    if (left < 10) left = 10;
    if (left + modalWidth > window.innerWidth - 10) left = window.innerWidth - modalWidth - 10;
    let top = rect.bottom + 8;
    const modalHeight = Math.min(620, window.innerHeight - 20);
    if (top + modalHeight > window.innerHeight) top = Math.max(10, rect.top - modalHeight - 8);
    modal.style.top = `${top}px`;
    modal.style.left = `${left}px`;
    document.body.appendChild(modal);

    let _offHandler = null;
    const closeModal = () => {
      if (_offHandler) document.removeEventListener('click', _offHandler);
      modal.remove();
    };
    modal.querySelector('.oh-modal-close').addEventListener('click', closeModal);

    const updateTabs = () => {
      modal.querySelectorAll('[data-seller-mode]').forEach((btn) => {
        const active = btn.dataset.sellerMode === activeSellerMode;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    };
    const renderLoadedSellers = () => {
      const body = modal.querySelector('.oh-modal-body');
      if (!body || loadedSellers.length === 0) return;
      body.dataset.state = 'ready';
      body.innerHTML = _renderSellerListByMode(loadedSellers, activeSellerMode, loadedTotalCount);
    };
    modal.addEventListener('click', (e) => {
      const modeBtn = e.target?.closest?.('[data-seller-mode]');
      if (!modeBtn || !modal.contains(modeBtn)) return;
      activeSellerMode = modeBtn.dataset.sellerMode || 'price';
      updateTabs();
      renderLoadedSellers();
    });

    setTimeout(() => {
      _offHandler = (e) => {
        if (!modal.contains(e.target) && e.target !== anchor) {
          closeModal();
        }
      };
      document.addEventListener('click', _offHandler);
    }, 0);

    // 异步拉真实 sellers — shared-utils 已 4h cache,大部分时候命中即返
    if (!sku || !window.jzFetchPublicFollowSell) {
      _renderModalEmpty(modal, totalCount, ozonModalUrl);
      return;
    }
    let result = null;
    try {
      result = await window.jzFetchPublicFollowSell(sku);
    } catch (e) {
      console.warn('[follow-sell modal] fetch failed', e);
    }
    // modal 可能在 await 期间被关闭
    if (!modal.isConnected) return;

    const sellers = (result && Array.isArray(result.sellers)) ? result.sellers : [];
    loadedTotalCount = Math.max(totalCount, Number(result?.count) || 0, sellers.length);
    const countEl = modal.querySelector('.oh-modal-title-count');
    if (countEl) countEl.textContent = String(loadedTotalCount);
    if (sellers.length === 0) {
      _renderModalEmpty(modal, loadedTotalCount, ozonModalUrl);
      return;
    }
    loadedSellers = sellers;
    updateTabs();
    renderLoadedSellers();
  }

  function _renderModalEmpty(modal, totalCount, ozonModalUrl) {
    const body = modal.querySelector('.oh-modal-body');
    if (!body) return;
    body.dataset.state = 'empty';
    body.innerHTML = `
      <div class="oh-modal-empty-state">
        <div class="oh-modal-empty-icon">${_lucideSvg('users')}</div>
        <div class="oh-modal-empty-title">${totalCount > 0 ? `${totalCount} 个跟卖商家` : '暂无跟卖商家'}</div>
        <div class="oh-modal-empty-hint">${totalCount > 0 ? '完整卖家列表(含价格、配送、评分)请在 Ozon 查看' : '该商品当前没有其他商家跟卖'}</div>
        ${ozonModalUrl && totalCount > 0
          ? `<a class="oh-modal-empty-btn" href="${_escHtml(ozonModalUrl)}" target="_blank" rel="noopener">在 Ozon 查看 →</a>`
          : ''}
      </div>
    `;
  }

  /**
   * 中央 loading 弹窗 — 给跟卖面板的双 phase 流水线(展开变体 + 拉源属性)显示进度。
   * 旧 UI 把进度挤在浮动 btn 文案里(`展开变体 X/N · 源属性 Y/M`),用户基本看不到。
   * 改成 360px 居中卡片 + 双进度条:展开变体(蓝)、拉源属性(绿)。
   *
   * 返回 `{ dialog, update(aT,aD,bT,bD), close() }`。total=0 的 phase 自动隐藏。
   * spinner 动画样式按需注入一次(`#ozon-helper-spinner-style` 标识)。
   */
  function createPipelineLoadingDialog() {
    // 一次性注入 spinner @keyframes(后续 toggle 复用)
    if (!document.querySelector('#ozon-helper-spinner-style')) {
      const style = document.createElement('style');
      style.id = 'ozon-helper-spinner-style';
      style.textContent = `@keyframes ozon-helper-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
      document.head.appendChild(style);
    }
    const dialog = document.createElement('div');
    dialog.className = 'ozon-helper-pipeline-loading';
    dialog.style.cssText = [
      'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
      'z-index:2147483646', 'width:360px', 'background:#fff',
      'border-radius:12px', 'box-shadow:0 10px 40px rgba(0,0,0,0.2)',
      'padding:20px 24px', 'font-family:inherit',
    ].join(';');
    dialog.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <div style="width:28px;height:28px;border:3px solid #e5e7eb;border-top-color:#3b82f6;border-radius:50%;animation:ozon-helper-spin 0.9s linear infinite;flex-shrink:0;"></div>
        <div style="font-size:15px;font-weight:600;color:#0f172a;">正在准备跟卖面板</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div data-progress="phaseA" style="display:none;">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;color:#475569;margin-bottom:4px;">
            <span>展开变体</span><span data-text="phaseA">0/0</span>
          </div>
          <div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;">
            <div data-bar="phaseA" style="height:100%;width:0%;background:#3b82f6;transition:width 0.3s;"></div>
          </div>
        </div>
        <div data-progress="phaseB" style="display:none;">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;color:#475569;margin-bottom:4px;">
            <span>拉取源属性</span><span data-text="phaseB">0/0</span>
          </div>
          <div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;">
            <div data-bar="phaseB" style="height:100%;width:0%;background:#10b981;transition:width 0.3s;"></div>
          </div>
        </div>
      </div>
      <div style="margin-top:14px;font-size:11.5px;color:#94a3b8;text-align:center;">完成后将自动打开跟卖面板</div>
    `;
    document.body.appendChild(dialog);

    const update = (aT, aD, bT, bD) => {
      const aEl = dialog.querySelector('[data-progress="phaseA"]');
      const bEl = dialog.querySelector('[data-progress="phaseB"]');
      if (aT > 0) {
        aEl.style.display = 'block';
        dialog.querySelector('[data-text="phaseA"]').textContent = `${aD}/${aT}`;
        dialog.querySelector('[data-bar="phaseA"]').style.width = `${Math.min(100, (aD / aT) * 100).toFixed(0)}%`;
      }
      if (bT > 0) {
        bEl.style.display = 'block';
        dialog.querySelector('[data-text="phaseB"]').textContent = `${bD}/${bT}`;
        dialog.querySelector('[data-bar="phaseB"]').style.width = `${Math.min(100, (bD / bT) * 100).toFixed(0)}%`;
      }
    };

    const close = () => {
      try { dialog.remove(); } catch {}
    };

    return { dialog, update, close };
  }

  async function toggleFollowSellPanel(btn) {
    // Toggle off: any open follow-sell panel (single or multi)
    const existingPanel = document.querySelector('.ozon-helper-followsell-panel.is-open');
    if (existingPanel) {
      closePanel(existingPanel);
      return;
    }

    // 等 composer-api 缓存就绪(shared-utils 已经在 page load 时预热,这里
    // 兜底 await — 用户秒点时如果还没回也会阻塞最多 1 个 fetch round trip)。
    // 之后所有 sync extractStateData / extractProductData / extractAspectVariants
    // 都走 cache fallback,Ozon 2026 SSR DOM 剥离也能正常采集。
    const originalBtnHtml = btn ? btn.innerHTML : null;
    if (btn && window.ensurePdpState) {
      btn.disabled = true;
      btn.innerHTML = `<span class="oh-btn-icon">${_lucideSvg('refresh-cw')}</span>采集中…`;
      try {
        await window.ensurePdpState();
      } catch {}
      btn.disabled = false;
      if (originalBtnHtml != null) btn.innerHTML = originalBtnHtml;
    }

    // Detect variants from page aspects widget(已含 composer-api fallback)
    let variants = extractAspectVariants();

    // ── Phase 0:弹窗补全(单轴多值,如 38 色)——同采集路径。内联只带可见 ~6,
    // 其余在「Все N цветов」弹窗懒加载;先按 aspectModalInfo.link 拉全量并集,
    // 再进下方多轴 Phase A / 源属性 Phase B 流水线(其 loading 弹窗随后接管进度,
    // 故这里不动 btn 文案,避免与下方 restoreBtn 抢恢复)。
    variants = await jzExpandVariantsViaModal(variants, extractRawAspects(), null);

    // ── 多轴展开 + 源属性预拉(流水线并发,统一 loading) ──
    //
    // 两个 phase:
    //   A. 多轴展开:webAspects 每轴只列与当前 SKU 共享其他维度的变体,所以
    //      6 色 × 8 码只能看到 13 unique SKU,真实 model 可达 48。挑小轴
    //      pivot iterate,fetch 每个非当前色页 SSR HTML(path-only,带 credentials),
    //      DOMParser 提 [data-state].aspects union 进 variantMap。
    //      为什么不走 composer-api page json:2026-05-26 端到端验证全 403,
    //      Ozon 已 deprecate。SSR HTML 200 OK。
    //
    //   B. 源属性预拉:对每个变体 SKU 走 JZSkuCollect.collectBySkus → SW
    //      searchVariants → Ozon /api/v1/search + create-bundle-by-variant-id,
    //      拿 weight/depth/width/height 用于面板 placeholder 兜底显示。
    //
    // 流水线:Phase B 启动时立刻把当前 13 个已知 SKU 喂给 worker pool;Phase A 每
    // 跑完一个色页发现新 SKU 就 push 进同一队列,workers 持续消费。两者完全
    // 重叠 → 总墙钟 ≈ max(A, B) 而非 A+B。3 个 worker × 1 SKU/round 与
    // JZSkuCollect 默认 BATCH_SIZE=3 相同的 in-flight 量。
    //
    // 完成后才打开面板,变体表格立刻就含完整 sourceMap;原 createMulti.. 内的
    // 异步 Phase B 块检测到 panel._panelSourceMap 已有数据就 skip 自己的 fetch。
    const _expandSourceMap = new Map();
    try {
      const rawAspects = extractRawAspects();
      const currentSku = String(extractProductData()?.sku || '');

      // 是否需要 Phase A(只有真多轴 + 多变体才展开)
      const needPhaseA =
        rawAspects.length >= 2 && variants.length > 1 && currentSku;

      // 是否能跑 Phase B(JZSkuCollect 由 manifest 注入 lib/sku-collect.js,
      // 单独门控 — 没有也不阻断面板打开,只是 placeholder 留空)
      const canPhaseB = !!window.JZSkuCollect?.collectBySkus;

      // 只有真多轴(needPhaseA)才在开面板前阻塞做变体发现;单轴(含 38 色单轴,Phase 0
      // 已展开)直接跳过 → 面板秒开,源属性由面板内置 Phase B 渐进填。
      if (needPhaseA) {
        // ── 提前算出 Phase A 要 fetch 几个链接(让初始 progress 文本正确显示 N/M) ──
        let linksToFetch = [];
        if (needPhaseA) {
          const sortedAxes = [...rawAspects].sort(
            (a, b) => (a.variants?.length || 0) - (b.variants?.length || 0),
          );
          const pivotAxis = sortedAxes[0];
          linksToFetch = (pivotAxis?.variants || [])
            .filter((v) => v && String(v.sku) !== currentSku && v.link)
            .slice(0, 8)
            .map((v) => ({ sku: String(v.sku), link: v.link }));
        }

        // ── 共享状态 ──
        const variantMap = new Map(variants.map((v) => [String(v.sku), v]));
        const pendingSkus = canPhaseB ? variants.map((v) => String(v.sku)).filter(Boolean) : [];
        const inflightSkus = new Set();
        let phaseADone = !needPhaseA || linksToFetch.length === 0;
        const phaseATotal = linksToFetch.length;
        let phaseADoneCount = 0;
        let phaseBTotal = pendingSkus.length;
        let phaseBDoneCount = 0;

        // ── 中央 loading 弹窗 — 比 btn 文案显眼,双进度条直观 ──
        const loadingDialog = createPipelineLoadingDialog();
        const restoreBtn = btn ? btn.innerHTML : null;
        const updateBtn = () => {
          // Phase B(源属性)已移到面板内渐进填,开面板前弹窗只显 Phase A(展开变体)
          loadingDialog.update(phaseATotal, phaseADoneCount, 0, 0);
        };
        if (btn) btn.disabled = true;
        updateBtn();

        // Phase B(每变体源属性 = /search + create-bundle)已从「开面板前预拉」移除 ——
        // 改由 createMultiVariantFollowSellPanel 内置的 fallback 渐进填(开面板传 null
        // sourceMap 即触发,带「源属性 done/total」徽章)。开面板前不再阻塞 38× seller
        // 请求,避免等待 + 撞反爬;_expandSourceMap 保持空 → 下方 panel 构造传 null。

        // ── Phase A:SSR HTML fetch 各色页,union aspects 进 variantMap,新 SKU
        //    push 进 pendingSkus 让 workers 立刻消费(linksToFetch 已上面预算) ──
        const phaseA = async () => {
          if (linksToFetch.length === 0) return;
          let fetchedPages = 0;
          for (let i = 0; i < linksToFetch.length; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, 1200));
            const target = linksToFetch[i];
            try {
              const u = new URL(target.link, 'https://www.ozon.ru');
              const r = await fetch(u.pathname, {
                credentials: 'include',
                headers: { accept: 'text/html' },
              });
              if (!r.ok) {
                console.warn(`[ozon-helper] phaseA link ${i + 1}: HTTP ${r.status}`);
                phaseADoneCount++;
                updateBtn();
                continue;
              }
              const html = await r.text();
              const doc = new DOMParser().parseFromString(html, 'text/html');
              let fetchedAspects = null;
              for (const el of doc.querySelectorAll('[data-state]')) {
                try {
                  const data = JSON.parse(el.getAttribute('data-state') || '');
                  if (Array.isArray(data?.aspects) && data.aspects.length > 0) {
                    fetchedAspects = data.aspects;
                    break;
                  }
                } catch {}
              }
              if (!fetchedAspects) {
                phaseADoneCount++;
                updateBtn();
                continue;
              }
              fetchedPages++;
              for (const aspect of fetchedAspects) {
                const aspectName = aspect.aspectName || '';
                for (const v of aspect.variants || []) {
                  const sku = String(v.sku || '');
                  if (!sku) continue;
                  if (!variantMap.has(sku)) {
                    const d = v.data || {};
                    const rawPriceStr = d.price;
                    const srcCurrency = _detectCurrencyFromPriceStr(rawPriceStr);
                    const rawPriceNum = window.normalizePrice(rawPriceStr) || 0;
                    const isRub = _isRubFallbackCurrency(srcCurrency);
                    variantMap.set(sku, {
                      sku,
                      title: d.title || '',
                      price: isRub ? _rubToCny(rawPriceNum) : rawPriceNum,
                      priceCurrency: isRub ? 'CNY' : srcCurrency,
                      priceRub: isRub ? rawPriceNum : 0,
                      coverImage: (d.coverImage || '').replace(/\/wc\d+\//, '/wc1000/'),
                      link: v.link || '',
                      availability: v.availability || 'unknown',
                      active: v.active === true,
                      aspectValues: {},
                    });
                    if (canPhaseB) {
                      pendingSkus.push(sku);
                      phaseBTotal++;
                    }
                  }
                  const existing = variantMap.get(sku);
                  const text =
                    v.data?.searchableText ||
                    v.data?.textRs?.map((t) => t.content).join('') ||
                    '';
                  if (aspectName && text) existing.aspectValues[aspectName] = text;
                }
              }
            } catch (e) {
              console.warn(`[ozon-helper] phaseA link ${i + 1} err:`, e?.message || e);
            }
            phaseADoneCount++;
            updateBtn();
          }
          console.log(
            `[ozon-helper] phaseA SSR expand: ${variants.length} → ${variantMap.size} (fetched ${fetchedPages}/${linksToFetch.length})`,
          );
        };

        // 面板立即开 + 源属性后台渐进填:开面板前只跑 Phase A(多轴变体发现 —— 渲染
        // 变体表格行需要全量变体);源属性(Phase B)不再预拉阻塞,移到面板内渐进填。
        try {
          await phaseA().finally(() => { phaseADone = true; });
        } catch (e) {
          console.warn('[ozon-helper] pipeline await failed:', e?.message || e);
        } finally {
          loadingDialog.close();
          if (btn) {
            btn.disabled = false;
            if (restoreBtn != null) btn.innerHTML = restoreBtn;
          }
        }

        variants = Array.from(variantMap.values());
      }
    } catch (e) {
      console.warn('[ozon-helper] aspect expansion guard failed:', e?.message || e);
    }

    // No variants found — construct a single-element array from current product data
    // so we always use the unified multi-variant panel
    if (variants.length === 0) {
      const product = extractProductData();
      const hasTitle = !!(product?.title && product.title.trim());
      const hasImages = Array.isArray(product?.images) && product.images.length > 0;
      const hasSku = !!(product?.sku || product?.productId);
      if (!hasTitle || !hasImages || !hasSku) {
        const missing = [
          !hasTitle ? '标题' : null,
          !hasImages ? '图片' : null,
          !hasSku ? 'SKU' : null,
        ].filter(Boolean).join(' / ');
        const original = btn ? btn.innerHTML : null;
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = `<span class="oh-btn-icon">${_lucideSvg('alert-triangle')}</span>页面解析失败 (${_escHtml(missing)})`;
          setTimeout(() => {
            if (original != null) btn.innerHTML = original;
            btn.disabled = false;
          }, 3500);
        }
        console.warn('[ozon-helper] extractProductData missing fields after fallback:', { hasTitle, hasImages, hasSku, product });
        return;
      }
      // product.price 已经是 normalized number,币种从 _detectPageCurrency() 拿
      // (它会重新扫 [data-state] 拿带符号的原始字符串解析)。
      const rawPrice = product.price || 0;
      const srcCurrency = _detectPageCurrency();
      const isRub = _isRubFallbackCurrency(srcCurrency);
      variants = [{
        sku: product.sku || product.productId || '',
        title: product.title || '',
        price: isRub ? _rubToCny(rawPrice) : rawPrice,
        priceCurrency: isRub ? 'CNY' : srcCurrency,
        priceRub: isRub ? rawPrice : 0,
        coverImage: product.images?.[0] || '',
        link: window.location.href,
        availability: true,
        active: true,
        aspectValues: {},
      }];
    }

    // Remove stale panel node before creating new one (guaranteed single node)
    document.querySelector('.ozon-helper-followsell-panel')?.remove();

    // 流水线 Phase B 已经拉到的 sourceMap 直接传给 panel 构造,createMultiVariantFollowSellPanel
    // 内部检测到 preCollectedSourceMap 有数据就 apply placeholders 跳过自己的 fetch。
    const panel = createMultiVariantFollowSellPanel(
      variants,
      _expandSourceMap && _expandSourceMap.size > 0 ? _expandSourceMap : null,
    );

    closeAllPanels(panel);
    panel.classList.add('is-open');
    setActiveButton(btn);
  }

  function extractKeywords() {
    // Extract hashtags from Ozon's webHashtags widget
    const hashtagWidget = document.querySelector('[data-widget="webHashtags"]');
    if (hashtagWidget) {
      const tagEls = hashtagWidget.querySelectorAll('[title]');
      const tags = Array.from(tagEls)
        .map(el => el.getAttribute('title')?.trim())
        .filter(t => t && t.startsWith('#'));
      if (tags.length > 0) return tags;
    }
    // Fallback: extract from tagList widget — but ONLY genuine hashtags (#-prefixed).
    // tagList 多数是「搜索关键词 / 类目」链接(多词短语,如「Настенно-потолочные
    // светодиодные светильники」),不是主题标签。旧实现只过滤 length>1 → 把这些短语
    // 当标签塞进 _aiHashtags,含连字符/空格 → 后端发 attr 23171 被 Ozon 拒
    // (BR_hashtags_symbols_validation,整批上架失败)。这里要求以 # 开头,纯关键词
    // 链接被排除:源商品没有真标签就不发,绝不拿关键词凑。
    const tagList = document.querySelector('[data-widget="tagList"]');
    if (tagList) {
      const links = tagList.querySelectorAll('a');
      const tags = Array.from(links)
        .map(a => a.textContent?.trim())
        .filter(t => t && t.startsWith('#'));
      if (tags.length > 0) return tags.slice(0, 20);
    }
    return [];
  }

  function extractPageDescription() {
    const contentCopy = window.JZFollowSellContentCopy;
    const readNodeText = (node) => (node?.innerText || node?.textContent || '').trim();
    const isExtensionNode = (node) => Boolean(node?.closest?.('[class*="ozon-helper"]'));
    // 富内容(RichContent widget)继续作为独立富内容块(11254)下发,描述不再兜底抓它回来:
    // 凡落在富内容 widget 内的节点一律跳过 —— 同时挡住 directSelectors 与下方「Описание 标题启发式」两条口子。
    const isRichContentNode = (node) =>
      Boolean(node?.closest?.('[data-widget*="richcontent" i]'));
    const candidates = [];
    const addCandidateText = (text) => {
      const raw = String(text || '').trim();
      if (raw) candidates.push(raw);
    };
    const addCandidateNode = (node) => {
      if (!node || isExtensionNode(node) || isRichContentNode(node)) return '';
      const text = readNodeText(node);
      if (text) candidates.push(text);
    };

    const state = window.extractStateData?.('state-webDescription');
    const fromState = contentCopy?.extractDescriptionText
      ? contentCopy.extractDescriptionText(state, 4096)
      : contentCopy?.safeText(
          state?.description || state?.text || state?.content || state?.html || '',
          4096,
        );
    addCandidateText(fromState);

    const directSelectors = [
      '[data-widget="webDescription"]',
      '[data-widget*="Description" i]',
      '[data-widget*="description" i]',
    ];
    const seen = new Set();
    for (const selector of directSelectors) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (_) {
        nodes = [];
      }
      for (const node of nodes) {
        if (seen.has(node)) continue;
        seen.add(node);
        addCandidateNode(node);
      }
    }

    const headingTexts = new Set([
      'description',
      '\u041e\u043f\u0438\u0441\u0430\u043d\u0438\u0435'.toLowerCase(),
      '\u0421\u043e\u0441\u0442\u0430\u0432'.toLowerCase(),
      '\u0421\u043f\u043e\u0441\u043e\u0431 \u043f\u0440\u0438\u043c\u0435\u043d\u0435\u043d\u0438\u044f'.toLowerCase(),
      '\u63cf\u8ff0',
      '\u5546\u54c1\u63cf\u8ff0',
    ]);
    const normalizeHeading = (value) => String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/[:：]+$/g, '')
      .trim()
      .toLowerCase();
    const headingNodes = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],div,span,p'))
      .filter((node) => {
        if (isExtensionNode(node)) return false;
        const text = normalizeHeading(readNodeText(node));
        return text.length > 0 && text.length <= 30 && headingTexts.has(text);
      });
    for (const heading of headingNodes) {
      let current = heading.parentElement;
      let depth = 0;
      while (current && current !== document.body && depth < 5) {
        addCandidateNode(current);
        current = current.parentElement;
        depth += 1;
      }
    }

    if (contentCopy?.pickBestVisibleDescriptionText) {
      return contentCopy.pickBestVisibleDescriptionText(candidates, 4096);
    }
    if (contentCopy?.extractVisibleDescriptionText) {
      for (const value of candidates) {
        const text = contentCopy.extractVisibleDescriptionText(value, 4096);
        if (text) return text;
      }
    }
    return candidates.find(Boolean) || '';
  }

  function createKeywordPanel() {
    let panel = document.querySelector('.ozon-helper-keyword-panel');
    if (panel) {
      return panel;
    }

    panel = document.createElement('div');
    panel.className = 'ozon-helper-panel ozon-helper-keyword-panel';
    panel.innerHTML = `
      <div class="ozon-helper-panel-header">
        <span>主题标签</span>
        <div style="display:flex;align-items:center;gap:6px;margin-left:auto;">
          <button class="ozon-helper-keyword-copy-all" data-action="copy-all" title="复制全部主题标签到剪贴板">${window.lucideIcon('copy', 13)} 复制全部</button>
          <button class="ozon-helper-close-btn" data-action="close">&times;</button>
        </div>
      </div>
      <div class="ozon-helper-panel-content">
        <div class="ozon-helper-keyword-list"></div>
      </div>
    `;

    document.body.appendChild(panel);

    panel.querySelector('[data-action="close"]').addEventListener('click', () => {
      closePanel(panel);
    });

    panel.querySelector('[data-action="copy-all"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const tags = extractKeywords();
      const reset = () => { btn.innerHTML = `${window.lucideIcon('copy', 13)} 复制全部`; };
      if (!tags.length) {
        btn.textContent = '无标签';
        setTimeout(reset, 1200);
        return;
      }
      // 用空格连接：贴到 Ozon 商品 SEO 描述 / 微信群分享时不会被自动换行打断
      const ok = await _safeCopy(tags.join(' '));
      btn.textContent = ok ? `已复制 ${tags.length} 个` : '复制失败';
      setTimeout(reset, 1500);
    });

    return panel;
  }

  function updateKeywordPanel() {
    const panel = createKeywordPanel();
    const listContainer = panel.querySelector('.ozon-helper-keyword-list');
    if (!listContainer) return;

    const keywords = extractKeywords();

    if (keywords.length === 0) {
      listContainer.innerHTML = '<div class="ozon-helper-panel-empty">未找到主题标签</div>';
      return;
    }

    listContainer.innerHTML = keywords.map(keyword => {
      const safe = _escHtml(keyword);
      return `
      <div class="ozon-helper-keyword-item">
        <span class="ozon-helper-keyword-text">${safe}</span>
        <div class="ozon-helper-keyword-actions">
          <button class="ozon-helper-keyword-btn" data-action="copy" data-keyword="${safe}" title="复制">${window.lucideIcon('copy', 13)}</button>
          <button class="ozon-helper-keyword-btn" data-action="translate" data-keyword="${safe}" title="翻译">${window.lucideIcon('globe', 13)}</button>
        </div>
        <span class="ozon-helper-keyword-translation" data-keyword="${safe}" style="display: none;"></span>
      </div>
    `;
    }).join('');

    listContainer.addEventListener('click', async (e) => {
      const btn = e.target.closest('.ozon-helper-keyword-btn');
      if (!btn) return;

      const action = btn.dataset.action;
      const keyword = btn.dataset.keyword;

      if (action === 'copy') {
        const ok = await _safeCopy(keyword);
        btn.innerHTML = ok ? window.lucideIcon('check', 13) : window.lucideIcon('x', 13);
        setTimeout(() => { btn.innerHTML = window.lucideIcon('copy', 13); }, 1000);
      } else if (action === 'translate') {
        const translationSpan = listContainer.querySelector(`.ozon-helper-keyword-translation[data-keyword="${keyword}"]`);
        if (!translationSpan) return;

        if (translationSpan.style.display === 'none') {
          btn.innerHTML = window.lucideIcon('loader', 13);
          try {
            const response = await window.sendMessage('translateKeywords', { texts: [keyword], from: 'ru', to: 'zh' });
            if (response.ok && response.data?.translations?.[0]) {
              translationSpan.textContent = response.data.translations[0];
              translationSpan.style.display = 'block';
              btn.innerHTML = window.lucideIcon('globe', 13);
            } else {
              translationSpan.textContent = '翻译失败';
              translationSpan.style.display = 'block';
              btn.innerHTML = window.lucideIcon('x', 13);
              setTimeout(() => { btn.innerHTML = window.lucideIcon('globe', 13); }, 2000);
            }
          } catch (error) {
            translationSpan.textContent = `错误: ${error.message}`;
            translationSpan.style.display = 'block';
            btn.innerHTML = window.lucideIcon('x', 13);
            setTimeout(() => { btn.innerHTML = window.lucideIcon('globe', 13); }, 2000);
          }
        } else {
          translationSpan.style.display = 'none';
        }
      }
    });
  }

  function toggleKeywordPanel(btn) {
    const panel = createKeywordPanel();
    if (panel.classList.contains('is-open')) {
      closePanel(panel);
    } else {
      closeAllPanels(panel);
      panel.style.right = ''; // 清除 JS 覆盖
      panel.classList.add('is-open');
      setActiveButton(btn);
      updateKeywordPanel();
    }
  }

  function createPriceBadge() {
    if (document.querySelector('.ozon-helper-price-badge')) {
      return;
    }
    const product = extractProductData();
    if (!product.price) {
      return;
    }

    const priceAnchor =
      document.querySelector('[data-widget="webPrice"]') ||
      document.querySelector('[data-widget="webSale"]') ||
      document.querySelector('[data-widget="webSalePrice"]');
    if (!priceAnchor) {
      return;
    }

    const badge = document.createElement('div');
    badge.className = 'ozon-helper-price-badge';

    const currentPrice = window.normalizePrice(product.price || 0);
    const originalPrice = window.normalizePrice(product.originalPrice || 0);
    const avgPrice = window.normalizePrice(product.statistics?.avg_price || 0);
    const discountPercent =
      originalPrice > currentPrice && originalPrice > 0
        ? Math.round(((originalPrice - currentPrice) / originalPrice) * 100)
        : 0;

    const priceStatus = avgPrice
      ? currentPrice <= avgPrice
        ? '低于均价'
        : '高于均价'
      : '均价未知';

    badge.innerHTML = `
      ${discountPercent ? `<span class="ozon-helper-badge-discount">-${discountPercent}%</span>` : ''}
      <span class="ozon-helper-badge-status">${priceStatus}</span>
    `;

    priceAnchor.appendChild(badge);
  }

  async function init() {
    if (_JZ_IS_PRODUCT_PAGE) {
      const stableSku = window.location.pathname.match(/\/product\/.*-(\d+)/)?.[1]
        || String(extractProductData()?.sku || '');
      if (stableSku) collectCoordinator.prefetch({ sku: stableSku }).catch(() => {});
    }
    const auth = await window.checkAuth();
    if (!auth.loggedIn) {
      window.createLoginPrompt();
      if (_JZ_IS_PRODUCT_PAGE) createSidebarDataCard();
      return;
    }

    // 列表页只注入精简浮窗,不做详情页那套商品级初始化(价格徽标/侧栏数据卡/采集等)。
    if (!_JZ_IS_PRODUCT_PAGE) {
      createSlimActionBar();
      return;
    }

    createActionBar();
    createPriceBadge();
    createSidebarDataCard();

    // 监听来自 service worker / popup 的消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'triggerCollectFromPopup') {
        // 跟 action bar 一键采集一致:采当前商品所有变体合并成一条记录(popup 消费方
        // 只看 resp.ok,ok=true 时会把该 URL 标记为已采集并移出列表)。母体单次 push 失败
        // (failed>0)必须返回 ok:false,否则失败被隐藏、URL 被永久移出待采列表。
        collectAllVariants()
          .then(r => {
            const ok = r?.multiVariant ? (r.total > 0 && !r.failed) : true;
            sendResponse({
              ok,
              multiVariant: !!r?.multiVariant,
              total: r?.total ?? null,
              failed: r?.failed ?? 0,
              dedupeHit: !!r?.dedupeHit,
              lastAt: r?.lastAt || null,
              error: ok ? undefined : '全部变体采集失败',
            });
          })
          .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true; // 异步 sendResponse
      }
      return true;
    });

    window.addEventListener('resize', () => {
      const panel = document.querySelector('.ozon-helper-profit-panel.is-open');
      if (panel) {
        positionProfitPanel(panel);
      }
      const bar = document.querySelector('.ozon-helper-action-bar');
      if (bar && bar.style.left) {
        const left = parseInt(bar.style.left);
        const top  = parseInt(bar.style.top);
        if (!isNaN(left) && !isNaN(top)) {
          applyBarPosition(bar, { left, top });
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
})();
