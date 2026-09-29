import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
} from "../auto-listing-source-image-intelligence-contract.mjs";
import {
  analyzeSourceImageBatch,
  buildSourceImageAnalysisBatches,
} from "../auto-listing-source-image-analyzer.mjs";

const compare = (left, right) => Buffer.from(String(left), "utf8").compare(Buffer.from(String(right), "utf8"));
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" && !Buffer.isBuffer(value)
    ? Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonical(value[key])]))
    : value;
const hash = (value) => crypto.createHash("sha256").update(
  Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value)),
).digest("hex");

const scope = Object.freeze({
  accountId: "account-a", jobId: "job-a", itemId: "item-a", expectedStatusVersion: 7,
});
const run = Object.freeze({
  id: "analysis-run-a", accountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId,
  expectedStatusVersion: scope.expectedStatusVersion,
  contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
  inputHash: "1".repeat(64), profileId: "profile-a", profileVersion: 3, modelName: "vision-model-a",
});
const profile = Object.freeze({
  id: run.profileId, accountId: scope.accountId, configVersion: run.profileVersion,
  textModel: run.modelName, connectionId: "connection-a", connectionVersion: 4,
});
const gatewayExecution = Object.freeze({
  channelId: "channel-a", connectionId: "connection-a", connectionVersion: 4, idleTimeoutMs: 300_000,
});

function materialized(sourceAssetId, bytes, sourceOrdinal) {
  return {
    sourceAssetId, sourceOrdinal, sizeBytes: bytes.length, contentHash: hash(bytes),
    objectKey: `auto-listing/source/v2/account-a/job-a/item-a/analysis-run/analysis-run-a/${sourceAssetId}/object.png`,
    contentType: "image/png",
  };
}

function observation(sourceAssetId, overrides = {}) {
  return {
    sourceAssetId,
    contentKinds: ["PRODUCT_VIEW"],
    viewpoints: [{ kind: "FRONT", confidence: "TENTATIVE", reasonCodes: ["VISIBLE_FRONT"] }],
    subjectBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    quality: { confidence: "TENTATIVE", usable: true, reasonCodes: [] },
    ocrRegions: [],
    markings: [{ kind: "PRODUCT_MARKING", region: { x: 0.2, y: 0.2, width: 0.2, height: 0.1 },
      confidence: "UNCERTAIN", reasonCodes: ["SURFACE_PERSPECTIVE_UNCERTAIN"] }],
    perceptualDuplicateGroup: null,
    eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW"],
    reasonCodes: [],
    ...overrides,
  };
}

function makeHarness({ assets, observations, gateway: gatewayOverride, persisted = [], batchIndex = 0 } = {}) {
  const materializedAssets = assets || [materialized("asset-a", Buffer.from("image-a"), 0)];
  const batch = buildSourceImageAnalysisBatches({ materializedAssets, terminalAssessments: [] })[batchIndex];
  const calls = { gateway: [], load: [], persist: [], lease: [] };
  const records = [...persisted];
  const gateway = gatewayOverride || {
    async analyzeSourceImages(input) {
      calls.gateway.push(input);
      return { observations: observations || materializedAssets.map((asset) => observation(asset.sourceAssetId)) };
    },
  };
  const bytesByAsset = new Map(materializedAssets.map((asset) => [asset.sourceAssetId,
    Buffer.from(asset.sourceAssetId === "asset-a" ? "image-a" : `image-${asset.sourceAssetId}`)]));
  for (const asset of materializedAssets) {
    const candidate = bytesByAsset.get(asset.sourceAssetId);
    if (hash(candidate) !== asset.contentHash) {
      bytesByAsset.set(asset.sourceAssetId, Buffer.from(asset.sourceAssetId.includes("duplicate") ? "same" : asset.sourceAssetId));
    }
  }
  const repository = {
    async listRunAssessments(input) { assert.deepEqual(input, { ...scope, analysisRunId: run.id }); return records; },
    async recordBatchAssessments(input) {
      calls.persist.push(input);
      for (const assessment of input.assessments) records.push({
        ...scope, analysisRunId: run.id, analysisBatchId: input.analysisBatchId,
        inputHash: input.inputHash, resultHash: assessment.assessmentHash,
        sourceAssetId: assessment.sourceAssetId, sourceOrdinal: assessment.sourceOrdinal,
        terminalStatus: assessment.terminalStatus, assessment,
      });
      return { status: "ACCEPTED", analysisBatchId: input.analysisBatchId,
        inputHash: input.inputHash, resultHash: input.resultHash, assessmentCount: input.assessments.length };
    },
  };
  const sourceAssetLoader = {
    async loadSourceAsset(input) {
      calls.load.push(input);
      const asset = input.materializedAsset;
      return { bytes: Buffer.from(bytesByAsset.get(asset.sourceAssetId)), contentType: asset.contentType };
    },
  };
  return {
    input: {
      scope, run, batch, repository, sourceAssetLoader, gateway, profile, gatewayExecution,
      assertLeaseActive() { calls.lease.push(`lease-${calls.lease.length + 1}`); },
    },
    calls, records, materializedAssets,
  };
}

test("keeps paid source-analysis batches within two images while retaining all thirteen assets", () => {
  const materializedAssets = Array.from({ length: 13 }, (_, index) => materialized(
    `asset-${index + 1}`, Buffer.from(`image-${index + 1}`), index,
  ));
  const batches = buildSourceImageAnalysisBatches({ materializedAssets, terminalAssessments: [{
    ...scope, analysisRunId: run.id, sourceAssetId: "asset-terminal", sourceOrdinal: null,
    terminalStatus: "DOWNLOAD_FAILED", analysisBatchId: null, inputHash: null,
    resultHash: "2".repeat(64), assessment: null, errorCode: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED",
    createdAt: "2026-08-30T00:00:00.000Z",
  }] });
  assert.deepEqual(batches.map((entry) => entry.assets.length), [2, 2, 2, 2, 2, 2, 1]);
  assert.deepEqual(batches.flatMap((entry) => entry.assets.map(({ sourceAssetId }) => sourceAssetId)),
    materializedAssets.map(({ sourceAssetId }) => sourceAssetId));
  assert.equal(batches.flatMap((entry) => entry.assets).some(({ sourceAssetId }) => sourceAssetId === "asset-terminal"), false);
});

test("V2 persists one classified semantic region for every OCR region", async () => {
  const ocrRegion = {
    text: "Подключите кабель к клеммам",
    region: { x: 0.1, y: 0.7, width: 0.7, height: 0.08 },
    language: "ru",
    confidence: "CONFIRMED",
  };
  const semanticRegion = {
    sourceText: ocrRegion.text,
    language: "ru",
    region: ocrRegion.region,
    confidence: "CONFIRMED",
    semanticKind: "USAGE_STEP",
    normalizedMeaning: "Подключить кабель к клеммам",
    sequence: 1,
    reasonCodes: [],
  };
  const harness = makeHarness({ observations: [observation("asset-a", {
    ocrRegions: [ocrRegion],
    semanticTextRegions: [semanticRegion],
  })] });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  const output = await analyzeSourceImageBatch(harness.input);

  assert.equal(output.assessments[0].contractVersion, "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2");
  assert.equal(output.assessments[0].semanticTextRegions.length, 1);
  assert.equal(output.assessments[0].semanticTextRegions[0].sourceText, semanticRegion.sourceText);
  assert.equal(output.assessments[0].semanticTextRegions[0].semanticKind, semanticRegion.semanticKind);
  assert.equal(output.assessments[0].semanticTextRegions[0].normalizedMeaning, semanticRegion.normalizedMeaning);
  assert.equal(output.assessments[0].semanticTextRegions[0].sequence, 1);
  assert.deepEqual({ ...output.assessments[0].semanticTextRegions[0].region }, semanticRegion.region);
  assert.equal(Object.isFrozen(output.assessments[0].semanticTextRegions[0]), true);
});

test("V2 accepts text-dense source images whose OCR response contains line breaks", async () => {
  const wireValue = { observations: [{
    sourceAssetId: "asset-a",
    contentKinds: ["MIXED"],
    viewpoints: [{
      kind: "DETAIL", confidence: "CONFIRMED", reasonCodes: ["CROPPED_PRODUCT"], completeProductVisible: false,
    }],
    subjectBounds: { x: 0.2, y: 0.4, width: 0.6, height: 0.5 },
    quality: { confidence: "CONFIRMED", usable: true, reasonCodes: ["TEXT_DENSE"] },
    textRegions: [{
      sourceText: "Характеристики:\nРазмер: 160 × 115 × 45 мм\nЦвет: серый",
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
  const harness = makeHarness({
    gateway: { async createTextResponse() { return { value: wireValue }; } },
  });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  const output = await analyzeSourceImageBatch(harness.input);

  assert.equal(output.status, "ACCEPTED");
  assert.equal(output.assessments[0].ocrRegions[0].text,
    "Характеристики: Размер: 160 × 115 × 45 мм Цвет: серый");
  assert.equal(output.assessments[0].semanticTextRegions[0].normalizedMeaning,
    "Размер: 160 × 115 × 45 мм Цвет: серый");
});

test("V2 accepts a usable collage plus a scene-only image from a real two-image analysis batch", async () => {
  const insetProductMarking = {
    sourceText: "MODEL 12345",
    normalizedMeaning: "MODEL 12345",
    language: "en",
    confidence: "CONFIRMED",
    semanticKind: "SPECIFICATION",
    sequence: null,
    semanticReasonCodes: ["RATING_LABEL"],
    markingKind: "PRODUCT_MARKING",
    markingConfidence: "CONFIRMED",
    markingReasonCodes: ["TEXT_ON_PRODUCT"],
    // The marking belongs to a secondary product close-up below the primary collage subject.
    region: { x: 0.531, y: 0.755, width: 0.06, height: 0.015 },
  };
  const assets = [
    materialized("asset-a", Buffer.from("image-a"), 0),
    materialized("asset-b", Buffer.from("image-asset-b"), 1),
  ];
  const wireValue = { observations: [
    {
      sourceAssetId: "asset-a",
      contentKinds: ["MIXED"],
      viewpoints: [
        { kind: "FRONT", confidence: "CONFIRMED", reasonCodes: ["PRIMARY_PRODUCT_VISIBLE"] },
        { kind: "DETAIL", confidence: "CONFIRMED", reasonCodes: ["INSET_PORT_CLOSEUP"] },
        { kind: "PACKAGE", confidence: "CONFIRMED", reasonCodes: ["ACCESSORY_COMPONENT_SHOWN"] },
      ],
      subjectBounds: { x: 0.039, y: 0.209, width: 0.863, height: 0.472 },
      quality: { confidence: "CONFIRMED", usable: true, reasonCodes: ["COLLAGE_LAYOUT"] },
      textRegions: [insetProductMarking],
      graphicalMarkings: [],
      perceptualDuplicateGroup: null,
      eligibleUses: ["TARGET_VIEW", "DETAIL", "TEXT_FACT"],
      reasonCodes: ["COLLAGE_LAYOUT", "MULTIPLE_VIEWS", "PROMOTIONAL_TEXT"],
    },
    {
      sourceAssetId: "asset-b",
      contentKinds: ["MIXED"],
      viewpoints: [{ kind: "SCENE", confidence: "CONFIRMED", reasonCodes: ["LIFESTYLE_USE_CONTEXT"] }],
      subjectBounds: null,
      quality: { confidence: "CONFIRMED", usable: true, reasonCodes: ["COLLAGE_LAYOUT"] },
      textRegions: [],
      graphicalMarkings: [],
      perceptualDuplicateGroup: null,
      eligibleUses: ["SCENE", "TEXT_FACT"],
      reasonCodes: ["COLLAGE_LAYOUT", "LIFESTYLE_SCENES", "PROMOTIONAL_TEXT"],
    },
  ] };
  const harness = makeHarness({
    assets,
    gateway: { async createTextResponse() { return { value: wireValue }; } },
  });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  const output = await analyzeSourceImageBatch(harness.input);

  assert.equal(output.assessments.length, 2);
  assert.deepEqual(output.assessments[0].eligibleUses, ["TARGET_VIEW", "DETAIL", "TEXT_FACT"]);
  assert.equal(output.assessments[0].markings[0].kind, "PRODUCT_MARKING");
  assert.deepEqual(output.assessments[1].eligibleUses, ["SCENE", "TEXT_FACT"]);
});

test("V2 limits text marking bounds to the matching OCR region while preserving graphical markings", async () => {
  const ocrRegion = {
    text: "38 CM",
    region: { x: 0.1, y: 0.7, width: 0.14, height: 0.06 },
    language: "ru",
    confidence: "CONFIRMED",
  };
  const broadTextMarking = {
    kind: "EXTERNAL_OVERLAY",
    region: { x: 0.05, y: 0.2, width: 0.75, height: 0.65 },
    confidence: "CONFIRMED",
    reasonCodes: ["SELLER_DIMENSION_TEXT"],
  };
  const graphicalMarking = {
    kind: "EXTERNAL_OVERLAY",
    region: { x: 0.82, y: 0.08, width: 0.08, height: 0.06 },
    confidence: "TENTATIVE",
    reasonCodes: ["SELLER_BADGE"],
  };
  const harness = makeHarness({ observations: [observation("asset-a", {
    ocrRegions: [ocrRegion],
    semanticTextRegions: [{
      sourceText: ocrRegion.text,
      language: ocrRegion.language,
      region: ocrRegion.region,
      confidence: ocrRegion.confidence,
      semanticKind: "SPECIFICATION",
      normalizedMeaning: "38 см",
      sequence: null,
      reasonCodes: [],
    }],
    markings: [broadTextMarking, graphicalMarking],
  })] });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  const output = await analyzeSourceImageBatch(harness.input);

  assert.deepEqual({ ...output.assessments[0].markings[0].region }, ocrRegion.region);
  assert.equal(output.assessments[0].markings[0].kind, broadTextMarking.kind);
  assert.equal(output.assessments[0].markings[0].confidence, broadTextMarking.confidence);
  assert.deepEqual(output.assessments[0].markings[0].reasonCodes, broadTextMarking.reasonCodes);
  assert.deepEqual({ ...output.assessments[0].markings[1].region }, graphicalMarking.region);
});

test("V2 rejects an observation that omits the marking classification for OCR text", async () => {
  const ocrRegion = {
    text: "seller.example",
    region: { x: 0.02, y: 0.02, width: 0.16, height: 0.04 },
    language: "en",
    confidence: "CONFIRMED",
  };
  const harness = makeHarness({ observations: [observation("asset-a", {
    ocrRegions: [ocrRegion],
    semanticTextRegions: [{
      sourceText: ocrRegion.text,
      language: ocrRegion.language,
      region: ocrRegion.region,
      confidence: ocrRegion.confidence,
      semanticKind: "EXTERNAL_OVERLAY",
      normalizedMeaning: "seller.example",
      sequence: null,
      reasonCodes: [],
    }],
    markings: [],
  })] });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  await assert.rejects(analyzeSourceImageBatch(harness.input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_RESULT_INVALID",
  });
});

test("V2 rejects a confirmed product marking whose OCR center is outside the physical product bounds", async () => {
  const ocrRegion = {
    text: "21CM",
    region: { x: 0.054, y: 0.543, width: 0.169, height: 0.102 },
    language: "en",
    confidence: "CONFIRMED",
  };
  const harness = makeHarness({ observations: [observation("asset-a", {
    subjectBounds: { x: 0.257, y: 0.137, width: 0.439, height: 0.547 },
    ocrRegions: [ocrRegion],
    semanticTextRegions: [{
      sourceText: ocrRegion.text,
      language: ocrRegion.language,
      region: ocrRegion.region,
      confidence: ocrRegion.confidence,
      semanticKind: "SPECIFICATION",
      normalizedMeaning: "21 cm",
      sequence: null,
      reasonCodes: [],
    }],
    markings: [{
      kind: "PRODUCT_MARKING",
      region: ocrRegion.region,
      confidence: "CONFIRMED",
      reasonCodes: ["PRODUCT_TEXT"],
    }],
  })] });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  await assert.rejects(analyzeSourceImageBatch(harness.input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_RESULT_INVALID",
    retryable: true,
  });
});

test("V2 rejects a confirmed dimension overlay classification for non-numeric product identity text", async () => {
  const ocrRegion = {
    text: "PUNCH BABY DELICIOUS",
    region: { x: 0.364, y: 0.676, width: 0.118, height: 0.134 },
    language: "en",
    confidence: "CONFIRMED",
  };
  const harness = makeHarness({ observations: [observation("asset-a", {
    subjectBounds: { x: 0.257, y: 0.137, width: 0.439, height: 0.547 },
    ocrRegions: [ocrRegion],
    semanticTextRegions: [{
      sourceText: ocrRegion.text,
      language: ocrRegion.language,
      region: ocrRegion.region,
      confidence: ocrRegion.confidence,
      semanticKind: "PRODUCT_IDENTITY",
      normalizedMeaning: "PUNCH BABY DELICIOUS",
      sequence: null,
      reasonCodes: [],
    }],
    markings: [{
      kind: "EXTERNAL_OVERLAY",
      region: ocrRegion.region,
      confidence: "CONFIRMED",
      reasonCodes: ["DIMENSION_TEXT"],
    }],
  })] });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  await assert.rejects(analyzeSourceImageBatch(harness.input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_RESULT_INVALID",
    retryable: true,
  });
});

test("V2 accepts an external dimension label even when its center overlaps the rectangular product bounds", async () => {
  const ocrRegion = {
    text: "38CM",
    region: { x: 0.347, y: 0.466, width: 0.058, height: 0.072 },
    language: "en",
    confidence: "CONFIRMED",
  };
  const harness = makeHarness({ observations: [observation("asset-a", {
    subjectBounds: { x: 0.307, y: 0.3, width: 0.632, height: 0.53 },
    ocrRegions: [ocrRegion],
    semanticTextRegions: [{
      sourceText: ocrRegion.text,
      language: ocrRegion.language,
      region: ocrRegion.region,
      confidence: ocrRegion.confidence,
      semanticKind: "SPECIFICATION",
      normalizedMeaning: "Height 38 cm",
      sequence: null,
      reasonCodes: [],
    }],
    markings: [{
      kind: "EXTERNAL_OVERLAY",
      region: ocrRegion.region,
      confidence: "CONFIRMED",
      reasonCodes: ["DIMENSION_OVERLAY"],
    }],
  })] });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  const output = await analyzeSourceImageBatch(harness.input);

  assert.equal(output.assessments[0].markings[0].kind, "EXTERNAL_OVERLAY");
  assert.deepEqual({ ...output.assessments[0].markings[0].region }, ocrRegion.region);
});

test("V2 accepts confirmed product identity text printed within the physical product bounds", async () => {
  const ocrRegion = {
    text: "LUNCH BAG DELICIOUS",
    region: { x: 0.505, y: 0.784, width: 0.182, height: 0.074 },
    language: "en",
    confidence: "CONFIRMED",
  };
  const harness = makeHarness({ observations: [observation("asset-a", {
    subjectBounds: { x: 0.165, y: 0.168, width: 0.675, height: 0.737 },
    ocrRegions: [ocrRegion],
    semanticTextRegions: [{
      sourceText: ocrRegion.text,
      language: ocrRegion.language,
      region: ocrRegion.region,
      confidence: ocrRegion.confidence,
      semanticKind: "PRODUCT_IDENTITY",
      normalizedMeaning: "LUNCH BAG DELICIOUS",
      sequence: null,
      reasonCodes: [],
    }],
    markings: [{
      kind: "PRODUCT_MARKING",
      region: ocrRegion.region,
      confidence: "CONFIRMED",
      reasonCodes: ["PRINTED_ON_PRODUCT"],
    }],
  })] });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  const output = await analyzeSourceImageBatch(harness.input);

  assert.equal(output.assessments[0].markings[0].kind, "PRODUCT_MARKING");
  assert.equal(output.assessments[0].semanticTextRegions[0].semanticKind, "PRODUCT_IDENTITY");
});

test("V2 repairs contradictory usable mixed-product eligibility from the confirmed visible viewpoint", async () => {
  const harness = makeHarness({ observations: [observation("asset-a", {
    contentKinds: ["TEXT_ONLY", "MIXED"],
    viewpoints: [{ kind: "DETAIL", confidence: "CONFIRMED", reasonCodes: ["CROP_OMITS_FULL_PRODUCT_BOUNDARIES"] }],
    subjectBounds: { x: 0.498, y: 0.284, width: 0.357, height: 0.588 },
    quality: { confidence: "CONFIRMED", usable: true, reasonCodes: [] },
    ocrRegions: [],
    semanticTextRegions: [],
    markings: [],
    eligibleUses: ["TEXT_FACT", "UNUSABLE"],
    reasonCodes: ["TEXT_DOMINANT"],
  })] });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  const output = await analyzeSourceImageBatch(harness.input);

  assert.deepEqual(output.assessments[0].eligibleUses, ["TEXT_FACT", "DETAIL"]);
  assert.equal(output.assessments[0].quality.usable, true);
  assert.equal(output.assessments[0].contentKinds.includes("MIXED"), true);
});

test("V2 normalizes the model's common 0-1000 integer bounds before persisting evidence", async () => {
  const gridRegion = { x: 100, y: 700, width: 700, height: 80 };
  const ocrRegion = {
    text: "Подключите кабель к клеммам",
    region: gridRegion,
    language: "ru",
    confidence: "CONFIRMED",
  };
  const harness = makeHarness({ observations: [observation("asset-a", {
    subjectBounds: { x: 100, y: 100, width: 800, height: 800 },
    ocrRegions: [ocrRegion],
    semanticTextRegions: [{
      sourceText: ocrRegion.text,
      language: "ru",
      region: gridRegion,
      confidence: "CONFIRMED",
      semanticKind: "USAGE_STEP",
      normalizedMeaning: "Подключить кабель к клеммам",
      sequence: 1,
      reasonCodes: [],
    }],
    markings: [{
      kind: "PRODUCT_MARKING",
      region: { x: 200, y: 200, width: 200, height: 100 },
      confidence: "UNCERTAIN",
      reasonCodes: ["SURFACE_PERSPECTIVE_UNCERTAIN"],
    }],
  })] });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  const output = await analyzeSourceImageBatch(harness.input);

  assert.deepEqual({ ...output.assessments[0].subjectBounds }, {
    x: 0.1, y: 0.1, width: 0.8, height: 0.8,
  });
  assert.deepEqual({ ...output.assessments[0].ocrRegions[0].region }, {
    x: 0.1, y: 0.7, width: 0.7, height: 0.08,
  });
  assert.deepEqual({ ...output.assessments[0].semanticTextRegions[0].region },
    { ...output.assessments[0].ocrRegions[0].region });
  assert.deepEqual({ ...output.assessments[0].markings[0].region },
    { ...output.assessments[0].ocrRegions[0].region });
});

test("V2 repairs normalized right-bottom endpoints only when size geometry would overflow", async () => {
  const endpointRegion = { x: 0.2, y: 0.3, width: 0.9, height: 0.8 };
  const ocrRegion = {
    text: "Технические характеристики",
    region: endpointRegion,
    language: "ru",
    confidence: "CONFIRMED",
  };
  const harness = makeHarness({ observations: [observation("asset-a", {
    subjectBounds: endpointRegion,
    ocrRegions: [ocrRegion],
    semanticTextRegions: [{
      sourceText: ocrRegion.text,
      language: "ru",
      region: endpointRegion,
      confidence: "CONFIRMED",
      semanticKind: "SPECIFICATION",
      normalizedMeaning: "Технические характеристики",
      sequence: null,
      reasonCodes: [],
    }],
    markings: [{
      kind: "EXTERNAL_OVERLAY",
      region: endpointRegion,
      confidence: "CONFIRMED",
      reasonCodes: ["SELLER_HEADLINE"],
    }],
  })] });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  const output = await analyzeSourceImageBatch(harness.input);

  assert.deepEqual({ ...output.assessments[0].subjectBounds }, {
    x: 0.2, y: 0.3, width: 0.7, height: 0.5,
  });
  assert.deepEqual({ ...output.assessments[0].ocrRegions[0].region }, {
    x: 0.2, y: 0.3, width: 0.7, height: 0.5,
  });
  assert.deepEqual({ ...output.assessments[0].semanticTextRegions[0].region },
    { ...output.assessments[0].ocrRegions[0].region });
  assert.deepEqual({ ...output.assessments[0].markings[0].region },
    { ...output.assessments[0].ocrRegions[0].region });
});

test("V2 clips a normalized size box at the image edge when it cannot be an endpoint box", async () => {
  const edgeRegion = { x: 0.78, y: 0.12, width: 0.3, height: 0.4 };
  const harness = makeHarness({ observations: [observation("asset-a", {
    subjectBounds: edgeRegion,
    ocrRegions: [],
    semanticTextRegions: [],
    markings: [],
  })] });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  const output = await analyzeSourceImageBatch(harness.input);

  assert.deepEqual({ ...output.assessments[0].subjectBounds }, {
    x: 0.78, y: 0.12, width: 0.22, height: 0.4,
  });
});

test("source-image analysis still rejects mixed-scale and out-of-grid bounds", async () => {
  const mixed = makeHarness({ observations: [observation("asset-a", {
    subjectBounds: { x: 0.1, y: 100, width: 800, height: 100 },
  })] });
  await assert.rejects(analyzeSourceImageBatch(mixed.input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_RESULT_INVALID",
  });

  const outside = makeHarness({ observations: [observation("asset-a", {
    subjectBounds: { x: 1001, y: 0, width: 1, height: 1 },
  })] });
  await assert.rejects(analyzeSourceImageBatch(outside.input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_RESULT_INVALID",
  });
});

test("V2 rejects semantic regions that do not classify OCR one-for-one", async () => {
  const harness = makeHarness({ observations: [observation("asset-a", {
    ocrRegions: [{
      text: "3 штуки",
      region: null,
      language: "ru",
      confidence: "CONFIRMED",
    }],
    semanticTextRegions: [],
  })] });
  harness.input.run = Object.freeze({
    ...run,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  });

  await assert.rejects(analyzeSourceImageBatch(harness.input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_RESULT_INVALID",
  });
});

test("exact content duplicates reuse one paid observation but retain one assessment per asset", async () => {
  const duplicateBytes = Buffer.from("same");
  const assets = [
    materialized("asset-a", duplicateBytes, 0),
    materialized("asset-duplicate", duplicateBytes, 1),
  ];
  const harness = makeHarness({ assets, observations: [observation("asset-a")] });
  harness.input.sourceAssetLoader.loadSourceAsset = async ({ materializedAsset }) => ({
    bytes: Buffer.from(duplicateBytes), contentType: materializedAsset.contentType,
  });
  const output = await analyzeSourceImageBatch(harness.input);
  assert.equal(harness.calls.gateway.length, 1);
  assert.deepEqual(harness.calls.gateway[0].images.map(({ sourceAssetId }) => sourceAssetId), ["asset-a"]);
  assert.deepEqual(output.assessments.map(({ sourceAssetId, terminalStatus }) => [sourceAssetId, terminalStatus]), [
    ["asset-a", "ANALYZED"], ["asset-duplicate", "DUPLICATE_REUSED"],
  ]);
  assert.equal(output.assessments[1].duplicateOfSourceAssetId, "asset-a");
  assert.notEqual(output.assessments[0].assessmentHash, output.assessments[1].assessmentHash);
  assert.equal(harness.calls.persist.length, 1);
  assert.equal(harness.calls.persist[0].assessments.length, 2);
});

test("an exact duplicate in a later batch reuses the accepted run observation without a second paid call", async () => {
  const assets = Array.from({ length: 3 }, (_, index) => materialized(
    `asset-${index + 1}`, Buffer.from(index === 2 ? "image-1" : `image-${index + 1}`), index,
  ));
  const first = makeHarness({
    assets,
    observations: assets.slice(0, 2).map(({ sourceAssetId }) => observation(sourceAssetId)),
  });
  first.input.sourceAssetLoader.loadSourceAsset = async (input) => {
    first.calls.load.push(input);
    return { bytes: Buffer.from(`image-${input.materializedAsset.sourceOrdinal + 1}`), contentType: "image/png" };
  };
  const acceptedFirst = await analyzeSourceImageBatch(first.input);
  assert.equal(first.calls.gateway.length, 1);

  const second = makeHarness({
    assets,
    batchIndex: 1,
    persisted: first.records.map((entry) => structuredClone(entry)),
    gateway: { async analyzeSourceImages() { throw new Error("exact duplicate must not be charged twice"); } },
  });
  second.input.sourceAssetLoader.loadSourceAsset = async (input) => {
    second.calls.load.push(input);
    return { bytes: Buffer.from("image-1"), contentType: "image/png" };
  };
  const acceptedSecond = await analyzeSourceImageBatch(second.input);
  assert.equal(second.calls.gateway.length, 0);
  assert.equal(second.calls.load.length, 0);
  assert.deepEqual(acceptedSecond.assessments.map(({ sourceAssetId, terminalStatus, duplicateOfSourceAssetId }) => ({
    sourceAssetId, terminalStatus, duplicateOfSourceAssetId,
  })), [{
    sourceAssetId: "asset-3", terminalStatus: "DUPLICATE_REUSED", duplicateOfSourceAssetId: "asset-1",
  }]);

  const changedHistory = first.records.map((entry) => structuredClone(entry));
  const changed = changedHistory.find(({ sourceAssetId }) => sourceAssetId === "asset-1");
  const { assessmentHash: ignoredHash, ...changedValue } = changed.assessment;
  changedValue.reasonCodes = ["HISTORIC_OBSERVATION_CHANGED"];
  changed.assessment = { ...changedValue, assessmentHash: hash(changedValue) };
  changed.resultHash = changed.assessment.assessmentHash;
  const changedSecond = makeHarness({
    assets,
    batchIndex: 1,
    persisted: changedHistory,
    gateway: { async analyzeSourceImages() { throw new Error("valid historical observation must be reused"); } },
  });
  changedSecond.input.sourceAssetLoader.loadSourceAsset = async (input) => {
    changedSecond.calls.load.push(input);
    return { bytes: Buffer.from("image-1"), contentType: "image/png" };
  };
  const changedAccepted = await analyzeSourceImageBatch(changedSecond.input);
  assert.notEqual(changedAccepted.inputHash, acceptedSecond.inputHash);
  assert.notEqual(changedAccepted.assessments[0].assessmentHash, acceptedSecond.assessments[0].assessmentHash);
  assert.equal(acceptedFirst.assessments[0].assessmentHash, ignoredHash);
});

test("invalid or conflicting historical rows never suppress a paid observation", async () => {
  const assets = Array.from({ length: 3 }, (_, index) => materialized(
    `asset-${index + 1}`, Buffer.from(index === 2 ? "image-1" : `image-${index + 1}`), index,
  ));
  const first = makeHarness({
    assets,
    observations: assets.slice(0, 2).map(({ sourceAssetId }) => observation(sourceAssetId)),
  });
  first.input.sourceAssetLoader.loadSourceAsset = async ({ materializedAsset }) => ({
    bytes: Buffer.from(`image-${materializedAsset.sourceOrdinal + 1}`), contentType: "image/png",
  });
  await analyzeSourceImageBatch(first.input);

  const invalidHash = first.records.map((entry) => structuredClone(entry));
  invalidHash.find(({ sourceAssetId }) => sourceAssetId === "asset-1").resultHash = "f".repeat(64);

  const conflicting = first.records.map((entry) => structuredClone(entry));
  const original = conflicting.find(({ sourceAssetId }) => sourceAssetId === "asset-1");
  const conflictRow = conflicting.find(({ sourceAssetId }) => sourceAssetId === "asset-2");
  const { assessmentHash: ignoredHash, ...conflictValue } = original.assessment;
  conflictValue.sourceAssetId = conflictRow.sourceAssetId;
  conflictValue.sourceOrdinal = conflictRow.sourceOrdinal;
  conflictValue.objectKey = assets[1].objectKey;
  const conflictAssessment = { ...conflictValue, assessmentHash: hash(conflictValue) };
  conflictRow.resultHash = conflictAssessment.assessmentHash;
  conflictRow.assessment = conflictAssessment;

  for (const persisted of [invalidHash, conflicting]) {
    const later = makeHarness({
      assets,
      batchIndex: 1,
      persisted,
      observations: [observation("asset-3")],
    });
    later.input.sourceAssetLoader.loadSourceAsset = async (input) => {
      later.calls.load.push(input);
      return { bytes: Buffer.from("image-1"), contentType: "image/png" };
    };
    const accepted = await analyzeSourceImageBatch(later.input);
    assert.equal(later.calls.gateway.length, 1);
    assert.equal(later.calls.load.length, 1);
    assert.equal(accepted.assessments[0].terminalStatus, "ANALYZED");
    assert.equal(accepted.assessments[0].duplicateOfSourceAssetId, null);
  }
});

test("different hashes stay in the paid batch even when the model marks them as near duplicates", async () => {
  const assets = [
    materialized("asset-a", Buffer.from("image-a"), 0),
    materialized("asset-b", Buffer.from("image-asset-b"), 1),
  ];
  const harness = makeHarness({ assets, observations: [
    observation("asset-a", { perceptualDuplicateGroup: "near-1" }),
    observation("asset-b", { perceptualDuplicateGroup: "near-1" }),
  ] });
  await analyzeSourceImageBatch(harness.input);
  assert.deepEqual(harness.calls.gateway[0].images.map(({ sourceAssetId }) => sourceAssetId), ["asset-a", "asset-b"]);
});

test("unknown AI fields fail the whole batch with no partial persistence", async () => {
  const harness = makeHarness({ observations: [{ ...observation("asset-a"), guessedBrand: "secret-brand" }] });
  await assert.rejects(analyzeSourceImageBatch(harness.input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_RESULT_INVALID",
  });
  assert.equal(harness.calls.persist.length, 0);
  assert.equal(harness.records.length, 0);
});

test("a fresh paid request retries one invalid source-image result before accepting the batch", async () => {
  const requests = [];
  const valid = observation("asset-a");
  const harness = makeHarness({
    gateway: {
      async createTextResponse(input) {
        requests.push(input);
        return { value: requests.length === 1
          ? { observations: [{ ...valid, guessedBrand: "not-in-contract" }] }
          : { observations: [valid] } };
      },
    },
  });

  const output = await analyzeSourceImageBatch(harness.input);

  assert.equal(output.status, "ACCEPTED");
  assert.equal(requests.length, 2);
  assert.match(requests[0].requestKey, /^[a-f0-9]{64}$/u);
  assert.match(requests[1].requestKey, /^[a-f0-9]{64}$/u);
  assert.notEqual(requests[0].requestKey, requests[1].requestKey);
  assert.equal(harness.calls.persist.length, 1);
});

test("source-image result retries remain bounded and never persist an invalid batch", async () => {
  const invalid = { ...observation("asset-a"), guessedBrand: "not-in-contract" };
  let paidCalls = 0;
  const harness = makeHarness({
    gateway: {
      async analyzeSourceImages() {
        paidCalls += 1;
        return { observations: [invalid] };
      },
    },
  });

  await assert.rejects(analyzeSourceImageBatch(harness.input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_RESULT_INVALID",
  });
  assert.equal(paidCalls, 3);
  assert.equal(harness.calls.persist.length, 0);
});

test("loads only verified stored bytes and checks the lease before load, paid call, and persistence", async () => {
  const harness = makeHarness();
  const output = await analyzeSourceImageBatch(harness.input);
  assert.equal(output.status, "ACCEPTED");
  assert.equal(harness.calls.load.length, 1);
  assert.deepEqual(Object.keys(harness.calls.gateway[0]).sort(), ["contractVersion", "images", "sourceFacts"]);
  assert.deepEqual(Object.keys(harness.calls.gateway[0].images[0]).sort(), [
    "bytes", "contentType", "sourceAssetId", "sourceOrdinal",
  ]);
  assert.equal(JSON.stringify(harness.calls.gateway[0]).includes("objectKey"), false);
  assert.equal(harness.calls.lease.length >= 3, true);
  assert.equal(harness.calls.persist.length, 1);
});

test("null-connection legacy profile reaches the direct analysis port without connection evidence", async () => {
  const harness = makeHarness();
  harness.input.profile = { ...profile, connectionId: null, connectionVersion: null };
  harness.input.gatewayExecution = null;
  const output = await analyzeSourceImageBatch(harness.input);
  assert.equal(output.status, "ACCEPTED");
  assert.equal(harness.calls.gateway.length, 1);
  assert.equal(harness.calls.persist.length, 1);
});

test("analyzer rejects crossing null legacy and connection-backed execution evidence before paid work", async () => {
  for (const overrides of [
    { profile, gatewayExecution: null },
    { profile: { ...profile, connectionId: null, connectionVersion: null }, gatewayExecution },
  ]) {
    const harness = makeHarness();
    Object.assign(harness.input, overrides);
    await assert.rejects(analyzeSourceImageBatch(harness.input), {
      code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_INPUT_INVALID",
    });
    assert.equal(harness.calls.gateway.length, 0);
    assert.equal(harness.calls.load.length, 0);
    assert.equal(harness.calls.persist.length, 0);
  }
});

test("same accepted batch replays without loading bytes or calling the paid gateway", async () => {
  const first = makeHarness();
  const accepted = await analyzeSourceImageBatch(first.input);
  const persisted = first.records.map((entry) => structuredClone(entry));
  const replay = makeHarness({ gateway: {
    async analyzeSourceImages() { throw new Error("paid gateway must not be called"); },
  }, persisted });
  const output = await analyzeSourceImageBatch(replay.input);
  assert.equal(accepted.inputHash, output.inputHash);
  assert.equal(output.status, "EXISTING_ACCEPTED");
  assert.equal(replay.calls.load.length, 0);
  assert.equal(replay.calls.persist.length, 0);
});

test("a batch without historical reuse preserves the accepted pre-fix input hash", async () => {
  const first = makeHarness();
  await analyzeSourceImageBatch(first.input);
  const asset = first.materializedAssets[0];
  const legacyInputHash = hash({
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    runInputHash: run.inputHash,
    analysisBatchId: first.input.batch.analysisBatchId,
    sourceFacts: {},
    images: [{
      sourceAssetId: asset.sourceAssetId,
      sourceOrdinal: asset.sourceOrdinal,
      contentHash: asset.contentHash,
      contentType: asset.contentType,
    }],
    profile: { id: profile.id, version: profile.configVersion, model: profile.textModel },
  });
  const persisted = first.records.map((entry) => ({
    ...structuredClone(entry), inputHash: legacyInputHash,
  }));
  const replay = makeHarness({
    persisted,
    gateway: { async analyzeSourceImages() { throw new Error("accepted legacy batch must replay"); } },
  });
  const output = await analyzeSourceImageBatch(replay.input);
  assert.equal(output.status, "EXISTING_ACCEPTED");
  assert.equal(output.inputHash, legacyInputHash);
  assert.equal(replay.calls.load.length, 0);
  assert.equal(replay.calls.gateway.length, 0);
  assert.equal(replay.calls.persist.length, 0);
});

test("replays a legacy accepted later duplicate batch before deriving historical reuse", async () => {
  const assets = Array.from({ length: 3 }, (_, index) => materialized(
    `asset-${index + 1}`, Buffer.from(index === 2 ? "image-1" : `image-${index + 1}`), index,
  ));
  const earlier = makeHarness({
    assets,
    observations: assets.slice(0, 2).map(({ sourceAssetId }) => observation(sourceAssetId)),
  });
  earlier.input.sourceAssetLoader.loadSourceAsset = async ({ materializedAsset }) => ({
    bytes: Buffer.from(`image-${materializedAsset.sourceOrdinal + 1}`), contentType: "image/png",
  });
  await analyzeSourceImageBatch(earlier.input);

  const acceptedLater = makeHarness({
    assets,
    batchIndex: 1,
    observations: [observation("asset-3")],
  });
  acceptedLater.input.sourceAssetLoader.loadSourceAsset = async ({ materializedAsset }) => ({
    bytes: Buffer.from("image-1"), contentType: materializedAsset.contentType,
  });
  const legacyAccepted = await analyzeSourceImageBatch(acceptedLater.input);
  const asset = assets[2];
  const legacyInputHash = hash({
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    runInputHash: run.inputHash,
    analysisBatchId: acceptedLater.input.batch.analysisBatchId,
    sourceFacts: {},
    images: [{
      sourceAssetId: asset.sourceAssetId,
      sourceOrdinal: asset.sourceOrdinal,
      contentHash: asset.contentHash,
      contentType: asset.contentType,
    }],
    profile: { id: profile.id, version: profile.configVersion, model: profile.textModel },
  });
  assert.equal(legacyAccepted.inputHash, legacyInputHash);
  assert.equal(legacyAccepted.assessments[0].terminalStatus, "ANALYZED");

  const replay = makeHarness({
    assets,
    batchIndex: 1,
    persisted: [
      ...earlier.records.map((entry) => structuredClone(entry)),
      ...acceptedLater.records.map((entry) => structuredClone(entry)),
    ],
    gateway: { async analyzeSourceImages() { throw new Error("accepted legacy duplicate must replay"); } },
  });
  replay.input.sourceAssetLoader.loadSourceAsset = async () => {
    throw new Error("accepted legacy duplicate must not load bytes");
  };
  const output = await analyzeSourceImageBatch(replay.input);
  assert.equal(replay.calls.load.length, 0);
  assert.equal(replay.calls.gateway.length, 0);
  assert.equal(replay.calls.persist.length, 0);
  assert.equal(output.status, "EXISTING_ACCEPTED");
  assert.equal(output.inputHash, legacyInputHash);
  assert.equal(output.assessments[0].terminalStatus, "ANALYZED");
});

test("unrelated earlier observations do not alter a later accepted pre-fix input hash", async () => {
  const assets = Array.from({ length: 3 }, (_, index) => materialized(
    `asset-${index + 1}`, Buffer.from(`image-${index + 1}`), index,
  ));
  const earlier = makeHarness({
    assets,
    observations: assets.slice(0, 2).map(({ sourceAssetId }) => observation(sourceAssetId)),
  });
  earlier.input.sourceAssetLoader.loadSourceAsset = async ({ materializedAsset }) => ({
    bytes: Buffer.from(`image-${materializedAsset.sourceOrdinal + 1}`), contentType: "image/png",
  });
  await analyzeSourceImageBatch(earlier.input);

  const acceptedLater = makeHarness({
    assets,
    batchIndex: 1,
    observations: [observation("asset-3")],
  });
  acceptedLater.input.sourceAssetLoader.loadSourceAsset = async ({ materializedAsset }) => ({
    bytes: Buffer.from("image-3"), contentType: materializedAsset.contentType,
  });
  await analyzeSourceImageBatch(acceptedLater.input);
  const asset = assets[2];
  const legacyInputHash = hash({
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    runInputHash: run.inputHash,
    analysisBatchId: acceptedLater.input.batch.analysisBatchId,
    sourceFacts: {},
    images: [{
      sourceAssetId: asset.sourceAssetId,
      sourceOrdinal: asset.sourceOrdinal,
      contentHash: asset.contentHash,
      contentType: asset.contentType,
    }],
    profile: { id: profile.id, version: profile.configVersion, model: profile.textModel },
  });
  const acceptedRows = acceptedLater.records.map((entry) => ({
    ...structuredClone(entry), inputHash: legacyInputHash,
  }));
  const replay = makeHarness({
    assets,
    batchIndex: 1,
    persisted: [...earlier.records.map((entry) => structuredClone(entry)), ...acceptedRows],
    gateway: { async analyzeSourceImages() { throw new Error("unrelated history must not alter replay"); } },
  });
  replay.input.sourceAssetLoader.loadSourceAsset = async (input) => {
    replay.calls.load.push(input);
    return { bytes: Buffer.from("image-3"), contentType: input.materializedAsset.contentType };
  };
  const output = await analyzeSourceImageBatch(replay.input);
  assert.equal(output.status, "EXISTING_ACCEPTED");
  assert.equal(output.inputHash, legacyInputHash);
  assert.equal(replay.calls.load.length, 0);
  assert.equal(replay.calls.gateway.length, 0);
  assert.equal(replay.calls.persist.length, 0);
});

test("forged historical batch identity or analyzed parent provenance cannot suppress payment", async () => {
  const assets = Array.from({ length: 3 }, (_, index) => materialized(
    `asset-${index + 1}`, Buffer.from(index === 2 ? "image-1" : `image-${index + 1}`), index,
  ));
  const earlier = makeHarness({
    assets,
    observations: assets.slice(0, 2).map(({ sourceAssetId }) => observation(sourceAssetId)),
  });
  earlier.input.sourceAssetLoader.loadSourceAsset = async ({ materializedAsset }) => ({
    bytes: Buffer.from(`image-${materializedAsset.sourceOrdinal + 1}`), contentType: "image/png",
  });
  await analyzeSourceImageBatch(earlier.input);

  const forgedBatch = earlier.records.map((entry) => structuredClone(entry));
  forgedBatch.find(({ sourceAssetId }) => sourceAssetId === "asset-1").analysisBatchId = "forged-batch";

  const forgedParent = earlier.records.map((entry) => structuredClone(entry));
  const parentRow = forgedParent.find(({ sourceAssetId }) => sourceAssetId === "asset-1");
  const parentValue = structuredClone(parentRow.assessment);
  delete parentValue.assessmentHash;
  parentValue.parentSourceAssetId = "forged-parent";
  parentRow.assessment = { ...parentValue, assessmentHash: hash(parentValue) };
  parentRow.resultHash = parentRow.assessment.assessmentHash;

  const outcomes = [];
  for (const persisted of [forgedBatch, forgedParent]) {
    const later = makeHarness({
      assets,
      batchIndex: 1,
      persisted,
      observations: [observation("asset-3")],
    });
    later.input.sourceAssetLoader.loadSourceAsset = async (input) => {
      later.calls.load.push(input);
      return { bytes: Buffer.from("image-1"), contentType: input.materializedAsset.contentType };
    };
    const output = await analyzeSourceImageBatch(later.input);
    outcomes.push({
      loads: later.calls.load.length,
      gatewayCalls: later.calls.gateway.length,
      terminalStatus: output.assessments[0].terminalStatus,
      duplicateOfSourceAssetId: output.assessments[0].duplicateOfSourceAssetId,
    });
  }
  assert.deepEqual(outcomes, [
    { loads: 1, gatewayCalls: 1, terminalStatus: "ANALYZED", duplicateOfSourceAssetId: null },
    { loads: 1, gatewayCalls: 1, terminalStatus: "ANALYZED", duplicateOfSourceAssetId: null },
  ]);
});

test("replaying an earlier batch never reuses a later accepted observation", async () => {
  const assets = Array.from({ length: 3 }, (_, index) => materialized(
    `asset-${index + 1}`, Buffer.from(index === 2 ? "image-1" : `image-${index + 1}`), index,
  ));
  const first = makeHarness({
    assets,
    observations: assets.slice(0, 2).map(({ sourceAssetId }) => observation(sourceAssetId)),
  });
  first.input.sourceAssetLoader.loadSourceAsset = async ({ materializedAsset }) => ({
    bytes: Buffer.from(`image-${materializedAsset.sourceOrdinal + 1}`), contentType: "image/png",
  });
  await analyzeSourceImageBatch(first.input);

  const earlier = first.records.find(({ sourceAssetId }) => sourceAssetId === "asset-1");
  const { assessmentHash: ignoredHash, ...laterValue } = structuredClone(earlier.assessment);
  laterValue.sourceAssetId = "asset-3";
  laterValue.sourceOrdinal = 2;
  laterValue.objectKey = assets[2].objectKey;
  const laterAssessment = { ...laterValue, assessmentHash: hash(laterValue) };
  const laterBatch = buildSourceImageAnalysisBatches({ materializedAssets: assets, terminalAssessments: [] })[1];
  const persisted = [...first.records.map((entry) => structuredClone(entry)), {
    ...scope,
    analysisRunId: run.id,
    analysisBatchId: laterBatch.analysisBatchId,
    inputHash: "e".repeat(64),
    resultHash: laterAssessment.assessmentHash,
    sourceAssetId: laterAssessment.sourceAssetId,
    sourceOrdinal: laterAssessment.sourceOrdinal,
    terminalStatus: laterAssessment.terminalStatus,
    assessment: laterAssessment,
  }];
  const replay = makeHarness({
    assets,
    persisted,
    gateway: { async analyzeSourceImages() { throw new Error("later observations must not alter earlier replay"); } },
  });
  replay.input.sourceAssetLoader.loadSourceAsset = async (input) => {
    replay.calls.load.push(input);
    return { bytes: Buffer.from(`image-${input.materializedAsset.sourceOrdinal + 1}`), contentType: "image/png" };
  };
  const output = await analyzeSourceImageBatch(replay.input);
  assert.equal(output.status, "EXISTING_ACCEPTED");
  assert.equal(replay.calls.load.length, 0);
  assert.equal(replay.calls.gateway.length, 0);
  assert.equal(replay.calls.persist.length, 0);
  assert.equal(ignoredHash, earlier.assessment.assessmentHash);
});

test("rejects mismatched adopted connection evidence before loading or charging", async () => {
  const harness = makeHarness();
  await assert.rejects(analyzeSourceImageBatch({
    ...harness.input,
    gatewayExecution: { ...gatewayExecution, connectionId: "connection-b" },
  }), { code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_INPUT_INVALID" });
  assert.equal(harness.calls.load.length, 0);
  assert.equal(harness.calls.gateway.length, 0);
});
