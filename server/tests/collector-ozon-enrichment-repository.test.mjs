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

function changingRefreshBundleInput(base) {
  let readCount = 0;
  const input = { ...base };
  Object.defineProperty(input, "refreshBundle", {
    enumerable: true,
    get() {
      readCount += 1;
      return readCount === 1 ? true : { requestsecretvalue: "must-not-persist" };
    },
  });
  return { input, readCount: () => readCount };
}

async function completeTerminalJob(repository, input) {
  const job = await repository.readJob({ accountId: input.accountId, jobId: input.jobId });
  return repository.completeJobAndCache({
    ...input,
    key: {
      accountId: input.accountId,
      source: "ozon",
      sku: job.sku,
      contractVersion: ACCOUNT_A_KEY.contractVersion,
    },
    responseHash: `complete-${input.jobId}`,
    capturedAt: input.now,
    expiresAt: new Date(input.now.getTime() + 21_600_000),
    captureContext: job.captureContext ?? null,
    claimFence: job.claimFence ?? null,
  });
}

async function failTerminalJob(repository, input) {
  const job = await repository.readJob({ accountId: input.accountId, jobId: input.jobId });
  return repository.failJobAndCache({
    ...input,
    key: {
      accountId: input.accountId,
      source: "ozon",
      sku: job.sku,
      contractVersion: ACCOUNT_A_KEY.contractVersion,
    },
    responseHash: `failure-${input.jobId}`,
    capturedAt: input.now,
    expiresAt: new Date(input.now.getTime() + 60_000),
    captureContext: job.captureContext ?? null,
    claimFence: job.claimFence ?? null,
  });
}

test("repository terminal contract exposes only watermark-fenced atomic writes", () => {
  const jsonRepository = createJsonCollectorOzonEnrichmentRepository({ state: {} });
  const postgresRepository = createPostgresCollectorOzonEnrichmentRepository({
    pool: { async query() { return { rows: [], rowCount: 0 }; } },
  });
  for (const repository of [jsonRepository, postgresRepository]) {
    assert.equal(Object.hasOwn(repository, "completeJob"), false);
    assert.equal(Object.hasOwn(repository, "failJob"), false);
    assert.equal(typeof repository.completeJobAndCache, "function");
    assert.equal(typeof repository.failJobAndCache, "function");
  }
});

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
  }), (error) => error?.status === 429 && error?.code === "ZONGZI_ENRICH_BUSY");
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
    refreshBundle: true,
    deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  });
  const duplicate = await repository.createOrGetJob({
    id: "job-a-replacement",
    accountId: "account-a",
    requestId: "request-shared",
    sku: "sku-1",
    preferredSessionId: "collector-later",
    refreshBundle: false,
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
      refreshBundle: index % 2 === 0,
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
    refreshBundle: false,
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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_SESSION_SCOPE");
  const fallback = await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-fallback",
    now: new Date("2026-07-31T00:00:01.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:00:06.000Z"),
  });
  assert.equal(fallback.id, "job-preferred-window");
  assert.equal(fallback.claimedSessionId, "collector-fallback");
});

test("JSON availability is read-only and follows the claimable job contract", async () => {
  const at = new Date("2026-07-31T00:00:10.000Z");
  const job = (overrides = {}) => ({
    id: "job-availability",
    accountId: "account-a",
    requestId: "request-availability",
    sku: "sku-availability",
    status: "PENDING",
    preferredSessionId: null,
    claimedSessionId: null,
    claimExpiresAt: null,
    nextAttemptAt: "2026-07-31T00:00:00.000Z",
    deadlineAt: "2026-07-31T00:01:00.000Z",
    createdAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  });
  const check = async (state, input, expected) => {
    const repository = createJsonCollectorOzonEnrichmentRepository({ state });
    const before = structuredClone(state);
    assert.equal(await repository.hasClaimableJob({ ...input, now: at }), expected);
    assert.deepEqual(state, before);
  };

  await check(
    { collectorSessions: [activeSession("collector-a", "account-a")] },
    { accountId: "account-a", collectorSessionId: "collector-a" },
    false,
  );
  await check(
    {
      collectorSessions: [activeSession("collector-a", "account-a")],
      collectorOzonEnrichmentJobs: [job({ nextAttemptAt: "2026-07-31T00:00:10.001Z" })],
    },
    { accountId: "account-a", collectorSessionId: "collector-a" },
    false,
  );
  await check(
    {
      collectorSessions: [activeSession("collector-a", "account-a")],
      collectorOzonEnrichmentJobs: [job({ deadlineAt: "2026-07-31T00:00:10.000Z" })],
    },
    { accountId: "account-a", collectorSessionId: "collector-a" },
    true,
  );
  await check(
    {
      collectorSessions: [activeSession("collector-b", "account-b")],
      collectorOzonEnrichmentJobs: [job()],
    },
    { accountId: "account-a", collectorSessionId: "collector-missing" },
    false,
  );
  await check(
    {
      collectorSessions: [activeSession("collector-b", "account-b")],
      collectorOzonEnrichmentJobs: [job()],
    },
    { accountId: "account-a", collectorSessionId: "collector-b" },
    false,
  );
  await check(
    {
      collectorSessions: [activeSession("collector-a", "account-a")],
      collectorOzonEnrichmentJobs: [
        ...Array.from({ length: 4 }, (_, index) => job({
          id: `job-processing-${index}`,
          status: "PROCESSING",
          claimedSessionId: `collector-processing-${index}`,
          claimExpiresAt: "2026-07-31T00:00:20.000Z",
        })),
        job({ id: "job-due-after-capacity" }),
      ],
    },
    { accountId: "account-a", collectorSessionId: "collector-a" },
    false,
  );
  await check(
    {
      collectorSessions: [activeSession("collector-a", "account-a")],
      collectorOzonEnrichmentJobs: [job()],
    },
    { accountId: "account-a", collectorSessionId: "collector-a" },
    true,
  );
  await check(
    {
      collectorSessions: [activeSession("collector-a", "account-a")],
      collectorOzonEnrichmentJobs: [job({
        status: "PROCESSING",
        claimedSessionId: "collector-expired",
        claimExpiresAt: "2026-07-31T00:00:10.000Z",
      })],
    },
    { accountId: "account-a", collectorSessionId: "collector-a" },
    true,
  );
  await check(
    {
      collectorSessions: [
        activeSession("collector-preferred", "account-a"),
        activeSession("collector-fallback", "account-a"),
      ],
      collectorOzonEnrichmentJobs: [job({ preferredSessionId: "collector-preferred" })],
    },
    { accountId: "account-a", collectorSessionId: "collector-fallback" },
    true,
  );
});

test("JSON availability ignores legacy linked duplicates that claim normalization would supersede", async () => {
  const at = new Date("2026-08-01T08:00:10.000Z");
  const state = {
    collectorSessions: [activeSession("collector-a", "account-a", {
      expiresAt: "2026-08-02T00:00:00.000Z",
    })],
    collectorOzonEnrichmentJobs: [
      {
        id: "legacy-winner",
        accountId: "account-a",
        collectItemId: "collect-duplicate",
        requestId: "request-legacy-winner",
        sku: "sku-duplicate",
        status: "PROCESSING",
        claimedSessionId: "collector-legacy-winner",
        claimExpiresAt: "2026-08-01T08:01:00.000Z",
        nextAttemptAt: "2026-08-01T08:00:00.000Z",
        deadlineAt: "9999-12-31T23:59:59.999Z",
        createdAt: "2026-08-01T08:00:00.000Z",
      },
      {
        id: "legacy-duplicate-one",
        accountId: "account-a",
        collectItemId: "collect-duplicate",
        requestId: "request-legacy-duplicate-one",
        sku: "sku-duplicate",
        status: "PROCESSING",
        claimedSessionId: "collector-legacy-duplicate-one",
        claimExpiresAt: "2026-08-01T08:01:00.000Z",
        nextAttemptAt: "2026-08-01T08:00:00.000Z",
        deadlineAt: "9999-12-31T23:59:59.999Z",
        createdAt: "2026-08-01T08:00:01.000Z",
      },
      {
        id: "legacy-duplicate-two",
        accountId: "account-a",
        collectItemId: "collect-duplicate",
        requestId: "request-legacy-duplicate-two",
        sku: "sku-duplicate",
        status: "PROCESSING",
        claimedSessionId: "collector-legacy-duplicate-two",
        claimExpiresAt: "2026-08-01T08:01:00.000Z",
        nextAttemptAt: "2026-08-01T08:00:00.000Z",
        deadlineAt: "9999-12-31T23:59:59.999Z",
        createdAt: "2026-08-01T08:00:02.000Z",
      },
      {
        id: "live-unique",
        accountId: "account-a",
        collectItemId: "collect-unique",
        requestId: "request-live-unique",
        sku: "sku-unique",
        status: "PROCESSING",
        claimedSessionId: "collector-live-unique",
        claimExpiresAt: "2026-08-01T08:01:00.000Z",
        nextAttemptAt: "2026-08-01T08:00:00.000Z",
        deadlineAt: "9999-12-31T23:59:59.999Z",
        createdAt: "2026-08-01T08:00:03.000Z",
      },
      {
        id: "due-pending",
        accountId: "account-a",
        requestId: "request-due-pending",
        sku: "sku-due-pending",
        status: "PENDING",
        preferredSessionId: null,
        nextAttemptAt: "2026-08-01T08:00:00.000Z",
        deadlineAt: "2026-08-01T08:02:00.000Z",
        createdAt: "2026-08-01T08:00:04.000Z",
      },
    ],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const before = structuredClone(state);

  assert.equal(await repository.hasClaimableJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: at,
  }), true);
  assert.deepEqual(state, before);

  assert.equal((await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: at,
    claimExpiresAt: new Date("2026-08-01T08:00:25.000Z"),
  })).id, "due-pending");
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

test("JSON claim prioritizes new linked collection work before retries and unlinked requests", async () => {
  const due = "2026-07-31T00:00:00.000Z";
  const deadline = "9999-12-31T23:59:59.999Z";
  const job = (overrides) => ({
    accountId: "account-a",
    status: "PENDING",
    preferredSessionId: null,
    claimedSessionId: null,
    claimExpiresAt: null,
    nextAttemptAt: due,
    deadlineAt: deadline,
    createdAt: due,
    attemptCount: 0,
    refreshBundle: {},
    ...overrides,
  });
  const state = {
    collectorSessions: [activeSession("collector-a", "account-a")],
    collectorOzonEnrichmentJobs: [
      job({
        id: "job-unlinked-preferred",
        requestId: "request-unlinked-preferred",
        sku: "sku-unlinked-preferred",
        preferredSessionId: "collector-a",
      }),
      job({
        id: "job-linked-retry",
        collectItemId: "collect-linked-retry",
        requestId: "request-linked-retry",
        sku: "sku-linked-retry",
        attemptCount: 3,
      }),
      job({
        id: "job-linked-new",
        collectItemId: "collect-linked-new",
        requestId: "request-linked-new",
        sku: "sku-linked-new",
        createdAt: "2026-07-31T00:00:00.500Z",
      }),
    ],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });

  const claimed = await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: new Date("2026-07-31T00:00:00.750Z"),
    claimExpiresAt: new Date("2026-07-31T00:00:05.750Z"),
  });

  assert.equal(claimed.id, "job-linked-new");
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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_JOB_OWNERSHIP");
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

test("JSON atomic terminal write rejects a rotated Seller claim fence without side effects", async () => {
  const state = {
    collectorSessions: [activeSession("collector-owner", "account-a")],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  await repository.createOrGetJob({
    id: "job-context-fence",
    accountId: "account-a",
    requestId: "request-context-fence",
    sku: ACCOUNT_A_KEY.sku,
    preferredSessionId: null,
    refreshBundle: true,
    deadlineAt: new Date("2026-07-31T00:00:20.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  });
  const claimedContext = {
    sellerCompanyId: "2681910",
    revision: 4,
    observedAt: "2026-07-31T00:00:00.000Z",
  };
  await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-owner",
    now: new Date("2026-07-31T00:00:00.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:00:10.000Z"),
    claimFence: "claim-fence-original",
    captureContext: claimedContext,
  });
  state.collectorOzonEnrichmentJobs[0].claimFence = "claim-fence-rotated";

  await assert.rejects(repository.completeJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-owner",
    jobId: "job-context-fence",
    key: ACCOUNT_A_KEY,
    result: completeResult(920),
    responseHash: "context-fence-hash",
    capturedAt: new Date("2026-07-31T00:00:01.000Z"),
    expiresAt: new Date("2026-07-31T06:00:01.000Z"),
    captureContext: claimedContext,
    claimFence: "claim-fence-original",
    now: new Date("2026-07-31T00:00:01.000Z"),
  }), (error) => error?.code === "SELLER_CONTEXT_CHANGED" && error?.status === 409);

  assert.equal(state.collectorOzonEnrichmentJobs[0].status, "PROCESSING");
  assert.equal(state.collectorOzonEnrichmentCache, undefined);
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
    error: { status: 502, code: "ZONGZI_ENRICH_UPSTREAM_FAILED" },
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
    refreshBundle: true,
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
    refreshBundle: false,
    deadlineAt: new Date("2026-07-31T02:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:10:00.000Z"),
  });

  assert.deepEqual(retried, created);
});

test("JSON create-or-get preserves retry history across an expired HTTP wait window", async () => {
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

  const beforeReplay = structuredClone(state.collectorOzonEnrichmentJobs[0]);
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

  assert.deepEqual(retried, beforeReplay);

  const claimed = await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-retry",
    now: new Date("2026-07-31T00:00:31.000Z"),
    claimExpiresAt: new Date("2026-07-31T00:00:36.000Z"),
  });
  const succeeded = await completeTerminalJob(repository, {
    accountId: "account-a",
    collectorSessionId: "collector-retry",
    jobId: claimed.id,
    result: completeResult(818),
    now: new Date("2026-07-31T00:00:32.000Z"),
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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_JOB_ID_CONFLICT");
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
    refreshBundle: true,
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
    completeTerminalJob(repository, {
      accountId: "account-a",
      collectorSessionId: "collector-attacker",
      jobId: "job-success",
      result: completeResult(303),
      now: new Date("2026-07-31T00:11:00.000Z"),
    }),
    (error) => error?.code === "ZONGZI_ENRICHMENT_JOB_OWNERSHIP",
  );
  await assert.rejects(
    failTerminalJob(repository, {
      accountId: "account-a",
      collectorSessionId: "collector-attacker",
      jobId: "job-success",
      error: { code: "ATTACKER_ERROR" },
      now: new Date("2026-07-31T00:11:00.000Z"),
    }),
    (error) => error?.code === "ZONGZI_ENRICHMENT_JOB_OWNERSHIP",
  );
  const succeeded = await completeTerminalJob(repository, {
    accountId: "account-a",
    collectorSessionId: "collector-owner",
    jobId: "job-success",
    result: completeResult(303),
    now: new Date("2026-07-31T00:12:00.000Z"),
  });
  assert.equal(succeeded.status, "SUCCESS");
  assert.equal(succeeded.result.descriptionCategoryId, 303);

  await assert.rejects(
    failTerminalJob(repository, {
      accountId: "account-a",
      collectorSessionId: "collector-owner",
      jobId: "job-success",
      error: { code: "LATE_ERROR" },
      now: new Date("2026-07-31T00:13:00.000Z"),
    }),
    (error) => error?.code === "ZONGZI_ENRICHMENT_JOB_TERMINAL",
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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_SESSION_SCOPE");

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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_SESSION_SCOPE");
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
      }), (error) => error?.code === "ZONGZI_ENRICHMENT_SESSION_SCOPE");
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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_SCOPE_REQUIRED");
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
  await assert.rejects(pending, (error) => error?.code === "ZONGZI_ENRICHMENT_SESSION_SCOPE");
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
      : completeTerminalJob(repository, {
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
      (error) => error?.code === "ZONGZI_ENRICHMENT_SESSION_SCOPE",
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
    (error) => error?.code === "ZONGZI_ENRICHMENT_DATE_INVALID");
  await assert.rejects(jsonRepository.writeCompleteCache({
    key: ACCOUNT_A_KEY,
    result: null,
    responseHash: "null-result",
    executorSessionId: "collector-a",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T06:00:00.000Z"),
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_PAYLOAD_REQUIRED");
  await assert.rejects(jsonRepository.writeNegativeCache({
    key: ACCOUNT_A_KEY,
    error: null,
    responseHash: "null-error",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T00:01:00.000Z"),
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_PAYLOAD_REQUIRED");
  await assert.rejects(jsonRepository.completeJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-null-payload",
    key: ACCOUNT_A_KEY,
    result: null,
    responseHash: "null-job-result",
    capturedAt: new Date("2026-07-31T00:10:00.000Z"),
    expiresAt: new Date("2026-07-31T06:10:00.000Z"),
    now: new Date("2026-07-31T00:10:00.000Z"),
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_PAYLOAD_REQUIRED");
  await assert.rejects(jsonRepository.failJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-null-payload",
    key: ACCOUNT_A_KEY,
    error: null,
    responseHash: "null-job-error",
    capturedAt: new Date("2026-07-31T00:10:00.000Z"),
    expiresAt: new Date("2026-07-31T00:11:00.000Z"),
    now: new Date("2026-07-31T00:10:00.000Z"),
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_PAYLOAD_REQUIRED");

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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_PAYLOAD_REQUIRED");
  await assert.rejects(pgRepository.writeNegativeCache({
    key: ACCOUNT_A_KEY,
    error: null,
    responseHash: "null-error",
    capturedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T00:01:00.000Z"),
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_PAYLOAD_REQUIRED");
  await assert.rejects(pgRepository.completeJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-null-payload",
    key: ACCOUNT_A_KEY,
    result: null,
    responseHash: "null-job-result",
    capturedAt: new Date("2026-07-31T00:10:00.000Z"),
    expiresAt: new Date("2026-07-31T06:10:00.000Z"),
    now: new Date("2026-07-31T00:10:00.000Z"),
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_PAYLOAD_REQUIRED");
  await assert.rejects(pgRepository.failJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-null-payload",
    key: ACCOUNT_A_KEY,
    error: null,
    responseHash: "null-job-error",
    capturedAt: new Date("2026-07-31T00:10:00.000Z"),
    expiresAt: new Date("2026-07-31T00:11:00.000Z"),
    now: new Date("2026-07-31T00:10:00.000Z"),
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_PAYLOAD_REQUIRED");
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
    && error?.code === "ZONGZI_ENRICH_BUSY"
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
  assert.equal(calls[0], "BEGIN ISOLATION LEVEL READ COMMITTED");
  assert.match(calls[1], /pg_advisory_xact_lock/);
  assert.doesNotMatch(calls[2], /deadline_at>\$4|claim_expires_at>\$4/);
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.includes("COMMIT"), false);
});

for (const terminalStatus of ["success", "failure"]) {
  test(`PostgreSQL atomic terminal ${terminalStatus} preserves a rotated-fence 409 without cache mutation`, async () => {
    const calls = [];
    const client = {
      async query(sql, params = []) {
        const normalized = String(sql).replace(/\s+/g, " ").trim();
        calls.push({ sql: normalized, params });
        if (normalized.startsWith("UPDATE collector_ozon_enrichment_jobs")) {
          return { rows: [], rowCount: 0 };
        }
        if (normalized.startsWith("SELECT id")) {
          return { rows: [{ id: "collector-owner" }], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT * FROM collector_ozon_enrichment_jobs")) {
          return { rows: [{
            id: `job-pg-stale-${terminalStatus}`,
            account_id: "account-a",
            request_id: `request-pg-stale-${terminalStatus}`,
            sku: ACCOUNT_A_KEY.sku,
            status: "PROCESSING",
            claimed_session_id: "collector-owner",
            claim_expires_at: "2026-07-31T00:00:10.000Z",
            deadline_at: "2026-07-31T00:00:20.000Z",
            claim_fence: "claim-new",
            capture_context_json: {
              sellerCompanyId: "7311458",
              revision: 2,
              observedAt: "2026-07-31T00:00:02.000Z",
            },
            created_at: "2026-07-31T00:00:00.000Z",
            updated_at: "2026-07-31T00:00:02.000Z",
          }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const repository = createPostgresCollectorOzonEnrichmentRepository({
      pool: {
        async connect() { return client; },
        async query() { return { rows: [], rowCount: 0 }; },
      },
    });
    const common = {
      accountId: "account-a",
      collectorSessionId: "collector-owner",
      jobId: `job-pg-stale-${terminalStatus}`,
      key: ACCOUNT_A_KEY,
      responseHash: `pg-stale-${terminalStatus}-hash`,
      capturedAt: new Date("2026-07-31T00:00:03.000Z"),
      expiresAt: new Date("2026-07-31T06:00:03.000Z"),
      captureContext: {
        sellerCompanyId: "2681910",
        revision: 1,
        observedAt: "2026-07-31T00:00:01.000Z",
      },
      claimFence: "claim-old",
      now: new Date("2026-07-31T00:00:03.000Z"),
    };
    const operation = terminalStatus === "success"
      ? repository.completeJobAndCache({ ...common, result: completeResult(930) })
      : repository.failJobAndCache({
          ...common,
          error: { code: "SELLER_CONTEXT_CHANGED", status: 409 },
        });

    await assert.rejects(operation, (error) =>
      error?.code === "SELLER_CONTEXT_CHANGED" && error?.status === 409);
    assert.equal(calls.at(-1).sql, "ROLLBACK");
    assert.equal(
      calls.some(({ sql }) => sql.startsWith("INSERT INTO collector_ozon_enrichment_cache")),
      false,
    );
    assert.equal(calls.some(({ sql }) => sql === "COMMIT"), false);
  });
}

test("PostgreSQL job claim locks the account transaction and enforces the four-job limit", async () => {
  const calls = [];
  let processingCount = "3";
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT id")) {
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
  assert.equal(calls[0].sql, "BEGIN ISOLATION LEVEL READ COMMITTED");
  assert.match(calls[1].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[1].params, ["account-a"]);
  assert.match(calls[2].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[2].params, ["collector-ozon-seller:account-a:collector-a"]);
  assert.match(calls[3].sql, /SELECT id,seller_context_json FROM collector_sessions/);
  assert.match(calls[3].sql, /revoked_at IS NULL/);
  assert.match(calls[3].sql, /expires_at>\$3/);
  assert.equal(calls.some(call => call.sql.includes("attempt_count=attempt_count+1")), false);
  assert.match(calls[4].sql, /status='PROCESSING'/);
  assert.match(calls[4].sql, /claim_expires_at>/);
  assert.match(calls[5].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(calls[5].sql, /account_id=\$1/);
  assert.match(calls[5].sql, /claimed_session_id=\$2/);
  assert.match(calls[5].sql, /job\.created_at \+ INTERVAL '1 second'<=\$3/);
  assert.match(
    calls[5].sql,
    /ORDER BY CASE WHEN job\.collect_item_id IS NOT NULL THEN 0 ELSE 1 END, CASE WHEN job\.attempt_count=0 THEN 0 ELSE 1 END, CASE WHEN job\.preferred_session_id=\$2 THEN 0 ELSE 1 END/,
  );
  assert.match(calls[5].sql, /claim_expires_at=\$4/);
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

test("PostgreSQL availability uses one read-only account-session scoped query", async () => {
  const calls = [];
  const otherAccountJob = {
    account_id: "account-b",
    status: "PENDING",
    next_attempt_at: "2026-07-31T00:00:00.000Z",
    deadline_at: "2026-07-31T00:01:00.000Z",
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({
    pool: {
      async query(sql, params = []) {
        calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
        return { rows: [{ available: false, ignored: otherAccountJob }], rowCount: 1 };
      },
    },
  });

  assert.equal(await repository.hasClaimableJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: new Date("2026-07-31T00:00:10.000Z"),
  }), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [
    "account-a",
    "collector-a",
    new Date("2026-07-31T00:00:10.000Z"),
  ]);
  assert.match(calls[0].sql, /FROM collector_sessions AS session/);
  assert.match(calls[0].sql, /session\.account_id=\$1 AND session\.id=\$2/);
  assert.match(calls[0].sql, /session\.revoked_at IS NULL AND session\.expires_at>\$3/);
  assert.match(calls[0].sql, /job\.account_id=\$1/);
  assert.match(calls[0].sql, /job\.status='PENDING'/);
  assert.match(calls[0].sql, /job\.claim_expires_at<=\$3/);
  assert.doesNotMatch(calls[0].sql, /job\.deadline_at>\$3/);
  assert.match(calls[0].sql, /job\.next_attempt_at<=\$3/);
  assert.match(calls[0].sql, /job\.preferred_session_id=\$2/);
  assert.match(calls[0].sql, /job\.created_at \+ INTERVAL '1 second'<=\$3/);
  assert.match(calls[0].sql, /status='PROCESSING' AND claim_expires_at>\$3/);
  assert.equal(/\b(INSERT|UPDATE|DELETE)\b/.test(calls[0].sql), false);
  assert.equal(/pg_advisory|seller_context/i.test(calls[0].sql), false);
});

test("PostgreSQL Seller-context observation uses the account-session transaction fence and rejects stale watermarks", async () => {
  const newer = {
    sellerCompanyId: "7311458",
    revision: 5,
    observedAt: "2026-08-01T08:00:05.000Z",
  };
  const older = {
    sellerCompanyId: "2681910",
    revision: 4,
    observedAt: "2026-08-01T08:00:04.000Z",
  };
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT id,seller_context_json")) {
        return { rows: [{ id: "collector-a", seller_context_json: older }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE collector_sessions")) {
        return { rows: [{ seller_context_json: JSON.parse(params[2]) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({
    pool: { async connect() { return client; }, async query() { return { rows: [] }; } },
  });
  assert.deepEqual(await repository.advanceSellerContext({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    captureContext: newer,
    now: new Date("2026-08-01T08:00:05.000Z"),
  }), newer);
  assert.equal(calls[0].sql, "BEGIN ISOLATION LEVEL READ COMMITTED");
  assert.match(calls[1].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[1].params, ["collector-ozon-seller:account-a:collector-a"]);
  assert.match(calls[2].sql, /FOR UPDATE/);
  assert.equal(calls.at(-1).sql, "COMMIT");

  const staleCalls = [];
  const staleClient = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      staleCalls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT id,seller_context_json")) {
        return { rows: [{ id: "collector-a", seller_context_json: newer }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const staleRepository = createPostgresCollectorOzonEnrichmentRepository({
    pool: { async connect() { return staleClient; }, async query() { return { rows: [] }; } },
  });
  await assert.rejects(staleRepository.advanceSellerContext({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    captureContext: older,
    now: new Date("2026-08-01T08:00:06.000Z"),
  }), (error) => error?.code === "SELLER_CONTEXT_CHANGED" && error?.status === 409);
  assert.equal(staleCalls.some(({ sql }) => sql.startsWith("UPDATE collector_sessions")), false);
  assert.equal(staleCalls.at(-1).sql, "ROLLBACK");
});

test("PostgreSQL claim rejects an invalid session before checking account capacity", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT id")) {
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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_SESSION_SCOPE");
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
    refreshBundle: false,
    deadlineAt: new Date("2026-07-31T02:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:10:00.000Z"),
  });

  assert.equal(retried.id, "job-stable");
  assert.deepEqual(retried.refreshBundle, { revision: 1 });
  assert.match(calls[0].sql, /ON CONFLICT DO NOTHING/);
});

test("PostgreSQL create-or-get returns the existing fenced row after its HTTP wait expires", async () => {
  const calls = [];
  const resetRow = {
    id: "job-expired-stable",
    account_id: "account-a",
    request_id: "request-expired-stable",
    sku: "sku-expired-stable",
    status: "PROCESSING",
    refresh_bundle: true,
    preferred_session_id: "collector-retry",
    claimed_session_id: "collector-original",
    claim_expires_at: "2026-07-31T00:00:30.000Z", claim_fence: "original-fence",
    deadline_at: "2026-07-31T00:00:41.000Z",
    created_at: "2026-07-31T00:00:21.000Z",
    updated_at: "2026-07-31T00:00:21.000Z",
    completed_at: null,
    attempt_count: 2,
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
      if (normalized.startsWith("SELECT * FROM collector_ozon_enrichment_jobs")) {
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
  assert.equal(retried.status, "PROCESSING");
  assert.equal(retried.claimFence, "original-fence");
  assert.equal(retried.claimedSessionId, "collector-original");
  assert.equal(retried.attemptCount, 2);
  assert.equal(calls.some(call => call.sql.startsWith("UPDATE")), false);
  assert.match(calls[1].sql, /account_id=\$1 AND request_id=\$2 AND sku=\$3/);
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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_JOB_ID_CONFLICT");
});

test("create-or-get snapshots caller input once before validation and persistence", async () => {
  const base = {
    id: "job-snapshot-create",
    accountId: "account-a",
    requestId: "request-snapshot-create",
    sku: "sku-snapshot-create",
    preferredSessionId: null,
    deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
  };
  const jsonInput = changingRefreshBundleInput(base);
  const state = {};
  const jsonJob = await createJsonCollectorOzonEnrichmentRepository({ state })
    .createOrGetJob(jsonInput.input);
  assert.equal(jsonInput.readCount(), 1);
  assert.equal(jsonJob.refreshBundle, true);
  assert.equal(state.collectorOzonEnrichmentJobs[0].refreshBundle, true);

  const postgresInput = changingRefreshBundleInput(base);
  const calls = [];
  const postgresJob = await createPostgresCollectorOzonEnrichmentRepository({
    pool: {
      async query(sql, params = []) {
        calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
        return { rows: [{
          id: base.id,
          account_id: base.accountId,
          request_id: base.requestId,
          sku: base.sku,
          status: "PENDING",
          refresh_bundle: JSON.parse(params[4]),
          attempt_count: 0,
          next_attempt_at: base.createdAt.toISOString(),
          deadline_at: base.deadlineAt.toISOString(),
          created_at: base.createdAt.toISOString(),
          updated_at: base.createdAt.toISOString(),
        }], rowCount: 1 };
      },
    },
  }).createOrGetJob(postgresInput.input);
  assert.equal(postgresInput.readCount(), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[4], "true");
  assert.equal(postgresJob.refreshBundle, true);
});

test("create-or-get rejects sensitive caller fields before JSON save or PostgreSQL query", async () => {
  const input = {
    id: "job-sensitive-input",
    accountId: "account-a",
    requestId: "request-sensitive-input",
    sku: "sku-sensitive-input",
    preferredSessionId: null,
    refreshBundle: true,
    deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
    sellerToken: "must-not-reach-persistence",
  };

  const state = {};
  let jsonSaveCalled = false;
  const jsonRepository = createJsonCollectorOzonEnrichmentRepository({
    state,
    async persist() { jsonSaveCalled = true; },
  });
  await assert.rejects(
    jsonRepository.createOrGetJob(input),
    (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
  );
  assert.equal(state.collectorOzonEnrichmentJobs, undefined);
  assert.equal(jsonSaveCalled, false);

  let postgresQueried = false;
  const postgresRepository = createPostgresCollectorOzonEnrichmentRepository({
    pool: {
      async query() {
        postgresQueried = true;
        return { rows: [], rowCount: 0 };
      },
    },
  });
  await assert.rejects(
    postgresRepository.createOrGetJob(input),
    (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
  );
  assert.equal(postgresQueried, false);
});

test("create-or-get rejects unknown and server-owned caller fields before persistence", async (t) => {
  const invalidFields = [
    ["unknown top-level field", "debugMetadata", "not-part-of-the-contract"],
    ["non-empty refresh object", "refreshBundle", { debugMetadata: "not-part-of-the-contract" }],
    ["array refresh value", "refreshBundle", []],
    ["string refresh value", "refreshBundle", "true"],
    ["numeric refresh value", "refreshBundle", 1],
    ["attempt count", "attemptCount", 99],
    ["next attempt", "nextAttemptAt", new Date("2099-01-01T00:00:00.000Z")],
    ["last error", "lastError", { code: "FORGED" }],
    ["capture context", "captureContext", { sellerCompanyId: "forged", revision: 99 }],
  ];
  for (const [index, [name, field, value]] of invalidFields.entries()) {
    await t.test(name, async () => {
      const input = {
        id: `job-invalid-${index}`,
        accountId: "account-a",
        requestId: `request-invalid-${index}`,
        sku: "sku-invalid-input",
        preferredSessionId: null,
        refreshBundle: true,
        deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
        createdAt: new Date("2026-07-31T00:00:00.000Z"),
        [field]: value,
      };
      const state = {};
      let jsonSaveCalled = false;
      await assert.rejects(
        createJsonCollectorOzonEnrichmentRepository({
          state,
          async persist() { jsonSaveCalled = true; },
        }).createOrGetJob(input),
        (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
      );
      assert.equal(state.collectorOzonEnrichmentJobs, undefined);
      assert.equal(jsonSaveCalled, false);

      let postgresQueried = false;
      await assert.rejects(
        createPostgresCollectorOzonEnrichmentRepository({
          pool: {
            async query() {
              postgresQueried = true;
              return { rows: [], rowCount: 0 };
            },
          },
        }).createOrGetJob(input),
        (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
      );
      assert.equal(postgresQueried, false);
    });
  }
});

test("create-or-get derives internal retry and capture state for valid new jobs in both adapters", async () => {
  const createdAt = new Date("2026-07-31T00:00:00.000Z");
  const input = {
    id: "job-derived-state",
    accountId: "account-a",
    requestId: "request-derived-state",
    sku: "sku-derived-state",
    preferredSessionId: null,
    refreshBundle: true,
    deadlineAt: new Date("2026-07-31T01:00:00.000Z"),
    createdAt,
  };

  const jsonJob = await createJsonCollectorOzonEnrichmentRepository({ state: {} })
    .createOrGetJob(input);
  assert.deepEqual({
    status: jsonJob.status,
    attemptCount: jsonJob.attemptCount,
    nextAttemptAt: jsonJob.nextAttemptAt,
    lastError: jsonJob.lastError,
    captureContext: jsonJob.captureContext,
    claimedSessionId: jsonJob.claimedSessionId,
    claimExpiresAt: jsonJob.claimExpiresAt,
    result: jsonJob.result,
    error: jsonJob.error,
    completedAt: jsonJob.completedAt,
  }, {
    status: "PENDING",
    attemptCount: 0,
    nextAttemptAt: createdAt.toISOString(),
    lastError: null,
    captureContext: null,
    claimedSessionId: null,
    claimExpiresAt: null,
    result: null,
    error: null,
    completedAt: null,
  });

  const calls = [];
  const postgresRepository = createPostgresCollectorOzonEnrichmentRepository({
    pool: {
      async query(sql, params = []) {
        const normalized = String(sql).replace(/\s+/g, " ").trim();
        calls.push({ sql: normalized, params });
        return { rows: [{
          id: input.id,
          account_id: input.accountId,
          request_id: input.requestId,
          sku: input.sku,
          status: "PENDING",
          refresh_bundle: input.refreshBundle,
          preferred_session_id: null,
          attempt_count: 0,
          next_attempt_at: createdAt.toISOString(),
          last_error_json: null,
          capture_context_json: null,
          deadline_at: input.deadlineAt.toISOString(),
          created_at: createdAt.toISOString(),
          updated_at: createdAt.toISOString(),
        }], rowCount: 1 };
      },
    },
  });
  const postgresJob = await postgresRepository.createOrGetJob(input);
  assert.equal(postgresJob.attemptCount, 0);
  assert.equal(postgresJob.nextAttemptAt, createdAt.toISOString());
  assert.equal(postgresJob.lastError, null);
  assert.equal(postgresJob.captureContext, null);
  assert.match(
    calls[0].sql,
    /attempt_count, next_attempt_at, last_error_json, capture_context_json/,
  );
  assert.match(calls[0].sql, /0,\$8,NULL,NULL/);
});

test("create-or-get preserves server-owned retry and historical capture state in both adapters", async () => {
  const createdAt = new Date("2026-07-31T00:00:21.000Z");
  const existing = {
    id: "job-held-derived-reset",
    accountId: "account-a",
    requestId: "request-held-derived-reset",
    sku: "sku-held-derived-reset",
    status: "PENDING",
    preferredSessionId: null,
    claimedSessionId: null,
    claimExpiresAt: null,
    refreshBundle: false,
    attemptCount: 7,
    nextAttemptAt: "2098-01-01T00:00:00.000Z",
    lastError: { code: "LEGACY_ERROR" },
    captureContext: {
      sellerCompanyId: "legacy",
      revision: 7,
      observedAt: "2098-01-01T00:00:00.000Z",
    },
    deadlineAt: "2026-07-31T00:00:20.000Z",
    result: null,
    error: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    completedAt: null,
  };
  const input = {
    id: "replacement-id-must-not-win",
    accountId: existing.accountId,
    requestId: existing.requestId,
    sku: existing.sku,
    preferredSessionId: null,
    refreshBundle: true,
    deadlineAt: new Date("2026-07-31T00:00:41.000Z"),
    createdAt,
  };

  const state = { collectorOzonEnrichmentJobs: [structuredClone(existing)] };
  const jsonReset = await createJsonCollectorOzonEnrichmentRepository({ state })
    .createOrGetJob(input);
  assert.deepEqual(jsonReset, existing);

  const calls = [];
  const postgresRepository = createPostgresCollectorOzonEnrichmentRepository({
    pool: {
      async query(sql, params = []) {
        const normalized = String(sql).replace(/\s+/g, " ").trim();
        calls.push({ sql: normalized, params });
        if (normalized.startsWith("INSERT INTO collector_ozon_enrichment_jobs")) {
          return { rows: [], rowCount: 0 };
        }
        if (normalized.startsWith("SELECT * FROM collector_ozon_enrichment_jobs")) {
          return { rows: [{
            id: existing.id,
            account_id: existing.accountId,
            request_id: existing.requestId,
            sku: existing.sku,
            status: "PENDING",
            preferred_session_id: null,
            refresh_bundle: true,
            attempt_count: existing.attemptCount,
            next_attempt_at: existing.nextAttemptAt,
            last_error_json: existing.lastError,
            capture_context_json: existing.captureContext,
            deadline_at: input.deadlineAt.toISOString(),
            created_at: createdAt.toISOString(),
            updated_at: createdAt.toISOString(),
          }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  });
  const postgresReset = await postgresRepository.createOrGetJob(input);
  assert.equal(postgresReset.nextAttemptAt, existing.nextAttemptAt);
  assert.equal(postgresReset.attemptCount, existing.attemptCount);
  assert.deepEqual(postgresReset.captureContext, existing.captureContext);
  assert.equal(calls.some(call => call.sql.startsWith("UPDATE")), false);
});

test("JSON linked enqueue is idempotent and rejects a collect-item mismatch", async () => {
  const repository = createJsonCollectorOzonEnrichmentRepository({
    state: {
      caches: {
        collectBox: [
          collectItem("collect-a", "account-a"),
          collectItem("collect-other", "account-a"),
        ],
      },
    },
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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_COLLECT_ITEM_CONFLICT");
});

test("linked enqueue ignores terminal history and creates one fresh active job in both adapters", async () => {
  const now = new Date("2026-08-01T08:05:00.000Z");
  const terminal = {
    id: "job-linked-terminal",
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "collect-request-old",
    sku: ACCOUNT_A_KEY.sku,
    status: "FAILED",
    refreshBundle: {},
    attemptCount: 1,
    nextAttemptAt: "2026-08-01T08:00:00.000Z",
    deadlineAt: "9999-12-31T23:59:59.999Z",
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T08:01:00.000Z",
    completedAt: "2026-08-01T08:01:00.000Z",
  };
  const input = {
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "collect-request-fresh",
    sku: ACCOUNT_A_KEY.sku,
    refreshBundle: {},
    now,
  };
  const state = {
    caches: { collectBox: [collectItem("collect-a", "account-a")] },
    collectorOzonEnrichmentJobs: [structuredClone(terminal)],
  };
  const jsonJob = await createJsonCollectorOzonEnrichmentRepository({ state })
    .enqueueForCollect(input);
  assert.equal(jsonJob.status, "PENDING");
  assert.notEqual(jsonJob.id, terminal.id);
  assert.equal(state.collectorOzonEnrichmentJobs.length, 2);

  const calls = [];
  const postgresJob = await createPostgresCollectorOzonEnrichmentRepository({
    pool: {
      async query(sql, params = []) {
        const normalized = String(sql).replace(/\s+/g, " ").trim();
        calls.push({ sql: normalized, params });
        if (normalized.includes("collect_item_id=$2 AND sku=$3")) {
          return normalized.includes("status IN ('PENDING','PROCESSING')")
            ? { rows: [], rowCount: 0 }
            : { rows: [{
                ...terminal,
                account_id: terminal.accountId,
                collect_item_id: terminal.collectItemId,
                request_id: terminal.requestId,
                next_attempt_at: terminal.nextAttemptAt,
                deadline_at: terminal.deadlineAt,
                created_at: terminal.createdAt,
                updated_at: terminal.updatedAt,
                completed_at: terminal.completedAt,
              }], rowCount: 1 };
        }
        if (normalized.startsWith("INSERT INTO collector_ozon_enrichment_jobs")) {
          return { rows: [{
            id: "job-linked-fresh",
            account_id: input.accountId,
            collect_item_id: input.collectItemId,
            request_id: input.requestId,
            sku: input.sku,
            status: "PENDING",
            refresh_bundle: {},
            attempt_count: 0,
            next_attempt_at: now.toISOString(),
            deadline_at: "9999-12-31T23:59:59.999Z",
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
          }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  }).enqueueForCollect(input);
  assert.equal(postgresJob.id, "job-linked-fresh");
  assert.ok(calls.some((call) =>
    call.sql.includes("collect_item_id=$2 AND sku=$3")
    && call.sql.includes("status IN ('PENDING','PROCESSING')")));
});

test("collected complete evidence terminates active linked jobs in both adapters", async () => {
  const now = new Date("2026-08-01T08:05:00.000Z");
  const active = {
    id: "job-linked-active",
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "collect-request-active",
    sku: ACCOUNT_A_KEY.sku,
    status: "PROCESSING",
    claimedSessionId: "collector-a",
    claimExpiresAt: "2026-08-01T08:06:00.000Z",
    claimFence: "claim-active",
    refreshBundle: {},
    attemptCount: 1,
    nextAttemptAt: "2026-08-01T08:00:00.000Z",
    deadlineAt: "9999-12-31T23:59:59.999Z",
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T08:01:00.000Z",
  };
  const input = {
    accountId: active.accountId,
    collectItemId: active.collectItemId,
    sku: active.sku,
    now,
  };
  const duplicate = {
    ...structuredClone(active),
    id: "job-linked-active-duplicate",
    status: "PENDING",
    claimedSessionId: null,
    claimExpiresAt: null,
    claimFence: null,
    createdAt: "2026-08-01T08:02:00.000Z",
    updatedAt: "2026-08-01T08:02:00.000Z",
  };
  const crossAccountIdCollision = {
    ...structuredClone(active),
    accountId: "account-b",
    collectItemId: "collect-b",
    requestId: "collect-request-cross-account",
    status: "PENDING",
    claimedSessionId: null,
    claimExpiresAt: null,
    claimFence: null,
  };
  const state = {
    collectorOzonEnrichmentJobs: [
      structuredClone(active),
      duplicate,
      crossAccountIdCollision,
    ],
  };
  const jsonResult = await createJsonCollectorOzonEnrichmentRepository({ state })
    .completeLinkedJobsFromCollectEvidence(input);
  assert.equal(jsonResult.length, 1);
  assert.equal(state.collectorOzonEnrichmentJobs[0].status, "SUCCESS");
  assert.equal(state.collectorOzonEnrichmentJobs[0].claimFence, null);
  assert.equal(state.collectorOzonEnrichmentJobs[1].status, "FAILED");
  assert.deepEqual(state.collectorOzonEnrichmentJobs[1].error, {
    code: "ZONGZI_ENRICHMENT_DUPLICATE_SUPERSEDED",
    status: 409,
  });
  assert.equal(state.collectorOzonEnrichmentJobs[2].status, "PENDING");
  assert.equal(state.collectorOzonEnrichmentJobs[2].result, undefined);

  const calls = [];
  const postgresResult = await createPostgresCollectorOzonEnrichmentRepository({
    pool: {
      async query(sql, params = []) {
        const normalized = String(sql).replace(/\s+/g, " ").trim();
        calls.push({ sql: normalized, params });
        if (!normalized.startsWith("UPDATE collector_ozon_enrichment_jobs")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{
          ...active,
          account_id: active.accountId,
          collect_item_id: active.collectItemId,
          request_id: active.requestId,
          status: "SUCCESS",
          claimed_session_id: null,
          claim_expires_at: null,
          claim_fence: null,
          result_json: { status: "COMPLETE", source: "COLLECTED_PUBLIC_EVIDENCE" },
          next_attempt_at: active.nextAttemptAt,
          deadline_at: active.deadlineAt,
          created_at: active.createdAt,
          updated_at: now.toISOString(),
          completed_at: now.toISOString(),
        }], rowCount: 1 };
      },
    },
  }).completeLinkedJobsFromCollectEvidence(input);
  assert.equal(postgresResult.length, 1);
  assert.ok(calls[0].sql.includes("status IN ('PENDING','PROCESSING')"));
  assert.deepEqual(calls[0].params.slice(0, 3), [active.accountId, active.collectItemId, active.sku]);
});

test("linked enqueue snapshots caller input once before validation and persistence", async () => {
  const base = {
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "linked-snapshot-input",
    sku: "4862904234",
    now: new Date("2026-08-01T08:00:00.000Z"),
  };
  const jsonInput = changingRefreshBundleInput(base);
  const state = {
    caches: { collectBox: [collectItem("collect-a", "account-a")] },
  };
  const jsonJob = await createJsonCollectorOzonEnrichmentRepository({ state })
    .enqueueForCollect(jsonInput.input);
  assert.equal(jsonInput.readCount(), 1);
  assert.equal(jsonJob.refreshBundle, true);
  assert.equal(state.collectorOzonEnrichmentJobs[0].refreshBundle, true);

  const postgresInput = changingRefreshBundleInput(base);
  const calls = [];
  const postgresJob = await createPostgresCollectorOzonEnrichmentRepository({
    pool: {
      async query(sql, params = []) {
        const normalized = String(sql).replace(/\s+/g, " ").trim();
        calls.push({ sql: normalized, params });
        if (!normalized.startsWith("INSERT INTO collector_ozon_enrichment_jobs")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{
          id: "linked-snapshot-job",
          account_id: base.accountId,
          collect_item_id: base.collectItemId,
          request_id: base.requestId,
          sku: base.sku,
          status: "PENDING",
          refresh_bundle: JSON.parse(params[5]),
          attempt_count: 0,
          next_attempt_at: base.now.toISOString(),
          deadline_at: "9999-12-31T23:59:59.999Z",
          created_at: base.now.toISOString(),
          updated_at: base.now.toISOString(),
        }], rowCount: 1 };
      },
    },
  }).enqueueForCollect(postgresInput.input);
  assert.equal(postgresInput.readCount(), 1);
  const insert = calls.find((call) => call.sql.startsWith("INSERT INTO collector_ozon_enrichment_jobs"));
  assert.equal(insert.params[5], "true");
  assert.equal(postgresJob.refreshBundle, true);
});

test("linked enqueue rejects sensitive caller fields outside refreshBundle before persistence", async () => {
  const input = {
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "linked-sensitive-input",
    sku: "4862904234",
    refreshBundle: {},
    now: new Date("2026-08-01T08:00:00.000Z"),
    sellerToken: "must-not-reach-persistence",
  };
  const state = {
    caches: { collectBox: [collectItem("collect-a", "account-a")] },
  };
  let jsonSaveCalled = false;
  await assert.rejects(
    createJsonCollectorOzonEnrichmentRepository({
      state,
      async persist() { jsonSaveCalled = true; },
    }).enqueueForCollect(input),
    (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
  );
  assert.equal(state.collectorOzonEnrichmentJobs, undefined);
  assert.equal(jsonSaveCalled, false);

  let postgresQueried = false;
  await assert.rejects(
    createPostgresCollectorOzonEnrichmentRepository({
      pool: {
        async query() {
          postgresQueried = true;
          return { rows: [], rowCount: 0 };
        },
      },
    }).enqueueForCollect(input),
    (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
  );
  assert.equal(postgresQueried, false);
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
      (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
    );
    assert.equal(state.collectorOzonEnrichmentJobs, undefined);

    let queried = false;
    const postgresRepository = createPostgresCollectorOzonEnrichmentRepository({
      pool: { async query() { queried = true; return { rows: [] }; } },
    });
    await assert.rejects(
      postgresRepository.enqueueForCollect(input),
      (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
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
      (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
    );
    assert.equal(state.collectorOzonEnrichmentJobs, undefined);

    let queried = false;
    const postgresRepository = createPostgresCollectorOzonEnrichmentRepository({
      pool: { async query() { queried = true; return { rows: [] }; } },
    });
    await assert.rejects(
      postgresRepository.enqueueForCollect(input),
      (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
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
        jsonCode: "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
        jsonJobCreated: false,
        jsonSaveCalled: false,
        postgresCode: "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
        postgresQueried: false,
      });
    });
  }
});

test("linked enqueue rejects non-empty metadata outside the fixed refresh contract", async () => {
  const state = {
    caches: { collectBox: [collectItem("collect-a", "account-a")] },
  };
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
  const input = {
    accountId: "account-a",
    collectItemId: "collect-a",
    requestId: "safe-metadata-request",
    sku: "4862904234",
    refreshBundle,
    now: new Date("2026-08-01T08:00:00.000Z"),
  };
  let jsonSaveCalled = false;
  await assert.rejects(
    createJsonCollectorOzonEnrichmentRepository({
      state,
      async persist() { jsonSaveCalled = true; },
    }).enqueueForCollect(input),
    (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
  );
  assert.equal(state.collectorOzonEnrichmentJobs, undefined);
  assert.equal(jsonSaveCalled, false);

  let postgresQueried = false;
  await assert.rejects(
    createPostgresCollectorOzonEnrichmentRepository({
      pool: {
        async query() {
          postgresQueried = true;
          return { rows: [], rowCount: 0 };
        },
      },
    }).enqueueForCollect(input),
    (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
  );
  assert.equal(postgresQueried, false);
});

test("linked enqueue rejects forged internal job state before either persistence adapter", async () => {
  const state = {
    caches: { collectBox: [collectItem("collect-a", "account-a")] },
  };
  const input = {
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
  };
  let jsonSaveCalled = false;
  await assert.rejects(
    createJsonCollectorOzonEnrichmentRepository({
      state,
      async persist() { jsonSaveCalled = true; },
    }).enqueueForCollect(input),
    (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
  );
  assert.equal(state.collectorOzonEnrichmentJobs, undefined);
  assert.equal(jsonSaveCalled, false);

  let postgresQueried = false;
  await assert.rejects(
    createPostgresCollectorOzonEnrichmentRepository({
      pool: {
        async query() {
          postgresQueried = true;
          return { rows: [], rowCount: 0 };
        },
      },
    }).enqueueForCollect(input),
    (error) => error?.code === "ZONGZI_ENRICHMENT_SENSITIVE_DATA",
  );
  assert.equal(postgresQueried, false);
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
    { code: "ZONGZI_ENRICHMENT_COLLECT_ITEM_NOT_FOUND", status: 404 },
    { code: "ZONGZI_ENRICHMENT_COLLECT_ITEM_NOT_FOUND", status: 404 },
  ]);
  assert.equal(state.collectorOzonEnrichmentJobs, undefined);
});

test("JSON linked retries wait until due and persist the safe service error projection", async () => {
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
      message: "Seller /api/v1/search: net::ERR_CONNECTION_RESET",
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
  assert.deepEqual(deferred.lastError, { code: "OZON_RETRYABLE", status: 503, message: "Seller /api/v1/search: net::ERR_CONNECTION_RESET" });
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

test("JSON claim normalizes legacy duplicate active linked jobs and preserves superseded audit history", async () => {
  const baseJob = (id, requestId, createdAt, overrides = {}) => ({
    id,
    accountId: "account-a",
    collectItemId: "collect-legacy-duplicate",
    requestId,
    sku: ACCOUNT_A_KEY.sku,
    status: "PENDING",
    preferredSessionId: null,
    claimedSessionId: null,
    claimExpiresAt: null,
    claimFence: null,
    refreshBundle: {},
    attemptCount: 0,
    nextAttemptAt: createdAt,
    lastError: null,
    captureContext: null,
    deadlineAt: "9999-12-31T23:59:59.999Z",
    result: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    ...overrides,
  });
  const state = {
    caches: { collectBox: [collectItem("collect-legacy-duplicate", "account-a")] },
    collectorSessions: [activeSession("collector-a", "account-a", {
      expiresAt: "2026-08-02T00:00:00.000Z",
    })],
    collectorOzonEnrichmentJobs: [
      baseJob("legacy-linked-a", "legacy-request-a", "2026-08-01T07:59:58.000Z"),
      baseJob("legacy-linked-b", "legacy-request-b", "2026-08-01T07:59:59.000Z", {
        status: "PROCESSING",
        claimedSessionId: "collector-a",
        claimExpiresAt: "2026-08-01T08:01:00.000Z",
        claimFence: "legacy-fence",
      }),
      baseJob("legacy-linked-c", "legacy-request-c", "2026-08-01T08:00:00.000Z"),
      baseJob("legacy-linked-b", "legacy-request-cross-account", "2026-08-01T08:00:00.500Z", {
        accountId: "account-b",
        collectItemId: "collect-legacy-cross-account",
        sku: "sku-cross-account",
      }),
    ],
  };
  let persists = 0;
  const repository = createJsonCollectorOzonEnrichmentRepository({
    state,
    async persist() { persists += 1; },
  });

  const claimed = await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: new Date("2026-08-01T08:00:01.000Z"),
    claimExpiresAt: new Date("2026-08-01T08:01:01.000Z"),
    claimFence: "canonical-fence",
    captureContext: {
      sellerCompanyId: "2681910",
      revision: 1,
      observedAt: "2026-08-01T08:00:01.000Z",
    },
  });

  assert.equal(claimed.id, "legacy-linked-a");
  assert.equal(persists >= 1, true);
  assert.equal(state.collectorOzonEnrichmentJobs.length, 4, "superseded rows remain auditable");
  const active = state.collectorOzonEnrichmentJobs.filter((job) =>
    job.accountId === "account-a" && ["PENDING", "PROCESSING"].includes(job.status));
  assert.deepEqual(active.map(({ id }) => id), ["legacy-linked-a"]);
  for (const duplicateId of ["legacy-linked-b", "legacy-linked-c"]) {
    const duplicate = state.collectorOzonEnrichmentJobs.find(
      ({ id, accountId }) => id === duplicateId && accountId === "account-a",
    );
    assert.equal(duplicate.status, "FAILED");
    assert.deepEqual(duplicate.error, {
      code: "ZONGZI_ENRICHMENT_DUPLICATE_SUPERSEDED",
      status: 409,
    });
    assert.deepEqual(duplicate.lastError, duplicate.error);
    assert.equal(duplicate.claimedSessionId, null);
    assert.equal(duplicate.claimExpiresAt, null);
    assert.equal(duplicate.claimFence, null);
    assert.equal(duplicate.completedAt, "2026-08-01T08:00:01.000Z");
  }
  const crossAccountCollision = state.collectorOzonEnrichmentJobs.find(
    ({ id, accountId }) => id === "legacy-linked-b" && accountId === "account-b",
  );
  assert.equal(crossAccountCollision.status, "PENDING");
  assert.equal(crossAccountCollision.error, null);
  assert.equal(crossAccountCollision.completedAt, null);
});

test("JSON tenant-scoped enqueue and claim never normalize another account's legacy duplicates", async () => {
  const legacyJob = (id, requestId, createdAt) => ({
    id,
    accountId: "account-b",
    collectItemId: "collect-legacy-b",
    requestId,
    sku: "sku-legacy-b",
    status: "PENDING",
    preferredSessionId: null,
    claimedSessionId: null,
    claimExpiresAt: null,
    claimFence: null,
    refreshBundle: {},
    attemptCount: 0,
    nextAttemptAt: createdAt,
    lastError: null,
    captureContext: null,
    deadlineAt: "9999-12-31T23:59:59.999Z",
    result: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  });
  const state = {
    caches: { collectBox: [
      collectItem("collect-tenant-a", "account-a"),
      collectItem("collect-legacy-b", "account-b"),
    ] },
    collectorSessions: [activeSession("collector-a", "account-a", {
      expiresAt: "2026-08-02T00:00:00.000Z",
    })],
    collectorOzonEnrichmentJobs: [
      legacyJob("legacy-b-a", "legacy-b-request-a", "2026-08-01T07:59:58.000Z"),
      legacyJob("legacy-b-b", "legacy-b-request-b", "2026-08-01T07:59:59.000Z"),
    ],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const beforeB = structuredClone(state.collectorOzonEnrichmentJobs);

  const enqueuedA = await repository.enqueueForCollect({
    accountId: "account-a",
    collectItemId: "collect-tenant-a",
    requestId: "tenant-a-request",
    sku: "sku-tenant-a",
    refreshBundle: {},
    now: new Date("2026-08-01T08:00:00.000Z"),
  });
  assert.deepEqual(
    state.collectorOzonEnrichmentJobs.filter((job) => job.accountId === "account-b"),
    beforeB,
  );

  const claimedA = await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: new Date("2026-08-01T08:00:01.000Z"),
    claimExpiresAt: new Date("2026-08-01T08:01:01.000Z"),
    claimFence: "tenant-a-fence",
    captureContext: {
      sellerCompanyId: "2681910",
      revision: 1,
      observedAt: "2026-08-01T08:00:01.000Z",
    },
  });
  assert.equal(claimedA.id, enqueuedA.id);
  assert.deepEqual(
    state.collectorOzonEnrichmentJobs.filter((job) => job.accountId === "account-b"),
    beforeB,
  );
});

test("JSON late failure from an expired claim cannot mutate a same-session reclaim", async () => {
  const state = {
    caches: { collectBox: [collectItem("collect-fenced", "account-a")] },
    collectorSessions: [activeSession("collector-a", "account-a", {
      expiresAt: "2026-08-02T00:00:00.000Z",
    })],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const job = await repository.enqueueForCollect({
    accountId: "account-a",
    collectItemId: "collect-fenced",
    requestId: "collect-request-fenced",
    sku: ACCOUNT_A_KEY.sku,
    refreshBundle: {},
    now: new Date("2026-08-01T08:00:00.000Z"),
  });
  const oldCaptureContext = {
    sellerCompanyId: "2681910",
    revision: 1,
    observedAt: "2026-08-01T08:00:00.000Z",
  };
  await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: new Date("2026-08-01T08:00:00.000Z"),
    claimExpiresAt: new Date("2026-08-01T08:00:05.000Z"),
    claimFence: "claim-old",
    captureContext: oldCaptureContext,
  });
  const reclaimed = await repository.claimNextJob({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    now: new Date("2026-08-01T08:00:05.000Z"),
    claimExpiresAt: new Date("2026-08-01T08:00:20.000Z"),
    claimFence: "claim-new",
    captureContext: {
      sellerCompanyId: "7311458",
      revision: 2,
      observedAt: "2026-08-01T08:00:05.000Z",
    },
  });
  assert.equal(reclaimed.id, job.id);
  const beforeLateFailure = structuredClone(state);

  await assert.rejects(repository.deferClaim({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: job.id,
    error: { code: "SELLER_CONTEXT_CHANGED", status: 409 },
    now: new Date("2026-08-01T08:00:06.000Z"),
    claimFence: "claim-old",
    captureContext: oldCaptureContext,
  }), (error) => error?.code === "SELLER_CONTEXT_CHANGED" && error?.status === 409);
  assert.deepEqual(state, beforeLateFailure);
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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_JOB_NOT_FOUND");
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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_JOB_NOT_FOUND");
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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_CAPTURE_CONTEXT_INVALID");
});

test("JSON Seller-context watermark linearizes switch-before-result and result-before-switch", async () => {
  const makeState = () => ({
    collectorSessions: [activeSession("collector-a", "account-a", {
      expiresAt: "2026-08-02T00:00:00.000Z",
    })],
  });
  const oldContext = {
    sellerCompanyId: "2681910",
    revision: 4,
    observedAt: "2026-08-01T08:00:00.000Z",
  };
  const newContext = {
    sellerCompanyId: "7311458",
    revision: 5,
    observedAt: "2026-08-01T08:00:02.000Z",
  };
  const prepare = async (state, suffix) => {
    const repository = createJsonCollectorOzonEnrichmentRepository({ state });
    await repository.createOrGetJob({
      id: `job-watermark-${suffix}`,
      accountId: "account-a",
      requestId: `request-watermark-${suffix}`,
      sku: ACCOUNT_A_KEY.sku,
      preferredSessionId: null,
      refreshBundle: true,
      deadlineAt: new Date("2026-08-01T09:00:00.000Z"),
      createdAt: new Date("2026-08-01T08:00:00.000Z"),
    });
    await repository.advanceSellerContext({
      accountId: "account-a",
      collectorSessionId: "collector-a",
      captureContext: oldContext,
      now: new Date("2026-08-01T08:00:00.000Z"),
    });
    const job = await repository.claimNextJob({
      accountId: "account-a",
      collectorSessionId: "collector-a",
      captureContext: oldContext,
      claimFence: `fence-watermark-${suffix}`,
      now: new Date("2026-08-01T08:00:00.000Z"),
      claimExpiresAt: new Date("2026-08-01T08:01:00.000Z"),
    });
    return { repository, job };
  };

  const switchedState = makeState();
  const switched = await prepare(switchedState, "switched");
  await switched.repository.advanceSellerContext({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    captureContext: newContext,
    now: new Date("2026-08-01T08:00:02.000Z"),
  });
  await assert.rejects(switched.repository.completeJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: switched.job.id,
    key: ACCOUNT_A_KEY,
    result: completeResult(268),
    responseHash: "watermark-stale-result",
    captureContext: oldContext,
    claimFence: "fence-watermark-switched",
    capturedAt: new Date("2026-08-01T08:00:03.000Z"),
    expiresAt: new Date("2026-08-01T14:00:03.000Z"),
    now: new Date("2026-08-01T08:00:03.000Z"),
  }), (error) => error?.code === "SELLER_CONTEXT_CHANGED" && error?.status === 409);
  assert.notEqual(switchedState.collectorOzonEnrichmentJobs[0].status, "SUCCESS");
  assert.deepEqual(switchedState.collectorOzonEnrichmentCache || [], []);

  const failedAfterSwitchState = makeState();
  const failedAfterSwitch = await prepare(failedAfterSwitchState, "failed-after-switch");
  await failedAfterSwitch.repository.advanceSellerContext({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    captureContext: newContext,
    now: new Date("2026-08-01T08:00:02.000Z"),
  });
  await assert.rejects(failedAfterSwitch.repository.failJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: failedAfterSwitch.job.id,
    key: ACCOUNT_A_KEY,
    error: { status: 404, code: "ZONGZI_ENRICH_NOT_FOUND" },
    responseHash: "watermark-stale-failure",
    captureContext: oldContext,
    claimFence: "fence-watermark-failed-after-switch",
    capturedAt: new Date("2026-08-01T08:00:03.000Z"),
    expiresAt: new Date("2026-08-01T08:01:03.000Z"),
    now: new Date("2026-08-01T08:00:03.000Z"),
  }), (error) => error?.code === "SELLER_CONTEXT_CHANGED" && error?.status === 409);
  assert.equal(failedAfterSwitchState.collectorOzonEnrichmentJobs[0].status, "PROCESSING");
  assert.deepEqual(failedAfterSwitchState.collectorOzonEnrichmentCache || [], []);

  const committedState = makeState();
  const committed = await prepare(committedState, "committed");
  await committed.repository.completeJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: committed.job.id,
    key: ACCOUNT_A_KEY,
    result: completeResult(269),
    responseHash: "watermark-current-result",
    captureContext: oldContext,
    claimFence: "fence-watermark-committed",
    capturedAt: new Date("2026-08-01T08:00:01.000Z"),
    expiresAt: new Date("2026-08-01T14:00:01.000Z"),
    now: new Date("2026-08-01T08:00:01.000Z"),
  });
  await committed.repository.advanceSellerContext({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    captureContext: newContext,
    now: new Date("2026-08-01T08:00:02.000Z"),
  });
  assert.equal(committedState.collectorOzonEnrichmentJobs[0].status, "SUCCESS");
  assert.equal(committedState.collectorOzonEnrichmentCache[0].status, "COMPLETE");
});

test("JSON Seller-context watermark rejects stale observations and deterministically keeps the newest concurrent observation", async () => {
  const state = {
    collectorSessions: [
      activeSession("collector-a", "account-a", { expiresAt: "2026-08-02T00:00:00.000Z" }),
      activeSession("collector-b", "account-b", { expiresAt: "2026-08-02T00:00:00.000Z" }),
    ],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const older = {
    sellerCompanyId: "2681910",
    revision: 8,
    observedAt: "2026-08-01T08:00:01.000Z",
  };
  const newer = {
    sellerCompanyId: "7311458",
    revision: 9,
    observedAt: "2026-08-01T08:00:02.000Z",
  };
  const concurrent = await Promise.allSettled([
    repository.advanceSellerContext({ accountId: "account-a", collectorSessionId: "collector-a", captureContext: newer, now: new Date(newer.observedAt) }),
    repository.advanceSellerContext({ accountId: "account-a", collectorSessionId: "collector-a", captureContext: older, now: new Date(older.observedAt) }),
  ]);
  assert.equal(concurrent.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(concurrent.filter(({ status }) => status === "rejected").length, 1);
  assert.deepEqual(state.collectorSessions[0].sellerContext, newer);
  assert.equal(state.collectorSessions[1].sellerContext, undefined);
  await assert.rejects(repository.advanceSellerContext({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    captureContext: older,
    now: new Date("2026-08-01T08:00:03.000Z"),
  }), (error) => error?.code === "SELLER_CONTEXT_CHANGED");
});

test("JSON terminal failure increments and returns the persisted attemptCount", async () => {
  const state = {
    collectorSessions: [activeSession("collector-a", "account-a", {
      expiresAt: "2026-08-02T00:00:00.000Z",
    })],
    collectorOzonEnrichmentJobs: [{
      id: "job-failed-attempt-json",
      accountId: "account-a",
      requestId: "failed-attempt-json",
      sku: ACCOUNT_A_KEY.sku,
      status: "PROCESSING",
      claimedSessionId: "collector-a",
      claimExpiresAt: "2026-08-01T08:01:00.000Z",
      deadlineAt: "9999-12-31T23:59:59.999Z",
      attemptCount: 3,
      createdAt: "2026-08-01T08:00:00.000Z",
    }],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });

  const failed = await repository.failJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-failed-attempt-json",
    key: ACCOUNT_A_KEY,
    error: { status: 404, code: "ZONGZI_ENRICH_NOT_FOUND" },
    responseHash: "failed-attempt-json-hash",
    capturedAt: new Date("2026-08-01T08:00:01.000Z"),
    expiresAt: new Date("2026-08-01T08:01:01.000Z"),
    now: new Date("2026-08-01T08:00:01.000Z"),
  });

  assert.equal(failed.attemptCount, 4);
  assert.equal(state.collectorOzonEnrichmentJobs[0].attemptCount, 4);
});

test("PostgreSQL terminal failure increments attemptCount in the atomic job write", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("UPDATE collector_ozon_enrichment_jobs")) {
        return { rows: [{
          id: "job-failed-attempt-pg",
          account_id: "account-a",
          request_id: "failed-attempt-pg",
          sku: ACCOUNT_A_KEY.sku,
          status: "FAILED",
          attempt_count: 4,
          error_json: { status: 404, code: "ZONGZI_ENRICH_NOT_FOUND" },
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

  const failed = await repository.failJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-failed-attempt-pg",
    key: ACCOUNT_A_KEY,
    error: { status: 404, code: "ZONGZI_ENRICH_NOT_FOUND" },
    responseHash: "failed-attempt-pg-hash",
    capturedAt: new Date("2026-08-01T08:00:01.000Z"),
    expiresAt: new Date("2026-08-01T08:01:01.000Z"),
    now: new Date("2026-08-01T08:00:01.000Z"),
  });

  const jobWrite = calls.find((call) => call.sql.startsWith("UPDATE collector_ozon_enrichment_jobs"));
  assert.match(jobWrite.sql, /attempt_count=attempt_count\+1/);
  assert.equal(failed.attemptCount, 4);
});

test("PostgreSQL linked enqueue, due claim, defer, and capture evidence stay account scoped", async () => {
  const calls = [];
  const captureEvidence = {
    sellerCompanyId: "2681910",
    revision: 4,
    observedAt: "2026-08-01T08:00:00.000Z",
  };
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
  pool.connect = async () => ({ query: pool.query.bind(pool), release() {} });
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
    error: { code: "OZON_RETRYABLE", status: 503, message: "safe upstream explanation" },
    captureContext: captureEvidence,
    claimFence: "claim-fenced-defer",
    now: new Date("2026-08-01T08:00:01.000Z"),
  });

  const insertCall = calls.find((call) => call.sql.startsWith("INSERT INTO collector_ozon_enrichment_jobs"));
  const deferCall = calls.find((call) => call.sql.startsWith("UPDATE collector_ozon_enrichment_jobs"));
  assert.match(insertCall.sql, /FROM collect_items AS collect_item/);
  assert.match(insertCall.sql, /collect_item\.account_id=\$2/);
  assert.match(insertCall.sql, /ON CONFLICT \(account_id, request_id, sku\) DO NOTHING/);
  assert.match(deferCall.sql, /WHERE account_id=\$1 AND claimed_session_id=\$2 AND id=\$3/);
  assert.match(deferCall.sql, /attempt_count=attempt_count\+1/);
  assert.match(deferCall.sql, /last_error_json=\$5::jsonb/);
  assert.match(deferCall.sql, /next_attempt_at=\$4 \+ CASE/);
  assert.match(deferCall.sql, /claim_fence=\$11/);
  assert.match(deferCall.sql, /capture_context_json IS NOT DISTINCT FROM \$12::jsonb/);
  assert.match(
    deferCall.sql,
    /CASE WHEN attempt_count=0 THEN \$6::double precision WHEN attempt_count=1 THEN \$7::double precision WHEN attempt_count=2 THEN \$8::double precision WHEN attempt_count=3 THEN \$9::double precision ELSE \$10::double precision END \* INTERVAL '1 millisecond'/,
  );
  assert.equal(deferCall.params[4], JSON.stringify({ code: "OZON_RETRYABLE", status: 503, message: "safe upstream explanation" }));
  assert.deepEqual(deferCall.params.slice(5), [
    30_000,
    120_000,
    600_000,
    1_800_000,
    3_600_000,
    "claim-fenced-defer",
    JSON.stringify(captureEvidence),
  ]);

  const claimClientCalls = [];
  const claimClient = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      claimClientCalls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT id")) {
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
        if (normalized.includes("collect_item_id=$2 AND sku=$3")) {
          return params[1] === "collect-a"
            ? { rows: [existing], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (normalized.startsWith("INSERT INTO collector_ozon_enrichment_jobs")) {
          return { rows: [], rowCount: 0 };
        }
        if (normalized.includes("request_id=$2 AND sku=$3")) {
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
  }), (error) => error?.code === "ZONGZI_ENRICHMENT_COLLECT_ITEM_CONFLICT");
  assert.ok(calls.some((entry) => /collect_item_id=\$2 AND sku=\$3/.test(entry.sql)));
  assert.ok(calls.some((entry) => /request_id=\$2 AND sku=\$3/.test(entry.sql)));
});

test("PostgreSQL defer classifies a same-session rotated fence as Seller context changed", async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("UPDATE collector_ozon_enrichment_jobs")) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT id")) {
        return { rows: [{ id: "collector-a" }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT * FROM collector_ozon_enrichment_jobs")) {
        return { rows: [{
          id: "job-fence-rotated-pg",
          account_id: "account-a",
          request_id: "request-fence-rotated-pg",
          sku: ACCOUNT_A_KEY.sku,
          status: "PROCESSING",
          claimed_session_id: "collector-a",
          claim_expires_at: "2026-08-01T08:01:00.000Z",
          deadline_at: "9999-12-31T23:59:59.999Z",
          claim_fence: "claim-new",
          capture_context_json: {
            sellerCompanyId: "7311458",
            revision: 2,
            observedAt: "2026-08-01T08:00:05.000Z",
          },
          created_at: "2026-08-01T08:00:00.000Z",
          updated_at: "2026-08-01T08:00:05.000Z",
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  pool.connect = async () => ({ query: pool.query.bind(pool), release() {} });
  const repository = createPostgresCollectorOzonEnrichmentRepository({
    pool,
  });

  await assert.rejects(repository.deferClaim({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-fence-rotated-pg",
    error: { code: "SELLER_CONTEXT_CHANGED", status: 409 },
    captureContext: {
      sellerCompanyId: "2681910",
      revision: 1,
      observedAt: "2026-08-01T08:00:00.000Z",
    },
    claimFence: "claim-old",
    now: new Date("2026-08-01T08:00:06.000Z"),
  }), (error) => error?.code === "SELLER_CONTEXT_CHANGED" && error?.status === 409);
  const update = calls.find(({ sql }) => sql.startsWith("UPDATE collector_ozon_enrichment_jobs"));
  assert.equal(update.params[10], "claim-old");
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
          claim_fence: params[7],
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
    claimFence: "capture-pg-fence",
    capturedAt: new Date("2026-08-01T08:00:01.000Z"),
    expiresAt: new Date("2026-08-01T14:00:01.000Z"),
    now: new Date("2026-08-01T08:00:01.000Z"),
  });

  const jobWrite = calls.find((call) => call.sql.startsWith("UPDATE collector_ozon_enrichment_jobs"));
  const cacheWrite = calls.find((call) => call.sql.startsWith("INSERT INTO collector_ozon_enrichment_cache"));
  assert.deepEqual(completed.captureContext, captureContext);
  assert.match(jobWrite.sql, /capture_context_json=\$7::jsonb/);
  assert.match(jobWrite.sql, /claim_fence=\$8/);
  assert.match(jobWrite.sql, /capture_context_json IS NOT DISTINCT FROM \$7::jsonb/);
  assert.equal(jobWrite.params[6], JSON.stringify(captureContext));
  assert.equal(jobWrite.params[7], "capture-pg-fence");
  assert.match(cacheWrite.sql, /capture_context_json/);
  assert.equal(cacheWrite.params[11], JSON.stringify(captureContext));
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("PostgreSQL terminal completion joins a caller-owned collect-item transaction", async () => {
  const calls = [];
  const transactionClient = {
    async connect() { throw new Error("an already-connected pg.Client must not reconnect"); },
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("UPDATE collector_ozon_enrichment_jobs")) {
        return { rows: [{
          id: "job-caller-transaction",
          account_id: "account-a",
          collect_item_id: "collect-a",
          request_id: "caller-transaction",
          sku: ACCOUNT_A_KEY.sku,
          status: "SUCCESS",
          attempt_count: 2,
          result_json: completeResult(270),
          deadline_at: "9999-12-31T23:59:59.999Z",
          created_at: "2026-08-01T08:00:00.000Z",
          updated_at: "2026-08-01T08:00:01.000Z",
          completed_at: "2026-08-01T08:00:01.000Z",
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { throw new Error("a caller-owned pg.Client must not be released"); },
  };
  const repository = createPostgresCollectorOzonEnrichmentRepository({
    pool: transactionClient,
    transactionOwner: "caller",
  });

  const completed = await repository.completeJobAndCache({
    accountId: "account-a",
    collectorSessionId: "collector-a",
    jobId: "job-caller-transaction",
    key: ACCOUNT_A_KEY,
    result: completeResult(270),
    responseHash: "caller-transaction-hash",
    capturedAt: new Date("2026-08-01T08:00:01.000Z"),
    expiresAt: new Date("2026-08-01T14:00:01.000Z"),
    now: new Date("2026-08-01T08:00:01.000Z"),
  });

  assert.equal(completed.status, "SUCCESS");
  assert.equal(calls.some((call) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(call.sql)), false);
  assert.equal(calls.filter((call) => call.sql.startsWith("UPDATE collector_ozon_enrichment_jobs")).length, 1);
  assert.equal(calls.filter((call) => call.sql.startsWith("INSERT INTO collector_ozon_enrichment_cache")).length, 1);
});

test('expired linked claims rotate fences without counting elapsed time as failure', async () => {
 const start=new Date('2026-07-31T00:00:00.000Z');
 const state={collectorSessions:[activeSession('collector-a','account-a')],caches:{collectBox:[collectItem('item-timeout','account-a')]}};
 const repository=createJsonCollectorOzonEnrichmentRepository({state});
 await repository.enqueueForCollect({accountId:'account-a',collectItemId:'item-timeout',requestId:'timeout-repeat',sku:'4862904234',refreshBundle:true,now:start});
 let first;
 for(let i=0;i<6;i++){
  const at=new Date(start.getTime()+i*31000);
  const job=await repository.claimNextJob({accountId:'account-a',collectorSessionId:'collector-a',now:at,claimExpiresAt:new Date(at.getTime()+30000)});
  if(i===0)first=job;
  assert.ok(job);assert.equal(job.attemptCount,0);
 }
 const final=await repository.readJob({accountId:'account-a',jobId:first.id});
 assert.equal(final.status,'PROCESSING');assert.equal(final.attemptCount,0);
 assert.equal(final.error,null);assert.equal(final.lastError,null);
});

test('repair PostgreSQL: expired claims, progress, late commits and takeover retain atomic fences', {
  skip: !process.env.SONLI_MIGRATION_TEST_DATABASE_URL && 'SONLI_MIGRATION_TEST_DATABASE_URL is not configured',
  timeout: 30_000,
}, async () => {
  const { Pool } = await import('pg');
  const { readdir, readFile } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const schema = `collector_repair_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: process.env.SONLI_MIGRATION_TEST_DATABASE_URL,
    options: `-c search_path=${schema},public` });
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    const dir = new URL('../db/migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort()) {
      let sql = await readFile(new URL(file, dir), 'utf8');
      // Migration 120 qualifies a restore helper as public; keep that helper in
      // this test's isolated schema while applying the full current migration set.
      if (file === '120_database_restore_compatibility.sql') {
        sql = sql.replaceAll('public.', `${schema}.`).replace('search_path = public,', `search_path = ${schema},`);
      }
      await pool.query(sql);
    }
    await pool.query("INSERT INTO accounts(id,username,display_name,role,status) VALUES ('repair-account','repair','repair','user','active')");
    await pool.query("INSERT INTO sessions(token,account_id,issued_at,expires_at) VALUES ('repair-web','repair-account','2026-08-01','9999-12-31')");
    const context = { sellerCompanyId: '2681910', revision: 1, observedAt: '2026-08-01T08:00:00.000Z' };
    for (const id of ['executor-a', 'executor-b']) await pool.query(
      `INSERT INTO collector_sessions(id,token_hash,account_id,parent_session_token,permissions,expires_at,seller_context_json)
       VALUES ($1,$1,'repair-account','repair-web','["collector.ozon.read"]','9999-12-31',$2::jsonb)`,
      [id, JSON.stringify(context)],
    );
    await pool.query(`INSERT INTO collect_items(id,account_id,source,identity_key,source_sku,status,summary)
      VALUES ('repair-item','repair-account','ozon','repair-identity','2102713588','PENDING_ENRICHMENT','{}')`);
    const repository = createPostgresCollectorOzonEnrichmentRepository({pool});
    const start = new Date(context.observedAt);
    const at = ms => new Date(start.getTime() + ms);
    const scope = {accountId: 'repair-account', collectorSessionId: 'executor-a'};
    const create = async (id, sku = id) => repository.createOrGetJob({
      id, accountId: scope.accountId, requestId: id, sku, refreshBundle: true, deadlineAt: at(20_000), createdAt: start,
    });
    const claim = (fence, ms, extra = {}) => repository.claimNextJob({
      ...scope, claimFence: fence, captureContext: context, now: at(ms), claimExpiresAt: at(ms + 30_000), ...extra,
    });
    const terminal = (job, ms, extra = {}) => ({
      ...scope, jobId: job.id, key: {accountId: scope.accountId, source: 'ozon', sku: job.sku, contractVersion: 'collector.ozon.enrichment.v1'},
      claimFence: job.claimFence, captureContext: context, now: at(ms), capturedAt: at(ms), expiresAt: at(ms + 60_000),
      responseHash: `repair-${job.id}`, ...extra,
    });

    await create('repair-slow', '2102713588');
    const original = await claim('slow-fence', 0);
    const replay = await repository.createOrGetJob({
      id: 'replacement', accountId: scope.accountId, requestId: 'repair-slow', sku: '2102713588',
      refreshBundle: true, deadlineAt: at(700_000), createdAt: at(660_000),
    });
    assert.equal(replay.claimFence, 'slow-fence');
    assert.equal(replay.status, 'PROCESSING');
    const renewed = await claim('slow-fence', 660_000, {jobId: original.id});
    assert.equal(renewed.claimFence, original.claimFence);
    assert.equal(renewed.claimExpiresAt, at(690_000).toISOString());
    assert.equal(renewed.attemptCount, 0);
    assert.equal(renewed.status, 'PROCESSING');
    const done = await repository.completeJobAndCache({...terminal(original, 720_000), result: completeResult(123)});
    assert.equal(done.status, 'SUCCESS');
    await assert.rejects(repository.completeJobAndCache({...terminal(original, 721_000), result: completeResult(456)}),
      error => error.code === 'ZONGZI_ENRICHMENT_JOB_TERMINAL');
    const cache = await repository.readCache({key: terminal(original, 0).key, now: at(721_000)});
    assert.equal(cache.result.descriptionCategoryId, 123);

    await repository.enqueueForCollect({accountId: scope.accountId, collectItemId: 'repair-item', requestId: 'repair-linked',
      sku: '2102713769', refreshBundle: true, now: start});
    let held = await claim('linked-0', 0);
    for (let i=1; i<=6; i++) {
      held = await claim(`linked-${i}`, i * 31_000);
      assert.equal(held.attemptCount, 0);
      assert.equal(held.lastError, null);
    }
    await assert.rejects(repository.failJobAndCache({...terminal(held, 187_000, {claimFence: 'linked-0'}), error: {code:'NETWORK_ERROR'}}),
      error => error.code === 'SELLER_CONTEXT_CHANGED');
    const error = {code:'ZONGZI_ENRICH_UPSTREAM_FAILED',status:502,message:'Seller /api/v1/search: net::ERR_CONNECTION_RESET',
      diagnostic:{stage:'seller.search',upstreamCode:'NETWORK_ERROR',requestSent:true,extensionVersion:'1.0.6'}};
    const deferred = await repository.deferClaim({...terminal(held, 220_000), error});
    assert.equal(deferred.attemptCount, 1);
    assert.deepEqual(deferred.lastError, error);
    await assert.rejects(claim(held.claimFence, 221_000, {jobId: held.id}), error => error.code === 'ZONGZI_ENRICHMENT_JOB_OWNERSHIP');

    const lastAttempt = await claim('linked-terminal', 251_000);
    const failed = await repository.failJobAndCache({...terminal(lastAttempt, 282_000), error});
    assert.equal(failed.attemptCount, 2);
    assert.deepEqual(failed.error, error);
    await create('repair-race');
    const racing = await claim('race-old', 300_000);
    const results = await Promise.allSettled([
      claim('race-old', 331_000, {jobId: racing.id}),
      claim('race-new', 331_000, {collectorSessionId: 'executor-b'}),
    ]);
    const winner = await repository.readJob({accountId: scope.accountId, jobId: racing.id});
    assert.equal(winner.attemptCount, 0);
    assert.equal(winner.error, null);
    // Only the winning lease/fence may continue; an expiry never opens both paths.
    if (winner.claimFence === 'race-old') {
      assert.equal(results[0].status, 'fulfilled');
      assert.notEqual(results[1].value?.id, racing.id);
    } else {
      assert.equal(winner.claimFence, 'race-new');
      assert.equal(results[0].status, 'rejected');
      await assert.rejects(repository.completeJobAndCache({...terminal(racing, 332_000), result: completeResult(789)}),
        error => ['ZONGZI_ENRICHMENT_JOB_OWNERSHIP','SELLER_CONTEXT_CHANGED'].includes(error.code));
    }
    const currentScope = {...scope, collectorSessionId: winner.claimedSessionId};
    await repository.advanceSellerContext({...currentScope, captureContext:{...context,revision:2}, now:at(332_000)});
    await assert.rejects(claim(winner.claimFence, 333_000, {jobId: winner.id, ...currentScope}),
      error => error.code === 'SELLER_CONTEXT_CHANGED');
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});
