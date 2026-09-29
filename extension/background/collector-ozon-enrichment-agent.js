(function (root) {
  'use strict';

  const READ_PERMISSION = 'collector.ozon.read';
  const POLL_MS = 250;
  const MAX_DRAIN_MS = 20_000;
  const NEXT_PATH = '/collector/ozon/enrichment-jobs/next';
  const AVAILABLE_DRAIN_ID = '__collectorOzonEnrichmentAvailable__';
  const DRAIN_COMPLETED = Symbol('collectorOzonDrainCompleted');
  const DRAIN_CANCELLED = Symbol('collectorOzonDrainCancelled');
  const DRAIN_FAILED = Symbol('collectorOzonDrainFailed');
  const JOB_KEYS = Object.freeze(['id', 'requestId', 'sku', 'refreshBundle', 'claimFence']);
  const JOB_KEYS_WITH_TASK_KEY = Object.freeze([...JOB_KEYS, 'taskKey']);
  const FAILURE_MESSAGES = Object.freeze({
    ZONGZI_ENRICH_DATA_CONFLICT: '来源包装参数冲突，请核实',
    ZONGZI_ENRICH_BUNDLE_UNCERTAIN: '上次商品包创建结果未确认，停止重复创建',
    ZONGZI_ENRICH_NOT_FOUND: '未找到 Ozon 商品资料',
    ZONGZI_ENRICH_INCOMPLETE: '来源未提供完整包装资料，请核实补填',
    ZONGZI_ENRICH_BUSY: 'Ozon 请求受限，稍后重试',
    ZONGZI_ENRICH_UPSTREAM_FAILED: 'Ozon 商品资料暂时无法读取',
    SELLER_CONTEXT_CHANGED: 'Seller 店铺上下文已变化',
    SELLER_CONTEXT_REQUIRED: '需要登录 Seller',
  });
  const SELLER_AUTH_CAPTURE_CODES = new Set([
    'AUTH_REQUIRED',
    'NO_SELLER_TAB',
    'SELLER_CONTEXT_REQUIRED',
    'SELLER_COMPANY_CONTEXT_REQUIRED',
  ]);
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
  const EXACT_SENSITIVE_KEYS = new Set(['auth', 'jwt', 'session', 'cookiejar']);
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

  const safeErrorText = (value) => {
    const redact = root.JzCollectorSession?.redactCollectorSecrets;
    const text = typeof redact === 'function' ? redact(value) : String(value || '')
      .replace(/(?:Collector|Bearer)\s+[^\s,;]+/gi, '[REDACTED]')
      .replace(/(?:ctt|cst|csess)_[A-Za-z0-9_-]+/gi, '[REDACTED]')
      .replace(/([?&](?:token|key|secret|signature|password|credential)[^=\s]*=)[^&\s]+/gi, '$1[REDACTED]');
    return text.slice(0, 1000);
  };

  const fixedFailure = (code, detail = {}) => {
    const stableCode = Object.hasOwn(FAILURE_MESSAGES, code) ? code : 'ZONGZI_ENRICH_UPSTREAM_FAILED';
    const diagnostic = detail.diagnostic || {};
    const explanation = safeErrorText(detail.message || '');
    return Object.assign(new Error(explanation && explanation !== '[REDACTED]' ? explanation : FAILURE_MESSAGES[stableCode]), {
      code: stableCode,
      diagnostic: {
        ...(diagnostic.stage ? { stage: safeErrorText(diagnostic.stage).slice(0, 80) } : {}),
        ...(diagnostic.upstreamCode ? { upstreamCode: safeErrorText(diagnostic.upstreamCode).slice(0, 80) } : {}),
        ...(Number.isInteger(diagnostic.upstreamStatus) ? { upstreamStatus: diagnostic.upstreamStatus } : {}),
        ...(typeof diagnostic.requestSent === 'boolean' ? { requestSent: diagnostic.requestSent } : {}),
        ...(root.chrome?.runtime?.getManifest ? { extensionVersion: root.chrome.runtime.getManifest().version } : {}),
      },
    });
  };

  const canonicalKey = (value) => String(value || '').replace(/[_-]/g, '').toLowerCase();
  const sensitiveNestedKey = (value) => {
    const key = canonicalKey(value);
    return EXACT_SENSITIVE_KEYS.has(key)
      || SENSITIVE_KEY_FRAGMENT.test(key)
      || key.includes('header');
  };
  const forbiddenNestedKey = (value) => {
    const key = canonicalKey(value);
    return RETIRED_SCOPE_KEYS.has(key)
      || sensitiveNestedKey(key)
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

  const assertRawVariantCredentialsSafe = (value) => {
    const seen = new WeakSet();
    const visit = (nested) => {
      if (typeof nested === 'string' && SECRET_VALUE.test(nested)) {
        throw fixedFailure('ZONGZI_ENRICH_UPSTREAM_FAILED');
      }
      if (!nested || typeof nested !== 'object') return;
      if (seen.has(nested)) return;
      seen.add(nested);
      if (Array.isArray(nested)) {
        nested.forEach(visit);
        return;
      }
      if (!isPlainObject(nested)) throw fixedFailure('ZONGZI_ENRICH_UPSTREAM_FAILED');
      for (const [key, child] of Object.entries(nested)) {
        if (sensitiveNestedKey(key)) throw fixedFailure('ZONGZI_ENRICH_UPSTREAM_FAILED');
        visit(child);
      }
    };
    visit(value);
    return value;
  };

  const assertSafeVariantData = (value) => {
    const seen = new WeakSet();
    const visit = (nested) => {
      if (typeof nested === 'string' && SECRET_VALUE.test(nested)) {
        throw fixedFailure('ZONGZI_ENRICH_UPSTREAM_FAILED');
      }
      if (!nested || typeof nested !== 'object') return;
      if (seen.has(nested)) return;
      seen.add(nested);
      if (Array.isArray(nested)) {
        nested.forEach(visit);
        return;
      }
      if (!isPlainObject(nested)) throw fixedFailure('ZONGZI_ENRICH_UPSTREAM_FAILED');
      for (const [key, child] of Object.entries(nested)) {
        if (forbiddenNestedKey(key)) throw fixedFailure('ZONGZI_ENRICH_UPSTREAM_FAILED');
        visit(child);
      }
    };
    visit(value);
    return value;
  };

  // The Seller portal response also contains draft actions, account context and URL
  // metadata. None of those fields belong to the enrichment contract. Keep only the
  // stable product fields consumed by the server so portal-only data cannot cross
  // the Collector boundary or make an otherwise valid capture fail validation.
  const projectVariantData = (variantData) => {
    const attributes = root.JzOzonEnrichmentContract.projectCollectedVariant(variantData).attributes || [];
    const attributeNumber = (key) => {
      const attribute = attributes.find((entry) => cleanText(entry?.key) === key);
      const number = Number(attribute?.value);
      return Number.isFinite(number) && number > 0 ? number : 0;
    };
    const positiveNumber = (...values) => {
      for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return number;
      }
      return null; // Missing source logistics are evidence gaps, not capture failures.
    };
    const positiveInteger = (value) => {
      const number = Number(value);
      if (Number.isSafeInteger(number) && number > 0) return number;
      throw fixedFailure('ZONGZI_ENRICH_UPSTREAM_FAILED');
    };
    const typeId = Object.hasOwn(variantData || {}, 'type_id')
      ? positiveInteger(variantData.type_id)
      : null;
    return {
      description_category_id: positiveInteger(variantData?.description_category_id),
      ...(Array.isArray(variantData?.packagingCandidates) ? {packagingCandidates: variantData.packagingCandidates.map(value => ({
        weightG: positiveNumber(value.weightG), lengthMm: positiveNumber(value.lengthMm),
        widthMm: positiveNumber(value.widthMm), heightMm: positiveNumber(value.heightMm),
      }))} : {}),
      ...(typeId ? { type_id: typeId } : {}),
      weight: positiveNumber(variantData?.weight, attributeNumber('4497')),
      depth: positiveNumber(variantData?.depth, attributeNumber('9454')),
      width: positiveNumber(variantData?.width, attributeNumber('9455')),
      height: positiveNumber(variantData?.height, attributeNumber('9456')),
      attributes,
    };
  };

  const normalizeJob = (value) => {
    if (
      (!exactKeys(value, JOB_KEYS) && !exactKeys(value, JOB_KEYS_WITH_TASK_KEY))
      || !safeJobId(value.id)
      || typeof value.requestId !== 'string'
      || !cleanText(value.requestId)
      || typeof value.sku !== 'string'
      || !cleanText(value.sku)
      || typeof value.refreshBundle !== 'boolean'
      || !safeJobId(value.claimFence)
    ) {
      throw fixedFailure('ZONGZI_ENRICH_UPSTREAM_FAILED');
    }
    return {
      id: safeJobId(value.id),
      requestId: cleanText(value.requestId),
      sku: cleanText(value.sku),
      refreshBundle: value.refreshBundle === true,
      claimFence: safeJobId(value.claimFence),
    };
  };

  const normalizeSellerContext = (value) => {
    const companyId = cleanText(value?.companyId);
    const revision = Number(value?.revision);
    const observedAt = Number(value?.observedAt);
    if (
      value?.status !== 'READY'
      || !/^\d{4,15}$/.test(companyId)
      || !Number.isSafeInteger(revision)
      || revision <= 0
      || !Number.isFinite(observedAt)
      || Number.isNaN(new Date(observedAt).getTime())
    ) {
      throw fixedFailure('SELLER_CONTEXT_REQUIRED');
    }
    const sellerTabId = Number(value?.sellerTabId);
    return Object.freeze({
      status: 'READY',
      companyId,
      revision,
      observedAt,
      ...(Number.isSafeInteger(sellerTabId) && sellerTabId > 0 ? { sellerTabId } : {}),
    });
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
      throw fixedFailure('ZONGZI_ENRICH_UPSTREAM_FAILED');
    }
    const expectedSku = cleanText(sku);
    const matched = capture.data.items.find((item) =>
      isPlainObject(item) && candidateSkuValues(item).includes(expectedSku));
    if (!matched) throw fixedFailure('ZONGZI_ENRICH_NOT_FOUND');
    return matched;
  };

  function create({
    sessionManager,
    captureVariant,
    canCapture,
    sellerContextRuntime,
    onResult,
    beforeClaim = async () => {},
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
      || typeof sellerContextRuntime?.resolveCurrentWithRecovery !== 'function'
      || typeof sellerContextRuntime?.submitIfCurrent !== 'function'
      || (onResult != null && typeof onResult !== 'function')
      || typeof sleep !== 'function'
      || typeof now !== 'function'
      || typeof setTimer !== 'function'
      || typeof clearTimer !== 'function'
      || typeof root.AbortController !== 'function'
    ) {
      throw new TypeError('collector Ozon agent dependencies are required');
    }
    const drains = new Map();
    const leaseRecords = new WeakMap();
    let nextGeneration = 1;
    let availablePromise = null;
    let availableRequestedGeneration = 0;
    let pendingAvailableKicks = [];

    const deadlineFailure = () => fixedFailure('ZONGZI_ENRICH_UPSTREAM_FAILED');
    const deactivate = (entry) => {
      if (!entry?.active) return;
      entry.active = false;
      const controller = entry.currentController;
      entry.currentController = null;
      controller?.abort();
      entry.resolveCancelled();
      if (drains.get(entry.requestId) === entry) drains.delete(entry.requestId);
    };
    const leaseHandle = (entry, acquire = true) => {
      const releaseToken = Object.freeze(Object.create(null));
      if (acquire) entry.refs += 1;
      const leaseRecord = { entry, claimed: false };
      leaseRecords.set(releaseToken, leaseRecord);
      const handle = entry.running.then((value) => value);
      Object.defineProperty(handle, 'releaseToken', {
        get() {
          if (!leaseRecord.claimed) {
            leaseRecord.claimed = true;
            entry.tokenRefs += 1;
          }
          return releaseToken;
        },
        enumerable: false,
        configurable: false,
      });
      return handle;
    };
    const isCurrent = (entry, generation) => {
      return Boolean(
        entry?.active
        && (entry.refs > 0 || entry.executing === true)
        && entry.generation === generation
        && drains.get(entry.requestId) === entry,
      );
    };
    const ensureCurrent = (entry, generation) => {
      if (!isCurrent(entry, generation)) throw deadlineFailure();
    };
    const withLifecycle = async (promise, entry, generation) => {
      try {
        ensureCurrent(entry, generation);
      } catch (error) {
        // The caller has already started this operation. Expiry must consume
        // its eventual rejection even though it may no longer publish a result.
        Promise.resolve(promise).catch(() => {});
        throw error;
      }
      const value = await Promise.race([
        Promise.resolve(promise),
        entry.cancelled.then(() => { throw deadlineFailure(); }),
      ]);
      ensureCurrent(entry, generation);
      return value;
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

    const reportFailure = async (
      entry,
      generation,
      collectorOperation,
      rawJob,
      error,
      sellerContext,
    ) => {
      const id = safeJobId(rawJob?.id);
      const claimFence = safeJobId(rawJob?.claimFence);
      if (!id || !claimFence || !isCurrent(entry, generation)) return false;
      const failure = fixedFailure(error?.code, error);
      while (isCurrent(entry, generation)) {
        try {
          ensureCurrent(entry, generation);
          const response = await withLifecycle(
            sellerContextRuntime.submitIfCurrent(sellerContext, () => collectorRequest(
              entry,
              generation,
              collectorOperation,
              `/collector/ozon/enrichment-jobs/${encodeURIComponent(id)}/fail`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  code: failure.code,
                  message: failure.message,
                  ...(Object.keys(failure.diagnostic || {}).length ? { diagnostic: failure.diagnostic } : {}),
                  captureContext: captureContextFor(sellerContext),
                  claimFence,
                }),
              },
            )),
            entry,
            generation,
          );
          ensureCurrent(entry, generation);
          if (response === false) return false;
          if (response?.ok) return true;
          if (!(response?.status >= 500 || [408, 429].includes(response?.status))) return false;
          root.console?.warn('[collector-ozon-enrichment] failure_upload', id, `HTTP ${response.status}`);
        } catch (error) {
          if (!isCurrent(entry, generation)
            || (/^(COLLECTOR_|SELLER_CONTEXT)/.test(error?.code || '') && !/^SELLER_CONTEXT_SYNC_/.test(error?.code || ''))
            || error?.name === 'AbortError') return false;
          root.console?.warn('[collector-ozon-enrichment] failure_upload', id, safeErrorText(error?.message || error));
        }
        try {
          await withLifecycle(sleep(1000), entry, generation);
        } catch { return false; }
      }
      return false;
    };

    const captureContextFor = (sellerContext) => ({
      sellerCompanyId: cleanText(sellerContext.companyId),
      revision: Number(sellerContext.revision),
      observedAt: new Date(sellerContext.observedAt).toISOString(),
    });

    const executeClaim = async (
      entry,
      generation,
      collectorOperation,
      rawJob,
      sellerContext,
    ) => {
      let job;
      let progressTimer;
      let keepProgress = false;
      let capturedResult = false;
      try {
        job = normalizeJob(rawJob);
        ensureCurrent(entry, generation);
        entry.executing = true;
        keepProgress = true;
        const renew = async () => {
          if (!keepProgress || !isCurrent(entry, generation)) return;
          try {
            await sessionManager.collectorFetch(
              `/collector/ozon/enrichment-jobs/${encodeURIComponent(job.id)}/progress`,
              {
                collectorOperation, permission: READ_PERMISSION, method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ captureContext: captureContextFor(sellerContext), claimFence: job.claimFence }),
              },
            );
          } catch { /* A connection failure does not determine the capture outcome. */ }
          if (keepProgress) progressTimer = setTimer(renew, 10_000);
        };
        progressTimer = setTimer(renew, 10_000);
        const capture = await withLifecycle(captureVariant({
          sku: job.sku, noProxy: true, readOnly: false, automaticCapture: true,
          forceRefresh: job.refreshBundle === true, sellerContext,
        }), entry, generation);
        ensureCurrent(entry, generation);
        const captureCode = cleanText(capture?.error || capture?.code);
        if (capture?.ok !== true && SELLER_AUTH_CAPTURE_CODES.has(captureCode)) {
          throw fixedFailure('SELLER_CONTEXT_REQUIRED', capture);
        }
        if (capture?.ok !== true && ['HTTP_429', 'ANTIBOT_BLOCKED'].includes(captureCode)) throw fixedFailure('ZONGZI_ENRICH_BUSY', capture);
        if (capture?.ok !== true && Object.hasOwn(FAILURE_MESSAGES, captureCode)) throw fixedFailure(captureCode, capture);
        if (capture?.ok !== true) throw fixedFailure(captureCode, capture);
        const rawVariantData = matchedVariantData(capture, job.sku);
        assertRawVariantCredentialsSafe(rawVariantData);
        const variantData = projectVariantData(rawVariantData);
        assertSafeVariantData(variantData);
        ensureCurrent(entry, generation);
        capturedResult = true;
        // Result delivery is independent of source capture. A lost receipt or a
        // transient server failure retries the SAME result/fence; never /fail.
        while (isCurrent(entry, generation)) {
          let response;
          try {
            response = await withLifecycle(
              sellerContextRuntime.submitIfCurrent(sellerContext, () => collectorRequest(
                entry, generation, collectorOperation,
                `/collector/ozon/enrichment-jobs/${encodeURIComponent(job.id)}/result`,
                { method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ variantData, captureContext: captureContextFor(sellerContext), claimFence: job.claimFence }) },
              )), entry, generation,
            );
            ensureCurrent(entry, generation);
            if (response === false) return false;
            if (response?.ok) {
              try {
                await onResult?.({ sku: job.sku, variantData, collectorOperation, sellerContext });
              } catch (error) {
                root.console?.warn('[collector-ozon-enrichment] result_notification', job.sku, safeErrorText(error?.message || error));
              }
              return true;
            }
            if (!(response?.status >= 500 || [408, 429].includes(response?.status))) {
              const rejected = await jsonBody(response);
              const code = cleanText(rejected?.code);
              root.console?.warn('[collector-ozon-enrichment] result_rejected', job.sku, `HTTP ${response?.status}`, safeErrorText(code));
              // Service-level failures already persist their disposition. An
              // invalid envelope is rejected earlier, so record it explicitly.
              // Ownership, authorization and Seller rejections never post /fail.
              if (['ZONGZI_ENRICH_REQUEST_INVALID', 'OZON_ENRICH_REQUEST_INVALID'].includes(code) || ([413, 415].includes(response?.status) && !code)) {
                await reportFailure(entry, generation, collectorOperation, job, fixedFailure('ZONGZI_ENRICH_INCOMPLETE', {
                  message: '商品资料回传被服务端拒绝，请更新扩展后重试',
                  diagnostic: { stage: 'result_upload', upstreamCode: code || `HTTP_${response.status}`, upstreamStatus: response.status, requestSent: true },
                }), sellerContext);
              }
              return false;
            }
            root.console?.warn('[collector-ozon-enrichment] result_upload', job.sku, `HTTP ${response.status}`);
          } catch (error) {
            if (!isCurrent(entry, generation)
              || (/^(COLLECTOR_|SELLER_CONTEXT)/.test(error?.code || '') && !/^SELLER_CONTEXT_SYNC_/.test(error?.code || ''))
              || error?.name === 'AbortError') throw error;
            root.console?.warn('[collector-ozon-enrichment] result_upload', job.sku, safeErrorText(error?.message || error));
          }
          await withLifecycle(sleep(1000), entry, generation);
        }
        return false;
      } catch (error) {
        if (!capturedResult && isCurrent(entry, generation)) {
          await reportFailure(
            entry,
            generation,
            collectorOperation,
            job || rawJob,
            error,
            sellerContext,
          );
        }
        return false;
      } finally {
        keepProgress = false;
        clearTimer(progressTimer);
        entry.executing = false;
        if (entry.refs <= 0) deactivate(entry);
      }
    };

    const claimNext = (entry, generation, collectorOperation, sellerContext) =>
      withCollectorStage(entry, generation, async (signal) => {
        await beforeClaim();
        ensureCurrent(entry, generation);
        const response = await sessionManager.collectorFetch(NEXT_PATH, {
          collectorOperation,
          permission: READ_PERMISSION,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ captureContext: captureContextFor(sellerContext) }),
          signal,
        });
        ensureCurrent(entry, generation);
        if (!response?.ok) throw fixedFailure('ZONGZI_ENRICH_UPSTREAM_FAILED');
        const body = await jsonBody(response);
        ensureCurrent(entry, generation);
        if (!exactKeys(body, ['ok', 'job']) || body.ok !== true) {
          throw fixedFailure('ZONGZI_ENRICH_UPSTREAM_FAILED');
        }
        return body.job;
      });

    const runDrain = async (entry, generation, { stopWhenEmpty = false } = {}) => {
      let collectorOperation;
      try {
        collectorOperation = await withLifecycle(requireOperation(), entry, generation);
        ensureCurrent(entry, generation);
      } catch {
        return isCurrent(entry, generation) ? DRAIN_FAILED : DRAIN_CANCELLED;
      }
      if (!collectorOperation) return DRAIN_FAILED;
      while (isCurrent(entry, generation) && now() < entry.deadlineAt) {
        let canCaptureNow;
        try {
          ensureCurrent(entry, generation);
          canCaptureNow = await withCollectorStage(
            entry,
            generation,
            (signal) => canCapture(collectorOperation, { signal }),
          ) === true;
          ensureCurrent(entry, generation);
        } catch {
          return isCurrent(entry, generation) ? DRAIN_FAILED : DRAIN_CANCELLED;
        }
        if (!isCurrent(entry, generation) || now() >= entry.deadlineAt) break;
        if (!canCaptureNow) {
          if (stopWhenEmpty) return DRAIN_COMPLETED;
          try {
            await withLifecycle(
              sleep(Math.min(POLL_MS, Math.max(0, entry.deadlineAt - now()))),
              entry,
              generation,
            );
          } catch {}
          continue;
        }
        let sellerContext = null;
        let leasedSellerContext = null;
        const sellerContextPromise = Promise.resolve()
          .then(() => sellerContextRuntime.resolveCurrentWithRecovery());
        const releaseSellerContext = async (snapshot) => {
          if (!snapshot || typeof snapshot !== 'object') return false;
          try {
            return await sellerContextRuntime.releaseSnapshot?.(snapshot) === true;
          } catch {
            return false;
          }
        };
        try {
          leasedSellerContext = await withLifecycle(
            sellerContextPromise,
            entry,
            generation,
          );
          sellerContext = normalizeSellerContext(leasedSellerContext);
          ensureCurrent(entry, generation);
        } catch (error) {
          if (leasedSellerContext) {
            await releaseSellerContext(leasedSellerContext);
          } else {
            void sellerContextPromise.then(releaseSellerContext, () => false);
          }
          if (stopWhenEmpty) return DRAIN_FAILED;
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
          const job = await claimNext(entry, generation, collectorOperation, sellerContext);
          ensureCurrent(entry, generation);
          if (job) {
            await executeClaim(entry, generation, collectorOperation, job, sellerContext);
            continue;
          }
          if (stopWhenEmpty) return DRAIN_COMPLETED;
        } catch (error) {
          if (String(error?.message || '').startsWith('SELLER_ROUTE_BUSY')) return DRAIN_FAILED;
          // The held public request owns the user-facing error. Polling stays fail-closed.
        } finally {
          await releaseSellerContext(leasedSellerContext || sellerContext);
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
      return DRAIN_CANCELLED;
    };

    const drainUntil = (input = {}) => {
      if (!exactKeys(input, ['requestId', 'deadlineAt']) && !exactKeys(input, ['requestId'])) {
        return Promise.reject(new TypeError('collector Ozon drain input is invalid'));
      }
      const requestId = typeof input.requestId === 'string' ? cleanText(input.requestId) : '';
      const requestedDeadline = input.deadlineAt === undefined ? Infinity : Number(input.deadlineAt);
      if (!requestId || (input.deadlineAt !== undefined && !Number.isFinite(requestedDeadline))) {
        return Promise.reject(new TypeError('collector Ozon drain input is invalid'));
      }
      const deadlineAt = requestedDeadline;
      const existing = drains.get(requestId);
      if (existing?.active) {
        existing.deadlineAt = Math.max(existing.deadlineAt, deadlineAt);
        return leaseHandle(existing);
      }
      let resolveCancelled;
      const cancelled = new Promise((resolve) => { resolveCancelled = resolve; });
      const entry = {
        requestId,
        generation: nextGeneration,
        refs: 1,
        tokenRefs: 0,
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
      return leaseHandle(entry, false);
    };

    const pruneAvailableKicks = (observedAt = now()) => {
      const live = [];
      for (const kick of pendingAvailableKicks) {
        if (kick.deadlineAt > observedAt) live.push(kick);
      }
      pendingAvailableKicks = live;
      return live;
    };

    const runAvailableRound = async (deadlineAt) => {
      let resolveCancelled;
      const cancelled = new Promise((resolve) => { resolveCancelled = resolve; });
      const entry = {
        requestId: AVAILABLE_DRAIN_ID,
        generation: nextGeneration,
        refs: 1,
        tokenRefs: 0,
        deadlineAt,
        active: true,
        currentController: null,
        cancelled,
        resolveCancelled,
        running: null,
      };
      nextGeneration += 1;
      drains.set(entry.requestId, entry);
      entry.running = runDrain(entry, entry.generation, { stopWhenEmpty: true })
        .finally(() => deactivate(entry));
      return entry.running;
    };

    const runAvailableOwner = async (ownerDeadlineAt) => {
      while (true) {
        const observedAt = now();
        if (observedAt >= ownerDeadlineAt) return 0;
        const live = pruneAvailableKicks(observedAt);
        if (live.length === 0) return 0;

        const roundGeneration = live[live.length - 1].generation;
        const outcome = await runAvailableRound(ownerDeadlineAt);
        if (outcome === DRAIN_FAILED) return roundGeneration;
        if (outcome === DRAIN_CANCELLED) return 0;
        // Commit only the kicks covered by an explicit empty stop; cancellation keeps them live.
        pendingAvailableKicks = pendingAvailableKicks.filter(
          ({ generation }) => generation > roundGeneration,
        );
      }
    };

    const runAvailableOwners = async () => {
      while (true) {
        const live = pruneAvailableKicks();
        if (live.length === 0) return 0;
        // A successor coalesces the current live queue, but never changes an active owner's deadline.
        const ownerDeadlineAt = Math.max(...live.map(({ deadlineAt }) => deadlineAt));
        const failedGeneration = await runAvailableOwner(ownerDeadlineAt);
        // A newer external kick authorizes one retry; the failed generation alone stays parked.
        if (
          failedGeneration > 0
          && !pruneAvailableKicks().some(({ generation }) => generation > failedGeneration)
        ) {
          return failedGeneration;
        }
      }
    };

    const drainAvailable = (input = {}) => {
      if (!exactKeys(input, ['deadlineAt']) || !Number.isFinite(Number(input.deadlineAt))) {
        return Promise.reject(new TypeError('collector Ozon available drain input is invalid'));
      }
      const deadlineAt = Math.min(Number(input.deadlineAt), now() + MAX_DRAIN_MS);
      availableRequestedGeneration += 1;
      pendingAvailableKicks.push({
        generation: availableRequestedGeneration,
        deadlineAt,
      });
      if (availablePromise) return availablePromise;
      let blockedGeneration = 0;
      const runOwners = async () => {
        blockedGeneration = await runAvailableOwners();
      };
      const hasRunnableKicks = () => {
        const live = pruneAvailableKicks();
        return live.length > 0 && (
          blockedGeneration === 0
          || live.some(({ generation }) => generation > blockedGeneration)
        );
      };
      let exposed;
      exposed = runOwners().finally(async () => {
        while (availablePromise === exposed && hasRunnableKicks()) {
          blockedGeneration = await runAvailableOwners();
        }
        if (availablePromise === exposed) {
          availablePromise = null;
        }
      });
      availablePromise = exposed;
      return exposed;
    };

    const stop = function stop(requestId, releaseToken) {
      const normalizedRequestId = cleanText(requestId);
      if (arguments.length >= 2) {
        if (!releaseToken || typeof releaseToken !== 'object') return false;
        const leaseRecord = leaseRecords.get(releaseToken);
        const entry = leaseRecord?.entry;
        if (!entry || entry.requestId !== normalizedRequestId || entry.refs <= 0) return false;
        leaseRecords.delete(releaseToken);
        entry.refs -= 1;
        if (leaseRecord.claimed) entry.tokenRefs -= 1;
        if (entry.refs === 0 && entry.active && !entry.executing) deactivate(entry);
        return true;
      }

      // Compatibility only: token-aware production callers never use this force-stop path.
      const entry = drains.get(normalizedRequestId);
      if (!entry?.active || entry.refs !== 1 || entry.tokenRefs !== 0) return false;
      deactivate(entry);
      return true;
    };

    return Object.freeze({ drainAvailable, drainUntil, stop, isBusy: () => Boolean(availablePromise) || [...drains.values()].some(entry => entry.active || entry.executing) });
  }

  const api = Object.freeze({ create });
  root.JzCollectorOzonAgent = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
