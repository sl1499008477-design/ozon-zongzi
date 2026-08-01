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
  prepareCollectRequestV4,
  prepareCompleteCollectRequestV4,
  preflightCollectRequestsV4,
} from "../collection-pipeline.mjs";
import { buildOzonEnrichmentSummary } from "../collect-enrichment-policy.mjs";
import { createJsonCollectorOzonEnrichmentRepository } from "../collector-ozon-enrichment-repository.mjs";
import { createJsonStateTransactionBoundary } from "../json-state-transaction.mjs";

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

function jsonHarness(body, { failEnqueue = false, failSave = false } = {}) {
  const state = {
    caches: { collectBox: [] },
    collectRequests: [],
    collectorOzonEnrichmentJobs: [],
  };
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
    loadState: async () => structuredClone(state),
    saveState: async (nextState) => {
      if (failSave) throw new Error("save failed");
      saved += 1;
      const savedState = structuredClone(nextState);
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, savedState);
    },
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    enqueueForCollect: async ({ state: nextState, ...input }) => {
      if (failEnqueue) throw new Error("enqueue failed");
      return createJsonCollectorOzonEnrichmentRepository({ state: nextState }).enqueueForCollect(input);
    },
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

test("batch preflight accepts missing enrichment fields but rejects invalid payload shape", () => {
  const prepared = preflightCollectRequestsV4({
    authenticatedAccount: { id: "preflight-account" },
    source: "ozon",
    inputs: [collectInput({
      sourceSku: "preflight-incomplete",
      requestId: "preflight-incomplete",
      payload: { sku: "preflight-incomplete", name: "Public title" },
    })],
  });
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].prepared.identity.sourceSku, "preflight-incomplete");

  assert.throws(
    () => preflightCollectRequestsV4({
      authenticatedAccount: { id: "preflight-account" },
      source: "ozon",
      inputs: [
        collectInput({ sourceSku: "preflight-valid", requestId: "preflight-valid" }),
        collectInput({ sourceSku: "preflight-invalid", requestId: "preflight-invalid", payload: [] }),
      ],
    }),
    (error) => error?.status === 422 && error?.code === "COLLECT_PAYLOAD_INVALID",
  );
});

test("JSON collection stores public Ozon data with enrichment and one linked pending job", async () => {
  const harness = jsonHarness(collectInput({
    sourceSku: "4862904234",
    requestId: "public-first-a",
    payload: { sku: "4862904234", name: "Public title" },
  }));

  await harness.invoke();

  const data = harness.response.body.data;
  assert.equal(harness.response.status, 200);
  assert.equal(data.name, "Public title");
  assert.deepEqual(data.enrichment, {
    status: "PENDING_ENRICHMENT",
    missingFields: requiredFields,
    attemptCount: 0,
    nextAttemptAt: "",
    lastErrorCode: "",
  });
  assert.deepEqual(harness.state.caches.collectBox[0].enrichment, data.enrichment);
  assert.equal(harness.state.collectorOzonEnrichmentJobs.length, 1);
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].collectItemId, data.id);
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].accountId, "json-account");
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].requestId, "public-first-a");
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].sku, "4862904234");
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].status, "PENDING");
  assert.equal(harness.saved, 1);
});

test("JSON mixed batch preflights every payload shape before writing", async () => {
  const harness = jsonHarness({
    items: [
      collectInput({ sourceSku: "json-batch-valid", requestId: "json-batch-valid" }),
      collectInput({ sourceSku: "json-batch-invalid", requestId: "json-batch-invalid", payload: null }),
    ],
  });

  await harness.invoke("/sources/ozon/collect/batch");

  assert.equal(harness.response.status, 422);
  assert.equal(harness.response.body.code, "COLLECT_PAYLOAD_INVALID");
  assert.equal(harness.normalized, 0);
  assert.equal(harness.saved, 0);
  assert.deepEqual(harness.state.caches.collectBox, []);
  assert.deepEqual(harness.state.collectRequests, []);
  assert.deepEqual(harness.state.collectorOzonEnrichmentJobs, []);
});

test("JSON batch returns public-first enrichment results and replay creates no duplicate item or job", async () => {
  const harness = jsonHarness({
    items: [collectInput({
      sourceSku: "json-batch-public",
      requestId: "json-batch-public-request",
      payload: { sku: "json-batch-public", name: "Batch public title" },
    })],
  });

  await harness.invoke("/sources/ozon/collect/batch");

  assert.equal(harness.response.status, 200);
  assert.deepEqual(harness.response.body.results, [{
    index: 0,
    sku: "json-batch-public",
    action: "created",
    collectItemId: harness.state.caches.collectBox[0].id,
    collectRequestId: harness.state.collectRequests[0].id,
    enrichment: {
      status: "PENDING_ENRICHMENT",
      missingFields: requiredFields,
      attemptCount: 0,
      nextAttemptAt: "",
      lastErrorCode: "",
    },
  }]);
  assert.equal(harness.state.caches.collectBox.length, 1);
  assert.equal(harness.state.collectorOzonEnrichmentJobs.length, 1);

  await harness.invoke("/sources/ozon/collect/batch");
  assert.equal(harness.response.status, 200);
  assert.equal(harness.state.caches.collectBox.length, 1);
  assert.equal(harness.state.collectRequests.length, 1);
  assert.equal(harness.state.collectorOzonEnrichmentJobs.length, 1);
});

test("JSON collection does not save an item or request when linked enqueue fails", async () => {
  const harness = jsonHarness(collectInput({
    sourceSku: "json-enqueue-failure",
    requestId: "json-enqueue-failure-request",
    payload: { sku: "json-enqueue-failure", name: "Public title" },
  }), { failEnqueue: true });

  await harness.invoke();

  assert.equal(harness.response.status, 500);
  assert.equal(harness.saved, 0);
  assert.deepEqual(harness.state.caches.collectBox, []);
  assert.deepEqual(harness.state.collectRequests, []);
  assert.deepEqual(harness.state.collectorOzonEnrichmentJobs, []);
});

test("JSON collection returns no success and keeps prior state when the atomic save fails", async () => {
  const harness = jsonHarness(collectInput({
    sourceSku: "json-save-failure",
    requestId: "json-save-failure-request",
    payload: { sku: "json-save-failure", name: "Public title" },
  }), { failSave: true });

  await harness.invoke();

  assert.equal(harness.response.status, 500);
  assert.equal(harness.saved, 0);
  assert.deepEqual(harness.state.caches.collectBox, []);
  assert.deepEqual(harness.state.collectRequests, []);
  assert.deepEqual(harness.state.collectorOzonEnrichmentJobs, []);
});

test("collection shape and identity validation remain fail closed", () => {
  for (const [input, code] of [
    [{ source: "ozon", sourceSku: "sku", requestId: "request", payload: {} }, "COLLECT_ACCOUNT_REQUIRED"],
    [{ source: "ozon", sourceSku: "", requestId: "request", payload: {} }, "COLLECT_SOURCE_SKU_REQUIRED"],
    [{ source: "ozon", sourceSku: "sku", requestId: "", payload: {} }, "COLLECT_REQUEST_ID_REQUIRED"],
    [{ source: "ozon", sourceSku: "sku", requestId: "request", payload: [] }, "COLLECT_PAYLOAD_INVALID"],
  ]) {
    assert.throws(
      () => prepareCollectRequestV4({
        authenticatedAccount: code === "COLLECT_ACCOUNT_REQUIRED" ? null : { id: "account-a" },
        input,
      }),
      (error) => error?.status === (code === "COLLECT_ACCOUNT_REQUIRED" ? 401 : 422)
        && error?.code === code,
      code,
    );
  }
  assert.throws(
    () => prepareCompleteCollectRequestV4({
      authenticatedAccount: { id: "account-a" },
      input: collectInput({
        sourceSku: "strict-incomplete",
        requestId: "strict-incomplete-request",
        payload: { sku: "strict-incomplete", name: "Public title" },
      }),
    }),
    (error) => error?.status === 422 && error?.code === "OZON_COLLECT_INCOMPLETE",
  );
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
  test("PostgreSQL collection stores public Ozon data and a linked job", { skip: "PostgreSQL is not configured" }, () => {});
} else {
  test("PostgreSQL collection stores public Ozon data and one account-linked job on replay", async () => {
    const suffix = crypto.randomUUID();
    const accountId = `ozon_gate_${suffix}`;
    const sourceSku = `pg-public-${suffix}`;
    const requestId = `pg-public-request-${suffix}`;
    const pool = await getPostgresPool();
    try {
      await runMigrations(pool);
      await pool.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'user','active')",
        [accountId, `ozon-gate-${suffix}`],
      );
      const input = collectInput({
        sourceSku,
        requestId,
        payload: { sku: sourceSku, name: "PostgreSQL public title" },
      });
      const first = await ingestCollectRequestV4({
        authenticatedAccount: { id: accountId },
        input,
      });
      assert.equal(first.item.name, "PostgreSQL public title");
      assert.equal(first.enrichment.status, "PENDING_ENRICHMENT");
      assert.deepEqual(first.enrichment.missingFields, requiredFields);
      assert.deepEqual(first.item.enrichment, first.enrichment);

      const replay = await ingestCollectRequestV4({
        authenticatedAccount: { id: accountId },
        input: structuredClone(input),
      });
      assert.equal(replay.duplicate, true);
      assert.equal(replay.collectItemId, first.collectItemId);
      assert.deepEqual(replay.enrichment, first.enrichment);

      await assert.rejects(
        ingestCollectRequestV4({
          authenticatedAccount: { id: accountId },
          input: { ...input, payload: { ...input.payload, name: "Conflicting public title" } },
        }),
        (error) => error?.status === 409 && error?.code === "COLLECT_REQUEST_CONFLICT",
      );
      const persisted = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM collect_items WHERE account_id=$1) AS item_count,
           (SELECT COUNT(*)::int FROM collect_requests WHERE account_id=$1 AND status='SUCCEEDED') AS request_count,
           (SELECT COUNT(*)::int FROM collector_ozon_enrichment_jobs WHERE account_id=$1) AS job_count`,
        [accountId],
      );
      assert.deepEqual(persisted.rows[0], { item_count: 1, request_count: 1, job_count: 1 });
      const linked = await pool.query(
        `SELECT account_id,collect_item_id,request_id,sku,status,refresh_bundle
           FROM collector_ozon_enrichment_jobs WHERE account_id=$1`,
        [accountId],
      );
      assert.deepEqual(linked.rows[0], {
        account_id: accountId,
        collect_item_id: first.collectItemId,
        request_id: requestId,
        sku: sourceSku,
        status: "PENDING",
        refresh_bundle: {},
      });
    } finally {
      await pool.query("DELETE FROM collector_ozon_enrichment_jobs WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM collect_requests WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM collect_raw_payloads WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM collect_items WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM accounts WHERE id=$1", [accountId]);
      await closePostgresPool();
    }
  });

  test("PostgreSQL linked-job failure rolls back the mirrored item before recording failure", async () => {
    const suffix = crypto.randomUUID();
    const accountId = `ozon_gate_tx_${suffix}`;
    const sourceSku = `pg-tx-public-${suffix}`;
    const requestId = `pg-tx-request-${suffix}`;
    const seedCollectItemId = `pg-tx-seed-${suffix}`;
    const pool = await getPostgresPool();
    try {
      await runMigrations(pool);
      await pool.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'user','active')",
        [accountId, `ozon-gate-tx-${suffix}`],
      );
      await pool.query(
        `INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary)
         VALUES ($1,$2,'ozon',$3,$4,'{}'::jsonb)`,
        [seedCollectItemId, accountId, `seed-identity-${suffix}`, `seed-sku-${suffix}`],
      );
      await pool.query(
        `INSERT INTO collector_ozon_enrichment_jobs (
           id,account_id,collect_item_id,request_id,sku,status,refresh_bundle,
           deadline_at,next_attempt_at,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,'PENDING','{}'::jsonb,'9999-12-31T23:59:59.999Z',NOW(),NOW(),NOW())`,
        [`pg-tx-job-${suffix}`, accountId, seedCollectItemId, requestId, sourceSku],
      );

      await assert.rejects(
        ingestCollectRequestV4({
          authenticatedAccount: { id: accountId },
          input: collectInput({
            sourceSku,
            requestId,
            payload: { sku: sourceSku, name: "Must roll back" },
          }),
        }),
        (error) => error?.status === 409
          && error?.code === "OZON_ENRICHMENT_COLLECT_ITEM_CONFLICT",
      );
      const persisted = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM collect_items WHERE account_id=$1 AND source_sku=$2) AS new_item_count,
           (SELECT COUNT(*)::int FROM collect_raw_payloads WHERE account_id=$1 AND source_sku=$2) AS raw_count,
           (SELECT COUNT(*)::int FROM collect_requests WHERE account_id=$1 AND source_sku=$2 AND status='FAILED') AS failed_count,
           (SELECT COUNT(*)::int FROM collector_ozon_enrichment_jobs WHERE account_id=$1) AS job_count`,
        [accountId, sourceSku],
      );
      assert.deepEqual(persisted.rows[0], {
        new_item_count: 0,
        raw_count: 0,
        failed_count: 1,
        job_count: 1,
      });
    } finally {
      await pool.query("DELETE FROM collector_ozon_enrichment_jobs WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM collect_requests WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM collect_raw_payloads WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM collect_items WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM accounts WHERE id=$1", [accountId]);
      await closePostgresPool();
    }
  });

  test("PostgreSQL mixed batch rejects a later invalid payload shape before any row writes", async () => {
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
            sourceSku: `pg-batch-invalid-${suffix}`,
            requestId: `pg-batch-invalid-${suffix}`,
            payload: null,
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
      assert.equal(body.code, "COLLECT_PAYLOAD_INVALID");
      const persisted = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM collect_items WHERE account_id=$1) AS item_count,
           (SELECT COUNT(*)::int FROM collect_requests WHERE account_id=$1) AS request_count,
           (SELECT COUNT(*)::int FROM collect_requests WHERE account_id=$1 AND status='SUCCEEDED') AS succeeded_count,
           (SELECT COUNT(*)::int FROM collect_requests WHERE account_id=$1 AND status='FAILED') AS failed_count,
           (SELECT COUNT(*)::int FROM collector_ozon_enrichment_jobs WHERE account_id=$1) AS job_count`,
        [accountId],
      );
      assert.deepEqual(persisted.rows[0], {
        item_count: 0,
        request_count: 0,
        succeeded_count: 0,
        failed_count: 0,
        job_count: 0,
      });
    } finally {
      await pool.query("DELETE FROM collector_ozon_enrichment_jobs WHERE account_id=$1", [accountId]);
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
