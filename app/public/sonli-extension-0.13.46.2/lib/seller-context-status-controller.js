(function (root) {
  'use strict';

  const isSellerContextSwitch = (previous, current) => {
    if (previous?.status !== 'READY') return false;
    if (current?.status === 'RECOVERING') return true;
    return current?.status === 'READY'
      && Boolean(previous.companyId)
      && Boolean(current.companyId)
      && String(previous.companyId) !== String(current.companyId);
  };

  const createSellerContextStatusController = ({
    requestStatus,
    onStatus,
    pollMs = 5_000,
    setInterval: schedule = root.setInterval.bind(root),
    clearInterval: cancel = root.clearInterval.bind(root),
  } = {}) => {
    if (typeof requestStatus !== 'function' || typeof onStatus !== 'function') {
      throw new TypeError('Seller context status controller requires requestStatus and onStatus');
    }
    let requestGeneration = 0;
    let timer = null;

    const refresh = async () => {
      const generation = ++requestGeneration;
      try {
        const status = await requestStatus();
        if (generation === requestGeneration) onStatus(status);
      } catch {
        if (generation === requestGeneration) onStatus({ status: 'LOGIN_REQUIRED' });
      }
    };
    const start = () => {
      if (timer != null) return;
      void refresh();
      timer = schedule(() => { void refresh(); }, pollMs);
    };
    const stop = () => {
      requestGeneration += 1;
      if (timer != null) cancel(timer);
      timer = null;
    };
    return Object.freeze({ refresh, start, stop });
  };

  const api = Object.freeze({
    createSellerContextStatusController,
    isSellerContextSwitch,
  });
  root.JzSellerContextStatusController = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
