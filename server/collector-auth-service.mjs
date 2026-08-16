import crypto from "node:crypto";

const TICKET_TTL_MS = 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const COLLECTOR_SECRET_PATTERN = /(?:ctt|cst)_[A-Za-z0-9_-]{16,}/g;
const DEFAULT_REVOKE_REASON = "PARENT_SESSION_REVOKED";

export const COLLECTOR_PERMISSIONS = Object.freeze([
  "collector.upload",
  "collector.job.read",
  "collector.config.read",
  "collector.ozon.read",
]);

export const COLLECTOR_REVOKE_REASONS = Object.freeze([
  DEFAULT_REVOKE_REASON,
  "WEB_LOGOUT",
  "ACCOUNT_DISABLED",
  "ACCOUNT_DELETED",
  "ACCOUNT_EXPIRED",
  "SECURITY_RESET",
  "SESSION_SUPERSEDED",
]);

const collectorRevokeReasonSet = new Set(COLLECTOR_REVOKE_REASONS);

export function hashCollectorSecret(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function opaqueSecret(prefix, randomBytes) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function sanitizeCollectorText(value, {
  max = 1000,
  secrets = [],
} = {}) {
  let sanitized = String(value || "");
  const explicitSecrets = [...new Set(
    (Array.isArray(secrets) ? secrets : [secrets])
      .map((secret) => String(secret || ""))
      .filter(Boolean),
  )].sort((left, right) => right.length - left.length);
  for (const secret of explicitSecrets) {
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized.replace(COLLECTOR_SECRET_PATTERN, "[REDACTED]").trim().slice(0, max);
}

export function normalizeCollectorRevokeReason(value, { secrets = [] } = {}) {
  const normalized = sanitizeCollectorText(value, { max: 80, secrets });
  return collectorRevokeReasonSet.has(normalized) ? normalized : DEFAULT_REVOKE_REASON;
}

export class CollectorAuthError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "CollectorAuthError";
    this.status = status;
    this.code = code;
  }
}

function serviceError(message, status, code) {
  return new CollectorAuthError(message, status, code);
}

function instant(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw serviceError("采集认证时间无效", 500, "COLLECTOR_AUTH_TIME_INVALID");
  }
  return date;
}

function expiresAtMillis(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : Number.NEGATIVE_INFINITY;
}

function mandatoryExpiresAtMillis(value, message, code) {
  if (!value) throw serviceError(message, 401, code);
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw serviceError(message, 401, code);
  return milliseconds;
}

function assertActiveAccount(account, at) {
  if (!account?.id || account.status !== "active" || expiresAtMillis(account.expiresAt) <= at.getTime()) {
    throw serviceError("账号不可用于采集认证", 403, "COLLECTOR_ACCOUNT_INACTIVE");
  }
}

function assertActiveParentSession(parentSession, accountId, at) {
  if (
    !parentSession
    || String(parentSession.accountId || "") !== String(accountId || "")
    || parentSession.revokedAt
  ) {
    throw serviceError("父登录会话已失效", 401, "COLLECTOR_PARENT_SESSION_REVOKED");
  }
  if (expiresAtMillis(parentSession.expiresAt) <= at.getTime()) {
    throw serviceError("父登录会话已过期", 401, "COLLECTOR_PARENT_SESSION_EXPIRED");
  }
}

function publicSession(record) {
  return {
    collectorSessionId: record.id,
    accountId: record.accountId,
    deviceFingerprint: record.deviceFingerprint || "",
    extensionVersion: record.extensionVersion || "",
    permissions: [...record.permissions],
    expiresAt: record.expiresAt,
  };
}

function publicAccount(account, accountId) {
  return {
    id: String(account?.id || accountId || ""),
    displayName: String(account?.displayName || account?.username || ""),
  };
}

export function createCollectorAuthService({
  repository,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  audit = async () => {},
} = {}) {
  if (!repository) throw new TypeError("collector auth repository required");

  async function writeAudit(event) {
    try {
      await audit(event);
    } catch {
      // Authentication must not fail because an out-of-band audit sink is down.
    }
  }

  async function issueTicket({ account, parentSessionToken } = {}) {
    const at = instant(now());
    assertActiveAccount(account, at);
    if (!String(parentSessionToken || "")) {
      throw serviceError("父登录会话无效", 401, "COLLECTOR_PARENT_SESSION_REVOKED");
    }

    const ticket = opaqueSecret("ctt", randomBytes);
    const ticketHash = hashCollectorSecret(ticket);
    const record = {
      id: `ctkt_${ticketHash.slice(0, 24)}`,
      ticketHash,
      accountId: String(account.id),
      parentSessionToken: String(parentSessionToken),
      permissions: [...COLLECTOR_PERMISSIONS],
      expiresAt: new Date(at.getTime() + TICKET_TTL_MS).toISOString(),
      consumedAt: null,
      createdAt: at.toISOString(),
    };
    const created = await repository.createTicket(record);
    if (!created) {
      await writeAudit({
        action: "collector.ticket.issue",
        accountId: record.accountId,
        ticketId: record.id,
        outcome: "parent_session_rejected",
      });
      throw serviceError("父登录会话已失效", 401, "COLLECTOR_PARENT_SESSION_REVOKED");
    }

    await writeAudit({
      action: "collector.ticket.issue",
      accountId: record.accountId,
      ticketId: record.id,
      outcome: "issued",
      expiresAt: record.expiresAt,
    });
    return {
      ticket,
      expiresAt: record.expiresAt,
      permissions: [...record.permissions],
    };
  }

  async function exchangeTicket({
    ticket,
    deviceFingerprint = "",
    extensionVersion = "",
  } = {}) {
    const at = instant(now());
    const consumed = await repository.consumeTicketAtomically({
      ticketHash: hashCollectorSecret(ticket),
      now: at,
    });
    const ticketRecord = consumed?.ticket || null;
    if (consumed?.outcome !== "consumed" || !ticketRecord) {
      const used = consumed?.outcome === "used";
      const expired = consumed?.outcome === "expired";
      const error = used
        ? serviceError("采集通行证已使用", 409, "COLLECTOR_TICKET_USED")
        : expired
          ? serviceError("采集通行证已过期", 401, "COLLECTOR_TICKET_EXPIRED")
          : serviceError("采集通行证无效", 401, "COLLECTOR_TICKET_INVALID");
      await writeAudit({
        action: "collector.ticket.exchange",
        accountId: ticketRecord?.accountId || "",
        ticketId: ticketRecord?.id || "",
        outcome: used ? "ticket_used" : expired ? "ticket_expired" : "ticket_invalid",
      });
      throw error;
    }

    try {
      assertActiveAccount(ticketRecord.account, at);
      assertActiveParentSession(ticketRecord.parentSession, ticketRecord.accountId, at);
    } catch (error) {
      await writeAudit({
        action: "collector.ticket.exchange",
        accountId: ticketRecord.accountId,
        ticketId: ticketRecord.id,
        outcome: String(error?.code || "COLLECTOR_EXCHANGE_REJECTED").toLowerCase(),
      });
      throw error;
    }

    const collectorToken = opaqueSecret("cst", randomBytes);
    const tokenHash = hashCollectorSecret(collectorToken);
    const parentExpiry = expiresAtMillis(ticketRecord.parentSession.expiresAt);
    const expiresAt = new Date(Math.min(at.getTime() + SESSION_TTL_MS, parentExpiry));
    const sessionRecord = {
      id: `csess_${tokenHash.slice(0, 24)}`,
      tokenHash,
      accountId: ticketRecord.accountId,
      parentSessionToken: ticketRecord.parentSessionToken,
      deviceFingerprint: sanitizeCollectorText(deviceFingerprint, {
        max: 240,
        secrets: [ticket, ticketRecord.parentSessionToken],
      }),
      extensionVersion: sanitizeCollectorText(extensionVersion, {
        max: 80,
        secrets: [ticket, ticketRecord.parentSessionToken],
      }),
      permissions: [...COLLECTOR_PERMISSIONS],
      expiresAt: expiresAt.toISOString(),
      revokedAt: null,
      revokedReason: "",
      lastSeenAt: at.toISOString(),
      createdAt: at.toISOString(),
    };
    const created = await repository.createSession(sessionRecord);
    const wrappedResult = Boolean(
      created
      && typeof created === "object"
      && Object.hasOwn(created, "session"),
    );
    const createdSession = wrappedResult ? created.session : created;
    if (!createdSession) {
      await writeAudit({
        action: "collector.ticket.exchange",
        accountId: ticketRecord.accountId,
        ticketId: ticketRecord.id,
        outcome: "session_create_failed",
      });
      throw serviceError("采集会话创建失败", 401, "COLLECTOR_SESSION_CREATE_FAILED");
    }
    const superseded = wrappedResult ? Number(created.supersededCount || 0) : 0;

    await writeAudit({
      action: "collector.ticket.exchange",
      accountId: createdSession.accountId,
      ticketId: ticketRecord.id,
      collectorSessionId: createdSession.id,
      outcome: "exchanged",
      expiresAt: createdSession.expiresAt,
      superseded,
    });
    return {
      collectorToken,
      ...publicSession(createdSession),
      account: publicAccount(ticketRecord.account, createdSession.accountId),
    };
  }

  async function authenticate({ collectorToken, requiredPermission } = {}) {
    const at = instant(now());
    const record = await repository.findActiveSession({
      tokenHash: hashCollectorSecret(collectorToken),
      now: at,
    });
    if (!record) {
      await writeAudit({
        action: "collector.session.authenticate",
        outcome: "session_invalid",
      });
      throw serviceError("采集会话无效", 401, "COLLECTOR_SESSION_INVALID");
    }

    try {
      assertActiveAccount(record.account, at);
      assertActiveParentSession(record.parentSession, record.accountId, at);
      if (record.revokedAt) {
        throw serviceError("采集会话已撤销", 401, "COLLECTOR_SESSION_REVOKED");
      }
      if (
        mandatoryExpiresAtMillis(
          record.expiresAt,
          "采集会话已过期",
          "COLLECTOR_SESSION_EXPIRED",
        ) <= at.getTime()
      ) {
        throw serviceError("采集会话已过期", 401, "COLLECTOR_SESSION_EXPIRED");
      }
      if (
        !COLLECTOR_PERMISSIONS.includes(requiredPermission)
        || !Array.isArray(record.permissions)
        || !record.permissions.includes(requiredPermission)
      ) {
        throw serviceError("采集会话权限不足", 403, "COLLECTOR_PERMISSION_DENIED");
      }
    } catch (error) {
      await writeAudit({
        action: "collector.session.authenticate",
        accountId: record.accountId,
        collectorSessionId: record.id,
        outcome: String(error?.code || "COLLECTOR_AUTH_REJECTED").toLowerCase(),
      });
      throw error;
    }

    await repository.touchSession({ sessionId: record.id, now: at });
    await writeAudit({
      action: "collector.session.authenticate",
      accountId: record.accountId,
      collectorSessionId: record.id,
      outcome: "authenticated",
      requiredPermission,
    });
    return publicSession(record);
  }

  async function revoke({
    parentSessionToken,
    accountId,
    reason = DEFAULT_REVOKE_REASON,
  } = {}) {
    const at = instant(now());
    const normalizedAccountId = String(accountId || "");
    const normalizedParentSessionToken = String(parentSessionToken || "");
    const revoked = Number(await repository.revokeSessions({
      parentSessionToken: normalizedParentSessionToken,
      accountId: normalizedAccountId,
      reason: normalizeCollectorRevokeReason(reason, {
        secrets: [normalizedParentSessionToken],
      }),
      now: at,
    })) || 0;
    await writeAudit({
      action: "collector.session.revoke",
      accountId: normalizedAccountId,
      outcome: "revoked",
      revoked,
    });
    return { revoked };
  }

  return Object.freeze({
    issueTicket,
    exchangeTicket,
    authenticate,
    revoke,
  });
}
