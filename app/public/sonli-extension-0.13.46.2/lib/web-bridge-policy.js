(function (root) {
  'use strict';
  const COLLECTOR_AUTH_PROTOCOL = 'SONLI_COLLECTOR_AUTH';
  const REQUEST_ACTION = 'collector.auth.request';
  const RESPONSE_ACTION = 'collector.auth.response';
  const requestId = (value) => {
    const normalized = String(value || '').trim();
    return normalized && normalized.length <= 128 ? normalized : '';
  };
  const isTrustedWebBridgeSender = (sender) => {
    try {
      const url = new URL(String(sender?.url || ''));
      return (url.protocol === 'https:' && (url.hostname === 'qh.jizhangerp.com' || url.hostname.endsWith('.qh.jizhangerp.com')))
        || (url.protocol === 'http:' && ['localhost', '127.0.0.1', 'store.localhost'].includes(url.hostname) && url.port === '3000');
    } catch { return false; }
  };
  const createCollectorAuthRequest = (value) => {
    const normalized = requestId(value);
    if (!normalized) throw new Error('COLLECTOR_AUTH_REQUEST_ID_REQUIRED');
    return {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: REQUEST_ACTION,
      requestId: normalized,
    };
  };
  const normalizeCollectorAuthResponse = (value, expectedRequestId) => {
    if (!value || typeof value !== 'object') return null;
    if (value.protocol !== COLLECTOR_AUTH_PROTOCOL || value.action !== RESPONSE_ACTION) return null;
    const normalized = requestId(value.requestId);
    if (!normalized || normalized !== requestId(expectedRequestId)) return null;
    const ticket = String(value.ticket || '');
    const expiresAt = String(value.expiresAt || '');
    if (!ticket || !expiresAt) return null;
    return {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: RESPONSE_ACTION,
      requestId: normalized,
      ticket,
      expiresAt,
    };
  };
  const api = Object.freeze({
    COLLECTOR_AUTH_PROTOCOL,
    createCollectorAuthRequest,
    isTrustedWebBridgeSender,
    normalizeCollectorAuthResponse,
  });
  root.JzWebBridgePolicy = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
