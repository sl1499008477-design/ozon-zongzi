(function (root) {
  'use strict';
  const trusted = (url) => {
    try { const u = new URL(String(url || '')); return (u.protocol === 'https:' && (u.hostname === 'www.ozonzongzi.com' || u.hostname.endsWith('.www.ozonzongzi.com'))) || (u.protocol === 'http:' && ['localhost', '127.0.0.1', 'store.localhost'].includes(u.hostname) && u.port === '3000'); } catch { return false; }
  };
  const copy = (source, fields) => Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));
  const collectorKeys = Object.freeze({
    'collector.auth.begin': Object.freeze(['action', 'generationId', 'requestId']),
    'collector.auth.logout': Object.freeze(['action', 'generationId']),
    'collector.auth.failure': Object.freeze(['action', 'generationId', 'publicCode', 'requestId']),
    'collector.auth.exchange': Object.freeze([
      'action',
      'expiresAt',
      'generationId',
      'requestId',
      'ticket',
    ]),
  });
  const collectorHintedBeginKeys = Object.freeze([
    'accountIdHint', 'action', 'generationId', 'requestId',
  ]);
  const collectorGenerationPattern = /^[A-Za-z0-9_-]{16,128}$/;
  const collectorRequestPattern = /^collector-[A-Za-z0-9-]+$/;
  const collectorFailureCodes = new Set([
    'WEB_LOGIN_REQUIRED',
    'LOCAL_SERVICE_UNAVAILABLE',
    'ACCOUNT_DISABLED',
    'ACCOUNT_EXPIRED',
    'PERMISSION_DENIED',
    'SERVER_UPGRADE_REQUIRED',
  ]);
  const nativeObjectConstructorSource = Function.prototype.toString.call(Object);
  const isPlainRecord = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype === null) return true;
      const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
      return Object.getPrototypeOf(prototype) === null
        && typeof constructor === 'function'
        && constructor.prototype === prototype
        && Function.prototype.toString.call(constructor) === nativeObjectConstructorSource;
    } catch {
      return false;
    }
  };
  const hasExactKeys = (source, expected) => {
    if (!isPlainRecord(source)) return false;
    const keys = Reflect.ownKeys(source).sort((left, right) => String(left).localeCompare(String(right)));
    return keys.length === expected.length
      && expected.every((field, index) => keys[index] === field);
  };
  const normalizePortalBridgeMessage = ({ protocol, message = {}, senderUrl } = {}) => {
    if (!trusted(senderUrl)) throw new Error('PORTAL_BRIDGE_FORBIDDEN');
    if (!isPlainRecord(message)) throw new Error('PORTAL_BRIDGE_FORBIDDEN');
    if (protocol === 'SONLI_COLLECTOR_AUTH') {
      const expectedKeys = message.action === 'collector.auth.begin'
        && Object.hasOwn(message, 'accountIdHint')
        ? collectorHintedBeginKeys
        : collectorKeys[message.action];
      if (!expectedKeys || !hasExactKeys(message, expectedKeys)) {
        throw new Error('PORTAL_BRIDGE_FORBIDDEN');
      }
      const generationId = typeof message.generationId === 'string'
        ? message.generationId
        : '';
      if (!collectorGenerationPattern.test(generationId)) {
        throw new Error('PORTAL_BRIDGE_FORBIDDEN');
      }
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      if (
        message.action !== 'collector.auth.logout'
        && (!collectorRequestPattern.test(requestId) || requestId.length > 128)
      ) throw new Error('PORTAL_BRIDGE_FORBIDDEN');
      if (message.action === 'collector.auth.begin') {
        if (!Object.hasOwn(message, 'accountIdHint')) {
          return { protocol, action: message.action, requestId, generationId };
        }
        const accountIdHint = typeof message.accountIdHint === 'string'
          ? message.accountIdHint.trim()
          : '';
        if (
          !accountIdHint
          || accountIdHint.length > 128
          || accountIdHint !== message.accountIdHint
        ) {
          throw new Error('PORTAL_BRIDGE_FORBIDDEN');
        }
        return { protocol, action: message.action, requestId, generationId, accountIdHint };
      }
      if (message.action === 'collector.auth.logout') {
        return { protocol, action: message.action, generationId };
      }
      if (message.action === 'collector.auth.failure') {
        if (!collectorFailureCodes.has(message.publicCode)) {
          throw new Error('PORTAL_BRIDGE_FORBIDDEN');
        }
        return {
          protocol,
          action: message.action,
          requestId,
          generationId,
          publicCode: message.publicCode,
        };
      }
      const ticket = typeof message.ticket === 'string' ? message.ticket : '';
      const expiresAt = typeof message.expiresAt === 'string' ? message.expiresAt : '';
      if (!ticket || !expiresAt) {
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
    if (!isPlainRecord(message)) throw new Error('PORTAL_BRIDGE_FORBIDDEN');
    const hasPortalProtocol = Object.hasOwn(message, 'portalProtocol');
    if (!trusted(senderUrl)) {
      if (hasPortalProtocol || Object.hasOwn(message, 'webBridge')) {
        throw new Error('PORTAL_BRIDGE_FORBIDDEN');
      }
      return { source: 'EXTENSION', route: 'INTERNAL', message };
    }
    if (!hasPortalProtocol) {
      if (Object.hasOwn(message, 'webBridge')) throw new Error('PORTAL_BRIDGE_FORBIDDEN');
      return { source: 'EXTENSION_CONTENT', route: 'INTERNAL', message };
    }
    const portalProtocol = message.portalProtocol;
    const portalDescriptors = Object.getOwnPropertyDescriptors(message);
    delete portalDescriptors.portalProtocol;
    const portalMessage = Object.create(
      Object.getPrototypeOf(message),
      portalDescriptors,
    );
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
