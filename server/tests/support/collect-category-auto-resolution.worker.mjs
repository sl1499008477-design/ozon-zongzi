import assert from "node:assert/strict";
import crypto from "node:crypto";
import { isolateCollectCategoryE2EEnvironment } from "./collect-category-e2e-environment.mjs";

isolateCollectCategoryE2EEnvironment({ dataDir: process.env.E2E_TEMP_DATA_DIR });
const { createAccountSharedOzonCategoryComposition } = await import("../../account-shared-ozon-category-composition.mjs");
const { createJsonStateTransactionBoundary } = await import("../../json-state-transaction.mjs");
const { postgresEnabled } = await import("../../db/connection.mjs");

const capturedAt = "2026-08-12T00:00:00.000Z";
const category = {
  descriptionCategoryId: 17028702,
  typeIdCandidate: 94405,
  path: ["家居", "杯子"],
  attributes: [{ key: "name", value: "杯子" }],
};
const items = ["collect-a", "collect-b"].map((id, index) => ({
  id,
  accountId: "account-a",
  source: "ozon",
  sourceSku: `offer-${index + 1}`,
  draftVersion: 1,
  listingDraft: { sourceCategory: category },
}));
const state = {
  caches: { collectBox: items },
  collectOzonCategorySourceEvidence: [],
  accountOzonSharedCategories: [],
  accountOzonSharedCategoryEvents: [],
  accountOzonCategoryConfirmations: [],
};
let batchReads = 0;
const composition = createAccountSharedOzonCategoryComposition({
  loadState: async () => state,
  saveState: async () => {},
  persistenceMode: () => "json",
  stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
  collectorAuthRuntime: {
    authenticateRequest: async () => ({ id: "account-a" }),
    authenticateSessionRequest: async () => ({ id: "account-a" }),
  },
  authenticateAccount: async () => ({ id: "account-a", role: "admin" }),
  readJson: async () => ({}),
  sendJson() {},
  sendError() {},
  normalizeItem: (item) => item,
  countAccountItems: () => items.length,
  now: () => new Date(capturedAt),
  randomUUID: (() => { let id = 0; return () => `e2e-${++id}`; })(),
  sleep: async () => {},
  logger: { error() {} },
});
for (const item of items) {
  await composition.accountSharedOzonCategoryRuntime.recordCollectionResult({
    state,
    accountId: "account-a",
    collectItemId: item.id,
    item,
    productDraftId: `draft-${item.id}`,
    productDraftVersion: 1,
    sourceVersion: "draft:1",
    rawResponseRef: `raw-${item.id}`,
    rawResponseHash: crypto.createHash("sha256").update(item.id).digest("hex"),
    capturedAt,
  });
}
batchReads += 1;
const publicRows = await composition.accountSharedOzonCategoryRuntime.readForItems({
  accountId: "account-a",
  collectItemIds: items.map((item) => item.id),
});
assert.equal(publicRows.length, 2);
assert.equal(state.accountOzonSharedCategories.length, 1);
assert.equal(publicRows.every((row) => row.categoryResolution.status === "ACTIVE"), true);
const storeScopedFields = JSON.stringify({
  evidence: state.collectOzonCategorySourceEvidence,
  shared: state.accountOzonSharedCategories,
  publicRows,
}).match(/storeId|credentialStoreId|operatingStoreId/g)?.length || 0;
process.stdout.write(JSON.stringify({
  persistence: postgresEnabled() ? "postgres" : "json",
  items: publicRows.length,
  batchReads,
  sharedSelections: state.accountOzonSharedCategories.length,
  storeScopedFields,
}));
