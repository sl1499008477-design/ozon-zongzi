import assert from "node:assert/strict";
import test from "node:test";
import {
  createJsonCollectorOzonEnrichmentRepository,
  createPostgresCollectorOzonEnrichmentRepository,
} from "../collector-ozon-enrichment-repository.mjs";

const ACCOUNT_A_KEY = Object.freeze({
  accountId: "account-a",
  source: "ozon",
  sku: "4862904234",
  contractVersion: "ozon-enrichment-v1",
});
const ACCOUNT_B_KEY = Object.freeze({
  accountId: "account-b",
  source: "ozon",
  sku: "4862904234",
  contractVersion: "ozon-enrichment-v1",
});

function completeResult(descriptionCategoryId) {
  return {
    status: "COMPLETE",
    descriptionCategoryId,
    logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
  };
}

test("JSON cache keeps equal SKUs isolated by account and honors complete and negative TTLs", async () => {
  const state = {};
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  await repository.writeCompleteCache({
    key: ACCOUNT_A_KEY,
    result: completeResult(101),
    responseHash: "complete-a-hash",
    executorSessionId: "collector-a",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T06:00:00.000Z"),
  });
  await repository.writeCompleteCache({
    key: ACCOUNT_B_KEY,
    result: completeResult(202),
    responseHash: "complete-b-hash",
    executorSessionId: "collector-b",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T06:00:00.000Z"),
  });

  const accountAHit = await repository.readCache({
    key: ACCOUNT_A_KEY,
    now: new Date("2026-07-31T05:59:59.999Z"),
  });
  const accountBHit = await repository.readCache({
    key: ACCOUNT_B_KEY,
    now: new Date("2026-07-31T05:59:59.999Z"),
  });
  assert.equal(accountAHit.result.descriptionCategoryId, 101);
  assert.equal(accountBHit.result.descriptionCategoryId, 202);
  assert.equal(await repository.readCache({
    key: ACCOUNT_A_KEY,
    now: new Date("2026-07-31T06:00:00.000Z"),
  }), null);
  assert.equal((await repository.readCache({
    key: ACCOUNT_A_KEY,
    now: new Date("2026-07-31T06:00:00.000Z"),
    includeExpired: true,
  })).status, "COMPLETE");

  await repository.writeNegativeCache({
    key: ACCOUNT_A_KEY,
    error: { code: "OZON_PRODUCT_NOT_FOUND", message: "not found" },
    responseHash: "negative-a-hash",
    capturedAt: new Date("2026-07-31T07:00:00.000Z"),
    expiresAt: new Date("2026-07-31T07:01:00.000Z"),
  });
  assert.equal((await repository.readCache({
    key: ACCOUNT_A_KEY,
    now: new Date("2026-07-31T07:00:59.999Z"),
  })).error.code, "OZON_PRODUCT_NOT_FOUND");
  assert.equal(await repository.readCache({
    key: ACCOUNT_A_KEY,
    now: new Date("2026-07-31T07:01:00.000Z"),
  }), null);
});

test("JSON cache lease has one owner and permits takeover only after expiry", async () => {
  const repository = createJsonCollectorOzonEnrichmentRepository({ state: {} });
  const first = await repository.tryAcquireCacheLease({
    key: ACCOUNT_A_KEY,
    leaseOwner: "owner-a",
    leaseExpiresAt: new Date("2026-07-31T00:01:00.000Z"),
    now: new Date("2026-07-31T00:00:00.000Z"),
  });
  const contended = await repository.tryAcquireCacheLease({
    key: ACCOUNT_A_KEY,
    leaseOwner: "owner-b",
    leaseExpiresAt: new Date("2026-07-31T00:01:30.000Z"),
    now: new Date("2026-07-31T00:00:30.000Z"),
  });
  const renewed = await repository.tryAcquireCacheLease({
    key: ACCOUNT_A_KEY,
    leaseOwner: "owner-a",
    leaseExpiresAt: new Date("2026-07-31T00:02:00.000Z"),
    now: new Date("2026-07-31T00:00:30.000Z"),
  });
  const takeover = await repository.tryAcquireCacheLease({
    key: ACCOUNT_A_KEY,
    leaseOwner: "owner-b",
    leaseExpiresAt: new Date("2026-07-31T00:03:00.000Z"),
    now: new Date("2026-07-31T00:02:00.000Z"),
  });

  assert.equal(first.leaseOwner, "owner-a");
  assert.equal(contended, null);
  assert.equal(renewed.leaseOwner, "owner-a");
  assert.equal(takeover.leaseOwner, "owner-b");
  assert.equal(await repository.releaseCacheLease({
    key: ACCOUNT_A_KEY,
    leaseOwner: "owner-a",
  }), false);
  assert.equal(await repository.releaseCacheLease({
    key: ACCOUNT_A_KEY,
    leaseOwner: "owner-b",
  }), true);
});

test("JSON job creation is stable and claims at most four unexpired jobs per account", async () => {
  const repository = createJsonCollectorOzonEnrichmentRepository({ state: {} });
  const created = await repository.createOrGetJob({
    id: "job-a-1",
    accountId: "account-a",
    requestId: "request-shared",
    sku: "sku-1",
    preferredSessionId: null,
    refreshBundle: { reason: "first" },
    deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  });
  const duplicate = await repository.createOrGetJob({
    id: "job-a-replacement",
    accountId: "account-a",
    requestId: "request-shared",
    sku: "sku-1",
    preferredSessionId: "collector-later",
    refreshBundle: { reason: "replacement" },
    deadlineAt: new Date("2026-07-31T02:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:30:00.000Z"),
  });
  assert.equal(created.id, "job-a-1");
  assert.deepEqual(duplicate, created);

  for (let index = 2; index <= 5; index += 1) {
    await repository.createOrGetJob({
      id: `job-a-${index}`,
      accountId: "account-a",
      requestId: `request-${index}`,
      sku: `sku-${index}`,
      preferredSessionId: null,
      refreshBundle: { ordinal: index },
      deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
      createdAt: new Date(`2026-07-31T00:00:0${index}.000Z`),
    });
  }
  await repository.createOrGetJob({
    id: "job-b-1",
    accountId: "account-b",
    requestId: "request-2",
    sku: "sku-2",
    preferredSessionId: null,
    refreshBundle: { ordinal: 1 },
    deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:00:01.000Z"),
  });

  const claimedA = [];
  for (let index = 1; index <= 5; index += 1) {
    claimedA.push(await repository.claimNextJob({
      accountId: "account-a",
      collectorSessionId: `collector-a-${index}`,
      now: new Date("2026-07-31T00:10:00.000Z"),
      claimExpiresAt: new Date("2026-07-31T00:20:00.000Z"),
    }));
  }
  const claimedB = await repository.claimNextJob({
    accountId: "account-b",
    collectorSessionId: "collector-b-1",
    now: new Date("2026-07-31T00:10:00.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:20:00.000Z"),
  });
  assert.equal(claimedA.filter(Boolean).length, 4);
  assert.equal(claimedA[4], null);
  assert.equal(claimedB.accountId, "account-b");
});

test("JSON job results require the owning session and terminal jobs are immutable", async () => {
  const repository = createJsonCollectorOzonEnrichmentRepository({ state: {} });
  await repository.createOrGetJob({
    id: "job-success",
    accountId: "account-a",
    requestId: "request-success",
    sku: "sku-success",
    preferredSessionId: null,
    refreshBundle: { reason: "refresh" },
    deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  });
  await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-owner",
    now: new Date("2026-07-31T00:10:00.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:20:00.000Z"),
  });

  await assert.rejects(
    repository.completeJob({
      accountId: "account-a",
      collectorSessionId: "collector-attacker",
      jobId: "job-success",
      result: completeResult(303),
      now: new Date("2026-07-31T00:11:00.000Z"),
    }),
    (error) => error?.code === "OZON_ENRICHMENT_JOB_OWNERSHIP",
  );
  await assert.rejects(
    repository.failJob({
      accountId: "account-a",
      collectorSessionId: "collector-attacker",
      jobId: "job-success",
      error: { code: "ATTACKER_ERROR" },
      now: new Date("2026-07-31T00:11:00.000Z"),
    }),
    (error) => error?.code === "OZON_ENRICHMENT_JOB_OWNERSHIP",
  );
  const succeeded = await repository.completeJob({
    accountId: "account-a",
    collectorSessionId: "collector-owner",
    jobId: "job-success",
    result: completeResult(303),
    now: new Date("2026-07-31T00:12:00.000Z"),
  });
  assert.equal(succeeded.status, "SUCCESS");
  assert.equal(succeeded.result.descriptionCategoryId, 303);

  await assert.rejects(
    repository.failJob({
      accountId: "account-a",
      collectorSessionId: "collector-owner",
      jobId: "job-success",
      error: { code: "LATE_ERROR" },
      now: new Date("2026-07-31T00:13:00.000Z"),
    }),
    (error) => error?.code === "OZON_ENRICHMENT_JOB_TERMINAL",
  );
  assert.deepEqual(await repository.readJob({
    accountId: "account-a",
    jobId: "job-success",
  }), succeeded);
  assert.equal(await repository.readJob({
    accountId: "account-b",
    jobId: "job-success",
  }), null);
});

test("JSON mutations serialize persistence and restore state when persistence fails", async () => {
  const state = {};
  let activePersists = 0;
  let maximumActivePersists = 0;
  const snapshots = [];
  const repository = createJsonCollectorOzonEnrichmentRepository({
    state,
    persist: async (savedState) => {
      activePersists += 1;
      maximumActivePersists = Math.max(maximumActivePersists, activePersists);
      await new Promise((resolve) => setTimeout(resolve, 5));
      snapshots.push(structuredClone(savedState.collectorOzonEnrichmentCache));
      activePersists -= 1;
    },
  });
  await Promise.all([
    repository.writeNegativeCache({
      key: ACCOUNT_A_KEY,
      error: { code: "A" },
      responseHash: "a",
      capturedAt: new Date("2026-07-31T00:00:00.000Z"),
      expiresAt: new Date("2026-07-31T00:01:00.000Z"),
    }),
    repository.writeNegativeCache({
      key: ACCOUNT_B_KEY,
      error: { code: "B" },
      responseHash: "b",
      capturedAt: new Date("2026-07-31T00:00:00.000Z"),
      expiresAt: new Date("2026-07-31T00:01:00.000Z"),
    }),
  ]);
  assert.equal(maximumActivePersists, 1);
  assert.equal(snapshots[0].length, 1);
  assert.equal(snapshots[1].length, 2);

  const failingState = {};
  const failingRepository = createJsonCollectorOzonEnrichmentRepository({
    state: failingState,
    persist: async () => { throw new Error("disk full"); },
  });
  await assert.rejects(failingRepository.writeNegativeCache({
    key: ACCOUNT_A_KEY,
    error: { code: "A" },
    responseHash: "a",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T00:01:00.000Z"),
  }));
  assert.equal(Object.hasOwn(failingState, "collectorOzonEnrichmentCache"), false);
});

test("JSON rejects Collector sessions from another account for writes and claims", async () => {
  const repository = createJsonCollectorOzonEnrichmentRepository({
    state: {
      collectorSessions: [
        { id: "collector-a", accountId: "account-a" },
        { id: "collector-b", accountId: "account-b" },
      ],
    },
  });
  await assert.rejects(repository.writeCompleteCache({
    key: ACCOUNT_A_KEY,
    result: completeResult(505),
    responseHash: "cross-account-hash",
    executorSessionId: "collector-b",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T06:00:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_SESSION_SCOPE");

  await repository.createOrGetJob({
    id: "job-a",
    accountId: "account-a",
    requestId: "request-a",
    sku: "sku-a",
    preferredSessionId: null,
    refreshBundle: {},
    deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  });
  await assert.rejects(repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-b",
    now: new Date("2026-07-31T00:10:00.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:20:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_SESSION_SCOPE");
});

test("PostgreSQL cache lease acquisition is one atomic account-scoped upsert", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
      return { rows: [{
        account_id: "account-a",
        source: "ozon",
        sku: "4862904234",
        contract_version: "ozon-enrichment-v1",
        lease_owner: "owner-a",
        lease_expires_at: "2026-07-31T00:01:00.000Z",
      }] };
    },
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({ pool });
  const acquired = await repository.tryAcquireCacheLease({
    key: ACCOUNT_A_KEY,
    leaseOwner: "owner-a",
    leaseExpiresAt: new Date("2026-07-31T00:01:00.000Z"),
    now: new Date("2026-07-31T00:00:00.000Z"),
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO collector_ozon_enrichment_cache/);
  assert.match(calls[0].sql, /ON CONFLICT \(account_id, source, sku, contract_version\) DO UPDATE/);
  assert.match(calls[0].sql, /lease_expires_at <= EXCLUDED\.updated_at OR collector_ozon_enrichment_cache\.lease_owner = EXCLUDED\.lease_owner/);
  assert.match(calls[0].sql, /RETURNING account_id, source, sku, contract_version, lease_owner, lease_expires_at/);
  assert.deepEqual(calls[0].params.slice(0, 4), [
    "account-a", "ozon", "4862904234", "ozon-enrichment-v1",
  ]);
  assert.equal(acquired.leaseOwner, "owner-a");
});

test("PostgreSQL cache writes keep a finite reacquisition sentinel and scope executor session", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
      return { rows: [{
        account_id: "account-a",
        source: "ozon",
        sku: "4862904234",
        contract_version: "ozon-enrichment-v1",
        status: "COMPLETE",
        result_json: completeResult(606),
      }], rowCount: 1 };
    },
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({ pool });
  await repository.writeCompleteCache({
    key: ACCOUNT_A_KEY,
    result: completeResult(606),
    responseHash: "complete-hash",
    executorSessionId: "collector-a",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T06:00:00.000Z"),
  });
  await repository.releaseCacheLease({ key: ACCOUNT_A_KEY, leaseOwner: "owner-a" });

  assert.match(calls[0].sql, /FROM collector_sessions/);
  assert.match(calls[0].sql, /account_id=\$1/);
  assert.match(calls[0].sql, /id=\$7/);
  assert.match(calls[0].sql, /revoked_at IS NULL/);
  assert.match(calls[0].sql, /expires_at>\$8/);
  assert.match(calls[0].sql, /lease_expires_at/);
  assert.match(calls[0].sql, /'-infinity'/);
  assert.match(calls[1].sql, /lease_expires_at='-infinity'/);
});

test("PostgreSQL job claim locks the account transaction and enforces the four-job limit", async () => {
  const calls = [];
  let processingCount = "3";
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT COUNT(*)")) return { rows: [{ count: processingCount }] };
      if (normalized.includes("FOR UPDATE SKIP LOCKED")) {
        return { rows: [{
          id: "job-a",
          account_id: "account-a",
          request_id: "request-a",
          sku: "sku-a",
          status: "PROCESSING",
          refresh_bundle: { reason: "refresh" },
          claimed_session_id: "collector-a",
          claim_expires_at: "2026-07-31T00:20:00.000Z",
          deadline_at: "2026-07-31T01:00:00.000Z",
          created_at: "2026-07-31T00:00:00.000Z",
          updated_at: "2026-07-31T00:10:00.000Z",
        }] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { async connect() { return client; }, async query() { return { rows: [] }; } };
  const repository = createPostgresCollectorOzonEnrichmentRepository({ pool });

  const claimed = await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: new Date("2026-07-31T00:10:00.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:20:00.000Z"),
  });
  assert.equal(claimed.id, "job-a");
  assert.equal(calls[0].sql, "BEGIN");
  assert.match(calls[1].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[1].params, ["account-a"]);
  assert.match(calls[2].sql, /status='PROCESSING'/);
  assert.match(calls[2].sql, /claim_expires_at>/);
  assert.match(calls[3].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(calls[3].sql, /account_id=\$1/);
  assert.match(calls[3].sql, /claimed_session_id=\$2/);
  assert.match(calls[3].sql, /session\.revoked_at IS NULL/);
  assert.match(calls[3].sql, /session\.expires_at>\$3/);
  assert.equal(calls.at(-1).sql, "COMMIT");

  calls.length = 0;
  processingCount = "4";
  assert.equal(await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-fifth",
    now: new Date("2026-07-31T00:10:00.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:20:00.000Z"),
  }), null);
  assert.equal(calls.some((call) => call.sql.includes("FOR UPDATE SKIP LOCKED")), false);
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("PostgreSQL job creation scopes a preferred Collector session to the account", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
      return { rows: [{
        id: "job-a",
        account_id: "account-a",
        request_id: "request-a",
        sku: "sku-a",
        status: "PENDING",
        refresh_bundle: {},
        preferred_session_id: "collector-a",
        deadline_at: "2026-07-31T01:00:00.000Z",
        created_at: "2026-07-31T00:00:00.000Z",
        updated_at: "2026-07-31T00:00:00.000Z",
      }] };
    },
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({ pool });
  await repository.createOrGetJob({
    id: "job-a",
    accountId: "account-a",
    requestId: "request-a",
    sku: "sku-a",
    preferredSessionId: "collector-a",
    refreshBundle: {},
    deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  });

  assert.match(calls[0].sql, /FROM accounts AS account/);
  assert.match(calls[0].sql, /LEFT JOIN collector_sessions AS preferred/);
  assert.match(calls[0].sql, /preferred\.account_id=\$2/);
  assert.match(calls[0].sql, /preferred\.revoked_at IS NULL/);
});

test("PostgreSQL terminal writes include account, owning session, processing state, and live claim", async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("UPDATE collector_ozon_enrichment_jobs")) {
        return { rows: [{
          id: "job-a",
          account_id: "account-a",
          request_id: "request-a",
          sku: "sku-a",
          status: normalized.includes("status='SUCCESS'") ? "SUCCESS" : "FAILED",
          refresh_bundle: {},
          claimed_session_id: "collector-owner",
          result_json: normalized.includes("status='SUCCESS'") ? completeResult(404) : null,
          error_json: normalized.includes("status='FAILED'") ? { code: "FAILED" } : null,
          deadline_at: "2026-07-31T01:00:00.000Z",
          created_at: "2026-07-31T00:00:00.000Z",
          updated_at: "2026-07-31T00:11:00.000Z",
          completed_at: "2026-07-31T00:11:00.000Z",
        }] };
      }
      return { rows: [] };
    },
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({ pool });
  await repository.completeJob({
    accountId: "account-a",
    collectorSessionId: "collector-owner",
    jobId: "job-a",
    result: completeResult(404),
    now: new Date("2026-07-31T00:11:00.000Z"),
  });
  await repository.failJob({
    accountId: "account-a",
    collectorSessionId: "collector-owner",
    jobId: "job-b",
    error: { code: "FAILED" },
    now: new Date("2026-07-31T00:11:00.000Z"),
  });

  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.match(call.sql, /account_id=\$1/);
    assert.match(call.sql, /claimed_session_id=\$2/);
    assert.match(call.sql, /id=\$3/);
    assert.match(call.sql, /status='PROCESSING'/);
    assert.match(call.sql, /claim_expires_at>\$4/);
    assert.match(call.sql, /EXISTS \(SELECT 1 FROM collector_sessions AS session/);
    assert.match(call.sql, /session\.revoked_at IS NULL/);
    assert.match(call.sql, /session\.expires_at>\$4/);
    assert.deepEqual(call.params.slice(0, 4), [
      "account-a",
      "collector-owner",
      index === 0 ? "job-a" : "job-b",
      new Date("2026-07-31T00:11:00.000Z"),
    ]);
  }
});
