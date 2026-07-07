/**
 * 1688-ai-wizard.js — 「AI 采集上架」向导（注入 detail.1688.com/offer/*）
 *
 * 对齐「乌拉 AI 采集」那种 4 步向导，但全部复用本项目已有后端能力，不引第三方：
 *   ① 获取数据      —— 数据由 alibaba-1688.js 的 buildPayload() 抓好后传进来
 *   ② 等待选择数据  —— 选店铺/仓库/类目(可留空=AI 自动) + 执行选项(直上/图片翻译/货号前缀) + 商品列表
 *   ③ AI 智能体输出 —— pushSourceCollect 入采集箱 → POST collect-box/:id/ai-listing-draft
 *                      (后端一次产出 重写标题/描述/hashtags + 类目智选 + 改图 + 定价)
 *   ④ 完成          —— 「直上」则自动 confirm + publish 上架
 * 另含「商品图片中心」(采集图按 主图/轮播/详情 分类) 与「系统设置」(AI 引擎信息/目标毛利率)。
 *
 * 入口：注册 window.__JZC_OPEN_AI_WIZARD__(raw)，由 alibaba-1688.js 面板的「AI 采集」按钮调用。
 * 通信：自带 bg() 包 chrome.runtime.sendMessage；用到的 background action 都已存在
 *       (pushSourceCollect / getStores / getWarehouses / getCategoryTree / getAiQuota /
 *        aiListingDraftCreate / aiListingDraftConfirm / aiListingDraftPublish)。
 *
 * AI Key 说明：本项目 AI 由后端统一托管(DMXAPI)，扩展端无需填 key —— 故「系统设置」只
 * 展示引擎/配额，不像乌拉那样让用户填阿里百炼 key。
 */

(() => {
  if (window.__JZC_AI_WIZARD_LOADED__) return;
  window.__JZC_AI_WIZARD_LOADED__ = true;

  const PRIMARY = '#2168ff';
  const log = (...a) => console.log('[jzc-ai-wizard]', ...a);
  const DEBUG_FLAG_RE = /^(1|true|yes|on)$/i;

  function debugEnabled() {
    try {
      if (window.__JZC_AI_WIZARD_DEBUG__ === true) return true;
      const v = localStorage.getItem('jzc_aiw_debug') || sessionStorage.getItem('jzc_aiw_debug') || '';
      return DEBUG_FLAG_RE.test(String(v).trim());
    } catch {
      return window.__JZC_AI_WIZARD_DEBUG__ === true;
    }
  }

  function listCount(v) { return Array.isArray(v) ? v.length : 0; }

  function debugSummary(message) {
    const body = message?.body || {};
    const raw = message?.raw || {};
    return {
      storeId: message?.storeId || '',
      sourceId: message?.sourceId || '',
      collectId: message?.id || '',
      typeId: body?.category?.typeId || message?.typeId || '',
      descCatId: body?.category?.descriptionCategoryId || '',
      modules: Array.isArray(body?.modules) ? body.modules : undefined,
      attrScope: body?.attrScope || '',
      candidates: listCount(body?.candidates),
      titleLen: typeof body?.title === 'string' ? body.title.length : undefined,
      attrTextLen: typeof body?.attributes === 'string' ? body.attributes.length : undefined,
      rawOfferId: raw?.offerId || '',
      rawTitleLen: typeof raw?.title === 'string' ? raw.title.length : undefined,
      rawImageCount: listCount(raw?.mainImages),
      items: listCount(message?.items),
      stocks: listCount(message?.stocks),
    };
  }

  function debugLog(dir, action, data) {
    if (!debugEnabled()) return;
    try {
      console.log('[jzc-ai-wizard:debug]', JSON.stringify({ dir, action, ...data }));
    } catch {
      console.log('[jzc-ai-wizard:debug]', dir, action);
    }
  }

  // ─────────────────────────────────────────────────────────── state ──
  const W = {
    raw: null,                 // buildPayload() 产出的 1688 商品
    items: [],                 // 商品列表行
    stores: [],
    warehouses: [],
    opts: {
      directListing: true,     // 是否直上
      imageTranslate: false,   // 图片翻译(映射后端 applyPoster 改图)
      offerPrefix: 'DPWL-I',
      storeId: '',
      storeCurrency: 'RUB',    // 选中店铺的绑定货币(companyCurrency)
      warehouseId: '',
      targetMargin: 30,        // 目标毛利率%
    },
    fxRate: null,              // CNY→RUB 实时汇率(getFxRate)
    catTree: null,             // Ozon 类目树(getCategoryTree)
    catTreeLoading: false,
    catTreeError: '',
    catPath: [],               // 已逐级选中的类目节点链
    category: null,            // 选定叶子类目 {typeId, descCatId, name}
    categoryVisualTags: [],     // suggest-category 主图视觉标签,供属性填充复用
    catAuto: '',               // AI 自动匹配状态：''/matching/done:<名>/失败提示
    attrsSchema: [],           // 该类目的属性 schema(getCategoryAttributes)
    reqAttrs: [],              // 必填属性(tier1) [{id,name,dict,value,dictValue,dictValueId,aiFilled,needsManual}]
    ratingAttrs: [],           // 内容评级加分属性(tier2，AI 填充后动态出现)
    packageInfo: null,         // Ozon import 顶层物流字段 {weightG,lengthMm,widthMm,heightMm}
    attrFilling: false,        // AI 填充中
    step: 2,                   // 1获取 2选择 3AI 4完成
    view: 'workbench',         // workbench | images | settings
    aiLog: [],
    generatedContent: null,
    batchPrice: { open: false, mode: 'set', value: '' },
    running: false,
    aiEngine: 'AI 智能体',
  };
  let catTreeReqSeq = 0;
  let warehousesReqSeq = 0;

  const WIZARD_DRAFT_CACHE_VERSION = 1;
  const wizardDraftCache = (() => {
    const key = '__JZC_AI_WIZARD_DRAFT_CACHE__';
    if (!window[key] || typeof window[key].get !== 'function') window[key] = new Map();
    return window[key];
  })();

  function defaultWizardOpts() {
    return {
      directListing: true,
      imageTranslate: false,
      offerPrefix: 'DPWL-I',
      storeId: '',
      storeCurrency: 'RUB',
      warehouseId: '',
      targetMargin: 30,
    };
  }

  function cloneJson(value) {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); }
    catch { return value; }
  }

  function offerIdentity(raw) {
    const r = raw || {};
    const fromRaw = r.offerId || r.offer_id || r.id || '';
    const fromUrl =
      String(location.pathname || '').match(/offer\/(\d+)/)?.[1] ||
      new URLSearchParams(location.search || '').get('offerId') ||
      '';
    return String(fromRaw || fromUrl || location.href || '').trim();
  }

  function wizardDraftCacheKey(raw) {
    const pageKey = `${location.origin || ''}${location.pathname || ''}`;
    return `jzc-aiw-draft:v${WIZARD_DRAFT_CACHE_VERSION}:${pageKey}:${offerIdentity(raw)}`;
  }

  function firstValue(...values) {
    return values.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  }

  function positiveInt(value, fallback) {
    const n = Number(String(value ?? '').match(/[\d.]+/)?.[0]);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
  }

  function packageInfoFromRaw(raw) {
    const p = raw?.packaging || {};
    const hasScraped = !!(
      p.weightG || p.weight || p.lengthMm || p.depthMm || p.lengthCm ||
      p.widthMm || p.widthCm || p.heightMm || p.heightCm
    );
    return {
      weightG: positiveInt(firstValue(p.weightG, p.weight, p.weightGrams), 100),
      lengthMm: positiveInt(firstValue(p.lengthMm, p.depthMm, p.lengthCm != null ? Number(p.lengthCm) * 10 : null), 200),
      widthMm: positiveInt(firstValue(p.widthMm, p.widthCm != null ? Number(p.widthCm) * 10 : null), 200),
      heightMm: positiveInt(firstValue(p.heightMm, p.heightCm != null ? Number(p.heightCm) * 10 : null), 100),
      source: hasScraped ? 'scraped' : 'default',
    };
  }

  function initialItemsFromRaw(raw) {
    const r = raw || {};
    const basePrice = fmtMoney(r.price) || fmtMoney((r.priceRange || '').split('~')[0]) || '';
    const baseImage = (r.mainImages || [])[0] || '';
    const variants = Array.isArray(r.skuList) && r.skuList.length
      ? r.skuList
      : (Array.isArray(r.variants) ? r.variants : []);
    if (!variants.length) return [{
      checked: true,
      image: baseImage,
      skuName: r.title || '采集商品',
      buyPrice: basePrice,
      salePrice: basePrice,
    }];
    return variants.map((v, i) => {
      const aspectName = v?.aspectValues && typeof v.aspectValues === 'object'
        ? Object.values(v.aspectValues).map((x) => String(x || '').trim()).filter(Boolean).join(' ')
        : '';
      const price = fmtMoney(v?.price || v?.salePrice || v?.buyPrice) || basePrice;
      return {
        checked: true,
        sku: v?.sku || v?.skuId || v?.id || `sku-${i + 1}`,
        image: v?.image || (Array.isArray(v?.images) ? v.images[0] : '') || baseImage,
        skuName: v?.skuName || v?.name || v?.title || aspectName || r.title || '采集商品',
        buyPrice: price,
        salePrice: price,
        stock: Number.isFinite(Number(v?.stock)) ? Number(v.stock) : undefined,
        aspectValues: v?.aspectValues || undefined,
      };
    });
  }

  function resetWizardState(raw) {
    W.raw = raw || {};
    W.step = 2;
    W.view = 'workbench';
    W.aiLog = [];
    W.running = false;
    W.items = initialItemsFromRaw(W.raw);
    W.packageInfo = packageInfoFromRaw(W.raw);
    W.generatedContent = null;
    W.batchPrice = { open: false, mode: 'set', value: '' };
    W.opts = defaultWizardOpts();
    W.fxRate = null;
    W.stores = [];
    W.warehouses = [];
    W.catTree = null; W.catTreeLoading = false; W.catTreeError = '';
    W.catPath = []; W.category = null; W.categoryVisualTags = []; W.attrsSchema = []; W.reqAttrs = []; W.ratingAttrs = []; W.attrFilling = false; W.catAuto = '';
  }

  function saveWizardDraft() {
    if (!W.raw) return;
    const key = wizardDraftCacheKey(W.raw);
    if (!offerIdentity(W.raw)) return;
    const draft = {
      version: WIZARD_DRAFT_CACHE_VERSION,
      savedAt: Date.now(),
      items: cloneJson(W.items),
      stores: cloneJson(W.stores),
      warehouses: cloneJson(W.warehouses),
      opts: cloneJson(W.opts),
      fxRate: W.fxRate,
      catTree: W.catTree,
      catTreeError: W.catTreeError || '',
      catPath: W.catPath,
      category: cloneJson(W.category),
      categoryVisualTags: cloneJson(W.categoryVisualTags),
      attrsSchema: cloneJson(W.attrsSchema),
      reqAttrs: cloneJson(W.reqAttrs),
      ratingAttrs: cloneJson(W.ratingAttrs),
      packageInfo: cloneJson(W.packageInfo),
      generatedContent: cloneJson(W.generatedContent),
      step: W.step,
      view: W.view,
      aiLog: cloneJson(W.aiLog),
      catAuto: W.catAuto || '',
      aiEngine: W.aiEngine,
    };
    wizardDraftCache.set(key, draft);
    try {
      const light = { ...draft, catTree: null, catPath: [] };
      sessionStorage.setItem(key, JSON.stringify(light));
    } catch {}
  }

  function restoreWizardDraft(raw) {
    const key = wizardDraftCacheKey(raw);
    const draft = wizardDraftCache.get(key);
    if (!draft || draft.version !== WIZARD_DRAFT_CACHE_VERSION || !draft.catTree) return false;
    W.raw = raw || {};
    W.step = Number(draft.step) || 2;
    W.view = draft.view || 'workbench';
    W.aiLog = Array.isArray(draft.aiLog) ? cloneJson(draft.aiLog) : [];
    W.running = false;
    W.attrFilling = false;
    W.items = Array.isArray(draft.items) && draft.items.length ? cloneJson(draft.items) : initialItemsFromRaw(W.raw);
    W.stores = Array.isArray(draft.stores) ? cloneJson(draft.stores) : [];
    W.warehouses = Array.isArray(draft.warehouses) ? cloneJson(draft.warehouses) : [];
    W.opts = { ...defaultWizardOpts(), ...(draft.opts || {}) };
    W.fxRate = draft.fxRate ?? null;
    W.catTree = draft.catTree;
    W.catTreeLoading = false;
    W.catTreeError = draft.catTreeError || '';
    W.catPath = Array.isArray(draft.catPath) ? draft.catPath : [];
    W.category = draft.category ? cloneJson(draft.category) : null;
    W.categoryVisualTags = Array.isArray(draft.categoryVisualTags) ? cloneJson(draft.categoryVisualTags) : [];
    W.attrsSchema = Array.isArray(draft.attrsSchema) ? cloneJson(draft.attrsSchema) : [];
    W.reqAttrs = Array.isArray(draft.reqAttrs) ? cloneJson(draft.reqAttrs) : [];
    W.ratingAttrs = Array.isArray(draft.ratingAttrs) ? cloneJson(draft.ratingAttrs) : [];
    W.packageInfo = draft.packageInfo ? cloneJson(draft.packageInfo) : packageInfoFromRaw(W.raw);
    W.generatedContent = draft.generatedContent ? cloneJson(draft.generatedContent) : null;
    W.batchPrice = { open: false, mode: 'set', value: '' };
    W.catAuto = draft.catAuto || '';
    W.aiEngine = draft.aiEngine || W.aiEngine;
    return true;
  }

  // 按店铺绑定货币给 1688 成本(人民币)定价。
  // 现成汇率是 CNY→RUB:店铺货币=CNY 不换;否则(RUB 等)按 CNY→RUB 换算。
  function computeSalePrice(costCny, marginPct) {
    const cost = Number(String(costCny ?? '').match(/[\d.]+/)?.[0]) || 0;
    const cur = (W.opts.storeCurrency || 'RUB').toUpperCase();
    const m = Number(marginPct) || 0;
    if (cur === 'CNY') {
      return { price: round2(cost * (1 + m / 100)), currency: 'CNY', costCny: cost, rate: 1 };
    }
    const rate = Number(W.fxRate) || 0;
    if (rate <= 0) {
      return { price: 0, currency: cur, costCny: cost, rate: 0, error: 'missing_fx_rate' };
    }
    return { price: round2(cost * rate * (1 + m / 100)), currency: cur, costCny: cost, rate };
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function applyPricingSnapshot(item, salePrice) {
    const snapshot = {
      costCny: salePrice.costCny,
      fxRate: salePrice.rate,
      targetMargin: Number(W.opts.targetMargin) || 0,
      salePrice: salePrice.price,
      currency: salePrice.currency,
    };
    item.salePrice = fmtMoney(salePrice.price);
    item.pricingSnapshot = snapshot;
    return snapshot;
  }

  // ───────────────────────────────────────────────────────── helpers ──
  function bg(message) {
    return new Promise((resolve) => {
      const debug = debugEnabled();
      const outgoing = debug ? { ...message, _aiwDebug: true } : message;
      const started = Date.now();
      if (debug) debugLog('send', outgoing.action, debugSummary(outgoing));
      try {
        chrome.runtime.sendMessage(outgoing, (resp) => {
          if (debug) {
            debugLog('recv', outgoing.action, {
              ok: !!resp?.ok,
              ms: Date.now() - started,
              error: resp?.ok === false ? String(resp?.error || '').slice(0, 180) : '',
            });
          }
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: '无响应' });
        });
      } catch (e) {
        if (debug) debugLog('error', outgoing.action, { ms: Date.now() - started, error: e?.message || String(e) });
        resolve({ ok: false, error: e?.message || String(e) });
      }
    });
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function toast(text, kind = 'info') {
    const old = document.getElementById('jzc-aiw-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'jzc-aiw-toast';
    el.className = 'jzc-aiw-toast ' + kind;
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function fmtMoney(v) {
    const n = Number(String(v ?? '').match(/[\d.]+/)?.[0]);
    return Number.isFinite(n) ? n.toFixed(2) : '';
  }

  // ──────────────────────────────────────────────────────── styles ──
  function injectStyles() {
    if (document.getElementById('jzc-aiw-style')) return;
    const s = document.createElement('style');
    s.id = 'jzc-aiw-style';
    s.textContent = `
    #jzc-aiw-mask{position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.45);
      display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}
    #jzc-aiw,#jzc-aiw *{box-sizing:border-box;}
    #jzc-aiw{position:relative;width:min(1180px,94vw);height:88vh;background:#f7f9fc;border-radius:16px;overflow:hidden;
      display:flex;box-shadow:0 24px 70px rgba(15,23,42,.35);color:#0f1f3d;}
    #jzc-aiw .aiw-side{width:190px;flex:0 0 190px;background:#fff;border-right:1px solid #eef1f6;padding:18px 12px;}
    #jzc-aiw .aiw-brand{font-size:17px;font-weight:800;padding:6px 10px 16px;color:#0f1f3d;}
    #jzc-aiw .aiw-nav{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:10px;cursor:pointer;
      color:#42506b;font-size:14px;font-weight:600;margin-bottom:4px;}
    #jzc-aiw .aiw-nav:hover{background:#f3f6fb;}
    #jzc-aiw .aiw-nav.on{background:#eaf1ff;color:${PRIMARY};}
    #jzc-aiw .aiw-nav svg{width:18px;height:18px;}
    #jzc-aiw .aiw-main{flex:1;min-width:0;display:flex;flex-direction:column;}
    #jzc-aiw .aiw-top{display:flex;align-items:center;justify-content:space-between;padding:18px 24px 0;}
    #jzc-aiw .aiw-h1{font-size:22px;font-weight:800;}
    #jzc-aiw .aiw-sub{font-size:13px;color:#7686a3;margin-top:3px;}
    #jzc-aiw .aiw-x{cursor:pointer;border:none;background:transparent;font-size:22px;color:#90a0bd;line-height:1;}
    #jzc-aiw .aiw-body{flex:1;overflow:auto;padding:18px 24px 28px;}
    /* steps */
    #jzc-aiw .aiw-steps{display:flex;align-items:center;margin:14px 0 20px;}
    #jzc-aiw .aiw-step{display:flex;align-items:center;gap:9px;color:#90a0bd;font-size:14px;font-weight:600;}
    #jzc-aiw .aiw-dot{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;
      background:#e6ebf3;color:#90a0bd;font-size:14px;font-weight:700;}
    #jzc-aiw .aiw-step.done .aiw-dot{background:#dceafe;color:${PRIMARY};}
    #jzc-aiw .aiw-step.on .aiw-dot{background:${PRIMARY};color:#fff;}
    #jzc-aiw .aiw-step.on{color:#0f1f3d;}
    #jzc-aiw .aiw-line{flex:1;height:2px;background:#e6ebf3;margin:0 12px;}
    /* cards */
    #jzc-aiw .aiw-card{background:#fff;border:1px solid #eef1f6;border-radius:14px;padding:18px 20px;margin-bottom:16px;}
    #jzc-aiw .aiw-row{display:flex;gap:18px;flex-wrap:wrap;}
    #jzc-aiw .aiw-field{flex:1;min-width:210px;}
    #jzc-aiw .aiw-label{font-size:13px;color:#42506b;font-weight:600;margin-bottom:7px;}
    #jzc-aiw select,#jzc-aiw input[type=text]{width:100%;height:40px;border:1px solid #e3e8f0;border-radius:10px;
      padding:0 12px;font-size:14px;background:#fbfcfe;color:#0f1f3d;outline:none;font-family:inherit;}
    #jzc-aiw select:focus,#jzc-aiw input[type=text]:focus{border-color:${PRIMARY};}
    #jzc-aiw .aiw-opts{display:flex;align-items:center;gap:26px;flex-wrap:wrap;margin-top:4px;}
    #jzc-aiw .aiw-opt{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;color:#42506b;}
    #jzc-aiw .aiw-sw{width:42px;height:24px;border-radius:999px;background:#d3dbe8;position:relative;cursor:pointer;transition:.16s;flex:0 0 42px;}
    #jzc-aiw .aiw-sw.on{background:${PRIMARY};}
    #jzc-aiw .aiw-sw::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.16s;}
    #jzc-aiw .aiw-sw.on::after{left:21px;}
    #jzc-aiw .aiw-prefix{display:flex;align-items:center;gap:10px;margin-left:auto;}
    #jzc-aiw .aiw-prefix input{width:140px;}
    /* btns */
    #jzc-aiw .aiw-btn{height:38px;padding:0 18px;border-radius:10px;border:none;cursor:pointer;font-size:14px;font-weight:700;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;gap:7px;}
    #jzc-aiw .aiw-btn svg{width:16px;height:16px;flex:0 0 16px;}
    #jzc-aiw .aiw-btn.primary{background:${PRIMARY};color:#fff;}
    #jzc-aiw .aiw-btn.primary:disabled{opacity:.55;cursor:not-allowed;}
    #jzc-aiw .aiw-btn.ghost{background:#eaf1ff;color:${PRIMARY};}
    #jzc-aiw .aiw-btn.lg{height:44px;padding:0 26px;font-size:15px;border-radius:12px;}
    #jzc-aiw .aiw-dialog-mask{position:absolute;inset:0;z-index:5;background:rgba(15,23,42,.22);
      display:flex;align-items:center;justify-content:center;padding:18px;}
    #jzc-aiw .aiw-dialog{width:min(420px,92%);background:#fff;border:1px solid #e3e8f0;border-radius:14px;
      box-shadow:0 18px 48px rgba(15,23,42,.22);padding:18px;}
    #jzc-aiw .aiw-dialog-row{display:flex;gap:10px;margin-top:12px;}
    #jzc-aiw .aiw-dialog-row>*{flex:1;}
    #jzc-aiw .aiw-dialog-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:16px;}
    #jzc-aiw .aiw-card-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
    #jzc-aiw .aiw-card-t{font-size:16px;font-weight:800;}
    /* table */
    #jzc-aiw table{width:100%;border-collapse:collapse;font-size:14px;}
    #jzc-aiw th{background:#f3f6fb;color:#42506b;font-weight:700;font-size:13px;padding:12px 10px;text-align:center;}
    #jzc-aiw th:first-child{border-radius:8px 0 0 8px;} #jzc-aiw th:last-child{border-radius:0 8px 8px 0;}
    #jzc-aiw td{padding:12px 10px;text-align:center;border-bottom:1px solid #eef2f7;vertical-align:middle;}
    #jzc-aiw .aiw-thumb{width:46px;height:46px;border-radius:8px;object-fit:cover;border:1px solid #eef2f7;background:#f7f9fc;}
    #jzc-aiw .aiw-cell-inp{width:78px;height:34px;text-align:center;}
    #jzc-aiw .aiw-del{color:#e5484d;cursor:pointer;font-weight:600;}
    #jzc-aiw .aiw-ck{width:18px;height:18px;accent-color:${PRIMARY};cursor:pointer;}
    /* ai log */
    #jzc-aiw .aiw-log{background:#0b1424;border-radius:12px;padding:14px 16px;min-height:150px;max-height:260px;overflow:auto;
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:#9fe6c0;line-height:1.7;white-space:pre-wrap;}
    #jzc-aiw .aiw-chip{display:inline-block;white-space:nowrap;background:#eef0ff;color:#6b5bd2;font-size:12px;font-weight:700;border-radius:999px;padding:4px 11px;}
    /* image center */
    #jzc-aiw .aiw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;}
    #jzc-aiw .aiw-imgcard{position:relative;border:1px solid #eef2f7;border-radius:12px;overflow:hidden;background:#fff;aspect-ratio:1;}
    #jzc-aiw .aiw-imgcard img{width:100%;height:100%;object-fit:cover;}
    #jzc-aiw .aiw-tag{position:absolute;top:8px;left:8px;font-size:11px;font-weight:800;color:#fff;border-radius:6px;padding:2px 8px;}
    #jzc-aiw .aiw-tag.main{background:${PRIMARY};} #jzc-aiw .aiw-tag.slide{background:#16a34a;} #jzc-aiw .aiw-tag.detail{background:#d97706;}
    /* settings */
    #jzc-aiw .aiw-set-row{display:flex;align-items:center;justify-content:space-between;padding:14px 2px;border-bottom:1px solid #eef2f7;}
    #jzc-aiw .aiw-set-row .k{font-size:14px;font-weight:600;color:#42506b;}
    #jzc-aiw .aiw-set-row .v{font-size:14px;color:#0f1f3d;}
    #jzc-aiw .aiw-num{width:90px;height:36px;text-align:center;}
    #jzc-aiw .aiw-note{font-size:12.5px;color:#7686a3;margin-top:10px;line-height:1.6;}
    .jzc-aiw-toast{position:fixed;top:22px;left:50%;transform:translateX(-50%);z-index:2147483647;
      padding:11px 18px;border-radius:10px;color:#fff;font-size:14px;font-family:system-ui,sans-serif;
      box-shadow:0 8px 24px rgba(0,0,0,.25);background:#1f2937;}
    .jzc-aiw-toast.ok{background:#16a34a;} .jzc-aiw-toast.error{background:#dc2626;}
    `;
    document.head.appendChild(s);
  }

  // ─────────────────────────────────────────────────────── icons ──
  const ICONS = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8M5 10v10h14V10"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1l-.4-2.6H10l-.4 2.6a7 7 0 0 0-1.7 1l-2.3-1-2 3.4L3.6 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z"/></svg>',
    launch: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4.5 13.2c-.4.5 0 1.3.7 1.3H10l-1.1 7.1c-.1.8.9 1.2 1.4.6L20 11c.4-.5 0-1.3-.7-1.3H14l1.1-7.1c.1-.8-.9-1.2-1.4-.6z"/></svg>',
  };

  // ───────────────────────────────────────────────────── render ──
  function el(html) {
    const d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstElementChild;
  }

  function open(raw) {
    injectStyles();
    const restored = restoreWizardDraft(raw || {});
    if (!restored) {
      resetWizardState(raw || {});
    }

    let mask = document.getElementById('jzc-aiw-mask');
    if (!mask) {
      mask = el(`<div id="jzc-aiw-mask"><div id="jzc-aiw"></div></div>`);
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
      document.body.appendChild(mask);
    }
    mask.style.display = 'flex';
    render();
    if (!restored) loadStores();
    loadAiEngine();
    if (!restored || !W.fxRate) loadFxRate();
  }

  function close() {
    saveWizardDraft();
    const mask = document.getElementById('jzc-aiw-mask');
    if (mask) mask.style.display = 'none';
  }

  function render() {
    const root = document.getElementById('jzc-aiw');
    if (!root) return;
    root.innerHTML = `
      <div class="aiw-side">
        <div class="aiw-brand">AI 采集</div>
        ${navItem('workbench', ICONS.home, '工作台')}
        ${navItem('images', ICONS.image, '商品图片中心')}
        ${navItem('settings', ICONS.gear, '系统设置')}
      </div>
      <div class="aiw-main">
        <div class="aiw-top">
          <div>
            <div class="aiw-h1">${W.view === 'images' ? '商品图片中心' : W.view === 'settings' ? '系统设置' : 'AI 智能工作台'}</div>
            <div class="aiw-sub">${W.view === 'settings' ? '查看 AI 引擎与处理参数' : W.view === 'images' ? '采集到的图片按 主图/轮播/详情 归类' : '采集商品 → AI 智能体输出 → 一键上架'}</div>
          </div>
          ${W.view === 'workbench'
            ? `<button class="aiw-btn primary lg" id="aiw-launch" ${W.running ? 'disabled' : ''}>${ICONS.launch} ${W.running ? '处理中…' : '点击启动'}</button>`
            : `<button class="aiw-x" id="aiw-close2">×</button>`}
        </div>
        <div class="aiw-body" id="aiw-body"></div>
      </div>`;
    root.querySelectorAll('.aiw-nav').forEach((n) =>
      n.addEventListener('click', () => { W.view = n.dataset.view; render(); }));
    const launch = root.querySelector('#aiw-launch');
    if (launch) launch.addEventListener('click', runPipeline);
    const c2 = root.querySelector('#aiw-close2');
    if (c2) c2.addEventListener('click', close);
    renderBody();
  }

  function navItem(view, icon, label) {
    return `<div class="aiw-nav ${W.view === view ? 'on' : ''}" data-view="${view}">${icon}<span>${label}</span></div>`;
  }

  function renderBody() {
    const body = document.getElementById('aiw-body');
    if (!body) return;
    if (W.view === 'images') { renderImages(body); saveWizardDraft(); return; }
    if (W.view === 'settings') { renderSettings(body); saveWizardDraft(); return; }
    renderWorkbench(body);
    saveWizardDraft();
  }

  // ───────────────────────────────── 工作台 ──
  function renderWorkbench(body) {
    body.innerHTML = `
      ${stepsHtml()}
      <div class="aiw-card">
        <div class="aiw-field" style="margin-bottom:16px">
          <div class="aiw-label">产品类目 <span style="color:#e5484d">*</span>（AI 自动匹配，可手动改）${catAutoBadge()}</div>
          <div id="aiw-cat-cascade" style="display:flex;gap:8px;flex-wrap:wrap"></div>
        </div>
        <div class="aiw-row">
          <div class="aiw-field">
            <div class="aiw-label">店铺选择 <span style="color:#e5484d">*</span></div>
            <select id="aiw-store"><option value="">请选择</option></select>
          </div>
          <div class="aiw-field">
            <div class="aiw-label">仓库选择</div>
            <select id="aiw-wh"><option value="">请选择</option></select>
          </div>
        </div>
        <div class="aiw-opts" style="margin-top:18px">
          <div class="aiw-opt"><span class="aiw-sw ${W.opts.directListing ? 'on' : ''}" data-opt="directListing"></span>是否直上</div>
          <div class="aiw-opt"><span class="aiw-sw ${W.opts.imageTranslate ? 'on' : ''}" data-opt="imageTranslate"></span>图片翻译</div>
          <div class="aiw-prefix"><span class="aiw-label" style="margin:0">货号前缀</span><input type="text" id="aiw-prefix" value="${esc(W.opts.offerPrefix)}"></div>
        </div>
      </div>

      <div class="aiw-card">
        <div class="aiw-card-h">
          <div class="aiw-card-t">商品列表</div>
          <button class="aiw-btn ghost" id="aiw-batch-price">批量设置售价</button>
        </div>
        <table>
          <thead><tr>
            <th style="width:46px"><input type="checkbox" class="aiw-ck" id="aiw-ck-all" ${W.items.every((i) => i.checked) ? 'checked' : ''}></th>
            <th style="width:70px">主图</th><th>SKU名称</th><th style="width:120px">采购价(¥)</th>
            <th style="width:120px">售价(¥)</th><th style="width:80px">操作</th>
          </tr></thead>
          <tbody id="aiw-rows">${W.items.map(rowHtml).join('')}</tbody>
        </table>
      </div>

      ${W.batchPrice?.open ? batchPriceDialogHtml() : ''}

      ${attrsCardHtml()}

      ${ratingCardHtml()}

      ${aiActionCardHtml()}

      ${W.aiLog.length || W.running ? `
      <div class="aiw-card">
        <div class="aiw-card-h"><div class="aiw-card-t">AI 输出日志</div><span class="aiw-chip">${esc(W.aiEngine)}</span></div>
        <div class="aiw-log" id="aiw-log">${W.aiLog.map(esc).join('\n') || '等待启动…'}</div>
      </div>` : ''}
    `;
    bindWorkbench(body);
  }

  function catAutoBadge() {
    if (!W.catAuto) return '';
    if (W.catAuto === 'matching') return ' <span style="color:#2168ff;font-weight:700;font-size:12px">· AI 匹配中…</span>';
    if (W.catAuto.indexOf('done:') === 0) return ` <span style="color:#16a34a;font-weight:700;font-size:12px">· AI 已选「${esc(W.catAuto.slice(5))}」✓</span>`;
    if (W.catAuto.indexOf('local:') === 0) return ` <span style="color:#d97706;font-weight:700;font-size:12px">· 本地预选「${esc(W.catAuto.slice(6))}」(后端 AI 未启用，请核对)</span>`;
    return ` <span style="color:#e5484d;font-weight:700;font-size:12px">· ${esc(W.catAuto)}</span>`;
  }

  function currentPackageInfo() {
    const base = packageInfoFromRaw(W.raw);
    const p = W.packageInfo || base;
    return {
      weightG: positiveInt(p.weightG, base.weightG),
      lengthMm: positiveInt(p.lengthMm, base.lengthMm),
      widthMm: positiveInt(p.widthMm, base.widthMm),
      heightMm: positiveInt(p.heightMm, base.heightMm),
      source: p.source || base.source,
    };
  }

  // 必填属性卡片：选定类目后显示该类目必填属性 + AI 填充结果(可编辑)。
  function attrsCardHtml() {
    if (!W.category) {
      return `<div class="aiw-card"><div class="aiw-card-t">必填属性</div>
        <div class="aiw-note" style="margin-top:8px">请先在上方选择产品类目，选到末级后自动拉取该类目的必填属性。</div></div>`;
    }
    const rows = W.reqAttrs.map((a, i) => {
      const valCell = a.dict
        ? `<input type="text" class="aiw-attr-val" data-i="${i}" value="${esc(a.dictValue || a.suggestedLabel || a.value || '')}" placeholder="AI 填充或手填">`
        : `<input type="text" class="aiw-attr-val" data-i="${i}" value="${esc(a.value || '')}" placeholder="AI 填充或手填">`;
      const suggested = a.suggestedLabel || a.dictValue || a.value || '';
      const manualText = suggested
        ? `AI 建议「${esc(suggested)}」，请手动确认。`
        : '请手动选择或填写。';
      const manualHint = a.needsManual
        ? `<div class="aiw-manual-hint" style="margin-top:6px;color:#d97706;font-size:12px;line-height:1.35">需手动确认：${manualText}</div>`
        : '';
      const badge = a.needsManual
        ? `<span class="aiw-chip" style="background:#fef3e7;color:#d97706">手动</span>`
        : (a.aiFilled ? `<span class="aiw-chip" style="background:#e7f6ec;color:#16a34a">AI</span>` : '');
      return `<tr>
        <td style="text-align:left;padding-left:14px">${esc(a.name)}${a.dict ? ' <span style="color:#7686a3;font-size:12px">[字典]</span>' : ''}</td>
        <td style="width:280px">${valCell}${manualHint}</td>
        <td style="width:60px">${badge}</td></tr>`;
    }).join('');
    return `<div class="aiw-card">
      <div class="aiw-card-h">
        <div class="aiw-card-t">必填属性 <span style="color:#7686a3;font-size:13px;font-weight:400">${esc(W.category.name)}（${W.reqAttrs.length} 项）</span></div>
        <button class="aiw-btn primary" id="aiw-fill-attrs" ${W.attrFilling ? 'disabled' : ''}>${W.attrFilling ? 'AI 填充中…' : 'AI 填充必填属性'}</button>
      </div>
      ${W.reqAttrs.length
        ? `<table><thead><tr><th style="text-align:left;padding-left:14px">属性名</th><th>值</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="aiw-note">该类目没有必填属性，或正在加载…</div>`}
      <div class="aiw-note">选项型属性需匹配到平台可选值才能上架；AI 填充会自动匹配，匹配不到的请手动改。</div>
    </div>`;
  }

  // 内容评级属性卡片(tier2)：AI 填充后出现的非必填加分属性，提升 Ozon 内容评分。
  // 和必填属性共用一次 aiFillAttrs 调用（AI 一次返回 tier1+tier2）。
  function ratingCardHtml() {
    if (!W.category) return '';
    const rows = W.ratingAttrs.map((a, i) => {
      const v = a.dict ? (a.dictValue || '') : (a.value || '');
      return `<tr>
        <td style="text-align:left;padding-left:14px">${esc(a.name)}${a.dict ? ' <span style="color:#7686a3;font-size:12px">[字典]</span>' : ''}</td>
        <td style="width:280px"><input type="text" class="aiw-rating-val" data-i="${i}" value="${esc(v)}" placeholder="可编辑或删空"></td>
        <td style="width:78px"><span class="aiw-chip" style="background:#fef3e7;color:#d97706">评分</span></td></tr>`;
    }).join('');
    return `<div class="aiw-card">
      <div class="aiw-card-h">
        <div class="aiw-card-t">内容评级属性 <span style="color:#7686a3;font-size:13px;font-weight:400">非必填，填了提升 Ozon 内容评分${W.ratingAttrs.length ? `（${W.ratingAttrs.length} 项）` : ''}</span></div>
        <button class="aiw-btn ghost" id="aiw-fill-rating" ${W.attrFilling ? 'disabled' : ''}>${W.attrFilling ? 'AI 填充中…' : 'AI 填充内容评级属性'}</button>
      </div>
      ${W.ratingAttrs.length
        ? `<table><thead><tr><th style="text-align:left;padding-left:14px">属性名</th><th>值</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="aiw-note">点「AI 填充内容评级属性」：AI 会挑出当前类目下非必填、但能拉高内容评分的属性并填好。</div>`}
    </div>`;
  }

  function aiActionCardHtml() {
    if (!W.category) return '';
    const c = W.generatedContent || {};
    const title = c.title || '';
    const desc = c.description || '';
    const tags = Array.isArray(c.hashtags) ? c.hashtags : [];
    return `<div class="aiw-card">
      <div class="aiw-card-h">
        <div class="aiw-card-t">AI 文案与上架 <span style="color:#7686a3;font-size:13px;font-weight:400">可单独重写，也可在属性填好后直接提交</span></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button class="aiw-btn ghost" id="aiw-rewrite-only" ${W.running ? 'disabled' : ''}>AI 重写标题/描述/标签</button>
          <button class="aiw-btn primary" id="aiw-publish-only" ${W.running ? 'disabled' : ''}>提交上架</button>
        </div>
      </div>
      <div id="aiw-content-preview" class="aiw-note" style="display:grid;gap:6px;line-height:1.5">
        ${title ? `<div><b>标题：</b>${esc(title)}</div>` : '<div>尚未生成 AI 文案；提交时会使用当前商品名。</div>'}
        ${desc ? `<div><b>描述：</b>${esc(String(desc).slice(0, 180))}${String(desc).length > 180 ? '…' : ''}</div>` : ''}
        ${tags.length ? `<div><b>标签：</b>${tags.map(esc).join(' ')}</div>` : ''}
      </div>
    </div>`;
  }

  function stepsHtml() {
    const steps = ['获取数据', '等待选择数据', 'AI智能体输出', '完成'];
    return `<div class="aiw-steps">${steps.map((t, i) => {
      const n = i + 1;
      const cls = n < W.step ? 'done' : n === W.step ? 'on' : '';
      const dot = n < W.step ? '✓' : n;
      return `<div class="aiw-step ${cls}"><span class="aiw-dot">${dot}</span><span>${t}</span></div>${i < 3 ? '<span class="aiw-line"></span>' : ''}`;
    }).join('')}</div>`;
  }

  function rowHtml(it, i) {
    return `<tr>
      <td><input type="checkbox" class="aiw-ck aiw-ck-row" data-i="${i}" ${it.checked ? 'checked' : ''}></td>
      <td>${it.image ? `<img class="aiw-thumb" src="${esc(it.image)}">` : '<div class="aiw-thumb"></div>'}</td>
      <td style="text-align:left">${esc(it.skuName)}</td>
      <td>¥ ${esc(it.buyPrice || '—')}</td>
      <td><input type="text" class="aiw-cell-inp aiw-price" data-i="${i}" value="${esc(it.salePrice)}"></td>
      <td><span class="aiw-del" data-i="${i}">删除</span></td>
    </tr>`;
  }

  function batchPriceDialogHtml() {
    const mode = W.batchPrice?.mode || 'set';
    const value = W.batchPrice?.value || '';
    return `<div class="aiw-dialog-mask" id="aiw-batch-price-dialog">
      <div class="aiw-dialog">
        <div class="aiw-card-h">
          <div class="aiw-card-t">批量设置售价</div>
          <button class="aiw-x" id="aiw-batch-cancel" type="button">×</button>
        </div>
        <div class="aiw-dialog-row">
          <select id="aiw-batch-mode">
            <option value="set" ${mode === 'set' ? 'selected' : ''}>固定售价</option>
            <option value="add" ${mode === 'add' ? 'selected' : ''}>增加金额</option>
            <option value="multiply" ${mode === 'multiply' ? 'selected' : ''}>乘以倍率</option>
          </select>
          <input type="text" id="aiw-batch-value" value="${esc(value)}" placeholder="0.00">
        </div>
        <div class="aiw-dialog-actions">
          <button class="aiw-btn ghost" id="aiw-batch-cancel2" type="button">取消</button>
          <button class="aiw-btn primary" id="aiw-batch-apply" type="button">确定</button>
        </div>
      </div>
    </div>`;
  }

  function openBatchPriceDialog() {
    W.batchPrice = {
      open: true,
      mode: W.batchPrice?.mode || 'set',
      value: W.batchPrice?.value || W.items.find((item) => item.checked)?.salePrice || W.items[0]?.salePrice || '',
    };
    renderBody();
  }

  function closeBatchPriceDialog() {
    W.batchPrice = { ...(W.batchPrice || {}), open: false };
    renderBody();
  }

  function applyBatchPrice(mode, value) {
    const n = Number(fmtMoney(value));
    if (!Number.isFinite(n) || n <= 0) {
      toast('请输入有效数值', 'error');
      return;
    }
    W.items.forEach((item) => {
      const current = Number(fmtMoney(item.salePrice || item.buyPrice || 0)) || 0;
      let next = n;
      if (mode === 'add') next = current + n;
      if (mode === 'multiply') next = current * n;
      item.salePrice = fmtMoney(round2(next));
    });
    W.batchPrice = { open: false, mode, value: String(value || '').trim() };
    renderBody();
  }

  function bindWorkbench(body) {
    body.querySelectorAll('.aiw-sw').forEach((sw) =>
      sw.addEventListener('click', () => {
        const k = sw.dataset.opt;
        W.opts[k] = !W.opts[k];
        sw.classList.toggle('on', W.opts[k]);
        saveWizardDraft();
      }));
    const prefix = body.querySelector('#aiw-prefix');
    if (prefix) prefix.addEventListener('input', () => {
      // 货号只允许 Ozon 接受的字符集（A-Za-z0-9_-./），过滤掉中文/空格/西里尔，
      // 否则整批 import 被后端 422 拒（offer_id 正则不通过）。
      const cleaned = prefix.value.replace(/[^A-Za-z0-9_\-./]/g, '');
      if (cleaned !== prefix.value) prefix.value = cleaned;
      W.opts.offerPrefix = cleaned.trim();
      saveWizardDraft();
    });
    renderCatCascade();                                   // 类目逐级下拉
    body.querySelectorAll('.aiw-attr-val').forEach((inp) =>
      inp.addEventListener('input', () => {
        const a = W.reqAttrs[+inp.dataset.i]; if (!a) return;
        if (a.dict) { a.dictValue = inp.value; a.dictValueId = ''; a.aiFilled = false; }  // 手改字典值清掉 id，提交时后端兜底匹配
        else a.value = inp.value;
        a.needsManual = false; a.manualReason = ''; a.suggestedLabel = '';
        saveWizardDraft();
      }));
    const fillBtn = body.querySelector('#aiw-fill-attrs');
    if (fillBtn) fillBtn.addEventListener('click', () => aiFillAttrs('required', { logTitle: 'AI 填充必填属性' }));
    body.querySelectorAll('.aiw-rating-val').forEach((inp) =>
      inp.addEventListener('input', () => {
        const a = W.ratingAttrs[+inp.dataset.i]; if (!a) return;
        if (a.dict) { a.dictValue = inp.value; a.dictValueId = ''; }  // 手改字典值清 id，提交后端兜底匹配
        else a.value = inp.value;
        saveWizardDraft();
      }));
    const fillRating = body.querySelector('#aiw-fill-rating');
    if (fillRating) fillRating.addEventListener('click', () => aiFillAttrs('rating', { logTitle: 'AI 填充内容评级属性' }));
    const rewriteOnly = body.querySelector('#aiw-rewrite-only');
    if (rewriteOnly) rewriteOnly.addEventListener('click', runRewriteOnly);
    const publishOnly = body.querySelector('#aiw-publish-only');
    if (publishOnly) publishOnly.addEventListener('click', runPublishOnly);
    const store = body.querySelector('#aiw-store');
    if (store) store.addEventListener('change', () => {
      selectStore(store.value, { reload: true });
    });
    const wh = body.querySelector('#aiw-wh');
    if (wh) wh.addEventListener('change', () => { W.opts.warehouseId = wh.value; saveWizardDraft(); });
    fillStoreSelect();
    fillWarehouseSelect();

    const ckAll = body.querySelector('#aiw-ck-all');
    if (ckAll) ckAll.addEventListener('change', () => { W.items.forEach((it) => (it.checked = ckAll.checked)); renderBody(); });
    body.querySelectorAll('.aiw-ck-row').forEach((ck) =>
      ck.addEventListener('change', () => { W.items[+ck.dataset.i].checked = ck.checked; saveWizardDraft(); }));
    body.querySelectorAll('.aiw-price').forEach((inp) =>
      inp.addEventListener('input', () => { W.items[+inp.dataset.i].salePrice = inp.value; saveWizardDraft(); }));
    body.querySelectorAll('.aiw-del').forEach((d) =>
      d.addEventListener('click', () => { W.items.splice(+d.dataset.i, 1); renderBody(); }));
    const bp = body.querySelector('#aiw-batch-price');
    if (bp) bp.addEventListener('click', openBatchPriceDialog);
    const batchCancel = body.querySelector('#aiw-batch-cancel');
    const batchCancel2 = body.querySelector('#aiw-batch-cancel2');
    if (batchCancel) batchCancel.addEventListener('click', closeBatchPriceDialog);
    if (batchCancel2) batchCancel2.addEventListener('click', closeBatchPriceDialog);
    const batchApply = body.querySelector('#aiw-batch-apply');
    if (batchApply) batchApply.addEventListener('click', () => {
      const mode = body.querySelector('#aiw-batch-mode')?.value || 'set';
      const value = body.querySelector('#aiw-batch-value')?.value || '';
      applyBatchPrice(mode, value);
    });
  }

  // ───────────────────────────────── 类目级联 + 必填属性 ──
  function childrenAt(level) {
    // level 0 → 树根 children；否则 → catPath[level-1] 的 children
    if (level === 0) return (W.catTree && W.catTree.children) || W.catTree || [];
    const parent = W.catPath[level - 1];
    return (parent && parent.children) || [];
  }
  function isLeaf(node) {
    return node && (!node.children || !node.children.length) && Number(node.type_id) > 0;
  }
  function renderCatCascade() {
    const box = document.getElementById('aiw-cat-cascade');
    if (!box) return;
    if (!W.opts.storeId) { box.innerHTML = '<span style="color:#7686a3;font-size:13px">请先选择店铺</span>'; return; }
    if (W.catTreeLoading) { box.innerHTML = '<span style="color:#2168ff;font-size:13px;font-weight:700">类目树加载中…</span>'; return; }
    if (W.catTreeError) { box.innerHTML = `<span style="color:#e5484d;font-size:13px">${esc(W.catTreeError)}</span>`; return; }
    if (!W.catTree) { box.innerHTML = '<span style="color:#7686a3;font-size:13px">类目树加载中…</span>'; return; }
    box.innerHTML = '';
    // 已选每级 + 下一级待选下拉
    const levels = W.catPath.length + 1;
    for (let lv = 0; lv < levels; lv++) {
      const opts = childrenAt(lv);
      if (!opts.length) break;
      const chosen = W.catPath[lv];
      const sel = document.createElement('select');
      sel.style.cssText = 'min-width:150px;flex:0 0 auto';
      sel.innerHTML = `<option value="">请选择</option>` + opts.map((n, i) =>
        `<option value="${i}" ${chosen && chosen.title === n.title ? 'selected' : ''}>${esc(n.title)}</option>`).join('');
      sel.addEventListener('change', () => onPickCat(lv, sel.value === '' ? null : opts[+sel.value]));
      box.appendChild(sel);
    }
  }
  function onPickCat(level, node) {
    W.catAuto = '';                                 // 手动选 → 清掉 AI 自动匹配标记
    W.catPath = W.catPath.slice(0, level);          // 截断到本级
    if (node) W.catPath.push(node);
    W.category = null; W.categoryVisualTags = []; W.attrsSchema = []; W.reqAttrs = [];
    const leaf = W.catPath[W.catPath.length - 1];
    if (isLeaf(leaf)) {
      W.category = {
        typeId: Number(leaf.type_id),
        descCatId: inheritedDescCatId(W.catPath),
        name: W.catPath.map((n) => n.title).join(' / '),
      };
      loadCategoryAttrs();
    }
    renderBody();   // 重渲染（级联 + 属性卡片）
  }
  async function loadCategoryTree() {
    const storeId = W.opts.storeId;
    const reqId = ++catTreeReqSeq;
    W.catTree = null; W.catTreeError = ''; W.catTreeLoading = true;
    W.catPath = []; W.category = null; W.categoryVisualTags = []; W.attrsSchema = []; W.reqAttrs = []; W.ratingAttrs = [];
    renderCatCascade();
    if (!storeId) {
      W.catTreeLoading = false;
      W.catTreeError = '请先选择店铺';
      renderCatCascade();
      return;
    }
    try {
      const scopedResp = await bg({ action: 'getCategoryTree', storeId, language: 'ZH_HANS' });
      if (reqId !== catTreeReqSeq) return;
      W.catTreeLoading = false;
      if (scopedResp.ok) {
        W.catTree = normalizeCategoryTree(scopedResp.data);
        W.catTreeError = W.catTree.children.length ? '' : '类目树为空，请检查店铺权限';
        renderCatCascade();
        if (!W.category && !W.catTreeError) autoMatchCategory();
      } else {
        W.catTreeError = `类目树加载失败：${scopedResp.error || '未知错误'}`;
        renderCatCascade();
        log('getCategoryTree failed', scopedResp.error);
      }
    } catch (e) {
      if (reqId !== catTreeReqSeq) return;
      W.catTreeLoading = false;
      W.catTreeError = `类目树加载失败：${e?.message || String(e)}`;
      renderCatCascade();
      log('getCategoryTree error', e);
    }
  }
  // 把采集的 1688 商品属性拼成一段「商品画像」文本，喂给 AI 判类目 / 填属性。
  function specsText() {
    const s = W.raw.specs || {};
    return Object.entries(s).map(([k, v]) => `${k}:${v}`).join('; ').slice(0, 1200);
  }
  function textValue(v) {
    if (Array.isArray(v)) return v.map(textValue).filter(Boolean).join(' > ');
    if (v && typeof v === 'object') return Object.values(v).map(textValue).filter(Boolean).join(' > ');
    return String(v || '').trim();
  }
  function sourceCategoryText() {
    const raw = W.raw || {};
    return [
      raw.category,
      raw.sourceCategory,
      raw.categoryPath,
      raw.breadcrumb,
      raw.breadcrumbs,
    ].map(textValue).filter(Boolean).join(' > ').slice(0, 500);
  }
  function skuContextNames() {
    const raw = W.raw || {};
    const names = [];
    const push = (v) => {
      const text = textValue(v);
      if (text && !names.includes(text)) names.push(text);
    };
    (W.items || []).forEach((item) => {
      if (item?.skuName && item.skuName !== raw.title) push(item.skuName);
    });
    (Array.isArray(raw.skuList) ? raw.skuList : []).forEach((sku) => {
      push(sku?.skuName || sku?.name || sku?.title);
      if (sku?.aspectValues && typeof sku.aspectValues === 'object') push(Object.values(sku.aspectValues).join(' '));
    });
    return names.slice(0, 8);
  }
  function detailContextText() {
    const raw = W.raw || {};
    return textValue(raw.detailText || raw.description || raw.desc || raw.detail || '').slice(0, 1200);
  }
  function selectedSkuContext(item) {
    const rawTitle = textValue(W.raw?.title);
    const skuName = textValue(item?.skuName);
    if (!skuName || skuName === rawTitle) return '';
    return skuName;
  }
  function attrFillDescription(item, specs) {
    const parts = [];
    const rawTitle = textValue(W.raw?.title);
    const skuName = selectedSkuContext(item);
    const aspectText = textValue(item?.aspectValues);
    if (rawTitle) parts.push(rawTitle);
    if (skuName) parts.push(`SKU名称：${skuName}`);
    if (aspectText && aspectText !== skuName) parts.push(`SKU属性：${aspectText}`);
    if (specs) parts.push(`商品属性：${specs}`);
    return parts.join('\n');
  }
  function nodeDescCatId(node) {
    return Number(node?.description_category_id || node?.descriptionCategoryId || node?.descCatId || 0) || 0;
  }
  function inheritedDescCatId(path) {
    let desc = 0;
    (path || []).forEach((node) => {
      desc = nodeDescCatId(node) || desc;
    });
    return desc;
  }
  // 收集所有叶子类目（带完整路径），供粗筛/候选用
  function collectLeaves() {
    const out = [];
    const dfs = (node, path) => {
      const p = [...path, node];
      if (isLeaf(node)) out.push({ node, path: p, leafTitle: node.title, fullName: p.map((n) => n.title).join('/') });
      (node.children || []).forEach((c) => dfs(c, p));
    };
    ((W.catTree && W.catTree.children) || []).forEach((n) => dfs(n, []));
    return out;
  }
  // 商品信息 vs 类目名 的粗筛打分：叶子名整出现强加分 + 2-gram 字重叠
  function overlapScore(name, query) {
    if (!name || !query) return 0;
    let s = 0;
    const leaf = name.split('/').pop();
    if (leaf && leaf.length >= 2 && query.includes(leaf)) s += 50;
    const grams = (str) => { const g = new Set(); for (let i = 0; i < str.length - 1; i++) g.add(str.slice(i, i + 2)); return g; };
    const ng = grams(name), qg = grams(query);
    let hit = 0; ng.forEach((g) => { if (qg.has(g)) hit++; });
    return s + hit * 6;
  }
  function setAutoCategory(path, kind) {
    W.catPath = path;
    const leaf = path[path.length - 1], parent = path[path.length - 2];
    W.category = {
      typeId: Number(leaf.type_id),
      descCatId: inheritedDescCatId(path),
      name: path.map((n) => n.title).join(' / '),
    };
    W.catAuto = 'done:' + leaf.title;
    renderBody();
    loadCategoryAttrs();
  }
  function findPathByCategoryId(typeId, descCatId) {
    const targetType = Number(typeId) || 0;
    const targetDesc = Number(descCatId) || 0;
    const roots = (W.catTree && W.catTree.children) || [];
    let found = null;
    const dfs = (node, path, inheritedDesc) => {
      if (!node || found) return;
      const next = [...path, node];
      const nodeType = Number(node.type_id) || 0;
      const nodeDesc = nodeDescCatId(node) || inheritedDesc || 0;
      if (isLeaf(node) && nodeType === targetType && (!targetDesc || nodeDesc === targetDesc)) {
        found = next;
        return;
      }
      (node.children || []).forEach((child) => dfs(child, next, nodeDesc));
    };
    roots.forEach((node) => dfs(node, [], 0));
    return found;
  }
  // AI 自动匹配类目：分层让 LLM 在每一级的【真实子类目】里选序号（它懂"长裤→裤子"
  // 这种语义，完全绕开本地字面匹配的 gap）。后端不通(端点没部署/无 key)时，退回
  // 本地粗筛取最高分叶子兜底，不至于完全失败（badge 会标"本地预选"提示去核对）。
  async function autoMatchCategory() {
    if (!W.catTree || W.category) return;
    W.catAuto = 'matching'; renderBody();
    const title = W.raw.title || '', attributes = specsText();
    const resp = await bg({
      action: 'suggestCategory',
      storeId: W.opts.storeId,
      body: {
        title,
        attributes,
        sourceCategory: sourceCategoryText(),
        skuNames: skuContextNames(),
        mainImageUrl: (W.raw.mainImages && W.raw.mainImages[0]) || '',
        imageCount: (W.raw.mainImages || []).length,
        detailText: detailContextText(),
        matchMode: 'leaf-topk',
        topK: 20,
      },
    });
    W.categoryVisualTags = (resp.ok && Array.isArray(resp.data?.visualTags))
      ? resp.data.visualTags.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 24)
      : [];
    const selected = resp.ok ? (resp.data?.selected || null) : null;
    if (selected?.typeId) {
      const path = findPathByCategoryId(selected.typeId, selected.descCatId);
      if (path && path.length) {
        const confidence = Number(selected.confidence || 0);
        if (confidence >= 0.45 && confidence < 0.75) {
          try {
            const imageUrl = (W.raw.mainImages && W.raw.mainImages[0]) || '';
            const vr = await bg({ action: 'verifyCategory', storeId: W.opts.storeId, body: { title, attributes, chosenPath: path.map((n) => n.title).join(' > '), imageUrl } });
            if (vr.ok && vr.data && vr.data.ok === false) {
              W.catAuto = 'AI 置信度偏低，请手选'; renderBody(); return;
            }
          } catch (e) { /* 低置信复核失败时保留候选,让用户可手动改 */ }
        }
        return setAutoCategory(path, 'done');
      }
    }

    // v2 没拿到可映射叶子时不做本地兜底，避免误选类目。
    W.catAuto = 'AI 未能判断类目，请手选'; renderBody();
  }
  async function loadCategoryAttrs() {
    if (!W.category) return;
    const resp = await bg({ action: 'getCategoryAttributes', typeId: W.category.typeId, storeId: W.opts.storeId });
    const schema = resp.ok ? (resp.data?.result || resp.data || []) : [];
    W.attrsSchema = Array.isArray(schema) ? schema : [];
    // 筛必填，建可编辑行；换类目清掉上一个类目的内容评级属性
    W.reqAttrs = W.attrsSchema.filter(isSchemaRequiredAttr).map((a) => ({
      id: Number(a.id), name: a.name || ('属性' + a.id),
      dict: Number(a.dictionary_id) > 0, collection: !!a.is_collection,
      value: '', dictValue: '', dictValueId: '', aiFilled: false,
      needsManual: false, manualReason: '', suggestedLabel: '',
    }));
    W.ratingAttrs = [];
    renderBody();
  }

  function currentAttrSnapshot() {
    const rows = [...(W.reqAttrs || []), ...(W.ratingAttrs || [])];
    return rows
      .map((a) => {
        if (a.dict && !String(a.dictValueId || '').trim()) return null;
        const raw = a.dict
          ? (a.dictValue || a.value || a.dictValueId || '')
          : (a.value || '');
        const value = String(raw || '').trim();
        return value ? { id: Number(a.id), values: [{ value }] } : null;
      })
      .filter((item) => item && Number.isFinite(item.id));
  }

  function mergeRatingAttrs(existingRows, incomingRows) {
    const merged = [];
    const indexById = new Map();
    (existingRows || []).forEach((row) => {
      const id = Number(row?.id);
      if (!Number.isFinite(id)) return;
      const copy = { ...row, id };
      indexById.set(id, merged.length);
      merged.push(copy);
    });
    (incomingRows || []).forEach((row) => {
      const id = Number(row?.id);
      if (!Number.isFinite(id)) return;
      const next = { ...row, id };
      if (indexById.has(id)) {
        merged[indexById.get(id)] = { ...merged[indexById.get(id)], ...next };
      } else {
        indexById.set(id, merged.length);
        merged.push(next);
      }
    });
    return merged;
  }

  // 一次 optimize-for-rating(modules:["attrs"]) 同时拿 tier1(必填) + tier2(内容评级加分)：
  // tier1 回填「必填属性」区，tier2 进「内容评级属性」区（提升 Ozon 内容评分）。
  function selectedListingItem() {
    return W.items.find((x) => x.checked) || W.items[0] || null;
  }

  function attrHasSubmitValue(a) {
    if (!a) return false;
    if (!a.dict) return !!String(a.value || '').trim();
    return !!String(a.dictValueId || '').trim() || isNoBrandAttr(a) || hasManualDictionaryText(a);
  }

  function isBrandAttr(a) {
    return /品牌|бренд|brand/i.test(String(a?.name || ''));
  }

  function isNoBrandText(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s_\-]+/g, '');
    return ['无品牌', 'nobrand', 'нетбренда', 'безбренда'].includes(normalized);
  }

  function isNoBrandAttr(a) {
    if (!a || !a.dict || !isBrandAttr(a)) return false;
    return isNoBrandText(a.suggestedLabel) || isNoBrandText(a.dictValue) || isNoBrandText(a.value);
  }

  function manualDictionaryText(a) {
    if (!a || !a.dict) return '';
    return String(a.dictValue || a.value || a.suggestedLabel || '').trim();
  }

  function hasManualDictionaryText(a) {
    return !!manualDictionaryText(a);
  }

  function requiresAutoSubmitConfirmation(a) {
    return !!(a && a.needsManual && !isNoBrandAttr(a) && manualDictionaryText(a));
  }

  function requiredManualConfirmAttrs() {
    return (W.reqAttrs || []).filter(requiresAutoSubmitConfirmation);
  }

  function submitAttributeOf(a) {
    if (!a) return null;
    if (a.dict) {
      const dictValueId = String(a.dictValueId || '').trim();
      if (dictValueId) {
        return {
          complex_id: 0,
          id: a.id,
          values: [{ dictionary_value_id: Number(dictValueId), value: '' }],
        };
      }
      if (isNoBrandAttr(a)) {
        return {
          complex_id: 0,
          id: a.id,
          values: [{ dictionary_value_id: 0, value: '无品牌' }],
        };
      }
      if (hasManualDictionaryText(a)) {
        return {
          complex_id: 0,
          id: a.id,
          values: [{ dictionary_value_id: 0, value: manualDictionaryText(a) }],
        };
      }
      return null;
    }
    const value = String(a.value || '').trim();
    if (!value) return null;
    return {
      complex_id: 0,
      id: a.id,
      values: [{ dictionary_value_id: 0, value }],
    };
  }

  function isRequiredFlag(value) {
    if (value === true || value === 1) return true;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes';
    }
    return false;
  }

  function isSchemaRequiredAttr(attr) {
    return isRequiredFlag(attr && attr.is_required);
  }

  function schemaAttrById(id) {
    const attrId = Number(id);
    if (!Number.isFinite(attrId)) return null;
    return (W.attrsSchema || []).find((attr) => Number(attr && attr.id) === attrId) || null;
  }

  function filledAttrsOf(rows) {
    return (rows || []).filter(attrHasSubmitValue);
  }

  function publishPriceInfo(item) {
    const current = Number(fmtMoney(item?.salePrice || ''));
    const cost = Number(fmtMoney(item?.buyPrice || ''));
    const computed = computeSalePrice(item?.buyPrice, W.opts.targetMargin);
    if (current > 0 && (!cost || Math.abs(current - cost) > 0.0001)) {
      item.pricingSnapshot = {
        costCny: cost,
        fxRate: computed.rate || (W.opts.storeCurrency === 'CNY' ? 1 : Number(W.fxRate) || 0),
        targetMargin: Number(W.opts.targetMargin) || 0,
        salePrice: round2(current),
        currency: W.opts.storeCurrency || computed.currency || 'RUB',
      };
      return { ...item.pricingSnapshot, price: item.pricingSnapshot.salePrice };
    }
    if (computed.error === 'missing_fx_rate') return computed;
    const pricingSnapshot = applyPricingSnapshot(item, computed);
    return { ...computed, pricingSnapshot };
  }

  function safeOfferPart(value, fallback) {
    const cleaned = String(value || '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^A-Za-z0-9_.-]/g, '')
      .replace(/[-_.]{2,}/g, '-')
      .replace(/^[-_.]+|[-_.]+$/g, '');
    return cleaned || String(fallback || '').padStart(2, '0');
  }

  function offerIdForItem(item, index, total) {
    const root = `${W.opts.offerPrefix}-${W.raw.offerId || Date.now()}`;
    if (total <= 1) return root;
    return `${root}-${safeOfferPart(item?.sku || item?.skuName, index + 1)}`;
  }

  function aiListingModelName() {
    const source = offerIdentity(W.raw) || W.raw?.offerId || W.raw?.offer_id || W.raw?.title || 'model';
    return `AIW-${safeOfferPart(source, 'model')}`;
  }

  function withSharedModelAttribute(attributes, modelName) {
    const attrs = (Array.isArray(attributes) ? attributes : [])
      .filter((attr) => Number(attr?.id ?? attr?.attribute_id) !== 9048)
      .map((attr) => cloneJson(attr));
    attrs.push({
      complex_id: 0,
      id: 9048,
      values: [{ dictionary_value_id: 0, value: modelName }],
    });
    return attrs;
  }

  function imagesForItem(item) {
    const images = [];
    const add = (url) => {
      const value = String(url || '').trim();
      if (value && !images.includes(value)) images.push(value);
    };
    add(item?.image);
    (W.raw.mainImages || []).forEach(add);
    return images;
  }

  function publishTitleForItem(item, baseTitle, total) {
    const common = String(baseTitle || '').trim();
    const label = String(item?.skuName || '').trim();
    const rawTitle = String(W.raw?.title || '').trim();
    if (common) return common;
    if (total > 1) return rawTitle || label || '';
    return label || rawTitle || '';
  }

  function buildPublishItems(rows, { title, description, hashtags, attributes }) {
    const pkg = currentPackageInfo();
    const sharedModelName = rows.length > 1 ? aiListingModelName() : '';
    const publishAttributes = sharedModelName ? withSharedModelAttribute(attributes, sharedModelName) : attributes;
    const items = [];
    const stocks = [];
    rows.forEach((row, index) => {
      const sp = publishPriceInfo(row);
      if (sp.error === 'missing_fx_rate') {
        throw new Error('未取到 CNY→RUB 汇率，已取消提交');
      }
      const offerId = offerIdForItem(row, index, rows.length);
      items.push({
        name: publishTitleForItem(row, title, rows.length),
        offer_id: offerId,
        price: String(sp.price),
        old_price: String(round2(sp.price * 1.25)),
        vat: '0',
        currency_code: sp.currency,
        weight: pkg.weightG,
        depth: pkg.lengthMm,
        width: pkg.widthMm,
        height: pkg.heightMm,
        images: imagesForItem(row),
        scraped_description: description || '',
        scraped_brand: 'no_brand',
        scraped_model_name: sharedModelName || undefined,
        _aiHashtags: Array.isArray(hashtags) ? hashtags : [],
        _pricingSnapshot: row.pricingSnapshot || sp.pricingSnapshot,
        description_category_id: W.category.descCatId,
        type_id: W.category.typeId,
        attributes: cloneJson(publishAttributes),
      });
      if (W.opts.warehouseId) {
        stocks.push({
          offer_id: offerId,
          stock: Number.isFinite(Number(row.stock)) && Number(row.stock) >= 0 ? Number(row.stock) : 10,
          warehouse_id: W.opts.warehouseId,
        });
      }
    });
    return { items, stocks };
  }

  async function runRewriteOnly() {
    if (W.running) return;
    if (!W.opts.storeId) { toast('请先选择上架店铺', 'error'); W.view = 'workbench'; render(); return; }
    if (!W.category) { toast('请先选择类目', 'error'); W.view = 'workbench'; render(); return; }
    const it = selectedListingItem();
    if (!it) { toast('请至少保留一个商品', 'error'); return; }

    W.running = true;
    setStep(3);
    pushLog('\n— AI 重写标题/描述/标签 —');
    renderBody();
    try {
      let title = it.skuName || W.raw.title || '';
      let description = '';
      let hashtags = [];
      const specsForRw = specsText();
      const resp = await bg({
        action: 'aiOptimizeForRating', storeId: W.opts.storeId,
        body: {
          title,
          description: specsForRw ? `${W.raw.title || ''}\n商品属性：${specsForRw}` : (W.raw.title || ''),
          category: { typeId: W.category.typeId, descriptionCategoryId: W.category.descCatId || undefined },
          categoryName: W.category.name,
          visualTags: W.categoryVisualTags || [],
          currentAttrs: currentAttrSnapshot(),
          modules: ['title', 'description', 'hashtags'],
        },
      });
      if (!resp.ok) throw new Error(resp.error);
      const mod = resp.data?.modules || {};
      if (mod.title?.value) title = mod.title.value;
      if (mod.description?.value) description = mod.description.value;
      if (Array.isArray(mod.hashtags?.value)) hashtags = mod.hashtags.value;
      W.generatedContent = { title, description, hashtags, updatedAt: Date.now() };
      pushLog(`· 标题：${title}`);
      if (description) pushLog(`· 描述：${String(description).slice(0, 90)}…`);
      if (hashtags.length) pushLog(`· 标签：${hashtags.slice(0, 8).join(' ')}`);
      toast('AI 文案已生成', 'ok');
    } catch (e) {
      pushLog(`✗ 重写失败：${e?.message || e}`);
      toast('AI 重写失败：' + (e?.message || e), 'error');
    } finally {
      W.running = false;
      renderBody();
    }
  }

  async function runPublishOnly() {
    if (W.running) return;
    const selected = W.items.filter((it) => it.checked);
    if (!selected.length) { toast('请至少勾选一个商品', 'error'); return; }
    if (!W.opts.storeId) { toast('请先选择上架店铺', 'error'); W.view = 'workbench'; render(); return; }
    if (!W.category) { toast('请先把产品类目选到末级', 'error'); W.view = 'workbench'; render(); return; }

    W.running = true;
    setStep(3);
    pushLog('\n— 独立提交上架 —');
    renderBody();
    try {
      const okReq = filledAttrsOf(W.reqAttrs);
      const okRating = filledAttrsOf(W.ratingAttrs);
      const okAttrs = [...okReq, ...okRating];
      const miss = W.reqAttrs.length - okReq.length;
      if (miss > 0) {
        pushLog(`✗ 必填属性还缺 ${miss} 项，请先补齐后再提交上架。`);
        throw new Error(`必填属性还缺 ${miss} 项，已取消提交`);
      }

      const content = W.generatedContent || {};
      const title = content.title || '';
      const description = content.description || '';
      const hashtags = Array.isArray(content.hashtags) ? content.hashtags : [];
      const attributes = okAttrs.map(submitAttributeOf).filter(Boolean);
      const built = buildPublishItems(selected, { title, description, hashtags, attributes });
      const pubResp = await bg({
        action: 'followSell', storeId: W.opts.storeId, items: built.items,
        applyPoster: W.opts.imageTranslate, posterPrimaryOnly: true, applyWatermark: false,
        applyAiRewrite: false, strictTypeMatch: false,
        stocks: built.stocks.length ? built.stocks : undefined,
      });
      if (!pubResp.ok) throw new Error('提交上架失败：' + pubResp.error);
      const taskId = pubResp.data?.result?.task_id || pubResp.data?.task_id || '';
      const offerIds = built.items.map((item) => item.offer_id).join('、');
      pushLog(taskId ? `✓ 已提交上架（货号 ${offerIds}，task=${taskId}）` : `✓ 已提交上架（${built.items.length} 个商品）`);
      setStep(4);
      toast('已提交上架', 'ok');
    } catch (e) {
      pushLog(`✗ ${e?.message || String(e)}`);
      toast(e?.message || String(e), 'error');
    } finally {
      W.running = false;
      renderBody();
    }
  }

  async function aiFillAttrs(attrScope = 'required-and-rating', opts = {}) {
    if (!W.opts.storeId) { toast('请先选择上架店铺（AI 填充需带店铺）', 'error'); return; }
    if (!W.category) { toast('请先选择类目', 'error'); return; }
    if (opts.logTitle) {
      W.view = 'workbench';
      setStep(Math.max(W.step || 2, 3));
      pushLog(`\n— ${opts.logTitle} —`);
    }
    W.attrFilling = true; renderBody();
    try {
      const it = W.items.find((x) => x.checked) || W.items[0];
      const specs = specsText();
      const resp = await bg({
        action: 'aiOptimizeForRating', storeId: W.opts.storeId,
        body: {
          productId: String(offerIdentity(W.raw) || '').slice(0, 64),
          title: textValue(W.raw?.title) || textValue(it?.skuName),
          // 把 1688 商品属性当「商品画像」喂给 AI，填属性时信息更全、更准
          description: attrFillDescription(it, specs),
          category: { typeId: W.category.typeId, descriptionCategoryId: W.category.descCatId || undefined },
          categoryName: W.category.name,
          visualTags: W.categoryVisualTags || [],
          attrScope,
          currentAttrs: currentAttrSnapshot(),
          modules: ['attrs'],
        },
      });
      if (!resp.ok) throw new Error(resp.error);
      const filled = resp.data?.modules?.attrs?.filled || [];
      let nReq = 0, nManual = 0; const rating = [];
      filled.forEach((f) => {
        const fid = Number(f.id);
        const schemaAttr = schemaAttrById(fid);
        const isRequiredBySchema = isSchemaRequiredAttr(schemaAttr);
        const isDict = f.source === 'dict-match';
        const okVal = isDict ? !!f.resolvedDictValueId : !!f.resolvedDictValue;
        const req = W.reqAttrs.find((x) => x.id === fid);
        if (attrScope === 'required' && !isRequiredBySchema) return;
        if (attrScope === 'rating' && (req || isRequiredBySchema)) return;
        if (!okVal) {
          if (req && (f.status === 'needs_manual' || isDict)) {
            const suggested = f.suggestedLabel || f.resolvedDictValue || '';
            req.needsManual = true;
            req.manualReason = f.reason || (isDict ? 'dict_value_not_found' : 'needs_manual');
            req.suggestedLabel = suggested;
            if (req.dict) { req.dictValue = suggested; req.dictValueId = ''; }
            else if (suggested) req.value = suggested;
            req.aiFilled = false;
            nManual++;
          }
          return;
        }
        if (req) {                                   // tier1 必填 → 回填必填区
          if (req.dict) { req.dictValueId = String(f.resolvedDictValueId); req.dictValue = f.resolvedDictValue || ''; }
          else req.value = f.resolvedDictValue || '';
          req.needsManual = false; req.manualReason = ''; req.suggestedLabel = '';
          req.aiFilled = true; nReq++;
        } else {                                     // tier2 非必填 → 内容评级加分区
          rating.push({
            id: fid, name: f.name || f.suggestedLabel || ('属性' + fid), dict: isDict,
            dictValueId: isDict ? String(f.resolvedDictValueId) : '',
            dictValue: isDict ? (f.resolvedDictValue || '') : '',
            value: isDict ? '' : (f.resolvedDictValue || ''), aiFilled: true,
          });
        }
      });
      if (attrScope !== 'required') W.ratingAttrs = mergeRatingAttrs(W.ratingAttrs, rating);
      if (W.aiLog.length) {
        pushLog(`· 必填属性：${nReq}/${W.reqAttrs.length} 已填` + (nManual ? `，需手动 ${nManual} 项` : ''));
        if (attrScope !== 'required') pushLog(`· 内容评级属性：${W.ratingAttrs.length} 项`);
      }
      toast(`AI 填充：必填 ${nReq}/${W.reqAttrs.length}、需手动 ${nManual} 项、内容评级 ${W.ratingAttrs.length} 项`, (nReq || rating.length || W.ratingAttrs.length) ? 'ok' : 'error');
    } catch (e) {
      if (W.aiLog.length) pushLog(`✗ AI 填充失败：${e?.message || e}`);
      toast('AI 填充失败：' + (e?.message || e), 'error');
    } finally {
      W.attrFilling = false; renderBody();
    }
  }

  // ───────────────────────────────── 图片中心 ──
  function renderImages(body) {
    const imgs = W.raw.mainImages || [];
    if (!imgs.length) { body.innerHTML = `<div class="aiw-card" style="text-align:center;color:#7686a3;padding:50px">未采集到图片</div>`; return; }
    body.innerHTML = `<div class="aiw-card"><div class="aiw-grid">${imgs.map((src, i) => {
      const kind = i === 0 ? 'main' : 'slide';     // MVP：首图=主图，其余=轮播；详情图采集端暂未单独区分
      const label = i === 0 ? '主图' : '轮播';
      return `<div class="aiw-imgcard"><span class="aiw-tag ${kind}">${label}</span><img src="${esc(src)}" loading="lazy"></div>`;
    }).join('')}</div><div class="aiw-note">主图/轮播由采集顺序推断；AI 改图（图片翻译开启时）在后端 poster 任务里完成，结果以采集箱草稿为准。</div></div>`;
  }

  // ───────────────────────────────── 系统设置 ──
  function renderSettings(body) {
    body.innerHTML = `
      <div class="aiw-card">
        <div class="aiw-card-t" style="margin-bottom:6px">AI 引擎</div>
        <div class="aiw-set-row"><span class="k">文本智能体</span><span class="v" id="aiw-set-engine">${esc(W.aiEngine)}</span></div>
        <div class="aiw-set-row"><span class="k">AI 配额 / 会员</span><span class="v" id="aiw-set-quota">加载中…</span></div>
        <div class="aiw-note">AI 由后端统一托管，扩展端无需配置 API Key（与「乌拉」让用户自填阿里百炼 key 的方式不同）。</div>
      </div>
      <div class="aiw-card">
        <div class="aiw-card-t" style="margin-bottom:6px">处理参数</div>
        <div class="aiw-set-row"><span class="k">目标毛利率（%）</span>
          <input type="text" class="aiw-cell-inp aiw-num" id="aiw-margin" value="${esc(W.opts.targetMargin)}"></div>
        <div class="aiw-set-row"><span class="k">CNY→RUB 汇率</span><span class="v">${W.fxRate ? '1¥≈' + W.fxRate + '₽' : '加载中…'}</span></div>
        <div class="aiw-set-row"><span class="k">类目智选偏好</span><span class="v">AI 自动匹配（默认）</span></div>
        <div class="aiw-note">定价：1688 人民币成本 × CNY→RUB 汇率 ×（1+目标毛利），按店铺绑定货币输出。</div>
      </div>`;
    const m = body.querySelector('#aiw-margin');
    if (m) m.addEventListener('input', () => { const n = parseInt(m.value, 10); if (Number.isFinite(n)) W.opts.targetMargin = n; });
    loadQuota();
  }

  // ──────────────────────────────────────────── data loaders ──
  function pickArray(raw, keys) {
    const queue = [raw];
    const seen = new Set();
    while (queue.length) {
      const cur = queue.shift();
      if (Array.isArray(cur)) return cur;
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);
      keys.forEach((k) => {
        if (cur[k] !== undefined && cur[k] !== null) queue.push(cur[k]);
      });
    }
    return [];
  }

  function normalizeCategoryTree(raw) {
    return { children: pickArray(raw, ['children', 'result', 'data', 'items']) };
  }

  function resetCategorySelection() {
    W.catTree = null; W.catTreeLoading = false; W.catTreeError = '';
    W.catPath = []; W.category = null; W.categoryVisualTags = []; W.attrsSchema = []; W.reqAttrs = []; W.ratingAttrs = [];
    W.catAuto = ''; W.attrFilling = false;
  }

  function selectStore(storeId, opts = {}) {
    const next = String(storeId || '');
    W.opts.storeId = next;
    const sel = W.stores.find((s) => String(s.id) === next);
    W.opts.storeCurrency = (sel && sel.currency) || 'RUB';
    W.opts.warehouseId = '';
    W.warehouses = [];
    resetCategorySelection();
    fillStoreSelect();
    fillWarehouseSelect();
    renderCatCascade();
    if (opts.reload && next) {
      loadWarehouses();
      loadCategoryTree();
    }
  }

  async function loadStores() {
    const [resp, authResp] = await Promise.all([
      bg({ action: 'getStores' }),
      bg({ action: 'getAuth' }).catch(() => ({ ok: false })),
    ]);
    if (resp.ok) {
      const raw = pickArray(resp.data, ['data', 'result', 'items', 'stores']);
      W.stores = raw.map((s) => ({
        id: s.id || s.storeId || s.store_id || s.value,
        label: s.label || s.companyName || s.legalName || s.name || s.clientId || s.id || s.storeId,
        currency: s.companyCurrency || s.currency || 'RUB',   // 店铺绑定货币
      })).filter((s) => s.id);
      const authStoreId = String(authResp?.ok ? (authResp.data?.storeId || '') : '');
      const selected =
        W.stores.find((s) => String(s.id) === authStoreId)?.id ||
        (W.stores.length === 1 ? W.stores[0].id : '');
      if (selected) selectStore(selected, { reload: true });
      else fillStoreSelect();
    } else {
      log('getStores failed', resp.error);
    }
  }

  function fillStoreSelect() {
    const sel = document.getElementById('aiw-store');
    if (!sel) return;
    sel.innerHTML = `<option value="">请选择</option>` +
      W.stores.map((s) => `<option value="${esc(s.id)}" ${String(s.id) === String(W.opts.storeId) ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
  }

  async function loadWarehouses() {
    const storeId = W.opts.storeId;
    const reqId = ++warehousesReqSeq;
    W.warehouses = [];
    fillWarehouseSelect();
    if (!storeId) return;
    const resp = await bg({ action: 'getWarehouses', storeId });
    if (reqId !== warehousesReqSeq || storeId !== W.opts.storeId) return;
    if (resp.ok) {
      const raw = pickArray(resp.data, ['warehouses', 'result', 'data', 'items']);
      W.warehouses = raw.map((w) => ({
        id: w.warehouse_id || w.warehouseId || w.id || w.value,
        label: w.name || w.label || w.warehouse_name || w.warehouse || w.warehouse_id || w.warehouseId || w.id,
      })).filter((w) => w.id);
      fillWarehouseSelect();
    } else {
      log('getWarehouses failed', resp.error);
    }
  }

  function fillWarehouseSelect() {
    const sel = document.getElementById('aiw-wh');
    if (!sel) return;
    sel.innerHTML = `<option value="">请选择</option>` +
      W.warehouses.map((w) => `<option value="${esc(w.id)}" ${String(w.id) === String(W.opts.warehouseId) ? 'selected' : ''}>${esc(w.label)}</option>`).join('');
  }

  async function loadAiEngine() {
    // 没有专门的引擎查询接口，用固定标签即可；配额在设置页拉。
    W.aiEngine = 'AI 智能体 · 后端托管';
  }

  async function loadFxRate() {
    const resp = await bg({ action: 'getFxRate' });
    if (resp.ok && resp.data?.rate) W.fxRate = resp.data.rate;
    else log('getFxRate failed', resp.error);
  }

  async function loadQuota() {
    const resp = await bg({ action: 'getAiQuota' });
    const v = document.getElementById('aiw-set-quota');
    if (!v) return;
    if (resp.ok) {
      const d = resp.data || {};
      const member = d.membership?.active ? '会员有效' : '普通';
      const imgs = d.aiImageRemaining ?? d.remaining ?? '—';
      v.textContent = `${member}｜AI改图余额 ${imgs}`;
    } else {
      v.textContent = '无法获取（需登录）';
    }
  }

  // ─────────────────────────────────────────── pipeline ──
  function pushLog(line) {
    W.aiLog.push(line);
    const box = document.getElementById('aiw-log');
    if (box) { box.textContent = W.aiLog.join('\n'); box.scrollTop = box.scrollHeight; }
    saveWizardDraft();
  }

  function setStep(n) { W.step = n; }

  async function runPipeline() {
    if (W.running) return;
    const selected = W.items.filter((it) => it.checked);
    if (!selected.length) { toast('请至少勾选一个商品', 'error'); return; }
    if (!W.opts.storeId) { toast('请先选择上架店铺', 'error'); W.view = 'workbench'; render(); return; }
    if (!W.category) { toast('请先把产品类目选到末级', 'error'); W.view = 'workbench'; render(); return; }

    W.running = true;
    setStep(3);
    W.aiLog = [];
    render();
    pushLog(`▶ 开始：店铺=${storeLabel()}  类目=${W.category.name}  直上=${W.opts.directListing ? '是' : '否'}`);

    let okCount = 0, failCount = 0;
    try {
      const it = selected[0];   // MVP：一次处理勾选的第一个

      // 1) 采集入箱（留采集记录；import 上架不依赖它）
      pushLog(`\n— 采集入箱 —`);
      const collectResp = await bg({
        action: 'pushSourceCollect', sourceId: '1688', raw: W.raw,
        forceResubmit: true, resetDraft: true, storeId: W.opts.storeId,
      });
      if (collectResp.ok) pushLog(`✓ 已入采集箱 id=${String(collectResp.data?.result?.id || '').slice(0, 8)}…`);
      else pushLog(`⚠ 入采集箱失败：${collectResp.error}（不影响上架）`);

      // 2) AI 重写文案（与跟卖同一套 rewrite prompt）
      pushLog(`\n— AI 重写标题/描述/标签 —`);
      let title = it.skuName || W.raw.title || '', description = '', hashtags = [];
      const specsForRw = specsText();
      const rwResp = await bg({
        action: 'aiOptimizeForRating', storeId: W.opts.storeId,
        body: {
          title, description: specsForRw ? `${W.raw.title || ''}\n商品属性：${specsForRw}` : (W.raw.title || ''),
          category: { typeId: W.category.typeId, descriptionCategoryId: W.category.descCatId || undefined },
          categoryName: W.category.name,
          visualTags: W.categoryVisualTags || [],
          currentAttrs: currentAttrSnapshot(),
          modules: ['title', 'description', 'hashtags'],
        },
      });
      if (rwResp.ok) {
        const mod = rwResp.data?.modules || {};
        if (mod.title?.value) { title = mod.title.value; pushLog(`· 标题：${title}`); }
        if (mod.description?.value) { description = mod.description.value; pushLog(`· 描述：${String(description).slice(0, 90)}…`); }
        if (mod.hashtags?.value?.length) { hashtags = mod.hashtags.value; pushLog(`· 标签：${hashtags.slice(0, 8).join(' ')}`); }
        W.generatedContent = { title, description, hashtags, updatedAt: Date.now() };
        saveWizardDraft();
      } else pushLog(`⚠ 重写失败：${rwResp.error}（用原标题）`);
      pushLog(`· 类目：${W.category.name}`);

      // 3) 定价（1688 人民币成本 → 店铺货币）
      const sp = computeSalePrice(it.buyPrice, W.opts.targetMargin);
      if (sp.error === 'missing_fx_rate') {
        pushLog(`✗ 定价失败：未取到 CNY→RUB 汇率，已停止，避免提交 0 售价`);
        throw new Error('未取到 CNY→RUB 汇率，已取消提交');
      }
      const pricingSnapshot = applyPricingSnapshot(it, sp);
      renderBody();
      if (sp.currency === 'RUB' && !W.fxRate) pushLog(`⚠ 未取到 CNY→RUB 汇率，定价可能不准`);
      pushLog(`· 货源成本：¥${sp.costCny}（CNY）` + (sp.currency === 'RUB' ? `  汇率 1¥≈${sp.rate}₽` : ''));
      pushLog(`· 建议售价：${sp.price} ${sp.currency}（目标毛利 ${W.opts.targetMargin}%）`);

      // 3.5) 属性没动过则自动 AI 填充（必填 tier1 + 内容评级 tier2 一次填完），
      //      免去手动点两个「AI 填充」按钮。用户已手填/点过则尊重现状、不覆盖。
      const missingRequired = W.reqAttrs.some((a) => !attrHasSubmitValue(a));
      const hasPotentialRatingAttrs = W.attrsSchema.some((a) => !a.is_required);
      const missingRating = hasPotentialRatingAttrs && !W.ratingAttrs.some(attrHasSubmitValue);
      if (W.attrsSchema.length && (missingRequired || missingRating)) {
        pushLog(`\n— AI 填充属性（必填 + 内容评级）—`);
        await aiFillAttrs('required-and-rating');
      }

      // 4) 属性：必填(tier1) + 内容评级(tier2)，AI 填充/手填的，一起带上架
      const okReq = filledAttrsOf(W.reqAttrs);
      const okRating = filledAttrsOf(W.ratingAttrs);
      const okAttrs = [...okReq, ...okRating];
      const miss = W.reqAttrs.length - okReq.length;
      if (W.opts.directListing && miss > 0) {
        pushLog(`· 必填属性：${okReq.length}/${W.reqAttrs.length} 已填（缺 ${miss} 项，Ozon 可能驳回）`);
        const manualNames = W.reqAttrs
          .filter((a) => a.needsManual)
          .map((a) => `${a.name}${a.suggestedLabel ? `（AI建议：${a.suggestedLabel}）` : ''}`)
          .slice(0, 5)
          .join('、');
        if (manualNames) pushLog(`· 需手动确认：${manualNames}`);
        pushLog(`✗ 直上已停止：必填属性还缺 ${miss} 项，请先补齐后再启动。`);
        throw new Error(`必填属性还缺 ${miss} 项，已取消直上提交`);
      }
      const manualConfirmAttrs = W.opts.directListing ? requiredManualConfirmAttrs() : [];
      if (manualConfirmAttrs.length) {
        const manualNames = manualConfirmAttrs
          .map((a) => `${a.name}${manualDictionaryText(a) ? `（AI建议：${manualDictionaryText(a)}）` : ''}`)
          .slice(0, 5)
          .join('、');
        if (manualNames) pushLog(`· 需确认必填属性：${manualNames}`);
        throw new Error('请确认必填属性，确认无误请单击提交。');
      }
      pushLog(`· 必填属性：${okReq.length}/${W.reqAttrs.length} 已填` + (miss ? `（缺 ${miss} 项，Ozon 可能驳回）` : ''));
      if (W.ratingAttrs.length) pushLog(`· 内容评级属性：${okRating.length}/${W.ratingAttrs.length} 已填（提升内容评分）`);

      // 5) 包装尺寸/重量（采集自 1688 装箱表，cm→mm、g）
      const pkg = currentPackageInfo();
      if (pkg.source === 'scraped') {
        pushLog(`· 包装(采集)：${pkg.lengthMm}×${pkg.widthMm}×${pkg.heightMm}mm  ${pkg.weightG}g`);
      } else {
        pushLog(`· 包装：未采到，用当前默认 ${pkg.lengthMm}×${pkg.widthMm}×${pkg.heightMm}mm/${pkg.weightG}g（可手动改）`);
      }

      if (!W.opts.directListing) {
        // 把 AI 生成的标题 + 已填属性回写采集箱条目 —— 否则采集箱里只剩 pushSourceCollect 的源数据,
        // 编辑页(读 item.name + item.variantData.attributes)看不到生成的标题/属性(用户反馈点)。
        // 属性映射成编辑页读的 {key,value};dict 取 dictValue(与向导显示一致,后端按 value 兜底匹配)。
        const cbId = collectResp.ok ? (collectResp.data?.result?.id || '') : '';
        if (cbId) {
          const vdAttrs = okAttrs
            .map((a) => ({ key: String(a.id), value: String(a.dict ? (a.dictValue || a.value || '') : (a.value || '')) }))
            .filter((a) => a.value);
          const upd = await bg({
            action: 'updateCollectBoxItem', id: cbId, storeId: W.opts.storeId,
            body: {
              name: title,
              price: String(sp.price),
              draft: { pricingSnapshot },
              variantData: { attributes: vdAttrs, pricingSnapshot },
            },
          });
          if (upd.ok) pushLog(`✓ 已回写采集箱:标题 + ${vdAttrs.length} 条属性`);
          else pushLog(`⚠ 回写采集箱失败：${upd.error}（可去采集箱手动补）`);
        } else {
          pushLog(`⚠ 未拿到采集箱 id，生成内容未回写`);
        }
        pushLog(`\n✓ 已采集 + 生成内容，未直上。可去「采集箱」编辑后上架。`);
        okCount++;
      } else {
        pushLog(`\n— 直上：拼装并提交 import —`);
        const attributes = okAttrs.map(submitAttributeOf).filter(Boolean);
        const built = buildPublishItems(selected, { title, description, hashtags, attributes });
        const pubResp = await bg({
          action: 'followSell', storeId: W.opts.storeId, items: built.items,
          // 「图片翻译」走后端海报/改图：正确字段是 applyPoster（applyAiImage 已下线、import 不读）
          applyPoster: W.opts.imageTranslate, posterPrimaryOnly: true, applyWatermark: false,
          applyAiRewrite: false, strictTypeMatch: false,
          stocks: built.stocks.length ? built.stocks : undefined,
        });
        if (!pubResp.ok) throw new Error('提交上架失败：' + pubResp.error);
        const r = pubResp.data || {};
        const taskId = r.result?.task_id || r.task_id || '';
        const offerIds = built.items.map((item) => item.offer_id).join('、');
        pushLog(taskId
          ? `✓ 已提交上架（货号 ${offerIds}，task=${taskId}）`
          : `⚠ 已提交但未拿到 task_id：${JSON.stringify(r).slice(0, 140)}`);
        okCount++;
      }
    } catch (e) {
      failCount++;
      pushLog(`✗ ${e?.message || String(e)}`);
      log('pipeline error', e);
    }

    W.running = false;
    setStep(4);
    render();
    pushLog(`\n— 完成：成功 ${okCount}，失败 ${failCount} —`);
    toast(failCount ? `完成，失败 ${failCount}` : 'AI 采集完成', failCount ? 'error' : 'ok');
  }

  function storeLabel() {
    return W.stores.find((s) => s.id === W.opts.storeId)?.label || W.opts.storeId;
  }

  // 暴露入口给 alibaba-1688.js 面板按钮
  window.__JZC_OPEN_AI_WIZARD__ = open;
  log('ready');
})();
