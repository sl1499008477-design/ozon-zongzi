import { randomUUID } from "node:crypto";
import { retryDelayMs } from "./collect-enrichment-policy.mjs";

let jsonOperationQueue = Promise.resolve();

const LINKED_JOB_DEADLINE = "9999-12-31T23:59:59.999Z";
const CAPTURE_CONTEXT_KEYS = new Set(["sellerCompanyId", "revision", "observedAt"]);
// The live service contract uses a boolean refresh flag and linked ingestion uses
// an empty placeholder. Any future metadata shape must be added here as an
// explicit, versioned contract instead of reopening arbitrary JSON persistence.
const CREATE_JOB_INPUT_KEYS = new Set([
  "id",
  "accountId",
  "requestId",
  "sku",
  "preferredSessionId",
  "refreshBundle",
  "deadlineAt",
  "createdAt",
]);
const ENQUEUE_JOB_INPUT_KEYS = new Set([
  "accountId",
  "collectItemId",
  "requestId",
  "sku",
  "refreshBundle",
  "now",
]);
const COMPLETE_LINKED_JOBS_INPUT_KEYS = new Set([
  "accountId",
  "collectItemId",
  "sku",
  "now",
]);
const COLLECTED_PUBLIC_EVIDENCE_RESULT = Object.freeze({
  status: "COMPLETE",
  source: "COLLECTED_PUBLIC_EVIDENCE",
});

function repositoryError(message, code = "ZONGZI_ENRICHMENT_PERSISTENCE_FAILED", status = 500) {
  return Object.assign(new Error(message), { code, status });
}

function requiredText(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw repositoryError(
      `Ozon enrichment ${field} is required`,
      "ZONGZI_ENRICHMENT_SCOPE_REQUIRED",
      400,
    );
  }
  return normalized;
}

function enrichmentKey(value = {}) {
  const source = requiredText(value.source, "source").toLowerCase();
  if (source !== "ozon") {
    throw repositoryError(
      "Ozon enrichment source must be ozon",
      "ZONGZI_ENRICHMENT_SOURCE_UNSUPPORTED",
      400,
    );
  }
  return {
    accountId: requiredText(value.accountId, "accountId"),
    source,
    sku: requiredText(value.sku, "sku"),
    contractVersion: requiredText(value.contractVersion, "contractVersion"),
  };
}

function requiredDate(value, field) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    throw repositoryError(
      `Ozon enrichment ${field} is invalid`,
      "ZONGZI_ENRICHMENT_DATE_INVALID",
      400,
    );
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw repositoryError(
      `Ozon enrichment ${field} is invalid`,
      "ZONGZI_ENRICHMENT_DATE_INVALID",
      400,
    );
  }
  return date;
}

function requiredPayload(value, field) {
  if (value === null || value === undefined) {
    throw repositoryError(
      `Ozon enrichment ${field} is required`,
      "ZONGZI_ENRICHMENT_PAYLOAD_REQUIRED",
      400,
    );
  }
  return value;
}

function positiveLimit(value, field) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw repositoryError(
      `Ozon enrichment ${field} is invalid`,
      "ZONGZI_ENRICHMENT_LIMIT_INVALID",
      400,
    );
  }
  return limit;
}

function optionalIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function stableError(value) {
  requiredPayload(value, "error");
  const error = {};
  const code = String(value?.code ?? "").trim();
  const status = Number(value?.status);
  if (code) error.code = code;
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  // Project already-validated service errors without revalidating persisted data.
  for (const key of ["message", "diagnostic", "missingFields", "retryable"]) {
    if (value[key] !== undefined) error[key] = copy(value[key]);
  }
  return error;
}

function captureContext(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw repositoryError(
      "Ozon enrichment capture context is invalid",
      "ZONGZI_ENRICHMENT_CAPTURE_CONTEXT_INVALID",
      400,
    );
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !CAPTURE_CONTEXT_KEYS.has(key))) {
    throw repositoryError(
      "Ozon enrichment capture context contains unsupported evidence",
      "ZONGZI_ENRICHMENT_CAPTURE_CONTEXT_INVALID",
      400,
    );
  }
  const revision = Number(value.revision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw repositoryError(
      "Ozon enrichment capture context revision is invalid",
      "ZONGZI_ENRICHMENT_CAPTURE_CONTEXT_INVALID",
      400,
    );
  }
  return {
    sellerCompanyId: requiredText(value.sellerCompanyId, "captureContext.sellerCompanyId"),
    revision,
    observedAt: requiredDate(value.observedAt, "captureContext.observedAt").toISOString(),
  };
}

function sameCaptureContext(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return left == null && right == null;
  }
  const normalizedLeft = captureContext(left);
  const normalizedRight = captureContext(right);
  return normalizedLeft.sellerCompanyId === normalizedRight.sellerCompanyId
    && normalizedLeft.revision === normalizedRight.revision
    && normalizedLeft.observedAt === normalizedRight.observedAt;
}

function sameSellerContextIdentity(left, right) {
  if (left == null || right == null) return left == null && right == null;
  const normalizedLeft = captureContext(left);
  const normalizedRight = captureContext(right);
  return normalizedLeft.sellerCompanyId === normalizedRight.sellerCompanyId
    && normalizedLeft.revision === normalizedRight.revision;
}

function compareSellerContextOrder(left, right) {
  const normalizedLeft = captureContext(left);
  const normalizedRight = captureContext(right);
  return normalizedLeft.revision - normalizedRight.revision
    || normalizedLeft.observedAt.localeCompare(normalizedRight.observedAt)
    || normalizedLeft.sellerCompanyId.localeCompare(normalizedRight.sellerCompanyId);
}

function nextSellerContextValue(currentValue, evidence) {
  const current = currentValue == null ? null : captureContext(currentValue);
  if (!current) return evidence;
  if (sameSellerContextIdentity(current, evidence)) {
    return compareSellerContextOrder(evidence, current) > 0 ? evidence : current;
  }
  if (compareSellerContextOrder(evidence, current) <= 0) throw sellerContextChangedError();
  return evidence;
}

function assertSellerContextWatermarkValue(currentValue, evidence) {
  if (currentValue != null && !sameSellerContextIdentity(currentValue, evidence)) {
    throw sellerContextChangedError();
  }
}

function sellerContextFenceKey(accountId, collectorSessionId) {
  return `collector-ozon-seller:${accountId}:${collectorSessionId}`;
}

function sellerContextChangedError() {
  return repositoryError(
    "Ozon Seller context changed after the enrichment job was claimed",
    "SELLER_CONTEXT_CHANGED",
    409,
  );
}

function persistenceContractError() {
  return repositoryError(
    "Ozon enrichment payload is outside the persistence contract",
    "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
    400,
  );
}

function assertExactInputContract(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw persistenceContractError();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw persistenceContractError();
  }
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw persistenceContractError();
  }
}

function fixedRefreshBundle(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === "boolean") return value;
  if (!Array.isArray(value) && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype === Object.prototype || prototype === null)
      && Object.keys(value).length === 0
    ) return {};
  }
  throw persistenceContractError();
}

function sameCacheKey(record, key) {
  return record?.accountId === key.accountId
    && record?.source === key.source
    && record?.sku === key.sku
    && record?.contractVersion === key.contractVersion;
}

function serializeJsonOperation(operation) {
  const flight = jsonOperationQueue.catch(() => {}).then(operation);
  jsonOperationQueue = flight;
  return flight;
}

function restoreFields(state, snapshots) {
  for (const snapshot of snapshots) {
    if (snapshot.existed) state[snapshot.fieldName] = snapshot.value;
    else delete state[snapshot.fieldName];
  }
}

function cacheFromRow(row = {}) {
  if (!row.account_id && !row.accountId) return null;
  return {
    accountId: String(row.account_id ?? row.accountId),
    source: String(row.source ?? ""),
    sku: String(row.sku ?? ""),
    contractVersion: String(row.contract_version ?? row.contractVersion ?? ""),
    status: row.status ?? null,
    result: copy(row.result_json ?? row.result ?? null),
    error: copy(row.error_json ?? row.error ?? null),
    responseHash: row.response_hash ?? row.responseHash ?? null,
    executorSessionId:
      row.last_executor_session_id ?? row.executorSessionId ?? null,
    captureContext: copy(row.capture_context_json ?? row.captureContext ?? null),
    capturedAt: optionalIso(row.captured_at ?? row.capturedAt),
    expiresAt: optionalIso(row.expires_at ?? row.expiresAt),
    leaseOwner: row.lease_owner ?? row.leaseOwner ?? null,
    leaseExpiresAt: optionalIso(row.lease_expires_at ?? row.leaseExpiresAt),
    updatedAt: optionalIso(row.updated_at ?? row.updatedAt),
  };
}

function jobFromRow(row = {}) {
  if (!row.id) return null;
  return {
    id: String(row.id),
    accountId: String(row.account_id ?? row.accountId ?? ""),
    requestId: String(row.request_id ?? row.requestId ?? ""),
    collectItemId: row.collect_item_id ?? row.collectItemId ?? null,
    sku: String(row.sku ?? ""),
    status: String(row.status ?? ""),
    preferredSessionId:
      row.preferred_session_id ?? row.preferredSessionId ?? null,
    claimedSessionId: row.claimed_session_id ?? row.claimedSessionId ?? null,
    claimExpiresAt: optionalIso(row.claim_expires_at ?? row.claimExpiresAt),
    claimFence: row.claim_fence ?? row.claimFence ?? null,
    refreshBundle: copy(row.refresh_bundle ?? row.refreshBundle ?? {}),
    attemptCount: Number(row.attempt_count ?? row.attemptCount ?? 0),
    nextAttemptAt: optionalIso(
      row.next_attempt_at ?? row.nextAttemptAt ?? row.created_at ?? row.createdAt,
    ),
    lastError: copy(row.last_error_json ?? row.lastError ?? null),
    captureContext: copy(row.capture_context_json ?? row.captureContext ?? null),
    deadlineAt: optionalIso(row.deadline_at ?? row.deadlineAt),
    result: copy(row.result_json ?? row.result ?? null),
    error: copy(row.error_json ?? row.error ?? null),
    createdAt: optionalIso(row.created_at ?? row.createdAt),
    updatedAt: optionalIso(row.updated_at ?? row.updatedAt),
    completedAt: optionalIso(row.completed_at ?? row.completedAt),
  };
}

function cacheRecord(key, existing = {}) {
  return {
    accountId: key.accountId,
    source: key.source,
    sku: key.sku,
    contractVersion: key.contractVersion,
    status: existing.status ?? null,
    result: copy(existing.result ?? null),
    error: copy(existing.error ?? null),
    responseHash: existing.responseHash ?? null,
    executorSessionId: existing.executorSessionId ?? null,
    captureContext: copy(existing.captureContext ?? null),
    capturedAt: existing.capturedAt ?? null,
    expiresAt: existing.expiresAt ?? null,
    leaseOwner: existing.leaseOwner ?? null,
    leaseExpiresAt: existing.leaseExpiresAt ?? null,
    updatedAt: existing.updatedAt ?? null,
  };
}

function newPendingJob(input) {
  const createdAt = requiredDate(input.createdAt, "createdAt").toISOString();
  return {
    id: requiredText(input.id, "job id"),
    accountId: requiredText(input.accountId, "accountId"),
    requestId: requiredText(input.requestId, "requestId"),
    collectItemId: input.collectItemId
      ? requiredText(input.collectItemId, "collectItemId")
      : null,
    sku: requiredText(input.sku, "sku"),
    status: "PENDING",
    preferredSessionId: input.preferredSessionId
      ? requiredText(input.preferredSessionId, "preferredSessionId")
      : null,
    claimedSessionId: null,
    claimExpiresAt: null,
    claimFence: null,
    refreshBundle: fixedRefreshBundle(input.refreshBundle),
    attemptCount: 0,
    nextAttemptAt: createdAt,
    lastError: null,
    captureContext: null,
    deadlineAt: requiredDate(input.deadlineAt, "deadlineAt").toISOString(),
    result: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  };
}

function jobLookupInput(input = {}) {
  return {
    accountId: requiredText(input.accountId, "accountId"),
    jobId: requiredText(input.jobId, "jobId"),
  };
}

function terminalJobError(record, collectorSessionId) {
  if (!record) {
    return repositoryError("Ozon enrichment job was not found", "ZONGZI_ENRICHMENT_JOB_NOT_FOUND", 404);
  }
  if (record.status === "SUCCESS" || record.status === "FAILED") {
    return repositoryError(
      "Ozon enrichment job is already terminal",
      "ZONGZI_ENRICHMENT_JOB_TERMINAL",
      409,
    );
  }
  if (
    record.status !== "PROCESSING"
    || record.claimedSessionId !== collectorSessionId
  ) {
    return repositoryError(
      "Collector session does not own the Ozon enrichment job",
      "ZONGZI_ENRICHMENT_JOB_OWNERSHIP",
      409,
    );
  }
  return null;
}

export function createJsonCollectorOzonEnrichmentRepository({
  state,
  persist = async () => {},
} = {}) {
  if (!state || typeof state !== "object") {
    throw new TypeError("Ozon enrichment JSON state required");
  }

  function scopedCollectorSession(accountId, sessionId, now = null) {
    const session = Array.isArray(state.collectorSessions)
      ? state.collectorSessions.find((record) => record?.id === sessionId)
      : null;
    const expiryMillis = session?.expiresAt
      ? new Date(session.expiresAt).getTime()
      : Number.NaN;
    return Boolean(session)
      && session.accountId === accountId
      && !session.revokedAt
      && Number.isFinite(expiryMillis)
      && Boolean(now)
      && expiryMillis > now.getTime();
  }

  function requireScopedCollectorSession(accountId, sessionId, now = null) {
    if (!scopedCollectorSession(accountId, sessionId, now)) {
      throw repositoryError(
        "Collector session is outside the Ozon enrichment account scope",
        "ZONGZI_ENRICHMENT_SESSION_SCOPE",
        403,
      );
    }
  }

  function collectorSession(accountId, sessionId) {
    return Array.isArray(state.collectorSessions)
      ? state.collectorSessions.find((record) =>
          record?.id === sessionId && record?.accountId === accountId)
      : null;
  }

  function assertSellerContextWatermark(session, evidence) {
    assertSellerContextWatermarkValue(session?.sellerContext ?? null, evidence);
  }

  async function commitMutation(fieldNames, mutate) {
    const snapshots = fieldNames.map((fieldName) => ({
      fieldName,
      existed: Object.hasOwn(state, fieldName),
      value: copy(state[fieldName]),
    }));
    try {
      const result = mutate();
      await persist(state);
      return copy(result);
    } catch (error) {
      restoreFields(state, snapshots);
      throw error;
    }
  }

  function cacheEntries() {
    return Array.isArray(state.collectorOzonEnrichmentCache)
      ? state.collectorOzonEnrichmentCache
      : [];
  }

  function jobEntries() {
    return Array.isArray(state.collectorOzonEnrichmentJobs)
      ? state.collectorOzonEnrichmentJobs
      : [];
  }

  async function advanceSellerContext({
    accountId,
    collectorSessionId,
    captureContext: rawCaptureContext,
    now,
  }) {
    const scopedAccountId = requiredText(accountId, "accountId");
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const evidence = captureContext(rawCaptureContext);
    const at = requiredDate(now, "now");
    if (!evidence) {
      throw repositoryError(
        "Ozon enrichment capture context is required",
        "ZONGZI_ENRICHMENT_CAPTURE_CONTEXT_INVALID",
        400,
      );
    }
    return serializeJsonOperation(async () => {
      requireScopedCollectorSession(scopedAccountId, sessionId, at);
      const session = collectorSession(scopedAccountId, sessionId);
      const next = nextSellerContextValue(session.sellerContext, evidence);
      if (sameCaptureContext(session.sellerContext ?? null, next)) return copy(next);
      return commitMutation(["collectorSessions"], () => {
        session.sellerContext = copy(next);
        session.sellerContextUpdatedAt = at.toISOString();
        return next;
      });
    });
  }

  function legacyLinkedDuplicateIds({
    accountId,
    collectItemId = "",
    sku = "",
  }) {
    const scopedCollectItemId = String(collectItemId || "");
    const scopedSku = String(sku || "");
    const activeLinked = jobEntries()
      .filter((record) =>
        String(record?.accountId || "") === accountId
        && (!scopedCollectItemId || String(record?.collectItemId || "") === scopedCollectItemId)
        && (!scopedSku || String(record?.sku || "") === scopedSku)
        && record?.collectItemId
        && ["PENDING", "PROCESSING"].includes(record?.status))
      .sort((left, right) => {
        const leftCreated = optionalIso(left?.createdAt) || "9999-12-31T23:59:59.999Z";
        const rightCreated = optionalIso(right?.createdAt) || "9999-12-31T23:59:59.999Z";
        return leftCreated.localeCompare(rightCreated)
          || String(left?.id || "").localeCompare(String(right?.id || ""));
      });
    const winners = new Set();
    const duplicateIds = new Set();
    for (const record of activeLinked) {
      const stableKey = JSON.stringify([
        String(record.accountId || ""),
        String(record.collectItemId || ""),
        String(record.sku || ""),
      ]);
      if (winners.has(stableKey)) duplicateIds.add(String(record.id));
      else winners.add(stableKey);
    }
    return duplicateIds;
  }

  async function normalizeLegacyLinkedJobDuplicates({
    accountId,
    collectItemId = "",
    sku = "",
    now,
  } = {}) {
    const scopedAccountId = requiredText(accountId, "accountId");
    const scopedCollectItemId = String(collectItemId || "");
    const scopedSku = String(sku || "");
    const at = requiredDate(now, "now");
    const duplicateIds = legacyLinkedDuplicateIds({
      accountId: scopedAccountId,
      collectItemId: scopedCollectItemId,
      sku: scopedSku,
    });
    if (!duplicateIds.size) return false;
    const superseded = Object.freeze({
      code: "ZONGZI_ENRICHMENT_DUPLICATE_SUPERSEDED",
      status: 409,
    });
    return commitMutation(["collectorOzonEnrichmentJobs"], () => {
      state.collectorOzonEnrichmentJobs = jobEntries();
      for (const record of state.collectorOzonEnrichmentJobs) {
        if (String(record?.accountId || "") !== scopedAccountId) continue;
        if (scopedCollectItemId && String(record?.collectItemId || "") !== scopedCollectItemId) continue;
        if (scopedSku && String(record?.sku || "") !== scopedSku) continue;
        if (!duplicateIds.has(String(record?.id || ""))) continue;
        record.status = "FAILED";
        record.result = null;
        record.error = copy(superseded);
        record.lastError = copy(superseded);
        record.claimedSessionId = null;
        record.claimExpiresAt = null;
        record.claimFence = null;
        record.completedAt = at.toISOString();
        record.updatedAt = at.toISOString();
      }
      return true;
    });
  }

  async function readCache({ key: rawKey, now, includeExpired = false }) {
    const key = enrichmentKey(rawKey);
    const at = requiredDate(now, "now");
    const found = cacheEntries().find((record) => sameCacheKey(record, key));
    if (!found?.status) return null;
    if (!includeExpired && (!found.expiresAt || new Date(found.expiresAt).getTime() <= at.getTime())) {
      return null;
    }
    return copy(found);
  }

  async function tryAcquireCacheLease({
    key: rawKey,
    leaseOwner,
    leaseExpiresAt,
    now,
    maxActiveLeases = 4,
  }) {
    const key = enrichmentKey(rawKey);
    const owner = requiredText(leaseOwner, "leaseOwner");
    const expires = requiredDate(leaseExpiresAt, "leaseExpiresAt");
    const at = requiredDate(now, "now");
    const capacity = positiveLimit(maxActiveLeases, "maxActiveLeases");
    return serializeJsonOperation(async () => {
      const existing = cacheEntries().find((record) => sameCacheKey(record, key));
      const heldByOther = existing?.leaseOwner
        && existing.leaseOwner !== owner
        && existing.leaseExpiresAt
        && new Date(existing.leaseExpiresAt).getTime() > at.getTime();
      if (heldByOther) return null;
      const activeOwners = new Set(cacheEntries()
        .filter((record) => record.accountId === key.accountId
          && record.leaseOwner
          && record.leaseExpiresAt
          && new Date(record.leaseExpiresAt).getTime() > at.getTime())
        .map((record) => record.leaseOwner));
      if (!activeOwners.has(owner) && activeOwners.size >= capacity) {
        throw repositoryError(
          "Ozon enrichment account has reached its active lease capacity",
          "ZONGZI_ENRICH_BUSY",
          429,
        );
      }
      return commitMutation(["collectorOzonEnrichmentCache"], () => {
        state.collectorOzonEnrichmentCache = cacheEntries();
        let mutable = state.collectorOzonEnrichmentCache.find((record) => sameCacheKey(record, key));
        if (!mutable) {
          mutable = cacheRecord(key);
          state.collectorOzonEnrichmentCache.push(mutable);
        }
        mutable.leaseOwner = owner;
        mutable.leaseExpiresAt = expires.toISOString();
        mutable.updatedAt = at.toISOString();
        return mutable;
      });
    });
  }

  async function releaseCacheLease({ key: rawKey, leaseOwner }) {
    const key = enrichmentKey(rawKey);
    const owner = requiredText(leaseOwner, "leaseOwner");
    return serializeJsonOperation(async () => {
      const existing = cacheEntries().find((record) => sameCacheKey(record, key));
      if (!existing || existing.leaseOwner !== owner) return false;
      return commitMutation(["collectorOzonEnrichmentCache"], () => {
        const mutable = state.collectorOzonEnrichmentCache.find((record) => sameCacheKey(record, key));
        mutable.leaseOwner = null;
        mutable.leaseExpiresAt = null;
        return true;
      });
    });
  }

  async function writeCache({
    key: rawKey,
    status,
    result,
    error,
    responseHash,
    executorSessionId,
    capturedAt,
    expiresAt,
  }) {
    const key = enrichmentKey(rawKey);
    const captured = requiredDate(capturedAt, "capturedAt");
    const expires = requiredDate(expiresAt, "expiresAt");
    if (status === "COMPLETE") requiredPayload(result, "result");
    else requiredPayload(error, "error");
    const executor = status === "COMPLETE"
      ? requiredText(executorSessionId, "executorSessionId")
      : null;
    return serializeJsonOperation(() => {
      if (executor) {
        requireScopedCollectorSession(key.accountId, executor, captured);
      }
      return commitMutation(["collectorOzonEnrichmentCache"], () => {
        state.collectorOzonEnrichmentCache = cacheEntries();
        let mutable = state.collectorOzonEnrichmentCache
          .find((record) => sameCacheKey(record, key));
        if (!mutable) {
          mutable = cacheRecord(key);
          state.collectorOzonEnrichmentCache.push(mutable);
        }
        mutable.status = status;
        mutable.result = copy(result ?? null);
        mutable.error = copy(error ?? null);
        mutable.responseHash = requiredText(responseHash, "responseHash");
        mutable.executorSessionId = executor;
        mutable.capturedAt = captured.toISOString();
        mutable.expiresAt = expires.toISOString();
        mutable.leaseOwner = null;
        mutable.leaseExpiresAt = null;
        mutable.updatedAt = captured.toISOString();
        return mutable;
      });
    });
  }

  async function writeCompleteCache(input) {
    return writeCache({ ...input, status: "COMPLETE", error: null });
  }

  async function writeNegativeCache(input) {
    return writeCache({
      ...input,
      status: "ERROR",
      result: null,
      executorSessionId: null,
    });
  }

  async function enqueueForCollect(input) {
    const request = copy(input);
    assertExactInputContract(request, ENQUEUE_JOB_INPUT_KEYS);
    const at = requiredDate(request.now, "now");
    const refreshBundle = fixedRefreshBundle(request.refreshBundle);
    const stableKey = {
      accountId: requiredText(request.accountId, "accountId"),
      collectItemId: requiredText(request.collectItemId, "collectItemId"),
      requestId: requiredText(request.requestId, "requestId"),
      sku: requiredText(request.sku, "sku"),
    };
    return serializeJsonOperation(async () => {
      await normalizeLegacyLinkedJobDuplicates({
        accountId: stableKey.accountId,
        collectItemId: stableKey.collectItemId,
        sku: stableKey.sku,
        now: at,
      });
      const existing = jobEntries().find((record) =>
        record.accountId === stableKey.accountId
        && record.collectItemId === stableKey.collectItemId
        && record.sku === stableKey.sku
        && ["PENDING", "PROCESSING"].includes(record.status));
      if (existing) {
        return jobFromRow(existing);
      }
      const scopedCollectItem = (Array.isArray(state.caches?.collectBox)
        ? state.caches.collectBox
        : []).find((item) =>
        String(item?.id ?? "") === stableKey.collectItemId
        && String(item?.accountId ?? "") === stableKey.accountId);
      if (!scopedCollectItem) {
        throw repositoryError(
          "Ozon enrichment collect item was not found in the account scope",
          "ZONGZI_ENRICHMENT_COLLECT_ITEM_NOT_FOUND",
          404,
        );
      }
      const replay = jobEntries().find((record) =>
        record.accountId === stableKey.accountId
        && record.requestId === stableKey.requestId
        && record.sku === stableKey.sku);
      if (replay) {
        if (replay.collectItemId !== stableKey.collectItemId) {
          throw repositoryError(
            "Ozon enrichment replay points to a different collect item",
            "ZONGZI_ENRICHMENT_COLLECT_ITEM_CONFLICT",
            409,
          );
        }
        return jobFromRow(replay);
      }
      const candidate = newPendingJob({
        id: randomUUID(),
        accountId: stableKey.accountId,
        collectItemId: stableKey.collectItemId,
        requestId: stableKey.requestId,
        sku: stableKey.sku,
        refreshBundle,
        preferredSessionId: null,
        deadlineAt: LINKED_JOB_DEADLINE,
        createdAt: at,
      });
      return commitMutation(["collectorOzonEnrichmentJobs"], () => {
        state.collectorOzonEnrichmentJobs = jobEntries();
        state.collectorOzonEnrichmentJobs.push(candidate);
        return candidate;
      });
    });
  }

  async function completeLinkedJobsFromCollectEvidence(input) {
    const request = copy(input);
    assertExactInputContract(request, COMPLETE_LINKED_JOBS_INPUT_KEYS);
    const accountId = requiredText(request.accountId, "accountId");
    const collectItemId = requiredText(request.collectItemId, "collectItemId");
    const sku = requiredText(request.sku, "sku");
    const at = requiredDate(request.now, "now");
    return serializeJsonOperation(() => {
      const active = jobEntries()
        .filter((record) =>
          record.accountId === accountId
          && record.collectItemId === collectItemId
          && record.sku === sku
          && ["PENDING", "PROCESSING"].includes(record.status))
        .sort((left, right) => {
          const leftCreated = optionalIso(left?.createdAt) || "9999-12-31T23:59:59.999Z";
          const rightCreated = optionalIso(right?.createdAt) || "9999-12-31T23:59:59.999Z";
          return leftCreated.localeCompare(rightCreated)
            || String(left?.id || "").localeCompare(String(right?.id || ""));
        });
      if (!active.length) return [];
      const winnerId = String(active[0].id);
      const activeIds = new Set(active.map((record) => String(record.id)));
      return commitMutation(["collectorOzonEnrichmentJobs"], () => {
        state.collectorOzonEnrichmentJobs = jobEntries();
        const completed = [];
        for (const record of state.collectorOzonEnrichmentJobs) {
          if (String(record?.accountId || "") !== accountId) continue;
          if (String(record?.collectItemId || "") !== collectItemId) continue;
          if (String(record?.sku || "") !== sku) continue;
          if (!activeIds.has(String(record?.id || ""))) continue;
          if (String(record.id) !== winnerId) {
            const superseded = {
              code: "ZONGZI_ENRICHMENT_DUPLICATE_SUPERSEDED",
              status: 409,
            };
            record.status = "FAILED";
            record.result = null;
            record.error = copy(superseded);
            record.lastError = copy(superseded);
            record.preferredSessionId = null;
            record.claimedSessionId = null;
            record.claimExpiresAt = null;
            record.claimFence = null;
            record.captureContext = null;
            record.completedAt = at.toISOString();
            record.updatedAt = at.toISOString();
            continue;
          }
          record.status = "SUCCESS";
          record.preferredSessionId = null;
          record.claimedSessionId = null;
          record.claimExpiresAt = null;
          record.claimFence = null;
          record.lastError = null;
          record.captureContext = null;
          record.result = copy(COLLECTED_PUBLIC_EVIDENCE_RESULT);
          record.error = null;
          record.completedAt = at.toISOString();
          record.updatedAt = at.toISOString();
          completed.push(record);
        }
        return completed;
      });
    });
  }

  async function createOrGetJob(input) {
    const request = copy(input);
    assertExactInputContract(request, CREATE_JOB_INPUT_KEYS);
    const stableKey = {
      id: requiredText(request.id, "job id"),
      accountId: requiredText(request.accountId, "accountId"),
      requestId: requiredText(request.requestId, "requestId"),
      sku: requiredText(request.sku, "sku"),
    };
    return serializeJsonOperation(async () => {
      const existing = jobEntries().find((record) =>
        record.accountId === stableKey.accountId
        && record.requestId === stableKey.requestId
        && record.sku === stableKey.sku);
      // HTTP wait windows never revoke an existing executor or reset its history.
      if (existing) return copy(existing);
      if (jobEntries().some((record) => record.id === stableKey.id)) {
        throw repositoryError(
          "Ozon enrichment job id belongs to another stable key",
          "ZONGZI_ENRICHMENT_JOB_ID_CONFLICT",
          409,
        );
      }
      const candidate = newPendingJob(request);
      if (
        candidate.preferredSessionId
        && !scopedCollectorSession(
          candidate.accountId,
          candidate.preferredSessionId,
          requiredDate(candidate.createdAt, "createdAt"),
        )
      ) {
        candidate.preferredSessionId = null;
      }
      return commitMutation(["collectorOzonEnrichmentJobs"], () => {
        state.collectorOzonEnrichmentJobs = jobEntries();
        state.collectorOzonEnrichmentJobs.push(candidate);
        return candidate;
      });
    });
  }

  async function claimNextJob({
    jobId,
    accountId,
    collectorSessionId,
    now,
    claimExpiresAt,
    claimFence,
    captureContext: rawCaptureContext = null,
  }) {
    const scopedAccountId = requiredText(accountId, "accountId");
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const at = requiredDate(now, "now");
    const claimExpiry = requiredDate(claimExpiresAt, "claimExpiresAt");
    const fence = claimFence == null
      ? randomUUID()
      : requiredText(claimFence, "claimFence");
    const evidence = captureContext(rawCaptureContext);
    return serializeJsonOperation(async () => {
      requireScopedCollectorSession(scopedAccountId, sessionId, at);
      const session = collectorSession(scopedAccountId, sessionId);
      if (jobId !== undefined) {
        const record = jobEntries().find(item => item.accountId === scopedAccountId && item.id === jobId);
        const invalid = terminalJobError(record, sessionId);
        if (invalid) throw invalid;
        assertSellerContextWatermark(session, evidence);
        if (record.claimFence !== fence || !sameCaptureContext(record.captureContext, evidence)) throw sellerContextChangedError();
        const otherActive = jobEntries().filter(item => item.accountId === scopedAccountId && item.id !== jobId
          && item.status === "PROCESSING" && new Date(item.claimExpiresAt).getTime() > at.getTime()).length;
        if (otherActive >= 4 && new Date(record.claimExpiresAt).getTime() <= at.getTime()) {
          throw repositoryError("Ozon enrichment executor capacity reached", "ZONGZI_ENRICH_BUSY", 429);
        }
        return commitMutation(["collectorOzonEnrichmentJobs"], () => {
          record.claimExpiresAt = new Date(Math.max(new Date(record.claimExpiresAt).getTime(), claimExpiry.getTime())).toISOString();
          record.updatedAt = at.toISOString();
          return record;
        });
      }
      if (evidence) {
        const next = nextSellerContextValue(session.sellerContext, evidence);
        if (!sameCaptureContext(session.sellerContext ?? null, next)) {
          await commitMutation(["collectorSessions"], () => {
            session.sellerContext = copy(next);
            session.sellerContextUpdatedAt = at.toISOString();
            return next;
          });
        }
      }
      await normalizeLegacyLinkedJobDuplicates({ accountId: scopedAccountId, now: at });

      const active = jobEntries().filter((record) =>
        record.accountId === scopedAccountId
        && record.status === "PROCESSING"
        && record.claimExpiresAt
        && new Date(record.claimExpiresAt).getTime() > at.getTime()).length;
      if (active >= 4) return null;
      const candidate = jobEntries()
        .filter((record) =>
          record.accountId === scopedAccountId
          && (record.status === "PENDING" || (
            record.status === "PROCESSING"
            && record.claimExpiresAt
            && new Date(record.claimExpiresAt).getTime() <= at.getTime()
          ))
          && (!record.nextAttemptAt
            || new Date(record.nextAttemptAt).getTime() <= at.getTime())
          && (
            !record.preferredSessionId
            || record.preferredSessionId === sessionId
            || new Date(record.createdAt).getTime() + 1000 <= at.getTime()
          ))
        .sort((left, right) => {
          const linked = Number(Boolean(right.collectItemId))
            - Number(Boolean(left.collectItemId));
          const attempts = Number(Number(left.attemptCount || 0) > 0)
            - Number(Number(right.attemptCount || 0) > 0);
          const preference = Number(right.preferredSessionId === sessionId)
            - Number(left.preferredSessionId === sessionId);
          return linked
            || attempts
            || preference
            || String(left.nextAttemptAt ?? left.createdAt)
              .localeCompare(String(right.nextAttemptAt ?? right.createdAt))
            || left.createdAt.localeCompare(right.createdAt)
            || left.id.localeCompare(right.id);
        })[0];
      if (!candidate) return null;
      return commitMutation(["collectorOzonEnrichmentJobs"], () => {
        candidate.status = "PROCESSING";
        candidate.claimedSessionId = sessionId;
        candidate.claimExpiresAt = claimExpiry.toISOString();
        candidate.claimFence = fence;
        candidate.captureContext = copy(evidence);
        candidate.updatedAt = at.toISOString();
        return candidate;
      });
    });
  }

  async function hasClaimableJob({ accountId, collectorSessionId, now }) {
    const scopedAccountId = requiredText(accountId, "accountId");
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const at = requiredDate(now, "now");
    return serializeJsonOperation(async () => {
      if (!scopedCollectorSession(scopedAccountId, sessionId, at)) return false;
      const duplicateIds = legacyLinkedDuplicateIds({ accountId: scopedAccountId });
      const claimableRecords = jobEntries().filter((record) =>
        !duplicateIds.has(String(record?.id || "")));
      const active = claimableRecords.filter((record) =>
        record.accountId === scopedAccountId
        && record.status === "PROCESSING"
        && record.claimExpiresAt
        && new Date(record.claimExpiresAt).getTime() > at.getTime()).length;
      if (active >= 4) return false;
      return claimableRecords.some((record) =>
        record.accountId === scopedAccountId
        && (record.status === "PENDING" || (
          record.status === "PROCESSING"
          && record.claimExpiresAt
          && new Date(record.claimExpiresAt).getTime() <= at.getTime()
        ))
        && (!record.nextAttemptAt || new Date(record.nextAttemptAt).getTime() <= at.getTime())
        && (
          !record.preferredSessionId
          || record.preferredSessionId === sessionId
          || new Date(record.createdAt).getTime() + 1000 <= at.getTime()
        ));
    });
  }

  async function deferClaim({
    accountId,
    collectorSessionId,
    jobId,
    error,
    captureContext: rawCaptureContext,
    claimFence,
    now,
  }) {
    const lookup = jobLookupInput({ accountId, jobId });
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const at = requiredDate(now, "now");
    const savedError = stableError(error);
    const evidence = captureContext(rawCaptureContext);
    const fence = claimFence == null ? null : requiredText(claimFence, "claimFence");
    return serializeJsonOperation(async () => {
      requireScopedCollectorSession(lookup.accountId, sessionId, at);
      assertSellerContextWatermark(
        collectorSession(lookup.accountId, sessionId),
        evidence,
      );
      const record = jobEntries().find((item) =>
        item.accountId === lookup.accountId && item.id === lookup.jobId);
      const invalid = terminalJobError(record, sessionId);
      if (invalid) throw invalid;
      if (
        fence !== null
        && (record.claimFence !== fence || !sameCaptureContext(record.captureContext, evidence))
      ) {
        throw sellerContextChangedError();
      }
      return commitMutation(["collectorOzonEnrichmentJobs"], () => {
        const attemptCount = Number(record.attemptCount || 0) + 1;
        record.status = "PENDING";
        record.attemptCount = attemptCount;
        record.nextAttemptAt = new Date(at.getTime() + retryDelayMs(attemptCount)).toISOString();
        record.lastError = copy(savedError);
        record.claimedSessionId = null;
        record.claimExpiresAt = null;
        record.claimFence = null;
        record.captureContext = null;
        record.updatedAt = at.toISOString();
        return record;
      });
    });
  }

  async function readJob(input) {
    const lookup = jobLookupInput(input);
    const found = jobEntries().find((record) =>
      record.accountId === lookup.accountId && record.id === lookup.jobId);
    return found ? copy(found) : null;
  }

  async function expireUnlinkedJob() {
    // Legacy runtime port: HTTP expiry no longer changes business state.
    return null;
  }

  async function finishJobAndCache({
    accountId,
    collectorSessionId,
    jobId,
    key: rawKey,
    result,
    error,
    responseHash,
    capturedAt,
    expiresAt,
    captureContext: rawCaptureContext,
    claimFence,
    now,
    status,
  }) {
    const lookup = jobLookupInput({ accountId, jobId });
    const key = enrichmentKey(rawKey);
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const at = requiredDate(now, "now");
    const captured = requiredDate(capturedAt, "capturedAt");
    const expires = requiredDate(expiresAt, "expiresAt");
    const payload = status === "SUCCESS" ? result : error;
    requiredPayload(payload, status === "SUCCESS" ? "result" : "error");
    const response = requiredText(responseHash, "responseHash");
    const evidence = captureContext(rawCaptureContext);
    const fence = claimFence == null ? null : requiredText(claimFence, "claimFence");
    if (key.accountId !== lookup.accountId) {
      throw repositoryError(
        "Ozon enrichment cache and job account scopes differ",
        "ZONGZI_ENRICHMENT_SESSION_SCOPE",
        403,
      );
    }
    return serializeJsonOperation(async () => {
      requireScopedCollectorSession(lookup.accountId, sessionId, at);
      assertSellerContextWatermark(
        collectorSession(lookup.accountId, sessionId),
        evidence,
      );
      const record = jobEntries().find((item) =>
        item.accountId === lookup.accountId && item.id === lookup.jobId);
      const invalid = terminalJobError(record, sessionId);
      if (invalid) throw invalid;
      if (
        fence !== null
        && (record.claimFence !== fence || !sameCaptureContext(record.captureContext, evidence))
      ) {
        throw sellerContextChangedError();
      }
      if (record.sku !== key.sku) {
        throw repositoryError(
          "Ozon enrichment cache and job SKU differ",
          "ZONGZI_ENRICHMENT_JOB_OWNERSHIP",
          409,
        );
      }
      return commitMutation(
        ["collectorOzonEnrichmentJobs", "collectorOzonEnrichmentCache"],
        () => {
          record.status = status;
          if (status === "FAILED") record.attemptCount = Number(record.attemptCount || 0) + 1;
          record.result = copy(result ?? null);
          record.error = copy(error ?? null);
          record.completedAt = at.toISOString();
          record.updatedAt = at.toISOString();
          record.captureContext = copy(evidence);

          state.collectorOzonEnrichmentCache = cacheEntries();
          let cache = state.collectorOzonEnrichmentCache
            .find((item) => sameCacheKey(item, key));
          if (!cache) {
            cache = cacheRecord(key);
            state.collectorOzonEnrichmentCache.push(cache);
          }
          cache.status = status === "SUCCESS" ? "COMPLETE" : "ERROR";
          cache.result = copy(result ?? null);
          cache.error = copy(error ?? null);
          cache.responseHash = response;
          cache.executorSessionId = status === "SUCCESS" ? sessionId : null;
          cache.captureContext = copy(evidence);
          cache.capturedAt = captured.toISOString();
          cache.expiresAt = expires.toISOString();
          cache.leaseOwner = null;
          cache.leaseExpiresAt = null;
          cache.updatedAt = captured.toISOString();
          return record;
        },
      );
    });
  }

  async function completeJobAndCache(input) {
    return finishJobAndCache({ ...input, status: "SUCCESS", error: null });
  }

  async function failJobAndCache(input) {
    return finishJobAndCache({ ...input, status: "FAILED", result: null });
  }

  return Object.freeze({
    readCache,
    tryAcquireCacheLease,
    releaseCacheLease,
    writeCompleteCache,
    writeNegativeCache,
    enqueueForCollect,
    completeLinkedJobsFromCollectEvidence,
    createOrGetJob,
    advanceSellerContext,
    claimNextJob,
    hasClaimableJob,
    deferClaim,
    completeJobAndCache,
    failJobAndCache,
    readJob,
    expireUnlinkedJob,
  });
}

export function createPostgresCollectorOzonEnrichmentRepository({
  pool,
  transactionOwner = "repository",
} = {}) {
  if (!pool?.query) throw new TypeError("Ozon enrichment PostgreSQL pool required");
  if (!["repository", "caller"].includes(transactionOwner)) {
    throw new TypeError("Ozon enrichment PostgreSQL transaction owner invalid");
  }

  async function query(sql, params) {
    try {
      return await pool.query(sql, params);
    } catch (error) {
      if (error?.code?.startsWith("ZONGZI_ENRICHMENT_")) throw error;
      throw repositoryError("Ozon enrichment PostgreSQL operation failed");
    }
  }

  async function advanceSellerContext({
    accountId,
    collectorSessionId,
    captureContext: rawCaptureContext,
    now,
  }) {
    const scopedAccountId = requiredText(accountId, "accountId");
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const evidence = captureContext(rawCaptureContext);
    const at = requiredDate(now, "now");
    if (!evidence) {
      throw repositoryError(
        "Ozon enrichment capture context is required",
        "ZONGZI_ENRICHMENT_CAPTURE_CONTEXT_INVALID",
        400,
      );
    }
    if (typeof pool.connect !== "function") {
      throw new TypeError("Ozon enrichment PostgreSQL pool.connect required");
    }
    const client = await pool.connect();
    let began = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      began = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [sellerContextFenceKey(scopedAccountId, sessionId)],
      );
      const selected = await client.query(
        `SELECT id,seller_context_json
           FROM collector_sessions
          WHERE account_id=$1 AND id=$2
            AND revoked_at IS NULL AND expires_at>$3
          FOR UPDATE`,
        [scopedAccountId, sessionId, at],
      );
      const session = selected.rows[0];
      if (!session) {
        throw repositoryError(
          "Collector session is outside the Ozon enrichment account scope",
          "ZONGZI_ENRICHMENT_SESSION_SCOPE",
          403,
        );
      }
      const current = session.seller_context_json ?? session.sellerContext ?? null;
      const next = nextSellerContextValue(current, evidence);
      if (!sameCaptureContext(current, next)) {
        await client.query(
          `UPDATE collector_sessions
              SET seller_context_json=$3::jsonb,seller_context_updated_at=$4
            WHERE account_id=$1 AND id=$2
            RETURNING seller_context_json`,
          [scopedAccountId, sessionId, JSON.stringify(next), at],
        );
      }
      await client.query("COMMIT");
      began = false;
      return copy(next);
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the authoritative Seller-context failure.
        }
      }
      if (
        error?.code === "SELLER_CONTEXT_CHANGED"
        || error?.code?.startsWith("ZONGZI_ENRICHMENT_")
      ) throw error;
      throw repositoryError("Ozon enrichment PostgreSQL Seller context update failed");
    } finally {
      client.release();
    }
  }

  async function readCache({ key: rawKey, now, includeExpired = false }) {
    const key = enrichmentKey(rawKey);
    const at = requiredDate(now, "now");
    const result = await query(
      `SELECT *
         FROM collector_ozon_enrichment_cache
        WHERE account_id=$1 AND source=$2 AND sku=$3 AND contract_version=$4
          AND status IS NOT NULL
          AND ($6::boolean OR expires_at>$5)`,
      [key.accountId, key.source, key.sku, key.contractVersion, at, includeExpired],
    );
    return result.rows[0] ? cacheFromRow(result.rows[0]) : null;
  }

  async function tryAcquireCacheLease({
    key: rawKey,
    leaseOwner,
    leaseExpiresAt,
    now,
    maxActiveLeases = 4,
  }) {
    const key = enrichmentKey(rawKey);
    const owner = requiredText(leaseOwner, "leaseOwner");
    const expires = requiredDate(leaseExpiresAt, "leaseExpiresAt");
    const at = requiredDate(now, "now");
    const capacity = positiveLimit(maxActiveLeases, "maxActiveLeases");
    const result = await query(
      `WITH account_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
       ), lease_state AS MATERIALIZED (
         SELECT COUNT(DISTINCT lease_owner) FILTER (
                  WHERE lease_owner IS NOT NULL AND lease_expires_at>$7
                ) AS active_lease_count,
                COALESCE(BOOL_OR(
                  source=$2 AND sku=$3 AND contract_version=$4
                  AND lease_owner IS NOT NULL AND lease_owner<>$5 AND lease_expires_at>$7
                ), FALSE) AS key_held_by_other,
                COALESCE(BOOL_OR(
                  source=$2 AND sku=$3 AND contract_version=$4
                  AND lease_owner=$5 AND lease_expires_at>$7
                ), FALSE) AS key_held_by_owner,
                COALESCE(BOOL_OR(
                  lease_owner=$5 AND lease_expires_at>$7
                ), FALSE) AS owner_has_live_lease
           FROM account_lock
           LEFT JOIN collector_ozon_enrichment_cache ON account_id=$1
       ), acquired AS (
         INSERT INTO collector_ozon_enrichment_cache (
           account_id, source, sku, contract_version, lease_owner, lease_expires_at, updated_at
         )
         SELECT $1,$2,$3,$4,$5,$6,$7
           FROM lease_state
          WHERE key_held_by_other OR key_held_by_owner
             OR owner_has_live_lease OR active_lease_count<$8
         ON CONFLICT (account_id, source, sku, contract_version) DO UPDATE
         SET lease_owner = EXCLUDED.lease_owner,
             lease_expires_at = EXCLUDED.lease_expires_at,
             updated_at = EXCLUDED.updated_at
         WHERE collector_ozon_enrichment_cache.lease_expires_at <= EXCLUDED.updated_at
            OR collector_ozon_enrichment_cache.lease_owner = EXCLUDED.lease_owner
         RETURNING account_id, source, sku, contract_version, lease_owner, lease_expires_at
       )
       SELECT TO_JSONB(acquired) AS lease, FALSE AS busy FROM acquired
       UNION ALL
       SELECT NULL::jsonb AS lease, TRUE AS busy
         FROM lease_state
        WHERE NOT EXISTS (SELECT 1 FROM acquired)
          AND NOT key_held_by_other AND NOT key_held_by_owner AND NOT owner_has_live_lease
          AND active_lease_count>=$8`,
      [key.accountId, key.source, key.sku, key.contractVersion, owner, expires, at, capacity],
    );
    if (result.rows[0]?.busy === true) {
      throw repositoryError(
        "Ozon enrichment account has reached its active lease capacity",
        "ZONGZI_ENRICH_BUSY",
        429,
      );
    }
    const acquired = result.rows[0]?.lease || result.rows[0];
    return acquired ? cacheFromRow(acquired) : null;
  }

  async function releaseCacheLease({ key: rawKey, leaseOwner }) {
    const key = enrichmentKey(rawKey);
    const owner = requiredText(leaseOwner, "leaseOwner");
    const result = await query(
      `UPDATE collector_ozon_enrichment_cache
          SET lease_owner=NULL, lease_expires_at='-infinity', updated_at=NOW()
        WHERE account_id=$1 AND source=$2 AND sku=$3 AND contract_version=$4
          AND lease_owner=$5`,
      [key.accountId, key.source, key.sku, key.contractVersion, owner],
    );
    return Number(result.rowCount || 0) > 0;
  }

  async function writeCompleteCache({
    key: rawKey,
    result: enrichmentResult,
    responseHash,
    executorSessionId,
    capturedAt,
    expiresAt,
  }) {
    const key = enrichmentKey(rawKey);
    const captured = requiredDate(capturedAt, "capturedAt");
    const expires = requiredDate(expiresAt, "expiresAt");
    requiredPayload(enrichmentResult, "result");
    const response = requiredText(responseHash, "responseHash");
    const executor = requiredText(executorSessionId, "executorSessionId");
    const saved = await query(
      `INSERT INTO collector_ozon_enrichment_cache (
         account_id, source, sku, contract_version, status, result_json, error_json,
         response_hash, last_executor_session_id, captured_at, expires_at,
         lease_owner, lease_expires_at, updated_at
       )
       SELECT $1,$2,$3,$4,'COMPLETE',$5::jsonb,NULL,$6,$7,$8,$9,NULL,'-infinity',$8
         FROM collector_sessions AS executor
        WHERE executor.account_id=$1 AND executor.id=$7
          AND executor.revoked_at IS NULL AND executor.expires_at>$8
       ON CONFLICT (account_id, source, sku, contract_version) DO UPDATE SET
         status='COMPLETE', result_json=EXCLUDED.result_json, error_json=NULL,
         response_hash=EXCLUDED.response_hash,
         last_executor_session_id=EXCLUDED.last_executor_session_id,
         captured_at=EXCLUDED.captured_at, expires_at=EXCLUDED.expires_at,
         lease_owner=NULL, lease_expires_at='-infinity', updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [
        key.accountId,
        key.source,
        key.sku,
        key.contractVersion,
        JSON.stringify(enrichmentResult ?? null),
        response,
        executor,
        captured,
        expires,
      ],
    );
    if (!saved.rows[0]) {
      throw repositoryError(
        "Collector session is outside the Ozon enrichment account scope",
        "ZONGZI_ENRICHMENT_SESSION_SCOPE",
        403,
      );
    }
    return cacheFromRow(saved.rows[0]);
  }

  async function writeNegativeCache({
    key: rawKey,
    error,
    responseHash,
    capturedAt,
    expiresAt,
  }) {
    const key = enrichmentKey(rawKey);
    const captured = requiredDate(capturedAt, "capturedAt");
    const expires = requiredDate(expiresAt, "expiresAt");
    requiredPayload(error, "error");
    const response = requiredText(responseHash, "responseHash");
    const saved = await query(
      `INSERT INTO collector_ozon_enrichment_cache (
         account_id, source, sku, contract_version, status, result_json, error_json,
         response_hash, last_executor_session_id, captured_at, expires_at,
         lease_owner, lease_expires_at, updated_at
       ) VALUES ($1,$2,$3,$4,'ERROR',NULL,$5::jsonb,$6,NULL,$7,$8,NULL,'-infinity',$7)
       ON CONFLICT (account_id, source, sku, contract_version) DO UPDATE SET
         status='ERROR', result_json=NULL, error_json=EXCLUDED.error_json,
         response_hash=EXCLUDED.response_hash, last_executor_session_id=NULL,
         captured_at=EXCLUDED.captured_at, expires_at=EXCLUDED.expires_at,
         lease_owner=NULL, lease_expires_at='-infinity', updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [
        key.accountId,
        key.source,
        key.sku,
        key.contractVersion,
        JSON.stringify(error ?? null),
        response,
        captured,
        expires,
      ],
    );
    return cacheFromRow(saved.rows[0]);
  }

  async function enqueueForCollect(input) {
    const request = copy(input);
    assertExactInputContract(request, ENQUEUE_JOB_INPUT_KEYS);
    const at = requiredDate(request.now, "now");
    const refreshBundle = fixedRefreshBundle(request.refreshBundle);
    const accountId = requiredText(request.accountId, "accountId");
    const collectItemId = requiredText(request.collectItemId, "collectItemId");
    const requestId = requiredText(request.requestId, "requestId");
    const sku = requiredText(request.sku, "sku");
    const deadline = requiredDate(LINKED_JOB_DEADLINE, "deadlineAt");
    const ownsTransaction = transactionOwner === "repository"
      && typeof pool.connect === "function";
    const client = ownsTransaction ? await pool.connect() : pool;
    let began = false;
    const execute = async (sql, params) => {
      try {
        return await client.query(sql, params);
      } catch (error) {
        if (error?.code?.startsWith("ZONGZI_ENRICHMENT_")) throw error;
        throw repositoryError("Ozon enrichment PostgreSQL operation failed");
      }
    };
    try {
      if (ownsTransaction) {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        began = true;
      }
      await execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`collector-ozon-linked:${accountId}:${collectItemId}:${sku}`],
      );
      const linked = await execute(
        `SELECT * FROM collector_ozon_enrichment_jobs
          WHERE account_id=$1 AND collect_item_id=$2 AND sku=$3
            AND status IN ('PENDING','PROCESSING')
          ORDER BY created_at ASC,id ASC LIMIT 1
          FOR UPDATE`,
        [accountId, collectItemId, sku],
      );
      let output = linked.rows[0] ? jobFromRow(linked.rows[0]) : null;
      if (!output) {
        const inserted = await execute(
          `INSERT INTO collector_ozon_enrichment_jobs (
             id, account_id, collect_item_id, request_id, sku, status, refresh_bundle,
             preferred_session_id, deadline_at, attempt_count, next_attempt_at,
             created_at, updated_at
           )
           SELECT $1,$2,collect_item.id,$4,$5,'PENDING',$6::jsonb,
                  NULL,$7,0,$8,$8,$8
             FROM collect_items AS collect_item
            WHERE collect_item.id=$3 AND collect_item.account_id=$2
           ON CONFLICT (account_id, request_id, sku) DO NOTHING
           RETURNING *`,
          [
            randomUUID(),
            accountId,
            collectItemId,
            requestId,
            sku,
            JSON.stringify(refreshBundle),
            deadline,
            at,
          ],
        );
        output = inserted.rows[0] ? jobFromRow(inserted.rows[0]) : null;
      }
      if (!output) {
        const replay = await execute(
          `SELECT * FROM collector_ozon_enrichment_jobs
            WHERE account_id=$1 AND request_id=$2 AND sku=$3`,
          [accountId, requestId, sku],
        );
        if (replay.rows[0]) {
          const existing = jobFromRow(replay.rows[0]);
          if (existing.collectItemId !== collectItemId) {
            throw repositoryError(
              "Ozon enrichment replay points to a different collect item",
              "ZONGZI_ENRICHMENT_COLLECT_ITEM_CONFLICT",
              409,
            );
          }
          output = existing;
        }
      }
      if (!output) {
        throw repositoryError(
          "Ozon enrichment collect item was not found in the account scope",
          "ZONGZI_ENRICHMENT_COLLECT_ITEM_NOT_FOUND",
          404,
        );
      }
      if (ownsTransaction) {
        await client.query("COMMIT");
        began = false;
      }
      return output;
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original linked-enqueue failure.
        }
      }
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  async function completeLinkedJobsFromCollectEvidence(input) {
    const request = copy(input);
    assertExactInputContract(request, COMPLETE_LINKED_JOBS_INPUT_KEYS);
    const accountId = requiredText(request.accountId, "accountId");
    const collectItemId = requiredText(request.collectItemId, "collectItemId");
    const sku = requiredText(request.sku, "sku");
    const at = requiredDate(request.now, "now");
    const result = await query(
      `UPDATE collector_ozon_enrichment_jobs
          SET status='SUCCESS', preferred_session_id=NULL,
              claimed_session_id=NULL, claim_expires_at=NULL, claim_fence=NULL,
              last_error_json=NULL, capture_context_json=NULL,
              result_json=$5::jsonb, error_json=NULL,
              completed_at=$4, updated_at=$4
        WHERE account_id=$1 AND collect_item_id=$2 AND sku=$3
          AND status IN ('PENDING','PROCESSING')
        RETURNING *`,
      [
        accountId,
        collectItemId,
        sku,
        at,
        JSON.stringify(COLLECTED_PUBLIC_EVIDENCE_RESULT),
      ],
    );
    return result.rows.map(jobFromRow);
  }

  async function createOrGetJob(input) {
    const request = copy(input);
    assertExactInputContract(request, CREATE_JOB_INPUT_KEYS);
    const record = newPendingJob(request);
    const recordParams = [
      record.id,
      record.accountId,
      record.requestId,
      record.sku,
      JSON.stringify(record.refreshBundle),
      record.preferredSessionId,
      requiredDate(record.deadlineAt, "deadlineAt"),
      requiredDate(record.createdAt, "createdAt"),
    ];
    const result = await query(
      `INSERT INTO collector_ozon_enrichment_jobs (
         id, account_id, request_id, sku, status, refresh_bundle,
         preferred_session_id, attempt_count, next_attempt_at, last_error_json,
         capture_context_json, deadline_at, created_at, updated_at
       )
       SELECT $1,$2,$3,$4,'PENDING',$5::jsonb,
              CASE WHEN preferred.id IS NULL THEN NULL ELSE $6 END,0,$8,NULL,NULL,$7,$8,$8
         FROM accounts AS account
         LEFT JOIN collector_sessions AS preferred
           ON preferred.id=$6 AND preferred.account_id=$2
          AND preferred.revoked_at IS NULL AND preferred.expires_at>$8
        WHERE account.id=$2
       ON CONFLICT DO NOTHING
       RETURNING *`,
      recordParams,
    );
    if (result.rows[0]) return jobFromRow(result.rows[0]);
    const stable = await query(
      `SELECT * FROM collector_ozon_enrichment_jobs
        WHERE account_id=$1 AND request_id=$2 AND sku=$3`,
      [record.accountId, record.requestId, record.sku],
    );
    if (stable.rows[0]) return jobFromRow(stable.rows[0]);
    const idConflict = await query(
      "SELECT id FROM collector_ozon_enrichment_jobs WHERE id=$1",
      [record.id],
    );
    if (idConflict.rows[0]) {
      throw repositoryError(
        "Ozon enrichment job id belongs to another stable key",
        "ZONGZI_ENRICHMENT_JOB_ID_CONFLICT",
        409,
      );
    }
    throw repositoryError(
      "Preferred Collector session is outside the Ozon enrichment account scope",
      "ZONGZI_ENRICHMENT_SESSION_SCOPE",
      403,
    );
  }

  async function claimNextJob({
    jobId,
    accountId,
    collectorSessionId,
    now,
    claimExpiresAt,
    claimFence,
    captureContext: rawCaptureContext = null,
  }) {
    const scopedAccountId = requiredText(accountId, "accountId");
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const at = requiredDate(now, "now");
    const claimExpiry = requiredDate(claimExpiresAt, "claimExpiresAt");
    const fence = claimFence == null
      ? randomUUID()
      : requiredText(claimFence, "claimFence");
    const evidence = captureContext(rawCaptureContext);
    if (!pool.connect) throw new TypeError("Ozon enrichment PostgreSQL pool.connect required");
    const client = await pool.connect();
    let began = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      began = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [scopedAccountId],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [sellerContextFenceKey(scopedAccountId, sessionId)],
      );
      const activeSession = await client.query(
        `SELECT id,seller_context_json FROM collector_sessions
          WHERE account_id=$1 AND id=$2
            AND revoked_at IS NULL AND expires_at>$3`,
        [scopedAccountId, sessionId, at],
      );
      if (!activeSession.rows[0]) {
        throw repositoryError(
          "Collector session is outside the Ozon enrichment account scope",
          "ZONGZI_ENRICHMENT_SESSION_SCOPE",
          403,
        );
      }
      if (jobId !== undefined) {
        assertSellerContextWatermarkValue(activeSession.rows[0].seller_context_json ?? null, evidence);
        const found = await client.query(
          "SELECT * FROM collector_ozon_enrichment_jobs WHERE account_id=$1 AND id=$2 FOR UPDATE",
          [scopedAccountId, jobId],
        );
        const record = found.rows[0] ? jobFromRow(found.rows[0]) : null;
        const invalid = terminalJobError(record, sessionId);
        if (invalid) throw invalid;
        if (record.claimFence !== fence || !sameCaptureContext(record.captureContext, evidence)) throw sellerContextChangedError();
        const active = await client.query(
          `SELECT COUNT(*) FROM collector_ozon_enrichment_jobs
            WHERE account_id=$1 AND id<>$3 AND status='PROCESSING' AND claim_expires_at>$2`,
          [scopedAccountId, at, jobId],
        );
        if (Number(active.rows[0]?.count || 0) >= 4 && new Date(record.claimExpiresAt).getTime() <= at.getTime()) {
          throw repositoryError("Ozon enrichment executor capacity reached", "ZONGZI_ENRICH_BUSY", 429);
        }
        const renewed = await client.query(
          `UPDATE collector_ozon_enrichment_jobs
              SET claim_expires_at=GREATEST(claim_expires_at,$4), updated_at=$5
            WHERE account_id=$1 AND id=$2 AND claimed_session_id=$3
              AND status='PROCESSING' AND claim_fence=$6
              AND capture_context_json IS NOT DISTINCT FROM $7::jsonb
            RETURNING *`,
          [scopedAccountId, jobId, sessionId, claimExpiry, at, fence, evidence ? JSON.stringify(evidence) : null],
        );
        await client.query("COMMIT");
        began = false;
        return jobFromRow(renewed.rows[0]);
      }
      if (evidence) {
        const current = activeSession.rows[0].seller_context_json ?? null;
        const next = nextSellerContextValue(current, evidence);
        if (!sameCaptureContext(current, next)) {
          await client.query(
            `UPDATE collector_sessions
                SET seller_context_json=$3::jsonb,seller_context_updated_at=$4
              WHERE account_id=$1 AND id=$2`,
            [scopedAccountId, sessionId, JSON.stringify(next), at],
          );
        }
      }

      const active = await client.query(
        `SELECT COUNT(*)
           FROM collector_ozon_enrichment_jobs
          WHERE account_id=$1 AND status='PROCESSING' AND claim_expires_at>$2`,
        [scopedAccountId, at],
      );
      if (Number(active.rows[0]?.count || 0) >= 4) {
        await client.query("COMMIT");
        began = false;
        return null;
      }
      const claimed = await client.query(
        `WITH candidate AS (
           SELECT job.id
             FROM collector_ozon_enrichment_jobs AS job
             JOIN collector_sessions AS session
               ON session.id=$2 AND session.account_id=$1
              AND session.revoked_at IS NULL AND session.expires_at>$3
            WHERE job.account_id=$1
              AND (
                job.status='PENDING'
                OR (job.status='PROCESSING' AND job.claim_expires_at<=$3)
              )
              AND job.next_attempt_at<=$3
              AND (
                job.preferred_session_id IS NULL
                OR job.preferred_session_id=$2
                OR job.created_at + INTERVAL '1 second'<=$3
              )
            ORDER BY CASE WHEN job.collect_item_id IS NOT NULL THEN 0 ELSE 1 END,
                     CASE WHEN job.attempt_count=0 THEN 0 ELSE 1 END,
                     CASE WHEN job.preferred_session_id=$2 THEN 0 ELSE 1 END,
                     job.next_attempt_at,
                     job.created_at,
                     job.id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE collector_ozon_enrichment_jobs AS job
            SET status='PROCESSING', claimed_session_id=$2,
                claim_expires_at=$4,
                claim_fence=$5, capture_context_json=$6::jsonb, updated_at=$3
           FROM candidate
          WHERE job.id=candidate.id AND job.account_id=$1
         RETURNING job.*`,
        [
          scopedAccountId,
          sessionId,
          at,
          claimExpiry,
          fence,
          evidence ? JSON.stringify(evidence) : null,
        ],
      );
      await client.query("COMMIT");
      began = false;
      return claimed.rows[0] ? jobFromRow(claimed.rows[0]) : null;
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original transaction error.
        }
      }
      if (
        error?.code === "SELLER_CONTEXT_CHANGED"
        || error?.code === "ZONGZI_ENRICH_BUSY"
        || error?.code?.startsWith("ZONGZI_ENRICHMENT_")
      ) throw error;
      throw repositoryError("Ozon enrichment PostgreSQL claim failed");
    } finally {
      client.release();
    }
  }

  async function hasClaimableJob({ accountId, collectorSessionId, now }) {
    const scopedAccountId = requiredText(accountId, "accountId");
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const at = requiredDate(now, "now");
    const result = await query(
      `SELECT EXISTS (
         SELECT 1
           FROM collector_sessions AS session
          WHERE session.account_id=$1 AND session.id=$2
            AND session.revoked_at IS NULL AND session.expires_at>$3
            AND (
              SELECT COUNT(*)
                FROM collector_ozon_enrichment_jobs
               WHERE account_id=$1
                 AND status='PROCESSING' AND claim_expires_at>$3
            ) < 4
            AND EXISTS (
              SELECT 1
                FROM collector_ozon_enrichment_jobs AS job
               WHERE job.account_id=$1
                 AND (
                   job.status='PENDING'
                   OR (job.status='PROCESSING' AND job.claim_expires_at<=$3)
                 )
                 AND job.next_attempt_at<=$3
                 AND (
                   job.preferred_session_id IS NULL
                   OR job.preferred_session_id=$2
                   OR job.created_at + INTERVAL '1 second'<=$3
                 )
            )
       ) AS available`,
      [scopedAccountId, sessionId, at],
    );
    return Boolean(result.rows[0]?.available);
  }

  async function deferClaim({
    accountId,
    collectorSessionId,
    jobId,
    error,
    captureContext: rawCaptureContext,
    claimFence,
    now,
  }) {
    const lookup = jobLookupInput({ accountId, jobId });
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const at = requiredDate(now, "now");
    const savedError = stableError(error);
    const evidence = captureContext(rawCaptureContext);
    const fence = claimFence == null ? null : requiredText(claimFence, "claimFence");
    const delays = [1, 2, 3, 4, 5].map(retryDelayMs);
    const ownsTransaction = transactionOwner === "repository";
    if (ownsTransaction && typeof pool.connect !== "function") {
      throw new TypeError("Ozon enrichment PostgreSQL pool.connect required");
    }
    const client = ownsTransaction ? await pool.connect() : pool;
    let began = false;
    try {
      if (ownsTransaction) {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        began = true;
      }
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [sellerContextFenceKey(lookup.accountId, sessionId)],
      );
      const updated = await client.query(
        `UPDATE collector_ozon_enrichment_jobs
            SET status='PENDING', attempt_count=attempt_count+1,
                next_attempt_at=$4 + CASE
                  WHEN attempt_count=0 THEN $6::double precision
                  WHEN attempt_count=1 THEN $7::double precision
                  WHEN attempt_count=2 THEN $8::double precision
                  WHEN attempt_count=3 THEN $9::double precision
                  ELSE $10::double precision
                END * INTERVAL '1 millisecond',
                last_error_json=$5::jsonb,
                claimed_session_id=NULL, claim_expires_at=NULL,
                claim_fence=NULL, capture_context_json=NULL, updated_at=$4
          WHERE account_id=$1 AND claimed_session_id=$2 AND id=$3
            AND status='PROCESSING'
            AND ($11::text IS NULL OR (
              claim_fence=$11
              AND capture_context_json IS NOT DISTINCT FROM $12::jsonb
            ))
            AND EXISTS (SELECT 1 FROM collector_sessions AS session
                         WHERE session.id=$2 AND session.account_id=$1
                           AND session.revoked_at IS NULL AND session.expires_at>$4
                           AND (
                             session.seller_context_json IS NULL
                             OR (
                               $12::jsonb IS NOT NULL
                               AND session.seller_context_json->>'sellerCompanyId'=$12::jsonb->>'sellerCompanyId'
                               AND session.seller_context_json->>'revision'=$12::jsonb->>'revision'
                             )
                           ))
         RETURNING *`,
        [
          lookup.accountId,
          sessionId,
          lookup.jobId,
          at,
          JSON.stringify(savedError),
          ...delays,
          fence,
          evidence ? JSON.stringify(evidence) : null,
        ],
      );
      if (!updated.rows[0]) {
        const activeSession = await client.query(
          `SELECT id,seller_context_json FROM collector_sessions
            WHERE account_id=$1 AND id=$2
              AND revoked_at IS NULL AND expires_at>$3`,
          [lookup.accountId, sessionId, at],
        );
        if (!activeSession.rows[0]) {
          throw repositoryError(
            "Collector session is outside the Ozon enrichment account scope",
            "ZONGZI_ENRICHMENT_SESSION_SCOPE",
            403,
          );
        }
        assertSellerContextWatermarkValue(
          activeSession.rows[0].seller_context_json ?? null,
          evidence,
        );
        const found = await client.query(
          `SELECT * FROM collector_ozon_enrichment_jobs
            WHERE account_id=$1 AND id=$2`,
          [lookup.accountId, lookup.jobId],
        );
        const foundJob = found.rows[0] ? jobFromRow(found.rows[0]) : null;
        const terminal = terminalJobError(foundJob, sessionId);
        if (terminal) throw terminal;
        if (
          fence !== null
          && (foundJob.claimFence !== fence || !sameCaptureContext(foundJob.captureContext, evidence))
        ) throw sellerContextChangedError();
        throw repositoryError(
          "Collector session no longer owns a deferrable Ozon enrichment job",
          "ZONGZI_ENRICHMENT_JOB_OWNERSHIP",
          409,
        );
      }
      if (ownsTransaction) {
        await client.query("COMMIT");
        began = false;
      }
      return jobFromRow(updated.rows[0]);
    } catch (errorValue) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the authoritative Seller-context failure.
        }
      }
      if (
        errorValue?.code === "SELLER_CONTEXT_CHANGED"
        || errorValue?.code?.startsWith("ZONGZI_ENRICHMENT_")
      ) throw errorValue;
      throw repositoryError("Ozon enrichment PostgreSQL defer transaction failed");
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  async function readJob(input) {
    const lookup = jobLookupInput(input);
    const result = await query(
      `SELECT * FROM collector_ozon_enrichment_jobs
        WHERE account_id=$1 AND id=$2`,
      [lookup.accountId, lookup.jobId],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : null;
  }

  async function expireUnlinkedJob() {
    // Legacy runtime port: HTTP expiry no longer changes business state.
    return null;
  }

  async function finishJobAndCache({
    accountId,
    collectorSessionId,
    jobId,
    key: rawKey,
    result,
    error,
    responseHash,
    capturedAt,
    expiresAt,
    captureContext: rawCaptureContext,
    claimFence,
    now,
    status,
  }) {
    const lookup = jobLookupInput({ accountId, jobId });
    const key = enrichmentKey(rawKey);
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const at = requiredDate(now, "now");
    const captured = requiredDate(capturedAt, "capturedAt");
    const expires = requiredDate(expiresAt, "expiresAt");
    const payload = status === "SUCCESS" ? result : error;
    requiredPayload(payload, status === "SUCCESS" ? "result" : "error");
    const response = requiredText(responseHash, "responseHash");
    const evidence = captureContext(rawCaptureContext);
    const fence = claimFence == null ? null : requiredText(claimFence, "claimFence");
    if (key.accountId !== lookup.accountId) {
      throw repositoryError(
        "Ozon enrichment cache and job account scopes differ",
        "ZONGZI_ENRICHMENT_SESSION_SCOPE",
        403,
      );
    }
    const ownsTransaction = transactionOwner === "repository";
    if (ownsTransaction && typeof pool.connect !== "function") {
      throw new TypeError("Ozon enrichment PostgreSQL pool.connect required");
    }
    const client = ownsTransaction ? await pool.connect() : pool;
    let began = false;
    try {
      if (ownsTransaction) {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        began = true;
      }
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [sellerContextFenceKey(lookup.accountId, sessionId)],
      );
      const resultColumn = status === "SUCCESS" ? "result_json" : "error_json";
      const otherColumn = status === "SUCCESS" ? "error_json" : "result_json";
      const updated = await client.query(
        `UPDATE collector_ozon_enrichment_jobs
            SET status='${status}', ${status === "FAILED" ? "attempt_count=attempt_count+1," : ""}
                ${resultColumn}=$5::jsonb, ${otherColumn}=NULL,
                capture_context_json=$7::jsonb, completed_at=$4, updated_at=$4
          WHERE account_id=$1 AND claimed_session_id=$2 AND id=$3 AND sku=$6
            AND status='PROCESSING'
            AND ($8::text IS NULL OR (
              claim_fence=$8
              AND capture_context_json IS NOT DISTINCT FROM $7::jsonb
            ))
            AND EXISTS (SELECT 1 FROM collector_sessions AS session
                         WHERE session.id=$2 AND session.account_id=$1
                           AND session.revoked_at IS NULL AND session.expires_at>$4
                           AND (
                             session.seller_context_json IS NULL
                             OR (
                               $7::jsonb IS NOT NULL
                               AND session.seller_context_json->>'sellerCompanyId'=$7::jsonb->>'sellerCompanyId'
                               AND session.seller_context_json->>'revision'=$7::jsonb->>'revision'
                             )
                           ))
         RETURNING *`,
        [
          lookup.accountId,
          sessionId,
          lookup.jobId,
          at,
          JSON.stringify(payload ?? null),
          key.sku,
          evidence ? JSON.stringify(evidence) : null,
          fence,
        ],
      );
      if (!updated.rows[0]) {
        const activeSession = await client.query(
          `SELECT id,seller_context_json FROM collector_sessions
            WHERE account_id=$1 AND id=$2
              AND revoked_at IS NULL AND expires_at>$3`,
          [lookup.accountId, sessionId, at],
        );
        if (!activeSession.rows[0]) {
          throw repositoryError(
            "Collector session is outside the Ozon enrichment account scope",
            "ZONGZI_ENRICHMENT_SESSION_SCOPE",
            403,
          );
        }
        assertSellerContextWatermarkValue(
          activeSession.rows[0].seller_context_json ?? null,
          evidence,
        );
        const found = await client.query(
          `SELECT * FROM collector_ozon_enrichment_jobs
            WHERE account_id=$1 AND id=$2`,
          [lookup.accountId, lookup.jobId],
        );
        const foundJob = found.rows[0] ? jobFromRow(found.rows[0]) : null;
        const terminal = terminalJobError(
          foundJob,
          sessionId,
        );
        if (terminal) throw terminal;
        if (
          fence !== null
          && (foundJob.claimFence !== fence || !sameCaptureContext(foundJob.captureContext, evidence))
        ) {
          throw sellerContextChangedError();
        }
        throw repositoryError(
          "Collector session no longer owns an updatable Ozon enrichment job",
          "ZONGZI_ENRICHMENT_JOB_OWNERSHIP",
          409,
        );
      }

      const cacheStatus = status === "SUCCESS" ? "COMPLETE" : "ERROR";
      await client.query(
        `INSERT INTO collector_ozon_enrichment_cache (
           account_id, source, sku, contract_version, status, result_json, error_json,
           capture_context_json, response_hash, last_executor_session_id, captured_at, expires_at,
           lease_owner, lease_expires_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$12::jsonb,$8,$9,$10,$11,NULL,'-infinity',$10)
         ON CONFLICT (account_id, source, sku, contract_version) DO UPDATE SET
           status=EXCLUDED.status, result_json=EXCLUDED.result_json,
           error_json=EXCLUDED.error_json, capture_context_json=EXCLUDED.capture_context_json,
           response_hash=EXCLUDED.response_hash,
           last_executor_session_id=EXCLUDED.last_executor_session_id,
           captured_at=EXCLUDED.captured_at, expires_at=EXCLUDED.expires_at,
           lease_owner=NULL, lease_expires_at='-infinity', updated_at=EXCLUDED.updated_at`,
        [
          key.accountId,
          key.source,
          key.sku,
          key.contractVersion,
          cacheStatus,
          status === "SUCCESS" ? JSON.stringify(result ?? null) : null,
          status === "FAILED" ? JSON.stringify(error ?? null) : null,
          response,
          status === "SUCCESS" ? sessionId : null,
          captured,
          expires,
          evidence ? JSON.stringify(evidence) : null,
        ],
      );
      if (ownsTransaction) {
        await client.query("COMMIT");
        began = false;
      }
      return jobFromRow(updated.rows[0]);
    } catch (errorValue) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original terminal transition failure.
        }
      }
      if (
        errorValue?.code === "SELLER_CONTEXT_CHANGED"
        || errorValue?.code?.startsWith("ZONGZI_ENRICHMENT_")
      ) throw errorValue;
      throw repositoryError("Ozon enrichment PostgreSQL terminal transaction failed");
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  async function completeJobAndCache(input) {
    return finishJobAndCache({ ...input, status: "SUCCESS", error: null });
  }

  async function failJobAndCache(input) {
    return finishJobAndCache({ ...input, status: "FAILED", result: null });
  }

  return Object.freeze({
    readCache,
    tryAcquireCacheLease,
    releaseCacheLease,
    writeCompleteCache,
    writeNegativeCache,
    enqueueForCollect,
    completeLinkedJobsFromCollectEvidence,
    createOrGetJob,
    advanceSellerContext,
    claimNextJob,
    hasClaimableJob,
    deferClaim,
    completeJobAndCache,
    failJobAndCache,
    readJob,
    expireUnlinkedJob,
  });
}
