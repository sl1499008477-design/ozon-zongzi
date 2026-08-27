import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_LISTING_AI_QUEUE,
  AUTO_LISTING_AI_QUEUE_OPTIONS,
  createAutoListingAiQueueAdapter,
  createAutoListingAiOutboxPublisher,
} from "../auto-listing-ai-queue.mjs";
import { createMemoryAutoListingAiOutboxRepository } from "../auto-listing-ai-outbox-repository.mjs";

const message = Object.freeze({
  contractVersion: "V1",
  accountId: "account-a",
  itemId: "item-a",
  phase: "PLAN_CONTENT",
  expectedStatusVersion: 3,
  correlationId: "correlation-a",
});

test("AI queue starts only its dedicated queue and publishes one closed V1 message with deterministic identities", async () => {
  const calls = [];
  const boss = {
    async start() { calls.push(["start"]); },
    async createQueue(name, options) { calls.push(["createQueue", name, options]); },
    async send(name, payload, options) { calls.push(["send", name, payload, options]); return options.id; },
    async stop(options) { calls.push(["stop", options]); },
  };
  let factories = 0;
  const queue = createAutoListingAiQueueAdapter({ enabled: true, bossFactory: () => { factories += 1; return boss; } });

  const result = await queue.publish(message);
  await queue.stop();

  assert.equal(AUTO_LISTING_AI_QUEUE, "auto-listing-ai-v1");
  assert.equal(Object.isFrozen(AUTO_LISTING_AI_QUEUE_OPTIONS), true);
  assert.deepEqual(AUTO_LISTING_AI_QUEUE_OPTIONS, {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 86_399,
    retentionSeconds: 1_209_600,
    deleteAfterSeconds: 604_800,
    heartbeatSeconds: 30,
    notify: true,
  });
  assert.equal(factories, 1);
  assert.deepEqual(calls[0], ["start"]);
  assert.equal(calls[1][0], "createQueue");
  assert.equal(calls[1][1], "auto-listing-ai-v1");
  assert.deepEqual(calls[1][2], AUTO_LISTING_AI_QUEUE_OPTIONS);
  assert.deepEqual(calls[2], ["send", "auto-listing-ai-v1", message, {
    id: "39dc894b-0057-5e82-8907-e1cffbd25eb6",
    singletonKey: "5e6f8a19b642d50cef84bb57627e8310fca0cfc9b43de27510796eee9c79bfb8",
  }]);
  assert.deepEqual(result, {
    publicationId: "39dc894b-0057-5e82-8907-e1cffbd25eb6",
    singletonKey: "5e6f8a19b642d50cef84bb57627e8310fca0cfc9b43de27510796eee9c79bfb8",
    duplicate: false,
  });
  assert.equal(calls[3][0], "stop");
  assert.doesNotMatch(JSON.stringify(calls), /listing-v3|submission|sourceRef|apiKey|secret/iu);
});

test("pg-boss singleton conflicts are idempotent publish success and feature-disabled adapters never create a boss", async () => {
  let factories = 0;
  const disabled = createAutoListingAiQueueAdapter({ enabled: false });
  assert.equal(await disabled.start(), false);
  await assert.rejects(disabled.publish(message), { code: "AUTO_LISTING_AI_QUEUE_DISABLED" });
  await disabled.stop();
  assert.equal(factories, 0);

  for (const duplicate of [null, Object.assign(new Error("raw singleton constraint"), { code: "PGBOSS_SINGLETON_ALREADY_EXISTS" })]) {
    const queue = createAutoListingAiQueueAdapter({
      enabled: true,
      bossFactory: () => {
        factories += 1;
        return {
          async start() {},
          async createQueue() {},
          async send() { if (duplicate instanceof Error) throw duplicate; return duplicate; },
          async stop() {},
        };
      },
    });
    assert.deepEqual(await queue.publish(message), {
      publicationId: "39dc894b-0057-5e82-8907-e1cffbd25eb6",
      singletonKey: "5e6f8a19b642d50cef84bb57627e8310fca0cfc9b43de27510796eee9c79bfb8",
      duplicate: true,
    });
    await queue.stop();
  }
  assert.equal(factories, 2);
});

test("publisher claims a bounded account batch, publishes the closed message and completes the exact lease", async () => {
  let now = 1_000;
  const outboxRepository = createMemoryAutoListingAiOutboxRepository({ now: () => now, token: () => "lease-a" });
  const pending = await outboxRepository.enqueueAutoListingAiMessage(message);
  const sent = [];
  const queueAdapter = createAutoListingAiQueueAdapter({
    enabled: true,
    bossFactory: () => ({
      async start() {},
      async createQueue() {},
      async send(name, payload, options) { sent.push({ name, payload, options }); return options.id; },
      async stop() {},
    }),
  });
  const publisher = createAutoListingAiOutboxPublisher({
    enabled: true,
    outboxRepository,
    queueAdapter,
    accountIds: async () => ["account-a"],
    timers: { setTimeout, clearTimeout, setInterval, clearInterval },
    workerId: "publisher-a",
    batchSize: 5,
    leaseMs: 5_000,
    publishTimeoutMs: 1_000,
    intervalMs: 10_000,
  });

  now = 1_100;
  const result = await publisher.publishOnce({ accountId: "account-a" });
  const [stored] = await outboxRepository.listAutoListingAiOutbox({ accountId: "account-a" });

  assert.deepEqual(result, { claimed: 1, published: 1, duplicates: 0, failed: 0 });
  assert.equal(stored.id, pending.id);
  assert.equal(stored.status, "COMPLETED");
  assert.equal(stored.completedAt, 1_100);
  assert.deepEqual(sent, [{
    name: "auto-listing-ai-v1",
    payload: message,
    options: {
      id: "39dc894b-0057-5e82-8907-e1cffbd25eb6",
      singletonKey: "5e6f8a19b642d50cef84bb57627e8310fca0cfc9b43de27510796eee9c79bfb8",
    },
  }]);
  await publisher.stop();
});

test("a queue publish failure fails only the exact outbox lease with a fixed safe retry code", async () => {
  const outboxRepository = createMemoryAutoListingAiOutboxRepository({
    now: () => 2_000,
    token: () => "lease-failure",
    baseRetryMs: 100,
    maxRetryMs: 100,
  });
  await outboxRepository.enqueueAutoListingAiMessage(message);
  const publisher = createAutoListingAiOutboxPublisher({
    enabled: true,
    outboxRepository,
    queueAdapter: {
      async publish() { throw new Error("postgres://user:password@production queue secret"); },
      async stop() {},
    },
    accountIds: async () => ["account-a"],
    timers: { setTimeout, clearTimeout, setInterval, clearInterval },
    workerId: "publisher-failure",
    batchSize: 1,
    leaseMs: 5_000,
    publishTimeoutMs: 1_000,
    intervalMs: 10_000,
  });

  const result = await publisher.publishOnce({ accountId: "account-a" });
  const [stored] = await outboxRepository.listAutoListingAiOutbox({ accountId: "account-a" });

  assert.deepEqual(result, { claimed: 1, published: 0, duplicates: 0, failed: 1 });
  assert.equal(stored.status, "PENDING");
  assert.equal(stored.lastErrorCode, "AUTO_LISTING_AI_QUEUE_PUBLISH_FAILED");
  assert.doesNotMatch(JSON.stringify(stored), /password|production|secret/iu);
});

test("a crash after queue publish leaves the outbox replayable and duplicate replay completes the new lease", async () => {
  let now = 3_000;
  let nonce = 0;
  const actualRepository = createMemoryAutoListingAiOutboxRepository({
    now: () => now,
    token: () => `lease-${++nonce}`,
  });
  await actualRepository.enqueueAutoListingAiMessage(message);
  let completionCalls = 0;
  let failureCalls = 0;
  const outboxRepository = {
    ...actualRepository,
    async completeAutoListingAiMessage(input) {
      completionCalls += 1;
      if (completionCalls === 1) throw new Error("process crashed after pg-boss commit password=raw");
      return actualRepository.completeAutoListingAiMessage(input);
    },
    async failAutoListingAiMessage(input) {
      failureCalls += 1;
      return actualRepository.failAutoListingAiMessage(input);
    },
  };
  let sends = 0;
  const queueAdapter = createAutoListingAiQueueAdapter({
    enabled: true,
    bossFactory: () => ({
      async start() {},
      async createQueue() {},
      async send(_name, _payload, options) { sends += 1; return sends === 1 ? options.id : null; },
      async stop() {},
    }),
  });
  const publisher = createAutoListingAiOutboxPublisher({
    enabled: true,
    outboxRepository,
    queueAdapter,
    accountIds: async () => ["account-a"],
    timers: { setTimeout, clearTimeout, setInterval, clearInterval },
    workerId: "publisher-replay",
    batchSize: 1,
    leaseMs: 100,
    publishTimeoutMs: 1_000,
    intervalMs: 10_000,
  });

  await assert.rejects(publisher.publishOnce({ accountId: "account-a" }), (error) => error?.code === "AUTO_LISTING_AI_PUBLISHER_FAILED"
    && error?.retryable === true && !/password|crash|pg-boss/iu.test(error.message));
  assert.equal(failureCalls, 0, "a successful queue publish must never be converted back to pending");
  assert.equal((await actualRepository.listAutoListingAiOutbox({ accountId: "account-a" }))[0].status, "PROCESSING");

  now = 3_100;
  assert.deepEqual(await publisher.publishOnce({ accountId: "account-a" }), { claimed: 1, published: 1, duplicates: 1, failed: 0 });
  assert.equal((await actualRepository.listAutoListingAiOutbox({ accountId: "account-a" }))[0].status, "COMPLETED");
  assert.equal(completionCalls, 2);
  assert.equal(sends, 2);
});

test("feature-disabled publisher starts no queue or timer and closed factories sanitize hidden or accessor inputs", async () => {
  let timerCalls = 0;
  let queueCalls = 0;
  const disabled = createAutoListingAiOutboxPublisher({ enabled: false });
  assert.equal(await disabled.start(), false);
  assert.deepEqual(await disabled.publishOnce({ accountId: "ignored-while-disabled" }), { claimed: 0, published: 0, duplicates: 0, failed: 0 });
  await disabled.stop();
  assert.equal(timerCalls, 0);
  assert.equal(queueCalls, 0);

  const hidden = { enabled: false };
  Object.defineProperty(hidden, "timers", { enumerable: false, value: { setInterval() { timerCalls += 1; } } });
  const accessor = { enabled: false };
  Object.defineProperty(accessor, "outboxRepository", { enumerable: true, get() { throw new Error("password=raw-production-secret"); } });
  const proxy = new Proxy({ enabled: false }, { ownKeys() { throw new Error("password=raw-production-secret"); } });
  for (const create of [
    () => createAutoListingAiQueueAdapter({ enabled: false, unexpected: true }),
    () => createAutoListingAiOutboxPublisher({ enabled: false, unexpected: true }),
    () => createAutoListingAiOutboxPublisher(hidden),
    () => createAutoListingAiOutboxPublisher(accessor),
    () => createAutoListingAiOutboxPublisher(proxy),
  ]) {
    assert.throws(create, (error) => error?.code && /_INVALID$/u.test(error.code)
      && !/password|production|secret/iu.test(error.message));
  }
});

test("enabled publisher replays immediately, bounds per-account concurrency and keeps a stoppable timer", async () => {
  const calls = [];
  let intervalCallback;
  const timer = { unref() { calls.push("unref"); } };
  let active = 0;
  let maximumActive = 0;
  const publisher = createAutoListingAiOutboxPublisher({
    enabled: true,
    outboxRepository: {
      async claimAutoListingAiMessages(input) {
        calls.push(["claim", input]);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return [];
      },
      async renewAutoListingAiMessageLease() { throw new Error("no rows"); },
      async completeAutoListingAiMessage() { throw new Error("no rows"); },
      async failAutoListingAiMessage() { throw new Error("no rows"); },
    },
    queueAdapter: {
      async start() { calls.push("queue-start"); return true; },
      async publish() { throw new Error("no rows"); },
      async stop() { calls.push("queue-stop"); },
    },
    accountIds: async () => ["account-a", "account-b"],
    timers: {
      setTimeout, clearTimeout,
      setInterval(callback, milliseconds) { calls.push(["setInterval", milliseconds]); intervalCallback = callback; return timer; },
      clearInterval(value) { calls.push(["clearInterval", value]); },
    },
    workerId: "publisher-timer",
    batchSize: 2,
    leaseMs: 4_000,
    publishTimeoutMs: 1_000,
    intervalMs: 2_000,
    accountConcurrency: 2,
  });

  assert.equal(await publisher.start(), true);
  assert.equal(await publisher.start(), true);
  assert.equal(typeof intervalCallback, "function");
  await intervalCallback();
  await publisher.stop();

  assert.deepEqual(calls, [
    "queue-start",
    ["claim", { accountId: "account-a", workerId: "publisher-timer", limit: 1, leaseMs: 4_000 }],
    ["claim", { accountId: "account-b", workerId: "publisher-timer", limit: 1, leaseMs: 4_000 }],
    ["setInterval", 2_000],
    "unref",
    ["claim", { accountId: "account-a", workerId: "publisher-timer", limit: 1, leaseMs: 4_000 }],
    ["claim", { accountId: "account-b", workerId: "publisher-timer", limit: 1, leaseMs: 4_000 }],
    ["clearInterval", timer],
    "queue-stop",
  ]);
  assert.equal(maximumActive, 2);
});

test("unknown pg-boss returns, malformed messages and raw adapter failures become fixed safe errors", async () => {
  let sends = 0;
  const queue = createAutoListingAiQueueAdapter({
    enabled: true,
    bossFactory: () => ({
      async start() {},
      async createQueue() {},
      async send() { sends += 1; return "unexpected-random-job-id"; },
      async stop() {},
    }),
  });
  await assert.rejects(queue.publish(message), (error) => error?.code === "AUTO_LISTING_AI_QUEUE_PUBLISH_FAILED"
    && error?.retryable === true && !/unexpected|random/iu.test(error.message));
  await assert.rejects(queue.publish({ ...message, prompt: "apiKey=raw-secret" }), (error) => error?.code === "AUTO_LISTING_AI_QUEUE_INVALID"
    && !/apiKey|secret/iu.test(error.message));
  assert.equal(sends, 1, "invalid messages must fail before reaching pg-boss");

  const unavailable = createAutoListingAiQueueAdapter({
    enabled: true,
    bossFactory: () => { throw new Error("postgres://user:password@production.internal"); },
  });
  await assert.rejects(unavailable.start(), (error) => error?.code === "AUTO_LISTING_AI_QUEUE_UNAVAILABLE"
    && error?.retryable === true && !/postgres|password|production/iu.test(error.message));

  const hostileError = new Error("raw queue error");
  Object.defineProperty(hostileError, "code", { get() { throw new Error("password=hidden-production-secret"); } });
  const hostile = createAutoListingAiQueueAdapter({
    enabled: true,
    bossFactory: () => ({ async start() {}, async createQueue() {}, async send() { throw hostileError; }, async stop() {} }),
  });
  await assert.rejects(hostile.publish(message), (error) => error?.code === "AUTO_LISTING_AI_QUEUE_PUBLISH_FAILED"
    && !/password|production|secret/iu.test(error.message));
});

test("queue startup cleans a started candidate when createQueue fails", async () => {
  const calls = [];
  const queue = createAutoListingAiQueueAdapter({
    enabled: true,
    bossFactory: () => ({
      async start() { calls.push("start"); },
      async createQueue() { calls.push("createQueue"); throw new Error("password=raw-production"); },
      async send() { throw new Error("must not send"); },
      async stop(options) { calls.push(["stop", options]); },
    }),
  });
  await assert.rejects(queue.start(), (error) => error?.code === "AUTO_LISTING_AI_QUEUE_UNAVAILABLE"
    && error.retryable === true && !/password|production/iu.test(error.message));
  assert.deepEqual(calls, ["start", "createQueue", ["stop", { graceful: true, timeout: 30_000 }]]);
});

test("scheduled publisher isolates one account failure and reports only safe per-account outcomes", async () => {
  const claims = [];
  const records = [];
  let tick;
  const publisher = createAutoListingAiOutboxPublisher({
    enabled: true,
    outboxRepository: {
      async claimAutoListingAiMessages({ accountId }) {
        claims.push(accountId);
        if (accountId === "account-a") throw new Error("postgres://user:password@production");
        return [];
      },
      async renewAutoListingAiMessageLease() { throw new Error("no rows"); },
      async completeAutoListingAiMessage() {},
      async failAutoListingAiMessage() {},
    },
    queueAdapter: { async start() {}, async publish() {}, async stop() {} },
    accountIds: async () => ["account-a", "account-b"],
    logger: { log(record) { records.push(record); } },
    timers: {
      setTimeout, clearTimeout,
      setInterval(callback) { tick = callback; return { unref() {} }; },
      clearInterval() {},
    },
    workerId: "publisher-account-isolation",
    batchSize: 2,
    leaseMs: 5_000,
    publishTimeoutMs: 1_000,
    intervalMs: 10_000,
  });
  await publisher.start();
  claims.length = 0;
  records.length = 0;
  assert.deepEqual(await tick(), [
    { accountId: "account-a", status: "FAILED", errorCode: "AUTO_LISTING_AI_PUBLISHER_FAILED" },
    { accountId: "account-b", status: "COMPLETED", claimed: 0, published: 0, duplicates: 0, failed: 0 },
  ]);
  assert.deepEqual(claims, ["account-a", "account-b"]);
  assert.deepEqual(records, [{ component: "AUTO_LISTING_AI_OUTBOX_RELAY", code: "AUTO_LISTING_AI_PUBLISHER_FAILED" }]);
  assert.doesNotMatch(JSON.stringify(await tick()), /password|postgres|production/iu);
  await publisher.stop();
});

test("more than 101 accounts stay fair when the first four account claims are slow", async () => {
  const all = Array.from({ length: 102 }, (_, index) => `account-${String(index).padStart(3, "0")}`);
  let page = 0;
  let tick;
  const claimed = [];
  const publisher = createAutoListingAiOutboxPublisher({
    enabled: true,
    outboxRepository: {
      async claimAutoListingAiMessages({ accountId }) {
        claimed.push(accountId);
        if (Number(accountId.slice(-3)) < 4) return new Promise(() => {});
        return [];
      },
      async renewAutoListingAiMessageLease() { throw new Error("no rows"); },
      async completeAutoListingAiMessage() {},
      async failAutoListingAiMessage() {},
    },
    queueAdapter: { async start() {}, async publish() {}, async stop() {} },
    accountIds: async () => (page++ === 0 ? all.slice(0, 100) : all.slice(100)),
    logger: { log() {} },
    timers: {
      setTimeout, clearTimeout,
      setInterval(callback) { tick = callback; return { unref() {} }; },
      clearInterval() {},
    },
    workerId: "publisher-fairness",
    batchSize: 2,
    leaseMs: 30_000,
    publishTimeoutMs: 5,
    intervalMs: 10_000,
    accountConcurrency: 4,
  });

  assert.equal(await publisher.start(), true);
  assert.equal(claimed.includes("account-004"), true, "healthy accounts must run after a bounded slow-claim timeout");
  assert.equal(claimed.includes("account-099"), true);
  await tick();
  assert.deepEqual(claimed.slice(-2), ["account-100", "account-101"]);
  await publisher.stop();
});

test("publisher startup discovery failure cleans the queue and logs only a fixed safe code", async () => {
  const calls = [];
  const records = [];
  const publisher = createAutoListingAiOutboxPublisher({
    enabled: true,
    outboxRepository: {
      async claimAutoListingAiMessages() { return []; },
      async renewAutoListingAiMessageLease() { throw new Error("no rows"); },
      async completeAutoListingAiMessage() {},
      async failAutoListingAiMessage() {},
    },
    queueAdapter: {
      async start() { calls.push("queue-start"); },
      async publish() {},
      async stop() { calls.push("queue-stop"); },
    },
    accountIds: async () => { throw new Error("postgres://user:password@production.internal"); },
    logger: { log(record) { records.push(record); } },
    timers: {
      setTimeout, clearTimeout,
      setInterval() { calls.push("timer-started"); },
      clearInterval() {},
    },
    workerId: "publisher-start-failure",
    batchSize: 2,
    leaseMs: 5_000,
    publishTimeoutMs: 1_000,
    intervalMs: 10_000,
  });

  await assert.rejects(publisher.start(), (error) => error?.code === "AUTO_LISTING_AI_PUBLISHER_FAILED"
    && error.retryable === true && !/password|postgres|production/iu.test(error.message));
  assert.deepEqual(calls, ["queue-start", "queue-stop"]);
  assert.deepEqual(records, [{ component: "AUTO_LISTING_AI_OUTBOX_RELAY", code: "AUTO_LISTING_AI_PUBLISHER_FAILED" }]);
  assert.doesNotMatch(JSON.stringify(records), /password|postgres|production/iu);
});

test("publisher stop always closes the queue when an in-flight discovery cycle fails", async () => {
  const calls = [];
  let tick;
  let discoveryCalls = 0;
  let rejectDiscovery;
  const publisher = createAutoListingAiOutboxPublisher({
    enabled: true,
    outboxRepository: {
      async claimAutoListingAiMessages() { return []; },
      async renewAutoListingAiMessageLease() { throw new Error("no rows"); },
      async completeAutoListingAiMessage() {},
      async failAutoListingAiMessage() {},
    },
    queueAdapter: {
      async start() { calls.push("queue-start"); },
      async publish() {},
      async stop() { calls.push("queue-stop"); },
    },
    accountIds: async () => {
      discoveryCalls += 1;
      if (discoveryCalls === 1) return [];
      return new Promise((resolve, reject) => { rejectDiscovery = reject; });
    },
    logger: { log() {} },
    timers: {
      setTimeout, clearTimeout,
      setInterval(callback) { tick = callback; return { unref() {} }; },
      clearInterval() { calls.push("timer-stop"); },
    },
    workerId: "publisher-stop-failure",
    batchSize: 2,
    leaseMs: 5_000,
    publishTimeoutMs: 1_000,
    intervalMs: 10_000,
  });

  await publisher.start();
  const scheduled = tick();
  await Promise.resolve();
  const stopping = publisher.stop();
  rejectDiscovery(new Error("postgres://user:password@production.internal"));
  await scheduled;
  await assert.rejects(stopping, (error) => error?.code === "AUTO_LISTING_AI_PUBLISHER_FAILED"
    && !/password|postgres|production/iu.test(error.message));
  assert.deepEqual(calls, ["queue-start", "timer-stop", "queue-stop"]);
});

test("publisher stop waits for in-flight startup and removes a timer created during startup", async () => {
  const calls = [];
  let releaseQueueStart;
  const queueStarted = new Promise((resolve) => { releaseQueueStart = resolve; });
  const timer = { unref() {} };
  const publisher = createAutoListingAiOutboxPublisher({
    enabled: true,
    outboxRepository: {
      async claimAutoListingAiMessages() { return []; },
      async renewAutoListingAiMessageLease() { throw new Error("no rows"); },
      async completeAutoListingAiMessage() {},
      async failAutoListingAiMessage() {},
    },
    queueAdapter: {
      async start() { calls.push("queue-start-begin"); await queueStarted; calls.push("queue-start-end"); },
      async publish() {},
      async stop() { calls.push("queue-stop"); },
    },
    accountIds: async () => [],
    logger: { log() {} },
    timers: {
      setTimeout, clearTimeout,
      setInterval() { calls.push("timer-start"); return timer; },
      clearInterval(value) { calls.push(["timer-stop", value]); },
    },
    workerId: "publisher-stop-startup",
    batchSize: 2,
    leaseMs: 5_000,
    publishTimeoutMs: 1_000,
    intervalMs: 10_000,
  });

  const starting = publisher.start();
  await Promise.resolve();
  const stopping = publisher.stop();
  releaseQueueStart();
  assert.equal(await starting, true);
  await stopping;
  assert.deepEqual(calls, [
    "queue-start-begin", "queue-start-end", "timer-start", ["timer-stop", timer], "queue-stop",
  ]);
});

test("publisher enforces the fixed batch and timeout ceilings and times out a stuck publish into a fenced retry", async () => {
  let now = 4_000;
  const outboxRepository = createMemoryAutoListingAiOutboxRepository({ now: () => now, token: () => "lease-timeout" });
  await outboxRepository.enqueueAutoListingAiMessage(message);
  let timeoutCallback;
  let timeoutMilliseconds;
  const timers = {
    setTimeout(callback, milliseconds) { timeoutCallback = callback; timeoutMilliseconds = milliseconds; return { kind: "timeout" }; },
    clearTimeout() {},
    setInterval() { throw new Error("timer must not start in publishOnce"); },
    clearInterval() {},
  };
  const base = {
    enabled: true,
    outboxRepository,
    queueAdapter: { async publish() { return new Promise(() => {}); }, async stop() {} },
    accountIds: async () => ["account-a"],
    timers,
    workerId: "publisher-timeout",
    batchSize: 1,
    leaseMs: 5_000,
    publishTimeoutMs: 1_000,
    intervalMs: 10_000,
  };
  const publisher = createAutoListingAiOutboxPublisher(base);

  const operation = publisher.publishOnce({ accountId: "account-a" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeoutMilliseconds, 1_000);
  timeoutCallback();
  assert.deepEqual(await operation, { claimed: 1, published: 0, duplicates: 0, failed: 1 });
  const [stored] = await outboxRepository.listAutoListingAiOutbox({ accountId: "account-a" });
  assert.equal(stored.status, "PENDING");
  assert.equal(stored.lastErrorCode, "AUTO_LISTING_AI_QUEUE_PUBLISH_FAILED");

  for (const override of [
    { batchSize: 51 },
    { leaseMs: 300_001 },
    { publishTimeoutMs: 60_001 },
    { intervalMs: 60_001 },
  ]) assert.throws(() => createAutoListingAiOutboxPublisher({ ...base, ...override }), { code: "AUTO_LISTING_AI_PUBLISHER_INVALID" });
});

test("publisher leaves the lease replayable when a queue adapter returns forged publication evidence", async () => {
  const actualRepository = createMemoryAutoListingAiOutboxRepository({ now: () => 5_000, token: () => "lease-forged" });
  await actualRepository.enqueueAutoListingAiMessage(message);
  let completionCalls = 0;
  let failureCalls = 0;
  const publisher = createAutoListingAiOutboxPublisher({
    enabled: true,
    outboxRepository: {
      ...actualRepository,
      async completeAutoListingAiMessage(input) { completionCalls += 1; return actualRepository.completeAutoListingAiMessage(input); },
      async failAutoListingAiMessage(input) { failureCalls += 1; return actualRepository.failAutoListingAiMessage(input); },
    },
    queueAdapter: {
      async publish() {
        const forged = {
          publicationId: "39dc894b-0057-5e82-8907-e1cffbd25eb6",
          singletonKey: "5e6f8a19b642d50cef84bb57627e8310fca0cfc9b43de27510796eee9c79bfb8",
          duplicate: false,
        };
        Object.defineProperty(forged, "rawSecret", { value: "password=hidden", enumerable: false });
        return forged;
      },
      async stop() {},
    },
    accountIds: async () => ["account-a"],
    timers: { setTimeout, clearTimeout, setInterval, clearInterval },
    workerId: "publisher-forged",
    batchSize: 1,
    leaseMs: 5_000,
    publishTimeoutMs: 1_000,
    intervalMs: 10_000,
  });

  await assert.rejects(publisher.publishOnce({ accountId: "account-a" }), { code: "AUTO_LISTING_AI_PUBLISHER_FAILED" });
  assert.equal(completionCalls, 0);
  assert.equal(failureCalls, 0, "ambiguous post-publish evidence must not be republished immediately");
  assert.equal((await actualRepository.listAutoListingAiOutbox({ accountId: "account-a" }))[0].status, "PROCESSING");
});
