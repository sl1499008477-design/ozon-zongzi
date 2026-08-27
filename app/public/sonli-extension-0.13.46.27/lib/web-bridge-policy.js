(function (root) {
  'use strict';
  const COLLECTOR_AUTH_PROTOCOL = 'SONLI_COLLECTOR_AUTH';
  const REQUEST_ACTION = 'collector.auth.request';
  const RESPONSE_ACTION = 'collector.auth.response';
  const READY_ACTION = 'collector.auth.ready';
  const READY_V2_ACTION = 'collector.auth.ready.v2';
  const ACCEPTED_ACTION = 'collector.auth.accepted';
  const FAILURE_ACTION = 'collector.auth.failure';
  const LOGOUT_ACTION = 'collector.auth.logout';
  const PUBLIC_FAILURE_CODES = new Set([
    'WEB_LOGIN_REQUIRED',
    'LOCAL_SERVICE_UNAVAILABLE',
    'ACCOUNT_DISABLED',
    'ACCOUNT_EXPIRED',
    'PERMISSION_DENIED',
    'SERVER_UPGRADE_REQUIRED',
  ]);
  const collectorGenerationPattern = /^[A-Za-z0-9_-]{16,128}$/;
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
  const hasExactKeys = (value, expected) => {
    if (!isPlainRecord(value)) return false;
    const keys = Reflect.ownKeys(value).sort((left, right) => String(left).localeCompare(String(right)));
    return keys.length === expected.length
      && expected.every((field, index) => keys[index] === field);
  };
  const generationId = (value) => (
    typeof value === 'string' && collectorGenerationPattern.test(value) ? value : ''
  );
  const requestId = (value) => {
    if (typeof value !== 'string') return '';
    return value.length <= 128 && /^collector-[A-Za-z0-9-]+$/.test(value) ? value : '';
  };
  const accountIdHint = (value) => {
    if (typeof value !== 'string') return '';
    const normalized = value.trim();
    return normalized && normalized.length <= 128 && value === normalized ? normalized : '';
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
  const normalizeCollectorAuthReady = (value) => {
    if (!hasExactKeys(value, ['action', 'generationId', 'protocol'])) return null;
    if (value.protocol !== COLLECTOR_AUTH_PROTOCOL || value.action !== READY_ACTION) return null;
    const normalizedGenerationId = generationId(value.generationId);
    if (!normalizedGenerationId) return null;
    return {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: READY_ACTION,
      generationId: normalizedGenerationId,
    };
  };
  const normalizeCollectorAuthReadyV2 = (value) => {
    if (!hasExactKeys(value, ['accountId', 'action', 'generationId', 'protocol'])) return null;
    if (value.protocol !== COLLECTOR_AUTH_PROTOCOL || value.action !== READY_V2_ACTION) return null;
    const normalizedGenerationId = generationId(value.generationId);
    const normalizedAccountIdHint = accountIdHint(value.accountId);
    if (!normalizedGenerationId || !normalizedAccountIdHint) return null;
    return {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: READY_V2_ACTION,
      generationId: normalizedGenerationId,
      accountIdHint: normalizedAccountIdHint,
    };
  };
  function normalizeCollectorAuthAccepted(value, expectedRequestId) {
    if (!hasExactKeys(value, ['action', 'generationId', 'protocol', 'requestId'])) return null;
    if (value.protocol !== COLLECTOR_AUTH_PROTOCOL || value.action !== ACCEPTED_ACTION) return null;
    if (typeof value.requestId !== 'string') return null;
    if (arguments.length > 1 && typeof expectedRequestId !== 'string') return null;
    const normalizedRequestId = requestId(value.requestId);
    const normalizedGenerationId = generationId(value.generationId);
    if (!normalizedRequestId || value.requestId !== normalizedRequestId || !normalizedGenerationId) {
      return null;
    }
    if (arguments.length > 1 && value.requestId !== expectedRequestId) return null;
    return {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: ACCEPTED_ACTION,
      requestId: normalizedRequestId,
      generationId: normalizedGenerationId,
    };
  }
  function normalizeCollectorAuthFailure(value, expectedRequestId) {
    if (!hasExactKeys(value, [
      'action', 'generationId', 'protocol', 'publicCode', 'requestId',
    ])) return null;
    if (value.protocol !== COLLECTOR_AUTH_PROTOCOL || value.action !== FAILURE_ACTION) return null;
    if (typeof value.requestId !== 'string') return null;
    if (arguments.length > 1 && typeof expectedRequestId !== 'string') return null;
    const normalizedRequestId = requestId(value.requestId);
    const normalizedGenerationId = generationId(value.generationId);
    if (!normalizedRequestId || normalizedRequestId !== value.requestId || !normalizedGenerationId
      || !PUBLIC_FAILURE_CODES.has(value.publicCode)) return null;
    if (arguments.length > 1 && normalizedRequestId !== expectedRequestId) return null;
    return {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: FAILURE_ACTION,
      requestId: normalizedRequestId,
      generationId: normalizedGenerationId,
      publicCode: value.publicCode,
    };
  }
  const normalizeCollectorAuthLogout = (value) => {
    if (!hasExactKeys(value, ['action', 'generationId', 'protocol'])) return null;
    if (value.protocol !== COLLECTOR_AUTH_PROTOCOL || value.action !== LOGOUT_ACTION) return null;
    const normalizedGenerationId = generationId(value.generationId);
    if (!normalizedGenerationId) return null;
    return {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: LOGOUT_ACTION,
      generationId: normalizedGenerationId,
    };
  };
  function normalizeCollectorAuthResponse(value, expectedRequestId) {
    if (!hasExactKeys(value, [
      'action',
      'expiresAt',
      'generationId',
      'protocol',
      'requestId',
      'ticket',
    ])) return null;
    if (value.protocol !== COLLECTOR_AUTH_PROTOCOL || value.action !== RESPONSE_ACTION) return null;
    if (typeof value.requestId !== 'string') return null;
    if (arguments.length > 1 && typeof expectedRequestId !== 'string') return null;
    const normalized = requestId(value.requestId);
    if (!normalized || value.requestId !== normalized) return null;
    if (arguments.length > 1 && value.requestId !== expectedRequestId) return null;
    const normalizedGenerationId = generationId(value.generationId);
    const ticket = typeof value.ticket === 'string' ? value.ticket : '';
    const expiresAt = typeof value.expiresAt === 'string' ? value.expiresAt : '';
    if (!normalizedGenerationId || !ticket || !expiresAt) return null;
    return {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: RESPONSE_ACTION,
      requestId: value.requestId,
      generationId: normalizedGenerationId,
      ticket,
      expiresAt,
    };
  }
  const api = Object.freeze({
    COLLECTOR_AUTH_PROTOCOL,
    createCollectorAuthRequest,
    isTrustedWebBridgeSender,
    normalizeCollectorAuthAccepted,
    normalizeCollectorAuthFailure,
    normalizeCollectorAuthLogout,
    normalizeCollectorAuthReady,
    normalizeCollectorAuthReadyV2,
    normalizeCollectorAuthResponse,
  });
  root.JzWebBridgePolicy = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
