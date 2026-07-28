(function (root) {
  'use strict';
  const ALLOWED_ACTIONS = new Set([
    'syncAuthFromWeb',
    'logout',
    'getOzonSellerLoginState',
    'openSellerPortal',
    'refreshFxProbes',
  ]);
  const isAllowedWebBridgeAction = (action) => ALLOWED_ACTIONS.has(String(action || ''));
  const isTrustedWebBridgeSender = (sender) => {
    try {
      const url = new URL(String(sender?.url || ''));
      return (url.protocol === 'https:' && (url.hostname === 'qh.jizhangerp.com' || url.hostname.endsWith('.qh.jizhangerp.com')))
        || (url.protocol === 'http:' && ['localhost', '127.0.0.1', 'store.localhost'].includes(url.hostname) && url.port === '3000');
    } catch { return false; }
  };
  const sanitizeWebBridgeResponse = (response) => {
    if (!response || typeof response !== 'object') return response;
    const data = response.data && typeof response.data === 'object' ? { ...response.data } : response.data;
    if (data && typeof data === 'object') {
      delete data.token;
      delete data.accessToken;
      delete data.access_token;
      delete data.authorization;
    }
    return { ...response, data };
  };
  const api = Object.freeze({ isAllowedWebBridgeAction, isTrustedWebBridgeSender, sanitizeWebBridgeResponse });
  root.JzWebBridgePolicy = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
