import assert from "node:assert/strict";
import test from "node:test";

process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

const {
  mirrorStateToRelationalTables,
  normalizeFormalAccountMirrorRecord,
} = await import("../formal-persistence.mjs");
const {
  purgeLegacyDataCollectionStoresForAccount,
  readLegacyDataCollectionStoresForAudit,
} = await import(
  "../legacy-data-collection-store.mjs"
);

test("formal account mirroring rejects an ID-only placeholder before SQL persistence", () => {
  assert.throws(
    () => normalizeFormalAccountMirrorRecord({ id: "account-a" }),
    (error) => error?.code === "FORMAL_ACCOUNT_RECORD_INCOMPLETE",
  );
  assert.deepEqual(normalizeFormalAccountMirrorRecord({
    id: " admin-a ",
    username: " admin ",
    displayName: "管理员",
  }), {
    id: "admin-a",
    username: "admin",
    displayName: "管理员",
  });
});

test("historical data-collection stores remain account-scoped and read-only", async () => {
  const calls = [];
  const pool = {
    async query(query, params) {
      calls.push({ sql: String(query), params });
      return {
        rows: [{
          data_collection_store_id: "legacy-data-store-a",
          account_id: "account-a",
          seller_company_id: "seller-company-a",
          label: "Historical A",
          status: "disabled",
          note: "audit evidence",
          is_current: false,
          last_verified_at: "2026-07-01T00:00:00.000Z",
          membership_created_at: "2026-06-01T00:00:00.000Z",
          membership_updated_at: "2026-07-01T00:00:00.000Z",
        }],
      };
    },
  };

  const records = await readLegacyDataCollectionStoresForAudit(pool, {
    accountId: " account-a ",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /\bSELECT\b/i);
  assert.match(calls[0].sql, /\bdata_collection_stores\b/i);
  assert.match(calls[0].sql, /\baccount_data_collection_stores\b/i);
  assert.doesNotMatch(calls[0].sql, /\b(?:INSERT|UPDATE|DELETE)\b/i);
  assert.deepEqual(calls[0].params, ["account-a"]);
  assert.deepEqual(records, [{
    id: "legacy-data-store-a",
    accountId: "account-a",
    sellerCompanyId: "seller-company-a",
    label: "Historical A",
    status: "disabled",
    note: "audit evidence",
    isCurrent: false,
    lastVerifiedAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    readOnly: true,
  }]);
});

test("historical data-store reads require an explicit account boundary", async () => {
  await assert.rejects(
    readLegacyDataCollectionStoresForAudit({ query: async () => ({ rows: [] }) }, {
      accountId: " ",
    }),
    (error) => error?.code === "ACCOUNT_SCOPE_REQUIRED",
  );
});

test("legacy data-store privacy purge requires explicit account, reason, actor, and time", async () => {
  const noQueryClient = {
    async query() {
      assert.fail("invalid purge policy must fail before SQL");
    },
  };
  const valid = {
    accountId: "account-a",
    reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
    actor: { type: "account", id: "admin-a" },
    occurredAt: "2026-07-30T09:30:00.000Z",
  };

  for (const missing of ["accountId", "reason", "actor", "occurredAt"]) {
    await assert.rejects(
      purgeLegacyDataCollectionStoresForAccount(noQueryClient, {
        ...valid,
        [missing]: missing === "actor" ? { type: "account", id: "" } : "",
      }),
      (error) => error?.code === "LEGACY_PURGE_POLICY_REQUIRED",
      missing,
    );
  }
});

test("legacy data-store privacy purge is account-scoped, transactional, counted, and audited", async () => {
  const calls = [];
  const client = {
    async query(query, params = []) {
      const sql = String(query).replace(/\s+/g, " ").trim();
      calls.push({ sql, params });
      if (sql.startsWith("SELECT m.account_id")) {
        return {
          rows: [{
            account_id: "account-a",
            data_collection_store_id: "legacy-a-1",
          }, {
            account_id: "account-a",
            data_collection_store_id: "legacy-a-2",
          }],
          rowCount: 2,
        };
      }
      if (sql.startsWith("DELETE FROM collection_store_verifications")) {
        return { rows: [], rowCount: 3 };
      }
      if (sql.startsWith("DELETE FROM account_data_collection_stores")) {
        return { rows: [{ data_collection_store_id: "legacy-a-1" }], rowCount: 2 };
      }
      if (sql.startsWith("DELETE FROM data_collection_stores")) {
        return { rows: [{ id: "legacy-a-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  const result = await purgeLegacyDataCollectionStoresForAccount(client, {
    accountId: " account-a ",
    reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
    actor: { type: "account", id: "admin-a" },
    occurredAt: "2026-07-30T09:30:00.000Z",
  });

  assert.deepEqual(result, {
    accountId: "account-a",
    legacyRecordCount: 2,
    verificationDeletedCount: 3,
    membershipDeletedCount: 2,
    orphanStoreDeletedCount: 1,
    auditEventId: "legacy-data-store-purge:account-a:2026-07-30T09:30:00.000Z",
  });
  assert.equal(calls[0].sql, "SAVEPOINT legacy_data_store_account_purge");
  assert.match(calls[1].sql, /WHERE m\.account_id=\$1/);
  assert.deepEqual(calls[1].params, ["account-a"]);
  const verificationDelete = calls.find((call) =>
    call.sql.startsWith("DELETE FROM collection_store_verifications"));
  assert.deepEqual(verificationDelete.params, ["account-a"]);
  assert.doesNotMatch(
    verificationDelete.sql,
    /data_collection_store_id|account_id\s*=\s*\$1\s+OR/i,
  );
  assert.equal(
    calls.at(-1).sql,
    "RELEASE SAVEPOINT legacy_data_store_account_purge",
  );

  const audit = calls.find((call) => call.sql.startsWith("INSERT INTO audit_events"));
  assert.ok(audit, "purge must append an audit event in the same transaction");
  assert.equal(audit.params[0], result.auditEventId);
  assert.equal(audit.params[1], "account-a");
  assert.equal(audit.params[4], "account");
  assert.equal(audit.params[5], "admin-a");
  assert.equal(audit.params[9], "2026-07-30T09:30:00.000Z");
  assert.deepEqual(JSON.parse(audit.params[8]), {
    reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
    legacyRecordCount: 2,
    verificationDeletedCount: 3,
    membershipDeletedCount: 2,
    orphanStoreDeletedCount: 1,
  });
});

test("legacy data-store privacy purge rolls back its savepoint on failure", async () => {
  const calls = [];
  const client = {
    async query(query) {
      const sql = String(query).replace(/\s+/g, " ").trim();
      calls.push(sql);
      if (sql.startsWith("SELECT m.account_id")) {
        return {
          rows: [{
            account_id: "account-a",
            data_collection_store_id: "legacy-a-1",
          }],
        };
      }
      if (sql.startsWith("DELETE FROM collection_store_verifications")) {
        throw new Error("forced purge failure");
      }
      return { rows: [], rowCount: 0 };
    },
  };

  await assert.rejects(
    purgeLegacyDataCollectionStoresForAccount(client, {
      accountId: "account-a",
      reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
      actor: { type: "system", id: "account-deletion-test" },
      occurredAt: "2026-07-30T09:31:00.000Z",
    }),
    /forced purge failure/,
  );
  assert.deepEqual(calls.slice(-2), [
    "ROLLBACK TO SAVEPOINT legacy_data_store_account_purge",
    "RELEASE SAVEPOINT legacy_data_store_account_purge",
  ]);
});

test("ordinary formal mirroring cannot invoke legacy evidence purge", async () => {
  const sql = [];
  const client = {
    async query(query) {
      const normalized = String(query).replace(/\s+/g, " ").trim();
      sql.push(normalized);
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  await mirrorStateToRelationalTables({ connect: async () => client }, {
    accounts: [],
    stores: [],
    sessions: {},
    caches: {
      files: [],
      warehouses: [],
      products: [],
      postings: [],
    },
    jobs: {},
    auditEvents: [],
  });

  assert.equal(sql.some((statement) => statement.startsWith("SAVEPOINT legacy_data_store")), false);
  assert.equal(
    sql.some((statement) => statement.includes("LEGACY_DATA_COLLECTION_STORE_PURGED")),
    false,
  );
});

test("formal mirror assigns a legacy ownerless store to the current account", async () => {
  const accountId = "acct_legacy_owner";
  const storeId = "store_legacy_ownerless";
  const state = {
    accounts: [{
      id: accountId,
      username: "legacy-owner",
      displayName: "Legacy Owner",
      role: "admin",
      status: "active",
    }],
    sessions: {},
    currentAccountId: accountId,
    currentStoreId: storeId,
    currentStoreIdsByAccount: {},
    stores: [{
      id: storeId,
      label: "Legacy Store",
      clientId: "legacy-client",
      status: "active",
    }],
    caches: {
      files: [],
      warehouses: [],
      products: [],
      postings: [],
    },
    jobs: {},
  };

  assert.equal(Object.hasOwn(state.stores[0], "ownerAccountId"), false);

  const trace = [];
  let storeInsertParams = null;
  let released = false;
  const client = {
    async query(query, params = []) {
      const sql = String(query?.text || query || "").trim();
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") trace.push(sql);
      if (/INSERT INTO stores\s*\(/i.test(sql)) {
        trace.push("INSERT_STORE");
        storeInsertParams = params;
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
  };

  await mirrorStateToRelationalTables(pool, state);

  assert.ok(storeInsertParams, "legacy store must be mirrored");
  assert.equal(storeInsertParams[0], storeId);
  assert.equal(storeInsertParams[1], accountId);
  assert.notEqual(storeInsertParams[1], "", "mirrored owner_account_id must not be empty");
  assert.equal(storeInsertParams[11], true, "legacy current store must remain current for its inferred owner");
  assert.deepEqual(trace, ["BEGIN", "INSERT_STORE", "COMMIT"]);
  assert.equal(released, true);
});

test("formal mirror preserves an existing relational owner for a legacy store", async () => {
  const ownerA = "acct_current";
  const ownerB = "acct_existing_owner";
  const storeId = "store_existing_owner";
  const state = {
    accounts: [
      { id: ownerA, username: "current", role: "admin", status: "active" },
      { id: ownerB, username: "owner", role: "user", status: "active" },
    ],
    sessions: {},
    currentAccountId: ownerA,
    currentStoreId: "",
    currentStoreIdsByAccount: { [ownerB]: storeId },
    stores: [{ id: storeId, label: "Mapped Store", clientId: "mapped-client", status: "active" }],
    caches: { files: [], warehouses: [], products: [], postings: [] },
    jobs: {},
  };
  let storeInsertParams = null;
  const client = {
    async query(query, params = []) {
      const sql = String(query?.text || query || "").trim();
      if (sql.startsWith("SELECT id, owner_account_id FROM stores")) {
        return { rows: [{ id: storeId, owner_account_id: ownerB }], rowCount: 1 };
      }
      if (/INSERT INTO stores\s*\(/i.test(sql)) storeInsertParams = params;
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  await mirrorStateToRelationalTables({ connect: async () => client }, state);

  assert.ok(storeInsertParams);
  assert.equal(storeInsertParams[1], ownerB);
  assert.equal(storeInsertParams[11], true);
  assert.equal(state.stores[0].ownerAccountId, ownerB, "the loaded state must retain the authoritative owner");
});

test("formal mirror rejects an ambiguous ownerless store in a multi-account state", async () => {
  const state = {
    accounts: [
      { id: "acct_one", username: "one", role: "admin", status: "active" },
      { id: "acct_two", username: "two", role: "user", status: "active" },
    ],
    sessions: {},
    currentAccountId: "acct_one",
    stores: [{ id: "store_ambiguous", label: "Ambiguous Store", status: "active" }],
    caches: { files: [], warehouses: [], products: [], postings: [] },
    jobs: {},
  };
  const trace = [];
  const client = {
    async query(query) {
      const sql = String(query?.text || query || "").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) trace.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  await assert.rejects(
    mirrorStateToRelationalTables({ connect: async () => client }, state),
    (error) => error?.code === "STORE_OWNER_REQUIRED",
  );
  assert.deepEqual(trace, ["BEGIN", "ROLLBACK"]);
});

test("formal mirror persists Ozon marketing seller price instead of BNPL parameters", async () => {
  const accountId = "acct_price_owner";
  const storeId = "store_price_owner";
  const state = {
    accounts: [{ id: accountId, username: "price-owner", role: "admin", status: "active" }],
    sessions: {},
    currentAccountId: accountId,
    currentStoreId: storeId,
    currentStoreIdsByAccount: { [accountId]: storeId },
    stores: [{
      id: storeId,
      ownerAccountId: accountId,
      label: "Price Store",
      clientId: "price-client",
      status: "active",
    }],
    caches: {
      files: [],
      warehouses: [],
      postings: [],
      products: [{
        id: "1723278442",
        product_id: "1723278442",
        sku: "2102714503",
        offer_id: "offer-price-test",
        name: "Price test product",
        status: "ALL",
        price: "0.00",
        price_info: {
          price: {
            price: "1675",
            old_price: "1675",
            marketing_seller_price: "198",
            marketing_price: "0",
            currency_code: "CNY",
          },
        },
        marketing_actions: {
          actions: [
            { title: "Рассрочка BNPL в Казахстане - АБ ТЕСТ", value: 4 },
            { title: "Максимальный бустинг", value: 198 },
          ],
        },
        storeId,
        store_id: storeId,
      }],
    },
    jobs: {},
  };
  let productInsertParams = null;
  const client = {
    async query(query, params = []) {
      const sql = String(query?.text || query || "").trim();
      if (/INSERT INTO products\s*\(/i.test(sql)) productInsertParams = params;
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  await mirrorStateToRelationalTables({ connect: async () => client }, state);

  assert.ok(productInsertParams, "product must be mirrored");
  assert.equal(productInsertParams[10], 198, "current price must use marketing_seller_price");
  assert.equal(productInsertParams[11], 1675, "original price must use old_price");
  assert.equal(productInsertParams[12], 198, "marketing price must use marketing_seller_price");
});
