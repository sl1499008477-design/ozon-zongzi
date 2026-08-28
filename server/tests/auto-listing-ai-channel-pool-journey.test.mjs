import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_LISTING_AI_PHASE_POLICIES,
  createAutoListingAiWorker,
} from "../auto-listing-ai-worker.mjs";
import {
  AUTO_LISTING_AI_QUEUE,
  AUTO_LISTING_AI_WORK_QUEUE,
} from "../auto-listing-ai-queue.mjs";
import { createSub2ApiAdapter } from "../sub2api-ai-adapter.mjs";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const profile = Object.freeze({
  id: "profile-journey",
  accountId: "account-journey",
  configVersion: 1,
  baseUrl: "https://gateway.example.test/v1",
  apiKeyEnvName: "SUB2API_JOURNEY_KEY",
  textProtocol: "SUB2API_RESPONSES",
  imageProtocol: "SUB2API_RESPONSES_IMAGE_TOOL",
  textModel: "text-model",
  imageModel: "image-model",
  enabled: true,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(assertion, attempts = 40) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try { return assertion(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw lastError;
}

function itemConcurrencyTracker() {
  const active = new Map();
  const maximum = new Map();
  return Object.freeze({
    start(itemId) {
      const next = (active.get(itemId) || 0) + 1;
      active.set(itemId, next);
      maximum.set(itemId, Math.max(maximum.get(itemId) || 0, next));
      return next;
    },
    end(itemId) { active.set(itemId, (active.get(itemId) || 1) - 1); },
    maximum(itemId) { return maximum.get(itemId) || 0; },
  });
}

function controlledChannel(displayName, itemTracker = null) {
  let active = 0;
  let maximum = 0;
  const calls = [];
  const pending = [];
  return Object.freeze({
    displayName,
    calls,
    maximum: () => maximum,
    async invoke({ itemId, phase, requestId, outcome = "SUCCESS" }) {
      active += 1;
      const itemActive = itemTracker?.start(itemId) || 1;
      maximum = Math.max(maximum, active);
      calls.push(Object.freeze({ type: "START", itemId, phase, requestId, active, itemActive }));
      const gate = deferred();
      pending.push(gate);
      await gate.promise;
      active -= 1;
      itemTracker?.end(itemId);
      calls.push(Object.freeze({ type: "END", itemId, phase, requestId, active, itemActive: itemActive - 1 }));
      return outcome;
    },
    releaseNext() {
      assert.ok(pending.length > 0, `${displayName} has no pending request`);
      pending.shift().resolve();
    },
  });
}

function bossHarness() {
  const handlers = new Map();
  return Object.freeze({
    boss: Object.freeze({
      on() {},
      async start() {},
      async createQueue() {},
      async work(name, _options, handler) { handlers.set(name, handler); return `worker-${name}`; },
      async stop() {},
    }),
    handler(name) { return handlers.get(name); },
  });
}

function message({ itemId, phase = "PLAN_CONTENT", target = null, version = 3 }) {
  return Object.freeze({
    contractVersion: "V1",
    accountId: "account-journey",
    itemId,
    phase,
    expectedStatusVersion: version,
    correlationId: `correlation-${itemId}-${phase}-${target || "root"}`,
    ...(phase === "GENERATE_IMAGE_SLOT" ? { slotKey: target } : {}),
  });
}

function workMessage(currentMessage, {
  channelId,
  connectionId,
  outboxId = `outbox-${currentMessage.itemId}-${currentMessage.phase}-${currentMessage.slotKey || "root"}`,
  generation = 1,
} = {}) {
  return Object.freeze({
    workContractVersion: "CHANNEL_WORK_V1",
    message: currentMessage,
    execution: Object.freeze({
      outboxId,
      dispatchGeneration: generation,
      channelId,
      connectionId,
      connectionVersion: 1,
      leaseOwner: `relay-${channelId}`,
      leaseToken: `relay-token-${channelId}-${generation}`,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
}

function adopted(execution) {
  return Object.freeze({
    ...execution,
    leaseOwner: `worker-${execution.channelId}`,
    leaseToken: `worker-token-${execution.channelId}-${execution.dispatchGeneration}`,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

function phaseStatus(phase) {
  return phase === "PLAN_CONTENT" ? "PLANNING" : "GENERATING";
}

function ack(currentMessage) {
  const outcomes = {
    PLAN_CONTENT: "PLAN_READY",
    GENERATE_IMAGE_SLOT: "IMAGE_SLOT_ACCEPTED",
    GENERATE_RICH_CONTENT: "CONTENT_READY_FOR_REVIEW",
  };
  return Object.freeze({
    contractVersion: "V1",
    disposition: "ACK",
    phase: currentMessage.phase,
    outcome: outcomes[currentMessage.phase],
    retryable: false,
    failureCode: null,
    correlationId: currentMessage.correlationId,
    failureScope: null,
    deliveryState: null,
    retryAfterMs: null,
  });
}

function channelFailure(currentMessage, deliveryState = "NOT_SENT") {
  return Object.freeze({
    contractVersion: "V1",
    disposition: "RETRY",
    phase: currentMessage.phase,
    outcome: "FAILED",
    retryable: true,
    failureCode: deliveryState === "NOT_SENT" ? "AI_GATEWAY_NETWORK_FAILED" : "INVALID_GATEWAY_RESPONSE",
    correlationId: currentMessage.correlationId,
    failureScope: "CHANNEL_TRANSIENT",
    deliveryState,
    retryAfterMs: null,
  });
}

function createJourneyWorker({ channels, acceptedSlots = new Set() }) {
  const boss = bossHarness();
  const requeues = [];
  const applied = [];
  const worker = createAutoListingAiWorker({
    enabled: true,
    bossFactory: () => boss.boss,
    executionRepository: Object.freeze({
      async adopt({ execution }) { return adopted(execution); },
      async renew({ execution }) { return execution; },
      async requeueChannelFailure(input) { requeues.push(input); return { disposition: "REQUEUED" }; },
    }),
    loadContext: async ({ message: currentMessage, execution }) => Object.freeze({
      accountId: currentMessage.accountId,
      jobId: "job-journey",
      itemId: currentMessage.itemId,
      status: phaseStatus(currentMessage.phase),
      statusVersion: currentMessage.expectedStatusVersion,
      activeContentPlanId: null,
      phaseInput: Object.freeze({ execution }),
    }),
    orchestrate: async ({ message: currentMessage, context }) => {
      const execution = context.phaseInput.execution;
      if (execution === null) return ack(currentMessage);
      const channel = channels.get(execution.connectionId);
      assert.ok(channel, `missing independent handler for ${execution.connectionId}`);
      if (currentMessage.phase === "GENERATE_IMAGE_SLOT" && acceptedSlots.has(currentMessage.slotKey)) {
        return ack(currentMessage);
      }
      const requestId = `${execution.connectionId}:${currentMessage.correlationId}`;
      const result = await channel.invoke({
        itemId: currentMessage.itemId,
        phase: currentMessage.phase === "GENERATE_IMAGE_SLOT"
          ? `image:${currentMessage.slotKey}:generate` : currentMessage.phase,
        requestId,
        outcome: execution.connectionId === "connection-a" && currentMessage.slotKey === "detail-2"
          ? "DEFINITE_CONNECTION_FAILURE" : "SUCCESS",
      });
      if (result === "DEFINITE_CONNECTION_FAILURE") return channelFailure(currentMessage, "NOT_SENT");
      if (currentMessage.phase === "GENERATE_IMAGE_SLOT") {
        await channel.invoke({
          itemId: currentMessage.itemId,
          phase: `image:${currentMessage.slotKey}:checker`,
          requestId: `${requestId}:checker`,
        });
        acceptedSlots.add(currentMessage.slotKey);
      }
      return ack(currentMessage);
    },
    workflow: Object.freeze({ async applyOutcome(input) { applied.push(input); } }),
    logger: { log() {} },
    phasePolicies: Object.freeze(Object.fromEntries(Object.entries(AUTO_LISTING_AI_PHASE_POLICIES).map(([phase, policy]) => [
      phase, Object.freeze({ ...policy, retryLimit: 0, retryDelayMs: 1 }),
    ]))),
  });
  return Object.freeze({ boss, worker, requeues, applied });
}

test("cases 2/3/4: independent fake gateways overlap products, serialize each product, switch channels, and reuse accepted images", async () => {
  const itemTracker = itemConcurrencyTracker();
  const channelA = controlledChannel("测试通道 A", itemTracker);
  const channelB = controlledChannel("测试通道 B", itemTracker);
  const channels = new Map([["connection-a", channelA], ["connection-b", channelB]]);
  const acceptedSlots = new Set();
  const journey = createJourneyWorker({ channels, acceptedSlots });
  await journey.worker.start();

  const first = message({ itemId: "item-a" });
  const second = message({ itemId: "item-b" });
  const concurrent = journey.boss.handler(AUTO_LISTING_AI_WORK_QUEUE)([
    { id: "job-a-plan", data: workMessage(first, { channelId: "channel-a", connectionId: "connection-a" }) },
    { id: "job-b-plan", data: workMessage(second, { channelId: "channel-b", connectionId: "connection-b" }) },
  ]);
  await eventually(() => {
    assert.equal(channelA.calls.filter((entry) => entry.type === "START").length, 1);
    assert.equal(channelB.calls.filter((entry) => entry.type === "START").length, 1);
  });
  channelA.releaseNext();
  channelB.releaseNext();
  assert.equal((await concurrent).every((entry) => entry.status === "completed"), true);

  for (const [slotKey, connectionId, channelId, paidStages] of [
    ["main-1", "connection-a", "channel-a", 2],
    ["detail-2", "connection-a", "channel-a", 1],
    ["detail-2", "connection-b", "channel-b", 2],
  ]) {
    const current = message({ itemId: "item-a", phase: "GENERATE_IMAGE_SLOT", target: slotKey, version: 4 });
    const channel = channels.get(connectionId);
    const startsBefore = channel.calls.filter((entry) => entry.type === "START").length;
    const processing = journey.boss.handler(AUTO_LISTING_AI_WORK_QUEUE)([{
      id: `job-${slotKey}-${connectionId}`,
      data: workMessage(current, { channelId, connectionId, generation: connectionId === "connection-b" ? 2 : 1 }),
    }]);
    for (let stage = 1; stage <= paidStages; stage += 1) {
      await eventually(() => assert.equal(
        channel.calls.filter((entry) => entry.type === "START").length,
        startsBefore + stage,
      ));
      channel.releaseNext();
    }
    await processing;
  }

  const acceptedMainReplay = message({
    itemId: "item-a",
    phase: "GENERATE_IMAGE_SLOT",
    target: "main-1",
    version: 4,
  });
  const channelBStartsBeforeReplay = channelB.calls.filter((entry) => entry.type === "START").length;
  await journey.boss.handler(AUTO_LISTING_AI_WORK_QUEUE)([{
    id: "job-main-1-connection-b-replay",
    data: workMessage(acceptedMainReplay, {
      channelId: "channel-b",
      connectionId: "connection-b",
      generation: 3,
    }),
  }]);
  assert.equal(channelB.calls.filter((entry) => entry.type === "START").length, channelBStartsBeforeReplay,
    "a channel switch must acknowledge an accepted image without another paid request");

  const rich = message({ itemId: "item-a", phase: "GENERATE_RICH_CONTENT", version: 4 });
  const richProcessing = journey.boss.handler(AUTO_LISTING_AI_WORK_QUEUE)([{
    id: "job-rich-b",
    data: workMessage(rich, { channelId: "channel-b", connectionId: "connection-b", generation: 4 }),
  }]);
  await eventually(() => assert.equal(channelB.calls.at(-1)?.type, "START"));
  channelB.releaseNext();
  await richProcessing;

  assert.equal(channelA.maximum(), 1);
  assert.equal(channelB.maximum(), 1);
  assert.equal(itemTracker.maximum("item-a"), 1,
    "plan, rich content, image generation, and image checking stay serial for one product across channels");
  assert.equal(journey.requeues.length, 1);
  assert.equal(journey.requeues[0].outcome.deliveryState, "NOT_SENT");
  assert.deepEqual([...acceptedSlots].sort(), ["detail-2", "main-1"]);
  assert.equal(channelB.calls.some((entry) => entry.phase.startsWith("image:main-1:")), false,
    "a channel switch must not regenerate an accepted image");
  assert.deepEqual(channelA.calls.filter((entry) => entry.type === "START").map((entry) => entry.requestId), [
    `connection-a:${first.correlationId}`,
    `connection-a:${message({ itemId: "item-a", phase: "GENERATE_IMAGE_SLOT", target: "main-1", version: 4 }).correlationId}`,
    `connection-a:${message({ itemId: "item-a", phase: "GENERATE_IMAGE_SLOT", target: "main-1", version: 4 }).correlationId}:checker`,
    `connection-a:${message({ itemId: "item-a", phase: "GENERATE_IMAGE_SLOT", target: "detail-2", version: 4 }).correlationId}`,
  ]);
  await journey.worker.stop();
});

function manualTimers() {
  let now = 0;
  let nextId = 0;
  const pending = new Map();
  return Object.freeze({
    setTimeout(callback, delay) {
      const handle = Object.freeze({ id: nextId += 1, unref() {} });
      pending.set(handle, { callback, at: now + delay });
      return handle;
    },
    clearTimeout(handle) { pending.delete(handle); },
    advanceBy(duration) {
      const target = now + duration;
      while (true) {
        const due = [...pending.entries()].filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        const [handle, task] = due;
        pending.delete(handle);
        now = task.at;
        task.callback();
      }
      now = target;
    },
    delays() { return [...pending.values()].map((task) => task.at - now).sort((left, right) => left - right); },
    activeCount() { return pending.size; },
  });
}

function controlledResponse() {
  let controller;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(value) { controller = value; },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } });
  return Object.freeze({
    response,
    enqueue(value) { controller.enqueue(new TextEncoder().encode(value)); },
    close() { controller.close(); },
    wasCancelled() { return cancelled; },
  });
}

function imageInput(overrides = {}) {
  return {
    profile,
    model: "image-model",
    correlationId: "correlation-idle-journey",
    requestKey: "request-idle-journey",
    prompt: "controlled fixture",
    size: "1024x1024",
    quality: "medium",
    outputFormat: "png",
    ...overrides,
  };
}

function fakeAdapter(fetchImpl, timers) {
  return createSub2ApiAdapter({
    fetchImpl,
    readSecret: () => "fixture-secret",
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    timers,
    logger: { info() {}, warn() {} },
  });
}

test("case 7: the five-minute idle watchdog aborts noise but legal events permit a longer call", async () => {
  const idleTimers = manualTimers();
  const idleStream = controlledResponse();
  const idlePending = fakeAdapter(async () => idleStream.response, idleTimers).generateImage(imageInput({
    idleTimeoutMs: 300_000,
  }));
  await eventually(() => assert.deepEqual(idleTimers.delays(), [300_000]));
  idleStream.enqueue(": keep-alive\n\ndata: {\"type\":\"response.completed\"");
  idleTimers.advanceBy(300_000);
  await assert.rejects(idlePending, (error) => error?.code === "AI_GATEWAY_IDLE_TIMEOUT"
    && error?.deliveryState === "POSSIBLY_SENT");
  assert.equal(idleStream.wasCancelled(), true);
  assert.equal(idleTimers.activeCount(), 0);

  const progressTimers = manualTimers();
  const progressStream = controlledResponse();
  const progressPending = fakeAdapter(async () => progressStream.response, progressTimers).generateImage(imageInput({
    idleTimeoutMs: 300_000,
    correlationId: "correlation-progress-journey",
    requestKey: "request-progress-journey",
  }));
  await eventually(() => assert.deepEqual(progressTimers.delays(), [300_000]));
  progressTimers.advanceBy(299_999);
  progressStream.enqueue([
    "event: response.image_generation_call.partial_image",
    `data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${PNG_1X1}","partial_image_index":0}`,
    "",
    "",
  ].join("\n"));
  await eventually(() => assert.deepEqual(progressTimers.delays(), [300_000]));
  progressTimers.advanceBy(299_999);
  progressStream.enqueue([
    "event: response.completed",
    "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}",
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n"));
  progressStream.close();
  assert.deepEqual(Buffer.from((await progressPending).bytes), Buffer.from(PNG_1X1, "base64"));
  assert.equal(progressTimers.activeCount(), 0);
});

test("case 10: one worker drains legacy v2 while connection-version work is accepted only by v3", async () => {
  const channel = controlledChannel("测试通道 A");
  const journey = createJourneyWorker({ channels: new Map([["connection-a", channel]]) });
  await journey.worker.start();
  const legacyMessage = message({ itemId: "legacy-item" });
  const connectedMessage = message({ itemId: "connected-item" });

  const legacy = journey.boss.handler(AUTO_LISTING_AI_QUEUE)([{ id: "legacy-v2", data: legacyMessage }]);
  await eventually(() => assert.equal(channel.calls.length, 0));
  const legacyResult = await legacy;
  assert.equal(legacyResult[0].status, "completed");

  const wrongQueue = await journey.boss.handler(AUTO_LISTING_AI_QUEUE)([{
    id: "connected-on-v2",
    data: workMessage(connectedMessage, { channelId: "channel-a", connectionId: "connection-a" }),
  }]);
  assert.equal(wrongQueue[0].output.code, "AUTO_LISTING_AI_MESSAGE_INVALID");

  const v3 = journey.boss.handler(AUTO_LISTING_AI_WORK_QUEUE)([{
    id: "connected-on-v3",
    data: workMessage(connectedMessage, { channelId: "channel-a", connectionId: "connection-a" }),
  }]);
  await eventually(() => assert.equal(channel.calls.filter((entry) => entry.type === "START").length, 1));
  channel.releaseNext();
  assert.equal((await v3)[0].status, "completed");
  await journey.worker.stop();
});
