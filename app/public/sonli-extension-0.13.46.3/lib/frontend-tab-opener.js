(function (root) {
  'use strict';

  const createFrontendTabOpener = ({
    queryTabs,
    updateTab,
    updateWindow,
    createTab,
    requestCollectorAuth,
    injectCollectorAuth = async () => {},
  } = {}) => {
    if (
      typeof queryTabs !== 'function'
      || typeof updateTab !== 'function'
      || typeof updateWindow !== 'function'
      || typeof createTab !== 'function'
      || typeof requestCollectorAuth !== 'function'
    ) {
      throw new TypeError('frontend tab opener dependencies are required');
    }

    const requestAuthBestEffort = async (tabId, reused) => {
      if (!Number.isInteger(tabId)) return;
      try {
        await requestCollectorAuth(tabId);
      } catch (error) {
        const message = String(error?.message || error || '');
        if (!reused || !/Receiving end does not exist/i.test(message)) return;
        try {
          await injectCollectorAuth(tabId);
          await requestCollectorAuth(tabId);
        } catch {}
      }
    };

    const openedResult = async ({ reused, tabId }) => {
      const result = { opened: true, reused };
      if (Number.isInteger(tabId)) result.tabId = tabId;
      await requestAuthBestEffort(tabId, reused);
      return result;
    };

    const createNewTab = async (url) => {
      try {
        const created = await createTab({ url, active: true });
        return openedResult({ reused: false, tabId: created?.id });
      } catch {
        return { opened: false };
      }
    };

    const open = async ({ url } = {}) => {
      let tabs;
      try {
        tabs = await queryTabs();
      } catch {
        return { opened: false };
      }

      const existing = Array.isArray(tabs)
        ? tabs.find((tab) => Number.isInteger(tab?.id))
        : null;
      if (!existing) return createNewTab(url);

      try {
        await updateTab(existing.id, { active: true });
        if (Number.isInteger(existing.windowId)) {
          await updateWindow(existing.windowId, { focused: true });
        }
        return openedResult({ reused: true, tabId: existing.id });
      } catch {
        return createNewTab(url);
      }
    };

    return Object.freeze({ open });
  };

  const api = Object.freeze({ createFrontendTabOpener });
  root.JzFrontendTabOpener = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
