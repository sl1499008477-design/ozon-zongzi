(function (root) {
  'use strict';

  const COMPANY_HEADER = 'x-o3-company-id';

  const normalizeCompanyId = (value) => {
    const normalized = String(value == null ? '' : value).trim();
    return /^\d{4,15}$/.test(normalized) ? normalized : '';
  };

  const normalizeCompanyName = (value) => String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();

  const companyIdFromSellerSwitcher = ({ activeName, entries } = {}) => {
    const normalizedActiveName = normalizeCompanyName(activeName);
    if (!normalizedActiveName || !Array.isArray(entries)) return '';
    const companyIds = [...new Set(entries
      .filter((entry) => normalizeCompanyName(entry?.name) === normalizedActiveName)
      .map((entry) => normalizeCompanyId(entry?.companyId))
      .filter(Boolean))];
    return companyIds.length === 1 ? companyIds[0] : '';
  };

  const sellerSwitcherEntryFromText = (value) => {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const match = /^(.+?)\s*Seller ID\s+(\d{4,15})$/.exec(text);
    if (!match) return null;
    const name = normalizeCompanyName(match[1]);
    const companyId = normalizeCompanyId(match[2]);
    return name && companyId ? { name, companyId } : null;
  };

  const readHeader = (headers, expectedName) => {
    if (!headers) return '';
    if (typeof headers.get === 'function') {
      return headers.get(expectedName) || headers.get(expectedName.toUpperCase()) || '';
    }
    if (Array.isArray(headers)) {
      const entry = headers.find(
        ([name]) => String(name || '').toLowerCase() === expectedName,
      );
      return entry?.[1] || '';
    }
    if (typeof headers === 'object') {
      const entry = Object.entries(headers).find(
        ([name]) => String(name || '').toLowerCase() === expectedName,
      );
      return entry?.[1] || '';
    }
    return '';
  };

  const companyIdFromFetchArgs = (input, init) => {
    const initValue = normalizeCompanyId(readHeader(init?.headers, COMPANY_HEADER));
    if (initValue) return initValue;
    const requestValue = normalizeCompanyId(readHeader(input?.headers, COMPANY_HEADER));
    if (requestValue) return requestValue;

    const requestUrl = typeof input === 'string' ? input : String(input?.url || '');
    let parsedUrl;
    try {
      parsedUrl = new URL(requestUrl, 'https://seller.ozon.ru');
    } catch {
      return '';
    }
    if (
      parsedUrl.protocol !== 'https:'
      || parsedUrl.hostname !== 'seller.ozon.ru'
      || parsedUrl.pathname !== '/api/composer-api.bx/_action/setUserCookies'
    ) {
      return '';
    }
    if (typeof init?.body !== 'string') return '';
    try {
      const payload = JSON.parse(init.body);
      const companyIds = [...new Set(
        (Array.isArray(payload?.cookies) ? payload.cookies : [])
          .filter((cookie) => cookie?.name === 'sc_company_id')
          .map((cookie) => normalizeCompanyId(cookie?.value))
          .filter(Boolean),
      )];
      return companyIds.length === 1 ? companyIds[0] : '';
    } catch {
      return '';
    }
  };

  const installObserver = ({ root: pageRoot = root, onCompanyId } = {}) => {
    if (!pageRoot || typeof onCompanyId !== 'function') {
      throw new TypeError('seller company observer requires a page root and callback');
    }
    let lastEmittedCompanyId = '';
    const emit = (value) => {
      const companyId = normalizeCompanyId(value);
      if (!companyId || companyId === lastEmittedCompanyId) return;
      lastEmittedCompanyId = companyId;
      onCompanyId(companyId);
    };

    const originalFetch = pageRoot.fetch;
    let wrappedFetch = null;
    if (typeof originalFetch === 'function') {
      wrappedFetch = function (...args) {
        emit(companyIdFromFetchArgs(args[0], args[1]));
        return originalFetch.apply(this, args);
      };
      pageRoot.fetch = wrappedFetch;
    }

    const xhrPrototype = pageRoot.XMLHttpRequest?.prototype;
    const originalSetRequestHeader = xhrPrototype?.setRequestHeader;
    let wrappedSetRequestHeader = null;
    if (typeof originalSetRequestHeader === 'function') {
      wrappedSetRequestHeader = function (name, value) {
        if (String(name || '').toLowerCase() === COMPANY_HEADER) emit(value);
        return originalSetRequestHeader.call(this, name, value);
      };
      xhrPrototype.setRequestHeader = wrappedSetRequestHeader;
    }

    return () => {
      if (wrappedFetch && pageRoot.fetch === wrappedFetch) pageRoot.fetch = originalFetch;
      if (
        wrappedSetRequestHeader
        && xhrPrototype?.setRequestHeader === wrappedSetRequestHeader
      ) {
        xhrPrototype.setRequestHeader = originalSetRequestHeader;
      }
    };
  };

  const api = Object.freeze({
    companyIdFromSellerSwitcher,
    companyIdFromFetchArgs,
    installObserver,
    normalizeCompanyId,
    sellerSwitcherEntryFromText,
  });
  root.JzSellerCompanyContext = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
