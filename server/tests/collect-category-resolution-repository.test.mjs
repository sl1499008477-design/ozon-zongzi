import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createJsonCollectCategoryResolutionRepository,
  createPostgresCollectCategoryResolutionRepository,
} from "../collect-category-resolution-repository.mjs";
import { appendAuditEvent } from "../audit-event.mjs";
import { removeAccountScope } from "../account-deletion.mjs";
import { createJsonStateTransactionBoundary } from "../json-state-transaction.mjs";
import { savePersistedState } from "../persistence.mjs";

const START = "2026-08-03T10:00:00.000Z";
const SCOPE = "OZON:DEFAULT";

function iso(value) {
  return new Date(value).toISOString();
}

function rowCopy(row) {
  if (!row) return row;
  const copied = structuredClone(row);
  for (const field of ["source_type_id", "target_description_category_id", "target_type_id"]) {
    if (copied[field] !== null && copied[field] !== undefined) copied[field] = String(copied[field]);
  }
  return copied;
}

function statefulPostgresPool() {
  let rows = [];
  let transactionRows = null;
  let credentialStoreToInvalidateBeforeMatchedWrite = null;
  let foreignKeyFailure = null;
  const collectItems = new Set(["account-a:collect-shared", "account-b:collect-b"]);
  const stores = new Set(["account-a:store-a", "account-b:store-b"]);

  function matchesFence(row, [accountId, id, leaseToken]) {
    return row.account_id === accountId && row.id === id && row.lease_token === leaseToken;
  }

  function matchesExpectedResolution(row, method, targetDescriptionCategoryId,
    targetTypeId, taxonomyFingerprint, matchedAt) {
    return (row.method ?? null) === (method ?? null)
      && (row.target_description_category_id ?? null) === (targetDescriptionCategoryId ?? null)
      && (row.target_type_id ?? null) === (targetTypeId ?? null)
      && (row.taxonomy_fingerprint ?? null) === (taxonomyFingerprint ?? null)
      && (row.matched_at ?? null) === (matchedAt ? iso(matchedAt) : null);
  }

  function maybeThrowForeignKey(operation) {
    if (foreignKeyFailure?.operation !== operation) return;
    const failure = foreignKeyFailure;
    foreignKeyFailure = null;
    throw Object.assign(new Error("insert or update violates foreign key with sensitive detail"), {
      code: "23503",
      constraint: failure.constraint,
      detail: "sensitive database relation detail",
    });
  }

  async function query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    if (normalized === "BEGIN") {
      transactionRows = structuredClone(rows);
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "COMMIT") {
      transactionRows = null;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "ROLLBACK") {
      if (transactionRows) rows = transactionRows;
      transactionRows = null;
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("SELECT EXISTS (")
      && normalized.endsWith("AS credential_store_scoped")
      && params.length === 2) {
      const [accountId, credentialStoreId] = params;
      return {
        rows: [{ credential_store_scoped: stores.has(`${accountId}:${credentialStoreId}`) }],
        rowCount: 1,
      };
    }

    if (normalized.startsWith("SELECT EXISTS (")
      && normalized.includes("AS collect_item_scoped")
      && normalized.endsWith("AS credential_store_scoped")) {
      const [accountId, collectItemId, credentialStoreId] = params;
      return {
        rows: [{
          collect_item_scoped: collectItems.has(`${accountId}:${collectItemId}`),
          credential_store_scoped:
            !credentialStoreId || stores.has(`${accountId}:${credentialStoreId}`),
        }],
        rowCount: 1,
      };
    }

    if (normalized.startsWith("INSERT INTO collect_category_resolutions AS current")) {
      maybeThrowForeignKey("enqueue");
      const [id, accountId, collectItemId, taxonomyScope, sourceTypeId, status,
        taxonomyFingerprint, credentialStoreId, nextAttemptAt, now] = params;
      if (!collectItems.has(`${accountId}:${collectItemId}`)
        || (credentialStoreId && !stores.has(`${accountId}:${credentialStoreId}`))) {
        return { rows: [], rowCount: 0 };
      }
      let row = rows.find((candidate) => candidate.account_id === accountId
        && candidate.collect_item_id === collectItemId
        && candidate.taxonomy_scope === taxonomyScope);
      if (!row) {
        row = {
          id,
          account_id: accountId,
          collect_item_id: collectItemId,
          taxonomy_scope: taxonomyScope,
          source_type_id: sourceTypeId,
          target_description_category_id: null,
          target_type_id: null,
          method: null,
          status,
          taxonomy_fingerprint: taxonomyFingerprint,
          credential_store_id: credentialStoreId,
          display_path_json: {},
          failure_code: null,
          failure_detail_safe: null,
          attempt_count: 0,
          next_attempt_at: iso(nextAttemptAt),
          lease_token: null,
          lease_expires_at: null,
          matched_at: null,
          validated_at: null,
          created_at: iso(now),
          updated_at: iso(now),
        };
        rows.push(row);
      } else if (row.method !== "MANUAL" && !(
        row.source_type_id === sourceTypeId
        && row.taxonomy_fingerprint === taxonomyFingerprint
        && (["MATCHING", "MATCHED", "NEEDS_REVIEW", "RETRYABLE_ERROR"].includes(row.status)
          || row.status === status)
      )) {
        Object.assign(row, {
          source_type_id: sourceTypeId,
          status,
          taxonomy_fingerprint: taxonomyFingerprint,
          credential_store_id: credentialStoreId,
          target_description_category_id: null,
          target_type_id: null,
          method: null,
          display_path_json: {},
          failure_code: null,
          failure_detail_safe: null,
          attempt_count: 0,
          next_attempt_at: iso(nextAttemptAt),
          lease_token: null,
          lease_expires_at: null,
          matched_at: null,
          validated_at: null,
          updated_at: iso(now),
        });
      }
      return { rows: [rowCopy(row)], rowCount: 1 };
    }

    if (normalized.startsWith("SELECT * FROM collect_category_resolutions")) {
      const [accountId, collectItemId, taxonomyScope] = params;
      const found = rows.find((row) => row.account_id === accountId
        && row.collect_item_id === collectItemId
        && row.taxonomy_scope === taxonomyScope);
      return { rows: found ? [rowCopy(found)] : [], rowCount: found ? 1 : 0 };
    }

    if (normalized.includes("FOR UPDATE SKIP LOCKED")) {
      const [accountId, taxonomyScope, now, leaseToken, leaseExpiresAt] = params;
      const nowMs = new Date(now).getTime();
      const found = rows
        .filter((row) => {
          const validationRetry = row.failure_detail_safe === "VALIDATION_RETRY_PENDING"
            && row.method != null
            && row.target_description_category_id != null
            && row.target_type_id != null;
          return row.account_id === accountId
          && (row.method !== "MANUAL" || validationRetry)
          && (!taxonomyScope || row.taxonomy_scope === taxonomyScope)
          && new Date(row.next_attempt_at).getTime() <= nowMs
          && (["QUEUED", "RETRYABLE_ERROR", "INVALIDATED"].includes(row.status)
            || (row.status === "MATCHED" && validationRetry)
            || (row.status === "MATCHING"
              && new Date(row.lease_expires_at || 0).getTime() <= nowMs));
        })
        .sort((left, right) => left.next_attempt_at.localeCompare(right.next_attempt_at))[0];
      if (!found) return { rows: [], rowCount: 0 };
      if (found.status === "INVALIDATED") {
        found.target_description_category_id = null;
        found.target_type_id = null;
        found.method = null;
        found.display_path_json = {};
        found.matched_at = null;
        found.validated_at = null;
      }
      Object.assign(found, {
        status: "MATCHING",
        lease_token: leaseToken,
        lease_expires_at: iso(leaseExpiresAt),
        attempt_count: found.attempt_count + 1,
        updated_at: iso(now),
      });
      return { rows: [rowCopy(found)], rowCount: 1 };
    }

    if (normalized.startsWith("SELECT taxonomy_fingerprint FROM collect_category_resolutions")) {
      const [accountId, id, leaseToken, now] = params;
      const found = rows.find((row) => row.account_id === accountId
        && row.id === id
        && row.lease_token === leaseToken
        && row.status === "MATCHING"
        && row.method !== "MANUAL"
        && new Date(row.lease_expires_at).getTime() > new Date(now).getTime());
      return {
        rows: found ? [{ taxonomy_fingerprint: found.taxonomy_fingerprint }] : [],
        rowCount: found ? 1 : 0,
      };
    }

    if (normalized.startsWith(
      "UPDATE collect_category_resolutions SET status='MATCHED', target_description_category_id=$4",
    )) {
      maybeThrowForeignKey("completeMatched");
      if (credentialStoreToInvalidateBeforeMatchedWrite) {
        stores.delete(credentialStoreToInvalidateBeforeMatchedWrite);
        credentialStoreToInvalidateBeforeMatchedWrite = null;
      }
      const row = rows.find((candidate) => matchesFence(candidate, params));
      if (!row || row.status !== "MATCHING" || row.method === "MANUAL"
        || !params[6] || row.taxonomy_fingerprint !== params[6]
        || (params[7] && !stores.has(`${params[0]}:${params[7]}`))
        || new Date(row.lease_expires_at).getTime() <= new Date(params[11]).getTime()) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        status: "MATCHED",
        target_description_category_id: params[3],
        target_type_id: params[4],
        method: params[5],
        taxonomy_fingerprint: params[6],
        credential_store_id: params[7],
        display_path_json: JSON.parse(params[8]),
        failure_code: null,
        failure_detail_safe: null,
        matched_at: iso(params[9]),
        validated_at: iso(params[10]),
        lease_token: null,
        lease_expires_at: null,
        updated_at: iso(params[11]),
      });
      return { rows: [rowCopy(row)], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE collect_category_resolutions SET status='NEEDS_REVIEW'")) {
      const row = rows.find((candidate) => matchesFence(candidate, params));
      if (!row || row.status !== "MATCHING" || row.method === "MANUAL"
        || new Date(row.lease_expires_at).getTime() <= new Date(params[5]).getTime()) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        status: "NEEDS_REVIEW",
        failure_code: params[3],
        failure_detail_safe: params[4],
        lease_token: null,
        lease_expires_at: null,
        updated_at: iso(params[5]),
      });
      return { rows: [rowCopy(row)], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE collect_category_resolutions SET status='RETRYABLE_ERROR'")) {
      const row = rows.find((candidate) => matchesFence(candidate, params));
      if (!row || row.status !== "MATCHING" || row.method === "MANUAL"
        || new Date(row.lease_expires_at).getTime() <= new Date(params[6]).getTime()) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        status: "RETRYABLE_ERROR",
        failure_code: params[3],
        failure_detail_safe: params[4],
        next_attempt_at: iso(params[5]),
        lease_token: null,
        lease_expires_at: null,
        updated_at: iso(params[6]),
      });
      return { rows: [rowCopy(row)], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE collect_category_resolutions SET status='INVALIDATED'")) {
      const row = rows.find((candidate) => matchesFence(candidate, params));
      if (!row || (params[2] != null
        && new Date(row.lease_expires_at).getTime() <= new Date(params[6]).getTime())
        || !matchesExpectedResolution(row, params[7], params[8], params[9], params[10], params[11])) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        status: "INVALIDATED",
        failure_code: params[3],
        failure_detail_safe: params[4],
        next_attempt_at: iso(params[5]),
        lease_token: null,
        lease_expires_at: null,
        updated_at: iso(params[6]),
      });
      return { rows: [rowCopy(row)], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE collect_category_resolutions SET status='QUEUED'")) {
      const row = rows.find((candidate) => matchesFence(candidate, params));
      if (!row || row.status !== "MATCHING"
        || new Date(row.lease_expires_at).getTime() <= new Date(params[3]).getTime()) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        status: "QUEUED",
        next_attempt_at: iso(params[3]),
        lease_token: null,
        lease_expires_at: null,
        updated_at: iso(params[3]),
      });
      return { rows: [rowCopy(row)], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE collect_category_resolutions SET source_type_id=$4")) {
      const [accountId, id, leaseToken, sourceTypeId, status, taxonomyFingerprint,
        credentialStoreId, nextAttemptAt, now] = params;
      const row = rows.find((candidate) => candidate.account_id === accountId
        && candidate.id === id && candidate.lease_token === leaseToken);
      if (!row || row.status !== "MATCHING" || row.method === "MANUAL"
        || new Date(row.lease_expires_at).getTime() <= new Date(now).getTime()
        || (credentialStoreId && !stores.has(`${accountId}:${credentialStoreId}`))) {
        return { rows: [], rowCount: 0 };
      }
      const executionChanged = row.source_type_id !== sourceTypeId
        || row.taxonomy_fingerprint !== taxonomyFingerprint;
      Object.assign(row, {
        source_type_id: sourceTypeId,
        status,
        taxonomy_fingerprint: taxonomyFingerprint,
        credential_store_id: credentialStoreId,
        target_description_category_id: null,
        target_type_id: null,
        method: null,
        display_path_json: {},
        failure_code: null,
        failure_detail_safe: null,
        attempt_count: executionChanged ? 0 : row.attempt_count,
        next_attempt_at: iso(nextAttemptAt),
        lease_token: null,
        lease_expires_at: null,
        matched_at: null,
        validated_at: null,
        updated_at: iso(now),
      });
      return { rows: [rowCopy(row)], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE collect_category_resolutions SET status='MATCHED', taxonomy_fingerprint=$4")) {
      const [accountId, id, leaseToken, taxonomyFingerprint, credentialStoreId,
        validatedAt, now, expectedMethod, expectedDescriptionCategoryId,
        expectedTypeId, expectedFingerprint, expectedMatchedAt] = params;
      const row = rows.find((candidate) => matchesFence(candidate, params));
      const validStatus = leaseToken == null
        ? row?.status === "MATCHED"
        : row?.status === "MATCHING"
          && row.failure_detail_safe === "VALIDATION_RETRY_PENDING"
          && new Date(row.lease_expires_at).getTime() > new Date(now).getTime();
      if (!row || !validStatus
        || !matchesExpectedResolution(row, expectedMethod, expectedDescriptionCategoryId,
          expectedTypeId, expectedFingerprint, expectedMatchedAt)
        || (credentialStoreId && !stores.has(`${accountId}:${credentialStoreId}`))) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        status: "MATCHED",
        taxonomy_fingerprint: taxonomyFingerprint,
        credential_store_id: credentialStoreId,
        failure_code: null,
        failure_detail_safe: null,
        attempt_count: 0,
        next_attempt_at: iso(now),
        lease_token: null,
        lease_expires_at: null,
        validated_at: iso(validatedAt),
        updated_at: iso(now),
      });
      return { rows: [rowCopy(row)], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE collect_category_resolutions SET status='MATCHED', credential_store_id=$4")) {
      const [accountId, id, leaseToken, credentialStoreId, failureCode,
        failureDetailSafe, nextAttemptAt, now, expectedMethod,
        expectedDescriptionCategoryId, expectedTypeId, expectedFingerprint,
        expectedMatchedAt] = params;
      const row = rows.find((candidate) => matchesFence(candidate, params));
      const validStatus = leaseToken == null
        ? row?.status === "MATCHED"
        : row?.status === "MATCHING"
          && row.failure_detail_safe === "VALIDATION_RETRY_PENDING"
          && new Date(row.lease_expires_at).getTime() > new Date(now).getTime();
      if (!row || !validStatus
        || !matchesExpectedResolution(row, expectedMethod, expectedDescriptionCategoryId,
          expectedTypeId, expectedFingerprint, expectedMatchedAt)
        || (credentialStoreId && !stores.has(`${accountId}:${credentialStoreId}`))) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        status: "MATCHED",
        credential_store_id: credentialStoreId,
        failure_code: failureCode,
        failure_detail_safe: failureDetailSafe,
        attempt_count: row.attempt_count + 1,
        next_attempt_at: iso(nextAttemptAt),
        lease_token: null,
        lease_expires_at: null,
        updated_at: iso(now),
      });
      return { rows: [rowCopy(row)], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO collect_category_resolutions AS current") === false
      && normalized.startsWith("INSERT INTO collect_category_resolutions")) {
      maybeThrowForeignKey("saveManual");
      const [id, accountId, collectItemId, taxonomyScope, sourceTypeId,
        targetDescriptionCategoryId, targetTypeId, taxonomyFingerprint,
        credentialStoreId, displayPathJson, matchedAt, validatedAt, now] = params;
      if (!collectItems.has(`${accountId}:${collectItemId}`)
        || (credentialStoreId && !stores.has(`${accountId}:${credentialStoreId}`))) {
        return { rows: [], rowCount: 0 };
      }
      let row = rows.find((candidate) => candidate.account_id === accountId
        && candidate.collect_item_id === collectItemId
        && candidate.taxonomy_scope === taxonomyScope);
      const base = {
        id, account_id: accountId, collect_item_id: collectItemId, taxonomy_scope: taxonomyScope,
        attempt_count: 0, next_attempt_at: iso(now), created_at: iso(now),
      };
      if (!row) {
        row = base;
        rows.push(row);
      }
      Object.assign(row, {
        source_type_id: sourceTypeId,
        target_description_category_id: targetDescriptionCategoryId,
        target_type_id: targetTypeId,
        method: "MANUAL",
        status: "MATCHED",
        taxonomy_fingerprint: taxonomyFingerprint,
        credential_store_id: credentialStoreId,
        display_path_json: JSON.parse(displayPathJson),
        failure_code: null,
        failure_detail_safe: null,
        lease_token: null,
        lease_expires_at: null,
        matched_at: iso(matchedAt),
        validated_at: iso(validatedAt),
        updated_at: iso(now),
      });
      return { rows: [rowCopy(row)], rowCount: 1 };
    }

    throw new Error(`Unexpected SQL in category-resolution test pool: ${normalized}`);
  }

  return {
    query,
    invalidateCredentialStoreBeforeNextMatchedWrite(accountId, credentialStoreId) {
      credentialStoreToInvalidateBeforeMatchedWrite = `${accountId}:${credentialStoreId}`;
    },
    failNextForeignKey(operation, constraint) {
      foreignKeyFailure = { operation, constraint };
    },
    async connect() {
      return { query, release() {} };
    },
  };
}

function jsonRepository(options) {
  return createJsonCollectCategoryResolutionRepository({
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    ...options,
  });
}

const adapters = {
  JSON() {
    const state = {
      caches: { collectBox: [
        { id: "collect-shared", accountId: "account-a" },
        { id: "collect-b", accountId: "account-b" },
      ] },
      stores: [
        { id: "store-a", ownerAccountId: "account-a" },
        { id: "store-b", ownerAccountId: "account-b" },
      ],
    };
    return jsonRepository({
      state,
      auditWriter: async ({ state: transactionState, event }) => {
        appendAuditEvent(transactionState, {
          eventId: `category-resolution-${transactionState.auditEvents?.length || 0}`,
          action: event.action,
          accountId: event.accountId,
          entityType: "collect-category-resolution",
          entityId: event.collectItemId,
          metadata: event,
          createdAt: START,
        });
      },
    });
  },
  PostgreSQL() {
    return createPostgresCollectCategoryResolutionRepository({
      pool: statefulPostgresPool(),
      auditWriter: async () => {},
    });
  },
};

function queued(overrides = {}) {
  return {
    accountId: "account-a",
    collectItemId: "collect-shared",
    taxonomyScope: SCOPE,
    sourceTypeId: 94405,
    status: "QUEUED",
    taxonomyFingerprint: "taxonomy-v1",
    credentialStoreId: "store-a",
    now: START,
    ...overrides,
  };
}

function safeAudit(action = "COLLECT_CATEGORY_RESOLUTION_QUEUED") {
  return {
    action,
    accountId: "account-a",
    collectItemId: "collect-shared",
    taxonomyScope: SCOPE,
    sourceTypeId: 94405,
    credentialStoreId: "store-a",
    taxonomyFingerprint: "taxonomy-v1",
    attempt: 0,
  };
}

function resolutionIdentity(record) {
  return {
    method: record.method,
    targetDescriptionCategoryId: record.targetDescriptionCategoryId,
    targetTypeId: record.targetTypeId,
    taxonomyFingerprint: record.taxonomyFingerprint,
    matchedAt: record.matchedAt,
  };
}

async function createAutomaticMatch(repository, {
  leaseToken = "automatic-match-lease",
  matchedAt = "2026-08-03T10:00:01.000Z",
} = {}) {
  const queuedRecord = await repository.enqueue(queued());
  await repository.claimNext({
    accountId: "account-a",
    taxonomyScope: SCOPE,
    leaseToken,
    leaseExpiresAt: "2026-08-03T10:01:00.000Z",
    now: START,
  });
  return repository.completeMatched({
    accountId: "account-a",
    id: queuedRecord.id,
    leaseToken,
    targetDescriptionCategoryId: 17028702,
    targetTypeId: 94405,
    method: "TYPE_ID_EXACT",
    taxonomyFingerprint: "taxonomy-v1",
    credentialStoreId: "store-a",
    matchedAt,
    validatedAt: matchedAt,
    now: matchedAt,
  });
}

function assertCredentialScopeError(error) {
  assert.deepEqual({
    code: error?.code,
    status: error?.status,
    message: error?.message,
  }, {
    code: "COLLECT_CATEGORY_RESOLUTION_CREDENTIAL_STORE_SCOPE",
    status: 403,
    message: "Credential store is outside the category resolution account scope",
  });
  return true;
}

function assertExecutionMismatch(error) {
  assert.deepEqual({
    code: error?.code,
    status: error?.status,
    message: error?.message,
  }, {
    code: "COLLECT_CATEGORY_RESOLUTION_EXECUTION_MISMATCH",
    status: 409,
    message: "Category resolution completion does not match the claimed execution",
  });
  return true;
}

for (const [adapterName, createRepository] of Object.entries(adapters)) {
  test(`${adapterName} enqueue is idempotent and every read, claim, and update is account scoped`, async () => {
    const repository = createRepository();
    const first = await repository.enqueue(queued());
    const replay = await repository.enqueue(queued());

    assert.equal(replay.id, first.id);
    await assert.rejects(
      repository.enqueue(queued({
        sourceTypeId: 99999,
        credentialStoreId: "store-b",
        now: "2026-08-03T10:00:00.250Z",
      })),
      assertCredentialScopeError,
    );
    assert.equal((await repository.readForItem(queued())).sourceTypeId, 94405);
    assert.equal(await repository.readForItem({
      accountId: "account-b",
      collectItemId: "collect-shared",
      taxonomyScope: SCOPE,
    }), null);
    assert.equal(await repository.claimNext({
      accountId: "account-b",
      taxonomyScope: SCOPE,
      leaseToken: "account-b-token",
      leaseExpiresAt: "2026-08-03T10:01:00.000Z",
      now: START,
    }), null);

    const claimed = await repository.claimNext({
      accountId: "account-a",
      taxonomyScope: SCOPE,
      leaseToken: "account-a-token",
      leaseExpiresAt: "2026-08-03T10:01:00.000Z",
      now: START,
    });
    assert.equal(claimed.id, first.id);
    await repository.enqueue(queued({ now: "2026-08-03T10:00:00.500Z" }));
    assert.equal((await repository.readForItem(queued())).leaseToken, "account-a-token");
    assert.equal(await repository.completeNeedsReview({
      accountId: "account-b",
      id: first.id,
      leaseToken: "account-a-token",
      failureCode: "TYPE_NOT_FOUND",
      now: "2026-08-03T10:00:01.000Z",
    }), null);
    assert.equal((await repository.readForItem(queued())).status, "MATCHING");
    assert.equal(await repository.claimNext({
      accountId: "account-a",
      taxonomyScope: SCOPE,
      leaseToken: "duplicate-token",
      leaseExpiresAt: "2026-08-03T10:01:00.000Z",
      now: "2026-08-03T10:00:01.000Z",
    }), null);
  });

  test(`${adapterName} expired leases recover and stale lease tokens cannot complete`, async () => {
    const repository = createRepository();
    const record = await repository.enqueue(queued());
    await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "lease-old",
      leaseExpiresAt: "2026-08-03T10:01:00.000Z", now: START,
    });
    assert.equal(await repository.completeMatched({
      accountId: "account-a", id: record.id, leaseToken: "lease-old",
      targetDescriptionCategoryId: 17028702, targetTypeId: 94405,
      method: "TYPE_ID_EXACT", taxonomyFingerprint: "taxonomy-v1",
      credentialStoreId: "store-a", now: "2026-08-03T10:01:00.000Z",
    }), null);
    const recovered = await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "lease-new",
      leaseExpiresAt: "2026-08-03T10:03:00.000Z", now: "2026-08-03T10:01:00.000Z",
    });
    assert.equal(recovered.id, record.id);
    assert.equal(recovered.leaseToken, "lease-new");

    assert.equal(await repository.completeMatched({
      accountId: "account-a", id: record.id, leaseToken: "lease-old",
      targetDescriptionCategoryId: 17028702, targetTypeId: 94405,
      method: "TYPE_ID_EXACT", taxonomyFingerprint: "taxonomy-v1",
      credentialStoreId: "store-a", displayPath: { zh: ["家居", "杯子"] },
      now: "2026-08-03T10:01:01.000Z",
    }), null);
    const matched = await repository.completeMatched({
      accountId: "account-a", id: record.id, leaseToken: "lease-new",
      targetDescriptionCategoryId: 17028702, targetTypeId: 94405,
      method: "TYPE_ID_EXACT", taxonomyFingerprint: "taxonomy-v1",
      credentialStoreId: "store-a", displayPath: { zh: ["家居", "杯子"] },
      now: "2026-08-03T10:01:01.000Z",
    });
    assert.equal(matched.status, "MATCHED");
    assert.equal(matched.attemptCount, 2);
    assert.deepEqual(matched.displayPath, { zh: ["家居", "杯子"] });
  });

  test(`${adapterName} manual results fence a stale automatic completion and survive enqueue replay`, async () => {
    const repository = createRepository();
    const record = await repository.enqueue(queued());
    await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "auto-lease",
      leaseExpiresAt: "2026-08-03T10:01:00.000Z", now: START,
    });
    const manual = await repository.saveManual({
      accountId: "account-a", collectItemId: "collect-shared", taxonomyScope: SCOPE,
      sourceTypeId: 94405, targetDescriptionCategoryId: 17029999, targetTypeId: 94405,
      taxonomyFingerprint: "taxonomy-v1", credentialStoreId: "store-a",
      displayPath: { zh: ["人工类目"] }, now: "2026-08-03T10:00:10.000Z",
    });
    assert.equal(manual.method, "MANUAL");

    assert.equal(await repository.completeMatched({
      accountId: "account-a", id: record.id, leaseToken: "auto-lease",
      targetDescriptionCategoryId: 17028702, targetTypeId: 94405,
      method: "TYPE_ID_EXACT", taxonomyFingerprint: "taxonomy-v1",
      credentialStoreId: "store-a", now: "2026-08-03T10:00:11.000Z",
    }), null);
    await repository.enqueue(queued({ now: "2026-08-03T10:00:12.000Z" }));
    const current = await repository.readForItem(queued());
    assert.equal(current.method, "MANUAL");
    assert.equal(current.targetDescriptionCategoryId, 17029999);
    await repository.invalidate({
      accountId: "account-a", id: record.id, leaseToken: null,
      expectedResolution: resolutionIdentity(current),
      failureCode: "MANUAL_TARGET_DISABLED", now: "2026-08-03T10:00:13.000Z",
    });
    const invalidManual = await repository.readForItem(queued());
    assert.equal(invalidManual.status, "INVALIDATED");
    assert.equal(invalidManual.method, "MANUAL");
    const requeued = await repository.enqueue(queued({ now: "2026-08-03T10:00:14.000Z" }));
    assert.equal(requeued.status, "INVALIDATED");
    assert.equal(requeued.method, "MANUAL");
    assert.equal(await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "automatic-retry",
      leaseExpiresAt: "2026-08-03T10:02:00.000Z", now: "2026-08-03T10:00:14.000Z",
    }), null);
  });

  test(`${adapterName} defer, release, review, and explicit invalidation preserve recoverable transitions`, async () => {
    const repository = createRepository();
    const record = await repository.enqueue(queued());
    await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "lease-1",
      leaseExpiresAt: "2026-08-03T10:01:00.000Z", now: START,
    });
    const deferred = await repository.deferRetry({
      accountId: "account-a", id: record.id, leaseToken: "lease-1",
      failureCode: "OZON_RATE_LIMITED", failureDetailSafe: "429",
      nextAttemptAt: "2026-08-03T10:05:00.000Z", now: "2026-08-03T10:00:10.000Z",
    });
    assert.equal(deferred.status, "RETRYABLE_ERROR");
    assert.equal(await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "too-soon",
      leaseExpiresAt: "2026-08-03T10:05:30.000Z", now: "2026-08-03T10:04:59.999Z",
    }), null);
    await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "lease-2",
      leaseExpiresAt: "2026-08-03T10:06:00.000Z", now: "2026-08-03T10:05:00.000Z",
    });
    assert.equal(await repository.releaseLease({
      accountId: "account-a", id: record.id, leaseToken: "wrong-token",
      now: "2026-08-03T10:05:01.000Z",
    }), null);
    assert.equal((await repository.releaseLease({
      accountId: "account-a", id: record.id, leaseToken: "lease-2",
      now: "2026-08-03T10:05:01.000Z",
    })).status, "QUEUED");
    await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "lease-3",
      leaseExpiresAt: "2026-08-03T10:07:00.000Z", now: "2026-08-03T10:05:01.000Z",
    });
    const review = await repository.completeNeedsReview({
      accountId: "account-a", id: record.id, leaseToken: "lease-3",
      failureCode: "TYPE_AMBIGUOUS", failureDetailSafe: "2 candidates",
      now: "2026-08-03T10:05:02.000Z",
    });
    assert.equal(review.status, "NEEDS_REVIEW");
    const invalidated = await repository.invalidate({
      accountId: "account-a", id: record.id, leaseToken: null,
      expectedResolution: resolutionIdentity(review),
      failureCode: "TAXONOMY_CHANGED", nextAttemptAt: "2026-08-03T10:05:03.000Z",
      now: "2026-08-03T10:05:03.000Z",
    });
    assert.equal(invalidated.status, "INVALIDATED");
  });

  test(`${adapterName} a changed execution key resets the retry attempt count`, async () => {
    const repository = createRepository();
    const record = await repository.enqueue(queued());
    await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "lease-v1",
      leaseExpiresAt: "2026-08-03T10:01:00.000Z", now: START,
    });
    await repository.releaseLease({
      accountId: "account-a", id: record.id, leaseToken: "lease-v1",
      now: "2026-08-03T10:00:01.000Z",
    });
    const nextExecution = await repository.enqueue(queued({
      sourceTypeId: 95555,
      taxonomyFingerprint: "taxonomy-v2",
      now: "2026-08-03T10:00:02.000Z",
    }));

    assert.equal(nextExecution.attemptCount, 0);
  });

  test(`${adapterName} completion cannot replace the fingerprint owned by its lease`, async () => {
    const repository = createRepository();
    const record = await repository.enqueue(queued());
    await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "fingerprint-lease",
      leaseExpiresAt: "2026-08-03T10:01:00.000Z", now: START,
    });
    const completion = {
      accountId: "account-a", id: record.id, leaseToken: "fingerprint-lease",
      targetDescriptionCategoryId: 17028702, targetTypeId: 94405,
      method: "TYPE_ID_EXACT", credentialStoreId: "store-a",
      now: "2026-08-03T10:00:01.000Z",
    };

    await assert.rejects(
      repository.completeMatched({ ...completion, taxonomyFingerprint: "taxonomy-v2" }),
      assertExecutionMismatch,
    );
    await assert.rejects(
      repository.completeMatched({ ...completion, taxonomyFingerprint: null }),
      assertExecutionMismatch,
    );
    assert.equal((await repository.readForItem(queued())).status, "MATCHING");
    const matched = await repository.completeMatched({
      ...completion,
      taxonomyFingerprint: "taxonomy-v1",
    });
    assert.equal(matched.taxonomyFingerprint, "taxonomy-v1");
  });

  test(`${adapterName} credential-store scope failures share one stable safe error contract`, async () => {
    const repository = createRepository();
    await assert.rejects(
      repository.enqueue(queued({ credentialStoreId: "store-b" })),
      assertCredentialScopeError,
    );
    await assert.rejects(
      repository.saveManual({
        ...queued({ credentialStoreId: "missing-store" }),
        targetDescriptionCategoryId: 17029999,
        targetTypeId: 94405,
      }),
      assertCredentialScopeError,
    );
    const record = await repository.enqueue(queued());
    await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "store-scope-lease",
      leaseExpiresAt: "2026-08-03T10:01:00.000Z", now: START,
    });
    await assert.rejects(
      repository.completeMatched({
        accountId: "account-a", id: record.id, leaseToken: "store-scope-lease",
        targetDescriptionCategoryId: 17028702, targetTypeId: 94405,
        method: "TYPE_ID_EXACT", taxonomyFingerprint: "taxonomy-v1",
        credentialStoreId: "store-b", now: "2026-08-03T10:00:01.000Z",
      }),
      assertCredentialScopeError,
    );
    assert.equal((await repository.readForItem(queued())).status, "MATCHING");
  });

  test(`${adapterName} requeues the claimed record directly without a second account-global claim`, async () => {
    const repository = createRepository();
    const record = await repository.enqueue(queued());
    await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "refresh-lease",
      leaseExpiresAt: "2026-08-03T10:01:00.000Z", now: START,
    });

    const requeued = await repository.requeueClaim({
      accountId: "account-a",
      id: record.id,
      leaseToken: "refresh-lease",
      sourceTypeId: 95555,
      status: "QUEUED",
      taxonomyFingerprint: "taxonomy-v2",
      credentialStoreId: "store-a",
      nextAttemptAt: "2026-08-03T10:00:01.000Z",
      now: "2026-08-03T10:00:01.000Z",
      auditEvent: safeAudit(),
    });

    assert.equal(requeued.id, record.id);
    assert.equal(requeued.status, "QUEUED");
    assert.equal(requeued.sourceTypeId, 95555);
    assert.equal(requeued.taxonomyFingerprint, "taxonomy-v2");
    assert.equal(requeued.attemptCount, 0);
  });

  test(`${adapterName} validation transitions preserve a manual target and persist restart-safe retry metadata`, async () => {
    const repository = createRepository();
    const manual = await repository.saveManual({
      ...queued(),
      targetDescriptionCategoryId: 17029999,
      targetTypeId: 94405,
      displayPath: { zh: ["人工类目"] },
    });

    const validated = await repository.validateMatched({
      accountId: "account-a",
      id: manual.id,
      taxonomyFingerprint: "taxonomy-v2",
      credentialStoreId: "store-a",
      expectedResolution: resolutionIdentity(manual),
      validatedAt: "2026-08-03T10:02:00.000Z",
      now: "2026-08-03T10:02:00.000Z",
      auditEvent: safeAudit("COLLECT_CATEGORY_RESOLUTION_VALIDATED"),
    });
    assert.equal(validated.status, "MATCHED");
    assert.equal(validated.method, "MANUAL");
    assert.equal(validated.targetDescriptionCategoryId, 17029999);
    assert.equal(validated.taxonomyFingerprint, "taxonomy-v2");

    const deferred = await repository.deferValidation({
      accountId: "account-a",
      id: manual.id,
      credentialStoreId: "store-a",
      expectedResolution: resolutionIdentity(validated),
      retryable: true,
      failureCode: "HTTP_503",
      nextAttemptAt: "2026-08-03T10:03:00.000Z",
      now: "2026-08-03T10:02:01.000Z",
      auditEvent: safeAudit("COLLECT_CATEGORY_RESOLUTION_RETRY_DEFERRED"),
    });
    assert.equal(deferred.status, "MATCHED");
    assert.equal(deferred.method, "MANUAL");
    assert.equal(deferred.targetDescriptionCategoryId, 17029999);
    assert.equal(deferred.failureCode, "HTTP_503");
    assert.equal(deferred.nextAttemptAt, "2026-08-03T10:03:00.000Z");
    assert.equal(deferred.attemptCount, 1);
  });
}

for (const [adapterName, setup] of Object.entries({
  JSON() {
    const state = {
      caches: { collectBox: [{ id: "collect-shared", accountId: "account-a" }] },
      stores: [{ id: "store-a", ownerAccountId: "account-a" }],
    };
    let auditWrites = 0;
    return {
      repository: jsonRepository({
        state,
        auditWriter: async ({ state: transactionState, event }) => {
          auditWrites += 1;
          appendAuditEvent(transactionState, {
            eventId: `cas-audit-${auditWrites}`,
            action: event.action,
            accountId: event.accountId,
            entityType: "collect-category-resolution",
            entityId: event.collectItemId,
            metadata: event,
            createdAt: START,
          });
        },
      }),
      auditWrites: () => auditWrites,
    };
  },
  PostgreSQL() {
    let auditWrites = 0;
    return {
      repository: createPostgresCollectCategoryResolutionRepository({
        pool: statefulPostgresPool(),
        auditWriter: async () => { auditWrites += 1; },
      }),
      auditWrites: () => auditWrites,
    };
  },
})) {
  test(`${adapterName} stale validation mutations cannot replace a newly saved manual resolution`, async () => {
    const { repository, auditWrites } = setup();
    const staleAutomatic = await createAutomaticMatch(repository);
    const manual = await repository.saveManual({
      ...queued({ now: "2026-08-03T10:00:02.000Z" }),
      targetDescriptionCategoryId: 17029999,
      targetTypeId: 95555,
      taxonomyFingerprint: "taxonomy-v2",
      displayPath: { zh: ["新人工类目"] },
    });
    const expectedResolution = resolutionIdentity(staleAutomatic);

    assert.equal(await repository.validateMatched({
      accountId: "account-a",
      id: staleAutomatic.id,
      expectedResolution,
      taxonomyFingerprint: "taxonomy-v3",
      credentialStoreId: "store-a",
      validatedAt: "2026-08-03T10:00:03.000Z",
      now: "2026-08-03T10:00:03.000Z",
      auditEvent: safeAudit("COLLECT_CATEGORY_RESOLUTION_VALIDATED"),
    }), null);
    assert.equal(await repository.deferValidation({
      accountId: "account-a",
      id: staleAutomatic.id,
      expectedResolution,
      retryable: true,
      credentialStoreId: "store-a",
      failureCode: "HTTP_503",
      nextAttemptAt: "2026-08-03T10:01:00.000Z",
      now: "2026-08-03T10:00:03.000Z",
      auditEvent: safeAudit("COLLECT_CATEGORY_RESOLUTION_RETRY_DEFERRED"),
    }), null);
    assert.equal(await repository.invalidate({
      accountId: "account-a",
      id: staleAutomatic.id,
      leaseToken: null,
      expectedResolution,
      failureCode: "TYPE_DISABLED",
      now: "2026-08-03T10:00:03.000Z",
      auditEvent: safeAudit("COLLECT_CATEGORY_RESOLUTION_INVALIDATED"),
    }), null);

    const current = await repository.readForItem(queued());
    assert.equal(current.status, "MATCHED");
    assert.equal(current.method, "MANUAL");
    assert.equal(current.targetDescriptionCategoryId, 17029999);
    assert.equal(current.targetTypeId, 95555);
    assert.equal(current.taxonomyFingerprint, "taxonomy-v2");
    assert.equal(current.matchedAt, manual.matchedAt);
    assert.equal(auditWrites(), 0);
  });

  test(`${adapterName} only due matched validation retries are claimable and preserve their target`, async () => {
    const { repository } = setup();
    const manual = await repository.saveManual({
      ...queued(),
      targetDescriptionCategoryId: 17029999,
      targetTypeId: 94405,
      displayPath: { zh: ["人工类目"] },
    });
    const deferred = await repository.deferValidation({
      accountId: "account-a",
      id: manual.id,
      expectedResolution: resolutionIdentity(manual),
      retryable: true,
      credentialStoreId: "store-a",
      failureCode: "HTTP_503",
      nextAttemptAt: "2026-08-03T10:01:00.000Z",
      now: "2026-08-03T10:00:01.000Z",
      auditEvent: safeAudit("COLLECT_CATEGORY_RESOLUTION_RETRY_DEFERRED"),
    });

    assert.equal(await repository.claimNext({
      accountId: "account-a",
      taxonomyScope: SCOPE,
      leaseToken: "too-soon-validation",
      leaseExpiresAt: "2026-08-03T10:02:00.000Z",
      now: "2026-08-03T10:00:59.999Z",
    }), null);
    const claimed = await repository.claimNext({
      accountId: "account-a",
      taxonomyScope: SCOPE,
      leaseToken: "validation-retry-lease",
      leaseExpiresAt: "2026-08-03T10:03:00.000Z",
      now: "2026-08-03T10:01:00.000Z",
    });
    assert.equal(claimed.status, "MATCHING");
    assert.equal(claimed.method, "MANUAL");
    assert.equal(claimed.targetDescriptionCategoryId, 17029999);
    assert.equal(claimed.targetTypeId, 94405);
    assert.equal(claimed.failureDetailSafe, "VALIDATION_RETRY_PENDING");

    const validated = await repository.validateMatched({
      accountId: "account-a",
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      expectedResolution: resolutionIdentity(deferred),
      taxonomyFingerprint: "taxonomy-v2",
      credentialStoreId: "store-a",
      validatedAt: "2026-08-03T10:01:01.000Z",
      now: "2026-08-03T10:01:01.000Z",
      auditEvent: safeAudit("COLLECT_CATEGORY_RESOLUTION_VALIDATED"),
    });
    assert.equal(validated.status, "MATCHED");
    assert.equal(validated.method, "MANUAL");
    assert.equal(validated.targetDescriptionCategoryId, 17029999);
    assert.equal(validated.failureCode, null);
    assert.equal(validated.failureDetailSafe, null);
    assert.equal(validated.leaseToken, null);
    assert.equal(await repository.claimNext({
      accountId: "account-a",
      taxonomyScope: SCOPE,
      leaseToken: "ordinary-match-must-not-claim",
      leaseExpiresAt: "2026-08-03T10:04:00.000Z",
      now: "2026-08-03T10:02:00.000Z",
    }), null);
  });
}

for (const [adapterName, setup] of Object.entries({
  JSON() {
    const state = {
      caches: { collectBox: [{ id: "collect-shared", accountId: "account-a" }] },
      stores: [{ id: "store-a", ownerAccountId: "account-a" }],
    };
    const repository = jsonRepository({
      state,
      auditWriter: async ({ event }) => {
        state.auditEvents = [...(state.auditEvents || []), structuredClone(event)];
        throw new Error("audit unavailable");
      },
    });
    return { repository, readAudit: () => state.auditEvents || [] };
  },
  PostgreSQL() {
    const pool = statefulPostgresPool();
    const repository = createPostgresCollectCategoryResolutionRepository({
      pool,
      auditWriter: async () => { throw new Error("audit unavailable"); },
    });
    return { repository, readAudit: () => [] };
  },
})) {
  test(`${adapterName} rolls the domain transition back when its audit write fails`, async () => {
    const { repository, readAudit } = setup();
    await assert.rejects(
      repository.enqueue({ ...queued(), auditEvent: safeAudit() }),
      /audit unavailable/,
    );
    assert.equal(await repository.readForItem(queued()), null);
    assert.deepEqual(readAudit(), []);
  });
}

for (const [adapterName, setup] of Object.entries({
  JSON() {
    const state = {
      caches: { collectBox: [{ id: "collect-shared", accountId: "account-a" }] },
      stores: [{ id: "store-a", ownerAccountId: "account-a" }],
    };
    let auditWrites = 0;
    return {
      repository: jsonRepository({ state, auditWriter: async () => { auditWrites += 1; } }),
      auditWrites: () => auditWrites,
    };
  },
  PostgreSQL() {
    let auditWrites = 0;
    return {
      repository: createPostgresCollectCategoryResolutionRepository({
        pool: statefulPostgresPool(),
        auditWriter: async () => { auditWrites += 1; },
      }),
      auditWrites: () => auditWrites,
    };
  },
})) {
  test(`${adapterName} does not emit an audit when the domain write fails`, async () => {
    const { repository, auditWrites } = setup();
    await assert.rejects(
      repository.enqueue({ ...queued({ credentialStoreId: "store-b" }), auditEvent: safeAudit() }),
      assertCredentialScopeError,
    );
    assert.equal(auditWrites(), 0);
  });
}

test("JSON real audit append and domain mutation both roll back when persistence fails", async () => {
  const originalAudit = {
    eventId: "existing-audit",
    action: "EXISTING",
    accountId: "account-a",
  };
  const state = {
    caches: { collectBox: [{ id: "collect-shared", accountId: "account-a" }] },
    stores: [{ id: "store-a", ownerAccountId: "account-a" }],
    auditEvents: [originalAudit],
  };
  const repository = jsonRepository({
    state,
    persist: async () => { throw new Error("disk unavailable after audit append"); },
    auditWriter: async ({ state: transactionState, event }) => {
      appendAuditEvent(transactionState, {
        eventId: "resolution-audit",
        action: event.action,
        accountId: event.accountId,
        entityType: "collect-category-resolution",
        entityId: event.collectItemId,
        metadata: event,
        createdAt: START,
      });
    },
  });

  await assert.rejects(
    repository.enqueue({ ...queued(), auditEvent: safeAudit() }),
    /disk unavailable after audit append/,
  );
  assert.equal(await repository.readForItem(queued()), null);
  assert.deepEqual(state.auditEvents, [originalAudit]);
});

for (const [adapterName, createRepository] of Object.entries({
  JSON() {
    return jsonRepository({
      state: {
        caches: { collectBox: [{ id: "collect-shared", accountId: "account-a" }] },
        stores: [{ id: "store-a", ownerAccountId: "account-a" }],
      },
    });
  },
  PostgreSQL() {
    return createPostgresCollectCategoryResolutionRepository({ pool: statefulPostgresPool() });
  },
})) {
  test(`${adapterName} rejects an audited mutation when no transaction audit writer is configured`, async () => {
    const repository = createRepository();
    await assert.rejects(
      repository.enqueue({ ...queued(), auditEvent: safeAudit() }),
      (error) => error?.code === "COLLECT_CATEGORY_RESOLUTION_AUDIT_WRITER_REQUIRED"
        && error?.status === 500,
    );
    assert.equal(await repository.readForItem(queued()), null);
  });
}

test("JSON persistence failure rolls the category resolution mutation back", async () => {
  const state = {
    caches: { collectBox: [{ id: "collect-shared", accountId: "account-a" }] },
    stores: [{ id: "store-a", ownerAccountId: "account-a" }],
  };
  const repository = jsonRepository({
    state,
    persist: async () => { throw new Error("disk unavailable"); },
  });

  await assert.rejects(repository.enqueue(queued()), /disk unavailable/);
  assert.equal(Object.hasOwn(state, "collectCategoryResolutions"), false);
});

test("JSON queued mutations recheck account scope after an account deletion wins the race", async () => {
  const state = {
    caches: { collectBox: [{ id: "collect-shared", accountId: "account-a" }] },
    stores: [{ id: "store-a", ownerAccountId: "account-a" }],
  };
  let releaseFirstPersist;
  let markFirstPersistStarted;
  const firstPersistStarted = new Promise((resolve) => { markFirstPersistStarted = resolve; });
  let persistCount = 0;
  const repository = jsonRepository({
    state,
    persist: async () => {
      persistCount += 1;
      if (persistCount !== 1) return;
      markFirstPersistStarted();
      await new Promise((resolve) => { releaseFirstPersist = resolve; });
    },
  });

  const first = repository.enqueue(queued());
  await firstPersistStarted;
  const raced = repository.enqueue(queued({
    sourceTypeId: 95555,
    taxonomyFingerprint: "taxonomy-v2",
    now: "2026-08-03T10:00:01.000Z",
  }));
  state.caches.collectBox = [];
  state.collectCategoryResolutions = [];
  releaseFirstPersist();
  await first;

  await assert.rejects(
    raced,
    (error) => error?.code === "COLLECT_CATEGORY_RESOLUTION_SCOPE",
  );
  assert.deepEqual(state.collectCategoryResolutions, []);
});

test("JSON reads wait for an in-flight persistence failure instead of exposing phantom state", async () => {
  const state = {
    caches: { collectBox: [{ id: "collect-shared", accountId: "account-a" }] },
    stores: [{ id: "store-a", ownerAccountId: "account-a" }],
  };
  let rejectPersist;
  let markPersistStarted;
  const persistStarted = new Promise((resolve) => { markPersistStarted = resolve; });
  const repository = jsonRepository({
    state,
    persist: async () => {
      markPersistStarted();
      await new Promise((resolve, reject) => { rejectPersist = () => reject(new Error("disk failed")); });
    },
  });

  const enqueue = repository.enqueue(queued());
  await persistStarted;
  let readSettled = false;
  const read = repository.readForItem(queued()).then((value) => {
    readSettled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(readSettled, false);
  rejectPersist();
  await assert.rejects(enqueue, /disk failed/);
  assert.equal(await read, null);
});

test("JSON no-op and stale-fence paths do not persist", async () => {
  const state = {
    caches: { collectBox: [{ id: "collect-shared", accountId: "account-a" }] },
    stores: [{ id: "store-a", ownerAccountId: "account-a" }],
  };
  const setup = jsonRepository({ state });
  const record = await setup.enqueue(queued());
  await setup.claimNext({
    accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "owned-lease",
    leaseExpiresAt: "2026-08-03T10:01:00.000Z", now: START,
  });
  const repository = jsonRepository({
    state,
    persist: async () => { throw new Error("persistence must not run"); },
  });

  assert.equal((await repository.enqueue(queued())).id, record.id);
  assert.equal(await repository.claimNext({
    accountId: "account-b", taxonomyScope: SCOPE, leaseToken: "other-account",
    leaseExpiresAt: "2026-08-03T10:01:00.000Z", now: START,
  }), null);
  assert.equal(await repository.completeNeedsReview({
    accountId: "account-a", id: record.id, leaseToken: "stale-token",
    failureCode: "TYPE_NOT_FOUND", now: "2026-08-03T10:00:01.000Z",
  }), null);
  assert.equal((await repository.readForItem(queued())).status, "MATCHING");
});

test("JSON failed persistence cannot resurrect records removed by concurrent account deletion", async () => {
  const existing = {
    id: "resolution-existing",
    accountId: "account-a",
    collectItemId: "collect-shared",
    taxonomyScope: SCOPE,
    sourceTypeId: 94405,
    targetDescriptionCategoryId: null,
    targetTypeId: null,
    method: null,
    status: "QUEUED",
    taxonomyFingerprint: "taxonomy-v1",
    credentialStoreId: "store-a",
    displayPath: {},
    failureCode: null,
    failureDetailSafe: null,
    attemptCount: 0,
    nextAttemptAt: START,
    leaseToken: null,
    leaseExpiresAt: null,
    matchedAt: null,
    validatedAt: null,
    createdAt: START,
    updatedAt: START,
  };
  const state = {
    accounts: [{ id: "account-a" }],
    caches: { collectBox: [{ id: "collect-shared", accountId: "account-a" }] },
    stores: [{ id: "store-a", ownerAccountId: "account-a" }],
    collectCategoryResolutions: [structuredClone(existing)],
  };
  let rejectPersist;
  let markPersistStarted;
  const persistStarted = new Promise((resolve) => { markPersistStarted = resolve; });
  const repository = jsonRepository({
    state,
    persist: async () => {
      markPersistStarted();
      await new Promise((resolve, reject) => {
        rejectPersist = () => reject(new Error("disk failed after deletion"));
      });
    },
  });

  const claim = repository.claimNext({
    accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "racing-lease",
    leaseExpiresAt: "2026-08-03T10:01:00.000Z", now: START,
  });
  await persistStarted;
  removeAccountScope(state, "account-a", { occurredAt: "2026-08-03T10:00:00.500Z" });
  rejectPersist();

  await assert.rejects(claim, /disk failed after deletion/);
  assert.deepEqual(state.collectCategoryResolutions, []);
});

test("JSON completion rechecks credential-store scope after waiting in the mutation queue", async () => {
  const state = {
    caches: { collectBox: [
      { id: "collect-shared", accountId: "account-a" },
      { id: "collect-b", accountId: "account-b" },
    ] },
    stores: [
      { id: "store-a", ownerAccountId: "account-a" },
      { id: "store-b", ownerAccountId: "account-b" },
    ],
  };
  const setup = jsonRepository({ state });
  const record = await setup.enqueue(queued());
  await setup.claimNext({
    accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "store-race-lease",
    leaseExpiresAt: "2026-08-03T10:01:00.000Z", now: START,
  });

  let releaseFirstPersist;
  let markFirstPersistStarted;
  let persistCount = 0;
  const firstPersistStarted = new Promise((resolve) => { markFirstPersistStarted = resolve; });
  const repository = jsonRepository({
    state,
    persist: async () => {
      persistCount += 1;
      if (persistCount !== 1) return;
      markFirstPersistStarted();
      await new Promise((resolve) => { releaseFirstPersist = resolve; });
    },
  });
  const blocker = repository.enqueue(queued({
    accountId: "account-b",
    collectItemId: "collect-b",
    credentialStoreId: "store-b",
    now: "2026-08-03T10:00:00.500Z",
  }));
  await firstPersistStarted;
  const completion = repository.completeMatched({
    accountId: "account-a", id: record.id, leaseToken: "store-race-lease",
    targetDescriptionCategoryId: 17028702, targetTypeId: 94405,
    method: "TYPE_ID_EXACT", taxonomyFingerprint: "taxonomy-v1",
    credentialStoreId: "store-a", now: "2026-08-03T10:00:01.000Z",
  });
  state.stores = state.stores.filter((store) => store.id !== "store-a");
  releaseFirstPersist();

  await blocker;
  await assert.rejects(completion, assertCredentialScopeError);
  assert.equal((await repository.readForItem(queued())).status, "MATCHING");
});

test("PostgreSQL completion reclassifies a concurrent credential-store loss", async () => {
  const pool = statefulPostgresPool();
  const repository = createPostgresCollectCategoryResolutionRepository({ pool });
  const record = await repository.enqueue(queued());
  await repository.claimNext({
    accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "store-race-lease",
    leaseExpiresAt: "2026-08-03T10:01:00.000Z", now: START,
  });
  pool.invalidateCredentialStoreBeforeNextMatchedWrite("account-a", "store-a");

  await assert.rejects(repository.completeMatched({
    accountId: "account-a", id: record.id, leaseToken: "store-race-lease",
    targetDescriptionCategoryId: 17028702, targetTypeId: 94405,
    method: "TYPE_ID_EXACT", taxonomyFingerprint: "taxonomy-v1",
    credentialStoreId: "store-a", now: "2026-08-03T10:00:01.000Z",
  }), assertCredentialScopeError);
  assert.equal((await repository.readForItem(queued())).status, "MATCHING");
});

test("PostgreSQL reclassifies only credential-store foreign-key races", async (t) => {
  const credentialConstraint = "collect_category_resolutions_credential_store_id_fkey";

  await t.test("enqueue", async () => {
    const pool = statefulPostgresPool();
    const repository = createPostgresCollectCategoryResolutionRepository({ pool });
    pool.failNextForeignKey("enqueue", credentialConstraint);
    await assert.rejects(repository.enqueue(queued()), assertCredentialScopeError);
  });

  await t.test("saveManual", async () => {
    const pool = statefulPostgresPool();
    const repository = createPostgresCollectCategoryResolutionRepository({ pool });
    pool.failNextForeignKey("saveManual", credentialConstraint);
    await assert.rejects(repository.saveManual({
      ...queued(),
      targetDescriptionCategoryId: 17028702,
      targetTypeId: 94405,
    }), assertCredentialScopeError);
  });

  await t.test("completeMatched", async () => {
    const pool = statefulPostgresPool();
    const repository = createPostgresCollectCategoryResolutionRepository({ pool });
    const record = await repository.enqueue(queued());
    await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "fk-race-lease",
      leaseExpiresAt: "2026-08-03T10:01:00.000Z", now: START,
    });
    pool.failNextForeignKey("completeMatched", credentialConstraint);
    await assert.rejects(repository.completeMatched({
      accountId: "account-a", id: record.id, leaseToken: "fk-race-lease",
      targetDescriptionCategoryId: 17028702, targetTypeId: 94405,
      method: "TYPE_ID_EXACT", taxonomyFingerprint: "taxonomy-v1",
      credentialStoreId: "store-a", now: "2026-08-03T10:00:01.000Z",
    }), assertCredentialScopeError);
  });

  await t.test("unrelated constraint remains a safe persistence error", async () => {
    const pool = statefulPostgresPool();
    const repository = createPostgresCollectCategoryResolutionRepository({ pool });
    pool.failNextForeignKey(
      "enqueue",
      "collect_category_resolutions_collect_item_id_fkey",
    );
    await assert.rejects(repository.enqueue(queued()), (error) => {
      assert.deepEqual({
        code: error?.code,
        status: error?.status,
        message: error?.message,
      }, {
        code: "COLLECT_CATEGORY_RESOLUTION_PERSISTENCE_FAILED",
        status: 500,
        message: "Collect category resolution PostgreSQL operation failed",
      });
      assert.equal(String(error?.message).includes("sensitive"), false);
      return true;
    });
  });
});

test("shared JSON transaction makes account deletion the final durable write", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-category-resolution-order-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const dataFile = path.join(dataDir, "local-state.json");
  const state = {
    accounts: [{ id: "account-a" }],
    caches: { collectBox: [{ id: "collect-shared", accountId: "account-a" }] },
    stores: [{ id: "store-a", ownerAccountId: "account-a" }],
    collectCategoryResolutions: [],
  };
  await savePersistedState({ dataDir, dataFile, state });
  const stateTransaction = createJsonStateTransactionBoundary({ enabled: () => true });
  let releaseOldWrite;
  let markOldSnapshotCaptured;
  const oldSnapshotCaptured = new Promise((resolve) => { markOldSnapshotCaptured = resolve; });
  const repository = jsonRepository({
    state,
    stateTransaction,
    persist: async (nextState) => {
      const captured = structuredClone(nextState);
      markOldSnapshotCaptured();
      await new Promise((resolve) => { releaseOldWrite = resolve; });
      await savePersistedState({ dataDir, dataFile, state: captured });
    },
  });

  const categoryWrite = repository.enqueue(queued());
  await oldSnapshotCaptured;
  let markDeletionEntered;
  const deletionEntered = new Promise((resolve) => { markDeletionEntered = resolve; });
  const accountDeletion = stateTransaction.run(async () => {
    markDeletionEntered();
    removeAccountScope(state, "account-a", { occurredAt: "2026-08-03T10:00:01.000Z" });
    await savePersistedState({ dataDir, dataFile, state });
  });

  const deletionCouldOvertake = await Promise.race([
    deletionEntered.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);
  if (deletionCouldOvertake) await accountDeletion;
  releaseOldWrite();
  await categoryWrite;
  await accountDeletion;

  const reloaded = JSON.parse(await readFile(dataFile, "utf8"));
  assert.deepEqual(state.accounts, []);
  assert.deepEqual(state.collectCategoryResolutions, []);
  assert.deepEqual(reloaded.accounts, []);
  assert.deepEqual(reloaded.collectCategoryResolutions, []);
});
