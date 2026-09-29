import assert from "node:assert/strict";
import test from "node:test";
import { autoListingSourceImageIntelligenceEnabled } from "../runtime-config.mjs";
import * as runtimeConfig from "../runtime-config.mjs";

test("runtime config accepts only an explicit boolean source-image intelligence flag", () => {
  assert.equal(autoListingSourceImageIntelligenceEnabled({ AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1_ENABLED: "true" }), true);
  assert.equal(autoListingSourceImageIntelligenceEnabled({}), false);
  assert.throws(() => autoListingSourceImageIntelligenceEnabled({ AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1_ENABLED: "yes" }), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_CONFIG_INVALID",
  });
});

test("public COS selection requires its own credentials and leaves MinIO as the default", () => {
  assert.equal(typeof runtimeConfig.listingMediaStorageConfig, "function");
  const config = runtimeConfig.listingMediaStorageConfig;
  assert.deepEqual(config({}), { provider: "minio" });
  assert.deepEqual(config({ LISTING_MEDIA_STORAGE: "minio", LISTING_COS_SECRET_ID: "partial" }), { provider: "minio" });
  const env = { LISTING_MEDIA_STORAGE: "cos", LISTING_COS_BUCKET: "public-media-1250000000",
    LISTING_COS_REGION: "ap-shanghai", LISTING_COS_SECRET_ID: "cos-id-marker", LISTING_COS_SECRET_KEY: "cos-key-marker" };
  assert.deepEqual(config(env), { provider: "cos", bucket: "public-media-1250000000", region: "ap-shanghai",
    secretId: "cos-id-marker", secretKey: "cos-key-marker" });
  for (const name of ["LISTING_COS_BUCKET", "LISTING_COS_REGION", "LISTING_COS_SECRET_ID", "LISTING_COS_SECRET_KEY"]) {
    assert.throws(() => config({ ...env, [name]: "", MINIO_ACCESS_KEY: "private-id", MINIO_SECRET_KEY: "private-key" }), error => {
      assert.equal(error.code, "LISTING_MEDIA_STORAGE_CONFIG_INVALID");
      assert.doesNotMatch(error.message, /marker|private-id|private-key/);
      return true;
    });
  }
  assert.throws(() => config({ LISTING_MEDIA_STORAGE: "unknown" }), { code: "LISTING_MEDIA_STORAGE_CONFIG_INVALID" });
});
