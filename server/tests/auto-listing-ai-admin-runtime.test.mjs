import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingAiAdminRuntime } from "../auto-listing-ai-admin-runtime.mjs";

function enabledEnv(overrides = {}) {
  return {
    NODE_ENV: "development",
    AUTO_LISTING_ENABLED: "true",
    AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "SUB2API_PRIMARY_KEY",
    AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "https://gateway.example/v1",
    AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS: "https://images.example",
    SUB2API_PRIMARY_KEY: "test-only-secret",
    ...overrides,
  };
}

function harness({ env = enabledEnv(), poolFailure = null } = {}) {
  const calls = [];
  const pool = Object.freeze({ async query() {}, async connect() {} });
  const repository = Object.freeze({ marker: "repository" });
  const gateway = Object.freeze({ marker: "gateway", async testCapabilities() {} });
  const capabilityService = Object.freeze({ marker: "capability", async testGatewayCapabilities() {} });
  const adminService = Object.freeze({ marker: "admin-service" });
  const runtime = createAutoListingAiAdminRuntime({
    env,
    async getPostgresPool() {
      calls.push(["pool"]);
      if (poolFailure) throw poolFailure;
      return pool;
    },
    createRepository(input) {
      calls.push(["repository", input]);
      return repository;
    },
    createGateway(input) {
      calls.push(["gateway", {
        allowLocalGateway: input.allowLocalGateway,
        allowedSecretEnvNames: input.allowedSecretEnvNames,
        allowedGatewayBaseUrls: input.allowedGatewayBaseUrls,
        allowedGatewayOrigins: input.allowedGatewayOrigins,
        visibleSecret: input.readSecret("SUB2API_PRIMARY_KEY"),
        hiddenSecret: input.readSecret("POSTGRES_PASSWORD"),
      }]);
      return gateway;
    },
    createCapabilityService(input) {
      calls.push(["capability", input]);
      return capabilityService;
    },
    createAdminService(input) {
      calls.push(["admin", input]);
      return adminService;
    },
    resolveGatewayHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  });
  return { runtime, calls, pool, repository, gateway, capabilityService, adminService };
}

test("admin runtime stays dormant while auto-listing is disabled", async () => {
  const { runtime, calls } = harness({ env: enabledEnv({ AUTO_LISTING_ENABLED: "false" }) });
  await assert.rejects(runtime.getService(), (error) => error?.code === "AUTO_LISTING_AI_ADMIN_DISABLED"
    && error?.status === 404 && !/secret|password/iu.test(error.message));
  assert.deepEqual(calls, []);
});

test("admin runtime lazily composes one account-scoped service with closed gateway policy", async () => {
  const { runtime, calls, pool, repository, gateway, capabilityService, adminService } = harness();
  assert.deepEqual(calls, []);
  assert.equal(await runtime.getService(), adminService);
  assert.equal(await runtime.getService(), adminService);
  assert.equal(calls.filter(([name]) => name === "pool").length, 1);
  assert.deepEqual(calls.find(([name]) => name === "repository"), ["repository", { pool }]);
  assert.deepEqual(calls.find(([name]) => name === "gateway"), ["gateway", {
    allowLocalGateway: false,
    allowedSecretEnvNames: ["SUB2API_PRIMARY_KEY"],
    allowedGatewayBaseUrls: ["https://gateway.example/v1"],
    allowedGatewayOrigins: ["https://images.example"],
    visibleSecret: "test-only-secret",
    hiddenSecret: undefined,
  }]);
  assert.deepEqual(calls.find(([name]) => name === "capability"), ["capability", { repository, gateway }]);
  const adminCall = calls.find(([name]) => name === "admin");
  assert.equal(typeof adminCall[1].resolveGatewayHostname, "function");
  assert.deepEqual(adminCall, ["admin", {
    repository,
    capabilityService,
    allowLocalGateway: false,
    resolveGatewayHostname: adminCall[1].resolveGatewayHostname,
    allowedSecretEnvNames: ["SUB2API_PRIMARY_KEY"],
    allowedGatewayBaseUrls: ["https://gateway.example/v1"],
    allowedGatewayOrigins: ["https://images.example"],
  }]);
});

test("admin runtime rejects incomplete or open gateway policy before database access", async () => {
  for (const env of [
    enabledEnv({ AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "" }),
    enabledEnv({ AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "", AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS: "" }),
    enabledEnv({ AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "SUB2API_PRIMARY_KEY,SUB2API_PRIMARY_KEY" }),
    enabledEnv({ AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY: "sometimes" }),
    enabledEnv({ NODE_ENV: "production", AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY: "true" }),
  ]) {
    const { runtime, calls } = harness({ env });
    await assert.rejects(runtime.getService(), (error) => error?.code === "AUTO_LISTING_AI_ADMIN_CONFIGURATION_INVALID"
      && !/secret|password|gateway\.example/iu.test(error.message));
    assert.deepEqual(calls, []);
  }
});

test("local gateway is opt-in and development-only", async () => {
  const { runtime, calls } = harness({ env: enabledEnv({
    AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY: "true",
    AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "http://127.0.0.1:8080/v1",
    AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS: "",
  }) });
  await runtime.getService();
  assert.equal(calls.find(([name]) => name === "gateway")[1].allowLocalGateway, true);
  assert.equal(calls.find(([name]) => name === "admin")[1].allowLocalGateway, true);
});

test("initialization failures are redacted and a later request can retry", async () => {
  let attempts = 0;
  const { runtime, calls } = harness({
    poolFailure: Object.assign(new Error("password=prod-secret host=internal"), { code: "ECONNREFUSED" }),
  });
  await assert.rejects(runtime.getService(), (error) => {
    attempts += 1;
    return error?.code === "AUTO_LISTING_AI_ADMIN_INITIALIZATION_FAILED"
      && error?.status === 503 && error?.retryable === true
      && !/password|prod-secret|internal/iu.test(error.message);
  });
  await assert.rejects(runtime.getService(), (error) => {
    attempts += 1;
    return error?.code === "AUTO_LISTING_AI_ADMIN_INITIALIZATION_FAILED";
  });
  assert.equal(attempts, 2);
  assert.equal(calls.filter(([name]) => name === "pool").length, 2);
});
