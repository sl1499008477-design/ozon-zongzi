import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";
import {
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
  verifySourceImageIntelligenceSummary,
} from "../auto-listing-source-image-intelligence-contract.mjs";
import {
  confirmSourceImageFacts,
  reconcileSourceImageAssessments,
} from "../auto-listing-source-image-reconciler.mjs";

const compareCodePoints = (left, right) => {
  const a = Array.from(String(left), (character) => character.codePointAt(0));
  const b = Array.from(String(right), (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
};
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort(compareCodePoints).map((key) => [key, canonical(value[key])]))
    : value;
const hash = (value) => crypto.createHash("sha256").update(
  Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value)),
).digest("hex");

function capture({ structuredFacts = [], brand = "" } = {}) {
  return buildAutoListingSourceSnapshot({
    accountId: "account-a", sourceType: "COLLECT_BOX", sourceRecordId: "collect-a", sourceVersion: "1",
    targetStoreId: "store-a", targetStoreCurrency: "RUB",
    categoryEvidence: {
      id: "category-evidence-a", accountId: "account-a", sourceDescriptionCategoryId: 170,
      sourceTypeId: 99, taxonomyScope: "OZON:DEFAULT",
    },
    sharedCategory: {
      id: "shared-category-a", accountId: "account-a", version: 1, evidenceId: "category-evidence-a",
      status: "ACTIVE", source: "SOURCE_DIRECT", sourceDescriptionCategoryId: 170, sourceTypeId: 99,
      currentDescriptionCategoryId: 170, currentTypeId: 99, taxonomyScope: "OZON:DEFAULT",
      taxonomyFingerprint: null,
    },
    collectItem: {
      id: "collect-a", accountId: "account-a", listingDraft: {
        sku: "sku-a", title: "Термокружка", brand, currency: "RUB", blackKopecks: "10000",
        greenKopecks: "8000", categoryAttributes: structuredFacts,
        categoryResolution: {
          status: "MATCHED", method: "taxonomy",
          target: { storeId: "store-a", descriptionCategoryId: "170", typeId: "99" },
        },
        images: [{ assetId: "capture-asset", contentHash: hash("capture-asset") }],
        variants: [{
          sku: "sku-a", offerId: "offer-sku-a", name: "sku-a", currency: "RUB",
          blackKopecks: "10000", greenKopecks: "8000",
          images: [{ assetId: "capture-asset", contentHash: hash("capture-asset") }],
        }],
      },
    },
    productDraft: { id: "draft-a", version: 1 }, rawResponseRef: "raw-a", rawResponseHash: hash("raw-a"),
  });
}

const subjectRegion = Object.freeze({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
const markingRegion = Object.freeze({ x: 0.25, y: 0.25, width: 0.2, height: 0.1 });
const canvasRegion = Object.freeze({ x: 0.82, y: 0.02, width: 0.15, height: 0.08 });

function assessment(sourceAssetId, sourceOrdinal, overrides = {}) {
  const value = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    sourceAssetId, sourceOrdinal, objectKey: `source/${sourceAssetId}.png`, contentHash: hash(sourceAssetId),
    parentSourceAssetId: null, terminalStatus: "ANALYZED", contentKinds: ["PRODUCT_VIEW"],
    viewpoints: [], subjectBounds: subjectRegion,
    quality: { confidence: "CONFIRMED", usable: true, reasonCodes: [] },
    ocrRegions: [], markings: [], perceptualDuplicateGroup: null, duplicateOfSourceAssetId: null,
    eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW"], reasonCodes: [], ...overrides,
  };
  return { ...value, assessmentHash: hash(value) };
}

function productAssessment(sourceAssetId, viewpoint, overrides = {}) {
  return assessment(sourceAssetId, overrides.sourceOrdinal ?? 0, {
    viewpoints: [{ kind: viewpoint, confidence: "CONFIRMED", reasonCodes: [`VISIBLE_${viewpoint}`] }],
    ...overrides,
  });
}

function textOnlyAssessment(sourceAssetId, text, overrides = {}) {
  return assessment(sourceAssetId, overrides.sourceOrdinal ?? 0, {
    contentKinds: ["TEXT_ONLY"], viewpoints: [], subjectBounds: null,
    ocrRegions: [{ text, region: null, language: "ru", confidence: "CONFIRMED" }],
    eligibleUses: ["TEXT_FACT"], ...overrides,
  });
}

function semanticAssessment(sourceAssetId, semanticTextRegions, overrides = {}) {
  const ocrRegions = semanticTextRegions.map(({ sourceText, language, region, confidence }) => ({
    text: sourceText, language, region, confidence,
  }));
  return assessment(sourceAssetId, overrides.sourceOrdinal ?? 0, {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
    contentKinds: ["TEXT_ONLY"],
    viewpoints: [],
    subjectBounds: null,
    ocrRegions,
    semanticTextRegions,
    eligibleUses: ["TEXT_FACT"],
    ...overrides,
  });
}

function semanticRegion(sourceText, semanticKind, overrides = {}) {
  return {
    sourceText,
    language: "ru",
    region: null,
    confidence: "CONFIRMED",
    semanticKind,
    normalizedMeaning: sourceText,
    sequence: semanticKind === "USAGE_STEP" ? 1 : null,
    reasonCodes: [],
    ...overrides,
  };
}

function productMarking(text = "Acme") {
  return {
    marking: { kind: "PRODUCT_MARKING", region: markingRegion, confidence: "CONFIRMED", reasonCodes: ["SURFACE_PERSPECTIVE"] },
    ocrRegion: { text, region: markingRegion, language: "en", confidence: "CONFIRMED" },
  };
}

function externalOverlay(text = "seller.example") {
  return {
    marking: { kind: "EXTERNAL_OVERLAY", region: canvasRegion, confidence: "CONFIRMED", reasonCodes: ["FIXED_CANVAS_POSITION"] },
    ocrRegion: { text, region: canvasRegion, language: "en", confidence: "CONFIRMED" },
  };
}

function uncertainSubjectMarking() {
  return { kind: "UNCERTAIN_MARKING", region: markingRegion, confidence: "UNCERTAIN", reasonCodes: ["SUBJECT_OVERLAP"] };
}

test("text-only images can confirm facts but can never become appearance references", () => {
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture({ structuredFacts: [{ kind: "PACKAGE_QUANTITY", value: "3" }] }),
    assessments: [
      textOnlyAssessment("text-1", "3 штуки", { sourceOrdinal: 0 }),
      productAssessment("front-1", "FRONT", { sourceOrdinal: 1 }),
    ],
    decisions: [],
  });
  const fact = summary.factCandidates.find((entry) => entry.kind === "PACKAGE_QUANTITY");
  assert.equal(fact.status, "CONFIRMED");
  assert.equal(fact.confirmationMethod, "STRUCTURED_FACT_MATCH");
  assert.deepEqual(fact.sources, [{ sourceAssetId: "text-1", region: null }]);
  assert.ok(!summary.eligibleAssetIds.includes("text-1"));
  assert.ok(summary.excludedAssetIds.includes("text-1"));
  assert.deepEqual(summary.coverageMap.FRONT.assetIds, ["front-1"]);
  assert.equal(verifySourceImageIntelligenceSummary(summary).summaryHash, summary.summaryHash);
});

test("V2 confirms low-risk meanings from every text region while preserving usage-step order", () => {
  const assessmentValue = semanticAssessment("all-text", [
    semanticRegion("Автоматическое срабатывание при перегреве", "SELLING_POINT"),
    semanticRegion("Для электрических шкафов", "USAGE"),
    semanticRegion("Закрепите устройство на DIN-рейке", "USAGE_STEP", { sequence: 1 }),
    semanticRegion("Подключите кабель к клеммам", "USAGE_STEP", { sequence: 2 }),
    semanticRegion("Рабочий ток 20 А", "SPECIFICATION"),
    semanticRegion("В комплекте 3 штуки", "PACKAGE_CONTENT"),
    semanticRegion("Не устанавливать рядом с водой", "CAUTION"),
  ]);

  const facts = confirmSourceImageFacts({ sourceCapture: capture(), assessments: [assessmentValue] });

  assert.deepEqual(facts.filter(({ status }) => status === "CONFIRMED").map(({ kind }) => kind), [
    "IMAGE_CAUTION",
    "IMAGE_PACKAGE_CONTENT",
    "IMAGE_SELLING_POINT",
    "IMAGE_SPECIFICATION",
    "IMAGE_USAGE",
    "IMAGE_USAGE_STEP",
    "IMAGE_USAGE_STEP",
  ]);
  assert.ok(facts.every(({ confirmationMethod }) => confirmationMethod === "SOURCE_TEXT_EXPLICIT_LOW_RISK"));
  assert.deepEqual(facts.filter(({ kind }) => kind === "IMAGE_USAGE_STEP")
    .map(({ sources }) => sources[0].sequence), [1, 2]);
  assert.ok(facts.every(({ sources }) => sources[0].sourceText.length > 0
    && sources[0].semanticKind.length > 0));
});

test("V2 useful text remains factual evidence even when its mixed image needs overlay cleanup", () => {
  const sellingPoint = semanticRegion("Срабатывание за доли секунды", "SELLING_POINT", {
    region: { x: 0.1, y: 0.7, width: 0.6, height: 0.08 },
  });
  const value = semanticAssessment("mixed-overlay", [sellingPoint], {
    contentKinds: ["MIXED"],
    viewpoints: [{ kind: "FRONT", confidence: "CONFIRMED", reasonCodes: ["VISIBLE_FRONT"] }],
    subjectBounds: subjectRegion,
    markings: [{
      kind: "EXTERNAL_OVERLAY", region: canvasRegion, confidence: "CONFIRMED",
      reasonCodes: ["FIXED_CANVAS_POSITION"],
    }],
    eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW", "TEXT_FACT"],
  });

  const fact = confirmSourceImageFacts({ sourceCapture: capture(), assessments: [value] })
    .find(({ kind }) => kind === "IMAGE_SELLING_POINT");

  assert.equal(fact?.status, "CONFIRMED");
  assert.equal(fact?.confirmationMethod, "SOURCE_TEXT_EXPLICIT_LOW_RISK");
});

test("V2 rejects promotion contact and external-overlay semantics before creative planning", () => {
  const facts = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [semanticAssessment("unsafe-text", [
      semanticRegion("Скидка 50%", "PROMOTION"),
      semanticRegion("seller.example", "EXTERNAL_OVERLAY"),
      semanticRegion("+7 900 000 00 00", "CONTACT"),
    ])],
  });

  assert.equal(facts.length, 3);
  assert.ok(facts.every(({ status, confirmationMethod }) => status === "REJECTED"
    && confirmationMethod === "REJECTED_FORBIDDEN_TEXT"));
});

test("V2 repeated meanings merge sources while different collection facts do not conflict", () => {
  const facts = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [
      semanticAssessment("selling-a", [semanticRegion("Автоматическое срабатывание", "SELLING_POINT")], { sourceOrdinal: 0 }),
      semanticAssessment("selling-b", [semanticRegion("Автоматическое срабатывание", "SELLING_POINT")], { sourceOrdinal: 1 }),
      semanticAssessment("selling-c", [semanticRegion("Компактный корпус", "SELLING_POINT")], { sourceOrdinal: 2 }),
    ],
  });

  const repeated = facts.find(({ value }) => value === "Автоматическое срабатывание");
  const distinct = facts.find(({ value }) => value === "Компактный корпус");
  assert.equal(repeated?.status, "CONFIRMED");
  assert.equal(repeated?.confirmationMethod, "INDEPENDENT_IMAGE_REPEAT");
  assert.equal(repeated?.sources.length, 2);
  assert.equal(distinct?.status, "CONFIRMED");
});

test("V2 rejects one repeated text once when confirmed semantic classifications tie across analysis batches", () => {
  const sourceText = "Изоляционная сумка на молнии";
  const facts = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [
      semanticAssessment("purple-view", [semanticRegion(sourceText, "PRODUCT_IDENTITY", {
        normalizedMeaning: "Insulated zippered bag",
      })], { sourceOrdinal: 0 }),
      semanticAssessment("gray-view", [semanticRegion(sourceText, "PROMOTION", {
        normalizedMeaning: "Insulated zippered bag",
      })], { sourceOrdinal: 1 }),
    ],
  });

  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, "FORBIDDEN_TEXT");
  assert.equal(facts[0].status, "REJECTED");
  assert.equal(facts[0].confirmationMethod, "REJECTED_FORBIDDEN_TEXT");
  assert.ok(facts[0].reasonCodes.includes("SOURCE_FACT_SEMANTIC_CLASSIFICATION_CONFLICT"));
  assert.deepEqual(facts[0].sources.map(({ sourceAssetId, semanticKind }) => ({ sourceAssetId, semanticKind })), [
    { sourceAssetId: "purple-view", semanticKind: "OTHER" },
    { sourceAssetId: "gray-view", semanticKind: "OTHER" },
  ]);
});

test("V2 applies a strict independent-image majority to repeated semantic classifications", () => {
  const sourceText = "ТЕРМОСУМКА";
  const facts = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [
      semanticAssessment("identity-a", [semanticRegion(sourceText, "PRODUCT_IDENTITY", {
        normalizedMeaning: "Thermal bag",
      })], { sourceOrdinal: 0 }),
      semanticAssessment("identity-b", [semanticRegion(sourceText, "PRODUCT_IDENTITY", {
        normalizedMeaning: "Thermal bag",
      })], { sourceOrdinal: 1 }),
      semanticAssessment("promotion-outlier", [semanticRegion(sourceText, "PROMOTION", {
        normalizedMeaning: "Thermal bag",
      })], { sourceOrdinal: 2 }),
    ],
  });

  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, "IMAGE_PRODUCT_IDENTITY");
  assert.equal(facts[0].status, "CONFIRMED");
  assert.equal(facts[0].confirmationMethod, "INDEPENDENT_IMAGE_REPEAT");
  assert.equal(facts[0].sources.length, 3);
  assert.ok(facts[0].sources.every(({ semanticKind }) => semanticKind === "PRODUCT_IDENTITY"));
});

test("V2 never lets a useful majority override a confirmed external-overlay classification", () => {
  const sourceText = "SELLER MARK";
  const facts = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [
      semanticAssessment("identity-a", [semanticRegion(sourceText, "PRODUCT_IDENTITY")], { sourceOrdinal: 0 }),
      semanticAssessment("identity-b", [semanticRegion(sourceText, "PRODUCT_IDENTITY")], { sourceOrdinal: 1 }),
      semanticAssessment("overlay", [semanticRegion(sourceText, "EXTERNAL_OVERLAY")], { sourceOrdinal: 2 }),
    ],
  });

  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, "FORBIDDEN_TEXT");
  assert.equal(facts[0].status, "REJECTED");
  assert.ok(facts[0].reasonCodes.includes("SOURCE_FACT_SEMANTIC_CLASSIFICATION_CONFLICT"));
  assert.ok(facts[0].sources.every(({ semanticKind }) => semanticKind === "OTHER"));
});

test("V2 high-risk text still needs matching structured evidence", () => {
  const semantic = semanticAssessment("certificate", [
    semanticRegion("Сертификация: CE", "SPECIFICATION"),
  ]);
  const unsupported = confirmSourceImageFacts({ sourceCapture: capture(), assessments: [semantic] });
  assert.ok(unsupported.every(({ status }) => status === "REJECTED"));

  const supported = confirmSourceImageFacts({
    sourceCapture: capture({ structuredFacts: [{ kind: "CERTIFICATION", value: "CE" }] }),
    assessments: [semantic],
  });
  const certification = supported.find(({ kind }) => kind === "CERTIFICATION");
  assert.equal(certification?.status, "CONFIRMED");
  assert.equal(certification?.confirmationMethod, "STRUCTURED_FACT_MATCH");
});

test("V2 pure-text sources supply facts but only product images receive original appearance bindings", () => {
  const product = productAssessment("front-v2", "FRONT", {
    sourceOrdinal: 0,
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
    semanticTextRegions: [],
  });
  const text = semanticAssessment("text-v2", [semanticRegion("Для электрощитов", "USAGE")], { sourceOrdinal: 1 });

  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(), assessments: [product, text], decisions: [],
  });

  assert.deepEqual(summary.appearanceAssetBindings.map(({ sourceAssetId, mode }) => ({ sourceAssetId, mode })), [
    { sourceAssetId: "front-v2", mode: "ORIGINAL" },
  ]);
  assert.ok(summary.excludedAssetIds.includes("text-v2"));
  assert.equal(summary.factCandidates.find(({ kind }) => kind === "IMAGE_USAGE")?.status, "CONFIRMED");
});

test("V2 binds an accepted cleaned derivative to the original logical asset and preserves OCR facts", () => {
  const original = semanticAssessment("front-overlay", [
    semanticRegion("Автоматическое отключение при перегреве", "SELLING_POINT", {
      region: { x: 0.1, y: 0.72, width: 0.6, height: 0.08 },
    }),
  ], {
    sourceOrdinal: 0,
    contentKinds: ["MIXED"],
    viewpoints: [{ kind: "FRONT", confidence: "CONFIRMED", reasonCodes: ["VISIBLE_FRONT"] }],
    subjectBounds: subjectRegion,
    markings: [{
      kind: "EXTERNAL_OVERLAY", region: canvasRegion, confidence: "CONFIRMED",
      reasonCodes: ["FIXED_CANVAS_POSITION"],
    }],
    eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW", "TEXT_FACT"],
  });
  const cleanedHash = hash("cleaned-front-overlay");
  const cleanupEvidenceHash = hash("cleanup-evidence");

  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(), assessments: [original], decisions: [],
    acceptedDerivativeBindings: [{
      sourceAssetId: "front-overlay",
      mode: "CLEANED",
      effectiveContentHash: cleanedHash,
      derivativeAttemptId: "cleanup-front-overlay-1",
      cleanupEvidenceHash,
    }],
  });

  assert.deepEqual(summary.eligibleAssetIds, ["front-overlay"]);
  assert.deepEqual(summary.excludedAssetIds, []);
  assert.deepEqual(summary.appearanceAssetBindings, [{
    sourceAssetId: "front-overlay",
    mode: "CLEANED",
    effectiveContentHash: cleanedHash,
    derivativeAttemptId: "cleanup-front-overlay-1",
    cleanupEvidenceHash,
  }]);
  assert.deepEqual(summary.coverageMap.FRONT.assetIds, ["front-overlay"]);
  assert.equal(summary.factCandidates.find(({ kind }) => kind === "IMAGE_SELLING_POINT")?.status, "CONFIRMED");
});

test("V2 product-marking confirmation does not relabel a confirmed external overlay", () => {
  const uncertainProductRegion = { x: 0.3, y: 0.55, width: 0.12, height: 0.06 };
  const original = semanticAssessment("mixed-overlay", [], {
    sourceOrdinal: 0,
    contentKinds: ["PRODUCT_VIEW", "MIXED"],
    viewpoints: [{ kind: "FRONT_RIGHT_3_4", confidence: "CONFIRMED", reasonCodes: [] }],
    subjectBounds: subjectRegion,
    markings: [
      { kind: "EXTERNAL_OVERLAY", region: canvasRegion, confidence: "CONFIRMED", reasonCodes: ["FIXED_CANVAS_POSITION"] },
      { kind: "PRODUCT_MARKING", region: uncertainProductRegion, confidence: "TENTATIVE", reasonCodes: ["SMALL_TEXT"] },
    ],
    eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW"],
  });
  const binding = {
    sourceAssetId: "mixed-overlay", mode: "CLEANED",
    effectiveContentHash: hash("cleaned-mixed-overlay"),
    derivativeAttemptId: "cleanup-mixed-overlay-1",
    cleanupEvidenceHash: hash("cleanup-mixed-overlay-evidence"),
  };

  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(), assessments: [original],
    decisions: [{ sourceAssetId: "mixed-overlay", decision: "PRODUCT_MARKING", decisionHash: "9".repeat(64) }],
    acceptedDerivativeBindings: [binding],
  });

  assert.deepEqual(summary.requiredConfirmations, []);
  assert.deepEqual(summary.appearanceAssetBindings, [binding]);
  assert.ok(summary.markingDecisions.some(({ kind, decisionMethod, regions }) => kind === "EXTERNAL_OVERLAY"
    && decisionMethod === "BACKGROUND_CANVAS_OVERLAY" && regions.some((region) => region.x === canvasRegion.x)));
  assert.ok(summary.markingDecisions.some(({ kind, decisionMethod, regions }) => kind === "PRODUCT_MARKING"
    && decisionMethod === "MANUAL_DECISION" && regions.some((region) => region.x === uncertainProductRegion.x)));
});

test("V2 keeps a confirmed overlay source as original guidance when no cleaned derivative exists", () => {
  const original = semanticAssessment("back-overlay", [
    semanticRegion("Для электрических шкафов", "USAGE"),
  ], {
    sourceOrdinal: 0,
    contentKinds: ["MIXED"],
    viewpoints: [{ kind: "BACK", confidence: "CONFIRMED", reasonCodes: ["VISIBLE_BACK"] }],
    subjectBounds: subjectRegion,
    markings: [{
      kind: "EXTERNAL_OVERLAY", region: canvasRegion, confidence: "CONFIRMED",
      reasonCodes: ["FIXED_CANVAS_POSITION"],
    }],
    eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW", "TEXT_FACT"],
  });

  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(), assessments: [original], decisions: [], acceptedDerivativeBindings: [],
  });

  assert.deepEqual(summary.eligibleAssetIds, ["back-overlay"]);
  assert.deepEqual(summary.excludedAssetIds, []);
  assert.equal(summary.factCandidates.find(({ kind }) => kind === "IMAGE_USAGE")?.status, "CONFIRMED");
  assert.deepEqual(summary.requiredConfirmations, []);
  assert.deepEqual(summary.coverageMap.BACK.assetIds, ["back-overlay"]);
  assert.deepEqual(summary.appearanceAssetBindings, [{
    sourceAssetId: "back-overlay",
    mode: "ORIGINAL",
    effectiveContentHash: original.contentHash,
    derivativeAttemptId: null,
    cleanupEvidenceHash: null,
  }]);
  assert.ok(summary.reasonCodes.includes("AUTO_LISTING_SOURCE_IMAGE_EXTERNAL_OVERLAY_GUIDANCE_ONLY"));
});

test("V2 does not let an external overlay hide an unresolved product marking", () => {
  const value = productAssessment("front-mixed-markings", "FRONT", {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
    semanticTextRegions: [],
    markings: [externalOverlay().marking, uncertainSubjectMarking()],
  });

  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(), assessments: [value], decisions: [], acceptedDerivativeBindings: [],
  });

  assert.deepEqual(summary.eligibleAssetIds, []);
  assert.equal(summary.requiredConfirmations[0]?.kind, "UNCERTAIN_MARKING");
});

test("price promotion contact site and unsupported certification text are rejected", () => {
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: [textOnlyAssessment("text-1", "999 ₽ скидка 50% example.ru +7 900 000 00 00 CE сертификат")],
    decisions: [],
  });
  assert.ok(summary.factCandidates.length > 0);
  assert.ok(summary.factCandidates.every((fact) => fact.status === "REJECTED"));
  assert.doesNotMatch(
    JSON.stringify(summary.factCandidates.filter((fact) => fact.status === "CONFIRMED")),
    /999|скидка|example|сертификат/ui,
  );
});

test("repeated Russian and English prohibited claims never become confirmed facts", () => {
  const prohibited = [
    "Продано 5000 раз", "Лечит аллергию", "Безопасно для детей", "Совместимо с BrandX",
    "Ranked number one", "Cures allergies", "Safe for children", "Compatible with BrandX",
    "Offer valid until tomorrow", "Better than BrandX", "Five year warranty",
  ];
  const assessments = prohibited.flatMap((text, index) => [
    textOnlyAssessment(`claim-${index}-a`, text, { sourceOrdinal: index * 2 }),
    textOnlyAssessment(`claim-${index}-b`, text, { sourceOrdinal: index * 2 + 1 }),
  ]);
  const facts = confirmSourceImageFacts({ sourceCapture: capture(), assessments });
  assert.ok(facts.length >= prohibited.length);
  assert.ok(facts.every((fact) => fact.status === "REJECTED"));
});

test("a product-marking region cannot authorize a prohibited claim", () => {
  const prohibited = ["Лечит аллергию", "Safe for children", "Compatible with BrandX", "Five year warranty"];
  const facts = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: prohibited.map((text, index) => {
      const { marking, ocrRegion } = productMarking(text);
      return productAssessment(`claim-${index}`, "FRONT", {
        sourceOrdinal: index, markings: [marking], ocrRegions: [ocrRegion],
      });
    }),
  });
  assert.ok(facts.every((fact) => fact.status === "REJECTED"));
});

test("a high-risk fact needs exact frozen support of the same closed kind", () => {
  const supported = confirmSourceImageFacts({
    sourceCapture: capture({ structuredFacts: [{ kind: "CERTIFICATION", value: "CE" }] }),
    assessments: [textOnlyAssessment("certificate", "Сертификация: CE")],
  });
  assert.equal(supported.find((fact) => fact.kind === "CERTIFICATION")?.status, "CONFIRMED");
  const unsupported = confirmSourceImageFacts({
    sourceCapture: capture({ structuredFacts: [{ kind: "MODEL", value: "CE" }] }),
    assessments: [textOnlyAssessment("certificate", "Сертификация: CE")],
  });
  assert.ok(unsupported.every((fact) => fact.status === "REJECTED"));
});

test("exact frozen facts keep structured authorization across every closed kind", () => {
  const cases = [
    [{ kind: "PACKAGE_QUANTITY", value: "3" }, "3 шт", "PACKAGE_QUANTITY"],
    [{ kind: "MATERIAL", value: "нержавеющая сталь" }, "Материал: нержавеющая сталь", "MATERIAL"],
    [{ kind: "MODEL", value: "X1/X2" }, "Модель: X1/X2", "MODEL"],
    [{ kind: "DIMENSIONS", value: "10x20 см" }, "Размер: 10x20 см", "DIMENSIONS"],
    [{ kind: "CERTIFICATION", value: "CE" }, "Сертификация: CE", "CERTIFICATION"],
    [{ kind: "WARRANTY", value: "2 года" }, "Гарантия: 2 года", "WARRANTY"],
  ];
  for (const [index, [structuredFact, text, expectedKind]] of cases.entries()) {
    const facts = confirmSourceImageFacts({
      sourceCapture: capture({ structuredFacts: [structuredFact] }),
      assessments: [textOnlyAssessment(`frozen-${index}`, text)],
    });
    const fact = facts.find(({ kind }) => kind === expectedKind);
    assert.equal(fact?.status, "CONFIRMED", expectedKind);
    assert.equal(fact?.confirmationMethod, "STRUCTURED_FACT_MATCH", expectedKind);
  }
  const brand = confirmSourceImageFacts({
    sourceCapture: capture({ brand: "Acme" }), assessments: [textOnlyAssessment("frozen-brand", "Acme")],
  }).find(({ kind }) => kind === "BRAND");
  assert.equal(brand?.status, "CONFIRMED");
  assert.equal(brand?.confirmationMethod, "STRUCTURED_FACT_MATCH");
});

test("structured quantity and brand require matching semantic context and canonical value", () => {
  const quantity = confirmSourceImageFacts({
    sourceCapture: capture({ structuredFacts: [{ kind: "PACKAGE_QUANTITY", value: "3" }] }),
    assessments: [textOnlyAssessment("rating", "Рейтинг 3 звезды")],
  });
  assert.ok(!quantity.some((fact) => fact.kind === "PACKAGE_QUANTITY" && fact.status === "CONFIRMED"));
  const brand = confirmSourceImageFacts({
    sourceCapture: capture({ brand: "Acme" }),
    assessments: [textOnlyAssessment("compatibility", "Compatible with Acme case")],
  });
  assert.ok(!brand.some((fact) => fact.kind === "BRAND" && fact.status === "CONFIRMED"));
});

test("a closed quantity must consume the whole OCR value before any authority can confirm it", () => {
  const tainted = [
    "3 шт подходит для iPhone", "3 шт уменьшает боль", "3 шт №1",
    "3 шт гипоаллергенный", "3 шт 500 шт",
  ];
  const repeated = confirmSourceImageFacts({
    sourceCapture: capture({ structuredFacts: [{ kind: "PACKAGE_QUANTITY", value: "3" }] }),
    assessments: tainted.flatMap((text, index) => [
      textOnlyAssessment(`tainted-${index}-a`, text, { sourceOrdinal: index * 2 }),
      textOnlyAssessment(`tainted-${index}-b`, text, { sourceOrdinal: index * 2 + 1 }),
    ]),
  });
  assert.ok(repeated.every((fact) => fact.status === "REJECTED"));

  const marked = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: tainted.map((text, index) => {
      const { marking, ocrRegion } = productMarking(text);
      return productAssessment(`marked-${index}`, "FRONT", {
        sourceOrdinal: index, markings: [marking], ocrRegions: [ocrRegion],
      });
    }),
  });
  assert.ok(marked.every((fact) => fact.status === "REJECTED"));
});

test("other closed fact kinds reject values with unparsed claim tails", () => {
  const tainted = [
    ["Материал: сталь подходит для iPhone", { kind: "MATERIAL", value: "сталь" }],
    ["Модель: X1 уменьшает боль", { kind: "MODEL", value: "X1" }],
    ["Размер: 10x20 см №1", { kind: "DIMENSIONS", value: "10x20 см" }],
  ];
  const repeated = confirmSourceImageFacts({
    sourceCapture: capture({ structuredFacts: tainted.map(([, fact]) => fact) }),
    assessments: tainted.flatMap(([text], index) => [
      textOnlyAssessment(`closed-${index}-a`, text, { sourceOrdinal: index * 2 }),
      textOnlyAssessment(`closed-${index}-b`, text, { sourceOrdinal: index * 2 + 1 }),
    ]),
  });
  assert.ok(repeated.every((fact) => fact.status === "REJECTED"));

  const marked = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: tainted.map(([text], index) => {
      const { marking, ocrRegion } = productMarking(text);
      return productAssessment(`closed-marked-${index}`, "FRONT", {
        sourceOrdinal: index, markings: [marking], ocrRegions: [ocrRegion],
      });
    }),
  });
  assert.ok(marked.every((fact) => fact.status === "REJECTED"));
});

test("non-frozen material and model values reject unsafe or multi-value tokens", () => {
  const unsafe = [
    "Материал: гипоаллергенный",
    "Материал: iPhone-совместимый",
    "Материал: сталь/алюминий",
    "Модель: X1_hypoallergenic",
    "Модель: X1/X2",
  ];
  for (const [index, text] of unsafe.entries()) {
    const repeated = confirmSourceImageFacts({
      sourceCapture: capture(),
      assessments: [
        textOnlyAssessment(`unsafe-${index}-a`, text, { sourceOrdinal: 0 }),
        textOnlyAssessment(`unsafe-${index}-b`, text, { sourceOrdinal: 1 }),
      ],
    });
    assert.ok(repeated.every((fact) => fact.status === "REJECTED"), text);

    const { marking, ocrRegion } = productMarking(text);
    const marked = confirmSourceImageFacts({
      sourceCapture: capture(),
      assessments: [productAssessment(`unsafe-marked-${index}`, "FRONT", {
        markings: [marking], ocrRegions: [ocrRegion],
      })],
    });
    assert.ok(marked.every((fact) => fact.status === "REJECTED"), text);
  }
});

test("material and model parsers reject separated claim variants but keep ordinary model separators", () => {
  const unsafe = [
    "Материал: гипо-аллергенный",
    "Material: hypo-allergenic",
    "Материал: сталь_алюминий",
    "Материал: сталь-алюминий",
    "Модель: X1_hypo-allergenic",
    "model-X1_hypo-allergenic",
    "Модель: X1_hypoallergenic2",
    "Модель: X1_compatibility",
    "Модель: X1_safety",
    "Модель: X1_medicalgrade",
  ];
  for (const [index, text] of unsafe.entries()) {
    const repeated = confirmSourceImageFacts({
      sourceCapture: capture(),
      assessments: [
        textOnlyAssessment(`variant-${index}-a`, text, { sourceOrdinal: 0 }),
        textOnlyAssessment(`variant-${index}-b`, text, { sourceOrdinal: 1 }),
      ],
    });
    assert.ok(repeated.every((fact) => fact.status === "REJECTED"), `repeated: ${text}`);

    const { marking, ocrRegion } = productMarking(text);
    const marked = confirmSourceImageFacts({
      sourceCapture: capture(),
      assessments: [productAssessment(`variant-marked-${index}`, "FRONT", {
        markings: [marking], ocrRegions: [ocrRegion],
      })],
    });
    assert.ok(marked.every((fact) => fact.status === "REJECTED"), `marked: ${text}`);
  }

  const repeatedModel = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [
      textOnlyAssessment("ordinary-model-a", "Модель: X1-Pro", { sourceOrdinal: 0 }),
      textOnlyAssessment("ordinary-model-b", "Модель: X1-Pro", { sourceOrdinal: 1 }),
    ],
  }).find(({ kind }) => kind === "MODEL");
  assert.equal(repeatedModel?.status, "CONFIRMED");
  assert.equal(repeatedModel?.confirmationMethod, "INDEPENDENT_IMAGE_REPEAT");

  const ordinaryMarking = productMarking("Модель: ABC_123");
  const markedModel = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [productAssessment("ordinary-model-marked", "FRONT", {
      markings: [ordinaryMarking.marking], ocrRegions: [ordinaryMarking.ocrRegion],
    })],
  }).find(({ kind }) => kind === "MODEL");
  assert.equal(markedModel?.status, "CONFIRMED");
  assert.equal(markedModel?.confirmationMethod, "PRODUCT_OR_PACKAGE_MARKING");
});

test("mixed-language and bounded medical-grade model claims require exact frozen trust", () => {
  const unsafe = [
    ["Модель: X1_hypo-аллергенный", "X1_hypo-аллергенный"],
    ["Модель: X1_гипо-allergenic", "X1_гипо-allergenic"],
    ["Модель: X1_med-grade", "X1_med-grade"],
    ["Модель: X1_medgrade", "X1_medgrade"],
  ];
  for (const [index, [text, trustedValue]] of unsafe.entries()) {
    const repeated = confirmSourceImageFacts({
      sourceCapture: capture(),
      assessments: [
        textOnlyAssessment(`mixed-claim-${index}-a`, text, { sourceOrdinal: 0 }),
        textOnlyAssessment(`mixed-claim-${index}-b`, text, { sourceOrdinal: 1 }),
      ],
    });
    assert.ok(repeated.every((fact) => fact.status === "REJECTED"), `repeated: ${text}`);

    const { marking, ocrRegion } = productMarking(text);
    const marked = confirmSourceImageFacts({
      sourceCapture: capture(),
      assessments: [productAssessment(`mixed-claim-marked-${index}`, "FRONT", {
        markings: [marking], ocrRegions: [ocrRegion],
      })],
    });
    assert.ok(marked.every((fact) => fact.status === "REJECTED"), `marked: ${text}`);

    const frozen = confirmSourceImageFacts({
      sourceCapture: capture({ structuredFacts: [{ kind: "MODEL", value: trustedValue }] }),
      assessments: [textOnlyAssessment(`mixed-claim-frozen-${index}`, text)],
    }).find(({ kind }) => kind === "MODEL");
    assert.equal(frozen?.status, "CONFIRMED", `frozen: ${text}`);
    assert.equal(frozen?.confirmationMethod, "STRUCTURED_FACT_MATCH", `frozen: ${text}`);
  }

  const ordinaryMed = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [
      textOnlyAssessment("ordinary-med-a", "Модель: X1-Med", { sourceOrdinal: 0 }),
      textOnlyAssessment("ordinary-med-b", "Модель: X1-Med", { sourceOrdinal: 1 }),
    ],
  }).find(({ kind }) => kind === "MODEL");
  assert.equal(ordinaryMed?.status, "CONFIRMED");
  assert.equal(ordinaryMed?.confirmationMethod, "INDEPENDENT_IMAGE_REPEAT");
});

test("dot-separated unsafe model claims require exact frozen trust", () => {
  const unsafe = [
    ["Модель: X1_hypo.allergenic", "X1_hypo.allergenic"],
    ["Модель: X1_med.grade", "X1_med.grade"],
  ];
  for (const [index, [text, trustedValue]] of unsafe.entries()) {
    const repeated = confirmSourceImageFacts({
      sourceCapture: capture(),
      assessments: [
        textOnlyAssessment(`dot-claim-${index}-a`, text, { sourceOrdinal: 0 }),
        textOnlyAssessment(`dot-claim-${index}-b`, text, { sourceOrdinal: 1 }),
      ],
    });
    assert.ok(repeated.length > 0, `repeated candidate: ${text}`);
    assert.ok(repeated.every(({ status }) => status === "REJECTED"), `repeated: ${text}`);

    const { marking, ocrRegion } = productMarking(text);
    const marked = confirmSourceImageFacts({
      sourceCapture: capture(),
      assessments: [productAssessment(`dot-claim-marked-${index}`, "FRONT", {
        markings: [marking], ocrRegions: [ocrRegion],
      })],
    });
    assert.ok(marked.length > 0, `marked candidate: ${text}`);
    assert.ok(marked.every(({ status }) => status === "REJECTED"), `marked: ${text}`);

    const frozen = confirmSourceImageFacts({
      sourceCapture: capture({ structuredFacts: [{ kind: "MODEL", value: trustedValue }] }),
      assessments: [textOnlyAssessment(`dot-claim-frozen-${index}`, text)],
    }).find(({ kind }) => kind === "MODEL");
    assert.equal(frozen?.status, "CONFIRMED", `frozen: ${text}`);
    assert.equal(frozen?.confirmationMethod, "STRUCTURED_FACT_MATCH", `frozen: ${text}`);
  }

  const ordinaryModels = ["X1-Med", "X1-Pro", "ABC_123"];
  for (const [index, value] of ordinaryModels.entries()) {
    const fact = confirmSourceImageFacts({
      sourceCapture: capture(),
      assessments: [
        textOnlyAssessment(`ordinary-dot-boundary-${index}-a`, `Модель: ${value}`, { sourceOrdinal: 0 }),
        textOnlyAssessment(`ordinary-dot-boundary-${index}-b`, `Модель: ${value}`, { sourceOrdinal: 1 }),
      ],
    }).find(({ kind }) => kind === "MODEL");
    assert.equal(fact?.status, "CONFIRMED", value);
    assert.equal(fact?.confirmationMethod, "INDEPENDENT_IMAGE_REPEAT", value);
  }
});

test("non-confirmed OCR never contributes independent repeated evidence", () => {
  for (const confidence of ["TENTATIVE", "UNCERTAIN"]) {
    const twoUnconfirmed = confirmSourceImageFacts({
      sourceCapture: capture(),
      assessments: [
        textOnlyAssessment(`unconfirmed-${confidence}-a`, "Материал: сталь", {
          sourceOrdinal: 0,
          ocrRegions: [{ text: "Материал: сталь", region: null, language: "ru", confidence }],
        }),
        textOnlyAssessment(`unconfirmed-${confidence}-b`, "Материал: сталь", {
          sourceOrdinal: 1,
          ocrRegions: [{ text: "Материал: сталь", region: null, language: "ru", confidence }],
        }),
      ],
    });
    assert.ok(twoUnconfirmed.every((fact) => fact.status === "REJECTED"), `two ${confidence}`);
    assert.ok(twoUnconfirmed.some((fact) => fact.reasonCodes.includes("SOURCE_FACT_OCR_NOT_CONFIRMED")));

    const oneConfirmed = confirmSourceImageFacts({
      sourceCapture: capture(),
      assessments: [
        textOnlyAssessment(`mixed-${confidence}-confirmed`, "Материал: сталь", { sourceOrdinal: 0 }),
        textOnlyAssessment(`mixed-${confidence}-unconfirmed`, "Материал: сталь", {
          sourceOrdinal: 1,
          ocrRegions: [{ text: "Материал: сталь", region: null, language: "ru", confidence }],
        }),
      ],
    });
    assert.ok(oneConfirmed.every((fact) => fact.status === "REJECTED"), `mixed ${confidence}`);

    for (const decision of ["EXTERNAL_OVERLAY_EXCLUDE", "UNRESOLVED_EXCLUDE"]) {
      const summary = reconcileSourceImageAssessments({
        sourceCapture: capture(),
        assessments: [
          productAssessment(`manual-${confidence}-${decision}-front`, "FRONT", {
            sourceOrdinal: 0,
            ocrRegions: [{ text: "Материал: сталь", region: null, language: "ru", confidence: "CONFIRMED" }],
          }),
          productAssessment(`manual-${confidence}-${decision}-right`, "RIGHT", {
            sourceOrdinal: 1,
            markings: [uncertainSubjectMarking()],
            ocrRegions: [{ text: "Материал: сталь", region: markingRegion, language: "ru", confidence }],
          }),
        ],
        decisions: [{
          sourceAssetId: `manual-${confidence}-${decision}-right`, decision, decisionHash: hash(`${confidence}-${decision}`),
        }],
      });
      assert.ok(summary.factCandidates.every((fact) => fact.status === "REJECTED"), `${confidence} ${decision}`);
    }
  }
});

test("two independent images confirm repeated text while exact and perceptual duplicates do not", () => {
  const base = textOnlyAssessment("text-a", "Материал: сталь", { sourceOrdinal: 0 });
  const exactDuplicate = textOnlyAssessment("text-b", "Материал: сталь", {
    sourceOrdinal: 1, terminalStatus: "DUPLICATE_REUSED", duplicateOfSourceAssetId: "text-a",
  });
  const nearDuplicate = textOnlyAssessment("text-c", "Материал: сталь", {
    sourceOrdinal: 2, perceptualDuplicateGroup: "near-a",
  });
  const sameNearDuplicate = textOnlyAssessment("text-d", "Материал: сталь", {
    sourceOrdinal: 3, perceptualDuplicateGroup: "near-a",
  });
  assert.ok(confirmSourceImageFacts({ sourceCapture: capture(), assessments: [base, exactDuplicate] })
    .every((fact) => fact.status === "REJECTED"));
  assert.ok(confirmSourceImageFacts({ sourceCapture: capture(), assessments: [nearDuplicate, sameNearDuplicate] })
    .every((fact) => fact.status === "REJECTED"));
  const independent = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [base, textOnlyAssessment("text-e", "Материал: сталь", { sourceOrdinal: 4 })],
  });
  assert.equal(independent.find((fact) => fact.value === "Материал: сталь").confirmationMethod, "INDEPENDENT_IMAGE_REPEAT");
});

test("exact and perceptual duplicate edges form one transitive evidence component", () => {
  const assessments = [
    textOnlyAssessment("text-a", "Материал: сталь", { sourceOrdinal: 0, perceptualDuplicateGroup: "near-a" }),
    textOnlyAssessment("text-b", "Материал: сталь", { sourceOrdinal: 1, perceptualDuplicateGroup: "near-a" }),
    textOnlyAssessment("text-c", "Материал: сталь", {
      sourceOrdinal: 2, terminalStatus: "DUPLICATE_REUSED", duplicateOfSourceAssetId: "text-b",
    }),
  ];
  const facts = confirmSourceImageFacts({ sourceCapture: capture(), assessments });
  assert.ok(facts.every((fact) => fact.status === "REJECTED"));
});

test("untyped repeated text is never promoted to a fact", () => {
  const facts = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [
      textOnlyAssessment("unknown-a", "Лучший выбор", { sourceOrdinal: 0 }),
      textOnlyAssessment("unknown-b", "Лучший выбор", { sourceOrdinal: 1 }),
    ],
  });
  assert.ok(facts.every((fact) => fact.status === "REJECTED"));
});

test("conflicting repeated values of one closed kind are all rejected", () => {
  const facts = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: ["500 шт", "500 шт", "600 шт", "600 шт"].map((text, index) =>
      textOnlyAssessment(`quantity-${index}`, text, { sourceOrdinal: index })),
  });
  const quantities = facts.filter((fact) => fact.kind === "PACKAGE_QUANTITY");
  assert.equal(quantities.length, 2);
  assert.ok(quantities.every((fact) => fact.status === "REJECTED"
    && fact.confirmationMethod === "CONFLICTING_EVIDENCE"));
});

test("a confirmed product or packaging marking can confirm a non-conflicting fact", () => {
  const { marking, ocrRegion } = productMarking("MODEL-X");
  const facts = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [productAssessment("nameplate", "FRONT", { markings: [marking], ocrRegions: [ocrRegion] })],
  });
  const fact = facts.find((entry) => entry.value === "MODEL-X");
  assert.equal(fact.status, "CONFIRMED");
  assert.equal(fact.confirmationMethod, "PRODUCT_OR_PACKAGE_MARKING");
  assert.deepEqual(fact.sources, [{ sourceAssetId: "nameplate", region: markingRegion }]);
});

test("text contained within a confirmed nameplate region is treated as marking evidence", () => {
  const { marking, ocrRegion } = productMarking("MODEL-Y");
  const containedOcr = { ...ocrRegion, region: { x: 0.28, y: 0.27, width: 0.1, height: 0.04 } };
  const facts = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [productAssessment("nameplate", "FRONT", { markings: [marking], ocrRegions: [containedOcr] })],
  });
  assert.equal(facts.find((entry) => entry.value === "MODEL-Y").confirmationMethod, "PRODUCT_OR_PACKAGE_MARKING");
});

test("a tiny OCR overlap with a nameplate does not authorize the text", () => {
  const { marking, ocrRegion } = productMarking("MODEL-Z");
  const grazingOcr = { ...ocrRegion, region: { x: 0.44, y: 0.25, width: 0.1, height: 0.1 } };
  const facts = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [productAssessment("nameplate", "FRONT", { markings: [marking], ocrRegions: [grazingOcr] })],
  });
  assert.ok(facts.every((fact) => fact.status === "REJECTED"));
});

test("intrinsic product markings are protected while canvas overlays are excluded", () => {
  const intrinsic = productMarking("Acme");
  const overlay = externalOverlay("seller.example");
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture({ brand: "Acme" }),
    assessments: [
      productAssessment("front", "FRONT", { sourceOrdinal: 0, markings: [intrinsic.marking], ocrRegions: [intrinsic.ocrRegion] }),
      productAssessment("side", "RIGHT", { sourceOrdinal: 1, markings: [overlay.marking], ocrRegions: [overlay.ocrRegion] }),
    ],
    decisions: [],
  });
  assert.equal(summary.markingDecisions.find((entry) => entry.sourceAssetId === "front").kind, "PRODUCT_MARKING");
  assert.equal(summary.markingDecisions.find((entry) => entry.sourceAssetId === "front").decisionMethod, "OBSERVED_PRODUCT_MARKING");
  assert.ok(summary.eligibleAssetIds.includes("front"));
  assert.ok(summary.excludedAssetIds.includes("side"));
  assert.equal(Object.isFrozen(summary.markingDecisions[0]), true);
});

test("a tentative marking already classified on the product remains protected and usable", () => {
  const intrinsic = productMarking("LUXEL");
  const assessment = productAssessment("product-detail", "DETAIL", {
    sourceOrdinal: 0,
    contentKinds: ["PRODUCT_DETAIL"],
    markings: [{ ...intrinsic.marking, confidence: "TENTATIVE", reasonCodes: ["BRAND_NAME"] }],
    ocrRegions: [intrinsic.ocrRegion],
    eligibleUses: ["DETAIL", "TEXT_FACT"],
  });
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture({ brand: "LUXEL" }),
    assessments: [assessment],
    decisions: [],
  });

  assert.deepEqual(summary.eligibleAssetIds, ["product-detail"]);
  assert.deepEqual(summary.excludedAssetIds, []);
  assert.deepEqual(summary.requiredConfirmations, []);
  assert.ok(summary.markingDecisions.some(({ sourceAssetId, kind, decisionMethod }) =>
    sourceAssetId === "product-detail"
      && kind === "PRODUCT_MARKING"
      && decisionMethod === "OBSERVED_PRODUCT_MARKING"));
  assert.ok(summary.markingDecisions.every(({ kind }) => kind !== "UNCERTAIN_MARKING"));
});

test("repeated physical-location evidence outranks an uncertain marking", () => {
  const repeated = (sourceAssetId, sourceOrdinal, viewpoint) => productAssessment(sourceAssetId, viewpoint, {
    sourceOrdinal,
    markings: [{ kind: "UNCERTAIN_MARKING", region: markingRegion, confidence: "UNCERTAIN", reasonCodes: ["SAME_PHYSICAL_LOCATION"] }],
  });
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(), assessments: [repeated("front", 0, "FRONT"), repeated("right", 1, "RIGHT")], decisions: [],
  });
  assert.ok(summary.markingDecisions.every((entry) => entry.kind === "PRODUCT_MARKING"));
  assert.ok(summary.markingDecisions.every((entry) => entry.decisionMethod === "REPEATED_PHYSICAL_LOCATION"));
  assert.deepEqual(summary.requiredConfirmations, []);
});

test("facts-only reconciliation uses the automatic effective marking disposition", () => {
  const repeatedMarking = {
    kind: "UNCERTAIN_MARKING", region: markingRegion, confidence: "UNCERTAIN",
    reasonCodes: ["SAME_PHYSICAL_LOCATION"],
  };
  const facts = confirmSourceImageFacts({
    sourceCapture: capture(),
    assessments: [
      productAssessment("front", "FRONT", {
        sourceOrdinal: 0, markings: [repeatedMarking],
        ocrRegions: [{ text: "MODEL-AUTO", region: markingRegion, language: "en", confidence: "CONFIRMED" }],
      }),
      productAssessment("right", "RIGHT", { sourceOrdinal: 1, markings: [repeatedMarking] }),
    ],
  });
  const model = facts.find((fact) => fact.kind === "MODEL");
  assert.equal(model?.status, "CONFIRMED");
  assert.equal(model?.confirmationMethod, "PRODUCT_OR_PACKAGE_MARKING");
});

test("a manually excluded asset cannot promote another asset by repeated physical location", () => {
  const repeatedMarking = {
    kind: "UNCERTAIN_MARKING", region: markingRegion, confidence: "UNCERTAIN",
    reasonCodes: ["SAME_PHYSICAL_LOCATION"],
  };
  const assessments = [
    productAssessment("front", "FRONT", {
      sourceOrdinal: 0, markings: [repeatedMarking],
      ocrRegions: [{ text: "MODEL-REPEAT", region: markingRegion, language: "en", confidence: "CONFIRMED" }],
    }),
    productAssessment("right", "RIGHT", { sourceOrdinal: 1, markings: [repeatedMarking] }),
  ];
  for (const [index, decision] of ["EXTERNAL_OVERLAY_EXCLUDE", "UNRESOLVED_EXCLUDE"].entries()) {
    const summary = reconcileSourceImageAssessments({
      sourceCapture: capture(), assessments,
      decisions: [{ sourceAssetId: "right", decision, decisionHash: String(index + 4).repeat(64) }],
    });
    const frontMarking = summary.markingDecisions.find(({ sourceAssetId }) => sourceAssetId === "front");
    assert.equal(frontMarking.kind, "UNCERTAIN_MARKING");
    assert.equal(summary.factCandidates.find(({ kind }) => kind === "MODEL")?.status, "REJECTED");
    assert.ok(summary.excludedAssetIds.includes("front"));
    assert.ok(summary.requiredConfirmations.some(({ sourceAssetId }) => sourceAssetId === "front"));
  }
});

test("same physical-location evidence may use different image coordinates", () => {
  const secondRegion = { x: 0.55, y: 0.3, width: 0.15, height: 0.08 };
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: [
      productAssessment("front", "FRONT", { sourceOrdinal: 0, markings: [{
        kind: "UNCERTAIN_MARKING", region: markingRegion, confidence: "UNCERTAIN", reasonCodes: ["SAME_PHYSICAL_LOCATION"],
      }] }),
      productAssessment("right", "RIGHT", { sourceOrdinal: 1, markings: [{
        kind: "UNCERTAIN_MARKING", region: secondRegion, confidence: "UNCERTAIN", reasonCodes: ["SAME_PHYSICAL_LOCATION"],
      }] }),
    ], decisions: [],
  });
  assert.ok(summary.markingDecisions.every((entry) => entry.kind === "PRODUCT_MARKING"
    && entry.decisionMethod === "REPEATED_PHYSICAL_LOCATION"));
});

test("fixed-canvas evidence outranks a contradictory product-marking label", () => {
  const contradictory = {
    kind: "PRODUCT_MARKING", region: canvasRegion, confidence: "CONFIRMED",
    reasonCodes: ["FIXED_CANVAS_POSITION"],
  };
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: [productAssessment("front", "FRONT", {
      markings: [contradictory],
      ocrRegions: [{ text: "MODEL-CANVAS", region: canvasRegion, language: "en", confidence: "CONFIRMED" }],
    })], decisions: [],
  });
  assert.equal(summary.markingDecisions[0].kind, "EXTERNAL_OVERLAY");
  assert.ok(summary.excludedAssetIds.includes("front"));
  assert.ok(summary.factCandidates.every((fact) => fact.status === "REJECTED"));
});

test("fact authorization follows the effective manual marking disposition", () => {
  const confirmed = productMarking("MODEL-MANUAL");
  const confirmedAssessment = productAssessment("front", "FRONT", {
    markings: [confirmed.marking], ocrRegions: [confirmed.ocrRegion],
  });
  for (const [index, decision] of ["EXTERNAL_OVERLAY_EXCLUDE", "UNRESOLVED_EXCLUDE"].entries()) {
    const summary = reconcileSourceImageAssessments({
      sourceCapture: capture({ structuredFacts: [{ kind: "MODEL", value: "MODEL-MANUAL" }] }),
      assessments: [confirmedAssessment],
      decisions: [{ sourceAssetId: "front", decision, decisionHash: String(index + 1).repeat(64) }],
    });
    assert.ok(summary.factCandidates.every((fact) => fact.status === "REJECTED"));
  }

  const promoted = reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: [productAssessment("front", "FRONT", {
      markings: [uncertainSubjectMarking()],
      ocrRegions: [{ text: "MODEL-MANUAL", region: markingRegion, language: "en", confidence: "CONFIRMED" }],
    })],
    decisions: [{ sourceAssetId: "front", decision: "PRODUCT_MARKING", decisionHash: "3".repeat(64) }],
  });
  assert.equal(promoted.factCandidates.find((fact) => fact.kind === "MODEL")?.status, "CONFIRMED");
  assert.equal(promoted.factCandidates.find((fact) => fact.kind === "MODEL")?.confirmationMethod,
    "PRODUCT_OR_PACKAGE_MARKING");
});

test("an uncertain marking over the only back view requires confirmation", () => {
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: [
      productAssessment("front", "FRONT", { sourceOrdinal: 0 }),
      productAssessment("back", "BACK", { sourceOrdinal: 1, markings: [uncertainSubjectMarking()] }),
    ],
    decisions: [],
  });
  assert.equal(summary.requiredConfirmations[0].sourceAssetId, "back");
  assert.equal(summary.reasonCodes.includes("AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED"), true);
  assert.ok(summary.excludedAssetIds.includes("back"));
  assert.equal(summary.coverageMap.BACK, undefined);
});

test("an uncertain duplicate view is excluded without blocking a safe asset in the same family", () => {
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: [
      productAssessment("front", "FRONT", { sourceOrdinal: 0 }),
      productAssessment("back-safe", "BACK", { sourceOrdinal: 1 }),
      productAssessment("back-uncertain", "BACK", { sourceOrdinal: 2, markings: [uncertainSubjectMarking()] }),
    ], decisions: [],
  });
  assert.deepEqual(summary.requiredConfirmations, []);
  assert.deepEqual(summary.coverageMap.BACK.assetIds, ["back-safe"]);
});

test("uncertain alternatives in the same missing view family are not each treated as unique evidence", () => {
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: [
      productAssessment("front-safe", "FRONT", { sourceOrdinal: 0 }),
      productAssessment("left-uncertain-a", "FRONT_LEFT_3_4", {
        sourceOrdinal: 1, markings: [uncertainSubjectMarking()],
      }),
      productAssessment("left-uncertain-b", "FRONT_LEFT_3_4", {
        sourceOrdinal: 2, markings: [uncertainSubjectMarking()],
      }),
    ], decisions: [],
  });
  assert.deepEqual(summary.requiredConfirmations, []);
  assert.ok(summary.excludedAssetIds.includes("left-uncertain-a"));
  assert.ok(summary.excludedAssetIds.includes("left-uncertain-b"));
  assert.equal(summary.coverageMap.LEFT, undefined);
});

test("a grazing uncertain marking does not block the only key view", () => {
  const grazingMarking = {
    kind: "UNCERTAIN_MARKING", region: { x: 0.095, y: 0.2, width: 0.006, height: 0.1 },
    confidence: "UNCERTAIN", reasonCodes: ["SUBJECT_OVERLAP_UNCERTAIN"],
  };
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: [productAssessment("back", "BACK", { markings: [grazingMarking] })], decisions: [],
  });
  assert.deepEqual(summary.requiredConfirmations, []);
  assert.ok(summary.excludedAssetIds.includes("back"));
});

test("one two and three confirmed view families are counted without inventing hidden views", () => {
  const forViews = (views) => reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: views.map((viewpoint, index) => productAssessment(`asset-${index}`, viewpoint, { sourceOrdinal: index })),
    decisions: [],
  });
  const one = forViews(["FRONT"]);
  const two = forViews(["FRONT", "RIGHT"]);
  const three = forViews(["FRONT", "RIGHT", "BACK"]);
  assert.equal(one.coverageMap.COMPLETE_PRODUCT.confirmedFamilyCount, 1);
  assert.equal(two.coverageMap.COMPLETE_PRODUCT.confirmedFamilyCount, 2);
  assert.equal(three.coverageMap.COMPLETE_PRODUCT.confirmedFamilyCount, 3);
  assert.deepEqual(one.coverageMap.COMPLETE_PRODUCT.confirmedFamilies, ["FRONT"]);
  assert.ok(one.coverageMap.COMPLETE_PRODUCT.prohibitedViews.includes("BACK"));
  assert.equal(one.coverageMap.BACK, undefined);
});

test("a usable front-facing product view is not reduced to detail-only evidence when an attached edge is cropped", () => {
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: [productAssessment("front-cropped-edge", "DETAIL", {
      contentKinds: ["MIXED", "PRODUCT_VIEW"],
      eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW", "DETAIL"],
      viewpoints: [{
        kind: "DETAIL",
        confidence: "CONFIRMED",
        reasonCodes: ["FRONT_FACING_PRODUCT", "ATTACHED_CABLES_CROPPED", "PARTIAL_PRODUCT_ONLY"],
      }],
      reasonCodes: ["PRODUCT_VISIBLE", "CABLES_PARTIALLY_CROPPED"],
    })],
    decisions: [],
  });

  assert.deepEqual(summary.coverageMap.FRONT.assetIds, ["front-cropped-edge"]);
  assert.deepEqual(summary.coverageMap.DETAIL.assetIds, ["front-cropped-edge"]);
  assert.deepEqual(summary.coverageMap.COMPLETE_PRODUCT.confirmedFamilies, ["FRONT"]);
  assert.ok(summary.coverageMap.COMPLETE_PRODUCT.prohibitedViews.includes("BACK"));
});

test("detail coverage ranks complete-product-visible evidence ahead of an earlier partial crop", () => {
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: [
      productAssessment("partial-detail", "DETAIL", {
        sourceOrdinal: 0,
        eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW", "DETAIL"],
        viewpoints: [{
          kind: "DETAIL", confidence: "CONFIRMED", reasonCodes: ["PARTIAL_PRODUCT_ONLY"],
        }],
      }),
      productAssessment("complete-composition", "DETAIL", {
        sourceOrdinal: 1,
        eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW", "DETAIL"],
        viewpoints: [{
          kind: "DETAIL", confidence: "CONFIRMED", reasonCodes: ["COMPLETE_PRODUCT_VISIBLE"],
        }],
      }),
    ],
    decisions: [],
  });

  assert.deepEqual(summary.coverageMap.DETAIL.assetIds, [
    "complete-composition",
    "partial-detail",
  ]);
});

test("a symmetric product does not invent separate front and back families", () => {
  const symmetricCylinder = (sourceAssetId, sourceOrdinal, viewpoint) => productAssessment(sourceAssetId, viewpoint, {
    sourceOrdinal,
    reasonCodes: ["ROTATIONAL_SYMMETRY_CONFIRMED"],
  });
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: [symmetricCylinder("a", 0, "FRONT"), symmetricCylinder("b", 1, "BACK")],
    decisions: [],
  });
  assert.equal(summary.symmetryClass, "ROTATIONAL");
  assert.equal(summary.coverageMap.COMPLETE_PRODUCT.confirmedFamilyCount, 1);
  assert.deepEqual(summary.coverageMap.COMPLETE_PRODUCT.confirmedFamilies, ["ROTATIONAL"]);
  assert.equal(summary.coverageMap.FRONT, undefined);
  assert.equal(summary.coverageMap.BACK, undefined);
  assert.deepEqual(summary.coverageMap.ROTATIONAL.assetIds, ["a", "b"]);
});

test("rotational symmetry collapses only horizontal exterior directions", () => {
  const symmetric = (sourceAssetId, sourceOrdinal, viewpoint) => productAssessment(sourceAssetId, viewpoint, {
    sourceOrdinal, reasonCodes: ["ROTATIONAL_SYMMETRY_CONFIRMED"],
  });
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: [symmetric("front", 0, "FRONT"), symmetric("top", 1, "TOP")], decisions: [],
  });
  assert.equal(summary.coverageMap.COMPLETE_PRODUCT.confirmedFamilyCount, 2);
  assert.deepEqual(summary.coverageMap.COMPLETE_PRODUCT.confirmedFamilies, ["ROTATIONAL", "TOP"]);
  assert.deepEqual(summary.coverageMap.TOP.assetIds, ["top"]);
  assert.ok(!summary.coverageMap.COMPLETE_PRODUCT.prohibitedViews.includes("TOP"));
});

test("three-quarter viewpoints contribute to their adjacent front or back and side families", () => {
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture(),
    assessments: [
      productAssessment("front-right", "FRONT_RIGHT_3_4", { sourceOrdinal: 0 }),
      productAssessment("back-left", "BACK_LEFT_3_4", { sourceOrdinal: 1 }),
    ], decisions: [],
  });
  assert.deepEqual(summary.coverageMap.FRONT.assetIds, ["front-right"]);
  assert.deepEqual(summary.coverageMap.RIGHT.assetIds, ["front-right"]);
  assert.deepEqual(summary.coverageMap.BACK.assetIds, ["back-left"]);
  assert.deepEqual(summary.coverageMap.LEFT.assetIds, ["back-left"]);
  assert.equal(summary.coverageMap.COMPLETE_PRODUCT.confirmedFamilyCount, 4);
});

test("a manual decision replaces one asset disposition then recomputes the whole immutable summary", () => {
  const assessments = [
    productAssessment("front", "FRONT", { sourceOrdinal: 0 }),
    productAssessment("back", "BACK", { sourceOrdinal: 1, markings: [uncertainSubjectMarking()] }),
  ];
  const unresolved = reconcileSourceImageAssessments({ sourceCapture: capture(), assessments, decisions: [] });
  const decided = reconcileSourceImageAssessments({
    sourceCapture: capture(), assessments,
    decisions: [{ sourceAssetId: "back", decision: "PRODUCT_MARKING", decisionHash: "d".repeat(64) }],
  });
  assert.deepEqual(
    decided.markingDecisions.find((entry) => entry.sourceAssetId === "front"),
    unresolved.markingDecisions.find((entry) => entry.sourceAssetId === "front"),
  );
  assert.equal(decided.markingDecisions.find((entry) => entry.sourceAssetId === "back").kind, "PRODUCT_MARKING");
  assert.equal(decided.markingDecisions.find((entry) => entry.sourceAssetId === "back").decisionMethod, "MANUAL_DECISION");
  assert.deepEqual(decided.requiredConfirmations, []);
  assert.ok(decided.eligibleAssetIds.includes("back"));
  assert.deepEqual(decided.coverageMap.BACK.assetIds, ["back"]);
  assert.notEqual(decided.summaryHash, unresolved.summaryHash);
  assert.equal(Object.isFrozen(decided), true);
  assert.equal(Object.isFrozen(decided.coverageMap), true);
});

test("reconciliation is deterministic across assessment input ordering", () => {
  const assessments = [
    productAssessment("back", "BACK", { sourceOrdinal: 1 }),
    productAssessment("front", "FRONT", { sourceOrdinal: 0 }),
  ];
  const left = reconcileSourceImageAssessments({ sourceCapture: capture(), assessments, decisions: [] });
  const right = reconcileSourceImageAssessments({ sourceCapture: capture(), assessments: assessments.toReversed(), decisions: [] });
  assert.deepEqual(left, right);
  assert.equal(left.summaryHash, right.summaryHash);
});

test("decisions defaults to an empty immutable decision set", () => {
  const assessments = [productAssessment("front", "FRONT", { sourceOrdinal: 0 })];
  const implicit = reconcileSourceImageAssessments({ sourceCapture: capture(), assessments });
  const explicit = reconcileSourceImageAssessments({ sourceCapture: capture(), assessments, decisions: [] });
  assert.deepEqual(implicit, explicit);
});
