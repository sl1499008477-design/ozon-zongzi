(function (root) {
  'use strict';
  const SCHEMA_VERSION = 1;
  const TTL_MS = 6 * 60 * 60 * 1000;
  const PENDING_PREFIX = 'jz:fx-pending:';
  const createFxObservationReplay = ({ list, set, remove, makeKey, now = () => Date.now() }) => {
    const flights = new Map();
    const normalizeScope = (scope) => {
      let backendOrigin = '';
      try { backendOrigin = new URL(String(scope?.backendOrigin || '')).origin; } catch {}
      const accountId = String(scope?.accountId || '').trim();
      const deviceId = String(scope?.deviceId || '').trim();
      const action = String(scope?.action || '');
      if (!/^https?:\/\//.test(backendOrigin) || !accountId || !deviceId || action !== 'FX_OBSERVATION') throw new Error('FX_REPLAY_SCOPE_REQUIRED');
      return { backendOrigin, accountId, deviceId, action };
    };
    const storageKey = (scope) => {
      return `${PENDING_PREFIX}${encodeURIComponent(scope.backendOrigin)}:${encodeURIComponent(scope.accountId)}:${encodeURIComponent(scope.deviceId)}:${scope.action}`;
    };
    const run = async (scope, collect, send) => {
      const normalizedScope = normalizeScope(scope);
      const key = storageKey(normalizedScope);
      if (flights.has(key)) return flights.get(key);
      const flight = (async () => {
        const currentTime = now();
        const stored = await list();
        let record = stored?.[key];
        const valid = record
          && record.schemaVersion === SCHEMA_VERSION
          && record.scope?.backendOrigin === normalizedScope.backendOrigin
          && record.scope?.accountId === normalizedScope.accountId
          && record.scope?.deviceId === normalizedScope.deviceId
          && record.scope?.action === normalizedScope.action
          && Number.isFinite(record.createdAt)
          && Number.isFinite(record.expiresAt)
          && record.createdAt <= currentTime
          && record.expiresAt > currentTime
          && record.expiresAt > record.createdAt
          && typeof record.key === 'string'
          && record.key.length > 0
          && record.body?.idempotencyKey === record.key;
        const staleKeys = Object.keys(stored || {})
          .filter((storedKey) => storedKey.startsWith(PENDING_PREFIX))
          .filter((storedKey) => storedKey !== key || !valid);
        if (staleKeys.length) await remove(staleKeys);
        if (!valid) {
          const idempotencyKey = String(makeKey() || '').trim();
          if (!idempotencyKey) throw new Error('FX_REPLAY_KEY_REQUIRED');
          record = {
            schemaVersion: SCHEMA_VERSION,
            scope: normalizedScope,
            createdAt: currentTime,
            expiresAt: currentTime + TTL_MS,
            key: idempotencyKey,
            body: { ...(await collect()) },
          };
          record.body.idempotencyKey = record.key;
          await set(key, record);
        }
        const response = await send(record.body);
        await remove([key]);
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
