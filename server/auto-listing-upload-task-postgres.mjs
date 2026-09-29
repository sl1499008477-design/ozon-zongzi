import crypto from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const REASONS = new Set(["REVIEW_APPROVED", "DIRECT_READY", "SAFE_RETRY"]);
const OUTCOMES = new Set(["SUBMITTED", "HANDED_OFF", "STALE", "BLOCKED"]);

function taskError(code, retryable = false) {
  const error = new Error("自动上架上传任务暂时不可用");
  error.code = code;
  error.retryable = retryable;
  return error;
}

const invalid = () => taskError("AUTO_LISTING_UPLOAD_TASK_INVALID");
const conflict = () => taskError("AUTO_LISTING_UPLOAD_TASK_CONFLICT");
const failed = () => taskError("AUTO_LISTING_UPLOAD_TASK_DATABASE_FAILED", true);
const leaseLost = () => taskError("AUTO_LISTING_UPLOAD_TASK_LEASE_LOST", true);

function ownCode(error) {
  try {
    const descriptor = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : null;
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
  } catch { return null; }
}

function plain(value) {
  try { return value !== null && typeof value === "object" && !Array.isArray(value)
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
    if (ownCode(error) === "AUTO_LISTING_UPLOAD_TASK_INVALID") throw error;
    throw invalid();
  }
}

function id(value) {
  return typeof value === "string" && SAFE_ID.test(value.trim()) ? value.trim() : null;
}

function code(value) {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : null;
}

function taskId(input) {
  return `upload-task-${crypto.createHash("sha256")
    .update(`${input.accountId}\0${input.itemId}\0${input.expectedStatusVersion}`, "utf8").digest("hex")}`;
}

async function query(client, sql, values = []) {
  try { return await client.query(sql, values); } catch (error) {
    if (String(ownCode(error) || "").startsWith("AUTO_LISTING_UPLOAD_TASK_")) throw error;
    throw failed();
  }
}

async function transaction(pool, work) {
  let client;
  try {
    client = await pool.connect();
    await query(client, "BEGIN");
    await query(client,
      `SELECT set_config('statement_timeout','25000',TRUE),
              set_config('lock_timeout','5000',TRUE),
              set_config('idle_in_transaction_session_timeout','30000',TRUE)`);
    const result = await work(client);
    await query(client, "COMMIT");
    return result;
  } catch (error) {
    if (client) { try { await client.query("ROLLBACK"); } catch {} }
    if (String(ownCode(error) || "").startsWith("AUTO_LISTING_UPLOAD_TASK_")) throw error;
    throw failed();
  } finally { try { client?.release(); } catch {} }
}

function enqueueInput(raw) {
  const value = closed(raw, new Set(["client", "accountId", "jobId", "itemId", "actorAccountId",
    "expectedStatusVersion", "correlationId", "enqueueReason"]));
  if (typeof value.client?.query !== "function"
    || ![value.accountId, value.jobId, value.itemId, value.actorAccountId, value.correlationId].every(id)
    || value.actorAccountId !== value.accountId || !REASONS.has(value.enqueueReason)
    || !Number.isSafeInteger(value.expectedStatusVersion) || value.expectedStatusVersion < 1
    || value.expectedStatusVersion >= 2_147_483_647) throw invalid();
  return value;
}

export async function enqueueAutoListingUploadTask(raw = {}) {
  const input = enqueueInput(raw);
  const idValue = taskId(input);
  const result = await query(input.client,
    `WITH inserted AS (
       INSERT INTO auto_listing_upload_tasks (
         id,account_id,job_id,item_id,actor_account_id,expected_status_version,
         correlation_id,enqueue_reason,state,attempt_count,next_run_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',0,NOW())
       ON CONFLICT (account_id,item_id,expected_status_version) DO NOTHING RETURNING id
     )
     SELECT id FROM inserted
     UNION ALL
     SELECT id FROM auto_listing_upload_tasks
      WHERE id=$1 AND account_id=$2 AND job_id=$3 AND item_id=$4 AND actor_account_id=$5
        AND expected_status_version=$6 AND correlation_id=$7 AND enqueue_reason=$8
        AND NOT EXISTS (SELECT 1 FROM inserted)`,
    [idValue, input.accountId, input.jobId, input.itemId, input.actorAccountId,
      input.expectedStatusVersion, input.correlationId, input.enqueueReason]);
  if (result?.rowCount !== 1 || result.rows?.[0]?.id !== idValue) throw conflict();
  const event = await query(input.client,
    `INSERT INTO auto_listing_upload_task_events
       (account_id,upload_task_id,event_type,from_state,to_state,attempt_count,correlation_id,evidence)
     SELECT $1,$2,'CREATED',NULL,'PENDING',0,$3,$4::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM auto_listing_upload_task_events
         WHERE account_id=$1 AND upload_task_id=$2 AND event_type='CREATED'
      ) RETURNING id`,
    [input.accountId, idValue, input.correlationId,
      JSON.stringify({ enqueueReason: input.enqueueReason, expectedStatusVersion: input.expectedStatusVersion })]);
  if (![0, 1].includes(event?.rowCount)) throw conflict();
  return Object.freeze({ taskId: idValue, duplicate: event.rowCount === 0 });
}

function leaseCommand(raw) {
  const value = closed(raw, new Set(["accountId", "workerId", "leaseMs"]));
  if (!id(value.accountId) || !id(value.workerId) || !Number.isSafeInteger(value.leaseMs)
    || value.leaseMs < 1_000 || value.leaseMs > 900_000) throw invalid();
  return value;
}

function accountScan(raw) {
  const value = closed(raw, new Set(["afterAccountId", "limit"]));
  if (!(value.afterAccountId === null || id(value.afterAccountId))
    || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 1_000) throw invalid();
  return value;
}

function evidence(raw) {
  const value = closed(raw, new Set(["outcome", "code"]));
  if (!OUTCOMES.has(value.outcome) || !(value.code === null || code(value.code))) throw invalid();
  return value;
}

function finishCommand(raw, kind) {
  const keys = new Set(["accountId", "taskId", "leaseToken", "correlationId", "evidence",
    ...(kind === "reschedule" ? ["delayMs", "errorCode"] : []),
    ...(kind === "dead" ? ["errorCode"] : [])]);
  const value = closed(raw, keys);
  if (![value.accountId, value.taskId, value.leaseToken, value.correlationId].every(id)) throw invalid();
  value.evidence = evidence(value.evidence);
  if (kind !== "complete" && !code(value.errorCode)) throw invalid();
  if (kind === "reschedule" && (!Number.isSafeInteger(value.delayMs) || value.delayMs < 100
    || value.delayMs > 86_400_000)) throw invalid();
  return value;
}

function taskFrom(row) {
  return Object.freeze({
    taskId: row.id, accountId: row.account_id, jobId: row.job_id, itemId: row.item_id,
    actor: Object.freeze({ id: row.actor_account_id, role: row.actor_role }),
    expectedStatusVersion: Number(row.expected_status_version), leaseToken: row.lease_token,
    attemptCount: Number(row.attempt_count), itemStatus: row.item_status,
    itemStatusVersion: Number(row.item_status_version),
  });
}

export function createPostgresAutoListingUploadTaskRepository({ pool, randomUUID = crypto.randomUUID } = {}) {
  if (typeof pool?.connect !== "function" || typeof pool?.query !== "function" || typeof randomUUID !== "function") {
    throw new TypeError("PostgreSQL pool is required for auto-listing upload tasks");
  }
  return Object.freeze({
    async listRunnableAccounts(raw = {}) {
      const input = accountScan(raw);
      const result = await query(pool,
        `SELECT DISTINCT task.account_id
           FROM auto_listing_upload_tasks AS task
           JOIN accounts AS account ON account.id=task.account_id AND account.status='active'
          WHERE task.account_id > COALESCE($1,'')
            AND ((task.state='PENDING' AND task.next_run_at<=NOW())
              OR (task.state='LEASED' AND task.lease_expires_at<=NOW()))
          ORDER BY task.account_id LIMIT $2`,
        [input.afterAccountId, input.limit]);
      return Object.freeze((result.rows || []).map((row) => row.account_id).filter(id));
    },

    async leaseNext(raw = {}) {
      const input = leaseCommand(raw);
      return transaction(pool, async (client) => {
        const leaseToken = `upload-lease-${randomUUID()}`;
        const leased = await query(client,
          `WITH candidate AS (
             SELECT task.id,account.role AS actor_role,item.status AS item_status,
                    item.status_version AS item_status_version
               FROM auto_listing_upload_tasks AS task
               JOIN accounts AS account
                 ON account.id=task.account_id AND account.id=task.actor_account_id
                AND account.status='active'
               JOIN auto_listing_job_items AS item
                 ON item.account_id=task.account_id AND item.job_id=task.job_id AND item.id=task.item_id
              WHERE task.account_id=$1
                AND ((task.state='PENDING' AND task.next_run_at<=NOW())
                  OR (task.state='LEASED' AND task.lease_expires_at<=NOW()))
                AND NOT EXISTS (
                  SELECT 1
                    FROM auto_listing_job_items AS predecessor
                   WHERE predecessor.account_id=item.account_id
                     AND predecessor.job_id=item.job_id
                     AND predecessor.source_order < item.source_order
                     AND predecessor.status NOT IN (
                       'SUCCEEDED','RETRYABLE_ERROR','BLOCKED','CANCELLED'
                     )
                )
              ORDER BY task.next_run_at,item.source_order,task.created_at,task.id
              FOR UPDATE OF task SKIP LOCKED LIMIT 1
           ), leased AS (
             UPDATE auto_listing_upload_tasks AS task
                SET state='LEASED',attempt_count=task.attempt_count+1,lease_owner=$2,lease_token=$3,
                    lease_expires_at=NOW()+($4::BIGINT*INTERVAL '1 millisecond'),updated_at=NOW()
               FROM candidate
              WHERE task.account_id=$1 AND task.id=candidate.id
              RETURNING task.*,candidate.actor_role,candidate.item_status,candidate.item_status_version
           ) SELECT * FROM leased`,
          [input.accountId, input.workerId, leaseToken, input.leaseMs]);
        if (leased?.rowCount !== 1) return null;
        const row = leased.rows[0];
        if (!["admin", "user"].includes(row.actor_role) || row.actor_account_id !== row.account_id) throw conflict();
        await query(client,
          `INSERT INTO auto_listing_upload_task_events
             (account_id,upload_task_id,event_type,from_state,to_state,attempt_count,correlation_id,evidence)
           VALUES ($1,$2,'LEASED',$3,'LEASED',$4,$5,'{}'::jsonb)`,
          [row.account_id, row.id, row.attempt_count === 1 ? "PENDING" : "LEASED", row.attempt_count,
            `${row.id}:${row.attempt_count}`]);
        return taskFrom(row);
      });
    },

    async completeLease(raw = {}) {
      const input = finishCommand(raw, "complete");
      return transaction(pool, async (client) => {
        const updated = await query(client,
          `UPDATE auto_listing_upload_tasks
              SET state='COMPLETED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
                  outcome=$4,last_error_code=$5,updated_at=NOW()
            WHERE account_id=$1 AND id=$2 AND state='LEASED' AND lease_token=$3
            RETURNING attempt_count`,
          [input.accountId, input.taskId, input.leaseToken, input.evidence.outcome, input.evidence.code]);
        if (updated?.rowCount !== 1) throw leaseLost();
        await query(client,
          `INSERT INTO auto_listing_upload_task_events
             (account_id,upload_task_id,event_type,from_state,to_state,attempt_count,error_code,correlation_id,evidence)
           VALUES ($1,$2,'COMPLETED','LEASED','COMPLETED',$3,$4,$5,$6::jsonb)`,
          [input.accountId, input.taskId, updated.rows[0].attempt_count, input.evidence.code,
            input.correlationId, JSON.stringify(input.evidence)]);
        return true;
      });
    },

    async rescheduleLease(raw = {}) {
      const input = finishCommand(raw, "reschedule");
      return transaction(pool, async (client) => {
        const updated = await query(client,
          `UPDATE auto_listing_upload_tasks
              SET state='PENDING',next_run_at=NOW()+($4::BIGINT*INTERVAL '1 millisecond'),
                  lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error_code=$5,updated_at=NOW()
            WHERE account_id=$1 AND id=$2 AND state='LEASED' AND lease_token=$3 RETURNING attempt_count`,
          [input.accountId, input.taskId, input.leaseToken, input.delayMs, input.errorCode]);
        if (updated?.rowCount !== 1) throw leaseLost();
        await query(client,
          `INSERT INTO auto_listing_upload_task_events
             (account_id,upload_task_id,event_type,from_state,to_state,attempt_count,error_code,correlation_id,evidence)
           VALUES ($1,$2,'RESCHEDULED','LEASED','PENDING',$3,$4,$5,$6::jsonb)`,
          [input.accountId, input.taskId, updated.rows[0].attempt_count, input.errorCode,
            input.correlationId, JSON.stringify(input.evidence)]);
        return true;
      });
    },

    async deadLetterLease(raw = {}) {
      const input = finishCommand(raw, "dead");
      return transaction(pool, async (client) => {
        const locked = await query(client,
          `SELECT task.job_id,task.item_id,task.expected_status_version,task.attempt_count,item.status,item.status_version
             FROM auto_listing_upload_tasks AS task
             JOIN auto_listing_job_items AS item
               ON item.account_id=task.account_id AND item.job_id=task.job_id AND item.id=task.item_id
            WHERE task.account_id=$1 AND task.id=$2 AND task.state='LEASED' AND task.lease_token=$3
            FOR UPDATE OF task,item`,
          [input.accountId, input.taskId, input.leaseToken]);
        if (locked?.rowCount !== 1) throw leaseLost();
        const row = locked.rows[0];
        const mayBlock = (row.status === "UPLOAD_QUEUED" && Number(row.status_version) === Number(row.expected_status_version))
          || (row.status === "UPLOADING" && Number(row.status_version) === Number(row.expected_status_version) + 1);
        let nextVersion = null;
        if (mayBlock) {
          const moved = await query(client,
            `UPDATE auto_listing_job_items
                SET status='BLOCKED',status_version=status_version+1,failure_code=$4,
                    failure_detail_safe=$4,updated_at=NOW()
              WHERE account_id=$1 AND job_id=$2 AND id=$3 AND status=$5 AND status_version=$6
              RETURNING status_version`,
            [input.accountId, row.job_id, row.item_id, input.errorCode, row.status, row.status_version]);
          if (moved?.rowCount !== 1) throw conflict();
          nextVersion = Number(moved.rows[0].status_version);
          await query(client,
            `UPDATE auto_listing_submission_links
                SET status='BLOCKED',claim_token=NULL,claim_expires_at=NULL,updated_at=NOW()
              WHERE account_id=$1 AND job_id=$2 AND auto_listing_item_id=$3 AND status='RESERVED'`,
            [input.accountId, row.job_id, row.item_id]);
          await query(client,
            `INSERT INTO auto_listing_events
               (id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,
                correlation_id,details,transition_version)
             VALUES ($1,$2,$3,$4,$2,$5,'BLOCKED','UPLOAD_DISPATCH_DEAD',$6,$7::jsonb,$8)`,
            [`upload-dispatch-event-${randomUUID()}`, input.accountId, row.job_id, row.item_id, row.status,
              input.correlationId, JSON.stringify({ uploadTaskId: input.taskId, errorCode: input.errorCode }), nextVersion]);
        }
        const dead = await query(client,
          `UPDATE auto_listing_upload_tasks
              SET state='DEAD',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
                  last_error_code=$4,outcome='BLOCKED',updated_at=NOW()
            WHERE account_id=$1 AND id=$2 AND state='LEASED' AND lease_token=$3 RETURNING attempt_count`,
          [input.accountId, input.taskId, input.leaseToken, input.errorCode]);
        if (dead?.rowCount !== 1) throw leaseLost();
        await query(client,
          `INSERT INTO auto_listing_upload_task_events
             (account_id,upload_task_id,event_type,from_state,to_state,attempt_count,error_code,correlation_id,evidence)
           VALUES ($1,$2,'DEAD','LEASED','DEAD',$3,$4,$5,$6::jsonb)`,
          [input.accountId, input.taskId, dead.rows[0].attempt_count, input.errorCode,
            input.correlationId, JSON.stringify({ ...input.evidence, itemStatusVersion: nextVersion })]);
        return true;
      });
    },
  });
}
