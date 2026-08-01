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

function activeSession(id, accountId, overrides = {}) {
  return {
    id,
    accountId,
    expiresAt: "2026-08-01T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function collectItem(id, accountId) {
  return { id, accountId };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("JSON cache keeps equal SKUs isolated by account and honors complete and negative TTLs", async () => {
  const state = {
    collectorSessions: [
      activeSession("collector-a", "account-a"),
      activeSession("collector-b", "account-b"),
    ],
  };
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

test("JSON cache lease admission counts unique live owners per account", async () => {
  const repository = createJsonCollectorOzonEnrichmentRepository({ state: {} });
  const at = new Date("2026-07-31T00:00:00.000Z");
  for (let index = 0; index < 4; index += 1) {
    await repository.tryAcquireCacheLease({
      key: { ...ACCOUNT_A_KEY, sku: `sku-capacity-${index}` },
      leaseOwner: `owner-${index}`,
      leaseExpiresAt: new Date("2026-07-31T00:01:00.000Z"),
      now: at,
      maxActiveLeases: 4,
    });
  }
  assert.equal(await repository.tryAcquireCacheLease({
    key: { ...ACCOUNT_A_KEY, sku: "sku-capacity-0" },
    leaseOwner: "same-key-follower",
    leaseExpiresAt: new Date("2026-07-31T00:01:00.000Z"),
    now: at,
    maxActiveLeases: 4,
  }), null);
  await assert.rejects(repository.tryAcquireCacheLease({
    key: { ...ACCOUNT_A_KEY, sku: "sku-capacity-fifth" },
    leaseOwner: "owner-fifth",
    leaseExpiresAt: new Date("2026-07-31T00:01:00.000Z"),
    now: at,
    maxActiveLeases: 4,
  }), (error) => error?.status === 429 && error?.code === "OZON_ENRICH_BUSY");
});

test("JSON job creation is stable and claims at most four unexpired jobs per account", async () => {
  const state = {
    collectorSessions: [
      ...Array.from({ length: 5 }, (_, index) =>
        activeSession(`collector-a-${index + 1}`, "account-a")),
      activeSession("collector-b-1", "account-b"),
      activeSession("collector-later", "account-a"),
    ],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
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

test("preferred claim is exclusive for one second then falls back only within the same account", async () => {
  const state = {
    collectorSessions: [
      activeSession("collector-preferred", "account-a"),
      activeSession("collector-fallback", "account-a"),
      activeSession("collector-other-account", "account-b"),
    ],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  await repository.createOrGetJob({
    id: "job-preferred-window",
    accountId: "account-a",
    requestId: "request-preferred-window",
    sku: "sku-preferred-window",
    preferredSessionId: "collector-preferred",
    refreshBundle: true,
    deadlineAt: new Date("2026-07-31T00:00:20.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  });

  assert.equal(await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-fallback",
    now: new Date("2026-07-31T00:00:00.999Z"),
    claimExpiresAt: new Date("2026-07-31T00:00:05.999Z"),
  }), null);
  await assert.rejects(repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-other-account",
    now: new Date("2026-07-31T00:00:01.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:00:06.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_SESSION_SCOPE");
  const fallback = await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-fallback",
    now: new Date("2026-07-31T00:00:01.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:00:06.000Z"),
  });
  assert.equal(fallback.id, "job-preferred-window");
  assert.equal(fallback.claimedSessionId, "collector-fallback");
});

test("JSON claim prioritizes the polling session preferred job before older general work", async () => {
  const state = { collectorSessions: [activeSession("collector-preferred", "account-a")] };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  await repository.createOrGetJob({
    id: "job-general-older",
    accountId: "account-a",
    requestId: "request-general-older",
    sku: "sku-general-older",
    preferredSessionId: null,
    refreshBundle: true,
    deadlineAt: new Date("2026-07-31T00:01:00.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  });
  await repository.createOrGetJob({
    id: "job-preferred-newer",
    accountId: "account-a",
    requestId: "request-preferred-newer",
    sku: "sku-preferred-newer",
    preferredSessionId: "collector-preferred",
    refreshBundle: true,
    deadlineAt: new Date("2026-07-31T00:01:00.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.100Z"),
  });
  const claimed = await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-preferred",
    now: new Date("2026-07-31T00:00:00.200Z"),
    claimExpiresAt: new Date("2026-07-31T00:00:05.200Z"),
  });
  assert.equal(claimed.id, "job-preferred-newer");
});

test("JSON drops an expired cached executor preference instead of blocking a new job", async () => {
  const state = {
    collectorSessions: [activeSession("collector-expired", "account-a", {
      expiresAt: "2026-07-30T23:59:59.999Z",
    })],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const created = await repository.createOrGetJob({
    id: "job-optional-preference",
    accountId: "account-a",
    requestId: "request-optional-preference",
    sku: "sku-optional-preference",
    preferredSessionId: "collector-expired",
    refreshBundle: true,
    deadlineAt: new Date("2026-07-31T00:00:20.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  });
  assert.equal(created.preferredSessionId, null);
});

test("JSON atomic terminal write rejects a lost claim without publishing cache", async () => {
  const state = {
    collectorSessions: [
      activeSession("collector-old", "account-a"),
      activeSession("collector-new", "account-a"),
    ],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  await repository.createOrGetJob({
    id: "job-atomic-lost-claim",
    accountId: "account-a",
    requestId: "request-atomic-lost-claim",
    sku: "sku-atomic-lost-claim",
    preferredSessionId: null,
    refreshBundle: true,
    deadlineAt: new Date("2026-07-31T00:00:20.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  });
  await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-old",
    now: new Date("2026-07-31T00:00:00.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:00:05.000Z"),
  });
  await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-new",
    now: new Date("2026-07-31T00:00:05.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:00:10.000Z"),
  });
  await assert.rejects(repository.completeJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-old",
    jobId: "job-atomic-lost-claim",
    key: ACCOUNT_A_KEY,
    result: completeResult(919),
    responseHash: "lost-claim-hash",
    capturedAt: new Date("2026-07-31T00:00:05.001Z"),
    expiresAt: new Date("2026-07-31T06:00:05.001Z"),
    now: new Date("2026-07-31T00:00:05.001Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_JOB_OWNERSHIP");
  assert.equal(await repository.readCache({
    key: ACCOUNT_A_KEY,
    now: new Date("2026-07-31T00:00:05.001Z"),
    includeExpired: true,
  }), null);
  assert.equal((await repository.readJob({
    accountId: "account-a",
    jobId: "job-atomic-lost-claim",
  })).claimedSessionId, "collector-new");
});

test("JSON atomic terminal persistence failure rolls back both job and cache", async () => {
  const state = {
    collectorSessions: [activeSession("collector-owner", "account-a")],
    collectorOzonEnrichmentJobs: [{
      id: "job-atomic-rollback",
      accountId: "account-a",
      requestId: "request-atomic-rollback",
      sku: ACCOUNT_A_KEY.sku,
      status: "PROCESSING",
      preferredSessionId: null,
      claimedSessionId: "collector-owner",
      claimExpiresAt: "2026-07-31T00:00:10.000Z",
      refreshBundle: true,
      deadlineAt: "2026-07-31T00:00:20.000Z",
      result: null,
      error: null,
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      completedAt: null,
    }],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({
    state,
    persist: async () => { throw new Error("disk full"); },
  });
  await assert.rejects(repository.failJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-owner",
    jobId: "job-atomic-rollback",
    key: ACCOUNT_A_KEY,
    error: { status: 502, code: "OZON_ENRICH_UPSTREAM_FAILED" },
    responseHash: "atomic-rollback-hash",
    capturedAt: new Date("2026-07-31T00:00:01.000Z"),
    expiresAt: new Date("2026-07-31T00:01:01.000Z"),
    now: new Date("2026-07-31T00:00:01.000Z"),
  }));
  assert.equal(state.collectorOzonEnrichmentJobs[0].status, "PROCESSING");
  assert.equal(state.collectorOzonEnrichmentCache, undefined);
});

test("JSON create-or-get returns the stable job before validating a changed preferred session", async () => {
  const state = {
    collectorSessions: [activeSession("collector-preferred", "account-a")],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const created = await repository.createOrGetJob({
    id: "job-stable",
    accountId: "account-a",
    requestId: "request-stable",
    sku: "sku-stable",
    preferredSessionId: "collector-preferred",
    refreshBundle: { revision: 1 },
    deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  });
  state.collectorSessions[0].revokedAt = "2026-07-31T00:05:00.000Z";

  const retried = await repository.createOrGetJob({
    id: "job-retry-ignored",
    accountId: "account-a",
    requestId: "request-stable",
    sku: "sku-stable",
    preferredSessionId: "collector-preferred",
    refreshBundle: { revision: 2 },
    deadlineAt: new Date("2026-07-31T02:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:10:00.000Z"),
  });

  assert.deepEqual(retried, created);
});

test("JSON create-or-get atomically requeues only an expired nonterminal stable job", async () => {
  const state = {
    collectorSessions: [
      activeSession("collector-original", "account-a"),
      activeSession("collector-retry", "account-a"),
    ],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  await repository.createOrGetJob({
    id: "job-expired-stable",
    accountId: "account-a",
    requestId: "request-expired-stable",
    sku: "sku-expired-stable",
    preferredSessionId: "collector-original",
    refreshBundle: false,
    deadlineAt: new Date("2026-07-31T00:00:20.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  });
  await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-original",
    now: new Date("2026-07-31T00:00:00.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:00:05.000Z"),
  });
  await repository.deferClaim({
    accountId: "account-a",
    collectorSessionId: "collector-original",
    jobId: "job-expired-stable",
    error: { code: "OZON_RETRYABLE", status: 503 },
    now: new Date("2026-07-31T00:00:01.000Z"),
  });

  const retried = await repository.createOrGetJob({
    id: "job-new-id-must-not-replace-stable-id",
    accountId: "account-a",
    requestId: "request-expired-stable",
    sku: "sku-expired-stable",
    preferredSessionId: "collector-retry",
    refreshBundle: true,
    deadlineAt: new Date("2026-07-31T00:00:41.000Z"),
    createdAt: new Date("2026-07-31T00:00:21.000Z"),
  });

  assert.equal(retried.id, "job-expired-stable");
  assert.equal(retried.status, "PENDING");
  assert.equal(retried.preferredSessionId, "collector-retry");
  assert.equal(retried.claimedSessionId, null);
  assert.equal(retried.claimExpiresAt, null);
  assert.equal(retried.attemptCount, 0);
  assert.equal(retried.nextAttemptAt, "2026-07-31T00:00:21.000Z");
  assert.equal(retried.lastError, null);
  assert.equal(retried.result, null);
  assert.equal(retried.error, null);
  assert.equal(retried.completedAt, null);
  assert.equal(retried.createdAt, "2026-07-31T00:00:21.000Z");
  assert.equal(retried.deadlineAt, "2026-07-31T00:00:41.000Z");
  assert.equal(retried.refreshBundle, true);

  const claimed = await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-retry",
    now: new Date("2026-07-31T00:00:21.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:00:26.000Z"),
  });
  const succeeded = await repository.completeJob({
    accountId: "account-a",
    collectorSessionId: "collector-retry",
    jobId: claimed.id,
    result: completeResult(818),
    now: new Date("2026-07-31T00:00:22.000Z"),
  });
  const terminalRetry = await repository.createOrGetJob({
    id: "job-terminal-must-not-revive",
    accountId: "account-a",
    requestId: "request-expired-stable",
    sku: "sku-expired-stable",
    preferredSessionId: null,
    refreshBundle: false,
    deadlineAt: new Date("2026-07-31T00:01:20.000Z"),
    createdAt: new Date("2026-07-31T00:01:00.000Z"),
  });
  assert.deepEqual(terminalRetry, succeeded);
});

test("JSON create-or-get rejects one job id mapped to a different stable key", async () => {
  const repository = createJsonCollectorOzonEnrichmentRepository({ state: {} });
  await repository.createOrGetJob({
    id: "job-collision",
    accountId: "account-a",
    requestId: "request-original",
    sku: "sku-original",
    preferredSessionId: null,
    refreshBundle: {},
    deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  });
  await assert.rejects(repository.createOrGetJob({
    id: "job-collision",
    accountId: "account-a",
    requestId: "request-other",
    sku: "sku-other",
    preferredSessionId: null,
    refreshBundle: {},
    deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:01:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_JOB_ID_CONFLICT");
});

test("JSON job results require the owning session and terminal jobs are immutable", async () => {
  const repository = createJsonCollectorOzonEnrichmentRepository({
    state: {
      collectorSessions: [
        activeSession("collector-owner", "account-a"),
        activeSession("collector-attacker", "account-a"),
      ],
    },
  });
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
        activeSession("collector-a", "account-a"),
        activeSession("collector-b", "account-b"),
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

test("JSON cache writes fail closed for missing, malformed, expired, or revoked sessions", async (t) => {
  const cases = [
    ["missing collection", {}],
    ["non-array collection", { collectorSessions: {} }],
    ["missing record", { collectorSessions: [] }],
    ["missing expiry", { collectorSessions: [{ id: "collector-a", accountId: "account-a" }] }],
    ["invalid expiry", { collectorSessions: [activeSession("collector-a", "account-a", { expiresAt: "bad-date" })] }],
    ["expired", { collectorSessions: [activeSession("collector-a", "account-a", { expiresAt: "2026-07-30T23:59:59.999Z" })] }],
    ["revoked", { collectorSessions: [activeSession("collector-a", "account-a", { revokedAt: "2026-07-30T23:00:00.000Z" })] }],
  ];
  for (const [name, state] of cases) {
    await t.test(name, async () => {
      const repository = createJsonCollectorOzonEnrichmentRepository({ state });
      await assert.rejects(repository.writeCompleteCache({
        key: ACCOUNT_A_KEY,
        result: completeResult(707),
        responseHash: "fail-closed-hash",
        executorSessionId: "collector-a",
        capturedAt: new Date("2026-07-31T00:00:00.000Z"),
        expiresAt: new Date("2026-07-31T06:00:00.000Z"),
      }), (error) => error?.code === "OZON_ENRICHMENT_SESSION_SCOPE");
    });
  }

  const repository = createJsonCollectorOzonEnrichmentRepository({
    state: { collectorSessions: [activeSession("collector-a", "account-a")] },
  });
  await assert.rejects(repository.writeCompleteCache({
    key: ACCOUNT_A_KEY,
    result: completeResult(708),
    responseHash: "missing-executor-hash",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T06:00:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_SCOPE_REQUIRED");
});

test("JSON cache write rechecks session after waiting for the serialized mutation queue", async () => {
  const enteredPersist = deferred();
  const releasePersist = deferred();
  let persistCalls = 0;
  const state = { collectorSessions: [activeSession("collector-a", "account-a")] };
  const repository = createJsonCollectorOzonEnrichmentRepository({
    state,
    persist: async () => {
      persistCalls += 1;
      if (persistCalls === 1) {
        enteredPersist.resolve();
        await releasePersist.promise;
      }
    },
  });
  const blocker = repository.writeNegativeCache({
    key: ACCOUNT_B_KEY,
    error: { code: "BLOCK" },
    responseHash: "blocker-hash",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T00:01:00.000Z"),
  });
  await enteredPersist.promise;
  const pending = repository.writeCompleteCache({
    key: ACCOUNT_A_KEY,
    result: completeResult(808),
    responseHash: "raced-hash",
    executorSessionId: "collector-a",
    capturedAt: new Date("2026-07-31T00:00:01.000Z"),
    expiresAt: new Date("2026-07-31T06:00:00.000Z"),
  });
  state.collectorSessions[0].revokedAt = "2026-07-31T00:00:00.500Z";
  releasePersist.resolve();
  await blocker;
  await assert.rejects(pending, (error) => error?.code === "OZON_ENRICHMENT_SESSION_SCOPE");
});

test("JSON claim and finish recheck session after waiting for the serialized mutation queue", async () => {
  for (const operation of ["claim", "finish"]) {
    const enteredPersist = deferred();
    const releasePersist = deferred();
    let persistCalls = 0;
    const job = {
      id: "job-race",
      accountId: "account-a",
      requestId: "request-race",
      sku: "sku-race",
      status: operation === "claim" ? "PENDING" : "PROCESSING",
      preferredSessionId: null,
      claimedSessionId: operation === "finish" ? "collector-a" : null,
      claimExpiresAt: operation === "finish" ? "2026-07-31T00:20:00.000Z" : null,
      refreshBundle: {},
      deadlineAt: "2026-07-31T01:00:00.000Z",
      result: null,
      error: null,
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      completedAt: null,
    };
    const state = {
      collectorSessions: [activeSession("collector-a", "account-a")],
      collectorOzonEnrichmentJobs: [job],
    };
    const repository = createJsonCollectorOzonEnrichmentRepository({
      state,
      persist: async () => {
        persistCalls += 1;
        if (persistCalls === 1) {
          enteredPersist.resolve();
          await releasePersist.promise;
        }
      },
    });
    const blocker = repository.writeNegativeCache({
      key: ACCOUNT_B_KEY,
      error: { code: "BLOCK" },
      responseHash: `blocker-${operation}`,
      capturedAt: new Date("2026-07-31T00:00:00.000Z"),
      expiresAt: new Date("2026-07-31T00:01:00.000Z"),
    });
    await enteredPersist.promise;
    const pending = operation === "claim"
      ? repository.claimNextJob({
        accountId: "account-a",
        collectorSessionId: "collector-a",
        now: new Date("2026-07-31T00:10:00.000Z"),
        claimExpiresAt: new Date("2026-07-31T00:20:00.000Z"),
      })
      : repository.completeJob({
        accountId: "account-a",
        collectorSessionId: "collector-a",
        jobId: "job-race",
        result: completeResult(909),
        now: new Date("2026-07-31T00:10:00.000Z"),
      });
    state.collectorSessions[0].revokedAt = "2026-07-31T00:05:00.000Z";
    releasePersist.resolve();
    await blocker;
    await assert.rejects(
      pending,
      (error) => error?.code === "OZON_ENRICHMENT_SESSION_SCOPE",
      operation,
    );
  }
});

test("repository rejects absent dates and null terminal payloads before mutation or query", async () => {
  const processingJob = {
    id: "job-null-payload",
    accountId: "account-a",
    requestId: "request-null-payload",
    sku: "sku-null-payload",
    status: "PROCESSING",
    preferredSessionId: null,
    claimedSessionId: "collector-a",
    claimExpiresAt: "2026-07-31T00:20:00.000Z",
    refreshBundle: {},
    deadlineAt: "2026-07-31T01:00:00.000Z",
    result: null,
    error: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    completedAt: null,
  };
  const state = {
    collectorSessions: [activeSession("collector-a", "account-a")],
    collectorOzonEnrichmentJobs: [processingJob],
  };
  const jsonRepository = createJsonCollectorOzonEnrichmentRepository({ state });
  await assert.rejects(jsonRepository.readCache({ key: ACCOUNT_A_KEY, now: null }),
    (error) => error?.code === "OZON_ENRICHMENT_DATE_INVALID");
  await assert.rejects(jsonRepository.writeCompleteCache({
    key: ACCOUNT_A_KEY,
    result: null,
    responseHash: "null-result",
    executorSessionId: "collector-a",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T06:00:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_PAYLOAD_REQUIRED");
  await assert.rejects(jsonRepository.writeNegativeCache({
    key: ACCOUNT_A_KEY,
    error: null,
    responseHash: "null-error",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T00:01:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_PAYLOAD_REQUIRED");
  await assert.rejects(jsonRepository.completeJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-null-payload",
    result: null,
    now: new Date("2026-07-31T00:10:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_PAYLOAD_REQUIRED");
  await assert.rejects(jsonRepository.failJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-null-payload",
    error: null,
    now: new Date("2026-07-31T00:10:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_PAYLOAD_REQUIRED");

  let queryCalls = 0;
  const pgRepository = createPostgresCollectorOzonEnrichmentRepository({
    pool: { async query() { queryCalls += 1; return { rows: [] }; } },
  });
  await assert.rejects(pgRepository.writeCompleteCache({
    key: ACCOUNT_A_KEY,
    result: null,
    responseHash: "null-result",
    executorSessionId: "collector-a",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T06:00:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_PAYLOAD_REQUIRED");
  await assert.rejects(pgRepository.writeNegativeCache({
    key: ACCOUNT_A_KEY,
    error: null,
    responseHash: "null-error",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T00:01:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_PAYLOAD_REQUIRED");
  await assert.rejects(pgRepository.completeJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-null-payload",
    result: null,
    now: new Date("2026-07-31T00:10:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_PAYLOAD_REQUIRED");
  await assert.rejects(pgRepository.failJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-null-payload",
    error: null,
    now: new Date("2026-07-31T00:10:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_PAYLOAD_REQUIRED");
  assert.equal(queryCalls, 0);
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
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.match(calls[0].sql, /COUNT\(DISTINCT lease_owner\)/);
  assert.match(calls[0].sql, /AS owner_has_live_lease/);
  assert.match(calls[0].sql, /key_held_by_other OR key_held_by_owner OR owner_has_live_lease OR active_lease_count<\$8/);
  assert.match(calls[0].sql, /NOT owner_has_live_lease/);
  assert.match(calls[0].sql, /INSERT INTO collector_ozon_enrichment_cache/);
  assert.match(calls[0].sql, /ON CONFLICT \(account_id, source, sku, contract_version\) DO UPDATE/);
  assert.match(calls[0].sql, /lease_expires_at <= EXCLUDED\.updated_at OR collector_ozon_enrichment_cache\.lease_owner = EXCLUDED\.lease_owner/);
  assert.match(calls[0].sql, /RETURNING account_id, source, sku, contract_version, lease_owner, lease_expires_at/);
  assert.deepEqual(calls[0].params.slice(0, 4), [
    "account-a", "ozon", "4862904234", "ozon-enrichment-v1",
  ]);
  assert.equal(acquired.leaseOwner, "owner-a");
});

test("PostgreSQL lease admission lets one live account owner acquire another key at capacity", async () => {
  const calls = [];
  const repository = createPostgresCollectorOzonEnrichmentRepository({
    pool: {
      async query(sql, params) {
        calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
        return { rows: [{
          account_id: "account-a",
          source: "ozon",
          sku: "owner-second-key",
          contract_version: "ozon-enrichment-v1",
          lease_owner: "owner-already-live",
          lease_expires_at: "2026-07-31T00:01:00.000Z",
        }] };
      },
    },
  });
  const acquired = await repository.tryAcquireCacheLease({
    key: { ...ACCOUNT_A_KEY, sku: "owner-second-key" },
    leaseOwner: "owner-already-live",
    leaseExpiresAt: new Date("2026-07-31T00:01:00.000Z"),
    now: new Date("2026-07-31T00:00:00.000Z"),
    maxActiveLeases: 4,
  });

  assert.equal(acquired.leaseOwner, "owner-already-live");
  assert.match(calls[0].sql, /lease_owner=\$5 AND lease_expires_at>\$7/);
  assert.match(calls[0].sql, /owner_has_live_lease OR active_lease_count<\$8/);
  assert.deepEqual(calls[0].params.slice(4), [
    "owner-already-live",
    new Date("2026-07-31T00:01:00.000Z"),
    new Date("2026-07-31T00:00:00.000Z"),
    4,
  ]);
});

test("PostgreSQL cache lease admission reports account capacity without exposing SQL", async () => {
  const repository = createPostgresCollectorOzonEnrichmentRepository({
    pool: {
      async query() {
        return { rows: [{ busy: true }] };
      },
    },
  });
  await assert.rejects(repository.tryAcquireCacheLease({
    key: ACCOUNT_A_KEY,
    leaseOwner: "owner-fifth",
    leaseExpiresAt: new Date("2026-07-31T00:01:00.000Z"),
    now: new Date("2026-07-31T00:00:00.000Z"),
    maxActiveLeases: 4,
  }), (error) => error?.status === 429
    && error?.code === "OZON_ENRICH_BUSY"
    && !error?.message.includes("SELECT"));
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

test("PostgreSQL atomic terminal write rolls back the job when cache persistence fails", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push(normalized);
      if (normalized.startsWith("UPDATE collector_ozon_enrichment_jobs")) {
        return { rows: [{
          id: "job-pg-atomic",
          account_id: "account-a",
          request_id: "request-pg-atomic",
          sku: ACCOUNT_A_KEY.sku,
          status: "SUCCESS",
          result_json: completeResult(929),
          claimed_session_id: "collector-owner",
          claim_expires_at: "2026-07-31T00:00:10.000Z",
          deadline_at: "2026-07-31T00:00:20.000Z",
          created_at: "2026-07-31T00:00:00.000Z",
          updated_at: "2026-07-31T00:00:01.000Z",
        }] };
      }
      if (normalized.startsWith("INSERT INTO collector_ozon_enrichment_cache")) {
        throw new Error("cache insert failed");
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({
    pool: { async connect() { return client; }, async query() { return { rows: [] }; } },
  });
  await assert.rejects(repository.completeJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-owner",
    jobId: "job-pg-atomic",
    key: ACCOUNT_A_KEY,
    result: completeResult(929),
    responseHash: "pg-atomic-hash",
    capturedAt: new Date("2026-07-31T00:00:01.000Z"),
    expiresAt: new Date("2026-07-31T06:00:01.000Z"),
    now: new Date("2026-07-31T00:00:01.000Z"),
  }));
  assert.equal(calls[0], "BEGIN");
  assert.match(calls[1], /deadline_at>\$4/);
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.includes("COMMIT"), false);
});

test("PostgreSQL job claim locks the account transaction and enforces the four-job limit", async () => {
  const calls = [];
  let processingCount = "3";
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT id FROM collector_sessions")) {
        return { rows: [{ id: params[1] }], rowCount: 1 };
      }
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
  assert.match(calls[2].sql, /SELECT id FROM collector_sessions/);
  assert.match(calls[2].sql, /revoked_at IS NULL/);
  assert.match(calls[2].sql, /expires_at>\$3/);
  assert.match(calls[3].sql, /status='PROCESSING'/);
  assert.match(calls[3].sql, /claim_expires_at>/);
  assert.match(calls[4].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(calls[4].sql, /account_id=\$1/);
  assert.match(calls[4].sql, /claimed_session_id=\$2/);
  assert.match(calls[4].sql, /job\.created_at \+ INTERVAL '1 second'<=\$3/);
  assert.match(calls[4].sql, /claim_expires_at=LEAST\(\$4, job\.deadline_at\)/);
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

test("PostgreSQL claim rejects an invalid session before checking account capacity", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT id FROM collector_sessions")) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT COUNT(*)")) {
        return { rows: [{ count: "4" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({
    pool: { async connect() { return client; }, async query() { return { rows: [] }; } },
  });

  await assert.rejects(repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-invalid",
    now: new Date("2026-07-31T00:10:00.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:20:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_SESSION_SCOPE");
  assert.equal(calls.some((call) => call.sql.startsWith("SELECT COUNT(*)")), false);
  assert.equal(calls.at(-1).sql, "ROLLBACK");
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
  assert.match(calls[0].sql, /CASE WHEN preferred\.id IS NULL THEN NULL ELSE \$6 END/);
});

test("PostgreSQL create-or-get returns a concurrent stable row despite an invalid retry preference", async () => {
  const existing = {
    id: "job-stable",
    account_id: "account-a",
    request_id: "request-stable",
    sku: "sku-stable",
    status: "PENDING",
    refresh_bundle: { revision: 1 },
    preferred_session_id: "collector-expired",
    deadline_at: "2026-07-31T01:00:00.000Z",
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: "2026-07-31T00:00:00.000Z",
  };
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("INSERT INTO collector_ozon_enrichment_jobs")) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.includes("WHERE account_id=$1 AND request_id=$2 AND sku=$3")) {
        return { rows: [existing], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({ pool });
  const retried = await repository.createOrGetJob({
    id: "job-retry-ignored",
    accountId: "account-a",
    requestId: "request-stable",
    sku: "sku-stable",
    preferredSessionId: "collector-expired",
    refreshBundle: { revision: 2 },
    deadlineAt: new Date("2026-07-31T02:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:10:00.000Z"),
  });

  assert.equal(retried.id, "job-stable");
  assert.deepEqual(retried.refreshBundle, { revision: 1 });
  assert.match(calls[0].sql, /ON CONFLICT DO NOTHING/);
});

test("PostgreSQL create-or-get atomically resets an expired nonterminal stable row", async () => {
  const calls = [];
  const resetRow = {
    id: "job-expired-stable",
    account_id: "account-a",
    request_id: "request-expired-stable",
    sku: "sku-expired-stable",
    status: "PENDING",
    refresh_bundle: true,
    preferred_session_id: "collector-retry",
    claimed_session_id: null,
    claim_expires_at: null,
    deadline_at: "2026-07-31T00:00:41.000Z",
    created_at: "2026-07-31T00:00:21.000Z",
    updated_at: "2026-07-31T00:00:21.000Z",
    completed_at: null,
    attempt_count: 0,
    next_attempt_at: "2026-07-31T00:00:21.000Z",
    last_error_json: null,
  };
  const pool = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("INSERT INTO collector_ozon_enrichment_jobs")) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("UPDATE collector_ozon_enrichment_jobs AS job")) {
        return { rows: [resetRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({ pool });
  const retried = await repository.createOrGetJob({
    id: "job-new-id-must-not-replace-stable-id",
    accountId: "account-a",
    requestId: "request-expired-stable",
    sku: "sku-expired-stable",
    preferredSessionId: "collector-retry",
    refreshBundle: true,
    deadlineAt: new Date("2026-07-31T00:00:41.000Z"),
    createdAt: new Date("2026-07-31T00:00:21.000Z"),
  });

  assert.equal(retried.id, "job-expired-stable");
  assert.equal(retried.status, "PENDING");
  assert.match(calls[1].sql, /status='PENDING'/);
  assert.match(calls[1].sql, /claimed_session_id=NULL/);
  assert.match(calls[1].sql, /claim_expires_at=NULL/);
  assert.match(calls[1].sql, /result_json=NULL/);
  assert.match(calls[1].sql, /error_json=NULL/);
  assert.match(calls[1].sql, /completed_at=NULL/);
  assert.match(calls[1].sql, /attempt_count=0/);
  assert.match(calls[1].sql, /next_attempt_at=\$8/);
  assert.match(calls[1].sql, /last_error_json=NULL/);
  assert.match(calls[1].sql, /status IN \('PENDING','PROCESSING'\)/);
  assert.match(calls[1].sql, /deadline_at<=\$8/);
  assert.match(calls[1].sql, /preferred\.account_id=\$2/);
});

test("PostgreSQL create-or-get reports an explicit id conflict after atomic insert loses", async () => {
  const pool = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("INSERT INTO collector_ozon_enrichment_jobs")) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.includes("WHERE account_id=$1 AND request_id=$2 AND sku=$3")) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.includes("WHERE id=$1")) {
        return { rows: [{ id: "job-collision" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({ pool });
  await assert.rejects(repository.createOrGetJob({
    id: "job-collision",
    accountId: "account-a",
    requestId: "request-other",
    sku: "sku-other",
    preferredSessionId: null,
    refreshBundle: {},
    deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_JOB_ID_CONFLICT");
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
    assert.match(call.sql, /deadline_at>\$4/);
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

test("PostgreSQL terminal fallback distinguishes session, ownership, terminal, missing, and update races", async (t) => {
  const processingOwned = {
    id: "job-a",
    account_id: "account-a",
    request_id: "request-a",
    sku: "sku-a",
    status: "PROCESSING",
    refresh_bundle: {},
    claimed_session_id: "collector-owner",
    claim_expires_at: "2026-07-31T00:20:00.000Z",
    deadline_at: "2026-07-31T01:00:00.000Z",
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: "2026-07-31T00:10:00.000Z",
  };
  const cases = [
    ["invalid session", false, processingOwned, "OZON_ENRICHMENT_SESSION_SCOPE"],
    ["wrong owner", true, { ...processingOwned, claimed_session_id: "collector-other" }, "OZON_ENRICHMENT_JOB_OWNERSHIP"],
    ["terminal", true, { ...processingOwned, status: "SUCCESS" }, "OZON_ENRICHMENT_JOB_TERMINAL"],
    ["missing", true, null, "OZON_ENRICHMENT_JOB_NOT_FOUND"],
    ["concurrent update race", true, processingOwned, "OZON_ENRICHMENT_JOB_OWNERSHIP"],
  ];
  for (const [name, sessionValid, job, expectedCode] of cases) {
    await t.test(name, async () => {
      const calls = [];
      const pool = {
        async query(sql, params = []) {
          const normalized = String(sql).replace(/\s+/g, " ").trim();
          calls.push({ sql: normalized, params });
          if (normalized.startsWith("UPDATE collector_ozon_enrichment_jobs")) {
            return { rows: [], rowCount: 0 };
          }
          if (normalized.startsWith("SELECT id FROM collector_sessions")) {
            return { rows: sessionValid ? [{ id: "collector-owner" }] : [], rowCount: sessionValid ? 1 : 0 };
          }
          if (normalized.startsWith("SELECT * FROM collector_ozon_enrichment_jobs")) {
            return { rows: job ? [job] : [], rowCount: job ? 1 : 0 };
          }
          return { rows: [], rowCount: 0 };
        },
      };
      const repository = createPostgresCollectorOzonEnrichmentRepository({ pool });
      await assert.rejects(repository.completeJob({
        accountId: "account-a",
        collectorSessionId: "collector-owner",
        jobId: "job-a",
        result: completeResult(1001),
        now: new Date("2026-07-31T00:11:00.000Z"),
      }), (error) => error?.code === expectedCode);
      assert.match(calls[1].sql, /SELECT id FROM collector_sessions/);
      if (!sessionValid) {
        assert.equal(calls.length, 2);
      } else {
        assert.match(calls[2].sql, /SELECT \* FROM collector_ozon_enrichment_jobs/);
      }
    });
  }
});

test("JSON linked enqueue is idempotent and rejects a collect-item mismatch", async () => {
  const repository = createJsonCollectorOzonEnrichmentRepository({
    state: { caches: { collectBox: [collectItem("collect-a", "account-a")] } },
  });
  const input = {
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "collect-request-a",
    sku: "4862904234",
    refreshBundle: {},
    now: new Date("2026-08-01T08:00:00.000Z"),
  };

  const first = await repository.enqueueForCollect(input);
  const duplicate = await repository.enqueueForCollect(input);

  assert.equal(duplicate.id, first.id);
  assert.equal(first.collectItemId, "collect-a");
  assert.equal(first.attemptCount, 0);
  assert.equal(first.nextAttemptAt, "2026-08-01T08:00:00.000Z");
  await assert.rejects(repository.enqueueForCollect({
    ...input,
    collectItemId: "collect-other",
  }), (error) => error?.code === "OZON_ENRICHMENT_COLLECT_ITEM_CONFLICT");
});

test("linked enqueue rejects composite Seller credential keys before persistence", async () => {
  const sensitiveBundles = [
    { sellerRequest: { sellerCookie: "must-not-persist" } },
    { requests: [{ authToken: "must-not-persist" }] },
    { challenges: [{ verificationCode: "must-not-persist" }] },
  ];
  for (const [index, refreshBundle] of sensitiveBundles.entries()) {
    const state = {
      caches: { collectBox: [collectItem("collect-a", "account-a")] },
    };
    const jsonRepository = createJsonCollectorOzonEnrichmentRepository({ state });
    const input = {
      accountId: "account-a",
      collectItemId: "collect-a",
      requestId: `credential-request-${index}`,
      sku: "4862904234",
      refreshBundle,
      now: new Date("2026-08-01T08:00:00.000Z"),
    };
    await assert.rejects(
      jsonRepository.enqueueForCollect(input),
      (error) => error?.code === "OZON_ENRICHMENT_SENSITIVE_DATA",
    );
    assert.equal(state.collectorOzonEnrichmentJobs, undefined);

    let queried = false;
    const postgresRepository = createPostgresCollectorOzonEnrichmentRepository({
      pool: { async query() { queried = true; return { rows: [] }; } },
    });
    await assert.rejects(
      postgresRepository.enqueueForCollect(input),
      (error) => error?.code === "OZON_ENRICHMENT_SENSITIVE_DATA",
    );
    assert.equal(queried, false);
  }
});

test("linked enqueue rejects normalized Seller credential semantics before persistence", async () => {
  const sensitiveBundles = [
    { metadata: { apikey: "must-not-persist" } },
    { entries: [{ sellertoken: "must-not-persist" }] },
    { outer: { entries: [{ refreshtoken: "must-not-persist" }] } },
    { sellerProfile: { clientsecret: "must-not-persist" } },
    { products: [{ details: { clientid: "must-not-persist" } }] },
    { checkpoints: [{ verificationcode: "must-not-persist" }] },
    { batches: [{ confirmation: { onetimecode: "must-not-persist" } }] },
    { metadata: { accesstoken: "must-not-persist" } },
    { actors: [{ sellercredentials: "must-not-persist" }] },
    { sellerProfile: { sellercookie: "must-not-persist" } },
    { actors: [{ profile: { sellerpassword: "must-not-persist" } }] },
    { metadata: { sellersecret: "must-not-persist" } },
    { forms: [{ authcode: "must-not-persist" }] },
    { forms: [{ details: { authenticationcode: "must-not-persist" } }] },
    { checkpoints: [{ authorizationcode: "must-not-persist" }] },
    { batches: [{ confirmation: { otpcode: "must-not-persist" } }] },
    { formats: { accessToken: "must-not-persist" } },
    { formats: { access_token: "must-not-persist" } },
    { formats: { "access-token": "must-not-persist" } },
    { formats: { ACCESSTOKEN: "must-not-persist" } },
    { formats: { aCcEsStOkEn: "must-not-persist" } },
  ];
  for (const [index, refreshBundle] of sensitiveBundles.entries()) {
    const state = {
      caches: { collectBox: [collectItem("collect-a", "account-a")] },
    };
    const jsonRepository = createJsonCollectorOzonEnrichmentRepository({ state });
    const input = {
      accountId: "account-a",
      collectItemId: "collect-a",
      requestId: `compact-credential-request-${index}`,
      sku: "4862904234",
      refreshBundle,
      now: new Date("2026-08-01T08:00:00.000Z"),
    };
    await assert.rejects(
      jsonRepository.enqueueForCollect(input),
      (error) => error?.code === "OZON_ENRICHMENT_SENSITIVE_DATA",
    );
    assert.equal(state.collectorOzonEnrichmentJobs, undefined);

    let queried = false;
    const postgresRepository = createPostgresCollectorOzonEnrichmentRepository({
      pool: { async query() { queried = true; return { rows: [] }; } },
    });
    await assert.rejects(
      postgresRepository.enqueueForCollect(input),
      (error) => error?.code === "OZON_ENRICHMENT_SENSITIVE_DATA",
    );
    assert.equal(queried, false);
  }
});

test("linked enqueue rejects plural and nonterminal credential semantics before either persistence gate", async (t) => {
  const sensitiveKeys = [
    "tokens",
    "accessTokens",
    "accesstokens",
    "refreshTokens",
    "apiKeys",
    "clientIds",
    "clientSecrets",
    "verificationCodes",
    "passwords",
    "secrets",
    "cookieValue",
    "accessTokenValue",
    "passwordHash",
    "authorizationHeader",
    "accessTokensValue",
    "requestaccesstokensvalue",
  ];

  for (const [index, sensitiveKey] of sensitiveKeys.entries()) {
    await t.test(sensitiveKey, async () => {
      const refreshBundle = {
        requests: [{ [sensitiveKey]: "must-not-persist" }],
      };
      const state = {
        caches: { collectBox: [collectItem("collect-a", "account-a")] },
      };
      let jsonSaveCalled = false;
      const input = {
        accountId: "account-a",
        collectItemId: "collect-a",
        requestId: `nonterminal-credential-request-${index}`,
        sku: "4862904234",
        refreshBundle,
        now: new Date("2026-08-01T08:00:00.000Z"),
      };

      let jsonError = null;
      try {
        await createJsonCollectorOzonEnrichmentRepository({
          state,
          async persist() { jsonSaveCalled = true; },
        }).enqueueForCollect(input);
      } catch (error) {
        jsonError = error;
      }

      let postgresQueried = false;
      let postgresError = null;
      const postgresRepository = createPostgresCollectorOzonEnrichmentRepository({
        pool: {
          async query() {
            postgresQueried = true;
            return { rows: [], rowCount: 0 };
          },
        },
      });
      try {
        await postgresRepository.enqueueForCollect(input);
      } catch (error) {
        postgresError = error;
      }

      assert.deepEqual({
        jsonCode: jsonError?.code ?? null,
        jsonJobCreated: Boolean(state.collectorOzonEnrichmentJobs?.length),
        jsonSaveCalled,
        postgresCode: postgresError?.code ?? null,
        postgresQueried,
      }, {
        jsonCode: "OZON_ENRICHMENT_SENSITIVE_DATA",
        jsonJobCreated: false,
        jsonSaveCalled: false,
        postgresCode: "OZON_ENRICHMENT_SENSITIVE_DATA",
        postgresQueried: false,
      });
    });
  }
});

test("linked enqueue permits non-secret company and capture metadata", async () => {
  const state = {
    caches: { collectBox: [collectItem("collect-a", "account-a")] },
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const refreshBundle = {
    sellerCompanyId: "2681910",
    sellercompanyid: "2681910",
    captureContext: { revision: 4, observedAt: "2026-08-01T08:00:00.000Z" },
    product: {
      productcode: "4862904234",
      categoryid: "17028922",
      barcode: "4600000000000",
      sourceid: "catalog-import",
      productCodes: ["4862904234"],
      categoryIds: ["17028922"],
      hotProduct: true,
      secretaryName: "Catalog contact",
    },
    request: {
      requestId: "safe-metadata-request",
      requestHeaders: ["accept-language"],
      clientIdentity: "browser-worker",
      apiVersion: "v1",
      accessMode: "read-only",
    },
  };
  const job = await repository.enqueueForCollect({
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "safe-metadata-request",
    sku: "4862904234",
    refreshBundle,
    now: new Date("2026-08-01T08:00:00.000Z"),
  });
  assert.deepEqual(job.refreshBundle, refreshBundle);
});

test("JSON linked enqueue ignores forged internal job state", async () => {
  const state = {
    caches: { collectBox: [collectItem("collect-a", "account-a")] },
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const job = await repository.enqueueForCollect({
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "forged-internal-state",
    sku: "4862904234",
    refreshBundle: {},
    now: new Date("2026-08-01T08:00:00.000Z"),
    attemptCount: 99,
    nextAttemptAt: new Date("2099-01-01T00:00:00.000Z"),
    lastError: { code: "FORGED" },
    captureContext: {
      sellerCompanyId: "forged",
      revision: 99,
      observedAt: "2099-01-01T00:00:00.000Z",
    },
    status: "SUCCESS",
    preferredSessionId: "forged-preference",
    claimedSessionId: "forged-owner",
    claimExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
    result: { forged: true },
    error: { forged: true },
    completedAt: new Date("2099-01-01T00:00:00.000Z"),
    leaseOwner: "forged-lease",
  });

  assert.equal(job.status, "PENDING");
  assert.equal(job.attemptCount, 0);
  assert.equal(job.nextAttemptAt, "2026-08-01T08:00:00.000Z");
  assert.equal(job.lastError, null);
  assert.equal(job.captureContext, null);
  assert.equal(job.preferredSessionId, null);
  assert.equal(job.claimedSessionId, null);
  assert.equal(job.claimExpiresAt, null);
  assert.equal(job.deadlineAt, "9999-12-31T23:59:59.999Z");
  assert.equal(job.result, null);
  assert.equal(job.error, null);
  assert.equal(job.completedAt, null);
  assert.equal(Object.hasOwn(state.collectorOzonEnrichmentJobs[0], "leaseOwner"), false);
});

test("JSON linked enqueue hides cross-account and missing collect items behind one error", async () => {
  const state = {
    caches: { collectBox: [collectItem("collect-b", "account-b")] },
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const errors = [];
  for (const collectItemId of ["collect-b", "collect-missing"]) {
    try {
      await repository.enqueueForCollect({
        accountId: "account-a",
        collectItemId,
        requestId: `scope-${collectItemId}`,
        sku: "4862904234",
        refreshBundle: {},
        now: new Date("2026-08-01T08:00:00.000Z"),
      });
      assert.fail("out-of-scope collect item must not enqueue");
    } catch (error) {
      errors.push(error);
    }
  }
  assert.deepEqual(errors.map(({ code, status }) => ({ code, status })), [
    { code: "OZON_ENRICHMENT_COLLECT_ITEM_NOT_FOUND", status: 404 },
    { code: "OZON_ENRICHMENT_COLLECT_ITEM_NOT_FOUND", status: 404 },
  ]);
  assert.equal(state.collectorOzonEnrichmentJobs, undefined);
});

test("JSON linked retries wait until due and persist only stable error fields", async () => {
  const state = {
    caches: { collectBox: [collectItem("collect-a", "account-a")] },
    collectorSessions: [activeSession("collector-a", "account-a", {
      expiresAt: "2026-08-02T00:00:00.000Z",
    })],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const enqueued = await repository.enqueueForCollect({
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "collect-request-a",
    sku: "4862904234",
    refreshBundle: {},
    now: new Date("2026-08-01T08:00:00.000Z"),
  });
  await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: new Date("2026-08-01T08:00:00.000Z"),
    claimExpiresAt: new Date("2026-08-01T08:01:00.000Z"),
  });

  const deferred = await repository.deferClaim({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: enqueued.id,
    error: {
      code: "OZON_RETRYABLE",
      status: 503,
      message: "contains unstable and potentially sensitive detail",
      stack: "must not persist",
      sellerToken: "must not persist",
    },
    now: new Date("2026-08-01T08:00:01.000Z"),
  });

  assert.equal(deferred.status, "PENDING");
  assert.equal(deferred.attemptCount, 1);
  assert.equal(deferred.nextAttemptAt, "2026-08-01T08:00:31.000Z");
  assert.equal(deferred.claimedSessionId, null);
  assert.equal(deferred.claimExpiresAt, null);
  assert.deepEqual(deferred.lastError, { code: "OZON_RETRYABLE", status: 503 });
  assert.equal(await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: new Date("2026-08-01T08:00:30.999Z"),
    claimExpiresAt: new Date("2026-08-01T08:01:30.999Z"),
  }), null);
  assert.equal((await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: new Date("2026-08-01T08:00:31.000Z"),
    claimExpiresAt: new Date("2026-08-01T08:01:31.000Z"),
  })).id, enqueued.id);
});

test("JSON linked jobs enforce account scope for read, claim, defer, and completion", async () => {
  const state = {
    caches: { collectBox: [
      collectItem("collect-a", "account-a"),
      collectItem("collect-b", "account-b"),
    ] },
    collectorSessions: [
      activeSession("collector-a", "account-a", { expiresAt: "2026-08-02T00:00:00.000Z" }),
      activeSession("collector-b", "account-b", { expiresAt: "2026-08-02T00:00:00.000Z" }),
    ],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const job = await repository.enqueueForCollect({
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "collect-request-a",
    sku: ACCOUNT_A_KEY.sku,
    refreshBundle: {},
    now: new Date("2026-08-01T08:00:00.000Z"),
  });
  await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: new Date("2026-08-01T08:00:00.000Z"),
    claimExpiresAt: new Date("2026-08-01T08:01:00.000Z"),
  });

  assert.equal(await repository.readJob({ accountId: "account-b", jobId: job.id }), null);
  assert.equal(await repository.claimNextJob({
    accountId: "account-b",
    collectorSessionId: "collector-b",
    now: new Date("2026-08-01T08:00:01.000Z"),
    claimExpiresAt: new Date("2026-08-01T08:01:01.000Z"),
  }), null);
  await assert.rejects(repository.deferClaim({
    accountId: "account-b",
    collectorSessionId: "collector-b",
    jobId: job.id,
    error: { code: "ATTACK" },
    now: new Date("2026-08-01T08:00:01.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_JOB_NOT_FOUND");
  await assert.rejects(repository.completeJobAndCache({
    accountId: "account-b",
    collectorSessionId: "collector-b",
    jobId: job.id,
    key: ACCOUNT_B_KEY,
    result: completeResult(268),
    responseHash: "cross-account-attempt",
    capturedAt: new Date("2026-08-01T08:00:01.000Z"),
    expiresAt: new Date("2026-08-01T14:00:01.000Z"),
    now: new Date("2026-08-01T08:00:01.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_JOB_NOT_FOUND");
});

test("JSON completion stores allowlisted capture evidence and rejects extra keys", async () => {
  const state = {
    caches: { collectBox: [collectItem("collect-a", "account-a")] },
    collectorSessions: [activeSession("collector-a", "account-a", {
      expiresAt: "2026-08-02T00:00:00.000Z",
    })],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const first = await repository.enqueueForCollect({
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "capture-a",
    sku: ACCOUNT_A_KEY.sku,
    refreshBundle: {},
    now: new Date("2026-08-01T08:00:00.000Z"),
  });
  await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: new Date("2026-08-01T08:00:00.000Z"),
    claimExpiresAt: new Date("2026-08-01T08:01:00.000Z"),
  });
  const captureContext = {
    sellerCompanyId: "2681910",
    revision: 4,
    observedAt: "2026-08-01T08:00:00.000Z",
  };
  const completed = await repository.completeJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: first.id,
    key: ACCOUNT_A_KEY,
    result: completeResult(268),
    responseHash: "capture-a-hash",
    captureContext,
    capturedAt: new Date("2026-08-01T08:00:01.000Z"),
    expiresAt: new Date("2026-08-01T14:00:01.000Z"),
    now: new Date("2026-08-01T08:00:01.000Z"),
  });
  assert.deepEqual(completed.captureContext, captureContext);
  assert.deepEqual((await repository.readCache({
    key: ACCOUNT_A_KEY,
    now: new Date("2026-08-01T08:00:02.000Z"),
  })).captureContext, captureContext);

  await assert.rejects(repository.completeJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: first.id,
    key: ACCOUNT_A_KEY,
    result: completeResult(269),
    responseHash: "capture-extra-hash",
    captureContext: { ...captureContext, sellerToken: "must not persist" },
    capturedAt: new Date("2026-08-01T08:00:02.000Z"),
    expiresAt: new Date("2026-08-01T14:00:02.000Z"),
    now: new Date("2026-08-01T08:00:02.000Z"),
  }), (error) => error?.code === "OZON_ENRICHMENT_CAPTURE_CONTEXT_INVALID");
});

test("PostgreSQL linked enqueue, due claim, defer, and capture evidence stay account scoped", async () => {
  const calls = [];
  const row = {
    id: "job-linked-pg",
    account_id: "account-a",
    collect_item_id: "collect-a",
    request_id: "collect-request-a",
    sku: ACCOUNT_A_KEY.sku,
    status: "PENDING",
    refresh_bundle: {},
    attempt_count: 0,
    next_attempt_at: "2026-08-01T08:00:00.000Z",
    deadline_at: "9999-12-31T23:59:59.999Z",
    created_at: "2026-08-01T08:00:00.000Z",
    updated_at: "2026-08-01T08:00:00.000Z",
  };
  const pool = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("INSERT INTO collector_ozon_enrichment_jobs")) {
        return { rows: [row], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE collector_ozon_enrichment_jobs")) {
        return { rows: [{
          ...row,
          status: "PENDING",
          attempt_count: 1,
          next_attempt_at: "2026-08-01T08:00:31.000Z",
          last_error_json: { code: "OZON_RETRYABLE", status: 503 },
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({ pool });
  await repository.enqueueForCollect({
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "collect-request-a",
    sku: ACCOUNT_A_KEY.sku,
    refreshBundle: {},
    now: new Date("2026-08-01T08:00:00.000Z"),
  });
  await repository.deferClaim({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-linked-pg",
    error: { code: "OZON_RETRYABLE", status: 503, message: "do not persist" },
    now: new Date("2026-08-01T08:00:01.000Z"),
  });

  assert.match(calls[0].sql, /FROM collect_items AS collect_item/);
  assert.match(calls[0].sql, /collect_item\.account_id=\$2/);
  assert.match(calls[0].sql, /ON CONFLICT \(account_id, request_id, sku\) DO NOTHING/);
  assert.match(calls[1].sql, /WHERE account_id=\$1 AND claimed_session_id=\$2 AND id=\$3/);
  assert.match(calls[1].sql, /attempt_count=attempt_count\+1/);
  assert.match(calls[1].sql, /last_error_json=\$5::jsonb/);
  assert.match(calls[1].sql, /next_attempt_at=\$4 \+ CASE/);
  assert.equal(calls[1].params[4], JSON.stringify({ code: "OZON_RETRYABLE", status: 503 }));
  assert.deepEqual(calls[1].params.slice(5), [30_000, 120_000, 600_000, 1_800_000, 3_600_000]);

  const claimClientCalls = [];
  const claimClient = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      claimClientCalls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT id FROM collector_sessions")) {
        return { rows: [{ id: "collector-a" }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT COUNT(*)")) return { rows: [{ count: "0" }] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const claimRepository = createPostgresCollectorOzonEnrichmentRepository({
    pool: { async connect() { return claimClient; }, async query() { return { rows: [] }; } },
  });
  await claimRepository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: new Date("2026-08-01T08:00:30.999Z"),
    claimExpiresAt: new Date("2026-08-01T08:01:30.999Z"),
  });
  assert.match(
    claimClientCalls.find((call) => call.sql.includes("FOR UPDATE SKIP LOCKED")).sql,
    /job\.next_attempt_at<=\$3/,
  );
});

test("PostgreSQL linked enqueue replays only the same collect item", async () => {
  const existing = {
    id: "job-linked-existing",
    account_id: "account-a",
    collect_item_id: "collect-a",
    request_id: "collect-request-a",
    sku: ACCOUNT_A_KEY.sku,
    status: "PENDING",
    refresh_bundle: {},
    attempt_count: 0,
    next_attempt_at: "2026-08-01T08:00:00.000Z",
    deadline_at: "9999-12-31T23:59:59.999Z",
    created_at: "2026-08-01T08:00:00.000Z",
    updated_at: "2026-08-01T08:00:00.000Z",
  };
  const calls = [];
  const repository = createPostgresCollectorOzonEnrichmentRepository({
    pool: {
      async query(sql, params = []) {
        const normalized = String(sql).replace(/\s+/g, " ").trim();
        calls.push({ sql: normalized, params });
        if (normalized.startsWith("INSERT INTO collector_ozon_enrichment_jobs")) {
          return { rows: [], rowCount: 0 };
        }
        if (normalized.startsWith("SELECT * FROM collector_ozon_enrichment_jobs")) {
          return { rows: [existing], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  });
  const input = {
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "collect-request-a",
    sku: ACCOUNT_A_KEY.sku,
    refreshBundle: {},
    now: new Date("2026-08-01T08:00:00.000Z"),
  };

  assert.equal((await repository.enqueueForCollect(input)).id, existing.id);
  await assert.rejects(repository.enqueueForCollect({
    ...input,
    collectItemId: "collect-other",
  }), (error) => error?.code === "OZON_ENRICHMENT_COLLECT_ITEM_CONFLICT");
  for (const call of calls.filter((entry) => entry.sql.startsWith("SELECT *"))) {
    assert.match(call.sql, /WHERE account_id=\$1 AND request_id=\$2 AND sku=\$3/);
  }
});

test("PostgreSQL completion stores only allowlisted capture evidence in job and cache", async () => {
  const calls = [];
  const captureContext = {
    sellerCompanyId: "2681910",
    revision: 4,
    observedAt: "2026-08-01T08:00:00.000Z",
  };
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("UPDATE collector_ozon_enrichment_jobs")) {
        return { rows: [{
          id: "job-capture-pg",
          account_id: "account-a",
          collect_item_id: "collect-a",
          request_id: "capture-pg",
          sku: ACCOUNT_A_KEY.sku,
          status: "SUCCESS",
          refresh_bundle: {},
          attempt_count: 0,
          next_attempt_at: "2026-08-01T08:00:00.000Z",
          capture_context_json: JSON.parse(params[6]),
          result_json: completeResult(268),
          deadline_at: "9999-12-31T23:59:59.999Z",
          created_at: "2026-08-01T08:00:00.000Z",
          updated_at: "2026-08-01T08:00:01.000Z",
          completed_at: "2026-08-01T08:00:01.000Z",
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({
    pool: { async connect() { return client; }, async query() { return { rows: [] }; } },
  });
  const completed = await repository.completeJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-capture-pg",
    key: ACCOUNT_A_KEY,
    result: completeResult(268),
    responseHash: "capture-pg-hash",
    captureContext,
    capturedAt: new Date("2026-08-01T08:00:01.000Z"),
    expiresAt: new Date("2026-08-01T14:00:01.000Z"),
    now: new Date("2026-08-01T08:00:01.000Z"),
  });

  const jobWrite = calls.find((call) => call.sql.startsWith("UPDATE collector_ozon_enrichment_jobs"));
  const cacheWrite = calls.find((call) => call.sql.startsWith("INSERT INTO collector_ozon_enrichment_cache"));
  assert.deepEqual(completed.captureContext, captureContext);
  assert.match(jobWrite.sql, /capture_context_json=\$7::jsonb/);
  assert.equal(jobWrite.params[6], JSON.stringify(captureContext));
  assert.match(cacheWrite.sql, /capture_context_json/);
  assert.equal(cacheWrite.params[11], JSON.stringify(captureContext));
  assert.equal(calls.at(-1).sql, "COMMIT");
});
