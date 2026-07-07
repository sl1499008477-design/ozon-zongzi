// 极掌采集器 — IndexedDB 持久化层 (v2)
//
// database 'jzCollector' v2: sales / keywords / sessions / failures
//
// stores:
//   sales      keyPath='sku'              indexes: keyword, collectedAt, status
//   keywords   keyPath='id' (auto)        indexes: status
//   sessions   keyPath='key' (常量)
//   failures   keyPath='taskId'           indexes: keyword
//
// API:
//   sales:    putSale, putSaleBatch, getSale, getAllSales, countSales, markPushed,
//             deleteSale, clearSales, exportCsv
//   keywords: addKeywords, getKeywords, getNextPendingKeyword, updateKeyword,
//             removeKeyword, clearKeywords
//   sessions: setSession, getSession, clearSession
//   failures: addFailure, getFailures, removeFailure, clearFailures
//   util:     init, onChange (BroadcastChannel 跨 tab 同步)

(() => {
  if (window.JZCollectorDB && window.JZCollectorDB._v2) return;

  const DB_NAME = 'jzCollector';
  const DB_VERSION = 2;
  const STORE_SALES = 'sales';
  const STORE_KEYWORDS = 'keywords';
  const STORE_SESSIONS = 'sessions';
  const STORE_FAILURES = 'failures';
  const FX_RUB_PER_CNY_FALLBACK = 11.5;

  let _db = null;
  let _initPromise = null;
  let _channel = null;
  let _fxRubPerCny = FX_RUB_PER_CNY_FALLBACK;
  const _changeListeners = new Set();

  function _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_SALES)) {
          const store = db.createObjectStore(STORE_SALES, { keyPath: 'sku' });
          store.createIndex('keyword', 'keyword', { unique: false });
          store.createIndex('collectedAt', 'collectedAt', { unique: false });
          store.createIndex('status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_KEYWORDS)) {
          const store = db.createObjectStore(STORE_KEYWORDS, { keyPath: 'id', autoIncrement: true });
          store.createIndex('status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          db.createObjectStore(STORE_SESSIONS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_FAILURES)) {
          const store = db.createObjectStore(STORE_FAILURES, { keyPath: 'taskId' });
          store.createIndex('keyword', 'keyword', { unique: false });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function init() {
    if (_db) return _db;
    if (!_initPromise) {
      _initPromise = _open().then((db) => {
        _db = db;
        try {
          _channel = new BroadcastChannel('jz-collector');
          _channel.addEventListener('message', (ev) => {
            if (!ev.data || !ev.data.type) return;
            for (const cb of _changeListeners) {
              try { cb(ev.data); } catch (e) { console.error('[JZCollectorDB] listener error:', e); }
            }
          });
        } catch (e) {
          console.warn('[JZCollectorDB] BroadcastChannel unavailable:', e);
        }
        return db;
      });
    }
    return _initPromise;
  }

  function _broadcast(payload) {
    for (const cb of _changeListeners) {
      try { cb(payload); } catch (e) { console.error('[JZCollectorDB] listener error:', e); }
    }
    if (_channel) {
      try { _channel.postMessage(payload); } catch (e) { /* swallow */ }
    }
  }

  function _store(name, mode = 'readonly') {
    return _db.transaction([name], mode).objectStore(name);
  }

  function _wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // ─── sales ─────────────────────────────────────────────
  function _filled(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
  }

  function _preserveMissing(next, existing, keys) {
    if (!existing) return next;
    for (const key of keys) {
      if (!_filled(next[key]) && _filled(existing[key])) next[key] = existing[key];
    }
    return next;
  }

  function _priceSourceRank(source) {
    const key = String(source || '').trim().toLowerCase();
    if (key === 'pdp' || key === 'detail') return 3;
    if (key === 'card' || key === 'list' || key === 'search') return 1;
    return 0;
  }

  function _recordPriceSource(record, sourceKey) {
    const raw = record?.raw && typeof record.raw === 'object' ? record.raw : null;
    return raw?.[sourceKey] || record?.[sourceKey] || '';
  }

  function _preserveHigherSource(next, existing, sourceKey, keys) {
    if (!existing) return next;
    const existingRank = _priceSourceRank(_recordPriceSource(existing, sourceKey));
    const nextRank = _priceSourceRank(_recordPriceSource(next, sourceKey));
    if (existingRank <= nextRank) return next;
    for (const key of keys) {
      if (_filled(existing[key])) next[key] = existing[key];
    }
    return next;
  }

  function _mergeSaleRecord(existing, record) {
    if (!existing) return record;
    const next = { ...record };
    _preserveMissing(next, existing, [
      'keyword',
      'hashtags',
      '_aiHashtags',
      'marketingPrice',
      'marketingPriceCurrency',
      'blackPrice',
      'blackPriceCurrency',
      'greenPrice',
      'greenPriceCurrency',
    ]);
    _preserveHigherSource(next, existing, '_marketingPriceSource', [
      'marketingPrice',
      'marketingPriceCurrency',
      'blackPrice',
      'blackPriceCurrency',
    ]);
    _preserveHigherSource(next, existing, '_greenPriceSource', [
      'greenPrice',
      'greenPriceCurrency',
    ]);
    const existingRaw = existing.raw && typeof existing.raw === 'object' ? existing.raw : null;
    const nextRaw = next.raw && typeof next.raw === 'object' ? next.raw : null;
    if (existingRaw || nextRaw) {
      const mergedRaw = { ...(existingRaw || {}), ...(nextRaw || {}) };
      _preserveMissing(mergedRaw, existingRaw, [
        'marketingPrice',
        'marketingPriceCurrency',
        'blackPrice',
        'blackPriceCurrency',
        'greenPrice',
        'greenPriceCurrency',
        'keyword',
        'searchKeyword',
        'hashtags',
        '_aiHashtags',
        'aiHashtags',
        'sourceHashtags',
        'marketingPriceCny',
        'blackPriceCny',
      ]);
      _preserveHigherSource(mergedRaw, existingRaw, '_marketingPriceSource', [
        'marketingPrice',
        'marketingPriceCurrency',
        'blackPrice',
        'blackPriceCurrency',
        'marketingPriceCny',
        'blackPriceCny',
        '_marketingPriceSource',
      ]);
      _preserveHigherSource(mergedRaw, existingRaw, '_greenPriceSource', [
        'greenPrice',
        'greenPriceCurrency',
        'greenPriceCny',
        '_greenPriceSource',
      ]);
      next.raw = Object.keys(mergedRaw).length ? mergedRaw : null;
    }
    return next;
  }

  async function putSale(record) {
    await init();
    if (!record || !record.sku) throw new Error('sku required');
    if (!record.collectedAt) record.collectedAt = Date.now();
    if (!record.status) record.status = 'local';
    let existing = null;
    try { existing = await _wrap(_store(STORE_SALES).get(record.sku)); } catch {}
    record = _mergeSaleRecord(existing, record);
    await _wrap(_store(STORE_SALES, 'readwrite').put(record));
    _broadcast({ type: 'sale-changed', skus: [record.sku] });
    return record;
  }

  async function putSaleBatch(records) {
    await init();
    if (!records || records.length === 0) return [];
    const tx = _db.transaction([STORE_SALES], 'readwrite');
    const store = tx.objectStore(STORE_SALES);
    const skus = [];
    for (const r of records) {
      if (!r || !r.sku) continue;
      if (!r.collectedAt) r.collectedAt = Date.now();
      if (!r.status) r.status = 'local';
      const req = store.get(r.sku);
      req.onsuccess = () => {
        store.put(_mergeSaleRecord(req.result, r));
      };
      skus.push(r.sku);
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
      tx.onabort = (e) => reject(e.target.error);
    });
    _broadcast({ type: 'sale-changed', skus });
    return skus;
  }

  async function getSale(sku) {
    await init();
    return _wrap(_store(STORE_SALES).get(sku));
  }

  async function getAllSales(opts = {}) {
    await init();
    const store = _store(STORE_SALES);
    if (opts.status) {
      return _wrap(store.index('status').getAll(opts.status));
    }
    return _wrap(store.getAll());
  }

  // 走 collectedAt 索引拉时间窗口内的 sale,避免 getAllSales 把整桶载入内存。
  // sales 桶在长期使用后可能上万行,getAll() 一次 deserialize 全量很重;
  // 配合 IDBKeyRange.lowerBound 走 collectedAt 索引游标,IDB 只 yield 命中
  // 区间的行。
  //
  // 注意:`collectedAt` 索引会自动跳过该字段为 null/undefined 的行,所以
  // 老/坏数据(没有 collectedAt 的 row)天然被滤掉 — 不会污染窗口统计。
  async function getSalesSince(sinceTs, opts = {}) {
    await init();
    if (typeof sinceTs !== 'number' || !isFinite(sinceTs)) {
      throw new Error('getSalesSince: sinceTs must be a finite number (ms epoch)');
    }
    const limit = Math.max(1, Math.min(500_000, opts.limit || 500_000));
    const store = _store(STORE_SALES);
    const idx = store.index('collectedAt');
    const range = IDBKeyRange.lowerBound(sinceTs);
    return new Promise((resolve, reject) => {
      const out = [];
      const req = idx.openCursor(range);
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur && out.length < limit) {
          out.push(cur.value);
          cur.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function countSales(opts = {}) {
    await init();
    const store = _store(STORE_SALES);
    if (opts.status) {
      return _wrap(store.index('status').count(opts.status));
    }
    return _wrap(store.count());
  }

  async function markPushed(skus) {
    await init();
    if (!skus || skus.length === 0) return 0;
    const tx = _db.transaction([STORE_SALES], 'readwrite');
    const store = tx.objectStore(STORE_SALES);
    let count = 0;
    const readRecord = (key) => new Promise((resolve, reject) => {
      const r = store.get(key);
      r.onsuccess = (e) => resolve(e.target.result);
      r.onerror = (e) => reject(e.target.error);
    });
    for (const sku of skus) {
      let existing = await readRecord(sku);
      if (!existing && typeof sku === 'string' && sku.trim() !== '') {
        const numericKey = Number(sku);
        if (Number.isFinite(numericKey) && String(numericKey) === sku) {
          existing = await readRecord(numericKey);
        }
      }
      if (existing) {
        existing.status = 'pushed';
        existing.pushedAt = Date.now();
        store.put(existing);
        count++;
      }
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
    _broadcast({ type: 'sale-changed', skus });
    return count;
  }

  async function deleteSale(sku) {
    await init();
    await _wrap(_store(STORE_SALES, 'readwrite').delete(sku));
    _broadcast({ type: 'sale-changed', skus: [sku] });
  }

  async function clearSales() {
    await init();
    await _wrap(_store(STORE_SALES, 'readwrite').clear());
    _broadcast({ type: 'sale-changed', skus: [], cleared: true });
  }

  // ─── CSV 导出（流式） ───────────────────────────────────
  // 字段顺序固定，与 sales record 对齐
  const CSV_FIELDS = [
    { key: 'image', label: '主图' },
    { key: 'sku', label: 'SKU' },
    { key: 'name', label: '商品名' },
    { key: 'price', label: '当前价(¥)' },
    { key: 'marketingPrice', label: '黑标价(¥)' },
    { key: 'soldCount', label: '月销量' },
    { key: 'gmvSumCny', label: '月销售额(¥)' },
    { key: 'brandName', label: '品牌' },
    { key: 'shippingMode', label: '发货模式' },
    { key: 'weight', label: '重量(g)' },
    { key: 'listedDays', label: '上架时间(天)' },
    { key: 'monthlyTurnoverDynamic', label: '月周转动态(%)' },
    { key: 'adCostRatio', label: '广告费占比(%)' },
    { key: 'promoDays', label: '参与促销天数' },
    { key: 'promoDiscount', label: '参与促销折扣(%)' },
    { key: 'promoConversionRate', label: '促销活动转化率(%)' },
    { key: 'paidPromotionDays', label: '付费推广天数' },
    { key: 'views', label: '商品卡浏览量' },
    { key: 'cardAddToCartRate', label: '商品卡加购率(%)' },
    { key: 'searchCatalogViews', label: '搜索目录浏览量' },
    { key: 'searchCatalogAddToCartRate', label: '搜索目录加购率(%)' },
    { key: 'displayConversionRate', label: '展示转化率(%)' },
    { key: 'returnCancelRate', label: '退货取消率(%)' },
    { key: 'followerCount', label: '跟卖人数' },
    { key: 'lowestFollowerPrice', label: '跟卖最低价(¥)' },
    { key: 'discount', label: '折扣(%)' },
    { key: 'keyword', label: '关键词' },
    { key: 'url', label: 'URL' },
    { key: 'status', label: '状态' },
    { key: 'collectedAt', label: '采集时间' },
  ];

  function _csvEscape(v) {
    if (v == null) return '';
    let s = String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function _firstValue(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }

  function _normalizeHashtagList(...values) {
    const out = [];
    const seen = new Set();
    const push = (value) => {
      if (value === undefined || value === null) return;
      if (Array.isArray(value)) {
        for (const item of value) push(item);
        return;
      }
      if (typeof value === 'object') {
        push(_firstValue(value.value, value.text, value.name, value.title));
        return;
      }
      const text = String(value).replace(/\u00a0/g, ' ').trim();
      if (!text) return;
      const matches = text.match(/#[\p{L}\p{N}_]+/gu) || [];
      for (const rawTag of matches) {
        const tag = rawTag.trim();
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
      }
    };
    for (const value of values) push(value);
    return out;
  }

  function _hashtagAttrText(source) {
    const attrs = Array.isArray(source?.attributes) ? source.attributes : [];
    const attr = attrs.find((item) => String(item?.key ?? item?.id) === '23171');
    if (!attr) return null;
    return _firstValue(attr.value, attr.text, attr.name, attr.title, attr.values, attr.collection);
  }

  function _resolveHashtagKeyword(rec) {
    const raw = rec?.raw || {};
    const variantMatch = _variantMatchFromRecord(rec);
    const tags = _normalizeHashtagList(
      rec?.hashtags,
      rec?._aiHashtags,
      raw.hashtags,
      raw._aiHashtags,
      raw.aiHashtags,
      raw.sourceHashtags,
      raw.ozonHashtags,
      _hashtagAttrText(raw.variantData),
      _hashtagAttrText(rec?.variantData),
      _hashtagAttrText(variantMatch),
    );
    return tags.length ? tags.join(' ') : null;
  }

  function _toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value).replace(/\u00a0/g, ' ').trim();
    if (!text || text === '-' || text === '\u2014') return null;
    const compact = text.replace(/\s+/g, '');
    const match = compact.match(/[-+]?\d+(?:[,.]\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0].replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function _daysSince(value) {
    if (!value) return null;
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return null;
    return Math.max(0, Math.floor((Date.now() - time) / 86400000));
  }

  function _daysValue(...values) {
    for (const value of values) {
      if (value === null || value === undefined || value === '') continue;
      if (typeof value === 'number') {
        if (Number.isFinite(value)) return value;
        continue;
      }
      const text = String(value).replace(/\u00a0/g, ' ').trim();
      if (!text || text === '-' || text === '\u2014') continue;
      const dayMatch = text.match(/(\d+)\s*(?:天|days?|дн)/i);
      if (dayMatch) return Number(dayMatch[1]);
      const dateMatch = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
      if (dateMatch) {
        const days = _daysSince(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`);
        if (days !== null) return days;
        continue;
      }
      const num = _toNumber(text);
      if (num !== null) return num;
    }
    return null;
  }

  function _extractCny(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value || '').replace(/\u00a0/g, ' ').trim();
    if (!text || text === '-' || text === '\u2014') return null;
    const match = text.replace(/\s+/g, '').match(/[\u00A5\uFFE5]\s*([-+]?\d+(?:[,.]\d+)?)/);
    if (!match) return null;
    const parsed = Number(match[1].replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function _currencyFromMoneyText(value) {
    const text = String(value || '').toUpperCase();
    if (!text) return null;
    if (/[\u20BD₽]/.test(text) || /\bRUB\b|\bRUR\b/.test(text) || /РУБ/i.test(text)) return 'RUB';
    if (/[\u00A5\uFFE5¥￥]/.test(text) || /\bCNY\b|\bRMB\b/.test(text) || /人民币|元/.test(text)) return 'CNY';
    return null;
  }

  function _moneyToCny(value, currency) {
    const n = _toNumber(value);
    if (n === null) return null;
    const code = String(currency || _currencyFromMoneyText(value) || '').trim().toUpperCase();
    if (code === 'CNY' || code === 'RMB') return n;
    const rate = _fxRubPerCny > 0 ? _fxRubPerCny : FX_RUB_PER_CNY_FALLBACK;
    return n / rate;
  }

  async function _refreshExportFxRate() {
    const sendMessage = globalThis.chrome?.runtime?.sendMessage;
    if (typeof sendMessage !== 'function') return _fxRubPerCny;
    try {
      const resp = await new Promise((resolve) => {
        try {
          sendMessage.call(chrome.runtime, { action: 'getFxRate' }, resolve);
        } catch {
          resolve(null);
        }
      });
      const rate = Number(resp?.data?.rate);
      if (resp?.ok && Number.isFinite(rate) && rate > 0) _fxRubPerCny = rate;
    } catch {}
    return _fxRubPerCny;
  }

  function _recordPriceCurrency(rec, raw) {
    return _firstValue(
      rec?.priceCurrency,
      raw?.priceCurrency,
      raw?.currency,
      raw?.currencyCode,
      raw?.currency_code,
      _currencyFromMoneyText(rec?.price),
      _currencyFromMoneyText(raw?.price),
      _currencyFromMoneyText(raw?.currentPrice),
      _currencyFromMoneyText(raw?.priceRub),
    );
  }

  function _moneyObjectValue(value) {
    if (value && typeof value === 'object') {
      const units = _toNumber(value.units);
      const nanos = Number(value.nanos);
      if (units !== null && Number.isFinite(nanos) && nanos !== 0) return units + (nanos / 1e9);
      if (units !== null) return units;
      const nestedValue = _firstValue(
        value.amount,
        value.value,
        value.price,
        value.marketing_price,
        value.marketingPrice,
      );
      return nestedValue && typeof nestedValue === 'object'
        ? _moneyObjectValue(nestedValue)
        : nestedValue;
    }
    return value;
  }

  function _moneyObjectCurrency(value) {
    if (value && typeof value === 'object') {
      const direct = _firstValue(
        value.currency_code,
        value.currencyCode,
        value.currency,
        value.price_currency,
        value.priceCurrency,
      );
      if (direct !== null) return direct;
      const nestedValue = _firstValue(value.price, value.marketing_price, value.marketingPrice);
      return nestedValue && typeof nestedValue === 'object'
        ? _moneyObjectCurrency(nestedValue)
        : _currencyFromMoneyText(nestedValue);
    }
    return _currencyFromMoneyText(value);
  }

  function _resolveMarketingPriceCny(rec) {
    const raw = rec?.raw || {};
    const variantMatch = _variantMatchFromRecord(rec);
    const partMarketingPrice = _firstValue(
      variantMatch?.part_marketing_price,
      variantMatch?.partMarketingPrice,
      raw.part_marketing_price,
      raw.partMarketingPrice,
    );
    const partPrice = partMarketingPrice && typeof partMarketingPrice === 'object'
      ? _firstValue(
          partMarketingPrice.price,
          partMarketingPrice.marketing_price,
          partMarketingPrice.marketingPrice,
          partMarketingPrice.value,
        )
      : null;
    const directCny = _toNumber(_firstValue(
      rec.marketingPriceCny,
      rec.marketing_price_cny,
      rec.blackPriceCny,
      rec.black_price_cny,
      raw.marketingPriceCny,
      raw.marketing_price_cny,
      raw.blackPriceCny,
      raw.black_price_cny,
      variantMatch?.marketingPriceCny,
      variantMatch?.marketing_price_cny,
    ));
    const priceValue = _firstValue(
      rec.marketingPrice,
      rec.marketing_price,
      rec.blackPrice,
      rec.black_price,
      raw.marketingPrice,
      raw.marketing_price,
      raw.blackPrice,
      raw.black_price,
      variantMatch?.marketingPrice,
      variantMatch?.marketing_price,
      partPrice,
    );
    const currency = _firstValue(
      rec.marketingPriceCurrency,
      rec.marketing_price_currency,
      rec.blackPriceCurrency,
      rec.black_price_currency,
      raw.marketingPriceCurrency,
      raw.marketing_price_currency,
      raw.blackPriceCurrency,
      raw.black_price_currency,
      variantMatch?.marketingPriceCurrency,
      variantMatch?.marketing_price_currency,
      _moneyObjectCurrency(priceValue),
      _moneyObjectCurrency(partPrice),
      _moneyObjectCurrency(partMarketingPrice),
      _recordPriceCurrency(rec, raw),
    );
    const converted = _moneyToCny(_moneyObjectValue(priceValue), currency);
    return converted !== null ? converted : directCny;
  }

  function _resolveCsvValue(rec, key) {
    const raw = rec?.raw || {};
    if (key === 'image') return _resolveImageUrl(rec);
    if (key === 'keyword') return _firstValue(_resolveHashtagKeyword(rec), rec.keyword, raw.keyword, raw.searchKeyword, raw.searchText);
    if (key === 'price') {
      const priceCurrency = _recordPriceCurrency(rec, raw);
      return _firstValue(
        raw.priceCny,
        raw.currentPriceCny,
        _moneyToCny(rec?.price, priceCurrency),
        _moneyToCny(raw.price, priceCurrency),
        _moneyToCny(raw.currentPrice, priceCurrency),
        _moneyToCny(raw.priceRub, 'RUB'),
        _extractCny(rec?.price),
        _extractCny(raw.price),
        _extractCny(raw.currentPrice),
      );
    }
    if (key === 'marketingPrice') return _resolveMarketingPriceCny(rec);
    if (key === 'gmvSumCny') {
      return _firstValue(
        _moneyToCny(raw.revenue30dRub, 'RUB'),
        _moneyToCny(raw.revenue30d, _currencyFromMoneyText(raw.revenue30d)),
        _moneyToCny(raw.gmvSum, _currencyFromMoneyText(raw.gmvSum)),
        _moneyToCny(rec.gmvSum, _currencyFromMoneyText(rec.gmvSum)),
        raw.revenue30dCny,
        _extractCny(raw.revenue30d),
        raw.gmvSumCny,
      );
    }
    if (key === 'brandName') return _firstValue(raw.brandName, raw.brand);
    if (key === 'shippingMode') return _firstValue(raw.shippingMode, raw.salesSchema, raw.marketSalesSchema, raw.deliverySchema, raw.deliveryType);
    if (key === 'weight') return _firstValue(raw.weight, raw.weightG, raw.weightGrams);
    if (key === 'listedDays') return _daysValue(raw.listedDays, raw.daysOnline, raw.createDate, raw.nullableCreateDate);
    if (key === 'monthlyTurnoverDynamic') return _firstValue(raw.monthlyTurnoverDynamic, raw.turnoverDynamic, raw.salesDynamics);
    if (key === 'adCostRatio') return _firstValue(raw.adCostRatio, raw.adCostPercent, raw.drr);
    if (key === 'promoDays') return _firstValue(raw.promoDays, raw.daysInPromo);
    if (key === 'promoDiscount') return _firstValue(raw.promoDiscount, raw.discount);
    if (key === 'promoConversionRate') return _firstValue(raw.promoConversionRate, raw.promoRevenueShare, raw.promoConvRate);
    if (key === 'paidPromotionDays') return _firstValue(raw.paidPromotionDays, raw.daysWithTrafarets, raw.daysWithAds);
    if (key === 'views') return _firstValue(rec.views, raw.views, raw.qtyViewPdp, raw.sessionCount, raw.pdpViews);
    if (key === 'cardAddToCartRate') return _firstValue(raw.cardAddToCartRate, raw.pdpToCartConversion, raw.convToCartPdp, raw.pdpCartRate);
    if (key === 'searchCatalogViews') return _firstValue(raw.searchCatalogViews, raw.sessionCountSearch, raw.searchViews);
    if (key === 'searchCatalogAddToCartRate') return _firstValue(raw.searchCatalogAddToCartRate, raw.convToCartSearch, raw.searchCartRate);
    if (key === 'displayConversionRate') return _firstValue(raw.displayConversionRate, raw.convViewToOrder, rec.convViewToOrder);
    if (key === 'returnCancelRate') {
      const direct = _firstValue(raw.returnCancelRate, raw.returnRate);
      if (direct !== null) return direct;
      const redemption = _toNumber(raw.nullableRedemptionRate);
      return redemption === null ? null : 100 - redemption;
    }
    if (key === 'followerCount') return _firstValue(raw.followerCount, raw.followSellCount, raw.heroFollow);
    if (key === 'lowestFollowerPrice') {
      return _firstValue(
        raw.lowestFollowerPriceCny,
        raw.followSellMinPriceCny,
        raw.followMinPriceCny,
        _moneyToCny(raw.lowestFollowerPrice, _firstValue(raw.lowestFollowerPriceCurrency, _currencyFromMoneyText(raw.lowestFollowerPrice))),
        _moneyToCny(raw.followSellMinPrice, _firstValue(raw.followSellMinPriceCurrency, _currencyFromMoneyText(raw.followSellMinPrice))),
        _moneyToCny(raw.followMinPrice, _firstValue(raw.followMinPriceCurrency, _currencyFromMoneyText(raw.followMinPrice))),
        _extractCny(raw.lowestFollowerPrice),
        _extractCny(raw.followSellMinPrice),
        _extractCny(raw.followMinPrice),
      );
    }
    return rec[key];
  }

  function _formatRow(rec) {
    return CSV_FIELDS.map((f) => {
      let v = _resolveCsvValue(rec, f.key);
      if (f.key === 'collectedAt' && v) v = _toLocalDateTimeString(v);
      return _csvEscape(v);
    }).join(',') + '\n';
  }

  const CSV_HEADER = '﻿' + CSV_FIELDS.map((f) => f.label).join(',') + '\n'; // BOM for Excel CN

  // 用 cursor 流式遍历，避免大数据集 OOM
  async function _streamSales(onRow, opts = {}) {
    await init();
    return new Promise((resolve, reject) => {
      const tx = _db.transaction([STORE_SALES], 'readonly');
      const store = tx.objectStore(STORE_SALES);
      const req = opts.status
        ? store.index('status').openCursor(IDBKeyRange.only(opts.status))
        : store.openCursor();
      let count = 0;
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          try {
            onRow(cursor.value);
            count++;
            cursor.continue();
          } catch (err) {
            reject(err);
          }
        } else {
          resolve(count);
        }
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // 优先 File System Access API 流式写一个文件；不支持则切片 500/份多文件下载
  async function exportCsv(opts = {}) {
    await init();
    await _refreshExportFxRate();
    const total = await countSales(opts);
    if (total === 0) throw new Error('没有可导出的数据');

    const filenameBase = opts.filename || `${globalThis.__JZ_BRAND__.displayName}采集_${new Date().toISOString().slice(0, 10)}`;

    // Path A: showSaveFilePicker 流式写
    if (typeof window.showSaveFilePicker === 'function') {
      let writable = null;
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filenameBase + '.csv',
          types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
        });
        writable = await handle.createWritable();
        const encoder = new TextEncoder();
        await writable.write(encoder.encode(CSV_HEADER));
        let writeChain = Promise.resolve();
        let written = 0;
        await _streamSales((rec) => {
          // queueMicrotask 给 cursor 一些喘息
          const chunk = encoder.encode(_formatRow(rec));
          writeChain = writeChain
            .then(() => writable.write(chunk))
            .then(() => { written++; });
        }, opts);
        await writeChain;
        await writable.close();
        return { ok: true, total, written, mode: 'fs-access', files: 1 };
      } catch (err) {
        try { await writable?.abort?.(); } catch {}
        if (err && err.name === 'AbortError') {
          return { ok: false, total, mode: 'fs-access', cancelled: true };
        }
        // 失败兜底走 fallback
        console.warn('[JZCollectorDB] showSaveFilePicker failed, fallback:', err);
      }
    }

    // Path B: fallback — 切片 500/份，多个 a.click 下载
    const SLICE = 500;
    let buffer = CSV_HEADER;
    let inSlice = 0;
    let sliceIdx = 0;
    const downloads = [];
    const triggerDownload = () => {
      if (inSlice === 0) return;
      const blob = new Blob([buffer], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filenameBase}_${sliceIdx + 1}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      downloads.push(a.download);
      sliceIdx++;
      buffer = CSV_HEADER;
      inSlice = 0;
    };
    await _streamSales((rec) => {
      buffer += _formatRow(rec);
      inSlice++;
      if (inSlice >= SLICE) triggerDownload();
    }, opts);
    triggerDownload();
    return { ok: true, total, mode: 'fallback', files: sliceIdx, filenames: downloads };
  }

  const XLSX_IMAGE_ROW_HEIGHT = 62;
  const XLSX_IMAGE_COL_WIDTH = 13;
  const XLSX_IMAGE_MAX_PX = 160;
  const XLSX_IMAGE_FETCH_TIMEOUT_MS = 10000;
  const XLSX_IMAGE_FETCH_CONCURRENCY = 4;

  function _xmlEscape(v) {
    return String(v ?? '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _toLocalDateTimeString(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value ?? '');
    const pad = (n) => String(n).padStart(2, '0');
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
    ].join('-') + ' ' + [
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds()),
    ].join(':');
  }

  function _xlsxFields() {
    const out = [];
    for (const field of CSV_FIELDS) {
      if (field.key === 'image') {
        out.push({ key: 'image', label: field.label });
        out.push({ key: 'imageUrl', label: '主图链接' });
      } else {
        out.push(field);
      }
    }
    return out;
  }

  function _variantMatchFromRecord(rec) {
    const vres = rec?.raw?.preFetched?.variant;
    const vitems = vres?.status === 'fulfilled'
      ? (vres.value?.items || vres.value?.data?.items || [])
      : [];
    return vitems.find((it) => String(it.variant_id) === String(rec?.sku)) || vitems[0] || null;
  }

  function _resolveImageUrl(rec) {
    const variantMatch = _variantMatchFromRecord(rec);
    const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(variantMatch) : null;
    return svCat?.mainImage || rec?.image || '';
  }

  function _resolveSourceName(rec) {
    const variantMatch = _variantMatchFromRecord(rec);
    const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(variantMatch) : null;
    if (window.jzPreferSourceName) {
      return window.jzPreferSourceName(svCat?.name, rec?.name) || rec?.name || '';
    }
    return rec?.name || svCat?.name || '';
  }

  function _resolveXlsxValue(rec, key) {
    if (key === 'image') return '';
    if (key === 'imageUrl') return _resolveImageUrl(rec);
    if (key === 'name') return _resolveSourceName(rec);
    return _resolveCsvValue(rec, key);
  }

  function _colName(n) {
    let s = '';
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function _cellRef(col, row) {
    return `${_colName(col)}${row}`;
  }

  function _isTextXlsxKey(key) {
    return ['sku', 'name', 'brandName', 'shippingMode', 'keyword', 'url', 'image', 'imageUrl', 'status', 'collectedAt'].includes(key);
  }

  function _xlsxCellXml(row, col, key, value) {
    const ref = _cellRef(col, row);
    if (value == null || value === '') return `<c r="${ref}"/>`;
    if (key === 'collectedAt') {
      value = _toLocalDateTimeString(value);
    }
    if (!_isTextXlsxKey(key)) {
      const n = _toNumber(value);
      if (n !== null) return `<c r="${ref}"><v>${n}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"><is><t>${_xmlEscape(value)}</t></is></c>`;
  }

  function _buildSheetXml(rows, fields, imageCount) {
    const lastCol = _colName(fields.length);
    const cols = fields.map((f, idx) => {
      const col = idx + 1;
      let width = 14;
      if (f.key === 'name') width = 34;
      else if (f.key === 'url' || f.key === 'imageUrl') width = 44;
      else if (f.key === 'image') width = XLSX_IMAGE_COL_WIDTH;
      else if (f.key === 'collectedAt') width = 22;
      return `<col min="${col}" max="${col}" width="${width}" customWidth="1"/>`;
    }).join('');
    const header = `<row r="1" ht="22" customHeight="1">${fields.map((f, idx) => (
      `<c r="${_cellRef(idx + 1, 1)}" t="inlineStr" s="1"><is><t>${_xmlEscape(f.label)}</t></is></c>`
    )).join('')}</row>`;
    const body = rows.map((rec, rIdx) => {
      const rowNum = rIdx + 2;
      const cells = fields.map((f, cIdx) => _xlsxCellXml(rowNum, cIdx + 1, f.key, _resolveXlsxValue(rec, f.key))).join('');
      const rowHeight = imageCount > 0 ? ` ht="${XLSX_IMAGE_ROW_HEIGHT}" customHeight="1"` : '';
      return `<row r="${rowNum}"${rowHeight}>${cells}</row>`;
    }).join('');
    const drawing = imageCount > 0 ? '<drawing r:id="rId1"/>' : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${lastCol}${rows.length + 1}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>${header}${body}</sheetData>
  ${drawing}
</worksheet>`;
  }

  function _imageExtFromMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('webp')) return 'webp';
    if (m.includes('png')) return 'png';
    if (m.includes('gif')) return 'gif';
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    return null;
  }

  function _imageMimeFromBytes(bytes) {
    if (!bytes || bytes.length < 12) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
    return null;
  }

  function _dataUrlToBytes(dataUrl) {
    const m = String(dataUrl || '').match(/^data:([^;,]+);base64,(.*)$/);
    if (!m) return null;
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime: m[1], bytes };
  }

  function _bytesToDataUrl(mime, bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return `data:${mime || 'application/octet-stream'};base64,${btoa(bin)}`;
  }

  function _blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function _withTimeout(promise, ms, label) {
    let timer = null;
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label || 'timeout')), ms);
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  function _sendMessageWithTimeout(message, ms, label) {
    return _withTimeout(new Promise((resolve) => {
      chrome.runtime.sendMessage(message, resolve);
    }), ms, label);
  }

  function _canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (canvas.toBlob) {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('canvas toBlob failed'));
        }, 'image/png');
        return;
      }
      try {
        const parsed = _dataUrlToBytes(canvas.toDataURL('image/png'));
        if (parsed) resolve(new Blob([parsed.bytes], { type: 'image/png' }));
        else reject(new Error('canvas toDataURL failed'));
      } catch (e) {
        reject(e);
      }
    });
  }

  async function _loadBitmapForXlsx(dataUrl) {
    const parsed = _dataUrlToBytes(dataUrl);
    if (parsed && typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(new Blob([parsed.bytes], { type: parsed.mime }));
      } catch {}
    }
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = dataUrl;
    });
    return img;
  }

  async function _convertImageToPngForXlsx(dataUrl) {
    const source = await _loadBitmapForXlsx(dataUrl);
    const rawW = source.naturalWidth || source.width || XLSX_IMAGE_MAX_PX;
    const rawH = source.naturalHeight || source.height || XLSX_IMAGE_MAX_PX;
    const scale = Math.min(1, XLSX_IMAGE_MAX_PX / Math.max(rawW, rawH));
    const w = Math.max(1, Math.round(rawW * scale));
    const h = Math.max(1, Math.round(rawH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(source, 0, 0, w, h);
    if (typeof source.close === 'function') source.close();
    const blob = await _canvasToPngBlob(canvas);
    return {
      mime: 'image/png',
      ext: 'png',
      bytes: new Uint8Array(await blob.arrayBuffer()),
    };
  }

  async function _normalizeImageForXlsx(mime, bytes, dataUrl) {
    let normalizedDataUrl = dataUrl;
    let ext = _imageExtFromMime(mime);
    if (!ext) {
      const sniffed = _imageMimeFromBytes(bytes);
      if (sniffed) {
        mime = sniffed;
        ext = _imageExtFromMime(mime);
        normalizedDataUrl = null;
      }
    }
    if (!ext) return null;
    if (ext === 'png' || ext === 'jpg') return { mime, bytes, ext };
    try {
      const src = normalizedDataUrl || _bytesToDataUrl(mime, bytes);
      return await _convertImageToPngForXlsx(src);
    } catch (e) {
      console.warn('[JZCollectorDB] xlsx image convert failed:', e);
      return null;
    }
  }

  async function _fetchImageForXlsx(url) {
    const src = String(url || '').trim();
    if (!/^https?:\/\//i.test(src)) return null;
    try {
      const resp = await _sendMessageWithTimeout(
        { action: 'proxyImageFetch', url: src },
        XLSX_IMAGE_FETCH_TIMEOUT_MS,
        'xlsx image proxy timeout',
      );
      if (resp?.ok && resp.dataUrl) {
        const parsed = _dataUrlToBytes(resp.dataUrl);
        if (parsed) {
          const normalized = await _normalizeImageForXlsx(parsed.mime, parsed.bytes, resp.dataUrl);
          if (normalized) return normalized;
        }
      }
    } catch {}
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const fetchPromise = fetch(src, controller ? { signal: controller.signal } : undefined);
      const r = await _withTimeout(
        fetchPromise,
        XLSX_IMAGE_FETCH_TIMEOUT_MS,
        'xlsx image fetch timeout',
      ).catch((e) => {
        try { controller?.abort(); } catch {}
        throw e;
      });
      if (!r.ok) return null;
      const blob = await r.blob();
      const dataUrl = _imageExtFromMime(blob.type) === 'png' || _imageExtFromMime(blob.type) === 'jpg'
        ? null
        : await _blobToDataUrl(blob);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return _normalizeImageForXlsx(blob.type, bytes, dataUrl);
    } catch {
      return null;
    }
  }

  async function _collectSales(opts = {}) {
    const rows = [];
    await _streamSales((rec) => rows.push(rec), opts);
    return rows;
  }

  async function _collectXlsxImages(rows, imageCol) {
    const found = [];
    let next = 0;
    const workerCount = Math.min(XLSX_IMAGE_FETCH_CONCURRENCY, rows.length);
    async function worker() {
      while (next < rows.length) {
        const i = next++;
        const url = _resolveImageUrl(rows[i]);
        const img = await _fetchImageForXlsx(url);
        if (!img) continue;
        found.push({
          row: i + 2,
          col: imageCol,
          ext: img.ext,
          bytes: img.bytes,
        });
      }
    }
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    found.sort((a, b) => a.row - b.row);
    return found.map((img, idx) => ({
      ...img,
      name: `image${idx + 1}.${img.ext}`,
    }));
  }

  function _buildDrawingXml(images) {
    const anchors = images.map((img, idx) => {
      const col0 = img.col - 1;
      const row0 = img.row - 1;
      return `<xdr:twoCellAnchor editAs="oneCell">
  <xdr:from><xdr:col>${col0}</xdr:col><xdr:colOff>90000</xdr:colOff><xdr:row>${row0}</xdr:row><xdr:rowOff>90000</xdr:rowOff></xdr:from>
  <xdr:to><xdr:col>${col0 + 1}</xdr:col><xdr:colOff>90000</xdr:colOff><xdr:row>${row0 + 1}</xdr:row><xdr:rowOff>90000</xdr:rowOff></xdr:to>
  <xdr:pic>
    <xdr:nvPicPr><xdr:cNvPr id="${idx + 1}" name="主图${idx + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
    <xdr:blipFill><a:blip r:embed="rId${idx + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
    <xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
  </xdr:pic>
  <xdr:clientData/>
</xdr:twoCellAnchor>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`;
  }

  function _buildDrawingRelsXml(images) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${images.map((img, idx) => (
  `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${img.name}"/>`
)).join('')}</Relationships>`;
  }

  function _contentTypesXml(images) {
    const mediaDefaults = [...new Set(images.map((img) => img.ext))]
      .map((ext) => {
        const type = ext === 'png'
          ? 'image/png'
          : ext === 'gif'
            ? 'image/gif'
            : ext === 'webp'
              ? 'image/webp'
              : 'image/jpeg';
        return `<Default Extension="${ext}" ContentType="${type}"/>`;
      })
      .join('');
    const drawingOverride = images.length
      ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
      : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${mediaDefaults}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${drawingOverride}
</Types>`;
  }

  function _xlsxStaticFiles(sheetXml, images) {
    const now = new Date().toISOString();
    const files = [
      { name: '[Content_Types].xml', data: _contentTypesXml(images) },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>' },
      { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Jizhang Collector</dc:creator><cp:lastModifiedBy>Jizhang Collector</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
      { name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Jizhang Collector</Application></Properties>' },
      { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="采集数据" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF3FF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>' },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
    ];
    if (images.length) {
      files.push({ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>' });
      files.push({ name: 'xl/drawings/drawing1.xml', data: _buildDrawingXml(images) });
      files.push({ name: 'xl/drawings/_rels/drawing1.xml.rels', data: _buildDrawingRelsXml(images) });
      for (const img of images) files.push({ name: `xl/media/${img.name}`, data: img.bytes });
    }
    return files;
  }

  let _crcTable = null;
  function _crc32(bytes) {
    if (!_crcTable) {
      _crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        _crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = _crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function _concatBytes(chunks) {
    const len = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  function _zipDateTime() {
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const year = Math.max(1980, d.getFullYear());
    const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { dosTime, dosDate };
  }

  function _u16(view, offset, value) { view.setUint16(offset, value, true); }
  function _u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

  function _zipStore(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const centrals = [];
    let offset = 0;
    const { dosTime, dosDate } = _zipDateTime();
    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
      const crc = _crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      _u32(lv, 0, 0x04034b50); _u16(lv, 4, 20); _u16(lv, 6, 0x0800); _u16(lv, 8, 0);
      _u16(lv, 10, dosTime); _u16(lv, 12, dosDate); _u32(lv, 14, crc);
      _u32(lv, 18, data.length); _u32(lv, 22, data.length); _u16(lv, 26, nameBytes.length); _u16(lv, 28, 0);
      local.set(nameBytes, 30);
      chunks.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      _u32(cv, 0, 0x02014b50); _u16(cv, 4, 20); _u16(cv, 6, 20); _u16(cv, 8, 0x0800); _u16(cv, 10, 0);
      _u16(cv, 12, dosTime); _u16(cv, 14, dosDate); _u32(cv, 16, crc);
      _u32(cv, 20, data.length); _u32(cv, 24, data.length); _u16(cv, 28, nameBytes.length);
      _u16(cv, 30, 0); _u16(cv, 32, 0); _u16(cv, 34, 0); _u16(cv, 36, 0); _u32(cv, 38, 0); _u32(cv, 42, offset);
      central.set(nameBytes, 46);
      centrals.push(central);
      offset += local.length + data.length;
    }
    const centralOffset = offset;
    for (const c of centrals) {
      chunks.push(c);
      offset += c.length;
    }
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    _u32(ev, 0, 0x06054b50); _u16(ev, 4, 0); _u16(ev, 6, 0);
    _u16(ev, 8, files.length); _u16(ev, 10, files.length);
    _u32(ev, 12, offset - centralOffset); _u32(ev, 16, centralOffset); _u16(ev, 20, 0);
    chunks.push(eocd);
    return _concatBytes(chunks);
  }

  function _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function exportXlsx(opts = {}) {
    await init();
    await _refreshExportFxRate();
    const total = await countSales(opts);
    if (total === 0) throw new Error('没有可导出的数据');
    const rows = await _collectSales(opts);
    const fields = _xlsxFields();
    const imageCol = fields.findIndex((f) => f.key === 'image') + 1;
    const images = imageCol ? await _collectXlsxImages(rows, imageCol) : [];
    const sheetXml = _buildSheetXml(rows, fields, images.length);
    const zipBytes = _zipStore(_xlsxStaticFiles(sheetXml, images));
    const blob = new Blob([zipBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const filenameBase = opts.filename || `${globalThis.__JZ_BRAND__?.displayName || '极掌'}采集_${new Date().toISOString().slice(0, 10)}`;
    const filename = `${filenameBase}.xlsx`;

    if (typeof window.showSaveFilePicker === 'function') {
      let writable = null;
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'Excel 工作簿', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
        });
        writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return { ok: true, total, images: images.length, mode: 'fs-access', files: 1 };
      } catch (err) {
        try { await writable?.abort?.(); } catch {}
        if (err && err.name === 'AbortError') return { ok: false, total, cancelled: true };
        console.warn('[JZCollectorDB] showSaveFilePicker xlsx failed, fallback:', err);
      }
    }

    _downloadBlob(blob, filename);
    return { ok: true, total, images: images.length, mode: 'download', files: 1, filenames: [filename] };
  }

  // ─── keywords ──────────────────────────────────────────
  async function addKeywords(texts) {
    await init();
    if (!texts || texts.length === 0) return 0;
    const tx = _db.transaction([STORE_KEYWORDS], 'readwrite');
    const store = tx.objectStore(STORE_KEYWORDS);
    let n = 0;
    for (const raw of texts) {
      const text = String(raw || '').trim();
      if (!text) continue;
      store.add({
        text,
        maxCollectNumber: 0,
        status: 'pending',
        collectedCount: 0,
        createdAt: Date.now(),
      });
      n++;
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
    _broadcast({ type: 'keyword-changed' });
    return n;
  }

  async function getKeywords(opts = {}) {
    await init();
    const store = _store(STORE_KEYWORDS);
    if (opts.status) {
      return _wrap(store.index('status').getAll(opts.status));
    }
    return _wrap(store.getAll());
  }

  async function getNextPendingKeyword() {
    const list = await getKeywords({ status: 'pending' });
    if (!list.length) return null;
    return list.sort((a, b) => a.id - b.id)[0];
  }

  async function updateKeyword(id, patch) {
    await init();
    const store = _store(STORE_KEYWORDS, 'readwrite');
    const existing = await _wrap(store.get(id));
    if (!existing) return null;
    Object.assign(existing, patch);
    await _wrap(store.put(existing));
    _broadcast({ type: 'keyword-changed' });
    return existing;
  }

  async function removeKeyword(id) {
    await init();
    await _wrap(_store(STORE_KEYWORDS, 'readwrite').delete(id));
    _broadcast({ type: 'keyword-changed' });
  }

  async function clearKeywords() {
    await init();
    await _wrap(_store(STORE_KEYWORDS, 'readwrite').clear());
    _broadcast({ type: 'keyword-changed' });
  }

  // ─── sessions ─────────────────────────────────────────
  const SESSION_KEY = 'current';

  async function setSession(patch) {
    await init();
    const store = _store(STORE_SESSIONS, 'readwrite');
    const existing = (await _wrap(store.get(SESSION_KEY))) || { key: SESSION_KEY };
    Object.assign(existing, patch, { updatedAt: Date.now() });
    await _wrap(store.put(existing));
    return existing;
  }

  async function getSession() {
    await init();
    return _wrap(_store(STORE_SESSIONS).get(SESSION_KEY));
  }

  async function clearSession() {
    await init();
    await _wrap(_store(STORE_SESSIONS, 'readwrite').delete(SESSION_KEY));
  }

  // ─── failures ─────────────────────────────────────────
  async function addFailure(rec) {
    await init();
    if (!rec || !rec.taskId) throw new Error('taskId required');
    if (!rec.lastTriedAt) rec.lastTriedAt = Date.now();
    if (!rec.attempts) rec.attempts = 1;
    await _wrap(_store(STORE_FAILURES, 'readwrite').put(rec));
  }

  async function getFailures(opts = {}) {
    await init();
    const store = _store(STORE_FAILURES);
    if (opts.keyword) {
      return _wrap(store.index('keyword').getAll(opts.keyword));
    }
    return _wrap(store.getAll());
  }

  async function removeFailure(taskId) {
    await init();
    await _wrap(_store(STORE_FAILURES, 'readwrite').delete(taskId));
  }

  async function clearFailures() {
    await init();
    await _wrap(_store(STORE_FAILURES, 'readwrite').clear());
  }

  function onChange(cb) {
    _changeListeners.add(cb);
    return () => _changeListeners.delete(cb);
  }

  window.JZCollectorDB = {
    _v2: true,
    init,
    // sales
    putSale, putSaleBatch, getSale, getAllSales, getSalesSince, countSales, markPushed, deleteSale, clearSales,
    exportCsv, exportXlsx,
    // keywords
    addKeywords, getKeywords, getNextPendingKeyword, updateKeyword, removeKeyword, clearKeywords,
    // sessions
    setSession, getSession, clearSession,
    // failures
    addFailure, getFailures, removeFailure, clearFailures,
    // util
    onChange,
  };
})();
