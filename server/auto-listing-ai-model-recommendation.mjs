export const RECOMMENDATION_RULE_VERSION = "AUTO_LISTING_MODEL_RECOMMENDATION_V1";
export const MAX_CANDIDATES = 50;

export const WEIGHTS = Object.freeze({
  DECLARED_STRUCTURED_TEXT: 100,
  DECLARED_RESPONSES_PROTOCOL: 60,
  DECLARED_IMAGE_GENERATION: 100,
  DECLARED_REFERENCE_IMAGE: 40,
  DECLARED_TARGET_RESOLUTION: 20,
  MODEL_ID_TEXT_HINT: 10,
  MODEL_ID_IMAGE_HINT: 10,
});

const TEXT_DECLARATIONS = Object.freeze([
  ["structured_text", "DECLARED_STRUCTURED_TEXT"],
  ["responses_protocol", "DECLARED_RESPONSES_PROTOCOL"],
]);

const IMAGE_DECLARATIONS = Object.freeze([
  ["image_generation", "DECLARED_IMAGE_GENERATION"],
  ["image_edit", "DECLARED_REFERENCE_IMAGE"],
  ["target_resolution", "DECLARED_TARGET_RESOLUTION"],
]);

const TEXT_MODEL_HINT = /(?:^|[-_.\/])(chat|claude|gpt|instruct|llama|mistral|qwen|text)(?:$|[-_.\/])/iu;
const IMAGE_MODEL_HINT = /(?:^|[-_.\/])(dall-?e|flux|image|midjourney|sdxl|stable-diffusion)(?:$|[-_.\/])/iu;

function catalogError(code) {
  const error = new TypeError(code);
  error.code = code;
  return error;
}

function normalizedModels(catalog) {
  if (!catalog || Array.isArray(catalog) || typeof catalog !== "object" || !Array.isArray(catalog.models)) {
    throw catalogError("AI_MODEL_CATALOG_INVALID");
  }

  const modelIds = new Set();
  return catalog.models.map((model) => {
    if (!model || Array.isArray(model) || typeof model !== "object"
      || typeof model.id !== "string" || model.id.length === 0
      || !model.metadata || Array.isArray(model.metadata) || typeof model.metadata !== "object") {
      throw catalogError("AI_MODEL_CATALOG_INVALID");
    }
    if (modelIds.has(model.id)) throw catalogError("AI_MODEL_CATALOG_DUPLICATE_ID");
    modelIds.add(model.id);
    return model;
  });
}

function capabilitySet(metadata, property) {
  if (!Array.isArray(metadata[property])) return new Set();
  return new Set(metadata[property].filter((capability) => typeof capability === "string"));
}

function candidateFor(model, declarations, hint, hintReason) {
  const capabilities = capabilitySet(model.metadata, "capabilities");
  const incompatibleCapabilities = capabilitySet(model.metadata, "incompatibleCapabilities");
  if (declarations.some(([capability]) => incompatibleCapabilities.has(capability))) return null;

  const reasonCodes = [];
  let score = 0;
  for (const [capability, reasonCode] of declarations) {
    if (!capabilities.has(capability)) continue;
    reasonCodes.push(reasonCode);
    score += WEIGHTS[reasonCode];
  }

  if (score === 0 && capabilities.size === 0 && hint.test(model.id)) {
    reasonCodes.push(hintReason);
    score = WEIGHTS[hintReason];
  }
  if (score === 0) return null;

  return {
    modelId: model.id,
    score,
    confidence: reasonCodes[0].startsWith("DECLARED_") ? "DECLARED" : "LOW",
    verified: false,
    reasonCodes,
  };
}

function rankedCandidates(models, declarations, hint, hintReason) {
  return models
    .map((model) => candidateFor(model, declarations, hint, hintReason))
    .filter((candidate) => candidate !== null)
    .sort((left, right) => right.score - left.score || (left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0))
    .slice(0, MAX_CANDIDATES);
}

/**
 * Creates an explainable, non-billing recommendation from a normalized model catalog.
 * Declared catalog capabilities are evidence, not a successful capability test, so every
 * recommendation remains unverified and callers must not treat it as execution approval.
 */
export function recommendAutoListingModels(catalog) {
  const models = normalizedModels(catalog);
  const textCandidates = rankedCandidates(models, TEXT_DECLARATIONS, TEXT_MODEL_HINT, "MODEL_ID_TEXT_HINT");
  const imageCandidates = rankedCandidates(models, IMAGE_DECLARATIONS, IMAGE_MODEL_HINT, "MODEL_ID_IMAGE_HINT");
  const warnings = ["RECOMMENDATIONS_UNVERIFIED"];
  if (textCandidates.length === 0) warnings.push("NO_TEXT_MODEL_CANDIDATE");
  if (imageCandidates.length === 0) warnings.push("NO_IMAGE_MODEL_CANDIDATE");

  return {
    ruleVersion: RECOMMENDATION_RULE_VERSION,
    verified: false,
    warnings,
    textCandidates,
    imageCandidates,
  };
}
