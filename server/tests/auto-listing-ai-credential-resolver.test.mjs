import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingCredentialCipher } from "../auto-listing-ai-credential-crypto.mjs";
import { createAutoListingAiCredentialResolver } from "../auto-listing-ai-credential-resolver.mjs";

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
