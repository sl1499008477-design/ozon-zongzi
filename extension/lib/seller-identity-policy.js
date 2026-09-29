(function (root) {
  'use strict';
  const getSellerOrigin = () => root.JzActiveSellerRoute?.getOrigin() || 'https://seller.ozon.ru';
  const allowedOrigin = origin => ['https://seller.ozon.ru', 'https://seller.ozonru.cn'].includes(origin);
  const isTrustedSellerTab = (tab, sellerOrigin = getSellerOrigin()) => {
    try {
      return allowedOrigin(sellerOrigin) && new URL(String(tab?.url || '')).origin === sellerOrigin;
    } catch {
      return false;
    }
  };
  const normalizeCompanyId = (value) => {
    const normalized = String(value == null ? '' : value).trim();
    return /^\d{4,15}$/.test(normalized) ? normalized : '';
  };
  const trustedCookieCompanyIds = (cookies, sellerOrigin = getSellerOrigin()) => [...new Set(
    (cookies || [])
      .filter(
        (cookie) =>
          cookie?.name === 'sc_company_id'
          && allowedOrigin(sellerOrigin)
          && [new URL(sellerOrigin).hostname, new URL(sellerOrigin).hostname.replace(/^seller\./, '')].includes(
            String(cookie.domain || '').replace(/^\./, '').toLowerCase(),
          ),
      )
      .map((cookie) => normalizeCompanyId(cookie.value))
      .filter(Boolean),
  )];
  const resolveTrustedSellerCompanyId = (cookies, sellerOrigin = getSellerOrigin()) => {
    const ids = trustedCookieCompanyIds(cookies, sellerOrigin);
    if (ids.length !== 1) throw new Error(ids.length ? '当前 Seller 线路 sc_company_id 冲突' : 'sc_company_id cookie 未找到,请确保已登录当前 Seller 线路');
    return ids[0];
  };
  const resolveTrustedSellerCompanyContext = ({
    sellerOrigin = getSellerOrigin(),
    cookies = [],
    observations = [],
    sellerTabs = [],
    now = Date.now(),
    ttlMs = 10 * 60 * 1000,
    stabilizationWindowMs = 0,
  } = {}) => {
    const trustedTabs = (sellerTabs || []).filter(tab => isTrustedSellerTab(tab, sellerOrigin));
    if (!trustedTabs.length) throw new Error('SELLER_CONTEXT_REQUIRED');
    const trustedTabIds = new Set(trustedTabs.map((tab) => Number(tab.id)));
    const validObservations = (observations || [])
      .map((observation, index) => ({ ...observation, index }))
      .filter((observation) => {
        const observedAt = Number(observation?.observedAt);
        return trustedTabIds.has(Number(observation?.tabId))
          && Boolean(normalizeCompanyId(observation?.companyId))
          && Number.isFinite(observedAt)
          && observedAt <= Number(now) + 5_000
          && Number(now) - observedAt <= Number(ttlMs);
      })
      .sort((left, right) => (
        Number(right.observedAt) - Number(left.observedAt)
        || Number(right.revision || 0) - Number(left.revision || 0)
        || right.index - left.index
      ));
    const cookieIds = trustedCookieCompanyIds(cookies, sellerOrigin);
    const latestObservation = validObservations[0];
    const observedId = normalizeCompanyId(latestObservation?.companyId);
    const safeStabilizationWindowMs = Math.max(0, Number(stabilizationWindowMs) || 0);
    const recentObservedIds = new Set(validObservations
      .filter((observation) => (
        Number(now) - Number(observation.observedAt) <= safeStabilizationWindowMs
      ))
      .map((observation) => normalizeCompanyId(observation.companyId)));
    if (safeStabilizationWindowMs > 0 && recentObservedIds.size > 1) {
      throw new Error('SELLER_CONTEXT_RECOVERING');
    }
    if (cookieIds.length > 1) {
      throw new Error('SELLER_COMPANY_CONTEXT_CONFLICT');
    }
    const cookieId = cookieIds[0] || '';
    if (cookieId && observedId && cookieId !== observedId) {
      throw new Error('SELLER_COMPANY_CONTEXT_CONFLICT');
    }
    const companyId = cookieId || observedId;
    if (!companyId) {
      if ((cookies || []).some((cookie) => cookie?.name === 'sc_company_id')) {
        throw new Error('sc_company_id cookie 未找到,请确保已登录当前 Seller 线路');
      }
      throw new Error('SELLER_COMPANY_CONTEXT_REQUIRED');
    }
    const observedTabId = observedId === companyId ? latestObservation?.tabId : undefined;
    const activeTabId = trustedTabs.find((tab) => tab.active)?.id;
    return {
      companyId,
      sellerTabId: Number(observedTabId || activeTabId || trustedTabs[0].id),
      source: cookieId && observedId ? 'cookie+observed' : cookieId ? 'cookie' : 'observed',
    };
  };
  const resolveSellerMessageIdentity = async ({
    sellerOrigin = getSellerOrigin(),
    findSellerTabs,
    getCookies,
    getObservedContexts,
    now = () => Date.now(),
  } = {}) => {
    const sellerTabs = (await findSellerTabs?.() || []).filter(tab => isTrustedSellerTab(tab, sellerOrigin));
    if (!sellerTabs.length) throw new Error('SELLER_CONTEXT_REQUIRED');
    const companyCookies = await getCookies({ url: sellerOrigin + '/', name: 'sc_company_id' });
    const context = resolveTrustedSellerCompanyContext({
      sellerOrigin,
      cookies: companyCookies,
      observations: await getObservedContexts?.(sellerTabs) || [],
      sellerTabs,
      now: now(),
    });
    const cookies = await getCookies({ url: sellerOrigin + '/' });
    const scopedCookies = (cookies || []).filter((cookie) => String(cookie?.domain || '').replace(/^\./, '') === new URL(sellerOrigin).hostname);
    return { ...context, cookies: scopedCookies };
  };
  const api = Object.freeze({
    getSellerOrigin,
    isTrustedSellerTab,
    normalizeCompanyId,
    resolveSellerMessageIdentity,
    resolveTrustedSellerCompanyContext,
    resolveTrustedSellerCompanyId,
  });
  root.JzSellerIdentityPolicy = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
