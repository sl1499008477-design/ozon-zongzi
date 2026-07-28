(function (root) {
  'use strict';
  const SCHEMA_VERSION = 1;
  const TTL_MS = 6 * 60 * 60 * 1000;
  const createFxObservationReplay = ({ get, set, remove, makeKey, now = () => Date.now() }) => {
    const flights = new Map();
    const storageKey = (scope) => {
      const accountId = String(scope?.accountId || '');
      const backendOrigin = String(scope?.backendOrigin || '');
      const deviceId = String(scope?.deviceId || '');
      const action = String(scope?.action || '');
      if (!/^https?:\/\//.test(backendOrigin) || !accountId || !deviceId || action !== 'FX_OBSERVATION') throw new Error('FX_REPLAY_SCOPE_REQUIRED');
      return `jz:fx-pending:${encodeURIComponent(backendOrigin)}:${encodeURIComponent(accountId)}:${encodeURIComponent(deviceId)}:${action}`;
    };
    const run = async (scope, collect, send) => {
      const key = storageKey(scope);
      if (flights.has(key)) return flights.get(key);
      const flight = (async () => {
        let record = await get(key);
        const valid = record && record.schemaVersion === SCHEMA_VERSION && record.scope?.backendOrigin === scope.backendOrigin && record.scope?.accountId === scope.accountId && record.scope?.deviceId === scope.deviceId && record.scope?.action === scope.action && record.createdAt <= now() && record.expiresAt > now() && record.body?.idempotencyKey;
        if (!valid) {
          if (record) await remove(key);
          record = { schemaVersion: SCHEMA_VERSION, scope: { ...scope }, createdAt: now(), expiresAt: now() + TTL_MS, key: makeKey(), body: { ...(await collect()) } };
          record.body.idempotencyKey = record.key;
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
