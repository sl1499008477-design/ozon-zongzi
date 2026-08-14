import crypto from "node:crypto";

const HASH = /^[a-f0-9]{64}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const REQUEST_KEY = /^auto-listing-plan-[a-f0-9]{64}$/u;
const RESERVE_KEYS = new Set([
  "accountId", "jobId", "itemId", "sourceSnapshotId", "profileId", "profileVersion",
  "inputHash", "expectedStatusVersion", "requestKey", "planningContract",
]);
const SAVE_KEYS = new Set([
  ...RESERVE_KEYS,
  "reservationToken", "strategyVersionId", "sourceHash", "strategyHash", "configHash",
  "visualGroupsHash", "visualGroups", "factRegistryHash", "factRegistry",
  "plannerModel", "promptTemplateVersion", "regeneration",
  "gatewayRequestId", "plan", "planHash",
]);
const RELEASE_KEYS = new Set([
  "accountId", "jobId", "itemId", "inputHash", "expectedStatusVersion", "reservationToken", "errorCode",
]);
const LOAD_KEYS = new Set(["accountId", "jobId", "itemId", "expectedStatusVersion"]);
const DERIVED_COMMAND_KEYS = new Set(["scope", "derivedPlan"]);
const DERIVED_SCOPE_KEYS = new Set(["accountId", "jobId", "itemId", "parentPlanId", "expectedStatusVersion"]);
const DERIVED_PLAN_KEYS = new Set([
  "id", "sourceAccountId", "jobId", "itemId", "sourceSnapshotId", "strategyVersionId", "profileId",
  "strategyHash", "configHash", "sourceHash", "inputHash", "plannerModel", "profileVersion",
  "promptTemplateVersion", "plan", "planHash", "visualGroupsHash", "visualGroups", "factRegistry",
  "regeneration", "gatewayRequestId", "parentPlanId", "derivationKind", "materializationSetHash",
]);
const VISUAL_GROUPS_KEYS = new Set(["sourceHash", "groups", "reasonCodes", "visualGroupsHash"]);
const VISUAL_GROUP_KEYS = new Set([
  "visualGroupKey", "sourceSkus", "variantIds", "referenceImages", "factEvidence", "reasonCodes",
]);
const PERSISTED_REFERENCE_KEYS = new Set([
  "assetId", "sourceRefHash", "sourceRef", "contentHash", "evidenceKind",
]);
const KNOWN_ERRORS = new Set([
  "AUTO_LISTING_CONTENT_PLAN_REPOSITORY_INVALID",
  "AUTO_LISTING_CONTENT_PLAN_SCOPE_CONFLICT",
  "AUTO_LISTING_CONTENT_PLAN_STATUS_VERSION_CONFLICT",
  "AUTO_LISTING_CONTENT_PLAN_LEASE_CONFLICT",
  "AUTO_LISTING_CONTENT_PLAN_ATTEMPTS_EXHAUSTED",
  "AUTO_LISTING_CONTENT_PLAN_EVIDENCE_CONFLICT",
]);

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactObject = (value, keys) => plainObject(value)
  && Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const sha256 = (value) => crypto.createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(canonical(value))).digest("hex");
const containsUrlLikeText = (value) => typeof value === "string"
  ? /\b(?:https?|ftp|file|data):|(?:^|[\s"'(])\/\/[a-z0-9]/iu.test(value)
  : Array.isArray(value) ? value.some(containsUrlLikeText)
    : plainObject(value) ? Object.values(value).some(containsUrlLikeText) : false;

function repositoryError(code, message, retryable) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

const invalid = () => repositoryError(
  "AUTO_LISTING_CONTENT_PLAN_REPOSITORY_INVALID",
  "图片规划仓储请求无效",
  false,
);
const unavailable = () => repositoryError(
  "AUTO_LISTING_CONTENT_PLAN_REPOSITORY_FAILED",
  "图片规划仓储暂时不可用",
  true,
);
const scopeConflict = () => repositoryError(
  "AUTO_LISTING_CONTENT_PLAN_SCOPE_CONFLICT",
  "图片规划任务范围不一致",
  false,
);
const versionConflict = () => repositoryError(
  "AUTO_LISTING_CONTENT_PLAN_STATUS_VERSION_CONFLICT",
  "图片规划任务状态已变化",
  false,
);
const leaseConflict = () => repositoryError(
  "AUTO_LISTING_CONTENT_PLAN_LEASE_CONFLICT",
  "图片规划租约已失效",
  true,
);
const evidenceConflict = () => repositoryError(
  "AUTO_LISTING_CONTENT_PLAN_EVIDENCE_CONFLICT",
  "图片规划持久化证据不一致",
  false,
);

function clean(value, maxBytes = 240) {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= maxBytes && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeIdentifier(value) {
  if (!clean(value) || !/^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u.test(value) || value.includes("@")) return false;
  if (/(?:https?|ftp|file|data):|www\./iu.test(value)) return false;
  if (/(?:^|[._:-])(?:api[_-]?key|password|passwd|secret|bearer|authorization|cookie|credential|private[_-]?key|access[_-]?token|refresh[_-]?token)(?:$|[._:-])/iu.test(value)) return false;
  if (/^(?:sk-(?:proj-)?[a-z0-9_-]{8,}|AKIA[A-Z0-9]{16}|AIza[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{8,})$/iu.test(value)) return false;
  return true;
}

function safeEvidenceText(value) {
  return clean(value) && !/(?:https?|ftp|file|data):|www\.|\b(?:api[_-]?key|password|passwd|secret|bearer|authorization|cookie|credential|private[_-]?key|access[_-]?token|refresh[_-]?token)\b/iu.test(value)
    && !/^(?:sk-(?:proj-)?[a-z0-9_-]{8,}|AKIA[A-Z0-9]{16}|AIza[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{8,})$/iu.test(value);
}

function validVersion(value) {
  return Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function assertJsonSafe(value, active = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return;
  }
  if ((!Array.isArray(value) && !plainObject(value)) || active.has(value)) throw invalid();
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 1_000) throw invalid();
      value.forEach((entry) => assertJsonSafe(entry, active));
    } else {
      if (Object.keys(value).length > 2_000) throw invalid();
      for (const [key, entry] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw invalid();
        assertJsonSafe(entry, active);
      }
    }
  } finally {
    active.delete(value);
  }
}

function assertScope(input) {
  for (const key of ["accountId", "jobId", "itemId"]) if (!safeIdentifier(input[key])) throw invalid();
  if (!validVersion(input.expectedStatusVersion)) throw invalid();
}

function validateReserve(input) {
  if (!exactObject(input, RESERVE_KEYS)) throw invalid();
  assertScope(input);
  if (!safeIdentifier(input.sourceSnapshotId) || !safeIdentifier(input.profileId)
    || !["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1"].includes(input.planningContract)
    || !Number.isInteger(input.profileVersion) || input.profileVersion < 1
    || !HASH.test(input.inputHash || "") || !REQUEST_KEY.test(input.requestKey || "")) throw invalid();
  return input;
}

function validateSave(input) {
  if (!exactObject(input, SAVE_KEYS)) throw invalid();
  validateReserve(Object.fromEntries([...RESERVE_KEYS].map((key) => [key, input[key]])));
  for (const key of ["reservationToken", "strategyVersionId"]) {
    if (!safeIdentifier(input[key])) throw invalid();
  }
  if (!safeEvidenceText(input.plannerModel) || !safeEvidenceText(input.promptTemplateVersion)) throw invalid();
  for (const key of ["sourceHash", "strategyHash", "configHash", "visualGroupsHash", "factRegistryHash", "planHash"]) {
    if (!HASH.test(input[key] || "")) throw invalid();
  }
  if (!plainObject(input.visualGroups) || !Array.isArray(input.factRegistry) || input.factRegistry.length < 1
    || input.factRegistry.length > 10_000 || !plainObject(input.plan)
    || !(input.regeneration === null || plainObject(input.regeneration))
    || !(input.gatewayRequestId === null || safeEvidenceText(input.gatewayRequestId))) throw invalid();
  assertJsonSafe(input.visualGroups);
  assertJsonSafe(input.factRegistry);
  assertJsonSafe(input.plan);
  assertJsonSafe(input.regeneration);
  if (Buffer.byteLength(JSON.stringify(input.visualGroups), "utf8") > 1_048_576
    || Buffer.byteLength(JSON.stringify(input.plan), "utf8") > 1_048_576
    || sha256(input.plan) !== input.planHash
    || sha256(input.factRegistry) !== input.factRegistryHash
    || input.visualGroups.visualGroupsHash !== input.visualGroupsHash) throw evidenceConflict();
  validatePersistedVisualGroups(input.visualGroups, { derived: false });
  return input;
}

function validatePersistedVisualGroups(value, { derived }) {
  if (!exactObject(value, VISUAL_GROUPS_KEYS) || !HASH.test(value.sourceHash || "")
    || !HASH.test(value.visualGroupsHash || "") || !Array.isArray(value.groups) || value.groups.length < 1
    || !Array.isArray(value.reasonCodes) || containsUrlLikeText(value)) throw evidenceConflict();
  for (const group of value.groups) {
    if (!exactObject(group, VISUAL_GROUP_KEYS) || !safeIdentifier(group.visualGroupKey)
      || !Array.isArray(group.sourceSkus) || !Array.isArray(group.variantIds)
      || !Array.isArray(group.referenceImages) || group.referenceImages.length < 1
      || !Array.isArray(group.factEvidence) || !Array.isArray(group.reasonCodes)) throw evidenceConflict();
    for (const reference of group.referenceImages) {
      if (!exactObject(reference, PERSISTED_REFERENCE_KEYS) || !safeIdentifier(reference.assetId)
        || reference.sourceRef !== null || !["SOURCE_REF_HASH", "CONTENT_HASH"].includes(reference.evidenceKind)) {
        throw evidenceConflict();
      }
      if (reference.evidenceKind === "SOURCE_REF_HASH") {
        if (derived || !HASH.test(reference.sourceRefHash || "") || reference.contentHash !== null) throw evidenceConflict();
      } else if (!HASH.test(reference.contentHash || "")
        || !(reference.sourceRefHash === null || HASH.test(reference.sourceRefHash || ""))) throw evidenceConflict();
    }
  }
}

function validateRelease(input) {
  if (!exactObject(input, RELEASE_KEYS)) throw invalid();
  assertScope(input);
  if (!HASH.test(input.inputHash || "") || !safeIdentifier(input.reservationToken)
    || !ERROR_CODE.test(input.errorCode || "")) throw invalid();
  return input;
}

function validateLoad(input) {
  if (!exactObject(input, LOAD_KEYS)) throw invalid();
  assertScope(input);
  return input;
}

function validateDerivedCommand(input) {
  if (!exactObject(input, DERIVED_COMMAND_KEYS) || !exactObject(input.scope, DERIVED_SCOPE_KEYS)
    || !exactObject(input.derivedPlan, DERIVED_PLAN_KEYS)) throw invalid();
  const { scope, derivedPlan } = input;
  assertScope(scope);
  if (!safeIdentifier(scope.parentPlanId)
    || !["id", "sourceAccountId", "jobId", "itemId", "sourceSnapshotId", "strategyVersionId", "profileId",
      "parentPlanId"].every((key) => safeIdentifier(derivedPlan[key]))
    || !safeEvidenceText(derivedPlan.plannerModel) || !safeEvidenceText(derivedPlan.promptTemplateVersion)
    || derivedPlan.sourceAccountId !== scope.accountId || derivedPlan.jobId !== scope.jobId
    || derivedPlan.itemId !== scope.itemId || derivedPlan.parentPlanId !== scope.parentPlanId
    || derivedPlan.id === derivedPlan.parentPlanId || derivedPlan.derivationKind !== "SOURCE_MATERIALIZATION"
    || !Number.isInteger(derivedPlan.profileVersion) || derivedPlan.profileVersion < 1
    || !["strategyHash", "configHash", "sourceHash", "inputHash", "planHash", "visualGroupsHash", "materializationSetHash"]
      .every((key) => HASH.test(derivedPlan[key] || ""))
    || !plainObject(derivedPlan.plan) || !plainObject(derivedPlan.visualGroups)
    || !Array.isArray(derivedPlan.factRegistry) || derivedPlan.factRegistry.length < 1
    || derivedPlan.factRegistry.length > 10_000
    || !(derivedPlan.regeneration === null || plainObject(derivedPlan.regeneration))
    || !(derivedPlan.gatewayRequestId === null || safeEvidenceText(derivedPlan.gatewayRequestId))) throw invalid();
  assertJsonSafe(derivedPlan);
  const serializedVisualGroups = JSON.stringify(derivedPlan.visualGroups);
  if (sha256(derivedPlan.plan) !== derivedPlan.planHash
    || derivedPlan.visualGroups.visualGroupsHash !== derivedPlan.visualGroupsHash
    || Buffer.byteLength(serializedVisualGroups, "utf8") > 1_048_576
    || /"evidenceKind"\s*:\s*"SOURCE_URL"|"sourceRef"\s*:\s*"https?:/iu.test(serializedVisualGroups)) {
    throw evidenceConflict();
  }
  validatePersistedVisualGroups(derivedPlan.visualGroups, { derived: true });
  return input;
}

function assertParentMatchesDerived(row, scope, derived) {
  const parent = mapRow(row);
  if (!parent || parent.id !== scope.parentPlanId || parent.accountId !== scope.accountId
    || parent.jobId !== scope.jobId || parent.itemId !== scope.itemId
    || parent.sourceSnapshotId !== derived.sourceSnapshotId
    || parent.strategyVersionId !== derived.strategyVersionId || parent.profileId !== derived.profileId
    || parent.profileVersion !== derived.profileVersion || parent.strategyHash !== derived.strategyHash
    || parent.configHash !== derived.configHash || parent.sourceHash !== derived.sourceHash
    || parent.plannerModel !== derived.plannerModel || parent.promptTemplateVersion !== derived.promptTemplateVersion
    || parent.planHash !== derived.planHash
    || JSON.stringify(canonical(parent.plan)) !== JSON.stringify(canonical(derived.plan))
    || JSON.stringify(canonical(parent.factRegistry)) !== JSON.stringify(canonical(derived.factRegistry))
    || parent.factRegistryHash !== sha256(derived.factRegistry)
    || JSON.stringify(canonical(parent.regeneration)) !== JSON.stringify(canonical(derived.regeneration))
    || parent.gatewayRequestId !== derived.gatewayRequestId
    || parent.parentPlanId !== null || parent.derivationKind !== null || parent.materializationSetHash !== null) {
    throw evidenceConflict();
  }
  return parent;
}

function assertDerivedStoredRow(row, scope, derived) {
  const stored = mapRow(row);
  if (!stored || stored.id !== derived.id || stored.derivedPlanId !== derived.id
    || stored.accountId !== scope.accountId || stored.jobId !== scope.jobId || stored.itemId !== scope.itemId
    || stored.sourceSnapshotId !== derived.sourceSnapshotId
    || stored.strategyVersionId !== derived.strategyVersionId || stored.profileId !== derived.profileId
    || stored.profileVersion !== derived.profileVersion || stored.strategyHash !== derived.strategyHash
    || stored.configHash !== derived.configHash || stored.sourceHash !== derived.sourceHash
    || stored.inputHash !== derived.inputHash || stored.plannerModel !== derived.plannerModel
    || stored.promptTemplateVersion !== derived.promptTemplateVersion || stored.planHash !== derived.planHash
    || stored.visualGroupsHash !== derived.visualGroupsHash
    || stored.factRegistryHash !== sha256(derived.factRegistry)
    || stored.gatewayRequestId !== derived.gatewayRequestId || stored.parentPlanId !== derived.parentPlanId
    || stored.derivationKind !== derived.derivationKind
    || stored.materializationSetHash !== derived.materializationSetHash
    || JSON.stringify(canonical(stored.plan)) !== JSON.stringify(canonical(derived.plan))
    || JSON.stringify(canonical(stored.visualGroups)) !== JSON.stringify(canonical(derived.visualGroups))
    || JSON.stringify(canonical(stored.factRegistry)) !== JSON.stringify(canonical(derived.factRegistry))
    || JSON.stringify(canonical(stored.regeneration)) !== JSON.stringify(canonical(derived.regeneration))) {
    throw evidenceConflict();
  }
  return stored;
}

function mapRow(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase()),
    value,
  ]));
}

function isKnown(error) {
  return KNOWN_ERRORS.has(error?.code);
}

async function rollback(client) {
  try { await client?.query("ROLLBACK"); } catch {}
}

function release(client) {
  try {
    const result = client?.release?.();
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {}
}

function assertItemBoundary(row, input) {
  if (!row || row.id !== input.itemId || row.snapshot_id !== input.sourceSnapshotId) throw scopeConflict();
  if (row.planning_contract !== input.planningContract) throw scopeConflict();
  if (row.status !== "PLANNING" || row.status_version !== input.expectedStatusVersion) throw versionConflict();
}

function assertStoredRow(row, input) {
  const mapped = mapRow(row);
  if (!mapped || mapped.accountId !== input.accountId || mapped.jobId !== input.jobId
    || mapped.itemId !== input.itemId || mapped.sourceSnapshotId !== input.sourceSnapshotId
    || mapped.planningContract !== input.planningContract
    || mapped.strategyVersionId !== input.strategyVersionId || mapped.profileId !== input.profileId
    || mapped.profileVersion !== input.profileVersion || mapped.inputHash !== input.inputHash
    || mapped.sourceHash !== input.sourceHash || mapped.strategyHash !== input.strategyHash
    || mapped.configHash !== input.configHash || mapped.visualGroupsHash !== input.visualGroupsHash
    || mapped.factRegistryHash !== input.factRegistryHash
    || mapped.plannerModel !== input.plannerModel || mapped.promptTemplateVersion !== input.promptTemplateVersion
    || mapped.gatewayRequestId !== input.gatewayRequestId || mapped.planHash !== input.planHash
    || JSON.stringify(canonical(mapped.visualGroups)) !== JSON.stringify(canonical(input.visualGroups))
    || JSON.stringify(canonical(mapped.factRegistry)) !== JSON.stringify(canonical(input.factRegistry))
    || JSON.stringify(canonical(mapped.regeneration)) !== JSON.stringify(canonical(input.regeneration))
    || JSON.stringify(canonical(mapped.plan)) !== JSON.stringify(canonical(input.plan))
    || mapped.parentPlanId !== null || mapped.derivationKind !== null || mapped.materializationSetHash !== null) {
    throw evidenceConflict();
  }
  return mapped;
}

export function createPostgresContentPlanRepository({
  pool,
  leaseMs = 120_000,
  maxAttempts = 3,
  token = () => crypto.randomUUID(),
  id = () => `plan-attempt-${crypto.randomUUID()}`,
  planId = () => `plan-${crypto.randomUUID()}`,
  derivationId = () => `plan-derivation-${crypto.randomUUID()}`,
  leaseOwner = "auto-listing-content-planner",
} = {}) {
  if (!pool || typeof pool.connect !== "function" || !Number.isInteger(leaseMs) || leaseMs < 1
    || leaseMs > 900_000 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3
    || typeof token !== "function" || typeof id !== "function" || typeof planId !== "function"
    || typeof derivationId !== "function"
    || !safeIdentifier(leaseOwner)) throw invalid();

  async function reserveContentPlan(rawInput) {
    const input = validateReserve(rawInput);
    const leaseToken = token();
    const attemptId = id();
    if (!safeIdentifier(leaseToken) || !safeIdentifier(attemptId)) throw invalid();
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const boundary = await client.query(
        `SELECT id,snapshot_id,status,status_version,active_content_plan_id,planning_contract
           FROM auto_listing_job_items
          WHERE account_id=$1 AND job_id=$2 AND id=$3
          FOR UPDATE`,
        [input.accountId, input.jobId, input.itemId],
      );
      assertItemBoundary(boundary.rows[0], input);

      if (boundary.rows[0].active_content_plan_id) {
        const existingActive = await client.query(
          `SELECT p.* FROM ai_content_plans p
            WHERE p.account_id=$1 AND p.job_id=$2 AND p.item_id=$3
              AND p.id=$4 AND p.input_hash=$5`,
          [input.accountId, input.jobId, input.itemId, boundary.rows[0].active_content_plan_id, input.inputHash],
        );
        if (existingActive.rows[0]) {
          await client.query("COMMIT");
          return { status: "EXISTING", record: mapRow(existingActive.rows[0]) };
        }
      }

      await client.query(
        `UPDATE auto_listing_content_plan_attempts
            SET status='FAILED',error_code='LEASE_EXPIRED',error_retryable=TRUE,
                lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3
            AND status='PLANNING' AND lease_expires_at <= NOW()`,
        [input.accountId, input.jobId, input.itemId],
      );
      const accepted = await client.query(
        `SELECT a.accepted_plan_id,p.*
           FROM auto_listing_content_plan_attempts a
           JOIN ai_content_plans p
             ON p.account_id=a.account_id AND p.job_id=a.job_id AND p.item_id=a.item_id
            AND p.id=a.accepted_plan_id
          WHERE a.account_id=$1 AND a.job_id=$2 AND a.item_id=$3 AND a.input_hash=$4
            AND a.planning_contract=$5 AND a.status='ACCEPTED'`,
        [input.accountId, input.jobId, input.itemId, input.inputHash, input.planningContract],
      );
      if (accepted.rows[0]) {
        if (boundary.rows[0].active_content_plan_id !== accepted.rows[0].accepted_plan_id) throw evidenceConflict();
        await client.query("COMMIT");
        return { status: "EXISTING", record: mapRow(accepted.rows[0]) };
      }
      const active = await client.query(
        `SELECT id,input_hash FROM auto_listing_content_plan_attempts
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3
            AND planning_contract=$4 AND status='PLANNING' AND lease_expires_at > NOW()`,
        [input.accountId, input.jobId, input.itemId, input.planningContract],
      );
      if (active.rowCount > 0) {
        await client.query("COMMIT");
        return { status: "IN_PROGRESS" };
      }
      const attempts = await client.query(
        `SELECT COALESCE(MAX(attempt_no),0)::INTEGER AS max_attempt_no
           FROM auto_listing_content_plan_attempts
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND input_hash=$4`,
        [input.accountId, input.jobId, input.itemId, input.inputHash],
      );
      const attemptNo = Number(attempts.rows[0]?.max_attempt_no || 0) + 1;
      if (attemptNo > maxAttempts) {
        throw repositoryError("AUTO_LISTING_CONTENT_PLAN_ATTEMPTS_EXHAUSTED", "图片规划重试次数已用完", false);
      }
      await client.query(
        `INSERT INTO auto_listing_content_plan_attempts (
           id,account_id,job_id,item_id,source_snapshot_id,profile_id,profile_version,input_hash,
           expected_status_version,request_key,attempt_no,status,lease_owner,lease_token,lease_expires_at,
           planning_contract,planner_stage
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PLANNING',$12,$13,
           NOW() + ($14 * INTERVAL '1 millisecond'),$15,$16)`,
        [attemptId, input.accountId, input.jobId, input.itemId, input.sourceSnapshotId,
          input.profileId, input.profileVersion, input.inputHash, input.expectedStatusVersion,
          input.requestKey, attemptNo, leaseOwner, leaseToken, leaseMs, input.planningContract,
          input.planningContract === "LEGACY_FULL_PLAN_V3" ? "FILLING_COPY" : "BUILDING_SKELETON"],
      );
      await client.query("COMMIT");
      return { status: "RESERVED", attemptNo, reservationToken: leaseToken, inputHash: input.inputHash };
    } catch (error) {
      await rollback(client);
      if (isKnown(error) || error?.code === "AUTO_LISTING_CONTENT_PLAN_ATTEMPTS_EXHAUSTED") throw error;
      throw unavailable();
    } finally {
      release(client);
    }
  }

  async function saveContentPlan(rawInput) {
    const input = validateSave(rawInput);
    const nextPlanId = planId();
    if (!safeIdentifier(nextPlanId)) throw invalid();
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const boundary = await client.query(
        `SELECT id,snapshot_id,status,status_version,active_content_plan_id,planning_contract
           FROM auto_listing_job_items
          WHERE account_id=$1 AND job_id=$2 AND id=$3
          FOR UPDATE`,
        [input.accountId, input.jobId, input.itemId],
      );
      assertItemBoundary(boundary.rows[0], input);
      const attempt = await client.query(
        `SELECT id,attempt_no,status,lease_token,lease_expires_at,expected_status_version,request_key,planning_contract
           FROM auto_listing_content_plan_attempts
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND source_snapshot_id=$4
            AND profile_id=$5 AND profile_version=$6 AND input_hash=$7
            AND expected_status_version=$8 AND request_key=$9 AND planning_contract=$11
            AND status='PLANNING' AND lease_token=$10 AND lease_expires_at > NOW()
          FOR UPDATE`,
        [input.accountId, input.jobId, input.itemId, input.sourceSnapshotId, input.profileId,
          input.profileVersion, input.inputHash, input.expectedStatusVersion, input.requestKey,
          input.reservationToken, input.planningContract],
      );
      if (attempt.rowCount !== 1) throw leaseConflict();
      const inserted = await client.query(
        `INSERT INTO ai_content_plans (
           id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
           strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
           prompt_template_version,plan,plan_hash,visual_groups_hash,visual_groups,fact_registry_hash,fact_registry,regeneration,
           gateway_request_id,parent_plan_id,derivation_kind,materialization_set_hash,planning_contract
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::JSONB,$16,$17,$18::JSONB,$19,$20::JSONB,$21::JSONB,$22,NULL,NULL,NULL,$23)
         RETURNING *`,
        [nextPlanId, input.accountId, input.jobId, input.itemId, input.sourceSnapshotId,
          input.strategyVersionId, input.profileId, input.strategyHash, input.configHash,
          input.sourceHash, input.inputHash, input.plannerModel, input.profileVersion,
          input.promptTemplateVersion, JSON.stringify(input.plan), input.planHash,
          input.visualGroupsHash, JSON.stringify(input.visualGroups),
          input.factRegistryHash, JSON.stringify(input.factRegistry),
          input.regeneration === null ? null : JSON.stringify(input.regeneration), input.gatewayRequestId,
          input.planningContract],
      );
      if (inserted.rowCount !== 1) throw evidenceConflict();
      const accepted = await client.query(
        `UPDATE auto_listing_content_plan_attempts
            SET status='ACCEPTED',accepted_plan_id=$11,accepted_at=NOW(),planner_stage='COMPLETED',
                lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND source_snapshot_id=$4
            AND profile_id=$5 AND profile_version=$6 AND input_hash=$7
            AND expected_status_version=$8 AND request_key=$9 AND planning_contract=$12
            AND status='PLANNING' AND lease_token=$10 AND lease_expires_at > NOW()
          RETURNING id`,
        [input.accountId, input.jobId, input.itemId, input.sourceSnapshotId, input.profileId,
          input.profileVersion, input.inputHash, input.expectedStatusVersion, input.requestKey,
          input.reservationToken, nextPlanId, input.planningContract],
      );
      if (accepted.rowCount !== 1) throw leaseConflict();
      const switched = await client.query(
        `UPDATE auto_listing_job_items
            SET active_content_plan_id=$4,updated_at=NOW()
          WHERE account_id=$1 AND job_id=$2 AND id=$3 AND snapshot_id=$5
            AND status='PLANNING' AND status_version=$6
          RETURNING id`,
        [input.accountId, input.jobId, input.itemId, nextPlanId,
          input.sourceSnapshotId, input.expectedStatusVersion],
      );
      if (switched.rowCount !== 1) throw versionConflict();
      const record = assertStoredRow(inserted.rows[0], input);
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await rollback(client);
      if (isKnown(error)) throw error;
      throw unavailable();
    } finally {
      release(client);
    }
  }

  async function releaseContentPlanReservation(rawInput) {
    const input = validateRelease(rawInput);
    try {
      const result = await pool.connect();
      try {
        const released = await result.query(
          `UPDATE auto_listing_content_plan_attempts a
              SET status='FAILED',planner_stage='FAILED',error_code=$7,error_retryable=TRUE,
                  lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
            WHERE a.account_id=$1 AND a.job_id=$2 AND a.item_id=$3 AND a.input_hash=$4
              AND a.expected_status_version=$5 AND a.status='PLANNING' AND a.lease_token=$6
              AND EXISTS (
                SELECT 1 FROM auto_listing_job_items i
                 WHERE i.account_id=a.account_id AND i.job_id=a.job_id AND i.id=a.item_id
                   AND i.status_version=$5
              )
            RETURNING a.id`,
          [input.accountId, input.jobId, input.itemId, input.inputHash,
            input.expectedStatusVersion, input.reservationToken, input.errorCode],
        );
        return { released: released.rowCount === 1 };
      } finally {
        release(result);
      }
    } catch (error) {
      if (isKnown(error)) throw error;
      throw unavailable();
    }
  }

  async function loadActiveContentPlan(rawInput) {
    const input = validateLoad(rawInput);
    let client;
    try {
      client = await pool.connect();
      const result = await client.query(
        `SELECT p.*
           FROM auto_listing_job_items i
           JOIN ai_content_plans p
             ON p.account_id=i.account_id AND p.job_id=i.job_id AND p.item_id=i.id
            AND p.id=i.active_content_plan_id
          WHERE i.account_id=$1 AND i.job_id=$2 AND i.id=$3 AND i.status_version=$4`,
        [input.accountId, input.jobId, input.itemId, input.expectedStatusVersion],
      );
      return mapRow(result.rows[0]);
    } catch {
      throw unavailable();
    } finally {
      release(client);
    }
  }

  async function createDerivedMaterializedPlan(rawInput) {
    const { scope, derivedPlan } = validateDerivedCommand(rawInput);
    const relationId = derivationId();
    if (!safeIdentifier(relationId)) throw invalid();
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const boundary = await client.query(
        `SELECT id,snapshot_id,status,status_version,active_content_plan_id
           FROM auto_listing_job_items
          WHERE account_id=$1 AND job_id=$2 AND id=$3
          FOR UPDATE`,
        [scope.accountId, scope.jobId, scope.itemId],
      );
      const item = boundary.rows[0];
      if (!item || item.id !== scope.itemId) throw scopeConflict();
      if (item.status !== "PLANNING" || item.status_version !== scope.expectedStatusVersion) throw versionConflict();

      const existing = await client.query(
        `SELECT d.derived_plan_id,p.*
           FROM auto_listing_content_plan_derivations d
           JOIN ai_content_plans p
             ON p.account_id=d.account_id AND p.job_id=d.job_id AND p.item_id=d.item_id
            AND p.id=d.derived_plan_id
          WHERE d.account_id=$1 AND d.job_id=$2 AND d.item_id=$3 AND d.parent_plan_id=$4
            AND d.materialization_set_hash=$5`,
        [scope.accountId, scope.jobId, scope.itemId, scope.parentPlanId, derivedPlan.materializationSetHash],
      );
      if (existing.rows[0]) {
        if (item.active_content_plan_id !== existing.rows[0].derived_plan_id
          || existing.rows[0].derived_plan_id !== derivedPlan.id) throw evidenceConflict();
        assertDerivedStoredRow(existing.rows[0], scope, derivedPlan);
        await client.query("COMMIT");
        return structuredClone(derivedPlan);
      }
      if (item.active_content_plan_id !== scope.parentPlanId) throw evidenceConflict();
      const parent = await client.query(
        `SELECT * FROM ai_content_plans
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND id=$4
          FOR SHARE`,
        [scope.accountId, scope.jobId, scope.itemId, scope.parentPlanId],
      );
      assertParentMatchesDerived(parent.rows[0], scope, derivedPlan);
      const factRegistryHash = sha256(derivedPlan.factRegistry);
      const inserted = await client.query(
        `INSERT INTO ai_content_plans (
           id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
           strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
           prompt_template_version,plan,plan_hash,visual_groups_hash,visual_groups,fact_registry_hash,fact_registry,
           regeneration,gateway_request_id,parent_plan_id,derivation_kind,materialization_set_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::JSONB,$16,$17,$18::JSONB,$19,$20::JSONB,$21::JSONB,$22,$23,$24,$25)
         RETURNING id`,
        [derivedPlan.id, scope.accountId, scope.jobId, scope.itemId, derivedPlan.sourceSnapshotId,
          derivedPlan.strategyVersionId, derivedPlan.profileId, derivedPlan.strategyHash,
          derivedPlan.configHash, derivedPlan.sourceHash, derivedPlan.inputHash, derivedPlan.plannerModel,
          derivedPlan.profileVersion, derivedPlan.promptTemplateVersion, JSON.stringify(derivedPlan.plan),
          derivedPlan.planHash, derivedPlan.visualGroupsHash, JSON.stringify(derivedPlan.visualGroups),
          factRegistryHash, JSON.stringify(derivedPlan.factRegistry),
          derivedPlan.regeneration === null ? null : JSON.stringify(derivedPlan.regeneration),
          derivedPlan.gatewayRequestId, scope.parentPlanId, derivedPlan.derivationKind,
          derivedPlan.materializationSetHash],
      );
      if (inserted.rowCount !== 1 || inserted.rows[0]?.id !== derivedPlan.id) throw evidenceConflict();
      const relation = await client.query(
        `INSERT INTO auto_listing_content_plan_derivations (
           id,account_id,job_id,item_id,parent_plan_id,derived_plan_id,materialization_set_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [relationId, scope.accountId, scope.jobId, scope.itemId, scope.parentPlanId,
          derivedPlan.id, derivedPlan.materializationSetHash],
      );
      if (relation.rowCount !== 1) throw evidenceConflict();
      const switched = await client.query(
        `UPDATE auto_listing_job_items
            SET active_content_plan_id=$6,updated_at=NOW()
          WHERE account_id=$1 AND job_id=$2 AND id=$3 AND active_content_plan_id=$4
            AND status='PLANNING' AND status_version=$5
          RETURNING id`,
        [scope.accountId, scope.jobId, scope.itemId, scope.parentPlanId,
          scope.expectedStatusVersion, derivedPlan.id],
      );
      if (switched.rowCount !== 1) throw versionConflict();
      await client.query("COMMIT");
      return structuredClone(derivedPlan);
    } catch (error) {
      await rollback(client);
      if (isKnown(error)) throw error;
      throw unavailable();
    } finally {
      release(client);
    }
  }

  return Object.freeze({
    reserveContentPlan,
    saveContentPlan,
    releaseContentPlanReservation,
    loadActiveContentPlan,
    createDerivedMaterializedPlan,
  });
}
