import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingUploadPolicyAdminRuntime } from "../auto-listing-upload-policy-admin-runtime.mjs";

const media = Object.freeze({
  origin: "https://media.example.com", baseUrl: "https://media.example.com/listing/",
  prefix: "listing-media/v2", publicationVersion: "LISTING_MEDIA_V2",
});

function runtime(overrides = {}) {
  const calls = [];
  const value = createAutoListingUploadPolicyAdminRuntime({
    env: {
      AUTO_LISTING_ENABLED: "true", AUTO_LISTING_UPLOAD_ENABLED: "true",
      AUTO_LISTING_DIRECT_UPLOAD_ALLOWED: "false", LISTING_PIPELINE_V3: "1",
      ...overrides.env,
    },
    getPostgresPool: async () => ({ query() {}, connect() {} }),
    getPublicationRuntime: async () => ({
      publicationPolicy: media,
      assertDirectReady: async (input) => { calls.push(["ready", input]); return { ready: true, evidenceId: "health-a" }; },
      checkPublicationHealth: async (input) => { calls.push(["health", input]); return { outcome: "PASSED" }; },
    }),
    assertDirectSystemReady: async (input) => { calls.push(["system-ready", input]); return { ready: true }; },
    createRepository: () => ({ findPolicyReplay() {}, listPolicies() {}, publishPolicy() {} }),
    createService: (input) => {
      calls.push(["service", input]);
      return { listPolicies: async () => [] };
    },
    ...overrides.dependencies,
  });
  return { value, calls };
}

test("runtime is lazy, cached and disabled unless auto-listing upload is explicitly enabled", async () => {
  const active = runtime();
  assert.strictEqual(await active.value.getService(), await active.value.getService());
  assert.equal(active.calls.filter(([kind]) => kind === "service").length, 1);

  for (const env of [
    { AUTO_LISTING_ENABLED: "false" },
    { AUTO_LISTING_UPLOAD_ENABLED: "false" },
  ]) {
    const disabled = runtime({ env });
    await assert.rejects(disabled.value.getService(), { code: "AUTO_LISTING_UPLOAD_POLICY_ADMIN_DISABLED" });
  }
});

test("DIRECT readiness wrapper requires rollout, injected system readiness, then media readiness", async () => {
  for (const env of [
    { AUTO_LISTING_DIRECT_UPLOAD_ALLOWED: "false" },
    { LISTING_PIPELINE_V3: "0", AUTO_LISTING_DIRECT_UPLOAD_ALLOWED: "true" },
  ]) {
    let captured;
    const h = runtime({
      env,
      dependencies: {
        createService: (input) => { captured = input; return { listPolicies: async () => [] }; },
      },
    });
    await h.value.getService();
    await assert.rejects(captured.assertDirectReady({ accountId: "account-a" }), {
      code: "AUTO_LISTING_DIRECT_POLICY_NOT_READY",
    });
    assert.equal(h.calls.some(([kind]) => kind === "ready"), false);
    assert.equal(h.calls.some(([kind]) => kind === "system-ready"), false);
  }

  let captured;
  const enabled = runtime({
    env: { AUTO_LISTING_DIRECT_UPLOAD_ALLOWED: "true" },
    dependencies: { createService: (input) => { captured = input; return { listPolicies: async () => [] }; } },
  });
  await enabled.value.getService();
  assert.equal((await captured.assertDirectReady({ accountId: "account-a" })).evidenceId, "health-a");
  assert.deepEqual(enabled.calls.find(([kind]) => kind === "system-ready")[1], { accountId: "account-a" });
  assert.deepEqual(enabled.calls.find(([kind]) => kind === "ready")[1], { accountId: "account-a" });
});

test("DIRECT system readiness is a separate fail-closed injected port", async () => {
  let captured;
  const h = runtime({
    env: { AUTO_LISTING_DIRECT_UPLOAD_ALLOWED: "true" },
    dependencies: {
      assertDirectSystemReady: async () => { throw new Error("queue unavailable"); },
      createService: (input) => { captured = input; return { listPolicies: async () => [] }; },
    },
  });
  await h.value.getService();
  await assert.rejects(captured.assertDirectReady({ accountId: "account-a" }), {
    code: "AUTO_LISTING_DIRECT_POLICY_NOT_READY",
  });
  assert.equal(h.calls.some(([kind]) => kind === "ready"), false);
});

test("runtime exposes the explicit publication health checker without probing during construction", async () => {
  let captured;
  const h = runtime({ dependencies: {
    createService: (input) => { captured = input; return { listPolicies: async () => [] }; },
  } });
  await h.value.getService();
  assert.equal(h.calls.some(([kind]) => kind === "health"), false);
  assert.deepEqual(await captured.checkPublicationHealth({ accountId: "account-a", checkedByAccountId: "account-a" }), {
    outcome: "PASSED",
  });
  assert.equal(h.calls.some(([kind]) => kind === "health"), true);
});

test("failed initialization is not cached and no health probe runs during construction", async () => {
  let attempts = 0;
  const h = runtime({ dependencies: {
    getPostgresPool: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary");
      return { query() {}, connect() {} };
    },
  } });
  await assert.rejects(h.value.getService(), { code: "AUTO_LISTING_UPLOAD_POLICY_ADMIN_INITIALIZATION_FAILED" });
  await h.value.getService();
  assert.equal(attempts, 2);
  assert.equal(h.calls.some(([kind]) => kind === "ready"), false);
});
