(function (root) {
  'use strict';
  const FX_STORAGE_KEY = 'jz_calc_fx_rate_v1';

  function createCollectorAccountStatus({
    sessionManager, getBackendUrl, getDeviceFingerprint, storage, collectFxProbe,
  }) {
    const request = async (path, collectorOperation, permission, body) => {
      const response = await sessionManager.collectorFetch(path, {
        collectorOperation, permission, method: body ? 'POST' : 'GET',
        ...(body ? { headers: { 'content-type': 'application/json', 'idempotency-key': body.idempotencyKey },
          body: JSON.stringify(body) } : {}),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        const code = response.status === 401 ? 'COLLECTOR_AUTH_REQUIRED'
          : response.status === 403 ? 'COLLECTOR_PERMISSION_DENIED' : 'COLLECTOR_ACCOUNT_STATUS_FAILED';
        throw Object.assign(new Error(root.JzCollectorSession.redactCollectorSecrets(
          result?.error || `采集统计或汇率请求失败 (${response.status})`,
        )), { code, status: response.status });
      }
      return result;
    };

    const begin = async () => {
      const operation = await sessionManager.beginCollectorOperation();
      if (!operation) throw Object.assign(new Error('请先连接 Web 采集授权'), { code: 'COLLECTOR_AUTH_REQUIRED' });
      return operation;
    };
    const assertCurrent = async operation => {
      const current = await sessionManager.beginCollectorOperation();
      if (!current || current.accountId !== operation.accountId || current.sessionIdentity !== operation.sessionIdentity) {
        throw Object.assign(new Error('采集会话已切换'), { code: 'COLLECTOR_SESSION_CHANGED' });
      }
    };

    async function getAccountSummary() {
      const operation = await begin();
      const summary = await request('/collector/account-summary', operation, 'collector.job.read');
      await assertCurrent(operation);
      return summary;
    }

    async function refreshFx() {
      const operation = await begin();
      const backendOrigin = new URL(await getBackendUrl()).origin;
      const deviceId = await getDeviceFingerprint();
      const probeResponse = await request('/collector/fx/probes/active', operation, 'collector.config.read');
      const probes = probeResponse.probes || [];
      let result = null;
      if (probes.length) {
        const replay = root.JzFxObservationReplay.createFxObservationReplay({
          list: () => storage.get(null),
          set: (key, value) => storage.set({ [key]: value }),
          remove: keys => storage.remove(keys),
          makeKey: () => `fx-observation:${deviceId}:${root.crypto.randomUUID()}`,
        });
        result = await replay.run({ backendOrigin, accountId: operation.accountId, deviceId, action: 'FX_OBSERVATION' },
          async () => {
            const observations = [], errors = [];
            for (const probe of probes) {
              await assertCurrent(operation);
              try { observations.push(await collectFxProbe(probe.sku)); }
              catch (error) { errors.push({ sku: probe.sku,
                error: root.JzCollectorSession.redactCollectorSecrets(error?.message || String(error)) }); }
              await new Promise(resolve => root.setTimeout(resolve, 250));
            }
            return { observations, errors, deviceId };
          },
          body => request('/collector/fx/observations', operation, 'collector.upload', body));
      }
      const currentRate = result?.rate || probeResponse.rate;
      const rate = Number(currentRate?.rate || 0);
      if (!(rate > 0)) throw new Error('本轮没有可用汇率');
      await assertCurrent(operation);
      await storage.set({ [FX_STORAGE_KEY]: {
        rate, ts: Date.parse(currentRate.computedAt) || 0,
        source: currentRate.source || 'ozon_sku_frontend',
        sampleCount: Number(currentRate.acceptedCount || 0), confidence: currentRate.confidence || 'LOW',
      } });
      return rate;
    }
    return Object.freeze({ getAccountSummary, refreshFx });
  }

  const api = Object.freeze({ createCollectorAccountStatus });
  root.JzCollectorAccountStatus = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
