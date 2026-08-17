(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JzCategoryStrategyHandoff = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';

  const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
  const CATEGORY_PATH = /^\/category\/[a-z0-9][a-z0-9-]*-[1-9][0-9]*\/$/i;
  const PRODUCT_PATH = /^\/product\/[a-z0-9][a-z0-9-]*-[1-9][0-9]*\/$/i;

  function invalid() {
    return Object.assign(new Error('CATEGORY_STRATEGY_HANDOFF_URL_INVALID'), {
      code: 'CATEGORY_STRATEGY_HANDOFF_URL_INVALID',
    });
  }

  function projectBrowserUrl(raw) {
    if (typeof raw !== 'string' || raw !== raw.trim() || raw.length > 2048) throw invalid();
    let url;
    try { url = new URL(raw); } catch { throw invalid(); }
    const keys = [...url.searchParams.keys()];
    const sessions = url.searchParams.getAll('zongziCategoryStrategySession');
    if (url.origin !== 'https://www.ozon.ru' || url.username || url.password || url.hash
      || !(CATEGORY_PATH.test(url.pathname) || PRODUCT_PATH.test(url.pathname))
      || keys.length !== 1 || keys[0] !== 'zongziCategoryStrategySession'
      || sessions.length !== 1 || !SESSION_ID.test(sessions[0])) throw invalid();
    return url.href;
  }

  return Object.freeze({ projectBrowserUrl });
});
