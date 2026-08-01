import crypto from "node:crypto";

const SENSITIVE_KEY = /(authorization|cookie|password|passphrase|secret|token|api[_-]?key|credential|private[_-]?key)/i;
const SERVER_SCOPE_KEY = /^(accountId|account_id|storeId|store_id|deviceId|device_id|source|action|status)$/;

const clean = (value, max = 240) => String(value ?? "").trim().slice(0, max);

function sanitizeValue(value, key = "", depth = 0) {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (depth > 5) return "[TRUNCATED]";
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "string") return value.slice(0, 1000);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, "", depth + 1));
  }
  if (!value || typeof value !== "object") return String(value ?? "").slice(0, 1000);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([childKey]) => !SERVER_SCOPE_KEY.test(childKey))
      .slice(0, 100)
      .map(([childKey, childValue]) => [
        clean(childKey, 120),
        sanitizeValue(childValue, childKey, depth + 1),
      ]),
  );
}

export function createAuditEvent({
  eventId = "",
  correlationId = "",
  action,
  status = "SUCCESS",
  accountId = "",
  storeId = "",
  deviceId = "",
  source = "local-api",
  actorType = "account",
  actorId = "",
  entityType = "operation",
  entityId = "",
  metadata = {},
  createdAt = "",
} = {}) {
  const id = clean(eventId, 200) || `audit_${crypto.randomUUID()}`;
  return {
    eventId: id,
    correlationId: clean(correlationId, 200) || id,
    action: clean(action || "UNKNOWN", 120).toUpperCase(),
    status: clean(status || "UNKNOWN", 80).toUpperCase(),
    accountId: clean(accountId, 160),
    storeId: clean(storeId, 160),
    deviceId: clean(deviceId, 200),
    source: clean(source || "local-api", 80),
    actorType: clean(actorType || "account", 80),
    actorId: clean(actorId || accountId, 160),
    entityType: clean(entityType || "operation", 120),
    entityId: clean(entityId, 240),
    metadata: sanitizeValue(metadata),
    createdAt: createdAt || new Date().toISOString(),
  };
}

export function appendAuditEvent(state, input) {
  const event = createAuditEvent(input);
  state.auditEvents = Array.isArray(state.auditEvents) ? state.auditEvents : [];
  const existingIndex = state.auditEvents.findIndex((item) => item?.eventId === event.eventId);
  if (existingIndex >= 0) state.auditEvents.splice(existingIndex, 1);
  state.auditEvents.unshift(event);
  state.auditEvents = state.auditEvents.slice(0, 1000);
  return event;
}

export async function insertPostgresAuditEvent(pool, input) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("PostgreSQL audit pool is required");
  }
  const event = createAuditEvent(input);
  await pool.query(
    `INSERT INTO audit_events (
       event_id, account_id, store_id, action, status, actor_type, actor_id,
       device_id, source, entity_type, entity_id, correlation_id, metadata,
       occurred_at, created_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$14)
     ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING`,
    [
      event.eventId,
      event.accountId || null,
      event.storeId || null,
      event.action,
      event.status,
      event.actorType,
      event.actorId,
      event.deviceId,
      event.source,
      event.entityType,
      event.entityId,
      event.correlationId,
      JSON.stringify(event.metadata),
      event.createdAt,
    ],
  );
  return event;
}
