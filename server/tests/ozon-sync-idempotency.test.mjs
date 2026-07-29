import assert from "node:assert/strict";
import test from "node:test";
import { createOzonSyncService } from "../ozon-sync-service.mjs";

const baseState = () => ({
  accounts: [
    { id: "account-a", status: "active" },
    { id: "account-b", status: "active" },
  ],
  stores: [
    {
      id: "store-a",
      ownerAccountId: "account-a",
      clientId: "client-a",
      apiKey: "api-a",
      status: "active",
    },
    {
      id: "store-b",
      ownerAccountId: "account-b",
      clientId: "client-b",
      apiKey: "api-b",
      status: "active",
    },
    {
      id: "store-a-2",
      ownerAccountId: "account-a",
      clientId: "client-a-2",
      apiKey: "api-a-2",
      status: "active",
    },
  ],
  caches: {
    products: [],
    postings: [],
    warehouses: [],
    promotions: [],
  },
  jobs: {},
  reports: [],
  auditEvents: [],
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fixture({
  failActions = false,
  loadFailures = 0,
  onActions = null,
} = {}) {
  let persisted = structuredClone(baseState());
  let clockTick = 0;
  let fetchCalls = 0;
  let remainingLoadFailures = loadFailures;
  const service = createOzonSyncService({
    loadState: async () => {
      if (remainingLoadFailures > 0) {
        remainingLoadFailures -= 1;
        throw new Error("state temporarily unavailable");
      }
      return structuredClone(persisted);
    },
    saveState: async (state) => {
      persisted = structuredClone(state);
    },
    now: () => new Date(Date.UTC(2026, 6, 29, 12, 0, clockTick++)),
    createJobId: () => "server-generated-key",
    logger: { warn() {} },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    const path = new URL(url).pathname;
    if (path === "/v1/seller/info") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: { company: { name: "Seller" } } }),
      };
    }
    if (path === "/v1/actions") {
      await onActions?.();
      if (failActions) {
        return {
          ok: false,
          status: 503,
          text: async () => JSON.stringify({
            code: "ACTIONS.UNAVAILABLE",
            message: "temporary failure",
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: [{ id: "promotion-1" }] }),
      };
    }
    throw new Error(`unexpected Ozon path: ${path}`);
  };
  return {
    service,
    state: () => structuredClone(persisted),
    fetchCalls: () => fetchCalls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

const syncInput = (overrides = {}) => ({
  accountId: "account-a",
  storeId: "store-a",
  type: "PROMOTIONS",
  jobId: "shared-client-key",
  requestId: "shared-request",
  source: "web",
  ...overrides,
});

test("same scoped sync request replays the exact terminal report", async () => {
  const testFixture = fixture();
  try {
    const first = await testFixture.service.runLocalSync(
      testFixture.state(),
      syncInput(),
    );
    const callsAfterFirst = testFixture.fetchCalls();
    const replay = await testFixture.service.runLocalSync(
      testFixture.state(),
      syncInput(),
    );

    assert.deepEqual(replay, first);
    assert.equal(testFixture.fetchCalls(), callsAfterFirst);
    assert.notEqual(first.taskId, "shared-client-key");
    assert.equal(first.clientJobId, "shared-client-key");
  } finally {
    testFixture.restore();
  }
});

test("concurrent identical sync requests share one successful execution", async () => {
  const actionStarted = deferred();
  const releaseAction = deferred();
  const testFixture = fixture({
    onActions: async () => {
      actionStarted.resolve();
      await releaseAction.promise;
    },
  });
  try {
    const firstPromise = testFixture.service.runLocalSync(
      testFixture.state(),
      syncInput(),
    );
    await actionStarted.promise;
    const secondPromise = testFixture.service.runLocalSync(
      testFixture.state(),
      syncInput(),
    );
    await new Promise((resolve) => setImmediate(resolve));
    releaseAction.resolve();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const persisted = testFixture.state();

    assert.deepEqual(second, first);
    assert.equal(testFixture.fetchCalls(), 2);
    assert.equal(
      persisted.reports.filter((report) => report.clientJobId === "shared-client-key").length,
      1,
    );
    assert.equal(
      persisted.auditEvents.filter((event) => event.correlationId === first.taskId).length,
      1,
    );
  } finally {
    releaseAction.resolve();
    testFixture.restore();
  }
});

test("same failed sync request replays the exact public failure", async () => {
  const testFixture = fixture({ failActions: true });
  try {
    let firstFailure;
    await assert.rejects(
      () => testFixture.service.runLocalSync(testFixture.state(), syncInput()),
      (error) => {
        firstFailure = structuredClone(error.body);
        return error?.status === 503 && error?.code === "OZON_HTTP_503";
      },
    );
    const callsAfterFirst = testFixture.fetchCalls();

    await assert.rejects(
      () => testFixture.service.runLocalSync(testFixture.state(), syncInput()),
      (error) => {
        assert.deepEqual(error.body, firstFailure);
        return error?.status === 503 && error?.code === "OZON_HTTP_503";
      },
    );
    assert.equal(testFixture.fetchCalls(), callsAfterFirst);
  } finally {
    testFixture.restore();
  }
});

test("concurrent identical failed sync requests share one public failure", async () => {
  const actionStarted = deferred();
  const releaseAction = deferred();
  const testFixture = fixture({
    failActions: true,
    onActions: async () => {
      actionStarted.resolve();
      await releaseAction.promise;
    },
  });
  try {
    const firstPromise = testFixture.service.runLocalSync(
      testFixture.state(),
      syncInput(),
    );
    await actionStarted.promise;
    const secondPromise = testFixture.service.runLocalSync(
      testFixture.state(),
      syncInput(),
    );
    await new Promise((resolve) => setImmediate(resolve));
    releaseAction.resolve();

    const [first, second] = await Promise.allSettled([firstPromise, secondPromise]);
    const persisted = testFixture.state();

    assert.equal(first.status, "rejected");
    assert.equal(second.status, "rejected");
    assert.deepEqual(second.reason.body, first.reason.body);
    assert.equal(testFixture.fetchCalls(), 2);
    assert.equal(
      persisted.reports.filter((report) => report.clientJobId === "shared-client-key").length,
      1,
    );
    assert.equal(
      persisted.auditEvents.filter((event) =>
        event.correlationId === first.reason.body.taskId).length,
      1,
    );
  } finally {
    releaseAction.resolve();
    testFixture.restore();
  }
});

test("failed sync claim is shared and released for a later retry", async () => {
  const testFixture = fixture({ loadFailures: 1 });
  try {
    const attempts = await Promise.allSettled([
      testFixture.service.runLocalSync(testFixture.state(), syncInput()),
      testFixture.service.runLocalSync(testFixture.state(), syncInput()),
    ]);

    assert.deepEqual(attempts.map((attempt) => attempt.status), [
      "rejected",
      "rejected",
    ]);
    assert.deepEqual(attempts[1].reason.body, attempts[0].reason.body);
    assert.equal(attempts[0].reason.code, "SYNC_STATE_UNAVAILABLE");
    assert.equal(testFixture.fetchCalls(), 0);

    const retry = await testFixture.service.runLocalSync(
      testFixture.state(),
      syncInput(),
    );
    assert.equal(retry.status, "SUCCESS");
    assert.equal(testFixture.fetchCalls(), 2);
  } finally {
    testFixture.restore();
  }
});

test("same account client key rejects a changed request or sync scope", async () => {
  const testFixture = fixture();
  try {
    await testFixture.service.runLocalSync(testFixture.state(), syncInput());

    await assert.rejects(
      () => testFixture.service.runLocalSync(testFixture.state(), syncInput({
        requestId: "changed-request",
      })),
      (error) => error?.status === 409 && error?.code === "SYNC_IDEMPOTENCY_CONFLICT",
    );
    await assert.rejects(
      () => testFixture.service.runLocalSync(testFixture.state(), syncInput({
        storeId: "store-a-2",
        type: "WAREHOUSES",
      })),
      (error) => error?.status === 409 && error?.code === "SYNC_IDEMPOTENCY_CONFLICT",
    );
  } finally {
    testFixture.restore();
  }
});

test("in-flight client key rejects a changed request or sync scope", async () => {
  const actionStarted = deferred();
  const releaseAction = deferred();
  const testFixture = fixture({
    onActions: async () => {
      actionStarted.resolve();
      await releaseAction.promise;
    },
  });
  try {
    const firstPromise = testFixture.service.runLocalSync(
      testFixture.state(),
      syncInput(),
    );
    await actionStarted.promise;

    await assert.rejects(
      () => testFixture.service.runLocalSync(testFixture.state(), syncInput({
        requestId: "changed-request",
      })),
      (error) => error?.status === 409 && error?.code === "SYNC_IDEMPOTENCY_CONFLICT",
    );
    await assert.rejects(
      () => testFixture.service.runLocalSync(testFixture.state(), syncInput({
        storeId: "store-a-2",
        type: "WAREHOUSES",
      })),
      (error) => error?.status === 409 && error?.code === "SYNC_IDEMPOTENCY_CONFLICT",
    );

    releaseAction.resolve();
    await firstPromise;
    assert.equal(testFixture.fetchCalls(), 2);
  } finally {
    releaseAction.resolve();
    testFixture.restore();
  }
});

test("two accounts using the same client key retain separate reports and audits", async () => {
  const testFixture = fixture();
  try {
    const accountA = await testFixture.service.runLocalSync(
      testFixture.state(),
      syncInput(),
    );
    const accountB = await testFixture.service.runLocalSync(
      testFixture.state(),
      syncInput({
        accountId: "account-b",
        storeId: "store-b",
      }),
    );
    const persisted = testFixture.state();

    assert.notEqual(accountA.taskId, accountB.taskId);
    assert.equal(persisted.jobs[accountA.taskId].accountId, "account-a");
    assert.equal(persisted.jobs[accountB.taskId].accountId, "account-b");
    assert.deepEqual(
      persisted.reports.map((report) => report.accountId).sort(),
      ["account-a", "account-b"],
    );
    assert.equal(new Set(
      persisted.auditEvents.map((event) => event.eventId),
    ).size, 2);
    assert.deepEqual(
      persisted.auditEvents.map((event) => event.accountId).sort(),
      ["account-a", "account-b"],
    );
  } finally {
    testFixture.restore();
  }
});
