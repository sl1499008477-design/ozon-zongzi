import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  createJsonAccountSharedOzonCategoryRepository,
  createPostgresAccountSharedOzonCategoryRepository,
} from "../account-shared-ozon-category-repository.mjs";

const HASH_A = "0123456789abcdef".repeat(4);
const HASH_B = "fedcba9876543210".repeat(4);
const TAXONOMY_HASH = "a1".repeat(32);
const CAPTURED_AT = "2026-08-12T01:02:03.000Z";
const VALIDATED_AT = "2026-08-12T02:03:04.000Z";

function sourceEvidence(overrides = {}) {
  const accountId = overrides.accountId ?? "account-a";
  const collectItemId = overrides.collectItemId ?? "collect-a";
  const productDraftId = overrides.productDraftId ?? "draft-a";
  const capturedAt = overrides.capturedAt ?? CAPTURED_AT;
  const rawResponseRef = overrides.rawResponseRef ?? "raw-a";
  const rawResponseHash = overrides.rawResponseHash ?? HASH_A;
  return {
    accountId,
    collectItemId,
    sourceVersion: "draft:7",
    productDraftId,
    productDraftVersion: 7,
    ozonProductId: 123456789,
    sourceSku: "SKU-A",
    taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 17028702,
    sourceTypeId: 94405,
    normalizedPath: ["Home", "Cups"],
    attributeSummary: [{ key: "8229", value: "Cup", dictionaryValueId: 94405 }],
    provenance: {
      accountId,
      collectItemId,
      sourceKind: "PRODUCT_DRAFT",
      sourceRecordId: productDraftId,
      rawResponseRef,
      rawResponseHash,
      capturedAt,
    },
    capturedAt,
    rawResponseRef,
    rawResponseHash,
    ...overrides,
  };
}

function sequential(prefix) {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function createJson({ state = {}, persist = async () => {}, ids = sequential("id") } = {}) {
  return {
    state,
    repository: createJsonAccountSharedOzonCategoryRepository({
      state,
      persist,
      idFactory: ids,
      now: () => VALIDATED_AT,
    }),
  };
}

function assertCode(code) {
  return (error) => error?.code === code && !Object.hasOwn(error, "cause");
}

function initializedState(evidenceRows = []) {
  return {
    collectOzonCategorySourceEvidence: evidenceRows,
    accountOzonSharedCategories: [],
    accountOzonSharedCategoryEvents: [],
  };
}

test("JSON records immutable evidence and one account-shared source-direct row without store identity", async () => {
  const persisted = [];
  const { state, repository } = createJson({
    state: {
      collectCategoryResolutions: [{ storeId: "retired-store" }],
      unrelated: [{ storeId: "keep-unrelated" }],
    },
    persist: async (next) => persisted.push(structuredClone(next)),
  });

  const result = await repository.recordSourceEvidence(sourceEvidence());

  assert.equal(Object.hasOwn(state, "collectCategoryResolutions"), false);
  assert.equal(state.collectOzonCategorySourceEvidence.length, 1);
  assert.equal(state.accountOzonSharedCategories.length, 1);
  assert.equal(state.accountOzonSharedCategoryEvents.length, 1);
  assert.equal(result.shared.status, "ACTIVE");
  assert.equal(result.shared.source, "SOURCE_DIRECT");
  assert.equal(result.shared.taxonomyFingerprint, null);
  assert.equal(result.shared.validatedAt, null);
  assert.deepEqual([
    result.shared.accountId,
    result.shared.sourceDescriptionCategoryId,
    result.shared.sourceTypeId,
    result.shared.taxonomyScope,
  ], ["account-a", 17028702, 94405, "OZON:DEFAULT"]);
  assert.equal(JSON.stringify({
    evidence: state.collectOzonCategorySourceEvidence,
    shared: state.accountOzonSharedCategories,
    events: state.accountOzonSharedCategoryEvents,
  }).includes("store"), false);
  assert.equal(persisted.length, 1);
});

test("JSON preload rejects non-contract evidence without leaking extra raw vendor secrets", async () => {
  const preload = { id: "evidence-preload", ...sourceEvidence(), rawVendorSecret: "token-secret" };
  const { repository } = createJson({ state: initializedState([preload]) });

  await assert.rejects(repository.readCurrentEvidence({
    accountId: "account-a",
    collectItemIds: ["collect-a"],
  }), (error) => (
    error?.code === "OZON_CATEGORY_PERSISTENCE_FAILED"
      && !String(error?.message).includes("token-secret")
      && !Object.hasOwn(error, "cause")
  ));
  await assert.rejects(repository.recordSourceEvidence(sourceEvidence({
    sourceVersion: "draft:8",
    productDraftVersion: 8,
  })), assertCode("OZON_CATEGORY_PERSISTENCE_FAILED"));
});

test("JSON preload never executes evidence accessors or proxies and rejects cycles safely", async () => {
  const fixtures = [];

  const accessor = { id: "accessor", ...sourceEvidence() };
  Object.defineProperty(accessor, "sourceSku", {
    enumerable: true,
    configurable: true,
    get() { throw new Error("getter vendor-secret"); },
  });
  fixtures.push(accessor);

  fixtures.push(new Proxy({ id: "proxy", ...sourceEvidence() }, {
    get() { throw new Error("proxy vendor-secret"); },
  }));

  const cyclic = { id: "cyclic", ...sourceEvidence() };
  cyclic.rawVendorCycle = cyclic;
  fixtures.push(cyclic);

  for (const preload of fixtures) {
    const { repository } = createJson({ state: initializedState([preload]) });
    await assert.rejects(repository.readCurrentEvidence({
      accountId: "account-a",
      collectItemIds: ["collect-a"],
    }), (error) => (
      error?.code === "OZON_CATEGORY_PERSISTENCE_FAILED"
        && !String(error?.message).includes("vendor-secret")
        && !Object.hasOwn(error, "cause")
    ));
  }
});

test("JSON evidence array carrier rejects index accessors, proxies, sparse slots, symbols, and prototypes safely", async () => {
  const valid = { id: "carrier-evidence", ...sourceEvidence() };
  const fixtures = [];

  const accessor = [valid];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    configurable: true,
    get() { throw new Error("array-index vendor-secret"); },
  });
  fixtures.push(accessor);

  fixtures.push(new Proxy([valid], {
    get() { throw new Error("array-proxy vendor-secret"); },
  }));

  const sparse = new Array(1);
  fixtures.push(sparse);

  const symbol = [valid];
  symbol[Symbol("vendor-secret")] = valid;
  fixtures.push(symbol);

  const prototype = [valid];
  Object.setPrototypeOf(prototype, { inheritedSecret: "vendor-secret" });
  fixtures.push(prototype);

  for (const rows of fixtures) {
    const state = initializedState();
    state.collectOzonCategorySourceEvidence = rows;
    const { repository } = createJson({ state });
    for (const operation of [
      () => repository.readCurrentEvidence({
        accountId: "account-a", collectItemIds: ["collect-a"],
      }),
      () => repository.recordSourceEvidence(sourceEvidence({
        sourceVersion: "draft:8", productDraftVersion: 8,
      })),
    ]) {
      await assert.rejects(operation(), (error) => (
        error?.code === "OZON_CATEGORY_PERSISTENCE_FAILED"
          && !String(error?.message).includes("vendor-secret")
          && !Object.hasOwn(error, "cause")
      ));
    }
  }
});

test("evidence replay is idempotent and a conflicting source version fails closed", async () => {
  const { state, repository } = createJson();
  const first = await repository.recordSourceEvidence(sourceEvidence());
  const replay = await repository.recordSourceEvidence(sourceEvidence());

  assert.deepEqual(replay, first);
  assert.equal(state.collectOzonCategorySourceEvidence.length, 1);
  assert.equal(state.accountOzonSharedCategories.length, 1);
  assert.equal(state.accountOzonSharedCategoryEvents.length, 1);

  await assert.rejects(repository.recordSourceEvidence(sourceEvidence({
    sourceDescriptionCategoryId: 17028703,
  })), assertCode("OZON_CATEGORY_SOURCE_VERSION_CONFLICT"));
  assert.equal(state.collectOzonCategorySourceEvidence.length, 1);
});

test("JSON accepts a closed enrichment-cache fact under the same account-shared signature", async () => {
  const { state, repository } = createJson();
  const result = await repository.recordSourceEvidence(sourceEvidence({
    collectItemId: null,
    sourceVersion: HASH_A,
    productDraftId: null,
    productDraftVersion: null,
    ozonProductId: null,
    sourceSku: "SKU-CACHE",
    normalizedPath: [],
    attributeSummary: [],
    rawResponseRef: "collector_ozon_enrichment_cache:ozon:SKU-CACHE:collector.ozon.enrichment.v1",
    provenance: {
      accountId: "account-a",
      collectItemId: null,
      sourceKind: "ENRICHMENT_CACHE",
      sourceRecordId: "ozon:SKU-CACHE:collector.ozon.enrichment.v1",
      rawResponseRef: "collector_ozon_enrichment_cache:ozon:SKU-CACHE:collector.ozon.enrichment.v1",
      rawResponseHash: HASH_A,
      capturedAt: CAPTURED_AT,
      enrichmentSource: "ozon",
      enrichmentContractVersion: "collector.ozon.enrichment.v1",
    },
  }));

  assert.equal(result.evidence.provenance.sourceKind, "ENRICHMENT_CACHE");
  assert.equal(state.collectOzonCategorySourceEvidence.length, 1);
  assert.equal(state.accountOzonSharedCategories.length, 1);
  assert.equal(state.accountOzonSharedCategoryEvents.length, 1);
  assert.equal(
    state.accountOzonSharedCategoryEvents[0].provenance.sourceRecordId,
    "ozon:SKU-CACHE:collector.ozon.enrichment.v1",
  );
  assert.equal(state.accountOzonSharedCategoryEvents[0].provenance.rawResponseHash, HASH_A);
  assert.equal(
    state.accountOzonSharedCategoryEvents[0].provenance.rawResponseRef,
    "collector_ozon_enrichment_cache:ozon:SKU-CACHE:collector.ozon.enrichment.v1",
  );

  await repository.recordSourceEvidence(sourceEvidence({
    collectItemId: null,
    sourceVersion: HASH_A,
    productDraftId: null,
    productDraftVersion: null,
    ozonProductId: null,
    sourceSku: "SKU-CACHE-2",
    normalizedPath: [],
    attributeSummary: [],
    rawResponseRef: "collector_ozon_enrichment_cache:ozon:SKU-CACHE-2:collector.ozon.enrichment.v1",
    provenance: {
      accountId: "account-a",
      collectItemId: null,
      sourceKind: "ENRICHMENT_CACHE",
      sourceRecordId: "ozon:SKU-CACHE-2:collector.ozon.enrichment.v1",
      rawResponseRef: "collector_ozon_enrichment_cache:ozon:SKU-CACHE-2:collector.ozon.enrichment.v1",
      rawResponseHash: HASH_A,
      capturedAt: CAPTURED_AT,
      enrichmentSource: "ozon",
      enrichmentContractVersion: "collector.ozon.enrichment.v1",
    },
  }));
  assert.equal(state.collectOzonCategorySourceEvidence.length, 2,
    "equal response versions from different cache records remain distinct immutable sources");
  assert.equal(state.accountOzonSharedCategories.length, 1,
    "equal category signatures still share one account current row");
});

test("concurrent same-version writes serialize to one fact and one safe conflict", async () => {
  const { state, repository } = createJson({
    persist: async () => new Promise((resolve) => setTimeout(resolve, 5)),
  });
  const results = await Promise.allSettled([
    repository.recordSourceEvidence(sourceEvidence()),
    repository.recordSourceEvidence(sourceEvidence({ sourceTypeId: 94406 })),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find((result) => result.status === "rejected").reason.code,
    "OZON_CATEGORY_SOURCE_VERSION_CONFLICT");
  assert.equal(state.collectOzonCategorySourceEvidence.length, 1);
  assert.equal(state.accountOzonSharedCategories.length, 1);
  assert.equal(state.accountOzonSharedCategoryEvents.length, 1);
});

test("reads require exact account scope and return immutable projections", async () => {
  const { repository } = createJson();
  const own = await repository.recordSourceEvidence(sourceEvidence());
  await repository.recordSourceEvidence(sourceEvidence({
    accountId: "account-b",
    collectItemId: "collect-a",
    productDraftId: "draft-b",
    rawResponseRef: "raw-b",
    rawResponseHash: HASH_B,
    provenance: {
      accountId: "account-b",
      collectItemId: "collect-a",
      sourceKind: "PRODUCT_DRAFT",
      sourceRecordId: "draft-b",
      rawResponseRef: "raw-b",
      rawResponseHash: HASH_B,
      capturedAt: CAPTURED_AT,
    },
  }));

  const evidence = await repository.readCurrentEvidence({
    accountId: "account-a",
    collectItemIds: ["collect-a"],
  });
  assert.deepEqual(evidence.map((row) => row.id), [own.evidence.id]);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence[0]), true);

  const shared = await repository.readSharedForEvidence({
    accountId: "account-a",
    evidenceIds: [own.evidence.id],
  });
  assert.equal(shared.length, 1);
  assert.equal(shared[0].accountId, "account-a");
  assert.equal(Object.isFrozen(shared[0]), true);

  assert.deepEqual(await repository.readSharedForEvidence({
    accountId: "account-b",
    evidenceIds: [own.evidence.id],
  }), []);
  await assert.rejects(repository.readCurrentEvidence({
    accountId: "account-a", collectItemIds: ["collect-a"], storeId: "store-a",
  }), assertCode("ACCOUNT_SHARED_OZON_CATEGORY_CONTRACT_INVALID"));
  const accessorIds = ["collect-a"];
  Object.defineProperty(accessorIds, "0", {
    enumerable: true,
    configurable: true,
    get() { throw new Error("read accessor executed"); },
  });
  await assert.rejects(repository.readCurrentEvidence({
    accountId: "account-a", collectItemIds: accessorIds,
  }), assertCode("ACCOUNT_SHARED_OZON_CATEGORY_CONTRACT_INVALID"));
});

test("JSON and PostgreSQL current evidence use capturedAt DESC then stable id DESC", async () => {
  const olderHighDraftVersion = {
    id: "evidence-z-old",
    ...sourceEvidence({
      sourceVersion: "draft:99",
      productDraftVersion: 99,
      capturedAt: "2026-08-12T01:02:03.000Z",
    }),
  };
  const newestLowDraftVersion = {
    id: "evidence-a-new",
    ...sourceEvidence({
      sourceVersion: "draft:1",
      productDraftVersion: 1,
      capturedAt: "2026-08-12T01:02:04.000Z",
      provenance: {
        ...sourceEvidence().provenance,
        capturedAt: "2026-08-12T01:02:04.000Z",
      },
    }),
  };
  const sameTimeHigherId = {
    id: "evidence-z-new",
    ...sourceEvidence({
      sourceVersion: "draft:2",
      productDraftVersion: 2,
      capturedAt: "2026-08-12T01:02:04.000Z",
      provenance: {
        ...sourceEvidence().provenance,
        capturedAt: "2026-08-12T01:02:04.000Z",
      },
    }),
  };
  const fixtures = [olderHighDraftVersion, newestLowDraftVersion, sameTimeHigherId];
  const json = createJson({ state: initializedState(fixtures) }).repository;
  const queries = [];
  const postgres = createPostgresAccountSharedOzonCategoryRepository({
    pool: {
      async query(sql) {
        queries.push(sql);
        return { rows: [{
          id: sameTimeHigherId.id,
          provenance: { categoryEvidence: sourceEvidence({
            sourceVersion: sameTimeHigherId.sourceVersion,
            productDraftVersion: sameTimeHigherId.productDraftVersion,
            capturedAt: sameTimeHigherId.capturedAt,
            provenance: sameTimeHigherId.provenance,
          }) },
        }] };
      },
    },
  });

  const input = { accountId: "account-a", collectItemIds: ["collect-a"] };
  const [jsonCurrent, postgresCurrent] = await Promise.all([
    json.readCurrentEvidence(input),
    postgres.readCurrentEvidence(input),
  ]);
  assert.equal(jsonCurrent[0].id, "evidence-z-new");
  assert.equal(postgresCurrent[0].id, "evidence-z-new");
  assert.match(queries[0], /ORDER BY collect_item_id,captured_at DESC,id DESC/iu);
});

test("manual confirmation appends a new evidence version before activating the shared row", async () => {
  const persisted = [];
  const { state, repository } = createJson({ persist: async (next) => {
    persisted.push(structuredClone(next));
  } });
  const captured = await repository.recordSourceEvidence(sourceEvidence());
  const original = structuredClone(state.collectOzonCategorySourceEvidence[0]);
  const manualEvidence = sourceEvidence({
    sourceVersion: "draft:7:manual:1",
    productDraftVersion: 8,
  });

  const updated = await repository.confirmManualCategory({
    accountId: "account-a",
    evidence: manualEvidence,
    expectedVersion: 1,
    currentDescriptionCategoryId: 17028788,
    currentTypeId: 95555,
    taxonomyFingerprint: TAXONOMY_HASH,
    validatedAt: VALIDATED_AT,
  });

  assert.deepEqual(state.collectOzonCategorySourceEvidence[0], original,
    "the captured fact stays byte-for-byte immutable");
  assert.equal(state.collectOzonCategorySourceEvidence.length, 2);
  assert.equal(updated.source, "MANUAL");
  assert.equal(updated.version, 2);
  assert.equal(updated.currentDescriptionCategoryId, 17028788);
  assert.notEqual(updated.evidenceId, captured.evidence.id);
  assert.equal(state.accountOzonSharedCategoryEvents.at(-1).sourceEvidenceId, updated.evidenceId);
  const lastCommit = persisted.at(-1);
  const newEvidenceIndex = JSON.stringify(lastCommit).indexOf(updated.evidenceId);
  const eventIndex = JSON.stringify(lastCommit).lastIndexOf(updated.evidenceId);
  assert.ok(newEvidenceIndex >= 0 && eventIndex > newEvidenceIndex);
});

test("all transitions enforce optimistic versions and atomically append safe events", async () => {
  let failNextPersist = false;
  const { state, repository } = createJson({ persist: async () => {
    if (failNextPersist) throw new Error("raw vendor response secret");
  } });
  const recorded = await repository.recordSourceEvidence(sourceEvidence());

  await assert.rejects(repository.invalidateSharedCategory({
    accountId: "account-a",
    evidenceId: recorded.evidence.id,
    expectedVersion: 2,
    safeFailureCode: "OZON_CATEGORY_INVALIDATED",
    transitionedAt: VALIDATED_AT,
  }), assertCode("OZON_CATEGORY_SHARED_VERSION_CONFLICT"));

  const invalidated = await repository.invalidateSharedCategory({
    accountId: "account-a",
    evidenceId: recorded.evidence.id,
    expectedVersion: 1,
    safeFailureCode: "OZON_CATEGORY_INVALIDATED",
    transitionedAt: VALIDATED_AT,
  });
  assert.equal(invalidated.status, "INVALIDATED");
  assert.equal(invalidated.version, 2);
  assert.equal(state.accountOzonSharedCategoryEvents.length, 2);

  failNextPersist = true;
  const beforeFailure = structuredClone(state);
  await assert.rejects(repository.markSharedNeedsReview({
    accountId: "account-a",
    evidenceId: recorded.evidence.id,
    expectedVersion: 2,
    safeFailureCode: "OZON_TYPE_AMBIGUOUS",
    transitionedAt: "2026-08-12T02:03:05.000Z",
  }), assertCode("OZON_CATEGORY_PERSISTENCE_FAILED"));
  assert.deepEqual(state, beforeFailure, "failed persistence cannot expose a row without its event");
});

test("JSON stale replay cannot reuse an idempotent transition through different evidence", async () => {
  const { state, repository } = createJson();
  const first = await repository.recordSourceEvidence(sourceEvidence());
  const second = await repository.recordSourceEvidence(sourceEvidence({
    sourceVersion: "draft:8",
    productDraftVersion: 8,
    capturedAt: "2026-08-12T01:02:04.000Z",
    provenance: {
      ...sourceEvidence().provenance,
      capturedAt: "2026-08-12T01:02:04.000Z",
    },
  }));
  assert.notEqual(first.evidence.id, second.evidence.id);

  await repository.activateRefreshedCategory({
    accountId: "account-a",
    evidenceId: first.evidence.id,
    expectedVersion: 1,
    currentDescriptionCategoryId: 17028702,
    currentTypeId: 94405,
    taxonomyFingerprint: TAXONOMY_HASH,
    validatedAt: VALIDATED_AT,
  });

  await assert.rejects(repository.activateRefreshedCategory({
    accountId: "account-a",
    evidenceId: second.evidence.id,
    expectedVersion: 1,
    currentDescriptionCategoryId: 17028702,
    currentTypeId: 94405,
    taxonomyFingerprint: TAXONOMY_HASH,
    validatedAt: VALIDATED_AT,
  }), assertCode("OZON_CATEGORY_SHARED_VERSION_CONFLICT"));
  assert.equal(state.accountOzonSharedCategories[0].evidenceId, first.evidence.id);
  assert.equal(state.accountOzonSharedCategoryEvents.length, 2);
});

test("taxonomy refresh activation and review transitions reject raw or unapproved failure codes", async () => {
  const { repository } = createJson();
  const recorded = await repository.recordSourceEvidence(sourceEvidence());
  const refreshed = await repository.activateRefreshedCategory({
    accountId: "account-a",
    evidenceId: recorded.evidence.id,
    expectedVersion: 1,
    currentDescriptionCategoryId: 17028702,
    currentTypeId: 94405,
    taxonomyFingerprint: TAXONOMY_HASH,
    validatedAt: VALIDATED_AT,
  });
  assert.equal(refreshed.source, "OZON_REFRESH");
  assert.equal(refreshed.version, 2);

  await assert.rejects(repository.markSharedNeedsReview({
    accountId: "account-a",
    evidenceId: recorded.evidence.id,
    expectedVersion: 2,
    safeFailureCode: "vendor said credential=secret",
    transitionedAt: "2026-08-12T02:03:05.000Z",
  }), assertCode("ACCOUNT_SHARED_OZON_CATEGORY_CONTRACT_INVALID"));
});

test("PostgreSQL reads emit exact account predicates and never carry store fields", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const repository = createPostgresAccountSharedOzonCategoryRepository({ pool });

  assert.deepEqual(await repository.readCurrentEvidence({
    accountId: "account-a", collectItemIds: ["collect-a", "collect-b"],
  }), []);
  assert.deepEqual(await repository.readSharedForEvidence({
    accountId: "account-a", evidenceIds: ["evidence-a"],
  }), []);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, ["account-a", ["collect-a", "collect-b"]]);
  assert.deepEqual(calls[1].params, ["account-a", ["evidence-a"]]);
  for (const call of calls) {
    assert.match(call.sql, /account_id\s*=\s*\$1/iu);
    assert.doesNotMatch(call.sql, /store/iu);
    assert.equal(JSON.stringify(call.params).includes("store"), false);
  }
});

test("PostgreSQL first writes acquire an account/source-version transaction fence", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (calls.length === 2) throw new Error("stop after fence observation");
      return { rows: [] };
    },
    release() {},
  };
  const repository = createPostgresAccountSharedOzonCategoryRepository({
    pool: { query: async () => ({ rows: [] }), connect: async () => client },
  });

  await assert.rejects(repository.recordSourceEvidence(sourceEvidence()),
    assertCode("OZON_CATEGORY_PERSISTENCE_FAILED"));
  assert.equal(calls[0].sql, "BEGIN");
  assert.match(calls[1].sql, /pg_advisory_xact_lock/iu);
  assert.deepEqual(calls[1].params, [
    "account-a\u0001PRODUCT_DRAFT\u0001draft-a\u0001draft:7",
  ]);
});

test("PostgreSQL connection failures expose only the fixed safe repository code", async () => {
  const repository = createPostgresAccountSharedOzonCategoryRepository({
    pool: {
      query: async () => ({ rows: [] }),
      async connect() { throw new Error("password=secret vendor endpoint"); },
    },
  });
  await assert.rejects(repository.recordSourceEvidence(sourceEvidence()), (error) => (
    error?.code === "OZON_CATEGORY_PERSISTENCE_FAILED"
      && !String(error?.message).includes("secret")
      && !Object.hasOwn(error, "cause")
  ));
});

test("PostgreSQL reads normalize immutable evidence created by migration 063", async () => {
  const repository = createPostgresAccountSharedOzonCategoryRepository({
    pool: {
      async query() {
        return { rows: [{
          id: "migrated-evidence-a",
          account_id: "account-a",
          source_kind: "PRODUCT_DRAFT",
          source_record_id: "draft-a",
          source_version: "7",
          collect_item_id: "collect-a",
          product_draft_id: "draft-a",
          source_description_category_id: 17028702,
          source_type_id: 94405,
          taxonomy_scope: "OZON:DEFAULT",
          captured_at: CAPTURED_AT,
          raw_response_hash: HASH_A,
          raw_response_ref: "raw-a",
          provenance: {
            sourceKind: "PRODUCT_DRAFT",
            sourceRecordId: "draft-a",
            sourceVersion: "7",
            collectItemId: "collect-a",
            productDraftId: "draft-a",
            rawResponseRef: "raw-a",
            canonicalPath: "data.sourceCategory",
          },
        }] };
      },
    },
  });

  const [evidence] = await repository.readCurrentEvidence({
    accountId: "account-a",
    collectItemIds: ["collect-a"],
  });
  assert.equal(evidence.id, "migrated-evidence-a");
  assert.equal(evidence.productDraftVersion, 7);
  assert.equal(evidence.ozonProductId, null);
  assert.equal(evidence.sourceSku, null);
  assert.deepEqual(evidence.normalizedPath, []);
  assert.deepEqual(evidence.attributeSummary, []);
  assert.equal(evidence.provenance.accountId, "account-a");
});

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL || "";
const postgresEnabled = process.env.ACCOUNT_SHARED_CATEGORY_POSTGRES_TESTS === "1"
  && Boolean(databaseUrl);
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

async function migrationFiles() {
  return (await readdir(migrationsDir))
    .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && Number(file.slice(0, 3)) <= 63)
    .sort();
}

if (!postgresEnabled) {
  test("PostgreSQL repository requires a disposable PostgreSQL 16 database", {
    skip: "requires ACCOUNT_SHARED_CATEGORY_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("PostgreSQL port records evidence and performs account-scoped atomic transitions", {
    timeout: 60_000,
  }, async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `shared_category_repository_${suffix}`;
    const accountId = `account-${suffix}`;
    const storeId = `store-${suffix}`;
    const collectItemId = `collect-${suffix}`;
    const rawId = `raw-${suffix}`;
    const draftId = `draft-${suffix}`;
    let scoped = null;
    try {
      const client = await admin.connect();
      try {
        await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
        await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
        for (const file of await migrationFiles()) {
          await client.query(await readFile(path.join(migrationsDir, file), "utf8"));
        }
        await client.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [accountId, `user-${suffix}`],
        );
        await client.query(
          "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$1,$1,$2,'active',$3)",
          [storeId, `client-${suffix}`, accountId],
        );
        await client.query(
          `INSERT INTO collect_items (id,account_id,store_id,source,identity_key,source_sku,summary)
           VALUES ($1,$2,$3,'ozon',$4,$5,'{}'::jsonb)`,
          [collectItemId, accountId, storeId, `identity-${suffix}`, `SKU-${suffix}`],
        );
        await client.query(
          `INSERT INTO collect_raw_payloads
            (id,collect_item_id,account_id,store_id,source_sku,source_url,payload_hash,payload,collected_at)
           VALUES ($1,$2,$3,$4,$5,'https://source.invalid/item',$6,'{}'::jsonb,$7)`,
          [rawId, collectItemId, accountId, storeId, `SKU-${suffix}`, HASH_A, CAPTURED_AT],
        );
        await client.query(
          `INSERT INTO product_drafts
            (id,collect_item_id,source_payload_id,version,data_hash,data,updated_by)
           VALUES ($1,$2,$3,7,$4,'{}'::jsonb,$5)`,
          [draftId, collectItemId, rawId, HASH_B, accountId],
        );
        await client.query(
          `INSERT INTO collector_ozon_enrichment_cache
            (account_id,source,sku,contract_version,status,result_json,response_hash,captured_at,expires_at)
           VALUES ($1,'ozon',$2,'collector.ozon.enrichment.v1','COMPLETE',$3::jsonb,$4,$5,$6)`,
          [
            accountId,
            `CACHE-${suffix}`,
            JSON.stringify({ status: "COMPLETE", sourceCategory: {
              descriptionCategoryId: 17028703, typeIdCandidate: 94406,
            } }),
            HASH_B,
            CAPTURED_AT,
            "2099-01-01T00:00:00.000Z",
          ],
        );
      } finally {
        client.release();
      }

      scoped = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      const repository = createPostgresAccountSharedOzonCategoryRepository({
        pool: scoped,
        idFactory: sequential(`pg-${suffix}`),
      });
      const evidenceInput = sourceEvidence({
        accountId,
        collectItemId,
        productDraftId: draftId,
        sourceSku: `SKU-${suffix}`,
        rawResponseRef: rawId,
        provenance: {
          accountId,
          collectItemId,
          sourceKind: "PRODUCT_DRAFT",
          sourceRecordId: draftId,
          rawResponseRef: rawId,
          rawResponseHash: HASH_A,
          capturedAt: CAPTURED_AT,
        },
      });
      const [first, replay] = await Promise.all([
        repository.recordSourceEvidence(evidenceInput),
        repository.recordSourceEvidence(evidenceInput),
      ]);
      assert.deepEqual(replay, first);
      assert.deepEqual((await repository.readCurrentEvidence({
        accountId, collectItemIds: [collectItemId],
      })).map((row) => row.id), [first.evidence.id]);
      assert.equal((await repository.readSharedForEvidence({
        accountId, evidenceIds: [first.evidence.id],
      }))[0].version, 1);
      assert.deepEqual(await repository.readSharedForEvidence({
        accountId: `other-${suffix}`, evidenceIds: [first.evidence.id],
      }), []);

      const cacheSku = `CACHE-${suffix}`;
      const cacheEvidence = await repository.recordSourceEvidence(sourceEvidence({
        accountId,
        collectItemId: null,
        sourceVersion: HASH_B,
        productDraftId: null,
        productDraftVersion: null,
        ozonProductId: null,
        sourceSku: cacheSku,
        sourceDescriptionCategoryId: 17028703,
        sourceTypeId: 94406,
        normalizedPath: [],
        attributeSummary: [],
        rawResponseHash: HASH_B,
        rawResponseRef: `collector_ozon_enrichment_cache:ozon:${cacheSku}:collector.ozon.enrichment.v1`,
        provenance: {
          accountId,
          collectItemId: null,
          sourceKind: "ENRICHMENT_CACHE",
          sourceRecordId: `ozon:${cacheSku}:collector.ozon.enrichment.v1`,
          rawResponseRef: `collector_ozon_enrichment_cache:ozon:${cacheSku}:collector.ozon.enrichment.v1`,
          rawResponseHash: HASH_B,
          capturedAt: CAPTURED_AT,
          enrichmentSource: "ozon",
          enrichmentContractVersion: "collector.ozon.enrichment.v1",
        },
      }));
      assert.equal(cacheEvidence.shared.sourceDescriptionCategoryId, 17028703);
      assert.equal((await repository.readSharedForEvidence({
        accountId, evidenceIds: [cacheEvidence.evidence.id],
      }))[0].sourceTypeId, 94406);
      const cacheEvent = (await scoped.query(
        `SELECT provenance FROM account_ozon_shared_category_events
          WHERE account_id=$1 AND source_evidence_id=$2 AND event_type='SOURCE_DIRECT_RECORDED'`,
        [accountId, cacheEvidence.evidence.id],
      )).rows[0];
      assert.equal(
        cacheEvent.provenance.sourceRecordId,
        `ozon:${cacheSku}:collector.ozon.enrichment.v1`,
      );
      assert.equal(cacheEvent.provenance.rawResponseHash, HASH_B);

      const refreshed = await repository.activateRefreshedCategory({
        accountId,
        evidenceId: first.evidence.id,
        expectedVersion: 1,
        currentDescriptionCategoryId: 17028702,
        currentTypeId: 94405,
        taxonomyFingerprint: TAXONOMY_HASH,
        validatedAt: VALIDATED_AT,
      });
      assert.equal(refreshed.version, 2);
      await assert.rejects(repository.invalidateSharedCategory({
        accountId,
        evidenceId: first.evidence.id,
        expectedVersion: 1,
        safeFailureCode: "OZON_CATEGORY_INVALIDATED",
        transitionedAt: "2026-08-12T02:03:05.000Z",
      }), assertCode("OZON_CATEGORY_SHARED_VERSION_CONFLICT"));

      const manual = await repository.confirmManualCategory({
        accountId,
        evidence: sourceEvidence({
          ...evidenceInput,
          sourceVersion: "draft:7:manual:1",
          productDraftVersion: 8,
        }),
        expectedVersion: 2,
        currentDescriptionCategoryId: 17028788,
        currentTypeId: 95555,
        taxonomyFingerprint: TAXONOMY_HASH,
        validatedAt: "2026-08-12T02:03:06.000Z",
      });
      assert.equal(manual.version, 3);
      assert.equal(manual.source, "MANUAL");
      assert.notEqual(manual.evidenceId, first.evidence.id);

      const counts = (await scoped.query(`
        SELECT
          (SELECT COUNT(*)::INT FROM collect_ozon_category_source_evidence WHERE account_id=$1) AS evidence,
          (SELECT COUNT(*)::INT FROM account_ozon_shared_categories WHERE account_id=$1) AS shared,
          (SELECT COUNT(*)::INT FROM account_ozon_shared_category_events WHERE account_id=$1) AS events
      `, [accountId])).rows[0];
      assert.deepEqual(counts, { evidence: 3, shared: 2, events: 4 });
      assert.equal(JSON.stringify((await scoped.query(
        "SELECT * FROM account_ozon_shared_categories WHERE account_id=$1",
        [accountId],
      )).rows).includes(storeId), false);
    } finally {
      if (scoped) await scoped.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  });
}
