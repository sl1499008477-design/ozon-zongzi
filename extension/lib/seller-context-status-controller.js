(function (root) {
  'use strict';

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

  const api = Object.freeze({ createSellerContextStatusController });
  root.JzSellerContextStatusController = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
