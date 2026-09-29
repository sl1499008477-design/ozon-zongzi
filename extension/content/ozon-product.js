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
  // 搜索、卖家和首页商品卡使用同一公开详情读取路径；在页面 UI 守卫之前提供。
  window.jzReadOzonProductMedia = fetchVariantGallery;
  // 接收器独立于侧栏和会员 UI；后台已固定 Collector 账号与领取凭证。
  installOzonWebCollectionReceiver();
  const _JZ_CATEGORY_STRATEGY_PRODUCT_FALLBACK = _JZ_IS_PRODUCT_PAGE
    && new URLSearchParams(window.location.search).has('zongziCategoryStrategySession');
  if (_JZ_CATEGORY_STRATEGY_PRODUCT_FALLBACK) {
    let observer = null;
    let timeout = null;
    const redirect = () => {
      let target = '';
      try {
        target = window.JzOzonBuyerCategory?.samplingTargetForProductPage(
          window.location.href,
          document,
        ) || '';
      } catch {
        return false;
      }
      if (!target) return false;
      observer?.disconnect();
      if (timeout) clearTimeout(timeout);
      window.location.replace(target);
      return true;
    };
    if (!redirect()) {
      observer = new MutationObserver(() => redirect());
      observer.observe(document.documentElement, { childList: true, subtree: true });
      timeout = setTimeout(() => observer.disconnect(), 15_000);
    }
    return;
  }
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

  function invalidProductVariantError(cause) {
    return Object.assign(new Error('Ozon 商品变体数据无效'), {
      code: 'ZONGZI_ENRICH_CONTRACT_MISMATCH',
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
    if (/ZONGZI_ENRICH_INCOMPLETE|ZONGZI_ENRICH_CONTRACT_MISMATCH/.test(code)
      || message.startsWith('缺少：')) {
      return message || '商品补全资料不完整';
    }
    if (['COLLECT_GALLERY_FAILED', 'COLLECT_PRICE_FAILED', 'ZONGZI_PRODUCT_RUSSIAN_REQUIRED', 'ZONGZI_COLLECTION_RELOADING'].includes(code)) return message;
    if (/ZONGZI_ENRICH_BUSY/.test(code)) return '商品资料正在排队，请稍后重试';
    if (/ZONGZI_ENRICH_NOT_FOUND/.test(code)) return '未找到该商品的完整资料';
    if (/ZONGZI_ENRICH_UPSTREAM_FAILED/.test(code)) return 'Ozon 商品资料暂时无法读取';
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

  function installOzonWebCollectionReceiver() {
    let active = null;
    const sameClaim = (left, right) => left && right && left.id === right.id
      && left.claimFence === right.claimFence && left.accountId === right.accountId;
    const blockedPage = () => {
      const text = `${document.title || ''}\n${document.body?.innerText || ''}`.slice(0, 4000);
      if (/доступ ограничен|подтвердите.{0,40}не робот|проверка безопасности|verify you are human|access denied|captcha|验证码|请完成验证/i.test(text)) {
        return { code: 'ZONGZI_VERIFICATION_REQUIRED', message: '请在已打开的 Ozon 页面完成验证，然后在网页任务中点击继续', waiting: true };
      }
      if (/войдите.{0,30}продолж|登录后.{0,10}继续|authentication required/i.test(text)) {
        return { code: 'ZONGZI_LOGIN_REQUIRED', message: '请在已打开的 Ozon 页面完成登录，然后在网页任务中点击继续', waiting: true };
      }
      return null;
    };
    const emit = async (task, kind, fields) => {
      if (active !== task) return;
      const event = { action: 'ozonWebCollectionEvent', kind, jobId: task.job.id,
        claimFence: task.job.claimFence, accountId: task.job.accountId, sku: task.job.sku, ...fields };
      if (kind === 'result' || kind === 'fail') task.terminal = event;
      try {
        const ack = await chrome.runtime.sendMessage(event);
        if (kind === 'progress' && ack?.ok === false && active === task) active = null;
      } catch { /* The next start message replays the terminal event after a worker restart. */ }
    };
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!['startOzonWebCollection', 'stopOzonWebCollection'].includes(message?.action)) return false;
      const job = message.job;
      if (sender?.id !== chrome.runtime.id || !job?.id || !job.claimFence || !job.accountId
        || !/^\d+$/.test(job.sku) || !['ALL', 'CURRENT'].includes(job.scope)) {
        sendResponse({ ok: false, code: 'WEB_COLLECT_TASK_INVALID' });
        return false;
      }
      if (message.action === 'stopOzonWebCollection') {
        if (sameClaim(active?.job, job)) active = null;
        sendResponse({ ok: true });
        return false;
      }
      const url = new URL(window.location.href);
      if (url.protocol !== 'https:' || !['www.ozon.ru', 'ozon.ru', 'www.ozon.kz', 'ozon.kz'].includes(url.hostname)
        || url.pathname.match(/^\/product\/(?:[^/]*-)?(\d+)\/?$/)?.[1] !== job.sku) {
        sendResponse({ ok: false, code: 'COLLECT_PAGE_CHANGED', message: '当前页面与网页采集 SKU 不一致' });
        return false;
      }
      if (sameClaim(active?.job, job)) {
        sendResponse({ ok: true, started: true });
        if (active.terminal) void chrome.runtime.sendMessage(active.terminal).catch(() => {});
        return false;
      }
      const task = { job };
      active = task;
      // Acknowledge before capture starts. Multi-SKU capture reports separate progress/result events.
      sendResponse({ ok: true, started: true });
      void Promise.resolve().then(async () => {
        const blocked = blockedPage();
        if (blocked) throw Object.assign(new Error(blocked.message), blocked);
        const onStatus = message => {
          if (active !== task) throw Object.assign(new Error('网页采集任务已停止'), { code: 'WEB_COLLECT_STOPPED' });
          void emit(task, 'progress', { message });
        };
        onStatus('正在读取商品页面…');
        await ensureRussianCollectionPage({ automatic: true });
        if (active !== task) return;
        const options = { captureOnly: true, onStatus };
        const result = job.scope === 'ALL' ? await collectAllVariants(null, options) : await performProductCollect(options);
        if (active !== task) return;
        if (String(result?.payload?.sku || '') !== job.sku) throw Object.assign(new Error('采集资料 SKU 与网页任务不一致'), { code: 'COLLECT_SKU_MISMATCH' });
        await emit(task, 'result', { payload: result.payload, capturedAt: new Date().toISOString() });
      }).catch(async error => {
        if (active !== task || error?.code === 'WEB_COLLECT_STOPPED') return;
        if (error?.code === 'ZONGZI_COLLECTION_RELOADING') {
          await emit(task, 'progress', { message: '已切换俄语，等待页面刷新后继续采集' });
          return;
        }
        const blocked = blockedPage();
        await emit(task, 'fail', blocked || { code: error?.code || 'COLLECT_CAPTURE_FAILED',
          message: error?.message || '商品采集失败，请重试', waiting: error?.waiting === true });
      });
      return false;
    });
  }

  // Ozon 的页面 JSON 服从站点语言设置；仅 ru 请求头无法覆盖中文设置。
  // 用户点击采集才切换语言。刷新后只恢复同一 SKU 一次，币种设置不变。
  async function ensureRussianCollectionPage(options = {}) {
    if (!/^zh(?:-|$)/i.test(document.documentElement?.lang || '')) return;
    const failure = () => Object.assign(new Error('无法取得俄语商品资料，请将 Ozon 网站语言切换为俄语，刷新后重新采集'), {
      code: 'ZONGZI_PRODUCT_RUSSIAN_REQUIRED', retryable: true,
    });
    try {
      const response = await fetch('/api/composer-api.bx/_action/saveLocale', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-o3-app-name': 'dweb_client', accept: 'application/json' },
        body: JSON.stringify({ locale: 'ru' }),
      });
      if (!response.ok || (await response.json()).isSuccess !== true) throw failure();
      if (!options.automatic) sessionStorage.setItem('jz-russian-collection-resume', JSON.stringify({
        sku: String(extractProductData()?.sku || ''), at: Date.now(),
      }));
    } catch {
      throw failure();
    }
    window.location.reload();
    throw Object.assign(new Error('已切换俄语，页面刷新后继续采集'), { code: 'ZONGZI_COLLECTION_RELOADING' });
  }

  function consumeRussianCollectionResume(sku) {
    try {
      const saved = JSON.parse(sessionStorage.getItem('jz-russian-collection-resume') || 'null');
      sessionStorage.removeItem('jz-russian-collection-resume');
      const age = Date.now() - saved?.at;
      return !!saved && saved.sku === String(sku) && age >= 0 && age < 120000
        && /^ru(?:-|$)/i.test(document.documentElement?.lang || '');
    } catch { return false; }
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
  async function jzFetchAspectsModalVariants(modalLink, { aspectName: requestedAspectName } = {}) {
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
            if (requestedAspectName && aspectName !== requestedAspectName) continue;
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
  async function jzExpandVariantsViaModal(variants, rawAspects, setBtn, options = {}) {
    if (options.requireComplete) {
      const map = new Map(variants.map(row => [String(row.sku), row]));
      for (const aspect of rawAspects) {
        const total = Number(aspect?.aspectModalInfo?.realNumberOfVariants) || 0;
        const axisRows = new Map((aspect.variants || []).filter(row => row.sku).map(row => [String(row.sku), row]));
        if (total > axisRows.size) {
          setBtn?.(`展开 SKU ${options.sourceSku} 的 ${total} 个${aspect.aspectName || '关联'}变体…`);
          const extra = await jzFetchAspectsModalVariants(aspect.aspectModalInfo?.link, { aspectName: aspect.aspectName });
          for (const row of extra) axisRows.set(String(row.sku), row);
          if (axisRows.size < total) throw Object.assign(new Error(`SKU ${options.sourceSku} 的 ${aspect.aspectName || '规格'}标明 ${total} 个变体，仅展开 ${axisRows.size} 个；请刷新后重试整组采集`), {
            code: 'COLLECT_VARIANTS_INCOMPLETE', retryable: true,
          });
          for (const row of extra) if (!map.has(String(row.sku))) map.set(String(row.sku), row);
        }
        options.expandedAxes?.set(aspect, [...axisRows.values()]);
      }
      return [...map.values()];
    }
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

  function currentBuyerCategoryUrl() {
    try {
      return window.JzOzonBuyerCategory?.findLeafCategoryUrl(document) || '';
    } catch {
      return '';
    }
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
  // 复用一键跟卖的变体展开思路：SSR 逐页补全跨轴所有公开变体，
  // 然后一次写入母体采集记录。Seller 属性由带 context 证据的后台任务补全。
  // 静默执行,进度直接显示在按钮上;单/无变体页直接委托 performProductCollect(单采)。
  //
  // 注意:下面的 SSR 展开块是 toggleFollowSellPanel(§Phase A,约 7397-7480)
  // 的精简镜像，但采集路径不启动跟卖面板的 Seller worker pool。
  // 若 Ozon 改 aspects/SSR 格式,两处需同步更新。
  async function collectAllVariants(btn, options = {}) {
    await ensureRussianCollectionPage({ automatic: options.captureOnly === true });
    const forceSingleResubmit = Boolean(options.forceResubmit);
    const setBtn = (text) => {
      options.onStatus?.(text);
      if (btn) btn.innerHTML = `<span class="oh-btn-icon">${_lucideSvg('refresh-cw')}</span>${text}`;
    };

    // composer-api 缓存预热(限 3s),让后续 sync 提取走 cache fallback
    if (window.ensurePdpState) {
      try { await Promise.race([window.ensurePdpState(), new Promise((r) => setTimeout(r, 3000))]); } catch {}
    }

    let variants = extractAspectVariants();
    const rawAspects = extractRawAspects();
    const expandedAxes = new Map();

    // ── Phase 0:弹窗补全(单轴多值,如 38 色)──
    // 内联 webAspects 只带可见 ~6 个,其余在「Все N цветов」弹窗懒加载;Phase A 的
    // ≥2 轴门挡不住单轴场景,这里先按 aspectModalInfo.link 拉全量并集。
    variants = await jzExpandVariantsViaModal(variants, rawAspects, setBtn, {
      requireComplete: options.captureOnly === true, sourceSku: String(extractProductData()?.sku || ''), expandedAxes,
    });

    // ── Phase A:SSR 逐页展开补全所有变体 SKU(多轴网格)──
    const failedExpansionSkus = [];
    try {
      const currentSku = String(extractProductData()?.sku || '');
      // Automatic ALL follows every discovered SKU: a shorter axis can hide
      // fixed representatives, sparse combinations, or another axis on a sibling.
      const traverseAllAxes = options.captureOnly === true;
      const needPhaseA = variants.length > 1 && currentSku && (traverseAllAxes || rawAspects.length >= 2);
      if (needPhaseA) {
        const variantMap = new Map(variants.map((v) => [String(v.sku), v]));
        const sortedAxes = [...rawAspects].sort(
          (a, b) => (a.variants?.length || 0) - (b.variants?.length || 0),
        );
        const traversalRows = traverseAllAxes ? [...variantMap.values()] : (expandedAxes.get(sortedAxes[0]) || sortedAxes[0]?.variants || []);
        const linksToFetch = traversalRows
          .filter((v) => v && String(v.sku) !== currentSku && (v.link || options.captureOnly))
          .slice(0, options.captureOnly ? undefined : 8)
          .map((v) => ({ sku: String(v.sku), link: v.link || `/product/${v.sku}/` }));
        const scheduledSkus = new Set([currentSku, ...linksToFetch.map(row => row.sku)]);
        const enqueueDiscoveredVariant = row => {
          const sku = String(row.sku || '');
          if (!traverseAllAxes || !sku || scheduledSkus.has(sku)) return;
          scheduledSkus.add(sku);
          linksToFetch.push({ sku, link: row.link || `/product/${sku}/` });
        };
        for (let i = 0; i < linksToFetch.length; i++) {
          setBtn(`展开变体 ${i}/${linksToFetch.length}…`);
          if (i > 0) await new Promise((r) => setTimeout(r, 1200));
          try {
            const u = new URL(linksToFetch[i].link, 'https://www.ozon.ru');
            const r = await fetch(u.pathname, { credentials: 'include', headers: { accept: 'text/html' } });
            if (!r.ok) {
              if (options.captureOnly) failedExpansionSkus.push(linksToFetch[i].sku);
              continue;
            }
            const html = await r.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            let fetchedAspects = null;
            for (const el of doc.querySelectorAll('[data-state]')) {
              try {
                const data = JSON.parse(el.getAttribute('data-state') || '');
                if (Array.isArray(data?.aspects) && data.aspects.length > 0) { fetchedAspects = data.aspects; break; }
              } catch {}
            }
            if (!fetchedAspects) {
              if (options.captureOnly) failedExpansionSkus.push(linksToFetch[i].sku);
              continue;
            }
            if (options.captureOnly) {
              const modalRows = await jzExpandVariantsViaModal([], fetchedAspects, setBtn, {
                requireComplete: true, sourceSku: linksToFetch[i].sku,
              });
              const includesCurrentSku = row => String(row.sku) === linksToFetch[i].sku;
              if (!modalRows.some(includesCurrentSku)
                && !fetchedAspects.some(aspect => (aspect.variants || []).some(includesCurrentSku))) {
                failedExpansionSkus.push(linksToFetch[i].sku);
                continue;
              }
              for (const row of modalRows) {
                if (!variantMap.has(String(row.sku))) variantMap.set(String(row.sku), row);
                enqueueDiscoveredVariant(row);
              }
            }
            for (const aspect of fetchedAspects) {
              const aspectName = aspect.aspectName || '';
              for (const v of aspect.variants || []) {
                const sku = String(v.sku || '');
                if (!sku) continue;
                enqueueDiscoveredVariant(v);
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
            if (options.captureOnly && e?.code === 'COLLECT_VARIANTS_INCOMPLETE') throw e;
            if (options.captureOnly) failedExpansionSkus.push(linksToFetch[i].sku);
            console.warn('[ozon-helper] collectAll phaseA err:', e?.message || e);
          }
        }
        variants = Array.from(variantMap.values());
      }
    } catch (e) {
      if (options.captureOnly && e?.code === 'COLLECT_VARIANTS_INCOMPLETE') throw e;
      console.warn('[ozon-helper] collectAll expand guard:', e?.message || e);
    }

    if (options.captureOnly) {
      if (failedExpansionSkus.length) throw Object.assign(new Error(`SKU ${failedExpansionSkus.join('、')} 的关联变体展开失败，请重试整组采集`), {
        code: 'COLLECT_VARIANTS_INCOMPLETE', retryable: true,
      });
      const declaredTotal = Math.max(0, ...extractRawAspects().map(a => Number(a?.aspectModalInfo?.realNumberOfVariants) || 0));
      if (new Set(variants.map(v => String(v.sku))).size < declaredTotal) {
        throw Object.assign(new Error(`页面标明 ${declaredTotal} 个变体，仅展开 ${variants.length} 个；请刷新页面后重试整组采集`), {
          code: 'COLLECT_VARIANTS_INCOMPLETE', retryable: true,
        });
      }
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
        ...options,
        forceResubmit: forceSingleResubmit,
        onStatus: setBtn,
      });
    }

    // ── 组装成「一条多变体采集记录」(锚定母体/当前页 SKU)──
    // 旧实现把每个变体 push 成独立一行(N 行),用户在采集箱看到一堆同款散行。
    // 现在改为:N 个变体写进母体 variantData.variants,后端按母体 SKU upsert 一行,
    // 编辑页 collect-adapter 据此渲染多变体 → 一个采集商品、多变体编辑。
    //
    // 母体统计/卖家/划线价取当前页 anchor；图册、视频与富内容按 SKU 保留。
    const anchorProduct = (() => { try { return extractProductData(); } catch { return null; } })();
    const anchorSku = String(anchorProduct?.sku || anchorProduct?.productId || '');
    const sourceCharacteristics = (() => {
      try { return extractCharacteristics(); } catch { return []; }
    })();

    if (!variants.some((v) => String(v.sku) === anchorSku)) throw invalidProductVariantError();
    // aspect 只提供封面。当前页复用已读取的图册，兄弟 SKU 各自读取公开商品页，
    // 不把母体图片或推荐商品图片当作其他规格的原图。
    const galleries = new Map();
    const galleryTargets = variants;
    const galleryBatchSize = 4;
    for (let i = 0; i < galleryTargets.length; i += galleryBatchSize) {
      setBtn(`读取图册 ${i}/${galleryTargets.length}…`);
      const batch = galleryTargets.slice(i, i + galleryBatchSize);
      await Promise.all(batch.map(async (v) => {
        const sku = String(v.sku);
        const media = await fetchVariantGallery(v.link || `/product/${sku}/`, { expectedSku: sku });
        if (sku === anchorSku && !media.pricing?.blackPrice) media.pricing = buildMarketingPricePayload(anchorProduct);
        if (media.images.length) galleries.set(sku, media);
      }));
      const missing = batch.filter((v) => !galleries.has(String(v.sku)));
      if (missing.length) {
        throw Object.assign(new Error(`SKU ${missing.map(v => v.sku).join('、')} 图册读取失败，请刷新商品页后重试`), {
          code: 'COLLECT_GALLERY_FAILED', retryable: true,
        });
      }
    }

    const missingPrices = variants.filter(v => !galleries.get(String(v.sku))?.pricing?.blackPrice);
    if (missingPrices.length) throw Object.assign(new Error(`SKU ${missingPrices.map(v => v.sku).join('、')} 售价资料读取失败，请刷新商品页后重试`), {
      code: 'COLLECT_PRICE_FAILED', retryable: true,
    });

    // 初次采集只使用公开 aspect/DOM/图册字段。Seller 源快照只能由带修订证据的
    // 后台任务补入，不能从 content script 未认证地混入 public upload。
    const toVariantRow = (v) => {
      const sku = String(v.sku);
      const media = galleries.get(sku) || {};
      const images = media.images || [];
      const pricing = media.pricing || {};
      let link = '';
      try { if (v.link) link = new URL(v.link, 'https://www.ozon.ru').href; } catch {}
      return {
        sku,
        name: v.title || '',
        image: images[0] || undefined,
        images: images.length ? images : undefined,
        videos: media.videos?.length ? media.videos : undefined,
        videoUrl: media.videos?.[0]?.url,
        videoCover: media.videos?.[0]?.coverUrl,
        richContent: media.richContent || undefined,
        description: media.description || undefined,
        color_image: media.color_image,
        videoCoverUrl: media.videoCoverUrl,
        contentDiagnostics: media.contentDiagnostics,
        // 每个 SKU 保留自己的黑标/绿标价格及原币种，竞品真实售价计算由后端统一计算。
        ...pricing,
        price: pricing.greenPrice || pricing.blackPrice,
        priceCurrency: pricing.blackPriceCurrency,
        // is_aspect 规格维度值(颜色/尺码 → 文本),编辑页可据此预填区分 SKU 的属性。
        aspectValues: v.aspectValues && Object.keys(v.aspectValues).length ? v.aspectValues : undefined,
        link: link || undefined,
      };
    };

    const rows = variants.map(toVariantRow).filter((r) => r.sku);
    // 母体必须精确匹配当前页 SKU，禁止把第一个兄弟变体当作锚点。
    const anchorRow = rows.find((r) => r.sku === anchorSku);
    if (!anchorRow) throw invalidProductVariantError();
    const variantRows = rows.map((r) => ({
      sku: r.sku,
      name: r.name || undefined,
      price: r.price,
      priceCurrency: r.priceCurrency,
      ...buildMarketingPricePayload(r),
      image: r.image,
      images: r.images,
      videos: r.videos,
      videoUrl: r.videoUrl,
      videoCover: r.videoCover,
      richContent: r.richContent,
      description: r.description,
      color_image: r.color_image,
      videoCoverUrl: r.videoCoverUrl,
      contentDiagnostics: r.contentDiagnostics,
      aspectValues: r.aspectValues,
      link: r.link,
    }));

    const variantData = { variants: variantRows, ...(anchorRow.description ? { description: anchorRow.description } : {}) };
    mergeMarketingPriceIntoVariantData(variantData, anchorProduct);
    // 母体保留既有 11254 入口；每个变体通过自己的 richContent 字段下发。
    jzInjectRichContentAttr(variantData, anchorRow.richContent);
    const contentCopy = window.JZFollowSellContentCopy;
    const collectAllDescription = contentCopy?.pickFollowSellDescription
      ? contentCopy.pickFollowSellDescription({
          customDescription: '',
          sourceVariant: variantData,
          richContent: anchorRow.richContent || '',
          fallbackName: '',
          max: 4096,
        })
      : '';
    contentCopy?.mergeSourceDescriptionIntoVariant?.(variantData, collectAllDescription);
    const collectAllHashtags = extractKeywords();
    contentCopy?.mergeSourceHashtagsIntoVariant?.(variantData, collectAllHashtags);
    const s = anchorProduct?.statistics || {};
    const buyerCategoryUrl = currentBuyerCategoryUrl();
    const payload = {
      sku: String(anchorRow.sku),
      url: window.location.href,
      ...(buyerCategoryUrl ? { buyerCategoryUrl } : {}),
      name: anchorRow.name || undefined,
      price: anchorRow.price,
      priceCurrency: anchorRow.priceCurrency,
      originalPrice: anchorProduct?.originalPrice != null ? String(anchorProduct.originalPrice) : undefined,
      ...buildMarketingPricePayload(anchorProduct),
      image: anchorRow.image,
      images: anchorRow.images,
      videos: anchorRow.videos,
      videoUrl: anchorRow.videoUrl,
      videoCover: anchorRow.videoCover,
      richContent: anchorRow.richContent,
      description: anchorRow.description,
      color_image: anchorRow.color_image,
      videoCoverUrl: anchorRow.videoCoverUrl,
      contentDiagnostics: anchorRow.contentDiagnostics,
      sourceCharacteristics: sourceCharacteristics.length ? sourceCharacteristics : undefined,
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

    if (options.captureOnly) return { ok: true, payload, multiVariant: true, total: variantRows.length };

    // 公开变体资料先一次写入采集箱；Seller 字段由后台任务逐步补全。
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
  function jzMergeCollectedGalleryImages(...lists) {
    const images = new Map();
    for (const image of lists.flat()) {
      let key = image;
      let chinaCdn = false;
      try {
        const url = new URL(image);
        if (url.protocol === 'https:' && /^ir(?:-\d+)?\.(?:ozone\.ru|ozonstatic\.cn)$/.test(url.hostname)) {
          key = url.hostname.replace(/\.ozonstatic\.cn$/, '.ozone.ru') + url.pathname + url.search;
          chinaCdn = url.hostname.endsWith('.ozonstatic.cn');
        }
      } catch { /* Preserve existing source values for the ingestion boundary. */ }
      // Keep the first gallery position, using a CN URL only when Ozon supplied it.
      if (!images.has(key) || chinaCdn) images.set(key, image);
    }
    return [...images.values()];
  }

  async function performProductCollect(options = {}) {
    options.onStatus?.('读取当前 SKU 的完整商品资料…');
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
    const sourceCharacteristics = (() => {
      try { return extractCharacteristics(); } catch { return []; }
    })();
    try {
      logProductSummary(product, extractBreadcrumbs(), sourceCharacteristics, '');
    } catch (e) {
      console.warn('[ozon-helper] logProductSummary threw:', e?.message);
      throw e;
    }

    // 只复用侧栏面板已经完成的 Seller 查询；不额外发请求，也不等待仍在途的
    // 查询。没有现成证据时保持原来的公开采集 + 后端缺失项补全路径。
    let collectSellerEvidence = {};
    if (typeof window.jzReadOzonCollectEvidence === 'function') {
      try {
        collectSellerEvidence = await window.jzReadOzonCollectEvidence(product.sku) || {};
      } catch { /* public collection remains available */ }
    }
    const variantMatch = collectSellerEvidence?.variantData
      && typeof collectSellerEvidence.variantData === 'object'
      && !Array.isArray(collectSellerEvidence.variantData)
      ? collectSellerEvidence.variantData
      : null;

    // 跟卖式 catalog 抽取:name/images 切成 sv(search+bundle)优先,DOM 兜底。
    // statistics / price / seller 仍走 DOM(seller-portal 接口不返回)。
    const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(variantMatch) : null;
    const collectName = window.jzPreferSourceName
      ? window.jzPreferSourceName(svCat?.name, product.title)
      : (product.title || svCat?.name || '');
    let collectImages = (svCat?.images?.length ? svCat.images : product.images) || [];
    let collectMainImage = svCat?.mainImage || product.images?.[0] || getMainImageUrl(product) || undefined;

    // 源富内容(11254):composer 缓存抽取注入 variantData(searchVariants 失败也会
    // 新建 {attributes} 兜底),编辑页预填 + 上架经 _sourceVariant 下发。
    const collectMedia = await fetchVariantGallery(product.url || window.location.pathname, { expectedSku: String(product.sku) });
    if (!collectMedia.images?.length) {
      throw Object.assign(new Error(`SKU ${product.sku} 图册读取失败，请刷新商品页后重试`), {
        code: 'COLLECT_GALLERY_FAILED', retryable: true,
      });
    }
    if (collectMedia.images?.length) {
      collectImages = jzMergeCollectedGalleryImages(collectMedia.images, svCat?.images || []);
      collectMainImage = collectImages[0];
    }
    const collectRichContent = collectMedia.richContent;
    let collectVariantData = jzInjectRichContentAttr(
      variantMatch,
      collectRichContent,
    );
    const contentCopy = window.JZFollowSellContentCopy;
    const sourceCollectDescription = contentCopy?.pickFollowSellDescription
      ? contentCopy.pickFollowSellDescription({
          customDescription: '',
          sourceVariant: collectVariantData || variantMatch,
          richContent: collectRichContent,
          fallbackName: '',
          max: 4096,
        })
      : '';
    const collectDescription = sourceCollectDescription || collectMedia.description || '';
    if (sourceCollectDescription) collectMedia.contentDiagnostics.description = { status: 'provided', source: 'seller_attribute' };
    collectVariantData = { ...(collectVariantData || {}), description: collectDescription,
      videos: collectMedia.videos, color_image: collectMedia.color_image, videoCoverUrl: collectMedia.videoCoverUrl, contentDiagnostics: collectMedia.contentDiagnostics };
    collectVariantData = contentCopy?.mergeSourceDescriptionIntoVariant
      ? contentCopy.mergeSourceDescriptionIntoVariant(
          collectVariantData || variantMatch || {},
          collectDescription,
        )
      : collectVariantData;
    mergeMarketingPriceIntoVariantData(collectVariantData, product);
    const collectHashtags = extractKeywords();
    contentCopy?.mergeSourceHashtagsIntoVariant?.(collectVariantData, collectHashtags);
    const buyerCategoryUrl = currentBuyerCategoryUrl();
    const collectPayload = {
      ...collectSellerEvidence,
      sku: product.sku,
      url: product.url,
      ...(buyerCategoryUrl ? { buyerCategoryUrl } : {}),
      name: collectName || product.title,
      price: product.price != null ? String(product.price) : undefined,
      // 页面币种(CNY/RUB)随价上传 — 后端 provider 据此决定是否 ×汇率,
      // 修跨境店人民币价被当卢布砍 ~12 倍的 bug。探测不到则留空(后端默认按 RUB)。
      priceCurrency: _detectPageCurrency() || undefined,
      originalPrice: product.originalPrice != null ? String(product.originalPrice) : undefined,
      ...buildMarketingPricePayload(product),
      image: collectMainImage,
      images: collectImages.length ? collectImages : undefined,
      description: collectDescription || undefined,
      richContent: collectRichContent || undefined,
      videos: collectMedia.videos,
      videoUrl: collectMedia.videos[0]?.url,
      videoCover: collectMedia.videos[0]?.coverUrl,
      color_image: collectMedia.color_image,
      videoCoverUrl: collectMedia.videoCoverUrl,
      contentDiagnostics: collectMedia.contentDiagnostics,
      sourceCharacteristics: sourceCharacteristics.length ? sourceCharacteristics : undefined,
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
    if (options.captureOnly) return { ok: true, payload: collectPayload, multiVariant: false, total: 1 };
    const collectPromise = collectCoordinator.collect({
      sku: product.sku,
      raw: collectPayload,
    });
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

  async function resolveProductCopySkus(currentSku, onProgress) {
    if (window.ensurePdpState) {
      await Promise.race([window.ensurePdpState(), new Promise(resolve => setTimeout(resolve, 3000))]).catch(() => {});
    }
    if (String(extractProductData()?.sku || '') !== currentSku) throw new Error('商品页面已切换，请重新打开复制窗口');
    return window.JzSkuCopy.resolveSkus({
      currentSku,
      aspects: extractRawAspects(),
      fetchModal: jzFetchAspectsModalVariants,
      onProgress,
      fetchAspects: async (sku, link) => {
        const path = new URL(link || `/product/${sku}/`, location.origin).pathname;
        try {
          const response = await fetch(path, { credentials: 'include', headers: { accept: 'text/html' } });
          if (response.ok) {
            const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
            for (const el of doc.querySelectorAll('[data-state]')) {
              try {
                const data = JSON.parse(el.getAttribute('data-state'));
                if (Array.isArray(data?.aspects) && data.aspects.length) return data.aspects;
              } catch { /* Other widgets are irrelevant. */ }
            }
          }
        } catch { /* SSR unavailable: use the existing buyer-tab state bridge. */ }
        const state = await window.sendMessage('fetchProductPageState', { url: new URL(path, location.origin).href });
        if (state?.fields?.aspects?.length) return state.fields.aspects;
        for (const raw of Object.values(state?.widgetStates || {})) {
          try {
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (Array.isArray(data?.aspects) && data.aspects.length) return data.aspects;
          } catch { /* Other widgets are irrelevant. */ }
        }
        return [];
      },
    });
  }

  function openSkuCopyDialog(follow) {
    if (document.querySelector('.ozon-helper-sku-copy')) return;
    const currentSku = String(extractProductData()?.sku || '');
    const dialog = document.createElement('dialog');
    dialog.className = 'ozon-helper-sku-copy';
    dialog.setAttribute('aria-label', follow ? '复制跟卖 SKU 及销量' : '复制当前商品 SKU');
    dialog.innerHTML = `
      <div class="oh-sku-copy-header"><strong>${follow ? '复制跟卖 SKU 及销量' : '复制当前商品 SKU'}</strong><button type="button" data-copy-close aria-label="关闭">×</button></div>
      ${follow ? `<label>复制范围 <select data-copy-scope><option value="current">仅当前商品</option><option value="all">包含全部多变体</option></select></label>
      <label><input type="checkbox" data-copy-sales> 包含销量（${_escHtml(window.jzSalesPeriodCnLong?.() || '近 30 天')}）</label>` : '<p>当前商品排第一，包含关联多变体，每行一个 SKU。</p>'}
      <p data-copy-status role="status">${follow ? '选择范围后开始复制。销量缺失时留空。' : '正在读取商品 SKU…'}</p>
      <textarea data-copy-preview readonly aria-label="复制内容预览" placeholder="复制内容将在这里显示"></textarea>
      <div class="oh-sku-copy-footer"><button type="button" data-copy-again disabled>复制结果</button><button type="button" data-copy-start>${follow ? '开始复制' : '重新读取并复制'}</button></div>`;
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector('[data-copy-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove());
    const status = dialog.querySelector('[data-copy-status]');
    const preview = dialog.querySelector('[data-copy-preview]');
    const start = dialog.querySelector('[data-copy-start]');
    const again = dialog.querySelector('[data-copy-again]');
    again.addEventListener('click', async () => {
      const ok = await _safeCopy(preview.value);
      again.textContent = ok ? '已复制' : '复制失败，请选择文本手动复制';
    });
    const run = async () => {
      if (start.disabled) return;
      const all = !follow || dialog.querySelector('[data-copy-scope]').value === 'all';
      const includeSales = follow && dialog.querySelector('[data-copy-sales]').checked;
      const period = window.jzGetSalesPeriod?.() || 'monthly';
      const controls = dialog.querySelectorAll('select, input, [data-copy-start]');
      controls.forEach(control => { control.disabled = true; });
      preview.value = '';
      again.disabled = true;
      again.textContent = '复制结果';
      const onProgress = text => {
        if (!dialog.isConnected) throw new Error('复制已取消');
        status.textContent = text;
      };
      try {
        if (!/^\d+$/.test(currentSku)) throw new Error('未获取到当前商品 SKU');
        onProgress('正在读取 SKU…');
        const resolved = all ? await resolveProductCopySkus(currentSku, onProgress) : { skus: [currentSku], warnings: [] };
        const result = follow ? await window.JzSkuCopy.collectFollowSkus({
          skus: resolved.skus, includeSales, period, onProgress,
          fetchSellers: sku => window.jzFetchPublicFollowSell(sku),
          fetchSales: (sku, selectedPeriod) => window.sendMessage('getMarketStats', { sku, period: selectedPeriod }),
        }) : { text: resolved.skus.join('\n'), count: resolved.skus.length, warnings: [], missingSales: 0 };
        if (!dialog.isConnected) return;
        const warnings = [...resolved.warnings, ...result.warnings];
        preview.value = result.text;
        again.disabled = !result.text;
        const copied = result.text ? await _safeCopy(result.text) : false;
        const summary = result.text ? `${copied ? '已复制' : '已读取'} ${result.count} 个 SKU${copied ? '。' : '，请点击「复制结果」或手动复制。'}` : (warnings.length ? '暂未获取到可复制的跟卖 SKU。' : '没有其他跟卖 SKU。');
        status.textContent = summary + (warnings.length ? `结果可能不完整：${warnings.join('；')}。` : '') + (result.missingSales ? `${result.missingSales} 个 SKU 的销量未获取到，已留空；可检查 Seller 登录后重试。` : '');
      } catch (error) {
        status.textContent = error?.message || '读取失败，请重试';
      } finally { controls.forEach(control => { control.disabled = false; }); }
    };
    start.addEventListener('click', run);
    if (!follow) run();
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
    const collectionBadge=document.createElement('span');
    collectionBadge.className='ozon-helper-collection-status';
    collectionBadge.setAttribute('role','status');
    collectionBadge.style.display = 'none';
    let checkingCollection=false;
    const refreshCollectionBadge=async()=>{
      if(checkingCollection || !bar.isConnected)return;
      const gear=document.querySelector('.ozon-helper-sidebar-card-header-actions [data-action="open-field-settings"]');
      if(!gear)return;
      if(collectionBadge.nextElementSibling!==gear)gear.before(collectionBadge);
      const sku=String(extractProductData()?.sku||'');
      if(!/^\d{6,16}$/.test(sku))return;
      checkingCollection=true;
      try{
        const result=await window.sendMessage('getCollectionSkuStatus',{sku});
        if(String(extractProductData()?.sku||'')!==sku)return;
        const label={COLLECTED:'已采集',LISTED:'已采集',AVAILABLE:'未采集'}[result?.status];
        collectionBadge.textContent=label||'';
        collectionBadge.dataset.collected=String(result?.status==='COLLECTED'||result?.status==='LISTED');
        collectionBadge.style.display=label?'inline-flex':'none';
      }catch{collectionBadge.textContent='';collectionBadge.style.display='none';}
      finally{checkingCollection=false;}
    };
    const collectionTimer=setInterval(()=>{if(!bar.isConnected){clearInterval(collectionTimer);window.removeEventListener('focus',refreshCollectionBadge);document.removeEventListener('jz-collection-updated',refreshCollectionBadge);return;}if(!document.hidden)refreshCollectionBadge();},15000);
    setTimeout(refreshCollectionBadge,500);
    window.addEventListener('focus',refreshCollectionBadge);
    document.addEventListener('jz-collection-updated',refreshCollectionBadge);


    const collectBtn = createActionButton(_ICONS.collect, /^zh(?:-|$)/i.test(document.documentElement.lang || '') ? '切换俄语并采集' : '一键采集', async () => {
      if (collectBtn.disabled) return;
      // 采全部变体是多阶段长操作(SSR 展开 + 逐变体抓 sv + 批量推送),进度由
      // collectAllVariants 直接写按钮文案,所以这里不套 showButtonFeedback 的 loading
      // 态(它会在异步进度更新时把按钮"恢复"成过期文案),改为手动存/还原 innerHTML。
      const original = collectBtn.innerHTML;
      collectBtn.disabled = true;
      collectBtn.innerHTML = `<span class="oh-btn-icon">${_lucideSvg('refresh-cw')}</span>采集中...`;
      try {
        const result = await collectAllVariants(collectBtn);
        await refreshCollectionBadge();
        collectBtn.disabled = false;
        collectBtn.innerHTML = original;
        if (result?.dedupeHit) {
          // 24h 内已采集过同 SKU,SW 直接走 cache 没发请求
          showButtonFeedback(collectBtn, 'success', '已存在，跳过重复采集', 2500);
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
    profitBtn.dataset.color = 'indigo';
    sourceBtn.dataset.color = 'amber';
    imageSearchBtn.dataset.color = 'cyan';
    keywordBtn.dataset.color = 'green';

    const erpBtn = createActionButton(_ICONS.erp, '进入ERP', () => {
      window.open('https://www.ozonzongzi.com/ozon/dashboard/', '_blank');
    });
    erpBtn.dataset.color = 'teal';

    // Dividers matching design
    const divider1 = document.createElement('div');
    divider1.className = 'ozon-helper-bar-divider';
    const divider2 = document.createElement('div');
    divider2.className = 'ozon-helper-bar-divider';

    const copyProductSkusBtn = createActionButton(_ICONS.variantSearch, '复制当前商品 SKU', () => openSkuCopyDialog(false));
    const copyFollowSkusBtn = createActionButton(_ICONS.variantSearch, '复制跟卖 SKU 及销量', () => openSkuCopyDialog(true));
    bar.append(divider1, collectBtn, copyProductSkusBtn, copyFollowSkusBtn, publicFollowSellBtn, publicFollowBtn, profitBtn, sourceBtn, imageSearchBtn, keywordBtn, divider2, erpBtn);
    document.body.appendChild(bar);
    if (consumeRussianCollectionResume(extractProductData()?.sku)) {
      setTimeout(() => { if (collectBtn.isConnected) collectBtn.click(); }, 500);
    }
    initBarDrag(bar);
    loadBarPosition().then(pos => applyBarPosition(bar, pos));
    loadBarCollapsed().then(c => {
      if (c) bar.classList.add('is-collapsed');
    });

    // URL hash 触发：从 data panel 的「跟卖」hero 卡 / 一键跟卖按钮跳过来时,
    // /product/xxx#jz-follow-sell 自动唤起跟卖面板

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

    const profitBtn = createActionButton(_ICONS.profit, `${globalThis.__JZ_BRAND__.displayName} 算价`, () =>
      toggleProfitPanel(profitBtn),
    );
    profitBtn.dataset.color = 'indigo';

    const erpBtn = createActionButton(_ICONS.erp, '进入ERP', () => {
      window.open('https://www.ozonzongzi.com/ozon/dashboard/', '_blank');
    });
    erpBtn.dataset.color = 'teal';

    const divider1 = document.createElement('div');
    divider1.className = 'ozon-helper-bar-divider';
    const divider2 = document.createElement('div');
    divider2.className = 'ozon-helper-bar-divider';

    bar.append(divider1, profitBtn, divider2, erpBtn);
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




  // ===== Sidebar Data Card (injected into Ozon right sidebar) =====


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
  // Ozon changes column counts and wraps buy-now in a horizontal row. Find the
  // purchase widget itself, then insert a full-height slot in its vertical flow.
  function sidebarCardMount() {
    const visible = (node) => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && node.getBoundingClientRect().width > 0;
    };
    const buyButtons = Array.from(document.querySelectorAll('[data-widget="webOneClickButton"]'));
    const buyNow = buyButtons.find(node => node.closest('[data-widget="webStickyColumn"]') && visible(node))
      || Array.from(document.querySelectorAll('[data-widget="webStickyColumn"] button')).find(node =>
        /^Купить сейчас$/i.test((node.textContent || '').trim()) && visible(node));
    // Sold-out/older pages may not expose buy-now. Keep the panel next to sale
    // until that widget appears; the observer will then move this same panel.
    const sale = buyNow ? null : Array.from(document.querySelectorAll('[data-widget="webSale"]'))
      .find(node => node.closest('[data-widget="webStickyColumn"]') && visible(node));
    let anchor = buyNow || sale;
    const column = anchor?.closest('[data-widget="webStickyColumn"]');
    if (!column) return null;
    for (let parent = anchor.parentElement; parent; anchor = parent, parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const vertical = style.display === 'block' || style.display === 'flow-root'
        || (style.display === 'flex' && style.flexDirection === 'column');
      if (vertical && !['absolute', 'fixed'].includes(style.position)) {
        return { insertParent: parent, insertAnchor: anchor, before: !!buyNow };
      }
      if (parent === column) break;
    }
    return null;
  }

  function placeSidebarDataCard(card, mount) {
    let slot = card.parentElement?.classList.contains('ozon-helper-sidebar-slot') ? card.parentElement : null;
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'ozon-helper-sidebar-slot';
      slot.appendChild(card);
    }
    let next = mount.before ? mount.insertAnchor : mount.insertAnchor.nextSibling;
    if (next === slot) next = slot.nextSibling;
    if (slot.parentElement !== mount.insertParent || slot.nextSibling !== next) {
      mount.insertParent.insertBefore(slot, next);
    }
    return slot;
  }

  function watchSidebarDataCard(card, sku, pageFacts, initialPageFacts) {
    let frame = null;
    let stopped = false;
    const disconnect = () => {
      stopped = true;
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('popstate', schedule);
      if (frame != null) cancelAnimationFrame(frame);
    };
    const clearCopies = () => {
      document.querySelectorAll('.ozon-helper-sidebar-card').forEach(node => { if (node !== card) node.remove(); });
      document.querySelectorAll('.ozon-helper-sidebar-slot').forEach(node => { if (!node.firstElementChild) node.remove(); });
    };
    const reconcile = () => {
      frame = null;
      if (stopped) return;
      const currentSku = location.pathname.match(/(\d{5,})\/?$/)?.[1];
      if (String(currentSku || '') !== String(sku || '') || (!document.contains(card) && pageFacts
        && pageFacts(extractProductData()) !== initialPageFacts)) {
        disconnect();
        card.parentElement?.classList.contains('ozon-helper-sidebar-slot') ? card.parentElement.remove() : card.remove();
        clearCopies();
        _sidebarCardRetries = 0;
        createSidebarDataCard();
        return;
      }
      const mount = sidebarCardMount();
      if (!mount) return;
      clearCopies();
      placeSidebarDataCard(card, mount);
    };
    const schedule = () => {
      if (!stopped && frame == null) frame = requestAnimationFrame(reconcile);
    };
    // Observe outside the sticky column too: Vue can replace the entire column.
    // Ignore our data fills and section toggles, which do not change the anchor.
    const observer = new MutationObserver(records => {
      if (records.some(record => !card.contains(record.target))) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('resize', schedule);
    window.addEventListener('popstate', schedule);
    return { disconnect };
  }

  function createSidebarDataCard() {
    if (document.querySelector('.ozon-helper-sidebar-card')) {
      _sidebarCardRetries = 0;
      return;
    }
    const mount = sidebarCardMount();
    if (!mount) {
      if (_sidebarCardRetries < 15) {
        _sidebarCardRetries++;
        setTimeout(createSidebarDataCard, 1000);
      }
      return;
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
      placeSidebarDataCard(lockedCard, mount);
      const observer = watchSidebarDataCard(lockedCard, location.pathname.match(/(\d{5,})\/?$/)?.[1]);
      window.jzBindPanelBrandFallback?.(lockedCard);
      lockedCard.querySelector('[data-action="close-sidebar-card"]')?.addEventListener('click', () => {
        observer.disconnect();
        lockedCard.parentElement.remove();
      });
      return;
    }

    let product;
    try {
      product = extractProductData();
    } catch (err) {
      return;
    }
    // Preserve reuse only when the page-derived values are unchanged. Price,
    // stock, rating or follow-seller hydration still gets the existing fresh render.
    const pageFacts = (value) => JSON.stringify([
      value.sku, value.price, value.category, value.brand, value.rating, value.reviewCount,
      value.freeRest, value.followSellCount, value.followSellMinPrice,
      value.statistics?.views, value.statistics?.discount,
      value.characteristics?.weightG, value.characteristics?.lengthCm,
      value.characteristics?.widthCm, value.characteristics?.heightCm,
    ]);
    const initialPageFacts = pageFacts(product);
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
        <div class="ozon-helper-sidebar-card-actions-row">
          <button class="ozon-helper-sidebar-card-btn" data-action="edit-list"><span class="oh-btn-icon">${_lucideSvg('pencil')}</span>编辑上架</button>
          <button class="ozon-helper-sidebar-card-btn" data-action="collect-one"><span class="oh-btn-icon">${_lucideSvg('inbox')}</span>采集</button>
        </div>
      </div>
    `;

    placeSidebarDataCard(card, mount);
    const cardObserver = watchSidebarDataCard(card, product.sku, pageFacts, initialPageFacts);
    window.jzBindPanelBrandFallback?.(card);
    card.querySelector('[data-action="close-sidebar-card"]').addEventListener('click', () => {
      cardObserver.disconnect();
      card.parentElement.remove();
    });
    // 字段设置齿轮:打开显隐设置弹窗(保存后对全站数据卡生效)。
    card.querySelector('[data-action="open-field-settings"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      window.jzOpenFieldSettings?.(card);
    });
    // 标记为数据卡 + 应用当前字段显隐(默认全显;用户关过的字段隐藏)。
    card.setAttribute('data-jz-datacard', '1');
    window.jzLoadFieldVisibility?.().then((v) => window.jzApplyFieldVisibility?.(card, v));
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
        // 会把 `https://www.ozonzongzi.com/api` 中的 `://api` 后 4 字符 `/api` 误删,
        // 得到 `https:/.jizhangerp.com` 这个残缺 URL,浏览器按相对路径解析 →
        // 拼到 ozon.ru 域名下变成 `https://www.ozon.ru/.jizhangerp.com/...`。
        const frontendUrl = 'https://www.ozonzongzi.com';
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
      btn.disabled = true;
      btn.innerHTML = `<span class="oh-btn-icon">${_lucideSvg('refresh-cw')}</span>采集中…`;
      try {
        // PDP 侧栏数据卡片跟 action bar 上的「一键采集」在同一个 PDP 页、同一份页面
        // 状态,复用同一个 collectAllVariants() — 采当前商品的所有变体 SKU,进度写在
        // 该按钮上;单/无变体页内部自动委托单采。
        const result = await collectAllVariants(btn);
        document.dispatchEvent(new Event('jz-collection-updated'));
        btn.classList.add('is-collected');
        const label = result?.dedupeHit ? '近期已采集' : '已采集';
        btn.innerHTML = `<span class="oh-btn-icon">✓</span>${label}`;
        setTimeout(() => {
          btn.classList.remove('is-collected');
          btn.innerHTML = originalHtml;
          btn.disabled = false;
          collectInFlight = false;
        }, result?.multiVariant ? 2800 : 1800);
      } catch (err) {
        console.warn('[ozon-helper] sidebar collect-one failed:', err);
        const friendly = productCollectFailurePresentation(err);
        btn.innerHTML = `<span class="oh-btn-icon">${_lucideSvg('alert-triangle')}</span>${friendly}`;
        setTimeout(() => {
          btn.innerHTML = originalHtml;
          btn.disabled = false;
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
      showMvStatus(statusDiv, 'error', '模拟手动上架仅支持单店,请只选择一个已登录所选 Seller 线路的店铺');
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
        [/executeScript 未返回结果|bridge 返回错误|seller portal/i, 'Seller 页面通讯失败，请刷新该页签后重试'],
        [/sc_company_id|cookie已过期|请先登录|seller\.ozon\.ru/i, '请确认已登录所选 Seller 线路'],
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
          `门户上架完成！已通过卖家中心创建 ${totalCreated} 个商品 → ${okStores.length} 个店铺。可在所选 Seller 线路的商品列表查看。`);
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
  function jzExtractRichContentFromStates(states, expectedSku = '') {
    if (!states || typeof states !== 'object') return '';
    const candidates = [];
    const seenJson = new Set();
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
    // Only a product description's explicit Rich document is source evidence.
    // Nested recommendations can contain larger Rich documents from other SKUs.
    for (const [key, raw] of Object.entries(states)) {
      if (!/^(?:state-)?(?:webDescription|webRichContent|description)(?:-|$)/i.test(key)) continue;
      const parsed = jzParseMaybeJson(raw);
      if (!parsed || typeof parsed !== 'object') continue;
      if (expectedSku && parsed.sku && String(parsed.sku) !== String(expectedSku)) continue;
      addCandidate(jzParseMaybeJson(parsed.richAnnotationJson), parsed.richAnnotationJson);
      if (jzIsRichContentDoc(parsed)) addCandidate(parsed, typeof raw === 'string' ? raw : null);
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.json || '';
  }

  // 商品 webDescription 的原始 HTML 描述与 11254 JSON 分开保存；不遍历推荐/复制摘要。
  function jzExtractSourceDescriptionFromStates(states, expectedSku = '') {
    let description = '';
    for (const [key, raw] of Object.entries(states || {})) {
      if (!/^(?:state-)?webDescription(?:-|$)/i.test(key)) continue;
      const state = jzParseMaybeJson(raw);
      if (!state || typeof state !== 'object') continue;
      if (expectedSku && state.sku && String(state.sku) !== String(expectedSku)) continue;
      if (String(state.richAnnotationType || '').toUpperCase() !== 'HTML') continue;
      const html = state.richAnnotation;
      if (typeof html === 'string' && html.trim() && html.length > description.length) description = html;
    }
    return description;
  }

  // Only Product nodes with an exact SKU can supply ordinary Russian description.
  // @graph is JSON-LD structure; recommendations and nested arbitrary objects are not.
  function jzReadProductJsonLd(doc, expectedSku) {
    let status = 'unverified';
    let message = '';
    const products = [];
    const visit = value => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== 'object') return;
      const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
      if (types.some(type => /(?:^|[/#])Product$/.test(String(type)))) products.push(value);
      if (Array.isArray(value['@graph'])) visit(value['@graph']);
    };
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(script.textContent)); }
      catch { status = 'read_failed'; message = 'Product JSON-LD 解析失败'; }
    }
    const product = products.find(value => String(value.sku || '') === String(expectedSku));
    if (product && status !== 'read_failed') status = 'not_provided';
    else if (!product && products.length && status !== 'read_failed') message = 'Product JSON-LD 不属于当前 SKU';
    const description = typeof product?.description === 'string' ? product.description.trim() : '';
    if (description) {
      if (!/[А-Яа-яЁё]/.test(description) || /[\u3400-\u9fff]/.test(description)) {
        return { description: '', status: 'read_failed', source: 'json_ld', message: '同 SKU 简介不是俄语原文，请切换俄语后重试' };
      }
      return { description, status: 'provided', source: 'json_ld' };
    }
    return { description: '', status, source: 'json_ld', ...(message ? { message } : {}) };
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

  function jzExtractVariantPriceFromStates(states) {
    for (const [key, raw] of Object.entries(states || {})) {
      if (!/^webPrice(?:-|$)/i.test(key)) continue;
      const state = jzParseMaybeJson(raw);
      if (!state || typeof state !== 'object') continue;
      const blackRaw = state.price ?? state.cardPrice;
      const greenRaw = state.cardPrice ?? state.price;
      const black = window.jzParseOzonPriceNumber?.(blackRaw);
      const green = window.jzParseOzonPriceNumber?.(greenRaw);
      const currency = window.jzDetectOzonMoneyCurrency?.(blackRaw);
      const greenCurrency = window.jzDetectOzonMoneyCurrency?.(greenRaw);
      if (!(black > 0) || !(green > 0) || green > black || !['CNY', 'RUB'].includes(currency) || currency !== greenCurrency) continue;
      return { blackPrice: black.toFixed(2), greenPrice: green.toFixed(2),
        blackPriceCurrency: currency, greenPriceCurrency: currency };
    }
    return {};
  }

  // 只保存公开视频源及封面；Seller 转存由既有授权流程处理。
  function jzExtractGalleryVideos(gallery, expectedSku = '') {
    if (expectedSku && gallery?.sku && String(gallery.sku) !== String(expectedSku)) return [];
    const videos = new Map();
    for (const raw of Array.isArray(gallery?.videos) ? gallery.videos : []) {
      const media = window.JZOzonVideoExtract?.extractOzonVideoFromSources([raw]);
      if (!media?.mp4 || videos.has(media.mp4)) continue;
      videos.set(media.mp4, { url: media.mp4, ...(media.cover ? { coverUrl: media.cover } : {}),
        ...(typeof raw.isCoverAutoPlayOn === 'boolean' ? { isCoverAutoPlayOn: raw.isCoverAutoPlayOn } : {}),
      });
    }
    return [...videos.values()];
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
   * Returns { images, richContent, description, videos, pricing }：同一 SKU 的完整媒体、源描述及黑标/绿标价格。
   */
  async function fetchVariantGallery(variantLink, { imagesOnly = false, expectedSku = '' } = {}) {
    if (!variantLink) return { images: [], richContent: '', description: '', videos: [] };
    let path = variantLink;
    try {
      if (/^https?:\/\//i.test(path)) {
        const u = new URL(path);
        path = u.pathname + u.search;
      }
    } catch {}
    if (!path.startsWith('/')) path = '/' + path;
    const pathSku = jzOzonProductId(path);
    if (expectedSku && pathSku !== String(expectedSku)) return { images: [], richContent: '', description: '', videos: [] };
    expectedSku = String(expectedSku || pathSku);
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
      typeof u === 'string' && /(?:ozone\.ru|ozonstatic\.cn)\//.test(u)
        ? u.replace(/\/wc\d+\//, '/wc1000/')
        : u;
    const norm = (u) => String(u || '').split('?')[0].split('#')[0].toLowerCase();

    let richContent = '';
    let description = '';
    let richContentHasText = false;
    let bestGallery = [];
    let pricing = {};
    const videos = new Map();
    let color_image;
    let videoCoverUrl;
    let coverUnverified = false;
    let galleryRead = false;
    let descriptionRead = false;
    let videosUnverified = false;
    const issues = [];
    const noteFailure = (field, message) => {
      if (!issues.some(issue => issue.field === field && issue.message === message)) issues.push({ field, message });
    };
    let descriptionEvidence;
    const result = () => ({
      images: bestGallery, richContent, description, videos: [...videos.values()], pricing,
      color_image, videoCoverUrl,
      contentDiagnostics: {
        description: descriptionEvidence ? { status: descriptionEvidence.status, source: descriptionEvidence.source, ...(descriptionEvidence.message ? { message: descriptionEvidence.message } : {}) }
          : { status: description ? 'provided' : 'not_provided', source: 'web_description' },
        richContent: { status: richContent ? 'provided' : issues.some(issue => issue.field === 'richContent' || (issue.field === 'page' && !descriptionRead)) ? 'read_failed' : descriptionRead ? 'not_provided' : 'unverified',
          ...(issues.length && !richContent ? { message: issues.map(issue => issue.message).join('；') } : {}) },
        videos: { status: videos.size ? 'provided' : videosUnverified ? 'unverified' : !galleryRead && issues.some(issue => issue.field === 'page') ? 'read_failed' : galleryRead ? 'not_provided' : 'unverified' },
        color_image: { status: color_image ? 'provided' : issues.some(issue => issue.field === 'color_image') ? 'unverified' : !galleryRead && issues.some(issue => issue.field === 'page') ? 'read_failed' : galleryRead ? 'not_provided' : 'unverified', source: 'webGallery.color_image' },
        videoCoverUrl: { status: videoCoverUrl ? 'provided' : coverUnverified ? 'unverified' : !galleryRead && issues.some(issue => issue.field === 'page') ? 'read_failed' : galleryRead ? 'not_provided' : 'unverified', source: 'webGallery.videoCover' },
        ...(issues.length ? { issues } : {}),
      },
    });
    const consumeStates = (states, { cached = false } = {}) => {
      // 先核对 gallery SKU；重定向到其他商品时，其富内容也不能归到请求 SKU。
      let bestImages = [];
      let bestCover = null;
      let matchingGallery = false;
      let foreignGallery = false;
      let matchingDescription = false;
      for (const k of Object.keys(states)) {
        let v = states[k];
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch {
          if (/^(?:state-)?webDescription(?:-|$)/i.test(k)) {
            noteFailure('richContent', `商品组件 ${k} 解析失败`);
            noteFailure('description', `商品组件 ${k} 解析失败`);
          } else if (/^(?:state-)?webGallery(?:-|$)/i.test(k)) noteFailure('page', `商品组件 ${k} 解析失败`);
          continue;
        } }
        if (!imagesOnly && /^(?:state-)?webDescription(?:-|$)/i.test(k) && v && typeof v === 'object'
          && (!v.sku || String(v.sku) === expectedSku)) {
          if (!cached) matchingDescription = true;
          if (typeof v.richAnnotationJson === 'string' && v.richAnnotationJson) {
            try { JSON.parse(v.richAnnotationJson); } catch { noteFailure('richContent', 'Rich JSON 解析失败'); }
          }
        }
        if (!v || typeof v !== 'object') continue;
        if (!/^(?:state-)?webGallery(?:-|$)/i.test(k)) continue;
        if (expectedSku && v.sku && String(v.sku) !== expectedSku) {
          foreignGallery = true;
          continue;
        }
        matchingGallery = true;
        if (!cached) galleryRead = true;
        if (!imagesOnly && String(v.sku || '') === expectedSku) {
          // Explicit fields only. Aspect thumbnails and autoplay flags do not establish these uses.
          if (v.color_image) {
            try {
              const candidate = typeof v.color_image === 'string' ? v.color_image.trim() : '';
              const url = new URL(candidate);
              if (!/^https?:[/][/]/i.test(candidate) || /\s/u.test(candidate)
                || !['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
              color_image ||= candidate;
            } catch { noteFailure('color_image', '源颜色样本链接无效，请编辑补充'); }
          }
          const cover = v.videoCover?.url;
          let validCover = false;
          try { const url = new URL(cover); validCover = ['https:', 'http:'].includes(url.protocol) && /\.(mp4|mov)$/i.test(url.pathname); } catch {}
          if (validCover) videoCoverUrl ||= cover;
          else if (v.videoCover) coverUnverified = true;
        }
        if (!imagesOnly) {
          const extracted = jzExtractGalleryVideos(v, expectedSku);
          if (v.videos && (!Array.isArray(v.videos) || (v.videos.length && !extracted.length))) videosUnverified = true;
          for (const video of extracted) if (!videos.has(video.url)) videos.set(video.url, video);
        }
        if (Array.isArray(v.images) && v.images.length > bestImages.length) {
          bestImages = v.images;
          bestCover = v.coverImage || null;
        }
      }
      if (foreignGallery && !matchingGallery) { noteFailure('page', '返回图册不属于请求 SKU'); return false; }
      if (matchingDescription) descriptionRead = true;
      if (!imagesOnly && !pricing.blackPrice) pricing = jzExtractVariantPriceFromStates(states);
      const candidateDescription = imagesOnly ? '' : jzExtractSourceDescriptionFromStates(states, expectedSku);
      if (candidateDescription && (candidateDescription.length > description.length || descriptionEvidence?.source === 'json_ld')) {
        description = candidateDescription;
        if (descriptionEvidence?.status === 'read_failed' && descriptionEvidence.message) noteFailure('description', descriptionEvidence.message);
        descriptionEvidence = { status: 'provided', source: 'web_description' };
      }
      if (!imagesOnly && !cached) for (const nextPage of jzCollectOzonRichContentPagePaths(states, path)) enqueuePath(nextPage);
      const candidateRichContent = imagesOnly ? '' : jzExtractRichContentFromStates(states, expectedSku);
      if (candidateRichContent) {
        const candidateHasText = jzRichContentHasText(candidateRichContent);
        if (!richContent || (!richContentHasText && candidateHasText)) {
          richContent = candidateRichContent;
          richContentHasText = candidateHasText;
        }
      }
      if (bestImages.length > 0) {
        const seen = new Set();
        const out = [];
        const push = (raw) => {
          const value = typeof raw === 'string' ? raw : (raw?.src || raw?.url || raw?.image);
          if (typeof value !== 'string') return;
          const upgraded = upgrade(value);
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
          if (imagesOnly) { bestGallery = out; return true; }
          if (out.length > bestGallery.length) bestGallery = out;
          if (richContent && description && richContentHasText) {
            return true;
          }
        }
      } else {
        console.warn('[fetchVariantGallery] No images in widgetStates', path, 'totalKeys=', Object.keys(states).length);
      }
      return false;
    };
    for (let i = 0; i < endpointQueue.length; i += 1) {
      const url = endpointQueue[i];
      try {
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { 'x-o3-app-name': 'dweb_client', 'accept': 'application/json' },
        });
        if (!resp.ok) throw new Error(`商品资料请求 HTTP ${resp.status || 'ERROR'}`);
        const data = await resp.json();
        if (!data?.widgetStates || typeof data.widgetStates !== 'object') throw new Error('商品资料缺少 widgetStates');
        if (consumeStates(data.widgetStates)) break;
      } catch (e) {
        noteFailure(url.includes('layout_container') || decodeURIComponent(url).includes('layout_container') ? 'richContent' : 'page', e?.message || '商品资料网络读取失败');
      }
    }
    if (!imagesOnly && !description) {
      // Reuse only the current SKU's document. Siblings need their own public HTML.
      const currentSku = jzOzonProductId(window.location.pathname);
      if (currentSku === expectedSku) descriptionEvidence = jzReadProductJsonLd(document, expectedSku);
      if (!descriptionEvidence?.description) {
        try {
          const resp = await fetch(path, { credentials: 'include', headers: { accept: 'text/html' } });
          if (!resp.ok) throw new Error(`简介页面 HTTP ${resp.status || 'ERROR'}`);
          const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
          descriptionEvidence = jzReadProductJsonLd(doc, expectedSku);
        } catch (error) {
          descriptionEvidence = { description: '', status: 'read_failed', source: 'json_ld', message: error?.message || '简介网络读取失败' };
        }
      }
      description = descriptionEvidence.description;
    }
    if (!imagesOnly && jzOzonProductId(window.location.pathname) === expectedSku) {
      const cachedGallery = window.extractStateData?.('state-webGallery');
      // A cache for another SKU must not supply descriptions or media after navigation.
      if (!cachedGallery?.sku || String(cachedGallery.sku) === expectedSku) {
        const cachedStates = window.ensurePdpState ? await window.ensurePdpState().catch(() => null) : null;
        consumeStates({ ...(cachedStates || {}),
          ...(String(cachedGallery?.sku || '') === expectedSku ? { 'state-webGallery': cachedGallery } : {}),
        }, { cached: true });
      }
    }
    if (!description && issues.some(issue => ['page', 'richContent', 'description'].includes(issue.field))) {
      descriptionEvidence = { status: 'read_failed', source: 'web_description', message: issues.map(issue => issue.message).join('；') };
    } else if (!description && descriptionRead && descriptionEvidence?.status === 'unverified' && !descriptionEvidence.message) {
      descriptionEvidence = { status: 'not_provided', source: 'web_description' };
    }
    return result();
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
          NO_SELLER_TAB: '请先打开所选 Seller 线路并登录,然后重试',
          PERMISSION_DENIED: '浏览器未授予插件访问所选 Seller 线路的权限。请在扩展管理页面点击本插件的"详细信息",将"网站访问权限"设为"在所有网站上",然后刷新页面重试',
          AUTH_REQUIRED: '卖家中心登录已过期,请重新登录所选 Seller 线路 后重试',
          ANTIBOT_BLOCKED: '卖家中心触发反爬验证,请在 所选 Seller 线路页面刷新后重试',
          TIMEOUT: '卖家中心请求超时,请检查网络或刷新所选 Seller 线路页面',
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

  /**
   * Poll Ozon import task status until completion or timeout.
   * Returns 'success' if all items imported, otherwise shows error and returns 'error'.
   */


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
