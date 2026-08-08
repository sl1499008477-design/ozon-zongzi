import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { createPostgresListingAssetPublicationCleanupRepository } from "../listing-asset-publication-cleanup-postgres.mjs";
import { createPostgresListingAssetPublicationHealthRepository } from "../listing-asset-publication-health-postgres.mjs";
import { createPostgresListingAssetPublicationRepository } from "../listing-asset-publication-postgres.mjs";

const enabled = String(process.env.AUTO_LISTING_POSTGRES_TESTS || "") === "1";
const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL || "";
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const hash = (character) => character.repeat(64);

test("PostgreSQL fences immutable publication evidence against plan-switch races", {
  skip: !enabled || !connectionString,
  timeout: 60_000,
}, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  const owner = await pool.connect();
  const competitor = await pool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `asset_publication_045_${suffix}`;
  const ids = Object.fromEntries(["account", "store", "warehouse", "snapshot", "strategy", "job", "item", "profile", "plan", "asset"]
    .map((key) => [key, `${key}-${suffix}`]));
  const attemptIdentityHash = hash("a");
  const inputHash = hash("b");
  const contentHash = hash("c");
  const objectKey = buildGeneratedAssetObjectKey({
    accountId: ids.account, jobId: ids.job, itemId: ids.item, planId: ids.plan,
    visualGroupKey: "group-a", slotKey: "main-1", attemptIdentityHash, attemptNo: 1,
    inputHash, contentHash,
  });
  try {
    await owner.query(`CREATE SCHEMA ${quote(schema)}`);
    for (const client of [owner, competitor]) await client.query(`SET search_path TO ${quote(schema)}, public`);
    const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
    for (const migration of migrations) await owner.query(await readFile(path.join(migrationsDir, migration), "utf8"));

    await owner.query("INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')", [ids.account, `user-${suffix}`]);
    await owner.query("INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,'Store','Store',$2,'active',$3)", [ids.store, `client-${suffix}`, ids.account]);
    await owner.query("INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)", [ids.warehouse, ids.store, `warehouse-${suffix}`]);
    await owner.query("INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,$4)", [ids.strategy, ids.account, `strategy-${suffix}`, hash("1")]);
    await owner.query("INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::jsonb,$4)", [ids.snapshot, ids.account, `record-${suffix}`, hash("2")]);
    await owner.query("INSERT INTO auto_listing_jobs (id,account_id,source_type,idempotency_key,config_hash,strategy_version_id) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5)", [ids.job, ids.account, `job-${suffix}`, hash("3"), ids.strategy]);
    await owner.query("INSERT INTO auto_listing_job_items (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version) VALUES ($1,$2,$3,$4,$5,$6,'GENERATING',7)", [ids.item, ids.job, ids.account, ids.snapshot, ids.store, ids.warehouse]);
    await owner.query(`INSERT INTO ai_gateway_profiles (
      id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,text_model,image_model,config_version
    ) VALUES ($1,$2,'Primary','https://gateway.invalid','AI_KEY','SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text','image',1)`, [ids.profile, ids.account]);
    await owner.query(`INSERT INTO ai_content_plans (
      id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
      strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
      prompt_template_version,plan,plan_hash,visual_groups_hash,visual_groups,fact_registry,fact_registry_hash
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$9,'text',1,'image-v1',$10::jsonb,$11,$8,$12::jsonb,$13::jsonb,$14)`, [
      ids.plan, ids.account, ids.job, ids.item, ids.snapshot, ids.strategy, ids.profile,
      hash("4"), inputHash,
      JSON.stringify({ slots: [{ slotKey: "main-1", visualGroupKey: "group-a", role: "MAIN" }] }), hash("5"),
      JSON.stringify({ sourceHash: hash("4"), groups: [], reasonCodes: [], visualGroupsHash: hash("4") }),
      JSON.stringify([{ factId: "fact-a", kind: "IDENTITY", value: "Product", sourcePath: "identity.name", visualGroupKeys: [] }]), hash("6"),
    ]);
    await owner.query("UPDATE auto_listing_job_items SET active_content_plan_id=$1 WHERE account_id=$2 AND id=$3", [ids.plan, ids.account, ids.item]);
    await owner.query(`INSERT INTO ai_generation_assets (
      id,account_id,job_id,item_id,plan_id,profile_id,visual_group_key,slot_key,role,input_hash,
      attempt_no,status,gateway_request_id,model_name,profile_version,prompt_hash,object_key,content_hash,
      content_type,width,height,checker_result,accepted_at,plan_hash,source_hash,strategy_hash,config_hash,
      visual_groups_hash,prompt_template_version,source_asset_evidence,checker_request_id,model_evidence,
      size_bytes,attempt_identity_hash,generation_size,final_input_bound_at,object_key_version,expected_status_version
    ) VALUES ($1,$2,$3,$4,$5,$6,'group-a','main-1','MAIN',$7,1,'ACCEPTED',$8,'image',1,$9,$10,$11,
      'image/png',2,3,'{"accepted":true}'::jsonb,NOW(),$9,$9,$9,$9,$9,'image-v1',$12::jsonb,$13,
      '{"model":"image"}'::jsonb,123,$14,'2x3',NOW(),'ATTEMPT_V2',7)`, [
      ids.asset, ids.account, ids.job, ids.item, ids.plan, ids.profile, inputHash,
      `gateway-${suffix}`, hash("7"), objectKey, contentHash,
      JSON.stringify([{ assetId: "source-a", contentHash: hash("8"), contentType: "image/png", width: 1, height: 1, size: 1 }]),
      `checker-${suffix}`, attemptIdentityHash,
    ]);

    const repository = createPostgresListingAssetPublicationRepository({ pool: { query: (...args) => owner.query(...args) }, randomUUID: () => `v1-${suffix}` });
    await owner.query("BEGIN");
    const first = await repository.recordPublication({
      accountId: ids.account, jobId: ids.job, itemId: ids.item, planId: ids.plan, assetId: ids.asset,
      publicObjectKey: `listing-media/v1/${contentHash.slice(0, 2)}/${contentHash}.png`,
      publishedUrl: `https://media.example.com/listing-media/v1/${contentHash.slice(0, 2)}/${contentHash}.png`,
      publicationVersion: "LISTING_MEDIA_V1", publicBaseUrl: "https://media.example.com/",
      publicPrefix: "listing-media/v1", publishedByAccountId: ids.account,
    });
    assert.equal(first.assetId, ids.asset);
    await competitor.query("SET lock_timeout='250ms'");
    await assert.rejects(
      competitor.query("UPDATE auto_listing_job_items SET active_content_plan_id=NULL WHERE account_id=$1 AND id=$2", [ids.account, ids.item]),
      { code: "55P03" },
    );
    await owner.query("COMMIT");

    await competitor.query("UPDATE auto_listing_job_items SET active_content_plan_id=NULL WHERE account_id=$1 AND id=$2", [ids.account, ids.item]);
    assert.equal(await repository.findPublication({ accountId: ids.account, itemId: ids.item, assetId: ids.asset, publicationVersion: "LISTING_MEDIA_V1" }), null);
    await competitor.query("UPDATE auto_listing_job_items SET active_content_plan_id=$1 WHERE account_id=$2 AND id=$3", [ids.plan, ids.account, ids.item]);

    await assert.rejects(owner.query(`INSERT INTO auto_listing_asset_publications (
      id,account_id,job_id,item_id,plan_id,asset_id,visual_group_key,slot_key,role,content_hash,
      content_type,size_bytes,width,height,private_object_key,public_object_key,public_url,
      publication_version,public_base_url,public_prefix,published_by_account_id
    ) SELECT 'bad-' || id,account_id,job_id,item_id,plan_id,asset_id,visual_group_key,slot_key,role,$1,
      content_type,size_bytes,width,height,private_object_key,public_object_key,public_url,'LISTING_MEDIA_V2',
      public_base_url,public_prefix,published_by_account_id
      FROM auto_listing_asset_publications WHERE account_id=$2 AND asset_id=$3 LIMIT 1`, [hash("f"), ids.account, ids.asset]), { code: "23514" });

    const repositoryV2 = createPostgresListingAssetPublicationRepository({ pool: { query: (...args) => owner.query(...args) }, randomUUID: () => `v2-${suffix}` });
    const second = await repositoryV2.recordPublication({
      accountId: ids.account, jobId: ids.job, itemId: ids.item, planId: ids.plan, assetId: ids.asset,
      publicObjectKey: `listing-media/v2/${contentHash.slice(0, 2)}/${contentHash}.png`,
      publishedUrl: `https://media-v2.example.com/listing-media/v2/${contentHash.slice(0, 2)}/${contentHash}.png`,
      publicationVersion: "LISTING_MEDIA_V2", publicBaseUrl: "https://media-v2.example.com/",
      publicPrefix: "listing-media/v2", publishedByAccountId: ids.account,
    });
    assert.equal(second.publicationVersion, "LISTING_MEDIA_V2");
    assert.equal(Number((await owner.query("SELECT COUNT(*) FROM auto_listing_asset_publications WHERE account_id=$1 AND asset_id=$2", [ids.account, ids.asset])).rows[0].count), 2);

    let cleanupSequence = 0;
    const cleanupRepository = createPostgresListingAssetPublicationCleanupRepository({
      pool: { query: (...args) => owner.query(...args), connect: async () => ({
        query: (...args) => owner.query(...args), release() {},
      }) },
      randomUUID: () => `orphan-${++cleanupSequence}-${suffix}`, token: () => `token-${suffix}`,
      clock: () => new Date("2026-08-08T00:00:00Z"),
    });
    const referencedCleanup = await cleanupRepository.recordCleanupRequired({
      accountId: ids.account, jobId: ids.job, itemId: ids.item, planId: ids.plan, assetId: ids.asset,
      contentHash, publicObjectKey: `listing-media/v1/${contentHash.slice(0, 2)}/${contentHash}.png`,
      publicationVersion: "LISTING_MEDIA_V1", publicBaseUrl: "https://media.example.com/",
      publicPrefix: "listing-media/v1", reasonCode: "RECORD_UNCERTAIN",
    });
    assert.equal((await cleanupRepository.claimCleanup({
      accountId: ids.account, cleanupId: referencedCleanup.id, workerId: "worker-a",
    })).status, "REFERENCED");
    const cleanupKey = `listing-media/v3/${contentHash.slice(0, 2)}/${contentHash}.png`;
    const cleanup = await cleanupRepository.recordCleanupRequired({
      accountId: ids.account, jobId: ids.job, itemId: ids.item, planId: ids.plan, assetId: ids.asset,
      contentHash, publicObjectKey: cleanupKey, publicationVersion: "LISTING_MEDIA_V3",
      publicBaseUrl: "https://media-v3.example.com/", publicPrefix: "listing-media/v3",
      reasonCode: "RECORD_UNCERTAIN",
    });
    const claimed = await cleanupRepository.claimCleanup({ accountId: ids.account, cleanupId: cleanup.id, workerId: "worker-a" });
    assert.equal(claimed.status, "DELETING");
    await assert.rejects(repositoryV2.recordPublication({
      accountId: ids.account, jobId: ids.job, itemId: ids.item, planId: ids.plan, assetId: ids.asset,
      publicObjectKey: cleanupKey,
      publishedUrl: `https://media-v3.example.com/${cleanupKey}`,
      publicationVersion: "LISTING_MEDIA_V3", publicBaseUrl: "https://media-v3.example.com/",
      publicPrefix: "listing-media/v3", publishedByAccountId: ids.account,
    }), { code: "23514" });
    const cleaned = await cleanupRepository.completeCleanup({
      accountId: ids.account, cleanupId: cleanup.id, leaseToken: claimed.leaseToken,
    });
    assert.equal(cleaned.status, "CLEANED");

    const healthRepository = createPostgresListingAssetPublicationHealthRepository({
      pool: { query: (...args) => owner.query(...args) }, randomUUID: () => `health-${suffix}`,
    });
    const checkedAt = new Date();
    const expiresAt = new Date(checkedAt.getTime() + 300_000);
    const health = await healthRepository.recordEvidence({
      accountId: ids.account, publicationVersion: "LISTING_MEDIA_V2",
      publicBaseUrl: "https://media-v2.example.com/", publicPrefix: "listing-media/v2", outcome: "PASSED",
      evidence: { probeKind: "PUBLIC_READBACK", httpStatus: 200, contentTypeMatched: true, bytesMatched: true },
      checkedByAccountId: ids.account, checkedAt, expiresAt,
    });
    const ready = await healthRepository.findReadyEvidence({
      accountId: ids.account, publicationVersion: "LISTING_MEDIA_V2",
      publicBaseUrl: "https://media-v2.example.com/", publicPrefix: "listing-media/v2", now: checkedAt,
    });
    assert.equal(ready.id, health.id);
    await assert.rejects(owner.query(
      "UPDATE auto_listing_asset_publication_health_evidence SET outcome='FAILED' WHERE account_id=$1 AND id=$2",
      [ids.account, health.id],
    ), { code: "23514" });
    await assert.rejects(owner.query("UPDATE auto_listing_asset_publications SET public_url=public_url WHERE account_id=$1 AND asset_id=$2", [ids.account, ids.asset]), { code: "23514" });
  } finally {
    try { await owner.query("ROLLBACK"); } catch {}
    try { await owner.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); } catch {}
    owner.release();
    competitor.release();
    await pool.end();
  }
});
