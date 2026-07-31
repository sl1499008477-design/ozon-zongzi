(function (root) {
  'use strict';

  const STORAGE_PREFIX = 'sonliSellerCompanyContext:';

  const createSellerCompanyContextRuntime = ({
    chromeApi = root.chrome,
    policy = root.JzSellerIdentityPolicy,
    now = () => Date.now(),
  } = {}) => {
    if (
      !chromeApi?.storage?.session
      || !chromeApi?.tabs
      || !chromeApi?.cookies
      || !policy?.resolveTrustedSellerCompanyContext
    ) {
      throw new TypeError('seller company context runtime dependencies are required');
    }
    const storageKey = (tabId) => `${STORAGE_PREFIX}${Number(tabId)}`;

    const rememberFromSender = async (sender, rawCompanyId) => {
      const tab = sender?.tab;
      if (!policy.isTrustedSellerTab(tab) || Number(sender?.frameId || 0) !== 0) {
        throw new Error('SELLER_CONTEXT_REQUIRED');
      }
      const companyId = policy.normalizeCompanyId(rawCompanyId);
      if (!companyId) throw new Error('SELLER_COMPANY_CONTEXT_INVALID');
      await chromeApi.storage.session.set({
        [storageKey(tab.id)]: {
          companyId,
          observedAt: now(),
        },
      });
      return { companyId, sellerTabId: Number(tab.id) };
    };

    const observationsForTabs = async (sellerTabs) => {
      const keys = (sellerTabs || []).map((tab) => storageKey(tab.id));
      if (!keys.length) return [];
      const stored = await chromeApi.storage.session.get(keys);
      return sellerTabs.flatMap((tab) => {
        const value = stored?.[storageKey(tab.id)];
        return value
          ? [{
              tabId: Number(tab.id),
              companyId: value.companyId,
              observedAt: value.observedAt,
            }]
          : [];
      });
    };

    const resolveCurrent = async () => {
      const sellerTabs = await chromeApi.tabs.query({
        url: 'https://seller.ozon.ru/*',
      });
      const cookies = await chromeApi.cookies.getAll({
        url: 'https://seller.ozon.ru/',
        name: 'sc_company_id',
      });
      return policy.resolveTrustedSellerCompanyContext({
        cookies,
        observations: await observationsForTabs(sellerTabs),
        sellerTabs,
        now: now(),
      });
    };

    return Object.freeze({
      observationsForTabs,
      rememberFromSender,
      resolveCurrent,
    });
  };

  const api = Object.freeze({
    createSellerCompanyContextRuntime,
    STORAGE_PREFIX,
  });
  root.JzSellerCompanyContextRuntime = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
