(function (root) {
  'use strict';
  const isTrustedSellerTab = (tab) => {
    try { const url = new URL(String(tab?.url || '')); return url.protocol === 'https:' && url.hostname === 'seller.ozon.ru'; } catch { return false; }
  };
  const resolveTrustedSellerCompanyId = (cookies) => {
    const ids = [...new Set((cookies || []).filter((cookie) => cookie?.name === 'sc_company_id' && String(cookie.domain || '').replace(/^\./, '') === 'seller.ozon.ru').map((cookie) => String(cookie.value || '').trim()).filter((value) => /^\d{4,15}$/.test(value)))];
    if (ids.length !== 1) throw new Error(ids.length ? '多个 seller.ozon.ru sc_company_id 冲突' : 'sc_company_id cookie 未找到,请确保已登录 seller.ozon.ru');
    return ids[0];
  };
  const resolveSellerMessageIdentity = async (sender, getCookies) => {
    if (!isTrustedSellerTab(sender?.tab || sender)) throw new Error('SELLER_CONTEXT_REQUIRED');
    const cookies = await getCookies({ url: 'https://seller.ozon.ru/' });
    const companyId = resolveTrustedSellerCompanyId(cookies);
    const scopedCookies = (cookies || []).filter((cookie) => String(cookie?.domain || '').replace(/^\./, '') === 'seller.ozon.ru');
    return { companyId, cookies: scopedCookies };
  };
  const api = Object.freeze({ isTrustedSellerTab, resolveTrustedSellerCompanyId, resolveSellerMessageIdentity });
  root.JzSellerIdentityPolicy = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
