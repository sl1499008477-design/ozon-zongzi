import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  applyAutoListingAiChannelPoolBaseMigrations,
  applyAutoListingAiChannelPoolMigration,
} from "./auto-listing-ai-runtime-postgres-fixture.mjs";

const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1"
  && Boolean(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const hash = (character) => character.repeat(64);

async function rejectsCode(operation, code = "23514") {
  await assert.rejects(operation, (error) => error?.code === code);
}

test("098 enforces account-scoped AI channel assignment, dispatch, and exact-version evidence", {
  skip: !enabled,
  timeout: 90_000,
}, async () => {
  const { Pool } = await import("pg");
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `auto_listing_ai_channels_${suffix}`;
  const pool = new Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  const accountA = `account-a-${suffix}`;
  const accountB = `account-b-${suffix}`;
  const ids = {
    profileA: `profile-a-${suffix}`, profileB: `profile-b-${suffix}`,
    connectionA: `connection-a-${suffix}`, connectionAValidated: `connection-av-${suffix}`,
    connectionB: `connection-b-${suffix}`,
    jobA: `job-a-${suffix}`, jobB: `job-b-${suffix}`,
    itemA: `item-a-${suffix}`, itemB: `item-b-${suffix}`,
  };

  try {
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    await client.query(`SET search_path TO ${quote(schema)}, public`);
    await applyAutoListingAiChannelPoolBaseMigrations(client);
    for (const accountId of [accountA, accountB]) {
      await client.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [accountId, `user-${accountId}`],
      );
    }
    for (const [accountId, marker] of [[accountA, "a"], [accountB, "b"]]) {
      const connectionId = accountId === accountA ? ids.connectionA : ids.connectionB;
      await client.query(
        `INSERT INTO ai_gateway_connection_versions (
           account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
           fingerprint,status,idempotency_key,request_hash,correlation_id,created_by
         ) VALUES ($1,$2,1,$3,'https://gateway.invalid','ciphertext','iv','tag','aes-256-gcm','local-v1',
           $4,'PENDING',$5,$6,$7,$1)`,
        [accountId, connectionId, `Connection ${marker}`, `fp-${marker}`, `connection-${marker}-${suffix}`,
          hash(marker), `corr-${marker}-${suffix}`],
      );
      await client.query(
        `UPDATE ai_gateway_connection_versions
         SET status='VALIDATED',status_version=2,validation_result='{"outcome":"PASSED"}'::jsonb,
           validation_hash=$3,validated_at=NOW(),validated_by=$1
         WHERE account_id=$1 AND id=$2 AND version=1`,
        [accountId, connectionId, hash(marker)],
      );
      await client.query(
        `UPDATE ai_gateway_connection_versions
         SET status='ACTIVE',status_version=3,activated_at=NOW(),activated_by=$1
         WHERE account_id=$1 AND id=$2 AND version=1`,
        [accountId, connectionId],
      );
      await client.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled,connection_id,connection_version
         ) VALUES ($1,$2,'Primary','https://gateway.invalid','SUB2API_ENCRYPTED_KEY','SUB2API_RESPONSES',
           'SUB2API_OPENAI_IMAGES','text-model','image-model',1,TRUE,$3,1)`,
        [accountId === accountA ? ids.profileA : ids.profileB, accountId, connectionId],
      );
    }
    await client.query(
      `INSERT INTO ai_gateway_connection_versions (
         account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
         fingerprint,status,idempotency_key,request_hash,correlation_id,created_by
       ) VALUES ($1,$2,1,'Validated','https://gateway.invalid','ciphertext','iv','tag','aes-256-gcm','local-v1',
         'fp-validated','PENDING',$3,$4,$5,$1)`,
      [accountA, ids.connectionAValidated, `connection-av-${suffix}`, hash("c"), `corr-v-${suffix}`],
    );
    await client.query(
      `UPDATE ai_gateway_connection_versions
       SET status='VALIDATED',status_version=2,validation_result='{"outcome":"PASSED"}'::jsonb,
         validation_hash=$3,validated_at=NOW(),validated_by=$1
       WHERE account_id=$1 AND id=$2 AND version=1`,
      [accountA, ids.connectionAValidated, hash("d")],
    );
    for (const [jobId, itemId, accountId, marker] of [
      [ids.jobA, ids.itemA, accountA, "a"], [ids.jobB, ids.itemB, accountB, "b"],
    ]) {
      const storeId = `store-${marker}-${suffix}`;
      const warehouseId = `warehouse-${marker}-${suffix}`;
      const snapshotId = `snapshot-${marker}-${suffix}`;
      const strategyId = `strategy-${marker}-${suffix}`;
      await client.query("INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)", [storeId, storeId, `client-${marker}-${suffix}`, accountId]);
      await client.query("INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)", [warehouseId, storeId, warehouseId]);
      await client.query("INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,$4)", [strategyId, accountId, `strategy-${marker}`, hash(marker)]);
      await client.query("INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::jsonb,$4)", [snapshotId, accountId, `record-${marker}`, hash(marker)]);
      await client.query("INSERT INTO auto_listing_jobs (id,account_id,source_type,idempotency_key,config_hash,strategy_version_id) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5)", [jobId, accountId, `job-${marker}-${suffix}`, hash(marker), strategyId]);
      await client.query("INSERT INTO auto_listing_job_items (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order) VALUES ($1,$2,$3,$4,$5,$6,'SOURCE_READY',3,1)", [itemId, jobId, accountId, snapshotId, storeId, warehouseId]);
    }

    await applyAutoListingAiChannelPoolMigration(client);
    const backfilled = await client.query(
      "SELECT channel_order,connection_id,connection_version FROM auto_listing_ai_profile_channels WHERE account_id=$1 AND profile_id=$2 AND profile_version=1",
      [accountA, ids.profileA],
    );
    assert.deepEqual(backfilled.rows, [{ channel_order: 1, connection_id: ids.connectionA, connection_version: 1 }]);

    const insertChannel = (channelId, values = {}) => client.query(
      `INSERT INTO auto_listing_ai_profile_channels (
         account_id,profile_id,profile_version,channel_id,display_name,connection_id,connection_version,channel_order,
         assigned_job_id,assigned_item_id,assigned_status_version,assigned_at
       ) VALUES ($1,$2,1,$3,'Channel',$4,$5,$6,$7,$8,$9,$10)`,
      [values.accountId ?? accountA, values.profileId ?? ids.profileA, channelId,
        values.connectionId ?? ids.connectionAValidated, values.connectionVersion ?? 1, values.channelOrder ?? 2,
        values.jobId ?? null, values.itemId ?? null, values.statusVersion ?? null, values.assignedAt ?? null],
    );
    await insertChannel(`channel-a-${suffix}`, { jobId: ids.jobA, itemId: ids.itemA, statusVersion: 3, assignedAt: new Date() });
    await rejectsCode(() => insertChannel(`channel-duplicate-${suffix}`, { channelOrder: 3, jobId: ids.jobA, itemId: ids.itemA, statusVersion: 3, assignedAt: new Date() }), "23505");
    await rejectsCode(() => insertChannel(`channel-half-assigned-${suffix}`, { channelOrder: 4, jobId: ids.jobA }), "23514");
    await rejectsCode(() => client.query(
      "UPDATE auto_listing_ai_profile_channels SET execution_lease_owner='worker' WHERE account_id=$1 AND profile_id=$2 AND channel_id=$3",
      [accountA, ids.profileA, `channel-a-${suffix}`],
    ));
    await rejectsCode(() => insertChannel(`channel-cross-profile-${suffix}`, { accountId: accountA, profileId: ids.profileB, channelOrder: 5 }), "23503");
    await rejectsCode(() => insertChannel(`channel-cross-connection-${suffix}`, { connectionId: ids.connectionB, channelOrder: 5 }), "23503");
    await rejectsCode(() => insertChannel(`channel-wrong-version-${suffix}`, { connectionId: ids.connectionAValidated, channelOrder: 5, connectionVersion: 2 }), "23503");
    await rejectsCode(() => insertChannel(`channel-active-extra-${suffix}`, { connectionId: ids.connectionA, channelOrder: 5 }));
    await rejectsCode(() => client.query(
      "UPDATE auto_listing_job_items SET last_ai_connection_id=$1,last_ai_connection_version=1,last_ai_channel_assigned_at=NOW() WHERE account_id=$2 AND job_id=$3 AND id=$4",
      [ids.connectionB, accountA, ids.jobA, ids.itemA],
    ), "23503");
    await client.query(
      "UPDATE auto_listing_job_items SET last_ai_connection_id=$1,last_ai_connection_version=1,last_ai_channel_assigned_at=NOW() WHERE account_id=$2 AND job_id=$3 AND id=$4",
      [ids.connectionA, accountA, ids.jobA, ids.itemA],
    );
    await rejectsCode(() => client.query(
      "UPDATE auto_listing_ai_profile_channels SET dispatch_generation=-1 WHERE account_id=$1 AND profile_id=$2 AND channel_id=$3",
      [accountA, ids.profileA, `channel-a-${suffix}`],
    ));
    await rejectsCode(() => client.query(
      "UPDATE auto_listing_ai_profile_channels SET uncertain_result_count=3 WHERE account_id=$1 AND profile_id=$2 AND channel_id=$3",
      [accountA, ids.profileA, `channel-a-${suffix}`],
    ));

    await client.query(
      `INSERT INTO auto_listing_ai_outbox (
         id,account_id,job_id,item_id,event_type,dedupe_key,state,contract_version,phase,expected_status_version,correlation_id,payload,
         publication_id,published_at
       ) VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,'COMPLETED','V1','PLAN_CONTENT',3,$6,
         $7::jsonb,$5,NOW())`,
      [`legacy-${suffix}`, accountA, ids.jobA, ids.itemA, hash("e"), `legacy-corr-${suffix}`,
        JSON.stringify({ contractVersion: "V1", accountId: accountA, itemId: ids.itemA, phase: "PLAN_CONTENT", expectedStatusVersion: 3, correlationId: `legacy-corr-${suffix}` })],
    );
    await client.query(
      `INSERT INTO auto_listing_ai_outbox (
         id,account_id,job_id,item_id,event_type,dedupe_key,state,contract_version,phase,expected_status_version,correlation_id,payload,next_retry_at,
         dispatch_contract_version,dispatch_generation,dispatch_queued_at,publication_id,lease_owner,lease_token,lease_expires_at
       ) VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,'PROCESSING','V1','PLAN_CONTENT',3,$6,$7::jsonb,NOW(),
         'CHANNEL_WORK_V1',0,NOW(),$8,'worker','token',NOW()+INTERVAL '1 minute')`,
      [`processing-${suffix}`, accountA, ids.jobA, ids.itemA, hash("f"), `processing-corr-${suffix}`,
        JSON.stringify({ contractVersion: "V1", accountId: accountA, itemId: ids.itemA, phase: "PLAN_CONTENT", expectedStatusVersion: 3, correlationId: `processing-corr-${suffix}` }), `${hash("f")}:0`],
    );
    await rejectsCode(() => client.query("DELETE FROM auto_listing_job_items WHERE account_id=$1 AND job_id=$2 AND id=$3", [accountA, ids.jobA, ids.itemA]), "23503");
    await rejectsCode(() => client.query("DELETE FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2 AND config_version=1", [accountA, ids.profileA]), "23503");
    await assert.rejects(() => client.query("DELETE FROM ai_gateway_connection_versions WHERE account_id=$1 AND id=$2 AND version=1", [accountA, ids.connectionA]));
  } finally {
    try { await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); } catch {}
    client.release();
    await pool.end();
  }
});
