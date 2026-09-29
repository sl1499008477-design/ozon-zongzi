(() => {
  'use strict';
  const context = globalThis.JzSellerCompanyContext;
  if (
    !context
    || globalThis.__JZ_SELLER_COMPANY_CONTEXT_HOOK__
    || window.top !== window
    || !['https://seller.ozon.ru', 'https://seller.ozonru.cn'].includes(window.location.origin)
  ) return;
  globalThis.__JZ_SELLER_COMPANY_CONTEXT_HOOK__ = true;

  const MESSAGE_MARKER = '__jzSellerCompanyContext';
  const CONTEXT_TYPE = 'JZ_SELLER_COMPANY_CONTEXT';
  const QUERY_TYPE = 'JZ_SELLER_COMPANY_CONTEXT_QUERY';
  const SWITCHER_RETRY_MS = 1_000;
  const SWITCHER_MAX_ATTEMPTS = 15;
  let latestCompanyId = '';
  let switcherResolution = null;

  const publish = (companyId) => {
    latestCompanyId = context.normalizeCompanyId(companyId);
    if (!latestCompanyId) return;
    window.postMessage({
      [MESSAGE_MARKER]: 1,
      type: CONTEXT_TYPE,
      companyId: latestCompanyId,
    }, window.location.origin);
  };

  const resolveFromVisibleSwitcher = async () => {
    if (
      latestCompanyId
      || switcherResolution
      || typeof document === 'undefined'
      || typeof context.companyIdFromSellerSwitcher !== 'function'
    ) return switcherResolution;
    switcherResolution = (async () => {
      const header = document.querySelector('[data-onboarding-target="headerCompanyName"]');
      if (!header) return '';
      const activeName = String(header.innerText || header.textContent || '').trim();
      const toggle = header.querySelector('[aria-expanded]') || header;
      const wasExpanded = toggle.getAttribute?.('aria-expanded') === 'true';
      if (!wasExpanded) toggle.click?.();
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        const entries = [...document.querySelectorAll('[id^="tippy-"] *')]
          .map((element) => context.sellerSwitcherEntryFromText(element.innerText || ''))
          .filter(Boolean);
        const companyId = context.companyIdFromSellerSwitcher({ activeName, entries });
        if (companyId) publish(companyId);
        return companyId;
      } finally {
        if (!wasExpanded && toggle.getAttribute?.('aria-expanded') === 'true') {
          toggle.click?.();
        }
      }
    })().catch(() => '').finally(() => {
      switcherResolution = null;
    });
    return switcherResolution;
  };

  const resolveFromVisibleSwitcherWithRetry = async (attemptsRemaining) => {
    const companyId = await resolveFromVisibleSwitcher();
    if (!companyId && !latestCompanyId && attemptsRemaining > 1) {
      setTimeout(() => {
        void resolveFromVisibleSwitcherWithRetry(attemptsRemaining - 1);
      }, SWITCHER_RETRY_MS);
    }
  };

  context.installObserver({ root: window, onCompanyId: publish });
  window.addEventListener('message', (event) => {
    if (
      event.source !== window
      || event.origin !== window.location.origin
      || event.data?.[MESSAGE_MARKER] !== 1
      || event.data?.type !== QUERY_TYPE
    ) {
      return;
    }
    if (latestCompanyId) publish(latestCompanyId);
    else void resolveFromVisibleSwitcher();
  });
  if (typeof document !== 'undefined' && typeof setTimeout === 'function') {
    setTimeout(() => {
      void resolveFromVisibleSwitcherWithRetry(SWITCHER_MAX_ATTEMPTS);
    }, 1_500);
  }
})();
