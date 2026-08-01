(function (root) {
  'use strict';

  // The manifest may list this shared helper in more than one matching content-script
  // group. Preserve the first page-scoped registry so product, search, and data-panel
  // callers cannot accidentally create separate coordinators for the same frame.
  if (
    root.JzOzonCollectCoordinator
    && typeof root.JzOzonCollectCoordinator.getPageCoordinator === 'function'
    && typeof root.JzOzonCollectCoordinator.matchesSku === 'function'
  ) {
    if (typeof module !== 'undefined') module.exports = root.JzOzonCollectCoordinator;
    return;
  }

  const STATES = Object.freeze([
    'IDLE',
    'PREFETCHING',
    'READY',
    'SAVING',
    'SUCCESS',
    'BLOCKED_AUTH',
    'ERROR',
  ]);
  const AUTH_CODES = new Set([
    'COLLECTOR_AUTH_REQUIRED',
    'COLLECTOR_PERMISSION_DENIED',
    'COLLECTOR_SESSION_CHANGED',
    'WEB_AUTH_REQUIRED',
  ]);
  const MISSING_FIELDS = Object.freeze([
    ['descriptionCategoryId', '类目'],
    ['weightG', '重量'],
    ['lengthMm', '长'],
    ['widthMm', '宽'],
    ['heightMm', '高'],
  ]);
  const KNOWN_CODES = Object.freeze([
    ...AUTH_CODES,
    'OZON_ENRICH_NOT_FOUND',
    'OZON_ENRICH_INCOMPLETE',
    'OZON_ENRICH_BUSY',
    'OZON_ENRICH_REQUEST_EXPIRED',
    'OZON_ENRICH_UPSTREAM_FAILED',
    'OZON_ENRICH_CONTRACT_MISMATCH',
    'OZON_COLLECT_INCOMPLETE',
    'COLLECT_PAYLOAD_INVALID',
    'COLLECTOR_UPLOAD_FAILED',
    'NETWORK_ERROR',
  ]);

  const cleanText = (value) => String(value == null ? '' : value).trim();
  const plainObject = (value) => {
    if (!value || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };
  const deepFreeze = (value, seen = new WeakSet()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    Object.values(value).forEach((nested) => deepFreeze(nested, seen));
    return Object.freeze(value);
  };
  const finalizedJsonPayload = (value) => {
    try {
      return deepFreeze(JSON.parse(JSON.stringify(value)));
    } catch {
      throw Object.assign(new Error('采集数据格式无效，请刷新页面后重试'), {
        code: 'COLLECT_PAYLOAD_INVALID',
        status: 422,
        retryable: false,
      });
    }
  };
  const exactKeys = (value, keys) => plainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
  const candidateSkuValues = (value) => {
    const values = [];
    const append = (candidate) => {
      if (candidate == null || typeof candidate === 'object') return;
      const normalized = cleanText(candidate);
      if (normalized) values.push(normalized);
    };
    const appendEntry = (entry) => {
      if (!entry || typeof entry !== 'object') return append(entry);
      for (const key of ['sku', 'sku_id', 'product_id', 'offer_id', 'value']) {
        append(entry[key]);
      }
    };
    for (const key of ['sku', 'sku_id', 'product_id', 'offer_id']) append(value?.[key]);
    for (const entries of [value?.skus, value?._searchMeta?.skus]) {
      if (Array.isArray(entries)) entries.forEach(appendEntry);
    }
    return values;
  };
  const matchesSku = (value, sku) => candidateSkuValues(value).includes(cleanText(sku));
  let pageCoordinator = null;

  function create({
    sendMessage,
    now = () => Date.now(),
    timeoutMs = 20_000,
    randomUUID,
  } = {}) {
    const contract = root.JzOzonEnrichmentContract;
    if (
      typeof sendMessage !== 'function'
      || typeof now !== 'function'
      || !Number.isFinite(Number(timeoutMs))
      || Number(timeoutMs) <= 0
      || typeof contract?.normalizeResult !== 'function'
      || (randomUUID !== undefined && typeof randomUUID !== 'function')
    ) {
      throw new TypeError('Ozon collect coordinator dependencies are required');
    }

    const entries = new Map();
    let requestSequence = 0;
    const createSecureNonce = randomUUID || (() => {
      if (typeof root.crypto?.randomUUID === 'function') return root.crypto.randomUUID();
      if (typeof root.crypto?.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        root.crypto.getRandomValues(bytes);
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      }
      throw new TypeError('Secure randomness is required for Ozon collection request IDs');
    });
    const instanceNonce = cleanText(createSecureNonce()).replace(/[^A-Za-z0-9_-]/g, '-');
    if (instanceNonce.length < 16) {
      throw new TypeError('Ozon collection request ID nonce is invalid');
    }

    const normalizeSku = (value) => {
      const sku = cleanText(value);
      if (!sku) throw new TypeError('Ozon SKU is required');
      return sku;
    };

    const requestIdFor = (sku) => {
      requestSequence += 1;
      const safeSku = sku.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
      return `ozon-collect-${Math.trunc(Number(now()) || 0)}-${instanceNonce}-${requestSequence}-${safeSku}`;
    };

    const entryFor = (value) => {
      const sku = normalizeSku(value);
      let entry = entries.get(sku);
      if (!entry) {
        const requestId = requestIdFor(sku);
        entry = {
          sku,
          status: 'IDLE',
          requestId,
          enrichmentRequestId: requestId,
          promise: null,
          result: null,
          error: null,
          collectionStarted: false,
          collectPromise: null,
          collectResult: null,
          finalizedUpload: null,
        };
        entries.set(sku, entry);
      }
      return entry;
    };

    const codeFrom = (error) => {
      const status = Number(error?.status) || 0;
      if (status === 401) return 'COLLECTOR_AUTH_REQUIRED';
      if (status === 403) return 'COLLECTOR_PERMISSION_DENIED';
      const candidates = [error?.code, error?.error, error?.message]
        .map(cleanText)
        .filter(Boolean);
      for (const candidate of candidates) {
        if (KNOWN_CODES.includes(candidate)) return candidate;
        const embedded = KNOWN_CODES.find((code) => candidate.includes(code));
        if (embedded) return embedded;
      }
      return candidates[0] || 'COLLECTOR_UPLOAD_FAILED';
    };

    const orderedMissingFields = (value) => {
      const present = new Set(
        (Array.isArray(value) ? value : [])
          .map(cleanText)
          .filter(Boolean),
      );
      return MISSING_FIELDS.filter(([field]) => present.has(field)).map(([field]) => field);
    };

    const mappedError = (error, phase = 'collect') => {
      if (error?.__jzOzonCollectMapped === true) return error;
      const code = codeFrom(error);
      const missingFields = orderedMissingFields(error?.missingFields || error?.missing);
      const missingLabels = MISSING_FIELDS
        .filter(([field]) => missingFields.includes(field))
        .map(([, label]) => label);
      const sourceMessage = cleanText(error?.message || error?.error);
      let message;
      if (code === 'COLLECTOR_AUTH_REQUIRED' || code === 'WEB_AUTH_REQUIRED') {
        message = '请先登录 Web';
      } else if (code === 'COLLECTOR_PERMISSION_DENIED' || code === 'COLLECTOR_SESSION_CHANGED') {
        message = '请重新连接 Web 采集授权';
      } else if (code === 'OZON_ENRICH_NOT_FOUND') {
        message = '未找到该商品的完整资料';
      } else if (code === 'OZON_ENRICH_INCOMPLETE' || code === 'OZON_ENRICH_CONTRACT_MISMATCH') {
        message = missingLabels.length
          ? `缺少：${missingLabels.join('、')}`
          : '商品补全资料不完整';
      } else if (code === 'OZON_ENRICH_BUSY') {
        message = '商品资料正在排队，请稍后重试';
      } else if (code === 'OZON_ENRICH_UPSTREAM_FAILED' || code === 'OZON_ENRICH_REQUEST_EXPIRED') {
        message = 'Ozon 商品资料暂时无法读取';
      } else if (code === 'OZON_COLLECT_INCOMPLETE') {
        message = '商品补全资料不完整';
      } else if (code === 'COLLECT_PAYLOAD_INVALID') {
        message = '采集数据格式无效，请刷新页面后重试';
      } else if (
        /NETWORK_ERROR|network|socket|网络|超时|timeout/i.test(`${code} ${sourceMessage}`)
      ) {
        message = '网络错误，请稍后重试';
      } else if (phase === 'enrich') {
        message = 'Ozon 商品资料暂时无法读取';
      } else {
        message = '采集失败，请稍后重试';
      }
      const next = Object.assign(new Error(message), {
        code,
        status: Number(error?.status) || 0,
        missingFields,
        retryable: error?.retryable === true,
      });
      Object.defineProperty(next, '__jzOzonCollectMapped', { value: true });
      return next;
    };

    const updateFailure = (entry, error, phase) => {
      const failure = mappedError(error, phase);
      entry.status = AUTH_CODES.has(failure.code) ? 'BLOCKED_AUTH' : 'ERROR';
      entry.error = failure;
      return failure;
    };

    const withTimeout = (operation, phase) => {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = root.setTimeout(() => reject(Object.assign(
          new Error(phase === 'enrich'
            ? 'Ozon 商品资料补全请求超时'
            : '采集上传超时'),
          {
            code: phase === 'enrich' ? 'OZON_ENRICH_UPSTREAM_FAILED' : 'NETWORK_ERROR',
            status: 504,
            retryable: true,
          },
        )), Number(timeoutMs));
      });
      return Promise.race([Promise.resolve(operation), timeout])
        .finally(() => root.clearTimeout(timer));
    };

    const normalizeServerResult = (value, sku) => {
      const result = contract.normalizeResult(value);
      if (result.sku !== sku) {
        throw Object.assign(new Error('Ozon 商品资料补全响应 SKU 不匹配'), {
          code: 'OZON_ENRICH_UPSTREAM_FAILED',
          status: 502,
          retryable: true,
        });
      }
      return result;
    };

    const startPrefetch = (entry) => {
      if (!entry.collectionStarted) {
        entry.status = 'PREFETCHING';
        entry.error = null;
      }
      let promise;
      let operation;
      try {
        operation = sendMessage('enrichOzonCollect', {
          requestId: entry.enrichmentRequestId,
          sku: entry.sku,
        });
      } catch (error) {
        operation = Promise.reject(error);
      }
      promise = withTimeout(operation, 'enrich')
        .then((value) => {
          const result = normalizeServerResult(value, entry.sku);
          entry.result = result;
          if (!entry.collectionStarted) {
            entry.status = 'READY';
            entry.error = null;
          }
          return result;
        })
        .catch((error) => {
          if (entry.promise === promise) entry.promise = null;
          if (!entry.collectionStarted) throw updateFailure(entry, error, 'enrich');
          throw mappedError(error, 'enrich');
        });
      entry.promise = promise;
      return promise;
    };

    const prefetchEntry = (entry, retryFailed = false) => {
      if (entry.result) {
        if (!entry.promise) entry.promise = Promise.resolve(entry.result);
        return entry.promise;
      }
      if (entry.status === 'PREFETCHING' && entry.promise) return entry.promise;
      if (
        !retryFailed
        && (entry.status === 'ERROR' || entry.status === 'BLOCKED_AUTH')
        && entry.error
      ) {
        return Promise.reject(entry.error);
      }
      if (retryFailed && (entry.status === 'ERROR' || entry.status === 'BLOCKED_AUTH')) {
        entry.enrichmentRequestId = requestIdFor(entry.sku);
      }
      return startPrefetch(entry);
    };

    const prefetch = ({ sku } = {}) => prefetchEntry(entryFor(sku));

    const batchItemError = (value) => Object.assign(
      new Error(cleanText(value?.message || value?.error) || 'Ozon 商品资料补全失败'),
      {
        code: cleanText(value?.code),
        status: Number(value?.status) || 0,
        missingFields: Array.isArray(value?.missingFields) ? value.missingFields : [],
        retryable: value?.retryable === true,
      },
    );

    const startBatchChunk = (chunk) => {
      const batchOperation = Promise.resolve().then(() => sendMessage('enrichOzonCollectBatch', {
        requestId: chunk[0].enrichmentRequestId,
        skus: chunk.map(({ sku }) => sku),
      }));
      const batchPromise = withTimeout(batchOperation, 'enrich').then((items) => {
        if (!Array.isArray(items) || items.length !== chunk.length) {
          throw Object.assign(new Error('Ozon 批量商品资料补全响应无效'), {
            code: 'OZON_ENRICH_UPSTREAM_FAILED',
            status: 502,
            retryable: true,
          });
        }
        return items;
      });

      chunk.forEach((entry, index) => {
        if (!entry.collectionStarted) {
          entry.status = 'PREFETCHING';
          entry.error = null;
        }
        let itemPromise;
        itemPromise = batchPromise
          .then((items) => {
            const item = items[index];
            if (!plainObject(item) || cleanText(item.sku) !== entry.sku) {
              throw Object.assign(new Error('Ozon 批量商品资料补全响应 SKU 不匹配'), {
                code: 'OZON_ENRICH_UPSTREAM_FAILED',
                status: 502,
                retryable: true,
              });
            }
            if (item.status === 'ERROR') throw batchItemError(item.error);
            if (item.status !== 'COMPLETE') {
              throw Object.assign(new Error('Ozon 批量商品资料补全响应无效'), {
                code: 'OZON_ENRICH_UPSTREAM_FAILED',
                status: 502,
                retryable: true,
              });
            }
            const result = normalizeServerResult(item.result, entry.sku);
            entry.result = result;
            if (!entry.collectionStarted) {
              entry.status = 'READY';
              entry.error = null;
            }
            return result;
          })
          .catch((error) => {
            if (entry.promise === itemPromise) entry.promise = null;
            if (!entry.collectionStarted) throw updateFailure(entry, error, 'enrich');
            throw mappedError(error, 'enrich');
          });
        entry.promise = itemPromise;
      });
    };

    const prefetchBatch = ({ skus, retryFailed = false } = {}) => {
      if (!Array.isArray(skus)) return Promise.reject(new TypeError('Ozon SKU list is required'));
      const orderedEntries = [];
      const seen = new Set();
      for (const value of skus) {
        const entry = entryFor(value);
        if (!seen.has(entry.sku)) {
          seen.add(entry.sku);
          orderedEntries.push(entry);
        }
      }
      const fresh = orderedEntries.filter((entry) => !entry.result
        && !(entry.status === 'PREFETCHING' && entry.promise)
        && (retryFailed === true
          || (entry.status !== 'ERROR' && entry.status !== 'BLOCKED_AUTH')));
      if (retryFailed === true) {
        fresh
          .filter((entry) => entry.status === 'ERROR' || entry.status === 'BLOCKED_AUTH')
          .forEach((entry) => {
            entry.enrichmentRequestId = requestIdFor(entry.sku);
          });
      }
      for (let index = 0; index < fresh.length; index += 20) {
        startBatchChunk(fresh.slice(index, index + 20));
      }
      return Promise.all(orderedEntries.map((entry) => {
        if (entry.result) return entry.result;
        if (
          (entry.status === 'ERROR' || entry.status === 'BLOCKED_AUTH')
          && entry.error
        ) {
          return { sku: entry.sku, status: 'ERROR', error: entry.error };
        }
        return entry.promise
          .then((result) => result)
          .catch((error) => ({ sku: entry.sku, status: 'ERROR', error }));
      }));
    };

    const collect = ({ sku, raw } = {}) => {
      const entry = entryFor(sku);
      if (entry.collectPromise) return entry.collectPromise;

      let uploadOperation;
      let collectPromise;
      try {
        entry.collectionStarted = true;
        if (!entry.finalizedUpload) {
          const timestamp = Number(now());
          entry.finalizedUpload = finalizedJsonPayload({
            sourceId: 'ozon',
            requestId: entry.requestId,
            capturedAt: new Date(
              Number.isFinite(timestamp) ? timestamp : Date.now(),
            ).toISOString(),
            raw: {
              ...(plainObject(raw) ? raw : {}),
              sku: entry.sku,
            },
          });
        }
        entry.status = 'SAVING';
        entry.error = null;
        uploadOperation = sendMessage('pushSourceCollect', entry.finalizedUpload);
      } catch (error) {
        uploadOperation = Promise.reject(error);
      }
      collectPromise = withTimeout(uploadOperation, 'collect')
        .then((response) => {
          if (
            !exactKeys(response, ['dedupeHit', 'result'])
            || typeof response.dedupeHit !== 'boolean'
            || !plainObject(response.result)
          ) {
            throw Object.assign(new Error('采集上传响应格式无效'), {
              code: 'COLLECTOR_UPLOAD_FAILED',
              status: 502,
              retryable: true,
            });
          }
          entry.collectResult = {
            dedupeHit: response.dedupeHit,
            result: response.result,
          };
          entry.status = 'SUCCESS';
          entry.error = null;
          return entry.collectResult;
        })
        .catch((error) => {
          const failure = updateFailure(entry, error, 'collect');
          if (entry.collectPromise === collectPromise) entry.collectPromise = null;
          throw failure;
        });
      entry.collectPromise = collectPromise;
      return collectPromise;
    };

    const getState = (sku) => {
      const entry = entryFor(sku);
      return {
        status: entry.status,
        requestId: entry.requestId,
        ...(entry.error ? { error: entry.error } : {}),
      };
    };

    return Object.freeze({ prefetch, prefetchBatch, collect, getState });
  }

  const getPageCoordinator = (options) => {
    if (!pageCoordinator) pageCoordinator = create(options);
    return pageCoordinator;
  };

  const api = Object.freeze({ create, getPageCoordinator, STATES, matchesSku });
  root.JzOzonCollectCoordinator = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
