import crypto from "node:crypto";
import {
  COLLECTOR_PERMISSIONS,
  sanitizeCollectorText,
} from "./collector-auth-service.mjs";

const TICKET_PATH = "/extension/collector-auth/ticket";
const EXCHANGE_PATH = "/extension/collector-auth/exchange";
const STATUS_PATH = "/extension/collector-auth/status";
const STATUS_PERMISSION = "collector.config.read";

function routeError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function errorStatus(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function collectorToken(req) {
  const authorization = String(req?.headers?.authorization || "");
  const match = authorization.match(/^Collector\s+(\S+)\s*$/i);
  return match?.[1] || "";
}

function parentToken(value) {
  if (typeof value === "string") return value;
  return String(value?.token || value?.parentSessionToken || "");
}

function publicAccount(result = {}) {
  const account = result.account && typeof result.account === "object"
    ? result.account
    : {};
  return {
    id: String(account.id || result.accountId || ""),
    displayName: String(account.displayName || result.displayName || ""),
  };
}

function safeErrorPayload(error, secrets = []) {
  return {
    ok: false,
    message: sanitizeCollectorText(
      error?.message || "采集认证请求失败",
      { max: 240, secrets },
    ),
    code: String(error?.code || "COLLECTOR_AUTH_FAILED").slice(0, 120),
  };
}

export function createCollectorAuthHttpHandler({
  requireWebAuth,
  findParentSession,
  authService,
  readJson,
  sendJson,
} = {}) {
  if (typeof requireWebAuth !== "function") {
    throw new TypeError("collector auth routes require requireWebAuth(req)");
  }
  if (typeof findParentSession !== "function") {
    throw new TypeError("collector auth routes require findParentSession(req, account)");
  }
  if (
    !authService
    || typeof authService.issueTicket !== "function"
    || typeof authService.exchangeTicket !== "function"
    || typeof authService.authenticate !== "function"
  ) {
    throw new TypeError("collector auth routes require authService");
  }
  if (typeof readJson !== "function" || typeof sendJson !== "function") {
    throw new TypeError("collector auth routes require readJson and sendJson");
  }

  return async function handleCollectorAuthRoute(req, res, url) {
    const pathname = url?.pathname || "";
    const ticketRoute = req.method === "POST" && pathname === TICKET_PATH;
    const exchangeRoute = req.method === "POST" && pathname === EXCHANGE_PATH;
    const statusRoute = req.method === "GET" && pathname === STATUS_PATH;
    if (!ticketRoute && !exchangeRoute && !statusRoute) return false;

    let secret = "";
    try {
      if (ticketRoute) {
        const account = await requireWebAuth(req);
        secret = parentToken(await findParentSession(req, account));
        if (!secret) {
          throw routeError(
            "父登录会话无效",
            401,
            "COLLECTOR_PARENT_SESSION_REVOKED",
          );
        }
        const issued = await authService.issueTicket({
          account,
          parentSessionToken: secret,
        });
        sendJson(res, 200, {
          ok: true,
          ticket: issued.ticket,
          expiresAt: issued.expiresAt,
          requestId: `cauth_${crypto.randomUUID()}`,
        });
        return true;
      }

      if (exchangeRoute) {
        const body = await readJson(req);
        secret = String(body?.ticket || "");
        const exchanged = await authService.exchangeTicket({
          ticket: secret,
          deviceFingerprint: String(body?.deviceFingerprint || ""),
          extensionVersion: String(body?.extensionVersion || ""),
        });
        sendJson(res, 200, {
          ok: true,
          collectorToken: exchanged.collectorToken,
          expiresAt: exchanged.expiresAt,
          account: publicAccount(exchanged),
          permissions: [...COLLECTOR_PERMISSIONS],
        });
        return true;
      }

      secret = collectorToken(req);
      if (!secret) {
        throw routeError(
          "需要 Collector 采集认证",
          401,
          "COLLECTOR_AUTH_REQUIRED",
        );
      }
      const authenticated = await authService.authenticate({
        collectorToken: secret,
        requiredPermission: STATUS_PERMISSION,
      });
      sendJson(res, 200, {
        ok: true,
        expiresAt: authenticated.expiresAt,
        account: publicAccount(authenticated),
        permissions: [...COLLECTOR_PERMISSIONS],
      });
      return true;
    } catch (error) {
      sendJson(res, errorStatus(error), safeErrorPayload(error, [secret]));
      return true;
    }
  };
}
