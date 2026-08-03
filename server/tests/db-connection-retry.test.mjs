import assert from "node:assert/strict";
import test from "node:test";

const ENV_KEYS = ["DATABASE_URL", "POSTGRES_HOST", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_PORT"];

function saveEnvironment() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

async function freshConnection() {
  return import(`../db/connection.mjs?retry-test=${Date.now()}-${Math.random()}`);
}

test("PostgreSQL pool retries failed initialization, shares success, and closes safely", async () => {
  const saved = saveEnvironment();
  try {
    delete process.env.DATABASE_URL;
    process.env.POSTGRES_HOST = "localhost";
    delete process.env.POSTGRES_DB;
    delete process.env.POSTGRES_USER;
    delete process.env.POSTGRES_PASSWORD;
    const connection = await freshConnection();
    await assert.rejects(connection.getPostgresPool(), /PostgreSQL/);
    await assert.doesNotReject(connection.closePostgresPool());

    Object.assign(process.env, {
      POSTGRES_DB: "retry_test",
      POSTGRES_USER: "retry_user",
      POSTGRES_PASSWORD: "retry_password",
    });
    const [left, right] = await Promise.all([connection.getPostgresPool(), connection.getPostgresPool()]);
    assert.equal(left, right);
    await connection.closePostgresPool();
    await assert.doesNotReject(connection.closePostgresPool());
  } finally {
    restoreEnvironment(saved);
  }
});

test("closing an old pool never closes a replacement created during its shutdown", async () => {
  const saved = saveEnvironment();
  try {
    Object.assign(process.env, {
      POSTGRES_HOST: "localhost",
      POSTGRES_DB: "close_test",
      POSTGRES_USER: "close_user",
      POSTGRES_PASSWORD: "close_password",
    });
    delete process.env.DATABASE_URL;
    const connection = await freshConnection();
    const first = await connection.getPostgresPool();
    let releaseFirstEnd;
    let firstEndCalls = 0;
    first.end = () => new Promise((resolve) => {
      firstEndCalls += 1;
      releaseFirstEnd = resolve;
    });
    const closing = connection.closePostgresPool();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replacement = await connection.getPostgresPool();
    let replacementEndCalls = 0;
    replacement.end = async () => { replacementEndCalls += 1; };
    assert.notEqual(replacement, first);
    assert.equal(typeof releaseFirstEnd, "function");
    releaseFirstEnd();
    await closing;
    assert.equal(firstEndCalls, 1);
    assert.equal(replacementEndCalls, 0);
    await connection.closePostgresPool();
    assert.equal(replacementEndCalls, 1);
  } finally {
    restoreEnvironment(saved);
  }
});

test("concurrent close is single-flight, preserves replacements after end failure, and retries", async () => {
  const saved = saveEnvironment();
  try {
    Object.assign(process.env, {
      POSTGRES_HOST: "localhost",
      POSTGRES_DB: "concurrent_close_test",
      POSTGRES_USER: "close_user",
      POSTGRES_PASSWORD: "close_password",
    });
    delete process.env.DATABASE_URL;
    const connection = await freshConnection();
    const first = await connection.getPostgresPool();
    let releaseFirstEnd;
    let firstEndCalls = 0;
    first.end = () => new Promise((resolve, reject) => {
      firstEndCalls += 1;
      releaseFirstEnd = () => reject(new Error("close failed"));
    });
    const left = connection.closePostgresPool();
    const right = connection.closePostgresPool();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(firstEndCalls, 1);
    releaseFirstEnd();
    await assert.rejects(left, /close failed/);
    await assert.rejects(right, /close failed/);

    const replacement = await connection.getPostgresPool();
    let replacementEndCalls = 0;
    replacement.end = async () => { replacementEndCalls += 1; };
    await connection.closePostgresPool();
    assert.equal(replacementEndCalls, 1);
  } finally {
    restoreEnvironment(saved);
  }
});
