import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryAutoListingAiOutboxRepository } from "../auto-listing-ai-outbox-repository.mjs";

const message = (overrides = {}) => ({
  contractVersion: "V1",
  accountId: "account-a",
  itemId: "item-a",
  phase: "PLAN_CONTENT",
  expectedStatusVersion: 2,
  correlationId: "correlation-a",
  ...overrides,
});

test("enqueue is canonical, deterministic, immutable, and account scoped", async () => {
  let timestamp = 1_000;
  const repository = createMemoryAutoListingAiOutboxRepository({ now: () => timestamp++ });
  const first = await repository.enqueueAutoListingAiMessage(message());
  const repeated = await repository.enqueueAutoListingAiMessage({
    correlationId: "correlation-a", phase: "PLAN_CONTENT", itemId: "item-a",
    contractVersion: "V1", expectedStatusVersion: 2, accountId: "account-a",
  });
  assert.deepEqual(repeated, first);
  assert.match(first.id, /^ai-outbox-[a-f0-9]{64}$/);
  assert.equal(first.status, "PENDING");
  assert.equal(first.attemptCount, 0);
  assert.equal(first.createdAt, 1_000);
  assert.equal(first.updatedAt, 1_000);
  first.message.accountId = "account-b";
  assert.equal((await repository.listAutoListingAiOutbox({ accountId: "account-a" }))[0].message.accountId, "account-a");
  assert.deepEqual(await repository.listAutoListingAiOutbox({ accountId: "account-b" }), []);
});

test("claim is exclusive, account scoped, and expired work receives a new ABA-fenced lease", async () => {
  let timestamp = 10_000;
  let nonce = 0;
  const repository = createMemoryAutoListingAiOutboxRepository({ now: () => timestamp, token: () => `lease-${++nonce}` });
  const pending = await repository.enqueueAutoListingAiMessage(message());
  const [first] = await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 1_000 });
  assert.equal(first.id, pending.id);
  assert.equal(first.status, "PROCESSING");
  assert.equal(first.attemptCount, 1);
  assert.equal(first.leaseOwner, "worker-a");
  assert.equal(first.leaseToken, "lease-1:1");
  assert.equal(first.leaseExpiresAt, 11_000);
  assert.deepEqual(await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-b", limit: 1, leaseMs: 1_000 }), []);
  assert.deepEqual(await repository.claimAutoListingAiMessages({ accountId: "account-b", workerId: "worker-b", limit: 1, leaseMs: 1_000 }), []);
  timestamp = 11_000;
  const [reclaimed] = await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-b", limit: 1, leaseMs: 500 });
  assert.equal(reclaimed.attemptCount, 2);
  assert.equal(reclaimed.leaseToken, "lease-2:2");
  await assert.rejects(repository.completeAutoListingAiMessage({
    accountId: "account-a", itemId: "item-a", id: pending.id, workerId: "worker-a", leaseToken: first.leaseToken,
  }), (error) => error?.code === "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED");
});

test("renew extends only a current unexpired lease using repository-owned time", async () => {
  let timestamp = 20_000;
  const repository = createMemoryAutoListingAiOutboxRepository({ now: () => timestamp, token: () => "lease-a" });
  await repository.enqueueAutoListingAiMessage(message());
  const [claimed] = await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 1_000 });
  timestamp = 20_500;
  await assert.rejects(repository.renewAutoListingAiMessageLease({
    accountId: "account-a", id: claimed.id, workerId: "worker-a", leaseToken: claimed.leaseToken, leaseMs: 2_000,
    itemId: "item-a",
    now: 999_999,
  }), (error) => error?.code === "AUTO_LISTING_AI_OUTBOX_INVALID");
  const renewed = await repository.renewAutoListingAiMessageLease({
    accountId: "account-a", itemId: "item-a", id: claimed.id, workerId: "worker-a",
    leaseToken: claimed.leaseToken, leaseMs: 2_000,
  });
  assert.equal(renewed.leaseExpiresAt, 22_500);
  timestamp = 22_500;
  await assert.rejects(repository.renewAutoListingAiMessageLease({
    accountId: "account-a", itemId: "item-a", id: claimed.id, workerId: "worker-a", leaseToken: claimed.leaseToken, leaseMs: 1_000,
  }), (error) => error?.code === "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED");
});

test("complete is terminal and immutable against stale or repeated operations", async () => {
  let timestamp = 30_000;
  const repository = createMemoryAutoListingAiOutboxRepository({ now: () => timestamp, token: () => "lease-a" });
  await repository.enqueueAutoListingAiMessage(message());
  const [claimed] = await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 1_000 });
  timestamp = 30_100;
  const completed = await repository.completeAutoListingAiMessage({
    accountId: "account-a", itemId: "item-a", id: claimed.id, workerId: "worker-a", leaseToken: claimed.leaseToken,
  });
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.completedAt, 30_100);
  assert.equal(completed.leaseToken, null);
  timestamp = 40_000;
  assert.deepEqual(await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-b", limit: 1, leaseMs: 1_000 }), []);
  const terminalOperations = [
    ["completeAutoListingAiMessage", {}],
    ["renewAutoListingAiMessageLease", { leaseMs: 1_000 }],
    ["failAutoListingAiMessage", { errorCode: "AUTO_LISTING_AI_WORK_FAILED" }],
    ["deadLetterAutoListingAiMessage", { errorCode: "AUTO_LISTING_AI_WORK_FAILED" }],
  ];
  for (const [operation, fields] of terminalOperations) {
    await assert.rejects(repository[operation]({
      accountId: "account-a", itemId: "item-a", id: claimed.id,
      workerId: "worker-a", leaseToken: claimed.leaseToken, ...fields,
    }), (error) => error?.code === "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED");
  }
});

test("successful completion after a retry clears stale failure evidence", async () => {
  let timestamp = 45_000;
  let nonce = 0;
  const repository = createMemoryAutoListingAiOutboxRepository({
    now: () => timestamp,
    token: () => `lease-${++nonce}`,
    baseRetryMs: 100,
    maxRetryMs: 100,
  });
  await repository.enqueueAutoListingAiMessage(message());
  const [firstClaim] = await repository.claimAutoListingAiMessages({
    accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 1_000,
  });
  const failed = await repository.failAutoListingAiMessage({
    accountId: "account-a", itemId: "item-a", id: firstClaim.id,
    workerId: "worker-a", leaseToken: firstClaim.leaseToken,
    errorCode: "AUTO_LISTING_AI_TRANSIENT",
  });
  assert.equal(failed.lastErrorCode, "AUTO_LISTING_AI_TRANSIENT");

  timestamp = failed.nextAttemptAt;
  const [retryClaim] = await repository.claimAutoListingAiMessages({
    accountId: "account-a", workerId: "worker-b", limit: 1, leaseMs: 1_000,
  });
  const completed = await repository.completeAutoListingAiMessage({
    accountId: "account-a", itemId: "item-a", id: retryClaim.id,
    workerId: "worker-b", leaseToken: retryClaim.leaseToken,
  });

  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.lastErrorCode, null);
  assert.equal(completed.nextAttemptAt, null);
});

test("fail applies bounded backoff and reaches DEAD at max attempts", async () => {
  let timestamp = 50_000;
  let nonce = 0;
  const repository = createMemoryAutoListingAiOutboxRepository({
    now: () => timestamp, token: () => `lease-${++nonce}`, baseRetryMs: 100, maxRetryMs: 200, maxAttempts: 3,
  });
  await repository.enqueueAutoListingAiMessage(message());
  for (const [attempt, expectedStatus, delay] of [[1, "PENDING", 100], [2, "PENDING", 200], [3, "DEAD", null]]) {
    const [claimed] = await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 50 });
    assert.equal(claimed.attemptCount, attempt);
    const failed = await repository.failAutoListingAiMessage({
      accountId: "account-a", id: claimed.id, workerId: "worker-a", leaseToken: claimed.leaseToken,
      itemId: "item-a", errorCode: "AUTO_LISTING_AI_WORK_FAILED",
    });
    assert.equal(failed.status, expectedStatus);
    assert.equal(failed.lastErrorCode, "AUTO_LISTING_AI_WORK_FAILED");
    if (delay !== null) {
      assert.equal(failed.nextAttemptAt, timestamp + delay);
      assert.deepEqual(await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 50 }), []);
      timestamp += delay;
    } else {
      assert.equal(failed.deadAt, timestamp);
      timestamp += 1_000;
      assert.deepEqual(await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 50 }), []);
    }
  }
});

test("explicit dead-letter is lease fenced and terminal", async () => {
  const repository = createMemoryAutoListingAiOutboxRepository({ now: () => 60_000, token: () => "lease-a" });
  await repository.enqueueAutoListingAiMessage(message());
  const [claimed] = await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 1_000 });
  const dead = await repository.deadLetterAutoListingAiMessage({
    accountId: "account-a", id: claimed.id, workerId: "worker-a", leaseToken: claimed.leaseToken,
    itemId: "item-a", errorCode: "AUTO_LISTING_AI_NON_RETRYABLE",
  });
  assert.equal(dead.status, "DEAD");
  assert.equal(dead.deadAt, 60_000);
  assert.equal(dead.lastErrorCode, "AUTO_LISTING_AI_NON_RETRYABLE");
});

test("invalid inputs fail with fixed safe errors and never expose raw values", async () => {
  const repository = createMemoryAutoListingAiOutboxRepository();
  const inheritedScope = Object.create({ accountId: "account-a" });
  for (const execute of [
    () => repository.enqueueAutoListingAiMessage(message({ prompt: "raw-secret" })),
    () => repository.listAutoListingAiOutbox({ accountId: "https://secret.invalid" }),
    () => repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 0, leaseMs: 1_000 }),
    () => repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 0 }),
    () => repository.listAutoListingAiOutbox(inheritedScope),
  ]) {
    await assert.rejects(execute(), (error) => {
      assert.match(error?.code || "", /^AUTO_LISTING_AI_(?:MESSAGE|OUTBOX)_INVALID$/);
      assert.equal(error?.message, "自动上架 AI 发件箱操作无效");
      assert.doesNotMatch(JSON.stringify(error), /raw-secret|secret\.invalid/);
      return true;
    });
  }
});

test("failure accepts only a stable non-sensitive uppercase error code and preserves the lease on rejection", async () => {
  for (const errorCode of ["raw backend secret", "lower_case", " BAD_CODE", "BAD\nCODE", "API_KEY_EXPOSED", "A".repeat(121)]) {
    const repository = createMemoryAutoListingAiOutboxRepository({ token: () => "lease-a" });
    await repository.enqueueAutoListingAiMessage(message());
    const [claimed] = await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 5_000 });
    await assert.rejects(repository.failAutoListingAiMessage({
      accountId: "account-a", id: claimed.id, workerId: "worker-a", leaseToken: claimed.leaseToken, errorCode,
      itemId: "item-a",
    }), (error) => error?.code === "AUTO_LISTING_AI_OUTBOX_INVALID");
    const [row] = await repository.listAutoListingAiOutbox({ accountId: "account-a" });
    assert.equal(row.status, "PROCESSING");
    assert.equal(row.lastErrorCode, null);
  }
});

test("rejects extra, hidden, accessor, proxy, and wrong-item repository command data", async () => {
  const repository = createMemoryAutoListingAiOutboxRepository({ now: () => 70_000, token: () => "lease-a" });
  await repository.enqueueAutoListingAiMessage(message());
  const [claimed] = await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 1_000 });
  const hidden = { accountId: "account-a" };
  Object.defineProperty(hidden, "rawSecret", { value: "hidden", enumerable: false });
  const accessor = { accountId: "account-a" };
  Object.defineProperty(accessor, "password", { enumerable: true, get() { throw new Error("DATABASE_PASSWORD=leaked"); } });
  const proxy = new Proxy({ accountId: "account-a" }, { ownKeys() { throw new Error("DATABASE_PASSWORD=leaked"); } });
  for (const input of [{ accountId: "account-a", password: "hidden" }, hidden, accessor, proxy]) {
    await assert.rejects(repository.listAutoListingAiOutbox(input), (error) => {
      assert.equal(error?.code, "AUTO_LISTING_AI_OUTBOX_INVALID");
      assert.equal(error?.message, "自动上架 AI 发件箱操作无效");
      assert.doesNotMatch(error?.message || "", /DATABASE_PASSWORD|hidden/);
      return true;
    });
  }
  await assert.rejects(repository.completeAutoListingAiMessage({
    accountId: "account-a", itemId: "item-b", id: claimed.id, workerId: "worker-a", leaseToken: claimed.leaseToken,
  }), (error) => error?.code === "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED");
  const completed = await repository.completeAutoListingAiMessage({
    accountId: "account-a", itemId: "item-a", id: claimed.id, workerId: "worker-a", leaseToken: claimed.leaseToken,
  });
  assert.equal(completed.status, "COMPLETED");
});

test("batch claim is atomic when token preparation fails", async () => {
  let tokenCalls = 0;
  const repository = createMemoryAutoListingAiOutboxRepository({
    now: () => 80_000,
    token: () => {
      tokenCalls += 1;
      if (tokenCalls === 2) throw new Error("raw token failure");
      return `lease-${tokenCalls}`;
    },
  });
  await repository.enqueueAutoListingAiMessage(message({ itemId: "item-a" }));
  await repository.enqueueAutoListingAiMessage(message({ itemId: "item-b" }));
  await assert.rejects(repository.claimAutoListingAiMessages({
    accountId: "account-a", workerId: "worker-a", limit: 2, leaseMs: 1_000,
  }), (error) => error?.code === "AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
  assert.deepEqual(
    (await repository.listAutoListingAiOutbox({ accountId: "account-a" })).map((row) => row.status),
    ["PENDING", "PENDING"],
  );
});

test("bounds repository capacity and supports closed cursor pagination", async () => {
  let timestamp = 90_000;
  const repository = createMemoryAutoListingAiOutboxRepository({ now: () => timestamp++, maxRows: 3 });
  for (const itemId of ["item-a", "item-b", "item-c"]) {
    await repository.enqueueAutoListingAiMessage(message({ itemId }));
  }
  await assert.rejects(
    repository.enqueueAutoListingAiMessage(message({ itemId: "item-d" })),
    (error) => error?.code === "AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED" && error?.retryable === true,
  );
  const firstPage = await repository.listAutoListingAiOutbox({ accountId: "account-a", limit: 2 });
  assert.equal(firstPage.length, 2);
  const secondPage = await repository.listAutoListingAiOutbox({ accountId: "account-a", limit: 2, afterId: firstPage.at(-1).id });
  assert.equal(secondPage.length, 1);
  assert.equal(new Set([...firstPage, ...secondPage].map((row) => row.id)).size, 3);
  await assert.rejects(
    repository.listAutoListingAiOutbox({ accountId: "account-a", limit: 101 }),
    (error) => error?.code === "AUTO_LISTING_AI_OUTBOX_INVALID",
  );
});

test("rejects unsafe injected time and overflow without mutating pending work", async () => {
  const invalidClock = createMemoryAutoListingAiOutboxRepository({ now: () => -0.5 });
  await assert.rejects(
    invalidClock.enqueueAutoListingAiMessage(message()),
    (error) => error?.code === "AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED",
  );

  const overflowClock = createMemoryAutoListingAiOutboxRepository({ now: () => Number.MAX_SAFE_INTEGER, token: () => "lease-a" });
  await overflowClock.enqueueAutoListingAiMessage(message());
  await assert.rejects(
    overflowClock.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 1 }),
    (error) => error?.code === "AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED",
  );
  assert.equal((await overflowClock.listAutoListingAiOutbox({ accountId: "account-a" }))[0].status, "PENDING");
});
