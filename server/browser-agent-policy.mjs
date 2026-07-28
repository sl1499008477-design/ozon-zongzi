export const CLAIM_TTL_MS = 300_000;

const EXECUTABLE_TYPES = new Set([
  "collect.hot_products",
  "collect.product_detail",
  "ozon.collect_variant",
  "ozon.market_data",
  "listing.create_draft",
  "listing.publish_draft",
]);

const RETRYABLE_AFTER_TIMEOUT = new Set([
  "collect.hot_products",
  "collect.product_detail",
  "ozon.collect_variant",
  "ozon.market_data",
  "listing.create_draft",
]);

const ACTION_STATUS = {
  progress: "RUNNING",
  result: "SUCCESS",
  fail: "FAILED",
};

const ALLOWED_FROM = {
  progress: new Set(["PROCESSING", "RUNNING"]),
  result: new Set(["RUNNING"]),
  fail: new Set(["PROCESSING", "RUNNING"]),
};

const SERVER_OWNED_FIELDS = new Set([
  "id",
  "accountId",
  "createdBy",
  "storeId",
  "status",
  "claimedByDeviceId",
  "claimExpiresAt",
  "claimAttempt",
  "createdAt",
  "updatedAt",
  "deviceId",
  "completedByDeviceId",
  "completedAt",
]);

function policyError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizedStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function accountOwnsStore(state, accountId, storeId) {
  if (!storeId) return false;
  return (state.stores || []).some((store) => (
    String(store.id || "") === String(storeId)
    && String(store.ownerAccountId || "") === String(accountId)
  ));
}

function ownedBrowserAgent(state, accountId, deviceId) {
  const agent = state.browserAgents?.[deviceId] || null;
  if (!agent || String(agent.accountId || "") !== String(accountId)) {
    throw policyError(404, "BROWSER_AGENT_NOT_FOUND", "浏览器执行设备不存在");
  }
  return agent;
}

export function ownedBrowserAgentJob(state, { accountId, jobId }) {
  const job = state.jobs?.[jobId] || null;
  if (
    !job
    || String(job.accountId || "") !== String(accountId)
    || !accountOwnsStore(state, accountId, job.storeId)
  ) {
    throw policyError(404, "BROWSER_AGENT_JOB_NOT_FOUND", "浏览器任务不存在");
  }
  return job;
}

export function claimNextBrowserAgentJob(state, {
  accountId,
  deviceId,
  nowMs = Date.now(),
}) {
  ownedBrowserAgent(state, accountId, deviceId);
  const now = new Date(nowMs).toISOString();
  for (const job of Object.values(state.jobs || {})) {
    const status = normalizedStatus(job.status);
    const expiresAt = Date.parse(job.claimExpiresAt || "");
    const expired = Number.isFinite(expiresAt) && expiresAt <= nowMs;
    if (
      String(job.accountId || "") !== String(accountId)
      || !accountOwnsStore(state, accountId, job.storeId)
      || !["PROCESSING", "RUNNING"].includes(status)
      || !expired
    ) {
      continue;
    }
    job.claimedByDeviceId = "";
    job.claimExpiresAt = "";
    job.lastClaimExpiredAt = now;
    job.updatedAt = now;
    if (RETRYABLE_AFTER_TIMEOUT.has(job.type)) {
      job.status = "PENDING";
    } else {
      job.status = "RECONCILING";
      job.reconciliationReason = "CLAIM_EXPIRED_AFTER_POSSIBLE_EXTERNAL_WRITE";
    }
    state.jobs[job.id] = job;
  }
  const pending = Object.values(state.jobs || {}).find((job) => (
    EXECUTABLE_TYPES.has(job.type)
    && String(job.accountId || "") === String(accountId)
    && accountOwnsStore(state, accountId, job.storeId)
    && normalizedStatus(job.status) === "PENDING"
  )) || null;
  if (!pending) return null;

  pending.status = "PROCESSING";
  pending.claimedByDeviceId = deviceId;
  pending.claimExpiresAt = new Date(nowMs + CLAIM_TTL_MS).toISOString();
  pending.claimAttempt = Math.max(0, Number(pending.claimAttempt) || 0) + 1;
  pending.updatedAt = now;
  state.jobs[pending.id] = pending;
  return pending;
}

function requestControlledPatch(patch = {}) {
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => !SERVER_OWNED_FIELDS.has(key)),
  );
}

export function sanitizeBrowserAgentJobPayload(payload = {}) {
  return requestControlledPatch(payload);
}

export function transitionBrowserAgentJob(state, {
  accountId,
  deviceId,
  jobId,
  action,
  patch = {},
  nowMs = Date.now(),
}) {
  ownedBrowserAgent(state, accountId, deviceId);
  const previous = ownedBrowserAgentJob(state, { accountId, jobId });
  const fromStatus = normalizedStatus(previous.status);
  const nextStatus = ACTION_STATUS[action];
  if (!nextStatus || !ALLOWED_FROM[action]?.has(fromStatus)) {
    throw policyError(409, "BROWSER_AGENT_JOB_STATUS_CONFLICT", "浏览器任务状态不允许当前操作");
  }
  if (String(previous.claimedByDeviceId || "") !== String(deviceId)) {
    throw policyError(409, "BROWSER_AGENT_JOB_DEVICE_CONFLICT", "浏览器任务已由其他设备领取");
  }

  const now = new Date(nowMs).toISOString();
  const terminal = action === "result" || action === "fail";
  const job = {
    ...previous,
    ...requestControlledPatch(patch),
    id: previous.id,
    accountId: previous.accountId,
    createdBy: previous.createdBy,
    storeId: previous.storeId,
    status: nextStatus,
    claimedByDeviceId: terminal ? "" : deviceId,
    claimExpiresAt: terminal ? "" : new Date(nowMs + CLAIM_TTL_MS).toISOString(),
    claimAttempt: previous.claimAttempt,
    createdAt: previous.createdAt,
    updatedAt: now,
    ...(terminal ? { completedByDeviceId: deviceId, completedAt: now } : {}),
  };
  state.jobs[jobId] = job;
  return { job, fromStatus, toStatus: nextStatus };
}
