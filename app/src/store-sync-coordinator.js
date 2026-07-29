export const STORE_SYNC_TYPES = Object.freeze([
  "WAREHOUSES",
  "PRODUCTS",
  "POSTINGS",
  "PROMOTIONS",
]);

const supportedTypes = new Set(STORE_SYNC_TYPES);

function syncId(prefix) {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function requestedTypes(types) {
  const requested = Array.isArray(types) ? types : STORE_SYNC_TYPES;
  const normalized = [...new Set(requested.map((type) => String(type || "").toUpperCase()))];
  for (const type of normalized) {
    if (!supportedTypes.has(type)) {
      throw Object.assign(new Error(`不支持的店铺同步类型: ${type || "(empty)"}`), {
        code: "STORE_SYNC_TYPE_UNSUPPORTED",
      });
    }
  }
  return normalized;
}

function snapshot(states) {
  return structuredClone(states);
}

function publicError(error, {
  storeId,
  type,
  taskId,
  requestId,
}) {
  const body = error?.body && typeof error.body === "object" ? error.body : {};
  return {
    accountId: String(body.accountId || ""),
    storeId: String(body.storeId || storeId),
    type: String(body.type || type),
    timestamp: String(body.timestamp || new Date().toISOString()),
    taskId: String(body.taskId || taskId),
    requestId: String(body.requestId || requestId),
    code: String(body.code || error?.code || "STORE_SYNC_FAILED"),
    message: String(body.message || "店铺同步失败"),
    details: body.details && typeof body.details === "object"
      ? structuredClone(body.details)
      : {},
  };
}

export async function runBackendStoreSync({
  storeId,
  types = STORE_SYNC_TYPES,
  request,
  onState = () => {},
} = {}) {
  const normalizedStoreId = String(storeId || "").trim();
  if (!normalizedStoreId) {
    throw Object.assign(new Error("店铺同步需要 storeId"), {
      code: "STORE_SYNC_STORE_REQUIRED",
    });
  }
  if (typeof request !== "function") {
    throw new TypeError("店铺同步需要 request(path, options)");
  }
  if (typeof onState !== "function") {
    throw new TypeError("店铺同步 onState 必须是函数");
  }

  const states = requestedTypes(types).map((type) => ({
    type,
    status: "PENDING",
    taskId: syncId("store-sync-task"),
    result: null,
    error: null,
  }));
  onState(snapshot(states));

  for (const state of states) {
    const requestId = syncId("store-sync-request");
    state.status = "RUNNING";
    onState(snapshot(states));
    try {
      const response = await request(`/local/sync/${state.type}`, {
        method: "POST",
        body: {
          storeId: normalizedStoreId,
          jobId: state.taskId,
          requestId,
          ...(state.type === "POSTINGS" ? { postingsSinceDays: 30 } : {}),
        },
      });
      const result = response?.job && typeof response.job === "object"
        ? response.job
        : response;
      state.taskId = String(result?.taskId || result?.id || state.taskId);
      state.result = result;
      state.error = null;
      state.status = "SUCCESS";
    } catch (error) {
      state.result = null;
      state.error = publicError(error, {
        storeId: normalizedStoreId,
        type: state.type,
        taskId: state.taskId,
        requestId,
      });
      state.status = "FAILED";
    }
    onState(snapshot(states));
  }

  return snapshot(states);
}
