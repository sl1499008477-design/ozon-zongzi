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
    onContextAdvance,
    ttlMs = DEFAULT_TTL_MS,
    stabilizationWindowMs = DEFAULT_STABILIZATION_WINDOW_MS,
  } = {}) => {
    if (
      !chromeApi?.storage?.session
      || !chromeApi?.tabs
      || !policy?.isTrustedSellerTab
      || !policy?.normalizeCompanyId
      || !recoveryTab?.createSellerRecoveryTabManager
      || (onContextAdvance != null && typeof onContextAdvance !== 'function')
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
    let observationEpoch = 0;
    let synchronizedEpoch = 0;

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
      const tab = sender?.tab;
      if (!policy.isTrustedSellerTab(tab) || Number(sender?.frameId) !== 0) {
        return Promise.reject(contextError('SELLER_CONTEXT_REQUIRED'));
      }
      const companyId = policy.normalizeCompanyId(rawCompanyId);
      if (!companyId) return Promise.reject(contextError('SELLER_COMPANY_CONTEXT_INVALID'));

      // Advance before the first await. A result submission in the same event-loop
      // turn must see the observation intent even while storage or server sync is pending.
      observationEpoch += 1;
      const intentEpoch = observationEpoch;
      const write = observationWrites.catch(() => {}).then(async () => {
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
        const snapshot = Object.freeze({
          companyId: observation.companyId,
          revision: observation.revision,
          observedAt: observation.observedAt,
          sellerTabId: observation.tabId,
        });
        await onContextAdvance?.(snapshot);
        synchronizedEpoch = intentEpoch;
        return snapshot;
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

    const submitIfCurrent = async (snapshot, submit) => {
      if (typeof submit !== 'function') {
        throw new TypeError('Seller context submission callback is required');
      }
      while (true) {
        const epoch = observationEpoch;
        const writes = observationWrites;
        await writes;
        if (epoch !== observationEpoch || writes !== observationWrites) continue;
        if (synchronizedEpoch !== epoch) return false;
        if (!(await isSnapshotCurrent(snapshot))) return false;
        if (epoch !== observationEpoch || writes !== observationWrites) continue;

        // There is no await between the final epoch check and invoking submit.
        // A later switch races only with the in-flight server request, where the
        // server watermark/CAS defines the authoritative order.
        return submit();
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
      submitIfCurrent,
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
