import assert from "node:assert/strict";
import test, { after } from "node:test";

const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = "postgres://query-contract.invalid/test";
const { mirrorCollectItemV3 } = await import("../listing-pipeline.mjs");

const FUTURE_CLIENT_TIME = "2099-12-31T23:59:59.999Z";

function fakeClient({ existingRaw = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("SELECT 1 FROM accounts")) {
        return { rowCount: 1, rows: [{ exists: 1 }] };
      }
      if (text.includes("SELECT id, payload_hash FROM collect_raw_payloads")) {
        return { rowCount: existingRaw ? 1 : 0, rows: existingRaw ? [existingRaw] : [] };
      }
      if (text.includes("INSERT INTO collect_items")) {
        return { rowCount: 1, rows: [{ id: params[0] }] };
      }
      if (text.includes("SELECT version, data_hash FROM product_drafts")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}

function futureDatedItem(id) {
  return {
    id,
    sku: "trusted-time-sku",
    name: "Trusted time fixture",
    capturedAt: FUTURE_CLIENT_TIME,
    collectedAt: FUTURE_CLIENT_TIME,
    createdAt: FUTURE_CLIENT_TIME,
    raw: {
      sku: "trusted-time-sku",
      capturedAt: FUTURE_CLIENT_TIME,
    },
    listingDraft: {
      sku: "trusted-time-sku",
      title: "Trusted time fixture",
      price: "100.00",
      variants: [],
    },
  };
}

test("client capture time remains traceable in payload but cannot set database business time", async () => {
  const client = fakeClient();
  await mirrorCollectItemV3(futureDatedItem("collect-trusted-time"), {
    client,
    collectId: "collect-trusted-time",
    accountId: "account-trusted-time",
    source: "ozon",
    requestId: "request-trusted-time",
    contentHash: "content-trusted-time",
    captureRaw: true,
  });

  const rawInsert = client.calls.find(({ sql }) => sql.includes("INSERT INTO collect_raw_payloads"));
  assert.ok(rawInsert, "normal ingest must persist one raw payload");
  assert.match(rawInsert.sql, /\$10::jsonb,NOW\(\)\s*\)/);
  assert.doesNotMatch(rawInsert.sql, /\$11/);
  assert.equal(rawInsert.params.length, 10);
  const persistedPayload = JSON.parse(rawInsert.params[9]);
  assert.equal(persistedPayload.source.capturedAt, FUTURE_CLIENT_TIME);
  assert.equal(persistedPayload.normalized.capturedAt, FUTURE_CLIENT_TIME);

  const itemInsert = client.calls.find(({ sql }) => sql.includes("INSERT INTO collect_items"));
  assert.ok(itemInsert, "normal ingest must persist one collection item");
  assert.match(itemInsert.sql, /\$7,NOW\(\),NOW\(\),\$8::jsonb/);
  assert.doesNotMatch(itemInsert.sql, /COALESCE|timestamptz/i);
  assert.equal(itemInsert.params.length, 8);
  assert.equal(itemInsert.params.includes(FUTURE_CLIENT_TIME), false);
});

test("duplicate raw ingest still reuses the existing payload while item upsert uses database time", async () => {
  const client = fakeClient({
    existingRaw: { id: "raw-existing", payload_hash: "content-duplicate" },
  });
  const result = await mirrorCollectItemV3(futureDatedItem("collect-duplicate-time"), {
    client,
    collectId: "collect-duplicate-time",
    accountId: "account-trusted-time",
    source: "ozon",
    requestId: "request-duplicate-time",
    contentHash: "content-duplicate",
    captureRaw: true,
  });

  assert.equal(
    client.calls.filter(({ sql }) => sql.includes("INSERT INTO collect_raw_payloads")).length,
    0,
    "same content hash must not create another raw version",
  );
  const itemInsert = client.calls.find(({ sql }) => sql.includes("INSERT INTO collect_items"));
  assert.match(itemInsert.sql, /\$7,NOW\(\),NOW\(\),\$8::jsonb/);
  assert.equal(result.rawId, "raw-existing");
});

after(() => {
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});
