import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingPlanDiagnosticRuntime } from "../auto-listing-plan-diagnostic-runtime.mjs";

test("runtime composes the read-only repository and service lazily once", async () => {
  const calls = [];
  const pool = { async query() {}, async connect() {} };
  const repository = { async loadLatest() {} };
  const contextRepository = { async reserve() {}, async complete() {} };
  const gateway = { async createTextResponse() {} };
  const evidenceRepository = { async loadOutcome() {}, async recordResponse() {}, async recordValidation() {} };
  const service = { async getLatest() {} };
  let serviceInput;
  const runtime = createAutoListingPlanDiagnosticRuntime({
    env: { AUTO_LISTING_ENABLED: "true", AUTO_LISTING_AI_ENABLED: "true" },
    async getPostgresPool() { calls.push("pool"); return pool; },
    createRepository(input) { calls.push(["repository", input]); return repository; },
    createContextRepository(input) { calls.push(["context", input]); return contextRepository; },
    async createReplayPorts(input) {
      calls.push(["replay-ports", input]);
      return { pool, gateway, evidenceRepository };
    },
    createService(input) { serviceInput = input; calls.push(["service"]); return service; },
  });
  assert.deepEqual(calls, []);
  assert.equal(await runtime.getService(), service);
  assert.equal(await runtime.getService(), service);
  assert.deepEqual(calls, ["pool", ["repository", { pool }], ["service"]]);
  assert.equal(typeof serviceInput.getReplayDependencies, "function");
  assert.deepEqual(await serviceInput.getReplayDependencies(), { contextRepository, gateway, evidenceRepository });
  assert.equal(calls.filter((entry) => Array.isArray(entry) && entry[0] === "replay-ports").length, 1);
  assert.equal(calls.filter((entry) => Array.isArray(entry) && entry[0] === "context").length, 1);
});

test("disabled or malformed runtime fails safely before pool access", async () => {
  let pools = 0;
  const runtime = createAutoListingPlanDiagnosticRuntime({
    env: { AUTO_LISTING_ENABLED: "false", AUTO_LISTING_AI_ENABLED: "true" },
    async getPostgresPool() { pools += 1; return {}; },
  });
  await assert.rejects(runtime.getService(), {
    code: "AUTO_LISTING_PLAN_DIAGNOSTIC_DISABLED", status: 404,
  });
  assert.equal(pools, 0);
});
