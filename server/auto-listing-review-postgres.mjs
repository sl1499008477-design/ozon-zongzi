import { hasCompleteReviewImageGroups } from "./auto-listing-review-evidence.mjs";
import { manualReviewWarningsFromCheckerEvidence } from "./auto-listing-result-checker.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SOFT_IMAGE_GROUP_WARNINGS = new Set([
  "IMAGE_GROUP_DUPLICATE_VIEW", "IMAGE_GROUP_VIEW_MISMATCH",
]);

function reviewError(code = "AUTO_LISTING_REVIEW_NOT_READY") {
  const error = new Error("自动上架审核内容暂时无法读取");
  error.code = code;
  error.status = code === "AUTO_LISTING_REVIEW_FAILED" ? 503 : 422;
  return error;
}

function ownCode(error) {
  try {
    const descriptor = error && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "code") : null;
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : "";
  } catch { return ""; }
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw reviewError("AUTO_LISTING_REVIEW_INVALID");
  return result;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function publicAssetUrl(itemId, assetId) {
  return `/auto-listing/items/${itemId}/assets/${assetId}/preview`;
}

function previewText(value) {
  const blocks = Array.isArray(object(value).blocks) ? value.blocks : [];
  return blocks
    .filter((block) => ["HEADING", "TEXT", "IMAGE_TEXT"].includes(block?.type)
      && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

function sourceFrom(row, accountId) {
  const snapshot = object(row.snapshot);
  const identity = object(snapshot.identity);
  const media = object(snapshot.media);
  const images = Array.isArray(media.images) ? media.images : [];
  return {
    accountId,
    title: typeof identity.primaryName === "string" ? identity.primaryName : "",
    sku: typeof identity.primarySku === "string" ? identity.primarySku : "",
    thumbnailUrl: typeof images[0] === "string" ? images[0] : "",
  };
}

function visualGroupsFrom(row) {
  const groups = Array.isArray(object(row.visual_groups).groups) ? row.visual_groups.groups : [];
  return groups.map((group) => ({
    key: group?.visualGroupKey,
    sourceAssetIds: (Array.isArray(group?.referenceImages) ? group.referenceImages : []).map((image) => image?.assetId),
  }));
}

function itemFrom(row, accountId, price) {
  return {
    accountId,
    id: row.id,
    status: row.status,
    statusVersion: row.status_version,
    failureCode: row.failure_code,
    sourceRecordId: row.source_record_id,
    targetStoreId: row.target_store_id,
    targetWarehouseId: row.target_warehouse_id,
    stock: object(row.config_snapshot).stock,
    variantCount: Number(row.variant_count),
    currentSourceImageAnalysisRunId: row.current_source_image_analysis_run_id || null,
    price,
  };
}

function sourceAnalysisEvidence(rows, row, accountId) {
  if (!Array.isArray(rows) || rows.length < 1) return null;
  const run = rows[0];
  if (run.analysis_run_id !== row.current_source_image_analysis_run_id
    || !["ACCEPTED", "CONFIRMATION_REQUIRED", "FAILED"].includes(run.run_status)
    || typeof run.summary_hash !== "string" || !run.summary) throw reviewError();
  const derivatives = Array.isArray(run.derivatives) ? run.derivatives.map((entry) => {
    const sourceAssetId = id(entry?.sourceAssetId);
    const derivativeAttemptId = id(entry?.derivativeAttemptId);
    const attemptNo = Number(entry?.attemptNo);
    const status = typeof entry?.status === "string" ? entry.status : "";
    const reasonCodes = Array.isArray(entry?.reasonCodes) ? entry.reasonCodes : [];
    if (!Number.isSafeInteger(attemptNo) || attemptNo < 1 || attemptNo > 3
      || !["RESERVED", "GENERATED", "ACCEPTED", "REJECTED", "FAILED"].includes(status)
      || typeof entry?.hasGeneratedCandidate !== "boolean" || reasonCodes.length > 40
      || reasonCodes.some((code) => typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,119}$/u.test(code))) {
      throw reviewError();
    }
    return { sourceAssetId, derivativeAttemptId, attemptNo, status,
      hasGeneratedCandidate: entry.hasGeneratedCandidate, reasonCodes: [...new Set(reasonCodes)] };
  }) : [];
  return {
    accountId,
    analysisRunId: run.analysis_run_id,
    status: run.run_status,
    summaryHash: run.summary_hash,
    expectedAssetCount: Number(run.expected_asset_count),
    terminalAssetCount: Number(run.terminal_asset_count),
    summary: run.summary,
    assessments: rows.filter((entry) => entry.source_asset_id).map((entry) => ({
      accountId,
      sourceAssetId: entry.source_asset_id,
      sourceOrdinal: entry.source_ordinal,
      terminalStatus: entry.terminal_status,
      assessment: entry.assessment,
      errorCode: entry.error_code || null,
    })),
    derivatives,
    plan: row.plan_document || null,
  };
}

function assetEvidence(row, accountId, itemId, groupWarnings = []) {
  const checkerWarnings = row.prompt_template_version === "AUTO_LISTING_CONTENT_PLAN_FILL_V6"
    && Number(row.attempt_no) === 3
    ? manualReviewWarningsFromCheckerEvidence(row.checker_result)
    : [];
  const manualReviewWarnings = [...new Set([...checkerWarnings, ...groupWarnings])];
  return {
    accountId,
    id: row.id,
    visualGroupKey: row.visual_group_key,
    role: row.role,
    requestedRole: row.requested_role || row.role,
    substitutionReasonCode: row.substitution_reason_code || null,
    manualReviewWarnings,
    slotKey: row.slot_key,
    accepted: true,
    publicUrl: publicAssetUrl(itemId, row.id),
  };
}

function exhaustedGroupWarningsBySlot(events, activePlanId) {
  const warnings = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.event_type !== "AI_IMAGE_GROUP_RETRY_EXHAUSTED") continue;
    const details = object(event.details);
    if (details.planId !== activePlanId || !Array.isArray(details.retrySlotKeys)
      || !Array.isArray(details.reasonCodes)) continue;
    const reasonCodes = [...new Set(details.reasonCodes)]
      .filter((code) => SOFT_IMAGE_GROUP_WARNINGS.has(code));
    if (reasonCodes.length === 0) continue;
    for (const slotKey of [...new Set(details.retrySlotKeys)]) {
      if (typeof slotKey !== "string" || !SAFE_ID.test(slotKey)) continue;
      warnings.set(slotKey, [...new Set([...(warnings.get(slotKey) || []), ...reasonCodes])]);
    }
  }
  return warnings;
}

function eventEvidence(row, accountId) {
  return {
    accountId,
    eventCode: row.event_type,
    outcome: row.to_status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

const REVIEW_ITEM_SQL = `
  SELECT item.id,item.account_id,item.job_id,item.status,item.status_version,item.failure_code,
    item.target_store_id,item.target_warehouse_id,item.active_content_plan_id,
    item.current_source_image_analysis_run_id,
    source.source_record_id,source.snapshot,job.config_snapshot,
    jsonb_array_length(base.ozon_ready_variants) AS variant_count,
    store.id AS store_id,store.owner_account_id AS store_account_id,
    store.label AS store_label, store.company_name AS store_company_name,
    warehouse.id AS warehouse_id,warehouse.name AS warehouse_name,
    plan.id AS plan_id,plan.visual_groups,plan.plan AS plan_document
  FROM auto_listing_job_items AS item
  JOIN auto_listing_jobs AS job
    ON job.id=item.job_id AND job.account_id=item.account_id
  JOIN auto_listing_source_snapshots AS source
    ON source.id=item.snapshot_id AND source.account_id=item.account_id
  JOIN auto_listing_listing_bases AS base
    ON base.account_id=item.account_id AND base.job_id=item.job_id AND base.item_id=item.id
      AND base.source_snapshot_id=item.snapshot_id
  JOIN stores AS store
    ON store.id=item.target_store_id AND store.owner_account_id=item.account_id
  JOIN warehouses AS warehouse
    ON warehouse.id=item.target_warehouse_id AND warehouse.store_id=store.id
  LEFT JOIN ai_content_plans AS plan
    ON plan.id=item.active_content_plan_id AND plan.account_id=item.account_id
      AND plan.job_id=item.job_id AND plan.item_id=item.id
  WHERE item.account_id=$1 AND item.id=$2
  LIMIT 1
`;

const REVIEW_SOURCE_ANALYSIS_SQL = `
  SELECT run.id AS analysis_run_id,run.status AS run_status,run.summary_hash,run.summary,
    run.expected_asset_count,run.terminal_asset_count,
    assessment.source_asset_id,assessment.source_ordinal,assessment.terminal_status,
    assessment.assessment,assessment.error_code,
    COALESCE((
      SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'sourceAssetId',derivative.source_asset_id,
        'derivativeAttemptId',derivative.derivative_attempt_id,
        'attemptNo',derivative.attempt_no,
        'status',derivative.status,
        'hasGeneratedCandidate',(
          derivative.status IN ('ACCEPTED','REJECTED')
          AND derivative.generated_object_key IS NOT NULL
        ),
        'reasonCodes',CASE
          WHEN JSONB_TYPEOF(derivative.check_result->'reasonCodes')='array'
            THEN derivative.check_result->'reasonCodes'
          WHEN derivative.failure_code IS NOT NULL THEN JSONB_BUILD_ARRAY(derivative.failure_code)
          ELSE '[]'::JSONB END
      ) ORDER BY derivative.source_asset_id,derivative.attempt_no)
      FROM auto_listing_source_image_derivatives AS derivative
      WHERE derivative.account_id=run.account_id AND derivative.job_id=run.job_id
        AND derivative.item_id=run.item_id AND derivative.analysis_run_id=run.id
    ),'[]'::JSONB) AS derivatives
  FROM auto_listing_source_image_analysis_runs AS run
  INNER JOIN auto_listing_job_items AS item
    ON item.account_id=$1 AND item.id=$2 AND item.job_id=run.job_id
      AND item.id=run.item_id AND item.current_source_image_analysis_run_id=run.id
  LEFT JOIN auto_listing_source_image_assessments AS assessment
    ON assessment.account_id=run.account_id AND assessment.job_id=run.job_id
      AND assessment.item_id=run.item_id AND assessment.analysis_run_id=run.id
      AND assessment.record_status='ACCEPTED'
  WHERE run.account_id=$1 AND run.id=item.current_source_image_analysis_run_id
    AND run.summary_hash IS NOT NULL
  ORDER BY assessment.source_ordinal NULLS LAST,assessment.source_asset_id
`;

const REVIEW_ASSETS_SQL = `
  SELECT DISTINCT ON (asset.slot_key)
    asset.id, asset.account_id, asset.visual_group_key, asset.role, asset.slot_key,
    asset.attempt_no, asset.checker_result, plan.prompt_template_version,
    planned_slot->>'requestedRole' AS requested_role,
    planned_slot->>'substitutionReasonCode' AS substitution_reason_code
  FROM ai_generation_assets AS asset
  INNER JOIN auto_listing_job_items AS item
    ON item.id=$2 AND item.account_id=$1 AND asset.plan_id=item.active_content_plan_id
      AND asset.job_id=item.job_id AND asset.item_id=item.id
  INNER JOIN ai_content_plans AS plan
    ON plan.account_id=asset.account_id AND plan.job_id=asset.job_id
      AND plan.item_id=asset.item_id AND plan.id=asset.plan_id
  CROSS JOIN LATERAL jsonb_array_elements(plan.plan->'slots') AS planned_slot
  WHERE asset.account_id = $1 AND asset.status='ACCEPTED'
    AND planned_slot->>'slotKey'=asset.slot_key
    AND (plan.prompt_template_version NOT IN ('AUTO_LISTING_CONTENT_PLAN_FILL_V3','AUTO_LISTING_CONTENT_PLAN_FILL_V4','AUTO_LISTING_CONTENT_PLAN_FILL_V5','AUTO_LISTING_CONTENT_PLAN_FILL_V6')
      OR jsonb_array_length(planned_slot->'claims')>0
      OR (plan.prompt_template_version='AUTO_LISTING_CONTENT_PLAN_FILL_V6'
        AND planned_slot->>'role'='MAIN')
      OR asset.checker_result->>'textForbidden'='true')
  ORDER BY asset.slot_key ASC,asset.expected_status_version DESC NULLS LAST,
    asset.created_at DESC,asset.id DESC
`;

const REVIEW_RICH_CONTENT_SQL = `
  WITH accepted AS (
    SELECT rich.*,MIN(asset->>'visualGroupKey') AS group_key,
      COUNT(DISTINCT asset->>'visualGroupKey')::INTEGER AS group_count
    FROM ai_rich_content_results AS rich
    INNER JOIN auto_listing_job_items AS item
      ON item.id=$2 AND item.account_id=$1 AND rich.plan_id=item.active_content_plan_id
        AND rich.job_id=item.job_id AND rich.item_id=item.id
    CROSS JOIN LATERAL jsonb_array_elements(rich.asset_evidence) AS asset
    WHERE rich.account_id=$1 AND rich.status='ACCEPTED'
    GROUP BY rich.id
  )
  SELECT DISTINCT ON (group_key) account_id,group_key,rich_content
  FROM accepted
  WHERE group_count=1
  ORDER BY group_key,accepted_at DESC NULLS LAST,created_at DESC,id DESC
`;

const REVIEW_EVENTS_SQL = `
  SELECT event.account_id,event.event_type,event.to_status,event.details,event.created_at
  FROM auto_listing_events AS event
  WHERE event.account_id = $1 AND event.item_id = $2
  ORDER BY event.created_at ASC
  LIMIT 500
`;

const ACCEPTED_ASSET_SQL = `
  SELECT asset.account_id, item.id AS item_id, asset.id, asset.object_key,
    asset.content_type, asset.content_hash, asset.size_bytes
  FROM ai_generation_assets AS asset
  INNER JOIN auto_listing_job_items AS item
    ON item.id=$2 AND item.account_id=$1 AND asset.plan_id=item.active_content_plan_id
      AND asset.job_id=item.job_id AND asset.item_id=item.id
  INNER JOIN ai_content_plans AS plan
    ON plan.account_id=asset.account_id AND plan.job_id=asset.job_id
      AND plan.item_id=asset.item_id AND plan.id=asset.plan_id
  CROSS JOIN LATERAL jsonb_array_elements(plan.plan->'slots') AS planned_slot
  WHERE asset.account_id = $1 AND asset.id = $3 AND asset.status='ACCEPTED'
    AND planned_slot->>'slotKey'=asset.slot_key
    AND (plan.prompt_template_version NOT IN ('AUTO_LISTING_CONTENT_PLAN_FILL_V3','AUTO_LISTING_CONTENT_PLAN_FILL_V4','AUTO_LISTING_CONTENT_PLAN_FILL_V5','AUTO_LISTING_CONTENT_PLAN_FILL_V6')
      OR jsonb_array_length(planned_slot->'claims')>0
      OR (plan.prompt_template_version='AUTO_LISTING_CONTENT_PLAN_FILL_V6'
        AND planned_slot->>'role'='MAIN')
      OR asset.checker_result->>'textForbidden'='true')
  LIMIT 1
`;

const CURRENT_SOURCE_ASSET_SQL = `
  SELECT assessment.account_id,item.id AS item_id,assessment.source_asset_id,
    assessment.object_key,assessment.content_type,assessment.content_hash,assessment.size_bytes
  FROM auto_listing_job_items AS item
  INNER JOIN auto_listing_source_image_analysis_runs AS run
    ON run.account_id=item.account_id AND run.job_id=item.job_id AND run.item_id=item.id
      AND run.id=item.current_source_image_analysis_run_id AND run.summary_hash IS NOT NULL
  INNER JOIN auto_listing_source_image_assessments AS assessment
    ON assessment.account_id=run.account_id AND assessment.job_id=run.job_id
      AND assessment.item_id=run.item_id AND assessment.analysis_run_id=run.id
      AND assessment.record_status='ACCEPTED'
  WHERE item.account_id=$1 AND item.id=$2 AND assessment.source_asset_id=$3
  LIMIT 1
`;

const CURRENT_SOURCE_DERIVATIVE_SQL = `
  SELECT derivative.account_id,item.id AS item_id,derivative.source_asset_id,
    derivative.derivative_attempt_id,derivative.generated_object_key,
    derivative.generated_content_type,derivative.generated_content_hash,
    derivative.generated_size_bytes
  FROM auto_listing_job_items AS item
  INNER JOIN auto_listing_source_image_analysis_runs AS run
    ON run.account_id=item.account_id AND run.job_id=item.job_id AND run.item_id=item.id
      AND item.current_source_image_analysis_run_id=run.id AND run.summary_hash IS NOT NULL
  INNER JOIN auto_listing_source_image_derivatives AS derivative
    ON derivative.account_id=run.account_id AND derivative.job_id=run.job_id
      AND derivative.item_id=run.item_id AND derivative.analysis_run_id=run.id
      AND derivative.source_asset_id=$3 AND derivative.derivative_attempt_id=$4
      AND derivative.status IN ('ACCEPTED','REJECTED')
  WHERE item.account_id=$1 AND item.id=$2
  LIMIT 1
`;

export function createPostgresAutoListingReviewRepository({ pool } = {}) {
  if (typeof pool?.connect !== "function" || typeof pool?.query !== "function") {
    throw new TypeError("Auto-listing review pool is required");
  }
  return Object.freeze({
    async loadReviewEvidence({ accountId: rawAccountId, itemId: rawItemId } = {}) {
      const accountId = id(rawAccountId);
      const itemId = id(rawItemId);
      let client;
      let started = false;
      try {
        client = await pool.connect();
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        started = true;
        const itemResult = await client.query(REVIEW_ITEM_SQL, [accountId, itemId]);
        const row = itemResult.rows[0];
        if (!row) {
          await client.query("COMMIT");
          started = false;
          return null;
        }
        const sourceAnalysisResult = row.current_source_image_analysis_run_id
          ? await client.query(REVIEW_SOURCE_ANALYSIS_SQL, [accountId, itemId]) : { rows: [] };
        const sourceImageAnalysis = sourceAnalysisEvidence(sourceAnalysisResult.rows, row, accountId);
        const confirmationReview = row.status === "BLOCKED"
          && row.failure_code === "AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED"
          && sourceImageAnalysis?.status === "CONFIRMATION_REQUIRED";
        if (!confirmationReview && (!row.active_content_plan_id || !row.plan_id)) throw reviewError();
        const assetsResult = confirmationReview ? { rows: [] }
          : await client.query(REVIEW_ASSETS_SQL, [accountId, itemId]);
        const richResult = confirmationReview ? { rows: [] }
          : await client.query(REVIEW_RICH_CONTENT_SQL, [accountId, itemId]);
        const eventsResult = await client.query(REVIEW_EVENTS_SQL, [accountId, itemId]);
        const groupWarningsBySlot = exhaustedGroupWarningsBySlot(
          eventsResult.rows, row.active_content_plan_id,
        );
        const assets = assetsResult.rows.map((asset) => assetEvidence(
          asset, accountId, itemId, groupWarningsBySlot.get(asset.slot_key) || [],
        ));
        const visualGroups = visualGroupsFrom(row);
        const richByGroup = new Map((richResult.rows || [])
          .map((rich) => [rich.group_key, rich]));
        const price = eventsResult.rows
          .map((event) => object(event.details).price)
          .find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
        const normalReviewInvalid = !confirmationReview
          && (!hasCompleteReviewImageGroups({ visualGroups, images: assets })
          || richByGroup.size !== visualGroups.length
          || visualGroups.some((group) => !richByGroup.has(group.key)));
        if (normalReviewInvalid || !price) throw reviewError();
        const richPreview = confirmationReview ? null : visualGroups.map((group, index) => {
          const text = previewText(richByGroup.get(group.key).rich_content);
          return visualGroups.length > 1 ? `商品组 ${index + 1}\n${text}` : text;
        }).join("\n\n");
        const evidence = Object.freeze({
          accountId,
          item: itemFrom(row, accountId, price),
          source: sourceFrom(row, accountId),
          store: { accountId, id: row.store_id, label: row.store_label?.trim() || row.store_company_name?.trim() || "" },
          warehouse: { accountId, id: row.warehouse_id, name: row.warehouse_name ?? "" },
          visualGroups,
          images: assets,
          richContent: confirmationReview ? null : { accountId, accepted: true, previewText: richPreview },
          events: eventsResult.rows.map((event) => eventEvidence(event, accountId)),
          ...(sourceImageAnalysis ? { sourceImageAnalysis } : {}),
        });
        await client.query("COMMIT");
        started = false;
        return evidence;
      } catch (error) {
        if (started) {
          try { await client.query("ROLLBACK"); } catch {}
        }
        if (String(ownCode(error)).startsWith("AUTO_LISTING_REVIEW_")) throw error;
        throw reviewError("AUTO_LISTING_REVIEW_FAILED");
      } finally {
        client?.release?.();
      }
    },

    async loadAcceptedAsset({ accountId: rawAccountId, itemId: rawItemId, assetId: rawAssetId } = {}) {
      const accountId = id(rawAccountId);
      const itemId = id(rawItemId);
      const assetId = id(rawAssetId);
      let result;
      try {
        result = await pool.query(ACCEPTED_ASSET_SQL, [accountId, itemId, assetId]);
      } catch {
        throw reviewError("AUTO_LISTING_REVIEW_FAILED");
      }
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({
        accountId: row.account_id,
        itemId: row.item_id,
        assetId: row.id,
        objectKey: row.object_key,
        contentType: row.content_type,
        contentHash: row.content_hash,
        sizeBytes: Number(row.size_bytes),
      });
    },

    async loadCurrentSourceAsset({ accountId: rawAccountId, itemId: rawItemId, sourceAssetId: rawSourceAssetId } = {}) {
      const accountId = id(rawAccountId);
      const itemId = id(rawItemId);
      const sourceAssetId = id(rawSourceAssetId);
      let result;
      try { result = await pool.query(CURRENT_SOURCE_ASSET_SQL, [accountId, itemId, sourceAssetId]); }
      catch { throw reviewError("AUTO_LISTING_REVIEW_FAILED"); }
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({
        accountId: row.account_id, itemId: row.item_id, sourceAssetId: row.source_asset_id,
        objectKey: row.object_key, contentType: row.content_type,
        contentHash: row.content_hash, sizeBytes: Number(row.size_bytes),
      });
    },

    async loadCurrentSourceDerivative({
      accountId: rawAccountId, itemId: rawItemId, sourceAssetId: rawSourceAssetId,
      derivativeAttemptId: rawDerivativeAttemptId,
    } = {}) {
      const accountId = id(rawAccountId);
      const itemId = id(rawItemId);
      const sourceAssetId = id(rawSourceAssetId);
      const derivativeAttemptId = id(rawDerivativeAttemptId);
      let result;
      try {
        result = await pool.query(CURRENT_SOURCE_DERIVATIVE_SQL,
          [accountId, itemId, sourceAssetId, derivativeAttemptId]);
      } catch { throw reviewError("AUTO_LISTING_REVIEW_FAILED"); }
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({
        accountId: row.account_id, itemId: row.item_id, sourceAssetId: row.source_asset_id,
        derivativeAttemptId: row.derivative_attempt_id, objectKey: row.generated_object_key,
        contentType: row.generated_content_type, contentHash: row.generated_content_hash,
        sizeBytes: Number(row.generated_size_bytes),
      });
    },
  });
}
