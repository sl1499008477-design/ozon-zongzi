import {
  activeAccount,
  bearerToken,
  findSession,
  isAccountExpired,
  requireAuth,
} from "./account-context.mjs";
import {
  appendAuditEvent,
  createAuditEvent,
  insertPostgresAuditEvent,
} from "./audit-event.mjs";
import {
  createJsonCollectorAuthRepository,
  createPostgresCollectorAuthRepository,
} from "./collector-auth-repository.mjs";
import { createCollectorAuthService } from "./collector-auth-service.mjs";
import { createCollectorAuthHttpHandler } from "./collector-auth-routes.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import { revokePersistedSessions } from "./persistence.mjs";

export function collectorParentSessionTokens(state, accountId) {
  const normalizedAccountId = String(accountId || "");
  return Object.entries(state?.sessions || {})
    .filter(([, session]) => String(session?.accountId || "") === normalizedAccountId)
    .map(([token]) => token);
}

export function collectorAccountChangeReason({ passwordChanged, accountExpired } = {}) {
  if (passwordChanged) return "SECURITY_RESET";
  return accountExpired ? "ACCOUNT_EXPIRED" : "ACCOUNT_DISABLED";
}

function auditAction(event = {}) {
  if (event.action === "collector.ticket.issue") {
    return event.outcome === "issued"
      ? "COLLECTOR_TICKET_ISSUED"
      : "COLLECTOR_SESSION_REJECTED";
  }
  if (event.action === "collector.ticket.exchange") {
    return event.outcome === "exchanged"
      ? "COLLECTOR_TICKET_EXCHANGED"
      : "COLLECTOR_SESSION_REJECTED";
  }
  if (event.action === "collector.session.authenticate") {
    return event.outcome === "authenticated" ? "" : "COLLECTOR_SESSION_REJECTED";
  }
  if (event.action === "collector.session.revoke") return "COLLECTOR_SESSION_REVOKED";
  return "";
}

export function createCollectorAuthRuntime({
  loadState,
  saveState,
  persistenceMode,
  stateTransaction,
  initializePostgresRepository,
  insertAuditEvent,
  readJson,
  sendJson,
} = {}) {
  if (
    typeof loadState !== "function"
    || typeof saveState !== "function"
    || typeof persistenceMode !== "function"
    || typeof stateTransaction?.run !== "function"
    || typeof readJson !== "function"
    || typeof sendJson !== "function"
  ) {
    throw new TypeError("collector auth runtime dependencies are required");
  }

  let postgresRepositoryPromise = null;

  function runStateTransaction(operation) {
    return stateTransaction.run(async () => {
      const state = await loadState();
      return operation(state);
    });
  }

  const initializeRepository = initializePostgresRepository || (async () => {
    await loadState();
    return createPostgresCollectorAuthRepository({
      pool: await getPostgresPool(),
    });
  });

  function postgresRepository() {
    if (!postgresRepositoryPromise) {
      const initialization = Promise.resolve().then(initializeRepository);
      postgresRepositoryPromise = initialization;
      initialization.catch(() => {
        if (postgresRepositoryPromise === initialization) {
          postgresRepositoryPromise = null;
        }
      });
    }
    return postgresRepositoryPromise;
  }

  const writePostgresAuditEvent = insertAuditEvent || (async (event) => (
    insertPostgresAuditEvent(await getPostgresPool(), event)
  ));

  async function callRepository(method, input) {
    if (persistenceMode() === "postgres") {
      return (await postgresRepository())[method](input);
    }
    return runStateTransaction(async (state) => {
      const repository = createJsonCollectorAuthRepository({
        state,
        persist: saveState,
      });
      return repository[method](input);
    });
  }

  const repository = Object.freeze({
    createTicket: (record) => callRepository("createTicket", record),
    consumeTicketAtomically: (input) => callRepository("consumeTicketAtomically", input),
    createSession: (record) => callRepository("createSession", record),
    findActiveSession: (input) => callRepository("findActiveSession", input),
    touchSession: (input) => callRepository("touchSession", input),
    revokeSessions: (input) => callRepository("revokeSessions", input),
  });

  async function audit(event = {}) {
    const action = auditAction(event);
    if (!action) return;
    const auditEvent = createAuditEvent({
      action,
      status: action === "COLLECTOR_SESSION_REJECTED" ? "FAILED" : "SUCCESS",
      accountId: String(event.accountId || ""),
      source: "extension",
      actorType: "collector_auth",
      actorId: String(event.accountId || ""),
      entityType: event.ticketId ? "collector_auth_ticket" : "collector_session",
      entityId: String(event.collectorSessionId || event.ticketId || ""),
      metadata: {
        outcome: String(event.outcome || ""),
        expiresAt: String(event.expiresAt || ""),
        requiredPermission: String(event.requiredPermission || ""),
        revoked: Number(event.revoked || 0),
      },
    });
    if (persistenceMode() === "postgres") {
      await writePostgresAuditEvent(auditEvent);
    } else {
      await runStateTransaction(async (state) => {
        appendAuditEvent(state, auditEvent);
        await saveState(state);
      });
    }
    if (
      event.action === "collector.session.authenticate"
      && event.outcome === "collector_account_inactive"
      && event.accountId
    ) {
      const state = await loadState();
      const account = activeAccount(state, event.accountId);
      const reason = !account
        ? "ACCOUNT_DELETED"
        : account.status === "disabled"
          ? "ACCOUNT_DISABLED"
          : isAccountExpired(account)
            ? "ACCOUNT_EXPIRED"
            : "PARENT_SESSION_REVOKED";
      await revokeAccountSessions({
        state,
        accountId: event.accountId,
        reason,
      });
    }
  }

  const service = createCollectorAuthService({ repository, audit });

  async function withAccount(result = {}) {
    const state = await loadState();
    const account = activeAccount(state, result.accountId);
    return {
      ...result,
      account: {
        id: String(account?.id || result.accountId || ""),
        displayName: String(account?.displayName || account?.username || ""),
      },
    };
  }

  const httpService = Object.freeze({
    issueTicket: (input) => service.issueTicket(input),
    exchangeTicket: (input) => service.exchangeTicket(input),
    authenticate: async (input) => withAccount(await service.authenticate(input)),
  });
  const handleHttpRoute = createCollectorAuthHttpHandler({
    requireWebAuth: async (req) => requireAuth(req, await loadState()),
    findParentSession: (req) => bearerToken(req),
    authService: httpService,
    readJson,
    sendJson,
  });

  async function authenticateSessionRequest(req, requiredPermission) {
    const authorization = String(req?.headers?.authorization || "");
    const match = authorization.match(/^Collector\s+(\S+)\s*$/i);
    if (!match?.[1]) {
      throw Object.assign(new Error("需要 Collector 采集认证"), {
        status: 401,
        code: "COLLECTOR_AUTH_REQUIRED",
      });
    }
    const authenticated = await httpService.authenticate({
      collectorToken: match[1],
      requiredPermission,
    });
    return authenticated;
  }

  async function authenticateRequest(req, requiredPermission) {
    const authenticated = await authenticateSessionRequest(req, requiredPermission);
    return authenticated.account || {
      id: authenticated.accountId,
      displayName: "",
    };
  }

  async function revokeCollectorSessions({
    parentSessionToken = "",
    parentSessionTokens = [],
    accountId = "",
    reason = "PARENT_SESSION_REVOKED",
    state = null,
  } = {}) {
    const currentState = state || await loadState();
    const explicitTokens = [
      parentSessionToken,
      ...(Array.isArray(parentSessionTokens) ? parentSessionTokens : []),
    ].map((token) => String(token || "").trim()).filter(Boolean);
    const resolvedAccountId = String(
      accountId
      || findSession(currentState, explicitTokens[0])?.accountId
      || "",
    );
    if (!resolvedAccountId) return { revoked: 0 };
    const accountTokens = [
      ...collectorParentSessionTokens(currentState, resolvedAccountId),
      ...(Array.isArray(currentState.collectorSessions)
        ? currentState.collectorSessions
          .filter((session) => String(session?.accountId || "") === resolvedAccountId)
          .map((session) => session?.parentSessionToken)
        : []),
    ];
    const candidates = parentSessionToken
      ? explicitTokens
      : [...explicitTokens, ...accountTokens];
    const tokens = [...new Set(
      candidates.map((token) => String(token || "").trim()).filter(Boolean),
    )];
    if (!tokens.length) {
      return service.revoke({
        parentSessionToken: "",
        accountId: resolvedAccountId,
        reason,
      });
    }
    let revoked = 0;
    for (const token of tokens) {
      const result = await service.revoke({
        parentSessionToken: token,
        accountId: resolvedAccountId,
        reason,
      });
      revoked += Number(result.revoked || 0);
    }
    return { revoked };
  }

  async function revokeParentSession(input = {}) {
    await revokeCollectorSessions(input);
    return revokePersistedSessions({
      token: input.parentSessionToken,
      reason: input.reason,
    });
  }

  async function revokeAccountSessions(input = {}) {
    await revokeCollectorSessions(input);
    return revokePersistedSessions({
      accountId: input.accountId,
      reason: input.reason,
    });
  }

  return Object.freeze({
    authenticateRequest,
    authenticateSessionRequest,
    handleHttpRoute,
    revokeAccountSessions,
    revokeParentSession,
  });
}
