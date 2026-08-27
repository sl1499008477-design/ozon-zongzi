'use strict';

/**
 * 极掌算价 · v1.2 · Floating Panel
 * 独立悬浮面板：右上角浮窗，可拖拽 / 最小化 / 关闭，关闭后变小球可恢复
 */

(function () {
  // 详情页 + 列表页(搜索/类目/卖家/品牌)都暴露算价面板 API —— 主插件 action bar 的「算价」
  // 按钮通过 window.__jzcMountPanel 按需唤起。面板默认不自动启动,列表页无商品 DOM 可填时
  // 退化为纯手动计算器。其余页面(首页/购物车…)不加载。
  if (
    !window.location.pathname.includes('/product/') &&
    !/\/(category|search|search-by-image|seller|brand|highlight)\b/.test(window.location.pathname)
  ) {
    return;
  }

  const P = 'jzc';
  const LS_STATE = 'jz_calc_state_v3';
  const LS_SKU_SPECS = 'jz_calc_sku_specs_v1'; // { [sku]: { price, cost, weight, dimL, dimW, dimH, ts } }
  const SKU_SPECS_MAX = 60;                    // LRU 上限
  const LS_MAIN_CHECK = 'jz_calc_main_check_v2';
  const LS_MIGRATE_DISMISS = 'jz_calc_migrate_dismiss_v1';
  const LS_FX_RATE = 'jz_calc_fx_rate_v1';
  const LABEL_FEE = 2.0;
  const PLATFORM_FEE_RATE = 0.04;
  const DPI_FACTOR_FALLBACK = 12;
  let DPI_FACTOR = DPI_FACTOR_FALLBACK; // 实时汇率拉到后由 background 写入 storage 触发更新
  const SAFETY_RATE = 0.15;

  // 主插件发布 >= 此版本时，算价停用
  const MAIN_EXT_STABLE_VERSION = '1.0.0';
  const MAIN_EXT_UPDATE_URL = 'http://127.0.0.1:3000/api/extension/latest';
  const MAIN_EXT_INSTALL_URL_FALLBACK = 'http://127.0.0.1:3000/extension';
  const MAIN_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const DEFAULT_BRAND_DISPLAY_NAME = /__BRAND/.test('ozon 粽子')
    ? 'ozon 粽子'
    : 'ozon 粽子';
  const DEFAULT_BRAND_PRODUCT_NAME = /__BRAND/.test('ozon 粽子')
    ? `${DEFAULT_BRAND_DISPLAY_NAME} - Ozon选品管理工具`
    : 'ozon 粽子';

  // ── Freight tables ──────────────────────────────
  // base 单位：¥/包；rates 单位：¥/g
  // 货值边界（卢布）来自义乌仓 122 资费表：xs/budget ≤ 1500₽，small/big 1501-7000₽，premium 7001+
  const VALUE_LO = 1500;
  const VALUE_HI = 7000;
  const W_XS = 500;
  const W_SMALL = 2000;
  const W_PSMALL = 5000;

  // 资费 + 尺寸限制来源：义乌仓 122 资费表（2026-04-15）+ XY/CEL/GUOO 报价表 xlsx
  // 每档字段：
  //   base / baseEconomy   票费（economy 时若 baseEconomy 存在则取代 base）
  //   rates[transport]     每克运费（economy/std/fast）
  //   maxL                 单边最长 ≤ N cm（超出该档不可发）
  //   maxSum               三边和 ≤ N cm（超出该档不可发）
  //   vol                  true=该档计抛（实重 vs 体积重取大）；false=不计抛只按实重
  // 关键事实：
  //   · CEL 的 Big / Premium Big 没有 Express（只有 Standard + Economy）
  //   · GUOO 的 Budget / Big / Premium Big 只有 Economy；Premium Small 无 Standard
  //   · GUOO 的 Extra Small Economy 票费 ¥3.00（其余运输方式 ¥3.12）
  //   · 兴远 XY 没有 Express；pBig 的 std/economy base 不同（64 vs 64.48）
  //   · 计抛规则按 xlsx「不计材积」标记逐档判定（GUOO budget/pSmall 计抛，CEL/XY 仅 big/pBig 计抛）
  const CEL_FREIGHT = {
    xs:     { base: 3.12,  maxL: 60,  maxSum: 90,  vol: false, rates: { economy: 0.026,   std: 0.0364,  fast: 0.0468  } },
    budget: { base: 23.92, maxL: 60,  maxSum: 150, vol: false, rates: { economy: 0.01768, std: 0.026,   fast: 0.03432 } },
    small:  { base: 16.64, maxL: 60,  maxSum: 150, vol: false, rates: { economy: 0.026,   std: 0.0364,  fast: 0.0468  } },
    big:    { base: 37.44, maxL: 150, maxSum: 310, vol: true,  rates: { economy: 0.01768, std: 0.026                  } },
    pSmall: { base: 22.88, maxL: 150, maxSum: 250, vol: false, rates: { economy: 0.026,   std: 0.0364,  fast: 0.0468  } },
    pBig:   { base: 64.48, maxL: 150, maxSum: 310, vol: true,  rates: { economy: 0.02392, std: 0.02912                } },
  };
  const GUOO_FREIGHT = {
    xs:     { base: 3.12,  baseEconomy: 3.00, maxL: 60,  maxSum: 90,  vol: false,
              rates: { economy: 0.026,   std: 0.0364,  fast: 0.0468  } },
    budget: { base: 23.92, maxL: 60,  maxSum: 150, vol: true,  rates: { economy: 0.01768                              } },
    small:  { base: 16.64, maxL: 60,  maxSum: 150, vol: false, rates: { economy: 0.026,   std: 0.0364,  fast: 0.0468  } },
    big:    { base: 37.44, maxL: 150, maxSum: 250, vol: true,  rates: { economy: 0.01768                              } },
    pSmall: { base: 22.88, maxL: 150, maxSum: 250, vol: true,  rates: { economy: 0.026,                  fast: 0.0468 } },
    pBig:   { base: 64.48, maxL: 150, maxSum: 310, vol: true,  rates: { economy: 0.02392                              } },
  };
  const XY_FREIGHT = {
    xs:     { base: 3.12,  maxL: 60,  maxSum: 90,  vol: false, rates: { economy: 0.026,   std: 0.0364   } },
    budget: { base: 23.92, maxL: 60,  maxSum: 150, vol: false, rates: { economy: 0.01768, std: 0.026    } },
    small:  { base: 16.64, maxL: 60,  maxSum: 150, vol: false, rates: { economy: 0.026,   std: 0.0364   } },
    big:    { base: 37.44, maxL: 150, maxSum: 250, vol: true,  rates: { economy: 0.01768, std: 0.026    } },
    pSmall: { base: 22.88, maxL: 150, maxSum: 250, vol: false, rates: { economy: 0.026,   std: 0.0364   } },
    pBig:   { base: 64,    baseEconomy: 64.48, maxL: 150, maxSum: 310, vol: true,
             rates: { economy: 0.02392, std: 0.02912 } },
  };
  // 中通 ZTO rFBS（v6.3）：与 CEL 大体相同，除 Big 仅有 Standard
  // ZTO 不在本次 xlsx 范围，尺寸用 CEL/XY 同档位的合理值兜底
  const ZTO_FREIGHT = {
    xs:     { base: 3.12,  maxL: 60,  maxSum: 90,  vol: false, rates: { economy: 0.026,   std: 0.0364,  fast: 0.0468  } },
    budget: { base: 23.92, maxL: 60,  maxSum: 150, vol: true,  rates: { economy: 0.01768, std: 0.026,   fast: 0.03432 } },
    small:  { base: 16.64, maxL: 60,  maxSum: 150, vol: true,  rates: { economy: 0.026,   std: 0.0364,  fast: 0.0468  } },
    big:    { base: 37.44, maxL: 150, maxSum: 310, vol: true,  rates: {                   std: 0.026                  } },
    pSmall: { base: 22.88, maxL: 150, maxSum: 250, vol: true,  rates: { economy: 0.026,   std: 0.0364,  fast: 0.0468  } },
    pBig:   { base: 64.48, maxL: 150, maxSum: 310, vol: true,  rates: { economy: 0.02392, std: 0.02912                } },
  };
  // 单一费率渠道：不分档、不分运输方式
  // EUB（E邮宝特惠 · 俄罗斯）：13元/票 + 32元/KG，≤5KG，单边≤60，三边和≤90，不计材积
  // EBP（E包裹特惠）：首重 500g 52.5元 + 续重 30元/KG，0.5-31KG，单边≤105，三边和≤200，货值≤¥1000，不计材积
  const EUB_FREIGHT = {
    type: 'flat',
    base: 13,
    perGram: 0.032,
    minFee: 0,
    weightCap: 5000,
    maxL: 60,
    maxSum: 90,
    note: '俄罗斯专线 · ≤5KG · 单边≤60 · 不计抛',
  };
  const EBP_FREIGHT = {
    type: 'flat',
    base: 37.5,
    perGram: 0.030,
    minFee: 52.5,           // 首重 500g 起步价
    weightCap: 31000,
    valueCapCNY: 1000,
    maxL: 105,
    maxSum: 200,
    note: '≤31KG · 单边≤105 · 货值≤¥1000 · 不计抛',
  };

  const TIERED_TABLES = { CEL: CEL_FREIGHT, GUOO: GUOO_FREIGHT, XY: XY_FREIGHT, ZTO: ZTO_FREIGHT };
  const FLAT_TABLES   = { EUB: EUB_FREIGHT, EBP: EBP_FREIGHT };
  const TIERED_CHANNELS = Object.keys(TIERED_TABLES);
  const FLAT_CHANNELS   = Object.keys(FLAT_TABLES);

  const CHANNEL_LABELS = {
    CEL:  { short: 'CEL',   full: 'CEL 物流' },
    GUOO: { short: 'GUOO',  full: 'GUOO 物流' },
    XY:   { short: '兴远',  full: '兴远 XY 物流' },
    ZTO:  { short: 'ZTO',   full: '中通 ZTO rFBS' },
    EUB:  { short: 'E邮宝', full: 'E邮宝特惠' },
    EBP:  { short: 'E包裹', full: 'E包裹特惠' },
  };

  // 体积重除数:
  //   - 默认渠道 (CEL/GUOO/XY): 12000 (即 L×W×H / 12000 kg)
  //   - ZTO rFBS 中通: 大件档 (big / pBig) 用 12000;其他档 (budget/small/pSmall)
  //     用 24000 (来自 ZTO-rFBS 报价表 v6.1)。xs 档 vol=false 不计抛,divisor 不被引用
  // 是否计抛由 freight 表每档的 vol 字段决定（不再写死档位 set；与 xlsx「不计材积」列对齐）
  function getVolDivisor(channel, tierKey, transport) {
    if (channel === 'ZTO') {
      if (tierKey === 'big' || tierKey === 'pBig') return 12000;
      return 24000;
    }
    return 12000;
  }
  // 检查尺寸是否超出该档位/渠道的限制；用户未填尺寸时返回 null（不报警）
  function checkSizeBreach(rule, dimL, dimW, dimH) {
    if (!rule) return null;
    const dims = [dimL || 0, dimW || 0, dimH || 0];
    const longest = Math.max(...dims);
    const sum = dims.reduce((a, b) => a + b, 0);
    if (sum <= 0) return null;
    const breachL   = rule.maxL   != null && longest > rule.maxL;
    const breachSum = rule.maxSum != null && sum     > rule.maxSum;
    if (!breachL && !breachSum) return null;
    return { breachL, breachSum, longest, sum, maxL: rule.maxL, maxSum: rule.maxSum };
  }

  function isFlatChannel(channelName) { return channelName in FLAT_TABLES; }
  function freightTableFor(channelName) {
    return TIERED_TABLES[channelName] || null;
  }
  function channelCfgRef(channelName) {
    if (channelName === 'CEL')  return celConfig;
    if (channelName === 'GUOO') return guooConfig;
    if (channelName === 'XY')   return xyConfig;
    if (channelName === 'ZTO')  return ztoConfig;
    return null;
  }

  // 升档表：任何档尺寸超限都尝试升到该渠道更大尺寸的档（big/pBig 自带 vol:true，自然按计抛计费）
  //   xs/budget/small → big   (该渠道非 premium 顶档：maxL 60→150, maxSum 90/150→310/250)
  //   pSmall → pBig            (premium 顶档：maxSum 250→310)
  //   big/pBig 已是顶档（无可升）
  // 物流商按尺寸+重量收费，OZON 货值边界仅决定佣金档，不约束物流档升档
  const UPGRADE_TO = { xs: 'big', budget: 'big', small: 'big', pSmall: 'pBig' };

  // recalcAll 传入未折算的 dim_LWH(cm³) 与三边 dimL/dimW/dimH(cm)
  // calcFreight 按渠道+档位+运输方式选择正确除数；返回值含 sizeBreach + upgradedFrom
  function calcFreight(channelName, actualW, dimVolume, priceCNY, dimL, dimW, dimH) {
    if (isFlatChannel(channelName)) {
      return calcFlatFreight(channelName, actualW, priceCNY, dimL, dimW, dimH);
    }
    const cfg = channelCfgRef(channelName);
    const table = freightTableFor(channelName);
    // 用实重决定档位，避免因体积重把轻小件错判到 Big
    let tierKey = matchTierKey(actualW, priceCNY);
    const originalTierKey = tierKey;
    let upgraded = false;
    // 尺寸超限 + 该档可升 → 升档
    if (UPGRADE_TO[tierKey]) {
      const idealBreach = checkSizeBreach(table[tierKey], dimL, dimW, dimH);
      if (idealBreach && table[UPGRADE_TO[tierKey]]) {
        tierKey = UPGRADE_TO[tierKey];
        upgraded = true;
      }
    }
    const tier = table[tierKey];
    let transport = (cfg && cfg[tierKey]) || 'economy';
    if (tier.rates[transport] == null) {
      // 找一个可用 transport 兜底（economy 优先，再 std，再 fast）
      transport = ['economy', 'std', 'fast'].find((k) => tier.rates[k] != null) || 'economy';
    }
    const ratePerGram = tier.rates[transport];
    const base = (tier.baseEconomy != null && transport === 'economy')
      ? tier.baseEconomy
      : tier.base;
    const usesVol = !!tier.vol;
    const divisor = getVolDivisor(channelName, tierKey, transport);
    const volW = (usesVol && dimVolume > 0) ? (dimVolume * 1000 / divisor) : 0;
    const billed = Math.max(actualW || 0, volW);
    const fee = base + billed * ratePerGram;
    const sizeBreach = checkSizeBreach(tier, dimL, dimW, dimH);
    return {
      fee, base, ratePerGram, tierKey, transport, billed, divisor, usesVol, sizeBreach,
      upgradedFrom: upgraded ? originalTierKey : null,
      type: 'tiered',
    };
  }

  function calcFlatFreight(channelName, actualW, priceCNY, dimL, dimW, dimH) {
    const t = FLAT_TABLES[channelName];
    const w = actualW || 0;
    const fee = Math.max(t.minFee || 0, t.base + w * t.perGram);
    const overWeight = t.weightCap != null && w > t.weightCap;
    const overValue  = t.valueCapCNY != null && (priceCNY || 0) > t.valueCapCNY;
    const sizeBreach = checkSizeBreach(t, dimL, dimW, dimH);
    return {
      fee, base: t.base, ratePerGram: t.perGram, billed: w,
      type: 'flat', overWeight, overValue, sizeBreach, note: t.note,
    };
  }

  // 把保存的渠道配置中已不存在的运输方式归回到该档位实际可用的（优先 economy）
  function normalizeChannelCfg(channelName, cfg) {
    const table = freightTableFor(channelName);
    const out = {};
    TIER_KEYS.forEach((k) => {
      const wanted = cfg?.[k] || 'economy';
      if (table[k].rates[wanted] != null) {
        out[k] = wanted;
      } else {
        out[k] = ['economy', 'std', 'fast'].find((t) => table[k].rates[t] != null) || 'economy';
      }
    });
    return out;
  }

  function tierFromPrice(p) {
    if (!p || p <= 0) return null;
    if (p <= 135) return 1;
    if (p <= 437) return 2;
    return 3;
  }
  const DEFAULT_TIER_RATE = { 1: 13, 2: 15, 3: 17 };
  let TIER_RATE = { ...DEFAULT_TIER_RATE };

  const fmt = (n, d = 2) =>
    n == null || isNaN(n) ? '—'
      : Number(n).toLocaleString('zh-CN', {
          minimumFractionDigits: d,
          maximumFractionDigits: d,
        });

  // ── Storage helpers ─────────────────────────────
  function storageGet(keys) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(keys, (v) => resolve(v || {})); }
      catch { resolve({}); }
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set(obj, () => resolve()); }
      catch { resolve(); }
    });
  }

  function compareVersions(v1, v2) {
    const a = String(v1 || '').split('.').map((n) => Number(n) || 0);
    const b = String(v2 || '').split('.').map((n) => Number(n) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  function getMainExtUpdateUrl() {
    const brandCode =
      globalThis.__JZ_BRAND__ &&
      typeof globalThis.__JZ_BRAND__.code === 'string'
        ? globalThis.__JZ_BRAND__.code.trim()
        : '';
    const qs = new URLSearchParams({ client: 'extension' });
    if (brandCode && brandCode !== 'platform') {
      qs.set('brand', brandCode);
    }
    return `${MAIN_EXT_UPDATE_URL}?${qs.toString()}`;
  }

  async function isMainExtStable() {
    const now = Date.now();
    const cached = (await storageGet([LS_MAIN_CHECK]))[LS_MAIN_CHECK];
    let mainVersion = null;
    let installUrl = null;
    if (cached && now - (cached.checkedAt || 0) < MAIN_CHECK_INTERVAL_MS) {
      mainVersion = cached.version;
      installUrl = cached.installUrl || null;
    } else {
      try {
        const resp = await fetch(getMainExtUpdateUrl(), {
          method: 'GET', cache: 'no-cache', signal: AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.version) {
            mainVersion = data.version;
            installUrl = data.downloadUrl || data.url || null;
            await storageSet({
              [LS_MAIN_CHECK]: { checkedAt: now, version: data.version, installUrl: installUrl || '' },
            });
          }
        }
      } catch {
        if (cached && cached.version) {
          mainVersion = cached.version;
          installUrl = cached.installUrl || null;
        }
      }
    }
    if (!mainVersion) return { stable: false };
    return {
      stable: compareVersions(mainVersion, MAIN_EXT_STABLE_VERSION) >= 0,
      version: mainVersion,
      installUrl: installUrl || MAIN_EXT_INSTALL_URL_FALLBACK,
    };
  }

  function readForceMigrate() {
    try {
      const query = new URLSearchParams(window.location.search);
      if (query.has('jzcForceMigrate')) return query.get('jzcForceMigrate') || '1';
      const hash = window.location.hash.replace(/^#/, '');
      const hashParams = new URLSearchParams(hash);
      if (hashParams.has('jzcForceMigrate')) return hashParams.get('jzcForceMigrate') || '1';
      if (/[?&#]jzcForceMigrate(=|&|$)/.test(window.location.href)) return '1';
    } catch {}
    return null;
  }

  async function shouldMigrate() {
    const forced = readForceMigrate();
    if (forced) {
      const ver = forced === '1' ? MAIN_EXT_STABLE_VERSION : forced;
      return { version: ver, installUrl: MAIN_EXT_INSTALL_URL_FALLBACK, dismissed: false };
    }
    const { stable, version, installUrl } = await isMainExtStable();
    if (!stable) return null;
    const dismissed = (await storageGet([LS_MIGRATE_DISMISS]))[LS_MIGRATE_DISMISS];
    return { version, installUrl: installUrl || MAIN_EXT_INSTALL_URL_FALLBACK, dismissed: dismissed === version };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return ch;
      }
    });
  }

  function renderMigrationToast(mainVersion, installUrl) {
    if (!document.body) {
      setTimeout(() => renderMigrationToast(mainVersion, installUrl), 300);
      return;
    }
    if (document.querySelector(`.${P}-migrate-toast`)) return;
    const brand = globalThis.__JZ_BRAND__ || {};
    const brandDisplayName = brand.displayName || DEFAULT_BRAND_DISPLAY_NAME;
    const brandProductName = brand.productName || DEFAULT_BRAND_PRODUCT_NAME;
    const url = installUrl || MAIN_EXT_INSTALL_URL_FALLBACK;
    const toast = document.createElement('div');
    toast.className = `${P}-migrate-toast`;
    toast.innerHTML = `
      <div class="${P}-migrate-head">
        <span class="${P}-migrate-mark">${escapeHtml((brandDisplayName || DEFAULT_BRAND_DISPLAY_NAME).slice(0, 1))}</span>
        <span class="${P}-migrate-title">${escapeHtml(brandDisplayName)}算价已停用</span>
        <button class="${P}-migrate-close" data-action="dismiss-migrate" title="不再提示">×</button>
      </div>
      <div class="${P}-migrate-body">
        算价功能已并入<b>${escapeHtml(brandProductName)} v${mainVersion}</b>，可同时获得选品、跟卖、库存、订单等完整工具链。
      </div>
      <div class="${P}-migrate-actions">
        <a class="${P}-migrate-btn primary" href="${url}" target="_blank" rel="noopener">前往下载主插件</a>
      </div>
    `;
    document.body.appendChild(toast);
    toast.querySelector('[data-action="dismiss-migrate"]').addEventListener('click', async () => {
      await storageSet({ [LS_MIGRATE_DISMISS]: mainVersion });
      toast.remove();
    });
  }

  // ── Extract product data from page ──────────────
  // Ozon 价格语义：
  //   黑标 (price)     = "без Ozon Банком" 普通价（不带 Ozon Bank）
  //   绿标 (cardPrice) = "с Ozon Банком" Ozon Bank 优惠价（UI 绿色背景）
  //   originalPrice    = 历史划线价，与黑/绿标无关
  function parsePriceNum(v) {
    if (v == null) return NaN;
    const t = typeof v === 'string' ? v : v.price ?? v.value ?? '';
    const n = parseFloat(String(t).replace(/[^\d.,]/g, '').replace(',', '.'));
    return n;
  }
  function extractProductData() {
    const data = {};
    try {
      const priceTags = window.jzExtractOzonPriceTags?.(document) || null;
      if (priceTags?.blackPrice != null) data.blackPrice = priceTags.blackPrice;
      if (priceTags?.greenPrice != null) data.greenPrice = priceTags.greenPrice;
    } catch (_) {}
    try {
      const els = document.querySelectorAll('[data-state]');
      for (const el of els) {
        const raw = el.getAttribute('data-state');
        if (!raw || raw.length < 10) continue;
        try {
          const p = JSON.parse(raw);
          if (!p || typeof p !== 'object') continue;
          if (p.price && data.blackPrice == null) {
            const n = parsePriceNum(p.price);
            if (!isNaN(n) && n > 0) data.blackPrice = n;
          }
          if (p.cardPrice && data.greenPrice == null) {
            const n = parsePriceNum(p.cardPrice);
            if (!isNaN(n) && n > 0) data.greenPrice = n;
          }
        } catch (_) {}
      }
    } catch (_) {}
    if (!data.blackPrice) {
      const el = document.querySelector('[data-widget="webPrice"] span');
      if (el) {
        const n = parseFloat(el.textContent.replace(/[^\d.,]/g, '').replace(',', '.'));
        if (!isNaN(n) && n > 0) data.blackPrice = n;
      }
    }
    // 没参与 Ozon Bank 折扣时只有 cardPrice 没有 price：cardPrice 即黑标
    if (data.blackPrice == null && data.greenPrice != null) {
      data.blackPrice = data.greenPrice;
    }
    // 公式要求 黑 ≥ 绿；若反了或缺失，绿标视作等于黑标（无折扣）
    if (data.blackPrice != null && (data.greenPrice == null || data.greenPrice > data.blackPrice)) {
      data.greenPrice = data.blackPrice;
    }
    const m = location.pathname.match(/\/product\/[^/]*-(\d+)/);
    if (m) data.sku = m[1];
    Object.assign(data, extractWeightAndDims());
    return data;
  }

  // ── 抓商品页特征：重量(g) + 长宽高(cm) ──────────────
  // Ozon 商品页常见 4 种结构：
  //   1) [data-widget="webShortCharacteristics"] data-state.characteristics: [{title|key, shortValue|values|value}]
  //   2) [data-widget="webCharacteristics"]      data-state.characteristics: 同上，列表更全
  //   3) DOM dl/dt/dd 或 table tr/td 兜底
  //   4) "Размеры, мм" 形如 "1500 x 2000 x 300" 一次性给出长宽高
  function extractWeightAndDims() {
    const out = {};
    const reW   = /вес|масса|брутто|нетто|weight|net\s*weight|gross|重量|净重|毛重|质量|重\s*量/i;
    const reLen = /длина|length|长[度]?(?!.*?宽)|глубин|глубина|depth|深/i;
    const reWid = /ширина|width|宽[度]?/i;
    const reHei = /высота|height|высоту|толщин|高[度]?|厚[度]?/i;
    const reDim = /размер[ыа]?|габарит|dimension|пакет|упаков|объ[её]мн|尺寸|外形|包装|长.*宽.*高/i;

    // 单位转换：返回克 (g)
    const toGrams = (numStr, unit) => {
      const n = parseFloat(String(numStr).replace(',', '.'));
      if (!isFinite(n) || n <= 0) return null;
      const u = String(unit || '').toLowerCase();
      if (/кг|kg|公斤|千克/.test(u)) return Math.round(n * 1000);
      if (/мг|mg|毫克/.test(u))      return Math.round(n / 1000);
      return Math.round(n); // г / g / 克 / 缺省
    };
    // 单位转换：返回厘米 (cm)
    const toCm = (numStr, unit) => {
      const n = parseFloat(String(numStr).replace(',', '.'));
      if (!isFinite(n) || n <= 0) return null;
      const u = String(unit || '').toLowerCase();
      if (/мм|mm|毫米/.test(u)) return +(n / 10).toFixed(1);
      if (/^м$|^m$|метр|米/.test(u)) return +(n * 100).toFixed(1);
      return +n.toFixed(1); // см / cm / 缺省按 cm
    };

    // 三维尺寸正则：捕获 "1500 x 2000 x 300 мм" / "150×200×30" / "96 х 96х 110 мм"
    // 注意：Ozon 用 西里尔字母 х (U+0445) 作分隔符，必须显式包含；空格也允许缺省
    const SEP = '[\\s]*[\\u0445\\u0425×x*✕✖][\\s]*';
    const triRe = new RegExp(
      '(\\d+(?:[.,]\\d+)?)' + SEP +
      '(\\d+(?:[.,]\\d+)?)' + SEP +
      '(\\d+(?:[.,]\\d+)?)\\s*(мм|mm|см|cm|метр|m|米|毫米)?',
      'i'
    );
    const numUnit = /(\d+(?:[.,]\d+)?)\s*(мм|mm|см|cm|кг|kg|г|g|公斤|千克|克|毫米|米|m)?/i;

    const scan = (kRaw, vRaw) => {
      if (!kRaw) return;
      const k = String(kRaw);
      const v = vRaw == null ? '' : (Array.isArray(vRaw)
        ? vRaw.map((x) => (x && (x.text || x.value || x.title)) || x).join(' ')
        : (typeof vRaw === 'object' ? (vRaw.text || vRaw.value || vRaw.title || JSON.stringify(vRaw)) : String(vRaw)));
      if (!v) return;

      // 一次性三维尺寸（优先级最高，因为信息最完整）
      if (reDim.test(k) || triRe.test(v)) {
        const m = v.match(triRe);
        if (m) {
          const unit = m[4] || (/мм|mm/i.test(k) ? 'mm' : (/см|cm/i.test(k) ? 'cm' : 'mm'));
          const a = toCm(m[1], unit), b = toCm(m[2], unit), c = toCm(m[3], unit);
          if (a && b && c) {
            // Ozon 习惯：长 × 宽 × 高
            if (out.dimL == null) out.dimL = a;
            if (out.dimW == null) out.dimW = b;
            if (out.dimH == null) out.dimH = c;
            return;
          }
        }
      }

      // 重量
      if (out.weight == null && reW.test(k)) {
        const m = v.match(numUnit);
        if (m) {
          const unitHint = m[2] || (/кг|kg/i.test(k) ? 'kg' : (/г\b|,?\s*г$|,\s*g/i.test(k) ? 'g' : ''));
          const g = toGrams(m[1], unitHint);
          if (g) out.weight = g;
        }
        return;
      }

      // 单维度
      const single = v.match(numUnit);
      if (!single) return;
      const unitHint = single[2] || (/мм|mm/i.test(k) ? 'mm' : (/см|cm/i.test(k) ? 'cm' : ''));
      const cm = toCm(single[1], unitHint);
      if (!cm) return;
      if (out.dimL == null && reLen.test(k)) out.dimL = cm;
      else if (out.dimW == null && reWid.test(k)) out.dimW = cm;
      else if (out.dimH == null && reHei.test(k)) out.dimH = cm;
    };

    // 解析复合字段：可能是 string、{textRs:[{content}]}、[{text|content|value}]、{text|content|value}
    const flatten = (x) => {
      if (x == null) return '';
      if (typeof x === 'string') return x;
      if (Array.isArray(x)) return x.map(flatten).filter(Boolean).join(' ');
      if (typeof x !== 'object') return String(x);
      if (x.textRs) return flatten(x.textRs);
      if (x.content != null) return flatten(x.content);
      if (x.text != null)    return flatten(x.text);
      if (x.value != null)   return flatten(x.value);
      if (x.title != null)   return flatten(x.title);
      return '';
    };

    // 递归遍历 JSON：把 key/value 都用 flatten 统一抽出文本
    const seen = new WeakSet();
    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const keyField = node.key ?? node.name ?? node.title;
      const valField = node.shortValue ?? node.fullValue ?? node.value ?? node.values ?? node.text;
      if (keyField != null && valField != null) {
        const k = flatten(keyField);
        const v = flatten(valField);
        if (k && v) scan(k, v);
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === 'object') walk(v);
      }
    };

    // 1) 主路径：参考极掌主插件，定位含 characteristics 数组的 data-state 节点
    //    Ozon 特征结构：{ title: { textRs: [{content}] }, values: [{text}] }
    let charsBlock = null;
    document.querySelectorAll('[data-state]').forEach((el) => {
      if (charsBlock) return;
      const raw = el.getAttribute('data-state');
      if (!raw || raw.length < 10) return;
      try {
        const data = JSON.parse(raw);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          // characteristics 可能嵌套在子层，先查顶层；找不到再 walk 全树后回填
          if (Array.isArray(data.characteristics)) charsBlock = data;
          // 同时执行通用 walk
          walk(data);
        }
      } catch (_) {}
    });
    if (charsBlock?.characteristics) {
      charsBlock.characteristics.forEach((c) => {
        if (!c || typeof c !== 'object') return;
        const title = flatten(c.title) || flatten(c.name) || flatten(c.key);
        const value = flatten(c.values) || flatten(c.shortValue) || flatten(c.fullValue) || flatten(c.value);
        if (title && value) scan(title, value);
      });
    }

    // 2) DOM 兜底：dl/dt/dd 与 table tr
    const allFilled = () =>
      out.weight != null && out.dimL != null && out.dimW != null && out.dimH != null;
    if (!allFilled()) {
      document.querySelectorAll('dl').forEach((dl) => {
        const dts = dl.querySelectorAll('dt');
        const dds = dl.querySelectorAll('dd');
        const n = Math.min(dts.length, dds.length);
        for (let i = 0; i < n; i++) scan(dts[i].textContent, dds[i].textContent);
      });
      document.querySelectorAll('tr').forEach((tr) => {
        const tds = tr.querySelectorAll('td,th');
        if (tds.length >= 2) scan(tds[0].textContent, tds[1].textContent);
      });
    }

    // 3) DOM 同级两子元素（Ozon 新布局：div > 两个 span/div 文本对）
    if (!allFilled()) {
      const widgets = document.querySelectorAll(
        '[data-widget*="haracteristic"], [data-widget="webShortCharacteristic"]'
      );
      const roots = widgets.length ? widgets : [document.body];
      roots.forEach((root) => {
        root.querySelectorAll('div, li').forEach((row) => {
          const kids = Array.from(row.children).filter(
            (c) => (c.textContent || '').trim().length
          );
          if (kids.length !== 2) return;
          const k = (kids[0].textContent || '').trim();
          const v = (kids[1].textContent || '').trim();
          if (!k || !v || k.length > 80 || v.length > 80) return;
          scan(k, v);
        });
      });
    }

    // 4) 文本兜底：拼接特征区可见文本，整段正则匹配
    if (!allFilled()) {
      const widgets = document.querySelectorAll(
        '[data-widget*="haracteristic"], [data-widget*="haracteristics"]'
      );
      let text = '';
      widgets.forEach((w) => { text += '\n' + (w.textContent || ''); });
      if (!text.trim()) text = document.body?.textContent || '';
      // 重量：键词 + 数字 + 单位
      if (out.weight == null) {
        const m = text.match(
          /(?:Вес|вес|Масса|масса|Weight|weight|重量|净重|毛重)[^\d]{0,40}(\d+(?:[.,]\d+)?)\s*(г|кг|g|kg|克|千克|公斤)\b/i
        );
        if (m) {
          const g = toGrams(m[1], m[2]);
          if (g) out.weight = g;
        }
      }
      // 三维尺寸：键词 + 三个数字
      if (out.dimL == null || out.dimW == null || out.dimH == null) {
        const m = text.match(
          /(?:Габариты|габариты|Размер[ыа]?|размер[ыа]?|Dimensions?|尺寸|外形|包装)[^\d]{0,60}(\d+(?:[.,]\d+)?)\s*[×x*✕✖]\s*(\d+(?:[.,]\d+)?)\s*[×x*✕✖]\s*(\d+(?:[.,]\d+)?)\s*(мм|mm|см|cm)?/i
        );
        if (m) {
          const unit = m[4] || (m[0] && /мм|mm/i.test(m[0]) ? 'mm' : (m[0] && /см|cm/i.test(m[0]) ? 'cm' : 'mm'));
          const a = toCm(m[1], unit), b = toCm(m[2], unit), c = toCm(m[3], unit);
          if (a && b && c) {
            if (out.dimL == null) out.dimL = a;
            if (out.dimW == null) out.dimW = b;
            if (out.dimH == null) out.dimH = c;
          }
        }
      }
    }

    return out;
  }

  // 2026-05 删除 fetchCharsFromComposer / autoFillFromComposer (公开 /features/
  // 兜底)。新流程靠 autoFillFromSellerPortal 走 sw.js searchVariants — 内部
  // /api/v1/search + /api/site/seller-prototype/create-bundle-by-variant-id 组合
  // 直接拿后台完整 weight/dim,覆盖率高(包括小百货/服饰)。

  // ── State ───────────────────────────────────────
  let panelEl = null;
  let triggerEl = null;
  let channel = 'CEL';
  let useOldFormula = false; // 平台涨价定价：勾选后黑标 ≤80 用旧公式

  // 6 档 × 3 运输方式（默认全部 economy 陆运经济）
  const TIER_KEYS = ['xs', 'budget', 'small', 'big', 'pSmall', 'pBig'];
  const TIER_META = {
    xs:     { label: 'Extra Small',   range: '0-500g · 货值≤1500₽' },
    budget: { label: 'Budget',        range: '>500g · 货值≤1500₽' },
    small:  { label: 'Small',         range: '0-2kg · 1501-7000₽ · 不计抛' },
    big:    { label: 'Big',           range: '>2kg · 1501-7000₽ · 计抛' },
    pSmall: { label: 'Premium Small', range: '0-5kg · 货值>7000₽' },
    pBig:   { label: 'Premium Big',   range: '>5kg · 货值>7000₽ · 计抛' },
  };
  const TRANSPORT_TYPES = [
    { key: 'fast',    label: '陆空特快',  icon: 'plane' },
    { key: 'std',     label: '陆空标准',  icon: 'plane' },
    { key: 'economy', label: '陆运经济',  icon: 'truck' },
  ];
  const defaultChannelCfg = () => Object.fromEntries(TIER_KEYS.map((k) => [k, 'economy']));
  let celConfig  = normalizeChannelCfg('CEL',  defaultChannelCfg());
  let guooConfig = normalizeChannelCfg('GUOO', defaultChannelCfg());
  let xyConfig   = normalizeChannelCfg('XY',   defaultChannelCfg());
  let ztoConfig  = normalizeChannelCfg('ZTO',  defaultChannelCfg());

  // 根据计费重 + 货值，匹配档位 key
  // 用「实重 + 货值」决定档位（货值边界 1500/7000 卢布与 Excel 一致）
  function matchTierKey(actualWeightG, priceCNY) {
    const w = actualWeightG || 0;
    const p = priceCNY || 0;
    const v = p * DPI_FACTOR;
    if (v <= VALUE_LO) return w <= W_XS ? 'xs' : 'budget';
    if (v <= VALUE_HI) return w <= W_SMALL ? 'small' : 'big';
    return w <= W_PSMALL ? 'pSmall' : 'pBig';
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.className = `${P}-panel`;
    panel.setAttribute('lang', 'zh-Hans');
    const _hdrBrand = globalThis.__JZ_BRAND__;
    const _hdrMark = _hdrBrand.logoUrl
      ? `<div class="${P}-brand-mark"><img src="${_hdrBrand.logoUrl}" alt=""></div>`
      : `<div class="${P}-brand-mark">${_hdrBrand.displayName[0]}</div>`;
    panel.innerHTML = `
      <div class="${P}-header" data-drag>
        ${_hdrMark}
        <div class="${P}-brand-text">
          <span class="${P}-brand-name">${_hdrBrand.displayName}算价</span>
          <span class="${P}-brand-sub">Ozon 跨境利润计算</span>
        </div>
        <div class="${P}-spacer"></div>
        <div class="${P}-sku" data-f="sku">—</div>
        <div class="${P}-actions">
          <button data-action="min" title="最小化">−</button>
          <button data-action="close" title="关闭">×</button>
        </div>
      </div>

      <div class="${P}-body">
        <!-- Hero -->
        <div class="${P}-hero empty" data-f="hero">
          <div class="${P}-hero-top">
            <div class="${P}-chip" data-f="statusChip">待输入</div>
          </div>
          <div class="${P}-profit-row">
            <div class="${P}-profit-main">
              <div class="${P}-profit-label">预估单件净利润</div>
              <div class="${P}-profit-num">
                <span class="sym">¥</span>
                <span class="big" data-f="profit">0.00</span>
              </div>
            </div>
            <div class="${P}-rate-badge">
              <div class="l">利润率</div>
              <div class="v" data-f="rate">0%</div>
            </div>
          </div>
          <div class="${P}-ruler">
            <div class="${P}-ruler-scale">
              <span>0%</span><span class="mid">安全线 15%</span><span>40%+</span>
            </div>
            <div class="${P}-ruler-track">
              <div class="${P}-ruler-fill" data-f="rulerFill" style="width:0%"></div>
              <div class="${P}-ruler-tick"></div>
            </div>
          </div>
        </div>

        <div class="${P}-banner" data-f="banner">
          <div class="${P}-banner-ic">!</div>
          <div data-f="bannerText"></div>
        </div>

        <!-- Price conversion -->
        <div class="${P}-section">
          <div class="${P}-section-head">
            <span class="${P}-section-label">Ozon 价格换算</span>
            <span class="${P}-section-hint" data-f="formula">—</span>
          </div>
          <div class="${P}-pricetags">
            <label class="${P}-pricetag">
              <span class="${P}-pricetag-badge" style="background:#0a0c14">黑标</span>
              <input class="num" type="number" step="0.01" data-f="blackPrice" placeholder="—"/>
            </label>
            <label class="${P}-pricetag">
              <span class="${P}-pricetag-badge" style="background:#00a046">绿标</span>
              <input class="num" type="number" step="0.01" data-f="greenPrice" placeholder="—"/>
            </label>
            <label class="${P}-pricetag strong">
              <span class="${P}-pricetag-badge" style="background:#005bff">实际售价</span>
              <input class="num" type="text" readonly data-f="actualPrice" placeholder="—"/>
            </label>
          </div>
        </div>

        <!-- Specs -->
        <div class="${P}-section">
          <div class="${P}-section-head">
            <span class="${P}-section-label">成本与规格</span>
          </div>
          <div class="${P}-specs">
            <label class="${P}-spec">
              <div class="${P}-spec-head"><span>定价</span><span>¥</span></div>
              <input type="number" step="0.01" data-f="price" placeholder="—"/>
            </label>
            <label class="${P}-spec">
              <div class="${P}-spec-head"><span>采购</span><span>¥</span></div>
              <input type="number" step="0.01" data-f="cost" placeholder="—"/>
            </label>
            <label class="${P}-spec">
              <div class="${P}-spec-head"><span>重量</span><span>g</span></div>
              <input type="number" step="1" data-f="weight" placeholder="—"/>
            </label>
          </div>
        </div>

        <!-- Tiers -->
        <div class="${P}-section">
          <div class="${P}-section-head">
            <span class="${P}-section-label">Ozon 佣金档位</span>
            <span class="${P}-section-hint primary">点击费率可自定义</span>
            <button class="${P}-tier-reset" data-action="reset-tier-rate" title="重置为默认 13/15/17">↺ 重置</button>
          </div>
          <div class="${P}-tiers">
            <div class="${P}-tier-card" data-tier="1">
              <span class="${P}-tier-current">当前</span>
              <div class="${P}-tier-name">T1 · 基础档</div>
              <div class="${P}-tier-rate-wrap">
                <input class="${P}-tier-rate" data-tier-rate="1" type="number" min="0" max="100" step="0.1" value="13"/>
                <span class="${P}-tier-rate-suffix">%</span>
              </div>
              <div class="${P}-tier-range">定价 ≤ ¥135</div>
            </div>
            <div class="${P}-tier-card" data-tier="2">
              <span class="${P}-tier-current">当前</span>
              <div class="${P}-tier-name">T2 · 标准档</div>
              <div class="${P}-tier-rate-wrap">
                <input class="${P}-tier-rate" data-tier-rate="2" type="number" min="0" max="100" step="0.1" value="15"/>
                <span class="${P}-tier-rate-suffix">%</span>
              </div>
              <div class="${P}-tier-range">¥135–437</div>
            </div>
            <div class="${P}-tier-card" data-tier="3">
              <span class="${P}-tier-current">当前</span>
              <div class="${P}-tier-name">T3 · 高价档</div>
              <div class="${P}-tier-rate-wrap">
                <input class="${P}-tier-rate" data-tier-rate="3" type="number" min="0" max="100" step="0.1" value="17"/>
                <span class="${P}-tier-rate-suffix">%</span>
              </div>
              <div class="${P}-tier-range">&gt; ¥437</div>
            </div>
          </div>
        </div>

        <!-- Channel -->
        <div class="${P}-section">
          <div class="${P}-channels">
            <div class="${P}-channels-head">
              <span class="${P}-channels-label">国际物流</span>
              <span class="${P}-fx-chip" data-f="fxChip" data-action="refresh-fx" title="人民币兑卢布汇率（用于物流货值档位边界 1500/7000₽）· 点击重新拉取">¥1≈₽12 · 兜底</span>
            </div>
            <div class="${P}-channels-group">
              <div class="${P}-ch-cell active" data-ch-cell="CEL">
                <button class="${P}-ch active" data-ch="CEL">
                  <div class="${P}-ch-name">CEL</div>
                  <div class="${P}-ch-sub" data-f="chSub_CEL">陆运经济</div>
                </button>
                <button class="${P}-ch-gear" data-action="open-cfg" data-channel="CEL" title="CEL 渠道运输方式配置">${window.lucideIcon('settings', 12)}</button>
              </div>
              <div class="${P}-ch-cell" data-ch-cell="GUOO">
                <button class="${P}-ch" data-ch="GUOO">
                  <div class="${P}-ch-name">GUOO</div>
                  <div class="${P}-ch-sub" data-f="chSub_GUOO">陆运经济</div>
                </button>
                <button class="${P}-ch-gear" data-action="open-cfg" data-channel="GUOO" title="GUOO 渠道运输方式配置">${window.lucideIcon('settings', 12)}</button>
              </div>
              <div class="${P}-ch-cell" data-ch-cell="XY">
                <button class="${P}-ch" data-ch="XY">
                  <div class="${P}-ch-name">兴远</div>
                  <div class="${P}-ch-sub" data-f="chSub_XY">陆运经济</div>
                </button>
                <button class="${P}-ch-gear" data-action="open-cfg" data-channel="XY" title="兴远 XY 渠道运输方式配置">${window.lucideIcon('settings', 12)}</button>
              </div>
              <div class="${P}-ch-cell" data-ch-cell="ZTO">
                <button class="${P}-ch" data-ch="ZTO">
                  <div class="${P}-ch-name">ZTO</div>
                  <div class="${P}-ch-sub" data-f="chSub_ZTO">陆运经济</div>
                </button>
                <button class="${P}-ch-gear" data-action="open-cfg" data-channel="ZTO" title="中通 ZTO rFBS 渠道运输方式配置">${window.lucideIcon('settings', 12)}</button>
              </div>
              <div class="${P}-ch-cell" data-ch-cell="EUB">
                <button class="${P}-ch" data-ch="EUB">
                  <div class="${P}-ch-name">E邮宝</div>
                  <div class="${P}-ch-sub">俄罗斯专线</div>
                </button>
              </div>
              <div class="${P}-ch-cell" data-ch-cell="EBP">
                <button class="${P}-ch" data-ch="EBP">
                  <div class="${P}-ch-name">E包裹</div>
                  <div class="${P}-ch-sub">≤¥1000</div>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Breakdown · 视觉层级强化：总计置顶 + 列表降噪 -->
        <div class="${P}-section ${P}-breakdown-section">
          <div class="${P}-break-hero">
            <div class="${P}-break-hero-top">
              <span class="${P}-break-hero-kicker">≈ 每件运营总投入</span>
              <span class="${P}-break-hero-unit">单件 · 人民币</span>
            </div>
            <div class="${P}-break-hero-num" data-f="bkTotal">¥—</div>
          </div>
          <div class="${P}-break-list-label">分项</div>
          <div class="${P}-breakdown">
            <div class="${P}-break-row" data-cat="cost">
              <span class="${P}-break-ic"></span>
              <span class="k">商品采购</span>
              <span class="v" data-f="bkCost">—</span>
            </div>
            <div class="${P}-break-row" data-cat="freight">
              <span class="${P}-break-ic"></span>
              <div class="${P}-break-row-label">
                <span class="k">国际运费</span>
                <span class="${P}-break-row-sub" data-f="bkFreightSub">CEL · Extra Small · 陆运经济</span>
              </div>
              <span class="v" data-f="bkFreight">—</span>
            </div>
            <div class="${P}-break-row" data-cat="comm">
              <span class="${P}-break-ic"></span>
              <span class="k" data-f="bkCommLabel">Ozon 佣金 · T1 · 13%</span>
              <span class="v" data-f="bkComm">—</span>
            </div>
            <div class="${P}-break-row" data-cat="plat">
              <span class="${P}-break-ic"></span>
              <span class="k">平台处理费 · 4%</span>
              <span class="v" data-f="bkPlat">—</span>
            </div>
            <div class="${P}-break-row" data-cat="label">
              <span class="${P}-break-ic"></span>
              <span class="k">贴单服务</span>
              <span class="v">−¥2.00</span>
            </div>
          </div>
        </div>

        <!-- Volumetric -->
        <div class="${P}-section">
          <div class="${P}-section-head">
            <span class="${P}-section-label">计抛检查 · L×W×H / 12000 (中通小件 24000)</span>
            <span class="${P}-vol-tag" data-f="volTag" style="display:none"></span>
          </div>
          <div class="${P}-specs">
            <label class="${P}-spec">
              <div class="${P}-spec-head"><span>长</span><span>cm</span></div>
              <input type="number" step="0.1" data-f="dimL" placeholder="—"/>
            </label>
            <label class="${P}-spec">
              <div class="${P}-spec-head"><span>宽</span><span>cm</span></div>
              <input type="number" step="0.1" data-f="dimW" placeholder="—"/>
            </label>
            <label class="${P}-spec">
              <div class="${P}-spec-head"><span>高</span><span>cm</span></div>
              <input type="number" step="0.1" data-f="dimH" placeholder="—"/>
            </label>
          </div>
        </div>
      </div>

      <div class="${P}-quick-actions">
        <button class="${P}-quick-btn warn" data-action="open-prohibited">${window.lucideIcon('ban', 13)} 禁运清单</button>
      </div>

      <div class="${P}-section ${P}-old-formula-row">
        <label class="${P}-checkbox-label">
          <input type="checkbox" data-f="useOldFormula"/>
          <span>平台涨价定价</span>
          <span class="${P}-checkbox-hint">勾选后，黑标 ≤80 使用旧公式计算</span>
        </label>
      </div>

      <div class="${P}-footer">
        <button class="${P}-cta" data-action="export">${window.lucideIcon('copy', 13)} 复制结果</button>
      </div>

      <div class="${P}-modal" data-modal="cfg-CEL">
        <div class="${P}-modal-card">
          <div class="${P}-modal-head">
            <span class="${P}-modal-title">CEL 渠道运输方式配置</span>
            <button class="${P}-modal-close" data-action="close-modal">×</button>
          </div>
          <div class="${P}-modal-sub">请为每个档位选择运输方式，配置会自动保存</div>
          <div class="${P}-modal-body" data-cfg-body="CEL"></div>
          <div class="${P}-modal-foot">
            <button class="${P}-modal-btn" data-action="close-modal">关闭</button>
          </div>
        </div>
      </div>

      <div class="${P}-modal" data-modal="cfg-GUOO">
        <div class="${P}-modal-card">
          <div class="${P}-modal-head">
            <span class="${P}-modal-title">GUOO 渠道运输方式配置</span>
            <button class="${P}-modal-close" data-action="close-modal">×</button>
          </div>
          <div class="${P}-modal-sub">请为每个档位选择运输方式，配置会自动保存</div>
          <div class="${P}-modal-body" data-cfg-body="GUOO"></div>
          <div class="${P}-modal-foot">
            <button class="${P}-modal-btn" data-action="close-modal">关闭</button>
          </div>
        </div>
      </div>

      <div class="${P}-modal" data-modal="cfg-XY">
        <div class="${P}-modal-card">
          <div class="${P}-modal-head">
            <span class="${P}-modal-title">兴远 XY 渠道运输方式配置</span>
            <button class="${P}-modal-close" data-action="close-modal">×</button>
          </div>
          <div class="${P}-modal-sub">兴远渠道仅提供 陆空标准 / 陆运经济（无 陆空特快）</div>
          <div class="${P}-modal-body" data-cfg-body="XY"></div>
          <div class="${P}-modal-foot">
            <button class="${P}-modal-btn" data-action="close-modal">关闭</button>
          </div>
        </div>
      </div>

      <div class="${P}-modal" data-modal="cfg-ZTO">
        <div class="${P}-modal-card">
          <div class="${P}-modal-head">
            <span class="${P}-modal-title">中通 ZTO rFBS 运输方式配置</span>
            <button class="${P}-modal-close" data-action="close-modal">×</button>
          </div>
          <div class="${P}-modal-sub">ZTO Big 仅 Standard；计抛除数 大件 (Big / Premium Big) 用 12000,其他档用 24000</div>
          <div class="${P}-modal-body" data-cfg-body="ZTO"></div>
          <div class="${P}-modal-foot">
            <button class="${P}-modal-btn" data-action="close-modal">关闭</button>
          </div>
        </div>
      </div>

      <div class="${P}-modal" data-modal="prohibited">
        <div class="${P}-modal-card">
          <div class="${P}-modal-head">
            <span class="${P}-modal-title">${window.lucideIcon('ban', 14)} 禁运清单</span>
            <button class="${P}-modal-close" data-action="close-modal">×</button>
          </div>
          <div class="${P}-modal-body">
            <p style="margin:0 0 10px;font-size:12px;color:#3a3e47;line-height:1.7;">
              <b>以下品类禁止运输到 Ozon 仓：</b>
            </p>
            <ul class="${P}-prohibited-list">
              <li>${window.lucideIcon('battery', 13)} 纯电产品（移动电源、电池等）</li>
              <li>${window.lucideIcon('flask', 13)} 白色粉末、化学制剂</li>
              <li>${window.lucideIcon('droplet', 13)} 液体、膏体（化妆品、洗护用品等）</li>
              <li>${window.lucideIcon('alert-triangle', 13)} 危险品、易燃易爆品</li>
              <li>${window.lucideIcon('pill', 13)} 处方药、保健品</li>
              <li>${window.lucideIcon('crosshair', 13)} 仿真枪械、刀具</li>
              <li>${window.lucideIcon('cigarette', 13)} 烟酒</li>
              <li>${window.lucideIcon('radio', 13)} 涉政、宗教、色情敏感物品</li>
            </ul>
            <p style="margin:10px 0 0;font-size:11px;color:#9aa0a8;line-height:1.5;">
              ⓘ 如不确定您的商品是否禁运，建议联系物流商确认，避免清关被扣。
            </p>
          </div>
          <div class="${P}-modal-foot">
            <button class="${P}-modal-btn" data-action="close-modal">我知道了</button>
          </div>
        </div>
      </div>
    `;
    return panel;
  }

  // 渲染单个渠道配置 modal 的 6 档列表
  function renderChannelCfgBody(channelName) {
    const body = panelEl.querySelector(`[data-cfg-body="${channelName}"]`);
    if (!body) return;
    const cfg = channelCfgRef(channelName);
    const table = freightTableFor(channelName);
    if (!cfg || !table) return;
    body.innerHTML = TIER_KEYS.map((k) => {
      const meta = TIER_META[k];
      const tier = table[k];
      const buttons = TRANSPORT_TYPES.map((t) => {
        const available = tier.rates[t.key] != null;
        const active = available && cfg[k] === t.key;
        const cls = `${P}-tt-btn${active ? ' active' : ''}${available ? '' : ' disabled'}`;
        const attrs = available
          ? `data-cfg-set="${channelName}" data-cfg-tier="${k}" data-cfg-type="${t.key}"`
          : `disabled aria-disabled="true" title="${channelName} · ${meta.label} 不支持${t.label}"`;
        return `<button class="${cls}" ${attrs}>
          <span class="${P}-tt-ic">${window.lucideIcon(t.icon, 12)}</span>${t.label}
        </button>`;
      }).join('');
      return `
        <div class="${P}-tt-tier">
          <div class="${P}-tt-tier-head">
            <span class="${P}-tt-tier-name">${meta.label}</span>
            <span class="${P}-tt-tier-range">${meta.range}</span>
          </div>
          <div class="${P}-tt-tier-btns">${buttons}</div>
        </div>
      `;
    }).join('');
  }

  function showTrigger() {
    if (triggerEl) return;
    const btn = document.createElement('button');
    btn.className = `${P}-trigger`;
    btn.title = `${globalThis.__JZ_BRAND__.displayName} 算价 · 点击展开`;
    btn.textContent = '极';
    btn.addEventListener('click', () => {
      btn.remove();
      triggerEl = null;
      mountPanel();
    });
    document.body.appendChild(btn);
    triggerEl = btn;
  }

  function mountPanel() {
    if (panelEl && document.contains(panelEl)) return;
    if (!document.body) {
      setTimeout(mountPanel, 200);
      return;
    }
    document.querySelectorAll(`.${P}-panel`).forEach((n) => n.remove());

    const panel = buildPanel();
    document.body.appendChild(panel);
    panelEl = panel;

    makeDraggable(panel);
    bindEvents();
    loadSettings();          // 内部依次：恢复偏好 → 恢复 SKU specs → autoFillFromPage(true) → recalcAll
    TIERED_CHANNELS.forEach(renderChannelCfgBody);
    trackUsage('jzc-calc:open');
  }

  // 通用功能埋点(service-worker 层会按设备做当天去重,失败静默)
  function trackUsage(featureKey) {
    try {
      chrome.runtime.sendMessage({ action: 'usageTrack', featureKey }, () => {
        // 吞掉 lastError,埋点不能影响主流程
        void chrome.runtime.lastError;
      });
    } catch (_) {
      // sw 不可达时静默
    }
  }

  // ── Drag ────────────────────────────────────────
  function makeDraggable(panel) {
    const header = panel.querySelector(`.${P}-header`);
    let sx, sy, ox, oy;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top;
      const mv = (ev) => {
        panel.style.left = (ox + ev.clientX - sx) + 'px';
        panel.style.top  = (oy + ev.clientY - sy) + 'px';
        panel.style.right = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        savePosition(panel);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  function savePosition(panel) {
    const r = panel.getBoundingClientRect();
    storageSet({
      [`${LS_STATE}_pos`]: { left: r.left, top: r.top },
    });
  }

  // ── Events ──────────────────────────────────────
  const q = (sel) => panelEl && panelEl.querySelector(sel);
  const qa = (sel) => (panelEl ? panelEl.querySelectorAll(sel) : []);
  const val = (sel) => parseFloat(q(sel)?.value) || 0;

  function bindEvents() {
    qa('input[data-f]').forEach((el) => {
      if (el.readOnly) return;
      el.addEventListener('input', () => {
        // 用户手输 → 标记，自动抓取（DOM/composer/seller portal）永不覆盖
        el.dataset.jzcUserEdited = '1';
        recalcAll();
        saveState();
      });
    });

    qa(`.${P}-ch`).forEach((btn) => {
      btn.addEventListener('click', () => {
        qa(`.${P}-ch`).forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        channel = btn.dataset.ch;
        saveState();
        recalcAll();
      });
    });

    panelEl.addEventListener('click', (e) => {
      const tBtn = e.target.closest('[data-cfg-set]');
      if (tBtn) {
        const ch = tBtn.dataset.cfgSet;
        const tier = tBtn.dataset.cfgTier;
        const type = tBtn.dataset.cfgType;
        const cfg = channelCfgRef(ch);
        if (cfg) cfg[tier] = type;
        renderChannelCfgBody(ch);
        saveState();
        recalcAll();
        return;
      }
      const t = e.target.closest('[data-action]');
      if (!t) return;
      const a = t.dataset.action;
      if (a === 'close') {
        panelEl.remove();
        panelEl = null;
        if (window.__jzcEmbedded) {
          // 嵌入主插件场景: 静默 unmount,不显示 trigger
          if (typeof window.__jzcOnUnmount === 'function') {
            try { window.__jzcOnUnmount(); } catch {}
          }
        } else {
          showTrigger();
        }
      } else if (a === 'min') {
        const minimized = panelEl.classList.toggle('minimized');
        t.textContent = minimized ? '+' : '−';
        saveState();
      } else if (a === 'export') {
        copyBreakdown(t);
      } else if (a === 'open-cfg') {
        const ch = t.dataset.channel;
        const m = panelEl.querySelector(`[data-modal="cfg-${ch}"]`);
        if (m) m.classList.add('show');
      } else if (a === 'open-prohibited') {
        const m = panelEl.querySelector('[data-modal="prohibited"]');
        if (m) m.classList.add('show');
      } else if (a === 'close-modal') {
        const m = t.closest(`.${P}-modal`);
        if (m) m.classList.remove('show');
      } else if (a === 'reset-tier-rate') {
        TIER_RATE = { ...DEFAULT_TIER_RATE };
        applyTierRateToInputs();
        saveState();
        recalcAll();
        flashBtn(t, '已重置');
      } else if (a === 'refresh-fx') {
        const orig = t.textContent;
        t.textContent = '拉取中…';
        try {
          chrome.runtime.sendMessage({ type: 'jzc:refreshFx' }, (resp) => {
            if (!resp?.ok) {
              t.textContent = orig;
              flashBtn(t, '拉取失败');
            }
            // 成功时由 storage.onChanged 监听器统一更新 chip 文本与 recalcAll
          });
        } catch {
          t.textContent = orig;
        }
      }
    });

    // Checkbox: 平台涨价定价
    const oldFormulaCb = q('[data-f="useOldFormula"]');
    if (oldFormulaCb) {
      oldFormulaCb.addEventListener('change', (e) => {
        useOldFormula = !!e.target.checked;
        saveState();
        recalcAll();
      });
    }

    // 佣金档位：用户可编辑
    qa(`.${P}-tier-rate[data-tier-rate]`).forEach((inp) => {
      inp.addEventListener('input', (e) => {
        const tier = Number(e.target.dataset.tierRate);
        const v = parseFloat(e.target.value);
        if (tier >= 1 && tier <= 3 && !isNaN(v) && v >= 0 && v <= 100) {
          TIER_RATE[tier] = v;
          saveState();
          recalcAll();
        }
      });
      // 阻止 input 上的点击冒泡到 tier-card
      inp.addEventListener('click', (e) => e.stopPropagation());
    });
  }

  function applyTierRateToInputs() {
    qa(`.${P}-tier-rate[data-tier-rate]`).forEach((inp) => {
      const tier = Number(inp.dataset.tierRate);
      inp.value = TIER_RATE[tier];
    });
  }

  function flashBtn(btn, msg) {
    const orig = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = orig; }, 1200);
  }

  function copyBreakdown(btn) {
    const v = (sel) => q(sel)?.textContent || '—';
    const text = [
      `${globalThis.__JZ_BRAND__.displayName}算价 · ${v(`[data-f="sku"]`)}`,
      `利润: ${v(`[data-f="profit"]`)}  利润率: ${v(`[data-f="rate"]`)}`,
      `---`,
      `黑标: ${q(`[data-f="blackPrice"]`)?.value || '—'}₽  绿标: ${q(`[data-f="greenPrice"]`)?.value || '—'}₽  实际售价: ${q(`[data-f="actualPrice"]`)?.value || '—'}₽`,
      `定价: ${q(`[data-f="price"]`)?.value || '—'}¥  采购: ${q(`[data-f="cost"]`)?.value || '—'}¥  重量: ${q(`[data-f="weight"]`)?.value || '—'}g`,
      `---`,
      `运费: ${v(`[data-f="bkFreight"]`)}  佣金: ${v(`[data-f="bkComm"]`)}  平台费: ${v(`[data-f="bkPlat"]`)}  贴单: −¥2.00`,
      `总成本: ${v(`[data-f="bkTotal"]`)}`,
    ].join('\n');
    navigator.clipboard.writeText(text).then(() => flashBtn(btn, '已复制')).catch(() => flashBtn(btn, '失败'));
  }

  // ── Recalc ──────────────────────────────────────
  function recalcAll() {
    if (!panelEl) return;
    calcActual();
    // 定价(默认 = 实际售价,见 autofill / calcActual)是所有经济计算的统一口径:
    // 佣金档位、佣金、平台费、运费货值、利润全部走它,默认即真实上架售价,口径自洽。
    const price    = val(`[data-f="price"]`);
    const cost     = val(`[data-f="cost"]`);
    const weight   = val(`[data-f="weight"]`);
    const tier     = tierFromPrice(price);
    const commRate = tier ? TIER_RATE[tier] : 15;

    qa(`.${P}-tier-card`).forEach((c) => c.classList.toggle('active', Number(c.dataset.tier) === tier));

    const dimL = val(`[data-f="dimL"]`), dimW = val(`[data-f="dimW"]`), dimH = val(`[data-f="dimH"]`);
    const dimVolume = (dimL > 0 && dimW > 0 && dimH > 0) ? dimL * dimW * dimH : 0;  // cm³
    const volTag = q(`[data-f="volTag"]`);
    volTag.style.display = 'none';

    const hero = q(`[data-f="hero"]`);
    const chip = q(`[data-f="statusChip"]`);
    const profitEl = q(`[data-f="profit"]`);
    const rateEl = q(`[data-f="rate"]`);
    const fill = q(`[data-f="rulerFill"]`);
    const banner = q(`[data-f="banner"]`);

    hero.classList.remove('ok', 'warn', 'danger', 'empty');

    if (price <= 0) {
      hero.classList.add('empty');
      chip.textContent = '待输入';
      profitEl.textContent = '0.00';
      rateEl.textContent = '0%';
      fill.style.width = '0%';
      banner.classList.remove('show', 'warn', 'danger');
      q(`[data-f="bkCost"]`).textContent = '—';
      q(`[data-f="bkFreight"]`).textContent = '—';
      q(`[data-f="bkComm"]`).textContent = '—';
      q(`[data-f="bkPlat"]`).textContent = '—';
      q(`[data-f="bkTotal"]`).textContent = '¥—';
      return;
    }

    const freightInfo = calcFreight(channel, weight, dimVolume, price, dimL, dimW, dimH);
    const freight = freightInfo.fee;
    if (freightInfo.billed > weight && weight > 0) {
      volTag.style.display = '';
      volTag.className = `${P}-vol-tag warn`;
      volTag.textContent = `按体积重 ${Math.round(freightInfo.billed)}g`;
    } else if (weight > 0) {
      volTag.style.display = '';
      volTag.className = `${P}-vol-tag ok`;
      volTag.textContent = '按实重';
    }
    const comm = price * (commRate / 100);
    const platFee = price * PLATFORM_FEE_RATE;
    const totalCost = cost + freight + comm + platFee + LABEL_FEE;
    const profit = price - totalCost;
    // 利润率 = 利润 ÷ 售价（销售利润率），与 15% 安全线、banner 差额同一口径
    const rate = (profit / price) * 100;
    const hasCost = cost > 0;
    // 未填采购价时利润率虚高无意义，不展示（已亏损除外——缺采购价也必亏）
    const showRate = hasCost || profit < 0;

    const danger = profit < 0;
    const warn = !danger && rate < SAFETY_RATE * 100;
    const state = danger ? 'danger' : !hasCost ? 'empty' : warn ? 'warn' : 'ok';
    hero.classList.add(state);
    chip.textContent = danger ? '亏损' : !hasCost ? '未填采购价' : warn ? '利润偏薄' : '利润健康';

    profitEl.textContent = (profit > 0 ? '+' : '') + fmt(profit);
    rateEl.textContent = showRate ? fmt(rate, 1) + '%' : '—';
    fill.style.width = showRate ? Math.max(0, Math.min(100, rate * 2)) + '%' : '0%';

    if (danger) {
      banner.classList.add('show', 'danger');
      banner.classList.remove('warn');
      q(`[data-f="bannerText"]`).innerHTML =
        `<b>正在亏损</b>，建议调价至 <b>¥${fmt(price + Math.abs(profit) + SAFETY_RATE * price, 0)}</b>（达 15% 安全线）`;
    } else if (hasCost && warn) {
      banner.classList.add('show', 'warn');
      banner.classList.remove('danger');
      q(`[data-f="bannerText"]`).innerHTML =
        `距 <b>15% 安全线</b>还差 <b>¥${fmt(SAFETY_RATE * price - profit)}</b>/单，可略微提价或换 ${channel === 'CEL' ? 'GUOO' : 'CEL'}`;
    } else {
      banner.classList.remove('show', 'warn', 'danger');
    }

    q(`[data-f="bkCost"]`).textContent = '−¥' + fmt(cost);
    const chLbl = CHANNEL_LABELS[channel]?.short || channel;
    let freightSub;
    if (freightInfo.type === 'flat') {
      const flags = [];
      if (freightInfo.overWeight) flags.push('超重');
      if (freightInfo.overValue)  flags.push('超额');
      if (freightInfo.sizeBreach) flags.push('尺寸超限');
      freightSub = [chLbl, freightInfo.note, ...flags].filter(Boolean).join(' · ');
    } else {
      const tierLbl  = TIER_META[freightInfo.tierKey]?.label || '';
      const transLbl = TRANSPORT_TYPES.find((t) => t.key === freightInfo.transport)?.label || '';
      const flags = [];
      if (freightInfo.upgradedFrom) {
        const fromLbl = TIER_META[freightInfo.upgradedFrom]?.label || freightInfo.upgradedFrom;
        flags.push(`↑由 ${fromLbl} 升档`);
      }
      if (freightInfo.sizeBreach) flags.push('尺寸超限');
      freightSub = [`${chLbl} · ${tierLbl} · ${transLbl}`, ...flags].join(' · ');
    }
    const subEl = q(`[data-f="bkFreightSub"]`);
    subEl.textContent = freightSub;
    // 配色：超限红 > 升档蓝 > 默认灰
    subEl.className = `${P}-break-row-sub`;
    if (freightInfo.sizeBreach) subEl.classList.add(`${P}-bk-breach`);
    else if (freightInfo.upgradedFrom) subEl.classList.add(`${P}-bk-upgraded`);
    q(`[data-f="bkFreight"]`).textContent = '−¥' + fmt(freight);

    // 尺寸警告 banner（不覆盖亏损红框）：
    //   ① sizeBreach 非空 → 红色「完全超限」（含升档后仍超）
    //   ② upgradedFrom 非空 + 不超 → 黄色「已自动升档·按计抛计」
    if (!danger) {
      if (freightInfo.sizeBreach) {
        const sb = freightInfo.sizeBreach;
        const parts = [];
        if (sb.breachL)   parts.push(`最长边 ${sb.longest}cm > ${sb.maxL}cm`);
        if (sb.breachSum) parts.push(`三边和 ${sb.sum}cm > ${sb.maxSum}cm`);
        banner.classList.add('show', 'danger');
        banner.classList.remove('warn');
        const head = freightInfo.upgradedFrom ? '尺寸完全超限' : `${chLbl} 尺寸超限`;
        q(`[data-f="bannerText"]`).innerHTML =
          `<b>${head}</b> · ${parts.join('，')}，请换渠道或缩小包装`;
      } else if (freightInfo.upgradedFrom) {
        const fromLbl = TIER_META[freightInfo.upgradedFrom]?.label || freightInfo.upgradedFrom;
        const toLbl   = TIER_META[freightInfo.tierKey]?.label || freightInfo.tierKey;
        banner.classList.add('show', 'warn');
        banner.classList.remove('danger');
        q(`[data-f="bannerText"]`).innerHTML =
          `<b>${fromLbl} 尺寸超限</b> · 已自动升 <b>${toLbl}</b>（按计抛计费）`;
      }
    }
    q(`[data-f="bkCommLabel"]`).textContent = `Ozon 佣金 · T${tier} · ${commRate}%`;
    q(`[data-f="bkComm"]`).textContent = '−¥' + fmt(comm);
    q(`[data-f="bkPlat"]`).textContent = '−¥' + fmt(platFee);
    q(`[data-f="bkTotal"]`).textContent = '¥' + fmt(totalCost);

    // 更新国际物流按钮副标题：tiered 渠道按当前档位实际生效的运输方式显示
    // 若 freight 计算用的是当前 channel，tierKey 已知；否则按实重重新匹配档位
    const matchedTier = isFlatChannel(channel)
      ? matchTierKey(weight, price)
      : freightInfo.tierKey;
    TIERED_CHANNELS.forEach((ch) => {
      const el = q(`[data-f="chSub_${ch}"]`);
      if (!el) return;
      const cfg = channelCfgRef(ch);
      const tier = freightTableFor(ch)[matchedTier];
      let t = (cfg && cfg[matchedTier]) || 'economy';
      if (!tier?.rates?.[t]) {
        t = ['economy', 'std', 'fast'].find((k) => tier?.rates?.[k] != null) || 'economy';
      }
      el.textContent = TRANSPORT_TYPES.find((x) => x.key === t)?.label || '陆运经济';
    });
  }

  // 实际售价(真实上架售价)纯计算 —— 返回 number 或 null(没黑标算不出)。
  // calcActual 展示用、autofill 默认定价用。**勿读 actualPrice 展示字段**:它经 fmt
  // 带千分位逗号(如 "1,234.56"),parseFloat 会截成个位 → >=1000 的价被读成 ¥1。
  function computeActual(black, green) {
    black = Number(black); green = Number(green);
    if (!(black > 0)) return null;
    // 默认新公式 (黑−绿)×2.25 + 黑;勾「平台涨价定价」且黑标 ≤80 用旧公式 黑 ÷ 1.0715
    if (useOldFormula && black <= 80) return black / 1.0715;
    return (black - green) * 2.25 + black;
  }

  function calcActual() {
    const black = val(`[data-f="blackPrice"]`);
    const apEl = q(`[data-f="actualPrice"]`);
    const fmEl = q(`[data-f="formula"]`);
    const actual = computeActual(black, val(`[data-f="greenPrice"]`));
    if (actual == null) { apEl.value = ''; fmEl.textContent = '—'; return; }
    apEl.value = fmt(actual, 2);
    fmEl.textContent = (useOldFormula && black <= 80) ? '黑 ÷ 1.0715 (≤80 旧公式)' : '(黑−绿)×2.25 + 黑';
  }

  function autoFillFromPage(onlyEmpty = false) {
    const d = extractProductData();
    // setIf 守则：
    //   ① 用户手输过的字段（jzcUserEdited=1）永不覆盖
    //   ② force=true 时绕过 onlyEmpty 限制（仅 seller portal 走这条）
    //   ③ 否则按 onlyEmpty 模式处理
    const setIf = (key, val, force = false) => {
      if (val == null) return false;
      const el = q(`[data-f="${key}"]`);
      if (!el) return false;
      if (el.dataset.jzcUserEdited === '1') return false;
      const next = String(val);
      if (el.value === next) return false;
      if (!force && onlyEmpty && el.value) return false;
      el.value = next;
      el.classList.add(`${P}-autofilled`);
      setTimeout(() => el.classList.remove(`${P}-autofilled`), 1600);
      return true;
    };

    // ── 价格段：DOM 抓的（同步）
    setIf('blackPrice', d.blackPrice);
    setIf('greenPrice', d.greenPrice);
    if (d.sku) q(`[data-f="sku"]`).textContent = 'SKU ' + d.sku;
    // 定价默认 = 实际售价(真实上架售价 =(黑−绿)×2.25+黑;页面价已是人民币不做汇率换算)。
    // Ozon 按上架售价扣佣 + 卖家实收按上架售价算,故定价默认取实际售价而非绿标(优惠价)。
    // 算不出(没黑标)时退绿标 → 黑标。用 number 字面回填(不带千分位逗号)。
    const actualDefault = computeActual(d.blackPrice, d.greenPrice);
    if (actualDefault != null && actualDefault > 0) {
      setIf('price', String(Number(actualDefault.toFixed(2))));
    } else if (d.greenPrice != null) {
      setIf('price', d.greenPrice);
    } else if (d.blackPrice != null) {
      setIf('price', d.blackPrice);
    }

    // ── 重量/尺寸：DOM 先填占位（最低优先级），seller portal 回来会强制覆盖
    setIf('weight', d.weight);
    setIf('dimL',   d.dimL);
    setIf('dimW',   d.dimW);
    setIf('dimH',   d.dimH);
    recalcAll();
    saveState();

    // ── 异步抓取(优先级:seller portal > DOM 占位)
    // 2026-05 移除 composer-api /features/ 兜底 — sw.js searchVariants 已切到
    // /api/v1/search + /api/site/seller-prototype/create-bundle-by-variant-id,
    // bundle 直接拿后台完整 weight/dim,覆盖率远高于公开 /features/(小百货/
    // 服饰类目公开页几乎不暴露物理参数)。
    const sku = d.sku || currentSku();
    console.log('[极掌算价] DOM 取数:', { weight: d.weight, dimL: d.dimL, dimW: d.dimW, dimH: d.dimH });

    // 把 jzc-calc 抓到的 normalized 重量/尺寸 持久化到 chrome.storage.local,
    // 跨 tab 共享给搜索页/列表页数据卡片(用户浏览过的 SKU 下次在任意位置
    // 看到都有完整数据)。字段映射:weight→weightG,dimL/W/H→length/width/heightMm
    const persistJzc = (src, label) => {
      if (!sku || !src || !window.jzPersistWeightDims) return;
      window.jzPersistWeightDims(sku, {
        weightG: src.weight,
        lengthMm: src.dimL,
        widthMm: src.dimW,
        heightMm: src.dimH,
      }, label);
    };
    // DOM 取数:可能有部分字段,合并策略由 jzPersistWeightDims 处理(不覆盖已有非空)
    persistJzc(d, 'jzc-dom');

    const applyExtra = (extra, force = false) => {
      let t = false;
      ['weight', 'dimL', 'dimW', 'dimH'].forEach((f) => {
        if (extra[f] != null) t = setIf(f, extra[f], force) || t;
      });
      if (t) { recalcAll(); saveState(); }
      return t;
    };

    if (sku) {
      autoFillFromSellerPortal(sku).then((sp) => {
        console.log('[极掌算价] seller portal 取数:', sp);
        if (['weight', 'dimL', 'dimW', 'dimH'].some((f) => sp[f] != null)) {
          persistJzc(sp, 'jzc-seller');
          applyExtra(sp, /* force */ true);
        }
      });
    }
    return d;
  }

  // Seller Portal: 通过 background 调标准 searchVariants action
  // (sw.js 2026-05 已切到 /api/v1/search + /api/site/seller-prototype/
  // create-bundle-by-variant-id 组合,bundle 注入物理 attr 到 items[0].attributes)。
  //
  // 历史 bug:这里原本用 message.type='jzc:searchVariants',但 sw.js dispatch
  // 是 switch(message.action) — 完全没命中,seller portal 路径从未工作过。
  // 改成 action='searchVariants' 后享受 bundle 物理 attr。
  //
  // 返回值 attributes 数组约定 key:
  //   4383 = 重量(g),回退 4497 = 含包装重量(g) ← sw.js bundle 注入此 key
  //   9454 = depth(mm) → length;9455 = width(mm);9456 = height(mm)
  // 需用户已登录 seller.ozon.ru;未登录时 background 抛错,本函数返回空对象。
  // 同 sku 多次调用复用 in-memory 缓存(sw.js 也有 30d storage.local cache)。
  const _sellerPortalCache = new Map();
  async function autoFillFromSellerPortal(sku) {
    if (!sku) return {};
    if (_sellerPortalCache.has(sku)) return _sellerPortalCache.get(sku);
    const promise = new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        resolve(val);
      };
      try {
        chrome.runtime.sendMessage({ action: 'searchVariants', sku }, (resp) => {
          if (chrome.runtime.lastError) {
            console.warn('[极掌算价] seller portal: ' + chrome.runtime.lastError.message);
            finish({});
            return;
          }
          if (!resp?.ok) {
            console.warn('[极掌算价] seller portal:', resp?.error || 'no response');
            finish({});
            return;
          }
          const items = resp.data?.items || [];
          const item =
            items.find((it) => String(it.variant_id) === String(sku)) ||
            items.find((it) => String(it.product_id) === String(sku)) ||
            items[0];
          if (!item?.attributes) { finish({}); return; }
          const attr = new Map(item.attributes.map((a) => [String(a.key), a]));
          const num = (k) => Number(attr.get(k)?.value) || 0;
          const out = {};
          // 优先 4497 带包装重量(SW 从 bundle 注入的 seller 后台真值),回退 4383 重量(/search 旧/裸重,偏轻)。
          const w = num('4497') || num('4383');
          if (w > 0) out.weight = w;
          const depth = num('9454'), width = num('9455'), height = num('9456');
          if (depth > 0)  out.dimL = +(depth / 10).toFixed(1);
          if (width > 0)  out.dimW = +(width / 10).toFixed(1);
          if (height > 0) out.dimH = +(height / 10).toFixed(1);
          finish(out);
        });
      } catch (e) {
        console.warn('[极掌算价] seller portal: ' + (e?.message || e));
        finish({});
      }
      // 安全超时（background 端 25s + executeScript 自身延时）
      setTimeout(() => finish({}), 30000);
    });
    _sellerPortalCache.set(sku, promise);
    return promise;
  }

  // Ozon 商品页的「特征」widget 经常懒加载，初次 mount 时取不到。
  // 双策略：
  //   A. 退避节奏定时探测（上限 12s，覆盖慢网络）
  //   B. MutationObserver 监听新增 [data-state]，命中即触发一次 autoFill
  let _autoFillObserver = null;
  function scheduleAutoFillRetries() {
    const allFilled = () =>
      ['weight', 'dimL', 'dimW', 'dimH'].every((f) => q(`[data-f="${f}"]`)?.value);

    [600, 1500, 3500, 7000, 12000].forEach((delay) => {
      setTimeout(() => {
        if (!allFilled()) autoFillFromPage(true);
      }, delay);
    });

    if (_autoFillObserver) _autoFillObserver.disconnect();
    let triggered = 0;
    _autoFillObserver = new MutationObserver((muts) => {
      if (allFilled() || triggered > 6) {
        _autoFillObserver?.disconnect();
        return;
      }
      const newStateNode = muts.some((m) =>
        Array.from(m.addedNodes).some(
          (n) =>
            n.nodeType === 1 &&
            (n.matches?.('[data-state]') || n.querySelector?.('[data-state]'))
        )
      );
      if (newStateNode) {
        triggered += 1;
        autoFillFromPage(true);
      }
    });
    _autoFillObserver.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => _autoFillObserver?.disconnect(), 30000);
  }

  function currentSku() {
    return location.pathname.match(/\/product\/[^/]*-(\d+)/)?.[1] || null;
  }

  const SPEC_FIELDS = ['price', 'cost', 'weight', 'dimL', 'dimW', 'dimH'];

  function saveState() {
    const state = {
      channel,
      useOldFormula,
      celConfig,
      guooConfig,
      xyConfig,
      ztoConfig,
      tierRate: TIER_RATE,
      minimized: panelEl?.classList.contains('minimized'),
    };
    storageSet({ [LS_STATE]: state });
    saveSkuSpecs();
  }

  function saveSkuSpecs() {
    const sku = currentSku();
    if (!sku) return;
    const specs = { ts: Date.now() };
    SPEC_FIELDS.forEach((f) => {
      const el = q(`[data-f="${f}"]`);
      if (el && el.value) specs[f] = el.value;
    });
    storageGet([LS_SKU_SPECS]).then((r) => {
      const all = r[LS_SKU_SPECS] || {};
      all[sku] = specs;
      storageSet({ [LS_SKU_SPECS]: pruneSkuSpecs(all) });
    });
    trackUsage('jzc-calc:save_specs');
  }

  function pruneSkuSpecs(all) {
    const entries = Object.entries(all);
    if (entries.length <= SKU_SPECS_MAX) return all;
    entries.sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
    return Object.fromEntries(entries.slice(0, SKU_SPECS_MAX));
  }

  // ── 实时汇率 ─────────────────────────────────────
  // 缓存写入由 service-worker.js 负责（每日刷新一次 + onInstalled/onStartup 立即刷一次）。
  // 这里只负责读取、UI 展示、storage 变化时重新计算。
  function applyFxRate(cached) {
    if (cached?.rate && cached.rate > 0) {
      DPI_FACTOR = cached.rate;
    } else {
      DPI_FACTOR = DPI_FACTOR_FALLBACK;
    }
    updateFxChip(cached);
  }

  function updateFxChip(cached) {
    const el = q(`[data-f="fxChip"]`);
    if (!el) return;
    if (cached?.rate && cached.rate > 0) {
      el.textContent = `¥1≈₽${cached.rate.toFixed(2)}`;
      const updated = cached.ts ? new Date(cached.ts).toLocaleString('zh-CN') : '—';
      el.title = `1 CNY ≈ ${cached.rate.toFixed(4)} RUB · 更新于 ${updated} · 来源 ${cached.source || 'open.er-api.com'}`;
      el.classList.remove('fallback');
    } else {
      el.textContent = `¥1≈₽${DPI_FACTOR_FALLBACK} · 兜底`;
      el.title = '汇率拉取失败或尚未拉到，使用默认 12 兜底（点击重试）';
      el.classList.add('fallback');
    }
  }

  async function loadFxRate() {
    const r = await storageGet([LS_FX_RATE]);
    let cached = r[LS_FX_RATE];
    if (!cached?.rate) {
      // 首装时缓存可能还没写入，主动 ping 一次 background
      cached = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'jzc:refreshFx' }, async (resp) => {
            if (resp?.ok && resp.rate > 0) {
              const r2 = await storageGet([LS_FX_RATE]);
              resolve(r2[LS_FX_RATE]);
            } else resolve(null);
          });
        } catch { resolve(null); }
      });
    }
    applyFxRate(cached);
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[LS_FX_RATE]) return;
      const next = changes[LS_FX_RATE].newValue;
      const prevRate = DPI_FACTOR;
      applyFxRate(next);
      if (panelEl && DPI_FACTOR !== prevRate) recalcAll();
    });
  } catch {}

  function loadSettings() {
    storageGet([LS_STATE, `${LS_STATE}_pos`, LS_SKU_SPECS]).then((res) => {
      const state = res[LS_STATE];
      const pos = res[`${LS_STATE}_pos`];
      const allSpecs = res[LS_SKU_SPECS] || {};

      if (state) {
        if (state.channel) {
          channel = state.channel;
          qa(`.${P}-ch`).forEach((b) => b.classList.toggle('active', b.dataset.ch === channel));
        }
        if (state.celConfig && typeof state.celConfig === 'object') {
          celConfig = normalizeChannelCfg('CEL', { ...defaultChannelCfg(), ...state.celConfig });
        }
        if (state.guooConfig && typeof state.guooConfig === 'object') {
          guooConfig = normalizeChannelCfg('GUOO', { ...defaultChannelCfg(), ...state.guooConfig });
        }
        if (state.xyConfig && typeof state.xyConfig === 'object') {
          xyConfig = normalizeChannelCfg('XY', { ...defaultChannelCfg(), ...state.xyConfig });
        }
        if (state.ztoConfig && typeof state.ztoConfig === 'object') {
          ztoConfig = normalizeChannelCfg('ZTO', { ...defaultChannelCfg(), ...state.ztoConfig });
        }
        if (state.useOldFormula) {
          useOldFormula = true;
          const cb = q('[data-f="useOldFormula"]');
          if (cb) cb.checked = true;
        }
        if (state.tierRate && typeof state.tierRate === 'object') {
          [1, 2, 3].forEach((k) => {
            const v = parseFloat(state.tierRate[k]);
            if (!isNaN(v) && v >= 0 && v <= 100) TIER_RATE[k] = v;
          });
          applyTierRateToInputs();
        }
        if (state.minimized) {
          panelEl.classList.add('minimized');
          const minBtn = panelEl.querySelector('[data-action="min"]');
          if (minBtn) minBtn.textContent = '+';
        }
        TIERED_CHANNELS.forEach(renderChannelCfgBody);
      }

      // per-SKU spec 字段（先恢复用户编辑过的，再用页面数据补空）
      // 恢复的值视作"用户输入"，标记后自动抓取（DOM/composer/seller portal）不再覆盖
      const sku = currentSku();
      if (sku && allSpecs[sku]) {
        SPEC_FIELDS.forEach((f) => {
          if (allSpecs[sku][f] != null) {
            const el = q(`[data-f="${f}"]`);
            if (el) {
              el.value = allSpecs[sku][f];
              el.dataset.jzcUserEdited = '1';
            }
          }
        });
      }

      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        const maxLeft = window.innerWidth - 60;
        const maxTop = window.innerHeight - 60;
        panelEl.style.left = Math.max(0, Math.min(maxLeft, pos.left)) + 'px';
        panelEl.style.top  = Math.max(0, Math.min(maxTop, pos.top)) + 'px';
        panelEl.style.right = 'auto';
      }

      autoFillFromPage(true);     // 仅填空字段（用户已存的不会被覆盖）
      scheduleAutoFillRetries();  // Ozon 特征 widget 常常懒加载，重试几次
      recalcAll();
      // 拉一次实时汇率（已缓存则直接用缓存）；汇率变化由 storage.onChanged 监听触发 recalcAll
      loadFxRate().then(() => { if (panelEl) recalcAll(); });
    });
  }

  // ── Init ────────────────────────────────────────
  async function init() {
    const migrate = await shouldMigrate();
    if (migrate) {
      if (!migrate.dismissed) renderMigrationToast(migrate.version, migrate.installUrl);
      return;
    }
    mountPanel();
  }

  // 调试入口:在控制台执行 __jzc.debugWeight() 查看抓取过程
  // 用于针对性反馈(哪个 SKU 抓不到 → 把输出贴回来)
  window.__jzc = {
    debugWeight: async () => {
      console.group('[极掌算价] debug');
      console.log('URL:', location.href);
      const dom = extractWeightAndDims();
      console.log('① DOM/data-state 抓取:', dom);
      const skuMatch = location.pathname.match(/\/product\/[^/]*-(\d+)/);
      const sku = skuMatch ? skuMatch[1] : '';
      const seller = sku ? await autoFillFromSellerPortal(sku) : {};
      console.log('② seller portal 抓取:', seller, sku ? `(sku=${sku})` : '(no sku)');
      const stateKeys = [];
      document.querySelectorAll('[data-state]').forEach((el) => {
        try {
          const o = JSON.parse(el.getAttribute('data-state') || '{}');
          if (o && typeof o === 'object') stateKeys.push({
            widget: el.getAttribute('data-widget') || '',
            keys: Object.keys(o).slice(0, 12),
          });
        } catch (_) {}
      });
      console.log('④ 页面 data-state 概览:', stateKeys);
      console.groupEnd();
      return { dom, composer, seller, stateKeys };
    },
  };

  // ── Embedded API (供主插件调用) ──────────────────
  window.__jzcMountPanel = () => {
    window.__jzcEmbedded = true;
    mountPanel();
  };
  window.__jzcUnmountPanel = () => {
    document.querySelectorAll(`.${P}-panel`).forEach((n) => n.remove());
    panelEl = null;
    document.querySelectorAll(`.${P}-trigger`).forEach((n) => n.remove());
    triggerEl = null;
  };
  window.__jzcIsMounted = () => !!(panelEl && document.contains(panelEl));
  window.__jzcInit = init; // 留给 lite standalone 入口手动调用

  // 默认不自动启动 — 由主插件控制 mount/unmount。
  // 如需 standalone 启动,调 window.__jzcInit() 即可。
})();
