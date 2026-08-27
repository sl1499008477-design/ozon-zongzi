(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JzCategoryStrategyHandoff = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';

  const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
  const RETURN_KEY_PREFIX = 'zongzi.categoryStrategySampling.return.';
  const CATEGORY_PATH = /^\/category\/[a-z0-9][a-z0-9-]*-[1-9][0-9]*\/$/i;
  const PRODUCT_PATH = /^\/product\/[a-z0-9][a-z0-9-]*-[1-9][0-9]*\/$/i;
  const STRATEGY_PATH = /^\/ozon\/tools\/category-strategies\/?$/;

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

  function projectSamplingPageUrl(raw, sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw invalid();
    const url = new URL(projectBrowserUrl(raw));
    if (!CATEGORY_PATH.test(url.pathname)
      || url.searchParams.get('zongziCategoryStrategySession') !== sessionId) throw invalid();
    return url.href;
  }

  function createCategoryStrategyReturnNavigation({
    storageSession,
    allowedOrigins,
    updateTab,
    updateWindow,
    createTab,
    removeTab,
  } = {}) {
    if (!storageSession || typeof storageSession.get !== 'function'
      || typeof storageSession.set !== 'function' || typeof storageSession.remove !== 'function'
      || !Array.isArray(allowedOrigins) || allowedOrigins.length < 1
      || allowedOrigins.some((origin) => typeof origin !== 'string')
      || typeof updateTab !== 'function' || typeof updateWindow !== 'function'
      || typeof createTab !== 'function' || typeof removeTab !== 'function') {
      throw new TypeError('category strategy return navigation dependencies are required');
    }
    const origins = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
    const keyFor = (sessionId) => `${RETURN_KEY_PREFIX}${sessionId}`;
    const positiveTabId = (value) => Number.isInteger(value) && value >= 0;
    const returnUrl = (raw) => {
      let url;
      try { url = new URL(raw); } catch { throw invalid(); }
      const keys = [...url.searchParams.keys()];
      const draftIds = url.searchParams.getAll('draftId');
      if (!origins.has(url.origin) || url.username || url.password || url.hash
        || !STRATEGY_PATH.test(url.pathname) || keys.length !== 1 || keys[0] !== 'draftId'
        || draftIds.length !== 1 || !SESSION_ID.test(draftIds[0])) throw invalid();
      return url.href;
    };
    const projectRecord = (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || !positiveTabId(raw.returnTabId) || !positiveTabId(raw.returnWindowId)
        || !positiveTabId(raw.samplingTabId)) throw invalid();
      return Object.freeze({ returnTabId: raw.returnTabId, returnWindowId: raw.returnWindowId,
        samplingTabId: raw.samplingTabId, returnUrl: returnUrl(raw.returnUrl) });
    };

    const remember = async ({ browserUrl, returnTabId, returnWindowId, returnUrl: rawReturnUrl,
      samplingTabId } = {}) => {
      const projectedBrowserUrl = new URL(projectBrowserUrl(browserUrl));
      const sessionId = projectedBrowserUrl.searchParams.get('zongziCategoryStrategySession');
      const record = projectRecord({ returnTabId, returnWindowId, samplingTabId,
        returnUrl: rawReturnUrl });
      await storageSession.set({ [keyFor(sessionId)]: record });
      return Object.freeze({ remembered: true, sessionId });
    };

    const complete = async ({ sessionId, samplingTabId } = {}) => {
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)
        || !positiveTabId(samplingTabId)) return Object.freeze({ returned: false, closed: false });
      const key = keyFor(sessionId);
      let record;
      try { record = projectRecord((await storageSession.get(key))?.[key]); }
      catch { return Object.freeze({ returned: false, closed: false }); }
      if (record.samplingTabId !== samplingTabId) {
        return Object.freeze({ returned: false, closed: false });
      }
      let targetTabId = record.returnTabId;
      try {
        await updateTab(record.returnTabId, { url: record.returnUrl, active: true });
        try { await updateWindow(record.returnWindowId, { focused: true }); } catch {}
      } catch {
        try {
          const created = await createTab({ url: record.returnUrl, active: true });
          targetTabId = positiveTabId(created?.id) ? created.id : null;
        } catch {
          return Object.freeze({ returned: false, closed: false });
        }
      }
      try { await storageSession.remove(key); } catch {}
      if (samplingTabId === targetTabId) return Object.freeze({ returned: true, closed: false });
      try {
        await removeTab(samplingTabId);
        return Object.freeze({ returned: true, closed: true });
      } catch {
        return Object.freeze({ returned: true, closed: false });
      }
    };

    return Object.freeze({ remember, complete });
  }

  return Object.freeze({ createCategoryStrategyReturnNavigation, projectBrowserUrl,
    projectSamplingPageUrl });
});
