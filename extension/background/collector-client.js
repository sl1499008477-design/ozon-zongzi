/**
 * Collector-only backend client.
 *
 * This client accepts only Collector session operations. It intentionally has
 * no Web bearer, Ozon Seller API, store-sync, lease, import, or report methods.
 */
(() => {
  let context = null;

  function setContext(next) {
    if (!next?.sessionManager || typeof next.getDeviceFingerprint !== 'function') {
      throw new TypeError('collector client requires session manager and device fingerprint');
    }
    context = next;
  }

  function requireContext() {
    if (!context) throw new Error('JzCollectorClient not initialized');
    return context;
  }

  async function request(path, permission, options = {}) {
    const { sessionManager } = requireContext();
    return sessionManager.collectorFetch(path, {
      ...options,
      collectorOperation: options.collectorOperation,
      permission,
    });
  }

  async function getJob(path, collectorOperation) {
    return request(path, 'collector.job.read', {
      collectorOperation,
      method: 'GET',
    });
  }

  async function getConfig(path, collectorOperation) {
    return request(path, 'collector.config.read', {
      collectorOperation,
      method: 'GET',
    });
  }

  async function upload({
    sourceId,
    raw,
    requestId,
    sourceUrl,
    collectorOperation,
  }) {
    const { sessionManager, getDeviceFingerprint } = requireContext();
    const normalizedSourceId = String(sourceId || '').trim();
    if (!normalizedSourceId) {
      return { ok: false, error: 'sourceId required' };
    }
    if (!collectorOperation) {
      return {
        ok: false,
        code: 'COLLECTOR_AUTH_REQUIRED',
        error: '请先在 Web 端登录 sonli',
      };
    }

    const safeRaw = raw && typeof raw === 'object' ? raw : {};
    const normalizedRequestId = String(requestId || `collect-${crypto.randomUUID()}`);
    const pendingUpload = {
      requestId: normalizedRequestId,
      path: `/sources/${encodeURIComponent(normalizedSourceId)}/collect`,
      body: {
        source: normalizedSourceId,
        sourceSku: String(safeRaw.sku || safeRaw.offerId || safeRaw.id || ''),
        sourceUrl: String(safeRaw.url || safeRaw.sourceUrl || sourceUrl || ''),
        requestId: normalizedRequestId,
        deviceFingerprint: await getDeviceFingerprint(),
        capturedAt: new Date().toISOString(),
        payload: globalThis.JzCollectorSession.withoutCollectorScope(safeRaw),
      },
    };
    const sendUpload = (entry, operation = collectorOperation) =>
      request(entry.path, 'collector.upload', {
        collectorOperation: operation,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': entry.requestId,
        },
        body: JSON.stringify(entry.body),
      });

    await sessionManager.flushPendingUploads(sendUpload, collectorOperation);
    try {
      const response = await sendUpload(pendingUpload);
      const text = await response.text().catch(() => '');
      let responseBody = null;
      try {
        responseBody = text ? JSON.parse(text) : null;
      } catch {}
      if (!response.ok) {
        const queued = await sessionManager.enqueueRetryablePendingUpload(
          pendingUpload,
          response.status,
          collectorOperation,
        );
        return {
          ok: false,
          status: response.status,
          error: globalThis.JzCollectorSession.redactCollectorSecrets(
            responseBody?.message || `采集上传失败 (${response.status})`,
          ),
          queued,
        };
      }
      return {
        ok: true,
        data: {
          dedupeHit: Boolean(responseBody?.duplicate),
          lastAt: null,
          result: responseBody?.data ?? responseBody,
        },
      };
    } catch (error) {
      let queued = false;
      try {
        queued = await sessionManager.enqueueRetryablePendingUpload(
          pendingUpload,
          0,
          collectorOperation,
        );
      } catch {}
      return {
        ok: false,
        queued,
        code: globalThis.JzCollectorSession.sanitizeCollectorErrorCode(
          error?.code,
          'COLLECTOR_UPLOAD_FAILED',
        ),
        error: globalThis.JzCollectorSession.redactCollectorSecrets(
          error?.message || '采集结果已保留，登录 Web 后可重新上传',
        ),
      };
    }
  }

  globalThis.JzCollectorClient = Object.freeze({
    getConfig,
    getJob,
    request,
    setContext,
    upload,
  });
})();
