import assert from "node:assert/strict";
import test, { after } from "node:test";

const previousDatabaseUrl = process.env.DATABASE_URL;
const previousPipelineFlag = process.env.LISTING_PIPELINE_V3;
process.env.LISTING_PIPELINE_V3 = "1";
process.env.DATABASE_URL = "postgres://query-contract.invalid/test";
const { buildCollectItemDraftV4, mirrorCollectItemV3 } = await import("../listing-pipeline.mjs");

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
      if (text.includes("SELECT version, data_hash, data FROM product_drafts")) {
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

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).reverse().map((key) => [key, reverseObjectKeys(value[key])]),
  );
}

function existingDraftClient(storedDraft) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT 1 FROM accounts")) {
        return { rowCount: 1, rows: [{ exists: 1 }] };
      }
      if (normalized.startsWith("SELECT id, payload_hash FROM collect_raw_payloads")) {
        return { rowCount: 1, rows: [{ id: "raw-canonical-order", payload_hash: "same-content" }] };
      }
      if (normalized.startsWith("INSERT INTO collect_items")) {
        return { rowCount: 1, rows: [{ id: params[0] }] };
      }
      if (normalized.startsWith("SELECT version, data_hash")) {
        return {
          rowCount: 1,
          rows: [{
            version: 2,
            data_hash: "legacy-order-dependent-hash",
            ...(normalized.startsWith("SELECT version, data_hash, data")
              ? { data: storedDraft }
              : {}),
          }],
        };
      }
      return { rowCount: 1, rows: [] };
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

test("equivalent product draft key order does not create a new draft version", async () => {
  const item = {
    id: "collect-canonical-order",
    sku: "sku-canonical-order",
    name: "Canonical order fixture",
    listingDraft: {
      sku: "sku-canonical-order",
      title: "Canonical order fixture",
      price: "100.00",
      sourceCategory: {
        typeName: "电动工具备件",
        attributes: [{ key: "8229", value: "电动工具备件", dictionary_value_id: 94891 }],
        typeIdCandidate: 94891,
        descriptionCategoryId: 76525013,
      },
      variants: [],
    },
  };
  const client = existingDraftClient(reverseObjectKeys(buildCollectItemDraftV4(item)));

  const result = await mirrorCollectItemV3(item, {
    client,
    collectId: item.id,
    accountId: "account-canonical-order",
    contentHash: "same-content",
    captureRaw: false,
  });

  assert.equal(result.version, 2);
  assert.equal(result.changed, false);
  assert.equal(
    client.calls.some(({ sql }) => sql.startsWith("UPDATE product_drafts SET")),
    false,
  );
});

after(() => {
  if (previousPipelineFlag === undefined) delete process.env.LISTING_PIPELINE_V3;
  else process.env.LISTING_PIPELINE_V3 = previousPipelineFlag;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});
