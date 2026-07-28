import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

async function requestJson(handle, method, pathname, body = null, token = "") {
  const payload = body ? JSON.stringify(body) : "";
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = pathname;
  req.headers = {
    "content-type": "application/json",
  };
  if (token) req.headers.authorization = `Bearer ${token}`;
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
const testAdminPassword = "test-admin-login-2026!";

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
process.env.SONLI_ADMIN_PASSWORD = testAdminPassword;

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

  const logoutFirst = await requestJson(handle, "POST", "/local/accounts/logout", {}, firstLogin.body.token);
  assert.equal(logoutFirst.status, 200);

  const firstAfterLogout = await requestJson(handle, "GET", "/local/state", null, firstLogin.body.token);
  assert.equal(firstAfterLogout.status, 200);
  assert.equal(firstAfterLogout.body.requiresLogin, true);

  const secondAfterLogout = await requestJson(handle, "GET", "/local/state", null, secondLogin.body.token);
  assert.equal(secondAfterLogout.status, 200);
  assert.equal(secondAfterLogout.body.account.username, "admin");

  console.log("account multi-session smoke passed");
  process.exitCode = 0;
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
