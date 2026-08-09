import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { recommendAutoListingModels } from "../auto-listing-ai-model-recommendation.mjs";

test("declared capabilities outrank name hints and remain unverified", () => {
  const result = recommendAutoListingModels({ models: [
    { id: "generic-a", ownedBy: "gateway", metadata: { capabilities: ["structured_text"] } },
    { id: "image-looking-name", ownedBy: "gateway", metadata: {} },
    { id: "generic-b", ownedBy: "gateway", metadata: { capabilities: ["image_generation", "image_edit"] } },
  ] });

  assert.equal(result.textCandidates[0].modelId, "generic-a");
  assert.equal(result.imageCandidates[0].modelId, "generic-b");
  assert.equal(result.verified, false);
  assert.equal(result.ruleVersion, "AUTO_LISTING_MODEL_RECOMMENDATION_V2");
  assert.deepEqual(result.imageCandidates[0].reasonCodes,
    ["DECLARED_IMAGE_GENERATION", "DECLARED_REFERENCE_IMAGE"]);
  assert.equal(result.imageCandidates[0].confidence, "DECLARED");
  assert.deepEqual(result.warnings, ["RECOMMENDATIONS_UNVERIFIED"]);
});

test("ties sort by model ID with a deterministic serializable result", () => {
  const catalog = { models: [
    { id: "text-z", ownedBy: "gateway", metadata: { capabilities: ["structured_text"] } },
    { id: "text-a", ownedBy: "gateway", metadata: { capabilities: ["structured_text"] } },
  ] };

  const first = recommendAutoListingModels(catalog);
  const second = recommendAutoListingModels(catalog);

  assert.deepEqual(first.textCandidates.map((candidate) => candidate.modelId), ["text-a", "text-z"]);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(
    createHash("sha256").update(JSON.stringify(first)).digest("hex"),
    createHash("sha256").update(JSON.stringify(second)).digest("hex"),
  );
});

test("explicit incompatibility disqualifies a capability even when a name hint matches", () => {
  const result = recommendAutoListingModels({ models: [
    {
      id: "text-model", ownedBy: "gateway",
      metadata: { capabilities: ["structured_text"], incompatibleCapabilities: ["structured_text"] },
    },
    {
      id: "image-model", ownedBy: "gateway",
      metadata: { capabilities: ["image_generation"], incompatibleCapabilities: ["image_generation"] },
    },
  ] });

  assert.deepEqual(result.textCandidates, []);
  assert.deepEqual(result.imageCandidates, []);
  assert.deepEqual(result.warnings, [
    "RECOMMENDATIONS_UNVERIFIED",
    "NO_TEXT_MODEL_CANDIDATE",
    "NO_IMAGE_MODEL_CANDIDATE",
  ]);
});

test("name hints are low-confidence candidates and never verify a capability", () => {
  const result = recommendAutoListingModels({ models: [
    { id: "qwen-chat", ownedBy: "gateway", metadata: {} },
    { id: "flux-image", ownedBy: "gateway", metadata: {} },
  ] });

  assert.deepEqual(result.textCandidates, [{
    modelId: "qwen-chat", score: 10, confidence: "LOW", verified: false,
    reasonCodes: ["MODEL_ID_TEXT_HINT"],
  }]);
  assert.deepEqual(result.imageCandidates, [{
    modelId: "flux-image", score: 10, confidence: "LOW", verified: false,
    reasonCodes: ["MODEL_ID_IMAGE_HINT"],
  }]);
  assert.equal(result.verified, false);
});

test("gpt-5.4 gains an unverified OAuth image-orchestrator hint only beside an OpenAI image model", () => {
  const result = recommendAutoListingModels({ models: [
    { id: "gpt-5.5", ownedBy: "openai", metadata: {} },
    { id: "gpt-5.4", ownedBy: "openai", metadata: {} },
    { id: "gpt-image-2", ownedBy: "openai", metadata: {} },
  ] });

  assert.equal(result.ruleVersion, "AUTO_LISTING_MODEL_RECOMMENDATION_V2");
  assert.deepEqual(result.textCandidates[0], {
    modelId: "gpt-5.4",
    score: 40,
    confidence: "LOW",
    verified: false,
    reasonCodes: ["MODEL_ID_TEXT_HINT", "SUB2API_OAUTH_IMAGE_ORCHESTRATOR_HINT"],
  });
  assert.equal(result.textCandidates[1].modelId, "gpt-5.5");
  assert.equal(result.verified, false);
});

test("the OAuth image-orchestrator hint also ranks declared gpt-5.4 without changing its confidence", () => {
  const result = recommendAutoListingModels({ models: [
    { id: "gpt-5.5", ownedBy: "openai", metadata: { capabilities: ["structured_text"] } },
    { id: "gpt-5.4", ownedBy: "openai", metadata: { capabilities: ["structured_text"] } },
    { id: "gpt-image-1", ownedBy: "openai", metadata: { capabilities: ["image_generation"] } },
  ] });

  assert.deepEqual(result.textCandidates[0], {
    modelId: "gpt-5.4",
    score: 130,
    confidence: "DECLARED",
    verified: false,
    reasonCodes: ["DECLARED_STRUCTURED_TEXT", "SUB2API_OAUTH_IMAGE_ORCHESTRATOR_HINT"],
  });
});

test("gpt-5.4 receives no OAuth image-orchestrator hint without an OpenAI image model", () => {
  const result = recommendAutoListingModels({ models: [
    { id: "gpt-5.4", ownedBy: "openai", metadata: {} },
    { id: "flux-image", ownedBy: "other", metadata: {} },
  ] });

  assert.deepEqual(result.textCandidates[0], {
    modelId: "gpt-5.4",
    score: 10,
    confidence: "LOW",
    verified: false,
    reasonCodes: ["MODEL_ID_TEXT_HINT"],
  });
});

test("declared scoring uses the fixed protocol and target-resolution weights", () => {
  const result = recommendAutoListingModels({ models: [
    {
      id: "text-declared", ownedBy: "gateway",
      metadata: { capabilities: ["structured_text", "responses_protocol"] },
    },
    {
      id: "image-declared", ownedBy: "gateway",
      metadata: { capabilities: ["image_generation", "image_edit", "target_resolution"] },
    },
  ] });

  assert.deepEqual(result.textCandidates[0], {
    modelId: "text-declared", score: 160, confidence: "DECLARED", verified: false,
    reasonCodes: ["DECLARED_STRUCTURED_TEXT", "DECLARED_RESPONSES_PROTOCOL"],
  });
  assert.deepEqual(result.imageCandidates[0], {
    modelId: "image-declared", score: 160, confidence: "DECLARED", verified: false,
    reasonCodes: ["DECLARED_IMAGE_GENERATION", "DECLARED_REFERENCE_IMAGE", "DECLARED_TARGET_RESOLUTION"],
  });
});

test("returns empty candidate lists rather than guessing unknown model capabilities", () => {
  const result = recommendAutoListingModels({ models: [
    { id: "opaque-provider-model", ownedBy: "gateway", metadata: {} },
  ] });

  assert.deepEqual(result.textCandidates, []);
  assert.deepEqual(result.imageCandidates, []);
  assert.deepEqual(result.warnings, [
    "RECOMMENDATIONS_UNVERIFIED",
    "NO_TEXT_MODEL_CANDIDATE",
    "NO_IMAGE_MODEL_CANDIDATE",
  ]);
});

test("rejects duplicate catalog model IDs before scoring", () => {
  assert.throws(() => recommendAutoListingModels({ models: [
    { id: "same-model", ownedBy: "gateway", metadata: {} },
    { id: "same-model", ownedBy: "gateway", metadata: {} },
  ] }), (error) => error instanceof TypeError && error.code === "AI_MODEL_CATALOG_DUPLICATE_ID");
});

test("limits each ranked candidate list to fifty models", () => {
  const models = Array.from({ length: 52 }, (_, index) => ({
    id: `text-${String(52 - index).padStart(2, "0")}`,
    ownedBy: "gateway",
    metadata: { capabilities: ["structured_text"] },
  }));

  const result = recommendAutoListingModels({ models });

  assert.equal(result.textCandidates.length, 50);
  assert.equal(result.textCandidates[0].modelId, "text-01");
  assert.equal(result.textCandidates.at(-1).modelId, "text-50");
});

test("does not mutate normalized catalog inputs", () => {
  const catalog = {
    models: [{
      id: "qwen-chat", ownedBy: "gateway",
      metadata: { capabilities: ["structured_text"], labels: ["keep", "unchanged"] },
    }],
  };
  const before = structuredClone(catalog);

  recommendAutoListingModels(catalog);

  assert.deepEqual(catalog, before);
});
