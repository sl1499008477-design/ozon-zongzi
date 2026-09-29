import sharp from "sharp";
import { sha256 } from "./auto-listing-asset-store.mjs";
import {
  sourceImageCleanupInputHash,
  verifySourceImageCleanupInput,
} from "./auto-listing-source-image-cleanup-contract.mjs";
import { storeSourceImageDerivative } from "./auto-listing-source-image-derivative-store.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const CLEANUP_MARGIN_RATIO = 0.015;
const CLEANUP_MARGIN_MIN = 2;
const CLEANUP_MARGIN_MAX = 18;

function failure(code = "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_INPUT_INVALID", retryable = false) {
  return Object.assign(new Error(code), { code, retryable });
}

function safeId(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 300 && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u.test(value);
}

function attemptScope(scope) {
  return {
    accountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId,
    analysisRunId: scope.analysisRunId, sourceAssetId: scope.sourceAssetId,
    expectedStatusVersion: scope.expectedStatusVersion, derivativeAttemptId: scope.derivativeAttemptId,
  };
}

function validScope(scope) {
  return scope && typeof scope === "object" && !Array.isArray(scope)
    && [scope.accountId, scope.jobId, scope.itemId, scope.analysisRunId,
      scope.sourceAssetId, scope.derivativeAttemptId].every(safeId)
    && Number.isInteger(scope.expectedStatusVersion) && scope.expectedStatusVersion >= 1
    && HASH.test(scope.inputHash || "")
    && Number.isInteger(scope.attemptNo) && scope.attemptNo >= 1 && scope.attemptNo <= 3;
}

function validOriginal(original) {
  return original && typeof original === "object" && !Array.isArray(original)
    && Buffer.isBuffer(original.bytes) && original.bytes.length > 0 && original.bytes.length <= 8 * 1024 * 1024
    && ["image/png", "image/jpeg", "image/webp"].includes(original.contentType)
    && HASH.test(original.contentHash || "") && original.contentHash === sha256(original.bytes)
    && Number.isInteger(original.width) && original.width > 0
    && Number.isInteger(original.height) && original.height > 0;
}

function validProfile(profile, accountId) {
  return profile && typeof profile === "object" && !Array.isArray(profile)
    && safeId(profile.id) && profile.accountId === accountId
    && Number.isInteger(profile.configVersion) && profile.configVersion >= 1
    && safeId(profile.imageModel);
}

function validExecution(value) {
  return value === null || (value && typeof value === "object" && !Array.isArray(value)
    && safeId(value.connectionId) && Number.isInteger(value.connectionVersion) && value.connectionVersion >= 1
    && value.idleTimeoutMs === 300_000);
}

function promptFor(input) {
  return [
    "Edit the supplied product photo only; do not redesign or recreate the product.",
    "The supplied source image is the immutable reference photo on a padded canvas.",
    "The API edit mask identifies the only pixels that may be repaired; every unmasked pixel must stay pixel-aligned and unchanged.",
    `Remove only external canvas overlays inside the edit mask derived from externalRegions: ${JSON.stringify(input.externalRegions)}.`,
    `Never edit protected product-native regions: ${JSON.stringify(input.protectedRegions)}.`,
    "Preserve product-native Logo, brand marks, model text, nameplate, and original surface printing exactly.",
    "Preserve product geometry, structure, color, material, quantity, cable, ports, accessories, crop, pose, perspective, and camera angle.",
    "Fill removed overlay pixels only from the surrounding background or directly visible product surface.",
    "Return the same canvas size and alignment as sourceImages[0]; never zoom, crop, reframe, rotate, or move the product.",
    "Do not add text, parts, functions, props, packaging, hidden structure, or a new viewing angle.",
    input.previousReasonCodes.length > 0
      ? `Correct only these prior checker findings: ${JSON.stringify(input.previousReasonCodes)}.`
      : "There are no prior checker findings.",
  ].join("\n");
}

function imageSize(original) {
  if (original.width > original.height * 1.1) return "1536x1024";
  if (original.height > original.width * 1.1) return "1024x1536";
  return "1024x1024";
}

function sizePixels(size) {
  const [width, height] = size.split("x").map(Number);
  return { width, height };
}

function fittedRect(original, target) {
  const scale = Math.min(target.width / original.width, target.height / original.height);
  const width = Math.max(1, Math.min(target.width, Math.round(original.width * scale)));
  const height = Math.max(1, Math.min(target.height, Math.round(original.height * scale)));
  return {
    left: Math.floor((target.width - width) / 2),
    top: Math.floor((target.height - height) / 2),
    width,
    height,
  };
}

function regionPixels(region, width, height) {
  const left = Math.max(0, Math.min(width - 1, Math.floor(region.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(region.y * height)));
  const right = Math.max(left + 1, Math.min(width, Math.ceil((region.x + region.width) * width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil((region.y + region.height) * height)));
  return { left, top, right, bottom };
}

function cleanupMargin(width, height) {
  return Math.max(CLEANUP_MARGIN_MIN, Math.min(CLEANUP_MARGIN_MAX,
    Math.round(Math.min(width, height) * CLEANUP_MARGIN_RATIO)));
}

function expandedRegionPixels(region, width, height, padding) {
  const rect = regionPixels(region, width, height);
  return {
    left: Math.max(0, rect.left - padding),
    top: Math.max(0, rect.top - padding),
    right: Math.min(width, rect.right + padding),
    bottom: Math.min(height, rect.bottom + padding),
  };
}

function paintMask(data, width, height, regions, alpha, padding = 0) {
  for (const region of regions) {
    const rect = expandedRegionPixels(region, width, height, padding);
    for (let y = rect.top; y < rect.bottom; y += 1) {
      for (let x = rect.left; x < rect.right; x += 1) {
        const offset = (y * width + x) * 4;
        data[offset] = 255;
        data[offset + 1] = 255;
        data[offset + 2] = 255;
        data[offset + 3] = alpha;
      }
    }
  }
}

function paintFeatheredMask(data, width, height, regions, padding) {
  const feather = Math.max(1, Math.ceil(padding / 2));
  for (const region of regions) {
    const rect = expandedRegionPixels(region, width, height, padding);
    for (let y = rect.top; y < rect.bottom; y += 1) {
      for (let x = rect.left; x < rect.right; x += 1) {
        const edgeDistance = Math.min(
          x - rect.left + 1,
          rect.right - x,
          y - rect.top + 1,
          rect.bottom - y,
        );
        const alpha = edgeDistance > feather
          ? 255 : Math.round((255 * edgeDistance) / (feather + 1));
        const offset = (y * width + x) * 4;
        data[offset] = 255;
        data[offset + 1] = 255;
        data[offset + 2] = 255;
        data[offset + 3] = Math.max(data[offset + 3], alpha);
      }
    }
  }
}

async function cleanupCanvas(original, input, size) {
  const target = sizePixels(size);
  const content = fittedRect(original, target);
  const margin = cleanupMargin(original.width, original.height);
  const modelMaskData = Buffer.alloc(original.width * original.height * 4, 255);
  paintMask(modelMaskData, original.width, original.height, input.externalRegions, 0, margin);
  paintMask(modelMaskData, original.width, original.height, input.protectedRegions, 255, margin);
  const blendMaskData = Buffer.alloc(original.width * original.height * 4);
  paintFeatheredMask(blendMaskData, original.width, original.height, input.externalRegions, margin);
  paintMask(blendMaskData, original.width, original.height, input.protectedRegions, 0, margin);
  const modelMask = await sharp(modelMaskData, {
    raw: { width: original.width, height: original.height, channels: 4 },
  }).png().toBuffer();
  const originalMask = await sharp(blendMaskData, {
    raw: { width: original.width, height: original.height, channels: 4 },
  }).png().toBuffer();
  const resizedOriginal = await sharp(original.bytes, { failOn: "error", animated: false })
    .resize(content.width, content.height, { fit: "fill" }).png().toBuffer();
  const statistics = await sharp(original.bytes, { failOn: "error", animated: false }).stats();
  const background = { ...statistics.dominant, alpha: 1 };
  const reference = await sharp({
    create: { width: target.width, height: target.height, channels: 4, background },
  }).composite([{ input: resizedOriginal, left: content.left, top: content.top }]).png().toBuffer();
  const mask = await sharp(modelMask, { failOn: "error", animated: false })
    .resize(content.width, content.height, { fit: "fill", kernel: "nearest" })
    .extend({
      top: content.top,
      bottom: target.height - content.top - content.height,
      left: content.left,
      right: target.width - content.left - content.width,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png().toBuffer();
  return { target, content, reference, mask, originalMask };
}

async function boundedCleanupBytes(original, generatedBytes, canvas) {
  const targetBytes = await sharp(generatedBytes, { failOn: "error", animated: false })
    .resize(canvas.target.width, canvas.target.height, { fit: "fill" })
    .png().toBuffer();
  const mapped = await sharp(targetBytes, { failOn: "error", animated: false })
    .extract(canvas.content)
    .resize(original.width, original.height, { fit: "fill" })
    .png().toBuffer();
  const patch = await sharp(mapped, { failOn: "error", animated: false }).ensureAlpha()
    .composite([{ input: canvas.originalMask, blend: "dest-in" }]).png().toBuffer();
  return sharp(original.bytes, { failOn: "error", animated: false }).ensureAlpha()
    .composite([{ input: patch, blend: "over" }]).png().toBuffer();
}

export async function cleanSourceImageOverlay({
  scope, cleanupInput: rawCleanupInput, original, profile, gateway, gatewayExecution = null,
  repository, storage = null, cleanupRecorder = null, storeDerivative = storeSourceImageDerivative,
  assertLeaseActive = () => {},
} = {}) {
  let cleanupInput;
  try { cleanupInput = verifySourceImageCleanupInput(rawCleanupInput); }
  catch (caught) { throw caught; }
  if (!validScope(scope) || !validOriginal(original) || !validProfile(profile, scope.accountId)
    || !validExecution(gatewayExecution) || !gateway || typeof gateway.generateImage !== "function"
    || !repository || typeof repository.loadAttempt !== "function"
    || typeof storeDerivative !== "function" || typeof assertLeaseActive !== "function"
    || cleanupInput.derivativeAttemptId !== scope.derivativeAttemptId
    || cleanupInput.sourceAssetId !== scope.sourceAssetId
    || cleanupInput.originalContentHash !== original.contentHash
    || cleanupInput.attemptNo !== scope.attemptNo) {
    throw failure();
  }
  assertLeaseActive();
  const existing = await repository.loadAttempt(attemptScope(scope));
  assertLeaseActive();
  if (!existing) throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_NOT_FOUND");
  if (["GENERATED", "ACCEPTED", "REJECTED"].includes(existing.status)) return existing;
  if (existing.status !== "RESERVED") {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_CLEANUP_ATTEMPT_INVALID");
  }
  const requestInputHash = sourceImageCleanupInputHash(cleanupInput);
  const size = imageSize(original);
  let canvas;
  try { canvas = await cleanupCanvas(original, cleanupInput, size); }
  catch { throw failure(); }
  assertLeaseActive();
  let generated;
  try {
    generated = await gateway.generateImage({
      profile,
      model: profile.imageModel,
      correlationId: `auto-listing-source-cleanup:${scope.derivativeAttemptId}`,
      requestKey: `source-cleanup-${requestInputHash}-attempt-${scope.attemptNo}`,
      idleTimeoutMs: gatewayExecution?.idleTimeoutMs ?? 300_000,
      prompt: promptFor(cleanupInput),
      sourceImages: Object.freeze([
        { contentType: "image/png", bytes: canvas.reference },
      ]),
      editMask: Object.freeze({ contentType: "image/png", bytes: canvas.mask }),
      size,
      quality: "high",
      outputFormat: "png",
    });
  } catch (caught) {
    assertLeaseActive();
    throw caught;
  }
  assertLeaseActive();
  if (!generated || !(generated.bytes instanceof Uint8Array) || !generated.bytes.length
    || !safeId(generated.requestId) || !generated.modelEvidence
    || generated.modelEvidence.requestedImageModel !== profile.imageModel) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_CLEANUP_GATEWAY_INVALID", true);
  }
  let boundedBytes;
  try { boundedBytes = await boundedCleanupBytes(original, Buffer.from(generated.bytes), canvas); }
  catch { throw failure("AUTO_LISTING_SOURCE_IMAGE_CLEANUP_GATEWAY_INVALID", true); }
  assertLeaseActive();
  return storeDerivative({
    scope,
    originalContentHash: original.contentHash,
    generated: {
      bytes: boundedBytes,
      requestId: generated.requestId,
      modelEvidence: structuredClone(generated.modelEvidence),
      gatewayConnectionId: gatewayExecution?.connectionId ?? null,
      gatewayConnectionVersion: gatewayExecution?.connectionVersion ?? null,
    },
    storage,
    repository,
    cleanupRecorder,
    assertLeaseActive,
  });
}
