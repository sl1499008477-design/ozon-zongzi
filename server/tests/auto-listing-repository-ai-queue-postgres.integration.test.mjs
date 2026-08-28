import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";

import { autoListingAiMessageDedupeKey } from "../auto-listing-ai-message.mjs";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
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

before(async () => {
  if (!enabled) return;
  const { Pool } = await import("pg");
  suffix = crypto.randomUUID().replaceAll("-", "");
  schema = `auto_listing_queue_projection_${suffix}`;
  adminPool = new Pool({ connectionString, max: 2 });
  admin = await adminPool.connect();
  await admin.query(`CREATE SCHEMA ${quote(schema)}`);
  await admin.query(`SET search_path TO ${quote(schema)}, public`);
  await applyAutoListingAiChannelPoolBaseMigrations(admin);
  await applyAutoListingAiChannelPoolMigration(admin);
  pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });
});

after(async () => {
  if (!enabled) return;
  try { await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); } finally {
    admin.release();
    await pool.end();
    await adminPool.end();
  }
});

async function seedScenario(label, {
  status = "PLANNING",
  phase = "PLAN_CONTENT",
  outboxState = "PENDING",
  nextRetryAt = "2020-01-01T00:00:00.000Z",
  leaseExpiresAt = null,
  lastErrorCode = null,
  channelMode = "free",
  channelDisplayName = `Channel ${label}`,
  addNewerPendingSibling = false,
  phaseTargetId = null,
} = {}) {
  const marker = `${label}-${suffix}`;
  const accountId = `account-${marker}`;
  const storeId = `store-${marker}`;
  const warehouseId = `warehouse-${marker}`;
  const strategyId = `strategy-${marker}`;
  const profileId = `profile-${marker}`;
  const connectionId = `connection-${marker}`;
  const channelId = `channel-${marker}`;
  const jobId = `job-${marker}`;
  const itemId = `item-${marker}`;
  const snapshotId = `snapshot-${marker}`;
  const expectedStatusVersion = 3;

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
  await pool.query(
    `INSERT INTO ai_gateway_connection_versions (
       account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
       fingerprint,status,idempotency_key,request_hash,correlation_id,created_by
     ) VALUES ($1,$2,1,$3,'https://gateway.invalid','ciphertext','iv','tag','aes-256-gcm','local-v1',
       $4,'PENDING',$5,$6,$7,$1)`,
    [accountId, connectionId, `Display ${label}`, `fingerprint-${marker}`,
      `connection-key-${marker}`, hash("b"), `connection-correlation-${marker}`],
  );
  await pool.query(
    `UPDATE ai_gateway_connection_versions
        SET status='VALIDATED',status_version=2,validation_result='{"outcome":"PASSED"}'::JSONB,
            validation_hash=$3,validated_at=NOW(),validated_by=$1
      WHERE account_id=$1 AND id=$2 AND version=1`,
    [accountId, connectionId, hash("c")],
  );
  await pool.query(
    `UPDATE ai_gateway_connection_versions
        SET status='ACTIVE',status_version=3,activated_at=NOW(),activated_by=$1
      WHERE account_id=$1 AND id=$2 AND version=1`,
    [accountId, connectionId],
  );
  await pool.query(
    `INSERT INTO ai_gateway_profiles (
       id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
       text_model,image_model,config_version,enabled,connection_id,connection_version
     ) VALUES ($1,$2,$3,'https://gateway.invalid','SUB2API_ENCRYPTED_KEY',
       'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1,TRUE,$4,1)`,
    [profileId, accountId, `Profile ${label}`, connectionId],
  );
  await pool.query(
    "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
    [snapshotId, accountId, `record-${marker}`, hash("d")],
  );
  await pool.query(
    `INSERT INTO auto_listing_jobs (
       id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version
     ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,1)`,
    [jobId, accountId, `job-key-${marker}`, hash("e"), strategyId, profileId],
  );
  await pool.query(
    `INSERT INTO auto_listing_job_items (
       id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)`,
    [itemId, jobId, accountId, snapshotId, storeId, warehouseId, status, expectedStatusVersion],
  );

  let staleJobId = null;
  let staleItemId = null;
  if (channelMode === "stale-reclaimable") {
    staleJobId = `stale-job-${marker}`;
    staleItemId = `stale-item-${marker}`;
    const staleSnapshotId = `stale-snapshot-${marker}`;
    await pool.query(
      "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
      [staleSnapshotId, accountId, `stale-record-${marker}`, hash("f")],
    );
    await pool.query(
      `INSERT INTO auto_listing_jobs (
         id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version
       ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,1)`,
      [staleJobId, accountId, `stale-job-key-${marker}`, hash("1"), strategyId, profileId],
    );
    await pool.query(
      `INSERT INTO auto_listing_job_items (
         id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
       ) VALUES ($1,$2,$3,$4,$5,$6,'READY_FOR_REVIEW',2,1)`,
      [staleItemId, staleJobId, accountId, staleSnapshotId, storeId, warehouseId],
    );
  }

  const fixed = ["fixed", "calling", "expired-processing"].includes(channelMode);
  const hasExecutionLease = ["calling", "expired-processing"].includes(channelMode);
  const channelLeaseExpiry = channelMode === "calling"
    ? "2099-01-01T00:00:00.000Z" : channelMode === "expired-processing"
      ? "2020-01-01T00:00:00.000Z" : null;
  await pool.query(
    `INSERT INTO auto_listing_ai_profile_channels (
       account_id,profile_id,profile_version,channel_id,display_name,connection_id,connection_version,
       channel_order,enabled,assigned_job_id,assigned_item_id,assigned_status_version,assigned_at,
       execution_lease_owner,execution_lease_token,execution_lease_expires_at
     ) VALUES ($1,$2,1,$3,$4,$5,1,1,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [accountId, profileId, channelId, channelDisplayName, connectionId,
      channelMode !== "unavailable",
      fixed ? jobId : staleJobId,
      fixed ? itemId : staleItemId,
      fixed ? expectedStatusVersion : staleItemId ? 2 : null,
      fixed || staleItemId ? new Date("2026-08-28T00:00:00.000Z") : null,
      hasExecutionLease ? "worker-exact" : null,
      hasExecutionLease ? "token-exact" : null,
      channelLeaseExpiry],
  );

  if (lastErrorCode) {
    await pool.query(
      `UPDATE auto_listing_job_items
          SET last_ai_connection_id=$3,last_ai_connection_version=1,last_ai_channel_assigned_at=NOW()
        WHERE account_id=$1 AND id=$2`,
      [accountId, itemId, connectionId],
    );
  }

  const outboxId = `outbox-${marker}`;
  const correlationId = `correlation-${marker}`;
  const message = {
    contractVersion: "V1", accountId, itemId, phase,
    expectedStatusVersion, correlationId,
    ...(phase === "GENERATE_IMAGE_SLOT" ? { slotKey: phaseTargetId } : {}),
    ...(phase === "MATERIALIZE_SOURCE_ASSET" ? { sourceAssetId: phaseTargetId } : {}),
  };
  await pool.query(
    `INSERT INTO auto_listing_ai_outbox (
       id,account_id,job_id,item_id,event_type,dedupe_key,state,contract_version,phase,phase_target_id,
       expected_status_version,correlation_id,payload,next_retry_at,last_error_code,
       lease_owner,lease_token,lease_expires_at,created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'V1',$5,$8,$9,$10,$11::JSONB,$12,$13,$14,$15,$16,
       '2026-08-28T00:00:00.000Z'::TIMESTAMPTZ)`,
    [outboxId, accountId, jobId, itemId, phase, autoListingAiMessageDedupeKey(message), outboxState,
      phaseTargetId, expectedStatusVersion, correlationId, JSON.stringify(message), nextRetryAt, lastErrorCode,
      outboxState === "PROCESSING" ? "worker-exact" : null,
      outboxState === "PROCESSING" ? "token-exact" : null,
      leaseExpiresAt],
  );

  if (addNewerPendingSibling) {
    const siblingPhase = "MATERIALIZE_SOURCE_ASSET";
    const siblingCorrelationId = `sibling-correlation-${marker}`;
    const sourceAssetId = `source-${marker}`;
    const siblingMessage = {
      contractVersion: "V1", accountId, itemId, phase: siblingPhase,
      sourceAssetId, expectedStatusVersion, correlationId: siblingCorrelationId,
    };
    await pool.query(
      `INSERT INTO auto_listing_ai_outbox (
         id,account_id,job_id,item_id,event_type,dedupe_key,state,contract_version,phase,phase_target_id,
         expected_status_version,correlation_id,payload,next_retry_at,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'PENDING','V1',$5,$7,$8,$9,$10::JSONB,NOW(),
         '2026-08-28T00:01:00.000Z'::TIMESTAMPTZ)`,
      [`sibling-${outboxId}`, accountId, jobId, itemId, siblingPhase,
        autoListingAiMessageDedupeKey(siblingMessage), sourceAssetId, expectedStatusVersion,
        siblingCorrelationId, JSON.stringify(siblingMessage)],
    );
  }

  return {
    accountId, storeId, warehouseId, strategyId, profileId, connectionId,
    jobId, itemId, channelId, outboxId, expectedStatusVersion,
  };
}

async function addReplacementCapacity(scenario, label) {
  const marker = `${label}-${suffix}`;
  const connectionId = `connection-${marker}`;
  const channelId = `channel-${marker}`;
  await pool.query(
    `INSERT INTO ai_gateway_connection_versions (
       account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
       fingerprint,status,idempotency_key,request_hash,correlation_id,created_by
     ) VALUES ($1,$2,1,$3,'https://gateway.invalid','ciphertext','iv','tag','aes-256-gcm','local-v1',
       $4,'PENDING',$5,$6,$7,$1)`,
    [scenario.accountId, connectionId, `Replacement ${label}`, `fingerprint-${marker}`,
      `connection-key-${marker}`, hash("6"), `connection-correlation-${marker}`],
  );
  await pool.query(
    `UPDATE ai_gateway_connection_versions
        SET status='VALIDATED',status_version=2,validation_result='{"outcome":"PASSED"}'::JSONB,
            validation_hash=$3,validated_at=NOW(),validated_by=$1
      WHERE account_id=$1 AND id=$2 AND version=1`,
    [scenario.accountId, connectionId, hash("7")],
  );
  await pool.query(
    `INSERT INTO auto_listing_ai_profile_channels (
       account_id,profile_id,profile_version,channel_id,display_name,connection_id,connection_version,
       channel_order,enabled
     ) VALUES ($1,$2,1,$3,$4,$5,1,2,TRUE)`,
    [scenario.accountId, scenario.profileId, channelId, `Replacement ${label}`, connectionId],
  );
  return { channelId, connectionId };
}

async function insertImageSibling(scenario, {
  label, slotKey, nextRetryAt, createdAt, updatedAt, lastErrorCode = null,
}) {
  const outboxId = `outbox-${label}-${suffix}`;
  const correlationId = `correlation-${label}-${suffix}`;
  const message = {
    contractVersion: "V1", accountId: scenario.accountId, itemId: scenario.itemId,
    phase: "GENERATE_IMAGE_SLOT", slotKey,
    expectedStatusVersion: scenario.expectedStatusVersion, correlationId,
  };
  await pool.query(
    `INSERT INTO auto_listing_ai_outbox (
       id,account_id,job_id,item_id,slot_key,event_type,dedupe_key,state,contract_version,phase,
       phase_target_id,expected_status_version,correlation_id,payload,next_retry_at,last_error_code,
       created_at,updated_at
     ) VALUES ($1,$2,$3,$4,$5,'GENERATE_IMAGE_SLOT',$6,'PENDING','V1','GENERATE_IMAGE_SLOT',
       $5,$7,$8,$9::JSONB,$10,$11,$12,$13)`,
    [outboxId, scenario.accountId, scenario.jobId, scenario.itemId, slotKey,
      autoListingAiMessageDedupeKey(message), scenario.expectedStatusVersion, correlationId,
      JSON.stringify(message), nextRetryAt, lastErrorCode, createdAt, updatedAt],
  );
  return outboxId;
}

async function seedSameAccountCallingJob(scenario) {
  const marker = `foreign-${scenario.accountId}`;
  const connectionId = `connection-${marker}`;
  const channelId = `channel-${marker}`;
  const snapshotId = `snapshot-${marker}`;
  const jobId = `job-${marker}`;
  const itemId = `item-${marker}`;
  await pool.query(
    `INSERT INTO ai_gateway_connection_versions (
       account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
       fingerprint,status,idempotency_key,request_hash,correlation_id,created_by
     ) VALUES ($1,$2,1,'Foreign','https://gateway.invalid','ciphertext','iv','tag','aes-256-gcm','local-v1',
       $3,'PENDING',$4,$5,$6,$1)`,
    [scenario.accountId, connectionId, `fingerprint-${marker}`, `connection-key-${marker}`,
      hash("2"), `connection-correlation-${marker}`],
  );
  await pool.query(
    `UPDATE ai_gateway_connection_versions
        SET status='VALIDATED',status_version=2,validation_result='{"outcome":"PASSED"}'::JSONB,
            validation_hash=$3,validated_at=NOW(),validated_by=$1
      WHERE account_id=$1 AND id=$2 AND version=1`,
    [scenario.accountId, connectionId, hash("3")],
  );
  await pool.query(
    "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
    [snapshotId, scenario.accountId, `record-${marker}`, hash("4")],
  );
  await pool.query(
    `INSERT INTO auto_listing_jobs (
       id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version
     ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,1)`,
    [jobId, scenario.accountId, `job-key-${marker}`, hash("5"), scenario.strategyId, scenario.profileId],
  );
  await pool.query(
    `INSERT INTO auto_listing_job_items (
       id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
     ) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',3,1)`,
    [itemId, jobId, scenario.accountId, snapshotId, scenario.storeId, scenario.warehouseId],
  );
  await pool.query(
    `INSERT INTO auto_listing_ai_profile_channels (
       account_id,profile_id,profile_version,channel_id,display_name,connection_id,connection_version,
       channel_order,enabled,assigned_job_id,assigned_item_id,assigned_status_version,assigned_at,
       execution_lease_owner,execution_lease_token,execution_lease_expires_at
     ) VALUES ($1,$2,1,$3,'Foreign channel',$4,1,2,FALSE,$5,$6,3,NOW(),
       'foreign-worker','foreign-token','2099-01-01T00:00:00.000Z'::TIMESTAMPTZ)`,
    [scenario.accountId, scenario.profileId, channelId, connectionId, jobId, itemId],
  );
  const correlationId = `correlation-${marker}`;
  const message = {
    contractVersion: "V1", accountId: scenario.accountId, itemId,
    phase: "PLAN_CONTENT", expectedStatusVersion: 3, correlationId,
  };
  await pool.query(
    `INSERT INTO auto_listing_ai_outbox (
       id,account_id,job_id,item_id,event_type,dedupe_key,state,contract_version,phase,
       expected_status_version,correlation_id,payload,next_retry_at,lease_owner,lease_token,lease_expires_at
     ) VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,'PROCESSING','V1','PLAN_CONTENT',3,$6,$7::JSONB,
       NOW(),'foreign-worker','foreign-token','2099-01-01T00:00:00.000Z'::TIMESTAMPTZ)`,
    [`outbox-${marker}`, scenario.accountId, jobId, itemId,
      autoListingAiMessageDedupeKey(message), correlationId, JSON.stringify(message)],
  );
  return { ...scenario, jobId, itemId };
}

async function queueProjection(scenario) {
  const job = await createAutoListingRepository({ pool }).getJob({
    accountId: scenario.accountId,
    jobId: scenario.jobId,
  });
  const item = job.items.find(({ id }) => id === scenario.itemId);
  return {
    aiQueueState: item.aiQueueState,
    aiChannelDisplayName: item.aiChannelDisplayName,
    aiChannelSwitching: item.aiChannelSwitching,
    aiChannelWaitStartedAt: item.aiChannelWaitStartedAt,
  };
}

const emptyProjection = {
  aiQueueState: null,
  aiChannelDisplayName: null,
  aiChannelSwitching: false,
  aiChannelWaitStartedAt: null,
};

test("task queue projection matches allocator runnable and reclaimable-channel semantics", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const live = await seedScenario("live", {
    outboxState: "PROCESSING",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    channelMode: "calling",
    addNewerPendingSibling: true,
  });
  assert.deepEqual(await queueProjection(live), {
    aiQueueState: "CALLING_AI",
    aiChannelDisplayName: "Channel live",
    aiChannelSwitching: false,
    aiChannelWaitStartedAt: null,
  });

  const expired = await seedScenario("expired", {
    outboxState: "PROCESSING",
    leaseExpiresAt: "2020-01-01T00:00:00.000Z",
    channelMode: "expired-processing",
  });
  assert.deepEqual(await queueProjection(expired), {
    aiQueueState: "WAITING_FOR_AI_CHANNEL",
    aiChannelDisplayName: "Channel expired",
    aiChannelSwitching: false,
    aiChannelWaitStartedAt: new Date("2020-01-01T00:00:00.000Z"),
  });

  const inconsistentLive = await seedScenario("inconsistent-live", {
    outboxState: "PROCESSING",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    channelMode: "free",
  });
  assert.deepEqual(await queueProjection(inconsistentLive), emptyProjection);

  const planning = await seedScenario("planning", { channelMode: "unavailable" });
  assert.equal((await queueProjection(planning)).aiQueueState, "WAITING_FOR_AI_CHANNEL");
  const generating = await seedScenario("generating", {
    status: "GENERATING", phase: "GENERATE_RICH_CONTENT", channelMode: "unavailable",
  });
  assert.equal((await queueProjection(generating)).aiQueueState, "WAITING_FOR_AI_CHANNEL");
  const planningPhaseOnGenerating = await seedScenario("plan-on-generating", {
    status: "GENERATING", phase: "PLAN_CONTENT", channelMode: "unavailable",
  });
  assert.deepEqual(await queueProjection(planningPhaseOnGenerating), emptyProjection);
  const generationPhaseOnPlanning = await seedScenario("generate-on-planning", {
    status: "PLANNING", phase: "GENERATE_RICH_CONTENT", channelMode: "unavailable",
  });
  assert.deepEqual(await queueProjection(generationPhaseOnPlanning), emptyProjection);

  const fixed = await seedScenario("fixed", { channelMode: "fixed" });
  assert.deepEqual(await queueProjection(fixed), {
    aiQueueState: "WAITING_FOR_AI_CHANNEL",
    aiChannelDisplayName: "Channel fixed",
    aiChannelSwitching: false,
    aiChannelWaitStartedAt: new Date("2020-01-01T00:00:00.000Z"),
  });
  const stale = await seedScenario("stale", { channelMode: "stale-reclaimable" });
  assert.deepEqual(await queueProjection(stale), emptyProjection);

  const switching = await seedScenario("switching", {
    channelMode: "free", lastErrorCode: "AI_GATEWAY_RATE_LIMITED",
  });
  assert.deepEqual(await queueProjection(switching), {
    aiQueueState: "SWITCHING_AI_CHANNEL",
    aiChannelDisplayName: "Channel switching",
    aiChannelSwitching: true,
    aiChannelWaitStartedAt: new Date("2020-01-01T00:00:00.000Z"),
  });
  const noCapacity = await seedScenario("no-capacity", { channelMode: "unavailable" });
  assert.equal((await queueProjection(noCapacity)).aiQueueState, "WAITING_FOR_AI_CHANNEL");
  const sameAccountForeignJob = await seedSameAccountCallingJob(noCapacity);
  assert.equal((await queueProjection(sameAccountForeignJob)).aiQueueState, "CALLING_AI");
  assert.equal((await queueProjection(noCapacity)).aiQueueState, "WAITING_FOR_AI_CHANNEL");

  const future = await seedScenario("future", {
    nextRetryAt: "2099-01-01T00:00:00.000Z", channelMode: "unavailable",
  });
  assert.deepEqual(await queueProjection(future), emptyProjection);
  const nonAi = await seedScenario("non-ai", {
    status: "READY_FOR_REVIEW", phase: "PLAN_CONTENT", channelMode: "unavailable",
  });
  assert.deepEqual(await queueProjection(nonAi), emptyProjection);

  assert.equal(await createAutoListingRepository({ pool }).getJob({
    accountId: switching.accountId,
    jobId: noCapacity.jobId,
  }), null);
  assert.deepEqual(await queueProjection(noCapacity), {
    aiQueueState: "WAITING_FOR_AI_CHANNEL",
    aiChannelDisplayName: null,
    aiChannelSwitching: false,
    aiChannelWaitStartedAt: new Date("2020-01-01T00:00:00.000Z"),
  });
});

test("latest channel failure outranks clean sibling image work and owns the switching timestamp", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const noCapacity = await seedScenario("image-siblings-no-capacity", {
    status: "GENERATING",
    phase: "GENERATE_IMAGE_SLOT",
    phaseTargetId: "slot-a",
    nextRetryAt: "2026-08-28T00:05:00.000Z",
    lastErrorCode: "AI_GATEWAY_NETWORK_FAILED",
    channelMode: "unavailable",
  });
  await pool.query(
    "UPDATE auto_listing_ai_outbox SET updated_at='2026-08-28T00:05:00.000Z'::TIMESTAMPTZ WHERE id=$1",
    [noCapacity.outboxId],
  );
  await pool.query(
    `UPDATE auto_listing_job_items
        SET last_ai_connection_id=$3,last_ai_connection_version=1,last_ai_channel_assigned_at=NOW()
      WHERE account_id=$1 AND id=$2`,
    [noCapacity.accountId, noCapacity.itemId, noCapacity.connectionId],
  );
  await insertImageSibling(noCapacity, {
    label: "image-clean-no-capacity",
    slotKey: "slot-b",
    nextRetryAt: "2026-08-28T00:01:00.000Z",
    createdAt: "2026-08-28T00:00:01.000Z",
    updatedAt: "2026-08-28T00:01:00.000Z",
  });
  assert.deepEqual(await queueProjection(noCapacity), {
    aiQueueState: "SWITCHING_AI_CHANNEL",
    aiChannelDisplayName: "Channel image-siblings-no-capacity",
    aiChannelSwitching: true,
    aiChannelWaitStartedAt: new Date("2026-08-28T00:05:00.000Z"),
  });

  const replacement = await seedScenario("image-siblings-replacement", {
    status: "GENERATING",
    phase: "GENERATE_IMAGE_SLOT",
    phaseTargetId: "slot-a",
    nextRetryAt: "2026-08-28T00:04:00.000Z",
    lastErrorCode: "AI_GATEWAY_NETWORK_FAILED",
    channelMode: "unavailable",
  });
  await pool.query(
    "UPDATE auto_listing_ai_outbox SET updated_at='2026-08-28T00:04:00.000Z'::TIMESTAMPTZ WHERE id=$1",
    [replacement.outboxId],
  );
  await pool.query(
    `UPDATE auto_listing_job_items
        SET last_ai_connection_id=$3,last_ai_connection_version=1,last_ai_channel_assigned_at=NOW()
      WHERE account_id=$1 AND id=$2`,
    [replacement.accountId, replacement.itemId, replacement.connectionId],
  );
  await insertImageSibling(replacement, {
    label: "image-second-failure",
    slotKey: "slot-b",
    nextRetryAt: "2026-08-28T00:06:00.000Z",
    createdAt: "2026-08-28T00:00:01.000Z",
    updatedAt: "2026-08-28T00:06:00.000Z",
    lastErrorCode: "AI_GATEWAY_RATE_LIMITED",
  });
  await insertImageSibling(replacement, {
    label: "image-clean-replacement",
    slotKey: "slot-c",
    nextRetryAt: "2026-08-28T00:02:00.000Z",
    createdAt: "2026-08-28T00:00:02.000Z",
    updatedAt: "2026-08-28T00:02:00.000Z",
  });
  await addReplacementCapacity(replacement, "image-replacement");
  assert.deepEqual(await queueProjection(replacement), {
    aiQueueState: "SWITCHING_AI_CHANNEL",
    aiChannelDisplayName: "Channel image-siblings-replacement",
    aiChannelSwitching: true,
    aiChannelWaitStartedAt: new Date("2026-08-28T00:06:00.000Z"),
  });
});

test("current fixed replacement assignment outranks stale channel failure evidence", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedScenario("failure-with-fixed-replacement", {
    lastErrorCode: "AI_GATEWAY_RATE_LIMITED",
    channelMode: "unavailable",
  });
  const replacement = await addReplacementCapacity(scenario, "fixed-after-failure");
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET assigned_job_id=$3,assigned_item_id=$4,assigned_status_version=$5,assigned_at=NOW()
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, replacement.channelId, scenario.jobId, scenario.itemId,
      scenario.expectedStatusVersion],
  );

  assert.deepEqual(await queueProjection(scenario), {
    aiQueueState: "WAITING_FOR_AI_CHANNEL",
    aiChannelDisplayName: "Replacement fixed-after-failure",
    aiChannelSwitching: false,
    aiChannelWaitStartedAt: new Date("2020-01-01T00:00:00.000Z"),
  });
});

test("live sibling without an exact channel lease blocks stale failure evidence", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedScenario("failure-with-live-mismatched-sibling", {
    status: "GENERATING",
    phase: "GENERATE_IMAGE_SLOT",
    phaseTargetId: "slot-a",
    lastErrorCode: "AI_GATEWAY_NETWORK_FAILED",
    channelMode: "free",
  });
  const siblingId = await insertImageSibling(scenario, {
    label: "live-mismatched-sibling",
    slotKey: "slot-b",
    nextRetryAt: "2020-01-01T00:00:00.000Z",
    createdAt: "2026-08-28T00:00:01.000Z",
    updatedAt: "2026-08-28T00:00:01.000Z",
  });
  await pool.query(
    `UPDATE auto_listing_ai_outbox
        SET state='PROCESSING',lease_owner='other-worker',lease_token='other-token',
            lease_expires_at='2099-01-01T00:00:00.000Z'::TIMESTAMPTZ
      WHERE account_id=$1 AND id=$2`,
    [scenario.accountId, siblingId],
  );

  assert.deepEqual(await queueProjection(scenario), emptyProjection);
});

test("persisted model-404 gateway code projects safe channel switching", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedScenario("model-404-requeued", {
    lastErrorCode: "NON_RETRYABLE_GATEWAY",
    channelMode: "free",
  });
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET requires_revalidation=TRUE,cooldown_until='2099-01-01T00:00:00.000Z'::TIMESTAMPTZ,
            last_error_code='NON_RETRYABLE_GATEWAY'
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.accountId, scenario.channelId],
  );

  assert.deepEqual(await queueProjection(scenario), {
    aiQueueState: "SWITCHING_AI_CHANNEL",
    aiChannelDisplayName: "Channel model-404-requeued",
    aiChannelSwitching: true,
    aiChannelWaitStartedAt: new Date("2020-01-01T00:00:00.000Z"),
  });
});

test("settings-valid channel controls are normalized before task projection", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedScenario("controlled-display-name", {
    outboxState: "PROCESSING",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    channelMode: "calling",
    channelDisplayName: "  Tab\tChannel\u0001  Name  ",
  });

  assert.deepEqual(await queueProjection(scenario), {
    aiQueueState: "CALLING_AI",
    aiChannelDisplayName: "Tab Channel Name",
    aiChannelSwitching: false,
    aiChannelWaitStartedAt: null,
  });
});
