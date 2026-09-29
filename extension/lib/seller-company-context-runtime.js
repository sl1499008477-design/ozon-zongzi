(function (root) {
  'use strict';

  const STORAGE_PREFIX = 'sonliSellerCompanyContext:';
  const CURRENT_STORAGE_KEY = `${STORAGE_PREFIX}current`;
  const PREVIOUS_STORAGE_KEY = `${STORAGE_PREFIX}previous`;
  const ROUTE_REVISION_KEY = `${STORAGE_PREFIX}routeRevision`;
  const DEFAULT_TTL_MS = 10 * 60 * 1000;
  const DEFAULT_STABILIZATION_WINDOW_MS = 1_000;
  const DEFAULT_CONTEXT_SYNC_TIMEOUT_MS = 5_000;

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
    contextSyncTimeoutMs = DEFAULT_CONTEXT_SYNC_TIMEOUT_MS,
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
    const safeContextSyncTimeoutMs = Math.max(
      1,
      Number(contextSyncTimeoutMs) || DEFAULT_CONTEXT_SYNC_TIMEOUT_MS,
    );
    let observationWrites = Promise.resolve();
    let observationEpoch = 0;
    let synchronizedEpoch = 0;

    const synchronizeContext = async (snapshot) => {
      if (typeof onContextAdvance !== 'function') return;
      let timeoutId;
      try {
        await Promise.race([
          Promise.resolve().then(() => onContextAdvance(snapshot)),
          new Promise((_, reject) => {
            timeoutId = setTimeout(
              () => reject(contextError('SELLER_CONTEXT_SYNC_TIMEOUT')),
              safeContextSyncTimeoutMs,
            );
          }),
        ]);
      } catch (error) {
        if (/^(?:SELLER_CONTEXT_SYNC_|COLLECTOR_)/.test(error?.code || '')) throw error;
        throw contextError('SELLER_CONTEXT_SYNC_FAILED');
      } finally {
        if (timeoutId != null) clearTimeout(timeoutId);
      }
    };

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
        const stored = await chromeApi.storage.session.get([CURRENT_STORAGE_KEY, ROUTE_REVISION_KEY]);
        const current = normalizeStored(stored?.[CURRENT_STORAGE_KEY]);
        const observation = {
          companyId,
          observedAt: now(),
          revision: current
            ? current.revision + (current.companyId === companyId ? 0 : 1)
            : (Number(stored?.[ROUTE_REVISION_KEY]) || 0) + 1,
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
        await synchronizeContext(snapshot);
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

    const recoverFromTrustedBrowserState = async () => {
      if (
        typeof chromeApi.cookies?.getAll !== 'function'
        || typeof policy.resolveTrustedSellerCompanyContext !== 'function'
      ) return null;
      const sellerTabs = (await chromeApi.tabs.query({
        url: policy.getSellerOrigin() + '/*',
      })).filter((tab) => policy.isTrustedSellerTab(tab));
      if (!sellerTabs.length) return null;
      const cookies = await chromeApi.cookies.getAll({
        url: policy.getSellerOrigin() + '/',
        name: 'sc_company_id',
      });
      const identity = policy.resolveTrustedSellerCompanyContext({
        cookies,
        observations: await observationsForTabs(sellerTabs),
        sellerTabs,
        now: Number(now()),
        ttlMs: safeTtlMs,
        stabilizationWindowMs: safeStabilizationWindowMs,
      });
      const sellerTab = sellerTabs.find((tab) => Number(tab.id) === Number(identity.sellerTabId));
      if (!sellerTab) return null;
      return rememberFromSender({ tab: sellerTab, frameId: 0 }, identity.companyId);
    };

    const snapshotCurrent = async () => {
      await root.JzActiveSellerRoute?.ready;
      await observationWrites;
      let stored = await chromeApi.storage.session.get([
        CURRENT_STORAGE_KEY,
        PREVIOUS_STORAGE_KEY,
      ]);
      let current = normalizeStored(stored?.[CURRENT_STORAGE_KEY]);
      const currentTime = Number(now());
      if (
        !current
        || current.observedAt > currentTime + 5_000
        || currentTime - current.observedAt > safeTtlMs
      ) {
        try {
          await recoverFromTrustedBrowserState();
        } catch (error) {
          // A trusted observation is still usable for read-only status when its
          // backend receipt is unavailable. Execution separately requires sync.
          if (!/^(?:SELLER_CONTEXT_SYNC_|COLLECTOR_)/.test(error?.code || '')) throw error;
        }
        stored = await chromeApi.storage.session.get([
          CURRENT_STORAGE_KEY,
          PREVIOUS_STORAGE_KEY,
        ]);
        current = normalizeStored(stored?.[CURRENT_STORAGE_KEY]);
      }
      const previous = normalizeStored(stored?.[PREVIOUS_STORAGE_KEY]);
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

    const acquireCurrentWithRecovery = async (options) => {
      const lease = await recovery.acquireCurrentWithRecovery(options);
      try {
        if (lease.snapshot?.status === 'READY'
          && !(await submitIfCurrent(lease.snapshot, () => true))) {
          throw contextError('SELLER_CONTEXT_CHANGED');
        }
        return lease;
      } catch (error) {
        await lease.release();
        throw error;
      }
    };
    const resolveCurrent = snapshotCurrent;
    const resolveCurrentWithRecovery = async (options) => {
      const snapshot = await recovery.resolveCurrentWithRecovery(options);
      if (snapshot?.status !== 'READY') return snapshot;
      return await submitIfCurrent(snapshot, () => snapshot) || { status: 'RECOVERING' };
    };
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

    const resynchronizeIfCurrent = (snapshot, epoch) => {
      const write = observationWrites.catch(() => {}).then(async () => {
        if (epoch !== observationEpoch) return;
        const stored = await chromeApi.storage.session.get([CURRENT_STORAGE_KEY, ROUTE_REVISION_KEY]);
        const current = normalizeStored(stored?.[CURRENT_STORAGE_KEY]);
        if (current?.companyId !== policy.normalizeCompanyId(snapshot?.companyId)
          || current?.revision !== Number(snapshot?.revision)
          || epoch !== observationEpoch
          || synchronizedEpoch === epoch) return;
        await synchronizeContext(Object.freeze({
          companyId: current.companyId,
          revision: current.revision,
          observedAt: current.observedAt,
          sellerTabId: current.tabId,
        }));
        synchronizedEpoch = epoch;
      });
      observationWrites = write.catch(() => {});
      return write;
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
        if (!(await isSnapshotCurrent(snapshot))) return false;
        if (epoch !== observationEpoch || writes !== observationWrites) continue;
        if (synchronizedEpoch !== epoch) {
          await resynchronizeIfCurrent(snapshot, epoch);
          continue;
        }

        // There is no await between the final epoch check and invoking submit.
        // A later switch races only with the in-flight server request, where the
        // server watermark/CAS defines the authoritative order.
        return submit();
      }
    };

    const resetForRouteChange = async () => {
      observationEpoch++;
      await observationWrites;
      const stored = await chromeApi.storage.session.get(null);
      const revision = Math.max(Number(stored?.[CURRENT_STORAGE_KEY]?.revision) || 0, Number(stored?.[ROUTE_REVISION_KEY]) || 0);
      await chromeApi.storage.session.remove(Object.keys(stored || {}).filter(key => key.startsWith(STORAGE_PREFIX) || key === recoveryTab.HELPER_STORAGE_KEY));
      await chromeApi.storage.session.set({ [ROUTE_REVISION_KEY]: revision });
    };

    return Object.freeze({
      resetForRouteChange,
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
    DEFAULT_CONTEXT_SYNC_TIMEOUT_MS,
    CURRENT_STORAGE_KEY,
    DEFAULT_STABILIZATION_WINDOW_MS,
    PREVIOUS_STORAGE_KEY,
    STORAGE_PREFIX,
  });
  root.JzSellerCompanyContextRuntime = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
