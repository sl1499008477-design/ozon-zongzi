import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createJsonCollectorAuthRepository } from "../collector-auth-repository.mjs";
import {
  COLLECTOR_PERMISSIONS,
  createCollectorAuthService,
  hashCollectorSecret,
} from "../collector-auth-service.mjs";
import { createCollectorAuthHttpHandler } from "../collector-auth-routes.mjs";

const NOW = new Date("2026-07-29T00:00:00.000Z");
const WEB_TOKEN = "local-web-route-token";
const ACCOUNT = {
  id: "account-route",
  displayName: "Route Account",
  status: "active",
  expiresAt: "2026-07-30T00:00:00.000Z",
};

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ozon-store-id, x-device-fingerprint",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function createRequest(method, pathname, {
  authorization = "",
  body,
} = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = pathname;
  req.headers = { "content-type": "application/json" };
  if (authorization) req.headers.authorization = authorization;
  return req;
}

function createResponse() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(text = "") {
      this.body = String(text || "");
    },
  };
}

async function request(handler, method, pathname, options = {}) {
  const req = createRequest(method, pathname, options);
  const res = createResponse();
  const url = new URL(pathname, "http://127.0.0.1");
  const handled = await handler(req, res, url);
  return {
    handled,
    status: res.status,
    headers: res.headers,
    body: res.body ? JSON.parse(res.body) : {},
  };
}

function createHarness() {
  const audits = [];
  const state = {
    accounts: [structuredClone(ACCOUNT), {
      id: "account-body-override",
      displayName: "Wrong Account",
      status: "active",
    }],
    sessions: {
      [WEB_TOKEN]: {
        token: WEB_TOKEN,
        accountId: ACCOUNT.id,
        expiresAt: "2026-07-30T00:00:00.000Z",
      },
    },
    collectorAuthTickets: [],
    collectorSessions: [],
  };
  const repository = createJsonCollectorAuthRepository({ state });
  const service = createCollectorAuthService({
    repository,
    now: () => new Date(NOW),
    randomBytes: (size) => Buffer.alloc(size, 7),
    audit: async (event) => audits.push(event),
  });
  const authService = {
    issueTicket: (input) => service.issueTicket(input),
    async exchangeTicket(input) {
      const exchanged = await service.exchangeTicket(input);
      const account = state.accounts.find((item) => item.id === exchanged.accountId);
      return {
        ...exchanged,
        account: {
          id: account.id,
          displayName: account.displayName,
        },
      };
    },
    async authenticate(input) {
      const authenticated = await service.authenticate(input);
      const account = state.accounts.find((item) => item.id === authenticated.accountId);
      return {
        ...authenticated,
        account: {
          id: account.id,
          displayName: account.displayName,
        },
      };
    },
  };
  const handler = createCollectorAuthHttpHandler({
    requireWebAuth(req) {
      if (req.headers.authorization !== `Bearer ${WEB_TOKEN}`) {
        throw Object.assign(new Error("未登录"), { status: 401, code: "LOCAL_AUTH_REQUIRED" });
      }
      return ACCOUNT;
    },
    findParentSession(req) {
      return req.headers.authorization === `Bearer ${WEB_TOKEN}` ? WEB_TOKEN : "";
    },
    authService,
    readJson,
    sendJson,
  });
  return { audits, handler, state };
}

test("ticket route requires Web bearer auth and ignores body account and permission overrides", async () => {
  const harness = createHarness();

  const unauthorized = await request(
    harness.handler,
    "POST",
    "/extension/collector-auth/ticket",
    { authorization: "Collector collector-token" },
  );
  assert.equal(unauthorized.status, 401);

  const issued = await request(
    harness.handler,
    "POST",
    "/extension/collector-auth/ticket",
    {
      authorization: `Bearer ${WEB_TOKEN}`,
      body: {
        accountId: "account-body-override",
        permissions: ["collector.admin"],
      },
    },
  );
  assert.equal(issued.status, 200);
  assert.equal(issued.body.ok, true);
  assert.match(issued.body.ticket, /^ctt_/);
  assert.match(issued.body.requestId, /^cauth_/);
  assert.deepEqual(
    Object.keys(issued.body).sort(),
    ["expiresAt", "ok", "requestId", "ticket"],
  );
  assert.equal(harness.state.collectorAuthTickets[0].accountId, ACCOUNT.id);
  assert.deepEqual(harness.state.collectorAuthTickets[0].permissions, [...COLLECTOR_PERMISSIONS]);
});

test("exchange accepts only a valid one-time ticket and returns the stable account session contract", async () => {
  const harness = createHarness();

  const missing = await request(
    harness.handler,
    "POST",
    "/extension/collector-auth/exchange",
    { body: { deviceFingerprint: "device-route", extensionVersion: "3.0.0" } },
  );
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, "COLLECTOR_TICKET_INVALID");

  const invalid = await request(
    harness.handler,
    "POST",
    "/extension/collector-auth/exchange",
    { body: { ticket: "not-a-ticket", deviceFingerprint: "device-route" } },
  );
  assert.equal(invalid.status, 401);
  assert.equal(invalid.body.code, "COLLECTOR_TICKET_INVALID");

  const issued = await request(
    harness.handler,
    "POST",
    "/extension/collector-auth/ticket",
    { authorization: `Bearer ${WEB_TOKEN}` },
  );
  const exchanged = await request(
    harness.handler,
    "POST",
    "/extension/collector-auth/exchange",
    {
      body: {
        ticket: issued.body.ticket,
        deviceFingerprint: "device-route",
        extensionVersion: "3.0.0",
        accountId: "account-body-override",
        permissions: ["collector.admin"],
      },
    },
  );
  assert.equal(exchanged.status, 200);
  assert.equal(exchanged.body.ok, true);
  assert.match(exchanged.body.collectorToken, /^cst_/);
  assert.deepEqual(exchanged.body.account, {
    id: ACCOUNT.id,
    displayName: ACCOUNT.displayName,
  });
  assert.deepEqual(exchanged.body.permissions, [...COLLECTOR_PERMISSIONS]);
  assert.equal("accountId" in exchanged.body, false);
  assert.equal("collectorSessionId" in exchanged.body, false);

  const reused = await request(
    harness.handler,
    "POST",
    "/extension/collector-auth/exchange",
    { body: { ticket: issued.body.ticket } },
  );
  assert.equal(reused.status, 409);
  assert.equal(reused.body.code, "COLLECTOR_TICKET_USED");
});

test("status accepts only the Collector authorization scheme", async () => {
  const harness = createHarness();
  const issued = await request(
    harness.handler,
    "POST",
    "/extension/collector-auth/ticket",
    { authorization: `Bearer ${WEB_TOKEN}` },
  );
  const exchanged = await request(
    harness.handler,
    "POST",
    "/extension/collector-auth/exchange",
    { body: { ticket: issued.body.ticket } },
  );

  const bearer = await request(
    harness.handler,
    "GET",
    "/extension/collector-auth/status",
    { authorization: `Bearer ${exchanged.body.collectorToken}` },
  );
  assert.equal(bearer.status, 401);
  assert.equal(bearer.body.code, "COLLECTOR_AUTH_REQUIRED");

  const status = await request(
    harness.handler,
    "GET",
    "/extension/collector-auth/status",
    { authorization: `Collector ${exchanged.body.collectorToken}` },
  );
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.account, {
    id: ACCOUNT.id,
    displayName: ACCOUNT.displayName,
  });
  assert.deepEqual(status.body.permissions, [...COLLECTOR_PERMISSIONS]);
  assert.equal(status.body.expiresAt, "2026-07-29T08:00:00.000Z");
});

test("route responses and collector audits never expose bearer tokens or secret hashes", async () => {
  const harness = createHarness();
  const issued = await request(
    harness.handler,
    "POST",
    "/extension/collector-auth/ticket",
    { authorization: `Bearer ${WEB_TOKEN}` },
  );
  const exchanged = await request(
    harness.handler,
    "POST",
    "/extension/collector-auth/exchange",
    { body: { ticket: issued.body.ticket } },
  );

  const auditJson = JSON.stringify(harness.audits);
  assert.doesNotMatch(auditJson, new RegExp(WEB_TOKEN));
  assert.doesNotMatch(auditJson, new RegExp(issued.body.ticket));
  assert.doesNotMatch(auditJson, new RegExp(exchanged.body.collectorToken));
  assert.doesNotMatch(auditJson, new RegExp(hashCollectorSecret(issued.body.ticket)));
  assert.doesNotMatch(auditJson, new RegExp(hashCollectorSecret(exchanged.body.collectorToken)));

  const responseJson = JSON.stringify([issued.body, exchanged.body]);
  assert.doesNotMatch(responseJson, new RegExp(WEB_TOKEN));
  assert.doesNotMatch(responseJson, new RegExp(hashCollectorSecret(issued.body.ticket)));
  assert.doesNotMatch(responseJson, new RegExp(hashCollectorSecret(exchanged.body.collectorToken)));
  assert.match(String(issued.headers["Access-Control-Allow-Headers"]), /Authorization/);
  assert.equal(issued.headers["Access-Control-Allow-Origin"], "*");
});

test("unrelated routes are not absorbed by collector auth", async () => {
  const harness = createHarness();
  const result = await request(harness.handler, "GET", "/health");
  assert.equal(result.handled, false);
  assert.equal(result.status, 0);
});
