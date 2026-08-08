import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { freezeAutoListingListingBase } from "../auto-listing-overlay.mjs";
import { createPostgresAutoListingUploadRepository } from "../auto-listing-upload-postgres.mjs";
import { createPostgresListingAssetPublicationRepository } from "../listing-asset-publication-postgres.mjs";

const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1"
  && Boolean(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const H = (character) => character.repeat(64);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

const publicationPolicy = Object.freeze({
  origin: "https://cdn.example.com", baseUrl: "https://cdn.example.com/",
  prefix: "listing-media/v1", publicationVersion: "LISTING_MEDIA_V1",
});

function listingVariant() {
  return {
    offer_id: "offer-a", name: "Product A", price: "100.00", currency_code: "RUB",
    description_category_id: 17028702, type_id: 92576,
    weight: 500, weight_unit: "g", depth: 200, width: 100, height: 50,
    dimension_unit: "mm", images: ["https://source.example/a.jpg"],
    primary_image: "https://source.example/a.jpg",
    attributes: [{ complex_id: 0, id: 85, values: [{ value: "Brand" }] }],
  };
}

test("PostgreSQL claims one local warehouse item, safely retries the same link, and binds one standard job", {
  skip: !enabled,
  timeout: 60_000,
}, async () => {
  const { Pool } = await import("pg");
  const adminPool = new Pool({ connectionString, max: 2 });
  const admin = await adminPool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `auto_listing_upload_${suffix}`;
  const ids = Object.fromEntries([
    "account", "store", "warehouseLocal", "product", "strategy", "snapshot", "collect",
    "draft", "policy", "job", "item", "profile", "plan", "listingBase", "submissionSnapshot",
    "submissionJob", "healthInitial", "healthRetry", "healthWrongVersion", "accountOther", "healthOther",
  ].map((key) => [key, `${key}-${suffix}`]));
  const warehousePlatformId = `platform-${suffix}`;
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await admin.query(`SET search_path TO ${quote(schema)}, public`);
    for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort()) {
      await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }
    pool = new Pool({ connectionString, max: 6, options: `-c search_path=${schema},public` });

    await admin.query("INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
      [ids.account, `user-${suffix}`]);
    await admin.query("INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
      [ids.accountOther, `other-${suffix}`]);
    await admin.query("INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,'Store','Store',$2,'active',$3)",
      [ids.store, `client-${suffix}`, ids.account]);
    await admin.query(`INSERT INTO store_credentials
      (store_id,client_id,encrypted_api_key,iv,auth_tag,algorithm,key_version)
      VALUES ($1,$2,'cipher','iv','tag','aes-256-gcm','v1')`, [ids.store, `client-${suffix}`]);
    await admin.query(`INSERT INTO warehouses
      (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
      VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)`, [ids.warehouseLocal, ids.store, warehousePlatformId]);
    await admin.query("INSERT INTO products (id,store_id,product_id,sku,status,is_archived) VALUES ($1,$2,$3,'sku-a','active',FALSE)",
      [ids.product, ids.store, `product-${suffix}`]);
    await admin.query("INSERT INTO product_stocks (product_id,warehouse_id,store_id,sku,source,present,reserved) VALUES ($1,$2,$3,'sku-a','fbs',5,0)",
      [ids.product, ids.warehouseLocal, ids.store]);
    await admin.query("INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary) VALUES ($1,$2,'test',$3,'sku-a','{}'::jsonb)",
      [ids.collect, ids.account, `identity-${suffix}`]);
    await admin.query(`INSERT INTO product_drafts
      (id,collect_item_id,version,data_hash,data,normalizer_version,category_rule_version,dictionary_version)
      VALUES ($1,$2,4,$3,$4::jsonb,'v3','cat-v1','dict-v1')`,
      [ids.draft, ids.collect, H("a"), JSON.stringify({ variants: [{ sourceCategory: { descriptionCategoryId: 17028702 } }] })]);
    await admin.query("UPDATE collect_items SET current_draft_id=$1 WHERE id=$2", [ids.draft, ids.collect]);
    await admin.query(`INSERT INTO ai_content_strategy_versions
      (id,account_id,strategy_key,version,status,content,content_hash)
      VALUES ($1,$2,'default',1,'PUBLISHED','{}'::jsonb,$3)`, [ids.strategy, ids.account, H("1")]);
    await admin.query(`INSERT INTO auto_listing_source_snapshots
      (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash)
      VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::jsonb,$4)`, [ids.snapshot, ids.account, ids.collect, H("b")]);
    const frozenConfig = normalizeAndHashAutoListingConfig({
      targetStoreId: ids.store, targetWarehouseId: ids.warehouseLocal, stock: 5,
      priceAdjustmentKopecks: "0",
      image: { ratio: "3:4", resolution: "1K", quality: "Medium", language: "ru",
        roles: { main: 1, sellingPoint: 2, detail: 1, scene: 1, specification: 0, infographic: 1 } },
    });
    await admin.query(`INSERT INTO auto_listing_upload_policy_versions
      (id,account_id,mode,enabled,version,publication_reason,created_by,published_by,published_at,
       publication_origin,publication_base_url,publication_prefix,publication_version,publication_policy_hash)
      VALUES ($1,$2,'DIRECT',TRUE,1,'integration',$2,$2,NOW(),$3,$4,$5,$6,$7)`,
      [ids.policy, ids.account, publicationPolicy.origin, publicationPolicy.baseUrl, publicationPolicy.prefix,
        publicationPolicy.publicationVersion, digest(publicationPolicy)]);
    const healthEvidence = JSON.stringify({ probeKind: "PUBLIC_READBACK", httpStatus: 200,
      contentTypeMatched: true, bytesMatched: true });
    await admin.query(`INSERT INTO auto_listing_asset_publication_health_evidence
      (id,account_id,publication_version,public_base_url,public_prefix,outcome,evidence,
       checked_by_account_id,checked_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,'PASSED',$6::jsonb,$2,NOW(),NOW()+INTERVAL '10 minutes'),
        ($7,$2,'WRONG_VERSION',$4,$5,'PASSED',$6::jsonb,$2,NOW(),NOW()+INTERVAL '10 minutes'),
        ($8,$9,$3,$4,$5,'PASSED',$6::jsonb,$9,NOW(),NOW()+INTERVAL '10 minutes')`,
      [ids.healthInitial, ids.account, publicationPolicy.publicationVersion, publicationPolicy.baseUrl,
        publicationPolicy.prefix, healthEvidence, ids.healthWrongVersion, ids.healthOther, ids.accountOther]);
    await admin.query(`INSERT INTO auto_listing_jobs
      (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,strategy_version_id,
       upload_policy_version_id,created_by,correlation_id)
      VALUES ($1,$2,'COLLECT_BOX','CREATED',$3,$4::jsonb,$5,$6,$7,$2,$8)`,
      [ids.job, ids.account, `job-${suffix}`, JSON.stringify(frozenConfig.config), frozenConfig.configHash,
        ids.strategy, ids.policy, `corr-${suffix}`]);
    await admin.query(`INSERT INTO auto_listing_job_items
      (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version)
      VALUES ($1,$2,$3,$4,$5,$6,'UPLOAD_QUEUED',7)`,
      [ids.item, ids.job, ids.account, ids.snapshot, ids.store, ids.warehouseLocal]);
    await admin.query(`INSERT INTO ai_gateway_profiles
      (id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,text_model,image_model,config_version)
      VALUES ($1,$2,'Profile','https://gateway.invalid','TEST_AI_KEY','SUB2API_RESPONSES',
        'SUB2API_OPENAI_IMAGES','text','image',1)`, [ids.profile, ids.account]);

    const slots = [
      ["main-1", "MAIN"], ["sell-1", "SELLING_POINT"], ["sell-2", "SELLING_POINT"],
      ["detail-1", "DETAIL"], ["scene-1", "SCENE"], ["info-1", "INFOGRAPHIC"],
    ].map(([slotKey, role], index) => ({ slotKey, visualGroupKey: "group-a", role, order: index + 1 }));
    const visualGroups = { sourceHash: H("4"), reasonCodes: [], visualGroupsHash: H("5"), groups: [{
      visualGroupKey: "group-a", sourceSkus: ["sku-a"], variantIds: ["variant-a"], factEvidence: [],
      reasonCodes: [], referenceImages: [],
    }] };
    await admin.query(`INSERT INTO ai_content_plans
      (id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
       strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,prompt_template_version,
       plan,plan_hash,visual_groups_hash,visual_groups,fact_registry,fact_registry_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'text',1,'plan-v1',$12::jsonb,$13,$14,$15::jsonb,$16::jsonb,$17)`,
      [ids.plan, ids.account, ids.job, ids.item, ids.snapshot, ids.strategy, ids.profile, H("6"),
        frozenConfig.configHash, H("b"), H("7"), JSON.stringify({ slots }), H("8"), H("5"),
        JSON.stringify(visualGroups), JSON.stringify([{ factId: "fact-a", kind: "IDENTITY_NAME",
          value: "Product A", sourcePath: "identity.name", visualGroupKeys: ["group-a"] }]), H("9")]);
    await admin.query("UPDATE auto_listing_job_items SET active_content_plan_id=$1 WHERE account_id=$2 AND id=$3",
      [ids.plan, ids.account, ids.item]);

    const pricing = { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" };
    const listingBase = freezeAutoListingListingBase({
      accountId: ids.account, jobId: ids.job, itemId: ids.item, sourceSnapshotId: ids.snapshot,
      collectItemId: ids.collect, targetStoreId: ids.store,
      productDraft: { id: ids.draft, version: 4, dataHash: H("a") },
      pricingEvidence: { ...pricing, evidenceHash: digest(pricing) }, richContentAttributeSupported: true,
      variants: [{ sourceVariantId: "variant-a", sourceSku: "sku-a", item: listingVariant() }],
      versions: { normalizerVersion: "v3", categoryRuleVersion: "cat-v1", dictionaryVersion: "dict-v1" },
    });
    await admin.query(`INSERT INTO auto_listing_listing_bases
      (id,account_id,job_id,item_id,source_snapshot_id,collect_item_id,target_store_id,product_draft_id,
       product_draft_version,product_draft_data_hash,ozon_ready_variants,pricing_evidence,
       rich_content_attribute_supported,listing_base_version,canonical_hash,normalizer_version,
       category_rule_version,dictionary_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,4,$9,$10::jsonb,$11::jsonb,TRUE,$12,$13,$14,$15,$16)`,
      [ids.listingBase, ids.account, ids.job, ids.item, ids.snapshot, ids.collect, ids.store, ids.draft,
        H("a"), JSON.stringify(listingBase.variants), JSON.stringify(listingBase.pricingEvidence),
        listingBase.version, listingBase.canonicalHash, listingBase.versions.normalizerVersion,
        listingBase.versions.categoryRuleVersion, listingBase.versions.dictionaryVersion]);

    const publicationRepository = createPostgresListingAssetPublicationRepository({ pool });
    const published = [];
    for (const [index, slot] of slots.entries()) {
      const assetId = `asset-${index + 1}-${suffix}`;
      const inputHash = digest(`input-${index}`);
      const contentHash = digest(`content-${index}`);
      const attemptIdentityHash = digest(`attempt-${index}`);
      const objectKey = buildGeneratedAssetObjectKey({ accountId: ids.account, jobId: ids.job,
        itemId: ids.item, planId: ids.plan, visualGroupKey: "group-a", slotKey: slot.slotKey,
        attemptIdentityHash, attemptNo: 1, inputHash, contentHash });
      await admin.query(`INSERT INTO ai_generation_assets
        (id,account_id,job_id,item_id,plan_id,profile_id,visual_group_key,slot_key,role,input_hash,
         attempt_no,status,gateway_request_id,model_name,profile_version,prompt_hash,object_key,content_hash,
         content_type,width,height,checker_result,accepted_at,plan_hash,source_hash,strategy_hash,config_hash,
         visual_groups_hash,prompt_template_version,source_asset_evidence,checker_request_id,model_evidence,
         size_bytes,attempt_identity_hash,generation_size,final_input_bound_at,object_key_version,expected_status_version)
        VALUES ($1,$2,$3,$4,$5,$6,'group-a',$7,$8,$9,1,'ACCEPTED',$10,'image',1,$11,$12,$13,
          'image/png',768,1024,'{"accepted":true}'::jsonb,NOW(),$11,$11,$11,$11,$11,'image-v1',$14::jsonb,$15,
          '{"model":"image"}'::jsonb,1024,$16,'768x1024',NOW(),'ATTEMPT_V2',7)`,
        [assetId, ids.account, ids.job, ids.item, ids.plan, ids.profile, slot.slotKey, slot.role, inputHash,
          `gateway-${index}-${suffix}`, H("c"), objectKey, contentHash,
          JSON.stringify([{ assetId: "source-a", contentHash: H("d"), contentType: "image/png", width: 1, height: 1, size: 1 }]),
          `checker-${index}-${suffix}`, attemptIdentityHash]);
      published.push(await publicationRepository.recordPublication({
        accountId: ids.account, jobId: ids.job, itemId: ids.item, planId: ids.plan, assetId,
        publicObjectKey: `${publicationPolicy.prefix}/${contentHash.slice(0, 2)}/${contentHash}.png`,
        publishedUrl: `${publicationPolicy.baseUrl}${publicationPolicy.prefix}/${contentHash.slice(0, 2)}/${contentHash}.png`,
        publicationVersion: publicationPolicy.publicationVersion, publicBaseUrl: publicationPolicy.baseUrl,
        publicPrefix: publicationPolicy.prefix, publishedByAccountId: ids.account,
      }));
    }

    const repository = createPostgresAutoListingUploadRepository({ pool });
    const context = await repository.loadUploadEvidence({ accountId: ids.account, itemId: ids.item });
    assert.equal(context.item.targetWarehouseId, ids.warehouseLocal);
    assert.equal(context.targetWarehousePlatformId, warehousePlatformId);
    assert.equal(context.acceptedAssets.length, 6);
    const publishedById = new Map(published.map((asset) => [asset.assetId, asset]));
    const mediaEvidenceHash = digest({
      visualGroups: context.visualGroups,
      assets: context.acceptedAssets.map(({ assetId }) => publishedById.get(assetId)).map((asset) => ({ assetId: asset.assetId, accountId: asset.accountId,
        jobId: asset.jobId, itemId: asset.itemId, planId: asset.planId,
        visualGroupKey: asset.visualGroupKey, slotKey: asset.slotKey, role: asset.role,
        status: asset.status, contentHash: asset.contentHash, width: asset.width, height: asset.height,
        publishedUrl: asset.publishedUrl, publicationVersion: asset.publicationVersion })),
      rich: [], publicationPolicy,
    });
    const reserveInput = {
      accountId: ids.account, itemId: ids.item, expectedStatusVersion: 7, action: "DIRECT_UPLOAD",
      correlationId: `corr-${suffix}`, jobId: ids.job, listingBaseId: ids.listingBase,
      activePlanId: ids.plan, targetStoreId: ids.store, targetWarehouseId: ids.warehouseLocal,
      targetWarehousePlatformId: warehousePlatformId, sourceHash: H("b"), configHash: frozenConfig.configHash,
      requestHash: H("e"), resultHash: H("f"), uploadPolicyVersionId: ids.policy,
      publicationPolicy, publicationPolicyHash: digest(publicationPolicy), mediaEvidenceHash,
      productDraft: { id: ids.draft, version: 4, dataHash: H("a") },
      directHealthEvidenceId: ids.healthInitial,
      idempotencyKey: `auto-listing:${ids.item}:${H("f")}`,
    };
    await assert.rejects(repository.reserveSubmission({ ...reserveInput,
      directHealthEvidenceId: ids.healthWrongVersion }), { code: "AUTO_LISTING_UPLOAD_CONFLICT" });
    await assert.rejects(repository.reserveSubmission({ ...reserveInput,
      directHealthEvidenceId: ids.healthOther }), { code: "AUTO_LISTING_UPLOAD_CONFLICT" });
    const concurrent = await Promise.allSettled([
      repository.reserveSubmission(reserveInput), repository.reserveSubmission(reserveInput),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 2,
      JSON.stringify(concurrent.map((result) => result.status === "fulfilled" ? result.value : {
        code: result.reason?.code, message: result.reason?.message,
      })));
    assert.equal(concurrent.filter((result) => result.status === "fulfilled"
      && result.value.claimOwned === true).length, 1);
    let reservation = concurrent.find((result) => result.status === "fulfilled" && result.value.claimOwned).value;
    assert.equal(reservation.claimOwned, true);
    assert.equal(reservation.directHealthEvidenceId, ids.healthInitial);
    assert.ok(reservation.claimToken);
    assert.deepEqual((await pool.query(
      "SELECT status,status_version FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
      [ids.account, ids.item],
    )).rows[0], { status: "UPLOADING", status_version: 8 });
    assert.equal(Number((await pool.query(
      "SELECT COUNT(*)::int AS count FROM auto_listing_submission_links WHERE account_id=$1 AND auto_listing_item_id=$2",
      [ids.account, ids.item],
    )).rows[0].count), 1);

    // Simulate a process dying after the immutable link and UPLOADING transition,
    // but before the standard submission is created. Only one restarted worker
    // may atomically take over the database-expired claim.
    await pool.query(
      `UPDATE auto_listing_submission_links SET claim_expires_at=NOW()-INTERVAL '1 second'
        WHERE account_id=$1 AND id=$2`, [ids.account, reservation.id],
    );
    const takeover = await Promise.all([
      repository.reserveSubmission(reserveInput), repository.reserveSubmission(reserveInput),
    ]);
    assert.equal(takeover.filter((entry) => entry.claimOwned).length, 1);
    assert.equal(new Set(takeover.map((entry) => entry.id)).size, 1);
    reservation = takeover.find((entry) => entry.claimOwned);
    assert.equal(reservation.attemptGeneration, 2);
    assert.deepEqual((await pool.query(
      "SELECT status,status_version FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
      [ids.account, ids.item],
    )).rows[0], { status: "UPLOADING", status_version: 8 });

    const failedAttempt = { accountId: ids.account, jobId: ids.job, itemId: ids.item,
      submissionLinkId: reservation.id, actorAccountId: ids.account, action: "DIRECT_UPLOAD",
      expectedStatusVersion: 7, targetStoreId: ids.store, targetWarehouseId: ids.warehouseLocal,
      productDraftHash: H("a"), requestHash: H("e"), resultHash: H("f"), outcome: "FAILED",
      directHealthEvidenceId: ids.healthInitial,
      errorCode: "AUTO_LISTING_SOURCE_DRAFT_CHANGED", errorSafe: "not submitted",
      correlationId: `retry-release-${suffix}`, responseSummary: {} };
    const released = await repository.releaseSubmissionForRetry({ accountId: ids.account, itemId: ids.item,
      linkId: reservation.id, claimToken: reservation.claimToken, correlationId: `retry-release-${suffix}`,
      attempt: failedAttempt });
    assert.deepEqual(released, { status: "UPLOAD_QUEUED", statusVersion: 9 });
    assert.deepEqual((await pool.query(
      "SELECT status,status_version FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
      [ids.account, ids.item],
    )).rows[0], { status: "UPLOAD_QUEUED", status_version: 9 });
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM auto_listing_upload_tasks
        WHERE account_id=$1 AND item_id=$2 AND expected_status_version=9 AND enqueue_reason='SAFE_RETRY'`,
      [ids.account, ids.item],
    )).rows[0].count), 1);
    await assert.rejects(repository.reserveSubmission({ ...reserveInput, expectedStatusVersion: 9,
      correlationId: `retry-wrong-${suffix}`, idempotencyKey: `wrong:${ids.item}` }), {
      code: "AUTO_LISTING_UPLOAD_CONFLICT",
    });
    await admin.query(`INSERT INTO auto_listing_asset_publication_health_evidence
      (id,account_id,publication_version,public_base_url,public_prefix,outcome,evidence,
       checked_by_account_id,checked_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,'PASSED',$6::jsonb,$2,NOW(),NOW()+INTERVAL '10 minutes')`,
      [ids.healthRetry, ids.account, publicationPolicy.publicationVersion, publicationPolicy.baseUrl,
        publicationPolicy.prefix, healthEvidence]);
    await assert.rejects(pool.query(
      "UPDATE auto_listing_submission_links SET direct_health_evidence_id=$3 WHERE account_id=$1 AND id=$2",
      [ids.account, reservation.id, ids.healthRetry],
    ), (error) => error?.code === "23514");
    reservation = await repository.reserveSubmission({ ...reserveInput, expectedStatusVersion: 9,
      correlationId: `retry-reserve-${suffix}`, directHealthEvidenceId: ids.healthRetry });
    assert.equal(reservation.claimOwned, true);
    assert.equal(reservation.directHealthEvidenceId, ids.healthInitial);
    assert.equal(reservation.attemptGeneration, 3);
    assert.deepEqual((await pool.query(
      "SELECT status,status_version FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
      [ids.account, ids.item],
    )).rows[0], { status: "UPLOADING", status_version: 10 });

    await admin.query(`INSERT INTO submission_snapshots
      (id,collect_item_id,draft_id,draft_version,account_id,store_id,idempotency_key,snapshot_hash,item_count,items,stocks)
      VALUES ($1,$2,$3,4,$4,$5,$6,$7,1,$8::jsonb,$9::jsonb)`,
      [ids.submissionSnapshot, ids.collect, ids.draft, ids.account, ids.store,
        `snapshot-${suffix}`, H("0"), JSON.stringify([listingVariant()]),
        JSON.stringify([{ offer_id: "offer-a", warehouse_id: warehousePlatformId, stock: 5 }])]);
    await admin.query(`INSERT INTO submission_jobs
      (id,snapshot_id,collect_item_id,account_id,store_id,type,status,correlation_id,item_count)
      VALUES ($1,$2,$3,$4,$5,'AUTO_LISTING','QUEUE_PENDING',$6,1)`,
      [ids.submissionJob, ids.submissionSnapshot, ids.collect, ids.account, ids.store, `submission-${suffix}`]);
    const attempt = { accountId: ids.account, jobId: ids.job, itemId: ids.item,
      submissionLinkId: reservation.id, actorAccountId: ids.account, action: "DIRECT_UPLOAD",
      expectedStatusVersion: 9, targetStoreId: ids.store, targetWarehouseId: ids.warehouseLocal,
      productDraftHash: H("a"), requestHash: H("e"), resultHash: H("f"), outcome: "SUCCEEDED",
      directHealthEvidenceId: ids.healthRetry,
      errorCode: null, errorSafe: null, correlationId: `corr-${suffix}`,
      responseSummary: { submissionJobId: ids.submissionJob, submissionSnapshotId: ids.submissionSnapshot },
    };
    await assert.rejects(repository.bindSubmission({ accountId: ids.account, itemId: ids.item,
      linkId: reservation.id, claimToken: `stale-${suffix}`, submissionJobId: ids.submissionJob,
      submissionSnapshotId: ids.submissionSnapshot, attempt }), { code: "AUTO_LISTING_UPLOAD_CONFLICT" });
    const bound = await repository.bindSubmission({ accountId: ids.account, itemId: ids.item,
      linkId: reservation.id, claimToken: reservation.claimToken, submissionJobId: ids.submissionJob,
      submissionSnapshotId: ids.submissionSnapshot, attempt });
    assert.equal(bound.status, "SUBMITTED");
    const replay = await repository.bindSubmission({ accountId: ids.account, itemId: ids.item,
      linkId: reservation.id, claimToken: reservation.claimToken, submissionJobId: ids.submissionJob,
      submissionSnapshotId: ids.submissionSnapshot, attempt });
    assert.equal(replay.submissionJobId, ids.submissionJob);
    assert.deepEqual((await pool.query(
      `SELECT expected_item_version,direct_health_evidence_id FROM auto_listing_upload_attempts
        WHERE account_id=$1 AND submission_link_id=$2 ORDER BY expected_item_version`,
      [ids.account, reservation.id],
    )).rows.map((row) => [Number(row.expected_item_version), row.direct_health_evidence_id]), [
      [7, ids.healthInitial], [9, ids.healthRetry],
    ]);
    assert.deepEqual((await pool.query(
      `SELECT state,submission_job_id FROM auto_listing_submission_reconcile_tasks
        WHERE account_id=$1 AND submission_link_id=$2`,
      [ids.account, reservation.id],
    )).rows[0], { state: "PENDING", submission_job_id: ids.submissionJob });
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM auto_listing_submission_reconcile_events e
        JOIN auto_listing_submission_reconcile_tasks t
          ON t.account_id=e.account_id AND t.id=e.reconcile_task_id
       WHERE t.account_id=$1 AND t.submission_link_id=$2 AND e.event_type='CREATED'`,
      [ids.account, reservation.id],
    )).rows[0].count), 1);
  } finally {
    await pool?.end();
    try {
      await admin.query("SET search_path TO public");
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    } finally {
      admin.release();
      await adminPool.end();
    }
  }
});
