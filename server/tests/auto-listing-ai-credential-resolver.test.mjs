import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingCredentialCipher } from "../auto-listing-ai-credential-crypto.mjs";
import { createAutoListingAiCredentialResolver } from "../auto-listing-ai-credential-resolver.mjs";
import * as credentialResolvers from "../auto-listing-ai-credential-resolver.mjs";

const scope = Object.freeze({
  accountId: "account-a",
  connectionId: "connection-a",
  connectionVersion: 1,
});

function encryptedConnection(secret = "sk-local-gateway") {
  const cipher = createAutoListingCredentialCipher({ key: Buffer.alloc(32, 7), keyVersion: "local-v1" });
  return {
    cipher,
    connection: {
      id: scope.connectionId,
      accountId: scope.accountId,
      version: scope.connectionVersion,
      status: "ACTIVE",
      encryptedSecret: {
        ...cipher.encrypt(scope, secret),
        fingerprint: "opaque-fingerprint",
      },
    },
  };
}

test("resolver decrypts only the exact account connection and version scope", async () => {
  const { cipher, connection } = encryptedConnection("  sk-local-gateway  ");
  const calls = [];
  const repository = {
    async loadConnectionForSecretResolution(input) {
      calls.push(structuredClone(input));
      return input.accountId === scope.accountId
        && input.connectionId === scope.connectionId
        && input.connectionVersion === scope.connectionVersion
        ? structuredClone(connection)
        : null;
    },
  };
  const resolver = createAutoListingAiCredentialResolver({ repository, cipher });

  assert.equal(await resolver.resolveSecret(scope), "sk-local-gateway");
  await assert.rejects(() => resolver.resolveSecret({
    accountId: "account-b",
    connectionId: scope.connectionId,
    connectionVersion: scope.connectionVersion,
  }), (error) => error?.code === "AI_GATEWAY_SECRET_MISSING");
  assert.deepEqual(calls, [scope, {
    accountId: "account-b",
    connectionId: scope.connectionId,
    connectionVersion: scope.connectionVersion,
  }]);
});

test("resolver keeps an old job on its exact retired connection after a newer profile is published", async () => {
  const { cipher, connection } = encryptedConnection("old-job-secret");
  const retired = { ...connection, status: "RETIRED" };
  const resolver = createAutoListingAiCredentialResolver({
    repository: { async loadConnectionForSecretResolution() { return structuredClone(retired); } },
    cipher,
  });
  assert.equal(await resolver.resolveSecret(scope), "old-job-secret");
});

test("resolver rejects mismatched repository identity and malformed scope without decrypting", async () => {
  const { cipher, connection } = encryptedConnection();
  let decryptions = 0;
  const resolver = createAutoListingAiCredentialResolver({
    repository: {
      async loadConnectionForSecretResolution() {
        return { ...connection, accountId: "account-b" };
      },
    },
    cipher: {
      decrypt(...args) {
        decryptions += 1;
        return cipher.decrypt(...args);
      },
    },
  });

  await assert.rejects(() => resolver.resolveSecret(scope), {
    code: "AI_GATEWAY_SECRET_MISSING",
  });
  await assert.rejects(() => resolver.resolveSecret({ ...scope, connectionVersion: 0 }), {
    code: "AI_GATEWAY_REQUEST_INVALID",
  });
  assert.equal(decryptions, 0);
});

test("resolver rejects non-canonical scope before repository access", async () => {
  let repositoryReads = 0;
  const resolver = createAutoListingAiCredentialResolver({
    repository: {
      async loadConnectionForSecretResolution() {
        repositoryReads += 1;
        return null;
      },
    },
    cipher: { decrypt() { throw new Error("must not decrypt"); } },
  });

  for (const invalidScope of [
    { ...scope, accountId: ` ${scope.accountId}` },
    { ...scope, connectionId: `${scope.connectionId} ` },
    { ...scope, connectionVersion: "1" },
    new Proxy({}, {
      getPrototypeOf() {
        throw new Proxy({}, { get() { throw new Error("hostile scope detail"); } });
      },
    }),
  ]) {
    await assert.rejects(() => resolver.resolveSecret(invalidScope), {
      code: "AI_GATEWAY_REQUEST_INVALID",
    });
  }
  assert.equal(repositoryReads, 0);
});

test("resolver maps repository DTO accessors and proxies to one secret-missing error", async () => {
  const leaked = "ciphertext-or-database-detail-must-not-leak";
  const hostileRows = [
    Object.defineProperty({}, "accountId", {
      enumerable: true,
      get() { throw new Error(leaked); },
    }),
    {
      accountId: scope.accountId,
      id: scope.connectionId,
      version: scope.connectionVersion,
      status: "ACTIVE",
      get encryptedSecret() { throw new Error(leaked); },
    },
    new Proxy({}, {
      get() { throw new Error(leaked); },
      getPrototypeOf() { throw new Error(leaked); },
    }),
  ];

  for (const row of hostileRows) {
    const resolver = createAutoListingAiCredentialResolver({
      repository: { async loadConnectionForSecretResolution() { return row; } },
      cipher: { decrypt() { throw new Error("must not decrypt"); } },
    });
    await assert.rejects(() => resolver.resolveSecret(scope), (error) => (
      error?.code === "AI_GATEWAY_SECRET_MISSING"
      && !String(error.message).includes(leaked)
    ));
  }
});

test("repository and decrypt failures map to stable errors without secret or ciphertext leakage", async () => {
  const { connection } = encryptedConnection();
  const ciphertext = connection.encryptedSecret.ciphertext;
  const secret = "sk-never-leak";
  const fixtures = [
    {
      repository: {
        async loadConnectionForSecretResolution() {
          throw new Error(`database failed ${ciphertext}`);
        },
      },
      cipher: { decrypt() { throw new Error("must not decrypt"); } },
    },
    {
      repository: { async loadConnectionForSecretResolution() { return connection; } },
      cipher: { decrypt() { throw new Error(`crypto failed ${secret}`); } },
    },
    {
      repository: { async loadConnectionForSecretResolution() { return connection; } },
      cipher: { decrypt() { return "   "; } },
    },
  ];

  for (const dependencies of fixtures) {
    const resolver = createAutoListingAiCredentialResolver(dependencies);
    await assert.rejects(() => resolver.resolveSecret(scope), (error) => (
      error?.code === "AI_GATEWAY_SECRET_MISSING"
      && !String(error.message).includes(ciphertext)
      && !String(error.message).includes(secret)
    ));
  }
});

test("resolver requires the Task 2 repository and cipher ports", () => {
  for (const dependencies of [
    undefined,
    {},
    { repository: {}, cipher: { decrypt() {} } },
    { repository: { loadConnectionForSecretResolution() {} }, cipher: {} },
  ]) {
    assert.throws(() => createAutoListingAiCredentialResolver(dependencies), TypeError);
  }
});

test("catalog sync resolver validates the live lease before decrypting and returns one closed in-memory credential", async () => {
  assert.equal(typeof credentialResolvers.createAutoListingAiCatalogSyncCredentialResolver, "function");
  const { cipher, connection } = encryptedConnection("  sk-catalog-lease  ");
  const reads = [];
  const decryptions = [];
  const resolver = credentialResolvers.createAutoListingAiCatalogSyncCredentialResolver({
    repository: {
      async loadCatalogSyncConnectionForSecretResolution(input) {
        reads.push(structuredClone(input));
        return structuredClone({ ...connection, status: "PENDING", baseUrl: "https://gateway.example.test/v1" });
      },
    },
    cipher: {
      decrypt(inputScope, encryptedSecret) {
        decryptions.push(structuredClone(inputScope));
        return cipher.decrypt(inputScope, encryptedSecret);
      },
    },
  });

  const credential = await resolver.resolveCredential({
    accountId: "account-a",
    taskId: "catalog-task-a",
    workerId: "catalog-worker-a",
    leaseVersion: 2,
    leaseToken: "aiglease_catalog-secret",
    minimumLeaseRemainingMs: 45_000,
  });

  assert.deepEqual(reads, [{
    accountId: "account-a",
    taskId: "catalog-task-a",
    workerId: "catalog-worker-a",
    leaseVersion: 2,
    leaseToken: "aiglease_catalog-secret",
    minimumLeaseRemainingMs: 45_000,
  }]);
  assert.deepEqual(decryptions, [scope]);
  assert.deepEqual(credential, {
    connection: {
      id: "connection-a",
      accountId: "account-a",
      version: 1,
      baseUrl: "https://gateway.example.test/v1",
      status: "PENDING",
    },
    secret: "sk-catalog-lease",
  });
  assert.doesNotMatch(JSON.stringify(credential), /cipher|fingerprint|authTag|keyVersion/iu);
});

test("catalog sync resolver preserves lease versus connection-stale failures and never decrypts either", async () => {
  assert.equal(typeof credentialResolvers.createAutoListingAiCatalogSyncCredentialResolver, "function");
  for (const [repositoryCode, expectedCode] of [
    ["AUTO_LISTING_AI_SETTINGS_CATALOG_LEASE_CONFLICT", "AUTO_LISTING_AI_MODEL_SYNC_LEASE_CONFLICT"],
    ["AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT", "AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE"],
  ]) {
    let decryptions = 0;
    const resolver = credentialResolvers.createAutoListingAiCatalogSyncCredentialResolver({
      repository: {
        async loadCatalogSyncConnectionForSecretResolution() {
          const error = new Error("leaseToken=must-not-leak");
          error.code = repositoryCode;
          throw error;
        },
      },
      cipher: { decrypt() { decryptions += 1; return "must-not-run"; } },
    });
    await assert.rejects(resolver.resolveCredential({
      accountId: "account-a",
      taskId: "catalog-task-a",
      workerId: "catalog-worker-a",
      leaseVersion: 2,
      leaseToken: "aiglease_catalog-secret",
      minimumLeaseRemainingMs: 45_000,
    }), (error) => error?.code === expectedCode && !/must-not-leak/iu.test(error.message));
    assert.equal(decryptions, 0);
  }
});

const capabilityExecution = Object.freeze({
  accountId: "account-a",
  profileId: "profile-a",
  configVersion: 1,
  attemptId: "attempt-capability-a",
  correlationId: "corr-capability-a",
  fence: 7,
  leaseVersion: 2,
  leaseToken: "caplease_capability-a",
  purpose: "PROFILE_CAPABILITY",
  authorizationHash: "a".repeat(64),
  requestKey: "b".repeat(64),
  connectionId: "connection-a",
  connectionVersion: 1,
  expectedConnectionStatus: "VALIDATED",
  expectedConnectionStatusVersion: 2,
  probe: "TEXT",
});

test("paid capability resolver binds decryption to the exact persisted attempt execution", async () => {
  assert.equal(typeof credentialResolvers.createAutoListingAiCapabilityCredentialResolver, "function");
  const { cipher, connection } = encryptedConnection("  sk-paid-capability  ");
  const reads = [];
  const transitions = [];
  const resolver = credentialResolvers.createAutoListingAiCapabilityCredentialResolver({
    repository: {
      async loadCapabilityExecutionForSecretResolution(input) {
        reads.push(structuredClone(input));
        return {
          accountId: "account-a",
          profileId: "profile-a",
          configVersion: 1,
          apiKeyEnvName: "SUB2API_ENCRYPTED_KEY",
          connection: { ...connection, status: "VALIDATED", statusVersion: 2 },
          providerRequestKey: "c".repeat(64),
          providerCorrelationId: "capcorr-text-a",
        };
      },
      async markCapabilitySubcallSending(input) {
        transitions.push(["SENDING", structuredClone(input)]);
        return { providerRequestKey: "c".repeat(64), providerCorrelationId: "capcorr-text-a" };
      },
      async completeCapabilitySubcall(input) {
        transitions.push(["SUCCEEDED", structuredClone(input)]);
        return { terminal: true };
      },
    },
    cipher,
    readSecret() { throw new Error("encrypted capability must not read env"); },
  });

  assert.deepEqual(await resolver.prepareSubcall(capabilityExecution), {
    providerRequestKey: "c".repeat(64), providerCorrelationId: "capcorr-text-a",
  });
  const credential = await resolver.resolveCredential(capabilityExecution);
  assert.deepEqual(reads, [capabilityExecution, capabilityExecution]);
  assert.deepEqual(credential, {
    accountId: "account-a",
    profileId: "profile-a",
    configVersion: 1,
    connectionId: "connection-a",
    connectionVersion: 1,
    providerRequestKey: "c".repeat(64),
    providerCorrelationId: "capcorr-text-a",
    secret: "sk-paid-capability",
  });
  assert.deepEqual(await resolver.markSending(capabilityExecution), {
    providerRequestKey: "c".repeat(64), providerCorrelationId: "capcorr-text-a",
  });
  assert.deepEqual(await resolver.completeSubcall(
    capabilityExecution, "SUCCEEDED", "PROVIDER_ACCEPTED",
  ), { terminal: true });
  assert.deepEqual(transitions, [
    ["SENDING", capabilityExecution],
    ["SUCCEEDED", { ...capabilityExecution, outcome: "SUCCEEDED", reason: "PROVIDER_ACCEPTED" }],
  ]);
  assert.doesNotMatch(JSON.stringify(credential), /cipher|fingerprint|authTag|keyVersion/iu);
});

test("paid capability resolver keeps legacy profiles attempt-bound and maps secret-reader failures safely", async () => {
  const legacyExecution = { ...capabilityExecution, connectionId: null, connectionVersion: null,
    expectedConnectionStatus: "LEGACY", expectedConnectionStatusVersion: 0 };
  const repository = {
    async loadCapabilityExecutionForSecretResolution(input) {
      assert.deepEqual(input, legacyExecution);
      return { accountId: "account-a", profileId: "profile-a", configVersion: 1,
        apiKeyEnvName: "SUB2API_LEGACY_KEY", connection: null,
        providerRequestKey: "d".repeat(64), providerCorrelationId: "capcorr-legacy-text" };
    },
    async markCapabilitySubcallSending() {
      return { providerRequestKey: "d".repeat(64), providerCorrelationId: "capcorr-legacy-text" };
    },
    async completeCapabilitySubcall() { return { terminal: true }; },
  };
  const cipher = { decrypt() { throw new Error("legacy must not decrypt"); } };
  const resolver = credentialResolvers.createAutoListingAiCapabilityCredentialResolver({
    repository, cipher, readSecret(name) { assert.equal(name, "SUB2API_LEGACY_KEY"); return "  legacy-secret  "; },
  });
  assert.deepEqual(await resolver.resolveCredential(legacyExecution), {
    accountId: "account-a", profileId: "profile-a", configVersion: 1,
    connectionId: null, connectionVersion: null,
    providerRequestKey: "d".repeat(64), providerCorrelationId: "capcorr-legacy-text",
    secret: "legacy-secret",
  });
  const failing = credentialResolvers.createAutoListingAiCapabilityCredentialResolver({
    repository, cipher, readSecret() { throw new Error("raw-env-secret-must-not-leak"); },
  });
  await assert.rejects(failing.resolveCredential(legacyExecution), (error) => (
    error?.code === "AI_GATEWAY_SECRET_MISSING" && !/raw-env-secret/iu.test(error.message)
  ));
});

test("paid capability resolver preserves execution fence failures without decrypting or reading env", async () => {
  assert.equal(typeof credentialResolvers.createAutoListingAiCapabilityCredentialResolver, "function");
  for (const repositoryCode of [
    "AUTO_LISTING_AI_ADMIN_CAPABILITY_EXECUTION_STALE",
    "AUTO_LISTING_AI_ADMIN_CAPABILITY_EXECUTION_LEASE_CONFLICT",
  ]) {
    let secretReads = 0;
    let decryptions = 0;
    const resolver = credentialResolvers.createAutoListingAiCapabilityCredentialResolver({
      repository: {
        async loadCapabilityExecutionForSecretResolution() {
          const error = new Error("leaseToken=must-not-leak");
          error.code = repositoryCode;
          throw error;
        },
        async markCapabilitySubcallSending() { throw new Error("must not run"); },
        async completeCapabilitySubcall() { throw new Error("must not run"); },
      },
      cipher: { decrypt() { decryptions += 1; return "must-not-run"; } },
      readSecret() { secretReads += 1; return "must-not-run"; },
    });
    await assert.rejects(resolver.resolveCredential(capabilityExecution), (error) => (
      error?.code === (repositoryCode.endsWith("STALE")
        ? "AI_GATEWAY_PROFILE_VERSION_CONFLICT"
        : "AI_GATEWAY_CAPABILITY_IN_PROGRESS")
      && !/must-not-leak/iu.test(error.message)
    ));
    assert.equal(decryptions, 0);
    assert.equal(secretReads, 0);
  }
});

test("paid capability prepare keeps an uncertain persisted reservation reclaimable", async () => {
  const resolver = credentialResolvers.createAutoListingAiCapabilityCredentialResolver({
    repository: {
      async loadCapabilityExecutionForSecretResolution() {
        throw Object.assign(new Error("database response unknown"), {
          code: "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED",
        });
      },
      async markCapabilitySubcallSending() { throw new Error("must not run"); },
      async completeCapabilitySubcall() { throw new Error("must not run"); },
    },
    cipher: { async decrypt() { throw new Error("must not decrypt"); } },
    readSecret() { throw new Error("must not read env"); },
  });

  await assert.rejects(resolver.prepareSubcall(capabilityExecution), {
    code: "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN", retryable: true,
  });
});
