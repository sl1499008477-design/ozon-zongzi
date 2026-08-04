import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { sha256 } from "../auto-listing-asset-store.mjs";
import { checkGeneratedAsset } from "../auto-listing-result-checker.mjs";

async function image() {
  return sharp({ create: { width: 768, height: 1024, channels: 4, background: "#112233" } }).png().toBuffer();
}

const fact = Object.freeze({
  factId: "fact.product.heightCm",
  field: "productMeasurements.heightCm",
  kind: "DIMENSION_HEIGHT",
  value: "1 cm",
  numericValue: 1,
  unit: "cm",
  sourcePath: "productMeasurements.heightCm",
});

const verifiedClaim = Object.freeze({
  text: "Высота 1 см",
  sourceFactId: fact.factId,
  field: fact.field,
  value: fact.value,
  numericValue: fact.numericValue,
  unit: fact.unit,
});

function checkerValue(overrides = {}, evidenceOverrides = {}) {
  return {
    matchesProduct: true,
    claimsVerified: true,
    russianText: true,
    quality: "PASS",
    prohibitedContent: false,
    reasons: [],
    evidence: {
      identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] },
      claims: [verifiedClaim],
      detectedTexts: ["Высота 1 см"],
      language: "ru",
      qualityFlags: [],
      prohibitedFlags: [],
      ...evidenceOverrides,
    },
    ...overrides,
  };
}

async function input(value) {
  const bytes = await image();
  return {
    generated: { bytes },
    ratio: "3:4",
    resolution: "1K",
    profile: { id: "profile-a", accountId: "account-a", configVersion: 2 },
    checkerModel: "checker-a",
    templateVersion: "image-v1",
    scope: { correlationId: "corr", requestKey: "check-key" },
    facts: [fact],
    references: [{ assetId: "asset-a", contentHash: sha256(bytes), contentType: "image/png", width: 768, height: 1024, size: bytes.length, bytes }],
    gateway: {
      async inspectImage(request) {
        assert.equal(request.sourceImages.length, 1);
        return {
          requestId: "check-1",
          modelEvidence: {
            requestedTextModel: "checker-a",
            gatewayReportedTextModel: "checker-a",
            gatewayReportedTextModelPresent: true,
          },
          value,
        };
      },
    },
  };
}

test("deterministic gate and closed checker response accept complete source-bound evidence", async () => {
  const result = await checkGeneratedAsset(await input(checkerValue()));
  assert.equal(result.accepted, true);
  assert.equal(result.evidence.generatedHash.length, 64);
  assert.equal(result.evidence.requestId, "check-1");
  assert.deepEqual(result.evidence.sourceFacts, [fact]);
  assert.deepEqual(result.evidence.sourceAssets.map(({ bytes: _bytes, ...entry }) => entry), [{
    assetId: "asset-a",
    contentHash: result.evidence.sourceAssets[0].contentHash,
    contentType: "image/png",
    width: 768,
    height: 1024,
    size: result.evidence.sourceAssets[0].size,
  }]);
});

test("identity evidence overrides contradictory top-level success", async () => {
  for (const field of ["color", "shape", "accessoryCount"]) {
    const identity = { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"], [field]: false };
    const result = await checkGeneratedAsset(await input(checkerValue({}, { identity })));
    assert.equal(result.code, "PRODUCT_IDENTITY_MISMATCH", field);
  }
});

test("language evidence and quality/prohibited flags override contradictory top-level success", async () => {
  const cases = [
    [checkerValue({}, { language: "other" }), "LANGUAGE_MISMATCH"],
    [checkerValue({}, { qualityFlags: ["BLUR"] }), "IMAGE_QUALITY_FAILED"],
    [checkerValue({}, { qualityFlags: ["CROP"] }), "IMAGE_QUALITY_FAILED"],
    [checkerValue({}, { qualityFlags: ["OBSTRUCTION"] }), "IMAGE_QUALITY_FAILED"],
    [checkerValue({}, { prohibitedFlags: ["CONTACT"] }), "PROHIBITED_CONTENT"],
    [checkerValue({}, { prohibitedFlags: ["REVIEW_REQUEST"] }), "PROHIBITED_CONTENT"],
    [checkerValue({}, { prohibitedFlags: ["EXTERNAL_PROMOTION"] }), "PROHIBITED_CONTENT"],
    [checkerValue({}, { prohibitedFlags: ["CERTIFICATION"] }), "PROHIBITED_CONTENT"],
    [checkerValue({}, { prohibitedFlags: ["MEDICAL_BENEFIT"] }), "PROHIBITED_CONTENT"],
    [checkerValue({}, { prohibitedFlags: ["UNLISTED_ACCESSORIES"] }), "PROHIBITED_CONTENT"],
    [checkerValue({}, { prohibitedFlags: ["WARRANTY"] }), "PROHIBITED_CONTENT"],
  ];
  for (const [value, code] of cases) {
    const result = await checkGeneratedAsset(await input(value));
    assert.equal(result.code, code);
  }
});

test("Russian body permits brand/model letters and numbers but an entirely non-Russian body fails closed", async () => {
  const mixed = await checkGeneratedAsset(await input(checkerValue({}, { detectedTexts: ["Высота Brand 500 — 1 см"], language: "ru" })));
  assert.equal(mixed.accepted, true);
  const nonRussian = await checkGeneratedAsset(await input(checkerValue({}, { detectedTexts: ["Brand 500 HEIGHT 1 CM"], language: "ru" })));
  assert.equal(nonRussian.code, "LANGUAGE_MISMATCH");
});

test("numeric claims must bind the same field, value, unit, and source fact", async () => {
  const mutations = [
    { text: "Вес 999 кг", field: "productMeasurements.weight", value: "999 kg", numericValue: 999, unit: "kg" },
    { text: "Высота 999 см", value: "999 cm", numericValue: 999 },
    { text: "Высота 1 кг", value: "1 kg", unit: "kg" },
    { text: "Высота 1 см", sourceFactId: "fact.unknown" },
  ];
  for (const mutation of mutations) {
    const result = await checkGeneratedAsset(await input(checkerValue({}, { claims: [{ ...verifiedClaim, ...mutation }] })));
    assert.equal(result.code, "UNVERIFIED_CLAIM", JSON.stringify(mutation));
  }
});

test("closed checker evidence rejects unknown flags, keys, references, and claim shapes", async () => {
  const malformed = [
    checkerValue({ unexpected: true }),
    checkerValue({}, { unexpected: true }),
    checkerValue({}, { qualityFlags: ["UNKNOWN_FLAG"] }),
    checkerValue({}, { prohibitedFlags: ["UNKNOWN_FLAG"] }),
    checkerValue({}, { identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["foreign"] } }),
    checkerValue({}, { claims: [{ ...verifiedClaim, unexpected: true }] }),
    checkerValue({}, { claims: [{ text: "Высота 1 см", sourceFactIds: [fact.factId] }] }),
  ];
  for (const value of malformed) {
    await assert.rejects(checkGeneratedAsset(await input(value)), (error) => error?.code === "CHECKER_UNAVAILABLE" && error?.retryable === true);
  }
});

test("top-level policy failures remain deterministic non-retryable rejections", async () => {
  const cases = [
    [checkerValue({ matchesProduct: false }), "PRODUCT_IDENTITY_MISMATCH"],
    [checkerValue({ claimsVerified: false }), "UNVERIFIED_CLAIM"],
    [checkerValue({ russianText: false }), "LANGUAGE_MISMATCH"],
    [checkerValue({ quality: "FAIL" }), "IMAGE_QUALITY_FAILED"],
    [checkerValue({ prohibitedContent: true }), "PROHIBITED_CONTENT"],
  ];
  for (const [value, code] of cases) {
    const result = await checkGeneratedAsset(await input(value));
    assert.deepEqual({ accepted: result.accepted, code: result.code, retryable: result.retryable }, { accepted: false, code, retryable: false });
  }
});

test("malformed checker output is an operationally distinguishable retryable failure", async () => {
  await assert.rejects(checkGeneratedAsset(await input({ matchesProduct: true })), (error) => error?.code === "CHECKER_UNAVAILABLE" && error?.retryable === true);
});
