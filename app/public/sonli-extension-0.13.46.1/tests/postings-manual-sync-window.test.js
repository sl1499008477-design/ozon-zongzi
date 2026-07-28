const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sourcePath = path.join(__dirname, "..", "background", "sync", "sync-engine.js");
const source = fs.readFileSync(sourcePath, "utf8");

function loadEngine(calls, opts = {}) {
  let postingsWatermark = opts.postingsWatermark || null;
  const savedWatermarks = [];
  const context = {
    console,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "generated-job-id" },
  };
  context.globalThis = context;
  context.JzSyncState = {
    getCachedCred: () => null,
    setCachedCred: () => {},
    invalidateCred: () => {},
    setCachedLease: () => {},
    clearCachedLease: () => {},
    getOrCreateDeviceId: async () => "device-1",
    getVisibleStores: async () => [{ id: "store-1" }],
    setLastRunAt: async () => {},
    getPostingsWatermark: async () => postingsWatermark,
    setPostingsWatermark: async (_storeId, watermark) => {
      postingsWatermark = watermark;
      savedWatermarks.push(watermark);
    },
  };
  context.JzLeaseClient = {
    acquire: async () => ({ leaseId: "lease-1", expiresAt: Date.now() + 300000 }),
    heartbeat: async () => {},
    release: async () => {},
  };
  context.JzBackendClient = {
    getSyncCredentials: async () => ({ clientId: "client", apiKey: "key" }),
    clientReport: async () => ({}),
    importPostings: async () => ({ imported: 1 }),
    getVisibleStores: async () => [{ id: "store-1" }],
  };
  context.JzDiffIndex = {
    computeHash: async () => "hash",
    getHashes: async () => new Map(),
    setHashes: async () => {},
  };
  context.JzOpiClient = {
    call: async (endpoint, payload) => {
      calls.push({ endpoint, payload });
      return {
        result: {
          postings: [{ posting_number: "posting-1", products: [] }],
          has_next: false,
        },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: sourcePath });
  return { engine: context.JzSyncEngine, savedWatermarks };
}

function daysInPayload(payload) {
  const since = new Date(payload.filter.since).getTime();
  const to = new Date(payload.filter.to).getTime();
  return Math.round((to - since) / 86400000);
}

(async () => {
  {
    const calls = [];
    const { engine, savedWatermarks } = loadEngine(calls);
    await engine.runOneType({ id: "store-1" }, "POSTINGS", "device-1", "manual-job-id");

    assert.strictEqual(calls.length, 1, "manual postings sync should call Ozon once");
    assert.strictEqual(calls[0].endpoint, "/v4/posting/fbs/list");
    assert.strictEqual(
      daysInPayload(calls[0].payload),
      30,
      "manual postings sync should pull the same 30-day window as backend manual sync",
    );
    assert.strictEqual(savedWatermarks.length, 1, "first successful sync should save a postings watermark");
    assert.strictEqual(savedWatermarks[0].lastSuccessTo, calls[0].payload.filter.to);
  }

  {
    const calls = [];
    const { engine, savedWatermarks } = loadEngine(calls);
    await engine.runOneType(
      { id: "store-1" },
      "POSTINGS",
      "device-1",
      "manual-job-id",
      { postingsSinceDays: 7 },
    );

    assert.strictEqual(calls.length, 1, "fast manual postings sync should call Ozon once");
    assert.strictEqual(
      daysInPayload(calls[0].payload),
      7,
      "fast manual postings sync should honor the requested short window",
    );
    assert.strictEqual(savedWatermarks.length, 0, "requested-day sync should not advance watermark");
  }

  {
    const calls = [];
    const { engine, savedWatermarks } = loadEngine(calls, {
      postingsWatermark: { lastSuccessTo: "2026-06-26T12:00:00.000Z" },
    });
    await engine.runOneType({ id: "store-1" }, "POSTINGS", "device-1", "manual-job-id");

    assert.strictEqual(calls.length, 1, "watermarked manual postings sync should call Ozon once");
    assert.strictEqual(
      calls[0].payload.filter.since,
      "2026-06-25T12:00:00.000Z",
      "watermarked manual postings sync should start at previous success minus one day",
    );
    assert.strictEqual(savedWatermarks.length, 1, "successful watermarked sync should advance watermark");
    assert.strictEqual(savedWatermarks[0].lastSuccessTo, calls[0].payload.filter.to);
  }

  {
    const calls = [];
    const { engine, savedWatermarks } = loadEngine(calls, {
      postingsWatermark: { lastSuccessTo: "2026-06-26T12:00:00.000Z" },
    });
    await engine.runOneType(
      { id: "store-1" },
      "POSTINGS",
      "device-1",
      "manual-job-id",
      {
        postingsSince: "2026-07-01T00:00:00.000Z",
        postingsTo: "2026-07-02T23:59:59.999Z",
      },
    );

    assert.strictEqual(calls.length, 1, "explicit-date postings sync should call Ozon once");
    assert.strictEqual(calls[0].payload.filter.since, "2026-07-01T00:00:00.000Z");
    assert.strictEqual(calls[0].payload.filter.to, "2026-07-02T23:59:59.999Z");
    assert.strictEqual(savedWatermarks.length, 0, "explicit-date postings sync should not advance watermark");
  }

  {
    const calls = [];
    const { engine, savedWatermarks } = loadEngine(calls);
    await engine.runRound("POSTINGS");

    assert.strictEqual(calls.length, 1, "scheduled postings sync should call Ozon once");
    assert.strictEqual(
      daysInPayload(calls[0].payload),
      30,
      "first scheduled postings sync without a watermark should pull the 30-day safety window",
    );
    assert.strictEqual(savedWatermarks.length, 1, "successful scheduled sync should save a postings watermark");
  }
})();
