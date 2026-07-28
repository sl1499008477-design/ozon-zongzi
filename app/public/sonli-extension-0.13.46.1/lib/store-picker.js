/**
 * 店铺选择器 — 复刻自一键跟卖面板（ozon-product.js:2620-3076）。
 *
 * API:
 *   const picker = JZStorePicker.mount(wrapperEl, opts);
 *   picker.getSelectedIds() → string[]
 *   picker.refresh() → 重拉店铺列表
 *
 * 用法（HTML 骨架由 caller 提供）：
 *   <div data-field="store-wrapper" style="position:relative;">
 *     <div data-action="toggle-stores"></div>
 *     <div data-field="store-dropdown" style="display:none;"></div>
 *   </div>
 *
 * opts:
 *   onChange?: (ids: string[]) => void   选中变化
 *   defaultSelectedIds?: string[]        覆盖 auth.storeId 默认勾选
 *
 * 不提供任何 mount-time 渲染：返回 promise 等待 stores 加载完毕，
 * caller 拿 picker.getSelectedIds() 时已经能拿到默认值。
 */
(function (root) {
  "use strict";

  function _escHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function _cssEscape(id) {
    return String(id).replace(/(["'\\])/g, "\\$1");
  }

  function _buildStoreView(s) {
    const id = s.id || s.storeId || "";
    const name = s.label || s.companyName || s.legalName || `店铺 ${id}`;
    const country = (s.companyCountry || "").toUpperCase();
    const flag =
      country === "RU"
        ? "🇷🇺"
        : country === "BY"
        ? "🇧🇾"
        : country === "KZ"
        ? "🇰🇿"
        : "";
    const group =
      country === "RU"
        ? "俄罗斯"
        : country === "BY"
        ? "白俄罗斯"
        : country === "KZ"
        ? "哈萨克斯坦"
        : "其它";
    const color =
      country === "RU"
        ? "#1d6bff"
        : country === "BY"
        ? "#0ea5e9"
        : country === "KZ"
        ? "#0891b2"
        : "#6b7a93";
    const tier = s.isPremium ? "Premium" : "Standard";
    const bound = !!s.watermarkTemplateId;
    const cleanName = name.replace(/[#·\s].*$/, "").trim();
    const initials = (cleanName.slice(0, 2) || "##").toUpperCase();
    const code =
      s.shopId != null
        ? String(s.shopId).padStart(5, "0")
        : id
        ? String(id).slice(-5)
        : "-----";
    return {
      id: String(id),
      name,
      country,
      flag,
      group,
      color,
      tier,
      bound,
      initials,
      code,
      isActive: s.isActive !== false,
    };
  }

  function _getRecentStoreIds() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(["mv-store-recent"], (r) => {
          resolve(
            Array.isArray(r["mv-store-recent"])
              ? r["mv-store-recent"].map(String)
              : []
          );
        });
      } catch {
        resolve([]);
      }
    });
  }

  function _saveRecentStoreIds(ids) {
    if (!ids || !ids.length) return;
    const newIds = ids.map(String);
    try {
      chrome.storage.local.get(["mv-store-recent"], (r) => {
        const existing = Array.isArray(r["mv-store-recent"])
          ? r["mv-store-recent"].map(String)
          : [];
        const merged = [
          ...newIds,
          ...existing.filter((x) => !newIds.includes(x)),
        ].slice(0, 12);
        chrome.storage.local.set({ "mv-store-recent": merged });
      });
    } catch {}
  }

  function _positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    pop.style.position = "fixed";
    pop.style.top = `${rect.bottom + 6}px`;
    pop.style.left = `${rect.left}px`;
    pop.style.zIndex = "2147483647";
    requestAnimationFrame(() => {
      const popRect = pop.getBoundingClientRect();
      if (popRect.right > window.innerWidth - 16) {
        pop.style.left = `${Math.max(
          16,
          window.innerWidth - popRect.width - 16
        )}px`;
      }
      if (popRect.bottom > window.innerHeight - 16) {
        pop.style.top = `${Math.max(16, rect.top - popRect.height - 6)}px`;
      }
    });
  }

  // promise wrapper for chrome.runtime.sendMessage
  function sendMsg(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  async function fetchStores() {
    const resp = await sendMsg({ action: "getStores" });
    if (!resp?.ok) return [];
    return resp.data?.data || resp.data || [];
  }

  async function fetchAuth() {
    const resp = await sendMsg({ action: "getAuth" });
    return resp?.data || resp || {};
  }

  function _renderEnterprisePicker(wrapper, storeList, opts) {
    const dropdown = wrapper.querySelector('[data-field="store-dropdown"]');
    const oldTrigger = wrapper.querySelector('[data-action="toggle-stores"]');
    if (!dropdown || !oldTrigger) return null;

    dropdown.classList.add("ozon-helper-mv-store-dropdown-legacy");

    const pill = document.createElement("div");
    pill.className = "ozon-helper-mv-store-pill";
    pill.setAttribute("data-action", "toggle-stores");
    oldTrigger.replaceWith(pill);

    const scopeRow = document.createElement("div");
    scopeRow.className = "ozon-helper-mv-store-pill-scope";
    scopeRow.style.display = "none";
    pill.insertAdjacentElement("afterend", scopeRow);

    const renderPill = () => {
      const checked = dropdown.querySelectorAll(
        ".ozon-helper-mv-store-cb:checked"
      );
      const total = storeList.length;
      const sel = checked.length;
      if (sel === 0) {
        pill.innerHTML = `
          <span class="ohm-pill-empty">请选择店铺</span>
          <span class="ohm-pill-meta">0 / ${total} 店</span>
          <span class="ohm-pill-arrow">点击选择 ▾</span>`;
        scopeRow.style.display = "none";
        scopeRow.innerHTML = "";
        return;
      }
      const samples = Array.from(checked)
        .slice(0, 4)
        .map((cb) => {
          const id = cb.value;
          const s = storeList.find(
            (x) => String(x.id || x.storeId) === String(id)
          );
          return s
            ? _buildStoreView(s)
            : { id, name: id, color: "#94a3b8", initials: "##", flag: "" };
        });
      const overflow = Math.max(0, sel - 4);
      pill.innerHTML = `
        <div class="ohm-pill-count"><strong>${sel}</strong><em>/ ${total} 店</em></div>
        <span class="ohm-pill-divider"></span>
        <div class="ohm-pill-stack">
          ${samples
            .map(
              (s) =>
                `<span class="ohm-pill-avatar" style="background:${
                  s.color
                }" title="${_escHtml(s.name)}">${_escHtml(s.initials)}</span>`
            )
            .join("")}
        </div>
        <span class="ohm-pill-names">${samples
          .map((s) => _escHtml(s.name))
          .join(" · ")}${overflow ? ` <em>+${overflow} 个</em>` : ""}</span>
        <span class="ohm-pill-arrow">点击修改 ▾</span>`;

      _getRecentStoreIds().then((recentIds) => {
        const recentSet = new Set(recentIds);
        const checkedIds = Array.from(checked).map((cb) => String(cb.value));
        const allRecent =
          checkedIds.length > 0 && checkedIds.every((id) => recentSet.has(id));
        const ruleLabel = allRecent ? `最近用过 (${sel})` : `已选 ${sel} 家`;
        scopeRow.style.display = "";
        scopeRow.innerHTML = `
          <span class="ohm-pill-scope-label">选择规则</span>
          <span class="ohm-pill-scope-chip">${ruleLabel} <em data-action="clear-stores">×</em></span>
          <span class="ohm-pill-scope-hint">规则保存后，新加入的店铺会自动匹配</span>
        `;
      });
    };
    renderPill();

    dropdown.addEventListener("change", () => {
      renderPill();
      if (typeof opts.onChange === "function") {
        const ids = Array.from(
          dropdown.querySelectorAll(".ozon-helper-mv-store-cb:checked")
        ).map((cb) => cb.value);
        opts.onChange(ids);
      }
    });

    scopeRow.addEventListener("click", (e) => {
      if (e.target.closest('[data-action="clear-stores"]')) {
        dropdown
          .querySelectorAll(".ozon-helper-mv-store-cb:checked")
          .forEach((cb) => {
            cb.checked = false;
            cb.dispatchEvent(new Event("change", { bubbles: true }));
          });
      }
    });

    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      _openPickerPopover(storeList, dropdown, pill);
    });

    return { dropdown, pill, renderPill };
  }

  function _openPickerPopover(storeList, hiddenDropdown, pill) {
    document
      .querySelectorAll(".ozon-helper-mv-storepick-pop")
      .forEach((p) => p.remove());

    const views = storeList.map(_buildStoreView);

    _getRecentStoreIds().then((recentIds) => {
      const recentSet = new Set(recentIds);
      views.forEach((v) => (v.lastUsed = recentSet.has(v.id)));

      let query = "";
      let activeTab = "全部";

      const pop = document.createElement("div");
      pop.className = "ozon-helper-mv-storepick-pop";
      document.body.appendChild(pop);

      const isChecked = (id) =>
        !!hiddenDropdown.querySelector(
          `.ozon-helper-mv-store-cb[value="${_cssEscape(id)}"]`
        )?.checked;
      const setChecked = (id, val) => {
        const cb = hiddenDropdown.querySelector(
          `.ozon-helper-mv-store-cb[value="${_cssEscape(id)}"]`
        );
        if (cb && cb.checked !== val) {
          cb.checked = val;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
      };

      const filteredList = () => {
        let list = views.slice();
        if (activeTab === "已选") list = list.filter((v) => isChecked(v.id));
        else if (activeTab === "最近") list = list.filter((v) => v.lastUsed);
        else if (activeTab === "Premium")
          list = list.filter((v) => v.tier === "Premium");
        else if (activeTab === "未绑水印")
          list = list.filter((v) => !v.bound);
        if (query) {
          const q = query.toLowerCase();
          list = list.filter(
            (v) =>
              v.name.toLowerCase().includes(q) ||
              v.code.includes(query) ||
              v.id.toLowerCase().includes(q)
          );
        }
        return list;
      };

      const renderPop = () => {
        const list = filteredList();
        const groupOrder = ["俄罗斯", "白俄罗斯", "哈萨克斯坦", "其它"];
        const grouped = groupOrder
          .map((g) => ({ name: g, rows: list.filter((v) => v.group === g) }))
          .filter((g) => g.rows.length);
        const counts = {
          全部: views.length,
          已选: hiddenDropdown.querySelectorAll(
            ".ozon-helper-mv-store-cb:checked"
          ).length,
          最近: views.filter((v) => v.lastUsed).length,
          Premium: views.filter((v) => v.tier === "Premium").length,
          未绑水印: views.filter((v) => !v.bound).length,
        };
        const tabs = ["全部", "已选", "最近", "Premium", "未绑水印"];
        const allInListChecked =
          list.length > 0 && list.every((v) => isChecked(v.id));
        const totalSelected = counts["已选"];
        const boundCount = views.filter((v) => v.bound).length;

        pop.innerHTML = `
          <div class="ohm-sp-search">
            <span class="ohm-sp-search-icon">🔍</span>
            <input type="text" class="ohm-sp-input" placeholder="搜店铺名 / 店铺 ID / 标签…" value="${_escHtml(
              query
            )}" />
          </div>
          <div class="ohm-sp-chips">
            <span class="ohm-sp-chips-label">快速选择</span>
            <span class="ohm-sp-chip" data-quick="all">全部 ${counts["全部"]} 家</span>
            <span class="ohm-sp-chip" data-quick="premium">仅 Premium (${counts["Premium"]})</span>
            <span class="ohm-sp-chip" data-quick="recent">最近用过 (${counts["最近"]})</span>
            <span class="ohm-sp-chip" data-quick="bound">已绑水印 (${boundCount})</span>
            <span class="ohm-sp-chip" data-quick="invert">反选</span>
            <span class="ohm-sp-chip is-danger" data-quick="clear">清空</span>
          </div>
          <div class="ohm-sp-tabs">
            ${tabs
              .map(
                (t) =>
                  `<span class="ohm-sp-tab ${
                    t === activeTab ? "is-active" : ""
                  }" data-tab="${t}">${t}<em>${counts[t]}</em></span>`
              )
              .join("")}
          </div>
          <div class="ohm-sp-list-head">
            <label class="ohm-sp-allinscope">
              <input type="checkbox" data-action="select-in-scope" ${
                allInListChecked ? "checked" : ""
              }/>
              全选当前列表（<b>${list.length}</b> 家）
            </label>
          </div>
          <div class="ohm-sp-list">
            ${
              grouped.length === 0
                ? '<div class="ohm-sp-empty">没有匹配的店铺</div>'
                : grouped
                    .map(
                      (g) => `
                <div class="ohm-sp-group">
                  <div class="ohm-sp-group-head">
                    <span class="ohm-sp-group-dot"></span>
                    <span class="ohm-sp-group-name">${g.name}</span>
                    <span class="ohm-sp-group-count">${g.rows.filter((v) => isChecked(v.id)).length} / ${g.rows.length}</span>
                    <span class="ohm-sp-group-action" data-group-all="${g.name}">本组全选</span>
                  </div>
                  ${g.rows
                    .map((v) => {
                      const checked = isChecked(v.id);
                      return `
                      <label class="ohm-sp-row ${checked ? "is-checked" : ""}">
                        <input type="checkbox" class="ohm-sp-row-cb" data-id="${_escHtml(v.id)}" ${checked ? "checked" : ""}/>
                        <span class="ohm-sp-avatar" style="background:${v.color}">${_escHtml(v.initials)}</span>
                        <span class="ohm-sp-info">
                          <span class="ohm-sp-name">${_escHtml(v.name)}${v.lastUsed ? ' <em class="ohm-sp-tag">最近</em>' : ""}</span>
                          <span class="ohm-sp-meta">${v.code}${v.flag ? " · " + v.flag : ""}${v.tier === "Premium" ? " · <b>Premium</b>" : ""}</span>
                        </span>
                        <span class="ohm-sp-status ${v.bound ? "is-ok" : ""}">${v.bound ? "💧 已绑" : "— 未绑"}</span>
                        <span class="ohm-sp-only" data-only="${_escHtml(v.id)}">仅此店</span>
                      </label>
                    `;
                    })
                    .join("")}
                </div>
              `
                    )
                    .join("")
            }
          </div>
          <div class="ohm-sp-footer">
            <span class="ohm-sp-footer-count">已选 <b>${totalSelected}</b> 家</span>
            <span class="ohm-sp-footer-spacer"></span>
            <button class="ohm-sp-btn ohm-sp-btn-ghost" data-action="close">取消</button>
            <button class="ohm-sp-btn ohm-sp-btn-primary" data-action="apply">应用</button>
          </div>
        `;
        _positionPopover(pop, pill);
      };

      renderPop();

      pop.addEventListener("input", (e) => {
        if (e.target.classList?.contains("ohm-sp-input")) {
          query = e.target.value;
          const cursor = e.target.selectionStart;
          renderPop();
          const ip = pop.querySelector(".ohm-sp-input");
          if (ip) {
            ip.focus();
            ip.setSelectionRange(cursor, cursor);
          }
        }
      });

      pop.addEventListener("click", (e) => {
        const tab = e.target.closest("[data-tab]");
        if (tab) {
          activeTab = tab.getAttribute("data-tab");
          renderPop();
          return;
        }
        const quick = e.target.closest("[data-quick]");
        if (quick) {
          const t = quick.getAttribute("data-quick");
          if (t === "all") views.forEach((v) => setChecked(v.id, true));
          else if (t === "premium")
            views.forEach((v) => setChecked(v.id, v.tier === "Premium"));
          else if (t === "recent")
            views.forEach((v) => setChecked(v.id, v.lastUsed));
          else if (t === "bound")
            views.forEach((v) => setChecked(v.id, v.bound));
          else if (t === "invert")
            views.forEach((v) => setChecked(v.id, !isChecked(v.id)));
          else if (t === "clear") views.forEach((v) => setChecked(v.id, false));
          renderPop();
          return;
        }
        const grpAll = e.target.closest("[data-group-all]");
        if (grpAll) {
          const g = grpAll.getAttribute("data-group-all");
          const allOn = views
            .filter((v) => v.group === g)
            .every((v) => isChecked(v.id));
          views
            .filter((v) => v.group === g)
            .forEach((v) => setChecked(v.id, !allOn));
          renderPop();
          return;
        }
        const onlyBtn = e.target.closest("[data-only]");
        if (onlyBtn) {
          const id = onlyBtn.getAttribute("data-only");
          views.forEach((v) => setChecked(v.id, v.id === id));
          renderPop();
          return;
        }
        const close = e.target.closest('[data-action="close"]');
        if (close) {
          pop.remove();
          return;
        }
        const apply = e.target.closest('[data-action="apply"]');
        if (apply) {
          const ids = Array.from(
            hiddenDropdown.querySelectorAll(".ozon-helper-mv-store-cb:checked")
          ).map((cb) => cb.value);
          _saveRecentStoreIds(ids);
          pop.remove();
          return;
        }
      });

      pop.addEventListener("change", (e) => {
        if (e.target.classList?.contains("ohm-sp-row-cb")) {
          setChecked(e.target.getAttribute("data-id"), e.target.checked);
          renderPop();
          return;
        }
        if (e.target.matches?.('[data-action="select-in-scope"]')) {
          filteredList().forEach((v) => setChecked(v.id, e.target.checked));
          renderPop();
          return;
        }
      });

      setTimeout(() => {
        const outside = (ev) => {
          if (!pop.contains(ev.target) && !pill.contains(ev.target)) {
            pop.remove();
            document.removeEventListener("mousedown", outside);
          }
        };
        document.addEventListener("mousedown", outside);
      }, 0);
    });
  }

  /**
   * 主入口。返回 Promise<{ getSelectedIds, refresh }>，
   * promise resolve 时店铺列表已加载、默认勾选已渲染。
   */
  async function mount(wrapperEl, opts = {}) {
    if (!wrapperEl) throw new Error("JZStorePicker.mount: wrapperEl required");

    const trigger = wrapperEl.querySelector('[data-action="toggle-stores"]');
    const dropdown = wrapperEl.querySelector('[data-field="store-dropdown"]');
    if (!trigger || !dropdown) {
      throw new Error(
        "JZStorePicker.mount: wrapperEl 缺少 [data-action=toggle-stores] 或 [data-field=store-dropdown]"
      );
    }
    trigger.textContent = "加载中...";

    const [storeList, auth] = await Promise.all([fetchStores(), fetchAuth()]);

    if (!storeList.length) {
      trigger.textContent = "暂无店铺";
      return {
        getSelectedIds: () => [],
        refresh: () => mount(wrapperEl, opts),
      };
    }

    // 渲染隐藏的 checkbox 列表（source-of-truth）+ 全选选项
    dropdown.innerHTML = "";
    const selectAll = document.createElement("label");
    selectAll.className = "ozon-helper-mv-store-option";
    selectAll.style.borderBottom = "1px solid #f0f0f0";
    selectAll.innerHTML = `<input type="checkbox" class="ozon-helper-mv-store-select-all" /> <strong>全选</strong>`;
    dropdown.appendChild(selectAll);

    const defaults =
      opts.defaultSelectedIds && opts.defaultSelectedIds.length
        ? new Set(opts.defaultSelectedIds.map(String))
        : auth.storeId
        ? new Set([String(auth.storeId)])
        : new Set();

    storeList.forEach((s) => {
      const id = String(s.id || s.storeId || "");
      const name = s.label || s.companyName || s.legalName || `店铺 ${id}`;
      const isDef = defaults.has(id);
      const label = document.createElement("label");
      label.className = "ozon-helper-mv-store-option";
      label.innerHTML = `<input type="checkbox" class="ozon-helper-mv-store-cb" value="${_escHtml(
        id
      )}" ${isDef ? "checked" : ""} /> ${_escHtml(name)}`;
      dropdown.appendChild(label);
    });

    // 全选交互
    const selectAllCb = dropdown.querySelector(
      ".ozon-helper-mv-store-select-all"
    );
    selectAllCb.addEventListener("change", () => {
      const allCbs = dropdown.querySelectorAll(".ozon-helper-mv-store-cb");
      allCbs.forEach((cb) => {
        cb.checked = selectAllCb.checked;
      });
      // 触发 change 让 onChange 回调生效
      dropdown.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // 升级到 enterprise pill picker
    _renderEnterprisePicker(wrapperEl, storeList, opts);

    // 初次触发 onChange，让 caller 拿到默认选择
    if (typeof opts.onChange === "function") {
      const ids = Array.from(
        dropdown.querySelectorAll(".ozon-helper-mv-store-cb:checked")
      ).map((cb) => cb.value);
      opts.onChange(ids);
    }

    return {
      getSelectedIds: () =>
        Array.from(
          dropdown.querySelectorAll(".ozon-helper-mv-store-cb:checked")
        ).map((cb) => cb.value),
      refresh: () => mount(wrapperEl, opts),
    };
  }

  root.JZStorePicker = { mount };
})(typeof self !== "undefined" ? self : window);
