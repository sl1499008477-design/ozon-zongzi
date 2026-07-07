/**
 * Content script injected into seller.ozon.ru pages.
 *
 * Bridges the service worker and seller.ozon.ru API by fetching directly
 * from the content script. Content scripts are not subject to the page's
 * CSP, and the extension's host_permissions grant access to seller.ozon.ru,
 * so cookies are sent automatically with credentials: 'include'.
 *
 * Flow:
 *   service-worker  →  chrome.tabs.sendMessage  →  this content script
 *   this script     →  fetch (with cookies)      →  seller.ozon.ru API
 *   this script     →  sendResponse              →  service-worker
 */

(() => {
  // ── Bestsellers 类目映射 relay ──────────────────────────────
  // page-world hook（content/ozon-bestsellers-hook.js）通过 window.postMessage 上报
  // {name, leafIds}，这里转发给 service worker → 极掌后端入库。
  //
  // ── Premium 透视眼 storage 同步 relay ─────────────────────
  // page-world hook（content/ozon-premium-hook.js）通过 window.postMessage 询问
  // 开关状态 / 请求切换 / 持久化面板位置；这里跟 chrome.storage.local 对接。
  // chrome.storage.onChanged 事件再反传给 main-world hook（来自 popup / 别的 tab
  // 切换开关时本 tab 也要同步）。
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__jzcReport !== 1) return;

    // 老逻辑：bestsellers 类目映射上报
    if (d.type === 'JZC_BESTSELLERS_REPORT') {
      const { name, leafIds, source } = d;
      if (!name || !Array.isArray(leafIds) || leafIds.length === 0) return;
      try {
        chrome.runtime.sendMessage({
          action: 'reportCategoryMapping',
          name,
          leafIds,
          source: source || 'bestsellers-hook',
        });
      } catch {
        // SW 未唤醒等场景静默忽略
      }
      return;
    }

    // 透视眼：拉初值
    if (d.type === 'JZC_PREMIUM_QUERY') {
      try {
        chrome.storage.local.get(
          ['ozon_premium_enabled', 'ozon_premium_panel_pos'],
          ({ ozon_premium_enabled, ozon_premium_panel_pos }) => {
            window.postMessage(
              { __jzcReport: 1, type: 'JZC_PREMIUM_TOGGLE', enabled: !!ozon_premium_enabled },
              '*',
            );
            if (ozon_premium_panel_pos) {
              window.postMessage(
                {
                  __jzcReport: 1,
                  type: 'JZC_PREMIUM_PANEL_POS_RESTORE',
                  pos: ozon_premium_panel_pos,
                },
                '*',
              );
            }
          },
        );
      } catch {}
      return;
    }

    // 透视眼：浮动面板内 toggle 触发切换
    if (d.type === 'JZC_PREMIUM_REQUEST_TOGGLE') {
      try {
        chrome.storage.local.set({ ozon_premium_enabled: !!d.next });
      } catch {}
      return;
    }

    // 透视眼：浮动面板拖动后持久化位置
    if (d.type === 'JZC_PREMIUM_PANEL_POS' && d.pos) {
      try {
        chrome.storage.local.set({ ozon_premium_panel_pos: d.pos });
      } catch {}
      return;
    }
  });

  // 启动时主动广播一次（针对 main-world hook 注入早于 bridge 启动的场景，
  // 它的 JZC_PREMIUM_QUERY 可能在 bridge 监听器装好之前就发了）
  try {
    chrome.storage.local.get(
      ['ozon_premium_enabled', 'ozon_premium_panel_pos'],
      ({ ozon_premium_enabled, ozon_premium_panel_pos }) => {
        window.postMessage(
          { __jzcReport: 1, type: 'JZC_PREMIUM_TOGGLE', enabled: !!ozon_premium_enabled },
          '*',
        );
        if (ozon_premium_panel_pos) {
          window.postMessage(
            {
              __jzcReport: 1,
              type: 'JZC_PREMIUM_PANEL_POS_RESTORE',
              pos: ozon_premium_panel_pos,
            },
            '*',
          );
        }
      },
    );
  } catch {}

  // 监听 storage 变化（来自 popup / 别 tab）→ 推送给本 tab 的 main-world hook
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.ozon_premium_enabled) {
        window.postMessage(
          {
            __jzcReport: 1,
            type: 'JZC_PREMIUM_TOGGLE',
            enabled: !!changes.ozon_premium_enabled.newValue,
          },
          '*',
        );
      }
      if (changes.ozon_premium_panel_pos) {
        window.postMessage(
          {
            __jzcReport: 1,
            type: 'JZC_PREMIUM_PANEL_POS_RESTORE',
            pos: changes.ozon_premium_panel_pos.newValue,
          },
          '*',
        );
      }
    });
  } catch {}

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'sellerPortalFetch') return false;

    const { apiPath, reqBody, fallbackCompanyId, timeoutMs } = message;
    // 兼容新调用：可选 urlPrefix / pageType；缺省退回原跟卖默认值
    const urlPrefix = message.urlPrefix !== undefined ? message.urlPrefix : '/api/v1';
    const pageType = message.pageType || 'products-other';

    (async () => {
      try {
        // Read sc_company_id from document.cookie, fall back to service worker value
        const companyId = document.cookie.split(';')
          .map(c => c.trim())
          .find(c => c.startsWith('sc_company_id='))
          ?.split('=')[1] || fallbackCompanyId || '';

        if (!companyId) {
          sendResponse({ ok: false, error: 'sc_company_id cookie 未找到，请确保已登录 seller.ozon.ru' });
          return;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const resp = await fetch('https://seller.ozon.ru' + urlPrefix + apiPath, {
            method: 'POST',
            signal: controller.signal,
            credentials: 'include',
            headers: {
              'accept': 'application/json, text/plain, */*',
              'content-type': 'application/json',
              'x-o3-app-name': 'seller-ui',
              'x-o3-company-id': companyId,
              'x-o3-language': 'zh-Hans',
              'x-o3-page-type': pageType,
            },
            body: JSON.stringify(reqBody),
          });
          clearTimeout(timer);

          // Handle redirects (login expired)
          if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
            sendResponse({ ok: false, status: 401, code: 'AUTH_REDIRECT', error: 'Seller portal cookie已过期，请重新登录' });
            return;
          }

          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            // codex review MEDIUM 修复 — 与 service-worker.doFetch 对齐:把 status 和
            // 响应体 code 单独抠出来传出去,让 background 的 makeStructuredError
            // 能识别 404 ResourceNotFound 当 bridge 是唯一可用 strategy 时也降级。
            let parsedCode = '';
            try {
              const json = JSON.parse(text);
              parsedCode = (json && (json.code || (json.error && json.error.code))) || '';
            } catch {}
            sendResponse({
              ok: false,
              status: resp.status,
              code: parsedCode,
              error: `Seller portal 请求失败 (${resp.status}): ${text.slice(0, 200)}`,
            });
            return;
          }

          const result = await resp.json();
          sendResponse({ ok: true, data: result });
        } catch (e) {
          clearTimeout(timer);
          if (e.name === 'AbortError') {
            sendResponse({ ok: false, error: `Seller portal 请求超时 (${timeoutMs}ms)` });
          } else {
            throw e;
          }
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();

    return true; // async sendResponse
  });
})();
