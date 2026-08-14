import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAutoListingCategoryStrategyPostgres } from "../auto-listing-category-strategy-postgres.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const sha = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
const adminAuditId = (action, accountId, idempotencyKey) => `audit_ai_admin_${sha(
  [action, accountId, idempotencyKey].join("\0"),
).slice(0, 40)}`;

async function applyMigrations(client) {
  const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
  assert.equal(migrations.at(-1), "075_auto_listing_category_strategy_sampling.sql");
  for (const migration of migrations) await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
}

async function seedSource(client, { accountId, suffix, descriptionCategoryId = 170, typeId = 99 }) {
  const collectItemId = `collect-${accountId}-${suffix}`;
  const productDraftId = `draft-${accountId}-${suffix}`;
  const rawId = `raw-${accountId}-${suffix}`;
  const evidenceId = `category-evidence-${accountId}-${suffix}`;
  await client.query(
    "INSERT INTO collect_items (id,account_id,status,source_sku,source_url) VALUES ($1,$2,'COLLECTED',$3,$4)",
    [collectItemId, accountId, `sku-${suffix}`, `https://www.ozon.ru/product/${suffix}`],
  );
  await client.query(
    `INSERT INTO collect_raw_payloads
       (id,collect_item_id,account_id,source_sku,source_url,payload_hash,collector_version,payload,collected_at)
     VALUES ($1,$2,$3,$4,$5,$6,'test','{}'::JSONB,NOW())`,
    [rawId, collectItemId, accountId, `sku-${suffix}`, `https://www.ozon.ru/product/${suffix}`, sha(rawId)],
  );
  await client.query(
    `INSERT INTO product_drafts (id,collect_item_id,source_payload_id,version,data_hash,data)
     VALUES ($1,$2,$3,7,$4,'{}'::JSONB)`,
    [productDraftId, collectItemId, rawId, sha(productDraftId)],
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
    [evidenceId, accountId, productDraftId, collectItemId, descriptionCategoryId, typeId, sha(rawId), rawId],
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
    [`shared-${accountId}-${suffix}`, accountId, descriptionCategoryId, typeId, evidenceId],
  );
  return { collectItemId, expectedSourceVersion: "draft:7" };
}

function sample({ suffix, ordinal, scope, accountId, draftId, sampleSetId }) {
  const sku = `sample-sku-${suffix}-${ordinal}`;
  const sampleId = `sample-${suffix}-${ordinal}`;
  const objectPrefix = `category-strategy/${accountId}/${draftId}/${sampleSetId}/${sampleId}`;
  return {
    sampleSetId,
    sampleId,
    sku,
    sourceProductId: ordinal === 0 ? 4_862_904_234 : 10_000 + ordinal,
    sourceProductRef: `ozon-product-${suffix}-${ordinal}`,
    sourceProductResponseHash: sha(`product-response-${suffix}-${ordinal}`),
    taxonomyScope: scope.taxonomyScope,
    descriptionCategoryId: scope.descriptionCategoryId,
    typeId: scope.typeId,
    images: [{
      imageId: `image-${suffix}-${ordinal}`,
      role: "MAIN",
      ordinal: 0,
      sourceUrlHost: "cdn.example.test",
      sourceRefHash: sha(`source-ref-${suffix}-${ordinal}`),
      sourceResponseHash: sha(`image-response-${suffix}-${ordinal}`),
      sourceContentHash: sha(`source-content-${suffix}-${ordinal}`),
      analysisObjectKey: `${objectPrefix}/analysis.webp`,
      analysisContentHash: sha(`analysis-${suffix}-${ordinal}`),
      thumbnailObjectKey: `${objectPrefix}/thumbnail.webp`,
      thumbnailContentHash: sha(`thumbnail-${suffix}-${ordinal}`),
      contentType: "image/webp",
      width: 1200,
      height: 1600,
      capturedAt: "2026-08-14T00:00:00.000Z",
    }],
  };
}

async function expectedSampleSetHash(pool, { accountId, draftId, sessionId, scope, samples }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sampleSetId = samples[0].sampleSetId;
    await client.query(
      `INSERT INTO auto_listing_category_strategy_sample_sets
         (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,session_id,
          idempotency_key,correlation_id,request_hash,actor_account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$2)`,
      [sampleSetId, accountId, draftId, scope.taxonomyScope, scope.descriptionCategoryId, scope.typeId,
        sessionId, `hash-probe-${sampleSetId}`, sha(`hash-probe-${sampleSetId}`)],
    );
    for (const [ordinal, entry] of samples.entries()) {
      await client.query(
        `INSERT INTO auto_listing_category_strategy_samples
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,ordinal,
            sku,source_product_id,source_product_ref,source_product_response_hash,
            idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$2)`,
        [entry.sampleId, accountId, draftId, scope.taxonomyScope, scope.descriptionCategoryId, scope.typeId,
          sampleSetId, ordinal, entry.sku, entry.sourceProductId, entry.sourceProductRef,
          entry.sourceProductResponseHash, `hash-probe-sample-${entry.sampleId}`, sha(entry.sampleId)],
      );
      for (const image of entry.images) {
        await client.query(
          `INSERT INTO auto_listing_category_strategy_sample_images
             (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_id,
              image_id,role,ordinal,source_url_host,source_ref_hash,source_response_hash,source_content_hash,
              analysis_object_key,analysis_content_hash,thumbnail_object_key,thumbnail_content_hash,
              content_type,width,height,captured_at,idempotency_key,correlation_id,request_hash,actor_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$1,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
             $22::TIMESTAMPTZ,$23,$23,$24,$2)`,
          [image.imageId, accountId, draftId, scope.taxonomyScope, scope.descriptionCategoryId, scope.typeId,
            sampleSetId, entry.sampleId, image.role, image.ordinal, image.sourceUrlHost, image.sourceRefHash,
            image.sourceResponseHash, image.sourceContentHash, image.analysisObjectKey, image.analysisContentHash,
            image.thumbnailObjectKey, image.thumbnailContentHash, image.contentType, image.width, image.height,
            image.capturedAt, `hash-probe-image-${image.imageId}`, sha(image.imageId)],
        );
      }
    }
    const result = await client.query(
      "SELECT auto_listing_category_strategy_canonical_sample_set_hash($1,$2) AS hash",
      [accountId, sampleSetId],
    );
    return result.rows[0].hash;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

if (!enabled) {
  test("category strategy PostgreSQL integration requires explicit disposable database opt-in", {
    skip: "requires AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS=1 and TEST_DATABASE_URL",
  }, () => {});
} else {
  test("repository enforces exact tenant, source, version, idempotency, expiry, and concurrent sealing", {
    timeout: 90_000,
  }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `category_strategy_repository_${suffix}`;
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${quote(schema)}`);
      await admin.query(`SET search_path TO ${quote(schema)}, public`);
      await applyMigrations(admin);
      const accountA = `account-a-${suffix}`;
      const accountB = `account-b-${suffix}`;
      for (const accountId of [accountA, accountB]) {
        await admin.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [accountId, `user-${accountId}`],
        );
      }
      const sourceA = await seedSource(admin, { accountId: accountA, suffix });
      const sourceB = await seedSource(admin, { accountId: accountB, suffix });
      pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema},public` });
      const repository = createAutoListingCategoryStrategyPostgres({ pool });
      const scope = { accountId: accountA, taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 170, typeId: 99 };

      const concurrentDraftInput = {
        accountId: accountB, actorId: accountB, scope: { ...scope, accountId: accountB },
        sourceCollectItemId: sourceB.collectItemId, expectedSourceVersion: sourceB.expectedSourceVersion,
        idempotencyKey: `concurrent-draft-${suffix}`, correlationId: `concurrent-draft-corr-${suffix}`,
      };
      const concurrentDrafts = await Promise.all([
        repository.createDraft(concurrentDraftInput), repository.createDraft(concurrentDraftInput),
      ]);
      assert.equal(new Set(concurrentDrafts.map((result) => result.draftId)).size, 1);
      assert.deepEqual(concurrentDrafts.map((result) => result.duplicate).sort(), [false, true]);
      const concurrentSessionInput = {
        accountId: accountB, actorId: accountB, draftId: concurrentDrafts[0].draftId, expectedDraftVersion: 1,
        sessionId: `concurrent-session-${suffix}`, sessionSecretHash: sha(`concurrent-secret-${suffix}`),
        expiresAt: new Date(Date.now() + (2 * 60 * 60 * 1000)).toISOString(),
        idempotencyKey: `concurrent-session-command-${suffix}`,
        correlationId: `concurrent-session-corr-${suffix}`,
      };
      const concurrentSessions = await Promise.all([
        repository.startSamplingSession(concurrentSessionInput),
        repository.startSamplingSession(concurrentSessionInput),
      ]);
      assert.equal(new Set(concurrentSessions.map((result) => result.sessionId)).size, 1);
      assert.deepEqual(concurrentSessions.map((result) => result.duplicate).sort(), [false, true]);
      const concurrentSampleSetId = `concurrent-sample-set-${suffix}`;
      const concurrentSamples = Array.from({ length: 5 }, (_, ordinal) => sample({
        suffix: `concurrent-${suffix}`, ordinal, scope: { ...scope, accountId: accountB },
        accountId: accountB, draftId: concurrentDrafts[0].draftId, sampleSetId: concurrentSampleSetId,
      }));
      const concurrentSampleHash = await expectedSampleSetHash(pool, {
        accountId: accountB, draftId: concurrentDrafts[0].draftId,
        sessionId: concurrentSessions[0].sessionId, scope: { ...scope, accountId: accountB },
        samples: concurrentSamples,
      });
      const concurrentCommitInput = {
        accountId: accountB, actorId: accountB, draftId: concurrentDrafts[0].draftId,
        sessionId: concurrentSessions[0].sessionId, sessionSecretHash: concurrentSessionInput.sessionSecretHash,
        expectedDraftVersion: 1, samples: concurrentSamples, sampleSetHash: concurrentSampleHash,
        idempotencyKey: `concurrent-commit-same-${suffix}`,
        correlationId: `concurrent-commit-same-corr-${suffix}`,
      };
      const concurrentCommits = await Promise.all([
        repository.commitSampleSet(concurrentCommitInput), repository.commitSampleSet(concurrentCommitInput),
      ]);
      assert.equal(new Set(concurrentCommits.map((result) => result.sampleSetId)).size, 1);
      assert.deepEqual(concurrentCommits.map((result) => result.duplicate).sort(), [false, true]);
      const concurrentPolicyInput = {
        accountId: accountB, actorId: accountB, expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY",
        idempotencyKey: `concurrent-policy-${suffix}`, correlationId: `concurrent-policy-corr-${suffix}`,
      };
      const concurrentPolicies = await Promise.all([
        repository.transitionAccountPolicy(concurrentPolicyInput),
        repository.transitionAccountPolicy(concurrentPolicyInput),
      ]);
      assert.deepEqual(concurrentPolicies.map((result) => result.version), [2, 2]);
      assert.deepEqual(concurrentPolicies.map((result) => result.duplicate).sort(), [false, true]);

      const draftInput = {
        accountId: accountA, actorId: accountA, scope, sourceCollectItemId: sourceA.collectItemId,
        expectedSourceVersion: sourceA.expectedSourceVersion,
        idempotencyKey: `create-draft-${suffix}`, correlationId: `create-draft-corr-${suffix}`,
      };
      const draft = await repository.createDraft(draftInput);
      assert.deepEqual({ status: draft.status, draftVersion: draft.draftVersion, scope: draft.scope }, {
        status: "COLLECTING", draftVersion: 1, scope,
      });
      assert.equal((await repository.createDraft(draftInput)).draftId, draft.draftId);
      assert.equal((await repository.createDraft(draftInput)).duplicate, true);
      await assert.rejects(repository.createDraft({
        ...draftInput, sourceCollectItemId: `different-${suffix}`,
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", status: 409 });
      await assert.rejects(repository.createDraft({
        ...draftInput, accountId: accountB, actorId: accountB, scope: { ...scope, accountId: accountB },
        idempotencyKey: `foreign-draft-${suffix}`,
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_SOURCE_NOT_FOUND", status: 404 });

      const expiresAt = new Date(Date.now() + (2 * 60 * 60 * 1000)).toISOString();
      await assert.rejects(repository.startSamplingSession({
        accountId: accountA, actorId: accountA, draftId: draft.draftId, expectedDraftVersion: 1,
        sessionId: `cross-command-session-${suffix}`, sessionSecretHash: sha(`cross-command-secret-${suffix}`),
        expiresAt, idempotencyKey: draftInput.idempotencyKey,
        correlationId: `cross-command-session-corr-${suffix}`,
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", status: 409 });
      assert.equal(Number((await pool.query(
        "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_sampling_sessions WHERE account_id=$1",
        [accountA],
      )).rows[0].count), 0);
      const sessionInput = {
        accountId: accountA, actorId: accountA, draftId: draft.draftId, expectedDraftVersion: 1,
        sessionId: `session-${suffix}`, sessionSecretHash: sha(`secret-${suffix}`), expiresAt,
        idempotencyKey: `start-session-${suffix}`, correlationId: `start-session-corr-${suffix}`,
      };
      const session = await repository.startSamplingSession(sessionInput);
      assert.equal(session.sessionId, sessionInput.sessionId);
      assert.equal(session.state, "ACTIVE");
      assert.equal(typeof session.createdAt, "string");
      assert.equal(Date.parse(session.expiresAt) - Date.parse(session.createdAt), 2 * 60 * 60 * 1000);
      assert.equal((await repository.startSamplingSession(sessionInput)).duplicate, true);
      await pool.query(
        `UPDATE auto_listing_category_strategy_sampling_sessions SET state='CANCELLED'
          WHERE account_id=$1 AND id=$2 AND state='ACTIVE'`,
        [accountA, session.sessionId],
      );
      const eventsBeforeCancelledReplay = Number((await pool.query(
        "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_events WHERE account_id=$1 AND idempotency_key=$2",
        [accountA, sessionInput.idempotencyKey],
      )).rows[0].count);
      const cancelledSessionReplay = await repository.startSamplingSession(sessionInput);
      assert.deepEqual({
        sessionId: cancelledSessionReplay.sessionId,
        draftId: cancelledSessionReplay.draftId,
        accountId: cancelledSessionReplay.accountId,
        state: cancelledSessionReplay.state,
        createdAt: cancelledSessionReplay.createdAt,
        expiresAt: cancelledSessionReplay.expiresAt,
        duplicate: cancelledSessionReplay.duplicate,
      }, {
        sessionId: session.sessionId,
        draftId: session.draftId,
        accountId: session.accountId,
        state: "ACTIVE",
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        duplicate: true,
      });
      assert.deepEqual((await pool.query(
        `SELECT state,COUNT(*) OVER ()::INTEGER AS count
           FROM auto_listing_category_strategy_sampling_sessions
          WHERE account_id=$1 AND id=$2`,
        [accountA, session.sessionId],
      )).rows[0], { state: "CANCELLED", count: 1 });
      assert.equal(Number((await pool.query(
        "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_events WHERE account_id=$1 AND idempotency_key=$2",
        [accountA, sessionInput.idempotencyKey],
      )).rows[0].count), eventsBeforeCancelledReplay);
      await assert.rejects(repository.startSamplingSession({ ...sessionInput, sessionSecretHash: sha("wrong") }), {
        code: "AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", status: 409,
      });

      const expiredDraft = await repository.createDraft({
        ...draftInput,
        scope: { ...scope, typeId: 100 },
        idempotencyKey: `expired-draft-${suffix}`,
      }).catch(() => null);
      assert.equal(expiredDraft, null);
      await pool.query("ALTER TABLE auto_listing_category_strategy_sampling_sessions DISABLE TRIGGER auto_listing_category_strategy_session_integrity");
      await pool.query(
        "ALTER TABLE auto_listing_category_strategy_sampling_sessions DROP CONSTRAINT auto_listing_category_strategy_sampling_sessions_check1",
      );
      await pool.query(
        "UPDATE auto_listing_category_strategy_sampling_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND id=$2",
        [accountA, session.sessionId],
      );
      await pool.query("ALTER TABLE auto_listing_category_strategy_sampling_sessions ENABLE TRIGGER auto_listing_category_strategy_session_integrity");
      const sampleSetId = `sample-set-${suffix}`;
      const initialSamples = Array.from({ length: 5 }, (_, ordinal) => sample({
        suffix, ordinal, scope, accountId: accountA, draftId: draft.draftId, sampleSetId,
      }));
      await assert.rejects(repository.commitSampleSet({
        accountId: accountA, actorId: accountA, draftId: draft.draftId, sessionId: session.sessionId,
        sessionSecretHash: sessionInput.sessionSecretHash,
        expectedDraftVersion: 1, samples: initialSamples, sampleSetHash: sha("not-written"),
        idempotencyKey: `expired-commit-${suffix}`, correlationId: `expired-commit-corr-${suffix}`,
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_EXPIRED", status: 409 });
      assert.equal(Number((await pool.query(
        "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_sample_sets WHERE account_id=$1 AND draft_id=$2",
        [accountA, draft.draftId],
      )).rows[0].count), 0);

      const liveSession = await repository.startSamplingSession({
        ...sessionInput, sessionId: `session-live-${suffix}`, idempotencyKey: `start-session-live-${suffix}`,
        correlationId: `start-session-live-corr-${suffix}`,
      });
      const commitBase = {
        accountId: accountA, actorId: accountA, draftId: draft.draftId, sessionId: liveSession.sessionId,
        sessionSecretHash: sessionInput.sessionSecretHash,
        expectedDraftVersion: 1, samples: initialSamples,
        idempotencyKey: `commit-${suffix}`, correlationId: `commit-corr-${suffix}`,
      };
      const adminLedgerCommands = [
        { action: "AUTO_LISTING_CATEGORY_STRATEGY_PUBLISH", idempotencyKey: `admin-publish-ledger-${suffix}` },
        { action: "AUTO_LISTING_CATEGORY_STRATEGY_ROLLBACK", idempotencyKey: `admin-rollback-ledger-${suffix}` },
      ];
      for (const command of adminLedgerCommands) {
        await pool.query(
          `INSERT INTO audit_events
             (event_id,account_id,action,status,actor_type,actor_id,source,entity_type,entity_id,
              correlation_id,metadata,occurred_at,created_at)
           VALUES ($1,$2,$3,'SUCCESS','account',$2,'auto-listing-ai-admin',
             'ai_content_strategy_version',$4,$5,$6::JSONB,NOW(),NOW())`,
          [adminAuditId(command.action, accountA, command.idempotencyKey), accountA, command.action,
            `admin-ledger-version-${suffix}`, `admin-ledger-corr-${suffix}`,
            JSON.stringify({ requestHash: sha(`${command.action}-request`), entityId: `admin-ledger-version-${suffix}` })],
        );
      }
      const crossNamespaceBefore = {
        drafts: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_drafts WHERE account_id=$1", [accountA],
        )).rows[0].count),
        sessions: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_sampling_sessions WHERE account_id=$1", [accountA],
        )).rows[0].count),
        sampleSets: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_sample_sets WHERE account_id=$1", [accountA],
        )).rows[0].count),
        events: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_events WHERE account_id=$1", [accountA],
        )).rows[0].count),
        policyVersion: (await repository.getAccountPolicy({ accountId: accountA })).version,
      };
      for (const command of adminLedgerCommands) {
        await assert.rejects(repository.createDraft({
          ...draftInput, idempotencyKey: command.idempotencyKey,
          correlationId: `create-with-${command.action}-${suffix}`,
        }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", status: 409 });
        await assert.rejects(repository.startSamplingSession({
          ...sessionInput, idempotencyKey: command.idempotencyKey,
          correlationId: `session-with-${command.action}-${suffix}`,
        }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", status: 409 });
        await assert.rejects(repository.commitSampleSet({
          ...commitBase, sampleSetHash: sha(`commit-with-${command.action}`),
          idempotencyKey: command.idempotencyKey,
          correlationId: `commit-with-${command.action}-${suffix}`,
        }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", status: 409 });
        await assert.rejects(repository.transitionAccountPolicy({
          accountId: accountA, actorId: accountA, expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY",
          idempotencyKey: command.idempotencyKey,
          correlationId: `policy-with-${command.action}-${suffix}`,
        }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", status: 409 });
      }
      assert.deepEqual({
        drafts: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_drafts WHERE account_id=$1", [accountA],
        )).rows[0].count),
        sessions: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_sampling_sessions WHERE account_id=$1", [accountA],
        )).rows[0].count),
        sampleSets: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_sample_sets WHERE account_id=$1", [accountA],
        )).rows[0].count),
        events: Number((await pool.query(
          "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_events WHERE account_id=$1", [accountA],
        )).rows[0].count),
        policyVersion: (await repository.getAccountPolicy({ accountId: accountA })).version,
      }, crossNamespaceBefore);
      await assert.rejects(repository.commitSampleSet({
        ...commitBase, sampleSetHash: sha("cross-command-commit"),
        idempotencyKey: draftInput.idempotencyKey,
        correlationId: `cross-command-commit-corr-${suffix}`,
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", status: 409 });
      assert.equal(Number((await pool.query(
        "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_sample_sets WHERE account_id=$1",
        [accountA],
      )).rows[0].count), 0);
      const { sessionSecretHash: _omittedSessionSecretHash, ...withoutSessionSecretHash } = commitBase;
      await assert.rejects(repository.commitSampleSet({
        ...withoutSessionSecretHash, sampleSetHash: sha("missing-secret"),
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_REPOSITORY_INVALID", status: 422 });
      await assert.rejects(repository.commitSampleSet({
        ...commitBase, sessionSecretHash: sha("wrong-session-secret"), sampleSetHash: sha("wrong-secret"),
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_SECRET_MISMATCH", status: 409 });
      await assert.rejects(repository.commitSampleSet({ ...commitBase, sampleSetHash: sha("wrong") }), {
        code: "AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_SET_HASH_MISMATCH", status: 409,
      });
      assert.equal(Number((await pool.query(
        "SELECT COUNT(*) AS count FROM auto_listing_category_strategy_samples WHERE account_id=$1 AND draft_id=$2",
        [accountA, draft.draftId],
      )).rows[0].count), 0);

      const expectedHash = await expectedSampleSetHash(pool, {
        accountId: accountA, draftId: draft.draftId, sessionId: liveSession.sessionId, scope, samples: initialSamples,
      });
      const concurrentInputs = ["one", "two"].map((label) => ({
        ...commitBase, sampleSetHash: expectedHash,
        idempotencyKey: `commit-${label}-${suffix}`, correlationId: `commit-${label}-corr-${suffix}`,
      }));
      const outcomes = await Promise.allSettled(concurrentInputs.map((input) => repository.commitSampleSet(input)));
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === "rejected"
        && outcome.reason?.code === "AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT").length, 1);
      const committed = outcomes.find((outcome) => outcome.status === "fulfilled").value;
      const winningInput = concurrentInputs.find((input) => input.idempotencyKey === committed.idempotencyKey);
      assert.equal((await repository.commitSampleSet(winningInput)).duplicate, true);
      await assert.rejects(repository.commitSampleSet({
        ...winningInput,
        expectedDraftVersion: 2,
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", status: 409 });
      assert.equal(committed.status, "SAMPLES_READY");
      assert.equal(committed.draftVersion, 2);
      await pool.query(
        `UPDATE auto_listing_category_strategy_drafts
            SET status='ANALYZING',draft_version=draft_version+1,updated_at=STATEMENT_TIMESTAMP()
          WHERE account_id=$1 AND id=$2 AND status='SAMPLES_READY' AND draft_version=2`,
        [accountA, draft.draftId],
      );
      const historicalDraftReplay = await repository.createDraft(draftInput);
      assert.deepEqual({ status: historicalDraftReplay.status, draftVersion: historicalDraftReplay.draftVersion }, {
        status: "COLLECTING", draftVersion: 1,
      });
      const historicalCommitReplay = await repository.commitSampleSet(winningInput);
      assert.deepEqual({ status: historicalCommitReplay.status, draftVersion: historicalCommitReplay.draftVersion }, {
        status: "SAMPLES_READY", draftVersion: 2,
      });

      await assert.rejects(repository.transitionAccountPolicy({
        accountId: accountA, actorId: accountA, expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY",
        idempotencyKey: draftInput.idempotencyKey,
        correlationId: `cross-command-policy-corr-${suffix}`,
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", status: 409 });
      assert.equal((await repository.getAccountPolicy({ accountId: accountA })).version, 1);

      const settings = await repository.transitionAccountPolicy({
        accountId: accountA, actorId: accountA, expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY",
        idempotencyKey: `policy-${suffix}`, correlationId: `policy-corr-${suffix}`,
      });
      assert.deepEqual({ mode: settings.mode, version: settings.version, duplicate: settings.duplicate }, {
        mode: "REQUIRE_EXACT_STRATEGY", version: 2, duplicate: false,
      });
      assert.equal((await repository.transitionAccountPolicy({
        accountId: accountA, actorId: accountA, expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY",
        idempotencyKey: `policy-${suffix}`, correlationId: `policy-corr-${suffix}`,
      })).duplicate, true);
      await assert.rejects(repository.transitionAccountPolicy({
        accountId: accountA, actorId: accountA, expectedVersion: 1, mode: "LEGACY_FALLBACK",
        idempotencyKey: `policy-${suffix}`, correlationId: `policy-corr-${suffix}`,
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", status: 409 });
      await assert.rejects(repository.transitionAccountPolicy({
        accountId: accountA, actorId: accountA, expectedVersion: 1, mode: "LEGACY_FALLBACK",
        idempotencyKey: `stale-policy-${suffix}`, correlationId: `stale-policy-corr-${suffix}`,
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_POLICY_VERSION_CONFLICT", status: 409 });
      await assert.rejects(repository.transitionAccountPolicy({
        accountId: accountA, actorId: accountB, expectedVersion: 2, mode: "LEGACY_FALLBACK",
        idempotencyKey: `wrong-actor-${suffix}`, correlationId: `wrong-actor-corr-${suffix}`,
      }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_REPOSITORY_INVALID", status: 422 });
      const laterSettings = await repository.transitionAccountPolicy({
        accountId: accountA, actorId: accountA, expectedVersion: 2, mode: "LEGACY_FALLBACK",
        idempotencyKey: `later-policy-${suffix}`, correlationId: `later-policy-corr-${suffix}`,
      });
      assert.equal(laterSettings.version, 3);
      const historicalReplay = await repository.transitionAccountPolicy({
        accountId: accountA, actorId: accountA, expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY",
        idempotencyKey: `policy-${suffix}`, correlationId: `policy-corr-${suffix}`,
      });
      assert.deepEqual({ mode: historicalReplay.mode, version: historicalReplay.version, duplicate: historicalReplay.duplicate }, {
        mode: "REQUIRE_EXACT_STRATEGY", version: 2, duplicate: true,
      });
      assert.equal((await repository.getAccountPolicy({ accountId: accountA })).version, 3);
    } finally {
      await pool?.end().catch(() => {});
      await admin.query("RESET search_path").catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => {});
      admin.release();
      await adminPool.end();
    }
  });
}
