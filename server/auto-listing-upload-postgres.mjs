import crypto from "node:crypto";

import { enqueueAutoListingUploadTask } from "./auto-listing-upload-task-postgres.mjs";
import { normalizeAndHashAutoListingConfig } from "./auto-listing-contract.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const WAREHOUSE_EVIDENCE_KEYS = Object.freeze(["schemaVersion", "accountId", "storeId",
  "warehouseRecordId", "platformWarehouseId", "fulfillmentType", "status", "outcome",
  "observedAt", "expiresAt", "evidenceHash", "correlationId", "actorAccountId"]);

function repositoryError(code = "AUTO_LISTING_UPLOAD_REPOSITORY_INVALID", status = 422, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

const isRepositoryError = (error) => /^(?:AUTO_LISTING_|RFBS_)/u.test(String(error?.code || ""));

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw repositoryError();
  return result;
}

function optionalId(value) {
  return value == null ? null : id(value);
}

function key(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > 512 || /[\u0000-\u001f\u007f]/u.test(result)) throw repositoryError();
  return result;
}

function hash(value) {
  if (typeof value !== "string" || !HASH.test(value)) throw repositoryError();
  return value;
}

function exactWarehouseValidation(value, scope) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).length !== WAREHOUSE_EVIDENCE_KEYS.length
    || !Reflect.ownKeys(value).every((name) => typeof name === "string" && WAREHOUSE_EVIDENCE_KEYS.includes(name))) {
    throw repositoryError();
  }
  const result = {};
  for (const name of WAREHOUSE_EVIDENCE_KEYS) {
    const candidate = value[name];
    if (typeof candidate !== "string" || !candidate || candidate !== candidate.trim()
      || candidate.length > 500 || /[\u0000-\u001f\u007f]/u.test(candidate)) throw repositoryError();
    result[name] = candidate;
  }
  if (result.schemaVersion !== "AUTO_LISTING_RFBS_WAREHOUSE_EVIDENCE_V1"
    || result.accountId !== scope.accountId || result.actorAccountId !== scope.accountId
    || result.storeId !== scope.targetStoreId || result.warehouseRecordId !== scope.targetWarehouseId
    || result.platformWarehouseId !== scope.targetWarehousePlatformId || result.fulfillmentType !== "RFBS"
    || result.status !== "ACTIVE" || result.outcome !== "PASSED" || result.correlationId !== scope.correlationId
    || !HASH.test(result.evidenceHash) || /^wh_/iu.test(result.platformWarehouseId)) throw repositoryError();
  const observed = new Date(result.observedAt); const expires = new Date(result.expiresAt);
  if (!Number.isFinite(observed.getTime()) || !Number.isFinite(expires.getTime())
    || observed.toISOString() !== result.observedAt || expires.toISOString() !== result.expiresAt
    || expires <= observed) throw repositoryError();
  const normalized = { schemaVersion: result.schemaVersion, accountId: result.accountId,
    storeId: result.storeId, warehouseRecordId: result.warehouseRecordId,
    platformWarehouseId: result.platformWarehouseId, fulfillmentType: result.fulfillmentType,
    status: result.status, outcome: result.outcome, observedAt: result.observedAt,
    expiresAt: result.expiresAt, correlationId: result.correlationId, actorAccountId: result.actorAccountId };
  if (result.evidenceHash !== crypto.createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex")) {
    throw repositoryError();
  }
  return Object.freeze(result);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
const publicationPolicyDigest = (value) => crypto.createHash("sha256").update(JSON.stringify({
  origin: value.origin,
  baseUrl: value.baseUrl,
  prefix: value.prefix,
  publicationVersion: value.publicationVersion,
}), "utf8").digest("hex");

function effectiveFrozenConfig(row) {
  const requested = Object.freeze({ config: row.config_snapshot, configHash: row.config_hash });
  const audit = row.effective_image_config;
  if (audit == null) return requested;
  try {
    if (!audit || typeof audit !== "object" || Array.isArray(audit)
      || Reflect.ownKeys(audit).length !== 3
      || !["roles", "total", "reasonCodes"].every((key) => Object.hasOwn(audit, key))
      || !audit.roles || typeof audit.roles !== "object" || Array.isArray(audit.roles)
      || !Array.isArray(audit.reasonCodes)) throw repositoryError();
    const requestedRoles = row.config_snapshot?.image?.roles;
    const roleKeys = ["main", "sellingPoint", "detail", "scene", "specification", "infographic"];
    if (!requestedRoles || Reflect.ownKeys(audit.roles).length !== roleKeys.length
      || roleKeys.some((key) => !Object.hasOwn(audit.roles, key)
        || !Number.isSafeInteger(audit.roles[key]) || audit.roles[key] < 0
        || (key !== "specification" && audit.roles[key] !== requestedRoles[key]))
      || ![requestedRoles.specification, 0].includes(audit.roles.specification)) throw repositoryError();
    const legacyReduced = requestedRoles.specification > 0 && audit.roles.specification === 0;
    const dimensionsUnavailable = audit.reasonCodes.length === 1
      && audit.reasonCodes[0] === "PRODUCT_DIMENSIONS_UNAVAILABLE";
    if (audit.reasonCodes.length > 1
      || (audit.reasonCodes.length === 1 && !dimensionsUnavailable)
      || (dimensionsUnavailable && requestedRoles.specification === 0)
      || (legacyReduced && !dimensionsUnavailable)
      || audit.total !== roleKeys.reduce((sum, key) => sum + audit.roles[key], 0)) throw repositoryError();
    return normalizeAndHashAutoListingConfig({
      ...row.config_snapshot,
      image: { ...row.config_snapshot.image, roles: audit.roles, total: audit.total },
    });
  } catch (error) {
    if (isRepositoryError(error)) throw error;
    throw repositoryError();
  }
}

function mapLink(row) {
  if (!row) return null;
  return {
    id: row.id, jobId: row.job_id, status: row.status, idempotencyKey: row.idempotency_key,
    resultHash: row.result_hash, targetStoreId: row.target_store_id,
    listingBaseId: row.listing_base_id, activePlanId: row.active_plan_id,
    sourceHash: row.source_hash, configHash: row.config_hash, requestHash: row.request_hash,
    uploadPolicyVersionId: row.upload_policy_version_id,
    publicationPolicyHash: row.publication_policy_hash, mediaEvidenceHash: row.media_evidence_hash,
    directHealthEvidenceId: row.direct_health_evidence_id || null,
    warehouseValidationEvidenceId: row.warehouse_validation_evidence_id || null,
    claimToken: row.claim_token || null,
    claimOwned: row.claim_owned === true, claimExpiresAt: row.claim_expires_at || null,
    attemptGeneration: Number(row.attempt_generation || 1),
    submissionSnapshotId: row.submission_snapshot_id || null,
    submissionJobId: row.submission_job_id || null,
  };
}

function listingBase(row) {
  return {
    version: row.listing_base_version,
    accountId: row.account_id,
    jobId: row.job_id,
    itemId: row.item_id,
    sourceSnapshotId: row.source_snapshot_id,
    collectItemId: row.collect_item_id,
    targetStoreId: row.target_store_id,
    productDraft: { id: row.product_draft_id, version: Number(row.product_draft_version), dataHash: row.product_draft_data_hash },
    pricingEvidence: row.pricing_evidence,
    richContentAttributeSupported: row.rich_content_attribute_supported,
    variants: row.ozon_ready_variants,
    versions: { normalizerVersion: row.normalizer_version, categoryRuleVersion: row.category_rule_version,
      dictionaryVersion: row.dictionary_version },
    canonicalHash: row.canonical_hash,
  };
}

function visualGroups(row) {
  const raw = row.visual_groups && typeof row.visual_groups === "object" ? row.visual_groups : {};
  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  const slots = Array.isArray(row.plan?.slots) ? row.plan.slots : [];
  return {
    accountId: row.account_id, jobId: row.job_id, itemId: row.item_id, planId: row.plan_id,
    groups: groups.map((group) => ({
      visualGroupKey: group.visualGroupKey,
      variantIds: group.variantIds,
      slots: slots.filter((slot) => slot.visualGroupKey === group.visualGroupKey)
        .map((slot) => ({ slotKey: slot.slotKey, role: slot.role, order: slot.order })),
    })),
  };
}

function richGroupKey(row) {
  const evidence = Array.isArray(row.asset_evidence) ? row.asset_evidence : [];
  const keys = [...new Set(evidence.map((asset) => asset?.visualGroupKey).filter(Boolean))];
  if (keys.length !== 1) throw repositoryError("AUTO_LISTING_UPLOAD_EVIDENCE_INVALID");
  return keys[0];
}

const CONTEXT_SQL = `
  SELECT item.id,item.id AS item_id,item.account_id,item.job_id,item.snapshot_id,item.status,item.status_version,
    item.target_store_id,item.target_warehouse_id,item.active_content_plan_id,
    job.config_snapshot,job.config_hash,job.upload_policy_version_id,job.warehouse_validation_evidence_id,
    (SELECT event.details->'effectiveImageConfig'
       FROM auto_listing_events AS event
      WHERE event.account_id=item.account_id AND event.job_id=item.job_id AND event.item_id=item.id
        AND event.event_type='SOURCE_CAPTURED'
      ORDER BY event.created_at,event.id LIMIT 1) AS effective_image_config,
    source.snapshot_hash,
    base.id AS listing_base_id,base.source_snapshot_id,base.collect_item_id,base.product_draft_id,
    base.product_draft_version,base.product_draft_data_hash,base.ozon_ready_variants,
    base.pricing_evidence,base.rich_content_attribute_supported,base.listing_base_version,
    base.canonical_hash,base.normalizer_version,base.category_rule_version,base.dictionary_version,
    plan.id AS plan_id,plan.visual_groups,plan.plan,
    policy.id AS policy_id,policy.account_id AS policy_account_id,policy.version AS policy_version,
    policy.mode AS policy_mode,policy.enabled AS policy_enabled,policy.published_by AS policy_published_by,
    policy.published_at AS policy_published_at,policy.publication_origin,policy.publication_base_url,
    policy.publication_prefix,policy.publication_version,policy.publication_policy_hash,
    store.id AS store_id,store.owner_account_id AS store_account_id,
    (credential.store_id IS NOT NULL AND credential.encrypted_api_key<>''
      AND credential.iv<>'' AND credential.auth_tag<>'') AS credentials_usable,
    collect.id AS current_collect_item_id,to_jsonb(collect) AS collect_row,
    draft.id AS current_draft_id,draft.version AS current_draft_version,
    draft.data_hash AS current_draft_data_hash,draft.data AS current_draft_data,
    creation_evidence.store_id AS creation_evidence_store_id,
    creation_evidence.warehouse_record_id AS creation_evidence_warehouse_record_id,
    creation_evidence.platform_warehouse_id AS creation_evidence_platform_warehouse_id,
    creation_evidence.schema_version AS creation_evidence_schema_version,
    creation_evidence.fulfillment_type AS creation_evidence_fulfillment_type,
    creation_evidence.status AS creation_evidence_status,creation_evidence.outcome AS creation_evidence_outcome,
    creation_evidence.observed_at AS creation_evidence_observed_at,
    creation_evidence.expires_at AS creation_evidence_expires_at,
    creation_evidence.evidence_hash AS creation_evidence_hash,
    creation_evidence.correlation_id AS creation_evidence_correlation_id,
    creation_evidence.actor_account_id AS creation_evidence_actor_account_id,
    terminal.id AS terminal_link_id,terminal.job_id AS terminal_job_id,
    terminal.status AS terminal_status,terminal.idempotency_key AS terminal_idempotency_key,
    terminal.result_hash AS terminal_result_hash,terminal.request_hash AS terminal_request_hash,
    terminal.target_store_id AS terminal_target_store_id,
    terminal.listing_base_id AS terminal_listing_base_id,terminal.active_plan_id AS terminal_active_plan_id,
    terminal.source_hash AS terminal_source_hash,terminal.config_hash AS terminal_config_hash,
    terminal.upload_policy_version_id AS terminal_upload_policy_version_id,
    terminal.publication_policy_hash AS terminal_publication_policy_hash,
    terminal.media_evidence_hash AS terminal_media_evidence_hash,
    terminal.submission_snapshot_id AS terminal_submission_snapshot_id,
    terminal.submission_job_id AS terminal_submission_job_id,
    terminal_recovery.id AS terminal_recovery_attempt_id,
    terminal_recovery.status AS terminal_recovery_status,
    terminal_recovery.original_ozon_task_id AS terminal_recovery_original_ozon_task_id,
    terminal_recovery.retry_ozon_task_id AS terminal_recovery_retry_ozon_task_id,
    terminal_recovery.old_shared_category_version AS terminal_recovery_old_shared_category_version,
    terminal_recovery.replacement_shared_category_version
      AS terminal_recovery_replacement_shared_category_version
  FROM auto_listing_job_items AS item
  JOIN auto_listing_jobs AS job ON job.account_id=item.account_id AND job.id=item.job_id
  JOIN auto_listing_source_snapshots AS source ON source.account_id=item.account_id AND source.id=item.snapshot_id
  JOIN auto_listing_listing_bases AS base ON base.account_id=item.account_id AND base.job_id=item.job_id
    AND base.item_id=item.id AND base.source_snapshot_id=item.snapshot_id
  JOIN ai_content_plans AS plan ON plan.account_id=item.account_id AND plan.job_id=item.job_id
    AND plan.item_id=item.id AND plan.id=item.active_content_plan_id
  LEFT JOIN auto_listing_upload_policy_versions AS policy
    ON policy.account_id=item.account_id AND policy.id=job.upload_policy_version_id
  JOIN stores AS store ON store.owner_account_id=item.account_id AND store.id=item.target_store_id
  LEFT JOIN store_credentials AS credential ON credential.store_id=store.id
  LEFT JOIN auto_listing_rfbs_warehouse_evidence AS creation_evidence
    ON creation_evidence.account_id=job.account_id AND creation_evidence.id=job.warehouse_validation_evidence_id
  LEFT JOIN auto_listing_submission_links AS terminal
    ON terminal.account_id=item.account_id AND terminal.auto_listing_item_id=item.id
   AND terminal.status IN ('SUBMITTED','RECONCILING','SUCCEEDED')
  LEFT JOIN submission_category_recovery_attempts AS terminal_recovery
    ON terminal_recovery.account_id=terminal.account_id
   AND terminal_recovery.submission_job_id=terminal.submission_job_id
   AND terminal_recovery.submission_snapshot_id=terminal.submission_snapshot_id
  JOIN collect_items AS collect ON collect.account_id=item.account_id AND collect.id=base.collect_item_id
    AND collect.deleted_at IS NULL
  JOIN product_drafts AS draft ON draft.id=collect.current_draft_id AND draft.collect_item_id=collect.id
  WHERE item.account_id=$1 AND item.id=$2
  LIMIT 1
`;

const ASSETS_SQL = `
  SELECT DISTINCT ON (asset.visual_group_key,asset.slot_key)
    asset.id,asset.account_id,asset.job_id,asset.item_id,asset.plan_id,
    asset.visual_group_key,asset.slot_key,asset.role,asset.status,asset.content_hash,asset.width,asset.height
  FROM ai_generation_assets AS asset
  JOIN ai_content_plans AS plan
    ON plan.account_id=asset.account_id AND plan.job_id=asset.job_id
      AND plan.item_id=asset.item_id AND plan.id=asset.plan_id
  CROSS JOIN LATERAL jsonb_array_elements(plan.plan->'slots') AS planned_slot
  WHERE asset.account_id=$1 AND asset.item_id=$2 AND asset.plan_id=$3 AND asset.status='ACCEPTED'
    AND planned_slot->>'slotKey'=asset.slot_key
    AND (plan.prompt_template_version NOT IN ('AUTO_LISTING_CONTENT_PLAN_FILL_V3','AUTO_LISTING_CONTENT_PLAN_FILL_V4','AUTO_LISTING_CONTENT_PLAN_FILL_V5','AUTO_LISTING_CONTENT_PLAN_FILL_V6')
      OR jsonb_array_length(planned_slot->'claims')>0
      OR asset.checker_result->>'textForbidden'='true')
  ORDER BY asset.visual_group_key,asset.slot_key,asset.expected_status_version DESC NULLS LAST,
    asset.created_at DESC,asset.id DESC
`;

const RICH_SQL = `
  WITH accepted AS (
    SELECT rich.*,MIN(asset->>'visualGroupKey') AS group_key,
      COUNT(DISTINCT asset->>'visualGroupKey')::INTEGER AS group_count
    FROM ai_rich_content_results AS rich
    CROSS JOIN LATERAL jsonb_array_elements(rich.asset_evidence) AS asset
    WHERE rich.account_id=$1 AND rich.item_id=$2 AND rich.plan_id=$3 AND rich.status='ACCEPTED'
    GROUP BY rich.id
  )
  SELECT DISTINCT ON (group_key)
    account_id,job_id,item_id,plan_id,rich_content,output_hash,asset_evidence,status
  FROM accepted
  WHERE group_count=1
  ORDER BY group_key,accepted_at DESC NULLS LAST,created_at DESC,id DESC
`;

const PUBLICATIONS_SQL = `
  SELECT DISTINCT ON (asset.visual_group_key,asset.slot_key)
    asset.id,asset.account_id,asset.job_id,asset.item_id,asset.plan_id,
    asset.visual_group_key,asset.slot_key,asset.role,asset.status,asset.content_hash,asset.width,asset.height,
    publication.public_url,publication.publication_version,publication.public_base_url,publication.public_prefix
  FROM ai_generation_assets AS asset
  JOIN ai_content_plans AS plan
    ON plan.account_id=asset.account_id AND plan.job_id=asset.job_id
      AND plan.item_id=asset.item_id AND plan.id=asset.plan_id
  CROSS JOIN LATERAL jsonb_array_elements(plan.plan->'slots') AS planned_slot
  JOIN auto_listing_asset_publications AS publication
    ON publication.account_id=asset.account_id AND publication.job_id=asset.job_id
      AND publication.item_id=asset.item_id AND publication.plan_id=asset.plan_id
      AND publication.asset_id=asset.id AND publication.content_hash=asset.content_hash
  WHERE asset.account_id=$1 AND asset.item_id=$2 AND asset.plan_id=$3 AND asset.status='ACCEPTED'
    AND publication.publication_version=$4
    AND planned_slot->>'slotKey'=asset.slot_key
    AND (plan.prompt_template_version NOT IN ('AUTO_LISTING_CONTENT_PLAN_FILL_V3','AUTO_LISTING_CONTENT_PLAN_FILL_V4','AUTO_LISTING_CONTENT_PLAN_FILL_V5','AUTO_LISTING_CONTENT_PLAN_FILL_V6')
      OR jsonb_array_length(planned_slot->'claims')>0
      OR asset.checker_result->>'textForbidden'='true')
  ORDER BY asset.visual_group_key,asset.slot_key,asset.expected_status_version DESC NULLS LAST,
    asset.created_at DESC,asset.id DESC
`;

const WAREHOUSE_SQL = `
  SELECT w.id,w.store_id,w.warehouse_id,w.warehouse_type,w.status,w.is_active,w.is_archived,
    EXISTS (SELECT 1 FROM product_stocks ps JOIN products p ON p.id=ps.product_id
      WHERE ps.warehouse_id=w.id AND ps.store_id=w.store_id AND LOWER(ps.source)='fbs' AND p.is_archived=FALSE)
      AS has_active_product_association
  FROM warehouses w WHERE w.store_id=$1
`;

function contextFrom(row, assets, rich, warehouses, publications = []) {
  const base = listingBase(row);
  const selectedWarehouse = warehouses.find((warehouse) => warehouse.id === row.target_warehouse_id);
  const effectiveConfig = effectiveFrozenConfig(row);
  return {
    item: { accountId: row.account_id, jobId: row.job_id, id: row.id, sourceSnapshotId: row.snapshot_id,
      status: row.status, statusVersion: Number(row.status_version), targetStoreId: row.target_store_id,
      targetWarehouseId: row.target_warehouse_id, activePlanId: row.active_content_plan_id },
    sourceHash: row.snapshot_hash,
    listingBaseId: row.listing_base_id,
    listingBase: base,
    frozenConfig: { config: row.config_snapshot, configHash: row.config_hash },
    effectiveFrozenConfig: effectiveConfig,
    targetWarehousePlatformId: selectedWarehouse?.warehouse_id || null,
    warehouseFulfillmentType: String(selectedWarehouse?.warehouse_type || "").trim().toUpperCase() || null,
    creationWarehouseValidation: row.warehouse_validation_evidence_id ? {
      evidenceId: row.warehouse_validation_evidence_id,
      schemaVersion: row.creation_evidence_schema_version,
      accountId: row.account_id,
      storeId: row.creation_evidence_store_id,
      warehouseRecordId: row.creation_evidence_warehouse_record_id,
      platformWarehouseId: row.creation_evidence_platform_warehouse_id,
      fulfillmentType: row.creation_evidence_fulfillment_type,
      status: row.creation_evidence_status,
      outcome: row.creation_evidence_outcome,
      observedAt: row.creation_evidence_observed_at instanceof Date
        ? row.creation_evidence_observed_at.toISOString() : row.creation_evidence_observed_at,
      expiresAt: row.creation_evidence_expires_at instanceof Date
        ? row.creation_evidence_expires_at.toISOString() : row.creation_evidence_expires_at,
      evidenceHash: row.creation_evidence_hash,
      correlationId: row.creation_evidence_correlation_id,
      actorAccountId: row.creation_evidence_actor_account_id,
    } : null,
    visualGroups: visualGroups({ ...row, plan_id: row.plan_id }),
    acceptedAssets: assets.map((asset) => ({
      accountId: asset.account_id, jobId: asset.job_id, itemId: asset.item_id, planId: asset.plan_id,
      assetId: asset.id, visualGroupKey: asset.visual_group_key, slotKey: asset.slot_key,
      role: asset.role, status: asset.status, contentHash: asset.content_hash,
      width: Number(asset.width), height: Number(asset.height),
    })),
    terminalPublishedAssets: publications.map((asset) => ({
      accountId: asset.account_id, jobId: asset.job_id, itemId: asset.item_id, planId: asset.plan_id,
      assetId: asset.id, visualGroupKey: asset.visual_group_key, slotKey: asset.slot_key,
      role: asset.role, status: asset.status, contentHash: asset.content_hash,
      width: Number(asset.width), height: Number(asset.height), publishedUrl: asset.public_url,
      publicationVersion: asset.publication_version,
    })),
    terminalSubmission: row.terminal_link_id ? {
      id: row.terminal_link_id, jobId: row.terminal_job_id, status: row.terminal_status,
      idempotencyKey: row.terminal_idempotency_key, resultHash: row.terminal_result_hash,
      requestHash: row.terminal_request_hash, targetStoreId: row.terminal_target_store_id,
      listingBaseId: row.terminal_listing_base_id, activePlanId: row.terminal_active_plan_id,
      sourceHash: row.terminal_source_hash, configHash: row.terminal_config_hash,
      uploadPolicyVersionId: row.terminal_upload_policy_version_id,
      publicationPolicyHash: row.terminal_publication_policy_hash,
      mediaEvidenceHash: row.terminal_media_evidence_hash,
      submissionSnapshotId: row.terminal_submission_snapshot_id,
      submissionJobId: row.terminal_submission_job_id,
      categoryRecovery: row.terminal_recovery_attempt_id ? {
        attemptId: row.terminal_recovery_attempt_id,
        status: row.terminal_recovery_status,
        originalOzonTaskId: row.terminal_recovery_original_ozon_task_id,
        retryOzonTaskId: row.terminal_recovery_retry_ozon_task_id,
        oldSharedCategoryVersion: Number(row.terminal_recovery_old_shared_category_version),
        replacementSharedCategoryVersion:
          Number(row.terminal_recovery_replacement_shared_category_version),
      } : null,
    } : null,
    acceptedRichContent: rich.map((entry) => ({
      accountId: entry.account_id, jobId: entry.job_id, itemId: entry.item_id, planId: entry.plan_id,
      visualGroupKey: richGroupKey(entry), status: entry.status, content: entry.rich_content, outputHash: entry.output_hash,
    })),
    productDraft: { id: row.current_draft_id, version: Number(row.current_draft_version), dataHash: row.current_draft_data_hash },
    collectItem: { ...(row.collect_row || {}), id: row.current_collect_item_id, accountId: row.account_id,
      listingDraft: row.current_draft_data || {} },
    store: { id: row.store_id, ownerAccountId: row.store_account_id, credentialsUsable: row.credentials_usable === true },
    warehouses: warehouses.map((warehouse) => ({
      id: warehouse.id, accountId: row.account_id, storeId: warehouse.store_id,
      warehouseId: warehouse.warehouse_id, warehouseType: warehouse.warehouse_type,
      status: warehouse.status, isActive: warehouse.is_active, isArchived: warehouse.is_archived,
      hasActiveProductAssociation: warehouse.has_active_product_association,
    })),
    products: warehouses.filter((warehouse) => warehouse.has_active_product_association).map((warehouse) => ({
      id: `eligibility-${warehouse.id}`, accountId: row.account_id, storeId: warehouse.store_id, isArchived: false,
      warehouseStocks: [{ warehouseId: warehouse.warehouse_id, source: "fbs" }],
    })),
    uploadPolicy: row.policy_id ? { id: row.policy_id, accountId: row.policy_account_id,
      version: Number(row.policy_version), mode: row.policy_mode, enabled: row.policy_enabled === true,
      publishedBy: row.policy_published_by,
      publishedAt: row.policy_published_at instanceof Date ? row.policy_published_at.toISOString() : row.policy_published_at,
      publicationPolicy: { origin: row.publication_origin, baseUrl: row.publication_base_url,
        prefix: row.publication_prefix, publicationVersion: row.publication_version },
      publicationPolicyHash: row.publication_policy_hash } : null,
  };
}

function lockedMediaEvidenceHash(row, assets, rich, publications) {
  const groups = visualGroups({ ...row, plan_id: row.plan_id });
  const publicationPolicy = { origin: row.publication_origin, baseUrl: row.publication_base_url,
    prefix: row.publication_prefix, publicationVersion: row.publication_version };
  const publishedById = new Map(publications.map((entry) => [entry.id, entry]));
  if (publishedById.size !== assets.length) throw repositoryError("AUTO_LISTING_UPLOAD_EVIDENCE_CHANGED", 409);
  return digest({
    visualGroups: groups,
    assets: assets.map((asset) => {
      const publication = publishedById.get(asset.id);
      if (!publication || publication.public_base_url !== row.publication_base_url
        || publication.public_prefix !== row.publication_prefix
        || publication.publication_version !== row.publication_version) {
        throw repositoryError("AUTO_LISTING_UPLOAD_EVIDENCE_CHANGED", 409);
      }
      return { assetId: asset.id, accountId: asset.account_id, jobId: asset.job_id,
        itemId: asset.item_id, planId: asset.plan_id, visualGroupKey: asset.visual_group_key,
        slotKey: asset.slot_key, role: asset.role, status: asset.status, contentHash: asset.content_hash,
        width: Number(asset.width), height: Number(asset.height), publishedUrl: publication.public_url,
        publicationVersion: publication.publication_version };
    }),
    rich: rich.map((entry) => ({ accountId: entry.account_id, jobId: entry.job_id, itemId: entry.item_id,
      planId: entry.plan_id, visualGroupKey: richGroupKey(entry), status: entry.status, outputHash: entry.output_hash })),
    publicationPolicy,
  });
}

const LINK_COLUMNS = `id,job_id,status,idempotency_key,result_hash,target_store_id,listing_base_id,active_plan_id,
  source_hash,config_hash,request_hash,upload_policy_version_id,publication_policy_hash,media_evidence_hash,
  direct_health_evidence_id,warehouse_validation_evidence_id,claim_token,claim_expires_at,attempt_generation,
  submission_snapshot_id,submission_job_id`;

function assertReusableReservation(row, values) {
  if (!row || ["SUBMITTED", "RECONCILING", "SUCCEEDED"].includes(row.status)) return;
  if (row.listing_base_id !== values.listingBaseId || row.active_plan_id !== values.activePlanId
    || row.source_hash !== values.sourceHash || row.config_hash !== values.configHash
    || row.request_hash !== values.requestHash || row.upload_policy_version_id !== values.uploadPolicyVersionId
    || row.publication_policy_hash !== values.publicationPolicyHash || row.media_evidence_hash !== values.mediaEvidenceHash
    || row.idempotency_key !== values.idempotencyKey) {
    throw repositoryError("AUTO_LISTING_UPLOAD_CONFLICT", 409);
  }
}

async function insertAttempt(database, randomUUID, input = {}) {
  const directHealthEvidenceId = optionalId(input.directHealthEvidenceId);
  const warehouseValidationEvidenceId = optionalId(input.warehouseValidationEvidenceId);
  if ((input.action === "DIRECT_UPLOAD") !== Boolean(directHealthEvidenceId)
    || (input.outcome === "RESERVED" && !warehouseValidationEvidenceId)) throw repositoryError();
  const inserted = await database.query(
    `INSERT INTO auto_listing_upload_attempts (
       id,account_id,job_id,auto_listing_item_id,submission_link_id,actor_account_id,action,
       expected_item_version,target_store_id,target_warehouse_id,product_draft_hash,request_hash,
       result_hash,direct_health_evidence_id,warehouse_validation_evidence_id,outcome,error_code,error_safe,
       listing_pipeline_response_summary,correlation_id
     ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20
        FROM auto_listing_submission_links AS link
        WHERE link.account_id=$2 AND link.id=$5
          AND link.auto_listing_item_id=$4 AND link.job_id=$3 AND link.target_store_id=$9
          AND (($15::text IS NULL AND link.warehouse_validation_evidence_id IS NULL
                AND $16::text<>'RESERVED')
            OR ($15::text IS NOT NULL AND link.warehouse_validation_evidence_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM auto_listing_rfbs_warehouse_evidence AS evidence
              WHERE evidence.account_id=$2 AND evidence.id=$15::text AND evidence.store_id=$9
                AND evidence.warehouse_record_id=$10 AND evidence.fulfillment_type='RFBS'
                AND evidence.outcome='PASSED'
                AND (($16::text='RESERVED' AND evidence.expires_at>STATEMENT_TIMESTAMP())
                  OR ($16::text<>'RESERVED' AND EXISTS (
                    SELECT 1 FROM auto_listing_upload_attempts AS reservation
                    WHERE reservation.account_id=link.account_id
                      AND reservation.submission_link_id=link.id
                      AND reservation.auto_listing_item_id=link.auto_listing_item_id
                      AND reservation.job_id=link.job_id
                      AND reservation.target_store_id=link.target_store_id
                      AND reservation.target_warehouse_id=$10
                      AND reservation.warehouse_validation_evidence_id=evidence.id
                      AND reservation.outcome='RESERVED'
                  )))
            )))
        RETURNING id`,
    [`upload-attempt-${randomUUID()}`, id(input.accountId), id(input.jobId), id(input.itemId),
      id(input.submissionLinkId), id(input.actorAccountId), input.action, input.expectedStatusVersion,
      id(input.targetStoreId), id(input.targetWarehouseId), hash(input.productDraftHash), hash(input.requestHash),
      hash(input.resultHash), directHealthEvidenceId, warehouseValidationEvidenceId, input.outcome,
      input.errorCode || null, input.errorSafe || null, JSON.stringify(input.responseSummary || {}), id(input.correlationId)],
  );
  if (inserted.rowCount !== 1) throw repositoryError("AUTO_LISTING_UPLOAD_CONFLICT", 409);
  return inserted.rows[0].id;
}

export function createPostgresAutoListingUploadRepository({ pool, randomUUID = crypto.randomUUID } = {}) {
  if (typeof pool?.connect !== "function" || typeof pool?.query !== "function" || typeof randomUUID !== "function") {
    throw new TypeError("Auto-listing upload PostgreSQL dependencies are required");
  }
  return Object.freeze({
    async loadUploadEvidence({ accountId: rawAccountId, itemId: rawItemId } = {}) {
      const accountId = id(rawAccountId);
      const itemId = id(rawItemId);
      const client = await pool.connect();
      let started = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        started = true;
        const result = await client.query(CONTEXT_SQL, [accountId, itemId]);
        const row = result.rows[0];
        if (!row) { await client.query("COMMIT"); started = false; return null; }
        const assets = await client.query(ASSETS_SQL, [accountId, itemId, row.plan_id]);
        const rich = await client.query(RICH_SQL, [accountId, itemId, row.plan_id]);
        const warehouses = await client.query(WAREHOUSE_SQL, [row.target_store_id]);
        const publications = await client.query(PUBLICATIONS_SQL,
          [accountId, itemId, row.plan_id, row.publication_version]);
        const value = contextFrom(row, assets.rows, rich.rows, warehouses.rows, publications.rows);
        await client.query("COMMIT");
        started = false;
        return value;
      } catch (error) {
        if (started) await client.query("ROLLBACK").catch(() => {});
        if (isRepositoryError(error)) throw error;
        throw repositoryError("AUTO_LISTING_UPLOAD_REPOSITORY_FAILED", 503, true);
      } finally { client.release(); }
    },

    async reserveSubmission(input = {}) {
      const values = {
        accountId: id(input.accountId), itemId: id(input.itemId), jobId: id(input.jobId),
        listingBaseId: id(input.listingBaseId), activePlanId: id(input.activePlanId),
        targetStoreId: id(input.targetStoreId), targetWarehouseId: id(input.targetWarehouseId),
        targetWarehousePlatformId: id(input.targetWarehousePlatformId),
        sourceHash: hash(input.sourceHash), configHash: hash(input.configHash), requestHash: hash(input.requestHash),
        resultHash: hash(input.resultHash), uploadPolicyVersionId: id(input.uploadPolicyVersionId),
        publicationPolicyHash: hash(input.publicationPolicyHash), mediaEvidenceHash: hash(input.mediaEvidenceHash),
        directHealthEvidenceId: optionalId(input.directHealthEvidenceId),
        warehouseFulfillmentType: String(input.warehouseFulfillmentType || "").trim().toUpperCase(),
        creationWarehouseValidationEvidenceId: optionalId(input.creationWarehouseValidationEvidenceId),
        idempotencyKey: key(input.idempotencyKey), correlationId: id(input.correlationId),
      };
      const warehouseValidation = values.warehouseFulfillmentType === "RFBS"
        ? exactWarehouseValidation(input.warehouseValidation, values) : null;
      const publicationPolicy = input.publicationPolicy;
      if (!Number.isSafeInteger(input.expectedStatusVersion) || input.expectedStatusVersion < 1
        || !["REVIEW_APPROVE", "DIRECT_UPLOAD"].includes(input.action)
        || ((input.action === "DIRECT_UPLOAD") !== Boolean(values.directHealthEvidenceId))
        || input.productDraft?.id !== id(input.productDraft?.id)
        || !Number.isSafeInteger(input.productDraft?.version) || input.productDraft.version < 1
        || !HASH.test(input.productDraft?.dataHash || "") || !publicationPolicy
        || publicationPolicyDigest(publicationPolicy) !== values.publicationPolicyHash
        || !["FBS", "RFBS"].includes(values.warehouseFulfillmentType)
        || (values.warehouseFulfillmentType === "RFBS") !== Boolean(values.creationWarehouseValidationEvidenceId)
        || (values.warehouseFulfillmentType === "RFBS") !== Boolean(warehouseValidation)
        || (values.warehouseFulfillmentType === "FBS" && input.warehouseValidation != null)) throw repositoryError();
      const client = await pool.connect();
      let started = false;
      try {
        await client.query("BEGIN"); started = true;
        const locked = await client.query(
          `SELECT item.id,item.id AS item_id,item.account_id,item.job_id,item.status,item.status_version,item.target_store_id,item.target_warehouse_id,
             item.active_content_plan_id,base.id AS listing_base_id,base.product_draft_id,
             base.product_draft_version,base.product_draft_data_hash,job.config_hash,job.upload_policy_version_id,
             job.warehouse_validation_evidence_id,
             source.snapshot_hash,plan.id AS plan_id,plan.visual_groups,plan.plan,
             policy.mode AS policy_mode,policy.publication_origin,policy.publication_base_url,policy.publication_prefix,
             policy.publication_version,policy.publication_policy_hash,
             draft.id AS current_draft_id,draft.version AS current_draft_version,draft.data_hash AS current_draft_data_hash,
             (credential.store_id IS NOT NULL AND credential.encrypted_api_key<>''
               AND credential.iv<>'' AND credential.auth_tag<>'') AS credentials_usable,
             warehouse.warehouse_id AS locked_warehouse_platform_id,
             UPPER(BTRIM(warehouse.warehouse_type)) AS locked_warehouse_type,
             warehouse.status AS locked_warehouse_status,warehouse.is_active AS locked_warehouse_active,
             warehouse.is_archived AS locked_warehouse_archived,
             EXISTS (SELECT 1 FROM product_stocks ps JOIN products p ON p.id=ps.product_id
               WHERE ps.warehouse_id=warehouse.id AND ps.store_id=warehouse.store_id
                 AND LOWER(ps.source)='fbs' AND p.is_archived=FALSE) AS locked_fbs_association
           FROM auto_listing_job_items AS item
           JOIN accounts AS account ON account.id=item.account_id
           JOIN auto_listing_jobs AS job ON job.account_id=item.account_id AND job.id=item.job_id
           JOIN auto_listing_listing_bases AS base ON base.account_id=item.account_id AND base.job_id=item.job_id AND base.item_id=item.id
           JOIN auto_listing_source_snapshots AS source ON source.account_id=item.account_id AND source.id=item.snapshot_id
           JOIN ai_content_plans AS plan ON plan.account_id=item.account_id AND plan.job_id=item.job_id
             AND plan.item_id=item.id AND plan.id=item.active_content_plan_id
           JOIN auto_listing_upload_policy_versions AS policy ON policy.account_id=item.account_id
             AND policy.id=job.upload_policy_version_id AND policy.enabled=TRUE
           JOIN collect_items AS collect ON collect.account_id=item.account_id AND collect.id=base.collect_item_id AND collect.deleted_at IS NULL
           JOIN product_drafts AS draft ON draft.id=collect.current_draft_id AND draft.collect_item_id=collect.id
           JOIN stores AS store ON store.owner_account_id=item.account_id AND store.id=item.target_store_id
           JOIN warehouses AS warehouse ON warehouse.store_id=store.id AND warehouse.id=item.target_warehouse_id
           LEFT JOIN store_credentials AS credential ON credential.store_id=store.id
          WHERE item.account_id=$1 AND item.id=$2
          FOR UPDATE OF item FOR SHARE OF account,store,warehouse`,
          [values.accountId, values.itemId],
        );
        const row = locked.rows[0];
        const queued = row?.status === "UPLOAD_QUEUED"
          && Number(row.status_version) === input.expectedStatusVersion;
        const recovering = row?.status === "UPLOADING"
          && Number(row.status_version) === input.expectedStatusVersion + 1;
        if (row && (row.locked_warehouse_type !== values.warehouseFulfillmentType
          || row.locked_warehouse_platform_id !== values.targetWarehousePlatformId
          || row.locked_warehouse_active !== true || row.locked_warehouse_archived !== false
          || ["disabled", "archived", "archive", "inactive", "deleted", "blocked"]
            .includes(String(row.locked_warehouse_status || "").trim().toLowerCase())
          || (values.warehouseFulfillmentType === "FBS" && row.locked_fbs_association !== true))) {
          throw repositoryError("AUTO_LISTING_UPLOAD_WAREHOUSE_CHANGED", 409);
        }
        if (!row || (!queued && !recovering) || row.job_id !== values.jobId || row.target_store_id !== values.targetStoreId
          || row.target_warehouse_id !== values.targetWarehouseId || row.active_content_plan_id !== values.activePlanId
          || row.listing_base_id !== values.listingBaseId || row.config_hash !== values.configHash
          || row.snapshot_hash !== values.sourceHash
          || row.upload_policy_version_id !== values.uploadPolicyVersionId || row.credentials_usable !== true
          || row.warehouse_validation_evidence_id !== values.creationWarehouseValidationEvidenceId
          || (input.action === "DIRECT_UPLOAD" ? row.policy_mode !== "DIRECT" : row.policy_mode !== "REVIEW")
          || row.publication_policy_hash !== values.publicationPolicyHash
          || row.publication_origin !== publicationPolicy.origin
          || row.publication_base_url !== publicationPolicy.baseUrl
          || row.publication_prefix !== publicationPolicy.prefix
          || row.publication_version !== publicationPolicy.publicationVersion
          || row.product_draft_id !== input.productDraft.id || Number(row.product_draft_version) !== input.productDraft.version
          || row.product_draft_data_hash !== input.productDraft.dataHash || row.current_draft_id !== input.productDraft.id
          || Number(row.current_draft_version) !== input.productDraft.version || row.current_draft_data_hash !== input.productDraft.dataHash) {
          throw repositoryError("AUTO_LISTING_UPLOAD_CONFLICT", 409);
        }
        if (input.action === "DIRECT_UPLOAD") {
          const health = await client.query(
            `SELECT id FROM auto_listing_asset_publication_health_evidence AS health
              WHERE health.account_id=$1 AND health.id=$2 AND health.publication_version=$3
                AND health.public_base_url=$4 AND health.public_prefix=$5
                AND health.outcome='PASSED' AND health.expires_at>NOW()
              FOR SHARE OF health`,
            [values.accountId, values.directHealthEvidenceId, publicationPolicy.publicationVersion,
              publicationPolicy.baseUrl, publicationPolicy.prefix],
          );
          if (health.rowCount !== 1) throw repositoryError("AUTO_LISTING_UPLOAD_CONFLICT", 409);
        }
        if (values.warehouseFulfillmentType === "RFBS") {
          const creationEvidence = await client.query(
            `SELECT id FROM auto_listing_rfbs_warehouse_evidence
              WHERE account_id=$1 AND id=$2 AND store_id=$3 AND warehouse_record_id=$4
                AND platform_warehouse_id=$5 AND fulfillment_type='RFBS' AND outcome='PASSED'
              FOR SHARE`,
            [values.accountId, values.creationWarehouseValidationEvidenceId, values.targetStoreId,
              values.targetWarehouseId, values.targetWarehousePlatformId],
          );
          if (creationEvidence.rowCount !== 1) throw repositoryError("AUTO_LISTING_UPLOAD_WAREHOUSE_CHANGED", 409);
        }
        const acceptedAssets = await client.query(ASSETS_SQL, [values.accountId, values.itemId, values.activePlanId]);
        const acceptedRich = await client.query(RICH_SQL, [values.accountId, values.itemId, values.activePlanId]);
        const publications = await client.query(PUBLICATIONS_SQL, [values.accountId, values.itemId,
          values.activePlanId, publicationPolicy.publicationVersion]);
        if (lockedMediaEvidenceHash(row, acceptedAssets.rows, acceptedRich.rows, publications.rows)
          !== values.mediaEvidenceHash) throw repositoryError("AUTO_LISTING_UPLOAD_EVIDENCE_CHANGED", 409);
        let existing = await client.query(
          `SELECT ${LINK_COLUMNS} FROM auto_listing_submission_links
            WHERE account_id=$1 AND auto_listing_item_id=$2 FOR UPDATE`,
          [values.accountId, values.itemId],
        );
        assertReusableReservation(existing.rows[0], values);
        if (existing.rows[0]) {
          const expectedEvidence = values.warehouseFulfillmentType === "RFBS";
          if (expectedEvidence !== Boolean(existing.rows[0].warehouse_validation_evidence_id)) {
            throw repositoryError("AUTO_LISTING_UPLOAD_CONFLICT", 409);
          }
        }
        let claimOwned = false;
        if (existing.rows[0]?.status === "RESERVED") {
          const current = existing;
          const takeover = await client.query(
            `UPDATE auto_listing_submission_links SET claim_token=$3,claim_expires_at=NOW()+INTERVAL '60 seconds',
               attempt_generation=attempt_generation+1,updated_at=NOW()
              WHERE account_id=$1 AND id=$2 AND status='RESERVED' AND claim_expires_at<=NOW()
              RETURNING ${LINK_COLUMNS}`,
            [values.accountId, existing.rows[0].id, `claim-${randomUUID()}`],
          );
          if (takeover.rowCount === 1) { existing = takeover; claimOwned = true; }
          else existing = current;
        }
        let currentWarehouseValidationEvidenceId = null;
        const insertWarehouseValidationEvidence = async (submissionLinkId) => {
          if (!warehouseValidation) return null;
            const databaseFresh = await client.query(
              "SELECT $1::timestamptz>STATEMENT_TIMESTAMP() AS fresh",
              [warehouseValidation.expiresAt],
            );
            if (databaseFresh.rows[0]?.fresh !== true) {
              throw repositoryError("RFBS_WAREHOUSE_EVIDENCE_EXPIRED", 409);
            }
            const warehouseValidationEvidenceId = `auto-listing-rfbs-upload-evidence-${randomUUID()}`;
            const insertedEvidence = await client.query(
              `INSERT INTO auto_listing_rfbs_warehouse_evidence (
                 id,account_id,store_id,warehouse_record_id,platform_warehouse_id,schema_version,
                 fulfillment_type,status,outcome,observed_at,expires_at,evidence_hash,correlation_id,
                 actor_account_id,raw_response_ref
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14,NULL)
               RETURNING id`,
              [warehouseValidationEvidenceId, warehouseValidation.accountId, warehouseValidation.storeId,
                warehouseValidation.warehouseRecordId, warehouseValidation.platformWarehouseId,
                warehouseValidation.schemaVersion, warehouseValidation.fulfillmentType,
                warehouseValidation.status, warehouseValidation.outcome, warehouseValidation.observedAt,
                warehouseValidation.expiresAt, warehouseValidation.evidenceHash,
                warehouseValidation.correlationId, warehouseValidation.actorAccountId],
            );
            if (insertedEvidence.rowCount !== 1) throw repositoryError("AUTO_LISTING_UPLOAD_CONFLICT", 409);
            await client.query(
              `INSERT INTO audit_events (
                 event_id,account_id,store_id,action,entity_type,entity_id,correlation_id,metadata,
                 status,actor_type,actor_id,source,occurred_at
               ) VALUES ($1,$2,$3,'AUTO_LISTING_RFBS_WAREHOUSE_VALIDATED',
                 'auto_listing_rfbs_warehouse_evidence',$4,$5,$6::jsonb,'SUCCESS','account',$2,
                 'auto-listing-upload-repository',STATEMENT_TIMESTAMP())`,
              [`AUTO_LISTING_RFBS_WAREHOUSE_VALIDATED:${warehouseValidationEvidenceId}`,
                values.accountId, values.targetStoreId, warehouseValidationEvidenceId,
                values.correlationId, JSON.stringify({ phase: "UPLOAD", submissionItemId: values.itemId,
                  submissionLinkId, submissionIdempotencyKey: values.idempotencyKey,
                  warehouseRecordId: values.targetWarehouseId,
                  platformWarehouseId: values.targetWarehousePlatformId,
                  evidenceHash: warehouseValidation.evidenceHash })],
            );
            return warehouseValidationEvidenceId;
        };
        if (!existing.rows[0]) {
          const submissionLinkId = `upload-link-${randomUUID()}`;
          currentWarehouseValidationEvidenceId = await insertWarehouseValidationEvidence(submissionLinkId);
          existing = await client.query(
            `INSERT INTO auto_listing_submission_links (
               id,account_id,job_id,auto_listing_item_id,listing_base_id,active_plan_id,target_store_id,
               source_hash,config_hash,request_hash,result_hash,upload_policy_version_id,idempotency_key,status,
               publication_origin,publication_base_url,publication_prefix,publication_version,
               publication_policy_hash,media_evidence_hash,direct_health_evidence_id,
               warehouse_validation_evidence_id,claim_token,claim_expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'RESERVED',$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW()+INTERVAL '60 seconds')
             ON CONFLICT (account_id,auto_listing_item_id) DO NOTHING
             RETURNING ${LINK_COLUMNS}`,
            [submissionLinkId, values.accountId, values.jobId, values.itemId, values.listingBaseId,
              values.activePlanId, values.targetStoreId, values.sourceHash, values.configHash, values.requestHash,
              values.resultHash, values.uploadPolicyVersionId, values.idempotencyKey, publicationPolicy.origin,
              publicationPolicy.baseUrl, publicationPolicy.prefix, publicationPolicy.publicationVersion,
              values.publicationPolicyHash, values.mediaEvidenceHash, values.directHealthEvidenceId,
              currentWarehouseValidationEvidenceId, `claim-${randomUUID()}`],
          );
          const inserted = Boolean(existing.rows[0]);
          if (!inserted) throw repositoryError("AUTO_LISTING_UPLOAD_CONFLICT", 409);
          assertReusableReservation(existing.rows[0], values);
          claimOwned = inserted;
        } else if (claimOwned && values.warehouseFulfillmentType === "RFBS") {
          currentWarehouseValidationEvidenceId = await insertWarehouseValidationEvidence(existing.rows[0].id);
        }
        if (claimOwned && queued) {
          const moved = await client.query(
            `UPDATE auto_listing_job_items SET status='UPLOADING',status_version=status_version+1,updated_at=NOW()
              WHERE account_id=$1 AND id=$2 AND status='UPLOAD_QUEUED' AND status_version=$3 RETURNING status_version`,
            [values.accountId, values.itemId, input.expectedStatusVersion],
          );
          if (moved.rowCount !== 1) throw repositoryError("AUTO_LISTING_UPLOAD_CONFLICT", 409);
          await client.query(
            `INSERT INTO auto_listing_events
               (id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,correlation_id,details)
             VALUES ($1,$2,$3,$4,$2,'UPLOAD_QUEUED','UPLOADING','UPLOAD_CLAIMED',$5,$6::jsonb)`,
            [`upload-event-${randomUUID()}`, values.accountId, values.jobId, values.itemId,
              values.correlationId, JSON.stringify({ submissionLinkId: existing.rows[0].id })],
          );
        }
        let reservedAttemptId = null;
        if (claimOwned && currentWarehouseValidationEvidenceId) {
          reservedAttemptId = await insertAttempt(client, randomUUID, {
            accountId: values.accountId, jobId: values.jobId, itemId: values.itemId,
            submissionLinkId: existing.rows[0].id, actorAccountId: values.accountId,
            action: input.action, expectedStatusVersion: input.expectedStatusVersion,
            targetStoreId: values.targetStoreId, targetWarehouseId: values.targetWarehouseId,
            productDraftHash: input.productDraft.dataHash, requestHash: values.requestHash,
            resultHash: values.resultHash, directHealthEvidenceId: values.directHealthEvidenceId,
            warehouseValidationEvidenceId: currentWarehouseValidationEvidenceId,
            outcome: "RESERVED", errorCode: null, errorSafe: null, correlationId: values.correlationId,
            responseSummary: { phase: "PRE_SEND", submissionIdempotencyKey: values.idempotencyKey,
              attemptGeneration: Number(existing.rows[0].attempt_generation || 1) },
          });
        }
        await client.query("COMMIT"); started = false;
        const link = mapLink({ ...existing.rows[0], claim_owned: claimOwned });
        return currentWarehouseValidationEvidenceId
          ? { ...link, warehouseValidationEvidenceId: currentWarehouseValidationEvidenceId,
            linkIdentityEvidenceId: link.warehouseValidationEvidenceId, reservedAttemptId }
          : link;
      } catch (error) {
        if (started) await client.query("ROLLBACK").catch(() => {});
        if (isRepositoryError(error)) throw error;
        throw repositoryError("AUTO_LISTING_UPLOAD_REPOSITORY_FAILED", 503, true);
      } finally { client.release(); }
    },

    async bindSubmission({ accountId: rawAccountId, itemId: rawItemId, linkId: rawLinkId,
      claimToken: rawClaimToken,
      submissionJobId: rawJobId, submissionSnapshotId: rawSnapshotId, attempt } = {}) {
      const accountId = id(rawAccountId); const itemId = id(rawItemId); const linkId = id(rawLinkId);
      const claimToken = id(rawClaimToken);
      const submissionJobId = id(rawJobId); const submissionSnapshotId = id(rawSnapshotId);
      if (!attempt || attempt.accountId !== accountId || attempt.itemId !== itemId || attempt.submissionLinkId !== linkId
        || attempt.outcome !== "SUCCEEDED") throw repositoryError();
      const client = await pool.connect();
      let started = false;
      try {
        await client.query("BEGIN"); started = true;
        const result = await client.query(
          `UPDATE auto_listing_submission_links SET submission_job_id=$4,submission_snapshot_id=$5,
             status='SUBMITTED',claim_token=NULL,claim_expires_at=NULL,updated_at=NOW()
            WHERE account_id=$1 AND auto_listing_item_id=$2 AND id=$3 AND status='RESERVED'
              AND submission_job_id IS NULL AND submission_snapshot_id IS NULL AND claim_token=$6
            RETURNING ${LINK_COLUMNS}`,
          [accountId, itemId, linkId, submissionJobId, submissionSnapshotId, claimToken],
        );
        let link = mapLink(result.rows[0]);
        if (link) await insertAttempt(client, randomUUID, attempt);
        else {
          const existing = await client.query(
            `SELECT ${LINK_COLUMNS} FROM auto_listing_submission_links
              WHERE account_id=$1 AND auto_listing_item_id=$2 AND id=$3 FOR UPDATE`,
            [accountId, itemId, linkId],
          );
          link = mapLink(existing.rows[0]);
          if (!link || link.submissionJobId !== submissionJobId || link.submissionSnapshotId !== submissionSnapshotId) {
            throw repositoryError("AUTO_LISTING_UPLOAD_CONFLICT", 409);
          }
        }
        const reconcileTask = await client.query(
          `INSERT INTO auto_listing_submission_reconcile_tasks
             (id,account_id,job_id,auto_listing_item_id,submission_link_id,submission_job_id,state,
              attempt_count,next_run_at)
           VALUES ($1,$2,$3,$4,$5,$6,'PENDING',0,NOW())
           ON CONFLICT (account_id,submission_link_id) DO NOTHING
           RETURNING id`,
          [`upload-reconcile-${randomUUID()}`, accountId, link.jobId, itemId, linkId, submissionJobId],
        );
        if (reconcileTask.rows[0]) {
          await client.query(
            `INSERT INTO auto_listing_submission_reconcile_events
               (account_id,reconcile_task_id,event_type,from_state,to_state,attempt_count,
                correlation_id,evidence)
             VALUES ($1,$2,'CREATED',NULL,'PENDING',0,$3,$4::jsonb)`,
            [accountId, reconcileTask.rows[0].id, id(attempt.correlationId),
              JSON.stringify({ submissionLinkId: linkId, submissionJobId })],
          );
        }
        await client.query("COMMIT"); started = false;
        return link;
      } catch (error) {
        if (started) await client.query("ROLLBACK").catch(() => {});
        if (isRepositoryError(error)) throw error;
        throw repositoryError("AUTO_LISTING_UPLOAD_REPOSITORY_FAILED", 503, true);
      } finally { client.release(); }
    },

    async recordAttempt(input = {}) {
      await insertAttempt(pool, randomUUID, input);
    },

    async blockSubmission({ accountId: rawAccountId, itemId: rawItemId, linkId: rawLinkId,
      claimToken: rawClaimToken, correlationId: rawCorrelationId, errorCode, attempt } = {}) {
      const accountId = id(rawAccountId); const itemId = id(rawItemId); const linkId = id(rawLinkId);
      const claimToken = id(rawClaimToken); const correlationId = id(rawCorrelationId); const safeCode = id(errorCode);
      if (!attempt || attempt.accountId !== accountId || attempt.itemId !== itemId
        || attempt.submissionLinkId !== linkId || !["BLOCKED", "UNCERTAIN"].includes(attempt.outcome)) {
        throw repositoryError();
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const blocked = await client.query(
          `UPDATE auto_listing_submission_links SET status='BLOCKED',claim_token=NULL,claim_expires_at=NULL,updated_at=NOW()
            WHERE account_id=$1 AND auto_listing_item_id=$2 AND id=$3 AND status='RESERVED' AND claim_token=$4 RETURNING job_id`,
          [accountId, itemId, linkId, claimToken],
        );
        if (blocked.rowCount === 1) {
          await insertAttempt(client, randomUUID, attempt);
          await client.query(
            `UPDATE auto_listing_job_items SET status='BLOCKED',status_version=status_version+1,
               failure_code=$3,failure_detail_safe=$3,updated_at=NOW()
              WHERE account_id=$1 AND id=$2 AND status='UPLOADING'`,
            [accountId, itemId, safeCode],
          );
          await client.query(
            `INSERT INTO auto_listing_events
               (id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,correlation_id,details)
             VALUES ($1,$2,$3,$4,$2,'UPLOADING','BLOCKED','UPLOAD_RESULT_UNCERTAIN',$5,$6::jsonb)`,
            [`upload-event-${randomUUID()}`, accountId, blocked.rows[0].job_id, itemId, correlationId,
              JSON.stringify({ submissionLinkId: linkId, errorCode: safeCode })],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (isRepositoryError(error)) throw error;
        throw repositoryError("AUTO_LISTING_UPLOAD_REPOSITORY_FAILED", 503, true);
      } finally { client.release(); }
    },

    async releaseSubmissionForRetry({ accountId: rawAccountId, itemId: rawItemId, linkId: rawLinkId,
      claimToken: rawClaimToken, correlationId: rawCorrelationId, attempt } = {}) {
      const accountId = id(rawAccountId); const itemId = id(rawItemId); const linkId = id(rawLinkId);
      const claimToken = id(rawClaimToken); const correlationId = id(rawCorrelationId);
      if (!attempt || attempt.accountId !== accountId || attempt.itemId !== itemId
        || attempt.submissionLinkId !== linkId || attempt.outcome !== "FAILED") throw repositoryError();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const released = await client.query(
          `UPDATE auto_listing_submission_links SET claim_expires_at=NOW(),updated_at=NOW()
            WHERE account_id=$1 AND auto_listing_item_id=$2 AND id=$3 AND status='RESERVED' AND claim_token=$4
            RETURNING job_id`,
          [accountId, itemId, linkId, claimToken],
        );
        if (released.rowCount !== 1) throw repositoryError("AUTO_LISTING_UPLOAD_CONFLICT", 409);
        const moved = await client.query(
          `UPDATE auto_listing_job_items SET status='UPLOAD_QUEUED',status_version=status_version+1,updated_at=NOW()
            WHERE account_id=$1 AND id=$2 AND status='UPLOADING' RETURNING status_version`,
          [accountId, itemId],
        );
        if (moved.rowCount !== 1) throw repositoryError("AUTO_LISTING_UPLOAD_CONFLICT", 409);
        await insertAttempt(client, randomUUID, attempt);
        await client.query(
          `INSERT INTO auto_listing_events
             (id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,correlation_id,details)
           VALUES ($1,$2,$3,$4,$2,'UPLOADING','UPLOAD_QUEUED','UPLOAD_RETRY_RELEASED',$5,$6::jsonb)`,
          [`upload-event-${randomUUID()}`, accountId, released.rows[0].job_id, itemId, correlationId,
            JSON.stringify({ submissionLinkId: linkId, statusVersion: Number(moved.rows[0].status_version) })],
        );
        await enqueueAutoListingUploadTask({ client, accountId, jobId: released.rows[0].job_id, itemId,
          actorAccountId: accountId, expectedStatusVersion: Number(moved.rows[0].status_version),
          correlationId, enqueueReason: "SAFE_RETRY" });
        await client.query("COMMIT");
        return { status: "UPLOAD_QUEUED", statusVersion: Number(moved.rows[0].status_version) };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (isRepositoryError(error)) throw error;
        throw repositoryError("AUTO_LISTING_UPLOAD_REPOSITORY_FAILED", 503, true);
      } finally { client.release(); }
    },
  });
}
