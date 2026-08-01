import "../env.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createJsonAccountScopedCollectionHandler } from "../account-scoped-collection-routes.mjs";
import {
  closePostgresPool,
  getPostgresPool,
  postgresEnabled,
} from "../db/connection.mjs";
import { runMigrations } from "../db/migrate.mjs";
import {
  ingestCollectRequestV4,
  preflightCompleteCollectRequestsV4,
} from "../collection-pipeline.mjs";
import { buildOzonEnrichmentSummary } from "../collect-enrichment-policy.mjs";

const requiredFields = Object.freeze([
  "descriptionCategoryId",
  "weightG",
  "lengthMm",
  "widthMm",
  "heightMm",
]);

function completeOzonPayload() {
  return {
    sku: "ozon-complete-sku",
    name: "Complete Ozon item",
    descriptionCategoryId: 17000001,
    logistics: {
      weightG: 500,
      lengthMm: 300,
      widthMm: 200,
      heightMm: 100,
    },
  };
}

function withoutRequiredField(field) {
  const payload = completeOzonPayload();
  if (field === "descriptionCategoryId") delete payload.descriptionCategoryId;
  else delete payload.logistics[field];
  return payload;
}

function collectInput({ source = "ozon", sourceSku = "ozon-complete-sku", requestId = "ozon-request", payload = completeOzonPayload() } = {}) {
  return {
    source,
    sourceSku,
    sourceUrl: `https://example.test/${sourceSku}`,
    requestId,
    capturedAt: "2026-07-31T00:00:00.000Z",
    payload,
  };
}

function jsonHarness(body) {
  const state = { caches: { collectBox: [] }, collectRequests: [] };
  let normalized = 0;
  let saved = 0;
  const response = {};
  const handler = createJsonAccountScopedCollectionHandler({
    authenticate: async () => ({ id: "json-account" }),
    readJson: async () => body,
    normalizeItem: (item) => {
      normalized += 1;
      return item;
    },
    saveState: async () => { saved += 1; },
    sendJson: (_res, status, data) => { response.status = status; response.body = data; },
    sendError: (_res, status, message, code, details = {}) => {
      response.status = status;
      response.body = { ok: false, message, code, ...details };
    },
    countAccountItems: (nextState, account) => nextState.caches.collectBox
      .filter((item) => item.accountId === account.id),
  });
  return {
    state,
    response,
    get normalized() { return normalized; },
    get saved() { return saved; },
    invoke: async (path = "/sources/ozon/collect") => handler(
      { method: "POST" },
      {},
      new URL(`http://localhost${path}`),
      state,
    ),
  };
}

test("incomplete Ozon payload is collectible but pending enrichment", () => {
  assert.deepEqual(buildOzonEnrichmentSummary({
    sku: "4862904234",
    name: "Public title",
  }), {
    status: "PENDING_ENRICHMENT",
    missingFields: ["descriptionCategoryId", "weightG", "lengthMm", "widthMm", "heightMm"],
    attemptCount: 0,
    nextAttemptAt: "",
    lastErrorCode: "",
  });
});

test("batch preflight rejects a later incomplete Ozon item before yielding any prepared request", () => {
  assert.throws(
    () => preflightCompleteCollectRequestsV4({
      authenticatedAccount: { id: "preflight-account" },
      source: "ozon",
      inputs: [
        collectInput({ sourceSku: "preflight-valid", requestId: "preflight-valid" }),
        collectInput({
          sourceSku: "preflight-incomplete",
          requestId: "preflight-incomplete",
          payload: withoutRequiredField("heightMm"),
        }),
      ],
    }),
    (error) => error?.status === 422
      && error?.code === "OZON_COLLECT_INCOMPLETE"
      && assert.deepEqual(error.missingFields, ["heightMm"]) === undefined,
  );
});

test("JSON collection rejects each missing Ozon completeness field before normalization or state writes", async () => {
  for (const field of requiredFields) {
    const harness = jsonHarness(collectInput({
      sourceSku: `json-incomplete-${field}`,
      requestId: `json-incomplete-${field}`,
      payload: withoutRequiredField(field),
    }));

    await harness.invoke();

    assert.equal(harness.response.status, 422, field);
    assert.equal(harness.response.body.code, "OZON_COLLECT_INCOMPLETE", field);
    assert.deepEqual(harness.response.body.missingFields, [field], field);
    assert.equal(harness.normalized, 0, `${field} must not reach normalization`);
    assert.equal(harness.saved, 0, `${field} must not save state`);
    assert.deepEqual(harness.state.caches.collectBox, [], field);
    assert.deepEqual(harness.state.collectRequests, [], field);
  }
});

test("JSON mixed batch rejects an incomplete later Ozon item with no prior-item state write", async () => {
  const harness = jsonHarness({
    items: [
      collectInput({ sourceSku: "json-batch-valid", requestId: "json-batch-valid" }),
      collectInput({
        sourceSku: "json-batch-incomplete",
        requestId: "json-batch-incomplete",
        payload: withoutRequiredField("widthMm"),
      }),
    ],
  });

  await harness.invoke("/sources/ozon/collect/batch");

  assert.equal(harness.response.status, 422);
  assert.equal(harness.response.body.code, "OZON_COLLECT_INCOMPLETE");
  assert.deepEqual(harness.response.body.missingFields, ["widthMm"]);
  assert.equal(harness.normalized, 0);
  assert.equal(harness.saved, 0);
  assert.deepEqual(harness.state.caches.collectBox, []);
  assert.deepEqual(harness.state.collectRequests, []);
});

test("JSON collection preserves complete Ozon idempotency, conflicts, and incomplete 1688 behavior", async () => {
  const input = collectInput({ sourceSku: "json-complete", requestId: "json-complete-request" });
  const first = jsonHarness(input);
  await first.invoke();
  assert.equal(first.response.status, 200);
  assert.equal(first.response.body.data.duplicate, false);
  assert.equal(first.state.caches.collectBox.length, 1);
  assert.equal(first.state.collectRequests[0].status, "SUCCEEDED");

  const repeated = jsonHarness(input);
  repeated.state.caches.collectBox = structuredClone(first.state.caches.collectBox);
  repeated.state.collectRequests = structuredClone(first.state.collectRequests);
  await repeated.invoke();
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.response.body.data.duplicate, true);
  assert.equal(repeated.state.caches.collectBox.length, 1);
  assert.equal(repeated.state.collectRequests.length, 1);

  const conflicting = jsonHarness(collectInput({
    sourceSku: "json-complete",
    requestId: "json-complete-request",
    payload: { ...completeOzonPayload(), name: "Conflicting complete Ozon item" },
  }));
  conflicting.state.caches.collectBox = structuredClone(first.state.caches.collectBox);
  conflicting.state.collectRequests = structuredClone(first.state.collectRequests);
  await conflicting.invoke();
  assert.equal(conflicting.response.status, 409);
  assert.equal(conflicting.response.body.code, "COLLECT_REQUEST_CONFLICT");
  assert.equal(conflicting.state.caches.collectBox.length, 1);
  assert.equal(conflicting.state.collectRequests[0].status, "SUCCEEDED");

  const nonOzon = jsonHarness(collectInput({
    source: "1688",
    sourceSku: "json-1688-incomplete",
    requestId: "json-1688-incomplete-request",
    payload: { sku: "json-1688-incomplete" },
  }));
  await nonOzon.invoke();
  assert.equal(nonOzon.response.status, 200);
  assert.equal(nonOzon.state.caches.collectBox.length, 1);
  assert.equal(nonOzon.state.collectRequests[0].status, "SUCCEEDED");
});

if (!postgresEnabled()) {
  test("PostgreSQL collection rejects incomplete Ozon payloads before writes", { skip: "PostgreSQL is not configured" }, () => {});
} else {
  test("PostgreSQL collection rejects each missing Ozon completeness field before request or item writes", async () => {
    const suffix = crypto.randomUUID();
    const accountId = `ozon_gate_${suffix}`;
    const pool = await getPostgresPool();
    try {
      await runMigrations(pool);
      await pool.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'user','active')",
        [accountId, `ozon-gate-${suffix}`],
      );
      for (const field of requiredFields) {
        const sourceSku = `pg-incomplete-${field}-${suffix}`;
        await assert.rejects(
          ingestCollectRequestV4({
            authenticatedAccount: { id: accountId },
            input: collectInput({
              sourceSku,
              requestId: `pg-incomplete-${field}-${suffix}`,
              payload: withoutRequiredField(field),
            }),
          }),
          (error) => error?.status === 422
            && error?.code === "OZON_COLLECT_INCOMPLETE"
            && assert.deepEqual(error.missingFields, [field]) === undefined,
          field,
        );
        const persisted = await pool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM collect_items WHERE account_id=$1) AS item_count,
             (SELECT COUNT(*)::int FROM collect_requests WHERE account_id=$1) AS request_count,
             (SELECT COUNT(*)::int FROM collect_requests WHERE account_id=$1 AND status='SUCCEEDED') AS succeeded_count`,
          [accountId],
        );
        assert.deepEqual(persisted.rows[0], {
          item_count: 0,
          request_count: 0,
          succeeded_count: 0,
        }, field);
      }
    } finally {
      await pool.query("DELETE FROM collect_requests WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM collect_raw_payloads WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM collect_items WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM accounts WHERE id=$1", [accountId]);
      await closePostgresPool();
    }
  });

  test("PostgreSQL mixed batch rejects an incomplete later Ozon item before any row writes", async () => {
    const suffix = crypto.randomUUID();
    const accountId = `ozon_gate_batch_${suffix}`;
    const collectorToken = `ozon-gate-batch-${suffix}`;
    const parentSessionToken = `ozon-gate-parent-${suffix}`;
    const pool = await getPostgresPool();
    try {
      await runMigrations(pool);
      await pool.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'user','active')",
        [accountId, `ozon-gate-batch-${suffix}`],
      );
      await pool.query("INSERT INTO sessions (token,account_id) VALUES ($1,$2)", [parentSessionToken, accountId]);
      await pool.query(
        `INSERT INTO collector_sessions (
           id,token_hash,account_id,parent_session_token,device_fingerprint,extension_version,permissions,expires_at
         ) VALUES ($1,$2,$3,$4,'ozon-gate-device','test',$5::jsonb,NOW() + INTERVAL '1 hour')`,
        [
          `ozon-gate-session-${suffix}`,
          crypto.createHash("sha256").update(collectorToken).digest("hex"),
          accountId,
          parentSessionToken,
          JSON.stringify(["collector.upload"]),
        ],
      );
      const { Readable } = await import("node:stream");
      const request = Readable.from([Buffer.from(JSON.stringify({
        items: [
          collectInput({ sourceSku: `pg-batch-valid-${suffix}`, requestId: `pg-batch-valid-${suffix}` }),
          collectInput({
            sourceSku: `pg-batch-incomplete-${suffix}`,
            requestId: `pg-batch-incomplete-${suffix}`,
            payload: withoutRequiredField("lengthMm"),
          }),
        ],
      }))]);
      request.method = "POST";
      request.url = "/sources/ozon/collect/batch";
      request.headers = {
        authorization: `Collector ${collectorToken}`,
        "content-type": "application/json",
      };
      const response = {
        status: 0,
        body: "",
        writeHead(status) { this.status = status; },
        end(body = "") { this.body = String(body); },
      };
      process.env.QH_LOCAL_NO_LISTEN = "1";
      const { handle } = await import("../index.mjs");
      await handle(request, response);
      const body = JSON.parse(response.body);
      assert.equal(response.status, 422);
      assert.equal(body.code, "OZON_COLLECT_INCOMPLETE");
      assert.deepEqual(body.missingFields, ["lengthMm"]);
      const persisted = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM collect_items WHERE account_id=$1) AS item_count,
           (SELECT COUNT(*)::int FROM collect_requests WHERE account_id=$1) AS request_count,
           (SELECT COUNT(*)::int FROM collect_requests WHERE account_id=$1 AND status='SUCCEEDED') AS succeeded_count,
           (SELECT COUNT(*)::int FROM collect_requests WHERE account_id=$1 AND status='FAILED') AS failed_count`,
        [accountId],
      );
      assert.deepEqual(persisted.rows[0], {
        item_count: 0,
        request_count: 0,
        succeeded_count: 0,
        failed_count: 0,
      });
    } finally {
      await pool.query("DELETE FROM collector_sessions WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM sessions WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM collect_requests WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM collect_raw_payloads WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM collect_items WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM accounts WHERE id=$1", [accountId]);
      await closePostgresPool();
    }
  });
}
