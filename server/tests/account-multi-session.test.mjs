import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

async function requestJson(handle, method, pathname, body = null, authorization = "") {
  const payload = body ? JSON.stringify(body) : "";
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = pathname;
  req.headers = {
    "content-type": "application/json",
  };
  if (authorization) {
    req.headers.authorization = authorization.includes(" ")
      ? authorization
      : `Bearer ${authorization}`;
  }
  const res = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(text = "") {
      this.body = String(text || "");
    },
  };
  await handle(req, res);
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-account-session-"));
const dataFile = path.join(dataDir, "local-state.json");
const testAdminPassword = "test-admin-login-2026!";

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
process.env.SONLI_ADMIN_PASSWORD = testAdminPassword;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

try {
  const { handle } = await import("../index.mjs");

  const firstLogin = await requestJson(handle, "POST", "/local/accounts/login", {
    username: "admin",
    password: testAdminPassword,
  });
  assert.equal(firstLogin.status, 200);
  assert.ok(firstLogin.body.token);

  const secondLogin = await requestJson(handle, "POST", "/local/accounts/login", {
    username: "admin",
    password: testAdminPassword,
  });
  assert.equal(secondLogin.status, 200);
  assert.ok(secondLogin.body.token);
  assert.notEqual(firstLogin.body.token, secondLogin.body.token);

  const firstState = await requestJson(handle, "GET", "/local/state", null, firstLogin.body.token);
  assert.equal(firstState.status, 200);
  assert.equal(firstState.body.account.username, "admin");

  const secondState = await requestJson(handle, "GET", "/local/state", null, secondLogin.body.token);
  assert.equal(secondState.status, 200);
  assert.equal(secondState.body.account.username, "admin");

  async function exchangeFor(webToken, deviceFingerprint) {
    const issued = await requestJson(
      handle,
      "POST",
      "/extension/collector-auth/ticket",
      {},
      webToken,
    );
    assert.equal(issued.status, 200);
    const exchanged = await requestJson(
      handle,
      "POST",
      "/extension/collector-auth/exchange",
      {
        ticket: issued.body.ticket,
        deviceFingerprint,
        extensionVersion: "3.0.0-test",
      },
    );
    assert.equal(exchanged.status, 200);
    return exchanged.body.collectorToken;
  }

  async function assertCollectorRevoked(collectorToken, reason) {
    const persisted = JSON.parse(await readFile(dataFile, "utf8"));
    const tokenHash = crypto.createHash("sha256").update(collectorToken).digest("hex");
    const session = persisted.collectorSessions.find((item) => item.tokenHash === tokenHash);
    assert.ok(session?.revokedAt);
    assert.equal(session.revokedReason, reason);
  }

  async function assertCollectorAuthRemoved(accountId, collectorToken) {
    const persisted = JSON.parse(await readFile(dataFile, "utf8"));
    const tokenHash = crypto.createHash("sha256").update(collectorToken).digest("hex");
    assert.equal(
      persisted.collectorSessions.some((item) => item.tokenHash === tokenHash),
      false,
    );
    assert.equal(
      persisted.collectorSessions.some((item) => item.accountId === accountId),
      false,
    );
    assert.equal(
      persisted.collectorAuthTickets.some((item) => item.accountId === accountId),
      false,
    );
  }

  const firstCollectorToken = await exchangeFor(firstLogin.body.token, "device-first");
  const secondCollectorToken = await exchangeFor(secondLogin.body.token, "device-second");

  const logoutFirst = await requestJson(handle, "POST", "/local/accounts/logout", {}, firstLogin.body.token);
  assert.equal(logoutFirst.status, 200);

  const firstAfterLogout = await requestJson(handle, "GET", "/local/state", null, firstLogin.body.token);
  assert.equal(firstAfterLogout.status, 200);
  assert.equal(firstAfterLogout.body.requiresLogin, true);

  const secondAfterLogout = await requestJson(handle, "GET", "/local/state", null, secondLogin.body.token);
  assert.equal(secondAfterLogout.status, 200);
  assert.equal(secondAfterLogout.body.account.username, "admin");

  const firstCollectorAfterLogout = await requestJson(
    handle,
    "GET",
    "/extension/collector-auth/status",
    null,
    `Collector ${firstCollectorToken}`,
  );
  assert.equal(firstCollectorAfterLogout.status, 401);
  await assertCollectorRevoked(firstCollectorToken, "WEB_LOGOUT");

  const secondCollectorAfterLogout = await requestJson(
    handle,
    "GET",
    "/extension/collector-auth/status",
    null,
    `Collector ${secondCollectorToken}`,
  );
  assert.equal(secondCollectorAfterLogout.status, 200);

  async function createUserWithCollector(username) {
    const created = await requestJson(
      handle,
      "POST",
      "/local/accounts",
      {
        username,
        password: `${username}-password-2026!`,
        displayName: username,
      },
      secondLogin.body.token,
    );
    assert.equal(created.status, 200);
    const login = await requestJson(handle, "POST", "/local/accounts/login", {
      username,
      password: `${username}-password-2026!`,
    });
    assert.equal(login.status, 200);
    return {
      accountId: created.body.account.id,
      webToken: login.body.token,
      collectorToken: await exchangeFor(login.body.token, `device-${username}`),
    };
  }

  const disabledUser = await createUserWithCollector("disabled-user");
  assert.equal((await requestJson(
    handle,
    "PATCH",
    `/local/accounts/${disabledUser.accountId}`,
    { status: "disabled" },
    secondLogin.body.token,
  )).status, 200);
  assert.equal((await requestJson(
    handle,
    "GET",
    "/extension/collector-auth/status",
    null,
    `Collector ${disabledUser.collectorToken}`,
  )).status, 403);
  await assertCollectorRevoked(disabledUser.collectorToken, "ACCOUNT_DISABLED");

  const expiredUser = await createUserWithCollector("expired-user");
  assert.equal((await requestJson(
    handle,
    "PATCH",
    `/local/accounts/${expiredUser.accountId}`,
    { expiresAt: "2020-01-01T00:00:00.000Z" },
    secondLogin.body.token,
  )).status, 200);
  assert.equal((await requestJson(
    handle,
    "GET",
    "/extension/collector-auth/status",
    null,
    `Collector ${expiredUser.collectorToken}`,
  )).status, 403);
  await assertCollectorRevoked(expiredUser.collectorToken, "ACCOUNT_EXPIRED");

  const deletedUser = await createUserWithCollector("deleted-user");
  assert.equal((await requestJson(
    handle,
    "DELETE",
    `/local/accounts/${deletedUser.accountId}`,
    {},
    secondLogin.body.token,
  )).status, 200);
  assert.equal((await requestJson(
    handle,
    "GET",
    "/extension/collector-auth/status",
    null,
    `Collector ${deletedUser.collectorToken}`,
  )).status, 401);
  await assertCollectorAuthRemoved(deletedUser.accountId, deletedUser.collectorToken);

  const naturallyExpiredUser = await createUserWithCollector("naturally-expired-user");
  const naturallyExpiredState = JSON.parse(await readFile(dataFile, "utf8"));
  naturallyExpiredState.accounts.find(
    (account) => account.id === naturallyExpiredUser.accountId,
  ).expiresAt = "2020-01-01T00:00:00.000Z";
  await writeFile(dataFile, JSON.stringify(naturallyExpiredState), "utf8");
  assert.equal((await requestJson(
    handle,
    "GET",
    "/extension/collector-auth/status",
    null,
    `Collector ${naturallyExpiredUser.collectorToken}`,
  )).status, 403);
  await assertCollectorRevoked(naturallyExpiredUser.collectorToken, "ACCOUNT_EXPIRED");

  const recoveredWithoutAuth = await createUserWithCollector("recovered-without-auth-user");
  const recoveryState = JSON.parse(await readFile(dataFile, "utf8"));
  recoveryState.accounts.find(
    (account) => account.id === recoveredWithoutAuth.accountId,
  ).expiresAt = "2020-01-01T00:00:00.000Z";
  await writeFile(dataFile, JSON.stringify(recoveryState), "utf8");

  const recovered = await requestJson(
    handle,
    "PATCH",
    `/local/accounts/${recoveredWithoutAuth.accountId}`,
    { expiresAt: "2099-01-01T00:00:00.000Z" },
    secondLogin.body.token,
  );
  assert.equal(recovered.status, 200);
  assert.equal((await requestJson(
    handle,
    "GET",
    "/extension/collector-auth/status",
    null,
    `Collector ${recoveredWithoutAuth.collectorToken}`,
  )).status, 401);
  assert.equal((await requestJson(
    handle,
    "POST",
    "/extension/collector-auth/ticket",
    {},
    recoveredWithoutAuth.webToken,
  )).status, 401);
  await assertCollectorRevoked(recoveredWithoutAuth.collectorToken, "ACCOUNT_EXPIRED");
  assert.equal((await requestJson(
    handle,
    "GET",
    "/extension/collector-auth/status",
    null,
    `Collector ${secondCollectorToken}`,
  )).status, 200);

  assert.equal((await requestJson(
    handle,
    "PATCH",
    `/local/accounts/${secondLogin.body.account.id}`,
    { password: "updated-admin-password-2026!" },
    secondLogin.body.token,
  )).status, 200);
  assert.equal((await requestJson(
    handle,
    "GET",
    "/extension/collector-auth/status",
    null,
    `Collector ${secondCollectorToken}`,
  )).status, 401);
  await assertCollectorRevoked(secondCollectorToken, "SECURITY_RESET");

  const oldPasswordLogin = await requestJson(handle, "POST", "/local/accounts/login", {
    username: "admin",
    password: testAdminPassword,
  });
  assert.equal(oldPasswordLogin.status, 401);
  const newPasswordLogin = await requestJson(handle, "POST", "/local/accounts/login", {
    username: "admin",
    password: "updated-admin-password-2026!",
  });
  assert.equal(newPasswordLogin.status, 200);
  assert.equal(newPasswordLogin.body.state.account.id, secondLogin.body.account.id);
  assert.equal(newPasswordLogin.body.state.token, newPasswordLogin.body.token);
  assert.deepEqual(newPasswordLogin.body.state.accounts, []);

  console.log("account multi-session smoke passed");
  process.exitCode = 0;
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
