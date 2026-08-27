import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const STATEMENT_TIMEOUT_MS = 25_000;
const LOCK_TIMEOUT_MS = 5_000;
const IDLE_TRANSACTION_TIMEOUT_MS = 30_000;

function repositoryError(code, status = 422, retryable = false) {
  const error = new Error("自动上架结果核对数据操作失败");
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

const invalid = () => repositoryError("AUTO_LISTING_RECONCILE_INVALID");
const failed = () => repositoryError("AUTO_LISTING_RECONCILE_DATABASE_FAILED", 503, true);
const conflict = () => repositoryError("AUTO_LISTING_RECONCILE_VERSION_CONFLICT", 409, true);
const notFound = () => repositoryError("AUTO_LISTING_RECONCILE_NOT_FOUND", 404);
const leaseLost = () => repositoryError("AUTO_LISTING_RECONCILE_LEASE_LOST", 409, true);
const adminConflict = () => repositoryError("AUTO_LISTING_RECONCILE_ADMIN_CONFLICT", 409);
const adminNotRecoverable = () => repositoryError("AUTO_LISTING_RECONCILE_ADMIN_NOT_RECOVERABLE", 409);
const adminNotFound = () => repositoryError("AUTO_LISTING_RECONCILE_ADMIN_NOT_FOUND", 404);

function ownCode(error) {
  try {
    if (!error || (typeof error !== "object" && typeof error !== "function")) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string"
      ? descriptor.value : null;
  } catch { return null; }
}

function plain(value) {
  try { return value !== null && typeof value === "object" && !utilTypes.isProxy(value) && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype; } catch { return false; }
}

function closed(raw, keys) {
  try {
    if (!plain(raw)) throw invalid();
    const own = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (ownCode(error) === "AUTO_LISTING_RECONCILE_INVALID") throw error;
    throw invalid();
  }
}

function identifier(value) {
  return typeof value === "string" && SAFE_ID.test(value.trim()) ? value.trim() : null;
}

function code(value) {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : null;
}

function hasRejectedOzonRichContent(response) {
  try {
    if (!plain(response)) return false;
    const rawResponse = response.rawResponse;
    if (!plain(rawResponse) || !Array.isArray(rawResponse.errors)) return false;
    return rawResponse.errors.some((entry) => plain(entry)
      && entry.code === "erased_attribute_value"
      && Number(entry.attribute_id) === 11254);
  } catch {
    return false;
  }
}

function digestId(prefix, value) {
  return `${prefix}-${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function recoveryCommand(raw) {
  const value = closed(raw, new Set([
    "accountId", "actorId", "taskId", "reason", "idempotencyKey", "correlationId",
  ]));
  for (const key of ["accountId", "actorId", "taskId", "idempotencyKey", "correlationId"]) {
    if (!identifier(value[key])) throw invalid();
  }
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (!reason || Buffer.byteLength(reason, "utf8") > 500 || value.accountId !== value.actorId) throw invalid();
  return { ...value, reason };
}

function recoveryRequestHash(input) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ taskId: input.taskId, reason: input.reason }), "utf8")
    .digest("hex");
}

async function safeQuery(client, sql, values = []) {
  try { return await client.query(sql, values); } catch (error) {
    if (ownCode(error)?.startsWith("AUTO_LISTING_RECONCILE_")) throw error;
    throw failed();
  }
}

async function configure(client) {
  await safeQuery(client,
    `SELECT set_config('statement_timeout',$1,TRUE),
            set_config('lock_timeout',$2,TRUE),
            set_config('idle_in_transaction_session_timeout',$3,TRUE)`,
    [String(STATEMENT_TIMEOUT_MS), String(LOCK_TIMEOUT_MS), String(IDLE_TRANSACTION_TIMEOUT_MS)]);
}

async function transaction(pool, work, { readOnly = false } = {}) {
  let client;
  try {
    client = await pool.connect();
    await safeQuery(client, readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    await configure(client);
    const result = await work(client);
    await safeQuery(client, "COMMIT");
    return result;
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    if (ownCode(error)?.startsWith("AUTO_LISTING_RECONCILE_")) throw error;
    throw failed();
  } finally {
    try { client?.release(); } catch {}
  }
}

function exactEvidence(value) {
  if (!plain(value)) throw invalid();
  const allowed = new Set(["itemStatus", "linkStatus"]);
  const result = closed(value, allowed);
  if (!code(result.itemStatus) || !code(result.linkStatus)) throw invalid();
  return result;
}

function nullableText(value) {
  return value === null || (typeof value === "string" && value.length >= 1 && value.length <= 240)
    ? value : undefined;
}

function safeSummary(raw) {
  try {
    if (utilTypes.isProxy(raw)) throw invalid();
    const rawDescriptors = Object.getOwnPropertyDescriptors(raw);
    const hasCategoryRecovery = Object.hasOwn(rawDescriptors, "categoryRecovery");
    const summaryKeys = new Set(["submissionJobId", "ozonTaskId", "counts", "variants",
      ...(hasCategoryRecovery ? ["categoryRecovery"] : [])]);
    const value = closed(raw, summaryKeys);
    if (!identifier(value.submissionJobId) || nullableText(value.ozonTaskId) === undefined
      || !Array.isArray(value.variants) || value.variants.length > 100) throw invalid();
    const counts = closed(value.counts, new Set(["success", "failed", "skipped", "stockCount"]));
    if (Object.values(counts).some((entry) => !Number.isSafeInteger(entry) || entry < 0
      || entry > 2_147_483_647)) throw invalid();
    const variants = value.variants.map((entry) => {
      const variant = closed(entry, new Set(["offerId", "status", "productId", "errorCode"]));
      if (nullableText(variant.offerId) === undefined || !code(variant.status)
        || nullableText(variant.productId) === undefined || nullableText(variant.errorCode) === undefined
        || (variant.errorCode !== null && !code(variant.errorCode))) throw invalid();
      return variant;
    });
    let categoryRecovery = null;
    if (hasCategoryRecovery && value.categoryRecovery !== null) {
      categoryRecovery = closed(value.categoryRecovery, new Set([
        "attemptId", "status", "originalOzonTaskId", "retryOzonTaskId",
        "oldSharedCategoryVersion", "replacementSharedCategoryVersion",
      ]));
      const oldVersion = categoryRecovery.oldSharedCategoryVersion;
      const replacementVersion = categoryRecovery.replacementSharedCategoryVersion;
      const retryTask = categoryRecovery.retryOzonTaskId;
      const replacementValid = Number.isSafeInteger(replacementVersion) && replacementVersion > oldVersion;
      const retryValid = Boolean(identifier(retryTask))
        && retryTask !== categoryRecovery.originalOzonTaskId;
      const shapeValid = categoryRecovery.status === "CLAIMED"
        ? retryTask === null && replacementVersion === null
        : ["MATCHED", "RETRY_PENDING"].includes(categoryRecovery.status)
          ? retryTask === null && replacementValid
          : ["RETRY_ACCEPTED", "SUCCEEDED"].includes(categoryRecovery.status)
            ? retryValid && replacementValid
            : categoryRecovery.status === "NEEDS_REVIEW"
              && ((retryTask === null && (replacementVersion === null || replacementValid))
                || (retryValid && replacementValid));
      if (!identifier(categoryRecovery.attemptId) || !identifier(categoryRecovery.originalOzonTaskId)
        || !shapeValid || !Number.isSafeInteger(oldVersion) || oldVersion < 1
        || value.ozonTaskId !== (retryTask || categoryRecovery.originalOzonTaskId)) throw invalid();
    }
    return { submissionJobId: value.submissionJobId, ozonTaskId: value.ozonTaskId, counts, variants,
      ...(hasCategoryRecovery ? { categoryRecovery } : {}) };
  } catch (error) {
    if (ownCode(error) === "AUTO_LISTING_RECONCILE_INVALID") throw error;
    throw invalid();
  }
}

function leaseCommand(raw, type) {
  const keys = type === "complete"
    ? new Set(["accountId", "taskId", "leaseToken", "correlationId", "evidence"])
    : new Set(["accountId", "taskId", "leaseToken", "correlationId", "errorCode", "evidence",
      ...(type === "reschedule" ? ["delayMs"] : [])]);
  const value = closed(raw, keys);
  for (const key of ["accountId", "taskId", "leaseToken", "correlationId"]) {
    if (!identifier(value[key])) throw invalid();
  }
  if (type !== "complete" && value.errorCode !== null && !code(value.errorCode)) throw invalid();
  if (type === "reschedule" && (!Number.isSafeInteger(value.delayMs) || value.delayMs < 100
    || value.delayMs > 86_400_000)) throw invalid();
  const evidence = plain(value.evidence) && Reflect.ownKeys(value.evidence).length === 0
    ? {} : exactEvidence(value.evidence);
  return { ...value, evidence };
}

function reconcileRequest(raw) {
  const value = closed(raw, new Set(["accountId", "itemId", "submissionLinkId", "correlationId"]));
  if (![value.accountId, value.itemId, value.submissionLinkId, value.correlationId].every(identifier)) throw invalid();
  return value;
}

function applyCommand(raw) {
  const keys = new Set([
    "accountId", "jobId", "itemId", "submissionLinkId", "submissionJobId", "correlationId",
    "expectedItemStatus", "expectedItemStatusVersion", "expectedLinkStatus", "itemStatus", "linkStatus",
    "failureCode", "summary", "advanceItemVersion", "enqueueNextCheck", "allowResubmission",
    "resolveReconciliationBlock",
  ]);
  const value = closed(raw, keys);
  for (const key of ["accountId", "jobId", "itemId", "submissionLinkId", "submissionJobId", "correlationId"]) {
    if (!identifier(value[key])) throw invalid();
  }
  for (const key of ["expectedItemStatus", "expectedLinkStatus", "itemStatus", "linkStatus"]) {
    if (!code(value[key])) throw invalid();
  }
  if ((value.failureCode !== null && !code(value.failureCode))
    || !Number.isSafeInteger(value.expectedItemStatusVersion) || value.expectedItemStatusVersion < 1
    || value.expectedItemStatusVersion >= 2_147_483_647
    || !["advanceItemVersion", "enqueueNextCheck", "allowResubmission", "resolveReconciliationBlock"]
      .every((key) => typeof value[key] === "boolean")) throw invalid();
  value.summary = safeSummary(value.summary);
  if (value.summary.submissionJobId !== value.submissionJobId
    || JSON.stringify(value.summary).length > 32_768) throw invalid();
  return value;
}

function taskFromRow(row) {
  return Object.freeze({
    taskId: row.task_id, accountId: row.account_id, jobId: row.job_id,
    itemId: row.item_id, submissionLinkId: row.submission_link_id,
    submissionJobId: row.submission_job_id, leaseToken: row.lease_token,
    attemptCount: Number(row.attempt_count),
  });
}

function terminalJobStatus(row) {
  const counts = {
    total: Number(row?.total_count),
    terminal: Number(row?.terminal_count),
    succeeded: Number(row?.succeeded_count),
    blocked: Number(row?.blocked_count),
    cancelled: Number(row?.cancelled_count),
  };
  if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)
    || counts.total < 1 || counts.terminal > counts.total
    || counts.succeeded + counts.blocked + counts.cancelled !== counts.terminal) throw failed();
  if (counts.terminal !== counts.total) return { status: null, counts };
  if (counts.succeeded === counts.total) return { status: "SUCCEEDED", counts };
  if (counts.cancelled === counts.total) return { status: "CANCELLED", counts };
  if (counts.blocked === counts.total || counts.succeeded === 0) return { status: "BLOCKED", counts };
  return { status: "PARTIAL_SUCCESS", counts };
}

export function createPostgresAutoListingSubmissionReconciliationRepository(options = {}) {
  let value;
  try {
    if (!plain(options)) throw invalid();
    const keys = Reflect.ownKeys(options);
    const descriptors = Object.getOwnPropertyDescriptors(options);
    if (!keys.includes("pool") || keys.some((key) => typeof key !== "string"
      || !["pool", "idFactory"].includes(key) || descriptors[key]?.enumerable !== true
      || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    value = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (ownCode(error) === "AUTO_LISTING_RECONCILE_INVALID") throw error;
    throw invalid();
  }
  if (Object.keys(value).some((key) => !["pool", "idFactory"].includes(key))
    || typeof value.pool?.connect !== "function" || typeof value.pool?.query !== "function"
    || (value.idFactory !== undefined && typeof value.idFactory !== "function")) throw invalid();
  const pool = value.pool;
  const idFactory = value.idFactory || ((kind, seed) => digestId(`reconcile_${kind}`, seed));

  async function loadReconciliationEvidence(raw) {
    const input = reconcileRequest(raw);
    return transaction(pool, async (client) => {
    const result = await safeQuery(client,
      `SELECT link.account_id,item.job_id,item.id AS item_id,item.status AS item_status,
              item.status_version AS item_status_version,item.failure_code,
              link.id AS submission_link_id,link.status AS submission_link_status,
              link.submission_job_id,submission.status AS submission_status,
              submission.ozon_task_id,submission.error_code AS submission_error_code,
              submission.success_count,submission.failed_count,submission.skipped_count,
              submission.result_summary,
              recovery.id AS recovery_attempt_id,recovery.status AS recovery_status,
              recovery.original_ozon_task_id AS recovery_original_ozon_task_id,
              recovery.retry_ozon_task_id AS recovery_retry_ozon_task_id,
              recovery.old_shared_category_version AS recovery_old_shared_category_version,
              recovery.replacement_shared_category_version AS recovery_replacement_shared_category_version
         FROM auto_listing_submission_links AS link
         JOIN auto_listing_job_items AS item
           ON item.account_id=link.account_id AND item.job_id=link.job_id
          AND item.id=link.auto_listing_item_id
         JOIN submission_jobs AS submission
           ON submission.account_id=link.account_id AND submission.id=link.submission_job_id
         LEFT JOIN submission_category_recovery_attempts AS recovery
           ON recovery.account_id=submission.account_id
          AND recovery.submission_job_id=submission.id
          AND recovery.submission_snapshot_id=submission.snapshot_id
        WHERE link.account_id=$1 AND link.auto_listing_item_id=$2 AND link.id=$3
          AND link.submission_job_id IS NOT NULL`,
      [input.accountId, input.itemId, input.submissionLinkId]);
    if (result?.rowCount !== 1) throw notFound();
    const row = result.rows[0];
    const items = await safeQuery(client,
      `SELECT item.offer_id,
              CASE WHEN child.id IS NULL THEN item.status ELSE child.status END AS status,
              CASE WHEN child.id IS NULL THEN item.product_id ELSE child.product_id END AS product_id,
              CASE WHEN child.id IS NULL THEN item.error_code ELSE NULL END AS error_code,
              CASE WHEN child.id IS NULL THEN item.response ELSE '{}'::jsonb END AS response
         FROM submission_items AS item
         JOIN submission_jobs AS submission ON submission.id=item.job_id
         LEFT JOIN submission_category_recovery_item_results AS child
           ON child.account_id=submission.account_id
          AND child.submission_job_id=submission.id
          AND child.submission_snapshot_id=submission.snapshot_id
          AND child.recovery_attempt_id=$3
          AND child.retry_ozon_task_id=$4
          AND child.submission_item_id=item.id
          AND child.offer_id=item.offer_id
        WHERE submission.account_id=$1 AND submission.id=$2
        ORDER BY item.sort_order,item.id
        LIMIT 101`,
      [input.accountId, row.submission_job_id, row.recovery_attempt_id, row.recovery_retry_ozon_task_id]);
    return Object.freeze({
      accountId: row.account_id, jobId: row.job_id, itemId: row.item_id,
      itemStatus: row.item_status, itemStatusVersion: Number(row.item_status_version),
      failureCode: row.failure_code || null,
      submissionLinkId: row.submission_link_id, submissionLinkStatus: row.submission_link_status,
      submissionJobId: row.submission_job_id,
      submission: Object.freeze({
        id: row.submission_job_id, accountId: row.account_id, status: row.submission_status,
        ozonTaskId: row.ozon_task_id || null, errorCode: row.submission_error_code || null,
        successCount: Number(row.success_count || 0), failedCount: Number(row.failed_count || 0),
        skippedCount: Number(row.skipped_count || 0), resultSummary: row.result_summary || {},
        categoryRecovery: row.recovery_attempt_id ? Object.freeze({
          attemptId: row.recovery_attempt_id, status: row.recovery_status,
          originalOzonTaskId: row.recovery_original_ozon_task_id,
          retryOzonTaskId: row.recovery_retry_ozon_task_id,
          oldSharedCategoryVersion: Number(row.recovery_old_shared_category_version),
          replacementSharedCategoryVersion: row.recovery_replacement_shared_category_version === null
            ? null : Number(row.recovery_replacement_shared_category_version),
        }) : null,
        items: (items.rows || []).map((entry) => ({
          offerId: entry.offer_id || null, status: entry.status, productId: entry.product_id || null,
          errorCode: hasRejectedOzonRichContent(entry.response)
            ? "OZON_RICH_CONTENT_REJECTED" : entry.error_code || null,
        })),
      }),
    });
    }, { readOnly: true });
  }

  async function applyReconciliation(raw) {
    const input = applyCommand(raw);
    return transaction(pool, async (client) => {
      const parent = await safeQuery(client,
        `SELECT id,status FROM auto_listing_jobs
          WHERE account_id=$1 AND id=$2
          FOR UPDATE`,
        [input.accountId, input.jobId]);
      const parentRow = parent?.rowCount === 1 ? parent.rows[0] : null;
      if (!parentRow) throw notFound();
      const parentStatus = code(parentRow.status);
      if (!parentStatus) throw failed();
      const locked = await safeQuery(client,
        `SELECT item.status AS item_status,item.status_version AS item_status_version,
                link.status AS link_status,link.submission_job_id
           FROM auto_listing_job_items AS item
           JOIN auto_listing_submission_links AS link
             ON link.account_id=item.account_id AND link.job_id=item.job_id
            AND link.auto_listing_item_id=item.id
          WHERE item.account_id=$1 AND item.job_id=$2 AND item.id=$3 AND link.id=$4
            AND link.submission_job_id=$5
          FOR UPDATE OF item,link`,
        [input.accountId, input.jobId, input.itemId, input.submissionLinkId, input.submissionJobId]);
      const row = locked?.rowCount === 1 ? locked.rows[0] : null;
      if (!row) throw notFound();
      const replay = row.item_status === input.itemStatus && row.link_status === input.linkStatus;
      if (row.item_status !== input.expectedItemStatus
        || Number(row.item_status_version) !== input.expectedItemStatusVersion
        || row.link_status !== input.expectedLinkStatus) {
        if (replay) return Object.freeze({ itemId: input.itemId, status: row.item_status,
          statusVersion: Number(row.item_status_version), linkStatus: row.link_status, duplicate: true });
        throw conflict();
      }
      let statusVersion = input.expectedItemStatusVersion;
      if (input.advanceItemVersion) {
        statusVersion += 1;
        const updated = await safeQuery(client,
          `UPDATE auto_listing_job_items
              SET status=$4,status_version=$5,failure_code=$6,failure_detail_safe=NULL,updated_at=NOW()
            WHERE account_id=$1 AND job_id=$2 AND id=$3
              AND status=$7 AND status_version=$8
            RETURNING status,status_version`,
          [input.accountId, input.jobId, input.itemId, input.itemStatus, statusVersion,
            input.failureCode, input.expectedItemStatus, input.expectedItemStatusVersion]);
        if (updated?.rowCount !== 1) throw conflict();
      }
      if (row.link_status !== input.linkStatus) {
        const updated = await safeQuery(client,
          `UPDATE auto_listing_submission_links
              SET status=$4,updated_at=NOW()
            WHERE account_id=$1 AND auto_listing_item_id=$2 AND id=$3 AND status=$5
            RETURNING status`,
          [input.accountId, input.itemId, input.submissionLinkId, input.linkStatus, input.expectedLinkStatus]);
        if (updated?.rowCount !== 1) throw conflict();
      }
      if (input.advanceItemVersion || row.link_status !== input.linkStatus) {
        const eventId = idFactory("event", [input.accountId, input.submissionLinkId,
          input.correlationId, statusVersion, input.linkStatus].join(":"));
        if (!identifier(eventId)) throw invalid();
        await safeQuery(client,
          `INSERT INTO auto_listing_events
            (id,account_id,job_id,item_id,from_status,to_status,event_type,correlation_id,
             details,transition_version)
           VALUES ($1,$2,$3,$4,$5,$6,'OZON_SUBMISSION_RECONCILED',$7,$8::jsonb,$9)
           ON CONFLICT (id) DO NOTHING`,
          [eventId, input.accountId, input.jobId, input.itemId, input.expectedItemStatus,
            input.itemStatus, input.correlationId, JSON.stringify({
              submissionLinkId: input.submissionLinkId,
              submissionJobId: input.submissionJobId,
              linkStatus: input.linkStatus,
              failureCode: input.failureCode,
              allowResubmission: input.allowResubmission,
              reconciliationResolved: input.resolveReconciliationBlock,
              summary: input.summary,
            }), input.advanceItemVersion ? statusVersion : null]);
      }
      const aggregate = await safeQuery(client,
        `SELECT COUNT(*)::INTEGER AS total_count,
                COUNT(*) FILTER (WHERE status IN ('SUCCEEDED','BLOCKED','CANCELLED'))::INTEGER AS terminal_count,
                COUNT(*) FILTER (WHERE status='SUCCEEDED')::INTEGER AS succeeded_count,
                COUNT(*) FILTER (WHERE status='BLOCKED')::INTEGER AS blocked_count,
                COUNT(*) FILTER (WHERE status='CANCELLED')::INTEGER AS cancelled_count
           FROM auto_listing_job_items
          WHERE account_id=$1 AND job_id=$2`,
        [input.accountId, input.jobId]);
      const parentAggregate = terminalJobStatus(aggregate?.rows?.[0]);
      if (parentAggregate.status && parentAggregate.status !== parentStatus) {
        const parentUpdated = await safeQuery(client,
          `UPDATE auto_listing_jobs
              SET status=$3,updated_at=NOW()
            WHERE account_id=$1 AND id=$2 AND status=$4
            RETURNING status`,
          [input.accountId, input.jobId, parentAggregate.status, parentStatus]);
        if (parentUpdated?.rowCount !== 1) throw conflict();
        const eventId = idFactory("job_event", [input.accountId, input.jobId, input.correlationId,
          parentStatus, parentAggregate.status].join(":"));
        if (!identifier(eventId)) throw invalid();
        await safeQuery(client,
          `INSERT INTO auto_listing_events
            (id,account_id,job_id,item_id,from_status,to_status,event_type,correlation_id,details)
           VALUES ($1,$2,$3,NULL,$4,$5,'AUTO_LISTING_JOB_AGGREGATED',$6,$7::jsonb)`,
          [eventId, input.accountId, input.jobId, parentStatus, parentAggregate.status,
            input.correlationId, JSON.stringify({ counts: parentAggregate.counts })]);
      }
      return Object.freeze({ itemId: input.itemId, status: input.itemStatus, statusVersion,
        linkStatus: input.linkStatus, duplicate: false });
    });
  }

  async function enqueue(raw) {
    const input = closed(raw, new Set(["accountId", "jobId", "itemId", "submissionLinkId",
      "submissionJobId", "correlationId"]));
    if (![input.accountId, input.jobId, input.itemId, input.submissionLinkId,
      input.submissionJobId, input.correlationId].every(identifier)) throw invalid();
    return transaction(pool, async (client) => {
      const taskId = idFactory("task", [input.accountId, input.submissionLinkId].join(":"));
      if (!identifier(taskId)) throw invalid();
      const inserted = await safeQuery(client,
        `INSERT INTO auto_listing_submission_reconcile_tasks
          (id,account_id,job_id,auto_listing_item_id,submission_link_id,submission_job_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (account_id,submission_link_id) DO NOTHING
         RETURNING id,state`,
        [taskId, input.accountId, input.jobId, input.itemId, input.submissionLinkId, input.submissionJobId]);
      if (inserted?.rowCount === 1) {
        await safeQuery(client,
          `INSERT INTO auto_listing_submission_reconcile_events
            (account_id,reconcile_task_id,event_type,to_state,attempt_count,correlation_id,evidence)
           VALUES ($1,$2,'CREATED','PENDING',0,$3,'{}'::jsonb)`,
          [input.accountId, taskId, input.correlationId]);
        return Object.freeze({ taskId, duplicate: false });
      }
      const existing = await safeQuery(client,
        `SELECT id,job_id,auto_listing_item_id,submission_job_id
           FROM auto_listing_submission_reconcile_tasks
          WHERE account_id=$1 AND submission_link_id=$2
          FOR SHARE`,
        [input.accountId, input.submissionLinkId]);
      const row = existing?.rowCount === 1 ? existing.rows[0] : null;
      if (!row || row.job_id !== input.jobId || row.auto_listing_item_id !== input.itemId
        || row.submission_job_id !== input.submissionJobId || !identifier(row.id)) throw conflict();
      return Object.freeze({ taskId: row.id, duplicate: true });
    });
  }

  async function leaseNext(raw) {
    const input = closed(raw, new Set(["workerId", "leaseMs"]));
    if (!identifier(input.workerId) || !Number.isSafeInteger(input.leaseMs)
      || input.leaseMs < 1_000 || input.leaseMs > 900_000) throw invalid();
    return transaction(pool, async (client) => {
      const token = idFactory("lease", `${input.workerId}:${crypto.randomUUID()}`);
      if (!identifier(token)) throw invalid();
      await safeQuery(client,
        `WITH exhausted_candidate AS (
           SELECT account_id,id,state,attempt_count
             FROM auto_listing_submission_reconcile_tasks
            WHERE attempt_count>=1000
              AND ((state='PENDING' AND next_run_at<=NOW())
                OR (state='LEASED' AND lease_expires_at<=NOW()))
            ORDER BY next_run_at,created_at,id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         ), exhausted AS (
           UPDATE auto_listing_submission_reconcile_tasks AS task
              SET state='DEAD',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
                  last_error_code='AUTO_LISTING_RECONCILE_ATTEMPT_LIMIT_REACHED',updated_at=NOW()
             FROM exhausted_candidate AS candidate
            WHERE task.account_id=candidate.account_id AND task.id=candidate.id
            RETURNING task.account_id,task.id,task.attempt_count,candidate.state AS from_state
         )
         INSERT INTO auto_listing_submission_reconcile_events
           (account_id,reconcile_task_id,event_type,from_state,to_state,attempt_count,
            error_code,correlation_id,evidence)
         SELECT account_id,id,'DEAD',from_state,'DEAD',attempt_count,
                'AUTO_LISTING_RECONCILE_ATTEMPT_LIMIT_REACHED',id || ':' || attempt_count,
                '{"reason":"ATTEMPT_LIMIT"}'::jsonb
           FROM exhausted`);
      const leased = await safeQuery(client,
        `WITH candidate AS (
           SELECT account_id,id,state
             FROM auto_listing_submission_reconcile_tasks
            WHERE attempt_count<1000
              AND ((state='PENDING' AND next_run_at<=NOW())
                OR (state='LEASED' AND lease_expires_at<=NOW()))
            ORDER BY next_run_at,created_at,id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE auto_listing_submission_reconcile_tasks AS task
            SET state='LEASED',attempt_count=task.attempt_count+1,
                lease_owner=$1,lease_token=$2,
                lease_expires_at=NOW()+($3 * INTERVAL '1 millisecond'),updated_at=NOW()
           FROM candidate
          WHERE task.account_id=candidate.account_id AND task.id=candidate.id
            AND task.attempt_count<1000
         RETURNING task.id AS task_id,task.account_id,task.job_id,
                   task.auto_listing_item_id AS item_id,task.submission_link_id,
                   task.submission_job_id,task.lease_token,task.attempt_count,candidate.state AS from_state`,
        [input.workerId, token, input.leaseMs]);
      if (leased?.rowCount !== 1) return null;
      const row = leased.rows[0];
      await safeQuery(client,
        `INSERT INTO auto_listing_submission_reconcile_events
          (account_id,reconcile_task_id,event_type,from_state,to_state,attempt_count,correlation_id,evidence)
         VALUES ($1,$2,'LEASED',$3,'LEASED',$4,$5,'{}'::jsonb)`,
        [row.account_id, row.task_id, row.from_state, row.attempt_count, `${row.task_id}:${row.attempt_count}`]);
      return taskFromRow(row);
    });
  }

  async function reopenDeadTask(raw) {
    const input = recoveryCommand(raw);
    const requestHash = recoveryRequestHash(input);
    const auditEventId = digestId("audit_auto_listing_reconcile_recovery",
      `${input.accountId}\0${input.idempotencyKey}`);
    if (!identifier(auditEventId)) throw invalid();
    return transaction(pool, async (client) => {
      const account = await safeQuery(client,
        `SELECT id,role FROM accounts WHERE id=$1 FOR UPDATE`, [input.accountId]);
      if (account?.rowCount !== 1 || account.rows[0]?.id !== input.accountId
        || account.rows[0]?.role !== "admin") throw adminNotFound();

      const replay = await safeQuery(client,
        `SELECT metadata FROM audit_events
          WHERE event_id=$1 AND account_id=$2
            AND action='AUTO_LISTING_RECONCILIATION_TASK_RECOVERED'
          FOR UPDATE`, [auditEventId, input.accountId]);
      if (replay?.rowCount === 1) {
        const metadata = replay.rows[0]?.metadata;
        if (!plain(metadata) || metadata.requestHash !== requestHash || metadata.taskId !== input.taskId
          || !Number.isSafeInteger(metadata.recoveryCount) || metadata.recoveryCount < 1) {
          throw adminConflict();
        }
        const current = await safeQuery(client,
          `SELECT id,account_id,recovery_count
             FROM auto_listing_submission_reconcile_tasks
            WHERE account_id=$1 AND id=$2`, [input.accountId, input.taskId]);
        const currentRow = current?.rowCount === 1 ? current.rows[0] : null;
        if (!currentRow || Number(currentRow.recovery_count) < metadata.recoveryCount) throw adminConflict();
        return Object.freeze({ accountId: currentRow.account_id, taskId: currentRow.id,
          state: "PENDING", recoveryCount: metadata.recoveryCount, duplicate: true });
      }
      if (replay?.rowCount !== 0) throw failed();

      const locked = await safeQuery(client,
        `SELECT task.id,task.account_id,task.job_id,task.auto_listing_item_id,
                task.submission_link_id,task.submission_job_id,task.state,task.recovery_count
           FROM auto_listing_submission_reconcile_tasks AS task
           JOIN auto_listing_submission_links AS link
             ON link.account_id=task.account_id AND link.job_id=task.job_id
            AND link.auto_listing_item_id=task.auto_listing_item_id
            AND link.id=task.submission_link_id AND link.submission_job_id=task.submission_job_id
           JOIN submission_jobs AS submission
             ON submission.account_id=task.account_id AND submission.id=task.submission_job_id
          WHERE task.account_id=$1 AND task.id=$2
          FOR UPDATE OF task`, [input.accountId, input.taskId]);
      const task = locked?.rowCount === 1 ? locked.rows[0] : null;
      if (!task) throw adminNotFound();
      if (task.state !== "DEAD") throw adminNotRecoverable();
      const previousRecoveryCount = Number(task.recovery_count);
      if (!Number.isSafeInteger(previousRecoveryCount) || previousRecoveryCount < 0
        || previousRecoveryCount >= 1000) throw adminNotRecoverable();

      const updated = await safeQuery(client,
        `UPDATE auto_listing_submission_reconcile_tasks
            SET state='PENDING',attempt_count=0,recovery_count=recovery_count+1,
                next_run_at=NOW(),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
                last_error_code=NULL,updated_at=NOW()
          WHERE account_id=$1 AND id=$2 AND state='DEAD' AND recovery_count=$3
          RETURNING id,account_id,state,recovery_count`,
        [input.accountId, input.taskId, previousRecoveryCount]);
      const row = updated?.rowCount === 1 ? updated.rows[0] : null;
      if (!row) throw adminConflict();
      const recoveryCount = Number(row.recovery_count);
      await safeQuery(client,
        `INSERT INTO auto_listing_submission_reconcile_events
          (account_id,reconcile_task_id,event_type,from_state,to_state,attempt_count,
           error_code,correlation_id,evidence)
         VALUES ($1,$2,'RECOVERED','DEAD','PENDING',0,NULL,$3,$4::jsonb)`,
        [input.accountId, input.taskId, input.correlationId,
          JSON.stringify({ auditEventId, recoveryCount })]);
      const audit = await safeQuery(client,
        `INSERT INTO audit_events (
           event_id,account_id,store_id,action,status,actor_type,actor_id,device_id,source,
           entity_type,entity_id,correlation_id,metadata,occurred_at,created_at
         ) VALUES ($1,$2,NULL,'AUTO_LISTING_RECONCILIATION_TASK_RECOVERED','SUCCESS',
           'account',$3,'','auto-listing-reconciliation-admin',
           'auto_listing_submission_reconcile_task',$4,$5,$6::jsonb,NOW(),NOW())
         ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
         RETURNING event_id`,
        [auditEventId, input.accountId, input.actorId, input.taskId, input.correlationId,
          JSON.stringify({ requestHash, taskId: input.taskId, jobId: task.job_id,
            itemId: task.auto_listing_item_id, submissionLinkId: task.submission_link_id,
            submissionJobId: task.submission_job_id, recoveryCount, reason: input.reason })]);
      if (audit?.rowCount !== 1) throw adminConflict();
      return Object.freeze({ accountId: row.account_id, taskId: row.id, state: row.state,
        recoveryCount, duplicate: false });
    });
  }

  async function finishLease(raw, type) {
    const input = leaseCommand(raw, type);
    const state = type === "complete" ? "COMPLETED" : type === "reschedule" ? "PENDING" : "DEAD";
    const event = type === "complete" ? "COMPLETED" : type === "reschedule" ? "RESCHEDULED" : "DEAD";
    return transaction(pool, async (client) => {
      const values = [input.accountId, input.taskId, input.leaseToken,
        ...(type === "reschedule" ? [input.delayMs] : []),
        type === "complete" ? null : input.errorCode];
      const delayIndex = type === "reschedule" ? 4 : null;
      const errorIndex = type === "reschedule" ? 5 : 4;
      const updated = await safeQuery(client,
        `UPDATE auto_listing_submission_reconcile_tasks
            SET state='${state}',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
                next_run_at=${type === "reschedule" ? `NOW()+($${delayIndex} * INTERVAL '1 millisecond')` : "next_run_at"},
                last_error_code=$${errorIndex},updated_at=NOW()
          WHERE account_id=$1 AND id=$2 AND state='LEASED' AND lease_token=$3
            AND lease_expires_at>NOW()
         RETURNING id,attempt_count`, values);
      if (updated?.rowCount !== 1) throw leaseLost();
      await safeQuery(client,
        `INSERT INTO auto_listing_submission_reconcile_events
          (account_id,reconcile_task_id,event_type,from_state,to_state,attempt_count,error_code,correlation_id,evidence)
         VALUES ($1,$2,'${event}','LEASED','${state}',$3,$4,$5,$6::jsonb)`,
        [input.accountId, input.taskId, updated.rows[0].attempt_count,
          type === "complete" ? null : input.errorCode, input.correlationId, JSON.stringify(input.evidence)]);
      return true;
    });
  }

  return Object.freeze({
    loadReconciliationEvidence, applyReconciliation, enqueue, leaseNext, reopenDeadTask,
    completeLease(raw) { return finishLease(raw, "complete"); },
    rescheduleLease(raw) { return finishLease(raw, "reschedule"); },
    deadLetterLease(raw) { return finishLease(raw, "dead"); },
  });
}
