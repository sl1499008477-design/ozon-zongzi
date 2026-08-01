(function (root) {
  'use strict';

  const STORAGE_PREFIX = 'sonliSellerCompanyContext:';
  const RECOVERY_FAILURE_COOLDOWN_MS = 30_000;

  const createSellerCompanyContextRuntime = ({
    chromeApi = root.chrome,
    policy = root.JzSellerIdentityPolicy,
    now = () => Date.now(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
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
    const recoverableContextError = (error) => [
      'SELLER_CONTEXT_REQUIRED',
      'SELLER_COMPANY_CONTEXT_REQUIRED',
    ].includes(error?.message);
    let recoveryPromise = null;
    let recoveryBlockedUntil = 0;

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

    const recoverCurrent = async ({ timeoutMs = 7_000, pollIntervalMs = 250 } = {}) => {
      const sellerTabs = (await chromeApi.tabs.query({
        url: 'https://seller.ozon.ru/*',
      })).filter((tab) => policy.isTrustedSellerTab(tab));
      if (!sellerTabs.length) throw new Error('SELLER_CONTEXT_REQUIRED');

      const sellerTab = sellerTabs.find((tab) => tab.active) || sellerTabs[0];
      const startedAt = now();
      try {
        await chromeApi.tabs.reload(sellerTab.id);
      } catch (error) {
        throw Object.assign(new Error('SELLER_CONTEXT_RECOVERY_FAILED'), { cause: error });
      }

      const safeTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs)
        : 7_000;
      const safePollIntervalMs = Number.isFinite(Number(pollIntervalMs)) && Number(pollIntervalMs) > 0
        ? Number(pollIntervalMs)
        : 250;
      while (now() - startedAt < safeTimeoutMs) {
        const remainingMs = safeTimeoutMs - (now() - startedAt);
        await sleep(Math.min(safePollIntervalMs, remainingMs));
        try {
          return await resolveCurrent();
        } catch (error) {
          if (!recoverableContextError(error)) throw error;
        }
      }
      throw new Error('SELLER_CONTEXT_RECOVERY_FAILED');
    };

    const resolveCurrentWithRecovery = async (options = {}) => {
      try {
        const resolved = await resolveCurrent();
        recoveryBlockedUntil = 0;
        return resolved;
      } catch (error) {
        if (!recoverableContextError(error)) throw error;
      }

      if (now() < recoveryBlockedUntil) {
        throw new Error('SELLER_CONTEXT_RECOVERY_FAILED');
      }
      if (!recoveryPromise) recoveryPromise = recoverCurrent(options);
      const currentRecovery = recoveryPromise;
      try {
        return await currentRecovery;
      } catch (error) {
        if (error?.message === 'SELLER_CONTEXT_RECOVERY_FAILED') {
          recoveryBlockedUntil = Math.max(recoveryBlockedUntil, now() + RECOVERY_FAILURE_COOLDOWN_MS);
        }
        throw error;
      } finally {
        if (recoveryPromise === currentRecovery) recoveryPromise = null;
      }
    };

    return Object.freeze({
      observationsForTabs,
      rememberFromSender,
      resolveCurrent,
      resolveCurrentWithRecovery,
    });
  };

  const api = Object.freeze({
    createSellerCompanyContextRuntime,
    STORAGE_PREFIX,
  });
  root.JzSellerCompanyContextRuntime = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
