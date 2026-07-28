import assert from "node:assert/strict";
import test from "node:test";

process.env.QH_LOCAL_NO_DOTENV = "1";
process.env.POSTGRES_HOST ||= "migration-test.invalid";

const { runMigrations } = await import("../db/migrate.mjs");

class SessionLock {
  owner = null;
  waiters = [];
  active = 0;
  maxActive = 0;

  async acquire(client) {
    if (this.owner) {
      await new Promise((resolve) => this.waiters.push({ client, resolve }));
    } else {
      this.owner = client;
    }
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
  }

  release(client) {
    assert.equal(this.owner, client, "only the owning PostgreSQL session may unlock migrations");
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) {
      this.owner = next.client;
      next.resolve();
    } else {
      this.owner = null;
    }
    return true;
  }
}

function createMigrationPool({ failMigration = false } = {}) {
  const state = {
    applied: new Set(),
    insertedVersions: [],
    lock: new SessionLock(),
    scans: 0,
    migrationBodies: 0,
    traces: [],
    clients: [],
  };

  const pool = {
    async connect() {
      const client = {
        id: `client-${state.clients.length + 1}`,
        inTransaction: false,
        released: false,
        async query(query, params = []) {
          const sql = String(query?.text || query || "").trim();
          if (sql.includes("pg_advisory_unlock")) {
            state.traces.push(`${this.id}:unlock`);
            return { rows: [{ unlocked: state.lock.release(this) }] };
          }
          if (sql.includes("pg_advisory_lock")) {
            state.traces.push(`${this.id}:lock-wait`);
            await state.lock.acquire(this);
            state.traces.push(`${this.id}:lock-held`);
            return { rows: [{}] };
          }
          if (sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations")) {
            assert.equal(state.lock.owner, this);
            state.traces.push(`${this.id}:ensure-table`);
            return { rows: [] };
          }
          if (/^SELECT version FROM schema_migrations$/i.test(sql)) {
            assert.equal(state.lock.owner, this);
            state.scans += 1;
            state.traces.push(`${this.id}:scan`);
            return { rows: [...state.applied].map((version) => ({ version })) };
          }
          if (sql === "BEGIN") {
            assert.equal(state.lock.owner, this);
            assert.equal(this.inTransaction, false);
            this.inTransaction = true;
            state.traces.push(`${this.id}:begin`);
            return { rows: [] };
          }
          if (sql === "ROLLBACK") {
            assert.equal(this.inTransaction, true);
            this.inTransaction = false;
            state.traces.push(`${this.id}:rollback`);
            return { rows: [] };
          }
          if (sql === "COMMIT") {
            assert.equal(this.inTransaction, true);
            this.inTransaction = false;
            state.traces.push(`${this.id}:commit`);
            return { rows: [] };
          }
          if (sql.startsWith("INSERT INTO schema_migrations")) {
            assert.equal(this.inTransaction, true);
            const version = params[0];
            if (state.applied.has(version)) {
              throw Object.assign(new Error(`duplicate migration ${version}`), { code: "23505" });
            }
            state.applied.add(version);
            state.insertedVersions.push(version);
            state.traces.push(`${this.id}:insert:${version}`);
            return { rows: [] };
          }
          assert.equal(this.inTransaction, true, `unexpected query outside a migration transaction: ${sql.slice(0, 80)}`);
          state.migrationBodies += 1;
          state.traces.push(`${this.id}:migration-body`);
          if (failMigration) {
            throw Object.assign(new Error("synthetic migration failure"), { code: "TEST_MIGRATION_FAILED" });
          }
          await new Promise((resolve) => setTimeout(resolve, 2));
          return { rows: [] };
        },
        release(error) {
          this.released = true;
          this.releaseError = error;
          state.traces.push(`${this.id}:release`);
        },
      };
      state.clients.push(client);
      return client;
    },
  };

  return { pool, state };
}

test("parallel migration runners serialize the complete scan and apply cycle", async () => {
  const { pool, state } = createMigrationPool();
  const results = await Promise.all([runMigrations(pool), runMigrations(pool)]);

  assert.equal(state.lock.maxActive, 1);
  assert.equal(state.lock.active, 0);
  assert.equal(state.scans, 2);
  assert.ok(state.insertedVersions.length > 0);
  assert.equal(new Set(state.insertedVersions).size, state.insertedVersions.length);
  assert.equal(state.migrationBodies, state.insertedVersions.length);
  assert.deepEqual(results.map((result) => result.applied.length).sort((a, b) => a - b), [0, state.insertedVersions.length]);
  assert.equal(state.clients.every((client) => client.released), true);
  assert.equal(state.clients.every((client) => client.releaseError === undefined), true);
});

test("a failed migration rolls back before releasing the session lock", async () => {
  const { pool, state } = createMigrationPool({ failMigration: true });

  await assert.rejects(
    runMigrations(pool),
    (error) => error?.code === "TEST_MIGRATION_FAILED",
  );

  assert.equal(state.applied.size, 0);
  assert.equal(state.lock.active, 0);
  assert.equal(state.clients[0].released, true);
  const rollbackIndex = state.traces.indexOf("client-1:rollback");
  const unlockIndex = state.traces.indexOf("client-1:unlock");
  assert.ok(rollbackIndex >= 0);
  assert.ok(unlockIndex > rollbackIndex);
  assert.equal(state.traces.includes("client-1:commit"), false);
});
