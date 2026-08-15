import assert from "node:assert/strict";
import test from "node:test";

import { createCategoryStrategyObservability } from "../auto-listing-category-strategy-observability.mjs";

const scope = Object.freeze({
  taxonomyScope: "OZON:DEFAULT",
  descriptionCategoryId: 170,
  typeId: 99,
});

test("category strategy observability emits only fixed metrics and allowlisted safe log fields", async () => {
  const increments = [];
  const logs = [];
  const observer = createCategoryStrategyObservability({
    accountHashSecret: "test-observability-secret",
    metrics: { increment(name, labels) { increments.push({ name, labels }); } },
    logger: { info(event) { logs.push(event); } },
    now: () => 1_250,
  });

  await observer.observe({
    metric: "category_strategy_analysis_attempt_total",
    accountId: "account-private",
    draftId: "draft-a",
    sessionId: null,
    attemptId: "attempt-a",
    strategyVersionId: null,
    scope,
    correlationId: "correlation-a",
    outcome: "success",
    startedAt: 1_000,
  });

  assert.deepEqual(increments, [{
    name: "category_strategy_analysis_attempt_total",
    labels: { outcome: "success" },
  }]);
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]).sort(), [
    "accountHash", "attemptId", "correlationId", "draftId", "durationMs", "metric", "outcome", "scope",
  ]);
  assert.match(logs[0].accountHash, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(logs[0]).includes("account-private"), false);
  assert.deepEqual(logs[0].scope, scope);
  assert.equal(logs[0].durationMs, 250);
  assert.equal(Object.isFrozen(logs[0]), true);
  assert.equal(Object.isFrozen(logs[0].scope), true);
});

test("category strategy observability rejects hostile or unknown carriers before touching sinks", async () => {
  let increments = 0;
  let logs = 0;
  let getterCalls = 0;
  const observer = createCategoryStrategyObservability({
    accountHashSecret: "test-observability-secret",
    metrics: { increment() { increments += 1; } },
    logger: { info() { logs += 1; } },
    now: () => 1_250,
  });
  const hostile = {};
  Object.defineProperty(hostile, "metric", { enumerable: true, get() { getterCalls += 1; return "category_strategy_required_total"; } });
  for (const input of [
    hostile,
    new Proxy({}, { ownKeys() { getterCalls += 1; return []; } }),
    { metric: "unknown_metric", accountId: "a", draftId: null, sessionId: null, attemptId: null,
      strategyVersionId: null, scope, correlationId: "c", outcome: "blocked", startedAt: 1_000 },
  ]) {
    await assert.rejects(observer.observe(input), { code: "AUTO_LISTING_CATEGORY_STRATEGY_OBSERVABILITY_INVALID" });
  }
  assert.equal(getterCalls, 0);
  assert.equal(increments, 0);
  assert.equal(logs, 0);
});

test("observability sink failures never change the caller outcome", async () => {
  const observer = createCategoryStrategyObservability({
    accountHashSecret: "test-observability-secret",
    metrics: { increment() { throw new Error("secret credential metric failure"); } },
    logger: { info() { throw new Error("signedUrl=https://private.example/x?token=secret"); } },
    now: () => 1_250,
  });
  await assert.doesNotReject(observer.observe({
    metric: "category_strategy_required_total",
    accountId: "account-private",
    draftId: null,
    sessionId: null,
    attemptId: null,
    strategyVersionId: null,
    scope,
    correlationId: "correlation-a",
    outcome: "blocked",
    startedAt: 1_000,
  }));
});
