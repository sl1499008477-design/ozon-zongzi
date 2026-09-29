import { types } from "node:util";

import {
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS,
  SOURCE_IMAGE_TEXT_SEMANTIC_KINDS,
} from "./auto-listing-source-image-intelligence-contract.mjs";

const INPUT_KEYS = new Set(["contractVersion", "sourceFacts", "images"]);
const IMAGE_KEYS = new Set(["sourceAssetId", "sourceOrdinal", "contentType", "bytes"]);
const EXECUTION_KEYS = new Set(["channelId", "connectionId", "connectionVersion", "idleTimeoutMs"]);
const IDENTITY_KEYS = new Set(["correlationId", "requestKey"]);
const CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const FORBIDDEN_FACT_KEY = /(?:url|uri|object.?key|credential|secret|token|authorization|api.?key)/iu;
const URL_VALUE = /(?:https?|ftp|file|data):|www\./iu;
const MAX_FACT_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 32 * 1024 * 1024;
const COMPLETE_PRODUCT_VIEW_KINDS = new Set([
  "FRONT", "BACK", "LEFT", "RIGHT", "FRONT_LEFT_3_4", "FRONT_RIGHT_3_4",
  "BACK_LEFT_3_4", "BACK_RIGHT_3_4", "TOP", "BOTTOM", "INTERIOR",
]);

function failure() {
  return Object.assign(new Error("来源图片 AI 分析请求无效"), {
    code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_ADAPTER_INVALID",
    retryable: false,
  });
}

function plain(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value) && !types.isProxy(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  } catch { return false; }
}

function closed(raw, keys) {
  try {
    if (!plain(raw)) throw failure();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw failure();
    return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code) throw error;
    throw failure();
  }
}

function identifier(value) {
  return typeof value === "string" && value === value.trim() && SAFE_ID.test(value);
}

function safeFacts(value, active = new Set()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 4_000 && !URL_VALUE.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value)) return value;
  if (!value || typeof value !== "object" || types.isProxy(value) || active.has(value)) throw failure();
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 100) throw failure();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw failure();
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw failure();
        return safeFacts(descriptor.value, active);
      });
    }
    if (!plain(value)) throw failure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 100 || keys.some((key) => typeof key !== "string" || FORBIDDEN_FACT_KEY.test(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw failure();
    return Object.fromEntries(keys.map((key) => [key, safeFacts(descriptors[key].value, active)]));
  } finally { active.delete(value); }
}

function validateExecution(raw, profile) {
  if (raw === null) {
    if (profile.connectionId !== null || profile.connectionVersion !== null) throw failure();
    return null;
  }
  const value = closed(raw, EXECUTION_KEYS);
  if (!identifier(value.channelId) || !identifier(value.connectionId)
    || !Number.isSafeInteger(value.connectionVersion) || value.connectionVersion < 1
    || value.idleTimeoutMs !== 300_000
    || profile.connectionId !== value.connectionId || profile.connectionVersion !== value.connectionVersion) throw failure();
  return Object.freeze(value);
}

function validateProfile(value) {
  if (!plain(value)) throw failure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
    || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw failure();
  const field = (key) => descriptors[key]?.value;
  const legacyConnection = field("connectionId") === null && field("connectionVersion") === null;
  const channelConnection = identifier(field("connectionId"))
    && Number.isSafeInteger(field("connectionVersion")) && field("connectionVersion") >= 1;
  if (!identifier(field("id")) || !identifier(field("accountId"))
    || !Number.isSafeInteger(field("configVersion")) || field("configVersion") < 1
    || !identifier(field("textModel"))
    || (!legacyConnection && !channelConnection)) throw failure();
  return value;
}

function validateIdentity(raw) {
  const value = closed(raw, IDENTITY_KEYS);
  if (!identifier(value.correlationId) || !HASH.test(value.requestKey || "")) throw failure();
  return Object.freeze(value);
}

function validateInput(raw) {
  const input = closed(raw, INPUT_KEYS);
  if (!Object.values(SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS).includes(input.contractVersion)
    || !Array.isArray(input.images) || types.isProxy(input.images)
    || input.images.length < 1 || input.images.length > 6) throw failure();
  const facts = safeFacts(input.sourceFacts);
  if (Buffer.byteLength(JSON.stringify(facts), "utf8") > MAX_FACT_BYTES) throw failure();
  let aggregateBytes = 0;
  const images = input.images.map((rawImage) => {
    const image = closed(rawImage, IMAGE_KEYS);
    if (!identifier(image.sourceAssetId) || !Number.isSafeInteger(image.sourceOrdinal) || image.sourceOrdinal < 0
      || image.sourceOrdinal > 9_999 || !CONTENT_TYPES.has(image.contentType) || !Buffer.isBuffer(image.bytes)
      || image.bytes.length < 1 || image.bytes.length > MAX_IMAGE_BYTES) throw failure();
    aggregateBytes += image.bytes.length;
    return Object.freeze({ ...image, bytes: Buffer.from(image.bytes) });
  });
  if (aggregateBytes > MAX_AGGREGATE_BYTES
    || new Set(images.map((image) => image.sourceAssetId)).size !== images.length
    || new Set(images.map((image) => image.sourceOrdinal)).size !== images.length) throw failure();
  return Object.freeze({ contractVersion: input.contractVersion, sourceFacts: facts, images });
}

function observationSchema(sourceAssetIds, contractVersion) {
  const confidence = { type: "string", enum: ["CONFIRMED", "TENTATIVE", "UNCERTAIN"] };
  const reasonCodes = { type: "array", maxItems: 20,
    items: { type: "string", pattern: "^[A-Z0-9][A-Z0-9_:-]{0,119}$" } };
  const bounds = {
    type: ["object", "null"],
    properties: {
      x: { type: "number", minimum: 0, maximum: 1 },
      y: { type: "number", minimum: 0, maximum: 1 },
      width: { type: "number", exclusiveMinimum: 0, maximum: 1 },
      height: { type: "number", exclusiveMinimum: 0, maximum: 1 },
    },
    required: ["x", "y", "width", "height"], additionalProperties: false,
  };
  const observation = {
    type: "object",
    properties: {
      sourceAssetId: { type: "string", enum: sourceAssetIds },
      contentKinds: { type: "array", maxItems: 7, items: { type: "string", enum: [
        "PRODUCT_VIEW", "PRODUCT_DETAIL", "USAGE_SCENE", "PACKAGE", "TEXT_ONLY", "MIXED", "OTHER",
      ] } },
      viewpoints: { type: "array", maxItems: 12, items: { type: "object", properties: {
        kind: { type: "string", enum: ["FRONT", "BACK", "LEFT", "RIGHT", "FRONT_LEFT_3_4", "FRONT_RIGHT_3_4", "BACK_LEFT_3_4", "BACK_RIGHT_3_4", "TOP", "BOTTOM", "INTERIOR", "DETAIL", "SCENE", "PACKAGE", "UNKNOWN"] },
        confidence, reasonCodes,
      }, required: ["kind", "confidence", "reasonCodes"], additionalProperties: false } },
      subjectBounds: bounds,
      quality: { type: ["object", "null"], properties: { confidence, usable: { type: "boolean" }, reasonCodes },
        required: ["confidence", "usable", "reasonCodes"], additionalProperties: false },
      ocrRegions: { type: "array", maxItems: 20, items: { type: "object", properties: {
        text: { type: "string", minLength: 1, maxLength: 500 }, region: bounds,
        language: { type: ["string", "null"], maxLength: 32 }, confidence,
      }, required: ["text", "region", "language", "confidence"], additionalProperties: false } },
      markings: { type: "array", maxItems: 20, items: { type: "object", properties: {
        kind: { type: "string", enum: ["PRODUCT_MARKING", "EXTERNAL_OVERLAY", "UNCERTAIN_MARKING"] },
        region: bounds, confidence, reasonCodes,
      }, required: ["kind", "region", "confidence", "reasonCodes"], additionalProperties: false } },
      perceptualDuplicateGroup: { type: ["string", "null"], maxLength: 240 },
      eligibleUses: { type: "array", maxItems: 8, items: { type: "string", enum: [
        "IDENTITY_ANCHOR", "TARGET_VIEW", "DETAIL", "SCENE", "PACKAGE", "TEXT_FACT", "UNUSABLE",
      ] } },
      reasonCodes,
    },
    required: ["sourceAssetId", "contentKinds", "viewpoints", "subjectBounds", "quality", "ocrRegions",
      "markings", "perceptualDuplicateGroup", "eligibleUses", "reasonCodes"],
    additionalProperties: false,
  };
  if (contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2) {
    const viewpoint = observation.properties.viewpoints.items;
    viewpoint.properties.completeProductVisible = { type: "boolean" };
    viewpoint.required = [...viewpoint.required, "completeProductVisible"];
    delete observation.properties.ocrRegions;
    delete observation.properties.markings;
    observation.properties.textRegions = {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          sourceText: { type: "string", minLength: 1, maxLength: 500 },
          language: { type: "string", minLength: 1, maxLength: 32 },
          region: bounds,
          confidence,
          semanticKind: { type: "string", enum: [...SOURCE_IMAGE_TEXT_SEMANTIC_KINDS] },
          normalizedMeaning: { type: "string", minLength: 1, maxLength: 500 },
          sequence: { type: ["integer", "null"], minimum: 1, maximum: 100 },
          semanticReasonCodes: reasonCodes,
          markingKind: {
            type: "string", enum: ["PRODUCT_MARKING", "EXTERNAL_OVERLAY", "UNCERTAIN_MARKING"],
          },
          markingConfidence: confidence,
          markingReasonCodes: reasonCodes,
        },
        required: [
          "sourceText", "language", "region", "confidence", "semanticKind", "normalizedMeaning", "sequence",
          "semanticReasonCodes", "markingKind", "markingConfidence", "markingReasonCodes",
        ],
        additionalProperties: false,
      },
    };
    observation.properties.graphicalMarkings = {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["PRODUCT_MARKING", "EXTERNAL_OVERLAY", "UNCERTAIN_MARKING"] },
          region: bounds,
          confidence,
          reasonCodes,
        },
        required: ["kind", "region", "confidence", "reasonCodes"],
        additionalProperties: false,
      },
    };
    observation.required = observation.required.filter((key) => !["ocrRegions", "markings"].includes(key));
    observation.required.splice(observation.required.indexOf("perceptualDuplicateGroup"), 0,
      "textRegions", "graphicalMarkings");
  }
  return { type: "object", properties: {
    observations: { type: "array", minItems: sourceAssetIds.length, maxItems: sourceAssetIds.length, items: observation },
  }, required: ["observations"], additionalProperties: false };
}

function promptFor(input) {
  const manifest = input.images.map(({ sourceAssetId, sourceOrdinal, contentType }) => ({
    sourceAssetId, sourceOrdinal, contentType,
  }));
  const instructions = [
    "Analyze only the supplied product-image bytes and return one observation per manifest entry.",
    `Contract: ${input.contractVersion}.`,
    `Source facts: ${JSON.stringify(input.sourceFacts)}.`,
    `Image manifest: ${JSON.stringify(manifest)}.`,
    "Return unique uppercase machine reason codes only, for example LOW_LIGHT or VIEW_OBSCURED; never return prose in reasonCodes.",
    "For every non-null normalized region, width and height must be greater than 0, and x + width and y + height must each be at most 1; use null when a valid region is uncertain.",
    "For every region, x and y are top-left coordinates; width and height are spans, never right or bottom coordinates.",
    "subjectBounds must tightly contain the entire visible physical product, including handles, cables, attached parts, and visible accessories; exclude seller text, badges, dimension lines, and unrelated props.",
    "Preserve observed confidence exactly; never upgrade tentative or uncertain evidence.",
    "Certification symbols are only visual markings and do not authorize certification claims.",
    "Text-only images do not prove product appearance or hidden structure.",
    "Viewpoint classification describes the camera view of the physical product, not text density, marketing layout, or how much canvas the product occupies.",
    "When the complete defining housing is visible, classify its visible face as FRONT, BACK, LEFT, RIGHT, TOP, or BOTTOM; attached cable ends may leave the canvas and must not turn that product view into DETAIL.",
    "A marketing layout may be text-dominant and still contain a usable product view; visible copy never makes a clearly identifiable physical product UNUSABLE.",
    "Use DETAIL only when the crop omits significant outer product boundaries and truly shows a local component, material, interface, or internal region.",
    "Classify an external overlay only from visible placement and perspective, never by guessing a brand.",
  ];
  if (input.contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2) instructions.push(
    "For every viewpoint set completeProductVisible=true only when the complete defining silhouette and all major components are visible; set it false for a crop, inset, isolated base, local component, or any view that omits a major part, even when its visible face has a clear direction.",
    "Set completeProductVisible=true when one whole product instance is not cropped by the image boundary or an inset, even when another variant, prop, label, or product instance is also present.",
    "Normal perspective self-occlusion does not mean completeProductVisible=false; judge whether the photographed whole unit is framed, not whether naturally hidden rear or underside surfaces are visible.",
    "A directional crop may still use its observed camera direction in the wire response, but it is partial evidence and must not count as a complete product angle.",
    "Before any cleanup or removal, recognize and classify every visible text region as exactly one textRegions entry.",
    "Each textRegions entry must bind OCR text, semantic meaning, and PRODUCT_MARKING, EXTERNAL_OVERLAY, or UNCERTAIN_MARKING classification in the same object.",
    `semanticKind must be one of: ${SOURCE_IMAGE_TEXT_SEMANTIC_KINDS.join(", ")}.`,
    "Use sequence 1 through 100 only for ordered USAGE_STEP text; use null for every other semantic kind.",
    "Preserve the literal meaning of useful selling points, usage, steps, specifications, package contents, cautions, and product identity without inventing facts.",
    "Classify canvas watermarks, seller logos, URLs, contact details, and promotional copy separately from product-native logos, model text, and nameplates.",
    "Product-native logos, model text, and nameplates belong to the product and must be preserved.",
    "Any text physically printed, engraved, molded, screened, or adhered on the product body belongs to the product; this includes each numeric rating such as 20A, 250VAC, or 50HZ and must be emitted as PRODUCT_MARKING even when it is absent from sourceFacts.",
    "For a single coherent product view, every confirmed PRODUCT_MARKING must have the center of its matching OCR region inside subjectBounds; when text is physically on the product, expand subjectBounds to include the full visible product rather than moving or reclassifying the text.",
    "For a collage with multiple distinct product panels or insets, subjectBounds may cover the primary product group; still recognize and classify product-native text on every secondary product view with its own tight OCR region.",
    "Dimension labels placed on the canvas beside the product or along guide lines, for example 21CM, 23CM, and 13CM, are EXTERNAL_OVERLAY even when their rectangles overlap subjectBounds.",
    "Reason codes must match the text type; never use a DIMENSION, MEASUREMENT, or SIZE reason for non-numeric product identity text.",
    "Use repeated visible evidence across supplied images: a logo or nameplate printed on the product in one image remains product-native in other views.",
    "Use PRODUCT_MARKING for product-native text, EXTERNAL_OVERLAY for canvas or seller text, and UNCERTAIN_MARKING only when placement is genuinely ambiguous.",
    "graphicalMarkings is only for a visible non-text seller logo or watermark; use one tight region around only that graphic.",
    "For EXTERNAL_OVERLAY, use a tight rectangle around the actual visible overlay pixels; never include unrelated background or product pixels. A badge border, icon, or shadow may be included only when it is visibly part of the same local overlay.",
  );
  return instructions.join("\n");
}

function normalizeModelText(value) {
  if (typeof value !== "string") return value;
  return value.replace(/[\p{White_Space}\u0000-\u001f\u007f]+/gu, " ").trim();
}

function normalizeResult(value, contractVersion) {
  if (contractVersion !== SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2
    || !plain(value) || !Array.isArray(value.observations)) return value;
  return {
    observations: value.observations.map((observation) => {
      if (!plain(observation) || !Array.isArray(observation.textRegions)
        || !Array.isArray(observation.graphicalMarkings)) return observation;
      const { textRegions, graphicalMarkings, viewpoints, ...rest } = observation;
      return {
        ...rest,
        viewpoints: Array.isArray(viewpoints) ? viewpoints.map((viewpoint) => {
          if (!plain(viewpoint) || typeof viewpoint.completeProductVisible !== "boolean") return viewpoint;
          const { completeProductVisible, ...normalized } = viewpoint;
          const completionReason = completeProductVisible
            ? "COMPLETE_PRODUCT_VISIBLE" : "PARTIAL_PRODUCT_ONLY";
          const normalizedReasons = Array.isArray(normalized.reasonCodes)
            && !normalized.reasonCodes.includes(completionReason)
            ? [...normalized.reasonCodes, completionReason] : normalized.reasonCodes;
          return {
            ...normalized,
            kind: !completeProductVisible && COMPLETE_PRODUCT_VIEW_KINDS.has(normalized.kind)
              ? "DETAIL" : normalized.kind,
            reasonCodes: normalizedReasons,
          };
        }) : viewpoints,
        ocrRegions: textRegions.map((region) => ({
          text: normalizeModelText(region.sourceText),
          region: region.region,
          language: normalizeModelText(region.language),
          confidence: region.confidence,
        })),
        semanticTextRegions: textRegions.map((region) => ({
          sourceText: normalizeModelText(region.sourceText),
          language: normalizeModelText(region.language),
          region: region.region,
          confidence: region.confidence,
          semanticKind: region.semanticKind,
          normalizedMeaning: normalizeModelText(region.normalizedMeaning),
          sequence: region.sequence,
          reasonCodes: region.semanticReasonCodes,
        })),
        markings: [
          ...textRegions.map((region) => ({
            kind: region.markingKind,
            region: region.region,
            confidence: region.markingConfidence,
            reasonCodes: region.markingReasonCodes,
          })),
          ...graphicalMarkings,
        ],
      };
    }),
  };
}

export function createSourceImageAnalysisAiAdapter({ gateway, profile: rawProfile, gatewayExecution: rawExecution,
  requestIdentity: rawIdentity } = {}) {
  if (!gateway || typeof gateway.createTextResponse !== "function") throw failure();
  const profile = validateProfile(rawProfile);
  const gatewayExecution = validateExecution(rawExecution, profile);
  const requestIdentity = validateIdentity(rawIdentity);
  return Object.freeze({
    async analyzeSourceImages(rawInput = {}) {
      const input = validateInput(rawInput);
      const response = await gateway.createTextResponse({
        profile,
        model: profile.textModel,
        prompt: promptFor(input),
        sourceImages: input.images.map(({ bytes, contentType }) => ({ bytes: Buffer.from(bytes), contentType })),
        jsonSchema: observationSchema(input.images.map(({ sourceAssetId }) => sourceAssetId), input.contractVersion),
        correlationId: requestIdentity.correlationId,
        requestKey: requestIdentity.requestKey,
        idleTimeoutMs: gatewayExecution?.idleTimeoutMs ?? 300_000,
      });
      if (!plain(response) || !Object.hasOwn(response, "value")) throw failure();
      return normalizeResult(response.value, input.contractVersion);
    },
  });
}
