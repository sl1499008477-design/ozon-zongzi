import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { createPostgresGenerationAttemptRepository } from "../auto-listing-generation-attempt-postgres.mjs";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const sha256 = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hash = (character) => character.repeat(64);

export async function runGenerationAttemptPostgresFixture({ connectionString } = {}) {
  if (typeof connectionString !== "string" || !connectionString.trim()) throw new Error("dedicated PostgreSQL URL required");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `generation_attempt_c2_${suffix}`;
  const accountId = `account-${suffix}`;
  const storeId = `store-${suffix}`;
  const warehouseId = `warehouse-${suffix}`;
  const snapshotId = `snapshot-${suffix}`;
  const strategyId = `strategy-${suffix}`;
  const jobId = `job-${suffix}`;
  const itemId = `item-${suffix}`;
  const profileId = `profile-${suffix}`;
  const planId = `plan-${suffix}`;
  const otherPlanId = `other-plan-${suffix}`;
  const scope = {
    accountId, jobId, itemId, planId, visualGroupKey: "visual-a", slotKey: "main",
    expectedStatusVersion: 7,
  };
  try {
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    await client.query(`SET search_path TO ${quote(schema)}, public`);
    const migrations = (await readdir(migrationsDir))
      .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && Number(file.slice(0, 3)) <= 32)
      .sort();
    for (const migration of migrations) {
      await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }
    await client.query(
      "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
      [accountId, `user-${suffix}`],
    );
    await client.query(
      "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,'Store','Store',$2,'active',$3)",
      [storeId, `client-${suffix}`, accountId],
    );
    await client.query(
      "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
      [warehouseId, storeId, `warehouse-${suffix}`],
    );
    await client.query(
      "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,$4)",
      [strategyId, accountId, `strategy-${suffix}`, hash("1")],
    );
    await client.query(
      "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::jsonb,$4)",
      [snapshotId, accountId, `record-${suffix}`, hash("2")],
    );
    await client.query(
      "INSERT INTO auto_listing_jobs (id,account_id,source_type,idempotency_key,config_hash,strategy_version_id) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5)",
      [jobId, accountId, `job-key-${suffix}`, hash("3"), strategyId],
    );
    await client.query(
      "INSERT INTO auto_listing_job_items (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version) VALUES ($1,$2,$3,$4,$5,$6,'GENERATING',7)",
      [itemId, jobId, accountId, snapshotId, storeId, warehouseId],
    );
    await client.query(
      `INSERT INTO ai_gateway_profiles (
         id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,text_model,image_model,config_version
       ) VALUES ($1,$2,'Primary','https://gateway.invalid','AI_GATEWAY_KEY','SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-a','image-a',1)`,
      [profileId, accountId],
    );
    const plan = { slots: [{ slotKey: "main", visualGroupKey: "visual-a", role: "MAIN" }] };
    const facts = [{ factId: "fact-a", kind: "IDENTITY", value: "Product", sourcePath: "identity.name", visualGroupKeys: [] }];
    for (const [id, inputHash] of [[planId, hash("4")], [otherPlanId, hash("5")]]) {
      await client.query(
        `INSERT INTO ai_content_plans (
           id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
           strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
           prompt_template_version,plan,plan_hash,visual_groups_hash,visual_groups,
           fact_registry,fact_registry_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'text-a',1,'image-v1',$12::JSONB,$13,$14,
           $15::JSONB,$16::JSONB,$17)`,
        [id, accountId, jobId, itemId, snapshotId, strategyId, profileId, hash("6"), hash("7"),
          hash("8"), inputHash, JSON.stringify(plan), sha256(plan), hash("9"),
          JSON.stringify({ sourceHash: hash("8"), groups: [], reasonCodes: [], visualGroupsHash: hash("9") }),
          JSON.stringify(facts), sha256(facts)],
      );
    }
    await client.query(
      "UPDATE auto_listing_job_items SET active_content_plan_id=$1 WHERE account_id=$2 AND job_id=$3 AND id=$4",
      [planId, accountId, jobId, itemId],
    );

    let tokenSequence = 0;
    let idSequence = 0;
    let lastDatabaseError = null;
    const diagnosticQuery = async (...arguments_) => {
      try { return await client.query(...arguments_); }
      catch (error) { lastDatabaseError = error; throw error; }
    };
    const repository = createPostgresGenerationAttemptRepository({
      pool: { query: diagnosticQuery, connect: async () => ({ query: diagnosticQuery, release() {} }) },
      token: () => `lease-${++tokenSequence}-${suffix}`,
      id: () => `generation-${++idSequence}-${suffix}`,
    });
    const attemptIdentityHash = hash("a");
    const inputHash = hash("b");
    const generationSize = "768x1024";
    let lease;
    try {
      lease = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts: 3 });
    } catch {
      throw new Error(`generation reserve failed (${lastDatabaseError?.code || "UNKNOWN"}:${lastDatabaseError?.constraint || "NONE"}:${lastDatabaseError?.message || "NONE"})`);
    }
    let bound;
    try {
      bound = await repository.bindGenerationAttemptInput({
        ...scope, attemptIdentityHash, inputHash, generationSize, attemptNo: lease.attemptNo, leaseToken: lease.leaseToken,
      });
    } catch {
      throw new Error(`generation bind failed (${lastDatabaseError?.code || "UNKNOWN"}:${lastDatabaseError?.constraint || "NONE"}:${lastDatabaseError?.message || "NONE"})`);
    }
    const stored = {
      objectKeyVersion: "ATTEMPT_V2", contentHash: hash("c"), contentType: "image/png",
      width: 768, height: 1024, size: 256,
    };
    stored.objectKey = buildGeneratedAssetObjectKey({ ...scope, attemptIdentityHash, inputHash, attemptNo: 1, contentHash: stored.contentHash });
    const owner = { ...scope, attemptIdentityHash, inputHash, generationSize, attemptNo: 1, leaseToken: lease.leaseToken };
    await repository.recordStoredGenerationAsset({ ...owner, ...stored });
    let accepted;
    try {
      accepted = await repository.completeGenerationAttempt({
        ...owner, role: "MAIN", ...stored, checkerEvidence: { accepted: true },
        gatewayRequestId: `gateway-${suffix}`, checkerRequestId: `checker-${suffix}`,
        modelEvidence: { requestedImageModel: "image-a" }, profileId, profileVersion: 1,
        modelName: "image-a", promptHash: hash("d"), planHash: sha256(plan), sourceHash: hash("8"),
        strategyHash: hash("6"), configHash: hash("7"), visualGroupsHash: hash("9"),
        promptTemplateVersion: "image-v1", sourceAssetEvidence: [{
          assetId: "source-a", contentHash: hash("e"), contentType: "image/png", width: 10, height: 20, size: 30,
        }], regeneration: null,
      });
    } catch {
      throw new Error(`generation complete failed (${lastDatabaseError?.code || "UNKNOWN"}:${lastDatabaseError?.constraint || "NONE"}:${lastDatabaseError?.message || "NONE"})`);
    }
    const replay = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts: 3 });

    const abaIdentity = hash("f");
    const firstAba = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash: abaIdentity, generationSize, maxAttempts: 3 });
    await client.query(
      "UPDATE ai_generation_assets SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND attempt_identity_hash=$2 AND attempt_no=1",
      [accountId, abaIdentity],
    );
    const secondAba = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash: abaIdentity, generationSize, maxAttempts: 3 });
    let staleTokenRejected = false;
    let staleTokenErrorCode = null;
    try {
      await repository.failGenerationAttempt({
        ...scope, attemptIdentityHash: abaIdentity, inputHash: abaIdentity, generationSize, attemptNo: 1,
        leaseToken: firstAba.leaseToken, role: "MAIN", code: "AUTO_LISTING_IMAGE_GATEWAY_INVALID",
        retryable: true, gatewayRequestId: null, checkerRequestId: null,
      });
    } catch (error) {
      staleTokenErrorCode = error?.code || null;
      staleTokenRejected = error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED";
    }
    const staleBeforeAttempt = await repository.reserveGenerationAttempt({
      ...scope, expectedStatusVersion: 8, attemptIdentityHash: hash("0"), generationSize, maxAttempts: 3,
    });
    const inactivePlan = await repository.reserveGenerationAttempt({
      ...scope, planId: otherPlanId, attemptIdentityHash: hash("1"), generationSize, maxAttempts: 3,
    });
    const staleCount = Number((await client.query(
      "SELECT COUNT(*)::INTEGER AS count FROM ai_generation_assets WHERE account_id=$1 AND attempt_identity_hash IN ($2,$3)",
      [accountId, hash("0"), hash("1")],
    )).rows[0].count);
    if (!(firstAba.attemptNo === 1 && secondAba.attemptNo === 2
      && firstAba.leaseToken !== secondAba.leaseToken && staleTokenRejected)) {
      throw new Error(`ABA diagnostic (${firstAba.status}:${firstAba.attemptNo}:${secondAba.status}:${secondAba.attemptNo}:${firstAba.leaseToken !== secondAba.leaseToken}:${staleTokenRejected}:${staleTokenErrorCode || "NONE"}:${lastDatabaseError?.code || "NONE"})`);
    }
    return {
      acceptedReplay: lease.status === "RESERVED" && bound.status === "BOUND"
        && accepted.status === "ACCEPTED" && replay.status === "EXISTING_ACCEPTED"
        && replay.record.id === accepted.id,
      abaFenced: true,
      staleBeforeAttempt: staleBeforeAttempt.status === "STALE" && inactivePlan.status === "STALE" && staleCount === 0,
    };
  } finally {
    try { await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); } catch {}
    client.release();
    await pool.end();
  }
}
