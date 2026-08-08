import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { createPostgresAutoListingPreferencesRepository } from "../auto-listing-preferences-postgres.mjs";

const frozen = normalizeAndHashAutoListingConfig({
  targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 5,
  priceAdjustmentKopecks: "100",
});

function preferenceRow(overrides = {}) {
  return {
    account_id: "account-a", target_store_id: "store-a", target_warehouse_id: "warehouse-a",
    stock: 5, price_adjustment_kopecks: "100", image_config: frozen.config.image,
    config_version: 1, updated_by: "account-a", created_at: "2026-08-07T00:00:00.000Z",
    updated_at: "2026-08-07T00:00:00.000Z", ...overrides,
  };
}

test("preference save validates owned active FBS inventory scope and records one audit event", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push([sql, params]);
      if (sql.includes("SELECT id FROM accounts")) return { rows: [{ id: "account-a" }] };
      if (sql.includes("FROM audit_events")) return { rows: [] };
      if (sql.includes("FROM auto_listing_preferences") && sql.includes("FOR UPDATE")) return { rows: [] };
      if (sql.includes("FROM stores s") && sql.includes("JOIN warehouses")) return { rows: [{
        store_id: "store-a", owner_account_id: "account-a", store_status: "active", client_id: "client-a",
        credentials_saved: true, warehouse_record_id: "warehouse-a", warehouse_id: "1001",
        warehouse_type: "FBS", warehouse_status: "active", is_active: true, is_archived: false,
        has_active_product_association: true,
      }] };
      if (sql.includes("INSERT INTO auto_listing_preferences")) return { rows: [preferenceRow()] };
      if (sql.includes("INSERT INTO audit_events")) return { rows: [{ event_id: params[0] }], rowCount: 1 };
      return { rows: [] };
    },
    release() { calls.push(["RELEASE", []]); },
  };
  const repository = createPostgresAutoListingPreferencesRepository({
    pool: { async query() {}, async connect() { return client; } },
  });
  const result = await repository.savePreferences({
    accountId: "account-a", actorId: "account-a", expectedVersion: 0,
    idempotencyKey: "pref-a", correlationId: "corr-a", config: frozen.config, configHash: frozen.configHash,
  });
  assert.equal(result.configVersion, 1);
  assert.equal(result.accountId, "account-a");
  assert.ok(calls.some(([sql]) => sql.includes("has_active_product_association")));
  assert.ok(calls.some(([sql]) => sql.includes("INSERT INTO audit_events")));
  assert.deepEqual(calls.map(([sql]) => sql).filter((sql) => ["BEGIN", "COMMIT", "ROLLBACK", "RELEASE"].includes(sql)), [
    "BEGIN", "COMMIT", "RELEASE",
  ]);
});

test("preference save rejects stale versions before writing", async () => {
  let writes = 0;
  const client = {
    async query(sql) {
      if (sql.includes("SELECT id FROM accounts")) return { rows: [{ id: "account-a" }] };
      if (sql.includes("FROM audit_events")) return { rows: [] };
      if (sql.includes("FROM auto_listing_preferences") && sql.includes("FOR UPDATE")) return { rows: [preferenceRow({ config_version: 3 })] };
      if (sql.includes("INSERT INTO") || sql.includes("UPDATE auto_listing_preferences")) writes += 1;
      return { rows: [] };
    }, release() {},
  };
  const repository = createPostgresAutoListingPreferencesRepository({ pool: { async query() {}, async connect() { return client; } } });
  await assert.rejects(repository.savePreferences({
    accountId: "account-a", actorId: "account-a", expectedVersion: 2,
    idempotencyKey: "pref-a", correlationId: "corr-a", config: frozen.config, configHash: frozen.configHash,
  }), { code: "AUTO_LISTING_PREFERENCES_VERSION_CONFLICT" });
  assert.equal(writes, 0);
});

test("preference reads and failures remain account scoped and safe", async () => {
  const repository = createPostgresAutoListingPreferencesRepository({
    pool: {
      async query(sql, params) {
        assert.match(sql, /WHERE account_id=\$1/u);
        assert.deepEqual(params, ["account-a"]);
        return { rows: [preferenceRow()] };
      },
      async connect() { throw new Error("not used"); },
    },
  });
  assert.equal((await repository.getPreferences({ accountId: "account-a" })).targetStoreId, "store-a");

  const failed = createPostgresAutoListingPreferencesRepository({
    pool: { async query() { throw new Error("password=prod-secret"); }, async connect() {} },
  });
  await assert.rejects(failed.getPreferences({ accountId: "account-a" }),
    (error) => error?.code === "AUTO_LISTING_PREFERENCES_PERSIST_FAILED" && !/password|prod-secret/iu.test(error.message));
});
