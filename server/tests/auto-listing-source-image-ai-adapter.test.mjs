import assert from "node:assert/strict";
import test from "node:test";

import { SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION } from "../auto-listing-source-image-intelligence-contract.mjs";
import { createSourceImageAnalysisAiAdapter } from "../auto-listing-source-image-ai-adapter.mjs";
import { createSub2ApiAdapter } from "../sub2api-ai-adapter.mjs";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const profile = Object.freeze({
  id: "profile-a", accountId: "account-a", configVersion: 3, textModel: "vision-model-a",
  connectionId: "connection-a", connectionVersion: 4,
});
const gatewayExecution = Object.freeze({
  channelId: "channel-a", connectionId: "connection-a", connectionVersion: 4, idleTimeoutMs: 300_000,
});
const requestIdentity = Object.freeze({
  correlationId: "source-image:job-a:item-a:batch-a", requestKey: "a".repeat(64),
});
const request = () => ({
  contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
  sourceFacts: { title: "Термокружка", brand: "Brand" },
  images: [{ sourceAssetId: "asset-a", sourceOrdinal: 0, contentType: "image/png", bytes: Buffer.from("stored") }],
});

test("maps the exact safe DTO to the existing multimodal gateway and returns its structured value", async () => {
  const calls = [];
  const expected = { observations: [] };
  const adapter = createSourceImageAnalysisAiAdapter({
    gateway: { async createTextResponse(input) { calls.push(input); return { value: expected }; } },
    profile, gatewayExecution, requestIdentity,
  });
  assert.equal(await adapter.analyzeSourceImages(request()), expected);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].sourceImages, [{ bytes: Buffer.from("stored"), contentType: "image/png" }]);
  assert.equal(calls[0].profile, profile);
  assert.equal(calls[0].model, profile.textModel);
  assert.equal(calls[0].correlationId, requestIdentity.correlationId);
  assert.equal(calls[0].requestKey, requestIdentity.requestKey);
  assert.equal(calls[0].idleTimeoutMs, 300_000);
  assert.equal(calls[0].jsonSchema.additionalProperties, false);
  assert.equal(
    calls[0].jsonSchema.properties.observations.items.properties.reasonCodes.items.pattern,
    "^[A-Z0-9][A-Z0-9_:-]{0,119}$",
  );
  assert.equal(
    calls[0].jsonSchema.properties.observations.items.properties.subjectBounds.properties.width.exclusiveMinimum,
    0,
  );
  assert.match(calls[0].prompt, /uppercase machine reason codes/iu);
  assert.match(calls[0].prompt, /x \+ width.*y \+ height.*at most 1/iu);
  assert.match(calls[0].prompt, /certification symbols? (?:are|is) only visual markings/iu);
  assert.match(calls[0].prompt, /text-only images? (?:do|does) not prove product appearance/iu);
  assert.match(calls[0].prompt, /visible placement and perspective/iu);
  assert.match(calls[0].prompt, /viewpoint classification.*not.*text density/iu);
  assert.match(calls[0].prompt, /complete defining housing.*attached cable ends.*(?:never|must not).*DETAIL/iu);
  assert.match(calls[0].prompt, /DETAIL only when.*crop omits.*outer product boundar/iu);
  assert.doesNotMatch(calls[0].prompt, /stored|objectKey|connection-a|credential|api.?key/iu);
});

test("V2 requests classify every visible text region for all six images in the current analysis batch", async () => {
  const calls = [];
  const images = Array.from({ length: 6 }, (_, index) => ({
    sourceAssetId: `asset-${index + 1}`,
    sourceOrdinal: index,
    contentType: "image/png",
    bytes: Buffer.from(`stored-${index + 1}`),
  }));
  const expected = { observations: images.map(({ sourceAssetId }) => ({
    sourceAssetId,
    contentKinds: ["MIXED"],
    viewpoints: [],
    subjectBounds: null,
    quality: null,
    ocrRegions: [],
    semanticTextRegions: [],
    markings: [],
    perceptualDuplicateGroup: null,
    eligibleUses: ["TEXT_FACT"],
    reasonCodes: [],
  })) };
  const wireExpected = { observations: expected.observations.map(({ ocrRegions, semanticTextRegions, markings, ...rest }) => ({
    ...rest,
    textRegions: [],
    graphicalMarkings: [],
  })) };
  const adapter = createSourceImageAnalysisAiAdapter({
    gateway: { async createTextResponse(input) { calls.push(input); return { value: wireExpected }; } },
    profile, gatewayExecution, requestIdentity,
  });

  assert.deepEqual(await adapter.analyzeSourceImages({
    ...request(),
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
    images,
  }), expected);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceImages.length, 6);
  assert.deepEqual(calls[0].sourceImages.map(({ bytes }) => bytes.toString()),
    images.map(({ bytes }) => bytes.toString()));
  const observation = calls[0].jsonSchema.properties.observations.items;
  assert.ok(observation.required.includes("textRegions"));
  assert.ok(observation.required.includes("graphicalMarkings"));
  assert.deepEqual(observation.properties.textRegions.items.properties.semanticKind.enum, [
    "SELLING_POINT", "USAGE", "USAGE_STEP", "SPECIFICATION", "PACKAGE_CONTENT", "CAUTION",
    "PRODUCT_IDENTITY", "EXTERNAL_OVERLAY", "PROMOTION", "CONTACT", "OTHER",
  ]);
  assert.match(calls[0].prompt, /every visible text region/iu);
  assert.match(calls[0].prompt, /before.*(?:clean|remov)/iu);
  assert.match(calls[0].prompt, /product-native.*(?:logo|model|nameplate)/iu);
  assert.match(calls[0].prompt, /numeric rating.*PRODUCT_MARKING/iu);
  assert.match(calls[0].prompt, /textRegions entry.*bind OCR text.*semantic meaning/iu);
  assert.match(calls[0].prompt,
    /subjectBounds.*entire visible physical product.*(?:handles|cables|attached parts)/iu);
  assert.match(calls[0].prompt,
    /width and height.*spans.*(?:never|not).*(?:right|bottom).*coordinates/iu);
  assert.match(calls[0].prompt,
    /confirmed PRODUCT_MARKING.*center.*inside.*subjectBounds/iu);
  assert.match(calls[0].prompt,
    /21CM.*23CM.*13CM.*EXTERNAL_OVERLAY/iu);
  assert.match(calls[0].prompt,
    /reason codes.*match.*text type/iu);
});

test("V2 wire output binds OCR semantics and marking classification in one text-region entry", async () => {
  const calls = [];
  const textRegion = {
    sourceText: "Скидка 20%",
    language: "ru",
    region: { x: 0.08, y: 0.03, width: 0.4, height: 0.1 },
    confidence: "CONFIRMED",
    semanticKind: "PROMOTION",
    normalizedMeaning: "Скидка 20%",
    sequence: null,
    semanticReasonCodes: ["PROMOTIONAL_TEXT"],
    markingKind: "EXTERNAL_OVERLAY",
    markingConfidence: "CONFIRMED",
    markingReasonCodes: ["CANVAS_PROMOTION"],
  };
  const wireValue = { observations: [{
    sourceAssetId: "asset-a",
    contentKinds: ["MIXED"],
    viewpoints: [{
      kind: "FRONT", confidence: "CONFIRMED", reasonCodes: [], completeProductVisible: true,
    }],
    subjectBounds: { x: 0.2, y: 0.2, width: 0.6, height: 0.7 },
    quality: { confidence: "CONFIRMED", usable: true, reasonCodes: [] },
    textRegions: [textRegion],
    graphicalMarkings: [],
    perceptualDuplicateGroup: null,
    eligibleUses: ["TARGET_VIEW", "TEXT_FACT"],
    reasonCodes: [],
  }] };
  const adapter = createSourceImageAnalysisAiAdapter({
    gateway: { async createTextResponse(input) { calls.push(input); return { value: wireValue }; } },
    profile, gatewayExecution, requestIdentity,
  });

  const output = await adapter.analyzeSourceImages({
    ...request(),
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  assert.deepEqual(output.observations[0].ocrRegions, [{
    text: textRegion.sourceText,
    region: textRegion.region,
    language: textRegion.language,
    confidence: textRegion.confidence,
  }]);
  assert.deepEqual(output.observations[0].semanticTextRegions, [{
    sourceText: textRegion.sourceText,
    language: textRegion.language,
    region: textRegion.region,
    confidence: textRegion.confidence,
    semanticKind: textRegion.semanticKind,
    normalizedMeaning: textRegion.normalizedMeaning,
    sequence: textRegion.sequence,
    reasonCodes: textRegion.semanticReasonCodes,
  }]);
  assert.deepEqual(output.observations[0].markings, [{
    kind: textRegion.markingKind,
    region: textRegion.region,
    confidence: textRegion.markingConfidence,
    reasonCodes: textRegion.markingReasonCodes,
  }]);
  assert.deepEqual(output.observations[0].viewpoints, [{
    kind: "FRONT", confidence: "CONFIRMED", reasonCodes: ["COMPLETE_PRODUCT_VISIBLE"],
  }]);
  const observationSchema = calls[0].jsonSchema.properties.observations.items;
  assert.ok(observationSchema.required.includes("textRegions"));
  assert.ok(observationSchema.required.includes("graphicalMarkings"));
  assert.equal(Object.hasOwn(observationSchema.properties, "ocrRegions"), false);
  assert.equal(Object.hasOwn(observationSchema.properties, "semanticTextRegions"), false);
  assert.equal(Object.hasOwn(observationSchema.properties, "markings"), false);
  assert.ok(observationSchema.properties.viewpoints.items.required.includes("completeProductVisible"));
  assert.match(calls[0].prompt, /completeProductVisible.*complete defining silhouette.*major components/iu);
  assert.match(calls[0].prompt,
    /completeProductVisible=true.*whole product instance.*not cropped.*(?:image boundary|inset)/iu);
  assert.match(calls[0].prompt,
    /normal (?:perspective|camera-angle) (?:occlusion|self-occlusion).*(?:must not|does not).*completeProductVisible=false/iu);
});

test("V2 normalizes multiline OCR text at the AI boundary without losing its words or semantics", async () => {
  const wireValue = { observations: [{
    sourceAssetId: "asset-a",
    contentKinds: ["MIXED"],
    viewpoints: [{
      kind: "DETAIL", confidence: "CONFIRMED", reasonCodes: ["CROPPED_PRODUCT"], completeProductVisible: false,
    }],
    subjectBounds: { x: 0.2, y: 0.4, width: 0.6, height: 0.5 },
    quality: { confidence: "CONFIRMED", usable: true, reasonCodes: ["TEXT_DENSE"] },
    textRegions: [{
      sourceText: "Характеристики:\nРазмер: 160 × 115 × 45 мм\tЦвет: серый",
      language: "ru",
      region: { x: 0.1, y: 0.1, width: 0.7, height: 0.2 },
      confidence: "CONFIRMED",
      semanticKind: "SPECIFICATION",
      normalizedMeaning: "Размер: 160 × 115 × 45 мм\nЦвет: серый",
      sequence: null,
      semanticReasonCodes: ["SPECIFICATION"],
      markingKind: "EXTERNAL_OVERLAY",
      markingConfidence: "CONFIRMED",
      markingReasonCodes: ["CANVAS_TEXT"],
    }],
    graphicalMarkings: [],
    perceptualDuplicateGroup: null,
    eligibleUses: ["TEXT_FACT"],
    reasonCodes: ["TEXT_DENSE"],
  }] };
  const adapter = createSourceImageAnalysisAiAdapter({
    gateway: { async createTextResponse() { return { value: wireValue }; } },
    profile, gatewayExecution, requestIdentity,
  });

  const output = await adapter.analyzeSourceImages({
    ...request(),
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  const expectedSourceText = "Характеристики: Размер: 160 × 115 × 45 мм Цвет: серый";
  assert.equal(output.observations[0].ocrRegions[0].text, expectedSourceText);
  assert.equal(output.observations[0].semanticTextRegions[0].sourceText, expectedSourceText);
  assert.equal(output.observations[0].semanticTextRegions[0].normalizedMeaning,
    "Размер: 160 × 115 × 45 мм Цвет: серый");
  assert.deepEqual(output.observations[0].markings[0].region,
    output.observations[0].ocrRegions[0].region);
});

test("V2 demotes a directional crop to DETAIL instead of counting it as a complete product angle", async () => {
  const wireValue = { observations: [{
    sourceAssetId: "asset-a",
    contentKinds: ["PRODUCT_VIEW", "PRODUCT_DETAIL"],
    viewpoints: [{
      kind: "TOP",
      confidence: "CONFIRMED",
      reasonCodes: ["VISIBLE_TOP_FACE"],
      completeProductVisible: false,
    }],
    subjectBounds: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
    quality: { confidence: "CONFIRMED", usable: true, reasonCodes: [] },
    textRegions: [],
    graphicalMarkings: [],
    perceptualDuplicateGroup: null,
    eligibleUses: ["TARGET_VIEW", "DETAIL"],
    reasonCodes: [],
  }] };
  const adapter = createSourceImageAnalysisAiAdapter({
    gateway: { async createTextResponse() { return { value: wireValue }; } },
    profile, gatewayExecution, requestIdentity,
  });

  const output = await adapter.analyzeSourceImages({
    ...request(),
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  assert.deepEqual(output.observations[0].viewpoints, [{
    kind: "DETAIL",
    confidence: "CONFIRMED",
    reasonCodes: ["VISIBLE_TOP_FACE", "PARTIAL_PRODUCT_ONLY"],
  }]);
  assert.equal(Object.hasOwn(output.observations[0].viewpoints[0], "completeProductVisible"), false);
});

test("V2 keeps overlay bounds local and aligns OCR markings one-for-one", async () => {
  const calls = [];
  const expected = { observations: [{
    sourceAssetId: "asset-a", contentKinds: ["MIXED"], viewpoints: [], subjectBounds: null,
    quality: null, ocrRegions: [], semanticTextRegions: [], markings: [],
    perceptualDuplicateGroup: null, eligibleUses: ["TEXT_FACT"], reasonCodes: [],
  }] };
  const adapter = createSourceImageAnalysisAiAdapter({
    gateway: { async createTextResponse(input) { calls.push(input); return { value: expected }; } },
    profile, gatewayExecution, requestIdentity,
  });

  await adapter.analyzeSourceImages({
    ...request(),
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  assert.match(calls[0].prompt,
    /textRegions entry.*bind OCR text.*semantic meaning.*(?:PRODUCT_MARKING|EXTERNAL_OVERLAY)/iu);
  assert.match(calls[0].prompt,
    /EXTERNAL_OVERLAY.*tight.*actual visible overlay.*(?:never|do not).*unrelated.*(?:background|product)/iu);
  assert.match(calls[0].prompt,
    /graphicalMarkings.*only.*non-text.*(?:seller logo|watermark)/iu);
  assert.doesNotMatch(calls[0].prompt, /complete visible (?:overlay|badge|container)/iu);
});

test("source-image structured output composes with the Sub2API Responses adapter", async () => {
  const expected = { observations: [{
    sourceAssetId: "asset-a", contentKinds: ["PRODUCT_VIEW"], viewpoints: [],
    subjectBounds: null, quality: null, ocrRegions: [], markings: [],
    perceptualDuplicateGroup: null, eligibleUses: ["IDENTITY_ANCHOR"], reasonCodes: [],
  }] };
  const sub2apiProfile = Object.freeze({
    ...profile,
    baseUrl: "https://gateway.example.test/v1",
    apiKeyEnvName: "SUB2API_TEST_KEY",
    textProtocol: "SUB2API_RESPONSES",
    imageProtocol: "SUB2API_RESPONSES_IMAGE_TOOL",
    imageModel: "image-model-a",
    connectionId: null,
    connectionVersion: null,
    enabled: true,
  });
  const requests = [];
  const gateway = createSub2ApiAdapter({
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({
        id: "response-source-image-a",
        model: sub2apiProfile.textModel,
        output_text: JSON.stringify(expected),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    readSecret: () => "test-secret",
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  });
  const adapter = createSourceImageAnalysisAiAdapter({
    gateway,
    profile: sub2apiProfile,
    gatewayExecution: null,
    requestIdentity,
  });

  const result = await adapter.analyzeSourceImages({
    ...request(),
    images: [{ ...request().images[0], bytes: PNG_1X1 }],
  });

  assert.deepEqual(result, expected);
  assert.deepEqual(requests, ["https://gateway.example.test/v1/responses"]);
});

test("null-connection legacy profile uses createTextResponse with the fixed idle timeout", async () => {
  const calls = [];
  const legacyProfile = Object.freeze({ ...profile, connectionId: null, connectionVersion: null });
  const expected = { observations: [] };
  const adapter = createSourceImageAnalysisAiAdapter({
    gateway: { async createTextResponse(input) { calls.push(input); return { value: expected }; } },
    profile: legacyProfile, gatewayExecution: null, requestIdentity,
  });
  assert.equal(await adapter.analyzeSourceImages(request()), expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profile, legacyProfile);
  assert.equal(calls[0].idleTimeoutMs, 300_000);
});

test("adapter rejects crossing null legacy and connection-backed execution evidence", () => {
  const legacyProfile = Object.freeze({ ...profile, connectionId: null, connectionVersion: null });
  const gateway = { async createTextResponse() {} };
  assert.throws(() => createSourceImageAnalysisAiAdapter({
    gateway, profile, gatewayExecution: null, requestIdentity,
  }), { code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_ADAPTER_INVALID" });
  assert.throws(() => createSourceImageAnalysisAiAdapter({
    gateway, profile: legacyProfile, gatewayExecution, requestIdentity,
  }), { code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_ADAPTER_INVALID" });
});

test("rejects extra request fields, raw URLs, object keys, credentials, and mismatched connection evidence before gateway work", async () => {
  for (const invalidRequest of [
    { ...request(), objectKey: "private/key" },
    { ...request(), sourceFacts: { rawUrl: "https://source.invalid/private?token=x" } },
    { ...request(), images: [{ ...request().images[0], objectKey: "private/key" }] },
    { ...request(), images: [{ ...request().images[0], credential: "secret" }] },
  ]) {
    let calls = 0;
    const adapter = createSourceImageAnalysisAiAdapter({
      gateway: { async createTextResponse() { calls += 1; } }, profile, gatewayExecution, requestIdentity,
    });
    await assert.rejects(adapter.analyzeSourceImages(invalidRequest), {
      code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_ADAPTER_INVALID",
    });
    assert.equal(calls, 0);
  }
  assert.throws(() => createSourceImageAnalysisAiAdapter({
    gateway: { async createTextResponse() {} }, profile,
    gatewayExecution: { ...gatewayExecution, connectionVersion: 5 }, requestIdentity,
  }), { code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_ADAPTER_INVALID" });
});

test("does not mutate or promote confidence in a structured gateway response", async () => {
  const value = { observations: [{
    sourceAssetId: "asset-a", contentKinds: ["PRODUCT_VIEW"],
    viewpoints: [{ kind: "FRONT", confidence: "UNCERTAIN", reasonCodes: ["LOW_LIGHT"] }],
    subjectBounds: null, quality: { confidence: "TENTATIVE", usable: false, reasonCodes: ["LOW_LIGHT"] },
    ocrRegions: [], markings: [{ kind: "UNCERTAIN_MARKING", region: null,
      confidence: "UNCERTAIN", reasonCodes: ["PERSPECTIVE_UNCLEAR"] }],
    perceptualDuplicateGroup: null, eligibleUses: ["UNUSABLE"], reasonCodes: ["LOW_LIGHT"],
  }] };
  const adapter = createSourceImageAnalysisAiAdapter({
    gateway: { async createTextResponse() { return { value }; } }, profile, gatewayExecution, requestIdentity,
  });
  const output = await adapter.analyzeSourceImages(request());
  assert.equal(output.observations[0].viewpoints[0].confidence, "UNCERTAIN");
  assert.equal(output.observations[0].markings[0].confidence, "UNCERTAIN");
});
