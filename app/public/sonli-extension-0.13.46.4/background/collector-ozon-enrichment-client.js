(function (root) {
  'use strict';

  const READ_PERMISSION = 'collector.ozon.read';
  const DEADLINE_MS = 20_000;
  const SINGLE_PATH = '/collector/ozon/enrich';
  const BATCH_PATH = '/collector/ozon/enrich/batch';
  const REQUIRED_MISSING_FIELDS = new Set([
    'descriptionCategoryId',
    'weightG',
    'lengthMm',
    'widthMm',
    'heightMm',
  ]);
  const PUBLIC_CODES = new Set([
    'COLLECTOR_AUTH_REQUIRED',
    'COLLECTOR_PERMISSION_DENIED',
    'COLLECTOR_SESSION_CHANGED',
    'OZON_ENRICH_REQUEST_INVALID',
    'OZON_ENRICH_REQUEST_ID_REQUIRED',
    'OZON_ENRICH_SKU_REQUIRED',
    'OZON_ENRICH_BATCH_SKUS_REQUIRED',
    'OZON_ENRICH_BATCH_LIMIT',
    'OZON_ENRICH_NOT_FOUND',
    'OZON_ENRICH_INCOMPLETE',
    'OZON_ENRICH_BUSY',
    'OZON_ENRICH_REQUEST_EXPIRED',
    'OZON_ENRICH_UPSTREAM_FAILED',
  ]);

  const isPlainObject = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };

  const exactKeys = (value, keys) => isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));

  const cleanText = (value) => String(value == null ? '' : value).trim();

  const redact = (value) => {
    const helper = root.JzCollectorSession?.redactCollectorSecrets;
    if (typeof helper === 'function') return helper(value);
    return String(value == null ? '' : value)
      .replace(/(?:ctt|cst|csess)_[A-Za-z0-9_-]*/gi, '[REDACTED]')
      .replace(/bearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[REDACTED]')
      .slice(0, 240);
  };

  const stableMissingFields = (value) => [...new Set(
    (Array.isArray(value) ? value : [])
      .map((field) => String(field || ''))
      .filter((field) => REQUIRED_MISSING_FIELDS.has(field)),
  )];

  const clientError = (
    status,
    code,
    message,
    missingFields = [],
    retryable,
  ) => Object.assign(new Error(redact(message || 'Ozon 商品资料补全失败')), {
    status: Number.isInteger(Number(status)) ? Number(status) : 0,
    code: PUBLIC_CODES.has(String(code || ''))
      ? String(code)
      : 'OZON_ENRICH_UPSTREAM_FAILED',
    missingFields: stableMissingFields(missingFields),
    retryable: Boolean(retryable),
  });

  const invalidRequest = (code = 'OZON_ENRICH_REQUEST_INVALID') => clientError(
    400,
    code,
    'Ozon 商品补全请求格式无效',
    [],
    false,
  );

  const jsonBody = async (response) => {
    const text = await response?.text?.().catch(() => '');
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  };

  const responseError = async (response) => {
    const body = await jsonBody(response);
    const status = Number(response?.status) || 0;
    return clientError(
      status,
      body?.code,
      body?.message || `Ozon 商品资料补全失败 (${status})`,
      body?.missingFields,
      body?.retryable ?? (status === 429 || status >= 500),
    );
  };

  const requiredText = (value, code) => {
    if (typeof value !== 'string') throw invalidRequest(code);
    const normalized = cleanText(value);
    if (!normalized) throw invalidRequest(code);
    return normalized;
  };

  const normalizeInput = (input, keys) => {
    if (!exactKeys(input, keys)) throw invalidRequest();
    return input;
  };

  function create({
    sessionManager,
    agent,
    getBackendUrl,
    now = () => Date.now(),
    setTimer = (...args) => root.setTimeout(...args),
    clearTimer = (...args) => root.clearTimeout(...args),
  } = {}) {
    if (
      typeof sessionManager?.beginCollectorOperation !== 'function'
      || typeof sessionManager?.collectorFetch !== 'function'
      || typeof agent?.drainUntil !== 'function'
      || typeof agent?.stop !== 'function'
      || typeof getBackendUrl !== 'function'
      || typeof now !== 'function'
      || typeof setTimer !== 'function'
      || typeof clearTimer !== 'function'
      || typeof root.AbortController !== 'function'
      || typeof root.JzOzonEnrichmentContract?.normalizeResult !== 'function'
    ) {
      throw new TypeError('collector Ozon client dependencies are required');
    }

    const requireOperation = async () => {
      const collectorOperation = await sessionManager.beginCollectorOperation();
      if (!collectorOperation) {
        throw clientError(401, 'COLLECTOR_AUTH_REQUIRED', '需要 Collector 采集认证', [], false);
      }
      if (!collectorOperation.permissions?.includes(READ_PERMISSION)) {
        throw clientError(403, 'COLLECTOR_PERMISSION_DENIED', 'Collector 权限不足', [], false);
      }
      return collectorOperation;
    };

    const heldRequest = async ({ requestId, path, body, normalize }) => {
      const collectorOperation = await requireOperation();
      const deadlineAt = now() + DEADLINE_MS;
      const abortController = new root.AbortController();
      const timeoutError = clientError(
        504,
        'OZON_ENRICH_UPSTREAM_FAILED',
        'Ozon 商品资料补全请求超时',
        [],
        true,
      );
      let deadlineTimer;
      let responsePromise;
      let drainPromise;
      let releaseToken;
      try {
        responsePromise = Promise.resolve(sessionManager.collectorFetch(path, {
          collectorOperation,
          permission: READ_PERMISSION,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: abortController.signal,
        }));
      } catch (error) {
        responsePromise = Promise.reject(error);
      }
      try {
        const drainHandle = agent.drainUntil({ requestId, deadlineAt });
        releaseToken = drainHandle?.releaseToken;
        drainPromise = Promise.resolve(drainHandle);
      } catch (error) {
        drainPromise = Promise.reject(error);
      }
      const settledDrainPromise = drainPromise.catch(() => undefined);
      const deadlinePromise = new Promise((_, reject) => {
        deadlineTimer = setTimer(() => {
          abortController.abort();
          reject(timeoutError);
        }, Math.max(0, deadlineAt - now()));
      });
      try {
        const readResponse = async () => {
          const response = await responsePromise;
          if (!response?.ok) throw await responseError(response);
          const payload = await jsonBody(response);
          return normalize(payload);
        };
        return await Promise.race([readResponse(), deadlinePromise]);
      } finally {
        agent.stop(requestId, releaseToken);
        abortController.abort();
        void settledDrainPromise;
        clearTimer(deadlineTimer);
      }
    };

    const enrich = async (input = {}) => {
      normalizeInput(input, ['requestId', 'sku']);
      const requestId = requiredText(input.requestId, 'OZON_ENRICH_REQUEST_ID_REQUIRED');
      const sku = requiredText(input.sku, 'OZON_ENRICH_SKU_REQUIRED');
      return heldRequest({
        requestId,
        path: SINGLE_PATH,
        body: { requestId, sku },
        normalize(payload) {
          if (!exactKeys(payload, ['ok', 'data']) || payload.ok !== true) {
            throw clientError(
              502,
              'OZON_ENRICH_UPSTREAM_FAILED',
              'Ozon 商品资料补全响应无效',
              [],
              true,
            );
          }
          const result = root.JzOzonEnrichmentContract.normalizeResult(payload.data);
          if (result.sku !== sku) {
            throw clientError(
              502,
              'OZON_ENRICH_UPSTREAM_FAILED',
              'Ozon 商品资料补全响应 SKU 不匹配',
              [],
              true,
            );
          }
          return result;
        },
      });
    };

    const normalizeBatchError = (value) => {
      if (!exactKeys(value, ['code', 'message', 'missingFields', 'retryable'])) {
        throw clientError(
          502,
          'OZON_ENRICH_UPSTREAM_FAILED',
          'Ozon 商品资料补全响应无效',
          [],
          true,
        );
      }
      const error = clientError(
        0,
        value.code,
        value.message,
        value.missingFields,
        value.retryable,
      );
      return {
        code: error.code,
        message: error.message,
        missingFields: error.missingFields,
        retryable: error.retryable,
      };
    };

    const enrichBatch = async (input = {}) => {
      normalizeInput(input, ['requestId', 'skus']);
      const requestId = requiredText(input.requestId, 'OZON_ENRICH_REQUEST_ID_REQUIRED');
      if (!Array.isArray(input.skus) || !input.skus.length) {
        throw invalidRequest('OZON_ENRICH_BATCH_SKUS_REQUIRED');
      }
      const skus = [];
      const seen = new Set();
      for (const rawSku of input.skus) {
        const sku = requiredText(rawSku, 'OZON_ENRICH_SKU_REQUIRED');
        if (!seen.has(sku)) {
          seen.add(sku);
          skus.push(sku);
        }
      }
      if (skus.length > 20) throw invalidRequest('OZON_ENRICH_BATCH_LIMIT');
      return heldRequest({
        requestId,
        path: BATCH_PATH,
        body: { requestId, skus },
        normalize(payload) {
          if (!exactKeys(payload, ['ok', 'data']) || payload.ok !== true || !Array.isArray(payload.data)) {
            throw clientError(
              502,
              'OZON_ENRICH_UPSTREAM_FAILED',
              'Ozon 商品资料补全响应无效',
              [],
              true,
            );
          }
          if (payload.data.length !== skus.length) {
            throw clientError(
              502,
              'OZON_ENRICH_UPSTREAM_FAILED',
              'Ozon 商品资料补全响应无效',
              [],
              true,
            );
          }
          return payload.data.map((item, index) => {
            if (
              !isPlainObject(item)
              || typeof item.sku !== 'string'
              || cleanText(item.sku) !== skus[index]
            ) {
              throw clientError(
                502,
                'OZON_ENRICH_UPSTREAM_FAILED',
                'Ozon 商品资料补全响应无效',
                [],
                true,
              );
            }
            if (item.status === 'COMPLETE' && exactKeys(item, ['sku', 'status', 'result'])) {
              const result = root.JzOzonEnrichmentContract.normalizeResult(item.result);
              if (result.sku !== skus[index]) {
                throw clientError(
                  502,
                  'OZON_ENRICH_UPSTREAM_FAILED',
                  'Ozon 商品资料补全响应 SKU 不匹配',
                  [],
                  true,
                );
              }
              return {
                sku: skus[index],
                status: 'COMPLETE',
                result,
              };
            }
            if (item.status === 'ERROR' && exactKeys(item, ['sku', 'status', 'error'])) {
              return {
                sku: skus[index],
                status: 'ERROR',
                error: normalizeBatchError(item.error),
              };
            }
            throw clientError(
              502,
              'OZON_ENRICH_UPSTREAM_FAILED',
              'Ozon 商品资料补全响应无效',
              [],
              true,
            );
          });
        },
      });
    };

    return Object.freeze({ enrich, enrichBatch });
  }

  const api = Object.freeze({ create });
  root.JzCollectorOzonClient = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
