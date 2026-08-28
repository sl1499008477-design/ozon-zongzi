import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAutoListingAiAdminPostgres } from "../auto-listing-ai-admin-postgres.mjs";
import { createAutoListingAiAdminService } from "../auto-listing-ai-admin-service.mjs";
import { createAutoListingCategoryStrategyPostgres } from "../auto-listing-category-strategy-postgres.mjs";
import { createAutoListingCategoryStrategyService } from "../auto-listing-category-strategy-service.mjs";
import { createPostgresAccountSharedOzonCategoryRepository }
  from "../account-shared-ozon-category-repository.mjs";
import { createAiGatewayProfileService } from "../ai-gateway-profile-service.mjs";
import { createAutoListingAiCapabilityCredentialResolver } from "../auto-listing-ai-credential-resolver.mjs";
import { createAutoListingAiSettingsPostgres } from "../auto-listing-ai-settings-postgres.mjs";
import { createSub2ApiAdapter } from "../sub2api-ai-adapter.mjs";

const connectionString = process.env.TEST_DATABASE_URL || process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = (process.env.AUTO_LISTING_POSTGRES_TESTS === "1"
  || process.env.AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS === "1") && Boolean(connectionString);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const requestKeyFor = (attemptId) => crypto.createHash("sha256")
  .update(`integration-capability\0${attemptId}`).digest("hex");

const profile = (displayName) => ({
  displayName,
  baseUrl: "https://gateway.example.test/v1",
  apiKeyEnvName: `SUB2API_${displayName.toUpperCase()}_KEY`,
  textProtocol: "SUB2API_RESPONSES",
  imageProtocol: "SUB2API_OPENAI_IMAGES",
  textModel: "text-model",
  imageModel: "image-model",
  configVersion: 1,
});

const strategyRules = (ruleId) => [{
  ruleId,
  ruleOrder: 1,
  matchType: "PRODUCT_STYLE",
  productStyle: "GENERAL",
  style: "BALANCED_DEFAULT",
  textDensityByRole: { MAIN: "NONE", SELLING_POINT: "LIGHT" },
}];

const categoryGuidance = (label) => ({
  overallStyle: `Чистый коммерческий каталог ${label}`,
  prohibitedPatterns: [`Не копировать брендинг конкурентов ${label}`],
  roles: Object.fromEntries([
    "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
  ].map((role) => [role, {
    composition: `Товар находится в центре кадра ${label} ${role}`,
    background: `Нейтральный светлый фон ${label} ${role}`,
    textDensity: role === "MAIN" ? "NONE" : "LIGHT",
    layout: `Чёткая визуальная иерархия ${label} ${role}`,
  }])),
});

async function seedPublishableCategoryDraft(client, { accountId, suffix, descriptionCategoryId, typeId,
  sourceDescriptionCategoryId = descriptionCategoryId, sourceTypeId = typeId }) {
  const collectItemId = `category-source-${suffix}`;
  const productDraftId = `category-product-draft-${suffix}`;
  const rawId = `category-raw-${suffix}`;
  const evidenceId = `category-evidence-${suffix}`;
  const draftId = `category-strategy-draft-${suffix}`;
  const sessionId = `category-session-${suffix}`;
  const sampleSetId = `category-sample-set-${suffix}`;
  const attemptId = `category-attempt-${suffix}`;
  const resultId = `category-result-${suffix}`;
  const sampleSetHash = crypto.createHash("sha256").update(`sample-set-${suffix}`).digest("hex");
  const h = (value) => crypto.createHash("sha256").update(value).digest("hex");
  await client.query(
    "INSERT INTO collect_items (id,account_id,status,source_sku,source_url) VALUES ($1,$2,'COLLECTED',$3,$4)",
    [collectItemId, accountId, `category-sku-${suffix}`, `https://www.ozon.ru/product/${suffix}`],
  );
  await client.query(
    `INSERT INTO collect_raw_payloads
       (id,collect_item_id,account_id,source_sku,source_url,payload_hash,collector_version,payload,collected_at)
     VALUES ($1,$2,$3,$4,$5,$6,'test','{}'::JSONB,NOW())`,
    [rawId, collectItemId, accountId, `category-sku-${suffix}`,
      `https://www.ozon.ru/product/${suffix}`, h(rawId)],
  );
  await client.query(
    "INSERT INTO product_drafts (id,collect_item_id,version,data_hash,data) VALUES ($1,$2,7,$3,'{}'::JSONB)",
    [productDraftId, collectItemId, h(productDraftId)],
  );
  await client.query(
    `INSERT INTO product_draft_revisions
       (id,draft_id,version,data_hash,data,changed_by,change_reason)
     VALUES ($1,$2,7,$3,'{}'::JSONB,$4,'category strategy integration seed')`,
    [`category-product-revision-${suffix}`, productDraftId, h(productDraftId), accountId],
  );
  await client.query("UPDATE collect_items SET current_draft_id=$2 WHERE account_id=$1 AND id=$3", [
    accountId, productDraftId, collectItemId,
  ]);
  await client.query(
    `INSERT INTO collect_ozon_category_source_evidence
       (id,account_id,source_kind,source_record_id,source_version,collect_item_id,product_draft_id,
        source_description_category_id,source_type_id,taxonomy_scope,captured_at,raw_response_hash,
        raw_response_ref,product_raw_response_ref,provenance)
     VALUES ($1,$2,'PRODUCT_DRAFT',$3,'7',$4,$3,$5,$6,'OZON:DEFAULT',NOW(),$7,$8,$8,'{}'::JSONB)`,
    [evidenceId, accountId, productDraftId, collectItemId,
      sourceDescriptionCategoryId, sourceTypeId, h(rawId), rawId],
  );
  await client.query(
    `INSERT INTO collect_ozon_category_current_sources
       (account_id,collect_item_id,source_evidence_id,source_kind,source_record_id,source_version)
     VALUES ($1,$2,$3,'PRODUCT_DRAFT',$4,'7')`,
    [accountId, collectItemId, evidenceId, productDraftId],
  );
  await client.query(
    `INSERT INTO account_ozon_shared_categories
       (id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
        current_description_category_id,current_type_id,status,source,version,source_evidence_id,validated_at)
     VALUES ($1,$2,$3,$4,'OZON:DEFAULT',$3,$4,'ACTIVE','SOURCE_DIRECT',1,$5,NOW())`,
    [`category-shared-${suffix}`, accountId, sourceDescriptionCategoryId, sourceTypeId, evidenceId],
  );
  if (sourceDescriptionCategoryId !== descriptionCategoryId || sourceTypeId !== typeId) {
    await client.query(
      `UPDATE account_ozon_shared_categories
          SET current_description_category_id=$3,current_type_id=$4,source='OZON_REFRESH',
              taxonomy_fingerprint=$5,validated_at=NOW(),version=version+1,
              updated_at=GREATEST(NOW(),updated_at+INTERVAL '1 millisecond')
        WHERE account_id=$1 AND id=$2`,
      [accountId, `category-shared-${suffix}`, descriptionCategoryId, typeId,
        h(`taxonomy-${suffix}`)],
    );
  }
  await client.query(
    `INSERT INTO auto_listing_category_strategy_drafts
       (id,account_id,taxonomy_scope,description_category_id,type_id,draft_version,status,
        source_collect_item_id,source_product_draft_id,source_product_draft_version,expected_source_version,
        idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,'OZON:DEFAULT',$3,$4,4,'DRAFT_READY',$5,$6,7,'draft:7',$7,$8,$9,$2)`,
    [draftId, accountId, descriptionCategoryId, typeId, collectItemId, productDraftId,
      `seed-draft-${suffix}`, `seed-draft-corr-${suffix}`, h(`seed-draft-${suffix}`)],
  );
  await client.query(
    `INSERT INTO auto_listing_category_strategy_sampling_sessions
       (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,session_secret_hash,
        idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,$3,'OZON:DEFAULT',$4,$5,$6,$7,$8,$9,$2)`,
    [sessionId, accountId, draftId, descriptionCategoryId, typeId, h(`secret-${suffix}`),
      `seed-session-${suffix}`, `seed-session-corr-${suffix}`, h(`seed-session-${suffix}`)],
  );
  await client.query(
    "ALTER TABLE auto_listing_category_strategy_sample_sets DISABLE TRIGGER auto_listing_category_strategy_sample_set_integrity",
  );
  await client.query(
    `INSERT INTO auto_listing_category_strategy_sample_sets
       (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,session_id,status,
        sample_set_hash,sample_count,sealed_at,idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,$3,'OZON:DEFAULT',$4,$5,$6,'SEALED',$7,5,NOW(),$8,$9,$10,$2)`,
    [sampleSetId, accountId, draftId, descriptionCategoryId, typeId, sessionId, sampleSetHash,
      `seed-set-${suffix}`, `seed-set-corr-${suffix}`, h(`seed-set-${suffix}`)],
  );
  await client.query(
    "ALTER TABLE auto_listing_category_strategy_sample_sets ENABLE TRIGGER auto_listing_category_strategy_sample_set_integrity",
  );
  await client.query(
    `INSERT INTO auto_listing_category_strategy_analysis_attempts
       (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_set_hash,
        analysis_input_hash,model_config_snapshot,model_config_hash,cost_confirmed,
        idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,$3,'OZON:DEFAULT',$4,$5,$6,$7,$8,'{"model":"test"}'::JSONB,$9,TRUE,$10,$11,$12,$2)`,
    [attemptId, accountId, draftId, descriptionCategoryId, typeId, sampleSetId, sampleSetHash,
      h(`analysis-input-${suffix}`), h(`model-${suffix}`), `seed-attempt-${suffix}`,
      `seed-attempt-corr-${suffix}`, h(`seed-attempt-${suffix}`)],
  );
  const guidance = categoryGuidance(suffix);
  await client.query(
    `INSERT INTO auto_listing_category_strategy_analysis_results
       (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,
        sample_set_hash,analysis_input_hash,raw_response,raw_response_hash,guidance,guidance_hash,
        idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,$3,'OZON:DEFAULT',$4,$5,$6,$7,$8,$9,'{"outcome":"accepted"}'::JSONB,$10,
       $11::JSONB,$12,$13,$14,$15,$2)`,
    [resultId, accountId, draftId, descriptionCategoryId, typeId, attemptId, sampleSetId, sampleSetHash,
      h(`analysis-input-${suffix}`), h(`raw-${suffix}`), JSON.stringify(guidance), h(JSON.stringify(guidance)),
      `seed-result-${suffix}`, `seed-result-corr-${suffix}`, h(`seed-result-${suffix}`)],
  );
  await client.query(
    `INSERT INTO auto_listing_category_strategy_events
       (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,event_type,event_payload,
        idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,$3,'OZON:DEFAULT',$4,$5,'DRAFT_EVENT',$6::JSONB,$7,$8,$9,$2)`,
    [`seed-result-event-${suffix}`, accountId, draftId, descriptionCategoryId, typeId,
      JSON.stringify({ event: "ANALYSIS_RESULT_RECORDED", draftVersion: 4, status: "DRAFT_READY",
        attemptId, resultId }), `seed-result-event-key-${suffix}`, `seed-result-event-corr-${suffix}`,
      h(`seed-result-event-${suffix}`)],
  );
  return { draftId, sampleSetHash, attemptId, resultId, guidance, evidenceId };
}

async function rawRejectsCode(operation, expectedCode) {
  try {
    await operation();
    return false;
  } catch (error) {
    return error?.code === expectedCode;
  }
}

if (!enabled) {
  test("AI admin PostgreSQL integration requires explicit opt-in and a dedicated disposable database", {
    skip: "requires PostgreSQL opt-in and a dedicated disposable database URL",
  }, () => {});
} else {
  test("category publication and archive preserve the current immutable strategy chain", {
    timeout: 90_000,
  }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 1 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `category_publish_mapping_${suffix}`;
    const schemaSql = quote(schema);
    const accountId = `account-mapped-${suffix}`;
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
      for (const migration of migrations) {
        await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      await admin.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'admin','active')",
        [accountId],
      );
      pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema},public` });
      const categoryRepository = createAutoListingCategoryStrategyPostgres({ pool });
      await categoryRepository.transitionAccountPolicy({
        accountId, actorId: accountId, expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY",
        idempotencyKey: `enable-mapped-${suffix}`,
        correlationId: `enable-mapped-correlation-${suffix}`,
      });
      const draft = await seedPublishableCategoryDraft(admin, {
        accountId, suffix, descriptionCategoryId: 170, typeId: 99,
        sourceDescriptionCategoryId: 190, sourceTypeId: 109,
      });
      const currentId = `current-mapped-strategy-${suffix}`;
      await admin.query(
        `INSERT INTO ai_content_strategy_versions
           (id,account_id,strategy_key,version,status,content,content_hash,created_by)
         VALUES ($1,$2,'default',1,'DRAFT','{"schemaVersion":"V2"}'::JSONB,$3,$2)`,
        [currentId, accountId, crypto.createHash("sha256").update(`current-${suffix}`).digest("hex")],
      );
      await admin.query(
        `UPDATE ai_content_strategy_versions
            SET status='PUBLISHED',published_at=NOW(),published_by=$2
          WHERE account_id=$2 AND id=$1`,
        [currentId, accountId],
      );
      const repository = createAutoListingAiAdminPostgres({ pool });
      const sharedRepository = createPostgresAccountSharedOzonCategoryRepository({ pool });
      const transitionTime = Date.now() + 10_000;

      await sharedRepository.activateRefreshedCategory({
        accountId, evidenceId: draft.evidenceId, expectedVersion: 2,
        currentDescriptionCategoryId: 171, currentTypeId: 100,
        taxonomyFingerprint: "b".repeat(64),
        validatedAt: new Date(transitionTime).toISOString(),
      });
      await assert.rejects(repository.publishCategoryStrategyDraft({
        accountId, actorId: accountId, draftId: draft.draftId, expectedDraftVersion: 4,
        expectedPublishedStrategyVersionId: currentId,
        idempotencyKey: `publish-wrong-active-mapping-${suffix}`,
        correlationId: `publish-wrong-active-mapping-correlation-${suffix}`,
      }), { code: "AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", status: 409 });
      await sharedRepository.activateRefreshedCategory({
        accountId, evidenceId: draft.evidenceId, expectedVersion: 3,
        currentDescriptionCategoryId: 170, currentTypeId: 99,
        taxonomyFingerprint: "c".repeat(64),
        validatedAt: new Date(transitionTime + 1_000).toISOString(),
      });
      await sharedRepository.markSharedNeedsReview({
        accountId, evidenceId: draft.evidenceId, expectedVersion: 4,
        safeFailureCode: "OZON_CATEGORY_NEEDS_REVIEW",
        transitionedAt: new Date(transitionTime + 2_000).toISOString(),
      });
      await assert.rejects(repository.publishCategoryStrategyDraft({
        accountId, actorId: accountId, draftId: draft.draftId, expectedDraftVersion: 4,
        expectedPublishedStrategyVersionId: currentId,
        idempotencyKey: `publish-disabled-mapping-${suffix}`,
        correlationId: `publish-disabled-mapping-correlation-${suffix}`,
      }), { code: "AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", status: 409 });
      await sharedRepository.activateRefreshedCategory({
        accountId, evidenceId: draft.evidenceId, expectedVersion: 5,
        currentDescriptionCategoryId: 170, currentTypeId: 99,
        taxonomyFingerprint: "d".repeat(64),
        validatedAt: new Date(transitionTime + 3_000).toISOString(),
      });
      await assert.rejects(repository.publishCategoryStrategyDraft({
        accountId, actorId: accountId, draftId: draft.draftId, expectedDraftVersion: 4,
        expectedPublishedStrategyVersionId: `stale-${currentId}`,
        idempotencyKey: `publish-stale-version-${suffix}`,
        correlationId: `publish-stale-version-correlation-${suffix}`,
      }), { code: "AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", status: 409 });

      const published = await repository.publishCategoryStrategyDraft({
        accountId, actorId: accountId, draftId: draft.draftId, expectedDraftVersion: 4,
        expectedPublishedStrategyVersionId: currentId,
        idempotencyKey: `publish-mapped-${suffix}`,
        correlationId: `publish-mapped-correlation-${suffix}`,
      });

      assert.equal(published.status, "PUBLISHED");
      assert.equal(published.version, 2);
      assert.deepEqual(published.rules.map((rule) => rule.scope), [{
        taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 170, typeId: 99,
      }]);

      const replacementDraft = await seedPublishableCategoryDraft(admin, {
        accountId, suffix: `replacement-${suffix}`, descriptionCategoryId: 170, typeId: 99,
        sourceDescriptionCategoryId: 191, sourceTypeId: 110,
      });
      const replacementPublished = await repository.publishCategoryStrategyDraft({
        accountId, actorId: accountId, draftId: replacementDraft.draftId, expectedDraftVersion: 4,
        expectedPublishedStrategyVersionId: published.id,
        idempotencyKey: `publish-replacement-${suffix}`,
        correlationId: `publish-replacement-correlation-${suffix}`,
      });
      assert.equal(replacementPublished.version, 3);

      const supersededArchiveInput = {
        accountId, actorId: accountId, draftId: draft.draftId, expectedDraftVersion: 5,
        idempotencyKey: `archive-superseded-${suffix}`,
        correlationId: `archive-superseded-correlation-${suffix}`,
      };
      const supersededArchive = await repository.archiveCategoryStrategyDraft(supersededArchiveInput);
      assert.deepEqual({
        removed: supersededArchive.removed,
        activeStrategyChanged: supersededArchive.activeStrategyChanged,
        strategyVersionId: supersededArchive.strategyVersionId,
      }, { removed: true, activeStrategyChanged: false, strategyVersionId: null });
      assert.equal((await repository.archiveCategoryStrategyDraft(supersededArchiveInput)).duplicate, true);
      assert.equal((await admin.query(
        "SELECT id FROM ai_content_strategy_versions WHERE account_id=$1 AND strategy_key='default' AND status='PUBLISHED'",
        [accountId],
      )).rows[0].id, replacementPublished.id);

      const activeArchive = await repository.archiveCategoryStrategyDraft({
        accountId, actorId: accountId, draftId: replacementDraft.draftId, expectedDraftVersion: 5,
        idempotencyKey: `archive-active-${suffix}`,
        correlationId: `archive-active-correlation-${suffix}`,
      });
      assert.deepEqual({
        removed: activeArchive.removed,
        activeStrategyChanged: activeArchive.activeStrategyChanged,
        strategyVersion: activeArchive.strategyVersion,
      }, { removed: true, activeStrategyChanged: true, strategyVersion: 4 });
      assert.equal((await admin.query(
        "SELECT COUNT(*)::int AS count FROM ai_content_strategy_rules WHERE account_id=$1 AND strategy_version_id=$2",
        [accountId, activeArchive.strategyVersionId],
      )).rows[0].count, 0);
      assert.equal((await admin.query(
        "SELECT COUNT(*)::int AS count FROM auto_listing_category_strategy_events WHERE account_id=$1 AND draft_id IN ($2,$3) AND event_type='PUBLISHED'",
        [accountId, draft.draftId, replacementDraft.draftId],
      )).rows[0].count, 2);
    } finally {
      try {
        await pool?.end();
        await admin.query("SET search_path TO public");
        await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
      } finally {
        admin.release();
        await adminPool.end();
      }
    }
  });

  test("AI admin repository serializes publication, preserves immutable history, and enforces account boundaries", { timeout: 60_000 }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 1 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_ai_admin_${suffix}`;
    const schemaSql = quote(schema);
    const accountA = `account-a-${suffix}`;
    const accountB = `account-b-${suffix}`;
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file))
        .sort();
      for (const migration of migrations) {
        await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      for (const accountId of [accountA, accountB]) {
        await admin.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [accountId, `user-${accountId}`],
        );
      }
      pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });
      const repository = createAutoListingAiAdminPostgres({ pool });
      const scopedRuleConstraint = await pool.query(
        `SELECT convalidated
           FROM pg_constraint
          WHERE conname='ai_content_strategy_rules_account_version_fk'
            AND conrelid='ai_content_strategy_rules'::regclass`,
      );
      assert.deepEqual(scopedRuleConstraint.rows, [{ convalidated: true }]);

      async function createPassedProfile(name, idempotencyKey) {
        const created = await repository.createProfile({
          accountId: accountA, actorId: accountA, idempotencyKey,
          correlationId: `correlation-${idempotencyKey}`, profile: profile(name),
        });
        const checkedAt = new Date().toISOString();
        const capabilityResult = {
          outcome: "PASSED",
          features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
          latencyMs: 5,
          models: { text: "text-model", image: "image-model" },
          checkedAt, errorCode: null,
        };
        const correlationId = `capability-${idempotencyKey}`;
        const attemptId = `attempt-${idempotencyKey}`;
        const begun = await repository.beginCapabilityTest({ costConfirmed: true,
          accountId: accountA, actorId: accountA, profileId: created.id, configVersion: 1,
          correlationId, attemptId, requestKey: requestKeyFor(attemptId),
        });
        const completed = await repository.completeCapabilityTest({ costConfirmed: true,
          accountId: accountA, actorId: accountA, profileId: created.id, configVersion: 1,
          correlationId, attemptId, fence: begun.fence,
          leaseVersion: begun.leaseVersion, leaseToken: begun.leaseToken,
          requestKey: requestKeyFor(attemptId), capabilityResult,
        });
        assert.equal(completed.applied, true);
        return created;
      }

      const first = await createPassedProfile("alpha", `create-alpha-${suffix}`);
      assert.equal(await rawRejectsCode(() => pool.query(
        `INSERT INTO ai_gateway_capability_attempts (
           id,account_id,profile_id,config_version,correlation_id,status,
           lease_version,lease_token,lease_expires_at
         ) VALUES ($1,$2,$3,1,$4,'RUNNING',1,'caplease_unauthorized',NOW()+INTERVAL '1 minute')`,
        [`unauthorized-attempt-${suffix}`, accountA, first.id, `unauthorized-corr-${suffix}`],
      ), "23514"), true);
      const replay = await repository.createProfile({
        accountId: accountA, actorId: accountA, idempotencyKey: `create-alpha-${suffix}`,
        correlationId: `correlation-create-alpha-${suffix}`, profile: profile("alpha"),
      });
      assert.equal(replay.id, first.id);
      assert.equal(replay.duplicate, true);
      const second = await createPassedProfile("beta", `create-beta-${suffix}`);
      assert.equal(await repository.beginCapabilityTest({ costConfirmed: true,
        accountId: accountB, actorId: accountB, profileId: first.id, configVersion: 1,
        correlationId: `foreign-capability-${suffix}`, attemptId: `foreign-attempt-${suffix}`,
        requestKey: requestKeyFor(`foreign-attempt-${suffix}`),
      }), null);

      const oldAttempt = await repository.beginCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: first.id, configVersion: 1,
        correlationId: `capability-old-${suffix}`, attemptId: `attempt-old-${suffix}`,
        requestKey: requestKeyFor(`attempt-old-${suffix}`),
      });
      const newAttempt = await repository.beginCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: first.id, configVersion: 1,
        correlationId: `capability-new-${suffix}`, attemptId: `attempt-new-${suffix}`,
        requestKey: requestKeyFor(`attempt-new-${suffix}`),
      });
      const newestCheckedAt = new Date().toISOString();
      const newestResult = {
        outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: 7,
        models: { text: "text-model", image: "image-model" }, checkedAt: newestCheckedAt, errorCode: null,
      };
      assert.equal((await repository.completeCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: first.id, configVersion: 1,
        correlationId: `capability-new-${suffix}`, attemptId: `attempt-new-${suffix}`,
        fence: newAttempt.fence, leaseVersion: newAttempt.leaseVersion, leaseToken: newAttempt.leaseToken,
        requestKey: requestKeyFor(`attempt-new-${suffix}`),
        capabilityResult: newestResult,
      })).applied, true);
      const stale = await repository.completeCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: first.id, configVersion: 1,
        correlationId: `capability-old-${suffix}`, attemptId: `attempt-old-${suffix}`,
        fence: oldAttempt.fence, leaseVersion: oldAttempt.leaseVersion, leaseToken: oldAttempt.leaseToken,
        requestKey: requestKeyFor(`attempt-old-${suffix}`),
        capabilityResult: { outcome: "FAILED", features: [], latencyMs: null,
          models: { text: "text-model", image: "image-model" }, checkedAt: new Date().toISOString(),
          errorCode: "NON_RETRYABLE_AUTH" },
      });
      assert.deepEqual({ applied: stale.applied, stale: stale.stale }, { applied: false, stale: true });
      const preserved = await pool.query(
        "SELECT enabled,capability_result FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2",
        [accountA, first.id],
      );
      assert.equal(preserved.rows[0].capability_result.checkedAt, newestCheckedAt);

      const crashCorrelation = `capability-crash-${suffix}`;
      const crashAttemptId = `attempt-crash-${suffix}`;
      const crashAttempt = await repository.beginCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: crashCorrelation, attemptId: crashAttemptId, requestKey: requestKeyFor(crashAttemptId),
      });
      const beforeCrash = await pool.query(
        "SELECT capability_result FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2",
        [accountA, second.id],
      );
      await pool.query(`CREATE OR REPLACE FUNCTION reject_selected_capability_audit()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.correlation_id='${crashCorrelation}' THEN
            RAISE EXCEPTION 'forced audit failure';
          END IF;
          RETURN NEW;
        END;
        $$`);
      await pool.query(`CREATE TRIGGER reject_selected_capability_audit_trigger
        BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_selected_capability_audit()`);
      const crashResult = { outcome: "PASSED",
        features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: 8,
        models: { text: "text-model", image: "image-model" }, checkedAt: new Date().toISOString(), errorCode: null };
      await assert.rejects(repository.completeCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: crashCorrelation, attemptId: crashAttemptId, fence: crashAttempt.fence,
        leaseVersion: crashAttempt.leaseVersion, leaseToken: crashAttempt.leaseToken,
        requestKey: requestKeyFor(crashAttemptId),
        capabilityResult: crashResult,
      }), { code: "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED" });
      const rolledBack = await pool.query(
        `SELECT p.capability_result,a.status,a.response
           FROM ai_gateway_profiles p
           JOIN ai_gateway_capability_attempts a
             ON a.account_id=p.account_id AND a.profile_id=p.id AND a.config_version=p.config_version
          WHERE p.account_id=$1 AND p.id=$2 AND a.id=$3`,
        [accountA, second.id, crashAttemptId],
      );
      assert.deepEqual(rolledBack.rows[0].capability_result, beforeCrash.rows[0].capability_result);
      assert.equal(rolledBack.rows[0].status, "RUNNING");
      assert.equal(rolledBack.rows[0].response, null);
      await pool.query("DROP TRIGGER reject_selected_capability_audit_trigger ON audit_events");
      await pool.query("DROP FUNCTION reject_selected_capability_audit()");
      assert.equal((await repository.completeCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: crashCorrelation, attemptId: crashAttemptId, fence: crashAttempt.fence,
        leaseVersion: crashAttempt.leaseVersion, leaseToken: crashAttempt.leaseToken,
        requestKey: requestKeyFor(crashAttemptId),
        capabilityResult: crashResult,
      })).applied, true);
      assert.equal(await rawRejectsCode(() => pool.query(
        "UPDATE ai_gateway_capability_attempts SET response='{}'::JSONB WHERE account_id=$1 AND id=$2",
        [accountA, crashAttemptId],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        "DELETE FROM ai_gateway_capability_attempts WHERE account_id=$1 AND id=$2",
        [accountA, crashAttemptId],
      ), "23514"), true);

      const recoveryCorrelation = `capability-recovery-${suffix}`;
      const recoveryAttemptId = `attempt-recovery-${suffix}`;
      await pool.query(
        `INSERT INTO ai_gateway_capability_attempts (
           id,account_id,profile_id,config_version,correlation_id,status,
           lease_version,lease_token,lease_expires_at,authorization_schema_version,
           purpose,cost_confirmed,authorization_hash,request_key,actor_id,
           target_connection_status,target_connection_status_version,authorized_at
         ) VALUES ($1,$2,$3,1,$4,'RUNNING',1,'caplease_crashed',NOW()-INTERVAL '1 minute',
           'AI_GATEWAY_CAPABILITY_AUTHORIZATION_V1','PROFILE_CAPABILITY',TRUE,$5,$6,$2,'LEGACY',0,NOW())`,
        [recoveryAttemptId, accountA, second.id, recoveryCorrelation,
          "a".repeat(64), requestKeyFor(recoveryAttemptId)],
      );
      const recoveredAttempt = await repository.beginCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: recoveryCorrelation, attemptId: recoveryAttemptId,
        requestKey: requestKeyFor(recoveryAttemptId),
      });
      assert.equal(recoveredAttempt.reclaimed, true);
      assert.equal(recoveredAttempt.leaseVersion, 2);
      assert.notEqual(recoveredAttempt.leaseToken, "caplease_crashed");
      const recoveryResult = { outcome: "PASSED",
        features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: 6,
        models: { text: "text-model", image: "image-model" }, checkedAt: new Date().toISOString(), errorCode: null };
      await assert.rejects(repository.completeCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: recoveryCorrelation, attemptId: recoveryAttemptId, fence: recoveredAttempt.fence,
        leaseVersion: 1, leaseToken: "caplease_crashed", requestKey: requestKeyFor(recoveryAttemptId),
        capabilityResult: recoveryResult,
      }), { code: "AI_GATEWAY_PROFILE_VERSION_CONFLICT", status: 409 });
      const recoveredCompletion = await repository.completeCapabilityTest({ costConfirmed: true,
        accountId: accountA, actorId: accountA, profileId: second.id, configVersion: 1,
        correlationId: recoveryCorrelation, attemptId: recoveryAttemptId, fence: recoveredAttempt.fence,
        leaseVersion: recoveredAttempt.leaseVersion, leaseToken: recoveredAttempt.leaseToken,
        requestKey: requestKeyFor(recoveryAttemptId),
        capabilityResult: recoveryResult,
      });
      assert.equal(recoveredCompletion.applied, true);

      const publicationInputs = [first, second].map((candidate, index) => ({
        accountId: accountA, actorId: accountA, profileId: candidate.id, configVersion: 1,
        idempotencyKey: `publish-profile-${index}-${suffix}`,
        correlationId: `correlation-publish-profile-${index}-${suffix}`,
      }));
      await Promise.all(publicationInputs.map((input) => repository.publishProfile(input)));
      const enabledProfiles = await pool.query(
        "SELECT id,config_version FROM ai_gateway_profiles WHERE account_id=$1 AND enabled IS TRUE",
        [accountA],
      );
      assert.equal(enabledProfiles.rowCount, 1);
      assert.equal(await rawRejectsCode(() => pool.query(
        "UPDATE ai_gateway_profiles SET enabled=TRUE WHERE account_id=$1 AND id<>$2",
        [accountA, enabledProfiles.rows[0].id],
      ), "23505"), true);
      await assert.rejects(repository.publishProfile({
        ...publicationInputs[0], accountId: accountB, actorId: accountB,
        idempotencyKey: `foreign-profile-${suffix}`,
      }), { code: "AUTO_LISTING_AI_PROFILE_NOT_FOUND", status: 404 });

      async function createStrategy(version) {
        return repository.createStrategyVersion({
          accountId: accountA, actorId: accountA, strategyKey: "default", version,
          idempotencyKey: `create-strategy-${version}-${suffix}`,
          correlationId: `correlation-create-strategy-${version}-${suffix}`,
          content: { schemaVersion: "V1" }, rules: strategyRules(`rule-${version}`),
        });
      }
      const strategy1 = await createStrategy(1);
      const strategy2 = await createStrategy(2);
      const strategyReadback = await repository.listStrategyVersions({ accountId: accountA, strategyKey: "default" });
      assert.deepEqual(strategyReadback.map((row) => row.rules[0].ruleId), ["rule-1", "rule-2"]);
      assert.deepEqual(strategyReadback[0].rules[0].textDensityByRole, { MAIN: "NONE", SELLING_POINT: "LIGHT" });
      const strategyPublicationInputs = [strategy1, strategy2].map((candidate) => ({
        accountId: accountA, actorId: accountA, strategyKey: "default",
        strategyVersionId: candidate.id, version: candidate.version,
        idempotencyKey: `publish-strategy-${candidate.version}-${suffix}`,
        correlationId: `correlation-publish-strategy-${candidate.version}-${suffix}`,
      }));
      await Promise.all(strategyPublicationInputs.map((input) => repository.publishStrategyVersion(input)));
      const strategies = await pool.query(
        "SELECT id,status,content,content_hash,published_at FROM ai_content_strategy_versions WHERE account_id=$1 AND strategy_key='default' ORDER BY version",
        [accountA],
      );
      assert.equal(strategies.rows.filter((row) => row.status === "PUBLISHED").length, 1);
      assert.equal(strategies.rows.filter((row) => row.status === "RETIRED").length, 1);
      const retired = strategies.rows.find((row) => row.status === "RETIRED");
      assert.ok(retired.published_at);
      assert.equal(await rawRejectsCode(() => pool.query(
        "UPDATE ai_content_strategy_versions SET content='{\"changed\":true}'::JSONB WHERE account_id=$1 AND id=$2",
        [accountA, retired.id],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        "DELETE FROM ai_content_strategy_versions WHERE account_id=$1 AND id=$2",
        [accountA, retired.id],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        `INSERT INTO ai_content_strategy_rules
           (id,account_id,strategy_version_id,rule_kind,rule_order,product_style,rule)
         VALUES ($1,$2,$3,'PRODUCT_STYLE',99,'GENERAL','{}'::JSONB)`,
        [`late-rule-${suffix}`, accountA, retired.id],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        `INSERT INTO ai_content_strategy_rules
           (id,account_id,strategy_version_id,rule_kind,rule_order,product_style,rule)
         VALUES ($1,$2,$3,'PRODUCT_STYLE',100,'GENERAL','{}'::JSONB)`,
        [`foreign-rule-${suffix}`, accountB, strategy1.id],
      ), "23503"), true);

      const legacyStrategy = `legacy-null-published-${suffix}`;
      await pool.query(
        `INSERT INTO ai_content_strategy_versions
           (id,account_id,strategy_key,version,status,content,content_hash,published_at)
         VALUES ($1,$2,'legacy-null',1,'PUBLISHED','{}'::JSONB,$3,NULL)`,
        [legacyStrategy, accountA, "f".repeat(64)],
      );
      assert.equal(await rawRejectsCode(() => pool.query(
        "UPDATE ai_content_strategy_versions SET content='{\"changed\":true}'::JSONB WHERE account_id=$1 AND id=$2",
        [accountA, legacyStrategy],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        `INSERT INTO ai_content_strategy_rules
           (id,account_id,strategy_version_id,rule_kind,rule_order,product_style,rule)
         VALUES ($1,$2,$3,'PRODUCT_STYLE',1,'GENERAL','{}'::JSONB)`,
        [`legacy-rule-${suffix}`, accountA, legacyStrategy],
      ), "23514"), true);
      await pool.query(
        "UPDATE ai_content_strategy_versions SET status='RETIRED' WHERE account_id=$1 AND id=$2",
        [accountA, legacyStrategy],
      );
      assert.equal(await rawRejectsCode(() => pool.query(
        "DELETE FROM ai_content_strategy_versions WHERE account_id=$1 AND id=$2",
        [accountA, legacyStrategy],
      ), "23514"), true);

      const audits = await pool.query(
        `SELECT action,COUNT(*)::INTEGER AS count
           FROM audit_events
          WHERE account_id=$1 AND source='auto-listing-ai-admin'
          GROUP BY action`,
        [accountA],
      );
      const counts = Object.fromEntries(audits.rows.map((row) => [row.action, row.count]));
      assert.deepEqual(counts, {
        AUTO_LISTING_AI_PROFILE_CAPABILITY_AUTHORIZED: 6,
        AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST: 6,
        AUTO_LISTING_AI_PROFILE_CREATE: 2,
        AUTO_LISTING_AI_PROFILE_PUBLISH: 2,
        AUTO_LISTING_AI_STRATEGY_VERSION_CREATE: 2,
        AUTO_LISTING_AI_STRATEGY_VERSION_PUBLISH: 2,
      });
    } finally {
      try {
        await pool?.end();
        await admin.query("SET search_path TO public");
        await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
      } finally {
        admin.release();
        await adminPool.end();
      }
    }
  });

  test("connection-backed publish and paid rollback switch profile plus connection state atomically", {
    timeout: 60_000,
  }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 1 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_ai_connected_${suffix}`;
    const schemaSql = quote(schema);
    const accountId = `account-connected-${suffix}`;
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file))
        .sort();
      for (const migration of migrations) {
        await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      await admin.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'admin','active')",
        [accountId],
      );
      pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema},public` });
      const settings = createAutoListingAiSettingsPostgres({ pool });
      const profiles = createAutoListingAiAdminPostgres({ pool });

      async function createConnected(label) {
        const connection = await settings.createPendingConnection({
          accountId, actorId: accountId, idempotencyKey: `connection-${label}-${suffix}`,
          correlationId: `connection-corr-${label}-${suffix}`, displayName: `Connection ${label}`,
          baseUrl: "https://gateway.example.test/v1",
          encryptedSecret: { algorithm: "aes-256-gcm", ciphertext: "Y2lwaGVy", iv: "aXY=",
            authTag: "dGFn", keyVersion: "local-v1", fingerprint: `fp-${label}-${suffix}` },
        });
        const task = await settings.enqueueModelSync({
          accountId, actorId: accountId, connectionId: connection.id, connectionVersion: 1,
          expectedConnectionStatusVersion: 1, syncPurpose: "CATALOG_SYNC", maxAttempts: 5,
          idempotencyKey: `catalog-${label}-${suffix}`, correlationId: `catalog-corr-${label}-${suffix}`,
        });
        const workerId = `worker-${label}-${suffix}`;
        const lease = await settings.claimModelSync({ accountId, workerId, leaseMs: 30_000,
          syncPurpose: "CATALOG_SYNC" });
        assert.equal(lease.taskId, task.id);
        const checkedAt = new Date().toISOString();
        const completed = await settings.completeModelSync({
          accountId, workerId, taskId: task.id, leaseVersion: lease.leaseVersion,
          leaseToken: lease.leaseToken, correlationId: `complete-${label}-${suffix}`,
          catalog: { models: [{ id: "image-model" }, { id: "text-model" }] },
          capabilityResult: { outcome: "NOT_TESTED", checkedAt, text: false, image: false },
        });
        const profileRow = await settings.createProfileFromSelection({
          accountId, actorId: accountId, connectionId: connection.id, connectionVersion: 1,
          catalogId: completed.catalog.id, displayName: `Profile ${label}`,
          textModel: "text-model", imageModel: "image-model",
          textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES",
          idempotencyKey: `profile-${label}-${suffix}`, correlationId: `profile-corr-${label}-${suffix}`,
        });
        return { connection, profile: profileRow };
      }

      async function passCapability(target, purpose, label) {
        const correlationId = `paid-${purpose}-${label}-${suffix}`;
        const attemptId = `attempt-${purpose}-${label}-${suffix}`;
        const begun = await profiles.beginCapabilityTest({ costConfirmed: true,
          accountId, actorId: accountId, profileId: target.profile.id, configVersion: 1,
          correlationId, attemptId, purpose, requestKey: requestKeyFor(attemptId),
        });
        const retiredAt = purpose === "ROLLBACK_CAPABILITY"
          ? (await pool.query(
            `SELECT retired_at FROM ai_gateway_connection_versions
              WHERE account_id=$1 AND id=$2 AND version=1`,
            [accountId, target.connection.id],
          )).rows[0]?.retired_at
          : null;
        const checkedAt = new Date(Math.max(Date.now(), retiredAt ? retiredAt.getTime() + 1 : 0)).toISOString();
        const capabilityResult = {
          outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
          latencyMs: 5, models: { text: target.profile.textModel, image: target.profile.imageModel },
          checkedAt, errorCode: null,
        };
        await profiles.completeCapabilityTest({ costConfirmed: true,
          accountId, actorId: accountId, profileId: target.profile.id, configVersion: 1,
          correlationId, attemptId, fence: begun.fence, leaseVersion: begun.leaseVersion,
          leaseToken: begun.leaseToken, purpose, requestKey: requestKeyFor(attemptId), capabilityResult,
        });
      }

      const first = await createConnected("first");
      await passCapability(first, "PROFILE_CAPABILITY", "first");
      await pool.query(`CREATE FUNCTION reject_primary_channel_${suffix}() RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced primary channel insert failure'; END;
        $$`);
      await pool.query(`CREATE TRIGGER reject_primary_channel_${suffix}
        BEFORE INSERT ON auto_listing_ai_profile_channels
        FOR EACH ROW WHEN (NEW.channel_id = 'primary')
        EXECUTE FUNCTION reject_primary_channel_${suffix}()`);
      await assert.rejects(profiles.publishProfile({
        accountId, actorId: accountId, profileId: first.profile.id, configVersion: 1,
        idempotencyKey: `publish-primary-rollback-${suffix}`, correlationId: `publish-primary-rollback-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED", status: 503 });
      assert.deepEqual((await pool.query(
        "SELECT enabled FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2 AND config_version=1",
        [accountId, first.profile.id],
      )).rows, [{ enabled: false }]);
      assert.equal(Number((await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM auto_listing_ai_profile_channels WHERE account_id=$1 AND profile_id=$2 AND profile_version=1",
        [accountId, first.profile.id],
      )).rows[0].count), 0);
      await pool.query(`DROP TRIGGER reject_primary_channel_${suffix} ON auto_listing_ai_profile_channels`);
      await pool.query(`DROP FUNCTION reject_primary_channel_${suffix}()`);
      await profiles.publishProfile({
        accountId, actorId: accountId, profileId: first.profile.id, configVersion: 1,
        idempotencyKey: `publish-first-${suffix}`, correlationId: `publish-first-corr-${suffix}`,
      });
      assert.deepEqual((await pool.query(
        `SELECT channel_id,channel_order,connection_id,connection_version
           FROM auto_listing_ai_profile_channels
          WHERE account_id=$1 AND profile_id=$2 AND profile_version=1`,
        [accountId, first.profile.id],
      )).rows, [{ channel_id: "primary", channel_order: 1, connection_id: first.connection.id,
        connection_version: 1 }]);
      const activeAttemptCountBefore = (await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_capability_attempts WHERE account_id=$1",
        [accountId],
      )).rows[0].count;
      const activeReservationCountBefore = (await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_capability_subcall_reservations WHERE account_id=$1",
        [accountId],
      )).rows[0].count;
      let activeProfileProviderCalls = 0;
      const activeProfileCapabilityService = createAiGatewayProfileService({
        repository: profiles,
        gateway: { async testCapabilities() { activeProfileProviderCalls += 1; throw new Error("must not run"); } },
      });
      await assert.rejects(activeProfileCapabilityService.testGatewayCapabilities({
        actor: { id: accountId, role: "admin" }, profileId: first.profile.id, configVersion: 1,
        correlationId: `active-profile-capability-${suffix}`, costConfirmed: true,
        purpose: "PROFILE_CAPABILITY",
      }), { code: "AUTO_LISTING_AI_PROFILE_CONNECTION_NOT_VALIDATED", status: 409 });
      assert.equal(activeProfileProviderCalls, 0,
        "the current published profile must be rejected before any provider invocation");
      assert.equal((await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_capability_attempts WHERE account_id=$1",
        [accountId],
      )).rows[0].count, activeAttemptCountBefore,
      "the rejected current-profile test must not create a capability attempt");
      assert.equal((await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_capability_subcall_reservations WHERE account_id=$1",
        [accountId],
      )).rows[0].count, activeReservationCountBefore,
      "the rejected current-profile test must not reserve any provider subcall");
      assert.equal((await pool.query(
        "SELECT enabled FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2 AND config_version=1",
        [accountId, first.profile.id],
      )).rows[0].enabled, true);

      const activationAuditCountBefore = (await pool.query(
        `SELECT COUNT(*)::INTEGER AS count FROM audit_events
          WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_PUBLISH'
            AND entity_id=$2 AND status='SUCCESS'`,
        [accountId, first.profile.id],
      )).rows[0].count;
      await assert.rejects(profiles.publishProfile({
        accountId, actorId: accountId, profileId: first.profile.id, configVersion: 1,
        idempotencyKey: `publish-first-new-intent-${suffix}`,
        correlationId: `publish-first-new-intent-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_PROFILE_VERSION_CONFLICT", status: 409 });
      assert.equal((await pool.query(
        `SELECT COUNT(*)::INTEGER AS count FROM audit_events
          WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_PUBLISH'
            AND entity_id=$2 AND status='SUCCESS'`,
        [accountId, first.profile.id],
      )).rows[0].count, activationAuditCountBefore,
      "a new no-op publish intent for the current target must not append activation evidence");
      assert.equal((await pool.query(
        "SELECT enabled FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2 AND config_version=1",
        [accountId, first.profile.id],
      )).rows[0].enabled, true);
      const activeBeforeSuccessor = (await pool.query(
        `SELECT status,status_version FROM ai_gateway_connection_versions
          WHERE account_id=$1 AND id=$2 AND version=1`,
        [accountId, first.connection.id],
      )).rows[0];
      assert.equal(activeBeforeSuccessor.status, "ACTIVE");
      const successorSync = await settings.enqueueModelSync({
        accountId, actorId: accountId, connectionId: first.connection.id, connectionVersion: 1,
        expectedConnectionStatusVersion: Number(activeBeforeSuccessor.status_version),
        syncPurpose: "CATALOG_SYNC", maxAttempts: 5,
        idempotencyKey: `catalog-successor-${suffix}`,
        correlationId: `catalog-successor-corr-${suffix}`,
      });
      const successorWorkerId = `worker-successor-${suffix}`;
      const successorLease = await settings.claimModelSync({ accountId, workerId: successorWorkerId,
        leaseMs: 30_000, syncPurpose: "CATALOG_SYNC" });
      assert.equal(successorLease.taskId, successorSync.id);
      const successorCheckedAt = new Date().toISOString();
      const successorCatalog = await settings.completeModelSync({
        accountId, workerId: successorWorkerId, taskId: successorSync.id,
        leaseVersion: successorLease.leaseVersion, leaseToken: successorLease.leaseToken,
        correlationId: `complete-successor-${suffix}`,
        catalog: { models: [{ id: "image-model-new" }, { id: "text-model-new" }] },
        capabilityResult: { outcome: "NOT_TESTED", checkedAt: successorCheckedAt, text: false, image: false },
      });
      const successorProfile = await settings.createProfileFromSelection({
        accountId, actorId: accountId, connectionId: first.connection.id, connectionVersion: 1,
        catalogId: successorCatalog.catalog.id, displayName: "Profile successor",
        textModel: "text-model-new", imageModel: "image-model-new",
        textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES",
        idempotencyKey: `profile-successor-${suffix}`,
        correlationId: `profile-successor-corr-${suffix}`,
      });
      const successor = { connection: first.connection, profile: successorProfile };
      assert.equal(successor.profile.enabled, false);
      assert.equal((await pool.query(
        "SELECT enabled FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2 AND config_version=1",
        [accountId, first.profile.id],
      )).rows[0].enabled, true);
      await passCapability(successor, "PROFILE_CAPABILITY", "successor");
      assert.equal((await pool.query(
        "SELECT enabled FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2 AND config_version=1",
        [accountId, first.profile.id],
      )).rows[0].enabled, true);
      await profiles.publishProfile({
        accountId, actorId: accountId, profileId: successor.profile.id, configVersion: 1,
        idempotencyKey: `publish-successor-${suffix}`,
        correlationId: `publish-successor-corr-${suffix}`,
      });
      const sameConnectionAfterSuccessor = (await pool.query(
        `SELECT status,status_version FROM ai_gateway_connection_versions
          WHERE account_id=$1 AND id=$2 AND version=1`,
        [accountId, first.connection.id],
      )).rows[0];
      assert.equal(sameConnectionAfterSuccessor.status, "ACTIVE");
      assert.equal(Number(sameConnectionAfterSuccessor.status_version), Number(activeBeforeSuccessor.status_version));
      const successorStates = await pool.query(
        `SELECT id,enabled,capability_result,capability_checked_at FROM ai_gateway_profiles
          WHERE account_id=$1 AND id IN ($2,$3) ORDER BY id`,
        [accountId, first.profile.id, successor.profile.id],
      );
      assert.deepEqual(Object.fromEntries(successorStates.rows.map((row) => [row.id, row.enabled])), {
        [first.profile.id]: false,
        [successor.profile.id]: true,
      });
      const retiredProfileRow = successorStates.rows.find((row) => row.id === first.profile.id);
      assert.deepEqual(retiredProfileRow.capability_result, {});
      assert.equal(retiredProfileRow.capability_checked_at, null);
      assert.equal((await pool.query(
        `SELECT COUNT(*)::INTEGER AS count FROM audit_events
          WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST'
            AND entity_id=$2 AND status='SUCCESS'`,
        [accountId, first.profile.id],
      )).rows[0].count, 1, "historical capability audit remains append-only after row evidence is invalidated");
      await assert.rejects(profiles.publishProfile({
        accountId, actorId: accountId, profileId: first.profile.id, configVersion: 1,
        idempotencyKey: `republish-old-without-retest-${suffix}`,
        correlationId: `republish-old-without-retest-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_PROFILE_CAPABILITY_REQUIRED", status: 409 });
      const second = await createConnected("second");
      await passCapability(second, "PROFILE_CAPABILITY", "second");
      await profiles.publishProfile({
        accountId, actorId: accountId, profileId: second.profile.id, configVersion: 1,
        idempotencyKey: `publish-second-${suffix}`, correlationId: `publish-second-corr-${suffix}`,
      });
      const rollbackInput = {
        accountId, actorId: accountId, profileId: successor.profile.id, configVersion: 1,
        idempotencyKey: `rollback-first-${suffix}`, correlationId: `rollback-first-corr-${suffix}`,
      };
      assert.deepEqual(await profiles.prepareProfileRollback(rollbackInput), {
        completed: false, duplicate: false, profile: null,
      });
      await assert.rejects(profiles.prepareProfileRollback({ ...rollbackInput,
        profileId: second.profile.id, correlationId: `rollback-conflict-${suffix}` }), {
        code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", status: 409,
      });
      await passCapability(successor, "ROLLBACK_CAPABILITY", "first");
      await pool.query("ALTER TABLE auto_listing_ai_profile_channels DISABLE TRIGGER auto_listing_ai_profile_channels_no_delete");
      await pool.query(
        "DELETE FROM auto_listing_ai_profile_channels WHERE account_id=$1 AND profile_id=$2 AND profile_version=1 AND channel_id='primary'",
        [accountId, successor.profile.id],
      );
      await pool.query("ALTER TABLE auto_listing_ai_profile_channels ENABLE TRIGGER auto_listing_ai_profile_channels_no_delete");
      assert.equal(Number((await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM auto_listing_ai_profile_channels WHERE account_id=$1 AND profile_id=$2 AND profile_version=1",
        [accountId, successor.profile.id],
      )).rows[0].count), 0, "the historical encrypted rollback target starts without a channel");
      await pool.query(`CREATE FUNCTION reject_rollback_primary_${suffix}() RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced rollback primary channel insert failure'; END;
        $$`);
      await pool.query(`CREATE TRIGGER reject_rollback_primary_${suffix}
        BEFORE INSERT ON auto_listing_ai_profile_channels
        FOR EACH ROW WHEN (NEW.channel_id = 'primary')
        EXECUTE FUNCTION reject_rollback_primary_${suffix}()`);
      await assert.rejects(profiles.rollbackProfile(rollbackInput), {
        code: "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED", status: 503,
      });
      assert.deepEqual((await pool.query(
        "SELECT id,enabled FROM ai_gateway_profiles WHERE account_id=$1 AND id IN ($2,$3) ORDER BY id",
        [accountId, successor.profile.id, second.profile.id],
      )).rows, [{ id: second.profile.id, enabled: true }, { id: successor.profile.id, enabled: false }].sort((a, b) => a.id.localeCompare(b.id)));
      assert.deepEqual((await pool.query(
        "SELECT id,status FROM ai_gateway_connection_versions WHERE account_id=$1 AND id IN ($2,$3) ORDER BY id",
        [accountId, successor.connection.id, second.connection.id],
      )).rows, [{ id: second.connection.id, status: "ACTIVE" }, { id: successor.connection.id, status: "RETIRED" }].sort((a, b) => a.id.localeCompare(b.id)));
      assert.equal(Number((await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM audit_events WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_ROLLBACK'",
        [accountId],
      )).rows[0].count), 0);
      await pool.query(`DROP TRIGGER reject_rollback_primary_${suffix} ON auto_listing_ai_profile_channels`);
      await pool.query(`DROP FUNCTION reject_rollback_primary_${suffix}()`);
      const rolledBack = await profiles.rollbackProfile(rollbackInput);
      assert.equal(rolledBack.enabled, true);
      assert.equal(rolledBack.activation.kind, "ROLLBACK");
      assert.equal(rolledBack.activation.actorId, accountId);
      assert.equal(new Date(rolledBack.activation.occurredAt).toISOString(), rolledBack.activation.occurredAt);
      assert.equal((await profiles.rollbackProfile(rollbackInput)).duplicate, true);
      assert.deepEqual((await pool.query(
        `SELECT channel_id,channel_order,connection_id,connection_version
           FROM auto_listing_ai_profile_channels
          WHERE account_id=$1 AND profile_id=$2 AND profile_version=1`,
        [accountId, successor.profile.id],
      )).rows, [{ channel_id: "primary", channel_order: 1, connection_id: successor.connection.id, connection_version: 1 }]);
      const activationOverview = await settings.loadSettingsOverview({ accountId });
      assert.deepEqual(
        activationOverview.profiles.find((candidate) => candidate.id === successor.profile.id)?.activation,
        rolledBack.activation,
      );
      const preparedReplay = await profiles.prepareProfileRollback({ ...rollbackInput,
        correlationId: `rollback-response-loss-${suffix}` });
      assert.equal(preparedReplay.completed, true);
      assert.equal(preparedReplay.profile.enabled, true);
      assert.deepEqual(preparedReplay.profile.activation, rolledBack.activation);
      const states = await pool.query(
        `SELECT id,status FROM ai_gateway_connection_versions
          WHERE account_id=$1 ORDER BY id`,
        [accountId],
      );
      assert.deepEqual(Object.fromEntries(states.rows.map((row) => [row.id, row.status])), {
        [first.connection.id]: "ACTIVE",
        [second.connection.id]: "RETIRED",
      });
      const purposeAudit = await pool.query(
        `SELECT COUNT(*)::INTEGER AS count FROM audit_events
          WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST'
            AND metadata->>'purpose'='ROLLBACK_CAPABILITY'`,
        [accountId],
      );
      assert.equal(purposeAudit.rows[0].count, 1);

      const beforeFirstProbe = await createConnected("before-first-probe");
      await passCapability(beforeFirstProbe, "PROFILE_CAPABILITY", "before-first-probe-seed");
      const beforeFirstCorrelation = `paid-before-first-probe-${suffix}`;
      const beforeFirstAttemptId = `attempt-before-first-probe-${suffix}`;
      const beforeFirstAttempt = await profiles.beginCapabilityTest({
        costConfirmed: true, accountId, actorId: accountId,
        profileId: beforeFirstProbe.profile.id, configVersion: 1,
        correlationId: beforeFirstCorrelation, attemptId: beforeFirstAttemptId,
        purpose: "PROFILE_CAPABILITY", requestKey: requestKeyFor(beforeFirstAttemptId),
      });
      const preparedCredential = await profiles.loadCapabilityExecutionForSecretResolution({
        ...beforeFirstAttempt.capabilityExecution, probe: "REACHABILITY",
      });
      assert.match(preparedCredential.providerRequestKey, /^[a-f0-9]{64}$/u);
      await assert.rejects(profiles.publishProfile({
        accountId, actorId: accountId, profileId: beforeFirstProbe.profile.id, configVersion: 1,
        idempotencyKey: `publish-before-first-probe-${suffix}`,
        correlationId: `publish-before-first-probe-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", status: 409 });
      await profiles.completeCapabilitySubcall({
        ...beforeFirstAttempt.capabilityExecution, probe: "REACHABILITY", outcome: "FAILED",
        reason: "PRE_SEND_FAILED",
      });
      await profiles.publishProfile({
        accountId, actorId: accountId, profileId: beforeFirstProbe.profile.id, configVersion: 1,
        idempotencyKey: `publish-before-first-probe-${suffix}`,
        correlationId: `publish-before-first-probe-corr-${suffix}`,
      });
      await assert.rejects(profiles.loadCapabilityExecutionForSecretResolution({
        ...beforeFirstAttempt.capabilityExecution, probe: "REACHABILITY",
      }), { code: "AUTO_LISTING_AI_ADMIN_CAPABILITY_EXECUTION_STALE", status: 409 });
      const beforeFirstStored = await pool.query(
        "SELECT status FROM ai_gateway_capability_attempts WHERE account_id=$1 AND id=$2",
        [accountId, beforeFirstAttemptId],
      );
      assert.equal(beforeFirstStored.rows[0].status, "STALE");

      const afterFirstProbe = await createConnected("after-first-probe");
      await passCapability(afterFirstProbe, "PROFILE_CAPABILITY", "after-first-probe-seed");
      const transitionCandidate = await settings.createPendingConnection({
        accountId, actorId: accountId, idempotencyKey: `connection-transition-${suffix}`,
        correlationId: `connection-transition-corr-${suffix}`, displayName: "Transition candidate",
        baseUrl: "https://gateway.example.test/v1",
        encryptedSecret: { algorithm: "aes-256-gcm", ciphertext: "Y2lwaGVy", iv: "aXY=",
          authTag: "dGFn", keyVersion: "local-v1", fingerprint: `fp-transition-${suffix}` },
      });
      let paidFetches = 0;
      let releaseFirstDns;
      let signalFirstDns;
      const firstDnsEntered = new Promise((resolve) => { signalFirstDns = resolve; });
      const firstDnsGate = new Promise((resolve) => { releaseFirstDns = resolve; });
      let gateDns = true;
      const resolver = createAutoListingAiCapabilityCredentialResolver({
        repository: profiles,
        cipher: { async decrypt() { return "paid-test-secret"; } },
        readSecret() { return undefined; },
      });
      const adapter = createSub2ApiAdapter({
        readSecret() { throw new Error("generic secret path must not authorize paid work"); },
        prepareCapabilitySubcall: (execution) => resolver.prepareSubcall(execution),
        resolveCapabilityCredential: (execution) => resolver.resolveCredential(execution),
        markCapabilitySubcallSending: (execution) => resolver.markSending(execution),
        completeCapabilitySubcall: (execution, outcome, reason) => resolver.completeSubcall(execution, outcome, reason),
        resolveHostname: async () => {
          if (gateDns) {
            gateDns = false;
            signalFirstDns();
            await firstDnsGate;
          }
          return [{ address: "203.0.113.10", family: 4 }];
        },
        allowedSecretEnvNames: ["SUB2API_ENCRYPTED_KEY"],
        allowedGatewayBaseUrls: ["https://gateway.example.test/v1"],
        fetchImpl: async () => {
          paidFetches += 1;
          if (paidFetches === 1) {
            await assert.rejects(profiles.publishProfile({
              accountId, actorId: accountId, profileId: afterFirstProbe.profile.id, configVersion: 1,
              idempotencyKey: `publish-after-first-probe-${suffix}`,
              correlationId: `publish-after-first-probe-corr-${suffix}`,
            }), { code: "AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", status: 409 });
          }
          if (paidFetches === 2) return new Response(JSON.stringify({
            id: "text-reservation", output: [{ type: "message",
              content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
          }), { status: 200, headers: { "content-type": "application/json" } });
          if (paidFetches === 3) return new Response(JSON.stringify({
            id: "image-reservation", data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }],
          }), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        },
      });
      const fencedService = createAiGatewayProfileService({ repository: profiles, gateway: adapter });
      const fencedCorrelation = `fenced-after-first-probe-${suffix}`;
      const fencedPromise = fencedService.testGatewayCapabilities({
        actor: { id: accountId, role: "admin" }, profileId: afterFirstProbe.profile.id,
        configVersion: 1, correlationId: fencedCorrelation, costConfirmed: true,
      });
      await firstDnsEntered;
      await assert.rejects(profiles.publishProfile({
        accountId, actorId: accountId, profileId: afterFirstProbe.profile.id, configVersion: 1,
        idempotencyKey: `publish-during-dns-${suffix}`,
        correlationId: `publish-during-dns-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", status: 409 });
      await assert.rejects(settings.markConnectionValidated({
        accountId, actorId: accountId, connectionId: transitionCandidate.id, connectionVersion: 1,
        expectedStatusVersion: 1, idempotencyKey: `validate-during-dns-${suffix}`,
        correlationId: `validate-during-dns-corr-${suffix}`, rollbackCapabilityEvidence: null,
        validationResult: { outcome: "PASSED", checkedAt: new Date().toISOString(), endpoint: "models" },
      }), { code: "AUTO_LISTING_AI_SETTINGS_CAPABILITY_SUBCALL_CONFLICT", status: 409 });
      releaseFirstDns();
      const fencedResult = await fencedPromise;
      assert.equal(fencedResult.outcome, "PASSED");
      assert.equal(paidFetches, 3, "all paid stages use terminal reservations before moving on");
      const fencedStored = await pool.query(
        `SELECT status FROM ai_gateway_capability_attempts
          WHERE account_id=$1 AND profile_id=$2 AND correlation_id=$3`,
        [accountId, afterFirstProbe.profile.id, fencedCorrelation],
      );
      assert.equal(fencedStored.rows[0].status, "PASSED");
      await profiles.publishProfile({
        accountId, actorId: accountId, profileId: afterFirstProbe.profile.id, configVersion: 1,
        idempotencyKey: `publish-after-first-probe-${suffix}`,
        correlationId: `publish-after-first-probe-corr-${suffix}`,
      });

      const secretFailure = await createConnected("decrypt-failure");
      let secretFailureFetches = 0;
      const secretFailureResolver = createAutoListingAiCapabilityCredentialResolver({
        repository: profiles,
        cipher: { async decrypt() { throw new Error("forced decrypt failure"); } },
        readSecret() { return undefined; },
      });
      const secretFailureGateway = createSub2ApiAdapter({
        readSecret() { throw new Error("generic resolver must not authorize paid work"); },
        prepareCapabilitySubcall: (execution) => secretFailureResolver.prepareSubcall(execution),
        resolveCapabilityCredential: (execution) => secretFailureResolver.resolveCredential(execution),
        markCapabilitySubcallSending: (execution) => secretFailureResolver.markSending(execution),
        completeCapabilitySubcall: (execution, outcome, reason) =>
          secretFailureResolver.completeSubcall(execution, outcome, reason),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        allowedSecretEnvNames: ["SUB2API_ENCRYPTED_KEY"],
        allowedGatewayBaseUrls: ["https://gateway.example.test/v1"],
        fetchImpl: async () => {
          secretFailureFetches += 1;
          throw new Error("decrypt failure must not reach transport");
        },
      });
      const secretFailureService = createAiGatewayProfileService({
        repository: profiles, gateway: secretFailureGateway,
      });
      const secretFailureCorrelation = `decrypt-failure-${suffix}`;
      const secretFailureResult = await secretFailureService.testGatewayCapabilities({
        actor: { id: accountId, role: "admin" }, profileId: secretFailure.profile.id,
        configVersion: 1, correlationId: secretFailureCorrelation, costConfirmed: true,
      });
      assert.equal(secretFailureResult.outcome, "FAILED");
      assert.equal(secretFailureFetches, 0);
      const secretFailureReservation = await pool.query(
        `SELECT reservation.status,terminal.metadata
           FROM ai_gateway_capability_subcall_reservations reservation
           JOIN ai_gateway_capability_attempts attempt
             ON attempt.account_id=reservation.account_id AND attempt.id=reservation.attempt_id
           LEFT JOIN audit_events terminal
             ON terminal.account_id=reservation.account_id
            AND terminal.action='AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_TERMINATED'
            AND terminal.metadata->>'attemptId'=reservation.attempt_id
            AND terminal.metadata->>'stage'=reservation.stage
          WHERE reservation.account_id=$1 AND attempt.correlation_id=$2`,
        [accountId, secretFailureCorrelation],
      );
      assert.equal(secretFailureReservation.rows.length, 1);
      assert.equal(secretFailureReservation.rows[0].status, "FAILED");
      assert.equal(secretFailureReservation.rows[0].metadata.reason, "PRE_SEND_FAILED");
      assert.equal((await pool.query(
        `SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_capability_subcall_reservations
          WHERE account_id=$1 AND status IN ('PREPARED','SENDING')`, [accountId],
      )).rows[0].count, 0);
      await assert.rejects(profiles.publishProfile({
        accountId, actorId: accountId, profileId: secretFailure.profile.id, configVersion: 1,
        idempotencyKey: `publish-decrypt-failure-${suffix}`,
        correlationId: `publish-decrypt-failure-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_PROFILE_CAPABILITY_REQUIRED", status: 409 });

      const subcallWriteFailure = await createConnected("subcall-write-failure");
      const subcallWriteCorrelation = `subcall-write-failure-${suffix}`;
      const subcallTransports = [];
      await pool.query(`CREATE OR REPLACE FUNCTION reject_subcall_terminal_${suffix}()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action='AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_TERMINATED'
            AND NEW.correlation_id='${subcallWriteCorrelation}' THEN
            RAISE EXCEPTION 'forced subcall terminal persistence failure';
          END IF;
          RETURN NEW;
        END;
        $$`);
      await pool.query(`CREATE TRIGGER reject_subcall_terminal_${suffix}_trigger
        BEFORE INSERT ON audit_events FOR EACH ROW
        EXECUTE FUNCTION reject_subcall_terminal_${suffix}()`);
      const subcallWriteGateway = createSub2ApiAdapter({
        readSecret() { throw new Error("generic resolver must not authorize paid recovery"); },
        prepareCapabilitySubcall: (execution) => resolver.prepareSubcall(execution),
        resolveCapabilityCredential: (execution) => resolver.resolveCredential(execution),
        markCapabilitySubcallSending: (execution) => resolver.markSending(execution),
        completeCapabilitySubcall: (execution, outcome, reason) => resolver.completeSubcall(execution, outcome, reason),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        allowedSecretEnvNames: ["SUB2API_ENCRYPTED_KEY"],
        allowedGatewayBaseUrls: ["https://gateway.example.test/v1"],
        fetchImpl: async (url, init) => {
          subcallTransports.push({ url: String(url), requestKey: init.headers["Idempotency-Key"],
            correlationId: init.headers["X-Correlation-Id"] });
          if (String(url).endsWith("/models")) return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200, headers: { "content-type": "application/json" },
          });
          if (String(url).endsWith("/responses")) return new Response(JSON.stringify({
            id: "text-subcall-recovery", output: [{ type: "message",
              content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
          }), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ id: "image-subcall-recovery", data: [{
            b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          }] }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      const subcallWriteService = createAiGatewayProfileService({
        repository: profiles, gateway: subcallWriteGateway,
      });
      const subcallWriteInput = { actor: { id: accountId, role: "admin" },
        profileId: subcallWriteFailure.profile.id, configVersion: 1,
        correlationId: subcallWriteCorrelation, costConfirmed: true };
      await assert.rejects(subcallWriteService.testGatewayCapabilities(subcallWriteInput), {
        code: "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN", status: 409,
      });
      assert.equal(subcallTransports.length, 1);
      const ambiguousAttempt = await pool.query(
        `SELECT attempt.id,attempt.status,reservation.status AS reservation_status,
                attempt.request_key,reservation.provider_request_key,
                reservation.provider_correlation_id,reservation.ever_sending_at
           FROM ai_gateway_capability_attempts attempt
           JOIN ai_gateway_capability_subcall_reservations reservation
             ON reservation.account_id=attempt.account_id AND reservation.attempt_id=attempt.id
          WHERE attempt.account_id=$1 AND attempt.correlation_id=$2`,
        [accountId, subcallWriteCorrelation],
      );
      assert.equal(ambiguousAttempt.rows[0].status, "RUNNING");
      assert.equal(ambiguousAttempt.rows[0].reservation_status, "SENDING");
      assert.ok(ambiguousAttempt.rows[0].ever_sending_at instanceof Date);
      assert.equal(ambiguousAttempt.rows[0].provider_request_key, subcallTransports[0].requestKey);
      assert.equal(ambiguousAttempt.rows[0].provider_correlation_id, subcallTransports[0].correlationId);
      await assert.rejects(profiles.publishProfile({
        accountId, actorId: accountId, profileId: subcallWriteFailure.profile.id, configVersion: 1,
        idempotencyKey: `publish-ambiguous-subcall-${suffix}`,
        correlationId: `publish-ambiguous-subcall-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", status: 409 });
      await assert.rejects(subcallWriteService.testGatewayCapabilities(subcallWriteInput), {
        code: "AI_GATEWAY_CAPABILITY_IN_PROGRESS", status: 409,
      });
      assert.equal(subcallTransports.length, 1);
      await pool.query(`DROP TRIGGER reject_subcall_terminal_${suffix}_trigger ON audit_events`);
      await pool.query(`DROP FUNCTION reject_subcall_terminal_${suffix}()`);
      const subcallFaultClient = await pool.connect();
      try {
        await subcallFaultClient.query("SET session_replication_role='replica'");
        await subcallFaultClient.query(
          "UPDATE ai_gateway_capability_attempts SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND id=$2",
          [accountId, ambiguousAttempt.rows[0].id],
        );
      } finally {
        await subcallFaultClient.query("SET session_replication_role='origin'").catch(() => {});
        subcallFaultClient.release();
      }
      let recoveredSecretFailureFetches = 0;
      const recoveredSecretFailureResolver = createAutoListingAiCapabilityCredentialResolver({
        repository: profiles,
        cipher: { async decrypt() { throw new Error("forced recovered secret failure"); } },
        readSecret() { return undefined; },
      });
      const recoveredSecretFailureGateway = createSub2ApiAdapter({
        readSecret() { throw new Error("generic resolver must not authorize recovered paid work"); },
        prepareCapabilitySubcall: (execution) => recoveredSecretFailureResolver.prepareSubcall(execution),
        resolveCapabilityCredential: (execution) => recoveredSecretFailureResolver.resolveCredential(execution),
        markCapabilitySubcallSending: (execution) => recoveredSecretFailureResolver.markSending(execution),
        completeCapabilitySubcall: (execution, outcome, reason) =>
          recoveredSecretFailureResolver.completeSubcall(execution, outcome, reason),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        allowedSecretEnvNames: ["SUB2API_ENCRYPTED_KEY"],
        allowedGatewayBaseUrls: ["https://gateway.example.test/v1"],
        fetchImpl: async () => {
          recoveredSecretFailureFetches += 1;
          throw new Error("recovered secret failure must not reach provider transport");
        },
      });
      const recoveredSecretFailureService = createAiGatewayProfileService({
        repository: profiles, gateway: recoveredSecretFailureGateway,
      });
      await assert.rejects(recoveredSecretFailureService.testGatewayCapabilities(subcallWriteInput), {
        code: "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN", status: 409,
      });
      assert.equal(recoveredSecretFailureFetches, 0);
      const reclaimedSending = await pool.query(
        `SELECT reservation.status,reservation.lease_version,reservation.ever_sending_at,
                reservation.provider_request_key,reservation.provider_correlation_id,attempt.status AS attempt_status
           FROM ai_gateway_capability_subcall_reservations reservation
           JOIN ai_gateway_capability_attempts attempt
             ON attempt.account_id=reservation.account_id AND attempt.id=reservation.attempt_id
          WHERE reservation.account_id=$1 AND reservation.attempt_id=$2
            AND reservation.stage='REACHABILITY'`,
        [accountId, ambiguousAttempt.rows[0].id],
      );
      assert.equal(reclaimedSending.rows[0].status, "SENDING",
        "an unresolved provider send must never reclaim as PREPARED");
      assert.equal(Number(reclaimedSending.rows[0].lease_version), 2);
      assert.equal(reclaimedSending.rows[0].attempt_status, "RUNNING");
      assert.ok(reclaimedSending.rows[0].ever_sending_at instanceof Date);
      assert.equal(reclaimedSending.rows[0].provider_request_key,
        ambiguousAttempt.rows[0].provider_request_key);
      assert.equal(reclaimedSending.rows[0].provider_correlation_id,
        ambiguousAttempt.rows[0].provider_correlation_id);
      await assert.rejects(pool.query(
        `UPDATE ai_gateway_capability_subcall_reservations
            SET lease_version=lease_version+1,reservation_version=reservation_version+1,
                status='PREPARED',prepared_at=NOW(),sending_at=NULL,completed_at=NULL
          WHERE account_id=$1 AND attempt_id=$2 AND stage='REACHABILITY'`,
        [accountId, ambiguousAttempt.rows[0].id],
      ), { code: "23514" });
      await assert.rejects(pool.query(
        `UPDATE ai_gateway_capability_subcall_reservations
            SET status='FAILED',completed_at=NOW(),terminal_reason='PRE_SEND_FAILED'
          WHERE account_id=$1 AND attempt_id=$2 AND stage='REACHABILITY'`,
        [accountId, ambiguousAttempt.rows[0].id],
      ), { code: "23514" });
      const secondCrashClient = await pool.connect();
      try {
        await secondCrashClient.query("SET session_replication_role='replica'");
        await secondCrashClient.query(
          "UPDATE ai_gateway_capability_attempts SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND id=$2",
          [accountId, ambiguousAttempt.rows[0].id],
        );
      } finally {
        await secondCrashClient.query("SET session_replication_role='origin'").catch(() => {});
        secondCrashClient.release();
      }
      await assert.rejects(profiles.publishProfile({
        accountId, actorId: accountId, profileId: subcallWriteFailure.profile.id, configVersion: 1,
        idempotencyKey: `publish-after-double-crash-${suffix}`,
        correlationId: `publish-after-double-crash-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", status: 409 });
      const preservedAmbiguity = await pool.query(
        `SELECT reservation.status,reservation.ever_sending_at,
                COUNT(cleanup.event_id)::INTEGER AS cleanup_count
           FROM ai_gateway_capability_subcall_reservations reservation
           LEFT JOIN audit_events cleanup
             ON cleanup.account_id=reservation.account_id
            AND cleanup.actor_type='system' AND cleanup.actor_id='expired-prepared-cleanup'
            AND cleanup.metadata->>'attemptId'=reservation.attempt_id
            AND cleanup.metadata->>'stage'=reservation.stage
          WHERE reservation.account_id=$1 AND reservation.attempt_id=$2
            AND reservation.stage='REACHABILITY'
          GROUP BY reservation.status,reservation.ever_sending_at`,
        [accountId, ambiguousAttempt.rows[0].id],
      );
      assert.equal(preservedAmbiguity.rows[0].status, "SENDING");
      assert.ok(preservedAmbiguity.rows[0].ever_sending_at instanceof Date);
      assert.equal(preservedAmbiguity.rows[0].cleanup_count, 0,
        "expired PREPARED cleanup must never rewrite a stage that reached provider sending");
      const subcallRecovered = await subcallWriteService.testGatewayCapabilities(subcallWriteInput);
      assert.equal(subcallRecovered.outcome, "PASSED");
      assert.equal(subcallTransports.length, 4);
      assert.equal(subcallTransports[0].requestKey, subcallTransports[1].requestKey);
      assert.equal(subcallTransports[0].correlationId, subcallTransports[1].correlationId);
      assert.equal(new Set(subcallTransports.map(({ requestKey }) => requestKey)).size, 3);
      assert.equal(new Set(subcallTransports.map(({ correlationId }) => correlationId)).size, 3);
      await profiles.publishProfile({
        accountId, actorId: accountId, profileId: subcallWriteFailure.profile.id, configVersion: 1,
        idempotencyKey: `publish-recovered-subcall-${suffix}`,
        correlationId: `publish-recovered-subcall-corr-${suffix}`,
      });

      const commitResponseLoss = await createConnected("subcall-commit-response-loss");
      let loseTerminalCommitResponse = true;
      const responseLossPool = {
        async connect() {
          const client = await pool.connect();
          let terminalCommitArmed = false;
          return {
            async query(sql, params = []) {
              if (/UPDATE ai_gateway_capability_subcall_reservations[\s\S]*SET status=\$5/iu.test(sql)
                && params[4] === "SUCCEEDED" && loseTerminalCommitResponse) terminalCommitArmed = true;
              const result = await client.query(sql, params);
              if (sql === "COMMIT" && terminalCommitArmed && loseTerminalCommitResponse) {
                loseTerminalCommitResponse = false;
                terminalCommitArmed = false;
                throw new Error("forced committed response loss");
              }
              return result;
            },
            release() { client.release(); },
          };
        },
        async query(sql, params = []) { return pool.query(sql, params); },
      };
      const responseLossProfiles = createAutoListingAiAdminPostgres({ pool: responseLossPool });
      const responseLossResolver = createAutoListingAiCapabilityCredentialResolver({
        repository: responseLossProfiles,
        cipher: { async decrypt() { return "paid-test-secret"; } },
        readSecret() { return undefined; },
      });
      const responseLossTransports = [];
      const responseLossGateway = createSub2ApiAdapter({
        readSecret() { throw new Error("generic resolver must not authorize paid response-loss work"); },
        prepareCapabilitySubcall: (execution) => responseLossResolver.prepareSubcall(execution),
        resolveCapabilityCredential: (execution) => responseLossResolver.resolveCredential(execution),
        markCapabilitySubcallSending: (execution) => responseLossResolver.markSending(execution),
        completeCapabilitySubcall: (execution, outcome, reason) =>
          responseLossResolver.completeSubcall(execution, outcome, reason),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        allowedSecretEnvNames: ["SUB2API_ENCRYPTED_KEY"],
        allowedGatewayBaseUrls: ["https://gateway.example.test/v1"],
        fetchImpl: async (url, init) => {
          responseLossTransports.push(init.headers["Idempotency-Key"]);
          if (String(url).endsWith("/models")) return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200, headers: { "content-type": "application/json" },
          });
          if (String(url).endsWith("/responses")) return new Response(JSON.stringify({
            id: "text-commit-loss", output: [{ type: "message",
              content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
          }), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ id: "image-commit-loss", data: [{
            b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          }] }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      const responseLossService = createAiGatewayProfileService({
        repository: responseLossProfiles, gateway: responseLossGateway,
      });
      const responseLossCorrelation = `subcall-commit-response-loss-${suffix}`;
      const responseLossResult = await responseLossService.testGatewayCapabilities({
        actor: { id: accountId, role: "admin" }, profileId: commitResponseLoss.profile.id,
        configVersion: 1, correlationId: responseLossCorrelation, costConfirmed: true,
      });
      assert.equal(responseLossResult.outcome, "PASSED");
      assert.equal(loseTerminalCommitResponse, false);
      assert.equal(responseLossTransports.length, 3);
      assert.equal(new Set(responseLossTransports).size, 3);
      const responseLossTerminal = await pool.query(
        `SELECT COUNT(*)::INTEGER AS count
           FROM ai_gateway_capability_subcall_reservations reservation
           JOIN ai_gateway_capability_attempts attempt
             ON attempt.account_id=reservation.account_id AND attempt.id=reservation.attempt_id
           JOIN audit_events terminal
             ON terminal.account_id=reservation.account_id
            AND terminal.action='AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_TERMINATED'
            AND terminal.metadata->>'attemptId'=reservation.attempt_id
            AND terminal.metadata->>'stage'=reservation.stage
          WHERE reservation.account_id=$1 AND attempt.correlation_id=$2
            AND reservation.status='SUCCEEDED'`,
        [accountId, responseLossCorrelation],
      );
      assert.equal(responseLossTerminal.rows[0].count, 3);

      const prepareCommitLoss = await createConnected("prepare-commit-loss");
      let losePreparedCommitResponse = true;
      const prepareLossPool = {
        async connect() {
          const client = await pool.connect();
          let preparedCommitArmed = false;
          return {
            async query(sql, params = []) {
              if (/INSERT INTO ai_gateway_capability_subcall_reservations/iu.test(sql)
                && losePreparedCommitResponse) preparedCommitArmed = true;
              const result = await client.query(sql, params);
              if (sql === "COMMIT" && preparedCommitArmed && losePreparedCommitResponse) {
                losePreparedCommitResponse = false;
                preparedCommitArmed = false;
                throw new Error("forced prepared commit response loss");
              }
              return result;
            },
            release() { client.release(); },
          };
        },
        async query(sql, params = []) { return pool.query(sql, params); },
      };
      const prepareLossProfiles = createAutoListingAiAdminPostgres({ pool: prepareLossPool });
      const prepareLossResolver = createAutoListingAiCapabilityCredentialResolver({
        repository: prepareLossProfiles,
        cipher: { async decrypt() { return "paid-test-secret"; } },
        readSecret() { return undefined; },
      });
      const prepareLossTransports = [];
      const prepareLossGateway = createSub2ApiAdapter({
        readSecret() { throw new Error("generic resolver must not authorize prepared response-loss work"); },
        prepareCapabilitySubcall: (execution) => prepareLossResolver.prepareSubcall(execution),
        resolveCapabilityCredential: (execution) => prepareLossResolver.resolveCredential(execution),
        markCapabilitySubcallSending: (execution) => prepareLossResolver.markSending(execution),
        completeCapabilitySubcall: (execution, outcome, reason) =>
          prepareLossResolver.completeSubcall(execution, outcome, reason),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        allowedSecretEnvNames: ["SUB2API_ENCRYPTED_KEY"],
        allowedGatewayBaseUrls: ["https://gateway.example.test/v1"],
        fetchImpl: async (url, init) => {
          prepareLossTransports.push(init.headers["Idempotency-Key"]);
          if (String(url).endsWith("/models")) return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200, headers: { "content-type": "application/json" },
          });
          if (String(url).endsWith("/responses")) return new Response(JSON.stringify({
            id: "text-prepare-loss", output: [{ type: "message",
              content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
          }), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ id: "image-prepare-loss", data: [{
            b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          }] }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      const prepareLossService = createAiGatewayProfileService({
        repository: prepareLossProfiles, gateway: prepareLossGateway,
      });
      const prepareLossResult = await prepareLossService.testGatewayCapabilities({
        actor: { id: accountId, role: "admin" }, profileId: prepareCommitLoss.profile.id,
        configVersion: 1, correlationId: `prepare-commit-loss-${suffix}`, costConfirmed: true,
      });
      assert.equal(prepareLossResult.outcome, "PASSED");
      assert.equal(losePreparedCommitResponse, false);
      assert.equal(prepareLossTransports.length, 3);
      assert.equal(new Set(prepareLossTransports).size, 3);

      const callerAbort = await createConnected("caller-abort");
      const callerAbortController = new AbortController();
      let callerAbortFetches = 0;
      const callerAbortGateway = createSub2ApiAdapter({
        readSecret() { throw new Error("generic resolver must not authorize aborted paid work"); },
        prepareCapabilitySubcall: (execution) => resolver.prepareSubcall(execution),
        resolveCapabilityCredential: (execution) => resolver.resolveCredential(execution),
        markCapabilitySubcallSending: (execution) => resolver.markSending(execution),
        completeCapabilitySubcall: (execution, outcome, reason) => resolver.completeSubcall(execution, outcome, reason),
        resolveHostname: async () => {
          callerAbortController.abort();
          return [{ address: "203.0.113.10", family: 4 }];
        },
        allowedSecretEnvNames: ["SUB2API_ENCRYPTED_KEY"],
        allowedGatewayBaseUrls: ["https://gateway.example.test/v1"],
        fetchImpl: async () => { callerAbortFetches += 1; throw new Error("must not fetch"); },
      });
      const callerAbortService = createAiGatewayProfileService({ repository: profiles, gateway: callerAbortGateway });
      const callerAbortCorrelation = `caller-abort-${suffix}`;
      const callerAbortResult = await callerAbortService.testGatewayCapabilities({
        actor: { id: accountId, role: "admin" }, profileId: callerAbort.profile.id,
        configVersion: 1, correlationId: callerAbortCorrelation, costConfirmed: true,
        signal: callerAbortController.signal,
      });
      assert.equal(callerAbortResult.outcome, "FAILED");
      assert.equal(callerAbortFetches, 0);
      const callerAbortStored = await pool.query(
        `SELECT reservation.status,terminal.metadata->>'reason' AS reason
           FROM ai_gateway_capability_attempts attempt
           JOIN ai_gateway_capability_subcall_reservations reservation
             ON reservation.account_id=attempt.account_id AND reservation.attempt_id=attempt.id
           JOIN audit_events terminal
             ON terminal.account_id=reservation.account_id
            AND terminal.action='AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_TERMINATED'
            AND terminal.metadata->>'attemptId'=reservation.attempt_id
            AND terminal.metadata->>'stage'=reservation.stage
          WHERE attempt.account_id=$1 AND attempt.correlation_id=$2`,
        [accountId, callerAbortCorrelation],
      );
      assert.deepEqual(callerAbortStored.rows, [{ status: "FAILED", reason: "PRE_SEND_ABORTED" }]);

      const unattendedPrepared = await createConnected("unattended-prepared");
      const unattendedAttemptId = `attempt-unattended-${suffix}`;
      const unattendedAttempt = await profiles.beginCapabilityTest({
        costConfirmed: true, accountId, actorId: accountId,
        profileId: unattendedPrepared.profile.id, configVersion: 1,
        correlationId: `unattended-${suffix}`, attemptId: unattendedAttemptId,
        purpose: "PROFILE_CAPABILITY", requestKey: requestKeyFor(unattendedAttemptId),
      });
      await profiles.loadCapabilityExecutionForSecretResolution({
        ...unattendedAttempt.capabilityExecution, probe: "REACHABILITY",
      });
      const unattendedClient = await pool.connect();
      try {
        await unattendedClient.query("SET session_replication_role='replica'");
        await unattendedClient.query(
          "UPDATE ai_gateway_capability_attempts SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND id=$2",
          [accountId, unattendedAttemptId],
        );
      } finally {
        await unattendedClient.query("SET session_replication_role='origin'").catch(() => {});
        unattendedClient.release();
      }
      const transitionAfterExpiry = await settings.markConnectionValidated({
        accountId, actorId: accountId, connectionId: transitionCandidate.id, connectionVersion: 1,
        expectedStatusVersion: 1, idempotencyKey: `validate-after-expired-prepared-${suffix}`,
        correlationId: `validate-after-expired-prepared-corr-${suffix}`, rollbackCapabilityEvidence: null,
        validationResult: { outcome: "PASSED", checkedAt: new Date().toISOString(), endpoint: "models" },
      });
      assert.equal(transitionAfterExpiry.status, "ACTIVE");
      const unattendedStored = await pool.query(
        `SELECT reservation.status,terminal.actor_type,terminal.actor_id,terminal.metadata->>'reason' AS reason
           FROM ai_gateway_capability_subcall_reservations reservation
           JOIN audit_events terminal
             ON terminal.account_id=reservation.account_id
            AND terminal.action='AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_TERMINATED'
            AND terminal.metadata->>'attemptId'=reservation.attempt_id
            AND terminal.metadata->>'stage'=reservation.stage
          WHERE reservation.account_id=$1 AND reservation.attempt_id=$2`,
        [accountId, unattendedAttemptId],
      );
      assert.deepEqual(unattendedStored.rows, [{ status: "FAILED", actor_type: "system",
        actor_id: "expired-prepared-cleanup", reason: "PRE_SEND_LEASE_EXPIRED" }]);
      await passCapability(unattendedPrepared, "PROFILE_CAPABILITY", "unattended-recovery");
      await profiles.publishProfile({
        accountId, actorId: accountId, profileId: unattendedPrepared.profile.id, configVersion: 1,
        idempotencyKey: `publish-unattended-recovery-${suffix}`,
        correlationId: `publish-unattended-recovery-corr-${suffix}`,
      });

      const crashReplay = await createConnected("provider-response-loss");
      let providerCalls = 0;
      const chargedRequestKeys = new Set();
      const replayGateway = createSub2ApiAdapter({
        readSecret() { throw new Error("generic resolver must not authorize paid replay"); },
        prepareCapabilitySubcall: (execution) => resolver.prepareSubcall(execution),
        resolveCapabilityCredential: (execution) => resolver.resolveCredential(execution),
        markCapabilitySubcallSending: (execution) => resolver.markSending(execution),
        completeCapabilitySubcall: (execution, outcome, reason) => resolver.completeSubcall(execution, outcome, reason),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        allowedSecretEnvNames: ["SUB2API_ENCRYPTED_KEY"],
        allowedGatewayBaseUrls: ["https://gateway.example.test/v1"],
        fetchImpl: async (url, init) => {
          providerCalls += 1;
          chargedRequestKeys.add(init.headers["Idempotency-Key"]);
          if (String(url).endsWith("/models")) return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200, headers: { "content-type": "application/json" },
          });
          if (String(url).endsWith("/responses")) return new Response(JSON.stringify({
            id: "text-replay", output: [{ type: "message",
              content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
          }), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ id: "image-replay", data: [{
            b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          }] }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      const replayService = createAiGatewayProfileService({ repository: profiles, gateway: replayGateway });
      const replayCorrelation = `provider-response-loss-${suffix}`;
      await pool.query(`CREATE OR REPLACE FUNCTION reject_capability_completion_${suffix}()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action='AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST'
            AND NEW.correlation_id='${replayCorrelation}' THEN
            RAISE EXCEPTION 'forced completion persistence failure';
          END IF;
          RETURN NEW;
        END;
        $$`);
      await pool.query(`CREATE TRIGGER reject_capability_completion_${suffix}_trigger
        BEFORE INSERT ON audit_events FOR EACH ROW
        EXECUTE FUNCTION reject_capability_completion_${suffix}()`);
      const replayInput = { actor: { id: accountId, role: "admin" },
        profileId: crashReplay.profile.id, configVersion: 1,
        correlationId: replayCorrelation, costConfirmed: true };
      await assert.rejects(replayService.testGatewayCapabilities(replayInput), {
        code: "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED",
      });
      assert.deepEqual({ providerCalls, charged: chargedRequestKeys.size }, { providerCalls: 3, charged: 3 });
      await assert.rejects(replayService.testGatewayCapabilities(replayInput), {
        code: "AI_GATEWAY_CAPABILITY_IN_PROGRESS", status: 409,
      });
      assert.deepEqual({ providerCalls, charged: chargedRequestKeys.size }, { providerCalls: 3, charged: 3 });
      const replayAttempt = await pool.query(
        `SELECT id,request_key FROM ai_gateway_capability_attempts
          WHERE account_id=$1 AND profile_id=$2 AND correlation_id=$3`,
        [accountId, crashReplay.profile.id, replayCorrelation],
      );
      await assert.rejects(profiles.beginCapabilityTest({
        costConfirmed: true, accountId, actorId: accountId, profileId: crashReplay.profile.id,
        configVersion: 1, correlationId: replayCorrelation, attemptId: replayAttempt.rows[0].id,
        purpose: "PROFILE_CAPABILITY", requestKey: "f".repeat(64),
      }), { code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", status: 409 });
      assert.equal(providerCalls, 3, "a conflicting persisted intent must not reach the provider");
      await pool.query(`DROP TRIGGER reject_capability_completion_${suffix}_trigger ON audit_events`);
      await pool.query(`DROP FUNCTION reject_capability_completion_${suffix}()`);
      const faultClient = await pool.connect();
      try {
        await faultClient.query("SET session_replication_role='replica'");
        await faultClient.query(
          "UPDATE ai_gateway_capability_attempts SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND id=$2",
          [accountId, replayAttempt.rows[0].id],
        );
      } finally {
        await faultClient.query("SET session_replication_role='origin'").catch(() => {});
        faultClient.release();
      }
      const recovered = await replayService.testGatewayCapabilities(replayInput);
      assert.equal(recovered.outcome, "PASSED");
      assert.deepEqual({ providerCalls, charged: chargedRequestKeys.size }, { providerCalls: 6, charged: 3 });
      assert.deepEqual(await replayService.testGatewayCapabilities(replayInput), recovered);
      assert.deepEqual({ providerCalls, charged: chargedRequestKeys.size }, { providerCalls: 6, charged: 3 });
      await assert.rejects(profiles.beginCapabilityTest({
        costConfirmed: true, accountId, actorId: accountId, profileId: crashReplay.profile.id,
        configVersion: 1, correlationId: `changed-payload-${suffix}`,
        attemptId: `changed-payload-attempt-${suffix}`, purpose: "PROFILE_CAPABILITY",
        requestKey: replayAttempt.rows[0].request_key,
      }), { code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", status: 409 });
      assert.deepEqual({ providerCalls, charged: chargedRequestKeys.size }, { providerCalls: 6, charged: 3 });
      const replayReservations = await pool.query(
        `SELECT stage,provider_request_key,reservation_version,status
           FROM ai_gateway_capability_subcall_reservations
          WHERE account_id=$1 AND attempt_id=$2 ORDER BY stage`,
        [accountId, replayAttempt.rows[0].id],
      );
      assert.equal(replayReservations.rows.length, 3);
      assert.equal(replayReservations.rows.every((row) => chargedRequestKeys.has(row.provider_request_key)
        && Number(row.reservation_version) === 2 && row.status === "SUCCEEDED"), true);

      const immutableAuthorization = await pool.query(
        `SELECT event_id FROM audit_events
          WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CAPABILITY_AUTHORIZED'
          ORDER BY created_at DESC LIMIT 1`,
        [accountId],
      );
      assert.equal(await rawRejectsCode(() => pool.query(
        "UPDATE audit_events SET status='FAILED' WHERE event_id=$1",
        [immutableAuthorization.rows[0].event_id],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        "UPDATE ai_gateway_capability_attempts SET request_key=$3 WHERE account_id=$1 AND id=$2",
        [accountId, replayAttempt.rows[0].id, "e".repeat(64)],
      ), "23514"), true);

      const privacyAccountId = `account-paid-privacy-${suffix}`;
      const privacyProfileId = `profile-paid-privacy-${suffix}`;
      const privacyAttemptId = `attempt-paid-privacy-${suffix}`;
      await pool.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'admin','active')",
        [privacyAccountId],
      );
      await pool.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled,created_by
         ) VALUES ($1,$2,'Privacy profile','https://gateway.example.test/v1','SUB2API_LEGACY_KEY',
           'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1,FALSE,$2)`,
        [privacyProfileId, privacyAccountId],
      );
      const privacyAttempt = await profiles.beginCapabilityTest({
        costConfirmed: true, accountId: privacyAccountId, actorId: privacyAccountId,
        profileId: privacyProfileId, configVersion: 1,
        correlationId: `privacy-paid-${suffix}`, attemptId: privacyAttemptId,
        purpose: "PROFILE_CAPABILITY", requestKey: requestKeyFor(privacyAttemptId),
      });
      await profiles.loadCapabilityExecutionForSecretResolution({
        ...privacyAttempt.capabilityExecution, probe: "REACHABILITY",
      });
      assert.equal((await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_capability_subcall_reservations WHERE account_id=$1",
        [privacyAccountId],
      )).rows[0].count, 1);
      assert.equal(await rawRejectsCode(() => pool.query(
        "DELETE FROM ai_gateway_capability_subcall_reservations WHERE account_id=$1",
        [privacyAccountId],
      ), "23514"), true);
      assert.equal(await rawRejectsCode(() => pool.query(
        "DELETE FROM ai_gateway_capability_attempts WHERE account_id=$1",
        [privacyAccountId],
      ), "23514"), true);
      await pool.query("DELETE FROM accounts WHERE id=$1", [privacyAccountId]);
      assert.equal((await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_capability_subcall_reservations WHERE account_id=$1",
        [privacyAccountId],
      )).rows[0].count, 0);
    } finally {
      try {
        await pool?.end();
        await admin.query("SET search_path TO public");
        await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
      } finally {
        admin.release();
        await adminPool.end();
      }
    }
  });

  test("054 quarantines legacy unknown RUNNING attempts and runtime blocks new paid correlation", {
    timeout: 60_000,
  }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 1 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_ai_legacy_attempt_${suffix}`;
    const schemaSql = quote(schema);
    const accountId = `account-legacy-attempt-${suffix}`;
    const profileId = `profile-legacy-attempt-${suffix}`;
    const attemptId = `attempt-legacy-unknown-${suffix}`;
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && file < "053_")
        .sort();
      for (const migration of migrations) {
        await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      await admin.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'admin','active')",
        [accountId],
      );
      await admin.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled,created_by
         ) VALUES ($1,$2,'Legacy profile','https://gateway.example.test/v1','SUB2API_LEGACY_KEY',
           'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1,FALSE,$2)`,
        [profileId, accountId],
      );
      await admin.query(
        `INSERT INTO ai_gateway_capability_attempts (
           id,account_id,profile_id,config_version,correlation_id,lease_token,lease_expires_at,status
         ) VALUES ($1,$2,$3,1,$4,$5,NOW()+INTERVAL '1 hour','RUNNING')`,
        [attemptId, accountId, profileId, `corr-legacy-unknown-${suffix}`, `caplease_legacy_${suffix}`],
      );
      for (const migration of [
        "053_auto_listing_ai_model_configuration.sql",
        "054_auto_listing_ai_capability_authorization.sql",
      ]) await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      await admin.query(`CREATE OR REPLACE FUNCTION auto_listing_reject_terminal_gateway_capability_attempt_mutation()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP='DELETE' OR OLD.status IN ('PASSED','FAILED','STALE') THEN
            RAISE EXCEPTION 'legacy 054 capability attempts are append-only' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END;
        $$`);
      await admin.query(await readFile(path.join(migrationsDir,
        "055_auto_listing_ai_capability_subcall_reservations.sql"), "utf8"));
      await admin.query(await readFile(path.join(migrationsDir,
        "056_auto_listing_ai_prepared_capability_recovery.sql"), "utf8"));

      const sentUpgradeAccountId = `account-sent-upgrade-${suffix}`;
      const sentUpgradeProfileId = `profile-sent-upgrade-${suffix}`;
      const sentUpgradeAttemptId = `attempt-sent-upgrade-${suffix}`;
      const sentUpgradeRequestKey = "b".repeat(64);
      await admin.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'admin','active')",
        [sentUpgradeAccountId],
      );
      await admin.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled,created_by
         ) VALUES ($1,$2,'Sent upgrade profile','https://gateway.example.test/v1','SUB2API_LEGACY_KEY',
           'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1,FALSE,$2)`,
        [sentUpgradeProfileId, sentUpgradeAccountId],
      );
      const sentUpgradeAttempt = await admin.query(
        `INSERT INTO ai_gateway_capability_attempts (
           id,account_id,profile_id,config_version,correlation_id,status,
           lease_version,lease_token,lease_expires_at,authorization_schema_version,
           purpose,cost_confirmed,authorization_hash,request_key,actor_id,
           target_connection_id,target_connection_version,target_connection_status,
           target_connection_status_version,authorized_at
         ) VALUES ($1,$2,$3,1,$4,'RUNNING',1,$5,NOW()-INTERVAL '1 second',
           'AI_GATEWAY_CAPABILITY_AUTHORIZATION_V1','PROFILE_CAPABILITY',TRUE,$6,$7,$2,
           NULL,NULL,'LEGACY',0,NOW())
         RETURNING fence`,
        [sentUpgradeAttemptId, sentUpgradeAccountId, sentUpgradeProfileId,
          `corr-sent-upgrade-${suffix}`, `caplease_sent_upgrade_${suffix}`, "a".repeat(64),
          sentUpgradeRequestKey],
      );
      const sentUpgradeProviderRequestKey = crypto.createHash("sha256").update(JSON.stringify({
        schemaVersion: "AI_GATEWAY_CAPABILITY_SUBCALL_V1",
        accountId: sentUpgradeAccountId,
        attemptId: sentUpgradeAttemptId,
        fence: Number(sentUpgradeAttempt.rows[0].fence),
        requestKey: sentUpgradeRequestKey,
        stage: "REACHABILITY",
      }), "utf8").digest("hex");
      const sentUpgradeProviderCorrelationId = `cap_${sentUpgradeProviderRequestKey.slice(0, 40)}`;
      const sentUpgradeSendingAt = new Date(Date.now() - 60_000).toISOString();
      await admin.query(
        `INSERT INTO ai_gateway_capability_subcall_reservations (
           id,account_id,attempt_id,profile_id,config_version,attempt_fence,lease_version,
           stage,status,provider_request_key,provider_correlation_id,prepared_at,sending_at
         ) VALUES ($1,$2,$3,$4,1,$5,1,'REACHABILITY','SENDING',$6,$7,$8,$8)`,
        [`reservation-sent-upgrade-${suffix}`, sentUpgradeAccountId, sentUpgradeAttemptId,
          sentUpgradeProfileId, sentUpgradeAttempt.rows[0].fence, sentUpgradeProviderRequestKey,
          sentUpgradeProviderCorrelationId, sentUpgradeSendingAt],
      );
      await admin.query(
        `INSERT INTO audit_events (
           event_id,account_id,action,status,actor_type,actor_id,source,entity_type,
           entity_id,correlation_id,metadata
         ) VALUES ($1,$2,'AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_SENDING','SUCCESS',
           'account',$2,'auto-listing-ai-admin','ai_gateway_profile',$3,$4,$5::JSONB)`,
        [`audit-sent-upgrade-${suffix}`, sentUpgradeAccountId, sentUpgradeProfileId,
          `corr-sent-upgrade-${suffix}`, JSON.stringify({
            requestHash: "e".repeat(64), attemptId: sentUpgradeAttemptId,
            stage: "REACHABILITY", providerRequestKey: sentUpgradeProviderRequestKey,
            providerRequestKeyHash: crypto.createHash("sha256").update(sentUpgradeProviderRequestKey).digest("hex"),
            providerCorrelationId: sentUpgradeProviderCorrelationId,
            leaseVersion: 1, reservationVersion: 1,
          })],
      );
      await admin.query(
        `UPDATE ai_gateway_capability_attempts
            SET lease_version=2,lease_token=$3,lease_expires_at=NOW()-INTERVAL '1 second'
          WHERE account_id=$1 AND id=$2`,
        [sentUpgradeAccountId, sentUpgradeAttemptId, `caplease_sent_upgrade_reclaimed_${suffix}`],
      );
      await admin.query(
        `UPDATE ai_gateway_capability_subcall_reservations
            SET lease_version=2,reservation_version=2,status='PREPARED',
                prepared_at=NOW(),sending_at=NULL,completed_at=NULL
          WHERE account_id=$1 AND attempt_id=$2`,
        [sentUpgradeAccountId, sentUpgradeAttemptId],
      );
      await admin.query(await readFile(path.join(migrationsDir,
        "057_auto_listing_ai_sent_reservation_recovery.sql"), "utf8"));
      const upgradedSending = await admin.query(
        `SELECT status,sending_at,ever_sending_at,
                auto_listing_cleanup_expired_prepared_capability_subcalls($1) AS cleaned_count
           FROM ai_gateway_capability_subcall_reservations
          WHERE account_id=$1 AND attempt_id=$2`,
        [sentUpgradeAccountId, sentUpgradeAttemptId],
      );
      assert.equal(upgradedSending.rows[0].status, "SENDING",
        "057 must reverse the old unsafe SENDING to PREPARED downgrade");
      assert.ok(upgradedSending.rows[0].sending_at instanceof Date);
      assert.ok(upgradedSending.rows[0].ever_sending_at instanceof Date,
        "057 must restore send evidence from the append-only SENDING audit after old reclaim erased sending_at");
      assert.equal(upgradedSending.rows[0].sending_at.toISOString(),
        upgradedSending.rows[0].ever_sending_at.toISOString());
      assert.equal(upgradedSending.rows[0].cleaned_count, 0);
      await assert.rejects(admin.query(
        `UPDATE ai_gateway_capability_subcall_reservations
            SET status='FAILED',completed_at=NOW(),terminal_reason='PRE_SEND_FAILED'
          WHERE account_id=$1 AND attempt_id=$2`,
        [sentUpgradeAccountId, sentUpgradeAttemptId],
      ), { code: "23514" });

      const quarantined = await admin.query(
        `SELECT status,authorization_schema_version,response->>'errorCode' AS error_code
           FROM ai_gateway_capability_attempts WHERE account_id=$1 AND id=$2`,
        [accountId, attemptId],
      );
      assert.deepEqual(quarantined.rows[0], {
        status: "STALE", authorization_schema_version: null,
        error_code: "AUTO_LISTING_AI_LEGACY_CAPABILITY_QUARANTINED",
      });
      const upgradeAudit = await admin.query(
        `SELECT actor_type,actor_id,metadata FROM audit_events
          WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CAPABILITY_UPGRADE_QUARANTINED'`,
        [accountId],
      );
      assert.equal(upgradeAudit.rows.length, 1);
      assert.equal(upgradeAudit.rows[0].actor_type, "system");
      assert.equal(upgradeAudit.rows[0].metadata.schemaVersion,
        "AI_GATEWAY_LEGACY_CAPABILITY_QUARANTINE_V1");
      assert.equal(Object.hasOwn(upgradeAudit.rows[0].metadata, "costConfirmed"), false);

      pool = new Pool({ connectionString, max: 2, options: `-c search_path=${schema},public` });
      const repository = createAutoListingAiAdminPostgres({ pool });
      const sentUpgradeReclaimed = await repository.beginCapabilityTest({
        costConfirmed: true, accountId: sentUpgradeAccountId, actorId: sentUpgradeAccountId,
        profileId: sentUpgradeProfileId, configVersion: 1,
        correlationId: `corr-sent-upgrade-${suffix}`, attemptId: sentUpgradeAttemptId,
        purpose: "PROFILE_CAPABILITY", requestKey: sentUpgradeRequestKey,
      });
      assert.equal(sentUpgradeReclaimed.reclaimed, true);
      let sentUpgradeNetworkCalls = 0;
      const sentUpgradeMissingResolver = createAutoListingAiCapabilityCredentialResolver({
        repository,
        cipher: { async decrypt() { throw new Error("legacy capability must not decrypt"); } },
        readSecret() { return undefined; },
      });
      const sentUpgradeMissingGateway = createSub2ApiAdapter({
        readSecret() { throw new Error("generic path must not authorize upgraded capability"); },
        prepareCapabilitySubcall: (execution) => sentUpgradeMissingResolver.prepareSubcall(execution),
        resolveCapabilityCredential: (execution) => sentUpgradeMissingResolver.resolveCredential(execution),
        markCapabilitySubcallSending: (execution) => sentUpgradeMissingResolver.markSending(execution),
        completeCapabilitySubcall: (execution, outcome, reason) =>
          sentUpgradeMissingResolver.completeSubcall(execution, outcome, reason),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        allowedSecretEnvNames: ["SUB2API_LEGACY_KEY"],
        allowedGatewayBaseUrls: ["https://gateway.example.test/v1"],
        fetchImpl: async () => {
          sentUpgradeNetworkCalls += 1;
          throw new Error("missing upgraded secret must not reach transport");
        },
      });
      await assert.rejects(sentUpgradeMissingGateway.testCapabilities({
        profile: sentUpgradeReclaimed.profile, timeoutMs: 500,
        capabilityExecution: sentUpgradeReclaimed.capabilityExecution,
      }), { code: "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN", status: 409 });
      assert.equal(sentUpgradeNetworkCalls, 0);
      const sentUpgradeStillUnknown = await pool.query(
        `SELECT attempt.status AS attempt_status,reservation.status AS reservation_status,
                reservation.ever_sending_at,reservation.provider_request_key
           FROM ai_gateway_capability_attempts attempt
           JOIN ai_gateway_capability_subcall_reservations reservation
             ON reservation.account_id=attempt.account_id AND reservation.attempt_id=attempt.id
          WHERE attempt.account_id=$1 AND attempt.id=$2 AND reservation.stage='REACHABILITY'`,
        [sentUpgradeAccountId, sentUpgradeAttemptId],
      );
      assert.equal(sentUpgradeStillUnknown.rows[0].attempt_status, "RUNNING");
      assert.equal(sentUpgradeStillUnknown.rows[0].reservation_status, "SENDING");
      assert.ok(sentUpgradeStillUnknown.rows[0].ever_sending_at instanceof Date);
      assert.equal(sentUpgradeStillUnknown.rows[0].provider_request_key, sentUpgradeProviderRequestKey);

      const sentUpgradeTransports = [];
      const sentUpgradeResolver = createAutoListingAiCapabilityCredentialResolver({
        repository,
        cipher: { async decrypt() { throw new Error("legacy capability must not decrypt"); } },
        readSecret() { return "paid-test-secret"; },
      });
      const sentUpgradeGateway = createSub2ApiAdapter({
        readSecret() { throw new Error("generic path must not authorize upgraded capability"); },
        prepareCapabilitySubcall: (execution) => sentUpgradeResolver.prepareSubcall(execution),
        resolveCapabilityCredential: (execution) => sentUpgradeResolver.resolveCredential(execution),
        markCapabilitySubcallSending: (execution) => sentUpgradeResolver.markSending(execution),
        completeCapabilitySubcall: (execution, outcome, reason) =>
          sentUpgradeResolver.completeSubcall(execution, outcome, reason),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        allowedSecretEnvNames: ["SUB2API_LEGACY_KEY"],
        allowedGatewayBaseUrls: ["https://gateway.example.test/v1"],
        fetchImpl: async (url, init) => {
          sentUpgradeTransports.push(init.headers["Idempotency-Key"]);
          if (String(url).endsWith("/models")) return new Response(JSON.stringify({
            object: "list", data: [{ id: "text-model" }, { id: "image-model" }],
          }), { status: 200, headers: { "content-type": "application/json" } });
          if (String(url).endsWith("/responses")) return new Response(JSON.stringify({
            id: "text-sent-upgrade", output: [{ type: "message",
              content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
          }), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ id: "image-sent-upgrade", data: [{
            b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          }] }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      const sentUpgradeCapability = await sentUpgradeGateway.testCapabilities({
        profile: sentUpgradeReclaimed.profile, timeoutMs: 500,
        capabilityExecution: sentUpgradeReclaimed.capabilityExecution,
      });
      assert.equal(sentUpgradeTransports.length, 3);
      assert.equal(sentUpgradeTransports[0], sentUpgradeProviderRequestKey);
      const sentUpgradeCheckedAt = new Date().toISOString();
      const sentUpgradeCompleted = await repository.completeCapabilityTest({
        costConfirmed: true, accountId: sentUpgradeAccountId, actorId: sentUpgradeAccountId,
        profileId: sentUpgradeProfileId, configVersion: 1,
        correlationId: `corr-sent-upgrade-${suffix}`, attemptId: sentUpgradeAttemptId,
        fence: sentUpgradeReclaimed.fence, leaseVersion: sentUpgradeReclaimed.leaseVersion,
        leaseToken: sentUpgradeReclaimed.leaseToken, purpose: "PROFILE_CAPABILITY",
        requestKey: sentUpgradeRequestKey, capabilityResult: {
          outcome: "PASSED", features: sentUpgradeCapability.features,
          latencyMs: sentUpgradeCapability.latencyMs, models: sentUpgradeCapability.models,
          checkedAt: sentUpgradeCheckedAt, errorCode: null,
        },
      });
      assert.equal(sentUpgradeCompleted.applied, true);
      const sentUpgradePublished = await repository.publishProfile({
        accountId: sentUpgradeAccountId, actorId: sentUpgradeAccountId,
        profileId: sentUpgradeProfileId, configVersion: 1,
        idempotencyKey: `publish-sent-upgrade-${suffix}`,
        correlationId: `publish-sent-upgrade-corr-${suffix}`,
      });
      assert.equal(sentUpgradePublished.enabled, true);

      await assert.rejects(repository.beginCapabilityTest({
        costConfirmed: true, accountId, actorId: accountId, profileId, configVersion: 1,
        correlationId: `corr-new-paid-${suffix}`, attemptId: `attempt-new-paid-${suffix}`,
        purpose: "PROFILE_CAPABILITY", requestKey: requestKeyFor(`attempt-new-paid-${suffix}`),
      }), { code: "AUTO_LISTING_AI_ADMIN_LEGACY_CAPABILITY_QUARANTINED", status: 409 });
      const attempts = await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_capability_attempts WHERE account_id=$1 AND profile_id=$2",
        [accountId, profileId],
      );
      assert.equal(attempts.rows[0].count, 1);

      const runtimeAttemptId = `attempt-runtime-legacy-${suffix}`;
      await pool.query(
        "ALTER TABLE ai_gateway_capability_attempts DISABLE TRIGGER ai_gateway_capability_attempts_authorized_insert",
      );
      try {
        await pool.query(
          `INSERT INTO ai_gateway_capability_attempts (
             id,account_id,profile_id,config_version,correlation_id,lease_token,lease_expires_at,status
           ) VALUES ($1,$2,$3,1,$4,$5,NOW()+INTERVAL '1 hour','RUNNING')`,
          [runtimeAttemptId, accountId, profileId,
            `corr-runtime-legacy-${suffix}`, `caplease_runtime_legacy_${suffix}`],
        );
      } finally {
        await pool.query(
          "ALTER TABLE ai_gateway_capability_attempts ENABLE TRIGGER ai_gateway_capability_attempts_authorized_insert",
        );
      }
      await assert.rejects(repository.beginCapabilityTest({
        costConfirmed: true, accountId, actorId: accountId, profileId, configVersion: 1,
        correlationId: `corr-runtime-new-${suffix}`, attemptId: `attempt-runtime-new-${suffix}`,
        purpose: "PROFILE_CAPABILITY", requestKey: requestKeyFor(`attempt-runtime-new-${suffix}`),
      }), { code: "AUTO_LISTING_AI_ADMIN_LEGACY_CAPABILITY_QUARANTINED", status: 409 });
      const runtimeQuarantined = await pool.query(
        `SELECT status,response->>'errorCode' AS error_code
           FROM ai_gateway_capability_attempts WHERE account_id=$1 AND id=$2`,
        [accountId, runtimeAttemptId],
      );
      assert.deepEqual(runtimeQuarantined.rows[0], {
        status: "STALE", error_code: "AUTO_LISTING_AI_LEGACY_CAPABILITY_QUARANTINED",
      });
      const runtimeAudit = await pool.query(
        `SELECT actor_type,actor_id FROM audit_events
          WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_CAPABILITY_UPGRADE_QUARANTINED'
            AND metadata->>'attemptId'=$2`,
        [accountId, runtimeAttemptId],
      );
      assert.deepEqual(runtimeAudit.rows[0], { actor_type: "system", actor_id: "runtime-quarantine" });

      const upgradedDeleteAccountId = `account-upgraded-delete-${suffix}`;
      const upgradedDeleteProfileId = `profile-upgraded-delete-${suffix}`;
      const upgradedDeleteAttemptId = `attempt-upgraded-delete-${suffix}`;
      await pool.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'admin','active')",
        [upgradedDeleteAccountId],
      );
      await pool.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled,created_by
         ) VALUES ($1,$2,'Upgraded delete','https://gateway.example.test/v1','SUB2API_LEGACY_KEY',
           'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1,FALSE,$2)`,
        [upgradedDeleteProfileId, upgradedDeleteAccountId],
      );
      const upgradedDeleteAttempt = await repository.beginCapabilityTest({
        costConfirmed: true, accountId: upgradedDeleteAccountId, actorId: upgradedDeleteAccountId,
        profileId: upgradedDeleteProfileId, configVersion: 1,
        correlationId: `corr-upgraded-delete-${suffix}`, attemptId: upgradedDeleteAttemptId,
        purpose: "PROFILE_CAPABILITY", requestKey: requestKeyFor(upgradedDeleteAttemptId),
      });
      await repository.loadCapabilityExecutionForSecretResolution({
        ...upgradedDeleteAttempt.capabilityExecution, probe: "REACHABILITY",
      });
      await pool.query("DELETE FROM accounts WHERE id=$1", [upgradedDeleteAccountId]);
      assert.equal((await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_gateway_capability_subcall_reservations WHERE account_id=$1",
        [upgradedDeleteAccountId],
      )).rows[0].count, 0);
    } finally {
      try {
        await pool?.end();
        await admin.query("SET search_path TO public");
        await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
      } finally {
        admin.release();
        await adminPool.end();
      }
    }
  });

  test("category publication replaces one exact scope while preserving the immutable account bundle", {
    timeout: 90_000,
  }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 1 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `category_publish_${suffix}`;
    const schemaSql = quote(schema);
    const accountA = `account-a-${suffix}`;
    const accountB = `account-b-${suffix}`;
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
      for (const migration of migrations) await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      for (const accountId of [accountA, accountB]) {
        await admin.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [accountId, `user-${accountId}`],
        );
      }
      const draft = await seedPublishableCategoryDraft(admin, {
        accountId: accountA, suffix, descriptionCategoryId: 170, typeId: 99,
      });
      const manualResultId = `zz-manual-result-${suffix}`;
      const manualGuidance = { ...draft.guidance, overallStyle: "Проверенный вручную стиль категории" };
      await admin.query(
        `INSERT INTO auto_listing_category_strategy_analysis_results
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,
            sample_set_hash,analysis_input_hash,raw_response,raw_response_hash,guidance,guidance_hash,
            source_kind,edited_by,edited_at,base_analysis_attempt_id,
            idempotency_key,correlation_id,request_hash,actor_account_id)
         SELECT $1,account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_id,
           sample_set_hash,analysis_input_hash,jsonb_build_object('sourceKind','MANUAL','baseAnalysisAttemptId',id),
           $2,$3::JSONB,$4,'MANUAL',account_id,NOW(),id,$5,$6,$7,account_id
           FROM auto_listing_category_strategy_analysis_attempts WHERE account_id=$8 AND id=$9`,
        [manualResultId, crypto.createHash("sha256").update(`manual-raw-${suffix}`).digest("hex"),
          JSON.stringify(manualGuidance), crypto.createHash("sha256")
            .update(JSON.stringify(manualGuidance)).digest("hex"), `manual-result-key-${suffix}`,
          `manual-result-correlation-${suffix}`, crypto.createHash("sha256")
            .update(`manual-result-request-${suffix}`).digest("hex"),
          accountA, draft.attemptId],
      );
      await admin.query(
        `UPDATE auto_listing_category_strategy_drafts
            SET draft_version=5,status='DRAFT_READY',updated_at=NOW()
          WHERE account_id=$1 AND id=$2 AND draft_version=4`,
        [accountA, draft.draftId],
      );
      await admin.query(
        `INSERT INTO auto_listing_category_strategy_events
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,event_type,event_payload,
            idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,'DRAFT_EVENT',$4::JSONB,$5,$6,$7,$2)`,
        [`manual-result-event-${suffix}`, accountA, draft.draftId,
          JSON.stringify({ event: "ANALYSIS_MANUAL_EDITED", draftVersion: 5, status: "DRAFT_READY",
            attemptId: draft.attemptId, resultId: manualResultId }), `manual-result-event-key-${suffix}`,
          `manual-result-event-correlation-${suffix}`, crypto.createHash("sha256")
            .update(`manual-result-event-${suffix}`).digest("hex")],
      );
      const unselectedGuidance = { ...manualGuidance, overallStyle: "Невыбранная более поздняя строка" };
      await admin.query(
        `INSERT INTO auto_listing_category_strategy_analysis_results
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,
            sample_set_hash,analysis_input_hash,raw_response,raw_response_hash,guidance,guidance_hash,
            source_kind,edited_by,edited_at,base_analysis_attempt_id,
            idempotency_key,correlation_id,request_hash,actor_account_id)
         SELECT $1,account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_id,
           sample_set_hash,analysis_input_hash,jsonb_build_object('sourceKind','MANUAL','baseAnalysisAttemptId',id),
           $2,$3::JSONB,$4,'MANUAL',account_id,NOW()+INTERVAL '1 second',id,$5,$6,$7,account_id
           FROM auto_listing_category_strategy_analysis_attempts WHERE account_id=$8 AND id=$9`,
        [`zzz-unselected-result-${suffix}`, crypto.createHash("sha256").update(`unselected-raw-${suffix}`).digest("hex"),
          JSON.stringify(unselectedGuidance), crypto.createHash("sha256")
            .update(JSON.stringify(unselectedGuidance)).digest("hex"), `unselected-result-key-${suffix}`,
          `unselected-result-correlation-${suffix}`, crypto.createHash("sha256")
            .update(`unselected-result-request-${suffix}`).digest("hex"), accountA, draft.attemptId],
      );
      const reverseDraft = await seedPublishableCategoryDraft(admin, {
        accountId: accountA, suffix: `reverse-${suffix}`, descriptionCategoryId: 172, typeId: 101,
      });
      const currentId = `current-account-strategy-${suffix}`;
      const currentContent = { schemaVersion: "V2" };
      await admin.query(
        `INSERT INTO ai_content_strategy_versions
           (id,account_id,strategy_key,version,status,content,content_hash,published_at,published_by,created_by)
         VALUES ($1,$2,'default',7,'DRAFT',$3::JSONB,$4,NULL,NULL,$2)`,
        [currentId, accountA, JSON.stringify(currentContent), crypto.createHash("sha256").update("current").digest("hex")],
      );
      const oldARule = {
        ruleId: `old-a-${suffix}`, matchType: "EXACT_CATEGORY_TYPE_V2",
        scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 170, typeId: 99 },
        overallStyle: "old A", prohibitedPatterns: [], roleGuidance: categoryGuidance("old-a").roles,
        sampleSetHash: "a".repeat(64), analysisAttemptId: `old-attempt-a-${suffix}`,
        analysisResultId: `old-result-a-${suffix}`,
      };
      const bRule = {
        ruleId: `rule-b-${suffix}`, matchType: "EXACT_CATEGORY_TYPE_V2",
        scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 171, typeId: 100 },
        overallStyle: "B remains", prohibitedPatterns: [], roleGuidance: categoryGuidance("b").roles,
        sampleSetHash: "b".repeat(64), analysisAttemptId: `attempt-b-${suffix}`,
        analysisResultId: `result-b-${suffix}`,
      };
      for (const [index, rule] of [oldARule, bRule].entries()) {
        await admin.query(
          `INSERT INTO ai_content_strategy_rules
             (id,account_id,strategy_version_id,rule_kind,rule_order,category_id,rule)
           VALUES ($1,$2,$3,'EXACT_CATEGORY',$4,$5,$6::JSONB)`,
          [`db-rule-${index}-${suffix}`, accountA, currentId, index + 1,
            String(rule.scope.descriptionCategoryId), JSON.stringify(rule)],
        );
      }
      const legacyRule = {
        ruleId: `legacy-rule-${suffix}`, ruleOrder: 3, matchType: "PRODUCT_STYLE",
        productStyle: "GENERAL", style: "BALANCED_DEFAULT",
        textDensityByRole: { MAIN: "NONE", SELLING_POINT: "LIGHT" },
      };
      await admin.query(
        `INSERT INTO ai_content_strategy_rules
           (id,account_id,strategy_version_id,rule_kind,rule_order,product_style,rule)
         VALUES ($1,$2,$3,'PRODUCT_STYLE',3,'GENERAL',$4::JSONB)`,
        [`db-legacy-rule-${suffix}`, accountA, currentId, JSON.stringify({
          ruleId: legacyRule.ruleId, style: legacyRule.style,
          textDensityByRole: legacyRule.textDensityByRole,
        })],
      );
      await admin.query(
        `UPDATE ai_content_strategy_versions
            SET status='PUBLISHED',published_at=NOW(),published_by=$2
          WHERE account_id=$2 AND id=$1`,
        [currentId, accountA],
      );
      pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });
      const repository = createAutoListingAiAdminPostgres({ pool });
      const base = {
        accountId: accountA, actorId: accountA, draftId: draft.draftId, expectedDraftVersion: 5,
        expectedPublishedStrategyVersionId: currentId,
      };
      const categoryLedgerKeys = [
        ["create", "DRAFT_CREATED"],
        ["session", "SAMPLING_SESSION_STARTED"],
        ["commit", "SAMPLE_SET_COMMITTED"],
      ].map(([label, event]) => ({
        label, event, idempotencyKey: `category-ledger-${label}-${suffix}`,
      }));
      for (const command of categoryLedgerKeys) {
        await pool.query(
          `INSERT INTO auto_listing_category_strategy_events
             (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,event_type,event_payload,
              idempotency_key,correlation_id,request_hash,actor_account_id)
           VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,'DRAFT_EVENT',$4::JSONB,$5,$6,$7,$2)`,
          [`category-ledger-${command.label}-event-${suffix}`, accountA, draft.draftId,
            JSON.stringify({ event: command.event }), command.idempotencyKey,
            `category-ledger-${command.label}-corr-${suffix}`, crypto.createHash("sha256")
              .update(`category-ledger-${command.label}`).digest("hex")],
        );
      }
      const policyLedgerKey = `category-ledger-policy-${suffix}`;
      await pool.query(
        `UPDATE auto_listing_category_strategy_account_settings
            SET mode='REQUIRE_EXACT_STRATEGY',version=version+1,idempotency_key=$2,
                correlation_id=$3,request_hash=$4,actor_account_id=$1
          WHERE account_id=$1 AND version=1`,
        [accountA, policyLedgerKey, `category-ledger-policy-corr-${suffix}`,
          crypto.createHash("sha256").update("category-ledger-policy").digest("hex")],
      );
      categoryLedgerKeys.push({ label: "policy", idempotencyKey: policyLedgerKey });
      const categoryLedgerState = async () => ({
        versions: (await pool.query(
          `SELECT id,version,status FROM ai_content_strategy_versions
            WHERE account_id=$1 ORDER BY version,id`, [accountA],
        )).rows,
        drafts: (await pool.query(
          `SELECT id,draft_version,status FROM auto_listing_category_strategy_drafts
            WHERE account_id=$1 ORDER BY id`, [accountA],
        )).rows,
        audits: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM audit_events WHERE account_id=$1", [accountA],
        )).rows[0].count),
        events: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_events WHERE account_id=$1", [accountA],
        )).rows[0].count),
      });
      for (const command of categoryLedgerKeys) {
        const beforeConflict = await categoryLedgerState();
        await assert.rejects(repository.publishCategoryStrategyDraft({
          ...base, idempotencyKey: command.idempotencyKey,
          correlationId: `publish-with-${command.label}-key-${suffix}`,
        }), { code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", status: 409 });
        await assert.rejects(repository.rollbackCategoryStrategyVersion({
          accountId: accountA, actorId: accountA, targetStrategyVersionId: currentId,
          expectedPublishedStrategyVersionId: currentId, idempotencyKey: command.idempotencyKey,
          correlationId: `rollback-with-${command.label}-key-${suffix}`,
        }), { code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", status: 409 });
        assert.deepEqual(await categoryLedgerState(), beforeConflict);
      }
      const before = await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_content_strategy_versions WHERE account_id=$1",
        [accountA],
      );
      await pool.query(
        `UPDATE account_ozon_shared_categories
            SET status='NEEDS_REVIEW',safe_failure_code='TEST_REVALIDATION',version=version+1,updated_at=NOW()
          WHERE account_id=$1 AND source_description_category_id=170 AND source_type_id=99`,
        [accountA],
      );
      await assert.rejects(repository.publishCategoryStrategyDraft({
        ...base, idempotencyKey: `stale-source-${suffix}`, correlationId: `stale-source-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", status: 409 });
      await pool.query(
        `UPDATE account_ozon_shared_categories
            SET status='ACTIVE',safe_failure_code='',version=version+1,updated_at=NOW()
          WHERE account_id=$1 AND source_description_category_id=170 AND source_type_id=99`,
        [accountA],
      );
      await assert.rejects(repository.publishCategoryStrategyDraft({
        ...base, expectedPublishedStrategyVersionId: `wrong-${suffix}`,
        idempotencyKey: `wrong-current-${suffix}`, correlationId: `wrong-current-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", status: 409 });
      await assert.rejects(repository.publishCategoryStrategyDraft({
        ...base, accountId: accountB, actorId: accountB,
        idempotencyKey: `wrong-account-${suffix}`, correlationId: `wrong-account-corr-${suffix}`,
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_READ_ONLY", status: 409 });
      assert.equal((await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM ai_content_strategy_versions WHERE account_id=$1",
        [accountA],
      )).rows[0].count, before.rows[0].count);

      const publishCollisionId = `publish-collision-${suffix}`;
      await pool.query(
        `INSERT INTO ai_content_strategy_versions
           (id,account_id,strategy_key,version,status,content,content_hash,created_by)
         VALUES ($1,$2,'default',8,'DRAFT','{}'::JSONB,$3,$2)`,
        [publishCollisionId, accountA, "c".repeat(64)],
      );
      await assert.rejects(repository.publishCategoryStrategyDraft({
        ...base, idempotencyKey: `publish-collision-${suffix}`,
        correlationId: `publish-collision-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", status: 409 });
      assert.equal((await pool.query(
        "SELECT status FROM ai_content_strategy_versions WHERE account_id=$1 AND id=$2",
        [accountA, currentId],
      )).rows[0].status, "PUBLISHED");
      assert.equal((await pool.query(
        "SELECT status FROM auto_listing_category_strategy_drafts WHERE account_id=$1 AND id=$2",
        [accountA, draft.draftId],
      )).rows[0].status, "DRAFT_READY");
      await pool.query(
        "DELETE FROM ai_content_strategy_versions WHERE account_id=$1 AND id=$2 AND status='DRAFT'",
        [accountA, publishCollisionId],
      );

      const publications = ["one", "two"].map((label) => ({
        ...base, idempotencyKey: `publish-category-${label}-${suffix}`,
        correlationId: `publish-category-${label}-corr-${suffix}`,
      }));
      const outcomes = await Promise.allSettled(publications.map((input) => repository.publishCategoryStrategyDraft(input)));
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === "rejected"
        && outcome.reason?.code === "AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT").length, 1);
      const published = outcomes.find((outcome) => outcome.status === "fulfilled").value;
      assert.equal(published.version, 8);
      assert.equal(published.status, "PUBLISHED");
      assert.equal(published.rules.length, 3);
      assert.equal(published.rules.filter((rule) => rule.scope?.descriptionCategoryId === 170).length, 1);
      assert.equal(published.rules.find((rule) => rule.scope?.descriptionCategoryId === 170).analysisResultId,
        manualResultId);
      assert.equal(published.rules.find((rule) => rule.scope?.descriptionCategoryId === 170).overallStyle,
        manualGuidance.overallStyle);
      assert.equal(published.rules.find((rule) => rule.scope?.descriptionCategoryId === 170).sampleSetHash,
        draft.sampleSetHash);
      assert.equal(published.rules.find((rule) => rule.scope?.descriptionCategoryId === 171).ruleId, bRule.ruleId);
      assert.equal(published.rules.find((rule) => rule.matchType === "PRODUCT_STYLE").ruleId, legacyRule.ruleId);
      const winningInput = publications.find((input) => input.idempotencyKey === published.idempotencyKey);
      const replay = await repository.publishCategoryStrategyDraft(winningInput);
      assert.equal(replay.id, published.id);
      assert.equal(replay.duplicate, true);
      await assert.rejects(repository.publishCategoryStrategyDraft({
        ...winningInput, correlationId: `publish-category-changed-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", status: 409 });
      const history = await repository.listStrategyVersions({ accountId: accountA, strategyKey: "default" });
      assert.deepEqual(history.map((row) => row.status), ["RETIRED", "PUBLISHED"]);
      assert.equal(history[0].rules.find((rule) => rule.scope?.descriptionCategoryId === 170).overallStyle, "old A");
      assert.deepEqual(await repository.listStrategyVersions({ accountId: accountB, strategyKey: "default" }), []);
      const immutable = await rawRejectsCode(() => pool.query(
        "UPDATE ai_content_strategy_rules SET rule='{}'::JSONB WHERE account_id=$1 AND strategy_version_id=$2",
        [accountA, published.id],
      ), "23514");
      assert.equal(immutable, true);
      const rollbackInput = {
        accountId: accountA,
        actorId: accountA,
        targetStrategyVersionId: currentId,
        expectedPublishedStrategyVersionId: published.id,
        idempotencyKey: `rollback-category-${suffix}`,
        correlationId: `rollback-category-corr-${suffix}`,
      };
      const beforePublishKeyRollback = await repository.listStrategyVersions({
        accountId: accountA, strategyKey: "default",
      });
      await assert.rejects(repository.rollbackCategoryStrategyVersion({
        ...rollbackInput, idempotencyKey: winningInput.idempotencyKey,
        correlationId: `rollback-with-publish-key-${suffix}`,
      }), { code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", status: 409 });
      assert.deepEqual(await repository.listStrategyVersions({ accountId: accountA, strategyKey: "default" }),
        beforePublishKeyRollback);
      const rolledBack = await repository.rollbackCategoryStrategyVersion(rollbackInput);
      assert.equal(rolledBack.version, 9);
      assert.equal(rolledBack.status, "PUBLISHED");
      assert.equal(rolledBack.id === currentId, false);
      assert.equal(rolledBack.id === published.id, false);
      assert.equal(rolledBack.rules.find((rule) => rule.scope?.descriptionCategoryId === 170).overallStyle, "old A");
      assert.equal((await repository.rollbackCategoryStrategyVersion(rollbackInput)).duplicate, true);
      await assert.rejects(repository.rollbackCategoryStrategyVersion({
        ...rollbackInput, correlationId: `rollback-category-changed-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", status: 409 });
      const afterRollback = await repository.listStrategyVersions({ accountId: accountA, strategyKey: "default" });
      assert.deepEqual(afterRollback.map((row) => row.status), ["RETIRED", "RETIRED", "PUBLISHED"]);
      assert.equal(afterRollback[0].rules.find((rule) => rule.scope?.descriptionCategoryId === 170).overallStyle, "old A");
      await assert.rejects(repository.publishCategoryStrategyDraft({
        accountId: accountA, actorId: accountA, draftId: reverseDraft.draftId, expectedDraftVersion: 4,
        expectedPublishedStrategyVersionId: rolledBack.id, idempotencyKey: rollbackInput.idempotencyKey,
        correlationId: `publish-with-rollback-key-${suffix}`,
      }), { code: "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", status: 409 });
      assert.equal((await pool.query(
        "SELECT status FROM auto_listing_category_strategy_drafts WHERE account_id=$1 AND id=$2",
        [accountA, reverseDraft.draftId],
      )).rows[0].status, "DRAFT_READY");
      assert.equal((await repository.listStrategyVersions({ accountId: accountA, strategyKey: "default" })).length,
        afterRollback.length);
      const retiredPublishReplay = await repository.publishCategoryStrategyDraft(winningInput);
      assert.deepEqual({ id: retiredPublishReplay.id, status: retiredPublishReplay.status,
        duplicate: retiredPublishReplay.duplicate }, {
        id: published.id, status: "PUBLISHED", duplicate: true,
      });
      const rollbackCollisionId = `rollback-collision-${suffix}`;
      await pool.query(
        `INSERT INTO ai_content_strategy_versions
           (id,account_id,strategy_key,version,status,content,content_hash,created_by)
         VALUES ($1,$2,'default',10,'DRAFT','{}'::JSONB,$3,$2)`,
        [rollbackCollisionId, accountA, "d".repeat(64)],
      );
      await assert.rejects(repository.rollbackCategoryStrategyVersion({
        accountId: accountA, actorId: accountA, targetStrategyVersionId: published.id,
        expectedPublishedStrategyVersionId: rolledBack.id,
        idempotencyKey: `rollback-collision-${suffix}`,
        correlationId: `rollback-collision-corr-${suffix}`,
      }), { code: "AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", status: 409 });
      assert.equal((await pool.query(
        "SELECT status FROM ai_content_strategy_versions WHERE account_id=$1 AND id=$2",
        [accountA, rolledBack.id],
      )).rows[0].status, "PUBLISHED");
      await pool.query(
        "DELETE FROM ai_content_strategy_versions WHERE account_id=$1 AND id=$2 AND status='DRAFT'",
        [accountA, rollbackCollisionId],
      );
      const laterRollback = await repository.rollbackCategoryStrategyVersion({
        accountId: accountA,
        actorId: accountA,
        targetStrategyVersionId: published.id,
        expectedPublishedStrategyVersionId: rolledBack.id,
        idempotencyKey: `rollback-category-later-${suffix}`,
        correlationId: `rollback-category-later-corr-${suffix}`,
      });
      assert.equal(laterRollback.version, 10);
      const retiredRollbackReplay = await repository.rollbackCategoryStrategyVersion(rollbackInput);
      assert.deepEqual({ id: retiredRollbackReplay.id, status: retiredRollbackReplay.status,
        duplicate: retiredRollbackReplay.duplicate }, {
        id: rolledBack.id, status: "PUBLISHED", duplicate: true,
      });
      const categoryRepository = createAutoListingCategoryStrategyPostgres({ pool });
      await categoryRepository.transitionAccountPolicy({
        accountId: accountA, actorId: accountA, expectedVersion: 2, mode: "LEGACY_FALLBACK",
        idempotencyKey: `disable-after-publication-${suffix}`,
        correlationId: `disable-after-publication-corr-${suffix}`,
      });
      const disabledSnapshot = {
        versions: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM ai_content_strategy_versions WHERE account_id=$1", [accountA],
        )).rows[0].count),
        audits: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM audit_events WHERE account_id=$1", [accountA],
        )).rows[0].count),
        events: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_events WHERE account_id=$1", [accountA],
        )).rows[0].count),
      };
      assert.equal((await repository.publishCategoryStrategyDraft(winningInput)).id, published.id);
      assert.equal((await repository.rollbackCategoryStrategyVersion(rollbackInput)).id, rolledBack.id);
      await assert.rejects(repository.publishCategoryStrategyDraft({
        accountId: accountA, actorId: accountA, draftId: reverseDraft.draftId, expectedDraftVersion: 4,
        expectedPublishedStrategyVersionId: laterRollback.id,
        idempotencyKey: `disabled-publish-${suffix}`, correlationId: `disabled-publish-corr-${suffix}`,
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_READ_ONLY", status: 409 });
      await assert.rejects(repository.rollbackCategoryStrategyVersion({
        accountId: accountA, actorId: accountA, targetStrategyVersionId: published.id,
        expectedPublishedStrategyVersionId: laterRollback.id,
        idempotencyKey: `disabled-rollback-${suffix}`, correlationId: `disabled-rollback-corr-${suffix}`,
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_READ_ONLY", status: 409 });
      assert.deepEqual({
        versions: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM ai_content_strategy_versions WHERE account_id=$1", [accountA],
        )).rows[0].count),
        audits: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM audit_events WHERE account_id=$1", [accountA],
        )).rows[0].count),
        events: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_events WHERE account_id=$1", [accountA],
        )).rows[0].count),
      }, disabledSnapshot);

      await categoryRepository.transitionAccountPolicy({
        accountId: accountA, actorId: accountA, expectedVersion: 3, mode: "REQUIRE_EXACT_STRATEGY",
        idempotencyKey: `enable-before-race-${suffix}`, correlationId: `enable-before-race-corr-${suffix}`,
      });
      const racePublishInput = {
        accountId: accountA, actorId: accountA, draftId: reverseDraft.draftId, expectedDraftVersion: 4,
        expectedPublishedStrategyVersionId: laterRollback.id,
        idempotencyKey: `race-publish-${suffix}`, correlationId: `race-publish-corr-${suffix}`,
      };
      const versionsBeforeRace = Number((await pool.query(
        "SELECT COUNT(*) AS count FROM ai_content_strategy_versions WHERE account_id=$1", [accountA],
      )).rows[0].count);
      const [disableOutcome, publishOutcome] = await Promise.allSettled([
        categoryRepository.transitionAccountPolicy({
          accountId: accountA, actorId: accountA, expectedVersion: 4, mode: "LEGACY_FALLBACK",
          idempotencyKey: `race-disable-${suffix}`, correlationId: `race-disable-corr-${suffix}`,
        }),
        repository.publishCategoryStrategyDraft(racePublishInput),
      ]);
      assert.equal(disableOutcome.status, "fulfilled");
      assert.equal(publishOutcome.status === "fulfilled"
        || (publishOutcome.status === "rejected"
          && publishOutcome.reason?.code === "AUTO_LISTING_CATEGORY_STRATEGY_READ_ONLY"), true);
      const versionsAfterRace = Number((await pool.query(
        "SELECT COUNT(*) AS count FROM ai_content_strategy_versions WHERE account_id=$1", [accountA],
      )).rows[0].count);
      assert.equal(versionsAfterRace, versionsBeforeRace + (publishOutcome.status === "fulfilled" ? 1 : 0));
      assert.equal((await categoryRepository.getAccountPolicy({ accountId: accountA })).mode, "LEGACY_FALLBACK");
    } finally {
      await pool?.end().catch(() => {});
      await admin.query("SET search_path TO public").catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      admin.release();
      await adminPool.end();
    }
  });

  test("real category service composition returns safe publish and rollback summaries on first call and replay", {
    timeout: 60_000,
  }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 1 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `category_composition_${suffix}`;
    const schemaSql = quote(schema);
    const accountId = `account-composition-${suffix}`;
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
      for (const migration of migrations) await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      await admin.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'admin','active')",
        [accountId],
      );
      const draft = await seedPublishableCategoryDraft(admin, {
        accountId, suffix, descriptionCategoryId: 270, typeId: 199,
      });
      const currentId = `composition-current-${suffix}`;
      await admin.query(
        `INSERT INTO ai_content_strategy_versions
           (id,account_id,strategy_key,version,status,content,content_hash,published_at,published_by,created_by)
         VALUES ($1,$2,'default',1,'PUBLISHED','{"schemaVersion":"V2"}'::JSONB,$3,NOW(),$2,$2)`,
        [currentId, accountId, crypto.createHash("sha256").update(`current-${suffix}`).digest("hex")],
      );
      pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema},public` });
      const categoryRepository = createAutoListingCategoryStrategyPostgres({ pool });
      await categoryRepository.transitionAccountPolicy({
        accountId, actorId: accountId, expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY",
        idempotencyKey: `enable-composition-${suffix}`,
        correlationId: `enable-composition-correlation-${suffix}`,
      });
      const publicationRepository = createAutoListingAiAdminPostgres({ pool });
      const publicationService = createAutoListingAiAdminService({
        repository: publicationRepository,
        capabilityService: { async testGatewayCapabilities() { throw new Error("not used"); } },
      });
      const service = createAutoListingCategoryStrategyService({
        repository: categoryRepository,
        readModel: {
          async listStrategies() { return []; },
          async getDraft() { return {
            draftId: draft.draftId, accountId,
            scope: { accountId, taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 270, typeId: 199 },
            draftVersion: 4, status: "DRAFT_READY", sampleCount: 5,
            sourceCollectItemId: `source-${suffix}`, expectedSourceVersion: "draft:7",
            browserUrl: "https://www.ozon.ru/category/test-category-270/",
          }; },
          async getDraftDetail() { throw new Error("not used"); },
          async getThumbnailEvidence() { return null; },
        },
        sampleStore: { async persistSampleImages() { throw new Error("not used"); } },
        exactProductFacts: { async verify() { throw new Error("not used"); } },
        extensionSessionChannel: {
          async assertReady() { throw new Error("not used"); },
          async putSession() { throw new Error("not used"); },
        },
        publicationService,
        objectStorage: { async readObjectExpected() { throw new Error("not used"); } },
        now: () => new Date("2026-08-15T00:00:00.000Z"),
        async deriveSessionIdentity() { throw new Error("not used"); },
      });
      const actor = { id: accountId, role: "admin" };
      const publishInput = {
        actor, draftId: draft.draftId, expectedDraftVersion: 4,
        expectedPublishedStrategyVersionId: currentId,
        idempotencyKey: `composition-publish-${suffix}`,
        correlationId: `composition-publish-correlation-${suffix}`,
      };
      const published = await service.publishDraft(publishInput);
      assert.deepEqual(Reflect.ownKeys(published), ["id", "strategyKey", "version", "status", "duplicate"]);
      assert.deepEqual({ strategyKey: published.strategyKey, version: published.version,
        status: published.status, duplicate: published.duplicate }, {
        strategyKey: "default", version: 2, status: "PUBLISHED", duplicate: false,
      });
      assert.deepEqual(await service.publishDraft(publishInput), { ...published, duplicate: true });
      assert.equal(Number((await pool.query(
        "SELECT COUNT(*) AS count FROM ai_content_strategy_versions WHERE account_id=$1", [accountId],
      )).rows[0].count), 2);

      const rollbackInput = {
        actor, draftId: draft.draftId, targetStrategyVersionId: currentId,
        expectedPublishedStrategyVersionId: published.id,
        idempotencyKey: `composition-rollback-${suffix}`,
        correlationId: `composition-rollback-correlation-${suffix}`,
      };
      const rolledBack = await service.rollbackDraft(rollbackInput);
      assert.deepEqual(Reflect.ownKeys(rolledBack), ["id", "strategyKey", "version", "status", "duplicate"]);
      assert.deepEqual({ strategyKey: rolledBack.strategyKey, version: rolledBack.version,
        status: rolledBack.status, duplicate: rolledBack.duplicate }, {
        strategyKey: "default", version: 3, status: "PUBLISHED", duplicate: false,
      });
      assert.deepEqual(await service.rollbackDraft(rollbackInput), { ...rolledBack, duplicate: true });
      assert.equal(Number((await pool.query(
        "SELECT COUNT(*) AS count FROM ai_content_strategy_versions WHERE account_id=$1", [accountId],
      )).rows[0].count), 3);
    } finally {
      await pool?.end().catch(() => {});
      await admin.query("SET search_path TO public").catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      admin.release();
      await adminPool.end();
    }
  });

  test("033 rejects a legacy cross-account strategy rule instead of leaving an unvalidated boundary", { timeout: 60_000 }, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_ai_admin_dirty_${suffix}`;
    const schemaSql = quote(schema);
    const accountA = `account-a-${suffix}`;
    const accountB = `account-b-${suffix}`;
    try {
      await client.query(`CREATE SCHEMA ${schemaSql}`);
      await client.query(`SET search_path TO ${schemaSql}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && file < "033_")
        .sort();
      for (const migration of migrations) {
        await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      for (const accountId of [accountA, accountB]) {
        await client.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [accountId, `user-${accountId}`],
        );
      }
      const strategyId = `strategy-${suffix}`;
      await client.query(
        `INSERT INTO ai_content_strategy_versions
           (id,account_id,strategy_key,version,status,content,content_hash)
         VALUES ($1,$2,'default',1,'DRAFT','{}'::JSONB,$3)`,
        [strategyId, accountA, "d".repeat(64)],
      );
      await client.query(
        `INSERT INTO ai_content_strategy_rules
           (id,account_id,strategy_version_id,rule_kind,rule_order,product_style,rule)
         VALUES ($1,$2,$3,'PRODUCT_STYLE',1,'GENERAL','{}'::JSONB)`,
        [`dirty-rule-${suffix}`, accountB, strategyId],
      );
      const migration033 = await readFile(path.join(migrationsDir, "033_auto_listing_ai_admin_integrity.sql"), "utf8");
      await assert.rejects(client.query(migration033), (error) => error?.code === "23503"
        && /cross-account AI content strategy rules require explicit repair/iu.test(error.message));
    } finally {
      try {
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
      } finally {
        client.release();
        await pool.end();
      }
    }
  });
}
