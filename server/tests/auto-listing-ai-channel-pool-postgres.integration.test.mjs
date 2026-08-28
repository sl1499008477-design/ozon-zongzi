import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";

import { autoListingAiMessageDedupeKey } from "../auto-listing-ai-message.mjs";
import { createPostgresAiOutboxRepository } from "../auto-listing-ai-outbox-postgres.mjs";
import { createPostgresAutoListingAiWorkflow } from "../auto-listing-ai-workflow-postgres.mjs";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
import {
  createPostgresAutoListingUploadTaskRepository,
  enqueueAutoListingUploadTask,
} from "../auto-listing-upload-task-postgres.mjs";
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
let runSuffix;
let sequence = 0;

before(async () => {
  if (!enabled) return;
  const { Pool } = await import("pg");
  runSuffix = crypto.randomUUID().replaceAll("-", "");
  schema = `ai_channel_pool_acceptance_${runSuffix}`;
  adminPool = new Pool({ connectionString, max: 2 });
  admin = await adminPool.connect();
  await admin.query(`CREATE SCHEMA ${quote(schema)}`);
  await admin.query(`SET search_path TO ${quote(schema)}, public`);
  await applyAutoListingAiChannelPoolBaseMigrations(admin);
  await applyAutoListingAiChannelPoolMigration(admin);
  pool = new Pool({ connectionString, max: 16, options: `-c search_path=${schema},public` });
});

after(async () => {
  if (!enabled) return;
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
  } finally {
    admin.release();
    await pool.end();
    await adminPool.end();
  }
});

async function seedConnectedScenario({ itemCount, channelCount, label }) {
  sequence += 1;
  const marker = `${label}-${sequence}-${runSuffix}`;
  const ids = Object.fromEntries(["account", "store", "warehouse", "strategy", "profile", "job"]
    .map((key) => [key, `${key}-${marker}`]));
  await pool.query(
    "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
    [ids.account, `user-${marker}`],
  );
  await pool.query(
    "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$1,$1,$2,'active',$3)",
    [ids.store, `client-${marker}`, ids.account],
  );
  await pool.query(
    "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$1,'FBS','active',TRUE,FALSE)",
    [ids.warehouse, ids.store],
  );
  await pool.query(
    "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,$3,1,'PUBLISHED','{}'::JSONB,$4)",
    [ids.strategy, ids.account, `strategy-${marker}`, hash("a")],
  );

  const connections = [];
  const channels = [];
  for (let index = 0; index < channelCount; index += 1) {
    const connectionId = `connection-${index + 1}-${marker}`;
    const channelId = `channel-${index + 1}-${marker}`;
    connections.push(connectionId);
    channels.push(channelId);
    await pool.query(
      `INSERT INTO ai_gateway_connection_versions (
         account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
         fingerprint,status,idempotency_key,request_hash,correlation_id,created_by
       ) VALUES ($1,$2,1,$3,'https://gateway.invalid','ciphertext','iv','tag','aes-256-gcm','fixture-v1',
         $4,'PENDING',$5,$6,$7,$1)`,
      [ids.account, connectionId, `测试通道 ${index + 1}`, `fingerprint-${index}-${marker}`,
        `connection-key-${index}-${marker}`, hash(String.fromCharCode(98 + index)),
        `connection-correlation-${index}-${marker}`],
    );
    await pool.query(
      `UPDATE ai_gateway_connection_versions
          SET status='VALIDATED',status_version=2,validation_result='{"outcome":"PASSED"}'::JSONB,
              validation_hash=$3,validated_at=NOW(),validated_by=$1
        WHERE account_id=$1 AND id=$2 AND version=1`,
      [ids.account, connectionId, hash("d")],
    );
    if (index === 0) {
      await pool.query(
        `UPDATE ai_gateway_connection_versions
            SET status='ACTIVE',status_version=3,activated_at=NOW(),activated_by=$1
          WHERE account_id=$1 AND id=$2 AND version=1`,
        [ids.account, connectionId],
      );
    }
  }
  await pool.query(
    `INSERT INTO ai_gateway_profiles (
       id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
       text_model,image_model,config_version,enabled,connection_id,connection_version
     ) VALUES ($1,$2,'Connected','https://gateway.invalid','SUB2API_ENCRYPTED_KEY',
       'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1,TRUE,$3,1)`,
    [ids.profile, ids.account, connections[0]],
  );
  for (const [index, connectionId] of connections.entries()) {
    await pool.query(
      `INSERT INTO auto_listing_ai_profile_channels (
         account_id,profile_id,profile_version,channel_id,display_name,connection_id,connection_version,channel_order
       ) VALUES ($1,$2,1,$3,$4,$5,1,$6)`,
      [ids.account, ids.profile, channels[index], `测试通道 ${index + 1}`, connectionId, index + 1],
    );
  }
  await pool.query(
    `INSERT INTO auto_listing_jobs (
       id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version,
       created_by,correlation_id
     ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,1,$2,$7)`,
    [ids.job, ids.account, `job-key-${marker}`, hash("e"), ids.strategy, ids.profile, `job-correlation-${marker}`],
  );

  const items = [];
  for (let index = 0; index < itemCount; index += 1) {
    const sourceOrder = index + 1;
    const itemId = `item-${sourceOrder}-${marker}`;
    const snapshotId = `snapshot-${sourceOrder}-${marker}`;
    const outboxId = `outbox-${sourceOrder}-${marker}`;
    const correlationId = `correlation-${sourceOrder}-${marker}`;
    const currentMessage = Object.freeze({
      contractVersion: "V1",
      accountId: ids.account,
      itemId,
      phase: "PLAN_CONTENT",
      expectedStatusVersion: 3,
      correlationId,
    });
    await pool.query(
      "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
      [snapshotId, ids.account, `record-${sourceOrder}-${marker}`, hash("f")],
    );
    await pool.query(
      `INSERT INTO auto_listing_job_items (
         id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
       ) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',3,$7)`,
      [itemId, ids.job, ids.account, snapshotId, ids.store, ids.warehouse, sourceOrder],
    );
    await pool.query(
      `INSERT INTO auto_listing_ai_outbox (
         id,account_id,job_id,item_id,event_type,dedupe_key,state,contract_version,phase,
         expected_status_version,correlation_id,payload,next_retry_at
       ) VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,'PENDING','V1','PLAN_CONTENT',3,$6,$7::JSONB,NOW())`,
      [outboxId, ids.account, ids.job, itemId, autoListingAiMessageDedupeKey(currentMessage),
        correlationId, JSON.stringify(currentMessage)],
    );
    items.push(Object.freeze({ itemId, snapshotId, outboxId, message: currentMessage, sourceOrder }));
  }
  return Object.freeze({ ...ids, marker, items: Object.freeze(items), connections, channels });
}

function outboxRepository(tokenPrefix) {
  let tokenSequence = 0;
  return createPostgresAiOutboxRepository({
    pool,
    token: () => `${tokenPrefix}-${tokenSequence += 1}-${runSuffix}`,
  });
}

async function claim(repository, scenario, workerId, limit = 10) {
  return repository.claimAutoListingAiWork({
    accountId: scenario.account,
    workerId,
    limit,
    leaseMs: 60_000,
  });
}

async function markPublishedAndAdopt(repository, row, workerId) {
  await repository.markAutoListingAiWorkPublished({
    accountId: row.accountId,
    itemId: row.itemId,
    id: row.id,
    workerId: row.leaseOwner,
    leaseToken: row.leaseToken,
    publicationId: row.publicationId,
  });
  return repository.adoptAutoListingAiWork({
    accountId: row.accountId,
    itemId: row.itemId,
    id: row.id,
    publicationId: row.publicationId,
    dispatchGeneration: row.workMessage.execution.dispatchGeneration,
    relayOwner: row.leaseOwner,
    relayToken: row.leaseToken,
    workerId,
    workerLeaseToken: `${workerId}-token`,
    leaseMs: 60_000,
  });
}

async function completeAiAndRelease(scenario, row, nextStatus = "UPLOAD_QUEUED") {
  await pool.query(
    `UPDATE auto_listing_job_items
        SET status=$3,updated_at=NOW()
      WHERE account_id=$1 AND id=$2`,
    [scenario.account, row.itemId, nextStatus],
  );
  await pool.query(
    `UPDATE auto_listing_ai_outbox
        SET state='COMPLETED',published_at=COALESCE(published_at,NOW()),next_retry_at=NULL,
            lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
      WHERE account_id=$1 AND id=$2`,
    [scenario.account, row.id],
  );
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET assigned_job_id=NULL,assigned_item_id=NULL,assigned_status_version=NULL,assigned_at=NULL,
            execution_lease_owner=NULL,execution_lease_token=NULL,execution_lease_expires_at=NULL,updated_at=NOW()
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.account, row.workMessage.execution.channelId],
  );
}

test("case 1: one channel shows the second item waiting and resumes it before predecessor upload completes", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedConnectedScenario({ itemCount: 2, channelCount: 1, label: "single" });
  const repository = outboxRepository("single-lease");
  const [first] = await claim(repository, scenario, "relay-single", 2);
  assert.equal(first.itemId, scenario.items[0].itemId);

  const waitingRow = (await createAutoListingRepository({ pool }).getJob({
    accountId: scenario.account,
    jobId: scenario.job,
  })).items.find((item) => item.id === scenario.items[1].itemId);
  assert.deepEqual({ state: waitingRow.aiQueueState, switching: waitingRow.aiChannelSwitching }, {
    state: "WAITING_FOR_AI_CHANNEL",
    switching: false,
  });
  assert.deepEqual((await pool.query(
    "SELECT state,attempts,dispatch_generation FROM auto_listing_ai_outbox WHERE account_id=$1 AND id=$2",
    [scenario.account, scenario.items[1].outboxId],
  )).rows[0], { state: "PENDING", attempts: 0, dispatch_generation: 0 });

  await completeAiAndRelease(scenario, first);
  await enqueueAutoListingUploadTask({
    client: pool,
    accountId: scenario.account,
    jobId: scenario.job,
    itemId: first.itemId,
    actorAccountId: scenario.account,
    expectedStatusVersion: 3,
    correlationId: `upload-${scenario.marker}`,
    enqueueReason: "DIRECT_READY",
  });
  const [second] = await claim(repository, scenario, "relay-single-next", 1);
  assert.equal(second.itemId, scenario.items[1].itemId);
  assert.equal((await pool.query(
    "SELECT state FROM auto_listing_upload_tasks WHERE account_id=$1 AND item_id=$2",
    [scenario.account, first.itemId],
  )).rows[0].state, "PENDING");
});

test("cases 2/5: two channels cap concurrency at two; the third waits with attempts zero and resumes after release", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedConnectedScenario({ itemCount: 3, channelCount: 2, label: "dual" });
  const repository = outboxRepository("dual-lease");
  const firstTwo = await claim(repository, scenario, "relay-dual", 3);
  assert.equal(firstTwo.length, 2);
  assert.equal(new Set(firstTwo.map((row) => row.workMessage.execution.channelId)).size, 2);
  assert.deepEqual(firstTwo.map((row) => row.itemId), scenario.items.slice(0, 2).map((item) => item.itemId));
  assert.deepEqual(await claim(repository, scenario, "relay-dual-blocked", 1), []);
  assert.deepEqual((await pool.query(
    "SELECT state,attempts,dispatch_generation FROM auto_listing_ai_outbox WHERE account_id=$1 AND id=$2",
    [scenario.account, scenario.items[2].outboxId],
  )).rows[0], { state: "PENDING", attempts: 0, dispatch_generation: 0 });

  await completeAiAndRelease(scenario, firstTwo[0], "READY_FOR_REVIEW");
  const [third] = await claim(repository, scenario, "relay-dual-resumed", 1);
  assert.equal(third.itemId, scenario.items[2].itemId);
  assert.equal(third.workMessage.execution.channelId, firstTwo[0].workMessage.execution.channelId);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::INTEGER AS count
       FROM auto_listing_ai_profile_channels
      WHERE account_id=$1 AND execution_lease_expires_at>NOW()`,
    [scenario.account],
  )).rows[0].count, 2);
});

test("case 6: POSSIBLY_SENT requeues once, then becomes AUTO_LISTING_AI_RESULT_UNCERTAIN", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedConnectedScenario({ itemCount: 1, channelCount: 2, label: "uncertain" });
  const repository = outboxRepository("uncertain-lease");
  const workflow = createPostgresAutoListingAiWorkflow({ pool });
  const outcome = (currentMessage) => ({
    contractVersion: "V1",
    disposition: "RETRY",
    phase: currentMessage.phase,
    outcome: "FAILED",
    retryable: true,
    failureCode: "INVALID_GATEWAY_RESPONSE",
    correlationId: currentMessage.correlationId,
    failureScope: "CHANNEL_TRANSIENT",
    deliveryState: "POSSIBLY_SENT",
    retryAfterMs: null,
  });

  const [firstClaim] = await claim(repository, scenario, "relay-uncertain-one", 1);
  const firstAdopted = await markPublishedAndAdopt(repository, firstClaim, "worker-uncertain-one");
  assert.deepEqual(await workflow.requeueChannelFailure({
    message: scenario.items[0].message,
    outcome: outcome(scenario.items[0].message),
    execution: firstAdopted.workMessage.execution,
  }), {
    disposition: "REQUEUED",
    status: "PLANNING",
    statusVersion: 3,
    enqueued: 0,
    uncertainResultCount: 1,
  });

  const [secondClaim] = await claim(repository, scenario, "relay-uncertain-two", 1);
  assert.notEqual(secondClaim.workMessage.execution.channelId, firstClaim.workMessage.execution.channelId);
  const secondAdopted = await markPublishedAndAdopt(repository, secondClaim, "worker-uncertain-two");
  assert.deepEqual(await workflow.requeueChannelFailure({
    message: scenario.items[0].message,
    outcome: outcome(scenario.items[0].message),
    execution: secondAdopted.workMessage.execution,
  }), {
    disposition: "APPLIED",
    status: "RETRYABLE_ERROR",
    statusVersion: 4,
    enqueued: 0,
  });
  assert.deepEqual((await pool.query(
    `SELECT item.status,item.failure_code,outbox.state,outbox.uncertain_result_count
       FROM auto_listing_job_items AS item
       JOIN auto_listing_ai_outbox AS outbox
         ON outbox.account_id=item.account_id AND outbox.item_id=item.id
      WHERE item.account_id=$1 AND item.id=$2`,
    [scenario.account, scenario.items[0].itemId],
  )).rows[0], {
    status: "RETRYABLE_ERROR",
    failure_code: "AUTO_LISTING_AI_RESULT_UNCERTAIN",
    state: "COMPLETED",
    uncertain_result_count: 2,
  });
});

test("case 8: an expired execution lease is taken over for the same fixed item without two effective owners", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedConnectedScenario({ itemCount: 2, channelCount: 1, label: "takeover" });
  const firstRepository = outboxRepository("takeover-one");
  const [first] = await claim(firstRepository, scenario, "relay-crashed", 1);
  await pool.query(
    "UPDATE auto_listing_ai_outbox SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND id=$2",
    [scenario.account, first.id],
  );
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET execution_lease_expires_at=NOW()-INTERVAL '1 second'
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.account, first.workMessage.execution.channelId],
  );

  const secondRepository = outboxRepository("takeover-two");
  const [takenOver] = await claim(secondRepository, scenario, "relay-replacement", 1);
  assert.equal(takenOver.itemId, first.itemId);
  assert.equal(takenOver.workMessage.execution.channelId, first.workMessage.execution.channelId);
  assert.equal(takenOver.workMessage.execution.dispatchGeneration, 2);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::INTEGER AS count
       FROM auto_listing_ai_profile_channels
      WHERE account_id=$1 AND assigned_item_id=$2 AND execution_lease_owner=$3`,
    [scenario.account, first.itemId, "relay-replacement"],
  )).rows[0].count, 1);
  assert.deepEqual((await pool.query(
    "SELECT state,attempts,dispatch_generation FROM auto_listing_ai_outbox WHERE account_id=$1 AND id=$2",
    [scenario.account, scenario.items[1].outboxId],
  )).rows[0], { state: "PENDING", attempts: 0, dispatch_generation: 0 });
});

test("case 9: later AI completion is allowed but its Ozon upload cannot overtake source_order", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedConnectedScenario({ itemCount: 2, channelCount: 2, label: "upload-order" });
  await pool.query(
    `UPDATE auto_listing_job_items
        SET status=CASE source_order WHEN 1 THEN 'UPLOADING' ELSE 'UPLOAD_QUEUED' END
      WHERE account_id=$1 AND job_id=$2`,
    [scenario.account, scenario.job],
  );
  await enqueueAutoListingUploadTask({
    client: pool,
    accountId: scenario.account,
    jobId: scenario.job,
    itemId: scenario.items[1].itemId,
    actorAccountId: scenario.account,
    expectedStatusVersion: 3,
    correlationId: `later-upload-${scenario.marker}`,
    enqueueReason: "DIRECT_READY",
  });
  const uploads = createPostgresAutoListingUploadTaskRepository({ pool });
  assert.equal(await uploads.leaseNext({
    accountId: scenario.account,
    workerId: "upload-worker",
    leaseMs: 30_000,
  }), null);
  await pool.query(
    "UPDATE auto_listing_job_items SET status='SUCCEEDED' WHERE account_id=$1 AND id=$2",
    [scenario.account, scenario.items[0].itemId],
  );
  assert.equal((await uploads.leaseNext({
    accountId: scenario.account,
    workerId: "upload-worker",
    leaseMs: 30_000,
  }))?.itemId, scenario.items[1].itemId);
});

async function seedLegacyScenario(label) {
  sequence += 1;
  const marker = `${label}-${sequence}-${runSuffix}`;
  const scenario = await seedConnectedScenario({ itemCount: 0, channelCount: 1, label: `${label}-base` });
  await pool.query("UPDATE ai_gateway_profiles SET enabled=FALSE WHERE account_id=$1", [scenario.account]);
  const profileId = `legacy-profile-${marker}`;
  const jobId = `legacy-job-${marker}`;
  const itemId = `legacy-item-${marker}`;
  const snapshotId = `legacy-snapshot-${marker}`;
  const outboxId = `legacy-outbox-${marker}`;
  const correlationId = `legacy-correlation-${marker}`;
  await pool.query(
    `INSERT INTO ai_gateway_profiles (
       id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
       text_model,image_model,config_version,enabled,connection_id,connection_version
     ) VALUES ($1,$2,'Legacy','https://gateway.invalid','LEGACY_GATEWAY_KEY',
       'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1,TRUE,NULL,NULL)`,
    [profileId, scenario.account],
  );
  await pool.query(
    `INSERT INTO auto_listing_source_snapshots
       (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash)
     VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)`,
    [snapshotId, scenario.account, `legacy-record-${marker}`, hash("1")],
  );
  await pool.query(
    `INSERT INTO auto_listing_jobs
       (id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version)
     VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,1)`,
    [jobId, scenario.account, `legacy-job-key-${marker}`, hash("2"), scenario.strategy, profileId],
  );
  await pool.query(
    `INSERT INTO auto_listing_job_items
       (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order)
     VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',3,1)`,
    [itemId, jobId, scenario.account, snapshotId, scenario.store, scenario.warehouse],
  );
  const legacyMessage = {
    contractVersion: "V1",
    accountId: scenario.account,
    itemId,
    phase: "PLAN_CONTENT",
    expectedStatusVersion: 3,
    correlationId,
  };
  await pool.query(
    `INSERT INTO auto_listing_ai_outbox
       (id,account_id,job_id,item_id,event_type,dedupe_key,state,contract_version,phase,
        expected_status_version,correlation_id,payload,next_retry_at)
     VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,'PENDING','V1','PLAN_CONTENT',3,$6,$7::JSONB,NOW())`,
    [outboxId, scenario.account, jobId, itemId, autoListingAiMessageDedupeKey(legacyMessage),
      correlationId, JSON.stringify(legacyMessage)],
  );
  return { ...scenario, profileId, jobId, itemId, outboxId };
}

test("case 10: PostgreSQL isolates connected v3 claims from the bounded environment-profile v2 drain", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const connected = await seedConnectedScenario({ itemCount: 1, channelCount: 1, label: "routing-connected" });
  const legacy = await seedLegacyScenario("routing-legacy");
  const repository = outboxRepository("routing-lease");
  assert.deepEqual(await repository.claimLegacyAutoListingAiMessages({
    accountId: connected.account,
    workerId: "legacy-relay",
    limit: 1,
    leaseMs: 30_000,
  }), []);
  assert.equal((await claim(repository, connected, "v3-relay", 1))[0]?.itemId, connected.items[0].itemId);
  const [legacyClaim] = await repository.claimLegacyAutoListingAiMessages({
    accountId: legacy.account,
    workerId: "legacy-relay",
    limit: 1,
    leaseMs: 30_000,
  });
  assert.equal(legacyClaim?.itemId, legacy.itemId);
  assert.deepEqual(await claim(repository, legacy, "v3-relay-legacy", 1), []);
});
