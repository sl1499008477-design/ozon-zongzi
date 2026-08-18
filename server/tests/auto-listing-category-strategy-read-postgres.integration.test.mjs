import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCategoryStrategyReadModel } from "../auto-listing-category-strategy-runtime.mjs";
import { createAutoListingCategoryStrategyService } from "../auto-listing-category-strategy-service.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_CATEGORY_STRATEGY_READ_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const h = (value) => crypto.createHash("sha256").update(value).digest("hex");
const roles = ["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"];

async function migrate(client) {
  const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
  assert.equal(migrations.at(-1), "076_auto_listing_category_strategy_analysis_edits.sql");
  for (const migration of migrations) await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
}

function guidance(label) {
  return { overallStyle: `${label} catalogue`, prohibitedPatterns: ["avoid brand copying"],
    roles: Object.fromEntries(roles.map((role) => [role, {
      composition: `${label} ${role} composition`, background: `${label} ${role} background`,
      textDensity: role === "MAIN" ? "NONE" : "LIGHT", layout: `${label} ${role} layout`,
    }])) };
}

function evidenceSummary(imageIds) {
  return {
    roleEvidence: Object.fromEntries(roles.map((role) => [role, { evidenceIds: imageIds.slice(0, 2), confidence: 0.86 }])),
    commonPatterns: [{ pattern: "subject centered", evidenceIds: imageIds.slice(0, 2), confidence: 0.86 }],
    differences: [{ pattern: "one sample uses props", evidenceIds: [imageIds[2]] }],
    cautions: ["avoid copying competitor marks"],
  };
}

function repositoryShape() {
  const unused = async () => { throw new Error("unused repository method"); };
  return Object.freeze({
    getDraftReplay: unused, createDraft: unused, startSamplingSession: unused,
    getSamplingSessionReplay: unused, validateSamplingSession: unused, prepareSampleRevision: unused,
    cancelSamplingSession: unused,
    getCommittedSampleSetReplay: unused, commitSampleSetCanonical: unused,
    transitionAccountPolicy: unused, getAccountPolicy: unused,
  });
}

if (!enabled) {
  test("category strategy durable read integration requires a disposable PostgreSQL 16 database", {
    skip: "set AUTO_LISTING_CATEGORY_STRATEGY_READ_POSTGRES_TESTS=1 and TEST_DATABASE_URL",
  }, () => {});
} else {
  test("production read model and service return persisted detail, isolate accounts, and resolve thumbnail identity", {
    timeout: 120_000,
  }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `category_strategy_read_${suffix}`;
    const schemaSql = quote(schema);
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      await migrate(admin);
      const accountA = `account-a-${suffix}`;
      const accountB = `account-b-${suffix}`;
      const collectId = `collect-${suffix}`;
      const rawId = `raw-${suffix}`;
      const productDraftId = `product-draft-${suffix}`;
      const draftId = `strategy-draft-${suffix}`;
      const sessionId = `session-${suffix}`;
      const setId = `sample-set-${suffix}`;
      const attemptId = `attempt-${suffix}`;
      for (const accountId of [accountA, accountB]) {
        await admin.query("INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'admin','active')", [accountId]);
      }
      await admin.query("INSERT INTO collect_items (id,account_id,status,source_sku,source_url) VALUES ($1,$2,'COLLECTED',$3,$4)",
        [collectId, accountA, `sku-${suffix}`, "https://www.ozon.ru/product/test-123456789/"]);
      await admin.query(`INSERT INTO collect_raw_payloads
        (id,collect_item_id,account_id,source_sku,source_url,payload_hash,collector_version,payload,collected_at)
        VALUES ($1,$2,$3,$4,$5,$6,'test','{}'::JSONB,NOW())`,
      [rawId, collectId, accountA, `sku-${suffix}`, "https://www.ozon.ru/product/test-123456789/", h(rawId)]);
      await admin.query(`INSERT INTO product_drafts
        (id,collect_item_id,source_payload_id,version,data_hash,data) VALUES ($1,$2,$3,7,$4,'{}'::JSONB)`,
      [productDraftId, collectId, rawId, h(productDraftId)]);
      await admin.query("UPDATE collect_items SET current_draft_id=$1 WHERE account_id=$2 AND id=$3",
        [productDraftId, accountA, collectId]);
      await admin.query(`INSERT INTO auto_listing_category_strategy_drafts
        (id,account_id,taxonomy_scope,description_category_id,type_id,draft_version,status,
         source_collect_item_id,source_product_draft_id,source_product_draft_version,expected_source_version,
         idempotency_key,correlation_id,request_hash,actor_account_id)
        VALUES ($1,$2,'OZON:DEFAULT',170,99,5,'PUBLISHED',$3,$4,7,'draft:7',$5,$6,$7,$2)`,
      [draftId, accountA, collectId, productDraftId, `draft-key-${suffix}`, `draft-corr-${suffix}`, h(`draft-${suffix}`)]);
      await admin.query(`INSERT INTO auto_listing_category_strategy_sampling_sessions
        (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,session_secret_hash,
         idempotency_key,correlation_id,request_hash,actor_account_id)
        VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,$5,$6,$7,$2)`,
      [sessionId, accountA, draftId, h(`secret-${suffix}`), `session-key-${suffix}`, `session-corr-${suffix}`, h(`session-${suffix}`)]);
      await admin.query(`INSERT INTO auto_listing_category_strategy_sample_sets
        (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,session_id,status,
         sample_set_hash,sample_count,sealed_at,idempotency_key,correlation_id,request_hash,actor_account_id)
        VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,'BUILDING',NULL,0,NULL,$5,$6,$7,$2)`,
      [setId, accountA, draftId, sessionId, `set-key-${suffix}`, `set-corr-${suffix}`, h(`set-request-${suffix}`)]);
      const imageIds = [];
      let expectedThumbnail;
      for (let ordinal = 0; ordinal < 5; ordinal += 1) {
        const sampleId = `sample-${ordinal}-${suffix}`;
        const imageId = `image-${ordinal}-${suffix}`;
        imageIds.push(imageId);
        await admin.query(`INSERT INTO auto_listing_category_strategy_samples
          (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,ordinal,sku,
           source_product_id,source_product_ref,source_product_response_hash,idempotency_key,correlation_id,request_hash,actor_account_id)
          VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,$5,$6,$7,$8,$9,$10,$11,$12,$2)`,
        [sampleId, accountA, draftId, setId, ordinal, `sample-sku-${ordinal}`, 1000 + ordinal,
          `product-${ordinal}`, h(`product-${ordinal}`), `sample-key-${ordinal}`, `sample-corr-${ordinal}`, h(`sample-${ordinal}`)]);
        const objectPrefix = `category-strategy/${accountA}/${draftId}/${setId}/${sampleId}`;
        const thumbnailHash = h(`thumbnail-${ordinal}`);
        await admin.query(`INSERT INTO auto_listing_category_strategy_sample_images
          (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_id,image_id,
           role,ordinal,source_url_host,source_ref_hash,source_response_hash,source_content_hash,
           analysis_object_key,analysis_content_hash,thumbnail_object_key,thumbnail_content_hash,content_type,
           width,height,captured_at,idempotency_key,correlation_id,request_hash,actor_account_id)
          VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,$5,$1,'MAIN',0,'cdn.example.test',$6,$7,$8,$9,$10,$11,$12,
           'image/webp',${ordinal === 0 ? 50 : 1200},${ordinal === 0 ? 50 : 1600},NOW(),$13,$14,$15,$2)`,
        [imageId, accountA, draftId, setId, sampleId, h(`ref-${ordinal}`), h(`response-${ordinal}`),
          h(`content-${ordinal}`), `${objectPrefix}/analysis.webp`, h(`analysis-${ordinal}`),
          `${objectPrefix}/thumbnail.webp`, thumbnailHash, `image-key-${ordinal}`, `image-corr-${ordinal}`, h(`image-${ordinal}`)]);
        if (ordinal === 0) {
          await admin.query(`INSERT INTO auto_listing_category_strategy_sample_images
            (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_id,image_id,
             role,ordinal,source_url_host,source_ref_hash,source_response_hash,source_content_hash,
             analysis_object_key,analysis_content_hash,thumbnail_object_key,thumbnail_content_hash,content_type,
             width,height,captured_at,idempotency_key,correlation_id,request_hash,actor_account_id)
            VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,$5,$1,'DETAIL',1,'cdn.example.test',$6,$7,$8,$9,$10,$11,$12,
             'image/webp',1200,1600,NOW(),$13,$14,$15,$2)`,
          [`detail-${imageId}`, accountA, draftId, setId, sampleId, h("detail-ref"), h("detail-response"),
            h("detail-content"), `${objectPrefix}/detail-analysis.webp`, h("detail-analysis"),
            `${objectPrefix}/detail-thumbnail.webp`, h("detail-thumbnail"), "detail-image-key", "detail-image-corr",
            h("detail-image-request")]);
          expectedThumbnail = { sampleId, imageId: `detail-${imageId}`,
            key: `${objectPrefix}/detail-thumbnail.webp`, hash: h("detail-thumbnail") };
        }
      }
      const sealed = await admin.query(`UPDATE auto_listing_category_strategy_sample_sets
        SET status='SEALED',sample_set_hash=auto_listing_category_strategy_canonical_sample_set_hash($1,$2)
        WHERE account_id=$1 AND id=$2 RETURNING sample_set_hash`, [accountA, setId]);
      const setHash = sealed.rows[0].sample_set_hash;
      const inputHash = h(`input-${suffix}`);
      await admin.query(`INSERT INTO auto_listing_category_strategy_analysis_attempts
        (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_set_hash,
         analysis_input_hash,model_config_snapshot,model_config_hash,cost_confirmed,
         idempotency_key,correlation_id,request_hash,actor_account_id)
        VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,$5,$6,'{"model":"test"}'::JSONB,$7,TRUE,$8,$9,$10,$2)`,
      [attemptId, accountA, draftId, setId, setHash, inputHash, h(`model-${suffix}`),
        `attempt-key-${suffix}`, `attempt-corr-${suffix}`, h(`attempt-${suffix}`)]);
      const evidence = evidenceSummary(imageIds);
      const aiRaw = { validationStatus: "ACCEPTED", safeCode: null, evidenceSummary: evidence };
      const aiGuidance = guidance("ai");
      await admin.query(`INSERT INTO auto_listing_category_strategy_analysis_results
        (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,sample_set_hash,
         analysis_input_hash,raw_response,raw_response_hash,guidance,guidance_hash,idempotency_key,correlation_id,
         request_hash,actor_account_id,source_kind,created_at)
        VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,$5,$6,$7,$8::JSONB,$9,$10::JSONB,$11,$12,$13,$14,$2,'AI',NOW()-INTERVAL '2 minutes')`,
      [`ai-result-${suffix}`, accountA, draftId, attemptId, setId, setHash, inputHash, JSON.stringify(aiRaw),
        h(JSON.stringify(aiRaw)), JSON.stringify(aiGuidance), h(JSON.stringify(aiGuidance)),
        `ai-key-${suffix}`, `ai-corr-${suffix}`, h(`ai-request-${suffix}`)]);
      const manualRaw = { sourceKind: "MANUAL", baseAnalysisAttemptId: attemptId };
      const manualGuidance = guidance("manual");
      await admin.query(`INSERT INTO auto_listing_category_strategy_analysis_results
        (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,sample_set_hash,
         analysis_input_hash,raw_response,raw_response_hash,guidance,guidance_hash,idempotency_key,correlation_id,
         request_hash,actor_account_id,source_kind,edited_by,edited_at,base_analysis_attempt_id,created_at)
        VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,$4,$5,$6,$7,$8::JSONB,$9,$10::JSONB,$11,$12,$13,$14,$2,
          'MANUAL',$2,NOW()-INTERVAL '1 minute',$4,NOW()-INTERVAL '1 minute')`,
      [`manual-result-${suffix}`, accountA, draftId, attemptId, setId, setHash, inputHash, JSON.stringify(manualRaw),
        h(JSON.stringify(manualRaw)), JSON.stringify(manualGuidance), h(JSON.stringify(manualGuidance)),
        `manual-key-${suffix}`, `manual-corr-${suffix}`, h(`manual-request-${suffix}`)]);
      await admin.query(`INSERT INTO ai_content_strategy_versions
        (id,account_id,strategy_key,version,status,content,content_hash,published_at,published_by,created_by)
        VALUES ($1,$3,'default',1,'RETIRED','{}'::JSONB,$4,NOW()-INTERVAL '1 day',$3,$3),
               ($2,$3,'default',2,'PUBLISHED','{}'::JSONB,$5,NOW(),$3,$3)`,
      [`strategy-v1-${suffix}`, `strategy-v2-${suffix}`, accountA, h(`v1-${suffix}`), h(`v2-${suffix}`)]);
      await admin.query(`INSERT INTO auto_listing_category_strategy_events
        (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,event_type,
         analysis_result_id,published_strategy_version_id,event_payload,idempotency_key,correlation_id,
         request_hash,actor_account_id)
        VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,'PUBLISHED',$4,$5,'{"version":2}'::JSONB,$6,$7,$8,$2)`,
      [`publication-${suffix}`, accountA, draftId, `manual-result-${suffix}`, `strategy-v2-${suffix}`,
        `publication-key-${suffix}`, `publication-corr-${suffix}`, h(`publication-${suffix}`)]);
      const accountBVersionId = `strategy-account-b-${suffix}`;
      await admin.query(`INSERT INTO ai_content_strategy_versions
        (id,account_id,strategy_key,version,status,content,content_hash,published_at,published_by,created_by)
        VALUES ($1,$2,'default',1,'PUBLISHED','{}'::JSONB,$3,NOW(),$2,$2)`,
      [accountBVersionId, accountB, h(`account-b-version-${suffix}`)]);
      // These rows are query-scope distractors only. The target publication above uses the full
      // production lineage; replica mode is confined to this disposable schema and restored immediately.
      await admin.query("SET session_replication_role=replica");
      try {
        await admin.query(`INSERT INTO auto_listing_category_strategy_events
          (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,event_type,
           analysis_result_id,published_strategy_version_id,event_payload,idempotency_key,correlation_id,
           request_hash,actor_account_id)
          VALUES
            ($1,$4,'other-description','OZON:DEFAULT',171,99,'PUBLISHED','other-description-result',$5,
             '{"version":2}'::JSONB,$6,$7,$8,$4),
            ($2,$4,'other-type','OZON:DEFAULT',170,100,'PUBLISHED','other-type-result',$5,
             '{"version":2}'::JSONB,$9,$10,$11,$4),
            ($3,$12,'other-account','OZON:DEFAULT',170,99,'PUBLISHED','other-account-result',$13,
             '{"version":1}'::JSONB,$14,$15,$16,$12)`, [
          `publication-other-description-${suffix}`,
          `publication-other-type-${suffix}`,
          `publication-other-account-${suffix}`,
          accountA,
          `strategy-v2-${suffix}`,
          `publication-other-description-key-${suffix}`,
          `publication-other-description-corr-${suffix}`,
          h(`publication-other-description-${suffix}`),
          `publication-other-type-key-${suffix}`,
          `publication-other-type-corr-${suffix}`,
          h(`publication-other-type-${suffix}`),
          accountB,
          accountBVersionId,
          `publication-other-account-key-${suffix}`,
          `publication-other-account-corr-${suffix}`,
          h(`publication-other-account-${suffix}`),
        ]);
      } finally {
        await admin.query("SET session_replication_role=origin");
      }

      pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema},public` });
      const readModel = createCategoryStrategyReadModel({ pool });
      const thumbnailBytes = Buffer.from([0x52, 0x49, 0x46, 0x46]);
      let objectRead;
      const service = createAutoListingCategoryStrategyService({ repository: repositoryShape(), readModel,
        sampleStore: { persistSampleImages: async () => {} }, exactProductFacts: { verify: async () => {} },
        extensionSessionChannel: { assertReady: async () => {}, putSession: async () => {} },
        publicationService: { publishCategoryStrategyDraft: async () => {}, rollbackCategoryStrategyVersion: async () => {} },
        analyzer: { analyze: async () => {}, editGuidance: async () => {} },
        objectStorage: { readObjectExpected: async (input) => { objectRead = input; return thumbnailBytes; } },
        now: () => new Date().toISOString(), deriveSessionIdentity: async () => ({ sessionId: "unused", sessionSecret: "x".repeat(32) }) });
      const actorA = { id: accountA, role: "admin" };
      const actorB = { id: accountB, role: "admin" };
      const detail = await service.getDraft({ actor: actorA, draftId });
      assert.equal(detail.samples.length, 5);
      assert.deepEqual(detail.samples[0], {
        sampleId: expectedThumbnail.sampleId,
        sku: "sample-sku-0",
        title: null,
        thumbnailUrl: `/api/admin/auto-listing/category-strategies/${draftId}/samples/${expectedThumbnail.sampleId}`
          + `/images/${expectedThumbnail.imageId}/thumbnail`,
        imageCount: 2,
        previewRole: "DETAIL",
        previewWidth: 1200,
        previewHeight: 1600,
        mainImageWidth: 50,
        mainImageHeight: 50,
        status: "READY",
        excludedReasons: [],
      });
      assert.equal(detail.draft.sourceCollectItemId, collectId);
      assert.equal(detail.draft.expectedSourceVersion, "draft:7");
      assert.equal(detail.analysis.provenance, "MANUAL");
      assert.equal(detail.analysis.evidenceSummary.roleEvidence.MAIN.confidence, 0.86);
      assert.deepEqual(detail.versions.map((entry) => entry.status), ["PUBLISHED", "RETIRED"]);
      assert.deepEqual(detail.categoryPublications.map((entry) => ({
        eventId: entry.eventId,
        strategyVersionId: entry.strategyVersionId,
        strategyVersion: entry.strategyVersion,
      })), [{
        eventId: `publication-${suffix}`,
        strategyVersionId: `strategy-v2-${suffix}`,
        strategyVersion: 2,
      }]);
      assert.match(detail.categoryPublications[0].publishedAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.equal(detail.published.id, `strategy-v2-${suffix}`);
      const readSql = [];
      const guardedReadModel = createCategoryStrategyReadModel({ pool: {
        query: async (sql, parameters) => { readSql.push(String(sql)); return pool.query(sql, parameters); },
      } });
      await guardedReadModel.getDraftDetail({ accountId: accountA, draftId });
      assert.match(readSql[0], /result\.sample_set_id=target\.sample_set_id/u);
      assert.equal(JSON.stringify(detail).includes("thumbnail_object_key"), false);
      await assert.rejects(service.getDraft({ actor: actorB, draftId }), {
        code: "AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", status: 404,
      });
      assert.deepEqual(await service.readSampleThumbnail({ actor: actorA, draftId,
        sampleId: expectedThumbnail.sampleId, imageId: expectedThumbnail.imageId }), thumbnailBytes);
      assert.deepEqual(objectRead, { accountId: accountA, key: expectedThumbnail.key,
        expectedSha256: expectedThumbnail.hash, maxBytes: 16 * 1024 * 1024 });
      await assert.rejects(service.readSampleThumbnail({ actor: actorB, draftId,
        sampleId: expectedThumbnail.sampleId, imageId: expectedThumbnail.imageId }), {
        code: "AUTO_LISTING_CATEGORY_STRATEGY_THUMBNAIL_NOT_FOUND", status: 404,
      });
    } finally {
      await pool?.end();
      await admin.query("SET session_replication_role=origin").catch(() => {});
      await admin.query("SET search_path TO public").catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      admin.release();
      await adminPool.end();
    }
  });
}
