(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JzOzonBuyerCategory = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';

  const CATEGORY_PATH = /^\/category\/[a-z0-9][a-z0-9-]*-[1-9][0-9]*\/$/i;
  const PRODUCT_PATH = /^\/product\/[a-z0-9][a-z0-9-]*-[1-9][0-9]*\/$/i;
  const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
  const OZON_SHARE_ID = /^[A-Za-z0-9_-]{1,128}$/;

  function invalid() {
    return Object.assign(new Error('ZONGZI_BUYER_CATEGORY_URL_INVALID'), {
      code: 'ZONGZI_BUYER_CATEGORY_URL_INVALID',
    });
  }

  function projectCategoryUrl(raw) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) throw invalid();
    let url;
    try { url = new URL(raw, 'https://www.ozon.ru'); } catch { throw invalid(); }
    if (url.origin !== 'https://www.ozon.ru' || url.username || url.password
      || !CATEGORY_PATH.test(url.pathname)) throw invalid();
    url.search = '';
    url.hash = '';
    return url.href;
  }

  function findLeafCategoryUrl(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return '';
    let scope = root;
    if (typeof root.querySelector === 'function') {
      scope = root.querySelector('[data-widget="breadCrumbs"], [data-widget="webBreadcrumbs"]') || root;
    }
    const candidates = [];
    for (const link of scope.querySelectorAll('a[href*="/category/"]')) {
      const attribute = link?.getAttribute?.('href');
      const raw = typeof attribute === 'string' && attribute
        ? attribute
        : (typeof link?.href === 'string' ? link.href : '');
      try { candidates.push(projectCategoryUrl(raw)); } catch {}
    }
    return candidates.at(-1) || '';
  }

  function samplingCategoryUrl(rawCategoryUrl, sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw invalid();
    const url = new URL(projectCategoryUrl(rawCategoryUrl));
    url.searchParams.set('zongziCategoryStrategySession', sessionId);
    return url.href;
  }

  function samplingTargetForProductPage(rawPageUrl, root) {
    let page;
    try { page = new URL(rawPageUrl); } catch { throw invalid(); }
    const keys = [...page.searchParams.keys()];
    const sessions = page.searchParams.getAll('zongziCategoryStrategySession');
    const shareIds = page.searchParams.getAll('sh');
    const routerReloads = page.searchParams.getAll('__rr');
    if (page.origin !== 'https://www.ozon.ru' || page.username || page.password || page.hash
      || !PRODUCT_PATH.test(page.pathname)
      || keys.some((key) => !['zongziCategoryStrategySession', 'sh', '__rr'].includes(key))
      || sessions.length !== 1 || !SESSION_ID.test(sessions[0])
      || shareIds.length > 1
      || (shareIds.length === 1 && !OZON_SHARE_ID.test(shareIds[0]))
      || routerReloads.length > 1
      || (routerReloads.length === 1 && routerReloads[0] !== '1')) throw invalid();
    const categoryUrl = findLeafCategoryUrl(root);
    return categoryUrl ? samplingCategoryUrl(categoryUrl, sessions[0]) : '';
  }

  return Object.freeze({
    findLeafCategoryUrl,
    projectCategoryUrl,
    samplingCategoryUrl,
    samplingTargetForProductPage,
  });
});
