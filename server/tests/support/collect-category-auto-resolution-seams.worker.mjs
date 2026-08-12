import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isolateCollectCategoryE2EEnvironment } from "./collect-category-e2e-environment.mjs";

isolateCollectCategoryE2EEnvironment({ dataDir: process.env.E2E_TEMP_DATA_DIR });
const mode = String(process.argv[2] || "");
const { createAccountSharedOzonCategoryRuntime } = await import("../../account-shared-ozon-category-runtime.mjs");
const { createAccountSharedOzonCategoryComposition } = await import("../../account-shared-ozon-category-composition.mjs");
const { createJsonAccountScopedCollectionHandler } = await import("../../account-scoped-collection-routes.mjs");
const { createJsonStateTransactionBoundary } = await import("../../json-state-transaction.mjs");

function responseRecorder() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(body = "") { this.body = body ? JSON.parse(String(body)) : null; },
  };
}

async function fastCollect() {
  let evidencePortCalls = 0;
  let storeResolverCalls = 0;
  const state = { caches: { collectBox: [] }, collectRequests: [] };
  const categoryEvidencePort = {
    async recordCollectionResult(input) {
      evidencePortCalls += 1;
      assert.equal(input.state, state);
      assert.equal(Object.hasOwn(input, "storeId"), false);
    },
  };
  const res = responseRecorder();
  const handler = createJsonAccountScopedCollectionHandler({
    authenticate: async () => ({ id: "account-seam" }),
    readJson: async () => ({
      sourceSku: "offer-seam", requestId: "request-seam", capturedAt: "2026-08-12T00:00:00.000Z",
      payload: { name: "杯子", description_category_id: 17028702, type_id: 94405 },
    }),
    normalizeItem: (item) => item,
    loadState: async () => state,
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    enqueueForCollect: async () => {},
    completeLinkedJobsFromCollectEvidence: async () => {},
    sendJson: (target, status, body) => { target.status = status; target.body = body; },
    sendError: (target, status, message, code) => { target.status = status; target.body = { message, code }; },
    countAccountItems: (working) => working.caches.collectBox.length,
    categoryEvidencePort,
    now: () => new Date("2026-08-12T00:00:00.000Z"),
  });
  await handler(
    { method: "POST" },
    res,
    new URL("http://local/sources/ozon/collect"),
    state,
  );
  return { status: res.status, evidencePortCalls, storeResolverCalls };
}

async function fastPatch() {
  let draftUpdates = 0;
  let evidencePortCalls = 0;
  const source = await readFile(new URL("../../index.mjs", import.meta.url), "utf8");
  const patchStart = source.indexOf('if (collectItemMatch && req.method === "PATCH")');
  const patchEnd = source.indexOf('if ((collectItemMatch && req.method === "DELETE")', patchStart);
  const patchBody = source.slice(patchStart, patchEnd);
  assert.doesNotMatch(patchBody, /saveManualFromDraft|recordCollectionResult|beforeCommit/);
  draftUpdates += Number(patchBody.includes("updateCollectItemDraft({"));
  evidencePortCalls += Number(/recordCollectionResult/.test(patchBody));
  return { status: 200, draftUpdates, evidencePortCalls };
}

async function confirmationAuth() {
  const runtime = createAccountSharedOzonCategoryRuntime({
    loadState: async () => ({}), saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    persistenceMode: () => "json",
  });
  let bodyReads = 0;
  const res = responseRecorder();
  const handler = runtime.createHttpHandler({
    authenticate: async () => ({ id: "account-seam", role: "user" }),
    readJson: async () => { bodyReads += 1; return {}; },
    sendJson: (target, status, body) => { target.status = status; target.body = body; },
  });
  await handler({ method: "POST" }, res, new URL("http://local/ozon/category-confirmations"));
  return { status: res.status, code: res.body.code, bodyReads };
}

function overrideValidation() {
  const base = {
    loadState: async () => ({}), saveState: async () => {}, persistenceMode: () => "json",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    collectorAuthRuntime: {
      authenticateRequest: async () => ({ id: "account-seam" }),
      authenticateSessionRequest: async () => ({ id: "account-seam" }),
    },
    authenticateAccount: async () => ({ id: "account-seam", role: "admin" }),
    readJson: async () => ({}), sendJson() {}, sendError() {},
    normalizeItem: (item) => item, countAccountItems: () => 0,
  };
  let invalidOverrides = 0;
  for (const overrides of [{ now: null }, { randomUUID: false }, { sleep: "later" }]) {
    assert.throws(() => createAccountSharedOzonCategoryComposition({ ...base, ...overrides }), /override/i);
    invalidOverrides += 1;
  }
  const composition = createAccountSharedOzonCategoryComposition(base);
  return {
    invalidOverrides,
    hasStoreWake: typeof composition.accountSharedOzonCategoryRuntime.onOperatingStoreAvailable === "function",
    hasTimer: typeof composition.accountSharedOzonCategoryRuntime.start === "function",
  };
}

const result = mode === "fast-collect" ? await fastCollect()
  : mode === "fast-patch" ? await fastPatch()
    : mode === "confirmation-auth" ? await confirmationAuth()
      : mode === "override-validation" ? overrideValidation()
        : (() => { throw new Error(`unknown mode: ${mode}`); })();
process.stdout.write(JSON.stringify(result));
