import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { createMemoryGenerationAttemptRepository } from "../auto-listing-generation-attempt-repository.mjs";
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
  const connectionAId = `connection-a-${suffix}`;
  const connectionBId = `connection-b-${suffix}`;
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
      .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && Number(file.slice(0, 3)) <= 98)
      .sort();
    for (const migration of migrations) {
      await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }
    await client.query(
      "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
      [accountId, `user-${suffix}`],
    );
    for (const [connectionId, version] of [[connectionAId, 1], [connectionBId, 1]]) {
      await client.query(
        `INSERT INTO ai_gateway_connection_versions (
           account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
           fingerprint,status,status_version,idempotency_key,request_hash,correlation_id,created_by
         ) VALUES ($1,$2,$3,$2,'https://gateway.invalid','cipher','iv','tag','aes-256-gcm','key-1',$4,'PENDING',1,$5,$6,$7,$8)`,
        [accountId, connectionId, version, hash(connectionId === connectionAId ? "a" : "b"),
          `connection-key-${connectionId}`, hash(connectionId === connectionAId ? "c" : "d"),
          `correlation-${connectionId}`, accountId],
      );
      const validationResult = { outcome: "PASSED", connectionId, connectionVersion: version };
      const validated = await client.query(
        `UPDATE ai_gateway_connection_versions
            SET status='VALIDATED',status_version=2,validation_result=$4::JSONB,validation_hash=$5,
                validated_at=NOW(),validated_by=$1
          WHERE account_id=$1 AND id=$2 AND version=$3 AND status='PENDING' AND status_version=1`,
        [accountId, connectionId, version, JSON.stringify(validationResult), sha256(validationResult)],
      );
      if (validated.rowCount !== 1) throw new Error(`connection validation setup failed for ${connectionId}`);
    }
    const activated = await client.query(
      `UPDATE ai_gateway_connection_versions
          SET status='ACTIVE',status_version=3,activated_at=NOW(),activated_by=$1
        WHERE account_id=$1 AND id=$2 AND version=1 AND status='VALIDATED' AND status_version=2`,
      [accountId, connectionAId],
    );
    if (activated.rowCount !== 1) throw new Error(`connection activation setup failed for ${connectionAId}`);
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
      "INSERT INTO auto_listing_job_items (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order) VALUES ($1,$2,$3,$4,$5,$6,'GENERATING',7,1)",
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

    const channelIdentity = hash("2");
    const channelInputHash = hash("3");
    const channelLease = await repository.reserveGenerationAttempt({
      ...scope, attemptIdentityHash: channelIdentity, generationSize, maxAttempts: 3,
      gatewayConnectionId: connectionAId, gatewayConnectionVersion: 1,
    });
    await repository.bindGenerationAttemptInput({
      ...scope, attemptIdentityHash: channelIdentity, inputHash: channelInputHash,
      generationSize, attemptNo: channelLease.attemptNo, leaseToken: channelLease.leaseToken,
      gatewayConnectionId: connectionAId, gatewayConnectionVersion: 1,
    });
    const channelStored = {
      objectKeyVersion: "ATTEMPT_V2", contentHash: hash("4"), contentType: "image/png",
      width: 768, height: 1024, size: 512,
    };
    channelStored.objectKey = buildGeneratedAssetObjectKey({
      ...scope, attemptIdentityHash: channelIdentity, inputHash: channelInputHash,
      attemptNo: 1, contentHash: channelStored.contentHash,
    });
    const channelOwner = {
      ...scope, attemptIdentityHash: channelIdentity, inputHash: channelInputHash,
      generationSize, attemptNo: 1, leaseToken: channelLease.leaseToken,
      gatewayConnectionId: connectionAId, gatewayConnectionVersion: 1,
    };
    await repository.recordStoredGenerationAsset({ ...channelOwner, ...channelStored });
    await repository.releaseGenerationLease({
      ...channelOwner, errorCode: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED",
      role: "MAIN", profileId, profileVersion: 1, modelName: "image-a",
      gatewayRequestId: `channel-gateway-${suffix}`, checkerRequestId: `channel-checker-${suffix}`,
      modelEvidence: { requestedImageModel: "image-a" },
      checkerConnectionId: connectionBId, checkerConnectionVersion: 1,
    });
    for (const mutation of [
      { accountId: `other-${accountId}` },
      { itemId: `other-${itemId}` },
      { attemptNo: 2 },
      { leaseToken: `stale-${channelLease.leaseToken}` },
    ]) {
      await assertReleaseRejected(repository, {
        ...channelOwner, ...mutation, errorCode: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED",
        role: "MAIN", profileId, profileVersion: 1, modelName: "image-a",
        gatewayRequestId: `other-gateway-${suffix}`, checkerRequestId: null,
        modelEvidence: { requestedImageModel: "image-a" },
      });
    }
    const releasedBeforeReclaim = (await client.query(
      `SELECT attempt_no,status,lease_token,error_code,gateway_request_id,object_key,
              gateway_connection_id,gateway_connection_version,checker_connection_id,checker_connection_version
       FROM ai_generation_assets WHERE account_id=$1 AND attempt_identity_hash=$2`,
      [accountId, channelIdentity],
    )).rows;
    const concurrentRepository = createPostgresGenerationAttemptRepository({
      pool: {
        async connect() {
          const connection = await pool.connect();
          await connection.query(`SET search_path TO ${quote(schema)}, public`);
          return connection;
        },
      },
      token: () => `channel-lease-${++tokenSequence}-${suffix}`,
      id: () => `channel-generation-${++idSequence}-${suffix}`,
    });
    const concurrent = await Promise.all([
      concurrentRepository.reserveGenerationAttempt({ ...scope, attemptIdentityHash: channelIdentity, generationSize, maxAttempts: 3,
        gatewayConnectionId: connectionBId, gatewayConnectionVersion: 1 }),
      concurrentRepository.reserveGenerationAttempt({ ...scope, attemptIdentityHash: channelIdentity, generationSize, maxAttempts: 3,
        gatewayConnectionId: connectionBId, gatewayConnectionVersion: 1 }),
    ]);
    const reclaimed = concurrent.find(({ status }) => status === "RESERVED");
    const occupied = concurrent.find(({ status }) => status === "IN_PROGRESS");
    const rebound = await repository.bindGenerationAttemptInput({
      ...scope, attemptIdentityHash: channelIdentity, inputHash: channelInputHash,
      generationSize, attemptNo: reclaimed?.attemptNo, leaseToken: reclaimed?.leaseToken,
      gatewayConnectionId: reclaimed?.gatewayConnectionId, gatewayConnectionVersion: reclaimed?.gatewayConnectionVersion,
    });
    await assertCompensationRejected(repository, {
      ...scope, attemptIdentityHash: channelIdentity, inputHash: channelInputHash,
      generationSize, attemptNo: reclaimed?.attemptNo, leaseToken: `stale-${reclaimed?.leaseToken}`,
      gatewayConnectionId: connectionAId, gatewayConnectionVersion: 1,
      ...channelStored,
    });
    const retainedAfterStaleCompensation = (await client.query(
      `SELECT object_key FROM ai_generation_assets
       WHERE account_id=$1 AND attempt_identity_hash=$2`,
      [accountId, channelIdentity],
    )).rows[0]?.object_key;
    const compensated = await repository.revertStoredGenerationAsset({
      ...scope, attemptIdentityHash: channelIdentity, inputHash: channelInputHash,
      generationSize, attemptNo: reclaimed?.attemptNo, leaseToken: reclaimed?.leaseToken,
      gatewayConnectionId: connectionAId, gatewayConnectionVersion: 1,
      ...channelStored,
    });
    const clearedAfterCompensation = (await client.query(
      `SELECT object_key,content_hash FROM ai_generation_assets
       WHERE account_id=$1 AND attempt_identity_hash=$2`,
      [accountId, channelIdentity],
    )).rows[0];
    let staleProducerReplacementRejected = false;
    try {
      await repository.replaceUnusableGenerationEvidence({
        ...scope, attemptIdentityHash: channelIdentity, inputHash: channelInputHash,
        generationSize, attemptNo: reclaimed?.attemptNo, leaseToken: `stale-${reclaimed?.leaseToken}`,
        gatewayConnectionId: connectionAId, gatewayConnectionVersion: 1,
        replacementGatewayConnectionId: connectionBId, replacementGatewayConnectionVersion: 1,
      });
    } catch (error) {
      staleProducerReplacementRejected = error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED";
    }
    const producerReplaced = await repository.replaceUnusableGenerationEvidence({
      ...scope, attemptIdentityHash: channelIdentity, inputHash: channelInputHash,
      generationSize, attemptNo: reclaimed?.attemptNo, leaseToken: reclaimed?.leaseToken,
      gatewayConnectionId: connectionAId, gatewayConnectionVersion: 1,
      replacementGatewayConnectionId: connectionBId, replacementGatewayConnectionVersion: 1,
    });
    const replacedProducerRow = (await client.query(
      `SELECT gateway_connection_id,gateway_connection_version,object_key,gateway_request_id,model_evidence
       FROM ai_generation_assets WHERE account_id=$1 AND attempt_identity_hash=$2`,
      [accountId, channelIdentity],
    )).rows[0];
    const channelRows = (await client.query(
      `SELECT attempt_no,status,lease_token,error_code FROM ai_generation_assets
       WHERE account_id=$1 AND attempt_identity_hash=$2`,
      [accountId, channelIdentity],
    )).rows;
    const memoryRepository = createMemoryGenerationAttemptRepository({
      token: (() => { let sequence = 0; return () => `memory-channel-${++sequence}`; })(),
      readItemState: async () => ({
        status: "GENERATING", statusVersion: scope.expectedStatusVersion, activeContentPlanId: scope.planId,
      }),
    });
    const memoryLease = await memoryRepository.reserveGenerationAttempt({
      ...scope, attemptIdentityHash: channelIdentity, generationSize, maxAttempts: 3,
      gatewayConnectionId: connectionAId, gatewayConnectionVersion: 1,
    });
    await memoryRepository.bindGenerationAttemptInput({
      ...scope, attemptIdentityHash: channelIdentity, inputHash: channelInputHash,
      generationSize, attemptNo: memoryLease.attemptNo, leaseToken: memoryLease.leaseToken,
      gatewayConnectionId: connectionAId, gatewayConnectionVersion: 1,
    });
    await memoryRepository.recordStoredGenerationAsset({
      ...scope, attemptIdentityHash: channelIdentity, inputHash: channelInputHash,
      generationSize, attemptNo: memoryLease.attemptNo, leaseToken: memoryLease.leaseToken,
      gatewayConnectionId: connectionAId, gatewayConnectionVersion: 1,
      ...channelStored,
    });
    const memoryReleased = await memoryRepository.releaseGenerationLease({
      ...scope, attemptIdentityHash: channelIdentity, inputHash: channelInputHash,
      generationSize, attemptNo: memoryLease.attemptNo, leaseToken: memoryLease.leaseToken,
      gatewayConnectionId: connectionAId, gatewayConnectionVersion: 1,
      errorCode: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED",
      role: "MAIN", profileId, profileVersion: 1, modelName: "image-a",
      gatewayRequestId: `channel-gateway-${suffix}`, checkerRequestId: `channel-checker-${suffix}`,
      modelEvidence: { requestedImageModel: "image-a" },
      checkerConnectionId: connectionBId, checkerConnectionVersion: 1,
    });
    const memoryReclaimed = await memoryRepository.reserveGenerationAttempt({
      ...scope, attemptIdentityHash: channelIdentity, generationSize, maxAttempts: 3,
      gatewayConnectionId: connectionBId, gatewayConnectionVersion: 1,
    });
    const memoryRebound = await memoryRepository.bindGenerationAttemptInput({
      ...scope, attemptIdentityHash: channelIdentity, inputHash: channelInputHash,
      generationSize, attemptNo: memoryReclaimed.attemptNo, leaseToken: memoryReclaimed.leaseToken,
      gatewayConnectionId: memoryReclaimed.gatewayConnectionId,
      gatewayConnectionVersion: memoryReclaimed.gatewayConnectionVersion,
    });
    const memoryProducerReplaced = await memoryRepository.replaceUnusableGenerationEvidence({
      ...scope, attemptIdentityHash: channelIdentity, inputHash: channelInputHash,
      generationSize, attemptNo: memoryReclaimed.attemptNo, leaseToken: memoryReclaimed.leaseToken,
      gatewayConnectionId: connectionAId, gatewayConnectionVersion: 1,
      replacementGatewayConnectionId: connectionBId, replacementGatewayConnectionVersion: 1,
    });
    const expectedChannelContract = {
      releasedStatus: "GENERATING", releasedAttemptNo: 1, reclaimedAttemptNo: 1,
      tokenChanged: true, recoveryObjectKey: channelStored.objectKey,
      recoveryGatewayRequestId: `channel-gateway-${suffix}`,
      recoveryGatewayConnectionId: connectionAId,
    };
    const memoryChannelContract = {
      releasedStatus: memoryReleased.status, releasedAttemptNo: memoryReleased.attemptNo,
      reclaimedAttemptNo: memoryReclaimed.attemptNo,
      tokenChanged: memoryReclaimed.leaseToken !== memoryLease.leaseToken,
      recoveryObjectKey: memoryRebound.recoveryRecord?.objectKey,
      recoveryGatewayRequestId: memoryRebound.recoveryRecord?.gatewayRequestId,
      recoveryGatewayConnectionId: memoryRebound.recoveryRecord?.gatewayConnectionId,
    };
    const postgresChannelContract = {
      releasedStatus: releasedBeforeReclaim[0]?.status,
      releasedAttemptNo: releasedBeforeReclaim[0]?.attempt_no,
      reclaimedAttemptNo: reclaimed?.attemptNo,
      tokenChanged: reclaimed?.leaseToken !== channelLease.leaseToken,
      recoveryObjectKey: rebound.recoveryRecord?.objectKey,
      recoveryGatewayRequestId: rebound.recoveryRecord?.gatewayRequestId,
      recoveryGatewayConnectionId: rebound.recoveryRecord?.gatewayConnectionId,
    };
    return {
      acceptedReplay: lease.status === "RESERVED" && bound.status === "BOUND"
        && accepted.status === "ACCEPTED" && replay.status === "EXISTING_ACCEPTED"
        && replay.record.id === accepted.id,
      abaFenced: true,
      staleBeforeAttempt: staleBeforeAttempt.status === "STALE" && inactivePlan.status === "STALE" && staleCount === 0,
      channelReclaimed: releasedBeforeReclaim.length === 1
        && releasedBeforeReclaim[0].attempt_no === 1
        && releasedBeforeReclaim[0].status === "GENERATING"
        && releasedBeforeReclaim[0].lease_token === "AUTO_LISTING_IMAGE_CHANNEL_RELEASED"
        && releasedBeforeReclaim[0].error_code === null
        && releasedBeforeReclaim[0].gateway_request_id === `channel-gateway-${suffix}`
        && releasedBeforeReclaim[0].gateway_connection_id === connectionAId
        && releasedBeforeReclaim[0].checker_connection_id === connectionBId
        && Number(releasedBeforeReclaim[0].checker_connection_version) === 1
        && releasedBeforeReclaim[0].object_key === channelStored.objectKey
        && reclaimed?.attemptNo === 1 && reclaimed.leaseToken !== channelLease.leaseToken
        && occupied?.status === "IN_PROGRESS" && channelRows.length === 1
        && channelRows[0].attempt_no === 1 && channelRows[0].status === "GENERATING"
        && channelRows[0].lease_token === reclaimed.leaseToken && channelRows[0].error_code === null,
      storedImageReusable: rebound.status === "BOUND"
        && rebound.recoveryRecord?.objectKey === channelStored.objectKey
        && rebound.recoveryRecord?.gatewayRequestId === `channel-gateway-${suffix}`,
      memoryPostgresChannelParity: JSON.stringify(memoryChannelContract) === JSON.stringify(expectedChannelContract)
        && JSON.stringify(postgresChannelContract) === JSON.stringify(expectedChannelContract),
      storedEvidenceCompensated: retainedAfterStaleCompensation === channelStored.objectKey
        && compensated.disposition === "REVERTED"
        && clearedAfterCompensation.object_key === null
        && clearedAfterCompensation.content_hash === null,
      producerReplacementFenced: staleProducerReplacementRejected
        && producerReplaced.gatewayConnectionId === connectionBId
        && memoryProducerReplaced.gatewayConnectionId === connectionBId
        && replacedProducerRow.gateway_connection_id === connectionBId
        && replacedProducerRow.object_key === null
        && replacedProducerRow.gateway_request_id === null
        && replacedProducerRow.model_evidence === null,
      checkerProvenanceParity: memoryReleased.checkerConnectionId === connectionBId
        && memoryReleased.checkerConnectionVersion === 1
        && releasedBeforeReclaim[0].checker_connection_id === connectionBId
        && Number(releasedBeforeReclaim[0].checker_connection_version) === 1,
    };
  } finally {
    try { await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); } catch {}
    client.release();
    await pool.end();
  }
}

async function assertReleaseRejected(repository, input) {
  try {
    await repository.releaseGenerationLease(input);
  } catch (error) {
    if (error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED") return;
    throw error;
  }
  throw new Error("stale channel release unexpectedly succeeded");
}

async function assertCompensationRejected(repository, input) {
  try {
    await repository.revertStoredGenerationAsset(input);
  } catch (error) {
    if (error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED") return;
    throw error;
  }
  throw new Error("stale stored-evidence compensation unexpectedly succeeded");
}
