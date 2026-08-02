import assert from "node:assert/strict";
import test from "node:test";
import {
  createJsonCollectCategoryResolutionRepository,
  createPostgresCollectCategoryResolutionRepository,
} from "../collect-category-resolution-repository.mjs";

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
  const collectItems = new Set(["account-a:collect-shared", "account-b:collect-b"]);
  const stores = new Set(["account-a:store-a", "account-b:store-b"]);

  function matchesFence(row, [accountId, id, leaseToken]) {
    return row.account_id === accountId && row.id === id && row.lease_token === leaseToken;
  }

  async function query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [], rowCount: 0 };

    if (normalized.startsWith("SELECT ( EXISTS (") && normalized.endsWith("AS scope_valid")) {
      const [accountId, collectItemId, credentialStoreId] = params;
      const scopeValid = collectItems.has(`${accountId}:${collectItemId}`)
        && (!credentialStoreId || stores.has(`${accountId}:${credentialStoreId}`));
      return { rows: [{ scope_valid: scopeValid }], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO collect_category_resolutions AS current")) {
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
        .filter((row) => row.account_id === accountId
          && (!taxonomyScope || row.taxonomy_scope === taxonomyScope)
          && row.method !== "MANUAL"
          && new Date(row.next_attempt_at).getTime() <= nowMs
          && (["QUEUED", "RETRYABLE_ERROR", "INVALIDATED"].includes(row.status)
            || (row.status === "MATCHING"
              && new Date(row.lease_expires_at || 0).getTime() <= nowMs)))
        .sort((left, right) => left.next_attempt_at.localeCompare(right.next_attempt_at))[0];
      if (!found) return { rows: [], rowCount: 0 };
      Object.assign(found, {
        status: "MATCHING",
        lease_token: leaseToken,
        lease_expires_at: iso(leaseExpiresAt),
        attempt_count: found.attempt_count + 1,
        updated_at: iso(now),
      });
      return { rows: [rowCopy(found)], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE collect_category_resolutions SET status='MATCHED'")) {
      const row = rows.find((candidate) => matchesFence(candidate, params));
      if (!row || row.status !== "MATCHING" || row.method === "MANUAL"
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
        && new Date(row.lease_expires_at).getTime() <= new Date(params[6]).getTime())) {
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

    if (normalized.startsWith("INSERT INTO collect_category_resolutions AS current") === false
      && normalized.startsWith("INSERT INTO collect_category_resolutions")) {
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
    async connect() {
      return { query, release() {} };
    },
  };
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
    return createJsonCollectCategoryResolutionRepository({ state });
  },
  PostgreSQL() {
    return createPostgresCollectCategoryResolutionRepository({ pool: statefulPostgresPool() });
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
      (error) => error?.code === "COLLECT_CATEGORY_RESOLUTION_SCOPE",
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
      failureCode: "MANUAL_TARGET_DISABLED", now: "2026-08-03T10:00:13.000Z",
    });
    assert.equal(await repository.claimNext({
      accountId: "account-a", taxonomyScope: SCOPE, leaseToken: "automatic-retry",
      leaseExpiresAt: "2026-08-03T10:02:00.000Z", now: "2026-08-03T10:00:13.000Z",
    }), null);
    const invalidManual = await repository.readForItem(queued());
    assert.equal(invalidManual.status, "INVALIDATED");
    assert.equal(invalidManual.method, "MANUAL");
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
}

test("JSON persistence failure rolls the category resolution mutation back", async () => {
  const state = {
    caches: { collectBox: [{ id: "collect-shared", accountId: "account-a" }] },
    stores: [{ id: "store-a", ownerAccountId: "account-a" }],
  };
  const repository = createJsonCollectCategoryResolutionRepository({
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
  const repository = createJsonCollectCategoryResolutionRepository({
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
  const repository = createJsonCollectCategoryResolutionRepository({
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
