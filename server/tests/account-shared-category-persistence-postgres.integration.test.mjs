import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL || "";
const enabled = process.env.ACCOUNT_SHARED_CATEGORY_POSTGRES_TESTS === "1" && Boolean(databaseUrl);

async function waitForBlockedCleanup(pool, applicationName, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT 1
         FROM pg_stat_activity
        WHERE application_name=$1
          AND state='active'
          AND wait_event_type='Lock'
          AND query LIKE '%UPDATE local_state%'
        LIMIT 1`,
      [applicationName],
    );
    if (result.rowCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("timed out waiting for the first-load cleanup CAS to block");
}

if (!enabled) {
  test("account-shared category persistence requires a disposable PostgreSQL 16 database", {
    skip: "requires ACCOUNT_SHARED_CATEGORY_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  const applicationName = `task1-persistence-${crypto.randomUUID()}`;
  const persistenceSchema = `task1_persistence_${crypto.randomUUID().replaceAll("-", "")}`;
  const bootstrap = new Pool({ connectionString: databaseUrl });
  await bootstrap.query(`CREATE SCHEMA "${persistenceSchema}"`);
  await bootstrap.end();
  const persistenceUrl = new URL(databaseUrl);
  persistenceUrl.searchParams.set("application_name", applicationName);
  persistenceUrl.searchParams.set("options", `-csearch_path=${persistenceSchema},public`);
  const observerUrl = new URL(persistenceUrl);
  observerUrl.searchParams.set("application_name", `${applicationName}-observer`);
  process.env.DATABASE_URL = persistenceUrl.toString();
  process.env.QH_LOCAL_NO_DOTENV = "1";

  const {
    loadPersistedState,
    savePersistedState,
  } = await import("../persistence.mjs");
  const { closePostgresPool } = await import("../db/connection.mjs");

  test.after(async () => {
    await closePostgresPool();
    const cleanup = new Pool({ connectionString: databaseUrl });
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS "${persistenceSchema}" CASCADE`);
    } finally {
      await cleanup.end();
    }
  });

  test("PG first-load cleanup rejects a lost CAS instead of returning unpersisted normalized state", {
    timeout: 60_000,
  }, async () => {
    const observer = new Pool({ connectionString: observerUrl.toString() });
    const blocker = await observer.connect();
    try {
      await loadPersistedState({ dataFile: "/path/that/does/not/exist.json" });
      await observer.query("DELETE FROM local_state WHERE id='local-state'");
      await observer.query(
        `INSERT INTO local_state (id,state,version)
         VALUES ('local-state',$1::jsonb,7)`,
        [JSON.stringify({
          accounts: [],
          stores: [],
          sessions: {},
          collectCategoryResolutions: [{ id: "retired-target" }],
          collectCategoryResolutionRuntimeCursors: { global: "retired-cursor" },
          caches: { files: [], warehouses: [], products: [], postings: [] },
          jobs: {},
          auditEvents: [],
        })],
      );

      await blocker.query("BEGIN");
      await blocker.query(
        "UPDATE local_state SET version=version+1 WHERE id='local-state'",
      );
      const loading = loadPersistedState({ dataFile: "/path/that/does/not/exist.json" });
      await waitForBlockedCleanup(observer, applicationName);
      await blocker.query("COMMIT");

      await assert.rejects(
        loading,
        (error) => error?.code === "LOCAL_STATE_VERSION_CONFLICT"
          && error?.status === 409
          && !String(error?.message || "").includes("collectCategoryResolutions"),
      );
      const stored = (await observer.query(
        "SELECT state,version FROM local_state WHERE id='local-state'",
      )).rows[0];
      assert.equal(stored.version, 8);
      assert.equal(Object.hasOwn(stored.state, "collectCategoryResolutions"), true);
      assert.equal(Object.hasOwn(stored.state, "collectCategoryResolutionRuntimeCursors"), true);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await observer.end();
    }
  });

  test("successful PG save commits an inferred store owner to caller and local_state", {
    timeout: 60_000,
  }, async () => {
    const observer = new Pool({ connectionString: observerUrl.toString() });
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const accountId = `account-owner-${suffix}`;
    const storeId = `store-owner-${suffix}`;
    const state = {
      accounts: [{
        id: accountId,
        username: `owner-${suffix}`,
        displayName: "Owner",
        role: "admin",
        status: "active",
      }],
      currentAccountId: accountId,
      currentStoreId: storeId,
      currentStoreIdsByAccount: { [accountId]: storeId },
      stores: [{
        id: storeId,
        label: "Ownerless legacy store",
        clientId: `client-${suffix}`,
        status: "active",
      }],
      sessions: {},
      caches: { files: [], warehouses: [], products: [], postings: [] },
      jobs: {},
      auditEvents: [],
    };
    const storesReference = state.stores;
    const storeReference = state.stores[0];
    try {
      await savePersistedState({ state });
      const stored = (await observer.query(
        "SELECT state FROM local_state WHERE id='local-state'",
      )).rows[0]?.state;
      const relational = (await observer.query(
        "SELECT owner_account_id FROM stores WHERE id=$1",
        [storeId],
      )).rows[0];

      assert.deepEqual({
        callerOwnerAccountId: state.stores[0].ownerAccountId,
        storedOwnerAccountId: stored?.stores?.[0]?.ownerAccountId,
        relationalOwnerAccountId: relational?.owner_account_id,
      }, {
        callerOwnerAccountId: accountId,
        storedOwnerAccountId: accountId,
        relationalOwnerAccountId: accountId,
      });
      assert.strictEqual(state.stores, storesReference);
      assert.strictEqual(state.stores[0], storeReference);
    } finally {
      await observer.end();
    }
  });
}
