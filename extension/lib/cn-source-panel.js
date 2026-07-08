(function () {
  if (window.JZCnSourcePanel) return;

  const LOG_PREFIX = "[jzc-cn-source]";
  const DEBUG_PAGE_SOURCE = "jzc-cn-source-debug-page";
  const DEBUG_BRIDGE_SOURCE = "jzc-cn-source-debug-bridge";
  const DEBUG_REQUEST_TYPE = "JZC_CN_SOURCE_DEBUG_REQUEST";
  const DEBUG_RESPONSE_TYPE = "JZC_CN_SOURCE_DEBUG_RESPONSE";

  function log(...args) {
    try {
      console.log(LOG_PREFIX, ...args);
    } catch {}
  }

  function getBrand() {
    const runtime = globalThis.__JZ_BRAND__ || {};
    const displayName = runtime.displayName || (/__BRAND/.test("sonli") ? "sonli" : "sonli");
    const webHost = runtime.webHost || (/__BRAND/.test("qh.jizhangerp.com") ? "store.jizhangerp.com" : "qh.jizhangerp.com");
    return {
      displayName,
      webHost,
      primaryColor: runtime.primaryColor || "#2168ff",
      logoUrl: runtime.logoUrl || null,
    };
  }

  function iconSvg(name) {
    const paths = {
      image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-4.2-4.2a2 2 0 0 0-2.8 0L5 19"/>',
      box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
      upload: '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.box}</svg>`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }

  function firstImage(raw) {
    if (!raw) return null;
    const images = Array.isArray(raw.images)
      ? raw.images
      : Array.isArray(raw.mainImages)
        ? raw.mainImages
        : [];
    return images[0] || raw.image || null;
  }

  function platformDebug(platform) {
    return {
      sourceId: platform?.sourceId || null,
      displayName: platform?.displayName || null,
    };
  }

  function readDebugPayload(platform, buildPayload) {
    try {
      return {
        platform: platformDebug(platform),
        href: location.href,
        raw: buildPayload(),
      };
    } catch (error) {
      return {
        platform: platformDebug(platform),
        href: location.href,
        raw: null,
        error: error?.message || String(error),
      };
    }
  }

  function exposePageDebugBridge(platform, buildPayload) {
    window.__JZC_CN_SOURCE_DEBUG__ = () => readDebugPayload(platform, buildPayload);

    if (!window.__JZC_CN_SOURCE_DEBUG_BRIDGE__) {
      window.__JZC_CN_SOURCE_DEBUG_BRIDGE__ = true;
      window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data.source !== DEBUG_PAGE_SOURCE || data.type !== DEBUG_REQUEST_TYPE) return;
        window.postMessage({
          source: DEBUG_BRIDGE_SOURCE,
          type: DEBUG_RESPONSE_TYPE,
          requestId: data.requestId,
          payload: readDebugPayload(platform, buildPayload),
        }, "*");
      });
    }

    if (document.getElementById("jzc-cn-source-debug-bridge-script")) return;
    const scriptUrl = chrome.runtime?.getURL?.("lib/cn-source-debug-page.js");
    if (!scriptUrl) return;
    const script = document.createElement("script");
    script.id = "jzc-cn-source-debug-bridge-script";
    script.src = scriptUrl;
    (document.documentElement || document.head || document.body)?.appendChild(script);
    script.onload = () => script.remove();
    script.onerror = () => script.remove();
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: "no response" });
        });
      } catch (error) {
        resolve({ ok: false, error: error?.message || String(error) });
      }
    });
  }

  function toUserFacingRuntimeError(message) {
    const text = String(message || "");
    if (/Extension context invalidated|context invalidated/i.test(text)) {
      return "扩展已重新加载，当前商品页还是旧脚本。请刷新当前商品页后再点手动上架。";
    }
    if (/Receiving end does not exist|message port closed/i.test(text)) {
      return "扩展后台刚刚重启，当前商品页连接已断开。请刷新当前商品页后重试。";
    }
    return text;
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  async function copyImageToClipboard(url) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
    try {
      const resp = await fetch(url, { mode: "cors", credentials: "omit" });
      if (!resp.ok) return false;
      let blob = await resp.blob();
      if (!blob.type || blob.type === "image/jpeg" || blob.type === "image/webp") {
        blob = await convertImageBlobToPng(blob).catch(() => blob);
      }
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      return true;
    } catch {
      return false;
    }
  }

  async function convertImageBlobToPng(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return await new Promise((resolve, reject) => {
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("canvas toBlob failed"))), "image/png");
    });
  }

  function injectStyles(brand) {
    if (document.getElementById("jzc-cn-source-panel-style")) return;
    const style = document.createElement("style");
    style.id = "jzc-cn-source-panel-style";
    style.textContent = `
      #jzc-cn-source-panel {
        position: fixed;
        right: 24px;
        bottom: 72px;
        z-index: 2147483647;
        width: 220px;
        color: #07142f;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }
      #jzc-cn-source-panel, #jzc-cn-source-panel * { box-sizing: border-box; }
      #jzc-cn-source-panel .jzc-cn-card {
        position: relative;
        padding: 14px;
        border: 1px solid rgba(231, 236, 246, 0.96);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.16), 0 2px 7px rgba(15, 23, 42, 0.08);
        backdrop-filter: blur(10px);
      }
      #jzc-cn-source-panel .jzc-cn-brand {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 32px;
        padding: 4px 4px 10px;
        cursor: grab;
        user-select: none;
      }
      #jzc-cn-source-panel .jzc-cn-logo {
        display: inline-flex;
        width: 32px;
        height: 32px;
        flex: 0 0 32px;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        border-radius: 8px;
        background: ${brand.primaryColor};
        color: #fff;
        font-size: 15px;
        font-weight: 900;
        line-height: 1;
      }
      #jzc-cn-source-panel .jzc-cn-logo img { width: 100%; height: 100%; object-fit: cover; }
      #jzc-cn-source-panel .jzc-cn-name {
        font-size: 15px;
        font-weight: 700;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #jzc-cn-source-panel .jzc-cn-divider { height: 1px; margin: 0 0 8px; background: #e4eaf5; }
      #jzc-cn-source-panel .jzc-cn-action {
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
      #jzc-cn-source-panel .jzc-cn-action:hover {
        transform: translateY(-1px);
        background: #eef3fb;
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.08);
      }
      #jzc-cn-source-panel .jzc-cn-action.is-primary {
        border-color: ${brand.primaryColor};
        background: #eaf1ff;
        color: ${brand.primaryColor};
      }
      #jzc-cn-source-panel .jzc-cn-action:disabled { cursor: wait; opacity: 0.78; transform: none; box-shadow: none; }
      #jzc-cn-source-panel .jzc-cn-action-icon {
        display: inline-flex;
        width: 16px;
        height: 16px;
        flex: 0 0 16px;
        align-items: center;
        justify-content: center;
        color: ${brand.primaryColor};
      }
      #jzc-cn-source-panel .jzc-cn-action-icon svg { width: 16px; height: 16px; }
      #jzc-cn-source-panel .jzc-cn-action-label {
        min-width: 0;
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 600;
      }
      #jzc-cn-source-panel .jzc-cn-hot {
        flex: 0 0 auto;
        padding: 1.5px 6px;
        border-radius: 8px;
        background: #ff5b5b;
        color: #fff;
        font-size: 9px;
        font-weight: 800;
        line-height: 1.4;
      }
      #jzc-cn-source-panel .jzc-cn-collapse {
        margin-left: auto;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 7px;
        color: #90a0bd;
        font-size: 17px;
        font-weight: 800;
        line-height: 1;
        cursor: pointer;
        flex: 0 0 24px;
      }
      #jzc-cn-source-panel .jzc-cn-collapse:hover { background: #eef2f8; color: #0f1f3d; }
      #jzc-cn-source-panel.jzc-collapsed { width: 54px !important; }
      #jzc-cn-source-panel.jzc-collapsed .jzc-cn-card { display: none; }
      #jzc-cn-source-panel .jzc-cn-ball {
        display: none;
        width: 54px;
        height: 54px;
        border-radius: 16px;
        background: ${brand.primaryColor};
        color: #fff;
        align-items: center;
        justify-content: center;
        font-size: 23px;
        font-weight: 900;
        cursor: grab;
        overflow: hidden;
        box-shadow: 0 12px 30px rgba(15,23,42,.28);
      }
      #jzc-cn-source-panel.jzc-collapsed .jzc-cn-ball { display: flex; }
      #jzc-cn-source-panel .jzc-cn-ball img { width: 100%; height: 100%; object-fit: cover; }
      @media (max-width: 720px) {
        #jzc-cn-source-panel { right: 12px; bottom: 18px; width: min(220px, calc(100vw - 24px)); }
      }
    `;
    document.head.appendChild(style);
  }

  function showToast(text, kind = "info") {
    const id = "jzc-cn-source-toast";
    document.getElementById(id)?.remove();
    const el = document.createElement("div");
    el.id = id;
    el.textContent = text;
    Object.assign(el.style, {
      position: "fixed",
      right: "24px",
      bottom: window.innerWidth <= 720 ? "304px" : "360px",
      zIndex: "2147483647",
      padding: "10px 14px",
      borderRadius: "8px",
      background: kind === "error" ? "#DC2626" : kind === "ok" ? "#16A34A" : "#1F2937",
      color: "#fff",
      fontSize: "13px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      maxWidth: "300px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function setActionBusy(action, busy, busyText) {
    const btn = document.querySelector(`#jzc-cn-source-panel [data-action="${action}"]`);
    if (!btn) return;
    const label = btn.querySelector(".jzc-cn-action-label");
    btn.disabled = busy;
    if (label) label.textContent = busy ? busyText : (btn.dataset.label || label.textContent);
  }

  function setupFloat(root, key) {
    const storageKey = `jzc_cn_source_float_${key}`;
    try {
      const state = JSON.parse(localStorage.getItem(storageKey) || "{}");
      if (typeof state.left === "number") {
        root.style.left = `${state.left}px`;
        root.style.top = `${state.top}px`;
        root.style.right = "auto";
        root.style.bottom = "auto";
      }
      if (state.collapsed) root.classList.add("jzc-collapsed");
    } catch {}

    function save(patch) {
      let state = {};
      try { state = JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch {}
      Object.assign(state, patch);
      try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch {}
    }

    function collapse(on) {
      root.classList.toggle("jzc-collapsed", on);
      save({ collapsed: on });
    }

    function clamp(x, y) {
      const w = root.offsetWidth;
      const h = root.offsetHeight;
      return [
        Math.max(6, Math.min(x, window.innerWidth - w - 6)),
        Math.max(6, Math.min(y, window.innerHeight - h - 6)),
      ];
    }

    function startDrag(event) {
      if (event.button !== 0) return;
      const rect = root.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      let moved = false;
      root.__dragMoved = false;
      const move = (ev) => {
        if (Math.abs(ev.clientX - event.clientX) + Math.abs(ev.clientY - event.clientY) > 4) moved = true;
        const [x, y] = clamp(ev.clientX - offsetX, ev.clientY - offsetY);
        root.style.left = `${x}px`;
        root.style.top = `${y}px`;
        root.style.right = "auto";
        root.style.bottom = "auto";
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        root.__dragMoved = moved;
        if (moved) {
          const next = root.getBoundingClientRect();
          save({ left: Math.round(next.left), top: Math.round(next.top) });
        }
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    }

    root.querySelector(".jzc-cn-brand")?.addEventListener("mousedown", startDrag);
    root.querySelector(".jzc-cn-ball")?.addEventListener("mousedown", startDrag);
    root.querySelector(".jzc-cn-ball")?.addEventListener("click", () => {
      if (!root.__dragMoved) collapse(false);
    });
    root.querySelector('[data-action="collapse"]')?.addEventListener("click", () => collapse(true));
  }

  async function openCollectEditor(itemId, brand) {
    const path = itemId
      ? `/ozon/products/collect/edit?id=${encodeURIComponent(itemId)}`
      : "/ozon/products/collect";
    const openResp = await sendRuntimeMessage({ action: "openFrontend", path });
    if (openResp?.ok) return;

    const frontendUrl = "http://127.0.0.1:5173";
    window.open(`${frontendUrl}${path}`, "_blank");
  }

  function mount({ platform, buildPayload }) {
    if (!platform?.sourceId || typeof buildPayload !== "function") return;
    if (document.getElementById("jzc-cn-source-panel")) return;
    const brand = getBrand();
    injectStyles(brand);

    exposePageDebugBridge(platform, buildPayload);

    const root = document.createElement("div");
    root.id = "jzc-cn-source-panel";
    const logo = brand.logoUrl
      ? `<span class="jzc-cn-logo"><img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.displayName)}"></span>`
      : `<span class="jzc-cn-logo">${escapeHtml((brand.displayName || "sonli").slice(0, 1))}</span>`;
    const ball = brand.logoUrl
      ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.displayName)}">`
      : escapeHtml((brand.displayName || "sonli").slice(0, 1));
    root.innerHTML = `
      <div class="jzc-cn-card">
        <div class="jzc-cn-brand">
          ${logo}
          <span class="jzc-cn-name">${escapeHtml(brand.displayName || "sonli")}</span>
          <span class="jzc-cn-collapse" data-action="collapse" title="收起">—</span>
        </div>
        <div class="jzc-cn-divider"></div>
        <button class="jzc-cn-action" type="button" data-action="copy-image" data-label="复制图片">
          <span class="jzc-cn-action-icon">${iconSvg("image")}</span>
          <span class="jzc-cn-action-label">复制图片</span>
        </button>
        <button class="jzc-cn-action" type="button" data-action="collect-product" data-label="采集商品">
          <span class="jzc-cn-action-icon">${iconSvg("box")}</span>
          <span class="jzc-cn-action-label">采集商品</span>
        </button>
        <button class="jzc-cn-action is-primary" type="button" data-action="manual-listing" data-label="手动上架">
          <span class="jzc-cn-action-icon">${iconSvg("upload")}</span>
          <span class="jzc-cn-action-label">手动上架</span>
          <span class="jzc-cn-hot">HOT</span>
        </button>
      </div>
      <div class="jzc-cn-ball" title="展开${escapeHtml(brand.displayName || "sonli")}">${ball}</div>
    `;

    async function collectCurrentProduct(options = {}) {
      let raw;
      try {
        raw = buildPayload();
      } catch (error) {
        log("buildPayload error:", error);
        throw error;
      }
      if (!raw) {
        log("payload missing:", { platform: platformDebug(platform), href: location.href });
        throw new Error(`未能识别${platform.displayName || "当前平台"}商品信息`);
      }
      log("payload:", raw);
      const resp = await sendRuntimeMessage({
        action: "pushSourceCollect",
        sourceId: platform.sourceId,
        raw,
        forceResubmit: !!options.forceResubmit,
        resetDraft: !!options.resetDraft,
      });
      log("resp:", resp);
      if (!resp?.ok) {
        log("error:", resp?.error || resp);
        throw new Error(toUserFacingRuntimeError(resp?.error || "未知错误"));
      }
      const data = resp.data || {};
      return { dedupeHit: !!data.dedupeHit, result: data.result || {} };
    }

    root.addEventListener("click", async (event) => {
      const btn = event.target?.closest?.("[data-action]");
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action;
      if (action === "collapse") return;
      if (action === "copy-image") {
        setActionBusy(action, true, "复制中...");
        try {
          const image = firstImage(buildPayload());
          if (!image) throw new Error("当前页面还没有识别到商品图片");
          let copiedLink = false;
          try {
            await copyTextToClipboard(image);
            copiedLink = true;
          } catch {}
          const copiedImage = await copyImageToClipboard(image);
          showToast(copiedImage ? "已复制商品主图" : copiedLink ? "已复制图片链接" : "浏览器拒绝写入剪贴板", copiedImage || copiedLink ? "ok" : "error");
        } catch (error) {
          showToast(`复制图片失败：${error?.message || String(error)}`, "error");
        } finally {
          setActionBusy(action, false);
        }
      }
      if (action === "collect-product") {
        setActionBusy(action, true, "采集中...");
        try {
          const { dedupeHit, result } = await collectCurrentProduct();
          showToast(dedupeHit ? "24h 内已采集过，跳过重复入库" : `已${result.action === "updated" ? "更新" : "加入"}采集箱`, "ok");
        } catch (error) {
          log("collect error:", error);
          showToast(`采集失败：${error?.message || String(error)}`, "error");
        } finally {
          setActionBusy(action, false);
        }
      }
      if (action === "manual-listing") {
        setActionBusy(action, true, "准备上架...");
        try {
          const { result } = await collectCurrentProduct({ forceResubmit: true, resetDraft: true });
          await openCollectEditor(result?.id, brand);
          showToast("已采集，正在打开编辑上架页", "ok");
        } catch (error) {
          log("manual listing error:", error);
          showToast(`手动上架失败：${error?.message || String(error)}`, "error");
        } finally {
          setActionBusy(action, false);
        }
      }
    });

    document.body.appendChild(root);
    setupFloat(root, platform.sourceId);
  }

  window.JZCnSourcePanel = { mount };
})();
