import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";

import { autoListingAiMessageDedupeKey } from "../auto-listing-ai-message.mjs";
import { createPostgresAiOutboxRepository } from "../auto-listing-ai-outbox-postgres.mjs";
import {
  applyAutoListingAiChannelPoolBaseMigrations,
  applyAutoListingAiChannelPoolMigration,
} from "./auto-listing-ai-runtime-postgres-fixture.mjs";

const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1"
  && Boolean(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const hash = (character) => character.repeat(64);

let adminPool;
let admin;
let pool;
let schema;
let suffix;
let sequence = 0;

before(async () => {
  if (!enabled) return;
  const { Pool } = await import("pg");
  suffix = crypto.randomUUID().replaceAll("-", "");
  schema = `auto_listing_ai_allocation_${suffix}`;
  adminPool = new Pool({ connectionString, max: 2 });
  admin = await adminPool.connect();
  await admin.query(`CREATE SCHEMA ${quote(schema)}`);
  await admin.query(`SET search_path TO ${quote(schema)}, public`);
  await applyAutoListingAiChannelPoolBaseMigrations(admin);
  await applyAutoListingAiChannelPoolMigration(admin);
  pool = new Pool({ connectionString, max: 12, options: `-c search_path=${schema},public` });
});

after(async () => {
  if (!enabled) return;
  try { await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); } finally {
    admin.release();
    await pool.end();
    await adminPool.end();
  }
});

async function seedScenario({ itemCount, channelCount }) {
  sequence += 1;
  const marker = `s${sequence}-${suffix}`;
  const accountId = `account-${marker}`;
  const profileId = `profile-${marker}`;
  const jobId = `job-${marker}`;
  const storeId = `store-${marker}`;
  const warehouseId = `warehouse-${marker}`;
  const strategyId = `strategy-${marker}`;
  await pool.query(
    "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
    [accountId, `user-${marker}`],
  );
  await pool.query(
    "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$1,$1,$2,'active',$3)",
    [storeId, `client-${marker}`, accountId],
  );
  await pool.query(
    "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$1,'FBS','active',TRUE,FALSE)",
    [warehouseId, storeId],
  );
  await pool.query(
    "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,$3,1,'PUBLISHED','{}'::JSONB,$4)",
    [strategyId, accountId, `strategy-${marker}`, hash("a")],
  );

  const connectionIds = [];
  const channelIds = [];
  for (let index = 0; index < channelCount; index += 1) {
    const connectionId = `connection-${index + 1}-${marker}`;
    connectionIds.push(connectionId);
    await pool.query(
      `INSERT INTO ai_gateway_connection_versions (
         account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
         fingerprint,status,idempotency_key,request_hash,correlation_id,created_by
       ) VALUES ($1,$2,1,$2,'https://gateway.invalid','ciphertext','iv','tag','aes-256-gcm','local-v1',
         $3,'PENDING',$4,$5,$6,$1)`,
      [accountId, connectionId, `fingerprint-${index}-${marker}`, `connection-key-${index}-${marker}`,
        hash(String.fromCharCode(98 + index)), `connection-correlation-${index}-${marker}`],
    );
    await pool.query(
      `UPDATE ai_gateway_connection_versions
          SET status='VALIDATED',status_version=2,validation_result='{"outcome":"PASSED"}'::JSONB,
              validation_hash=$3,validated_at=NOW(),validated_by=$1
        WHERE account_id=$1 AND id=$2 AND version=1`,
      [accountId, connectionId, hash("d")],
    );
    if (index === 0) {
      await pool.query(
        `UPDATE ai_gateway_connection_versions
            SET status='ACTIVE',status_version=3,activated_at=NOW(),activated_by=$1
          WHERE account_id=$1 AND id=$2 AND version=1`,
        [accountId, connectionId],
      );
    }
  }
  await pool.query(
    `INSERT INTO ai_gateway_profiles (
       id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
       text_model,image_model,config_version,enabled,connection_id,connection_version
     ) VALUES ($1,$2,'Connected','https://gateway.invalid','SUB2API_ENCRYPTED_KEY',
       'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1,TRUE,$3,1)`,
    [profileId, accountId, connectionIds[0]],
  );
  for (const [index, connectionId] of connectionIds.entries()) {
    const channelId = `channel-${index + 1}-${marker}`;
    channelIds.push(channelId);
    await pool.query(
      `INSERT INTO auto_listing_ai_profile_channels (
         account_id,profile_id,profile_version,channel_id,display_name,connection_id,connection_version,channel_order
       ) VALUES ($1,$2,1,$3,$3,$4,1,$5)`,
      [accountId, profileId, channelId, connectionId, index + 1],
    );
  }
  await pool.query(
    `INSERT INTO auto_listing_jobs (
       id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version
     ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,1)`,
    [jobId, accountId, `job-key-${marker}`, hash("e"), strategyId, profileId],
  );

  const items = [];
  for (let index = 0; index < itemCount; index += 1) {
    const itemId = `item-${index + 1}-${marker}`;
    const snapshotId = `snapshot-${index + 1}-${marker}`;
    const outboxId = `outbox-${index + 1}-${marker}`;
    const correlationId = `correlation-${index + 1}-${marker}`;
    const message = {
      contractVersion: "V1", accountId, itemId, phase: "PLAN_CONTENT",
      expectedStatusVersion: 3, correlationId,
    };
    await pool.query(
      "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
      [snapshotId, accountId, `record-${index + 1}-${marker}`, hash("f")],
    );
    await pool.query(
      `INSERT INTO auto_listing_job_items (
         id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
       ) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',3,$7)`,
      [itemId, jobId, accountId, snapshotId, storeId, warehouseId, index + 1],
    );
    await pool.query(
      `INSERT INTO auto_listing_ai_outbox (
         id,account_id,job_id,item_id,event_type,dedupe_key,state,contract_version,phase,
         expected_status_version,correlation_id,payload,next_retry_at
       ) VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,'PENDING','V1','PLAN_CONTENT',3,$6,$7::JSONB,NOW())`,
      [outboxId, accountId, jobId, itemId, autoListingAiMessageDedupeKey(message), correlationId, JSON.stringify(message)],
    );
    items.push({ itemId, outboxId, message });
  }
  return {
    accountId, profileId, jobId, storeId, warehouseId, strategyId,
    items, connectionIds, channelIds,
  };
}

async function insertOutbox(scenario, {
  itemId, phase, target = null, expectedStatusVersion = 3, suffixLabel,
  nextRetryAt = new Date(), createdAt = new Date(), attempts = 0,
}) {
  const outboxId = `outbox-${suffixLabel}-${suffix}`;
  const correlationId = `correlation-${suffixLabel}-${suffix}`;
  const message = {
    contractVersion: "V1", accountId: scenario.accountId, itemId, phase,
    expectedStatusVersion, correlationId,
    ...(phase === "GENERATE_IMAGE_SLOT" ? { slotKey: target } : {}),
    ...(phase === "MATERIALIZE_SOURCE_ASSET" ? { sourceAssetId: target } : {}),
  };
  await pool.query(
    `INSERT INTO auto_listing_ai_outbox (
       id,account_id,job_id,item_id,slot_key,event_type,dedupe_key,state,attempts,available_at,
       contract_version,phase,phase_target_id,expected_status_version,correlation_id,payload,next_retry_at,created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,'V1',$6,$5,$10,$11,$12::JSONB,$9,$13)`,
    [outboxId, scenario.accountId, scenario.jobId, itemId, target, phase,
      autoListingAiMessageDedupeKey(message), attempts, nextRetryAt, expectedStatusVersion,
      correlationId, JSON.stringify(message), createdAt],
  );
  return { outboxId, message };
}

async function claim(repository, scenario, workerId = "relay-test", limit = 10) {
  return repository.claimAutoListingAiWork({
    accountId: scenario.accountId, workerId, limit, leaseMs: 60_000,
  });
}

async function completePublishedClaim(row) {
  await pool.query(
    `UPDATE auto_listing_ai_outbox
        SET state='COMPLETED',published_at=NOW(),next_retry_at=NULL,
            lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
      WHERE account_id=$1 AND id=$2`,
    [row.accountId, row.id],
  );
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET execution_lease_owner=NULL,execution_lease_token=NULL,execution_lease_expires_at=NULL,updated_at=NOW()
      WHERE account_id=$1 AND channel_id=$2`,
    [row.accountId, row.workMessage.execution.channelId],
  );
}

async function executionSnapshot(scenario, row) {
  return (await pool.query(
    `SELECT o.state,o.attempts,o.dispatch_contract_version,o.dispatch_generation,
            o.publication_id,o.published_at,o.lease_owner,o.lease_token,o.lease_expires_at,
            o.last_error_code,o.dead_at,
            i.status AS item_status,i.status_version AS item_status_version,
            i.last_ai_connection_id,i.last_ai_connection_version,
            c.assigned_job_id,c.assigned_item_id,c.assigned_status_version,
            c.execution_lease_owner,c.execution_lease_token,c.execution_lease_expires_at,
            (SELECT COUNT(*)::INTEGER FROM auto_listing_events AS event
              WHERE event.account_id=o.account_id AND event.item_id=o.item_id) AS event_count
       FROM auto_listing_ai_outbox AS o
       JOIN auto_listing_job_items AS i
         ON i.account_id=o.account_id AND i.job_id=o.job_id AND i.id=o.item_id
       JOIN auto_listing_ai_profile_channels AS c
         ON c.account_id=o.account_id AND c.assigned_job_id=o.job_id AND c.assigned_item_id=o.item_id
      WHERE o.account_id=$1 AND o.id=$2 AND c.channel_id=$3`,
    [scenario.accountId, row.id, row.workMessage.execution.channelId],
  )).rows[0];
}

test("one connected channel allocates only the earliest item without touching the waiter", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 90_000,
}, async () => {
  const scenario = await seedScenario({ itemCount: 2, channelCount: 1 });
  const repository = createPostgresAiOutboxRepository({ pool, token: () => `lease-${suffix}` });
  const claim = repository.claimAutoListingAiWork?.bind(repository)
    ?? repository.claimAutoListingAiMessages.bind(repository);

  const claimed = await claim({
    accountId: scenario.accountId, workerId: "relay-one", limit: 2, leaseMs: 60_000,
  });

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].itemId, scenario.items[0].itemId);
  const waiting = (await pool.query(
    "SELECT state,attempts,dispatch_generation FROM auto_listing_ai_outbox WHERE id=$1",
    [scenario.items[1].outboxId],
  )).rows[0];
  assert.deepEqual(waiting, { state: "PENDING", attempts: 0, dispatch_generation: 0 });
});

test("two channels allocate two distinct items and leave the third untouched", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 3, channelCount: 2 });
  const repository = createPostgresAiOutboxRepository({ pool });
  const claimed = await claim(repository, scenario);
  assert.deepEqual(claimed.map((row) => row.itemId), scenario.items.slice(0, 2).map((item) => item.itemId));
  assert.equal(new Set(claimed.map((row) => row.workMessage.execution.channelId)).size, 2);
  assert.deepEqual((await pool.query(
    "SELECT state,attempts,dispatch_generation FROM auto_listing_ai_outbox WHERE id=$1",
    [scenario.items[2].outboxId],
  )).rows[0], { state: "PENDING", attempts: 0, dispatch_generation: 0 });
});

test("a fixed item's next phase has capacity precedence and keeps its channel", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 2, channelCount: 1 });
  const repository = createPostgresAiOutboxRepository({ pool });
  const [first] = await claim(repository, scenario, "relay-first", 1);
  await completePublishedClaim(first);
  await pool.query(
    "UPDATE auto_listing_ai_outbox SET next_retry_at='2020-01-01T00:00:00Z'::TIMESTAMPTZ WHERE id=$1",
    [scenario.items[1].outboxId],
  );
  const next = await insertOutbox(scenario, {
    itemId: scenario.items[0].itemId, phase: "MATERIALIZE_SOURCE_ASSET",
    target: `source-${suffix}`, suffixLabel: `fixed-next-${sequence}`,
    nextRetryAt: new Date("2021-01-01T00:00:00Z"),
  });

  const [claimed] = await claim(repository, scenario, "relay-next", 1);
  assert.equal(claimed.id, next.outboxId);
  assert.equal(claimed.itemId, scenario.items[0].itemId);
  assert.equal(claimed.workMessage.execution.channelId, first.workMessage.execution.channelId);
  assert.equal((await pool.query(
    "SELECT assigned_status_version FROM auto_listing_ai_profile_channels WHERE account_id=$1 AND channel_id=$2",
    [scenario.accountId, scenario.channelIds[0]],
  )).rows[0].assigned_status_version, 3);
  assert.deepEqual((await pool.query(
    "SELECT state,attempts FROM auto_listing_ai_outbox WHERE id=$1",
    [scenario.items[1].outboxId],
  )).rows[0], { state: "PENDING", attempts: 0 });
});

test("a channel-failure recovery can use a fixed assignment with no remaining work", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 2, channelCount: 1 });
  const repository = createPostgresAiOutboxRepository({ pool });
  const [first] = await claim(repository, scenario, "relay-first", 1);
  await completePublishedClaim(first);
  await pool.query(
    `UPDATE auto_listing_ai_outbox
        SET attempts=1,last_error_code='RETRYABLE_GATEWAY',
            next_retry_at='2021-01-01T00:00:00Z'::TIMESTAMPTZ
      WHERE id=$1`,
    [scenario.items[1].outboxId],
  );

  const [recovery] = await claim(repository, scenario, "relay-recovery", 1);
  assert.equal(recovery.id, scenario.items[1].outboxId);
  assert.equal(recovery.itemId, scenario.items[1].itemId);
  assert.equal(recovery.workMessage.execution.channelId, first.workMessage.execution.channelId);
  assert.deepEqual((await pool.query(
    `SELECT assigned_item_id,execution_lease_owner
       FROM auto_listing_ai_profile_channels WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, scenario.channelIds[0]],
  )).rows[0], {
    assigned_item_id: scenario.items[1].itemId,
    execution_lease_owner: "relay-recovery",
  });
});

test("a channel-failure recovery waits while the fixed item has runnable work", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 2, channelCount: 1 });
  const repository = createPostgresAiOutboxRepository({ pool });
  const [first] = await claim(repository, scenario, "relay-first", 1);
  await completePublishedClaim(first);

  const fixedNext = await insertOutbox(scenario, {
    itemId: scenario.items[0].itemId, phase: "MATERIALIZE_SOURCE_ASSET",
    target: `source-${suffix}`, suffixLabel: `fixed-before-recovery-${sequence}`,
    nextRetryAt: new Date("2020-01-01T00:00:00Z"),
  });
  await pool.query(
    `UPDATE auto_listing_ai_outbox
        SET attempts=1,last_error_code='RETRYABLE_GATEWAY',
            next_retry_at='2021-01-01T00:00:00Z'::TIMESTAMPTZ
      WHERE id=$1`,
    [scenario.items[1].outboxId],
  );

  const [claimed] = await claim(repository, scenario, "relay-fixed-continuation", 1);
  assert.equal(claimed.id, fixedNext.outboxId);
  assert.equal(claimed.itemId, scenario.items[0].itemId);
  assert.equal(claimed.workMessage.execution.channelId, first.workMessage.execution.channelId);
  assert.deepEqual((await pool.query(
    "SELECT state,attempts FROM auto_listing_ai_outbox WHERE id=$1",
    [scenario.items[1].outboxId],
  )).rows[0], { state: "PENDING", attempts: 1 });
});

test("superseded unsent work is retired before the current status version continues", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 1 });
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET assigned_job_id=$3,assigned_item_id=$4,assigned_status_version=3,assigned_at=NOW()
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, scenario.channelIds[0], scenario.jobId, scenario.items[0].itemId],
  );
  await pool.query(
    "UPDATE auto_listing_job_items SET status_version=4 WHERE account_id=$1 AND id=$2",
    [scenario.accountId, scenario.items[0].itemId],
  );
  const current = await insertOutbox(scenario, {
    itemId: scenario.items[0].itemId, phase: "PLAN_CONTENT", expectedStatusVersion: 4,
    suffixLabel: `current-generation-blocked-${sequence}`,
  });

  const [claimed] = await claim(
    createPostgresAiOutboxRepository({ pool }), scenario, "relay-current-continues", 1,
  );
  assert.equal(claimed.id, current.outboxId);
  assert.equal(claimed.itemId, scenario.items[0].itemId);
  assert.deepEqual((await pool.query(
    `SELECT assigned_job_id,assigned_item_id,assigned_status_version
       FROM auto_listing_ai_profile_channels WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, scenario.channelIds[0]],
  )).rows[0], {
    assigned_job_id: scenario.jobId,
    assigned_item_id: scenario.items[0].itemId,
    assigned_status_version: 4,
  });
  assert.deepEqual((await pool.query(
    "SELECT state,attempts,dispatch_generation FROM auto_listing_ai_outbox WHERE id=$1",
    [current.outboxId],
  )).rows[0], { state: "PROCESSING", attempts: 1, dispatch_generation: 1 });
  assert.deepEqual((await pool.query(
    "SELECT state,attempts FROM auto_listing_ai_outbox WHERE id=$1",
    [scenario.items[0].outboxId],
  )).rows[0], { state: "COMPLETED", attempts: 0 });
});

test("a live old status-version execution blocks the current generation until its lease expires", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 1 });
  await pool.query(
    `UPDATE auto_listing_ai_outbox
        SET state='PROCESSING',attempts=1,dispatch_contract_version='CHANNEL_WORK_V1',
            dispatch_generation=1,lease_owner='old-worker',lease_token='old-token',
            lease_expires_at=NOW()+INTERVAL '10 minutes',
            publication_id=dedupe_key || ':1',dispatch_queued_at=NOW()
      WHERE account_id=$1 AND id=$2`,
    [scenario.accountId, scenario.items[0].outboxId],
  );
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET assigned_job_id=$3,assigned_item_id=$4,assigned_status_version=3,assigned_at=NOW(),
            execution_lease_owner='old-worker',execution_lease_token='old-token',
            execution_lease_expires_at=NOW()+INTERVAL '10 minutes'
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, scenario.channelIds[0], scenario.jobId, scenario.items[0].itemId],
  );
  await pool.query(
    "UPDATE auto_listing_job_items SET status_version=4 WHERE account_id=$1 AND id=$2",
    [scenario.accountId, scenario.items[0].itemId],
  );
  const current = await insertOutbox(scenario, {
    itemId: scenario.items[0].itemId, phase: "PLAN_CONTENT", expectedStatusVersion: 4,
    suffixLabel: `current-generation-waits-for-live-old-${sequence}`,
  });

  assert.deepEqual(await claim(createPostgresAiOutboxRepository({ pool }), scenario, "relay-current-waiting", 1), []);
  assert.deepEqual((await pool.query(
    "SELECT state,lease_owner FROM auto_listing_ai_outbox WHERE account_id=$1 AND id=$2",
    [scenario.accountId, scenario.items[0].outboxId],
  )).rows[0], { state: "PROCESSING", lease_owner: "old-worker" });
  assert.deepEqual((await pool.query(
    "SELECT state,attempts FROM auto_listing_ai_outbox WHERE account_id=$1 AND id=$2",
    [scenario.accountId, current.outboxId],
  )).rows[0], { state: "PENDING", attempts: 0 });
  assert.deepEqual((await pool.query(
    `SELECT assigned_status_version,execution_lease_owner
       FROM auto_listing_ai_profile_channels WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, scenario.channelIds[0]],
  )).rows[0], { assigned_status_version: 3, execution_lease_owner: "old-worker" });
});

test("a stale status-version assignment is cleared before normal affinity selection", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 2 });
  await pool.query(
    `UPDATE auto_listing_ai_outbox
        SET state='COMPLETED',publication_id=dedupe_key,published_at=NOW(),next_retry_at=NULL
      WHERE id=$1`,
    [scenario.items[0].outboxId],
  );
  await pool.query(
    `UPDATE auto_listing_job_items
        SET status_version=4,last_ai_connection_id=$3,last_ai_connection_version=1,
            last_ai_channel_assigned_at=NOW()
      WHERE account_id=$1 AND id=$2`,
    [scenario.accountId, scenario.items[0].itemId, scenario.connectionIds[1]],
  );
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET assigned_job_id=$3,assigned_item_id=$4,assigned_status_version=3,assigned_at=NOW()
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, scenario.channelIds[0], scenario.jobId, scenario.items[0].itemId],
  );
  const current = await insertOutbox(scenario, {
    itemId: scenario.items[0].itemId, phase: "PLAN_CONTENT", expectedStatusVersion: 4,
    suffixLabel: `current-generation-affinity-${sequence}`,
  });

  const [claimed] = await claim(createPostgresAiOutboxRepository({ pool }), scenario, "relay-current-affinity", 1);
  assert.equal(claimed.id, current.outboxId);
  assert.equal(claimed.workMessage.execution.channelId, scenario.channelIds[1]);
  assert.deepEqual((await pool.query(
    `SELECT channel_id,assigned_item_id,assigned_status_version
       FROM auto_listing_ai_profile_channels WHERE account_id=$1 ORDER BY channel_order`,
    [scenario.accountId],
  )).rows, [
    { channel_id: scenario.channelIds[0], assigned_item_id: null, assigned_status_version: null },
    { channel_id: scenario.channelIds[1], assigned_item_id: scenario.items[0].itemId, assigned_status_version: 4 },
  ]);
});

test("multiple image slots for one item never receive simultaneous execution leases", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 2 });
  await pool.query(
    "UPDATE auto_listing_job_items SET status='GENERATING' WHERE account_id=$1 AND id=$2",
    [scenario.accountId, scenario.items[0].itemId],
  );
  const slots = await Promise.all(["slot-a", "slot-b"].map((slot) => insertOutbox(scenario, {
    itemId: scenario.items[0].itemId, phase: "GENERATE_IMAGE_SLOT", target: `${slot}-${suffix}`,
    suffixLabel: `${slot}-${sequence}`,
  })));
  await pool.query(
    "UPDATE auto_listing_ai_outbox SET created_at='2020-01-01T00:00:00Z'::TIMESTAMPTZ,next_retry_at='2020-01-01T00:00:00Z'::TIMESTAMPTZ WHERE id=ANY($1::TEXT[])",
    [slots.map((slot) => slot.outboxId)],
  );
  const repository = createPostgresAiOutboxRepository({ pool });
  const claimed = await claim(repository, scenario);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, slots.map((slot) => slot.outboxId).sort()[0]);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::INTEGER AS count FROM auto_listing_ai_outbox
      WHERE account_id=$1 AND item_id=$2 AND state='PROCESSING' AND lease_expires_at>NOW()`,
    [scenario.accountId, scenario.items[0].itemId],
  )).rows[0].count, 1);
});

test("an expired execution lease is reclaimed by a new owner without changing the fixed item", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 1 });
  const repository = createPostgresAiOutboxRepository({ pool });
  const [first] = await claim(repository, scenario, "relay-old", 1);
  await pool.query(
    "UPDATE auto_listing_ai_outbox SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [first.id],
  );
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET execution_lease_expires_at=NOW()-INTERVAL '1 second'
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, scenario.channelIds[0]],
  );
  const [reclaimed] = await claim(repository, scenario, "relay-new", 1);
  assert.equal(reclaimed.itemId, first.itemId);
  assert.equal(reclaimed.workMessage.execution.channelId, first.workMessage.execution.channelId);
  assert.equal(reclaimed.workMessage.execution.dispatchGeneration, 2);
  assert.equal(reclaimed.leaseOwner, "relay-new");
  assert.deepEqual((await pool.query(
    `SELECT assigned_job_id,assigned_item_id,execution_lease_owner
       FROM auto_listing_ai_profile_channels WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, scenario.channelIds[0]],
  )).rows[0], {
    assigned_job_id: scenario.jobId,
    assigned_item_id: scenario.items[0].itemId,
    execution_lease_owner: "relay-new",
  });
});

test("stale assignments are reclaimed only for a successful candidate", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  for (const staleStatus of ["READY_FOR_REVIEW", "CANCELLED", "PLANNING"]) {
    const scenario = await seedScenario({ itemCount: 2, channelCount: 1 });
    await pool.query(
      `UPDATE auto_listing_ai_outbox
          SET state='COMPLETED',publication_id=dedupe_key,published_at=NOW(),next_retry_at=NULL
        WHERE id=$1`,
      [scenario.items[0].outboxId],
    );
    await pool.query(
      "UPDATE auto_listing_job_items SET status=$2 WHERE account_id=$1 AND id=$3",
      [scenario.accountId, staleStatus, scenario.items[0].itemId],
    );
    await pool.query(
      `UPDATE auto_listing_ai_profile_channels
          SET assigned_job_id=$3,assigned_item_id=$4,assigned_status_version=3,assigned_at=NOW()
        WHERE account_id=$1 AND channel_id=$2`,
      [scenario.accountId, scenario.channelIds[0], scenario.jobId, scenario.items[0].itemId],
    );
    const [claimed] = await claim(createPostgresAiOutboxRepository({ pool }), scenario, `relay-${staleStatus}`, 1);
    assert.equal(claimed.itemId, scenario.items[1].itemId);
  }
});

test("disabled, cooling, and revalidation-required channels are excluded without side effects", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 3 });
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET enabled=CASE channel_id WHEN $2 THEN FALSE ELSE enabled END,
            cooldown_until=CASE channel_id WHEN $3 THEN NOW()+INTERVAL '1 hour' ELSE cooldown_until END,
            requires_revalidation=CASE channel_id WHEN $4 THEN TRUE ELSE requires_revalidation END
      WHERE account_id=$1`,
    [scenario.accountId, ...scenario.channelIds],
  );
  const beforeState = (await pool.query(
    `SELECT o.state,o.attempts,o.dispatch_generation,i.last_ai_connection_id,
            (SELECT COUNT(*)::INTEGER FROM auto_listing_events e WHERE e.account_id=o.account_id) AS events
       FROM auto_listing_ai_outbox o JOIN auto_listing_job_items i ON i.id=o.item_id WHERE o.id=$1`,
    [scenario.items[0].outboxId],
  )).rows[0];
  assert.deepEqual(await claim(createPostgresAiOutboxRepository({ pool }), scenario), []);
  const afterState = (await pool.query(
    `SELECT o.state,o.attempts,o.dispatch_generation,i.last_ai_connection_id,
            (SELECT COUNT(*)::INTEGER FROM auto_listing_events e WHERE e.account_id=o.account_id) AS events
       FROM auto_listing_ai_outbox o JOIN auto_listing_job_items i ON i.id=o.item_id WHERE o.id=$1`,
    [scenario.items[0].outboxId],
  )).rows[0];
  assert.deepEqual(afterState, beforeState);
});

test("an empty claim never performs an unrelated stale-assignment maintenance sweep", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 1 });
  await pool.query(
    `UPDATE auto_listing_ai_outbox
        SET state='COMPLETED',publication_id=dedupe_key,published_at=NOW(),next_retry_at=NULL
      WHERE id=$1`,
    [scenario.items[0].outboxId],
  );
  await pool.query(
    "UPDATE auto_listing_job_items SET status='READY_FOR_REVIEW' WHERE account_id=$1 AND id=$2",
    [scenario.accountId, scenario.items[0].itemId],
  );
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET assigned_job_id=$3,assigned_item_id=$4,assigned_status_version=3,assigned_at=NOW()
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, scenario.channelIds[0], scenario.jobId, scenario.items[0].itemId],
  );
  assert.deepEqual(await claim(createPostgresAiOutboxRepository({ pool }), scenario), []);
  assert.deepEqual((await pool.query(
    `SELECT assigned_job_id,assigned_item_id FROM auto_listing_ai_profile_channels
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, scenario.channelIds[0]],
  )).rows[0], { assigned_job_id: scenario.jobId, assigned_item_id: scenario.items[0].itemId });
});

test("last exact connection affinity wins before channel order", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 2 });
  await pool.query(
    `UPDATE auto_listing_job_items
        SET last_ai_connection_id=$3,last_ai_connection_version=1,last_ai_channel_assigned_at=NOW()
      WHERE account_id=$1 AND id=$2`,
    [scenario.accountId, scenario.items[0].itemId, scenario.connectionIds[1]],
  );
  const [claimed] = await claim(createPostgresAiOutboxRepository({ pool }), scenario, "relay-affinity", 1);
  assert.equal(claimed.workMessage.execution.channelId, scenario.channelIds[1]);
});

test("an account with no capacity cannot block another account", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const blocked = await seedScenario({ itemCount: 1, channelCount: 1 });
  const available = await seedScenario({ itemCount: 1, channelCount: 1 });
  await pool.query(
    "UPDATE auto_listing_ai_profile_channels SET enabled=FALSE WHERE account_id=$1",
    [blocked.accountId],
  );
  const repository = createPostgresAiOutboxRepository({ pool });
  const [blockedClaim, availableClaim] = await Promise.all([
    claim(repository, blocked, "relay-blocked", 1), claim(repository, available, "relay-available", 1),
  ]);
  assert.deepEqual(blockedClaim, []);
  assert.equal(availableClaim.length, 1);
  assert.equal(availableClaim[0].accountId, available.accountId);
});

test("concurrent workers cannot allocate one channel or item twice", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 2, channelCount: 1 });
  const first = createPostgresAiOutboxRepository({ pool });
  const second = createPostgresAiOutboxRepository({ pool });
  const results = await Promise.all([
    claim(first, scenario, "relay-concurrent-a", 1),
    claim(second, scenario, "relay-concurrent-b", 1),
  ]);
  assert.equal(results.flat().length, 1);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::INTEGER AS count FROM auto_listing_ai_profile_channels WHERE account_id=$1 AND execution_lease_expires_at>NOW()",
    [scenario.accountId],
  )).rows[0].count, 1);
});

test("concurrent workers cannot allocate one item across two available channels", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 2 });
  const results = await Promise.all([
    claim(createPostgresAiOutboxRepository({ pool }), scenario, "relay-one-item-a", 1),
    claim(createPostgresAiOutboxRepository({ pool }), scenario, "relay-one-item-b", 1),
  ]);
  assert.equal(results.flat().length, 1);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::INTEGER AS count FROM auto_listing_ai_profile_channels
      WHERE account_id=$1 AND assigned_item_id=$2`,
    [scenario.accountId, scenario.items[0].itemId],
  )).rows[0].count, 1);
  assert.deepEqual((await pool.query(
    "SELECT state,attempts,dispatch_generation FROM auto_listing_ai_outbox WHERE id=$1",
    [scenario.items[0].outboxId],
  )).rows[0], { state: "PROCESSING", attempts: 1, dispatch_generation: 1 });
});

test("old disabled frozen profiles keep using their retired exact-version channel", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 1 });
  await pool.query(
    "UPDATE ai_gateway_profiles SET enabled=FALSE WHERE account_id=$1 AND id=$2 AND config_version=1",
    [scenario.accountId, scenario.profileId],
  );
  await pool.query(
    `UPDATE ai_gateway_connection_versions
        SET status='RETIRED',status_version=4,retired_at=NOW(),retired_by=$1
      WHERE account_id=$1 AND id=$2 AND version=1`,
    [scenario.accountId, scenario.connectionIds[0]],
  );
  const nextConnectionId = `connection-next-${sequence}-${suffix}`;
  const nextProfileId = `profile-next-${sequence}-${suffix}`;
  await pool.query(
    `INSERT INTO ai_gateway_connection_versions (
       account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
       fingerprint,status,idempotency_key,request_hash,correlation_id,created_by
     ) VALUES ($1,$2,1,'Next','https://gateway.invalid','ciphertext','iv','tag','aes-256-gcm','local-v1',
       $3,'PENDING',$4,$5,$6,$1)`,
    [scenario.accountId, nextConnectionId, `fingerprint-next-${sequence}-${suffix}`,
      `connection-next-key-${sequence}-${suffix}`, hash("a"), `connection-next-correlation-${sequence}-${suffix}`],
  );
  await pool.query(
    `UPDATE ai_gateway_connection_versions
        SET status='VALIDATED',status_version=2,validation_result='{"outcome":"PASSED"}'::JSONB,
            validation_hash=$3,validated_at=NOW(),validated_by=$1
      WHERE account_id=$1 AND id=$2 AND version=1`,
    [scenario.accountId, nextConnectionId, hash("b")],
  );
  await pool.query(
    `UPDATE ai_gateway_connection_versions
        SET status='ACTIVE',status_version=3,activated_at=NOW(),activated_by=$1
      WHERE account_id=$1 AND id=$2 AND version=1`,
    [scenario.accountId, nextConnectionId],
  );
  await pool.query(
    `INSERT INTO ai_gateway_profiles (
       id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
       text_model,image_model,config_version,enabled,connection_id,connection_version
     ) VALUES ($1,$2,'Next connected','https://gateway.invalid','SUB2API_ENCRYPTED_KEY',
       'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','next-text','next-image',2,TRUE,$3,1)`,
    [nextProfileId, scenario.accountId, nextConnectionId],
  );
  const [claimed] = await claim(createPostgresAiOutboxRepository({ pool }), scenario, "relay-frozen", 1);
  assert.equal(claimed.workMessage.execution.connectionId, scenario.connectionIds[0]);
});

test("claim ordering applies retry time before deterministic source and outbox order", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 4, channelCount: 4 });
  await pool.query(
    `UPDATE auto_listing_ai_outbox
        SET next_retry_at=CASE item_id WHEN $2 THEN '2020-01-01T00:00:00Z'::TIMESTAMPTZ
                                      ELSE '2021-01-01T00:00:00Z'::TIMESTAMPTZ END,
            available_at='2019-01-01T00:00:00Z'::TIMESTAMPTZ,
            created_at='2022-01-01T00:00:00Z'::TIMESTAMPTZ
      WHERE account_id=$1`,
    [scenario.accountId, scenario.items[3].itemId],
  );
  await pool.query(
    `UPDATE auto_listing_job_items
        SET source_order=CASE id WHEN $2 THEN 1 WHEN $3 THEN 2 WHEN $4 THEN 3 ELSE 9 END
      WHERE account_id=$1`,
    [scenario.accountId, scenario.items[0].itemId, scenario.items[1].itemId, scenario.items[2].itemId],
  );
  const claimed = await claim(createPostgresAiOutboxRepository({ pool }), scenario, "relay-order", 4);
  assert.deepEqual(claimed.map((row) => row.itemId), [
    scenario.items[3].itemId,
    scenario.items[0].itemId,
    scenario.items[1].itemId,
    scenario.items[2].itemId,
  ]);
});

test("job creation time precedes item source order when retry times tie", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 2 });
  const olderJobId = `job-older-${sequence}-${suffix}`;
  const olderItemId = `item-older-${sequence}-${suffix}`;
  const olderSnapshotId = `snapshot-older-${sequence}-${suffix}`;
  await pool.query(
    "UPDATE auto_listing_jobs SET created_at='2022-01-01T00:00:00Z'::TIMESTAMPTZ WHERE account_id=$1 AND id=$2",
    [scenario.accountId, scenario.jobId],
  );
  await pool.query(
    "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
    [olderSnapshotId, scenario.accountId, `record-older-${sequence}-${suffix}`, hash("c")],
  );
  await pool.query(
    `INSERT INTO auto_listing_jobs (
       id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version,created_at
     ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,1,'2021-01-01T00:00:00Z'::TIMESTAMPTZ)`,
    [olderJobId, scenario.accountId, `job-older-key-${sequence}-${suffix}`, hash("d"),
      scenario.strategyId, scenario.profileId],
  );
  await pool.query(
    `INSERT INTO auto_listing_job_items (
       id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
     ) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',3,99)`,
    [olderItemId, olderJobId, scenario.accountId, olderSnapshotId, scenario.storeId, scenario.warehouseId],
  );
  const older = await insertOutbox({ ...scenario, jobId: olderJobId }, {
    itemId: olderItemId, phase: "PLAN_CONTENT", suffixLabel: `older-job-${sequence}`,
    nextRetryAt: new Date("2020-01-01T00:00:00Z"), createdAt: new Date("2023-01-01T00:00:00Z"),
  });
  await pool.query(
    "UPDATE auto_listing_ai_outbox SET next_retry_at='2020-01-01T00:00:00Z'::TIMESTAMPTZ WHERE id=$1",
    [scenario.items[0].outboxId],
  );
  const [claimed] = await claim(createPostgresAiOutboxRepository({ pool }), scenario, "relay-job-order", 1);
  assert.equal(claimed.id, older.outboxId);
});

test("outbox creation time wins before lexical ID when earlier ordering fields tie", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 2 });
  const earlier = await insertOutbox(scenario, {
    itemId: scenario.items[0].itemId, phase: "MATERIALIZE_SOURCE_ASSET",
    target: `created-at-source-${suffix}`, suffixLabel: `created-earlier-${sequence}`,
    nextRetryAt: new Date("2020-01-01T00:00:00Z"),
    createdAt: new Date("2021-01-01T00:00:00Z"),
  });
  await pool.query(
    `UPDATE auto_listing_ai_outbox
        SET next_retry_at='2020-01-01T00:00:00Z'::TIMESTAMPTZ,
            available_at='2020-01-01T00:00:00Z'::TIMESTAMPTZ,
            created_at='2022-01-01T00:00:00Z'::TIMESTAMPTZ
      WHERE account_id=$1 AND id=$2`,
    [scenario.accountId, scenario.items[0].outboxId],
  );
  const [claimed] = await claim(createPostgresAiOutboxRepository({ pool }), scenario, "relay-created-at", 1);
  assert.equal(claimed.id, earlier.outboxId);
  assert.equal(scenario.items[0].outboxId < earlier.outboxId, true);
});

test("marking publication is exact and keeps both execution leases live", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 1 });
  const repository = createPostgresAiOutboxRepository({ pool });
  const [row] = await claim(repository, scenario, "relay-mark", 1);
  const command = {
    accountId: row.accountId, itemId: row.itemId, id: row.id,
    workerId: row.leaseOwner, leaseToken: row.leaseToken, publicationId: row.publicationId,
  };
  await repository.markAutoListingAiWorkPublished(command);
  const state = (await pool.query(
    `SELECT o.state,o.published_at,o.lease_owner,o.lease_token,
            c.execution_lease_owner,c.execution_lease_token
       FROM auto_listing_ai_outbox o
       JOIN auto_listing_ai_profile_channels c
         ON c.account_id=o.account_id AND c.assigned_job_id=o.job_id AND c.assigned_item_id=o.item_id
      WHERE o.account_id=$1 AND o.id=$2`,
    [row.accountId, row.id],
  )).rows[0];
  assert.equal(state.state, "PROCESSING");
  assert.notEqual(state.published_at, null);
  assert.equal(state.lease_owner, "relay-mark");
  assert.equal(state.execution_lease_owner, "relay-mark");
  for (const stale of [
    { ...command, accountId: `wrong-${suffix}` },
    { ...command, itemId: `wrong-${suffix}` },
    { ...command, leaseToken: `wrong-${suffix}` },
    { ...command, publicationId: `${row.publicationId}-wrong` },
  ]) await assert.rejects(repository.markAutoListingAiWorkPublished(stale), {
    code: "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED",
  });
});

test("definite NOT_SENT release preserves fixed assignment and v3 never inherits the legacy attempt cap", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 1 });
  const repository = createPostgresAiOutboxRepository({ pool, maxAttempts: 5 });
  await pool.query(
    "UPDATE auto_listing_ai_outbox SET uncertain_result_count=1 WHERE id=$1",
    [scenario.items[0].outboxId],
  );
  let row;
  for (let generation = 1; generation <= 7; generation += 1) {
    [row] = await claim(repository, scenario, `relay-release-${generation}`, 1);
    assert.equal(row.workMessage.execution.dispatchGeneration, generation);
    const command = {
      accountId: row.accountId, itemId: row.itemId, id: row.id,
      workerId: row.leaseOwner, leaseToken: row.leaseToken, publicationId: row.publicationId,
    };
    if (generation === 1) {
      for (const stale of [
        { ...command, accountId: `wrong-${suffix}` },
        { ...command, itemId: `wrong-${suffix}` },
        { ...command, leaseToken: `wrong-${suffix}` },
        { ...command, publicationId: `${row.publicationId}-wrong` },
      ]) await assert.rejects(repository.releaseUnpublishedAutoListingAiWork(stale), {
        code: "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED",
      });
    }
    await repository.releaseUnpublishedAutoListingAiWork(command);
  }
  assert.deepEqual((await pool.query(
    `SELECT state,attempts,dispatch_generation,uncertain_result_count,publication_id,
            lease_owner,lease_token,lease_expires_at,dead_at
       FROM auto_listing_ai_outbox WHERE id=$1`,
    [row.id],
  )).rows[0], {
    state: "PENDING", attempts: 7, dispatch_generation: 7, uncertain_result_count: 1,
    publication_id: null, lease_owner: null, lease_token: null, lease_expires_at: null, dead_at: null,
  });
  const channel = (await pool.query(
    `SELECT assigned_job_id,assigned_item_id,execution_lease_owner,execution_lease_token,execution_lease_expires_at
       FROM auto_listing_ai_profile_channels WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, scenario.channelIds[0]],
  )).rows[0];
  assert.equal(channel.assigned_item_id, scenario.items[0].itemId);
  assert.equal(channel.assigned_job_id, scenario.jobId);
  assert.equal(channel.execution_lease_owner, null);
  assert.equal((await repository.listRunnableAutoListingAiAccountIds({
    afterAccountId: null, limit: 100,
  })).includes(scenario.accountId), true);
  await assert.rejects(repository.releaseUnpublishedAutoListingAiWork({
    accountId: row.accountId, itemId: row.itemId, id: row.id,
    workerId: row.leaseOwner, leaseToken: row.leaseToken, publicationId: row.publicationId,
  }), { code: "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED" });
});

test("adopt and renew replace and extend both exact leases atomically", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 1 });
  const repository = createPostgresAiOutboxRepository({ pool });
  const [row] = await claim(repository, scenario, "relay-adopt", 1);
  await repository.markAutoListingAiWorkPublished({
    accountId: row.accountId, itemId: row.itemId, id: row.id,
    workerId: row.leaseOwner, leaseToken: row.leaseToken, publicationId: row.publicationId,
  });
  const adoptCommand = {
    accountId: row.accountId, itemId: row.itemId, id: row.id,
    publicationId: row.publicationId,
    dispatchGeneration: row.workMessage.execution.dispatchGeneration,
    relayOwner: row.leaseOwner, relayToken: row.leaseToken,
    workerId: "worker-adopted", workerLeaseToken: `worker-token-${suffix}`, leaseMs: 120_000,
  };
  for (const stale of [
    { ...adoptCommand, accountId: `wrong-${suffix}` },
    { ...adoptCommand, itemId: `wrong-${suffix}` },
    { ...adoptCommand, publicationId: `${adoptCommand.publicationId}-wrong` },
    { ...adoptCommand, dispatchGeneration: adoptCommand.dispatchGeneration + 1 },
    { ...adoptCommand, relayOwner: `wrong-${suffix}` },
    { ...adoptCommand, relayToken: `wrong-${suffix}` },
  ]) {
    const before = await executionSnapshot(scenario, row);
    await assert.rejects(repository.adoptAutoListingAiWork(stale), {
      code: "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED",
    });
    assert.deepEqual(await executionSnapshot(scenario, row), before);
  }
  const adopted = await repository.adoptAutoListingAiWork(adoptCommand);
  assert.equal(adopted.workMessage.execution.leaseOwner, "worker-adopted");
  assert.equal(adopted.workMessage.execution.leaseToken, `worker-token-${suffix}`);
  const firstExpiry = Date.parse(adopted.workMessage.execution.leaseExpiresAt);
  const renewCommand = {
    accountId: row.accountId, itemId: row.itemId, id: row.id,
    publicationId: row.publicationId,
    dispatchGeneration: row.workMessage.execution.dispatchGeneration,
    workerId: "worker-adopted", leaseToken: `worker-token-${suffix}`, leaseMs: 180_000,
  };
  for (const stale of [
    { ...renewCommand, accountId: `wrong-${suffix}` },
    { ...renewCommand, itemId: `wrong-${suffix}` },
    { ...renewCommand, publicationId: `${renewCommand.publicationId}-wrong` },
    { ...renewCommand, dispatchGeneration: renewCommand.dispatchGeneration + 1 },
    { ...renewCommand, workerId: `wrong-${suffix}` },
    { ...renewCommand, leaseToken: `wrong-${suffix}` },
  ]) {
    const before = await executionSnapshot(scenario, adopted);
    await assert.rejects(repository.renewAutoListingAiWorkLease(stale), {
      code: "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED",
    });
    assert.deepEqual(await executionSnapshot(scenario, adopted), before);
  }
  const renewed = await repository.renewAutoListingAiWorkLease(renewCommand);
  assert.equal(Date.parse(renewed.workMessage.execution.leaseExpiresAt) > firstExpiry, true);
  const leases = (await pool.query(
    `SELECT o.lease_owner,o.lease_token,o.lease_expires_at,
            c.execution_lease_owner,c.execution_lease_token,c.execution_lease_expires_at
       FROM auto_listing_ai_outbox o
       JOIN auto_listing_ai_profile_channels c
         ON c.account_id=o.account_id AND c.assigned_job_id=o.job_id AND c.assigned_item_id=o.item_id
      WHERE o.account_id=$1 AND o.id=$2`,
    [row.accountId, row.id],
  )).rows[0];
  assert.equal(leases.lease_owner, leases.execution_lease_owner);
  assert.equal(leases.lease_token, leases.execution_lease_token);
  assert.equal(leases.lease_expires_at.getTime(), leases.execution_lease_expires_at.getTime());
});

test("a channel-side fencing mismatch prevents one-sided renewal", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 1 });
  const repository = createPostgresAiOutboxRepository({ pool });
  const [row] = await claim(repository, scenario, "relay-fence", 1);
  const before = (await pool.query(
    "SELECT lease_expires_at FROM auto_listing_ai_outbox WHERE id=$1",
    [row.id],
  )).rows[0].lease_expires_at;
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels SET execution_lease_token=$3
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, scenario.channelIds[0], `other-token-${suffix}`],
  );
  await assert.rejects(repository.renewAutoListingAiWorkLease({
    accountId: row.accountId, itemId: row.itemId, id: row.id,
    publicationId: row.publicationId,
    dispatchGeneration: row.workMessage.execution.dispatchGeneration,
    workerId: row.leaseOwner, leaseToken: row.leaseToken, leaseMs: 180_000,
  }), { code: "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED" });
  const after = (await pool.query(
    "SELECT lease_expires_at FROM auto_listing_ai_outbox WHERE id=$1",
    [row.id],
  )).rows[0].lease_expires_at;
  assert.equal(after.getTime(), before.getTime());
});

test("legacy lifecycle methods reject v3 work without mutating either lease or business state", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const cases = [
    ["renew", (repository, row) => repository.renewAutoListingAiMessageLease({
      accountId: row.accountId, itemId: row.itemId, id: row.id,
      workerId: row.leaseOwner, leaseToken: row.leaseToken, leaseMs: 180_000,
    })],
    ["complete", (repository, row) => repository.completeAutoListingAiMessage({
      accountId: row.accountId, itemId: row.itemId, id: row.id,
      workerId: row.leaseOwner, leaseToken: row.leaseToken,
    })],
    ["fail", (repository, row) => repository.failAutoListingAiMessage({
      accountId: row.accountId, itemId: row.itemId, id: row.id,
      workerId: row.leaseOwner, leaseToken: row.leaseToken,
      errorCode: "AUTO_LISTING_AI_PUBLISH_RETRYABLE",
    })],
    ["dead-letter", (repository, row) => repository.deadLetterAutoListingAiMessage({
      accountId: row.accountId, itemId: row.itemId, id: row.id,
      workerId: row.leaseOwner, leaseToken: row.leaseToken,
      errorCode: "AUTO_LISTING_AI_PUBLISH_FAILED",
    })],
  ];
  for (const [name, execute] of cases) {
    const scenario = await seedScenario({ itemCount: 1, channelCount: 1 });
    const repository = createPostgresAiOutboxRepository({ pool });
    const [row] = await claim(repository, scenario, `relay-legacy-${name}`, 1);
    const before = await executionSnapshot(scenario, row);
    await assert.rejects(execute(repository, row), {
      code: "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED",
    });
    assert.deepEqual(await executionSnapshot(scenario, row), before);
  }
});

test("legacy lifecycle methods also reject null-dispatch work from a connected frozen profile", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const scenario = await seedScenario({ itemCount: 1, channelCount: 1 });
  const repository = createPostgresAiOutboxRepository({ pool });
  const [row] = await claim(repository, scenario, "relay-connected-null-dispatch", 1);
  await pool.query(
    `UPDATE auto_listing_ai_outbox
        SET dispatch_contract_version=NULL,dispatch_generation=0,dispatch_queued_at=NULL,publication_id=NULL
      WHERE account_id=$1 AND id=$2`,
    [row.accountId, row.id],
  );
  const before = await executionSnapshot(scenario, row);
  await assert.rejects(repository.renewAutoListingAiMessageLease({
    accountId: row.accountId, itemId: row.itemId, id: row.id,
    workerId: row.leaseOwner, leaseToken: row.leaseToken, leaseMs: 180_000,
  }), { code: "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED" });
  assert.deepEqual(await executionSnapshot(scenario, row), before);
});

test("legacy reconciliation never projects v3 DEAD or interrupted rows", {
  skip: enabled ? false : "requires PostgreSQL",
}, async () => {
  const deadScenario = await seedScenario({ itemCount: 1, channelCount: 1 });
  const repository = createPostgresAiOutboxRepository({ pool });
  const [deadRow] = await claim(repository, deadScenario, "relay-v3-dead", 1);
  await pool.query(
    `UPDATE auto_listing_ai_outbox
        SET state='DEAD',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
            publication_id=NULL,published_at=NULL,next_retry_at=NULL,dead_at=NOW(),
            last_error_code='AUTO_LISTING_AI_PUBLISH_FAILED'
      WHERE account_id=$1 AND id=$2`,
    [deadRow.accountId, deadRow.id],
  );
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET execution_lease_owner=NULL,execution_lease_token=NULL,execution_lease_expires_at=NULL
      WHERE account_id=$1 AND channel_id=$2`,
    [deadScenario.accountId, deadScenario.channelIds[0]],
  );
  const deadBefore = await executionSnapshot(deadScenario, deadRow);
  assert.deepEqual(await repository.reconcileDeadAutoListingAiMessages({
    accountId: deadScenario.accountId, limit: 10,
  }), { recovered: 0 });
  assert.deepEqual(await repository.reconcileDeadLegacyAutoListingAiMessages({
    accountId: deadScenario.accountId, limit: 10,
  }), { recovered: 0 });
  assert.deepEqual(await executionSnapshot(deadScenario, deadRow), deadBefore);

  const interruptedScenario = await seedScenario({ itemCount: 1, channelCount: 1 });
  const [interruptedRow] = await claim(repository, interruptedScenario, "relay-v3-interrupted", 1);
  await repository.markAutoListingAiWorkPublished({
    accountId: interruptedRow.accountId, itemId: interruptedRow.itemId, id: interruptedRow.id,
    workerId: interruptedRow.leaseOwner, leaseToken: interruptedRow.leaseToken,
    publicationId: interruptedRow.publicationId,
  });
  await pool.query(
    `UPDATE auto_listing_ai_outbox
        SET state='COMPLETED',published_at=NOW()-INTERVAL '4 hours',next_retry_at=NULL,
            lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
      WHERE account_id=$1 AND id=$2`,
    [interruptedRow.accountId, interruptedRow.id],
  );
  await pool.query(
    "UPDATE auto_listing_job_items SET updated_at=NOW()-INTERVAL '4 hours' WHERE account_id=$1 AND id=$2",
    [interruptedScenario.accountId, interruptedScenario.items[0].itemId],
  );
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET execution_lease_owner=NULL,execution_lease_token=NULL,execution_lease_expires_at=NULL
      WHERE account_id=$1 AND channel_id=$2`,
    [interruptedScenario.accountId, interruptedScenario.channelIds[0]],
  );
  const interruptedBefore = await executionSnapshot(interruptedScenario, interruptedRow);
  assert.deepEqual(await repository.reconcileInterruptedAutoListingAiItems({
    accountId: interruptedScenario.accountId, limit: 10,
  }), { recovered: 0 });
  assert.deepEqual(await executionSnapshot(interruptedScenario, interruptedRow), interruptedBefore);
});
