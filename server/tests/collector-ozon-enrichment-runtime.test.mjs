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

test("PostgreSQL-mode enrichment writes dedicated audit rows without rewriting legacy state", async () => {
  const persistedAudits = [];
  let loadCount = 0;
  let saveCount = 0;
  const loggerSignals = [];
  const repository = cacheOnlyRepository();
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => {
      loadCount += 1;
      return versionedClone({ auditEvents: [] }, 1);
    },
    saveState: async () => { saveCount += 1; },
    persistenceMode: () => "postgres",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    initializePostgresRepository: async () => repository,
    persistPostgresAuditEvent: async (event) => { persistedAudits.push(event); },
    now: () => new Date(NOW),
    logger: { error(...args) { loggerSignals.push(args); } },
  });

  const output = await runtime.service.enrichBatch({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    requestId: "request-runtime-audit",
    skus: ["sku-runtime-1", "sku-runtime-2", "sku-runtime-3", "sku-runtime-4"],
  });

  assert.equal(output.every((item) => item.status === "COMPLETE"), true);
  const enrichmentAudits = persistedAudits.filter(
    (event) => event.source === "collector-ozon-enrichment",
  );
  assert.equal(enrichmentAudits.length, 4);
  assert.deepEqual(
    new Set(enrichmentAudits.map((event) => event.metadata.sku)),
    new Set(["sku-runtime-1", "sku-runtime-2", "sku-runtime-3", "sku-runtime-4"]),
  );
  assert.equal(loadCount, 0);
  assert.equal(saveCount, 0);
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

test("PostgreSQL audit write failure emits only a safe logger signal", async () => {
  let auditAttempts = 0;
  const loggerSignals = [];
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => versionedClone({ auditEvents: [] }, 1),
    saveState: async () => { throw new Error("legacy state must not be saved"); },
    persistenceMode: () => "postgres",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    authenticate: async () => ({ collectorSessionId: "collector-runtime", accountId: "account-runtime" }),
    readJson: async () => ({}),
    sendJson() {},
    initializePostgresRepository: async () => cacheOnlyRepository(),
    persistPostgresAuditEvent: async () => {
      auditAttempts += 1;
      throw new Error("database relation and credential detail");
    },
    now: () => new Date(NOW),
    logger: { error(...args) { loggerSignals.push(args); } },
  });

  const result = await runtime.service.enrichOne({
    session: { collectorSessionId: "collector-runtime", accountId: "account-runtime" },
    requestId: "request-exhausted-audit",
    sku: "sku-exhausted-audit",
  });

  assert.equal(result.cache.hit, true);
  assert.equal(auditAttempts, 1);
  assert.equal(loggerSignals.length, 1);
  assert.equal(JSON.stringify(loggerSignals).includes("credential detail"), false);
});
