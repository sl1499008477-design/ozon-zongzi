import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_LISTING_AI_PHASE_POLICIES,
  createAutoListingAiWorker as createWorkerFactory,
} from "../auto-listing-ai-worker.mjs";
import {
  AUTO_LISTING_AI_QUEUE,
  AUTO_LISTING_AI_QUEUE_OPTIONS,
  AUTO_LISTING_AI_WORK_QUEUE,
  AUTO_LISTING_AI_WORK_QUEUE_OPTIONS,
} from "../auto-listing-ai-queue.mjs";

const baseMessage = Object.freeze({
  contractVersion: "V1",
  accountId: "account-a",
  itemId: "item-a",
  phase: "PLAN_CONTENT",
  expectedStatusVersion: 3,
  correlationId: "correlation-a",
});

const legacyExecutionRepository = Object.freeze({
  async adopt() { return null; },
  async renew() { return null; },
  async requeueChannelFailure() { return null; },
});

function createAutoListingAiWorker(config) {
  return createWorkerFactory({ executionRepository: legacyExecutionRepository, ...config });
}

test("default paid phases keep concurrency and retry policy without application deadlines", () => {
  assert.equal(AUTO_LISTING_AI_PHASE_POLICIES.GENERATE_IMAGE_SLOT.concurrency, 1);
  assert.equal(AUTO_LISTING_AI_PHASE_POLICIES.GENERATE_IMAGE_SLOT.retryLimit, 0);
  assert.equal(Object.hasOwn(AUTO_LISTING_AI_PHASE_POLICIES.GENERATE_IMAGE_SLOT, "timeoutMs"), false);
  assert.equal(Object.hasOwn(AUTO_LISTING_AI_PHASE_POLICIES.PLAN_CONTENT, "timeoutMs"), false);
});

function manualTimers() {
  let now = 0;
  let sequence = 0;
  const scheduled = [];
  const timers = {
    now() { return now; },
    setTimeout(callback, delay) {
      const handle = { at: now + delay, callback, cancelled: false, sequence: sequence += 1 };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) handle.cancelled = true;
    },
    async advanceBy(delay) {
      const end = now + delay;
      while (true) {
        const next = scheduled
          .filter((handle) => !handle.cancelled && handle.at <= end)
          .sort((left, right) => left.at - right.at || left.sequence - right.sequence)[0];
        if (!next) break;
        next.cancelled = true;
        now = next.at;
        next.callback();
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      }
      now = end;
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    },
  };
  return timers;
}

test("a paid rich phase may finish after the former outer deadline", async () => {
  const harness = bossHarness();
  const timers = manualTimers();
  const message = { ...baseMessage, phase: "GENERATE_RICH_CONTENT" };
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (value) => context(value, { status: "GENERATING" }),
    orchestrate: async ({ message: current }) => new Promise((resolve) => {
      timers.setTimeout(() => resolve(phaseOutcome(current, { outcome: "CONTENT_READY_FOR_REVIEW" })), 180_000);
    }),
    workflow: passthroughWorkflow,
    logger: { log() {} },
    timers,
  });
  await worker.start();

  const processing = harness.handler()([{ id: "rich-boundary", data: message }]);
  await new Promise((resolve) => setImmediate(resolve));
  await timers.advanceBy(180_000);

  assert.deepEqual(await processing, [{
    id: "rich-boundary", status: "completed",
    output: { disposition: "ACK", code: "CONTENT_READY_FOR_REVIEW" },
  }]);
  await worker.stop();
});

function phasePolicies(overrides = {}) {
  return Object.fromEntries(Object.keys(AUTO_LISTING_AI_PHASE_POLICIES).map((phase) => [
    phase,
    { concurrency: 1, retryLimit: 0, retryDelayMs: 1, ...overrides[phase] },
  ]));
}

function context(message, overrides = {}) {
  return {
    accountId: message.accountId,
    jobId: "job-a",
    itemId: message.itemId,
    status: "PLANNING",
    statusVersion: message.expectedStatusVersion,
    activeContentPlanId: null,
    phaseInput: { requestId: "phase-input-a" },
    ...overrides,
  };
}

function phaseOutcome(message, overrides = {}) {
  return Object.freeze({
    contractVersion: "V1",
    disposition: "ACK",
    phase: message.phase,
    outcome: message.phase === "PLAN_CONTENT" ? "PLAN_READY" : "IMAGE_SLOT_ACCEPTED",
    retryable: false,
    failureCode: null,
    correlationId: message.correlationId,
    failureScope: null,
    deliveryState: null,
    retryAfterMs: null,
    ...overrides,
  });
}

const passthroughWorkflow = Object.freeze({
  async applyOutcome({ outcome }) { return outcome; },
});

function bossHarness() {
  const calls = [];
  const handlers = new Map();
  const boss = {
    on(event) { calls.push(["on", event]); },
    async start() { calls.push(["start"]); },
    async createQueue(name, options) { calls.push(["createQueue", name, options]); },
    async work(name, options, callback) {
      calls.push(["work", name, options]);
      handlers.set(name, callback);
      return "worker-a";
    },
    async stop(options) { calls.push(["stop", options]); },
  };
  return { boss, calls, handler: (name = AUTO_LISTING_AI_QUEUE) => handlers.get(name) };
}

test("either disabled feature flag yields a worker handle that creates no PgBoss, context loader, orchestrator, or timer", async () => {
  let factories = 0;
  let timers = 0;
  const worker = createAutoListingAiWorker({
    enabled: false,
    bossFactory: () => { factories += 1; },
    loadContext: async () => { throw new Error("must not load"); },
    orchestrate: async () => { throw new Error("must not orchestrate"); },
    workflow: passthroughWorkflow,
    timers: {
      setTimeout() { timers += 1; },
      clearTimeout() {},
    },
  });

  assert.equal(await worker.start(), false);
  await worker.stop();
  assert.equal(factories, 0);
  assert.equal(timers, 0);
});

test("enabled construction requires an explicit queue factory and partial startup is cleaned without leaking raw errors", async () => {
  assert.throws(
    () => createAutoListingAiWorker({
      enabled: true,
      bossFactory: () => bossHarness().boss,
      loadContext: async () => context(baseMessage),
      orchestrate: async () => phaseOutcome(baseMessage),
    }),
    (error) => error?.code === "AUTO_LISTING_AI_WORKER_INVALID",
  );

  assert.throws(
    () => createAutoListingAiWorker({
      enabled: true,
      loadContext: async () => context(baseMessage),
      orchestrate: async () => phaseOutcome(baseMessage),
      workflow: passthroughWorkflow,
    }),
    (error) => error?.code === "AUTO_LISTING_AI_WORKER_INVALID",
  );

  const calls = [];
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => ({
      async start() { calls.push("start"); },
      async createQueue() { calls.push("createQueue"); throw new Error("password=raw-secret"); },
      async work() { calls.push("work"); },
      async stop(options) { calls.push(["stop", options]); },
    }),
    loadContext: async () => context(baseMessage),
    orchestrate: async () => phaseOutcome(baseMessage),
    workflow: passthroughWorkflow,
    logger: { log() {} },
    phasePolicies: phasePolicies(),
    timers: { setTimeout, clearTimeout },
  });
  await assert.rejects(
    worker.start(),
    (error) => error?.code === "AUTO_LISTING_AI_WORKER_START_FAILED"
      && !/password|raw-secret/iu.test(error.message),
  );
  assert.deepEqual(calls, ["start", "createQueue", ["stop", { graceful: true, timeout: 300_000 }]]);
});

test("worker persists a terminal orchestrator outcome before acknowledging its queue job", async () => {
  const harness = bossHarness();
  const order = [];
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => { order.push("load"); return context(message); },
    orchestrate: async ({ message }) => { order.push("orchestrate"); return phaseOutcome(message); },
    workflow: Object.freeze({
      async applyOutcome({ message, outcome, execution }) {
        order.push("apply");
        assert.deepEqual(message, baseMessage);
        assert.deepEqual(outcome, phaseOutcome(message));
        assert.equal(execution, null);
      },
    }),
    logger: { log() {} },
    phasePolicies: phasePolicies(),
    timers: { setTimeout, clearTimeout },
  });
  await worker.start();

  assert.deepEqual(await harness.handler()([{ id: "persist-before-ack", data: baseMessage }]), [{
    id: "persist-before-ack", status: "completed",
    output: { disposition: "ACK", code: "PLAN_READY" },
  }]);
  order.push("acknowledged");
  assert.deepEqual(order, ["load", "orchestrate", "apply", "acknowledged"]);
  await worker.stop();
});

test("worker returns an outcome persistence failure to pg-boss and a later queue delivery retries safely", async () => {
  const harness = bossHarness();
  const calls = { load: 0, orchestrate: 0, apply: 0 };
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => { calls.load += 1; return context(message); },
    orchestrate: async ({ message }) => { calls.orchestrate += 1; return phaseOutcome(message); },
    workflow: Object.freeze({
      async applyOutcome() {
        calls.apply += 1;
        if (calls.apply === 1) {
          const error = new Error("password=raw-secret");
          error.code = "AUTO_LISTING_AI_WORKFLOW_PERSIST_FAILED";
          error.retryable = true;
          throw error;
        }
      },
    }),
    logger: { log() {} },
    phasePolicies: phasePolicies({ PLAN_CONTENT: { retryLimit: 1 } }),
    timers: {
      setTimeout(callback, delay) {
        if (delay === 1) { queueMicrotask(callback); return Object.freeze({ retry: true }); }
        return setTimeout(callback, delay);
      },
      clearTimeout(handle) { if (!handle?.retry) clearTimeout(handle); },
    },
  });
  await worker.start();

  assert.deepEqual(await harness.handler()([{ id: "persist-retry", data: baseMessage }]), [{
    id: "persist-retry", status: "failed",
    output: { disposition: "FAILED", code: "AUTO_LISTING_AI_WORKFLOW_PERSIST_FAILED" },
  }]);
  assert.deepEqual(calls, { load: 1, orchestrate: 1, apply: 1 });
  assert.deepEqual(await harness.handler()([{ id: "persist-retry", data: baseMessage }]), [{
    id: "persist-retry", status: "completed", output: { disposition: "ACK", code: "PLAN_READY" },
  }]);
  assert.deepEqual(calls, { load: 2, orchestrate: 2, apply: 2 });
  await worker.stop();
});

test("a lost apply response returns failure, then the queue redelivery ACKs stale without repeating the external phase", async () => {
  const harness = bossHarness();
  let advanced = false;
  let loads = 0;
  let orchestrations = 0;
  let applies = 0;
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => {
      loads += 1;
      return context(message, advanced ? { statusVersion: message.expectedStatusVersion + 1 } : {});
    },
    orchestrate: async ({ message }) => { orchestrations += 1; return phaseOutcome(message); },
    workflow: Object.freeze({
      async applyOutcome() {
        applies += 1;
        advanced = true;
        const error = new Error("database reply was lost after commit");
        error.code = "AUTO_LISTING_AI_WORKFLOW_DATABASE_FAILED";
        error.retryable = true;
        throw error;
      },
    }),
    logger: { log() {} },
    phasePolicies: phasePolicies({ PLAN_CONTENT: { retryLimit: 1 } }),
    timers: {
      setTimeout(callback, delay) {
        if (delay === 1) { queueMicrotask(callback); return Object.freeze({ retry: true }); }
        return setTimeout(callback, delay);
      },
      clearTimeout(handle) { if (!handle?.retry) clearTimeout(handle); },
    },
  });
  await worker.start();

  assert.deepEqual(await harness.handler()([{ id: "lost-apply-response", data: baseMessage }]), [{
    id: "lost-apply-response", status: "failed",
    output: { disposition: "FAILED", code: "AUTO_LISTING_AI_WORKFLOW_DATABASE_FAILED" },
  }]);
  assert.deepEqual({ loads, orchestrations, applies }, { loads: 1, orchestrations: 1, applies: 1 });
  assert.deepEqual(await harness.handler()([{ id: "lost-apply-response", data: baseMessage }]), [{
    id: "lost-apply-response", status: "completed",
    output: { disposition: "ACK", code: "AUTO_LISTING_AI_MESSAGE_STALE" },
  }]);
  assert.deepEqual({ loads, orchestrations, applies }, { loads: 2, orchestrations: 1, applies: 1 });
  await worker.stop();
});

test("outcome persistence may finish after the former database deadline without recursive writes", async () => {
  const harness = bossHarness();
  let applies = 0;
  let finishPersistence;
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => phaseOutcome(message),
    workflow: Object.freeze({
      async applyOutcome() {
        applies += 1;
        await new Promise((resolve) => { finishPersistence = resolve; });
      },
    }),
    logger: { log() {} },
    phasePolicies: phasePolicies(),
    timers: { setTimeout, clearTimeout },
  });
  await worker.start();

  let settled = false;
  const processing = harness.handler()([{ id: "slow-persistence", data: baseMessage }])
    .then((result) => { settled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(applies, 1);
  finishPersistence();
  assert.deepEqual(await processing, [{
    id: "slow-persistence", status: "completed",
    output: { disposition: "ACK", code: "PLAN_READY" },
  }]);
  assert.equal(applies, 1);
  await worker.stop();
});

test("intermediate RETRY is not persisted, while exhausted RETRY and terminal FAIL are persisted then ACKed", async () => {
  for (const scenario of ["retry-then-ack", "retry-exhausted", "terminal-fail"]) {
    const harness = bossHarness();
    const applied = [];
    let attempts = 0;
    const worker = createAutoListingAiWorker({
      enabled: true,
      bossFactory: () => harness.boss,
      loadContext: async (message) => context(message),
      orchestrate: async ({ message }) => {
        attempts += 1;
        if (scenario === "retry-then-ack" && attempts > 1) return phaseOutcome(message);
        if (scenario === "terminal-fail") {
          return phaseOutcome(message, {
            disposition: "FAIL", outcome: "FAILED", retryable: false,
            failureCode: "AUTO_LISTING_CONTENT_PLAN_INVALID",
          });
        }
        return phaseOutcome(message, {
          disposition: "RETRY", outcome: "FAILED", retryable: true,
          failureCode: "AUTO_LISTING_CONTENT_PLAN_GATEWAY_FAILED",
        });
      },
      workflow: Object.freeze({ async applyOutcome({ message, outcome }) { applied.push([message, outcome]); } }),
      logger: { log() {} },
      phasePolicies: phasePolicies({ PLAN_CONTENT: { retryLimit: scenario === "terminal-fail" ? 0 : 1 } }),
      timers: {
        setTimeout(callback, delay) {
          if (delay === 1) { queueMicrotask(callback); return Object.freeze({ retry: true }); }
          return setTimeout(callback, delay);
        },
        clearTimeout(handle) { if (!handle?.retry) clearTimeout(handle); },
      },
    });
    await worker.start();
    const result = await harness.handler()([{ id: scenario, data: baseMessage }]);

    assert.equal(applied.length, 1);
    assert.deepEqual(applied[0][0], baseMessage);
    if (scenario === "retry-then-ack") {
      assert.equal(attempts, 2);
      assert.equal(applied[0][1].disposition, "ACK");
      assert.deepEqual(result, [{ id: scenario, status: "completed", output: { disposition: "ACK", code: "PLAN_READY" } }]);
    } else {
      assert.equal(applied[0][1].disposition, "FAIL");
      assert.equal(applied[0][1].retryable, scenario === "retry-exhausted");
      assert.deepEqual(result, [{
        id: scenario, status: "completed",
        output: {
          disposition: "FAIL",
          code: scenario === "retry-exhausted"
            ? "AUTO_LISTING_CONTENT_PLAN_GATEWAY_FAILED" : "AUTO_LISTING_CONTENT_PLAN_INVALID",
        },
      }]);
    }
    await worker.stop();
  }
});

test("gateway rate limiting is persisted after one attempt without consuming automatic retries", async () => {
  const harness = bossHarness();
  const applied = [];
  let attempts = 0;
  let retryTimers = 0;
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => {
      attempts += 1;
      return phaseOutcome(message, {
        disposition: "RETRY", outcome: "FAILED", retryable: true,
        failureCode: "AI_GATEWAY_RATE_LIMITED",
      });
    },
    workflow: Object.freeze({ async applyOutcome({ message, outcome }) { applied.push([message, outcome]); } }),
    logger: { log() {} },
    phasePolicies: phasePolicies({ PLAN_CONTENT: { retryLimit: 2 } }),
    timers: {
      setTimeout(callback, delay) {
        if (delay === 1) { retryTimers += 1; queueMicrotask(callback); return Object.freeze({ retry: true }); }
        return setTimeout(callback, delay);
      },
      clearTimeout(handle) { if (!handle?.retry) clearTimeout(handle); },
    },
  });
  await worker.start();

  const result = await harness.handler()([{ id: "rate-limited", data: baseMessage }]);

  assert.equal(attempts, 1);
  assert.equal(retryTimers, 0);
  assert.equal(applied.length, 1);
  assert.equal(applied[0][1].disposition, "FAIL");
  assert.equal(applied[0][1].retryable, true);
  assert.equal(applied[0][1].failureCode, "AI_GATEWAY_RATE_LIMITED");
  assert.deepEqual(result, [{
    id: "rate-limited", status: "completed",
    output: { disposition: "FAIL", code: "AI_GATEWAY_RATE_LIMITED" },
  }]);
  await worker.stop();
});

test("a retryable context failure is closed through the workflow before the queue job is acknowledged", async () => {
  const harness = bossHarness();
  const applied = [];
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async () => {
      const error = new Error("postgres://raw-secret");
      error.code = "AUTO_LISTING_AI_CONTEXT_DATABASE_FAILED";
      error.retryable = true;
      throw error;
    },
    orchestrate: async () => { throw new Error("must not orchestrate"); },
    workflow: Object.freeze({ async applyOutcome({ message, outcome }) { applied.push([message, outcome]); } }),
    logger: { log() {} },
    phasePolicies: phasePolicies({ PLAN_CONTENT: { retryLimit: 0 } }),
    timers: { setTimeout, clearTimeout },
  });
  await worker.start();
  const result = await harness.handler()([{ id: "closed-context", data: baseMessage }]);
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0][0], baseMessage);
  assert.equal(applied[0][1].disposition, "FAIL");
  assert.equal(applied[0][1].retryable, true);
  assert.equal(applied[0][1].failureCode, "AUTO_LISTING_AI_CONTEXT_DATABASE_FAILED");
  assert.equal(result[0].status, "completed");
  assert.equal(result[0].output.disposition, "FAIL");
  await worker.stop();
});

test("workflow persistence failure is returned to pg-boss so its durable retry policy can retry", async () => {
  const harness = bossHarness();
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => phaseOutcome(message),
    workflow: Object.freeze({
      async applyOutcome() {
        const error = new Error("database unavailable password=raw");
        error.code = "AUTO_LISTING_AI_WORKFLOW_DATABASE_FAILED";
        error.retryable = true;
        throw error;
      },
    }),
    logger: { log() {} },
    phasePolicies: phasePolicies(),
    timers: { setTimeout, clearTimeout },
  });
  await worker.start();
  const [result] = await harness.handler()([{ id: "pg-boss-retry", data: baseMessage }]);
  assert.equal(result.status, "failed");
  assert.equal(result.output.code, "AUTO_LISTING_AI_WORKFLOW_DATABASE_FAILED");
  assert.equal(AUTO_LISTING_AI_QUEUE_OPTIONS.retryLimit > 0, true);
  assert.doesNotMatch(JSON.stringify(result), /password|database unavailable|raw/iu);
  await worker.stop();
});

test("phase policy rejects obsolete application deadline fields", () => {
  let factories = 0;
  assert.throws(
    () => createAutoListingAiWorker({
      enabled: true,
      bossFactory: () => { factories += 1; },
      loadContext: async (message) => context(message),
      orchestrate: async ({ message }) => phaseOutcome(message),
      workflow: passthroughWorkflow,
      phasePolicies: phasePolicies({
        PLAN_CONTENT: { timeoutMs: 280_000, retryLimit: 2, retryDelayMs: 1_000 },
      }),
      logger: { log() {} },
      timers: { setTimeout, clearTimeout },
    }),
    (error) => error?.code === "AUTO_LISTING_AI_WORKER_INVALID",
  );
  assert.equal(factories, 0);
});

test("an observability sink failure never changes a successfully processed phase", async () => {
  const harness = bossHarness();
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => phaseOutcome(message),
    workflow: passthroughWorkflow,
    logger: { log() { throw new Error("logger unavailable"); } },
    phasePolicies: phasePolicies(),
    timers: { setTimeout, clearTimeout },
  });

  assert.equal(await worker.start(), true);
  assert.deepEqual(await harness.handler()([{ id: "job-a", data: baseMessage }]), [{
    id: "job-a", status: "completed", output: { disposition: "ACK", code: "PLAN_READY" },
  }]);
  await worker.stop();
});

test("an acknowledged phase may retain a stable diagnostic failure code without failing the queue job", async () => {
  const harness = bossHarness();
  const logs = [];
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => phaseOutcome(message, {
      outcome: "IMAGE_SLOT_SKIPPED",
      failureCode: "AUTO_LISTING_IMAGE_POLICY_REJECTED",
    }),
    workflow: passthroughWorkflow,
    logger: { log(record) { logs.push(record); } },
    phasePolicies: phasePolicies(),
    timers: { setTimeout, clearTimeout },
  });

  await worker.start();
  assert.deepEqual(await harness.handler()([{ id: "policy-skip", data: baseMessage }]), [{
    id: "policy-skip", status: "completed", output: { disposition: "ACK", code: "IMAGE_SLOT_SKIPPED" },
  }]);
  assert.deepEqual(logs.at(-1), {
    correlationId: "correlation-a", phase: "PLAN_CONTENT", code: "IMAGE_SLOT_SKIPPED",
  });
  await worker.stop();
});

test("dedicated worker creates the v2 drain and v3 queue and reloads exact context before one legacy orchestration", async () => {
  const harness = bossHarness();
  const loaded = [];
  const orchestrated = [];
  const logs = [];
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => {
      loaded.push(message);
      return context(message);
    },
    orchestrate: async (input) => {
      orchestrated.push(input);
      return phaseOutcome(input.message);
    },
    workflow: passthroughWorkflow,
    logger: { log(record) { logs.push(record); } },
    phasePolicies: phasePolicies(),
    timers: { setTimeout, clearTimeout },
  });

  assert.equal(await worker.start(), true);
  const result = await harness.handler()([{ id: "queue-job-a", data: { ...baseMessage } }]);

  assert.deepEqual(harness.calls.filter((entry) => entry[0] === "createQueue"), [
    ["createQueue", AUTO_LISTING_AI_QUEUE, AUTO_LISTING_AI_QUEUE_OPTIONS],
    ["createQueue", AUTO_LISTING_AI_WORK_QUEUE, AUTO_LISTING_AI_WORK_QUEUE_OPTIONS],
  ]);
  const work = harness.calls.find((entry) => entry[0] === "work");
  assert.equal(work[1], AUTO_LISTING_AI_QUEUE);
  assert.equal(work[2].perJobResults, true);
  assert.deepEqual(loaded, [baseMessage]);
  assert.deepEqual(orchestrated, [{ message: baseMessage, context: context(baseMessage) }]);
  assert.deepEqual(result, [{
    id: "queue-job-a",
    status: "completed",
    output: { disposition: "ACK", code: "PLAN_READY" },
  }]);
  assert.deepEqual(logs.at(-1), {
    correlationId: "correlation-a", phase: "PLAN_CONTENT", code: "PLAN_READY",
  });
  assert.doesNotMatch(JSON.stringify({ calls: harness.calls, logs }), /submission|sourceRef|apiKey|secret/iu);
  await worker.stop();
});

test("stale and cancelled messages ACK after reload with zero orchestrator calls", async () => {
  const harness = bossHarness();
  let orchestrations = 0;
  let phaseInputReads = 0;
  const contexts = [
    {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", status: "PLANNING",
      statusVersion: 4, activeContentPlanId: null,
      get phaseInput() { phaseInputReads += 1; throw new Error("must not read stale phase input"); },
    },
    {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", status: "CANCELLED",
      statusVersion: 3, activeContentPlanId: null,
      get phaseInput() { phaseInputReads += 1; throw new Error("must not read cancelled phase input"); },
    },
  ];
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async () => contexts.shift(),
    orchestrate: async ({ message }) => { orchestrations += 1; return phaseOutcome(message); },
    workflow: passthroughWorkflow,
    logger: { log() {} },
    phasePolicies: phasePolicies(),
    timers: { setTimeout, clearTimeout },
  });
  await worker.start();

  assert.deepEqual(await harness.handler()([{ id: "stale-a", data: baseMessage }]), [{
    id: "stale-a", status: "completed", output: { disposition: "ACK", code: "AUTO_LISTING_AI_MESSAGE_STALE" },
  }]);
  assert.deepEqual(await harness.handler()([{ id: "cancelled-a", data: baseMessage }]), [{
    id: "cancelled-a", status: "completed", output: { disposition: "ACK", code: "AUTO_LISTING_AI_ITEM_CANCELLED" },
  }]);
  assert.equal(orchestrations, 0);
  assert.equal(phaseInputReads, 0);
  await worker.stop();
});

test("a current message requires a plain server-loaded phase input before orchestration", async () => {
  const harness = bossHarness();
  let orchestrations = 0;
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => context(message, { phaseInput: null }),
    orchestrate: async () => { orchestrations += 1; },
    workflow: passthroughWorkflow,
    logger: { log() {} },
    phasePolicies: phasePolicies(),
    timers: { setTimeout, clearTimeout },
  });
  await worker.start();

  assert.deepEqual(await harness.handler()([{ id: "invalid-context", data: baseMessage }]), [{
    id: "invalid-context", status: "completed",
    output: { disposition: "FAIL", code: "AUTO_LISTING_AI_CONTEXT_INVALID" },
  }]);
  assert.equal(orchestrations, 0);
  await worker.stop();
});

test("phase policies independently bound concurrency and retry only stable retryable failures", async () => {
  const harness = bossHarness();
  const active = new Map();
  const maximum = new Map();
  const attempts = new Map();
  const release = new Map();
  const timerDelays = [];
  const policies = phasePolicies({
    PLAN_CONTENT: { concurrency: 1, retryLimit: 1, retryDelayMs: 7 },
    GENERATE_IMAGE_SLOT: { concurrency: 2, retryLimit: 0 },
  });
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => context(message, {
      status: message.phase === "GENERATE_IMAGE_SLOT" ? "GENERATING" : "PLANNING",
      activeContentPlanId: message.phase === "GENERATE_IMAGE_SLOT" ? "plan-a" : null,
    }),
    orchestrate: async ({ message }) => {
      const count = (attempts.get(message.correlationId) || 0) + 1;
      attempts.set(message.correlationId, count);
      if (message.correlationId === "retry-a" && count === 1) {
        return phaseOutcome(message, {
          disposition: "RETRY", outcome: "PHASE_RETRY", retryable: true,
          failureCode: "AUTO_LISTING_AI_GATEWAY_TEMPORARY",
        });
      }
      const next = (active.get(message.phase) || 0) + 1;
      active.set(message.phase, next);
      maximum.set(message.phase, Math.max(maximum.get(message.phase) || 0, next));
      await new Promise((resolve) => release.set(message.correlationId, resolve));
      active.set(message.phase, active.get(message.phase) - 1);
      return phaseOutcome(message);
    },
    workflow: passthroughWorkflow,
    logger: { log() {} },
    phasePolicies: policies,
    timers: {
      setTimeout(callback, delay) {
        timerDelays.push(delay);
        if (delay === 7) { queueMicrotask(callback); return { retryDelay: true }; }
        return setTimeout(callback, delay);
      },
      clearTimeout(handle) { if (!handle?.retryDelay) clearTimeout(handle); },
    },
  });
  await worker.start();
  const imageMessage = (suffix) => ({
    ...baseMessage,
    phase: "GENERATE_IMAGE_SLOT",
    slotKey: `slot-${suffix}`,
    correlationId: `image-${suffix}`,
  });
  const processing = harness.handler()([
    { id: "plan-retry", data: { ...baseMessage, correlationId: "retry-a" } },
    { id: "plan-second", data: { ...baseMessage, correlationId: "plan-b" } },
    { id: "image-one", data: imageMessage("a") },
    { id: "image-two", data: imageMessage("b") },
    { id: "image-three", data: imageMessage("c") },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum.get("PLAN_CONTENT"), 1);
  assert.equal(maximum.get("GENERATE_IMAGE_SLOT"), 2);
  assert.equal(attempts.get("retry-a"), 2);
  assert.equal(timerDelays.includes(7), true);
  for (const key of ["retry-a", "image-a", "image-b"]) release.get(key)?.();
  await new Promise((resolve) => setImmediate(resolve));
  for (const key of ["plan-b", "image-c"]) release.get(key)?.();
  const results = await processing;
  assert.equal(results.every((entry) => entry.status === "completed"), true);
  await worker.stop();
});

test("a slow phase stays in flight and never starts an overlapping retry", async () => {
  const harness = bossHarness();
  const logs = [];
  let orchestrations = 0;
  let finishPhase;
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => context(message),
    orchestrate: async () => {
      orchestrations += 1;
      await new Promise((resolve) => { finishPhase = resolve; });
      return phaseOutcome(baseMessage);
    },
    workflow: passthroughWorkflow,
    logger: { log(record) { logs.push(record); } },
    phasePolicies: phasePolicies({ PLAN_CONTENT: { retryLimit: 2 } }),
    timers: { setTimeout, clearTimeout },
  });
  await worker.start();

  let settled = false;
  const processing = harness.handler()([{ id: "slow-a", data: baseMessage }])
    .then((result) => { settled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(settled, false);
  assert.equal(orchestrations, 1);
  finishPhase();
  assert.deepEqual(await processing, [{
    id: "slow-a", status: "completed",
    output: { disposition: "ACK", code: "PLAN_READY" },
  }]);
  assert.equal(logs.some((entry) => entry.code === "AUTO_LISTING_AI_PHASE_TIMEOUT"), false);
  await worker.stop();
});

test("a slow context reload may finish and then starts orchestration once", async () => {
  const harness = bossHarness();
  let releaseContext;
  let orchestrations = 0;
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => {
      await new Promise((resolve) => { releaseContext = resolve; });
      return context(message);
    },
    orchestrate: async ({ message }) => { orchestrations += 1; return phaseOutcome(message); },
    workflow: passthroughWorkflow,
    logger: { log() {} },
    phasePolicies: phasePolicies({ PLAN_CONTENT: { retryLimit: 2 } }),
    timers: { setTimeout, clearTimeout },
  });
  await worker.start();

  let settled = false;
  const processing = harness.handler()([{ id: "slow-context", data: baseMessage }])
    .then((result) => { settled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(settled, false);
  releaseContext();
  assert.deepEqual(await processing, [{
    id: "slow-context", status: "completed",
    output: { disposition: "ACK", code: "PLAN_READY" },
  }]);
  assert.equal(orchestrations, 1);
  await worker.stop();
});

test("an exhausted RETRY outcome becomes a persisted terminal failure and then ACKs the queue", async () => {
  const harness = bossHarness();
  let attempts = 0;
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => {
      attempts += 1;
      return phaseOutcome(message, {
        disposition: "RETRY", outcome: "FAILED", retryable: true,
        failureCode: "AUTO_LISTING_AI_GATEWAY_TEMPORARY",
      });
    },
    workflow: passthroughWorkflow,
    logger: { log() {} },
    phasePolicies: phasePolicies({ PLAN_CONTENT: { retryLimit: 1 } }),
    timers: {
      setTimeout(callback, delay) {
        if (delay === 1) { queueMicrotask(callback); return Object.freeze({ retry: true }); }
        return setTimeout(callback, delay);
      },
      clearTimeout(handle) { if (!handle?.retry) clearTimeout(handle); },
    },
  });
  await worker.start();

  assert.deepEqual(await harness.handler()([{ id: "retry-exhausted", data: baseMessage }]), [{
    id: "retry-exhausted", status: "completed",
    output: { disposition: "FAIL", code: "AUTO_LISTING_AI_GATEWAY_TEMPORARY" },
  }]);
  assert.equal(attempts, 2);
  await worker.stop();
});

test("a credential-shaped uppercase exception code is never stored or logged", async () => {
  const harness = bossHarness();
  const logs = [];
  const unsafe = new Error("raw failure");
  unsafe.code = "PASSWORD_SUPERSECRET";
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async () => { throw unsafe; },
    orchestrate: async () => { throw new Error("must not orchestrate"); },
    workflow: passthroughWorkflow,
    logger: { log(record) { logs.push(record); } },
    phasePolicies: phasePolicies(),
    timers: { setTimeout, clearTimeout },
  });
  await worker.start();

  assert.deepEqual(await harness.handler()([{ id: "unsafe-code", data: baseMessage }]), [{
    id: "unsafe-code", status: "completed",
    output: { disposition: "FAIL", code: "AUTO_LISTING_AI_PHASE_FAILED" },
  }]);
  assert.doesNotMatch(JSON.stringify(logs), /PASSWORD|SUPERSECRET/u);
  await worker.stop();
});

test("invalid or exhausted work stores and logs only safe codes, and graceful stop waits for in-flight work", async () => {
  const harness = bossHarness();
  const logs = [];
  let finish;
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => {
      if (message.correlationId === "in-flight") await new Promise((resolve) => { finish = resolve; });
      else throw new Error("password=raw-secret https://private.example/path");
      return phaseOutcome(message);
    },
    workflow: passthroughWorkflow,
    logger: { log(record) { logs.push(record); } },
    phasePolicies: phasePolicies(),
    timers: { setTimeout, clearTimeout },
  });
  await worker.start();
  const failed = await harness.handler()([{ id: "unsafe-failure", data: baseMessage }]);
  assert.deepEqual(failed, [{
    id: "unsafe-failure", status: "completed", output: { disposition: "FAIL", code: "AUTO_LISTING_AI_PHASE_FAILED" },
  }]);

  const processing = harness.handler()([{ id: "in-flight", data: { ...baseMessage, correlationId: "in-flight" } }]);
  await new Promise((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  finish();
  await processing;
  await stopping;
  assert.equal(stopped, true);
  assert.doesNotMatch(JSON.stringify(logs), /password|raw-secret|private\.example|https?:\/\//iu);
  assert.deepEqual(harness.calls.filter((entry) => entry[0] === "stop"), [[
    "stop", { graceful: true, timeout: 300_000 },
  ]]);
});

function workMessage(message = baseMessage) {
  return {
    workContractVersion: "CHANNEL_WORK_V1",
    message,
    execution: {
      outboxId: "outbox-a",
      dispatchGeneration: 2,
      channelId: "channel-a",
      connectionId: "connection-a",
      connectionVersion: 3,
      leaseOwner: "relay-a",
      leaseToken: "relay-token-a",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

function dualBossHarness() {
  const calls = [];
  const handlers = new Map();
  const boss = {
    on(event) { calls.push(["on", event]); },
    async start() { calls.push(["start"]); },
    async createQueue(name, options) { calls.push(["createQueue", name, options]); },
    async work(name, options, callback) {
      calls.push(["work", name, options]);
      handlers.set(name, callback);
      return `worker-${name}`;
    },
    async stop(options) { calls.push(["stop", options]); },
  };
  return { boss, calls, handler: (name) => handlers.get(name) };
}

test("v3 adopts before business work while the same boss continues serving the v2 drain", async () => {
  const harness = dualBossHarness();
  const events = [];
  const executionRepository = Object.freeze({
    async adopt(input) { events.push(["adopt", input]); return null; },
    async renew(input) { events.push(["renew", input]); },
    async requeueChannelFailure(input) { events.push(["requeue", input]); },
  });
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    executionRepository,
    loadContext: async () => { events.push(["load"]); throw new Error("must not load"); },
    orchestrate: async () => { events.push(["model"]); throw new Error("must not call"); },
    workflow: Object.freeze({ async applyOutcome(input) { events.push(["apply", input]); } }),
    logger: { log() {} },
  });
  await worker.start();

  assert.deepEqual(harness.calls.filter(([name]) => name === "createQueue"), [
    ["createQueue", AUTO_LISTING_AI_QUEUE, AUTO_LISTING_AI_QUEUE_OPTIONS],
    ["createQueue", AUTO_LISTING_AI_WORK_QUEUE, AUTO_LISTING_AI_WORK_QUEUE_OPTIONS],
  ]);
  assert.equal(typeof harness.handler(AUTO_LISTING_AI_QUEUE), "function");
  assert.equal(typeof harness.handler(AUTO_LISTING_AI_WORK_QUEUE), "function");
  const wrongQueue = await harness.handler(AUTO_LISTING_AI_QUEUE)([{ id: "wrong-queue", data: workMessage() }]);
  assert.equal(wrongQueue[0].output.code, "AUTO_LISTING_AI_MESSAGE_INVALID");
  assert.deepEqual(events, []);
  const result = await harness.handler(AUTO_LISTING_AI_WORK_QUEUE)([{ id: "v3-a", data: workMessage() }]);
  assert.equal(result[0].output.code, "AUTO_LISTING_AI_MESSAGE_STALE");
  assert.deepEqual(events.map(([name]) => name), ["adopt"]);
  await worker.stop();
});

test("v3 business retry keeps one adopted execution and never cools or switches its fixed channel", async () => {
  const harness = dualBossHarness();
  const adoptedExecution = Object.freeze({
    ...workMessage().execution,
    leaseOwner: "worker-a",
    leaseToken: "worker-token-a",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  let adopts = 0;
  let attempts = 0;
  const applied = [];
  const executionRepository = Object.freeze({
    async adopt() { adopts += 1; return adoptedExecution; },
    async renew() { return adoptedExecution; },
    async requeueChannelFailure() { throw new Error("business retry must not switch channel"); },
  });
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    executionRepository,
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => {
      attempts += 1;
      return attempts === 1 ? phaseOutcome(message, {
        disposition: "RETRY", outcome: "FAILED", retryable: true,
        failureCode: "AUTO_LISTING_CONTENT_PLAN_GATEWAY_FAILED", failureScope: "BUSINESS",
      }) : phaseOutcome(message);
    },
    workflow: Object.freeze({ async applyOutcome(input) { applied.push(input); } }),
    logger: { log() {} },
    phasePolicies: phasePolicies({ PLAN_CONTENT: { retryLimit: 1 } }),
    timers: {
      setTimeout(callback, delay) {
        if (delay === 1) { queueMicrotask(callback); return { retry: true }; }
        return setTimeout(callback, delay);
      },
      clearTimeout(handle) { if (!handle?.retry) clearTimeout(handle); },
    },
  });
  await worker.start();
  const result = await harness.handler(AUTO_LISTING_AI_WORK_QUEUE)([{ id: "v3-business", data: workMessage() }]);
  assert.equal(result[0].status, "completed");
  assert.equal(adopts, 1);
  assert.equal(attempts, 2);
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].execution, adoptedExecution);
  await worker.stop();
});

test("v3 channel failure is requeued once without inline retry or item failure persistence", async () => {
  const harness = dualBossHarness();
  const events = [];
  const adoptedExecution = Object.freeze({
    ...workMessage().execution,
    leaseOwner: "worker-a",
    leaseToken: "worker-token-a",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const executionRepository = Object.freeze({
    async adopt() { events.push("adopt"); return adoptedExecution; },
    async renew() { events.push("renew"); return adoptedExecution; },
    async requeueChannelFailure(input) { events.push(["requeue", input]); return { disposition: "REQUEUED" }; },
  });
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    executionRepository,
    loadContext: async (message) => { events.push("load"); return context(message); },
    orchestrate: async ({ message }) => {
      events.push("model");
      return phaseOutcome(message, {
        disposition: "RETRY", outcome: "FAILED", retryable: true,
        failureCode: "AI_GATEWAY_RATE_LIMITED",
        failureScope: "CHANNEL_TRANSIENT", deliveryState: "NOT_SENT", retryAfterMs: 5_000,
      });
    },
    workflow: Object.freeze({ async applyOutcome() { events.push("apply"); } }),
    logger: { log() {} },
    phasePolicies: phasePolicies({ PLAN_CONTENT: { retryLimit: 2 } }),
  });
  await worker.start();
  const result = await harness.handler(AUTO_LISTING_AI_WORK_QUEUE)([{ id: "v3-rate", data: workMessage() }]);

  assert.equal(result[0].status, "completed");
  assert.deepEqual(events.map((entry) => Array.isArray(entry) ? entry[0] : entry), ["adopt", "load", "model", "requeue"]);
  const persisted = events.find((entry) => Array.isArray(entry) && entry[0] === "requeue")[1];
  assert.deepEqual(persisted.execution, adoptedExecution);
  assert.equal(persisted.outcome.deliveryState, "NOT_SENT");
  await worker.stop();
});

test("v3 renews within one third of its lease, stops heartbeat, and never saves after lease loss", async () => {
  const harness = dualBossHarness();
  const timers = manualTimers();
  const events = [];
  let finishModel;
  const adoptedExecution = Object.freeze({
    ...workMessage().execution,
    leaseOwner: "worker-a",
    leaseToken: "worker-token-a",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const executionRepository = Object.freeze({
    async adopt(input) { events.push(["adopt", input]); return adoptedExecution; },
    async renew(input) {
      events.push(["renew", input]);
      throw Object.assign(new Error("lost"), { code: "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED" });
    },
    async requeueChannelFailure(input) { events.push(["requeue", input]); },
  });
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    executionRepository,
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => new Promise((resolve) => {
      finishModel = () => resolve(phaseOutcome(message, {
        failureScope: null, deliveryState: null, retryAfterMs: null,
      }));
    }),
    workflow: Object.freeze({ async applyOutcome(input) { events.push(["apply", input]); } }),
    logger: { log() {} },
    timers,
  });
  await worker.start();
  const processing = harness.handler(AUTO_LISTING_AI_WORK_QUEUE)([{ id: "v3-lost", data: workMessage() }]);
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await timers.advanceBy(10_000);
  assert.equal(events.filter(([name]) => name === "renew").length, 1);
  assert.equal(events.find(([name]) => name === "renew")[1].leaseMs, 30_000);
  finishModel();
  const result = await processing;
  assert.equal(result[0].output.code, "AUTO_LISTING_AI_MESSAGE_STALE");
  assert.equal(events.some(([name]) => name === "apply" || name === "requeue"), false);
  await timers.advanceBy(60_000);
  assert.equal(events.filter(([name]) => name === "renew").length, 1, "heartbeat must be stopped");
  await worker.stop();
});

test("v3 persists with the latest execution returned by repeated lease renewals", async () => {
  const harness = dualBossHarness();
  const timers = manualTimers();
  let finishModel;
  const adoptedExecution = Object.freeze({
    ...workMessage().execution,
    leaseOwner: "worker-a",
    leaseToken: "worker-token-a",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const renewedExecutions = [120_000, 180_000].map((offset) => Object.freeze({
    ...adoptedExecution,
    leaseExpiresAt: new Date(Date.now() + offset).toISOString(),
  }));
  let renewals = 0;
  const applied = [];
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    executionRepository: Object.freeze({
      async adopt() { return adoptedExecution; },
      async renew() { return renewedExecutions[renewals++]; },
      async requeueChannelFailure() { throw new Error("must not requeue"); },
    }),
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => new Promise((resolve) => {
      finishModel = () => resolve(phaseOutcome(message));
    }),
    workflow: Object.freeze({ async applyOutcome(input) { applied.push(input); } }),
    logger: { log() {} },
    timers,
  });
  await worker.start();
  const processing = harness.handler(AUTO_LISTING_AI_WORK_QUEUE)([{ id: "v3-renewed", data: workMessage() }]);
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await timers.advanceBy(20_000);
  finishModel();
  const result = await processing;

  assert.equal(result[0].status, "completed");
  assert.equal(renewals, 2);
  assert.deepEqual(applied[0].execution, renewedExecutions[1]);
  await worker.stop();
});

test("v3 treats an invalid renewal result as lease loss and never persists", async () => {
  const harness = dualBossHarness();
  const timers = manualTimers();
  let finishModel;
  let writes = 0;
  const adoptedExecution = Object.freeze({
    ...workMessage().execution,
    leaseOwner: "worker-a",
    leaseToken: "worker-token-a",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    executionRepository: Object.freeze({
      async adopt() { return adoptedExecution; },
      async renew() { return null; },
      async requeueChannelFailure() { writes += 1; },
    }),
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => new Promise((resolve) => {
      finishModel = () => resolve(phaseOutcome(message));
    }),
    workflow: Object.freeze({ async applyOutcome() { writes += 1; } }),
    logger: { log() {} },
    timers,
  });
  await worker.start();
  const processing = harness.handler(AUTO_LISTING_AI_WORK_QUEUE)([{ id: "v3-invalid-renew", data: workMessage() }]);
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await timers.advanceBy(10_000);
  finishModel();
  const result = await processing;

  assert.equal(result[0].output.code, "AUTO_LISTING_AI_MESSAGE_STALE");
  assert.equal(writes, 0);
  await worker.stop();
});

test("v3 lease loss during retry delay prevents a second paid attempt and persistence", async () => {
  const harness = dualBossHarness();
  const timers = manualTimers();
  let attempts = 0;
  let writes = 0;
  const adoptedExecution = Object.freeze({
    ...workMessage().execution,
    leaseOwner: "worker-a",
    leaseToken: "worker-token-a",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    executionRepository: Object.freeze({
      async adopt() { return adoptedExecution; },
      async renew() { throw Object.assign(new Error("lost"), { code: "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED" }); },
      async requeueChannelFailure() { writes += 1; },
    }),
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => {
      attempts += 1;
      return phaseOutcome(message, {
        disposition: "RETRY", outcome: "FAILED", retryable: true,
        failureCode: "AUTO_LISTING_CONTENT_PLAN_GATEWAY_FAILED", failureScope: "BUSINESS",
      });
    },
    workflow: Object.freeze({ async applyOutcome() { writes += 1; } }),
    logger: { log() {} },
    phasePolicies: phasePolicies({ PLAN_CONTENT: { retryLimit: 1, retryDelayMs: 20_000 } }),
    timers,
  });
  await worker.start();
  const processing = harness.handler(AUTO_LISTING_AI_WORK_QUEUE)([{ id: "v3-lost-before-retry", data: workMessage() }]);
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await timers.advanceBy(10_000);
  await timers.advanceBy(10_000);
  const result = await processing;

  assert.equal(result[0].output.code, "AUTO_LISTING_AI_MESSAGE_STALE");
  assert.equal(attempts, 1);
  assert.equal(writes, 0);
  await worker.stop();
});

test("v3 heartbeat keeps planned start times despite consecutive slow renewals", async () => {
  const harness = dualBossHarness();
  const timers = manualTimers();
  let finishModel;
  const starts = [];
  const adoptedExecution = Object.freeze({
    ...workMessage().execution,
    leaseOwner: "worker-a",
    leaseToken: "worker-token-a",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    executionRepository: Object.freeze({
      async adopt() { return adoptedExecution; },
      async renew() {
        starts.push(timers.now());
        return new Promise((resolve) => timers.setTimeout(() => resolve(Object.freeze({
          ...adoptedExecution,
          leaseExpiresAt: new Date(Date.now() + 180_000 + starts.length).toISOString(),
        })), 4_000));
      },
      async requeueChannelFailure() { throw new Error("must not requeue"); },
    }),
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => new Promise((resolve) => {
      finishModel = () => resolve(phaseOutcome(message));
    }),
    workflow: Object.freeze({ async applyOutcome() {} }),
    logger: { log() {} },
    timers,
  });
  await worker.start();
  const processing = harness.handler(AUTO_LISTING_AI_WORK_QUEUE)([{ id: "v3-slow-renew", data: workMessage() }]);
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await timers.advanceBy(28_000);
  finishModel();
  await processing;

  assert.deepEqual(starts, [10_000, 20_000]);
  await worker.stop();
});

test("v3 marks a renewal lost at the next heartbeat deadline without overlapping a 12-second renew", async () => {
  const harness = dualBossHarness();
  const timers = manualTimers();
  let finishModel;
  let writes = 0;
  const starts = [];
  const adoptedExecution = Object.freeze({
    ...workMessage().execution,
    leaseOwner: "worker-a",
    leaseToken: "worker-token-a",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => harness.boss,
    executionRepository: Object.freeze({
      async adopt() { return adoptedExecution; },
      async renew() {
        starts.push(timers.now());
        return new Promise((resolve) => timers.setTimeout(() => resolve(Object.freeze({
          ...adoptedExecution,
          leaseExpiresAt: new Date(Date.now() + 180_000).toISOString(),
        })), 12_000));
      },
      async requeueChannelFailure() { writes += 1; },
    }),
    loadContext: async (message) => context(message),
    orchestrate: async ({ message }) => new Promise((resolve) => {
      finishModel = () => resolve(phaseOutcome(message));
    }),
    workflow: Object.freeze({ async applyOutcome() { writes += 1; } }),
    logger: { log() {} },
    timers,
  });
  await worker.start();
  const processing = harness.handler(AUTO_LISTING_AI_WORK_QUEUE)([{ id: "v3-renew-deadline", data: workMessage() }]);
  let settled = false;
  processing.finally(() => { settled = true; });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await timers.advanceBy(20_000);
  finishModel();
  await new Promise((resolve) => setImmediate(resolve));
  const settledAtDeadline = settled;
  await timers.advanceBy(2_000);
  const result = await processing;

  assert.equal(settledAtDeadline, true, "stop must not wait for an overdue renewal promise");
  assert.equal(result[0].output.code, "AUTO_LISTING_AI_MESSAGE_STALE");
  assert.deepEqual(starts, [10_000], "an overdue renew must not overlap with another database renew");
  assert.equal(writes, 0);
  await worker.stop();
});
