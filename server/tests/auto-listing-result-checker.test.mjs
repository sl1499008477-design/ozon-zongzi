import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { sha256 } from "../auto-listing-asset-store.mjs";
import { checkGeneratedAsset } from "../auto-listing-result-checker.mjs";

async function image() { return sharp({ create: { width: 768, height: 1024, channels: 4, background: "#112233" } }).png().toBuffer(); }
async function input(value) {
  const bytes = await image();
  return {
    generated: { bytes }, ratio: "3:4", resolution: "1K", profile: { id: "profile-a", configVersion: 2 }, checkerModel: "checker-a", templateVersion: "image-v1",
    scope: { correlationId: "corr", requestKey: "check-key" }, facts: [{ factId: "f1" }],
    references: [{ assetId: "asset-a", contentHash: sha256(bytes), contentType: "image/png", bytes }],
    gateway: { async inspectImage(request) { assert.equal(request.sourceImages.length, 1); return { requestId: "check-1", value: Object.keys(value).length === 1 ? value : { ...value, evidence: { identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] }, claims: [{ text: "red product", sourceFactIds: ["f1"] }], detectedTexts: ["товар"], language: "ru", qualityFlags: [], prohibitedFlags: [] } } }; } },
  };
}

test("deterministic gate and closed checker response accept a verified generated asset", async () => {
  const result = await checkGeneratedAsset(await input({ matchesProduct: true, claimsVerified: true, russianText: true, quality: "PASS", prohibitedContent: false, reasons: [] }));
  assert.equal(result.accepted, true);
  assert.equal(result.evidence.generatedHash.length, 64);
});

test("policy failure is a deterministic non-retryable rejection", async () => {
  const result = await checkGeneratedAsset(await input({ matchesProduct: false, claimsVerified: true, russianText: true, quality: "PASS", prohibitedContent: false, reasons: ["wrong_product"] }));
  assert.deepEqual({ accepted: result.accepted, code: result.code, retryable: result.retryable }, { accepted: false, code: "PRODUCT_IDENTITY_MISMATCH", retryable: false });
});

test("maps product, claim, Russian-copy, quality, and marketplace-policy findings to stable policy codes", async () => {
  const cases = [
    ["wrong color or accessory", { matchesProduct: false, claimsVerified: true, russianText: true, quality: "PASS", prohibitedContent: false, reasons: ["color"] }, "PRODUCT_IDENTITY_MISMATCH"],
    ["unsupported numeric claim", { matchesProduct: true, claimsVerified: false, russianText: true, quality: "PASS", prohibitedContent: false, reasons: ["number"] }, "UNVERIFIED_CLAIM"],
    ["non Russian copy", { matchesProduct: true, claimsVerified: true, russianText: false, quality: "PASS", prohibitedContent: false, reasons: ["language"] }, "LANGUAGE_MISMATCH"],
    ["blur crop obstruction", { matchesProduct: true, claimsVerified: true, russianText: true, quality: "FAIL", prohibitedContent: false, reasons: ["blur"] }, "IMAGE_QUALITY_FAILED"],
    ["contact review or external promotion", { matchesProduct: true, claimsVerified: true, russianText: true, quality: "PASS", prohibitedContent: true, reasons: ["contact"] }, "PROHIBITED_CONTENT"],
  ];
  for (const [, value, code] of cases) {
    const result = await checkGeneratedAsset(await input(value));
    assert.deepEqual({ accepted: result.accepted, code: result.code, retryable: result.retryable }, { accepted: false, code, retryable: false });
  }
});

test("rejects malformed checker output as an operationally distinguishable retryable failure", async () => {
  await assert.rejects(checkGeneratedAsset(await input({ matchesProduct: true })), (error) => error?.code === "CHECKER_UNAVAILABLE" && error?.retryable === true);
});
