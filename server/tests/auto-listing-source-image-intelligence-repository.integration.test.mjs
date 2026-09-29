import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION } from "../auto-listing-source-image-intelligence-contract.mjs";

const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const assessment = (sourceAssetId, sourceOrdinal, terminalStatus = "ANALYZED", contentDigit = "a") => {
  const value = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION, sourceAssetId, sourceOrdinal,
    objectKey: `auto-listing/source/v2/account/job/item/analysis-run/run/${sourceAssetId}/object.jpg`,
    contentHash: contentDigit.repeat(64), parentSourceAssetId: null, terminalStatus,
    contentKinds: ["PRODUCT_VIEW"],
    viewpoints: [{ kind: "FRONT", confidence: "CONFIRMED", reasonCodes: ["VISIBLE_FRONT"] }],
    subjectBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    quality: { confidence: "CONFIRMED", usable: true, reasonCodes: [] },
    ocrRegions: [], markings: [], perceptualDuplicateGroup: null, duplicateOfSourceAssetId: null,
    eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW"], reasonCodes: [],
  };
  return { ...value, assessmentHash: digest(value) };
};
const summary = (overrides = {}) => {
  const value = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    coverageMap: { FRONT: ["asset-1"] }, factCandidates: [], markingDecisions: [],
    eligibleAssetIds: ["asset-1", "asset-2"], excludedAssetIds: ["asset-3"],
    requiredConfirmations: [], symmetryClass: "ASYMMETRIC", reasonCodes: [], ...overrides,
  };
  return { ...value, summaryHash: digest(value) };
};
async function runHistoricalMigrationFixture({ applyThrough102, seedHistoricalRows, apply103 }) {
  await applyThrough102();
  await seedHistoricalRows();
  await apply103();
}

test("PostgreSQL fixture seeds historical Outbox rows between migration 102 and 103", async () => {
  const events = [];
  await runHistoricalMigrationFixture({
    applyThrough102: async () => events.push("migrate-through-102"),
    seedHistoricalRows: async () => events.push("seed-v1-v2-outbox"),
    apply103: async () => events.push("apply-103"),
  });
  assert.deepEqual(events, ["migrate-through-102", "seed-v1-v2-outbox", "apply-103"]);
});

test("PostgreSQL repository replays runs and enforces account scope after fresh migrations", {
  skip: enabled ? false : "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
}, async () => {
  const { Pool } = await import("pg");
  const { createAutoListingRepository } = await import("../auto-listing-repository.mjs");
  const { createPostgresSourceImageIntelligenceRepository } = await import("../auto-listing-source-image-intelligence-repository.mjs");
  const adminPool = new Pool({ connectionString: process.env.SONLI_MIGRATION_TEST_DATABASE_URL, max: 1 });
  const schema = `source_image_intelligence_${randomUUID().replaceAll("-", "")}`;
  const suffix = randomUUID().replaceAll("-", "");
  const ids = Object.fromEntries(["accountA", "accountB", "store", "warehouse", "strategy", "snapshot", "job", "item", "profile"]
    .map((key) => [key, `${key}-${suffix}`]));
  const client = await adminPool.connect();
  let pool;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    const migrations = (await readdir(migrationsDirectory)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
    const migration103 = "103_auto_listing_source_image_intelligence.sql";
    const migrationsThrough102 = migrations.filter((file) => Number.parseInt(file.slice(0, 3), 10) <= 102);
    assert.equal(migrations.includes(migration103), true);
    const historicalRows = [
      { contractVersion: "V1", phase: "PLAN_CONTENT", phaseTargetId: null },
      { contractVersion: "V2", phase: "MATERIALIZE_SOURCE_ASSET", phaseTargetId: "asset-historical" },
    ].map(({ contractVersion, phase, phaseTargetId }) => {
      const correlationId = `correlation-${contractVersion.toLowerCase()}-${suffix}`;
      const payload = {
        contractVersion, accountId: ids.accountA, itemId: ids.item, phase,
        expectedStatusVersion: 7, correlationId,
        ...(phaseTargetId === null ? {} : { sourceAssetId: phaseTargetId }),
      };
      return {
        id: `outbox-${contractVersion.toLowerCase()}-${suffix}`,
        contractVersion,
        dedupeKey: digest({ contractVersion, suffix }),
        correlationId,
        phase,
        phaseTargetId,
        state: "PENDING",
        payload,
      };
    });
    await runHistoricalMigrationFixture({
      applyThrough102: async () => {
        for (const migration of migrationsThrough102) {
          await client.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
        }
      },
      seedHistoricalRows: async () => {
        for (const accountId of [ids.accountA, ids.accountB]) await client.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [accountId, `user-${accountId}`],
        );
        await client.query(
          "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$1,$1,$2,'active',$3)",
          [ids.store, `client-${suffix}`, ids.accountA],
        );
        await client.query(
          "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$1,'FBS','active',TRUE,FALSE)",
          [ids.warehouse, ids.store],
        );
        await client.query(
          "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,'default',1,'PUBLISHED','{}'::JSONB,$3)",
          [ids.strategy, ids.accountA, "a".repeat(64)],
        );
        await client.query(
          `INSERT INTO ai_gateway_profiles (
            id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
            text_model,image_model,config_version,enabled
          ) VALUES ($1,$2,'Profile','https://gateway.invalid','TEST_KEY','SUB2API_RESPONSES',
            'SUB2API_OPENAI_IMAGES','text-model','vision-model',1,FALSE)`,
          [ids.profile, ids.accountA],
        );
        await client.query(
          "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
          [ids.snapshot, ids.accountA, `record-${suffix}`, "b".repeat(64)],
        );
        await client.query(
          `INSERT INTO auto_listing_jobs (
            id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version
          ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,1)`,
          [ids.job, ids.accountA, `job-${suffix}`, "c".repeat(64), ids.strategy, ids.profile],
        );
        await client.query(
          `INSERT INTO auto_listing_job_items (
            id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
          ) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',7,1)`,
          [ids.item, ids.job, ids.accountA, ids.snapshot, ids.store, ids.warehouse],
        );
        for (const row of historicalRows) await client.query(
          `INSERT INTO auto_listing_ai_outbox (
            id,account_id,job_id,item_id,event_type,dedupe_key,payload,state,contract_version,phase,
            phase_target_id,expected_status_version,correlation_id,next_retry_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB,$8,$9,$10,$11,7,$12,NOW())`,
          [row.id, ids.accountA, ids.job, ids.item, row.phase, row.dedupeKey, JSON.stringify(row.payload),
            row.state, row.contractVersion, row.phase, row.phaseTargetId, row.correlationId],
        );
      },
      apply103: async () => {
        await client.query(await readFile(path.join(migrationsDirectory, migration103), "utf8"));
      },
    });
    const preservedRows = await client.query(
      `SELECT id,contract_version AS "contractVersion",payload,phase,phase_target_id AS "phaseTargetId",state
        FROM auto_listing_ai_outbox WHERE account_id=$1 AND contract_version IN ('V1','V2') ORDER BY contract_version`,
      [ids.accountA],
    );
    assert.deepEqual(preservedRows.rows, historicalRows.map((row) => ({
      id: row.id, contractVersion: row.contractVersion, payload: row.payload,
      phase: row.phase, phaseTargetId: row.phaseTargetId, state: row.state,
    })));
    pool = new Pool({
      connectionString: process.env.SONLI_MIGRATION_TEST_DATABASE_URL,
      max: 2,
      options: `-c search_path=${schema},public`,
    });
    let sequence = 0;
    const repository = createPostgresSourceImageIntelligenceRepository({
      pool,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
      id: (kind) => `${kind}-${++sequence}-${suffix}`,
      token: () => `token-${suffix}`,
    });
    const input = {
      accountId: ids.accountA, jobId: ids.job, itemId: ids.item, sourceSnapshotId: ids.snapshot,
      expectedStatusVersion: 7, contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
      sourceSnapshotHash: "b".repeat(64), sourceAssetSetHash: "d".repeat(64), inputHash: "e".repeat(64),
      promptTemplateVersion: "source-image-analysis-v1", profileId: ids.profile, profileVersion: 1,
      modelName: "vision-model", expectedAssetCount: 3,
    };
    const first = await repository.reserveAnalysisRun(input);
    assert.deepEqual(await repository.reserveAnalysisRun(input), first);
    await assert.rejects(repository.markAssetUnavailable({
      accountId: ids.accountB, jobId: ids.job, itemId: ids.item, analysisRunId: first.id,
      expectedStatusVersion: 7, sourceAssetId: "asset-1", sourceOrdinal: 0, terminalStatus: "DOWNLOAD_FAILED",
      errorCode: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED",
    }), { code: "AUTO_LISTING_SOURCE_IMAGE_SCOPE_CONFLICT" });

    const runScope = {
      accountId: ids.accountA, jobId: ids.job, itemId: ids.item,
      analysisRunId: first.id, expectedStatusVersion: 7,
    };
    const materialized = {
      ...runScope, sourceAssetId: "asset-1", sourceOrdinal: 0, sourceRefHash: "f".repeat(64),
      objectKey: assessment("asset-1", 0).objectKey, contentHash: "a".repeat(64),
      contentType: "image/jpeg", sizeBytes: 1024,
    };
    const materializedFirst = await repository.markAssetMaterialized(materialized);
    assert.deepEqual(await repository.markAssetMaterialized(materialized), materializedFirst);
    const assessments = [assessment("asset-1", 0), assessment("asset-2", 1, "ANALYZED", "b")];
    const batch = {
      ...runScope, analysisBatchId: "batch-1", inputHash: "1".repeat(64),
      resultHash: digest(assessments.map(({ assessmentHash }) => assessmentHash)), assessments,
    };
    assert.equal((await repository.recordBatchAssessments(batch)).status, "ACCEPTED");
    assert.equal((await repository.recordBatchAssessments(batch)).status, "EXISTING_ACCEPTED");
    const conflictingAssessments = [assessment("asset-4", 3, "ANALYZED", "d"), assessment("asset-1", 0, "ANALYZED", "c")];
    await assert.rejects(repository.recordBatchAssessments({
      ...batch, analysisBatchId: "batch-conflict", inputHash: "2".repeat(64),
      resultHash: digest(conflictingAssessments.map(({ assessmentHash }) => assessmentHash)),
      assessments: conflictingAssessments,
    }), { code: "AUTO_LISTING_SOURCE_IMAGE_ASSESSMENT_CONFLICT" });
    assert.equal((await repository.listRunAssessments(runScope)).some(({ sourceAssetId }) => sourceAssetId === "asset-4"), false);
    await assert.rejects(repository.acceptSummary({
      ...runScope, inputHash: "3".repeat(64), summary: summary({ requiredConfirmations: ["asset-2"] }),
    }), { code: "AUTO_LISTING_SOURCE_IMAGE_TERMINAL_COUNT_MISMATCH" });

    const unavailable = {
      ...runScope, sourceAssetId: "asset-3", sourceOrdinal: 2, terminalStatus: "DOWNLOAD_FAILED",
      errorCode: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED",
    };
    const unavailableFirst = await repository.markAssetUnavailable(unavailable);
    assert.deepEqual(await repository.markAssetUnavailable(unavailable), unavailableFirst);
    const unavailableEvidence = await client.query(
      `SELECT source_ordinal,terminal_status FROM auto_listing_source_image_assessments
        WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND analysis_run_id=$4 AND source_asset_id='asset-3'`,
      [ids.accountA, ids.job, ids.item, first.id],
    );
    assert.deepEqual(unavailableEvidence.rows[0], { source_ordinal: 2, terminal_status: "DOWNLOAD_FAILED" });
    await client.query(
      `UPDATE auto_listing_job_items SET status='BLOCKED',status_version=8,
         failure_code='AUTO_LISTING_SOURCE_IMAGE_EVIDENCE_INSUFFICIENT',
         failure_detail_safe='AUTO_LISTING_SOURCE_IMAGE_EVIDENCE_INSUFFICIENT',recovery_point=NULL
       WHERE account_id=$1 AND job_id=$2 AND id=$3 AND status='PLANNING' AND status_version=7`,
      [ids.accountA, ids.job, ids.item],
    );
    const blockedJob = await createAutoListingRepository({ pool }).getJob({
      accountId: ids.accountA, jobId: ids.job,
    });
    assert.deepEqual(blockedJob.items[0].sourceImageFailure, {
      reasonCode: "DOWNLOAD_FAILED", sourceOrdinal: 2, viewpoint: "UNKNOWN",
    });
    await client.query(
      `UPDATE auto_listing_job_items SET status='PLANNING',status_version=7,
         failure_code=NULL,failure_detail_safe=NULL,recovery_point=NULL
       WHERE account_id=$1 AND job_id=$2 AND id=$3 AND status='BLOCKED' AND status_version=8`,
      [ids.accountA, ids.job, ids.item],
    );
    const parentSummary = summary({ requiredConfirmations: [{
      sourceAssetId: "asset-2", kind: "UNCERTAIN_MARKING", regions: [],
      reasonCodes: ["AUTO_LISTING_SOURCE_IMAGE_UNIQUE_VIEW_MARKING_UNCERTAIN"],
    }] });
    const parent = await repository.acceptSummary({
      ...runScope, inputHash: "3".repeat(64), summary: parentSummary,
    });
    assert.equal(parent.status, "CONFIRMATION_REQUIRED");
    assert.deepEqual(await repository.markAssetMaterialized(materialized), materializedFirst);
    assert.deepEqual(await repository.markAssetUnavailable(unavailable), unavailableFirst);
    assert.equal((await repository.recordBatchAssessments(batch)).status, "EXISTING_ACCEPTED");
    await assert.rejects(repository.markAssetMaterialized({
      ...materialized, sourceAssetId: "asset-4", sourceOrdinal: 3,
      objectKey: assessment("asset-4", 3, "ANALYZED", "d").objectKey, contentHash: "d".repeat(64),
    }), { code: "AUTO_LISTING_SOURCE_IMAGE_RUN_TERMINAL" });
    await assert.rejects(repository.markAssetUnavailable({
      ...runScope, sourceAssetId: "asset-4", sourceOrdinal: 3, terminalStatus: "DOWNLOAD_FAILED",
      errorCode: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED",
    }), { code: "AUTO_LISTING_SOURCE_IMAGE_RUN_TERMINAL" });
    await assert.rejects(repository.recordBatchAssessments({
      ...batch, analysisBatchId: "batch-terminal", inputHash: "5".repeat(64),
      resultHash: digest([assessment("asset-4", 3, "ANALYZED", "d").assessmentHash]),
      assessments: [assessment("asset-4", 3, "ANALYZED", "d")],
    }), { code: "AUTO_LISTING_SOURCE_IMAGE_RUN_TERMINAL" });

    const parentAssessments = await repository.listRunAssessments(runScope);
    await client.query(
      `UPDATE auto_listing_job_items SET status='BLOCKED',status_version=8,
         failure_code='AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED',
         failure_detail_safe='AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED',recovery_point=NULL
       WHERE account_id=$1 AND job_id=$2 AND id=$3 AND status='PLANNING' AND status_version=7`,
      [ids.accountA, ids.job, ids.item],
    );
    assert.deepEqual(await repository.acceptSummary({
      ...runScope, inputHash: "3".repeat(64), summary: parentSummary,
    }), parent);

    const rollbackIdempotencyKey = `decision-rollback-${suffix}`;
    await client.query(`CREATE FUNCTION reject_source_reconcile_${suffix}() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.contract_version='V3' AND NEW.phase='RECONCILE_SOURCE_IMAGE_ANALYSIS' THEN
          RAISE EXCEPTION 'forced source decision rollback';
        END IF;
        RETURN NEW;
      END $$`);
    await client.query(`CREATE TRIGGER reject_source_reconcile_${suffix}
      BEFORE INSERT ON auto_listing_ai_outbox FOR EACH ROW
      EXECUTE FUNCTION reject_source_reconcile_${suffix}()`);
    await assert.rejects(repository.recordSourceImageDecision({
      ...runScope, expectedStatusVersion: 8, sourceAssetId: "asset-2",
      decision: "EXTERNAL_OVERLAY_EXCLUDE", idempotencyKey: rollbackIdempotencyKey,
      correlationId: `correlation-rollback-${suffix}`,
    }), { code: "AUTO_LISTING_SOURCE_IMAGE_REPOSITORY_FAILED" });
    const rolledBack = await client.query(
      `SELECT item.status,item.status_version,item.recovery_point,item.failure_code,item.failure_detail_safe,
              item.current_source_image_analysis_run_id,
              (SELECT COUNT(*)::INTEGER FROM auto_listing_source_image_decisions decision
                WHERE decision.account_id=item.account_id AND decision.idempotency_key=$4) AS decisions,
              (SELECT COUNT(*)::INTEGER FROM auto_listing_source_image_analysis_runs derived
                WHERE derived.account_id=item.account_id AND derived.parent_run_id=$5) AS derived_runs,
              (SELECT COUNT(*)::INTEGER FROM auto_listing_events event
                WHERE event.account_id=item.account_id AND event.job_id=item.job_id AND event.item_id=item.id
                  AND event.event_type='SOURCE_IMAGE_DECISION_ACCEPTED') AS events,
              (SELECT COUNT(*)::INTEGER FROM auto_listing_ai_outbox outbox
                WHERE outbox.account_id=item.account_id AND outbox.job_id=item.job_id AND outbox.item_id=item.id
                  AND outbox.contract_version='V3' AND outbox.phase='RECONCILE_SOURCE_IMAGE_ANALYSIS') AS outbox_rows
         FROM auto_listing_job_items item
        WHERE item.account_id=$1 AND item.job_id=$2 AND item.id=$3`,
      [ids.accountA, ids.job, ids.item, rollbackIdempotencyKey, first.id],
    );
    assert.deepEqual(rolledBack.rows[0], {
      status: "BLOCKED", status_version: 8, recovery_point: null,
      failure_code: "AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED",
      failure_detail_safe: "AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED",
      current_source_image_analysis_run_id: first.id,
      decisions: 0, derived_runs: 0, events: 0, outbox_rows: 0,
    });
    await client.query(`DROP TRIGGER reject_source_reconcile_${suffix} ON auto_listing_ai_outbox`);
    await client.query(`DROP FUNCTION reject_source_reconcile_${suffix}()`);

    const decisionInput = {
      ...runScope, expectedStatusVersion: 8, sourceAssetId: "asset-2",
      decision: "EXTERNAL_OVERLAY_EXCLUDE", idempotencyKey: `decision-asset-2-${suffix}`,
      correlationId: `correlation-decision-${suffix}`,
    };
    const decisionResult = await repository.recordSourceImageDecision(decisionInput);
    const { derivedRun } = decisionResult;
    assert.equal(derivedRun.expectedStatusVersion, 9);
    assert.deepEqual(decisionResult.item, { status: "PLANNING", statusVersion: 9 });
    assert.deepEqual(decisionResult.event, {
      eventType: "SOURCE_IMAGE_DECISION_ACCEPTED", fromStatus: "BLOCKED", toStatus: "PLANNING",
      transitionVersion: 9, correlationId: decisionInput.correlationId,
    });
    assert.equal(decisionResult.outbox.phase, "RECONCILE_SOURCE_IMAGE_ANALYSIS");
    assert.equal(decisionResult.outbox.expectedStatusVersion, 9);
    assert.equal(decisionResult.outbox.analysisRunId, derivedRun.id);
    const replayDecision = await repository.recordSourceImageDecision({
      ...decisionInput, correlationId: `correlation-replay-${suffix}`,
    });
    assert.deepEqual(replayDecision, decisionResult);
    await assert.rejects(repository.recordSourceImageDecision({
      ...decisionInput, decision: "PRODUCT_MARKING", correlationId: `correlation-conflict-${suffix}`,
    }), { code: "AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT" });
    const lifecycleRows = await client.query(
      `SELECT item.status,item.status_version,item.recovery_point,item.failure_code,item.failure_detail_safe,
              item.current_source_image_analysis_run_id,
              (SELECT COUNT(*)::INTEGER FROM auto_listing_source_image_decisions decision
                WHERE decision.account_id=item.account_id AND decision.idempotency_key=$4) AS decisions,
              (SELECT COUNT(*)::INTEGER FROM auto_listing_source_image_analysis_runs derived
                WHERE derived.account_id=item.account_id AND derived.parent_run_id=$5) AS derived_runs,
              (SELECT COUNT(*)::INTEGER FROM auto_listing_events event
                WHERE event.account_id=item.account_id AND event.job_id=item.job_id AND event.item_id=item.id
                  AND event.event_type='SOURCE_IMAGE_DECISION_ACCEPTED') AS events,
              (SELECT COUNT(*)::INTEGER FROM auto_listing_ai_outbox outbox
                WHERE outbox.account_id=item.account_id AND outbox.job_id=item.job_id AND outbox.item_id=item.id
                  AND outbox.contract_version='V3' AND outbox.phase='RECONCILE_SOURCE_IMAGE_ANALYSIS') AS outbox_rows,
              (SELECT COUNT(*)::INTEGER FROM auto_listing_ai_outbox outbox
                WHERE outbox.account_id=item.account_id AND outbox.job_id=item.job_id AND outbox.item_id=item.id
                  AND outbox.contract_version='V3' AND outbox.phase<>'RECONCILE_SOURCE_IMAGE_ANALYSIS') AS other_v3_rows
         FROM auto_listing_job_items item
        WHERE item.account_id=$1 AND item.job_id=$2 AND item.id=$3`,
      [ids.accountA, ids.job, ids.item, decisionInput.idempotencyKey, first.id],
    );
    assert.deepEqual(lifecycleRows.rows[0], {
      status: "PLANNING", status_version: 9, recovery_point: null, failure_code: null, failure_detail_safe: null,
      current_source_image_analysis_run_id: derivedRun.id,
      decisions: 1, derived_runs: 1, events: 1, outbox_rows: 1, other_v3_rows: 0,
    });
    const derivedScope = {
      accountId: ids.accountA, jobId: ids.job, itemId: ids.item,
      analysisRunId: derivedRun.id, expectedStatusVersion: 9,
    };
    assert.equal(await repository.loadAcceptedSummary(derivedScope), null);
    assert.deepEqual(
      (await repository.listRunAssessments(derivedScope)).map(({ resultHash }) => resultHash),
      parentAssessments.map(({ resultHash }) => resultHash),
    );
    const acceptedDerived = await repository.acceptSummary({
      ...derivedScope, inputHash: "4".repeat(64),
      summary: summary({ eligibleAssetIds: ["asset-1"], excludedAssetIds: ["asset-2", "asset-3"] }),
    });
    assert.equal(acceptedDerived.status, "ACCEPTED");
  } finally {
    await client.query("RESET search_path").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    client.release();
    await pool?.end();
    await adminPool.end();
  }
});
