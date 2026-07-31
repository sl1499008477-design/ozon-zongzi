(() => {
  'use strict';
  const context = globalThis.JzSellerCompanyContext;
  if (!context || globalThis.__JZ_SELLER_COMPANY_CONTEXT_HOOK__) return;
  globalThis.__JZ_SELLER_COMPANY_CONTEXT_HOOK__ = true;

  const MESSAGE_MARKER = '__jzSellerCompanyContext';
  const CONTEXT_TYPE = 'JZ_SELLER_COMPANY_CONTEXT';
  const QUERY_TYPE = 'JZ_SELLER_COMPANY_CONTEXT_QUERY';
  let latestCompanyId = '';

  const publish = (companyId) => {
    latestCompanyId = context.normalizeCompanyId(companyId);
    if (!latestCompanyId) return;
    window.postMessage({
      [MESSAGE_MARKER]: 1,
      type: CONTEXT_TYPE,
      companyId: latestCompanyId,
    }, window.location.origin);
  };

  context.installObserver({ root: window, onCompanyId: publish });
  window.addEventListener('message', (event) => {
    if (
      event.source !== window
      || event.origin !== window.location.origin
      || event.data?.[MESSAGE_MARKER] !== 1
      || event.data?.type !== QUERY_TYPE
      || !latestCompanyId
    ) {
      return;
    }
    publish(latestCompanyId);
  });
})();
