import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { sha256 } from "../auto-listing-asset-store.mjs";
import * as checkerModule from "../auto-listing-result-checker.mjs";

const { checkGeneratedAsset } = checkerModule;

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

async function input(value, overrides = {}) {
  const bytes = await image();
  return {
    generated: { bytes },
    ratio: "3:4",
    resolution: "1K",
    profile: { id: "profile-a", accountId: "account-a", configVersion: 2 },
    checkerModel: "checker-a",
    templateVersion: "image-v1",
    textRequired: true,
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
    ...overrides,
  };
}

function evaluatorInput(checkerResult, overrides = {}) {
  return {
    checkerResult,
    references: [{ assetId: "asset-a", contentHash: "a".repeat(64), contentType: "image/png", width: 768, height: 1024, size: 1024 }],
    facts: [fact],
    checkerModel: "checker-a",
    profile: { id: "profile-a", accountId: "account-a", configVersion: 2 },
    templateVersion: "image-v1",
    requestId: "check-1",
    generatedHash: "b".repeat(64),
    checkerModelEvidence: {
      requestedTextModel: "checker-a",
      gatewayReportedTextModel: "checker-a",
      gatewayReportedTextModelPresent: true,
    },
    textRequired: true,
    ...overrides,
  };
}

const checkerUnavailable = (error) => error?.code === "CHECKER_UNAVAILABLE" && error?.retryable === true;

function throwingOversizedArray(length) {
  return new Proxy(new Array(length), {
    get(target, property, receiver) {
      if (property === Symbol.iterator || /^(?:0|[1-9][0-9]*)$/u.test(String(property))) {
        throw new Error("oversized checker array was traversed");
      }
      return Reflect.get(target, property, receiver);
    },
  });
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
  const mixedInput = await input(checkerValue({}, { detectedTexts: ["Высота Brand 500 — 1 см"], language: "ru" }));
  mixedInput.facts.push({ factId: "fact.brand", field: "identity.brand", kind: "BRAND", value: "Brand 500", numericValue: null, unit: null, sourcePath: "identity.brand" });
  const mixed = await checkGeneratedAsset(mixedInput);
  assert.equal(mixed.accepted, true);
  const cyrillicAlphanumeric = await checkGeneratedAsset(await input(checkerValue({}, { detectedTexts: ["Модель2"] })));
  assert.equal(cyrillicAlphanumeric.accepted, true);
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

test("claim text cannot hide extra numeric units or unrelated nonnumeric copy behind bound fields", async () => {
  const numeric = await checkGeneratedAsset(await input(checkerValue({}, { claims: [{ ...verifiedClaim, text: "Вес 999kg, высота 1 cm" }] })));
  assert.equal(numeric.code, "UNVERIFIED_CLAIM");
  const missingUnit = await checkGeneratedAsset(await input(checkerValue({}, { claims: [{ ...verifiedClaim, text: "Высота 1" }] })));
  assert.equal(missingUnit.code, "UNVERIFIED_CLAIM");
  const materialFact = { factId: "fact.material", field: "attributes.material", kind: "ATTRIBUTE", value: "Титан", numericValue: null, unit: null, sourcePath: "attributes.material" };
  const materialInput = await input(checkerValue({}, { claims: [{ text: "Стальной корпус", sourceFactId: materialFact.factId, field: materialFact.field, value: materialFact.value, numericValue: null, unit: null }] }));
  materialInput.facts = [materialFact];
  const textual = await checkGeneratedAsset(materialInput);
  assert.equal(textual.code, "UNVERIFIED_CLAIM");

  const modelFact = { factId: "fact.model", field: "identity.model", kind: "MODEL", value: "Brand 500", numericValue: null, unit: null, sourcePath: "identity.model" };
  for (const [text, code] of [["Модель Brand 500", undefined], ["Модель Brand 500 999", "UNVERIFIED_CLAIM"]]) {
    const modelInput = await input(checkerValue({}, { claims: [{ text, sourceFactId: modelFact.factId, field: modelFact.field, value: modelFact.value, numericValue: null, unit: null }], detectedTexts: ["Модель Brand 500"] }));
    modelInput.facts = [modelFact];
    assert.equal((await checkGeneratedAsset(modelInput)).code, code, text);
  }
});

test("each detected text segment allows only Russian or fact-proven brand model and technical tokens", async () => {
  const brandFact = { factId: "fact.brand", field: "identity.brand", kind: "BRAND", value: "Brand 500", numericValue: null, unit: null, sourcePath: "identity.brand" };
  const techFact = { factId: "fact.tech", field: "attributes.connectivity", kind: "ATTRIBUTE", value: "USB LED IPX7", numericValue: null, unit: null, sourcePath: "attributes.connectivity" };
  const acceptedInput = await input(checkerValue({}, { detectedTexts: ["Высота 1 см", "Brand 500", "USB LED IPX7"] }));
  acceptedInput.facts.push(brandFact, techFact);
  assert.equal((await checkGeneratedAsset(acceptedInput)).accepted, true);
  for (const detectedTexts of [["Высота 1 см", "Best choice"], ["Высота 1 см", "最佳选择"]]) {
    const rejectedInput = await input(checkerValue({}, { detectedTexts }));
    rejectedInput.facts.push(brandFact, techFact);
    assert.equal((await checkGeneratedAsset(rejectedInput)).code, "LANGUAGE_MISMATCH", detectedTexts[1]);
  }
  const arbitraryInput = await input(checkerValue({}, { detectedTexts: ["Высота 1 см", "SUPER"] }));
  arbitraryInput.facts.push({ factId: "fact.marketing", field: "attributes.marketing", kind: "ATTRIBUTE", value: "SUPER", numericValue: null, unit: null, sourcePath: "attributes.marketing" });
  assert.equal((await checkGeneratedAsset(arbitraryInput)).code, "LANGUAGE_MISMATCH");

  const exceptionOnly = await input(checkerValue({}, { detectedTexts: ["Brand 500", "USB LED IPX7"] }));
  exceptionOnly.facts.push(brandFact, techFact);
  assert.equal((await checkGeneratedAsset(exceptionOnly)).code, "LANGUAGE_MISMATCH");
  for (const contradiction of [checkerValue({ russianText: false }, { detectedTexts: ["Brand 500"] }), checkerValue({}, { detectedTexts: ["Brand 500"], language: "other" })]) {
    const contradicted = await input(contradiction);
    contradicted.facts.push(brandFact);
    assert.equal((await checkGeneratedAsset(contradicted)).code, "LANGUAGE_MISMATCH");
  }
});

test("empty detected text follows the explicit slot text requirement", async () => {
  const required = await checkGeneratedAsset(await input(checkerValue({}, { detectedTexts: [] })));
  assert.equal(required.code, "LANGUAGE_MISMATCH");
  const none = checkerValue({}, { claims: [], detectedTexts: [] });
  const optional = await checkGeneratedAsset(await input(none, { textRequired: false }));
  assert.equal(optional.accepted, true);

  const explicitNoText = checkerValue(
    { russianText: false },
    { claims: [], detectedTexts: [], language: "other" },
  );
  const explicitOptional = await checkGeneratedAsset(await input(explicitNoText, { textRequired: false }));
  assert.equal(explicitOptional.accepted, true);
});

test("punctuation-only or emoji-only OCR evidence cannot impersonate valid Russian text", async () => {
  for (const detectedText of ["!!!", "🔥✨"]) {
    const result = await checkGeneratedAsset(await input(checkerValue({}, { claims: [], detectedTexts: [detectedText] })));
    assert.equal(result.code, "LANGUAGE_MISMATCH");
  }
});

test("checker text ceilings use UTF-8 bytes instead of JavaScript character counts", async () => {
  const russian2048Bytes = "я".repeat(1024);
  const russian2050Bytes = "я".repeat(1025);
  assert.equal(Buffer.byteLength(russian2048Bytes, "utf8"), 2048);
  assert.equal(Buffer.byteLength(russian2050Bytes, "utf8"), 2050);

  assert.equal(checkerModule.evaluateGeneratedCheckerEvidence(
    evaluatorInput(checkerValue({}, { detectedTexts: [russian2048Bytes] })),
  ).accepted, true);

  const overlongCases = [
    checkerValue({ matchesProduct: false, reasons: ["я".repeat(121)] }),
    checkerValue({}, { identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["я".repeat(121)] } }),
    checkerValue({}, { claims: [{ ...verifiedClaim, text: russian2050Bytes }] }),
    checkerValue({}, { claims: [{ ...verifiedClaim, sourceFactId: "я".repeat(121) }] }),
    checkerValue({}, { claims: [{ ...verifiedClaim, field: "я".repeat(257) }] }),
    checkerValue({}, { claims: [{ ...verifiedClaim, value: russian2050Bytes }] }),
    checkerValue({}, { claims: [{ ...verifiedClaim, unit: "я".repeat(33) }] }),
    checkerValue({}, { detectedTexts: [russian2050Bytes] }),
  ];
  for (const value of overlongCases) {
    assert.throws(
      () => checkerModule.evaluateGeneratedCheckerEvidence(evaluatorInput(value)),
      checkerUnavailable,
    );
  }
});

test("checker arrays have explicit caps and reject oversize before iteration", async () => {
  const cases = [
    ["reasons", 33, (array) => checkerValue({ reasons: array })],
    ["sourceAssetIds", 8, (array) => checkerValue({}, { identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: array } })],
    ["claims", 257, (array) => checkerValue({}, { claims: array })],
    ["detectedTexts", 65, (array) => checkerValue({}, { detectedTexts: array })],
    ["qualityFlags", 5, (array) => checkerValue({}, { qualityFlags: array })],
    ["prohibitedFlags", 9, (array) => checkerValue({}, { prohibitedFlags: array })],
  ];
  for (const [name, length, build] of cases) {
    assert.throws(
      () => checkerModule.evaluateGeneratedCheckerEvidence(evaluatorInput(build(throwingOversizedArray(length)))),
      checkerUnavailable,
      name,
    );
  }

  let checkerSchema;
  const request = await input(checkerValue());
  request.gateway.inspectImage = async ({ jsonSchema }) => {
    checkerSchema = jsonSchema;
    return {
      requestId: "check-1",
      modelEvidence: {
        requestedTextModel: "checker-a",
        gatewayReportedTextModel: "checker-a",
        gatewayReportedTextModelPresent: true,
      },
      value: checkerValue(),
    };
  };
  assert.equal((await checkGeneratedAsset(request)).accepted, true);
  assert.equal(checkerSchema.properties.reasons.maxItems, 32);
  assert.equal(checkerSchema.properties.evidence.properties.identity.properties.sourceAssetIds.maxItems, 7);
  assert.equal(checkerSchema.properties.evidence.properties.claims.maxItems, 256);
  assert.equal(checkerSchema.properties.evidence.properties.detectedTexts.maxItems, 64);
  assert.equal(checkerSchema.properties.evidence.properties.qualityFlags.maxItems, 4);
  assert.equal(checkerSchema.properties.evidence.properties.prohibitedFlags.maxItems, 8);
});

test("outer checker rejects oversized references and facts before generated-image decoding", async () => {
  for (const overrides of [
    { references: throwingOversizedArray(8) },
    { facts: throwingOversizedArray(257) },
  ]) {
    const request = await input(checkerValue());
    request.generated = { bytes: Buffer.from("not-an-image", "utf8") };
    Object.assign(request, overrides);
    await assert.rejects(checkGeneratedAsset(request), checkerUnavailable);
  }
});

test("exports one pure closed evaluator and persists the complete raw checker decision for replay", async () => {
  assert.equal(typeof checkerModule.evaluateGeneratedCheckerEvidence, "function");
  const request = await input(checkerValue());
  const live = await checkGeneratedAsset(request);
  assert.deepEqual(live.evidence.checkerResult, checkerValue());
  const replay = checkerModule.evaluateGeneratedCheckerEvidence({
    checkerResult: live.evidence.checkerResult,
    references: request.references,
    facts: request.facts,
    checkerModel: request.checkerModel,
    profile: request.profile,
    templateVersion: request.templateVersion,
    requestId: live.evidence.requestId,
    generatedHash: live.evidence.generatedHash,
    checkerModelEvidence: live.evidence.checkerModelEvidence,
    textRequired: true,
  });
  assert.equal(replay.accepted, true);
  assert.deepEqual(replay.evidence, live.evidence);
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
