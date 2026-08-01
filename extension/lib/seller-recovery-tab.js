(function (root) {
  'use strict';

  const HELPER_STORAGE_KEY = 'sonliSellerRecoveryTab';
  const HELPER_URL = 'https://seller.ozon.ru/app';
  const STATUS = Object.freeze({
    READY: 'READY',
    RECOVERING: 'RECOVERING',
    LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  });

  const errorCode = (error) => String(error?.code || error?.message || '');
  const positiveMs = (value, fallback) => (
    Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback
  );
  const effectiveTabUrl = (tab) => String(tab?.pendingUrl || tab?.url || '');
  const isOwnedHelperTab = (tab, policy) => policy.isTrustedSellerTab({
    ...tab,
    url: effectiveTabUrl(tab),
  });
  const isLoginUrl = (value) => {
    try {
      const url = new URL(String(value || ''));
      return url.origin === 'https://seller.ozon.ru'
        && /(?:^|[/.\-_])(login|signin|auth)(?:$|[/.\-_])/i.test(url.pathname);
    } catch {
      return false;
    }
  };

  const createSellerRecoveryTabManager = ({
    chromeApi = root.chrome,
    policy = root.JzSellerIdentityPolicy,
    readCurrent,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) => {
    if (
      !chromeApi?.storage?.session
      || !chromeApi?.tabs
      || !policy?.isTrustedSellerTab
      || typeof readCurrent !== 'function'
    ) {
      throw new TypeError('seller recovery tab dependencies are required');
    }

    let recoveryPromise = null;

    const taggedHelper = async () => {
      const stored = await chromeApi.storage.session.get(HELPER_STORAGE_KEY);
      const record = stored?.[HELPER_STORAGE_KEY];
      const tabId = Number(record?.tabId);
      if (!Number.isInteger(tabId) || tabId <= 0 || record?.active !== false) return null;
      try {
        const tab = await chromeApi.tabs.get(tabId);
        if (!isOwnedHelperTab(tab, policy)) {
          await chromeApi.storage.session.remove(HELPER_STORAGE_KEY);
          return null;
        }
        return { record, tab };
      } catch {
        await chromeApi.storage.session.remove(HELPER_STORAGE_KEY);
        return null;
      }
    };

    const createHelper = async () => {
      const existing = await taggedHelper();
      if (existing) return existing;
      const tab = await chromeApi.tabs.create({ url: HELPER_URL, active: false });
      const record = { tabId: Number(tab.id), active: false };
      await chromeApi.storage.session.set({ [HELPER_STORAGE_KEY]: record });
      return { record, tab };
    };

    const closeTaggedHelper = async () => {
      const helper = await taggedHelper();
      if (!helper) return;
      await chromeApi.tabs.remove(helper.record.tabId);
      await chromeApi.storage.session.remove(HELPER_STORAGE_KEY);
    };

    const markLoginRequired = async (helper) => {
      const tagged = await taggedHelper();
      if (!tagged || tagged.record.tabId !== helper.record.tabId) {
        return { status: STATUS.LOGIN_REQUIRED };
      }
      const record = { ...tagged.record, status: STATUS.LOGIN_REQUIRED };
      await chromeApi.storage.session.set({ [HELPER_STORAGE_KEY]: record });
      return { status: STATUS.LOGIN_REQUIRED, helperTabId: record.tabId };
    };

    const readStatus = async () => {
      try {
        return { status: STATUS.READY, ...(await readCurrent()) };
      } catch (error) {
        const code = errorCode(error);
        if (code === 'SELLER_CONTEXT_RECOVERING') return { status: STATUS.RECOVERING };
        if (
          code === 'SELLER_CONTEXT_REQUIRED'
          || code === 'SELLER_COMPANY_CONTEXT_REQUIRED'
        ) return null;
        throw error;
      }
    };

    const queryBridge = async (tab) => {
      if (!policy.isTrustedSellerTab(tab)) return;
      try {
        await chromeApi.scripting?.executeScript({
          target: { tabId: Number(tab.id), frameIds: [0] },
          world: 'MAIN',
          func: () => window.postMessage({
            __jzSellerCompanyContext: 1,
            type: 'JZ_SELLER_COMPANY_CONTEXT_QUERY',
          }, window.location.origin),
        });
      } catch {}
    };

    const pollCurrent = async ({ durationMs, pollIntervalMs, helper }) => {
      let elapsedMs = 0;
      while (elapsedMs < durationMs) {
        const delayMs = Math.min(pollIntervalMs, durationMs - elapsedMs);
        await sleep(delayMs);
        elapsedMs += delayMs;
        const current = await readStatus();
        if (current) return current;
        if (helper) {
          try {
            const tagged = await taggedHelper();
            if (!tagged || tagged.record.tabId !== helper.record.tabId) return null;
            if (isLoginUrl(effectiveTabUrl(tagged.tab))) {
              return markLoginRequired(tagged);
            }
          } catch {
            return null;
          }
        }
      }
      return null;
    };

    const resolve = async ({
      timeoutMs = 7_000,
      pollIntervalMs = 250,
      probeTimeoutMs = 500,
    } = {}) => {
      const immediate = await readStatus();
      if (immediate?.status === STATUS.READY) {
        await closeTaggedHelper();
        return immediate;
      }
      if (immediate) return immediate;

      const stableHelper = await taggedHelper();
      if (stableHelper?.record.status === STATUS.LOGIN_REQUIRED) {
        return { status: STATUS.LOGIN_REQUIRED, helperTabId: stableHelper.record.tabId };
      }

      const trustedTabs = (await chromeApi.tabs.query({
        url: 'https://seller.ozon.ru/*',
      })).filter((tab) => policy.isTrustedSellerTab(tab));
      await Promise.all(trustedTabs.map(queryBridge));

      const safePollIntervalMs = positiveMs(pollIntervalMs, 250);
      const safeProbeTimeoutMs = positiveMs(probeTimeoutMs, 500);
      const probed = await pollCurrent({
        durationMs: safeProbeTimeoutMs,
        pollIntervalMs: safePollIntervalMs,
      });
      if (probed?.status === STATUS.READY) return probed;
      if (probed) return probed;

      const helper = await createHelper();
      if (isLoginUrl(effectiveTabUrl(helper.tab))) {
        return markLoginRequired(helper);
      }
      await queryBridge(helper.tab);
      const recovered = await pollCurrent({
        durationMs: positiveMs(timeoutMs, 7_000),
        pollIntervalMs: safePollIntervalMs,
        helper,
      });
      if (recovered?.status === STATUS.READY) {
        await closeTaggedHelper();
        return recovered;
      }
      if (recovered) return recovered;
      return markLoginRequired(helper);
    };

    const resolveCurrentWithRecovery = (options) => {
      if (!recoveryPromise) {
        recoveryPromise = resolve(options).finally(() => {
          recoveryPromise = null;
        });
      }
      return recoveryPromise;
    };

    const focusLoginHelper = async () => {
      const helper = await taggedHelper();
      if (!helper) return false;
      await chromeApi.tabs.update(helper.record.tabId, { active: true });
      return true;
    };

    return Object.freeze({
      focusLoginHelper,
      resolveCurrentWithRecovery,
    });
  };

  const api = Object.freeze({
    createSellerRecoveryTabManager,
    HELPER_STORAGE_KEY,
    HELPER_URL,
    STATUS,
  });
  root.JzSellerRecoveryTab = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
