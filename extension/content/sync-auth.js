/**
 * sync-auth.js — Injected on jizhangerp.com and localhost:3000
 * Two-way token bridge between frontend localStorage and extension chrome.storage.
 *
 *   - Web → Extension: on load / on localStorage change, push token to chrome.storage.
 *   - Extension → Web: on load, if Web has no token but extension does,
 *     restore it to localStorage and reload so the React app boots logged in.
 *
 * Scenario fix: clicking "查看" in popup opens an ERP page; previously the
 * empty-web-token was reported back and the extension cleared its own token,
 * logging the user out of the extension too.
 *
 * v3 fingerprint(2026-05-27 起):同时把 web 算出的 v3 machine fingerprint
 * 推给 SW。SW 自己没 DOM 算不出 screen 维度,被动接收 web/popup 算的同一份
 * v3 fingerprint,保证 "同台机器 = 1 fingerprint = 1 设备名额"。
 */
(() => {
  const sendToExtension = (payload) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, (resp) => resolve(resp));
    } catch {
      resolve(null);
    }
  });

  // 跟 frontend/lib/device-fingerprint.ts + extension/popup/popup.js 严格对齐
  // (任何调整这 3 处都得一起改,否则同机算不到同一个 hash)。
  function getMachineFingerprintV3() {
    try {
      const cached = localStorage.getItem('deviceFingerprint_v3');
      if (cached) return cached;
    } catch {}
    const screenInfo = window.screen
      ? [window.screen.width, window.screen.height, window.screen.colorDepth].join('x')
      : 'unknown-screen';
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown-tz';
    const language = navigator.language || 'unknown-lang';
    const platform = `${navigator.userAgentData?.platform || navigator.platform || ''} ${navigator.userAgent || ''}`;
    const osBucket = /mac/i.test(platform) ? 'mac'
      : /win/i.test(platform) ? 'windows'
      : /android/i.test(platform) ? 'android'
      : /iphone|ipad|ios/i.test(platform) ? 'ios'
      : /linux/i.test(platform) ? 'linux'
      : 'unknown-os';
    const raw = [
      'jizhang-machine-v3',
      osBucket,
      screenInfo,
      timeZone,
      language,
      navigator.hardwareConcurrency || 0,
    ].join('|');
    let h1 = 0x811c9dc5, h2 = 0x1b873593;
    for (let i = 0; i < raw.length; i++) {
      h1 = (h1 ^ raw.charCodeAt(i)) >>> 0;
      h1 = Math.imul(h1, 0x01000193);
      h2 = (h2 ^ raw.charCodeAt(i)) >>> 0;
      h2 = Math.imul(h2, 0xcc9e2d51);
    }
    return `machine-v3-${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`;
  }

  // 启动时推一次给 SW(token 还没同步也无所谓,fingerprint 跟 token 解耦)
  try {
    sendToExtension({
      action: 'setMachineFingerprint',
      deviceFingerprint: getMachineFingerprintV3(),
    });
  } catch {}

  const pushWebToExtension = () => {
    const token = localStorage.getItem('token');
    const storeId = localStorage.getItem('currentOzonStoreId');
    sendToExtension({
      action: 'syncAuthFromWeb',
      token: token || null,
      storeId: storeId || null,
    });
  };

  const restoreFromExtension = async () => {
    const resp = await sendToExtension({ action: 'getAuth' });
    const auth = resp?.data || null;
    if (!auth?.token) return false;

    // Write extension's token into frontend localStorage so the app boots logged in.
    localStorage.setItem('token', auth.token);
    if (auth.storeId) {
      localStorage.setItem('currentOzonStoreId', auth.storeId);
    }
    return true;
  };

  const RESTORE_GUARD_KEY = 'ozonHelperRestoredOnce';

  // 网页主动登出标记(由 frontend clearAuthAndNotifyExtension 写入)。跳转到
  // /login 后 token 已空,无法跟"未登录的新 tab"区分,靠这个标记表达"这是
  // 一次主动登出" → 清扩展 token,且绝不反向 restore。带 TTL 防残留误触发。
  const LOGOUT_SIGNAL_KEY = 'jz_logout_signal';
  const LOGOUT_SIGNAL_TTL_MS = 15000;

  const consumeLogoutSignal = () => {
    let raw = null;
    try {
      raw = localStorage.getItem(LOGOUT_SIGNAL_KEY);
      if (raw) localStorage.removeItem(LOGOUT_SIGNAL_KEY);
    } catch {
      return false;
    }
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    const age = Date.now() - ts;
    // age<0 = 未来时间戳(时钟回拨/异常),不当作有效登出标记。
    return age >= 0 && age <= LOGOUT_SIGNAL_TTL_MS;
  };

  const init = async () => {
    const webToken = localStorage.getItem('token');
    if (webToken) {
      // 已登录页:清掉可能残留的登出标记(防"登出→秒重登"窗口内误触发登出),
      // 再正常把 token 转发给扩展(切店铺时同步 storeId)。
      try { localStorage.removeItem(LOGOUT_SIGNAL_KEY); } catch {}
      pushWebToExtension();
      return;
    }

    // 未登录 + 有效登出标记 → 这是一次主动登出:让扩展也登出,且绝不反向 restore。
    if (consumeLogoutSignal()) {
      sendToExtension({ action: 'logout' });
      return;
    }

    // Guard against reload loops when the extension token is also expired
    // (Web will 401 → clear localStorage → sync-auth would restore + reload forever).
    if (sessionStorage.getItem(RESTORE_GUARD_KEY)) {
      return;
    }

    // Web is unauthenticated — try to restore from extension before the app
    // redirects to /login.
    const restored = await restoreFromExtension();
    if (restored) {
      sessionStorage.setItem(RESTORE_GUARD_KEY, '1');
      console.log('[sync-auth] Restored token from extension, reloading page');
      location.reload();
    }
  };

  init();

  // 同 tab 立即登出:frontend 登出时同步派发此事件(content script 与页面
  // 共享 window 事件总线),不依赖页面跳转,先于 navigation 通知扩展。
  window.addEventListener('jizhang-erp:logout', () => {
    sendToExtension({ action: 'logout' });
  });

  // Keep pushing Web → Extension on login/logout in another tab.
  window.addEventListener('storage', (e) => {
    // 另一 tab 主动登出 → 本桥也通知扩展登出。
    if (e.key === LOGOUT_SIGNAL_KEY && e.newValue) {
      sendToExtension({ action: 'logout' });
      return;
    }
    if (e.key === 'token' || e.key === 'currentOzonStoreId') {
      pushWebToExtension();
    }
  });

  // ── Web ↔ Extension postMessage bridge ─────────────────────────────
  // 前端 web page 不知道 extension ID，无法直接 chrome.runtime.sendMessage(ID, ...)。
  // 所以让 web page 用 window.postMessage 发，content script 转发给 background。
  // 协议：req `{ __jzcExt: 1, id, action, payload }` → resp `{ __jzcExtResp: 1, id, ok, data, error }`
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__jzcExt !== 1 || !data.id || !data.action) return;
    chrome.runtime.sendMessage(
      { action: data.action, ...(data.payload || {}) },
      (resp) => {
        const err = chrome.runtime.lastError?.message;
        window.postMessage(
          {
            __jzcExtResp: 1,
            id: data.id,
            ok: !err && resp?.ok !== false,
            data: resp?.data,
            error: err || resp?.error,
          },
          '*',
        );
      },
    );
  });
})();
