import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLLECTOR_PERMISSIONS,
  createCollectorAuthService,
  hashCollectorSecret,
} from "../collector-auth-service.mjs";
import {
  createJsonCollectorAuthRepository,
  createPostgresCollectorAuthRepository,
} from "../collector-auth-repository.mjs";
import { mirrorCollectorAuthState } from "../formal-persistence.mjs";

const START = new Date("2026-07-29T00:00:00.000Z");
const ACTIVE_ACCOUNT = Object.freeze({
  id: "account_1",
  status: "active",
  expiresAt: "2026-08-29T00:00:00.000Z",
});
const PARENT_TOKEN = "web-parent-session-secret";

function createFakeRepository({
  account = ACTIVE_ACCOUNT,
  parentExpiresAt = "2026-07-30T00:00:00.000Z",
} = {}) {
  const tickets = new Map();
  const sessions = new Map();
  const parentSessions = new Map([[
    PARENT_TOKEN,
    {
      accountId: account.id,
      expiresAt: parentExpiresAt,
      revokedAt: null,
    },
  ]]);
  const touches = [];

  const contextFor = (record) => ({
    ...record,
    account,
    parentSession: parentSessions.get(record.parentSessionToken) || null,
  });

  return {
    tickets,
    sessions,
    parentSessions,
    touches,
    async createTicket(record) {
      tickets.set(record.ticketHash, structuredClone(record));
      return contextFor(record);
    },
    async consumeTicketAtomically({ ticketHash, now }) {
      const record = tickets.get(ticketHash);
      if (!record) return { outcome: "not_found" };
      if (record.consumedAt) return { outcome: "used", ticket: contextFor(record) };
      if (new Date(record.expiresAt).getTime() <= now.getTime()) {
        return { outcome: "expired", ticket: contextFor(record) };
      }
      record.consumedAt = now.toISOString();
      return { outcome: "consumed", ticket: contextFor(record) };
    },
    async createSession(record) {
      sessions.set(record.tokenHash, structuredClone(record));
      return contextFor(record);
    },
    async findActiveSession({ tokenHash }) {
      const record = sessions.get(tokenHash);
      return record ? contextFor(record) : null;
    },
    async touchSession({ sessionId, now }) {
      touches.push({ sessionId, now: now.toISOString() });
      const record = [...sessions.values()].find((item) => item.id === sessionId);
      if (record) record.lastSeenAt = now.toISOString();
    },
    async revokeSessions({ parentSessionToken, accountId, reason, now }) {
      let revoked = 0;
      for (const record of sessions.values()) {
        if (
          record.parentSessionToken === parentSessionToken
          && record.accountId === accountId
          && !record.revokedAt
        ) {
          record.revokedAt = now.toISOString();
          record.revokedReason = reason;
          revoked += 1;
        }
      }
      return revoked;
    },
  };
}

function createHarness(options = {}) {
  let current = new Date(options.now || START);
  let randomCall = 0;
  const audits = [];
  const repository = options.repository || createFakeRepository(options);
  const service = createCollectorAuthService({
    repository,
    now: () => new Date(current),
    randomBytes: (size) => Buffer.alloc(size, ++randomCall),
    audit: async (event) => audits.push(structuredClone(event)),
  });
  return {
    service,
    repository,
    audits,
    setNow(value) {
      current = new Date(value);
    },
  };
}

async function issueAndExchange(harness, exchange = {}) {
  const issued = await harness.service.issueTicket({
    account: ACTIVE_ACCOUNT,
    parentSessionToken: PARENT_TOKEN,
  });
  const exchanged = await harness.service.exchangeTicket({
    ticket: issued.ticket,
    deviceFingerprint: exchange.deviceFingerprint || "device-fingerprint",
    extensionVersion: exchange.extensionVersion || "3.0.0",
  });
  return { issued, exchanged };
}

test("ticket plaintext is returned once while only its SHA-256 hash is persisted for 60 seconds", async () => {
  const harness = createHarness();

  const issued = await harness.service.issueTicket({
    account: ACTIVE_ACCOUNT,
    parentSessionToken: PARENT_TOKEN,
  });

  assert.match(issued.ticket, /^ctt_[A-Za-z0-9_-]+$/);
  assert.equal(issued.expiresAt, "2026-07-29T00:01:00.000Z");
  assert.equal(harness.repository.tickets.size, 1);
  const [persisted] = harness.repository.tickets.values();
  assert.equal(persisted.ticketHash, hashCollectorSecret(issued.ticket));
  assert.equal("ticket" in persisted, false);
  assert.equal(JSON.stringify(persisted).includes(issued.ticket), false);
});

test("a ticket can be consumed once and a repeated exchange reports COLLECTOR_TICKET_USED", async () => {
  const harness = createHarness();
  const { issued } = await issueAndExchange(harness);

  await assert.rejects(
    harness.service.exchangeTicket({
      ticket: issued.ticket,
      deviceFingerprint: "device-fingerprint",
      extensionVersion: "3.0.0",
    }),
    (error) => error?.status === 409 && error?.code === "COLLECTOR_TICKET_USED",
  );
});

test("an unconsumed ticket older than 60 seconds reports COLLECTOR_TICKET_EXPIRED", async () => {
  const harness = createHarness();
  const issued = await harness.service.issueTicket({
    account: ACTIVE_ACCOUNT,
    parentSessionToken: PARENT_TOKEN,
  });
  harness.setNow("2026-07-29T00:01:00.001Z");

  await assert.rejects(
    harness.service.exchangeTicket({
      ticket: issued.ticket,
      deviceFingerprint: "device-fingerprint",
      extensionVersion: "3.0.0",
    }),
    (error) => error?.status === 401 && error?.code === "COLLECTOR_TICKET_EXPIRED",
  );
});

test("collector session expiry is capped by the parent web session expiry", async () => {
  const harness = createHarness({
    parentExpiresAt: "2026-07-29T02:00:00.000Z",
  });

  const { exchanged } = await issueAndExchange(harness);

  assert.equal(exchanged.expiresAt, "2026-07-29T02:00:00.000Z");
  const [persisted] = harness.repository.sessions.values();
  assert.equal(persisted.expiresAt, "2026-07-29T02:00:00.000Z");
  assert.equal("collectorToken" in persisted, false);
  assert.equal("token" in persisted, false);
  assert.equal(persisted.tokenHash, hashCollectorSecret(exchanged.collectorToken));
});

test("collector session expires after eight hours when the parent session lasts longer", async () => {
  const harness = createHarness({
    parentExpiresAt: "2026-07-30T00:00:00.000Z",
  });

  const { exchanged } = await issueAndExchange(harness);

  assert.equal(exchanged.expiresAt, "2026-07-29T08:00:00.000Z");
});

test("exchange strips collector secrets embedded in persisted device metadata", async () => {
  const harness = createHarness();
  const issued = await harness.service.issueTicket({
    account: ACTIVE_ACCOUNT,
    parentSessionToken: PARENT_TOKEN,
  });

  await harness.service.exchangeTicket({
    ticket: issued.ticket,
    deviceFingerprint: `device ${issued.ticket}`,
    extensionVersion: `version ${issued.ticket}`,
  });

  const [persisted] = harness.repository.sessions.values();
  assert.equal(JSON.stringify(persisted).includes(issued.ticket), false);
});

test("issued collector sessions receive exactly the three collector permissions", async () => {
  const harness = createHarness();
  const { issued, exchanged } = await issueAndExchange(harness);

  assert.deepEqual(issued.permissions, [
    "collector.upload",
    "collector.job.read",
    "collector.config.read",
  ]);
  assert.deepEqual(exchanged.permissions, [
    "collector.upload",
    "collector.job.read",
    "collector.config.read",
  ]);
  assert.deepEqual([...COLLECTOR_PERMISSIONS], issued.permissions);
});

test("authentication rejects a permission outside the collector session scope with 403", async () => {
  const harness = createHarness();
  const { exchanged } = await issueAndExchange(harness);

  await assert.rejects(
    harness.service.authenticate({
      collectorToken: exchanged.collectorToken,
      requiredPermission: "collector.admin",
    }),
    (error) => error?.status === 403 && error?.code === "COLLECTOR_PERMISSION_DENIED",
  );
});

test("inactive accounts are rejected before ticket issuance and during collector authentication", async () => {
  const disabledAccount = { ...ACTIVE_ACCOUNT, status: "disabled" };
  const disabledHarness = createHarness({
    repository: createFakeRepository({ account: disabledAccount }),
  });
  await assert.rejects(
    disabledHarness.service.issueTicket({
      account: disabledAccount,
      parentSessionToken: PARENT_TOKEN,
    }),
    (error) => error?.status === 403 && error?.code === "COLLECTOR_ACCOUNT_INACTIVE",
  );

  const harness = createHarness();
  const { exchanged } = await issueAndExchange(harness);
  const [session] = harness.repository.sessions.values();
  session.account = undefined;
  const originalFind = harness.repository.findActiveSession;
  harness.repository.findActiveSession = async (input) => ({
    ...await originalFind(input),
    account: disabledAccount,
  });
  await assert.rejects(
    harness.service.authenticate({
      collectorToken: exchanged.collectorToken,
      requiredPermission: "collector.upload",
    }),
    (error) => error?.status === 403 && error?.code === "COLLECTOR_ACCOUNT_INACTIVE",
  );
});

test("authentication rejects a revoked parent web session", async () => {
  const harness = createHarness();
  const { exchanged } = await issueAndExchange(harness);
  harness.repository.parentSessions.get(PARENT_TOKEN).revokedAt = "2026-07-29T00:00:01.000Z";

  await assert.rejects(
    harness.service.authenticate({
      collectorToken: exchanged.collectorToken,
      requiredPermission: "collector.upload",
    }),
    (error) => error?.status === 401 && error?.code === "COLLECTOR_PARENT_SESSION_REVOKED",
  );
});

test("exchange audits a revoked parent rejection after the ticket is consumed", async () => {
  const harness = createHarness();
  const issued = await harness.service.issueTicket({
    account: ACTIVE_ACCOUNT,
    parentSessionToken: PARENT_TOKEN,
  });
  harness.repository.parentSessions.get(PARENT_TOKEN).revokedAt = "2026-07-29T00:00:01.000Z";

  await assert.rejects(
    harness.service.exchangeTicket({
      ticket: issued.ticket,
      deviceFingerprint: "device-fingerprint",
      extensionVersion: "3.0.0",
    }),
    (error) => error?.code === "COLLECTOR_PARENT_SESSION_REVOKED",
  );

  assert.ok(harness.audits.some((event) => (
    event.ticketId
    && event.accountId === ACTIVE_ACCOUNT.id
    && event.outcome === "collector_parent_session_revoked"
  )));
});

test("authentication rejects a revoked collector session", async () => {
  const harness = createHarness();
  const { exchanged } = await issueAndExchange(harness);
  const [session] = harness.repository.sessions.values();
  session.revokedAt = "2026-07-29T00:00:01.000Z";

  await assert.rejects(
    harness.service.authenticate({
      collectorToken: exchanged.collectorToken,
      requiredPermission: "collector.upload",
    }),
    (error) => error?.status === 401 && error?.code === "COLLECTOR_SESSION_REVOKED",
  );
});

test("authentication rejects an expired collector session", async () => {
  const harness = createHarness();
  const { exchanged } = await issueAndExchange(harness);
  harness.setNow("2026-07-29T08:00:00.001Z");

  await assert.rejects(
    harness.service.authenticate({
      collectorToken: exchanged.collectorToken,
      requiredPermission: "collector.upload",
    }),
    (error) => error?.status === 401 && error?.code === "COLLECTOR_SESSION_EXPIRED",
  );
});

test("successful authentication touches last use and returns no token or hash", async () => {
  const harness = createHarness();
  const { exchanged } = await issueAndExchange(harness, {
    deviceFingerprint: "device-123",
    extensionVersion: "3.4.5",
  });
  harness.setNow("2026-07-29T00:02:00.000Z");

  const authenticated = await harness.service.authenticate({
    collectorToken: exchanged.collectorToken,
    requiredPermission: "collector.job.read",
  });

  assert.equal(authenticated.accountId, ACTIVE_ACCOUNT.id);
  assert.equal(authenticated.deviceFingerprint, "device-123");
  assert.equal(authenticated.extensionVersion, "3.4.5");
  assert.equal(harness.repository.touches.length, 1);
  assert.deepEqual(harness.repository.touches[0], {
    sessionId: authenticated.collectorSessionId,
    now: "2026-07-29T00:02:00.000Z",
  });
  assert.equal(/token|hash/i.test(Object.keys(authenticated).join(",")), false);
  assert.equal(JSON.stringify(authenticated).includes(exchanged.collectorToken), false);
});

test("revocation is account and parent-session scoped", async () => {
  const harness = createHarness();
  await issueAndExchange(harness);

  const result = await harness.service.revoke({
    parentSessionToken: PARENT_TOKEN,
    accountId: ACTIVE_ACCOUNT.id,
    reason: "web logout",
  });

  assert.deepEqual(result, { revoked: 1 });
  const [session] = harness.repository.sessions.values();
  assert.equal(session.revokedReason, "web logout");
});

test("audits record identifiers and outcomes without ticket or collector-token plaintext", async () => {
  const harness = createHarness();
  const { issued, exchanged } = await issueAndExchange(harness);
  await harness.service.authenticate({
    collectorToken: exchanged.collectorToken,
    requiredPermission: "collector.config.read",
  });
  await assert.rejects(
    harness.service.exchangeTicket({
      ticket: issued.ticket,
      deviceFingerprint: "device-fingerprint",
      extensionVersion: "3.0.0",
    }),
  );
  await harness.service.revoke({
    parentSessionToken: PARENT_TOKEN,
    accountId: ACTIVE_ACCOUNT.id,
    reason: `logout after ${exchanged.collectorToken}`,
  });
  const [persistedSession] = harness.repository.sessions.values();
  assert.equal(persistedSession.revokedReason.includes(exchanged.collectorToken), false);

  assert.ok(harness.audits.some((event) => event.ticketId && event.outcome === "issued"));
  assert.ok(harness.audits.some((event) => event.collectorSessionId && event.outcome === "authenticated"));
  assert.ok(harness.audits.some((event) => event.outcome === "ticket_used"));
  const serialized = JSON.stringify(harness.audits);
  assert.equal(serialized.includes(issued.ticket), false);
  assert.equal(serialized.includes(exchanged.collectorToken), false);
  assert.equal(serialized.includes(PARENT_TOKEN), false);
});

test("JSON repository serializes same-process ticket consumption and stores hashes only", async () => {
  const ticket = "ctt_json-plaintext-ticket";
  const collectorToken = "cst_json-plaintext-token";
  const ticketHash = hashCollectorSecret(ticket);
  const tokenHash = hashCollectorSecret(collectorToken);
  const state = {
    accounts: [structuredClone(ACTIVE_ACCOUNT)],
    sessions: {
      [PARENT_TOKEN]: {
        accountId: ACTIVE_ACCOUNT.id,
        expiresAt: "2026-07-30T00:00:00.000Z",
        revokedAt: null,
      },
    },
  };
  let persistenceCalls = 0;
  const repository = createJsonCollectorAuthRepository({
    state,
    persist: async () => {
      persistenceCalls += 1;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  await repository.createTicket({
    id: "ticket_json",
    ticket,
    ticketHash,
    accountId: ACTIVE_ACCOUNT.id,
    parentSessionToken: PARENT_TOKEN,
    permissions: [...COLLECTOR_PERMISSIONS],
    expiresAt: "2026-07-29T00:01:00.000Z",
    createdAt: START.toISOString(),
  });

  const results = await Promise.all([
    repository.consumeTicketAtomically({ ticketHash, now: START }),
    repository.consumeTicketAtomically({ ticketHash, now: START }),
  ]);
  await repository.createSession({
    id: "session_json",
    collectorToken,
    token: collectorToken,
    tokenHash,
    accountId: ACTIVE_ACCOUNT.id,
    parentSessionToken: PARENT_TOKEN,
    deviceFingerprint: `device ${ticket}`,
    extensionVersion: `version ${collectorToken}`,
    permissions: [...COLLECTOR_PERMISSIONS],
    expiresAt: "2026-07-29T08:00:00.000Z",
    lastSeenAt: START.toISOString(),
    createdAt: START.toISOString(),
  });
  await repository.revokeSessions({
    parentSessionToken: PARENT_TOKEN,
    accountId: ACTIVE_ACCOUNT.id,
    reason: `logout ${collectorToken}`,
    now: START,
  });

  assert.deepEqual(results.map((result) => result.outcome).sort(), ["consumed", "used"]);
  assert.equal(state.collectorAuthTickets.length, 1);
  assert.equal(state.collectorSessions.length, 1);
  const serialized = JSON.stringify({
    collectorAuthTickets: state.collectorAuthTickets,
    collectorSessions: state.collectorSessions,
  });
  assert.equal(serialized.includes(ticket), false);
  assert.equal(serialized.includes(collectorToken), false);
  assert.equal(serialized.includes(ticketHash), true);
  assert.equal(serialized.includes(tokenHash), true);
  assert.ok(persistenceCalls >= 3);
});

test("JSON repository rolls back an in-memory ticket consumption when persistence fails", async () => {
  const ticketHash = hashCollectorSecret("ctt_json-persistence-failure");
  const state = {
    accounts: [structuredClone(ACTIVE_ACCOUNT)],
    sessions: {
      [PARENT_TOKEN]: {
        accountId: ACTIVE_ACCOUNT.id,
        expiresAt: "2026-07-30T00:00:00.000Z",
      },
    },
  };
  let failPersistence = false;
  const repository = createJsonCollectorAuthRepository({
    state,
    persist: async () => {
      if (failPersistence) throw new Error("state write failed");
    },
  });
  await repository.createTicket({
    id: "ticket_json_rollback",
    ticketHash,
    accountId: ACTIVE_ACCOUNT.id,
    parentSessionToken: PARENT_TOKEN,
    permissions: [...COLLECTOR_PERMISSIONS],
    expiresAt: "2026-07-29T00:01:00.000Z",
    createdAt: START.toISOString(),
  });
  failPersistence = true;

  await assert.rejects(
    repository.consumeTicketAtomically({ ticketHash, now: START }),
    (error) => error?.code === "COLLECTOR_AUTH_PERSISTENCE_FAILED",
  );
  assert.equal(state.collectorAuthTickets[0].consumedAt, null);

  failPersistence = false;
  const retry = await repository.consumeTicketAtomically({ ticketHash, now: START });
  assert.equal(retry.outcome, "consumed");
});

test("PostgreSQL repository lets the conditional UPDATE decide ticket consumption before classifying failures", async () => {
  const ticketHash = hashCollectorSecret("ctt_postgres-ticket");
  const row = {
    id: "ticket_pg",
    ticket_hash: ticketHash,
    account_id: ACTIVE_ACCOUNT.id,
    parent_session_token: PARENT_TOKEN,
    permissions: [...COLLECTOR_PERMISSIONS],
    expires_at: "2026-07-29T00:01:00.000Z",
    consumed_at: null,
    created_at: START.toISOString(),
    account_status: "active",
    account_expires_at: ACTIVE_ACCOUNT.expiresAt,
    parent_session_expires_at: "2026-07-30T00:00:00.000Z",
    parent_session_revoked_at: null,
  };
  const operations = [];
  const pool = {
    async query(sql, values) {
      operations.push({ sql, values });
      if (/UPDATE\s+collector_auth_tickets/i.test(sql)) {
        if (row.consumed_at || new Date(row.expires_at) <= values[1]) return { rows: [] };
        row.consumed_at = values[1].toISOString();
        return { rows: [{ ...row }] };
      }
      if (/SELECT[\s\S]+FROM\s+collector_auth_tickets/i.test(sql)) {
        return { rows: [{ ...row }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const repository = createPostgresCollectorAuthRepository({ pool });

  const first = await repository.consumeTicketAtomically({ ticketHash, now: START });
  const second = await repository.consumeTicketAtomically({ ticketHash, now: START });

  assert.equal(first.outcome, "consumed");
  assert.equal(second.outcome, "used");
  assert.match(operations[0].sql, /UPDATE\s+collector_auth_tickets/i);
  assert.match(operations[0].sql, /consumed_at\s+IS\s+NULL/i);
  assert.match(operations[0].sql, /expires_at\s*>\s*\$2/i);
  assert.equal(operations[0].values[0], ticketHash);
});

test("formal state mirroring ignores plaintext collector secret fields", async () => {
  const ticket = "ctt_mirror-plaintext-ticket";
  const collectorToken = "cst_mirror-plaintext-token";
  const ticketHash = hashCollectorSecret(ticket);
  const tokenHash = hashCollectorSecret(collectorToken);
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  };

  await mirrorCollectorAuthState(client, {
    collectorAuthTickets: [{
      id: "ticket_mirror",
      ticket,
      ticketHash,
      accountId: ACTIVE_ACCOUNT.id,
      parentSessionToken: PARENT_TOKEN,
      permissions: [...COLLECTOR_PERMISSIONS],
      expiresAt: "2026-07-29T00:01:00.000Z",
      createdAt: START.toISOString(),
    }],
    collectorSessions: [{
      id: "session_mirror",
      collectorToken,
      token: collectorToken,
      tokenHash,
      accountId: ACTIVE_ACCOUNT.id,
      parentSessionToken: PARENT_TOKEN,
      permissions: [...COLLECTOR_PERMISSIONS],
      expiresAt: "2026-07-29T08:00:00.000Z",
      revokedAt: START.toISOString(),
      revokedReason: `logout ${collectorToken}`,
      createdAt: START.toISOString(),
      lastSeenAt: START.toISOString(),
    }],
  });

  const serializedParameters = JSON.stringify(calls.map((call) => call.values));
  assert.equal(calls.length, 2);
  assert.equal(serializedParameters.includes(ticket), false);
  assert.equal(serializedParameters.includes(collectorToken), false);
  assert.equal(serializedParameters.includes(ticketHash), true);
  assert.equal(serializedParameters.includes(tokenHash), true);
});

test("repositories reject non-SHA secret values without persisting them", async () => {
  const state = {
    accounts: [structuredClone(ACTIVE_ACCOUNT)],
    sessions: {
      [PARENT_TOKEN]: {
        accountId: ACTIVE_ACCOUNT.id,
        expiresAt: "2026-07-30T00:00:00.000Z",
      },
    },
  };
  const repository = createJsonCollectorAuthRepository({ state });

  await assert.rejects(
    repository.createTicket({
      id: "ticket_unhashed",
      ticketHash: "ctt_plaintext-not-a-hash",
      accountId: ACTIVE_ACCOUNT.id,
      parentSessionToken: PARENT_TOKEN,
      permissions: [...COLLECTOR_PERMISSIONS],
      expiresAt: "2026-07-29T00:01:00.000Z",
      createdAt: START.toISOString(),
    }),
    (error) => (
      error?.status === 500
      && error?.code === "COLLECTOR_SECRET_HASH_REQUIRED"
      && !error.message.includes("ctt_plaintext-not-a-hash")
    ),
  );
  assert.deepEqual(state.collectorAuthTickets || [], []);
});

test("PostgreSQL repository errors never expose a parent-session secret", async () => {
  const pool = {
    async query() {
      throw new Error(`constraint failed for ${PARENT_TOKEN}`);
    },
  };
  const repository = createPostgresCollectorAuthRepository({ pool });

  await assert.rejects(
    repository.revokeSessions({
      parentSessionToken: PARENT_TOKEN,
      accountId: ACTIVE_ACCOUNT.id,
      reason: "logout",
      now: START,
    }),
    (error) => (
      error?.status === 500
      && error?.code === "COLLECTOR_AUTH_PERSISTENCE_FAILED"
      && !error.message.includes(PARENT_TOKEN)
    ),
  );
});

test("PostgreSQL repository redacts collector secrets from session metadata and revoke reasons", async () => {
  const ticket = "ctt_postgres-metadata-secret";
  const collectorToken = "cst_postgres-metadata-secret";
  const tokenHash = hashCollectorSecret(collectorToken);
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{}], rowCount: 1 };
    },
  };
  const repository = createPostgresCollectorAuthRepository({ pool });

  await repository.createSession({
    id: "session_pg_metadata",
    tokenHash,
    accountId: ACTIVE_ACCOUNT.id,
    parentSessionToken: PARENT_TOKEN,
    deviceFingerprint: `device ${ticket}`,
    extensionVersion: `version ${collectorToken}`,
    permissions: [...COLLECTOR_PERMISSIONS],
    expiresAt: "2026-07-29T08:00:00.000Z",
    revokedAt: null,
    revokedReason: `created after ${ticket}`,
    lastSeenAt: START.toISOString(),
    createdAt: START.toISOString(),
  });
  await repository.revokeSessions({
    parentSessionToken: PARENT_TOKEN,
    accountId: ACTIVE_ACCOUNT.id,
    reason: `logout ${collectorToken}`,
    now: START,
  });

  const serializedParameters = JSON.stringify(calls.map((call) => call.values));
  assert.equal(serializedParameters.includes(ticket), false);
  assert.equal(serializedParameters.includes(collectorToken), false);
  assert.equal(serializedParameters.includes("[REDACTED]"), true);
});

test("formal mirroring replaces database errors that contain collector-related secrets", async () => {
  const ticketHash = hashCollectorSecret("ctt_mirror-error");
  const client = {
    async query() {
      throw new Error(`foreign key failed for ${PARENT_TOKEN}`);
    },
  };

  await assert.rejects(
    mirrorCollectorAuthState(client, {
      collectorAuthTickets: [{
        id: "ticket_mirror_error",
        ticketHash,
        accountId: ACTIVE_ACCOUNT.id,
        parentSessionToken: PARENT_TOKEN,
        permissions: [...COLLECTOR_PERMISSIONS],
        expiresAt: "2026-07-29T00:01:00.000Z",
        createdAt: START.toISOString(),
      }],
    }),
    (error) => (
      error?.code === "COLLECTOR_AUTH_MIRROR_FAILED"
      && !error.message.includes(PARENT_TOKEN)
    ),
  );
});
