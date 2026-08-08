import assert from "node:assert/strict";
import test from "node:test";

import {
  createAutoListingAiModelSyncSchedulePostgres,
  createAutoListingAiModelSyncWorker,
} from "../auto-listing-ai-model-sync-worker.mjs";

const candidate = Object.freeze({
  accountId: "account-daily",
  connectionId: "connection-daily",
  connectionVersion: 2,
  connectionStatusVersion: 5,
  latestCatalogId: null,
  lastSyncedAt: null,
});

function lease(accountId, overrides = {}) {
  return {
    taskId: `task-${accountId}`,
    accountId,
    connectionId: `connection-${accountId}`,
    connectionVersion: 1,
    syncPurpose: "CATALOG_SYNC",
    targetConnectionStatusVersion: 3,
    attemptCount: 1,
    maxAttempts: 5,
    leaseVersion: 1,
    leaseToken: `lease-${accountId}`,
    leaseExpiresAt: "2026-08-08T08:02:00.000Z",
    reclaimed: false,
    ...overrides,
  };
}

function workerConfig(overrides = {}) {
  return {
    enabled: true,
    repository: {
      async listRunnableSyncAccountIds() { return []; },
      async claimModelSync() { return null; },
      async enqueueModelSync() { throw new Error("unexpected enqueue"); },
    },
    scheduler: { async listDueConnections() { return []; } },
    syncService: { async syncModelCatalog() { throw new Error("unexpected sync"); } },
    workerId: "model-sync-worker",
    pollIntervalMs: 60_000,
    accountPageSize: 2,
    logger: { log() {} },
    timers: { setTimeout() { return 1; }, clearTimeout() {} },
    ...overrides,
  };
}

test("worker pages with a strictly increasing cursor, claims only catalog tasks, and bounds concurrency at two", async () => {
  const cursors = [];
  const claims = [];
  let phase = 0;
  let active = 0;
  let peak = 0;
  const repository = {
    async listRunnableSyncAccountIds(input) {
      cursors.push(structuredClone(input));
      assert.equal(input.syncPurpose, "CATALOG_SYNC");
      if (phase > 0) return [];
      if (input.afterAccountId === null) return ["account-a", "account-b"];
      if (input.afterAccountId === "account-b") return ["account-c"];
      phase = 1;
      return [];
    },
    async claimModelSync(input) {
      claims.push(structuredClone(input));
      assert.equal(input.syncPurpose, "CATALOG_SYNC");
      return lease(input.accountId);
    },
    async enqueueModelSync() { throw new Error("no daily candidates"); },
  };
  const syncService = {
    async syncModelCatalog(input) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { taskId: input.taskId, status: "SUCCEEDED" };
    },
  };
  const worker = createAutoListingAiModelSyncWorker(workerConfig({ repository, syncService }));
  const result = await worker.runOnce();

  assert.equal(result.claimed, 3);
  assert.equal(result.succeeded, 3);
  assert.equal(peak, 2);
  assert.deepEqual(cursors.slice(0, 3).map((entry) => entry.afterAccountId), [null, "account-b", "account-c"]);
  assert.equal(claims.every((entry) => entry.leaseMs === 120_000), true);
});

test("worker rejects a non-progressing account page instead of looping", async () => {
  const worker = createAutoListingAiModelSyncWorker(workerConfig({
    repository: {
      async listRunnableSyncAccountIds({ afterAccountId }) {
        return afterAccountId === null ? ["account-b"] : ["account-a"];
      },
      async claimModelSync({ accountId }) { return lease(accountId); },
      async enqueueModelSync() { throw new Error("must not enqueue"); },
    },
    syncService: { async syncModelCatalog(input) { return { taskId: input.taskId, status: "SUCCEEDED" }; } },
  }));
  await assert.rejects(worker.runOnce(), { code: "AUTO_LISTING_AI_MODEL_SYNC_WORKER_CURSOR_INVALID" });
});

test("manual runnable work is processed before daily scheduling", async () => {
  const order = [];
  let sweep = 0;
  const repository = {
    async listRunnableSyncAccountIds({ afterAccountId }) {
      if (afterAccountId !== null) return [];
      sweep += 1;
      return sweep === 1 ? ["account-manual"] : [];
    },
    async claimModelSync({ accountId }) { order.push("claim-manual"); return lease(accountId); },
    async enqueueModelSync() { order.push("enqueue-daily"); return { status: "PENDING", duplicate: false }; },
  };
  const worker = createAutoListingAiModelSyncWorker(workerConfig({
    repository,
    scheduler: { async listDueConnections() { order.push("list-daily"); return [candidate]; } },
    syncService: { async syncModelCatalog() { order.push("complete-manual"); return { status: "SUCCEEDED" }; } },
  }));
  await worker.runOnce();
  assert.deepEqual(order.slice(0, 4), ["claim-manual", "complete-manual", "list-daily", "enqueue-daily"]);
});

test("daily enqueue is deterministic, limited to five attempts, and cannot resurrect a DEAD task", async () => {
  const enqueues = [];
  let existing = null;
  const repository = {
    async listRunnableSyncAccountIds() { return []; },
    async claimModelSync() { return null; },
    async enqueueModelSync(input) {
      enqueues.push(structuredClone(input));
      if (existing) return { ...existing, duplicate: true };
      existing = { id: "daily-dead", status: "DEAD", duplicate: false };
      return existing;
    },
  };
  const worker = createAutoListingAiModelSyncWorker(workerConfig({
    repository,
    scheduler: { async listDueConnections() { return [candidate]; } },
  }));
  const first = await worker.runOnce();
  const second = await worker.runOnce();

  assert.equal(first.scheduled, 0);
  assert.equal(second.scheduled, 0);
  assert.equal(enqueues.length, 2);
  assert.equal(enqueues[0].idempotencyKey, enqueues[1].idempotencyKey);
  assert.equal(enqueues[0].maxAttempts, 5);
  assert.equal(enqueues[0].syncPurpose, "CATALOG_SYNC");
  assert.equal(enqueues[0].actorId, "account-daily");
  assert.equal(enqueues[0].expectedConnectionStatusVersion, 5);
});

test("expired leases are reclaimed and completed through the same catalog service", async () => {
  const received = [];
  let claimed = false;
  let listed = false;
  const worker = createAutoListingAiModelSyncWorker(workerConfig({
    repository: {
      async listRunnableSyncAccountIds({ afterAccountId }) {
        if (afterAccountId !== null || listed) return [];
        listed = true;
        return ["account-a"];
      },
      async claimModelSync() {
        if (claimed) return null;
        claimed = true;
        return lease("account-a", { attemptCount: 2, leaseVersion: 2, reclaimed: true });
      },
      async enqueueModelSync() { throw new Error("must not enqueue"); },
    },
    syncService: {
      async syncModelCatalog(input) { received.push(structuredClone(input)); return { status: "SUCCEEDED" }; },
    },
  }));
  const result = await worker.runOnce();
  assert.equal(result.reclaimed, 1);
  assert.equal(received[0].leaseVersion, 2);
});

test("graceful stop clears the timer and waits for the in-flight lease", async () => {
  let callback;
  let cleared = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let listed = false;
  const worker = createAutoListingAiModelSyncWorker(workerConfig({
    repository: {
      async listRunnableSyncAccountIds({ afterAccountId }) {
        if (afterAccountId !== null || listed) return [];
        listed = true;
        return ["account-a"];
      },
      async claimModelSync() { return lease("account-a"); },
      async enqueueModelSync() { throw new Error("must not enqueue"); },
    },
    syncService: { async syncModelCatalog() { await gate; return { status: "SUCCEEDED" }; } },
    timers: {
      setTimeout(next) { callback = next; return 9; },
      clearTimeout(id) { assert.equal(id, 9); cleared += 1; },
    },
  }));
  assert.equal(await worker.start(), true);
  const running = callback();
  await new Promise((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await Promise.all([running, stopping]);
  assert.equal(stopped, true);
  assert.equal(cleared, 0, "the fired timer is no longer pending");
});

test("PostgreSQL daily scheduler uses database time, a 24-hour success fence, and strict account paging", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{
        account_id: "account-b",
        connection_id: "connection-b",
        connection_version: "2",
        connection_status_version: "4",
        latest_catalog_id: "catalog-old",
        last_synced_at: "2026-08-07T07:59:59.000Z",
      }] };
    },
  };
  const scheduler = createAutoListingAiModelSyncSchedulePostgres({ pool });
  const result = await scheduler.listDueConnections({ afterAccountId: "account-a", limit: 20 });
  assert.deepEqual(result, [{
    accountId: "account-b",
    connectionId: "connection-b",
    connectionVersion: 2,
    connectionStatusVersion: 4,
    latestCatalogId: "catalog-old",
    lastSyncedAt: "2026-08-07T07:59:59.000Z",
  }]);
  assert.deepEqual(calls[0].params, ["account-a", 20]);
  assert.match(calls[0].sql, /status='ACTIVE'/iu);
  assert.match(calls[0].sql, /catalog\.created_at AS synced_at/iu);
  assert.match(calls[0].sql, /NOW\(\)\s*-\s*INTERVAL '24 hours'/iu);
  assert.match(calls[0].sql, /sync_purpose='CATALOG_SYNC'/iu);
  assert.match(calls[0].sql, /status IN \('PENDING','LEASED','FAILED'\)/iu);
  assert.match(calls[0].sql, /ORDER BY c\.account_id/iu);
});

test("worker and scheduler factories reject hostile traps without leaking their values", () => {
  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error("leaseToken=raw-secret"); },
  });
  for (const create of [
    () => createAutoListingAiModelSyncWorker(hostile),
    () => createAutoListingAiModelSyncSchedulePostgres(hostile),
  ]) {
    assert.throws(create, (error) => /_INVALID$/u.test(error?.code ?? "")
      && !/leaseToken|raw-secret/iu.test(error.message));
  }
});
