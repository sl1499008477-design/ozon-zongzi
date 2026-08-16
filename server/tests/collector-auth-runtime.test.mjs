import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createCollectorAuthRuntime } from "../collector-auth-runtime.mjs";
import { hashCollectorSecret } from "../collector-auth-service.mjs";
import { createJsonStateTransactionBoundary } from "../json-state-transaction.mjs";
import { createObjectCleanupWorker } from "../object-cleanup-worker.mjs";

const WEB_TOKEN = "runtime-web-token";
const ACCOUNT = {
  id: "runtime-account",
  displayName: "Runtime Account",
  status: "active",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function initialState() {
  return {
    accounts: [structuredClone(ACCOUNT)],
    sessions: {
      [WEB_TOKEN]: {
        token: WEB_TOKEN,
        accountId: ACCOUNT.id,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
    collectorAuthTickets: [],
    collectorSessions: [],
    auditEvents: [],
    businessChanges: [],
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(res, status, payload) {
  res.status = status;
  res.body = payload;
}

async function request(runtime, method, pathname, {
  authorization = "",
  body,
} = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = pathname;
  req.headers = { host: "127.0.0.1", "content-type": "application/json" };
  if (authorization) req.headers.authorization = authorization;
  const res = { status: 0, body: null };
  const handled = await runtime.handleHttpRoute(
    req,
    res,
    new URL(pathname, "http://127.0.0.1"),
  );
  return { handled, status: res.status, body: res.body };
}

function collectorRequest(token) {
  const req = Readable.from([]);
  req.headers = { authorization: `Collector ${token}` };
  return req;
}

function jsonRuntime(state, {
  saveState = async (nextState) => Object.assign(state, structuredClone(nextState)),
} = {}) {
  return createCollectorAuthRuntime({
    loadState: async () => structuredClone(state),
    saveState,
    persistenceMode: () => "json",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    readJson,
    sendJson,
  });
}

function postgresRuntimeHarness() {
  const state = initialState();
  const tickets = new Map();
  const audits = [];
  let initialized = false;
  let legacyReadsAfterInitialization = 0;
  let legacyWritesAfterInitialization = 0;

  const contextFor = (record) => ({
    ...record,
    account: structuredClone(ACCOUNT),
    parentSession: {
      accountId: ACCOUNT.id,
      expiresAt: state.sessions[WEB_TOKEN].expiresAt,
      revokedAt: null,
    },
  });
  const repository = {
    async createTicket(record) {
      tickets.set(record.ticketHash, structuredClone(record));
      return contextFor(record);
    },
    async consumeTicketAtomically({ ticketHash, now }) {
      const record = tickets.get(ticketHash);
      if (!record) return { outcome: "not_found" };
      record.consumedAt = now.toISOString();
      return { outcome: "consumed", ticket: contextFor(record) };
    },
    async createSession(record) {
      return { session: contextFor(record), supersededCount: 2 };
    },
    async findActiveSession() {
      return null;
    },
    async touchSession() {
      return false;
    },
    async revokeSessions() {
      return 0;
    },
  };

  const runtime = createCollectorAuthRuntime({
    async loadState() {
      if (initialized) {
        legacyReadsAfterInitialization += 1;
        throw new Error("legacy state read after PostgreSQL repository initialization");
      }
      return structuredClone(state);
    },
    async saveState() {
      if (initialized) {
        legacyWritesAfterInitialization += 1;
        throw new Error("legacy state write after PostgreSQL repository initialization");
      }
    },
    persistenceMode: () => "postgres",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    async initializePostgresRepository() {
      initialized = true;
      return repository;
    },
    async insertAuditEvent(event) {
      audits.push(structuredClone(event));
    },
    readJson,
    sendJson,
  });

  return {
    runtime,
    audits,
    legacyAttempts: () => ({
      reads: legacyReadsAfterInitialization,
      writes: legacyWritesAfterInitialization,
    }),
  };
}

test("real runtime ticket route preserves stable Web auth and account codes without leaking credentials", async (context) => {
  const cases = [{
    name: "missing Web session",
    mutateState(state) { delete state.sessions[WEB_TOKEN]; },
    expectedStatus: 401,
    expectedCode: "WEB_AUTH_REQUIRED",
  }, {
    name: "missing account",
    mutateState(state) { state.accounts = []; },
    expectedStatus: 401,
    expectedCode: "WEB_AUTH_REQUIRED",
  }, {
    name: "disabled",
    mutateState(state) { state.accounts[0].status = "disabled"; },
    expectedStatus: 403,
    expectedCode: "COLLECTOR_ACCOUNT_DISABLED",
  }, {
    name: "expired",
    mutateState(state) { state.accounts[0].expiresAt = "2000-01-01T00:00:00.000Z"; },
    expectedStatus: 403,
    expectedCode: "COLLECTOR_ACCOUNT_EXPIRED",
  }];

  for (const fixture of cases) {
    await context.test(fixture.name, async () => {
      const state = initialState();
      fixture.mutateState(state);

      const result = await request(
        jsonRuntime(state),
        "POST",
        "/extension/collector-auth/ticket",
        { authorization: `Bearer ${WEB_TOKEN}` },
      );

      assert.equal(result.status, fixture.expectedStatus);
      assert.equal(result.body.code, fixture.expectedCode);
      const serialized = JSON.stringify(result.body);
      assert.equal(serialized.includes(ACCOUNT.id), false);
      assert.equal(serialized.includes(WEB_TOKEN), false);
      assert.equal(serialized.includes("COLLECTOR_AUTH_FAILED"), false);
    });
  }
});

test("disabled and expired account authentication persistently revokes old Collector tokens across recovery", async (context) => {
  const cases = [{
    name: "disabled",
    deactivate(account) { account.status = "disabled"; },
    recover(account) { account.status = "active"; },
    expectedCode: "COLLECTOR_ACCOUNT_DISABLED",
    expectedReason: "ACCOUNT_DISABLED",
  }, {
    name: "expired",
    deactivate(account) { account.expiresAt = "2000-01-01T00:00:00.000Z"; },
    recover(account) { account.expiresAt = "2099-01-01T00:00:00.000Z"; },
    expectedCode: "COLLECTOR_ACCOUNT_EXPIRED",
    expectedReason: "ACCOUNT_EXPIRED",
  }];

  for (const fixture of cases) {
    await context.test(fixture.name, async () => {
      const state = initialState();
      const runtime = jsonRuntime(state);
      const issued = await request(runtime, "POST", "/extension/collector-auth/ticket", {
        authorization: `Bearer ${WEB_TOKEN}`,
      });
      const exchanged = await request(runtime, "POST", "/extension/collector-auth/exchange", {
        body: {
          ticket: issued.body.ticket,
          deviceFingerprint: `runtime-${fixture.name}-device`,
          extensionVersion: "3.0.0-test",
        },
      });
      const collectorToken = exchanged.body.collectorToken;

      fixture.deactivate(state.accounts[0]);
      let inactiveError;
      await assert.rejects(
        runtime.authenticateSessionRequest(
          collectorRequest(collectorToken),
          "collector.config.read",
        ),
        (error) => {
          inactiveError = error;
          return error?.code === fixture.expectedCode;
        },
      );
      const inactiveErrorText = `${inactiveError?.code} ${inactiveError?.message}`;
      for (const secret of [ACCOUNT.id, WEB_TOKEN, collectorToken]) {
        assert.equal(inactiveErrorText.includes(secret), false);
      }
      assert.ok(state.collectorSessions[0].revokedAt);
      assert.equal(state.collectorSessions[0].revokedReason, fixture.expectedReason);

      fixture.recover(state.accounts[0]);
      let recoveryError;
      await assert.rejects(
        runtime.authenticateSessionRequest(
          collectorRequest(collectorToken),
          "collector.config.read",
        ),
        (error) => {
          recoveryError = error;
          return error?.code === "COLLECTOR_SESSION_REVOKED";
        },
      );
      const recoveryErrorText = `${recoveryError?.code} ${recoveryError?.message}`;
      for (const secret of [ACCOUNT.id, WEB_TOKEN, collectorToken]) {
        assert.equal(recoveryErrorText.includes(secret), false);
      }
    });
  }
});

test("audit save failure after required account revocation cannot revive the old Collector token", async () => {
  const state = initialState();
  let failNextAuditSave = false;
  const runtime = jsonRuntime(state, {
    async saveState(nextState) {
      const addsAudit = nextState.auditEvents.length > state.auditEvents.length;
      if (failNextAuditSave && addsAudit) {
        failNextAuditSave = false;
        throw new Error("audit save unavailable");
      }
      Object.assign(state, structuredClone(nextState));
    },
  });
  const issued = await request(runtime, "POST", "/extension/collector-auth/ticket", {
    authorization: `Bearer ${WEB_TOKEN}`,
  });
  const exchanged = await request(runtime, "POST", "/extension/collector-auth/exchange", {
    body: { ticket: issued.body.ticket, deviceFingerprint: "audit-failure-device" },
  });
  const collectorToken = exchanged.body.collectorToken;

  state.accounts[0].status = "disabled";
  failNextAuditSave = true;
  await assert.rejects(
    runtime.authenticateSessionRequest(
      collectorRequest(collectorToken),
      "collector.config.read",
    ),
    (error) => error?.code === "COLLECTOR_ACCOUNT_DISABLED",
  );
  assert.ok(state.collectorSessions[0].revokedAt);
  assert.equal(state.collectorSessions[0].revokedReason, "ACCOUNT_DISABLED");

  state.accounts[0].status = "active";
  await assert.rejects(
    runtime.authenticateSessionRequest(
      collectorRequest(collectorToken),
      "collector.config.read",
    ),
    (error) => error?.code === "COLLECTOR_SESSION_REVOKED",
  );
});

test("required account revocation save failure is surfaced and can be retried before recovery", async () => {
  const state = initialState();
  let failNextRevokeSave = false;
  let collectorToken = "";
  const runtime = jsonRuntime(state, {
    async saveState(nextState) {
      const addsRevocation = Boolean(nextState.collectorSessions[0]?.revokedAt)
        && !state.collectorSessions[0]?.revokedAt;
      if (failNextRevokeSave && addsRevocation) {
        failNextRevokeSave = false;
        throw new Error(`raw revoke failure ${ACCOUNT.id} ${collectorToken}`);
      }
      Object.assign(state, structuredClone(nextState));
    },
  });
  const issued = await request(runtime, "POST", "/extension/collector-auth/ticket", {
    authorization: `Bearer ${WEB_TOKEN}`,
  });
  const exchanged = await request(runtime, "POST", "/extension/collector-auth/exchange", {
    body: { ticket: issued.body.ticket, deviceFingerprint: "revoke-failure-device" },
  });
  collectorToken = exchanged.body.collectorToken;

  state.accounts[0].status = "disabled";
  failNextRevokeSave = true;
  let revokeError;
  await assert.rejects(
    runtime.authenticateSessionRequest(
      collectorRequest(collectorToken),
      "collector.config.read",
    ),
    (error) => {
      revokeError = error;
      return error?.code === "COLLECTOR_AUTH_PERSISTENCE_FAILED";
    },
  );
  assert.equal(state.collectorSessions[0].revokedAt, null);
  const publicError = `${revokeError?.code} ${revokeError?.message}`;
  for (const secret of ["raw revoke failure", ACCOUNT.id, collectorToken]) {
    assert.equal(publicError.includes(secret), false);
  }

  await assert.rejects(
    runtime.authenticateSessionRequest(
      collectorRequest(collectorToken),
      "collector.config.read",
    ),
    (error) => error?.code === "COLLECTOR_ACCOUNT_DISABLED",
  );
  assert.ok(state.collectorSessions[0].revokedAt);
  assert.equal(state.collectorSessions[0].revokedReason, "ACCOUNT_DISABLED");

  state.accounts[0].status = "active";
  await assert.rejects(
    runtime.authenticateSessionRequest(
      collectorRequest(collectorToken),
      "collector.config.read",
    ),
    (error) => error?.code === "COLLECTOR_SESSION_REVOKED",
  );
});

test("expired presented Collector token still revokes every account token before recovery", async () => {
  const state = initialState();
  const runtime = jsonRuntime(state);
  const issueAndExchangeForDevice = async (deviceFingerprint) => {
    const issued = await request(runtime, "POST", "/extension/collector-auth/ticket", {
      authorization: `Bearer ${WEB_TOKEN}`,
    });
    const exchanged = await request(runtime, "POST", "/extension/collector-auth/exchange", {
      body: { ticket: issued.body.ticket, deviceFingerprint },
    });
    return exchanged.body.collectorToken;
  };
  const expiredToken = await issueAndExchangeForDevice("expired-presented-device");
  const liveToken = await issueAndExchangeForDevice("other-live-device");
  const expiredHash = hashCollectorSecret(expiredToken);
  state.collectorSessions.find(({ tokenHash }) => tokenHash === expiredHash).expiresAt = (
    "2000-01-01T00:00:00.000Z"
  );
  state.accounts[0].expiresAt = "2000-01-01T00:00:00.000Z";

  await assert.rejects(
    runtime.authenticateSessionRequest(
      collectorRequest(expiredToken),
      "collector.config.read",
    ),
    (error) => error?.code === "COLLECTOR_ACCOUNT_EXPIRED",
  );
  assert.equal(state.collectorSessions.every(({ revokedReason }) => (
    revokedReason === "ACCOUNT_EXPIRED"
  )), true);

  state.accounts[0].expiresAt = "2099-01-01T00:00:00.000Z";
  for (const token of [expiredToken, liveToken]) {
    await assert.rejects(
      runtime.authenticateSessionRequest(
        collectorRequest(token),
        "collector.config.read",
      ),
      (error) => error?.code === "COLLECTOR_SESSION_REVOKED",
    );
  }
});

test("authenticateSessionRequest returns the safe full session for Ozon reads without Collector or Web secrets", async () => {
  const state = initialState();
  const runtime = jsonRuntime(state);
  const issued = await request(runtime, "POST", "/extension/collector-auth/ticket", {
    authorization: `Bearer ${WEB_TOKEN}`,
  });
  const exchanged = await request(runtime, "POST", "/extension/collector-auth/exchange", {
    body: {
      ticket: issued.body.ticket,
      deviceFingerprint: "runtime-device",
      extensionVersion: "3.0.0-test",
    },
  });

  const session = await runtime.authenticateSessionRequest(
    collectorRequest(exchanged.body.collectorToken),
    "collector.ozon.read",
  );

  assert.deepEqual(session, {
    collectorSessionId: state.collectorSessions[0].id,
    accountId: ACCOUNT.id,
    deviceFingerprint: "runtime-device",
    extensionVersion: "3.0.0-test",
    permissions: [
      "collector.upload",
      "collector.job.read",
      "collector.config.read",
      "collector.ozon.read",
    ],
    expiresAt: state.collectorSessions[0].expiresAt,
    account: { id: ACCOUNT.id, displayName: ACCOUNT.displayName },
  });
  const serialized = JSON.stringify(session);
  assert.equal(serialized.includes(exchanged.body.collectorToken), false);
  assert.equal(serialized.includes(WEB_TOKEN), false);
  assert.equal(serialized.includes(state.collectorSessions[0].tokenHash), false);
});

test("authenticateSessionRequest rejects legacy sessions without Ozon read permission", async () => {
  const state = initialState();
  const legacyToken = "cst_legacy-collector-session";
  state.collectorSessions.push({
    id: "csess_legacy",
    tokenHash: hashCollectorSecret(legacyToken),
    accountId: ACCOUNT.id,
    parentSessionToken: WEB_TOKEN,
    deviceFingerprint: "legacy-device",
    extensionVersion: "3.0.0",
    permissions: ["collector.upload", "collector.job.read", "collector.config.read"],
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
    revokedReason: "",
    lastSeenAt: "2026-07-29T00:00:00.000Z",
    createdAt: "2026-07-29T00:00:00.000Z",
  });

  await assert.rejects(
    jsonRuntime(state).authenticateSessionRequest(
      collectorRequest(legacyToken),
      "collector.ozon.read",
    ),
    (error) => error?.status === 403 && error?.code === "COLLECTOR_PERMISSION_DENIED",
  );
});

test("shared JSON transaction preserves collector writes and a concurrent normal business mutation", async () => {
  let persisted = initialState();
  const collectorSaveStarted = deferred();
  const releaseCollectorSave = deferred();
  const normalLoaded = deferred();
  const releaseNormalSave = deferred();
  let collectorSaveBlocked = false;

  async function loadState() {
    return structuredClone(persisted);
  }

  async function saveState(nextState) {
    const isCollectorWrite = nextState.collectorAuthTickets.length > 0
      && nextState.businessChanges.length === 0;
    if (isCollectorWrite && !collectorSaveBlocked) {
      collectorSaveBlocked = true;
      collectorSaveStarted.resolve();
      await releaseCollectorSave.promise;
    }
    persisted = structuredClone(nextState);
  }

  const stateTransaction = createJsonStateTransactionBoundary({
    enabled: () => true,
  });
  const runtime = createCollectorAuthRuntime({
    loadState,
    saveState,
    persistenceMode: () => "json",
    stateTransaction,
    readJson,
    sendJson,
  });

  const collectorRequest = request(
    runtime,
    "POST",
    "/extension/collector-auth/ticket",
    { authorization: `Bearer ${WEB_TOKEN}` },
  );
  await collectorSaveStarted.promise;

  const normalMutation = stateTransaction.run(async () => {
    const state = await loadState();
    state.businessChanges.push({ id: "business-change-kept" });
    normalLoaded.resolve();
    await releaseNormalSave.promise;
    await saveState(state);
  });

  await new Promise((resolve) => setImmediate(resolve));
  releaseCollectorSave.resolve();
  await normalLoaded.promise;
  releaseNormalSave.resolve();

  const [issued] = await Promise.all([collectorRequest, normalMutation]);
  assert.equal(issued.status, 200);
  assert.deepEqual(persisted.businessChanges, [{ id: "business-change-kept" }]);
  assert.equal(persisted.collectorAuthTickets.length, 1);
  assert.equal(
    persisted.auditEvents.some((event) => event.action === "COLLECTOR_TICKET_ISSUED"),
    true,
  );
});

test("shared JSON transaction preserves collector writes and background object cleanup", async () => {
  let persisted = {
    ...initialState(),
    pendingObjectDeletions: [{
      objectKey: "background-orphan.png",
      attemptCount: 0,
      nextAttemptAt: "2026-07-29T00:00:00.000Z",
    }],
  };
  const cleanupRemoveStarted = deferred();
  const releaseCleanupRemove = deferred();

  async function loadState() {
    return structuredClone(persisted);
  }

  async function saveState(nextState) {
    persisted = structuredClone(nextState);
  }

  const stateTransaction = createJsonStateTransactionBoundary({
    enabled: () => true,
  });
  const runtime = createCollectorAuthRuntime({
    loadState,
    saveState,
    persistenceMode: () => "json",
    stateTransaction,
    readJson,
    sendJson,
  });
  const cleanupWorker = createObjectCleanupWorker({
    loadState,
    saveState,
    stateTransaction,
    async removeObject() {
      cleanupRemoveStarted.resolve();
      await releaseCleanupRemove.promise;
    },
    logger: { error() {} },
  });

  const cleanupRequest = cleanupWorker.drain();
  await cleanupRemoveStarted.promise;
  const collectorRequest = request(
    runtime,
    "POST",
    "/extension/collector-auth/ticket",
    { authorization: `Bearer ${WEB_TOKEN}` },
  );
  await new Promise((resolve) => setImmediate(resolve));
  releaseCleanupRemove.resolve();

  const [cleanup, issued] = await Promise.all([cleanupRequest, collectorRequest]);
  assert.equal(cleanup.deleted, 1);
  assert.equal(issued.status, 200);
  assert.deepEqual(persisted.pendingObjectDeletions, []);
  assert.equal(persisted.collectorAuthTickets.length, 1);
  assert.equal(
    persisted.auditEvents.some((event) => event.action === "COLLECTOR_TICKET_ISSUED"),
    true,
  );
});

test("PostgreSQL ticket issue and exchange use focused audits without legacy state hydration", async () => {
  const harness = postgresRuntimeHarness();
  const issued = await request(
    harness.runtime,
    "POST",
    "/extension/collector-auth/ticket",
    { authorization: `Bearer ${WEB_TOKEN}` },
  );
  const exchanged = await request(
    harness.runtime,
    "POST",
    "/extension/collector-auth/exchange",
    {
      body: {
        ticket: issued.body.ticket,
        deviceFingerprint: "postgres-device",
        extensionVersion: "3.0.0-postgres",
      },
    },
  );

  assert.equal(issued.status, 200);
  assert.equal(exchanged.status, 200);
  assert.deepEqual(exchanged.body.account, {
    id: ACCOUNT.id,
    displayName: ACCOUNT.displayName,
  });
  assert.deepEqual(harness.legacyAttempts(), { reads: 0, writes: 0 });
  assert.deepEqual(
    harness.audits.map(({ action, status, accountId }) => ({ action, status, accountId })),
    [{
      action: "COLLECTOR_TICKET_ISSUED",
      status: "SUCCESS",
      accountId: ACCOUNT.id,
    }, {
      action: "COLLECTOR_TICKET_EXCHANGED",
      status: "SUCCESS",
      accountId: ACCOUNT.id,
    }],
  );
  assert.deepEqual(
    harness.audits.map(({ entityType }) => entityType),
    ["collector_auth_ticket", "collector_auth_ticket"],
  );
  assert.match(harness.audits[0].entityId, /^ctkt_/);
  assert.match(harness.audits[1].entityId, /^csess_/);
  const serializedMetadata = JSON.stringify(harness.audits.map((event) => event.metadata));
  assert.equal(harness.audits[1].metadata.superseded, 2);
  for (const secret of [issued.body.ticket, exchanged.body.collectorToken, WEB_TOKEN]) {
    assert.equal(serializedMetadata.includes(secret), false);
  }
});

test("JSON Collector exchange audit persists a numeric superseded count without credentials", async () => {
  const state = initialState();
  const runtime = jsonRuntime(state);
  const issued = await request(runtime, "POST", "/extension/collector-auth/ticket", {
    authorization: `Bearer ${WEB_TOKEN}`,
  });
  const exchanged = await request(runtime, "POST", "/extension/collector-auth/exchange", {
    body: {
      ticket: issued.body.ticket,
      deviceFingerprint: "json-audit-device",
      extensionVersion: "3.0.0-json-audit",
    },
  });
  const audit = state.auditEvents.find((event) => event.action === "COLLECTOR_TICKET_EXCHANGED");
  assert.equal(typeof audit.metadata.superseded, "number");
  assert.equal(audit.metadata.superseded, 0);
  const serialized = JSON.stringify(audit.metadata);
  assert.equal(serialized.includes(issued.body.ticket), false);
  assert.equal(serialized.includes(exchanged.body.collectorToken), false);
  assert.equal(serialized.includes("json-audit-device"), false);
});

test("PostgreSQL repository initialization retries after failure and retains successful single-flight", async () => {
  const state = initialState();
  let loadCalls = 0;
  let initializationAttempts = 0;

  const repository = {
    async createTicket(record) {
      return {
        ...record,
        account: structuredClone(ACCOUNT),
        parentSession: {
          accountId: ACCOUNT.id,
          expiresAt: state.sessions[WEB_TOKEN].expiresAt,
          revokedAt: null,
        },
      };
    },
    async consumeTicketAtomically() {
      return { outcome: "not_found" };
    },
    async createSession() {
      return null;
    },
    async findActiveSession() {
      return null;
    },
    async touchSession() {
      return false;
    },
    async revokeSessions() {
      return { revoked: 0 };
    },
  };

  async function loadState() {
    loadCalls += 1;
    if (initializationAttempts === 0 && loadCalls === 2) {
      throw new Error("transient PostgreSQL initialization failure");
    }
    return structuredClone(state);
  }

  async function initializePostgresRepository() {
    initializationAttempts += 1;
    if (initializationAttempts === 1) {
      throw new Error("transient PostgreSQL initialization failure");
    }
    return repository;
  }

  const runtime = createCollectorAuthRuntime({
    loadState,
    saveState: async () => {},
    persistenceMode: () => "postgres",
    stateTransaction: createJsonStateTransactionBoundary({
      enabled: () => false,
    }),
    initializePostgresRepository,
    insertAuditEvent: async () => {},
    readJson,
    sendJson,
  });

  const first = await request(
    runtime,
    "POST",
    "/extension/collector-auth/ticket",
    { authorization: `Bearer ${WEB_TOKEN}` },
  );
  assert.equal(first.status, 500);

  const second = request(
    runtime,
    "POST",
    "/extension/collector-auth/ticket",
    { authorization: `Bearer ${WEB_TOKEN}` },
  );
  const concurrent = request(
    runtime,
    "POST",
    "/extension/collector-auth/ticket",
    { authorization: `Bearer ${WEB_TOKEN}` },
  );

  const [secondResult, concurrentResult] = await Promise.all([second, concurrent]);
  assert.equal(secondResult.status, 200);
  assert.equal(concurrentResult.status, 200);
  assert.equal(initializationAttempts, 2);

  const retained = await request(
    runtime,
    "POST",
    "/extension/collector-auth/ticket",
    { authorization: `Bearer ${WEB_TOKEN}` },
  );
  assert.equal(retained.status, 200);
  assert.equal(initializationAttempts, 2);
});

test("default PostgreSQL first ticket loads legacy Web auth state once before focused repository work", async () => {
  const state = initialState();
  const phases = [];
  let loadCalls = 0;
  const pool = {
    async query(sql, values) {
      phases.push(/INSERT\s+INTO\s+collector_auth_tickets/i.test(sql) ? "ticket-insert" : "other-sql");
      if (/INSERT\s+INTO\s+collector_auth_tickets/i.test(sql)) {
        return {
          rows: [{
            id: values[0], ticket_hash: values[1], account_id: values[2],
            parent_session_token: values[3], permissions: JSON.parse(values[4]),
            expires_at: values[5], consumed_at: values[6], created_at: values[7],
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const runtime = createCollectorAuthRuntime({
    async loadState() {
      loadCalls += 1;
      phases.push("web-auth-state");
      return structuredClone(state);
    },
    async saveState() {},
    persistenceMode: () => "postgres",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    postgresPool: pool,
    async insertAuditEvent() { phases.push("focused-audit"); },
    readJson,
    sendJson,
  });

  const issued = await request(runtime, "POST", "/extension/collector-auth/ticket", {
    authorization: `Bearer ${WEB_TOKEN}`,
  });
  assert.equal(issued.status, 200);
  assert.equal(loadCalls, 1);
  assert.deepEqual(phases, ["web-auth-state", "ticket-insert", "focused-audit"]);
});
