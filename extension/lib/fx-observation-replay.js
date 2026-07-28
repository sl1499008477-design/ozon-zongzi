(function (root) {
  'use strict';
  const createFxObservationReplay = ({ get, set, remove, makeKey }) => {
    const flights = new Map();
    const storageKey = (scope) => {
      const accountId = String(scope?.accountId || '');
      const deviceId = String(scope?.deviceId || '');
      const action = String(scope?.action || '');
      if (!accountId || !deviceId || action !== 'FX_OBSERVATION') throw new Error('FX_REPLAY_SCOPE_REQUIRED');
      return `jz:fx-pending:${encodeURIComponent(accountId)}:${encodeURIComponent(deviceId)}:${action}`;
    };
    const run = async (scope, collect, send) => {
      const key = storageKey(scope);
      if (flights.has(key)) return flights.get(key);
      const flight = (async () => {
        let record = await get(key);
        if (!record || record.scope?.accountId !== scope.accountId || record.scope?.deviceId !== scope.deviceId || record.scope?.action !== scope.action || !record.body?.idempotencyKey) {
          record = { scope: { ...scope }, body: { ...(await collect()), idempotencyKey: makeKey() } };
          await set(key, record);
        }
        const response = await send(record.body);
        await remove(key);
        return response;
      })();
      flights.set(key, flight);
      try { return await flight; } finally { flights.delete(key); }
    };
    return Object.freeze({ run });
  };
  const api = Object.freeze({ createFxObservationReplay });
  root.JzFxObservationReplay = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
