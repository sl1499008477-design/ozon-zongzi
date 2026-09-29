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
  const getSellerOrigin = () => root.JzActiveSellerRoute?.getOrigin() || 'https://seller.ozon.ru';
  const isLoginUrl = (value) => {
    try {
      const url = new URL(String(value || ''));
      return url.origin === getSellerOrigin()
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
      const tab = await chromeApi.tabs.create({ url: getSellerOrigin() + '/app', active: false });
      const record = { tabId: Number(tab.id), active: false };
      await chromeApi.storage.session.set({ [HELPER_STORAGE_KEY]: record });
      return { record, tab };
    };

    // Legacy snapshot callers have no lease to release. The helper stays open
    // for subsequent work, including after a service-worker restart.
    const releaseOwnedSnapshot = async () => false;

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
      let current;
      try {
        current = await readCurrent();
      } catch (error) {
        const code = errorCode(error);
        if (code === 'SELLER_CONTEXT_RECOVERING') return { status: STATUS.RECOVERING };
        if (
          code === 'SELLER_CONTEXT_REQUIRED'
          || code === 'SELLER_COMPANY_CONTEXT_REQUIRED'
        ) return null;
        throw error;
      }
      const sellerTabId = Number(current?.sellerTabId);
      if (!Number.isInteger(sellerTabId) || sellerTabId <= 0) return null;
      try {
        const sellerTab = await chromeApi.tabs.get(sellerTabId);
        if (!isOwnedHelperTab(sellerTab, policy)) return null;
      } catch {
        return null;
      }
      return { status: STATUS.READY, ...current };
    };

    const queryBridge = async (tab) => {
      if (!policy.isTrustedSellerTab(tab)) return;
      try {
        // An extension update invalidates old isolated-world listeners without
        // navigating Seller tabs. Restore the idempotent scripts before asking
        // the page-world observer for its current company; do not reload tabs.
        await chromeApi.scripting?.executeScript({
          target: { tabId: Number(tab.id), frameIds: [0] },
          world: 'MAIN',
          files: ['lib/seller-company-context.js', 'content/seller-company-context-hook.js'],
        });
        await chromeApi.scripting?.executeScript({
          target: { tabId: Number(tab.id), frameIds: [0] },
          world: 'ISOLATED',
          files: ['content/ozon-seller-bridge.js'],
        });
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
      await root.JzActiveSellerRoute?.ready;
      const immediate = await readStatus();
      if (immediate?.status === STATUS.READY) {
        return immediate;
      }
      if (immediate) return immediate;

      const stableHelper = await taggedHelper();
      const trustedTabs = (await chromeApi.tabs.query({
        url: getSellerOrigin() + '/*',
      })).filter((tab) => isOwnedHelperTab(tab, policy));
      const userTabs = trustedTabs.filter((tab) => tab.id !== stableHelper?.record.tabId);
      if (!userTabs.length && stableHelper?.record.status === STATUS.LOGIN_REQUIRED) {
        return { status: STATUS.LOGIN_REQUIRED, helperTabId: stableHelper.record.tabId };
      }

      const recoveryTabs = userTabs.length ? userTabs : trustedTabs;
      await Promise.all(recoveryTabs.map(queryBridge));

      const safePollIntervalMs = positiveMs(pollIntervalMs, 250);
      const safeProbeTimeoutMs = positiveMs(probeTimeoutMs, 500);
      const probed = await pollCurrent({
        durationMs: recoveryTabs.length ? positiveMs(timeoutMs, 7_000) : safeProbeTimeoutMs,
        pollIntervalMs: safePollIntervalMs,
        helper: userTabs.length ? null : stableHelper,
      });
      if (probed?.status === STATUS.READY) return probed;
      if (probed) return probed;

      // An existing Seller page may still be initializing. Keep using it rather
      // than opening another page after the short initial bridge probe.
      if (recoveryTabs.length) {
        if (!userTabs.length && stableHelper) return markLoginRequired(stableHelper);
        return {
          status: recoveryTabs.some((tab) => isLoginUrl(effectiveTabUrl(tab)))
            ? STATUS.LOGIN_REQUIRED
            : STATUS.RECOVERING,
        };
      }

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
        return recovered;
      }
      if (recovered) return recovered;
      return markLoginRequired(helper);
    };

    const resolveShared = (options) => {
      if (!recoveryPromise) {
        recoveryPromise = resolve(options).then(async (snapshot) => {
          if (snapshot?.status === STATUS.READY) {
            const helper = await taggedHelper();
            if (helper?.record.status === STATUS.LOGIN_REQUIRED
              && helper.record.tabId === Number(snapshot.sellerTabId)) {
              const { status, ...record } = helper.record;
              await chromeApi.storage.session.set({ [HELPER_STORAGE_KEY]: record });
            }
          }
          return snapshot;
        }).finally(() => {
          recoveryPromise = null;
        });
      }
      return recoveryPromise;
    };

    const resolveCurrentWithRecovery = (options) => resolveShared(options);

    const acquireCurrentWithRecovery = async (options) => {
      const snapshot = await resolveShared(options);
      let retainedTabId = null;
      if (snapshot?.status === STATUS.READY) {
        const helper = await taggedHelper();
        const sellerTabId = Number(snapshot.sellerTabId);
        if (helper && helper.record.tabId === sellerTabId) {
          retainedTabId = sellerTabId;
        }
      }

      let released = false;
      return Object.freeze({
        snapshot,
        release: async () => {
          if (released) return false;
          released = true;
          return retainedTabId !== null;
        },
      });
    };

    const focusLoginHelper = async () => {
      const helper = await taggedHelper();
      if (!helper) return false;
      try {
        await chromeApi.tabs.update(helper.record.tabId, { active: true });
        return true;
      } catch {
        const stored = await chromeApi.storage.session.get(HELPER_STORAGE_KEY);
        if (Number(stored?.[HELPER_STORAGE_KEY]?.tabId) === helper.record.tabId) {
          await chromeApi.storage.session.remove(HELPER_STORAGE_KEY);
        }
        return false;
      }
    };

    return Object.freeze({
      acquireCurrentWithRecovery,
      focusLoginHelper,
      releaseOwnedSnapshot,
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
