import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Query } from "pg";
import { getPostgresPool, closePostgresPool } from "../../db/connection.mjs";
import { persistPostgresStateAtomically } from "../../postgres-state-transaction.mjs";

// Launched by the container-owning test, in a separate process so an unhandled
// Client/Pool error really exits. There is no uncaughtException/error listener here.
const [name, port, scenario] = process.argv.slice(2);
assert.match(name, /^ozon-pg-disconnect-[0-9a-f-]{36}$/);
assert.match(port, /^\d+$/);
process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${port}/postgres`;
process.env.POSTGRES_SSL = "false";
const docker = (...args) => execFileSync("docker", args, {
  encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
}).trim();
async function waitFor(check, message) {
  // Harness watchdog only; no application query/task timeouts are changed.
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message);
}
async function restart() {
  docker("start", name);
  await waitFor(() => {
    try {
      docker("exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres");
      return true;
    } catch { return false; }
  }, "PostgreSQL did not recover after the real crash");
}
const pool = await getPostgresPool();
await pool.query(`CREATE TABLE IF NOT EXISTS disconnect_state (
  id text PRIMARY KEY, state jsonb, version integer, updated_at timestamptz);
  INSERT INTO disconnect_state VALUES ('local-state', '{"saved":"before-crash"}', 1, NOW())
  ON CONFLICT (id) DO NOTHING;
  CREATE TABLE IF NOT EXISTS disconnect_writes (note text PRIMARY KEY);`);
const client = await pool.connect();
const errors = [];
// Observe the real event without installing an error listener that would hide the bug.
const emit = client.emit;
client.emit = function (event, ...args) {
  if (event === "error") errors.push(args[0]);
  return emit.call(this, event, ...args);
};
const killedPid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
let released = false;
const release = () => { if (!released) { released = true; client.release(); } };
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const assertDisconnected = error => {
  assert(error instanceof Error, "the interrupted operation must fail, never report success");
  assert.match(error.message, /Connection terminated unexpectedly|ECONNRESET|terminating connection|connection to server was lost/);
};
async function crash({ backendOnly = false } = {}) {
  if (backendOnly) {
    // Killing a real backend has the same socket/crash-recovery mechanism as an OOM kill.
    docker("exec", name, "sh", "-c", 'kill -9 "$1"', "--", String(killedPid));
  } else {
    docker("kill", "--signal=KILL", name);
  }
  await waitFor(() => errors.length > 0, "no real connection error observed");
}
async function waitForQuery() {
  await waitFor(() => docker("exec", name, "psql", "-U", "postgres", "-Atc",
    `SELECT count(*) FROM pg_stat_activity WHERE pid=${killedPid} AND wait_event='PgSleep'`) === "1",
  "the test query did not reach PostgreSQL");
}
try {
  if (scenario === "ordinary-sql-error") {
    await client.query("BEGIN");
    const { error } = await settle(client.query("SELECT definitely_missing_column"));
    assert.equal(error.code, "42703");
    await client.query("ROLLBACK");
    assert.equal(errors.length, 0, "a SQL error must not invalidate a healthy connection");
    release();
    // Repeated borrowing must not accumulate connection error listeners.
    const listeners = client.listenerCount("error");
    for (let i = 0; i < 15; i += 1) {
      const borrowed = await pool.connect();
      assert.equal(borrowed, client);
      await borrowed.query("SELECT 1");
      borrowed.release();
    }
    assert.equal(client.listenerCount("error"), listeners);
    const callbackValue = await new Promise((resolve, reject) => pool.connect((error, borrowed, done) => {
      if (error) return reject(error);
      borrowed.query("SELECT $1::integer AS value", [7], (error, result) => {
        done(error);
        error ? reject(error) : resolve(result.rows[0].value);
      });
    }));
    assert.equal(callbackValue, 7);
  } else if (scenario === "idle-pool") {
    release();
    await crash();
    assert.equal(pool.totalCount, 0, "broken idle connections must be removed");
  } else if (scenario === "active-pool-query" || scenario === "active-held-query") {
    if (scenario === "active-pool-query") release();
    const target = scenario === "active-pool-query" ? pool : client;
    const pending = settle(target.query("INSERT INTO disconnect_writes SELECT $1 FROM pg_sleep(60)", [scenario]));
    await waitForQuery();
    await crash({ backendOnly: scenario === "active-held-query" });
    const { error } = await pending;
    assertDisconnected(error);
    assert.equal(error, errors[0], "the caller must receive the original connection error object");
    release();
  } else if (scenario === "held-between-queries") {
    await client.query("BEGIN");
    await client.query("INSERT INTO disconnect_writes VALUES ($1)", [scenario]);
    await crash();
    const { error } = await settle(client.query("COMMIT"));
    assertDisconnected(error);
    assert.equal(error, errors[0]);
    await assert.rejects(client.query("ROLLBACK"), failure => failure === error);
    const callbackError = await new Promise(resolve => client.query("SELECT 1", failure => resolve(failure)));
    assert.equal(callbackError, error);
    const configCallbackError = await new Promise(resolve => client.query({ text: "SELECT 1", callback: resolve }));
    assert.equal(configCallbackError, error);
    const query = new Query("SELECT 1");
    const queryError = new Promise(resolve => query.once("error", resolve));
    assert.equal(client.query(query), query);
    assert.equal(await queryError, error);
    release();
  } else if (scenario === "state-transaction") {
    const state = {};
    Object.defineProperty(state, "__storageVersion", { value: 1, writable: true, configurable: true });
    let mirrorCalls = 0;
    let afterCommitCalls = 0;
    const { error } = await settle(persistPostgresStateAtomically({
      client, table: "disconnect_state", state, protectedState: { saved: "must-not-commit" },
      mirror: async () => {
        mirrorCalls += 1;
        await client.query("INSERT INTO disconnect_writes VALUES ($1)", [scenario]);
        await crash();
        return { afterCommit: () => { afterCommitCalls += 1; } };
      },
    }));
    assertDisconnected(error);
    assert.equal(error, errors[0], "rollback failure must not replace the original connection error");
    assert.equal(mirrorCalls, 1, "the transaction/mirror must never be replayed");
    assert.equal(afterCommitCalls, 0, "no success side effects after a failed commit");
    assert.equal(state.__storageVersion, 1, "do not report an uncommitted version as saved");
    release();
  } else {
    assert.fail(`Unknown scenario: ${scenario}`);
  }

  if (scenario !== "ordinary-sql-error") {
    assert.equal(pool.totalCount, 0, "failed checked-out connections must be discarded on release");
    // A request during an outage must fail; the shared pool itself remains usable.
    if (scenario !== "active-held-query") {
      const { error } = await settle(pool.query("SELECT 1"));
      assert(error instanceof Error, "reading while PostgreSQL is down must fail");
    }
    await restart();
    assert.equal(await getPostgresPool(), pool, "existing callers should recover using the same pool");
    const recovered = await pool.connect();
    try {
      assert.notEqual(recovered, client, "a broken client must never be reused");
      assert.equal((await recovered.query("SELECT 42 AS value")).rows[0].value, 42);
    } finally { recovered.release(); }
  }
  assert.deepEqual((await pool.query("SELECT state,version FROM disconnect_state WHERE id='local-state'")).rows,
    [{ state: { saved: "before-crash" }, version: 1 }]);
  assert.deepEqual((await pool.query("SELECT note FROM disconnect_writes")).rows, [], "no aborted writes replayed after recovery");
  console.log(`recovery verified; scenario=${scenario}; disconnect=${errors[0]?.message || "none"}; saved version=1; aborted writes=0`);
} finally {
  release();
  await closePostgresPool();
}
