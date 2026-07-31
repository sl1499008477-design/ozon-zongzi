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
