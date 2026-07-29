import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("SONLI_MIGRATION_TEST_DATABASE_URL is required; use a dedicated disposable PostgreSQL database");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../db/migrations");
const migration019 = path.join(migrationsDir, "019_account_scoped_collection_and_collector_sessions.sql");
const suffix = crypto.randomUUID().replaceAll("-", "");
const schemaName = `account_scoped_collection_${suffix}`;
const pool = new Pool({ connectionString: databaseUrl });

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

async function applyMigrationsBefore019(client) {
  const migrations = (await readdir(migrationsDir))
    .filter((file) => /^(?:00[1-9]|01[0-8])_.+\.sql$/.test(file))
    .sort();
  for (const migration of migrations) {
    await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
  }
}

async function createPre019Schema(client, schema) {
  await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
  await applyMigrationsBefore019(client);

  const accountA = `account_a_${suffix}`;
  const accountB = `account_b_${suffix}`;
  const accountCascade = `account_cascade_${suffix}`;
  const storeA = `store_a_${suffix}`;
  const dataStore = `data_store_${suffix}`;
  const collectItem = `collect_item_${suffix}`;
  const rawPayload = `raw_payload_${suffix}`;
  const collectRequest = `collect_request_${suffix}`;
  const parentSession = `parent_session_${suffix}`;

  await client.query(
    `INSERT INTO accounts (id, username, display_name, role, status)
     VALUES ($1, $2, $2, 'user', 'active'), ($3, $4, $4, 'user', 'active'), ($5, $6, $6, 'user', 'active')`,
    [accountA, `user_a_${suffix}`, accountB, `user_b_${suffix}`, accountCascade, `user_c_${suffix}`],
  );
  await client.query(
    `INSERT INTO stores (id, owner_account_id, label, client_id, status)
     VALUES ($1, $2, 'Legacy store', $3, 'active')`,
    [storeA, accountA, `client_${suffix}`],
  );
  await client.query(
    "INSERT INTO data_collection_stores (id, seller_company_id) VALUES ($1, $2)",
    [dataStore, `seller_${suffix}`],
  );
  await client.query(
    `INSERT INTO account_data_collection_stores (account_id, data_collection_store_id, label)
     VALUES ($1, $2, 'Legacy data store')`,
    [accountA, dataStore],
  );
  await client.query("INSERT INTO sessions (token, account_id) VALUES ($1, $2)", [parentSession, accountA]);
  await client.query(
    `INSERT INTO collect_items (
       id, account_id, store_id, data_collection_store_id, source, identity_key, source_sku, summary
     ) VALUES ($1, $2, $3, $4, 'ozon', $5, 'sku-shared', '{}'::jsonb)`,
    [collectItem, accountA, storeA, dataStore, `identity-shared-${suffix}`],
  );
  await client.query(
    `INSERT INTO collect_raw_payloads (
       id, collect_item_id, account_id, store_id, data_collection_store_id, payload_hash, payload
     ) VALUES ($1, $2, NULL, $3, $4, $5, '{}'::jsonb)`,
    [rawPayload, collectItem, storeA, dataStore, `payload-hash-${suffix}`],
  );
  await client.query(
    `INSERT INTO collect_requests (
       id, idempotency_key, account_id, store_id, data_collection_store_id, source, source_sku,
       request_hash, content_hash, collect_item_id
     ) VALUES ($1, $2, NULL, $3, $4, 'ozon', 'sku-shared', $5, $6, $7)`,
    [collectRequest, `request-shared-${suffix}`, storeA, dataStore, `request-hash-${suffix}`, `content-hash-${suffix}`, collectItem],
  );

  return {
    accountA,
    accountB,
    accountCascade,
    collectItem,
    collectRequest,
    dataStore,
    parentSession,
    rawPayload,
  };
}

async function apply019(client) {
  await client.query(await readFile(migration019, "utf8"));
}

async function assertColumnNullable(client, table, column, expected) {
  const result = await client.query(
    `SELECT is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  assert.equal(result.rows[0]?.is_nullable, expected ? "YES" : "NO", `${table}.${column} nullability`);
}

async function assertValidMigrationBehavior(client, fixture) {
  await assertColumnNullable(client, "collect_items", "account_id", false);
  await assertColumnNullable(client, "collect_raw_payloads", "account_id", false);
  await assertColumnNullable(client, "collect_requests", "account_id", false);
  await assertColumnNullable(client, "collector_auth_tickets", "account_id", false);
  await assertColumnNullable(client, "collector_sessions", "account_id", false);
  for (const [table, column] of [
    ["collect_items", "store_id"],
    ["collect_items", "data_collection_store_id"],
    ["collect_raw_payloads", "store_id"],
    ["collect_raw_payloads", "data_collection_store_id"],
    ["collect_requests", "store_id"],
    ["collect_requests", "data_collection_store_id"],
    ["collector_tasks", "operating_store_id"],
    ["collector_tasks", "data_collection_store_id"],
    ["collector_task_runs", "operating_store_id"],
    ["collector_task_runs", "data_collection_store_id"],
    ["collector_task_items", "operating_store_id"],
    ["collector_task_items", "data_collection_store_id"],
    ["collector_task_events", "operating_store_id"],
    ["collector_exports", "operating_store_id"],
    ["collector_exports", "data_collection_store_id"],
    ["collector_market_snapshots", "operating_store_id"],
    ["collector_market_snapshots", "data_collection_store_id"],
    ["collector_category_mappings", "operating_store_id"],
    ["collector_category_mappings", "data_collection_store_id"],
  ]) {
    await assertColumnNullable(client, table, column, true);
  }

  const backfilled = await client.query(
    `SELECT
       (SELECT account_id FROM collect_raw_payloads WHERE id = $1) AS raw_account_id,
       (SELECT account_id FROM collect_requests WHERE id = $2) AS request_account_id,
       (SELECT data_collection_store_id FROM collect_items WHERE id = $3) AS item_data_store_id,
       (SELECT data_collection_store_id FROM collect_raw_payloads WHERE id = $1) AS raw_data_store_id,
       (SELECT data_collection_store_id FROM collect_requests WHERE id = $2) AS request_data_store_id`,
    [fixture.rawPayload, fixture.collectRequest, fixture.collectItem],
  );
  assert.deepEqual(backfilled.rows[0], {
    raw_account_id: fixture.accountA,
    request_account_id: fixture.accountA,
    item_data_store_id: fixture.dataStore,
    raw_data_store_id: fixture.dataStore,
    request_data_store_id: fixture.dataStore,
  });
  const historicalEvidence = await client.query(
    `SELECT
       to_regclass(format('%I.data_collection_stores', current_schema())) IS NOT NULL AS data_store_table_exists,
       EXISTS (
         SELECT 1 FROM pg_constraint fk
         WHERE fk.conrelid = 'account_data_collection_stores'::regclass
           AND fk.confrelid = 'data_collection_stores'::regclass
       ) AS data_store_foreign_key_exists`,
  );
  assert.deepEqual(historicalEvidence.rows[0], {
    data_store_table_exists: true,
    data_store_foreign_key_exists: true,
  });

  await client.query(
    `INSERT INTO collect_items (id, account_id, source, identity_key, source_sku, summary)
     VALUES ($1, $2, 'ozon', $3, 'sku-shared', '{}'::jsonb)`,
    [`collect_item_other_account_${suffix}`, fixture.accountB, `identity-shared-${suffix}`],
  );
  await assert.rejects(
    client.query(
      `INSERT INTO collect_items (id, account_id, source, identity_key, source_sku, summary)
       VALUES ($1, $2, 'ozon', $3, 'sku-shared', '{}'::jsonb)`,
      [`collect_item_same_account_${suffix}`, fixture.accountA, `identity-shared-${suffix}`],
    ),
    (error) => error?.code === "23505",
  );

  await client.query(
    `INSERT INTO collect_requests (
       id, idempotency_key, account_id, source, source_sku, request_hash, content_hash
     ) VALUES ($1, $2, $3, 'ozon', 'sku-shared', $4, $5)`,
    [`collect_request_other_account_${suffix}`, `request-shared-${suffix}`, fixture.accountB, `request-hash-other-${suffix}`, `content-hash-other-${suffix}`],
  );
  await assert.rejects(
    client.query(
      `INSERT INTO collect_requests (
         id, idempotency_key, account_id, source, source_sku, request_hash, content_hash
       ) VALUES ($1, $2, $3, 'ozon', 'sku-shared', $4, $5)`,
      [`collect_request_same_account_${suffix}`, `request-shared-${suffix}`, fixture.accountA, `request-hash-same-${suffix}`, `content-hash-same-${suffix}`],
    ),
    (error) => error?.code === "23505",
  );

  const ticketHash = `ticket-hash-${suffix}`;
  const sessionHash = `collector-session-hash-${suffix}`;
  const foreignParentSession = `foreign_parent_session_${suffix}`;
  await client.query("INSERT INTO sessions (token, account_id) VALUES ($1, $2)", [foreignParentSession, fixture.accountB]);
  await client.query(
    `INSERT INTO collector_auth_tickets (
       id, ticket_hash, account_id, parent_session_token, permissions, expires_at
     ) VALUES ($1, $2, $3, $4, '["collector:run"]'::jsonb, NOW() + INTERVAL '1 hour')`,
    [`ticket_${suffix}`, ticketHash, fixture.accountA, fixture.parentSession],
  );
  await client.query(
    `INSERT INTO collector_sessions (
       id, token_hash, account_id, parent_session_token, device_fingerprint, extension_version, permissions, expires_at
     ) VALUES ($1, $2, $3, $4, 'device-fingerprint', '1.0.0', '["collector:run"]'::jsonb, NOW() + INTERVAL '1 hour')`,
    [`collector_session_${suffix}`, sessionHash, fixture.accountA, fixture.parentSession],
  );
  await assert.rejects(
    client.query(
      `INSERT INTO collector_auth_tickets (id, ticket_hash, account_id, parent_session_token, permissions, expires_at)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, NOW() + INTERVAL '1 hour')`,
      [`cross_account_ticket_${suffix}`, `cross-account-ticket-hash-${suffix}`, fixture.accountA, foreignParentSession],
    ),
    (error) => error?.code === "23503",
  );
  await assert.rejects(
    client.query(
      `INSERT INTO collector_sessions (id, token_hash, account_id, parent_session_token, device_fingerprint, extension_version, permissions, expires_at)
       VALUES ($1, $2, $3, $4, 'cross-account-device', '1.0.0', '[]'::jsonb, NOW() + INTERVAL '1 hour')`,
      [`cross_account_session_${suffix}`, `cross-account-session-hash-${suffix}`, fixture.accountA, foreignParentSession],
    ),
    (error) => error?.code === "23503",
  );
  await assert.rejects(
    client.query(
      `INSERT INTO collector_auth_tickets (id, ticket_hash, account_id, parent_session_token, permissions, expires_at)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, NOW() + INTERVAL '1 hour')`,
      [`duplicate_ticket_${suffix}`, ticketHash, fixture.accountA, fixture.parentSession],
    ),
    (error) => error?.code === "23505",
  );
  await assert.rejects(
    client.query(
      `INSERT INTO collector_sessions (id, token_hash, account_id, parent_session_token, device_fingerprint, extension_version, permissions, expires_at)
       VALUES ($1, $2, $3, $4, 'device-fingerprint-2', '1.0.0', '[]'::jsonb, NOW() + INTERVAL '1 hour')`,
      [`duplicate_session_${suffix}`, sessionHash, fixture.accountA, fixture.parentSession],
    ),
    (error) => error?.code === "23505",
  );
  const consumedOnce = await client.query(
    "UPDATE collector_auth_tickets SET consumed_at = NOW() WHERE ticket_hash = $1 AND consumed_at IS NULL RETURNING id",
    [ticketHash],
  );
  const consumedTwice = await client.query(
    "UPDATE collector_auth_tickets SET consumed_at = NOW() WHERE ticket_hash = $1 AND consumed_at IS NULL RETURNING id",
    [ticketHash],
  );
  assert.equal(consumedOnce.rowCount, 1);
  assert.equal(consumedTwice.rowCount, 0);

  const cascadeSession = `cascade_parent_session_${suffix}`;
  await client.query("INSERT INTO sessions (token, account_id) VALUES ($1, $2)", [cascadeSession, fixture.accountCascade]);
  await client.query(
    `INSERT INTO collector_auth_tickets (id, ticket_hash, account_id, parent_session_token, permissions, expires_at)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, NOW() + INTERVAL '1 hour')`,
    [`cascade_ticket_${suffix}`, `cascade-ticket-hash-${suffix}`, fixture.accountCascade, cascadeSession],
  );
  await client.query(
    `INSERT INTO collector_sessions (id, token_hash, account_id, parent_session_token, device_fingerprint, extension_version, permissions, expires_at)
     VALUES ($1, $2, $3, $4, 'cascade-device', '1.0.0', '[]'::jsonb, NOW() + INTERVAL '1 hour')`,
    [`cascade_collector_session_${suffix}`, `cascade-session-hash-${suffix}`, fixture.accountCascade, cascadeSession],
  );
  await client.query("DELETE FROM accounts WHERE id = $1", [fixture.accountCascade]);
  const cascaded = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM collector_auth_tickets WHERE account_id = $1) AS ticket_count,
       (SELECT COUNT(*)::int FROM collector_sessions WHERE account_id = $1) AS session_count`,
    [fixture.accountCascade],
  );
  assert.deepEqual(cascaded.rows[0], { ticket_count: 0, session_count: 0 });
}

async function createRunTaskConflictFixture(client, schema) {
  const fixture = await createPre019Schema(client, schema);
  const storeB = `store_b_${suffix}`;
  const dataStoreB = `data_store_b_${suffix}`;
  const taskA = `task_a_${suffix}`;
  const taskB = `task_b_${suffix}`;
  const runB = `run_b_${suffix}`;
  const pricingVersion = `pricing_b_${suffix}`;

  await client.query(
    `INSERT INTO stores (id, owner_account_id, label, client_id, status)
     VALUES ($1, $2, 'Account B store', $3, 'active')`,
    [storeB, fixture.accountB, `client_b_${suffix}`],
  );
  await client.query("INSERT INTO data_collection_stores (id, seller_company_id) VALUES ($1, $2)", [dataStoreB, `seller_b_${suffix}`]);
  await client.query(
    "INSERT INTO account_data_collection_stores (account_id, data_collection_store_id, label) VALUES ($1, $2, 'Account B data store')",
    [fixture.accountB, dataStoreB],
  );
  await client.query(
    `INSERT INTO collector_tasks (id, account_id, operating_store_id, data_collection_store_id, name, task_type)
     VALUES ($1, $2, $3, $4, 'Task A', 'SELLER_ANALYTICS'), ($5, $6, $7, $8, 'Task B', 'SELLER_ANALYTICS')`,
    [taskA, fixture.accountA, `store_a_${suffix}`, fixture.dataStore, taskB, fixture.accountB, storeB, dataStoreB],
  );
  await client.query(
    `INSERT INTO pricing_config_versions (id, version_no, scope_type, scope_id, status, config_hash)
     VALUES ($1, 1, 'account', $2, 'ACTIVE', $1)`,
    [pricingVersion, fixture.accountB],
  );
  await client.query(
    `INSERT INTO collector_task_runs (
       id, task_id, account_id, operating_store_id, data_collection_store_id, pricing_config_version_id, run_no
     ) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
    [runB, taskB, fixture.accountB, storeB, dataStoreB, pricingVersion],
  );
  const event = await client.query(
    `INSERT INTO collector_task_events (
       task_id, run_id, account_id, operating_store_id, data_collection_store_id, event_type
     ) VALUES ($1, $2, $3, $4, $5, 'MIGRATION_CONFLICT_FIXTURE')
     RETURNING id`,
    [taskA, runB, fixture.accountA, `store_a_${suffix}`, fixture.dataStore],
  );
  return { eventId: String(event.rows[0].id) };
}

const client = await pool.connect();
const rejectedSchema = `${schemaName}_rejected`;
const childConflictSchema = `${schemaName}_child_conflict`;
const runTaskConflictSchema = `${schemaName}_run_task_conflict`;
try {
  const fixture = await createPre019Schema(client, schemaName);
  await apply019(client);
  await assertValidMigrationBehavior(client, fixture);

  const rejectedFixture = await createPre019Schema(client, rejectedSchema);
  await client.query(
    `INSERT INTO ${quoteIdentifier(rejectedSchema)}.collect_items (
       id, account_id, source, identity_key, source_sku, summary
     ) VALUES ($1, NULL, 'ozon', '', 'unowned-sku', '{}'::jsonb)`,
    [`unowned_collect_item_${suffix}`],
  );
  await client.query(`SET search_path TO ${quoteIdentifier(rejectedSchema)}, public`);
  await assert.rejects(
    apply019(client),
    (error) => error?.message.includes("collect_items") && error?.message.includes(`unowned_collect_item_${suffix}`),
  );
  assert.ok(rejectedFixture.collectItem);

  const childConflictFixture = await createPre019Schema(client, childConflictSchema);
  await client.query(
    `UPDATE ${quoteIdentifier(childConflictSchema)}.collect_raw_payloads
     SET account_id = $1
     WHERE id = $2`,
    [childConflictFixture.accountB, childConflictFixture.rawPayload],
  );
  await client.query(`SET search_path TO ${quoteIdentifier(childConflictSchema)}, public`);
  await assert.rejects(
    apply019(client),
    (error) => error?.message.includes("collect_raw_payloads") && error?.message.includes(childConflictFixture.rawPayload),
  );

  const runTaskConflictFixture = await createRunTaskConflictFixture(client, runTaskConflictSchema);
  await client.query(`SET search_path TO ${quoteIdentifier(runTaskConflictSchema)}, public`);
  await assert.rejects(
    apply019(client),
    (error) => error?.message.includes("collector_task_events") && error?.message.includes(runTaskConflictFixture.eventId),
  );
  console.log("account-scoped collection migration integration passed");
} finally {
  await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(runTaskConflictSchema)} CASCADE`).catch(() => {});
  await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(childConflictSchema)} CASCADE`).catch(() => {});
  await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(rejectedSchema)} CASCADE`).catch(() => {});
  await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`).catch(() => {});
  client.release();
  await pool.end();
}
