import crypto from "node:crypto";

import {
  isSafeSourceScopeIdentifier,
} from "./auto-listing-source-asset-store.mjs";
import {
  verifySourceMaterializationObjectKey,
} from "./auto-listing-source-materialization-repository.mjs";
import { loadStoredSourceImageDerivative } from "./auto-listing-source-image-derivative-store.mjs";
import { verifySourceImageIntelligenceSummary } from "./auto-listing-source-image-intelligence-contract.mjs";

const REQUEST_KEYS = new Set([
  "accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey",
  "expectedStatusVersion", "assetId", "sourceRef", "evidenceKind",
]);
const FACTORY_KEYS = new Set(["pool", "repository", "derivativeRepository", "storage"]);
const REQUIRED_FACTORY_KEYS = new Set(["pool", "repository", "storage"]);
const HASH = /^[a-f0-9]{64}$/u;
const CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

function loaderError(code, retryable = false) {
  const error = new Error("自动上架来源图片暂时无法读取");
  error.code = code;
  error.retryable = retryable;
  return error;
}

function plainObject(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  } catch {
    return false;
  }
}

function exactObject(value, keys) {
  try {
    const actual = Reflect.ownKeys(value);
    return plainObject(value) && actual.length === keys.size
      && actual.every((key) => typeof key === "string" && keys.has(key));
  } catch {
    return false;
  }
}

function validRequest(input) {
  return exactObject(input, REQUEST_KEYS)
    && ["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "assetId"]
      .every((key) => isSafeSourceScopeIdentifier(input[key]))
    && Number.isInteger(input.expectedStatusVersion) && input.expectedStatusVersion >= 1
    && input.expectedStatusVersion <= 2_147_483_647
    && input.sourceRef === null && input.evidenceKind === "CONTENT_HASH";
}

function validAccepted(record, request, { parentPlanId, sourceMaterializationScope }) {
  const ownerMatches = sourceMaterializationScope === null
    ? record.parentPlanId === parentPlanId
    : record.owner?.kind === "SOURCE_IMAGE_ANALYSIS"
      && record.owner.id === sourceMaterializationScope.analysisRunId
      && record.expectedStatusVersion === sourceMaterializationScope.expectedStatusVersion;
  const objectKeyVersion = sourceMaterializationScope === null ? "SOURCE_V1" : "SOURCE_V2";
  return plainObject(record) && record.status === "ACCEPTED"
    && record.accountId === request.accountId && record.jobId === request.jobId
    && record.itemId === request.itemId && ownerMatches
    && record.sourceAssetId === request.assetId
    && record.objectKeyVersion === objectKeyVersion
    && verifySourceMaterializationObjectKey(record)
    && HASH.test(record.contentHash || "") && CONTENT_TYPES.has(record.contentType)
    && Number.isInteger(record.width) && record.width >= 1
    && Number.isInteger(record.height) && record.height >= 1
    && Number.isInteger(record.sizeBytes) && record.sizeBytes >= 1
    && record.sizeBytes <= MAX_SOURCE_BYTES;
}

async function loadSourceMaterializationScope(pool, request, currentAnalysisRunId) {
  const result = await pool.query(
    `WITH RECURSIVE current_run AS (
       SELECT * FROM auto_listing_source_image_analysis_runs
        WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND id=$4
     ), lineage AS (
       SELECT id,parent_run_id,expected_status_version,input_hash,0 AS depth,ARRAY[id]::TEXT[] AS path
         FROM current_run
       UNION ALL
       SELECT parent.id,parent.parent_run_id,parent.expected_status_version,parent.input_hash,
              child.depth+1,child.path || parent.id
         FROM auto_listing_source_image_analysis_runs AS parent
         JOIN lineage AS child ON parent.id=child.parent_run_id
        WHERE parent.account_id=$1 AND parent.job_id=$2 AND parent.item_id=$3
          AND NOT parent.id=ANY(child.path) AND CARDINALITY(child.path)<100
     ), lineage_guard AS (
       SELECT COUNT(*) FILTER (WHERE parent_run_id IS NULL)::INTEGER AS root_count FROM lineage
     )
     SELECT candidate.id,candidate.expected_status_version
       FROM current_run
       JOIN auto_listing_source_image_analysis_runs AS candidate
         ON candidate.account_id=current_run.account_id
        AND candidate.job_id=current_run.job_id
        AND candidate.item_id=current_run.item_id
        AND candidate.source_snapshot_id=current_run.source_snapshot_id
        AND candidate.source_snapshot_hash=current_run.source_snapshot_hash
        AND candidate.source_asset_set_hash=current_run.source_asset_set_hash
        AND candidate.intelligence_contract_version=current_run.intelligence_contract_version
        AND candidate.prompt_template_version=current_run.prompt_template_version
        AND candidate.profile_id=current_run.profile_id
        AND candidate.profile_version=current_run.profile_version
        AND candidate.model_name=current_run.model_name
        AND candidate.expected_status_version<=current_run.expected_status_version
       LEFT JOIN lineage ON lineage.id=candidate.id
      CROSS JOIN lineage_guard AS guard
      WHERE guard.root_count=1
        AND (lineage.id IS NOT NULL OR EXISTS (
          SELECT 1 FROM lineage AS input_owner
           WHERE input_owner.input_hash=candidate.input_hash
        ))
        AND EXISTS (
          SELECT 1
            FROM auto_listing_source_image_assessments AS assessment
            JOIN auto_listing_source_materialization_attempts AS attempt
              ON attempt.account_id=assessment.account_id
             AND attempt.job_id=assessment.job_id
             AND attempt.item_id=assessment.item_id
             AND attempt.source_asset_id=assessment.source_asset_id
             AND attempt.source_ref_hash=assessment.source_ref_hash
             AND attempt.object_key=assessment.object_key
             AND attempt.content_hash=assessment.content_hash
             AND attempt.content_type=assessment.content_type
             AND attempt.size_bytes=assessment.size_bytes
             AND attempt.source_analysis_run_id=candidate.id
             AND attempt.expected_status_version=candidate.expected_status_version
             AND attempt.status='ACCEPTED'
           WHERE assessment.account_id=$1 AND assessment.job_id=$2 AND assessment.item_id=$3
             AND assessment.analysis_run_id=$4 AND assessment.source_asset_id=$5
             AND assessment.expected_status_version=current_run.expected_status_version
             AND assessment.record_status='ACCEPTED'
             AND assessment.terminal_status IN ('ANALYZED','DUPLICATE_REUSED','CONFIRMATION_REQUIRED')
        )
      ORDER BY (lineage.id IS NULL),lineage.depth NULLS LAST,
               candidate.expected_status_version DESC,candidate.id
      LIMIT 1`,
    [request.accountId, request.jobId, request.itemId, currentAnalysisRunId, request.assetId],
  );
  const row = result?.rows?.[0];
  if (result?.rowCount !== 1 || !isSafeSourceScopeIdentifier(row?.id)
    || !Number.isInteger(row?.expected_status_version) || row.expected_status_version < 1
    || row.expected_status_version > request.expectedStatusVersion) {
    throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
  }
  return Object.freeze({
    analysisRunId: row.id,
    expectedStatusVersion: row.expected_status_version,
  });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function jsonValue(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true); }
}

function effectiveBinding(row, request, derivativeRepository) {
  if (!derivativeRepository || row.source_image_analysis_run_id == null) return null;
  if (row.source_image_status !== "ACCEPTED"
    || !Number.isInteger(row.source_image_expected_status_version)
    || row.source_image_expected_status_version < 1
    || !HASH.test(row.source_image_intelligence_hash || "")
    || row.source_image_intelligence_hash !== row.source_image_summary_hash) {
    throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
  }
  let summary;
  try { summary = verifySourceImageIntelligenceSummary(jsonValue(row.source_image_summary)); }
  catch { throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true); }
  if (summary.summaryHash !== row.source_image_summary_hash) {
    throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
  }
  if (summary.contractVersion === "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1") return null;
  const bindings = summary.appearanceAssetBindings.filter(({ sourceAssetId }) => sourceAssetId === request.assetId);
  if (bindings.length !== 1) throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
  return Object.freeze({ binding: bindings[0], summary });
}

function validDerivativeAttempt(attempt, request, row, binding, originalRecord) {
  return plainObject(attempt) && attempt.status === "ACCEPTED"
    && attempt.accountId === request.accountId && attempt.jobId === request.jobId
    && attempt.itemId === request.itemId && attempt.analysisRunId === row.analysisRunId
    && attempt.sourceAssetId === request.assetId
    && attempt.expectedStatusVersion === row.expectedStatusVersion
    && attempt.derivativeAttemptId === binding.derivativeAttemptId
    && attempt.originalContentHash === originalRecord.contentHash
    && attempt.generatedContentHash === binding.effectiveContentHash
    && attempt.cleanupEvidenceHash === binding.cleanupEvidenceHash;
}

async function loadSourceDerivativeScope(pool, request, currentAnalysisRunId, binding, originalRecord) {
  const result = await pool.query(
    `WITH RECURSIVE lineage AS (
       SELECT id,parent_run_id,expected_status_version,0 AS depth,ARRAY[id]::TEXT[] AS path
         FROM auto_listing_source_image_analysis_runs
        WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND id=$4
       UNION ALL
       SELECT parent.id,parent.parent_run_id,parent.expected_status_version,
              child.depth+1,child.path || parent.id
         FROM auto_listing_source_image_analysis_runs AS parent
         JOIN lineage AS child ON parent.id=child.parent_run_id
        WHERE parent.account_id=$1 AND parent.job_id=$2 AND parent.item_id=$3
          AND NOT parent.id=ANY(child.path) AND CARDINALITY(child.path)<100
     )
     SELECT derivative.analysis_run_id AS id,
            derivative.expected_status_version
       FROM lineage
       JOIN auto_listing_source_image_derivatives AS derivative
         ON derivative.account_id=$1 AND derivative.job_id=$2 AND derivative.item_id=$3
        AND derivative.analysis_run_id=lineage.id
      WHERE derivative.source_asset_id=$5 AND derivative.derivative_attempt_id=$6
        AND derivative.status='ACCEPTED'
        AND derivative.original_content_hash=$7
        AND derivative.generated_content_hash=$8
        AND derivative.cleanup_evidence_hash=$9
      ORDER BY lineage.depth
      LIMIT 2`,
    [request.accountId, request.jobId, request.itemId, currentAnalysisRunId,
      request.assetId, binding.derivativeAttemptId, originalRecord.contentHash,
      binding.effectiveContentHash, binding.cleanupEvidenceHash],
  );
  const row = result?.rows?.[0];
  if (result?.rowCount !== 1 || !isSafeSourceScopeIdentifier(row?.id)
    || !Number.isInteger(row?.expected_status_version) || row.expected_status_version < 1
    || row.expected_status_version > request.expectedStatusVersion) {
    throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
  }
  return Object.freeze({
    analysisRunId: row.id,
    expectedStatusVersion: row.expected_status_version,
  });
}

export function createActiveMaterializedSourceAssetLoader(options = {}) {
  if (!plainObject(options) || Reflect.ownKeys(options).some((key) => typeof key !== "string" || !FACTORY_KEYS.has(key))
    || [...REQUIRED_FACTORY_KEYS].some((key) => !Object.hasOwn(options, key))
    || typeof options.pool?.query !== "function"
    || typeof options.repository?.listAcceptedSourceMaterializationsForPlan !== "function"
    || (options.derivativeRepository !== undefined
      && typeof options.derivativeRepository?.loadAttempt !== "function")
    || typeof options.storage?.getObjectBuffer !== "function") {
    throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_INVALID");
  }
  const { pool, repository, derivativeRepository = null, storage } = options;

  async function loadSourceAsset(input) {
    if (!validRequest(input)) throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_INVALID");
    try {
      const result = await pool.query(
        `SELECT plan.parent_plan_id,plan.source_image_analysis_run_id,
                plan.source_image_intelligence_hash,
                run.expected_status_version AS source_image_expected_status_version,
                run.status AS source_image_status,
                run.summary_hash AS source_image_summary_hash,
                run.summary AS source_image_summary
           FROM auto_listing_job_items AS item
           JOIN ai_content_plans AS plan
             ON plan.account_id=item.account_id AND plan.job_id=item.job_id
            AND plan.item_id=item.id AND plan.id=$4
           LEFT JOIN auto_listing_source_image_analysis_runs AS run
             ON run.account_id=plan.account_id AND run.job_id=plan.job_id
            AND run.item_id=plan.item_id AND run.id=plan.source_image_analysis_run_id
          WHERE item.account_id=$1 AND item.job_id=$2 AND item.id=$3
            AND item.active_content_plan_id=plan.id AND item.status='GENERATING'
            AND item.status_version=$5
            AND plan.derivation_kind='SOURCE_MATERIALIZATION'`,
        [input.accountId, input.jobId, input.itemId, input.planId, input.expectedStatusVersion],
      );
      if (!result || !Array.isArray(result.rows) || result.rows.length !== 1
        || !isSafeSourceScopeIdentifier(result.rows[0]?.parent_plan_id)) {
        throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
      }
      const parentPlanId = result.rows[0].parent_plan_id;
      const sourceImageAnalysisRunId = result.rows[0].source_image_analysis_run_id ?? null;
      if (sourceImageAnalysisRunId !== null && !isSafeSourceScopeIdentifier(sourceImageAnalysisRunId)) {
        throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
      }
      const sourceMaterializationScope = sourceImageAnalysisRunId === null
        ? null : await loadSourceMaterializationScope(pool, input, sourceImageAnalysisRunId);
      const records = await repository.listAcceptedSourceMaterializationsForPlan({
        accountId: input.accountId,
        jobId: input.jobId,
        itemId: input.itemId,
        parentPlanId,
        ...(sourceMaterializationScope === null ? {} : {
          sourceImageAnalysisRunId,
          ...(sourceMaterializationScope.analysisRunId === sourceImageAnalysisRunId ? {} : {
            sourceMaterializationAnalysisRunId: sourceMaterializationScope.analysisRunId,
          }),
        }),
      });
      if (!Array.isArray(records)) throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
      const matches = records.filter((record) => record?.sourceAssetId === input.assetId);
      if (matches.length !== 1 || !validAccepted(matches[0], input, {
        parentPlanId,
        sourceMaterializationScope,
      })) {
        throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
      }
      const record = matches[0];
      const effective = effectiveBinding(result.rows[0], input, derivativeRepository);
      if (effective?.binding.mode === "ORIGINAL"
        && effective.binding.effectiveContentHash !== record.contentHash) {
        throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
      }
      if (effective?.binding.mode === "CLEANED") {
        const derivativeScope = await loadSourceDerivativeScope(
          pool, input, sourceImageAnalysisRunId, effective.binding, record,
        );
        let attempt;
        try {
          attempt = await derivativeRepository.loadAttempt({
            accountId: input.accountId,
            jobId: input.jobId,
            itemId: input.itemId,
            analysisRunId: derivativeScope.analysisRunId,
            sourceAssetId: input.assetId,
            expectedStatusVersion: derivativeScope.expectedStatusVersion,
            derivativeAttemptId: effective.binding.derivativeAttemptId,
          });
        } catch { throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true); }
        if (!validDerivativeAttempt(attempt, input, derivativeScope, effective.binding, record)) {
          throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
        }
        let stored;
        try { stored = await loadStoredSourceImageDerivative({ attempt, storage }); }
        catch { throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true); }
        if (stored.contentHash !== effective.binding.effectiveContentHash) {
          throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
        }
        return Object.freeze({
          assetId: record.sourceAssetId,
          sourceRef: null,
          evidenceKind: "CONTENT_HASH",
          bytes: Buffer.from(stored.bytes),
          contentType: stored.contentType,
          width: stored.width,
          height: stored.height,
          evidenceMode: "CLEANED",
          derivativeAttemptId: effective.binding.derivativeAttemptId,
        });
      }
      const stored = await storage.getObjectBuffer(record.objectKey, { maxBytes: MAX_SOURCE_BYTES });
      const bytes = Buffer.isBuffer(stored) ? Buffer.from(stored) : null;
      if (!bytes || bytes.length !== record.sizeBytes || sha256(bytes) !== record.contentHash) {
        throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
      }
      return Object.freeze({
        assetId: record.sourceAssetId,
        sourceRef: null,
        evidenceKind: "CONTENT_HASH",
        bytes,
        contentType: record.contentType,
        width: record.width,
        height: record.height,
        ...(effective ? { evidenceMode: "ORIGINAL", derivativeAttemptId: null } : {}),
      });
    } catch (error) {
      if (error?.code === "AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE") throw error;
      throw loaderError("AUTO_LISTING_SOURCE_ASSET_LOADER_UNAVAILABLE", true);
    }
  }

  return Object.freeze({ loadSourceAsset });
}
