import assert from "node:assert/strict";
import test from "node:test";
import { createCollectorOzonEnrichmentRuntime } from "../collector-ozon-enrichment-runtime.mjs";
import { createJsonStateTransactionBoundary } from "../json-state-transaction.mjs";

const NOW = new Date("2026-07-31T00:00:00.000Z");

function cacheResult(sku) {
  return {
    status: "COMPLETE",
    result: {
      status: "COMPLETE",
      contractVersion: "collector.ozon.enrichment.v1",
      sku,
      descriptionCategoryId: 123,
      logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
      variantData: { description_category_id: 123 },
      source: "BACKEND_FLEET",
      capturedAt: NOW.toISOString(),
      cache: { hit: false, expiresAt: new Date(NOW.getTime() + 21_600_000).toISOString() },
    },
    expiresAt: new Date(NOW.getTime() + 21_600_000).toISOString(),
  };
}

function versionedClone(state, version) {
  const value = structuredClone(state);
  Object.defineProperty(value, "__storageVersion", {
    value: version,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return value;
}

function cacheOnlyRepository() {
  return {
    async readCache({ key }) { return cacheResult(key.sku); },
    async tryAcquireCacheLease() { throw new Error("cache hit must not lease"); },
    async releaseCacheLease() { return false; },
    async createOrGetJob() { throw new Error("cache hit must not create"); },
    async claimNextJob() { return null; },
    async completeJobAndCache() { throw new Error("unused"); },
    async failJobAndCache() { throw new Error("unused"); },
    async readJob() { return null; },
  };
}

test("PostgreSQL-mode concurrent enrichment audits serialize and retry version conflicts", async () => {
  let persisted = { auditEvents: [] };
  let version = 1;
  let injectConflict = true;
  let loadCount = 0;
  const loggerSignals = [];
  const repository = cacheOnlyRepository();
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => {
      loadCount += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return versionedClone(persisted, version);
    },
    saveState: async (state) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (injectConflict) {
        injectConflict = false;
        version += 1;
        persisted = {
          ...persisted,
          auditEvents: [{ eventId: "external-audit", action: "EXTERNAL" }],
        };
        throw Object.assign(new Error("simulated local state conflict"), {
          code: "LOCAL_STATE_VERSION_CONFLICT",
          status: 409,
        });
      }
      if (Number(state.__storageVersion) !== version) {
        throw Object.assign(new Error("concurrent local state conflict"), {
          code: "LOCAL_STATE_VERSION_CONFLICT",
          status: 409,
        });
      }
      persisted = structuredClone(state);
      version += 1;
    },
    persistenceMode: () => "postgres",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    initializePostgresRepository: async () => repository,
    now: () => new Date(NOW),
    logger: { error(...args) { loggerSignals.push(args); } },
  });

  const output = await runtime.service.enrichBatch({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    requestId: "request-runtime-audit",
    skus: ["sku-runtime-1", "sku-runtime-2", "sku-runtime-3", "sku-runtime-4"],
  });

  assert.equal(output.every((item) => item.status === "COMPLETE"), true);
  const enrichmentAudits = persisted.auditEvents.filter(
    (event) => event.source === "collector-ozon-enrichment",
  );
  assert.equal(enrichmentAudits.length, 4);
  assert.deepEqual(
    new Set(enrichmentAudits.map((event) => event.metadata.sku)),
    new Set(["sku-runtime-1", "sku-runtime-2", "sku-runtime-3", "sku-runtime-4"]),
  );
  assert.equal(persisted.auditEvents.some((event) => event.eventId === "external-audit"), true);
  assert.ok(loadCount >= 5, "one conflict must reload before all four audits commit");
  assert.deepEqual(loggerSignals, []);
});

test("JSON-mode concurrent enrichment audits remain serialized with repository state writes", async () => {
  const skus = ["sku-json-1", "sku-json-2", "sku-json-3", "sku-json-4"];
  let persisted = {
    auditEvents: [],
    collectorOzonEnrichmentCache: skus.map((sku) => ({
      accountId: "account-runtime",
      source: "ozon",
      sku,
      contractVersion: "collector.ozon.enrichment.v1",
      ...cacheResult(sku),
    })),
  };
  const stateTransaction = createJsonStateTransactionBoundary({ enabled: () => true });
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => structuredClone(persisted),
    saveState: async (state) => { persisted = structuredClone(state); },
    persistenceMode: () => "json",
    stateTransaction,
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    now: () => new Date(NOW),
  });

  const output = await runtime.service.enrichBatch({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    requestId: "request-json-audit",
    skus,
  });

  assert.equal(output.every((item) => item.status === "COMPLETE"), true);
  assert.equal(
    persisted.auditEvents.filter((event) => event.source === "collector-ozon-enrichment").length,
    4,
  );
});

test("audit conflict retry is finite and emits only a safe logger signal after exhaustion", async () => {
  let saveAttempts = 0;
  const loggerSignals = [];
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => versionedClone({ auditEvents: [] }, 1),
    saveState: async () => {
      saveAttempts += 1;
      throw Object.assign(new Error("database relation and credential detail"), {
        code: "LOCAL_STATE_VERSION_CONFLICT",
        status: 409,
      });
    },
    persistenceMode: () => "postgres",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    initializePostgresRepository: async () => cacheOnlyRepository(),
    now: () => new Date(NOW),
    logger: { error(...args) { loggerSignals.push(args); } },
  });

  const result = await runtime.service.enrichOne({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    requestId: "request-exhausted-audit",
    sku: "sku-exhausted-audit",
  });

  assert.equal(result.cache.hit, true);
  assert.equal(saveAttempts, 4);
  assert.equal(loggerSignals.length, 1);
  assert.equal(JSON.stringify(loggerSignals).includes("credential detail"), false);
});
