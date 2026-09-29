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
  const PUBLIC_UPLOAD_CODES = new Set([
    'COLLECTOR_AUTH_REQUIRED',
    'COLLECTOR_PERMISSION_DENIED',
    'COLLECTOR_SESSION_CHANGED',
    'COLLECTOR_UPLOAD_FAILED',
    'COLLECT_REQUEST_FAILED',
    'ZONGZI_COLLECT_INCOMPLETE',
  ]);
  const PUBLIC_MISSING_FIELDS = new Set([
    'descriptionCategoryId',
    'weightG',
    'lengthMm',
    'widthMm',
    'heightMm',
  ]);

  function stableUploadCode(status, value) {
    if (status === 401) return 'COLLECTOR_AUTH_REQUIRED';
    if (status === 403) return 'COLLECTOR_PERMISSION_DENIED';
    const sanitized = globalThis.JzCollectorSession.sanitizeCollectorErrorCode(
      value,
      'COLLECTOR_UPLOAD_FAILED',
    );
    return PUBLIC_UPLOAD_CODES.has(sanitized) ? sanitized : 'COLLECTOR_UPLOAD_FAILED';
  }

  function stableMissingFields(value) {
    return [...new Set(
      (Array.isArray(value) ? value : [])
        .map((field) => String(field || ''))
        .filter((field) => PUBLIC_MISSING_FIELDS.has(field)),
    )];
  }

  function stableUploadMessage(code) {
    if (code === 'COLLECTOR_AUTH_REQUIRED') return '请先登录 Web';
    if (code === 'COLLECTOR_PERMISSION_DENIED' || code === 'COLLECTOR_SESSION_CHANGED') {
      return '请重新连接 Web 采集授权';
    }
    if (code === 'ZONGZI_COLLECT_INCOMPLETE') return '商品资料不完整，未写入采集箱';
    return '采集上传失败，请稍后重试';
  }

  function stableCapturedAt(value) {
    if (typeof value === 'string') {
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value) return value;
    }
    return new Date().toISOString();
  }

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
    capturedAt,
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
        capturedAt: stableCapturedAt(capturedAt),
        payload: globalThis.JzCollectorSession.withoutCollectorScope(safeRaw),
      },
    };
    const uploadEntry = (entry, operation = collectorOperation) =>
      sendUpload(entry, operation);

    try {
      await sessionManager.flushPendingUploads(uploadEntry, collectorOperation);
      const response = await uploadEntry(pendingUpload);
      const text = await response.text().catch(() => '');
      let responseBody = null;
      try {
        responseBody = text ? JSON.parse(text) : null;
      } catch {}
      if (!response.ok) {
        const status = Number(response.status) || 0;
        const code = stableUploadCode(status, responseBody?.code);
        const retryable = typeof responseBody?.retryable === 'boolean'
          ? responseBody.retryable
          : globalThis.JzCollectorSession.isRetryableCollectorUploadStatus(status);
        let queued = false;
        let queueWriteFailed = false;
        try {
          queued = await sessionManager.enqueueRetryablePendingUpload(
            pendingUpload,
            status,
            collectorOperation,
          );
        } catch {
          queueWriteFailed = true;
        }
        return {
          ok: false,
          status,
          code,
          error: stableUploadMessage(code),
          missingFields: stableMissingFields(responseBody?.missingFields),
          retryable,
          queued,
          queueWriteFailed,
        };
      }
      return {
        ok: true,
        data: {
          dedupeHit: Boolean(responseBody?.duplicate),
          result: responseBody?.data ?? responseBody,
        },
      };
    } catch (error) {
      let queued = false;
      let queueWriteFailed = false;
      try {
        queued = await sessionManager.enqueueRetryablePendingUpload(
          pendingUpload,
          0,
          collectorOperation,
        );
      } catch {
        queueWriteFailed = true;
      }
      const status = Number(error?.status) || 0;
      const code = stableUploadCode(status, error?.code);
      return {
        ok: false,
        status,
        queued,
        queueWriteFailed,
        code,
        error: stableUploadMessage(code),
        missingFields: [],
        retryable: globalThis.JzCollectorSession.isRetryableCollectorUploadStatus(status),
      };
    }
  }

  globalThis.JzCollectorClient = Object.freeze({
    setContext,
    upload,
  });
})();
