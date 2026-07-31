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
  const RETIRED_SCOPE_KEYS = new Set([
    'accountid',
    'createdby',
    'clientid',
    'storeid',
    'localstoreid',
    'operatingstoreid',
    'datacollectionstoreid',
    'datacollectionstore',
    'datacollectionstores',
    'datacollectionstoreids',
    'currentdatacollectionstoreid',
    'currentdatacollectionstoreidsbyaccount',
    'sellercompanyid',
    'sellercompany',
    'legacyscope',
  ]);
  const SENSITIVE_KEY_FRAGMENT =
    /(?:authorization|cookie|credential|password|passphrase|secret|token|apikey|privatekey)/;
  const SECRET_VALUE =
    /(?:\bCollector\s+(?:csess|cst|ctt)_[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+\/-]{20,}={0,2}|\b(?:csess|cst|ctt)_[A-Za-z0-9_-]{16,})/i;

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

  const canonicalKey = (value) => String(value || '').replace(/[_-]/g, '').toLowerCase();
  const forbiddenNestedKey = (value) => {
    const key = canonicalKey(value);
    return RETIRED_SCOPE_KEYS.has(key)
      || SENSITIVE_KEY_FRAGMENT.test(key)
      || key.includes('header')
      || key === 'action'
      || key.endsWith('action')
      || key === 'script'
      || key.startsWith('script')
      || key.endsWith('script')
      || key === 'url'
      || key.endsWith('url')
      || key === 'uri'
      || key.endsWith('uri');
  };

  const assertSafeVariantData = (value) => {
    const seen = new WeakSet();
    const visit = (nested) => {
      if (typeof nested === 'string' && SECRET_VALUE.test(nested)) {
        throw fixedFailure('OZON_ENRICH_UPSTREAM_FAILED');
      }
      if (!nested || typeof nested !== 'object') return;
      if (seen.has(nested)) return;
      seen.add(nested);
      if (Array.isArray(nested)) {
        nested.forEach(visit);
        return;
      }
      if (!isPlainObject(nested)) throw fixedFailure('OZON_ENRICH_UPSTREAM_FAILED');
      for (const [key, child] of Object.entries(nested)) {
        if (forbiddenNestedKey(key)) throw fixedFailure('OZON_ENRICH_UPSTREAM_FAILED');
        visit(child);
      }
    };
    visit(value);
    return value;
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
      || typeof root.AbortController !== 'function'
    ) {
      throw new TypeError('collector Ozon agent dependencies are required');
    }
    const drains = new Map();
    let nextGeneration = 1;

    const deadlineFailure = () => fixedFailure('OZON_ENRICH_UPSTREAM_FAILED');
    const deactivate = (entry) => {
      if (!entry?.active) return;
      entry.active = false;
      entry.refs = 0;
      const controller = entry.currentController;
      entry.currentController = null;
      controller?.abort();
      entry.resolveCancelled();
      if (drains.get(entry.requestId) === entry) drains.delete(entry.requestId);
    };
    const isCurrent = (entry, generation) => {
      if (entry?.active && now() >= entry.deadlineAt) deactivate(entry);
      return Boolean(
        entry?.active
        && entry.refs > 0
        && entry.generation === generation
        && drains.get(entry.requestId) === entry,
      );
    };
    const ensureCurrent = (entry, generation) => {
      if (!isCurrent(entry, generation)) throw deadlineFailure();
    };
    const withLifecycle = async (promise, entry, generation) => {
      ensureCurrent(entry, generation);
      let timer;
      const deadlineSignal = new Promise((resolve) => {
        const schedule = () => {
          const remaining = entry.deadlineAt - now();
          if (remaining <= 0) {
            deactivate(entry);
            resolve();
            return;
          }
          timer = setTimer(() => {
            if (now() >= entry.deadlineAt) {
              deactivate(entry);
              resolve();
            } else {
              schedule();
            }
          }, remaining);
        };
        schedule();
      });
      try {
        const value = await Promise.race([
          Promise.resolve(promise),
          entry.cancelled.then(() => { throw deadlineFailure(); }),
          deadlineSignal.then(() => { throw deadlineFailure(); }),
        ]);
        ensureCurrent(entry, generation);
        return value;
      } finally {
        clearTimer(timer);
      }
    };

    const withCollectorStage = async (entry, generation, request) => {
      ensureCurrent(entry, generation);
      const controller = new root.AbortController();
      entry.currentController = controller;
      const pending = (async () => {
        ensureCurrent(entry, generation);
        return request(controller.signal);
      })();
      try {
        return await withLifecycle(pending, entry, generation);
      } finally {
        if (entry.currentController === controller) entry.currentController = null;
        controller.abort();
      }
    };

    const requireOperation = async () => {
      const collectorOperation = await sessionManager.beginCollectorOperation();
      if (!collectorOperation?.permissions?.includes(READ_PERMISSION)) return null;
      return collectorOperation;
    };

    const collectorRequest = (entry, generation, collectorOperation, path, options = {}) =>
      withCollectorStage(entry, generation, (signal) => sessionManager.collectorFetch(path, {
        collectorOperation,
        permission: READ_PERMISSION,
        ...options,
        signal,
      }));

    const reportFailure = async (entry, generation, collectorOperation, rawJob, error) => {
      const id = safeJobId(rawJob?.id);
      if (!id || !isCurrent(entry, generation)) return false;
      const failure = fixedFailure(error?.code);
      try {
        ensureCurrent(entry, generation);
        const response = await collectorRequest(
          entry,
          generation,
          collectorOperation,
          `/collector/ozon/enrichment-jobs/${encodeURIComponent(id)}/fail`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: failure.code, message: failure.message }),
          },
        );
        ensureCurrent(entry, generation);
        return Boolean(response?.ok);
      } catch {
        return false;
      }
    };

    const executeClaim = async (entry, generation, collectorOperation, rawJob) => {
      let job;
      try {
        job = normalizeJob(rawJob);
        ensureCurrent(entry, generation);
        const capture = await withLifecycle(captureVariant({
          sku: job.sku,
          noProxy: true,
          forceRefresh: job.refreshBundle === true,
        }), entry, generation);
        ensureCurrent(entry, generation);
        const variantData = matchedVariantData(capture, job.sku);
        assertSafeVariantData(variantData);
        ensureCurrent(entry, generation);
        const response = await collectorRequest(
          entry,
          generation,
          collectorOperation,
          `/collector/ozon/enrichment-jobs/${encodeURIComponent(job.id)}/result`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ variantData }),
          },
        );
        ensureCurrent(entry, generation);
        if (!response?.ok) throw fixedFailure('OZON_ENRICH_UPSTREAM_FAILED');
        return true;
      } catch (error) {
        if (isCurrent(entry, generation)) {
          await reportFailure(entry, generation, collectorOperation, job || rawJob, error);
        }
        return false;
      }
    };

    const claimNext = (entry, generation, collectorOperation) =>
      withCollectorStage(entry, generation, async (signal) => {
        const response = await sessionManager.collectorFetch(NEXT_PATH, {
          collectorOperation,
          permission: READ_PERMISSION,
          method: 'GET',
          signal,
        });
        ensureCurrent(entry, generation);
        if (!response?.ok) throw fixedFailure('OZON_ENRICH_UPSTREAM_FAILED');
        const body = await jsonBody(response);
        ensureCurrent(entry, generation);
        if (!exactKeys(body, ['ok', 'job']) || body.ok !== true) {
          throw fixedFailure('OZON_ENRICH_UPSTREAM_FAILED');
        }
        return body.job;
      });

    const runDrain = async (entry, generation) => {
      let collectorOperation;
      try {
        collectorOperation = await withLifecycle(requireOperation(), entry, generation);
        ensureCurrent(entry, generation);
      } catch {
        return;
      }
      if (!collectorOperation) return;
      while (isCurrent(entry, generation)) {
        let trusted = false;
        try {
          ensureCurrent(entry, generation);
          trusted = await withLifecycle(canCapture(), entry, generation) === true;
          ensureCurrent(entry, generation);
        } catch {
          trusted = false;
        }
        if (!isCurrent(entry, generation)) break;
        if (!trusted) {
          try {
            await withLifecycle(
              sleep(Math.min(POLL_MS, Math.max(0, entry.deadlineAt - now()))),
              entry,
              generation,
            );
          } catch {}
          continue;
        }
        try {
          const job = await claimNext(entry, generation, collectorOperation);
          ensureCurrent(entry, generation);
          if (job) {
            await executeClaim(entry, generation, collectorOperation, job);
            continue;
          }
        } catch {
          // The held public request owns the user-facing error. Polling stays fail-closed.
        }
        if (!isCurrent(entry, generation)) break;
        try {
          await withLifecycle(
            sleep(Math.min(POLL_MS, Math.max(0, entry.deadlineAt - now()))),
            entry,
            generation,
          );
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
      const existing = drains.get(requestId);
      if (existing?.active) {
        existing.refs += 1;
        existing.deadlineAt = Math.max(existing.deadlineAt, deadlineAt);
        return existing.running;
      }
      let resolveCancelled;
      const cancelled = new Promise((resolve) => { resolveCancelled = resolve; });
      const entry = {
        requestId,
        generation: nextGeneration,
        refs: 1,
        deadlineAt,
        active: true,
        currentController: null,
        cancelled,
        resolveCancelled,
        running: null,
      };
      nextGeneration += 1;
      drains.set(requestId, entry);
      entry.running = runDrain(entry, entry.generation)
        .finally(() => deactivate(entry));
      return entry.running;
    };

    const stop = (requestId) => {
      const entry = drains.get(cleanText(requestId));
      if (!entry?.active || entry.refs <= 0) return false;
      entry.refs -= 1;
      if (entry.refs === 0) deactivate(entry);
      return true;
    };

    return Object.freeze({ drainUntil, stop });
  }

  const api = Object.freeze({ create });
  root.JzCollectorOzonAgent = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
