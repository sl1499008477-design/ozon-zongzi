import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  createJsonCollectCategoryResolutionRepository,
  createPostgresCollectCategoryResolutionRepository,
} from "../collect-category-resolution-repository.mjs";
import { createCollectCategoryResolutionRuntime } from "../collect-category-resolution-runtime.mjs";
import { createJsonStateTransactionBoundary } from "../json-state-transaction.mjs";

function requestJson(handle, pathname, token) {
  const req = Readable.from([]);
  req.method = "GET";
  req.url = pathname;
  req.headers = { authorization: `Bearer ${token}` };
  const res = {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; },
    end(body = "") { this.body = String(body); },
  };
  return handle(req, res).then(() => ({ status: res.status, body: JSON.parse(res.body || "{}") }));
}

function containsForbiddenCategoryField(value) {
  const forbidden = new Set([
    "credentialstoreid",
    "leasetoken",
    "leaseexpiresat",
    "attemptcount",
    "failurecode",
    "failuredetailsafe",
    "target_description_category_id",
    "failure_detail_safe",
    "credential_store_id",
    "lease_token",
    "lease_expires_at",
    "attempt_count",
    "failure_code",
  ]);
  if (!value || typeof value !== "object") return "";
  for (const [key, nested] of Object.entries(value)) {
    if (forbidden.has(key.replace(/[_-]/g, "").toLowerCase()) || forbidden.has(key)) return key;
    const found = containsForbiddenCategoryField(nested);
    if (found) return found;
  }
  return "";
}

function resolutionRow({
  id,
  accountId,
  collectItemId,
  taxonomyScope,
  status = "MATCHED",
} = {}) {
  return {
    id,
    account_id: accountId,
    collect_item_id: collectItemId,
    taxonomy_scope: taxonomyScope,
    source_type_id: 94_405,
    target_description_category_id: 17_028_702,
    target_type_id: 94_405,
    method: "TYPE_ID_EXACT",
    status,
    taxonomy_fingerprint: "taxonomy-v1",
    credential_store_id: "private-store",
    display_path_json: { zh: ["类目"] },
    failure_code: "PRIVATE_FAILURE",
    failure_detail_safe: "private failure",
    attempt_count: 2,
    next_attempt_at: "2026-08-03T10:00:00.000Z",
    lease_token: "private-lease",
    lease_expires_at: "2026-08-03T10:02:00.000Z",
    matched_at: "2026-08-03T10:00:00.000Z",
    validated_at: "2026-08-03T10:00:00.000Z",
    created_at: "2026-08-03T10:00:00.000Z",
    updated_at: "2026-08-03T10:00:00.000Z",
  };
}

test("JSON and PostgreSQL resolution repositories batch account-scoped reads once", async () => {
  const rows = [
    resolutionRow({ id: "a-default", accountId: "account-a", collectItemId: "collect-a", taxonomyScope: "OZON:DEFAULT" }),
    resolutionRow({ id: "a-ru", accountId: "account-a", collectItemId: "collect-a", taxonomyScope: "OZON:RU" }),
    resolutionRow({ id: "a-other", accountId: "account-a", collectItemId: "collect-z", taxonomyScope: "OZON:DEFAULT" }),
    resolutionRow({ id: "b-default", accountId: "account-b", collectItemId: "collect-a", taxonomyScope: "OZON:DEFAULT" }),
  ];
  let jsonTransactions = 0;
  const jsonRepository = createJsonCollectCategoryResolutionRepository({
    state: {
      caches: { collectBox: [] },
      collectCategoryResolutions: rows.map((row) => ({
        ...row,
        accountId: row.account_id,
        collectItemId: row.collect_item_id,
        taxonomyScope: row.taxonomy_scope,
        sourceTypeId: row.source_type_id,
        targetDescriptionCategoryId: row.target_description_category_id,
        targetTypeId: row.target_type_id,
        credentialStoreId: row.credential_store_id,
        displayPath: row.display_path_json,
        failureCode: row.failure_code,
        failureDetailSafe: row.failure_detail_safe,
        attemptCount: row.attempt_count,
        nextAttemptAt: row.next_attempt_at,
        leaseToken: row.lease_token,
        leaseExpiresAt: row.lease_expires_at,
        matchedAt: row.matched_at,
        validatedAt: row.validated_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    },
    stateTransaction: {
      async run(work) {
        jsonTransactions += 1;
        return work();
      },
    },
  });

  const requestedIds = [
    "collect-z",
    "collect-a",
    "collect-a",
    "missing",
    ...Array.from({ length: 250 }, (_, index) => `bounded-${index}`),
  ];
  const json = await jsonRepository.readForItems({ accountId: "account-a", collectItemIds: requestedIds });
  assert.equal(jsonTransactions, 1, "JSON uses one state transaction for the batch");
  assert.deepEqual(json.map((record) => [record.collectItemId, record.taxonomyScope]), [
    ["collect-a", "OZON:DEFAULT"],
    ["collect-a", "OZON:RU"],
    ["collect-z", "OZON:DEFAULT"],
  ]);
  assert.equal(json.some((record) => record.accountId === "account-b"), false);

  const pgQueries = [];
  const postgresRepository = createPostgresCollectCategoryResolutionRepository({
    pool: {
      async query(sql, params) {
        pgQueries.push({ sql: String(sql), params: structuredClone(params) });
        assert.match(String(sql), /account_id=\$1/);
        assert.match(String(sql), /collect_item_id\s*=\s*ANY\(\$2::text\[\]\)/);
        const [accountId, collectItemIds] = params;
        return {
          rows: rows.filter((row) => row.account_id === accountId && collectItemIds.includes(row.collect_item_id)),
        };
      },
    },
  });
  const postgres = await postgresRepository.readForItems({ accountId: "account-a", collectItemIds: requestedIds });
  assert.equal(pgQueries.length, 1, "PostgreSQL uses one query for the batch");
  assert.equal(pgQueries[0].params[1].length, 200, "the repository bounds unique input IDs");
  assert.deepEqual(postgres.map((record) => [record.collectItemId, record.taxonomyScope]), [
    ["collect-a", "OZON:DEFAULT"],
    ["collect-a", "OZON:RU"],
    ["collect-z", "OZON:DEFAULT"],
  ]);
  assert.equal(postgres.some((record) => record.accountId === "account-b"), false);
});

test("runtime exposes the batch read port without falling back to per-item reads", async () => {
  const calls = [];
  const repository = {
    async readForItems(input) {
      calls.push(structuredClone(input));
      return [
        { id: "default", accountId: "account-a", collectItemId: "collect-a", taxonomyScope: "OZON:DEFAULT" },
      ];
    },
    async readForItem() { throw new Error("per-item category resolution reads are forbidden here"); },
    async enqueue() { return null; },
    async claimNext() { return null; },
    async completeMatched() { return null; },
    async completeNeedsReview() { return null; },
    async deferRetry() { return null; },
    async invalidate() { return null; },
    async saveManual() { return null; },
    async requeueClaim() { return null; },
    async validateMatched() { return null; },
    async deferValidation() { return null; },
  };
  const runtime = createCollectCategoryResolutionRuntime({
    loadState: async () => { throw new Error("PostgreSQL batch reads must not load JSON state"); },
    saveState: async () => {},
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    persistenceMode: () => "postgres",
    categoryService: {
      async getCategorySnapshot() { return {}; },
      async validateTarget() { return {}; },
    },
    currentCredentialStoreForAccount: async () => "store-a",
    initializePostgresRepository: async () => repository,
    appendAudit: async () => {},
    now: () => new Date("2026-08-03T10:00:00.000Z"),
    randomUUID: () => "runtime-test",
  });

  assert.deepEqual(await runtime.readForItems({
    accountId: "account-a",
    collectItemIds: ["collect-a", "collect-a", "missing"],
  }), [{
    id: "default",
    accountId: "account-a",
    collectItemId: "collect-a",
    taxonomyScope: "OZON:DEFAULT",
  }]);
  assert.deepEqual(calls, [{
    accountId: "account-a",
    collectItemIds: ["collect-a", "missing"],
  }]);
});

test("collect box reads expose one account-scoped stable category summary without raw resolution fields", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-collect-category-summary-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  await writeFile(path.join(dataDir, "local-state.json"), JSON.stringify({
    sessions: {
      token_a: { token: "token_a", accountId: "account-a", issuedAt: "2026-08-03T00:00:00.000Z" },
      token_b: { token: "token_b", accountId: "account-b", issuedAt: "2026-08-03T00:00:00.000Z" },
    },
    accounts: [
      { id: "account-a", username: "a", role: "admin", status: "active" },
      { id: "account-b", username: "b", role: "admin", status: "active" },
    ],
    currentStoreIdsByAccount: { "account-a": "store-a", "account-b": "foreign-store" },
    stores: [
      { id: "store-a", ownerAccountId: "account-a", clientId: "client-a", apiKey: "private-a" },
      { id: "store-b", ownerAccountId: "account-a", clientId: "client-b", apiKey: "private-b" },
      { id: "foreign-store", ownerAccountId: "account-b", clientId: "client-c", apiKey: "private-c" },
    ],
    caches: {
      collectBox: [
        {
          id: "collect-a", accountId: "account-a", source: "ozon", name: "A",
          sourceCategory: { descriptionCategoryId: 17_033_604, typeIdCandidate: 94_405 },
          listingDraft: {
            categoryResolution: {
              status: "MATCHED", method: "MANUAL",
              target: { storeId: "legacy-store-a", descriptionCategoryId: 99, typeId: 100 },
            },
          },
        },
        { id: "collect-b", accountId: "account-b", source: "ozon", name: "B" },
      ],
    },
    collectCategoryResolutions: [
      {
        id: "resolution-a", accountId: "account-a", collectItemId: "collect-a",
        taxonomyScope: "OZON:DEFAULT", status: "MATCHED", sourceTypeId: 94_405,
        targetDescriptionCategoryId: 17_028_702, targetTypeId: 94_405,
        displayPath: { zh: ["运动与休闲", "捞鱼网"], ru: ["Спорт и отдых", "Подсачек"] },
        method: "TYPE_ID_EXACT", matchedAt: "2026-08-03T10:00:00.000Z",
        validatedAt: "2026-08-03T10:00:00.000Z", credentialStoreId: "store-a",
        leaseToken: "private-lease", leaseExpiresAt: "2026-08-03T10:02:00.000Z",
        attemptCount: 3, failureCode: "PRIVATE_FAILURE", failureDetailSafe: "private failure detail",
      },
      {
        id: "resolution-b", accountId: "account-b", collectItemId: "collect-b",
        taxonomyScope: "OZON:DEFAULT", status: "NEEDS_REVIEW", sourceTypeId: 99,
        targetDescriptionCategoryId: null, targetTypeId: null, displayPath: {}, method: null,
        matchedAt: null, validatedAt: null, credentialStoreId: "foreign-store",
        leaseToken: "foreign-lease", attemptCount: 7, failureDetailSafe: "foreign failure detail",
      },
    ],
    hashes: {}, leases: {}, browserAgents: {}, jobs: {}, reports: [], auditEvents: [],
  }), "utf8");

  const prior = {
    dataDir: process.env.QH_LOCAL_DATA_DIR,
    noListen: process.env.QH_LOCAL_NO_LISTEN,
    noDotenv: process.env.QH_LOCAL_NO_DOTENV,
    pipeline: process.env.LISTING_PIPELINE_V3,
  };
  process.env.QH_LOCAL_DATA_DIR = dataDir;
  process.env.QH_LOCAL_NO_LISTEN = "1";
  process.env.QH_LOCAL_NO_DOTENV = "1";
  process.env.LISTING_PIPELINE_V3 = "0";
  t.after(() => {
    if (prior.dataDir === undefined) delete process.env.QH_LOCAL_DATA_DIR;
    else process.env.QH_LOCAL_DATA_DIR = prior.dataDir;
    if (prior.noListen === undefined) delete process.env.QH_LOCAL_NO_LISTEN;
    else process.env.QH_LOCAL_NO_LISTEN = prior.noListen;
    if (prior.noDotenv === undefined) delete process.env.QH_LOCAL_NO_DOTENV;
    else process.env.QH_LOCAL_NO_DOTENV = prior.noDotenv;
    if (prior.pipeline === undefined) delete process.env.LISTING_PIPELINE_V3;
    else process.env.LISTING_PIPELINE_V3 = prior.pipeline;
  });

  const { handle } = await import(`../index.mjs?collect-category-summary=${Date.now()}`);
  const accountA = await requestJson(handle, "/ozon/collect-box", "token_a");
  const accountB = await requestJson(handle, "/ozon/collect-box", "token_b");

  assert.equal(accountA.status, 200);
  assert.deepEqual(accountA.body.data.map((item) => item.id), ["collect-a"]);
  assert.deepEqual(accountA.body.data[0].sourceCategory, {
    descriptionCategoryId: 17_033_604,
    typeIdCandidate: 94_405,
  });
  assert.equal(accountA.body.data[0].listingDraft.categoryResolution.target.storeId, "legacy-store-a");
  assert.deepEqual(accountA.body.data[0].categoryResolution, {
    status: "MATCHED",
    taxonomyScope: "OZON:DEFAULT",
    targetDescriptionCategoryId: 17_028_702,
    targetTypeId: 94_405,
    displayPath: { zh: ["运动与休闲", "捞鱼网"], ru: ["Спорт и отдых", "Подсачек"] },
    method: "TYPE_ID_EXACT",
    matchedAt: "2026-08-03T10:00:00.000Z",
    validatedAt: "2026-08-03T10:00:00.000Z",
    action: "NONE",
    message: "类目已匹配",
  });
  assert.equal(containsForbiddenCategoryField(accountA.body.data[0]), "");

  assert.equal(accountB.status, 200);
  assert.deepEqual(accountB.body.data.map((item) => item.id), ["collect-b"]);
  assert.equal(accountB.body.data.some((item) => item.id === "collect-a"), false);
  assert.equal(containsForbiddenCategoryField(accountB.body.data[0]), "");
});
