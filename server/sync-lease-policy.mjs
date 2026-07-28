import crypto from "node:crypto";

const ALLOWED_SYNC_TYPES = new Set(["PRODUCTS", "POSTINGS", "WAREHOUSES"]);

function leaseError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizedType(value) {
  const type = String(value || "").trim().toUpperCase();
  if (!ALLOWED_SYNC_TYPES.has(type)) {
    throw leaseError(400, "SYNC_LEASE_TYPE_INVALID", "不支持的同步类型");
  }
  return type;
}

function normalizedDeviceId(value) {
  const deviceId = String(value || "").trim();
  if (!deviceId) {
    throw leaseError(400, "SYNC_LEASE_DEVICE_REQUIRED", "同步设备标识不能为空");
  }
  return deviceId;
}

function normalizedTtlSeconds(value) {
  return Math.max(60, Math.min(3600, Number(value || 300) || 300));
}

function leaseKey(accountId, storeId, type) {
  return `${accountId}:${storeId}:${type}`;
}

function findLeaseEntry(state, leaseId, accountId) {
  const match = Object.entries(state.leases || {}).find(([, lease]) =>
    String(lease.leaseId || "") === String(leaseId || "")
    && String(lease.accountId || "") === String(accountId || "")
  );
  if (!match) {
    throw leaseError(404, "SYNC_LEASE_NOT_FOUND", "同步锁不存在");
  }
  return match;
}

function assertLiveHolder(state, lease, { deviceId, now = Date.now() }) {
  if (Date.parse(lease.expiresAt || "") <= now) {
    for (const [key, candidate] of Object.entries(state.leases || {})) {
      if (candidate === lease) delete state.leases[key];
    }
    throw leaseError(409, "SYNC_LEASE_EXPIRED", "同步锁已过期，请重新获取");
  }
  if (String(lease.deviceId || "") !== normalizedDeviceId(deviceId)) {
    throw leaseError(409, "SYNC_LEASE_DEVICE_MISMATCH", "同步锁已由另一台设备持有");
  }
}

export function acquireSyncLease(state, {
  accountId,
  storeId,
  type,
  deviceId,
  ttlSeconds,
  now = Date.now(),
}) {
  state.leases = state.leases && typeof state.leases === "object" ? state.leases : {};
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedStoreId = String(storeId || "").trim();
  const normalizedSyncType = normalizedType(type);
  const normalizedDevice = normalizedDeviceId(deviceId);
  const ttl = normalizedTtlSeconds(ttlSeconds);
  const key = leaseKey(normalizedAccountId, normalizedStoreId, normalizedSyncType);
  const existing = state.leases[key];
  if (existing && Date.parse(existing.expiresAt || "") > now) {
    if (String(existing.deviceId || "") !== normalizedDevice) {
      return { acquired: false, expiresAt: existing.expiresAt };
    }
    existing.expiresAt = new Date(now + ttl * 1000).toISOString();
    existing.updatedAt = new Date(now).toISOString();
    return {
      acquired: true,
      leaseId: existing.leaseId,
      expiresAt: existing.expiresAt,
      lease: existing,
      idempotent: true,
    };
  }
  const timestamp = new Date(now).toISOString();
  const lease = {
    leaseId: crypto.randomUUID(),
    accountId: normalizedAccountId,
    storeId: normalizedStoreId,
    type: normalizedSyncType,
    deviceId: normalizedDevice,
    expiresAt: new Date(now + ttl * 1000).toISOString(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.leases[key] = lease;
  return { acquired: true, leaseId: lease.leaseId, expiresAt: lease.expiresAt, lease, idempotent: false };
}

export function heartbeatSyncLease(state, {
  accountId,
  leaseId,
  deviceId,
  ttlSeconds,
  now = Date.now(),
}) {
  const [, lease] = findLeaseEntry(state, leaseId, accountId);
  assertLiveHolder(state, lease, { deviceId, now });
  const ttl = normalizedTtlSeconds(ttlSeconds);
  lease.expiresAt = new Date(now + ttl * 1000).toISOString();
  lease.updatedAt = new Date(now).toISOString();
  return { refreshed: true, expiresAt: lease.expiresAt, lease };
}

export function releaseSyncLease(state, { accountId, leaseId, deviceId, now = Date.now() }) {
  const [key, lease] = findLeaseEntry(state, leaseId, accountId);
  assertLiveHolder(state, lease, { deviceId, now });
  delete state.leases[key];
  return { released: true, lease };
}

export function requireActiveSyncLease(state, {
  accountId,
  storeId,
  type,
  leaseId,
  deviceId,
  now = Date.now(),
}) {
  if (!String(leaseId || "").trim()) {
    throw leaseError(409, "SYNC_LEASE_REQUIRED", "提交同步数据前必须先获取同步锁");
  }
  const [, lease] = findLeaseEntry(state, leaseId, accountId);
  assertLiveHolder(state, lease, { deviceId, now });
  const expectedType = normalizedType(type);
  if (String(lease.storeId || "") !== String(storeId || "") || lease.type !== expectedType) {
    throw leaseError(409, "SYNC_LEASE_SCOPE_MISMATCH", "同步锁与本次店铺或同步类型不匹配");
  }
  return lease;
}
