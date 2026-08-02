(function (root) {
  'use strict';
  const trusted = (url) => {
    try { const u = new URL(String(url || '')); return (u.protocol === 'https:' && (u.hostname === 'qh.jizhangerp.com' || u.hostname.endsWith('.qh.jizhangerp.com'))) || (u.protocol === 'http:' && ['localhost', '127.0.0.1', 'store.localhost'].includes(u.hostname) && u.port === '3000'); } catch { return false; }
  };
  const copy = (source, fields) => Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));
  const collectorKeys = Object.freeze({
    'collector.auth.begin': Object.freeze(['action', 'generationId']),
    'collector.auth.logout': Object.freeze(['action', 'generationId']),
    'collector.auth.exchange': Object.freeze([
      'action',
      'expiresAt',
      'generationId',
      'requestId',
      'ticket',
    ]),
  });
  const collectorGenerationPattern = /^[A-Za-z0-9_-]{16,128}$/;
  const hasExactKeys = (source, expected) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
    const keys = Object.keys(source).sort();
    return keys.length === expected.length
      && expected.every((field, index) => keys[index] === field);
  };
  const normalizePortalBridgeMessage = ({ protocol, message = {}, senderUrl } = {}) => {
    if (!trusted(senderUrl)) throw new Error('PORTAL_BRIDGE_FORBIDDEN');
    if (protocol === 'SONLI_COLLECTOR_AUTH') {
      const expectedKeys = collectorKeys[message.action];
      if (!expectedKeys || !hasExactKeys(message, expectedKeys)) {
        throw new Error('PORTAL_BRIDGE_FORBIDDEN');
      }
      const generationId = typeof message.generationId === 'string'
        ? message.generationId
        : '';
      if (!collectorGenerationPattern.test(generationId)) {
        throw new Error('PORTAL_BRIDGE_FORBIDDEN');
      }
      if (message.action === 'collector.auth.begin' || message.action === 'collector.auth.logout') {
        return { protocol, action: message.action, generationId };
      }
      const requestId = typeof message.requestId === 'string' ? message.requestId.trim() : '';
      const ticket = typeof message.ticket === 'string' ? message.ticket : '';
      const expiresAt = typeof message.expiresAt === 'string' ? message.expiresAt : '';
      if (!requestId || requestId.length > 128 || !ticket || !expiresAt) {
        throw new Error('PORTAL_BRIDGE_FORBIDDEN');
      }
      return {
        protocol,
        action: message.action,
        requestId,
        generationId,
        ticket,
        expiresAt,
      };
    }
    if (protocol === 'JZ_ERP') {
      if (message.action === 'followSell') return { protocol, action: message.action, ...copy(message, ['storeId', 'items', 'strictTypeMatch', 'dryRun', 'applyPoster', 'applyAiRewrite', 'stocks', 'viaPortal']) };
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
    const { portalProtocol, ...portalMessage } = message;
    const normalized = normalizePortalBridgeMessage({
      protocol: portalProtocol,
      message: portalMessage,
      senderUrl,
    });
    const route = normalized.protocol === 'SONLI_COLLECTOR_AUTH'
      ? 'SONLI_COLLECTOR_AUTH'
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
