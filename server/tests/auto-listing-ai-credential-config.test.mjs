import assert from "node:assert/strict";
import test from "node:test";
import { loadAutoListingCredentialKey } from "../auto-listing-ai-credential-config.mjs";

const validKey = Buffer.alloc(32, 11).toString("base64url");
const secureFileStat = { isFile: () => true, isSymbolicLink: () => false, mode: 0o100600 };

function credentialFile({ fileStat = secureFileStat, value = validKey, readError } = {}) {
  return async () => ({
    stat: async () => fileStat,
    readFile: async () => {
      if (readError) throw readError;
      return value;
    },
    close: async () => {},
  });
}

function keyError(code) {
  return (error) => error?.code === code && !String(error.message).includes(validKey);
}

test("credential key loader accepts exactly one base64url environment key", async () => {
  const key = await loadAutoListingCredentialKey({
    env: { AUTO_LISTING_CREDENTIAL_MASTER_KEY: validKey },
  });

  assert.deepEqual(key, Buffer.alloc(32, 11));
});

test("credential key loader rejects missing, conflicting, short, and malformed environment key sources", async () => {
  const cases = [
    [{}, "AUTO_LISTING_AI_CREDENTIAL_KEY_MISSING"],
    [{ AUTO_LISTING_CREDENTIAL_MASTER_KEY: validKey, AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE: "/run/secrets/credential-master.key" }, "AUTO_LISTING_AI_CREDENTIAL_KEY_SOURCE_CONFLICT"],
    [{ AUTO_LISTING_CREDENTIAL_MASTER_KEY: Buffer.alloc(31, 11).toString("base64url") }, "AUTO_LISTING_AI_CREDENTIAL_KEY_INVALID"],
    [{ AUTO_LISTING_CREDENTIAL_MASTER_KEY: `${validKey}!` }, "AUTO_LISTING_AI_CREDENTIAL_KEY_INVALID"],
    [{ AUTO_LISTING_CREDENTIAL_MASTER_KEY: `${validKey.slice(0, -1)}x` }, "AUTO_LISTING_AI_CREDENTIAL_KEY_INVALID"],
  ];

  for (const [env, code] of cases) {
    await assert.rejects(
      loadAutoListingCredentialKey({ env }),
      keyError(code),
    );
  }
});

test("credential key loader reads a secure regular key file", async () => {
  const key = await loadAutoListingCredentialKey({
    env: { AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE: "/run/secrets/credential-master.key" },
    open: credentialFile({ value: `${validKey}\n` }),
  });

  assert.deepEqual(key, Buffer.alloc(32, 11));
});

test("credential key loader rejects symlink, non-regular, and group-or-world-readable key files", async () => {
  const insecureStats = [
    { isFile: () => true, isSymbolicLink: () => true, mode: 0o120600 },
    { isFile: () => false, isSymbolicLink: () => false, mode: 0o040600 },
    { isFile: () => true, isSymbolicLink: () => false, mode: 0o100640 },
    { isFile: () => true, isSymbolicLink: () => false, mode: 0o100604 },
    { isFile: () => true, isSymbolicLink: () => false, mode: 0o100620 },
  ];

  for (const statResult of insecureStats) {
    await assert.rejects(
      loadAutoListingCredentialKey({
        env: { AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE: "/run/secrets/credential-master.key" },
        open: credentialFile({ fileStat: statResult }),
      }),
      keyError("AUTO_LISTING_AI_CREDENTIAL_KEY_FILE_INVALID"),
    );
  }
});

test("production rejects the local bootstrap key path and accepts an absolute mounted secret path", async () => {
  await assert.rejects(
    loadAutoListingCredentialKey({
      env: {
        NODE_ENV: "production",
        AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE: "server-data/sub2api-local/credential-master.key",
      },
      open: credentialFile(),
    }),
    keyError("AUTO_LISTING_AI_CREDENTIAL_KEY_PRODUCTION_SOURCE_REQUIRED"),
  );

  const key = await loadAutoListingCredentialKey({
    env: {
      NODE_ENV: "production",
      AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE: "/run/secrets/credential-master.key",
    },
    open: credentialFile(),
  });
  assert.deepEqual(key, Buffer.alloc(32, 11));
});

test("credential key loader reads a verified open descriptor instead of reopening a checked path", async () => {
  let closeCount = 0;
  const key = await loadAutoListingCredentialKey({
    env: { AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE: "/run/secrets/credential-master.key" },
    readFile: async () => { throw new Error("path must not be reopened"); },
    stat: async () => { throw new Error("path must not be restated"); },
    open: async (path) => {
      assert.equal(path, "/run/secrets/credential-master.key");
      return {
        stat: async () => secureFileStat,
        readFile: async (encoding) => {
          assert.equal(encoding, "utf8");
          return validKey;
        },
        close: async () => { closeCount += 1; },
      };
    },
  });

  assert.deepEqual(key, Buffer.alloc(32, 11));
  assert.equal(closeCount, 1);
});

test("credential key loader normalizes file read failures without leaking the path or key", async () => {
  await assert.rejects(
    loadAutoListingCredentialKey({
      env: { AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE: "/private/credential-master.key" },
      open: credentialFile({ readError: new Error("permission denied /private/credential-master.key") }),
    }),
    (error) => error?.code === "AUTO_LISTING_AI_CREDENTIAL_KEY_FILE_READ_FAILED"
      && !String(error.message).includes("/private/credential-master.key"),
  );
});
