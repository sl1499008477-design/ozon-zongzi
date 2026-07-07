// 极掌采集器 — 浮动控制面板（P1 完整版）
//
// 用法（在 content script 里）:
//   const panel = window.JZCollectorPanel.create({
//     queue,                   // JZTaskQueue 实例 (必传)
//     db,                      // JZCollectorDB (默认 window.JZCollectorDB)
//     onPushClick:        async () => ({ ok, message }),
//     onClearClick:       async () => {},
//     onExportClick:      async () => db.exportCsv(),
//     onToggleRunning:    (next) => {},   // 主开关：控制是否写入本地桶
//     onAutoScrollToggle: (next) => {},   // 自动翻页 on/off
//     onSalesFilterChange:(onlyWithSales) => {},
//     onKeywordsStart:    async (texts, maxN) => {},
//     onKeywordsStop:     async () => {},
//     onKeywordsClear:    async () => {},
//   });
//   panel.mount();
//   panel.setRunning(true);
//   panel.setAutoScrollerState({ running, autoPaused });
//   panel.setKeywordPilotState({ mode, currentKeyword, pendingCount, doneCount });
//   panel.toast('提示', 'success', 2000);

(() => {
  if (window.JZCollectorPanel && window.JZCollectorPanel._v2) return;

  const PANEL_HTML = `
    <div class="jz-c-header">
      <div class="jz-c-header-left">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="10" rx="2"/>
          <circle cx="12" cy="5" r="2"/>
          <path d="M12 7v4"/>
          <line x1="8" y1="16" x2="8" y2="16"/>
          <line x1="16" y1="16" x2="16" y2="16"/>
        </svg>
        <span>${globalThis.__JZ_BRAND__.displayName}采集器</span>
      </div>
      <div class="jz-c-header-actions">
        <button class="jz-c-icon-btn" data-act="collapse" title="折叠">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="jz-c-body">
      <div class="jz-c-status-row">
        <div class="jz-c-status" data-el="status">
          <span class="jz-c-status-dot"></span>
          <span data-el="status-text">已停止</span>
        </div>
        <button class="jz-c-toggle-btn" data-act="toggle" data-el="toggle">
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6,4 20,12 6,20"/></svg>
          <span data-el="toggle-text">启动</span>
        </button>
      </div>

      <div class="jz-c-progress">
        <div class="jz-c-stat">
          <span class="jz-c-stat-num" data-el="success">0</span>
          <span class="jz-c-stat-label">已加载</span>
        </div>
        <div class="jz-c-stat">
          <span class="jz-c-stat-num" data-el="running">0</span>
          <span class="jz-c-stat-label">进行中</span>
        </div>
        <div class="jz-c-stat is-failed">
          <span class="jz-c-stat-num" data-el="failed">0</span>
          <span class="jz-c-stat-label">失败<button class="jz-c-stat-retry jz-c-hidden" data-act="retry-failures" title="重试所有失败" data-el="retry-btn">↻</button></span>
        </div>
      </div>

      <div class="jz-c-row">
        <label class="jz-c-switch">
          <input type="checkbox" data-act="auto-scroll-toggle" data-el="auto-scroll-toggle" />
          <span class="jz-c-switch-track"><span class="jz-c-switch-knob"></span></span>
          <span class="jz-c-switch-label">自动翻页</span>
        </label>
        <label class="jz-c-checkbox">
          <input type="checkbox" data-act="sales-filter" data-el="sales-filter" />
          <span>仅抓有销量</span>
        </label>
      </div>
      <div class="jz-c-filter-entry" data-el="filter-entry">
        <div>
          <strong>智能筛选</strong>
          <span class="jz-c-filter-summary" data-el="filter-summary">未配置</span>
        </div>
        <button class="jz-c-btn jz-c-btn-ghost" data-act="filter-open">筛选设置</button>
      </div>

      <details class="jz-c-section" data-el="keyword-section">
        <summary>关键词采集器 <span class="jz-c-pill" data-el="kw-pill"></span></summary>
        <div class="jz-c-section-body">
          <textarea
            class="jz-c-textarea"
            placeholder="一行一个关键词，例如：&#10;коврик&#10;лежак&#10;игрушка"
            data-el="kw-textarea"
            rows="4"
          ></textarea>
          <div class="jz-c-row">
            <label class="jz-c-mini-input">
              <span>每个关键词上限</span>
              <input type="number" min="0" placeholder="0=无限制" data-el="kw-max" />
            </label>
          </div>
          <div data-el="kw-current" class="jz-c-kw-current jz-c-hidden">
            当前: <strong data-el="kw-current-text"></strong> ·
            进度 <span data-el="kw-pending-count">0</span> 待 / <span data-el="kw-done-count">0</span> 完成
          </div>
          <div class="jz-c-actions">
            <button class="jz-c-btn" data-act="kw-start" data-el="kw-start">开始</button>
            <button class="jz-c-btn jz-c-btn-danger-ghost" data-act="kw-stop" data-el="kw-stop">停止</button>
          </div>
          <div class="jz-c-actions full">
            <button class="jz-c-btn jz-c-btn-ghost" data-act="kw-clear">清空关键词队列</button>
          </div>
        </div>
      </details>

      <div class="jz-c-bucket">
        本地桶: <strong data-el="bucket-count">0</strong> 项
        <span data-el="pushed-info" class="jz-c-hidden">（已推送 <strong data-el="pushed-count">0</strong>）</span>
      </div>

      <div class="jz-c-actions">
        <button class="jz-c-btn jz-c-btn-ghost" data-act="export-xlsx">导出Excel</button>
        <button class="jz-c-btn jz-c-btn-danger-ghost" data-act="clear">清空本地桶</button>
      </div>
      <div class="jz-c-actions full">
        <button class="jz-c-btn" data-act="push" data-el="push-btn">推送到候选池</button>
      </div>

      <div class="jz-c-toast" data-el="toast"></div>
    </div>
  `;

  const BUBBLE_HTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="10" rx="2"/>
      <circle cx="12" cy="5" r="2"/>
      <path d="M12 7v4"/>
      <line x1="8" y1="16" x2="8" y2="16"/>
      <line x1="16" y1="16" x2="16" y2="16"/>
    </svg>
    <span class="jz-c-bubble-badge jz-c-hidden" data-el="badge">0</span>
  `;

  const COLLAPSED_KEY = 'jz-c-panel-collapsed';
  const KW_MAX_KEY = 'jz-c-kw-max';
  const SALES_FILTER_KEY = 'jz-c-sales-filter';
  const SMART_FILTER_KEY = 'jz-c-smart-filter-state';
  const SMART_FILTER_DEFAULT_ID = 'smart-filter-default';
  const SMART_TEMPLATE_MAX_NAME_LENGTH = 40;
  const FX_RUB_PER_CNY_FALLBACK = 11.5;
  const SMART_FILTER_FIELD_KEYS = [
    { key: 'soldCount', label: '月销量范围：', minPlaceholder: '最小值', maxPlaceholder: '最大值' },
    { key: 'gmvSum', label: '月销售额范围：', minPlaceholder: '最小值', maxPlaceholder: '最大值', prefix: '¥' },
    { key: 'price', label: '价格范围：', minPlaceholder: '最小价格', maxPlaceholder: '最大价格', prefix: '¥' },
    { key: 'marketingPrice', label: '黑标价范围：', minPlaceholder: '最小值', maxPlaceholder: '最大值', prefix: '¥' },
    { key: 'weight', label: '重量范围：', minPlaceholder: '最小重量', maxPlaceholder: '最大重量', suffix: 'g' },
    { key: 'listedDays', label: '上架时间：', minPlaceholder: '最小天数', maxPlaceholder: '最大天数', suffix: '天' },
    { key: 'monthlyTurnoverDynamic', label: '月周转动态：', minPlaceholder: '最小', maxPlaceholder: '最大', suffix: '%' },
    { key: 'adCostRatio', label: '广告费占比：', minPlaceholder: '最小', maxPlaceholder: '最大', suffix: '%' },
    { key: 'promoDays', label: '参与促销天数：', minPlaceholder: '最小天数', maxPlaceholder: '最大天数', suffix: '天' },
    { key: 'promoDiscount', label: '参与促销的折扣：', minPlaceholder: '最小', maxPlaceholder: '最大', suffix: '%' },
    { key: 'promoConversionRate', label: '促销活动的转化率：', minPlaceholder: '最小', maxPlaceholder: '最大', suffix: '%' },
    { key: 'paidPromotionDays', label: '付费推广天数：', minPlaceholder: '最小天数', maxPlaceholder: '最大天数', suffix: '天' },
    { key: 'views', label: '商品卡浏览量：', minPlaceholder: '最小值', maxPlaceholder: '最大值' },
    { key: 'cardAddToCartRate', label: '商品卡加购率：', minPlaceholder: '最小', maxPlaceholder: '最大', suffix: '%' },
    { key: 'searchCatalogViews', label: '搜索目录浏览量：', minPlaceholder: '最小值', maxPlaceholder: '最大值' },
    { key: 'searchCatalogAddToCartRate', label: '搜索目录加购率：', minPlaceholder: '最小', maxPlaceholder: '最大', suffix: '%' },
    { key: 'displayConversionRate', label: '展示转化率：', minPlaceholder: '最小', maxPlaceholder: '最大', suffix: '%' },
    { key: 'returnCancelRate', label: '退货取消率：', minPlaceholder: '最小', maxPlaceholder: '最大', suffix: '%' },
    { key: 'followerCount', label: '跟卖人数：', minPlaceholder: '最小值', maxPlaceholder: '最大值', suffix: '人' },
    { key: 'lowestFollowerPrice', label: '跟卖最低价：', minPlaceholder: '最小值', maxPlaceholder: '最大值', prefix: '¥' },
  ];
  const SMART_FILTER_SELECT_KEYS = [
    { key: 'shippingMode', label: '发货模式：', options: ['FBS', 'FBO', '不限'] },
  ];
  const SMART_FILTER_BRAND_OPTIONS = [
    { value: 'branded', label: '有品牌' },
    { value: 'noBrand', label: '无品牌' },
    { value: 'any', label: '不限' },
  ];
  const LOCAL_COLLECT_TOAST_ROOT_ID = 'jz-c-local-collect-toast-root';
  const LOCAL_COLLECT_TOAST_DURATION_MS = 1800;
  let localCollectToastSeq = 0;

  function showLocalCollectToast(sku) {
    const displaySku = String(sku || '').trim();
    if (!displaySku) return;
    const seq = ++localCollectToastSeq;

    let root = document.getElementById(LOCAL_COLLECT_TOAST_ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = LOCAL_COLLECT_TOAST_ROOT_ID;
      root.className = 'jz-c-local-collect-toast-root';
      (document.body || document.documentElement).appendChild(root);
    }

    root.replaceChildren();

    const item = document.createElement('div');
    item.className = 'jz-c-local-collect-toast';

    const icon = document.createElement('span');
    icon.className = 'jz-c-local-collect-toast-icon';
    icon.textContent = '✓';

    const text = document.createElement('span');
    text.className = 'jz-c-local-collect-toast-text';
    text.textContent = `自动收藏商品成功: ${displaySku}`;

    item.append(icon, text);
    root.appendChild(item);
    requestAnimationFrame(() => item.classList.add('is-visible'));

    window.setTimeout(() => {
      if (seq !== localCollectToastSeq) return;
      item.classList.add('is-leaving');
      window.setTimeout(() => item.remove(), 180);
    }, LOCAL_COLLECT_TOAST_DURATION_MS);
  }

  const FILTER_MODAL_HTML = `
    <div class="jz-c-filter-mask jz-c-hidden" data-el="filter-mask">
      <div class="jz-c-filter-modal">
        <div class="jz-c-filter-head">
          <div>
            <h3>编辑选品规则</h3>
          </div>
          <button class="jz-c-btn jz-c-btn-ghost jz-c-filter-close" data-act="filter-close">×</button>
        </div>

        <div class="jz-c-filter-toolbar">
          <label class="jz-c-checkbox">
            <input type="checkbox" data-field="enabled" />
            <span>启用选品规则</span>
          </label>
          <div class="jz-c-filter-template">
            <span>模板：</span>
            <select class="jz-c-filter-template-select" data-el="filter-template" data-field="template"></select>
            <div class="jz-c-filter-template-actions">
              <button class="jz-c-btn jz-c-btn-ghost" data-act="filter-add">新增</button>
              <button class="jz-c-btn jz-c-btn-ghost" data-act="filter-rename">重命名</button>
              <button class="jz-c-btn jz-c-btn-ghost" data-act="filter-delete">删除</button>
            </div>
          </div>
        </div>

        <div class="jz-c-filter-table" data-el="filter-table"></div>

        <div class="jz-c-filter-foot">
          <button class="jz-c-btn jz-c-btn-ghost" data-act="filter-close">取消</button>
          <button class="jz-c-btn jz-c-btn-ghost" data-act="filter-reset">重置为空</button>
          <button class="jz-c-btn" data-act="filter-save">保存</button>
        </div>
      </div>
    </div>
  `;

  function create(opts = {}) {
    const queue = opts.queue;
    const db = opts.db || window.JZCollectorDB;
    if (!queue) throw new Error('JZCollectorPanel: queue is required');

    let panelEl = null;
    let bubbleEl = null;
    let collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
    let mounted = false;
    let unsubscribers = [];
    let running = false;
    let autoScrollerRunning = false;
    let autoScrollerAutoPaused = false;
    let pilotState = { mode: 'IDLE', currentKeyword: null };
    let toastTimer = null;
    let smartFilterState = null;
    let filterMaskEl = null;
    let smartFxRubPerCny = FX_RUB_PER_CNY_FALLBACK;
    let smartFxRefreshPromise = null;

    function _q(sel) { return panelEl.querySelector(`[data-el="${sel}"]`); }
    function _qm(sel) { return filterMaskEl?.querySelector(`[data-el="${sel}"]`); }
    function _qmf(sel) { return filterMaskEl?.querySelector(`[data-field="${sel}"]`); }
    function _toNumber(value) {
      if (value === null || value === undefined || value === '') return null;
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      const normalized = String(value).replace(/\u00a0/g, ' ').trim();
      const match = normalized.replace(/\s+/g, '').match(/[-+]?\d+(?:[,.]\d+)?/);
      if (!match) return null;
      const parsed = Number(match[0].replace(',', '.'));
      return Number.isFinite(parsed) ? parsed : null;
    }
    function _toFixedNumber(value) {
      if (value === null || value === undefined || value === '') return null;
      if (typeof value === 'number') return value;
      if (typeof value === 'string') {
        const normalized = value.replace(/\u00a0/g, ' ').trim();
        const match = normalized.replace(/\s+/g, '').match(/[-+]?\d+(?:[,.]\d+)?/);
        if (!match) return null;
        const parsed = Number(match[0].replace(',', '.'));
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    }

    function _smartFxRate() {
      return smartFxRubPerCny > 0 ? smartFxRubPerCny : FX_RUB_PER_CNY_FALLBACK;
    }

    function _refreshSmartFxRate() {
      if (smartFxRefreshPromise) return smartFxRefreshPromise;
      const sendMessage = globalThis.chrome?.runtime?.sendMessage;
      if (typeof sendMessage !== 'function') return Promise.resolve(_smartFxRate());
      smartFxRefreshPromise = new Promise((resolve) => {
        try {
          sendMessage.call(chrome.runtime, { action: 'getFxRate' }, resolve);
        } catch {
          resolve(null);
        }
      }).then((resp) => {
        const rate = Number(resp?.data?.rate);
        if (resp?.ok && Number.isFinite(rate) && rate > 0) {
          smartFxRubPerCny = rate;
        }
        return _smartFxRate();
      }).catch(() => _smartFxRate()).finally(() => {
        smartFxRefreshPromise = null;
      });
      return smartFxRefreshPromise;
    }

  function _smartDefaultTemplate() {
    return {
      id: SMART_FILTER_DEFAULT_ID,
      name: '默认模板',
      brandOption: 'any',
      shippingMode: '不限',
      conditions: {
        soldCount: { min: null, max: null },
        gmvSum: { min: null, max: null },
        price: { min: null, max: null },
        weight: { min: null, max: null },
        listedDays: { min: null, max: null },
        monthlyTurnoverDynamic: { min: null, max: null },
        adCostRatio: { min: null, max: null },
        promoDays: { min: null, max: null },
        promoDiscount: { min: null, max: null },
        promoConversionRate: { min: null, max: null },
        paidPromotionDays: { min: null, max: null },
        views: { min: null, max: null },
        cardAddToCartRate: { min: null, max: null },
        searchCatalogViews: { min: null, max: null },
        searchCatalogAddToCartRate: { min: null, max: null },
        displayConversionRate: { min: null, max: null },
        returnCancelRate: { min: null, max: null },
        followerCount: { min: null, max: null },
        lowestFollowerPrice: { min: null, max: null },
        },
      };
    }

    function _genTemplateId() {
      return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

  function _smartNormTemplate(template) {
    const src = template || {};
    const norm = {
      id: String(src.id || _genTemplateId()),
      name: String(src.name || '未命名模板')
        .trim()
        .slice(0, SMART_TEMPLATE_MAX_NAME_LENGTH) || '未命名模板',
      brandOption: SMART_FILTER_BRAND_OPTIONS.some((item) => item.value === src.brandOption)
        ? src.brandOption
        : 'any',
      shippingMode: SMART_FILTER_SELECT_KEYS[0].options.includes(src.shippingMode)
        ? src.shippingMode
        : '不限',
      conditions: {},
    };
      SMART_FILTER_FIELD_KEYS.forEach((field) => {
        const raw = src.conditions?.[field.key] || {};
        norm.conditions[field.key] = {
          min: _toNumber(raw.min),
          max: _toNumber(raw.max),
        };
      });
      return norm;
    }

    function _smartLoadState() {
      const fallback = {
        enabled: false,
        currentTemplateId: SMART_FILTER_DEFAULT_ID,
        templates: [_smartDefaultTemplate()],
      };
      const raw = localStorage.getItem(SMART_FILTER_KEY);
      if (!raw) return fallback;
      try {
        const parsed = JSON.parse(raw);
        const seenIds = new Set();
        const templates = Array.isArray(parsed?.templates)
          ? parsed.templates
              .map(_smartNormTemplate)
              .filter((item) => {
                if (!item || !item.id) return false;
                if (seenIds.has(item.id)) return false;
                seenIds.add(item.id);
                return true;
              })
          : [_smartDefaultTemplate()];
        if (!templates.length) templates.push(_smartDefaultTemplate());
        if (!templates.some((item) => item.id === SMART_FILTER_DEFAULT_ID)) {
          templates.unshift(_smartDefaultTemplate());
        } else {
          const defaultIndex = templates.findIndex((item) => item.id === SMART_FILTER_DEFAULT_ID);
          if (defaultIndex > 0) {
            const defaultTemplate = templates.splice(defaultIndex, 1)[0];
            templates.unshift(defaultTemplate);
          }
        }
        let currentTemplateId = String(parsed.currentTemplateId || SMART_FILTER_DEFAULT_ID);
        if (!templates.some((x) => x.id === currentTemplateId)) {
          currentTemplateId = SMART_FILTER_DEFAULT_ID;
        }
        return {
          enabled: typeof parsed?.enabled === 'boolean' ? !!parsed.enabled : false,
          currentTemplateId,
          templates,
        };
      } catch {
        return fallback;
      }
    }

    function _smartSaveState(state) {
      const templates = Array.isArray(state?.templates)
        ? state.templates.map(_smartNormTemplate).filter((item) => item && item.id)
        : [_smartDefaultTemplate()];
      const seenIds = new Set();
      const dedupedTemplates = [];
      templates.forEach((item) => {
        if (seenIds.has(item.id)) return;
        seenIds.add(item.id);
        dedupedTemplates.push(item);
      });
      let currentTemplateId = String(state?.currentTemplateId || SMART_FILTER_DEFAULT_ID);
      if (!dedupedTemplates.some((item) => item.id === currentTemplateId)) {
        currentTemplateId = SMART_FILTER_DEFAULT_ID;
      }
      const fixed = {
        enabled: !!state?.enabled,
        currentTemplateId,
        templates: dedupedTemplates,
      };
      try {
        localStorage.setItem(SMART_FILTER_KEY, JSON.stringify(fixed));
      } catch {}
    }

    function _smartEnsureCurrentTemplate() {
      if (!smartFilterState.templates || !smartFilterState.templates.length) {
        smartFilterState.templates = [_smartDefaultTemplate()];
      }
      if (!smartFilterState.currentTemplateId) {
        smartFilterState.currentTemplateId = SMART_FILTER_DEFAULT_ID;
      }
      if (!_getTemplateById(smartFilterState.currentTemplateId)) {
        smartFilterState.currentTemplateId = smartFilterState.templates[0]?.id || SMART_FILTER_DEFAULT_ID;
      }
      if (!smartFilterState.templates.some((item) => item.id === smartFilterState.currentTemplateId)) {
        smartFilterState.currentTemplateId = SMART_FILTER_DEFAULT_ID;
      }
      const defaultTemplate = smartFilterState.templates.find((item) => item.id === SMART_FILTER_DEFAULT_ID);
      if (!defaultTemplate) {
        smartFilterState.templates.unshift(_smartDefaultTemplate());
        smartFilterState.currentTemplateId = SMART_FILTER_DEFAULT_ID;
      }
    }

    function _smartMakeTemplateName(baseName, existing) {
      const existingSet = new Set((existing || []).map((name) => String(name || '').trim()));
      const trimmedBase = String(baseName || '').trim().slice(0, SMART_TEMPLATE_MAX_NAME_LENGTH);
      const base = trimmedBase || '模板';
      if (!existingSet.has(base) && base.length > 0) return base;
      for (let i = 1; i <= 99; i += 1) {
        const candidate = `${base} ${i}`.trim();
        if (!existingSet.has(candidate)) return candidate;
      }
      return `${base}-${Date.now()}`;
    }

    function _smartCloneConditions(src) {
      const next = {};
      SMART_FILTER_FIELD_KEYS.forEach((field) => {
        const cfg = src?.[field.key] || {};
        next[field.key] = {
          min: _toNumber(cfg.min),
          max: _toNumber(cfg.max),
        };
      });
      return next;
    }

  function _addTemplate() {
    const source = smartCurrentTemplate();
    const newTemplate = {
      id: _genTemplateId(),
      name: _smartMakeTemplateName('新模板', smartFilterState.templates.map((item) => item.name)),
      brandOption: source?.brandOption || 'any',
      shippingMode: source?.shippingMode || '不限',
      conditions: _smartCloneConditions(source?.conditions),
    };
      smartFilterState.templates.push(newTemplate);
      smartFilterState.currentTemplateId = newTemplate.id;
      _smartSaveState(smartFilterState);
      _renderFilterTemplateOptions();
      _renderFilterForm();
      _refreshFilterSummary();
      _syncFilterToGlobal();
      toast('已新增模板', 'success', 1200);
    }

    function _renameTemplateById(templateId, nextName) {
      const template = _getTemplateById(templateId);
      if (!template) return;
      if (template.id === SMART_FILTER_DEFAULT_ID) return;
      const normalized = _smartMakeTemplateName(
        String(nextName || '').trim(),
        smartFilterState.templates
          .filter((item) => item.id !== templateId)
          .map((item) => item.name)
      );
      template.name = normalized;
      _smartSaveState(smartFilterState);
      _renderFilterTemplateOptions();
      _renderFilterForm();
      _refreshFilterSummary();
      _syncFilterToGlobal();
    }

    function _deleteTemplateById(templateId) {
      if (templateId === SMART_FILTER_DEFAULT_ID) return;
      smartFilterState.templates = smartFilterState.templates.filter((item) => item.id !== templateId);
      _smartEnsureCurrentTemplate();
      _smartSaveState(smartFilterState);
      _renderFilterTemplateOptions();
      _renderFilterForm();
      _refreshFilterSummary();
      _syncFilterToGlobal();
    }

    function _renameTemplate() {
      const template = smartCurrentTemplate();
      if (!template || template.id === SMART_FILTER_DEFAULT_ID) {
        if (template?.id === SMART_FILTER_DEFAULT_ID) {
          toast('默认模板不可重命名', 'info', 1200);
        }
        return;
      }
      const input = window.prompt('请输入模板名称');
      const normalizedInput = String(input || '').trim();
      if (!normalizedInput) return;
      if (normalizedInput.length > SMART_TEMPLATE_MAX_NAME_LENGTH) {
        toast(`模板名称最长${SMART_TEMPLATE_MAX_NAME_LENGTH}字符`, 'info', 1400);
        return;
      }
      _renameTemplateById(template.id, normalizedInput);
      toast('模板已重命名', 'success', 1200);
    }

    function _deleteTemplate() {
      const template = smartCurrentTemplate();
      if (!template || template.id === SMART_FILTER_DEFAULT_ID) {
        if (template?.id === SMART_FILTER_DEFAULT_ID) {
          toast('默认模板不可删除', 'info', 1200);
        }
        return;
      }
      if (!window.confirm(`确认删除模板「${template.name || '未命名模板'}」？`)) return;
      _deleteTemplateById(template.id);
      toast('模板已删除', 'success', 1200);
    }

    function smartCurrentTemplate() {
      return smartFilterState.templates.find((item) => item.id === smartFilterState.currentTemplateId) || smartFilterState.templates[0];
    }

    function smartMatchesFieldValue(value, cfg) {
      const minBound = cfg ? _toNumber(cfg.min) : null;
      const maxBound = cfg ? _toNumber(cfg.max) : null;
      const hasBounds = minBound !== null || maxBound !== null;
      if (!hasBounds) return true;
      if (!cfg) return true;
      const num = _toFixedNumber(value);
      if (num === null) return false;
      if (minBound !== null && num < minBound) return false;
      if (maxBound !== null && num > maxBound) return false;
      return true;
    }

    function _firstValue(...values) {
      for (const value of values) {
        if (value !== undefined && value !== null && value !== '') return value;
      }
      return null;
    }

    function _daysSince(value) {
      if (!value) return null;
      const time = new Date(value).getTime();
      if (Number.isNaN(time)) return null;
      return Math.max(0, Math.floor((Date.now() - time) / 86400000));
    }

    function _daysFieldValue(...values) {
      for (const value of values) {
        if (value === null || value === undefined || value === '') continue;
        if (typeof value === 'number') {
          if (Number.isFinite(value)) return value;
          continue;
        }
        const text = String(value).replace(/\u00a0/g, ' ').trim();
        if (!text || text === '-' || text === '—') continue;
        const dayMatch = text.match(/(\d+)\s*(?:天|days?|дн)/i);
        if (dayMatch) return Number(dayMatch[1]);
        const dateMatch = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
        if (dateMatch) {
          const days = _daysSince(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`);
          if (days !== null) return days;
          continue;
        }
        const num = _toFixedNumber(text);
        if (num !== null) return num;
      }
      return null;
    }

    function _moneyTextToCny(value) {
      if (value === null || value === undefined || value === '') return null;
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      const text = String(value).replace(/\u00a0/g, ' ').trim();
      const cnyMatch = text.replace(/\s+/g, '').match(/[\u00A5\uFFE5]\s*([-+]?\d+(?:[,.]\d+)?)/);
      if (cnyMatch) {
        const cny = Number(cnyMatch[1].replace(',', '.'));
        return Number.isFinite(cny) ? cny : null;
      }
      return null;
    }

    function _currencyFromMoneyText(value) {
      const text = String(value || '').toUpperCase();
      if (!text) return null;
      if (/[\u20BD₽]/.test(text) || /\bRUB\b|\bRUR\b/.test(text) || /РУБ/i.test(text)) return 'RUB';
      if (/[\u00A5\uFFE5¥￥]/.test(text) || /\bCNY\b|\bRMB\b/.test(text) || /人民币|元/.test(text)) return 'CNY';
      return null;
    }

    function _moneyToCny(value, currency) {
      const num = _toFixedNumber(value);
      if (num === null) return null;
      const code = String(currency || _currencyFromMoneyText(value) || '').trim().toUpperCase();
      return (code === 'CNY' || code === 'RMB') ? num : num / _smartFxRate();
    }

    function _percentFieldValue(...values) {
      const value = _firstValue(...values);
      if (value === null || value === undefined || value === '') return null;
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      const text = String(value)
        .replace(/\u00a0/g, ' ')
        .replace(/[−–—]/g, '-')
        .replace(',', '.')
        .trim();
      if (!text || text === '-' || text === '--') return null;
      const match = text.match(/[-+]?\d+(?:\.\d+)?/);
      if (!match) return null;
      const num = Number(match[0]);
      return Number.isFinite(num) ? num : null;
    }

    function _moneyObjectValue(value) {
      if (value && typeof value === 'object') {
        const units = _toFixedNumber(value.units);
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

    function _productIdFromUrl(url) {
      const text = String(url || '');
      const match = text.match(/\/product\/(?:[^/?#]+-)?(\d+)(?:[/?#]|$)/) || text.match(/[?&](?:sku|product_id|productId)=(\d+)/);
      return match ? match[1] : null;
    }

    function _variantMatchFromData(data, info) {
      const variantResult = data?.preFetched?.variant || info?.preFetched?.variant || null;
      const value = variantResult?.status === 'fulfilled' ? variantResult.value : variantResult;
      const items = value?.items || value?.data?.items || [];
      if (!Array.isArray(items) || items.length === 0) return null;
      const sku = _firstValue(
        data?.sku,
        data?.productId,
        info?.sku,
        info?.productId,
        _productIdFromUrl(info?.url),
      );
      return items.find((it) => String(it.variant_id) === String(sku)) || items[0] || null;
    }

    function _marketingPriceCny(data, info) {
      const variantMatch = _variantMatchFromData(data, info);
      const partMarketingPrice = _firstValue(
        variantMatch?.part_marketing_price,
        variantMatch?.partMarketingPrice,
        data?.part_marketing_price,
        data?.partMarketingPrice,
      );
      const partPrice = partMarketingPrice && typeof partMarketingPrice === 'object'
        ? _firstValue(
            partMarketingPrice.price,
            partMarketingPrice.marketing_price,
            partMarketingPrice.marketingPrice,
            partMarketingPrice.value,
          )
        : null;
      const directCny = _toFixedNumber(_firstValue(
        info?.marketingPriceCny,
        info?.marketing_price_cny,
        info?.blackPriceCny,
        info?.black_price_cny,
        data?.marketingPriceCny,
        data?.marketing_price_cny,
        data?.blackPriceCny,
        data?.black_price_cny,
        variantMatch?.marketingPriceCny,
        variantMatch?.marketing_price_cny,
      ));
      const priceValue = _firstValue(
        info?.marketingPrice,
        info?.marketing_price,
        info?.blackPrice,
        info?.black_price,
        data?.marketingPrice,
        data?.marketing_price,
        data?.blackPrice,
        data?.black_price,
        variantMatch?.marketingPrice,
        variantMatch?.marketing_price,
        partPrice,
      );
      const currency = _firstValue(
        info?.marketingPriceCurrency,
        info?.marketing_price_currency,
        info?.blackPriceCurrency,
        info?.black_price_currency,
        data?.marketingPriceCurrency,
        data?.marketing_price_currency,
        data?.blackPriceCurrency,
        data?.black_price_currency,
        variantMatch?.marketingPriceCurrency,
        variantMatch?.marketing_price_currency,
        _moneyObjectCurrency(priceValue),
        _moneyObjectCurrency(partPrice),
        _moneyObjectCurrency(partMarketingPrice),
        data?.priceCurrency,
        info?.priceCurrency,
      );
      const converted = _moneyToCny(_moneyObjectValue(priceValue), currency);
      return converted !== null ? converted : directCny;
    }

    function smartGetDataField(data, key, info) {
      if (!data && !info) return null;
      if (key === 'price') {
        const dataCurrency = _firstValue(
          data?.priceCurrency,
          data?.currency,
          data?.currencyCode,
          data?.currency_code,
          _currencyFromMoneyText(data?.price),
          _currencyFromMoneyText(data?.currentPrice),
        );
        const infoCurrency = _firstValue(
          info?.priceCurrency,
          _currencyFromMoneyText(info?.price),
        );
        return _firstValue(
          data?.priceCny,
          data?.currentPriceCny,
          _moneyToCny(data?.price, dataCurrency),
          _moneyToCny(data?.currentPrice, dataCurrency),
          _moneyToCny(info?.price, infoCurrency),
          _moneyToCny(data?.avgPrice, dataCurrency),
          _moneyTextToCny(data?.price),
          _moneyTextToCny(data?.currentPrice),
        );
      }
      if (key === 'marketingPrice') return _marketingPriceCny(data, info);
      if (key === 'soldCount') return data?.soldCount;
      if (key === 'gmvSum') return _firstValue(
        _moneyToCny(data?.revenue30dRub, 'RUB'),
        _moneyToCny(data?.revenue30d, _currencyFromMoneyText(data?.revenue30d)),
        _moneyToCny(data?.gmvSum, _currencyFromMoneyText(data?.gmvSum)),
        data?.gmvSumCny,
        data?.revenue30dCny,
        _moneyTextToCny(data?.revenue30d)
      );
      if (key === 'views') return _firstValue(data?.views, data?.qtyViewPdp, data?.sessionCount, data?.pdpViews);
      if (key === 'weight') return _firstValue(data?.weight, data?.weightG, data?.weightGrams);
      if (key === 'listedDays') return _daysFieldValue(data?.listedDays, data?.daysOnline, data?.createDate, data?.nullableCreateDate);
      if (key === 'monthlyTurnoverDynamic') return _percentFieldValue(data?.monthlyTurnoverDynamic, data?.turnoverDynamic, data?.salesDynamics);
      if (key === 'adCostRatio') return _firstValue(data?.adCostRatio, data?.adCostPercent, data?.drr);
      if (key === 'promoDays') return _firstValue(data?.promoDays, data?.daysInPromo);
      if (key === 'promoDiscount') return _firstValue(data?.promoDiscount, data?.discount);
      if (key === 'promoConversionRate') return _firstValue(data?.promoConversionRate, data?.promoRevenueShare, data?.promoConvRate);
      if (key === 'paidPromotionDays') return _firstValue(data?.paidPromotionDays, data?.daysWithTrafarets, data?.daysWithAds);
      if (key === 'cardAddToCartRate') return _firstValue(data?.cardAddToCartRate, data?.pdpToCartConversion, data?.convToCartPdp, data?.pdpCartRate);
      if (key === 'searchCatalogViews') return _firstValue(data?.searchCatalogViews, data?.sessionCountSearch, data?.searchViews);
      if (key === 'searchCatalogAddToCartRate') return _firstValue(data?.searchCatalogAddToCartRate, data?.convToCartSearch, data?.searchCartRate);
      if (key === 'displayConversionRate') return _firstValue(data?.displayConversionRate, data?.convViewToOrder);
      if (key === 'returnCancelRate') {
        const direct = _firstValue(data?.returnCancelRate, data?.returnRate);
        if (direct !== null) return direct;
        const redemption = _toFixedNumber(data?.nullableRedemptionRate);
        return redemption === null ? null : 100 - redemption;
      }
      if (key === 'followerCount') return _firstValue(data?.followerCount, data?.followSellCount, data?.heroFollow);
      if (key === 'lowestFollowerPrice') return _firstValue(
        data?.lowestFollowerPriceCny,
        data?.followSellMinPriceCny,
        data?.followMinPriceCny,
        _moneyToCny(data?.lowestFollowerPrice, _firstValue(data?.lowestFollowerPriceCurrency, _currencyFromMoneyText(data?.lowestFollowerPrice))),
        _moneyToCny(data?.followSellMinPrice, _firstValue(data?.followSellMinPriceCurrency, _currencyFromMoneyText(data?.followSellMinPrice))),
        _moneyToCny(data?.followMinPrice, _firstValue(data?.followMinPriceCurrency, _currencyFromMoneyText(data?.followMinPrice))),
        _moneyTextToCny(data?.lowestFollowerPrice),
        _moneyTextToCny(data?.followSellMinPrice),
        _moneyTextToCny(data?.followMinPrice),
      );
      return null;
    }

    function smartMissingFields(data, info) {
      if (!smartFilterState.enabled) return [];
      const template = smartCurrentTemplate();
      const missing = [];
      Object.entries(template.conditions || {}).forEach(([key, cfg]) => {
        const minBound = cfg ? _toNumber(cfg.min) : null;
        const maxBound = cfg ? _toNumber(cfg.max) : null;
        if (minBound === null && maxBound === null) return;
        if (_toFixedNumber(smartGetDataField(data, key, info)) === null) {
          missing.push(key);
        }
      });
      return missing;
    }

  function smartHasBrand(data) {
    const rawBrand = [
      data?.brandName,
      data?.brand,
      data?.brand_name,
      data?.raw?.brandName,
      data?.raw?.brand,
    ].find((value) => value !== undefined && value !== null && String(value).trim() !== '');
    const text = String(rawBrand || '').trim();
    if (!text) return false;
    const normalized = text.toLowerCase();
    return ![
      '-',
      '--',
      '—',
      '无',
      '无品牌',
      '没有品牌',
      '未设置品牌',
      'no brand',
      'no_brand',
      'nobrand',
      'none',
      'null',
      'undefined',
      'без бренда',
      'нет бренда',
    ].includes(normalized);
  }

  function smartMatches(data, info) {
    if (!smartFilterState.enabled) return true;
    const template = smartCurrentTemplate();
    if (template.brandOption && template.brandOption !== 'any') {
      const hasBrand = smartHasBrand(data);
      if (template.brandOption === 'branded' && !hasBrand) return false;
      if (template.brandOption === 'noBrand' && hasBrand) return false;
    }
    if (template.shippingMode && template.shippingMode !== '不限') {
      const shippingMode = String(data?.shippingMode || data?.deliverySchema || data?.deliveryType || data?.salesSchema || (Array.isArray(data?.sources) ? data.sources.join('/') : '') || '').trim().toUpperCase();
      if (!shippingMode || shippingMode !== template.shippingMode) return false;
    }
    return Object.entries(template.conditions || {}).every(([key, cfg]) => {
      const matched = smartMatchesFieldValue(smartGetDataField(data, key, info), cfg);
      return matched;
    });
  }

    function _build() {
      panelEl = document.createElement('div');
      panelEl.className = 'jz-c-panel';
      panelEl.innerHTML = PANEL_HTML;

      bubbleEl = document.createElement('div');
      bubbleEl.className = 'jz-c-bubble';
      bubbleEl.innerHTML = BUBBLE_HTML;
      smartFilterState = _smartLoadState();
      _smartEnsureCurrentTemplate();
      filterMaskEl = document.createElement('div');
      filterMaskEl.innerHTML = FILTER_MODAL_HTML;
      filterMaskEl = filterMaskEl.firstElementChild;

      _restoreInputs();
      _bindEvents();
      _applyCollapsedState();
      _refreshSmartFxRate();
      _refreshFilterSummary();
      _syncFilterToGlobal();
    }

    function _restoreInputs() {
      const savedMax = localStorage.getItem(KW_MAX_KEY) || '200';
      _q('kw-max').value = savedMax;
      const onlySales = localStorage.getItem(SALES_FILTER_KEY) === '1';
      _q('sales-filter').checked = onlySales;
      _refreshFilterSummary();
    }

    function _bindEvents() {
      panelEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'collapse') return _collapse();
        if (act === 'toggle') return _onToggleClick();
        if (act === 'retry-failures') return queue.retryAllFailures();
        if (act === 'export-xlsx' || act === 'export-csv') return _onExportClick();
        if (act === 'clear') return _onClearClick();
        if (act === 'push') return _onPushClick();
        if (act === 'kw-start') return _onKeywordsStart();
        if (act === 'kw-stop') return _onKeywordsStop();
        if (act === 'kw-clear') return _onKeywordsClear();
        if (act === 'filter-open') return _openFilterModal();
        if (act === 'filter-close') return _closeFilterModal();
        if (act === 'filter-save') return _saveFilterForm();
        if (act === 'filter-reset') return _resetFilterForm();
        if (act === 'filter-add') return _addTemplate();
        if (act === 'filter-rename') return _renameTemplate();
        if (act === 'filter-delete') return _deleteTemplate();
      });
      panelEl.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.act === 'auto-scroll-toggle') {
          if (typeof opts.onAutoScrollToggle === 'function') {
            try { opts.onAutoScrollToggle(t.checked); } catch (err) { toast(err.message || '操作失败', 'error'); }
          }
        } else if (t.dataset.act === 'sales-filter') {
          localStorage.setItem(SALES_FILTER_KEY, t.checked ? '1' : '0');
          if (typeof opts.onSalesFilterChange === 'function') {
            try { opts.onSalesFilterChange(t.checked); } catch (err) { toast(err.message || '操作失败', 'error'); }
          }
        }
      });
      bubbleEl.addEventListener('click', () => _expand());

      filterMaskEl?.addEventListener('click', (e) => {
        const t = e.target;
        if (t === filterMaskEl) return _closeFilterModal();
        const actEl = t.closest('[data-act]');
        if (!actEl) return;
        const act = actEl.dataset.act;
        if (act === 'filter-close') return _closeFilterModal();
        if (act === 'filter-save') return _saveFilterForm();
        if (act === 'filter-reset') return _resetFilterForm();
        if (act === 'filter-add') return _addTemplate();
        if (act === 'filter-rename') return _renameTemplate();
        if (act === 'filter-delete') return _deleteTemplate();
      });
      filterMaskEl?.addEventListener('change', (e) => {
        const t = e.target;
        if (!t.matches('[data-field]')) return;
        if (t.dataset.field === 'template') return _onTemplateChange(t.value);
      });
      filterMaskEl?.addEventListener('input', (e) => {
        if (e.target.matches('[data-field]')) {
          // do nothing now; user confirms by Save
        }
      });
    }

    function _getTemplateById(templateId) {
      return smartFilterState.templates.find((t) => t.id === templateId) || smartFilterState.templates[0];
    }

    function _setTemplate(templateId) {
      const next = _getTemplateById(templateId);
      if (!next) return;
      smartFilterState.currentTemplateId = next.id;
      _smartSaveState(smartFilterState);
      _renderFilterTemplateOptions();
      _renderFilterForm();
      _refreshFilterSummary();
      _syncFilterToGlobal();
    }

    function _renderFilterTemplateOptions() {
      const select = _qm('filter-template');
      if (!select) return;
      const prevId = smartFilterState.currentTemplateId;
      select.innerHTML = '';
      smartFilterState.templates.forEach((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name || '未命名模板';
        if (item.id === prevId) option.selected = true;
        select.appendChild(option);
      });
    }

    function _renderFilterRow(fieldKey, cfg) {
      const field = SMART_FILTER_FIELD_KEYS.find((item) => item.key === fieldKey);
      if (!field) return '';
      const minVal = cfg?.min ?? '';
      const maxVal = cfg?.max ?? '';
      const prefix = field.prefix ? `<span class="jz-c-filter-addon">${field.prefix}</span>` : '';
      const minSuffix = field.suffix ? `<span class="jz-c-filter-addon">${field.suffix}</span>` : '';
      const maxSuffix = field.suffix ? `<span class="jz-c-filter-addon">${field.suffix}</span>` : '';
      return `
        <div class="jz-c-filter-row">
          <span>${field.label}</span>
          <label class="jz-c-filter-input">${prefix}<input type="number" step="any" data-field="${field.key}-min" value="${minVal}" placeholder="${field.minPlaceholder || '最小'}" />${minSuffix}</label>
          <em>至</em>
          <label class="jz-c-filter-input">${prefix}<input type="number" step="any" data-field="${field.key}-max" value="${maxVal}" placeholder="${field.maxPlaceholder || '最大'}" />${maxSuffix}</label>
        </div>
      `;
    }

    function _renderBrandRow(template) {
      const value = template?.brandOption || 'any';
      return `
        <div class="jz-c-filter-row is-brand">
          <span>品牌选项：</span>
          ${SMART_FILTER_BRAND_OPTIONS.map((item) => `
            <label>
              <input type="radio" name="jz-c-brand-option" data-field="brandOption" value="${item.value}" ${item.value === value ? 'checked' : ''} />
              ${item.label}
            </label>
          `).join('')}
        </div>
      `;
    }

    function _renderSelectRow(field, template) {
      const value = template?.[field.key] || field.options[0];
      return `
        <div class="jz-c-filter-row is-select">
          <span>${field.label}</span>
          <select data-field="${field.key}">
            ${field.options.map((item) => `<option value="${item}" ${item === value ? 'selected' : ''}>${item}</option>`).join('')}
          </select>
        </div>
      `;
    }

  function _renderFilterForm() {
    const template = smartCurrentTemplate();
    const table = _qm('filter-table');
    if (!table) return;
    const rows = [_renderBrandRow(template)];
    SMART_FILTER_FIELD_KEYS.forEach((f) => {
      rows.push(_renderFilterRow(f.key, template?.conditions?.[f.key]));
      if (f.key === 'displayConversionRate') {
        SMART_FILTER_SELECT_KEYS.forEach((selectField) => rows.push(_renderSelectRow(selectField, template)));
      }
    });
    table.innerHTML = rows.join('');
    const enabled = smartFilterState.enabled;
    const enabledEl = _qmf('enabled');
    if (enabledEl) enabledEl.checked = !!enabled;
  }

  function _collectTemplatePayload() {
    const template = smartCurrentTemplate();
    const conditions = {};
    SMART_FILTER_FIELD_KEYS.forEach((field) => {
      const minInput = _qmf(`${field.key}-min`);
      const maxInput = _qmf(`${field.key}-max`);
        conditions[field.key] = {
          min: _toNumber(minInput?.value),
          max: _toNumber(maxInput?.value),
        };
      });

    return {
      id: template?.id || smartFilterState.currentTemplateId,
      name: template?.name || '未命名模板',
      brandOption: filterMaskEl?.querySelector('[data-field="brandOption"]:checked')?.value || template?.brandOption || 'any',
      shippingMode: _qmf('shippingMode')?.value || template?.shippingMode || '不限',
      conditions,
    };
  }

    function _syncFilterToGlobal() {
      window.JZCollectorFilter = {
        matches: smartMatches,
        getMissingFields: smartMissingFields,
      };
    }

    function _openFilterModal() {
      if (!filterMaskEl) return;
      filterMaskEl.classList.remove('jz-c-hidden');
      _renderFilterTemplateOptions();
      _renderFilterForm();
    }

    function _closeFilterModal() {
      filterMaskEl?.classList.add('jz-c-hidden');
      _refreshFilterSummary();
    }

    function _resetFilterForm() {
      const template = smartCurrentTemplate();
      if (!template) return;
      const baseline = _smartDefaultTemplate();
      template.conditions = baseline.conditions;
      template.brandOption = baseline.brandOption;
      template.shippingMode = baseline.shippingMode;
      _renderFilterForm();
    }

  function _saveFilterForm() {
    const payload = _collectTemplatePayload();
    const nextTemplates = smartFilterState.templates.map((item) => {
      if (item.id !== payload.id) return item;
      return {
        ...item,
        brandOption: payload.brandOption,
        shippingMode: payload.shippingMode,
        conditions: payload.conditions,
      };
    });
    smartFilterState.templates = nextTemplates;
    smartFilterState.enabled = !!_qmf('enabled')?.checked;
    const current = _getTemplateById(payload.id);
    smartFilterState.currentTemplateId = current?.id || smartFilterState.currentTemplateId;
      _smartSaveState(smartFilterState);
      _syncFilterToGlobal();
      _refreshFilterSummary();
      _closeFilterModal();
      _onFilterChange();
      toast('筛选配置已保存', 'success', 1200);
    }

    function _onTemplateChange(nextTemplateId) {
      _setTemplate(nextTemplateId);
      _renderFilterForm();
    }

  function _renderFilterSummary() {
    const summary = _q('filter-summary');
    const template = smartCurrentTemplate();
    if (!summary) return;
    if (!smartFilterState.enabled) {
      summary.textContent = '未开启';
      summary.classList.remove('is-on');
      return;
      }
      const hasRangeLimits = SMART_FILTER_FIELD_KEYS.some((field) => {
        const cfg = template.conditions?.[field.key] || {};
        return _toNumber(cfg.min) !== null || _toNumber(cfg.max) !== null;
      });
      const hasBrandLimit = !!template.brandOption && template.brandOption !== 'any';
      const hasShippingLimit = !!template.shippingMode && template.shippingMode !== '不限';
      if (hasRangeLimits || hasBrandLimit || hasShippingLimit) {
        summary.textContent = `已开启（${template.name}）`;
      } else {
        summary.textContent = '已开启（无筛选条件）';
      }
      summary.classList.add('is-on');
    }

    function _onFilterChange() {
      _renderFilterSummary();
    }

    function _refreshFilterSummary() {
      _renderFilterSummary();
    }

    async function _onToggleClick() {
      const next = !running;
      try {
        if (typeof opts.onToggleRunning === 'function') {
          await opts.onToggleRunning(next);
        }
        running = next;
        _renderAutoScroller();
        _renderStatus();
      } catch (err) {
        toast(err.message || '操作失败', 'error', 2500);
      }
    }

    async function _onPushClick() {
      if (typeof opts.onPushClick !== 'function') {
        toast('未配置推送回调', 'error', 2000);
        return;
      }
      const pushBtn = _q('push-btn');
      pushBtn.disabled = true;
      const originalText = pushBtn.textContent;
      pushBtn.textContent = '推送中...';
      try {
        const res = await opts.onPushClick();
        if (res && res.ok) {
          toast(res.message || '推送成功', 'success', 2500);
        } else {
          toast((res && res.message) || '推送失败', 'error', 3000);
        }
      } catch (err) {
        toast(err.message || '推送失败', 'error', 3000);
      } finally {
        pushBtn.disabled = false;
        pushBtn.textContent = originalText;
        await _refreshBucket();
      }
    }

    async function _onClearClick() {
      if (!confirm('确定清空本地桶吗？已推送到候选池的记录不会受影响。')) return;
      try {
        if (typeof opts.onClearClick === 'function') {
          await opts.onClearClick();
        } else if (db) {
          await db.clearSales();
        }
        toast('本地桶已清空', 'success', 1500);
        await _refreshBucket();
      } catch (err) {
        toast(err.message || '清空失败', 'error', 2500);
      }
    }

    async function _onExportClick() {
      try {
        const res = (typeof opts.onExportClick === 'function')
          ? await opts.onExportClick()
          : (db.exportXlsx ? await db.exportXlsx() : await db.exportCsv());
        if (res && res.cancelled) {
          toast('已取消', 'info', 1200);
        } else if (res && res.ok) {
          if (res.mode === 'fallback') {
            toast(`导出 ${res.total} 条 → ${res.files} 个文件`, 'success', 2500);
          } else {
            toast(`导出 ${res.total} 条`, 'success', 2000);
          }
        }
      } catch (err) {
        toast(err.message || '导出失败', 'error', 2500);
      }
    }

    async function _onKeywordsStart() {
      const ta = _q('kw-textarea');
      const maxInput = _q('kw-max');
      const texts = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
      const max = parseInt(maxInput.value, 10) || 0;
      localStorage.setItem(KW_MAX_KEY, String(max));
      if (texts.length === 0) {
        toast('请先输入关键词（一行一个）', 'error', 2000);
        return;
      }
      try {
        if (typeof opts.onKeywordsStart === 'function') {
          await opts.onKeywordsStart(texts, max);
          ta.value = '';
          toast(`已加入 ${texts.length} 个关键词，开始巡航…`, 'success', 2000);
        }
      } catch (err) {
        toast(err.message || '启动失败', 'error', 2500);
      }
    }

    async function _onKeywordsStop() {
      try {
        if (typeof opts.onKeywordsStop === 'function') await opts.onKeywordsStop();
        toast('关键词巡航已停止', 'info', 1500);
      } catch (err) {
        toast(err.message || '停止失败', 'error', 2500);
      }
    }

    async function _onKeywordsClear() {
      if (!confirm('确定清空所有未完成的关键词吗？')) return;
      try {
        if (typeof opts.onKeywordsClear === 'function') await opts.onKeywordsClear();
        toast('关键词队列已清空', 'success', 1500);
      } catch (err) {
        toast(err.message || '清空失败', 'error', 2500);
      }
    }

    function _collapse() {
      collapsed = true;
      localStorage.setItem(COLLAPSED_KEY, '1');
      _applyCollapsedState();
    }
    function _expand() {
      collapsed = false;
      localStorage.removeItem(COLLAPSED_KEY);
      _applyCollapsedState();
    }
    function _applyCollapsedState() {
      if (!panelEl || !bubbleEl) return;
      panelEl.classList.toggle('jz-c-hidden', collapsed);
      bubbleEl.classList.toggle('jz-c-hidden', !collapsed);
    }

    function _renderStatus() {
      const statusEl = _q('status');
      const statusText = _q('status-text');
      const toggleEl = _q('toggle');
      const toggleText = _q('toggle-text');

      statusEl.classList.toggle('is-running', running && !queue.paused);
      statusEl.classList.toggle('is-paused', running && queue.paused);

      let label = '已停止';
      if (running) {
        if (queue.paused) label = '已暂停';
        else if (autoScrollerAutoPaused) label = '节流暂停翻页…';
        else if (pilotState.mode === 'COLLECTING' && pilotState.currentKeyword) {
          label = `采集 "${pilotState.currentKeyword.text}"`;
        } else if (pilotState.mode === 'NAVIGATING') {
          label = '跳转中…';
        } else {
          label = '采集中…';
        }
      }
      statusText.textContent = label;

      toggleEl.classList.toggle('is-running', running);
      toggleText.textContent = running ? '停止' : '启动';
      toggleEl.querySelector('svg').innerHTML = running
        ? '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>'
        : '<polygon points="6,4 20,12 6,20"/>';
    }

    function _renderQueueStats() {
      const stats = running
        ? queue.stats()
        : { success: 0, running: 0, failed: 0 };
      _q('success').textContent = String(stats.success);
      _q('running').textContent = String(stats.running);
      _q('failed').textContent = String(stats.failed);
      _q('retry-btn').classList.toggle('jz-c-hidden', stats.failed === 0);
    }

    function _renderAutoScroller() {
      const cb = _q('auto-scroll-toggle');
      cb.disabled = !running;
      cb.checked = running && autoScrollerRunning;
    }

    function _renderPilot() {
      const pill = _q('kw-pill');
      const cur = _q('kw-current');
      const curText = _q('kw-current-text');
      const pending = _q('kw-pending-count');
      const done = _q('kw-done-count');
      const startBtn = _q('kw-start');
      const stopBtn = _q('kw-stop');

      const collecting = pilotState.mode === 'COLLECTING' || pilotState.mode === 'NAVIGATING';
      pill.textContent = collecting ? '运行中' : '';
      pill.className = 'jz-c-pill' + (collecting ? ' is-running' : '');

      if (collecting && pilotState.currentKeyword) {
        cur.classList.remove('jz-c-hidden');
        curText.textContent = pilotState.currentKeyword.text;
        pending.textContent = String(pilotState.pendingCount ?? 0);
        done.textContent = String(pilotState.doneCount ?? 0);
      } else {
        cur.classList.add('jz-c-hidden');
      }

      startBtn.disabled = collecting;
      stopBtn.disabled = !collecting;
    }

    async function _refreshBucket() {
      if (!db) return;
      try {
        const total = await db.countSales();
        const pushed = await db.countSales({ status: 'pushed' });
        _q('bucket-count').textContent = String(total);
        const pushedInfo = _q('pushed-info');
        if (pushed > 0) {
          pushedInfo.classList.remove('jz-c-hidden');
          _q('pushed-count').textContent = String(pushed);
        } else {
          pushedInfo.classList.add('jz-c-hidden');
        }
        const unpushed = total - pushed;
        const badge = bubbleEl.querySelector('[data-el="badge"]');
        if (unpushed > 0) {
          badge.textContent = unpushed > 99 ? '99+' : String(unpushed);
          badge.classList.remove('jz-c-hidden');
        } else {
          badge.classList.add('jz-c-hidden');
        }
      } catch (e) { /* swallow */ }
    }

    function toast(message, type = 'info', durationMs = 2000) {
      const el = _q('toast');
      el.textContent = message;
      el.className = 'jz-c-toast' + (type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : '');
      if (toastTimer) clearTimeout(toastTimer);
      if (durationMs > 0) {
        toastTimer = setTimeout(() => { el.textContent = ''; el.className = 'jz-c-toast'; }, durationMs);
      }
    }

    function setRunning(next) {
      running = !!next;
      if (!running) {
        autoScrollerRunning = false;
        autoScrollerAutoPaused = false;
        _renderAutoScroller();
      }
      _renderQueueStats();
      _renderStatus();
    }

    function setAutoScrollerState({ running: r, autoPaused }) {
      autoScrollerRunning = !!r;
      autoScrollerAutoPaused = !!autoPaused;
      _renderAutoScroller();
      _renderStatus();
    }

    function setKeywordPilotState(state) {
      pilotState = state || { mode: 'IDLE', currentKeyword: null };
      _renderPilot();
      _renderStatus();
    }

    function getInitialSalesFilter() {
      return _q('sales-filter').checked;
    }

    function mount(container) {
      if (mounted) return;
      _build();
      const target = container || document.body;
      target.appendChild(panelEl);
      target.appendChild(bubbleEl);
      if (filterMaskEl) {
        (document.body || target).appendChild(filterMaskEl);
      }
      _syncFilterToGlobal();
      mounted = true;
      _renderStatus();
      _renderQueueStats();
      _renderAutoScroller();
      _renderPilot();
      _refreshBucket();
      unsubscribers.push(queue.on('stateChange', () => {
        _renderQueueStats();
        _renderStatus();
      }));
      if (db) {
        unsubscribers.push(db.onChange(() => _refreshBucket()));
      }
    }

    function unmount() {
      if (!mounted) return;
      for (const fn of unsubscribers) try { fn(); } catch {}
      unsubscribers = [];
      panelEl?.remove();
      bubbleEl?.remove();
      filterMaskEl?.remove();
      panelEl = null;
      bubbleEl = null;
      filterMaskEl = null;
      mounted = false;
    }

    return {
      mount, unmount, toast,
      setRunning, setAutoScrollerState, setKeywordPilotState,
      refreshBucket: _refreshBucket,
      getInitialSalesFilter,
    };
  }

  window.JZCollectorPanel = { _v2: true, create };
  window.JZCollectorToast = {
    ...(window.JZCollectorToast || {}),
    localCollectSuccess: showLocalCollectToast,
  };
})();
