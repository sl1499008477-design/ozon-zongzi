import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAutoListingAiAdminPostgres } from "../auto-listing-ai-admin-postgres.mjs";
import { createCategoryStrategyReadModel } from "../auto-listing-category-strategy-runtime.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresEnabled = process.env.AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const migrationPath = path.join(migrationsDir, "075_auto_listing_category_strategy_sampling.sql");
const sourceRevisionMigrationPath = path.join(
  migrationsDir,
  "093_category_strategy_source_product_revision.sql",
);
const archiveMigrationPath = path.join(
  migrationsDir,
  "097_category_strategy_auditable_archive.sql",
);
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const H = (digit) => digit.repeat(64);
const sha = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest("hex");

function legacyIncompleteSampleSetHash(samples) {
  return sha(samples.map((sample) => [
    String(sample.ordinal).padStart(4, "0"), sha(sample.sku),
    sample.images.map((image) => `${String(image.ordinal).padStart(2, "0")}:${image.role}:${image.imageId}`).join(","),
  ].join(":")).join("\n"));
}

test("093 keeps category-strategy source evidence immutable without locking the mutable product draft", async () => {
  const sql = await readFile(sourceRevisionMigrationPath, "utf8");

  assert.match(sql, /DROP CONSTRAINT IF EXISTS auto_listing_category_strateg_source_collect_item_id_sourc_fkey/iu);
  assert.match(sql, /FOREIGN KEY \(source_collect_item_id,source_product_draft_id\)[\s\S]*REFERENCES product_drafts\(collect_item_id,id\)/iu);
  assert.match(sql, /FOREIGN KEY \(source_product_draft_id,source_product_draft_version\)[\s\S]*REFERENCES product_draft_revisions\(draft_id,version\)/iu);
});

test("097 archives drafts without deleting immutable evidence and removes repeated source validation from updates", async () => {
  const sql = await readFile(archiveMigrationPath, "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ/iu);
  assert.match(sql, /removed_at IS NULL/iu);
  assert.match(sql, /TG_OP='INSERT'/iu);
  assert.doesNotMatch(sql, /\b(?:DELETE FROM|DROP TABLE|TRUNCATE)\b/iu);
});

async function databaseSampleSetHash(client, accountId, sampleSetId) {
  const result = await client.query(
    "SELECT auto_listing_category_strategy_canonical_sample_set_hash($1,$2) AS hash",
    [accountId, sampleSetId],
  );
  return result.rows[0].hash;
}

async function expectCode(promise, code = "23514") {
  await assert.rejects(promise, (error) => error?.code === code);
}

async function applyMigrations(client) {
  const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
  assert.equal(migrations.includes("076_auto_listing_category_strategy_analysis_edits.sql"), true);
  assert.equal(migrations.at(-1), "101_manual_category_confirmation_product_revision.sql");
  for (const migration of migrations) await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
}

async function createSource(client, { accountId, suffix, label }) {
  const collectItemId = `collect-${label}-${suffix}`;
  const productDraftId = `product-draft-${label}-${suffix}`;
  await client.query(
    "INSERT INTO collect_items (id,account_id,status,source_sku,source_url) VALUES ($1,$2,'COLLECTED',$3,$4)",
    [collectItemId, accountId, `source-${label}`, `https://www.ozon.ru/product/${label}`],
  );
  await client.query(
    "INSERT INTO product_drafts (id,collect_item_id,version,data_hash,data) VALUES ($1,$2,7,$3,'{}'::JSONB)",
    [productDraftId, collectItemId, H("a")],
  );
  await client.query(
    `INSERT INTO product_draft_revisions
       (id,draft_id,version,data_hash,data,changed_by,change_reason)
     VALUES ($1,$2,7,$3,'{}'::JSONB,$4,'category strategy migration test seed')`,
    [`product-draft-revision-${label}-${suffix}`, productDraftId, H("a"), accountId],
  );
  await client.query("UPDATE collect_items SET current_draft_id=$2 WHERE id=$1", [collectItemId, productDraftId]);
  return { collectItemId, productDraftId, productDraftVersion: 7, expectedSourceVersion: "draft:7" };
}

async function insertDraft(client, { id, accountId, source, typeId = 99, actorId = accountId, key }) {
  return client.query(
    `INSERT INTO auto_listing_category_strategy_drafts
       (id,account_id,taxonomy_scope,description_category_id,type_id,draft_version,status,
        source_collect_item_id,source_product_draft_id,source_product_draft_version,expected_source_version,
        idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,'OZON:DEFAULT',170,$3,1,'COLLECTING',$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, accountId, typeId, source.collectItemId, source.productDraftId, source.productDraftVersion,
      source.expectedSourceVersion, key, `${key}-correlation`, sha(key), actorId],
  );
}

async function insertSession(client, {
  id, accountId, draftId, typeId = 99, key, createdSql = "DEFAULT", expiresSql = "DEFAULT", state = "ACTIVE",
}) {
  return client.query(
    `INSERT INTO auto_listing_category_strategy_sampling_sessions
       (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,session_secret_hash,
        state,created_at,expires_at,idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,$3,'OZON:DEFAULT',170,$4,$5,$6,${createdSql},${expiresSql},$7,$8,$9,$2)`,
    [id, accountId, draftId, typeId, sha(`secret-${key}`), state, key, `${key}-correlation`, sha(key)],
  );
}

async function insertSampleSet(client, { id, accountId, draftId, sessionId, typeId = 99, key }) {
  return client.query(
    `INSERT INTO auto_listing_category_strategy_sample_sets
       (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,session_id,
        status,idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,$3,'OZON:DEFAULT',170,$4,$5,'BUILDING',$6,$7,$8,$2)`,
    [id, accountId, draftId, typeId, sessionId, key, `${key}-correlation`, sha(key)],
  );
}

async function addSample(client, context, ordinal, {
  sku = `sku-${ordinal}`, withMain = true, details = 0,
  objectAccountId = context.accountId, contentType = "image/webp", sourceUrlHost = "cdn.example.test",
  sourceProductId = 10_000 + ordinal, sourceProductRef = `ozon-product-${10_000 + ordinal}`,
  sourceProductResponseHash = sha(`product-response-${ordinal}`), imageEvidence = {},
} = {}) {
  const sampleId = `${context.sampleSetId}-sample-${ordinal}`;
  const sampleKey = `${context.sampleSetId}-sample-key-${ordinal}`;
  await client.query(
    `INSERT INTO auto_listing_category_strategy_samples
       (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,
        ordinal,sku,source_product_id,source_product_ref,source_product_response_hash,
        idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,$3,'OZON:DEFAULT',170,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$2)`,
    [sampleId, context.accountId, context.draftId, context.typeId, context.sampleSetId, ordinal, sku,
      sourceProductId, sourceProductRef, sourceProductResponseHash,
      sampleKey, `${sampleKey}-correlation`, sha(sampleKey)],
  );
  const images = [];
  const roles = withMain ? [{ role: "MAIN", ordinal: 0 }, ...Array.from({ length: details }, (_, index) => ({
    role: "DETAIL", ordinal: index + 1,
  }))] : [];
  for (const image of roles) {
    const defaultImageId = `${sampleId}-image-${image.ordinal}`;
    const objectPrefix = `category-strategy/${objectAccountId}/${context.draftId}/${context.sampleSetId}/${sampleId}`;
    const evidence = {
      imageId: defaultImageId,
      sourceUrlHost,
      sourceRefHash: sha(`source-ref-${defaultImageId}`),
      sourceResponseHash: sha(`response-${defaultImageId}`),
      sourceContentHash: sha(`source-${defaultImageId}`),
      analysisObjectKey: `${objectPrefix}/analysis-${image.ordinal}.webp`,
      analysisContentHash: sha(`analysis-${defaultImageId}`),
      thumbnailObjectKey: `${objectPrefix}/thumbnail-${image.ordinal}.webp`,
      thumbnailContentHash: sha(`thumbnail-${defaultImageId}`),
      contentType,
      width: 1200,
      height: 1600,
      capturedAt: "2026-08-14T00:00:00.000Z",
      ...imageEvidence,
    };
    const imageId = evidence.imageId;
    const imageKey = `${imageId}-key`;
    await client.query(
      `INSERT INTO auto_listing_category_strategy_sample_images
         (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_id,
          image_id,role,ordinal,source_url_host,source_ref_hash,source_response_hash,source_content_hash,
          analysis_object_key,analysis_content_hash,thumbnail_object_key,thumbnail_content_hash,
          content_type,width,height,captured_at,idempotency_key,correlation_id,request_hash,actor_account_id)
       VALUES ($1,$2,$3,'OZON:DEFAULT',170,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
         $14,$15,$16,$17,$18,$19,$20,$21::TIMESTAMPTZ,$22,$23,$24,$2)`,
      [imageId, context.accountId, context.draftId, context.typeId, context.sampleSetId, sampleId,
        imageId, image.role, image.ordinal, evidence.sourceUrlHost, evidence.sourceRefHash,
        evidence.sourceResponseHash, evidence.sourceContentHash, evidence.analysisObjectKey,
        evidence.analysisContentHash, evidence.thumbnailObjectKey, evidence.thumbnailContentHash,
        evidence.contentType, evidence.width, evidence.height, evidence.capturedAt,
        imageKey, `${imageKey}-correlation`, sha(imageKey)],
    );
    images.push({ imageId, role: image.role, ordinal: image.ordinal });
  }
  return { ordinal, sku, images, sampleId };
}

async function buildCanonicalEvidenceProbe(client, context, sessionId, {
  insertionOrder = [0, 1, 2, 3, 4], mutateFirstEvidence = () => {},
} = {}) {
  await insertSampleSet(client, {
    id: context.sampleSetId, accountId: context.accountId, draftId: context.draftId,
    sessionId, key: `${context.sampleSetId}-key`,
  });
  const samples = [];
  for (const ordinal of insertionOrder) {
    const sampleId = `${context.sampleSetId}-sample-${ordinal}`;
    const objectPrefix = `category-strategy/${context.accountId}/${context.draftId}/${context.sampleSetId}/${sampleId}`;
    const sampleEvidence = {
      sourceProductId: 20_000 + ordinal,
      sourceProductRef: `probe-product-${ordinal}`,
      sourceProductResponseHash: sha(`probe-product-response-${ordinal}`),
    };
    const imageEvidence = {
      imageId: `${sampleId}-image-0`,
      sourceUrlHost: "probe.cdn.example.test",
      sourceRefHash: sha(`probe-source-ref-${ordinal}`),
      sourceResponseHash: sha(`probe-source-response-${ordinal}`),
      sourceContentHash: sha(`probe-source-content-${ordinal}`),
      analysisObjectKey: `${objectPrefix}/analysis-0.webp`,
      analysisContentHash: sha(`probe-analysis-content-${ordinal}`),
      thumbnailObjectKey: `${objectPrefix}/thumbnail-0.webp`,
      thumbnailContentHash: sha(`probe-thumbnail-content-${ordinal}`),
      contentType: "image/webp",
      width: 1200,
      height: 1600,
      capturedAt: "2026-08-14T00:00:00.000Z",
    };
    if (ordinal === 0) mutateFirstEvidence({ sample: sampleEvidence, image: imageEvidence, objectPrefix });
    samples.push(await addSample(client, context, ordinal, {
      sku: `probe-sku-${ordinal}`, ...sampleEvidence, imageEvidence,
    }));
  }
  return samples;
}

async function sealSampleSet(client, sampleSetId, hash) {
  return client.query(
    "UPDATE auto_listing_category_strategy_sample_sets SET status='SEALED',sample_set_hash=$2 WHERE id=$1",
    [sampleSetId, hash],
  );
}

async function insertAttempt(client, context, { id, sampleSetHash, key }) {
  return client.query(
    `INSERT INTO auto_listing_category_strategy_analysis_attempts
       (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,
        sample_set_hash,analysis_input_hash,model_config_snapshot,model_config_hash,cost_confirmed,
        idempotency_key,correlation_id,request_hash,actor_account_id)
     VALUES ($1,$2,$3,'OZON:DEFAULT',170,$4,$5,$6,$7,'{"model":"test"}'::JSONB,$8,TRUE,$9,$10,$11,$2)`,
    [id, context.accountId, context.draftId, context.typeId, context.sampleSetId, sampleSetHash,
      sha(`analysis-input-${id}`), sha(`model-${id}`), key, `${key}-correlation`, sha(key)],
  );
}

test("075 defines closed provenance, transactional sealing, scoped publication, and immutable command history", async () => {
  const sql = await readFile(migrationPath, "utf8");
  for (const table of [
    "auto_listing_category_strategy_drafts", "auto_listing_category_strategy_account_settings",
    "auto_listing_category_strategy_sampling_sessions", "auto_listing_category_strategy_sample_sets",
    "auto_listing_category_strategy_samples", "auto_listing_category_strategy_sample_images",
    "auto_listing_category_strategy_analysis_attempts", "auto_listing_category_strategy_analysis_results",
    "auto_listing_category_strategy_events",
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "iu"));
  for (const token of [
    "source_collect_item_id", "source_product_draft_id", "source_product_draft_version", "expected_source_version",
    "session_secret_hash", "CANCELLED", "BUILDING", "SEALED", "source_product_id", "source_product_ref",
    "source_url_host", "source_ref_hash", "source_response_hash", "source_content_hash", "analysis_object_key",
    "analysis_content_hash", "thumbnail_object_key", "thumbnail_content_hash", "content_type", "captured_at",
  ]) assert.match(sql, new RegExp(token, "iu"));
  assert.match(sql, /auto_listing_category_strategy_canonical_sample_set_hash/iu);
  assert.match(sql, /FOREIGN KEY \(account_id,draft_id,taxonomy_scope,description_category_id,type_id,analysis_result_id\)/iu);
  assert.match(sql, /FOREIGN KEY \(account_id,published_strategy_version_id\)[\s\S]*?ai_content_strategy_versions\(account_id,id\)/iu);
  assert.match(sql, /CHECK \(actor_account_id=account_id\)/giu);
  assert.match(sql, /ERRCODE\s*=\s*'23514'/iu);
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/iu);
});

if (!postgresEnabled) {
  test("075 PostgreSQL attack matrix requires an explicit disposable PostgreSQL gate", {
    skip: "requires AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS=1 and TEST_DATABASE_URL",
  }, () => {});
} else {
  test("075 rejects every evidence-integrity attack and permits only closed transitions", { timeout: 60_000 }, async () => {
    const { Pool } = await import("pg");
    const root = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await root.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `category_strategy_${suffix}`;
    const accountA = `account-a-${suffix}`;
    const accountB = `account-b-${suffix}`;
    try {
      await client.query(`CREATE SCHEMA ${quote(schema)}`);
      await client.query(`SET search_path TO ${quote(schema)}, public`);
      await applyMigrations(client);
      await client.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active'),($3,$4,$4,'admin','active')",
        [accountA, `admin-a-${suffix}`, accountB, `admin-b-${suffix}`],
      );
      const sourceA = await createSource(client, { accountId: accountA, suffix, label: "a" });
      const sourceB = await createSource(client, { accountId: accountA, suffix, label: "b" });
      const draftA = `draft-a-${suffix}`;
      await expectCode(insertDraft(client, {
        id: `forged-actor-${suffix}`, accountId: accountA, actorId: accountB, source: sourceA, key: `forged-actor-key-${suffix}`,
      }));
      await expectCode(insertDraft(client, {
        id: `stale-source-${suffix}`, accountId: accountA,
        source: { ...sourceA, productDraftVersion: 6, expectedSourceVersion: "draft:6" }, key: `stale-source-key-${suffix}`,
      }));
      await insertDraft(client, { id: draftA, accountId: accountA, source: sourceA, key: `draft-a-key-${suffix}` });

      assert.deepEqual((await client.query(
        "SELECT mode,version FROM auto_listing_category_strategy_account_settings WHERE account_id=$1", [accountA],
      )).rows, [{ mode: "LEGACY_FALLBACK", version: "1" }]);
      const strictKey = `settings-strict-${suffix}`;
      const strictHash = sha(strictKey);
      await client.query(
        `UPDATE auto_listing_category_strategy_account_settings
            SET mode='REQUIRE_EXACT_STRATEGY',version=2,idempotency_key=$2,correlation_id=$3,request_hash=$4,actor_account_id=$1
          WHERE account_id=$1`,
        [accountA, strictKey, `${strictKey}-correlation`, strictHash],
      );
      const replay = await client.query(
        `UPDATE auto_listing_category_strategy_account_settings
            SET mode='REQUIRE_EXACT_STRATEGY',version=2,idempotency_key=$2,correlation_id=$3,request_hash=$4,actor_account_id=$1
          WHERE account_id=$1`,
        [accountA, strictKey, `${strictKey}-correlation`, strictHash],
      );
      assert.equal(replay.rowCount, 0);
      assert.equal((await client.query(
        "SELECT COUNT(*)::int AS count FROM auto_listing_category_strategy_events WHERE account_id=$1 AND idempotency_key=$2",
        [accountA, strictKey],
      )).rows[0].count, 1);
      await expectCode(client.query(
        `UPDATE auto_listing_category_strategy_account_settings
            SET mode='REQUIRE_EXACT_STRATEGY',version=3,idempotency_key=$2,correlation_id=$3,request_hash=$4,actor_account_id=$1
          WHERE account_id=$1`,
        [accountA, `settings-same-${suffix}`, `settings-same-correlation-${suffix}`, H("1")],
      ));
      await expectCode(client.query(
        `UPDATE auto_listing_category_strategy_account_settings
            SET mode='LEGACY_FALLBACK',version=3,idempotency_key=$2,correlation_id=$3,request_hash=$4,actor_account_id=$1
          WHERE account_id=$1`,
        [accountA, strictKey, `${strictKey}-correlation`, H("2")],
      ));
      const fallbackKey = `settings-fallback-${suffix}`;
      await client.query(
        `UPDATE auto_listing_category_strategy_account_settings
            SET mode='LEGACY_FALLBACK',version=3,idempotency_key=$2,correlation_id=$3,request_hash=$4,actor_account_id=$1
          WHERE account_id=$1`,
        [accountA, fallbackKey, `${fallbackKey}-correlation`, sha(fallbackKey)],
      );

      await expectCode(insertSession(client, {
        id: `session-early-${suffix}`, accountId: accountA, draftId: draftA, key: `session-early-key-${suffix}`,
        expiresSql: "STATEMENT_TIMESTAMP()+INTERVAL '1 hour'",
      }));
      await expectCode(insertSession(client, {
        id: `session-late-${suffix}`, accountId: accountA, draftId: draftA, key: `session-late-key-${suffix}`,
        expiresSql: "STATEMENT_TIMESTAMP()+INTERVAL '3 hours'",
      }));
      await expectCode(insertSession(client, {
        id: `session-forged-clock-${suffix}`, accountId: accountA, draftId: draftA,
        key: `session-forged-clock-key-${suffix}`,
        createdSql: "STATEMENT_TIMESTAMP()+INTERVAL '1 hour'",
        expiresSql: "STATEMENT_TIMESTAMP()+INTERVAL '3 hours'",
      }));
      const sessionA = `session-a-${suffix}`;
      await insertSession(client, { id: sessionA, accountId: accountA, draftId: draftA, key: `session-a-key-${suffix}` });
      const lifetime = await client.query(
        "SELECT EXTRACT(EPOCH FROM (expires_at-created_at))::int AS seconds FROM auto_listing_category_strategy_sampling_sessions WHERE id=$1",
        [sessionA],
      );
      assert.equal(lifetime.rows[0].seconds, 7_200);
      await expectCode(client.query(
        "UPDATE auto_listing_category_strategy_sampling_sessions SET expires_at=expires_at+INTERVAL '1 hour' WHERE id=$1",
        [sessionA],
      ));
      const cancelledSession = `session-cancelled-${suffix}`;
      await insertSession(client, {
        id: cancelledSession, accountId: accountA, draftId: draftA, key: `session-cancelled-key-${suffix}`,
      });
      await client.query(
        "UPDATE auto_listing_category_strategy_sampling_sessions SET state='CANCELLED' WHERE id=$1", [cancelledSession],
      );
      await expectCode(insertSampleSet(client, {
        id: `cancelled-set-${suffix}`, accountId: accountA, draftId: draftA, sessionId: cancelledSession,
        key: `cancelled-set-key-${suffix}`,
      }));

      const canonicalProbeSet = `set-canonical-probe-${suffix}`;
      const canonicalProbeContext = {
        accountId: accountA, draftId: draftA, typeId: 99, sampleSetId: canonicalProbeSet,
      };
      const provenanceMutations = [
        ["source product id", ({ sample }) => { sample.sourceProductId = 90_001; }],
        ["source product ref", ({ sample }) => { sample.sourceProductRef = "probe-product-mutated"; }],
        ["source product response hash", ({ sample }) => { sample.sourceProductResponseHash = H("1"); }],
        ["image id", ({ image }) => { image.imageId = `probe-image-mutated-${suffix}`; }],
        ["source host", ({ image }) => { image.sourceUrlHost = "mutated.cdn.example.test"; }],
        ["source ref hash", ({ image }) => { image.sourceRefHash = H("2"); }],
        ["image response hash", ({ image }) => { image.sourceResponseHash = H("3"); }],
        ["source content hash", ({ image }) => { image.sourceContentHash = H("4"); }],
        ["captured at", ({ image }) => { image.capturedAt = "2026-08-14T00:00:01.000Z"; }],
        ["analysis object key", ({ image, objectPrefix }) => {
          image.analysisObjectKey = `${objectPrefix}/analysis-mutated.webp`;
        }],
        ["analysis content hash", ({ image }) => { image.analysisContentHash = H("5"); }],
        ["thumbnail object key", ({ image, objectPrefix }) => {
          image.thumbnailObjectKey = `${objectPrefix}/thumbnail-mutated.webp`;
        }],
        ["thumbnail content hash", ({ image }) => { image.thumbnailContentHash = H("6"); }],
        ["mime", ({ image }) => { image.contentType = "image/png"; }],
        ["width", ({ image }) => { image.width = 1199; }],
        ["height", ({ image }) => { image.height = 1599; }],
      ];
      await client.query("BEGIN");
      try {
        await client.query("SAVEPOINT canonical_probe_empty");
        const baselineSamples = await buildCanonicalEvidenceProbe(
          client, canonicalProbeContext, sessionA,
        );
        const baselineHash = await databaseSampleSetHash(client, accountA, canonicalProbeSet);
        assert.equal(await databaseSampleSetHash(client, accountA, canonicalProbeSet), baselineHash);
        await client.query("SET LOCAL TIME ZONE 'Pacific/Kiritimati'");
        assert.equal(
          await databaseSampleSetHash(client, accountA, canonicalProbeSet), baselineHash,
          "the same instant must hash identically in another session timezone",
        );
        await client.query("SET LOCAL TIME ZONE 'UTC'");
        const legacyIncompleteHash = legacyIncompleteSampleSetHash(baselineSamples);
        await client.query("ROLLBACK TO SAVEPOINT canonical_probe_empty");

        for (const [label, mutateFirstEvidence] of provenanceMutations) {
          await buildCanonicalEvidenceProbe(client, canonicalProbeContext, sessionA, { mutateFirstEvidence });
          const changedHash = await databaseSampleSetHash(client, accountA, canonicalProbeSet);
          assert.notEqual(changedHash, baselineHash, `${label} must change the database canonical hash`);
          await client.query("SAVEPOINT stale_canonical_hash");
          await expectCode(sealSampleSet(client, canonicalProbeSet, baselineHash));
          await client.query("ROLLBACK TO SAVEPOINT stale_canonical_hash");
          await client.query("ROLLBACK TO SAVEPOINT canonical_probe_empty");
        }

        const eraHashes = [];
        for (const capturedAt of ["0001-01-01 00:00:00 AD", "0001-01-01 00:00:00 BC"]) {
          await buildCanonicalEvidenceProbe(client, canonicalProbeContext, sessionA, {
            mutateFirstEvidence: ({ image }) => { image.capturedAt = capturedAt; },
          });
          eraHashes.push(await databaseSampleSetHash(client, accountA, canonicalProbeSet));
          await client.query("ROLLBACK TO SAVEPOINT canonical_probe_empty");
        }
        assert.notEqual(
          eraHashes[0], eraHashes[1],
          "0001 AD and 0001 BC are different instants and must not share a canonical hash",
        );

        await buildCanonicalEvidenceProbe(client, canonicalProbeContext, sessionA, {
          insertionOrder: [4, 3, 2, 1, 0],
        });
        assert.equal(await databaseSampleSetHash(client, accountA, canonicalProbeSet), baselineHash);
        assert.notEqual(legacyIncompleteHash, baselineHash);
        await client.query("SAVEPOINT incomplete_canonical_hash");
        await expectCode(sealSampleSet(client, canonicalProbeSet, legacyIncompleteHash));
        await client.query("ROLLBACK TO SAVEPOINT incomplete_canonical_hash");
        await sealSampleSet(client, canonicalProbeSet, baselineHash);
      } finally {
        await client.query("ROLLBACK").catch(() => {});
      }

      const sampleSetA = `set-a-${suffix}`;
      const contextA = { accountId: accountA, draftId: draftA, typeId: 99, sampleSetId: sampleSetA };
      await insertSampleSet(client, {
        id: sampleSetA, accountId: accountA, draftId: draftA, sessionId: sessionA, key: `set-a-key-${suffix}`,
      });
      await expectCode(insertAttempt(client, contextA, {
        id: `attempt-before-seal-${suffix}`, sampleSetHash: H("3"), key: `attempt-before-seal-key-${suffix}`,
      }));
      const validSamples = [];
      for (let ordinal = 0; ordinal < 4; ordinal += 1) validSamples.push(await addSample(client, contextA, ordinal));
      await expectCode(addSample(client, contextA, 4, { sku: "sku-0" }));
      await expectCode(sealSampleSet(client, sampleSetA, await databaseSampleSetHash(client, accountA, sampleSetA)));
      validSamples.push(await addSample(client, contextA, 4));
      await expectCode(sealSampleSet(client, sampleSetA, H("4")));
      const sampleSetHash = await databaseSampleSetHash(client, accountA, sampleSetA);
      await sealSampleSet(client, sampleSetA, sampleSetHash);
      assert.deepEqual((await client.query(
        "SELECT status,sample_set_hash,sample_count,sealed_at IS NOT NULL AS sealed FROM auto_listing_category_strategy_sample_sets WHERE id=$1",
        [sampleSetA],
      )).rows, [{ status: "SEALED", sample_set_hash: sampleSetHash, sample_count: 5, sealed: true }]);
      await expectCode(addSample(client, contextA, 5));
      await expectCode(client.query(
        `INSERT INTO auto_listing_category_strategy_sample_images
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_id,
            image_id,role,ordinal,source_url_host,source_ref_hash,source_response_hash,source_content_hash,
            analysis_object_key,analysis_content_hash,thumbnail_object_key,thumbnail_content_hash,
            content_type,width,height,captured_at,idempotency_key,correlation_id,request_hash,actor_account_id)
         SELECT $1,account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,id,
           $1,'DETAIL',1,'cdn.example.test',$2,$3,$4,
           'category-strategy/'||account_id||'/'||draft_id||'/'||sample_set_id||'/'||id||'/late-analysis.webp',$5,
           'category-strategy/'||account_id||'/'||draft_id||'/'||sample_set_id||'/'||id||'/late-thumb.webp',$6,
           'image/webp',100,100,STATEMENT_TIMESTAMP(),$7,$8,$9,account_id
           FROM auto_listing_category_strategy_samples WHERE id=$10`,
        [`late-image-${suffix}`, H("5"), H("6"), H("7"), H("8"), H("9"), `late-image-key-${suffix}`,
          `late-image-correlation-${suffix}`, H("a"), validSamples[0].sampleId],
      ));

      const overSet = `set-over-${suffix}`;
      const overContext = { ...contextA, sampleSetId: overSet };
      await insertSampleSet(client, { id: overSet, accountId: accountA, draftId: draftA, sessionId: sessionA, key: `set-over-key-${suffix}` });
      const overSamples = [];
      for (let ordinal = 0; ordinal < 21; ordinal += 1) overSamples.push(await addSample(client, overContext, ordinal, { sku: `over-sku-${ordinal}` }));
      await expectCode(sealSampleSet(client, overSet, await databaseSampleSetHash(client, accountA, overSet)));

      const missingMainSet = `set-missing-main-${suffix}`;
      const missingMainContext = { ...contextA, sampleSetId: missingMainSet };
      await insertSampleSet(client, { id: missingMainSet, accountId: accountA, draftId: draftA, sessionId: sessionA, key: `set-missing-main-key-${suffix}` });
      const missingMainSamples = [];
      for (let ordinal = 0; ordinal < 5; ordinal += 1) missingMainSamples.push(await addSample(
        client, missingMainContext, ordinal, { sku: `missing-main-sku-${ordinal}`, withMain: ordinal !== 4 },
      ));
      await expectCode(sealSampleSet(
        client, missingMainSet, await databaseSampleSetHash(client, accountA, missingMainSet),
      ));

      const detailSet = `set-detail-${suffix}`;
      const detailContext = { ...contextA, sampleSetId: detailSet };
      await insertSampleSet(client, { id: detailSet, accountId: accountA, draftId: draftA, sessionId: sessionA, key: `set-detail-key-${suffix}` });
      await addSample(client, detailContext, 0, { sku: "detail-sku", details: 5 });
      await expectCode(addSample(client, detailContext, 1, { sku: "sixth-detail-probe", details: 6 }));

      const provenanceSet = `set-provenance-${suffix}`;
      const provenanceContext = { ...contextA, sampleSetId: provenanceSet };
      await insertSampleSet(client, { id: provenanceSet, accountId: accountA, draftId: draftA, sessionId: sessionA, key: `set-provenance-key-${suffix}` });
      await expectCode(addSample(client, provenanceContext, 0, {
        sku: "bad-provenance-sku", objectAccountId: accountB,
      }));

      const attempt = `attempt-a-${suffix}`;
      await insertAttempt(client, contextA, { id: attempt, sampleSetHash, key: `attempt-a-key-${suffix}` });
      const result = `result-a-${suffix}`;
      await client.query(
        `INSERT INTO auto_listing_category_strategy_analysis_results
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,
            sample_set_hash,analysis_input_hash,raw_response,raw_response_hash,guidance,guidance_hash,
            idempotency_key,correlation_id,request_hash,actor_account_id)
         SELECT $1,account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_id,
           sample_set_hash,analysis_input_hash,'{"result":"raw"}'::JSONB,$2,'{"overallStyle":"clean"}'::JSONB,$3,$4,$5,$6,account_id
           FROM auto_listing_category_strategy_analysis_attempts WHERE id=$7`,
        [result, H("b"), H("c"), `result-a-key-${suffix}`, `result-a-correlation-${suffix}`, H("d"), attempt],
      );
      assert.deepEqual((await client.query(
        "SELECT source_kind,edited_by,edited_at,base_analysis_attempt_id FROM auto_listing_category_strategy_analysis_results WHERE id=$1",
        [result],
      )).rows, [{ source_kind: "AI", edited_by: null, edited_at: null, base_analysis_attempt_id: null }]);
      await expectCode(client.query(
        `INSERT INTO auto_listing_category_strategy_analysis_results
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,
            sample_set_hash,analysis_input_hash,raw_response,raw_response_hash,guidance,guidance_hash,
            idempotency_key,correlation_id,request_hash,actor_account_id)
         SELECT $1,account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_id,
           sample_set_hash,analysis_input_hash,'{"duplicate":"ai"}'::JSONB,$2,'{"overallStyle":"duplicate"}'::JSONB,$3,$4,$5,$6,account_id
           FROM auto_listing_category_strategy_analysis_attempts WHERE id=$7`,
        [`duplicate-ai-${suffix}`, H("1"), H("2"), `duplicate-ai-key-${suffix}`,
          `duplicate-ai-correlation-${suffix}`, H("3"), attempt],
      ), "23505");
      await expectCode(client.query(
        `INSERT INTO auto_listing_category_strategy_analysis_results
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,
            sample_set_hash,analysis_input_hash,raw_response,raw_response_hash,guidance,guidance_hash,
            source_kind,idempotency_key,correlation_id,request_hash,actor_account_id)
         SELECT $1,account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_id,
           sample_set_hash,analysis_input_hash,'{"sourceKind":"MANUAL","baseAnalysisAttemptId":"missing"}'::JSONB,
           $2,'{"overallStyle":"edit"}'::JSONB,$3,'MANUAL',$4,$5,$6,account_id
           FROM auto_listing_category_strategy_analysis_attempts WHERE id=$7`,
        [`manual-missing-${suffix}`, H("4"), H("5"), `manual-missing-key-${suffix}`,
          `manual-missing-correlation-${suffix}`, H("6"), attempt],
      ));
      await expectCode(client.query(
        `INSERT INTO auto_listing_category_strategy_analysis_results
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,
            sample_set_hash,analysis_input_hash,raw_response,raw_response_hash,guidance,guidance_hash,
            source_kind,edited_by,edited_at,base_analysis_attempt_id,
            idempotency_key,correlation_id,request_hash,actor_account_id)
         SELECT $1,account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_id,
           sample_set_hash,analysis_input_hash,jsonb_build_object('sourceKind','MANUAL','baseAnalysisAttemptId',id),
           $2,'{"overallStyle":"cross-account"}'::JSONB,$3,'MANUAL',$4,STATEMENT_TIMESTAMP(),id,$5,$6,$7,$4
           FROM auto_listing_category_strategy_analysis_attempts WHERE id=$8`,
        [`manual-cross-account-${suffix}`, H("d"), H("e"), accountB,
          `manual-cross-account-key-${suffix}`, `manual-cross-account-correlation-${suffix}`, H("f"), attempt],
      ));
      const manualResult = `manual-result-${suffix}`;
      await client.query(
        `INSERT INTO auto_listing_category_strategy_analysis_results
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,
            sample_set_hash,analysis_input_hash,raw_response,raw_response_hash,guidance,guidance_hash,
            source_kind,edited_by,edited_at,base_analysis_attempt_id,
            idempotency_key,correlation_id,request_hash,actor_account_id)
         SELECT $1,account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_id,
           sample_set_hash,analysis_input_hash,jsonb_build_object('sourceKind','MANUAL','baseAnalysisAttemptId',id),
           $2,'{"overallStyle":"edited"}'::JSONB,$3,'MANUAL',account_id,STATEMENT_TIMESTAMP(),id,$4,$5,$6,account_id
           FROM auto_listing_category_strategy_analysis_attempts WHERE id=$7`,
        [manualResult, H("7"), H("8"), `manual-result-key-${suffix}`,
          `manual-result-correlation-${suffix}`, H("9"), attempt],
      );
      await expectCode(client.query(
        "UPDATE auto_listing_category_strategy_analysis_results SET edited_by=$2 WHERE id=$1",
        [manualResult, accountB],
      ));
      await expectCode(client.query(
        `INSERT INTO auto_listing_category_strategy_analysis_results
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,
            sample_set_hash,analysis_input_hash,raw_response,raw_response_hash,guidance,guidance_hash,
            source_kind,edited_by,edited_at,base_analysis_attempt_id,
            idempotency_key,correlation_id,request_hash,actor_account_id)
         SELECT $1,account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_id,
           sample_set_hash,analysis_input_hash,jsonb_build_object('sourceKind','MANUAL','baseAnalysisAttemptId',id,'vendorRaw','forbidden'),
           $2,'{"overallStyle":"edited"}'::JSONB,$3,'MANUAL',account_id,STATEMENT_TIMESTAMP(),id,$4,$5,$6,account_id
           FROM auto_listing_category_strategy_analysis_attempts WHERE id=$7`,
        [`manual-vendor-${suffix}`, H("a"), H("b"), `manual-vendor-key-${suffix}`,
          `manual-vendor-correlation-${suffix}`, H("c"), attempt],
      ));
      const strategy = `strategy-${suffix}`;
      await client.query(
        "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,'category-strategy',1,'DRAFT','{}'::JSONB,$3)",
        [strategy, accountA, H("e")],
      );
      await client.query(
        "UPDATE ai_content_strategy_versions SET status='PUBLISHED',published_at=STATEMENT_TIMESTAMP(),published_by=$2 WHERE id=$1",
        [strategy, accountA],
      );
      const publishedEvent = `published-event-${suffix}`;
      await client.query(
        `INSERT INTO auto_listing_category_strategy_events
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,event_type,
            analysis_result_id,published_strategy_version_id,idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,'OZON:DEFAULT',170,99,'PUBLISHED',$4,$5,$6,$7,$8,$2)`,
        [publishedEvent, accountA, draftA, result, strategy, `published-event-key-${suffix}`, `published-event-correlation-${suffix}`, H("f")],
      );

      const archiveEnableKey = `settings-archive-enable-${suffix}`;
      await client.query(
        `UPDATE auto_listing_category_strategy_account_settings
            SET mode='REQUIRE_EXACT_STRATEGY',version=4,idempotency_key=$2,correlation_id=$3,
                request_hash=$4,actor_account_id=$1
          WHERE account_id=$1`,
        [accountA, archiveEnableKey, `${archiveEnableKey}-correlation`, sha(archiveEnableKey)],
      );

      const scopedPool = {
        async connect() { return { query: client.query.bind(client), release() {} }; },
        query: client.query.bind(client),
      };
      const archived = await createAutoListingAiAdminPostgres({ pool: scopedPool })
        .archiveCategoryStrategyDraft({
          accountId: accountA, actorId: accountA, draftId: draftA, expectedDraftVersion: 1,
          idempotencyKey: `archive-draft-key-${suffix}`,
          correlationId: `archive-draft-correlation-${suffix}`,
        });
      assert.deepEqual({ removed: archived.removed, draftVersion: archived.draftVersion,
        activeStrategyChanged: archived.activeStrategyChanged }, {
        removed: true, draftVersion: 2, activeStrategyChanged: false,
      });
      assert.equal((await client.query(
        "SELECT removed_at IS NOT NULL AS removed FROM auto_listing_category_strategy_drafts WHERE id=$1",
        [draftA],
      )).rows[0].removed, true);
      assert.equal((await createCategoryStrategyReadModel({ pool: scopedPool })
        .listStrategies({ accountId: accountA })).some((entry) => entry.draftId === draftA), false);

      const draftWrongScope = `draft-wrong-scope-${suffix}`;
      await insertDraft(client, {
        id: draftWrongScope, accountId: accountA, source: sourceB, typeId: 100, key: `draft-wrong-scope-key-${suffix}`,
      });
      await expectCode(client.query(
        `INSERT INTO auto_listing_category_strategy_events
           (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,event_type,
            analysis_result_id,published_strategy_version_id,idempotency_key,correlation_id,request_hash,actor_account_id)
         VALUES ($1,$2,$3,'OZON:DEFAULT',170,100,'PUBLISHED',$4,$5,$6,$7,$8,$2)`,
        [`forged-result-event-${suffix}`, accountA, draftWrongScope, result, strategy,
          `forged-result-event-key-${suffix}`, `forged-result-event-correlation-${suffix}`, H("0")],
      ));
      await expectCode(client.query("DELETE FROM auto_listing_category_strategy_drafts WHERE id=$1", [draftA]));

      const disposableDraft = `draft-disposable-${suffix}`;
      await insertDraft(client, { id: disposableDraft, accountId: accountA, source: sourceB, typeId: 101, key: `draft-disposable-key-${suffix}` });
      await client.query("DELETE FROM auto_listing_category_strategy_drafts WHERE id=$1", [disposableDraft]);

      assert.equal((await client.query(
        "SELECT COUNT(*)::int AS count FROM auto_listing_category_strategy_events WHERE account_id=$1", [accountB],
      )).rows[0].count, 1);
      await client.query("DELETE FROM accounts WHERE id=$1", [accountB]);
      assert.equal((await client.query(
        `SELECT (
           (SELECT COUNT(*) FROM auto_listing_category_strategy_account_settings WHERE account_id=$1)
           +(SELECT COUNT(*) FROM auto_listing_category_strategy_events WHERE account_id=$1))::int AS count`,
        [accountB],
      )).rows[0].count, 0);

      for (const [table, id] of [
        ["auto_listing_category_strategy_sample_sets", sampleSetA],
        ["auto_listing_category_strategy_analysis_results", result],
        ["auto_listing_category_strategy_analysis_results", manualResult],
        ["auto_listing_category_strategy_events", publishedEvent],
      ]) {
        await expectCode(client.query(`UPDATE ${table} SET correlation_id='mutated' WHERE id=$1`, [id]));
        await expectCode(client.query(`DELETE FROM ${table} WHERE id=$1`, [id]));
      }
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => {});
      client.release();
      await root.end();
    }
  });
}
