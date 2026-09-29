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
import { lookupObservationIdentity } from "../account-shared-ozon-category-contract.mjs";
import { createAccountSharedOzonCategoryRuntime } from "../account-shared-ozon-category-runtime.mjs";
import { deleteRemovedAccountScopes } from "../formal-persistence.mjs";

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

function lookupEvidence({ accountId = "account-a", collectItemId = "collect-a", productId = 123456789,
  sku = "SKU-A", hash = HASH_B, categoryId = 17028702, typeId = 94405,
  triggerProductDraftId = "draft-a", triggerProductDraftVersion = 7,
  capturedAt = CAPTURED_AT } = {}) {
  const observation = lookupObservationIdentity({
    collectItemId, triggerProductDraftId, triggerProductDraftVersion,
    lookupContractVersion: "account-shared-ozon-category-lookup.v1",
    requestedOzonProductId: productId, requestedSourceSku: sku,
    matchedOzonProductId: productId, matchedSourceSku: sku,
    responseHash: hash,
  });
  const rawResponseRef = observation.rawResponseRef;
  return sourceEvidence({
    accountId, collectItemId, sourceVersion: observation.sourceVersion,
    productDraftId: null, productDraftVersion: null, ozonProductId: productId,
    sourceSku: sku, sourceDescriptionCategoryId: categoryId, sourceTypeId: typeId,
    normalizedPath: [], attributeSummary: [], rawResponseRef, rawResponseHash: hash,
    provenance: {
      accountId, collectItemId, sourceKind: "OZON_READ_LOOKUP",
      sourceRecordId: observation.sourceRecordId, rawResponseRef, rawResponseHash: hash,
      capturedAt,
      lookupContractVersion: "account-shared-ozon-category-lookup.v1",
      triggerProductDraftId, triggerProductDraftVersion,
      requestedOzonProductId: productId, requestedSourceSku: sku,
      matchedOzonProductId: productId, matchedSourceSku: sku,
    },
    capturedAt,
  });
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

test("JSON preload projects historical extra fields without leaking raw vendor secrets", async () => {
  const preload = { id: "evidence-preload", ...sourceEvidence(), rawVendorSecret: "token-secret" };
  const { repository } = createJson({ state: initializedState([preload]) });

  const [read] = await repository.readCurrentEvidence({
    accountId: "account-a",
    collectItemIds: ["collect-a"],
  });
  assert.equal(read.id, "evidence-preload");
  assert.equal(read.sourceDescriptionCategoryId, 17028702);
  assert.equal(read.sourceTypeId, 94405);
  assert.equal(JSON.stringify(read).includes("token-secret"), false);
  const next = await repository.recordSourceEvidence(sourceEvidence({
    sourceVersion: "draft:8",
    productDraftVersion: 8,
  }));
  assert.equal(next.evidence.sourceVersion, "draft:8");
});

// Executable objects cannot come from stored JSON. Exercise that protection at
// recordSourceEvidence, where untrusted in-process input actually enters the repository.
test("JSON new evidence never executes accessors or proxies and rejects cycles safely", async () => {
  const fixtures = [];
  let executed = 0;

  const accessor = sourceEvidence();
  Object.defineProperty(accessor, "sourceSku", {
    enumerable: true,
    configurable: true,
    get() { executed += 1; throw new Error("getter vendor-secret"); },
  });
  fixtures.push(accessor);

  fixtures.push(new Proxy(sourceEvidence(), {
    get() { executed += 1; throw new Error("proxy vendor-secret"); },
  }));

  const cyclic = sourceEvidence();
  cyclic.attributeSummary[0].value = cyclic;
  fixtures.push(cyclic);

  for (const input of fixtures) {
    const { repository, state } = createJson({ persist: async () => assert.fail("invalid write persisted") });
    await assert.rejects(repository.recordSourceEvidence(input), (error) => (
      error?.code === "ACCOUNT_SHARED_ZONGZI_CATEGORY_CONTRACT_INVALID"
        && !String(error?.message).includes("vendor-secret")
        && !Object.hasOwn(error, "cause")
    ));
    assert.deepEqual(state, {});
  }
  assert.equal(executed, 0);
});

test("JSON new evidence rejects metadata array accessors, proxies and symbol properties before persistence", async () => {
  const valid = { key: "8229", value: "Cup", dictionaryValueId: 94405 };
  const fixtures = [];
  let executed = 0;

  const accessor = [valid];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    configurable: true,
    get() { executed += 1; throw new Error("array-index vendor-secret"); },
  });
  fixtures.push(accessor);

  fixtures.push(new Proxy([valid], {
    get() { executed += 1; throw new Error("array-proxy vendor-secret"); },
  }));

  const symbol = [valid];
  symbol[Symbol("vendor-secret")] = valid;
  fixtures.push(symbol);

  for (const rows of fixtures) {
    const { repository, state } = createJson({ persist: async () => assert.fail("invalid write persisted") });
    await assert.rejects(repository.recordSourceEvidence(sourceEvidence({ attributeSummary: rows })), (error) => (
      error?.code === "ACCOUNT_SHARED_ZONGZI_CATEGORY_CONTRACT_INVALID"
        && !String(error?.message).includes("vendor-secret")
        && !Object.hasOwn(error, "cause")
    ));
    assert.deepEqual(state, {});
  }
  assert.equal(executed, 0);
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
  })), assertCode("ZONGZI_CATEGORY_SOURCE_VERSION_CONFLICT"));
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
    "ZONGZI_CATEGORY_SOURCE_VERSION_CONFLICT");
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
  }), assertCode("ACCOUNT_SHARED_ZONGZI_CATEGORY_CONTRACT_INVALID"));
  const accessorIds = ["collect-a"];
  Object.defineProperty(accessorIds, "0", {
    enumerable: true,
    configurable: true,
    get() { throw new Error("read accessor executed"); },
  });
  await assert.rejects(repository.readCurrentEvidence({
    accountId: "account-a", collectItemIds: accessorIds,
  }), assertCode("ACCOUNT_SHARED_ZONGZI_CATEGORY_CONTRACT_INVALID"));
});

test("JSON and PostgreSQL current evidence follow the canonical source pointer, never capture clocks", async () => {
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
  const jsonState = initializedState(fixtures);
  jsonState.collectOzonCategoryCurrentSources = [{
    accountId: "account-a",
    collectItemId: "collect-a",
    evidenceId: olderHighDraftVersion.id,
    sourceKind: "PRODUCT_DRAFT",
    sourceRecordId: "draft-a",
    sourceVersion: "draft:99",
  }];
  const json = createJson({ state: jsonState }).repository;
  const queries = [];
  const postgres = createPostgresAccountSharedOzonCategoryRepository({
    pool: {
      async query(sql) {
        queries.push(sql);
        return { rows: [{
          id: olderHighDraftVersion.id,
          account_id: "account-a",
          collect_item_id: "collect-a",
          source_kind: "PRODUCT_DRAFT",
          source_record_id: "draft-a",
          source_version: "draft:99",
          product_draft_id: "draft-a",
          enrichment_source: null,
          enrichment_sku: null,
          enrichment_contract_version: null,
          source_description_category_id: "17028702",
          source_type_id: "94405",
          taxonomy_scope: "OZON:DEFAULT",
          captured_at: CAPTURED_AT,
          raw_response_hash: HASH_A,
          raw_response_ref: "raw-a",
          product_raw_response_ref: "raw-a",
          lookup_evidence_id: null,
          created_at: CAPTURED_AT,
          provenance: { categoryEvidence: sourceEvidence({
            sourceVersion: olderHighDraftVersion.sourceVersion,
            productDraftVersion: olderHighDraftVersion.productDraftVersion,
            capturedAt: olderHighDraftVersion.capturedAt,
            provenance: olderHighDraftVersion.provenance,
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
  assert.equal(jsonCurrent[0].id, "evidence-z-old");
  assert.equal(postgresCurrent[0].id, "evidence-z-old");
  assert.match(queries[0], /collect_ozon_category_current_sources/iu);
  assert.doesNotMatch(queries[0], /captured_at\s+DESC/iu);
});

test("JSON ignores a late stale draft capture when the collect item points at another draft", async () => {
  const state = initializedState();
  state.caches = { collectBox: [{
    id: "collect-a", accountId: "account-a", currentDraftId: "draft-current", draftVersion: 2,
  }] };
  const { repository } = createJson({ state });
  const current = await repository.recordSourceEvidence(sourceEvidence({
    productDraftId: "draft-current", productDraftVersion: 2, sourceVersion: "draft:2",
    capturedAt: "2026-08-12T01:00:00.000Z",
    provenance: { ...sourceEvidence().provenance, sourceRecordId: "draft-current",
      capturedAt: "2026-08-12T01:00:00.000Z" },
  }));
  await repository.recordSourceEvidence(sourceEvidence({
    productDraftId: "draft-stale", productDraftVersion: 1, sourceVersion: "draft:1",
    capturedAt: "2026-08-12T02:00:00.000Z", rawResponseRef: "raw-stale",
    provenance: { ...sourceEvidence().provenance, sourceRecordId: "draft-stale",
      rawResponseRef: "raw-stale", capturedAt: "2026-08-12T02:00:00.000Z" },
  }));
  assert.equal((await repository.readCurrentEvidence({
    accountId: "account-a", collectItemIds: ["collect-a"],
  }))[0].id, current.evidence.id);
});

test("JSON lookup replay and stale completion cannot roll a canonical pointer backward", async () => {
  const state = initializedState();
  state.caches = { collectBox: [{
    id: "collect-a", accountId: "account-a", currentDraftId: "draft-a", draftVersion: 7,
  }] };
  const { repository } = createJson({ state });
  await repository.recordSourceEvidence(sourceEvidence());
  const oldLookup = await repository.recordSourceEvidence(lookupEvidence({ hash: HASH_A }));
  assert.equal((await repository.readCurrentEvidence({
    accountId: "account-a", collectItemIds: ["collect-a"],
  }))[0].id, oldLookup.evidence.id);

  state.caches.collectBox[0].draftVersion = 8;
  const nextDraft = await repository.recordSourceEvidence(sourceEvidence({
    sourceVersion: "draft:8", productDraftVersion: 8, rawResponseHash: HASH_B,
    provenance: { ...sourceEvidence().provenance, rawResponseHash: HASH_B },
  }));
  const nextHash = crypto.createHash("sha256").update("lookup-next").digest("hex");
  const lateHash = crypto.createHash("sha256").update("lookup-late-old").digest("hex");
  const [nextLookup] = await Promise.all([
    repository.recordSourceEvidence(lookupEvidence({
      hash: nextHash, triggerProductDraftVersion: 8,
    })),
    repository.recordSourceEvidence(lookupEvidence({ hash: lateHash })),
  ]);
  assert.notEqual(nextLookup.evidence.id, oldLookup.evidence.id);

  await repository.recordSourceEvidence(lookupEvidence({ hash: HASH_A }));
  const current = await repository.readCurrentEvidence({
    accountId: "account-a", collectItemIds: ["collect-a"],
  });
  assert.equal(current[0].id, nextLookup.evidence.id);
  assert.notEqual(current[0].id, nextDraft.evidence.id);
});

test("JSON exact lookup replay keeps the first observation clock without duplicate evidence", async () => {
  const state = initializedState();
  state.caches = { collectBox: [{
    id: "collect-a", accountId: "account-a", currentDraftId: "draft-a", draftVersion: 7,
  }] };
  const { repository } = createJson({ state });
  await repository.recordSourceEvidence(sourceEvidence());

  const first = await repository.recordSourceEvidence(lookupEvidence());
  const replay = await repository.recordSourceEvidence(lookupEvidence({
    capturedAt: "2026-08-12T01:02:04.000Z",
  }));

  assert.equal(replay.evidence.id, first.evidence.id);
  assert.equal(replay.evidence.capturedAt, CAPTURED_AT,
    "an observation replay returns the persisted capture clock");
  assert.equal(state.collectOzonCategoryLookupEvidence.length, 1);
  assert.equal(state.collectOzonCategorySourceEvidence.filter(
    (row) => row.provenance.sourceKind === "OZON_READ_LOOKUP",
  ).length, 1);
});

test("JSON same lookup response from a newer trigger draft records and promotes a new observation", async () => {
  const state = initializedState();
  state.caches = { collectBox: [{
    id: "collect-a", accountId: "account-a", currentDraftId: "draft-a", draftVersion: 7,
  }] };
  const { repository } = createJson({ state });
  await repository.recordSourceEvidence(sourceEvidence());
  const first = await repository.recordSourceEvidence(lookupEvidence());

  state.caches.collectBox[0].draftVersion = 8;
  await repository.recordSourceEvidence(sourceEvidence({
    sourceVersion: "draft:8",
    productDraftVersion: 8,
  }));
  const newer = await repository.recordSourceEvidence(lookupEvidence({
    triggerProductDraftVersion: 8,
    capturedAt: "2026-08-12T01:02:04.000Z",
  }));

  assert.notEqual(newer.evidence.id, first.evidence.id);
  assert.notEqual(newer.evidence.sourceVersion, first.evidence.sourceVersion);
  assert.notEqual(newer.evidence.provenance.sourceRecordId,
    first.evidence.provenance.sourceRecordId);
  assert.equal(state.collectOzonCategoryLookupEvidence.length, 2);
  assert.equal((await repository.readCurrentEvidence({
    accountId: "account-a", collectItemIds: ["collect-a"],
  }))[0].id, newer.evidence.id);
});

test("JSON same-account items with the same exact lookup response keep item-scoped observations", async () => {
  const state = initializedState();
  state.caches = { collectBox: [
    { id: "collect-a", accountId: "account-a", currentDraftId: "draft-a", draftVersion: 7 },
    { id: "collect-b", accountId: "account-a", currentDraftId: "draft-b", draftVersion: 7 },
  ] };
  const { repository } = createJson({ state });
  await repository.recordSourceEvidence(sourceEvidence());
  await repository.recordSourceEvidence(sourceEvidence({
    collectItemId: "collect-b",
    productDraftId: "draft-b",
    rawResponseRef: "raw-b",
    provenance: {
      ...sourceEvidence().provenance,
      collectItemId: "collect-b",
      sourceRecordId: "draft-b",
      rawResponseRef: "raw-b",
    },
  }));

  const first = await repository.recordSourceEvidence(lookupEvidence());
  const second = await repository.recordSourceEvidence(lookupEvidence({
    collectItemId: "collect-b",
    triggerProductDraftId: "draft-b",
    capturedAt: "2026-08-12T01:02:04.000Z",
  }));

  assert.notEqual(second.evidence.id, first.evidence.id);
  assert.notEqual(second.evidence.provenance.sourceRecordId,
    first.evidence.provenance.sourceRecordId);
  assert.equal(state.collectOzonCategoryLookupEvidence.length, 2);
  const current = await repository.readCurrentEvidence({
    accountId: "account-a", collectItemIds: ["collect-a", "collect-b"],
  });
  assert.deepEqual(new Map(current.map((row) => [row.collectItemId, row.id])), new Map([
    ["collect-a", first.evidence.id],
    ["collect-b", second.evidence.id],
  ]));
});

test("JSON lookup cannot create a current pointer without its canonical trigger draft", async () => {
  const state = initializedState();
  const { repository } = createJson({ state });
  const recorded = await repository.recordSourceEvidence(lookupEvidence());

  assert.equal(recorded.evidence.provenance.sourceKind, "OZON_READ_LOOKUP");
  assert.deepEqual(await repository.readCurrentEvidence({
    accountId: "account-a", collectItemIds: ["collect-a"],
  }), []);
});

test("manual confirmation appends provenance and CASes the current draft pointer", async () => {
  const persisted = [];
  const state = { caches: { collectBox: [{
    id: "collect-a", accountId: "account-a", currentDraftId: "draft-a", draftVersion: 7,
  }] } };
  const { repository } = createJson({ state, persist: async (next) => {
    persisted.push(structuredClone(next));
  } });
  const captured = await repository.recordSourceEvidence(sourceEvidence());
  const original = structuredClone(state.collectOzonCategorySourceEvidence[0]);

  const updated = await repository.confirmManualCategory({
    accountId: "account-a",
    collectItemId: "collect-a",
    expectedSourceVersion: "draft:7",
    currentDescriptionCategoryId: 17028788,
    currentTypeId: 95555,
    taxonomyFingerprint: TAXONOMY_HASH,
    validatedAt: VALIDATED_AT,
    actorId: "account-a",
    correlationId: "manual-correlation",
    idempotencyKey: "manual-idempotency",
    requestHash: HASH_B,
  });

  assert.deepEqual(state.collectOzonCategorySourceEvidence[0], original,
    "the captured fact stays byte-for-byte immutable");
  assert.equal(state.collectOzonCategorySourceEvidence.length, 2);
  assert.equal(state.collectOzonCategorySourceEvidence[1].provenance.sourceKind,
    "MANUAL_CONFIRMATION");
  assert.equal(updated.source, "MANUAL");
  assert.equal(updated.version, 1);
  assert.equal(updated.currentDescriptionCategoryId, 17028788);
  assert.notEqual(updated.evidenceId, captured.evidence.id);
  assert.equal(state.collectOzonCategoryCurrentSources[0].evidenceId, updated.evidenceId);
  assert.equal(state.accountOzonSharedCategoryEvents.at(-1).sourceEvidenceId, updated.evidenceId);
  const lastCommit = persisted.at(-1);
  assert.equal(lastCommit.collectOzonCategorySourceEvidence.length, 2);
  assert.equal(lastCommit.accountOzonSharedCategoryEvents.at(-1).eventType,
    "MANUAL_CATEGORY_CONFIRMED");
});

test("manual confirmation can replace older category evidence after the same draft is edited", async () => {
  const state = { caches: { collectBox: [{
    id: "collect-a", accountId: "account-a", currentDraftId: "draft-a", draftVersion: 1,
  }] } };
  const { repository } = createJson({ state });
  await repository.recordSourceEvidence(sourceEvidence({
    sourceVersion: "draft:1", productDraftVersion: 1,
  }));
  state.caches.collectBox[0].draftVersion = 2;

  const updated = await repository.confirmManualCategory({
    accountId: "account-a",
    collectItemId: "collect-a",
    expectedSourceVersion: "draft:2",
    currentDescriptionCategoryId: 17028654,
    currentTypeId: 971445831,
    taxonomyFingerprint: TAXONOMY_HASH,
    validatedAt: VALIDATED_AT,
    actorId: "account-a",
    correlationId: "manual-after-edit-correlation",
    idempotencyKey: "manual-after-edit-idempotency",
    requestHash: HASH_B,
  });

  assert.equal(updated.source, "MANUAL");
  assert.equal(updated.currentDescriptionCategoryId, 17028654);
  assert.equal(updated.currentTypeId, 971445831);
  assert.equal(state.collectOzonCategoryCurrentSources[0].sourceKind, "MANUAL_CONFIRMATION");
  assert.match(state.collectOzonCategoryCurrentSources[0].sourceVersion, /^manual-confirmation:v1:/u);
  assert.equal(state.collectOzonCategoryManualConfirmationEvidence[0].triggerProductDraftVersion, 2);
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
    safeFailureCode: "ZONGZI_CATEGORY_INVALIDATED",
    transitionedAt: VALIDATED_AT,
  }), assertCode("ZONGZI_CATEGORY_SHARED_VERSION_CONFLICT"));

  const invalidated = await repository.invalidateSharedCategory({
    accountId: "account-a",
    evidenceId: recorded.evidence.id,
    expectedVersion: 1,
    safeFailureCode: "ZONGZI_CATEGORY_INVALIDATED",
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
    safeFailureCode: "ZONGZI_TYPE_AMBIGUOUS",
    transitionedAt: "2026-08-12T02:03:05.000Z",
  }), assertCode("ZONGZI_CATEGORY_PERSISTENCE_FAILED"));
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
  }), assertCode("ZONGZI_CATEGORY_SHARED_VERSION_CONFLICT"));
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
  }), assertCode("ACCOUNT_SHARED_ZONGZI_CATEGORY_CONTRACT_INVALID"));
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
    assertCode("ZONGZI_CATEGORY_PERSISTENCE_FAILED"));
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
    error?.code === "ZONGZI_CATEGORY_PERSISTENCE_FAILED"
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
  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d{3}_.+\.sql$/u.test(file)
      && (Number(file.slice(0, 3)) <= 72 || file === "101_manual_category_confirmation_product_revision.sql"))
    .sort();
  assert.equal(files.at(-1), "101_manual_category_confirmation_product_revision.sql");
  return files;
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
    const foreignAccountId = `account-foreign-${suffix}`;
    const storeId = `store-${suffix}`;
    const collectItemId = `collect-${suffix}`;
    const rawId = `raw-${suffix}`;
    const draftId = `draft-${suffix}`;
    const secondCollectItemId = `collect-second-${suffix}`;
    const secondRawId = `raw-second-${suffix}`;
    const secondDraftId = `draft-second-${suffix}`;
    const unresolvedCollectItemId = `collect-unresolved-${suffix}`;
    const unresolvedRawId = `raw-unresolved-${suffix}`;
    const unresolvedDraftId = `draft-unresolved-${suffix}`;
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
        await client.query("UPDATE collect_items SET current_draft_id=$1 WHERE account_id=$2 AND id=$3",
          [draftId, accountId, collectItemId]);
        await client.query(
          `INSERT INTO collect_items (id,account_id,store_id,source,identity_key,source_sku,summary)
           VALUES ($1,$2,$3,'ozon',$4,$5,'{}'::jsonb)`,
          [secondCollectItemId, accountId, storeId, `identity-second-${suffix}`, `SKU-SECOND-${suffix}`],
        );
        await client.query(
          `INSERT INTO collect_raw_payloads
            (id,collect_item_id,account_id,store_id,source_sku,source_url,payload_hash,payload,collected_at)
           VALUES ($1,$2,$3,$4,$5,'https://source.invalid/item',$6,'{}'::jsonb,$7)`,
          [secondRawId, secondCollectItemId, accountId, storeId, `SKU-SECOND-${suffix}`,
            HASH_B, CAPTURED_AT],
        );
        await client.query(
          `INSERT INTO product_drafts
            (id,collect_item_id,source_payload_id,version,data_hash,data,updated_by)
           VALUES ($1,$2,$3,1,$4,'{}'::jsonb,$5)`,
          [secondDraftId, secondCollectItemId, secondRawId, HASH_A, accountId],
        );
        await client.query("UPDATE collect_items SET current_draft_id=$1 WHERE account_id=$2 AND id=$3",
          [secondDraftId, accountId, secondCollectItemId]);
        await client.query(
          `INSERT INTO collect_items (id,account_id,store_id,source,identity_key,source_sku,summary)
           VALUES ($1,$2,$3,'ozon',$4,$5,'{}'::jsonb)`,
          [unresolvedCollectItemId, accountId, storeId, `identity-unresolved-${suffix}`,
            `SKU-UNRESOLVED-${suffix}`],
        );
        await client.query(
          `INSERT INTO collect_raw_payloads
            (id,collect_item_id,account_id,store_id,source_sku,source_url,payload_hash,payload,collected_at)
           VALUES ($1,$2,$3,$4,$5,'https://source.invalid/item',$6,'{}'::jsonb,$7)`,
          [unresolvedRawId, unresolvedCollectItemId, accountId, storeId,
            `SKU-UNRESOLVED-${suffix}`, HASH_A, CAPTURED_AT],
        );
        await client.query(
          `INSERT INTO product_drafts
            (id,collect_item_id,source_payload_id,version,data_hash,data,updated_by)
           VALUES ($1,$2,$3,1,$4,'{}'::jsonb,$5)`,
          [unresolvedDraftId, unresolvedCollectItemId, unresolvedRawId, HASH_B, accountId],
        );
        await client.query(
          `INSERT INTO product_draft_revisions
            (id,draft_id,version,data_hash,data,changed_by,change_reason)
           VALUES ($1,$2,1,$3,'{}'::jsonb,$4,'test source revision')`,
          [`revision-unresolved-${suffix}`, unresolvedDraftId, HASH_B, accountId],
        );
        await client.query("UPDATE collect_items SET current_draft_id=$1 WHERE account_id=$2 AND id=$3",
          [unresolvedDraftId, accountId, unresolvedCollectItemId]);
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

      const secondEvidenceInput = sourceEvidence({
        accountId, collectItemId: secondCollectItemId, sourceVersion: "draft:1",
        productDraftId: secondDraftId, productDraftVersion: 1,
        sourceSku: `SKU-SECOND-${suffix}`, rawResponseRef: secondRawId,
        rawResponseHash: HASH_B,
        sourceDescriptionCategoryId: 17028788, sourceTypeId: 95555,
        provenance: {
          accountId, collectItemId: secondCollectItemId, sourceKind: "PRODUCT_DRAFT",
          sourceRecordId: secondDraftId, rawResponseRef: secondRawId,
          rawResponseHash: HASH_B, capturedAt: CAPTURED_AT,
        },
      });
      const second = await repository.recordSourceEvidence(secondEvidenceInput);

      let confirmationClock = 6;
      const confirmationRuntime = createAccountSharedOzonCategoryRuntime({
        loadState: async () => ({}), saveState: async () => {},
        stateTransaction: { run: async (operation) => operation() },
        persistenceMode: () => "postgres",
        postgresPool: async () => scoped,
        now: () => new Date(`2026-08-12T02:03:0${confirmationClock++}.000Z`),
        randomUUID: sequential(`runtime-${suffix}`),
      });
      const unresolvedRuntime = createAccountSharedOzonCategoryRuntime({
        loadState: async () => ({}), saveState: async () => {},
        stateTransaction: { run: async (operation) => operation() },
        persistenceMode: () => "postgres", postgresPool: async () => scoped,
        sourceLookup: { async lookup() { return Object.freeze({ status: "UNRESOLVED" }); } },
        now: () => new Date(CAPTURED_AT), randomUUID: sequential(`unresolved-${suffix}`),
      });
      const unresolved = await unresolvedRuntime.recordCollectionResult({
        postgresExecutor: scoped, accountId, collectItemId: unresolvedCollectItemId,
        item: { sourceSku: `SKU-UNRESOLVED-${suffix}`, listingDraft: { sourceCategory: {} } },
        sourceVersion: "draft:1", productDraftId: unresolvedDraftId, productDraftVersion: 1,
        rawResponseRef: unresolvedRawId, rawResponseHash: HASH_A, capturedAt: CAPTURED_AT,
        lookupContext: { accountId, store: { clientId: "fixture", apiKey: "fixture" },
          sourceSku: `SKU-UNRESOLVED-${suffix}`, ozonProductId: null },
      });
      assert.equal(unresolved.categoryResolution.status, "NEEDS_REVIEW");
      assert.equal((await scoped.query(
        "SELECT COUNT(*)::INT AS count FROM collect_ozon_category_source_evidence WHERE account_id=$1 AND collect_item_id=$2",
        [accountId, unresolvedCollectItemId],
      )).rows[0].count, 0, "an unresolved exact lookup writes no source evidence");
      const beforeRejectedConfirmation = (await scoped.query(`
        SELECT
          (SELECT COUNT(*)::INT FROM collect_ozon_category_source_evidence WHERE account_id=$1) AS evidence,
          (SELECT COUNT(*)::INT FROM collect_ozon_category_manual_confirmation_evidence WHERE account_id=$1) AS manual,
          (SELECT COUNT(*)::INT FROM account_ozon_category_confirmation_audit WHERE account_id=$1) AS audit
      `, [accountId])).rows[0];
      for (const rejected of [
        { actor: { id: accountId, role: "admin" }, collectItemId: unresolvedCollectItemId,
          expectedSourceVersion: "draft:2" },
        { actor: { id: foreignAccountId, role: "admin" }, collectItemId: unresolvedCollectItemId,
          expectedSourceVersion: "draft:1" },
      ]) {
        await assert.rejects(confirmationRuntime.confirmManualCategory({
          ...rejected, descriptionCategoryId: 17028788, typeId: 95555,
          taxonomyScope: "OZON:DEFAULT", idempotencyKey: `rejected-${rejected.actor.id}-${suffix}`,
          correlationId: `rejected-correlation-${rejected.actor.id}-${suffix}`,
        }));
      }
      assert.deepEqual((await scoped.query(`
        SELECT
          (SELECT COUNT(*)::INT FROM collect_ozon_category_source_evidence WHERE account_id=$1) AS evidence,
          (SELECT COUNT(*)::INT FROM collect_ozon_category_manual_confirmation_evidence WHERE account_id=$1) AS manual,
          (SELECT COUNT(*)::INT FROM account_ozon_category_confirmation_audit WHERE account_id=$1) AS audit
      `, [accountId])).rows[0], beforeRejectedConfirmation,
      "stale and cross-account confirmations leave provenance and audit unchanged");
      const manual = await confirmationRuntime.confirmManualCategory({
        actor: { id: accountId, role: "admin" }, collectItemId: unresolvedCollectItemId,
        expectedSourceVersion: "draft:1", descriptionCategoryId: 17028788, typeId: 95555,
        taxonomyScope: "OZON:DEFAULT", idempotencyKey: `manual-${suffix}`,
        correlationId: `correlation-manual-${suffix}`,
      });
      const manualReplay = await confirmationRuntime.confirmManualCategory({
        actor: { id: accountId, role: "admin" }, collectItemId: unresolvedCollectItemId,
        expectedSourceVersion: "draft:1", descriptionCategoryId: 17028788, typeId: 95555,
        taxonomyScope: "OZON:DEFAULT", idempotencyKey: `manual-${suffix}`,
        correlationId: `correlation-manual-${suffix}`,
      });
      assert.deepEqual(manualReplay, manual);
      assert.equal(manual.categoryResolution.version, 2);
      assert.equal(manual.categoryResolution.source, "MANUAL");
      assert.equal((await repository.readSharedForEvidence({
        accountId, evidenceIds: [second.evidence.id],
      }))[0].source, "MANUAL", "same signature immediately shares manual selection");
      const corrected = await confirmationRuntime.confirmManualCategory({
        actor: { id: accountId, role: "admin" }, collectItemId: unresolvedCollectItemId,
        expectedSourceVersion: "draft:1", descriptionCategoryId: 17028789, typeId: 95556,
        taxonomyScope: "OZON:DEFAULT", idempotencyKey: `correction-${suffix}`,
        correlationId: `correlation-correction-${suffix}`,
      });
      assert.equal(corrected.categoryResolution.version, 1);
      assert.equal((await scoped.query(
        "SELECT COUNT(*)::INT AS count FROM account_ozon_category_confirmation_audit WHERE account_id=$1",
        [accountId],
      )).rows[0].count, 2);
      const confirmationAuditId = (await scoped.query(
        "SELECT id FROM account_ozon_category_confirmation_audit WHERE account_id=$1 ORDER BY id LIMIT 1",
        [accountId],
      )).rows[0].id;
      await assert.rejects(scoped.query(
        "UPDATE account_ozon_category_confirmation_audit SET correlation_id='changed' WHERE id=$1",
        [confirmationAuditId],
      ), (error) => error?.code === "23514");
      await assert.rejects(scoped.query(
        "DELETE FROM account_ozon_category_confirmation_audit WHERE id=$1",
        [confirmationAuditId],
      ), (error) => error?.code === "23514");
      const manualObservationId = (await scoped.query(
        "SELECT id FROM collect_ozon_category_manual_confirmation_evidence WHERE account_id=$1 ORDER BY id LIMIT 1",
        [accountId],
      )).rows[0].id;
      await assert.rejects(scoped.query(
        "UPDATE collect_ozon_category_manual_confirmation_evidence SET correlation_id='changed' WHERE account_id=$1 AND id=$2",
        [accountId, manualObservationId],
      ), (error) => error?.code === "23514");
      await assert.rejects(scoped.query(
        "DELETE FROM collect_ozon_category_manual_confirmation_evidence WHERE account_id=$1 AND id=$2",
        [accountId, manualObservationId],
      ), (error) => error?.code === "23514");
      assert.equal((await scoped.query(
        "SELECT COUNT(*)::INT AS count FROM collect_ozon_category_source_evidence WHERE account_id=$1",
        [accountId],
      )).rows[0].count, 4, "each manual confirmation appends a distinct source observation");

      await scoped.query(
        `INSERT INTO product_draft_revisions
          (id,draft_id,version,data_hash,data,changed_by,change_reason)
         VALUES ($1,$2,2,$3,'{}'::jsonb,$4,'test later revision')`,
        [`revision-unresolved-v2-${suffix}`, unresolvedDraftId, HASH_A, accountId],
      );
      await assert.doesNotReject(scoped.query(
        "UPDATE product_drafts SET version=2,data_hash=$2 WHERE id=$1",
        [unresolvedDraftId, HASH_A],
      ));
      assert.deepEqual((await scoped.query(
        `SELECT trigger_product_draft_version
           FROM collect_ozon_category_manual_confirmation_evidence
          WHERE account_id=$1 AND collect_item_id=$2
          ORDER BY captured_at,id`,
        [accountId, unresolvedCollectItemId],
      )).rows.map((row) => Number(row.trigger_product_draft_version)), [1, 1]);

      const lookup = await repository.recordSourceEvidence(lookupEvidence({
        accountId, collectItemId, sku: `SKU-${suffix}`,
        triggerProductDraftId: draftId, triggerProductDraftVersion: 7,
      }));
      assert.equal(lookup.evidence.provenance.sourceKind, "OZON_READ_LOOKUP");
      assert.equal((await scoped.query(
        "SELECT COUNT(*)::INT AS count FROM collect_ozon_category_lookup_evidence WHERE account_id=$1",
        [accountId],
      )).rows[0].count, 1);
      const lookupReplay = await repository.recordSourceEvidence(lookupEvidence({
        accountId, collectItemId, sku: `SKU-${suffix}`,
        triggerProductDraftId: draftId, triggerProductDraftVersion: 7,
        capturedAt: "2026-08-12T01:02:04.000Z",
      }));
      assert.equal(lookupReplay.evidence.id, lookup.evidence.id);
      assert.equal(lookupReplay.evidence.capturedAt, CAPTURED_AT,
        "PostgreSQL replay returns the persisted observation clock");
      assert.equal((await scoped.query(
        "SELECT COUNT(*)::INT AS count FROM collect_ozon_category_lookup_evidence WHERE account_id=$1",
        [accountId],
      )).rows[0].count, 1, "same observation replay adds no lookup metadata");

      const secondItemLookup = await repository.recordSourceEvidence(lookupEvidence({
        accountId, collectItemId: secondCollectItemId, sku: `SKU-${suffix}`,
        triggerProductDraftId: secondDraftId, triggerProductDraftVersion: 1,
        capturedAt: "2026-08-12T01:02:04.000Z",
      }));
      assert.notEqual(secondItemLookup.evidence.id, lookup.evidence.id);
      assert.notEqual(secondItemLookup.evidence.provenance.sourceRecordId,
        lookup.evidence.provenance.sourceRecordId);
      assert.equal((await repository.readCurrentEvidence({
        accountId, collectItemIds: [secondCollectItemId],
      }))[0].id, secondItemLookup.evidence.id,
      "same account/request/response stays scoped to the second item");

      await scoped.query("UPDATE product_drafts SET version=8 WHERE id=$1", [draftId]);
      await repository.recordSourceEvidence(sourceEvidence({
        ...evidenceInput, sourceVersion: "draft:8", productDraftVersion: 8,
      }));
      const lateLookupHash = crypto.createHash("sha256").update(`late-${suffix}`).digest("hex");
      const [nextLookup] = await Promise.all([
        repository.recordSourceEvidence(lookupEvidence({
          accountId, collectItemId, sku: `SKU-${suffix}`, hash: HASH_B,
          triggerProductDraftId: draftId, triggerProductDraftVersion: 8,
          capturedAt: "2026-08-12T01:02:05.000Z",
        })),
        repository.recordSourceEvidence(lookupEvidence({
          accountId, collectItemId, sku: `SKU-${suffix}`, hash: lateLookupHash,
          triggerProductDraftId: draftId, triggerProductDraftVersion: 7,
        })),
      ]);
      assert.notEqual(nextLookup.evidence.id, lookup.evidence.id,
        "a newer trigger draft creates an independent observation for the same response");
      assert.notEqual(nextLookup.evidence.sourceVersion, lookup.evidence.sourceVersion);
      await repository.recordSourceEvidence(lookupEvidence({
        accountId, collectItemId, sku: `SKU-${suffix}`,
        triggerProductDraftId: draftId, triggerProductDraftVersion: 7,
      }));
      assert.equal((await repository.readCurrentEvidence({
        accountId, collectItemIds: [collectItemId],
      }))[0].id, nextLookup.evidence.id,
      "replay and late stale lookup cannot roll the PostgreSQL pointer backward");

      const rollbackHash = crypto.createHash("sha256").update(`rollback-${suffix}`).digest("hex");
      const rollbackInput = lookupEvidence({
        accountId, collectItemId, productId: 777777, sku: `SKU-${suffix}`, hash: rollbackHash,
        triggerProductDraftId: draftId, triggerProductDraftVersion: 8,
      });
      const rollbackRef = rollbackInput.rawResponseRef;
      await scoped.query(`CREATE FUNCTION reject_task3_lookup_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.source_record_id='${rollbackRef}' THEN RAISE EXCEPTION 'controlled rollback'; END IF;
        RETURN NEW; END $$`);
      await scoped.query(`CREATE TRIGGER reject_task3_lookup_evidence BEFORE INSERT
        ON collect_ozon_category_source_evidence FOR EACH ROW EXECUTE FUNCTION reject_task3_lookup_evidence()`);
      await assert.rejects(repository.recordSourceEvidence(rollbackInput),
        assertCode("ZONGZI_CATEGORY_PERSISTENCE_FAILED"));
      assert.equal((await scoped.query(
        "SELECT COUNT(*)::INT AS count FROM collect_ozon_category_lookup_evidence WHERE account_id=$1 AND id=$2",
        [accountId, rollbackRef],
      )).rows[0].count, 0, "lookup provenance rolls back with failed evidence");
      await scoped.query("DROP TRIGGER reject_task3_lookup_evidence ON collect_ozon_category_source_evidence");
      await scoped.query("DROP FUNCTION reject_task3_lookup_evidence()");

      const foreignCollectItemId = `collect-foreign-${suffix}`;
      const foreignRawId = `raw-foreign-${suffix}`;
      const foreignDraftId = `draft-foreign-${suffix}`;
      await scoped.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [foreignAccountId, `user-foreign-${suffix}`],
      );
      await scoped.query(
        `INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary)
         VALUES ($1,$2,'ozon',$3,$4,'{}'::jsonb)`,
        [foreignCollectItemId, foreignAccountId, `identity-foreign-${suffix}`, `SKU-${suffix}`],
      );
      await scoped.query(
        `INSERT INTO collect_raw_payloads
          (id,collect_item_id,account_id,source_sku,source_url,payload_hash,payload,collected_at)
         VALUES ($1,$2,$3,$4,'https://source.invalid/foreign',$5,'{}'::jsonb,$6)`,
        [foreignRawId, foreignCollectItemId, foreignAccountId, `SKU-${suffix}`, HASH_A, CAPTURED_AT],
      );
      await scoped.query(
        `INSERT INTO product_drafts
          (id,collect_item_id,source_payload_id,version,data_hash,data,updated_by)
         VALUES ($1,$2,$3,1,$4,'{}'::jsonb,$5)`,
        [foreignDraftId, foreignCollectItemId, foreignRawId, HASH_B, foreignAccountId],
      );
      await scoped.query(
        `INSERT INTO product_draft_revisions
          (id,draft_id,version,data_hash,data,changed_by,change_reason)
         VALUES ($1,$2,1,$3,'{}'::jsonb,$4,'test foreign source revision')`,
        [`revision-foreign-${suffix}`, foreignDraftId, HASH_B, foreignAccountId],
      );
      await scoped.query("UPDATE collect_items SET current_draft_id=$1 WHERE id=$2",
        [foreignDraftId, foreignCollectItemId]);
      const foreignLookup = await repository.recordSourceEvidence(lookupEvidence({
        accountId: foreignAccountId, collectItemId: foreignCollectItemId, sku: `SKU-${suffix}`,
        triggerProductDraftId: foreignDraftId, triggerProductDraftVersion: 1,
      }));
      assert.equal((await repository.readCurrentEvidence({
        accountId: foreignAccountId, collectItemIds: [foreignCollectItemId],
      }))[0].id, foreignLookup.evidence.id);
      assert.deepEqual(await repository.readCurrentEvidence({
        accountId, collectItemIds: [foreignCollectItemId],
      }), []);
      const foreignConfirmationRuntime = createAccountSharedOzonCategoryRuntime({
        loadState: async () => ({}), saveState: async () => {},
        stateTransaction: { run: async (operation) => operation() },
        persistenceMode: () => "postgres", postgresPool: async () => scoped,
        now: () => new Date(CAPTURED_AT), randomUUID: sequential(`foreign-runtime-${suffix}`),
      });
      await foreignConfirmationRuntime.confirmManualCategory({
        actor: { id: foreignAccountId, role: "admin" },
        collectItemId: foreignCollectItemId,
        expectedSourceVersion: "draft:1",
        descriptionCategoryId: 17028702,
        typeId: 94405,
        taxonomyScope: "OZON:DEFAULT",
        idempotencyKey: `foreign-idempotency-${suffix}`,
        correlationId: `foreign-correlation-${suffix}`,
      });
      const foreignAuditId = (await scoped.query(
        "SELECT id FROM account_ozon_category_confirmation_audit WHERE account_id=$1",
        [foreignAccountId],
      )).rows[0].id;
      await assert.rejects(scoped.query(
        "DELETE FROM account_ozon_category_confirmation_audit WHERE id=$1", [foreignAuditId],
      ), (error) => error?.code === "23514");
      const deletionState = { auditEvents: [] };
      Object.defineProperty(deletionState, "__deletedAccountScopes", {
        value: [{
          accountId: foreignAccountId,
          storeIds: [],
          legacyDataStorePurgePolicy: {
            actor: { type: "account", id: accountId },
            reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
            occurredAt: VALIDATED_AT,
          },
        }],
        enumerable: false, configurable: true,
      });
      const deletionClient = await scoped.connect();
      let deletion;
      try {
        await deletionClient.query("BEGIN");
        deletion = await deleteRemovedAccountScopes(deletionClient, deletionState);
        await deletionClient.query("COMMIT");
        deletion.afterCommit();
      } catch (error) {
        await deletionClient.query("ROLLBACK");
        throw error;
      } finally {
        deletionClient.release();
      }
      assert.equal((await scoped.query(
        "SELECT COUNT(*)::INT AS count FROM accounts WHERE id=$1", [foreignAccountId],
      )).rows[0].count, 0);
      assert.equal((await scoped.query(
        "SELECT COUNT(*)::INT AS count FROM account_ozon_category_confirmation_audit WHERE id=$1",
        [foreignAuditId],
      )).rows[0].count, 0, "formal account cleanup cascades confirmation ledger rows");

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

      await assert.rejects(repository.invalidateSharedCategory({
        accountId,
        evidenceId: first.evidence.id,
        expectedVersion: 2,
        safeFailureCode: "ZONGZI_CATEGORY_INVALIDATED",
        transitionedAt: "2026-08-12T02:03:05.000Z",
      }), assertCode("ZONGZI_CATEGORY_SHARED_VERSION_CONFLICT"));

      const counts = (await scoped.query(`
        SELECT
          (SELECT COUNT(*)::INT FROM collect_ozon_category_source_evidence WHERE account_id=$1) AS evidence,
          (SELECT COUNT(*)::INT FROM account_ozon_shared_categories WHERE account_id=$1) AS shared,
          (SELECT COUNT(*)::INT FROM account_ozon_shared_category_events WHERE account_id=$1) AS events
      `, [accountId])).rows[0];
      assert.deepEqual(counts, { evidence: 10, shared: 4, events: 6 });
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
