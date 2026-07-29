import {
  normalizeCollectorRevokeReason,
  sanitizeCollectorText,
} from "./collector-auth-service.mjs";

let jsonOperationQueue = Promise.resolve();

function repositoryError(message, code = "COLLECTOR_AUTH_PERSISTENCE_FAILED") {
  return Object.assign(new Error(message), { status: 500, code });
}

function expiredStateError(kind) {
  const ticket = kind === "ticket";
  return Object.assign(new Error(ticket ? "采集通行证已过期" : "采集会话已过期"), {
    status: 401,
    code: ticket ? "COLLECTOR_TICKET_EXPIRED" : "COLLECTOR_SESSION_EXPIRED",
  });
}

function mandatoryExpiryMillis(value, kind) {
  if (!value) throw expiredStateError(kind);
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw expiredStateError(kind);
  return milliseconds;
}

function requireSecretHash(value) {
  const hash = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw repositoryError("采集认证密钥摘要无效", "COLLECTOR_SECRET_HASH_REQUIRED");
  }
  return hash;
}

function serializeJsonOperation(operation) {
  const flight = jsonOperationQueue.catch(() => {}).then(operation);
  jsonOperationQueue = flight;
  return flight;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function permissions(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function ticketRecord(value = {}) {
  return {
    id: String(value.id || ""),
    ticketHash: String(value.ticketHash ?? value.ticket_hash ?? ""),
    accountId: String(value.accountId ?? value.account_id ?? ""),
    parentSessionToken: String(value.parentSessionToken ?? value.parent_session_token ?? ""),
    permissions: permissions(value.permissions),
    expiresAt: iso(value.expiresAt ?? value.expires_at),
    consumedAt: iso(value.consumedAt ?? value.consumed_at),
    createdAt: iso(value.createdAt ?? value.created_at),
  };
}

function sessionRecord(value = {}) {
  const parentSessionToken = String(value.parentSessionToken ?? value.parent_session_token ?? "");
  const rawRevokedReason = value.revokedReason ?? value.revoked_reason ?? "";
  return {
    id: String(value.id || ""),
    tokenHash: String(value.tokenHash ?? value.token_hash ?? ""),
    accountId: String(value.accountId ?? value.account_id ?? ""),
    parentSessionToken,
    deviceFingerprint: sanitizeCollectorText(value.deviceFingerprint ?? value.device_fingerprint, {
      max: 240,
      secrets: [parentSessionToken],
    }),
    extensionVersion: sanitizeCollectorText(value.extensionVersion ?? value.extension_version, {
      max: 80,
      secrets: [parentSessionToken],
    }),
    permissions: permissions(value.permissions),
    expiresAt: iso(value.expiresAt ?? value.expires_at),
    revokedAt: iso(value.revokedAt ?? value.revoked_at),
    revokedReason: rawRevokedReason
      ? normalizeCollectorRevokeReason(rawRevokedReason, { secrets: [parentSessionToken] })
      : "",
    lastSeenAt: iso(value.lastSeenAt ?? value.last_seen_at),
    createdAt: iso(value.createdAt ?? value.created_at),
  };
}

function accountFrom(value = {}) {
  return {
    id: String(value.accountId ?? value.account_id ?? value.account?.id ?? ""),
    status: String(value.accountStatus ?? value.account_status ?? value.account?.status ?? "active"),
    expiresAt: iso(value.accountExpiresAt ?? value.account_expires_at ?? value.account?.expiresAt),
  };
}

function parentSessionFrom(value = {}) {
  const source = value.parentSession || {};
  return {
    accountId: String(value.accountId ?? value.account_id ?? source.accountId ?? ""),
    expiresAt: iso(value.parentSessionExpiresAt ?? value.parent_session_expires_at ?? source.expiresAt),
    revokedAt: iso(value.parentSessionRevokedAt ?? value.parent_session_revoked_at ?? source.revokedAt),
  };
}

function withContext(record, source = record) {
  return {
    ...record,
    account: accountFrom(source),
    parentSession: parentSessionFrom(source),
  };
}

function stateAccount(state, accountId) {
  return (state.accounts || []).find((account) => String(account?.id || "") === String(accountId || "")) || null;
}

function stateParentSession(state, parentSessionToken) {
  const parent = state.sessions && typeof state.sessions === "object"
    ? state.sessions[parentSessionToken]
    : null;
  if (!parent) return null;
  return {
    accountId: String(parent.accountId || ""),
    expiresAt: iso(parent.expiresAt),
    revokedAt: iso(parent.revokedAt),
  };
}

function jsonContext(state, record) {
  return {
    ...record,
    account: stateAccount(state, record.accountId),
    parentSession: stateParentSession(state, record.parentSessionToken),
  };
}

function isActiveParentForRecord(state, record, at) {
  const account = stateAccount(state, record.accountId);
  const parent = stateParentSession(state, record.parentSessionToken);
  if (!account || account.status !== "active" || !parent || parent.accountId !== record.accountId) return false;
  if (account.expiresAt && new Date(account.expiresAt).getTime() <= at.getTime()) return false;
  if (parent.revokedAt) return false;
  if (parent.expiresAt && new Date(parent.expiresAt).getTime() <= at.getTime()) return false;
  return true;
}

export function createJsonCollectorAuthRepository({
  state,
  persist = async () => {},
} = {}) {
  if (!state || typeof state !== "object") throw new TypeError("collector auth JSON state required");

  async function save() {
    try {
      await persist(state);
    } catch {
      throw repositoryError("采集认证状态保存失败");
    }
  }

  async function commitMutation(fieldNames, mutate) {
    const snapshots = fieldNames.map((fieldName) => ({
      fieldName,
      existed: Object.hasOwn(state, fieldName),
      value: structuredClone(state[fieldName]),
    }));
    try {
      const result = mutate();
      await save();
      return result;
    } catch (error) {
      for (const snapshot of snapshots) {
        if (snapshot.existed) state[snapshot.fieldName] = snapshot.value;
        else delete state[snapshot.fieldName];
      }
      throw error;
    }
  }

  async function createTicket(input) {
    return serializeJsonOperation(async () => {
      const record = ticketRecord(input);
      record.ticketHash = requireSecretHash(record.ticketHash);
      const at = input?.now instanceof Date ? input.now : new Date(record.createdAt);
      if (mandatoryExpiryMillis(record.expiresAt, "ticket") <= at.getTime()) {
        throw expiredStateError("ticket");
      }
      if (!isActiveParentForRecord(state, record, at)) return null;
      return commitMutation(["collectorAuthTickets"], () => {
        state.collectorAuthTickets = Array.isArray(state.collectorAuthTickets)
          ? state.collectorAuthTickets
          : [];
        state.collectorAuthTickets.push(record);
        return jsonContext(state, record);
      });
    });
  }

  async function consumeTicketAtomically({ ticketHash, now }) {
    return serializeJsonOperation(async () => {
      const normalizedHash = requireSecretHash(ticketHash);
      state.collectorAuthTickets = Array.isArray(state.collectorAuthTickets)
        ? state.collectorAuthTickets
        : [];
      const record = state.collectorAuthTickets.find((item) => item?.ticketHash === normalizedHash);
      if (!record) return { outcome: "not_found" };
      if (record.consumedAt) return { outcome: "used", ticket: jsonContext(state, record) };
      let expiresAt;
      try {
        expiresAt = mandatoryExpiryMillis(record.expiresAt, "ticket");
      } catch {
        return { outcome: "expired", ticket: jsonContext(state, record) };
      }
      if (expiresAt <= now.getTime()) {
        return { outcome: "expired", ticket: jsonContext(state, record) };
      }
      return commitMutation(["collectorAuthTickets"], () => {
        const mutableRecord = state.collectorAuthTickets.find((item) => item?.ticketHash === normalizedHash);
        mutableRecord.consumedAt = now.toISOString();
        return { outcome: "consumed", ticket: jsonContext(state, mutableRecord) };
      });
    });
  }

  async function createSession(input) {
    return serializeJsonOperation(async () => {
      const record = sessionRecord(input);
      record.tokenHash = requireSecretHash(record.tokenHash);
      const at = new Date(record.createdAt);
      if (mandatoryExpiryMillis(record.expiresAt, "session") <= at.getTime()) {
        throw expiredStateError("session");
      }
      if (!isActiveParentForRecord(state, record, at)) return null;
      return commitMutation(["collectorSessions"], () => {
        state.collectorSessions = Array.isArray(state.collectorSessions)
          ? state.collectorSessions
          : [];
        state.collectorSessions.push(record);
        return jsonContext(state, record);
      });
    });
  }

  async function findActiveSession({ tokenHash, now }) {
    const normalizedHash = requireSecretHash(tokenHash);
    const collectorSessions = Array.isArray(state.collectorSessions)
      ? state.collectorSessions
      : [];
    const record = collectorSessions.find((item) => item?.tokenHash === normalizedHash);
    if (!record) return null;
    if (mandatoryExpiryMillis(record.expiresAt, "session") <= now.getTime()) {
      throw expiredStateError("session");
    }
    const normalizedRecord = sessionRecord(record);
    return jsonContext(state, normalizedRecord);
  }

  async function touchSession({ sessionId, now }) {
    return serializeJsonOperation(async () => {
      state.collectorSessions = Array.isArray(state.collectorSessions)
        ? state.collectorSessions
        : [];
      const record = state.collectorSessions.find((item) => item?.id === sessionId);
      if (!record) return false;
      return commitMutation(["collectorSessions"], () => {
        const mutableRecord = state.collectorSessions.find((item) => item?.id === sessionId);
        mutableRecord.lastSeenAt = now.toISOString();
        return true;
      });
    });
  }

  async function revokeSessions({ parentSessionToken, accountId, reason, now }) {
    return serializeJsonOperation(async () => {
      state.collectorSessions = Array.isArray(state.collectorSessions)
        ? state.collectorSessions
        : [];
      const targets = state.collectorSessions.filter((record) => (
        record?.parentSessionToken === parentSessionToken
        && record?.accountId === accountId
        && !record.revokedAt
      ));
      if (!targets.length) return 0;
      return commitMutation(["collectorSessions"], () => {
        let revoked = 0;
        for (const record of state.collectorSessions) {
          if (
            record?.parentSessionToken === parentSessionToken
            && record?.accountId === accountId
            && !record.revokedAt
          ) {
            record.revokedAt = now.toISOString();
            record.revokedReason = normalizeCollectorRevokeReason(reason, {
              secrets: [parentSessionToken],
            });
            revoked += 1;
          }
        }
        return revoked;
      });
    });
  }

  return Object.freeze({
    createTicket,
    consumeTicketAtomically,
    createSession,
    findActiveSession,
    touchSession,
    revokeSessions,
  });
}

function postgresTicket(row) {
  return withContext(ticketRecord(row), row);
}

function postgresSession(row) {
  return withContext(sessionRecord(row), row);
}

export function createPostgresCollectorAuthRepository({ pool } = {}) {
  if (!pool?.query) throw new TypeError("collector auth PostgreSQL pool required");

  async function query(sql, values) {
    try {
      return await pool.query(sql, values);
    } catch {
      throw repositoryError("采集认证数据操作失败");
    }
  }

  async function createTicket(input) {
    const ticketHash = requireSecretHash(input.ticketHash);
    const result = await query(
      `
        INSERT INTO collector_auth_tickets (
          id, ticket_hash, account_id, parent_session_token, permissions,
          expires_at, consumed_at, created_at
        )
        SELECT $1,$2,$3,$4,$5::jsonb,$6,$7,$8
        FROM accounts AS account
        JOIN sessions AS parent
          ON parent.account_id=account.id AND parent.token=$4
        WHERE account.id=$3
          AND account.status='active'
          AND (account.expires_at IS NULL OR account.expires_at>$9)
          AND parent.revoked_at IS NULL
          AND (parent.expires_at IS NULL OR parent.expires_at>$9)
        RETURNING *
      `,
      [
        input.id,
        ticketHash,
        input.accountId,
        input.parentSessionToken,
        JSON.stringify(permissions(input.permissions)),
        input.expiresAt,
        input.consumedAt,
        input.createdAt,
        input.createdAt,
      ],
    );
    return result.rows[0] ? ticketRecord(result.rows[0]) : null;
  }

  async function consumeTicketAtomically({ ticketHash, now }) {
    const normalizedHash = requireSecretHash(ticketHash);
    const consumed = await query(
      `
        WITH consumed AS (
          UPDATE collector_auth_tickets
          SET consumed_at=$2
          WHERE ticket_hash=$1
            AND consumed_at IS NULL
            AND expires_at>$2
          RETURNING *
        )
        SELECT consumed.*,
               account.status AS account_status,
               account.expires_at AS account_expires_at,
               parent.expires_at AS parent_session_expires_at,
               parent.revoked_at AS parent_session_revoked_at
        FROM consumed
        JOIN accounts AS account ON account.id=consumed.account_id
        JOIN sessions AS parent
          ON parent.account_id=consumed.account_id
         AND parent.token=consumed.parent_session_token
      `,
      [normalizedHash, now],
    );
    if (consumed.rows[0]) {
      return { outcome: "consumed", ticket: postgresTicket(consumed.rows[0]) };
    }

    const found = await query(
      `
        SELECT ticket.*,
               account.status AS account_status,
               account.expires_at AS account_expires_at,
               parent.expires_at AS parent_session_expires_at,
               parent.revoked_at AS parent_session_revoked_at
        FROM collector_auth_tickets AS ticket
        JOIN accounts AS account ON account.id=ticket.account_id
        JOIN sessions AS parent
          ON parent.account_id=ticket.account_id
         AND parent.token=ticket.parent_session_token
        WHERE ticket.ticket_hash=$1
      `,
      [normalizedHash],
    );
    if (!found.rows[0]) return { outcome: "not_found" };
    const ticket = postgresTicket(found.rows[0]);
    if (ticket.consumedAt) return { outcome: "used", ticket };
    if (new Date(ticket.expiresAt).getTime() <= now.getTime()) return { outcome: "expired", ticket };
    return { outcome: "not_found" };
  }

  async function createSession(input) {
    const record = sessionRecord(input);
    record.tokenHash = requireSecretHash(record.tokenHash);
    const result = await query(
      `
        INSERT INTO collector_sessions (
          id, token_hash, account_id, parent_session_token,
          device_fingerprint, extension_version, permissions, expires_at,
          revoked_at, revoked_reason, last_seen_at, created_at
        )
        SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12
        FROM accounts AS account
        JOIN sessions AS parent
          ON parent.account_id=account.id AND parent.token=$4
        WHERE account.id=$3
          AND account.status='active'
          AND (account.expires_at IS NULL OR account.expires_at>$12)
          AND parent.revoked_at IS NULL
          AND (parent.expires_at IS NULL OR parent.expires_at>$12)
        RETURNING *
      `,
      [
        record.id,
        record.tokenHash,
        record.accountId,
        record.parentSessionToken,
        record.deviceFingerprint,
        record.extensionVersion,
        JSON.stringify(record.permissions),
        record.expiresAt,
        record.revokedAt,
        record.revokedReason,
        record.lastSeenAt,
        record.createdAt,
      ],
    );
    return result.rows[0] ? sessionRecord(result.rows[0]) : null;
  }

  async function findActiveSession({ tokenHash }) {
    const normalizedHash = requireSecretHash(tokenHash);
    const result = await query(
      `
        SELECT collector.*,
               account.status AS account_status,
               account.expires_at AS account_expires_at,
               parent.expires_at AS parent_session_expires_at,
               parent.revoked_at AS parent_session_revoked_at
        FROM collector_sessions AS collector
        JOIN accounts AS account ON account.id=collector.account_id
        JOIN sessions AS parent
          ON parent.account_id=collector.account_id
         AND parent.token=collector.parent_session_token
        WHERE collector.token_hash=$1
      `,
      [normalizedHash],
    );
    return result.rows[0] ? postgresSession(result.rows[0]) : null;
  }

  async function touchSession({ sessionId, now }) {
    const result = await query(
      "UPDATE collector_sessions SET last_seen_at=$2 WHERE id=$1",
      [sessionId, now],
    );
    return Number(result.rowCount || 0) > 0;
  }

  async function revokeSessions({ parentSessionToken, accountId, reason, now }) {
    const result = await query(
      `
        UPDATE collector_sessions
        SET revoked_at=$4, revoked_reason=$3
        WHERE parent_session_token=$1
          AND account_id=$2
          AND revoked_at IS NULL
      `,
      [
        parentSessionToken,
        accountId,
        normalizeCollectorRevokeReason(reason, { secrets: [parentSessionToken] }),
        now,
      ],
    );
    return Number(result.rowCount || 0);
  }

  return Object.freeze({
    createTicket,
    consumeTicketAtomically,
    createSession,
    findActiveSession,
    touchSession,
    revokeSessions,
  });
}
