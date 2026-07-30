/**
 * Collector-only backend client.
 *
 * This client accepts only Collector session operations. It intentionally has
 * no Web bearer, Ozon Seller API, store-sync, lease, import, or report methods.
 */
(() => {
  let context = null;
  const ALLOWED_SOURCE_IDS = new Set([
    '1688',
    'amazon',
    'jd',
    'mercadolibre',
    'ozon',
    'pdd',
    'shein',
    'taobao',
    'temu',
    'wb',
    'yandex',
  ]);

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

  function normalizeSourceId(value) {
    const sourceId = String(value || '').trim().toLowerCase();
    return ALLOWED_SOURCE_IDS.has(sourceId) ? sourceId : '';
  }

  function expectedUploadPath(sourceId) {
    return `/sources/${encodeURIComponent(sourceId)}/collect`;
  }

  function validateUploadEntry(entry) {
    const sourceId = normalizeSourceId(entry?.body?.source);
    if (!sourceId || String(entry?.path || '') !== expectedUploadPath(sourceId)) {
      const error = new Error('COLLECTOR_UPLOAD_ROUTE_INVALID');
      error.code = 'COLLECTOR_UPLOAD_ROUTE_INVALID';
      throw error;
    }
    return { entry, sourceId };
  }

  function sendUpload(entry, collectorOperation) {
    const { sessionManager } = requireContext();
    const validated = validateUploadEntry(entry);
    return sessionManager.collectorFetch(expectedUploadPath(validated.sourceId), {
      collectorOperation,
      permission: 'collector.upload',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': String(validated.entry.requestId || ''),
      },
      body: JSON.stringify(validated.entry.body),
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
    const normalizedSourceId = normalizeSourceId(sourceId);
    if (!normalizedSourceId) {
      return {
        ok: false,
        code: 'COLLECTOR_SOURCE_UNSUPPORTED',
        error: '不支持的数据来源',
      };
    }
    if (!collectorOperation) {
      return {
        ok: false,
        code: 'COLLECTOR_AUTH_REQUIRED',
        error: '请先在 ozon 粽子 Web 管理系统登录',
      };
    }

    const safeRaw = raw && typeof raw === 'object' ? raw : {};
    const normalizedRequestId = String(requestId || `collect-${crypto.randomUUID()}`);
    const pendingUpload = {
      requestId: normalizedRequestId,
      path: expectedUploadPath(normalizedSourceId),
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
    const uploadEntry = (entry, operation = collectorOperation) =>
      sendUpload(entry, operation);

    await sessionManager.flushPendingUploads(uploadEntry, collectorOperation);
    try {
      const response = await uploadEntry(pendingUpload);
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
    setContext,
    upload,
  });
})();
