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
    async revokeSessions({ parentSessionToken = "", accountId, reason, now }) {
      let revoked = 0;
      for (const record of sessions.values()) {
        if (
          (!parentSessionToken || record.parentSessionToken === parentSessionToken)
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
    audit: options.audit || (async (event) => audits.push(structuredClone(event))),
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

test("exchange returns only the public account projection from repository context", async () => {
  const account = {
    id: "account-a",
    displayName: "账号 A",
    username: "private-username",
    role: "admin",
    status: "active",
    expiresAt: "2026-08-29T00:00:00.000Z",
  };
  const harness = createHarness({
    repository: createFakeRepository({ account }),
  });
  const issued = await harness.service.issueTicket({
    account,
    parentSessionToken: PARENT_TOKEN,
  });

  const exchanged = await harness.service.exchangeTicket({
    ticket: issued.ticket,
    deviceFingerprint: "device-fingerprint",
    extensionVersion: "3.0.0",
  });

  assert.deepEqual(exchanged.account, {
    id: "account-a",
    displayName: "账号 A",
  });
});

test("a parent web session without an expiry still caps the collector session at eight hours", async () => {
  const harness = createHarness({ parentExpiresAt: null });

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
    deviceFingerprint: `device ${issued.ticket} ${PARENT_TOKEN}`,
    extensionVersion: `version ${issued.ticket} ${PARENT_TOKEN}`,
  });

  const [persisted] = harness.repository.sessions.values();
  assert.equal(persisted.deviceFingerprint.includes(issued.ticket), false);
  assert.equal(persisted.deviceFingerprint.includes(PARENT_TOKEN), false);
  assert.equal(persisted.extensionVersion.includes(issued.ticket), false);
  assert.equal(persisted.extensionVersion.includes(PARENT_TOKEN), false);
});

test("new collector tickets and sessions receive exactly the four least-privilege permissions", async () => {
  const harness = createHarness();
  const { issued, exchanged } = await issueAndExchange(harness);

  assert.deepEqual(issued.permissions, [
    "collector.upload",
    "collector.job.read",
    "collector.config.read",
    "collector.ozon.read",
  ]);
  assert.deepEqual(exchanged.permissions, [
    "collector.upload",
    "collector.job.read",
    "collector.config.read",
    "collector.ozon.read",
  ]);
  assert.deepEqual([...COLLECTOR_PERMISSIONS], issued.permissions);
});

test("a legacy collector session without Ozon read permission receives COLLECTOR_PERMISSION_DENIED", async () => {
  const harness = createHarness();
  const { exchanged } = await issueAndExchange(harness);

  const currentSession = await harness.service.authenticate({
    collectorToken: exchanged.collectorToken,
    requiredPermission: "collector.ozon.read",
  });
  assert.equal(currentSession.collectorSessionId, exchanged.collectorSessionId);

  const [legacySession] = harness.repository.sessions.values();
  legacySession.permissions = [
    "collector.upload",
    "collector.job.read",
    "collector.config.read",
  ];
  await assert.rejects(
    harness.service.authenticate({
      collectorToken: exchanged.collectorToken,
      requiredPermission: "collector.ozon.read",
    }),
    (error) => error?.status === 403 && error?.code === "COLLECTOR_PERMISSION_DENIED",
  );
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
    (error) => error?.status === 403 && error?.code === "COLLECTOR_ACCOUNT_DISABLED",
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
    (error) => error?.status === 403 && error?.code === "COLLECTOR_ACCOUNT_DISABLED",
  );
});

test("required expired-account revocation survives a best-effort audit failure and recovery", async () => {
  const account = { ...ACTIVE_ACCOUNT };
  const harness = createHarness({
    repository: createFakeRepository({ account }),
    audit: async () => { throw new Error("audit sink unavailable"); },
  });
  const { exchanged } = await issueAndExchange(harness);
  const [session] = harness.repository.sessions.values();

  account.expiresAt = "2026-07-28T23:59:59.000Z";
  await assert.rejects(
    harness.service.authenticate({
      collectorToken: exchanged.collectorToken,
      requiredPermission: "collector.upload",
    }),
    (error) => error?.code === "COLLECTOR_ACCOUNT_EXPIRED",
  );
  assert.ok(session.revokedAt);
  assert.equal(session.revokedReason, "ACCOUNT_EXPIRED");

  account.expiresAt = "2026-08-29T00:00:00.000Z";
  await assert.rejects(
    harness.service.authenticate({
      collectorToken: exchanged.collectorToken,
      requiredPermission: "collector.upload",
    }),
    (error) => error?.code === "COLLECTOR_SESSION_REVOKED",
  );
});

test("expired accounts and expired parent Web sessions retain distinct stable codes", async () => {
  const expiredAccount = { ...ACTIVE_ACCOUNT, expiresAt: "2026-07-28T23:59:59.000Z" };
  const accountHarness = createHarness({
    repository: createFakeRepository({ account: expiredAccount }),
  });
  await assert.rejects(
    accountHarness.service.issueTicket({
      account: expiredAccount,
      parentSessionToken: PARENT_TOKEN,
    }),
    (error) => error?.status === 403 && error?.code === "COLLECTOR_ACCOUNT_EXPIRED",
  );

  const parentHarness = createHarness();
  const issued = await parentHarness.service.issueTicket({
    account: ACTIVE_ACCOUNT,
    parentSessionToken: PARENT_TOKEN,
  });
  parentHarness.repository.parentSessions.get(PARENT_TOKEN).expiresAt = "2026-07-28T23:59:59.000Z";
  await assert.rejects(
    parentHarness.service.exchangeTicket({ ticket: issued.ticket }),
    (error) => error?.status === 401 && error?.code === "COLLECTOR_PARENT_SESSION_EXPIRED",
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

test("authentication rejects missing, invalid, and boundary collector-session expiry values", async (t) => {
  for (const [label, expiresAt] of [
    ["missing", null],
    ["invalid", "not-a-timestamp"],
    ["boundary", START.toISOString()],
  ]) {
    await t.test(label, async () => {
      const harness = createHarness();
      const { exchanged } = await issueAndExchange(harness);
      const [session] = harness.repository.sessions.values();
      session.expiresAt = expiresAt;

      await assert.rejects(
        harness.service.authenticate({
          collectorToken: exchanged.collectorToken,
          requiredPermission: "collector.upload",
        }),
        (error) => error?.status === 401 && error?.code === "COLLECTOR_SESSION_EXPIRED",
      );
      assert.equal(harness.repository.touches.length, 0);
    });
  }
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
  assert.deepEqual(authenticated.account, { id: ACTIVE_ACCOUNT.id, displayName: ACTIVE_ACCOUNT.displayName || ACTIVE_ACCOUNT.username || "" });
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

test("service authentication through JSON repository accepts valid expiry and fail-closes corrupted expiry", async (t) => {
  for (const [label, expiresAt] of [
    ["valid", "2026-07-29T08:00:00.000Z"],
    ["missing", null],
    ["invalid", "not-a-timestamp"],
  ]) {
    await t.test(label, async () => {
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
      const repository = createJsonCollectorAuthRepository({ state });
      const harness = createHarness({ repository });
      const { exchanged } = await issueAndExchange(harness);
      state.collectorSessions[0].expiresAt = expiresAt;
      harness.setNow("2026-07-29T00:02:00.000Z");

      if (label === "valid") {
        const authenticated = await harness.service.authenticate({
          collectorToken: exchanged.collectorToken,
          requiredPermission: "collector.upload",
        });
        assert.equal(authenticated.accountId, ACTIVE_ACCOUNT.id);
        assert.equal(state.collectorSessions[0].lastSeenAt, "2026-07-29T00:02:00.000Z");
        return;
      }

      await assert.rejects(
        harness.service.authenticate({
          collectorToken: exchanged.collectorToken,
          requiredPermission: "collector.upload",
        }),
        (error) => error?.status === 401 && error?.code === "COLLECTOR_SESSION_EXPIRED",
      );
      assert.equal(state.collectorSessions[0].lastSeenAt, START.toISOString());
    });
  }
});

test("revocation is account and parent-session scoped", async () => {
  const harness = createHarness();
  await issueAndExchange(harness);

  const result = await harness.service.revoke({
    parentSessionToken: PARENT_TOKEN,
    accountId: ACTIVE_ACCOUNT.id,
    reason: "WEB_LOGOUT",
  });

  assert.deepEqual(result, { revoked: 1 });
  const [session] = harness.repository.sessions.values();
  assert.equal(session.revokedReason, "WEB_LOGOUT");
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
    reason: `logout after ${exchanged.collectorToken} ${PARENT_TOKEN}`,
  });
  const [persistedSession] = harness.repository.sessions.values();
  assert.equal(persistedSession.revokedReason, "PARENT_SESSION_REVOKED");

  assert.ok(harness.audits.some((event) => event.ticketId && event.outcome === "issued"));
  assert.ok(harness.audits.some((event) => event.collectorSessionId && event.outcome === "authenticated"));
  assert.ok(harness.audits.some((event) => event.outcome === "ticket_used"));
  const serialized = JSON.stringify(harness.audits);
  assert.equal(serialized.includes(issued.ticket), false);
  assert.equal(serialized.includes(exchanged.collectorToken), false);
  assert.equal(serialized.includes(PARENT_TOKEN), false);
});

test("successful exchange audits the repository supersession count without device or secret metadata", async () => {
  const repository = createFakeRepository();
  const createLegacySession = repository.createSession.bind(repository);
  repository.createSession = async (record) => ({
    session: await createLegacySession(record),
    supersededCount: 2,
  });
  const harness = createHarness({ repository });

  const { issued, exchanged } = await issueAndExchange(harness, {
    deviceFingerprint: "private-device-fingerprint",
  });

  const exchangeAudit = harness.audits.find((event) => event.outcome === "exchanged");
  assert.equal(exchangeAudit.superseded, 2);
  assert.equal(exchangeAudit.collectorSessionId, exchanged.collectorSessionId);
  const serialized = JSON.stringify(exchangeAudit);
  assert.equal(serialized.includes("private-device-fingerprint"), false);
  assert.equal(serialized.includes(issued.ticket), false);
  assert.equal(serialized.includes(exchanged.collectorToken), false);
  assert.equal(serialized.includes(PARENT_TOKEN), false);
});

test("a rejected session insert fails the exchange without revoking the existing device session", async () => {
  const repository = createFakeRepository();
  const oldTokenHash = hashCollectorSecret("cst_existing-device-session");
  await repository.createSession({
    id: "session_existing_device",
    tokenHash: oldTokenHash,
    accountId: ACTIVE_ACCOUNT.id,
    parentSessionToken: PARENT_TOKEN,
    deviceFingerprint: "device-fingerprint",
    extensionVersion: "2.9.0",
    permissions: [...COLLECTOR_PERMISSIONS],
    expiresAt: "2026-07-29T08:00:00.000Z",
    revokedAt: null,
    revokedReason: "",
    lastSeenAt: "2026-07-28T23:59:00.000Z",
    createdAt: "2026-07-28T23:59:00.000Z",
  });
  repository.createSession = async () => null;
  const harness = createHarness({ repository });
  const issued = await harness.service.issueTicket({
    account: ACTIVE_ACCOUNT,
    parentSessionToken: PARENT_TOKEN,
  });

  await assert.rejects(
    harness.service.exchangeTicket({
      ticket: issued.ticket,
      deviceFingerprint: "device-fingerprint",
      extensionVersion: "3.0.0",
    }),
    (error) => error?.status === 401 && error?.code === "COLLECTOR_SESSION_CREATE_FAILED",
  );

  const existing = repository.sessions.get(oldTokenHash);
  assert.equal(existing.revokedAt, null);
  assert.equal(existing.revokedReason, "");
  assert.ok(harness.audits.some((event) => (
    event.action === "collector.ticket.exchange"
    && event.outcome === "session_create_failed"
    && event.accountId === ACTIVE_ACCOUNT.id
  )));
  assert.equal(harness.audits.some((event) => event.outcome === "exchanged"), false);
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
    deviceFingerprint: `device ${ticket} ${PARENT_TOKEN}`,
    extensionVersion: `version ${collectorToken} ${PARENT_TOKEN}`,
    permissions: [...COLLECTOR_PERMISSIONS],
    expiresAt: "2026-07-29T08:00:00.000Z",
    lastSeenAt: START.toISOString(),
    createdAt: START.toISOString(),
  });
  await repository.revokeSessions({
    parentSessionToken: PARENT_TOKEN,
    accountId: ACTIVE_ACCOUNT.id,
    reason: `logout ${collectorToken} ${PARENT_TOKEN}`,
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
  assert.equal(state.collectorSessions[0].deviceFingerprint.includes(PARENT_TOKEN), false);
  assert.equal(state.collectorSessions[0].extensionVersion.includes(PARENT_TOKEN), false);
  assert.equal(state.collectorSessions[0].revokedReason, "PARENT_SESSION_REVOKED");
  assert.ok(persistenceCalls >= 3);
});

test("JSON session creation supersedes only active same-account sessions with the exact non-empty device in one commit", async () => {
  const deviceFingerprint = "device-exact";
  const oldSameDevice = {
    id: "session_old_same_device",
    tokenHash: hashCollectorSecret("cst_old-same-device"),
    accountId: ACTIVE_ACCOUNT.id,
    parentSessionToken: PARENT_TOKEN,
    deviceFingerprint,
    permissions: [...COLLECTOR_PERMISSIONS],
    expiresAt: "2026-07-29T08:00:00.000Z",
    revokedAt: null,
    revokedReason: "",
    lastSeenAt: "2026-07-28T23:59:00.000Z",
    createdAt: "2026-07-28T23:59:00.000Z",
  };
  const state = {
    accounts: [structuredClone(ACTIVE_ACCOUNT)],
    sessions: {
      [PARENT_TOKEN]: {
        accountId: ACTIVE_ACCOUNT.id,
        expiresAt: "2026-07-30T00:00:00.000Z",
        revokedAt: null,
      },
    },
    collectorSessions: [
      oldSameDevice,
      { ...oldSameDevice, id: "session_other_device", deviceFingerprint: "device-other" },
      { ...oldSameDevice, id: "session_other_account", accountId: "account_2" },
      {
        ...oldSameDevice,
        id: "session_already_revoked",
        revokedAt: "2026-07-28T23:58:00.000Z",
        revokedReason: "WEB_LOGOUT",
      },
    ].map((record) => structuredClone(record)),
  };
  const persistedSnapshots = [];
  const repository = createJsonCollectorAuthRepository({
    state,
    persist: async (persistedState) => {
      persistedSnapshots.push(structuredClone(persistedState.collectorSessions));
    },
  });

  const result = await repository.createSession({
    id: "session_new_same_device",
    tokenHash: hashCollectorSecret("cst_new-same-device"),
    accountId: ACTIVE_ACCOUNT.id,
    parentSessionToken: PARENT_TOKEN,
    deviceFingerprint,
    extensionVersion: "3.0.0",
    permissions: [...COLLECTOR_PERMISSIONS],
    expiresAt: "2026-07-29T08:00:00.000Z",
    revokedAt: null,
    revokedReason: "",
    lastSeenAt: START.toISOString(),
    createdAt: START.toISOString(),
  });

  assert.equal(result.supersededCount, 1);
  assert.equal(result.session.id, "session_new_same_device");
  assert.equal(persistedSnapshots.length, 1);
  const committed = persistedSnapshots[0];
  assert.equal(committed.length, 5);
  assert.deepEqual(
    committed.map(({ id, revokedAt, revokedReason }) => ({ id, revokedAt, revokedReason })),
    [
      {
        id: "session_old_same_device",
        revokedAt: START.toISOString(),
        revokedReason: "SESSION_SUPERSEDED",
      },
      { id: "session_other_device", revokedAt: null, revokedReason: "" },
      { id: "session_other_account", revokedAt: null, revokedReason: "" },
      {
        id: "session_already_revoked",
        revokedAt: "2026-07-28T23:58:00.000Z",
        revokedReason: "WEB_LOGOUT",
      },
      { id: "session_new_same_device", revokedAt: null, revokedReason: "" },
    ],
  );
});

test("JSON session creation does not supersede sessions when the exact device fingerprint is empty", async () => {
  const state = {
    accounts: [structuredClone(ACTIVE_ACCOUNT)],
    sessions: {
      [PARENT_TOKEN]: {
        accountId: ACTIVE_ACCOUNT.id,
        expiresAt: "2026-07-30T00:00:00.000Z",
        revokedAt: null,
      },
    },
    collectorSessions: [{
      id: "session_old_empty_device",
      tokenHash: hashCollectorSecret("cst_old-empty-device"),
      accountId: ACTIVE_ACCOUNT.id,
      parentSessionToken: PARENT_TOKEN,
      deviceFingerprint: "",
      permissions: [...COLLECTOR_PERMISSIONS],
      expiresAt: "2026-07-29T08:00:00.000Z",
      revokedAt: null,
      revokedReason: "",
      lastSeenAt: "2026-07-28T23:59:00.000Z",
      createdAt: "2026-07-28T23:59:00.000Z",
    }],
  };
  const repository = createJsonCollectorAuthRepository({ state });

  const result = await repository.createSession({
    id: "session_new_empty_device",
    tokenHash: hashCollectorSecret("cst_new-empty-device"),
    accountId: ACTIVE_ACCOUNT.id,
    parentSessionToken: PARENT_TOKEN,
    deviceFingerprint: "",
    permissions: [...COLLECTOR_PERMISSIONS],
    expiresAt: "2026-07-29T08:00:00.000Z",
    lastSeenAt: START.toISOString(),
    createdAt: START.toISOString(),
  });

  assert.equal(result.supersededCount, 0);
  assert.equal(state.collectorSessions[0].revokedAt, null);
  assert.equal(state.collectorSessions[1].revokedAt, null);
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

test("JSON repository classifies missing, invalid, and boundary ticket expiry as expired", async () => {
  const state = {
    accounts: [structuredClone(ACTIVE_ACCOUNT)],
    sessions: {
      [PARENT_TOKEN]: {
        accountId: ACTIVE_ACCOUNT.id,
        expiresAt: "2026-07-30T00:00:00.000Z",
      },
    },
    collectorAuthTickets: [
      {
        id: "ticket_missing_expiry",
        ticketHash: hashCollectorSecret("ctt_missing-expiry"),
        accountId: ACTIVE_ACCOUNT.id,
        parentSessionToken: PARENT_TOKEN,
        permissions: [...COLLECTOR_PERMISSIONS],
        expiresAt: null,
        consumedAt: null,
        createdAt: START.toISOString(),
      },
      {
        id: "ticket_invalid_expiry",
        ticketHash: hashCollectorSecret("ctt_invalid-expiry"),
        accountId: ACTIVE_ACCOUNT.id,
        parentSessionToken: PARENT_TOKEN,
        permissions: [...COLLECTOR_PERMISSIONS],
        expiresAt: "not-a-timestamp",
        consumedAt: null,
        createdAt: START.toISOString(),
      },
      {
        id: "ticket_boundary_expiry",
        ticketHash: hashCollectorSecret("ctt_boundary-expiry"),
        accountId: ACTIVE_ACCOUNT.id,
        parentSessionToken: PARENT_TOKEN,
        permissions: [...COLLECTOR_PERMISSIONS],
        expiresAt: START.toISOString(),
        consumedAt: null,
        createdAt: START.toISOString(),
      },
    ],
  };
  const repository = createJsonCollectorAuthRepository({ state });

  for (const ticket of state.collectorAuthTickets) {
    const result = await repository.consumeTicketAtomically({
      ticketHash: ticket.ticketHash,
      now: START,
    });
    assert.equal(result.outcome, "expired");
    assert.equal(ticket.consumedAt, null);
  }
});

test("JSON repository rejects invalid creates but returns read context for account-first validation", async () => {
  const tokenHash = hashCollectorSecret("cst_invalid-json-expiry");
  const state = {
    accounts: [structuredClone(ACTIVE_ACCOUNT)],
    sessions: {
      [PARENT_TOKEN]: {
        accountId: ACTIVE_ACCOUNT.id,
        expiresAt: "2026-07-30T00:00:00.000Z",
      },
    },
    collectorSessions: [{
      id: "session_invalid_read_expiry",
      tokenHash,
      accountId: ACTIVE_ACCOUNT.id,
      parentSessionToken: PARENT_TOKEN,
      permissions: [...COLLECTOR_PERMISSIONS],
      expiresAt: "not-a-timestamp",
      lastSeenAt: START.toISOString(),
      createdAt: START.toISOString(),
    }],
  };
  const repository = createJsonCollectorAuthRepository({ state });

  await assert.rejects(
    repository.createTicket({
      id: "ticket_missing_create_expiry",
      ticketHash: hashCollectorSecret("ctt_missing-create-expiry"),
      accountId: ACTIVE_ACCOUNT.id,
      parentSessionToken: PARENT_TOKEN,
      permissions: [...COLLECTOR_PERMISSIONS],
      expiresAt: null,
      createdAt: START.toISOString(),
    }),
    (error) => error?.status === 401 && error?.code === "COLLECTOR_TICKET_EXPIRED",
  );
  await assert.rejects(
    repository.createSession({
      id: "session_invalid_create_expiry",
      tokenHash: hashCollectorSecret("cst_invalid-create-expiry"),
      accountId: ACTIVE_ACCOUNT.id,
      parentSessionToken: PARENT_TOKEN,
      permissions: [...COLLECTOR_PERMISSIONS],
      expiresAt: "not-a-timestamp",
      lastSeenAt: START.toISOString(),
      createdAt: START.toISOString(),
    }),
    (error) => error?.status === 401 && error?.code === "COLLECTOR_SESSION_EXPIRED",
  );
  const found = await repository.findActiveSession({ tokenHash, now: START });
  assert.equal(found.id, "session_invalid_read_expiry");
  assert.equal(found.expiresAt, null);
  assert.equal(found.account.id, ACTIVE_ACCOUNT.id);
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
    account_display_name: "账号 A",
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
  assert.deepEqual(first.ticket.account, {
    id: ACTIVE_ACCOUNT.id,
    displayName: "账号 A",
    status: "active",
    expiresAt: ACTIVE_ACCOUNT.expiresAt,
  });
  assert.equal(second.outcome, "used");
  assert.match(operations[0].sql, /UPDATE\s+collector_auth_tickets/i);
  assert.match(operations[0].sql, /consumed_at\s+IS\s+NULL/i);
  assert.match(operations[0].sql, /expires_at\s*>\s*\$2/i);
  assert.equal(operations[0].values[0], ticketHash);
});

test("PostgreSQL session creation uses two NUL-free lock parameters before atomically superseding an exact active account device", async () => {
  const calls = [];
  const row = {
    id: "session_pg_new",
    token_hash: hashCollectorSecret("cst_postgres-new-session"),
    account_id: ACTIVE_ACCOUNT.id,
    parent_session_token: PARENT_TOKEN,
    device_fingerprint: "device-pg-exact",
    extension_version: "3.0.0",
    permissions: [...COLLECTOR_PERMISSIONS],
    expires_at: "2026-07-29T08:00:00.000Z",
    revoked_at: null,
    revoked_reason: "",
    last_seen_at: START.toISOString(),
    created_at: START.toISOString(),
    superseded_count: "1",
  };
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/INSERT\s+INTO\s+collector_sessions/i.test(sql)) return { rows: [{ ...row }], rowCount: 1 };
      if (/UPDATE\s+collector_sessions/i.test(sql)) return { rows: [{ id: "session_pg_old" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: "RELEASE", values: [] }); },
  };
  const pool = { connect: async () => client, query: client.query.bind(client) };
  const repository = createPostgresCollectorAuthRepository({ pool });

  const result = await repository.createSession({
    id: row.id,
    tokenHash: row.token_hash,
    accountId: row.account_id,
    parentSessionToken: row.parent_session_token,
    deviceFingerprint: row.device_fingerprint,
    extensionVersion: row.extension_version,
    permissions: [...row.permissions],
    expiresAt: row.expires_at,
    revokedAt: null,
    revokedReason: "",
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  });

  assert.deepEqual(calls.map(({ sql }) => sql.trim().split(/\s+/)[0]), [
    "BEGIN", "SELECT", "INSERT", "UPDATE", "COMMIT", "RELEASE",
  ]);
  assert.match(calls[1].sql, /pg_advisory_xact_lock\(hashtext\(\$1\),\s*hashtext\(\$2\)\)/i);
  assert.deepEqual(calls[1].values, [ACTIVE_ACCOUNT.id, row.device_fingerprint]);
  assert.equal(calls[1].values.some((value) => value.includes("\u0000")), false);
  assert.match(calls[2].sql, /account\.status='active'/i);
  assert.match(calls[3].sql, /account_id\s*=\s*\$1/i);
  assert.match(calls[3].sql, /device_fingerprint\s*=\s*\$2/i);
  assert.match(calls[3].sql, /id\s*<>\s*\$3/i);
  assert.match(calls[3].sql, /revoked_at\s+IS\s+NULL/i);
  assert.doesNotMatch(calls[3].sql, /\bI?LIKE\b/i);
  assert.equal(calls[3].values[4], "SESSION_SUPERSEDED");
  assert.equal(result.session.id, row.id);
  assert.equal(result.supersededCount, 1);
});

test("PostgreSQL zero-row insert cannot supersede an existing device session", async () => {
  const existing = {
    id: "session_pg_existing",
    revokedAt: null,
    revokedReason: "",
  };
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/UPDATE\s+collector_sessions/i.test(sql)) {
        existing.revokedAt = String(values[11]);
        existing.revokedReason = values[12];
      }
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: "RELEASE", values: [] }); },
  };
  const pool = { connect: async () => client, query: client.query.bind(client) };
  const repository = createPostgresCollectorAuthRepository({ pool });

  const result = await repository.createSession({
    id: "session_pg_rejected",
    tokenHash: hashCollectorSecret("cst_postgres-rejected-session"),
    accountId: ACTIVE_ACCOUNT.id,
    parentSessionToken: PARENT_TOKEN,
    deviceFingerprint: "device-pg-exact",
    extensionVersion: "3.0.0",
    permissions: [...COLLECTOR_PERMISSIONS],
    expiresAt: "2026-07-29T08:00:00.000Z",
    revokedAt: null,
    revokedReason: "",
    lastSeenAt: START.toISOString(),
    createdAt: START.toISOString(),
  });

  assert.deepEqual(calls.map(({ sql }) => sql.trim().split(/\s+/)[0]), [
    "BEGIN", "SELECT", "INSERT", "COMMIT", "RELEASE",
  ]);
  assert.equal(result, null);
  assert.deepEqual(existing, {
    id: "session_pg_existing",
    revokedAt: null,
    revokedReason: "",
  });
});

test("PostgreSQL same-account/device concurrent session transactions serialize on one advisory lock", async () => {
  const rows = [];
  let lockTail = Promise.resolve();
  const makeClient = () => {
    let releaseLock = null;
    return {
      async query(sql, values = []) {
        if (/^BEGIN/i.test(sql.trim())) return { rows: [] };
        if (/pg_advisory_xact_lock/i.test(sql)) {
          if (values.some((value) => String(value).includes("\u0000"))) {
            throw new Error("PostgreSQL text parameters cannot contain NUL");
          }
          assert.match(sql, /pg_advisory_xact_lock\(hashtext\(\$1\),\s*hashtext\(\$2\)\)/i);
          assert.deepEqual(values, [ACTIVE_ACCOUNT.id, "device-concurrent"]);
          const predecessor = lockTail;
          lockTail = new Promise((resolve) => { releaseLock = resolve; });
          await predecessor;
          return { rows: [] };
        }
        if (/INSERT\s+INTO\s+collector_sessions/i.test(sql)) {
          const row = {
            id: values[0], token_hash: values[1], account_id: values[2],
            parent_session_token: values[3], device_fingerprint: values[4],
            extension_version: values[5], permissions: JSON.parse(values[6]),
            expires_at: values[7], revoked_at: null, revoked_reason: "",
            last_seen_at: values[10], created_at: values[11],
          };
          rows.push(row);
          return { rows: [row], rowCount: 1 };
        }
        if (/UPDATE\s+collector_sessions/i.test(sql)) {
          const revoked = rows.filter((row) => row.account_id === values[0]
            && row.device_fingerprint === values[1] && row.id !== values[2] && !row.revoked_at);
          revoked.forEach((row) => { row.revoked_at = values[3]; row.revoked_reason = values[4]; });
          return { rows: revoked.map(({ id }) => ({ id })), rowCount: revoked.length };
        }
        if (/^(COMMIT|ROLLBACK)/i.test(sql.trim())) {
          releaseLock?.();
          return { rows: [] };
        }
        throw new Error(`unexpected SQL ${sql}`);
      },
      release() {},
    };
  };
  const pool = { connect: async () => makeClient(), query: async () => ({ rows: [] }) };
  const repository = createPostgresCollectorAuthRepository({ pool });
  const input = (id) => ({
    id,
    tokenHash: hashCollectorSecret(`cst_${id}_transaction_fixture`),
    accountId: ACTIVE_ACCOUNT.id,
    parentSessionToken: PARENT_TOKEN,
    deviceFingerprint: "device-concurrent",
    extensionVersion: "3.0.0",
    permissions: [...COLLECTOR_PERMISSIONS],
    expiresAt: "2026-07-29T08:00:00.000Z",
    lastSeenAt: START.toISOString(),
    createdAt: START.toISOString(),
  });
  const [first, second] = await Promise.all([
    repository.createSession(input("session_concurrent_a")),
    repository.createSession(input("session_concurrent_b")),
  ]);
  assert.deepEqual([first.supersededCount, second.supersededCount], [0, 1]);
  assert.equal(rows.filter((row) => !row.revoked_at).length, 1);
  assert.equal(rows.find((row) => row.revoked_at)?.revoked_reason, "SESSION_SUPERSEDED");
});

test("PostgreSQL session transaction rolls back and releases its fixed connection after failure", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql.trim().split(/\s+/)[0]);
      if (/INSERT\s+INTO\s+collector_sessions/i.test(sql)) throw new Error("raw database detail");
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push("RELEASE"); },
  };
  const repository = createPostgresCollectorAuthRepository({
    pool: { connect: async () => client, query: client.query.bind(client) },
  });
  await assert.rejects(repository.createSession({
    id: "session_rollback",
    tokenHash: hashCollectorSecret("cst_transaction_rollback_fixture"),
    accountId: ACTIVE_ACCOUNT.id,
    parentSessionToken: PARENT_TOKEN,
    deviceFingerprint: "device-rollback",
    extensionVersion: "3.0.0",
    permissions: [...COLLECTOR_PERMISSIONS],
    expiresAt: "2026-07-29T08:00:00.000Z",
    lastSeenAt: START.toISOString(),
    createdAt: START.toISOString(),
  }), (error) => error?.code === "COLLECTOR_AUTH_PERSISTENCE_FAILED"
    && !error.message.includes("raw database detail"));
  assert.deepEqual(calls, ["BEGIN", "SELECT", "INSERT", "ROLLBACK", "RELEASE"]);
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
    accounts: [structuredClone(ACTIVE_ACCOUNT)],
    sessions: {
      [PARENT_TOKEN]: {
        accountId: ACTIVE_ACCOUNT.id,
        expiresAt: "2026-07-30T00:00:00.000Z",
      },
    },
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
      deviceFingerprint: `device ${PARENT_TOKEN}`,
      extensionVersion: `version ${PARENT_TOKEN}`,
      revokedAt: START.toISOString(),
      revokedReason: `logout ${collectorToken} ${PARENT_TOKEN}`,
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
  const sessionParameters = calls[1].values;
  assert.equal(sessionParameters[4].includes(PARENT_TOKEN), false);
  assert.equal(sessionParameters[5].includes(PARENT_TOKEN), false);
  assert.equal(sessionParameters[9], "PARENT_SESSION_REVOKED");
});

test("formal mirroring skips Collector auth records without a surviving account and matching parent Web session", async () => {
  const validTicketHash = hashCollectorSecret("ctt_valid-mirror-ticket");
  const orphanTicketHash = hashCollectorSecret("ctt_orphan-mirror-ticket");
  const validTokenHash = hashCollectorSecret("cst_valid-mirror-token");
  const orphanTokenHash = hashCollectorSecret("cst_orphan-mirror-token");
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  };

  await mirrorCollectorAuthState(client, {
    accounts: [
      { id: "account-surviving" },
      { id: "account-parent-mismatch" },
    ],
    sessions: {
      "surviving-web-session": {
        accountId: "account-surviving",
      },
      "mismatched-web-session": {
        accountId: "account-parent-mismatch",
      },
    },
    collectorAuthTickets: [{
      id: "ticket-valid",
      ticketHash: validTicketHash,
      accountId: "account-surviving",
      parentSessionToken: "surviving-web-session",
      expiresAt: "2026-07-30T12:00:00.000Z",
    }, {
      id: "ticket-deleted-account",
      ticketHash: orphanTicketHash,
      accountId: "account-deleted",
      parentSessionToken: "deleted-web-session",
      expiresAt: "2026-07-30T12:00:00.000Z",
    }, {
      id: "ticket-parent-mismatch",
      ticketHash: hashCollectorSecret("ctt_mismatched-parent-ticket"),
      accountId: "account-surviving",
      parentSessionToken: "mismatched-web-session",
      expiresAt: "2026-07-30T12:00:00.000Z",
    }],
    collectorSessions: [{
      id: "collector-session-valid",
      tokenHash: validTokenHash,
      accountId: "account-surviving",
      parentSessionToken: "surviving-web-session",
      expiresAt: "2026-07-30T12:00:00.000Z",
    }, {
      id: "collector-session-deleted-account",
      tokenHash: orphanTokenHash,
      accountId: "account-deleted",
      parentSessionToken: "deleted-web-session",
      deviceFingerprint: "private-deleted-device",
      expiresAt: "2026-07-30T12:00:00.000Z",
    }],
  });

  assert.equal(calls.length, 2);
  const serializedParameters = JSON.stringify(calls.map((call) => call.values));
  assert.equal(serializedParameters.includes(validTicketHash), true);
  assert.equal(serializedParameters.includes(validTokenHash), true);
  assert.equal(serializedParameters.includes(orphanTicketHash), false);
  assert.equal(serializedParameters.includes(orphanTokenHash), false);
  assert.equal(serializedParameters.includes("private-deleted-device"), false);
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

test("PostgreSQL repository revokes every active Collector session for an account without a parent token", async () => {
  const calls = [];
  const repository = createPostgresCollectorAuthRepository({
    pool: {
      async query(sql, values) {
        calls.push({ sql, values });
        return { rows: [], rowCount: 2 };
      },
    },
  });

  const revoked = await repository.revokeSessions({
    accountId: ACTIVE_ACCOUNT.id,
    reason: "ACCOUNT_DISABLED",
    now: START,
  });

  assert.equal(revoked, 2);
  assert.match(calls[0].sql, /WHERE\s+account_id=\$1/i);
  assert.doesNotMatch(calls[0].sql, /parent_session_token/i);
  assert.match(calls[0].sql, /revoked_at\s+IS\s+NULL/i);
  assert.deepEqual(calls[0].values, [ACTIVE_ACCOUNT.id, "ACCOUNT_DISABLED", START]);
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
    deviceFingerprint: `device ${ticket} ${PARENT_TOKEN}`,
    extensionVersion: `version ${collectorToken} ${PARENT_TOKEN}`,
    permissions: [...COLLECTOR_PERMISSIONS],
    expiresAt: "2026-07-29T08:00:00.000Z",
    revokedAt: null,
    revokedReason: `created after ${ticket} ${PARENT_TOKEN}`,
    lastSeenAt: START.toISOString(),
    createdAt: START.toISOString(),
  });
  await repository.revokeSessions({
    parentSessionToken: PARENT_TOKEN,
    accountId: ACTIVE_ACCOUNT.id,
    reason: `logout ${collectorToken} ${PARENT_TOKEN}`,
    now: START,
  });

  const serializedParameters = JSON.stringify(calls.map((call) => call.values));
  assert.equal(serializedParameters.includes(ticket), false);
  assert.equal(serializedParameters.includes(collectorToken), false);
  assert.equal(serializedParameters.includes("[REDACTED]"), true);
  const insertCall = calls.find(({ sql }) => /INSERT\s+INTO\s+collector_sessions/i.test(sql));
  const revokeCall = calls.find(({ sql }) => /WHERE\s+parent_session_token=\$1/i.test(sql));
  assert.equal(insertCall.values[4].includes(PARENT_TOKEN), false);
  assert.equal(insertCall.values[5].includes(PARENT_TOKEN), false);
  assert.equal(insertCall.values[9], "PARENT_SESSION_REVOKED");
  assert.equal(revokeCall.values[2], "PARENT_SESSION_REVOKED");
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
      accounts: [structuredClone(ACTIVE_ACCOUNT)],
      sessions: {
        [PARENT_TOKEN]: {
          accountId: ACTIVE_ACCOUNT.id,
          expiresAt: "2026-07-30T00:00:00.000Z",
        },
      },
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
