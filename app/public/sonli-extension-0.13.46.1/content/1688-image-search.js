/**
 * 1688-image-search.js — 注入到 1688（s.1688.com / www.1688.com）。
 *
 * 用途：用户在 Ozon 商品页点"1688找货源"按钮时，极掌跳转到
 * `https://s.1688.com/youyuan/index.htm?tab=imageSearch&__jzcOzonImg=<encoded ozon image url>`
 * 本脚本读取 __jzcOzonImg 参数 → 让 background 代理 fetch ozon 图片（避开 CORS）
 * → 把 blob 通过 DataTransfer 注入到 1688 自身的 file input → dispatch change 事件
 * → 触发 1688 原生的"以图搜款"流程。
 *
 * 等同于用户手动点击"以图搜款"按钮选了 ozon 图片，但全程自动。
 */

(() => {
  const PARAM = '__jzcOzonImg';
  const FILE_INPUT_SELECTOR = 'input#img-search-upload, input[type="file"][accept*="image"]';
  const SAVED_KEY = '__jzcLast1688AutoUpload';
  const BRIDGE_REQUEST_SOURCE = 'jzc-1688-image-search';
  const BRIDGE_RESPONSE_SOURCE = 'jzc-1688-image-search-main';
  const BRIDGE_REQUEST_TYPE = 'JZC_1688_UPLOAD_IMAGE_ID';
  const BRIDGE_RESPONSE_TYPE = 'JZC_1688_UPLOAD_IMAGE_ID_RESULT';
  const IMAGE_ID_RETRY_TOTAL_MS = 10000;
  const IMAGE_ID_ATTEMPT_TIMEOUT_MS = 1000;
  const IMAGE_ID_RETRY_DELAY_MS = 150;

  const getOzonImgFromUrl = () => {
    try {
      const u = new URL(location.href);
      return u.searchParams.get(PARAM);
    } catch {
      return null;
    }
  };

  /** 用 background fetch 拉 ozon 图（绕过页面 CORS），返回 base64 dataURL */
  const proxyFetch = (url) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'proxyImageFetch', url }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false, error: 'no response' });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message || String(e) });
    }
  });

  const dataUrlToFile = (dataUrl, name) => {
    const [meta, b64] = dataUrl.split(',');
    const mime = (meta.match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const ext = mime.split('/')[1] || 'jpg';
    return new File([buf], `${name}.${ext}`, { type: mime });
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const requestImageIdAttemptFromPage = (dataUrl, attempt, timeoutMs) => new Promise((resolve) => {
    if (!dataUrl || typeof window.postMessage !== 'function') {
      resolve(null);
      return;
    }

    const requestId = `${Date.now()}-${attempt}-${Math.random().toString(36).slice(2)}`;
    let done = false;
    const finish = (imageId) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(imageId || null);
    };
    const onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data || {};
      if (data.source !== BRIDGE_RESPONSE_SOURCE || data.type !== BRIDGE_RESPONSE_TYPE) return;
      if (data.requestId !== requestId) return;
      if (!data.ok || !data.imageId) {
        console.warn('[jzc-1688] imageId bridge attempt failed:', { attempt, error: data.error || 'empty imageId' });
        finish(null);
        return;
      }
      finish(String(data.imageId));
    };
    const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));

    window.addEventListener('message', onMessage);
    window.postMessage({
      source: BRIDGE_REQUEST_SOURCE,
      type: BRIDGE_REQUEST_TYPE,
      requestId,
      attempt,
      dataUrl,
    }, '*');
  });

  const requestImageIdFromPage = async (dataUrl) => {
    const deadline = Date.now() + IMAGE_ID_RETRY_TOTAL_MS;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt += 1;
      const timeoutMs = Math.min(IMAGE_ID_ATTEMPT_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
      if (timeoutMs <= 0) break;

      const imageId = await requestImageIdAttemptFromPage(dataUrl, attempt, timeoutMs);
      if (imageId) return imageId;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= IMAGE_ID_RETRY_DELAY_MS) break;
      await wait(Math.min(IMAGE_ID_RETRY_DELAY_MS, remainingMs));
    }

    return null;
  };
  const navigateToImageIdResult = (imageId) => {
    if (!imageId) return false;
    try {
      const url = new URL(location.href);
      url.searchParams.set('tab', 'imageSearch');
      url.searchParams.set('imageId', imageId);
      url.searchParams.set('imageIdList', imageId);
      url.searchParams.delete(PARAM);
      location.href = url.href;
      return true;
    } catch (e) {
      console.warn('[jzc-1688] imageId navigation failed:', (e && e.message) || e);
      return false;
    }
  };

  const waitForFileInput = () => new Promise((resolve) => {
    const found = document.querySelector(FILE_INPUT_SELECTOR);
    if (found) return resolve(found);
    const obs = new MutationObserver(() => {
      const el = document.querySelector(FILE_INPUT_SELECTOR);
      if (el) {
        obs.disconnect();
        resolve(el);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // 兜底：15 秒超时
    setTimeout(() => { obs.disconnect(); resolve(document.querySelector(FILE_INPUT_SELECTOR)); }, 15000);
  });

  /**
   * 上传成功后 1688 会弹出"帮你找同款"小卡片，里面有橙色的"搜索图片"按钮。
   * 必须再点一下才会真正跳到结果页。等到该按钮出现就自动 click。
   */
  const waitAndClickSearchButton = () => new Promise((resolve) => {
    const normalizeText = (el) => (el.textContent || '').replace(/\s+/g, '').trim();
    const isVisible = (el) => {
      if (!(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const hasReachedResult = () => {
      try {
        return new URL(location.href).searchParams.has('imageId');
      } catch {
        return false;
      }
    };
    const clickableSelector =
      'button, a, [role="button"], [onclick], [tabindex], [class*="button"], [class*="Button"], [class*="btn"], [class*="Btn"]';

    const findSearchImageButton = () => {
      const preciseSelectors = [
        '.copy-image-container .search-btn',
        '[data-tracker="pasteImagePreview"]',
        '[data-trackercn="粘贴图片预览"]',
        '.search-btn',
      ];
      for (const selector of preciseSelectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (isVisible(el)) return el;
        }
      }

      const clickableCandidates = Array.from(document.querySelectorAll(clickableSelector))
        .map((el) => ({ el, text: normalizeText(el) }))
        .filter(({ el, text }) => text === '搜索图片' && isVisible(el))
        .sort((a, b) => {
          const aScore = a.el.closest('.copy-image-container') ? 0 : 1;
          const bScore = b.el.closest('.copy-image-container') ? 0 : 1;
          return aScore - bScore;
        });

      for (const { el } of clickableCandidates) return el;

      const textCandidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
        .map((el) => ({ el, text: normalizeText(el) }))
        .filter(({ el, text }) => text === '搜索图片' && isVisible(el));

      for (const { el } of textCandidates) {
        const clickable = el.closest(clickableSelector) || el;
        if (isVisible(clickable)) return clickable;
      }
      return null;
    };

    const clickButton = (btn) => {
      try {
        btn.scrollIntoView({ block: 'center', inline: 'center' });
      } catch {}
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((ev) => {
        const EventCtor = ev.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        btn.dispatchEvent(new EventCtor(ev, { bubbles: true, cancelable: true, view: window, button: 0 }));
      });
      if (typeof btn.click === 'function') {
        btn.click();
      } else {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 }));
      }
    };

    let done = false;
    let clickCount = 0;
    let lastClickAt = 0;
    const startedAt = Date.now();
    const finish = (result) => {
      if (done) return;
      done = true;
      obs.disconnect();
      clearInterval(timer);
      if (!result) console.warn('[jzc-1688] search image button did not open result');
      resolve(result);
    };
    const attempt = () => {
      if (hasReachedResult()) return finish(true);
      if (Date.now() - startedAt > 20000) return finish(false);
      const btn = findSearchImageButton();
      if (!btn) return false;
      const now = Date.now();
      if (now - lastClickAt < 800) return true;
      lastClickAt = now;
      clickCount += 1;
      clickButton(btn);
      console.info('[jzc-1688] search image button clicked', { clickCount });
      return true;
    };

    const obs = new MutationObserver(() => {
      attempt();
    });
    const timer = setInterval(() => {
      attempt();
    }, 800);
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'disabled', 'aria-disabled'],
      characterData: true,
    });
    attempt();
    setTimeout(() => finish(hasReachedResult() || clickCount > 0), 22000);
  });

  const inject = async (ozonUrl) => {
    // 防重复执行（同 SPA 路由切换不再触发）
    try {
      const last = sessionStorage.getItem(SAVED_KEY);
      if (last === ozonUrl) return;
      sessionStorage.setItem(SAVED_KEY, ozonUrl);
    } catch {}

    const resp = await proxyFetch(ozonUrl);
    if (!resp?.ok || !resp.dataUrl) {
      console.warn('[jzc-1688] proxyFetch failed:', resp?.error);
      return;
    }
    const imageId = await requestImageIdFromPage(resp.dataUrl);
    if (imageId && navigateToImageIdResult(imageId)) return;

    const file = dataUrlToFile(resp.dataUrl, 'ozon');
    const input = await waitForFileInput();
    if (!input) {
      console.warn('[jzc-1688] file input not found');
      return;
    }
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      console.warn('[jzc-1688] inject failed:', e);
      return;
    }
    // 等"搜索图片"按钮出现 + 自动点击（无此步只显示上传 popover，搜索结果不刷新）
    await waitAndClickSearchButton();
  };

  const ozonUrl = getOzonImgFromUrl();
  if (ozonUrl) inject(ozonUrl);
})();
