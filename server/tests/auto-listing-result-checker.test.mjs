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
    matchesCategoryStyle: true,
    claimsVerified: true,
    russianText: true,
    quality: "PASS",
    prohibitedContent: false,
    reasons: [],
    evidence: {
      identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] },
      categoryStyle: { matches: true, referenceEvidenceIds: [] },
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
        assert.equal(Object.hasOwn(request, "timeoutMs"), false);
        assert.equal(request.idleTimeoutMs, 300_000);
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
  const result = await checkGeneratedAsset(await input(checkerValue(), {
    gatewayExecution: {
      channelId: "channel-b", connectionId: "connection-b", connectionVersion: 9, idleTimeoutMs: 300_000,
    },
  }));
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

test("checker rejects an open leased execution before a paid inspection", async () => {
  let calls = 0;
  const candidate = await input(checkerValue(), {
    gatewayExecution: {
      channelId: "channel-b", connectionId: "connection-b", connectionVersion: 9,
      idleTimeoutMs: 300_000, fallback: true,
    },
  });
  candidate.gateway.inspectImage = async () => { calls += 1; };
  await assert.rejects(checkGeneratedAsset(candidate), checkerUnavailable);
  assert.equal(calls, 0);
});

test("legacy accepted checker evidence remains valid when no category style images existed", () => {
  const legacy = checkerValue();
  delete legacy.matchesCategoryStyle;
  delete legacy.evidence.categoryStyle;

  const result = checkerModule.evaluateGeneratedCheckerEvidence(evaluatorInput(legacy));

  assert.equal(result.accepted, true);
  assert.equal(Object.hasOwn(result.evidence, "categoryStyleAssets"), false);
  assert.equal(Object.hasOwn(result.evidence, "categoryStyleGuidance"), false);
});

test("rejects an image that is valid product evidence but does not match cited category style", async () => {
  const styleBytes = await sharp({ create: { width: 900, height: 1200, channels: 4, background: "#cc3366" } }).webp().toBuffer();
  const response = checkerValue({ matchesCategoryStyle: false }, {
    categoryStyle: { matches: false, referenceEvidenceIds: ["style-evidence-a"] },
  });
  const request = await input(response, {
    templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
    claimEvidenceFactIds: [fact.factId],
    categoryStyle: {
      overallStyle: "bold marketplace infographic",
      prohibitedPatterns: [], role: "MAIN", composition: "large centered product",
      background: "high contrast gradient", textDensity: "LIGHT", layout: "headline above product",
    },
    categoryStyleReferences: [{
      evidenceId: "style-evidence-a", sku: "sample-sku-a", contentHash: sha256(styleBytes),
      contentType: "image/webp", width: 900, height: 1200, size: styleBytes.length, bytes: styleBytes,
    }],
  });

  const result = await checkGeneratedAsset(request);

  assert.equal(result.accepted, false);
  assert.equal(result.code, "CATEGORY_STYLE_MISMATCH");
  assert.equal(result.severity, "SOFT");
  assert.deepEqual(result.evidence.categoryStyleAssets.map(({ evidenceId }) => evidenceId), ["style-evidence-a"]);
});

test("checker request uses only the best product reference and keeps exact facts in structured context", async () => {
  const request = await input(checkerValue({}, {
    identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] },
  }));
  request.references.push({ ...request.references[0], assetId: "asset-b" });
  request.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";
  let prompt;
  request.gateway.inspectImage = async (value) => {
    prompt = value.prompt;
    assert.equal(value.sourceImages.length, 1);
    return {
      requestId: "check-1",
      modelEvidence: {
        requestedTextModel: "checker-a",
        gatewayReportedTextModel: "checker-a",
        gatewayReportedTextModelPresent: true,
      },
      value: checkerValue({}, {
        identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] },
      }),
    };
  };

  assert.equal((await checkGeneratedAsset(request)).accepted, true);
  assert.match(prompt, /辅助展示商品功能的环境物品不是随附配件/u);
  assert.match(prompt, /逐词提取的合法子集就必须把 claimsVerified 设为 true/u);
  assert.match(prompt, /没有展示 facts 中的全部随附配件不构成不一致/u);
  assert.match(prompt, /detectedTexts 只列第一张待检查结果中的可编辑营销文案/u);
  assert.match(prompt, /不得抄录后续来源参考图里的文字/u);
  assert.match(prompt, /配件与禁止内容也只能观察第一张待检查结果/u);
  assert.match(prompt, /第一张没有独立配件物体/u);
  assert.match(prompt, /只有明确表现为包装内含、随商品交付或配件清单/u);
  const context = JSON.parse(prompt.slice(prompt.indexOf("{")));
  assert.deepEqual(context, {
    orderedSourceAssetIds: ["asset-a"],
    facts: [fact],
  });
});

test("V6 missing dimension lines are a non-blocking presentation warning while false numbers stay hard", async () => {
  const presentation = await input(checkerValue(
    { quality: "FAIL" },
    { qualityFlags: ["DIMENSION_ANNOTATION_MISSING"] },
  ), {
    templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
    claimEvidenceFactIds: [fact.factId],
    dimensionAnnotationsRequired: true,
  });
  const warning = await checkGeneratedAsset(presentation);
  assert.equal(warning.accepted, false);
  assert.equal(warning.code, "DIMENSION_ANNOTATION_MISSING");
  assert.equal(warning.severity, "SOFT");

  const falseNumber = await input(checkerValue({}, {
    claims: [{ ...verifiedClaim, text: "Высота 99 см", value: "99 cm", numericValue: 99 }],
    detectedTexts: ["Высота 99 см"],
  }), {
    templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
    claimEvidenceFactIds: [fact.factId],
  });
  const hard = await checkGeneratedAsset(falseNumber);
  assert.equal(hard.code, "UNVERIFIED_CLAIM");
  assert.equal(hard.severity, "HARD");
});

test("V6 checker claim evidence can cite only facts selected by the current slot", async () => {
  const selected = {
    factId: "fact.identity.name", field: "identity.primaryName", kind: "IDENTITY_NAME",
    value: "Фонарь ручной", numericValue: null, unit: null, sourcePath: "identity.primaryName",
  };
  const equivalent = {
    factId: "fact.attribute.product-type", field: "attributes[0].values[0]", kind: "ATTRIBUTE:product-type",
    value: "Фонарь ручной", numericValue: null, unit: null, sourcePath: "attributes[0].values[0]",
  };
  const claim = {
    text: selected.value, sourceFactId: selected.factId, field: selected.field,
    value: selected.value, numericValue: null, unit: null,
  };
  const request = await input(checkerValue({}, { claims: [claim], detectedTexts: [claim.text] }));
  request.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  request.facts = [selected, equivalent];
  request.claimEvidenceFactIds = [selected.factId];
  let checkerSchema;
  request.gateway.inspectImage = async ({ jsonSchema }) => {
    checkerSchema = jsonSchema;
    return {
      requestId: "check-1",
      modelEvidence: {
        requestedTextModel: "checker-a",
        gatewayReportedTextModel: "checker-a",
        gatewayReportedTextModelPresent: true,
      },
      value: checkerValue({}, { claims: [claim], detectedTexts: [claim.text] }),
    };
  };

  assert.equal((await checkGeneratedAsset(request)).accepted, true);
  assert.deepEqual(
    checkerSchema.properties.evidence.properties.claims.items.properties.sourceFactId.enum,
    [selected.factId],
  );
});

test("V6 normalizes redundant inferred claim projection to the selected frozen fact", async () => {
  const selected = {
    factId: "fact.attribute.modes", field: "attributes[5].values[0]#dictionaryValueId=41834", kind: "ATTRIBUTE:modes",
    value: "Кол-во режимов: 1", numericValue: null, unit: null,
    sourcePath: "attributes[5].values[0]#dictionaryValueId=41834",
  };
  const inferred = {
    text: selected.value, sourceFactId: selected.factId, field: "attributes[5].values[0]",
    value: selected.value, numericValue: 1, unit: null,
  };
  const request = await input(checkerValue({}, { claims: [inferred], detectedTexts: [inferred.text] }), {
    templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
    facts: [selected],
    claimEvidenceFactIds: [selected.factId],
  });

  const result = await checkGeneratedAsset(request);

  assert.equal(result.accepted, true);
  assert.deepEqual(result.evidence.checkerResult.evidence.claims, [{
    ...inferred,
    field: selected.field,
    numericValue: null,
    unit: null,
  }]);
});

test("V6 cannot replace a missing planned claim citation with an equivalent unselected identity fact", async () => {
  const selected = {
    factId: "fact.attribute.product-type", field: "attributes[0].values[0]", kind: "ATTRIBUTE:product-type",
    value: "Фонарь ручной", numericValue: null, unit: null, sourcePath: "attributes[0].values[0]",
  };
  const unselectedIdentity = {
    factId: "fact.identity.name", field: "identity.primaryName", kind: "IDENTITY_NAME",
    value: "Фонарь ручной", numericValue: null, unit: null, sourcePath: "identity.primaryName",
  };
  const response = checkerValue(
    { claimsVerified: false },
    { claims: [], detectedTexts: [selected.value] },
  );
  const request = await input(response, {
    templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
    facts: [selected, unselectedIdentity],
    claimEvidenceFactIds: [selected.factId],
  });

  assert.equal((await checkGeneratedAsset(request)).code, "UNVERIFIED_CLAIM");
});

test("checker accepts the same extractive identity wording already accepted by the frozen content plan", async () => {
  const identityFact = {
    factId: "fact.identity.name",
    field: "variants.name",
    kind: "IDENTITY_NAME",
    value: "Терморегулятор, термостат до 3500Вт Для теплого пола, белый матовый",
    numericValue: null,
    unit: null,
    sourcePath: "variants.name",
  };
  const claim = {
    text: "Терморегулятор до 3500 Вт",
    sourceFactId: identityFact.factId,
    field: identityFact.field,
    value: identityFact.value,
    numericValue: null,
    unit: null,
  };
  const request = await input(checkerValue({}, { claims: [claim], detectedTexts: [claim.text] }));
  request.facts = [identityFact];
  const result = await checkGeneratedAsset(request);
  assert.equal(result.accepted, true, JSON.stringify(result));
});

test("identity claim may expose numeric metadata already present in the exact identity text", async () => {
  const identityFact = {
    factId: "fact.identity.name",
    field: "variants.name",
    kind: "IDENTITY_NAME",
    value: "Терморегулятор, термостат до 3500Вт Для теплого пола, серый",
    numericValue: null,
    unit: null,
    sourcePath: "variants.name",
  };
  const claim = {
    text: "Термостат до 3500 Вт для теплого пола",
    sourceFactId: identityFact.factId,
    field: identityFact.field,
    value: identityFact.value,
    numericValue: 3500,
    unit: "Вт",
  };
  const request = await input(checkerValue({}, { claims: [claim], detectedTexts: [claim.text] }));
  request.facts = [identityFact];
  request.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";

  const result = await checkGeneratedAsset(request);
  assert.equal(result.accepted, true, JSON.stringify(result));
});

test("V3 identity claim may cite an extractive value instead of duplicating the full identity fact", async () => {
  const identityFact = {
    factId: "fact.identity.name",
    field: "variants.name",
    kind: "IDENTITY_NAME",
    value: "Терморегулятор, термостат до 3500Вт Для теплого пола, кремовый",
    numericValue: null,
    unit: null,
    sourcePath: "variants.name",
  };
  const claim = {
    text: "кремовый",
    sourceFactId: identityFact.factId,
    field: identityFact.field,
    value: "кремовый",
    numericValue: null,
    unit: null,
  };
  const request = await input(checkerValue({}, { claims: [claim], detectedTexts: [claim.text] }));
  request.facts = [identityFact];
  request.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";

  const result = await checkGeneratedAsset(request);
  assert.equal(result.accepted, true, JSON.stringify(result));
});

test("V3 accepts an extractive audit value when the rendered non-identity claim still contains the complete fact", async () => {
  const attributeFact = {
    factId: "fact.attribute.type",
    field: "attributes[0].values[0]#dictionaryValueId=115946631",
    kind: "ATTRIBUTE:type",
    value: "Тип: Фонарь ручной",
    numericValue: null,
    unit: null,
    sourcePath: "attributes[0].values[0]#dictionaryValueId=115946631",
  };
  const claim = {
    text: attributeFact.value,
    sourceFactId: attributeFact.factId,
    field: attributeFact.field,
    value: "Фонарь ручной",
    numericValue: null,
    unit: null,
  };
  const request = await input(checkerValue(
    { claimsVerified: false },
    { claims: [claim], detectedTexts: [claim.text] },
  ));
  request.facts = [attributeFact];
  request.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";

  assert.equal((await checkGeneratedAsset(request)).accepted, true);
});

test("auditable source-bound claims override a contradictory claimsVerified false", async () => {
  const identityFact = {
    factId: "fact.identity.name",
    field: "variants.name",
    kind: "IDENTITY_NAME",
    value: "Терморегулятор, термостат до 3500Вт Для теплого пола, кремовый",
    numericValue: null,
    unit: null,
    sourcePath: "variants.name",
  };
  const claims = ["Терморегулятор", "Для теплого пола", "кремовый"].map((text) => ({
    text,
    sourceFactId: identityFact.factId,
    field: identityFact.field,
    value: identityFact.value,
    numericValue: null,
    unit: null,
  }));
  const request = await input(checkerValue(
    { claimsVerified: false },
    { claims, detectedTexts: ["Терморегулятор для теплого пола, кремовый"] },
  ));
  request.facts = [identityFact];
  request.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";

  const result = await checkGeneratedAsset(request);
  assert.equal(result.accepted, true, JSON.stringify(result));

  const incomplete = await input(checkerValue(
    { claimsVerified: false },
    { claims: claims.slice(0, 1), detectedTexts: ["Умный терморегулятор для теплого пола, кремовый"] },
  ));
  incomplete.facts = [identityFact];
  incomplete.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";
  assert.equal((await checkGeneratedAsset(incomplete)).code, "UNVERIFIED_CLAIM");
});

test("V3 does not combine a number from one fact with the unit and label from another fact", async () => {
  const power = {
    factId: "fact.power",
    field: "attributes.power",
    kind: "ATTRIBUTE",
    value: "3500 Вт",
    numericValue: 3500,
    unit: "Вт",
    sourcePath: "attributes.power",
  };
  const weight = {
    factId: "fact.weight",
    field: "attributes.weight",
    kind: "ATTRIBUTE",
    value: "1 кг",
    numericValue: 1,
    unit: "кг",
    sourcePath: "attributes.weight",
  };
  const claims = [
    { text: "Мощность 3500 Вт", sourceFactId: power.factId, field: power.field, value: power.value, numericValue: 3500, unit: "Вт" },
    { text: "Вес 1 кг", sourceFactId: weight.factId, field: weight.field, value: weight.value, numericValue: 1, unit: "кг" },
  ];
  const request = await input(checkerValue(
    { claimsVerified: false },
    { claims, detectedTexts: ["Вес 3500 кг"] },
  ));
  request.facts = [power, weight];
  request.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";

  assert.equal((await checkGeneratedAsset(request)).code, "UNVERIFIED_CLAIM");
});

test("V3 accepts detected identity text that is directly extractive even when the model omits duplicate claims", async () => {
  const identityFact = {
    factId: "fact.identity.name",
    field: "variants.name",
    kind: "IDENTITY_NAME",
    value: "Терморегулятор, термостат до 3500Вт Для теплого пола, кремовый",
    numericValue: null,
    unit: null,
    sourcePath: "variants.name",
  };
  const request = await input(checkerValue(
    { claimsVerified: false },
    { claims: [], detectedTexts: ["Термостат для теплого пола, кремовый"] },
  ));
  request.facts = [identityFact];
  request.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";

  const result = await checkGeneratedAsset(request);
  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.deepEqual(result.evidence.sourceFactIds, [identityFact.factId]);

  const invented = await input(checkerValue(
    { claimsVerified: false },
    { claims: [], detectedTexts: ["Умный термостат для теплого пола, кремовый"] },
  ));
  invented.facts = [identityFact];
  invented.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";
  assert.equal((await checkGeneratedAsset(invented)).code, "UNVERIFIED_CLAIM");
});

test("product body identity evidence overrides contradictory top-level success", async () => {
  for (const field of ["color", "shape"]) {
    const identity = { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"], [field]: false };
    const result = await checkGeneratedAsset(await input(checkerValue({}, { identity })));
    assert.equal(result.code, "PRODUCT_IDENTITY_MISMATCH", field);
  }
});

test("omitting optional kit accessories from one image is not a product identity mismatch", async () => {
  const identity = { color: true, shape: true, accessoryCount: false, sourceAssetIds: ["asset-a"] };
  const result = await checkGeneratedAsset(await input(checkerValue({}, { identity })));
  assert.equal(result.accepted, true);
});

test("explanatory pass reasons do not override all authoritative checker gates", async () => {
  const result = await checkGeneratedAsset(await input(checkerValue({
    reasons: ["主体、事实、俄语、质量和禁止内容检查均通过。"],
  })));
  assert.equal(result.accepted, true);
});

test("a schema-valid Chinese checker explanation is not rejected by its UTF-8 byte length", async () => {
  const explanation = "该图片中的商品主体与来源参考保持一致，颜色、形状和配件数量均可对应；俄语文案只引用了已提供的商品事实，画面清晰且未出现禁止内容。".repeat(2);
  assert.ok(explanation.length <= 240);
  assert.ok(Buffer.byteLength(explanation, "utf8") > 240);
  const result = await checkGeneratedAsset(await input(checkerValue({ reasons: [explanation] })));
  assert.equal(result.accepted, true);
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

test("V5 role-compliance quality flags reject structurally wrong images", async () => {
  for (const qualityFlag of ["ROLE_MISMATCH", "DETAIL_NOT_CLOSEUP", "DIMENSION_ANNOTATION_MISSING"]) {
    const result = await checkGeneratedAsset(await input(checkerValue(
      { quality: "FAIL" },
      { qualityFlags: [qualityFlag] },
    )));
    assert.equal(result.code, "IMAGE_QUALITY_FAILED", qualityFlag);
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

test("Russian fixed copy permits a source-bound technical token without a hardcoded token list", async () => {
  const protectionFact = {
    factId: "fact.attribute.protection",
    field: "attributes.protection",
    kind: "ATTRIBUTE:protection",
    value: "Степень защиты от влаги и пыли: IP55",
    numericValue: null,
    unit: null,
    sourcePath: "attributes.protection",
  };
  const protectionClaim = {
    text: protectionFact.value,
    sourceFactId: protectionFact.factId,
    field: protectionFact.field,
    value: protectionFact.value,
    numericValue: null,
    unit: null,
  };
  const acceptedInput = await input(checkerValue(
    {},
    { claims: [protectionClaim], detectedTexts: [protectionClaim.text] },
  ));
  acceptedInput.facts = [protectionFact];
  acceptedInput.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V4";
  assert.equal((await checkGeneratedAsset(acceptedInput)).accepted, true);

  const inventedInput = await input(checkerValue(
    {},
    { claims: [protectionClaim], detectedTexts: [protectionClaim.text.replace("IP55", "IP56")] },
  ));
  inventedInput.facts = [protectionFact];
  inventedInput.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V4";
  assert.equal((await checkGeneratedAsset(inventedInput)).code, "LANGUAGE_MISMATCH");
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

test("fixed-copy checker accepts numeric metadata extracted from an exact labeled source fact", async () => {
  const labeledPowerFact = {
    factId: "fact.attribute.8145.0",
    field: "attributes[3].values[0]",
    kind: "ATTRIBUTE:power",
    value: "Мощность, Вт: 80",
    numericValue: null,
    unit: null,
    sourcePath: "attributes[3].values[0]",
  };
  const powerClaim = {
    text: labeledPowerFact.value,
    sourceFactId: labeledPowerFact.factId,
    field: labeledPowerFact.field,
    value: labeledPowerFact.value,
    numericValue: 80,
    unit: "Вт",
  };
  const exactInput = await input(checkerValue(
    { claimsVerified: true },
    { claims: [powerClaim], detectedTexts: [powerClaim.text] },
  ));
  exactInput.facts = [labeledPowerFact];
  exactInput.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V4";
  assert.equal((await checkGeneratedAsset(exactInput)).accepted, true);

  for (const mutation of [
    { numericValue: 800 },
    { unit: "кг" },
    { value: "Мощность, Вт: 800", text: "Мощность, Вт: 800", numericValue: 800 },
  ]) {
    const invalidInput = await input(checkerValue(
      { claimsVerified: true },
      { claims: [{ ...powerClaim, ...mutation }], detectedTexts: [{ ...powerClaim, ...mutation }.text] },
    ));
    invalidInput.facts = [labeledPowerFact];
    invalidInput.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V4";
    assert.equal((await checkGeneratedAsset(invalidInput)).code, "UNVERIFIED_CLAIM", JSON.stringify(mutation));
  }
});

test("fixed-copy checker accepts an extractive numeric audit value when rendered copy stays exact", async () => {
  const quantityFact = {
    factId: "fact.attribute.22315.0",
    field: "attributes[8].values[0]",
    kind: "ATTRIBUTE:quantity",
    value: "Кол-во светодиодов: 20",
    numericValue: null,
    unit: null,
    sourcePath: "attributes[8].values[0]",
  };
  const quantityClaim = {
    text: quantityFact.value,
    sourceFactId: quantityFact.factId,
    field: quantityFact.field,
    value: "20",
    numericValue: 20,
    unit: null,
  };
  const exactInput = await input(checkerValue(
    { claimsVerified: true },
    { claims: [quantityClaim], detectedTexts: [quantityClaim.text] },
  ));
  exactInput.facts = [quantityFact];
  exactInput.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V4";
  assert.equal((await checkGeneratedAsset(exactInput)).accepted, true);

  const wrongQuantity = await input(checkerValue(
    { claimsVerified: true },
    { claims: [{ ...quantityClaim, value: "200", numericValue: 200 }], detectedTexts: [quantityClaim.text] },
  ));
  wrongQuantity.facts = [quantityFact];
  wrongQuantity.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V4";
  assert.equal((await checkGeneratedAsset(wrongQuantity)).code, "UNVERIFIED_CLAIM");
});

test("claim text cannot hide extra numeric units or unrelated nonnumeric copy behind bound fields", async () => {
  const numeric = await checkGeneratedAsset(await input(checkerValue({}, { claims: [{ ...verifiedClaim, text: "Вес 999kg, высота 1 cm" }] })));
  assert.equal(numeric.code, "UNVERIFIED_CLAIM");
  const inventedMarketingInput = await input(checkerValue(
    { claimsVerified: false },
    { claims: [{ ...verifiedClaim, text: "Лучший товар высота 1 см" }], detectedTexts: ["Лучший товар высота 1 см"] },
  ));
  inventedMarketingInput.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";
  const inventedMarketing = await checkGeneratedAsset(inventedMarketingInput);
  assert.equal(inventedMarketing.code, "UNVERIFIED_CLAIM");
  for (const text of [
    "Высота не 1 см", "Высота без 1 см", "Высота до 1 см", "Высота от 1 см",
    "Высота < 1 см", "Высота ≠ 1 см", "Высота ≈ 1 см", "Высота − 1 см",
    "Высота ≉ 1 см", "Высота ≲ 1 см", "Высота ∼ 1 см",
  ]) {
    const changedMeaningInput = await input(checkerValue(
      { claimsVerified: false },
      { claims: [{ ...verifiedClaim, text }], detectedTexts: [text] },
    ));
    changedMeaningInput.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";
    assert.equal((await checkGeneratedAsset(changedMeaningInput)).code, "UNVERIFIED_CLAIM", text);
  }
  for (const detectedText of ["Высота < 1 см", "Высота ≠ 1 см", "Высота − 1 см"]) {
    const changedOcrInput = await input(checkerValue(
      { claimsVerified: false },
      { claims: [verifiedClaim], detectedTexts: [detectedText] },
    ));
    changedOcrInput.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";
    assert.equal((await checkGeneratedAsset(changedOcrInput)).code, "UNVERIFIED_CLAIM", detectedText);
  }
  const identityFactWithNumber = {
    factId: "fact.identity.numbered-name",
    field: "variants.name",
    kind: "IDENTITY_NAME",
    value: "Товар высота 1 см",
    numericValue: null,
    unit: null,
    sourcePath: "variants.name",
  };
  const changedIdentityOcrInput = await input(checkerValue(
    { claimsVerified: false },
    { claims: [], detectedTexts: ["Товар высота ≠ 1 см"] },
  ));
  changedIdentityOcrInput.facts = [identityFactWithNumber];
  changedIdentityOcrInput.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";
  assert.equal((await checkGeneratedAsset(changedIdentityOcrInput)).code, "UNVERIFIED_CLAIM");
  for (const [factValue, detectedText] of [
    ["Товар мощность 3500 Вт вес 1 кг", "Товар 3500 кг"],
    ["Устройство без подогрева", "Устройство подогрева"],
    ["Устройство мощность 100 Вт и более", "Устройство мощность 100 Вт"],
    ["Товар вес 1 кг и менее", "Товар вес 1 кг"],
  ]) {
    const sourceFact = {
      ...identityFactWithNumber,
      factId: `fact.identity.${detectedText}`,
      value: factValue,
    };
    const changedIdentityMeaningInput = await input(checkerValue(
      { claimsVerified: false },
      { claims: [], detectedTexts: [detectedText] },
    ));
    changedIdentityMeaningInput.facts = [sourceFact];
    changedIdentityMeaningInput.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";
    assert.equal((await checkGeneratedAsset(changedIdentityMeaningInput)).code, "UNVERIFIED_CLAIM", detectedText);
  }
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
  const identityNameFact = {
    factId: "fact.identity.name", field: "identity.primaryName", kind: "IDENTITY_NAME",
    value: "MQOUO Шкаф складной туристический", numericValue: null, unit: null,
    sourcePath: "identity.primaryName",
  };
  const nativeIdentityInput = await input(checkerValue({}, {
    claims: [], detectedTexts: [identityNameFact.value],
  }));
  nativeIdentityInput.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";
  nativeIdentityInput.facts = [identityNameFact];
  assert.equal((await checkGeneratedAsset(nativeIdentityInput)).accepted, true);
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

test("V3 empty-copy policy rejects even fact-bound editable marketing text", async () => {
  const forbidden = await checkGeneratedAsset(await input(checkerValue(), {
    templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V3",
    textRequired: false,
    textForbidden: true,
  }));
  assert.equal(forbidden.code, "UNVERIFIED_CLAIM");

  const noText = checkerValue(
    { russianText: false },
    { claims: [], detectedTexts: [], language: "other" },
  );
  const accepted = await checkGeneratedAsset(await input(noText, {
    templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V3",
    textRequired: false,
    textForbidden: true,
  }));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.evidence.textForbidden, true);
});

test("V6 empty-copy slot accepts zero auditable claims when the model returns claimsVerified false", async () => {
  const noText = checkerValue(
    { claimsVerified: false, russianText: false },
    { claims: [], detectedTexts: [], language: "other" },
  );

  const result = await checkGeneratedAsset(await input(noText, {
    templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
    textRequired: false,
    textForbidden: true,
    claimEvidenceFactIds: [],
  }));

  assert.equal(result.accepted, true);
  assert.equal(result.evidence.textForbidden, true);
  assert.deepEqual(result.evidence.sourceFactIds, []);
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
    checkerValue({ matchesProduct: false, reasons: ["я".repeat(241)] }),
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
  assert.doesNotMatch(JSON.stringify(checkerSchema), /"uniqueItems"/u);
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
    await assert.rejects(checkGeneratedAsset(await input(value)), (error) => error?.code === "CHECKER_EVIDENCE_INVALID" && error?.retryable === true);
  }
});

test("top-level policy failures remain deterministic non-retryable rejections", async () => {
  const cases = [
    [checkerValue({ matchesProduct: false }), "PRODUCT_IDENTITY_MISMATCH"],
    [checkerValue({ russianText: false }), "LANGUAGE_MISMATCH"],
    [checkerValue({ quality: "FAIL" }), "IMAGE_QUALITY_FAILED"],
    [checkerValue({ prohibitedContent: true }), "PROHIBITED_CONTENT"],
  ];
  for (const [value, code] of cases) {
    const result = await checkGeneratedAsset(await input(value));
    assert.deepEqual({ accepted: result.accepted, code: result.code, retryable: result.retryable }, { accepted: false, code, retryable: false });
  }
});

test("V6 classifies factual and safety failures as hard while presentation failures remain soft", () => {
  const cases = [
    [checkerValue({ matchesProduct: false }), "PRODUCT_IDENTITY_MISMATCH", "HARD"],
    [checkerValue({ claimsVerified: false }, { claims: [] }), "UNVERIFIED_CLAIM", "HARD"],
    [checkerValue({ russianText: false }), "LANGUAGE_MISMATCH", "HARD"],
    [checkerValue({ prohibitedContent: true }), "PROHIBITED_CONTENT", "HARD"],
    [checkerValue({ quality: "FAIL" }, { qualityFlags: ["BLUR"] }), "IMAGE_QUALITY_FAILED", "HARD"],
    [checkerValue({ quality: "FAIL" }, { qualityFlags: ["DIMENSION_ANNOTATION_MISSING"] }), "DIMENSION_ANNOTATION_MISSING", "SOFT"],
    [checkerValue({ quality: "FAIL" }, { qualityFlags: ["ROLE_MISMATCH"] }), "ROLE_MISMATCH", "SOFT"],
    [checkerValue({ quality: "FAIL" }, { qualityFlags: ["DETAIL_NOT_CLOSEUP"] }), "DETAIL_NOT_CLOSEUP", "SOFT"],
    [checkerValue({ quality: "FAIL" }, { qualityFlags: ["SUBJECT_NOT_DOMINANT"] }), "SUBJECT_NOT_DOMINANT", "SOFT"],
    [checkerValue({ quality: "FAIL" }, { qualityFlags: ["LABEL_OVERLAP"] }), "LABEL_OVERLAP", "SOFT"],
    [checkerValue({ quality: "FAIL" }, { qualityFlags: ["LABEL_READABILITY_LOW"] }), "LABEL_READABILITY_LOW", "SOFT"],
  ];

  for (const [value, code, severity] of cases) {
    const result = checkerModule.evaluateGeneratedCheckerEvidence(evaluatorInput(value, {
      templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
      claimEvidenceFactIds: [fact.factId],
      dimensionAnnotationsRequired: true,
    }));
    assert.equal(result.accepted, false, code);
    assert.equal(result.code, code);
    assert.equal(result.severity, severity);
  }
});

test("V6 product documentary without trusted dimensions ignores a spurious missing-dimension flag", () => {
  const result = checkerModule.evaluateGeneratedCheckerEvidence(evaluatorInput(checkerValue({
    quality: "FAIL",
  }, {
    qualityFlags: ["DIMENSION_ANNOTATION_MISSING"],
  }), {
    templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
    claimEvidenceFactIds: [fact.factId],
    dimensionAnnotationsRequired: false,
  }));

  assert.equal(result.accepted, true);
  assert.equal(Object.hasOwn(result, "code"), false);
});

test("a hard checker condition wins when the same response also contains a soft presentation issue", () => {
  const result = checkerModule.evaluateGeneratedCheckerEvidence(evaluatorInput(checkerValue({
    prohibitedContent: true,
    quality: "FAIL",
  }, {
    qualityFlags: ["ROLE_MISMATCH"],
    prohibitedFlags: ["EXTERNAL_PROMOTION"],
  }), {
    templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
    claimEvidenceFactIds: [fact.factId],
  }));

  assert.equal(result.code, "PROHIBITED_CONTENT");
  assert.equal(result.severity, "HARD");
});

test("malformed checker output is an operationally distinguishable retryable failure", async () => {
  await assert.rejects(checkGeneratedAsset(await input({ matchesProduct: true })), (error) => error?.code === "CHECKER_EVIDENCE_INVALID" && error?.retryable === true);
});

test("propagates a malformed gateway response without an inline paid inspection retry", async () => {
  const request = await input(checkerValue());
  let calls = 0;
  const gatewayError = Object.assign(new Error("malformed structured response"), {
    code: "INVALID_GATEWAY_RESPONSE",
    requestId: "checker-invalid-1",
    failureField: "/evidence/claims/0/unit",
  });
  request.gateway.inspectImage = async () => {
    calls += 1;
    throw gatewayError;
  };

  await assert.rejects(checkGeneratedAsset(request), (error) => error === gatewayError);
  assert.equal(calls, 1);
});

test("repairs one locally inconsistent evidence result and then accepts the corrected result", async () => {
  const request = await input(checkerValue());
  let calls = 0;
  request.gateway.inspectImage = async () => {
    calls += 1;
    return {
      requestId: `checker-evidence-${calls}`,
      modelEvidence: {
        requestedTextModel: "checker-a",
        gatewayReportedTextModel: "checker-a",
        gatewayReportedTextModelPresent: true,
      },
      value: calls === 1
        ? checkerValue({}, { identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["foreign"] } })
        : checkerValue(),
    };
  };

  assert.equal((await checkGeneratedAsset(request)).accepted, true);
  assert.equal(calls, 2);
});

test("two inconsistent evidence results retain the exact safe contract field", async () => {
  const request = await input(checkerValue());
  let calls = 0;
  request.gateway.inspectImage = async () => {
    calls += 1;
    return {
      requestId: `checker-evidence-${calls}`,
      modelEvidence: {
        requestedTextModel: "checker-a",
        gatewayReportedTextModel: "checker-a",
        gatewayReportedTextModelPresent: true,
      },
      value: checkerValue({}, {
        identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["foreign"] },
      }),
    };
  };

  await assert.rejects(checkGeneratedAsset(request), (error) => {
    assert.equal(error?.code, "CHECKER_EVIDENCE_INVALID");
    assert.equal(error?.requestId, "checker-evidence-2");
    assert.equal(error?.checkerEvidence?.detailCode, "SOURCE_ASSET_IDS_MISMATCH");
    assert.equal(error?.checkerEvidence?.failureField, "/evidence/identity/sourceAssetIds");
    assert.deepEqual(error?.checkerEvidence?.requestIds, ["checker-evidence-1", "checker-evidence-2"]);
    assert.equal(error?.checkerEvidence?.callCount, 2);
    return true;
  });
});

test("preserves a safe non-retryable gateway rejection for worker classification", async () => {
  const request = await input(checkerValue());
  let calls = 0;
  const gatewayError = Object.assign(new Error("gateway rejected request"), {
    code: "NON_RETRYABLE_GATEWAY", status: 404, requestId: "checker-model-missing",
  });
  request.gateway.inspectImage = async () => {
    calls += 1;
    throw gatewayError;
  };

  await assert.rejects(checkGeneratedAsset(request), (error) => error === gatewayError);
  assert.equal(calls, 1);
});

test("does not impose an application deadline or rewrite a failed inspection", async () => {
  const request = await input(checkerValue());
  const timeouts = [];
  const gatewayError = Object.assign(new Error("checker timed out"), { code: "GATEWAY_TIMEOUT", retryable: true });
  request.gateway.inspectImage = async (gatewayRequest) => {
    timeouts.push(Object.hasOwn(gatewayRequest, "timeoutMs"));
    throw gatewayError;
  };

  await assert.rejects(checkGeneratedAsset(request), (error) => error === gatewayError);
  assert.deepEqual(timeouts, [false]);
});

test("does not rewrite or automatically retry non-timeout checker failures", async () => {
  const request = await input(checkerValue());
  let calls = 0;
  const gatewayError = Object.assign(new Error("gateway rejected request"), { code: "NON_RETRYABLE_GATEWAY" });
  request.gateway.inspectImage = async () => {
    calls += 1;
    throw gatewayError;
  };

  await assert.rejects(checkGeneratedAsset(request), (error) => error === gatewayError);
  assert.equal(calls, 1);
});

test("still bounds an unknown coded checker exception instead of persisting its private code", async () => {
  const request = await input(checkerValue());
  request.gateway.inspectImage = async () => {
    throw Object.assign(new Error("private upstream detail"), { code: "PRIVATE_GATEWAY_SECRET" });
  };

  await assert.rejects(checkGeneratedAsset(request), checkerUnavailable);
});

test("checker lease loss after provider return prevents evidence handling and a repair call", async () => {
  const request = await input(checkerValue());
  const stale = Object.assign(new Error("stale execution"), {
    code: "AUTO_LISTING_AI_EXECUTION_LEASE_LOST", retryable: false,
  });
  let active = true;
  let calls = 0;
  request.assertLeaseActive = () => { if (!active) throw stale; };
  const inspect = request.gateway.inspectImage;
  request.gateway.inspectImage = async (gatewayRequest) => {
    calls += 1;
    const response = await inspect(gatewayRequest);
    active = false;
    return response;
  };

  await assert.rejects(checkGeneratedAsset(request), (error) => error === stale);
  assert.equal(calls, 1);
});

test("checker provider rejection rechecks the lease before classifying the failure", async () => {
  const request = await input(checkerValue());
  const stale = Object.assign(new Error("stale execution"), {
    code: "AUTO_LISTING_AI_EXECUTION_LEASE_LOST", retryable: false,
  });
  const providerFailure = Object.assign(new Error("provider rejected"), {
    code: "NON_RETRYABLE_AUTH", status: 403, retryable: false,
  });
  let active = true;
  request.assertLeaseActive = () => { if (!active) throw stale; };
  request.gateway.inspectImage = async () => {
    active = false;
    throw providerFailure;
  };

  await assert.rejects(checkGeneratedAsset(request), (error) => error === stale);
});
