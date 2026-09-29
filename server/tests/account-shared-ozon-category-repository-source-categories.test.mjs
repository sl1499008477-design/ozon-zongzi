import assert from "node:assert/strict";
import test from "node:test";
import {
  createJsonAccountSharedOzonCategoryRepository,
  createPostgresAccountSharedOzonCategoryRepository,
} from "../account-shared-ozon-category-repository.mjs";

const CATEGORY_A = { sourceDescriptionCategoryId: 17028702, sourceTypeId: 94405, taxonomyScope: "OZON:DEFAULT" };
const CATEGORY_B = { sourceDescriptionCategoryId: 17028654, sourceTypeId: 971445831, taxonomyScope: "OZON:DEFAULT" };
const NOW = "2026-09-10T01:00:00.000Z";

function shared(overrides = {}) {
  return {
    id: "shared-a", accountId: "account-a", ...CATEGORY_A,
    currentDescriptionCategoryId: 17028654, currentTypeId: 971445831,
    status: "ACTIVE", source: "OZON_REFRESH", taxonomyFingerprint: "ab".repeat(32),
    version: 4, evidenceId: "deleted-source-evidence", validatedAt: NOW,
    ...overrides,
  };
}

test("JSON source-category reads survive deleted collection evidence and match whole account-scoped pairs", async () => {
  const state = { accountOzonSharedCategories: [
    shared(),
    shared({ id: "shared-b", ...CATEGORY_B, status: "NEEDS_REVIEW", version: 8 }),
    shared({ id: "crossed-pair", sourceTypeId: CATEGORY_B.sourceTypeId }),
    shared({ id: "foreign", accountId: "account-b" }),
  ] };
  const before = structuredClone(state);
  const repository = createJsonAccountSharedOzonCategoryRepository({ state, persist: async () => {
    assert.fail("source-category reads must not backfill or persist deleted collection state");
  } });
  const result = await repository.readSharedForSourceCategories({
    accountId: "account-a", categories: [CATEGORY_A, CATEGORY_B, CATEGORY_A],
  });
  assert.deepEqual(result.map((row) => [row.accountId, row.sourceDescriptionCategoryId,
    row.sourceTypeId, row.currentDescriptionCategoryId, row.currentTypeId, row.status, row.version]), [
    ["account-a", 17028702, 94405, 17028654, 971445831, "ACTIVE", 4],
    ["account-a", 17028654, 971445831, 17028654, 971445831, "NEEDS_REVIEW", 8],
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result[0]));
  assert.deepEqual(state, before);
  assert.deepEqual(await repository.readSharedForSourceCategories({
    accountId: "account-a", categories: [{ ...CATEGORY_A, sourceTypeId: 999999 }],
  }), []);
});

test("source-category reads expose current invalidated/review versions without falling back to a frozen category", async () => {
  const state = { accountOzonSharedCategories: [shared()] };
  const repository = createJsonAccountSharedOzonCategoryRepository({ state });
  for (const [status, version] of [["ACTIVE", 4], ["INVALIDATED", 5], ["NEEDS_REVIEW", 6]]) {
    Object.assign(state.accountOzonSharedCategories[0], { status, version });
    const [result] = await repository.readSharedForSourceCategories({ accountId: "account-a", categories: [CATEGORY_A] });
    assert.equal(result.status, status);
    assert.equal(result.version, version);
    assert.equal(result.currentDescriptionCategoryId, 17028654);
    assert.equal(result.sourceDescriptionCategoryId, 17028702);
  }
});

test("PostgreSQL source-category reads use one account-scoped query with paired IDs and no evidence join", async () => {
  const calls = [];
  const repository = createPostgresAccountSharedOzonCategoryRepository({ pool: { async query(sql, params) {
    calls.push({ sql, params });
    return { rows: [{
      id: "shared-a", account_id: "account-a", source_description_category_id: "17028702",
      source_type_id: "94405", taxonomy_scope: "OZON:DEFAULT",
      current_description_category_id: "17028654", current_type_id: "971445831",
      status: "INVALIDATED", source: "OZON_REFRESH", taxonomy_fingerprint: "ab".repeat(32),
      safe_failure_code: "ZONGZI_CATEGORY_INVALIDATED", version: 5,
      source_evidence_id: "deleted-source-evidence", validated_at: new Date(NOW),
      created_at: new Date(NOW), updated_at: new Date(NOW),
    }] };
  } } });
  const [result] = await repository.readSharedForSourceCategories({
    accountId: "account-a", categories: [CATEGORY_A, CATEGORY_B],
  });
  assert.deepEqual([result.accountId, result.sourceDescriptionCategoryId, result.sourceTypeId,
    result.currentDescriptionCategoryId, result.currentTypeId, result.status, result.version],
  ["account-a", 17028702, 94405, 17028654, 971445831, "INVALIDATED", 5]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM account_ozon_shared_categories/iu);
  assert.match(calls[0].sql, /shared.account_id\s*=\s*\$1/iu);
  assert.match(calls[0].sql, /unnest\(\$2::bigint\[\],\s*\$3::bigint\[\],\s*\$4::text\[\]\)/iu);
  assert.doesNotMatch(calls[0].sql, /collect_ozon|collect_items|JOIN|INSERT|UPDATE/iu);
  assert.deepEqual(calls[0].params, ["account-a", [17028702, 17028654],
    [94405, 971445831], ["OZON:DEFAULT", "OZON:DEFAULT"]]);
  assert.ok(Object.isFrozen(result));
});

test("source-category query inputs require only a valid account and genuine source category identities", async () => {
  const repositories = [createJsonAccountSharedOzonCategoryRepository({ state: {}, persist: async () => {
    assert.fail("a source-category read must not persist");
  } }), createPostgresAccountSharedOzonCategoryRepository({ pool: { async query() {
    assert.fail("empty or invalid input must not issue SQL");
  } } })];
  let executed = 0;
  const accessor = { ...CATEGORY_A };
  Object.defineProperty(accessor, "sourceTypeId", { enumerable: true, get() { executed += 1; return 94405; } });
  const listAccessor = [CATEGORY_A];
  Object.defineProperty(listAccessor, "0", { enumerable: true, get() { executed += 1; return CATEGORY_A; } });
  const fixtures = [
    { accountId: "", categories: [CATEGORY_A] },
    { accountId: "account-a", categories: null },
    { accountId: "account-a", categories: [{ ...CATEGORY_A, accountId: "account-b" }] },
    { accountId: "account-a", categories: [{ ...CATEGORY_A, sourceDescriptionCategoryId: 0 }] },
    { accountId: "account-a", categories: [{ ...CATEGORY_A, sourceTypeId: true }] },
    { accountId: "account-a", categories: [{ ...CATEGORY_A, sourceTypeId: "94405" }] },
    { accountId: "account-a", categories: [{ ...CATEGORY_A, taxonomyScope: "OTHER" }] },
    { accountId: "account-a", categories: [{ sourceTypeId: 94405, taxonomyScope: "OZON:DEFAULT" }] },
    { accountId: "account-a", categories: [CATEGORY_A], storeId: "store-override" },
    { accountId: "account-a", categories: new Array(1) },
    { accountId: "account-a", categories: Array(501).fill(CATEGORY_A) },
    { accountId: "account-a", categories: [accessor] },
    { accountId: "account-a", categories: listAccessor },
    { accountId: "account-a", categories: new Proxy([], { get() { executed += 1; return 1; } }) },
  ];
  for (const repository of repositories) {
    assert.deepEqual(await repository.readSharedForSourceCategories({ accountId: "account-a", categories: [] }), []);
    for (const input of fixtures) {
      await assert.rejects(repository.readSharedForSourceCategories(input),
        { code: "ACCOUNT_SHARED_ZONGZI_CATEGORY_CONTRACT_INVALID" });
    }
  }
  assert.equal(executed, 0);
});

test("source-category query database errors expose only the safe persistence failure", async () => {
  const repository = createPostgresAccountSharedOzonCategoryRepository({ pool: { async query() {
    throw new Error("password=private database detail");
  } } });
  await assert.rejects(repository.readSharedForSourceCategories({ accountId: "account-a", categories: [CATEGORY_A] }),
    (error) => error.code === "ZONGZI_CATEGORY_PERSISTENCE_FAILED" && error.status === 500
      && !error.message.includes("private") && !Object.hasOwn(error, "cause"));
});
