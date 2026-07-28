// 水印模板 select 填充 — extension/content/ozon-product.js + extension/batch-upload/index.js
// 之前各自一份 fetch /ozon/watermark-settings + /auth/ozon-stores 并把 store
// 绑定模板拿出来 auto-select 的代码,几乎完全一样。提到这里集中维护。
//
// 用法:
//   const { templates, boundId } = await JZWatermarkTemplates.loadIntoSelect({
//     getAuth,                    // async () => { token, backendUrl, storeId? }
//     selectEl,                   // <select> 节点
//     applyCheckboxEl,            // optional <input type=checkbox> — 有绑定时勾上
//     defaultLabel,               // optional, 默认 "店铺绑定水印/边框"
//   });
//
// 行为:
//   - 拉模板 + store 列表
//   - 把「店铺绑定水印/边框」+ 模板填进 selectEl 选项,默认选中「店铺绑定水印/边框」
//   - 若提供了 applyCheckboxEl 且有绑定,勾上复选框
//   - 异常时 select 显示"加载失败"option,函数 resolve 不抛
(function () {
  const STORE_BOUND_VALUE = "__store_bound__";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c];
    });
  }

  function getTemplateTypeLabel(type) {
    if (type === "border") return "边框";
    if (type === "image") return "图片";
    return "文字";
  }

  async function loadIntoSelect(opts) {
    const {
      getAuth,
      loadData,
      selectEl,
      applyCheckboxEl,
      defaultLabel = "店铺绑定水印/边框",
    } = opts || {};
    if (typeof getAuth !== "function") {
      throw new Error("loadIntoSelect: getAuth function required");
    }
    try {
      const auth = await getAuth();
      if (!auth || !auth.token || !auth.backendUrl) {
        if (selectEl) {
          selectEl.innerHTML = `<option value="${STORE_BOUND_VALUE}" selected>${escapeHtml(defaultLabel)}</option>`;
        }
        return { templates: [], boundId: null, storeBoundValue: STORE_BOUND_VALUE };
      }
      const headers = {
        Authorization: "Bearer " + auth.token,
        "Content-Type": "application/json",
      };
      if (auth.storeId) headers["x-ozon-store-id"] = auth.storeId;
      // CDN 历史污染兜底:见 extension/lib/cdn-buster.js。
      const bust = globalThis.JzCdnBuster ? globalThis.JzCdnBuster.withCdnBuster : (u) => u;
      let payload;
      if (typeof loadData === "function") {
        const loaded = await loadData({ auth, headers });
        payload = loaded && loaded.data ? loaded.data : loaded;
      } else {
        const [wmRes, storeRes] = await Promise.all([
          fetch(bust(auth.backendUrl + "/ozon/watermark-settings"), { headers }),
          fetch(bust(auth.backendUrl + "/auth/ozon-stores"), { headers }),
        ]);
        payload = {
          templates: wmRes.ok ? await wmRes.json() : [],
          stores: storeRes.ok ? await storeRes.json() : [],
        };
      }
      const templates = Array.isArray(payload && payload.templates) ? payload.templates : [];
      const stores = Array.isArray(payload && payload.stores) ? payload.stores : [];
      const currentStore = stores.find(function (s) {
        return s.id === auth.storeId;
      });
      const boundId = (currentStore && currentStore.watermarkTemplateId) || null;

      if (selectEl) {
        selectEl.innerHTML =
          `<option value="${STORE_BOUND_VALUE}" selected>${escapeHtml(defaultLabel)}</option>` +
          templates
            .map(function (t) {
              const typeLabel = getTemplateTypeLabel(t.type);
              return `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)} (${typeLabel})</option>`;
            })
            .join("");
        selectEl.value = STORE_BOUND_VALUE;
      }
      if (boundId && applyCheckboxEl) applyCheckboxEl.checked = true;
      return { templates, boundId, storeBoundValue: STORE_BOUND_VALUE };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[watermark-templates] load failed:", e);
      if (selectEl) {
        selectEl.innerHTML = '<option value="">加载失败</option>';
      }
      return { templates: [], boundId: null, storeBoundValue: STORE_BOUND_VALUE, error: e };
    }
  }

  if (typeof window !== "undefined") {
    window.JZWatermarkTemplates = { STORE_BOUND_VALUE, loadIntoSelect };
  }
})();
