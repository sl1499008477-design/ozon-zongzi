import crypto from "node:crypto";
import {
  OZON_ENRICHMENT_CONTRACT_VERSION,
  normalizeOzonAgentResult,
} from "./collector-ozon-enrichment-contract.mjs";
import { sanitizeCollectorText } from "./collector-auth-service.mjs";
import {
  assertOzonListingReady,
  mergeOzonEnrichmentResult,
} from "./collect-enrichment-policy.mjs";

const SOURCE = "ozon";
const COMPLETE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const DEADLINE_MS = 20 * 1000;
// Seller capture performs two sequential portal calls (each capped at six
// seconds) and still needs time to commit the result. Keep a five-second recovery
// window inside the public deadline so another live Collector can retry a dead
// executor without invalidating a healthy capture midway through its work.
const CLAIM_TTL_MS = 15 * 1000;
const POLL_MS = 250;
const BATCH_CONCURRENCY = 4;
const MERGE_MAX_ATTEMPTS = 4;
const REQUIRED_MISSING_FIELDS = new Set([
  "descriptionCategoryId",
  "weightG",
  "lengthMm",
  "widthMm",
  "heightMm",
]);

const EXECUTOR_FAILURES = Object.freeze({
  OZON_ENRICH_NOT_FOUND: Object.freeze({
    status: 404,
    message: "未找到 Ozon 商品资料",
    retryable: false,
    disposition: "NEEDS_ATTENTION",
  }),
  OZON_ENRICH_INCOMPLETE: Object.freeze({
    status: 422,
    message: "Ozon 商品资料不完整",
    retryable: false,
    disposition: "NEEDS_ATTENTION",
  }),
  OZON_ENRICH_BUSY: Object.freeze({
    status: 429,
    message: "Ozon 商品资料正在排队，请稍后重试",
    retryable: true,
    disposition: "RETRYING",
  }),
  OZON_ENRICH_UPSTREAM_FAILED: Object.freeze({
    status: 502,
    message: "Ozon 商品资料暂时无法读取",
    retryable: true,
    disposition: "RETRYING",
  }),
  SELLER_CONTEXT_REQUIRED: Object.freeze({
    status: 409,
    message: "需要打开并登录 Ozon Seller 页面",
    retryable: true,
    disposition: "WAITING_FOR_SELLER",
  }),
  SELLER_CONTEXT_CHANGED: Object.freeze({
    status: 409,
    message: "Ozon Seller 账号上下文已变化",
    retryable: true,
    disposition: "WAITING_FOR_SELLER",
  }),
});

const PUBLIC_SERVICE_FAILURES = Object.freeze({
  OZON_ENRICH_BUSY: Object.freeze({
    status: 429,
    message: "Ozon 商品资料正在排队，请稍后重试",
    retryable: true,
  }),
  OZON_ENRICH_REQUEST_EXPIRED: Object.freeze({
    status: 409,
    message: "该补全请求已过期，请使用新的 requestId 重试",
    retryable: false,
  }),
  OZON_ENRICHMENT_JOB_NOT_FOUND: Object.freeze({
    status: 404,
    message: "Ozon 商品补全任务不存在",
    retryable: false,
  }),
  OZON_ENRICHMENT_JOB_OWNERSHIP: Object.freeze({
    status: 409,
    message: "Collector 会话不拥有该 Ozon 商品补全任务",
    retryable: false,
  }),
  OZON_ENRICH_UPSTREAM_FAILED: Object.freeze({
    status: 502,
    message: "Ozon 商品资料暂时无法读取",
    retryable: true,
  }),
  COLLECT_ITEM_NOT_FOUND: Object.freeze({
    status: 404,
    message: "采集箱条目不存在",
    retryable: false,
  }),
  SELLER_CONTEXT_CHANGED: Object.freeze({
    status: 409,
    message: "Ozon Seller 账号上下文已变化",
    retryable: true,
  }),
});

function cleanText(value, max = 240) {
  return sanitizeCollectorText(value, { max });
}

function instant(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw enrichmentError(500, "OZON_ENRICH_UPSTREAM_FAILED", "Ozon 商品资料时间无效");
  }
  return date;
}

function requiredText(value, code, message, status = 400) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw enrichmentError(status, code, message, { retryable: false });
  return normalized;
}

function sessionScope(value = {}) {
  const accountId = requiredText(
    value.accountId,
    "COLLECTOR_AUTH_REQUIRED",
    "需要 Collector 采集认证",
    401,
  );
  const collectorSessionId = requiredText(
    value.collectorSessionId,
    "COLLECTOR_AUTH_REQUIRED",
    "需要 Collector 采集认证",
    401,
  );
  return { accountId, collectorSessionId };
}

function stableMissingFields(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((field) => String(field || ""))
      .filter((field) => REQUIRED_MISSING_FIELDS.has(field)),
  )];
}

function responseSha256(value) {
  function canonicalJsonValue(input) {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (Array.isArray(input)) {
      return input.map((item) => {
        const normalized = canonicalJsonValue(item);
        return normalized === undefined ? null : normalized;
      });
    }
    if (input && typeof input === "object") {
      if (typeof input.toJSON === "function") return canonicalJsonValue(input.toJSON());
      const normalized = {};
      for (const key of Object.keys(input).sort()) {
        const child = canonicalJsonValue(input[key]);
        if (child !== undefined) normalized[key] = child;
      }
      return normalized;
    }
    if (typeof input === "bigint") {
      throw new TypeError("Ozon enrichment response hash requires JSON-representable values");
    }
    return undefined;
  }

  const canonical = canonicalJsonValue(value);
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonical === undefined ? null : canonical))
    .digest("hex");
}

function cacheKey(accountId, sku) {
  return {
    accountId,
    source: SOURCE,
    sku,
    contractVersion: OZON_ENRICHMENT_CONTRACT_VERSION,
  };
}

function cachedResult(record, hit) {
  const result = structuredClone(record.result);
  result.cache = { hit, expiresAt: String(record.expiresAt || result.cache?.expiresAt || "") };
  return result;
}

function executorFailureCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (Object.hasOwn(EXECUTOR_FAILURES, normalized)) return normalized;
  if (normalized === "HTTP_429") return "OZON_ENRICH_BUSY";
  if (
    normalized === "NETWORK_ERROR"
    || normalized === "TIMEOUT"
    || normalized === "ETIMEDOUT"
    || /^HTTP_5\d\d$/.test(normalized)
  ) return "OZON_ENRICH_UPSTREAM_FAILED";
  if (
    normalized === "OZON_ENRICH_INVALID"
    || normalized === "COLLECT_ENRICHMENT_INCOMPLETE"
  ) return "OZON_ENRICH_INCOMPLETE";
  return "OZON_ENRICH_UPSTREAM_FAILED";
}

function stableExecutorError(code, missingFields = []) {
  const stableCode = executorFailureCode(code);
  const policy = EXECUTOR_FAILURES[stableCode];
  return {
    status: policy.status,
    code: stableCode,
    message: policy.message,
    missingFields: stableMissingFields(missingFields),
    retryable: policy.retryable,
    disposition: policy.disposition,
  };
}

function errorPayload(error) {
  return {
    code: String(error?.code || "OZON_ENRICH_UPSTREAM_FAILED"),
    message: cleanText(error?.message || "Ozon 商品资料暂时无法读取"),
    missingFields: stableMissingFields(error?.missingFields),
    retryable: error?.retryable !== false,
  };
}

function batchError(error) {
  const stable = publicServiceError(error);
  return {
    code: stable.code,
    message: stable.message,
    missingFields: stableMissingFields(stable.missingFields),
    retryable: stable.retryable,
  };
}

function auditStatus(error) {
  return error ? "FAILED" : "SUCCESS";
}

function enrichmentError(status, code, message, details = {}) {
  const missingFields = stableMissingFields(details.missingFields);
  const retryable = details.retryable ?? (status === 429 || status >= 500);
  return Object.assign(new Error(cleanText(message || "Ozon 商品资料补全失败")), {
    status,
    code: String(code || "OZON_ENRICH_UPSTREAM_FAILED"),
    missingFields,
    retryable: Boolean(retryable),
    isPublicOzonEnrichmentError: true,
  });
}

function publicServiceError(error) {
  if (error?.isPublicOzonEnrichmentError === true) return error;
  const repositoryCode = String(error?.code || "");
  let code = "OZON_ENRICH_UPSTREAM_FAILED";
  if (repositoryCode === "OZON_ENRICH_BUSY") {
    code = repositoryCode;
  } else if (repositoryCode === "OZON_ENRICHMENT_JOB_NOT_FOUND") {
    code = repositoryCode;
  } else if (repositoryCode === "COLLECT_ITEM_NOT_FOUND") {
    code = repositoryCode;
  } else if (repositoryCode === "SELLER_CONTEXT_CHANGED") {
    code = repositoryCode;
  } else if ([
    "OZON_ENRICHMENT_JOB_OWNERSHIP",
    "OZON_ENRICHMENT_JOB_TERMINAL",
    "OZON_ENRICHMENT_SESSION_SCOPE",
  ].includes(repositoryCode)) {
    code = "OZON_ENRICHMENT_JOB_OWNERSHIP";
  }
  const policy = PUBLIC_SERVICE_FAILURES[code];
  return enrichmentError(policy.status, code, policy.message, {
    retryable: policy.retryable,
  });
}

function errorFromJob(job = {}) {
  const error = job?.error && typeof job.error === "object" ? job.error : {};
  const stable = stableExecutorError(String(error.code || ""), error.missingFields);
  return enrichmentError(
    Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
      ? error.status
      : stable.status,
    stable.code,
    stable.message,
    { missingFields: stable.missingFields, retryable: stable.retryable },
  );
}

export function createCollectorOzonEnrichmentService({
  repository,
  collectItems = null,
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  audit = async () => {},
  onAuditError = (event) => console.error("collector Ozon enrichment audit failed", event),
  assertListingReady = assertOzonListingReady,
  categoryEvidencePort = null,
} = {}) {
  const repositoryMethods = [
    "readCache",
    "tryAcquireCacheLease",
    "releaseCacheLease",
    "createOrGetJob",
    "advanceSellerContext",
    "claimNextJob",
    "hasClaimableJob",
    "deferClaim",
    "completeJobAndCache",
    "failJobAndCache",
    "readJob",
  ];
  if (!repository || repositoryMethods.some((method) => typeof repository[method] !== "function")) {
    throw new TypeError("Ozon enrichment service repository contract required");
  }
  const collectItemPort = Object.freeze({
    read: async () => null,
    save: async () => null,
    complete: async () => null,
    fail: async () => null,
    defer: async () => null,
    retry: async () => null,
    ...(collectItems || {}),
  });
  if (
    !collectItemPort
    || ["read", "save", "complete", "fail", "defer", "retry"]
      .some((method) => typeof collectItemPort[method] !== "function")
  ) {
    throw new TypeError("Ozon enrichment collect item contract required");
  }
  if (
    typeof now !== "function"
    || typeof randomUUID !== "function"
    || typeof sleep !== "function"
    || typeof audit !== "function"
    || typeof onAuditError !== "function"
    || typeof assertListingReady !== "function"
    || (categoryEvidencePort !== null
      && typeof categoryEvidencePort?.recordCollectionResult !== "function")
  ) {
    throw new TypeError("Ozon enrichment service dependencies are required");
  }
  async function writeAudit(event) {
    try {
      await audit(event);
    } catch {
      try {
        await onAuditError({
          action: String(event.action || ""),
          accountId: String(event.accountId || ""),
          requestId: String(event.requestId || ""),
          jobId: String(event.jobId || ""),
        });
      } catch {
        // A secondary observability sink must not corrupt a persisted business transition.
      }
    }
  }

  async function waitForJob({ accountId, jobId, deadlineAt }) {
    while (instant(now()).getTime() < deadlineAt.getTime()) {
      const current = await repository.readJob({ accountId, jobId });
      if (current?.status === "SUCCESS") return current.result;
      if (current?.status === "FAILED") throw errorFromJob(current);
      await sleep(POLL_MS);
    }
    throw enrichmentError(
      504,
      "OZON_ENRICH_UPSTREAM_FAILED",
      "Ozon 商品资料读取超时",
      { retryable: true },
    );
  }

  async function waitForSharedCacheOrLease({ key, leaseOwner, deadlineAt }) {
    while (instant(now()).getTime() < deadlineAt.getTime()) {
      const currentTime = instant(now());
      const current = await repository.readCache({ key, now: currentTime });
      if (current?.status === "COMPLETE") {
        return { acquired: false, result: cachedResult(current, false) };
      }
      if (current?.status === "ERROR") throw errorFromJob({ error: current.error });
      const lease = await repository.tryAcquireCacheLease({
        key,
        leaseOwner,
        leaseExpiresAt: deadlineAt,
        now: currentTime,
        maxActiveLeases: BATCH_CONCURRENCY,
      });
      if (lease) return { acquired: true };
      await sleep(POLL_MS);
    }
    throw enrichmentError(
      504,
      "OZON_ENRICH_UPSTREAM_FAILED",
      "Ozon 商品资料读取超时",
      { retryable: true },
    );
  }

  async function enrichOne({ session, requestId, sku } = {}) {
    const scoped = sessionScope(session);
    const normalizedRequestId = requiredText(
      requestId,
      "OZON_ENRICH_REQUEST_ID_REQUIRED",
      "补全请求缺少 requestId",
    );
    const normalizedSku = requiredText(sku, "OZON_ENRICH_SKU_REQUIRED", "补全请求缺少 SKU");
    const startedAt = instant(now());
    const deadlineAt = new Date(startedAt.getTime() + DEADLINE_MS);
    const key = cacheKey(scoped.accountId, normalizedSku);
    let jobId = "";
    let leaseOwner = "";
    let cacheHit = false;
    let result;
    let failure;

    try {
      const liveCache = await repository.readCache({ key, now: startedAt });
      if (liveCache?.status === "COMPLETE") {
        cacheHit = true;
        result = cachedResult(liveCache, true);
        return result;
      }
      if (liveCache?.status === "ERROR") {
        cacheHit = true;
        throw errorFromJob({ error: liveCache.error });
      }

      const staleCache = await repository.readCache({
        key,
        now: startedAt,
        includeExpired: true,
      });
      leaseOwner = requiredText(
        randomUUID(),
        "OZON_ENRICH_UPSTREAM_FAILED",
        "无法创建 Ozon 商品补全任务",
        502,
      );
      const leaseOutcome = await waitForSharedCacheOrLease({ key, leaseOwner, deadlineAt });
      if (!leaseOutcome.acquired) {
        result = leaseOutcome.result;
        return result;
      }
      const acquiredAt = instant(now());
      if (acquiredAt.getTime() >= deadlineAt.getTime()) {
        await repository.releaseCacheLease({ key, leaseOwner });
        throw enrichmentError(
          504,
          "OZON_ENRICH_UPSTREAM_FAILED",
          "Ozon 商品资料读取超时",
          { retryable: true },
        );
      }

      let job;
      try {
        job = await repository.createOrGetJob({
          id: leaseOwner,
          accountId: scoped.accountId,
          requestId: normalizedRequestId,
          sku: normalizedSku,
          preferredSessionId: staleCache?.status === "COMPLETE"
            ? staleCache.executorSessionId || null
            : null,
          refreshBundle: true,
          deadlineAt,
          createdAt: acquiredAt,
        });
      } catch (error) {
        await repository.releaseCacheLease({ key, leaseOwner });
        throw error;
      }
      jobId = String(job.id);
      if (job.status === "SUCCESS" || job.status === "FAILED") {
        await repository.releaseCacheLease({ key, leaseOwner });
        throw enrichmentError(
          409,
          "OZON_ENRICH_REQUEST_EXPIRED",
          "该补全请求已过期，请使用新的 requestId 重试",
          { retryable: false },
        );
      }
      result = await waitForJob({
        accountId: scoped.accountId,
        jobId,
        deadlineAt,
      });
      return result;
    } catch (error) {
      failure = publicServiceError(error);
      throw failure;
    } finally {
      const finishedAt = instant(now());
      const responseHash = responseSha256(result || errorPayload(failure));
      await writeAudit({
        action: "collector.ozon.enrich",
        requestId: normalizedRequestId,
        accountId: scoped.accountId,
        sku: normalizedSku,
        jobId,
        collectorSessionId: scoped.collectorSessionId,
        cacheHit,
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        status: auditStatus(failure),
        code: String(failure?.code || ""),
        missingFields: stableMissingFields(failure?.missingFields),
        responseHash,
      });
    }
  }

  async function enrichBatch({ session, requestId, skus } = {}) {
    const scoped = sessionScope(session);
    const normalizedRequestId = requiredText(
      requestId,
      "OZON_ENRICH_REQUEST_ID_REQUIRED",
      "补全请求缺少 requestId",
    );
    if (!Array.isArray(skus) || !skus.length) {
      throw enrichmentError(
        400,
        "OZON_ENRICH_BATCH_SKUS_REQUIRED",
        "补全请求缺少 SKU 列表",
        { retryable: false },
      );
    }
    const normalizedSkus = skus.map((sku) => requiredText(
      sku,
      "OZON_ENRICH_SKU_REQUIRED",
      "补全请求缺少 SKU",
    ));
    const output = new Array(normalizedSkus.length);
    let nextIndex = 0;
    async function worker() {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= normalizedSkus.length) return;
        const sku = normalizedSkus[index];
        try {
          output[index] = {
            sku,
            status: "COMPLETE",
            result: await enrichOne({ session: scoped, requestId: normalizedRequestId, sku }),
          };
        } catch (error) {
          output[index] = { sku, status: "ERROR", error: batchError(error) };
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(BATCH_CONCURRENCY, normalizedSkus.length) }, () => worker()),
    );
    return output;
  }

  async function observeSellerContext({ session, captureContext } = {}) {
    const scoped = sessionScope(session);
    try {
      await repository.advanceSellerContext({
        accountId: scoped.accountId,
        collectorSessionId: scoped.collectorSessionId,
        captureContext,
        now: instant(now()),
      });
    } catch (error) {
      throw publicServiceError(error);
    }
  }

  async function hasAvailableJob({ session } = {}) {
    const scoped = sessionScope(session);
    try {
      return Boolean(await repository.hasClaimableJob({
        accountId: scoped.accountId,
        collectorSessionId: scoped.collectorSessionId,
        now: instant(now()),
      }));
    } catch (error) {
      throw publicServiceError(error);
    }
  }

  async function claimNext({ session, captureContext = null } = {}) {
    const scoped = sessionScope(session);
    const claimedAt = instant(now());
    const claimFence = requiredText(
      randomUUID(),
      "OZON_ENRICH_UPSTREAM_FAILED",
      "Ozon 商品资料任务围栏无效",
      500,
    );
    let job;
    try {
      job = await repository.claimNextJob({
        accountId: scoped.accountId,
        collectorSessionId: scoped.collectorSessionId,
        now: claimedAt,
        claimExpiresAt: new Date(claimedAt.getTime() + CLAIM_TTL_MS),
        claimFence,
        captureContext,
      });
    } catch (error) {
      const failure = publicServiceError(error);
      await writeAudit({
        action: "collector.ozon.enrichment.claim",
        requestId: "",
        accountId: scoped.accountId,
        sku: "",
        jobId: "",
        collectorSessionId: scoped.collectorSessionId,
        cacheHit: false,
        durationMs: 0,
        status: "FAILED",
        code: failure.code,
        missingFields: failure.missingFields,
        responseHash: responseSha256(errorPayload(failure)),
      });
      throw failure;
    }
    if (!job) return null;
    const exposed = {
      id: String(job.id),
      requestId: String(job.requestId),
      sku: String(job.sku),
      refreshBundle: job.refreshBundle === true,
      claimFence: String(job.claimFence || claimFence),
    };
    await writeAudit({
      action: "collector.ozon.enrichment.claim",
      requestId: exposed.requestId,
      accountId: scoped.accountId,
      sku: exposed.sku,
      jobId: exposed.id,
      collectorSessionId: scoped.collectorSessionId,
      cacheHit: false,
      durationMs: 0,
      status: "SUCCESS",
      missingFields: [],
      responseHash: responseSha256(exposed),
    });
    return exposed;
  }

  function assertClaimOwnership(job, scoped, at) {
    if (
      !job
      || job.accountId !== scoped.accountId
      || job.status !== "PROCESSING"
      || job.claimedSessionId !== scoped.collectorSessionId
      || !job.claimExpiresAt
      || new Date(job.claimExpiresAt).getTime() <= at.getTime()
      || !job.deadlineAt
      || new Date(job.deadlineAt).getTime() <= at.getTime()
    ) {
      throw enrichmentError(
        409,
        "OZON_ENRICHMENT_JOB_OWNERSHIP",
        "Collector 会话不拥有该 Ozon 商品补全任务",
        { retryable: false },
      );
    }
  }

  function sameSellerContextSnapshot(left, right) {
    if (left == null || right == null) return left == null && right == null;
    const leftObservedAt = new Date(left.observedAt).toISOString();
    const rightObservedAt = new Date(right.observedAt).toISOString();
    return String(left.sellerCompanyId || "") === String(right.sellerCompanyId || "")
      && Number(left.revision) === Number(right.revision)
      && leftObservedAt === rightObservedAt;
  }

  function assertClaimFence(job, claimFence, captureContext) {
    if (
      String(job?.claimFence || "") !== String(claimFence || "")
      || !sameSellerContextSnapshot(job?.captureContext ?? null, captureContext ?? null)
    ) {
      throw enrichmentError(
        409,
        "SELLER_CONTEXT_CHANGED",
        "Ozon Seller 账号上下文已变化",
        { retryable: true },
      );
    }
  }

  function failurePersistence({ scoped, job, at, error, captureContext, claimFence }) {
    const stable = stableExecutorError(String(error?.code || ""), error?.missingFields);
    const persistedError = { status: stable.status, code: stable.code };
    const requestedTtl = Number(error?.retryAfterMs);
    const negativeTtl = Number.isFinite(requestedTtl) && requestedTtl > 0
      ? Math.min(NEGATIVE_TTL_MS, requestedTtl)
      : NEGATIVE_TTL_MS;
    const expiresAt = new Date(at.getTime() + negativeTtl);
    const key = cacheKey(scoped.accountId, job.sku);
    return {
      stable,
      failure: {
        accountId: scoped.accountId,
        collectorSessionId: scoped.collectorSessionId,
        jobId: job.id,
        key,
        error: persistedError,
        responseHash: responseSha256(persistedError),
        capturedAt: at,
        expiresAt,
        captureContext,
        claimFence,
        now: at,
      },
    };
  }

  async function persistFailure(input) {
    const planned = failurePersistence(input);
    const persistedJob = await repository.failJobAndCache(planned.failure);
    return { stable: planned.stable, job: persistedJob };
  }

  function collectItemMissing() {
    return enrichmentError(
      404,
      "COLLECT_ITEM_NOT_FOUND",
      "采集箱条目不存在",
      { retryable: false },
    );
  }

  function linkedSummary({ status, job, error = null, nextAttemptAt = "", capturedAt = "" }) {
    const attemptCount = Number(job?.attemptCount || 0);
    return {
      status,
      missingFields: stableMissingFields(error?.missingFields),
      attemptCount,
      nextAttemptAt: String(nextAttemptAt || ""),
      lastErrorCode: String(error?.code || ""),
      ...(capturedAt ? { capturedAt: String(capturedAt) } : {}),
    };
  }

  async function applyExecutorFailure({
    scoped,
    job,
    at,
    error,
    captureContext = undefined,
    claimFence = undefined,
  }) {
    const stable = stableExecutorError(String(error?.code || ""), error?.missingFields);
    if (stable.retryable && job.collectItemId) {
      const deferred = await collectItemPort.defer({
        accountId: job.accountId,
        collectItemId: job.collectItemId,
        status: stable.disposition,
        error: stable,
        deferClaim: {
          accountId: scoped.accountId,
          collectorSessionId: scoped.collectorSessionId,
          jobId: job.id,
          error: stable,
          captureContext,
          claimFence,
          now: at,
        },
      });
      if (!deferred?.item || !deferred?.job) throw collectItemMissing();
      return { stable, job: deferred.job };
    }
    if (job.collectItemId) {
      const planned = failurePersistence({
        scoped,
        job,
        at,
        error: stable,
        captureContext,
        claimFence,
      });
      const persisted = await collectItemPort.fail({
        accountId: job.accountId,
        collectItemId: job.collectItemId,
        status: planned.stable.disposition,
        enrichment: linkedSummary({
          status: planned.stable.disposition,
          job,
          error: planned.stable,
        }),
        failure: planned.failure,
      });
      if (!persisted?.item || !persisted?.job) throw collectItemMissing();
      return { stable: planned.stable, job: persisted.job };
    }
    return persistFailure({
      scoped,
      job,
      at,
      error: stable,
      captureContext,
      claimFence,
    });
  }

  async function mergeLinkedCollectItem({ job, result, completedAt, completion }) {
    if (!job.collectItemId) return null;
    let lastConflict = null;
    for (let attempt = 0; attempt < MERGE_MAX_ATTEMPTS; attempt += 1) {
      const current = await collectItemPort.read({
        accountId: job.accountId,
        collectItemId: job.collectItemId,
      });
      if (!current) throw collectItemMissing();
      const listingDraft = mergeOzonEnrichmentResult(current.listingDraft || {}, result);
      assertListingReady(listingDraft);
      try {
        const saved = await collectItemPort.complete({
          accountId: job.accountId,
          collectItemId: job.collectItemId,
          expectedVersion: Number(current.draftVersion || 0),
          listingDraft,
          status: "COMPLETE",
          enrichment: linkedSummary({
            status: "COMPLETE",
            job,
            capturedAt: completedAt.toISOString(),
          }),
          completion,
          ...(categoryEvidencePort ? { categoryEvidence: { result, completedAt } } : {}),
        });
        if (!saved) throw collectItemMissing();
        return saved;
      } catch (error) {
        if (!["DRAFT_VERSION_CONFLICT", "LOCAL_STATE_VERSION_CONFLICT"].includes(error?.code)) {
          throw error;
        }
        lastConflict = error;
      }
    }
    throw lastConflict || enrichmentError(
      409,
      "OZON_ENRICH_UPSTREAM_FAILED",
      "采集草稿并发更新失败",
      { retryable: true },
    );
  }

  async function completeClaim({
    session,
    jobId,
    variantData,
    captureContext = undefined,
    claimFence = undefined,
  } = {}) {
    const scoped = sessionScope(session);
    const normalizedJobId = requiredText(
      jobId,
      "OZON_ENRICHMENT_JOB_NOT_FOUND",
      "Ozon 商品补全任务不存在",
      404,
    );
    const completedAt = instant(now());
    let job = null;
    let responseHash = "";
    try {
      job = await repository.readJob({ accountId: scoped.accountId, jobId: normalizedJobId });
      assertClaimOwnership(job, scoped, completedAt);
      const fencedCaptureContext = captureContext === undefined
        ? (job.captureContext ?? null)
        : captureContext;
      const fencedClaim = claimFence === undefined ? job.claimFence : claimFence;
      if (job.claimFence != null || claimFence !== undefined) {
        assertClaimFence(job, fencedClaim, fencedCaptureContext);
      }
      let normalized;
      try {
        normalized = normalizeOzonAgentResult({
          sku: job.sku,
          variantData,
          source: "EXTENSION_SELLER_CAPTURE",
          capturedAt: completedAt.toISOString(),
        });
      } catch (error) {
        const { stable } = await applyExecutorFailure({
          scoped,
          job,
          at: completedAt,
          error,
          captureContext: fencedCaptureContext,
          claimFence: fencedClaim,
        });
        throw enrichmentError(stable.status, stable.code, stable.message, stable);
      }
      const expiresAt = new Date(completedAt.getTime() + COMPLETE_TTL_MS);
      const result = {
        ...normalized,
        cache: { hit: false, expiresAt: expiresAt.toISOString() },
      };
      responseHash = responseSha256(result);
      const completion = {
        accountId: scoped.accountId,
        collectorSessionId: scoped.collectorSessionId,
        jobId: normalizedJobId,
        key: cacheKey(scoped.accountId, job.sku),
        result,
        responseHash,
        executorSessionId: scoped.collectorSessionId,
        capturedAt: completedAt,
        expiresAt,
        captureContext: fencedCaptureContext,
        claimFence: fencedClaim,
      };
      if (job.collectItemId) {
        try {
          await mergeLinkedCollectItem({ job, result, completedAt, completion });
        } catch (error) {
          if (error?.code !== "COLLECT_ENRICHMENT_INCOMPLETE") throw error;
          const { stable } = await applyExecutorFailure({
            scoped,
            job,
            at: completedAt,
            error,
            captureContext: fencedCaptureContext,
            claimFence: fencedClaim,
          });
          throw enrichmentError(stable.status, stable.code, stable.message, stable);
        }
      } else {
        await repository.completeJobAndCache({ ...completion, now: instant(now()) });
      }
      await writeAudit({
        action: "collector.ozon.enrichment.complete",
        requestId: job.requestId,
        accountId: scoped.accountId,
        sku: job.sku,
        jobId: job.id,
        collectorSessionId: scoped.collectorSessionId,
        cacheHit: false,
        durationMs: Math.max(0, completedAt.getTime() - new Date(job.createdAt).getTime()),
        status: "SUCCESS",
        code: "",
        missingFields: [],
        responseHash,
        captureContext: fencedCaptureContext,
      });
      return result;
    } catch (error) {
      const failure = publicServiceError(error);
      responseHash = responseSha256(errorPayload(failure));
      await writeAudit({
        action: "collector.ozon.enrichment.complete",
        requestId: String(job?.requestId || ""),
        accountId: scoped.accountId,
        sku: String(job?.sku || ""),
        jobId: String(job?.id || normalizedJobId),
        collectorSessionId: scoped.collectorSessionId,
        cacheHit: false,
        durationMs: job?.createdAt
          ? Math.max(0, completedAt.getTime() - new Date(job.createdAt).getTime())
          : 0,
        status: "FAILED",
        code: failure.code,
        missingFields: failure.missingFields,
        responseHash,
      });
      throw failure;
    }
  }

  async function failClaim({
    session,
    jobId,
    code,
    captureContext = undefined,
    claimFence = undefined,
  } = {}) {
    const scoped = sessionScope(session);
    const normalizedJobId = requiredText(
      jobId,
      "OZON_ENRICHMENT_JOB_NOT_FOUND",
      "Ozon 商品补全任务不存在",
      404,
    );
    const failedAt = instant(now());
    let job = null;
    try {
      job = await repository.readJob({ accountId: scoped.accountId, jobId: normalizedJobId });
      assertClaimOwnership(job, scoped, failedAt);
      const fencedCaptureContext = captureContext === undefined
        ? (job.captureContext ?? null)
        : captureContext;
      const fencedClaim = claimFence === undefined ? job.claimFence : claimFence;
      if (job.claimFence != null || claimFence !== undefined) {
        assertClaimFence(job, fencedClaim, fencedCaptureContext);
      }
      const { stable, job: persistedJob } = await applyExecutorFailure({
        scoped,
        job,
        at: failedAt,
        error: { code: String(code || "") },
        captureContext: fencedCaptureContext,
        claimFence: fencedClaim,
      });
      await writeAudit({
        action: "collector.ozon.enrichment.fail",
        requestId: job.requestId,
        accountId: scoped.accountId,
        sku: job.sku,
        jobId: job.id,
        collectorSessionId: scoped.collectorSessionId,
        cacheHit: false,
        durationMs: Math.max(0, failedAt.getTime() - new Date(job.createdAt).getTime()),
        status: "FAILED",
        code: stable.code,
        missingFields: stable.missingFields,
        responseHash: responseSha256(stable),
      });
      return { id: job.id, status: persistedJob.status };
    } catch (error) {
      const failure = publicServiceError(error);
      await writeAudit({
        action: "collector.ozon.enrichment.fail",
        requestId: String(job?.requestId || ""),
        accountId: scoped.accountId,
        sku: String(job?.sku || ""),
        jobId: String(job?.id || normalizedJobId),
        collectorSessionId: scoped.collectorSessionId,
        cacheHit: false,
        durationMs: job?.createdAt
          ? Math.max(0, failedAt.getTime() - new Date(job.createdAt).getTime())
          : 0,
        status: "FAILED",
        code: failure.code,
        missingFields: failure.missingFields,
        responseHash: responseSha256(errorPayload(failure)),
      });
      throw failure;
    }
  }

  async function retryCollectItem({ accountId, collectItemId } = {}) {
    const scopedAccountId = requiredText(
      accountId,
      "COLLECTOR_AUTH_REQUIRED",
      "需要账号认证",
      401,
    );
    const normalizedCollectItemId = requiredText(
      collectItemId,
      "COLLECT_ITEM_NOT_FOUND",
      "采集箱条目不存在",
      404,
    );
    const retriedAt = instant(now());
    let response = null;
    let failure = null;
    try {
      const retried = await collectItemPort.retry({
        accountId: scopedAccountId,
        collectItemId: normalizedCollectItemId,
        now: retriedAt,
      });
      if (!retried) throw collectItemMissing();
      const job = retried.job && typeof retried.job === "object" ? retried.job : {};
      response = {
        collectItemId: normalizedCollectItemId,
        enrichment: retried.item?.enrichment && typeof retried.item.enrichment === "object"
          ? structuredClone(retried.item.enrichment)
          : null,
        job: {
          id: String(job.id || ""),
          requestId: String(job.requestId || ""),
          sku: String(job.sku || ""),
          status: String(job.status || ""),
          attemptCount: Number(job.attemptCount || 0),
          nextAttemptAt: String(job.nextAttemptAt || ""),
        },
      };
      return response;
    } catch (error) {
      failure = publicServiceError(error);
      throw failure;
    } finally {
      await writeAudit({
        action: "collector.ozon.enrichment.manual_retry",
        requestId: String(response?.job?.requestId || ""),
        accountId: scopedAccountId,
        sku: String(response?.job?.sku || ""),
        jobId: String(response?.job?.id || ""),
        collectorSessionId: "",
        actorType: "account",
        actorId: scopedAccountId,
        cacheHit: false,
        durationMs: 0,
        status: auditStatus(failure),
        code: String(failure?.code || ""),
        missingFields: [],
        responseHash: responseSha256(response || errorPayload(failure)),
      });
    }
  }

  return Object.freeze({
    enrichOne,
    enrichBatch,
    observeSellerContext,
    hasAvailableJob,
    claimNext,
    completeClaim,
    failClaim,
    retryCollectItem,
  });
}
