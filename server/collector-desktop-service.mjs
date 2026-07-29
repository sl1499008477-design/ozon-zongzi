import crypto from "node:crypto";
import { getPostgresPool, postgresEnabled } from "./db/connection.mjs";
import { runMigrations } from "./db/migrate.mjs";
import { getActivePricingConfig } from "./pricing-config-service.mjs";
import { withoutCollectorScope } from "./collector-scope-sanitizer.mjs";

export const COLLECTOR_TASK_STATUSES = Object.freeze([
  "NOT_STARTED",
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export const COLLECTOR_RUN_STATUSES = Object.freeze([
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export const COLLECTOR_ITEM_STATUSES = Object.freeze([
  "DISCOVERED",
  "ENRICHED",
  "QUALIFIED",
  "FILTERED_OUT",
  "FAILED",
]);

const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const ACTIVE_RUN_STATUSES = new Set(["QUEUED", "RUNNING"]);
const TERMINAL_ITEM_STATUSES = new Set(["QUALIFIED", "FILTERED_OUT", "FAILED"]);
const TASK_TRANSITIONS = Object.freeze({
  NOT_STARTED: new Set(["QUEUED", "CANCELLED"]),
  QUEUED: new Set(["RUNNING", "FAILED", "CANCELLED"]),
  RUNNING: new Set(["COMPLETED", "FAILED", "CANCELLED"]),
  COMPLETED: new Set(["QUEUED"]),
  FAILED: new Set(["QUEUED"]),
  CANCELLED: new Set(["QUEUED"]),
});
const RUN_TRANSITIONS = Object.freeze({
  QUEUED: new Set(["RUNNING", "FAILED", "CANCELLED"]),
  RUNNING: new Set(["COMPLETED", "FAILED", "CANCELLED"]),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
});
const ITEM_TRANSITIONS = Object.freeze({
  DISCOVERED: new Set(["DISCOVERED", "ENRICHED", "QUALIFIED", "FILTERED_OUT", "FAILED"]),
  ENRICHED: new Set(["ENRICHED", "QUALIFIED", "FILTERED_OUT", "FAILED"]),
  QUALIFIED: new Set(["QUALIFIED"]),
  FILTERED_OUT: new Set(["FILTERED_OUT"]),
  FAILED: new Set(["FAILED"]),
});
const EXPORT_TRANSITIONS = Object.freeze({
  PENDING: new Set(["GENERATING", "READY", "FAILED"]),
  GENERATING: new Set(["READY", "FAILED"]),
  READY: new Set(),
  FAILED: new Set(["GENERATING"]),
});

let migrationPromise = null;

function serviceError(message, status = 400, code = "COLLECTOR_INVALID_REQUEST") {
  return Object.assign(new Error(message), { status, code });
}

function clean(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function required(value, label, max = 240) {
  const result = clean(value, max);
  if (!result) throw serviceError(`${label}必填`, 422, "COLLECTOR_FIELD_REQUIRED");
  return result;
}

function jsonObject(value, label = "JSON") {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw serviceError(`${label}必须是对象`, 422, "COLLECTOR_INVALID_JSON_OBJECT");
  }
  return value;
}

function boundedInteger(value, { label, min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null }) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== null) return fallback;
    throw serviceError(`${label}必填`, 422, "COLLECTOR_FIELD_REQUIRED");
  }
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw serviceError(`${label}必须是 ${min}–${max} 之间的整数`, 422, "COLLECTOR_INVALID_NUMBER");
  }
  return result;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function stableId(prefix, ...parts) {
  return `${prefix}_${sha256(parts.join("|")).slice(0, 28)}`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function tokenMatches(rawToken, storedHash) {
  const actual = Buffer.from(sha256(rawToken));
  const expected = Buffer.from(clean(storedHash, 64));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function normalizeStatus(value, allowed, label) {
  const result = clean(value, 80).toUpperCase();
  if (!allowed.includes(result)) {
    throw serviceError(`${label}无效`, 422, "COLLECTOR_INVALID_STATUS");
  }
  return result;
}

function readOnlyLegacyScope(row = {}) {
  const legacyScope = {};
  if (row.operating_store_id) legacyScope.operatingStoreId = row.operating_store_id;
  if (row.data_collection_store_id) legacyScope.dataCollectionStoreId = row.data_collection_store_id;
  return Object.keys(legacyScope).length ? legacyScope : null;
}

export function canTransitionCollectorTask(fromStatus, toStatus) {
  const from = clean(fromStatus, 80).toUpperCase();
  const to = clean(toStatus, 80).toUpperCase();
  return Boolean(TASK_TRANSITIONS[from]?.has(to));
}

export function canTransitionCollectorRun(fromStatus, toStatus) {
  const from = clean(fromStatus, 80).toUpperCase();
  const to = clean(toStatus, 80).toUpperCase();
  return Boolean(RUN_TRANSITIONS[from]?.has(to));
}

function assertTaskTransition(fromStatus, toStatus) {
  if (!canTransitionCollectorTask(fromStatus, toStatus)) {
    throw serviceError(`任务不能从 ${fromStatus} 变更为 ${toStatus}`, 409, "COLLECTOR_TASK_INVALID_TRANSITION");
  }
}

function assertRunTransition(fromStatus, toStatus) {
  if (!canTransitionCollectorRun(fromStatus, toStatus)) {
    throw serviceError(`运行不能从 ${fromStatus} 变更为 ${toStatus}`, 409, "COLLECTOR_RUN_INVALID_TRANSITION");
  }
}

function mapTask(row = {}) {
  const legacyScope = readOnlyLegacyScope(row);
  return {
    id: row.id || "",
    accountId: row.account_id || "",
    operatingStoreId: null,
    ...(legacyScope ? { legacyScope } : {}),
    name: row.name || "",
    taskType: row.task_type || "",
    source: row.source || "ozon",
    status: row.status || "NOT_STARTED",
    statusVersion: Number(row.status_version || 1),
    concurrency: Number(row.concurrency || 4),
    currentRunId: row.current_run_id || "",
    configuration: withoutCollectorScope(row.configuration || {}),
    lastErrorCode: row.last_error_code || "",
    lastErrorMessage: row.last_error_message || "",
    createdBy: row.created_by || "",
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    deletedAt: row.deleted_at || null,
  };
}

function mapRun(row = {}) {
  const progress = {
    totalCount: Number(row.total_count || 0),
    processedCount: Number(row.processed_count || 0),
    qualifiedCount: Number(row.qualified_count || 0),
    filteredCount: Number(row.filtered_count || 0),
    failedCount: Number(row.failed_count || 0),
  };
  const legacyScope = readOnlyLegacyScope(row);
  return {
    id: row.id || "",
    taskId: row.task_id || "",
    accountId: row.account_id || "",
    operatingStoreId: null,
    ...(legacyScope ? { legacyScope } : {}),
    pricingConfigVersionId: row.pricing_config_version_id || "",
    runNo: Number(row.run_no || 0),
    status: row.status || "QUEUED",
    statusVersion: Number(row.status_version || 1),
    idempotencyKey: row.idempotency_key || "",
    configurationSnapshot: withoutCollectorScope(row.configuration_snapshot || {}),
    claimedByDeviceId: row.claimed_by_device_id || "",
    lockExpiresAt: row.lock_expires_at || null,
    heartbeatAt: row.heartbeat_at || null,
    cancelRequestedAt: row.cancel_requested_at || null,
    cancelRequested: Boolean(row.cancel_requested_at),
    claimCount: Number(row.claim_count || 0),
    ...progress,
    progress,
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    resultSummary: withoutCollectorScope(row.result_summary || {}),
    queuedAt: row.queued_at || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapDevice(row = {}) {
  return {
    id: row.id || "",
    accountId: row.account_id || "",
    deviceKey: row.device_key || "",
    name: row.name || "",
    platform: row.platform || "",
    arch: row.arch || "",
    appVersion: row.app_version || "",
    status: row.status || "ACTIVE",
    lastSeenAt: row.last_seen_at || null,
    revokedAt: row.revoked_at || null,
    metadata: withoutCollectorScope(row.metadata || {}),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapItem(row = {}) {
  const legacyScope = readOnlyLegacyScope(row);
  return {
    id: row.id || "",
    taskId: row.task_id || "",
    runId: row.run_id || "",
    accountId: row.account_id || "",
    operatingStoreId: null,
    ...(legacyScope ? { legacyScope } : {}),
    collectItemId: row.collect_item_id || "",
    source: row.source || "ozon",
    sourceKey: row.source_key || "",
    sourceSku: row.source_sku || "",
    sourceUrl: row.source_url || "",
    sortOrder: Number(row.sort_order || 0),
    status: row.status || "DISCOVERED",
    attemptCount: Number(row.attempt_count || 1),
    rawPayload: withoutCollectorScope(row.raw_payload || {}),
    analytics: withoutCollectorScope(row.analytics || {}),
    sourcing: withoutCollectorScope(row.sourcing || {}),
    pricing: withoutCollectorScope(row.pricing || {}),
    filterResult: withoutCollectorScope(row.filter_result || {}),
    exportData: withoutCollectorScope(row.export_data || {}),
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    firstSeenAt: row.first_seen_at || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapEvent(row = {}) {
  const legacyScope = readOnlyLegacyScope(row);
  return {
    id: Number(row.id || 0),
    taskId: row.task_id || "",
    runId: row.run_id || "",
    accountId: row.account_id || "",
    operatingStoreId: null,
    ...(legacyScope ? { legacyScope } : {}),
    fromStatus: row.from_status || "",
    toStatus: row.to_status || "",
    eventType: row.event_type || "",
    level: row.level || "INFO",
    message: row.message || "",
    actorType: row.actor_type || "system",
    actorId: row.actor_id || "",
    payload: withoutCollectorScope(row.payload || {}),
    createdAt: row.created_at || null,
  };
}

function mapExport(row = {}) {
  const legacyScope = readOnlyLegacyScope(row);
  return {
    id: row.id || "",
    taskId: row.task_id || "",
    runId: row.run_id || "",
    accountId: row.account_id || "",
    operatingStoreId: null,
    ...(legacyScope ? { legacyScope } : {}),
    fileId: row.file_id || "",
    version: Number(row.version || 0),
    status: row.status || "PENDING",
    format: row.format || "xlsx",
    fileName: row.file_name || "",
    objectKey: row.object_key || "",
    contentType: row.content_type || "",
    size: Number(row.size || 0),
    sha256: row.sha256 || "",
    itemCount: Number(row.item_count || 0),
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    metadata: withoutCollectorScope(row.metadata || {}),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || null,
  };
}

function mapMarketSnapshot(row = {}) {
  const legacyScope = readOnlyLegacyScope(row);
  const payload = withoutCollectorScope(row.payload || {});
  return {
    id: row.id || "",
    taskId: row.task_id || "",
    runId: row.run_id || "",
    accountId: row.account_id || "",
    operatingStoreId: null,
    ...(legacyScope ? { legacyScope } : {}),
    source: row.source || "ozon_seller_analytics",
    sourceIdentity: clean(payload.sourceIdentity || row.source, 500),
    snapshotKey: row.snapshot_key || "",
    sourceSku: row.source_sku || "",
    productId: row.product_id || "",
    categoryId: row.category_id || "",
    period: row.period || "MONTHLY",
    periodStart: row.period_start || null,
    periodEnd: row.period_end || null,
    requestId: row.request_id || "",
    contentHash: row.content_hash || "",
    metrics: withoutCollectorScope(row.metrics || {}),
    payload,
    collectedAt: row.collected_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapCategoryMapping(row = {}) {
  const legacyScope = readOnlyLegacyScope(row);
  const payload = withoutCollectorScope(row.payload || {});
  return {
    id: row.id || "",
    accountId: row.account_id || "",
    operatingStoreId: null,
    ...(legacyScope ? { legacyScope } : {}),
    source: row.source || "ozon_seller_analytics",
    sourceIdentity: clean(payload.sourceIdentity || row.source, 500),
    rootCategoryId: row.root_category_id || "",
    rootCategoryName: row.root_category_name || "",
    leafCategoryId: row.leaf_category_id || "",
    leafCategoryName: row.leaf_category_name || "",
    status: row.status || "ACTIVE",
    payload,
    lastSeenAt: row.last_seen_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function poolReady() {
  if (!postgresEnabled()) {
    throw serviceError("桌面采集任务需要 PostgreSQL", 503, "COLLECTOR_POSTGRES_REQUIRED");
  }
  const pool = await getPostgresPool();
  if (!migrationPromise) {
    migrationPromise = runMigrations(pool).catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  await migrationPromise;
  return pool;
}

async function transaction(callback) {
  const pool = await poolReady();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function validateAccountWithClient(client, accountId) {
  const account = await client.query(
    `SELECT id, status, expires_at FROM accounts
     WHERE id=$1 AND status='active' AND (expires_at IS NULL OR expires_at > NOW())`,
    [required(accountId, "账号 ID")],
  );
  if (!account.rowCount) {
    throw serviceError("账号不存在、已停用或已过期", 403, "COLLECTOR_ACCOUNT_UNAVAILABLE");
  }
  return {
    accountId,
    operatingStoreId: null,
  };
}

export async function validateCollectorScope(input) {
  const pool = await poolReady();
  return validateAccountWithClient(pool, input?.accountId);
}

async function insertEvent(client, {
  taskId,
  runId = null,
  accountId,
  fromStatus = "",
  toStatus = "",
  eventType,
  level = "INFO",
  message = "",
  actorType = "system",
  actorId = "",
  payload = {},
}) {
  const result = await client.query(
    `INSERT INTO collector_task_events (
       task_id,run_id,account_id,operating_store_id,data_collection_store_id,
       from_status,to_status,event_type,level,message,actor_type,actor_id,payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     RETURNING *`,
    [
      taskId, runId, accountId, null, null,
      clean(fromStatus, 80), clean(toStatus, 80), required(eventType, "事件类型", 120),
      normalizeStatus(level || "INFO", ["DEBUG", "INFO", "WARN", "ERROR"], "事件级别"),
      clean(message, 2000), clean(actorType || "system", 80), clean(actorId, 240),
      JSON.stringify(withoutCollectorScope(jsonObject(payload, "事件数据"))),
    ],
  );
  return mapEvent(result.rows[0]);
}

async function ensureRunScope(client, accountId, runId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT * FROM collector_task_runs
     WHERE id=$1 AND account_id=$2${lock ? " FOR UPDATE" : ""}`,
    [required(runId, "运行 ID"), required(accountId, "账号 ID")],
  );
  if (!result.rowCount) throw serviceError("任务运行不存在", 404, "COLLECTOR_RUN_NOT_FOUND");
  return result.rows[0];
}

async function findDeviceWithClient(client, accountId, deviceIdOrKey) {
  const key = required(deviceIdOrKey, "设备 ID");
  const result = await client.query(
    `SELECT * FROM collector_devices
     WHERE account_id=$1 AND (id=$2 OR device_key=$2) LIMIT 1`,
    [accountId, key],
  );
  return result.rows[0] || null;
}

async function ensureDeviceWithClient(client, accountId, input = {}) {
  const deviceKey = required(input.deviceKey || input.deviceId || input.id, "设备 ID");
  const existing = await findDeviceWithClient(client, accountId, deviceKey);
  if (existing?.status === "REVOKED") {
    throw serviceError("执行设备已被撤销", 403, "COLLECTOR_DEVICE_REVOKED");
  }
  if (existing) {
    const updated = await client.query(
      `UPDATE collector_devices SET
         name=CASE WHEN $3<>'' THEN $3 ELSE name END,
         platform=CASE WHEN $4<>'' THEN $4 ELSE platform END,
         arch=CASE WHEN $5<>'' THEN $5 ELSE arch END,
         app_version=CASE WHEN $6<>'' THEN $6 ELSE app_version END,
         metadata=CASE WHEN $7::jsonb<>'{}'::jsonb THEN $7::jsonb ELSE metadata END,
         last_seen_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND account_id=$2 RETURNING *`,
      [
        existing.id, accountId, clean(input.name, 160), clean(input.platform, 80),
        clean(input.arch, 80), clean(input.appVersion, 80),
        JSON.stringify(withoutCollectorScope(jsonObject(input.metadata, "设备信息"))),
      ],
    );
    return updated.rows[0];
  }
  const inserted = await client.query(
    `INSERT INTO collector_devices (
       id,account_id,device_key,name,platform,arch,app_version,metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
    [
      stableId("coldev", accountId, deviceKey), accountId, deviceKey,
      clean(input.name, 160), clean(input.platform, 80), clean(input.arch, 80),
      clean(input.appVersion, 80), JSON.stringify(withoutCollectorScope(jsonObject(input.metadata, "设备信息"))),
    ],
  );
  return inserted.rows[0];
}

async function assertLeaseWithClient(client, run, accountId, deviceId, leaseToken) {
  const device = await findDeviceWithClient(client, accountId, deviceId);
  if (!device || device.status !== "ACTIVE") {
    throw serviceError("执行设备不存在或已被撤销", 403, "COLLECTOR_DEVICE_UNAVAILABLE");
  }
  if (run.status !== "RUNNING") {
    throw serviceError("任务运行当前不接受执行结果", 409, "COLLECTOR_RUN_NOT_RUNNING");
  }
  if (run.claimed_by_device_id !== device.id || !tokenMatches(required(leaseToken, "租约令牌", 500), run.lease_token_hash)) {
    throw serviceError("任务运行租约不匹配", 409, "COLLECTOR_RUN_LEASE_MISMATCH");
  }
  if (!run.lock_expires_at || new Date(run.lock_expires_at).getTime() <= Date.now()) {
    throw serviceError("任务运行租约已过期，请重新领取", 409, "COLLECTOR_RUN_LEASE_EXPIRED");
  }
  return device;
}

export async function registerCollectorDevice(accountId, input = {}) {
  return transaction(async (client) => mapDevice(await ensureDeviceWithClient(client, accountId, input)));
}

export async function listCollectorDevices(accountId) {
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT * FROM collector_devices WHERE account_id=$1 ORDER BY last_seen_at DESC`,
    [required(accountId, "账号 ID")],
  );
  return result.rows.map(mapDevice);
}

export async function revokeCollectorDevice(accountId, deviceIdOrKey) {
  return transaction(async (client) => {
    const device = await findDeviceWithClient(client, accountId, deviceIdOrKey);
    if (!device) return false;
    await client.query(
      `UPDATE collector_devices SET status='REVOKED',revoked_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND account_id=$2`,
      [device.id, accountId],
    );
    return true;
  });
}

export async function createCollectorTask({
  accountId,
  name = "",
  taskType,
  source = "ozon",
  concurrency = 4,
  configuration = {},
  createdBy = "",
} = {}) {
  const normalizedType = required(taskType, "任务类型", 120).toUpperCase();
  const normalizedConcurrency = boundedInteger(concurrency, { label: "并发数", min: 2, max: 20, fallback: 4 });
  const normalizedConfiguration = withoutCollectorScope(jsonObject(configuration, "任务配置"));
  return transaction(async (client) => {
    await validateAccountWithClient(client, accountId);
    const id = randomId("coltask");
    const result = await client.query(
      `INSERT INTO collector_tasks (
         id,account_id,operating_store_id,data_collection_store_id,name,task_type,
         source,concurrency,configuration,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,
      [
        id, accountId, null, null,
        clean(name || `采集任务 ${new Date().toLocaleString("zh-CN")}`, 240), normalizedType,
        clean(source || "ozon", 80).toLowerCase(), normalizedConcurrency,
        JSON.stringify(normalizedConfiguration), createdBy || accountId,
      ],
    );
    await insertEvent(client, {
      taskId: id,
      accountId,
      toStatus: "NOT_STARTED",
      eventType: "TASK_CREATED",
      actorType: "account",
      actorId: createdBy || accountId,
      payload: { taskType: normalizedType },
    });
    return mapTask(result.rows[0]);
  });
}

export async function getCollectorTaskForAccount(accountId, taskId, { includeDeleted = false } = {}) {
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT * FROM collector_tasks
     WHERE id=$1 AND account_id=$2 AND ($3::boolean OR deleted_at IS NULL) LIMIT 1`,
    [required(taskId, "任务 ID"), required(accountId, "账号 ID"), Boolean(includeDeleted)],
  );
  return result.rows[0] ? mapTask(result.rows[0]) : null;
}

export async function listCollectorTasksForAccount({
  accountId,
  status = "",
  query = "",
  name = "",
  includeDeleted = false,
  limit = 200,
  offset = 0,
} = {}) {
  const pool = await poolReady();
  const normalizedStatus = status ? normalizeStatus(status, COLLECTOR_TASK_STATUSES, "任务状态") : "";
  const normalizedQuery = clean(query || name, 240);
  const result = await pool.query(
    `SELECT * FROM collector_tasks
     WHERE account_id=$1
       AND ($2='' OR status=$2)
       AND ($3='' OR name ILIKE '%' || $3 || '%' OR task_type ILIKE '%' || $3 || '%')
       AND ($4::boolean OR deleted_at IS NULL)
     ORDER BY updated_at DESC,id DESC LIMIT $5 OFFSET $6`,
    [
      required(accountId, "账号 ID"), normalizedStatus, normalizedQuery, Boolean(includeDeleted),
      boundedInteger(limit, { label: "分页数量", min: 1, max: 500, fallback: 200 }),
      boundedInteger(offset, { label: "分页偏移", min: 0, max: 10_000_000, fallback: 0 }),
    ],
  );
  return result.rows.map(mapTask);
}

export async function listCollectorTasksPageForAccount({
  accountId,
  status = "",
  query = "",
  name = "",
  taskName = "",
  includeDeleted = false,
  page = 1,
  pageSize = 50,
} = {}) {
  const normalizedPage = boundedInteger(page, { label: "页码", min: 1, max: 1_000_000, fallback: 1 });
  const normalizedPageSize = boundedInteger(pageSize, { label: "每页数量", min: 1, max: 500, fallback: 50 });
  const normalizedStatus = status ? normalizeStatus(status, COLLECTOR_TASK_STATUSES, "任务状态") : "";
  const normalizedQuery = clean(query || name || taskName, 240);
  const filters = {
    accountId: required(accountId, "账号 ID"),
    status: normalizedStatus,
    query: normalizedQuery,
    includeDeleted: Boolean(includeDeleted),
  };
  const pool = await poolReady();
  const totalResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM collector_tasks
     WHERE account_id=$1
       AND ($2='' OR status=$2)
       AND ($3='' OR name ILIKE '%' || $3 || '%' OR task_type ILIKE '%' || $3 || '%')
       AND ($4::boolean OR deleted_at IS NULL)`,
    [
      filters.accountId,
      filters.status,
      filters.query,
      filters.includeDeleted,
    ],
  );
  const tasks = await listCollectorTasksForAccount({
    ...filters,
    limit: normalizedPageSize,
    offset: (normalizedPage - 1) * normalizedPageSize,
  });
  return {
    tasks,
    total: Number(totalResult.rows[0]?.total || 0),
    page: normalizedPage,
    pageSize: normalizedPageSize,
  };
}

export async function updateCollectorTask({ accountId, taskId, patch = {}, expectedVersion = null } = {}) {
  return transaction(async (client) => {
    const current = await client.query(
      `SELECT * FROM collector_tasks
       WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [required(taskId, "任务 ID"), required(accountId, "账号 ID")],
    );
    if (!current.rowCount) throw serviceError("采集任务不存在", 404, "COLLECTOR_TASK_NOT_FOUND");
    const row = current.rows[0];
    if (expectedVersion !== null && Number(expectedVersion) !== Number(row.status_version)) {
      throw serviceError("任务已在其他设备更新，请刷新后重试", 409, "COLLECTOR_TASK_VERSION_CONFLICT");
    }
    if (ACTIVE_RUN_STATUSES.has(row.status)) {
      throw serviceError("排队或执行中的任务不能修改", 409, "COLLECTOR_TASK_ACTIVE");
    }
    const configuration = hasOwn(patch, "configuration")
      ? withoutCollectorScope(jsonObject(patch.configuration, "任务配置"))
      : row.configuration;
    const concurrency = hasOwn(patch, "concurrency")
      ? boundedInteger(patch.concurrency, { label: "并发数", min: 2, max: 20 })
      : row.concurrency;
    const updated = await client.query(
      `UPDATE collector_tasks SET
         name=$3,task_type=$4,source=$5,concurrency=$6,configuration=$7::jsonb,
         status_version=status_version+1,updated_at=NOW()
       WHERE id=$1 AND account_id=$2 RETURNING *`,
      [
        taskId, accountId,
        hasOwn(patch, "name") ? clean(patch.name, 240) : row.name,
        hasOwn(patch, "taskType") ? required(patch.taskType, "任务类型", 120).toUpperCase() : row.task_type,
        hasOwn(patch, "source") ? required(patch.source, "来源", 80).toLowerCase() : row.source,
        concurrency, JSON.stringify(configuration),
      ],
    );
    await insertEvent(client, {
      taskId,
      accountId,
      fromStatus: row.status,
      toStatus: row.status,
      eventType: "TASK_UPDATED",
      actorType: "account",
      actorId: accountId,
      payload: { previousStatusVersion: Number(row.status_version) },
    });
    return mapTask(updated.rows[0]);
  });
}

export async function softDeleteCollectorTask(accountId, taskId) {
  return transaction(async (client) => {
    const current = await client.query(
      `SELECT * FROM collector_tasks
       WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [required(taskId, "任务 ID"), required(accountId, "账号 ID")],
    );
    if (!current.rowCount) return false;
    if (ACTIVE_RUN_STATUSES.has(current.rows[0].status)) {
      throw serviceError("请先取消正在排队或执行的任务", 409, "COLLECTOR_TASK_ACTIVE");
    }
    await client.query(
      `UPDATE collector_tasks SET deleted_at=NOW(),updated_at=NOW(),status_version=status_version+1
       WHERE id=$1 AND account_id=$2`,
      [taskId, accountId],
    );
    await insertEvent(client, {
      taskId,
      accountId,
      fromStatus: current.rows[0].status,
      toStatus: current.rows[0].status,
      eventType: "TASK_DELETED",
      actorType: "account",
      actorId: accountId,
    });
    return true;
  });
}

async function resolvePricingVersionWithClient(client, {
  accountId,
  requestedVersionId = "",
  fallbackVersionId = "",
}) {
  if (requestedVersionId) {
    const requested = await client.query(
      `SELECT id,status,effective_from,effective_to FROM pricing_config_versions
       WHERE id=$1 AND status IN ('ACTIVE','SCHEDULED')
         AND (
           scope_type='global'
           OR (scope_type='account' AND scope_id=$2)
         )`,
      [requestedVersionId, accountId],
    );
    if (!requested.rowCount) {
      throw serviceError("指定的算价配置不存在或未发布", 409, "COLLECTOR_PRICING_CONFIG_UNAVAILABLE");
    }
    const row = requested.rows[0];
    const now = Date.now();
    if ((row.effective_from && new Date(row.effective_from).getTime() > now)
      || (row.effective_to && new Date(row.effective_to).getTime() <= now)) {
      throw serviceError("指定的算价配置当前未生效", 409, "COLLECTOR_PRICING_CONFIG_NOT_EFFECTIVE");
    }
    return row.id;
  }
  const active = await client.query(
    `SELECT id FROM pricing_config_versions
     WHERE status IN ('ACTIVE','SCHEDULED')
       AND (effective_from IS NULL OR effective_from <= NOW())
       AND (effective_to IS NULL OR effective_to > NOW())
       AND (
         (scope_type='account' AND scope_id=$1)
         OR scope_type='global'
       )
     ORDER BY CASE scope_type WHEN 'store' THEN 1 WHEN 'account' THEN 2 ELSE 3 END,
              effective_from DESC NULLS LAST,version_no DESC
     LIMIT 1`,
    [accountId],
  );
  if (active.rowCount) return active.rows[0].id;
  const fallback = clean(fallbackVersionId, 240);
  if (fallback) {
    const found = await client.query(
      `SELECT id FROM pricing_config_versions
       WHERE id=$1 AND status IN ('ACTIVE','SCHEDULED')
         AND (effective_from IS NULL OR effective_from <= NOW())
         AND (effective_to IS NULL OR effective_to > NOW())
         AND (
           scope_type='global'
           OR (scope_type='account' AND scope_id=$2)
         )`,
      [fallback, accountId],
    );
    if (found.rowCount) return fallback;
  }
  throw serviceError("没有可用的算价配置", 409, "COLLECTOR_PRICING_CONFIG_UNAVAILABLE");
}

export async function queueCollectorTaskRun({
  accountId,
  taskId,
  idempotencyKey = "",
  pricingConfigVersionId = "",
  requestedBy = "",
} = {}) {
  const task = await getCollectorTaskForAccount(accountId, taskId);
  if (!task) throw serviceError("采集任务不存在", 404, "COLLECTOR_TASK_NOT_FOUND");
  const activePricingConfig = await getActivePricingConfig({
    accountId,
  });
  return transaction(async (client) => {
    const locked = await client.query(
      `SELECT * FROM collector_tasks
       WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [taskId, accountId],
    );
    if (!locked.rowCount) throw serviceError("采集任务不存在", 404, "COLLECTOR_TASK_NOT_FOUND");
    const row = locked.rows[0];
    await validateAccountWithClient(client, accountId);
    const normalizedIdempotencyKey = clean(idempotencyKey, 240);
    if (normalizedIdempotencyKey) {
      const duplicate = await client.query(
        `SELECT * FROM collector_task_runs WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [accountId, normalizedIdempotencyKey],
      );
      if (duplicate.rowCount) {
        if (duplicate.rows[0].task_id !== taskId) {
          throw serviceError("幂等键已被其他任务使用", 409, "COLLECTOR_IDEMPOTENCY_KEY_REUSED");
        }
        return { duplicate: true, run: mapRun(duplicate.rows[0]) };
      }
    }
    const activeRun = await client.query(
      `SELECT id FROM collector_task_runs
       WHERE task_id=$1 AND account_id=$2 AND status IN ('QUEUED','RUNNING') LIMIT 1`,
      [taskId, accountId],
    );
    if (activeRun.rowCount) {
      throw serviceError("任务已有排队或执行中的运行", 409, "COLLECTOR_TASK_ALREADY_ACTIVE");
    }
    assertTaskTransition(row.status, "QUEUED");
    const runNoResult = await client.query(
      `SELECT COALESCE(MAX(run_no),0)+1 AS run_no
       FROM collector_task_runs WHERE task_id=$1 AND account_id=$2`,
      [taskId, accountId],
    );
    const resolvedPricingVersionId = await resolvePricingVersionWithClient(client, {
      accountId,
      requestedVersionId: clean(pricingConfigVersionId, 240),
      fallbackVersionId: activePricingConfig?.id || "",
    });
    const runId = randomId("colrun");
    const configurationSnapshot = {
      taskId,
      taskType: row.task_type,
      source: row.source,
      concurrency: Number(row.concurrency),
      configuration: row.configuration || {},
      operatingStoreId: null,
      pricingConfigVersionId: resolvedPricingVersionId,
      frozenAt: new Date().toISOString(),
    };
    const inserted = await client.query(
      `INSERT INTO collector_task_runs (
         id,task_id,account_id,operating_store_id,data_collection_store_id,
         pricing_config_version_id,run_no,idempotency_key,configuration_snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
      [
        runId, taskId, accountId, null, null,
        resolvedPricingVersionId, Number(runNoResult.rows[0].run_no), normalizedIdempotencyKey,
        JSON.stringify(withoutCollectorScope(configurationSnapshot)),
      ],
    );
    await client.query(
      `UPDATE collector_tasks SET
         status='QUEUED',status_version=status_version+1,current_run_id=$3,
         last_error_code='',last_error_message='',updated_at=NOW()
       WHERE id=$1 AND account_id=$2`,
      [taskId, accountId, runId],
    );
    await insertEvent(client, {
      taskId,
      runId,
      accountId,
      fromStatus: row.status,
      toStatus: "QUEUED",
      eventType: "RUN_QUEUED",
      actorType: "account",
      actorId: requestedBy || accountId,
      payload: { runNo: Number(runNoResult.rows[0].run_no), pricingConfigVersionId: resolvedPricingVersionId },
    });
    return { duplicate: false, run: mapRun(inserted.rows[0]) };
  });
}

export async function getCollectorRunForAccount(accountId, runId) {
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT * FROM collector_task_runs WHERE id=$1 AND account_id=$2 LIMIT 1`,
    [required(runId, "运行 ID"), required(accountId, "账号 ID")],
  );
  return result.rows[0] ? mapRun(result.rows[0]) : null;
}

export async function listCollectorRunsForTask({ accountId, taskId, limit = 100, offset = 0 } = {}) {
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT * FROM collector_task_runs
     WHERE account_id=$1 AND task_id=$2
     ORDER BY run_no DESC LIMIT $3 OFFSET $4`,
    [
      required(accountId, "账号 ID"), required(taskId, "任务 ID"),
      boundedInteger(limit, { label: "分页数量", min: 1, max: 500, fallback: 100 }),
      boundedInteger(offset, { label: "分页偏移", min: 0, max: 10_000_000, fallback: 0 }),
    ],
  );
  return result.rows.map(mapRun);
}

export async function claimCollectorRun({
  accountId,
  runId,
  deviceId,
  device = {},
  leaseSeconds = 90,
} = {}) {
  const normalizedLeaseSeconds = boundedInteger(leaseSeconds, {
    label: "租约时长",
    min: 30,
    max: 300,
    fallback: 90,
  });
  return transaction(async (client) => {
    const run = await ensureRunScope(client, accountId, runId, { lock: true });
    const deviceRow = await ensureDeviceWithClient(client, accountId, {
      ...device,
      deviceId: deviceId || device.deviceId || device.deviceKey,
    });
    await validateAccountWithClient(client, accountId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw serviceError("任务运行已经结束", 409, "COLLECTOR_RUN_TERMINAL");
    }
    const reclaimed = run.status === "RUNNING";
    if (reclaimed && run.lock_expires_at && new Date(run.lock_expires_at).getTime() > Date.now()) {
      throw serviceError("任务运行正在被其他执行器处理", 409, "COLLECTOR_RUN_LEASE_ACTIVE");
    }
    if (run.cancel_requested_at) {
      throw serviceError("任务运行已请求取消", 409, "COLLECTOR_RUN_CANCEL_REQUESTED");
    }
    if (run.status === "QUEUED") assertRunTransition(run.status, "RUNNING");
    const leaseToken = crypto.randomBytes(32).toString("base64url");
    const lockExpiresAt = new Date(Date.now() + normalizedLeaseSeconds * 1000);
    const updated = await client.query(
      `UPDATE collector_task_runs SET
         status='RUNNING',status_version=status_version+1,
         claimed_by_device_id=$3,lease_token_hash=$4,lock_expires_at=$5,
         heartbeat_at=NOW(),claim_count=claim_count+1,
         started_at=COALESCE(started_at,NOW()),updated_at=NOW()
       WHERE id=$1 AND account_id=$2 RETURNING *`,
      [runId, accountId, deviceRow.id, sha256(leaseToken), lockExpiresAt],
    );
    const task = await client.query(
      `SELECT status,current_run_id FROM collector_tasks WHERE id=$1 AND account_id=$2 FOR UPDATE`,
      [run.task_id, accountId],
    );
    if (!task.rowCount || task.rows[0].current_run_id !== runId) {
      throw serviceError("任务当前运行已发生变化", 409, "COLLECTOR_TASK_RUN_CHANGED");
    }
    if (task.rows[0].status !== "RUNNING") {
      assertTaskTransition(task.rows[0].status, "RUNNING");
      await client.query(
        `UPDATE collector_tasks SET status='RUNNING',status_version=status_version+1,updated_at=NOW()
         WHERE id=$1 AND account_id=$2`,
        [run.task_id, accountId],
      );
    }
    await insertEvent(client, {
      taskId: run.task_id,
      runId,
      accountId,
      fromStatus: run.status,
      toStatus: "RUNNING",
      eventType: reclaimed ? "RUN_RECLAIMED" : "RUN_CLAIMED",
      actorType: "device",
      actorId: deviceRow.id,
      payload: { leaseSeconds: normalizedLeaseSeconds, claimCount: Number(run.claim_count || 0) + 1 },
    });
    return {
      run: mapRun(updated.rows[0]),
      leaseToken,
      reclaimed,
      device: mapDevice(deviceRow),
    };
  });
}

function mergedProgress(run, progress = {}) {
  const result = {};
  for (const [camel, snake] of [
    ["totalCount", "total_count"],
    ["processedCount", "processed_count"],
    ["qualifiedCount", "qualified_count"],
    ["filteredCount", "filtered_count"],
    ["failedCount", "failed_count"],
  ]) {
    const existing = Number(run[snake] || 0);
    const requested = hasOwn(progress, camel)
      ? boundedInteger(progress[camel], { label: camel, min: 0, max: 100_000_000 })
      : existing;
    result[camel] = Math.max(existing, requested);
  }
  if (result.totalCount > 0 && result.processedCount > result.totalCount) {
    result.totalCount = result.processedCount;
  }
  return result;
}

export async function heartbeatCollectorRun({
  accountId,
  runId,
  deviceId,
  leaseToken,
  leaseSeconds = 90,
  progress = {},
} = {}) {
  const normalizedLeaseSeconds = boundedInteger(leaseSeconds, {
    label: "租约时长",
    min: 30,
    max: 300,
    fallback: 90,
  });
  return transaction(async (client) => {
    const run = await ensureRunScope(client, accountId, runId, { lock: true });
    const device = await assertLeaseWithClient(client, run, accountId, deviceId, leaseToken);
    const next = mergedProgress(run, jsonObject(progress, "任务进度"));
    const updated = await client.query(
      `UPDATE collector_task_runs SET
         total_count=$3,processed_count=$4,qualified_count=$5,filtered_count=$6,failed_count=$7,
         heartbeat_at=NOW(),lock_expires_at=$8,updated_at=NOW()
       WHERE id=$1 AND account_id=$2 RETURNING *`,
      [
        runId, accountId, next.totalCount, next.processedCount, next.qualifiedCount,
        next.filteredCount, next.failedCount,
        new Date(Date.now() + normalizedLeaseSeconds * 1000),
      ],
    );
    await client.query(
      `UPDATE collector_devices SET last_seen_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND account_id=$2`,
      [device.id, accountId],
    );
    await client.query(
      `UPDATE collector_tasks SET updated_at=NOW() WHERE id=$1 AND account_id=$2`,
      [run.task_id, accountId],
    );
    return {
      run: mapRun(updated.rows[0]),
      cancelRequested: Boolean(updated.rows[0].cancel_requested_at),
    };
  });
}

export async function requestCollectorRunCancellation({ accountId, runId, actorId = "" } = {}) {
  return transaction(async (client) => {
    const run = await ensureRunScope(client, accountId, runId, { lock: true });
    if (TERMINAL_RUN_STATUSES.has(run.status)) return mapRun(run);
    const task = await client.query(
      `SELECT * FROM collector_tasks WHERE id=$1 AND account_id=$2 FOR UPDATE`,
      [run.task_id, accountId],
    );
    if (!task.rowCount || task.rows[0].current_run_id !== runId) {
      throw serviceError("任务当前运行已发生变化", 409, "COLLECTOR_TASK_RUN_CHANGED");
    }
    const staleRunning = run.status === "RUNNING"
      && (!run.lock_expires_at || new Date(run.lock_expires_at).getTime() <= Date.now());
    if (run.status === "QUEUED" || staleRunning) {
      const fromStatus = run.status;
      assertRunTransition(fromStatus, "CANCELLED");
      assertTaskTransition(task.rows[0].status, "CANCELLED");
      const updated = await client.query(
        `UPDATE collector_task_runs SET
           status='CANCELLED',status_version=status_version+1,cancel_requested_at=NOW(),
           completed_at=NOW(),lock_expires_at=NULL,lease_token_hash='',updated_at=NOW()
         WHERE id=$1 AND account_id=$2 RETURNING *`,
        [runId, accountId],
      );
      await client.query(
        `UPDATE collector_tasks SET status='CANCELLED',status_version=status_version+1,updated_at=NOW()
         WHERE id=$1 AND account_id=$2`,
        [run.task_id, accountId],
      );
      await insertEvent(client, {
        taskId: run.task_id,
        runId,
        accountId,
        fromStatus,
        toStatus: "CANCELLED",
        eventType: staleRunning ? "RUN_STALE_CANCELLED" : "RUN_CANCELLED",
        actorType: "account",
        actorId: actorId || accountId,
      });
      return mapRun(updated.rows[0]);
    }
    const updated = await client.query(
      `UPDATE collector_task_runs SET
         cancel_requested_at=COALESCE(cancel_requested_at,NOW()),updated_at=NOW()
       WHERE id=$1 AND account_id=$2 RETURNING *`,
      [runId, accountId],
    );
    await insertEvent(client, {
      taskId: run.task_id,
      runId,
      accountId,
      fromStatus: "RUNNING",
      toStatus: "RUNNING",
      eventType: "RUN_CANCEL_REQUESTED",
      level: "WARN",
      actorType: "account",
      actorId: actorId || accountId,
    });
    return mapRun(updated.rows[0]);
  });
}

async function finishCollectorRun({
  accountId,
  runId,
  deviceId,
  leaseToken,
  status,
  resultSummary = {},
  errorCode = "",
  errorMessage = "",
} = {}) {
  const targetStatus = normalizeStatus(status, ["COMPLETED", "FAILED", "CANCELLED"], "完成状态");
  return transaction(async (client) => {
    const run = await ensureRunScope(client, accountId, runId, { lock: true });
    const device = await assertLeaseWithClient(client, run, accountId, deviceId, leaseToken);
    assertRunTransition(run.status, targetStatus);
    const task = await client.query(
      `SELECT * FROM collector_tasks WHERE id=$1 AND account_id=$2 FOR UPDATE`,
      [run.task_id, accountId],
    );
    if (!task.rowCount || task.rows[0].current_run_id !== runId) {
      throw serviceError("任务当前运行已发生变化", 409, "COLLECTOR_TASK_RUN_CHANGED");
    }
    assertTaskTransition(task.rows[0].status, targetStatus);
    const normalizedErrorCode = targetStatus === "FAILED" ? clean(errorCode || "COLLECTOR_RUN_FAILED", 120) : "";
    const normalizedErrorMessage = targetStatus === "FAILED" ? clean(errorMessage, 2000) : "";
    const updated = await client.query(
      `UPDATE collector_task_runs SET
         status=$3,status_version=status_version+1,result_summary=$4::jsonb,
         error_code=$5,error_message=$6,lock_expires_at=NULL,lease_token_hash='',
         completed_at=NOW(),heartbeat_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND account_id=$2 RETURNING *`,
      [
        runId, accountId, targetStatus, JSON.stringify(withoutCollectorScope(jsonObject(resultSummary, "运行结果"))),
        normalizedErrorCode, normalizedErrorMessage,
      ],
    );
    await client.query(
      `UPDATE collector_tasks SET
         status=$3,status_version=status_version+1,last_error_code=$4,
         last_error_message=$5,updated_at=NOW()
       WHERE id=$1 AND account_id=$2`,
      [run.task_id, accountId, targetStatus, normalizedErrorCode, normalizedErrorMessage],
    );
    await insertEvent(client, {
      taskId: run.task_id,
      runId,
      accountId,
      fromStatus: run.status,
      toStatus: targetStatus,
      eventType: `RUN_${targetStatus}`,
      level: targetStatus === "FAILED" ? "ERROR" : "INFO",
      message: normalizedErrorMessage,
      actorType: "device",
      actorId: device.id,
      payload: withoutCollectorScope(jsonObject(resultSummary, "运行结果")),
    });
    return mapRun(updated.rows[0]);
  });
}

export function completeCollectorRun(input = {}) {
  return finishCollectorRun({ ...input, status: "COMPLETED" });
}

export function failCollectorRun(input = {}) {
  return finishCollectorRun({ ...input, status: "FAILED" });
}

export function cancelCollectorRun(input = {}) {
  return finishCollectorRun({ ...input, status: "CANCELLED" });
}

export async function upsertCollectorRunItem({
  accountId,
  runId,
  deviceId,
  leaseToken,
  item = {},
} = {}) {
  const source = clean(item.source || "ozon", 80).toLowerCase();
  const sourceKey = required(item.sourceKey || item.sourceSku || item.sku || item.productId, "商品来源键", 500);
  const status = normalizeStatus(item.status || "DISCOVERED", COLLECTOR_ITEM_STATUSES, "商品状态");
  return transaction(async (client) => {
    const run = await ensureRunScope(client, accountId, runId, { lock: true });
    await assertLeaseWithClient(client, run, accountId, deviceId, leaseToken);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${runId}|${source}|${sourceKey}`]);
    const collectItemId = clean(item.collectItemId, 240);
    if (collectItemId) {
      const collectItem = await client.query(
        `SELECT id FROM collect_items WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`,
        [collectItemId, accountId],
      );
      if (!collectItem.rowCount) {
        throw serviceError("采集箱商品不存在或不属于当前账号", 409, "COLLECTOR_COLLECT_ITEM_SCOPE_MISMATCH");
      }
    }
    const existingResult = await client.query(
      `SELECT * FROM collector_task_items
       WHERE run_id=$1 AND account_id=$2 AND source=$3 AND source_key=$4 FOR UPDATE`,
      [runId, accountId, source, sourceKey],
    );
    const existing = existingResult.rows[0] || null;
    if (existing && !ITEM_TRANSITIONS[existing.status]?.has(status)) {
      const explicitFailedRetry = existing.status === "FAILED"
        && item.retry === true
        && ["DISCOVERED", "ENRICHED", "QUALIFIED"].includes(status);
      if (!explicitFailedRetry) {
        throw serviceError(
          `商品状态不能从 ${existing.status} 变更为 ${status}`,
          409,
          "COLLECTOR_ITEM_INVALID_TRANSITION",
        );
      }
    }
    const data = (camel, snake) => withoutCollectorScope(hasOwn(item, camel)
      ? jsonObject(item[camel], camel)
      : (existing?.[snake] || {}));
    const attemptCount = existing
      ? Number(existing.attempt_count || 1) + (item.retry === true ? 1 : 0)
      : boundedInteger(item.attemptCount, { label: "尝试次数", min: 1, max: 10_000, fallback: 1 });
    const completedAt = TERMINAL_ITEM_STATUSES.has(status) ? new Date() : null;
    const id = existing?.id || stableId("colitem", runId, source, sourceKey);
    const result = await client.query(
      `INSERT INTO collector_task_items (
         id,task_id,run_id,account_id,operating_store_id,data_collection_store_id,
         collect_item_id,source,source_key,source_sku,source_url,sort_order,status,
         attempt_count,raw_payload,analytics,sourcing,pricing,filter_result,export_data,
         error_code,error_message,completed_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
         $15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22,$23
       )
       ON CONFLICT (run_id,source,source_key) DO UPDATE SET
         collect_item_id=EXCLUDED.collect_item_id,
         source_sku=EXCLUDED.source_sku,source_url=EXCLUDED.source_url,
         sort_order=EXCLUDED.sort_order,status=EXCLUDED.status,
         attempt_count=EXCLUDED.attempt_count,raw_payload=EXCLUDED.raw_payload,
         analytics=EXCLUDED.analytics,sourcing=EXCLUDED.sourcing,pricing=EXCLUDED.pricing,
         filter_result=EXCLUDED.filter_result,export_data=EXCLUDED.export_data,
         error_code=EXCLUDED.error_code,error_message=EXCLUDED.error_message,
         completed_at=EXCLUDED.completed_at,updated_at=NOW()
       WHERE collector_task_items.account_id=EXCLUDED.account_id
       RETURNING *`,
      [
        id, run.task_id, runId, accountId, null, null,
        collectItemId || existing?.collect_item_id || null, source, sourceKey,
        hasOwn(item, "sourceSku") ? clean(item.sourceSku, 240) : (existing?.source_sku || ""),
        hasOwn(item, "sourceUrl") ? clean(item.sourceUrl, 2000) : (existing?.source_url || ""),
        hasOwn(item, "sortOrder")
          ? boundedInteger(item.sortOrder, { label: "排序", min: 0, max: 100_000_000 })
          : Number(existing?.sort_order || 0),
        status, attemptCount,
        JSON.stringify(data("rawPayload", "raw_payload")),
        JSON.stringify(data("analytics", "analytics")),
        JSON.stringify(data("sourcing", "sourcing")),
        JSON.stringify(data("pricing", "pricing")),
        JSON.stringify(data("filterResult", "filter_result")),
        JSON.stringify(data("exportData", "export_data")),
        hasOwn(item, "errorCode") ? clean(item.errorCode, 120) : (existing?.error_code || ""),
        hasOwn(item, "errorMessage") ? clean(item.errorMessage, 2000) : (existing?.error_message || ""),
        completedAt,
      ],
    );
    const stats = await client.query(
      `SELECT
         COUNT(*)::int AS total_count,
         COUNT(*) FILTER (WHERE status IN ('QUALIFIED','FILTERED_OUT','FAILED'))::int AS processed_count,
         COUNT(*) FILTER (WHERE status='QUALIFIED')::int AS qualified_count,
         COUNT(*) FILTER (WHERE status='FILTERED_OUT')::int AS filtered_count,
         COUNT(*) FILTER (WHERE status='FAILED')::int AS failed_count
       FROM collector_task_items WHERE run_id=$1 AND account_id=$2`,
      [runId, accountId],
    );
    const counts = stats.rows[0];
    await client.query(
      `UPDATE collector_task_runs SET
         total_count=GREATEST(total_count,$3),processed_count=$4,
         qualified_count=$5,filtered_count=$6,failed_count=$7,updated_at=NOW()
       WHERE id=$1 AND account_id=$2`,
      [
        runId, accountId, Number(counts.total_count), Number(counts.processed_count),
        Number(counts.qualified_count), Number(counts.filtered_count), Number(counts.failed_count),
      ],
    );
    return { item: mapItem(result.rows[0]), created: !existing };
  });
}

export async function listCollectorRunItems({
  accountId,
  runId,
  status = "",
  limit = 500,
  offset = 0,
} = {}) {
  const pool = await poolReady();
  const normalizedStatus = status ? normalizeStatus(status, COLLECTOR_ITEM_STATUSES, "商品状态") : "";
  const result = await pool.query(
    `SELECT i.* FROM collector_task_items i
     JOIN collector_task_runs r ON r.id=i.run_id AND r.account_id=i.account_id
     WHERE i.account_id=$1 AND i.run_id=$2 AND ($3='' OR i.status=$3)
     ORDER BY i.sort_order,i.created_at,i.id LIMIT $4 OFFSET $5`,
    [
      required(accountId, "账号 ID"), required(runId, "运行 ID"), normalizedStatus,
      boundedInteger(limit, { label: "分页数量", min: 1, max: 5000, fallback: 500 }),
      boundedInteger(offset, { label: "分页偏移", min: 0, max: 10_000_000, fallback: 0 }),
    ],
  );
  return result.rows.map(mapItem);
}

export async function appendCollectorRunEvent({
  accountId,
  runId,
  eventType,
  level = "INFO",
  message = "",
  actorType = "device",
  actorId = "",
  payload = {},
} = {}) {
  return transaction(async (client) => {
    const run = await ensureRunScope(client, accountId, runId);
    return insertEvent(client, {
      taskId: run.task_id,
      runId,
      accountId,
      fromStatus: run.status,
      toStatus: run.status,
      eventType,
      level,
      message,
      actorType,
      actorId,
      payload,
    });
  });
}

export async function listCollectorRunEvents({ accountId, runId, afterId = 0, limit = 500 } = {}) {
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT e.* FROM collector_task_events e
     JOIN collector_task_runs r ON r.id=e.run_id AND r.account_id=e.account_id
     WHERE e.account_id=$1 AND e.run_id=$2 AND e.id>$3
     ORDER BY e.id LIMIT $4`,
    [
      required(accountId, "账号 ID"), required(runId, "运行 ID"),
      boundedInteger(afterId, { label: "事件游标", min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
      boundedInteger(limit, { label: "分页数量", min: 1, max: 2000, fallback: 500 }),
    ],
  );
  return result.rows.map(mapEvent);
}

export async function createCollectorExport({
  accountId,
  runId,
  format = "xlsx",
  fileName = "",
  metadata = {},
} = {}) {
  return transaction(async (client) => {
    const run = await ensureRunScope(client, accountId, runId, { lock: true });
    const nextVersion = await client.query(
      `SELECT COALESCE(MAX(version),0)+1 AS version
       FROM collector_exports WHERE run_id=$1 AND account_id=$2`,
      [runId, accountId],
    );
    const version = Number(nextVersion.rows[0].version);
    const result = await client.query(
      `INSERT INTO collector_exports (
         id,task_id,run_id,account_id,operating_store_id,data_collection_store_id,
         version,format,file_name,metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
      [
        randomId("colexport"), run.task_id, runId, accountId, null,
        null, version, clean(format || "xlsx", 40).toLowerCase(),
        clean(fileName || `collector-${run.task_id}-${version}.xlsx`, 500),
        JSON.stringify(withoutCollectorScope(jsonObject(metadata, "导出信息"))),
      ],
    );
    await insertEvent(client, {
      taskId: run.task_id,
      runId,
      accountId,
      fromStatus: run.status,
      toStatus: run.status,
      eventType: "EXPORT_CREATED",
      payload: { exportId: result.rows[0].id, version },
    });
    return mapExport(result.rows[0]);
  });
}

export async function updateCollectorExport({ accountId, exportId, patch = {} } = {}) {
  return transaction(async (client) => {
    const current = await client.query(
      `SELECT * FROM collector_exports WHERE id=$1 AND account_id=$2 FOR UPDATE`,
      [required(exportId, "导出 ID"), required(accountId, "账号 ID")],
    );
    if (!current.rowCount) throw serviceError("导出记录不存在", 404, "COLLECTOR_EXPORT_NOT_FOUND");
    const row = current.rows[0];
    const status = hasOwn(patch, "status")
      ? normalizeStatus(patch.status, ["PENDING", "GENERATING", "READY", "FAILED"], "导出状态")
      : row.status;
    if (status !== row.status && !EXPORT_TRANSITIONS[row.status]?.has(status)) {
      throw serviceError(`导出不能从 ${row.status} 变更为 ${status}`, 409, "COLLECTOR_EXPORT_INVALID_TRANSITION");
    }
    const fileId = hasOwn(patch, "fileId") ? clean(patch.fileId, 240) : (row.file_id || "");
    if (fileId) {
      const file = await client.query(
        `SELECT id FROM files WHERE id=$1 AND (created_by IS NULL OR created_by=$2)`,
        [fileId, accountId],
      );
      if (!file.rowCount) {
        throw serviceError("导出文件不存在或不属于当前账号", 409, "COLLECTOR_FILE_SCOPE_MISMATCH");
      }
    }
    const updated = await client.query(
      `UPDATE collector_exports SET
         status=$3,file_id=$4,file_name=$5,object_key=$6,content_type=$7,
         size=$8,sha256=$9,item_count=$10,error_code=$11,error_message=$12,
         metadata=$13::jsonb,completed_at=CASE WHEN $3 IN ('READY','FAILED') THEN NOW() ELSE completed_at END,
         updated_at=NOW()
       WHERE id=$1 AND account_id=$2 RETURNING *`,
      [
        exportId, accountId, status, fileId || null,
        hasOwn(patch, "fileName") ? clean(patch.fileName, 500) : row.file_name,
        hasOwn(patch, "objectKey") ? clean(patch.objectKey, 1000) : row.object_key,
        hasOwn(patch, "contentType") ? clean(patch.contentType, 240) : row.content_type,
        hasOwn(patch, "size") ? boundedInteger(patch.size, { label: "文件大小", min: 0, max: Number.MAX_SAFE_INTEGER }) : Number(row.size),
        hasOwn(patch, "sha256") ? clean(patch.sha256, 64) : row.sha256,
        hasOwn(patch, "itemCount") ? boundedInteger(patch.itemCount, { label: "商品数量", min: 0, max: 100_000_000 }) : Number(row.item_count),
        hasOwn(patch, "errorCode") ? clean(patch.errorCode, 120) : row.error_code,
        hasOwn(patch, "errorMessage") ? clean(patch.errorMessage, 2000) : row.error_message,
        JSON.stringify(withoutCollectorScope(hasOwn(patch, "metadata") ? jsonObject(patch.metadata, "导出信息") : row.metadata)),
      ],
    );
    await insertEvent(client, {
      taskId: row.task_id,
      runId: row.run_id,
      accountId,
      fromStatus: row.status,
      toStatus: status,
      eventType: `EXPORT_${status}`,
      level: status === "FAILED" ? "ERROR" : "INFO",
      message: hasOwn(patch, "errorMessage") ? clean(patch.errorMessage, 2000) : "",
      payload: { exportId },
    });
    return mapExport(updated.rows[0]);
  });
}

export async function listCollectorExportsForRun({ accountId, runId } = {}) {
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT e.* FROM collector_exports e
     JOIN collector_task_runs r ON r.id=e.run_id AND r.account_id=e.account_id
     WHERE e.account_id=$1 AND e.run_id=$2 ORDER BY e.version DESC`,
    [required(accountId, "账号 ID"), required(runId, "运行 ID")],
  );
  return result.rows.map(mapExport);
}

export async function getCollectorExportForAccount(accountId, exportId) {
  const pool = await poolReady();
  const result = await pool.query(
    `SELECT * FROM collector_exports WHERE id=$1 AND account_id=$2 LIMIT 1`,
    [required(exportId, "导出 ID"), required(accountId, "账号 ID")],
  );
  return result.rows[0] ? mapExport(result.rows[0]) : null;
}

async function validateOptionalTaskRunScope(client, {
  accountId,
  taskId = "",
  runId = "",
}) {
  let resolvedTaskId = clean(taskId, 240);
  let resolvedRunId = clean(runId, 240);
  if (resolvedRunId) {
    const run = await client.query(
      `SELECT id,task_id
       FROM collector_task_runs WHERE id=$1 AND account_id=$2`,
      [resolvedRunId, accountId],
    );
    if (!run.rowCount || (resolvedTaskId && run.rows[0].task_id !== resolvedTaskId)) {
      throw serviceError("市场数据的任务运行范围不匹配", 409, "COLLECTOR_RUN_SCOPE_MISMATCH");
    }
    resolvedTaskId = run.rows[0].task_id;
  }
  if (resolvedTaskId) {
    const task = await client.query(
      `SELECT id FROM collector_tasks WHERE id=$1 AND account_id=$2`,
      [resolvedTaskId, accountId],
    );
    if (!task.rowCount) {
      throw serviceError("市场数据的任务范围不匹配", 409, "COLLECTOR_TASK_SCOPE_MISMATCH");
    }
  }
  return { taskId: resolvedTaskId || null, runId: resolvedRunId || null };
}

function normalizePeriod(value) {
  const period = clean(value || "MONTHLY", 40).toUpperCase();
  if (["WEEK", "WEEKLY"].includes(period)) return "WEEKLY";
  if (["MONTH", "MONTHLY"].includes(period)) return "MONTHLY";
  throw serviceError("市场数据周期必须为 WEEKLY 或 MONTHLY", 422, "COLLECTOR_INVALID_PERIOD");
}

export async function upsertCollectorMarketSnapshot({
  accountId,
  taskId = "",
  runId = "",
  source = "ozon_seller_analytics",
  sourceIdentity = "",
  snapshotKey = "",
  sourceSku = "",
  productId = "",
  categoryId = "",
  period = "MONTHLY",
  periodStart = null,
  periodEnd = null,
  requestId = "",
  metrics = {},
  payload = {},
  collectedAt = null,
} = {}) {
  const normalizedSource = clean(source || "ozon_seller_analytics", 120).toLowerCase();
  const normalizedSourceIdentity = clean(sourceIdentity || normalizedSource, 500);
  const normalizedPayload = {
    ...withoutCollectorScope(jsonObject(payload, "市场快照")),
    sourceIdentity: normalizedSourceIdentity,
  };
  const normalizedMetrics = withoutCollectorScope(jsonObject(metrics, "市场指标"));
  const normalizedPeriod = normalizePeriod(period);
  const resolvedSnapshotKey = clean(snapshotKey, 500) || sha256(canonicalJson({
    source: normalizedSource,
    sourceSku: clean(sourceSku, 240),
    productId: clean(productId, 240),
    categoryId: clean(categoryId, 240),
    period: normalizedPeriod,
    periodStart: periodStart || null,
    periodEnd: periodEnd || null,
  }));
  return transaction(async (client) => {
    await validateAccountWithClient(client, accountId);
    const link = await validateOptionalTaskRunScope(client, {
      accountId,
      taskId,
      runId,
    });
    const contentHash = sha256(canonicalJson({ metrics: normalizedMetrics, payload: normalizedPayload }));
    const id = stableId("colmkt", accountId, normalizedSource, normalizedSourceIdentity, resolvedSnapshotKey);
    const result = await client.query(
      `INSERT INTO collector_market_snapshots (
         id,task_id,run_id,account_id,operating_store_id,data_collection_store_id,
         seller_company_id,source,snapshot_key,source_sku,product_id,category_id,
         period,period_start,period_end,request_id,content_hash,metrics,payload,collected_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18::jsonb,$19::jsonb,COALESCE($20::timestamptz,NOW())
       )
       ON CONFLICT (id) DO UPDATE SET
         task_id=EXCLUDED.task_id,run_id=EXCLUDED.run_id,
         source=EXCLUDED.source,
         source_sku=EXCLUDED.source_sku,product_id=EXCLUDED.product_id,
         category_id=EXCLUDED.category_id,period=EXCLUDED.period,
         period_start=EXCLUDED.period_start,period_end=EXCLUDED.period_end,
         request_id=EXCLUDED.request_id,content_hash=EXCLUDED.content_hash,
         metrics=EXCLUDED.metrics,payload=EXCLUDED.payload,
         collected_at=EXCLUDED.collected_at,updated_at=NOW()
       WHERE collector_market_snapshots.account_id=EXCLUDED.account_id
       RETURNING *`,
      [
        id, link.taskId, link.runId, accountId, null, null,
        "", normalizedSource, resolvedSnapshotKey,
        clean(sourceSku, 240), clean(productId, 240), clean(categoryId, 240),
        normalizedPeriod, periodStart || null, periodEnd || null, clean(requestId, 240),
        contentHash, JSON.stringify(normalizedMetrics), JSON.stringify(normalizedPayload),
        collectedAt || null,
      ],
    );
    return mapMarketSnapshot(result.rows[0]);
  });
}

export async function listCollectorMarketSnapshots({
  accountId,
  source = "ozon_seller_analytics",
  sourceIdentity = "",
  sourceSku = "",
  categoryId = "",
  period = "",
  limit = 500,
  offset = 0,
} = {}) {
  const pool = await poolReady();
  await validateAccountWithClient(pool, accountId);
  const normalizedPeriod = period ? normalizePeriod(period) : "";
  const result = await pool.query(
    `SELECT * FROM collector_market_snapshots
     WHERE account_id=$1 AND source=$2
       AND ($3='' OR COALESCE(NULLIF(payload->>'sourceIdentity',''),source)=$3)
       AND ($4='' OR source_sku=$4)
       AND ($5='' OR category_id=$5)
       AND ($6='' OR period=$6)
     ORDER BY collected_at DESC,id DESC LIMIT $7 OFFSET $8`,
    [
      required(accountId, "账号 ID"), clean(source || "ozon_seller_analytics", 120).toLowerCase(),
      clean(sourceIdentity, 500), clean(sourceSku, 240), clean(categoryId, 240), normalizedPeriod,
      boundedInteger(limit, { label: "分页数量", min: 1, max: 5000, fallback: 500 }),
      boundedInteger(offset, { label: "分页偏移", min: 0, max: 10_000_000, fallback: 0 }),
    ],
  );
  return result.rows.map(mapMarketSnapshot);
}

export async function upsertCollectorCategoryMapping({
  accountId,
  source = "ozon_seller_analytics",
  sourceIdentity = "",
  rootCategoryId,
  rootCategoryName = "",
  leafCategoryId,
  leafCategoryName = "",
  status = "ACTIVE",
  payload = {},
} = {}) {
  const normalizedSource = clean(source || "ozon_seller_analytics", 120).toLowerCase();
  const normalizedSourceIdentity = clean(sourceIdentity || normalizedSource, 500);
  const rootId = required(rootCategoryId, "一级类目 ID", 240);
  const leafId = required(leafCategoryId, "叶子类目 ID", 240);
  const normalizedStatus = normalizeStatus(status || "ACTIVE", ["ACTIVE", "DISABLED"], "类目映射状态");
  return transaction(async (client) => {
    await validateAccountWithClient(client, accountId);
    const id = stableId(
      "colcat",
      accountId,
      normalizedSource,
      normalizedSourceIdentity,
      rootId,
      leafId,
    );
    const result = await client.query(
      `INSERT INTO collector_category_mappings (
         id,account_id,operating_store_id,data_collection_store_id,source,
         root_category_id,root_category_name,leaf_category_id,leaf_category_name,
         status,payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         root_category_name=EXCLUDED.root_category_name,
         leaf_category_name=EXCLUDED.leaf_category_name,
         status=EXCLUDED.status,payload=EXCLUDED.payload,
         last_seen_at=NOW(),updated_at=NOW()
       WHERE collector_category_mappings.account_id=EXCLUDED.account_id
       RETURNING *`,
      [
        id, accountId, null, null, normalizedSource,
        rootId, clean(rootCategoryName, 500), leafId, clean(leafCategoryName, 500),
        normalizedStatus, JSON.stringify({
          ...withoutCollectorScope(jsonObject(payload, "类目映射")),
          sourceIdentity: normalizedSourceIdentity,
        }),
      ],
    );
    return mapCategoryMapping(result.rows[0]);
  });
}

export async function listCollectorCategoryMappings({
  accountId,
  source = "ozon_seller_analytics",
  sourceIdentity = "",
  rootCategoryId = "",
  status = "ACTIVE",
  limit = 5000,
} = {}) {
  const pool = await poolReady();
  await validateAccountWithClient(pool, accountId);
  const normalizedStatus = status
    ? normalizeStatus(status, ["ACTIVE", "DISABLED"], "类目映射状态")
    : "";
  const result = await pool.query(
    `SELECT * FROM collector_category_mappings
     WHERE account_id=$1 AND source=$2
       AND ($3='' OR COALESCE(NULLIF(payload->>'sourceIdentity',''),source)=$3)
       AND ($4='' OR root_category_id=$4) AND ($5='' OR status=$5)
     ORDER BY root_category_name,leaf_category_name,leaf_category_id LIMIT $6`,
    [
      required(accountId, "账号 ID"), clean(source || "ozon_seller_analytics", 120).toLowerCase(),
      clean(sourceIdentity, 500), clean(rootCategoryId, 240), normalizedStatus,
      boundedInteger(limit, { label: "分页数量", min: 1, max: 10_000, fallback: 5000 }),
    ],
  );
  return result.rows.map(mapCategoryMapping);
}

export async function collectorDesktopHealth(accountId) {
  if (!postgresEnabled()) return { ok: false, enabled: false, reason: "postgres_disabled" };
  try {
    const pool = await poolReady();
    const normalizedAccountId = required(accountId, "账号 ID");
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM collector_tasks WHERE account_id=$1 AND deleted_at IS NULL) AS task_count,
         (SELECT COUNT(*)::int FROM collector_task_runs WHERE account_id=$1 AND status IN ('QUEUED','RUNNING')) AS active_run_count,
         (SELECT COUNT(*)::int FROM collector_devices WHERE account_id=$1 AND status='ACTIVE') AS active_device_count`,
      [normalizedAccountId],
    );
    return {
      ok: true,
      enabled: true,
      taskCount: Number(result.rows[0].task_count),
      activeRunCount: Number(result.rows[0].active_run_count),
      activeDeviceCount: Number(result.rows[0].active_device_count),
    };
  } catch (error) {
    return { ok: false, enabled: true, reason: error.message };
  }
}
