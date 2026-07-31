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

function jsonRuntime(state) {
  return createCollectorAuthRuntime({
    loadState: async () => structuredClone(state),
    saveState: async (nextState) => Object.assign(state, structuredClone(nextState)),
    persistenceMode: () => "json",
    stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    readJson,
    sendJson,
  });
}

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
