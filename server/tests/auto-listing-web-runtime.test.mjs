import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createAutoListingWebRuntime } from "../auto-listing-web-runtime.mjs";
import {
  createAutoListingCategoryStrategyRuntime,
  createCategoryStrategyAnalysisConfigurationResolver,
  createCategoryStrategyExtensionChannel,
} from "../auto-listing-category-strategy-runtime.mjs";
import { createSub2ApiAdapter } from "../sub2api-ai-adapter.mjs";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const CATEGORY_ROLES = [
  "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
];

test("analysis configuration resolver is account-scoped and requires exactly one enabled profile", async () => {
  const calls = [];
  const resolver = createCategoryStrategyAnalysisConfigurationResolver({ pool: {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [{ id: "profile-a", config_version: "7", text_model: "vision-a" }] };
    },
  } });
  assert.deepEqual(await resolver.resolve({ accountId: "account-a" }), {
    analyzerVersion: "category-strategy-v1", promptVersion: "category-strategy-prompt-v2",
    profileId: "profile-a", profileVersion: 7, model: "vision-a",
  });
  assert.deepEqual(calls[0].parameters, ["account-a"]);
  assert.match(calls[0].sql, /WHERE account_id=\$1 AND enabled IS TRUE/u);

  for (const rows of [[], [
    { id: "profile-a", config_version: 7, text_model: "a" },
    { id: "profile-b", config_version: 1, text_model: "b" },
  ]]) {
    const closedResolver = createCategoryStrategyAnalysisConfigurationResolver({
      pool: { async query() { return { rows }; } },
    });
    await assert.rejects(closedResolver.resolve({ accountId: "account-a" }), {
      code: rows.length === 0
        ? "AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_PROFILE_NOT_CONFIGURED"
        : "AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_PROFILE_AMBIGUOUS",
      status: 409,
    });
  }
});

test("category strategy production adapter sends the exact account profile and image evidence to the paid gateway", async () => {
  const adapterModule = await import("../auto-listing-category-strategy-ai-adapter.mjs").catch(() => ({}));
  assert.equal(typeof adapterModule.createCategoryStrategyAnalysisAiAdapter, "function");
  const queries = [];
  const gatewayCalls = [];
  const rawOutput = {
    schemaVersion: 3,
    style: { ru: "краткий каталог", zh: "简洁目录" },
    roleGuidance: {},
    commonPatterns: [],
    differences: [],
    cautions: [],
  };
  const adapter = adapterModule.createCategoryStrategyAnalysisAiAdapter({
    pool: {
      async query(sql, parameters) {
        queries.push({ sql, parameters });
        return { rows: [{
          id: "profile-a", account_id: "account-a", config_version: 7,
          base_url: "https://gateway.example.test/v1", api_key_env_name: "SUB2API_ENCRYPTED_KEY",
          text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_RESPONSES_IMAGE_TOOL",
          text_model: "vision-a", image_model: "image-a", enabled: true,
          connection_id: "connection-a", connection_version: 3,
        }] };
      },
    },
    async getGateway() {
      return { async createTextResponse(input) { gatewayCalls.push(input); return { value: rawOutput }; } };
    },
  });
  const execution = {
    accountId: "account-a", analyzerVersion: "category-strategy-v1",
    promptVersion: "category-strategy-prompt-v2", profileId: "profile-a",
    profileVersion: 7, model: "vision-a",
  };
  await adapter.assertReady({ accountId: "account-a", configuration: {
    analyzerVersion: "category-strategy-v1", promptVersion: "category-strategy-prompt-v2",
    profileId: "profile-a", profileVersion: 7, model: "vision-a",
  } });
  assert.equal(gatewayCalls.length, 0);
  assert.deepEqual(await adapter.analyze({
    attemptId: "attempt-a", requestKey: "a".repeat(64), execution,
    scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17029005, typeId: 94453 },
    productFacts: [
      { sampleId: "sample-a", sku: "10001" },
      { sampleId: "sample-b", sku: "10002" },
    ],
    images: [
      { evidenceId: "evidence-a", sampleId: "sample-a", sku: "10001", role: "MAIN", ordinal: 0,
        contentType: "image/webp", bytesBase64: Buffer.from("image-a").toString("base64") },
      { evidenceId: "evidence-b", sampleId: "sample-b", sku: "10002", role: "DETAIL", ordinal: 1,
        contentType: "image/jpeg", bytesBase64: Buffer.from("image-b").toString("base64") },
    ],
    contract: { schemaVersion: 3,
      roles: ["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"],
      aggregateEvidenceMinimumDistinctSkus: 2,
      prohibited: ["image counts", "role counts", "copying brand claims", "future generation references"] },
  }), rawOutput);
  assert.deepEqual(queries.map((entry) => entry.parameters), [
    ["account-a", "profile-a", 7, "vision-a"],
    ["account-a", "profile-a", 7, "vision-a"],
  ]);
  assert.match(queries[0].sql, /account_id=\$1.+id=\$2.+config_version=\$3.+text_model=\$4.+enabled IS TRUE/su);
  assert.equal(gatewayCalls.length, 1);
  assert.deepEqual(gatewayCalls[0].sourceImages.map((image) => ({
    contentType: image.contentType, bytes: image.bytes.toString("utf8"),
  })), [
    { contentType: "image/webp", bytes: "image-a" },
    { contentType: "image/jpeg", bytes: "image-b" },
  ]);
  assert.equal(gatewayCalls[0].profile.accountId, "account-a");
  assert.equal(gatewayCalls[0].profile.connectionId, "connection-a");
  assert.equal(gatewayCalls[0].model, "vision-a");
  assert.equal(gatewayCalls[0].requestKey, "a".repeat(64));
  assert.equal(gatewayCalls[0].correlationId, "attempt-a");
  assert.match(gatewayCalls[0].prompt, /evidence-a.+10001.+evidence-b.+10002/su);
  assert.match(gatewayCalls[0].prompt, /Russian.+Simplified Chinese/su);
  assert.equal(gatewayCalls[0].jsonSchema.properties.schemaVersion.const, 3);
  assert.deepEqual(gatewayCalls[0].jsonSchema.properties.style.required, ["ru", "zh"]);
  assert.equal(gatewayCalls[0].jsonSchema.properties.style.properties.ru.maxLength, 500);
  assert.equal(gatewayCalls[0].jsonSchema.properties.commonPatterns.maxItems, 10);
  assert.equal(gatewayCalls[0].jsonSchema.properties.differences.maxItems, 10);
  assert.equal(gatewayCalls[0].jsonSchema.properties.cautions.maxItems, 10);
  assert.deepEqual(gatewayCalls[0].jsonSchema.properties.roleGuidance.required,
    ["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"]);
  assert.deepEqual(gatewayCalls[0].jsonSchema.properties.roleGuidance.properties.MAIN
    .properties.evidenceIds.items.enum, ["evidence-a", "evidence-b"]);
  await assert.rejects(adapter.recover({
    attemptId: "attempt-a", requestKey: "a".repeat(64), execution,
  }), { code: "AI_RESPONSE_UNKNOWN", retryable: true });
  assert.equal(gatewayCalls.length, 1);
});

test("category strategy production request is accepted by the strict multimodal gateway contract", async () => {
  const { createCategoryStrategyAnalysisAiAdapter } = await import("../auto-listing-category-strategy-ai-adapter.mjs");
  const requests = [];
  const evidenceIds = Array.from({ length: 7 }, (_, sampleIndex) => (
    Array.from({ length: 6 }, (_, imageIndex) => `evidence-${sampleIndex + 1}-${imageIndex + 1}`)
  )).flat();
  const citedEvidenceIds = [evidenceIds[0], evidenceIds[6]];
  const roleGuidance = Object.fromEntries(CATEGORY_ROLES.map((role) => [role, {
    composition: { ru: `${role} композиция`, zh: `${role} 构图` },
    background: { ru: "чистый", zh: "干净" }, textDensity: "LIGHT",
    layout: { ru: "по центру", zh: "居中" }, evidenceIds: citedEvidenceIds, confidence: 0.9,
  }]));
  const output = {
    schemaVersion: 3, style: { ru: "краткий каталог", zh: "简洁目录" }, roleGuidance,
    commonPatterns: [{ pattern: { ru: "чистый макет", zh: "干净布局" },
      evidenceIds: citedEvidenceIds, confidence: 0.9 }],
    differences: [], cautions: [],
  };
  const gateway = createSub2ApiAdapter({
    async fetchImpl(url, init) {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        model: "vision-a",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    readSecret() { throw new Error("legacy secret must not be used"); },
    async resolveSecret() { return "test-encrypted-secret"; },
    async resolveHostname() { return [{ address: "203.0.113.10", family: 4 }]; },
    allowedGatewayBaseUrls: ["https://gateway.example.test/v1"],
  });
  const adapter = createCategoryStrategyAnalysisAiAdapter({
    pool: { async query() { return { rows: [{
      id: "profile-a", account_id: "account-a", config_version: 7,
      base_url: "https://gateway.example.test/v1", api_key_env_name: "SUB2API_ENCRYPTED_KEY",
      text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_RESPONSES_IMAGE_TOOL",
      text_model: "vision-a", image_model: "image-a", enabled: true,
      connection_id: "connection-a", connection_version: 3,
    }] }; } },
    async getGateway() { return gateway; },
  });

  const result = await adapter.analyze({
    attemptId: "attempt-a", requestKey: "a".repeat(64),
    execution: {
      accountId: "account-a", analyzerVersion: "category-strategy-v1",
      promptVersion: "category-strategy-prompt-v2", profileId: "profile-a",
      profileVersion: 7, model: "vision-a",
    },
    scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17029005, typeId: 94453 },
    productFacts: Array.from({ length: 7 }, (_, sampleIndex) => ({
      sampleId: `sample-${sampleIndex + 1}`, sku: `${10001 + sampleIndex}`,
    })),
    images: evidenceIds.map((evidenceId, index) => {
      const sampleIndex = Math.floor(index / 6);
      const imageIndex = index % 6;
      return {
        evidenceId, sampleId: `sample-${sampleIndex + 1}`, sku: `${10001 + sampleIndex}`,
        role: imageIndex === 0 ? "MAIN" : "DETAIL", ordinal: imageIndex,
        contentType: "image/png", bytesBase64: PNG_1X1,
      };
    }),
    contract: { schemaVersion: 3, roles: CATEGORY_ROLES,
      aggregateEvidenceMinimumDistinctSkus: 2,
      prohibited: ["image counts", "role counts", "copying brand claims", "future generation references"] },
  });

  assert.deepEqual(result, output);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://gateway.example.test/v1/responses");
  assert.equal(requests[0].body.input[0].content.filter((part) => part.type === "input_image").length, 42);
  assert.deepEqual(requests[0].body.text.format.schema.properties.roleGuidance.required, CATEGORY_ROLES);
  assert.equal(requests[0].body.text.format.schema.properties.schemaVersion.const, 3);
});

test("category strategy runtime lazily composes the production analysis adapter when none is injected", async () => {
  let analyzerInput;
  let adapterInput;
  let gatewayPortCalls = 0;
  const gateway = { createTextResponse() {} };
  const productionAdapter = { assertReady() {}, analyze() {}, recover() {} };
  const runtime = createAutoListingCategoryStrategyRuntime({
    env: { AUTO_LISTING_ENABLED: "true",
      APP_ENCRYPTION_KEY: "test-only-category-session-key-at-least-32-characters" },
    async getPostgresPool() { return { async query() {}, async connect() {} }; },
    createRepository() { return {}; }, createStrategyReadModel() { return {}; },
    createSampleStore() { return {}; }, createObjectStorage() { return {}; },
    createAnalyzer(input) { analyzerInput = input; return { analyze() {}, editGuidance() {} }; },
    createAnalysisAiAdapter(input) { adapterInput = input; return productionAdapter; },
    async createAnalysisGatewayPorts() { gatewayPortCalls += 1; return { gateway }; },
    createPublicationRepository() { return {}; },
    createAdminService() { return { publishCategoryStrategyDraft() {}, rollbackCategoryStrategyVersion() {} }; },
    createService() { return { marker: "category-service" }; },
  });
  await runtime.getService();
  assert.equal(analyzerInput.aiAdapter, productionAdapter);
  assert.equal(gatewayPortCalls, 0);
  assert.equal(await adapterInput.getGateway(), gateway);
  assert.equal(await adapterInput.getGateway(), gateway);
  assert.equal(gatewayPortCalls, 1);
});
import {
  createAutoListingCategoryStrategyExtensionHttpHandler,
  createAutoListingCategoryStrategyHttpHandler,
} from "../auto-listing-category-strategy-routes.mjs";

function build({ settingsStartError = null, mountCategoryExtension = false } = {}) {
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
  const categoryExtensionChannel = Object.freeze({ marker: "category-extension-channel" });
  const categoryStrategyRuntime = Object.freeze({
    async getService() { return categoryStrategyService; },
    extensionChannel: categoryExtensionChannel,
  });
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
  let categoryStrategyExtensionHandlerInput;
  const runtime = createAutoListingWebRuntime({
    authenticate: async () => ({ id: "account-a", role: "admin" }),
    ...(mountCategoryExtension ? { authenticateCollector: async () => ({ id: "account-a", role: "admin" }) } : {}),
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
    createCategoryStrategyExtensionHandler(input) {
      categoryStrategyExtensionHandlerInput = input;
      return async (_req, _res, url) =>
        url.pathname.startsWith("/extension/auto-listing/category-strategy");
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
    categoryStrategyExtensionHandler: () => categoryStrategyExtensionHandlerInput,
    categoryExtensionChannel,
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

test("web runtime mounts the authenticated extension sampling route on the same channel", async () => {
  const h = build({ mountCategoryExtension: true });
  assert.equal(await h.runtime.handleCategoryStrategyExtensionRoute({}, {}, new URL(
    "https://example.test/extension/auto-listing/category-strategy/sampling-session",
  )), true);
  const input = h.categoryStrategyExtensionHandler();
  assert.equal(input.extensionChannel, h.categoryExtensionChannel);
  assert.equal(await input.getService(), h.categoryStrategyService);
  await input.readJson({});
  assert.deepEqual(h.events.find((entry) => Array.isArray(entry) && entry[0] === "read-json"),
    ["read-json", { maxBytes: 256 * 1024, requireBody: true }]);
});

test("category strategy runtime composes real non-analysis ports and fails exact facts closed until Task 6 wiring", async () => {
  const service = Object.freeze({ marker: "category-service" });
  let captured;
  let analyzerInput;
  const objectStorage = {};
  let poolReads = 0;
  const runtime = createAutoListingCategoryStrategyRuntime({
    env: { AUTO_LISTING_ENABLED: "true",
      APP_ENCRYPTION_KEY: "test-only-category-session-key-at-least-32-characters" },
    async getPostgresPool() { poolReads += 1; return { async query() {}, async connect() {} }; },
    createRepository() { return {}; },
    createStrategyReadModel() { return {}; },
    createSampleStore() { return {}; },
    createObjectStorage() { return objectStorage; },
    createAnalyzer(input) { analyzerInput = input; return { analyze() {}, editGuidance() {} }; },
    analysisAiAdapter: { assertReady() {}, analyze() {}, recover() {} },
    createPublicationRepository() { return {}; },
    createAdminService() { return { publishCategoryStrategyDraft() {}, rollbackCategoryStrategyVersion() {} }; },
    createService(input) { captured = input; return service; },
  });
  assert.equal(poolReads, 0);
  assert.equal(await runtime.getService(), service);
  assert.equal(poolReads, 1);
  assert.equal(captured.analyzer.analyze instanceof Function, true);
  assert.equal(analyzerInput.repository, captured.repository);
  assert.equal(analyzerInput.objectStorage, objectStorage);
  assert.equal(analyzerInput.aiAdapter.analyze instanceof Function, true);
  assert.equal(typeof analyzerInput.configurationResolver.resolve, "function");
  await assert.rejects(captured.exactProductFacts.verify({
    accountId: "account-a", draftId: "draft-a", sessionId: "session-a",
    sessionSecretHash: "a".repeat(64),
    scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 170, typeId: 99 },
    sku: "4862904234", sourceProductId: 4_862_904_234,
    sourceProductRef: "product-4862904234", correlationId: "correlation-a",
  }), {
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
  await assert.rejects(captured.extensionSessionChannel.assertReady({ accountId: "account-a" }), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_HANDOFF_NOT_READY", status: 409,
  });
  assert.equal(typeof captured.extensionSessionChannel.putSession, "function");
  assert.equal(await runtime.getService(), service);
  assert.equal(poolReads, 1);
});

test("category strategy runtime wires safe observability only when its hash secret is configured", async () => {
  const increments = [];
  const logs = [];
  let captured;
  const runtime = createAutoListingCategoryStrategyRuntime({
    env: { AUTO_LISTING_ENABLED: "true",
      APP_ENCRYPTION_KEY: "test-only-category-session-key-at-least-32-characters",
      AUTO_LISTING_CATEGORY_STRATEGY_OBSERVABILITY_HASH_SECRET: "test-observer-hash-secret-long-enough" },
    metrics: { increment(name, labels) { increments.push({ name, labels }); } },
    logger: { info(event) { logs.push(event); } },
    async getPostgresPool() { return { async query() {}, async connect() {} }; },
    createRepository() { return {}; }, createStrategyReadModel() { return {}; },
    createSampleStore() { return {}; }, createObjectStorage() { return {}; },
    createAnalyzer() { return { analyze() {}, editGuidance() {} }; },
    createPublicationRepository() { return {}; },
    createAdminService() { return { publishCategoryStrategyDraft() {}, rollbackCategoryStrategyVersion() {} }; },
    createService(input) { captured = input; return { marker: "service" }; },
  });
  await runtime.getService();
  assert.equal(typeof captured.observability.observe, "function");
  await captured.observability.observe({ metric: "category_strategy_publish_total", accountId: "private-account",
    draftId: "draft-a", sessionId: null, attemptId: null, strategyVersionId: "strategy-v2",
    scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 170, typeId: 99 },
    correlationId: "correlation-a", outcome: "success", startedAt: Date.now() });
  assert.deepEqual(increments, [{ name: "category_strategy_publish_total", labels: { outcome: "success" } }]);
  assert.equal(JSON.stringify(logs).includes("private-account"), false);
});

test("default category runtime session route returns NOT_READY before a database session write", async () => {
  let sessionWrites = 0;
  const repository = {
    async getDraftReplay() { return null; },
    async createDraft() { throw new Error("not used"); },
    async getSamplingSessionReplay() { return null; },
    async prepareSampleRevision() { throw new Error("must not write"); },
    async cancelSamplingSession() { throw new Error("must not write"); },
    async startSamplingSession() { sessionWrites += 1; throw new Error("must not write"); },
    async validateSamplingSession() { throw new Error("not used"); },
    async getCommittedSampleSetReplay() { return null; },
    async commitSampleSetCanonical() { throw new Error("not used"); },
    async transitionAccountPolicy() { throw new Error("not used"); },
    async getAccountPolicy() {
      return { accountId: "account-a", mode: "REQUIRE_EXACT_STRATEGY", version: 1, duplicate: false };
    },
  };
  const runtime = createAutoListingCategoryStrategyRuntime({
    env: { AUTO_LISTING_ENABLED: "true",
      APP_ENCRYPTION_KEY: "test-only-category-session-key-at-least-32-characters" },
    async getPostgresPool() { return { async query() {}, async connect() {} }; },
    createRepository() { return repository; },
    createStrategyReadModel() { return {
      async listStrategies() { return []; },
      async getDraft() { return {
        draftId: "draft-a", accountId: "account-a",
        scope: { accountId: "account-a", taxonomyScope: "OZON:DEFAULT",
          descriptionCategoryId: 170, typeId: 99 },
        draftVersion: 1, status: "COLLECTING", sampleCount: 0,
        sourceCollectItemId: "collect-a", expectedSourceVersion: "draft:1",
        browserUrl: "https://www.ozon.ru/category/170/",
      }; },
      async getDraftDetail() { throw new Error("not used"); },
      async getThumbnailEvidence() { return null; },
    }; },
    createSampleStore() { return { async persistSampleImages() { throw new Error("not used"); } }; },
    createObjectStorage() { return { async readObjectExpected() { throw new Error("not used"); } }; },
    createAnalyzer() { return { async analyze() {}, async editGuidance() {} }; },
    createPublicationRepository() { return {}; },
    createAdminService() { return {
      async publishCategoryStrategyDraft() { throw new Error("not used"); },
      async rollbackCategoryStrategyVersion() { throw new Error("not used"); },
    }; },
  });
  let response;
  const handler = createAutoListingCategoryStrategyHttpHandler({
    authenticate: async () => ({ id: "account-a", role: "admin" }),
    getService: runtime.getService,
    readJson: async () => ({ expectedDraftVersion: 1,
      idempotencyKey: "session-no-transport", correlationId: "correlation-a" }),
    sendJson(_res, status, payload) { response = { status, payload }; },
  });

  assert.equal(await handler({ method: "POST" }, {}, new URL(
    "https://example.test/admin/auto-listing/category-strategies/draft-a/sampling-sessions",
  )), true);
  assert.deepEqual(response, { status: 409, payload: {
    ok: false, code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_HANDOFF_NOT_READY",
    message: "类目策略请求无法完成",
  } });
  assert.equal(sessionWrites, 0);
});

test("extension channel rejects old versions before handoff and keeps sessions account scoped", async () => {
  let now = Date.parse("2026-08-15T00:00:00.000Z");
  const channel = createCategoryStrategyExtensionChannel({
    now: () => now,
    minimumExtensionVersion: "0.13.46.3",
  });
  await assert.rejects(channel.markReady({ accountId: "account-a", extensionVersion: "0.13.46.2" }), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_VERSION_UNSUPPORTED", status: 426,
  });
  await assert.rejects(channel.assertReady({ accountId: "account-a" }), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_HANDOFF_NOT_READY", status: 409,
  });
  await channel.markReady({ accountId: "account-a", extensionVersion: "0.13.46.3" });
  await channel.assertReady({ accountId: "account-a" });
  await channel.putSession({
    accountId: "account-a", actorId: "account-a", draftId: "draft-a",
    expectedDraftVersion: 1, sessionId: "session-a",
    sessionSecret: "secret-value-at-least-32-characters", expiresAt: "2026-08-15T02:00:00.000Z",
    extensionMode: "CATEGORY_STRATEGY_SAMPLING",
    scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542 },
  });
  assert.equal((await channel.getSession({ accountId: "account-a", sessionId: "session-a",
    extensionVersion: "0.13.46.3" })).sessionId, "session-a");
  assert.equal(await channel.getSession({ accountId: "account-b", sessionId: "session-a",
    extensionVersion: "0.13.46.3" }), null);
  await channel.putSession({
    accountId: "account-a", actorId: "account-a", draftId: "draft-b",
    expectedDraftVersion: 2, sessionId: "session-b",
    sessionSecret: "another-secret-value-at-least-32-characters",
    expiresAt: "2026-08-15T02:00:00.000Z", extensionMode: "CATEGORY_STRATEGY_SAMPLING",
    scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028923, typeId: 91543 },
  });
  assert.equal((await channel.getSession({ accountId: "account-a", sessionId: "session-a",
    extensionVersion: "0.13.46.3" })).draftId, "draft-a");
  assert.equal((await channel.getSession({ accountId: "account-a", sessionId: "session-b",
    extensionVersion: "0.13.46.3" })).draftId, "draft-b");
  await assert.rejects(channel.cancelSession({ accountId: "account-a", sessionId: "session-a",
    extensionVersion: "0.13.46.2" }), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_VERSION_UNSUPPORTED", status: 426,
  });
  assert.equal((await channel.getSession({ accountId: "account-a", sessionId: "session-a",
    extensionVersion: "0.13.46.3" })).draftId, "draft-a");
  now += 2 * 60 * 60 * 1000;
  assert.equal(await channel.getSession({ accountId: "account-a", sessionId: "session-a",
    extensionVersion: "0.13.46.3" }), null);
  assert.equal(await channel.getSession({ accountId: "account-a", sessionId: "session-b",
    extensionVersion: "0.13.46.3" }), null);
});

test("extension facts route reprojects captured page and card evidence before Task 5 cross-check", async () => {
  const hash = "a".repeat(64);
  const scope = { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542 };
  const channel = createCategoryStrategyExtensionChannel({
    now: () => Date.parse("2026-08-15T00:00:00.000Z"),
    minimumExtensionVersion: "0.13.46.3",
  });
  await channel.markReady({ accountId: "account-a", extensionVersion: "0.13.46.3" });
  await channel.putSession({ accountId: "account-a", actorId: "account-a", draftId: "draft-a",
    expectedDraftVersion: 1, sessionId: "session-a",
    sessionSecret: "secret-value-at-least-32-characters", expiresAt: "2026-08-15T02:00:00.000Z",
    extensionMode: "CATEGORY_STRATEGY_SAMPLING", scope });
  const samples = Array.from({ length: 5 }, (_, index) => {
    const sku = String(4_862_904_234 + index);
    return { sku, sourceProductId: Number(sku), sourceProductRef: `product-${sku}`,
      sourceProductResponseHash: hash, pageScope: scope, productScope: scope,
      sourceReferences: [{ imageId: `image-${sku}`, role: "MAIN", ordinal: 0,
        sourceUrl: `https://cdn1.ozone.ru/${sku}.jpg`, sourceResponseHash: hash }] };
  });
  let confirmInput;
  let confirmCalls = 0;
  const service = { async confirmSampleSet(input) {
    confirmCalls += 1; confirmInput = input; return { accepted: true };
  } };
  const responses = [];
  let currentRole = "admin";
  const handler = createAutoListingCategoryStrategyExtensionHttpHandler({
    async authenticateExtension(_req, permission) {
      assert.ok(["collector.job.read", "collector.upload"].includes(permission));
      return { id: "account-a", role: currentRole };
    },
    async getService() { return service; },
    extensionChannel: channel,
    async readJson() { return { sessionId: "session-a",
      pageFact: { pageScope: scope, sourceResponseHash: hash }, samples,
      idempotencyKey: "confirm-a", correlationId: "correlation-a" }; },
    sendJson(_res, status, payload) { responses.push({ status, payload }); },
  });
  assert.equal(await handler({ method: "POST", headers: { "x-zongzi-extension-version": "0.13.46.2" } }, {},
    new URL("https://example.test/extension/auto-listing/category-strategy/sampling-sessions/session-a/confirm")), true);
  assert.equal(responses[0].status, 426);
  assert.equal(confirmCalls, 0);
  assert.equal(await handler({ method: "GET", headers: { "x-zongzi-extension-version": "0.13.46.3" } }, {},
    new URL("https://example.test/extension/auto-listing/category-strategy/sampling-sessions/session-a")), true);
  assert.equal(responses[1].status, 200);
  assert.equal(responses[1].payload.data.sessionId, "session-a");
  assert.equal(responses[1].payload.data.expectedDraftVersion, 1);
  assert.equal(await handler({ method: "POST", headers: { "x-zongzi-extension-version": "0.13.46.3" } }, {},
    new URL("https://example.test/extension/auto-listing/category-strategy/sampling-sessions/session-a/confirm")), true);
  assert.equal(responses[2].status, 201);
  assert.equal(await channel.getSession({ accountId: "account-a", sessionId: "session-a",
    extensionVersion: "0.13.46.3" }), null);
  assert.deepEqual(confirmInput.actor, { id: "account-a", role: "admin" });
  assert.equal(confirmInput.sessionSecret, "secret-value-at-least-32-characters");
  assert.deepEqual(confirmInput.samples, samples.map(({ sku, sourceProductId, sourceProductRef }) =>
    ({ sku, sourceProductId, sourceProductRef })));
  assert.equal((await channel.verify({ accountId: "account-a", draftId: "draft-a",
    sessionId: "session-a", sessionSecretHash: crypto.createHash("sha256")
      .update("secret-value-at-least-32-characters").digest("hex"),
    scope, sku: samples[0].sku, sourceProductId: samples[0].sourceProductId,
    sourceProductRef: samples[0].sourceProductRef, correlationId: "correlation-a" })).sku,
  samples[0].sku);
  assert.equal(await handler({ method: "POST", headers: { "x-zongzi-extension-version": "0.13.46.3" } }, {},
    new URL("https://example.test/extension/auto-listing/category-strategy/sampling-sessions/session-a/confirm")), true);
  assert.equal(responses[3].status, 201);
  assert.equal(confirmCalls, 2);
  currentRole = "user";
  assert.equal(await handler({ method: "POST", headers: { "x-zongzi-extension-version": "0.13.46.3" } }, {},
    new URL("https://example.test/extension/auto-listing/category-strategy/sampling-sessions/session-a/cancel")), true);
  assert.equal(responses[4].status, 403);
  assert.equal(confirmCalls, 2);
});

test("extension confirmation restores the private facts channel after a server restart", async () => {
  const hash = "a".repeat(64);
  const scope = { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542 };
  const samples = Array.from({ length: 5 }, (_, index) => {
    const sku = String(4_862_904_234 + index);
    return { sku, sourceProductId: Number(sku), sourceProductRef: `product-${sku}`,
      sourceProductResponseHash: hash, pageScope: scope, productScope: scope,
      sourceReferences: [{ imageId: `image-${sku}`, role: "MAIN", ordinal: 0,
        sourceUrl: `https://cdn1.ozone.ru/${sku}.jpg`, sourceResponseHash: hash }] };
  });
  const restartedChannel = createCategoryStrategyExtensionChannel({
    now: () => Date.parse("2026-08-15T00:30:00.000Z"),
    minimumExtensionVersion: "0.13.46.3",
  });
  let confirmed = null;
  let response = null;
  const handler = createAutoListingCategoryStrategyExtensionHttpHandler({
    async authenticateExtension() { return { id: "account-a", role: "admin" }; },
    async getService() { return { async confirmSampleSet(input) {
      confirmed = input;
      return { accepted: true };
    } }; },
    extensionChannel: restartedChannel,
    async readJson() { return {
      sessionId: "session-a",
      session: {
        draftId: "draft-a",
        expectedDraftVersion: 1,
        sessionSecret: "secret-value-at-least-32-characters",
        scope,
        expiresAt: "2026-08-15T02:00:00.000Z",
      },
      pageFact: { pageScope: scope, sourceResponseHash: hash },
      samples,
      idempotencyKey: "confirm-a",
      correlationId: "correlation-a",
    }; },
    sendJson(_res, status, payload) { response = { status, payload }; },
  });

  assert.equal(await handler({ method: "POST", headers: {
    "x-zongzi-extension-version": "0.13.46.3",
  } }, {}, new URL(
    "https://example.test/extension/auto-listing/category-strategy/sampling-sessions/session-a/confirm",
  )), true);
  assert.equal(response.status, 201);
  assert.equal(confirmed.draftId, "draft-a");
  assert.equal(confirmed.expectedDraftVersion, 1);
  assert.equal(confirmed.sessionSecret, "secret-value-at-least-32-characters");
  assert.deepEqual(confirmed.samples, samples.map(({ sku, sourceProductId, sourceProductRef }) =>
    ({ sku, sourceProductId, sourceProductRef })));
});

test("extension confirmation restores a legacy private session from the durable draft after restart", async () => {
  const hash = "a".repeat(64);
  const scope = { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542 };
  const samples = Array.from({ length: 5 }, (_, index) => {
    const sku = String(4_862_904_234 + index);
    return { sku, sourceProductId: Number(sku), sourceProductRef: `product-${sku}`,
      sourceProductResponseHash: hash, pageScope: scope, productScope: scope,
      sourceReferences: [{ imageId: `image-${sku}`, role: "MAIN", ordinal: 0,
        sourceUrl: `https://cdn1.ozone.ru/${sku}.jpg`, sourceResponseHash: hash }] };
  });
  const restartedChannel = createCategoryStrategyExtensionChannel({
    now: () => Date.parse("2026-08-15T00:30:00.000Z"),
    minimumExtensionVersion: "0.13.46.16",
  });
  let confirmed = null;
  let draftReads = 0;
  let response = null;
  const handler = createAutoListingCategoryStrategyExtensionHttpHandler({
    async authenticateExtension() { return { id: "account-a", role: "admin" }; },
    async getService() { return {
      async getDraft({ draftId }) {
        draftReads += 1;
        assert.equal(draftId, "draft-a");
        return { draft: { draftId: "draft-a", draftVersion: 3, scope },
          session: { sessionId: "session-a", expiresAt: "2026-08-15T02:00:00.000Z" } };
      },
      async confirmSampleSet(input) { confirmed = input; return { accepted: true }; },
    }; },
    extensionChannel: restartedChannel,
    async readJson() { return {
      sessionId: "session-a",
      session: { draftId: "draft-a", sessionSecret: "secret-value-at-least-32-characters" },
      pageFact: { pageScope: scope, sourceResponseHash: hash }, samples,
      idempotencyKey: "confirm-a", correlationId: "correlation-a",
    }; },
    sendJson(_res, status, payload) { response = { status, payload }; },
  });

  assert.equal(await handler({ method: "POST", headers: {
    "x-zongzi-extension-version": "0.13.46.16",
  } }, {}, new URL(
    "https://example.test/extension/auto-listing/category-strategy/sampling-sessions/session-a/confirm",
  )), true);
  assert.equal(response.status, 201);
  assert.equal(draftReads, 1);
  assert.equal(confirmed.draftId, "draft-a");
  assert.equal(confirmed.expectedDraftVersion, 3);
  assert.equal(confirmed.sessionSecret, "secret-value-at-least-32-characters");
});

test("extension cancellation clears local facts even when durable cancellation reports a safe failure", async () => {
  let localCancels = 0;
  const responses = [];
  const handler = createAutoListingCategoryStrategyExtensionHttpHandler({
    async authenticateExtension() { return { id: "account-a", role: "admin" }; },
    async getService() { return { async cancelSamplingSession() {
      throw Object.assign(new Error("database raw"), {
        code: "AUTO_LISTING_CATEGORY_STRATEGY_DATABASE_FAILED", status: 503, retryable: true,
      });
    } }; },
    extensionChannel: {
      async markReady() {},
      async getSession() {},
      async putSession() {},
      async putFacts() {},
      async completeSession() {},
      async cancelSession(input) {
      localCancels += 1;
      assert.deepEqual(input, { accountId: "account-a", sessionId: "session-a",
        extensionVersion: "0.13.46.3" });
      return true;
      },
    },
    async readJson() { return { sessionId: "session-a" }; },
    sendJson(_res, status, payload) { responses.push({ status, payload }); },
  });
  assert.equal(await handler({ method: "POST", headers: {
    "x-zongzi-extension-version": "0.13.46.3",
  } }, {}, new URL(
    "https://example.test/extension/auto-listing/category-strategy/sampling-sessions/session-a/cancel",
  )), true);
  assert.equal(localCancels, 1);
  assert.deepEqual(responses, [{ status: 503, payload: { ok: false,
    code: "AUTO_LISTING_CATEGORY_STRATEGY_DATABASE_FAILED",
    message: "类目策略扩展服务暂时不可用" } }]);
});

test("extension facts channel rejects extra, accessor, wrong-account, and mixed-scope evidence with zero confirm", async () => {
  const hash = "a".repeat(64);
  const scope = { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542 };
  const channel = createCategoryStrategyExtensionChannel({
    now: () => Date.parse("2026-08-15T00:00:00.000Z"), minimumExtensionVersion: "0.13.46.3",
  });
  await channel.markReady({ accountId: "account-a", extensionVersion: "0.13.46.3" });
  await channel.putSession({ accountId: "account-a", actorId: "account-a", draftId: "draft-a",
    expectedDraftVersion: 1, sessionId: "session-a",
    sessionSecret: "secret-value-at-least-32-characters", expiresAt: "2026-08-15T02:00:00.000Z",
    extensionMode: "CATEGORY_STRATEGY_SAMPLING", scope });
  const sample = { sku: "4862904234", sourceProductId: 4_862_904_234,
    sourceProductRef: "product-4862904234", sourceProductResponseHash: hash,
    pageScope: scope, productScope: { ...scope, typeId: 1 },
    sourceReferences: [{ imageId: "image-a", role: "MAIN", ordinal: 0,
      sourceUrl: "https://cdn1.ozone.ru/a.jpg", sourceResponseHash: hash }] };
  let reads = 0;
  const accessor = { ...sample };
  Object.defineProperty(accessor, "sku", { enumerable: true, get() { reads += 1; return sample.sku; } });
  const batch = (first) => [first, ...Array.from({ length: 4 }, (_, index) => {
    const sku = String(4_862_904_235 + index);
    return { ...sample, sku, sourceProductId: Number(sku), sourceProductRef: `product-${sku}`,
      productScope: scope, sourceReferences: [{ ...sample.sourceReferences[0], imageId: `image-${sku}` }] };
  })];
  for (const [accountId, candidate] of [
    ["account-b", { ...sample, productScope: scope }],
    ["account-a", sample],
    ["account-a", { ...sample, productScope: scope, vendorPayload: {} }],
    ["account-a", accessor],
  ]) {
    await assert.rejects(channel.putFacts({ accountId, sessionId: "session-a",
      extensionVersion: "0.13.46.3",
      pageFact: { pageScope: scope, sourceResponseHash: hash }, samples: batch(candidate) }));
  }
  assert.equal(reads, 0);
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
