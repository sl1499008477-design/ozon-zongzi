import crypto from "node:crypto";
import { assertPermission, PERMISSIONS } from "./permissions.mjs";

export function normalizeAccountExpiresAt(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    const error = new Error("登录期限不是有效时间");
    error.status = 400;
    throw error;
  }
  return date.toISOString();
}

export function createPasswordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    passwordSalt: salt,
    passwordHash: crypto.scryptSync(String(password || ""), salt, 32).toString("hex"),
    passwordAlgorithm: "scrypt",
  };
}

export function verifyPassword(password, account = {}) {
  if (!account.passwordHash || !account.passwordSalt) return false;
  const hash = crypto.scryptSync(String(password || ""), account.passwordSalt, 32);
  const expected = Buffer.from(account.passwordHash, "hex");
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}

export function createAccountRecord({
  username,
  password,
  displayName,
  role = "user",
  expiresAt = "",
  status = "active",
}) {
  const now = new Date().toISOString();
  return {
    id: `acct_${crypto.randomUUID()}`,
    username: String(username || "").trim(),
    displayName: String(displayName || username || "").trim(),
    role: role === "admin" ? "admin" : "user",
    status: status === "disabled" ? "disabled" : "active",
    expiresAt: normalizeAccountExpiresAt(expiresAt),
    ...createPasswordHash(password),
    createdAt: now,
    updatedAt: now,
    lastLoginAt: "",
  };
}

export function isAccountExpired(account = {}, now = Date.now()) {
  if (!account.expiresAt) return false;
  const expiresAt = new Date(account.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

export function publicAccount(account = {}) {
  if (!account?.id) return null;
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName || account.username,
    role: account.role === "admin" ? "admin" : "user",
    status: account.status === "disabled" ? "disabled" : "active",
    expiresAt: account.expiresAt || "",
    expired: isAccountExpired(account),
    createdAt: account.createdAt || "",
    updatedAt: account.updatedAt || "",
    lastLoginAt: account.lastLoginAt || "",
  };
}

export function activeAccount(state, accountId = state.currentAccountId) {
  return (state.accounts || []).find((account) => String(account.id) === String(accountId)) || null;
}

export function findAccountByUsername(state, username) {
  const key = String(username || "").trim().toLowerCase();
  if (!key) return null;
  return (state.accounts || []).find((account) => String(account.username || "").toLowerCase() === key) || null;
}

export function storesForAccount(state, accountId = state.currentAccountId) {
  const ownerId = String(accountId || "");
  if (!ownerId) return [];
  return (state.stores || []).filter((store) => String(store.ownerAccountId || "") === ownerId);
}

export function currentStoreIdForAccount(state, accountId = state.currentAccountId) {
  const ownerId = String(accountId || "");
  if (!ownerId) return "";
  const stores = storesForAccount(state, ownerId);
  const mappedId = state.currentStoreIdsByAccount?.[ownerId] || "";
  const legacyId = String(state.currentAccountId || "") === ownerId ? state.currentStoreId || "" : "";
  const candidateId = mappedId || legacyId;
  if (stores.some((store) => String(store.id || "") === String(candidateId))) return candidateId;
  return stores[0]?.id || "";
}

export function setCurrentStoreForAccount(state, accountId, storeId) {
  const ownerId = String(accountId || "");
  if (!ownerId) return;
  state.currentStoreIdsByAccount = state.currentStoreIdsByAccount && typeof state.currentStoreIdsByAccount === "object"
    ? state.currentStoreIdsByAccount
    : {};
  if (storeId) state.currentStoreIdsByAccount[ownerId] = storeId;
  else delete state.currentStoreIdsByAccount[ownerId];
  if (String(state.currentAccountId || "") === ownerId) state.currentStoreId = storeId || "";
}

export function findStore(state, storeId) {
  return (state.stores || []).find((store) => String(store.id) === String(storeId)) || null;
}

export function activeStore(state, storeId = state.currentStoreId, accountId = state.currentAccountId) {
  const store = findStore(state, storeId);
  if (!store) return null;
  return String(store.ownerAccountId || "") === String(accountId || "") ? store : null;
}

export function storeIdForAccountRequest(state, account, requestedStoreId = "") {
  const storeId = String(requestedStoreId || currentStoreIdForAccount(state, account?.id) || "").trim();
  if (!storeId) return "";
  if (!activeStore(state, storeId, account?.id)) {
    const error = new Error("经营店铺不存在或不属于当前 sonli 账号");
    error.status = 403;
    error.code = "STORE_ACCOUNT_FORBIDDEN";
    throw error;
  }
  return storeId;
}

export function createStoreId(clientId) {
  return `local_${crypto.createHash("sha256").update(String(clientId)).digest("hex").slice(0, 12)}`;
}

export function normalizeDateOnly(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

export function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function createToken() {
  return `local-${crypto.randomUUID()}`;
}

export function bearerToken(req) {
  const value = req.headers.authorization || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

export function findSession(state, token) {
  if (!token) return null;
  if (state.sessions && typeof state.sessions === "object" && state.sessions[token]) {
    return state.sessions[token];
  }
  if (state.token && token === state.token && state.currentAccountId) {
    return {
      token,
      accountId: state.currentAccountId,
      issuedAt: state.sessionIssuedAt || "",
      lastSeenAt: "",
      legacy: true,
    };
  }
  return null;
}

function setSessionContext(state, token, account, session = {}) {
  state.token = token;
  state.currentAccountId = account.id;
  state.sessionIssuedAt = session.issuedAt || state.sessionIssuedAt || new Date().toISOString();
  state.currentStoreId = currentStoreIdForAccount(state, account.id);
}

export function revokeAccountSessions(state, accountId) {
  const ownerId = String(accountId || "");
  if (!ownerId || !state.sessions || typeof state.sessions !== "object") return;
  for (const [token, session] of Object.entries(state.sessions)) {
    if (String(session?.accountId || "") === ownerId) delete state.sessions[token];
  }
  if (String(state.currentAccountId || "") === ownerId) {
    state.token = "";
    state.currentAccountId = "";
    state.sessionIssuedAt = "";
    state.currentStoreId = "";
  }
}

export function removeSession(state, token) {
  if (!token) return;
  if (state.sessions && typeof state.sessions === "object") delete state.sessions[token];
  if (state.token === token) {
    const remaining = Object.entries(state.sessions || {})
      .filter(([, session]) => activeAccount(state, session?.accountId))
      .sort(([, left], [, right]) => String(right?.lastSeenAt || right?.issuedAt || "").localeCompare(String(left?.lastSeenAt || left?.issuedAt || "")));
    const [nextToken, nextSession] = remaining[0] || [];
    const nextAccount = nextSession ? activeAccount(state, nextSession.accountId) : null;
    if (nextToken && nextAccount) setSessionContext(state, nextToken, nextAccount, nextSession);
    else {
      state.token = "";
      state.currentAccountId = "";
      state.sessionIssuedAt = "";
      state.currentStoreId = "";
    }
  }
}

export function createAuthSession(state, account, req) {
  const now = new Date().toISOString();
  const token = createToken();
  state.sessions =
    state.sessions
    && typeof state.sessions === "object"
    && !Array.isArray(state.sessions)
      ? state.sessions
      : {};
  state.sessions[token] = {
    token,
    accountId: account.id,
    issuedAt: now,
    lastSeenAt: now,
    userAgent: String(req.headers["user-agent"] || "").slice(0, 240),
  };
  setSessionContext(state, token, account, state.sessions[token]);
  return token;
}

function codedAuthError(code, status, message) {
  return Object.assign(new Error(message), { code, status });
}

export function requireAuth(req, state) {
  const token = bearerToken(req);
  const session = findSession(state, token);
  if (!session) {
    throw codedAuthError("WEB_AUTH_REQUIRED", 401, "未登录，请先登录 sonli");
  }
  const account = activeAccount(state, session.accountId);
  if (!account) {
    removeSession(state, token);
    throw codedAuthError("WEB_AUTH_REQUIRED", 401, "登录状态已失效，请重新登录");
  }
  if (account.status === "disabled") {
    revokeAccountSessions(state, account.id);
    throw codedAuthError("COLLECTOR_ACCOUNT_DISABLED", 403, "账号已被停用，请联系管理员");
  }
  if (isAccountExpired(account)) {
    revokeAccountSessions(state, account.id);
    throw codedAuthError("COLLECTOR_ACCOUNT_EXPIRED", 403, "账号登录期限已过期，请联系管理员");
  }
  if (state.sessions?.[token]) state.sessions[token].lastSeenAt = new Date().toISOString();
  setSessionContext(state, token, account, session);
  return account;
}

export function optionalAuth(req, state) {
  if (!bearerToken(req)) return null;
  try {
    return requireAuth(req, state);
  } catch {
    return null;
  }
}

export function requireAdmin(req, state) {
  return requirePermission(req, state, PERMISSIONS.ACCOUNT_MANAGE);
}

export function requirePermission(req, state, permission) {
  return assertPermission(requireAuth(req, state), permission);
}
