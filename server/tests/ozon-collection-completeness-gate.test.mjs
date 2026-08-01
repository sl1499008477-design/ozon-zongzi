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
    readJson: async (request) => request?.bodyOverride ?? body,
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
    completeLinkedJobsFromCollectEvidence: async ({ state: nextState, ...input }) => (
      createJsonCollectorOzonEnrichmentRepository({ state: nextState })
        .completeLinkedJobsFromCollectEvidence(input)
    ),
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
    invoke: async (path = "/sources/ozon/collect", bodyOverride) => handler(
      { method: "POST", bodyOverride },
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

test("shared JSON and PostgreSQL preparation strips forged server draft state while retaining exact raw audit evidence", async () => {
  const sourceSku = "forged-server-draft";
  const forgedPayload = {
    sku: sourceSku,
    name: "Public evidence only",
    id: "forged-collect-id",
    status: "COMPLETE",
    draftVersion: 999,
    listingDraft: {
      descriptionCategoryId: 88_000_001,
      sourceCategory: { descriptionCategoryId: 17_000_001 },
      logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
    },
    listing_draft: { forgedAlias: "snake" },
    "listing-draft": { forgedAlias: "kebab" },
    enrichment: { status: "COMPLETE", missingFields: [] },
    draft_version: 998,
    "draft-version": 997,
    raw: { forged: true },
  };
  const input = collectInput({
    sourceSku,
    requestId: "forged-server-draft-request",
    payload: forgedPayload,
  });
  const prepared = prepareCollectRequestV4({
    authenticatedAccount: { id: "prepare-account" },
    input,
  });

  for (const field of [
    "listingDraft",
    "listing_draft",
    "listing-draft",
    "enrichment",
    "draftVersion",
    "draft_version",
    "draft-version",
    "raw",
    "status",
  ]) {
    assert.equal(Object.hasOwn(prepared.normalizedItem, field), false, field);
  }
  assert.notEqual(prepared.normalizedItem.id, "forged-collect-id");
  assert.deepEqual(buildOzonEnrichmentSummary(prepared.normalizedItem), {
    status: "PENDING_ENRICHMENT",
    missingFields: requiredFields,
    attemptCount: 0,
    nextAttemptAt: "",
    lastErrorCode: "",
  });

  const harness = jsonHarness(input);
  await harness.invoke();
  const item = harness.state.caches.collectBox[0];
  assert.equal(item.status === "COMPLETE", false);
  assert.equal(item.listingDraft, undefined);
  assert.equal(item.enrichment.status, "PENDING_ENRICHMENT");
  assert.equal(harness.state.collectorOzonEnrichmentJobs.length, 1);
  assert.deepEqual(item.raw, forgedPayload);
  assert.deepEqual(harness.state.collectRequests[0].rawEvidence.payload, forgedPayload);
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
  assert.deepEqual(harness.response.body.enrichment, data.enrichment);
  assert.deepEqual(harness.state.caches.collectBox[0].enrichment, data.enrichment);
  assert.equal(harness.state.collectorOzonEnrichmentJobs.length, 1);
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].collectItemId, data.id);
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].accountId, "json-account");
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].requestId, "public-first-a");
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].sku, "4862904234");
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].status, "PENDING");
  assert.equal(harness.saved, 1);
});

test("JSON pending canonical item becomes complete and atomically supersedes its active linked job", async () => {
  const sourceSku = "json-pending-to-complete";
  const harness = jsonHarness(collectInput({
    sourceSku,
    requestId: "json-pending-to-complete-a",
    payload: { sku: sourceSku, name: "Public evidence first" },
  }));
  await harness.invoke();
  harness.state.collectorOzonEnrichmentJobs[0] = {
    ...harness.state.collectorOzonEnrichmentJobs[0],
    status: "PROCESSING",
    claimedSessionId: "collector-stale-after-recollect",
    claimExpiresAt: "2099-08-01T08:01:00.000Z",
    claimFence: "claim-stale-after-recollect",
    attemptCount: 2,
  };
  harness.state.caches.collectBox[0].listingDraft = {
    title: "Manual title survives public completion",
    logistics: { weightG: 777, lengthMm: "", widthMm: "", heightMm: "" },
  };
  harness.state.caches.collectBox[0].draftVersion = 4;

  await harness.invoke("/sources/ozon/collect", collectInput({
    sourceSku,
    requestId: "json-pending-to-complete-b",
    payload: {
      ...completeOzonPayload(),
      sku: sourceSku,
      name: "Complete public evidence",
    },
  }));

  assert.equal(harness.response.status, 200);
  assert.deepEqual(harness.response.body.enrichment, {
    status: "COMPLETE",
    missingFields: [],
    attemptCount: 0,
    nextAttemptAt: "",
    lastErrorCode: "",
  });
  assert.deepEqual(harness.state.caches.collectBox[0].enrichment, harness.response.body.enrichment);
  assert.equal(harness.state.caches.collectBox[0].status, "COMPLETE");
  assert.deepEqual(harness.state.caches.collectBox[0].listingDraft, {
    title: "Manual title survives public completion",
    logistics: { weightG: 777, lengthMm: 300, widthMm: 200, heightMm: 100 },
    sourceCategory: { descriptionCategoryId: 17_000_001 },
  });
  assert.equal(harness.state.caches.collectBox[0].draftVersion, 5);
  assert.equal(harness.state.collectorOzonEnrichmentJobs.length, 1);
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].status, "SUCCESS");
  assert.deepEqual(harness.state.collectorOzonEnrichmentJobs[0].result, {
    status: "COMPLETE",
    source: "COLLECTED_PUBLIC_EVIDENCE",
  });
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].claimedSessionId, null);
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].claimExpiresAt, null);
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].claimFence, null);
});

test("JSON same account/source/SKU with a new request keeps the canonical completed item and request audit", async () => {
  const sourceSku = "json-canonical-complete";
  const firstInput = collectInput({
    sourceSku,
    requestId: "json-canonical-request-a",
    payload: { sku: sourceSku, name: "First public title" },
  });
  const harness = jsonHarness(firstInput);
  await harness.invoke();

  const originalId = harness.state.caches.collectBox[0].id;
  harness.state.caches.collectBox[0] = {
    ...harness.state.caches.collectBox[0],
    name: "Manually curated title",
    status: "COMPLETE",
    draftVersion: 9,
    listingDraft: {
      title: "Manual listing title",
      descriptionCategoryId: 880001,
      typeId: 990001,
      sourceCategory: { descriptionCategoryId: 17_000_001 },
      logistics: { weightG: 610, lengthMm: 310, widthMm: 210, heightMm: 110 },
    },
    enrichment: {
      status: "COMPLETE",
      missingFields: [],
      attemptCount: 2,
      nextAttemptAt: "",
      lastErrorCode: "",
    },
  };
  harness.state.collectorOzonEnrichmentJobs[0].status = "SUCCESS";
  harness.state.collectorOzonEnrichmentJobs[0].result = { status: "COMPLETE" };

  await harness.invoke("/sources/ozon/collect", collectInput({
    sourceSku,
    requestId: "json-canonical-request-b",
    payload: {
      sku: sourceSku,
      name: "Replacement public title must not overwrite manual data",
      publicEvidenceAddedLater: "safe-new-evidence",
    },
  }));

  assert.equal(harness.response.status, 200);
  assert.equal(harness.state.caches.collectBox.length, 1);
  const item = harness.state.caches.collectBox[0];
  assert.equal(item.id, originalId);
  assert.equal(item.name, "Manually curated title");
  assert.equal(item.publicEvidenceAddedLater, "safe-new-evidence");
  assert.equal(item.status, "COMPLETE");
  assert.equal(item.draftVersion, 9);
  assert.deepEqual(item.listingDraft, {
    title: "Manual listing title",
    descriptionCategoryId: 880001,
    typeId: 990001,
    sourceCategory: { descriptionCategoryId: 17_000_001 },
    logistics: { weightG: 610, lengthMm: 310, widthMm: 210, heightMm: 110 },
  });
  assert.equal(harness.state.collectorOzonEnrichmentJobs.length, 1);
  assert.equal(harness.state.collectorOzonEnrichmentJobs[0].status, "SUCCESS");
  assert.equal(harness.state.collectRequests.length, 2);
  assert.deepEqual(new Set(
    harness.state.collectRequests.map((request) => request.sourceRequestId),
  ), new Set(["json-canonical-request-a", "json-canonical-request-b"]));
  assert.equal(harness.state.collectRequests.every(
    (request) => request.response.item.id === originalId,
  ), true);
});

test("JSON collection isolates server lifecycle fields while retaining request-scoped raw evidence", async () => {
  const sourceSku = "json-server-owned-fields";
  const firstPayload = {
    sku: sourceSku,
    name: "First public evidence",
    status: "DELETED",
    createdAt: "2000-01-01T00:00:00.000Z",
    created_at: "2000-01-01T00:00:01.000Z",
    "created-at": "2000-01-01T00:00:02.000Z",
    updatedAt: "2000-01-02T00:00:00.000Z",
    updated_at: "2000-01-02T00:00:01.000Z",
    "updated-at": "2000-01-02T00:00:02.000Z",
    deletedAt: "2026-08-01T00:00:00.000Z",
    draftVersion: 999,
    listingJobId: "forged-job",
    listingResult: { forged: true },
    pipelineVersion: "forged-pipeline",
  };
  const harness = jsonHarness(collectInput({
    sourceSku,
    requestId: "json-owned-a",
    payload: firstPayload,
  }));
  await harness.invoke();

  const first = harness.state.caches.collectBox[0];
  for (const field of [
    "deletedAt",
    "createdAt",
    "created_at",
    "created-at",
    "updatedAt",
    "updated_at",
    "updated-at",
    "draftVersion",
    "listingJobId",
    "listingResult",
    "pipelineVersion",
  ]) assert.equal(Object.hasOwn(first, field), false, field);
  assert.notEqual(first.status, "DELETED");
  assert.deepEqual(first.raw, firstPayload);

  first.status = "COMPLETE";
  first.draftVersion = 4;
  first.listingDraft = { title: "Manual draft" };
  const secondPayload = {
    sku: sourceSku,
    name: "Second evidence cannot replace manual title",
    publicEvidenceAddedLater: "traceable",
    status: "FAILED",
    deletedAt: "2026-08-02T00:00:00.000Z",
    listingTaskId: "forged-task",
  };
  await harness.invoke("/sources/ozon/collect", collectInput({
    sourceSku,
    requestId: "json-owned-b",
    payload: secondPayload,
  }));

  const canonical = harness.state.caches.collectBox[0];
  assert.equal(canonical.status, "COMPLETE");
  assert.equal(canonical.draftVersion, 4);
  assert.deepEqual(canonical.listingDraft, { title: "Manual draft" });
  assert.equal(canonical.publicEvidenceAddedLater, "traceable");
  assert.equal(Object.hasOwn(canonical, "deletedAt"), false);
  assert.equal(Object.hasOwn(canonical, "listingTaskId"), false);
  assert.deepEqual(canonical.raw, firstPayload);
  assert.deepEqual(
    harness.state.collectRequests.map((request) => ({
      requestId: request.sourceRequestId,
      collectItemId: request.rawEvidence?.collectItemId,
      payload: request.rawEvidence?.payload,
    })),
    [
      { requestId: "json-owned-a", collectItemId: canonical.id, payload: firstPayload },
      { requestId: "json-owned-b", collectItemId: canonical.id, payload: secondPayload },
    ],
  );
});

test("JSON identical replay ignores every spelling of volatile lifecycle fields and retains exact first raw evidence", async () => {
  const sourceSku = "json-volatile-alias-replay";
  const firstPayload = {
    sku: sourceSku,
    name: "Stable public evidence",
    createdAt: "2000-01-01T00:00:00.000Z",
    created_at: "2000-01-01T00:00:01.000Z",
    "created-at": "2000-01-01T00:00:02.000Z",
    updatedAt: "2000-01-02T00:00:00.000Z",
    updated_at: "2000-01-02T00:00:01.000Z",
    "updated-at": "2000-01-02T00:00:02.000Z",
    scraped_at: "2000-01-03T00:00:00.000Z",
    "saved-at": "2000-01-04T00:00:00.000Z",
    listing_submitted_at: "2000-01-05T00:00:00.000Z",
    "listing-completed-at": "2000-01-06T00:00:00.000Z",
    listing_last_error_at: "2000-01-07T00:00:00.000Z",
  };
  const harness = jsonHarness(collectInput({
    sourceSku,
    requestId: "json-volatile-alias-request",
    payload: firstPayload,
  }));
  await harness.invoke();

  const replayPayload = {
    ...firstPayload,
    createdAt: "2099-01-01T00:00:00.000Z",
    created_at: "2099-01-01T00:00:01.000Z",
    "created-at": "2099-01-01T00:00:02.000Z",
    updatedAt: "2099-01-02T00:00:00.000Z",
    updated_at: "2099-01-02T00:00:01.000Z",
    "updated-at": "2099-01-02T00:00:02.000Z",
    scraped_at: "2099-01-03T00:00:00.000Z",
    "saved-at": "2099-01-04T00:00:00.000Z",
    listing_submitted_at: "2099-01-05T00:00:00.000Z",
    "listing-completed-at": "2099-01-06T00:00:00.000Z",
    listing_last_error_at: "2099-01-07T00:00:00.000Z",
  };
  await harness.invoke("/sources/ozon/collect", collectInput({
    sourceSku,
    requestId: "json-volatile-alias-request",
    payload: replayPayload,
  }));

  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.data.duplicate, true);
  assert.equal(harness.state.collectRequests.length, 1);
  assert.deepEqual(harness.state.collectRequests[0].rawEvidence.payload, firstPayload);
  assert.deepEqual(harness.state.caches.collectBox[0].raw, firstPayload);
});

test("JSON same SKU new requests reuse one active enrichment job instead of replacing its lease", async () => {
  const sourceSku = "json-canonical-active";
  const harness = jsonHarness(collectInput({
    sourceSku,
    requestId: "json-active-request-a",
    payload: { sku: sourceSku, name: "First evidence" },
  }));
  await harness.invoke();
  harness.state.collectorOzonEnrichmentJobs[0] = {
    ...harness.state.collectorOzonEnrichmentJobs[0],
    status: "PROCESSING",
    claimedSessionId: "collector-live",
    claimExpiresAt: "2099-08-01T08:01:00.000Z",
    attemptCount: 2,
  };
  const originalJob = structuredClone(harness.state.collectorOzonEnrichmentJobs[0]);

  await Promise.all([
    harness.invoke("/sources/ozon/collect", collectInput({
      sourceSku,
      requestId: "json-active-request-b",
      payload: { sku: sourceSku, name: "Second evidence" },
    })),
    harness.invoke("/sources/ozon/collect", collectInput({
      sourceSku,
      requestId: "json-active-request-c",
      payload: { sku: sourceSku, name: "Third evidence" },
    })),
  ]);

  assert.equal(harness.state.caches.collectBox.length, 1);
  assert.equal(harness.state.collectorOzonEnrichmentJobs.length, 1);
  assert.deepEqual(harness.state.collectorOzonEnrichmentJobs[0], originalJob);
  assert.equal(harness.state.collectRequests.length, 3);
});

test("JSON historical success replay derives complete and pending enrichment without rewriting history or creating jobs", async () => {
  for (const fixture of [
    {
      sku: "json-history-complete",
      requestId: "json-history-complete-request",
      payload: {
        ...completeOzonPayload(),
        sku: "json-history-complete",
        name: "Historical complete",
      },
      expected: {
        status: "COMPLETE",
        missingFields: [],
        attemptCount: 0,
        nextAttemptAt: "",
        lastErrorCode: "",
      },
    },
    {
      sku: "json-history-pending",
      requestId: "json-history-pending-request",
      payload: { sku: "json-history-pending", name: "Historical pending" },
      expected: {
        status: "PENDING_ENRICHMENT",
        missingFields: requiredFields,
        attemptCount: 0,
        nextAttemptAt: "",
        lastErrorCode: "",
      },
    },
  ]) {
    const input = collectInput({
      sourceSku: fixture.sku,
      requestId: fixture.requestId,
      payload: fixture.payload,
    });
    const harness = jsonHarness(input);
    await harness.invoke();

    delete harness.state.caches.collectBox[0].enrichment;
    delete harness.state.collectRequests[0].response.enrichment;
    delete harness.state.collectRequests[0].response.item.enrichment;
    harness.state.collectorOzonEnrichmentJobs = [];

    await harness.invoke();

    assert.equal(harness.response.status, 200, fixture.sku);
    assert.equal(harness.response.body.data.duplicate, true, fixture.sku);
    assert.deepEqual(harness.response.body.data.enrichment, fixture.expected, fixture.sku);
    assert.deepEqual(harness.response.body.enrichment, fixture.expected, fixture.sku);
    assert.equal(Object.hasOwn(harness.state.caches.collectBox[0], "enrichment"), false, fixture.sku);
    assert.equal(
      Object.hasOwn(harness.state.collectRequests[0].response.item, "enrichment"),
      false,
      fixture.sku,
    );
    assert.equal(harness.state.collectorOzonEnrichmentJobs.length, 0, fixture.sku);
  }
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
  assert.deepEqual(first.state.caches.collectBox[0].listingDraft.logistics, {
    weightG: 500,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 100,
  });
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
      const concurrentRequestId = `${requestId}-concurrent`;
      const [first, concurrent] = await Promise.all([
        ingestCollectRequestV4({
          authenticatedAccount: { id: accountId },
          input,
        }),
        ingestCollectRequestV4({
          authenticatedAccount: { id: accountId },
          input: { ...input, requestId: concurrentRequestId },
        }),
      ]);
      assert.equal(first.item.name, "PostgreSQL public title");
      assert.equal(first.enrichment.status, "PENDING_ENRICHMENT");
      assert.deepEqual(first.enrichment.missingFields, requiredFields);
      assert.deepEqual(first.item.enrichment, first.enrichment);
      assert.equal(concurrent.duplicate, false);
      assert.equal(concurrent.collectItemId, first.collectItemId);
      assert.deepEqual(concurrent.enrichment, first.enrichment);

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
      assert.deepEqual(persisted.rows[0], { item_count: 1, request_count: 2, job_count: 1 });
      const linked = await pool.query(
        `SELECT account_id,collect_item_id,request_id,sku,status,refresh_bundle
           FROM collector_ozon_enrichment_jobs WHERE account_id=$1`,
        [accountId],
      );
      assert.equal(linked.rows[0].account_id, accountId);
      assert.equal(linked.rows[0].collect_item_id, first.collectItemId);
      assert.equal(new Set([requestId, concurrentRequestId]).has(linked.rows[0].request_id), true);
      assert.equal(linked.rows[0].sku, sourceSku);
      assert.equal(linked.rows[0].status, "PENDING");
      assert.deepEqual(linked.rows[0].refresh_bundle, {});

      const completed = await ingestCollectRequestV4({
        authenticatedAccount: { id: accountId },
        input: collectInput({
          sourceSku,
          requestId: `${requestId}-complete`,
          payload: {
            ...completeOzonPayload(),
            sku: sourceSku,
            name: "PostgreSQL complete public evidence",
          },
        }),
      });
      assert.equal(completed.collectItemId, first.collectItemId);
      assert.deepEqual(completed.enrichment, {
        status: "COMPLETE",
        missingFields: [],
        attemptCount: 0,
        nextAttemptAt: "",
        lastErrorCode: "",
      });
      assert.equal(completed.item.status, "COMPLETE");
      assert.deepEqual(completed.item.listingDraft.logistics, {
        weightG: 500,
        lengthMm: 300,
        widthMm: 200,
        heightMm: 100,
      });
      assert.deepEqual(completed.item.listingDraft.sourceCategory, {
        descriptionCategoryId: 17_000_001,
      });
      const completedItem = await pool.query(
        `SELECT c.status,c.summary->'enrichment' AS enrichment,d.data AS draft_data
           FROM collect_items c
           LEFT JOIN product_drafts d ON d.id=c.current_draft_id
          WHERE c.id=$1 AND c.account_id=$2`,
        [first.collectItemId, accountId],
      );
      assert.equal(completedItem.rows[0].status, "COMPLETE");
      assert.equal(completedItem.rows[0].enrichment.status, "COMPLETE");
      assert.deepEqual(completedItem.rows[0].draft_data.logistics, {
        weightG: 500,
        lengthMm: 300,
        widthMm: 200,
        heightMm: 100,
      });
      const completedJobs = await pool.query(
        `SELECT status,result_json,claimed_session_id,claim_expires_at,claim_fence
           FROM collector_ozon_enrichment_jobs
          WHERE account_id=$1 AND collect_item_id=$2`,
        [accountId, first.collectItemId],
      );
      assert.equal(completedJobs.rows.length, 1);
      assert.equal(completedJobs.rows[0].status, "SUCCESS");
      assert.deepEqual(completedJobs.rows[0].result_json, {
        status: "COMPLETE",
        source: "COLLECTED_PUBLIC_EVIDENCE",
      });
      assert.equal(completedJobs.rows[0].claimed_session_id, null);
      assert.equal(completedJobs.rows[0].claim_expires_at, null);
      assert.equal(completedJobs.rows[0].claim_fence, null);

      const terminalHistorySku = `pg-terminal-history-${suffix}`;
      const terminalFirst = await ingestCollectRequestV4({
        authenticatedAccount: { id: accountId },
        input: collectInput({
          sourceSku: terminalHistorySku,
          requestId: `${requestId}-terminal-a`,
          payload: { sku: terminalHistorySku, name: "Terminal history first" },
        }),
      });
      await pool.query(
        `UPDATE collector_ozon_enrichment_jobs
            SET status='FAILED',error_json='{"code":"OZON_TEST_TERMINAL"}'::jsonb,
                completed_at=NOW(),updated_at=NOW()
          WHERE account_id=$1 AND collect_item_id=$2 AND status='PENDING'`,
        [accountId, terminalFirst.collectItemId],
      );
      const terminalSecond = await ingestCollectRequestV4({
        authenticatedAccount: { id: accountId },
        input: collectInput({
          sourceSku: terminalHistorySku,
          requestId: `${requestId}-terminal-b`,
          payload: { sku: terminalHistorySku, name: "Terminal history second" },
        }),
      });
      assert.equal(terminalSecond.enrichment.status, "PENDING_ENRICHMENT");
      const terminalHistoryJobs = await pool.query(
        `SELECT status FROM collector_ozon_enrichment_jobs
          WHERE account_id=$1 AND collect_item_id=$2
          ORDER BY created_at,id`,
        [accountId, terminalFirst.collectItemId],
      );
      assert.deepEqual(
        terminalHistoryJobs.rows.map((row) => row.status),
        ["FAILED", "PENDING"],
      );
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
