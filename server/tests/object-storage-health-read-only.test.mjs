import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "minio";

process.env.QH_LOCAL_NO_DOTENV = "1";
process.env.QH_LOCAL_NO_LISTEN = "1";
Object.assign(process.env, { MINIO_ENDPOINT: "unused.invalid", MINIO_ACCESS_KEY: "synthetic", MINIO_SECRET_KEY: "synthetic", MINIO_BUCKET: "synthetic-health-test" });
const { objectStorageHealth } = await import("../object-storage.mjs");

test("a missing storage bucket is reported by readiness and is not created by it", async (t) => {
  t.mock.method(Client.prototype, "bucketExists", async () => false);
  t.mock.method(Client.prototype, "makeBucket", async () => { assert.fail("a health probe must not create a bucket"); });
  const result = await objectStorageHealth();
  assert.equal(result.ok, false);
});

test("an existing storage bucket passes readiness without a write", async (t) => {
  t.mock.method(Client.prototype, "bucketExists", async () => true);
  t.mock.method(Client.prototype, "makeBucket", async () => { assert.fail("a health probe must not create a bucket"); });
  assert.equal((await objectStorageHealth()).ok, true);
});
