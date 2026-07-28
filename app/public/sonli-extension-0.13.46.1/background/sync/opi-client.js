/**
 * extension/background/sync/opi-client.js
 *
 * 直连 api-seller.ozon.ru OPI 的 fetch 封装。Phase 0 PoC 已验证 chrome-extension
 * Origin 不被 ban,30/30 200 + p95 373ms。
 *
 * 通过 importScripts 加载到 SW global,挂 globalThis.JzOpiClient。
 */

(() => {
  const BASE_URL = "https://api-seller.ozon.ru";
  const DEFAULT_TIMEOUT_MS = 60_000;

  /**
   * @param {string} path 例如 "/v3/product/list"
   * @param {object} body
   * @param {{ clientId: string, apiKey: string }} creds
   * @param {{ timeoutMs?: number }} [opts]
   */
  async function call(path, body, creds, opts = {}) {
    if (!creds?.clientId || !creds?.apiKey) {
      throw new Error("OPI credentials missing");
    }
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "Client-Id": String(creds.clientId),
          "Api-Key": String(creds.apiKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {}
      if (!res.ok) {
        const err = new Error(
          `OPI ${res.status} ${path}: ${text.slice(0, 200)}`,
        );
        err.status = res.status;
        err.bodyText = text;
        throw err;
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  globalThis.JzOpiClient = { call };
})();
