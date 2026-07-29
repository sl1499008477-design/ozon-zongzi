(function (root) {
  'use strict';
  const trusted = (url) => {
    try { const u = new URL(String(url || '')); return (u.protocol === 'https:' && (u.hostname === 'qh.jizhangerp.com' || u.hostname.endsWith('.qh.jizhangerp.com'))) || (u.protocol === 'http:' && ['localhost', '127.0.0.1', 'store.localhost'].includes(u.hostname) && u.port === '3000'); } catch { return false; }
  };
  const copy = (source, fields) => Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));
  const normalizePortalBridgeMessage = ({ protocol, message = {}, senderUrl } = {}) => {
    if (!trusted(senderUrl)) throw new Error('PORTAL_BRIDGE_FORBIDDEN');
    if (protocol === 'SONLI_COLLECTOR_AUTH') {
      if (message.action !== 'collector.auth.exchange') throw new Error('PORTAL_BRIDGE_FORBIDDEN');
      const requestId = String(message.requestId || '').trim();
      const ticket = String(message.ticket || '');
      const expiresAt = String(message.expiresAt || '');
      if (!requestId || requestId.length > 128 || !ticket || !expiresAt) throw new Error('PORTAL_BRIDGE_FORBIDDEN');
      return { protocol, action: message.action, requestId, ticket, expiresAt };
    }
    if (protocol === 'JZ_ERP') {
      if (message.type === 'jzManualSync') return { protocol, type: message.type, ...copy(message, ['storeId', 'syncType', 'postingsSinceDays', 'postingsSince', 'postingsTo']) };
      if (message.action === 'followSell') return { protocol, action: message.action, ...copy(message, ['storeId', 'items', 'strictTypeMatch', 'dryRun', 'applyWatermark', 'applyPoster', 'applyAiRewrite', 'stocks', 'viaPortal']) };
    }
    throw new Error('PORTAL_BRIDGE_FORBIDDEN');
  };
  const routePortalRuntimeMessage = ({ message = {}, senderUrl } = {}) => {
    if (!trusted(senderUrl)) {
      if (message?.portalProtocol || message?.webBridge) throw new Error('PORTAL_BRIDGE_FORBIDDEN');
      return { source: 'EXTENSION', route: 'INTERNAL', message };
    }
    if (!message?.portalProtocol) {
      if (message?.webBridge) throw new Error('PORTAL_BRIDGE_FORBIDDEN');
      return { source: 'EXTENSION_CONTENT', route: 'INTERNAL', message };
    }
    const normalized = normalizePortalBridgeMessage({
      protocol: message.portalProtocol,
      message,
      senderUrl,
    });
    const route = normalized.protocol === 'SONLI_COLLECTOR_AUTH'
      ? 'SONLI_COLLECTOR_AUTH'
      : normalized.type === 'jzManualSync'
        ? 'JZ_MANUAL_SYNC'
        : 'JZ_FOLLOW_SELL';
    return { source: 'PORTAL', route, message: normalized };
  };
  const sanitizePortalBridgeResponse = (response) => {
    if (!response || typeof response !== 'object') return response;
    const data = response.data && typeof response.data === 'object' ? { ...response.data } : response.data;
    if (data && typeof data === 'object') { delete data.token; delete data.accessToken; delete data.access_token; delete data.authorization; }
    return { ...response, data };
  };
  const api = Object.freeze({ normalizePortalBridgeMessage, routePortalRuntimeMessage, sanitizePortalBridgeResponse });
  root.JzPortalBridgePolicy = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
