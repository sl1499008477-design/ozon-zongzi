import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingWebRuntime } from "../auto-listing-web-runtime.mjs";

function build({ settingsStartError = null } = {}) {
  const events = [];
  const service = Object.freeze({ marker: "settings-service" });
  const settingsRuntime = Object.freeze({
    async getService() { return service; },
    async startWorker() { events.push("settings-start"); if (settingsStartError) throw settingsStartError; return true; },
    async stopWorker() { events.push("settings-stop"); },
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
    createPublicationRuntime() { throw new Error("publication must stay lazy"); },
    createUploadRuntime() { throw new Error("upload must stay lazy"); },
    createReconciliationRuntime() { throw new Error("reconciliation must stay lazy"); },
    createOperationsRuntime() { return operationsRuntime; },
    storage: {},
    probePublicPolicy: async () => true,
    assertDirectSystemReady: async () => true,
  });
  return { runtime, events, service, settingsHandler: () => settingsHandlerInput };
}

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

test("settings worker startup failure unwinds settings, operations, and user workers in reverse order", async () => {
  const failure = new Error("settings worker failed");
  const h = build({ settingsStartError: failure });
  await assert.rejects(h.runtime.startWorkers(), (error) => error === failure);
  assert.deepEqual(h.events.filter((entry) => typeof entry === "string"), [
    "user-start", "operations-start", "settings-start",
    "settings-stop", "operations-stop", "user-stop",
  ]);
});
