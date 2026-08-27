(function (root) {
  'use strict';
  const isTrustedSellerTab = (tab) => {
    try {
      return new URL(String(tab?.url || '')).origin === 'https://seller.ozon.ru';
    } catch {
      return false;
    }
  };
  const normalizeCompanyId = (value) => {
    const normalized = String(value == null ? '' : value).trim();
    return /^\d{4,15}$/.test(normalized) ? normalized : '';
  };
  const trustedCookieCompanyIds = (cookies) => [...new Set(
    (cookies || [])
      .filter(
        (cookie) =>
          cookie?.name === 'sc_company_id'
          && ['seller.ozon.ru', 'ozon.ru'].includes(
            String(cookie.domain || '').replace(/^\./, '').toLowerCase(),
          ),
      )
      .map((cookie) => normalizeCompanyId(cookie.value))
      .filter(Boolean),
  )];
  const resolveTrustedSellerCompanyId = (cookies) => {
    const ids = trustedCookieCompanyIds(cookies);
    if (ids.length !== 1) throw new Error(ids.length ? '多个 seller.ozon.ru sc_company_id 冲突' : 'sc_company_id cookie 未找到,请确保已登录 seller.ozon.ru');
    return ids[0];
  };
  const resolveTrustedSellerCompanyContext = ({
    cookies = [],
    observations = [],
    sellerTabs = [],
    now = Date.now(),
    ttlMs = 10 * 60 * 1000,
    stabilizationWindowMs = 0,
  } = {}) => {
    const trustedTabs = (sellerTabs || []).filter(isTrustedSellerTab);
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
    const cookieIds = trustedCookieCompanyIds(cookies);
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
        throw new Error('sc_company_id cookie 未找到,请确保已登录 seller.ozon.ru');
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
    findSellerTabs,
    getCookies,
    getObservedContexts,
    now = () => Date.now(),
  } = {}) => {
    const sellerTabs = (await findSellerTabs?.() || []).filter(isTrustedSellerTab);
    if (!sellerTabs.length) throw new Error('SELLER_CONTEXT_REQUIRED');
    const companyCookies = await getCookies({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
    const context = resolveTrustedSellerCompanyContext({
      cookies: companyCookies,
      observations: await getObservedContexts?.(sellerTabs) || [],
      sellerTabs,
      now: now(),
    });
    const cookies = await getCookies({ url: 'https://seller.ozon.ru/' });
    const scopedCookies = (cookies || []).filter((cookie) => String(cookie?.domain || '').replace(/^\./, '') === 'seller.ozon.ru');
    return { ...context, cookies: scopedCookies };
  };
  const api = Object.freeze({
    isTrustedSellerTab,
    normalizeCompanyId,
    resolveSellerMessageIdentity,
    resolveTrustedSellerCompanyContext,
    resolveTrustedSellerCompanyId,
  });
  root.JzSellerIdentityPolicy = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
