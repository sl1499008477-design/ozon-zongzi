import { randomUUID } from "node:crypto";

const STATUS = new Set([
  "WAITING_ENRICHMENT",
  "WAITING_STORE",
  "QUEUED",
  "MATCHING",
  "MATCHED",
  "NEEDS_REVIEW",
  "RETRYABLE_ERROR",
  "INVALIDATED",
]);
const ENQUEUE_STATUS = new Set(["WAITING_ENRICHMENT", "WAITING_STORE", "QUEUED", "INVALIDATED"]);
const CLAIMABLE_STATUS = new Set(["QUEUED", "RETRYABLE_ERROR", "INVALIDATED"]);
const jsonQueues = new WeakMap();

function repositoryError(message, code = "COLLECT_CATEGORY_RESOLUTION_PERSISTENCE_FAILED", status = 500) {
  return Object.assign(new Error(message), { code, status });
}

function collectItemScopeError() {
  return repositoryError(
    "Collect item was not found in the category resolution account scope",
    "COLLECT_CATEGORY_RESOLUTION_SCOPE",
    404,
  );
}

function credentialStoreScopeError() {
  return repositoryError(
    "Credential store is outside the category resolution account scope",
    "COLLECT_CATEGORY_RESOLUTION_CREDENTIAL_STORE_SCOPE",
    403,
  );
}

function executionMismatchError() {
  return repositoryError(
    "Category resolution completion does not match the claimed execution",
    "COLLECT_CATEGORY_RESOLUTION_EXECUTION_MISMATCH",
    409,
  );
}

function requiredText(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw repositoryError(
      `Collect category resolution ${field} is required`,
      "COLLECT_CATEGORY_RESOLUTION_INPUT_INVALID",
      400,
    );
  }
  return normalized;
}

function optionalText(value, maxLength = 500) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function requiredDate(value, field) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    throw repositoryError(
      `Collect category resolution ${field} is invalid`,
      "COLLECT_CATEGORY_RESOLUTION_INPUT_INVALID",
      400,
    );
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw repositoryError(
      `Collect category resolution ${field} is invalid`,
      "COLLECT_CATEGORY_RESOLUTION_INPUT_INVALID",
      400,
    );
  }
  return date;
}

function positiveId(value, field, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === "")) return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw repositoryError(
      `Collect category resolution ${field} is invalid`,
      "COLLECT_CATEGORY_RESOLUTION_INPUT_INVALID",
      400,
    );
  }
  return normalized;
}

function idFromRow(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function displayPath(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw repositoryError(
      "Collect category resolution displayPath is invalid",
      "COLLECT_CATEGORY_RESOLUTION_INPUT_INVALID",
      400,
    );
  }
  return copy(value);
}

function statusValue(value, allowed = STATUS) {
  const normalized = requiredText(value, "status");
  if (!allowed.has(normalized)) {
    throw repositoryError(
      "Collect category resolution status is invalid",
      "COLLECT_CATEGORY_RESOLUTION_INPUT_INVALID",
      400,
    );
  }
  return normalized;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function recordFromRow(row = {}) {
  if (!row?.id) return null;
  return {
    id: String(row.id),
    accountId: String(row.account_id ?? row.accountId ?? ""),
    collectItemId: String(row.collect_item_id ?? row.collectItemId ?? ""),
    taxonomyScope: String(row.taxonomy_scope ?? row.taxonomyScope ?? ""),
    sourceTypeId: idFromRow(row.source_type_id ?? row.sourceTypeId),
    targetDescriptionCategoryId:
      idFromRow(row.target_description_category_id ?? row.targetDescriptionCategoryId),
    targetTypeId: idFromRow(row.target_type_id ?? row.targetTypeId),
    method: row.method ?? null,
    status: String(row.status ?? ""),
    taxonomyFingerprint: row.taxonomy_fingerprint ?? row.taxonomyFingerprint ?? null,
    credentialStoreId: row.credential_store_id ?? row.credentialStoreId ?? null,
    displayPath: copy(row.display_path_json ?? row.displayPath ?? {}),
    failureCode: row.failure_code ?? row.failureCode ?? null,
    failureDetailSafe: row.failure_detail_safe ?? row.failureDetailSafe ?? null,
    attemptCount: Number(row.attempt_count ?? row.attemptCount ?? 0),
    nextAttemptAt: isoOrNull(row.next_attempt_at ?? row.nextAttemptAt),
    leaseToken: row.lease_token ?? row.leaseToken ?? null,
    leaseExpiresAt: isoOrNull(row.lease_expires_at ?? row.leaseExpiresAt),
    matchedAt: isoOrNull(row.matched_at ?? row.matchedAt),
    validatedAt: isoOrNull(row.validated_at ?? row.validatedAt),
    createdAt: isoOrNull(row.created_at ?? row.createdAt),
    updatedAt: isoOrNull(row.updated_at ?? row.updatedAt),
  };
}

function enqueueInput(input = {}) {
  const now = requiredDate(input.now, "now");
  return {
    accountId: requiredText(input.accountId, "accountId"),
    collectItemId: requiredText(input.collectItemId, "collectItemId"),
    taxonomyScope: requiredText(input.taxonomyScope, "taxonomyScope"),
    sourceTypeId: positiveId(input.sourceTypeId, "sourceTypeId", { optional: true }),
    status: statusValue(input.status ?? "QUEUED", ENQUEUE_STATUS),
    taxonomyFingerprint: optionalText(input.taxonomyFingerprint, 240),
    credentialStoreId: optionalText(input.credentialStoreId, 240),
    nextAttemptAt: requiredDate(input.nextAttemptAt ?? now, "nextAttemptAt"),
    now,
  };
}

function scopeInput(input = {}) {
  return {
    accountId: requiredText(input.accountId, "accountId"),
    collectItemId: requiredText(input.collectItemId, "collectItemId"),
    taxonomyScope: requiredText(input.taxonomyScope, "taxonomyScope"),
  };
}

function fenceInput(input = {}, { nullableToken = false } = {}) {
  return {
    accountId: requiredText(input.accountId, "accountId"),
    id: requiredText(input.id, "id"),
    leaseToken: nullableToken && input.leaseToken == null
      ? null
      : requiredText(input.leaseToken, "leaseToken"),
  };
}

function sameStableKey(record, key) {
  return record?.accountId === key.accountId
    && record?.collectItemId === key.collectItemId
    && record?.taxonomyScope === key.taxonomyScope;
}

function sameExecutionKey(record, request) {
  return Number(record?.sourceTypeId || 0) === Number(request.sourceTypeId || 0)
    && (record?.taxonomyFingerprint ?? null) === request.taxonomyFingerprint;
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function serializeJson(state, operation) {
  const previous = jsonQueues.get(state) || Promise.resolve();
  const flight = previous.catch(() => {}).then(operation);
  jsonQueues.set(state, flight);
  return flight.finally(() => {
    if (jsonQueues.get(state) === flight) jsonQueues.delete(state);
  });
}

export function createJsonCollectCategoryResolutionRepository({
  state,
  persist = async () => {},
} = {}) {
  if (!state || typeof state !== "object") {
    throw new TypeError("Collect category resolution JSON state required");
  }

  function records() {
    return Array.isArray(state.collectCategoryResolutions) ? state.collectCategoryResolutions : [];
  }

  function assertCollectItemScope(accountId, collectItemId) {
    const found = Array.isArray(state.caches?.collectBox)
      && state.caches.collectBox.some((item) =>
        String(item?.id ?? "") === collectItemId
        && String(item?.accountId ?? "") === accountId);
    if (!found) {
      throw collectItemScopeError();
    }
  }

  function assertStoreScope(accountId, credentialStoreId) {
    if (!credentialStoreId) return;
    const found = Array.isArray(state.stores) && state.stores.some((store) =>
      String(store?.id ?? "") === credentialStoreId
      && String(store?.ownerAccountId ?? "") === accountId);
    if (!found) {
      throw credentialStoreScopeError();
    }
  }

  async function mutate(operation) {
    return serializeJson(state, async () => {
      const hadRecords = Object.hasOwn(state, "collectCategoryResolutions");
      const previousRecords = state.collectCategoryResolutions;
      const normalizedBefore = Array.isArray(previousRecords) ? previousRecords : [];
      const working = copy(normalizedBefore);
      const result = operation(working);
      if (sameJsonValue(working, normalizedBefore)) return copy(result);

      state.collectCategoryResolutions = working;
      try {
        await persist(state);
      } catch (error) {
        if (state.collectCategoryResolutions === working) {
          if (hadRecords) state.collectCategoryResolutions = previousRecords;
          else delete state.collectCategoryResolutions;
        }
        throw error;
      }

      if (state.collectCategoryResolutions !== working) return null;
      return copy(result);
    });
  }

  async function enqueue(input) {
    const request = enqueueInput(input);
    return mutate((entries) => {
      assertCollectItemScope(request.accountId, request.collectItemId);
      assertStoreScope(request.accountId, request.credentialStoreId);
      const existing = entries.find((record) => sameStableKey(record, request));
      if (existing && (
        (existing.status === "MATCHED" && existing.method === "MANUAL")
        || (["MATCHING", "MATCHED", "NEEDS_REVIEW", "RETRYABLE_ERROR"].includes(existing.status)
          && sameExecutionKey(existing, request))
        || (existing.status === request.status && sameExecutionKey(existing, request))
      )) return recordFromRow(existing);
      const nowIso = request.now.toISOString();
      if (existing) {
        Object.assign(existing, {
          sourceTypeId: request.sourceTypeId,
          targetDescriptionCategoryId: null,
          targetTypeId: null,
          method: null,
          status: request.status,
          taxonomyFingerprint: request.taxonomyFingerprint,
          credentialStoreId: request.credentialStoreId,
          displayPath: {},
          failureCode: null,
          failureDetailSafe: null,
          attemptCount: 0,
          nextAttemptAt: request.nextAttemptAt.toISOString(),
          leaseToken: null,
          leaseExpiresAt: null,
          matchedAt: null,
          validatedAt: null,
          updatedAt: nowIso,
        });
        return recordFromRow(existing);
      }
      const created = {
        id: randomUUID(),
        accountId: request.accountId,
        collectItemId: request.collectItemId,
        taxonomyScope: request.taxonomyScope,
        sourceTypeId: request.sourceTypeId,
        targetDescriptionCategoryId: null,
        targetTypeId: null,
        method: null,
        status: request.status,
        taxonomyFingerprint: request.taxonomyFingerprint,
        credentialStoreId: request.credentialStoreId,
        displayPath: {},
        failureCode: null,
        failureDetailSafe: null,
        attemptCount: 0,
        nextAttemptAt: request.nextAttemptAt.toISOString(),
        leaseToken: null,
        leaseExpiresAt: null,
        matchedAt: null,
        validatedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      entries.push(created);
      return recordFromRow(created);
    });
  }

  async function readForItem(input) {
    const scope = scopeInput(input);
    return serializeJson(state, () =>
      recordFromRow(records().find((record) => sameStableKey(record, scope)) || null));
  }

  async function claimNext(input = {}) {
    const accountId = requiredText(input.accountId, "accountId");
    const taxonomyScope = input.taxonomyScope == null
      ? null
      : requiredText(input.taxonomyScope, "taxonomyScope");
    const leaseToken = requiredText(input.leaseToken, "leaseToken");
    const now = requiredDate(input.now, "now");
    const leaseExpiresAt = requiredDate(input.leaseExpiresAt, "leaseExpiresAt");
    if (leaseExpiresAt.getTime() <= now.getTime()) {
      throw repositoryError(
        "Collect category resolution lease must expire after now",
        "COLLECT_CATEGORY_RESOLUTION_INPUT_INVALID",
        400,
      );
    }
    return mutate((entries) => {
      const candidate = entries
        .filter((record) => record.accountId === accountId
          && (!taxonomyScope || record.taxonomyScope === taxonomyScope)
          && new Date(record.nextAttemptAt).getTime() <= now.getTime()
          && (CLAIMABLE_STATUS.has(record.status)
            || (record.status === "MATCHING"
              && new Date(record.leaseExpiresAt || 0).getTime() <= now.getTime())))
        .sort((left, right) => String(left.nextAttemptAt).localeCompare(String(right.nextAttemptAt))
          || String(left.createdAt).localeCompare(String(right.createdAt))
          || String(left.id).localeCompare(String(right.id)))[0];
      if (!candidate) return null;
      if (candidate.status === "INVALIDATED") {
        candidate.targetDescriptionCategoryId = null;
        candidate.targetTypeId = null;
        candidate.method = null;
        candidate.displayPath = {};
        candidate.matchedAt = null;
        candidate.validatedAt = null;
      }
      candidate.status = "MATCHING";
      candidate.leaseToken = leaseToken;
      candidate.leaseExpiresAt = leaseExpiresAt.toISOString();
      candidate.attemptCount = Number(candidate.attemptCount || 0) + 1;
      candidate.updatedAt = now.toISOString();
      return recordFromRow(candidate);
    });
  }

  function fencedMutation(input, update, options) {
    const fence = fenceInput(input, options);
    return mutate((entries) => {
      const current = entries.find((record) => record.accountId === fence.accountId
        && record.id === fence.id
        && (record.leaseToken ?? null) === fence.leaseToken);
      if (!current) return null;
      return update(current, fence);
    });
  }

  async function completeMatched(input = {}) {
    const targetDescriptionCategoryId = positiveId(
      input.targetDescriptionCategoryId,
      "targetDescriptionCategoryId",
    );
    const targetTypeId = positiveId(input.targetTypeId, "targetTypeId");
    const method = requiredText(input.method, "method");
    if (method === "MANUAL") {
      throw repositoryError(
        "Automatic category completion cannot use MANUAL method",
        "COLLECT_CATEGORY_RESOLUTION_INPUT_INVALID",
        400,
      );
    }
    const at = requiredDate(input.now, "now");
    const matchedAt = requiredDate(input.matchedAt ?? at, "matchedAt");
    const validatedAt = requiredDate(input.validatedAt ?? at, "validatedAt");
    const path = displayPath(input.displayPath);
    const credentialStoreId = optionalText(input.credentialStoreId, 240);
    const completionFingerprint = optionalText(input.taxonomyFingerprint, 240);
    const accountId = requiredText(input.accountId, "accountId");
    assertStoreScope(accountId, credentialStoreId);
    return fencedMutation(input, (current) => {
      assertStoreScope(accountId, credentialStoreId);
      if (current.status !== "MATCHING"
        || current.method === "MANUAL"
        || new Date(current.leaseExpiresAt || 0).getTime() <= at.getTime()) return null;
      if (!completionFingerprint
        || !current.taxonomyFingerprint
        || current.taxonomyFingerprint !== completionFingerprint) {
        throw executionMismatchError();
      }
      Object.assign(current, {
        status: "MATCHED",
        targetDescriptionCategoryId,
        targetTypeId,
        method,
        credentialStoreId,
        displayPath: path,
        failureCode: null,
        failureDetailSafe: null,
        leaseToken: null,
        leaseExpiresAt: null,
        matchedAt: matchedAt.toISOString(),
        validatedAt: validatedAt.toISOString(),
        updatedAt: at.toISOString(),
      });
      return recordFromRow(current);
    });
  }

  async function completeNeedsReview(input = {}) {
    const at = requiredDate(input.now, "now");
    const failureCode = requiredText(input.failureCode, "failureCode");
    return fencedMutation(input, (current) => {
      if (current.status !== "MATCHING"
        || current.method === "MANUAL"
        || new Date(current.leaseExpiresAt || 0).getTime() <= at.getTime()) return null;
      Object.assign(current, {
        status: "NEEDS_REVIEW",
        targetDescriptionCategoryId: null,
        targetTypeId: null,
        method: null,
        displayPath: {},
        failureCode,
        failureDetailSafe: optionalText(input.failureDetailSafe),
        leaseToken: null,
        leaseExpiresAt: null,
        matchedAt: null,
        validatedAt: null,
        updatedAt: at.toISOString(),
      });
      return recordFromRow(current);
    });
  }

  async function deferRetry(input = {}) {
    const at = requiredDate(input.now, "now");
    const nextAttemptAt = requiredDate(input.nextAttemptAt, "nextAttemptAt");
    if (nextAttemptAt.getTime() < at.getTime()) {
      throw repositoryError(
        "Collect category resolution nextAttemptAt is before now",
        "COLLECT_CATEGORY_RESOLUTION_INPUT_INVALID",
        400,
      );
    }
    const failureCode = requiredText(input.failureCode, "failureCode");
    return fencedMutation(input, (current) => {
      if (current.status !== "MATCHING"
        || current.method === "MANUAL"
        || new Date(current.leaseExpiresAt || 0).getTime() <= at.getTime()) return null;
      Object.assign(current, {
        status: "RETRYABLE_ERROR",
        failureCode,
        failureDetailSafe: optionalText(input.failureDetailSafe),
        nextAttemptAt: nextAttemptAt.toISOString(),
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: at.toISOString(),
      });
      return recordFromRow(current);
    });
  }

  async function invalidate(input = {}) {
    const at = requiredDate(input.now, "now");
    const nextAttemptAt = requiredDate(input.nextAttemptAt ?? at, "nextAttemptAt");
    return fencedMutation(input, (current) => {
      if (input.leaseToken != null
        && new Date(current.leaseExpiresAt || 0).getTime() <= at.getTime()) return null;
      Object.assign(current, {
        status: "INVALIDATED",
        failureCode: requiredText(input.failureCode, "failureCode"),
        failureDetailSafe: optionalText(input.failureDetailSafe),
        nextAttemptAt: nextAttemptAt.toISOString(),
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: at.toISOString(),
      });
      return recordFromRow(current);
    }, { nullableToken: true });
  }

  async function saveManual(input = {}) {
    const request = enqueueInput({ ...input, status: "QUEUED" });
    const targetDescriptionCategoryId = positiveId(
      input.targetDescriptionCategoryId,
      "targetDescriptionCategoryId",
    );
    const targetTypeId = positiveId(input.targetTypeId, "targetTypeId");
    const matchedAt = requiredDate(input.matchedAt ?? request.now, "matchedAt");
    const validatedAt = requiredDate(input.validatedAt ?? request.now, "validatedAt");
    const path = displayPath(input.displayPath);
    return mutate((entries) => {
      assertCollectItemScope(request.accountId, request.collectItemId);
      assertStoreScope(request.accountId, request.credentialStoreId);
      let current = entries.find((record) => sameStableKey(record, request));
      if (!current) {
        current = {
          id: randomUUID(),
          accountId: request.accountId,
          collectItemId: request.collectItemId,
          taxonomyScope: request.taxonomyScope,
          attemptCount: 0,
          nextAttemptAt: request.now.toISOString(),
          createdAt: request.now.toISOString(),
        };
        entries.push(current);
      }
      Object.assign(current, {
        sourceTypeId: request.sourceTypeId,
        targetDescriptionCategoryId,
        targetTypeId,
        method: "MANUAL",
        status: "MATCHED",
        taxonomyFingerprint: request.taxonomyFingerprint,
        credentialStoreId: request.credentialStoreId,
        displayPath: path,
        failureCode: null,
        failureDetailSafe: null,
        leaseToken: null,
        leaseExpiresAt: null,
        matchedAt: matchedAt.toISOString(),
        validatedAt: validatedAt.toISOString(),
        updatedAt: request.now.toISOString(),
      });
      return recordFromRow(current);
    });
  }

  async function releaseLease(input = {}) {
    const at = requiredDate(input.now, "now");
    return fencedMutation(input, (current) => {
      if (current.status !== "MATCHING"
        || new Date(current.leaseExpiresAt || 0).getTime() <= at.getTime()) return null;
      Object.assign(current, {
        status: "QUEUED",
        nextAttemptAt: at.toISOString(),
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: at.toISOString(),
      });
      return recordFromRow(current);
    });
  }

  return Object.freeze({
    enqueue,
    readForItem,
    claimNext,
    completeMatched,
    completeNeedsReview,
    deferRetry,
    invalidate,
    saveManual,
    releaseLease,
  });
}

export function createPostgresCollectCategoryResolutionRepository({ pool } = {}) {
  if (!pool?.query) throw new TypeError("Collect category resolution PostgreSQL pool required");

  async function query(sql, params = [], executor = pool) {
    try {
      return await executor.query(sql, params);
    } catch (error) {
      if (error?.code?.startsWith("COLLECT_CATEGORY_RESOLUTION_")) throw error;
      throw repositoryError("Collect category resolution PostgreSQL operation failed");
    }
  }

  async function requireInputScope({ accountId, collectItemId, credentialStoreId }) {
    const scoped = await query(
      `SELECT
         EXISTS (
           SELECT 1 FROM collect_items WHERE id=$2 AND account_id=$1
         ) AS collect_item_scoped,
         ($3::text IS NULL OR EXISTS (
           SELECT 1 FROM stores WHERE id=$3 AND owner_account_id=$1
         )) AS credential_store_scoped`,
      [accountId, collectItemId, credentialStoreId],
    );
    if (scoped.rows[0]?.collect_item_scoped !== true) throw collectItemScopeError();
    if (scoped.rows[0]?.credential_store_scoped !== true) throw credentialStoreScopeError();
  }

  async function requireCredentialStoreScope(accountId, credentialStoreId) {
    if (!credentialStoreId) return;
    const scoped = await query(
      `SELECT EXISTS (
         SELECT 1 FROM stores WHERE id=$2 AND owner_account_id=$1
       ) AS credential_store_scoped`,
      [accountId, credentialStoreId],
    );
    if (scoped.rows[0]?.credential_store_scoped !== true) throw credentialStoreScopeError();
  }

  async function enqueue(input) {
    const request = enqueueInput(input);
    await requireInputScope(request);
    const result = await query(
      `INSERT INTO collect_category_resolutions AS current (
         id, account_id, collect_item_id, taxonomy_scope, source_type_id, status,
         taxonomy_fingerprint, credential_store_id, next_attempt_at, created_at, updated_at
       )
       SELECT $1, item.account_id, item.id, $4, $5, $6, $7, $8, $9, $10, $10
         FROM collect_items AS item
         LEFT JOIN stores AS credential_store
           ON credential_store.id=$8 AND credential_store.owner_account_id=$2
        WHERE item.id=$3 AND item.account_id=$2
          AND ($8::text IS NULL OR credential_store.id IS NOT NULL)
       ON CONFLICT (account_id, collect_item_id, taxonomy_scope) DO UPDATE
       SET source_type_id=EXCLUDED.source_type_id,
           status=EXCLUDED.status,
           taxonomy_fingerprint=EXCLUDED.taxonomy_fingerprint,
           credential_store_id=EXCLUDED.credential_store_id,
           target_description_category_id=NULL,
           target_type_id=NULL,
           method=NULL,
           display_path_json='{}'::jsonb,
           failure_code=NULL,
           failure_detail_safe=NULL,
           attempt_count=0,
           next_attempt_at=EXCLUDED.next_attempt_at,
           lease_token=NULL,
           lease_expires_at=NULL,
           matched_at=NULL,
           validated_at=NULL,
           updated_at=EXCLUDED.updated_at
       WHERE NOT (current.status='MATCHED' AND current.method='MANUAL')
         AND NOT (
           current.source_type_id IS NOT DISTINCT FROM EXCLUDED.source_type_id
           AND current.taxonomy_fingerprint IS NOT DISTINCT FROM EXCLUDED.taxonomy_fingerprint
           AND (
             current.status IN ('MATCHING','MATCHED','NEEDS_REVIEW','RETRYABLE_ERROR')
             OR current.status=EXCLUDED.status
           )
         )
       RETURNING current.*`,
      [
        randomUUID(), request.accountId, request.collectItemId, request.taxonomyScope,
        request.sourceTypeId, request.status, request.taxonomyFingerprint,
        request.credentialStoreId, request.nextAttemptAt, request.now,
      ],
    );
    if (result.rows[0]) return recordFromRow(result.rows[0]);
    await requireInputScope(request);
    const stable = await query(
      `SELECT * FROM collect_category_resolutions
        WHERE account_id=$1 AND collect_item_id=$2 AND taxonomy_scope=$3`,
      [request.accountId, request.collectItemId, request.taxonomyScope],
    );
    if (!stable.rows[0]) throw collectItemScopeError();
    return recordFromRow(stable.rows[0]);
  }

  async function readForItem(input) {
    const scope = scopeInput(input);
    const result = await query(
      `SELECT * FROM collect_category_resolutions
        WHERE account_id=$1 AND collect_item_id=$2 AND taxonomy_scope=$3`,
      [scope.accountId, scope.collectItemId, scope.taxonomyScope],
    );
    return recordFromRow(result.rows[0] || null);
  }

  async function claimNext(input = {}) {
    const accountId = requiredText(input.accountId, "accountId");
    const taxonomyScope = input.taxonomyScope == null
      ? null
      : requiredText(input.taxonomyScope, "taxonomyScope");
    const leaseToken = requiredText(input.leaseToken, "leaseToken");
    const now = requiredDate(input.now, "now");
    const leaseExpiresAt = requiredDate(input.leaseExpiresAt, "leaseExpiresAt");
    if (leaseExpiresAt.getTime() <= now.getTime()) {
      throw repositoryError(
        "Collect category resolution lease must expire after now",
        "COLLECT_CATEGORY_RESOLUTION_INPUT_INVALID",
        400,
      );
    }
    if (typeof pool.connect !== "function") {
      throw new TypeError("Collect category resolution PostgreSQL pool.connect required");
    }
    const client = await pool.connect();
    let began = false;
    try {
      await query("BEGIN", [], client);
      began = true;
      const result = await query(
        `WITH candidate AS (
           SELECT id
             FROM collect_category_resolutions
            WHERE account_id=$1
              AND ($2::text IS NULL OR taxonomy_scope=$2)
              AND next_attempt_at<=$3
              AND (
                status IN ('QUEUED','RETRYABLE_ERROR','INVALIDATED')
                OR (status='MATCHING' AND lease_expires_at<=$3)
              )
            ORDER BY next_attempt_at, created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE collect_category_resolutions AS current
            SET status='MATCHING', lease_token=$4, lease_expires_at=$5,
                attempt_count=current.attempt_count+1, updated_at=$3,
                target_description_category_id=CASE
                   WHEN current.status='INVALIDATED' THEN NULL
                   ELSE current.target_description_category_id END,
                target_type_id=CASE WHEN current.status='INVALIDATED' THEN NULL ELSE current.target_type_id END,
                method=CASE WHEN current.status='INVALIDATED' THEN NULL ELSE current.method END,
                display_path_json=CASE WHEN current.status='INVALIDATED' THEN '{}'::jsonb ELSE current.display_path_json END,
                matched_at=CASE WHEN current.status='INVALIDATED' THEN NULL ELSE current.matched_at END,
                validated_at=CASE WHEN current.status='INVALIDATED' THEN NULL ELSE current.validated_at END
           FROM candidate
          WHERE current.account_id=$1 AND current.id=candidate.id
         RETURNING current.*`,
        [accountId, taxonomyScope, now, leaseToken, leaseExpiresAt],
        client,
      );
      await query("COMMIT", [], client);
      began = false;
      return recordFromRow(result.rows[0] || null);
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Keep the original persistence error.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function completeMatched(input = {}) {
    const fence = fenceInput(input);
    const targetDescriptionCategoryId = positiveId(
      input.targetDescriptionCategoryId,
      "targetDescriptionCategoryId",
    );
    const targetTypeId = positiveId(input.targetTypeId, "targetTypeId");
    const method = requiredText(input.method, "method");
    if (method === "MANUAL") {
      throw repositoryError(
        "Automatic category completion cannot use MANUAL method",
        "COLLECT_CATEGORY_RESOLUTION_INPUT_INVALID",
        400,
      );
    }
    const now = requiredDate(input.now, "now");
    const matchedAt = requiredDate(input.matchedAt ?? now, "matchedAt");
    const validatedAt = requiredDate(input.validatedAt ?? now, "validatedAt");
    const credentialStoreId = optionalText(input.credentialStoreId, 240);
    const completionFingerprint = optionalText(input.taxonomyFingerprint, 240);
    await requireCredentialStoreScope(fence.accountId, credentialStoreId);
    const claimed = await query(
      `SELECT taxonomy_fingerprint
         FROM collect_category_resolutions
        WHERE account_id=$1 AND id=$2 AND lease_token=$3
          AND status='MATCHING' AND method IS DISTINCT FROM 'MANUAL'
          AND lease_expires_at>$4`,
      [fence.accountId, fence.id, fence.leaseToken, now],
    );
    if (claimed.rows[0]
      && (!completionFingerprint
        || !claimed.rows[0].taxonomy_fingerprint
        || claimed.rows[0].taxonomy_fingerprint !== completionFingerprint)) {
      throw executionMismatchError();
    }
    const result = await query(
      `UPDATE collect_category_resolutions
          SET status='MATCHED', target_description_category_id=$4, target_type_id=$5,
              method=$6, credential_store_id=$8,
              display_path_json=$9::jsonb, failure_code=NULL, failure_detail_safe=NULL,
              matched_at=$10, validated_at=$11, lease_token=NULL, lease_expires_at=NULL,
              updated_at=$12
        WHERE account_id=$1 AND id=$2 AND lease_token=$3
          AND status='MATCHING' AND method IS DISTINCT FROM 'MANUAL'
          AND lease_expires_at>$12
          AND $7::text IS NOT NULL AND taxonomy_fingerprint=$7
          AND ($8::text IS NULL OR EXISTS (
            SELECT 1 FROM stores WHERE id=$8 AND owner_account_id=$1
          ))
        RETURNING *`,
      [
        fence.accountId, fence.id, fence.leaseToken, targetDescriptionCategoryId,
        targetTypeId, method, optionalText(input.taxonomyFingerprint, 240),
        credentialStoreId, JSON.stringify(displayPath(input.displayPath)),
        matchedAt, validatedAt, now,
      ],
    );
    if (!result.rows[0]) await requireCredentialStoreScope(fence.accountId, credentialStoreId);
    return recordFromRow(result.rows[0] || null);
  }

  async function completeNeedsReview(input = {}) {
    const fence = fenceInput(input);
    const now = requiredDate(input.now, "now");
    const result = await query(
      `UPDATE collect_category_resolutions
          SET status='NEEDS_REVIEW', target_description_category_id=NULL, target_type_id=NULL,
              method=NULL, display_path_json='{}'::jsonb, failure_code=$4,
              failure_detail_safe=$5, matched_at=NULL, validated_at=NULL,
              lease_token=NULL, lease_expires_at=NULL, updated_at=$6
        WHERE account_id=$1 AND id=$2 AND lease_token=$3
          AND status='MATCHING' AND method IS DISTINCT FROM 'MANUAL'
          AND lease_expires_at>$6
        RETURNING *`,
      [
        fence.accountId, fence.id, fence.leaseToken,
        requiredText(input.failureCode, "failureCode"), optionalText(input.failureDetailSafe), now,
      ],
    );
    return recordFromRow(result.rows[0] || null);
  }

  async function deferRetry(input = {}) {
    const fence = fenceInput(input);
    const now = requiredDate(input.now, "now");
    const nextAttemptAt = requiredDate(input.nextAttemptAt, "nextAttemptAt");
    if (nextAttemptAt.getTime() < now.getTime()) {
      throw repositoryError(
        "Collect category resolution nextAttemptAt is before now",
        "COLLECT_CATEGORY_RESOLUTION_INPUT_INVALID",
        400,
      );
    }
    const result = await query(
      `UPDATE collect_category_resolutions
          SET status='RETRYABLE_ERROR', failure_code=$4, failure_detail_safe=$5,
              next_attempt_at=$6, lease_token=NULL, lease_expires_at=NULL, updated_at=$7
        WHERE account_id=$1 AND id=$2 AND lease_token=$3
          AND status='MATCHING' AND method IS DISTINCT FROM 'MANUAL'
          AND lease_expires_at>$7
        RETURNING *`,
      [
        fence.accountId, fence.id, fence.leaseToken,
        requiredText(input.failureCode, "failureCode"), optionalText(input.failureDetailSafe),
        nextAttemptAt, now,
      ],
    );
    return recordFromRow(result.rows[0] || null);
  }

  async function invalidate(input = {}) {
    const fence = fenceInput(input, { nullableToken: true });
    const now = requiredDate(input.now, "now");
    const nextAttemptAt = requiredDate(input.nextAttemptAt ?? now, "nextAttemptAt");
    const result = await query(
      `UPDATE collect_category_resolutions
          SET status='INVALIDATED', failure_code=$4, failure_detail_safe=$5,
              next_attempt_at=$6, lease_token=NULL, lease_expires_at=NULL, updated_at=$7
        WHERE account_id=$1 AND id=$2 AND lease_token IS NOT DISTINCT FROM $3
          AND ($3::text IS NULL OR lease_expires_at>$7)
        RETURNING *`,
      [
        fence.accountId, fence.id, fence.leaseToken,
        requiredText(input.failureCode, "failureCode"), optionalText(input.failureDetailSafe),
        nextAttemptAt, now,
      ],
    );
    return recordFromRow(result.rows[0] || null);
  }

  async function saveManual(input = {}) {
    const request = enqueueInput({ ...input, status: "QUEUED" });
    await requireInputScope(request);
    const targetDescriptionCategoryId = positiveId(
      input.targetDescriptionCategoryId,
      "targetDescriptionCategoryId",
    );
    const targetTypeId = positiveId(input.targetTypeId, "targetTypeId");
    const matchedAt = requiredDate(input.matchedAt ?? request.now, "matchedAt");
    const validatedAt = requiredDate(input.validatedAt ?? request.now, "validatedAt");
    const result = await query(
      `INSERT INTO collect_category_resolutions (
         id, account_id, collect_item_id, taxonomy_scope, source_type_id,
         target_description_category_id, target_type_id, method, status,
         taxonomy_fingerprint, credential_store_id, display_path_json,
         failure_code, failure_detail_safe, attempt_count, next_attempt_at,
         lease_token, lease_expires_at, matched_at, validated_at, created_at, updated_at
       )
       SELECT $1, item.account_id, item.id, $4, $5, $6, $7, 'MANUAL', 'MATCHED',
              $8, $9, $10::jsonb, NULL, NULL, 0, $13, NULL, NULL, $11, $12, $13, $13
         FROM collect_items AS item
         LEFT JOIN stores AS credential_store
           ON credential_store.id=$9 AND credential_store.owner_account_id=$2
        WHERE item.id=$3 AND item.account_id=$2
          AND ($9::text IS NULL OR credential_store.id IS NOT NULL)
       ON CONFLICT (account_id, collect_item_id, taxonomy_scope) DO UPDATE
       SET source_type_id=EXCLUDED.source_type_id,
           target_description_category_id=EXCLUDED.target_description_category_id,
           target_type_id=EXCLUDED.target_type_id, method='MANUAL', status='MATCHED',
           taxonomy_fingerprint=EXCLUDED.taxonomy_fingerprint,
           credential_store_id=EXCLUDED.credential_store_id,
           display_path_json=EXCLUDED.display_path_json,
           failure_code=NULL, failure_detail_safe=NULL,
           lease_token=NULL, lease_expires_at=NULL,
           matched_at=EXCLUDED.matched_at, validated_at=EXCLUDED.validated_at,
           updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [
        randomUUID(), request.accountId, request.collectItemId, request.taxonomyScope,
        request.sourceTypeId, targetDescriptionCategoryId, targetTypeId,
        request.taxonomyFingerprint, request.credentialStoreId,
        JSON.stringify(displayPath(input.displayPath)), matchedAt, validatedAt, request.now,
      ],
    );
    if (!result.rows[0]) await requireInputScope(request);
    if (!result.rows[0]) throw collectItemScopeError();
    return recordFromRow(result.rows[0]);
  }

  async function releaseLease(input = {}) {
    const fence = fenceInput(input);
    const now = requiredDate(input.now, "now");
    const result = await query(
      `UPDATE collect_category_resolutions
          SET status='QUEUED', next_attempt_at=$4, lease_token=NULL,
              lease_expires_at=NULL, updated_at=$4
        WHERE account_id=$1 AND id=$2 AND lease_token=$3 AND status='MATCHING'
          AND lease_expires_at>$4
        RETURNING *`,
      [fence.accountId, fence.id, fence.leaseToken, now],
    );
    return recordFromRow(result.rows[0] || null);
  }

  return Object.freeze({
    enqueue,
    readForItem,
    claimNext,
    completeMatched,
    completeNeedsReview,
    deferRetry,
    invalidate,
    saveManual,
    releaseLease,
  });
}
