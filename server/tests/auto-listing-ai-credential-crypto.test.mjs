import assert from "node:assert/strict";
import test from "node:test";
import { createAutoListingCredentialCipher } from "../auto-listing-ai-credential-crypto.mjs";

const key = Buffer.alloc(32, 7);
const scope = {
  accountId: "account-a",
  connectionId: "connection-a",
  connectionVersion: 1,
};

test("cipher binds ciphertext to account, connection, and version", () => {
  const cipher = createAutoListingCredentialCipher({ key, keyVersion: "local-v1" });
  const encrypted = cipher.encrypt(scope, "sk-gateway-secret");

  assert.equal(cipher.decrypt(scope, encrypted), "sk-gateway-secret");
  assert.throws(
    () => cipher.decrypt({ ...scope, accountId: "account-b" }, encrypted),
    (error) => error?.code === "AUTO_LISTING_AI_CREDENTIAL_DECRYPT_FAILED",
  );
  assert.throws(
    () => cipher.decrypt({ ...scope, connectionId: "connection-b" }, encrypted),
    (error) => error?.code === "AUTO_LISTING_AI_CREDENTIAL_DECRYPT_FAILED",
  );
  assert.throws(
    () => cipher.decrypt({ ...scope, connectionVersion: 2 }, encrypted),
    (error) => error?.code === "AUTO_LISTING_AI_CREDENTIAL_DECRYPT_FAILED",
  );
  assert.doesNotMatch(JSON.stringify(encrypted), /sk-gateway-secret/);
});

test("cipher binds ciphertext to the normalized key version", () => {
  const v1Cipher = createAutoListingCredentialCipher({ key, keyVersion: "local-v1" });
  const v2Cipher = createAutoListingCredentialCipher({ key, keyVersion: "local-v2" });
  const encrypted = v1Cipher.encrypt(scope, "sk-gateway-secret");

  assert.throws(
    () => v2Cipher.decrypt(scope, { ...encrypted, keyVersion: "local-v2" }),
    (error) => error?.code === "AUTO_LISTING_AI_CREDENTIAL_DECRYPT_FAILED",
  );
});

test("cipher emits opaque versioned payloads and stable fingerprints", () => {
  const cipher = createAutoListingCredentialCipher({ key, keyVersion: "local-v1" });
  const encrypted = cipher.encrypt(scope, "sk-gateway-secret");

  assert.deepEqual(Object.keys(encrypted).sort(), ["algorithm", "authTag", "ciphertext", "iv", "keyVersion"]);
  assert.equal(encrypted.algorithm, "aes-256-gcm");
  assert.equal(encrypted.keyVersion, "local-v1");
  assert.match(encrypted.iv, /^[A-Za-z0-9+/]+={0,2}$/u);
  assert.match(encrypted.authTag, /^[A-Za-z0-9+/]+={0,2}$/u);
  assert.match(encrypted.ciphertext, /^[A-Za-z0-9+/]+={0,2}$/u);
  assert.equal(cipher.fingerprint("sk-gateway-secret"), cipher.fingerprint("sk-gateway-secret"));
  assert.notEqual(cipher.fingerprint("sk-gateway-secret"), cipher.fingerprint("sk-gateway-secret-2"));
  assert.match(cipher.fingerprint("sk-gateway-secret"), /^[a-f0-9]{32}$/u);
});

test("cipher rejects malformed payloads without leaking ciphertext or crypto internals", () => {
  const cipher = createAutoListingCredentialCipher({ key, keyVersion: "local-v1" });
  const encrypted = cipher.encrypt(scope, "sk-gateway-secret");

  for (const payload of [null, {}, { ...encrypted, keyVersion: "old-v1" }, { ...encrypted, authTag: "not-base64" }]) {
    assert.throws(() => cipher.decrypt(scope, payload), (error) => (
      error?.code === "AUTO_LISTING_AI_CREDENTIAL_DECRYPT_FAILED"
      && !String(error.message).includes("sk-gateway-secret")
      && !String(error.message).includes("Unsupported state")
    ));
  }
});
