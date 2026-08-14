import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingWebRuntime } from "../auto-listing-web-runtime.mjs";
import { createAutoListingCategoryStrategyRuntime } from "../auto-listing-category-strategy-runtime.mjs";

function build({ settingsStartError = null } = {}) {
  const events = [];
  const service = Object.freeze({ marker: "settings-service" });
  const diagnosticService = Object.freeze({ marker: "diagnostic-service" });
  const categoryStrategyService = Object.freeze({ marker: "category-strategy-service" });
  const settingsRuntime = Object.freeze({
    async getService() { return service; },
    async startWorker() { events.push("settings-start"); if (settingsStartError) throw settingsStartError; return true; },
    async stopWorker() { events.push("settings-stop"); },
  });
  const diagnosticRuntime = Object.freeze({ async getService() { return diagnosticService; } });
  const categoryStrategyRuntime = Object.freeze({ async getService() { return categoryStrategyService; } });
  const userRuntime = Object.freeze({
    async getService() { return {}; },
    async startWorkers() { events.push("user-start"); return true; },
    async stopWorkers() { events.push("user-stop"); },
  });
  const operationsRuntime = Object.freeze({
    async start() { events.push("operations-start"); return true; },
    async stop() { events.push("operations-stop"); },
  });
  let settingsHandlerInput;
  let diagnosticHandlerInput;
  let categoryStrategyHandlerInput;
  const runtime = createAutoListingWebRuntime({
    authenticate: async () => ({ id: "account-a", role: "admin" }),
    getAutoListingService: async () => ({}),
    collectSku: async () => ({}),
    async readJson(_req, options) { events.push(["read-json", options]); return {}; },
    sendJson() {},
    env: { AUTO_LISTING_ENABLED: "false", AUTO_LISTING_AI_ENABLED: "false" },
    resolvePool: async () => { throw new Error("pool must stay lazy"); },
    createUserWorkflowRuntime() { return userRuntime; },
    createAiSettingsRuntime(input) { events.push(["settings-runtime", input]); return settingsRuntime; },
    createAiSettingsHandler(input) {
      settingsHandlerInput = input;
      return async (_req, _res, url) => url.pathname.startsWith("/admin/auto-listing/ai-settings");
    },
    createPlanDiagnosticRuntime(input) { events.push(["diagnostic-runtime", input]); return diagnosticRuntime; },
    createPlanDiagnosticHandler(input) {
      diagnosticHandlerInput = input;
      return async (_req, _res, url) => url.pathname.startsWith("/admin/auto-listing/plan-diagnostics/");
    },
    createCategoryStrategyRuntime(input) {
      events.push(["category-strategy-runtime", input]);
      return categoryStrategyRuntime;
    },
    createCategoryStrategyHandler(input) {
      categoryStrategyHandlerInput = input;
      return async (_req, _res, url) => url.pathname.startsWith("/admin/auto-listing/category-strategies");
    },
    createPublicationRuntime() { throw new Error("publication must stay lazy"); },
    createUploadRuntime() { throw new Error("upload must stay lazy"); },
    createReconciliationRuntime() { throw new Error("reconciliation must stay lazy"); },
    createOperationsRuntime() { return operationsRuntime; },
    storage: {},
    probePublicPolicy: async () => true,
    assertDirectSystemReady: async () => true,
  });
  return {
    runtime, events, service, diagnosticService, categoryStrategyService,
    settingsHandler: () => settingsHandlerInput,
    diagnosticHandler: () => diagnosticHandlerInput,
    categoryStrategyHandler: () => categoryStrategyHandlerInput,
  };
}

test("web runtime mounts diagnostics before legacy AI administration without touching PostgreSQL", async () => {
  const h = build();
  assert.equal(await h.runtime.handleAiAdminRoute({}, {}, new URL(
    "https://example.test/admin/auto-listing/plan-diagnostics/items/item-a/latest?jobId=job-a",
  )), true);
  assert.equal(await h.diagnosticHandler().getService(), h.diagnosticService);
  assert.equal(h.events.some((entry) => entry === "pool"), false);
});

test("web runtime mounts the stable AI settings handler without touching PostgreSQL", async () => {
  const h = build();
  assert.equal(await h.runtime.handleAiAdminRoute({}, {}, new URL(
    "https://example.test/admin/auto-listing/ai-settings",
  )), true);
  const input = h.settingsHandler();
  assert.equal(await input.getService(), h.service);
  await input.readJson({});
  assert.deepEqual(h.events.find((entry) => Array.isArray(entry) && entry[0] === "read-json"),
    ["read-json", { maxBytes: 64 * 1024, requireBody: true }]);
  assert.equal(h.events.some((entry) => entry === "settings-start"), false);
});

test("web runtime mounts category strategy administration independently and keeps PostgreSQL lazy", async () => {
  const h = build();
  assert.equal(await h.runtime.handleCategoryStrategyAdminRoute({}, {}, new URL(
    "https://example.test/admin/auto-listing/category-strategies/settings",
  )), true);
  assert.equal(await h.categoryStrategyHandler().getService(), h.categoryStrategyService);
  await h.categoryStrategyHandler().readJson({});
  assert.deepEqual(h.events.find((entry) => Array.isArray(entry) && entry[0] === "read-json"),
    ["read-json", { maxBytes: 256 * 1024, requireBody: true }]);
  assert.equal(h.events.some((entry) => entry === "pool"), false);
});

test("category strategy runtime composes real non-analysis ports and fails exact facts closed until Task 6 wiring", async () => {
  const service = Object.freeze({ marker: "category-service" });
  let captured;
  let poolReads = 0;
  const runtime = createAutoListingCategoryStrategyRuntime({
    env: { AUTO_LISTING_ENABLED: "true",
      APP_ENCRYPTION_KEY: "test-only-category-session-key-at-least-32-characters" },
    async getPostgresPool() { poolReads += 1; return { async query() {}, async connect() {} }; },
    createRepository() { return {}; },
    createStrategyReadModel() { return {}; },
    createSampleStore() { return {}; },
    createObjectStorage() { return {}; },
    createPublicationRepository() { return {}; },
    createAdminService() { return { publishCategoryStrategyDraft() {}, rollbackCategoryStrategyVersion() {} }; },
    createService(input) { captured = input; return service; },
  });
  assert.equal(poolReads, 0);
  assert.equal(await runtime.getService(), service);
  assert.equal(poolReads, 1);
  await assert.rejects(captured.exactProductFacts.verify({}), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_EXACT_FACTS_NOT_READY", status: 409,
  });
  const sessionIdentityInput = { accountId: "account-a", draftId: "draft-a", expectedDraftVersion: 1,
    idempotencyKey: "session-a", correlationId: "correlation-a" };
  const identity = await captured.deriveSessionIdentity(sessionIdentityInput);
  assert.deepEqual(await captured.deriveSessionIdentity(sessionIdentityInput), identity);
  assert.equal(identity.sessionId.startsWith("session-"), true);
  assert.equal(identity.sessionSecret.length, 64);
  assert.notEqual((await captured.deriveSessionIdentity({ ...sessionIdentityInput,
    idempotencyKey: "session-b" })).sessionSecret, identity.sessionSecret);
  assert.equal(typeof captured.extensionSessionChannel.putSession, "function");
  assert.equal(await runtime.getService(), service);
  assert.equal(poolReads, 1);
});

test("settings worker startup failure unwinds settings, operations, and user workers in reverse order", async () => {
  const failure = new Error("settings worker failed");
  const h = build({ settingsStartError: failure });
  await assert.rejects(h.runtime.startWorkers(), (error) => error === failure);
  assert.deepEqual(h.events.filter((entry) => typeof entry === "string"), [
    "user-start", "operations-start", "settings-start",
    "settings-stop", "operations-stop", "user-stop",
  ]);
});
