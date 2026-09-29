import sharp from "sharp";

async function png(seed) {
  const red = (seed * 53) % 256;
  const green = (seed * 97) % 256;
  const blue = (seed * 193) % 256;
  return sharp({
    create: { width: 24 + (seed % 3), height: 24 + (seed % 5), channels: 3, background: { r: red, g: green, b: blue } },
  }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

async function jpeg(seed) {
  const red = (seed * 71) % 256;
  const green = (seed * 131) % 256;
  const blue = (seed * 211) % 256;
  return sharp({
    create: { width: 25 + (seed % 4), height: 25 + (seed % 6), channels: 3, background: { r: red, g: green, b: blue } },
  }).jpeg({ quality: 82, chromaSubsampling: "4:4:4" }).toBuffer();
}

const subjectRegion = Object.freeze({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
const productMarkingRegion = Object.freeze({ x: 0.28, y: 0.3, width: 0.18, height: 0.08 });
const overlayRegion = Object.freeze({ x: 0.78, y: 0.03, width: 0.18, height: 0.08 });

function image(assetId, bytes, options = {}) {
  return Object.freeze({
    assetId,
    bytes,
    contentType: options.contentType || "image/png",
    terminalFailure: options.terminalFailure || null,
    contentKinds: Object.freeze(options.contentKinds || ["PRODUCT_VIEW"]),
    viewpoint: options.viewpoint || "FRONT",
    subjectBounds: options.subjectBounds === undefined ? subjectRegion : options.subjectBounds,
    quality: Object.freeze(options.quality || { confidence: "CONFIRMED", usable: true, reasonCodes: [] }),
    ocrRegions: Object.freeze(options.ocrRegions || []),
    semanticTextRegions: Object.freeze(options.semanticTextRegions || []),
    markings: Object.freeze(options.markings || []),
    perceptualDuplicateGroup: options.perceptualDuplicateGroup || null,
    eligibleUses: Object.freeze(options.eligibleUses || ["IDENTITY_ANCHOR", "TARGET_VIEW"]),
    reasonCodes: Object.freeze(options.reasonCodes || []),
  });
}

function textImage(assetId, bytes, text, options = {}) {
  const region = null;
  const confidence = "CONFIRMED";
  const language = "ru";
  return image(assetId, bytes, {
    ...options,
    contentKinds: ["TEXT_ONLY"],
    viewpoint: "UNKNOWN",
    subjectBounds: null,
    ocrRegions: [{ text, region, language, confidence }],
    semanticTextRegions: [{
      sourceText: text,
      language,
      region,
      confidence,
      semanticKind: options.semanticKind || "OTHER",
      normalizedMeaning: options.normalizedMeaning || text,
      sequence: options.semanticKind === "USAGE_STEP" ? (options.sequence || 1) : null,
      reasonCodes: [],
    }],
    eligibleUses: ["TEXT_FACT"],
  });
}

function product(name, assets, structuredFacts = []) {
  return Object.freeze({ name, assets: Object.freeze(assets), structuredFacts: Object.freeze(structuredFacts) });
}

function fixture(name, products, { requiresConfirmation = false } = {}) {
  return Object.freeze({
    name,
    products: Object.freeze(products),
    uniqueSourceAssetCount: products.reduce((total, entry) => total + new Set(entry.assets.map(({ assetId }) => assetId)).size, 0),
    requiresConfirmation,
  });
}

const buffers = await Promise.all(Array.from({ length: 40 }, (_, index) => index % 3 === 0 ? jpeg(index + 1) : png(index + 1)));

export const multiViewComplete = fixture("multiViewComplete", [product("multi", [
  image("multi-front", buffers[0], { viewpoint: "FRONT", contentType: "image/jpeg" }),
  image("multi-back", buffers[1], { viewpoint: "BACK" }),
  image("multi-right", buffers[2], { viewpoint: "RIGHT" }),
  image("multi-detail", buffers[3], { contentKinds: ["PRODUCT_DETAIL"], viewpoint: "DETAIL", contentType: "image/jpeg", eligibleUses: ["DETAIL"] }),
  image("multi-package", buffers[4], { contentKinds: ["PACKAGE"], viewpoint: "PACKAGE", eligibleUses: ["PACKAGE", "TEXT_FACT"] }),
  textImage("multi-text", buffers[5], "Материал: сталь", { semanticKind: "SPECIFICATION" }),
], [{ kind: "MATERIAL", value: "сталь" }])]);

export const singleViewWithText = fixture("singleViewWithText", [product("single", [
  image("single-front", buffers[6], { viewpoint: "FRONT", contentType: "image/jpeg" }),
  textImage("single-text-material", buffers[7], "Материал: сталь", { semanticKind: "SPECIFICATION" }),
  textImage("single-text-quantity", buffers[8], "3 штуки", { semanticKind: "PACKAGE_CONTENT" }),
  textImage("single-text-promo", buffers[9], "Скидка 50% seller.example", {
    contentType: "image/jpeg", semanticKind: "PROMOTION",
  }),
], [{ kind: "MATERIAL", value: "сталь" }, { kind: "PACKAGE_QUANTITY", value: "3" }])]);

export const intrinsicLogoAndOverlay = fixture("intrinsicLogoAndOverlay", [product("markings", [
  image("marking-front", buffers[10], {
    contentKinds: ["MIXED"],
    viewpoint: "FRONT",
    markings: [{ kind: "PRODUCT_MARKING", region: productMarkingRegion, confidence: "CONFIRMED", reasonCodes: ["SURFACE_PERSPECTIVE"] }],
    ocrRegions: [{ text: "Acme", region: productMarkingRegion, language: "en", confidence: "CONFIRMED" }],
    semanticTextRegions: [{
      sourceText: "Acme", language: "en", region: productMarkingRegion, confidence: "CONFIRMED",
      semanticKind: "PRODUCT_IDENTITY", normalizedMeaning: "Acme", sequence: null, reasonCodes: [],
    }],
  }),
  image("marking-right", buffers[11], { viewpoint: "RIGHT" }),
  image("marking-overlay", buffers[12], {
    contentKinds: ["MIXED"],
    viewpoint: "BACK",
    contentType: "image/jpeg",
    markings: [{ kind: "EXTERNAL_OVERLAY", region: overlayRegion, confidence: "CONFIRMED", reasonCodes: ["FIXED_CANVAS_POSITION"] }],
    ocrRegions: [{ text: "seller.example", region: overlayRegion, language: "en", confidence: "CONFIRMED" }],
    semanticTextRegions: [{
      sourceText: "seller.example", language: "en", region: overlayRegion, confidence: "CONFIRMED",
      semanticKind: "EXTERNAL_OVERLAY", normalizedMeaning: "Seller watermark", sequence: null, reasonCodes: [],
    }],
  }),
])]);

export const subjectOverlayAmbiguous = fixture("subjectOverlayAmbiguous", [product("ambiguous", [
  image("ambiguous-front", buffers[13], { viewpoint: "FRONT" }),
  image("ambiguous-back", buffers[14], {
    viewpoint: "BACK",
    markings: [{ kind: "UNCERTAIN_MARKING", region: productMarkingRegion, confidence: "UNCERTAIN", reasonCodes: ["SUBJECT_OVERLAP"] }],
  }),
])], { requiresConfirmation: true });

const duplicateOriginal = buffers[15];
export const duplicatesAndBroken = fixture("duplicatesAndBroken", [product("duplicates", [
  image("duplicate-front", duplicateOriginal, {
    viewpoint: "FRONT",
    contentType: "image/jpeg",
    perceptualDuplicateGroup: "near-front",
  }),
  image("duplicate-exact", duplicateOriginal, { viewpoint: "FRONT", contentType: "image/jpeg" }),
  image("duplicate-near", buffers[16], { viewpoint: "FRONT", perceptualDuplicateGroup: "near-front" }),
  image("duplicate-low", buffers[17], {
    viewpoint: "RIGHT",
    quality: { confidence: "CONFIRMED", usable: false, reasonCodes: ["LOW_RESOLUTION"] },
    eligibleUses: [],
  }),
  image("duplicate-corrupt", Buffer.from("not-an-image", "utf8"), { terminalFailure: "UNSUPPORTED_MEDIA" }),
  image("duplicate-unavailable", null, { terminalFailure: "DOWNLOAD_FAILED" }),
])]);

const manyViews = ["FRONT", "BACK", "RIGHT", "LEFT", "DETAIL", "PACKAGE", "FRONT", "BACK", "RIGHT", "DETAIL", "FRONT", "BACK", "RIGHT"];
export const moreThanTenImages = fixture("moreThanTenImages", [product("many", manyViews.map((viewpoint, index) =>
  image(`many-${String(index + 1).padStart(2, "0")}`, buffers[18 + index], {
    viewpoint,
    contentKinds: viewpoint === "DETAIL" ? ["PRODUCT_DETAIL"] : viewpoint === "PACKAGE" ? ["PACKAGE"] : ["PRODUCT_VIEW"],
    eligibleUses: viewpoint === "DETAIL" ? ["DETAIL"] : viewpoint === "PACKAGE" ? ["PACKAGE"] : ["IDENTITY_ANCHOR", "TARGET_VIEW"],
    contentType: (18 + index) % 3 === 0 ? "image/jpeg" : "image/png",
  }))) ]);

export const twoProductsOneChannel = fixture("twoProductsOneChannel", [
  product("shared-a", [
    image("shared-a-front", buffers[32], { viewpoint: "FRONT" }),
    image("shared-a-back", buffers[33], { viewpoint: "BACK", contentType: "image/jpeg" }),
    image("shared-a-right", buffers[34], { viewpoint: "RIGHT" }),
    textImage("shared-a-text", buffers[35], "Материал: сталь", { semanticKind: "SPECIFICATION" }),
  ], [{ kind: "MATERIAL", value: "сталь" }]),
  product("shared-b", [
    image("shared-b-front", buffers[36], { viewpoint: "FRONT", contentType: "image/jpeg" }),
    image("shared-b-back", buffers[37], { viewpoint: "BACK" }),
    image("shared-b-left", buffers[38], { viewpoint: "LEFT" }),
    image("shared-b-text", buffers[39], {
      contentKinds: ["TEXT_ONLY"],
      viewpoint: "UNKNOWN",
      subjectBounds: null,
      contentType: "image/jpeg",
      ocrRegions: [{ text: "Материал: алюминий", region: null, language: "ru", confidence: "CONFIRMED" }],
      semanticTextRegions: [{
        sourceText: "Материал: алюминий", language: "ru", region: null, confidence: "CONFIRMED",
        semanticKind: "SPECIFICATION", normalizedMeaning: "Материал: алюминий", sequence: null, reasonCodes: [],
      }],
      eligibleUses: ["TEXT_FACT"],
    }),
  ], [{ kind: "MATERIAL", value: "алюминий" }]),
]);
