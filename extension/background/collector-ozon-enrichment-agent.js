(function (root) {
  'use strict';

  const READ_PERMISSION = 'collector.ozon.read';
  const POLL_MS = 250;
  const MAX_DRAIN_MS = 20_000;
  const NEXT_PATH = '/collector/ozon/enrichment-jobs/next';
  const JOB_KEYS = Object.freeze(['id', 'requestId', 'sku', 'refreshBundle']);
  const FAILURE_MESSAGES = Object.freeze({
    OZON_ENRICH_NOT_FOUND: '未找到 Ozon 商品资料',
    OZON_ENRICH_UPSTREAM_FAILED: 'Ozon 商品资料暂时无法读取',
  });

  const isPlainObject = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };

  const cleanText = (value) => String(value == null ? '' : value).trim();
  const safeJobId = (value) => {
    const id = cleanText(value);
    return /^[A-Za-z0-9._:-]{1,200}$/.test(id) ? id : '';
  };

  const exactKeys = (value, keys) => isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));

  const jsonBody = async (response) => {
    const text = await response?.text?.().catch(() => '');
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  };

  const fixedFailure = (code) => {
    const stableCode = Object.hasOwn(FAILURE_MESSAGES, code)
      ? code
      : 'OZON_ENRICH_UPSTREAM_FAILED';
    return Object.assign(new Error(FAILURE_MESSAGES[stableCode]), {
      code: stableCode,
    });
  };

  const normalizeJob = (value) => {
    if (
      !exactKeys(value, JOB_KEYS)
      || !safeJobId(value.id)
      || typeof value.requestId !== 'string'
      || !cleanText(value.requestId)
      || typeof value.sku !== 'string'
      || !cleanText(value.sku)
      || typeof value.refreshBundle !== 'boolean'
    ) {
      throw fixedFailure('OZON_ENRICH_UPSTREAM_FAILED');
    }
    return {
      id: safeJobId(value.id),
      requestId: cleanText(value.requestId),
      sku: cleanText(value.sku),
      refreshBundle: value.refreshBundle === true,
    };
  };

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

  const matchedVariantData = (capture, sku) => {
    if (capture?.ok !== true || !isPlainObject(capture.data) || !Array.isArray(capture.data.items)) {
      throw fixedFailure('OZON_ENRICH_UPSTREAM_FAILED');
    }
    const expectedSku = cleanText(sku);
    const matched = capture.data.items.find((item) =>
      isPlainObject(item) && candidateSkuValues(item).includes(expectedSku));
    if (!matched) throw fixedFailure('OZON_ENRICH_NOT_FOUND');
    return matched;
  };

  function create({
    sessionManager,
    captureVariant,
    canCapture,
    sleep,
    now = () => Date.now(),
    setTimer = (...args) => root.setTimeout(...args),
    clearTimer = (...args) => root.clearTimeout(...args),
  } = {}) {
    if (
      typeof sessionManager?.beginCollectorOperation !== 'function'
      || typeof sessionManager?.collectorFetch !== 'function'
      || typeof captureVariant !== 'function'
      || typeof canCapture !== 'function'
      || typeof sleep !== 'function'
      || typeof now !== 'function'
      || typeof setTimer !== 'function'
      || typeof clearTimer !== 'function'
    ) {
      throw new TypeError('collector Ozon agent dependencies are required');
    }
    const active = new Set();
    const drains = new Map();

    const deadlineFailure = () => fixedFailure('OZON_ENRICH_UPSTREAM_FAILED');
    const withDeadline = (promise, deadlineAt) => new Promise((resolve, reject) => {
      const remaining = deadlineAt - now();
      if (remaining <= 0) {
        reject(deadlineFailure());
        return;
      }
      const timer = setTimer(() => reject(deadlineFailure()), remaining);
      Promise.resolve(promise).then(
        (value) => {
          clearTimer(timer);
          resolve(value);
        },
        (error) => {
          clearTimer(timer);
          reject(error);
        },
      );
    });

    const requireOperation = async () => {
      const collectorOperation = await sessionManager.beginCollectorOperation();
      if (!collectorOperation?.permissions?.includes(READ_PERMISSION)) return null;
      return collectorOperation;
    };

    const collectorRequest = (collectorOperation, path, options = {}) =>
      sessionManager.collectorFetch(path, {
        collectorOperation,
        permission: READ_PERMISSION,
        ...options,
      });

    const reportFailure = async (collectorOperation, rawJob, error, deadlineAt) => {
      const id = safeJobId(rawJob?.id);
      if (!id || now() >= deadlineAt) return false;
      const failure = fixedFailure(error?.code);
      try {
        const response = await withDeadline(collectorRequest(
          collectorOperation,
          `/collector/ozon/enrichment-jobs/${encodeURIComponent(id)}/fail`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: failure.code, message: failure.message }),
          },
        ), deadlineAt);
        return Boolean(response?.ok);
      } catch {
        return false;
      }
    };

    const executeClaim = async (collectorOperation, rawJob, deadlineAt) => {
      let job;
      try {
        job = normalizeJob(rawJob);
        const capture = await withDeadline(captureVariant({
          sku: job.sku,
          noProxy: true,
          forceRefresh: job.refreshBundle === true,
        }), deadlineAt);
        const variantData = matchedVariantData(capture, job.sku);
        const response = await withDeadline(collectorRequest(
          collectorOperation,
          `/collector/ozon/enrichment-jobs/${encodeURIComponent(job.id)}/result`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ variantData }),
          },
        ), deadlineAt);
        if (!response?.ok) throw fixedFailure('OZON_ENRICH_UPSTREAM_FAILED');
        return true;
      } catch (error) {
        if (now() < deadlineAt) {
          await reportFailure(collectorOperation, job || rawJob, error, deadlineAt);
        }
        return false;
      }
    };

    const claimNext = async (collectorOperation) => {
      const response = await collectorRequest(collectorOperation, NEXT_PATH, { method: 'GET' });
      if (!response?.ok) throw fixedFailure('OZON_ENRICH_UPSTREAM_FAILED');
      const body = await jsonBody(response);
      if (!exactKeys(body, ['ok', 'job']) || body.ok !== true) {
        throw fixedFailure('OZON_ENRICH_UPSTREAM_FAILED');
      }
      return body.job;
    };

    const runDrain = async ({ requestId, deadlineAt }) => {
      let collectorOperation;
      try {
        collectorOperation = await withDeadline(requireOperation(), deadlineAt);
      } catch {
        return;
      }
      if (!collectorOperation) return;
      while (active.has(requestId) && now() < deadlineAt) {
        let trusted = false;
        try {
          trusted = await withDeadline(canCapture(), deadlineAt) === true;
        } catch {
          trusted = false;
        }
        if (!trusted) {
          try {
            await withDeadline(sleep(Math.min(POLL_MS, Math.max(0, deadlineAt - now()))), deadlineAt);
          } catch {}
          continue;
        }
        try {
          const job = await withDeadline(claimNext(collectorOperation), deadlineAt);
          if (job) {
            await executeClaim(collectorOperation, job, deadlineAt);
            continue;
          }
        } catch {
          // The held public request owns the user-facing error. Polling stays fail-closed.
        }
        try {
          await withDeadline(sleep(Math.min(POLL_MS, Math.max(0, deadlineAt - now()))), deadlineAt);
        } catch {}
      }
    };

    const drainUntil = (input = {}) => {
      if (!exactKeys(input, ['requestId', 'deadlineAt'])) {
        return Promise.reject(new TypeError('collector Ozon drain input is invalid'));
      }
      const requestId = typeof input.requestId === 'string' ? cleanText(input.requestId) : '';
      const requestedDeadline = Number(input.deadlineAt);
      if (!requestId || !Number.isFinite(requestedDeadline)) {
        return Promise.reject(new TypeError('collector Ozon drain input is invalid'));
      }
      const deadlineAt = Math.min(requestedDeadline, now() + MAX_DRAIN_MS);
      if (drains.has(requestId)) return drains.get(requestId);
      active.add(requestId);
      const running = runDrain({ requestId, deadlineAt })
        .finally(() => {
          active.delete(requestId);
          drains.delete(requestId);
        });
      drains.set(requestId, running);
      return running;
    };

    const stop = (requestId) => active.delete(cleanText(requestId));

    return Object.freeze({ drainUntil, stop });
  }

  const api = Object.freeze({ create });
  root.JzCollectorOzonAgent = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
