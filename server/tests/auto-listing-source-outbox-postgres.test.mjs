import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAutoListingSourceOutboxRepository } from "../auto-listing-source-outbox-postgres.mjs";

const row = {
  id: "source-1", account_id: "account-a", import_file_id: "import-1", row_id: "row-1",
  event_type: "COLLECT_EXCEL_SKU", state: "PROCESSING", state_version: "1", attempts: 1,
  available_at: "2026-08-07T00:00:00.000Z", lease_owner: "worker-a", lease_token: "lease-a",
  lease_expires_at: "2026-08-07T00:05:00.000Z", lease_generation: "1",
  normalized_sku: "7003", row_status: "COLLECTING", row_status_version: "1",
  file_status: "COLLECTING", file_status_version: "2",
};

function harness(overrides = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/SELECT o\.\*,r\.status/u.test(sql)) return { rows: [overrides.releaseRow || row] };
      if (/SELECT o\.\*/u.test(sql)) return { rows: [overrides.claimRow || { ...row, state: "PENDING", state_version: "0", attempts: 0, lease_token: null, row_status: "PENDING", row_status_version: "0", file_status: "QUEUED", file_status_version: "1" }] };
      if (/UPDATE auto_listing_source_outbox[\s\S]*RETURNING/u.test(sql)) return { rows: [row], rowCount: 1 };
      if (/UPDATE auto_listing_import_rows/u.test(sql)) return { rows: [{ id: "row-1" }], rowCount: 1 };
      if (/UPDATE auto_listing_import_files/u.test(sql)) return { rows: [{ id: "import-1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: "RELEASE", params: [] }); },
  };
  return {
    calls,
    repository: createPostgresAutoListingSourceOutboxRepository({
      pool: { query: async () => ({ rows: [] }), connect: async () => client },
    }),
  };
}

test("claims one account-scoped pending row and advances file, row, and lease in one transaction", async () => {
  const { repository, calls } = harness();
  const claimed = await repository.claimNext({ accountId: "account-a", workerId: "worker-a", leaseSeconds: 120 });
  assert.deepEqual(claimed, {
    id: "source-1", accountId: "account-a", importFileId: "import-1", rowId: "row-1",
    sku: "7003", state: "PROCESSING", stateVersion: 1, attempts: 1,
    leaseToken: "lease-a", leaseGeneration: 1,
  });
  assert.match(calls.find(({ sql }) => /SELECT o\.\*/u.test(sql)).sql, /FOR UPDATE OF o,r,f SKIP LOCKED/u);
  assert.ok(calls.some(({ sql }) => /SET LOCAL statement_timeout/u.test(sql)));
  assert.ok(calls.some(({ sql }) => /UPDATE auto_listing_import_files[\s\S]*'COLLECTING'/u.test(sql)));
  assert.ok(calls.some(({ sql }) => /UPDATE auto_listing_import_rows[\s\S]*attempt_count=attempt_count\+1/u.test(sql)));
  assert.ok(calls.some(({ sql }) => /COMMIT/u.test(sql)));
});

test("completion requires the live lease and atomically records the collect item and counters", async () => {
  const { repository, calls } = harness();
  const result = await repository.completeCollection({
    accountId: "account-a", outboxId: "source-1", rowId: "row-1",
    leaseToken: "lease-a", collectItemId: "collect-7003",
  });
  assert.deepEqual(result, { completed: true, duplicate: false });
  const statements = calls.map(({ sql }) => sql);
  const rowUpdate = statements.findIndex((sql) => /UPDATE auto_listing_import_rows[\s\S]*'READY'/u.test(sql));
  const counterUpdate = statements.findIndex((sql) => /ready_rows=ready_rows\+1/u.test(sql));
  const outboxUpdate = statements.findIndex((sql) => /UPDATE auto_listing_source_outbox[\s\S]*'COMPLETED'/u.test(sql));
  assert.ok(rowUpdate >= 0 && counterUpdate > rowUpdate && outboxUpdate > counterUpdate);
  assert.match(statements[outboxUpdate], /lease_cas_token=\$4/u);
});

test("completion accepts the bounded Unicode collect id produced from a valid SKU", async () => {
  const { repository } = harness();
  await assert.doesNotReject(repository.completeCollection({
    accountId: "account-a", outboxId: "source-1", rowId: "row-1",
    leaseToken: "lease-a", collectItemId: "товар 7003",
  }));
});

test("retry releases the row before the outbox so the database can verify the live lease", async () => {
  const { repository, calls } = harness();
  const result = await repository.failCollection({
    accountId: "account-a", outboxId: "source-1", rowId: "row-1", leaseToken: "lease-a",
    errorCode: "OZON_SKU_SCRAPE_EMPTY", retryable: true,
  });
  assert.deepEqual(result, { state: "PENDING", attempts: 1 });
  const statements = calls.map(({ sql }) => sql);
  const rowRetry = statements.findIndex((sql) => /UPDATE auto_listing_import_rows[\s\S]*source_lease_cas_token/u.test(sql));
  const outboxRetry = statements.findIndex((sql) => /UPDATE auto_listing_source_outbox[\s\S]*'PENDING'/u.test(sql));
  assert.ok(rowRetry >= 0 && outboxRetry > rowRetry);
  assert.match(statements[outboxRetry], /available_at=statement_timestamp\(\) \+ \(\$6 \* INTERVAL '1 second'\)/u);
});

test("the final allowed attempt becomes DEAD and increments failed rows exactly once", async () => {
  const { repository, calls } = harness({ releaseRow: { ...row, attempts: 5 } });
  const result = await repository.failCollection({
    accountId: "account-a", outboxId: "source-1", rowId: "row-1", leaseToken: "lease-a",
    errorCode: "OZON_SKU_COLLECTION_FAILED", retryable: true,
  });
  assert.deepEqual(result, { state: "DEAD", attempts: 5 });
  assert.ok(calls.some(({ sql }) => /failed_rows=failed_rows\+1/u.test(sql)));
  assert.ok(calls.some(({ sql }) => /UPDATE auto_listing_source_outbox[\s\S]*'DEAD'/u.test(sql)));
});

test("rejects forged scope and error codes before acquiring a connection", async () => {
  let connects = 0;
  const repository = createPostgresAutoListingSourceOutboxRepository({
    pool: { query: async () => ({ rows: [] }), connect: async () => { connects += 1; throw new Error("unused"); } },
  });
  await assert.rejects(repository.claimNext({ accountId: "", workerId: "worker", leaseSeconds: 60 }), { code: "AUTO_LISTING_SOURCE_OUTBOX_INVALID" });
  await assert.rejects(repository.failCollection({
    accountId: "account-a", outboxId: "source-1", rowId: "row-1", leaseToken: "lease-a",
    errorCode: "SECRET upstream", retryable: true,
  }), { code: "AUTO_LISTING_SOURCE_OUTBOX_INVALID" });
  assert.equal(connects, 0);
});

test("discovers only accounts with due pending or expired processing work", async () => {
  const queries = [];
  const repository = createPostgresAutoListingSourceOutboxRepository({
    pool: {
      connect: async () => assert.fail("account discovery uses a read-only pool query"),
      async query(sql, params) {
        queries.push({ sql: String(sql), params });
        return { rows: [{ account_id: "account-a" }, { account_id: "account-b" }] };
      },
    },
  });
  assert.deepEqual(await repository.listRunnableAccountIds({ cursor: "account-0", limit: 25 }), ["account-a", "account-b"]);
  assert.match(queries[0].sql, /state='PENDING'[\s\S]*available_at<=statement_timestamp\(\)/u);
  assert.match(queries[0].sql, /state='PROCESSING'[\s\S]*lease_expires_at<=statement_timestamp\(\)/u);
  assert.match(queries[0].sql, /account_id>\$1/u);
  assert.deepEqual(queries[0].params, ["account-0", 25]);
});
