import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresAiOutboxRepository } from "../auto-listing-ai-outbox-postgres.mjs";
import { autoListingAiMessageDedupeKey } from "../auto-listing-ai-message.mjs";

const message = Object.freeze({
  contractVersion: "V1",
  accountId: "account-a",
  itemId: "item-a",
  phase: "PLAN_CONTENT",
  expectedStatusVersion: 3,
  correlationId: "correlation-a",
});
const dedupeKey = autoListingAiMessageDedupeKey(message);

function outboxRow(overrides = {}) {
  return {
    id: "ai-outbox-1",
    dedupe_key: dedupeKey,
    account_id: "account-a",
    job_id: "job-a",
    item_id: "item-a",
    contract_version: "V1",
    phase: "PLAN_CONTENT",
    phase_target_id: null,
    expected_status_version: 3,
    correlation_id: "correlation-a",
    payload: message,
    state: "PENDING",
    attempts: 0,
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    publication_id: null,
    next_retry_at: new Date("2026-08-04T00:00:00Z"),
    last_error_code: null,
    created_at: new Date("2026-08-04T00:00:00Z"),
    updated_at: new Date("2026-08-04T00:00:00Z"),
    published_at: null,
    dead_at: null,
    ...overrides,
  };
}

function scriptedPool(steps) {
  const calls = [];
  let connectCount = 0;
  let releaseCount = 0;
  const execute = async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (/^(?:BEGIN|COMMIT|ROLLBACK)/u.test(sql)) return { rows: [] };
    const next = steps.shift();
    if (next instanceof Error) throw next;
    return next ?? { rows: [] };
  };
  const client = {
    query: execute,
    release() { releaseCount += 1; },
  };
  return {
    calls,
    get connectCount() { return connectCount; },
    get releaseCount() { return releaseCount; },
    query: execute,
    async connect() {
      connectCount += 1;
      return client;
    },
  };
}

test("PostgreSQL outbox enqueue is deterministic, account scoped and returns the stored canonical message", async () => {
  const pool = scriptedPool([{ rows: [outboxRow()] }]);
  const repository = createPostgresAiOutboxRepository({ pool, id: () => "ai-outbox-1" });

  const first = await repository.enqueueAutoListingAiMessage(message);
  const secondPool = scriptedPool([{ rows: [outboxRow()] }]);
  const replay = await createPostgresAiOutboxRepository({ pool: secondPool, id: () => "must-not-affect-dedupe" })
    .enqueueAutoListingAiMessage(message);

  assert.equal(first.dedupeKey, dedupeKey);
  assert.equal(first.itemId, "item-a");
  assert.deepEqual(first.message, message);
  assert.deepEqual(replay.message, message);
  assert.match(pool.calls[0].sql, /INSERT INTO auto_listing_ai_outbox/i);
  assert.match(pool.calls[0].sql, /FROM auto_listing_job_items AS item/i);
  assert.match(pool.calls[0].sql, /item\.account_id=\$[0-9]+ AND item\.id=\$[0-9]+/i);
  assert.match(pool.calls[0].sql, /ON CONFLICT \(dedupe_key\)/i);
  assert.doesNotMatch(JSON.stringify(pool.calls), /https?:|sourceRef|apiKey|secret/i);
});

test("PostgreSQL outbox claims with account scope, SKIP LOCKED, database lease time and a fresh ABA token", async () => {
  const claimed = outboxRow({
    state: "PROCESSING", attempts: 1, lease_owner: "worker-a", lease_token: "nonce-a:1",
    lease_expires_at: new Date("2026-08-04T00:01:00Z"),
  });
  const pool = scriptedPool([
    { rows: [{ job_id: "job-a" }] }, { rows: [claimed] },
    { rows: [{ job_id: "job-a" }] }, { rows: [{ ...claimed, lease_token: "nonce-b:2", attempts: 2 }] },
  ]);
  let nonce = 0;
  const repository = createPostgresAiOutboxRepository({ pool, token: () => `nonce-${++nonce}` });

  const first = await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 5, leaseMs: 60_000 });
  const reclaimed = await repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 5, leaseMs: 60_000 });

  assert.equal(first[0].leaseToken, "nonce-a:1");
  assert.equal(reclaimed[0].leaseToken, "nonce-b:2");
  const claimUpdates = pool.calls.filter((call) => /UPDATE auto_listing_ai_outbox AS outbox/iu.test(call.sql));
  for (const call of claimUpdates) {
    assert.match(call.sql, /FOR UPDATE OF outbox SKIP LOCKED/i);
    assert.match(call.sql, /account_id=\$1/i);
    assert.match(call.sql, /lease_expires_at <= NOW\(\)/i);
    assert.match(call.sql, /NOW\(\)\+\(\$[0-9]+ \* INTERVAL '1 millisecond'\)/i);
  }
  assert.equal(claimUpdates.length, 2);
  assert.equal(pool.connectCount, 2);
  assert.equal(pool.releaseCount, 2);
  assert.deepEqual(pool.calls.map((call) => call.sql.split(/\s/u, 1)[0]), [
    "BEGIN", "WITH", "WITH", "COMMIT", "BEGIN", "WITH", "WITH", "COMMIT",
  ]);
});

test("legacy PostgreSQL claim excludes every job whose frozen profile has a connection", async () => {
  const pool = scriptedPool([{ rows: [] }]);
  const repository = createPostgresAiOutboxRepository({ pool, token: () => "legacy-fence" });

  assert.deepEqual(await repository.claimLegacyAutoListingAiMessages({
    accountId: "account-a", workerId: "worker-a", limit: 5, leaseMs: 60_000,
  }), []);

  const sql = pool.calls.map((call) => call.sql).join("\n");
  assert.match(sql, /JOIN ai_gateway_profiles AS profile/iu);
  assert.match(sql, /profile\.account_id=job\.account_id/iu);
  assert.match(sql, /profile\.id=job\.ai_profile_id/iu);
  assert.match(sql, /profile\.config_version=job\.ai_profile_version/iu);
  assert.match(sql, /profile\.connection_id IS NULL/iu);
  assert.doesNotMatch(sql, /INSERT INTO auto_listing_ai_channels|dispatch_contract_version='CHANNEL_WORK_V1'/iu);
});

test("claim locks jobs before a fresh-snapshot update selects one eligible outbox per batch", async () => {
  const pool = scriptedPool([{ rows: [{ job_id: "job-a" }] }, { rows: [] }]);
  const repository = createPostgresAiOutboxRepository({ pool, token: () => "batch-order" });

  await repository.claimAutoListingAiMessages({
    accountId: "account-a", workerId: "worker-a", limit: 10, leaseMs: 60_000,
  });

  const [, lockCall, updateCall] = pool.calls;
  assert.equal(pool.calls[0].sql, "BEGIN ISOLATION LEVEL READ COMMITTED");
  assert.match(lockCall.sql, /FROM auto_listing_jobs AS job/iu);
  assert.match(lockCall.sql, /JOIN LATERAL/iu);
  assert.match(lockCall.sql, /LIMIT \$2 FOR UPDATE OF job SKIP LOCKED/iu);
  assert.match(lockCall.sql, /state='PROCESSING'[\s\S]*?lease_expires_at <= NOW\(\)[\s\S]*?attempts >= \$3/iu);
  assert.match(updateCall.sql, /unnest\(\$6::TEXT\[\]\)/iu);
  assert.match(updateCall.sql, /JOIN auto_listing_job_items AS item/iu);
  assert.match(updateCall.sql, /predecessor\.source_order < item\.source_order/iu);
  assert.match(updateCall.sql, /predecessor\.status NOT IN \('SUCCEEDED','READY_FOR_REVIEW','RETRYABLE_ERROR','BLOCKED','CANCELLED'\)/iu);
  assert.match(updateCall.sql, /live\.state='PROCESSING'[\s\S]*?live\.lease_expires_at > NOW\(\)/iu);
  assert.match(updateCall.sql, /CROSS JOIN LATERAL[\s\S]*?LIMIT 1 FOR UPDATE OF outbox SKIP LOCKED/iu);
  assert.doesNotMatch(`${lockCall.sql}\n${updateCall.sql}`, /advisory|hashtextextended/iu);
  assert.doesNotMatch(updateCall.sql, /\$7/iu);
  assert.deepEqual(updateCall.parameters[5], ["job-a"]);
  assert.equal(updateCall.parameters.length, 6);
  assert.equal(pool.calls.at(-1).sql, "COMMIT");
  assert.equal(pool.releaseCount, 1);
});

test("claim rolls back and releases its dedicated client when the fresh-snapshot update fails", async () => {
  const pool = scriptedPool([{ rows: [{ job_id: "job-a" }] }, new Error("password=raw-database-secret")]);
  const repository = createPostgresAiOutboxRepository({ pool, token: () => "batch-order" });

  await assert.rejects(
    repository.claimAutoListingAiMessages({
      accountId: "account-a", workerId: "worker-a", limit: 10, leaseMs: 60_000,
    }),
    (error) => error.code === "AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED"
      && error.retryable === true
      && !/password|database|secret/iu.test(error.message),
  );

  assert.equal(pool.calls.at(-1).sql, "ROLLBACK");
  assert.equal(pool.calls.some((call) => call.sql === "COMMIT"), false);
  assert.equal(pool.releaseCount, 1);
});

test("PostgreSQL outbox dynamically discovers runnable or exhaustible V1 accounts with bounded keyset pagination", async () => {
  const pool = scriptedPool([{ rows: [{ account_id: "account-b" }, { account_id: "account-c" }] }]);
  const repository = createPostgresAiOutboxRepository({ pool, maxAttempts: 4 });

  assert.deepEqual(await repository.listRunnableAutoListingAiAccountIds({
    afterAccountId: "account-a",
    limit: 2,
  }), ["account-b", "account-c"]);

  assert.match(pool.calls[0].sql, /contract_version='V1'/iu);
  assert.match(pool.calls[0].sql, /state='PENDING'[\s\S]*?attempts < \$3[\s\S]*?next_retry_at <= NOW\(\)/iu);
  assert.match(pool.calls[0].sql, /state='PROCESSING'[\s\S]*?lease_expires_at <= NOW\(\)/iu);
  assert.match(pool.calls[0].sql, /state='DEAD' AND EXISTS[\s\S]*?i\.status_version=auto_listing_ai_outbox\.expected_status_version/iu);
  assert.match(pool.calls[0].sql, /i\.status='PLANNING'[\s\S]*?i\.status='GENERATING'/iu);
  assert.match(pool.calls[0].sql, /state='COMPLETED'[\s\S]*?INTERVAL '3 hours'[\s\S]*?NOT EXISTS/iu);
  assert.doesNotMatch(pool.calls[0].sql, /contract_version='V1' AND attempts < \$3/iu);
  assert.match(pool.calls[0].sql, /account_id > \$1/iu);
  assert.match(pool.calls[0].sql, /GROUP BY account_id[\s\S]*?ORDER BY account_id[\s\S]*?LIMIT \$2/iu);
  assert.deepEqual(pool.calls[0].parameters, ["account-a", 2, 4]);

  await assert.rejects(
    repository.listRunnableAutoListingAiAccountIds({ afterAccountId: null, limit: 101 }),
    { code: "AUTO_LISTING_AI_OUTBOX_INVALID" },
  );
  assert.equal(pool.calls.length, 1);
});

test("DEAD reconciliation is account scoped, status-version fenced, audited and idempotent by projection", async () => {
  const pool = scriptedPool([{ rows: [{ item_id: "item-a" }] }, { rows: [] }]);
  const repository = createPostgresAiOutboxRepository({ pool });

  assert.deepEqual(await repository.reconcileDeadAutoListingAiMessages({
    accountId: "account-a", limit: 10,
  }), { recovered: 1 });
  assert.deepEqual(await repository.reconcileDeadAutoListingAiMessages({
    accountId: "account-a", limit: 10,
  }), { recovered: 0 });

  const sql = pool.calls[0].sql;
  assert.match(sql, /o\.account_id=\$1[\s\S]*?o\.state='DEAD'/iu);
  assert.match(sql, /i\.status_version=o\.expected_status_version/iu);
  assert.match(sql, /FOR UPDATE OF i SKIP LOCKED/iu);
  assert.match(sql, /SET status='RETRYABLE_ERROR'[\s\S]*?recovery_point=CASE/iu);
  assert.match(sql, /INSERT INTO auto_listing_events/iu);
  assert.match(sql, /transition_version/iu);
  assert.deepEqual(pool.calls[0].parameters, ["account-a", 10]);
  await assert.rejects(repository.reconcileDeadAutoListingAiMessages({
    accountId: "account-b", limit: 10, unexpected: true,
  }), { code: "AUTO_LISTING_AI_OUTBOX_INVALID" });
});

test("interrupted worker reconciliation waits beyond the queue budget, excludes live work and advances the status fence", async () => {
  const pool = scriptedPool([{ rows: [{ item_id: "item-a" }] }, { rows: [] }]);
  const repository = createPostgresAiOutboxRepository({ pool });
  assert.deepEqual(await repository.reconcileInterruptedAutoListingAiItems({
    accountId: "account-a", limit: 5,
  }), { recovered: 1 });
  assert.deepEqual(await repository.reconcileInterruptedAutoListingAiItems({
    accountId: "account-a", limit: 5,
  }), { recovered: 0 });
  const sql = pool.calls[0].sql;
  assert.match(sql, /i\.account_id=\$1[\s\S]*?i\.status IN \('PLANNING','GENERATING'\)/iu);
  assert.match(sql, /i\.updated_at <= NOW\(\)-INTERVAL '3 hours'/iu);
  assert.match(sql, /done\.state='COMPLETED'[\s\S]*?done\.expected_status_version=i\.status_version/iu);
  assert.match(sql, /live\.state IN \('PENDING','PROCESSING'\)/iu);
  assert.match(sql, /FOR UPDATE OF i SKIP LOCKED/iu);
  assert.match(sql, /status='RETRYABLE_ERROR'[\s\S]*?AUTO_LISTING_AI_WORKER_INTERRUPTED/iu);
  assert.match(sql, /INSERT INTO auto_listing_events/iu);
});

test("renew, complete and failure transitions require the unexpired exact account/worker/token fence", async () => {
  const processing = outboxRow({
    state: "PROCESSING", attempts: 1, lease_owner: "worker-a", lease_token: "lease-a",
    lease_expires_at: new Date("2026-08-04T00:01:00Z"),
  });
  const pool = scriptedPool([
    { rows: [{ ...processing, lease_expires_at: new Date("2026-08-04T00:02:00Z") }] },
    { rows: [{ ...processing, state: "COMPLETED", lease_owner: null, lease_token: null, lease_expires_at: null,
      publication_id: dedupeKey, published_at: new Date("2026-08-04T00:00:30Z") }] },
    { rows: [] },
  ]);
  const repository = createPostgresAiOutboxRepository({ pool });

  await repository.renewAutoListingAiMessageLease({ accountId: "account-a", itemId: "item-a", id: "ai-outbox-1", workerId: "worker-a", leaseToken: "lease-a", leaseMs: 60_000 });
  const complete = await repository.completeAutoListingAiMessage({ accountId: "account-a", itemId: "item-a", id: "ai-outbox-1", workerId: "worker-a", leaseToken: "lease-a" });
  assert.equal(complete.status, "COMPLETED");
  await assert.rejects(
    repository.deadLetterAutoListingAiMessage({ accountId: "account-a", itemId: "item-a", id: "ai-outbox-1", workerId: "worker-a", leaseToken: "stale", errorCode: "AUTO_LISTING_AI_PUBLISH_FAILED" }),
    { code: "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED" },
  );
  for (const call of pool.calls) {
    assert.match(call.sql, /account_id=\$1/i);
    assert.match(call.sql, /item_id=\$3[\s\S]*?lease_owner=\$4 AND lease_token=\$5/i);
    assert.match(call.sql, /lease_expires_at > NOW\(\)/i);
  }
});

test("retry remains pending below maxAttempts and dead-letters at the bound without raw errors", async () => {
  const pending = outboxRow({ attempts: 1, last_error_code: "AUTO_LISTING_AI_PUBLISH_RETRYABLE" });
  const dead = outboxRow({ state: "DEAD", attempts: 3, last_error_code: "AUTO_LISTING_AI_PUBLISH_RETRYABLE", dead_at: new Date() });
  const pool = scriptedPool([{ rows: [pending] }, { rows: [dead] }]);
  const repository = createPostgresAiOutboxRepository({ pool, maxAttempts: 3 });
  const input = { accountId: "account-a", itemId: "item-a", id: "ai-outbox-1", workerId: "worker-a", leaseToken: "lease-a", errorCode: "AUTO_LISTING_AI_PUBLISH_RETRYABLE" };

  assert.equal((await repository.failAutoListingAiMessage(input)).status, "PENDING");
  assert.equal((await repository.failAutoListingAiMessage(input)).status, "DEAD");
  assert.match(pool.calls[0].sql, /CASE WHEN attempts >= \$[0-9]+ THEN 'DEAD' ELSE 'PENDING' END/i);
  assert.doesNotMatch(JSON.stringify(pool.calls), /raw database exploded/i);
});

test("database errors are normalized to one safe retryable repository failure", async () => {
  const pool = scriptedPool([new Error("password=super-secret host=production.internal")]);
  const repository = createPostgresAiOutboxRepository({ pool });
  await assert.rejects(
    repository.listAutoListingAiOutbox({ accountId: "account-a", limit: 100 }),
    (error) => error.code === "AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED"
      && error.retryable === true
      && !/password|production|secret/i.test(error.message),
  );
});

test("list is bounded, cursor scoped and rejects an unknown account cursor", async () => {
  const pool = scriptedPool([{ rows: [outboxRow()] }, { rows: [] }]);
  const repository = createPostgresAiOutboxRepository({ pool });
  const rows = await repository.listAutoListingAiOutbox({ accountId: "account-a", limit: 10, afterId: "cursor-a" });
  assert.equal(rows.length, 0);
  assert.match(pool.calls[0].sql, /WHERE account_id=\$1[\s\S]*?id=\$2/i);
  assert.match(pool.calls[1].sql, /ORDER BY created_at,id LIMIT \$2/i);

  const missing = createPostgresAiOutboxRepository({ pool: scriptedPool([{ rows: [] }]) });
  await assert.rejects(
    missing.listAutoListingAiOutbox({ accountId: "account-a", limit: 10, afterId: "missing-a" }),
    { code: "AUTO_LISTING_AI_OUTBOX_INVALID" },
  );
});

test("public inputs are closed and identifiers use the 240 UTF-8 byte boundary", async () => {
  const pool = scriptedPool([]);
  const repository = createPostgresAiOutboxRepository({ pool });
  for (const execute of [
    () => repository.listAutoListingAiOutbox({ accountId: "account-a", unexpected: true }),
    () => repository.claimAutoListingAiMessages({ accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 1_000, unexpected: true }),
    () => repository.completeAutoListingAiMessage({ accountId: "account-a", itemId: "界".repeat(81), id: "ai-outbox-1", workerId: "worker-a", leaseToken: "lease-a" }),
    () => repository.failAutoListingAiMessage({ accountId: "account-a", itemId: "item-a", id: "ai-outbox-1", workerId: "worker-a", leaseToken: "lease-a", errorCode: "API_KEY_EXPOSED" }),
  ]) await assert.rejects(execute(), { code: "AUTO_LISTING_AI_OUTBOX_INVALID" });
  assert.equal(pool.calls.length, 0);
});

test("internal identifier failures are sanitized before crossing the repository boundary", async () => {
  const repository = createPostgresAiOutboxRepository({
    pool: scriptedPool([]),
    id: () => { throw new Error("password=raw-production-secret"); },
  });
  await assert.rejects(
    repository.enqueueAutoListingAiMessage(message),
    (error) => error.code === "AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED"
      && error.retryable === true
      && !/password|production|secret/i.test(error.message),
  );
});

test("factory options are closed and proxy traps cannot leak raw configuration failures", () => {
  assert.throws(
    () => createPostgresAiOutboxRepository({ pool: scriptedPool([]), unexpected: true }),
    { code: "AUTO_LISTING_AI_OUTBOX_INVALID" },
  );
  const trapped = new Proxy({}, { ownKeys() { throw new Error("password=production-secret"); } });
  assert.throws(
    () => createPostgresAiOutboxRepository(trapped),
    (error) => error.code === "AUTO_LISTING_AI_OUTBOX_INVALID" && !/password|production|secret/i.test(error.message),
  );
  assert.throws(
    () => createPostgresAiOutboxRepository({ pool: { query() {} } }),
    { code: "AUTO_LISTING_AI_OUTBOX_INVALID" },
  );
});
