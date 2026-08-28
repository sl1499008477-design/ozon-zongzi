import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import sharp from "sharp";

import { autoListingAiMessageDedupeKey } from "../auto-listing-ai-message.mjs";
import { createPostgresAiOutboxRepository } from "../auto-listing-ai-outbox-postgres.mjs";
import { createPostgresAutoListingAiWorkflow } from "../auto-listing-ai-workflow-postgres.mjs";
import { sha256 } from "../auto-listing-asset-store.mjs";
import { createMemoryGenerationAttemptRepository } from "../auto-listing-generation-attempt-repository.mjs";
import { generateImageSlot } from "../auto-listing-image-generator.mjs";
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

async function seedConnectedScenario({
  itemCount,
  channelCount,
  label,
  itemStatus = "PLANNING",
  phase = "PLAN_CONTENT",
}) {
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
    const slotKey = phase === "GENERATE_IMAGE_SLOT" ? "detail-2" : null;
    const currentMessage = Object.freeze({
      contractVersion: "V1",
      accountId: ids.account,
      itemId,
      phase,
      expectedStatusVersion: 3,
      correlationId,
      ...(slotKey ? { slotKey } : {}),
    });
    await pool.query(
      "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
      [snapshotId, ids.account, `record-${sourceOrder}-${marker}`, hash("f")],
    );
    await pool.query(
      `INSERT INTO auto_listing_job_items (
         id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,3,$8)`,
      [itemId, ids.job, ids.account, snapshotId, ids.store, ids.warehouse, itemStatus, sourceOrder],
    );
    await pool.query(
      `INSERT INTO auto_listing_ai_outbox (
         id,account_id,job_id,item_id,event_type,dedupe_key,state,contract_version,phase,
         phase_target_id,expected_status_version,correlation_id,payload,next_retry_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'PENDING','V1',$5,$9,3,$7,$8::JSONB,NOW())`,
      [outboxId, ids.account, ids.job, itemId, phase, autoListingAiMessageDedupeKey(currentMessage),
        correlationId, JSON.stringify(currentMessage), slotKey],
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

function retryOutcome(message, retryAfterMs = 1_000) {
  return Object.freeze({
    contractVersion: "V1",
    disposition: "RETRY",
    phase: message.phase,
    outcome: "FAILED",
    retryable: true,
    failureCode: "AI_GATEWAY_NETWORK_FAILED",
    correlationId: message.correlationId,
    failureScope: "CHANNEL_TRANSIENT",
    deliveryState: "NOT_SENT",
    retryAfterMs,
  });
}

function ackOutcome(message) {
  return Object.freeze({
    contractVersion: "V1",
    disposition: "ACK",
    phase: message.phase,
    outcome: message.phase === "GENERATE_IMAGE_SLOT" ? "IMAGE_SLOT_ACCEPTED" : "PLAN_READY",
    retryable: false,
    failureCode: null,
    correlationId: message.correlationId,
    failureScope: null,
    deliveryState: null,
    retryAfterMs: null,
  });
}

async function executionSnapshot(scenario, outboxId) {
  return (await pool.query(
    `SELECT outbox.state,outbox.attempts,outbox.dispatch_generation,outbox.publication_id,
            outbox.lease_owner,outbox.lease_token,item.status,item.status_version,
            channel.channel_id,channel.execution_lease_owner,channel.execution_lease_token
       FROM auto_listing_ai_outbox AS outbox
       JOIN auto_listing_job_items AS item
         ON item.account_id=outbox.account_id AND item.id=outbox.item_id
       JOIN auto_listing_ai_profile_channels AS channel
         ON channel.account_id=outbox.account_id
        AND channel.assigned_job_id=outbox.job_id AND channel.assigned_item_id=outbox.item_id
      WHERE outbox.account_id=$1 AND outbox.id=$2`,
    [scenario.account, outboxId],
  )).rows[0];
}

async function createAcceptedAssetJourney(scenario) {
  const sourceBytes = await sharp({
    create: { width: 768, height: 1024, channels: 4, background: "#445566" },
  }).png().toBuffer();
  const sourceHash = sha256(sourceBytes);
  const attempts = createMemoryGenerationAttemptRepository({ token: () => `asset-${crypto.randomUUID()}` });
  const repository = Object.freeze({
    ...attempts,
    async recordAssetCleanupRequired(value) { return value; },
  });
  const objects = new Map();
  const calls = { a: { generate: 0, inspect: 0 }, b: { generate: 0, inspect: 0 } };
  const scope = Object.freeze({
    accountId: scenario.account,
    jobId: scenario.job,
    itemId: scenario.items[0].itemId,
    planId: `plan-${scenario.marker}`,
    visualGroupKey: "main",
    slotKey: "main-1",
  });
  const fact = Object.freeze({
    factId: "fact-name",
    field: "identity.primaryName",
    kind: "IDENTITY_NAME",
    value: "Красный товар",
    numericValue: null,
    unit: null,
    sourcePath: "identity.primaryName",
    visualGroupKeys: ["main"],
  });
  const reference = Object.freeze({
    assetId: "source-main",
    sourceRef: null,
    evidenceKind: "CONTENT_HASH",
    contentHash: sourceHash,
  });
  const slot = Object.freeze({
    slotKey: scope.slotKey,
    visualGroupKey: scope.visualGroupKey,
    role: "MAIN",
    textDensity: "LIGHT",
    preserve: ["shape"],
    referenceAssetIds: [reference.assetId],
  });
  const profile = Object.freeze({
    id: scenario.profile,
    accountId: scenario.account,
    configVersion: 1,
    textModel: "text-model",
    imageModel: "image-model",
  });
  const plan = Object.freeze({
    id: scope.planId,
    jobId: scope.jobId,
    itemId: scope.itemId,
    sourceAccountId: scope.accountId,
    profileId: profile.id,
    profileVersion: profile.configVersion,
    plannerModel: profile.textModel,
    promptTemplateVersion: "image-v1",
    planHash: hash("1"),
    sourceHash: hash("2"),
    strategyHash: hash("3"),
    configHash: hash("4"),
    visualGroupsHash: hash("5"),
    visualGroups: { groups: [{ visualGroupKey: scope.visualGroupKey, referenceImages: [reference] }] },
    plan: { slots: [slot] },
    factRegistry: [fact],
  });
  const gateway = (name) => Object.freeze({
    async generateImage() {
      calls[name].generate += 1;
      return {
        bytes: sourceBytes,
        requestId: `generate-${name}`,
        modelEvidence: {
          requestedImageModel: profile.imageModel,
          gatewayReportedImageModel: profile.imageModel,
          gatewayReportedImageModelPresent: true,
          orchestratorModel: "",
        },
      };
    },
    async inspectImage() {
      calls[name].inspect += 1;
      return {
        requestId: `inspect-${name}`,
        modelEvidence: {
          requestedTextModel: profile.textModel,
          gatewayReportedTextModel: profile.textModel,
          gatewayReportedTextModelPresent: true,
        },
        value: {
          matchesProduct: true,
          matchesCategoryStyle: true,
          claimsVerified: true,
          russianText: true,
          quality: "PASS",
          prohibitedContent: false,
          reasons: [],
          evidence: {
            identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: [reference.assetId] },
            categoryStyle: { matches: true, referenceEvidenceIds: [] },
            claims: [{
              text: fact.value,
              sourceFactId: fact.factId,
              field: fact.field,
              value: fact.value,
              numericValue: null,
              unit: null,
            }],
            detectedTexts: ["товар"],
            language: "ru",
            qualityFlags: [],
            prohibitedFlags: [],
          },
        },
      };
    },
  });
  const inputFor = (execution, name) => ({
    scope,
    plan,
    slot,
    categoryStyle: null,
    profile,
    imageModel: profile.imageModel,
    ratio: "3:4",
    resolution: "1K",
    size: "768x1024",
    quality: "high",
    templateVersion: "image-v1",
    gatewayExecution: {
      channelId: execution.channelId,
      connectionId: execution.connectionId,
      connectionVersion: execution.connectionVersion,
      idleTimeoutMs: 300_000,
    },
    sourceAssetLoader: {
      async loadSourceAsset() {
        return {
          assetId: reference.assetId,
          sourceRef: reference.sourceRef,
          evidenceKind: reference.evidenceKind,
          bytes: sourceBytes,
          contentType: "image/png",
          width: 768,
          height: 1024,
        };
      },
    },
    repository,
    storage: {
      async putObjectFromBuffer(value) {
        objects.set(value.key, Buffer.from(value.buffer));
        return {
          key: value.key,
          sha256: sha256(value.buffer),
          contentType: value.contentType,
          size: value.buffer.length,
        };
      },
      async getObjectBuffer(key) {
        const value = objects.get(key);
        if (!value) throw new Error("missing accepted object");
        return Buffer.from(value);
      },
    },
    gateway: gateway(name),
  });
  return { calls, inputFor };
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

test("case 2: two channels cap concurrency at two; the third waits with attempts zero and resumes after release", {
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

test("case 3: competing same-item slots are serialized by the durable outbox and channel lease before paid work", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedConnectedScenario({
    itemCount: 1,
    channelCount: 2,
    label: "same-item-competition",
    itemStatus: "GENERATING",
    phase: "GENERATE_IMAGE_SLOT",
  });
  const sibling = Object.freeze({
    ...scenario.items[0].message,
    slotKey: "main-1",
    correlationId: `correlation-sibling-${scenario.marker}`,
  });
  await pool.query(
    `INSERT INTO auto_listing_ai_outbox (
       id,account_id,job_id,item_id,event_type,dedupe_key,state,contract_version,phase,
       phase_target_id,expected_status_version,correlation_id,payload,next_retry_at
     ) VALUES ($1,$2,$3,$4,'GENERATE_IMAGE_SLOT',$5,'PENDING','V1','GENERATE_IMAGE_SLOT',$8,3,$6,$7::JSONB,NOW())`,
    [`outbox-sibling-${scenario.marker}`, scenario.account, scenario.job, scenario.items[0].itemId,
      autoListingAiMessageDedupeKey(sibling), sibling.correlationId, JSON.stringify(sibling), sibling.slotKey],
  );

  const repositories = [outboxRepository("same-item-a"), outboxRepository("same-item-b")];
  const competingClaims = await Promise.all(repositories.map((repository, index) => claim(
    repository,
    scenario,
    `relay-same-item-${index + 1}`,
    1,
  )));
  const claimed = competingClaims.flat();
  let activePaidCalls = 0;
  let maxPaidCalls = 0;
  await Promise.all(claimed.map(async () => {
    activePaidCalls += 1;
    maxPaidCalls = Math.max(maxPaidCalls, activePaidCalls);
    await new Promise((resolve) => setImmediate(resolve));
    activePaidCalls -= 1;
  }));

  assert.equal(claimed.length, 1, "the durable claim boundary must admit only one same-item slot");
  assert.equal(maxPaidCalls, 1, "a missing durable mutex would let both competing paid calls overlap");
  assert.deepEqual((await pool.query(
    `SELECT state,attempts,dispatch_generation
       FROM auto_listing_ai_outbox
      WHERE account_id=$1 AND item_id=$2
      ORDER BY state DESC, id`,
    [scenario.account, scenario.items[0].itemId],
  )).rows.map((row) => ({ ...row })), [
    { state: "PROCESSING", attempts: 1, dispatch_generation: 1 },
    { state: "PENDING", attempts: 0, dispatch_generation: 0 },
  ]);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::INTEGER AS count
       FROM auto_listing_ai_profile_channels
      WHERE account_id=$1 AND assigned_item_id=$2 AND execution_lease_expires_at>NOW()`,
    [scenario.account, scenario.items[0].itemId],
  )).rows[0].count, 1);
});

test("case 4: durable NOT_SENT requeue assigns channel B and the production generator reuses channel A's accepted asset", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedConnectedScenario({
    itemCount: 1,
    channelCount: 2,
    label: "switch-reuse",
    itemStatus: "GENERATING",
    phase: "GENERATE_IMAGE_SLOT",
  });
  const repository = outboxRepository("switch-reuse");
  const workflow = createPostgresAutoListingAiWorkflow({ pool });
  const [claimedA] = await claim(repository, scenario, "relay-channel-a", 1);
  assert.equal(claimedA.workMessage.execution.connectionId, scenario.connections[0]);
  const adoptedA = await markPublishedAndAdopt(repository, claimedA, "worker-channel-a");
  const assets = await createAcceptedAssetJourney(scenario);
  const acceptedOnA = await generateImageSlot(assets.inputFor(adoptedA.workMessage.execution, "a"));
  assert.deepEqual(assets.calls.a, { generate: 1, inspect: 1 });
  assert.equal(acceptedOnA.gatewayConnectionId, scenario.connections[0]);
  assert.equal(acceptedOnA.checkerConnectionId, scenario.connections[0]);

  assert.deepEqual(await workflow.requeueChannelFailure({
    message: scenario.items[0].message,
    outcome: retryOutcome(scenario.items[0].message, 60_000),
    execution: adoptedA.workMessage.execution,
  }), {
    disposition: "REQUEUED",
    status: "GENERATING",
    statusVersion: 3,
    enqueued: 0,
    uncertainResultCount: 0,
  });
  assert.deepEqual((await pool.query(
    `SELECT state,attempts,dispatch_generation,publication_id,lease_owner,lease_token
       FROM auto_listing_ai_outbox WHERE account_id=$1 AND id=$2`,
    [scenario.account, claimedA.id],
  )).rows[0], {
    state: "PENDING",
    attempts: 1,
    dispatch_generation: 1,
    publication_id: null,
    lease_owner: null,
    lease_token: null,
  });

  const [claimedB] = await claim(repository, scenario, "relay-channel-b", 1);
  assert.equal(claimedB.workMessage.execution.connectionId, scenario.connections[1]);
  assert.equal(claimedB.workMessage.execution.dispatchGeneration, 2);
  const reusedOnB = await generateImageSlot(assets.inputFor(claimedB.workMessage.execution, "b"));
  assert.equal(reusedOnB.id, acceptedOnA.id);
  assert.equal(reusedOnB.gatewayConnectionId, scenario.connections[0], "producer remains channel A");
  assert.equal(reusedOnB.checkerConnectionId, scenario.connections[0], "checker producer remains channel A");
  assert.deepEqual(assets.calls.b, { generate: 0, inspect: 0 },
    "channel B must not repeat either paid call for the accepted slot");
});

test("case 5: two cooldown-only channels wait without consuming attempts and resume after expiry", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedConnectedScenario({ itemCount: 1, channelCount: 2, label: "cooldown-wait" });
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET cooldown_until=NOW()+INTERVAL '250 milliseconds',last_error_code='AI_GATEWAY_NETWORK_FAILED'
      WHERE account_id=$1`,
    [scenario.account],
  );
  const repository = outboxRepository("cooldown-wait");
  assert.deepEqual(await claim(repository, scenario, "relay-during-cooldown", 1), []);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::INTEGER AS count FROM auto_listing_ai_profile_channels
      WHERE account_id=$1 AND cooldown_until>NOW() AND last_error_code='AI_GATEWAY_NETWORK_FAILED'`,
    [scenario.account],
  )).rows[0].count, 2);
  assert.deepEqual((await pool.query(
    "SELECT state,attempts,dispatch_generation FROM auto_listing_ai_outbox WHERE account_id=$1 AND id=$2",
    [scenario.account, scenario.items[0].outboxId],
  )).rows[0], { state: "PENDING", attempts: 0, dispatch_generation: 0 });

  await new Promise((resolve) => setTimeout(resolve, 400));
  const [resumed] = await claim(repository, scenario, "relay-after-cooldown", 1);
  assert.equal(resumed.itemId, scenario.items[0].itemId);
  assert.deepEqual((await pool.query(
    `SELECT outbox.state,outbox.attempts,outbox.dispatch_generation,
            channel.consecutive_failure_count,channel.last_error_code
       FROM auto_listing_ai_outbox AS outbox
       JOIN auto_listing_ai_profile_channels AS channel
         ON channel.account_id=outbox.account_id AND channel.assigned_item_id=outbox.item_id
      WHERE outbox.account_id=$1 AND outbox.id=$2`,
    [scenario.account, scenario.items[0].outboxId],
  )).rows[0], {
    state: "PROCESSING",
    attempts: 1,
    dispatch_generation: 1,
    consecutive_failure_count: 0,
    last_error_code: "AI_GATEWAY_NETWORK_FAILED",
  });
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

test("case 8: generation-2 takeover fences generation-1 renew and outcome persistence", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedConnectedScenario({ itemCount: 2, channelCount: 1, label: "takeover" });
  const firstRepository = outboxRepository("takeover-one");
  const [first] = await claim(firstRepository, scenario, "relay-crashed", 1);
  const firstAdopted = await markPublishedAndAdopt(firstRepository, first, "worker-crashed");
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

  const beforeStaleAttempts = await executionSnapshot(scenario, first.id);
  await assert.rejects(firstRepository.renewAutoListingAiWorkLease({
    accountId: scenario.account,
    itemId: first.itemId,
    id: first.id,
    publicationId: first.publicationId,
    dispatchGeneration: firstAdopted.workMessage.execution.dispatchGeneration,
    workerId: firstAdopted.workMessage.execution.leaseOwner,
    leaseToken: firstAdopted.workMessage.execution.leaseToken,
    leaseMs: 120_000,
  }), { code: "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED" });
  assert.deepEqual(await executionSnapshot(scenario, first.id), beforeStaleAttempts);

  const workflow = createPostgresAutoListingAiWorkflow({ pool });
  assert.deepEqual(await workflow.applyPhaseOutcome({
    message: scenario.items[0].message,
    outcome: ackOutcome(scenario.items[0].message),
    execution: firstAdopted.workMessage.execution,
  }), { disposition: "STALE", status: null, statusVersion: null, enqueued: 0 });
  assert.deepEqual(await workflow.requeueChannelFailure({
    message: scenario.items[0].message,
    outcome: retryOutcome(scenario.items[0].message),
    execution: firstAdopted.workMessage.execution,
  }), { disposition: "STALE", status: null, statusVersion: null, enqueued: 0 });
  assert.deepEqual(await executionSnapshot(scenario, first.id), beforeStaleAttempts);

  const generationOnlyStale = Object.freeze({
    ...takenOver.workMessage.execution,
    dispatchGeneration: 1,
  });
  assert.deepEqual(await workflow.applyPhaseOutcome({
    message: scenario.items[0].message,
    outcome: ackOutcome(scenario.items[0].message),
    execution: generationOnlyStale,
  }), { disposition: "STALE", status: null, statusVersion: null, enqueued: 0 });
  assert.deepEqual(await executionSnapshot(scenario, first.id), beforeStaleAttempts,
    "a stale generation must not alter the generation-2 owner or item state");
});

test("case 8b: generation-2 reservation wait is durable and later reclaims the same fixed channel", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedConnectedScenario({ itemCount: 2, channelCount: 1, label: "reservation-defer" });
  const repository = outboxRepository("reservation-defer");
  const [generationOne] = await claim(repository, scenario, "relay-reservation-one", 1);
  const adoptedOne = await markPublishedAndAdopt(repository, generationOne, "worker-reservation-one");
  await pool.query(
    "UPDATE auto_listing_ai_outbox SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND id=$2",
    [scenario.account, generationOne.id],
  );
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET execution_lease_expires_at=NOW()-INTERVAL '1 second'
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.account, generationOne.workMessage.execution.channelId],
  );

  const [generationTwo] = await claim(repository, scenario, "relay-reservation-two", 1);
  assert.equal(generationTwo.itemId, scenario.items[0].itemId);
  assert.equal(generationTwo.workMessage.execution.dispatchGeneration, 2);
  const adoptedTwo = await markPublishedAndAdopt(repository, generationTwo, "worker-reservation-two");
  const workflow = createPostgresAutoListingAiWorkflow({ pool });
  assert.deepEqual(await workflow.applyPhaseOutcome({
    message: scenario.items[0].message,
    outcome: {
      contractVersion: "V1", disposition: "RETRY", phase: "PLAN_CONTENT", outcome: "IN_PROGRESS",
      retryable: true, failureCode: "AUTO_LISTING_CONTENT_PLAN_IN_PROGRESS",
      correlationId: scenario.items[0].message.correlationId,
      failureScope: "RESERVATION_BUSY", deliveryState: null, retryAfterMs: 30_000,
    },
    execution: adoptedTwo.workMessage.execution,
  }), { disposition: "DEFERRED", status: "PLANNING", statusVersion: 3, enqueued: 0 });

  assert.deepEqual((await pool.query(
    `SELECT item.status,item.status_version,outbox.state,outbox.uncertain_result_count,
            outbox.attempts,outbox.next_retry_at>NOW() AS deferred,
            channel.assigned_item_id,channel.enabled,channel.execution_lease_owner,
            channel.consecutive_failure_count,channel.last_error_code
       FROM auto_listing_job_items AS item
       JOIN auto_listing_ai_outbox AS outbox
         ON outbox.account_id=item.account_id AND outbox.item_id=item.id
       JOIN auto_listing_ai_profile_channels AS channel
         ON channel.account_id=item.account_id AND channel.assigned_item_id=item.id
      WHERE item.account_id=$1 AND item.id=$2`,
    [scenario.account, scenario.items[0].itemId],
  )).rows[0], {
    status: "PLANNING", status_version: 3, state: "PENDING", uncertain_result_count: 0,
    attempts: 2, deferred: true, assigned_item_id: scenario.items[0].itemId,
    enabled: true, execution_lease_owner: null, consecutive_failure_count: 0, last_error_code: null,
  });
  assert.deepEqual(await workflow.applyPhaseOutcome({
    message: scenario.items[0].message,
    outcome: ackOutcome(scenario.items[0].message),
    execution: adoptedOne.workMessage.execution,
  }), { disposition: "STALE", status: null, statusVersion: null, enqueued: 0 });

  await pool.query(
    "UPDATE auto_listing_ai_outbox SET next_retry_at=NOW() WHERE account_id=$1 AND id=$2",
    [scenario.account, generationOne.id],
  );
  const [generationThree] = await claim(repository, scenario, "relay-reservation-three", 1);
  assert.equal(generationThree.itemId, scenario.items[0].itemId);
  assert.equal(generationThree.workMessage.execution.channelId, generationOne.workMessage.execution.channelId);
  assert.equal(generationThree.workMessage.execution.dispatchGeneration, 3);
  assert.deepEqual((await pool.query(
    "SELECT status,status_version,failure_code FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
    [scenario.account, scenario.items[0].itemId],
  )).rows[0], { status: "PLANNING", status_version: 3, failure_code: null });
  assert.deepEqual((await pool.query(
    "SELECT state,attempts FROM auto_listing_ai_outbox WHERE account_id=$1 AND id=$2",
    [scenario.account, scenario.items[1].outboxId],
  )).rows[0], { state: "PENDING", attempts: 0 });
});

test("case 8c: a disabled crashed busy channel reclaims only its fixed item then releases before the next phase", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  timeout: 120_000,
}, async () => {
  const scenario = await seedConnectedScenario({ itemCount: 2, channelCount: 2, label: "disabled-takeover" });
  const otherTenant = await seedConnectedScenario({ itemCount: 1, channelCount: 1, label: "disabled-other-tenant" });
  const repository = outboxRepository("disabled-takeover");
  const [generationOne] = await claim(repository, scenario, "relay-disabled-one", 1);
  const adoptedOne = await markPublishedAndAdopt(repository, generationOne, "worker-disabled-one");
  const disabledChannel = generationOne.workMessage.execution.channelId;
  await pool.query(
    "UPDATE auto_listing_ai_profile_channels SET enabled=FALSE WHERE account_id=$1 AND channel_id=$2",
    [scenario.account, disabledChannel],
  );
  await pool.query(
    "UPDATE auto_listing_ai_outbox SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND id=$2",
    [scenario.account, generationOne.id],
  );
  await pool.query(
    `UPDATE auto_listing_ai_profile_channels
        SET execution_lease_expires_at=NOW()-INTERVAL '1 second'
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.account, disabledChannel],
  );

  const [generationTwo] = await claim(repository, scenario, "relay-disabled-two", 1);
  assert.equal(generationTwo.itemId, scenario.items[0].itemId);
  assert.equal(generationTwo.workMessage.execution.channelId, disabledChannel);
  assert.equal(generationTwo.workMessage.execution.dispatchGeneration, 2);
  const adoptedTwo = await markPublishedAndAdopt(repository, generationTwo, "worker-disabled-two");
  await assert.rejects(repository.renewAutoListingAiWorkLease({
    accountId: scenario.account, itemId: generationOne.itemId, id: generationOne.id,
    publicationId: generationOne.publicationId,
    dispatchGeneration: adoptedOne.workMessage.execution.dispatchGeneration,
    workerId: adoptedOne.workMessage.execution.leaseOwner,
    leaseToken: adoptedOne.workMessage.execution.leaseToken,
    leaseMs: 60_000,
  }), { code: "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED" });
  assert.deepEqual((await pool.query(
    "SELECT state,attempts FROM auto_listing_ai_outbox WHERE account_id=$1 AND id=$2",
    [scenario.account, scenario.items[1].outboxId],
  )).rows[0], { state: "PENDING", attempts: 0 });
  assert.deepEqual((await pool.query(
    "SELECT assigned_item_id,execution_lease_owner FROM auto_listing_ai_profile_channels WHERE account_id=$1",
    [otherTenant.account],
  )).rows, [{ assigned_item_id: null, execution_lease_owner: null }]);

  const planId = `plan-${scenario.marker}`;
  await pool.query(
    `INSERT INTO ai_content_plans (
       id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
       strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
       prompt_template_version,plan,plan_hash,visual_groups_hash,visual_groups,gateway_request_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$9,'planner',1,'plan-v1',
       '{"slots":[]}'::JSONB,$8,$8,'{"groups":[]}'::JSONB,'gateway-request')`,
    [planId, scenario.account, scenario.job, scenario.items[0].itemId,
      scenario.items[0].snapshotId, scenario.strategy, scenario.profile, hash("8"), hash("9")],
  );
  await pool.query(
    "UPDATE auto_listing_job_items SET active_content_plan_id=$3 WHERE account_id=$1 AND id=$2",
    [scenario.account, scenario.items[0].itemId, planId],
  );
  const workflow = createPostgresAutoListingAiWorkflow({ pool });
  assert.deepEqual(await workflow.applyPhaseOutcome({
    message: scenario.items[0].message,
    outcome: ackOutcome(scenario.items[0].message),
    execution: adoptedTwo.workMessage.execution,
  }), { disposition: "APPLIED", status: "PLANNING", statusVersion: 3, enqueued: 1 });
  assert.deepEqual((await pool.query(
    `SELECT assigned_item_id,execution_lease_owner
       FROM auto_listing_ai_profile_channels
      WHERE account_id=$1 AND channel_id=$2`,
    [scenario.account, disabledChannel],
  )).rows[0], { assigned_item_id: null, execution_lease_owner: null });

  const [newItem] = await claim(repository, scenario, "relay-new-item-after-disabled", 1);
  assert.equal(newItem.itemId, scenario.items[1].itemId);
  assert.notEqual(newItem.workMessage.execution.channelId, disabledChannel);
  assert.equal(newItem.workMessage.execution.channelId, scenario.channels[1]);
  await completeAiAndRelease(scenario, newItem);

  const [nextPhase] = await claim(repository, scenario, "relay-next-phase-after-disabled", 1);
  assert.equal(nextPhase.itemId, scenario.items[0].itemId);
  assert.notEqual(nextPhase.workMessage.execution.channelId, disabledChannel);
  assert.equal(nextPhase.workMessage.execution.channelId, scenario.channels[1]);
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
