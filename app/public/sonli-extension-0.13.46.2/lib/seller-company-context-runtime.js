(function (root) {
  'use strict';

  const STORAGE_PREFIX = 'sonliSellerCompanyContext:';
  const CURRENT_STORAGE_KEY = `${STORAGE_PREFIX}current`;
  const PREVIOUS_STORAGE_KEY = `${STORAGE_PREFIX}previous`;
  const DEFAULT_TTL_MS = 10 * 60 * 1000;
  const DEFAULT_STABILIZATION_WINDOW_MS = 1_000;

  const contextError = (code) => Object.assign(new Error(code), { code });

  const createSellerCompanyContextRuntime = ({
    chromeApi = root.chrome,
    policy = root.JzSellerIdentityPolicy,
    recoveryTab = root.JzSellerRecoveryTab,
    now = () => Date.now(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ttlMs = DEFAULT_TTL_MS,
    stabilizationWindowMs = DEFAULT_STABILIZATION_WINDOW_MS,
  } = {}) => {
    if (
      !chromeApi?.storage?.session
      || !chromeApi?.tabs
      || !policy?.isTrustedSellerTab
      || !policy?.normalizeCompanyId
      || !recoveryTab?.createSellerRecoveryTabManager
    ) {
      throw new TypeError('seller company context runtime dependencies are required');
    }

    const storageKey = (tabId) => `${STORAGE_PREFIX}${Number(tabId)}`;
    const safeTtlMs = Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS);
    const safeStabilizationWindowMs = Math.max(
      0,
      Number(stabilizationWindowMs) || 0,
    );
    let observationWrites = Promise.resolve();

    const normalizeStored = (value) => {
      const companyId = policy.normalizeCompanyId(value?.companyId);
      const observedAt = Number(value?.observedAt);
      const revision = Number(value?.revision);
      const tabId = Number(value?.tabId);
      if (
        !companyId
        || !Number.isFinite(observedAt)
        || !Number.isInteger(revision)
        || revision <= 0
        || !Number.isInteger(tabId)
        || tabId <= 0
      ) return null;
      return { companyId, observedAt, revision, tabId };
    };

    const rememberFromSender = (sender, rawCompanyId) => {
      const write = observationWrites.catch(() => {}).then(async () => {
        const tab = sender?.tab;
        if (!policy.isTrustedSellerTab(tab) || Number(sender?.frameId) !== 0) {
          throw contextError('SELLER_CONTEXT_REQUIRED');
        }
        const companyId = policy.normalizeCompanyId(rawCompanyId);
        if (!companyId) throw contextError('SELLER_COMPANY_CONTEXT_INVALID');

        const stored = await chromeApi.storage.session.get(CURRENT_STORAGE_KEY);
        const current = normalizeStored(stored?.[CURRENT_STORAGE_KEY]);
        const observation = {
          companyId,
          observedAt: now(),
          revision: current
            ? current.revision + (current.companyId === companyId ? 0 : 1)
            : 1,
          tabId: Number(tab.id),
        };
        const values = {
          [CURRENT_STORAGE_KEY]: observation,
          [storageKey(tab.id)]: observation,
        };
        if (current && current.companyId !== companyId) {
          values[PREVIOUS_STORAGE_KEY] = current;
        }
        await chromeApi.storage.session.set(values);
        return {
          companyId: observation.companyId,
          revision: observation.revision,
          observedAt: observation.observedAt,
          sellerTabId: observation.tabId,
        };
      });
      observationWrites = write.catch(() => {});
      return write;
    };

    const observationsForTabs = async (sellerTabs) => {
      const trustedTabs = (sellerTabs || []).filter((tab) => policy.isTrustedSellerTab(tab));
      const keys = trustedTabs.map((tab) => storageKey(tab.id));
      if (!keys.length) return [];
      const stored = await chromeApi.storage.session.get(keys);
      return trustedTabs.flatMap((tab) => {
        const observation = normalizeStored(stored?.[storageKey(tab.id)]);
        return observation ? [observation] : [];
      });
    };

    const allObservations = async () => {
      const stored = await chromeApi.storage.session.get(null);
      return Object.entries(stored || {}).flatMap(([key, value]) => (
        /^sonliSellerCompanyContext:\d+$/.test(key)
          ? [normalizeStored(value)].filter(Boolean)
          : []
      ));
    };

    const snapshotCurrent = async () => {
      await observationWrites;
      const stored = await chromeApi.storage.session.get([
        CURRENT_STORAGE_KEY,
        PREVIOUS_STORAGE_KEY,
      ]);
      const current = normalizeStored(stored?.[CURRENT_STORAGE_KEY]);
      const previous = normalizeStored(stored?.[PREVIOUS_STORAGE_KEY]);
      const currentTime = Number(now());
      if (
        !current
        || current.observedAt > currentTime + 5_000
        || currentTime - current.observedAt > safeTtlMs
      ) throw contextError('SELLER_CONTEXT_REQUIRED');

      if (safeStabilizationWindowMs > 0) {
        const competing = [previous, ...(await allObservations())]
          .filter(Boolean)
          .some((observation) => (
          observation.companyId !== current.companyId
          && currentTime - observation.observedAt <= safeStabilizationWindowMs
          && observation.observedAt <= currentTime + 5_000
          ));
        if (competing) throw contextError('SELLER_CONTEXT_RECOVERING');
      }
      return {
        companyId: current.companyId,
        revision: current.revision,
        observedAt: current.observedAt,
        sellerTabId: current.tabId,
      };
    };

    const recovery = recoveryTab.createSellerRecoveryTabManager({
      chromeApi,
      policy,
      readCurrent: snapshotCurrent,
      sleep,
    });

    const acquireCurrentWithRecovery = (options) => recovery.acquireCurrentWithRecovery(options);
    const resolveCurrent = snapshotCurrent;
    const resolveCurrentWithRecovery = (options) => recovery.resolveCurrentWithRecovery(options);
    const releaseSnapshot = (snapshot) => recovery.releaseOwnedSnapshot(snapshot);
    const isSnapshotCurrent = async (snapshot) => {
      try {
        const current = await snapshotCurrent();
        return current.companyId === policy.normalizeCompanyId(snapshot?.companyId)
          && current.revision === Number(snapshot?.revision);
      } catch {
        return false;
      }
    };

    return Object.freeze({
      acquireCurrentWithRecovery,
      focusLoginHelper: recovery.focusLoginHelper,
      isSnapshotCurrent,
      observationsForTabs,
      releaseSnapshot,
      rememberFromSender,
      resolveCurrent,
      resolveCurrentWithRecovery,
      snapshotCurrent,
    });
  };

  const api = Object.freeze({
    createSellerCompanyContextRuntime,
    CURRENT_STORAGE_KEY,
    DEFAULT_STABILIZATION_WINDOW_MS,
    PREVIOUS_STORAGE_KEY,
    STORAGE_PREFIX,
  });
  root.JzSellerCompanyContextRuntime = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
