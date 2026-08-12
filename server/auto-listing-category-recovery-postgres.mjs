import crypto from "node:crypto";
import { projectOzonImportCarrier, projectProductionOzonImportErrorEvidence } from "./ozon-category-import-error-policy.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;

function repositoryError(code, status = 422, retryable = false) {
  const error = new Error("自动类目恢复数据操作失败");
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  error.cause = null;
  return error;
}

const invalid = () => repositoryError("AUTO_LISTING_CATEGORY_RECOVERY_INVALID");
const unavailable = () => repositoryError("AUTO_LISTING_CATEGORY_RECOVERY_DATABASE_FAILED", 503, true);
const notFound = () => repositoryError("AUTO_LISTING_CATEGORY_RECOVERY_NOT_FOUND", 404);
const conflict = () => repositoryError("AUTO_LISTING_CATEGORY_RECOVERY_CONFLICT", 409);
const policyDisabled = () => repositoryError("AUTO_LISTING_CATEGORY_RECOVERY_POLICY_DISABLED", 409);

function ownCode(error) {
  try {
    const descriptor = error && Object.getOwnPropertyDescriptor(error, "code");
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value : null;
  } catch { return null; }
}

function exact(raw, keys) {
  const value = projectOzonImportCarrier(raw);
  if (!value || Array.isArray(value)) throw invalid();
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) throw invalid();
  return value;
}

function identifier(value) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw invalid();
  return value;
}

function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw invalid();
  return value;
}

function instant(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) throw invalid();
  return value;
}

function digest(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw invalid();
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
  return value;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function attemptDto(row, extras = {}) {
  return Object.freeze({ attemptId: row.id, status: row.status, ...extras });
}

function matchedAttemptDto(row) {
  return Object.freeze({
    attemptId: row.id,
    status: row.status,
    replacementSharedCategoryId: row.replacement_shared_category_id,
    replacementSharedCategoryVersion: Number(row.replacement_shared_category_version),
    correctedItemsHash: row.corrected_items_hash,
  });
}

function retryAttemptDto(row) {
  return Object.freeze({
    attemptId: row.id, status: row.status, retryOzonTaskId: row.retry_ozon_task_id,
  });
}

async function transaction(pool, work) {
  let client;
  try {
    if (!pool || typeof pool.connect !== "function") throw invalid();
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('statement_timeout','25000',TRUE),
              set_config('lock_timeout','5000',TRUE),
              set_config('idle_in_transaction_session_timeout','30000',TRUE)`,
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    const code = ownCode(error);
    if (code?.startsWith("AUTO_LISTING_CATEGORY_RECOVERY_")) throw error;
    if (code === "23505" || code === "23514" || code === "40001") throw conflict();
    throw unavailable();
  } finally {
    try { client?.release(); } catch {}
  }
}

function loadCommand(raw) {
  const value = exact(raw, ["accountId", "jobId", "evidenceId"]);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, identifier(entry)]));
}

function claimCommand(raw) {
  const keys = [
    "accountId", "jobId", "snapshotId", "evidenceId", "sourceEvidenceId",
    "oldSharedCategoryId", "oldSharedCategoryVersion", "originalOzonTaskId", "correlationId",
  ];
  const value = exact(raw, keys);
  for (const key of keys.filter((key) => key !== "oldSharedCategoryVersion")) identifier(value[key]);
  positive(value.oldSharedCategoryVersion);
  return value;
}

const TRANSITION_IDENTITY_KEYS = [
  "accountId", "jobId", "snapshotId", "evidenceId", "attemptId", "sourceEvidenceId",
  "oldSharedCategoryId", "oldSharedCategoryVersion", "originalOzonTaskId", "correlationId",
];

function transitionBase(raw, extraKeys = []) {
  const value = exact(raw, [...TRANSITION_IDENTITY_KEYS, "expectedStatus", ...extraKeys, "transitionedAt"]);
  for (const key of TRANSITION_IDENTITY_KEYS.filter((key) => key !== "oldSharedCategoryVersion")) {
    identifier(value[key]);
  }
  positive(value.oldSharedCategoryVersion);
  identifier(value.expectedStatus);
  instant(value.transitionedAt);
  return value;
}

function exactAttemptIdentity(row, input) {
  return row?.account_id === input.accountId
    && row.submission_job_id === input.jobId
    && row.submission_snapshot_id === input.snapshotId
    && row.triggering_error_evidence_id === input.evidenceId
    && row.id === input.attemptId
    && row.source_evidence_id === input.sourceEvidenceId
    && row.old_shared_category_id === input.oldSharedCategoryId
    && Number(row.old_shared_category_version) === input.oldSharedCategoryVersion
    && row.original_ozon_task_id === input.originalOzonTaskId
    && row.correlation_id === input.correlationId;
}

function safeEvidence(value) {
  const evidence = exact(value, [
    "schemaVersion", "policyVersion", "errorCode", "field", "attributeId", "state",
    "offerId", "productId", "classification",
  ]);
  if (evidence.schemaVersion !== "OZON_CATEGORY_IMPORT_ERROR_EVIDENCE_V1"
    || !identifier(evidence.policyVersion) || !SAFE_CODE.test(evidence.errorCode)
    || typeof evidence.field !== "string" || evidence.field.length < 1 || evidence.field.length > 240
    || (evidence.attributeId !== null && (!Number.isSafeInteger(evidence.attributeId) || evidence.attributeId < 1))
    || evidence.state !== "FAILED" || !identifier(evidence.offerId) || evidence.productId !== null
    || evidence.classification !== "EXPLICIT_CATEGORY_FAILURE") throw invalid();
  return evidence;
}

function parseBasis(row) {
  const items = projectOzonImportCarrier(row.original_items);
  const evidence = safeEvidence(row.safe_evidence);
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) throw conflict();
  const offers = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || Array.isArray(item) || typeof item.offer_id !== "string" || !SAFE_ID.test(item.offer_id)
      || typeof item.sku !== "string" || item.sku.length > 240 || seen.has(item.offer_id)) throw conflict();
    seen.add(item.offer_id);
    offers.push(Object.freeze({ offerId: item.offer_id, sku: item.sku }));
  }
  return deepFreeze({
    accountId: row.account_id,
    jobId: row.submission_job_id,
    snapshotId: row.submission_snapshot_id,
    evidenceId: row.id,
    policyVersion: row.classifier_policy_version,
    classification: evidence.classification,
    productId: evidence.productId,
    originalOzonTaskId: row.original_ozon_task_id,
    sourceEvidenceId: row.source_evidence_id,
    oldSharedCategoryId: row.old_shared_category_id,
    oldSharedCategoryVersion: Number(row.old_shared_category_version),
    offers,
    frozenItems: items,
    safeEvidence: evidence,
    sharedCategory: Object.freeze({
      accountId: row.shared_account_id,
      sourceDescriptionCategoryId: Number(row.shared_source_description_category_id),
      sourceTypeId: Number(row.shared_source_type_id),
      taxonomyScope: row.shared_taxonomy_scope,
      currentDescriptionCategoryId: Number(row.shared_current_description_category_id),
      currentTypeId: Number(row.shared_current_type_id),
      status: row.shared_status,
      source: row.shared_source,
      taxonomyFingerprint: row.shared_taxonomy_fingerprint,
      version: Number(row.shared_version),
      evidenceId: row.shared_evidence_id,
      validatedAt: row.shared_validated_at === null ? null : new Date(row.shared_validated_at).toISOString(),
    }),
    existingAttempt: row.attempt_id === null ? null
      : Object.freeze({
        attemptId: row.attempt_id, status: row.attempt_status,
        correlationId: row.attempt_correlation_id,
      }),
  });
}

export function createAutoListingCategoryRecoveryPostgres({
  pool,
  idFactory = () => `category-recovery-${crypto.randomUUID()}`,
  now = () => new Date().toISOString(),
} = {}) {
  return Object.freeze({
    async recordCategoryErrorEvidence(raw) {
      const value = exact(raw, [
        "accountId", "jobId", "snapshotId", "itemId", "offerId", "originalOzonTaskId",
        "policyVersion", "safeEvidence", "sourceEvidenceId", "oldSharedCategoryId",
        "oldSharedCategoryVersion", "originalSnapshotHash",
      ]);
      for (const key of ["accountId", "jobId", "snapshotId", "itemId", "offerId",
        "originalOzonTaskId", "policyVersion", "sourceEvidenceId", "oldSharedCategoryId"]) identifier(value[key]);
      positive(value.oldSharedCategoryVersion);
      digest(value.originalSnapshotHash);
      safeEvidence(value.safeEvidence);
      if (projectProductionOzonImportErrorEvidence(value.safeEvidence) === null) throw policyDisabled();
      throw policyDisabled();
    },

    async loadCategoryRecoveryBasis(raw) {
      const input = loadCommand(raw);
      return transaction(pool, async (client) => {
        const rows = (await client.query(
          `SELECT evidence.*,attempt.id AS attempt_id,attempt.status AS attempt_status,
                  attempt.correlation_id AS attempt_correlation_id,
                  shared.account_id AS shared_account_id,
                  shared.source_description_category_id AS shared_source_description_category_id,
                  shared.source_type_id AS shared_source_type_id,
                  shared.taxonomy_scope AS shared_taxonomy_scope,
                  shared.current_description_category_id AS shared_current_description_category_id,
                  shared.current_type_id AS shared_current_type_id,
                  shared.status AS shared_status,shared.source AS shared_source,
                  shared.taxonomy_fingerprint AS shared_taxonomy_fingerprint,
                  shared.version AS shared_version,shared.source_evidence_id AS shared_evidence_id,
                  shared.validated_at AS shared_validated_at
             FROM submission_category_error_evidence AS evidence
             JOIN submission_jobs AS job
               ON job.account_id=evidence.account_id AND job.id=evidence.submission_job_id
              AND job.snapshot_id=evidence.submission_snapshot_id
             JOIN submission_snapshots AS snapshot
               ON snapshot.account_id=evidence.account_id AND snapshot.id=evidence.submission_snapshot_id
              AND snapshot.snapshot_hash=evidence.original_snapshot_hash
              AND snapshot.items=evidence.original_items
             JOIN collect_ozon_category_source_evidence AS source
               ON source.account_id=evidence.account_id AND source.id=evidence.source_evidence_id
             JOIN account_ozon_shared_categories AS shared
               ON shared.account_id=evidence.account_id AND shared.id=evidence.old_shared_category_id
              AND shared.source_evidence_id=source.id
             LEFT JOIN submission_category_recovery_attempts AS attempt
               ON attempt.account_id=evidence.account_id
              AND attempt.submission_job_id=evidence.submission_job_id
            WHERE evidence.account_id=$1 AND evidence.submission_job_id=$2 AND evidence.id=$3
              AND (
                (attempt.id IS NULL AND shared.version=evidence.old_shared_category_version
                  AND shared.status='ACTIVE' AND job.status='FAILED'
                  AND job.ozon_task_id=evidence.original_ozon_task_id
                  AND NOT EXISTS (
                    SELECT 1 FROM submission_items AS item
                     WHERE item.job_id=job.id AND item.snapshot_id=job.snapshot_id
                       AND (NULLIF(BTRIM(item.product_id),'') IS NOT NULL OR item.status<>'FAILED')
                  ))
                OR
                (attempt.id IS NOT NULL
                  AND attempt.submission_snapshot_id=evidence.submission_snapshot_id
                  AND attempt.triggering_error_evidence_id=evidence.id
                  AND attempt.source_evidence_id=evidence.source_evidence_id
                  AND attempt.old_shared_category_id=evidence.old_shared_category_id
                  AND attempt.old_shared_category_version=evidence.old_shared_category_version
                  AND attempt.original_ozon_task_id=evidence.original_ozon_task_id
                  AND attempt.original_snapshot_hash=evidence.original_snapshot_hash)
              )
            FOR SHARE OF evidence,job,snapshot,source,shared`,
          [input.accountId, input.jobId, input.evidenceId],
        )).rows;
        if (rows.length !== 1) throw notFound();
        return parseBasis(rows[0]);
      });
    },

    async claimCategoryRecovery(raw) {
      const input = claimCommand(raw);
      const attemptId = identifier(idFactory());
      const claimedAt = instant(now());
      return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`${input.accountId}\u001f${input.jobId}`]);
        const existing = (await client.query(
          "SELECT * FROM submission_category_recovery_attempts WHERE account_id=$1 AND submission_job_id=$2 FOR UPDATE",
          [input.accountId, input.jobId],
        )).rows[0];
        if (existing) {
          if (existing.submission_snapshot_id === input.snapshotId
            && existing.triggering_error_evidence_id === input.evidenceId
            && existing.source_evidence_id === input.sourceEvidenceId
            && existing.old_shared_category_id === input.oldSharedCategoryId
            && Number(existing.old_shared_category_version) === input.oldSharedCategoryVersion
            && existing.original_ozon_task_id === input.originalOzonTaskId
            && existing.correlation_id === input.correlationId) return attemptDto(existing, { claimed: false });
          throw conflict();
        }
        const eligible = (await client.query(
          `SELECT job.id
             FROM submission_category_error_evidence AS evidence
             JOIN submission_jobs AS job
               ON job.account_id=evidence.account_id AND job.id=evidence.submission_job_id
              AND job.snapshot_id=evidence.submission_snapshot_id
             JOIN submission_snapshots AS snapshot
               ON snapshot.account_id=evidence.account_id AND snapshot.id=evidence.submission_snapshot_id
              AND snapshot.snapshot_hash=evidence.original_snapshot_hash
              AND snapshot.items=evidence.original_items
             JOIN account_ozon_shared_categories AS shared
               ON shared.account_id=evidence.account_id AND shared.id=evidence.old_shared_category_id
              AND shared.source_evidence_id=evidence.source_evidence_id
              AND shared.version=evidence.old_shared_category_version AND shared.status='ACTIVE'
            WHERE evidence.account_id=$1 AND evidence.submission_job_id=$2
              AND evidence.submission_snapshot_id=$3 AND evidence.id=$4
              AND evidence.source_evidence_id=$5 AND evidence.old_shared_category_id=$6
              AND evidence.old_shared_category_version=$7 AND evidence.original_ozon_task_id=$8
              AND job.status='FAILED' AND job.ozon_task_id=evidence.original_ozon_task_id
              AND NOT EXISTS (
                SELECT 1 FROM submission_items AS item
                 WHERE item.job_id=job.id AND item.snapshot_id=job.snapshot_id
                   AND (NULLIF(BTRIM(item.product_id),'') IS NOT NULL OR item.status<>'FAILED')
              )
            FOR UPDATE OF job,shared`,
          [input.accountId, input.jobId, input.snapshotId, input.evidenceId,
            input.sourceEvidenceId, input.oldSharedCategoryId, input.oldSharedCategoryVersion,
            input.originalOzonTaskId],
        )).rows[0];
        if (!eligible) throw notFound();
        const itemRows = (await client.query(
          `SELECT status,product_id FROM submission_items
            WHERE job_id=$1 AND snapshot_id=$2 ORDER BY id FOR UPDATE`,
          [input.jobId, input.snapshotId],
        )).rows;
        if (!itemRows.length || itemRows.some((item) => item.status !== "FAILED"
          || (typeof item.product_id === "string" && item.product_id.trim() !== ""))) throw notFound();
        let row = (await client.query(
          `INSERT INTO submission_category_recovery_attempts(
             id,account_id,submission_job_id,submission_snapshot_id,triggering_error_evidence_id,
             source_evidence_id,old_shared_category_id,old_shared_category_version,
             original_ozon_task_id,original_snapshot_hash,status,correlation_id,claimed_at,updated_at)
           SELECT $1,evidence.account_id,evidence.submission_job_id,evidence.submission_snapshot_id,evidence.id,
                  evidence.source_evidence_id,evidence.old_shared_category_id,evidence.old_shared_category_version,
                  evidence.original_ozon_task_id,evidence.original_snapshot_hash,'CLAIMED',$10,$11,$11
             FROM submission_category_error_evidence AS evidence
             JOIN account_ozon_shared_categories AS shared
               ON shared.account_id=evidence.account_id AND shared.id=evidence.old_shared_category_id
              AND shared.source_evidence_id=evidence.source_evidence_id
              AND shared.version=evidence.old_shared_category_version AND shared.status='ACTIVE'
            WHERE evidence.account_id=$2 AND evidence.submission_job_id=$3
              AND evidence.submission_snapshot_id=$4 AND evidence.id=$5
              AND evidence.source_evidence_id=$6 AND evidence.old_shared_category_id=$7
              AND evidence.old_shared_category_version=$8 AND evidence.original_ozon_task_id=$9
           RETURNING *`,
          [attemptId, input.accountId, input.jobId, input.snapshotId, input.evidenceId,
            input.sourceEvidenceId, input.oldSharedCategoryId, input.oldSharedCategoryVersion,
            input.originalOzonTaskId, input.correlationId, claimedAt],
        )).rows[0];
        if (!row) throw notFound();
        return attemptDto(row, { claimed: true });
      });
    },

    async saveCategoryRecoveryMatch(raw) {
      const input = transitionBase(raw, [
        "replacementSharedCategoryId", "replacementSharedCategoryVersion",
        "correctedItems", "correctedItemsHash",
      ]);
      identifier(input.replacementSharedCategoryId);
      positive(input.replacementSharedCategoryVersion);
      const items = projectOzonImportCarrier(input.correctedItems);
      if (!Array.isArray(items) || items.length < 1 || items.length > 100
        || digest(input.correctedItemsHash) !== stableHash(items)) throw invalid();
      return transaction(pool, async (client) => {
        let row = (await client.query(
          `UPDATE submission_category_recovery_attempts AS attempt
              SET status='MATCHED',corrected_items=$12::JSONB,corrected_items_hash=$13,
                  replacement_shared_category_id=$14,replacement_shared_category_version=$15,
                  updated_at=GREATEST($16::TIMESTAMPTZ,attempt.updated_at+INTERVAL '1 microsecond')
             FROM account_ozon_shared_categories AS shared,
                  collect_ozon_category_source_evidence AS source
            WHERE attempt.account_id=$1 AND attempt.submission_job_id=$2
              AND attempt.submission_snapshot_id=$3 AND attempt.triggering_error_evidence_id=$4
              AND attempt.id=$5 AND attempt.source_evidence_id=$6
              AND attempt.old_shared_category_id=$7 AND attempt.old_shared_category_version=$8
              AND attempt.original_ozon_task_id=$9 AND attempt.correlation_id=$10
              AND attempt.status=$11
              AND shared.account_id=attempt.account_id AND shared.id=$14
              AND shared.version=$15 AND shared.status='ACTIVE'
              AND shared.source_evidence_id=attempt.source_evidence_id
              AND source.account_id=attempt.account_id AND source.id=attempt.source_evidence_id
              AND shared.source_description_category_id=source.source_description_category_id
              AND shared.source_type_id=source.source_type_id
              AND shared.taxonomy_scope=source.taxonomy_scope
           RETURNING attempt.*`,
          [input.accountId, input.jobId, input.snapshotId, input.evidenceId, input.attemptId,
            input.sourceEvidenceId, input.oldSharedCategoryId, input.oldSharedCategoryVersion,
            input.originalOzonTaskId, input.correlationId, input.expectedStatus, JSON.stringify(items),
            input.correctedItemsHash, input.replacementSharedCategoryId,
            input.replacementSharedCategoryVersion, input.transitionedAt],
        )).rows[0];
        if (!row) {
          const existing = (await client.query(
            "SELECT * FROM submission_category_recovery_attempts WHERE account_id=$1 AND id=$2 FOR SHARE",
            [input.accountId, input.attemptId],
          )).rows[0];
          if (!exactAttemptIdentity(existing, input)
            || !["MATCHED", "RETRY_PENDING", "RETRY_ACCEPTED", "SUCCEEDED"].includes(existing.status)
            || existing.corrected_items_hash !== input.correctedItemsHash
            || stableHash(projectOzonImportCarrier(existing.corrected_items)) !== input.correctedItemsHash
            || existing.replacement_shared_category_id !== input.replacementSharedCategoryId
            || Number(existing.replacement_shared_category_version) !== input.replacementSharedCategoryVersion) {
            throw conflict();
          }
          row = existing;
        }
        return matchedAttemptDto(row);
      });
    },

    async markCategoryRecoveryRetryPending(raw) {
      const input = transitionBase(raw);
      return transitionStatus(pool, input, "RETRY_PENDING");
    },

    async markCategoryRecoveryRetryAccepted(raw) {
      const input = transitionBase(raw, ["retryOzonTaskId"]);
      identifier(input.retryOzonTaskId);
      return transitionStatus(pool, input, "RETRY_ACCEPTED", {
        retryOzonTaskId: input.retryOzonTaskId, project: retryAttemptDto,
      });
    },

    async completeCategoryRecovery(raw) {
      const input = transitionBase(raw, ["retryOzonTaskId"]);
      identifier(input.retryOzonTaskId);
      return transitionStatus(pool, input, "SUCCEEDED", {
        requireRetryOzonTaskId: input.retryOzonTaskId, completedAt: input.transitionedAt,
        project: retryAttemptDto,
      });
    },

    async requireCategoryRecoveryReview(raw) {
      const keys = [
        "accountId", "jobId", "snapshotId", "evidenceId", "attemptId", "sourceEvidenceId",
        "oldSharedCategoryId", "oldSharedCategoryVersion", "originalOzonTaskId", "correlationId",
        "safeReviewCode", "transitionedAt",
      ];
      const input = exact(raw, keys);
      for (const key of keys.filter((key) => !["attemptId", "oldSharedCategoryVersion", "safeReviewCode", "transitionedAt"].includes(key))) identifier(input[key]);
      if (input.attemptId !== null) identifier(input.attemptId);
      positive(input.oldSharedCategoryVersion);
      if (typeof input.safeReviewCode !== "string" || !SAFE_CODE.test(input.safeReviewCode)) throw invalid();
      instant(input.transitionedAt);
      return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`${input.accountId}\u001f${input.jobId}`]);
        let targetAttemptId = input.attemptId;
        if (input.attemptId === null) {
          const existing = (await client.query(
            `SELECT * FROM submission_category_recovery_attempts
              WHERE account_id=$1 AND submission_job_id=$2 FOR UPDATE`,
            [input.accountId, input.jobId],
          )).rows[0];
          if (existing) {
            const identity = { ...input, attemptId: existing.id };
            if (!exactAttemptIdentity(existing, identity) || existing.status !== "NEEDS_REVIEW"
              || existing.safe_review_code !== input.safeReviewCode) throw conflict();
            return attemptDto(existing);
          }
          const eligible = (await client.query(
            `SELECT job.id
               FROM submission_category_error_evidence AS evidence
               JOIN submission_jobs AS job
                 ON job.account_id=evidence.account_id AND job.id=evidence.submission_job_id
                AND job.snapshot_id=evidence.submission_snapshot_id
               JOIN submission_snapshots AS snapshot
                 ON snapshot.account_id=evidence.account_id AND snapshot.id=evidence.submission_snapshot_id
                AND snapshot.snapshot_hash=evidence.original_snapshot_hash
                AND snapshot.items=evidence.original_items
               JOIN account_ozon_shared_categories AS shared
                 ON shared.account_id=evidence.account_id AND shared.id=evidence.old_shared_category_id
                AND shared.source_evidence_id=evidence.source_evidence_id
                AND shared.version=evidence.old_shared_category_version AND shared.status='ACTIVE'
              WHERE evidence.account_id=$1 AND evidence.submission_job_id=$2
                AND evidence.submission_snapshot_id=$3 AND evidence.id=$4
                AND evidence.source_evidence_id=$5 AND evidence.old_shared_category_id=$6
                AND evidence.old_shared_category_version=$7 AND evidence.original_ozon_task_id=$8
                AND job.status='FAILED' AND job.ozon_task_id=evidence.original_ozon_task_id
              FOR UPDATE OF job,shared`,
            [input.accountId, input.jobId, input.snapshotId, input.evidenceId,
              input.sourceEvidenceId, input.oldSharedCategoryId, input.oldSharedCategoryVersion,
              input.originalOzonTaskId],
          )).rows[0];
          if (!eligible) throw notFound();
          const itemRows = (await client.query(
            `SELECT status,product_id FROM submission_items
              WHERE job_id=$1 AND snapshot_id=$2 ORDER BY id FOR UPDATE`,
            [input.jobId, input.snapshotId],
          )).rows;
          if (!itemRows.length || itemRows.some((item) => item.status !== "FAILED"
            || (typeof item.product_id === "string" && item.product_id.trim() !== ""))) throw notFound();
          targetAttemptId = identifier(idFactory());
          const claimed = (await client.query(
            `INSERT INTO submission_category_recovery_attempts(
               id,account_id,submission_job_id,submission_snapshot_id,triggering_error_evidence_id,
               source_evidence_id,old_shared_category_id,old_shared_category_version,
               original_ozon_task_id,original_snapshot_hash,status,correlation_id,claimed_at,updated_at)
             SELECT $1,evidence.account_id,evidence.submission_job_id,evidence.submission_snapshot_id,evidence.id,
                    evidence.source_evidence_id,evidence.old_shared_category_id,evidence.old_shared_category_version,
                    evidence.original_ozon_task_id,evidence.original_snapshot_hash,'CLAIMED',$10,$11,$11
               FROM submission_category_error_evidence AS evidence
              WHERE evidence.account_id=$2 AND evidence.submission_job_id=$3
                AND evidence.submission_snapshot_id=$4 AND evidence.id=$5
                AND evidence.source_evidence_id=$6 AND evidence.old_shared_category_id=$7
                AND evidence.old_shared_category_version=$8 AND evidence.original_ozon_task_id=$9
             ON CONFLICT (account_id,submission_job_id) DO NOTHING RETURNING *`,
            [targetAttemptId, input.accountId, input.jobId, input.snapshotId, input.evidenceId,
              input.sourceEvidenceId, input.oldSharedCategoryId, input.oldSharedCategoryVersion,
              input.originalOzonTaskId, input.correlationId, input.transitionedAt],
          )).rows[0];
          if (!claimed) throw conflict();
        }
        const identity = { ...input, attemptId: targetAttemptId };
        let row = (await client.query(
          `UPDATE submission_category_recovery_attempts
              SET status='NEEDS_REVIEW',safe_review_code=$11,completed_at=$12,
                  updated_at=GREATEST($12::TIMESTAMPTZ,updated_at+INTERVAL '1 microsecond')
            WHERE account_id=$1 AND submission_job_id=$2 AND submission_snapshot_id=$3
              AND triggering_error_evidence_id=$4 AND id=$5 AND source_evidence_id=$6
              AND old_shared_category_id=$7 AND old_shared_category_version=$8
              AND original_ozon_task_id=$9 AND correlation_id=$10
              AND status IN ('CLAIMED','MATCHED','RETRY_PENDING','RETRY_ACCEPTED') RETURNING *`,
          [input.accountId, input.jobId, input.snapshotId, input.evidenceId, targetAttemptId,
            input.sourceEvidenceId, input.oldSharedCategoryId, input.oldSharedCategoryVersion,
            input.originalOzonTaskId, input.correlationId, input.safeReviewCode, input.transitionedAt],
        )).rows[0];
        if (!row) {
          const existing = (await client.query(
            "SELECT * FROM submission_category_recovery_attempts WHERE account_id=$1 AND id=$2 FOR SHARE",
            [input.accountId, targetAttemptId],
          )).rows[0];
          if (!exactAttemptIdentity(existing, identity) || existing.status !== "NEEDS_REVIEW"
            || existing.safe_review_code !== input.safeReviewCode) throw conflict();
          row = existing;
        }
        return attemptDto(row);
      });
    },
  });
}

async function transitionStatus(pool, input, toStatus, extras = {}) {
  return transaction(pool, async (client) => {
    let row = (await client.query(
      `UPDATE submission_category_recovery_attempts
          SET status=$12,
              retry_ozon_task_id=CASE WHEN $13::TEXT IS NULL THEN retry_ozon_task_id ELSE $13 END,
              completed_at=CASE WHEN $14::TIMESTAMPTZ IS NULL THEN completed_at ELSE $14 END,
              updated_at=GREATEST($15::TIMESTAMPTZ,updated_at+INTERVAL '1 microsecond')
        WHERE account_id=$1 AND submission_job_id=$2 AND submission_snapshot_id=$3
          AND triggering_error_evidence_id=$4 AND id=$5 AND source_evidence_id=$6
          AND old_shared_category_id=$7 AND old_shared_category_version=$8
          AND original_ozon_task_id=$9 AND correlation_id=$10 AND status=$11
          AND ($16::TEXT IS NULL OR retry_ozon_task_id=$16)
        RETURNING *`,
      [input.accountId, input.jobId, input.snapshotId, input.evidenceId, input.attemptId,
        input.sourceEvidenceId, input.oldSharedCategoryId, input.oldSharedCategoryVersion,
        input.originalOzonTaskId, input.correlationId, input.expectedStatus, toStatus,
        extras.retryOzonTaskId || null, extras.completedAt || null, input.transitionedAt,
        extras.requireRetryOzonTaskId || null],
    )).rows[0];
    if (!row) {
      const existing = (await client.query(
        "SELECT * FROM submission_category_recovery_attempts WHERE account_id=$1 AND id=$2 FOR SHARE",
        [input.accountId, input.attemptId],
      )).rows[0];
      const allowedReplay = toStatus === "RETRY_PENDING"
        ? ["RETRY_PENDING", "RETRY_ACCEPTED", "SUCCEEDED"].includes(existing?.status)
        : toStatus === "RETRY_ACCEPTED"
          ? ["RETRY_ACCEPTED", "SUCCEEDED"].includes(existing?.status)
            && existing.retry_ozon_task_id === extras.retryOzonTaskId
          : toStatus === "SUCCEEDED" && existing?.status === "SUCCEEDED"
            && existing.retry_ozon_task_id === extras.requireRetryOzonTaskId;
      if (!exactAttemptIdentity(existing, input) || !allowedReplay) throw conflict();
      row = existing;
    }
    return (extras.project || attemptDto)(row);
  });
}
