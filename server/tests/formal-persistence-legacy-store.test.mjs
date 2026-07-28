import assert from "node:assert/strict";
import test from "node:test";

process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

const { mirrorStateToRelationalTables } = await import("../formal-persistence.mjs");

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
