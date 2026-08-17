(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JzOzonBuyerCategory = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';

  const CATEGORY_PATH = /^\/category\/[a-z0-9][a-z0-9-]*-[1-9][0-9]*\/$/i;

  function invalid() {
    return Object.assign(new Error('OZON_BUYER_CATEGORY_URL_INVALID'), {
      code: 'OZON_BUYER_CATEGORY_URL_INVALID',
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

  return Object.freeze({ findLeafCategoryUrl, projectCategoryUrl });
});
