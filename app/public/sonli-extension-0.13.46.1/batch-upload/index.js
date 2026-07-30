/**
 * 批量上架页编排：
 *   1. 启动时拉取 stores（GET /auth/ozon-stores）渲染多选 chip + 检测 seller.ozon.ru tab
 *   2. textarea 输入 → JZQuickListParser.parseQuickListText → 渲染预览表
 *   3. 点击「开始批采+上架」：
 *      a. JZSkuCollect.collectBySkus 批采每个有效 SKU（BATCH_SIZE=3 + retry 2 + 2s sleep）
 *      b. 对每个成功 SKU 调 JZV3Payload.buildV3Item 拼装 V3 item
 *      c. 多店铺 Promise.allSettled 调 background followSell action
 *      d. 渲染结果列表
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const sendMessage = (payload) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp);
        }
      });
    });

  // ─── Constants ──────────────────────────────────
  // 海报单价默认 50 极点，启动后由 loadAiQuota() 用 /jidian/pricing 实际值覆盖
  // （超管可在 /admin/platform/jidian-pricing 调整）。批量模式只有 SKU 没图数，
  // 按 8 张/SKU 估算（实际 6-12 常见）
  const POSTER_COST_PER_IMAGE_DEFAULT = 50;
  const ESTIMATE_IMAGES_PER_SKU = 8;
  const RECHARGE_PATH = "/ozon/settings/jidian";
  const MEMBERSHIP_PATH = "/ozon/settings/membership";
  const BATCH_UPLOAD_LISTING_CFG_KEY = "batch-upload-listing-config-v1";
  const DEFAULT_BRAND_DISPLAY_NAME = /__BRAND/.test("sonli")
    ? "平台"
    : "sonli";

  // ─── State ──────────────────────────────────────
  const state = {
    selectedStoreIds: [], // 由 JZStorePicker.onChange 维护
    storeLabels: new Map(), // id → label，用于结果面板展示
    rows: [], // QuickListRow[]
    submitting: false,
    abortCtrl: null,
    picker: null,
    aiBalance: null, // 极点余额，loadAiQuota 拉到后填入；失败保持 null
    posterPricePerImage: POSTER_COST_PER_IMAGE_DEFAULT, // AI 海报单价，loadAiQuota 用后端动态值覆盖
    pointLabel: "极点", // 分销商可定制别名，loadAiQuota 拿到后覆盖
    aiRewriteUserTouched: false, // 用户是否手动动过 AI 重写开关；true 后不再自动设默认
    // 每店独立的仓库选择（Ozon 仓库 ID 是 seller-scoped 的,跨店不通用）
    warehousesByStore: new Map(), // sid(string) → { loading, options:[{value,label}], error }
    selectedWarehouseByStore: new Map(), // sid(string) → warehouseId
  };

  // 各店物流仓库选择的跨会话记忆。state.selectedWarehouseByStore 是内存 Map、
  // 关页即丢;这里持久化到 chrome.storage,下次打开各店自动回填上次所选仓库。
  // **与跟卖面板(ozon-product.js)共用同一 key** —— 同一店铺的仓库偏好两处通用。
  let _persistedWh = {};
  try {
    chrome.storage.local.get(["followSellWarehouseByStore"], (r) => {
      const m = r && r.followSellWarehouseByStore;
      if (m && typeof m === "object") _persistedWh = m;
    });
  } catch (e) { /* storage 不可用 → 不记忆 */ }

  function persistWh(storeId, warehouseId) {
    const sid = String(storeId || "");
    const wid = String(warehouseId || "");
    if (!sid || !wid || _persistedWh[sid] === wid) return; // 无变化不写
    _persistedWh[sid] = wid;
    try {
      chrome.storage.local.set({ followSellWarehouseByStore: _persistedWh });
    } catch (e) { /* ignore */ }
  }

  // ─── Auth / boot ───────────────────────────────
  function readBatchListingConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([BATCH_UPLOAD_LISTING_CFG_KEY], (r) => {
          const cfg = r && r[BATCH_UPLOAD_LISTING_CFG_KEY];
          resolve(cfg && typeof cfg === "object" ? cfg : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function writeBatchListingConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return;
    try {
      chrome.storage.local.set({ [BATCH_UPLOAD_LISTING_CFG_KEY]: cfg });
    } catch {}
  }

  function captureBatchListingConfig() {
    const cfg = readCfg();
    const selectedWarehouseByStore = {};
    state.selectedWarehouseByStore.forEach((warehouseId, storeId) => {
      if (storeId && warehouseId) selectedWarehouseByStore[String(storeId)] = String(warehouseId);
    });
    return {
      version: 1,
      savedAt: Date.now(),
      selectedStoreIds: state.selectedStoreIds.slice(),
      brand: cfg.brand,
      imageOrder: cfg.imageOrder,
      currencyCode: cfg.currencyCode,
      currency: cfg.currencyCode,
      // 不缓存合并型号名(attr 9048):复用上次批次的型号名会被 Ozon 错误并卡;只记「是否合并」。
      mergeEnabled: !!$("cfg-merge-card")?.checked || !!cfg.mergeModel,
      applyPoster: cfg.applyPoster,
      posterPrimaryOnly: cfg.posterPrimaryOnly,
      applyAiRewrite: cfg.applyAiRewrite,
      captureVideo: cfg.captureVideo,
      defaultStock: cfg.defaultStock,
      oldPriceStrategy: { type: "multiplier", value: 1.25 },
      selectedWarehouseByStore,
      warehouseIdByStore: selectedWarehouseByStore,
    };
  }

  function applyBatchListingConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return;
    const setSelect = (id, value) => {
      const el = $(id);
      if (!el || typeof value !== "string") return;
      if ([...el.options].some((o) => o.value === value)) el.value = value;
    };
    setSelect("cfg-brand", cfg.brand);
    setSelect("cfg-image-order", cfg.imageOrder);
    setSelect("cfg-currency", cfg.currencyCode || cfg.currency);
    const setChecked = (id, value) => {
      if (typeof value !== "boolean") return;
      const el = $(id);
      if (el && !el.disabled) el.checked = value;
    };
    const mergeField = $("cfg-merge-model");
    const mergeToggle = $("cfg-merge-card");
    // 只恢复「是否合并」,不恢复型号名:勾上则生成全新型号名,避免不同批次复用同一 9048 误并卡。
    if (mergeToggle && typeof cfg.mergeEnabled === "boolean") {
      mergeToggle.checked = cfg.mergeEnabled;
      if (cfg.mergeEnabled && mergeField && !mergeField.value.trim()) {
        mergeField.value = "JZ-" + Date.now().toString(36).toUpperCase();
      }
    }
    setChecked("cfg-ai-poster", cfg.applyPoster);
    setChecked("cfg-poster-primary-only", cfg.posterPrimaryOnly);
    setChecked("cfg-ai-rewrite", cfg.applyAiRewrite);
    setChecked("cfg-capture-video", cfg.captureVideo);
    if (typeof cfg.applyAiRewrite === "boolean") state.aiRewriteUserTouched = true;
    if (Number.isFinite(Number(cfg.defaultStock))) {
      const stockInput = $("cfg-default-stock");
      if (stockInput) stockInput.value = String(Number(cfg.defaultStock));
    }
    const warehouseMap = cfg.selectedWarehouseByStore || cfg.warehouseIdByStore || {};
    if (warehouseMap && typeof warehouseMap === "object") {
      Object.entries(warehouseMap).forEach(([storeId, warehouseId]) => {
        if (storeId && warehouseId) state.selectedWarehouseByStore.set(String(storeId), String(warehouseId));
      });
      renderWarehouseByStore();
    }
    updateAiEnabledCount();
    updatePosterEstimate();
  }

  function saveBatchListingConfigAfterSuccess(settled) {
    const hasSuccess = Array.isArray(settled) && settled.some((s) => s.status === "fulfilled");
    if (!hasSuccess) return;
    writeBatchListingConfig(captureBatchListingConfig());
  }

  async function fetchAuth() {
    const response = await sendMessage({ action: "getAuth" });
    return response?.data || response || {};
  }

  async function checkAuth() {
    const auth = await fetchAuth();
    if (!auth?.token) {
      const brandDisplayName = globalThis.__JZ_BRAND__?.displayName || DEFAULT_BRAND_DISPLAY_NAME;
      showAuthNotice("error", `未登录${brandDisplayName}。请先在扩展弹窗里登录。`);
      return false;
    }
    return true;
  }

  async function checkSellerTab() {
    try {
      const tabs = await chrome.tabs.query({ url: "https://seller.ozon.ru/*" });
      if (!tabs.length) {
        showAuthNotice(
          "error",
          "未检测到 seller.ozon.ru 标签页。请先打开并登录 seller.ozon.ru，再回来点开始。"
        );
        return false;
      }
      hideAuthNotice();
      return true;
    } catch (e) {
      showAuthNotice("error", "检测 seller.ozon.ru tab 失败: " + e.message);
      return false;
    }
  }

  function showAuthNotice(level, text) {
    const notice = $("auth-notice");
    notice.style.display = "";
    notice.className = "notice notice-" + level;
    $("auth-notice-text").textContent = text;
  }
  function hideAuthNotice() {
    $("auth-notice").style.display = "none";
  }

  // 上品配额预判:复刻后端 membership-check.service.ts 的 LISTING_CREATE 门控。
  // 提交前本地判一遍,达上限直接拦截并引导升级,不再让整批白跑到后端付费墙。
  // count = 单店上品数;多店扇出时后端按单店逐次 assert,这里用首店口径预判。
  function evaluateListingQuota(summary, itemCount) {
    if (!summary) return { blocked: false };
    const caps = summary.caps || {};
    const usage = summary.usage || {};
    const cumLimit = caps.cumulativeListingLimit || 0;
    const dailyLimit = caps.dailyListingLimit || 0;
    const cum = usage.listingCumulative || 0;
    const today = usage.listingToday || 0;
    const count = Math.max(1, itemCount || 1);
    if (summary.canUse && summary.canUse.LISTING_CREATE === false && cumLimit === 0 && dailyLimit === 0) {
      return { blocked: true, message: "免费会员暂不支持上品，请升级会员解锁该功能" };
    }
    if (cumLimit > 0 && cum + count > cumLimit) {
      return { blocked: true, message: `免费版终身累计上品 ${cumLimit} 个已达上限，升级会员解锁每日配额` };
    }
    if (dailyLimit > 0 && today + count > dailyLimit) {
      return { blocked: true, message: `今日上品 ${dailyLimit} 个已达上限，请明日再试或升级更高等级` };
    }
    return { blocked: false };
  }

  // 达上限提示:沿用 auth-notice 条 + 内联「升级会员」链接(同 RECHARGE_PATH 充值链接套路)
  function showUpgradeNotice(message) {
    const notice = $("auth-notice");
    notice.style.display = "";
    notice.className = "notice notice-warn";
    $("auth-notice-text").textContent = message + " ";
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = "升级会员 →";
    link.style.fontWeight = "600";
    link.onclick = (e) => {
      e.preventDefault();
      sendMessage({ action: "openFrontend", path: MEMBERSHIP_PATH });
    };
    $("auth-notice-text").appendChild(link);
  }

  async function loadStores() {
    const savedCfg = await readBatchListingConfig();
    // 同时拉店铺列表用于结果面板的 label 映射
    const storesResp = await sendMessage({ action: "getStores" });
    if (storesResp?.ok) {
      const list = storesResp.data?.data || storesResp.data || [];
      state.storeLabels.clear();
      list.forEach((s) => {
        const id = String(s.id || s.storeId || "");
        const label =
          s.label || s.companyName || s.legalName || `店铺 ${id}`;
        state.storeLabels.set(id, label);
      });
    }

    try {
      const picker = await window.JZStorePicker.mount($("store-wrapper"), {
        defaultSelectedIds: Array.isArray(savedCfg?.selectedStoreIds)
          ? savedCfg.selectedStoreIds.map(String)
          : undefined,
        onChange: (ids) => {
          state.selectedStoreIds = ids;
          // 为新选中的店铺懒加载仓库;已加载过的不重复请求
          ids.forEach((sid) => {
            const key = String(sid);
            if (!state.warehousesByStore.has(key)) {
              fetchWarehousesForStore(key);
            }
          });
          renderWarehouseByStore();
          updateSubmitState();
          updatePosterEstimate();
        },
      });
      state.picker = picker;
      // 同步初始选择（mount 内部已触发一次 onChange，但保险起见再 sync 一遍）
      state.selectedStoreIds = picker.getSelectedIds();
      // 对初始选中的店铺也跑一次懒加载
      state.selectedStoreIds.forEach((sid) => {
        const key = String(sid);
        if (!state.warehousesByStore.has(key)) {
          fetchWarehousesForStore(key);
        }
      });
      renderWarehouseByStore();
      applyBatchListingConfig(savedCfg);
    } catch (e) {
      console.error("[batch-upload] mount store picker failed:", e);
    }
  }

  // ─── Per-store warehouse: fetch + render ───────
  async function fetchWarehousesForStore(sid) {
    if (!sid) return;
    const key = String(sid);
    state.warehousesByStore.set(key, { loading: true, options: [], error: null });
    renderWarehouseByStore();
    try {
      const resp = await sendMessage({ action: "getWarehouses", storeId: sid });
      if (!resp || !resp.ok) {
        const msg = resp?.error || resp?.message || "加载失败";
        state.warehousesByStore.set(key, { loading: false, options: [], error: msg });
        renderWarehouseByStore();
        return;
      }
      const inner = resp.data ?? resp;
      const list = Array.isArray(inner) ? inner
        : Array.isArray(inner?.result) ? inner.result
        : Array.isArray(inner?.warehouses) ? inner.warehouses
        : [];
      const options = list
        .map((w) => ({
          value: String(w.warehouse_id ?? w.warehouseId ?? w.id ?? ""),
          label: w.name || `仓库 ${w.warehouse_id ?? w.id ?? ""}`,
        }))
        .filter((o) => o.value);
      state.warehousesByStore.set(key, { loading: false, options, error: null });
      // 单仓库自动选中,省一次点击
      if (options.length === 1 && !state.selectedWarehouseByStore.has(key)) {
        state.selectedWarehouseByStore.set(key, options[0].value);
      }
      renderWarehouseByStore();
    } catch (e) {
      state.warehousesByStore.set(key, {
        loading: false,
        options: [],
        error: e?.message || "加载失败",
      });
      renderWarehouseByStore();
    }
  }

  function renderWarehouseByStore() {
    const root = $("wh-by-store-list");
    if (!root) return;
    if (state.selectedStoreIds.length === 0) {
      root.innerHTML = '<div class="wh-by-store-empty">请先选择目标店铺</div>';
      return;
    }
    const html = state.selectedStoreIds
      .map((sid) => {
        const key = String(sid);
        const label = state.storeLabels.get(key) || `店铺 ${sid}`;
        const wh = state.warehousesByStore.get(key);
        const selected = state.selectedWarehouseByStore.get(key) || (_persistedWh[key] ? String(_persistedWh[key]) : "");
        const loading = !wh || wh.loading;
        const isError = !!(wh && wh.error);
        const isEmpty = wh && !wh.loading && !wh.error && wh.options.length === 0;
        const cls = `wh-by-store-item${isError ? " is-error" : isEmpty ? " is-empty" : ""}`;
        let placeholder = "加载中...";
        if (isError) placeholder = "加载失败";
        else if (isEmpty) placeholder = "无可用仓库";
        else if (!loading) placeholder = "请选择仓库";
        const opts = wh?.options || [];
        const optsHtml = opts
          .map(
            (o) =>
              `<option value="${escapeHtml(o.value)}"${o.value === selected ? " selected" : ""}>${escapeHtml(o.label)}</option>`
          )
          .join("");
        const placeholderOpt =
          loading || isError || isEmpty || !selected
            ? `<option value="">${escapeHtml(placeholder)}</option>`
            : "";
        const retryBtn = isError || isEmpty
          ? `<button type="button" class="wh-retry-btn" data-action="retry-wh" title="重新加载">⟳</button>`
          : "";
        const errLine = isError
          ? `<div class="wh-store-error">${escapeHtml(wh.error)}</div>`
          : isEmpty
          ? `<div class="wh-store-error">该店铺暂无可用仓库</div>`
          : "";
        return `
          <div class="${cls}" data-sid="${escapeHtml(key)}">
            <div class="wh-store-name-row">
              <div class="wh-store-name" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
              ${retryBtn}
            </div>
            <select class="fld is-sm" data-action="select-wh" data-sid="${escapeHtml(key)}" ${loading || isError || isEmpty ? "disabled" : ""}>
              ${placeholderOpt}${optsHtml}
            </select>
            ${errLine}
          </div>
        `;
      })
      .join("");
    root.innerHTML = html;
    root.querySelectorAll('[data-action="select-wh"]').forEach((sel) => {
      // 渲染后用浏览器实际选中值(记忆命中→记忆值,否则首项)回填 map + 持久化,
      // 让提交/校验也看得到上次记忆,不必再点一次(guard 防重复写)。
      const sid0 = sel.dataset.sid;
      if (sid0 && sel.value && !state.selectedWarehouseByStore.has(sid0)) {
        state.selectedWarehouseByStore.set(sid0, sel.value);
        persistWh(sid0, sel.value);
      }
      sel.addEventListener("change", (e) => {
        const k = e.target.dataset.sid;
        state.selectedWarehouseByStore.set(k, e.target.value);
        persistWh(k, e.target.value);
      });
    });
    root.querySelectorAll('[data-action="retry-wh"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.closest("[data-sid]")?.dataset?.sid;
        if (k) fetchWarehousesForStore(k);
      });
    });
  }

  // ─── Parse / preview ───────────────────────────
  function onTextareaInput() {
    const text = $("textarea").value;
    const rows = window.JZQuickListParser.parseQuickListText(text);
    state.rows = rows;
    renderPreview();
    updateSubmitState();
    updatePosterEstimate();
  }

  function renderPreview() {
    const tbody = $("preview-tbody");
    tbody.innerHTML = "";
    const card = $("preview-card");
    if (state.rows.length === 0) {
      card.style.display = "none";
      $("parse-stat").textContent = "0 行";
      return;
    }
    card.style.display = "";

    let valid = 0;
    let invalid = 0;
    for (const r of state.rows) {
      if (r.valid) valid++;
      else invalid++;

      const tr = document.createElement("tr");
      if (!r.valid) tr.className = "row-bad";
      const dim = r.lengthMm != null
        ? `${r.lengthMm}×${r.widthMm ?? "?"}×${r.heightMm ?? "?"}`
        : "—";
      const priceCell = r.price != null
        ? r.minPrice != null
          ? `${r.price.toFixed(2)} <span class="price-min">~${r.minPrice.toFixed(2)}</span>`
          : r.price.toFixed(2)
        : "—";
      tr.innerHTML = `
        <td class="c-idx">${r.index}</td>
        <td class="c-sku">${escapeHtml(r.sku || "—")}</td>
        <td class="c-price">${priceCell}</td>
        <td class="c-offer">${escapeHtml(r.offerId || "—")}</td>
        <td class="c-w">${r.weightG != null ? r.weightG : "—"}</td>
        <td class="c-dim">${dim}</td>
        <td class="c-fmt">${
          r.formatHint
            ? `<span class="fmt-tag">F${r.formatHint}</span>`
            : ""
        }</td>
        <td class="c-msg">${escapeHtml(r.reason || "")}</td>
      `;
      tbody.appendChild(tr);
    }

    const total = state.rows.length;
    $("parse-stat").textContent = `${total} 行 · ${valid} 有效 · ${invalid} 错误`;
    $("preview-stat").textContent = `${valid} / ${total} 行可上架`;
  }

  function updateSubmitState() {
    const validCount = state.rows.filter((r) => r.valid).length;
    const storeCount = state.selectedStoreIds.length;
    const btn = $("btn-submit");
    btn.disabled = state.submitting || validCount === 0 || storeCount === 0;
    if (validCount === 0) btn.textContent = "开始批采 + 上架";
    else
      btn.textContent = `开始批采 + 上架（${validCount} 条 × ${storeCount} 店铺）`;
  }

  // ─── Submit ────────────────────────────────────
  async function onSubmit() {
    if (state.submitting) return;

    const validRows = state.rows.filter((r) => r.valid);
    if (validRows.length === 0) {
      showAuthNotice("warn", "没有可上架的有效行");
      return;
    }
    if (state.selectedStoreIds.length === 0) {
      showAuthNotice("warn", "请至少选择一个目标店铺");
      return;
    }

    const cfg = readCfg();
    // 默认库存>0 时,所有选中店铺都必须选了仓库(否则该店无法挂库存,默认行为不一致)
    const defaultStockNow = parseInt($("cfg-default-stock")?.value || "0", 10) || 0;
    if (defaultStockNow > 0) {
      const missing = state.selectedStoreIds.filter(
        (sid) => !state.selectedWarehouseByStore.get(String(sid))
      );
      if (missing.length > 0) {
        const names = missing
          .map((sid) => state.storeLabels.get(String(sid)) || `店铺 ${sid}`)
          .join("、");
        showAuthNotice(
          "warn",
          `店铺「${names}」未选仓库,无法挂库存。请到右侧「物流仓库」逐店选择,或将默认库存改为 0。`
        );
        return;
      }
    }

    // 会员上品配额预校验:达上限直接拦截 + 引导升级,不打后端(不消耗限流槽/不留 FAILED 记录)。
    // 拉取失败(网络/未登录)时静默放行,让后端兜底,避免误拦。
    try {
      const memRes = await sendMessage({ action: "getMembershipSummary" });
      if (memRes && memRes.ok && memRes.data) {
        const quota = evaluateListingQuota(memRes.data, validRows.length);
        if (quota.blocked) {
          showUpgradeNotice(quota.message);
          return;
        }
      }
    } catch (_) {
      /* 静默放行 */
    }

    if (!(await checkSellerTab())) return;

    state.submitting = true;
    state.abortCtrl = new AbortController();
    $("btn-submit").style.display = "none";
    $("btn-cancel").style.display = "";
    $("btn-clear").disabled = true;
    $("textarea").disabled = true;
    updateSubmitState();

    $("progress-card").style.display = "";
    $("result-card").style.display = "none";
    $("result-list").innerHTML = "";
    $("progress-log").innerHTML = "";

    try {
      await runSubmit(validRows);
    } catch (err) {
      // 兜底:任何 uncaught throw 都 reset state, 否则按钮一直 disabled
      // (state.submitting=true 残留 → 用户感受到"点了没反应")
      console.error("[batch-upload] onSubmit failed:", err);
      const log = $("progress-log");
      if (log) {
        const line = document.createElement("div");
        line.className = "log-err";
        line.textContent = `✗ 流程出错: ${err?.message || err}`;
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
      }
      showAuthNotice("error", `流程出错: ${err?.message || err}`);
    } finally {
      onSubmitDone();
    }
  }

  async function runSubmit(validRows) {
    const log = $("progress-log");
    const appendLog = (text, cls) => {
      const line = document.createElement("div");
      if (cls) line.className = cls;
      line.textContent = text;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    };

    // Phase 1: 批采（gate check 软检测 — 失败不阻断，只警告）
    setProgress("collect", 0, validRows.length);
    const skus = validRows.map((r) => r.sku);
    const firstSku = skus[0];
    appendLog(`正在预检通讯 (gate=${firstSku})...`);

    let gate = await window.JZSkuCollect.gateCheck(firstSku);
    // 仅当 gate 报"基础设施性"错误时才尝试 cookie resync + 警告
    // 单个 SKU 没数据 / 反爬偶发 不算，让 collectBySkus 整体跑完按结果统计
    const fundamentalErrors = ["AUTH_REQUIRED", "NO_SELLER_TAB", "PERMISSION_DENIED", "NO_OZON_TAB"];
    if (!gate.ok && fundamentalErrors.includes(gate.errorCode)) {
      appendLog("基础通讯失败，尝试刷新登录状态...", "log-err");
      try {
        await sendMessage({ action: "syncSellerCookies" });
        appendLog("Cookie 已刷新，重试...");
        gate = await window.JZSkuCollect.gateCheck(firstSku);
      } catch {}
      if (!gate.ok && fundamentalErrors.includes(gate.errorCode)) {
        // 真正的环境问题（没登录 / 没开 Ozon tab）→ 提示但不直接 abort，
        // 让 collectBySkus 跑一遍：万一是 search-variant-model 没登录但
        // 公开页能抓（或反过来），仍能拿到部分数据
        appendLog(
          `⚠ ${humanizeError(gate.message)} — 仍尝试继续，可能有数据缺失`,
          "log-err"
        );
        showAuthNotice("warn", humanizeError(gate.message));
      }
    }
    if (gate.ok && gate.distilled) {
      const sources = [];
      if (gate.hasPageProduct) sources.push("公开页");
      if (gate.hasSourceVariant) sources.push("已上架同款");
      appendLog(
        `  ✓ ${firstSku} (gate · ${sources.join(" + ") || "无源"})`,
        "log-ok"
      );
    }
    if (state.abortCtrl?.signal.aborted) {
      appendLog("已取消", "log-err");
      onSubmitDone();
      return;
    }

    // Phase 1b: 批采全部 SKU（gate 拿到的结果通过 prefetched 复用）
    appendLog(`开始批采 ${skus.length} 个 SKU（已预取 ${gate.ok && gate.distilled ? 1 : 0}）...`);
    const prefetched = new Map();
    if (gate.ok && gate.distilled) prefetched.set(firstSku, gate.distilled);

    // 转存视频开关在此处先读(cfg 在 Phase 2 才整体 readCfg)。开启则采集后逐 SKU 抓竞品
    // 视频转存为自有 Ozon 视频,写进 distilled.videoUrl → buildV3Item 下发 item.videoUrl。
    const captureVideo = $("cfg-capture-video")?.checked || false;
    const collectResult = await window.JZSkuCollect.collectBySkus(skus, {
      signal: state.abortCtrl.signal,
      prefetched,
      captureVideo,
      onProgress: (done, total, sku, ok, error) => {
        setProgress("collect", done, total);
        if (ok && sku !== firstSku) appendLog(`  ✓ ${sku}`, "log-ok");
        else if (!ok) appendLog(`  ✗ ${sku}: ${humanizeError(error)}`, "log-err");
      },
      onVideoProgress: (done, total, sku, ok) => {
        setProgress("collect", done, total);
        if (ok) appendLog(`  🎬 ${sku} 视频已转存`, "log-ok");
        else appendLog(`  · ${sku} 无视频`);
      },
    });
    if (captureVideo) appendLog("转存竞品视频中（逐 SKU，较慢）…");

    if (state.abortCtrl?.signal.aborted) {
      appendLog("已取消", "log-err");
      onSubmitDone();
      return;
    }

    appendLog(
      `批采完成: ${collectResult.sourceMap.size} 成功 / ${collectResult.failed.length} 失败`
    );

    // 反爬熔断:collectBySkus 命中 seller portal 403 会中止剩余批次并进入冷却。
    // 已采到的部分仍可正常提交(上架走后端官方 API,不碰门户),但要明确告知用户原因与冷却时间。
    if (collectResult.antibotTripped) {
      const mins = Math.ceil((collectResult.cooldownMs || 0) / 60000);
      appendLog(
        `⚠ seller.ozon.ru 触发反爬保护，已中止剩余采集并冷却约 ${mins} 分钟。已采到的 SKU 仍会继续提交；剩余 SKU 请稍后再采，或换网络 / 减小单次批量。`,
        "log-err"
      );
      showAuthNotice(
        "warn",
        `seller.ozon.ru 触发反爬保护，采集已暂停约 ${mins} 分钟。这是短时请求过密所致，降低批量或稍后再试可避免。`
      );
    }

    if (collectResult.sourceMap.size === 0) {
      appendLog("无 SKU 采集成功，停止提交", "log-err");
      onSubmitDone();
      return;
    }

    // Phase 2: 拼 V3 items
    const cfg = readCfg();
    const batchSalt = window.JZQuickListParser.genSalt();
    // 型号名称(attr 9048):跟「一键跟卖」面板的 merge-model 字段保持一致 —— 默认留空,
    // 用户填了才整批共享同一型号名 → Ozon 合并为同一张卡;留空则不下发 scraped_model_name,
    // 后端按各变体兜底(各自独立成卡),避免把不相关的商品错误合并到一张卡。
    // batchSalt 仍用于 offer_id 唯一性,与型号合并解耦。
    const batchModelName = cfg.mergeModel || "";
    const items = [];
    const itemsFailed = [];
    for (const r of validRows) {
      const distilled = collectResult.sourceMap.get(r.sku);
      // 客户端 shuffle 图片（按 imageOrder 设定）
      const reorderedDistilled = distilled
        ? Object.assign({}, distilled, {
            images: applyImageOrder(distilled.images, cfg.imageOrder),
          })
        : null;
      const built = window.JZV3Payload.buildV3Item(r, reorderedDistilled, {
        offerIdPrefix: cfg.offerIdPrefix,
        batchSalt,
        currencyCode: cfg.currencyCode,
        vat: cfg.vat,
        brand: cfg.brand,
        modelName: batchModelName,
      });
      if (built.ok) {
        items.push(built.item);
      } else {
        itemsFailed.push({ sku: r.sku, error: built.error });
      }
    }

    if (itemsFailed.length > 0) {
      for (const f of itemsFailed) {
        appendLog(`  ! ${f.sku} 跳过: ${f.error}`, "log-err");
      }
    }

    if (items.length === 0) {
      appendLog("没有可提交的 item，停止", "log-err");
      onSubmitDone();
      return;
    }

    // 标题质量预检（免费、纯规则）。源标题原样复制时易被 Ozon 判「无意义/语法错误」。
    // 开了 AI 重写时 backend 会重写标题、本检查无意义，只在没开时提醒，让用户改标题或开 AI 重写。
    if (!cfg.applyAiRewrite && window.JZTitleQuality) {
      const flagged = [];
      for (const it of items) {
        const q = window.JZTitleQuality.checkTitleQuality(it.name);
        if (!q.ok) flagged.push({ sku: it.scraped_sku || it.offer_id, issue: q.issues[0]?.label || "标题质量存疑" });
      }
      if (flagged.length > 0) {
        appendLog(
          `  ⚠ ${flagged.length}/${items.length} 条标题质量存疑（源标题可能被 Ozon 判为无意义/语法错误）。建议开启「AI 重写」或手动改标题后重试。`,
          "log-err",
        );
        for (const f of flagged.slice(0, 5)) {
          appendLog(`      · ${f.sku}: ${f.issue}`, "log-err");
        }
        if (flagged.length > 5) {
          appendLog(`      · 其余 ${flagged.length - 5} 条略`, "log-err");
        }
      }
    }

    appendLog(
      `开始向 ${state.selectedStoreIds.length} 个店铺提交 ${items.length} 条...`
    );

    // Phase 3: 多店铺 Promise.allSettled 提交
    const storeIds = state.selectedStoreIds.slice();
    setProgress("submit", 0, storeIds.length);
    let submitDone = 0;

    // 埋点（当天去重在 sw 层做,失败静默）
    sendMessage({ action: "usageTrack", featureKey: "batch-upload:submit" }).catch(() => {});

    const settled = await Promise.allSettled(
      storeIds.map(async (sid) => {
        const label = state.storeLabels.get(String(sid)) || `店铺 ${sid}`;
        try {
          // 物流仓库 & 库存：每店独立从 state.selectedWarehouseByStore 取;
          // defaultStock=0 或 该店未选仓库 → 不挂库存(submit 前已校验)
          let stocks;
          if (cfg.defaultStock > 0) {
            const warehouseId = state.selectedWarehouseByStore.get(String(sid)) || "";
            if (warehouseId) {
              stocks = items.map((it) => ({
                offer_id: it.offer_id,
                stock: cfg.defaultStock,
                warehouse_id: warehouseId,
              }));
            }
          }

          const resp = await sendMessage({
            action: "followSell",
            storeId: sid,
            items,
            ...(stocks && stocks.length > 0 ? { stocks } : {}),
            applyPoster: cfg.applyPoster,
            ...(cfg.applyPoster && cfg.posterPrimaryOnly ? { posterPrimaryOnly: true } : {}),
            applyAiRewrite: cfg.applyAiRewrite,
            // 严格类目匹配：sv 缺失时 backend 直接跳过该 item，不退化到面包屑
            // 模糊匹配（避免错配 type 引发 Ozon "商品照片与其类型不符" 报错）。
            strictTypeMatch: true,
          });
          submitDone++;
          setProgress("submit", submitDone, storeIds.length);
          if (!resp?.ok) {
            const errMsg = resp?.error || resp?.message || "提交失败";
            // 提交响应超时/网络错 ≠ 一定没上架:后端可能已建任务并在处理,甚至已拿到 Ozon
            // 真实结果(如「每日新建配额已满」)。先核对该店任务列表,按真实状态汇报,避免误报
            // 「网络异常」导致客户重复提交(白撞配额 / 建重复任务)。
            if (/超时|timeout|Failed to fetch|NetworkError|网络/i.test(String(errMsg))) {
              const task = await reconcileTimedOutSubmit(sid, items.length);
              if (task) {
                const st = String(task.status || "").toUpperCase();
                const tid = task.taskId || task.localTaskId || task.id || "";
                if (st === "FAILED") {
                  const reason = task.errorMessage || "请见上架记录";
                  appendLog(`  ✗ ${label}: 任务已创建但失败 — ${reason}`, "log-err");
                  throw new Error(reason);
                }
                // QUEUED / IMPORTING / CHECKING / SUCCESS / PARTIAL_SUCCESS → 已提交,勿重复提交
                appendLog(
                  `  ✓ ${label}: 提交响应超时,但任务已创建(状态 ${st || "处理中"}),已避免重复提交 — 去「上架记录」看结果`,
                  "log-ok",
                );
                return {
                  storeId: sid,
                  taskId: tid,
                  warnings: [`提交响应超时,但任务已创建(${st || "处理中"});请勿重复提交,去「上架记录」查看结果`],
                  raw: task,
                };
              }
              // 没在任务列表找到 → 确实没送达,可安全重试
              appendLog(`  ✗ ${label}: ${humanizeError(errMsg)}(上架记录无对应任务,可重试)`, "log-err");
              throw new Error(errMsg);
            }
            appendLog(`  ✗ ${label}: ${humanizeError(errMsg)}`, "log-err");
            throw new Error(errMsg);
          }
          const taskId =
            resp.data?.result?.task_id || resp.data?.task_id;
          // 严格模式：所有 SKU 都因 sv 不可用被跳过 → backend 返回 task_id=0
          // 这不是"未收到任务ID"的失败，而是提交本身就没东西可发
          const allSkipped = resp.data?.result?.strictSkipped || [];
          if (!taskId && allSkipped.length > 0) {
            appendLog(
              `  ✗ ${label}: 全部 ${allSkipped.length} 个 SKU 因无源数据被跳过`,
              "log-err",
            );
            for (const s of allSkipped.slice(0, 5)) {
              appendLog(
                `      · ${s.sku || s.offer_id}: ${s.reason}`,
                "log-err",
              );
            }
            if (allSkipped.length > 5) {
              appendLog(`      · 其余 ${allSkipped.length - 5} 个略`, "log-err");
            }
            throw new Error("所有 SKU 因无源数据被跳过");
          }
          if (!taskId) {
            // 跟一键跟卖一致：没拿到 task_id 就当失败
            const err = "未收到任务ID";
            appendLog(`  ✗ ${label}: ${humanizeError(err)}`, "log-err");
            throw new Error(err);
          }
          // warnings 字段（如部分图片采集失败、AI 配额不足等非致命提醒）
          const warnings =
            resp.data?.warnings || resp.data?.result?.warnings || [];
          if (warnings.length > 0) {
            appendLog(`  ⚠ ${label}: ${warnings[0]}`, "log-err");
          }
          // backend 严格模式跳过的 SKU 列表（sv 不可用 → 不退化到面包屑）
          const strictSkipped = resp.data?.result?.strictSkipped || [];
          if (strictSkipped.length > 0) {
            appendLog(
              `  ⚠ ${label}: ${strictSkipped.length} 个 SKU 因无源数据被跳过`,
              "log-err",
            );
            for (const s of strictSkipped.slice(0, 5)) {
              appendLog(
                `      · ${s.sku || s.offer_id}: ${s.reason}`,
                "log-err",
              );
            }
            if (strictSkipped.length > 5) {
              appendLog(`      · 其余 ${strictSkipped.length - 5} 个略`, "log-err");
            }
          }
          appendLog(`  ✓ ${label}: task_id=${taskId}`, "log-ok");
          return { storeId: sid, taskId, warnings, raw: resp.data };
        } catch (e) {
          submitDone++;
          setProgress("submit", submitDone, storeIds.length);
          throw e;
        }
      })
    );

    saveBatchListingConfigAfterSuccess(settled);
    renderResults(settled, storeIds, items.length, collectResult, itemsFailed);
    onSubmitDone();
  }

  function readCfg() {
    const applyPoster = $("cfg-ai-poster")?.checked || false;
    // 只改主图:仅在 applyPoster 启用时有意义。透传给 backend 后,
    // product-import.worker.ts 按 primaryOnly 分支只跑第一张图,其余原图直送 Ozon。
    const posterPrimaryOnly = $("cfg-poster-primary-only")?.checked || false;
    const applyAiRewrite = $("cfg-ai-rewrite").checked;
    const captureVideo = $("cfg-capture-video")?.checked || false;
    const stockInput = $("cfg-default-stock");
    const defaultStock = parseInt(stockInput?.value || "0", 10);
    return {
      // Hardcoded（跟一键跟卖一致）：货号前缀 jz、VAT 0
      offerIdPrefix: "jz",
      vat: "0",
      // 01 店铺与基础
      brand: $("cfg-brand").value, // 'no_brand' | 'copy'
      imageOrder: $("cfg-image-order").value, // 'keep' | 'shuffle' | 'shuffle_keep_first'
      currencyCode: $("cfg-currency").value,
      // 型号名称（attr 9048）：留空=不合并，跟「一键跟卖」面板 merge-model 字段一致。
      // 填写后整批共享同一型号名 → Ozon 合并为同一张卡。
      mergeModel: ($("cfg-merge-model")?.value || "").trim(),
      // 02 AI 增强（V1 旧版改图已下线，仅 V2 海报）
      applyPoster,
      posterPrimaryOnly,
      applyAiRewrite,
      // 转存视频:逐 SKU 抓竞品 PDP 视频转存为自有 Ozon 视频(默认关,较慢)。
      captureVideo,
      // 默认库存:每店独立的 warehouseId 走 state.selectedWarehouseByStore
      defaultStock: Number.isFinite(defaultStock) && defaultStock > 0 ? defaultStock : 0,
    };
  }

  // 客户端 shuffle，跟 ozon-product.js:4987-5000 同款
  function applyImageOrder(images, order) {
    if (!Array.isArray(images) || images.length <= 1) return images;
    if (order === "shuffle") {
      const out = images.slice();
      for (let k = out.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [out[k], out[j]] = [out[j], out[k]];
      }
      return out;
    }
    if (order === "shuffle_keep_first" && images.length > 2) {
      const first = images[0];
      const rest = images.slice(1);
      for (let k = rest.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [rest[k], rest[j]] = [rest[j], rest[k]];
      }
      return [first, ...rest];
    }
    return images;
  }

  function setProgress(which, done, total) {
    // 当前 index.html 的 progress-card 只有 #progress-log, 不再有 prog-{which}-fill/text
    // 进度条 DOM (refactor 时简化为纯日志). 加 null 容错避免老代码 NPE 中断流程.
    const fill = $(`prog-${which}-fill`);
    const text = $(`prog-${which}-text`);
    if (!fill || !text) return;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    fill.style.width = pct + "%";
    text.textContent = `${done}/${total}`;
    if (done >= total && total > 0) fill.classList.add("is-done");
    else fill.classList.remove("is-done");
  }

  function renderResults(settled, storeIds, itemCount, collectResult, itemsFailed) {
    const list = $("result-list");
    list.innerHTML = "";
    settled.forEach((s, i) => {
      const sid = storeIds[i];
      const label = state.storeLabels.get(String(sid)) || `店铺 ${sid}`;
      const row = document.createElement("div");
      if (s.status === "fulfilled") {
        const warnings = s.value.warnings || [];
        row.className = "result-row is-ok";
        const warnHtml =
          warnings.length > 0
            ? ` · <span style="color:#c2410c">${escapeHtml(warnings[0])}</span>`
            : "";
        row.innerHTML = `<span class="result-store">${escapeHtml(
          label
        )}</span><span>提交成功 · ${itemCount} 条${warnHtml}</span><span class="result-meta">task=${escapeHtml(
          s.value.taskId || "—"
        )}</span>`;
      } else {
        const errMsg = humanizeError(s.reason?.message || s.reason);
        row.className = "result-row is-err";
        row.innerHTML = `<span class="result-store">${escapeHtml(
          label
        )}</span><span>失败: ${escapeHtml(errMsg)}</span>`;
      }
      list.appendChild(row);
    });

    const totalFailed = collectResult.failed.length + itemsFailed.length;
    if (totalFailed > 0) {
      const summary = document.createElement("div");
      summary.className = "result-row";
      summary.innerHTML = `<span class="result-store">未上架</span><span>${
        collectResult.failed.length
      } 个 SKU 批采失败 / ${itemsFailed.length} 个 item 拼装失败</span>`;
      list.appendChild(summary);
    }

    $("result-card").style.display = "";
  }

  function onSubmitDone() {
    state.submitting = false;
    state.abortCtrl = null;
    $("btn-submit").style.display = "";
    $("btn-cancel").style.display = "none";
    $("btn-clear").disabled = false;
    $("textarea").disabled = false;
    updateSubmitState();
  }

  function onCancel() {
    if (state.abortCtrl) state.abortCtrl.abort();
  }

  function onClear() {
    if (state.submitting) return;
    $("textarea").value = "";
    state.rows = [];
    renderPreview();
    updateSubmitState();
    $("progress-card").style.display = "none";
    $("result-card").style.display = "none";
  }

  // ─── Helpers ───────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // 提交响应超时/网络错后,核对该店是否其实已创建上架任务(避免误报网络错 + 客户重复提交)。
  // 后端 /products/import 先建任务记录再入队,响应慢被客户端 120s 掐断时任务往往已存在。
  // 轮询任务列表(最多 3 次,~7.5s),返回最近一条 skuCount 匹配且近 10 分钟内创建的任务;无则 null。
  // 列表已按 createdAt DESC,find 命中的即本次提交那条(即便之前重试过,取最新也对)。
  async function reconcileTimedOutSubmit(sid, expectedSkuCount) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 3000));
      let resp;
      try {
        resp = await sendMessage({ action: "listFollowSellTasks", storeId: sid, current: 1, pageSize: 10 });
      } catch {
        continue;
      }
      const items = resp?.data?.items || resp?.data?.list || (Array.isArray(resp?.data) ? resp.data : []);
      if (!Array.isArray(items) || !items.length) continue;
      const match = items.find((t) => {
        const sku = Number(t.skuCount ?? t.sku_count ?? 0);
        const ts = new Date(t.createdAt || 0).getTime();
        const recent = Number.isFinite(ts) && Date.now() - ts < 10 * 60 * 1000;
        return Math.abs(sku - expectedSkuCount) <= 2 && recent;
      });
      if (match) return match;
    }
    return null;
  }

  // 跟一键跟卖完全一致的错误友好化映射（ozon-product.js:5104-5125）
  function humanizeError(raw) {
    if (!raw) return "未知错误";
    const msg = String(raw);
    const TABLE = [
      [/IMPORT_RATE_LIMIT|429/i, "上架请求过于频繁，请稍后再试（每分钟最多 30 次）"],
      [/AUTH_EXPIRED|401|TOKEN_REVOKED|jwt expired/i, "登录已过期，请重新登录后重试"],
      [/Tenant context missing/i, "租户信息缺失，请重新登录"],
      [/items\.length must be <= 200/i, "单次最多 200 个商品，请分批上架"],
      [/未收到任务ID|task_id/i, "后端未返回任务编号，可能是网络中断，请稍后重试"],
      [/executeScript 未返回结果|bridge 返回错误|seller portal/i, "seller.ozon.ru 页面通讯失败，请刷新该页签后重试"],
      [/sc_company_id|cookie已过期|请先登录|seller\.ozon\.ru/i, "请确认已登录 seller.ozon.ru"],
      [/NetworkError|Failed to fetch|TimeoutError|超时/i, "网络异常或请求超时，请检查网络后重试"],
      [/Pre-import lookup failed/i, "Ozon 商品列表查询失败，已中止避免重复，请稍后重试"],
      [/offer_id already exists/i, "商品 offer_id 已存在，请检查是否重复上架"],
      [/Store not found/i, "店铺不存在或无权访问"],
      [/Missing x-ozon-store-id/i, "请先选择一个店铺"],
      // gate check 错误码（sku-collect.js 转译过的）
      [/NO_SELLER_TAB/i, "请先打开 seller.ozon.ru 并登录，再点开始"],
      [/NO_OZON_TAB/i, "请先在浏览器打开任意 ozon.ru 或 ozon.kz 页面（保持后台打开即可），用于抓商品公开页数据"],
      [/AUTH_REQUIRED/i, "seller.ozon.ru 登录已过期，请重新登录"],
      [/PERMISSION_DENIED/i, "扩展无权访问 seller.ozon.ru，请在 chrome://extensions 检查权限"],
      [/ANTIBOT_BLOCKED/i, "seller.ozon.ru 触发反爬，请稍后重试或换网络"],
      [/所有公开端点都失败/i, "Ozon 反爬拦截或 SKU 已下架，请在 ozon.ru / ozon.kz 浏览此 SKU 后重试"],
    ];
    for (const [re, label] of TABLE) {
      if (re.test(msg)) return label;
    }
    return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
  }

  // AI 改图额度（getAiQuota action）
  async function loadAiQuota() {
    try {
      const resp = await sendMessage({ action: "getAiQuota" });
      if (!resp?.ok) return;
      const q = resp.data || {};
      // V1 旧版 ai-image-quota span 已删（仅 V2 海报，单价由 loadAiQuota 动态覆盖到 poster-unit-cost span）
      // 2026-07:AI 重写按次扣极点(不再是会员权益)。余额充足 → 默认勾选(用户
      // 手动动过不覆盖);余额不足 → 禁用并取消勾选,否则提交会命中 backend
      // INSUFFICIENT_JIDIAN 让整批 FAILED。靠免费标题预检提醒。
      const rewritePl =
        typeof q.pointLabel === "string" && q.pointLabel.trim() ? q.pointLabel.trim() : "极点";
      if (q.aiRewrite?.sufficient) {
        $("ai-rewrite-quota").textContent = `${q.aiRewrite.price} ${rewritePl}/次`;
        $("ai-rewrite-quota").style.color = "#52c41a";
        $("ai-rewrite-quota").title = "按次扣费;多店铺上架同款文案缓存命中不重复扣";
        const cb = $("cfg-ai-rewrite");
        if (cb) cb.disabled = false;
        if (cb && !state.aiRewriteUserTouched && !cb.checked) {
          cb.checked = true;
          updateAiEnabledCount();
        }
      } else if (q.aiRewrite) {
        $("ai-rewrite-quota").textContent = `${rewritePl}不足`;
        $("ai-rewrite-quota").style.color = "#ff4d4f";
        $("ai-rewrite-quota").title = `${rewritePl}余额不足（当前 ${q.aiRewrite.balance ?? 0}，每次 ${q.aiRewrite.price}），请先充值`;
        const cb = $("cfg-ai-rewrite");
        if (cb) {
          cb.checked = false;
          cb.disabled = true;
          updateAiEnabledCount();
        }
      }
      // 海报成本预估需要：缓存余额 + 单价，触发卡片刷新
      if (typeof q.balance === "number") {
        state.aiBalance = q.balance;
      }
      if (typeof q.pointLabel === "string" && q.pointLabel.trim()) {
        state.pointLabel = q.pointLabel.trim();
      }
      const costUnitEl = $("poster-cost-unit");
      if (costUnitEl) costUnitEl.textContent = state.pointLabel;
      const n1UnitEl = $("poster-n1-unit");
      if (n1UnitEl) n1UnitEl.textContent = state.pointLabel;
      if (typeof q.aiImage?.price === "number" && q.aiImage.price > 0) {
        state.posterPricePerImage = q.aiImage.price;
        const unitCostEl = $("poster-unit-cost");
        if (unitCostEl) unitCostEl.textContent = `${q.aiImage.price} ${state.pointLabel} / 张`;
      }
      updatePosterEstimate();
    } catch (e) {
      // 静默失败
    }
  }

  // ─── AI 海报：成本预估 + 余额对比 + 耗时提示 ───────
  function updatePosterEstimate() {
    const enabled = $("cfg-ai-poster")?.checked || false;
    const extras = $("poster-extras");
    const disabledHint = $("poster-disabled-hint");
    if (!extras || !disabledHint) return;

    extras.style.display = enabled ? "" : "none";
    disabledHint.style.display = enabled ? "none" : "";
    if (!enabled) return;

    // SKU 数 = 已 parse 的有效行数；fallback 到 textarea 非空行数（输入中尚未 parse 的瞬时态）
    let skuCount = state.rows.filter((r) => r.valid).length;
    if (skuCount === 0) {
      const raw = $("textarea")?.value || "";
      skuCount = raw.split("\n").filter((l) => l.trim().length > 0).length;
    }
    // 只改主图:每 SKU 只渲染主图,极点 N→1 (worker.ts:316 primaryOnly 分支)。
    const primaryOnly = $("cfg-poster-primary-only")?.checked || false;
    const imagesPerSku = primaryOnly ? 1 : ESTIMATE_IMAGES_PER_SKU;
    // 多店扇出不再乘 store 数 —— 后端按 (tenantId, offerId, image-hash) cache，
    // 第一个店跑出来后，其余店都是 cache 命中、不重复扣点。
    const totalImages = skuCount * imagesPerSku;
    const pricePerImage = state.posterPricePerImage || POSTER_COST_PER_IMAGE_DEFAULT;
    const totalCost = totalImages * pricePerImage;

    const balance = state.aiBalance;
    // 余额未知时默认按充足色显示 cost box（不显示余额行）
    const sufficient = balance == null ? true : balance >= totalCost;

    // Cost box
    const costValueEl = $("poster-cost-value");
    const costBreakdownEl = $("poster-cost-breakdown");
    const costBox = $("poster-cost-box");
    if (costValueEl) costValueEl.textContent = totalCost.toLocaleString();
    if (costBreakdownEl) {
      if (skuCount === 0) {
        costBreakdownEl.textContent = primaryOnly
          ? "粘贴 SKU 后自动估算（每 SKU 只算 1 张主图）"
          : "粘贴 SKU 后自动估算（每 SKU ≈ 8 张图）";
      } else if (primaryOnly) {
        costBreakdownEl.textContent = `预估 ${skuCount} SKU × 1 张主图 × ${pricePerImage} ${state.pointLabel}`;
      } else {
        costBreakdownEl.textContent = `预估 ${skuCount} SKU × ${ESTIMATE_IMAGES_PER_SKU} 张 × ${pricePerImage} ${state.pointLabel}`;
      }
    }
    if (costBox) costBox.classList.toggle("insufficient", !sufficient);

    // Balance row
    const balanceRow = $("poster-balance-row");
    const balanceIcon = $("poster-balance-icon");
    const balanceText = $("poster-balance-text");
    const rechargeLink = $("poster-recharge-link");
    if (balanceRow && balanceIcon && balanceText && rechargeLink) {
      // 余额未知 / 成本=0 时不显示余额行（cost box 仍然显示空预估）
      if (balance == null || totalCost === 0) {
        balanceRow.style.display = "none";
      } else {
        balanceRow.style.display = "";
        balanceRow.classList.toggle("insufficient", !sufficient);
        balanceIcon.textContent = sufficient ? "✓" : "⚠";
        balanceText.textContent = `余额：${balance.toLocaleString()} ${state.pointLabel} · ${
          sufficient ? "充足" : "不足"
        }`;
        if (sufficient) {
          rechargeLink.style.display = "none";
        } else {
          rechargeLink.style.display = "";
          // openFrontend 走 service-worker，本地 a 标签 fallback：传入 frontend baseUrl 通过 chrome.tabs（service-worker 已支持 openFrontend，但这里用普通链接更轻）
          rechargeLink.href = "#";
          rechargeLink.onclick = (e) => {
            e.preventDefault();
            sendMessage({ action: "openFrontend", path: RECHARGE_PATH });
          };
        }
      }
    }
  }

  function updateAiEnabledCount() {
    let count = 0;
    if ($("cfg-ai-poster")?.checked) count++;
    if ($("cfg-ai-rewrite").checked) count++;
    const el = $("ai-enabled-count");
    if (count > 0) {
      el.textContent = `已启用 ${count}`;
      el.style.display = "";
    } else {
      el.style.display = "none";
    }
  }

  function bindAiSection() {
    // 折叠/展开点击
    $("ai-head").addEventListener("click", () => {
      const sect = $("ai-section");
      const head = $("ai-head");
      const isCollapsed = sect.classList.toggle("mv-collapsed");
      head.dataset.collapsed = String(isCollapsed);
    });
    $("ai-head").dataset.collapsed = "false";

    // 自定义提示词输入框可见性跟随场景 select
    // 任一 toggle 改时更新已启用计数（V1 旧版改图已下线）
    ["cfg-ai-poster", "cfg-ai-rewrite"].forEach((id) =>
      $(id) && $(id).addEventListener("change", updateAiEnabledCount)
    );
    // 海报 toggle 单独触发成本预估刷新
    $("cfg-ai-poster")?.addEventListener("change", updatePosterEstimate);
    // 只改主图勾选时也要重算预估,否则 toggle 主图模式后 cost box 不刷新。
    $("cfg-poster-primary-only")?.addEventListener("change", updatePosterEstimate);
    // 用户手动动过 AI 重写开关后,loadAiQuota 的「会员默认勾选」不再覆盖其选择。
    $("cfg-ai-rewrite")?.addEventListener("change", () => {
      state.aiRewriteUserTouched = true;
    });
  }

  // 「合并成一张卡」开关:只是给已有的型号名称(attr 9048)字段做自动填/清,
  // 上架逻辑(readCfg → buildV3Item)不变 —— 合并与否始终看该字段是否非空:
  //   勾选且字段空 → 自动生成整批共享型号名 → 40 变体并一张卡;
  //   取消勾选 → 清空字段 → 不合并(每个各自成卡,现状)。
  // 手动填/清字段时反向同步开关,保证「勾选 ⟺ 有型号名 ⟺ 合并」一致。
  function bindMergeCard() {
    const toggle = $("cfg-merge-card");
    const field = $("cfg-merge-model");
    if (!toggle || !field) return;
    // 整批唯一 + 共享一个值即可让 Ozon 合并;用户可改成更可读的型号名。
    const genModel = () => "JZ-" + Date.now().toString(36).toUpperCase();
    // 只缓存「是否合并」这个偏好,不缓存型号名本身:每次开页重新生成新型号名,
    // 避免不同批次复用同一型号名导致 Ozon 把不相关商品错误并到一张卡。
    const persist = (on) => {
      try {
        chrome.storage.local.set({ batchMergeCardEnabled: !!on });
      } catch {}
    };
    toggle.addEventListener("change", () => {
      if (toggle.checked) {
        if (!field.value.trim()) field.value = genModel();
      } else {
        field.value = "";
      }
      persist(toggle.checked);
    });
    field.addEventListener("input", () => {
      const on = !!field.value.trim();
      if (on !== toggle.checked) {
        toggle.checked = on; // 勾选 ⟺ 有型号名 ⟺ 合并
        persist(on);
      }
    });
    // 恢复上次的「合并」偏好:之前勾选过则自动勾上并生成新型号名(仅在留空时
    // 生成,不覆盖用户本次已填的自定义名)。
    try {
      chrome.storage.local.get(["batchMergeCardEnabled"], (r) => {
        if (r && r.batchMergeCardEnabled) {
          toggle.checked = true;
          if (!field.value.trim()) field.value = genModel();
        }
      });
    } catch {}
  }

  // 头栏 logo + 标题：按 brand 配置渲染（分销商扩展看到自家 logo/名称，
  // 而不是固定的"极"方块和"极掌"文案）。
  //   - tb-icon：有 brand.logoUrl 用 <img>，否则用 displayName[0] 占位字符
  //   - document.title：brand 占位符在主插件 build.js /
  //     分销商 extension-build.service.ts textual replace 流程会被替换；dev
  //     加载源码时占位符没替换，这里 runtime 兜底
  function renderBrandHeader() {
    const brand = globalThis.__JZ_BRAND__ || {};
    const displayName = brand.displayName || DEFAULT_BRAND_DISPLAY_NAME;
    // logo 方块底色按 brand 主色走（默认 CSS --primary 是 #1677FF）；只覆盖
    // logo 这一处的 background，不批量改派生色，避免与页面其它紫蓝色控件冲突 —
    // logo 是 brand 锚点，其它控件保留 ERP 设计的多色基底。
    const iconEl = $("tb-icon");
    if (iconEl) {
      if (brand.primaryColor) iconEl.style.background = brand.primaryColor;
      if (brand.logoUrl) {
        const img = document.createElement("img");
        img.src = brand.logoUrl;
        img.alt = "";
        iconEl.innerHTML = "";
        iconEl.appendChild(img);
      } else {
        iconEl.textContent = displayName.slice(0, 1);
      }
    }
    // dev 加载源码时占位符没被 build 替换 → 兜底
    if (document.title.includes("sonli")) {
      document.title = document.title.split("sonli").join(displayName);
    }
  }

  // ─── Boot ──────────────────────────────────────
  async function init() {
    renderBrandHeader();

    // 显示扩展版本
    try {
      const manifest = chrome.runtime.getManifest();
      $("hdr-version").textContent = "v" + manifest.version;
    } catch {}

    // 鉴权 + tab 检查
    const authed = await checkAuth();
    if (!authed) return;
    await checkSellerTab();
    await loadStores();

    // AI 增强相关初始化（不阻塞主流程）
    // 仓库走 picker.onChange 的懒加载,不在这里全局加载
    bindAiSection();
    bindMergeCard();
    applyBatchListingConfig(await readBatchListingConfig());
    loadAiQuota();
    updatePosterEstimate();

    // 事件
    $("textarea").addEventListener("input", onTextareaInput);
    $("btn-submit").addEventListener("click", onSubmit);
    $("btn-cancel").addEventListener("click", onCancel);
    $("btn-clear").addEventListener("click", onClear);
    $("btn-history").addEventListener("click", () => {
      sendMessage({
        action: "openFrontend",
        path: "/ozon/products/import-history",
      });
    });

    // 使用说明 drawer
    const openHelp = () => {
      $("help-backdrop").style.display = "";
      $("help-drawer").style.display = "";
      $("help-drawer").setAttribute("aria-hidden", "false");
    };
    const closeHelp = () => {
      $("help-backdrop").style.display = "none";
      $("help-drawer").style.display = "none";
      $("help-drawer").setAttribute("aria-hidden", "true");
    };
    $("btn-help").addEventListener("click", openHelp);
    $("btn-help-close").addEventListener("click", closeHelp);
    $("help-backdrop").addEventListener("click", closeHelp);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("help-drawer").style.display !== "none") closeHelp();
    });

    updateSubmitState();
  }

  init();
})();
