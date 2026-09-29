import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";
import {
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
  enumerateSourceImageAssets,
  partitionSourceImageAnalysisBatches,
  verifySourceImageAssessment,
  verifySourceImageIntelligenceSummary,
} from "../auto-listing-source-image-intelligence-contract.mjs";

const compareCodePoints = (left, right) => Buffer.from(String(left), "utf8").compare(Buffer.from(String(right), "utf8"));
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort(compareCodePoints).map((key) => [key, canonical(value[key])]))
    : value;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const image = (assetId, seed = assetId) => ({ assetId, contentHash: hash(seed) });

function sourceCaptureWithImages(images, variants = null) {
  const sourceVariants = variants || [{ sku: "sku-a", images }];
  return buildAutoListingSourceSnapshot({
    accountId: "account-a", sourceType: "COLLECT_BOX", sourceRecordId: "collect-a", sourceVersion: "1",
    targetStoreId: "store-a", targetStoreCurrency: "RUB",
    categoryEvidence: { id: "category-evidence-a", accountId: "account-a", sourceDescriptionCategoryId: 170, sourceTypeId: 99, taxonomyScope: "OZON:DEFAULT" },
    sharedCategory: { id: "shared-category-a", accountId: "account-a", version: 1, evidenceId: "category-evidence-a", status: "ACTIVE", source: "SOURCE_DIRECT", sourceDescriptionCategoryId: 170, sourceTypeId: 99, currentDescriptionCategoryId: 170, currentTypeId: 99, taxonomyScope: "OZON:DEFAULT", taxonomyFingerprint: null },
    collectItem: { id: "collect-a", accountId: "account-a", listingDraft: {
      sku: sourceVariants[0].sku, title: "Термокружка", brand: "Brand", currency: "RUB", blackKopecks: "10000", greenKopecks: "8000",
      categoryResolution: { status: "MATCHED", method: "taxonomy", target: { storeId: "store-a", descriptionCategoryId: "170", typeId: "99" } },
      images: sourceVariants[0].images, variants: sourceVariants.map((variant) => ({ ...variant, offerId: `offer-${variant.sku}`, name: variant.sku, currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" })),
    } },
    productDraft: { id: "draft-a", version: 1 }, rawResponseRef: "raw-a", rawResponseHash: hash("raw-a"),
  });
}

function assessment(overrides = {}) {
  const value = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    sourceAssetId: "asset-a", sourceOrdinal: 0, objectKey: "source/a.png", contentHash: hash("content-a"),
    parentSourceAssetId: null, terminalStatus: "ANALYZED", contentKinds: [], viewpoints: [], subjectBounds: null,
    quality: null, ocrRegions: [], markings: [], perceptualDuplicateGroup: null, duplicateOfSourceAssetId: null,
    eligibleUses: [], reasonCodes: [], ...overrides,
  };
  return { ...value, assessmentHash: hash(value) };
}

function summary(overrides = {}) {
  const value = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION, coverageMap: {}, factCandidates: [], markingDecisions: [],
    eligibleAssetIds: [], excludedAssetIds: [], requiredConfirmations: [], symmetryClass: null, reasonCodes: [], ...overrides,
  };
  return { ...value, summaryHash: hash(value) };
}

test("enumerates every unique captured source asset independently from the six output slots", () => {
  const capture = sourceCaptureWithImages(Array.from({ length: 13 }, (_, index) => image(`asset-${index + 1}`, `${index + 1}`)));
  const assets = enumerateSourceImageAssets({ sourceCapture: capture });
  assert.equal(assets.length, 13);
  assert.deepEqual(assets.map((entry) => entry.sourceOrdinal), Array.from({ length: 13 }, (_, index) => index));
  assert.equal(new Set(assets.map((entry) => entry.sourceAssetId)).size, 13);
});

test("enumerates sibling-SKU images and preserves memberships while deduplicating shared media", () => {
  const capture = sourceCaptureWithImages([], [
    { sku: "sku-a", images: [image("shared"), image("first")] },
    { sku: "sku-b", images: [image("shared"), "https://source.example.test/private.jpg"] },
  ]);
  const assets = enumerateSourceImageAssets({ sourceCapture: capture });
  assert.deepEqual(assets.map(({ sourceAssetId, sourceOrdinal }) => [sourceAssetId, sourceOrdinal]), [
    ["shared", 0], ["first", 1],
    [`source-url-${crypto.createHash("sha256").update("https://source.example.test/private.jpg").digest("hex").slice(0, 24)}`, 2],
  ]);
  assert.deepEqual(assets[0].memberships, [
    { variantId: "sku-a", sku: "sku-a", mediaOrdinal: 0 },
    { variantId: "sku-b", sku: "sku-b", mediaOrdinal: 0 },
  ]);
  assert.deepEqual(assets[2].memberships, [
    { variantId: "sku-b", sku: "sku-b", mediaOrdinal: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(assets), /source\.example\.test|private\.jpg/u);
  assert.equal(Object.isFrozen(assets), true);
  assert.equal(Object.isFrozen(assets[0].memberships), true);
});

test("rejects an object asset identifier that would expose an external URL", () => {
  const capture = sourceCaptureWithImages([image("https://source.example.test/private.jpg")]);
  assert.throws(() => enumerateSourceImageAssets({ sourceCapture: capture }), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID",
  });
});

test("rejects non-scalar Unicode keys before canonical summary hashing", () => {
  for (const key of ["\uD800", "\uDC00"]) {
    assert.throws(() => verifySourceImageIntelligenceSummary(summary({ coverageMap: { [key]: "value" } })), {
      code: "AUTO_LISTING_SOURCE_IMAGE_CONTRACT_INVALID",
    });
  }
});

test("rejects path and URL-reference forms as object source asset identifiers", () => {
  for (const assetId of ["//source.example/private.jpg", "/private.jpg", "source/private.jpg", "source\\private.jpg", "asset?token=secret", "asset#fragment"]) {
    const capture = sourceCaptureWithImages([image(assetId)]);
    assert.throws(() => enumerateSourceImageAssets({ sourceCapture: capture }), {
      code: "AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID",
    });
  }
});

test("rejects scheme-like and www object source asset identifiers without double slashes", () => {
  for (const assetId of ["https:example.test", "http:example.test", "ftp:example.test", "www.example.test"]) {
    const capture = sourceCaptureWithImages([image(assetId)]);
    assert.throws(() => enumerateSourceImageAssets({ sourceCapture: capture }), {
      code: "AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID",
    });
  }
});

test("partitions all materialized assets by image count and aggregate bytes without truncation", () => {
  const assets = Array.from({ length: 13 }, (_, index) => ({
    sourceAssetId: `asset-${index + 1}`, sourceOrdinal: index, sizeBytes: 5 * 1024 * 1024,
    contentHash: String(index + 1).padStart(64, "0"), objectKey: `source/${index + 1}.png`, contentType: "image/png",
  }));
  const batches = partitionSourceImageAnalysisBatches({ assets, maxImages: 6, maxAggregateBytes: 32 * 1024 * 1024 });
  assert.deepEqual(batches.map((batch) => batch.assets.length), [6, 6, 1]);
  assert.deepEqual(batches.flatMap((batch) => batch.assets.map((asset) => asset.sourceAssetId)), assets.map((asset) => asset.sourceAssetId));
  assert.deepEqual(batches.map((batch) => batch.aggregateBytes), [30, 30, 5].map((value) => value * 1024 * 1024));
  assert.ok(batches.every((batch) => /^[a-f0-9]{64}$/u.test(batch.analysisBatchId)));
});

test("rejects non-materialized and oversized source-image batches", () => {
  const asset = { sourceAssetId: "asset-a", sourceOrdinal: 0, sizeBytes: 33 * 1024 * 1024, contentHash: hash("asset-a"), objectKey: "source/a.png", contentType: "image/png" };
  assert.throws(() => partitionSourceImageAnalysisBatches({ assets: [{ ...asset, objectKey: null }] }), { code: "AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID" });
  assert.throws(() => partitionSourceImageAnalysisBatches({ assets: [asset] }), { code: "AUTO_LISTING_SOURCE_IMAGE_INPUT_TOO_LARGE" });
});

test("verifies closed assessment and summary hashes with recursively frozen values", () => {
  const acceptedAssessment = verifySourceImageAssessment(assessment({ reasonCodes: ["z", "ä"] }));
  const acceptedSummary = verifySourceImageIntelligenceSummary(summary({ reasonCodes: ["z", "ä"] }));
  assert.equal(Object.isFrozen(acceptedAssessment), true);
  assert.equal(Object.isFrozen(acceptedSummary.reasonCodes), true);
  assert.throws(() => verifySourceImageAssessment({ ...assessment(), extra: true }), { code: "AUTO_LISTING_SOURCE_IMAGE_CONTRACT_INVALID" });
  assert.throws(() => verifySourceImageIntelligenceSummary({ ...summary(), summaryHash: "0".repeat(64) }), { code: "AUTO_LISTING_SOURCE_IMAGE_CONTRACT_INVALID" });
});

test("accepts immutable V1 evidence while V2 assessments classify every text region", () => {
  const legacy = assessment({ contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1" });
  assert.deepEqual(verifySourceImageAssessment(structuredClone(legacy)), legacy);

  const v2Value = {
    ...assessment(),
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
    ocrRegions: [{
      text: "Подключите кабель к клеммам",
      region: { x: 0.12, y: 0.66, width: 0.62, height: 0.08 },
      language: "ru",
      confidence: "CONFIRMED",
    }],
    semanticTextRegions: [{
      sourceText: "Подключите кабель к клеммам",
      language: "ru",
      region: { x: 0.12, y: 0.66, width: 0.62, height: 0.08 },
      confidence: "CONFIRMED",
      semanticKind: "USAGE_STEP",
      normalizedMeaning: "Подключить кабель к клеммам",
      sequence: 1,
      reasonCodes: [],
    }],
  };
  delete v2Value.assessmentHash;
  const v2 = { ...v2Value, assessmentHash: hash(v2Value) };
  const accepted = verifySourceImageAssessment(v2);

  assert.equal(accepted.contractVersion, "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2");
  assert.equal(accepted.semanticTextRegions[0].sequence, 1);
  assert.equal(Object.isFrozen(accepted.semanticTextRegions[0]), true);

  for (const semanticTextRegions of [
    [{ ...v2.semanticTextRegions[0], sequence: null }],
    [{ ...v2.semanticTextRegions[0], semanticKind: "SELLING_POINT", sequence: 1 }],
    [{ ...v2.semanticTextRegions[0], unexpected: true }],
  ]) {
    const invalidValue = { ...v2Value, semanticTextRegions };
    const invalid = { ...invalidValue, assessmentHash: hash(invalidValue) };
    assert.throws(() => verifySourceImageAssessment(invalid), {
      code: "AUTO_LISTING_SOURCE_IMAGE_CONTRACT_INVALID",
    });
  }
});

test("V2 summaries bind every eligible logical source to verified original or cleaned bytes", () => {
  const summaryValue = {
    ...summary({
      eligibleAssetIds: ["asset-a", "asset-b"],
      appearanceAssetBindings: [{
        sourceAssetId: "asset-a",
        mode: "ORIGINAL",
        effectiveContentHash: hash("original-a"),
        derivativeAttemptId: null,
        cleanupEvidenceHash: null,
      }, {
        sourceAssetId: "asset-b",
        mode: "CLEANED",
        effectiveContentHash: hash("cleaned-b"),
        derivativeAttemptId: "source-cleanup-attempt-b-1",
        cleanupEvidenceHash: hash("cleanup-check-b"),
      }],
    }),
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
  };
  delete summaryValue.summaryHash;
  const v2 = { ...summaryValue, summaryHash: hash(summaryValue) };
  const accepted = verifySourceImageIntelligenceSummary(v2);

  assert.deepEqual(accepted.appearanceAssetBindings.map(({ sourceAssetId }) => sourceAssetId), ["asset-a", "asset-b"]);
  assert.equal(Object.isFrozen(accepted.appearanceAssetBindings[1]), true);

  for (const appearanceAssetBindings of [
    [v2.appearanceAssetBindings[0]],
    [v2.appearanceAssetBindings[0], { ...v2.appearanceAssetBindings[1], sourceAssetId: "asset-a" }],
    [{ ...v2.appearanceAssetBindings[0], derivativeAttemptId: "forbidden-attempt" }, v2.appearanceAssetBindings[1]],
    [v2.appearanceAssetBindings[0], { ...v2.appearanceAssetBindings[1], cleanupEvidenceHash: null }],
  ]) {
    const invalidValue = { ...summaryValue, appearanceAssetBindings };
    const invalid = { ...invalidValue, summaryHash: hash(invalidValue) };
    assert.throws(() => verifySourceImageIntelligenceSummary(invalid), {
      code: "AUTO_LISTING_SOURCE_IMAGE_CONTRACT_INVALID",
    });
  }
});

test("verifies the reconciled nested summary contract while retaining legacy Task 1 summaries", () => {
  const reconciled = summary({
    coverageMap: {
      FRONT: { assetIds: ["asset-a"], preciseViewpoints: ["FRONT"], tentativeAssetIds: [] },
      COMPLETE_PRODUCT: {
        confirmedFamilyCount: 1, confirmedFamilies: ["FRONT"], requiredFamilyCount: 1,
        prohibitedViews: ["BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"],
      },
    },
    factCandidates: [{
      sourceFactId: `source-fact-${"1".repeat(24)}`, kind: "PACKAGE_QUANTITY", value: "3", status: "CONFIRMED",
      sources: [{ sourceAssetId: "asset-a", region: null }], confirmationMethod: "STRUCTURED_FACT_MATCH",
      reasonCodes: ["SOURCE_FACT_STRUCTURED_MATCH"],
    }],
    markingDecisions: [{
      sourceAssetId: "asset-a", kind: "PRODUCT_MARKING", regions: [],
      decisionMethod: "OBSERVED_PRODUCT_MARKING", reasonCodes: ["PRODUCT_MARKING_PROTECTED"],
    }],
    eligibleAssetIds: ["asset-a"], excludedAssetIds: [], requiredConfirmations: [],
    symmetryClass: "ASYMMETRIC", reasonCodes: ["AUTO_LISTING_SOURCE_IMAGE_HIDDEN_VIEW_INFERENCE_PROHIBITED"],
  });
  const accepted = verifySourceImageIntelligenceSummary(reconciled);
  assert.equal(Object.isFrozen(accepted.coverageMap.FRONT), true);
  assert.equal(Object.isFrozen(accepted.factCandidates[0].sources), true);

  const legacy = summary({ coverageMap: { FRONT: ["asset-a"] }, requiredConfirmations: ["asset-b"] });
  const acceptedLegacy = verifySourceImageIntelligenceSummary(legacy);
  assert.deepEqual(acceptedLegacy.coverageMap.FRONT, ["asset-a"]);
  assert.deepEqual(acceptedLegacy.requiredConfirmations, ["asset-b"]);
  assert.equal(acceptedLegacy.summaryHash, legacy.summaryHash);
});

test("rejects malformed reconciled nested summaries and cross-list asset conflicts", () => {
  const validCoverage = {
    FRONT: { assetIds: ["asset-a"], preciseViewpoints: ["FRONT"], tentativeAssetIds: [] },
    COMPLETE_PRODUCT: {
      confirmedFamilyCount: 1, confirmedFamilies: ["FRONT"], requiredFamilyCount: 1,
      prohibitedViews: ["BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"],
    },
  };
  const reconciledSummary = (overrides = {}) => summary({
    coverageMap: validCoverage, eligibleAssetIds: ["asset-a"], symmetryClass: "ASYMMETRIC", ...overrides,
  });
  for (const invalid of [
    reconciledSummary({ coverageMap: { ...validCoverage, FRONT: { ...validCoverage.FRONT, hidden: true } } }),
    reconciledSummary({ coverageMap: { ...validCoverage, COMPLETE_PRODUCT: {
      ...validCoverage.COMPLETE_PRODUCT, confirmedFamilies: ["BACK"],
    } } }),
    reconciledSummary({ excludedAssetIds: ["asset-a"] }),
    reconciledSummary({ factCandidates: [{
      sourceFactId: "fact-invalid", kind: "PACKAGE_QUANTITY", value: "3", status: "CONFIRMED",
      sources: [], confirmationMethod: "STRUCTURED_FACT_MATCH", reasonCodes: [],
    }] }),
    reconciledSummary({ requiredConfirmations: [{
      sourceAssetId: "asset-a", kind: "UNCERTAIN_MARKING", regions: [], reasonCodes: [], extra: true,
    }] }),
  ]) {
    assert.throws(() => verifySourceImageIntelligenceSummary(invalid), {
      code: "AUTO_LISTING_SOURCE_IMAGE_CONTRACT_INVALID",
    });
  }
});

test("reconciled coverage validates precise viewpoints against every required family", () => {
  const complete = (confirmedFamilies, prohibitedViews = []) => ({
    confirmedFamilyCount: confirmedFamilies.length, confirmedFamilies,
    requiredFamilyCount: Math.min(confirmedFamilies.length, 3), prohibitedViews,
  });
  const entry = (preciseViewpoints) => ({ assetIds: ["asset-a"], preciseViewpoints, tentativeAssetIds: [] });
  const accepted = summary({
    coverageMap: {
      FRONT: entry(["FRONT_RIGHT_3_4"]), RIGHT: entry(["FRONT_RIGHT_3_4"]),
      COMPLETE_PRODUCT: complete(["FRONT", "RIGHT"], ["BACK", "LEFT", "TOP", "BOTTOM", "INTERIOR"]),
    },
    eligibleAssetIds: ["asset-a"], symmetryClass: "ASYMMETRIC",
  });
  assert.equal(verifySourceImageIntelligenceSummary(accepted).summaryHash, accepted.summaryHash);

  for (const invalid of [
    summary({
      coverageMap: { FRONT: entry(["BACK"]), COMPLETE_PRODUCT: complete(["FRONT"]) },
      eligibleAssetIds: ["asset-a"], symmetryClass: "ASYMMETRIC",
    }),
    summary({
      coverageMap: { FRONT: entry(["FRONT_RIGHT_3_4"]), COMPLETE_PRODUCT: complete(["FRONT"]) },
      eligibleAssetIds: ["asset-a"], symmetryClass: "ASYMMETRIC",
    }),
    summary({
      coverageMap: { ROTATIONAL: entry(["TOP"]), COMPLETE_PRODUCT: complete(["ROTATIONAL"]) },
      eligibleAssetIds: ["asset-a"], symmetryClass: "ROTATIONAL",
    }),
  ]) {
    assert.throws(() => verifySourceImageIntelligenceSummary(invalid), {
      code: "AUTO_LISTING_SOURCE_IMAGE_CONTRACT_INVALID",
    });
  }
});

test("reconciled coverage requires the fixed-order prohibited-view complement", () => {
  const entry = (viewpoint) => ({ assetIds: ["asset-a"], preciseViewpoints: [viewpoint], tentativeAssetIds: [] });
  const complete = (confirmedFamilies, prohibitedViews) => ({
    confirmedFamilyCount: confirmedFamilies.length, confirmedFamilies,
    requiredFamilyCount: Math.min(confirmedFamilies.length, 3), prohibitedViews,
  });
  const asymmetricCoverage = {
    FRONT: entry("FRONT"),
    COMPLETE_PRODUCT: complete(["FRONT"], ["BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"]),
  };
  const rotationalCoverage = {
    ROTATIONAL: entry("FRONT"), TOP: entry("TOP"),
    COMPLETE_PRODUCT: complete(["ROTATIONAL", "TOP"], ["BACK", "LEFT", "RIGHT", "BOTTOM", "INTERIOR"]),
  };
  const rotationalWithoutHorizontal = {
    TOP: entry("TOP"),
    COMPLETE_PRODUCT: complete(["TOP"], ["FRONT", "BACK", "LEFT", "RIGHT", "BOTTOM", "INTERIOR"]),
  };
  for (const [coverageMap, symmetryClass] of [
    [asymmetricCoverage, "ASYMMETRIC"],
    [rotationalCoverage, "ROTATIONAL"],
    [rotationalWithoutHorizontal, "ROTATIONAL"],
  ]) {
    const accepted = summary({ coverageMap, eligibleAssetIds: ["asset-a"], symmetryClass });
    assert.equal(verifySourceImageIntelligenceSummary(accepted).summaryHash, accepted.summaryHash);
  }

  for (const prohibitedViews of [[], ["FRONT"], ["BACK"],
    ["RIGHT", "LEFT", "BACK", "TOP", "BOTTOM", "INTERIOR"]]) {
    const invalid = summary({
      coverageMap: {
        ...asymmetricCoverage,
        COMPLETE_PRODUCT: { ...asymmetricCoverage.COMPLETE_PRODUCT, prohibitedViews },
      },
      eligibleAssetIds: ["asset-a"], symmetryClass: "ASYMMETRIC",
    });
    assert.throws(() => verifySourceImageIntelligenceSummary(invalid), {
      code: "AUTO_LISTING_SOURCE_IMAGE_CONTRACT_INVALID",
    });
  }
});
