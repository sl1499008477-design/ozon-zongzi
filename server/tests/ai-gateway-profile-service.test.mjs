import assert from "node:assert/strict";
import test from "node:test";
import { createAiGatewayProfileService } from "../ai-gateway-profile-service.mjs";
import {
  assertAutoListingAiRuntimeConfiguration,
  autoListingAiEnabled,
} from "../runtime-config.mjs";

const admin = { id: "account-admin", role: "admin" };
const ordinary = { id: "account-user", role: "user" };
const profile = Object.freeze({
  id: "profile-a",
  accountId: "account-admin",
  configVersion: 4,
  baseUrl: "https://gateway.example/v1",
  apiKeyEnvName: "SUB2API_PROFILE_A_KEY",
  textProtocol: "SUB2API_RESPONSES",
  imageProtocol: "SUB2API_OPENAI_IMAGES",
  textModel: "text-model-a",
  imageModel: "image-model-a",
  enabled: false,
});

function fixture({ gatewayResult, gatewayError, saved = { updated: true } } = {}) {
  const calls = [];
  const repository = {
    async loadProfileForCapabilityTest(input) {
      calls.push(["load", input]);
      return input.accountId === profile.accountId && input.profileId === profile.id && input.configVersion === profile.configVersion
        ? { ...profile }
        : null;
    },
    async recordCapabilityResult(input) {
      calls.push(["save", input]);
      return saved;
    },
  };
  const gateway = {
    async testCapabilities(input) {
      calls.push(["gateway", input]);
      if (gatewayError) throw gatewayError;
      return gatewayResult || {
        features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
        latencyMs: 321,
        models: { text: "text-model-a", image: "image-model-a" },
        modelEvidence: {
          requestedImageModel: "image-model-a",
          gatewayReportedImageModel: "image-model-a",
          gatewayReportedImageModelPresent: true,
          orchestratorModel: "",
        },
        requestIds: { reachability: "r1", text: "r2", image: "r3" },
      };
    },
  };
  const service = createAiGatewayProfileService({
    repository,
    gateway,
    now: () => new Date("2026-08-04T10:00:00.000Z"),
  });
  return { service, calls };
}

test("capability testing is administrator-only and rejects before repository or gateway work", async () => {
  const { service, calls } = fixture();
  await assert.rejects(
    service.testGatewayCapabilities({ actor: ordinary, profileId: "profile-a", configVersion: 4, correlationId: "corr" }),
    (error) => error?.code === "PERMISSION_FORBIDDEN",
  );
  assert.deepEqual(calls, []);
});

test("successful explicit capability test is account/version scoped and persists only safe evidence", async () => {
  const { service, calls } = fixture();
  const result = await service.testGatewayCapabilities({
    actor: admin,
    profileId: "profile-a",
    configVersion: 4,
    correlationId: "corr-capability",
  });

  assert.deepEqual(result, {
    profileId: "profile-a",
    configVersion: 4,
    outcome: "PASSED",
    features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
    latencyMs: 321,
    models: { text: "text-model-a", image: "image-model-a" },
    checkedAt: "2026-08-04T10:00:00.000Z",
    errorCode: null,
    enabled: true,
  });
  assert.deepEqual(calls[0], ["load", {
    accountId: "account-admin",
    profileId: "profile-a",
    configVersion: 4,
  }]);
  const gatewayInput = calls[1][1];
  assert.equal(gatewayInput.profile.accountId, "account-admin");
  assert.equal(gatewayInput.profile.configVersion, 4);
  assert.equal(gatewayInput.correlationId, "corr-capability");
  assert.match(gatewayInput.requestKey, /^[a-f0-9]{64}$/);
  const saved = calls[2][1];
  assert.equal(saved.accountId, "account-admin");
  assert.equal(saved.profileId, "profile-a");
  assert.equal(saved.expectedConfigVersion, 4);
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.capabilityResult, {
    outcome: "PASSED",
    features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
    latencyMs: 321,
    models: { text: "text-model-a", image: "image-model-a" },
    checkedAt: "2026-08-04T10:00:00.000Z",
    errorCode: null,
  });
  const serialized = JSON.stringify({ result, saved });
  assert.doesNotMatch(serialized, /apiKeyEnvName|SUB2API_PROFILE_A_KEY|requestIds|authorization|cookie|bytes|prompt/i);
});

test("failed capability test disables the exact profile version and returns a stable safe outcome", async () => {
  const upstream = Object.assign(new Error("secret upstream body"), {
    code: "NON_RETRYABLE_AUTH",
    retryable: false,
  });
  const { service, calls } = fixture({ gatewayError: upstream });
  const result = await service.testGatewayCapabilities({
    actor: admin,
    profileId: "profile-a",
    configVersion: 4,
    correlationId: "corr-failed",
  });
  assert.deepEqual(result, {
    profileId: "profile-a",
    configVersion: 4,
    outcome: "FAILED",
    features: [],
    latencyMs: null,
    models: { text: "text-model-a", image: "image-model-a" },
    checkedAt: "2026-08-04T10:00:00.000Z",
    errorCode: "NON_RETRYABLE_AUTH",
    enabled: false,
  });
  const saved = calls.at(-1)[1];
  assert.equal(saved.enabled, false);
  assert.equal(saved.expectedConfigVersion, 4);
  assert.doesNotMatch(JSON.stringify(saved), /secret upstream body/);
});

test("compare-and-swap prevents an old cost-bearing test from enabling a newer profile version", async () => {
  const { service, calls } = fixture({ saved: { updated: false, currentConfigVersion: 5 } });
  await assert.rejects(
    service.testGatewayCapabilities({ actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "corr-stale" }),
    (error) => error?.code === "AI_GATEWAY_PROFILE_VERSION_CONFLICT" && error?.retryable === false,
  );
  const saved = calls.at(-1)[1];
  assert.equal(saved.expectedConfigVersion, 4);
  assert.equal(saved.enabled, true);
});

test("foreign, missing, or malformed profile identity never reaches the gateway", async () => {
  for (const input of [
    { actor: admin, profileId: "foreign", configVersion: 4, correlationId: "corr" },
    { actor: admin, profileId: "profile-a", configVersion: 0, correlationId: "corr" },
    { actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "" },
  ]) {
    const { service, calls } = fixture();
    await assert.rejects(service.testGatewayCapabilities(input), (error) => [
      "AI_GATEWAY_PROFILE_NOT_FOUND",
      "AI_GATEWAY_CAPABILITY_REQUEST_INVALID",
    ].includes(error?.code));
    assert.equal(calls.some(([name]) => name === "gateway"), false);
  }
});

test("capability result validation rejects unsafe or incomplete adapter output and disables the version", async () => {
  for (const gatewayResult of [
    { features: ["STRUCTURED_TEXT"], latencyMs: 10, models: { text: "text-model-a", image: "image-model-a" } },
    { features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG", "SECRET_TOKEN"], latencyMs: 10, models: { text: "text-model-a", image: "image-model-a" } },
    { features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: -1, models: { text: "text-model-a", image: "image-model-a" } },
    {
      features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      latencyMs: 10,
      models: { text: "text-model-a", image: "image-model-a" },
      modelEvidence: { requestedImageModel: "other-image", gatewayReportedImageModel: "", orchestratorModel: "" },
    },
    {
      features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      latencyMs: 10,
      models: { text: "text-model-a", image: "image-model-a" },
      modelEvidence: { requestedImageModel: "image-model-a", gatewayReportedImageModel: "other-image", orchestratorModel: "" },
    },
    {
      features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      latencyMs: 10,
      models: { text: "text-model-a", image: "image-model-a" },
      modelEvidence: {
        requestedImageModel: "image-model-a",
        gatewayReportedImageModel: "",
        gatewayReportedImageModelPresent: true,
        orchestratorModel: "",
      },
    },
  ]) {
    const { service, calls } = fixture({ gatewayResult });
    const result = await service.testGatewayCapabilities({ actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "corr" });
    assert.equal(result.outcome, "FAILED");
    assert.equal(result.errorCode, "INVALID_GATEWAY_RESPONSE");
    assert.equal(calls.at(-1)[1].enabled, false);
  }
});

test("AUTO_LISTING_AI_ENABLED defaults off and performs no profile or secret read", () => {
  let reads = 0;
  assert.equal(autoListingAiEnabled({}), false);
  assert.equal(assertAutoListingAiRuntimeConfiguration({
    env: {},
    resolveProfile() { reads += 1; },
    readSecret() { reads += 1; },
  }), null);
  assert.equal(reads, 0);
});

test("enabled AI runtime requires the referenced enabled profile and its exact environment secret", () => {
  const env = { AUTO_LISTING_AI_ENABLED: "1", AUTO_LISTING_AI_PROFILE_ID: "profile-a", SUB2API_PROFILE_A_KEY: "x" };
  const safe = assertAutoListingAiRuntimeConfiguration({ env, profile: { ...profile, enabled: true } });
  assert.deepEqual(safe, { profileId: "profile-a", configVersion: 4 });

  for (const [fixtureEnv, fixtureProfile, code] of [
    [{ AUTO_LISTING_AI_ENABLED: "1" }, profile, "AUTO_LISTING_AI_PROFILE_REQUIRED"],
    [{ ...env, AUTO_LISTING_AI_PROFILE_ID: "other" }, profile, "AUTO_LISTING_AI_PROFILE_MISMATCH"],
    [env, { ...profile, enabled: false }, "AUTO_LISTING_AI_PROFILE_NOT_ENABLED"],
    [{ ...env, SUB2API_PROFILE_A_KEY: "" }, { ...profile, enabled: true }, "AUTO_LISTING_AI_SECRET_REQUIRED"],
    [{ ...env, SUB2API_PROFILE_A_KEY: "   " }, { ...profile, enabled: true }, "AUTO_LISTING_AI_SECRET_REQUIRED"],
    [env, { ...profile, enabled: true, apiKeyEnvName: "__proto__" }, "AUTO_LISTING_AI_PROFILE_INVALID"],
  ]) {
    assert.throws(
      () => assertAutoListingAiRuntimeConfiguration({ env: fixtureEnv, profile: fixtureProfile }),
      (error) => error?.code === code,
    );
  }
});
