import assert from "node:assert/strict";
import test from "node:test";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";
import { buildVisualGroups } from "../auto-listing-visual-groups.mjs";

const image = (assetId, digit = "a") => ({ assetId, contentHash: digit.repeat(64) });
const fact = (factId, kind, value) => ({ factId, kind, value });
const evidence = (variantId, appearanceFacts, size = "M", overrides = {}) => ({
  contractVersion: 1,
  variantId,
  appearanceStatus: "COMPLETE",
  appearanceFacts,
  sizeFacts: [fact(`fact.size.${variantId}`, "SIZE", size)],
  ...overrides,
});

function sourceCapture(variants) {
  return buildAutoListingSourceSnapshot({
    accountId: "account-a",
    sourceType: "COLLECT_BOX",
    sourceRecordId: "collect-1",
    sourceVersion: "1",
    collectItem: {
      id: "collect-1",
      accountId: "account-a",
      listingDraft: {
        sku: variants[0].sku,
        title: "Термокружка",
        brand: "Brand",
        categoryResolution: { status: "MATCHED", method: "taxonomy", target: { storeId: "store-a", descriptionCategoryId: "170", typeId: "99" } },
        currency: "RUB",
        blackKopecks: "10000",
        greenKopecks: "8000",
        attributes: [],
        logistics: { length: 900, width: 800, height: 700, dimensionUnit: "mm" },
        descriptionCategoryId: "170",
        typeId: "99",
        productMeasurements: { reliable: true, lengthCm: 22, unit: "cm", source: "manufacturer" },
        images: variants[0].images,
        variants: variants.map((variant) => ({
          offerId: `offer-${variant.sku}`,
          name: variant.sku,
          blackKopecks: "10000",
          greenKopecks: "8000",
          currency: "RUB",
          ...variant,
        })),
      },
    },
    productDraft: { id: "draft-1", version: 1 },
    rawResponseRef: "raw-1",
    rawResponseHash: "raw-hash",
  });
}

test("size-only variants with identical complete appearance facts share one stable visual group", () => {
  const red = [fact("fact.color.red", "COLOR", "red"), fact("fact.shape.round", "SHAPE", "round")];
  const capture = sourceCapture([
    { sku: "sku-m", images: [image("image-m", "a")], evidence: evidence("variant-m", red, "M") },
    { sku: "sku-l", images: [image("image-l", "b")], evidence: evidence("variant-l", [...red].reverse(), "L") },
  ]);

  const first = buildVisualGroups({ sourceCapture: capture });
  const second = buildVisualGroups({ sourceCapture: capture });

  assert.equal(first.groups.length, 1);
  assert.deepEqual(first, second);
  assert.match(first.visualGroupsHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.groups[0].sourceSkus, ["sku-l", "sku-m"]);
  assert.deepEqual(first.groups[0].variantIds, ["variant-l", "variant-m"]);
  assert.deepEqual(first.groups[0].referenceImages, [image("image-m", "a"), image("image-l", "b")]
    .map((entry) => ({ ...entry, sourceRef: null, evidenceKind: "CONTENT_HASH" }))
    .sort((a, b) => a.assetId.localeCompare(b.assetId)));
  assert.ok(first.groups[0].reasonCodes.includes("SIZE_ONLY_VARIANTS_SHARED"));
  assert.ok(first.groups[0].factEvidence.some((entry) => entry.factId === "fact.color.red"));
});

test("visible color, pattern, shape, or accessory-count differences always split groups", () => {
  for (const [kind, left, right] of [
    ["COLOR", "red", "blue"],
    ["PATTERN", "plain", "striped"],
    ["SHAPE", "round", "square"],
    ["ACCESSORY_COUNT", "1", "2"],
  ]) {
    const capture = sourceCapture([
      { sku: `sku-${left}`, images: [image(`image-${left}`, "c")], evidence: evidence(`variant-${left}`, [fact(`fact.${kind}.${left}`, kind, left)]) },
      { sku: `sku-${right}`, images: [image(`image-${right}`, "d")], evidence: evidence(`variant-${right}`, [fact(`fact.${kind}.${right}`, kind, right)]) },
    ]);
    const result = buildVisualGroups({ sourceCapture: capture });
    assert.equal(result.groups.length, 2, kind);
    assert.ok(result.groups.every((group) => group.reasonCodes.includes("VISIBLE_APPEARANCE_DIFFERENCE")));
  }
});

test("missing or ambiguous appearance evidence is conservatively split and never inferred from names or logistics", () => {
  const capture = sourceCapture([
    { sku: "red-m", images: [image("same-a", "e")], evidence: null },
    { sku: "red-l", images: [image("same-b", "e")], evidence: evidence("variant-l", [], "L", { appearanceStatus: "AMBIGUOUS" }) },
  ]);
  const result = buildVisualGroups({ sourceCapture: capture });
  assert.equal(result.groups.length, 2);
  assert.ok(result.groups.every((group) => group.reasonCodes.includes("AMBIGUOUS_APPEARANCE_SPLIT")));
  assert.doesNotMatch(JSON.stringify(result), /900|800|700|dimensionUnit/);
});

test("rejects unknown or conflicting V1 visual evidence and unsafe media instead of guessing fields", () => {
  const valid = evidence("variant-1", [fact("fact.color.red", "COLOR", "red")]);
  for (const variant of [
    { sku: "sku-1", images: [image("image-1")], evidence: { ...valid, guessedColor: "red" } },
    { sku: "sku-1", images: [{ ...image("image-1"), url: "https://untrusted.example" }], evidence: valid },
    { sku: "sku-1", images: [image("image-1")], evidence: { ...valid, appearanceFacts: [fact("same", "COLOR", "red"), fact("same", "COLOR", "blue")] } },
  ]) {
    assert.throws(
      () => buildVisualGroups({ sourceCapture: sourceCapture([variant]) }),
      (error) => error?.code === "AUTO_LISTING_VISUAL_EVIDENCE_INVALID",
    );
  }
});

test("rejects unverified captures and unknown top-level input keys", () => {
  const capture = sourceCapture([{ sku: "sku-1", images: [image("image-1")], evidence: evidence("variant-1", [fact("fact.color.red", "COLOR", "red")]) }]);
  assert.throws(() => buildVisualGroups({ sourceCapture: capture, storeId: "forbidden" }), (error) => error?.code === "AUTO_LISTING_VISUAL_EVIDENCE_INVALID");
  assert.throws(() => buildVisualGroups({ sourceCapture: { ...capture, snapshotHash: "0".repeat(64) } }), (error) => error?.code === "AUTO_LISTING_SOURCE_INVALID");
});

test("normalizes current canonical URL media to deterministic non-content-hash references", () => {
  const capture = sourceCapture([{
    sku: "sku-url",
    images: ["https://cdn.example.test/product/red.jpg"],
    evidence: evidence("variant-url", [fact("fact.color.red", "COLOR", "red")]),
  }]);
  const first = buildVisualGroups({ sourceCapture: capture });
  const second = buildVisualGroups({ sourceCapture: capture });
  assert.deepEqual(first, second);
  assert.deepEqual(first.groups[0].referenceImages, [{
    assetId: first.groups[0].referenceImages[0].assetId,
    contentHash: null,
    sourceRef: "https://cdn.example.test/product/red.jpg",
    evidenceKind: "SOURCE_URL",
  }]);
  assert.match(first.groups[0].referenceImages[0].assetId, /^source-url-[a-f0-9]{24}$/);

  const colliding = sourceCapture([{
    sku: "sku-url",
    images: [{ assetId: first.groups[0].referenceImages[0].assetId, contentHash: "f".repeat(64) }, "https://cdn.example.test/product/red.jpg"],
    evidence: evidence("variant-url", [fact("fact.color.red", "COLOR", "red")]),
  }]);
  assert.throws(() => buildVisualGroups({ sourceCapture: colliding }), (error) => error?.code === "AUTO_LISTING_VISUAL_EVIDENCE_INVALID");
});

test("legacy appearance evidence and conflicting V1 kinds are conservative singleton groups", () => {
  const legacy = sourceCapture([
    { sku: "legacy-a", images: [image("legacy-a")], evidence: { guessedColor: "red" } },
    { sku: "legacy-b", images: [image("legacy-b")], evidence: { contractVersion: 0, color: "red" } },
  ]);
  const legacyGroups = buildVisualGroups({ sourceCapture: legacy });
  assert.equal(legacyGroups.groups.length, 2);
  assert.ok(legacyGroups.groups.every((group) => group.reasonCodes.includes("LEGACY_APPEARANCE_EVIDENCE_SINGLETON")));

  const conflicting = sourceCapture([{
    sku: "conflict", images: [image("conflict")], evidence: evidence("variant-conflict", [
      fact("fact.color.red", "COLOR", "red"), fact("fact.color.blue", "COLOR", "blue"),
    ]),
  }]);
  const result = buildVisualGroups({ sourceCapture: conflicting });
  assert.equal(result.groups.length, 1);
  assert.ok(result.groups[0].reasonCodes.includes("CONFLICTING_APPEARANCE_EVIDENCE_SINGLETON"));
  assert.deepEqual(result.groups[0].factEvidence, result.groups[0].factEvidence.filter((entry) => entry.kind === "SIZE"));
});

test("visual evidence ordering is fixed by code point rather than host locale", () => {
  const capture = sourceCapture([
    { sku: "z", images: [image("z")], evidence: evidence("z", [fact("z", "COLOR", "red")]) },
    { sku: "ä", images: [image("ä")], evidence: evidence("ä", [fact("ä", "COLOR", "blue")]) },
  ]);
  const result = buildVisualGroups({ sourceCapture: capture });
  assert.deepEqual(result.groups.flatMap((group) => group.sourceSkus), ["z", "ä"]);
});

test("all non-V1 JSON evidence is singleton-only and source-wide asset identities cannot conflict", () => {
  for (const evidenceValue of ["legacy", 1, true, [], { contractVersion: 2 }]) {
    const capture = sourceCapture([{ sku: `legacy-${typeof evidenceValue}`, images: [image("legacy")], evidence: evidenceValue }]);
    const result = buildVisualGroups({ sourceCapture: capture });
    assert.equal(result.groups.length, 1);
    assert.ok(result.groups[0].reasonCodes.some((reason) => reason.includes("SINGLETON")));
  }
  const collision = sourceCapture([
    { sku: "red", images: [image("shared", "a")], evidence: evidence("red", [fact("red", "COLOR", "red")]) },
    { sku: "blue", images: [image("shared", "b")], evidence: evidence("blue", [fact("blue", "COLOR", "blue")]) },
  ]);
  assert.throws(() => buildVisualGroups({ sourceCapture: collision }), (error) => error?.code === "AUTO_LISTING_VISUAL_EVIDENCE_INVALID");

  const urlOnly = sourceCapture([{
    sku: "url", images: ["https://cdn.example.test/one.jpg"], evidence: evidence("url", [fact("url", "COLOR", "red")]),
  }]);
  const sourceUrlAssetId = buildVisualGroups({ sourceCapture: urlOnly }).groups[0].referenceImages[0].assetId;
  const urlCollision = sourceCapture([
    { sku: "url", images: ["https://cdn.example.test/one.jpg"], evidence: evidence("url", [fact("url", "COLOR", "red")]) },
    { sku: "asset", images: [image(sourceUrlAssetId, "c")], evidence: evidence("asset", [fact("asset", "COLOR", "blue")]) },
  ]);
  assert.throws(() => buildVisualGroups({ sourceCapture: urlCollision }), (error) => error?.code === "AUTO_LISTING_VISUAL_EVIDENCE_INVALID");
});
